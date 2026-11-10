package main

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"sort"
	"strings"
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
	// Verified is whether the email was vouched for by a provider or a mailed code. It never leaves the server.
	Verified bool `json:"-"`
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

// identity is one way a person proved who they are: a provider and its id for them.
type identity struct {
	Provider string // google, github, microsoft or password
	Subject  string
	Email    string
	// Verified says the provider vouched for the email. Microsoft does not, so its email is only shown.
	Verified bool
	Name     string
	Picture  *string
}

// signIn finds or creates the user for an identity and starts a session for this install, replacing any earlier
// one from the same install. A new identity with a verified email joins the account that already has that
// verified email, so one person who uses two providers keeps one account. An unverified email never joins anything.
// then, if given, runs in the same transaction before the session starts.
func (s *store) signIn(ctx context.Context, id identity, install string, refresh []byte, expires time.Time, then func(tx pgx.Tx, userID string) error) (u user, sessionID string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	email := strings.ToLower(strings.TrimSpace(id.Email))
	// Two first sign-ins with the same email at once must not make two accounts.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, email); err != nil {
		return
	}
	var userID string
	err = tx.QueryRow(ctx, `SELECT user_id::text FROM identities WHERE provider = $1 AND subject = $2`, id.Provider, id.Subject).Scan(&userID)
	switch {
	case err == nil:
		_, err = tx.Exec(ctx, `UPDATE identities SET email = $3, verified = $4 WHERE provider = $1 AND subject = $2`, id.Provider, id.Subject, email, id.Verified)
		if err == nil {
			_, err = tx.Exec(ctx, `
				UPDATE users SET name = COALESCE(NULLIF($2, ''), name), picture = COALESCE($3, picture),
					email = CASE WHEN $4 THEN $5 ELSE email END, email_verified = email_verified OR $4, updated_at = now()
				WHERE id = $1::uuid`, userID, id.Name, id.Picture, id.Verified, email)
		}
	case errors.Is(err, pgx.ErrNoRows):
		err = nil
		if id.Verified {
			err = tx.QueryRow(ctx, `SELECT user_id::text FROM identities WHERE verified AND lower(email) = $1 ORDER BY created_at LIMIT 1`, email).Scan(&userID)
			if errors.Is(err, pgx.ErrNoRows) {
				err = nil
			}
		}
		if err == nil && userID == "" {
			err = tx.QueryRow(ctx, `
				INSERT INTO users (id, email, name, picture, email_verified) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id::text`,
				email, id.Name, id.Picture, id.Verified).Scan(&userID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO identities (provider, subject, user_id, email, verified) VALUES ($1, $2, $3::uuid, $4, $5)`,
				id.Provider, id.Subject, userID, email, id.Verified)
		}
	}
	if err != nil {
		return
	}
	if then != nil {
		if err = then(tx, userID); err != nil {
			return
		}
	}
	if u, sessionID, err = startSession(ctx, tx, userID, install, refresh, expires); err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

func startSession(ctx context.Context, tx pgx.Tx, userID, install string, refresh []byte, expires time.Time) (u user, sessionID string, err error) {
	err = tx.QueryRow(ctx, `SELECT id::text, email, name, picture, handle, email_verified FROM users WHERE id = $1::uuid`, userID).
		Scan(&u.ID, &u.Email, &u.Name, &u.Picture, &u.Handle, &u.Verified)
	if err != nil {
		return
	}
	if _, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1::uuid AND install_id = $2`, u.ID, install); err != nil {
		return
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, install_id, refresh_hash, expires_at) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4)
		RETURNING id::text`, u.ID, install, refresh, expires).Scan(&sessionID)
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
		SELECT u.id::text, u.email, u.name, u.picture, u.handle, u.email_verified
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = $1::uuid AND u.id = $2::uuid AND s.expires_at > now()`, sessionID, userID).
		Scan(&u.ID, &u.Email, &u.Name, &u.Picture, &u.Handle, &u.Verified)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errSignedOut
	}
	return
}

func (s *store) deleteExpired(ctx context.Context) (int64, error) {
	s.db.Exec(ctx, `DELETE FROM email_codes WHERE expires_at < now()`)
	t, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	return t.RowsAffected(), err
}

// putCode keeps the one code an address can have, replacing an earlier one.
func (s *store) putCode(ctx context.Context, email string, hash []byte, expires time.Time) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO email_codes (email, code_hash, attempts, expires_at) VALUES ($1, $2, 0, $3)
		ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at`, email, hash, expires)
	return err
}

// consumeCode spends the address's code if hash matches. A wrong guess counts, and the fifth ends the code.
func (s *store) consumeCode(ctx context.Context, email string, hash []byte) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var want []byte
	var tries int
	var expires time.Time
	err = tx.QueryRow(ctx, `SELECT code_hash, attempts, expires_at FROM email_codes WHERE email = $1 FOR UPDATE`, email).Scan(&want, &tries, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return errBadCode
	}
	if err != nil {
		return err
	}
	switch {
	case time.Now().After(expires) || tries >= codeTries:
		_, err = tx.Exec(ctx, `DELETE FROM email_codes WHERE email = $1`, email)
		if err == nil {
			err = tx.Commit(ctx)
		}
		if err == nil {
			err = errBadCode
		}
		return err
	case !bytes.Equal(want, hash):
		if tries+1 >= codeTries {
			_, err = tx.Exec(ctx, `DELETE FROM email_codes WHERE email = $1`, email)
		} else {
			_, err = tx.Exec(ctx, `UPDATE email_codes SET attempts = attempts + 1 WHERE email = $1`, email)
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
		if err == nil {
			err = errBadCode
		}
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM email_codes WHERE email = $1`, email); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// passwordHash is the stored hash for an address, or "" when it has no password.
func (s *store) passwordHash(ctx context.Context, email string) (string, error) {
	var h string
	err := s.db.QueryRow(ctx, `
		SELECT p.hash FROM identities i JOIN passwords p ON p.user_id = i.user_id WHERE i.provider = 'password' AND i.subject = $1`, email).Scan(&h)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return h, err
}
