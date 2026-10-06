-- Retain only the date/revision after deleting sample content. Recreating a date
-- must not reuse an earlier revision and let a stale editor overwrite it.
ALTER TABLE development_entries ADD COLUMN deleted boolean NOT NULL DEFAULT false;
ALTER TABLE development_entries DROP CONSTRAINT development_entries_check;
ALTER TABLE development_entries ADD CONSTRAINT development_entries_content CHECK (deleted OR title <> '' OR body <> '');
