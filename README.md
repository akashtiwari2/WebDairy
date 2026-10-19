# WebDairy

A local personal diary built with Angular, Go Echo and PostgreSQL, following the
owner-supplied `Diary_App_Detailed_Plan.pdf`. The PDF describes planned features;
this repository's roadmap records what is actually implemented.

## Current milestone: Phase 4 development implementation

- Calendar/editor for past, present and future dates; configurable timezone (Asia/Kolkata default), month picker and collapsible calendar.
- Separate login password and vault passphrase; Argon2id password hashing,
  HttpOnly sessions, expiry, login throttling, Host/Origin and CSRF checks.
- Browser AES-256-GCM encryption, random vault key, pinned Argon2id wrapping,
  independent offline recovery key and verified first-time recovery setup.
- Passphrase change, recovery-key replacement and login-password reset.
- Serialized one-second autosave, optimistic revisions, idempotent lost-response
  retries and explicit comparison before resolving a conflict.
- Encrypted IndexedDB pending drafts, recovery on unlock, manual/five-minute
  inactivity lock, and one editing tab per browser origin using Web Locks.
- Browser-only title/body/tag search, mood/tag filters, optional writing streak and backup health; local text search with date filters and excerpts.
- Trash comparison/restore to an empty date, confirmed permanent deletion and
  confirmed expired-trash cleanup (30 days by default).
- Light/dark/system theme, timezone and trash-period settings.
- Portable encrypted .diary exports, verified import preview, current-diary safety
  backup and atomic replacement; independent passphrase/recovery-key restoration.
- Last three pre-replacement backups retained in PostgreSQL, with encrypted browser
  copies and separate file downloads.

Google sign-in uses PKCE/state and a verified Google subject. Drive consent is
separate; OAuth tokens use OS credential storage. Daily/weekly/monthly encrypted
uploads retry durable pending archives, with per-vault retention after verified
transfer. New-device restore still needs a backup passphrase/recovery key.
Desktop builds embed Angular assets and migrations; PostgreSQL remains required.

Clean-database restore is rehearsed automatically with both backup secrets.
This is development software, not a security-audited release. The development
Docker database uses trust authentication and is unsuitable for personal data.

Existing Phase 1 rows are preserved in `development_entries`; they are not
converted into encrypted entries, erased, or served by the default API. Old
plaintext copies stay plaintext until deliberately handled separately.

## Cloud development

Validated: Node **24.19.0**, npm **11.9.0**, Angular CLI **22.2.1**, Go **1.27.1**,
PostgreSQL **18** with a pinned Docker image. Cloud scripts require Docker and
Linux amd64; use the existing checkout without an additional worktree.

```bash
cd /workspace/WebDairy
bash scripts/install.sh
bash scripts/dev.sh
```

The Go backend automatically applies pending migrations before accepting requests.
For local Windows/Mac use, run `go run ./cmd/diary` from `backend`; no separate
`-migrate` command is required. Already-applied migrations are skipped.

Cloud startup checks ports, starts the labelled synthetic database, applies numbered
migrations 1–7, then starts Go on loopback 47831 and Angular on loopback 4300 with
the same-origin `/api` proxy. Ctrl+C stops its app children; PostgreSQL stays up.

On the first visit, create two different passwords, copy the recovery key offline,
and verify that copy. Later, log in and then unlock the vault. Secrets are entered
locally; do not send them in chat or commit them to Git.

```bash
bash scripts/check.sh             # Go tests/vet, Angular tests, production build
bash scripts/test-integration.sh  # Real PostgreSQL, restore rollback, race detection
bash scripts/test-browser.sh      # Chromium, disposable DB, both restore secrets
```

Writing now includes encrypted mood/tags and local filters, an optional saved-day
streak, durable offline drafts with reconnect retries, and browser backup health.
See [writing and offline limits](docs/writing.md). Optional Google login, scheduled Drive backups and desktop builds are now available
after configuration. See [Google and desktop setup](docs/google-setup.md).

See [local Windows/Mac setup](docs/setup.md), [API](docs/api.md),
[security design](docs/security.md), [browser checks](docs/browser-tests.md) and
[roadmap](docs/roadmap.md).

## Saving, locking and recovery

Saved means PostgreSQL acknowledged a committed encrypted write. Before submission,
the browser stores the pending attempt and latest text in an encrypted draft.
Lost-response retries reuse the same operation ID and ciphertext. Conflicts retain
both your draft and the decrypted saved version for an explicit choice.

Lock encrypts outstanding drafts before clearing the editor, date index and keys.
It can complete while the server is unavailable. If draft encryption/storage fails,
lock reports failure and keeps the tab/key available for retry. After a refresh or
restart, log in/unlock and review recovered drafts before saving them.

Wait for Saved before closing. Browser termination, storage eviction, disk failure
or loss of the most recent keystroke before encryption can still lose data.
Browser drafts are not backups. Keep an exported .diary file outside browser
storage, and its passphrase or recovery key separately. The Docker volume and cloud
publication are not backups. See [backup/restore steps](docs/backup.md).

Clearing all text does not silently delete a saved entry. Use Delete entry to
move its content to encrypted trash. Writing again on that date creates a new
record and preserves the old trash entry. Revisiting an untouched empty date creates
no row. Limits: 200 Unicode title characters, 1 MiB UTF-8 body, 2 MiB JSON request.
Diary dates, title/body, content timestamps and deletion state stay inside the
ciphertext; the database still sees record IDs, revisions, sizes and write timing.

## Login reset

From `backend`, with `DATABASE_URL` configured in `.env` or the process, run:

```bash
go run ./cmd/diary -reset-login
```

Enter/confirm a new password at the hidden terminal prompts. All sessions are
revoked. The encrypted vault and recovery key are unchanged. This command cannot
recover a forgotten vault passphrase; use the offline recovery key for that.

## Layout

```text
frontend/      Angular UI, browser crypto, authentication and encrypted drafts
backend/       Echo protected API, opaque storage, migration runner and tests
migrations/    Numbered SQL, including preserved synthetic Phase 1 tables
scripts/       Install/start and isolated verification tools
docs/          Setup, API, security design and remaining milestones
```

The backend loads `backend/.env` automatically when run from `backend`. Copy
[the template](backend/.env.example) once and set your own connection. Explicit
process variables override the file; restart Go after edits. Never commit credentials.
Generated binaries, `.env` files, logs and diary exports are ignored.

### Simple browser launcher with PostgreSQL

WebDairy remains a browser app backed by local PostgreSQL. Packaged launchers embed
frontend/migrations and open the browser; first-run connection setup is in the browser,
with start/setup/reset shortcuts. No Go/Node is needed to run a package. New backup
preferences default to Daily; Google credentials and Drive permission are still required.
See [daily-use guide](docs/daily-use.md) for setup, upgrades and one-laptop-at-a-time restore.
No Tauri/native window, SQLite migration, hosted service or closed-app backup is included.
