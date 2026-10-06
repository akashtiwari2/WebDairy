import { TestBed } from '@angular/core/testing';
import { App, todayInKolkata } from './app';
import { DiaryService, Entry, validCivilDate } from './diary.service';

type Attempt = { title: string; body: string; expected_revision: number; operation_id: string };
const response = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const date = '2030-10-20';
const stored = (value: string, body = 'Synthetic body', revision = 1): Entry => ({
  date: value,
  title: 'Sample title',
  body,
  revision,
  created_at: '2026-10-06T00:00:00Z',
  updated_at: '2026-10-06T00:00:00Z',
});

describe('Persistent diary and autosave', () => {
  let database: Record<string, Entry>;
  let operations: Record<string, string>;
  let handle: (url: string, init?: RequestInit) => Promise<Response>;
  let api: ReturnType<typeof vi.fn<typeof handle>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    database = {};
    operations = {};
    handle = async (url, init) => {
      if (url === '/api/health') return response(200, { database: 'ready' });
      if (url === '/api/entries') return response(200, { dates: Object.keys(database) });
      const date = url.split('/').at(-1)!;
      const entry = database[date];
      if (init?.method === 'PUT') {
        const attempt: Attempt = JSON.parse(init.body as string);
        if (
          entry &&
          operations[date] === attempt.operation_id &&
          entry.revision === attempt.expected_revision + 1 &&
          entry.body === attempt.body &&
          entry.title === attempt.title
        )
          return response(200, { ...entry });
        if ((entry?.revision ?? 0) !== attempt.expected_revision)
          return response(409, { current: entry ? { ...entry } : null });
        const next: Entry = {
          ...stored(date),
          title: attempt.title,
          body: attempt.body,
          revision: attempt.expected_revision + 1,
        };
        database[date] = next;
        operations[date] = attempt.operation_id;
        return response(200, { ...next });
      }
      if (init?.method === 'DELETE') {
        if (!entry) return response(404);
        if (entry.revision !== JSON.parse(init.body as string).expected_revision)
          return response(409, { current: { ...entry } });
        delete database[date];
        return response(204);
      }
      return entry ? response(200, { ...entry }) : response(404);
    };
    api = vi.fn(handle);
    vi.stubGlobal('fetch', api);
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const writes = (mock: typeof api) => mock.mock.calls.filter(([, init]) => init?.method === 'PUT');
  async function ready(value = date) {
    const service = TestBed.inject(DiaryService);
    await service.load(value);
    return service;
  }

  it('autosaves after one idle second and marks Saved only after acknowledgement', async () => {
    const service = await ready();
    service.edit(date, 'Sample future plan', 'Synthetic writing');
    expect(service.state(date).status).toBe('unsaved');
    await vi.advanceTimersByTimeAsync(999);
    expect(writes(api)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(database[date].body).toBe('Synthetic writing');
    expect(service.state(date).status).toBe('saved');
    expect(service.hasUnsavedChanges()).toBe(false);
    expect(service.dates().has(date)).toBe(true);
  });
  it('serializes rapid edits without an older response overwriting new text', async () => {
    const service = await ready();
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => (release = resolve));
    let first = true;
    // Resolve a committed first response manually while newer typing is in memory.
    let firstResponse!: Response;
    api.mockImplementation(async (url, init) => {
      if (init?.method === 'PUT' && first) {
        first = false;
        firstResponse = await handle(url, init);
        return gate;
      }
      return handle(url, init);
    });
    service.edit(date, 'Sample', 'First');
    const saving = service.save(date);
    await Promise.resolve();
    service.edit(date, 'Sample', 'Newest');
    expect(writes(api)).toHaveLength(1);
    expect(service.state(date).body).toBe('Newest');
    release(firstResponse);
    await saving;
    expect(writes(api)).toHaveLength(2);
    expect(database[date].body).toBe('Newest');
    expect(database[date].revision).toBe(2);
    expect(service.state(date).body).toBe('Newest');
    expect(service.state(date).status).toBe('saved');
  });
  it('keeps failed text and recovers with Retry rather than reporting Saved', async () => {
    const service = await ready();
    api.mockImplementation((url, init) =>
      init?.method === 'PUT' ? Promise.resolve(response(503)) : handle(url, init),
    );
    service.edit(date, 'Sample', 'Kept draft');
    await service.save(date);
    expect(service.state(date).status).toBe('failed');
    expect(service.state(date).body).toBe('Kept draft');
    expect(service.hasUnsavedChanges()).toBe(true);
    expect(database[date]).toBeUndefined();
    api.mockImplementation(handle);
    await service.retry(date);
    expect(service.state(date).status).toBe('saved');
    expect(database[date].body).toBe('Kept draft');
  });
  it('retries the same operation after a lost response without creating a second revision', async () => {
    const service = await ready();
    let lost = true;
    api.mockImplementation(async (url, init) => {
      const result = await handle(url, init);
      if (init?.method === 'PUT' && lost) {
        lost = false;
        throw new TypeError('Synthetic network loss');
      }
      return result;
    });
    service.edit(date, 'Sample', 'Committed but response lost');
    await service.save(date);
    expect(service.state(date).status).toBe('failed');
    expect(database[date].revision).toBe(1);
    await service.retry(date);
    const attempts = writes(api).map(([, init]) => JSON.parse(init!.body as string));
    expect(attempts[1].operation_id).toBe(attempts[0].operation_id);
    expect(database[date].revision).toBe(1);
    expect(service.state(date).status).toBe('saved');
  });
  it('times out a stalled request without losing the draft', async () => {
    // Node implements AbortSignal.timeout with native timers outside fake timers.
    // Supply the equivalent browser signal so this test can advance time deterministically.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const service = await ready();
    api.mockImplementation((url, options) =>
      options?.method === 'PUT'
        ? new Promise<Response>((_, reject) =>
            options.signal!.addEventListener('abort', () =>
              reject(new DOMException('Synthetic timeout', 'AbortError')),
            ),
          )
        : handle(url, options),
    );
    service.edit(date, 'Sample', 'Stalled network draft');
    const saving = service.save(date);
    await vi.advanceTimersByTimeAsync(8000);
    await saving;
    expect(service.state(date).status).toBe('failed');
    expect(service.state(date).body).toBe('Stalled network draft');
  });

  it('confirms an unknown creation before discarding so a lost response cannot leave a hidden entry', async () => {
    const service = await ready();
    let lost = true;
    api.mockImplementation(async (url, init) => {
      const result = await handle(url, init);
      if (init?.method === 'PUT' && lost) {
        lost = false;
        throw new TypeError('Synthetic response loss');
      }
      return result;
    });
    service.edit(date, 'Sample', 'Unknown committed draft');
    await service.save(date);
    expect(service.state(date).revision).toBe(0);
    expect(database[date].revision).toBe(1);
    await service.deleteEntry(date);
    expect(database[date]).toBeUndefined();
    expect(service.state(date).status).toBe('blank');
    expect(service.hasUnsavedChanges()).toBe(false);
  });

  it('bounds automatic failure retries while retaining the draft', async () => {
    const service = await ready();
    api.mockImplementation((url, init) =>
      init?.method === 'PUT' ? Promise.resolve(response(503)) : handle(url, init),
    );
    service.edit(date, 'Sample', 'Still here');
    await service.save(date);
    await vi.advanceTimersByTimeAsync(30000);
    expect(writes(api)).toHaveLength(4);
    expect(service.state(date).body).toBe('Still here');
    expect(service.state(date).status).toBe('failed');
  });
  it('preserves a conflicting draft and requires an explicit version choice', async () => {
    database[date] = stored(date, 'Original');
    const service = await ready();
    database[date] = stored(date, 'Another tab', 2);
    service.edit(date, 'My title', 'My draft');
    await service.save(date);
    expect(service.state(date).status).toBe('conflict');
    expect(service.state(date).body).toBe('My draft');
    expect(service.state(date).conflict?.body).toBe('Another tab');
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes(api)).toHaveLength(1);
    await service.overwriteWithDraft(date);
    expect(database[date].revision).toBe(3);
    expect(database[date].body).toBe('My draft');
  });
  it('can discard a conflicting draft in favour of the saved version', async () => {
    database[date] = stored(date, 'Original');
    const service = await ready();
    database[date] = stored(date, 'Other version', 2);
    service.edit(date, 'Sample', 'My draft');
    await service.save(date);
    service.useSavedVersion(date);
    expect(service.state(date).body).toBe('Other version');
    expect(service.state(date).status).toBe('saved');
    expect(service.hasUnsavedChanges()).toBe(false);
  });
  it('does not silently recreate an entry deleted by another editor', async () => {
    database[date] = stored(date);
    const service = await ready();
    delete database[date];
    service.edit(date, 'Sample', 'My draft');
    await service.save(date);
    expect(service.state(date).status).toBe('conflict');
    expect(service.state(date).conflict).toBeNull();
    expect(database[date]).toBeUndefined();
    await service.overwriteWithDraft(date);
    expect(database[date].revision).toBe(1);
  });
  it('empty visits create nothing, title-only entries save, and clearing requires deletion', async () => {
    const service = await ready();
    await service.save(date);
    expect(writes(api)).toHaveLength(0);
    service.edit(date, 'Title only', '');
    await service.save(date);
    expect(database[date].title).toBe('Title only');
    service.edit(date, '', '');
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.state(date).status).toBe('unsaved');
    expect(database[date].title).toBe('Title only');
    expect(service.state(date).error).toContain('Use Delete entry');
    await service.deleteEntry(date);
    expect(database[date]).toBeUndefined();
    expect(service.dates().has(date)).toBe(false);
  });
  it('failed deletion is kept pending and can be retried safely', async () => {
    database[date] = stored(date);
    const service = await ready();
    api.mockImplementation((url, init) =>
      init?.method === 'DELETE' ? Promise.resolve(response(503)) : handle(url, init),
    );
    await service.deleteEntry(date);
    expect(service.state(date).status).toBe('failed');
    expect(service.state(date).body).toBe('Synthetic body');
    expect(service.state(date).deleteRequested).toBe(true);
    api.mockImplementation(handle);
    await service.retry(date);
    expect(service.state(date).status).toBe('blank');
    expect(service.hasUnsavedChanges()).toBe(false);
  });
  it('blocks editing when the date could not be loaded and supports load retry', async () => {
    api.mockResolvedValue(response(503));
    const service = await ready();
    service.edit(date, 'Cannot write', 'Unknown base');
    expect(service.state(date).body).toBe('');
    expect(service.state(date).loaded).toBe(false);
    api.mockImplementation(handle);
    await service.retry(date);
    expect(service.state(date).loaded).toBe(true);
  });
  it('saves a future draft on navigation and loads confirmed text in a fresh client', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    await app.select(date);
    app.edit('Future sample', 'Birthday plans');
    await app.select('2024-02-29');
    await app.diary.save(date);
    await app.select(date);
    expect(app.entry().body).toBe('Birthday plans');
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
    const reopened = TestBed.createComponent(App).componentInstance;
    await reopened.select(date);
    expect(reopened.entry().body).toBe('Birthday plans');
    expect(reopened.selected()).toBe(date);
    expect(reopened.entry().status).toBe('saved');
  });
  it('preserves unsaved text on navigation even when both save and target load fail', async () => {
    const app = TestBed.createComponent(App).componentInstance;
    await app.select(date);
    api.mockResolvedValue(response(503));
    app.edit('Sample', 'Do not lose this');
    await app.select('2040-01-01');
    await app.diary.save(date);
    expect(app.entry().loaded).toBe(false);
    await app.select(date);
    expect(app.entry().body).toBe('Do not lose this');
    expect(app.entry().status).toBe('failed');
  });
  it('warns before unloading a pending draft but not a confirmed save', async () => {
    const service = await ready();
    service.edit(date, 'Sample', 'Pending');
    const pending = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
    await service.save(date);
    const saved = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });
  it('keeps the selected civil date and text across Kolkata midnight', async () => {
    vi.setSystemTime(new Date('2026-10-06T18:29:50Z'));
    const app = TestBed.createComponent(App).componentInstance;
    await app.diary.load(app.selected());
    app.edit('Sample', 'Midnight draft');
    const selected = app.selected();
    await vi.advanceTimersByTimeAsync(30000);
    expect(app.today()).toBe('2026-10-07');
    expect(app.selected()).toBe(selected);
    expect(app.entry().body).toBe('Midnight draft');
  });
  it('validates civil dates, leap day and minimum/maximum supported years', () => {
    expect(todayInKolkata(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07');
    for (const value of ['2024-02-29', '0001-01-01', '9999-12-31'])
      expect(validCivilDate(value)).toBe(true);
    for (const value of ['2023-02-29', '2024-04-31', '0000-01-01', '2024-1-01'])
      expect(validCivilDate(value)).toBe(false);
  });
  it('renders sample-only notice and text without interpreting it as HTML', async () => {
    database[date] = stored(date, '<img src=x onerror=alert(1)>');
    const fixture = TestBed.createComponent(App);
    await fixture.componentInstance.select(date);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('without encryption');
    expect(root.querySelector('textarea')!.value).toContain('<img');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('Saved');
  });
});
