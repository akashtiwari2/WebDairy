package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/akashtiwari2/WebDairy/backend/internal/database"
	"github.com/akashtiwari2/WebDairy/backend/internal/entries"
	"github.com/akashtiwari2/WebDairy/backend/internal/server"
	"github.com/jackc/pgx/v5/pgxpool"
)

func run() error {
	migrate := flag.Bool("migrate", false, "apply pending numbered database migrations and exit")
	migrationPath := flag.String("migrations", "../migrations", "migration directory")
	flag.Parse()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required; use scripts/dev.sh for the isolated development database")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return errors.New("database configuration is invalid")
	}
	defer pool.Close()
	if *migrate {
		migrationCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := database.Migrate(migrationCtx, pool, *migrationPath); err != nil {
			return err
		}
		fmt.Println("Database migrations ready (versions 1 through 4).")
		return nil
	}
	e := server.New(func(ctx context.Context) error {
		var version int
		err := pool.QueryRow(ctx, "SELECT version FROM schema_migrations WHERE version = 4").Scan(&version)
		return err
	}, &entries.Store{Pool: pool})
	addr := "127.0.0.1:8080"
	fmt.Println("WebDairy Phase 1 backend listening on", addr)
	failure := make(chan error, 1)
	go func() { failure <- e.Start(addr) }()
	select {
	case err := <-failure:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return e.Shutdown(shutdownCtx)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
