package main

import (
	"errors"
	"os"
	"strings"
)

type config struct {
	Port               string
	DatabaseURL        string
	RedisURL           string
	GoogleClientID     string
	GoogleClientSecret string
	SessionSecret      []byte
	// The host name of the proxy whose X-Client-IP is believed. Empty believes nobody.
	TrustedProxy string
	// Who may review submissions. There is no way to become one from inside the service.
	AdminEmails map[string]bool

	// Where Google is reached. Only the functional test changes these.
	GoogleTokenURL string
	GoogleJWKSURL  string
	GoogleIssuers  []string

	// GitHub and Microsoft are offered only when both halves of their client are set.
	GitHubClientID, GitHubClientSecret       string
	MicrosoftClientID, MicrosoftClientSecret string
	// Where they are reached. Only the functional test changes these.
	GitHubTokenURL, GitHubAPIURL        string
	MicrosoftTokenURL, MicrosoftJWKSURL string
	MicrosoftIssuerFormat               string // has one %s, the tenant id

	// Email and password sign-in is offered only when mail can be sent.
	SMTPAddr, SMTPUser, SMTPPass, MailFrom string
}

func loadConfig() (config, error) {
	c := config{
		Port:               env("PORT", "8080"),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		RedisURL:           os.Getenv("REDIS_URL"),
		GoogleClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		GoogleClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		SessionSecret:      []byte(os.Getenv("SESSION_SECRET")),
		TrustedProxy:       os.Getenv("TRUSTED_PROXY"),
		GoogleTokenURL:     env("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
		GoogleJWKSURL:      env("GOOGLE_JWKS_URL", "https://www.googleapis.com/oauth2/v3/certs"),
		GoogleIssuers:      []string{"https://accounts.google.com", "accounts.google.com"},

		GitHubClientID:        os.Getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret:    os.Getenv("GITHUB_CLIENT_SECRET"),
		GitHubTokenURL:        env("GITHUB_TOKEN_URL", "https://github.com/login/oauth/access_token"),
		GitHubAPIURL:          env("GITHUB_API_URL", "https://api.github.com"),
		MicrosoftClientID:     os.Getenv("MICROSOFT_CLIENT_ID"),
		MicrosoftClientSecret: os.Getenv("MICROSOFT_CLIENT_SECRET"),
		MicrosoftTokenURL:     env("MICROSOFT_TOKEN_URL", "https://login.microsoftonline.com/common/oauth2/v2.0/token"),
		MicrosoftJWKSURL:      env("MICROSOFT_JWKS_URL", "https://login.microsoftonline.com/common/discovery/v2.0/keys"),
		MicrosoftIssuerFormat: env("MICROSOFT_ISSUER_FORMAT", "https://login.microsoftonline.com/%s/v2.0"),

		SMTPAddr: os.Getenv("SMTP_ADDR"),
		SMTPUser: os.Getenv("SMTP_USER"),
		SMTPPass: os.Getenv("SMTP_PASS"),
		MailFrom: os.Getenv("MAIL_FROM"),
	}
	c.AdminEmails = map[string]bool{}
	for _, e := range strings.Split(os.Getenv("ADMIN_EMAILS"), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			c.AdminEmails[e] = true
		}
	}
	if v := os.Getenv("GOOGLE_ISSUER"); v != "" {
		c.GoogleIssuers = strings.Split(v, ",")
	}
	for name, v := range map[string]string{
		"DATABASE_URL": c.DatabaseURL, "REDIS_URL": c.RedisURL,
		"GOOGLE_CLIENT_ID": c.GoogleClientID, "GOOGLE_CLIENT_SECRET": c.GoogleClientSecret,
	} {
		if v == "" {
			return c, errors.New(name + " is not set")
		}
	}
	if (c.GitHubClientID == "") != (c.GitHubClientSecret == "") || (c.MicrosoftClientID == "") != (c.MicrosoftClientSecret == "") {
		return c, errors.New("a provider needs both its client id and its client secret")
	}
	if c.SMTPAddr != "" && c.MailFrom == "" {
		return c, errors.New("MAIL_FROM is not set")
	}
	if len(c.SessionSecret) < 32 {
		return c, errors.New("SESSION_SECRET must be at least 32 characters")
	}
	return c, nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
