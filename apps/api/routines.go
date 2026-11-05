package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ---------- what comes in ----------
// Published routines are read by other people's agents and replayed in their browsers, so the shape
// is checked here and re-built field by field: nothing the server was not told about is stored.

var (
	namePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	handlePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,29}$`)
	sitePattern   = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)
	secretName    = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
	useWhen       = regexp.MustCompile(`(?i)\buse when\b`)
	actions       = map[string]bool{"navigate": true, "click": true, "type": true, "clear": true, "select": true, "upload": true, "press": true, "wait": true, "read": true}
	// Names that would read as the service or as a place, not a person.
	reserved = map[string]bool{"local": true, "admin": true, "api": true, "me": true, "root": true, "support": true, "official": true, "browser-routines": true, "browserroutines": true, "routines": true, "www": true}
)

const (
	maxSteps       = 300
	maxPerUser     = 100
	maxPublishBody = 256 << 10
)

type paramSpec struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
	Accept      string `json:"accept,omitempty"`
}

type routineMeta struct {
	Name        string               `json:"name"`
	Site        string               `json:"site"`
	Description string               `json:"description"`
	Params      map[string]paramSpec `json:"params"`
	Secrets     []string             `json:"secrets"`
	Pauses      []int                `json:"pauses"`
	Returns     string               `json:"returns,omitempty"`
	DraftedBy   string               `json:"drafted_by,omitempty"`
}

type locator struct {
	Tag   string            `json:"tag"`
	Role  string            `json:"role,omitempty"`
	Name  string            `json:"name,omitempty"`
	Text  string            `json:"text,omitempty"`
	Attrs map[string]string `json:"attrs"`
	CSS   string            `json:"css"`
	Near  string            `json:"near,omitempty"`
}

type fingerprint struct {
	URL       string   `json:"url"`
	Title     string   `json:"title,omitempty"`
	Landmarks []string `json:"landmarks"`
}

type step struct {
	N      int          `json:"n"`
	Action string       `json:"action"`
	Label  string       `json:"label"`
	URL    string       `json:"url,omitempty"`
	Value  *string      `json:"value,omitempty"`
	Target *locator     `json:"target,omitempty"`
	Page   *fingerprint `json:"page,omitempty"`
	Crop   string       `json:"crop,omitempty"`
	Pause  string       `json:"pause,omitempty"`
	Pick   string       `json:"pick,omitempty"`
}

type routineIn struct {
	Meta  routineMeta `json:"meta"`
	Body  string      `json:"body"`
	Steps []step      `json:"steps"`
}

// onSite is the same rule the extension and the CLI apply.
func onSite(rawURL, site string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == site || strings.HasSuffix(h, "."+site)
}

// normalize makes empty lists and maps encode as [] and {}, which is what readers expect.
func (r *routineIn) normalize() {
	if r.Meta.Params == nil {
		r.Meta.Params = map[string]paramSpec{}
	}
	if r.Meta.Secrets == nil {
		r.Meta.Secrets = []string{}
	}
	if r.Meta.Pauses == nil {
		r.Meta.Pauses = []int{}
	}
	for i := range r.Steps {
		if t := r.Steps[i].Target; t != nil && t.Attrs == nil {
			t.Attrs = map[string]string{}
		}
		if p := r.Steps[i].Page; p != nil && p.Landmarks == nil {
			p.Landmarks = []string{}
		}
	}
}

// check returns the first reason a routine cannot be published, as a short code.
func (r *routineIn) check(name string) string {
	m := &r.Meta
	switch {
	case !namePattern.MatchString(name) || m.Name != name:
		return "bad_name"
	case len(m.Description) < 20 || len(m.Description) > 1024 || !useWhen.MatchString(m.Description):
		return "bad_description"
	case !strings.Contains(m.Site, ".") || !sitePattern.MatchString(m.Site):
		return "bad_site"
	case len(r.Body) > 20<<10:
		return "body_too_long"
	case len(r.Steps) == 0 || len(r.Steps) > maxSteps:
		return "bad_steps"
	case len(m.Params) > 30 || len(m.Secrets) > 10 || len(m.Pauses) > maxSteps || len(m.Returns) > 512 || len(m.DraftedBy) > 40:
		return "bad_meta"
	}
	for k, p := range m.Params {
		if !secretName.MatchString(k) || (p.Type != "string" && p.Type != "file") || len(p.Description) > 300 || len(p.Accept) > 100 {
			return "bad_params"
		}
	}
	for _, s := range m.Secrets {
		if !secretName.MatchString(s) {
			return "bad_secrets"
		}
	}
	for _, n := range m.Pauses {
		if n < 1 || n > len(r.Steps) {
			return "bad_pauses"
		}
	}
	for i, s := range r.Steps {
		if s.N != i+1 || !actions[s.Action] || len(s.Label) > 300 || (s.Value != nil && len(*s.Value) > 4096) || len(s.Crop) > 32 {
			return "bad_steps"
		}
		if s.Pause != "" && s.Pause != "auto" && s.Pause != "author" {
			return "bad_steps"
		}
		if s.Pick != "" && s.Pick != "first" {
			return "bad_steps"
		}
		// A step that leaves the site would send an installer's signed-in browser somewhere else.
		if s.URL != "" && !onSite(s.URL, m.Site) {
			return "step_off_site"
		}
		if s.Page != nil && s.Page.URL != "" && !onSite(s.Page.URL, m.Site) {
			return "step_off_site"
		}
		if s.Action == "navigate" && s.URL == "" {
			return "bad_steps"
		}
		if t := s.Target; t != nil && (len(t.Attrs) > 20 || len(t.CSS) > 600) {
			return "bad_steps"
		}
	}
	return ""
}

// ---------- the database ----------

var (
	errHandleTaken = errors.New("handle taken")
	errHandleSet   = errors.New("handle already set")
	errTooMany     = errors.New("too many routines")
	errNotFound    = errors.New("not found")
)

type summary struct {
	Owner       string    `json:"owner"`
	Name        string    `json:"name"`
	Site        string    `json:"site"`
	Description string    `json:"description"`
	Version     int       `json:"version"`
	Installs    int       `json:"installs"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type full struct {
	summary
	Meta  json.RawMessage `json:"meta"`
	Body  string          `json:"body"`
	Steps json.RawMessage `json:"steps"`
}

