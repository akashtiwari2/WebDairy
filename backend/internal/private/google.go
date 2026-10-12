package private

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

type GoogleIdentity struct {
	Subject string `json:"subject"`
	Email   string `json:"email"`
}

func (s *Store) GoogleIdentity(ctx context.Context) (GoogleIdentity, error) {
	var identity GoogleIdentity
	err := s.Pool.QueryRow(ctx, `SELECT subject,email FROM google_identity WHERE owner_id=true`).Scan(&identity.Subject, &identity.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return identity, nil
	}
	return identity, err
}
func (s *Store) LinkGoogle(ctx context.Context, subject, email string) error {
	if subject == "" || len(subject) > 255 || email == "" || len(email) > 320 {
		return ErrInvalid
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO google_identity(owner_id,subject,email) VALUES(true,$1,$2)
 ON CONFLICT(owner_id) DO UPDATE SET email=EXCLUDED.email WHERE google_identity.subject=EXCLUDED.subject`, subject, email)
	if err != nil {
		return err
	}
	identity, err := s.GoogleIdentity(ctx)
	if err != nil {
		return err
	}
	if identity.Subject != subject {
		return ErrConflict
	}
	return nil
}
func (s *Store) HasPassword(ctx context.Context) (bool, error) {
	var enabled bool
	err := s.Pool.QueryRow(ctx, `SELECT password_hash IS NOT NULL FROM owner_auth WHERE id=true`).Scan(&enabled)
	return enabled, err
}
func (s *Store) AddOfflinePassword(ctx context.Context, password string) error {
	hash, err := PasswordHash(password)
	if err != nil {
		return ErrInvalid
	}
	result, err := s.Pool.Exec(ctx, `UPDATE owner_auth SET password_hash=$1 WHERE id=true AND password_hash IS NULL`, hash)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrConflict
	}
	return nil
}
