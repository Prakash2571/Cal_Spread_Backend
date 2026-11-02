package registry

// Ports of the tests/box/dhanMarginAndIp.test.mjs cases the margin and routes goldens did
// not assert. The Dhan client is the real one over the loopback fakeDhan (newUnitRig);
// Node stubbed calculateMultiMargin / calculateMargin / getStaticIp instead.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// nodeBoxOrders is the suite's BOX_ORDERS.
func nodeBoxOrders() []market.MarginOrder {
	mk := func(sym, side string, price float64) market.MarginOrder {
		return market.MarginOrder{Exchange: "NFO", Tradingsymbol: sym, TransactionType: side, Variety: "regular",
			Product: "NRML", OrderType: "MARKET", Quantity: 275, Price: price}
	}
	return []market.MarginOrder{
		mk("ASTRAL25SEP2500CE", "BUY", 50), mk("ASTRAL25SEP2520CE", "SELL", 30),
		mk("ASTRAL25SEP2520PE", "BUY", 40), mk("ASTRAL25SEP2500PE", "SELL", 20),
	}
}

// seedBoxLegs is marginManager's seeded instrument store: every leg resolves.
func seedBoxLegs(u *unitRig) {
	var rows []dhan.Instrument
	for i, o := range nodeBoxOrders() {
		rows = append(rows, dhan.Instrument{
			Instrument:     market.Instrument{InstrumentToken: 2_000_045_000 + int64(i), Exchange: "NFO", Tradingsymbol: o.Tradingsymbol},
			DhanSegment:    dhan.Segment("NSE_FNO"),
			DhanSecurityID: 45000 + int64(i),
		})
	}
	u.reg.DhanInstrumentStore().SetInstruments(rows)
}

func countOut(lines []string, prefix string) int {
	n := 0
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

const (
	multiReq  = "api POST /margincalculator/multi "
	perLegReq = "api POST /margincalculator "
)

// "the netting flags are always explicit, and default to false"
func TestNodeMultiMarginNettingFlagsAreExplicit(t *testing.T) {
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"api POST /margincalculator/multi": {{Status: 200, Body: json.RawMessage(`{"totalMargin":41250}`)}},
	})
	u.activateDhan("tok")
	oneLeg := dhan.MarginLeg{ExchangeSegment: dhan.Segment("NSE_FNO"), TransactionType: "BUY", Quantity: 275,
		ProductType: "MARGIN", SecurityID: "45000", Price: 50}
	body := func(opts dhan.MultiMarginOptions) map[string]any {
		t.Helper()
		if _, err := u.reg.DhanClient().CalculateMultiMargin(context.Background(), []dhan.MarginLeg{oneLeg}, opts); err != nil {
			t.Fatal(err)
		}
		out := u.dhan.takeOut()
		if len(out) != 1 || !strings.HasPrefix(out[0], multiReq) {
			t.Fatalf("requests %q", out)
		}
		parts := strings.SplitN(out[0], " ", 5) // host method path headers body
		var b map[string]any
		if err := json.Unmarshal([]byte(parts[4]), &b); err != nil {
			t.Fatalf("body %q: %v", parts[4], err)
		}
		return b
	}
	if b := body(dhan.MultiMarginOptions{}); b["includePosition"] != false || b["includeOrder"] != false {
		t.Errorf("defaults: %v", b)
	}
	if b := body(dhan.MultiMarginOptions{IncludePosition: true}); b["includePosition"] != true || b["includeOrder"] != false {
		t.Errorf("{includePosition: true}: %v", b)
	}
}

func fallbackRig(t *testing.T) *unitRig {
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"api POST /margincalculator/multi": {{Status: 500, Body: json.RawMessage(`{"errorType":"Server","errorMessage":"multi endpoint unavailable"}`)}},
		"api POST /margincalculator":       {{Status: 200, Body: json.RawMessage(`{"totalMargin":50000,"spanMargin":40000}`)}},
	})
	u.activateDhan("tok")
	seedBoxLegs(u)
	return u
}

