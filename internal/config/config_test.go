package config

import (
	"math"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

func TestNumMatchesNodeHelper(t *testing.T) {
	cases := []struct {
		raw  string
		want float64
	}{
		{"", 7}, {"   ", 7}, {"12", 12}, {" 12.5 ", 12.5}, {"1e3", 1000}, {"0x10", 16},
		{"-1", 7},    // Node num() rejects negatives
		{"abc", 7},   // NaN
		{"inf", 7},   // Go spelling, not a JS number
		{"nan", 7},   //
		{"1_000", 7}, // Go underscore syntax is not a JS number
		{"Infinity", 7},
		{"0", 0},
	}
	for _, c := range cases {
		got := Num(MapGetter(map[string]string{"X": c.raw}), "X", 7)
		if got != c.want {
			t.Errorf("Num(%q) = %v, want %v", c.raw, got, c.want)
		}
	}
	if got := Num(MapGetter(nil), "MISSING", 3); got != 3 {
		t.Errorf("unset = %v, want 3", got)
	}
}

func TestNumAnyAllowsNegative(t *testing.T) {
	v, ok := NumAny(MapGetter(map[string]string{"X": "-2.5"}), "X")
	if !ok || v != -2.5 {
		t.Fatalf("got %v %v", v, ok)
	}
	if _, ok := NumAny(MapGetter(map[string]string{"X": "1e999"}), "X"); ok {
		t.Fatal("overflowing value must not be accepted")
	}
	if v, _ := jsx.ParseNumber("1e999"); !math.IsInf(v, 1) {
		t.Fatal("JSNumber should overflow to +Inf like JS")
	}
}

func TestBoolMatchesNodeHelper(t *testing.T) {
	for raw, want := range map[string]bool{"1": true, "TRUE": true, " yes ": true, "0": false, "False": false, "no": false} {
		if got := Bool(MapGetter(map[string]string{"B": raw}), "B", !want); got != want {
			t.Errorf("Bool(%q) = %v, want %v", raw, got, want)
		}
	}
	for _, raw := range []string{"", "on", "off", "maybe"} {
		if !Bool(MapGetter(map[string]string{"B": raw}), "B", true) || Bool(MapGetter(map[string]string{"B": raw}), "B", false) {
			t.Errorf("Bool(%q) must fall back to the default", raw)
		}
	}
}

func TestLoadDefaultsAndExtraSessionDays(t *testing.T) {
	c := Load(MapGetter(map[string]string{"EXTRA_SESSION_DAYS": " 2026-11-08, ,2027-10-29", "ADMIN_SECRET": "  s  "}))
	if c.Port != 3001 || c.FrontendURL != "http://localhost:5173" {
		t.Fatalf("defaults: port=%d frontend=%q", c.Port, c.FrontendURL)
	}
	if !c.ExtraSessionDays["2026-11-08"] || !c.ExtraSessionDays["2027-10-29"] || len(c.ExtraSessionDays) != 2 {
		t.Fatalf("extra days: %v", c.ExtraSessionDays)
	}
	if c.AdminSecret != "s" {
		t.Fatalf("admin secret not trimmed: %q", c.AdminSecret)
	}
}
