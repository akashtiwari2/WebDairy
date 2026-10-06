# Setup and troubleshooting

Use the existing `/workspace/WebDairy` checkout. Cloud tasks are already isolated;
no additional Git worktree is required.

- **`go version` is a different program:** source `scripts/env.sh`. The system
  `/usr/bin/go` can be an unrelated executable; the checked toolchain is under
  `/workspace/.tools/go/bin`.
- **npm cache permission error:** source `scripts/env.sh`; the scripts direct npm
  to `/workspace/.cache/npm`, not an unwritable user-home directory.
- **Docker unavailable:** start/enable the environment's Docker daemon. No real
  Google credentials or diary secrets are necessary for the scaffold.
- **Port 5432, 8080 or 4200 occupied:** inspect the existing service before stopping
  anything. Do not kill another task's process or remove another task's container.
- **Database unavailable / 503:** run `bash scripts/db.sh` and check the development
  container with `docker exec webdiary-postgres pg_isready -U diary_dev -d diary_dev`.
  The health endpoint requires migration 1, not merely an open database port.
- **Frontend can't contact Go:** start via `scripts/dev.sh` so `/api` uses the proxy.
- **Read backend startup failures:** `.runtime/backend.log` contains scaffold logs.
- **Dependency access:** registry.npmjs.org, proxy.golang.org, sum.golang.org,
  dl.google.com, and the Docker registry endpoints are used. TLS and dependency
  integrity verification remain enabled.

To use an external PostgreSQL database, supply `DATABASE_URL` securely and run
`go run ./cmd/diary -migrate` from `backend/` after sourcing `scripts/env.sh`.
The cloud `db.sh` still manages its separate synthetic development container.
