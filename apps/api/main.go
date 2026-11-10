// The Agentic Routines API: Google sign-in and the accounts everything else belongs to.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--health" {
		os.Exit(health())
	}
	if err := run(); err != nil {
		slog.Error("stopped", "err", err)
		os.Exit(1)
	}
}

// health is what the container's check runs: ask the server on this machine.
func health() int {
	c := http.Client{Timeout: 2 * time.Second}
	res, err := c.Get("http://127.0.0.1:" + env("PORT", "8080") + "/healthz")
	if err != nil {
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() error {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := openStore(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.db.Close()
	lim, err := newLimiter(cfg.RedisURL, 30, time.Minute)
	if err != nil {
		return err
	}
	a := &app{cfg: cfg, proxy: &proxyAddrs{name: cfg.TrustedProxy}, db: db, google: newGoogle(cfg), github: newGitHub(cfg), microsoft: newMicrosoft(cfg), mailer: newMailer(cfg), signer: signer{cfg.SessionSecret}, limiter: lim}

	go func() {
		for {
			if n, err := db.deleteExpired(ctx); err != nil && ctx.Err() == nil {
				slog.Warn("could not clear expired sessions", "err", err)
			} else if n > 0 {
				slog.Info("cleared expired sessions", "count", n)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Hour):
			}
		}
	}()

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           a.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// A sign-in waits on Google twice, each limited to 5 seconds.
		WriteTimeout: 20 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("listening", "addr", srv.Addr)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
