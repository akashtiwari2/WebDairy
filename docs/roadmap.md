# Implementation roadmap

The uploaded PDF is a design proposal, not evidence that its features are implemented.
The owner's request authorizes starting the project from an empty repository. The
foundation and Phase 1 persistence are implemented; the rest is staged development.

1. **Phase 1, persistent sample diary (implemented):** Angular, Echo, PostgreSQL,
   transaction-based migrations, CRUD, per-date serial autosave, bounded failure
   retries and explicit conflict comparison. Future entries survive refresh and
   application/database restart. Data stays in a separate synthetic plaintext
   development table; unsaved recovery across refresh remains Phase 2 work.
2. **Phase 2, private vault:** browser AES-GCM, pinned Argon2id wrapping, distinct
   login/session controls, recovery key, encrypted IndexedDB drafts, auto-lock.
3. **Phase 3, usable local diary:** search, trash, timezone/theme settings, encrypted
   export/import and transactional restore. Rehearse past/today/future restoration
   with both passphrase and recovery before real diary use.
4. **Phase 4, Windows and Drive:** embed Angular in Go, launcher lifecycle and
   second-instance handling, supported desktop OAuth, protected token storage,
   immutable encrypted backups, retry and retention, second-machine restoration.
5. **Phase 5, release:** accessibility, failure/corruption cases, midnight behaviour,
   packaging and documented trusted release.

Defaults to validate during implementation: Asia/Kolkata; one owner/vault; one active
computer and editing tab; one entry per selected civil date; dates inside encrypted
payloads; one-second autosave; five-minute auto-lock; ten-minute dirty backup;
30-day trash; seven recent and four weekly snapshots. No AI/sync/hosting implied.

Phase 1 checks do not satisfy the PDF's encrypted-draft, cryptography, backup,
recovery or Windows release acceptance gates. No Google account or OAuth credentials
are needed until the Drive milestone.
