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
	desktopMode := flag.Bool("desktop", packagedBrowser == "true", "serve the packaged diary in your browser")
	configure := flag.Bool("configure", false, "open the browser connection setup instead of the diary")
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
		*envFile, e = desktop.EnvironmentPath(executable)
		if e != nil {
			return e
		}
	}
	if *configure && (!*desktopMode || *migrate || *resetLogin) {
		return errors.New("-configure is only available for the browser package")
	}
	if *desktopMode && !*migrate && !*resetLogin {
		return runBrowser(*envFile, *configure)
	}
	if err := loadEnvironment(*envFile, explicitEnv); err != nil {
		return err
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
	addr := "127.0.0.1:47831"
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		if *desktopMode && desktop.Existing() {
			return desktop.OpenBrowser("http://127.0.0.1:47831")
		}
		return errors.New("port 47831 is occupied; keep the existing app running or stop your own old backend before starting this one")
	}
	e.Listener = listener
	defer listener.Close()
	fmt.Println("WebDairy listening on", addr)
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

// Set only by the packaging build. Source/development commands retain their
// existing defaults; a downloaded executable opens the browser on double-click.
var packagedBrowser = "false"

func runBrowser(path string, configure bool) error {
	if desktop.Existing() {
		if configure {
			return errors.New("WebDairy is already running. Close its launcher window before opening Setup WebDairy")
		}
		return desktop.OpenBrowser(desktop.BrowserURL)
	}
	if !desktop.Ready() {
		return errors.New("browser files are missing; build the package with node scripts/package.mjs")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:47831")
	if err != nil {
		if desktop.Existing() && !configure {
			return desktop.OpenBrowser(desktop.BrowserURL)
		}
		return errors.New("port 47831 is in use by another program. Close your own old WebDairy process before starting this one")
	}
	defer listener.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	setup := desktop.NewSetup(ctx, path, func(startup context.Context, values map[string]string) (http.Handler, func(), error) {
		pool, err := pgxpool.New(ctx, values["DATABASE_URL"])
		if err != nil {
			return nil, nil, err
		}
		// Ping first so the wizard can distinguish an unavailable service,
		// invalid login and missing database without printing any credentials.
		if err = pool.Ping(startup); err == nil {
			err = database.MigrateFS(startup, pool, desktop.Migrations())
		}
		if err != nil {
			pool.Close()
			return nil, nil, err
		}
		e := server.New(func(check context.Context) error {
			var version int
			return pool.QueryRow(check, "SELECT version FROM schema_migrations WHERE version = 7").Scan(&version)
		}, &private.Store{Pool: pool}, cloud.New(values["GOOGLE_CLIENT_ID"], values["GOOGLE_CLIENT_SECRET"]))
		desktop.Mount(e)
		return e, pool.Close, nil
	})
	defer setup.Close()
	srv := &http.Server{Handler: setup, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	failure := make(chan error, 1)
	go func() { failure <- srv.Serve(listener) }()
	if !configure {
		go func() { _ = setup.Start() }()
	}
	fmt.Println("WebDairy is open in your browser. Keep this window running; Ctrl+C stops WebDairy.")
	if err := desktop.OpenBrowser(desktop.BrowserURL); err != nil {
		fmt.Println("Open", desktop.BrowserURL, "in your browser.")
	}
	select {
	case err := <-failure:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		return srv.Shutdown(shutdown)
	}
	return nil
}
