package registry

import (
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
)

// Literal kept history cases of tests/box/dhanSupport.test.mjs. The earlier
// helper golden used different candle values and October date ranges.
func TestNodeDhanHistoryColumnsAndOrdering(t *testing.T) {
	values := func(ns ...float64) []dhan.Value {
		out := make([]dhan.Value, len(ns))
		for i, n := range ns {
			out[i] = dhan.NumberValue(n)
		}
		return out
	}
	t.Run("Dhan's COLUMN-wise candles transpose into rows", func(t *testing.T) {
		rows := DhanCandlesToRows(dhan.Candles{
			Open: values(100, 101), High: values(105, 106), Low: values(99, 100), Close: values(104, 105),
			Volume: values(1000, 2000), OpenInterest: values(50, 60), Timestamp: values(1_760_000_000, 1_760_000_060),
		})
		if len(rows) != 2 || rows[0].Open != 100 || rows[0].Close != 104 || rows[0].Volume != 1000 || rows[0].OI != 50 {
			t.Fatalf("transposed candles = %+v", rows)
		}
		if rows[0].Date != "2025-10-09 14:23:20" {
			t.Fatalf("Kite-shaped IST date = %q", rows[0].Date)
		}
	})
	t.Run("candles come back oldest-first, matching Kite's ordering", func(t *testing.T) {
		rows := DhanCandlesToRows(dhan.Candles{Close: values(2, 1), Timestamp: values(1_760_000_060, 1_760_000_000)})
		if len(rows) != 2 || !(rows[0].Date < rows[1].Date) {
			t.Fatalf("oldest-first candles = %+v", rows)
		}
	})
	t.Run("missing columns become 0 rather than undefined", func(t *testing.T) {
		rows := DhanCandlesToRows(dhan.Candles{Timestamp: values(1_760_000_000)})
		if len(rows) != 1 || rows[0].Open != 0 || rows[0].OI != 0 {
			t.Fatalf("missing candle columns = %+v", rows)
		}
	})
}

func TestNodeDhanHistoryRangeCoverage(t *testing.T) {
	from := float64(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	t.Run("long ranges chunk, because Dhan bounds intraday request spans", func(t *testing.T) {
		to := float64(time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC).UnixMilli())
		chunks := ChunkDateRange(from, to, 5)
		if len(chunks) < 6 || chunks[0].From != from || chunks[len(chunks)-1].To != to {
			t.Fatalf("complete January range = %+v", chunks)
		}
		for i := 1; i < len(chunks); i++ {
			if chunks[i].From != chunks[i-1].To {
				t.Errorf("gap between chunks %d and %d", i-1, i)
			}
		}
	})
	t.Run("a range within the limit is a single chunk", func(t *testing.T) {
		to := float64(time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC).UnixMilli())
		if got := ChunkDateRange(from, to, 5); len(got) != 1 {
			t.Fatalf("short range = %+v, want one chunk", got)
		}
	})
}
