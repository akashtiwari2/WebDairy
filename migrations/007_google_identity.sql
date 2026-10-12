-- Google subject is the identity; email is display-only, never account ownership.
ALTER TABLE owner_auth ALTER COLUMN password_hash DROP NOT NULL;
CREATE TABLE google_identity (
 owner_id boolean PRIMARY KEY DEFAULT true REFERENCES owner_auth(id) ON DELETE CASCADE,
 subject text NOT NULL UNIQUE CHECK (length(subject) BETWEEN 1 AND 255),
 email text NOT NULL CHECK (length(email) BETWEEN 1 AND 320)
);
