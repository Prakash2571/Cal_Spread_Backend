package synthetic

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

// The golden comes from testdata/gen_math.mjs, which runs the original
// src/synthetic/math.ts. Chains and windows are rebuilt here by the Go functions from
// the same instrument rows, so every step of the pipeline is compared, not just the last.

// gnum is a golden number; the generator writes non-finite values as {"$num": "NaN"}.
type gnum float64

func (n *gnum) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '{' {
		var o struct {
			Num string `json:"$num"`
		}
		if err := json.Unmarshal(b, &o); err != nil {
			return err
		}
		switch o.Num {
		case "NaN":
			*n = gnum(math.NaN())
		case "Infinity":
			*n = gnum(math.Inf(1))
		case "-Infinity":
			*n = gnum(math.Inf(-1))
		default:
			return fmt.Errorf("bad $num %q", o.Num)
		}
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	*n = gnum(f)
	return nil
}

type mathGolden struct {
	Today        string              `json:"today"`
	Now          int64               `json:"now"`
	OptionRates  ratecard.Rates      `json:"optionRates"`
	FuturesRates ratecard.Rates      `json:"futuresRates"`
	Instruments  []market.Instrument `json:"instruments"`
	Chains       []json.RawMessage   `json:"chains"`
	ChainsLater  []json.RawMessage   `json:"chainsLater"`
	Windows      []struct {
		Underlying string          `json:"underlying"`
		Board      BoardItem       `json:"board"`
		Ref        gnum            `json:"ref"`
		EachSide   int             `json:"eachSide"`
		Window     json.RawMessage `json:"window"`
		Tokens     []int64         `json:"tokens"`
	} `json:"windows"`
	Rebuild []struct {
		Underlying    string  `json:"underlying"`
		Ref           float64 `json:"ref"`
		Now           int64   `json:"now"`
		Hysteresis    float64 `json:"hysteresis"`
		MinIntervalMs float64 `json:"minIntervalMs"`
		Value         bool    `json:"value"`
	} `json:"rebuild"`
	TokensFor [][2]int          `json:"tokensFor"`
	Years     []json.RawMessage `json:"years"`
	Keys      []json.RawMessage `json:"keys"`
	Charges   []struct {
		Legs     []ChargeOrder `json:"legs"`
		Quantity float64       `json:"quantity"`
		Order    float64       `json:"order"`
		Both     struct {
			Entry float64 `json:"entry"`
			Exit  float64 `json:"exit"`
		} `json:"both"`
	} `json:"charges"`
	Evaluations []struct {
		Underlying    string               `json:"underlying"`
		Ref           float64              `json:"ref"`
		EachSide      int                  `json:"eachSide"`
		Kind          string               `json:"kind"`
		Params        EvalParams           `json:"params"`
		Quotes        [][2]json.RawMessage `json:"quotes"`
		Opportunities []string             `json:"opportunities"`
		Sorted        []string             `json:"sorted"`
	} `json:"evaluations"`
}

func loadMathGolden(t *testing.T) *mathGolden {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "math_golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/synthetic/testdata/gen_math.mjs)", err)
	}
	var g mathGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return &g
}

// entries is a Map<number, SynthInstrument> as the generator wrote it: [strike, contract]
// pairs in ascending strike order.
func entries(m map[float64]Contract) [][2]any {
	keys := make([]float64, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Float64s(keys)
	out := make([][2]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, [2]any{k, m[k]})
	}
	return out
}

func chainJSON(c *ChainIndex) []byte {
	b, _ := encodeJS(struct {
		Underlying string    `json:"underlying"`
		Expiry     string    `json:"expiry"`
		LotSize    float64   `json:"lot_size"`
		StrikeStep float64   `json:"strike_step"`
		Future     Contract  `json:"future"`
		Strikes    []float64 `json:"strikes"`
		CE         [][2]any  `json:"ce"`
		PE         [][2]any  `json:"pe"`
	}{c.Underlying, c.Expiry, c.LotSize, c.StrikeStep, c.Future, c.Strikes, entries(c.CE), entries(c.PE)})
	return b
}

func windowJSON(w *Window) []byte {
	if w == nil {
		return []byte("null")
	}
	b, _ := encodeJS(struct {
		Underlying string    `json:"underlying"`
		Name       string    `json:"name"`
		IsIndex    bool      `json:"is_index"`
		Expiry     string    `json:"expiry"`
		LotSize    float64   `json:"lot_size"`
		StrikeStep float64   `json:"strike_step"`
		AtmStrike  float64   `json:"atm_strike"`
		Strikes    []float64 `json:"strikes"`
		Future     Contract  `json:"future"`
		CE         [][2]any  `json:"ce"`
		PE         [][2]any  `json:"pe"`
		RefPrice   float64   `json:"ref_price"`
		WindowAt   int64     `json:"window_at"`
	}{w.Underlying, w.Name, w.IsIndex, w.Expiry, w.LotSize, w.StrikeStep, w.AtmStrike, w.Strikes, w.Future, entries(w.CE),
		entries(w.PE), w.RefPrice, w.WindowAt})
	return b
}

