-- Phase 1 ONLY: plaintext synthetic entries. This table is deliberately separate
-- from the encrypted vault schema and must never be used for personal diary data.
CREATE TABLE development_entries (
 diary_date date PRIMARY KEY,
 title text NOT NULL CHECK (char_length(title) <= 200),
 body text NOT NULL CHECK (octet_length(body) <= 1048576),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (title <> '' OR body <> '')
);
