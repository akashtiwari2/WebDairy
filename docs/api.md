# Phase 3 local API

Go listens on `127.0.0.1:8080`. Angular's same-origin `/api` proxy forwards from
4300 while preserving Host. Allowed hosts are localhost/127.0.0.1 on those two
ports. Writes require matching Origin, JSON content type and `X-CSRF-Token`.
Cross-site requests are rejected. No CORS allowance or request-body logging.

All responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
Uninitialized bootstrap/setup is intended only for the trusted local owner.

| Route | Purpose |
| --- | --- |
| GET `/api/health` | Database migration 6 readiness; stage `phase3` |
| GET `/api/auth/session` | `{initialized,authenticated,csrf_token}`; bootstrap cookie |
| POST `/api/auth/setup` | `{login_password,envelope}`; creates one owner/vault atomically |
| POST `/api/auth/login` | `{password}`; new session and rotated CSRF token |
| POST `/api/auth/logout` | Revokes session and cookies |
| POST `/api/auth/password` | `{current_password,new_password}`; revokes all sessions |
| GET `/api/vault` | Authenticated `{envelope,revision,vault_epoch,generation}` |
| PUT `/api/vault` | `{envelope,expected_revision,operation_id}`; atomic envelope revision |
| GET `/api/entries?cursor=UUID` | Authenticated `{records,next_cursor}`; 100 per page |
| PUT `/api/entries/UUID` | Authenticated encrypted write; committed encrypted record |

Entry reads and writes contain no diary dates or text. No plaintext date route,
public listing is exposed by the production constructor.
The legacy development server constructor remains solely for compatibility tests.

A write contains `crypto_version:1`, base64 `nonce` (12 bytes), base64 `ciphertext`
(with GCM tag), `expected_revision` (0 creates), UUID `vault_epoch` and UUID `operation_id`.
A response adds immutable `id`, `vault_id` and positive `revision`.

`409` returns `{error:'revision_conflict',current:<opaque record|null>}` for entries.
The client authenticates/decrypts the comparison before offering a choice.
Reusing an operation ID with different bytes conflicts. Replaying identical
committed bytes acknowledges only while that record's resulting revision is still
current; a later edit makes the old retry conflict. Envelope updates use the same
rule. Database transactions retain hashed operation identities.

The envelope has format version 1, vault UUID, passphrase KDF/AES-GCM wrapper and
independent HKDF recovery wrapper. Each wraps the same random 32-byte vault key;
Go validates the bounded format and stores it, never receiving the raw key or vault
passphrase. KDF parameters outside the supported policy are rejected.

Login: 12–1024 UTF-8 bytes, Argon2id 64 MiB/3 iterations/1 lane, random 16-byte salt.
A global persisted one-minute window allows five password attempts, including valid
ones; subsequent attempts return `429` with Retry-After 60. Session tokens and CSRF
secrets are random 32-byte values; database storage holds hashes. Host-only HttpOnly
SameSite=Strict cookies use `/api`, idle expiry 30 minutes and absolute expiry 24
hours. Secure is enabled under TLS; this loopback development server uses HTTP.

`400`: invalid format; `401`: expired/missing authentication; `403`: Host/Origin/CSRF;
`404`: absent resource/route; `413`: request >2 MiB; `429`: login throttle;
`503`: database unavailable. Database error details and credentials are not exposed.

## Backup, restore and permanent deletion

| Route | Purpose |
| --- | --- |
| GET `/api/backup/snapshot` | Authenticated consistent `{vault,records,snapshot_at}` under REPEATABLE READ |
| DELETE `/api/entries/UUID` | Authenticated `{vault_epoch,expected_revision,operation_id}`; permanent removal, 204 |
| GET `/api/backup/history` | Authenticated metadata for the last three pre-replacement copies |
| GET `/api/backup/history/UUID` | Authenticated encrypted .diary archive |
| POST `/api/restore/stage` | Bounded opaque import; does not change the active diary |
| POST `/api/restore/commit` | Atomic replacement of a staged import |

Stage body: UUID `operation_id`, wrapped-key `envelope`, encrypted `records`, and
`expected`. Empty-database restore uses `expected:null`. Existing-diary restore
requires `{vault_id,vault_epoch,generation,envelope_revision}` matching the safety
snapshot and an encrypted `safety_backup` archive using the current envelope.
The browser authenticates the entire archive and every record before staging;
Go validates opaque structure, IDs, revisions, sizes and supported crypto policy.
Go cannot authenticate GCM contents without the vault key, which it never receives.

