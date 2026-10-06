# Setup and troubleshooting

Use the existing `/workspace/WebDairy` checkout. Cloud tasks are already isolated;
no additional Git worktree is required.

- **`go version` is a different program:** source `scripts/env.sh`. The system
  `/usr/bin/go` can be an unrelated executable; the checked toolchain is under
  `/workspace/.tools/go/bin`.
- **npm cache permission error:** source `scripts/env.sh`; the scripts direct npm
  to `/workspace/.cache/npm`, not an unwritable user-home directory.
- **Docker unavailable:** start/enable the environment's Docker daemon. No real
  Google credentials or diary secrets are necessary for Phase 1.
- **Port 5432, 8080 or 4200 occupied:** inspect the existing service before stopping
  anything. Do not kill another task's process or remove another task's container.
- **Database unavailable / 503:** run `bash scripts/db.sh` and check the development
  container with `docker exec webdiary-postgres pg_isready -U diary_dev -d diary_dev`.
  The health endpoint requires migration 4, not merely an open database port.
- **Frontend can't contact Go:** start via `scripts/dev.sh` so `/api` uses the proxy.
- **Read backend startup failures:** `.runtime/backend.log` contains Phase 1 logs.
- **Dependency access:** registry.npmjs.org, proxy.golang.org, sum.golang.org,
  dl.google.com, and the Docker registry endpoints are used. TLS and dependency
  integrity verification remain enabled.

To use an external PostgreSQL database, supply `DATABASE_URL` securely and run
`go run ./cmd/diary -migrate` from `backend/` after sourcing `scripts/env.sh`.
The cloud `db.sh` still manages its separate synthetic development container.

## Persistence and migrations

Startup now applies numbered migrations 1–4 once. Migration 2 adds the synthetic
plaintext development table; migration 3 prevents stale updates after deletion and
recreation. Migration 4 retains committed operation identities so delayed creation
retries cannot resurrect deleted entries. Existing encrypted skeleton tables remain
separate. Repeating `db.sh`
does not reset entries. `-migrations` accepts a migration directory (the old
single-file `-migration` flag has been replaced).

If a date cannot load, use **Retry loading** rather than editing an unknown baseline.
A failed save is not Saved; keep the tab open and use Retry. Failed drafts are only
in memory until Phase 2 encrypted draft recovery is implemented. Saved entries survive
ordinary service/container restarts, but the Docker volume is not assumed to survive
cloud snapshot restoration. Publish the updated source/configuration for future
Codex tasks, and never rely on that publication as a diary backup.

Run `bash scripts/test-integration.sh` to verify real PostgreSQL CRUD, idempotent
retries, concurrent update conflicts, delete/recreate safety, and failed-migration
rollback. It provisions a disposable test database rather than modifying diary data.
