# WebDairy

A personal diary being built from scratch with Angular, Go Echo and PostgreSQL,
following `Diary_App_Detailed_Plan.pdf` supplied by the owner.

## Current milestone: runnable development foundation

- Angular calendar, Today, date picker and plain-text title/editor.
- Past and future dates, leap days, and separate **in-memory sample drafts** per date.
- Go Echo backend with `/api/health` that verifies the database migration exists.
- PostgreSQL 18, a repeatable transaction-based initial migration, and reserved
  vault/opaque encrypted-entry tables. No plaintext diary date/title columns.
- Locked dependencies, development scripts and automated checks.

**This is not yet a usable diary.** Refreshing loses the demo drafts. Login,
browser encryption, durable CRUD/autosave, encrypted draft recovery, export/restore,
Drive backup and Windows packaging are not implemented. Use synthetic text only.

## Cloud development quick start

Validated toolchain: Node **24.19.0**, npm **11.9.0**, Angular CLI **22.2.1**,
Go **1.27.1**, PostgreSQL **18** (image pinned by digest in the scripts).
A working Docker daemon and Linux amd64 are needed by the cloud install script.

```bash
cd /workspace/WebDairy
bash scripts/install.sh
bash scripts/dev.sh
```

`install.sh` installs a checksum-verified Go toolchain under `/workspace/.tools`,
uses `npm ci` and Go module checksums, and builds both components.
`dev.sh` starts/reuses the development database, applies migration 1, checks backend
readiness and runs Angular. The UI proxies `/api` to Go from the same browser origin.
Ctrl+C stops the frontend and backend started by the script; PostgreSQL stays up.
Local diagnostic addresses are port 4200 for Angular and port 8080 for Go.

```bash
# In another terminal, validate the real database-backed readiness endpoint:
curl --fail http://127.0.0.1:4200/api/health
# Run the frontend and backend checks:
bash scripts/check.sh
# Stop only the development database when finished:
docker stop webdiary-postgres
```

### Development data and configuration

The named Docker volume `webdiary-postgres-data` persists the scaffold database
within the current Docker environment. Its survival across cloud snapshots is not
assumed; `db.sh` recreates an empty schema when needed. Never use it for real diary data.

The development container binds to **127.0.0.1** and uses trust authentication,
without a production password. Any local process can access it. This is solely an
isolated synthetic development configuration. Production/local personal use needs
password authentication, a least-privilege runtime role and a separate migration role.
`DATABASE_URL` can override the backend connection; never commit credentials.
The default `sslmode=disable` is for this local development database only.

Scripts do not reset or delete an existing database. Migration 1 is repeatable.
Avoid reusing the container/volume names for unrelated projects. Go and npm caches
are outside the checkout. Build outputs, environment files, runtime logs and diary
exports are ignored. No GitHub commits or pushes have been made automatically.

## Project layout

```text
frontend/      Angular standalone calendar/editor scaffold and tests
backend/       Echo readiness service, PostgreSQL connection and migration command
migrations/    Versioned SQL (currently 001_initial.sql)
scripts/       Install, database, development and validation commands
docs/          Implementation roadmap and troubleshooting
```

See [the roadmap](docs/roadmap.md) for the PDF milestones and
[troubleshooting](docs/setup.md) for startup failures.
