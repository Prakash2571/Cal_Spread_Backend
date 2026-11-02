package calendar

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Pure helpers against testdata/helpers.golden.json, recorded from the original
// index.ts functions. Results are compared as exact JSON.stringify text.

func TestHelpersGoldenRound2(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	n := 0
	for _, c := range g.Get("round2").Elems() {
		ins, outs := c.Get("in").Elems(), c.Get("out").Elems()
		if len(ins) != len(outs) || len(ins) == 0 {
			t.Fatalf("round2 case: %d inputs, %d outputs", len(ins), len(outs))
		}
		for i, in := range ins {
			x := gnum(in)
			if got, want := outNum(round2(x), true), outs[i].Str(); got != want {
				t.Errorf("round2(%v) = %s, Node %s", x, got, want)
			}
			n++
		}
	}
	t.Logf("%d round2 values", n)
}

func TestHelpersGoldenBestPrice(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	cases := g.Get("bestPrice").Elems()
	for i, c := range cases {
		levels := gLevels(c.Get("levels"))
		best, ok := bestPrice(levels, c.Get("side").Str())
		if got, want := outNum(best, ok), c.Get("out").Str(); got != want {
			t.Errorf("case %d bestPrice(%v, %s) = %s, Node %s", i, levels, c.Get("side").Str(), got, want)
		}
	}
	if len(cases) < 100 {
		t.Fatalf("only %d bestPrice cases", len(cases))
	}
}

func TestHelpersGoldenToLegCharges(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	cases := g.Get("toLegCharges").Elems()
	for i, c := range cases {
		got := marshal(toLegCharges(gChargeLeg(c.Get("leg")), gOrderCharges(c.Get("oc"), false)))
		if want := c.Get("out").Str(); got != want {
			t.Errorf("case %d toLegCharges:\n got %s\nwant %s", i, got, want)
		}
	}
	if len(cases) < 100 {
		t.Fatalf("only %d toLegCharges cases", len(cases))
	}
}

func TestHelpersGoldenAggregateAndTotals(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	for i, c := range g.Get("aggregateCharges").Elems() {
		var legs []LegCharges
		for _, l := range c.Get("legs").Elems() {
			legs = append(legs, gLegCharges(l))
		}
		at := time.UnixMilli(int64(c.Get("now").Num())).UTC()
		got := marshal(aggregateCharges(legs, c.Get("source").Str(), at))
		if want := c.Get("out").Str(); got != want {
			t.Errorf("case %d aggregateCharges:\n got %s\nwant %s", i, got, want)
		}
	}
	for i, c := range g.Get("chargeTotals").Elems() {
		got := marshal(chargeTotals(gTradeCharges(c.Get("in"))))
		if want := c.Get("out").Str(); got != want {
			t.Errorf("case %d chargeTotals: got %s want %s", i, got, want)
		}
	}
}

func TestHelpersGoldenLegLists(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	for i, c := range g.Get("unpricedLogLegs").Elems() {
		if got, want := marshal(unpricedLogLegs(gChargeLegs(c.Get("legs")))), c.Get("out").Str(); got != want {
			t.Errorf("case %d unpricedLogLegs:\n got %s\nwant %s", i, got, want)
		}
	}
	for i, c := range g.Get("reverseLegs").Elems() {
		if got, want := marshal(reverseLegs(gChargeLegs(c.Get("legs")))), c.Get("out").Str(); got != want {
			t.Errorf("case %d reverseLegs:\n got %s\nwant %s", i, got, want)
		}
	}
}

func TestHelpersGoldenSerializeTrade(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	for i, c := range g.Get("serializeTrade").Elems() {
		if got, want := marshal(serializeTrade(gTrade(t, c.Get("doc")))), c.Get("out").Str(); got != want {
			t.Errorf("case %d serializeTrade:\n got %s\nwant %s", i, got, want)
		}
	}
}

// chargesKite is a Kite whose /charges/orders answer is scripted.
type chargesKite struct {
	noSessionKite
	requested *string
	rows      []kite.OrderCharges
	err       error
}

func (k *chargesKite) GetOrderCharges(_ context.Context, orders []kite.ChargeOrder) ([]kite.OrderCharges, error) {
	text := marshal(orders)
	k.requested = &text
	return k.rows, k.err
}

type logSink struct {
	mu   sync.Mutex
	msgs []string
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.msgs = append(l.msgs, fmt.Sprintf(format, args...))
}

func (l *logSink) take() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.msgs
	l.msgs = nil
	return out
}

