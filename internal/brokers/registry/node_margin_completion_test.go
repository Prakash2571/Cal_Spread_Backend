package registry

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func nodeMultiBody(t *testing.T, lines []string) map[string]any {
	t.Helper()
	for _, line := range lines {
		if !strings.HasPrefix(line, multiReq) {
			continue
		}
		parts := strings.SplitN(line, " ", 5)
		var body map[string]any
		if len(parts) != 5 || json.Unmarshal([]byte(parts[4]), &body) != nil {
			t.Fatalf("unreadable multi-margin request: %q", line)
		}
		return body
	}
	t.Fatalf("no multi-margin request in %q", lines)
	return nil
}

// The three missing wire assertions in tests/box/dhanMarginAndIp.test.mjs:
// "the multi-margin request sends its legs under `scripList`",
// "dhanClientId is sent ONCE at the top level, never repeated per leg", and
// "the body carries exactly Dhan's four fields and nothing more".
func TestNodeMultiMarginExactWireContract(t *testing.T) {
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"api POST /margincalculator/multi": {{Status: 200, Body: json.RawMessage(`{"totalMargin":41250}`)}},
	})
	token := "tok"
	u.reg.setDhanSession(&token, nil, &dhanMeta{clientID: "CLIENT7"})
	leg := dhan.MarginLeg{ExchangeSegment: "NSE_FNO", TransactionType: "BUY", Quantity: 275,
		ProductType: "MARGIN", SecurityID: "45000", Price: 50}
	if _, err := u.reg.DhanClient().CalculateMultiMargin(context.Background(), []dhan.MarginLeg{leg}, dhan.MultiMarginOptions{}); err != nil {
		t.Fatal(err)
	}
	lines := u.dhan.takeOut()
	if len(lines) != 1 || !strings.HasPrefix(lines[0], multiReq) {
		t.Fatalf("want exactly one POST /margincalculator/multi: %q", lines)
	}
	got := nodeMultiBody(t, lines)
	var want map[string]any
	if err := json.Unmarshal([]byte(`{"dhanClientId":"CLIENT7","includePosition":false,"includeOrder":false,"scripList":[{"exchangeSegment":"NSE_FNO","transactionType":"BUY","quantity":275,"productType":"MARGIN","securityId":"45000","price":50}]}`), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("multi-margin body = %#v, want %#v", got, want)
	}
}

func nodeBasketRig(t *testing.T, multi, perLeg httpSpec) *unitRig {
	t.Helper()
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"api POST /margincalculator/multi": {multi},
		"api POST /margincalculator":       {perLeg},
	})
	u.activateDhan("tok")
	seedBoxLegs(u)
	return u
}

// The original suite sends FOUR ASTRAL legs. The registry golden sent three
// BHEL legs; it could not prove that every leg and direction survived together.
func TestNodeFourLegBasketMarginContract(t *testing.T) {
	u := nodeBasketRig(t,
		httpSpec{Status: 200, Body: json.RawMessage(`{"totalMargin":41250,"spanMargin":30000,"exposureMargin":11250,"marginBenefit":158750}`)},
		httpSpec{Status: 200, Body: json.RawMessage(`{"totalMargin":50000,"spanMargin":40000}`)})
	res, err := u.reg.Margins().BasketMargin(context.Background(), nodeBoxOrders(), false)
	if err != nil {
		t.Fatal(err)
	}
	lines := u.dhan.takeOut()
	if countOut(lines, multiReq) != 1 || countOut(lines, perLegReq) != 0 || res.Source != market.MarginDhanMulti {
		t.Fatalf("multi-order must be preferred: %+v, requests %q", res, lines)
	}
	legs, ok := nodeMultiBody(t, lines)["scripList"].([]any)
	if !ok || len(legs) != 4 {
		t.Fatalf("all FOUR legs must be sent in one request: %#v", legs)
	}
	for i, raw := range legs {
		leg, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("leg %d is not an object: %#v", i, raw)
		}
		if leg["transactionType"] != []string{"BUY", "SELL", "BUY", "SELL"}[i] {
			t.Errorf("leg %d direction = %v", i, leg["transactionType"])
		}
		price, isNumber := leg["price"].(float64)
		if leg["productType"] != "MARGIN" || leg["exchangeSegment"] != "NSE_FNO" || leg["quantity"] != float64(275) || !isNumber || !(price > 0) {
			t.Errorf("leg %d must retain its carry-forward contract: %#v", i, leg)
		}
	}
	if res.Total != 41250 || res.Span == nil || *res.Span != 30000 || res.Exposure == nil || *res.Exposure != 11250 || res.HedgeBenefit == nil || *res.HedgeBenefit != 158750 {
		t.Fatalf("hedge-adjusted totals and benefit must be preserved: %+v", res)
	}
	if !(res.Total < 200_000) {
		t.Fatalf("hedged margin %v must be below the per-leg sum", res.Total)
	}
}

