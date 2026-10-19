#!/usr/bin/env bash
# Disposable Linux acceptance for the cross-platform browser package.
set -euo pipefail
source "$(dirname "$0")/env.sh"
command -v chromium >/dev/null
node --input-type=module <<'JS'
import net from 'node:net';
for (const port of [47831,9222]) await new Promise((resolve,reject)=>{
 const s=net.createServer();s.once('error',()=>reject(Error(`Port ${port} occupied; stop your own app first.`)));s.listen(port,'127.0.0.1',()=>s.close(resolve));
});
JS
DATABASE_URL='postgres://diary_dev@127.0.0.1:5432/diary_dev?sslmode=disable' bash "$WEBDIARY_ROOT/scripts/db.sh"
# Build only when requested; this check otherwise tests the produced archive/binary.
if [[ ! -x "$WEBDIARY_ROOT/release/linux-amd64/WebDairy" ]]; then node "$WEBDIARY_ROOT/scripts/package.mjs" linux-amd64; fi
launch_database="webdiary_launcher_$(date +%s)_$$"
launch_temp=$(mktemp -d /tmp/webdiary-launcher.XXXXXX)
server_pid='';browser_pid=''
cleanup() {
 for pid in "$browser_pid" "$server_pid"; do
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true;wait "$pid" 2>/dev/null || true;fi
 done
 docker exec webdiary-postgres dropdb --force --if-exists -U diary_dev "$launch_database" >/dev/null
 docker exec webdiary-postgres dropdb --force --if-exists -U diary_dev "${launch_database}_other" >/dev/null
 rm -rf "$launch_temp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' 'DATABASE_URL=postgres://diary_dev@127.0.0.1:1/missing?sslmode=disable' 'CUSTOM_SETTING=retained' >"$launch_temp/.env"
chmod 600 "$launch_temp/.env"
docker exec webdiary-postgres createdb -U diary_dev "${launch_database}_other"
docker exec webdiary-postgres psql -U diary_dev -d "${launch_database}_other" -c "CREATE TABLE schema_migrations(version integer); CREATE TABLE synthetic_other_data(value text); INSERT INTO synthetic_other_data VALUES('keep me');" >/dev/null
export WEBDIARY_LAUNCH_CONFIG="$launch_temp/.env"
export WEBDIARY_LAUNCH_DATABASE="$launch_database"
export WEBDIARY_LAUNCH_BINARY="$WEBDIARY_ROOT/release/linux-amd64/WebDairy"
export WEBDIARY_LAUNCH_SCREENSHOTS="$WEBDIARY_ROOT/.runtime/screenshots"
mkdir -p "$WEBDIARY_LAUNCH_SCREENSHOTS"
# No flags selecting browser mode: packaged binary defaults must work on double-click.
env -u DATABASE_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET "$WEBDIARY_LAUNCH_BINARY" -env "$WEBDIARY_LAUNCH_CONFIG" >"$launch_temp/server.log" 2>&1 & server_pid=$!
chromium --headless --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir="$launch_temp/profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 about:blank >"$launch_temp/browser.log" 2>&1 & browser_pid=$!
ready=false
for attempt in {1..30};do
 if ! kill -0 "$server_pid" "$browser_pid" 2>/dev/null;then cat "$launch_temp/server.log";exit 1;fi
 if curl -fsS http://127.0.0.1:47831/setup/status >/dev/null 2>&1 && curl -fsS http://127.0.0.1:9222/json >/dev/null 2>&1;then ready=true;break;fi
 sleep 1
done
[[ "$ready" == true ]] || { echo 'Launcher startup timed out.' >&2;exit 1; }
node "$WEBDIARY_ROOT/scripts/test-launcher.mjs"
# Stop and restart from an unrelated directory with saved config: data and settings persist.
kill "$server_pid";wait "$server_pid" 2>/dev/null || true;server_pid=''
cd "$launch_temp"
env -u DATABASE_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET "$WEBDIARY_LAUNCH_BINARY" -env "$WEBDIARY_LAUNCH_CONFIG" >"$launch_temp/restart.log" 2>&1 & server_pid=$!
ready=false
for attempt in {1..30};do
 if ! kill -0 "$server_pid" 2>/dev/null;then cat "$launch_temp/restart.log";exit 1;fi
 if curl -fsS http://127.0.0.1:47831/api/health >/dev/null 2>&1;then ready=true;break;fi
 sleep 1
done
[[ "$ready" == true ]] || { echo 'Saved-config restart timed out.' >&2;exit 1; }
env -u DATABASE_URL -u GOOGLE_CLIENT_ID -u GOOGLE_CLIENT_SECRET "$WEBDIARY_LAUNCH_BINARY" -env "$launch_temp/nonexistent.env" >"$launch_temp/second.log" 2>&1
[[ "$(docker exec webdiary-postgres psql -U diary_dev -d "$launch_database" -At -c 'SELECT count(*) FROM schema_migrations')" == '7' ]]
[[ "$(docker exec webdiary-postgres psql -U diary_dev -d "$launch_database" -At -c 'SELECT count(*) FROM entries WHERE ciphertext IS NOT NULL')" == '1' ]]
[[ "$(docker exec webdiary-postgres psql -U diary_dev -d "${launch_database}_other" -At -c "SELECT value FROM synthetic_other_data")" == 'keep me' ]]
echo 'PASS: browser package first-run PostgreSQL setup, saved-config restart, embedded migrations, data retention and second-instance reuse.'
