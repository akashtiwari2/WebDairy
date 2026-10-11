# Implementation roadmap

The uploaded PDF is a design proposal, not proof of implemented features.
The owner authorized starting from an empty repository and continuing to Phase 2.

1. **Phase 1 (implemented):** Angular/Echo/PostgreSQL, calendar, sample CRUD,
   autosave, revisions and conflict comparison. The old plaintext development
   tables remain preserved, with no default API access or automatic import.
2. **Phase 2 (implemented):** distinct login/session and vault-unlock flows,
   browser AES-256-GCM, pinned Argon2id, verified offline recovery key, rewrapping,
   encrypted IndexedDB pending drafts, manual/automatic lock and one editing tab.
   Encrypted trash state is stored; browsing/restoring trash is next.
3. **Phase 3 (next):** local search, trash browser/retention, timezone/theme,
   versioned encrypted export/import and transactional restore. Rehearse
   past/today/future restoration with both passphrase and recovery before private use.
4. **Phase 4:** Windows launcher/embedded frontend, second-instance handling,
   desktop OAuth and protected tokens, immutable encrypted Google Drive backups,
   retry/retention and second-machine restore.
5. **Phase 5:** accessibility, corruption/failure coverage, release hardening,
   supported-platform validation and documented trusted release.

Defaults: Asia/Kolkata, one owner/vault, one active computer/browser origin,
immutable random record IDs, one entry per civil date, one-second autosave,
five-minute auto-lock. Backup frequency and retention remain future design choices.
No hosting, AI or multi-device synchronization is implied. No Google credentials
are required for the current milestone.

Phase 2 validation is development evidence, not a security audit. Backup/restore,
least-privilege production database setup and packaged desktop acceptance remain
outstanding. See security.md for the threat model and practical limits.
