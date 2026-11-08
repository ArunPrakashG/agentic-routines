package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Every submission is read by a person before it goes live, every time. The checks below do the
// boring part first and never approve anything on their own: they only tell the reviewer where to look.

var (
	guidelines  = map[string]bool{"G1": true, "G2": true, "G3": true, "G4": true, "G5": true, "G6": true, "G7": true, "G8": true, "G9": true}
	placeholder = regexp.MustCompile(`^\{\{[a-z0-9_:]+\}\}$`)
	// Things that look like a key, token or password someone typed in while recording.
	secretShape = regexp.MustCompile(`(?i)(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-z0-9-]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.|-----BEGIN [A-Z ]*PRIVATE KEY|[a-f0-9]{40,})`)
	// Steps that are hard to take back. Leaving one without a pause is worth a second look.
	finalWords = regexp.MustCompile(`(?i)\b(delete|remove|pay|purchase|buy|order|send|submit|publish|post|transfer|confirm|cancel|unsubscribe|deactivate|close account)\b`)
)

var (
	errNotPending = errors.New("not pending")
	errBlockedOut = errors.New("publisher is blocked")
)

type submissionRow struct {
	ID          string     `json:"id"`
	Owner       string     `json:"owner"`
	Name        string     `json:"name"`
	Site        string     `json:"site"`
	Description string     `json:"description"`
	Version     int        `json:"version"`
	Status      string     `json:"status"`
	Guideline   *string    `json:"guideline"`
	Note        *string    `json:"note"`
	SubmittedAt time.Time  `json:"submitted_at"`
	DecidedAt   *time.Time `json:"decided_at"`
}

const submissionCols = `s.id::text, coalesce(u.handle, ''), s.name, s.site, s.description, s.version, s.status, s.guideline, s.note, s.submitted_at, s.decided_at`

func scanSubmission(row pgx.Row, extra ...any) (x submissionRow, err error) {
	return x, row.Scan(append([]any{&x.ID, &x.Owner, &x.Name, &x.Site, &x.Description, &x.Version, &x.Status, &x.Guideline, &x.Note, &x.SubmittedAt, &x.DecidedAt}, extra...)...)
}

// ---------- what a publisher sees ----------

func (s *store) submissionsOf(ctx context.Context, ownerID string) ([]submissionRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+submissionCols+` FROM submissions s JOIN users u ON u.id = s.owner_id
		WHERE s.owner_id = $1::uuid ORDER BY s.submitted_at DESC LIMIT 50`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []submissionRow{}
	for rows.Next() {
		x, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *store) withdraw(ctx context.Context, ownerID, id string) error {
	t, err := s.db.Exec(ctx, `UPDATE submissions SET status = 'withdrawn', decided_at = now(), decided_by = 'publisher'
		WHERE id = $1::uuid AND owner_id = $2::uuid AND status = 'pending'`, id, ownerID)
	if err == nil && t.RowsAffected() == 0 {
		err = errNotFound
	}
	return err
}

func (a *app) mySubmissions(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	list, err := a.db.submissionsOf(r.Context(), u.ID)
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"submissions": list})
}

