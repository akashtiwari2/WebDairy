package desktop

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

//go:embed setup.html
var setupHTML string

const BrowserURL = "http://127.0.0.1:47831"

type Initializer func(context.Context, map[string]string) (http.Handler, func(), error)

type Setup struct {
	mu      sync.RWMutex
	work    sync.Mutex
	app     http.Handler
	cleanup func()
	busy    bool
	message string
	path    string
	token   string
	init    Initializer
	ctx     context.Context
}

type SetupStatus struct {
	Ready      bool   `json:"ready"`
	Busy       bool   `json:"busy"`
	Message    string `json:"message"`
	Configured bool   `json:"configured"`
}

// Configuration lives outside the downloaded package, so upgrades retain it.
// Honour an existing portable .env for compatibility without copying secrets.
func EnvironmentPath(executable string) (string, error) {
	legacy := filepath.Join(filepath.Dir(executable), ".env")
	if _, err := os.Stat(legacy); err == nil {
		return legacy, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", errors.New("could not find your local settings folder; use -env with a file path")
	}
	return filepath.Join(dir, "WebDairy", ".env"), nil
}

func NewSetup(ctx context.Context, path string, initialize Initializer) *Setup {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic("could not generate local setup token")
	}
	return &Setup{path: path, token: hex.EncodeToString(secret), ctx: ctx, init: initialize}
}

func (s *Setup) values() (map[string]string, error) {
	values, err := godotenv.Read(s.path)
	if errors.Is(err, os.ErrNotExist) {
		values, err = map[string]string{}, nil
	}
	if err != nil {
		return nil, errors.New("could not read local settings; check the .env file format before changing it")
	}
	for _, key := range []string{"DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"} {
		if value, ok := os.LookupEnv(key); ok && value != "" {
			values[key] = value
		}
	}
	return values, nil
}

func (s *Setup) Status() SetupStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	values, _ := s.values()
	return SetupStatus{s.app != nil, s.busy, s.message, values["DATABASE_URL"] != ""}
}

func (s *Setup) Close() {
	s.work.Lock()
	defer s.work.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cleanup != nil {
		s.cleanup()
		s.cleanup = nil
	}
}

func (s *Setup) Start() error {
	values, err := s.values()
	if err != nil {
		s.mu.Lock()
		s.message = err.Error()
		s.mu.Unlock()
		return err
	}
	if values["DATABASE_URL"] == "" {
		return nil
	}
	return s.open(values, false)
}

func (s *Setup) open(values map[string]string, save bool) error {
	if !s.work.TryLock() {
		return errors.New("WebDairy is already checking the connection; wait a moment")
	}
	defer s.work.Unlock()
	return s.openLocked(values, save)
}

func (s *Setup) openLocked(values map[string]string, save bool) error {
	s.mu.Lock()
	if s.app != nil {
		s.mu.Unlock()
		return errors.New("WebDairy is already open; close it before changing connection settings")
	}
	s.busy, s.message = true, ""
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.busy = false; s.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(s.ctx, 35*time.Second)
	defer cancel()
	handler, cleanup, err := s.init(ctx, values)
	if err == nil && save {
		err = saveSettings(s.path, values)
	}
	if err != nil {
		if cleanup != nil {
			cleanup()
		}
		s.mu.Lock()
		s.message = ConnectionMessage(err)
		s.mu.Unlock()
		return errors.New(ConnectionMessage(err))
	}
	s.mu.Lock()
	s.app, s.cleanup = handler, cleanup
	s.mu.Unlock()
	return nil
}

func ConnectionMessage(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "28P01", "28000":
			return "PostgreSQL did not accept that username or password. Check your PostgreSQL login and try again."
		case "3D000":
			return "The diary database does not exist. Enable Create database below, or choose your existing diary database."
		case "42501":
			return "This PostgreSQL account cannot set up the diary database. Use an account that owns the diary database."
		}
	}
	var connection *pgconn.ConnectError
	if errors.As(err, &connection) {
		return "Diary storage could not start. Keep PostgreSQL running, check its port and try again. Your diary has not been reset."
	}
	// No raw SQL, DSN or provider errors reach the browser or logs.
	return "WebDairy could not finish opening the diary. Check local settings and database permissions, then try again. Existing diary data is kept."
}

func saveSettings(path string, values map[string]string) error {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("settings file must not be a symbolic link")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := godotenv.Marshal(values)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".webdiary-settings-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.WriteString(data + "\n"); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}

type connectionRequest struct {
	User         string `json:"user"`
	Password     string `json:"password"`
	Database     string `json:"database"`
	Port         int    `json:"port"`
	Create       bool   `json:"create"`
	GoogleID     string `json:"google_id"`
	GoogleSecret string `json:"google_secret"`
}

var databaseName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)
var errOccupiedDatabase = errors.New("database contains another app's tables")

func (r connectionRequest) DSN() (string, error) {
	if r.Database == "postgres" || r.Database == "template0" || r.Database == "template1" {
		return "", errors.New("choose a separate diary database, such as diary_db, instead of a PostgreSQL system database")
	}
	if !databaseName.MatchString(r.Database) || strings.TrimSpace(r.User) == "" || len(r.User) > 100 || r.Port < 1 || r.Port > 65535 || len(r.Password) > 4096 {
		return "", errors.New("enter a PostgreSQL username, a valid database name and a port between 1 and 65535")
	}
	u := url.URL{Scheme: "postgres", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(r.Port)), Path: "/" + r.Database, User: url.UserPassword(r.User, r.Password)}
	u.RawQuery = "sslmode=disable"
	return u.String(), nil
}

