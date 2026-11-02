package analytics

import (
	"context"
	"errors"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kv"
)

// fakeCache is an in-memory cache with the Redis semantics the Node golden's Upstash
// emulation has (testdata/harness.mjs FakeRedis): keys carry the calspread: prefix, a key
// expires as a whole when now >= expiresAt, HSET into a missing key creates a hash without
// a TTL, HDEL of the last field drops the key, EXPIRE of a missing key does nothing.
// failNext fails that many calls; reads are recorded as single-command bodies, the way
// redis.ts sent them.
type fakeCache struct {
	mu       sync.Mutex
	now      func() int64
	keys     map[string]*fakeKey
	failNext int
	onRead   func(cmd []any)
	disabled bool
}

type fakeKey struct {
	hash      map[string]string
	value     *string
	expiresAt *int64
}

var errFakeOutage = errors.New("HTTP 503 fake outage")

func newFakeCache(now func() int64, onRead func(cmd []any)) *fakeCache {
	return &fakeCache{now: now, keys: map[string]*fakeKey{}, onRead: onRead}
}

func (c *fakeCache) Enabled() bool { return c != nil && !c.disabled }

func (c *fakeCache) fail() bool {
	if c.failNext > 0 {
		c.failNext--
		return true
	}
	return false
}

func (c *fakeCache) live(full string) *fakeKey {
	k := c.keys[full]
	if k != nil && k.expiresAt != nil && c.now() >= *k.expiresAt {
		delete(c.keys, full)
		return nil
	}
	return k
}

func (c *fakeCache) record(cmd ...any) {
	if c.onRead != nil {
		c.onRead(cmd)
	}
}

func (c *fakeCache) Ping(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.record("PING")
	if c.fail() {
		return errFakeOutage
	}
	return nil
}

func (c *fakeCache) Get(ctx context.Context, key string) (string, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.record("GET", kv.Prefix+key)
	if c.fail() {
		return "", false, errFakeOutage
	}
	k := c.live(kv.Prefix + key)
	if k == nil || k.value == nil {
		return "", false, nil
	}
	return *k.value, true, nil
}

func (c *fakeCache) HGetAll(ctx context.Context, key string) (map[string]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.record("HGETALL", kv.Prefix+key)
	if c.fail() {
		return nil, errFakeOutage
	}
	out := map[string]string{}
	if k := c.live(kv.Prefix + key); k != nil && k.hash != nil {
		for f, v := range k.hash {
			out[f] = v
		}
	}
	return out, nil
}

func (c *fakeCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail() {
		return errFakeOutage
	}
	k := &fakeKey{value: &value}
	if ttl > 0 {
		at := c.now() + ttl.Milliseconds()
		k.expiresAt = &at
	}
	c.keys[kv.Prefix+key] = k
	return nil
}

func (c *fakeCache) HSet(ctx context.Context, key string, fields map[string]string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail() {
		return errFakeOutage
	}
	full := kv.Prefix + key
	k := c.live(full)
	if k == nil || k.hash == nil {
		nk := &fakeKey{hash: map[string]string{}}
		if k != nil {
			nk.expiresAt = k.expiresAt
		}
		k = nk
		c.keys[full] = k
	}
	for f, v := range fields {
		k.hash[f] = v
	}
	return nil
}

func (c *fakeCache) HDel(ctx context.Context, key string, fields ...string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail() {
		return errFakeOutage
	}
	full := kv.Prefix + key
	k := c.live(full)
	if k == nil || k.hash == nil {
		return nil
	}
	for _, f := range fields {
		delete(k.hash, f)
	}
	if len(k.hash) == 0 {
		delete(c.keys, full)
	}
	return nil
}

func (c *fakeCache) Expire(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail() {
		return false, errFakeOutage
	}
	k := c.live(kv.Prefix + key)
	if k == nil {
		return false, nil
	}
	at := c.now() + ttl.Milliseconds()
	k.expiresAt = &at
	return true, nil
}

// seed writes a key directly, as the golden's redisSeed did.
func (c *fakeCache) seed(key string, fields [][2]string, value *string, ttlSec int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := &fakeKey{}
	if ttlSec > 0 {
		at := c.now() + ttlSec*1000
		k.expiresAt = &at
	}
	if fields != nil {
		k.hash = map[string]string{}
		for _, f := range fields {
			k.hash[f[0]] = f[1]
		}
	} else {
		k.value = value
	}
	c.keys[kv.Prefix+key] = k
}

// dump is FakeRedis.dump(): live keys sorted, each with its remaining TTL and its fields
// sorted numerically (or its value).
func (c *fakeCache) dump() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	names := make([]string, 0, len(c.keys))
	for k := range c.keys {
		names = append(names, k)
	}
	jsSortStrings(names)
	out := []any{}
	for _, name := range names {
		k := c.live(name)
		if k == nil {
			continue
		}
		var ttl any
		if k.expiresAt != nil {
			ttl = *k.expiresAt - c.now()
		}
		if k.hash != nil {
			fields := make([]string, 0, len(k.hash))
			for f := range k.hash {
				fields = append(fields, f)
			}
			sort.SliceStable(fields, func(i, j int) bool {
				x, y := jsNumberString(fields[i]), jsNumberString(fields[j])
				nx, ny := math.IsNaN(x), math.IsNaN(y)
				if nx || ny {
					if nx != ny {
						return ny
					}
					return cmpUTF16(fields[i], fields[j]) < 0
				}
				return x < y
			})
			pairs := make([]any, len(fields))
			for i, f := range fields {
				pairs[i] = []any{f, k.hash[f]}
			}
			out = append(out, []any{name, orderedJSON{"ttlMs", ttl, "fields", pairs}})
		} else {
			out = append(out, []any{name, orderedJSON{"ttlMs", ttl, "value", *k.value}})
		}
	}
	return out
}

// orderedJSON is an object literal: alternating keys and values, written in order.
type orderedJSON []any

func (o orderedJSON) AppendJS(dst []byte) []byte {
	dst = append(dst, '{')
	for i := 0; i+1 < len(o); i += 2 {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = jsjson.AppendString(dst, o[i].(string))
		dst = append(dst, ':')
		dst = jsjson.Append(dst, o[i+1])
	}
	return append(dst, '}')
}

// fakeTimer is a scheduled callback the test fires by hand.
type fakeTimer struct {
	d       time.Duration
	f       func()
	stopped bool
	fired   bool
}

func (t *fakeTimer) Stop() bool {
	was := !t.stopped && !t.fired
	t.stopped = true
	return was
}

type fakeTimers struct {
	mu   sync.Mutex
	list []*fakeTimer
}

func (ft *fakeTimers) afterFunc(d time.Duration, f func()) Timer {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	t := &fakeTimer{d: d, f: f}
	ft.list = append(ft.list, t)
	return t
}

// pending is the durations (ms) of the timers that have neither fired nor been stopped.
func (ft *fakeTimers) pending() []int64 {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	out := []int64{}
	for _, t := range ft.list {
		if !t.stopped && !t.fired {
			out = append(out, t.d.Milliseconds())
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
