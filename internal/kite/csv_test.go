package kite

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// jsNum is a golden number: a JSON number, or {"$num":"NaN"|"Infinity"|"-Infinity"} for
// the values JSON cannot carry (testdata/loader.mjs replacer).
type jsNum float64

func (n *jsNum) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '{' {
		var o struct {
			Num string `json:"$num"`
		}
		if err := json.Unmarshal(b, &o); err != nil {
			return err
		}
		switch o.Num {
		case "NaN":
			*n = jsNum(math.NaN())
		case "Infinity":
			*n = jsNum(math.Inf(1))
		case "-Infinity":
			*n = jsNum(math.Inf(-1))
		default:
			return fmt.Errorf("unknown $num %q", o.Num)
		}
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	*n = jsNum(f)
	return nil
}

type csvGoldenRow struct {
	InstrumentToken jsNum  `json:"instrument_token"`
	ExchangeToken   jsNum  `json:"exchange_token"`
	Tradingsymbol   string `json:"tradingsymbol"`
	Name            string `json:"name"`
	LastPrice       jsNum  `json:"last_price"`
	Expiry          string `json:"expiry"`
	Strike          jsNum  `json:"strike"`
	TickSize        jsNum  `json:"tick_size"`
	LotSize         jsNum  `json:"lot_size"`
	InstrumentType  string `json:"instrument_type"`
	Segment         string `json:"segment"`
	Exchange        string `json:"exchange"`
}

func sameNumber(got float64, want jsNum) bool {
	w := float64(want)
	return got == w || (math.IsNaN(got) && math.IsNaN(w))
}

// wantToken is the documented deviation for the integer token columns: Node kept any
// Number() result; Go has int64 fields, so NaN, ±Infinity and values beyond int64 read as
// 0 and fractions are truncated. exact reports whether Node's value survives unchanged.
func wantToken(v jsNum) (token int64, exact bool) {
	f := float64(v)
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > 9.2e18 {
		return 0, false
	}
	return int64(f), f == math.Trunc(f)
}

// TestParseInstrumentsCSVGolden compares ParseInstrumentsCSV with src/kite.ts
// parseInstrumentsCsv run by Node (gen_csv.mjs) on the same text: line endings, BOM,
// quoting, column order, short/long rows, every Number() edge case per numeric column,
// JavaScript whitespace trimming and 800 generated rows.
func TestParseInstrumentsCSVGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "instruments_csv.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/kite/testdata/gen_csv.mjs)", err)
	}
	var g struct {
		Cases []struct {
			Name  string         `json:"name"`
			CSV   string         `json:"csv"`
			Rows  []csvGoldenRow `json:"rows"`
			Error *string        `json:"error"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 90 {
		t.Fatalf("golden has only %d cases", len(g.Cases))
	}
	rows, inexactTokens := 0, 0
	for _, c := range g.Cases {
		if c.Error != nil {
			t.Fatalf("%s: Node threw %s; the Go parser cannot fail", c.Name, *c.Error)
		}
		got := ParseInstrumentsCSV(c.CSV)
		if got == nil || len(got) != len(c.Rows) {
			t.Errorf("%s: %d rows, want %d", c.Name, len(got), len(c.Rows))
			continue
		}
		for i, w := range c.Rows {
			r := got[i]
			var diffs []string
			for _, tok := range []struct {
				name string
				got  int64
				want jsNum
			}{{"instrument_token", r.InstrumentToken, w.InstrumentToken}, {"exchange_token", r.ExchangeToken, w.ExchangeToken}} {
				want, exact := wantToken(tok.want)
				if !exact {
					inexactTokens++
					// gen_csv.mjs puts one deliberate fractional row (FRACTION) among the
					// realistic ones; every other realistic or bulk token is an integer.
					if (strings.HasPrefix(c.Name, "realistic") || strings.HasPrefix(c.Name, "bulk")) && w.Tradingsymbol != "FRACTION" {
						diffs = append(diffs, tok.name+" is not an exact integer in a realistic row")
					}
				}
				if tok.got != want {
					diffs = append(diffs, fmt.Sprintf("%s %d, want %d (Node %v)", tok.name, tok.got, want, float64(tok.want)))
				}
			}
			for _, n := range []struct {
				name string
				got  float64
				want jsNum
			}{{"last_price", r.LastPrice, w.LastPrice}, {"strike", r.Strike, w.Strike}, {"tick_size", r.TickSize, w.TickSize}, {"lot_size", r.LotSize, w.LotSize}} {
				if !sameNumber(n.got, n.want) {
					diffs = append(diffs, fmt.Sprintf("%s %v, want %v", n.name, n.got, float64(n.want)))
				}
			}
			for _, s := range [][3]string{{"tradingsymbol", r.Tradingsymbol, w.Tradingsymbol}, {"name", r.Name, w.Name},
				{"expiry", r.Expiry, w.Expiry}, {"instrument_type", r.InstrumentType, w.InstrumentType},
				{"segment", r.Segment, w.Segment}, {"exchange", r.Exchange, w.Exchange}} {
				if s[1] != s[2] {
					diffs = append(diffs, fmt.Sprintf("%s %q, want %q", s[0], s[1], s[2]))
				}
			}
			if len(diffs) > 0 {
				t.Errorf("%s row %d: %s", c.Name, i, strings.Join(diffs, "; "))
			}
		}
		rows += len(c.Rows)
	}
	t.Logf("%d cases, %d rows; %d token values Node kept as NaN/Infinity/fraction/beyond int64 (Go: 0 or truncated)",
		len(g.Cases), rows, inexactTokens)
}
