package ratecard_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

func env(kv ...string) config.Getter {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return config.MapGetter(m)
}

type refOrder struct {
	Side          ratecard.Side `json:"side"`
	Tradingsymbol string        `json:"tradingsymbol"`
	Quantity      float64       `json:"quantity"`
	Price         float64       `json:"price"`
}

// TestLegChargesMatchNodeExactly replays 707 cases generated from the original
// src/box/localCharges.ts (testdata/gen_leg_cases.mjs) and requires bit-exact output.
func TestLegChargesMatchNodeExactly(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "leg_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Rates    ratecard.Rates `json:"rates"`
			Order    refOrder       `json:"order"`
			Expected ratecard.Leg   `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 700 {
		t.Fatalf("only %d reference cases", len(f.Cases))
	}
	bad := 0
	for i, c := range f.Cases {
		if got := ratecard.LegCharges(ratecard.Order(c.Order), c.Rates); got != c.Expected {
			bad++
			if bad <= 5 {
				t.Errorf("case %d %+v:\n got  %+v\n want %+v", i, c.Order, got, c.Expected)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("%d of %d cases differ from Node", bad, len(f.Cases))
	}
}

type group struct {
	Legs                                                            []ratecard.Leg
	Value, Brokerage, Stt, ExchangeTxn, Sebi, StampDuty, Gst, Total float64
}

func (g *group) UnmarshalJSON(b []byte) error {
	var v struct {
		Legs        []ratecard.Leg `json:"legs"`
		Value       float64        `json:"value"`
		Brokerage   float64        `json:"brokerage"`
		Stt         float64        `json:"stt"`
		ExchangeTxn float64        `json:"exchange_txn"`
		Sebi        float64        `json:"sebi"`
		StampDuty   float64        `json:"stamp_duty"`
		Gst         float64        `json:"gst"`
		Total       float64        `json:"total"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*g = group{v.Legs, v.Value, v.Brokerage, v.Stt, v.ExchangeTxn, v.Sebi, v.StampDuty, v.Gst, v.Total}
	return nil
}

// price sums legs the way calculateBoxCharges did: each head is round2 of the leg sum.
func price(orders []refOrder, r ratecard.Rates) group {
	var g group
	for _, o := range orders {
		g.Legs = append(g.Legs, ratecard.LegCharges(ratecard.Order(o), r))
	}
	sum := func(f func(ratecard.Leg) float64) float64 {
		var acc float64
		for _, l := range g.Legs {
			acc += f(l)
		}
		return jsx.Round2(acc)
	}
	g.Value = sum(func(l ratecard.Leg) float64 { return l.Value })
	g.Brokerage = sum(func(l ratecard.Leg) float64 { return l.Brokerage })
	g.Stt = sum(func(l ratecard.Leg) float64 { return l.Stt })
	g.ExchangeTxn = sum(func(l ratecard.Leg) float64 { return l.ExchangeTxn })
	g.Sebi = sum(func(l ratecard.Leg) float64 { return l.Sebi })
	g.StampDuty = sum(func(l ratecard.Leg) float64 { return l.StampDuty })
	g.Gst = sum(func(l ratecard.Leg) float64 { return l.Gst })
	g.Total = sum(func(l ratecard.Leg) float64 { return l.Total })
	return g
}

func eq(a, b group) bool {
	if len(a.Legs) != len(b.Legs) {
		return false
	}
	for i := range a.Legs {
		if a.Legs[i] != b.Legs[i] {
			return false
		}
	}
	return a.Value == b.Value && a.Brokerage == b.Brokerage && a.Stt == b.Stt && a.ExchangeTxn == b.ExchangeTxn &&
		a.Sebi == b.Sebi && a.StampDuty == b.StampDuty && a.Gst == b.Gst && a.Total == b.Total
}

