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

Phase 3 additionally checks local search/date filters without network queries,
occupied-date trash comparison and alternate restore, permanent purge, title-only
Today, timezone/theme, encrypted file downloads and retained trash. It confirms
invalid-file/wrong-key preservation, emergency export during an outage, safety-storage
failure blocking replacement, stale-safety rejection, lost-success restore
retry and pre-replacement copy retention. It then **recreates only its uniquely
named disposable database twice** and restores from the downloaded file with
passphrase and recovery independently, choosing new local logins and comparing
all restored dates/text/trash/preferences. Temporary downloads are removed on exit.
SQL integration injects a failure after replacement starts and verifies full rollback;
it also checks stage binding/expiry, new epochs and tombstone resurrection protection.

The layout checks verify a six-week calendar fits desktop windows at 1440×900,
1366×768 and 1024×650 without page or horizontal overflow, while retaining a usable
editor and visible save controls. Settings occupies its own view. Long diary text
scrolls inside the editor; narrow/mobile and expanded forms can use normal page
scrolling so controls remain reachable.

The writing enhancements additionally verify encrypted mood/tags in API records
and clean-database restore with both keys, durable drafts and automatic backend
reconnection, the streak visibility setting, backup-health state and removal of
normal editor save/restore buttons. Unit tests cover civil-date/leap-day streaks,
future-date exclusion, private metadata limits, local filters and backup age/source
classification, including record removal/revision changes.

Phase 4 adds OAuth/Drive mock-provider and disposable PostgreSQL checks for verified
subject/PKCE/replay, separate scopes, OS-store failure, token isolation, explicit
Google/local setup mode, offline password setup, idempotent encrypted uploads and
Google-backed fresh restore. Frontend tests cover schedules, durable upload retry,
blocked/isolated popups and callback-cookie timing. Desktop smoke validation uses
a packaged Linux executable from an unrelated working directory, embedded SQL,
second-instance reuse and a production-CSP browser encryption/recovery workflow.
Windows/macOS cross-compilation is build evidence; live OAuth/OS acceptance remains
manual after configuring the client described in google-setup.md.

## Packaged launcher acceptance

After `node scripts/package.mjs linux-amd64`, `bash scripts/test-launcher.sh`
uses only disposable synthetic PostgreSQL databases and a temporary browser
profile/config. It tests unavailable storage, rejection/preservation of another
app's database (including an unrelated migration marker), first-run database
creation, saved configuration, embedded migrations, CSP-compatible production
CSS/Argon2, recovery verification, encrypted autosave/mood/tags, focused unlock,
viewport fit, restart with retained data and second-instance reuse. Screenshots
are written under ignored `.runtime/screenshots`. It does not test real Google
accounts or execute Windows/Mac binaries on those operating systems.
