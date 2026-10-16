package server

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"github.com/akashtiwari2/WebDairy/backend/internal/cloud"
	"github.com/akashtiwari2/WebDairy/backend/internal/database"
	"github.com/akashtiwari2/WebDairy/backend/internal/private"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type googleTransport func(*http.Request) (*http.Response, error)

func (f googleTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type googleTestSecrets map[string]string

func (m googleTestSecrets) Get(k string) (string, error) {
	v, ok := m[k]
	if !ok {
		return "", cloud.ErrReconnect
	}
	return v, nil
}
func (m googleTestSecrets) Set(k, v string) error { m[k] = v; return nil }
func (m googleTestSecrets) Delete(k string) error { delete(m, k); return nil }
func TestGoogleWorkflow(t *testing.T) {
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
	const schema = "phase4_google_test"
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = database.Migrate(ctx, pool, filepath.Join("..", "..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	s := &private.Store{Pool: pool}
	g := cloud.New("synthetic-client", "")
	g.Secrets = googleTestSecrets{}
	providerSubject := "google-owner"
	providerScope := "openid email"
	driveFiles := []cloud.File{}
	failDrive := false
	g.HTTP = &http.Client{Transport: googleTransport(func(req *http.Request) (*http.Response, error) {
		var result any = map[string]any{"access_token": "synthetic-access", "refresh_token": "synthetic-refresh", "token_type": "Bearer", "expires_in": 3600, "scope": providerScope}
		status := 200
		switch {
		case strings.HasSuffix(req.URL.Path, "userinfo"):
			result = map[string]any{"sub": providerSubject, "email": "owner@example.test", "email_verified": true}
		case strings.Contains(req.URL.Path, "drive/v3/files"):
			if req.Header.Get("Authorization") != "Bearer synthetic-access" {
				t.Error("Drive token missing")
			}
			if failDrive {
				status = 503
				result = map[string]string{"private_provider_error": "must not leak"}
				break
			}
			if req.Method == "POST" {
				_, params, _ := mime.ParseMediaType(req.Header.Get("Content-Type"))
				parts := multipart.NewReader(req.Body, params["boundary"])
				part, _ := parts.NextPart()
				metadata, _ := io.ReadAll(part)
				var meta struct {
					Properties map[string]string `json:"appProperties"`
				}
				json.Unmarshal(metadata, &meta)
				part, _ = parts.NextPart()
				data, _ := io.ReadAll(part)
				hash := md5.Sum(data)
				file := cloud.File{ID: "mock_drive_file", Created: time.Now().UTC().Format(time.RFC3339Nano), MD5: hex.EncodeToString(hash[:]), Properties: meta.Properties}
				driveFiles = append(driveFiles, file)
				result = file
			} else {
				result = map[string]any{"files": driveFiles}
			}
		}
		body, _ := json.Marshal(result)
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})}
	e := New(pool.Ping, s, g)
	cookies := map[string]*http.Cookie{}
	csrf := ""
	request := func(method, path string, value any, secure bool) *httptest.ResponseRecorder {
		data, _ := json.Marshal(value)
		req := httptest.NewRequest(method, "http://127.0.0.1:4300"+path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		if secure {
			req.Header.Set("Origin", "http://127.0.0.1:4300")
			req.Header.Set("X-CSRF-Token", csrf)
			for _, c := range cookies {
				req.AddCookie(c)
			}
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		for _, c := range rec.Result().Cookies() {
			cookies[c.Name] = c
		}
		return rec
	}
	profile := func() {
		r := request("GET", "/api/auth/session", nil, true)
		if r.Code != 200 {
			t.Fatal("session", r.Code)
		}
		var p struct {
			CSRF string `json:"csrf_token"`
		}
		json.Unmarshal(r.Body.Bytes(), &p)
		csrf = p.CSRF
	}
	profile()
	oauthLogin := func() {
		started := request("POST", "/api/google/start", map[string]string{"purpose": "login"}, true)
		if started.Code != 200 {
			t.Fatal("OAuth start", started.Code, started.Body)
		}
		var response struct {
			URL string `json:"url"`
		}
		json.Unmarshal(started.Body.Bytes(), &response)
		u, _ := url.Parse(response.URL)
		if strings.Contains(u.Query().Get("scope"), cloud.DriveScope) || u.Query().Get("code_challenge") == "" {
			t.Fatal("unsafe login scope/PKCE")
		}
		req := httptest.NewRequest("GET", "http://127.0.0.1:8080/api/google/callback?state="+u.Query().Get("state")+"&code=synthetic-code", nil)
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatal("OAuth callback", rec.Code, rec.Body)
		}
		for _, cookie := range rec.Result().Cookies() {
			cookies[cookie.Name] = cookie
		}
		if strings.Contains(rec.Body.String(), "synthetic-access") {
			t.Fatal("token exposed")
		}
		replay := httptest.NewRecorder()
		e.ServeHTTP(replay, req)
		if replay.Code != 400 {
			t.Fatal("OAuth replay accepted")
		}
		profile()
	}
	b64 := func(n int) string { return base64.StdEncoding.EncodeToString(make([]byte, n)) }
	envelope := private.Envelope{FormatVersion: 1, VaultID: "12345678-1234-4234-8234-123456789012", Passphrase: private.PasswordEnvelope{KDF: private.KDF{Algorithm: "argon2id", Version: 19, Memory: 65536, Iterations: 3, Parallelism: 1, Salt: b64(16)}, Nonce: b64(12), Ciphertext: b64(48)}, Recovery: private.RecoveryEnvelope{Algorithm: "HKDF-SHA256", Salt: b64(16), Nonce: b64(12), Ciphertext: b64(48)}}
	setup := map[string]any{"login_password": "", "envelope": envelope, "use_google": true}
	if r := request("POST", "/api/auth/setup", setup, true); r.Code != 400 {
		t.Fatal("passwordless setup without Google proof", r.Code)
	}
	oauthLogin()
	localChoice := map[string]any{"login_password": "synthetic local choice password", "envelope": envelope, "use_google": false}
	localResult := request("POST", "/api/auth/setup", localChoice, true)
	if localResult.Code != 200 {
		t.Fatal("explicit local mode", localResult.Code, localResult.Body)
	}
	if has, _ := s.HasPassword(ctx); !has {
		t.Fatal("Google proof silently replaced chosen local password")
	}
	if linked, _ := s.GoogleIdentity(ctx); linked.Subject != "" {
		t.Fatal("local setup silently linked Google")
	}
	if _, err = pool.Exec(ctx, `TRUNCATE sessions,owner_auth,vaults CASCADE`); err != nil {
		t.Fatal(err)
	}
	profile()
	oauthLogin()
	r := request("POST", "/api/auth/setup", setup, true)
	if r.Code != 200 {
		t.Fatal("Google setup", r.Code, r.Body)
	}
	profile()
	identity, err := s.GoogleIdentity(ctx)
	if err != nil || identity.Subject != "google-owner" {
		t.Fatal("Google identity not bound")
	}
	// Separate Drive consent persists credentials only in the injected test keyring.
	consent := request("POST", "/api/google/start", map[string]string{"purpose": "drive"}, true)
	if consent.Code != 200 {
		t.Fatal("Drive start", consent.Code, consent.Body)
	}
	var authLink struct {
		URL string `json:"url"`
	}
	json.Unmarshal(consent.Body.Bytes(), &authLink)
	authURL, _ := url.Parse(authLink.URL)
	if !strings.Contains(authURL.Query().Get("scope"), cloud.DriveScope) {
		t.Fatal("separate Drive scope missing")
	}
	providerScope = "openid email " + cloud.DriveScope
	callback := httptest.NewRequest("GET", "http://127.0.0.1:8080/api/google/callback?state="+authURL.Query().Get("state")+"&code=synthetic-drive-code", nil)
	callback.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, callback)
	if rec.Code != 200 {
		t.Fatal("Drive callback", rec.Code, rec.Body)
	}
	archive := private.Archive{Format: "webdiary-backup", Version: 1, VaultID: envelope.VaultID, Envelope: envelope, Salt: b64(16), Nonce: b64(12), Ciphertext: b64(32)}
	upload := map[string]any{"operation_id": "33333333-3333-4333-8333-333333333333", "archive": archive, "snapshot_at": time.Now().UTC().Format(time.RFC3339Nano), "keep": 3}
	if r = request("POST", "/api/drive/upload", upload, true); r.Code != 200 {
		t.Fatal("Drive upload", r.Code, r.Body)
	}
	if r = request("POST", "/api/drive/upload", upload, true); r.Code != 200 || len(driveFiles) != 1 {
		t.Fatal("Drive retry duplicate", r.Code)
	}
	if r = request("GET", "/api/google/status", nil, true); strings.Contains(r.Body.String(), "synthetic-access") || strings.Contains(r.Body.String(), "synthetic-refresh") {
		t.Fatal("OAuth tokens exposed")
	}
	failDrive = true
	if r = request("POST", "/api/drive/upload", upload, true); r.Code != 503 || len(driveFiles) != 1 || strings.Contains(r.Body.String(), "must not leak") {
		t.Fatal("failed upload changed backup state or leaked provider errors")
	}
	failDrive = false
	if has, _ := s.HasPassword(ctx); has {
		t.Fatal("unexpected local password")
	}
	if err = s.LinkGoogle(ctx, "foreign-owner", "foreign@example.test"); err != private.ErrConflict {
		t.Fatal("foreign account replaced owner")
	}
	if r = request("POST", "/api/google/start", map[string]string{"purpose": "drive"}, false); r.Code != 403 {
		t.Fatal("Drive consent CSRF bypass")
	}
	if r = request("POST", "/api/auth/offline-password", map[string]string{"password": "synthetic offline password"}, true); r.Code != 204 {
		t.Fatal("offline password", r.Code, r.Body)
	}
	if err = s.CheckPassword(ctx, "synthetic offline password"); err != nil {
		t.Fatal("offline login rejected")
	}
	if r = request("POST", "/api/auth/offline-password", map[string]string{"password": "synthetic replacement password"}, true); r.Code != 409 {
		t.Fatal("existing password overwritten without verification")
	}
	// Only callback GET can arrive as a cross-site navigation, and still needs state.
	for _, path := range []string{"/api/google/callback?state=invalid", "/api/auth/session"} {
		req := httptest.NewRequest("GET", "http://127.0.0.1:8080"+path, nil)
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		want := 403
		if path != "/api/auth/session" {
			want = 400
		}
		if rec.Code != want {
			t.Fatal("cross-site exception", path, rec.Code)
		}
	}
	// Fresh-device restore must bind Google identity atomically with the new vault.
	if _, err = pool.Exec(ctx, `TRUNCATE sessions,owner_auth,vaults CASCADE`); err != nil {
		t.Fatal(err)
	}
	profile()
	providerSubject = "restored-google-owner"
	oauthLogin()
	stage := private.Stage{ID: "11111111-1111-4111-8111-111111111111", Envelope: envelope, Records: []private.Record{}}
	if r = request("POST", "/api/restore/stage", stage, true); r.Code != 200 {
		t.Fatal("fresh Google stage", r.Code, r.Body)
	}
	if r = request("POST", "/api/restore/commit", map[string]any{"stage_id": stage.ID, "use_google": true}, true); r.Code != 200 {
		t.Fatal("fresh Google restore", r.Code, r.Body)
	}
	identity, err = s.GoogleIdentity(ctx)
	if err != nil || identity.Subject != "restored-google-owner" {
		t.Fatal("restored Google identity missing")
	}
	if has, _ := s.HasPassword(ctx); has {
		t.Fatal("restore unexpectedly requires local password")
	}
	profile()
	if r = request("GET", "/api/vault", nil, true); r.Code != 200 {
		t.Fatal("fresh restore session missing")
	}
}
