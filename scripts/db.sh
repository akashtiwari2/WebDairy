#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
# Trust authentication is ONLY for the loopback-bound synthetic development DB.
if docker container inspect webdiary-postgres >/dev/null 2>&1; then
 if [[ "$(docker inspect -f '{{ index .Config.Labels "webdiary.environment" }}' webdiary-postgres)" != "development" ]]; then
  echo 'Container name is already used by another application.' >&2; exit 1
 fi
 docker start webdiary-postgres >/dev/null
else
 docker run -d --name webdiary-postgres --label webdiary.environment=development \
  -e POSTGRES_USER=diary_dev -e POSTGRES_DB=diary_dev -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:5432:5432 -v webdiary-postgres-data:/var/lib/postgresql \
  postgres:18@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf >/dev/null
fi
ready=false
for attempt in {1..30}; do
 if docker exec webdiary-postgres pg_isready -U diary_dev -d diary_dev >/dev/null 2>&1; then ready=true; break; fi
 sleep 1
done
if [[ "$ready" != true ]]; then echo 'Development PostgreSQL did not become ready.' >&2; exit 1; fi
cd "$WEBDIARY_ROOT/backend"
go run ./cmd/diary -migrate
