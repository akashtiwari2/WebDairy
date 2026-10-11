-- Phase 1 sample tables are retained but are not exposed by the private app.
ALTER TABLE vaults ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE TABLE owner_auth (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 password_hash text NOT NULL,
 vault_id uuid NOT NULL UNIQUE REFERENCES vaults(id)
);
CREATE TABLE sessions (
 token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
 csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
 expires_at timestamptz NOT NULL,
 absolute_expiry timestamptz NOT NULL
);
CREATE TABLE auth_throttle (
 name text PRIMARY KEY,
 attempts integer NOT NULL,
 window_start timestamptz NOT NULL
);
CREATE TABLE private_operations (
 operation_id uuid PRIMARY KEY,
 vault_id uuid NOT NULL REFERENCES vaults(id),
 record_id uuid NOT NULL,
 request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
 result_revision bigint CHECK (result_revision > 0)
);
CREATE TABLE vault_operations (
 operation_id uuid PRIMARY KEY,
 vault_id uuid NOT NULL REFERENCES vaults(id),
 request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
 result_revision bigint CHECK (result_revision > 0)
);
