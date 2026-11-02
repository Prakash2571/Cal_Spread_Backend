package kv_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kv"
)

// fakeClock lets a test move time without sleeping.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newCache(t *testing.T) (*kv.Cache, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)}
	return kv.New(dbtest.New(t), clk.now), clk
}

func TestPlainValueTTL(t *testing.T) {
	c, clk := newCache(t)
	ctx := context.Background()
	if _, ok, err := c.Get(ctx, "prevclose"); ok || err != nil {
		t.Fatalf("absent key: ok=%v err=%v", ok, err)
	}
	if err := c.Set(ctx, "prevclose", `{"a":1}`, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if v, ok, _ := c.Get(ctx, "prevclose"); !ok || v != `{"a":1}` {
		t.Fatalf("Get = %q,%v", v, ok)
	}
	clk.advance(9 * time.Second)
	if _, ok, _ := c.Get(ctx, "prevclose"); !ok {
		t.Fatal("still live at 9s")
	}
	clk.advance(2 * time.Second)
	if _, ok, _ := c.Get(ctx, "prevclose"); ok {
		t.Fatal("expired at 11s")
	}
	// Overwriting replaces the value and resets the TTL.
	if err := c.Set(ctx, "prevclose", "2", 0); err != nil {
		t.Fatal(err)
	}
	clk.advance(24 * time.Hour)
	if v, ok, _ := c.Get(ctx, "prevclose"); !ok || v != "2" {
		t.Fatalf("no-expiry value gone: %q,%v", v, ok)
	}
}

func TestHashSemantics(t *testing.T) {
	c, clk := newCache(t)
	ctx := context.Background()
	if m, err := c.HGetAll(ctx, "oiframe:v2:1m"); err != nil || len(m) != 0 {
		t.Fatalf("absent hash: %v %v", m, err)
	}
	if err := c.HSet(ctx, "oiframe:v2:1m", map[string]string{"100": "a", "200": "b"}); err != nil {
		t.Fatal(err)
	}
	if err := c.HSet(ctx, "oiframe:v2:1m", map[string]string{"200": "B", "300": "c"}); err != nil {
		t.Fatal(err)
	}
	m, _ := c.HGetAll(ctx, "oiframe:v2:1m")
	if len(m) != 3 || m["100"] != "a" || m["200"] != "B" || m["300"] != "c" {
		t.Fatalf("HGetAll = %v", m)
	}
	// A new hash has no TTL until EXPIRE; HSET into an existing hash keeps its TTL.
	if ok, err := c.Expire(ctx, "oiframe:v2:1m", time.Minute); !ok || err != nil {
		t.Fatalf("Expire = %v %v", ok, err)
	}
	clk.advance(30 * time.Second)
	if err := c.HSet(ctx, "oiframe:v2:1m", map[string]string{"400": "d"}); err != nil {
		t.Fatal(err)
	}
	clk.advance(31 * time.Second)
	if m, _ := c.HGetAll(ctx, "oiframe:v2:1m"); len(m) != 0 {
		t.Fatalf("hash must expire as a whole, got %v", m)
	}
	// Writing to an expired hash starts a fresh one without the stale fields.
	if err := c.HSet(ctx, "oiframe:v2:1m", map[string]string{"500": "e"}); err != nil {
		t.Fatal(err)
	}
	m, _ = c.HGetAll(ctx, "oiframe:v2:1m")
	if len(m) != 1 || m["500"] != "e" {
		t.Fatalf("fresh hash = %v", m)
	}
	clk.advance(24 * time.Hour)
	if m, _ := c.HGetAll(ctx, "oiframe:v2:1m"); len(m) != 1 {
		t.Fatal("the fresh hash has no TTL until Expire")
	}
}

func TestHDelDropsEmptyHashAndExpireOnMissingKey(t *testing.T) {
	c, _ := newCache(t)
	ctx := context.Background()
	_ = c.HSet(ctx, "h", map[string]string{"a": "1", "b": "2"})
	_ = c.HDel(ctx, "h", "a", "zzz")
	if m, _ := c.HGetAll(ctx, "h"); len(m) != 1 || m["b"] != "2" {
		t.Fatalf("after HDel: %v", m)
	}
	_ = c.HDel(ctx, "h", "b")
	if ok, _ := c.Expire(ctx, "h", time.Minute); ok {
		t.Fatal("an emptied hash no longer exists, so Expire reports false")
	}
	if ok, _ := c.Expire(ctx, "never", time.Minute); ok {
		t.Fatal("Expire on a missing key reports false")
	}
}

func TestDelPurgeAndSetReplacesHash(t *testing.T) {
	c, clk := newCache(t)
	ctx := context.Background()
	_ = c.HSet(ctx, "h", map[string]string{"a": "1"})
	_ = c.Set(ctx, "h", "plain", time.Hour) // SET replaces a hash
	if m, _ := c.HGetAll(ctx, "h"); len(m) != 1 || m[""] != "plain" {
		t.Fatalf("hash not replaced: %v", m)
	}
	_ = c.Set(ctx, "short", "x", time.Second)
	_ = c.Set(ctx, "long", "y", time.Hour)
	clk.advance(time.Minute)
	if n, err := c.Purge(ctx); err != nil || n != 1 {
		t.Fatalf("Purge removed %d, err %v (want 1)", n, err)
	}
	if err := c.Del(ctx, "long", "h", "nothing"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := c.Get(ctx, "long"); ok {
		t.Fatal("Del did not remove the key")
	}
	if err := c.Ping(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestKeysArePrefixed(t *testing.T) {
	clk := &fakeClock{t: time.Now()}
	pool := dbtest.New(t)
	c := kv.New(pool, clk.now)
	_ = c.Set(context.Background(), "k", "v", 0)
	var stored string
	if err := pool.QueryRow(context.Background(), `select key from kv_keys`).Scan(&stored); err != nil || stored != "calspread:k" {
		t.Fatalf("stored key = %q, err %v", stored, err)
	}
}

func TestDisabledCacheBehavesLikeUnconfiguredRedis(t *testing.T) {
	c := kv.New(nil, nil)
	ctx := context.Background()
	if c.Enabled() {
		t.Fatal("must be disabled")
	}
	if _, ok, err := c.Get(ctx, "k"); ok || err != nil {
		t.Fatalf("Get: %v %v", ok, err)
	}
	if m, err := c.HGetAll(ctx, "k"); err != nil || len(m) != 0 {
		t.Fatalf("HGetAll: %v %v", m, err)
	}
	if err := c.Set(ctx, "k", "v", 0); err != kv.ErrDisabled {
		t.Fatalf("Set error = %v", err)
	}
	if err := c.Ping(ctx); err != kv.ErrDisabled {
		t.Fatalf("Ping error = %v", err)
	}
	if n, err := c.Purge(ctx); n != 0 || err != nil {
		t.Fatalf("Purge: %d %v", n, err)
	}
}
