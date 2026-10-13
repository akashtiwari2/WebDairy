import { StartupService } from './startup.service';
import { GoogleService } from './google.service';
import { Component, input, signal, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PreferencesService, Preferences } from './preferences.service';
import { VaultService } from './vault.service';
@Component({
  selector: 'app-auth-panel',
  imports: [FormsModule],
  templateUrl: './auth-panel.html',
  styles: [
    `
      :host {
        display: block;
      }
      .panel {
        max-width: 480px;
        padding: 32px;
        background: var(--paper);
        border: 1px solid var(--border);
        border-radius: 14px;
        margin: 24px auto;
      }
      h2 {
        font:
          30px Georgia,
          serif;
      }
      label {
        display: block;
        margin: 16px 0;
        font-size: 14px;
      }
      input {
        display: block;
        width: 100%;
        padding: 10px;
        box-sizing: border-box;
        margin-top: 6px;
        border: 1px solid var(--border);
        border-radius: 6px;
      }
      input[type='checkbox'] {
        display: inline;
        width: auto;
      }
      button {
        padding: 10px 16px;
        margin: 6px 6px 6px 0;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--soft);
        color: var(--ink);
      }
      p {
        line-height: 1.6;
        font-size: 14px;
      }
      code {
        display: block;
        overflow-wrap: anywhere;
        padding: 16px;
        background: var(--soft);
        user-select: all;
      }
      .hint {
        color: var(--muted);
        font-size: 12px;
      }
    `,
  ],
})
export class AuthPanel {
  readonly startup = inject(StartupService);
  readonly google = inject(GoogleService);
  readonly preferences = inject(PreferencesService);
  setPreference(key: keyof Preferences, value: any) {
    void this.v.perform(async () =>
      this.preferences.set({ ...this.preferences.value(), [key]: value }),
    );
  }
  readonly v = inject(VaultService);
  readonly settings = input(false);
  readonly recovering = signal(false);
  loginPassword = '';
  passphrase = '';
  confirmation = '';
  current = '';
  currentLogin = '';
  offlinePassword = '';
  offlineConfirmation = '';
  recoveryInput = '';
  savedOffline = false;
  constructor() {
    effect(() => {
      this.v.state();
      this.settings();
      this.clear();
      this.recovering.set(false);
    });
  }
  private clear() {
    this.loginPassword = '';
    this.passphrase = '';
    this.confirmation = '';
    this.current = '';
    this.currentLogin = '';
    this.offlinePassword = '';
    this.offlineConfirmation = '';
    this.recoveryInput = '';
    this.savedOffline = false;
  }
  async setup() {
    const login = this.loginPassword,
      pass = this.passphrase,
      confirm = this.confirmation;
    this.clear();
    await this.v.perform(async () => {
      if (pass !== confirm) throw new Error('Passphrases do not match.');
      await this.v.beginSetup(login, pass);
    });
  }
  async login() {
    const password = this.loginPassword;
    this.clear();
    await this.v.perform(() => this.v.login(password));
  }
  async unlock() {
    const pass = this.passphrase;
    this.clear();
    await this.v.perform(() => this.v.unlock(pass));
  }
  async verify() {
    const secret = this.recoveryInput,
      saved = this.savedOffline;
    this.clear();
    await this.v.perform(async () => {
      if (!saved) throw new Error('Save the recovery key offline before continuing.');
      await this.v.confirmRecovery(secret);
    });
  }
  async recover() {
    const secret = this.recoveryInput,
      pass = this.passphrase,
      confirm = this.confirmation;
    this.clear();
    await this.v.perform(async () => {
      if (pass !== confirm) throw new Error('Passphrases do not match.');
      await this.v.recover(secret, pass);
      this.recovering.set(false);
    });
  }
  async addOfflinePassword() {
    const password = this.offlinePassword,
      confirm = this.offlineConfirmation;
    this.clear();
    await this.v.perform(async () => {
      if (password !== confirm) throw new Error('Offline passwords do not match.');
      await this.v.auth.request('/api/auth/offline-password', 'POST', { password });
      await this.google.refresh();
    });
  }
  async changePass() {
    const current = this.current,
      pass = this.passphrase,
      confirm = this.confirmation;
    this.clear();
    await this.v.perform(async () => {
      if (pass !== confirm) throw new Error('Passphrases do not match.');
      await this.v.changePassphrase(current, pass);
    });
  }
  async rotate() {
    const current = this.current;
    this.clear();
    await this.v.perform(() => this.v.rotateRecovery(current));
  }
  async changeLogin() {
    const current = this.currentLogin,
      next = this.loginPassword;
    this.clear();
    await this.v.perform(() => this.v.changeLogin(current, next));
  }
  cancel() {
    this.clear();
    this.v.cancelRecovery();
  }
  retry() {
    void this.v.perform(() => this.v.start());
  }
  logout() {
    void this.v.perform(() => this.v.logout());
  }
}
