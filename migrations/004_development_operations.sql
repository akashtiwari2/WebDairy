-- Keep committed operation identities after delete/recreate so delayed retries
-- cannot resurrect content. Request hashes are only idempotence metadata.
CREATE TABLE development_entry_operations (
 operation_id uuid PRIMARY KEY,
 diary_date date NOT NULL,
 request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
 result_revision bigint CHECK (result_revision > 0)
);
