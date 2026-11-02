package quotes

// Ports of the kept tests/box/serialize.test.mjs quote-store cases with Node's inputs.

import (
	"reflect"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// "a depthless tick must not refresh a good book's timestamp"
func TestNodeDepthlessTickDoesNotRefreshTheTimestamp(t *testing.T) {
	s := NewStore()
	s.ApplyTicks([]market.Tick{{Token: 7, LastPrice: 10, Bid: 9, Ask: 11,
		Bids: []market.DepthLevel{{Price: 9, Qty: 75, Orders: 1}}, Asks: []market.DepthLevel{{Price: 11, Qty: 75, Orders: 1}}}}, 1000)
	changed := s.ApplyTicks([]market.Tick{{Token: 7, LastPrice: 10.5, Bid: 0, Ask: 0}}, 9000)
	if len(changed) != 0 {
		t.Errorf("applyTicks = %v, want []", changed)
	}
	q, ok := s.Get(7)
	if !ok || q.At != 1000 {
		t.Fatalf("book %+v, want at 1000", q)
	}
	if s.IsFresh(7, 1500, 9000) {
		t.Error("the book must keep ageing")
	}
}

// "executable books can only enter the store through WebSocket ticks"
func TestNodeBooksEnterOnlyThroughWebSocketTicks(t *testing.T) {
	s := NewStore()
	// store.applyLadder === undefined: REST ladders are not an execution source.
	if _, ok := reflect.TypeOf(s).MethodByName("ApplyLadder"); ok {
		t.Fatal("the quote store must not accept REST ladders")
	}
	s.ApplyTicks([]market.Tick{{Token: 11, LastPrice: 50, Bid: 49, Ask: 51,
		Bids: []market.DepthLevel{{Price: 49, Qty: 100, Orders: 1}}, Asks: []market.DepthLevel{{Price: 51, Qty: 100, Orders: 1}}}}, 2000)
	q, ok := s.Get(11)
	if !ok || q.Source != "ws" || q.Version <= 0 {
		t.Fatalf("book %+v", q)
	}
	if !s.IsFresh(11, 1500, 3000) {
		t.Error("fresh at 1000 ms age")
	}
	s.Forget([]int64{11})
	if _, ok := s.Get(11); ok {
		t.Error("forget must remove the book")
	}
}
