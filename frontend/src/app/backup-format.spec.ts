import { webcrypto } from 'node:crypto';
import {
  Archive,
  Snapshot,
  createArchive,
  backupKey,
  parseArchive,
  verifyArchive,
} from './backup-format';
import {
  aesKey,
  random,
  Envelope,
  wrapPassword,
  wrapRecovery,
  encryptJSON,
  decryptJSON,
  context,
  Payload,
  OpaqueRecord,
} from './vault-crypto';
import { defaults, todayInZone, validPreferences } from './preferences.service';

describe('Portable encrypted backups', () => {
  let raw: Uint8Array<ArrayBuffer>,
    key: CryptoKey,
    envelope: Envelope,
    recovery: string,
    snapshot: Snapshot,
    archive: Archive;
  const pass = 'synthetic backup passphrase';
  async function record(
    date: string,
    title: string,
    body: string,
    trashed = false,
  ): Promise<OpaqueRecord> {
    const id = crypto.randomUUID();
    const payload: Payload = {
      date,
      title,
      body,
      trashed,
      trashed_at: trashed ? '2026-10-11T01:00:00Z' : null,
      created_at: '2026-10-11T00:00:00Z',
      updated_at: '2026-10-11T01:00:00Z',
    };
    return {
      id,
      vault_id: envelope.vault_id,
      revision: 4,
      crypto_version: 1,
      ...(await encryptJSON(key, payload, context('entry', envelope.vault_id, id))),
    };
  }
  beforeAll(async () => {
    vi.stubGlobal('crypto', webcrypto);
    raw = random(32);
    key = await aesKey(raw);
    const id = crypto.randomUUID(),
      wrapped = await wrapRecovery(raw, id);
    recovery = wrapped.secret;
    envelope = {
      format_version: 1,
      vault_id: id,
      passphrase: await wrapPassword(raw, pass, id),
      recovery: wrapped.envelope,
    };
    snapshot = {
      vault: { envelope, revision: 2, generation: 7, vault_epoch: crypto.randomUUID() },
      snapshot_at: '2026-10-11T12:00:00Z',
      records: await Promise.all([
        record('2024-02-29', 'SYNTHETIC PAST', 'SYNTHETIC PAST BODY'),
        record('2026-10-11', 'SYNTHETIC TODAY TITLE ONLY', ''),
        record('2099-10-20', 'SYNTHETIC FUTURE', 'SYNTHETIC FUTURE BODY'),
        record('2024-02-29', 'SYNTHETIC TRASH', 'SYNTHETIC TRASH BODY', true),
        record('2024-02-29', 'SYNTHETIC SECOND TRASH', 'Retained', true),
      ]),
    };
    archive = await createArchive(
      snapshot,
      { ...defaults, theme: 'dark', timezone: 'America/New_York' },
      key,
      (salt) => backupKey(raw, salt, id),
    );
  });
  afterAll(() => {
    raw.fill(0);
    vi.unstubAllGlobals();
  });
  it('restores exact dates, text, title-only entries, trash and preferences with either secret', async () => {
    for (const [secret, mode] of [
      [pass, 'passphrase'],
      [recovery, 'recovery'],
    ] as const) {
      const verified = await verifyArchive(parseArchive(JSON.stringify(archive)), secret, mode);
      expect(verified.manifest.records).toEqual(snapshot.records);
      expect(verified.active).toBe(3);
      expect(verified.trashed).toBe(2);
      expect(verified.raw).toEqual(raw);
      expect(verified.manifest.preferences).toEqual({
        ...defaults,
        theme: 'dark',
        timezone: 'America/New_York',
      });
      verified.raw.fill(0);
    }
    const text = JSON.stringify(archive);
    for (const secret of [
      'SYNTHETIC',
      '2024-02-29',
      pass,
      recovery,
      'password_hash',
      'session_token',
      'raw_key',
    ])
      expect(text).not.toContain(secret);
  });
  it('uses fresh outer salts/nonces and rejects wrong keys, header and ciphertext tampering', async () => {
    const second = await createArchive(snapshot, defaults, key, (salt) =>
      backupKey(raw, salt, envelope.vault_id),
    );
    expect(second.salt).not.toBe(archive.salt);
    expect(second.nonce).not.toBe(archive.nonce);
    await expect(
      verifyArchive(archive, 'wrong synthetic passphrase', 'passphrase'),
    ).rejects.toThrow('Could not verify');
    const bad = structuredClone(archive);
    bad.ciphertext = (bad.ciphertext.startsWith('A') ? 'B' : 'A') + bad.ciphertext.slice(1);
    await expect(verifyArchive(bad, recovery, 'recovery')).rejects.toThrow('Could not verify');
    const header = structuredClone(archive);
    header.envelope.passphrase = structuredClone(second.envelope.passphrase);
    header.envelope.passphrase.nonce = archive.nonce;
    await expect(verifyArchive(header, recovery, 'recovery')).rejects.toThrow('Could not verify');
  });
  it('rejects unsupported versions and expensive KDF headers before key derivation', () => {
    expect(() => parseArchive(JSON.stringify({ ...archive, version: 2 }))).toThrow('Unsupported');
    const bad = structuredClone(archive);
    bad.envelope.passphrase.kdf.memory_kib = 999999999 as 65536;
    expect(() => parseArchive(JSON.stringify(bad))).toThrow('KDF');
  });
  it('authenticates every inner entry and rejects duplicate active dates', async () => {
    const tampered = structuredClone(snapshot);
    tampered.records[0].ciphertext = 'AAAAAAAAAAAAAAAAAAAAAA==';
    await expect(
      createArchive(tampered, defaults, key, (salt) => backupKey(raw, salt, envelope.vault_id)),
    ).rejects.toThrow();
    const duplicate = {
      ...snapshot,
      records: [...snapshot.records, await record('2024-02-29', 'Duplicate', 'Body')],
    };
    await expect(
      createArchive(duplicate, defaults, key, (salt) => backupKey(raw, salt, envelope.vault_id)),
    ).rejects.toThrow('duplicate active dates');
  });
  it('restores files larger than an individual entry limit', async () => {
    const large = {
      ...snapshot,
      records: await Promise.all([
        record('2026-01-01', 'Large one', 'x'.repeat(800000)),
        record('2026-01-02', 'Large two', 'y'.repeat(800000)),
      ]),
    };
    const exported = await createArchive(large, defaults, key, (salt) =>
      backupKey(raw, salt, envelope.vault_id),
    );
    expect(exported.ciphertext.length).toBeGreaterThan(2000000);
    const verified = await verifyArchive(
      parseArchive(JSON.stringify(exported)),
      recovery,
      'recovery',
    );
    expect(verified.active).toBe(2);
    const first = await decryptJSON<Payload>(
      await aesKey(verified.raw),
      verified.manifest.records[0],
      context('entry', envelope.vault_id, large.records[0].id),
    );
    expect(first.body.length).toBe(800000);
    verified.raw.fill(0);
  });
});
describe('Timezone preferences', () => {
  it('changes Today at the selected-zone midnight without converting stored civil dates', () => {
    const instant = new Date('2026-10-11T19:00:00Z');
    expect(todayInZone('Asia/Kolkata', instant)).toBe('2026-10-12');
    expect(todayInZone('America/New_York', instant)).toBe('2026-10-11');
    expect(validPreferences({ ...defaults, timezone: 'not/a-zone' })).toBe(false);
    expect(validPreferences({ ...defaults, trash_days: 0 })).toBe(false);
    expect(validPreferences({ ...defaults, theme: 'dark' })).toBe(true);
  });
});
