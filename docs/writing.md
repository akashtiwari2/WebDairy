# Writing, offline drafts and backup health

## Offline writing

WebDairy uses a local Go backend and PostgreSQL. Internet access is not needed to
log in, unlock, write, search or save while those local services are running.
Google sign-in/Drive are optional; a new Google session or Drive access needs
internet. Existing local password login does not. Google-only owners can optionally
add an offline login password in Settings.

If the backend becomes unavailable after unlocking, keep writing in the open tab.
Each edit is encrypted before its draft is stored in this browser's IndexedDB.
**Saved on this device · pending database save** appears only after durable local
storage succeeds and a network/backend save fails. It does not mean PostgreSQL
acknowledged the save or that an off-device backup exists. A storage failure shows
an error instead; keep the tab open and fix it before closing.

Failed network saves retry, and a ten-second backend health check (also triggered
by the browser's online event) resumes pending saves when the database is ready.
Existing ciphertext/operation IDs are reused for uncertain writes. Conflicting
revisions or a replaced vault still require comparison rather than silent overwrite.
After reopening and unlocking with the local backend, recovered encrypted drafts
save automatically; conflicts remain blocked for explicit resolution.

The current development frontend, login and unlock need the local services. This
is not a service-worker/PWA that can cold-start without a frontend/backend, and
it does not bypass login, vault locking or auto-lock during an outage. Encrypted
drafts survive a normal lock; backend availability is required to unlock again.
Use the same browser profile and hostname. Browser storage can be cleared; export
an encrypted editor-text file when a longer outage needs a separate copy.

Normal writing has no **Save now** or **Restore saved text** buttons. Status shows
progress; **Retry save** appears for failures. Conflict comparison, trash and draft
recovery are still available. Wait for **Saved** for a confirmed database save.

## Mood and tags

Choose Happy, Calm, Neutral, Sad or Stressed, or leave mood unset. Enter tags
separated by commas and press Enter or leave the field to apply them. Up to ten
unique tags are allowed, each at most 32 characters. Tags are deduplicated without
regard to case. Metadata saves with entry text and stays encrypted in the database,
browser drafts and portable backups. Existing entries/backups without metadata
remain supported; no new database columns or migration are required.

Search / Trash offers a mood selector and an exact, case-insensitive tag filter.
The text search also includes tags. Search happens locally after vault unlock.

## Writing streak

The diary shows the current streak, best streak and total written days. These are
computed from distinct saved, non-trashed entry dates with a title or body in the
selected timezone. Future entries and unconfirmed drafts do not count. A streak
continues if today is not written yet but yesterday is; a missed day resets it.
This measures diary entry dates, not a separate history of when you typed.
Settings → **Show writing streak** lets you hide it; the setting travels in backups.

## Backup health

The diary shortcut and Backups panel show the last full browser backup for this
vault, whether none exists, whether it is older than 24 hours, or whether newer
changes exist. Full backups are still manual. Encrypted emergency editor-text
exports do not count as full database backups. New full copies also record opaque
record IDs/revisions to detect changes such as permanent deletion. Old copies
remain valid and use their timestamp for health reporting.

Health describes browser copies, not verified Google Drive or off-device coverage.
A download starting cannot prove you kept the file elsewhere. Keep a downloaded
.diary file and its recovery key separately. With Google/Drive configured, health also shows pending/recent/overdue/unavailable
Drive state; overdue uses the chosen schedule (manual reminders use 24 hours).
See [Google and desktop setup](google-setup.md) for scheduled uploads and new-device
restore discovery.
