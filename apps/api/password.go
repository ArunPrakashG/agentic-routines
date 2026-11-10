package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/argon2"
)

// Email and password sign-in. An address is proved with a mailed code before it can have a password, so nobody
// can register someone else's address, and a password account never holds an address its owner did not control.
// The same step sets a new password for an address that has one, which is how a forgotten password is reset.

const (
	codeTTL        = 10 * time.Minute
	codeTries      = 5
	loginTries     = 8                // wrong passwords per address ...
	loginWindow    = 15 * time.Minute // ... in this long, then the address waits
	codesPerWindow = 3
	minPassword    = 10
	maxPassword    = 128
)

var (
	errBadCode      = errors.New("bad code")
	errTooManyCodes = errors.New("too many codes")
)

// OWASP's argon2id minimum: 19 MiB, 2 passes, 1 lane. Each hash holds that memory while it runs, so only
// two run at once and the rest wait; the service stays small under a flood of sign-ins.
const (
	argonMem     = 19 * 1024
	argonTime    = 2
	argonThreads = 1
)

var hashSlots = make(chan struct{}, 2)

func hashPassword(password string) string {
	hashSlots <- struct{}{}
	defer func() { <-hashSlots }()
	salt := make([]byte, 16)
	rand.Read(salt)
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMem, argonThreads, 32)
	return fmt.Sprintf("argon2id$%d,%d,%d$%s$%s", argonMem, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

func checkPassword(password, stored string) bool {
	hashSlots <- struct{}{}
	defer func() { <-hashSlots }()
	p := strings.Split(stored, "$")
	if len(p) != 4 || p[0] != "argon2id" {
		return false
	}
	var mem, t uint32
	var threads uint8
	if _, err := fmt.Sscanf(p[1], "%d,%d,%d", &mem, &t, &threads); err != nil {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(p[2])
	want, err2 := base64.RawStdEncoding.DecodeString(p[3])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, mem, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// An address that has no account is checked against this, so a wrong address takes as long as a wrong password.
var decoyHash = hashPassword("decoy-" + rand.Text())

// cleanEmail lower-cases an address and refuses anything that is not a plain one.
func cleanEmail(s string) (string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) > 254 || strings.ContainsAny(s, "\r\n<>,;\" ") {
		return "", false
	}
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || a.Name != "" {
		return "", false
	}
	if at := strings.LastIndexByte(s, '@'); at < 1 || !strings.Contains(s[at+1:], ".") {
		return "", false
	}
	return s, true
}

func validPassword(p string) bool {
	return utf8.ValidString(p) && len(p) <= maxPassword && utf8.RuneCountInString(p) >= minPassword
}

func (a *app) codeHash(email, code string) []byte {
	m := hmac.New(sha256.New, a.cfg.SessionSecret)
	m.Write([]byte("email-code\x00" + email + "\x00" + code))
	return m.Sum(nil)
}

// passwordCode mails a code. It answers the same whether or not the address has an account, whether or not the
// mail was sent, and whether or not the address asked too often.
func (a *app) passwordCode(w http.ResponseWriter, r *http.Request) {
	if a.mailer == nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	b, ok := readJSON(w, r, map[string]int{"email": 300})
	if !ok {
		return
	}
	email, ok := cleanEmail(b["email"])
	if !ok {
		fail(w, http.StatusBadRequest, "bad_email")
		return
	}
	if a.limiter.hit(r.Context(), "code:"+email, loginWindow) > codesPerWindow {
		reply(w, http.StatusAccepted, map[string]bool{"sent": true})
		return
	}
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		serverError(w, r, err)
		return
	}
	code := fmt.Sprintf("%06d", n.Int64())
	if err := a.db.putCode(r.Context(), email, a.codeHash(email, code), time.Now().Add(codeTTL)); err != nil {
		serverError(w, r, err)
		return
	}
	// Sent after the answer, so the time it takes says nothing about the address.
	go func() {
		err := a.mailer.send(email, "Your Agentic Routines code",
			fmt.Sprintf("Your code is %s.\n\nIt works for %d minutes. If you did not ask for it, ignore this message.\n", code, int(codeTTL.Minutes())))
		if err != nil {
			slog.Warn("could not send a code", "err", err)
		}
	}()
	reply(w, http.StatusAccepted, map[string]bool{"sent": true})
}

// passwordSet takes the mailed code and a password. It makes the account if the address has none, adds a password
// to an account that signs in another way and has this verified address, or replaces the password. A new password
// ends every other session on the account.
func (a *app) passwordSet(w http.ResponseWriter, r *http.Request) {
	if a.mailer == nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	b, ok := readJSON(w, r, map[string]int{"email": 300, "code": 12, "password": 1024, "install_id": 128})
	if !ok {
		return
	}
	email, ok := cleanEmail(b["email"])
	if !ok {
		fail(w, http.StatusBadRequest, "bad_email")
		return
	}
	if !validPassword(b["password"]) {
		fail(w, http.StatusBadRequest, "weak_password")
		return
	}
	if err := a.db.consumeCode(r.Context(), email, a.codeHash(email, strings.TrimSpace(b["code"]))); err != nil {
		if errors.Is(err, errBadCode) {
			fail(w, http.StatusUnauthorized, "bad_code")
			return
		}
		serverError(w, r, err)
		return
	}
	hash := hashPassword(b["password"])
	id := identity{Provider: "password", Subject: email, Email: email, Verified: true, Name: strings.SplitN(email, "@", 2)[0]}
	a.startSession(w, r, id, b["install_id"], func(tx pgx.Tx, userID string) error {
		var had bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM passwords WHERE user_id = $1::uuid)`, userID).Scan(&had); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO passwords (user_id, hash) VALUES ($1::uuid, $2)
			ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, updated_at = now()`, userID, hash); err != nil {
			return err
		}
		if !had {
			return nil
		}
		_, err := tx.Exec(r.Context(), `DELETE FROM sessions WHERE user_id = $1::uuid`, userID)
		return err
	})
	a.limiter.clear(r.Context(), "login:"+email)
}

func (a *app) passwordLogin(w http.ResponseWriter, r *http.Request) {
	if a.mailer == nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	b, ok := readJSON(w, r, map[string]int{"email": 300, "password": 1024, "install_id": 128})
	if !ok {
		return
	}
	email, ok := cleanEmail(b["email"])
	if !ok {
		fail(w, http.StatusUnauthorized, "bad_credentials")
		return
	}
	key := "login:" + email
	if a.limiter.count(r.Context(), key) >= loginTries {
		w.Header().Set("Retry-After", fmt.Sprint(int(loginWindow.Seconds())))
		fail(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}
	stored, err := a.db.passwordHash(r.Context(), email)
	if err != nil {
		serverError(w, r, err)
		return
	}
	hash := stored
	if hash == "" {
		hash = decoyHash
	}
	if good := checkPassword(b["password"], hash); !good || stored == "" {
		a.limiter.hit(r.Context(), key, loginWindow)
		fail(w, http.StatusUnauthorized, "bad_credentials")
		return
	}
	a.limiter.clear(r.Context(), key)
	a.startSession(w, r, identity{Provider: "password", Subject: email, Email: email, Verified: true}, b["install_id"], nil)
}
