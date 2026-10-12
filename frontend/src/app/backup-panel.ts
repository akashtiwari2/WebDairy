import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BackupService } from './backup.service';
import { VaultService } from './vault.service';
@Component({
  selector: 'app-backup-panel',
  imports: [FormsModule],
  templateUrl: './backup-panel.html',
})
export class BackupPanel {
  readonly b = inject(BackupService);
  readonly v = inject(VaultService);
  readonly fileName = signal('');
  file?: File;
  secret = '';
  mode: 'passphrase' | 'recovery' = 'passphrase';
  login = '';
  confirmation = '';
  replaceConfirmed = false;
  constructor() {
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
      if (!this.b.auth.initialized() && login !== confirmation)
        throw new Error('Login passwords do not match.');
      await this.b.commit(login, confirmed);
    });
  }
  timestamp(value: string) {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: this.b.preferences.value().timezone,
    }).format(new Date(value));
  }
  refresh() {
    void this.v.perform(() => this.b.refresh());
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
