package dhan

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"strings"
	"testing"
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
	if tick.AveragePrice == nil || *tick.AveragePrice != 52.5 || state.Volume != 10000 {
		t.Fatal("broker day-volume-weighted average was lost before the strategy")
	}
	oi := int64(500)
	state = feed.mergeLocked(2_000_030_000, &Packet{Code: FeedCodeOI, OI: &oi}, 2000)
	if state.AveragePrice != 52.5 {
		t.Fatal("OI-only packet erased the cached day average")
	}
	encoded, err := json.Marshal(tick)
	if err != nil || strings.Contains(string(encoded), "AveragePrice") || strings.Contains(string(encoded), "average_price") {
		t.Fatal("internal strategy metadata altered legacy browser tick JSON")
	}
}