func TestNodeBasketMarginReferencePricesAndZeroPriceFallback(t *testing.T) {
	for _, tc := range []struct {
		title     string
		reference *float64
	}{
		{"the REAL per-leg price is preferred over the order price", func() *float64 { n := 12.5; return &n }()},
		{"a zero-priced leg is never sent, because Dhan rejects one", nil},
	} {
		t.Run(tc.title, func(t *testing.T) {
			u := nodeBasketRig(t,
				httpSpec{Status: 200, Body: json.RawMessage(`{"totalMargin":41250}`)},
				httpSpec{Status: 200, Body: json.RawMessage(`{"totalMargin":50000}`)})
			orders := nodeBoxOrders()
			for i := range orders {
				orders[i].Price, orders[i].ReferencePrice = 0, tc.reference
			}
			if _, err := u.reg.Margins().BasketMargin(context.Background(), orders, false); err != nil {
				t.Fatal(err)
			}
			legs := nodeMultiBody(t, u.dhan.takeOut())["scripList"].([]any)
			if len(legs) != 4 {
				t.Fatalf("got %d legs, want four", len(legs))
			}
			for i, raw := range legs {
				price, ok := raw.(map[string]any)["price"].(float64)
				if !ok || !(price > 0) || (tc.reference != nil && price != 12.5) {
					t.Errorf("leg %d: price %v must use a positive reference", i, price)
				}
			}
		})
	}
}

func TestNodeBasketMarginUnreadableAndUnpricedResponses(t *testing.T) {
	t.Run("an unreadable multi response falls back rather than recording zero", func(t *testing.T) {
		u := nodeBasketRig(t, httpSpec{Status: 200, Body: json.RawMessage(`{}`)},
			httpSpec{Status: 200, Body: json.RawMessage(`{"totalMargin":50000,"spanMargin":40000}`)})
		res, err := u.reg.Margins().BasketMargin(context.Background(), nodeBoxOrders(), false)
		if err != nil || countOut(u.dhan.takeOut(), perLegReq) != 4 || res.Source != market.MarginDhanPerLegFallback || !(res.Total > 0) {
			t.Fatalf("unreadable multi must fall back for every leg: %+v, %v", res, err)
		}
	})
	t.Run("when NOTHING can be priced the result is `unavailable`, not zero margin", func(t *testing.T) {
		u := nodeBasketRig(t, httpSpec{Status: 500, Body: json.RawMessage(`{"errorMessage":"multi endpoint unavailable"}`)},
			httpSpec{Status: 500, Body: json.RawMessage(`{"errorMessage":"per-leg unavailable"}`)})
		res, err := u.reg.Margins().BasketMargin(context.Background(), nodeBoxOrders(), false)
		if err != nil || res.Source != market.MarginUnavailable || res.Total != 0 {
			t.Fatalf("no priced result must remain explicitly unavailable: %+v, %v", res, err)
		}
	})
	t.Run("Zerodha still uses its own basket API, labelled kite_basket", func(t *testing.T) {
		u := newUnitRig(t, nil, nil)
		res, err := u.reg.Margins().BasketMargin(context.Background(), nodeBoxOrders(), false)
		if err != nil || res.Source != market.MarginKiteBasket || countOut(u.dhan.takeOut(), multiReq) != 0 {
			t.Fatalf("Zerodha must use its own basket API: %+v, %v", res, err)
		}
	})
}
