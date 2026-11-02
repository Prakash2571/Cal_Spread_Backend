package dhan

// Port of tests/box/dhanFeedDecoder.test.mjs "production Dhan frame handling marks FULL
// authoritative and retained partial depth non-authoritative": the real feed's frame
// handling (seeded wanted set, no socket) feeding the real quote store. The frames are
// built with the suite's own little-endian builders.

import (
	"encoding/binary"
	"math"
	"reflect"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/quotes"
)

const nodeSecurity = 45678

// nodePacket is the suite's packet(code, byteLength, segmentCode, securityId, fill).
func nodePacket(code byte, length int, segment byte, security int32, fill func(b []byte)) []byte {
	b := make([]byte, length)
	b[0] = code
	binary.LittleEndian.PutUint16(b[1:], uint16(int16(length)))
	b[3] = segment
	binary.LittleEndian.PutUint32(b[4:], uint32(security))
	if fill != nil {
		fill(b)
	}
	return b
}

func putF32(b []byte, at int, v float32) { binary.LittleEndian.PutUint32(b[at:], math.Float32bits(v)) }
func putI32(b []byte, at int, v int32)   { binary.LittleEndian.PutUint32(b[at:], uint32(v)) }
func putI16(b []byte, at int, v int16)   { binary.LittleEndian.PutUint16(b[at:], uint16(v)) }

// nodeFullPacket is the suite's fullPacket() with its defaults and the given ladders
// ([price, qty, orders] per level).
func nodeFullPacket(bids, asks [][3]float64) []byte {
	const oi = 4321
	return nodePacket(FeedCodeFull, 162, 2, nodeSecurity, func(v []byte) {
		putF32(v, 8, 123.45)
		putI16(v, 12, 25)
		putI32(v, 14, 1_760_000_000)
		putF32(v, 18, 122.0)
		putI32(v, 22, 9999)
		putI32(v, 26, 500)
		putI32(v, 30, 700)
		putI32(v, 34, oi)
		putI32(v, 38, oi+100)
		putI32(v, 42, oi-100)
		putF32(v, 46, 120)
		putF32(v, 50, 119)
		putF32(v, 54, 130)
		putF32(v, 58, 118)
		for i := 0; i < 5; i++ {
			at := 62 + i*20
			var bid, ask [3]float64
			if i < len(bids) {
				bid = bids[i]
			}
			if i < len(asks) {
				ask = asks[i]
			}
			putI32(v, at, int32(bid[1]))
			putI32(v, at+4, int32(ask[1]))
			putI16(v, at+8, int16(bid[2]))
			putI16(v, at+10, int16(ask[2]))
			putF32(v, at+12, float32(bid[0]))
			putF32(v, at+16, float32(ask[0]))
		}
	})
}

func TestNodeFeedFrameHandlingMarksFullAuthoritativeAndPartialNot(t *testing.T) {
	const internalToken = 7_654_321
	var batches [][]market.Tick
	f := NewFeed(FeedOptions{
		AccessToken: func() string { return "" },
		ClientID:    func() string { return "" },
		OnTicks:     func(ts []market.Tick) { batches = append(batches, ts) },
		Resolve: func(token int64) (FeedInstrument, bool) {
			if token == internalToken {
				return FeedInstrument{Segment: Segment("NSE_FNO"), SecurityID: nodeSecurity}, true
			}
			return FeedInstrument{}, false
		},
	})
	f.mu.Lock() // feed.wanted.add(internalToken)
	f.wantSeq++
	f.wanted[internalToken] = f.wantSeq
	f.mu.Unlock()
	handle := func(buf []byte, now int64) {
		f.mu.Lock()
		f.handleFrameLocked(buf, now)
		f.mu.Unlock()
		f.drain()
	}
	handle(nodeFullPacket([][3]float64{{100, 75, 3}}, [][3]float64{{101, 50, 2}}), 1000)
	handle(nodePacket(FeedCodeTicker, 16, 2, nodeSecurity, func(v []byte) {
		putF32(v, 8, 102.5)
		putI32(v, 12, 1_760_000_500)
	}), 2000)

	if len(batches) != 2 {
		t.Fatalf("%d batches, want 2", len(batches))
	}
	full, partial := batches[0][0], batches[1][0]
	if full.DepthUpdated == nil || !*full.DepthUpdated {
		t.Errorf("full.depth_updated = %v, want true", full.DepthUpdated)
	}
	if partial.DepthUpdated == nil || *partial.DepthUpdated {
		t.Errorf("partial.depth_updated = %v, want false (present, not absent)", partial.DepthUpdated)
	}
	if !reflect.DeepEqual(partial.Bids, full.Bids) || !reflect.DeepEqual(partial.Asks, full.Asks) {
		t.Errorf("merged ladders must remain available: full %+v/%+v partial %+v/%+v", full.Bids, full.Asks, partial.Bids, partial.Asks)
	}
	// The ladders themselves (recorded for this frame in feed_merge.json "full then ticker").
	if !reflect.DeepEqual(full.Bids, []market.DepthLevel{{Price: 100, Qty: 75, Orders: 3}}) ||
		!reflect.DeepEqual(full.Asks, []market.DepthLevel{{Price: 101, Qty: 50, Orders: 2}}) {
		t.Errorf("full ladders %+v / %+v", full.Bids, full.Asks)
	}

	store := quotes.NewStore()
	store.ApplyTicks([]market.Tick{full}, 1000)
	accepted, ok := store.Get(internalToken)
	if !ok {
		t.Fatal("the FULL tick must create a book")
	}
	version := accepted.Version
	store.ApplyTicks([]market.Tick{partial}, 2000)
	got, _ := store.Get(internalToken)
	if got.Version != version || got.At != 1000 {
		t.Fatalf("partial refreshed the book: version %d->%d at %d", version, got.Version, got.At)
	}
}
