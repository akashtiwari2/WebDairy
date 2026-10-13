import { StartupService } from './startup.service';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BackupService } from './backup.service';
import { VaultService } from './vault.service';
@Component({
  selector: 'app-backup-panel',
  imports: [FormsModule],
  templateUrl: './backup-panel.html',
})
export class BackupPanel {
  readonly startup = inject(StartupService);
  readonly driveRestore = signal(false);
  readonly b = inject(BackupService);
  readonly sortedFiles = computed(() =>
    [...this.b.google.files()].sort(
      (a, b) =>
        Date.parse(b.appProperties?.snapshot_at || b.createdTime) -
        Date.parse(a.appProperties?.snapshot_at || a.createdTime),
    ),
  );
  readonly v = inject(VaultService);
  readonly fileName = signal('');
  file?: File;
  secret = '';
  mode: 'passphrase' | 'recovery' = 'passphrase';
  login = '';
  confirmation = '';
  replaceConfirmed = false;
  readonly driveId = signal('');
  constructor() {
    effect(() => {
      const files = this.sortedFiles();
      if (!files.some((f) => f.id === this.driveId())) this.driveId.set(files[0]?.id ?? '');
    });
    effect(() => {
      this.v.state();
      this.b.preview();
      this.b.safetyReady();
      this.secret = '';
      this.login = '';
      this.confirmation = '';
      this.replaceConfirmed = false;
    });
    void this.b
      .refresh()
      .catch(() =>
        this.b.message.set(
          'Browser backup storage is unavailable. Downloaded files remain available.',
        ),
      );
  }
  back() {
    this.b.clearPreview();
    this.startup.choice.set('welcome');
    this.startup.restoreLocked.set(false);
  }
  backToCreate() {
    this.b.clearPreview();
    this.startup.choice.set('create');
  }
  switchKey() {
    this.secret = '';
    this.mode = this.mode === 'passphrase' ? 'recovery' : 'passphrase';
  }
  choose(event: Event) {
    const input = event.target as HTMLInputElement;
    this.file = input.files?.[0];
    this.fileName.set(this.file?.name ?? '');
    input.value = '';
    this.b.clearPreview();
  }
  verify() {
    const file = this.file,
      secret = this.secret,
      mode = this.mode;
    this.secret = '';
    void this.v.perform(async () => {
      if (!file) throw new Error('Choose an encrypted backup file.');
      await this.b.inspectFile(file, secret, mode);
      this.file = undefined;
      this.fileName.set('');
    });
  }
  commit() {
    const login = this.login,
      confirmation = this.confirmation,
      confirmed = this.replaceConfirmed;
    this.login = '';
    this.confirmation = '';
    this.replaceConfirmed = false;
    void this.v.perform(async () => {
      if (!this.b.auth.initialized() && !this.b.auth.googleSetupReady() && login !== confirmation)
        throw new Error('Login passwords do not match.');
      await this.b.commit(login, confirmed);
    });
  }
  timestamp(value: string) {
    if (!Number.isFinite(Date.parse(value))) return 'Unknown snapshot time';
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: this.b.preferences.value().timezone,
    }).format(new Date(value));
  }
  refresh() {
    void this.v.perform(() => this.b.refresh());
  }
  setBackupPreference(key: 'backup_frequency' | 'backup_keep', value: any) {
    void this.v.perform(async () =>
      this.b.preferences.set({ ...this.b.preferences.value(), [key]: value }),
    );
  }
  uploadDrive() {
    void this.v.perform(() => this.b.uploadDrive());
  }
  refreshDrive() {
    void this.v.perform(() => this.b.google.list());
  }
  verifyDrive() {
    const secret = this.secret,
      mode = this.mode,
      id = this.driveId();
    this.secret = '';
    void this.v.perform(() => this.b.inspectDrive(id, secret, mode));
  }
  disconnectDrive() {
    if (window.confirm('Disconnect Drive on this device? Existing backups remain in Google Drive.'))
      void this.v.perform(() => this.b.google.disconnect());
  }
  export(drafts = false) {
    void this.v.perform(() => this.b.exportBackup(drafts).then(() => {}));
  }
  safety() {
    void this.v.perform(() => this.b.prepareSafety());
  }
  history(id: string) {
    void this.v.perform(() => this.b.downloadHistory(id));
  }
  remove(id: string) {
    if (window.confirm('Remove this browser backup copy? Keep a separate downloaded copy first.'))
      void this.v.perform(() => this.b.removeLocal(id));
  }
}
