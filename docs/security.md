# Phase 3 security design and limits

## Scope

One local owner/vault, one active computer and one browser origin. Use a consistent
hostname (127.0.0.1 or localhost), not both simultaneously. Web Locks prevents two
editing tabs in the same browser/origin; it cannot coordinate different browsers,
profiles, hostnames or computers. Revision checks still reject conflicting writes
on the same record. Encrypted dates cannot be deduplicated by the server across
independent offline writers; the client refuses duplicate dates when opening.

The design protects diary content at rest from someone obtaining only the database
or browser draft store. It does not protect an unlocked browser, malware, extensions,
OS administrators, keyloggers, malicious served JavaScript or a compromised local
machine. A database writer can delete/replay data; AES-GCM detects altered ciphertext
and identity substitution, not deletion or complete rollback of an old valid vault.
Record count, byte size, opaque IDs, revisions and operational write timing are visible.

## Key and payload format

Web Crypto generates a random 256-bit vault key. Entry AES-256-GCM uses a new random
96-bit nonce for every encryption and a 128-bit tag. Authenticated context is:

```
webdiary|entry|v1|<vault UUID>|<immutable record UUID>
```

The encrypted JSON holds civil date, title, body, content creation/update timestamps
and trash state/deletion timestamp. Dates are unchanged across timezone changes;
Today uses the configured timezone (Asia/Kolkata by default).
Encrypted draft context uses `draft` in place of `entry`, binding the same identifiers.
Pending attempts contain their exact original opaque write inside the encrypted draft,
so crash/lost-response retry cannot reuse an operation ID with different ciphertext.

A passphrase envelope wraps the random key using Argon2id version 19, 64 MiB,
3 iterations, one lane, random 16-byte salt, then AES-GCM with its own nonce and
context `webdiary|wrap|v1|<vault UUID>|passphrase`. The pinned browser implementation
is hash-wasm 4.12.0, bundled locally without a CDN. Both browser and Go reject
unrecognized/oversized KDF policies before derivation. Passphrases are 12–1024
UTF-8 bytes; stronger unpredictable passphrases are preferable. No trimming or
Unicode normalization changes the passphrase. Browser/Go fixture compatibility
is checked independently; AES-GCM also has a published known-answer test.

In the cloud Chromium check, the initial Argon2id/recovery-envelope setup flow took
about **299–367 ms**. These are one machine's development measurements, not a universal
performance guarantee. Benchmark on supported desktop hardware before release;
any future KDF-policy change needs a versioned migration, not silently weaker costs.

Recovery uses a random 256-bit secret, shown as 64 hexadecimal characters, separate
16-byte salt and HKDF-SHA256. HKDF info is `webdiary|recovery|v1|<vault UUID>`;
AES-GCM wrapping context ends in `|recovery`. First setup requires an offline copy
and full-key verification before committing. Wrong keys never create an empty vault.
Passphrase change/recovery rewraps the same key and verifies the new wrapper before
atomic revision-checked storage. Recovery-key rotation similarly requires verification.
Old recovery secrets may still unlock old backup/database copies; rotation is not
retroactive revocation. Neither losing both passphrase and recovery secret nor deleting
the only database copy can be fixed by resetting login.

AES CryptoKeys are non-extractable. The raw vault key remains in unlocked memory for
rewrapping only; temporary byte buffers are cleared where practical. Lock clears the
editor, indexes, attempts, recovery display and key references. JavaScript strings,
WASM/runtime internals, garbage collection and OS memory prevent guaranteed erasure.
No passphrase, raw key, login secret or plaintext draft is written to localStorage/
IndexedDB; localStorage holds only non-sensitive inactivity, timezone, theme and trash-period
preferences. Search text and excerpts remain in the unlocked component memory.

## Draft and lock behavior

Encrypted draft writes complete before a network save is submitted. Queues serialize
writes per date; acknowledgement removes a draft only when current text matches the
acknowledged version. A later edit remains recoverable. On unlock, encrypted records
and drafts must all verify before editing is enabled; corruption preserves data and
blocks opening rather than displaying an empty replacement.

Lock stops autosave, waits for in-flight requests and encrypts the latest drafts.
Server outage does not prevent local lock. Encryption/IndexedDB failure reports an
error and refuses to clear the working key/editor, so the user can retry. Session
expiry similarly preserves drafts before returning to login. Default inactivity is
five minutes, configurable 1–60; suspended/background browser timers can delay it.
Power loss, storage eviction or forced closure before the last draft write completes
can lose the last edits. IndexedDB drafts are not independent backups.

