package synthetic

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Part 2 of math_golden.json (gen_math.mjs): the paper-position half of
// src/synthetic/math.ts. Trades are opened from the Go opportunities of the part-1
// evaluation sets (themselves checked against Node by TestMathGoldenEvaluateAndSort).

type tradesGolden struct {
	Now     int64 `json:"now"`
	DepthOf []struct {
		Input *struct {
			Bids *[]market.DepthLevel `json:"bids"`
			Asks *[]market.DepthLevel `json:"asks"`
		} `json:"input"`
		Value json.RawMessage `json:"value"`
	} `json:"depthOf"`
	Trades []struct {
		U         string  `json:"u"`
		Kind      string  `json:"kind"`
		PS        string  `json:"ps"`
		Key       string  `json:"key"`
		ID        string  `json:"id"`
		Broker    string  `json:"broker"`
		WithDepth bool    `json:"withDepth"`
		Opened    *string `json:"opened"`
		Exits     []struct {
			Now          int64                `json:"now"`
			Quotes       [][2]json.RawMessage `json:"quotes"`
			Ltps         [][2]json.RawMessage `json:"ltps"`
			Rules        ExitRules            `json:"rules"`
			ExpirySafety bool                 `json:"expirySafety"`
			Metrics      string               `json:"metrics"`
			Reason       string               `json:"reason"`
			ClosedAt     int64                `json:"closedAt"`
			ClosedDay    string               `json:"closedDay"`
			CloseDepth   bool                 `json:"closeDepth"`
			Closed       *string              `json:"closed"`
		} `json:"exits"`
		Settled string `json:"settled"`
		Margin  string `json:"margin"`
	} `json:"trades"`
	DayPnl []struct {
		Day    string     `json:"day"`
		Open   []OpenMark `json:"open"`
		Closed []string   `json:"closed"`
		Value  string     `json:"value"`
	} `json:"dayPnl"`
}

// depthBook is gen_math.mjs depthBook.
func depthBook(t int64) *Depth {
	if t%3 == 0 {
		return nil
	}
	p := float64(t % 97)
	return DepthOf([]market.DepthLevel{{Price: p, Qty: 75}, {Price: p - 0.05, Qty: 150}}, []market.DepthLevel{{Price: p + 0.05, Qty: 75}}, true)
}

