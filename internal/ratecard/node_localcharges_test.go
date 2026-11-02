package ratecard_test

// Ports of the tests/box/localCharges.test.mjs cases whose assertions
// TestShippedDefaultsAndInvariants made only in part. The Node assertions are formulas
// over the leg; each is asserted as written, plus the value the ORIGINAL TypeScript
// returned for these inputs (scratch/go-migration/tmp/port/record_values.mjs).

import (
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

// "STT rounding is centralised in roundStt and honours the mode flag"
func TestNodeSttRoundingHonoursTheModeFlag(t *testing.T) {
	nearestRupee, paise := ratecard.Rates{SttRoundNearestRupee: true}, ratecard.Rates{SttRoundNearestRupee: false}
	if got := ratecard.RoundStt(22.5, nearestRupee); got != 23 {
		t.Errorf("roundStt(22.5, rupee) = %v, want 23", got)
	}
	if got := ratecard.RoundStt(22.49, nearestRupee); got != 22 {
		t.Errorf("roundStt(22.49, rupee) = %v, want 22", got)
	}
	if got := ratecard.RoundStt(22.5, paise); got != 22.5 {
		t.Errorf("roundStt(22.5, paise) = %v, want 22.5", got)
	}
}

// "brokerage is a flat ₹20 per order and GST is 18% of (brokerage+exchange+SEBI)"
func TestNodeBrokerageFlatAndGstOnBrokerageExchangeSebi(t *testing.T) {
	r := ratecard.Load(env())
	const value = 75 * 300.0
	leg := ratecard.LegCharges(ratecard.Order{Side: ratecard.Buy, Tradingsymbol: "X", Quantity: 75, Price: 300}, r)
	if leg.Brokerage != 20 {
		t.Errorf("brokerage = %v", leg.Brokerage)
	}
	if want := jsx.Round2(value*(r.ExchangeTxnPct/100) + ratecard.IPFT(value, r)); leg.ExchangeTxn != want || leg.ExchangeTxn != 7.99 {
		t.Errorf("exchange_txn = %v, want round2(value*pct/100 + ipftFor) = %v (Node: 7.99)", leg.ExchangeTxn, want)
	}
	if want := jsx.Round2(value * (r.SebiPct / 100)); leg.Sebi != want || leg.Sebi != 0.02 {
		t.Errorf("sebi = %v, want %v (Node: 0.02)", leg.Sebi, want)
	}
	if want := jsx.Round2((leg.Brokerage + leg.ExchangeTxn + leg.Sebi) * 0.18); leg.Gst != want || leg.Gst != 5.04 {
		t.Errorf("gst = %v, want %v (Node: 5.04)", leg.Gst, want)
	}
}

// "IPFT is modelled as ₹ per crore of premium and folded into the exchange head"
func TestNodeIpftPerCroreFoldsIntoTheExchangeHead(t *testing.T) {
	r := ratecard.Load(env("BOX_IPFT_PER_CRORE", "50"))
	const value = 10_000_000.0 // ₹1 crore of premium
	if got := ratecard.IPFT(value, r); got != 50 {
		t.Errorf("ipftFor(1e7) = %v, want 50", got)
	}
	leg := ratecard.LegCharges(ratecard.Order{Side: ratecard.Buy, Tradingsymbol: "X", Quantity: 1, Price: value}, r)
	if want := jsx.Round2(value*(r.ExchangeTxnPct/100) + 50); leg.ExchangeTxn != want || leg.ExchangeTxn != 3553 {
		t.Errorf("exchange_txn = %v, want %v (Node: 3553)", leg.ExchangeTxn, want)
	}
}

// "no charge head is ever negative, and IPFT is now actually billed"
func TestNodeNoChargeHeadIsNegative(t *testing.T) {
	r := ratecard.Load(env())
	leg := ratecard.LegCharges(ratecard.Order{Side: ratecard.Sell, Tradingsymbol: "X", Quantity: 75, Price: 300}, r)
	for name, v := range map[string]float64{
		"quantity": leg.Quantity, "price": leg.Price, "value": leg.Value, "brokerage": leg.Brokerage, "stt": leg.Stt,
		"exchange_txn": leg.ExchangeTxn, "sebi": leg.Sebi, "stamp_duty": leg.StampDuty, "gst": leg.Gst, "total": leg.Total,
	} {
		if !(v >= 0) {
			t.Errorf("%s must satisfy >= 0: %v", name, v)
		}
	}
	if got := ratecard.IPFT(22_500, r); got <= 0 || got != 0.11 {
		t.Errorf("ipftFor(22500) = %v, want > 0 (Node: 0.11)", got)
	}
	if leg.Total != 67.05 { // Node's total for SELL 75@300 on the shipped card
		t.Errorf("total = %v, want 67.05", leg.Total)
	}
}
