package registry

// Ports of tests/box/indexSpot.test.mjs cases with the suite's own spot sets: the
// golden's spot sets left FINNIFTY under Zerodha's name and MIDCPNIFTY / NIFTYNXT50
// under Dhan's names unchecked, and MIDCPNIFTY → "NIFTY MID SELECT" only indirect.

import (
	"slices"
	"testing"
)

func hasSpot(list ...string) func(string) bool {
	return func(s string) bool { return slices.Contains(list, s) }
}

// "ZERODHA's index spot still resolves to the curated name"
func TestNodeZerodhaIndexSpotResolvesToTheCuratedName(t *testing.T) {
	kite := hasSpot("NIFTY 50", "NIFTY BANK", "NIFTY FIN SERVICE", "NIFTY MID SELECT", "NIFTY NEXT 50")
	for underlying, want := range map[string]string{
		"NIFTY": "NIFTY 50", "BANKNIFTY": "NIFTY BANK", "MIDCPNIFTY": "NIFTY MID SELECT", "NIFTYNXT50": "NIFTY NEXT 50",
	} {
		if got, ok := ResolveIndexSpotSymbol(underlying, kite, IndexSpotMap); !ok || got != want {
			t.Errorf("resolve(%q) = %q,%v, want %q", underlying, got, ok, want)
		}
	}
}

// "every mapped index underlying resolves under BOTH naming conventions"
func TestNodeEveryMappedIndexResolvesUnderBothConventions(t *testing.T) {
	if len(IndexSpotMap) != 5 {
		t.Fatalf("IndexSpotMap has %d entries", len(IndexSpotMap))
	}
	for underlying, kiteName := range IndexSpotMap {
		if got, ok := ResolveIndexSpotSymbol(underlying, hasSpot(kiteName), IndexSpotMap); !ok || got != kiteName {
			t.Errorf("%s: got %q,%v, want %q", underlying, got, ok, kiteName)
		}
		if got, ok := ResolveIndexSpotSymbol(underlying, hasSpot(underlying), IndexSpotMap); !ok || got != underlying {
			t.Errorf("%s under Dhan's convention: got %q,%v", underlying, got, ok)
		}
	}
}
