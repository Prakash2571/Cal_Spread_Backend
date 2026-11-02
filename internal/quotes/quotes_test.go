package quotes

import (
	"math"
	"reflect"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Ported from tests/box/{math,serialize,depthReadiness}.test.mjs (the kept cases).

func lv(p, q float64) market.DepthLevel { return market.DepthLevel{Price: p, Qty: q, Orders: 1} }
func b(v bool) *bool                    { return &v }

func tick(over func(*market.Tick)) market.Tick {
	t := market.Tick{Token: 101, LastPrice: 100, ClosePrice: 99, Bid: 99.9, Ask: 100.1}
	if over != nil {
		over(&t)
	}
	return t
}

func chain(first, step float64, count int) []float64 {
	out := make([]float64, count)
	for i := range out {
		out[i] = first + float64(i)*step
	}
	return out
}

func TestStrikeWindow(t *testing.T) {
	atm, w, ok := SelectStrikeWindow(chain(19700, 100, 11), 20120, 3)
	if !ok || atm != 20100 || !reflect.DeepEqual(w, []float64{19800, 19900, 20000, 20100, 20200, 20300, 20400}) {
		t.Fatalf("atm=%v window=%v", atm, w)
	}
	for _, n := range []int{7, 11, 41, 200} {
		c := chain(20000, 50, n)
		if _, w, _ := SelectStrikeWindow(c, c[n/2], 3); len(w) != 7 {
			t.Errorf("count %d gave %d strikes", n, len(w))
		}
	}
	c := chain(20000, 50, 5)
	if _, w, _ := SelectStrikeWindow(c, c[0], 3); len(w) > 7 || w[0] != c[0] {
		t.Errorf("edge window = %v", w)
	}
	if _, _, ok := SelectStrikeWindow(nil, 1, 3); ok {
		t.Error("empty chain")
	}
}

func TestAtmStepAndRecentre(t *testing.T) {
	if a, _ := AtmStrike([]float64{100, 200, 300}, 260); a != 300 {
		t.Error(a)
	}
	if a, _ := AtmStrike([]float64{100, 200, 300}, 240); a != 200 {
		t.Error(a)
	}
	if a, _ := AtmStrike([]float64{300, 100, 200}, 150); a != 100 {
		t.Errorf("tie goes to the lower strike, got %v", a)
	}
	if _, ok := AtmStrike(nil, 1); ok {
		t.Error("empty")
	}
	if StrikeStep([]float64{19700, 19800, 19900, 20000}) != 100 || StrikeStep([]float64{100}) != 0 {
		t.Error("step")
	}
	if StrikeStep([]float64{100, 150, 250, 300, 300}) != 50 { // gaps 50,100,50 → sorted 50,50,100 → index 1
		t.Error("median gap")
	}
	if ShouldRecentreWindow(20000, 20060, 100, 0.15) || !ShouldRecentreWindow(20000, 20070, 100, 0.15) ||
		!ShouldRecentreWindow(20000, 19930, 100, 0.15) || ShouldRecentreWindow(20000, 20500, 0, 0.15) {
		t.Error("hysteresis")
	}
}

func TestReceiveTimeAndFreshness(t *testing.T) {
	s := NewStore()
	changed := s.ApplyTicks([]market.Tick{{Token: 42, LastPrice: 101, Bid: 100, Ask: 102,
		Bids: []market.DepthLevel{lv(100, 75)}, Asks: []market.DepthLevel{lv(102, 75)}}}, 5000)
	q, _ := s.Get(42)
	if !reflect.DeepEqual(changed, []int64{42}) || q.At != 5000 || q.Bid != 100 || q.AskQty != 75 || q.Source != "ws" || q.Version <= 0 {
		t.Fatalf("%v %+v", changed, q)
	}
	if !s.IsFresh(42, 1500, 6000) || s.IsFresh(42, 1500, 6600) || s.IsFresh(43, 1500, 5000) {
		t.Error("freshness")
	}
	// A depthless tick does not refresh the book.
	if got := s.ApplyTicks([]market.Tick{{Token: 42, LastPrice: 10.5}}, 9000); len(got) != 0 {
		t.Error("depthless tick changed something")
	}
	if q2, _ := s.Get(42); q2 != q {
		t.Error("book must be the same object")
	}
	s.Forget([]int64{42})
	if _, ok := s.Get(42); ok {
		t.Error("forget")
	}
}

func TestLtpOnlyAndRetainedLadders(t *testing.T) {
	s := NewStore()
	n := 0
	s.Subscribe(func([]int64, int64) { n++ })
	if got := s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) { t.DepthUpdated = b(false) })}, 1000); len(got) != 0 || s.UpdateCount() != 0 || n != 0 {
		t.Fatal("LTP-only tick must be ignored")
	}
	if s.Diagnostics().DepthlessIgnored != 1 {
		t.Error("counter")
	}
	full := tick(func(t *market.Tick) {
		t.DepthUpdated = b(true)
		t.Bids, t.Asks = []market.DepthLevel{lv(99.9, 25)}, []market.DepthLevel{lv(100.1, 30)}
	})
	s.ApplyTicks([]market.Tick{full}, 1000)
	before, _ := s.Get(101)
	partial := full
	partial.DepthUpdated, partial.LastPrice = b(false), 101 // retained ladders, not authoritative
	s.ApplyTicks([]market.Tick{partial}, 2000)
	after, _ := s.Get(101)
	if after != before || after.At != 1000 {
		t.Error("partial packet must not refresh the book")
	}
}

