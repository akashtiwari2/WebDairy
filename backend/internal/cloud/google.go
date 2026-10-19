// Package cloud handles Google OAuth and opaque Drive files. Vault keys and
// decrypted diary content never enter this package. Tokens only use an OS keyring.
package cloud

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/zalando/go-keyring"
)

var ErrReconnect = errors.New("Google permission expired or unavailable; reconnect Google Drive")
var ErrKeyring = errors.New("OS credential storage is unavailable; unlock your keychain and retry; tokens were not saved to disk")
var ErrAccount = errors.New("Choose the Google account already linked to this diary")
var ErrOAuth = errors.New("Google sign-in was not completed or verified; retry sign-in")

type Identity struct {
	Subject  string `json:"sub"`
	Email    string `json:"email"`
	Verified bool   `json:"email_verified"`
}
type Credentials struct {
	Access  string    `json:"access_token"`
	Refresh string    `json:"refresh_token"`
	Scope   string    `json:"scope"`
	Expiry  time.Time `json:"expiry"`
}
type SecretStore interface {
	Get(string) (string, error)
	Set(string, string) error
	Delete(string) error
}
type OSStore struct{}

func (OSStore) Get(k string) (string, error) { return keyring.Get("WebDairy Google", k) }
func (OSStore) Set(k, v string) error        { return keyring.Set("WebDairy Google", k, v) }
func (OSStore) Delete(k string) error        { return keyring.Delete("WebDairy Google", k) }

type Flow struct {
	State, Verifier, Nonce, Purpose, Subject, Session, CSRF, Origin string
	Identity                                                        Identity
	Expires                                                         time.Time
	Done, Used, Cancelled                                           bool
	Failure                                                         string
}
type Google struct {
	ClientID, ClientSecret                          string
	HTTP                                            *http.Client
	Secrets                                         SecretStore
	AuthURL, TokenURL, UserURL, DriveURL, UploadURL string
	mu                                              sync.Mutex
	tokenMu                                         sync.Mutex
	uploadMu                                        sync.Mutex
	flows                                           map[string]*Flow
	proofs                                          map[string]struct {
		Identity Identity
		Expires  time.Time
	}
}

const DriveScope = "https://www.googleapis.com/auth/drive.appdata"
const Redirect = "http://127.0.0.1:47831/api/google/callback"

