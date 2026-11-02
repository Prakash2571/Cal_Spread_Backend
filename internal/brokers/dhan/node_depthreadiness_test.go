package dhan

// Port of tests/box/depthReadiness.test.mjs "Dhan retained ladders on a partial packet
// do not refresh executable storage": toTick(state, true|false) into the quote store.
// TestToTickGolden cannot tell a nil depth_updated from false (both print false) and
// quotes.TestLtpOnlyAndRetainedLadders builds its ticks by hand.

import (
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/quotes"
)

func TestNodeRetainedLaddersOnAPartialPacketDoNotRefreshTheStore(t *testing.T) {
	state := FeedState{Token: 101, LastPrice: 100, ClosePrice: 99, OI: 50,
		Bids: []market.DepthLevel{{Price: 99.9, Qty: 25, Orders: 1}}, Asks: []market.DepthLevel{{Price: 100.1, Qty: 30, Orders: 1}}}
	full := ToTick(state, true)
	partialState := state
	partialState.LastPrice = 101
	partial := ToTick(partialState, false)
	if full.DepthUpdated == nil || !*full.DepthUpdated {
		t.Fatalf("full.depth_updated = %v, want true", full.DepthUpdated)
	}
	if partial.DepthUpdated == nil || *partial.DepthUpdated {
		t.Fatalf("partial.depth_updated = %v, want false", partial.DepthUpdated)
	}
	store := quotes.NewStore()
	store.ApplyTicks([]market.Tick{full}, 1000)
	q, ok := store.Get(101)
	if !ok {
		t.Fatal("no book after the full tick")
	}
	version := q.Version
	store.ApplyTicks([]market.Tick{partial}, 2000)
	q, _ = store.Get(101)
	if q.Version != version || q.At != 1000 {
		t.Fatalf("version %d->%d at %d, want unchanged and 1000", version, q.Version, q.At)
	}
}
