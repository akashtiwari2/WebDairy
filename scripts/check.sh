#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$WEBDIARY_ROOT/backend"
go test ./...
go vet ./...
cd "$WEBDIARY_ROOT/frontend"
npm test
npm run build
