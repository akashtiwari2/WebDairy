package desktop

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func TestSetupConnectionEscaping(t *testing.T) {
	dsn, err := (connectionRequest{User: "synthetic_user", Password: "a@b:#% /?", Database: "synthetic_diary", Port: 5433}).DSN()
	if err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if config.ConnConfig.Password != "a@b:#% /?" || config.ConnConfig.Database != "synthetic_diary" || config.ConnConfig.Port != 5433 || config.ConnConfig.Host != "127.0.0.1" {
		t.Fatal("connection fields did not round trip")
	}
	for _, name := range []string{"postgres; DROP DATABASE x", "", "../file", "postgres", "template0", "template1"} {
		if _, err := (connectionRequest{User: "user", Database: name, Port: 5432}).DSN(); err == nil {
			t.Fatal("invalid database name accepted")
		}
	}
}

func TestSetupRejectsCrossSiteAndProtectsSecrets(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("CUSTOM_SETTING=keep-me\nGOOGLE_CLIENT_SECRET=SYNTHETIC_SECRET\n"), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s := NewSetup(context.Background(), path, func(context.Context, map[string]string) (http.Handler, func(), error) {
		calls++
		return nil, nil, errors.New("SYNTHETIC_SECRET internal provider failure")
	})
	for _, tc := range []struct{ host, origin, token, site string }{
		{"attacker.example", BrowserURL, s.token, "same-origin"},
		{"127.0.0.1:8080", "https://attacker.example", s.token, "cross-site"},
		{"127.0.0.1:8080", "", s.token, ""},
		{"127.0.0.1:8080", BrowserURL, "wrong", "same-origin"},
	} {
		r := httptest.NewRequest("POST", BrowserURL+"/setup/retry", strings.NewReader("{}"))
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-WebDairy-Setup", tc.token)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("untrusted setup request accepted")
		}
	}
	if calls != 0 {
		t.Fatal("untrusted request initialized the app")
	}
	for _, route := range []string{"/", "/setup/status"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", BrowserURL+route, nil))
		if w.Code != 200 || strings.Contains(w.Body.String(), "SYNTHETIC_SECRET") {
			t.Fatal("setup leaked a stored credential")
		}
	}
	if strings.Contains(ConnectionMessage(&pgconn.PgError{Code: "28P01", Message: "SYNTHETIC_SECRET"}), "SYNTHETIC_SECRET") {
		t.Fatal("database error leaked credentials")
	}
	if strings.Contains(ConnectionMessage(errors.New("SYNTHETIC_SECRET")), "SYNTHETIC_SECRET") {
		t.Fatal("startup error leaked credentials")
	}
}

func TestSetupRetriesAndKeepsConfig(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("GOOGLE_CLIENT_ID", "")
	t.Setenv("GOOGLE_CLIENT_SECRET", "")
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("DATABASE_URL=postgres://synthetic\nCUSTOM_SETTING=keep-me\n"), 0600); err != nil {
		t.Fatal(err)
	}
	calls, closed := 0, 0
	s := NewSetup(context.Background(), path, func(context.Context, map[string]string) (http.Handler, func(), error) {
		calls++
		if calls == 1 {
			return nil, nil, errors.New("startup failure")
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("diary")) }), func() { closed++ }, nil
	})
	// Use a process override just for this startup; it never writes a file.
	t.Setenv("DATABASE_URL", "postgres://synthetic")
	if s.Start() == nil || s.Status().Ready {
		t.Fatal("failed startup appeared ready")
	}
	if err := s.Start(); err != nil || !s.Status().Ready {
		t.Fatal("saved connection did not retry")
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", BrowserURL+"/", nil))
	if w.Body.String() != "diary" {
		t.Fatal("successful initialization did not serve diary")
	}
	if err := s.Start(); err == nil || calls != 2 {
		t.Fatal("ready app reinitialized")
	}
	s.Close()
	s.Close()
	if closed != 1 {
		t.Fatal("pool cleanup was not idempotent")
	}
	values, err := godotenv.Read(path)
	if err != nil || values["CUSTOM_SETTING"] != "keep-me" {
		t.Fatal("existing configuration was overwritten")
	}
}

func TestSaveSettingsAtomicAndPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings", ".env")
	values := map[string]string{"DATABASE_URL": "postgres://synthetic:encoded%40password@127.0.0.1/diary", "CUSTOM_SETTING": "keep-me", "GOOGLE_CLIENT_SECRET": "synthetic # @ $ secret"}
	if err := saveSettings(path, values); err != nil {
		t.Fatal(err)
	}
	got, err := godotenv.Read(path)
	if err != nil || got["GOOGLE_CLIENT_SECRET"] != values["GOOGLE_CLIENT_SECRET"] || got["CUSTOM_SETTING"] != "keep-me" {
		t.Fatal("configuration did not round trip")
	}
	if err := saveSettings(path, values); err != nil {
		t.Fatal("settings could not be updated")
	}
	if info, err := os.Stat(path); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatal("settings permissions are not private")
	}
	link := filepath.Join(dir, "linked.env")
	if err := os.Symlink(path, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := saveSettings(link, values); err == nil {
		t.Fatal("symlink target overwritten")
	}
}
