# WebDairy: daily use in your browser

WebDairy keeps PostgreSQL. This version uses a browser window, with a small local
program running behind it. There is no Tauri/native window and no hosted database.
The launcher includes the frontend and migrations; running a package does not need
Go, Node, npm or pgAdmin. PostgreSQL and a current browser are required.

## Install once (Windows or Mac)

1. Install PostgreSQL if you do not already have it. Note its username, password
   and port. Keep the PostgreSQL service running; pgAdmin is optional and can be closed.
2. Extract the package for your computer. Windows uses `Start-WebDairy.cmd` or
   `WebDairy.exe`. Mac uses `Start-WebDairy.command` (Apple Silicon: darwin-arm64;
   Intel: darwin-amd64). Keep the executable and shortcuts together.
3. Open Start-WebDairy. Your default browser opens automatically at
   `http://127.0.0.1:47831`. Keep the launcher/terminal window running.
4. On first use, enter your PostgreSQL username, password, diary database name
   and (if different) port in the browser setup form. The password is your
   PostgreSQL password, not your diary or Google password. WebDairy URL-encodes
   special password characters for you.
5. Enable **Create this database if it does not exist** for a new diary. An account
   with database-creation permission is required; otherwise create the separate
   empty database once using your PostgreSQL administrator and uncheck this option.
   Existing WebDairy data is retained. Databases already used by another app are
   rejected unless they have WebDairy's migration marker and diary tables. No other databases or
   PostgreSQL services are deleted, stopped or reconfigured.
6. Choose **Start a new diary**, or **Restore my diary** for an existing backup.
   Google connection setup is optional, but needed for Google sign-in and Drive.
   See [Google setup](google-setup.md). Without it you can write locally and use
   downloaded encrypted backup files.
7. Save and verify your recovery key outside the app during new-diary setup.
   The diary password protects your writing; the recovery key is your way back
   if you forget that password. Local password mode also has a separate app login.

This is an unsigned development package, not a signed installer. OS trust/signing
and live Windows/Mac/Google acceptance remain pending. Do not bypass organizational
security controls to run it. A Mac downloaded command may need its execute permission
restored; package archives preserve that permission where the extraction tool supports it.

## Every day

Open **Start-WebDairy**, log in if needed, unlock with your diary password and write.
The app opens Today; use the calendar for another date. Text saves automatically.
Wait for **Saved** before closing. Long writing scrolls inside the editor on desktop.
Mood and tags are optional. Search, Trash, Backups and Settings are separate tools.

Closing the browser tab does not stop the local program. You can open the shortcut
again to reopen the existing instance. **Ctrl+C** or closing the launcher window
stops WebDairy; save first. PostgreSQL must stay running. Browser window closure,
computer shutdown and a locked diary do not run new scheduled backups.

No internet: saved local writing and an existing local session/offline login can
continue, but Google sign-in and Drive transfers need internet. On a Google-only
account enable an optional offline login password in Settings before you need to
sign in without internet. This does not replace the diary encryption password.
An unlocked diary can retain encrypted drafts during a local storage/backend
outage and retry when it returns. Reopening/unlocking requires working local services.

## Connect automatic backup

- Existing diary: log in normally → Settings → **Connect Google account**.
- Backups → **Enable Google Drive backup** → approve Google's permission.
- New preferences default to **Daily**. Existing frequency choices (including
  manual) are kept; change to Daily/Weekly/Monthly in Backups if desired.
- The app checks every 30 seconds while open/unlocked. A due or failed backup
  retries; an already-pending upload retries even in manual mode.
- **Back up now** before changing laptops. Wait for successful confirmation.
  **Saved** means local saving, not a completed Google Drive backup.

Local backup files and browser-only copies are under **Backup files on your computer**;
retention/reconnect/disconnect are under **Backup settings**. Browser copies are not
an off-device backup. Google Drive app-data backups do not appear in the normal
Drive file browser. Keep the same Google OAuth project/client on every laptop.

## Move to another laptop (one laptop at a time)

1. On the old laptop, wait for Saved, then Backups → Back up now. Wait for success.
2. On the new laptop install PostgreSQL and the same WebDairy package, then complete
   its one-time local connection setup. Use the same Google client/project.
3. Continue with Google → Restore my diary → Find my backup → allow Drive access.
   WebDairy lists available backups and selects the newest snapshot by default.
4. Enter that backup's diary password (or choose its recovery key), verify and
   confirm Restore my diary. The app never replaces an existing diary silently.
5. If a diary already exists here, unlock it and download a safety copy before
   confirming replacement. After restore, write on this laptop.

This is backup/restore, not live merging. A new laptop only receives the last
successful backup; writing after that snapshot is not covered until another backup.

## Settings, upgrades and troubleshooting

Connection settings are saved locally, with private file permissions where the OS
supports them, in the user's settings folder:

- Windows: `%APPDATA%\WebDairy\.env`
- Mac: `~/Library/Application Support/WebDairy/.env`
- Linux: `$XDG_CONFIG_HOME/WebDairy/.env` or `~/.config/WebDairy/.env`

An existing `.env` beside the executable is still supported and takes priority.
An explicit `-env PATH` overrides the default file. Nonempty process environment variables
still override file values; setup does not silently replace those overrides.
Database credentials are local config, not encrypted diary content. Never share the
file or include it in a package. Settings files never render their saved passwords.

To change the database/Google client, stop WebDairy and open **Setup-WebDairy**.
Enter the PostgreSQL connection and optionally both Google client fields. Leaving
the Google fields blank keeps the saved Google configuration. Valid changes are
saved only after the selected database has connected and migrations have succeeded.
No passwords are embedded in browser HTML, printed to logs or included in packages.

To upgrade, stop WebDairy, extract the new package and start it. User-folder settings
and PostgreSQL diary data stay in place. If using the legacy portable `.env`, keep
that private file alongside the new executable yourself.

When upgrading from the old port 8080 to 47831, first wait for **Saved** or export
pending writing in the old app. Browser drafts and login cookies belong to a
specific port and are not moved automatically. Saved PostgreSQL entries stay in
the database; open the new address and log in/unlock again.

If storage could not start, start PostgreSQL and click **Try saved connection again**.
A wrong PostgreSQL password has its own message. The app does not auto-start/kill an
unknown PostgreSQL service; Windows Services, Postgres.app, Homebrew and other
installations use different management tools. Configure your chosen installation
once to start at login/boot if desired.

**Reset-login** changes only the app login password and revokes sessions; it does not
unlock encrypted writing or change the diary password. Keep your recovery key safe.
Use one consistent browser/profile and 127.0.0.1 hostname. Development port 4300
has separate browser draft storage from packaged port 47831: save/export pending
writing before switching. Saved PostgreSQL entries remain in the same database.
