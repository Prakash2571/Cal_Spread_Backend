package registry

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// helpers.golden.json is written by testdata/gen_registry.mjs from the original
// TypeScript (history.ts, boardDiagnostics.ts, indexSpot.ts).

// jsNum decodes a canonical golden number: plain JSON numbers, or {"$num": "NaN" |
// "Infinity" | "-Infinity" | "-0"} for what JSON cannot carry.
type jsNum float64

func (n *jsNum) UnmarshalJSON(b []byte) error {
	if bytes.HasPrefix(bytes.TrimSpace(b), []byte("{")) {
		var w struct {
			Num string `json:"$num"`
		}
		if err := json.Unmarshal(b, &w); err != nil {
			return err
		}
		switch w.Num {
		case "NaN":
			*n = jsNum(math.NaN())
		case "Infinity":
			*n = jsNum(math.Inf(1))
		case "-Infinity":
			*n = jsNum(math.Inf(-1))
		case "-0":
			*n = jsNum(math.Copysign(0, -1))
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

func sameNum(a, b float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.IsNaN(a) && math.IsNaN(b)
	}
	return a == b && math.Signbit(a) == math.Signbit(b)
}

type helpersGolden struct {
	Cases struct {
		Chunk []struct {
			From    jsNum `json:"from"`
			To      jsNum `json:"to"`
			MaxDays jsNum `json:"maxDays"`
			Out     []struct {
				From jsNum `json:"from"`
				To   jsNum `json:"to"`
			} `json:"out"`
		} `json:"chunk"`
		Candles []struct {
			Input dhan.Candles    `json:"input"`
			Out   json.RawMessage `json:"out"`
		} `json:"candles"`
		Board []struct {
			Universe string          `json:"universe"`
			Map      string          `json:"map"`
			Out      json.RawMessage `json:"out"`
		} `json:"board"`
		Known []struct {
			Universe string          `json:"universe"`
			Symbols  []string        `json:"symbols"`
			Out      json.RawMessage `json:"out"`
		} `json:"known"`
		Spot []struct {
			Map        string   `json:"map"`
			Underlying string   `json:"underlying"`
			Has        string   `json:"has"`
			Candidates []string `json:"candidates"`
			Resolved   *string  `json:"resolved"`
		} `json:"spot"`
	} `json:"cases"`
	Universes map[string][]market.Instrument `json:"universes"`
	Maps      map[string]map[string]string   `json:"maps"`
	SpotSets  map[string][]string            `json:"spotSets"`
}

func loadHelpersGolden(t *testing.T) helpersGolden {
	t.Helper()
	raw, err := os.ReadFile("testdata/helpers.golden.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g helpersGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	return g
}

// compactJSON re-encodes golden JSON text compactly (the generator already wrote it
// compactly; this only guards against whitespace).
func compactJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		t.Fatalf("compact: %v", err)
	}
	return b.String()
}

func TestChunkDateRangeGolden(t *testing.T) {
	g := loadHelpersGolden(t)
	if len(g.Cases.Chunk) == 0 {
		t.Fatal("no chunk cases")
	}
	for i, c := range g.Cases.Chunk {
		got := ChunkDateRange(float64(c.From), float64(c.To), float64(c.MaxDays))
		if len(got) != len(c.Out) {
			t.Fatalf("case %d (%v..%v / %v): %d chunks, want %d", i, c.From, c.To, c.MaxDays, len(got), len(c.Out))
		}
		for j := range got {
			if !sameNum(got[j].From, float64(c.Out[j].From)) || !sameNum(got[j].To, float64(c.Out[j].To)) {
				t.Errorf("case %d chunk %d: got [%v, %v], want [%v, %v]", i, j, got[j].From, got[j].To, c.Out[j].From, c.Out[j].To)
			}
		}
	}
}

func TestDhanCandlesToRowsGolden(t *testing.T) {
	g := loadHelpersGolden(t)
	for i, c := range g.Cases.Candles {
		got := string(jsjson.Marshal(DhanCandlesToRows(c.Input)))
		if want := compactJSON(t, c.Out); got != want {
			t.Errorf("case %d:\n got  %s\n want %s", i, got, want)
		}
	}
}

func TestBoardDiagnosticsGolden(t *testing.T) {
	g := loadHelpersGolden(t)
	if len(g.Cases.Board) == 0 || len(g.Cases.Known) == 0 {
		t.Fatal("no board cases")
	}
	for _, c := range g.Cases.Board {
		got := string(jsjson.Marshal(DiagnoseBoard(g.Universes[c.Universe], g.Maps[c.Map])))
		if want := compactJSON(t, c.Out); got != want {
			t.Errorf("diagnoseBoard(%s, %s):\n got  %s\n want %s", c.Universe, c.Map, got, want)
		}
	}
	for _, c := range g.Cases.Known {
		got := string(jsjson.Marshal(CheckKnownSymbols(g.Universes[c.Universe], c.Symbols)))
		if want := compactJSON(t, c.Out); got != want {
			t.Errorf("checkKnownSymbols(%s, %v):\n got  %s\n want %s", c.Universe, c.Symbols, got, want)
		}
	}
}

func TestIndexSpotGolden(t *testing.T) {
	g := loadHelpersGolden(t)
	if len(g.Cases.Spot) == 0 {
		t.Fatal("no spot cases")
	}
	for _, c := range g.Cases.Spot {
		set := g.SpotSets[c.Has]
		has := func(s string) bool {
			for _, x := range set {
				if x == s {
					return true
				}
			}
			return false
		}
		m := g.Maps[c.Map]
		if got := IndexSpotCandidates(c.Underlying, m); strings.Join(got, "|") != strings.Join(c.Candidates, "|") || len(got) != len(c.Candidates) {
			t.Errorf("candidates(%q, %s) = %q, want %q", c.Underlying, c.Map, got, c.Candidates)
		}
		got, ok := ResolveIndexSpotSymbol(c.Underlying, has, m)
		switch {
		case c.Resolved == nil && ok:
			t.Errorf("resolve(%q, %s, %s) = %q, want null", c.Underlying, c.Map, c.Has, got)
		case c.Resolved != nil && (!ok || got != *c.Resolved):
			t.Errorf("resolve(%q, %s, %s) = %q/%v, want %q", c.Underlying, c.Map, c.Has, got, ok, *c.Resolved)
		}
	}
	// The production map is INDEX_SPOT_MAP itself.
	if got, want := string(jsjson.Marshal(IndexSpotMap)), string(jsjson.Marshal(g.Maps["index"])); got != want {
		t.Errorf("IndexSpotMap = %s, want %s", got, want)
	}
}