func (a *app) withdraw(w http.ResponseWriter, r *http.Request) {
	u, ok := a.user(w, r)
	if !ok {
		return
	}
	if !isUUID(r.PathValue("id")) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	switch err := a.db.withdraw(r.Context(), u.ID, r.PathValue("id")); {
	case errors.Is(err, errNotFound):
		fail(w, http.StatusNotFound, "not_found")
	case err != nil:
		serverError(w, r, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func isUUID(s string) bool { return uuidPattern.MatchString(s) }

// ---------- the block list, for clients ----------

type blockList struct {
	Users    []string `json:"users"`
	Repos    []string `json:"repos"`
	Routines []string `json:"routines"`
}

// The routines on it are everything that should not run any more: blocked by name, switched off,
// or published by someone who is blocked. A client turns off what it has installed from them.
func (s *store) blocklist(ctx context.Context) (b blockList, err error) {
	b = blockList{Users: []string{}, Repos: []string{}, Routines: []string{}}
	rows, err := s.db.Query(ctx, `SELECT kind, value FROM blocks ORDER BY kind, value`)
	if err != nil {
		return
	}
	for rows.Next() {
		var kind, value string
		if err = rows.Scan(&kind, &value); err != nil {
			rows.Close()
			return
		}
		switch kind {
		case "user":
			b.Users = append(b.Users, value)
		case "repo":
			b.Repos = append(b.Repos, value)
		case "routine":
			b.Routines = append(b.Routines, value)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return
	}
	off, err := s.db.Query(ctx, `SELECT u.handle || '/' || r.name FROM routines r JOIN users u ON u.id = r.owner_id
		WHERE r.disabled AND u.handle IS NOT NULL ORDER BY 1`)
	if err != nil {
		return
	}
	defer off.Close()
	for off.Next() {
		var v string
		if err = off.Scan(&v); err != nil {
			return
		}
		b.Routines = append(b.Routines, v)
	}
	return b, off.Err()
}

func (a *app) blocklist(w http.ResponseWriter, r *http.Request) {
	b, err := a.db.blocklist(r.Context())
	if err != nil {
		serverError(w, r, err)
		return
	}
	// The only response that is the same for everyone.
	w.Header().Set("Cache-Control", "public, max-age=300")
	reply(w, http.StatusOK, b)
}

// ---------- the reviewer ----------

func (a *app) adminRoutes(mux *http.ServeMux) {
	g := func(limit int64, h http.HandlerFunc) http.HandlerFunc { return a.limitedTo("admin", limit, a.admin(h)) }
	mux.HandleFunc("GET /api/v1/admin/submissions", g(240, a.adminList))
	mux.HandleFunc("GET /api/v1/admin/submissions/{id}", g(240, a.adminDetail))
	mux.HandleFunc("POST /api/v1/admin/submissions/{id}/approve", g(60, a.adminApprove))
	mux.HandleFunc("POST /api/v1/admin/submissions/{id}/reject", g(60, a.adminReject))
	mux.HandleFunc("GET /api/v1/admin/routines", g(240, a.adminRoutinesList))
	mux.HandleFunc("POST /api/v1/admin/routines/{owner}/{name}/disable", g(60, a.adminDisable))
	mux.HandleFunc("POST /api/v1/admin/routines/{owner}/{name}/enable", g(60, a.adminEnable))
	mux.HandleFunc("DELETE /api/v1/admin/routines/{owner}/{name}", g(60, a.adminDelete))
	mux.HandleFunc("GET /api/v1/admin/blocks", g(240, a.adminBlocks))
	mux.HandleFunc("PUT /api/v1/admin/blocks", g(60, a.adminBlock))
	mux.HandleFunc("DELETE /api/v1/admin/blocks", g(60, a.adminUnblock))
	mux.HandleFunc("GET /api/v1/admin/audit", g(240, a.adminAudit))
}

type adminKey struct{}

// admin lets only the allow-listed accounts through. Everyone else gets the same answer as a path that does not exist.
func (a *app) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := a.user(w, r)
		if !ok {
			return
		}
		if !u.Admin {
			fail(w, http.StatusNotFound, "not_found")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), adminKey{}, u.Email)))
	}
}

func adminOf(r *http.Request) string { s, _ := r.Context().Value(adminKey{}).(string); return s }

type checkResult struct {
	ID    string `json:"id"`
	Level string `json:"level"` // pass, warn or fail
	Text  string `json:"text"`
	// Tag is the short form for the queue. Empty when the check passed.
	Tag string `json:"tag,omitempty"`
}

var checkText = map[string]string{
	"bad_name": "The name is not a valid routine name.", "bad_description": "The description needs a clear \"Use when\" clause.",
	"bad_site": "The site is not a valid host.", "body_too_long": "The notes are too long.", "bad_steps": "A step is malformed or there are too many.",
	"bad_meta": "The details are too large.", "bad_params": "A value the person fills in is malformed.", "bad_secrets": "A secret name is malformed.",
	"bad_pauses": "A pause points at a step that does not exist.", "bad_urls": "The pages the routine applies to are not host-and-path patterns on its site.", "bad_surface": "Only browser routines are accepted for now.", "bad_hooks": "The hooks or the notes for the agent are too long, or a hook is on an unknown event.", "step_off_site": "A step leaves the routine's site.",
}

