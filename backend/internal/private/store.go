package private

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ Pool *pgxpool.Pool }
type KDF struct {
	Algorithm   string `json:"algorithm"`
	Version     int    `json:"version"`
	Memory      int    `json:"memory_kib"`
	Iterations  int    `json:"iterations"`
	Parallelism int    `json:"parallelism"`
	Salt        string `json:"salt"`
}
type PasswordEnvelope struct {
	KDF        KDF    `json:"kdf"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}
type RecoveryEnvelope struct {
	Algorithm  string `json:"algorithm"`
	Salt       string `json:"salt"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}
type Envelope struct {
	FormatVersion int              `json:"format_version"`
	VaultID       string           `json:"vault_id"`
	Passphrase    PasswordEnvelope `json:"passphrase"`
	Recovery      RecoveryEnvelope `json:"recovery"`
}
type Vault struct {
	Epoch      string   `json:"vault_epoch"`
	Generation int64    `json:"generation"`
	Envelope   Envelope `json:"envelope"`
	Revision   int64    `json:"revision"`
}
type Record struct {
	ID            string `json:"id"`
	VaultID       string `json:"vault_id"`
	CryptoVersion int    `json:"crypto_version"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
	Revision      int64  `json:"revision"`
}
type Write struct {
	Epoch            string `json:"vault_epoch"`
	CryptoVersion    int    `json:"crypto_version"`
	Nonce            string `json:"nonce"`
	Ciphertext       string `json:"ciphertext"`
	ExpectedRevision int64  `json:"expected_revision"`
	OperationID      string `json:"operation_id"`
}
type RecordConflict struct{ Current *Record }

func (*RecordConflict) Error() string { return "record revision conflict" }

var UUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func exactBase64(value string, size int) bool {
	b, e := base64.StdEncoding.Strict().DecodeString(value)
	return e == nil && len(b) == size
}
func ValidEnvelope(e Envelope) bool {
	k := e.Passphrase.KDF
	return e.FormatVersion == 1 && UUID.MatchString(e.VaultID) && k.Algorithm == "argon2id" && k.Version == 19 && k.Memory == 65536 && k.Iterations == 3 && k.Parallelism == 1 && exactBase64(k.Salt, 16) && exactBase64(e.Passphrase.Nonce, 12) && exactBase64(e.Passphrase.Ciphertext, 48) && e.Recovery.Algorithm == "HKDF-SHA256" && exactBase64(e.Recovery.Salt, 16) && exactBase64(e.Recovery.Nonce, 12) && exactBase64(e.Recovery.Ciphertext, 48)
}
func ValidWrite(w Write) bool {
	ciphertext, e := base64.StdEncoding.Strict().DecodeString(w.Ciphertext)
	return e == nil && len(ciphertext) >= 16 && len(ciphertext) <= 1500000 && w.CryptoVersion == 1 && UUID.MatchString(w.Epoch) && exactBase64(w.Nonce, 12) && UUID.MatchString(w.OperationID) && w.ExpectedRevision >= 0 && w.ExpectedRevision <= 9007199254740990
}
func (s *Store) Setup(ctx context.Context, password string, envelope Envelope) error {
	hash, err := PasswordHash(password)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(873125902)`); err != nil {
		return err
	}
	var initialized bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM owner_auth)`).Scan(&initialized); err != nil {
		return err
	}
	if initialized {
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `INSERT INTO vaults(id,crypto_version,key_envelope) VALUES($1::uuid,1,$2::jsonb)`, envelope.VaultID, encoded); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO owner_auth(id,password_hash,vault_id) VALUES(true,$1,$2::uuid)`, hash, envelope.VaultID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) Vault(ctx context.Context) (Vault, error) {
	var vault Vault
	var encoded []byte
	err := s.Pool.QueryRow(ctx, `SELECT key_envelope,revision,vault_epoch::text,generation FROM vaults WHERE id=(SELECT vault_id FROM owner_auth WHERE id=true)`).Scan(&encoded, &vault.Revision, &vault.Epoch, &vault.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return vault, ErrNotFound
	}
	if err != nil {
		return vault, err
	}
	err = json.Unmarshal(encoded, &vault.Envelope)
	return vault, err
}
func (s *Store) SetEnvelope(ctx context.Context, envelope Envelope, revision int64, operation string) (Vault, error) {
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return Vault{}, err
	}
	hash := sha256.Sum256(append(encoded, []byte(jsonNumber(revision))...))
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Vault{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(873125902)`); err != nil {
		return Vault{}, err
	}
	result, err := tx.Exec(ctx, `INSERT INTO vault_operations(operation_id,vault_id,request_hash) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT DO NOTHING`, operation, envelope.VaultID, hash[:])
	if err != nil {
		return Vault{}, err
	}
	var next int64
	if result.RowsAffected() == 0 {
		var original []byte
		if err = tx.QueryRow(ctx, `SELECT request_hash,result_revision FROM vault_operations WHERE operation_id=$1::uuid`, operation).Scan(&original, &next); err != nil {
			return Vault{}, err
		}
		var current int64
		if err = tx.QueryRow(ctx, `SELECT revision FROM vaults WHERE id=$1::uuid`, envelope.VaultID).Scan(&current); err != nil {
			return Vault{}, err
		}
		if !bytes.Equal(hash[:], original) || current != next {
			return Vault{}, ErrConflict
		}
		return readVault(ctx, tx)
	}
	err = tx.QueryRow(ctx, `UPDATE vaults SET key_envelope=$1::jsonb,revision=revision+1,generation=generation+1 WHERE id=$2::uuid AND revision=$3 AND id=(SELECT vault_id FROM owner_auth WHERE id=true) RETURNING revision`, encoded, envelope.VaultID, revision).Scan(&next)
	if errors.Is(err, pgx.ErrNoRows) {
		return Vault{}, ErrConflict
	}
	if err != nil {
		return Vault{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE vault_operations SET result_revision=$2 WHERE operation_id=$1::uuid`, operation, next); err != nil {
		return Vault{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Vault{}, err
	}
	return s.Vault(ctx)
}
func jsonNumber(value int64) string { b, _ := json.Marshal(value); return string(b) }
func scanRecord(row pgx.Row) (Record, error) {
	var r Record
	var nonce, ciphertext []byte
	err := row.Scan(&r.ID, &r.VaultID, &r.CryptoVersion, &nonce, &ciphertext, &r.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	r.Nonce = base64.StdEncoding.EncodeToString(nonce)
	r.Ciphertext = base64.StdEncoding.EncodeToString(ciphertext)
	return r, err
}

const columns = `id::text,vault_id::text,1,nonce,ciphertext,revision`

func (s *Store) Records(ctx context.Context, cursor string) ([]Record, string, error) {
	if cursor == "" {
		cursor = "00000000-0000-0000-0000-000000000000"
	}
	rows, err := s.Pool.Query(ctx, `SELECT `+columns+` FROM entries WHERE vault_id=(SELECT vault_id FROM owner_auth WHERE id=true) AND id>$1::uuid ORDER BY id LIMIT 101`, cursor)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	records := []Record{}
	for rows.Next() {
		r, err := scanRecord(rows)
		if err != nil {
			return nil, "", err
		}
		records = append(records, r)
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(records) > 100 {
		records = records[:100]
		next = records[99].ID
	}
	return records, next, nil
}
func (s *Store) Save(ctx context.Context, id string, write Write) (Record, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(873125902)`); err != nil {
		return Record{}, err
	}
	var vaultID, epoch string
	if err = tx.QueryRow(ctx, `SELECT v.id::text,v.vault_epoch::text FROM vaults v JOIN owner_auth o ON o.vault_id=v.id WHERE o.id=true`).Scan(&vaultID, &epoch); err != nil {
		return Record{}, err
	}
	if write.Epoch != epoch {
		return Record{}, ErrVaultChanged
	}
	var tombstoned bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM entry_tombstones WHERE id=$1::uuid)`, id).Scan(&tombstoned); err != nil {
		return Record{}, err
	}
	if tombstoned {
		return Record{}, &RecordConflict{}
	}
	encoded, _ := json.Marshal(struct {
		ID    string
		Write Write
	}{id, write})
	hash := sha256.Sum256(encoded)
	inserted, err := tx.Exec(ctx, `INSERT INTO private_operations(operation_id,vault_id,record_id,request_hash) VALUES($1::uuid,$2::uuid,$3::uuid,$4) ON CONFLICT DO NOTHING`, write.OperationID, vaultID, id, hash[:])
	if err != nil {
		return Record{}, err
	}
	if inserted.RowsAffected() == 0 {
		var original []byte
		var revision int64
		if err = tx.QueryRow(ctx, `SELECT request_hash,result_revision FROM private_operations WHERE operation_id=$1::uuid`, write.OperationID).Scan(&original, &revision); err != nil {
			return Record{}, err
		}
		current, err := scanRecord(tx.QueryRow(ctx, `SELECT `+columns+` FROM entries WHERE id=$1::uuid AND vault_id=$2::uuid`, id, vaultID))
		if errors.Is(err, ErrNotFound) {
			return Record{}, &RecordConflict{}
		}
		if err != nil {
			return Record{}, err
		}
		if bytes.Equal(original, hash[:]) && current.Revision == revision {
			return current, nil
		}
		return Record{}, &RecordConflict{Current: &current}
	}
	nonce, _ := base64.StdEncoding.DecodeString(write.Nonce)
	ciphertext, _ := base64.StdEncoding.DecodeString(write.Ciphertext)
	var record Record
	if write.ExpectedRevision == 0 {
		record, err = scanRecord(tx.QueryRow(ctx, `INSERT INTO entries(id,vault_id,ciphertext,nonce) VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING `+columns, id, vaultID, ciphertext, nonce))
	} else {
		record, err = scanRecord(tx.QueryRow(ctx, `UPDATE entries SET ciphertext=$3,nonce=$4,revision=revision+1,operational_updated_at=now() WHERE id=$1::uuid AND vault_id=$2::uuid AND revision=$5 RETURNING `+columns, id, vaultID, ciphertext, nonce, write.ExpectedRevision))
	}
	if errors.Is(err, ErrNotFound) {
		current, e := scanRecord(tx.QueryRow(ctx, `SELECT `+columns+` FROM entries WHERE id=$1::uuid AND vault_id=$2::uuid`, id, vaultID))
		if errors.Is(e, ErrNotFound) {
			return Record{}, &RecordConflict{}
		}
		if e != nil {
			return Record{}, e
		}
		return Record{}, &RecordConflict{Current: &current}
	}
	if err != nil {
		return Record{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE private_operations SET result_revision=$2 WHERE operation_id=$1::uuid`, write.OperationID, record.Revision); err != nil {
		return Record{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE vaults SET generation=generation+1 WHERE id=$1::uuid`, vaultID); err != nil {
		return Record{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Record{}, err
	}
	return record, nil
}