func chainsByName(t *testing.T, raws []json.RawMessage) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for _, r := range raws {
		var c struct {
			Underlying string `json:"underlying"`
		}
		if err := json.Unmarshal(r, &c); err != nil {
			t.Fatal(err)
		}
		out[c.Underlying] = r
	}
	return out
}

func TestMathGoldenUniverseAndWindows(t *testing.T) {
	g := loadMathGolden(t)
	for _, set := range []struct {
		today string
		want  []json.RawMessage
	}{{g.Today, g.Chains}, {"2026-11-25", g.ChainsLater}} {
		got := IndexSyntheticChains(g.Instruments, set.today)
		want := chainsByName(t, set.want)
		if len(got) != len(want) {
			names := []string{}
			for k := range got {
				names = append(names, k)
			}
			t.Fatalf("today %s: chains %v, want %d", set.today, names, len(want))
		}
		for name, c := range got {
			if s := chainJSON(c); string(s) != string(want[name]) {
				t.Errorf("today %s chain %s:\n got %s\nwant %s", set.today, name, s, want[name])
			}
		}
	}
	chains := IndexSyntheticChains(g.Instruments, g.Today)
	for i, w := range g.Windows {
		win := BuildWindow(w.Board, chains[w.Underlying], float64(w.Ref), w.EachSide, g.Now)
		if s := windowJSON(win); string(s) != string(w.Window) {
			t.Errorf("window %d %s ref %v each %d:\n got %s\nwant %s", i, w.Underlying, float64(w.Ref), w.EachSide, s, w.Window)
			continue
		}
		if win != nil && !reflect.DeepEqual(WindowTokens(win), w.Tokens) {
			t.Errorf("window %d tokens %v, want %v", i, WindowTokens(win), w.Tokens)
		}
	}
	for i, r := range g.Rebuild {
		c := chains[r.Underlying]
		win := BuildWindow(BoardItem{Symbol: r.Underlying, Name: r.Underlying}, c, c.Strikes[len(c.Strikes)/2], 2, g.Now)
		if got := WindowNeedsRebuild(win, r.Ref, r.Now, r.Hysteresis, r.MinIntervalMs); got != r.Value {
			t.Errorf("rebuild %d %+v: got %v", i, r, got)
		}
	}
	for _, tf := range g.TokensFor {
		if got := TokensFor(tf[0]); got != tf[1] {
			t.Errorf("TokensFor(%d) = %d, want %d", tf[0], got, tf[1])
		}
	}
	for _, raw := range g.Years {
		var y struct {
			E string
			N int64
			V float64
		}
		var arr []json.RawMessage
		_ = json.Unmarshal(raw, &arr)
		_ = json.Unmarshal(arr[0], &y.E)
		_ = json.Unmarshal(arr[1], &y.N)
		_ = json.Unmarshal(arr[2], &y.V)
		if got := YearsToExpiry(y.E, y.N); got != y.V {
			t.Errorf("YearsToExpiry(%q, %d) = %v, want %v", y.E, y.N, got, y.V)
		}
	}
	for _, raw := range g.Keys {
		var pair [2]json.RawMessage
		_ = json.Unmarshal(raw, &pair)
		var args []json.RawMessage
		_ = json.Unmarshal(pair[0], &args)
		var u, e, d, want string
		var k float64
		_ = json.Unmarshal(args[0], &u)
		_ = json.Unmarshal(args[1], &e)
		_ = json.Unmarshal(args[2], &k)
		_ = json.Unmarshal(args[3], &d)
		_ = json.Unmarshal(pair[1], &want)
		if got := CandidateKey(u, e, k, Direction(d)); got != want {
			t.Errorf("CandidateKey = %q, want %q", got, want)
		}
	}
}

func TestMathGoldenCharges(t *testing.T) {
	g := loadMathGolden(t)
	if len(g.Charges) < 40 {
		t.Fatalf("only %d charge cases", len(g.Charges))
	}
	for i, c := range g.Charges {
		if got := OrderCharges(c.Legs, c.Quantity, g.OptionRates, g.FuturesRates); got != c.Order {
			t.Errorf("charges %d: OrderCharges %v, want %v", i, got, c.Order)
		}
		entry, exit := Charges(c.Legs, c.Quantity, g.OptionRates, g.FuturesRates)
		if entry != c.Both.Entry || exit != c.Both.Exit {
			t.Errorf("charges %d: Charges %v/%v, want %v/%v", i, entry, exit, c.Both.Entry, c.Both.Exit)
		}
	}
}