// checkWarns compares Go log lines with Node's console.warn first arguments: each Node
// text must start the Go line at the same position.
func checkWarns(t *testing.T, ctx string, node []*kitejson.Value, goLines []string) {
	t.Helper()
	if len(node) != len(goLines) {
		t.Errorf("%s: %d warnings, Node %d: %q", ctx, len(goLines), len(node), goLines)
		return
	}
	for i, w := range node {
		if want := strings.TrimSuffix(w.Str(), ":"); !strings.HasPrefix(goLines[i], want) {
			t.Errorf("%s: warning %d = %q, Node %q", ctx, i, goLines[i], w.Str())
		}
	}
}

type pricedJSON struct {
	Charges *TradeCharges `json:"charges"`
	LogLegs []LogLeg      `json:"logLegs"`
}

func TestHelpersGoldenPriceChargeGroups(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	for i, c := range g.Get("priceChargeGroups").Elems() {
		var groups []chargeGroup
		for _, gr := range c.Get("groups").Elems() {
			groups = append(groups, chargeGroup{legs: gChargeLegs(gr.Get("legs")), source: gr.Get("source").Str()})
		}
		k := &chargesKite{}
		if c.Get("how").Str() == "throws" {
			k.err = &kite.KiteError{Status: 503, Message: "Charges API is unavailable."}
		}
		if rows := c.Get("rows"); !rows.Nullish() {
			k.rows = []kite.OrderCharges{}
			for _, row := range rows.Elems() {
				k.rows = append(k.rows, gOrderCharges(row, true))
			}
		}
		now := time.UnixMilli(int64(c.Get("now").Num())).UTC()
		logs := &logSink{}
		s := New(Deps{Kite: k, Now: func() time.Time { return now }, Logf: logs.logf})
		priced := s.priceChargeGroups(context.Background(), groups)
		got := "null"
		if priced != nil {
			out := make([]pricedJSON, len(priced))
			for j, p := range priced {
				out[j] = pricedJSON{Charges: p.charges, LogLegs: p.logLegs}
			}
			got = marshal(out)
		}
		ctx := fmt.Sprintf("case %d (%s)", i, c.Get("how").Str())
		if want := c.Get("out").Str(); got != want {
			t.Errorf("%s priceChargeGroups:\n got %s\nwant %s", ctx, got, want)
		}
		switch req := c.Get("requested"); {
		case req.Nullish() && k.requested != nil:
			t.Errorf("%s: Go called /charges/orders, Node did not", ctx)
		case !req.Nullish() && (k.requested == nil || *k.requested != req.Str()):
			t.Errorf("%s: requested orders differ:\n got %v\nwant %s", ctx, k.requested, req.Str())
		}
		checkWarns(t, ctx, c.Get("warns").Elems(), logs.take())
	}
}

// ladderKite is a Kite whose /quote ladders are scripted.
type ladderKite struct {
	noSessionKite
	called bool
	ids    []string
	rest   map[int64]kite.QuoteLadder
	err    error
}

func (k *ladderKite) GetQuoteLadder(_ context.Context, ids []string) (map[int64]kite.QuoteLadder, error) {
	k.called = true
	k.ids = ids
	return k.rest, k.err
}

// fakeHub serves scripted books and records the tokens asked for.
type fakeHub struct {
	mu     sync.Mutex
	books  map[int64]hub.Ladder
	calls  []int64
	badAge []int64
}

func (h *fakeHub) GetFreshLadder(token int64, maxAgeMs int64) (hub.Ladder, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, token)
	if maxAgeMs != 5000 {
		h.badAge = append(h.badAge, maxAgeMs)
	}
	l, ok := h.books[token]
	return l, ok
}

func gBooks(v *kitejson.Value) map[int64]hub.Ladder {
	out := map[int64]hub.Ladder{}
	for _, k := range v.Keys() {
		var tk int64
		fmt.Sscan(k, &tk)
		out[tk] = gLadder(v.Get(k))
	}
	return out
}

type levelJSON struct {
	Price float64 `json:"price"`
	Qty   float64 `json:"qty"`
}

type ladderJSON struct {
	Last float64     `json:"last"`
	Bids []levelJSON `json:"bids"`
	Asks []levelJSON `json:"asks"`
}