func (s *store) setHandle(ctx context.Context, userID, handle string) error {
	t, err := s.db.Exec(ctx, `UPDATE users SET handle = $2, updated_at = now() WHERE id = $1::uuid AND handle IS NULL`, userID, handle)
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return errHandleTaken
	}
	if err != nil {
		return err
	}
	if t.RowsAffected() == 0 {
		return errHandleSet
	}
	return nil
}

func (s *store) deleteUser(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM users WHERE id = $1::uuid`, userID)
	return err
}

func (s *store) publish(ctx context.Context, ownerID, name string, r routineIn) (version int, err error) {
	meta, err := json.Marshal(r.Meta)
	if err != nil {
		return
	}
	steps, err := json.Marshal(r.Steps)
	if err != nil {
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	// Serialises one person's publishes, so the cap cannot be passed by two at once.
	if _, err = tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE`, ownerID); err != nil {
		return
	}
	var have int
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT count(*), coalesce(bool_or(name = $2), false) FROM routines WHERE owner_id = $1::uuid`, ownerID, name).Scan(&have, &exists); err != nil {
		return
	}
	if !exists && have >= maxPerUser {
		return 0, errTooMany
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO routines (id, owner_id, name, site, description, version, body, meta, steps)
		VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, 1, $5, $6, $7)
		ON CONFLICT (owner_id, name) DO UPDATE SET site = EXCLUDED.site, description = EXCLUDED.description,
			version = routines.version + 1, body = EXCLUDED.body, meta = EXCLUDED.meta, steps = EXCLUDED.steps, updated_at = now()
		RETURNING version`, ownerID, name, r.Meta.Site, r.Meta.Description, r.Body, meta, steps).Scan(&version)
	if err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

func (s *store) unpublish(ctx context.Context, ownerID, name string) error {
	t, err := s.db.Exec(ctx, `DELETE FROM routines WHERE owner_id = $1::uuid AND name = $2`, ownerID, name)
	if err == nil && t.RowsAffected() == 0 {
		err = errNotFound
	}
	return err
}

const summaryCols = `u.handle, r.name, r.site, r.description, r.version, r.installs, r.updated_at`

func scanSummary(row pgx.Row, extra ...any) (x summary, err error) {
	return x, row.Scan(append([]any{&x.Owner, &x.Name, &x.Site, &x.Description, &x.Version, &x.Installs, &x.UpdatedAt}, extra...)...)
}

