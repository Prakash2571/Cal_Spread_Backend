package spike

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestArmUsesEarlierThirtyMinuteLow(t *testing.T) {
	now := time.Date(2026, 11, 4, 10, 20, 0, 0, ist).UnixMilli()
	for _, tc := range []struct {
		name    string
		premium float64
		age     int64
		want    bool
	}{
		{"exact five percent", 105, 1000, true},
		{"above five percent", 106, 29 * 60_000, true},
		{"below five percent", 104.99, 1000, false},
		{"thirty minutes inclusive", 105, WindowMs, true},
		{"expired low", 105, WindowMs + 1, false},
		{"same sample is not earlier", 105, 0, false},
		{"invalid premium", math.NaN(), 1000, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := &priceWindow{}
			w.Add(Sample{T: now - tc.age, Premium: 100})
			if tc.age > 1000 {
				w.Add(Sample{T: now - 500, Premium: 103})
			}
			state, trigger := advanceArmed(nil, Sample{}, Sample{T: now, Premium: tc.premium}, w.References(now))
			if (state != nil) != tc.want || trigger != nil {
				t.Fatalf("state=%+v trigger=%+v, want armed=%v", state, trigger, tc.want)
			}
			if state != nil && (state.ArmedAt != now || state.Reference.Premium != 100) {
				t.Fatalf("wrong arm/reference: %+v", state)
			}
		})
	}
}

