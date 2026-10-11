# Reproducing browser checks

The check uses Chromium DevTools Protocol and Node's built-in WebSocket; no remote
browser service or extra automation dependency is required. It runs only against
fresh disposable data and refuses an already initialized vault.

Run `bash scripts/test-browser.sh` on the Linux cloud environment with Chromium,
Docker, Node and the installed project dependencies available. Ports 8080, 4200 and
9222 must be free. The runner creates a unique test database/profile, starts its own
app/browser processes, and removes only those resources on exit. It never uses a
personal DATABASE_URL or the ordinary diary database.

Coverage: first setup/offline recovery verification, encrypted API and IndexedDB
inspection, wrong passphrase, second-tab exclusion, offline draft lock/reload recovery,
passphrase change, recovery rotation and recovery with old/new secrets, five-minute
auto-lock, storage failure preventing unsafe lock, login change/relogin, and ciphertext
tampering blocking opening. Test secrets and recovery keys stay in test-process RAM;
only check results and non-secret timing are printed.

`test-browser.mjs` relies on Angular's development inspection API for deterministic
fault injection. It is test tooling, not part of the app bundle or the packaged release.
Unit checks separately cover lost-success responses, current-text preservation,
revision conflict choice, published AES-GCM known-answer and cross-implementation
Argon2id compatibility. PostgreSQL integration checks cover transactions, session
expiry/revocation, throttling, opaque storage and migration rollback with race detection.
