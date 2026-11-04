package spike

import (
	"testing"
	"time"
)

func TestCrossoverRequiresFivePercentAtThatUpdate(t *testing.T) {
	now := time.Date(2026, 11, 4, 10, 20, 0, 0, ist).UnixMilli()
	for _, tc := range []struct {
		name      string
		previous  Sample
		current   Sample
		history   []Sample
		direction string
	}{
		{"up after one minute", Sample{T: now - 1000, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{{T: now - 60_000, Premium: 100}}, "CALL_CREDIT"},
		{"exact five percent 29m", Sample{T: now - 1000, Premium: 104, VWAP: 104.5}, Sample{T: now, Premium: 105, VWAP: 104.5}, []Sample{{T: now - 29*60_000, Premium: 100}}, "CALL_CREDIT"},
		{"down at five percent", Sample{T: now - 1000, Premium: 99, VWAP: 96}, Sample{T: now, Premium: 95, VWAP: 96}, []Sample{{T: now - 20*60_000, Premium: 100}}, "PUT_CREDIT"},
		{"any earlier price", Sample{T: now - 1000, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{{T: now - 29*60_000, Premium: 100}, {T: now - 60_000, Premium: 103}}, "CALL_CREDIT"},
		{"30m inclusive", Sample{T: now - 1000, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{{T: now - WindowMs, Premium: 100}}, "CALL_CREDIT"},
		{"reference expired", Sample{T: now - 1000, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{{T: now - WindowMs - 1, Premium: 100}}, ""},
		{"insufficient move", Sample{T: now - 1000, Premium: 103, VWAP: 104}, Sample{T: now, Premium: 104.5, VWAP: 104}, []Sample{{T: now - 60_000, Premium: 100}}, ""},
		{"late post-cross confirmation", Sample{T: now - 1000, Premium: 104, VWAP: 103}, Sample{T: now, Premium: 106, VWAP: 103}, []Sample{{T: now - 60_000, Premium: 100}}, ""},
		{"VWAP alone crossed", Sample{T: now - 1000, Premium: 106, VWAP: 107}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{{T: now - 60_000, Premium: 100}}, ""},
		{"freshness gap", Sample{T: now - quoteAgeMs - 1, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{{T: now - 60_000, Premium: 100}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			signal, qualified := Qualify(tc.previous, tc.current, tc.history)
			if qualified != (tc.direction != "") || (qualified && signal.Direction != tc.direction) {
				t.Fatalf("qualification %v %+v; want %q", qualified, signal, tc.direction)
			}
		})
	}
}

func TestRollingExtremaKeepTheEntireThirtyMinuteWindow(t *testing.T) {
	w := &priceWindow{}
	var history []Sample
	for second := int64(0); second < 4000; second++ {
		sample := Sample{T: 1000 + second*1000, Premium: 100 + float64((second*37)%211)}
		w.Add(sample)
		history = append(history, sample)
		for len(history) > 0 && sample.T-history[0].T > WindowMs {
			history = history[1:]
		}
		minimum, maximum := history[0].Premium, history[0].Premium
		for _, point := range history {
			if point.Premium < minimum {
				minimum = point.Premium
			}
			if point.Premium > maximum {
				maximum = point.Premium
			}
		}
		refs := w.References(sample.T)
		if len(refs) != 2 || refs[0].Premium != minimum || refs[1].Premium != maximum {
			t.Fatalf("rolling extrema differ at second %d: %+v, expected %v/%v", second, refs, minimum, maximum)
		}
	}
}
