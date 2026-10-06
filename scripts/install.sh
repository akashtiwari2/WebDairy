#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p /workspace/.tools "$GOCACHE" "$GOMODCACHE" "$npm_config_cache"
if [[ ! -x /workspace/.tools/go/bin/go ]] || [[ "$(/workspace/.tools/go/bin/go version)" != *"go1.27.1 "* ]]; then
 archive=$(mktemp /tmp/webdiary-go.XXXXXX.tar.gz)
 trap 'rm -f "$archive"' EXIT
 curl -fsSL https://dl.google.com/go/go1.27.1.linux-amd64.tar.gz -o "$archive"
 printf '%s  %s\n' '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445' "$archive" | sha256sum -c -
 tar -xzf "$archive" -C /workspace/.tools
fi
node -e 'const [m,n,p]=process.versions.node.split(".").map(Number); if (m!==24 || n<15) {throw Error("Node 24.15+ required; validated with 24.19.0")}'
cd "$WEBDIARY_ROOT/frontend"
npm ci --no-audit --no-fund
npm run build
cd "$WEBDIARY_ROOT/backend"
go mod download
go mod verify
go build -o bin/diary ./cmd/diary
# Docker images and containers can need recreation on a fresh task.
docker pull postgres:18@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf
