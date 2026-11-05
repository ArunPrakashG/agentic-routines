package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	accessTTL  = 15 * time.Minute
	refreshTTL = 60 * 24 * time.Hour
	issuer     = "browser-routines"
)

type tokens struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
}

type sessionClaims struct {
	jwt.RegisteredClaims
	Session string `json:"sid"`
	Install string `json:"ins"`
}

type signer struct{ secret []byte }

func (s signer) access(userID, sessionID, install string, now time.Time) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, sessionClaims{
		RegisteredClaims: jwt.RegisteredClaims{Issuer: issuer, Subject: userID, IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(accessTTL))},
		Session:          sessionID, Install: install,
	}).SignedString(s.secret)
}

// check returns the claims of a current access token, or nil.
func (s signer) check(token string) *sessionClaims {
	c := &sessionClaims{}
	_, err := jwt.ParseWithClaims(token, c, func(*jwt.Token) (any, error) { return s.secret, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(issuer), jwt.WithExpirationRequired(), jwt.WithLeeway(5*time.Second))
	if err != nil || c.Subject == "" || c.Session == "" {
		return nil
	}
	return c
}

func newRefreshToken() (token string, hash []byte) {
	b := make([]byte, 32)
	rand.Read(b)
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, hashOf(token)
}

func hashOf(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
