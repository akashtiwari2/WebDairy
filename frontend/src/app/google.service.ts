import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { AuthService, APIError } from './auth.service';
import { VaultService } from './vault.service';
export interface GoogleStatus {
  configured: boolean;
  offline_password_available?: boolean;
  linked: boolean;
  drive_connected: boolean;
  setup_ready: boolean;
  email: string;
  flow_done: boolean;
  flow_error: string;
}
export interface DriveFile {
  id: string;
  name: string;
  createdTime: string;
  size: string;
  appProperties?: { snapshot_at?: string; vault_id?: string };
}
@Injectable({ providedIn: 'root' })
export class GoogleService {
  readonly auth = inject(AuthService);
  readonly vault = inject(VaultService);
  readonly status = signal<GoogleStatus>({
    configured: false,
    linked: false,
    drive_connected: false,
    setup_ready: false,
    email: '',
    flow_done: false,
    flow_error: '',
  });
  readonly files = signal<DriveFile[]>([]);
  readonly error = signal('');
  readonly connecting = signal(false);
  readonly loading = signal(false);
  readonly listed = signal(false);
  private poll?: ReturnType<typeof setInterval>;
  private popup?: Window | null;
  private expires = 0;
  private polling = false;
  constructor() {
    void this.refresh().catch(() => {});
    inject(DestroyRef).onDestroy(() => clearInterval(this.poll));
  }
  async refresh() {
    this.status.set(await this.auth.request<GoogleStatus>('/api/google/status'));
  }
  async connect(purpose: 'login' | 'link' | 'drive') {
    if (this.connecting()) return;
    // Open synchronously from the click so popup blockers do not discard OAuth.
    this.popup = window.open('about:blank', 'webdiary-google', 'popup,width=620,height=760');
    if (!this.popup) {
      this.error.set('Allow this app to open a Google sign-in window, then retry.');
      return;
    }
    this.connecting.set(true);
    this.error.set('');
    this.listed.set(false);
    this.files.set([]);
    try {
      const result = await this.auth.request<{ url: string }>('/api/google/start', 'POST', {
        purpose,
      });
      this.popup.location.href = result.url;
      this.expires = Date.now() + 10 * 60000;
      this.poll = setInterval(() => void this.finish(purpose), 1500);
    } catch (e) {
      this.stop();
      this.error.set(this.message(e));
    }
  }
  private async finish(purpose: string) {
    if (this.polling) return;
    if (Date.now() > this.expires) {
      this.cancel();
      this.error.set('Google sign-in timed out. Retry when connected.');
      return;
    }
    this.polling = true;
    try {
      await this.refresh();
      if (this.status().flow_done) {
        const error = this.status().flow_error;
        if (error) {
          this.stop();
          this.error.set(error);
          return;
        }
        await this.auth.session();
        await this.refresh();
        // Callback cookies can arrive a moment after the backend flow completes.
        if (purpose === 'login' && !this.auth.authenticated() && !this.auth.googleSetupReady())
          return;
        if (purpose === 'drive' && !this.status().drive_connected) return;
        this.stop();
        if (purpose === 'login' && this.vault.state() !== 'unlocked')
          await this.vault.perform(() => this.vault.start());
        if (this.status().drive_connected) await this.list();
      }
      // Google may isolate its popup using COOP. Completion comes from the
      // authenticated backend flow, not the popup's cross-origin closed flag.
    } catch (e) {
      this.error.set(this.message(e));
    } finally {
      this.polling = false;
    }
  }
  cancel() {
    this.stop();
    void this.auth.request('/api/google/cancel', 'POST', {}).catch(() => {});
  }
  private stop() {
    clearInterval(this.poll);
    this.poll = undefined;
    this.connecting.set(false);
    this.popup?.close();
    this.popup = undefined;
  }
  message(e: unknown) {
    return e instanceof APIError && e.data?.message
      ? e.data.message
      : e instanceof Error
        ? e.message
        : 'Google connection failed. Retry.';
  }
  async list() {
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.auth.request<{ backups: DriveFile[] }>('/api/drive/backups');
      this.files.set(result.backups);
      this.listed.set(true);
    } catch (e) {
      this.files.set([]);
      this.listed.set(false);
      this.error.set(this.message(e));
      throw e;
    } finally {
      this.loading.set(false);
    }
  }
  async disconnect() {
    await this.auth.request('/api/drive/disconnect', 'POST', {});
    this.files.set([]);
    await this.refresh();
  }
}