// autoChecks tells the reviewer where to look. A pass is not an approval.
func autoChecks(name string, in routineIn) []checkResult {
	out := []checkResult{}
	code := in.check(name)
	if code == "" {
		out = append(out, checkResult{"shape", "pass", "Shape, size and description are valid.", ""})
	} else {
		out = append(out, checkResult{"shape", "fail", checkText[code], "Invalid"})
	}
	if code != "step_off_site" {
		out = append(out, checkResult{"site", "pass", "Every step stays on " + in.Meta.Site + ".", ""})
	} else {
		out = append(out, checkResult{"site", "fail", checkText[code], "Leaves its site"})
	}
	out = append(out, lookalikeCheck(in), textCheck(in))
	var typed, secrets, unpaused []string
	paused := map[int]bool{}
	for _, n := range in.Meta.Pauses {
		paused[n] = true
	}
	for _, s := range in.Steps {
		n := strconv.Itoa(s.N)
		if secretShape.MatchString(s.URL) {
			secrets = append(secrets, n)
		}
		if s.Value != nil && *s.Value != "" && (s.Action == "type" || s.Action == "select") {
			if secretShape.MatchString(*s.Value) {
				secrets = append(secrets, n)
			} else if !placeholder.MatchString(*s.Value) {
				typed = append(typed, n)
			}
		}
		if (s.Action == "click" || s.Action == "press") && finalWords.MatchString(s.Label) && !paused[s.N] && s.Pause == "" {
			unpaused = append(unpaused, n)
		}
	}
	out = append(out, hookChecks(in)...)
	if len(secrets) > 0 {
		out = append(out, checkResult{"secrets", "fail", "Steps " + strings.Join(secrets, ", ") + " type something that looks like a key or token.", "Looks like a key"})
	} else {
		out = append(out, checkResult{"secrets", "pass", "Nothing typed looks like a key, token or password.", ""})
	}
	if len(typed) > 0 {
		out = append(out, checkResult{"typed", "warn", "Steps " + strings.Join(typed, ", ") + " type a fixed value that every installer will send. Check it is public.", plural(len(typed), "public value")})
	} else {
		out = append(out, checkResult{"typed", "pass", "Every typed value is filled in by the person who runs it.", ""})
	}
	if len(unpaused) > 0 {
		out = append(out, checkResult{"pauses", "warn", "Steps " + strings.Join(unpaused, ", ") + " read like a final action and do not pause first.", "No pause before a final step"})
	} else {
		out = append(out, checkResult{"pauses", "pass", "Nothing that reads like a final action runs without a pause.", ""})
	}
	return out
}

// lookalikeCheck flags a site or step address written in punycode: it may spell a well-known name with other letters.
func lookalikeCheck(in routineIn) checkResult {
	hosts := []string{in.Meta.Site}
	for _, s := range in.Steps {
		for _, raw := range []string{s.URL, pageURL(s)} {
			if u, err := url.Parse(raw); err == nil && raw != "" {
				hosts = append(hosts, u.Hostname())
			}
		}
	}
	for _, h := range hosts {
		for _, label := range strings.Split(strings.ToLower(h), ".") {
			if strings.HasPrefix(label, "xn--") {
				return checkResult{"lookalike", "warn", "An address uses punycode (" + h + "). It can spell a well-known name with other letters. Decode it and check it is the site the routine says.", "Lookalike address"}
			}
		}
	}
	return checkResult{"lookalike", "pass", "Every address is written in plain letters.", ""}
}

func pageURL(s step) string {
	if s.Page == nil {
		return ""
	}
	return s.Page.URL
}

// What is read by whoever installs a routine, and by their agent: the notes, the labels, the descriptions. Text
// that talks to the agent or points elsewhere is worth a look.
var agentBait = regexp.MustCompile(`(?i)(ignore (all |any |the )?(previous|prior|above|earlier)|disregard (the|all|any|your)|system prompt|developer message|you (must|should|need to) (now )?(run|execute|call|ignore|send|reveal|upload|visit|open)|do not (tell|mention|inform|show)|https?://|\b(curl|wget|powershell|base64)\b|</?(system|tool|instructions?)>)`)

func textCheck(in routineIn) checkResult {
	texts := []string{in.Meta.Description, in.Meta.Returns, in.Body}
	for k, p := range in.Meta.Params {
		texts = append(texts, k, p.Description)
	}
	for _, s := range in.Steps {
		texts = append(texts, s.Label)
	}
	for _, t := range texts {
		if m := agentBait.FindString(t); m != "" {
			return checkResult{"text", "warn", "The notes or labels contain “" + short(m, 40) + "”. They are read by the installer's agent, so check this is not an instruction or a link.", "Text aimed at the agent"}
		}
	}
	return checkResult{"text", "pass", "The notes and labels hold no instructions to an agent and no links.", ""}
}

