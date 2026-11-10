package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type app struct {
	cfg       config
	proxy     *proxyAddrs
	db        *store
	google    *google
	github    *github
	microsoft *microsoft
	mailer    *mailer
	signer    signer
	limiter   *limiter
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("GET /api/v1/auth/providers", a.limitedTo("read", 120, a.providers))
	mux.HandleFunc("POST /api/v1/auth/google", a.limited(a.signIn))
	mux.HandleFunc("POST /api/v1/auth/github", a.limited(a.signInGitHub))
	mux.HandleFunc("POST /api/v1/auth/microsoft", a.limited(a.signInMicrosoft))
	mux.HandleFunc("POST /api/v1/auth/password/code", a.limited(a.passwordCode))
	mux.HandleFunc("POST /api/v1/auth/password/set", a.limited(a.passwordSet))
	mux.HandleFunc("POST /api/v1/auth/password/login", a.limited(a.passwordLogin))
	mux.HandleFunc("POST /api/v1/auth/refresh", a.limited(a.refresh))
	mux.HandleFunc("POST /api/v1/auth/signout", a.limited(a.signOut))
	mux.HandleFunc("GET /api/v1/me", a.limitedTo("read", 120, a.me))
	mux.HandleFunc("DELETE /api/v1/me", a.limitedTo("write", 10, a.deleteMe))
	mux.HandleFunc("PUT /api/v1/me/handle", a.limitedTo("write", 10, a.setHandle))
	mux.HandleFunc("GET /api/v1/me/routines", a.limitedTo("read", 120, a.myRoutines))
	mux.HandleFunc("PUT /api/v1/routines/{name}", a.limitedTo("write", 20, a.publish))
	mux.HandleFunc("DELETE /api/v1/routines/{name}", a.limitedTo("write", 20, a.unpublish))
	mux.HandleFunc("GET /api/v1/me/submissions", a.limitedTo("read", 120, a.mySubmissions))
	mux.HandleFunc("DELETE /api/v1/me/submissions/{id}", a.limitedTo("write", 20, a.withdraw))
	mux.HandleFunc("GET /api/v1/blocklist", a.limitedTo("read", 120, a.blocklist))
	a.adminRoutes(mux)
	mux.HandleFunc("GET /api/v1/routines", a.limitedTo("read", 120, a.search))
	mux.HandleFunc("GET /api/v1/routines/{owner}/{name}", a.limitedTo("read", 120, a.getRoutine))
	mux.HandleFunc("POST /api/v1/routines/{owner}/{name}/installs", a.limitedTo("install", 20, a.countInstall))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fail(w, http.StatusNotFound, "not_found") })
	return a.wrap(mux)
}

// ---------- plumbing ----------

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(s int) {
	w.status = s
	w.ResponseWriter.WriteHeader(s)
}

func (a *app) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		// Nothing here is for a shared cache: it is all per person. The proxy adds the rest of the security
		// headers; these are for a response that reaches a browser some other way. It is all JSON.
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Referrer-Policy", "no-referrer")
		// The directory and the block list are public, and the website reads them from the browser.
		if r.Method == http.MethodGet && publicRead(r.URL.Path) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		defer func() {
			if p := recover(); p != nil {
				slog.Error("panic", "path", r.URL.Path, "panic", p)
				if sw.status == http.StatusOK {
					fail(sw, http.StatusInternalServerError, "server_error")
				}
			}
			if r.URL.Path != "/healthz" {
				slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
			}
		}()
		next.ServeHTTP(sw, r)
	})
}

// proxyAddrs knows the addresses behind the proxy's host name. It looks them up at most once a minute, and a
// failed lookup keeps the last answer, so a DNS hiccup does not put every visitor behind one address.
type proxyAddrs struct {
	name  string
	mu    sync.Mutex
	addrs map[netip.Addr]bool
	at    time.Time
}

func (p *proxyAddrs) isProxy(ctx context.Context, remote string) bool {
	if p == nil || p.name == "" {
		return false
	}
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.at) > time.Minute {
		ctx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		if found, err := net.DefaultResolver.LookupNetIP(ctx, "ip", p.name); err == nil {
			p.addrs = make(map[netip.Addr]bool, len(found))
			for _, f := range found {
				p.addrs[f.Unmap()] = true
			}
			p.at = time.Now()
		}
	}
	return p.addrs[addr.Unmap()]
}

func publicRead(path string) bool {
	return path == "/api/v1/blocklist" || path == "/api/v1/routines" || strings.HasPrefix(path, "/api/v1/routines/")
}

// The proxy in front sets X-Client-IP from the connection it saw, replacing whatever the visitor sent. Other
// containers can reach the app too, so the header counts only on a connection from the proxy. A value that
// is not an address is not believed.
func (a *app) clientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Client-IP")); v != "" && a.proxy.isProxy(r.Context(), r.RemoteAddr) {
		if _, err := netip.ParseAddr(v); err == nil {
			return v
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *app) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.limiter.allow(r.Context(), "auth", a.clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			fail(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next(w, r)
	}
}

