package dhan

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// margin.json is written by testdata/gen_margin.mjs from the original
// normalizeDhanMultiMargin, describeDhanMarginPayload and extractIpv4Addresses
// (src/brokers/dhan/client.ts).
func TestMarginPayloadHelpersGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/margin.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Cases []struct {
			Input      json.RawMessage `json:"input"`
			Undefined  bool            `json:"undefined"`
			Normalized json.RawMessage `json:"normalized"`
			Describe   string          `json:"describe"`
			IPs        []string        `json:"ips"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 50 {
		t.Fatalf("only %d cases", len(g.Cases))
	}
	for i, c := range g.Cases {
		var v Value // undefined
		if !c.Undefined {
			if v, err = ParseJSON(c.Input); err != nil {
				t.Fatalf("case %d: %v", i, err)
			}
		}
		var want bytes.Buffer
		if err := json.Compact(&want, c.Normalized); err != nil {
			t.Fatal(err)
		}
		gotN := "null"
		if n := NormalizeMultiMargin(v); n != nil {
			gotN = string(jsjson.Marshal(n))
		}
		if gotN != want.String() {
			t.Errorf("case %d %s: normalized\n got  %s\n want %s", i, c.Input, gotN, want.String())
		}
		if got := DescribeMarginPayload(v); got != c.Describe {
			t.Errorf("case %d %s: describe %q, want %q", i, c.Input, got, c.Describe)
		}
		if got := ExtractIPv4Addresses(v); strings.Join(got, "|") != strings.Join(c.IPs, "|") || len(got) != len(c.IPs) {
			t.Errorf("case %d %s: ips %q, want %q", i, c.Input, got, c.IPs)
		}
	}
}
