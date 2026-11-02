// Package ratecard is the deterministic, synchronous option/futures charge calculator
// (src/box/localCharges.ts). Synthetic prices its paper trades with it. Every head is
// rounded to paise, a leg's total is the sum of its rounded heads, and the rates are
// env-overridable because statutory rates change.
//
// The arithmetic follows the Node code operation for operation (same order of multiply
// and divide, Math.round-style halves) so results are identical to the cent.
package ratecard

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// Side is the order side.
type Side string

const (
	Buy  Side = "BUY"
	Sell Side = "SELL"
)

// Rates is one rate card. Percentages are PERCENT (0.15 means 0.15%), as circulars state them.
type Rates struct {
	BrokeragePerOrder    float64 `json:"brokeragePerOrder"`    // flat ₹ per executed order
	BrokerageMaxPct      float64 `json:"brokerageMaxPct"`      // optional cap as % of turnover; 0 disables it
	SttSellPct           float64 `json:"sttSellPct"`           // STT on SELLs, % of premium
	SttRoundNearestRupee bool    `json:"sttRoundNearestRupee"` // contract notes round STT to the rupee
	ExchangeTxnPct       float64 `json:"exchangeTxnPct"`       // both sides
	IpftPerCrore         float64 `json:"ipftPerCrore"`         // ₹ per crore of premium, folded into the exchange head
	IpftPct              float64 `json:"ipftPct"`              // legacy IPFT as % of premium
	SebiPct              float64 `json:"sebiPct"`              // both sides
	StampDutyBuyPct      float64 `json:"stampDutyBuyPct"`      // BUY side only
	GstPct               float64 `json:"gstPct"`               // on brokerage + exchange + SEBI
	SttType              string  `json:"sttType"`              // Kite's label for the transaction tax
	RateVersion          string  `json:"rateVersion"`          // stamped on records so old P&L stays interpretable
}

// Load reads the shipped rate card, every value overridable from the environment.
// Defaults are the NSE equity-options structure in force since 1 April 2026.
func Load(get config.Getter) Rates {
	return Rates{
		BrokeragePerOrder:    config.Num(get, "BOX_BROKERAGE_PER_ORDER", 20),
		BrokerageMaxPct:      config.Num(get, "BOX_BROKERAGE_MAX_PCT", 0),
		SttSellPct:           config.Num(get, "BOX_STT_SELL_PCT", 0.15),
		SttRoundNearestRupee: config.Bool(get, "BOX_STT_ROUND_NEAREST_RUPEE", true),
		ExchangeTxnPct:       config.Num(get, "BOX_EXCHANGE_TXN_PCT", 0.03503),
		IpftPerCrore:         config.Num(get, "BOX_IPFT_PER_CRORE", 50),
		IpftPct:              config.Num(get, "BOX_IPFT_PCT", 0),
		SebiPct:              config.Num(get, "BOX_SEBI_PCT", 0.0001),
		StampDutyBuyPct:      config.Num(get, "BOX_STAMP_DUTY_BUY_PCT", 0.003),
		GstPct:               config.Num(get, "BOX_GST_PCT", 18),
		SttType:              config.Str(get, "BOX_STT_TYPE", "stt"),
		RateVersion:          config.Str(get, "BOX_CHARGE_RATE_VERSION", "zerodha-nse-options-2026-04-01"),
	}
}

// Order is one order to charge.
type Order struct {
	Side          Side
	Tradingsymbol string
	Quantity      float64
	Price         float64
}

// Leg is the charges of one order, shaped like a stored contract note.
type Leg struct {
	Side          Side    `json:"side"`
	Tradingsymbol string  `json:"tradingsymbol"`
	Quantity      float64 `json:"quantity"`
	Price         float64 `json:"price"`
	Value         float64 `json:"value"`
	Brokerage     float64 `json:"brokerage"`
	Stt           float64 `json:"stt"`
	SttType       string  `json:"stt_type"`
	ExchangeTxn   float64 `json:"exchange_txn"`
	Sebi          float64 `json:"sebi"`
	StampDuty     float64 `json:"stamp_duty"`
	Gst           float64 `json:"gst"`
	Total         float64 `json:"total"`
}

// pct is (value * percent) / 100, in that order.
func pct(value, percent float64) float64 { return (value * percent) / 100 }

// RoundStt rounds the STT head: to the nearest rupee (JavaScript Math.round) when the
// card says so, else to paise. The one place this rule lives.
func RoundStt(value float64, r Rates) float64 {
	if r.SttRoundNearestRupee {
		return jsx.Round(value)
	}
	return jsx.Round2(value)
}

// IPFT is the NSE Investor Protection Fund Trust charge for one leg (₹), from the ₹/crore
// rate plus any legacy percentage.
func IPFT(value float64, r Rates) float64 {
	perCrore := (value * r.IpftPerCrore) / 10_000_000
	return jsx.Round2(perCrore + pct(value, r.IpftPct))
}

// LegCharges prices ONE order. Every head is rounded to paise (STT by RoundStt), and the
// total is the sum of the rounded heads, so a caller can add the heads or trust the total.
func LegCharges(o Order, r Rates) Leg {
	value := jsx.Round2(o.Quantity * o.Price)

	limit := math.Inf(1)
	if r.BrokerageMaxPct > 0 {
		limit = pct(value, r.BrokerageMaxPct)
	}
	brokerage := jsx.Round2(math.Min(r.BrokeragePerOrder, limit))

	// STT is a SELL-side tax on the premium.
	var stt float64
	sttType := ""
	if o.Side == Sell {
		stt = RoundStt(pct(value, r.SttSellPct), r)
		sttType = r.SttType
	}
	// The exchange head carries the exchange transaction charge plus IPFT.
	exchange := jsx.Round2(pct(value, r.ExchangeTxnPct) + IPFT(value, r))
	sebi := jsx.Round2(pct(value, r.SebiPct))
	// Stamp duty is a BUY-side duty.
	var stamp float64
	if o.Side == Buy {
		stamp = jsx.Round2(pct(value, r.StampDutyBuyPct))
	}
	// GST applies to brokerage and the two turnover fees, never to STT or stamp duty.
	gst := jsx.Round2(pct(brokerage+exchange+sebi, r.GstPct))

	return Leg{
		Side: o.Side, Tradingsymbol: o.Tradingsymbol, Quantity: o.Quantity,
		Price: jsx.Round2(o.Price), Value: value,
		Brokerage: brokerage, Stt: stt, SttType: sttType, ExchangeTxn: exchange,
		Sebi: sebi, StampDuty: stamp, Gst: gst,
		Total: jsx.Round2(brokerage + stt + exchange + sebi + stamp + gst),
	}
}