func TestMathGoldenTrades(t *testing.T) {
	g := loadMathGolden(t)
	raw, err := os.ReadFile(filepath.Join("testdata", "math_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tg tradesGolden
	if err := json.Unmarshal(raw, &tg); err != nil {
		t.Fatal(err)
	}

	for i, d := range tg.DepthOf {
		var got *Depth
		if d.Input != nil {
			var bids, asks []market.DepthLevel
			if d.Input.Bids != nil {
				bids = *d.Input.Bids
			}
			if d.Input.Asks != nil {
				asks = *d.Input.Asks
			}
			got = DepthOf(bids, asks, true)
		} else {
			got = DepthOf(nil, nil, false)
		}
		b, _ := encodeJS(got)
		if string(b) != string(d.Value) {
			t.Errorf("depthOf %d:\n got %s\nwant %s", i, b, d.Value)
		}
	}

	// The part-1 evaluation sets, re-evaluated in Go and indexed by key.
	chains := IndexSyntheticChains(g.Instruments, g.Today)
	boards := map[string]BoardItem{
		"NIFTY":     {Symbol: "NIFTY", Name: "Nifty 50", IsIndex: true},
		"BANKNIFTY": {Symbol: "BANKNIFTY", Name: "Nifty Bank", IsIndex: true},
		"RELIANCE":  {Symbol: "RELIANCE", Name: "Reliance Industries"},
	}
	sets := map[string]map[string]*Opportunity{} // "u|kind|paramset" -> key -> opportunity
	setIndex := map[string]int{}
	for _, e := range g.Evaluations {
		board, ok := boards[e.Underlying]
		if !ok {
			board = BoardItem{Symbol: e.Underlying, Name: e.Underlying}
		}
		w := BuildWindow(board, chains[e.Underlying], e.Ref, e.EachSide, g.Now)
		quotes := map[int64]*QuoteLike{}
		for _, q := range e.Quotes {
			var tok int64
			var ql QuoteLike
			_ = json.Unmarshal(q[0], &tok)
			_ = json.Unmarshal(q[1], &ql)
			quotes[tok] = &ql
		}
		p := e.Params
		p.OptionRates, p.FuturesRates = g.OptionRates, g.FuturesRates
		byKey := map[string]*Opportunity{}
		for _, strike := range w.Strikes {
			for _, d := range Directions {
				o := EvaluateSynthetic(w, strike, d, func(tok int64) *QuoteLike { return quotes[tok] }, p)
				byKey[o.Key] = o
			}
		}
		// Parameter sets are written in a fixed order per (underlying, kind).
		base := e.Underlying + "|" + e.Kind
		n := setIndex[base]
		setIndex[base] = n + 1
		sets[base+"|"+[]string{"default", "no carry", "zero rf", "negative rf"}[n]] = byKey
	}

	opened, exits, closes := 0, 0, 0
	for _, tr := range tg.Trades {
		opp := sets[tr.U+"|"+tr.Kind+"|"+tr.PS][tr.Key]
		if opp == nil {
			t.Fatalf("%s: no opportunity %s in set %s|%s|%s", tr.ID, tr.Key, tr.U, tr.Kind, tr.PS)
		}
		var depthFor DepthFunc
		if tr.WithDepth {
			depthFor = depthBook
		}
		trade := OpenTradeFromOpportunity(opp, tr.ID, tr.Broker, g.Now, g.Today, g.OptionRates.RateVersion, g.FuturesRates.RateVersion, depthFor)
		if (trade == nil) != (tr.Opened == nil) {
			t.Fatalf("%s: opened %v, Node opened %v", tr.ID, trade != nil, tr.Opened != nil)
		}
		if trade == nil {
			continue
		}
		opened++
		b, err := encodeJS(trade)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != *tr.Opened {
			t.Fatalf("%s opened:\n got %s\nwant %s", tr.ID, b, *tr.Opened)
		}
		for j, ex := range tr.Exits {
			quotes := map[int64]*QuoteLike{}
			for _, q := range ex.Quotes {
				var tok int64
				var ql QuoteLike
				_ = json.Unmarshal(q[0], &tok)
				_ = json.Unmarshal(q[1], &ql)
				quotes[tok] = &ql
			}
			ltps := map[int64]*float64{}
			for _, l := range ex.Ltps {
				var tok int64
				var v *float64
				_ = json.Unmarshal(l[0], &tok)
				_ = json.Unmarshal(l[1], &v)
				ltps[tok] = v
			}
			m := EvaluateExit(trade, func(tok int64) *QuoteLike { return quotes[tok] }, func(tok int64) *float64 { return ltps[tok] },
				ExitParams{Now: ex.Now, QuoteMaxAgeMs: 2000, ExpirySafety: ex.ExpirySafety, Rules: ex.Rules,
					OptionRates: g.OptionRates, FuturesRates: g.FuturesRates})
			mb, err := encodeJS(m)
			if err != nil {
				t.Fatal(err)
			}
			if string(mb) != ex.Metrics {
				t.Fatalf("%s exit %d metrics:\n got %s\nwant %s", tr.ID, j, mb, ex.Metrics)
			}
			exits++
			var closeDepth DepthFunc
			if ex.CloseDepth {
				closeDepth = depthBook
			}
			closed := CloseTradeAtTouch(trade, m, NullStr(ex.Reason), ex.ClosedAt, ex.ClosedDay, closeDepth)
			if (closed == nil) != (ex.Closed == nil) {
				t.Fatalf("%s exit %d: closed %v, Node closed %v", tr.ID, j, closed != nil, ex.Closed != nil)
			}
			if closed != nil {
				closes++
				cb, _ := encodeJS(closed)
				if string(cb) != *ex.Closed {
					t.Fatalf("%s exit %d closed:\n got %s\nwant %s", tr.ID, j, cb, *ex.Closed)
				}
			}
		}
		sb, _ := encodeJS(SettleTradeAtExpiry(trade, 1795514401000, "2026-11-24")) // Date.parse("2026-11-24T10:00:01Z")
		if string(sb) != tr.Settled {
			t.Fatalf("%s settled:\n got %s\nwant %s", tr.ID, sb, tr.Settled)
		}
		ob, _ := encodeJS(MarginOrders(trade))
		if string(ob) != tr.Margin {
			t.Fatalf("%s margin orders:\n got %s\nwant %s", tr.ID, ob, tr.Margin)
		}
		// The open trade must be untouched by evaluating, closing and settling it.
		if again, _ := encodeJS(trade); string(again) != *tr.Opened {
			t.Fatalf("%s: the open trade changed while it was closed or settled", tr.ID)
		}
	}
	if opened < 50 || closes < 100 {
		t.Fatalf("coverage too thin: %d opened, %d closes", opened, closes)
	}

	for i, d := range tg.DayPnl {
		var closed []*Trade
		for _, s := range d.Closed {
			var tr Trade
			if err := json.Unmarshal([]byte(s), &tr); err != nil {
				t.Fatal(err)
			}
			closed = append(closed, &tr)
		}
		b, _ := encodeJS(ComputeDayPnl(d.Day, d.Open, closed))
		if string(b) != d.Value {
			t.Errorf("day P&L %d:\n got %s\nwant %s", i, b, d.Value)
		}
	}
	t.Logf("%d trades opened, %d exits evaluated, %d closes", opened, exits, closes)
}
