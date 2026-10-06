import { DestroyRef, Injectable, inject, signal } from '@angular/core';

export interface Entry {
  date: string;
  title: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export type SaveStatus =
  'loading' | 'blank' | 'unsaved' | 'saving' | 'saved' | 'failed' | 'conflict' | 'deleting';
export interface EntryState {
  title: string;
  body: string;
  revision: number;
  savedTitle: string;
  savedBody: string;
  loaded: boolean;
  status: SaveStatus;
  error: string;
  conflict?: Entry | null;
  deleteRequested: boolean;
}
interface Attempt {
  title: string;
  body: string;
  expected_revision: number;
  operation_id: string;
}
const empty = (): EntryState => ({
  title: '',
  body: '',
  revision: 0,
  savedTitle: '',
  savedBody: '',
  loaded: false,
  status: 'loading',
  error: '',
  conflict: undefined,
  deleteRequested: false,
});
const dirty = (entry: EntryState) =>
  entry.title !== entry.savedTitle || entry.body !== entry.savedBody;
const hasText = (entry: Pick<EntryState, 'title' | 'body'>) =>
  !!(entry.title.trim() || entry.body.trim());

export function validCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

@Injectable({ providedIn: 'root' })
export class DiaryService {
  readonly states = signal<Record<string, EntryState>>({});
  readonly dates = signal(new Set<string>());
  readonly indexError = signal('');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Attempt>();
  private readonly retries = new Map<string, number>();
  private destroyed = false;

  constructor() {
    const unload = (event: BeforeUnloadEvent) => {
      if (this.hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.timers.forEach((timer) => clearTimeout(timer));
      window.removeEventListener('beforeunload', unload);
    });
  }

  private request(url: string, options: RequestInit = {}) {
    return fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  }

