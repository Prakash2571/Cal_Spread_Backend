package registry

// Port of tests/box/dhanSupport.test.mjs "a candle with a bad timestamp is dropped
// rather than dated to 1970": the candles golden has no NaN timestamp (JSON cannot carry
// one), so the !Number.isFinite half of the drop check was never run.

import (
	"math"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

func TestNodeCandleWithABadTimestampIsDropped(t *testing.T) {
	rows := DhanCandlesToRows(dhan.Candles{
		Close:     []dhan.Value{dhan.NumberValue(1), dhan.NumberValue(2)},
		Timestamp: []dhan.Value{dhan.NumberValue(math.NaN()), dhan.NumberValue(1_760_000_000)},
	})
	if len(rows) != 1 {
		t.Fatalf("%d rows, want 1", len(rows))
	}
	// The surviving row as the original TypeScript returns it for this input
	// (scratch/go-migration/tmp/port/record_values.mjs).
	const node = `[{"date":"2025-10-09 14:23:20","open":0,"high":0,"low":0,"close":2,"volume":0,"oi":0}]`
	if got := string(jsjson.Marshal(rows)); got != node {
		t.Fatalf("rows\n got %s\nwant %s", got, node)
	}
	// ±Infinity takes the same branch.
	for _, bad := range []float64{math.Inf(1), math.Inf(-1)} {
		if n := len(DhanCandlesToRows(dhan.Candles{Timestamp: []dhan.Value{dhan.NumberValue(bad)}})); n != 0 {
			t.Errorf("timestamp %v kept (%d rows)", bad, n)
		}
	}
}