Stages bind to the authenticated session (or bootstrap CSRF secret for a fresh DB),
expire after 15 minutes, and permit two pending stages. Identical operation retries
are allowed. Finished payloads are cleared; expired stages are removed when staging
another import. The browser preview/key expires after five minutes or lock.

Commit body: UUID `stage_id`; fresh restore additionally requires
`new_login_password` (12–1024 bytes). Existing restore keeps the current login and
rejects an extra login password. Fresh bootstrap still requires matching Origin,
Host and CSRF; initialized stores require authentication. All data changes and the
retained safety archive commit in one transaction. A failure rolls back everything.
The previous encrypted archive remains separately downloadable after success.

Each write/purge increments vault generation. Every restore creates a new vault
epoch, rejecting delayed writes with `409 {error:'vault_changed'}`. Snapshot revision,
epoch and generation must still match at commit. Identical committed restore retries
acknowledge the current vault without applying the snapshot again. If a fresh commit
response is lost, log in using the newly chosen password and inspect the diary;
the client will not blindly repeat bootstrap replacement.

Permanent deletion uses a tombstone to prevent ordinary stale writes recreating
that UUID; retrying its original delete operation acknowledges it once. The server
cannot see the encrypted trash flag; the owner UI only offers purge on trash rows.
Explicit confirmed import may reintroduce content from an older backup, with a new
epoch. Backup files outside the app are never erased by deleting a diary entry.

Limits: 10,000 imported/exported records, 32 MiB serialized snapshot, 48 MiB encrypted
file and 96 MiB staging HTTP body; ordinary requests retain the 2 MiB cap. Restore
HTTP requests allow 60 seconds; others 10 seconds. Search queries and snippets never
use an API route.

## Optional Google and Drive APIs (Phase 4)

- `GET /api/google/status`: configured/link/Drive/proof/flow state; never OAuth tokens.
- `POST /api/google/start {purpose: login|link|drive}`: CSRF-protected PKCE authorization
  URL. Linking requires the existing owner's session; Drive consent is separate.
- `GET /api/google/callback`: one-use state/code callback; this alone permits a
  cross-site top-level GET. All other Host/Origin/CSRF checks remain.
- `POST /api/google/cancel`: cancel the pending local flow.
- `POST /api/auth/offline-password {password}`: authenticated Google-only owner;
  creates the first local password, never replaces an existing one without verification.
- `GET /api/drive/backups`: app-data backup metadata for the authenticated owner or
  verified fresh-device Google proof.
- `GET /api/drive/backups/:id`: selected owned opaque archive, bounded to 48 MiB.
- `POST /api/drive/upload {operation_id,archive,snapshot_at,keep}`: authenticated
  owner, matching vault, immutable upload retry and verified-transfer retention (3–100).
- `POST /api/drive/disconnect`: remove this device's stored credentials, retain files.

Fresh `/api/auth/setup` and `/api/restore/commit` accept `use_google: true` only
with a verified temporary Google proof; no new local login password is then needed.
Explicit local mode preserves the supplied local password even if a proof exists.
Existing-diary replacement keeps its login identity and still requires a safety copy.
`GET /api/desktop` identifies an active embedded-UI instance; it exposes no data.

## Packaged local browser setup

The executable binds only 127.0.0.1:8080 and initially serves an isolated setup
handler until PostgreSQL connects and migrations succeed. No diary/auth API is
mounted on this handler. `GET /setup/status` exposes only readiness, busy state,
a sanitized message and whether a connection is configured. Passwords/DSNs are
never returned. The setup HTML has a nonce-based CSP; mutation requires that
random startup token in `X-WebDairy-Setup`, exact local Origin/Host and JSON.

`POST /setup/connect {user,password,database,port,create,google_id,google_secret}`
accepts only a loopback PostgreSQL connection. Creation is limited to the named
missing database; system databases and unrelated occupied databases are rejected.
Missing schema migrations apply before settings are atomically saved with private
file permissions where supported. Blank Google fields preserve existing values;
process overrides cannot be silently changed. `POST /setup/retry` retries saved
settings. Concurrent initialization is serialized. Once ready, the handler serves
the original authenticated API/frontend; connection mutations are rejected.
`-configure` opens setup explicitly on the next launch; an existing running app
must be closed first. No PostgreSQL service is auto-started, modified or stopped.
