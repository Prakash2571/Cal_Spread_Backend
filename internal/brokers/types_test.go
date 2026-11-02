package brokers

import "testing"

func TestIdentity(t *testing.T) {
	if len(IDs) != 2 || IDs[0] != Zerodha || IDs[1] != Dhan {
		t.Fatalf("IDs = %v", IDs)
	}
	if Legacy != Zerodha {
		t.Fatal("legacy broker is zerodha")
	}
	for s, want := range map[string]bool{"zerodha": true, "dhan": true, "DHAN": false, " dhan": false, "": false, "upstox": false} {
		if IsID(s) != want {
			t.Errorf("IsID(%q) = %v", s, !want)
		}
	}
}

func TestOfDefaultsToLegacy(t *testing.T) {
	dhan, junk := "dhan", "upstox"
	if Of(nil) != Zerodha || Of(&junk) != Zerodha || Of(&dhan) != Dhan {
		t.Fatal("Of must default to zerodha for missing or unknown values")
	}
}

func TestParseAndLabel(t *testing.T) {
	good := map[string]ID{" DHAN ": Dhan, "Zerodha": Zerodha, "dhan": Dhan}
	for in, want := range good {
		if got, ok := Parse(in); !ok || got != want {
			t.Errorf("Parse(%q) = %v,%v", in, got, ok)
		}
	}
	for _, bad := range []any{"upstox", "", nil, 5.0, true, []any{"dhan"}} {
		if _, ok := Parse(bad); ok {
			t.Errorf("Parse(%#v) should fail", bad)
		}
	}
	if Dhan.Label() != "DHAN" || Zerodha.Label() != "ZERODHA" {
		t.Fatal("labels")
	}
}
