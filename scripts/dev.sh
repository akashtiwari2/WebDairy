#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/env.sh"
node --input-type=module <<'JS'
import net from 'node:net';
for (const port of [8080, 4200]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Local port ${port} is occupied. Check the existing service before stopping anything.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
JS
"$WEBDIARY_ROOT/scripts/db.sh"
mkdir -p "$WEBDIARY_ROOT/.runtime"
cd "$WEBDIARY_ROOT/backend"
go build -o bin/diary ./cmd/diary
./bin/diary >"$WEBDIARY_ROOT/.runtime/backend.log" 2>&1 &
backend_pid=$!
frontend_pid=''
cleanup() {
 if [[ -n "$frontend_pid" ]]; then kill "$frontend_pid" 2>/dev/null || true; fi
 kill "$backend_pid" 2>/dev/null || true
 wait "$backend_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ready=false
for attempt in {1..20}; do
 if ! kill -0 "$backend_pid" 2>/dev/null; then cat "$WEBDIARY_ROOT/.runtime/backend.log"; exit 1; fi
 if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then ready=true; break; fi
 sleep 1
done
if [[ "$ready" != true ]]; then echo 'Backend readiness failed.' >&2; exit 1; fi
cd "$WEBDIARY_ROOT/frontend"
# Invoke the local CLI directly so the tracked PID owns the server.
node node_modules/@angular/cli/bin/ng.js serve --host 127.0.0.1 --port 4200 --proxy-config proxy.conf.json &
frontend_pid=$!
wait "$frontend_pid"
