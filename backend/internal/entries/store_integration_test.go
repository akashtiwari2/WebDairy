package entries

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/akashtiwari2/WebDairy/backend/internal/database"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TEST_DATABASE_URL must point to the disposable database created by
// scripts/test-integration.sh. Normal unit runs report this test as skipped.
func TestPostgresWorkflow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("run scripts/test-integration.sh for isolated PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal("test database configuration invalid")
	}
	defer pool.Close()
	directory := "../../../migrations"
	for i := 0; i < 2; i++ {
		if err := database.Migrate(ctx, pool, directory); err != nil {
			t.Fatal(err)
		}
	}
	var versions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil || versions != 4 {
		t.Fatal("migration repeatability failed", err)
	}
	s := &Store{Pool: pool}
	operation := func(id string, revision int64, title, body string) Write {
		return Write{Title: title, Body: body, ExpectedRevision: revision, OperationID: id}
	}

	t.Run("past today leap and future dates survive new connection", func(t *testing.T) {
		dates := []string{"2000-01-01", time.Now().UTC().Format("2006-01-02"), "2024-02-29", "2099-10-20"}
		ids := []string{"10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"}
		for i, date := range dates {
			write := operation(ids[i], 0, "Synthetic title", "Sample body\nwith newline")
			if i == 2 {
				write.Body = ""
			} // title-only is valid
			saved, err := s.Save(ctx, date, write)
			if err != nil || saved.Revision != 1 || saved.Date != date {
				t.Fatalf("create %s failed: %v", date, err)
			}
		}
		other, err := pgxpool.New(ctx, dsn)
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		reopened := &Store{Pool: other}
		for _, date := range dates {
			entry, err := reopened.Get(ctx, date)
			if err != nil || entry.Date != date || entry.Title != "Synthetic title" || entry.Revision != 1 {
				t.Fatalf("reopen %s failed: %v", date, err)
			}
		}
		index, err := reopened.Dates(ctx)
		if err != nil || len(index) != 4 {
			t.Fatal("calendar index failed", err)
		}
		if _, err := reopened.Get(ctx, "2040-01-01"); !errors.Is(err, ErrNotFound) {
			t.Fatal("empty visit created entry")
		}
	})
	t.Run("retries are idempotent and stale writes preserve current data", func(t *testing.T) {
		date := "2098-01-01"
		create := operation("22222222-2222-4222-8222-222222222222", 0, "Sample", "Initial")
		first, err := s.Save(ctx, date, create)
		if err != nil {
			t.Fatal(err)
		}
		retry, err := s.Save(ctx, date, create)
		if err != nil || retry.Revision != first.Revision || !retry.UpdatedAt.Equal(first.UpdatedAt) {
			t.Fatal("create retry incremented revision")
		}
		update := operation("33333333-3333-4333-8333-333333333333", 1, "Sample", "Updated")
		second, err := s.Save(ctx, date, update)
		if err != nil || second.Revision != 2 {
			t.Fatal("update failed", err)
		}
		retry, err = s.Save(ctx, date, update)
		if err != nil || retry.Revision != 2 || !retry.UpdatedAt.Equal(second.UpdatedAt) {
			t.Fatal("update retry incremented revision")
		}
		bad := operation("44444444-4444-4444-8444-444444444444", 1, "Sample", "Stale text")
		_, err = s.Save(ctx, date, bad)
		var conflict *Conflict
		if !errors.As(err, &conflict) || conflict.Current.Body != "Updated" {
			t.Fatal("stale write did not conflict")
		}
		create.OperationID = "55555555-5555-4555-8555-555555555555"
		if _, err = s.Save(ctx, date, create); !errors.As(err, &conflict) {
			t.Fatal("duplicate date overwrote entry")
		}
		update.Body = "Different payload with reused operation"
		if _, err = s.Save(ctx, date, update); !errors.As(err, &conflict) {
			t.Fatal("operation reuse accepted a different payload")
		}
	})
	t.Run("concurrent updates allow exactly one winner", func(t *testing.T) {
		date := "2097-01-01"
		if _, err := s.Save(ctx, date, operation("66666666-6666-4666-8666-666666666666", 0, "Sample", "Initial")); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for _, id := range []string{"77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"} {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				_, err := s.Save(ctx, date, operation(id, 1, "Sample", id))
				results <- err
			}(id)
		}
		wg.Wait()
		close(results)
		wins, conflicts := 0, 0
		for err := range results {
			var conflict *Conflict
			if err == nil {
				wins++
			} else if errors.As(err, &conflict) {
				conflicts++
			} else {
				t.Fatal(err)
			}
		}
		current, err := s.Get(ctx, date)
		if wins != 1 || conflicts != 1 || err != nil || current.Revision != 2 {
			t.Fatal("concurrent update protection failed")
		}
	})
	t.Run("concurrent duplicate operation commits once", func(t *testing.T) {
		write := operation("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 0, "Sample", "Concurrent retry")
		var wg sync.WaitGroup
		results := make(chan Entry, 2)
		failures := make(chan error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				entry, err := s.Save(ctx, "2096-01-01", write)
				if err != nil {
					failures <- err
				} else {
					results <- entry
				}
			}()
		}
		wg.Wait()
		close(results)
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
		count := 0
		for entry := range results {
			count++
			if entry.Revision != 1 {
				t.Fatal("duplicate operation incremented revision")
			}
		}
		if count != 2 {
			t.Fatal("duplicate operation did not return both acknowledgements")
		}
	})
	t.Run("deletion checks revision and never resurrects stale updates", func(t *testing.T) {
		date := "2098-01-01"
		var conflict *Conflict
		if err := s.Delete(ctx, date, 1); !errors.As(err, &conflict) {
			t.Fatal("stale delete did not conflict")
		}
		if err := s.Delete(ctx, date, 2); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get(ctx, date); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted entry remains")
		}
		if err := s.Delete(ctx, date, 2); !errors.Is(err, ErrNotFound) {
			t.Fatal("repeated deletion should report missing entry")
		}
		_, err := s.Save(ctx, date, operation("99999999-9999-4999-8999-999999999999", 2, "Sample", "Stale"))
		if !errors.As(err, &conflict) || conflict.Current != nil {
			t.Fatal("stale update resurrected deleted entry")
		}
		_, err = s.Save(ctx, date, operation("22222222-2222-4222-8222-222222222222", 0, "Sample", "Initial"))
		if !errors.As(err, &conflict) || conflict.Current != nil {
			t.Fatal("delayed creation retry resurrected deleted entry")
		}
		recreate := operation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0, "Sample", "Recreated")
		newEntry, err := s.Save(ctx, date, recreate)
		if err != nil || newEntry.Revision != 4 {
			t.Fatal("recreated date reused old revision", err)
		}
		retried, err := s.Save(ctx, date, recreate)
		if err != nil || retried.Revision != 4 {
			t.Fatal("recreate retry was not idempotent", err)
		}
		_, err = s.Save(ctx, date, operation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 2, "Sample", "Old editor"))
		if !errors.As(err, &conflict) || conflict.Current.Body != "Recreated" {
			t.Fatal("old editor overwrote recreated entry")
		}
	})
	t.Run("failed migration rolls back schema and version", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "005_failure.sql"), []byte(`CREATE TABLE migration_should_rollback(id integer); SELECT deliberately_missing_function();`), 0600); err != nil {
			t.Fatal(err)
		}
		if err := database.Migrate(ctx, pool, dir); err == nil {
			t.Fatal("invalid migration succeeded")
		}
		var absent bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('migration_should_rollback') IS NULL`).Scan(&absent); err != nil || !absent {
			t.Fatal("failed migration left table")
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil || versions != 4 {
			t.Fatal("failed migration recorded version")
		}
	})
}