// "a FAILED multi call falls back to the per-leg sum, clearly labelled"
func TestNodeFailedMultiFallsBackToThePerLegSum(t *testing.T) {
	u := fallbackRig(t)
	res, err := u.reg.Margins().BasketMargin(context.Background(), nodeBoxOrders(), false)
	if err != nil {
		t.Fatal(err)
	}
	out := u.dhan.takeOut()
	if n := countOut(out, multiReq); n != 1 {
		t.Errorf("%d multi calls, want 1", n)
	}
	if n := countOut(out, perLegReq); n != 4 {
		t.Errorf("%d per-leg calls, want 4: every leg was priced individually", n)
	}
	if res.Source != market.MarginDhanPerLegFallback {
		t.Errorf("source %q", res.Source)
	}
	if res.HedgeBenefit != nil {
		t.Errorf("hedge_benefit = %v, want null: no benefit is recognised in this path", *res.HedgeBenefit)
	}
	if res.Exposure != nil {
		t.Errorf("exposure = %v, want null", *res.Exposure)
	}
}

// "the fallback is CONSERVATIVE — it can never understate the requirement"
func TestNodeFallbackIsConservative(t *testing.T) {
	ctx := context.Background()
	fallback, err := fallbackRig(t).reg.Margins().BasketMargin(ctx, nodeBoxOrders(), false)
	if err != nil {
		t.Fatal(err)
	}
	u2 := newUnitRig(t, nil, map[string][]httpSpec{"api POST /margincalculator/multi": {{Status: 200,
		Body: json.RawMessage(`{"totalMargin":41250,"spanMargin":30000,"exposureMargin":11250,"marginBenefit":158750}`)}}})
	u2.activateDhan("tok")
	seedBoxLegs(u2)
	hedged, err := u2.reg.Margins().BasketMargin(ctx, nodeBoxOrders(), false)
	if err != nil {
		t.Fatal(err)
	}
	if hedged.Source != market.MarginDhanMulti || hedged.Total != 41250 {
		t.Fatalf("hedged %+v", hedged)
	}
	if fallback.Total < hedged.Total {
		t.Errorf("fallback %v must be >= hedge-adjusted %v", fallback.Total, hedged.Total)
	}
	if fallback.Total != 200_000 {
		t.Errorf("fallback total %v, want 200000", fallback.Total)
	}
}

// "a configured IP that has NOT been verified yet is NOT ready"
func TestNodeConfiguredButUnverifiedIPIsNotReady(t *testing.T) {
	u := newUnitRig(t, nil, nil)
	u.env.set("DHAN_STATIC_PUBLIC_IP", "203.0.113.7")
	u.env.set("DHAN_STATIC_IP_EXPECTED", "true")
	u.activateDhan("tok")
	if st := u.reg.DhanStaticIPState(); st.APIVerified != nil {
		t.Errorf("api_verified = %v, want null (never checked)", *st.APIVerified)
	}
	if u.reg.DhanStaticIPReady() {
		t.Error("a configured but unverified IP must not be ready")
	}
}

// "verification without a Dhan session fails closed"
func TestNodeVerificationWithoutASessionFailsClosed(t *testing.T) {
	u := newUnitRig(t, nil, nil)
	u.env.set("DHAN_STATIC_PUBLIC_IP", "203.0.113.7")
	u.reg.state.Store(&brokerState{active: brokers.Dhan, gen: 3}) // activateDhan(m) without a session
	res := u.reg.VerifyDhanStaticIP(context.Background())
	if res.Verified {
		t.Error("verified without a session")
	}
	if res.Error == nil || !strings.Contains(*res.Error, "without a Dhan session") {
		t.Errorf("error = %v, want /without a Dhan session/", res.Error)
	}
	if n := countOut(u.dhan.takeOut(), "api GET /ip/getIP"); n != 0 {
		t.Errorf("%d getIP calls without a session", n)
	}
}
