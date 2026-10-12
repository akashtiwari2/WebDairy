import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GoogleService, GoogleStatus } from './google.service';
import { AuthService } from './auth.service';
import { VaultService } from './vault.service';
describe('Google popup completion', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('waits for callback cookies and tolerates an isolated popup before completing Google-only setup', async () => {
    vi.useFakeTimers();
    const status: GoogleStatus = {
      configured: true,
      linked: false,
      drive_connected: false,
      setup_ready: false,
      email: '',
      flow_done: false,
      flow_error: '',
    };
    let arrived = false;
    const auth = {
      authenticated: signal(false),
      googleSetupReady: signal(false),
      session: vi.fn(async () => {
        auth.googleSetupReady.set(arrived);
      }),
      request: vi.fn(async (path: string) =>
        path === '/api/google/start'
          ? { url: 'https://accounts.google.com/synthetic' }
          : { ...status },
      ),
    };
    const vault = {
      state: signal('setup'),
      perform: async (fn: () => Promise<void>) => fn(),
      start: vi.fn(async () => {}),
    };
    const popup = { closed: true, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    TestBed.configureTestingModule({
      providers: [
        GoogleService,
        { provide: AuthService, useValue: auth },
        { provide: VaultService, useValue: vault },
      ],
    });
    const g = TestBed.inject(GoogleService);
    await g.connect('login');
    await vi.advanceTimersByTimeAsync(1500);
    expect(g.connecting()).toBe(true);
    status.flow_done = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(g.connecting()).toBe(true);
    expect(vault.start).not.toHaveBeenCalled();
    arrived = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(g.connecting()).toBe(false);
    expect(vault.start).toHaveBeenCalledOnce();
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it('shows blocked-popup feedback without starting an OAuth request', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ configured: true }));
    vi.spyOn(window, 'open').mockReturnValue(null);
    TestBed.configureTestingModule({
      providers: [
        GoogleService,
        { provide: AuthService, useValue: { request } },
        { provide: VaultService, useValue: {} },
      ],
    });
    const g = TestBed.inject(GoogleService);
    await g.connect('login');
    expect(g.error()).toContain('Allow this app');
    expect(request.mock.calls).toHaveLength(1); // Constructor status only.
  });
});
