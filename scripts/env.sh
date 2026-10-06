#!/usr/bin/env bash
# Source this file; caches and tool installation stay inside the writable workspace.
WEBDIARY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/workspace/.tools/go/bin:$PATH"
export GOPATH=/workspace/.cache/go
export GOCACHE=/workspace/.cache/go-build
export GOMODCACHE=/workspace/.cache/go-mod
export npm_config_cache=/workspace/.cache/npm
export NG_CLI_ANALYTICS=false
export DATABASE_URL="${DATABASE_URL:-postgres://diary_dev@127.0.0.1:5432/diary_dev?sslmode=disable}"
