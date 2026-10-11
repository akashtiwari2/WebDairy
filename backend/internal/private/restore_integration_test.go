package private

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/akashtiwari2/WebDairy/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreWorkflow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable TEST_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "phase3_restore_test"
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = database.Migrate(ctx, pool, filepath.Join("..", "..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	b64 := func(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }
	envelope := Envelope{FormatVersion: 1, VaultID: "12345678-1234-4234-8234-123456789012", Passphrase: PasswordEnvelope{KDF: KDF{Algorithm: "argon2id", Version: 19, Memory: 65536, Iterations: 3, Parallelism: 1, Salt: b64(16)}, Nonce: b64(12), Ciphertext: b64(48)}, Recovery: RecoveryEnvelope{Algorithm: "HKDF-SHA256", Salt: b64(16), Nonce: b64(12), Ciphertext: b64(48)}}
	record := func(id string, vault string) Record {
		return Record{ID: id, VaultID: vault, CryptoVersion: 1, Nonce: b64(12), Ciphertext: b64(32), Revision: 1}
	}
	ids := []string{"10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"}
	stage := Stage{ID: "11111111-1111-4111-8111-111111111111", Envelope: envelope, Records: []Record{record(ids[0], envelope.VaultID), record(ids[1], envelope.VaultID), record(ids[2], envelope.VaultID)}}
	binding, _ := Token()
	if err = s.StageRestore(ctx, stage, binding); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Vault(ctx); err != ErrNotFound {
		t.Fatal("staging changed active vault")
	}
	if err = s.StageRestore(ctx, stage, binding); err != nil {
		t.Fatal("stage retry", err)
	}
	if _, err = s.CommitRestore(ctx, stage.ID, "foreign binding", "synthetic login password"); err != ErrUnauthenticated {
		t.Fatal("stage binding bypass")
	}
	v, err := s.CommitRestore(ctx, stage.ID, binding, "synthetic login password")
	if err != nil {
		t.Fatal(err)
	}
	originalEpoch := v.Epoch
	if v.Generation != 1 || !UUID.MatchString(v.Epoch) {
		t.Fatal("initial restore state")
	}
	retry, err := s.CommitRestore(ctx, stage.ID, binding, "synthetic login password")
	if err != nil || retry.Epoch != v.Epoch {
		t.Fatal("commit retry mutated vault")
	}
	snapshot, err := s.Snapshot(ctx)
	if err != nil || len(snapshot.Records) != 3 {
		t.Fatal("fresh restore records", err)
	}
	expected := func(v Vault) *RestoreState {
		return &RestoreState{VaultID: v.Envelope.VaultID, Epoch: v.Epoch, Generation: v.Generation, Revision: v.Revision}
	}
	safety := func(v Vault) *Archive {
		return &Archive{Format: "webdiary-backup", Version: 1, VaultID: v.Envelope.VaultID, Envelope: v.Envelope, Salt: b64(16), Nonce: b64(12), Ciphertext: b64(32)}
	}
	incoming := envelope
	incoming.VaultID = "22345678-1234-4234-8234-123456789012"
	next := Stage{ID: "22222222-2222-4222-8222-222222222222", Envelope: incoming, Records: []Record{record(ids[0], incoming.VaultID), record(ids[1], incoming.VaultID)}, Expected: expected(v), Safety: safety(v)}
	if err = s.StageRestore(ctx, next, binding); err != nil {
		t.Fatal(err)
	}
	write := Write{Epoch: v.Epoch, CryptoVersion: 1, Nonce: b64(12), Ciphertext: b64(48), ExpectedRevision: 1, OperationID: "33333333-3333-4333-8333-333333333333"}
	if _, err = s.Save(ctx, ids[0], write); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CommitRestore(ctx, next.ID, binding, ""); err != ErrConflict {
		t.Fatal("stale replacement accepted")
	}
	snapshot, err = s.Snapshot(ctx)
	if err != nil || len(snapshot.Records) != 3 || snapshot.Records[0].Revision != 2 || snapshot.Vault.Epoch != originalEpoch {
		t.Fatal("stale restore changed data")
	}
	next.ID = "44444444-4444-4444-8444-444444444444"
	next.Expected = expected(snapshot.Vault)
	next.Safety = safety(snapshot.Vault)
	if err = s.StageRestore(ctx, next, binding); err != nil {
		t.Fatal(err)
	}
	// Force failure after the first staged row is inserted and active rows removed.
	if _, err = pool.Exec(ctx, `CREATE FUNCTION fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='10000000-0000-4000-8000-000000000002'::uuid THEN RAISE EXCEPTION 'synthetic interrupted restore';END IF;RETURN NEW;END $$;CREATE TRIGGER interrupt_restore BEFORE INSERT ON entries FOR EACH ROW EXECUTE FUNCTION fail_restore()`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CommitRestore(ctx, next.ID, binding, ""); err == nil {
		t.Fatal("interrupted restore accepted")
	}
	unchanged, err := s.Snapshot(ctx)
	if err != nil || len(unchanged.Records) != 3 || unchanged.Vault.Epoch != snapshot.Vault.Epoch || unchanged.Records[0].Revision != 2 {
		t.Fatal("partial restore was not rolled back")
	}
	var history int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM restore_backups`).Scan(&history); err != nil || history != 0 {
		t.Fatal("rollback leaked history")
	}
	if _, err = pool.Exec(ctx, `DROP TRIGGER interrupt_restore ON entries;DROP FUNCTION fail_restore()`); err != nil {
		t.Fatal(err)
	}
	applied, err := s.CommitRestore(ctx, next.ID, binding, "")
	if err != nil {
		t.Fatal(err)
	}
	if applied.Epoch == originalEpoch || applied.Envelope.VaultID != incoming.VaultID {
		t.Fatal("restore epoch not changed")
	}
	if _, err = s.Save(ctx, ids[0], write); err != ErrVaultChanged {
		t.Fatal("old writer overwrote restored entry")
	}
	var archived []byte
	if err = pool.QueryRow(ctx, `SELECT archive FROM restore_backups WHERE id=$1::uuid`, next.ID).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	var old Archive
	if err = json.Unmarshal(archived, &old); err != nil || old.VaultID != envelope.VaultID {
		t.Fatal("previous vault backup missing")
	}
	// Permanent deletion is idempotent and creation cannot resurrect its old ID.
	operation := "55555555-5555-4555-8555-555555555555"
	if err = s.Purge(ctx, ids[0], applied.Epoch, operation, 1); err != nil {
		t.Fatal(err)
	}
	if err = s.Purge(ctx, ids[0], applied.Epoch, operation, 1); err != nil {
		t.Fatal("purge retry", err)
	}
	write.Epoch = applied.Epoch
	write.ExpectedRevision = 0
	write.OperationID = "66666666-6666-4666-8666-666666666666"
	if _, err = s.Save(ctx, ids[0], write); err == nil {
		t.Fatal("purged record resurrected")
	} else {
		var conflict *RecordConflict
		if !errors.As(err, &conflict) {
			t.Fatal(err)
		}
	}
	current, err := s.Vault(ctx)
	if err != nil {
		t.Fatal(err)
	}
	final := Stage{ID: "77777777-7777-4777-8777-777777777777", Envelope: incoming, Records: next.Records, Expected: expected(current), Safety: safety(current)}
	if err = s.StageRestore(ctx, final, binding); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE restore_stages SET expires_at=now()-interval '1 second' WHERE id=$1::uuid`, final.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CommitRestore(ctx, final.ID, binding, ""); err != ErrNotFound {
		t.Fatal("expired staging accepted")
	}
	// Explicit restore may reintroduce an old ID, with a fresh epoch guarding delayed writes.
	final.ID = "88888888-8888-4888-8888-888888888888"
	if err = s.StageRestore(ctx, final, binding); err != nil {
		t.Fatal(err)
	}
	restored, err := s.CommitRestore(ctx, final.ID, binding, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Save(ctx, ids[0], write); err != ErrVaultChanged {
		t.Fatal("purge-era writer accepted")
	}
	records, _, err := s.Records(ctx, "")
	if err != nil || len(records) != 2 || restored.Epoch == applied.Epoch {
		t.Fatal("explicit restore failed")
	}
	// Invalid metadata and duplicate IDs never reach staging storage.
	bad := final
	bad.ID = "99999999-9999-4999-8999-999999999999"
	bad.Records = append(bad.Records, bad.Records[0])
	if err = s.StageRestore(ctx, bad, binding); err != ErrInvalid {
		t.Fatal("duplicate record accepted")
	}
}
