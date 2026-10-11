import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { webcrypto } from 'node:crypto';
import { todayInKolkata } from './app';
import { DiaryService, validCivilDate } from './diary.service';
import { AuthService } from './auth.service';
import { VaultService } from './vault.service';
import { StoredDraft } from './drafts';
import { aesKey, encryptJSON, context, OpaqueRecord, OpaqueWrite, Payload } from './vault-crypto';
const date = '2030-10-20',
  vaultID = '12345678-1234-4234-8234-123456789012';
const response = (status: number, data: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;
describe('Encrypted autosave and durable drafts', () => {
  let service: DiaryService,
    database: Map<string, OpaqueRecord>,
    operations: Map<string, string>,
    local: Map<string, StoredDraft>,
    key: CryptoKey;
  let handle: (path: string, init?: RequestInit) => Promise<Response>,
    api: ReturnType<typeof vi.fn<typeof handle>>;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', webcrypto);
    key = await aesKey(new Uint8Array(32));
    database = new Map();
    operations = new Map();
    local = new Map();
    handle = async (path, init) => {
      if (path === '/api/entries')
        return response(200, { records: [...database.values()], next_cursor: '' });
      const id = path.split('/').at(-1)!,
        write: OpaqueWrite = JSON.parse(init!.body as string),
        old = database.get(id),
        encoded = JSON.stringify(write);
      if (
        operations.get(write.operation_id) === encoded &&
        old?.revision === write.expected_revision + 1
      )
        return response(200, old);
      if ((old?.revision ?? 0) !== write.expected_revision)
        return response(409, { current: old ?? null });
      const record: OpaqueRecord = {
        id,
        vault_id: vaultID,
        crypto_version: 1,
        nonce: write.nonce,
        ciphertext: write.ciphertext,
        revision: write.expected_revision + 1,
      };
      database.set(id, record);
      operations.set(write.operation_id, encoded);
      return response(200, record);
    };
    api = vi.fn((path, init) => handle(path, init));
    vi.stubGlobal('fetch', api);
    TestBed.configureTestingModule({
      providers: [
        DiaryService,
        AuthService,
        { provide: VaultService, useValue: { key, id: vaultID, busy: signal(false) } },
      ],
    });
    TestBed.inject(AuthService).authenticated.set(true);
    service = TestBed.inject(DiaryService);
    vi.spyOn(service.drafts, 'list').mockImplementation(async () => [...local.values()]);
    vi.spyOn(service.drafts, 'put').mockImplementation(async (draft) => {
      local.set(draft.key, draft);
      return draft.key;
    });
    vi.spyOn(service.drafts, 'remove').mockImplementation(async (vault, id) => {
      local.delete(`${vault}/${id}`);
    });
    await service.initialize();
    await service.load(date);
  });
  afterEach(async () => {
    service.clear();
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const writes = () => api.mock.calls.filter(([, init]) => init?.method === 'PUT');
  async function record(id: string, body: string, revision: number): Promise<OpaqueRecord> {
    const payload: Payload = {
      date,
      title: 'Server title',
      body,
      trashed: false,
      created_at: '2026-10-11T00:00:00.000Z',
      updated_at: '2026-10-11T00:00:00.000Z',
    };
    return {
      id,
      vault_id: vaultID,
      crypto_version: 1,
      revision,
      ...(await encryptJSON(key, payload, context('entry', vaultID, id))),
    };
  }
  it('autosaves after one second and sends only UUIDs and ciphertext', async () => {
    service.edit(date, 'SYNTHETIC TITLE', 'SYNTHETIC BODY');
    await vi.advanceTimersByTimeAsync(999);
    expect(writes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await service.save(date);
    expect(service.state(date).status).toBe('saved');
    expect(database.size).toBe(1);
    expect(local.size).toBe(0);
    expect(JSON.stringify(writes())).not.toContain(date);
    expect(JSON.stringify(writes())).not.toContain('SYNTHETIC');
  });
  it('does not create untouched empty entries', async () => {
    await service.save(date);
    expect(writes()).toHaveLength(0);
  });
  it('persists encrypted draft before sending a write and clears it after acknowledgement', async () => {
    handle = async (path, init) => {
      expect(local.size).toBe(1);
      expect(JSON.stringify([...local.values()])).not.toContain('SYNTHETIC');
      const w = JSON.parse(init!.body as string);
      const r = { id: path.split('/').at(-1)!, vault_id: vaultID, revision: 1, ...w };
      database.set(r.id, r);
      return response(200, r);
    };
    service.edit(date, 'SYNTHETIC TITLE', 'SYNTHETIC BODY');
    await service.save(date);
    expect(local.size).toBe(0);
  });
  it('blocks network writes when encrypted local storage fails', async () => {
    vi.mocked(service.drafts.put).mockRejectedValue(new Error('storage full'));
    service.edit(date, 'Title', 'Body');
    await service.save(date);
    expect(writes()).toHaveLength(0);
    expect(service.state(date).body).toBe('Body');
    expect(service.state(date).error).toContain('storage full');
  });
  it('preserves latest text typed while an earlier save is in flight', async () => {
    let release!: () => void, started!: () => void;
    const start = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r)),
      original = handle;
    let first = true;
    handle = async (path, init) => {
      if (first) {
        first = false;
        started();
        await gate;
      }
      return original(path, init);
    };
    service.edit(date, 'Title', 'First');
    const flight = service.save(date);
    await start;
    service.edit(date, 'Title', 'Second');
    release();
    await flight;
    expect(writes()).toHaveLength(2);
    expect(service.state(date).savedBody).toBe('Second');
    expect(service.state(date).revision).toBe(2);
    expect(local.size).toBe(0);
  });
  it('retries identical ciphertext and operation after a lost successful response', async () => {
    const original = handle;
    let first = true;
    handle = async (path, init) => {
      const result = await original(path, init);
      if (first) {
        first = false;
        throw new TypeError('lost response');
      }
      return result;
    };
    service.edit(date, 'Title', 'Body');
    await service.save(date);
    expect(service.state(date).status).toBe('failed');
    expect(local.size).toBe(1);
    await service.retry(date);
    expect(writes()[0][1]!.body).toBe(writes()[1][1]!.body);
    expect(service.state(date).revision).toBe(1);
    expect(local.size).toBe(0);
  });
  it('keeps conflict draft and decrypts the compared version', async () => {
    const id = service.state(date).id;
    database.set(id, await record(id, 'Other writer', 1));
    service.edit(date, 'Mine', 'My draft');
    await service.save(date);
    expect(service.state(date).status).toBe('conflict');
    expect(service.state(date).body).toBe('My draft');
    expect(service.state(date).conflict?.body).toBe('Other writer');
    expect(local.size).toBe(1);
    await service.overwriteWithDraft(date);
    expect(service.state(date).revision).toBe(2);
    expect(service.state(date).savedBody).toBe('My draft');
  });
  it('requires an explicit choice to use the saved conflict version', async () => {
    const id = service.state(date).id;
    database.set(id, await record(id, 'Other writer', 1));
    service.edit(date, 'Mine', 'My draft');
    await service.save(date);
    await service.useSavedVersion(date);
    expect(service.state(date).body).toBe('Other writer');
    expect(local.size).toBe(0);
    expect(writes()).toHaveLength(1);
  });
  it('restores an encrypted pending write after memory was cleared, including lost acknowledgements', async () => {
    const original = handle;
    let first = true;
    handle = async (path, init) => {
      const result = await original(path, init);
      if (first) {
        first = false;
        throw new TypeError('lost response');
      }
      return result;
    };
    service.edit(date, 'Title', 'Recovered text');
    await service.save(date);
    const pending = writes()[0][1]!.body;
    await service.flushAndClear();
    expect(service.states().size).toBe(0);
    await service.initialize();
    expect(service.state(date).body).toBe('Recovered text');
    await service.save(date);
    expect(writes()[1][1]!.body).toBe(pending);
    expect(service.state(date).revision).toBe(1);
  });
  it('flushes latest encrypted draft on lock even when the server is unavailable', async () => {
    handle = async () => response(503, {});
    service.edit(date, 'Title', 'Offline draft');
    await service.save(date);
    await service.flushAndClear();
    expect(service.states().size).toBe(0);
    expect(local.size).toBe(1);
    handle = async () => response(200, { records: [], next_cursor: '' });
    await service.initialize();
    expect(service.state(date).body).toBe('Offline draft');
  });
  it('refuses a successful lock if encrypted draft storage fails', async () => {
    vi.mocked(service.drafts.put).mockRejectedValue(new Error('storage full'));
    service.edit(date, 'Title', 'Keep me');
    await expect(service.flushAndClear()).rejects.toThrow('storage full');
    expect(service.state(date).body).toBe('Keep me');
  });
  it('blocks opening tampered records without exposing a partial index', async () => {
    const id = service.state(date).id,
      r = await record(id, 'Body', 1);
    r.ciphertext = 'AAAA';
    database.set(id, r);
    service.clear();
    await expect(service.initialize()).rejects.toThrow('integrity');
    expect(service.states().size).toBe(0);
  });
  it('moves deletion state inside ciphertext and reuses the record on recreation', async () => {
    service.edit(date, 'Title', 'Body');
    await service.save(date);
    const id = service.state(date).id;
    await service.deleteEntry(date);
    expect(service.state(date).trashed).toBe(true);
    expect(service.dates().has(date)).toBe(false);
    service.edit(date, 'New title', 'New body');
    await service.save(date);
    expect(service.state(date).id).toBe(id);
    expect(service.state(date).revision).toBe(3);
    expect(database.size).toBe(1);
  });
});
describe('Civil dates', () => {
  it('supports leap days and rejects normalization and year zero', () => {
    expect(validCivilDate('2024-02-29')).toBe(true);
    for (const date of ['2023-02-29', '0000-01-01', '2026-13-01', '2026-1-01'])
      expect(validCivilDate(date)).toBe(false);
  });
  it('uses Asia/Kolkata for today independent of machine timezone', () => {
    expect(todayInKolkata(new Date('2026-10-11T19:00:00Z'))).toBe('2026-10-12');
  });
});
