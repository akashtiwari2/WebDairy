# WebDairy

A personal diary being built with Angular, Go Echo and PostgreSQL, following the
owner-supplied `Diary_App_Detailed_Plan.pdf`.

## Current milestone: Phase 1 persistent sample diary

- Calendar, Today, date picker and plain-text title/editor for past, present and future dates.
- PostgreSQL create/read/update/delete with one active entry per civil date.
- One-second autosave, Save now, and Unsaved / Saving / Saved / Save failed states.
- Serialized saves per date, retained in-tab drafts on failure, bounded retries and unload warning.
- Revision conflicts preserve the draft and show the saved version for an explicit choice.
- Saved-day markers, title-only entries, leap-day support and midnight-safe navigation.
- Explicit deletion. Clearing text never silently deletes an entry. Deleted sample content is
  removed; date/revision tombstones prevent stale editors overwriting a recreated entry.

**Sample text only. Phase 1 stores plaintext in `development_entries`.** The
separate `vaults`/`entries` schema is reserved for encrypted Phase 2 storage. Login,
browser encryption, encrypted pending-draft recovery, trash, export/restore, Google
Drive and Windows packaging are not implemented. This is not ready for private diary use.

Saved means PostgreSQL confirmed a committed write. Confirmed entries survive browser
refresh and application/database restart. Unconfirmed text stays only in this tab:
if you close/refresh before confirmation, it can be lost. The unload warning is best-effort and browsers may suppress it. Nothing writes plaintext
pending drafts or keys to localStorage/IndexedDB. Cloud snapshot restoration of the
Docker data volume is not promised.

## Cloud development quick start

Validated: Node **24.19.0**, npm **11.9.0**, Angular CLI **22.2.1**, Go **1.27.1**,
PostgreSQL **18** (pinned Docker image digest). Docker and Linux amd64 are required
by the cloud scripts. Use the existing isolated checkout; no Git worktree is needed.

```bash
cd /workspace/WebDairy
bash scripts/install.sh
bash scripts/dev.sh
```

`install.sh` uses checksum-verified Go, `npm ci`, Go module verification, and builds
both components. `dev.sh` starts/reuses the labelled database, applies all pending
migrations, waits for readiness and runs Angular with its same-origin `/api` proxy.
Ctrl+C stops the frontend/backend started by the script; PostgreSQL remains running.
Local diagnostic ports: Angular 4200, Go 8080. Routine setup does not commit or push.

```bash
curl --fail http://127.0.0.1:4200/api/health
bash scripts/check.sh             # Go unit checks/vet + Angular tests + build
bash scripts/test-integration.sh  # Real PostgreSQL tests in a disposable database
```

The integration runner creates and drops only its uniquely named synthetic test database.
Without `TEST_DATABASE_URL`, the PostgreSQL integration test is explicitly skipped by
the unit command; run the integration script for that coverage.

## Writing and failure handling

Select any date and enter a title/body. After one idle second, autosave submits a
snapshot; newer edits are saved after its acknowledgement. Navigation requests an
immediate save while retaining each date's draft in memory. A saved-day dot means a
confirmed stored entry, not merely an unsaved draft.

If loading fails, editing is disabled until **Retry loading** obtains the baseline.
If saving fails, text remains in the tab, with three bounded automatic retries and an eight-second request timeout and
**Retry save**. The same operation ID makes retrying a lost response idempotent.
An entry changed/deleted in another tab produces a conflict: compare the saved
version, then confirm either using it or saving your draft over the compared revision.
Another concurrent change still conflicts. Retry never silently chooses a version.

Title limit: 200 Unicode characters; body limit: 1 MiB UTF-8; JSON request cap: 2 MiB.
Empty visits create no rows. Title-only entries are valid. To clear an existing entry,
use confirmed **Delete entry**, or **Restore saved text** to undo the local clearing.
Deletion is not trash in Phase 1. Database operational timestamps use UTC, and civil
diary dates remain unchanged when reopened. Today uses Asia/Kolkata.

## Development configuration

The local database container binds **127.0.0.1** and uses trust authentication solely
for synthetic development data. Any local process can access it. The API requires
loopback Host and matching Origin on JSON writes; it has no account authentication.
Before personal use, Phase 2 must add encryption, authentication and least-privilege roles.

`DATABASE_URL` optionally overrides the backend connection; never commit credentials.
The default local connection has `sslmode=disable` because this container is local.
The named volume `webdiary-postgres-data` persists container restarts in this Docker
environment. Do not assume cloud publication backs it up; do not use it for real data.

Migrations 1–4 are transactionally applied once under a PostgreSQL advisory lock.
Scripts never reset the database. Generated outputs, `.env` files, logs and diary
exports are ignored; caches and tools stay outside the checkout.

## Layout and further work

```text
frontend/      Angular calendar/editor, per-date autosave service and tests
backend/       Echo API, PostgreSQL repository, migration runner and tests
migrations/    Numbered SQL; encrypted skeleton and synthetic development tables
scripts/       Install, database, startup, unit/build and isolated integration checks
docs/          API contract, implementation roadmap and troubleshooting
```

See [Phase 1 API](docs/api.md), [roadmap](docs/roadmap.md) and
[setup troubleshooting](docs/setup.md).