  state(date: string): EntryState {
    return this.states()[date] ?? empty();
  }
  hasUnsavedChanges(): boolean {
    return (
      this.pending.size > 0 ||
      Object.values(this.states()).some((entry) => dirty(entry) || entry.deleteRequested)
    );
  }
  private patch(date: string, change: Partial<EntryState>) {
    this.states.update((states) => ({ ...states, [date]: { ...this.state(date), ...change } }));
  }
  private mark(date: string, present: boolean) {
    this.dates.update((dates) => {
      const next = new Set(dates);
      if (present) next.add(date);
      else next.delete(date);
      return next;
    });
  }
  async loadDates() {
    try {
      const response = await this.request('/api/entries');
      if (!response.ok) throw new Error();
      const result: { dates: string[] } = await response.json();
      const dates = new Set(result.dates);
      // A list response must not undo newer local confirmations.
      for (const [date, state] of Object.entries(this.states()))
        if (state.loaded) {
          if (state.revision > 0) dates.add(date);
          else dates.delete(date);
        }
      this.dates.set(dates);
      this.indexError.set('');
    } catch {
      this.indexError.set('Calendar markers unavailable.');
    }
  }
  load(date: string): Promise<void> {
    if (this.state(date).loaded) return Promise.resolve();
    const existing = this.loads.get(date);
    if (existing) return existing;
    this.patch(date, { status: 'loading', error: '' });
    const flight = this.read(date).finally(() => this.loads.delete(date));
    this.loads.set(date, flight);
    return flight;
  }
  private async read(date: string) {
    try {
      const response = await this.request(`/api/entries/${date}`);
      if (response.status === 404) {
        this.patch(date, { ...empty(), loaded: true, status: 'blank' });
        this.mark(date, false);
        return;
      }
      if (!response.ok) throw new Error();
      const entry: Entry = await response.json();
      this.adopt(date, entry);
    } catch {
      this.patch(date, {
        status: 'failed',
        error: 'Could not load this date. Retry before writing.',
      });
    }
  }
  private adopt(date: string, entry: Entry | null) {
    this.pending.delete(date);
    this.retries.delete(date);
    this.patch(
      date,
      entry
        ? {
            ...empty(),
            title: entry.title,
            body: entry.body,
            savedTitle: entry.title,
            savedBody: entry.body,
            revision: entry.revision,
            loaded: true,
            status: 'saved',
          }
        : { ...empty(), loaded: true, status: 'blank' },
    );
    this.mark(date, !!entry);
  }
  edit(date: string, title: string, body: string) {
    const previous = this.state(date);
    if (!previous.loaded || previous.deleteRequested) return;
    this.patch(date, { title, body, error: previous.status === 'conflict' ? previous.error : '' });
    const entry = this.state(date);
    if (previous.status === 'conflict') return;
    const status =
      dirty(entry) || this.pending.has(date) ? 'unsaved' : entry.revision ? 'saved' : 'blank';
    this.patch(date, { status });
    this.retries.delete(date);
    this.cancelTimer(date);
    if (status === 'unsaved') this.schedule(date, 1000);
  }
  private cancelTimer(date: string) {
    clearTimeout(this.timers.get(date));
    this.timers.delete(date);
  }
  private schedule(date: string, delay: number) {
    if (this.destroyed) return;
    this.cancelTimer(date);
    this.timers.set(
      date,
      setTimeout(() => {
        this.timers.delete(date);
        void this.save(date);
      }, delay),
    );
  }
  save(date: string): Promise<void> {
    this.cancelTimer(date);
    const existing = this.flights.get(date);
    if (existing) return existing;
    const entry = this.state(date);
    if (!entry.loaded || entry.status === 'conflict' || entry.deleteRequested || this.destroyed)
      return Promise.resolve();
    const flight = this.persist(date).finally(() => this.flights.delete(date));
    this.flights.set(date, flight);
    return flight;
  }
  private async persist(date: string) {
    while (!this.destroyed) {
      const current = this.state(date);
      let attempt = this.pending.get(date);
      if (!attempt && !dirty(current)) {
        this.patch(date, { status: current.revision ? 'saved' : 'blank', error: '' });
        return;
      }
      if (!attempt) {
        if (!hasText(current)) {
          this.patch(date, {
            status: current.revision ? 'unsaved' : 'blank',
            error: current.revision
              ? 'Clearing text does not delete an entry. Use Delete entry or restore the saved text.'
              : '',
          });
          return;
        }
        if (
          [...current.title].length > 200 ||
          new TextEncoder().encode(current.body).length > 1048576
        ) {
          this.patch(date, {
            status: 'failed',
            error: 'Title limit is 200 characters; body limit is 1 MiB.',
          });
          return;
        }
        attempt = {
          title: current.title,
          body: current.body,
          expected_revision: current.revision,
          operation_id: crypto.randomUUID(),
        };
        this.pending.set(date, attempt);
      }
      this.patch(date, { status: 'saving', error: '' });
      let transient = true;
      try {
        const response = await this.request(`/api/entries/${date}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt),
        });
        if (response.status === 409) {
          const result: { current: Entry | null } = await response.json();
          this.patch(date, {
            status: 'conflict',
            conflict: result.current,
            error:
              'This entry changed elsewhere. Your draft is preserved. Compare before choosing a version.',
          });
          return;
        }
        if (!response.ok) {
          transient = response.status >= 500 || response.status === 429;
          if (!transient) this.pending.delete(date);
          throw new Error();
        }
        const saved: Entry = await response.json();
        this.pending.delete(date);
        this.retries.delete(date);
        this.patch(date, {
          revision: saved.revision,
          savedTitle: saved.title,
          savedBody: saved.body,
        });
        this.mark(date, true);
        // The user's newer edits remain untouched. The next iteration saves them
        // only after this revision is acknowledged, serializing writes per date.
      } catch {
        const retries = this.retries.get(date) ?? 0;
        const retry = transient && retries < 3;
        this.patch(date, {
          status: 'failed',
          error: retry
            ? 'Save failed. Draft kept in this tab; retrying shortly.'
            : 'Save failed. Draft kept in this tab. Use Retry save.',
        });
        if (retry) {
          this.retries.set(date, retries + 1);
          this.schedule(date, 1000 * 2 ** retries);
        }
        return;
      }
    }
  }
  async retry(date: string) {
    if (!this.state(date).loaded) return this.load(date);
    this.retries.delete(date);
    if (this.state(date).deleteRequested) return this.deleteEntry(date);
    return this.save(date);
  }
  useSavedVersion(date: string) {
    this.cancelTimer(date);
    const entry = this.state(date);
    if (entry.status !== 'conflict') return;
    this.adopt(date, entry.conflict ?? null);
  }
  async overwriteWithDraft(date: string) {
    const entry = this.state(date);
    if (entry.status !== 'conflict') return;
    this.pending.delete(date);
    this.patch(date, {
      revision: entry.conflict?.revision ?? 0,
      savedTitle: entry.conflict?.title ?? '',
      savedBody: entry.conflict?.body ?? '',
      conflict: undefined,
      deleteRequested: false,
      status: 'unsaved',
      error: '',
    });
    return this.save(date);
  }
  async deleteEntry(date: string) {
    this.cancelTimer(date);
    const flight = this.flights.get(date);
    if (flight) await flight;
    if (this.pending.has(date)) {
      await this.save(date);
      if (this.pending.has(date)) {
        if (this.state(date).status !== 'conflict')
          this.patch(date, {
            status: 'failed',
            error:
              'A previous save is unconfirmed. Retry saving before deleting or discarding this draft.',
          });
        return;
      }
    }
    const entry = this.state(date);
    if (!entry.loaded || entry.status === 'conflict') return;
    if (!entry.revision) {
      this.adopt(date, null);
      return;
    }
    this.patch(date, { status: 'deleting', deleteRequested: true, error: '' });
    try {
      const response = await this.request(`/api/entries/${date}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: entry.revision }),
      });
      if (response.status === 409) {
        const result: { current: Entry | null } = await response.json();
        this.patch(date, {
          status: 'conflict',
          deleteRequested: false,
          conflict: result.current,
          error:
            'Entry changed before deletion. Your text is preserved; compare the saved version first.',
        });
        return;
      }
      if (!response.ok && response.status !== 404) throw new Error();
      this.adopt(date, null);
    } catch {
      this.patch(date, {
        status: 'failed',
        error:
          'Deletion was not confirmed. Your text is kept in this tab. Retry to confirm deletion.',
      });
    }
  }
}