func ladderOut(m map[int64]ladder) string {
	tokens := make([]int64, 0, len(m))
	for tk := range m {
		tokens = append(tokens, tk)
	}
	sort.Slice(tokens, func(i, j int) bool { return tokens[i] < tokens[j] })
	lv := func(ls []market.DepthLevel) []levelJSON {
		out := []levelJSON{}
		for _, l := range ls {
			out = append(out, levelJSON{l.Price, l.Qty})
		}
		return out
	}
	rows := make([][2]any, len(tokens))
	for i, tk := range tokens {
		l := m[tk]
		rows[i] = [2]any{tk, ladderJSON{Last: l.last, Bids: lv(l.bids), Asks: lv(l.asks)}}
	}
	return marshal(rows)
}

func TestHelpersGoldenResolveLadder(t *testing.T) {
	g := loadGolden(t, "testdata/helpers.golden.json")
	for i, c := range g.Get("resolveLadder").Elems() {
		ctx := fmt.Sprintf("case %d", i)
		h := &fakeHub{books: gBooks(c.Get("hub"))}
		k := &ladderKite{rest: map[int64]kite.QuoteLadder{}}
		rest := c.Get("rest")
		if e := rest.Get("error"); !e.Nullish() {
			k.err = gError(e)
		} else {
			for tk, l := range gBooks(rest) {
				k.rest[tk] = kite.QuoteLadder{Last: l.Last, Bids: l.Bids, Asks: l.Asks}
			}
		}
		universe := gInstruments(t, c.Get("universe"))
		calls := 0
		var uErr error
		if e := c.Get("universeError"); !e.Nullish() {
			uErr = gError(e)
		}
		s := New(Deps{Hub: h, Kite: k, Instruments: func(context.Context) ([]market.Instrument, error) {
			calls++
			if uErr != nil {
				return nil, uErr
			}
			return universe, nil
		}})
		var tokens []int64
		for _, tk := range c.Get("tokens").Elems() {
			tokens = append(tokens, gint(tk))
		}
		out, err := s.resolveLadder(context.Background(), tokens)
		if e := c.Get("error"); !e.Nullish() {
			if err == nil {
				t.Errorf("%s: no error, Node threw %s", ctx, e.Get("message").Str())
			} else if err.Error() != e.Get("message").Str() || (e.Get("name").Str() == "KiteError") != isKite(err) {
				t.Errorf("%s: error %v, Node %s %q", ctx, err, e.Get("name").Str(), e.Get("message").Str())
			}
		} else if err != nil {
			t.Errorf("%s: error %v", ctx, err)
		} else if got, want := ladderOut(out), c.Get("out").Str(); got != want {
			t.Errorf("%s resolveLadder:\n got %s\nwant %s", ctx, got, want)
		}
		if ids := c.Get("ids"); ids.Nullish() != !k.called {
			t.Errorf("%s: getQuoteLadder called=%v, Node ids=%s", ctx, k.called, kitejson.Marshal(ids))
		} else if !ids.Nullish() && marshal(k.ids) != string(kitejson.Marshal(ids)) {
			t.Errorf("%s: ids %v, Node %s", ctx, k.ids, kitejson.Marshal(ids))
		}
		if got, want := marshal(h.calls), string(kitejson.Marshal(c.Get("hubCalls"))); got != want {
			t.Errorf("%s: hub calls %s, Node %s", ctx, got, want)
		}
		if got := float64(calls); got != c.Get("instrumentCalls").Num() {
			t.Errorf("%s: %d instrument loads, Node %v", ctx, calls, c.Get("instrumentCalls").Num())
		}
		if len(h.badAge) > 0 {
			t.Errorf("%s: getFreshLadder max ages %v, want 5000", ctx, h.badAge)
		}
	}
}

func isKite(err error) bool { _, ok := kite.AsKiteError(err); return ok }

// The JSON encoder must write what JSON.stringify writes for the values the helpers
// produce; a direct check on the trickiest ones.
func TestEncodingOfSpecialNumbers(t *testing.T) {
	c := aggregateCharges([]LegCharges{{Side: "BUY", Value: math.NaN(), Total: math.Copysign(0, -1)}}, "kite", time.UnixMilli(1).UTC())
	got := string(jsjson.Marshal(c))
	want := `{"legs":[{"side":"BUY","tradingsymbol":"","quantity":0,"price":0,"value":null,"brokerage":0,"stt":0,"stt_type":"","exchange_txn":0,"sebi":0,"stamp_duty":0,"gst":0,"total":0}],"value":null,"brokerage":0,"stt":0,"exchange_txn":0,"sebi":0,"stamp_duty":0,"gst":0,"total":0,"source":"kite","at":"1970-01-01T00:00:00.001Z"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if jsx.ISO(time.UnixMilli(1790000000123)) != "2026-09-21T14:13:20.123Z" {
		t.Fatal("ISO format")
	}
}
