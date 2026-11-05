package main

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// google trades the code the extension got from Google's sign-in screen for an ID token and
// checks it. This side holds the client secret.
type google struct {
	clientID, secret, tokenURL string
	issuers                    []string
	http                       *http.Client
	keys                       *keySet
}

func newGoogle(c config) *google {
	client := &http.Client{Timeout: 5 * time.Second}
	return &google{
		clientID: c.GoogleClientID, secret: c.GoogleClientSecret, tokenURL: c.GoogleTokenURL,
		issuers: c.GoogleIssuers, http: client, keys: &keySet{url: c.GoogleJWKSURL, http: client},
	}
}

func (g *google) exchange(ctx context.Context, code, verifier, redirect string) (string, error) {
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"redirect_uri": {redirect}, "client_id": {g.clientID}, "client_secret": {g.secret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := g.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		return "", errGoogleRejected
	}
	var out struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil || out.IDToken == "" {
		return "", errGoogleRejected
	}
	return out.IDToken, nil
}

var (
	errGoogleRejected = errors.New("google rejected the code")
	errBadIDToken     = errors.New("bad id token")
)

type idClaims struct {
	jwt.RegisteredClaims
	Nonce         string `json:"nonce"`
	Email         string `json:"email"`
	EmailVerified any    `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

func (g *google) verify(ctx context.Context, token, nonce string) (*idClaims, error) {
	c := &idClaims{}
	_, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		return g.keys.get(ctx, kid)
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(g.clientID), jwt.WithExpirationRequired(), jwt.WithLeeway(30*time.Second))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errBadIDToken, err)
	}
	verified := c.EmailVerified == true || c.EmailVerified == "true"
	if !slices.Contains(g.issuers, c.Issuer) || c.Nonce != nonce || !verified || c.Subject == "" || c.Email == "" {
		return nil, errBadIDToken
	}
	if c.Name == "" {
		c.Name = c.Email
	}
	return c, nil
}

// keySet is Google's signing keys, kept for as long as Google says they are good.
type keySet struct {
	url  string
	http *http.Client

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	expires time.Time
	fetched time.Time
}

var maxAge = regexp.MustCompile(`max-age=(\d+)`)

func (k *keySet) get(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	now := time.Now()
	if key, ok := k.keys[kid]; ok && now.Before(k.expires) {
		return key, nil
	}
	// An unknown key id may mean Google rotated; look again, but not on every bad token.
	if now.After(k.expires) || now.Sub(k.fetched) > time.Minute {
		if err := k.fetch(ctx); err != nil {
			slog.Warn("could not fetch Google's keys", "err", err)
			if key, ok := k.keys[kid]; ok {
				return key, nil
			}
			return nil, err
		}
	}
	if key, ok := k.keys[kid]; ok {
		return key, nil
	}
	return nil, errors.New("unknown signing key")
}

func (k *keySet) fetch(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.url, nil)
	if err != nil {
		return err
	}
	res, err := k.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	var doc struct {
		Keys []struct{ Kid, Kty, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
		return err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, j := range doc.Keys {
		if j.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(j.N)
		e, err2 := base64.RawURLEncoding.DecodeString(j.E)
		if err1 != nil || err2 != nil || len(e) > 4 {
			continue
		}
		exp := 0
		for _, b := range e {
			exp = exp<<8 | int(b)
		}
		keys[j.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}
	}
	if len(keys) == 0 {
		return errors.New("no usable keys")
	}
	ttl := time.Hour
	if m := maxAge.FindStringSubmatch(res.Header.Get("Cache-Control")); m != nil {
		if s, err := strconv.Atoi(m[1]); err == nil && s > 0 {
			ttl = time.Duration(s) * time.Second
		}
	}
	k.keys, k.fetched, k.expires = keys, time.Now(), time.Now().Add(ttl)
	return nil
}
