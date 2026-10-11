# Setup and troubleshooting

## Windows or Mac, using installed PostgreSQL

Use your cloned WebDairy folder. Install Go 1.27.1 and Node 24.15+ (validated 24.19.0),
and ensure PostgreSQL is accepting connections. Use the actual PostgreSQL role,
password and port configured on your machine; `diary_user` is just an example.
Create a separate empty database for WebDairy, with a role allowed to migrate it.

In the backend terminal, from `WebDairy/backend`, set the connection **before**
running migrations/server. Replace placeholders with your own values locally.
URL-encode password characters such as `@`, `:`, `#` and `%`.

Windows PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://YOUR_ROLE:YOUR_PASSWORD@127.0.0.1:5432/diary_db?sslmode=disable'
go mod download
go run ./cmd/diary -migrate
go run ./cmd/diary
```

Mac terminal:

```bash
export DATABASE_URL='postgres://YOUR_ROLE:YOUR_PASSWORD@127.0.0.1:5432/diary_db?sslmode=disable'
go mod download
go run ./cmd/diary -migrate
go run ./cmd/diary
```

Leave this terminal running. In a **second terminal**, from `WebDairy/frontend`:

```bash
npm ci
npm start
```

Open the local app on port 4200. First create the login password and a different
vault passphrase, then save/verify the offline recovery key. On later visits log
in and unlock. `npm start` includes the proxy configuration; plain `ng serve`
without that configuration cannot forward `/api` to Go.

The variable is held by that terminal and inherited by the Go process, not saved
in Go source. A new terminal needs it again. `.env` is not automatically loaded by
this backend. Never replace `os.Getenv("DATABASE_URL")` with the connection string:
Getenv expects the **variable's name**. Do not commit credentials.

## Cloud development

Use the existing `/workspace/WebDairy` checkout; no extra worktree is needed.
Source `scripts/env.sh` for the verified Go toolchain and writable dependency caches.
Run `scripts/install.sh` if dependencies are missing, then `scripts/dev.sh`.
The scripts manage a labelled, loopback-bound PostgreSQL container for synthetic
data only. Port conflicts are reported without stopping unrelated services.

- Backend unavailable: keep the Go terminal running; inspect its current error.
- Database not-ready: verify `pg_isready` and actual credentials with `psql`, then
  run `go run ./cmd/diary -migrate` from backend. Health requires migration 5.
- Password authentication failed: the PostgreSQL role/password in DATABASE_URL
  differs from your actual database account. This is separate from WebDairy login.
- Login expired: unlock after logging in again; encrypted pending drafts stay local.
- Wrong vault key/corrupt record: editing is blocked; no empty replacement is created.
- Encrypted draft storage failure: keep the tab open, free browser storage and retry.
  Lock will report failure while it cannot safely persist the current draft.
- Another editing tab: lock/close that tab first. Use the same browser and hostname;
  localhost and 127.0.0.1 have separate cookies, storage and Web Locks.
- Forgotten login: run `go run ./cmd/diary -reset-login` in an interactive backend
  terminal. It revokes sessions without altering the vault.
- Forgotten vault passphrase: after login, use the offline recovery key to set a
  new passphrase. Login reset cannot decrypt the diary.

Migrations 1–5 apply transactionally once under an advisory lock; startup never
resets data. Version 5 adds login/session/revision support. Existing Phase 1
plaintext development rows are preserved separately, without automatic import.

`bash scripts/test-integration.sh` uses a disposable synthetic database, ignoring
any caller-supplied personal DATABASE_URL. Ordinary unit tests skip database tests
unless TEST_DATABASE_URL is provided. Cloud publication retains setup/source,
not a guaranteed database backup. Docker data should not be assumed to survive a
new cloud snapshot/task.
