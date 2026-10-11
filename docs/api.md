# Phase 2 local API

Go listens on `127.0.0.1:8080`. Angular's same-origin `/api` proxy forwards from
4200 while preserving Host. Allowed hosts are localhost/127.0.0.1 on those two
ports. Writes require matching Origin, JSON content type and `X-CSRF-Token`.
Cross-site requests are rejected. No CORS allowance or request-body logging.

All responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
Uninitialized bootstrap/setup is intended only for the trusted local owner.

| Route | Purpose |
| --- | --- |
| GET `/api/health` | Database migration 5 readiness; stage `phase2` |
| GET `/api/auth/session` | `{initialized,authenticated,csrf_token}`; bootstrap cookie |
| POST `/api/auth/setup` | `{login_password,envelope}`; creates one owner/vault atomically |
| POST `/api/auth/login` | `{password}`; new session and rotated CSRF token |
| POST `/api/auth/logout` | Revokes session and cookies |
| POST `/api/auth/password` | `{current_password,new_password}`; revokes all sessions |
| GET `/api/vault` | Authenticated `{envelope,revision}` |
| PUT `/api/vault` | `{envelope,expected_revision,operation_id}`; atomic envelope revision |
| GET `/api/entries?cursor=UUID` | Authenticated `{records,next_cursor}`; 100 per page |
| PUT `/api/entries/UUID` | Authenticated encrypted write; committed encrypted record |

Entry reads and writes contain no diary dates or text. No plaintext date route,
physical-delete route or public listing is exposed by the production constructor.
The legacy development server constructor remains solely for compatibility tests.

A write contains `crypto_version:1`, base64 `nonce` (12 bytes), base64 `ciphertext`
(with GCM tag), `expected_revision` (0 creates) and UUID `operation_id`.
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
