package boundedcache

import (
	"reflect"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// tests/box/boundedCache.test.mjs: "a fresh value is returned". The original
// assertion compares a quote array; the inherited tests only stored integers.
func TestNodeFreshQuoteArrayIsReturned(t *testing.T) {
	c := New[[]market.Tick](4000*time.Millisecond, 3, func() time.Time { return time.UnixMilli(1_000_000) })
	value := []market.Tick{{Token: 1, LastPrice: 10}}
	c.Set("k", value)
	if got, ok := c.Get("k"); !ok || !reflect.DeepEqual(got, value) {
		t.Fatalf("fresh quotes = %+v, %v; want [{token:1,last_price:10}]", got, ok)
	}
}
