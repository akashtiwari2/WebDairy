package cloud

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type memorySecrets struct {
	mu     sync.Mutex
	values map[string]string
	fail   bool
}

func (m *memorySecrets) Get(k string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[k]
	if !ok {
		return "", errors.New("missing")
	}
	return v, nil
}
func (m *memorySecrets) Set(k, v string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail {
		return errors.New("locked")
	}
	m.values[k] = v
	return nil
}
func (m *memorySecrets) Delete(k string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.values, k)
	return nil
}
func TestOAuthAndDrive(t *testing.T) {
	var uploads, refreshes int
	verified := true
	subject := "owner-subject"
	files := []File{}
	bodies := map[string][]byte{}
	deleted := []string{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/token":
			r.ParseForm()
			if r.Form.Get("grant_type") == "authorization_code" && r.Form.Get("code_verifier") == "" {
				t.Error("missing PKCE")
				w.WriteHeader(400)
				return
			}
			if r.Form.Get("grant_type") == "refresh_token" {
				refreshes++
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "synthetic-access", "refresh_token": "synthetic-refresh", "expires_in": 3600, "token_type": "Bearer", "scope": "openid email " + DriveScope})
		case "/userinfo":
			if r.Header.Get("Authorization") != "Bearer synthetic-access" {
				w.WriteHeader(401)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"sub": subject, "email": "synthetic@example.test", "email_verified": verified})
		case "/files":
			if r.Header.Get("Authorization") != "Bearer synthetic-access" {
				w.WriteHeader(401)
				return
			}
			if r.URL.Query().Get("spaces") != "appDataFolder" {
				t.Error("must restrict to private app folder")
			}
			json.NewEncoder(w).Encode(map[string]any{"files": files})
		case "/upload":
			_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			parts := multipart.NewReader(r.Body, params["boundary"])
			part, _ := parts.NextPart()
			meta, _ := io.ReadAll(part)
			var metadata struct {
				Properties map[string]string `json:"appProperties"`
				Parents    []string          `json:"parents"`
			}
			json.Unmarshal(meta, &metadata)
			if len(metadata.Parents) != 1 || metadata.Parents[0] != "appDataFolder" {
				t.Error("wrong upload parent")
			}
			part, _ = parts.NextPart()
			data, _ := io.ReadAll(part)
			sum := md5.Sum(data)
			uploads++
			f := File{ID: "uploaded_" + metadata.Properties["operation_id"], Created: time.Now().UTC().Format(time.RFC3339Nano), MD5: hex.EncodeToString(sum[:]), Properties: metadata.Properties}
			files = append(files, f)
			bodies[f.ID] = data
			json.NewEncoder(w).Encode(f)
		default:
			id := strings.TrimPrefix(r.URL.Path, "/files/")
			if r.Method == "DELETE" {
				deleted = append(deleted, id)
				w.WriteHeader(204)
				return
			}
			if data, ok := bodies[id]; ok {
				w.Write(data)
			} else {
				w.WriteHeader(404)
			}
		}
	}))
	defer provider.Close()
	g := New("synthetic-client", "synthetic-client-secret")
	store := &memorySecrets{values: map[string]string{}}
	g.Secrets = store
	g.TokenURL = provider.URL + "/token"
	g.UserURL = provider.URL + "/userinfo"
	g.DriveURL = provider.URL + "/files"
	g.UploadURL = provider.URL + "/upload"
	state, link, err := g.Start("login", "", "", "", "http://127.0.0.1:4200")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(link)
	if strings.Contains(parsed.Query().Get("scope"), DriveScope) || parsed.Query().Get("code_challenge_method") != "S256" || parsed.Query().Get("code_challenge") == "" {
		t.Fatal("login scope/PKCE invalid")
	}
	if _, err = g.Take("bad-state"); err == nil {
		t.Fatal("invalid state accepted")
	}
	flow, err := g.Take(state)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Take(state); err == nil {
		t.Fatal("state replay accepted")
	}
	if done, _ := g.Result(state); done {
		t.Fatal("callback was marked completed before verification")
	}
	driveState, driveLink, e := g.Start("drive", subject, "", "", "http://127.0.0.1:4200")
	if e != nil {
		t.Fatal(e)
	}
	u, _ := url.Parse(driveLink)
	if !strings.Contains(u.Query().Get("scope"), DriveScope) || u.Query().Get("access_type") != "offline" {
		t.Fatal("Drive consent scope missing")
	}
	g.Cancel(driveState)
	if _, e = g.Take(driveState); e == nil {
		t.Fatal("cancelled flow accepted")
	}
	identity, credentials, err := g.Exchange(context.Background(), flow, "synthetic-code")
	if err != nil || identity.Subject != subject {
		t.Fatal("identity not verified", err)
	}
	verified = false
	if _, _, err = g.Exchange(context.Background(), flow, "synthetic-code"); err == nil {
		t.Fatal("unverified email accepted")
	}
	verified = true
	flow.Subject = "foreign-owner"
	if _, _, err = g.Exchange(context.Background(), flow, "synthetic-code"); err == nil {
		t.Fatal("foreign subject accepted")
	}
	store.fail = true
	if err = g.Save(subject, credentials); !errors.Is(err, ErrKeyring) {
		t.Fatal("keyring failure silently accepted")
	}
	store.fail = false
	credentials.Expiry = time.Now().Add(-time.Hour)
	if err = g.Save(subject, credentials); err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"ciphertext":"synthetic-encrypted-bytes"}`)
	ctx := context.Background()
	file, err := g.Upload(ctx, subject, "operation_1", "vault_A", "2026-10-12T00:00:00Z", data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Upload(ctx, subject, "operation_1", "vault_A", "2026-10-12T00:00:00Z", data); err != nil || uploads != 1 {
		t.Fatal("retry created duplicate")
	}
	if _, err = g.Upload(ctx, subject, "operation_1", "vault_A", "2026-10-12T00:00:00Z", []byte("changed")); err == nil {
		t.Fatal("changed retry payload accepted")
	}
	if refreshes != 1 {
		t.Fatal("expiry did not refresh once")
	}
	downloaded, err := g.Download(ctx, subject, file.ID, 1024)
	if err != nil || string(downloaded) != string(data) {
		t.Fatal("download mismatch")
	}
	if _, err = g.Download(ctx, subject, "foreign-file", 1024); err == nil {
		t.Fatal("unlisted file downloaded")
	}
	for i, id := range []string{"old_1", "old_2", "old_3", "other_vault"} {
		vault := "vault_A"
		if i == 3 {
			vault = "vault_B"
		}
		files = append(files, File{ID: id, Created: "2020-01-01T00:00:00Z", Properties: map[string]string{"webdiary": "1", "vault_id": vault}})
	}
	if err = g.Prune(ctx, subject, "vault_A", 3); err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0] == "other_vault" || deleted[0] == file.ID {
		t.Fatal("unsafe retention", deleted)
	}
	if err = g.Disconnect(subject); err != nil || g.Connected(subject) {
		t.Fatal("disconnect did not remove credential")
	}
}
