import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { webcrypto } from 'node:crypto';
import { BackupService } from './backup.service';
import { VaultService } from './vault.service';
import { DiaryService } from './diary.service';
import { AuthService } from './auth.service';
import { GoogleService } from './google.service';
import { PreferencesService, defaults } from './preferences.service';
import { LocalBackup } from './backup-store';
import { backupKey, Snapshot } from './backup-format';
import { aesKey, base64, encryptJSON, context, Envelope } from './vault-crypto';

describe('Encrypted Drive job durability', () => {
  let b: BackupService,
    copies: Map<string, LocalBackup>,
    request: Mock<(path: string, ...args: any[]) => Promise<any>>,
    preferences: any,
    vault: any,
    google: any;
  const id = '12345678-1234-4234-8234-123456789012';
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('crypto', webcrypto);
    const raw = new Uint8Array(32),
      key = await aesKey(raw),
      base = (n: number) => base64(new Uint8Array(n));
    const envelope: Envelope = {
      format_version: 1,
      vault_id: id,
      passphrase: {
        kdf: {
          algorithm: 'argon2id',
          version: 19,
          memory_kib: 65536,
          iterations: 3,
          parallelism: 1,
          salt: base(16),
        },
        nonce: base(12),
        ciphertext: base(48),
      },
      recovery: { algorithm: 'HKDF-SHA256', salt: base(16), nonce: base(12), ciphertext: base(48) },
    };
    const recordID = '11111111-1111-4111-8111-111111111111';
    const snapshot: Snapshot = {
      vault: {
        envelope,
        revision: 1,
        generation: 1,
        vault_epoch: '22222222-2222-4222-8222-222222222222',
      },
      snapshot_at: new Date().toISOString(),
      records: [
        {
          id: recordID,
          vault_id: id,
          revision: 1,
          crypto_version: 1,
          ...(await encryptJSON(
            key,
            {
              date: '2026-10-12',
              title: 'SYNTHETIC PRIVATE TITLE',
              body: 'SYNTHETIC PRIVATE BODY',
              mood: 'Calm',
              tags: ['SYNTHETIC TAG'],
              trashed: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            context('entry', id, recordID),
          )),
        },
      ],
    };
    copies = new Map();
    request = vi.fn<(path: string, ...args: any[]) => Promise<any>>(async (path: string) =>
      path === '/api/backup/snapshot'
        ? snapshot
        : path === '/api/backup/history'
          ? { backups: [] }
          : { backup: { id: 'drive_file_1' }, warning: '' },
    );
    preferences = { value: signal({ ...defaults }) };
    vault = {
      state: signal('unlocked'),
      busy: signal(false),
      id,
      key,
      vault: snapshot.vault,
      clearListeners: new Set(),
      backupKey: (salt: string) => backupKey(raw, salt, id),
      perform: async (action: () => Promise<void>) => {
        vault.busy.set(true);
        try {
          await action();
        } catch {
        } finally {
          vault.busy.set(false);
        }
      },
    };
    google = {
      status: signal({ configured: true, linked: true, drive_connected: true }),
      listed: signal(true),
      loading: signal(false),
      files: signal([]),
      refresh: vi.fn(async () => {}),
      list: vi.fn(async () => {}),
      message: (e: any) => e.message,
    };
    TestBed.configureTestingModule({
      providers: [
        BackupService,
        { provide: VaultService, useValue: vault },
        {
          provide: AuthService,
          useValue: {
            authenticated: signal(true),
            initialized: signal(true),
            googleSetupReady: signal(false),
            request,
          },
        },
        {
          provide: DiaryService,
          useValue: {
            states: signal(new Map()),
            trash: signal(new Map()),
            saveAll: vi.fn(async () => {}),
          },
        },
        { provide: GoogleService, useValue: google },
        { provide: PreferencesService, useValue: preferences },
      ],
    });
    b = TestBed.inject(BackupService);
    vi.spyOn(b.store, 'list').mockImplementation(async () => [...copies.values()]);
    vi.spyOn(b.store, 'save').mockImplementation(
      async (archive, source, recordVersions, snapshotAt) => {
        const copy = {
          id: crypto.randomUUID(),
          archive,
          source,
          record_versions: recordVersions,
          snapshot_at: snapshotAt,
          saved_at: new Date().toISOString(),
        };
        copies.set(copy.id, copy);
        return copy;
      },
    );
    vi.spyOn(b.store, 'uploaded').mockImplementation(async (copy, file) => {
      copies.set(copy.id, { ...copy, source: 'drive', cloud_file_id: file });
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('retains the same encrypted archive/operation after failure and marks uploaded only after acknowledgement', async () => {
    const original = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (path: string, ...args: any[]) => {
      if (path === '/api/drive/upload' && fail) throw new TypeError('synthetic connection failure');
      return original(path, ...args);
    });
    await expect(b.uploadDrive()).rejects.toThrow('synthetic connection failure');
    expect(copies.size).toBe(1);
    expect([...copies.values()][0].source).toBe('drive-pending');
    const first = request.mock.calls.find(([path]) => path === '/api/drive/upload')![2];
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC');
    fail = false;
    await b.uploadDrive();
    const attempts = request.mock.calls.filter(([path]) => path === '/api/drive/upload');
    expect(attempts).toHaveLength(2);
    expect(attempts[1][2]).toEqual(attempts[0][2]);
    expect(copies.size).toBe(1);
    expect([...copies.values()][0].cloud_file_id).toBe('drive_file_1');
    expect([...copies.values()][0].source).toBe('drive');
  });
  it('acknowledges a pending manual upload even when Drive already reports a recent snapshot', async () => {
    const original = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (path: string, ...args: any[]) => {
      if (path === '/api/drive/upload' && fail) throw new TypeError('lost upload acknowledgement');
      return original(path, ...args);
    });
    await expect(b.uploadDrive()).rejects.toThrow();
    const pending = [...copies.values()][0];
    google.files.set([
      {
        id: 'drive_file_1',
        createdTime: pending.saved_at,
        appProperties: { vault_id: id, snapshot_at: pending.snapshot_at },
      },
    ]);
    fail = false;
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(60001);
    for (let i = 0; i < 40 && b.driveBusy(); i++) await vi.advanceTimersByTimeAsync(50);
    expect(copies.get(pending.id)?.source).toBe('drive');
    expect(request.mock.calls.filter(([path]) => path === '/api/drive/upload')).toHaveLength(2);
  });
  it('blocks upload if the durable encrypted browser copy cannot be stored', async () => {
    vi.mocked(b.store.save).mockRejectedValue(new Error('synthetic storage full'));
    await expect(b.uploadDrive()).rejects.toThrow('synthetic storage full');
    expect(request.mock.calls.some(([path]) => path === '/api/drive/upload')).toBe(false);
    expect(copies.size).toBe(0);
  });
  it('does not schedule while locked/busy and catches up once unlocked', async () => {
    vault.state.set('locked');
    preferences.value.set({ ...defaults, backup_frequency: 'daily' });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(30000);
    expect(request.mock.calls.some(([path]) => path === '/api/drive/upload')).toBe(false);
    vault.state.set('unlocked');
    vault.busy.set(true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(30000);
    expect(request.mock.calls.some(([path]) => path === '/api/drive/upload')).toBe(false);
    // Native WebCrypto needs the real event loop; fake-clock spin loops can
    // finish before the crypto thread delivers its result under build load.
    vi.useRealTimers();
    vault.busy.set(false);
    TestBed.tick();
    await vi.waitFor(
      () => expect(request.mock.calls.some(([path]) => path === '/api/drive/upload')).toBe(true),
      { timeout: 5000 },
    );
    await vi.waitFor(() => expect(b.driveBusy()).toBe(false), { timeout: 5000 });
  });
});
