package main

import (
	"testing"
	"time"
)

func TestSpikeFixtureKeepsWeekendVerificationInsideARecordedMarketSession(t *testing.T) {
	ist := time.FixedZone("IST", 330*60)
	for _, tc := range []struct {
		day, wantDay int
	}{{7, 6}, {8, 6}, {9, 9}} {
		at := spikeFixtureTime(time.Date(2026, 11, tc.day, 18, 0, 0, 0, ist))
		if at.Day() != tc.wantDay || at.Weekday() == time.Saturday || at.Weekday() == time.Sunday ||
			at.Hour() != 14 || at.Minute() != 5 || at.Second() != 10 {
			t.Fatalf("day %d cannot exercise live crossover workflows: %s", tc.day, at)
		}
	}
}
