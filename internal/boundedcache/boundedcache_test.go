package boundedcache

import (
	"fmt"
	"testing"
	"time"
)

// Ported from tests/box/boundedCache.test.mjs.
func at(maxEntries int) (*Cache[int], func(time.Duration)) {
	now := time.UnixMilli(1_000_000)
	c := New[int](4000*time.Millisecond, maxEntries, func() time.Time { return now })
	return c, func(d time.Duration) { now = now.Add(d) }
}

func TestFreshValueAndExpiryDeletes(t *testing.T) {
	c, advance := at(3)
	c.Set("k", 7)
	if v, ok := c.Get("k"); !ok || v != 7 {
		t.Fatal("fresh value")
	}
	advance(4000 * time.Millisecond) // age == ttl is expired
	if _, ok := c.Get("k"); ok || c.Len() != 0 {
		t.Fatalf("expired entry must be deleted, len=%d", c.Len())
	}
}

func TestCapAndOldestFirstEviction(t *testing.T) {
	c, _ := at(3)
	for i := 0; i < 5000; i++ {
		c.Set(fmt.Sprintf("tokens-%d", i), i)
	}
	if c.Len() > 3 {
		t.Fatalf("len %d exceeds cap", c.Len())
	}
	c, _ = at(3)
	c.Set("a", 1)
	c.Set("b", 2)
	c.Set("c", 3)
	c.Set("a", 99) // a becomes newest
	c.Set("d", 4)  // evicts b
	if v, ok := c.Get("a"); !ok || v != 99 {
		t.Error("re-set key keeps its value")
	}
	if _, ok := c.Get("b"); ok {
		t.Error("b was the oldest and must be evicted")
	}
	if _, ok := c.Get("d"); !ok {
		t.Error("d present")
	}
}

func TestExpiredSweptBeforeLiveEvicted(t *testing.T) {
	c, advance := at(3)
	c.Set("old1", 1)
	c.Set("old2", 2)
	advance(4001 * time.Millisecond)
	c.Set("fresh", 3)
	if c.Len() != 1 {
		t.Fatalf("len = %d", c.Len())
	}
}

func TestMissClearAndMinimumCap(t *testing.T) {
	c, _ := at(3)
	if _, ok := c.Get("nope"); ok || c.Len() != 0 {
		t.Fatal("miss must not create an entry")
	}
	c.Set("a", 1)
	c.Clear()
	if c.Len() != 0 {
		t.Fatal("clear")
	}
	c, _ = at(0)
	c.Set("a", 1)
	c.Set("b", 2)
	if v, ok := c.Get("b"); c.Len() != 1 || !ok || v != 2 {
		t.Fatal("cap below one is coerced to one")
	}
	if !c.Delete("b") || c.Delete("b") {
		t.Fatal("delete")
	}
}
