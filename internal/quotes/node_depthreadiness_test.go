package quotes

// Ports of the kept tests/box/depthReadiness.test.mjs cases whose Node assertions the
// earlier quote-store tests did not all make (the tick/lv/b helpers of quotes_test.go
// mirror the suite's tick() and level()). Case 3 (Dhan toTick into the store) needs the
// Dhan package and lives in internal/brokers/dhan/node_depthreadiness_test.go.

import (
	"reflect"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// "first LTP-only option tick does not create or notify an executable book"
func TestNodeFirstLtpOnlyTickCreatesNoBook(t *testing.T) {
	s := NewStore()
	notifications := 0
	s.Subscribe(func([]int64, int64) { notifications++ })
	if got := s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) { t.DepthUpdated = b(false) })}, 1000); len(got) != 0 {
		t.Errorf("applyTicks = %v, want []", got)
	}
	if q, ok := s.Get(101); ok {
		t.Errorf("get(101) = %+v, want undefined", q)
	}
	if s.UpdateCount() != 0 || notifications != 0 || s.Diagnostics().DepthlessIgnored != 1 {
		t.Errorf("updateCount %d notifications %d depthless_ignored %d", s.UpdateCount(), notifications, s.Diagnostics().DepthlessIgnored)
	}
}

// "LTP-only packet after a book cannot refresh its time, version, or listeners": the
// LTP-only packet carries no ladders here (TestLtpOnlyAndRetainedLadders used a
// partial packet with retained ladders, Node's next case).
func TestNodeLtpOnlyPacketAfterABookChangesNothing(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{lv(99.9, 25)}, []market.DepthLevel{lv(100.1, 30)}
	})}, 1000)
	before, ok := s.Get(101)
	if !ok {
		t.Fatal("no book after an authoritative tick")
	}
	version := before.Version
	notifications := 0
	s.Subscribe(func([]int64, int64) { notifications++ })
	if got := s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) { t.LastPrice, t.DepthUpdated = 101, b(false) })}, 2000); len(got) != 0 {
		t.Errorf("applyTicks = %v, want []", got)
	}
	after, _ := s.Get(101)
	if after != before || after.At != 1000 || after.Version != version || notifications != 0 {
		t.Errorf("book %+v (same=%v) notifications %d", after, after == before, notifications)
	}
}

// "authoritative empty depth invalidates the old book and notifies dependents"
func TestNodeEmptyAuthoritativeDepthNotifiesTheToken(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{lv(99.9, 25)}, []market.DepthLevel{}
	})}, 1000)
	type seen struct {
		Tokens []int64
		At     int64
	}
	var got []seen
	s.Subscribe(func(tk []int64, at int64) { got = append(got, seen{append([]int64(nil), tk...), at}) })
	changed := s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{}, []market.DepthLevel{}
	})}, 2000)
	if !reflect.DeepEqual(changed, []int64{101}) {
		t.Errorf("applyTicks = %v, want [101]", changed)
	}
	if _, ok := s.Get(101); ok {
		t.Error("the book must be gone")
	}
	if !reflect.DeepEqual(got, []seen{{Tokens: []int64{101}, At: 2000}}) {
		t.Errorf("listener saw %+v, want [{tokens:[101], at:2000}]", got)
	}
	if s.Diagnostics().EmptyInvalidations != 1 {
		t.Errorf("empty_invalidations = %d", s.Diagnostics().EmptyInvalidations)
	}
}

// "one-sided books support only the relevant reducing side": the kept quote-store half
// (touchPrice/walkDepth are Box order pricing and were dropped). A bid-only
// authoritative book is stored with its bid ladder and no asks.
func TestNodeOneSidedBookIsStored(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{tick(func(t *market.Tick) {
		t.DepthUpdated, t.Bids, t.Asks = b(true), []market.DepthLevel{lv(99.9, 75)}, []market.DepthLevel{}
	})}, 1000)
	q, ok := s.Get(101)
	if !ok {
		t.Fatal("a bid-only authoritative book must be stored")
	}
	if !reflect.DeepEqual(q.Bids, []market.DepthLevel{lv(99.9, 75)}) || len(q.Asks) != 0 {
		t.Fatalf("bids %+v asks %+v, want [99.9 x 75] and []", q.Bids, q.Asks)
	}
}
