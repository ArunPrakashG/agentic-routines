package main

import (
	"context"
	"log/slog"
	"net/netip"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// limiter counts calls per visitor in Redis, so the count survives a restart and holds if
// there is ever more than one instance. If Redis is down it counts in this process instead, so
// sign-in and publishing still have a limit, though one that resets on a restart.
type limiter struct {
	rdb    *redis.Client
	limit  int64
	window time.Duration
	local  localCounts
}

// localCounts is the in-process stand-in for Redis: a count per key, and when its window ends.
type localCounts struct {
	mu   sync.Mutex
	keys map[string]localCount
}

type localCount struct {
	n     int64
	until time.Time
}

// maxLocalKeys bounds memory if Redis stays down under a flood of new visitors.
const maxLocalKeys = 50_000

func (c *localCounts) incr(key string, window time.Duration) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if c.keys == nil {
		c.keys = map[string]localCount{}
	}
	e, ok := c.keys[key]
	if !ok || !now.Before(e.until) {
		if !ok && len(c.keys) >= maxLocalKeys {
			c.prune(now)
		}
		e = localCount{until: now.Add(window)}
	}
	e.n++
	c.keys[key] = e
	return e.n
}

func (c *localCounts) get(key string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.keys[key]; ok && time.Now().Before(e.until) {
		return e.n
	}
	return 0
}

func (c *localCounts) del(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.keys, key)
}

// prune drops ended windows, and if every window is still running, all of them: a fresh count is
// better than an unbounded map. Called with the lock held.
func (c *localCounts) prune(now time.Time) {
	for k, e := range c.keys {
		if !now.Before(e.until) {
			delete(c.keys, k)
		}
	}
	if len(c.keys) >= maxLocalKeys {
		clear(c.keys)
	}
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
	return &limiter{rdb: redis.NewClient(o), limit: int64(limit), window: window}, nil
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
		slog.Warn("rate limit check failed, counting in process", "err", err)
		return l.local.incr(key, l.window) <= limit
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
// down it is decided in this process.
func (l *limiter) once(ctx context.Context, group, visitor, what string, window time.Duration) bool {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	key := "br:once:" + group + ":" + visitorKey(visitor) + ":" + what
	ok, err := l.rdb.SetNX(ctx, key, 1, window).Result()
	if err != nil {
		slog.Warn("rate limit check failed, counting in process", "err", err)
		return l.local.incr(key, window) == 1
	}
	return ok
}

// count is how many hits a key has in its window. With Redis down it is the count kept in this process.
func (l *limiter) count(ctx context.Context, key string) int64 {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	n, err := l.rdb.Get(ctx, "br:rl:"+key).Int64()
	if err != nil {
		return l.local.get("br:rl:" + key)
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
		slog.Warn("rate limit check failed, counting in process", "err", err)
		return l.local.incr("br:rl:"+key, window)
	}
	return n.Val()
}

func (l *limiter) clear(ctx context.Context, key string) {
	ctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	l.rdb.Del(ctx, "br:rl:"+key)
	l.local.del("br:rl:" + key)
}
