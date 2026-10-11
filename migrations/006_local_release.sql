ALTER TABLE vaults ADD COLUMN vault_epoch uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE vaults ADD COLUMN generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0);
CREATE TABLE entry_tombstones (
 id uuid PRIMARY KEY,
 vault_id uuid NOT NULL,
 revision bigint NOT NULL CHECK (revision > 0),
 operation_id uuid NOT NULL UNIQUE
);
CREATE TABLE restore_stages (
 id uuid PRIMARY KEY,
 binding_hash bytea NOT NULL CHECK (octet_length(binding_hash)=32),
 request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
 payload jsonb NOT NULL,
 result jsonb,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
);
CREATE TABLE restore_backups (
 id uuid PRIMARY KEY,
 archive jsonb NOT NULL,
 saved_at timestamptz NOT NULL DEFAULT now()
);