// TestGoldenFixtureCharges replays tests/migration-fixtures/box/charges.json.
func TestGoldenFixtureCharges(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "charges.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Name  string `json:"name"`
			Input struct {
				Orders []refOrder     `json:"orders"`
				Rates  ratecard.Rates `json:"rates"`
			} `json:"input"`
			Expected json.RawMessage `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) != 2 {
		t.Fatalf("want 2 cases, got %d", len(f.Cases))
	}
	var entry group
	if err := json.Unmarshal(f.Cases[0].Expected, &entry); err != nil {
		t.Fatal(err)
	}
	if got := price(f.Cases[0].Input.Orders, f.Cases[0].Input.Rates); !eq(got, entry) {
		t.Errorf("%s:\n got  %+v\n want %+v", f.Cases[0].Name, got, entry)
	}

	var rt struct {
		Entry     group   `json:"entry"`
		Exit      group   `json:"estimated_exit"`
		EntryTot  float64 `json:"entry_total"`
		ExitTotal float64 `json:"estimated_exit_total"`
	}
	if err := json.Unmarshal(f.Cases[1].Expected, &rt); err != nil {
		t.Fatal(err)
	}
	in := f.Cases[1].Input
	reversed := append([]refOrder(nil), in.Orders...)
	for i := range reversed {
		if reversed[i].Side == ratecard.Buy {
			reversed[i].Side = ratecard.Sell
		} else {
			reversed[i].Side = ratecard.Buy
		}
	}
	if got := price(in.Orders, in.Rates); !eq(got, rt.Entry) || got.Total != rt.EntryTot {
		t.Errorf("round-trip entry mismatch: %+v", got)
	}
	if got := price(reversed, in.Rates); !eq(got, rt.Exit) || got.Total != rt.ExitTotal {
		t.Errorf("round-trip exit mismatch: %+v", got)
	}
}

// Ported from tests/box/localCharges.test.mjs.
func TestShippedDefaultsAndInvariants(t *testing.T) {
	r := ratecard.Load(env())
	if r.SttSellPct != 0.15 || r.ExchangeTxnPct != 0.03503 || r.IpftPerCrore != 50 || r.SebiPct != 0.0001 ||
		r.StampDutyBuyPct != 0.003 || r.GstPct != 18 || r.BrokeragePerOrder != 20 || !r.SttRoundNearestRupee ||
		r.SttType != "stt" || r.RateVersion != "zerodha-nse-options-2026-04-01" {
		t.Fatalf("defaults: %+v", r)
	}
	sell := ratecard.LegCharges(ratecard.Order{Side: ratecard.Sell, Tradingsymbol: "X", Quantity: 75, Price: 300}, r)
	buy := ratecard.LegCharges(ratecard.Order{Side: ratecard.Buy, Tradingsymbol: "X", Quantity: 75, Price: 300}, r)
	if sell.Stt != jsx.Round(22500*0.0015) || sell.Stt == jsx.Round2(22500*0.0015) || sell.SttType != "stt" {
		t.Errorf("sell STT must be rupee-rounded: %+v", sell)
	}
	if buy.Stt != 0 || buy.SttType != "" || buy.StampDuty != jsx.Round2(22500*0.00003) || sell.StampDuty != 0 {
		t.Errorf("side-only heads: buy=%+v sell=%+v", buy, sell)
	}
	if buy.Brokerage != 20 || buy.Gst != jsx.Round2((buy.Brokerage+buy.ExchangeTxn+buy.Sebi)*0.18) {
		t.Errorf("brokerage/gst: %+v", buy)
	}
	if ratecard.IPFT(22500, r) <= 0 {
		t.Error("IPFT must be billed")
	}
	if ratecard.IPFT(10_000_000, ratecard.Load(env("BOX_IPFT_PER_CRORE", "50"))) != 50 {
		t.Error("₹50 per crore on ₹1 crore is ₹50")
	}
	for _, side := range []ratecard.Side{ratecard.Buy, ratecard.Sell} {
		for _, p := range []float64{1.5, 105, 300.25, 999.9} {
			l := ratecard.LegCharges(ratecard.Order{Side: side, Tradingsymbol: "X", Quantity: 75, Price: p}, r)
			if l.Total != jsx.Round2(l.Brokerage+l.Stt+l.ExchangeTxn+l.Sebi+l.StampDuty+l.Gst) {
				t.Errorf("%s@%v: total must equal summed heads", side, p)
			}
		}
	}
	if ratecard.RoundStt(22.5, ratecard.Rates{SttRoundNearestRupee: true}) != 23 || ratecard.RoundStt(22.5, ratecard.Rates{}) != 22.5 {
		t.Error("RoundStt modes")
	}
	low := ratecard.LegCharges(ratecard.Order{Side: ratecard.Sell, Tradingsymbol: "X", Quantity: 75, Price: 300},
		ratecard.Load(env("BOX_STT_SELL_PCT", "0.05")))
	if low.Stt != 11 { // 0.05% of 22,500 = 11.25 → 11
		t.Errorf("env override: STT = %v", low.Stt)
	}
}