func TestEmptyAuthoritativeBookInvalidatesAndNotifies(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{lv(99.9, 25)}, []market.DepthLevel{}
	})}, 1000)
	type seen struct {
		tokens []int64
		at     int64
	}
	var got []seen
	s.Subscribe(func(tk []int64, at int64) { got = append(got, seen{tk, at}) })
	ch := s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{}, []market.DepthLevel{}
	})}, 2000)
	if _, ok := s.Get(101); ok || !reflect.DeepEqual(ch, []int64{101}) || len(got) != 1 || got[0].at != 2000 {
		t.Fatalf("changed=%v seen=%v", ch, got)
	}
	if s.Diagnostics().EmptyInvalidations != 1 {
		t.Error("counter")
	}
}

func TestLegacyLaddersAndMalformedLevels(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.Bids = []market.DepthLevel{lv(math.Inf(1), 10), lv(99.8, math.NaN()), lv(99.7, 1.5), lv(99.9, 20)}
		t.Asks = []market.DepthLevel{lv(math.NaN(), 10), lv(100.1, 30), lv(100.2, 0), lv(100.3, -1)}
	})}, 1000)
	q, _ := s.Get(101)
	if !reflect.DeepEqual(q.Bids, []market.DepthLevel{lv(99.9, 20)}) || !reflect.DeepEqual(q.Asks, []market.DepthLevel{lv(100.1, 30)}) {
		t.Fatalf("%+v", q)
	}
	if s.Diagnostics().MalformedLevelsDropped != 6 {
		t.Error("malformed count")
	}
	// Sorting best first and capping at five.
	s.ApplyTicks([]market.Tick{{Token: 5, Bids: []market.DepthLevel{lv(1, 1), lv(3, 1), lv(2, 1), lv(6, 1), lv(5, 1), lv(4, 1)}}}, 1)
	q, _ = s.Get(5)
	if len(q.Bids) != 5 || q.Bids[0].Price != 6 || q.Bids[4].Price != 2 || q.Ask != 0 {
		t.Fatalf("%+v", q.Bids)
	}
}

func TestGenerationInvalidation(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{lv(99.9, 75)}, []market.DepthLevel{lv(100.1, 75)}
	})}, 1000)
	s.InvalidateGeneration()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) { t.DepthUpdated = b(false) })}, 2000)
	want := Diagnostics{AuthoritativeObservations: 1, UsableBookUpdates: 1, DepthlessIgnored: 1, GenerationInvalidations: 1}
	if s.Size() != 0 || s.LastUpdateAt() != nil || s.Diagnostics() != want {
		t.Fatalf("%+v", s.Diagnostics())
	}
}

func TestListenerUnsubscribeAndPanicIsolation(t *testing.T) {
	s := NewStore()
	calls := 0
	s.Subscribe(func([]int64, int64) { panic("bad listener") })
	unsub := s.Subscribe(func([]int64, int64) { calls++ })
	tk := market.Tick{Token: 1, Bids: []market.DepthLevel{lv(1, 1)}}
	s.ApplyTicks([]market.Tick{tk}, 1)
	unsub()
	s.ApplyTicks([]market.Tick{tk}, 2)
	if calls != 1 || s.ListenerCount() != 1 {
		t.Fatalf("calls=%d listeners=%d", calls, s.ListenerCount())
	}
}

func TestSpotStore(t *testing.T) {
	s := NewSpotStore()
	s.Set(1, 20050, 1000)
	if v, _ := s.Get(1); v != (Spot{20050, 1000}) || !s.IsFresh(1, 10000, 5000) || s.IsFresh(1, 10000, 20000) {
		t.Fatal("spot")
	}
	s.Set(1, 0, 2000)
	if v, _ := s.Get(1); v.Value != 20050 {
		t.Error("zero print must be ignored")
	}
}
