import { argon2id } from 'hash-wasm';
import { webcrypto } from 'node:crypto';
import {
  aesKey,
  base64,
  open,
  seal,
  encryptJSON,
  decryptJSON,
  context,
  wrapPassword,
  wrapRecovery,
  unwrapPassword,
  unwrapRecovery,
  validateEnvelope,
  random,
  Envelope,
} from './vault-crypto';
const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (n) => parseInt(n, 16));
describe('Browser vault cryptography', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());
  it('matches the independent Go Argon2id fixture at the pinned vault cost', async () => {
    const digest = await argon2id({
      password: 'synthetic Argon2 fixture',
      salt: Uint8Array.from({ length: 16 }, (_, i) => i),
      iterations: 3,
      memorySize: 65536,
      parallelism: 1,
      hashLength: 32,
      outputType: 'hex',
    });
    expect(digest).toBe('de00760260e1439f9a348a6b68f4b4ab4d999690f770a183ebd26df8e23d7333');
  });
  it('decrypts a published AES-256-GCM known-answer vector', async () => {
    const key = await aesKey(new Uint8Array(32));
    const result = await open(
      key,
      {
        nonce: base64(new Uint8Array(12)),
        ciphertext: base64(hex('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919')),
      },
      '',
    );
    expect(result).toEqual(new Uint8Array(16));
    expect(key.extractable).toBe(false);
  });
  it('uses fresh 96-bit nonces and rejects swapped record/vault IDs and tampering', async () => {
    const key = await aesKey(random(32)),
      aad = context('entry', 'vault', 'record');
    const a = await encryptJSON(key, { body: 'Synthetic' }, aad),
      b = await encryptJSON(key, { body: 'Synthetic' }, aad);
    expect(a.nonce).not.toBe(b.nonce);
    expect(await decryptJSON(key, a, aad)).toEqual({ body: 'Synthetic' });
    await expect(decryptJSON(key, a, context('entry', 'vault', 'other'))).rejects.toThrow();
    await expect(decryptJSON(key, a, context('entry', 'other', 'record'))).rejects.toThrow();
    await expect(decryptJSON(key, { ...a, ciphertext: 'AAAA' }, aad)).rejects.toThrow();
  });
  it('wraps the same random key with independent passphrase and recovery envelopes', async () => {
    const raw = random(32),
      id = crypto.randomUUID(),
      pass = 'synthetic vault passphrase';
    const recovery = await wrapRecovery(raw, id);
    const envelope: Envelope = {
      format_version: 1,
      vault_id: id,
      passphrase: await wrapPassword(raw, pass, id),
      recovery: recovery.envelope,
    };
    expect(await unwrapPassword(envelope, pass)).toEqual(raw);
    expect(await unwrapRecovery(envelope, recovery.secret)).toEqual(raw);
    await expect(unwrapPassword(envelope, 'incorrect passphrase')).rejects.toThrow();
    await expect(unwrapRecovery(envelope, '0'.repeat(64))).rejects.toThrow();
    envelope.passphrase = await wrapPassword(raw, 'new synthetic passphrase', id);
    expect(await unwrapPassword(envelope, 'new synthetic passphrase')).toEqual(raw);
    expect(await unwrapRecovery(envelope, recovery.secret)).toEqual(raw);
    envelope.passphrase.kdf.memory_kib = 999999999 as 65536;
    expect(() => validateEnvelope(envelope)).toThrow('KDF');
  });
});
