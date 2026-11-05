package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"time"
)

type app struct {
	cfg     config
	db      *store
	google  *google
	signer  signer
	limiter *limiter
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("POST /api/v1/auth/google", a.limited(a.signIn))
	mux.HandleFunc("POST /api/v1/auth/refresh", a.limited(a.refresh))
	mux.HandleFunc("POST /api/v1/auth/signout", a.limited(a.signOut))
	mux.HandleFunc("GET /api/v1/me", a.me)
	mux.HandleFunc("DELETE /api/v1/me", a.limitedTo("write", 10, a.deleteMe))
	mux.HandleFunc("PUT /api/v1/me/handle", a.limitedTo("write", 10, a.setHandle))
	mux.HandleFunc("GET /api/v1/me/routines", a.limitedTo("read", 120, a.myRoutines))
	mux.HandleFunc("PUT /api/v1/routines/{name}", a.limitedTo("write", 20, a.publish))
	mux.HandleFunc("DELETE /api/v1/routines/{name}", a.limitedTo("write", 20, a.unpublish))
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
		// Nothing here is for a shared cache: it is all per person. The proxy adds the security headers.
		w.Header().Set("Cache-Control", "no-store")
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

// The proxy in front sets X-Client-IP from the connection it saw; the app is not reachable any other way.
func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Client-IP"); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *app) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.limiter.allow(r.Context(), "auth", clientIP(r)) {
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
		if !a.limiter.within(r.Context(), group, clientIP(r), limit) {
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

	now := time.Now()
	refresh, hash := newRefreshToken()
	var picture *string
	if claims.Picture != "" {
		picture = &claims.Picture
	}
	u, sid, err := a.db.signIn(r.Context(), claims.Subject, claims.Email, claims.Name, picture, b["install_id"], hash, now.Add(refreshTTL))
	if err != nil {
		serverError(w, r, err)
		return
	}
	access, err := a.signer.access(u.ID, sid, b["install_id"], now)
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