func TestMathGoldenEvaluateAndSort(t *testing.T) {
	g := loadMathGolden(t)
	chains := IndexSyntheticChains(g.Instruments, g.Today)
	boards := map[string]BoardItem{
		"NIFTY":     {Symbol: "NIFTY", Name: "Nifty 50", IsIndex: true},
		"BANKNIFTY": {Symbol: "BANKNIFTY", Name: "Nifty Bank", IsIndex: true},
		"RELIANCE":  {Symbol: "RELIANCE", Name: "Reliance Industries"},
	}
	total := 0
	for _, e := range g.Evaluations {
		board, ok := boards[e.Underlying]
		if !ok {
			board = BoardItem{Symbol: e.Underlying, Name: e.Underlying}
		}
		w := BuildWindow(board, chains[e.Underlying], e.Ref, e.EachSide, g.Now)
		if w == nil {
			t.Fatalf("%s: no window", e.Underlying)
		}
		quotes := map[int64]*QuoteLike{}
		for _, q := range e.Quotes {
			var tok int64
			var ql QuoteLike
			if err := json.Unmarshal(q[0], &tok); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(q[1], &ql); err != nil {
				t.Fatal(err)
			}
			quotes[tok] = &ql
		}
		p := e.Params
		p.OptionRates, p.FuturesRates = g.OptionRates, g.FuturesRates
		quoteFor := func(tok int64) *QuoteLike { return quotes[tok] }
		var opps []*Opportunity
		for _, strike := range w.Strikes {
			for _, d := range Directions {
				opps = append(opps, EvaluateSynthetic(w, strike, d, quoteFor, p))
			}
		}
		if len(opps) != len(e.Opportunities) {
			t.Fatalf("%s %s: %d opportunities, want %d", e.Underlying, e.Kind, len(opps), len(e.Opportunities))
		}
		for i, o := range opps {
			b, err := encodeJS(o)
			if err != nil {
				t.Fatal(err)
			}
			if string(b) != e.Opportunities[i] {
				t.Errorf("%s %s q=%v rf=%v carry=%v: opportunity %d\n got %s\nwant %s", e.Underlying, e.Kind, p.Quantity, p.RfPct,
					p.IncludeCarry, i, b, e.Opportunities[i])
			}
		}
		sorted := SortOpportunities(append([]*Opportunity(nil), opps...))
		keys := make([]string, len(sorted))
		for i, o := range sorted {
			keys[i] = o.Key
		}
		if !reflect.DeepEqual(keys, e.Sorted) {
			t.Errorf("%s %s: sorted\n got %v\nwant %v", e.Underlying, e.Kind, keys, e.Sorted)
		}
		total += len(opps)
	}
	t.Logf("%d evaluation sets, %d opportunities", len(g.Evaluations), total)
}

func TestMathGoldenISTHelpers(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "math_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		IST []map[string]json.RawMessage `json:"ist"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for i, c := range g.IST {
		var now int64
		_ = json.Unmarshal(c["now"], &now)
		var expiry, today string
		_ = json.Unmarshal(c["expiry"], &expiry)
		_ = json.Unmarshal(c["today"], &today)
		switch {
		case c["safety"] != nil:
			var minutes float64
			var want bool
			_ = json.Unmarshal(c["minutes"], &minutes)
			_ = json.Unmarshal(c["safety"], &want)
			if got := InExpirySafetyWindow(expiry, today, now, minutes); got != want {
				t.Errorf("ist %d: InExpirySafetyWindow(%s,%s,%d,%v) = %v", i, expiry, today, now, minutes, got)
			}
		case c["past"] != nil:
			var open, want bool
			_ = json.Unmarshal(c["open"], &open)
			_ = json.Unmarshal(c["past"], &want)
			if got := IsPastSettlement(expiry, today, now, open); got != want {
				t.Errorf("ist %d: IsPastSettlement(%s,%s,%d,%v) = %v", i, expiry, today, now, open, got)
			}
		default:
			var want int
			_ = json.Unmarshal(c["minutes"], &want)
			if got := ISTMinutesOfDay(now); got != want {
				t.Errorf("ist %d: ISTMinutesOfDay(%d) = %d, want %d", i, now, got, want)
			}
		}
	}
}
