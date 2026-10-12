import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LibraryPanel } from './library-panel';
import { DiaryService, EntryState } from './diary.service';
import { VaultService } from './vault.service';
import { PreferencesService, defaults } from './preferences.service';

describe('Local library and confirmed retention cleanup', () => {
  let panel: LibraryPanel;
  const purge = vi.fn(async (_id: string) => {});
  function row(id: string, date: string, age: number, trashed = false): EntryState {
    return {
      id,
      date,
      title: 'Mixed CASE title',
      body: 'Private local text',
      revision: 1,
      trashed,
      trashed_at: trashed ? new Date(Date.now() - age * 86400000).toISOString() : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      savedTitle: 'Mixed CASE title',
      savedBody: 'Private local text',
      savedTrashed: trashed,
      loaded: true,
      status: 'saved',
      error: '',
      deleteRequested: false,
    };
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    purge.mockClear();
    TestBed.configureTestingModule({
      providers: [
        LibraryPanel,
        {
          provide: DiaryService,
          useValue: {
            states: signal(
              new Map([
                ['2026-10-11', row('today', '2026-10-11', 0)],
                ['2099-10-20', row('future', '2099-10-20', 0)],
              ]),
            ),
            trash: signal(
              new Map([
                ['expired', row('expired', '2026-01-01', 31, true)],
                ['recent', row('recent', '2026-01-02', 29, true)],
              ]),
            ),
            purgeTrash: purge,
          },
        },
        {
          provide: VaultService,
          useValue: { perform: async (action: () => Promise<void>) => action() },
        },
        { provide: PreferencesService, useValue: { value: signal({ ...defaults }) } },
      ],
    });
    panel = TestBed.inject(LibraryPanel);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('filters title/body locally, case-insensitively and by civil-date range', () => {
    panel.query.set('cAsE TITLE');
    panel.from.set('2099-01-01');
    panel.until.set('2099-12-31');
    expect(panel.results().map((s) => s.id)).toEqual(['future']);
    panel.query.set('PRIVATE LOCAL');
    expect(panel.results()[0].excerpt).toBe('Private local text');
    expect(panel.results().some((s) => s.trashed)).toBe(false);
  });
  it('combines private mood/tag filters with text and dates', () => {
    const diary = TestBed.inject(DiaryService);
    diary.states.set(
      new Map(
        [...diary.states()].map(([date, row]) => [
          date,
          {
            ...row,
            mood: date.startsWith('2099') ? ('Calm' as const) : ('Happy' as const),
            tags: ['Travel'],
          },
        ]),
      ),
    );
    panel.mood.set('Calm');
    panel.tag.set('travel');
    expect(panel.results().map((s) => s.id)).toEqual(['future']);
    panel.query.set('travel');
    expect(panel.results()).toHaveLength(1);
    panel.tag.set('work');
    expect(panel.results()).toHaveLength(0);
  });
  it('does not purge without confirmation and only removes expired trash when confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    panel.purgeExpired();
    expect(purge).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    panel.purgeExpired();
    await Promise.resolve();
    expect(purge.mock.calls.map(([id]) => id)).toEqual(['expired']);
  });
  it('updates the expiry count as time passes while the unlocked panel stays open', async () => {
    expect(panel.expired().map((s) => s.id)).toEqual(['expired']);
    await vi.advanceTimersByTimeAsync(2 * 86400000);
    expect(
      panel
        .expired()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['expired', 'recent']);
  });
});
