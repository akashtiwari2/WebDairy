# Google login, Drive backups and desktop setup

Google integration is optional. Local password login and encrypted .diary files
continue to work without Google. Never send Google passwords, client secrets,
OAuth tokens or vault/recovery keys in chat or commit them to Git.

## Create your OAuth client (first time)

1. Open https://console.cloud.google.com/ and create/select a project for WebDairy.
2. Enable **Google Drive API** in APIs & Services → Library.
3. Open **Google Auth Platform** (or OAuth consent screen), set your app name and
   support email. For personal development choose External / Testing and add your
   own Google email under Test users. Configure the scopes `openid`, `email` and
   `https://www.googleapis.com/auth/drive.appdata`.
4. In Clients / Credentials create an **OAuth client ID → Desktop app**. Download
   its JSON and keep it private. Use this same client/project on each device so
   Google's private app-data folder contains the same backups. A web application
   client with arbitrary browser redirect settings is not this desktop flow.
5. In a browser package, stop WebDairy and open **Setup-WebDairy**. Enter the
   PostgreSQL connection, expand **Google connection**, and paste both `client_id`
   and `client_secret` from the downloaded JSON. Connect and open the diary. These
   settings are saved locally; users do not need Go/Node or manual `.env` editing.
   In a source checkout instead, add the values to your local `backend/.env`
   (not your Google password):

   ```dotenv
   GOOGLE_CLIENT_ID=YOUR_DESKTOP_CLIENT_ID.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=YOUR_DESKTOP_CLIENT_SECRET
   ```

6. For a source checkout, restart the backend: `go run ./cmd/diary`. Migration 7 is automatic. Keep the
   frontend running with `npm start`, using `http://127.0.0.1:4300` consistently.
   The backend OAuth callback is `http://127.0.0.1:47831/api/google/callback`.
7. Allow the Google sign-in popup. A successful callback says to close that window;
   WebDairy polls for completion and updates automatically.

Google's External/Testing mode and app verification policies can limit who signs
in and how long Drive refresh tokens last (often seven days for testing apps with
Drive scopes). Reconnect if permission expires. Publishing/verification is a
separate Google Console decision; this project does not publish your OAuth app.

## Existing diary versus new device

For an existing diary, log in normally, open Settings and **Connect Google account**.
This binds the verified Google subject, not an email string, to the local owner.
A different Google account cannot replace it. The original local password remains
available. On later visits use **Continue with Google**, then unlock the vault.

For an empty database, **Continue with Google** first. Choose a vault passphrase,
save/verify the recovery key and create the diary without a separate login password.
Alternatively connect Drive and restore an existing backup before creating a vault.
Google sign-in cannot decrypt diary content. To cold-start without internet after
a Google session expires, optionally enable an **offline login password** in Settings.
Google login and Drive discovery require internet; local writing remains offline.

## Drive permission and schedules

Open Backups → **Enable Google Drive backup**. This is a separate consent flow;
login alone does not request Drive access. Tokens remain on the backend and are
stored only in Windows Credential Manager, macOS Keychain or Linux Secret Service.
No plaintext file/database/localStorage fallback exists. A locked/unavailable
credential store prevents connection; unlock it and retry. Headless Linux without
a working Secret Service cannot enable persistent Drive tokens.

Choose Manual, Daily (24 hours), Weekly (7 days) or Monthly (30 days), and keep 3–100
backups (default 30). Scheduled backups run while the app is open, logged in and
unlocked. Manual creates no new scheduled backups; already-pending uploads still
retry while connected/unlocked. Missed scheduled backups catch up after unlock. The UI shows progress, errors and
last successful **snapshot time**. Uploads first save drafts, obtain a consistent
snapshot and encrypt it in the browser. Local encrypted pending copies survive
restart. Retries reuse the same operation/archive; Drive's checksum verifies
transfer. Retention runs only after a verified upload and only for that vault's
files. Reconnect Drive after revoked/expired permission. Disconnect removes this
device's stored tokens; existing Drive backups are preserved. You may also revoke
access in your Google account's security settings.

Files live in Google's private `appDataFolder`, not your regular Drive file list.
No decrypted dates, mood, tags, diary text or vault keys are sent to Google. Public
backup metadata includes vault ID, random operation/file ID, size and snapshot time.
This is encrypted snapshot backup, not concurrent multi-device synchronization.

## Restore on another device

1. Use the same OAuth client/project, start the app with an empty local database
   and sign into the same Google account.
2. Connect Drive backup permission. **Restore available** lists backup timestamps.
3. Select a backup and provide that backup's vault passphrase or recovery key.
4. Review the authenticated preview and explicitly confirm restore. With a verified
   Google login, a fresh device does not ask for a new local login password.
5. If a diary already exists, unlock it and save/confirm a safety backup first.
   Replacement is transactional; failed validation does not erase the diary.

Older backups may need their historical passphrase/recovery key. Keep an offline
recovery key and a separate downloaded encrypted file even when using Drive.

## Desktop launcher and embedded UI

On a build machine with Node, Go and installed frontend dependencies:

```bash
node scripts/package.mjs windows-amd64
node scripts/package.mjs darwin-arm64
```

Other targets: windows-arm64, darwin-amd64, linux-amd64. Output is in
`release/<target>/`: executable, launcher, .env.example and setup guide. Angular
assets and numbered migrations are embedded in the executable; runtime Node/Go
and external SQL files are not required. PostgreSQL must still be installed and
running on the user's machine. The first-run browser form saves the connection locally;
set your own database and optional OAuth client, then run Start-WebDairy.

The app opens `http://127.0.0.1:47831`; a second launcher opens the existing browser
instance. Port conflicts report an error instead of stopping unrelated services.
Keep its process running. Save/export old drafts before switching from port 4300:
browser cookies/IndexedDB are tied to the browser origin. Committed database
content is retained when using the same DATABASE_URL.

These are unsigned development builds. Signing/notarization, installer distribution,
a real Google-account end-to-end trial and actual Windows/macOS hardware acceptance
remain release validation tasks; mock-provider/cross-compilation checks are not
proof of those external/platform checks.

Daily use, first-run PostgreSQL setup, settings storage, launcher shortcuts and moving laptops: [daily-use guide](daily-use.md). No Tauri or native desktop window is used.
