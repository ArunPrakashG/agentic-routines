package main

import (
	"context"
	"log/slog"
	"net/netip"
	"time"

	"github.com/redis/go-redis/v9"
)

// limiter counts calls per visitor in Redis, so the count survives a restart and holds if
// there is ever more than one instance. If Redis is down it lets calls through.
type limiter struct {
	rdb    *redis.Client
	limit  int64
	window time.Duration
}

func newLimiter(url string, limit int, window time.Duration) (*limiter, error) {
	o, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	o.PoolSize = 8
	o.DialTimeout = 500 * time.Millisecond
	o.ReadTimeout = 200 * time.Millisecond
	o.WriteTimeout = 200 * time.Millisecond
	return &limiter{redis.NewClient(o), int64(limit), window}, nil
}

func (l *limiter) allow(ctx context.Context, group, visitor string) bool {
	key := "br:rl:" + group + ":" + visitorKey(visitor)
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	pipe := l.rdb.Pipeline()
	n := pipe.Incr(ctx, key)
	pipe.ExpireNX(ctx, key, l.window)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("rate limit check failed", "err", err)
		return true
	}
	return n.Val() <= l.limit
}

// An IPv6 visitor can pick any address in their /64, so they count as one.
func visitorKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return "unknown"
	}
	if a.Is4In6() {
		a = a.Unmap()
	}
	if a.Is6() {
		p, _ := a.Prefix(64)
		return p.Masked().Addr().String() + "/64"
	}
	return a.String()
}
