package jsx

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestRoundMatchesMathRound(t *testing.T) {
	// Expected values are what JavaScript's Math.round returns.
	cases := []struct{ in, want float64 }{
		{2.5, 3}, {-2.5, -2}, {0.5, 1}, {-0.5, 0}, {1.4999999999999999, 2},
		{0.49999999999999994, 0}, // naive floor(x+0.5) would give 1
		{-0.2, 0}, {-1.5, -1}, {1e21, 1e21}, {4503599627370497, 4503599627370497},
	}
	for _, c := range cases {
		if got := Round(c.in); got != c.want {
			t.Errorf("Round(%v) = %v, want %v", c.in, got, c.want)
		}
	}
	if math.Signbit(Round(-0.2)) {
		t.Error("Round(-0.2) must be +0, not -0")
	}
	if !math.IsNaN(Round(math.NaN())) || !math.IsInf(Round(math.Inf(1)), 1) {
		t.Error("NaN and Inf pass through")
	}
}

func TestRound2(t *testing.T) {
	// Math.round(-1.005*100)/100 and friends.
	cases := []struct{ in, want float64 }{{1.005, 1}, {2.675, 2.68}, {-2.675, -2.67}, {10.125, 10.13}, {0, 0}}
	for _, c := range cases {
		if got := Round2(c.in); got != c.want {
			t.Errorf("Round2(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestJSONNumberFormattingMatchesJS(t *testing.T) {
	// JSON.stringify prints these the same way as Go's encoder; the port relies on it.
	cases := map[float64]string{1e21: "1e+21", 1e-7: "1e-7", 123456789012345680000: "123456789012345680000", 0.000001: "0.000001", 100: "100", 1.5: "1.5"}
	for in, want := range cases {
		b, _ := json.Marshal(in)
		if string(b) != want {
			t.Errorf("Marshal(%v) = %s, want %s", in, b, want)
		}
	}
	// Negative zero is the one divergence: JS prints 0.
	b, _ := json.Marshal(math.Copysign(0, -1))
	if string(b) != "-0" {
		t.Skip("encoder already normalises negative zero")
	}
}

func TestISOHasThreeFractionDigits(t *testing.T) {
	if got := ISO(time.Date(2026, 10, 27, 9, 15, 0, 0, time.UTC)); got != "2026-10-27T09:15:00.000Z" {
		t.Errorf("ISO = %s", got)
	}
	if got := ISO(time.Date(2026, 10, 27, 9, 15, 0, 123456789, time.FixedZone("x", 3600))); got != "2026-10-27T08:15:00.123Z" {
		t.Errorf("ISO = %s", got)
	}
	if got := TruncMs(time.Unix(0, 1_999_999)); got.Nanosecond() != 1_000_000 {
		t.Errorf("TruncMs nanos = %d", got.Nanosecond())
	}
}

func TestIstDayKeyBoundary(t *testing.T) {
	// Verified against Node: istDayKey(2026-10-26T18:29:59.999Z) = 2026-10-26, +1ms = 2026-10-27.
	a := time.Date(2026, 10, 26, 18, 29, 59, 999_000_000, time.UTC)
	if got := IstDayKey(a); got != "2026-10-26" {
		t.Errorf("before boundary: %s", got)
	}
	if got := IstDayKey(a.Add(time.Millisecond)); got != "2026-10-27" {
		t.Errorf("at boundary: %s", got)
	}
	if got := IstDateTime(a.Add(time.Millisecond)); got != "2026-10-27 00:00:00" {
		t.Errorf("IstDateTime: %s", got)
	}
}

func TestIsMarketOpen(t *testing.T) {
	ist := time.FixedZone("IST", 5*3600+1800)
	at := func(d, h, m int) time.Time { return time.Date(2026, 10, d, h, m, 0, 0, ist) }
	cases := []struct {
		name string
		t    time.Time
		want bool
	}{
		{"Tue 09:14", at(27, 9, 14), false}, {"Tue 09:15", at(27, 9, 15), true},
		{"Tue 15:40", at(27, 15, 40), true}, {"Tue 15:41", at(27, 15, 41), false},
		{"Sat 10:00", at(24, 10, 0), false}, {"Sun 10:00", at(25, 10, 0), false},
		{"Mon 12:00", at(26, 12, 0), true},
	}
	for _, c := range cases {
		if got := IsMarketOpen(c.t); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
