package dhan

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestFullPacketDayAverageReachesInternalTick(t *testing.T) {
	frame := make([]byte, fullBytes)
	frame[0], frame[3] = FeedCodeFull, byte(CodeBySegment[SegmentNSEFNO])
	binary.LittleEndian.PutUint16(frame[1:], fullBytes)
	binary.LittleEndian.PutUint32(frame[4:], 30000)
	binary.LittleEndian.PutUint32(frame[8:], math.Float32bits(106))
	binary.LittleEndian.PutUint32(frame[18:], math.Float32bits(52.5))
	binary.LittleEndian.PutUint32(frame[22:], 10000)
	decoded := DecodeFeed(frame)
	if len(decoded.Errors) != 0 || len(decoded.Packets) != 1 {
		t.Fatalf("FULL packet failed: %+v", decoded)
	}
	feed := &Feed{state: map[int64]*FeedState{}}
	state := feed.mergeLocked(2_000_030_000, &decoded.Packets[0], 1000)
	tick := ToTick(*state, true)
	if tick.AveragePrice == nil || *tick.AveragePrice != 52.5 || tick.Volume == nil || *tick.Volume != 10000 {
		t.Fatal("broker day-volume-weighted average was lost before the strategy")
	}
	oi := int64(500)
	state = feed.mergeLocked(2_000_030_000, &Packet{Code: FeedCodeOI, OI: &oi}, 2000)
	partial := ToTick(*state, false)
	if state.AveragePrice != 52.5 || partial.Volume == nil || *partial.Volume != 10000 {
		t.Fatal("OI-only packet erased the cached day average or volume")
	}
	encoded, err := json.Marshal(tick)
	if err != nil || strings.Contains(string(encoded), "AveragePrice") || strings.Contains(string(encoded), "average_price") ||
		strings.Contains(string(encoded), "Volume") || strings.Contains(string(encoded), "volume") {
		t.Fatal("internal strategy metadata altered legacy browser tick JSON")
	}
}

func TestVolumeProvenanceComesFromEachPacket(t *testing.T) {
	const token = int64(2_000_030_000)
	var ticks []market.Tick
	feed := NewFeed(FeedOptions{
		Resolve: func(int64) (FeedInstrument, bool) {
			return FeedInstrument{Segment: SegmentNSEFNO, SecurityID: 30000}, true
		},
		OnTicks: func(batch []market.Tick) { ticks = append(ticks, batch...) },
	})
	feed.wanted[token] = 1
	for i, tc := range []struct {
		name    string
		code    byte
		size    int
		volume  uint32
		updated bool
		want    float64
	}{
		{"ticker before volume", FeedCodeTicker, tickerBytes, 0, false, 0},
		{"quote carries volume", FeedCodeQuote, quoteBytes, 10000, true, 10000},
		{"ticker keeps volume", FeedCodeTicker, tickerBytes, 0, false, 10000},
		{"OI keeps volume", FeedCodeOI, oiBytes, 0, false, 10000},
		{"full carries volume", FeedCodeFull, fullBytes, 10100, true, 10100},
		{"quote carries zero", FeedCodeQuote, quoteBytes, 0, true, 0},
		{"ticker keeps zero", FeedCodeTicker, tickerBytes, 0, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frame := make([]byte, tc.size)
			frame[0], frame[3] = tc.code, byte(CodeBySegment[SegmentNSEFNO])
			binary.LittleEndian.PutUint16(frame[1:], uint16(tc.size))
			binary.LittleEndian.PutUint32(frame[4:], 30000)
			if tc.updated {
				binary.LittleEndian.PutUint32(frame[22:], tc.volume)
			}
			feed.mu.Lock()
			feed.handleFrameLocked(frame, int64(i+1)*1000)
			feed.mu.Unlock()
			feed.drain()
			if len(ticks) != i+1 {
				t.Fatalf("expected one tick per packet, got %d", len(ticks))
			}
			tick := ticks[i]
			if tick.VolumeUpdated == nil || *tick.VolumeUpdated != tc.updated || tick.Volume == nil || *tick.Volume != tc.want {
				t.Fatalf("wrong volume or packet provenance: %+v", tick)
			}
			if feed.state[token].Volume != tc.want {
				t.Fatalf("partial packet changed cached volume: %+v", feed.state[token])
			}
		})
	}
	if *ticks[1].Volume != 10000 || *ticks[4].Volume != 10100 {
		t.Fatal("later packets mutated previously delivered tick volumes")
	}
}
