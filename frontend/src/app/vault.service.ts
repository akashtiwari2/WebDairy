import { Injectable, inject, signal } from '@angular/core';
import { backupKey } from './backup-format';
import { AuthService, APIError } from './auth.service';
import {
  Envelope,
  Vault,
  aesKey,
  random,
  validateEnvelope,
  wrapPassword,
  wrapRecovery,
  unwrapPassword,
  unwrapRecovery,
  recoveryBytes,
} from './vault-crypto';
export type VaultState = 'checking' | 'setup' | 'login' | 'locked' | 'opening' | 'unlocked';
@Injectable({ providedIn: 'root' })
export class VaultService {
  readonly auth = inject(AuthService);
  readonly state = signal<VaultState>('checking');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly recoverySecret = signal('');
  readonly recoveryPurpose = signal<'setup' | 'rotate' | ''>('');
  readonly idleMinutes = signal(5);
  readonly clearListeners = new Set<() => void>();
  onOpen: () => Promise<void> = async () => {};
  onLock: () => Promise<void> = async () => {};
  onFailedOpen: () => void = () => {};
  private raw?: Uint8Array<ArrayBuffer>;
  private cryptoKey?: CryptoKey;
  private releaseTab?: () => void;
  private pending?: { raw: Uint8Array<ArrayBuffer>; envelope: Envelope; login: string };
  private pendingRecovery?: Envelope['recovery'];
  private lastActivity = Date.now();
  vault?: Vault;
  async backupKey(salt: string) {
    if (!this.raw) throw new Error('Unlock first.');
    return backupKey(this.raw, salt, this.id);
  }
  async adopt(raw: Uint8Array<ArrayBuffer>) {
    this.vault = await this.auth.request<Vault>('/api/vault');
    await this.openRaw(raw);
  }
  get key(): CryptoKey {
    if (!this.cryptoKey) throw new Error('Vault locked.');
    return this.cryptoKey;
  }
  get id(): string {
    if (!this.vault) throw new Error('Vault unavailable.');
    return this.vault.envelope.vault_id;
  }
  constructor() {
    try {
      const saved = Number(localStorage.getItem('webdiary-idle-minutes'));
      if (saved >= 1 && saved <= 60) this.idleMinutes.set(saved);
    } catch {
      /* Optional preference only. */
    }
    for (const event of ['pointerdown', 'keydown', 'touchstart'])
      window.addEventListener(
        event,
        () => {
          this.lastActivity = Date.now();
        },
        { passive: true },
      );
    setInterval(() => {
      if (
        this.state() === 'unlocked' &&
        !this.busy() &&
        Date.now() - this.lastActivity >= this.idleMinutes() * 60000
      )
        void this.perform(() => this.lock());
    }, 1000);
  }
  async perform(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      this.busy.set(false);
    }
  }
  async start() {
    await this.auth.session();
    if (!this.auth.initialized()) {
      this.state.set('setup');
      return;
    }
    if (!this.auth.authenticated()) {
      this.state.set('login');
      return;
    }
    this.vault = await this.auth.request<Vault>('/api/vault');
    validateEnvelope(this.vault.envelope);
    this.state.set('locked');
  }
  async login(password: string) {
    await this.auth.login(password);
    this.vault = await this.auth.request<Vault>('/api/vault');
    validateEnvelope(this.vault.envelope);
    this.state.set('locked');
  }
  async beginSetup(login: string, pass: string) {
    if (
      new TextEncoder().encode(login).length < 12 ||
      new TextEncoder().encode(login).length > 1024 ||
      login === pass
    )
      throw new Error('Use different login and vault passwords, each at least 12 characters.');
    this.cancelRecovery();
    const raw = random(32),
      id = crypto.randomUUID();
    try {
      const passphrase = await wrapPassword(raw, pass, id),
        recovery = await wrapRecovery(raw, id);
      this.pending = {
        raw,
        login,
        envelope: { format_version: 1, vault_id: id, passphrase, recovery: recovery.envelope },
      };
      this.recoverySecret.set(recovery.secret);
      this.recoveryPurpose.set('setup');
    } catch (e) {
      raw.fill(0);
      throw e;
    }
  }
  async confirmRecovery(secret: string) {
    const supplied = recoveryBytes(secret),
      expected = recoveryBytes(this.recoverySecret());
    let different = 0;
    for (let i = 0; i < 32; i++) different |= supplied[i] ^ expected[i];
    supplied.fill(0);
    expected.fill(0);
    if (different) throw new Error('Recovery key does not match. Check your offline copy.');
    if (this.recoveryPurpose() === 'setup' && this.pending) {
      const pending = this.pending;
      const verified = await unwrapRecovery(pending.envelope, secret);
      verified.fill(0);
      try {
        await this.auth.setup(pending.login, pending.envelope);
      } catch (e) {
        if (e instanceof APIError && e.status === 409) {
          this.cancelRecovery();
          await this.start();
          throw new Error(
            'Vault already exists. Log in with the password used during setup; do not create a replacement.',
          );
        }
        throw e;
      }
      this.vault = await this.auth.request<Vault>('/api/vault');
      const raw = pending.raw.slice();
      this.cancelRecovery();
      await this.openRaw(raw);
    } else if (
      this.recoveryPurpose() === 'rotate' &&
      this.pendingRecovery &&
      this.vault &&
      this.raw
    ) {
      const envelope = { ...this.vault.envelope, recovery: this.pendingRecovery };
      const verified = await unwrapRecovery(envelope, secret);
      verified.fill(0);
      await this.setEnvelope(envelope);
      this.cancelRecovery();
    } else throw new Error('Start recovery key setup again.');
  }
  cancelRecovery() {
    this.pending?.raw.fill(0);
    this.pending = undefined;
    this.pendingRecovery = undefined;
    this.recoverySecret.set('');
    this.recoveryPurpose.set('');
  }
  private async claimTab() {
    if (!navigator.locks)
      throw new Error(
        'This browser cannot enforce one editing tab. Use a current browser on localhost.',
      );
    let acquired!: () => void, failed!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    void navigator.locks
      .request(`webdiary-edit-${this.id}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          failed(new Error('Vault is open in another tab. Lock that tab first.'));
          return;
        }
        await new Promise<void>((resolve) => {
          this.releaseTab = resolve;
          acquired();
        });
      })
      .catch((e) => failed(e));
    await ready;
  }
  private async openRaw(raw: Uint8Array<ArrayBuffer>) {
    this.state.set('opening');
    try {
      await this.claimTab();
      this.raw = raw;
      this.cryptoKey = await aesKey(raw);
      await this.onOpen();
      this.lastActivity = Date.now();
      this.state.set('unlocked');
    } catch (e) {
      raw.fill(0);
      this.raw = undefined;
      this.cryptoKey = undefined;
      this.releaseTab?.();
      this.releaseTab = undefined;
      this.onFailedOpen();
      this.state.set(this.auth.authenticated() ? 'locked' : 'login');
      throw e;
    }
  }
  async unlock(pass: string) {
    this.vault = await this.auth.request<Vault>('/api/vault');
    validateEnvelope(this.vault.envelope);
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = await unwrapPassword(this.vault.envelope, pass);
    } catch {
      throw new Error('Could not unlock. Passphrase or encrypted vault data is invalid.');
    }
    await this.openRaw(raw);
  }
  async recover(secret: string, newPass: string) {
    this.vault = await this.auth.request<Vault>('/api/vault');
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = await unwrapRecovery(this.vault.envelope, secret);
    } catch {
      throw new Error('Could not recover. Recovery key or encrypted vault data is invalid.');
    }
    try {
      const passphrase = await wrapPassword(raw, newPass, this.id),
        envelope = { ...this.vault.envelope, passphrase };
      const check = await unwrapPassword(envelope, newPass);
      check.fill(0);
      await this.setEnvelope(envelope);
      await this.openRaw(raw);
    } catch (e) {
      raw.fill(0);
      throw e;
    }
  }
  async changePassphrase(current: string, next: string) {
    if (!this.raw || !this.vault) throw new Error('Unlock first.');
    const verified = await unwrapPassword(this.vault.envelope, current);
    verified.fill(0);
    const envelope = {
      ...this.vault.envelope,
      passphrase: await wrapPassword(this.raw, next, this.id),
    };
    const check = await unwrapPassword(envelope, next);
    check.fill(0);
    await this.setEnvelope(envelope);
  }
  async rotateRecovery(current: string) {
    if (!this.raw || !this.vault) throw new Error('Unlock first.');
    const verified = await unwrapPassword(this.vault.envelope, current);
    verified.fill(0);
    this.cancelRecovery();
    const recovery = await wrapRecovery(this.raw, this.id);
    this.pendingRecovery = recovery.envelope;
    this.recoverySecret.set(recovery.secret);
    this.recoveryPurpose.set('rotate');
  }
  private async setEnvelope(envelope: Envelope) {
    const write = {
      envelope,
      expected_revision: this.vault!.revision,
      operation_id: crypto.randomUUID(),
    };
    // A lost response retries the identical envelope and operation, never a new key.
    try {
      this.vault = await this.auth.request<Vault>('/api/vault', 'PUT', write);
    } catch (e) {
      if (e instanceof APIError && e.status < 500) throw e;
      try {
        this.vault = await this.auth.request<Vault>('/api/vault', 'PUT', write);
      } catch {
        throw new Error(
          'Envelope update not confirmed. Keep both old and new keys/passphrases and retry after reconnecting.',
        );
      }
    }
  }
  async lock() {
    if (this.state() === 'unlocked') await this.onLock();
    for (const clear of this.clearListeners) clear();
    this.raw?.fill(0);
    this.raw = undefined;
    this.cryptoKey = undefined;
    this.cancelRecovery();
    this.releaseTab?.();
    this.releaseTab = undefined;
    this.state.set(this.auth.authenticated() ? 'locked' : 'login');
  }
  async logout() {
    await this.lock();
    await this.auth.logout();
    this.vault = undefined;
    this.state.set('login');
  }
  async changeLogin(current: string, next: string) {
    await this.lock();
    await this.auth.changePassword(current, next);
    this.state.set('login');
  }
  setIdle(minutes: number) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return;
    this.idleMinutes.set(minutes);
    try {
      localStorage.setItem('webdiary-idle-minutes', String(minutes));
    } catch {
      /* Optional preference. */
    }
    this.lastActivity = Date.now();
  }
}