func TestTriggerOnlyPriceDrivenDownwardCrossOrTouchWhileArmed(t *testing.T) {
	const now = int64(10_000_000)
	for _, tc := range []struct {
		name     string
		armed    bool
		previous Sample
		current  Sample
		want     bool
	}{
		{"downward inclusive previous VWAP", true, Sample{T: now - 1000, Premium: 105, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, true},
		{"downward above previous VWAP", true, Sample{T: now - 1000, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, true},
		{"unarmed down cross", false, Sample{T: now - 1000, Premium: 105, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"upward cross", true, Sample{T: now - 1000, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 106, VWAP: 105}, false},
		{"VWAP driven", true, Sample{T: now - 1000, Premium: 104, VWAP: 103}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"touch then fall", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, true},
		{"touch exactly one rupee below", true, Sample{T: now - 1000, Premium: 104, VWAP: 105}, Sample{T: now, Premium: 103, VWAP: 105}, true},
		{"fall without touch at one rupee and one paisa below", true, Sample{T: now - 1000, Premium: 103.99, VWAP: 105}, Sample{T: now, Premium: 103, VWAP: 105}, false},
		{"touch without fall at equal premium", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104.5, VWAP: 105}, false},
		{"touch without fall at rising premium", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104.75, VWAP: 105}, false},
		{"unarmed touch then fall", false, Sample{T: now - 1000, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"touch current equal VWAP", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 104}, false},
		{"touch sixty seconds inclusive", true, Sample{T: now - quoteAgeMs, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, true},
		{"touch sample gap", true, Sample{T: now - quoteAgeMs - 1, Premium: 104.5, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"current equal VWAP", true, Sample{T: now - 1000, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 105, VWAP: 105}, false},
		{"sixty seconds inclusive", true, Sample{T: now - quoteAgeMs, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, true},
		{"sample gap", true, Sample{T: now - quoteAgeMs - 1, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"time reversed", true, Sample{T: now + 1, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"missing VWAP", true, Sample{T: now - 1, Premium: 106, VWAP: 0}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"nonfinite prior premium", true, Sample{T: now - 1, Premium: math.Inf(1), VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"nonfinite prior VWAP", true, Sample{T: now - 1, Premium: 106, VWAP: math.Inf(1)}, Sample{T: now, Premium: 104, VWAP: 105}, false},
		{"nonfinite current VWAP", true, Sample{T: now - 1, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: math.NaN()}, false},
		{"nonfinite current premium", true, Sample{T: now - 1, Premium: 106, VWAP: 105}, Sample{T: now, Premium: math.NaN(), VWAP: 105}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var state *armedState
			if tc.armed {
				state = &armedState{ArmedAt: now - 2000, Reference: Sample{T: now - 3000, Premium: 100}}
			}
			next, trigger := advanceArmed(state, tc.previous, tc.current, nil)
			if (trigger != nil) != tc.want || (tc.want && next != nil) {
				t.Fatalf("next=%+v trigger=%+v, want trigger=%v", next, trigger, tc.want)
			}
		})
	}
}

func TestArmingSampleCannotTriggerTouchThenFall(t *testing.T) {
	const now = int64(10_000_000)
	low := Sample{T: now - 2000, Premium: 100}
	previous := Sample{T: now - 1000, Premium: 106.5, VWAP: 107}
	current := Sample{T: now, Premium: 106, VWAP: 107}
	if !downwardVWAPCross(previous, current) {
		t.Fatal("fixture must qualify for the touch trigger")
	}
	state, trigger := advanceArmed(nil, previous, current, []Sample{low})
	if state == nil || state.ArmedAt != now || state.Reference != low || trigger != nil {
		t.Fatalf("arming sample triggered or failed to arm: state=%+v trigger=%+v", state, trigger)
	}
	next, trigger := advanceArmed(state, current, Sample{T: now + 1000, Premium: 105.5, VWAP: 107}, []Sample{low})
	if next != nil || trigger != state {
		t.Fatalf("subsequent touch did not consume the original arm: next=%+v trigger=%+v", next, trigger)
	}
}

func TestArmedPersistenceExpiryAndRearm(t *testing.T) {
	const now = int64(10_000_000)
	low := Sample{T: now - 1000, Premium: 100}
	state, _ := advanceArmed(nil, Sample{}, Sample{T: now, Premium: 106, VWAP: 105}, []Sample{low})
	// Falling below +5% without crossing does not disarm before the low expires.
	state, trigger := advanceArmed(state, Sample{T: now, Premium: 106, VWAP: 100}, Sample{T: now + 1000, Premium: 104, VWAP: 100}, []Sample{low})
	if state == nil || state.ArmedAt != now || trigger != nil {
		t.Fatal("pullback prematurely consumed the arm")
	}
	state, trigger = advanceArmed(state, Sample{T: now + 1000, Premium: 104, VWAP: 100}, Sample{T: now + 2000, Premium: 103, VWAP: 104}, []Sample{low})
	if state != nil || trigger == nil {
		t.Fatal("first downward cross did not consume arm")
	}
	state, trigger = advanceArmed(state, Sample{}, Sample{T: now + 3000, Premium: 106}, []Sample{low})
	if state == nil || trigger != nil || state.ArmedAt != now+3000 {
		t.Fatal("fresh +5% could not re-arm")
	}
	expired := low.T + WindowMs + 1
	state, trigger = advanceArmed(state, Sample{}, Sample{T: expired, Premium: 104}, []Sample{{T: expired - 1000, Premium: 103}})
	if state != nil || trigger != nil {
		t.Fatal("expired +5% reference retained arm")
	}
	state, _ = advanceArmed(nil, Sample{}, Sample{T: expired + 1000, Premium: 109}, []Sample{{T: expired, Premium: 103}})
	if state == nil {
		t.Fatal("could not re-arm after reference expiry")
	}
	// Another valid low keeps an old arm alive, preserving its spot baseline.
	state.Baseline = spotSample{T: state.ArmedAt, Price: 23850}
	armedAt := state.ArmedAt
	later := expired + WindowMs + 1
	state, _ = advanceArmed(state, Sample{}, Sample{T: later, Premium: 116}, []Sample{{T: later - 1000, Premium: 110}})
	if state == nil || state.ArmedAt != armedAt || state.Reference.Premium != 110 || state.Baseline.Price != 23850 {
		t.Fatal("reference renewal changed the arm time or spot baseline")
	}
}

func TestAttributeUnderlyingDirectionAndFreshness(t *testing.T) {
	const armedAt = int64(10_000_000)
	const triggerAt = armedAt + 10_000
	for _, tc := range []struct {
		name      string
		baseline  spotSample
		current   spotSample
		direction string
		note      string
	}{
		{"up", spotSample{armedAt, 100}, spotSample{triggerAt, 101}, CallCredit, ""},
		{"down", spotSample{armedAt, 100}, spotSample{triggerAt, 99}, PutCredit, ""},
		{"flat", spotSample{armedAt, 100}, spotSample{triggerAt, 100}, "", "flat"},
		{"missing baseline", spotSample{}, spotSample{triggerAt, 101}, "", "unavailable"},
		{"missing current", spotSample{armedAt, 100}, spotSample{}, "", "unavailable"},
		{"stale baseline", spotSample{armedAt - spotBaselineAgeMs - 1, 100}, spotSample{triggerAt, 101}, "", "unavailable"},
		{"stale current", spotSample{armedAt, 100}, spotSample{triggerAt - quoteAgeMs - 1, 101}, "", "unavailable"},
		{"inclusive ages", spotSample{armedAt - spotBaselineAgeMs, 100}, spotSample{triggerAt - quoteAgeMs, 101}, CallCredit, ""},
		{"baseline after arm", spotSample{armedAt + 1, 100}, spotSample{triggerAt, 101}, "", "unavailable"},
		{"future current", spotSample{armedAt, 100}, spotSample{triggerAt + 1, 101}, "", "unavailable"},
		{"invalid baseline", spotSample{armedAt, math.NaN()}, spotSample{triggerAt, 101}, "", "unavailable"},
		{"invalid current", spotSample{armedAt, 100}, spotSample{triggerAt, math.Inf(1)}, "", "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			direction, note := attributeUnderlyingDirection(tc.baseline, tc.current, armedAt, triggerAt)
			if direction != tc.direction || !strings.Contains(note, tc.note) {
				t.Fatalf("direction=%s note=%s, want %s/%s", direction, note, tc.direction, tc.note)
			}
		})
	}
}

func TestCreditSpreadLegsBothDirectionsAndMissingFourthHedge(t *testing.T) {
	u := buildUniverses(testInstruments(), "2026-11-04")["NIFTY"]
	selected := u.Pairs[5]
	for _, tc := range []struct {
		direction, shortKind, longKind string
		shortToken, longToken          int64
	}{
		{CallCredit, "CE", "CE", selected.CE.InstrumentToken, u.Calls[9].InstrumentToken},
		{PutCredit, "PE", "PE", selected.PE.InstrumentToken, u.Puts[1].InstrumentToken},
	} {
		t.Run(tc.direction, func(t *testing.T) {
			short, long, ok := creditSpreadLegs(u, selected, tc.direction)
			if !ok || short.InstrumentType != tc.shortKind || long.InstrumentType != tc.longKind || short.InstrumentToken != tc.shortToken || long.InstrumentToken != tc.longToken {
				t.Fatalf("wrong legs: %+v %+v %v", short, long, ok)
			}
			missing := u
			if tc.direction == CallCredit {
				missing.Calls = u.Calls[:9]
			} else {
				missing.Puts = u.Puts[2:]
			}
			if _, _, ok := creditSpreadLegs(missing, selected, tc.direction); ok {
				t.Fatal("selected nonexistent fourth hedge")
			}
			// A missing intermediate strike moves the fourth listed hedge farther out.
			gapped := u
			var wantHedge market.Instrument
			if tc.direction == CallCredit {
				gapped.Calls = append(append([]market.Instrument{}, u.Calls[:6]...), u.Calls[7:]...)
				wantHedge = u.Calls[10]
			} else {
				gapped.Puts = append(append([]market.Instrument{}, u.Puts[:4]...), u.Puts[5:]...)
				wantHedge = u.Puts[0]
			}
			if short, hedge, ok := creditSpreadLegs(gapped, selected, tc.direction); !ok || short.InstrumentToken != tc.shortToken || hedge.InstrumentToken != wantHedge.InstrumentToken {
				t.Fatalf("wrong legs across missing intermediate strike: %+v %+v %v", short, hedge, ok)
			}
		})
	}
	if _, _, ok := creditSpreadLegs(u, selected, "unknown"); ok {
		t.Fatal("unknown direction silently selected legs")
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

func TestResolveSpotTokensFromIndexMasterRowsWithoutSecurityIDConstants(t *testing.T) {
	rows := []market.Instrument{
		{InstrumentToken: 101, Name: "NIFTY", Tradingsymbol: "NIFTY 50", InstrumentType: "INDEX", Exchange: "INDICES", Segment: "INDICES"},
		{InstrumentToken: 202, Name: "SENSEX", Tradingsymbol: "SENSEX", InstrumentType: "INDEX", Exchange: "INDICES", Segment: "INDICES"},
		{InstrumentToken: 303, Name: "NIFTY BANK", Tradingsymbol: "BANKNIFTY", InstrumentType: "INDEX", Exchange: "INDICES", Segment: "INDICES"},
		{InstrumentToken: 404, Name: "NIFTY", InstrumentType: "CE", Exchange: "NFO", Segment: "NFO-OPT"},
		{InstrumentToken: 505, Name: "SENSEX", InstrumentType: "EQ", Exchange: "BSE", Segment: "BSE"},
	}
	got := resolveSpotTokens(rows)
	if len(got) != 2 || got[101] != "NIFTY" || got[202] != "SENSEX" {
		t.Fatalf("resolved names to the wrong instruments: %+v", got)
	}
	rows[0].Name, rows[0].Tradingsymbol = "", "  nifty  50 "
	if got = resolveSpotTokens(rows); got[101] != "NIFTY" {
		t.Fatal("exact normalized NIFTY 50 alias was not recognized")
	}
	duplicate := rows[0]
	duplicate.InstrumentToken = 606
	got = resolveSpotTokens(append(rows, duplicate))
	if len(got) != 1 || got[202] != "SENSEX" {
		t.Fatalf("ambiguous NIFTY master match did not fail closed: %+v", got)
	}
}
