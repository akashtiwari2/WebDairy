// Package entries stores synthetic plaintext data for the Phase 1 learning app.
// The encrypted entries/vaults tables are reserved for the private-vault milestone.
package entries

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("entry not found")

type Entry struct {
	Date      string    `json:"date"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Revision  int64     `json:"revision"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Write struct {
	Title            string `json:"title"`
	Body             string `json:"body"`
	ExpectedRevision int64  `json:"expected_revision"`
	OperationID      string `json:"operation_id"`
}

type Conflict struct{ Current *Entry }

func (*Conflict) Error() string { return "entry changed since it was loaded" }

type Repository interface {
	Dates(context.Context) ([]string, error)
	Get(context.Context, string) (Entry, error)
	Save(context.Context, string, Write) (Entry, error)
	Delete(context.Context, string, int64) error
}

type Store struct{ Pool *pgxpool.Pool }

const columns = `diary_date::text, title, body, revision, created_at, updated_at`

func scan(row pgx.Row) (Entry, error) {
	var entry Entry
	err := row.Scan(&entry.Date, &entry.Title, &entry.Body, &entry.Revision, &entry.CreatedAt, &entry.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return entry, ErrNotFound
	}
	return entry, err
}

func (s *Store) Dates(ctx context.Context) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT diary_date::text FROM development_entries WHERE NOT deleted ORDER BY diary_date`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	dates := []string{}
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			return nil, err
		}
		dates = append(dates, date)
	}
	return dates, rows.Err()
}

func (s *Store) Get(ctx context.Context, date string) (Entry, error) {
	return scan(s.Pool.QueryRow(ctx, `SELECT `+columns+` FROM development_entries WHERE diary_date=$1::date AND NOT deleted`, date))
}

func (s *Store) Save(ctx context.Context, date string, write Write) (Entry, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Entry{}, err
	}
	defer tx.Rollback(context.Background())
	encoded, err := json.Marshal(struct {
		Date  string
		Write Write
	}{date, write})
	if err != nil {
		return Entry{}, err
	}
	hash := sha256.Sum256(encoded)
	inserted, err := tx.Exec(ctx, `INSERT INTO development_entry_operations(operation_id,diary_date,request_hash)
	 VALUES($1::uuid,$2::date,$3) ON CONFLICT (operation_id) DO NOTHING`, write.OperationID, date, hash[:])
	if err != nil {
		return Entry{}, err
	}
	if inserted.RowsAffected() == 0 {
		var originalHash []byte
		var revision int64
		if err := tx.QueryRow(ctx, `SELECT request_hash,result_revision FROM development_entry_operations WHERE operation_id=$1::uuid`, write.OperationID).Scan(&originalHash, &revision); err != nil {
			return Entry{}, err
		}
		current, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM development_entries WHERE diary_date=$1::date AND NOT deleted`, date))
		if errors.Is(err, ErrNotFound) {
			return Entry{}, &Conflict{}
		}
		if err != nil {
			return Entry{}, err
		}
		if bytes.Equal(originalHash, hash[:]) && current.Revision == revision && current.Title == write.Title && current.Body == write.Body {
			return current, nil
		}
		return Entry{}, &Conflict{Current: &current}
	}
	var entry Entry
	if write.ExpectedRevision == 0 {
		entry, err = scan(tx.QueryRow(ctx, `INSERT INTO development_entries(diary_date,title,body,operation_id)
		 VALUES ($1::date,$2,$3,$4::uuid) ON CONFLICT (diary_date) DO UPDATE
		 SET title=EXCLUDED.title,body=EXCLUDED.body,operation_id=EXCLUDED.operation_id,
		 revision=development_entries.revision+1,deleted=false,created_at=now(),updated_at=now()
		 WHERE development_entries.deleted RETURNING `+columns,
			date, write.Title, write.Body, write.OperationID))
	} else {
		entry, err = scan(tx.QueryRow(ctx, `UPDATE development_entries SET title=$2,body=$3,
		 revision=revision+1,operation_id=$4::uuid,updated_at=now()
		 WHERE diary_date=$1::date AND revision=$5 AND NOT deleted RETURNING `+columns,
			date, write.Title, write.Body, write.OperationID, write.ExpectedRevision))
	}
	if !errors.Is(err, ErrNotFound) {
		if err != nil {
			return Entry{}, err
		}
		if _, err := tx.Exec(ctx, `UPDATE development_entry_operations SET result_revision=$2 WHERE operation_id=$1::uuid`, write.OperationID, entry.Revision); err != nil {
			return Entry{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Entry{}, err
		}
		return entry, nil
	}
	current, err := scan(tx.QueryRow(ctx, `SELECT `+columns+` FROM development_entries WHERE diary_date=$1::date AND NOT deleted`, date))
	if errors.Is(err, ErrNotFound) {
		return Entry{}, &Conflict{}
	}
	if err != nil {
		return Entry{}, err
	}
	return Entry{}, &Conflict{Current: &current}
}

func (s *Store) Delete(ctx context.Context, date string, revision int64) error {
	result, err := s.Pool.Exec(ctx, `UPDATE development_entries SET deleted=true,title='',body='',revision=revision+1,updated_at=now() WHERE diary_date=$1::date AND revision=$2 AND NOT deleted`, date, revision)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 1 {
		return nil
	}
	current, err := s.Get(ctx, date)
	if errors.Is(err, ErrNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return &Conflict{Current: &current}
}
