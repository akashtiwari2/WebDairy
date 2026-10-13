# Setup and troubleshooting

For the packaged browser launcher (no Go/Node), follow [daily use](daily-use.md).
PostgreSQL is retained. The first-run browser wizard saves the local connection;
Start-WebDairy/Setup-WebDairy/Reset-login shortcuts are included. The instructions
below are for working with the source checkout.

## Windows or Mac, using installed PostgreSQL

Use your cloned WebDairy folder. Install Go 1.27.1 and Node 24.15+ (validated 24.19.0),
and ensure PostgreSQL is accepting connections. Use the actual PostgreSQL role,
password and port configured on your machine; `diary_user` is just an example.
Create a separate empty database for WebDairy, with a role allowed to migrate it.

In `WebDairy/backend`, create `.env` once from the included template and edit it
with your actual PostgreSQL connection. URL-encode password characters such as
`@`, `:`, `#` and `%`. The PostgreSQL role/password is separate from the app login.

Windows PowerShell (first setup only):

```powershell
Copy-Item .env.example .env
notepad .env
```

Mac terminal (first setup only):

```bash
cp .env.example .env
open -e .env
```

Save this line with **your own values** in the file:

```dotenv
DATABASE_URL=postgres://YOUR_ROLE:YOUR_PASSWORD@127.0.0.1:5432/diary_db?sslmode=disable
```

Now run these commands from `backend` on either Windows or Mac:

```bash
go mod download
go run ./cmd/diary
```

Backend startup automatically applies pending migrations before accepting requests.
Already-applied migrations are skipped; existing diary data is preserved. No separate
`-migrate` command is needed. Keep `-migrate` only when you want to apply migrations
and exit without starting the server.

Leave this terminal running. In a **second terminal**, from `WebDairy/frontend`:

```bash
npm ci
npm start
```

Open the local app on port 4200. First create the login password and a different
vault passphrase, then save/verify the offline recovery key. On later visits log
in and unlock. `npm start` includes the proxy configuration; plain `ng serve`
without that configuration cannot forward `/api` to Go.

Go automatically reads `.env` in the backend working directory for server,
migration and login-reset commands. You do not need to export the variable again
in every new terminal. A process variable set explicitly takes precedence over the
file. To switch to the file in an old terminal, remove its override: PowerShell
`Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue`, or Mac
`unset DATABASE_URL`. Changes to `.env` take effect after restarting Go.

Keep `.env` local: it is ignored by Git. Only `.env.example` is shared. On a new
clone, copy that template once and use that machine's connection. The cloud's local
`.env` uses a synthetic trust-auth development database; those values are not your
Windows/Mac credentials. Use `-env PATH` for an explicit file location, e.g.
`go run ./cmd/diary -env .env.local`. A missing default file is allowed when
DATABASE_URL is set in the process; an explicit missing or malformed file fails
without printing its contents. The frontend must never receive DATABASE_URL.

## Cloud development

Use the existing `/workspace/WebDairy` checkout; no extra worktree is needed.
Source `scripts/env.sh` for the verified Go toolchain and writable dependency caches.
Run `scripts/install.sh` if dependencies are missing, then `scripts/dev.sh`.
The scripts manage a labelled, loopback-bound PostgreSQL container for synthetic
data only. Port conflicts are reported without stopping unrelated services.

- Backend unavailable: keep the Go terminal running; inspect its current error.
- Database not-ready: verify `pg_isready` and actual credentials with `psql`, then
  restart with `go run ./cmd/diary` from backend. Startup applies pending migrations
  and exits with an error if migration fails. Health requires migration 7.
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

Migrations 1–7 apply transactionally once under an advisory lock; startup never
resets data. Version 5 adds login/session/revision support; version 6 adds restore
staging, backup history, vault epochs and permanent-deletion tombstones. Existing Phase 1
plaintext development rows are preserved separately, without automatic import.

`bash scripts/test-integration.sh` uses a disposable synthetic database, ignoring
any caller-supplied personal DATABASE_URL. Ordinary unit tests skip database tests
unless TEST_DATABASE_URL is provided. Cloud publication retains setup/source,
not a guaranteed database backup. Docker data should not be assumed to survive a
new cloud snapshot/task.

## Updating from Phase 2

Stop your own backend/frontend processes. From the cloned repository root run
`git pull`; keep your backend `.env` configured. From `backend`, run
`go run ./cmd/diary` (migrations run automatically). From `frontend`, run
`npm ci`, then `npm start`. The migration preserves encrypted entries and old
Phase 1 development data. Unlock, then use Search / Trash, Settings or Backups.
See [backup and restore](backup.md) before switching machines.

## Google and desktop builds

Google integration is optional and disabled without a configured Desktop OAuth
client. Follow [Google/Drive and desktop setup](google-setup.md). Startup applies
migration 7 while preserving existing owners, password hashes and encrypted data.
Existing owners link Google after local login; Google-only owners can add an
optional offline login password. Configure Drive consent/schedule separately.