// limitedTo counts calls per visitor in a group of its own, up to limit a minute.
func (a *app) limitedTo(group string, limit int64, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.limiter.within(r.Context(), group, a.clientIP(r), limit) {
			w.Header().Set("Retry-After", "60")
			fail(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next(w, r)
	}
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code string) {
	reply(w, status, map[string]string{"error": code})
}

func serverError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("request failed", "path", r.URL.Path, "err", err)
	fail(w, http.StatusInternalServerError, "server_error")
}

// readJSON takes a small JSON object whose named fields are all present, non-empty and at most max long.
func readJSON(w http.ResponseWriter, r *http.Request, fields map[string]int) (map[string]string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var in map[string]any
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return nil, false
	}
	out := make(map[string]string, len(fields))
	for name, max := range fields {
		s, ok := in[name].(string)
		if !ok || s == "" || len(s) > max {
			fail(w, http.StatusBadRequest, "bad_request")
			return nil, false
		}
		out[name] = s
	}
	return out, true
}

// ---------- handlers ----------

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.db.ping(ctx); err != nil {
		fail(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte("ok\n"))
}

// The extension did the Google screen with PKCE and hands over the code.
func (a *app) signIn(w http.ResponseWriter, r *http.Request) {
	b, ok := readJSON(w, r, map[string]int{"code": 2048, "code_verifier": 128, "redirect_uri": 512, "nonce": 256, "install_id": 128})
	if !ok {
		return
	}
	idToken, err := a.google.exchange(r.Context(), b["code"], b["code_verifier"], b["redirect_uri"])
	if errors.Is(err, errGoogleRejected) {
		fail(w, http.StatusUnauthorized, "google_rejected")
		return
	}
	if err != nil {
		slog.Warn("google token exchange failed", "err", err)
		fail(w, http.StatusBadGateway, "google_unreachable")
		return
	}
	claims, err := a.google.verify(r.Context(), idToken, b["nonce"])
	if err != nil {
		if errors.Is(err, errBadIDToken) {
			slog.Info("id token refused", "err", err)
			fail(w, http.StatusUnauthorized, "bad_id_token")
		} else {
			slog.Warn("could not check the id token", "err", err)
			fail(w, http.StatusBadGateway, "google_unreachable")
		}
		return
	}

	id := identity{Provider: "google", Subject: claims.Subject, Email: claims.Email, Verified: true, Name: claims.Name}
	if claims.Picture != "" {
		id.Picture = &claims.Picture
	}
	a.startSession(w, r, id, b["install_id"], nil)
}

// startSession signs the identity in and answers with the tokens and the account.
func (a *app) startSession(w http.ResponseWriter, r *http.Request, id identity, install string, then func(pgx.Tx, string) error) {
	now := time.Now()
	refresh, hash := newRefreshToken()
	u, sid, err := a.db.signIn(r.Context(), id, install, hash, now.Add(refreshTTL), then)
	if err != nil {
		serverError(w, r, err)
		return
	}
	u.Admin = u.Verified && a.cfg.AdminEmails[strings.ToLower(u.Email)]
	access, err := a.signer.access(u.ID, sid, install, now)
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, struct {
		tokens
		User user `json:"user"`
	}{tokens{access, int(accessTTL.Seconds()), refresh}, u})
}

func (a *app) refresh(w http.ResponseWriter, r *http.Request) {
	b, ok := readJSON(w, r, map[string]int{"refresh_token": 256, "install_id": 128})
	if !ok {
		return
	}
	now := time.Now()
	next, nextHash := newRefreshToken()
	userID, sid, err := a.db.rotate(r.Context(), hashOf(b["refresh_token"]), b["install_id"], nextHash, now, now.Add(refreshTTL))
	if errors.Is(err, errSignedOut) {
		fail(w, http.StatusUnauthorized, "signed_out")
		return
	}
	if err != nil {
		serverError(w, r, err)
		return
	}
	access, err := a.signer.access(userID, sid, b["install_id"], now)
	if err != nil {
		serverError(w, r, err)
		return
	}
	reply(w, http.StatusOK, tokens{access, int(accessTTL.Seconds()), next})
}

func (a *app) signOut(w http.ResponseWriter, r *http.Request) {
	b, ok := readJSON(w, r, map[string]int{"refresh_token": 256})
	if !ok {
		return
	}
	if err := a.db.signOut(r.Context(), hashOf(b["refresh_token"])); err != nil {
		serverError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var bearer = regexp.MustCompile(`^Bearer (\S+)$`)

func (a *app) me(w http.ResponseWriter, r *http.Request) {
	if u, ok := a.user(w, r); ok {
		reply(w, http.StatusOK, u)
	}
}
