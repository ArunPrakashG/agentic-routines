package main

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Shared by every instance that could start at once; Postgres hands the lock to one at a time.
const migrationLock = 7_428_113_001

var errSignedOut = errors.New("signed out")

// A session lasts as long as it is used, but not past this: after a year the person signs in again.
const sessionMaxAge = 365 * 24 * time.Hour

type user struct {
	ID      string  `json:"id"`
	Email   string  `json:"email"`
	Name    string  `json:"name"`
	Picture *string `json:"picture"`
	Handle  *string `json:"handle"`
	Admin   bool    `json:"admin"`
}

type store struct{ db *pgxpool.Pool }

func openStore(ctx context.Context, url string) (*store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	// The Postgres here is shared with other apps, so stay small.
	cfg.MaxConns = 6
	cfg.MinConns = 1
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = time.Hour
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	// The database can still be starting when this does.
	var last error
	for i := 0; i < 30; i++ {
		if last = db.Ping(ctx); last == nil {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	if last != nil {
		return nil, last
	}
	s := &store{db}
	return s, s.migrate(ctx)
}

func (s *store) migrate(ctx context.Context) error {
	conn, err := s.db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLock); err != nil {
		return err
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLock)

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	files, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		return err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	for _, f := range files {
		var done bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)`, f.Name()).Scan(&done); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, err := migrationFiles.ReadFile("migrations/" + f.Name())
		if err != nil {
			return err
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		// A file holds several statements, which only the plain query protocol accepts.
		if _, err := tx.Conn().PgConn().Exec(ctx, string(sql)).ReadAll(); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("%s: %w", f.Name(), err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (name) VALUES ($1)`, f.Name()); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) ping(ctx context.Context) error { return s.db.Ping(ctx) }

// signIn finds or creates the user for a Google account and starts a session for this install,
// replacing any earlier one from the same install.
func (s *store) signIn(ctx context.Context, sub, email, name string, picture *string, install string, refresh []byte, expires time.Time) (u user, sessionID string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `
		INSERT INTO users (id, google_sub, email, name, picture) VALUES (gen_random_uuid(), $1, $2, $3, $4)
		ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, updated_at = now()
		RETURNING id::text, email, name, picture, handle`, sub, email, name, picture).
		Scan(&u.ID, &u.Email, &u.Name, &u.Picture, &u.Handle)
	if err != nil {
		return
	}
	if _, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1::uuid AND install_id = $2`, u.ID, install); err != nil {
		return
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, install_id, refresh_hash, expires_at) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4)
		RETURNING id::text`, u.ID, install, refresh, expires).Scan(&sessionID)
	if err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

// rotate swaps a refresh token for the next one. A token works once: seeing a used one again
// means two holders, so the whole session ends. Returns errSignedOut for any token it won't take.
func (s *store) rotate(ctx context.Context, used []byte, install string, next []byte, now, expires time.Time) (userID, sessionID string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	var current []byte
	var sessionInstall string
	var expiry, created time.Time
	err = tx.QueryRow(ctx, `
		SELECT id::text, user_id::text, install_id, refresh_hash, expires_at, created_at FROM sessions
		WHERE refresh_hash = $1 OR previous_hash = $1 FOR UPDATE`, used).
		Scan(&sessionID, &userID, &sessionInstall, &current, &expiry, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", errSignedOut
	}
	if err != nil {
		return
	}
	if !bytes.Equal(current, used) || sessionInstall != install || expiry.Before(now) || now.Sub(created) > sessionMaxAge {
		if _, err = tx.Exec(ctx, `DELETE FROM sessions WHERE id = $1::uuid`, sessionID); err != nil {
			return
		}
		if err = tx.Commit(ctx); err != nil {
			return
		}
		return "", "", errSignedOut
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET refresh_hash = $2, previous_hash = $1, expires_at = $3 WHERE id = $4::uuid`, used, next, expires, sessionID); err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

func (s *store) signOut(ctx context.Context, refresh []byte) error {
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE refresh_hash = $1`, refresh)
	return err
}

// me reads through the session, so signing out ends an access token straight away.
func (s *store) me(ctx context.Context, userID, sessionID string) (u user, err error) {
	err = s.db.QueryRow(ctx, `
		SELECT u.id::text, u.email, u.name, u.picture, u.handle
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = $1::uuid AND u.id = $2::uuid AND s.expires_at > now()`, sessionID, userID).
		Scan(&u.ID, &u.Email, &u.Name, &u.Picture, &u.Handle)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errSignedOut
	}
	return
}

func (s *store) deleteExpired(ctx context.Context) (int64, error) {
	t, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	return t.RowsAffected(), err
}