func New(id, secret string) *Google {
	return &Google{ClientID: id, ClientSecret: secret, HTTP: &http.Client{Timeout: 60 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}, Secrets: OSStore{},
		AuthURL: "https://accounts.google.com/o/oauth2/v2/auth", TokenURL: "https://oauth2.googleapis.com/token", UserURL: "https://openidconnect.googleapis.com/v1/userinfo",
		DriveURL: "https://www.googleapis.com/drive/v3/files", UploadURL: "https://www.googleapis.com/upload/drive/v3/files", flows: map[string]*Flow{}, proofs: map[string]struct {
			Identity Identity
			Expires  time.Time
		}{}}
}
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure randomness unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (g *Google) key(subject string) string {
	h := sha256.Sum256([]byte(g.ClientID + "|" + subject))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
func (g *Google) Start(purpose, subject, session, csrf, origin string) (string, string, error) {
	if g.ClientID == "" {
		return "", "", errors.New("Google OAuth is not configured; follow docs/google-setup.md")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for id, f := range g.flows {
		if time.Now().After(f.Expires) {
			delete(g.flows, id)
		}
	}
	for id, p := range g.proofs {
		if time.Now().After(p.Expires) {
			delete(g.proofs, id)
		}
	}
	if len(g.flows) >= 8 {
		return "", "", errors.New("Too many pending Google sign-ins; close other tabs and retry later")
	}
	f := &Flow{State: token(), Verifier: token(), Nonce: token(), Purpose: purpose, Subject: subject, Session: session, CSRF: csrf, Origin: origin, Expires: time.Now().Add(10 * time.Minute)}
	g.flows[f.State] = f
	challenge := sha256.Sum256([]byte(f.Verifier))
	scope := "openid email"
	if purpose == "drive" {
		scope += " " + DriveScope
	}
	q := url.Values{"client_id": {g.ClientID}, "redirect_uri": {Redirect}, "response_type": {"code"}, "scope": {scope}, "state": {f.State}, "nonce": {f.Nonce}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "prompt": {"select_account"}}
	if purpose == "drive" {
		q.Set("access_type", "offline")
		q.Set("prompt", "consent select_account")
	}
	return f.State, g.AuthURL + "?" + q.Encode(), nil
}
func (g *Google) Take(state string) (Flow, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flows[state]
	if f == nil || f.Used || time.Now().After(f.Expires) {
		return Flow{}, ErrOAuth
	}
	f.Used = true // One-use even if exchange fails.
	return *f, nil
}
func (g *Google) Cancel(state string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if f := g.flows[state]; f != nil {
		f.Used = true
		f.Done = true
		f.Cancelled = true
		f.Failure = "Google connection cancelled"
	}
}
func (g *Google) Cancelled(state string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flows[state]
	return f == nil || f.Cancelled
}
func (g *Google) Result(state string) (bool, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	f := g.flows[state]
	if f == nil || time.Now().After(f.Expires) {
		return false, ""
	}
	return f.Done, f.Failure
}
func (g *Google) Finish(state string, identity Identity, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if f := g.flows[state]; f != nil && !f.Cancelled {
		f.Identity = identity
		f.Done = true
		if err != nil {
			f.Failure = err.Error()
		}
	}
}
func (g *Google) Proof(ticket string) (Identity, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.proofs[ticket]
	return p.Identity, ok && time.Now().Before(p.Expires)
}
func (g *Google) GrantProof(identity Identity) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	t := token()
	g.proofs[t] = struct {
		Identity Identity
		Expires  time.Time
	}{identity, time.Now().Add(10 * time.Minute)}
	return t
}
func (g *Google) ClearProof(ticket string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.proofs, ticket)
}
func (g *Google) decode(ctx context.Context, method, path string, body io.Reader, access, content string, out any, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, method, path, body)
	if err != nil {
		return ErrReconnect
	}
	if access != "" {
		req.Header.Set("Authorization", "Bearer "+access)
	}
	if content != "" {
		req.Header.Set("Content-Type", content)
	}
	response, err := g.HTTP.Do(req)
	if err != nil {
		return ErrReconnect
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ErrReconnect
	}
	if out == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return ErrReconnect
	}
	if json.Unmarshal(data, out) != nil {
		return ErrReconnect
	}
	return nil
}
func (g *Google) exchange(ctx context.Context, values url.Values) (Credentials, error) {
	values.Set("client_id", g.ClientID)
	if g.ClientSecret != "" {
		values.Set("client_secret", g.ClientSecret)
	}
	var r struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Scope   string `json:"scope"`
		Expires int    `json:"expires_in"`
		Type    string `json:"token_type"`
	}
	if err := g.decode(ctx, "POST", g.TokenURL, strings.NewReader(values.Encode()), "", "application/x-www-form-urlencoded", &r, 65536); err != nil {
		return Credentials{}, err
	}
	if r.Access == "" || !strings.EqualFold(r.Type, "Bearer") || r.Expires < 1 {
		return Credentials{}, ErrOAuth
	}
	return Credentials{Access: r.Access, Refresh: r.Refresh, Scope: r.Scope, Expiry: time.Now().Add(time.Duration(r.Expires) * time.Second)}, nil
}
func (g *Google) Exchange(ctx context.Context, f Flow, code string) (Identity, Credentials, error) {
	if code == "" || len(code) > 8192 {
		return Identity{}, Credentials{}, ErrOAuth
	}
	credentials, err := g.exchange(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {Redirect}, "code_verifier": {f.Verifier}})
	if err != nil {
		return Identity{}, Credentials{}, ErrOAuth
	}
	// Identity is fetched directly from Google's authenticated userinfo endpoint,
	// not accepted from browser input or an unverified JWT/email claim.
	var identity Identity
	if err = g.decode(ctx, "GET", g.UserURL, nil, credentials.Access, "", &identity, 65536); err != nil || identity.Subject == "" || len(identity.Subject) > 255 || identity.Email == "" || len(identity.Email) > 320 || !identity.Verified {
		return Identity{}, Credentials{}, ErrOAuth
	}
	if f.Subject != "" && f.Subject != identity.Subject {
		return Identity{}, Credentials{}, ErrAccount
	}
	return identity, credentials, nil
}
func (g *Google) Save(subject string, c Credentials) error {
	g.tokenMu.Lock()
	defer g.tokenMu.Unlock()
	return g.save(subject, c)
}
func (g *Google) save(subject string, c Credentials) error {
	if !strings.Contains(" "+c.Scope+" ", " "+DriveScope+" ") || c.Refresh == "" {
		return errors.New("Google Drive offline permission was not granted; reconnect and approve backup access")
	}
	b, _ := json.Marshal(c)
	if g.Secrets.Set(g.key(subject), string(b)) != nil {
		return ErrKeyring
	}
	return nil
}
func (g *Google) Connected(subject string) bool {
	if subject == "" {
		return false
	}
	v, e := g.Secrets.Get(g.key(subject))
	var c Credentials
	return e == nil && json.Unmarshal([]byte(v), &c) == nil && c.Refresh != ""
}
func (g *Google) Disconnect(subject string) error {
	g.tokenMu.Lock()
	defer g.tokenMu.Unlock()
	if err := g.Secrets.Delete(g.key(subject)); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return ErrKeyring
	}
	return nil
}
func (g *Google) access(ctx context.Context, subject string) (string, error) {
	g.tokenMu.Lock()
	defer g.tokenMu.Unlock()
	value, err := g.Secrets.Get(g.key(subject))
	var c Credentials
	if err != nil || json.Unmarshal([]byte(value), &c) != nil {
		return "", ErrReconnect
	}
	if time.Now().Add(time.Minute).Before(c.Expiry) {
		return c.Access, nil
	}
	refreshed, err := g.exchange(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.Refresh}})
	if err != nil {
		return "", ErrReconnect
	}
	if refreshed.Refresh == "" {
		refreshed.Refresh = c.Refresh
	}
	if refreshed.Scope == "" {
		refreshed.Scope = c.Scope
	}
	if err = g.save(subject, refreshed); err != nil {
		return "", err
	}
	return refreshed.Access, nil
}