## Local API and deployment

Login uses independent server-side Argon2id password hashing. Opaque session/CSRF
secrets have only hashes in PostgreSQL. Sessions have 30-minute idle and 24-hour
absolute expiry; login rotation, logout and password reset revoke appropriate sessions.
Persisted five-attempt/minute throttling bounds login work. Host/Origin validation,
SameSite=Strict HttpOnly cookies and a matching header CSRF token protect writes.
There is no permissive CORS configuration or request-body/access logging.

The Angular development response has a CSP restricted to locally bundled scripts
(including WASM compilation), same-origin API and local development WebSocket,
with no frames/objects. Inline styles remain required by Angular. This is a development
server, not the future packaged server; equivalent headers and deployment controls
must be implemented for that server before release.

Cloud Docker trust authentication, a development database superuser and loopback
HTTP are **synthetic development only**. Before personal use, provision a restricted
runtime DB role distinct from the migration/admin role, authenticated local database
access, trusted executable/assets and supported desktop lifecycle. Phase 3 export/restore has been rehearsed with synthetic data on clean databases;
Windows packaging and supported desktop acceptance remain future work.
This implementation has automated development checks, not a third-party security audit.

## Portable backup and restore

Format 1 `.diary` JSON holds wrapped key envelopes, vault UUID, 16-byte random HKDF
salt, 12-byte nonce and ciphertext. The entire manifest is encrypted with AES-256-GCM:
HKDF-SHA256 derives a separate backup key from the vault key with info
`webdiary|backup-key|v1|<vault UUID>`. Additional authenticated data is
`webdiary|backup|v1|<vault UUID>|<base64 salt>|<base64 SHA256 canonical envelope>`.
Canonical envelope JSON recursively sorts object keys. Every export generates a
new salt and nonce. The encrypted manifest contains version/source, vault envelope,
epoch/generation, encrypted records/revisions, snapshot timestamp and preferences.
No login hashes, sessions, CSRF tokens, passwords or raw/recovery keys are exported.
KDF metadata and wrapped keys are public headers, authenticated by the outer tag.

Import rejects unsupported versions/oversized headers before deriving a key. It
unwraps with the file's passphrase or recovery envelope, verifies the outer manifest,
then decrypts/authenticates every inner entry and rejects duplicate active dates/IDs.
Multiple trashed records on one date are allowed. Entry and draft formats remain
compatible with Phase 2; old trash lacks a timestamp and uses its update timestamp.
Limits are bounded in browser and server (see api.md). Preview raw keys are temporary,
cleared on expiry, cancel or lock; existing-diary imports require an unlocked vault.

Export first saves drafts, then takes a consistent encrypted database snapshot.
An emergency editor-text export can instead encrypt current in-memory drafts during
an outage; it labels its unconfirmed/conflict content and never calls it Saved.
Browser IndexedDB stores encrypted backup archives only. A browser copy must succeed
before download/replacement. Quota/storage failures block replacement. Keep downloaded
files separately: browser storage and server copies share their machine's failure risk.

Before replacement the browser makes a verified, encrypted current-diary copy,
stores it locally and starts a download; the owner must confirm saving that file.
The server binds the stage to the session/CSRF token, checks the exact snapshot
baseline and atomically captures the safety archive, changes owner/vault/records,
advances revision/generation and creates a new epoch. SQL failure leaves the original
state unchanged. The last three successful replacement copies stay encrypted in
PostgreSQL until superseded; browser copies remain until explicitly removed.
Stale pending saves/drafts require comparison after a new epoch, even if their old
record revision coincides with the restored one. Old ordinary writes cannot bypass
permanent-deletion tombstones. Explicit user-confirmed import can restore old deleted
content; deletion does not revoke or edit exported files.

This is local snapshot replacement, not merging or multi-device synchronization.
Old backups require their own historical passphrase/recovery key after rewrapping.
A clean-database import asks for a new independent local login; it never restores
login credentials. Automatic/Drive backups and desktop secure token handling belong
to Phase 4. Trash retention is a minimum period (1–365 days, default 30); deletion
of expired items requires confirmation while unlocked, rather than an unattended purge.
