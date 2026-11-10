package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The other places a person can sign in. Like Google, the extension runs the provider's screen with PKCE and
// hands over the code; this side holds the client secret, trades the code, and decides what the answer proves.

var errRejected = errors.New("provider rejected the code")

// postForm sends a token request and returns the JSON answer, or errRejected when the provider says no.
func postForm(ctx context.Context, c *http.Client, endpoint string, form url.Values) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out map[string]any
	err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	if res.StatusCode >= 500 {
		return nil, fmt.Errorf("status %d", res.StatusCode)
	}
	// GitHub answers a bad code with 200 and an error field.
	if err != nil || res.StatusCode != http.StatusOK || out["error"] != nil {
		return nil, errRejected
	}
	return out, nil
}

// ---------- GitHub ----------

type github struct {
	clientID, secret, tokenURL, apiURL string
	http                               *http.Client
}

func newGitHub(c config) *github {
	if c.GitHubClientID == "" {
		return nil
	}
	return &github{c.GitHubClientID, c.GitHubClientSecret, c.GitHubTokenURL, strings.TrimSuffix(c.GitHubAPIURL, "/"), &http.Client{Timeout: 5 * time.Second}}
}

func (g *github) get(ctx context.Context, token, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.apiURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "agentic-routines-api")
	res, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("github %s: status %d", path, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
}

// identity trades the code for the person's GitHub id and primary verified email. The access token lives only
// for these two calls.
func (g *github) identity(ctx context.Context, code, verifier, redirect string) (identity, error) {
	tok, err := postForm(ctx, g.http, g.tokenURL, url.Values{
		"client_id": {g.clientID}, "client_secret": {g.secret}, "code": {code}, "redirect_uri": {redirect}, "code_verifier": {verifier},
	})
	if err != nil {
		return identity{}, err
	}
	access, _ := tok["access_token"].(string)
	if access == "" {
		return identity{}, errRejected
	}
	var me struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := g.get(ctx, access, "/user", &me); err != nil {
		return identity{}, err
	}
	if me.ID == 0 || me.Login == "" {
		return identity{}, errRejected
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := g.get(ctx, access, "/user/emails", &emails); err != nil {
		return identity{}, err
	}
	// Only a verified address is believed, the primary one first. A GitHub account with none gets a
	// stand-in that is shown, not trusted.
	id := identity{Provider: "github", Subject: strconv.FormatInt(me.ID, 10), Name: me.Name}
	for _, e := range emails {
		if e.Verified && e.Email != "" && (id.Email == "" || e.Primary) {
			id.Email, id.Verified = e.Email, true
		}
	}
	if id.Email == "" {
		id.Email = me.Login + "@users.noreply.github.com"
	}
	if id.Name == "" {
		id.Name = me.Login
	}
	if me.AvatarURL != "" {
		id.Picture = &me.AvatarURL
	}
	return id, nil
}

// ---------- Microsoft ----------

type microsoft struct {
	clientID, secret, tokenURL, issuerFormat string
	http                                     *http.Client
	keys                                     *keySet
}

func newMicrosoft(c config) *microsoft {
	if c.MicrosoftClientID == "" {
		return nil
	}
	client := &http.Client{Timeout: 5 * time.Second}
	return &microsoft{c.MicrosoftClientID, c.MicrosoftClientSecret, c.MicrosoftTokenURL, c.MicrosoftIssuerFormat, client, &keySet{url: c.MicrosoftJWKSURL, http: client}}
}

type msClaims struct {
	jwt.RegisteredClaims
	Nonce             string `json:"nonce"`
	Tenant            string `json:"tid"`
	Name              string `json:"name"`
	Email             string `json:"email"`
	PreferredUsername string `json:"preferred_username"`
}

// identity checks the ID token Microsoft returns. Its email claim can be set by a tenant admin to anything, so it
// is shown but never trusted: the identity is unverified, and so it can neither join an account nor review.
func (m *microsoft) identity(ctx context.Context, code, verifier, redirect, nonce string) (identity, error) {
	tok, err := postForm(ctx, m.http, m.tokenURL, url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"redirect_uri": {redirect}, "client_id": {m.clientID}, "client_secret": {m.secret}, "scope": {"openid profile email"},
	})
	if err != nil {
		return identity{}, err
	}
	raw, _ := tok["id_token"].(string)
	if raw == "" {
		return identity{}, errRejected
	}
	c := &msClaims{}
	_, err = jwt.ParseWithClaims(raw, c, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return m.keys.get(ctx, kid)
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(m.clientID), jwt.WithExpirationRequired(), jwt.WithLeeway(30*time.Second))
	if err != nil {
		return identity{}, fmt.Errorf("%w: %v", errBadIDToken, err)
	}
	// The sign-in endpoint is shared by every tenant, so the issuer has to name the tenant the token says it is from.
	if c.Tenant == "" || c.Issuer != fmt.Sprintf(m.issuerFormat, c.Tenant) || c.Nonce != nonce || c.Subject == "" {
		return identity{}, errBadIDToken
	}
	email := c.Email
	if email == "" {
		email = c.PreferredUsername
	}
	if email == "" {
		email = c.Subject + "@microsoft.invalid"
	}
	id := identity{Provider: "microsoft", Subject: c.Tenant + ":" + c.Subject, Email: email, Name: c.Name}
	if id.Name == "" {
		id.Name = email
	}
	return id, nil
}

