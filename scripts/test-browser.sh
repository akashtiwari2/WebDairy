#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
command -v chromium >/dev/null || { echo 'Chromium is required for browser checks.' >&2; exit 1; }
node --input-type=module <<'JS'
import net from 'node:net';
for(const port of [8080,4300,9222]) await new Promise((resolve,reject)=>{
 const server=net.createServer();server.once('error',()=>reject(new Error(`Port ${port} occupied; stop your own app before browser checks.`)));
 server.listen(port,'127.0.0.1',()=>server.close(resolve));
});
JS
DATABASE_URL='postgres://diary_dev@127.0.0.1:5432/diary_dev?sslmode=disable' bash "$WEBDIARY_ROOT/scripts/db.sh"
browser_database="webdiary_browser_$(date +%s)_$$"
browser_temp=$(mktemp -d /tmp/webdiary-browser.XXXXXX)
backend_pid=''; frontend_pid=''; browser_pid=''; database_created=false
cleanup() {
 for pid in "$browser_pid" "$frontend_pid" "$backend_pid"; do
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
 done
 if [[ "$database_created" == true ]]; then docker exec webdiary-postgres dropdb --force -U diary_dev "$browser_database" >/dev/null; fi
 rm -rf "$browser_temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker exec webdiary-postgres createdb -U diary_dev "$browser_database";database_created=true
export DATABASE_URL="postgres://diary_dev@127.0.0.1:5432/$browser_database?sslmode=disable"
cd "$WEBDIARY_ROOT/backend"
go build -o "$browser_temp/diary" ./cmd/diary
"$browser_temp/diary" -migrate
"$browser_temp/diary" >"$browser_temp/backend.log" 2>&1 & backend_pid=$!
cd "$WEBDIARY_ROOT/frontend"
node node_modules/@angular/cli/bin/ng.js serve --host 127.0.0.1 --port 4300 --proxy-config proxy.conf.json >"$browser_temp/frontend.log" 2>&1 & frontend_pid=$!
chromium --headless --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir="$browser_temp/profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank >"$browser_temp/browser.log" 2>&1 & browser_pid=$!
ready=false
for attempt in {1..30}; do
 if ! kill -0 "$backend_pid" "$frontend_pid" "$browser_pid" 2>/dev/null; then echo 'Browser test service exited; see startup logs.' >&2; cat "$browser_temp/backend.log" "$browser_temp/frontend.log";exit 1;fi
 if curl -fsS http://127.0.0.1:4300/api/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1; then ready=true;break;fi
 sleep 1
done
if [[ "$ready" != true ]]; then echo 'Browser test startup timed out.' >&2;exit 1;fi
export WEBDIARY_BROWSER_DATABASE="$browser_database"
export WEBDIARY_BROWSER_BINARY="$browser_temp/diary"
export WEBDIARY_BROWSER_DOWNLOADS="$browser_temp/downloads"
mkdir -p "$WEBDIARY_BROWSER_DOWNLOADS"
cd "$WEBDIARY_ROOT"
node scripts/test-browser.mjs