func short(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// hookPatterns are things a hook has no way to do in its sandbox. Seeing one says what the author was after.
var hookPatterns = regexp.MustCompile(`\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|postMessage|indexedDB|localStorage|document\.cookie)\b|\beval\s*\(|\bimport\s*\(`)

// hookChecks tells the reviewer a routine carries code and what that code reaches for. Hooks cannot leave their
// sandbox, so none of this is blocking: it is where to read.
func hookChecks(in routineIn) []checkResult {
	n := len(in.Meta.Hooks)
	notes := in.Meta.Instructions != ""
	for _, s := range in.Steps {
		notes = notes || s.Instructions != ""
	}
	out := []checkResult{}
	if n == 0 {
		out = append(out, checkResult{"hooks", "pass", "No hooks.", ""})
	} else {
		var reach []string
		for ev, code := range in.Meta.Hooks {
			if m := hookPatterns.FindString(code); m != "" {
				reach = append(reach, ev+" uses "+strings.TrimSpace(m))
			}
		}
		sort.Strings(reach)
		if len(reach) > 0 {
			out = append(out, checkResult{"hooks", "warn", "Hooks on " + plural(n, "event") + ". They run in a sandbox with no network. " + strings.Join(reach, "; ") + ", which does nothing there. Read the code below.", "Hooks reach outside"})
		} else {
			out = append(out, checkResult{"hooks", "warn", "Hooks on " + plural(n, "event") + ". They run in a sandbox with no network and can only ask for the listed directives. Read the code below.", plural(n, "hook")})
		}
	}
	if notes {
		out = append(out, checkResult{"notes", "warn", "It carries notes for the installer's agent. Read them below: an agent is shown them as written by someone else.", "Agent notes"})
	}
	return out
}

type adminRow struct {
	submissionRow
	Email string `json:"publisher_email"`
	Steps int    `json:"steps"`
	// LiveVersion is the version this would replace, nil for a first submission.
	LiveVersion  *int          `json:"live_version"`
	NewPublisher bool          `json:"new_publisher"`
	Tags         []checkResult `json:"tags"`
}

func (s *store) adminList(ctx context.Context, status string, limit, offset int) ([]adminRow, error) {
	order := "s.submitted_at DESC"
	if status == "pending" {
		order = "s.submitted_at ASC"
	}
	rows, err := s.db.Query(ctx, `
		SELECT `+submissionCols+`, u.email, jsonb_array_length(s.steps),
		  (SELECT version FROM routines WHERE owner_id = s.owner_id AND name = s.name),
		  NOT EXISTS (SELECT 1 FROM submissions o WHERE o.owner_id = s.owner_id AND o.status = 'approved'),
		  s.meta, s.body, s.steps
		FROM submissions s JOIN users u ON u.id = s.owner_id
		WHERE ($1 = 'all' OR s.status = $1) ORDER BY `+order+` LIMIT $2 OFFSET $3`, status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []adminRow{}
	for rows.Next() {
		var x adminRow
		var meta, steps json.RawMessage
		var in routineIn
		x.submissionRow, err = scanSubmission(rows, &x.Email, &x.Steps, &x.LiveVersion, &x.NewPublisher, &meta, &in.Body, &steps)
		if err != nil {
			return nil, err
		}
		x.Tags = []checkResult{}
		if json.Unmarshal(meta, &in.Meta) == nil && json.Unmarshal(steps, &in.Steps) == nil {
			for _, c := range autoChecks(x.Name, in) {
				if c.Tag != "" {
					x.Tags = append(x.Tags, c)
				}
			}
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (a *app) adminList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = "pending"
	}
	if status != "all" && status != "pending" && status != "approved" && status != "rejected" && status != "withdrawn" {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	limit, offset := 50, 0
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 {
		limit = min(v, 100)
	}
	if v, err := strconv.Atoi(q.Get("offset")); err == nil && v > 0 {
		offset = min(v, 10_000)
	}
	list, err := a.db.adminList(r.Context(), status, limit, offset)
	if err != nil {
		serverError(w, r, err)
		return
	}
	var waiting int
	if err := a.db.db.QueryRow(r.Context(), `SELECT count(*) FROM submissions WHERE status = 'pending'`).Scan(&waiting); err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"submissions": list, "waiting": waiting})
}

type publisherStats struct {
	Handle   string    `json:"handle"`
	Email    string    `json:"email"`
	Joined   time.Time `json:"joined"`
	Live     int       `json:"live"`
	Approved int       `json:"approved"`
	Rejected int       `json:"rejected"`
	Blocked  bool      `json:"blocked"`
}

type liveCopy struct {
	Version int             `json:"version"`
	Meta    json.RawMessage `json:"meta"`
	Body    string          `json:"body"`
	Steps   json.RawMessage `json:"steps"`
}

type detail struct {
	submissionRow
	Meta       json.RawMessage `json:"meta"`
	Body       string          `json:"body"`
	Steps      json.RawMessage `json:"steps"`
	Playwright string          `json:"playwright"`
	Checks     []checkResult   `json:"checks"`
	Live       *liveCopy       `json:"live"`
	Publisher  publisherStats  `json:"publisher"`
}

func (s *store) submission(ctx context.Context, id string) (d detail, ownerID string, err error) {
	row := s.db.QueryRow(ctx, `
		SELECT `+submissionCols+`, s.meta, s.body, s.steps, s.playwright, s.owner_id::text FROM submissions s JOIN users u ON u.id = s.owner_id
		WHERE s.id = $1::uuid`, id)
	d.submissionRow, err = scanSubmission(row, &d.Meta, &d.Body, &d.Steps, &d.Playwright, &ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	return
}

func (a *app) adminDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isUUID(id) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	ctx := r.Context()
	d, ownerID, err := a.db.submission(ctx, id)
	if errors.Is(err, errNotFound) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		serverError(w, r, err)
		return
	}
	var in routineIn
	in.Body = d.Body
	if json.Unmarshal(d.Meta, &in.Meta) != nil || json.Unmarshal(d.Steps, &in.Steps) != nil {
		serverError(w, r, errors.New("stored submission is unreadable"))
		return
	}
	d.Checks = autoChecks(d.Name, in)
	var l liveCopy
	switch err := a.db.db.QueryRow(ctx, `SELECT version, meta, body, steps FROM routines WHERE owner_id = $1::uuid AND name = $2`, ownerID, d.Name).Scan(&l.Version, &l.Meta, &l.Body, &l.Steps); {
	case err == nil:
		d.Live = &l
	case !errors.Is(err, pgx.ErrNoRows):
		serverError(w, r, err)
		return
	}
	p := &d.Publisher
	if err := a.db.db.QueryRow(ctx, `
		SELECT coalesce(u.handle, ''), u.email, u.created_at,
		  (SELECT count(*) FROM routines WHERE owner_id = u.id),
		  (SELECT count(*) FROM submissions WHERE owner_id = u.id AND status = 'approved'),
		  (SELECT count(*) FROM submissions WHERE owner_id = u.id AND status = 'rejected'),
		  EXISTS (SELECT 1 FROM blocks WHERE kind = 'user' AND value = u.handle)
		FROM users u WHERE u.id = $1::uuid`, ownerID).Scan(&p.Handle, &p.Email, &p.Joined, &p.Live, &p.Approved, &p.Rejected, &p.Blocked); err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, d)
}

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func audit(ctx context.Context, q execer, admin, action, target string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	b, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO audit (admin, action, target, detail) VALUES ($1, $2, $3, $4)`, admin, action, target, b)
	return err
}

var errInvalid = errors.New("no longer valid")

// approve puts a pending submission live. The shape is checked again here, so what goes live is what passes now.
func (s *store) approve(ctx context.Context, id, admin string) (owner, name string, version int, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	var ownerID, status string
	var in routineIn
	var meta, steps []byte
	err = tx.QueryRow(ctx, `
		SELECT s.owner_id::text, coalesce(u.handle, ''), s.name, s.version, s.status, s.body, s.meta, s.steps
		FROM submissions s JOIN users u ON u.id = s.owner_id WHERE s.id = $1::uuid FOR UPDATE OF s`, id).
		Scan(&ownerID, &owner, &name, &version, &status, &in.Body, &meta, &steps)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", 0, errNotFound
	}
	if err != nil {
		return
	}
	if status != "pending" {
		return "", "", 0, errNotPending
	}
	var blocked bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM blocks WHERE (kind = 'user' AND value = $1) OR (kind = 'routine' AND value = $2)
		OR (kind = 'account' AND value = (SELECT google_sub FROM users WHERE id = $3::uuid)))`,
		owner, owner+"/"+name, ownerID).Scan(&blocked); err != nil {
		return
	}
	if blocked {
		return "", "", 0, errBlockedOut
	}
	if json.Unmarshal(meta, &in.Meta) != nil || json.Unmarshal(steps, &in.Steps) != nil || in.check(name) != "" {
		return "", "", 0, errInvalid
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO routines (id, owner_id, name, site, description, version, body, meta, steps, playwright)
		VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, (SELECT playwright FROM submissions WHERE id = $9::uuid))
		ON CONFLICT (owner_id, name) DO UPDATE SET site = EXCLUDED.site, description = EXCLUDED.description,
			version = EXCLUDED.version, body = EXCLUDED.body, meta = EXCLUDED.meta, steps = EXCLUDED.steps, playwright = EXCLUDED.playwright,
			approved_at = now(), updated_at = now()`,
		ownerID, name, in.Meta.Site, in.Meta.Description, version, in.Body, meta, steps, id); err != nil {
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE submissions SET status = 'approved', decided_at = now(), decided_by = $2 WHERE id = $1::uuid`, id, admin); err != nil {
		return
	}
	if err = audit(ctx, tx, admin, "approve", owner+"/"+name, map[string]any{"submission": id, "version": version}); err != nil {
		return
	}
	err = tx.Commit(ctx)
	return
}