// Create only the explicitly named missing database. Never drop databases,
// replace existing tables, alter PostgreSQL services or reset diary records.
func ensureDatabase(ctx context.Context, dsn string, create bool) error {
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return err
	}
	target := config.ConnConfig.Database
	if create {
		admin := config.Copy()
		admin.ConnConfig.Database = "postgres"
		pool, err := pgxpool.NewWithConfig(ctx, admin)
		if err != nil {
			return err
		}
		defer pool.Close()
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)", target).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if _, err := pool.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{target}.Sanitize()); err != nil {
				var pg *pgconn.PgError
				if !errors.As(err, &pg) || pg.Code != "42P04" {
					return err
				}
			}
		}
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return err
	}
	defer pool.Close()
	var occupied bool
	err = pool.QueryRow(ctx, `SELECT (to_regclass('public.schema_migrations') IS NULL
		OR to_regclass('public.vaults') IS NULL OR to_regclass('public.entries') IS NULL) AND EXISTS
		(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')`).Scan(&occupied)
	if err != nil {
		return err
	}
	if occupied {
		return errOccupiedDatabase
	}
	return nil
}

func (s *Setup) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Host != "127.0.0.1:47831" {
		http.Error(w, "Open WebDairy at "+BrowserURL, 403)
		return
	}
	s.mu.RLock()
	app := s.app
	s.mu.RUnlock()
	if r.URL.Path == "/api/desktop" && r.Method == http.MethodGet {
		writeJSON(w, 200, map[string]bool{"desktop": true})
		return
	}
	if app != nil && !strings.HasPrefix(r.URL.Path, "/setup/") {
		app.ServeHTTP(w, r)
		return
	}
	if (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != BrowserURL) || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "Local setup only", 403)
		return
	}
	if r.Method == http.MethodPost {
		if r.Header.Get("Origin") != BrowserURL || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-WebDairy-Setup")), []byte(s.token)) != 1 {
			http.Error(w, "Local setup only", 403)
			return
		}
		if app != nil {
			writeJSON(w, 409, map[string]string{"message": "WebDairy is already open. Close it before changing setup."})
			return
		}
	}
	switch {
	case r.URL.Path == "/setup/status" && r.Method == http.MethodGet:
		writeJSON(w, 200, s.Status())
	case r.URL.Path == "/setup/retry" && r.Method == http.MethodPost:
		if err := s.Start(); err != nil {
			writeJSON(w, 503, map[string]string{"message": err.Error()})
			return
		}
		writeJSON(w, 200, s.Status())
	case r.URL.Path == "/setup/connect" && r.Method == http.MethodPost:
		s.connect(w, r)
	case r.URL.Path == "/api/health" && r.Method == http.MethodGet:
		writeJSON(w, 503, map[string]string{"status": "unavailable", "database": "not-ready"})
	case r.Method == http.MethodGet && (r.URL.Path == "/" || r.URL.Path == "/setup"):
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-"+s.token+"'; style-src 'nonce-"+s.token+"'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		view, _ := template.New("setup").Parse(setupHTML)
		_ = view.Execute(w, struct {
			Token  string
			Status SetupStatus
		}{s.token, s.Status()})
	default:
		http.NotFound(w, r)
	}
}

func (s *Setup) connect(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, 400, map[string]string{"message": "Use the WebDairy setup form."})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input connectionRequest
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		writeJSON(w, 400, map[string]string{"message": "Check your connection details and try again."})
		return
	}
	dsn, err := input.DSN()
	if err != nil {
		writeJSON(w, 400, map[string]string{"message": err.Error()})
		return
	}
	if os.Getenv("DATABASE_URL") != "" || (input.GoogleID != "" && os.Getenv("GOOGLE_CLIENT_ID") != "") || (input.GoogleSecret != "" && os.Getenv("GOOGLE_CLIENT_SECRET") != "") {
		writeJSON(w, 409, map[string]string{"message": "This connection is supplied by a process environment variable. Remove that override before changing it in setup."})
		return
	}
	values, err := s.values()
	if err != nil {
		writeJSON(w, 400, map[string]string{"message": err.Error()})
		return
	}
	if input.GoogleID != "" || input.GoogleSecret != "" {
		if !strings.HasSuffix(input.GoogleID, ".apps.googleusercontent.com") || len(input.GoogleID) > 300 || input.GoogleSecret == "" || len(input.GoogleSecret) > 1000 {
			writeJSON(w, 400, map[string]string{"message": "Enter both the Desktop OAuth client ID and client secret from your Google setup file."})
			return
		}
		values["GOOGLE_CLIENT_ID"], values["GOOGLE_CLIENT_SECRET"] = input.GoogleID, input.GoogleSecret
	}
	if !s.work.TryLock() {
		writeJSON(w, 409, map[string]string{"message": "WebDairy is already checking the connection. Wait a moment."})
		return
	}
	defer s.work.Unlock()
	s.mu.Lock()
	if s.app != nil {
		s.mu.Unlock()
		writeJSON(w, 409, map[string]string{"message": "WebDairy is already open. Close it before changing setup."})
		return
	}
	s.busy, s.message = true, ""
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.busy = false; s.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	err = ensureDatabase(ctx, dsn, input.Create)
	cancel()
	if err != nil {
		message := ConnectionMessage(err)
		if errors.Is(err, errOccupiedDatabase) {
			message = "That database contains another app's tables. Choose a separate empty database for your diary."
		}
		writeJSON(w, 503, map[string]string{"message": message})
		return
	}
	values["DATABASE_URL"] = dsn
	if err := s.openLocked(values, true); err != nil {
		writeJSON(w, 503, map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, 200, s.Status())
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