// ---------- the endpoints ----------

// providers tells the extension what it can offer, and the public client ids to offer it with.
func (a *app) providers(w http.ResponseWriter, r *http.Request) {
	type p struct {
		ID       string `json:"id"`
		ClientID string `json:"client_id"`
	}
	list := []p{{"google", a.cfg.GoogleClientID}}
	if a.github != nil {
		list = append(list, p{"github", a.cfg.GitHubClientID})
	}
	if a.microsoft != nil {
		list = append(list, p{"microsoft", a.cfg.MicrosoftClientID})
	}
	reply(w, http.StatusOK, map[string]any{"providers": list, "password": a.mailer != nil})
}

func (a *app) signInGitHub(w http.ResponseWriter, r *http.Request) {
	if a.github == nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	b, ok := readJSON(w, r, map[string]int{"code": 2048, "code_verifier": 128, "redirect_uri": 512, "install_id": 128})
	if !ok {
		return
	}
	id, err := a.github.identity(r.Context(), b["code"], b["code_verifier"], b["redirect_uri"])
	a.finish(w, r, "github", id, err, b["install_id"])
}

func (a *app) signInMicrosoft(w http.ResponseWriter, r *http.Request) {
	if a.microsoft == nil {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	b, ok := readJSON(w, r, map[string]int{"code": 4096, "code_verifier": 128, "redirect_uri": 512, "nonce": 256, "install_id": 128})
	if !ok {
		return
	}
	id, err := a.microsoft.identity(r.Context(), b["code"], b["code_verifier"], b["redirect_uri"], b["nonce"])
	a.finish(w, r, "microsoft", id, err, b["install_id"])
}

// finish answers a provider sign-in: the provider's refusal, its failure, or a new session.
func (a *app) finish(w http.ResponseWriter, r *http.Request, provider string, id identity, err error, install string) {
	switch {
	case errors.Is(err, errRejected):
		fail(w, http.StatusUnauthorized, "provider_rejected")
		return
	case errors.Is(err, errBadIDToken):
		slog.Info("id token refused", "provider", provider, "err", err)
		fail(w, http.StatusUnauthorized, "bad_id_token")
		return
	case err != nil:
		slog.Warn("provider sign-in failed", "provider", provider, "err", err)
		fail(w, http.StatusBadGateway, "provider_unreachable")
		return
	}
	a.startSession(w, r, id, install, nil)
}
