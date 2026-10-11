package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/akashtiwari2/WebDairy/backend/internal/database"
	"github.com/akashtiwari2/WebDairy/backend/internal/private"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPrivateWorkflow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable TEST_DATABASE_URL")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = database.Migrate(ctx, pool, filepath.Join("..", "..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	s := &private.Store{Pool: pool}
	e := New(pool.Ping, s)
	cookies := map[string]*http.Cookie{}
	csrf := ""
	request := func(method, path string, value any, secure bool) *httptest.ResponseRecorder {
		var data []byte
		if value != nil {
			data, _ = json.Marshal(value)
		}
		req := httptest.NewRequest(method, "http://127.0.0.1:4200"+path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		if secure {
			req.Header.Set("Origin", "http://127.0.0.1:4200")
			req.Header.Set("X-CSRF-Token", csrf)
			for _, c := range cookies {
				req.AddCookie(c)
			}
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if secure {
			for _, c := range rec.Result().Cookies() {
				cookies[c.Name] = c
			}
		}
		return rec
	}
	decodeProfile := func(rec *httptest.ResponseRecorder) {
		t.Helper()
		if rec.Code != 200 {
			t.Fatalf("profile %d %s", rec.Code, rec.Body)
		}
		var p struct {
			CSRF string `json:"csrf_token"`
		}
		if err = json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		csrf = p.CSRF
	}
	if got := request("GET", "/api/entries", nil, false).Code; got != 401 {
		t.Fatalf("unauthenticated %d", got)
	}
	decodeProfile(request("GET", "/api/auth/session", nil, true))
	if c := cookies[csrfCookie]; !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe cookie")
	}
	if got := request("POST", "/api/auth/login", map[string]string{"password": "synthetic login password"}, false).Code; got != 403 {
		t.Fatalf("no CSRF %d", got)
	}
	for _, host := range []string{"evil.example:4200", "localhost:9000"} {
		req := httptest.NewRequest("GET", "http://"+host+"/api/health", nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != 403 {
			t.Fatal("host bypass")
		}
	}
	req := httptest.NewRequest("GET", "http://127.0.0.1:4200/api/auth/session", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatal("origin bypass")
	}
	b64 := func(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }
	envelope := private.Envelope{FormatVersion: 1, VaultID: "12345678-1234-4234-8234-123456789012", Passphrase: private.PasswordEnvelope{KDF: private.KDF{Algorithm: "argon2id", Version: 19, Memory: 65536, Iterations: 3, Parallelism: 1, Salt: b64(16)}, Nonce: b64(12), Ciphertext: b64(48)}, Recovery: private.RecoveryEnvelope{Algorithm: "HKDF-SHA256", Salt: b64(16), Nonce: b64(12), Ciphertext: b64(48)}}
	setup := map[string]any{"login_password": "synthetic login password", "envelope": envelope}
	decodeProfile(request("POST", "/api/auth/setup", setup, true))
	if got := request("POST", "/api/auth/setup", setup, true).Code; got != 409 {
		t.Fatalf("second setup %d", got)
	}
	if got := request("GET", "/api/vault", nil, true).Code; got != 200 {
		t.Fatalf("vault %d", got)
	}
	id := "11111111-1111-4111-8111-111111111111"
	block, _ := aes.NewCipher(make([]byte, 32))
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	encrypted := gcm.Seal(nil, nonce, []byte(`{"date":"2030-10-20","title":"SYNTHETIC SECRET","body":"synthetic body"}`), []byte("webdiary|entry|v1|"+envelope.VaultID+"|"+id))
	w := private.Write{CryptoVersion: 1, Nonce: b64(12), Ciphertext: base64.StdEncoding.EncodeToString(encrypted), OperationID: "22222222-2222-4222-8222-222222222222"}
	put := request("PUT", "/api/entries/"+id, w, true)
	if put.Code != 200 {
		t.Fatalf("save %d %s", put.Code, put.Body)
	}
	if got := request("PUT", "/api/entries/"+id, w, true).Code; got != 200 {
		t.Fatalf("idempotence %d", got)
	}
	changed := w
	changed.OperationID = "33333333-3333-4333-8333-333333333333"
	if got := request("PUT", "/api/entries/"+id, changed, true).Code; got != 409 {
		t.Fatalf("stale %d", got)
	}
	changed = w
	changed.Ciphertext = b64(20)
	if got := request("PUT", "/api/entries/"+id, changed, true).Code; got != 409 {
		t.Fatal("operation hash bypass")
	}
	if got := request("PUT", "/api/entries/2030-10-20", map[string]string{"title": "plaintext"}, true).Code; got != 400 {
		t.Fatal("plaintext API enabled")
	}
	if got := request("DELETE", "/api/entries/"+id, nil, true).Code; got != 404 && got != 405 {
		t.Fatal("delete exposed")
	}
	listing := request("GET", "/api/entries", nil, true)
	if listing.Code != 200 || strings.Contains(listing.Body.String(), "2030-10-20") || strings.Contains(listing.Body.String(), "SYNTHETIC SECRET") {
		t.Fatal("plaintext response")
	}
	var ciphertext []byte
	if err = pool.QueryRow(ctx, `SELECT ciphertext FROM entries WHERE id=$1::uuid`, id).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("SYNTHETIC SECRET")) {
		t.Fatal("plaintext database")
	}
	var hash string
	if err = pool.QueryRow(ctx, `SELECT password_hash FROM owner_auth`).Scan(&hash); err != nil || !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatal("password hash")
	}
	// Competing writers: exactly one revision advances. Operation retries never advance twice.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			next := w
			next.ExpectedRevision = 1
			next.OperationID = fmt.Sprintf("44444444-4444-4444-8444-%012d", i)
			_, err := s.Save(ctx, id, next)
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)
	success := 0
	conflicts := 0
	for err := range results {
		if err == nil {
			success++
		} else if _, ok := err.(*private.RecordConflict); ok {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("concurrent revision")
	}
	v, err := s.SetEnvelope(ctx, envelope, 1, "55555555-5555-4555-8555-555555555555")
	if err != nil || v.Revision != 2 {
		t.Fatal("envelope update", err)
	}
	v, err = s.SetEnvelope(ctx, envelope, 1, "55555555-5555-4555-8555-555555555555")
	if err != nil || v.Revision != 2 {
		t.Fatal("envelope retry", err)
	}
	if _, err = s.SetEnvelope(ctx, envelope, 1, "66666666-6666-4666-8666-666666666666"); err != private.ErrConflict {
		t.Fatal("stale envelope")
	}
	// Reopening a connection keeps encrypted records and the envelope intact.
	reopened, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	records, _, err := (&private.Store{Pool: reopened}).Records(ctx, "")
	if err != nil || len(records) != 1 || records[0].Revision != 2 {
		t.Fatal("restart persistence", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE sessions SET expires_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", "/api/vault", nil, true).Code; got != 401 {
		t.Fatal("expired session accepted")
	}
	decodeProfile(request("GET", "/api/auth/session", nil, true))
	if got := request("POST", "/api/auth/login", map[string]string{"password": "wrong password"}, true).Code; got != 401 {
		t.Fatal("wrong login accepted")
	}
	decodeProfile(request("POST", "/api/auth/login", map[string]string{"password": "synthetic login password"}, true))
	if got := request("POST", "/api/auth/login", map[string]string{"password": "wrong password"}, true).Code; got != 401 {
		t.Fatalf("throttle count %d", got)
	}
	if got := request("POST", "/api/auth/login", map[string]string{"password": "wrong password"}, true).Code; got != 429 {
		t.Fatalf("throttle bypass %d", got)
	}
	if err = s.ResetLogin(ctx, "replacement synthetic login"); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", "/api/vault", nil, true).Code; got != 401 {
		t.Fatal("reset did not revoke")
	}
	persisted, err := s.Vault(ctx)
	if err != nil || persisted.Revision != 2 {
		t.Fatal("reset altered vault")
	}
	decodeProfile(request("GET", "/api/auth/session", nil, true))
	decodeProfile(request("POST", "/api/auth/login", map[string]string{"password": "replacement synthetic login"}, true))
	if got := request("POST", "/api/auth/logout", map[string]string{}, true).Code; got != 204 {
		t.Fatal("logout")
	}
	if got := request("GET", "/api/entries", nil, true).Code; got != 401 {
		t.Fatal("logout did not revoke")
	}
	// Echo's access logger is intentionally not installed: request bodies/keys are never logged.
}
