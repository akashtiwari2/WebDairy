import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { AuthService, APIError } from './auth.service';
import { VaultService } from './vault.service';
import { DraftStore } from './drafts';
import {
  Payload,
  Mood,
  OpaqueRecord,
  OpaqueWrite,
  context,
  encryptJSON,
  decryptJSON,
  validatePayload,
  uuid,
  validCivilDate,
} from './vault-crypto';
export { validCivilDate } from './vault-crypto';
export type SaveStatus =
  'loading' | 'blank' | 'unsaved' | 'saving' | 'saved' | 'failed' | 'conflict' | 'deleting';
export interface Entry extends Payload {
  id: string;
  revision: number;
}
export interface EntryState extends Entry {
  savedTitle: string;
  savedBody: string;
  savedMood?: Mood;
  savedTags?: string[];
  localDraftReady?: boolean;
  savedTrashed: boolean;
  savedTrashedAt?: string | null;
  loaded: boolean;
  status: SaveStatus;
  error: string;
  conflict?: Entry | null;
  deleteRequested: boolean;
}
interface Attempt {
  write: OpaqueWrite;
  payload: Payload;
}
interface Draft {
  vault_epoch?: string;
  state: EntryState;
  attempt?: Attempt;
}
function empty(date: string): EntryState {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    date,
    title: '',
    body: '',
    mood: '',
    tags: [],
    created_at: now,
    updated_at: now,
    trashed: false,
    trashed_at: null,
    revision: 0,
    savedTitle: '',
    savedBody: '',
    savedTrashed: false,
    loaded: false,
    status: 'blank',
    error: '',
    deleteRequested: false,
  };
}
const dirty = (s: EntryState) =>
  s.title !== s.savedTitle ||
  s.body !== s.savedBody ||
  (s.mood ?? '') !== (s.savedMood ?? '') ||
  JSON.stringify(s.tags ?? []) !== JSON.stringify(s.savedTags ?? []) ||
  s.trashed !== s.savedTrashed ||
  (s.trashed_at ?? null) !== (s.savedTrashedAt ?? null);