// search lists by words in the name, description or site, and by the site a person is on.
func (s *store) search(ctx context.Context, q, host string, limit, offset int) ([]summary, error) {
	pattern := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
	rows, err := s.db.Query(ctx, `
		SELECT `+summaryCols+` FROM routines r JOIN users u ON u.id = r.owner_id
		WHERE u.handle IS NOT NULL
		  AND ($1 = '' OR r.name ILIKE $2 OR r.description ILIKE $2 OR r.site ILIKE $2)
		  AND ($3 = '' OR $3 = r.site OR $3 LIKE '%.' || r.site)
		ORDER BY r.installs DESC, r.updated_at DESC LIMIT $4 OFFSET $5`, q, pattern, host, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []summary{}
	for rows.Next() {
		x, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *store) mine(ctx context.Context, ownerID string) ([]summary, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+summaryCols+` FROM routines r JOIN users u ON u.id = r.owner_id
		WHERE r.owner_id = $1::uuid ORDER BY r.updated_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []summary{}
	for rows.Next() {
		x, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *store) routine(ctx context.Context, owner, name string) (f full, err error) {
	row := s.db.QueryRow(ctx, `
		SELECT `+summaryCols+`, r.meta, r.body, r.steps FROM routines r JOIN users u ON u.id = r.owner_id
		WHERE u.handle = $1 AND r.name = $2`, owner, name)
	f.summary, err = scanSummary(row, &f.Meta, &f.Body, &f.Steps)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	return
}

func (s *store) countInstall(ctx context.Context, owner, name string) error {
	t, err := s.db.Exec(ctx, `
		UPDATE routines SET installs = installs + 1 FROM users u
		WHERE u.id = routines.owner_id AND u.handle = $1 AND routines.name = $2`, owner, name)
	if err == nil && t.RowsAffected() == 0 {
		err = errNotFound
	}
	return err
}

// ---------- handlers ----------

// user is the signed-in person, read through their session so signing out ends the token at once.
func (a *app) user(w http.ResponseWriter, r *http.Request) (user, bool) {
	m := bearer.FindStringSubmatch(r.Header.Get("Authorization"))
	var c *sessionClaims
	if m != nil {
		c = a.signer.check(m[1])
	}
	if c == nil || c.Install != r.Header.Get("X-Install-Id") || strings.TrimSpace(c.Install) == "" {
		fail(w, http.StatusUnauthorized, "signed_out")
		return user{}, false
	}
	u, err := a.db.me(r.Context(), c.Subject, c.Session)
	if errors.Is(err, errSignedOut) {
		fail(w, http.StatusUnauthorized, "signed_out")
		return user{}, false
	}
	if err != nil {
		serverError(w, r, err)
		return user{}, false
	}
	return u, true
}

func (a *app) setHandle(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	b, ok := readJSON(w, r, map[string]int{"handle": 64})
	if !ok {
		return
	}
	h := b["handle"]
	if !handlePattern.MatchString(h) || reserved[h] {
		fail(w, http.StatusBadRequest, "bad_handle")
		return
	}
	switch err := a.db.setHandle(r.Context(), u.ID, h); {
	case errors.Is(err, errHandleTaken):
		fail(w, http.StatusConflict, "handle_taken")
	case errors.Is(err, errHandleSet):
		fail(w, http.StatusConflict, "handle_set")
	case err != nil:
		serverError(w, r, err)
	default:
		u.Handle = &h
		reply(w, http.StatusOK, u)
	}
}

func (a *app) deleteMe(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	// Their routines go with them: the directory only holds what its owner still stands behind.
	if err := a.db.deleteUser(r.Context(), u.ID); err != nil {
		serverError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) publish(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	if u.Handle == nil {
		fail(w, http.StatusConflict, "needs_handle")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPublishBody)
	var in routineIn
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	name := r.PathValue("name")
	if code := in.check(name); code != "" {
		fail(w, http.StatusBadRequest, code)
		return
	}
	in.normalize()
	version, err := a.db.publish(r.Context(), u.ID, name, in)
	if errors.Is(err, errTooMany) {
		fail(w, http.StatusConflict, "too_many_routines")
		return
	}
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"owner": *u.Handle, "name": name, "version": version})
}

func (a *app) unpublish(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	switch err := a.db.unpublish(r.Context(), u.ID, r.PathValue("name")); {
	case errors.Is(err, errNotFound):
		fail(w, http.StatusNotFound, "not_found")
	case err != nil:
		serverError(w, r, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *app) myRoutines(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	list, err := a.db.mine(r.Context(), u.ID)
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"routines": list})
}

func (a *app) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	words := strings.TrimSpace(q.Get("q"))
	host := strings.ToLower(strings.TrimSpace(q.Get("site")))
	if len(words) > 100 || len(host) > 253 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	limit, offset := 20, 0
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 {
		limit = min(v, 50)
	}
	if v, err := strconv.Atoi(q.Get("offset")); err == nil && v > 0 {
		offset = min(v, 10_000)
	}
	list, err := a.db.search(r.Context(), words, host, limit, offset)
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"routines": list})
}

func (a *app) getRoutine(w http.ResponseWriter, r *http.Request) {
	f, err := a.db.routine(r.Context(), r.PathValue("owner"), r.PathValue("name"))
	if errors.Is(err, errNotFound) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, f)
}

// The installer's own machine reports an install once it has saved the routine.
func (a *app) countInstall(w http.ResponseWriter, r *http.Request) {
	switch err := a.db.countInstall(r.Context(), r.PathValue("owner"), r.PathValue("name")); {
	case errors.Is(err, errNotFound):
		fail(w, http.StatusNotFound, "not_found")
	case err != nil:
		serverError(w, r, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
