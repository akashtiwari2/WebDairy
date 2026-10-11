import {
  Envelope,
  Vault,
  OpaqueRecord,
  Payload,
  aesKey,
  random,
  base64,
  unbase64,
  validateEnvelope,
  validatePayload,
  uuid,
  context,
  encryptJSON,
  decryptJSON,
  unwrapPassword,
  unwrapRecovery,
} from './vault-crypto';
import { Preferences, validPreferences } from './preferences.service';
export const MAX_SNAPSHOT = 32 * 1024 * 1024,
  MAX_ARCHIVE = 48 * 1024 * 1024,
  MAX_RECORDS = 10000;
export interface Snapshot {
  vault: Vault;
  records: OpaqueRecord[];
  snapshot_at: string;
}
export interface Manifest extends Snapshot {
  format: 'webdiary-snapshot';
  version: 1;
  source: 'database' | 'browser-draft';
  preferences: Preferences;
}
export interface Archive {
  format: 'webdiary-backup';
  version: 1;
  vault_id: string;
  envelope: Envelope;
  salt: string;
  nonce: string;
  ciphertext: string;
}
export interface VerifiedBackup {
  raw: Uint8Array<ArrayBuffer>;
  manifest: Manifest;
  active: number;
  trashed: number;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}
export async function backupKey(
  raw: Uint8Array<ArrayBuffer>,
  salt: string,
  vault: string,
): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: unbase64(salt, 16),
      info: new TextEncoder().encode(`webdiary|backup-key|v1|${vault}`),
    },
    source,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function backupContext(envelope: Envelope, salt: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(envelope)),
  );
  return `webdiary|backup|v1|${envelope.vault_id}|${salt}|${base64(new Uint8Array(digest))}`;
}
export async function validateManifest(
  manifest: Manifest,
  key: CryptoKey,
): Promise<{ active: number; trashed: number }> {
  if (
    !manifest ||
    manifest.format !== 'webdiary-snapshot' ||
    manifest.version !== 1 ||
    !['database', 'browser-draft'].includes(manifest.source) ||
    !manifest.vault ||
    !Number.isSafeInteger(manifest.vault.revision) ||
    manifest.vault.revision < 1 ||
    !uuid.test(manifest.vault.vault_epoch) ||
    !Number.isSafeInteger(manifest.vault.generation) ||
    manifest.vault.generation < 0 ||
    !Number.isFinite(Date.parse(manifest.snapshot_at)) ||
    !Array.isArray(manifest.records) ||
    manifest.records.length > MAX_RECORDS ||
    !validPreferences(manifest.preferences)
  )
    throw new Error('Invalid backup manifest.');
  validateEnvelope(manifest.vault.envelope);
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > MAX_SNAPSHOT)
    throw new Error('Backup exceeds the 32 MiB snapshot limit.');
  const ids = new Set<string>(),
    dates = new Set<string>();
  let active = 0,
    trashed = 0;
  for (const record of manifest.records) {
    if (
      !record ||
      !uuid.test(record.id) ||
      ids.has(record.id) ||
      record.vault_id !== manifest.vault.envelope.vault_id ||
      record.crypto_version !== 1 ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      record.revision > 9007199254740990
    )
      throw new Error('Invalid or duplicate backup record.');
    ids.add(record.id);
    unbase64(record.nonce, 12);
    const ciphertext = unbase64(record.ciphertext);
    if (ciphertext.length < 16 || ciphertext.length > 1500000)
      throw new Error('Invalid backup ciphertext length.');
    const payload = validatePayload(
      await decryptJSON<Payload>(key, record, context('entry', record.vault_id, record.id)),
    );
    if (payload.trashed) trashed++;
    else {
      if (dates.has(payload.date)) throw new Error('Backup contains duplicate active dates.');
      dates.add(payload.date);
      active++;
    }
  }
  return { active, trashed };
}
export async function createArchive(
  snapshot: Snapshot,
  preferences: Preferences,
  entryKey: CryptoKey,
  derive: (salt: string) => Promise<CryptoKey>,
  source: Manifest['source'] = 'database',
): Promise<Archive> {
  const manifest: Manifest = {
    ...snapshot,
    format: 'webdiary-snapshot',
    version: 1,
    source,
    preferences,
  };
  await validateManifest(manifest, entryKey);
  const salt = base64(random(16));
  const envelope = snapshot.vault.envelope;
  const sealed = await encryptJSON(
    await derive(salt),
    manifest,
    await backupContext(envelope, salt),
  );
  const archive: Archive = {
    format: 'webdiary-backup',
    version: 1,
    vault_id: envelope.vault_id,
    envelope,
    salt,
    ...sealed,
  };
  if (new TextEncoder().encode(JSON.stringify(archive)).length > MAX_ARCHIVE)
    throw new Error('Encrypted file exceeds the 48 MiB limit.');
  return archive;
}
export function parseArchive(text: string): Archive {
  if (new TextEncoder().encode(text).length > MAX_ARCHIVE)
    throw new Error('Backup file exceeds 48 MiB.');
  let a: Archive;
  try {
    a = JSON.parse(text);
  } catch {
    throw new Error('Choose a valid encrypted WebDairy backup file.');
  }
  if (!a || a.format !== 'webdiary-backup') throw new Error('Not a WebDairy backup.');
  if (a.version !== 1)
    throw new Error('Unsupported backup version. Upgrade WebDairy before restoring.');
  if (
    Object.keys(a).some(
      (k) =>
        !['format', 'version', 'vault_id', 'envelope', 'salt', 'nonce', 'ciphertext'].includes(k),
    ) ||
    a.vault_id !== a.envelope?.vault_id
  )
    throw new Error('Invalid backup header.');
  validateEnvelope(a.envelope);
  unbase64(a.salt, 16);
  unbase64(a.nonce, 12);
  if (
    typeof a.ciphertext !== 'string' ||
    a.ciphertext.length < 24 ||
    a.ciphertext.length > MAX_ARCHIVE
  )
    throw new Error('Invalid backup size.');
  return a;
}
export async function verifyArchive(
  archive: Archive,
  secret: string,
  mode: 'passphrase' | 'recovery',
): Promise<VerifiedBackup> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    raw =
      mode === 'passphrase'
        ? await unwrapPassword(archive.envelope, secret)
        : await unwrapRecovery(archive.envelope, secret);
    const manifest = await decryptJSON<Manifest>(
      await backupKey(raw, archive.salt, archive.vault_id),
      archive,
      await backupContext(archive.envelope, archive.salt),
      MAX_ARCHIVE,
    );
    if (canonical(manifest.vault?.envelope) !== canonical(archive.envelope))
      throw new Error('Envelope mismatch.');
    const counts = await validateManifest(manifest, await aesKey(raw));
    return { raw, manifest, ...counts };
  } catch (e) {
    raw?.fill(0);
    throw new Error('Could not verify backup. Key, format or encrypted contents are invalid.');
  }
}