const payload = (s: EntryState): Payload => ({
  date: s.date,
  title: s.title,
  body: s.body,
  ...(s.mood === undefined ? {} : { mood: s.mood }),
  ...(s.tags === undefined ? {} : { tags: s.tags }),
  created_at: s.created_at,
  updated_at: s.updated_at,
  trashed: s.trashed,
  trashed_at: s.trashed_at ?? null,
});
@Injectable({ providedIn: 'root' })
export class DiaryService {
  readonly vault = inject(VaultService);
  private readonly auth = inject(AuthService);
  readonly connectionLost = signal(false);
  readonly internetOnline = signal(navigator.onLine);
  readonly trash = signal(new Map<string, EntryState>());
  private purges = new Map<
    string,
    { vault_epoch: string; expected_revision: number; operation_id: string }
  >();
  readonly states = signal(new Map<string, EntryState>());
  readonly dates = computed(
    () =>
      new Set(
        [...this.states().values()]
          .filter(
            (s) => s.revision > 0 && !s.savedTrashed && (s.savedTitle.trim() || s.savedBody.trim()),
          )
          .map((s) => s.date),
      ),
  );
  readonly indexError = signal('');
  readonly drafts = new DraftStore();
  private attempts = new Map<string, Attempt>();
  private queues = new Map<string, Promise<void>>();
  private flights = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private retries = new Map<string, number>();
  private paused = true;
  constructor() {
    this.vault.onOpen = () => this.initialize();
    this.vault.onLock = () => this.flushAndClear();
    this.vault.onFailedOpen = () => this.clear();
    const online = () => {
      this.internetOnline.set(navigator.onLine);
      void this.resumePending();
    };
    const offline = () => this.internetOnline.set(navigator.onLine);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    const reconnect = setInterval(() => {
      if (this.connectionLost()) void this.resumePending();
    }, 10000);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if ([...this.states().values()].some((s) => dirty(s) || this.attempts.has(s.date))) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(reconnect);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('beforeunload', beforeUnload);
    });
  }
  private resuming = false;
  async resumePending() {
    if (this.paused || this.vault.busy() || this.resuming) return;
    this.resuming = true;
    try {
      const health = await this.auth.request<{ database: string }>(
        '/api/health',
        'GET',
        undefined,
        3000,
      );
      if (health.database !== 'ready') return;
      this.connectionLost.set(false);
      for (const state of this.states().values()) {
        if (state.loaded && state.localDraftReady && state.status === 'failed')
          await this.retry(state.date);
      }
    } catch {
      /* Keep durable drafts; a later heartbeat retries connectivity. */
    } finally {
      this.resuming = false;
    }
  }
  state(date: string): EntryState {
    return this.states().get(date) ?? empty(date);
  }
  private set(date: string, change: Partial<EntryState>) {
    const states = new Map(this.states());
    states.set(date, { ...this.state(date), ...change });
    this.states.set(states);
  }
  async initialize() {
    const states = new Map<string, EntryState>(),
      trash = new Map<string, EntryState>(),
      seen = new Set<string>();
    let cursor = '',
      count = 0;
    do {
      const page = await this.auth.request<{ records: OpaqueRecord[]; next_cursor: string }>(
        '/api/entries' + (cursor ? `?cursor=${cursor}` : ''),
      );
      if (
        !Array.isArray(page.records) ||
        page.records.length > 100 ||
        (page.next_cursor && (!uuid.test(page.next_cursor) || page.next_cursor <= cursor))
      )
        throw new Error('Invalid encrypted index.');
      for (const record of page.records) {
        if (++count > 100000) throw new Error('Vault is too large to open in this browser.');
        const entry = await this.decrypt(record);
        if (seen.has(entry.id)) throw new Error('Duplicate record ID. Data preserved.');
        seen.add(entry.id);
        if (!entry.trashed && states.has(entry.date))
          throw new Error('Duplicate diary date. Vault was not opened; data was preserved.');
        const loaded: EntryState = {
          ...entry,
          savedTitle: entry.title,
          savedBody: entry.body,
          savedMood: entry.mood,
          savedTags: entry.tags,
          savedTrashed: entry.trashed,
          savedTrashedAt: entry.trashed_at ?? null,
          loaded: true,
          status: entry.trashed ? 'blank' : 'saved',
          error: '',
          deleteRequested: false,
        };
        if (entry.trashed) trash.set(entry.id, loaded);
        else states.set(entry.date, loaded);
      }
      cursor = page.next_cursor;
    } while (cursor);
    const attempts = new Map<string, Attempt>();
    for (const stored of await this.drafts.list(this.vault.id)) {
      if (
        !uuid.test(stored.record_id) ||
        stored.format_version !== 1 ||
        stored.key !== `${this.vault.id}/${stored.record_id}`
      )
        throw new Error('Invalid encrypted draft metadata.');
      const draft = await decryptJSON<Draft>(
        this.vault.key,
        stored,
        context('draft', this.vault.id, stored.record_id),
      );
      const state = draft.state;
      validatePayload(state);
      if (
        state.id !== stored.record_id ||
        !Number.isSafeInteger(state.revision) ||
        state.revision < 0 ||
        typeof state.savedTitle !== 'string' ||
        typeof state.savedBody !== 'string' ||
        typeof state.savedTrashed !== 'boolean'
      )
        throw new Error('Invalid encrypted draft.');
      const existing = states.get(state.date);
      if (existing && existing.id !== state.id)
        throw new Error('Conflicting record for recovered draft. Data preserved.');
      if (state.conflict) validatePayload(state.conflict);
      const staleEpoch =
        draft.vault_epoch !== undefined && draft.vault_epoch !== this.vault.vault!.vault_epoch;
      if (staleEpoch) {
        state.status = 'conflict';
        state.conflict = existing ?? trash.get(state.id) ?? null;
      }
      if (draft.attempt) {
        validatePayload(draft.attempt.payload);
        if (
          draft.attempt.payload.date !== state.date ||
          !uuid.test(draft.attempt.write.operation_id) ||
          draft.attempt.write.crypto_version !== 1 ||
          !Number.isSafeInteger(draft.attempt.write.expected_revision) ||
          draft.attempt.write.expected_revision < 0
        )
          throw new Error('Invalid pending save.');
        // Verify persisted pending ciphertext before retrying it to the server.
        const decoded = await decryptJSON<Payload>(
          this.vault.key,
          draft.attempt.write,
          context('entry', this.vault.id, state.id),
        );
        if (JSON.stringify(decoded) !== JSON.stringify(draft.attempt.payload))
          throw new Error('Pending save payload mismatch.');
        draft.attempt.write.vault_epoch ??= this.vault.vault!.vault_epoch;
        if (staleEpoch || draft.attempt.write.vault_epoch !== this.vault.vault!.vault_epoch) {
          state.status = 'conflict';
          state.conflict = existing ?? trash.get(state.id) ?? null;
        } else attempts.set(state.date, draft.attempt);
      }
      trash.delete(state.id);
      states.set(state.date, {
        ...state,
        loaded: true,
        status: state.status === 'conflict' ? 'conflict' : 'unsaved',
        error:
          state.status === 'conflict'
            ? 'Recovered encrypted draft. Compare it before resolving the conflict.'
            : 'Recovered encrypted draft. Saving automatically…',
      });
    }
    this.states.set(states);
    this.trash.set(trash);
    this.attempts = attempts;
    this.paused = false;
    this.connectionLost.set(false);
    this.indexError.set('');
    for (const state of states.values()) {
      if (state.status === 'unsaved') this.schedule(state.date, 1000);
    }
  }
  private async decrypt(record: OpaqueRecord): Promise<Entry> {
    if (
      record.vault_id !== this.vault.id ||
      !uuid.test(record.id) ||
      record.crypto_version !== 1 ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1
    )
      throw new Error('Invalid encrypted record metadata.');
    try {
      return {
        ...validatePayload(
          await decryptJSON<Payload>(
            this.vault.key,
            record,
            context('entry', this.vault.id, record.id),
          ),
        ),
        id: record.id,
        revision: record.revision,
      };
    } catch {
      throw new Error(
        'Encrypted entry failed integrity verification. Data preserved; editing is blocked.',
      );
    }
  }
  async load(date: string) {
    if (!this.paused && !this.states().has(date)) this.set(date, { loaded: true });
  }
  async loadDates() {
    /* Index is decrypted atomically at unlock; it is never sent as dates. */
  }
  edit(
    date: string,
    title: string,
    body: string,
    mood: Mood = this.state(date).mood ?? '',
    tags: string[] = this.state(date).tags ?? [],
  ) {
    if (this.paused || this.vault.busy()) return;
    const current = this.state(date);
    if (!current.loaded || current.deleteRequested) return;
    this.set(date, {
      title,
      body,
      mood,
      tags: [...tags],
      localDraftReady: false,
      trashed: false,
      trashed_at: null,
      updated_at: new Date().toISOString(),
      status: current.status === 'conflict' ? 'conflict' : 'unsaved',
      error: current.status === 'conflict' ? current.error : '',
    });
    void this.stash(date).catch((e) => this.storageFailure(date, e));
    if (current.status !== 'conflict') this.schedule(date, 1000);
  }
  private storageFailure(date: string, e: unknown) {
    this.set(date, {
      status: 'failed',
      localDraftReady: false,
      error: e instanceof Error ? e.message : 'Encrypted draft storage failed. Keep this tab open.',
    });
  }
  private schedule(date: string, delay: number) {
    clearTimeout(this.timers.get(date));
    this.timers.set(
      date,
      setTimeout(() => {
        this.timers.delete(date);
        void this.save(date);
      }, delay),
    );
  }
  private stash(date: string): Promise<void> {
    const queued = (this.queues.get(date) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const state = this.states().get(date);
        if (!state) return;
        const attempt = this.attempts.get(date);
        if (!dirty(state) && !attempt && state.status !== 'conflict') {
          await this.drafts.remove(this.vault.id, state.id);
          this.set(date, { localDraftReady: false });
          return;
        }
        const sealed = await encryptJSON(
          this.vault.key,
          { state, attempt, vault_epoch: this.vault.vault!.vault_epoch } satisfies Draft,
          context('draft', this.vault.id, state.id),
        );
        await this.drafts.put({
          key: `${this.vault.id}/${state.id}`,
          vault_id: this.vault.id,
          record_id: state.id,
          format_version: 1,
          ...sealed,
        });
        if (JSON.stringify(payload(this.state(date))) === JSON.stringify(payload(state)))
          this.set(date, { localDraftReady: true });
      });
    this.queues.set(date, queued);
    return queued;
  }
  save(date: string): Promise<void> {
    if (this.paused) return Promise.resolve();
    const existing = this.flights.get(date);
    if (existing) return existing;
    clearTimeout(this.timers.get(date));
    this.timers.delete(date);
    const flight = this.persist(date).finally(() => this.flights.delete(date));
    this.flights.set(date, flight);
    return flight;
  }
  private async persist(date: string) {
    try {
      while (!this.paused) {
        const state = this.state(date);
        if (
          !state.loaded ||
          state.status === 'conflict' ||
          (!dirty(state) && !this.attempts.has(date))
        )
          return;
        let attempt = this.attempts.get(date);
        if (!attempt) {
          const data = validatePayload(payload(state));
          if (!data.trashed && !data.title.trim() && !data.body.trim()) {
            this.set(date, {
              status: state.revision ? 'unsaved' : 'blank',
              error: state.revision ? 'Use Delete entry to remove saved text.' : '',
            });
            await this.stash(date);
            return;
          }
          attempt = {
            payload: data,
            write: {
              crypto_version: 1,
              vault_epoch: this.vault.vault!.vault_epoch,
              expected_revision: state.revision,
              operation_id: crypto.randomUUID(),
              ...(await encryptJSON(
                this.vault.key,
                data,
                context('entry', this.vault.id, state.id),
              )),
            },
          };
          this.attempts.set(date, attempt);
        }
        this.set(date, { status: state.deleteRequested ? 'deleting' : 'saving', error: '' });
        await this.stash(date); // Durable encrypted pending write precedes network submission.
        const record = await this.auth.request<OpaqueRecord>(
          `/api/entries/${state.id}`,
          'PUT',
          attempt.write,
        );
        this.connectionLost.set(false);
        const acknowledged = await this.decrypt(record);
        if (
          record.id !== state.id ||
          record.revision !== attempt.write.expected_revision + 1 ||
          JSON.stringify(payload({ ...state, ...acknowledged })) !== JSON.stringify(attempt.payload)
        )
          throw new Error('Save acknowledgement mismatch. Draft preserved.');
        if (!acknowledged.trashed) {
          const trash = new Map(this.trash());
          trash.delete(acknowledged.id);
          this.trash.set(trash);
        }
        this.attempts.delete(date);
        this.retries.delete(date);
        const latest = this.state(date);
        this.set(date, {
          revision: record.revision,
          savedTitle: acknowledged.title,
          savedBody: acknowledged.body,
          savedMood: acknowledged.mood,
          savedTags: acknowledged.tags,
          savedTrashed: acknowledged.trashed,
          savedTrashedAt: acknowledged.trashed_at ?? null,
          deleteRequested: latest.trashed && !acknowledged.trashed,
        });
        if (!dirty(this.state(date)))
          this.set(date, {
            status: acknowledged.trashed ? 'blank' : 'saved',
            error: '',
            deleteRequested: false,
          });
        await this.stash(date); // Removes only a draft matching the acknowledged current text.
        if (acknowledged.trashed && !dirty(this.state(date))) {
          const trash = new Map(this.trash());
          trash.set(state.id, this.state(date));
          this.trash.set(trash);
          const states = new Map(this.states());
          states.delete(date);
          this.states.set(states);
          return;
        }
      }
    } catch (e) {
      if (e instanceof APIError && e.status === 409 && e.data?.error === 'vault_changed') {
        this.set(date, {
          status: 'failed',
          error:
            'Vault was replaced. Lock and unlock to compare your recovered draft with the restored diary.',
        });
      } else if (e instanceof APIError && e.status === 409) {
        try {
          const current = e.data?.current ? await this.decrypt(e.data.current) : null;
          if (current && current.id !== this.state(date).id)
            throw new Error('Conflict record identity mismatch. Draft preserved.');
          this.attempts.delete(date);
          this.set(date, {
            status: 'conflict',
            conflict: current,
            error: 'Saved version changed. Compare it with your draft before choosing.',
          });
          await this.stash(date);
        } catch (integrity) {
          this.set(date, {
            status: 'failed',
            error: integrity instanceof Error ? integrity.message : 'Conflict verification failed.',
          });
        }
      } else {
        if (
          (e instanceof APIError && e.status >= 500) ||
          e instanceof TypeError ||
          (e instanceof DOMException &&
            ['TimeoutError', 'AbortError', 'NetworkError'].includes(e.name))
        )
          this.connectionLost.set(true);
        this.set(date, {
          status: 'failed',
          error: e instanceof Error ? e.message : 'Save failed. Draft preserved.',
        });
        const retries = this.retries.get(date) ?? 0;
        // Validation, storage and integrity errors require an explicit retry.
        if (
          !this.paused &&
          this.auth.authenticated() &&
          retries < 3 &&
          ((e instanceof APIError && e.status >= 500) ||
            e instanceof DOMException ||
            e instanceof TypeError)
        ) {
          this.retries.set(date, retries + 1);
          this.schedule(date, 1000 * 2 ** retries);
        }
      }
    }
  }
  async retry(date: string) {
    this.retries.delete(date);
    await this.save(date);
  }
  async deleteEntry(date: string) {
    if (this.paused) return;
    // Resolve uncertain creation first so a late successful save cannot resurrect it.
    if (this.attempts.has(date) || this.flights.has(date)) {
      await this.save(date);
      if (this.attempts.has(date) || this.state(date).status === 'conflict') return;
    }
    const state = this.state(date);
    if (state.revision === 0) {
      this.set(date, {
        title: '',
        body: '',
        mood: '',
        tags: [],
        status: 'blank',
        error: '',
        trashed: false,
      });
      await this.stash(date);
      return;
    }
    this.set(date, {
      trashed: true,
      trashed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleteRequested: true,
      status: 'unsaved',
      error: '',
    });
    await this.stash(date);
    await this.save(date);
  }
  async useSavedVersion(date: string) {
    const state = this.state(date);
    if (state.status !== 'conflict') return;
    const current = state.conflict ?? { ...empty(date), loaded: true };
    this.attempts.delete(date);
    if (current.trashed) {
      const trash = new Map(this.trash());
      trash.set(current.id, {
        ...state,
        ...current,
        savedTitle: current.title,
        savedBody: current.body,
        savedMood: current.mood,
        savedTags: current.tags,
        savedTrashed: true,
        savedTrashedAt: current.trashed_at ?? null,
        status: 'blank',
        error: '',
        conflict: undefined,
        deleteRequested: false,
      });
      this.trash.set(trash);
      const states = new Map(this.states());
      states.delete(date);
      this.states.set(states);
      await this.drafts.remove(this.vault.id, state.id);
      return;
    }
    if (current.date !== date)
      throw new Error('The saved entry moved to another date. Lock and unlock to reload it.');
    this.set(date, {
      ...current,
      savedTitle: current.title,
      savedBody: current.body,
      savedMood: current.mood,
      savedTags: current.tags,
      savedTrashed: current.trashed,
      savedTrashedAt: current.trashed_at ?? null,
      conflict: undefined,
      deleteRequested: false,
      status: current.revision && !current.trashed ? 'saved' : 'blank',
      error: '',
    });
    await this.stash(date);
    if (current.id !== state.id) await this.drafts.remove(this.vault.id, state.id);
  }
  async overwriteWithDraft(date: string) {
    const state = this.state(date);
    if (state.status !== 'conflict') return;
    this.attempts.delete(date);
    this.set(date, {
      ...(state.conflict ? {} : { id: crypto.randomUUID() }),
      revision: state.conflict?.revision ?? 0,
      savedTitle: state.conflict?.title ?? '',
      savedBody: state.conflict?.body ?? '',
      savedMood: state.conflict?.mood ?? '',
      savedTags: state.conflict?.tags ?? [],
      savedTrashed: state.conflict?.trashed ?? false,
      savedTrashedAt: state.conflict?.trashed_at ?? null,
      conflict: undefined,
      status: 'unsaved',
      error: '',
    });
    await this.stash(date);
    if (this.state(date).id !== state.id) await this.drafts.remove(this.vault.id, state.id);
    await this.save(date);
  }
  async saveAll() {
    await Promise.all([...this.flights.values()]);
    for (const date of [...this.states().keys()]) await this.save(date);
    if (
      [...this.states().values()].some(
        (s) => dirty(s) || s.status === 'conflict' || this.attempts.has(s.date),
      )
    )
      throw new Error(
        'Save or resolve all drafts before exporting a database backup or replacing this diary. You can export unsaved text separately.',
      );
  }
  async currentRecords(): Promise<OpaqueRecord[]> {
    const records: OpaqueRecord[] = [];
    const all = new Map(
      [...this.trash().values(), ...this.states().values()].map((s) => [s.id, s]),
    );
    for (const state of all.values()) {
      if (!state.trashed && !state.title.trim() && !state.body.trim() && state.revision === 0)
        continue;
      const sealed = await encryptJSON(
        this.vault.key,
        validatePayload(payload(state)),
        context('entry', this.vault.id, state.id),
      );
      records.push({
        id: state.id,
        vault_id: this.vault.id,
        crypto_version: 1,
        revision: Math.max(1, state.revision),
        ...sealed,
      });
    }
    return records;
  }
  async restoreTrash(id: string, date: string) {
    if (this.paused || !validCivilDate(date)) throw new Error('Unlock and choose a valid date.');
    const source = this.trash().get(id);
    if (!source) throw new Error('Trash entry is no longer available.');
    await Promise.all(this.flights.values());
    const current = this.states().get(date);
    if (current && (current.revision > 0 || current.title.trim() || current.body.trim()))
      throw new Error(
        'This date already has an entry or draft. Compare it and choose another date.',
      );
    this.set(date, {
      ...source,
      date,
      trashed: false,
      trashed_at: null,
      updated_at: new Date().toISOString(),
      status: 'unsaved',
      deleteRequested: false,
      error: '',
    });
    await this.stash(date);
    const trash = new Map(this.trash());
    trash.delete(id);
    this.trash.set(trash);
    await this.save(date);
    if (this.state(date).status !== 'saved')
      throw new Error(
        'Trash restore is pending. Your text is in the editor; retry or resolve the conflict there.',
      );
  }
  async purgeTrash(id: string) {
    if (this.paused) throw new Error('Unlock first.');
    const entry = this.trash().get(id);
    if (!entry) throw new Error('Trash entry unavailable.');
    let request = this.purges.get(id);
    if (!request) {
      request = {
        vault_epoch: this.vault.vault!.vault_epoch,
        expected_revision: entry.revision,
        operation_id: crypto.randomUUID(),
      };
      this.purges.set(id, request);
    }
    await this.auth.request(`/api/entries/${id}`, 'DELETE', request);
    await this.drafts.remove(this.vault.id, id);
    this.purges.delete(id);
    const trash = new Map(this.trash());
    trash.delete(id);
    this.trash.set(trash);
  }
  async flushAndClear() {
    this.paused = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.flights.values());
    try {
      await Promise.all([...this.states().keys()].map((date) => this.stash(date)));
    } catch (e) {
      this.paused = false;
      throw e;
    }
    this.clear();
  }
  clear() {
    this.paused = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.states.set(new Map());
    this.trash.set(new Map());
    this.purges.clear();
    this.attempts.clear();
    this.queues.clear();
    this.retries.clear();
    this.indexError.set('');
  }
}
