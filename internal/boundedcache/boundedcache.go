// Package boundedcache is boundedCache.ts: an in-process TTL cache with a size cap.
// Eviction is FIFO by last Set (Get does not refresh recency); an entry whose age is
// exactly the TTL is already expired. It stays in process on purpose: it bounds memory
// per request permutation and is not a shared cache.
package boundedcache

import (
	"container/list"
	"sync"
	"time"
)

type entry[V any] struct {
	key   string
	at    time.Time
	value V
}

// Cache is safe for concurrent use.
type Cache[V any] struct {
	mu    sync.Mutex
	ttl   time.Duration
	max   int
	now   func() time.Time
	order *list.List // oldest first
	items map[string]*list.Element
}

// New returns a cache. maxEntries below 1 is treated as 1; now may be nil.
func New[V any](ttl time.Duration, maxEntries int, now func() time.Time) *Cache[V] {
	if maxEntries < 1 {
		maxEntries = 1
	}
	if now == nil {
		now = time.Now
	}
	return &Cache[V]{ttl: ttl, max: maxEntries, now: now, order: list.New(), items: map[string]*list.Element{}}
}

// Get returns the value for key. An expired entry is deleted and reported missing.
func (c *Cache[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var zero V
	el, ok := c.items[key]
	if !ok {
		return zero, false
	}
	e := el.Value.(*entry[V])
	if c.now().Sub(e.at) >= c.ttl {
		c.order.Remove(el)
		delete(c.items, key)
		return zero, false
	}
	return e.value, true
}

// Set stores value, moving key to the newest position, then sweeps expired entries and
// evicts the oldest ones beyond the cap.
func (c *Cache[V]) Set(key string, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.order.Remove(el)
	}
	c.items[key] = c.order.PushBack(&entry[V]{key: key, at: c.now(), value: value})
	cutoff := c.now().Add(-c.ttl)
	for el := c.order.Front(); el != nil; {
		next := el.Next()
		if e := el.Value.(*entry[V]); !e.at.After(cutoff) {
			c.order.Remove(el)
			delete(c.items, e.key)
		}
		el = next
	}
	for c.order.Len() > c.max {
		oldest := c.order.Front()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*entry[V]).key)
	}
}

// Delete removes key and reports whether it was present.
func (c *Cache[V]) Delete(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if ok {
		c.order.Remove(el)
		delete(c.items, key)
	}
	return ok
}

// Len counts stored entries, including expired ones not yet swept (like Map.size).
func (c *Cache[V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}

// Clear removes everything.
func (c *Cache[V]) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.order.Init()
	c.items = map[string]*list.Element{}
}
