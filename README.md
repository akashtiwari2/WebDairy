# WebDairy

A local personal diary built with Angular, Go Echo and PostgreSQL, following the
owner-supplied `Diary_App_Detailed_Plan.pdf`. The PDF describes planned features;
this repository's roadmap records what is actually implemented.

## Current milestone: Phase 2 private vault

- Calendar/editor for past, present and future dates; Today uses Asia/Kolkata.
- Separate login password and vault passphrase; Argon2id password hashing,
  HttpOnly sessions, expiry, login throttling, Host/Origin and CSRF checks.
- Browser AES-256-GCM encryption, random vault key, pinned Argon2id wrapping,
  independent offline recovery key and verified first-time recovery setup.
- Passphrase change, recovery-key replacement and login-password reset.
- Serialized one-second autosave, optimistic revisions, idempotent lost-response
  retries and explicit comparison before resolving a conflict.
- Encrypted IndexedDB pending drafts, recovery on unlock, manual/five-minute
  inactivity lock, and one editing tab per browser origin using Web Locks.
- Encrypted deletion state. Trash browsing, search and backup/restore are Phase 3.

**Use sample data until encrypted export/restore is implemented and rehearsed.**
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

Startup checks ports, starts the labelled synthetic database, applies numbered
migrations 1–5, then starts Go on loopback 8080 and Angular on loopback 4200 with
the same-origin `/api` proxy. Ctrl+C stops its app children; PostgreSQL stays up.

On the first visit, create two different passwords, copy the recovery key offline,
and verify that copy. Later, log in and then unlock the vault. Secrets are entered
locally; do not send them in chat or commit them to Git.

```bash
bash scripts/check.sh             # Go tests/vet, Angular tests, production build
bash scripts/test-integration.sh  # Real PostgreSQL and race detection, disposable DB
```

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
Browser drafts are not backups. The Docker volume and cloud publication are not
backups either; no cross-machine recovery is promised yet.

Clearing all text does not silently delete a saved entry. Use Delete entry to
mark its content as encrypted trash. Revisiting an untouched empty date creates
no row. Limits: 200 Unicode title characters, 1 MiB UTF-8 body, 2 MiB JSON request.
Diary dates, title/body, content timestamps and deletion state stay inside the
ciphertext; the database still sees record IDs, revisions, sizes and write timing.

## Login reset

From `backend`, with `DATABASE_URL` set, run:

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

`DATABASE_URL` may override the local connection; never commit credentials.
Generated binaries, `.env` files, logs and diary exports are ignored.
