package database

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate applies each numbered SQL file once, under one transaction and lock.
// The lock also prevents two launchers from racing to apply a migration.
func Migrate(ctx context.Context, pool *pgxpool.Pool, directory string) error {
	files, err := filepath.Glob(filepath.Join(directory, "*.sql"))
	if err != nil || len(files) == 0 {
		return fmt.Errorf("migration directory has no readable SQL files")
	}
	sort.Strings(files)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("cannot connect to database for migration")
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(873125901)"); err != nil {
		return fmt.Errorf("cannot lock database migrations")
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("cannot prepare migration tracking")
	}
	for _, file := range files {
		name := filepath.Base(file)
		version, err := strconv.Atoi(strings.SplitN(name, "_", 2)[0])
		if err != nil || version < 1 {
			return fmt.Errorf("invalid migration filename: %s", name)
		}
		var applied bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)", version).Scan(&applied); err != nil {
			return fmt.Errorf("cannot read migration tracking")
		}
		if applied {
			continue
		}
		sql, err := os.ReadFile(file)
		if err != nil {
			return fmt.Errorf("cannot read migration: %s", name)
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migration failed: %s", name)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", version); err != nil {
			return fmt.Errorf("cannot record migration: %s", name)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("cannot commit database migrations")
	}
	return nil
}
