package private

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/argon2"
)

var ErrUnauthenticated = errors.New("authentication required")
var ErrLimited = errors.New("try again later")
var ErrConflict = errors.New("revision conflict")
var ErrNotFound = errors.New("not found")

const passwordMemory = 65536
const passwordIterations = 3

func PasswordHash(password string) (string, error) {
	if len(password) < 12 || len(password) > 1024 {
		return "", errors.New("login password must be 12 to 1024 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	digest := argon2.IDKey([]byte(password), salt, passwordIterations, passwordMemory, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(digest)), nil
}
func VerifyPassword(password, encoded string) bool {
	if len(password) > 1024 {
		return false
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=65536,t=3,p=1" {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) != 16 {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(expected) != 32 {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, passwordIterations, passwordMemory, 1, 32)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}
func Token() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
func ValidToken(token string) bool {
	b, e := base64.RawURLEncoding.DecodeString(token)
	return e == nil && len(b) == 32
}
func TokenHash(token string) []byte { digest := sha256.Sum256([]byte(token)); return digest[:] }

func (s *Store) Initialized(ctx context.Context) (bool, error) {
	var initialized bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM owner_auth)`).Scan(&initialized)
	return initialized, err
}
func (s *Store) LoginAllowed(ctx context.Context) error {
	var count int
	err := s.Pool.QueryRow(ctx, `INSERT INTO auth_throttle(name,attempts,window_start) VALUES('login',1,now())
 ON CONFLICT(name) DO UPDATE SET
 attempts=CASE WHEN auth_throttle.window_start<now()-interval '1 minute' THEN 1 ELSE auth_throttle.attempts+1 END,
 window_start=CASE WHEN auth_throttle.window_start<now()-interval '1 minute' THEN now() ELSE auth_throttle.window_start END RETURNING attempts`).Scan(&count)
	if err != nil {
		return err
	}
	if count > 5 {
		return ErrLimited
	}
	return nil
}
func (s *Store) CheckPassword(ctx context.Context, password string) error {
	if err := s.LoginAllowed(ctx); err != nil {
		return err
	}
	var hash string
	err := s.Pool.QueryRow(ctx, `SELECT password_hash FROM owner_auth WHERE id=true`).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthenticated
	}
	if err != nil {
		return err
	}
	if !VerifyPassword(password, hash) {
		return ErrUnauthenticated
	}
	return nil
}
func (s *Store) NewSession(ctx context.Context) (string, string, error) {
	token, err := Token()
	if err != nil {
		return "", "", err
	}
	csrf, err := Token()
	if err != nil {
		return "", "", err
	}
	_, err = s.Pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at<=now() OR absolute_expiry<=now()`)
	if err != nil {
		return "", "", err
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO sessions(token_hash,csrf_hash,expires_at,absolute_expiry) VALUES($1,$2,now()+interval '30 minutes',now()+interval '24 hours')`, TokenHash(token), TokenHash(csrf))
	return token, csrf, err
}
func (s *Store) Authenticate(ctx context.Context, token, csrf string) error {
	if !ValidToken(token) || !ValidToken(csrf) {
		return ErrUnauthenticated
	}
	result, err := s.Pool.Exec(ctx, `UPDATE sessions SET expires_at=LEAST(now()+interval '30 minutes',absolute_expiry)
 WHERE token_hash=$1 AND csrf_hash=$2 AND expires_at>now() AND absolute_expiry>now()`, TokenHash(token), TokenHash(csrf))
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrUnauthenticated
	}
	return nil
}
func (s *Store) Logout(ctx context.Context, token string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, TokenHash(token))
	return err
}
func (s *Store) ResetLogin(ctx context.Context, password string) error {
	hash, err := PasswordHash(password)
	if err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	result, err := tx.Exec(ctx, `UPDATE owner_auth SET password_hash=$1 WHERE id=true`, hash)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err = tx.Exec(ctx, `DELETE FROM sessions`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM auth_throttle`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
