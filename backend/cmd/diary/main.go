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
	"github.com/akashtiwari2/WebDairy/backend/internal/private"
	"github.com/akashtiwari2/WebDairy/backend/internal/server"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"golang.org/x/term"
)

// Explicit process environment wins over a local file (for deployments/test runners).
func loadEnvironment(path string, required bool) error {
	if err := godotenv.Load(path); err != nil {
		if !required && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		// Do not echo parser errors: they may include database credentials.
		return errors.New("could not load .env; check that the file exists and uses KEY=value syntax")
	}
	return nil
}

func run() error {
	migrate := flag.Bool("migrate", false, "apply pending numbered database migrations and exit")
	migrationPath := flag.String("migrations", "../migrations", "migration directory")
	resetLogin := flag.Bool("reset-login", false, "reset login password interactively and invalidate all sessions; vault unchanged")
	envFile := flag.String("env", ".env", "environment file (default: .env in the current backend directory)")
	flag.Parse()
	explicitEnv := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "env" {
			explicitEnv = true
		}
	})
	if err := loadEnvironment(*envFile, explicitEnv); err != nil {
		return err
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required; copy backend/.env.example to backend/.env and set your PostgreSQL connection")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return errors.New("database configuration is invalid")
	}
	defer pool.Close()
	if !*resetLogin || *migrate {
		migrationCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := database.Migrate(migrationCtx, pool, *migrationPath)
		cancel()
		if err != nil {
			return fmt.Errorf("database migration failed: %w", err)
		}
		fmt.Println("Database migrations ready (versions 1 through 6).")
		if *migrate {
			return nil
		}
	}
	if *resetLogin {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return errors.New("reset-login requires an interactive terminal")
		}
		fmt.Print("New login password (at least 12 characters): ")
		password, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}
		defer clear(password)
		fmt.Print("Confirm new login password: ")
		confirmation, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}
		defer clear(confirmation)
		if string(password) != string(confirmation) {
			return errors.New("passwords did not match")
		}
		resetCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := (&private.Store{Pool: pool}).ResetLogin(resetCtx, string(password)); err != nil {
			return err
		}
		fmt.Println("Login reset. All sessions revoked. Encrypted vault unchanged.")
		return nil
	}
	e := server.New(func(ctx context.Context) error {
		var version int
		err := pool.QueryRow(ctx, "SELECT version FROM schema_migrations WHERE version = 6").Scan(&version)
		return err
	}, &private.Store{Pool: pool})
	addr := "127.0.0.1:8080"
	fmt.Println("WebDairy Phase 3 backend listening on", addr)
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
