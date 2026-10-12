package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/akashtiwari2/WebDairy/backend/internal/cloud"
	"github.com/akashtiwari2/WebDairy/backend/internal/database"
	"github.com/akashtiwari2/WebDairy/backend/internal/desktop"
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
	desktopMode := flag.Bool("desktop", false, "serve embedded UI, open browser and reuse an existing app instance")
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
	if *desktopMode && !explicitEnv {
		executable, e := os.Executable()
		if e != nil {
			return e
		}
		*envFile = filepath.Join(filepath.Dir(executable), ".env")
	}
	if err := loadEnvironment(*envFile, explicitEnv); err != nil {
		return err
	}
	if *desktopMode && !*resetLogin && !*migrate {
		if !desktop.Ready() {
			return errors.New("desktop assets missing; build with node scripts/package.mjs")
		}
		if desktop.Existing() {
			return desktop.OpenBrowser("http://127.0.0.1:8080")
		}
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		if *desktopMode {
			return errors.New("DATABASE_URL is required; copy .env.example to .env next to the desktop executable and configure PostgreSQL")
		}
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
		var err error
		if *desktopMode {
			err = database.MigrateFS(migrationCtx, pool, desktop.Migrations())
		} else {
			err = database.Migrate(migrationCtx, pool, *migrationPath)
		}
		cancel()
		if err != nil {
			return fmt.Errorf("database migration failed: %w", err)
		}
		fmt.Println("Database migrations ready (versions 1 through 7).")
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
		err := pool.QueryRow(ctx, "SELECT version FROM schema_migrations WHERE version = 7").Scan(&version)
		return err
	}, &private.Store{Pool: pool}, cloud.New(os.Getenv("GOOGLE_CLIENT_ID"), os.Getenv("GOOGLE_CLIENT_SECRET")))
	if *desktopMode {
		desktop.Mount(e)
	}
	addr := "127.0.0.1:8080"
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		if *desktopMode && desktop.Existing() {
			return desktop.OpenBrowser("http://127.0.0.1:8080")
		}
		return errors.New("port 8080 is occupied; keep the existing app running or stop your own old backend before starting this one")
	}
	e.Listener = listener
	defer listener.Close()
	fmt.Println("WebDairy Phase 4 backend listening on", addr)
	failure := make(chan error, 1)
	go func() { failure <- e.Start(addr) }()
	if *desktopMode {
		go func() {
			client := http.Client{Timeout: time.Second}
			for attempt := 0; attempt < 30; attempt++ {
				select {
				case <-ctx.Done():
					return
				default:
				}
				if r, e := client.Get("http://127.0.0.1:8080/api/health"); e == nil {
					r.Body.Close()
					if r.StatusCode == 200 {
						_ = desktop.OpenBrowser("http://127.0.0.1:8080")
						return
					}
				}
				time.Sleep(200 * time.Millisecond)
			}
		}()
	}
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
