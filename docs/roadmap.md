# Implementation roadmap

The uploaded PDF is a design proposal, not proof of implemented features.
The owner authorized implementation through Phase 3.

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
