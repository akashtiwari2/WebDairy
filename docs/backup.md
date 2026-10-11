# Backup and restore

## Export a file

1. Unlock your diary and open **Backups**.
2. Choose **Save and export backup**. All drafts must save or be resolved first.
3. Save the downloaded `.diary` file outside the browser (prefer a separate disk).
4. Keep its vault passphrase or offline recovery key in a different safe place.

The file is encrypted, includes active entries, trash and preferences, and excludes
login credentials. Browser copies are convenient additional copies, not independent
backups. Make a new export after important changes and before switching computers.
No automatic schedule or Drive upload exists in Phase 3.

If the backend is unavailable, **Export unsaved editor text** encrypts the text
currently in memory, including your draft version of any conflicts. That file is
labelled as containing unconfirmed edits. It does not replace a database backup.

## Restore into an empty database / another computer

1. Install/start WebDairy with a new dedicated empty PostgreSQL database; run migrations.
2. On the setup screen, choose the encrypted backup file under backup/restore.
3. Enter the passphrase **from when the file was created**, or choose its recovery key.
4. Verify and inspect the entry/trash counts and snapshot time.
5. Choose/confirm a new local login password and explicitly confirm restoration.
6. After completion, inspect your past, present and future entries and trash.

The saved diary dates stay unchanged. The restored timezone determines Today.
Restoring with a recovery key opens the diary but does not change the file's vault
passphrase. You can change the passphrase in Settings and then export a fresh backup.

## Replace the existing diary

Unlock the current diary first. Choose/verify the import file, then **Download current
diary backup**. Save that safety file outside the browser before checking the
replacement confirmation. Restore replaces the whole diary; it does not merge entries.
The current login remains unchanged; the vault key/passphrase comes from the file.

If you edit after taking the safety copy, restore refuses to use the stale copy.
Take a new safety backup and confirm again. Invalid keys/files and failed transactions
do not replace the active diary. If completion is uncertain after a network failure,
reopen/log in and inspect the diary before trying again. On a fresh database use the
new login password you chose for restore.

The three latest pre-replacement copies are available in Backups after successful
replacement. To undo a replacement, download one and restore it using its own key;
first take a safety copy of the current diary. Copies in the same database cannot
protect against loss of that database—keep a separate downloaded file.

## Trash and permanent deletion

Delete entry moves its encrypted text to Trash. Search excludes trash. Writing a
new entry on the same date preserves the old trash item. Trash shows a comparison
when the original date is occupied; choose a different empty date for restoration.
Permanent deletion and expired-trash cleanup both ask for confirmation. Trash is
kept for at least the configured period (30 days by default); cleanup runs only when
you confirm it in Trash. Earlier backup files may still contain deleted text.
