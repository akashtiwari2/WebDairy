import { argon2id } from 'hash-wasm';

export interface KDF {
  algorithm: 'argon2id';
  version: 19;
  memory_kib: 65536;
  iterations: 3;
  parallelism: 1;
  salt: string;
}
export interface Sealed {
  nonce: string;
  ciphertext: string;
}
export interface Envelope {
  format_version: 1;
  vault_id: string;
  passphrase: Sealed & { kdf: KDF };
  recovery: Sealed & { algorithm: 'HKDF-SHA256'; salt: string };
}
export interface Vault {
  envelope: Envelope;
  revision: number;
  vault_epoch: string;
  generation: number;
}
export interface Payload {
  date: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  trashed: boolean;
  trashed_at?: string | null;
}
export interface OpaqueRecord extends Sealed {
  id: string;
  vault_id: string;
  crypto_version: 1;
  revision: number;
}
export interface OpaqueWrite extends Sealed {
  vault_epoch: string;
  crypto_version: 1;
  expected_revision: number;
  operation_id: string;
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
export const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
export function base64(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result);
}
export function unbase64(
  text: string,
  length?: number,
  maxEncoded = 2000000,
): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length > maxEncoded)
    throw new Error('Invalid encrypted data.');
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (base64(bytes) !== text || (length !== undefined && bytes.length !== length))
    throw new Error('Invalid encrypted data.');
  return bytes;
}
export function validCivilDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) return false;
  const parsed = new Date(date + 'T12:00:00Z');
  return !isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
export function validatePayload(value: Payload): Payload {
  if (
    !value ||
    !validCivilDate(value.date) ||
    typeof value.title !== 'string' ||
    Array.from(value.title).length > 200 ||
    typeof value.body !== 'string' ||
    encoder.encode(value.body).length > 1048576 ||
    typeof value.trashed !== 'boolean' ||
    (value.trashed_at != null &&
      (typeof value.trashed_at !== 'string' || !Number.isFinite(Date.parse(value.trashed_at)))) ||
    !/^\d{4}-\d\d-\d\dT/.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !Number.isFinite(Date.parse(value.updated_at))
  )
    throw new Error('Invalid encrypted entry.');
  return value;
}
export function validateEnvelope(e: Envelope): Envelope {
  if (
    !e ||
    e.format_version !== 1 ||
    !uuid.test(e.vault_id) ||
    e.passphrase?.kdf?.algorithm !== 'argon2id' ||
    e.passphrase.kdf.version !== 19 ||
    e.passphrase.kdf.memory_kib !== 65536 ||
    e.passphrase.kdf.iterations !== 3 ||
    e.passphrase.kdf.parallelism !== 1 ||
    e.recovery?.algorithm !== 'HKDF-SHA256'
  )
    throw new Error('Unsupported vault format or KDF settings.');
  unbase64(e.passphrase.kdf.salt, 16);
  unbase64(e.passphrase.nonce, 12);
  unbase64(e.passphrase.ciphertext, 48);
  unbase64(e.recovery.salt, 16);
  unbase64(e.recovery.nonce, 12);
  unbase64(e.recovery.ciphertext, 48);
  return e;
}
export function validatePassphrase(pass: string) {
  const size = encoder.encode(pass).length;
  if (size < 12 || size > 1024) throw new Error('Use a passphrase of 12 to 1024 UTF-8 bytes.');
}
export async function aesKey(raw: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(
  key: CryptoKey,
  data: Uint8Array<ArrayBuffer>,
  context: string,
): Promise<Sealed> {
  const nonce = random(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(context), tagLength: 128 },
    key,
    data,
  );
  return { nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function open(
  key: CryptoKey,
  data: Sealed,
  context: string,
  maxEncoded = 2000000,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unbase64(data.nonce, 12),
        additionalData: encoder.encode(context),
        tagLength: 128,
      },
      key,
      unbase64(data.ciphertext, undefined, maxEncoded),
    ),
  );
}
export async function passKey(pass: string, kdf: KDF) {
  if (encoder.encode(pass).length > 1024) throw new Error('Passphrase too long.');
  const derived = new Uint8Array(
    await argon2id({
      password: pass,
      salt: unbase64(kdf.salt, 16),
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    }),
  );
  try {
    return await aesKey(derived);
  } finally {
    derived.fill(0);
  }
}
export function recoveryBytes(secret: string): Uint8Array<ArrayBuffer> {
  const normalized = secret.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error('Enter the complete 64-character recovery key.');
  return Uint8Array.from(normalized.match(/../g)!, (pair) => parseInt(pair, 16));
}
async function recoveryKey(secret: string, salt: string, vault: string) {
  const raw = recoveryBytes(secret);
  try {
    const source = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: unbase64(salt, 16),
        info: encoder.encode(`webdiary|recovery|v1|${vault}`),
      },
      source,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    raw.fill(0);
  }
}
export async function wrapPassword(
  raw: Uint8Array<ArrayBuffer>,
  pass: string,
  vault: string,
): Promise<Envelope['passphrase']> {
  validatePassphrase(pass);
  const kdf: KDF = {
    algorithm: 'argon2id',
    version: 19,
    memory_kib: 65536,
    iterations: 3,
    parallelism: 1,
    salt: base64(random(16)),
  };
  return {
    kdf,
    ...(await seal(await passKey(pass, kdf), raw, `webdiary|wrap|v1|${vault}|passphrase`)),
  };
}
export async function wrapRecovery(raw: Uint8Array<ArrayBuffer>, vault: string) {
  const bytes = random(32);
  const secret = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  bytes.fill(0);
  const salt = base64(random(16));
  const envelope: Envelope['recovery'] = {
    algorithm: 'HKDF-SHA256',
    salt,
    ...(await seal(
      await recoveryKey(secret, salt, vault),
      raw,
      `webdiary|wrap|v1|${vault}|recovery`,
    )),
  };
  return { secret, envelope };
}
export async function unwrapPassword(e: Envelope, pass: string) {
  validateEnvelope(e);
  return open(
    await passKey(pass, e.passphrase.kdf),
    e.passphrase,
    `webdiary|wrap|v1|${e.vault_id}|passphrase`,
  );
}
export async function unwrapRecovery(e: Envelope, secret: string) {
  validateEnvelope(e);
  return open(
    await recoveryKey(secret, e.recovery.salt, e.vault_id),
    e.recovery,
    `webdiary|wrap|v1|${e.vault_id}|recovery`,
  );
}
export const context = (kind: 'entry' | 'draft', vault: string, id: string) =>
  `webdiary|${kind}|v1|${vault}|${id}`;
export async function encryptJSON(key: CryptoKey, value: unknown, aad: string) {
  return seal(key, encoder.encode(JSON.stringify(value)), aad);
}
export async function decryptJSON<T>(
  key: CryptoKey,
  value: Sealed,
  aad: string,
  maxEncoded = 2000000,
): Promise<T> {
  const bytes = await open(key, value, aad, maxEncoded);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Encrypted data could not be decoded.');
  } finally {
    bytes.fill(0);
  }
}
