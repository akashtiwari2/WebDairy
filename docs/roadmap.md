# Implementation roadmap

The uploaded PDF is a design proposal, not proof of implemented features.
Implementation through Phase 3 is complete. The owner has also requested the
Phase 4 login/backup/restore requirements below; these remain pending.

1. **Phase 1 (implemented):** Angular/Echo/PostgreSQL calendar, sample CRUD,
   autosave, revisions and conflict comparison. Old plaintext development rows
   remain preserved, with no default API access or automatic import.
2. **Phase 2 (implemented):** separate login/session and vault unlock, browser
   AES-256-GCM, pinned Argon2id, verified offline recovery key, rewrapping,
   encrypted pending drafts, manual/automatic lock and one editing tab.
3. **Phase 3 (implemented):** local title/body search and date filters, trash
   comparison/alternate-date restore/permanent deletion, confirmed retention
   cleanup, timezone/theme, month picker/collapsible calendar, encrypted export,
   authenticated import preview, safety backups and transactional replacement.
   Browser checks recreate a disposable database and restore past/Today/future,
   title-only and trashed entries with both passphrase and recovery key.
4. **Phase 4 (next):** Windows launcher/embedded frontend, second-instance handling,
   desktop OAuth/protected tokens, immutable encrypted Google Drive backups,
   automatic retry/retention and packaged second-machine restore.
5. **Phase 5:** accessibility, corruption/failure coverage, release hardening,
   supported-platform validation and documented trusted release.

## Autosave controls (implemented)

Implemented with the writing enhancements below; validated with encrypted-draft
and browser failure/recovery checks.

- [x] Remove the always-visible **Save now** button from normal diary editing.
- [x] Remove **Restore saved text** and its unused handler; it is not version history.
- [x] Keep autosave and clear **Saving… / Saved / Save failed** status feedback.
- [x] Show **Retry save** only when saving fails; retain the draft if retry fails.
- [x] Keep conflict comparison/resolution, encrypted draft recovery and delete/trash
      controls available. Removing editor buttons must not remove these safeguards.
- [x] Verify successful autosave, failed-save retry and draft preservation; check
      desktop/mobile layout with the simplified controls.

## Replanned writing enhancements (implemented before Phase 4)

The owner prioritized these local features before Google OAuth/Drive packaging.

- [x] Offline local writing without internet; encrypted drafts during an unlocked
      backend outage and automatic pending-save retry after backend recovery.
      Reopen/unlock still requires the local services; this is not a standalone PWA.
- [x] Current/best streak and written-day count from saved entry dates, with a
      Settings option to hide it. Exclude future dates, trash and unconfirmed drafts.
- [x] Optional encrypted mood/tags, local mood/tag search filters and metadata
      preservation through draft recovery, trash, encrypted backup and restore.
- [x] Backup health: last full browser backup, missing/overdue/new-change state,
      storage errors and a clear distinction from emergency exports/off-device copies.
- [x] Simplify autosave controls and validate encrypted recovery and responsive UI.

Details and practical offline limits: [writing guide](writing.md).
Next: Phase 4 Google login, protected desktop lifecycle, scheduled Drive backups
and new-device restore discovery. Photos, reminders and simultaneous-device sync
are not included in this feature batch.

## Phase 4: requested Google login and scheduled backups (pending)

These requirements are recorded for future implementation; Google login and
scheduled Drive backups are not available in the current app.

- [ ] Add **Sign in with Google** using desktop OAuth, verified Google identity
      and protected local sessions. Google login must work without creating a
      separate WebDairy login password. Plan migration for existing local owners.
- [ ] Request Google Drive backup permission separately from sign-in; signing in
      alone must not require Drive access. Store OAuth tokens in protected OS storage.
- [ ] Offer **Daily / Weekly / Monthly / Manual** backup frequency in settings.
- [ ] Automatically upload immutable encrypted snapshots when the app is running,
      the vault is unlocked and backup is due. Catch up on a missed backup at the
      next suitable startup/unlock; do not promise backups while the app is closed.
- [ ] Retry failed uploads and show backup progress, last successful backup time
      and actionable errors. Configure backup retention without overwriting the
      last known good backup during a failed upload.
- [ ] On a new device, after signing into the same Google account and granting
      Drive access, discover available WebDairy backups and show **Restore** with
      backup dates. Handle no backup, revoked permission and offline states clearly.
- [ ] Restore only after the user chooses a backup and provides that backup's
      vault passphrase or recovery key. Google sign-in alone cannot decrypt it.
- [ ] If the device already has a diary, require explicit replacement confirmation
      and a verified safety backup. Reuse authenticated preview and transactional
      replacement so invalid backups or failed restores preserve the current diary.
- [ ] Validate sign-in, permission denial/revocation, scheduled backup/retry and
      new-device restore on supported Windows/Mac devices, including both unlock keys.

This is backup and restore between devices, not simultaneous multi-device editing
or automatic merging. Keep Google login, Drive permission and vault unlock distinct
in the interface.

Defaults: Asia/Kolkata, one owner/vault, one active computer/browser origin,
immutable random record IDs, one active entry per civil date, one-second autosave,
five-minute auto-lock and 30-day trash minimum. Local backup is manual; browser
copies stay until removal, server replacement history retains the latest three.
Expired trash is removed only after an explicit unlocked confirmation.
No hosting, AI or multi-device synchronization is implied. No Google credentials
are required for Phase 3.

Validation is development evidence, not a security audit. Production least-privilege
DB setup, desktop packaging, actual Windows/Mac hardware acceptance and automatic
cloud backup remain outstanding. See security.md for practical limits.
