#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
# Never test against the caller's personal/external database.
DATABASE_URL='postgres://diary_dev@127.0.0.1:5432/diary_dev?sslmode=disable' bash "$WEBDIARY_ROOT/scripts/db.sh"
test_database="webdiary_test_$(date +%s)_$$"
docker exec webdiary-postgres createdb -U diary_dev "$test_database"
cleanup() { docker exec webdiary-postgres dropdb --force -U diary_dev "$test_database" >/dev/null; }
trap cleanup EXIT
cd "$WEBDIARY_ROOT/backend"
TEST_DATABASE_URL="postgres://diary_dev@127.0.0.1:5432/$test_database?sslmode=disable" go test -race -count=1 -v ./internal/entries -run '^TestPostgresWorkflow$'