func (s *store) reject(ctx context.Context, id, admin, guideline, note string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner, name, status string
	err = tx.QueryRow(ctx, `SELECT coalesce(u.handle, ''), s.name, s.status FROM submissions s JOIN users u ON u.id = s.owner_id
		WHERE s.id = $1::uuid FOR UPDATE OF s`, id).Scan(&owner, &name, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if status != "pending" {
		return errNotPending
	}
	if _, err = tx.Exec(ctx, `UPDATE submissions SET status = 'rejected', guideline = $2, note = $3, decided_at = now(), decided_by = $4 WHERE id = $1::uuid`,
		id, guideline, note, admin); err != nil {
		return err
	}
	if err = audit(ctx, tx, admin, "reject", owner+"/"+name, map[string]any{"submission": id, "guideline": guideline}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *app) decided(w http.ResponseWriter, r *http.Request, err error) bool {
	switch {
	case errors.Is(err, errNotFound):
		fail(w, http.StatusNotFound, "not_found")
	case errors.Is(err, errNotPending):
		fail(w, http.StatusConflict, "not_pending")
	case errors.Is(err, errBlockedOut):
		fail(w, http.StatusConflict, "blocked")
	case errors.Is(err, errInvalid):
		fail(w, http.StatusConflict, "no_longer_valid")
	case err != nil:
		serverError(w, r, err)
	default:
		return true
	}
	return false
}

func (a *app) adminApprove(w http.ResponseWriter, r *http.Request) {
	if !isUUID(r.PathValue("id")) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	owner, name, version, err := a.db.approve(r.Context(), r.PathValue("id"), adminOf(r))
	if a.decided(w, r, err) {
		reply(w, http.StatusOK, map[string]any{"owner": owner, "name": name, "version": version, "status": "approved"})
	}
}

func (a *app) adminReject(w http.ResponseWriter, r *http.Request) {
	if !isUUID(r.PathValue("id")) {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	b, ok := readJSON(w, r, map[string]int{"guideline": 3, "note": 1000})
	if !ok {
		return
	}
	if !guidelines[b["guideline"]] {
		fail(w, http.StatusBadRequest, "bad_guideline")
		return
	}
	if a.decided(w, r, a.db.reject(r.Context(), r.PathValue("id"), adminOf(r), b["guideline"], b["note"])) {
		reply(w, http.StatusOK, map[string]string{"status": "rejected"})
	}
}

// ---------- live routines ----------

type liveRow struct {
	summary
	Disabled       bool      `json:"disabled"`
	DisabledReason *string   `json:"disabled_reason"`
	ApprovedAt     time.Time `json:"approved_at"`
	Blocked        bool      `json:"publisher_blocked"`
}

func (a *app) adminRoutinesList(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "all"
	}
	if status != "all" && status != "live" && status != "disabled" {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	rows, err := a.db.db.Query(r.Context(), `
		SELECT `+summaryCols+`, r.disabled, r.disabled_reason, r.approved_at,
		  EXISTS (SELECT 1 FROM blocks b WHERE b.kind = 'user' AND b.value = u.handle)
		FROM routines r JOIN users u ON u.id = r.owner_id
		WHERE u.handle IS NOT NULL AND ($1 = 'all' OR ($1 = 'live') = NOT r.disabled)
		ORDER BY r.installs DESC, r.updated_at DESC LIMIT 500`, status)
	if err != nil {
		serverError(w, r, err)
		return
	}
	defer rows.Close()
	out := []liveRow{}
	for rows.Next() {
		var x liveRow
		x.summary, err = scanSummary(rows, &x.Disabled, &x.DisabledReason, &x.ApprovedAt, &x.Blocked)
		if err != nil {
			serverError(w, r, err)
			return
		}
		out = append(out, x)
	}
	if rows.Err() != nil {
		serverError(w, r, rows.Err())
		return
	}
	reply(w, http.StatusOK, map[string]any{"routines": out})
}

func (s *store) setDisabled(ctx context.Context, admin, owner, name string, off bool, reason string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var why *string
	if off {
		why = &reason
	}
	t, err := tx.Exec(ctx, `UPDATE routines r SET disabled = $3, disabled_reason = $4, updated_at = now() FROM users u
		WHERE u.id = r.owner_id AND u.handle = $1 AND r.name = $2`, owner, name, off, why)
	if err != nil {
		return err
	}
	if t.RowsAffected() == 0 {
		return errNotFound
	}
	action := "enable"
	if off {
		action = "disable"
	}
	if err = audit(ctx, tx, admin, action, owner+"/"+name, map[string]any{"reason": reason}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *app) adminDisable(w http.ResponseWriter, r *http.Request) {
	b, ok := readJSON(w, r, map[string]int{"reason": 300})
	if !ok {
		return
	}
	err := a.db.setDisabled(r.Context(), adminOf(r), r.PathValue("owner"), r.PathValue("name"), true, b["reason"])
	if a.decided(w, r, err) {
		reply(w, http.StatusOK, map[string]bool{"disabled": true})
	}
}

func (a *app) adminEnable(w http.ResponseWriter, r *http.Request) {
	err := a.db.setDisabled(r.Context(), adminOf(r), r.PathValue("owner"), r.PathValue("name"), false, "")
	if a.decided(w, r, err) {
		reply(w, http.StatusOK, map[string]bool{"disabled": false})
	}
}

func (a *app) adminDelete(w http.ResponseWriter, r *http.Request) {
	tx, err := a.db.db.Begin(r.Context())
	if err != nil {
		serverError(w, r, err)
		return
	}
	defer tx.Rollback(r.Context())
	owner, name := r.PathValue("owner"), r.PathValue("name")
	t, err := tx.Exec(r.Context(), `DELETE FROM routines r USING users u WHERE u.id = r.owner_id AND u.handle = $1 AND r.name = $2`, owner, name)
	if err == nil && t.RowsAffected() == 0 {
		err = errNotFound
	}
	if err == nil {
		err = audit(r.Context(), tx, adminOf(r), "delete", owner+"/"+name, nil)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if a.decided(w, r, err) {
		w.WriteHeader(http.StatusNoContent)
	}
}

// ---------- blocks and the audit trail ----------

type blockRow struct {
	Kind      string    `json:"kind"`
	Value     string    `json:"value"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
	By        string    `json:"by"`
}

func (a *app) adminBlocks(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.db.Query(r.Context(), `SELECT kind, value, reason, created_at, created_by FROM blocks ORDER BY created_at DESC LIMIT 500`)
	if err != nil {
		serverError(w, r, err)
		return
	}
	defer rows.Close()
	out := []blockRow{}
	for rows.Next() {
		var x blockRow
		if err := rows.Scan(&x.Kind, &x.Value, &x.Reason, &x.CreatedAt, &x.By); err != nil {
			serverError(w, r, err)
			return
		}
		out = append(out, x)
	}
	reply(w, http.StatusOK, map[string]any{"blocks": out})
}

var subPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

var routineRef = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,29}/[a-z0-9][a-z0-9-]{1,62}$`)

// blockValue puts a value in the form it is stored and compared in, or says it is not one.
func blockValue(kind, value string) (string, bool) {
	value = strings.TrimSpace(value)
	switch kind {
	case "user":
		return value, handlePattern.MatchString(value)
	case "routine":
		return value, routineRef.MatchString(value)
	case "account":
		return value, subPattern.MatchString(value)
	case "repo":
		u, err := url.Parse(strings.ToLower(value))
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
			return "", false
		}
		return "https://" + u.Hostname() + strings.TrimSuffix(strings.TrimSuffix(u.EscapedPath(), "/"), ".git"), true
	}
	return "", false
}

func (a *app) adminBlock(w http.ResponseWriter, r *http.Request) {
	b, ok := readJSON(w, r, map[string]int{"kind": 10, "value": 300, "reason": 300})
	if !ok {
		return
	}
	value, valid := blockValue(b["kind"], b["value"])
	if !valid {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	admin := adminOf(r)
	ctx := r.Context()
	err := func() error {
		tx, err := a.db.db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `INSERT INTO blocks (kind, value, reason, created_by) VALUES ($1, $2, $3, $4)
			ON CONFLICT (kind, value) DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()`,
			b["kind"], value, b["reason"], admin); err != nil {
			return err
		}
		// Blocking a person also stops what they have waiting. Their live routines are already hidden by the block.
		if b["kind"] == "user" {
			if _, err = tx.Exec(ctx, `INSERT INTO blocks (kind, value, reason, created_by) SELECT 'account', u.google_sub, $2, $3 FROM users u
				WHERE u.handle = $1 ON CONFLICT (kind, value) DO NOTHING`, value, b["reason"], admin); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `UPDATE submissions s SET status = 'rejected', note = 'Publisher blocked.', decided_at = now(), decided_by = $2
				FROM users u WHERE u.id = s.owner_id AND u.handle = $1 AND s.status = 'pending'`, value, admin); err != nil {
				return err
			}
		}
		if err = audit(ctx, tx, admin, "block", b["kind"]+":"+value, map[string]any{"reason": b["reason"]}); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}()
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, blockRow{Kind: b["kind"], Value: value, Reason: b["reason"], CreatedAt: time.Now(), By: admin})
}

func (a *app) adminUnblock(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	value, valid := blockValue(q.Get("kind"), q.Get("value"))
	if !valid {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	ctx := r.Context()
	tx, err := a.db.db.Begin(ctx)
	if err != nil {
		serverError(w, r, err)
		return
	}
	defer tx.Rollback(ctx)
	t, err := tx.Exec(ctx, `DELETE FROM blocks WHERE kind = $1 AND value = $2`, q.Get("kind"), value)
	if err == nil && q.Get("kind") == "user" {
		_, err = tx.Exec(ctx, `DELETE FROM blocks WHERE kind = 'account' AND value IN (SELECT google_sub FROM users WHERE handle = $1)`, value)
	}
	if err == nil && t.RowsAffected() == 0 {
		err = errNotFound
	}
	if err == nil {
		err = audit(ctx, tx, adminOf(r), "unblock", q.Get("kind")+":"+value, nil)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if a.decided(w, r, err) {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *app) adminAudit(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.db.Query(r.Context(), `SELECT admin, action, target, detail, at FROM audit ORDER BY at DESC, id DESC LIMIT 100`)
	if err != nil {
		serverError(w, r, err)
		return
	}
	defer rows.Close()
	type entry struct {
		Admin  string          `json:"admin"`
		Action string          `json:"action"`
		Target string          `json:"target"`
		Detail json.RawMessage `json:"detail"`
		At     time.Time       `json:"at"`
	}
	out := []entry{}
	for rows.Next() {
		var x entry
		if err := rows.Scan(&x.Admin, &x.Action, &x.Target, &x.Detail, &x.At); err != nil {
			serverError(w, r, err)
			return
		}
		out = append(out, x)
	}
	reply(w, http.StatusOK, map[string]any{"audit": out})
}

func plural(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return strconv.Itoa(n) + " " + what + "s"
}
