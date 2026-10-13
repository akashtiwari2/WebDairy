import { GoogleService } from './google.service';
import { backupDue } from './backup-schedule';
import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService, APIError } from './auth.service';
import { VaultService } from './vault.service';
import { DiaryService } from './diary.service';
import { PreferencesService } from './preferences.service';
import {
  Archive,
  VerifiedBackup,
  Snapshot,
  createArchive,
  parseArchive,
  verifyArchive,
  MAX_ARCHIVE,
  canonical,
} from './backup-format';
import { BackupStore, LocalBackup } from './backup-store';
import { backupHealth, recordVersions } from './writing-insights';
import { Vault } from './vault-crypto';
interface RestoreState {
  vault_id: string;
  vault_epoch: string;
  generation: number;
  envelope_revision: number;
}
const baseline = (v: Vault): RestoreState => ({
  vault_id: v.envelope.vault_id,
  vault_epoch: v.vault_epoch,
  generation: v.generation,
  envelope_revision: v.revision,
});
export interface Preview {
  vault_id: string;
  snapshot_at: string;
  active: number;
  trashed: number;
  source: string;
}
@Injectable({ providedIn: 'root' })
export class BackupService {
  readonly vault = inject(VaultService);
  readonly diary = inject(DiaryService);
  readonly auth = inject(AuthService);
  readonly preferences = inject(PreferencesService);
  readonly store = new BackupStore();
  readonly google = inject(GoogleService);
  readonly driveBusy = signal(false);
  readonly driveMessage = signal('');
  readonly driveError = signal('');
  private retryAt = 0;
  private failures = 0;
  readonly lastDriveSnapshot = computed(() => {
    this.vault.state();
    const remote = this.google
      .files()
      .filter((f) => f.appProperties?.vault_id === this.vault.vault?.envelope.vault_id)
      .map((f) => f.appProperties?.snapshot_at || f.createdTime);
    const uploaded = this.local()
      .filter(
        (c) => c.source === 'drive' && c.archive.vault_id === this.vault.vault?.envelope.vault_id,
      )
      .map((c) => c.snapshot_at || c.saved_at);
    return (
      [...remote, ...uploaded]
        .filter(
          (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 60000,
        )
        .sort()
        .at(-1) ?? ''
    );
  });
  readonly preview = signal<Preview | null>(null);
  readonly safetyReady = signal(false);
  readonly message = signal('');
  readonly local = signal<LocalBackup[]>([]);
  readonly historyError = signal('');
  readonly localReady = signal(false);
  readonly localError = signal('');
  private readonly healthTick = signal(Date.now());
  readonly health = computed(() => {
    this.vault.state();
    if (this.google.status().drive_connected) {
      if (this.driveBusy())
        return {
          label: 'Uploading encrypted Drive backup…',
          savedAt: this.lastDriveSnapshot(),
          kind: 'uploading',
        };
      if (
        this.local().some(
          (c) =>
            c.source === 'drive-pending' &&
            c.archive.vault_id === this.vault.vault?.envelope.vault_id,
        )
      )
        return {
          label: 'Drive upload pending',
          savedAt: this.lastDriveSnapshot(),
          kind: 'pending',
        };
      if (!this.google.listed())
        return {
          label: this.google.error()
            ? 'Drive unavailable · local copies remain'
            : 'Checking Drive backups…',
          savedAt: this.lastDriveSnapshot(),
          kind: 'checking',
        };
      const savedAt = this.lastDriveSnapshot();
      if (!savedAt) return { label: 'No Drive backup yet', savedAt: '', kind: 'missing' };
      const frequency = this.preferences.value().backup_frequency ?? 'daily';
      if (backupDue(frequency === 'manual' ? 'daily' : frequency, savedAt, this.healthTick()))
        return { label: 'Drive backup overdue', savedAt, kind: 'overdue' };
      const records = [...this.diary.states().values(), ...this.diary.trash().values()];
      const copy = this.local().find(
        (c) =>
          c.source === 'drive' &&
          c.snapshot_at === savedAt &&
          c.archive.vault_id === this.vault.vault?.envelope.vault_id,
      );
      if (
        records.some(
          (r) =>
            (r.revision > 0 || r.title.trim() || r.body.trim()) &&
            Date.parse(r.updated_at) > Date.parse(savedAt),
        ) ||
        (copy?.record_versions !== undefined && copy.record_versions !== recordVersions(records))
      )
        return { label: 'New changes since Drive backup', savedAt, kind: 'changed' };
      return { label: 'Recent Drive backup', savedAt, kind: 'recent' };
    }
    if (this.localError())
      return { label: 'Backup storage unavailable', savedAt: '', kind: 'unavailable' };
    if (!this.localReady()) return { label: 'Checking backups…', savedAt: '', kind: 'checking' };
    const updates = [...this.diary.states().values(), ...this.diary.trash().values()]
      .filter((s) => s.revision > 0 || s.title.trim() || s.body.trim())
      .map((s) => Date.parse(s.updated_at));
    return backupHealth(
      this.local(),
      this.vault.vault?.envelope.vault_id ?? '',
      updates.reduce((latest, value) => Math.max(latest, value), 0),
      this.healthTick(),
      recordVersions([...this.diary.states().values(), ...this.diary.trash().values()]),
    );
  });
  readonly history = signal<{ id: string; saved_at: string }[]>([]);
  private candidate?: VerifiedBackup;
  private safety?: { expected: RestoreState; archive: Archive };
  private stage?: {
    operation_id: string;
    envelope: Archive['envelope'];
    records: Snapshot['records'];
    expected: RestoreState | null;
    safety_backup?: Archive;
  };
  private expires?: ReturnType<typeof setTimeout>;
  constructor() {
    this.vault.clearListeners.add(() => this.clearPreview());
    effect(() => {
      if (this.vault.state() === 'unlocked') void this.refresh().catch(() => {});
    });
    effect(() => {
      if (this.vault.state() === 'unlocked')
        void this.google
          .refresh()
          .then(() => {
            if (this.google.status().drive_connected) return this.google.list();
            return undefined;
          })
          .catch(() => {});
    });
    effect(() => {
      this.preferences.value();
      this.google.status();
      this.google.listed();
      this.google.files();
      this.vault.state();
      void this.scheduledBackup();
    });
    const scheduler = setInterval(() => void this.scheduledBackup(), 30000);
    inject(DestroyRef).onDestroy(() => clearInterval(scheduler));
    const tick = setInterval(() => this.healthTick.set(Date.now()), 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }
  clearPreview() {
    this.candidate?.raw.fill(0);
    this.candidate = undefined;
    this.safety = undefined;
    this.stage = undefined;
    this.preview.set(null);
    this.safetyReady.set(false);
    clearTimeout(this.expires);
  }
  async refresh() {
    this.healthTick.set(Date.now());
    try {
      this.local.set(await this.store.list());
      this.localReady.set(true);
      this.localError.set('');
    } catch (e) {
      this.localReady.set(false);
      this.localError.set(
        'Browser backup storage is unavailable. Keep downloaded files separately.',
      );
      throw e;
    }
    this.historyError.set('');
    if (this.auth.authenticated()) {
      try {
        const r = await this.auth.request<{ backups: { id: string; saved_at: string }[] }>(
          '/api/backup/history',
        );
        this.history.set(r.backups);
      } catch {
        this.history.set([]);
        this.historyError.set(
          'Server backup history is unavailable. Browser copies and downloaded files remain available.',
        );
      }
    } else this.history.set([]);
  }
  private download(archive: Archive, label = 'backup') {
    const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' }),
      url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webdiary-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.diary`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async exportBackup(drafts = false) {
    if (this.vault.state() !== 'unlocked') throw new Error('Unlock your diary before exporting.');
    let snapshot: Snapshot;
    if (drafts) {
      snapshot = {
        vault: this.vault.vault!,
        records: await this.diary.currentRecords(),
        snapshot_at: new Date().toISOString(),
      };
    } else {
      await this.diary.saveAll();
      snapshot = await this.auth.request<Snapshot>('/api/backup/snapshot');
      if (
        snapshot.vault.vault_epoch !== this.vault.vault!.vault_epoch ||
        canonical(snapshot.vault.envelope) !== canonical(this.vault.vault!.envelope)
      )
        throw new Error('Vault changed. Lock/unlock before exporting.');
    }
    const archive = await createArchive(
      snapshot,
      this.preferences.value(),
      this.vault.key,
      (salt) => this.vault.backupKey(salt),
      drafts ? 'browser-draft' : 'database',
    );
    await this.store.save(
      archive,
      drafts ? 'unsaved-text' : 'export',
      recordVersions(snapshot.records),
    );
    this.download(archive);
    await this.refresh();
    this.message.set(
      drafts
        ? 'Encrypted editor-text export saved. It includes unconfirmed edits and your version of conflicts.'
        : 'Encrypted database backup saved locally and download started. Copy the file outside this browser.',
    );
    return archive;
  }
  private async scheduledBackup() {
    if (
      this.vault.state() === 'unlocked' &&
      this.google.status().drive_connected &&
      !this.google.listed() &&
      !this.google.loading() &&
      !this.vault.busy() &&
      Date.now() >= this.retryAt
    ) {
      try {
        await this.google.list();
      } catch {
        this.retryAt = Date.now() + 60000;
        return;
      }
    }
    if (
      this.vault.state() !== 'unlocked' ||
      !this.auth.authenticated() ||
      this.vault.busy() ||
      this.driveBusy() ||
      !this.google.status().drive_connected ||
      !this.google.listed() ||
      Date.now() < this.retryAt ||
      (!this.local().some(
        (c) =>
          c.source === 'drive-pending' &&
          c.archive.vault_id === this.vault.vault?.envelope.vault_id,
      ) &&
        !backupDue(
          this.preferences.value().backup_frequency ?? 'daily',
          this.lastDriveSnapshot(),
          Date.now(),
        ))
    )
      return;
    await this.vault.perform(() => this.uploadDrive());
  }
  async uploadDrive() {
    if (this.driveBusy()) return;
    if (this.vault.state() !== 'unlocked' || !this.google.status().drive_connected)
      throw new Error('Unlock the diary and connect Google Drive first.');
    this.driveBusy.set(true);
    this.driveError.set('');
    try {
      this.driveMessage.set('Creating encrypted backup…');
      const copies = await this.store.list();
      let pending = copies.find(
        (c) => c.source === 'drive-pending' && c.archive.vault_id === this.vault.id,
      );
      if (!pending) {
        await this.diary.saveAll();
        const snapshot = await this.auth.request<Snapshot>('/api/backup/snapshot');
        if (
          snapshot.vault.vault_epoch !== this.vault.vault!.vault_epoch ||
          canonical(snapshot.vault.envelope) !== canonical(this.vault.vault!.envelope)
        )
          throw new Error('Vault changed. Lock/unlock before uploading.');
        const archive = await createArchive(
          snapshot,
          this.preferences.value(),
          this.vault.key,
          (salt) => this.vault.backupKey(salt),
        );
        pending = await this.store.save(
          archive,
          'drive-pending',
          recordVersions(snapshot.records),
          snapshot.snapshot_at,
        );
      }
      this.driveMessage.set('Uploading encrypted backup to Google Drive…');
      const result = await this.auth.request<{ backup: { id: string }; warning: string }>(
        '/api/drive/upload',
        'POST',
        {
          operation_id: pending.id,
          archive: pending.archive,
          snapshot_at: pending.snapshot_at || pending.saved_at,
          keep: this.preferences.value().backup_keep ?? 30,
        },
        120000,
      );
      await this.store.uploaded(pending, result.backup.id);
      this.failures = 0;
      this.retryAt = 0;
      this.driveMessage.set(result.warning || 'Encrypted backup verified on Google Drive.');
      await this.refresh();
      await this.google.list().catch(() => {});
    } catch (e) {
      this.retryAt = Date.now() + Math.min(15 * 60000, 60000 * 2 ** this.failures++);
      this.driveError.set(this.google.message(e));
      try {
        this.local.set(await this.store.list());
      } catch {}
      this.driveMessage.set(
        'Backup is pending. Your local diary and existing Drive backups are preserved.',
      );
      throw e;
    } finally {
      this.driveBusy.set(false);
    }
  }
  async inspectDrive(id: string, secret: string, mode: 'passphrase' | 'recovery') {
    const archive = await this.auth.request<Archive>(
      '/api/drive/backups/' + encodeURIComponent(id),
      'GET',
      undefined,
      60000,
    );
    await this.inspectText(JSON.stringify(archive), secret, mode);
  }
  async prepareSafety() {
    if (!this.candidate) throw new Error('Verify an import first.');
    await this.diary.saveAll();
    const snapshot = await this.auth.request<Snapshot>('/api/backup/snapshot');
    if (
      snapshot.vault.vault_epoch !== this.vault.vault!.vault_epoch ||
      canonical(snapshot.vault.envelope) !== canonical(this.vault.vault!.envelope)
    )
      throw new Error('Current vault changed. Unlock it again before taking a safety backup.');
    const archive = await createArchive(
      snapshot,
      this.preferences.value(),
      this.vault.key,
      (salt) => this.vault.backupKey(salt),
    );
    await this.store.save(archive, 'before-restore', recordVersions(snapshot.records));
    this.download(archive, 'before-restore');
    this.safety = { expected: baseline(snapshot.vault), archive };
    this.stage = undefined;
    this.safetyReady.set(true);
    await this.refresh();
  }
  async inspectFile(file: File, secret: string, mode: 'passphrase' | 'recovery') {
    if (!file || file.size > MAX_ARCHIVE)
      throw new Error('Choose a backup file smaller than 48 MiB.');
    await this.inspectText(await file.text(), secret, mode);
  }
  async inspectText(text: string, secret: string, mode: 'passphrase' | 'recovery') {
    this.clearPreview();
    this.message.set('');
    const archive = parseArchive(text);
    const verified = await verifyArchive(archive, secret, mode);
    this.candidate = verified;
    this.preview.set({
      vault_id: archive.vault_id,
      snapshot_at: verified.manifest.snapshot_at,
      active: verified.active,
      trashed: verified.trashed,
      source: verified.manifest.source,
    });
    this.expires = setTimeout(() => {
      this.clearPreview();
      this.message.set('Import preview expired. Verify the file again.');
    }, 5 * 60000);
  }
  async commit(newLogin: string, confirmed: boolean) {
    if (!confirmed || !this.candidate)
      throw new Error('Verify the file and explicitly confirm restore.');
    const fresh = !this.auth.initialized();
    if (!fresh && (this.vault.state() !== 'unlocked' || !this.safety || !this.safetyReady()))
      throw new Error('Unlock and save a current-diary backup before replacement.');
    if (
      fresh &&
      !this.auth.googleSetupReady() &&
      (new TextEncoder().encode(newLogin).length < 12 ||
        new TextEncoder().encode(newLogin).length > 1024)
    )
      throw new Error('Choose a new local login password of at least 12 characters.');
    if (!fresh) await this.diary.saveAll();
    const candidate = this.candidate;
    this.stage ??= {
      operation_id: crypto.randomUUID(),
      envelope: candidate.manifest.vault.envelope,
      records: candidate.manifest.records,
      expected: fresh ? null : this.safety!.expected,
      ...(fresh ? {} : { safety_backup: this.safety!.archive }),
    };
    const stage = this.stage;
    try {
      await this.auth.request('/api/restore/stage', 'POST', stage, 60000);
    } catch (e) {
      if (e instanceof APIError && e.status === 409) {
        this.safetyReady.set(false);
        this.stage = undefined;
        throw new Error(
          'Current diary changed. Save a new current-diary backup and confirm again.',
        );
      }
      throw e;
    }
    // Key is copied only for the post-commit verification. Lock clears preview/editor keys.
    const raw = candidate.raw.slice(),
      preferences = { ...candidate.manifest.preferences };
    try {
      await this.vault.lock();
      let applied: Vault;
      const request = {
        stage_id: stage.operation_id,
        ...(fresh
          ? this.auth.googleSetupReady()
            ? { use_google: true }
            : { new_login_password: newLogin }
          : {}),
      };
      try {
        applied = await this.auth.request<Vault>('/api/restore/commit', 'POST', request, 60000);
      } catch (e) {
        if (!fresh && (!(e instanceof APIError) || e.status >= 500))
          applied = await this.auth.request<Vault>('/api/restore/commit', 'POST', request, 60000);
        else throw e;
      }
      if (applied.envelope.vault_id !== stage.envelope.vault_id)
        throw new Error('Restore acknowledgement mismatch. Reopen and verify your diary.');
      await this.auth.session();
      this.preferences.set(preferences);
      await this.vault.adopt(raw);
      await this.refresh();
      this.message.set(
        'Restore completed and all restored entries verified. Keep the backup and its offline recovery key.',
      );
    } catch (e) {
      raw.fill(0);
      await this.vault.start().catch(() => {});
      throw new Error(
        e instanceof APIError && e.status === 409
          ? 'Diary changed before commit. Nothing was replaced; verify and prepare a new safety backup.'
          : 'Restore was not fully confirmed. Reopen/sign in (with Google or the local login used for restore) and verify the diary before retrying. Your pre-restore backup is retained.',
      );
    }
  }
  downloadLocal(id: string) {
    const backup = this.local().find((b) => b.id === id);
    if (!backup) throw new Error('Local backup unavailable.');
    this.download(backup.archive);
  }
  async downloadHistory(id: string) {
    const archive = await this.auth.request<Archive>(`/api/backup/history/${id}`);
    this.download(archive, 'before-restore');
  }
  async removeLocal(id: string) {
    await this.store.remove(id);
    await this.refresh();
  }
}
