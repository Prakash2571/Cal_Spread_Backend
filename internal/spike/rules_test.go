package spike

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestQualificationUsesEarlierThirtyMinuteLowWithoutChartVWAP(t *testing.T) {
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
			state, trigger, _ := advanceArmed(nil, Sample{}, Sample{T: now, Premium: tc.premium}, w.References(now), 0, 0, nil)
			if (state != nil) != tc.want || trigger != nil {
				t.Fatalf("state=%+v trigger=%+v, want armed=%v", state, trigger, tc.want)
			}
			if state != nil && (state.ArmedAt != now || state.Reference.Premium != 100) {
				t.Fatalf("wrong arm/reference: %+v", state)
			}
		})
	}
}

func TestPinnedEntryOnlyPriceDrivenDownwardChartCrossOrTouchAndFall(t *testing.T) {
	const now = int64(10_000_000)
	for _, tc := range []struct {
		name                               string
		armed                              bool
		previous                           Sample
		current                            Sample
		previousChartVWAP, currentChartVWAP float64
		want                               bool
	}{
		{"downward inclusive previous VWAP", true, Sample{T: now - 1000, Premium: 105, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, true},
		{"downward above previous VWAP", true, Sample{T: now - 1000, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, true},
		{"unarmed down cross", false, Sample{T: now - 1000, Premium: 105, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, false},
		{"upward cross", true, Sample{T: now - 1000, Premium: 104, VWAP: 200}, Sample{T: now, Premium: 106, VWAP: 200}, 105, 105, false},
		{"VWAP driven", true, Sample{T: now - 1000, Premium: 104, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 103, 105, false},
		{"touch then fall", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, true},
		{"touch exactly one rupee below", true, Sample{T: now - 1000, Premium: 104, VWAP: 200}, Sample{T: now, Premium: 103, VWAP: 200}, 105, 105, true},
		{"fall without touch at one rupee and one paisa below", true, Sample{T: now - 1000, Premium: 103.99, VWAP: 200}, Sample{T: now, Premium: 103, VWAP: 200}, 105, 105, false},
		{"touch without fall at equal premium", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104.5, VWAP: 200}, 105, 105, false},
		{"touch without fall at rising premium", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104.75, VWAP: 200}, 105, 105, false},
		{"unarmed touch then fall", false, Sample{T: now - 1000, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, false},
		{"touch current equal VWAP", true, Sample{T: now - 1000, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 104, false},
		{"touch sixty seconds inclusive", true, Sample{T: now - quoteAgeMs, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, true},
		{"touch sample gap", true, Sample{T: now - quoteAgeMs - 1, Premium: 104.5, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, false},
		{"current equal VWAP", true, Sample{T: now - 1000, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 105, VWAP: 200}, 105, 105, false},
		{"sixty seconds inclusive", true, Sample{T: now - quoteAgeMs, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, true},
		{"sample gap", true, Sample{T: now - quoteAgeMs - 1, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, false},
		{"time reversed", true, Sample{T: now + 1, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, false},
		{"missing VWAP", true, Sample{T: now - 1, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 0, 105, false},
		{"nonfinite prior premium", true, Sample{T: now - 1, Premium: math.Inf(1), VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, 105, false},
		{"nonfinite prior VWAP", true, Sample{T: now - 1, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, math.Inf(1), 105, false},
		{"nonfinite current VWAP", true, Sample{T: now - 1, Premium: 106, VWAP: 200}, Sample{T: now, Premium: 104, VWAP: 200}, 105, math.NaN(), false},
		{"nonfinite current premium", true, Sample{T: now - 1, Premium: 106, VWAP: 200}, Sample{T: now, Premium: math.NaN(), VWAP: 200}, 105, 105, false},
		{"signal cross only", true, Sample{T: now - 1000, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, 100, 100, false},
		{"chart cross only", true, Sample{T: now - 1000, Premium: 106, VWAP: 150}, Sample{T: now, Premium: 104, VWAP: 150}, 105, 105, true},
		{"missing current chart VWAP", true, Sample{T: now - 1000, Premium: 106, VWAP: 105}, Sample{T: now, Premium: 104, VWAP: 105}, 105, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var state *armedState
			if tc.armed {
				state = &armedState{ArmedAt: now - 2000, Reference: Sample{T: now - 3000, Premium: 100}, PinnedAt: now - 2000, Direction: CallCredit}
			}
			next, trigger, _ := advanceArmed(state, tc.previous, tc.current, nil, tc.previousChartVWAP, tc.currentChartVWAP, nil)
			if (trigger != nil) != tc.want || (tc.want && next != nil) {
				t.Fatalf("next=%+v trigger=%+v, want trigger=%v", next, trigger, tc.want)
			}
		})
	}
}

func TestQualificationBelowChartAndSlidingReferenceAtPin(t *testing.T) {
	const now = int64(10_000_000)
	low := Sample{T: now - 1000, Premium: 100}
	state, trigger, _ := advanceArmed(nil, Sample{}, Sample{T: now, Premium: 106}, []Sample{low}, 0, 110, nil)
	if state == nil || state.PinnedAt != 0 || state.AboveSince != 0 || trigger != nil {
		t.Fatal("+5% below chart VWAP must qualify without starting an above run")
	}
	// The original low ages out. Qualification stays; the current rolling low
	// supplies the baseline at pin even though +5% no longer holds.
	later := low.T + WindowMs + 1
	newLow := Sample{T: later - 1000, Premium: 105}
	pinAt := later + DirectionPinMs
	history := spotHistory{{T: newLow.T, Price: 23800}, {T: pinAt, Price: 23810}}
	previous := Sample{}
	for at := later; at <= pinAt; at += quoteAgeMs {
		current := Sample{T: at, Premium: 110}
		state, trigger, _ = advanceArmed(state, previous, current, []Sample{newLow}, 110, 110, history)
		previous = current
	}
	if state == nil || state.ArmedAt != now || state.Reference != newLow || state.Baseline.Price != 23800 || state.Direction != CallCredit || state.PinnedAt != pinAt || trigger != nil {
		t.Fatalf("pin failed to use the sliding low without requalification: %+v, %+v", state, trigger)
	}
}

func TestPinRequires120SecondsContinuouslyAtOrAboveChart(t *testing.T) {
	const now = int64(10_000_000)
	for _, direction := range []string{CallCredit, PutCredit} {
		for _, premium := range []float64{105, 108} {
			state := &armedState{ArmedAt: now, Reference: Sample{T: now - 1000, Premium: 100}}
			spot := 101.0
			if direction == PutCredit {
				spot = 99
			}
			history := spotHistory{{T: now - 1000, Price: 100}, {T: now + DirectionPinMs, Price: spot}}
			previous := Sample{}
			for second := int64(0); second <= 120; second++ {
				current := Sample{T: now + second*1000, Premium: premium, VWAP: 999}
				next, trigger, note := advanceArmed(state, previous, current, nil, 105, 105, history)
				if next == nil || trigger != nil || next.AboveSince != now || (next.PinnedAt != 0) != (second == 120) {
					t.Fatalf("premium=%v second=%d: next=%+v trigger=%+v", premium, second, next, trigger)
				}
				if second == 120 && (next.Direction != direction || !strings.Contains(note, "after 2 min above chart VWAP")) {
					t.Fatalf("wrong sustained-above pin direction/note: %+v, %s", next, note)
				}
				state, previous = next, current
			}
		}
	}
}

func TestShortAboveRunsAndWhipsawsDoNotPin(t *testing.T) {
	const now = int64(10_000_000)
	// The morning's 86 s run and the interpolated-line 119 s run are too short.
	for _, seconds := range []int64{2, 86, 119} {
		state := &armedState{ArmedAt: now, Reference: Sample{T: now - 1000, Premium: 100}}
		history := spotHistory{{T: now - 1000, Price: 100}, {T: now, Price: 101}}
		previous := Sample{}
		for second := int64(0); second <= seconds+1; second++ {
			premium := 108.0
			if second > seconds {
				premium = 104.5 // Downward cross/touch must reset, never pin/enter.
			}
			current := Sample{T: now + second*1000, Premium: premium}
			next, trigger, _ := advanceArmed(state, previous, current, nil, 105, 105, history)
			if next == nil || next.PinnedAt != 0 || trigger != nil || (second > seconds && next.AboveSince != 0) {
				t.Fatalf("%d s run pinned or entered at second %d: %+v, %+v", seconds, second, next, trigger)
			}
			state, previous = next, current
		}
	}
}

func TestAboveRunResetsOnBelowInvalidLineOrSampleGap(t *testing.T) {
	const now = int64(10_000_000)
	for _, tc := range []struct {
		name          string
		previous      Sample
		premium, line float64
		wantSince     int64
	}{
		{"below by a paisa", Sample{T: now - 1000, Premium: 108}, 104.99, 105, 0},
		{"touch below", Sample{T: now - 1000, Premium: 108}, 104.5, 105, 0},
		{"chart steps above premium", Sample{T: now - 1000, Premium: 108}, 108, 109, 0},
		{"missing chart", Sample{T: now - 1000, Premium: 108}, 108, 0, 0},
		{"invalid chart", Sample{T: now - 1000, Premium: 108}, 108, math.NaN(), 0},
		{"invalid premium", Sample{T: now - 1000, Premium: 108}, math.NaN(), 105, 0},
		{"sixty seconds plus one ms", Sample{T: now - quoteAgeMs - 1, Premium: 108}, 108, 105, now},
		{"continuity reset", Sample{}, 108, 105, now},
		{"time reversed", Sample{T: now + 1, Premium: 108}, 108, 105, now},
		{"previous below", Sample{T: now - 1000, Premium: 104}, 108, 105, now},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &armedState{ArmedAt: now - DirectionPinMs, AboveSince: now - DirectionPinMs, Reference: Sample{T: now - DirectionPinMs - 1000, Premium: 100}}
			next, trigger, _ := advanceArmed(state, tc.previous, Sample{T: now, Premium: tc.premium}, nil, 105, tc.line, nil)
			if next == nil || next.PinnedAt != 0 || next.AboveSince != tc.wantSince || trigger != nil {
				t.Fatalf("interrupted run did not reset: %+v, %+v", next, trigger)
			}
			// A fresh sample starts/restarts the run; 119 further seconds do
			// not inherit any elapsed time from before the interruption.
			previous := Sample{}
			for second := int64(1); second <= 120; second++ {
				current := Sample{T: now + second*1000, Premium: 108}
				next, trigger, _ = advanceArmed(next, previous, current, nil, 105, 105, nil)
				if next == nil || next.PinnedAt != 0 || trigger != nil || next.AboveSince != now+1000 {
					t.Fatal("interrupted run retained time toward the next pin")
				}
				previous = current
			}
		})
	}
}

func TestQualificationDoesNotInheritUnqualifiedAboveRun(t *testing.T) {
	const now = int64(10_000_000)
	previous := Sample{T: now - 1000, Premium: 104}
	state, trigger, _ := advanceArmed(nil, previous, Sample{T: now, Premium: 106}, []Sample{{T: now - DirectionPinMs, Premium: 100}}, 100, 100, nil)
	if state == nil || state.AboveSince != now || state.PinnedAt != 0 || trigger != nil {
		t.Fatal("qualification inherited an above run from before it latched")
	}
}

func TestFirstPinWinsAndEntryDoesNotRecheckFivePercent(t *testing.T) {
	const now = int64(10_000_000)
	low := Sample{T: now - 2000, Premium: 100}
	pinAt := now + DirectionPinMs
	history := spotHistory{{T: low.T, Price: 100}, {T: pinAt, Price: 101}}
	var state, trigger *armedState
	previous := Sample{}
	for at := now; at <= pinAt; at += quoteAgeMs {
		current := Sample{T: at, Premium: 108}
		state, trigger, _ = advanceArmed(state, previous, current, []Sample{low}, 105, 105, history)
		previous = current
	}
	if state == nil || state.PinnedAt != pinAt || trigger != nil {
		t.Fatal("sustained-above run did not pin")
	}
	original := *state
	// A later touch would imply LONG, but the original SHORT must win.
	history.add(spotSample{T: pinAt + 1000, Price: 99})
	state, trigger, _ = advanceArmed(state, previous, Sample{T: pinAt + 1000, Premium: 105.5}, []Sample{{T: pinAt, Premium: 90}}, 105, 105, history)
	if state == nil || *state != original || trigger != nil {
		t.Fatal("later touch changed the first pin or its reference")
	}
	// Qualification and pin survive the old low's expiry, then enter below +5%.
	later := low.T + WindowMs + 1
	state, trigger, _ = advanceArmed(state, Sample{}, Sample{T: later, Premium: 105.5}, nil, 0, 105, nil)
	if state == nil || *state != original || trigger != nil {
		t.Fatal("window age expired the qualification/pin")
	}
	next, trigger, _ := advanceArmed(state, Sample{T: later, Premium: 105.5}, Sample{T: later + 1000, Premium: 103}, nil, 105, 105, nil)
	if next != nil || trigger == nil || *trigger != original || trigger.Direction != CallCredit {
		t.Fatal("entry rechecked +5%, spot direction, reference age or pin")
	}
	// Consumption allows a fresh qualification later in the same day.
	next, trigger, _ = advanceArmed(next, Sample{}, Sample{T: later + 3000, Premium: 106}, []Sample{{T: later + 2000, Premium: 100}}, 0, 110, nil)
	if next == nil || next.ArmedAt != later+3000 || trigger != nil {
		t.Fatal("consumed qualification could not rearm")
	}
}

func TestFlatOrStaleSpotConsumesFirstPinWithoutEntry(t *testing.T) {
	const now = int64(10_000_000)
	low := Sample{T: now - DirectionPinMs - 1000, Premium: 100}
	for _, tc := range []struct {
		name    string
		history spotHistory
	}{
		{"flat", spotHistory{{T: low.T, Price: 100}, {T: now, Price: 100}}},
		{"missing", nil},
		{"stale current", spotHistory{{T: low.T, Price: 100}, {T: now - quoteAgeMs - 1, Price: 101}}},
		{"stale baseline", spotHistory{{T: low.T - spotBaselineAgeMs - 1, Price: 100}, {T: now, Price: 101}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &armedState{ArmedAt: now - DirectionPinMs, AboveSince: now - DirectionPinMs, Reference: low}
			next, trigger, note := advanceArmed(state, Sample{T: now - 1000, Premium: 108}, Sample{T: now, Premium: 108}, []Sample{low}, 105, 105, tc.history)
			if next != nil || trigger != nil || !strings.Contains(note, "pin consumed") {
				t.Fatalf("flat/stale spot retained pin or entered: %+v, %+v, %s", next, trigger, note)
			}
			// A later fall cannot use the consumed qualification; no new +5%.
			next, trigger, _ = advanceArmed(next, Sample{T: now, Premium: 108}, Sample{T: now + 1000, Premium: 103}, []Sample{low}, 105, 105, spotHistory{{T: low.T, Price: 100}, {T: now + 1000, Price: 101}})
			if next != nil || trigger != nil {
				t.Fatal("consumed pin was reused on a later fall")
			}
		})
	}
}

func TestQualificationAndPinEndWithDay(t *testing.T) {
	now := time.Date(2026, 11, 19, 15, 30, 0, 0, ist).UnixMilli()
	for _, pinned := range []bool{false, true} {
		state := &armedState{ArmedAt: now, AboveSince: now, Reference: Sample{T: now - 1000, Premium: 100}}
		if pinned {
			state.PinnedAt, state.Direction = now, CallCredit
		}
		next, trigger, _ := advanceArmed(state, Sample{}, Sample{T: now + 24*60*60_000, Premium: 110}, nil, 0, 105, nil)
		if next != nil || trigger != nil {
			t.Fatal("qualification/pin leaked into the next day")
		}
	}
}

func TestAttributeUnderlyingDirectionAndFreshness(t *testing.T) {
	const referenceAt = int64(10_000_000)
	const pinAt = referenceAt + 10_000
	for _, tc := range []struct {
		name      string
		baseline  spotSample
		current   spotSample
		direction string
		note      string
	}{
		{"up", spotSample{referenceAt, 100}, spotSample{pinAt, 101}, CallCredit, ""},
		{"down", spotSample{referenceAt, 100}, spotSample{pinAt, 99}, PutCredit, ""},
		{"flat", spotSample{referenceAt, 100}, spotSample{pinAt, 100}, "", "flat"},
		{"missing baseline", spotSample{}, spotSample{pinAt, 101}, "", "unavailable"},
		{"missing current", spotSample{referenceAt, 100}, spotSample{}, "", "unavailable"},
		{"stale baseline", spotSample{referenceAt - spotBaselineAgeMs - 1, 100}, spotSample{pinAt, 101}, "", "unavailable"},
		{"stale current", spotSample{referenceAt, 100}, spotSample{pinAt - quoteAgeMs - 1, 101}, "", "unavailable"},
		{"inclusive ages", spotSample{referenceAt - spotBaselineAgeMs, 100}, spotSample{pinAt - quoteAgeMs, 101}, CallCredit, ""},
		{"baseline after low", spotSample{referenceAt + 1, 100}, spotSample{pinAt, 101}, "", "unavailable"},
		{"future current", spotSample{referenceAt, 100}, spotSample{pinAt + 1, 101}, "", "unavailable"},
		{"invalid baseline", spotSample{referenceAt, math.NaN()}, spotSample{pinAt, 101}, "", "unavailable"},
		{"invalid current", spotSample{referenceAt, 100}, spotSample{pinAt, math.Inf(1)}, "", "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			direction, note := attributeUnderlyingDirection(tc.baseline, tc.current, referenceAt, pinAt)
			if direction != tc.direction || !strings.Contains(note, tc.note) {
				t.Fatalf("direction=%s note=%s, want %s/%s", direction, note, tc.direction, tc.note)
			}
		})
	}
}

func TestATMPairIsNearestSpotNotMinimumStraddle(t *testing.T) {
	u := buildUniverses(testInstruments(), "2026-11-04")["NIFTY"] // 23600..24100 by 50
	for _, tc := range []struct {
		spot, strike float64
	}{
		{23921, 23900}, {23874, 23850}, {23875, 23850}, // midpoint tie takes the lower strike
		{23876, 23900}, {20000, 23600}, {30000, 24100},
	} {
		p, ok := atmPair(u, tc.spot)
		if !ok || p.CE.Strike != tc.strike || p.PE.Strike != tc.strike {
			t.Fatalf("spot %v: got strike %v, want %v", tc.spot, p.CE.Strike, tc.strike)
		}
	}
	for _, spot := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		if _, ok := atmPair(u, spot); ok {
			t.Fatalf("invalid spot %v selected a strike", spot)
		}
	}
	if _, ok := atmPair(universe{}, 23900); ok {
		t.Fatal("empty chain selected a strike")
	}
	// Spot 23921 with a rising underlying: sell ATM 23900 CE, hedge the 4th higher CE.
	atm, _ := atmPair(u, 23921)
	short, hedge, ok := creditSpreadLegs(u, atm, CallCredit)
	if !ok || short.Strike != 23900 || short.InstrumentType != "CE" || hedge.Strike != 24100 || hedge.InstrumentType != "CE" {
		t.Fatalf("wrong ATM call credit legs: %+v %+v", short, hedge)
	}
	short, hedge, ok = creditSpreadLegs(u, atm, PutCredit)
	if !ok || short.Strike != 23900 || short.InstrumentType != "PE" || hedge.Strike != 23700 || hedge.InstrumentType != "PE" {
		t.Fatalf("wrong ATM put credit legs: %+v %+v", short, hedge)
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
