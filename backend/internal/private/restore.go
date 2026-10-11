package private

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const MaxSnapshot = 32 * 1024 * 1024
const MaxArchive = 48 * 1024 * 1024
const MaxRecords = 10000

type Snapshot struct {
	Vault   Vault    `json:"vault"`
	Records []Record `json:"records"`
	At      string   `json:"snapshot_at"`
}
type RestoreState struct {
	VaultID    string `json:"vault_id"`
	Epoch      string `json:"vault_epoch"`
	Generation int64  `json:"generation"`
	Revision   int64  `json:"envelope_revision"`
}
type Archive struct {
	Format     string   `json:"format"`
	Version    int      `json:"version"`
	VaultID    string   `json:"vault_id"`
	Envelope   Envelope `json:"envelope"`
	Salt       string   `json:"salt"`
	Nonce      string   `json:"nonce"`
	Ciphertext string   `json:"ciphertext"`
}
type Stage struct {
	ID       string        `json:"operation_id"`
	Envelope Envelope      `json:"envelope"`
	Records  []Record      `json:"records"`
	Expected *RestoreState `json:"expected"`
	Safety   *Archive      `json:"safety_backup,omitempty"`
}

func ValidArchive(a *Archive) bool {
	if a == nil {
		return false
	}
	if a.Format != "webdiary-backup" || a.Version != 1 || a.VaultID != a.Envelope.VaultID || !ValidEnvelope(a.Envelope) || !exactBase64(a.Salt, 16) || !exactBase64(a.Nonce, 12) || len(a.Ciphertext) > MaxArchive {
		return false
	}
	ciphertext, e := base64.StdEncoding.Strict().DecodeString(a.Ciphertext)
	return e == nil && len(ciphertext) >= 16
}
func ValidStage(stage Stage) bool {
	if !UUID.MatchString(stage.ID) || !ValidEnvelope(stage.Envelope) || stage.Records == nil || len(stage.Records) > MaxRecords {
		return false
	}
	ids := map[string]bool{}
	size := 0
	for _, r := range stage.Records {
		if ids[r.ID] || !UUID.MatchString(r.ID) || r.VaultID != stage.Envelope.VaultID || r.Revision < 1 || r.Revision > 9007199254740990 || !ValidWrite(Write{Epoch: "00000000-0000-0000-0000-000000000001", CryptoVersion: r.CryptoVersion, Nonce: r.Nonce, Ciphertext: r.Ciphertext, OperationID: r.ID}) {
			return false
		}
		ids[r.ID] = true
		size += len(r.Ciphertext) + len(r.Nonce) + 200
		if size > MaxSnapshot {
			return false
		}
	}
	if stage.Expected == nil {
		return stage.Safety == nil
	}
	expected := stage.Expected
	return UUID.MatchString(expected.VaultID) && UUID.MatchString(expected.Epoch) && expected.Generation >= 0 && expected.Generation <= 9007199254740990 && expected.Revision > 0 && ValidArchive(stage.Safety) && stage.Safety.VaultID == expected.VaultID
}
func (s *Store) Snapshot(ctx context.Context) (Snapshot, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Snapshot{}, err
	}
	defer tx.Rollback(context.Background())
	v, err := readVault(ctx, tx)
	if err != nil {
		return Snapshot{}, err
	}
	rows, err := tx.Query(ctx, `SELECT `+columns+` FROM entries WHERE vault_id=$1::uuid ORDER BY id`, v.Envelope.VaultID)
	if err != nil {
		return Snapshot{}, err
	}
	records := []Record{}
	size := 0
	for rows.Next() {
		r, e := scanRecord(rows)
		if e != nil {
			rows.Close()
			return Snapshot{}, e
		}
		records = append(records, r)
		size += len(r.Ciphertext) + 200
		if len(records) > MaxRecords || size > MaxSnapshot {
			rows.Close()
			return Snapshot{}, ErrInvalid
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return Snapshot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Snapshot{}, err
	}
	return Snapshot{Vault: v, Records: records, At: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}
func readVault(ctx context.Context, tx pgx.Tx) (Vault, error) {
	var v Vault
	var encoded []byte
	err := tx.QueryRow(ctx, `SELECT v.key_envelope,v.revision,v.vault_epoch::text,v.generation FROM vaults v JOIN owner_auth o ON o.vault_id=v.id WHERE o.id=true`).Scan(&encoded, &v.Revision, &v.Epoch, &v.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(encoded, &v.Envelope)
	return v, err
}
func matches(v Vault, expected *RestoreState) bool {
	return expected != nil && v.Envelope.VaultID == expected.VaultID && v.Epoch == expected.Epoch && v.Generation == expected.Generation && v.Revision == expected.Revision
}
func (s *Store) StageRestore(ctx context.Context, stage Stage, binding string) error {
	if !ValidStage(stage) {
		return ErrInvalid
	}
	encoded, err := json.Marshal(stage)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(encoded)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(873125902)`); err != nil {
		return err
	}
	var priorHash, bindingHash []byte
	err = tx.QueryRow(ctx, `SELECT request_hash,binding_hash FROM restore_stages WHERE id=$1::uuid AND expires_at>now()`, stage.ID).Scan(&priorHash, &bindingHash)
	if err == nil {
		if !bytes.Equal(priorHash, hash[:]) || !bytes.Equal(bindingHash, TokenHash(binding)) {
			return ErrConflict
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	current, err := readVault(ctx, tx)
	if stage.Expected == nil {
		if !errors.Is(err, ErrNotFound) {
			if err != nil {
				return err
			}
			return ErrConflict
		}
	} else {
		if err != nil {
			return err
		}
		if !matches(current, stage.Expected) {
			return ErrConflict
		}
		a, _ := json.Marshal(current.Envelope)
		b, _ := json.Marshal(stage.Safety.Envelope)
		if !bytes.Equal(a, b) {
			return ErrConflict
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM restore_stages WHERE expires_at<=now()`); err != nil {
		return err
	}
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM restore_stages WHERE result IS NULL`).Scan(&count); err != nil {
		return err
	}
	if count >= 2 {
		return ErrLimited
	}
	if _, err = tx.Exec(ctx, `INSERT INTO restore_stages(id,binding_hash,request_hash,payload) VALUES($1::uuid,$2,$3,$4::jsonb)`, stage.ID, TokenHash(binding), hash[:], encoded); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func randomUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func (s *Store) CommitRestore(ctx context.Context, id, binding, password string) (Vault, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Vault{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(873125902)`); err != nil {
		return Vault{}, err
	}
	var encoded, hash, result []byte
	err = tx.QueryRow(ctx, `SELECT payload,binding_hash,result FROM restore_stages WHERE id=$1::uuid AND expires_at>now() FOR UPDATE`, id).Scan(&encoded, &hash, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return Vault{}, ErrNotFound
	}
	if err != nil {
		return Vault{}, err
	}
	if !bytes.Equal(hash, TokenHash(binding)) {
		return Vault{}, ErrUnauthenticated
	}
	current, currentErr := readVault(ctx, tx)
	if result != nil {
		var applied Vault
		if err = json.Unmarshal(result, &applied); err != nil {
			return Vault{}, err
		}
		if currentErr != nil || current.Epoch != applied.Epoch || current.Envelope.VaultID != applied.Envelope.VaultID {
			return Vault{}, ErrConflict
		}
		return current, nil
	}
	var stage Stage
	if err = json.Unmarshal(encoded, &stage); err != nil || !ValidStage(stage) {
		return Vault{}, ErrInvalid
	}
	var loginHash string
	if stage.Expected == nil {
		if !errors.Is(currentErr, ErrNotFound) {
			if currentErr != nil {
				return Vault{}, currentErr
			}
			return Vault{}, ErrConflict
		}
		loginHash, err = PasswordHash(password)
		if err != nil {
			return Vault{}, ErrInvalid
		}
	} else {
		if currentErr != nil {
			return Vault{}, currentErr
		}
		if !matches(current, stage.Expected) {
			return Vault{}, ErrConflict
		}
	}
	envelope, _ := json.Marshal(stage.Envelope)
	epoch, err := randomUUID()
	if err != nil {
		return Vault{}, err
	}
	var nextGeneration int64 = 1
	var nextRevision int64 = 1
	if stage.Expected != nil {
		nextGeneration = current.Generation + 1
		nextRevision = current.Revision + 1
		safety, _ := json.Marshal(stage.Safety)
		if _, err = tx.Exec(ctx, `INSERT INTO restore_backups(id,archive) VALUES($1::uuid,$2::jsonb)`, id, safety); err != nil {
			return Vault{}, err
		}
		// Bound retained rollback copies, after the new copy is safely part of this transaction.
		if _, err = tx.Exec(ctx, `DELETE FROM restore_backups WHERE id IN (SELECT id FROM restore_backups ORDER BY saved_at DESC,id DESC OFFSET 3)`); err != nil {
			return Vault{}, err
		}
		oldID := current.Envelope.VaultID
		for _, query := range []string{`DELETE FROM private_operations WHERE vault_id=$1::uuid`, `DELETE FROM vault_operations WHERE vault_id=$1::uuid`, `DELETE FROM entries WHERE vault_id=$1::uuid`} {
			if _, err = tx.Exec(ctx, query, oldID); err != nil {
				return Vault{}, err
			}
		}
	}
	// Preserve revisions across a same-ID replacement; the new epoch rejects every old writer.
	if _, err = tx.Exec(ctx, `INSERT INTO vaults(id,crypto_version,key_envelope,revision,vault_epoch,generation) VALUES($1::uuid,1,$2::jsonb,$3,$4::uuid,$5) ON CONFLICT(id) DO UPDATE SET key_envelope=EXCLUDED.key_envelope,revision=EXCLUDED.revision,vault_epoch=EXCLUDED.vault_epoch,generation=EXCLUDED.generation`, stage.Envelope.VaultID, envelope, nextRevision, epoch, nextGeneration); err != nil {
		return Vault{}, err
	}
	if stage.Expected == nil {
		if _, err = tx.Exec(ctx, `INSERT INTO owner_auth(id,password_hash,vault_id) VALUES(true,$1,$2::uuid)`, loginHash, stage.Envelope.VaultID); err != nil {
			return Vault{}, err
		}
	} else {
		if _, err = tx.Exec(ctx, `UPDATE owner_auth SET vault_id=$1::uuid WHERE id=true`, stage.Envelope.VaultID); err != nil {
			return Vault{}, err
		}
		if current.Envelope.VaultID != stage.Envelope.VaultID {
			if _, err = tx.Exec(ctx, `DELETE FROM vaults WHERE id=$1::uuid`, current.Envelope.VaultID); err != nil {
				return Vault{}, err
			}
		}
	}
	for _, r := range stage.Records {
		nonce, _ := base64.StdEncoding.DecodeString(r.Nonce)
		ciphertext, _ := base64.StdEncoding.DecodeString(r.Ciphertext)
		if _, err = tx.Exec(ctx, `DELETE FROM entry_tombstones WHERE id=$1::uuid`, r.ID); err != nil {
			return Vault{}, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO entries(id,vault_id,nonce,ciphertext,revision) VALUES($1::uuid,$2::uuid,$3,$4,$5)`, r.ID, stage.Envelope.VaultID, nonce, ciphertext, r.Revision); err != nil {
			return Vault{}, err
		}
	}
	applied := Vault{Envelope: stage.Envelope, Revision: nextRevision, Epoch: epoch, Generation: nextGeneration}
	result, _ = json.Marshal(applied)
	if _, err = tx.Exec(ctx, `UPDATE restore_stages SET result=$2::jsonb,payload='{}'::jsonb WHERE id=$1::uuid`, id, result); err != nil {
		return Vault{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Vault{}, err
	}
	return applied, nil
}
func (s *Store) Purge(ctx context.Context, id, epoch, operation string, revision int64) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(873125902)`); err != nil {
		return err
	}
	v, err := readVault(ctx, tx)
	if err != nil {
		return err
	}
	if v.Epoch != epoch {
		return ErrVaultChanged
	}
	var originalOperation string
	err = tx.QueryRow(ctx, `SELECT operation_id::text FROM entry_tombstones WHERE id=$1::uuid AND vault_id=$2::uuid`, id, v.Envelope.VaultID).Scan(&originalOperation)
	if err == nil {
		if originalOperation == operation {
			return nil
		}
		return ErrNotFound
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	result, err := tx.Exec(ctx, `DELETE FROM entries WHERE id=$1::uuid AND vault_id=$2::uuid AND revision=$3`, id, v.Envelope.VaultID, revision)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrConflict
	}
	if _, err = tx.Exec(ctx, `INSERT INTO entry_tombstones(id,vault_id,revision,operation_id) VALUES($1::uuid,$2::uuid,$3,$4::uuid)`, id, v.Envelope.VaultID, revision, operation); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE vaults SET generation=generation+1 WHERE id=$1::uuid`, v.Envelope.VaultID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
