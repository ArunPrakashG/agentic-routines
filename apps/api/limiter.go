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
	return l.within(ctx, group, visitor, l.limit)
}

// within is allow with a limit of its own, for groups that need more or fewer calls than sign-in does.
func (l *limiter) within(ctx context.Context, group, visitor string, limit int64) bool {
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
	return n.Val() <= limit
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

// once is true the first time a visitor does a thing in a window, and false for the repeats. If Redis is
// down it says yes, as the other limits do.
func (l *limiter) once(ctx context.Context, group, visitor, what string, window time.Duration) bool {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	ok, err := l.rdb.SetNX(ctx, "br:once:"+group+":"+visitorKey(visitor)+":"+what, 1, window).Result()
	if err != nil {
		slog.Warn("rate limit check failed", "err", err)
		return true
	}
	return ok
}

// count is how many hits a key has in its window. Redis being down counts as none, like the other checks.
func (l *limiter) count(ctx context.Context, key string) int64 {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	n, err := l.rdb.Get(ctx, "br:rl:"+key).Int64()
	if err != nil {
		return 0
	}
	return n
}

// hit adds one to a key. The window starts at the first hit.
func (l *limiter) hit(ctx context.Context, key string, window time.Duration) int64 {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	pipe := l.rdb.Pipeline()
	n := pipe.Incr(ctx, "br:rl:"+key)
	pipe.ExpireNX(ctx, "br:rl:"+key, window)
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Warn("rate limit check failed", "err", err)
		return 0
	}
	return n.Val()
}

func (l *limiter) clear(ctx context.Context, key string) {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	l.rdb.Del(ctx, "br:rl:"+key)
}
