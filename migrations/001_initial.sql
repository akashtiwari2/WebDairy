-- Scaffold only: no owner credentials or diary content are seeded.
-- Run in a transaction. Re-running version 1 is safe.
CREATE TABLE IF NOT EXISTS schema_migrations (
 version integer PRIMARY KEY,
 applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vaults (
 id uuid PRIMARY KEY,
 crypto_version integer NOT NULL CHECK (crypto_version > 0),
 key_envelope jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
 id uuid PRIMARY KEY,
 vault_id uuid NOT NULL REFERENCES vaults(id),
 ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 2097152),
 nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 operational_created_at timestamptz NOT NULL DEFAULT now(),
 operational_updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
