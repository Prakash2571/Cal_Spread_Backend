package boundedcache

// Ports of the tests/box/boundedCache.test.mjs cases whose exact inputs or assertions no
// Go test had (ttl 4000 ms, cap 3, the `at` helper of boundedcache_test.go).

import (
	"testing"
	"time"
)

// "an expired entry is DELETED, not merely skipped"
func TestNodeExpiredEntryIsDeletedNotSkipped(t *testing.T) {
	c, advance := at(3)
	c.Set("k", 1)
	if c.Len() != 1 {
		t.Fatalf("size %d after one set", c.Len())
	}
	advance(4001 * time.Millisecond)
	if _, ok := c.Get("k"); ok {
		t.Fatal("an expired entry must not be served")
	}
	if c.Len() != 0 {
		t.Fatalf("and must no longer occupy memory: size %d", c.Len())
	}
}

// "eviction is oldest-first": with no re-set, the fourth key evicts the first.
func TestNodeEvictionIsOldestFirst(t *testing.T) {
	c, _ := at(3)
	c.Set("a", 1)
	c.Set("b", 2)
	c.Set("c", 3)
	c.Set("d", 4) // evicts "a"
	if _, ok := c.Get("a"); ok {
		t.Error(`"a" was the oldest and must be evicted`)
	}
	if v, ok := c.Get("b"); !ok || v != 2 {
		t.Errorf(`get("b") = %v,%v, want 2`, v, ok)
	}
	if v, ok := c.Get("d"); !ok || v != 4 {
		t.Errorf(`get("d") = %v,%v, want 4`, v, ok)
	}
}

// "expired entries are swept before anything live is evicted"
func TestNodeExpiredSweptBeforeLiveEvictedServesTheFreshValue(t *testing.T) {
	c, advance := at(3)
	c.Set("old1", 1)
	c.Set("old2", 2)
	advance(4001 * time.Millisecond)
	c.Set("fresh", 3)
	if c.Len() != 1 {
		t.Fatalf("size %d, want 1", c.Len())
	}
	if v, ok := c.Get("fresh"); !ok || v != 3 {
		t.Fatalf(`get("fresh") = %v,%v, want 3`, v, ok)
	}
}
