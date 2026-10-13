import { Injectable, signal } from '@angular/core';
export class APIError extends Error {
  constructor(
    readonly status: number,
    readonly data: any,
  ) {
    super(
      data?.error === 'google_setup_expired'
        ? data.message
        : status === 401
          ? 'Login expired. Your encrypted draft is retained.'
          : status === 429
            ? 'Too many login attempts. Wait one minute.'
            : data?.error === 'database_unavailable'
              ? 'Diary storage is unavailable. Keep PostgreSQL running and try again.'
              : status === 502 || status === 503
                ? 'WebDairy is not responding. Keep the local program running and try again.'
                : 'This action could not be completed. Please try again.',
    );
  }
}
interface Session {
  initialized: boolean;
  authenticated: boolean;
  csrf_token: string;
  google_setup_ready?: boolean;
}
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly authenticated = signal(false);
  readonly initialized = signal(false);
  readonly googleSetupReady = signal(false);
  private csrf = '';
  accept(profile: Session) {
    this.authenticated.set(profile.authenticated);
    this.initialized.set(profile.initialized);
    this.googleSetupReady.set(profile.google_setup_ready === true);
    this.csrf = profile.csrf_token;
  }
  async session() {
    this.accept(await this.request<Session>('/api/auth/session'));
  }
  async login(password: string) {
    this.accept(await this.request<Session>('/api/auth/login', 'POST', { password }));
  }
  async setup(login_password: string, envelope: unknown) {
    this.accept(
      await this.request<Session>('/api/auth/setup', 'POST', {
        login_password,
        envelope,
        use_google: this.googleSetupReady(),
      }),
    );
  }
  async logout() {
    await this.request('/api/auth/logout', 'POST');
    this.authenticated.set(false);
    await this.session();
  }
  async changePassword(current_password: string, new_password: string) {
    await this.request('/api/auth/password', 'POST', { current_password, new_password });
    this.authenticated.set(false);
    await this.session();
  }
  async request<T>(path: string, method = 'GET', value?: unknown, timeout = 10000): Promise<T> {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
      headers:
        method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 401) this.authenticated.set(false);
      if (data?.error === 'google_setup_expired') this.googleSetupReady.set(false);
      throw new APIError(response.status, data);
    }
    return data as T;
  }
}
