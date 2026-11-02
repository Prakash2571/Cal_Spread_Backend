package calendar

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Decoding of the goldens written by testdata/gen_calendar.mjs. Numbers JSON cannot carry
// (NaN, the infinities, -0) are {"$num": "..."} objects.

func loadGolden(t *testing.T, file string) *kitejson.Value {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with gen_calendar.mjs)", file, err)
	}
	v, err := kitejson.Parse(string(raw))
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	return v
}

func gnum(v *kitejson.Value) float64 {
	if v.Kind() == kitejson.Object {
		switch v.Get("$num").Str() {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		case "-0":
			return math.Copysign(0, -1)
		}
	}
	return v.Num()
}

func gnumPtr(v *kitejson.Value) *float64 {
	if v.Nullish() {
		return nil
	}
	f := gnum(v)
	return &f
}

func gint(v *kitejson.Value) int64 { return int64(gnum(v)) }

// outNum is the generator's outNum: JSON text for finite numbers, String(v) otherwise.
func outNum(v float64, ok bool) string {
	if !ok {
		return "null"
	}
	return kitejson.FormatNumber(v)
}

func marshal(v any) string { return string(jsjson.Marshal(v)) }

func gChargeLeg(v *kitejson.Value) ChargeLeg {
	return ChargeLeg{
		Side: v.Get("side").Str(), Token: gint(v.Get("token")), Expiry: v.Get("expiry").Str(),
		Tradingsymbol: v.Get("tradingsymbol").Str(), Exchange: v.Get("exchange").Str(),
		Quantity: gnum(v.Get("quantity")), Price: gnum(v.Get("price")),
	}
}

func gChargeLegs(v *kitejson.Value) []ChargeLeg {
	out := []ChargeLeg{}
	for _, e := range v.Elems() {
		out = append(out, gChargeLeg(e))
	}
	return out
}

func gBreakdown(v *kitejson.Value) kite.OrderChargeBreakdown {
	g := v.Get("gst")
	return kite.OrderChargeBreakdown{
		TransactionTax: gnum(v.Get("transaction_tax")), TransactionTaxType: v.Get("transaction_tax_type").Str(),
		ExchangeTurnoverCharge: gnum(v.Get("exchange_turnover_charge")), SebiTurnoverCharge: gnum(v.Get("sebi_turnover_charge")),
		Brokerage: gnum(v.Get("brokerage")), StampDuty: gnum(v.Get("stamp_duty")),
		GST:   kite.GST{IGST: gnum(g.Get("igst")), CGST: gnum(g.Get("cgst")), SGST: gnum(g.Get("sgst")), Total: gnum(g.Get("total"))},
		Total: gnum(v.Get("total")),
	}
}

// gOrderCharges decodes one OrderCharges row. raw is the JSON value of Kite's charges
// object, or (rawAsText) a string holding its JSON text.
func gOrderCharges(v *kitejson.Value, rawAsText bool) kite.OrderCharges {
	oc := kite.OrderCharges{
		OrderID: v.Get("order_id").Str(), Tradingsymbol: v.Get("tradingsymbol").Str(),
		TransactionType: v.Get("transaction_type").Str(), Quantity: gnum(v.Get("quantity")),
		Price: gnum(v.Get("price")), Charges: gBreakdown(v.Get("charges")),
	}
	switch raw := v.Get("raw"); {
	case raw.Nullish():
		oc.Raw = json.RawMessage("null")
	case rawAsText:
		oc.Raw = json.RawMessage(raw.Str())
	default:
		oc.Raw = kitejson.Marshal(raw)
	}
	return oc
}

func gLegCharges(v *kitejson.Value) LegCharges {
	return LegCharges{
		Side: v.Get("side").Str(), Tradingsymbol: v.Get("tradingsymbol").Str(), Quantity: gnum(v.Get("quantity")),
		Price: gnum(v.Get("price")), Value: gnum(v.Get("value")), Brokerage: gnum(v.Get("brokerage")),
		Stt: gnum(v.Get("stt")), SttType: v.Get("stt_type").Str(), ExchangeTxn: gnum(v.Get("exchange_txn")),
		Sebi: gnum(v.Get("sebi")), StampDuty: gnum(v.Get("stamp_duty")), Gst: gnum(v.Get("gst")), Total: gnum(v.Get("total")),
	}
}

func gTradeCharges(v *kitejson.Value) *TradeCharges {
	if v.Nullish() {
		return nil
	}
	c := &TradeCharges{
		Legs: []LegCharges{}, Value: gnum(v.Get("value")), Brokerage: gnum(v.Get("brokerage")), Stt: gnum(v.Get("stt")),
		ExchangeTxn: gnum(v.Get("exchange_txn")), Sebi: gnum(v.Get("sebi")), StampDuty: gnum(v.Get("stamp_duty")),
		Gst: gnum(v.Get("gst")), Total: gnum(v.Get("total")), Source: v.Get("source").Str(), At: v.Get("at").Str(),
	}
	for _, l := range v.Get("legs").Elems() {
		c.Legs = append(c.Legs, gLegCharges(l))
	}
	return c
}

// gTime reads a Date field: epoch ms or ISO text.
func gTime(t *testing.T, v *kitejson.Value) time.Time {
	t.Helper()
	if v.IsNumber() {
		return time.UnixMilli(int64(v.Num())).UTC()
	}
	ts, err := time.Parse(time.RFC3339Nano, v.Str())
	if err != nil {
		t.Fatalf("bad date %q: %v", v.Str(), err)
	}
	return ts.UTC()
}

func gTimePtr(t *testing.T, v *kitejson.Value) *time.Time {
	if v.Nullish() {
		return nil
	}
	ts := gTime(t, v)
	return &ts
}

// gTrade decodes a stored trade as the generator writes it (id, ISO or ms dates).
func gTrade(t *testing.T, v *kitejson.Value) *Trade {
	t.Helper()
	leg := func(l *kitejson.Value) Leg {
		return Leg{Token: gint(l.Get("token")), Expiry: l.Get("expiry").Str(), Entry: gnum(l.Get("entry"))}
	}
	return &Trade{
		ID: v.Get("id").Str(), Symbol: v.Get("symbol").Str(), Name: v.Get("name").Str(),
		IsIndex: v.Get("is_index").Truthy(), LotSize: gnum(v.Get("lot_size")),
		Buy: leg(v.Get("buy")), Sell: leg(v.Get("sell")), Status: v.Get("status").Str(),
		OpenedAt: gTime(t, v.Get("opened_at")), ClosedAt: gTimePtr(t, v.Get("closed_at")),
		ClosePnl: gnumPtr(v.Get("close_pnl")), BuyClose: gnumPtr(v.Get("buy_close")),
		SellClose: gnumPtr(v.Get("sell_close")), Margin: gnumPtr(v.Get("margin")),
		EntryCharges: gTradeCharges(v.Get("entry_charges")), ExitCharges: gTradeCharges(v.Get("exit_charges")),
		EstExitCharges: gTradeCharges(v.Get("est_exit_charges")), EntryValue: gnumPtr(v.Get("entry_value")),
		ExitValue: gnumPtr(v.Get("exit_value")), TotalCharges: gnumPtr(v.Get("total_charges")),
		NetPnl: gnumPtr(v.Get("net_pnl")),
	}
}

func gLevels(v *kitejson.Value) []market.DepthLevel {
	out := []market.DepthLevel{}
	for _, l := range v.Elems() {
		out = append(out, market.DepthLevel{Price: gnum(l.Get("price")), Qty: gnum(l.Get("qty")), Orders: gnum(l.Get("orders"))})
	}
	return out
}

func gLadder(v *kitejson.Value) hub.Ladder {
	return hub.Ladder{Last: gnum(v.Get("last")), Bids: gLevels(v.Get("bids")), Asks: gLevels(v.Get("asks"))}
}

func gInstruments(t *testing.T, v *kitejson.Value) []market.Instrument {
	t.Helper()
	var out []market.Instrument
	if err := json.Unmarshal(kitejson.Marshal(v), &out); err != nil {
		t.Fatalf("decode instruments: %v", err)
	}
	return out
}

func gBoard(t *testing.T, v *kitejson.Value) []BoardItem {
	t.Helper()
	var out []BoardItem
	if err := json.Unmarshal(kitejson.Marshal(v), &out); err != nil {
		t.Fatalf("decode board: %v", err)
	}
	return out
}

// gError is a scripted collaborator failure: a KiteError or a plain Error.
func gError(v *kitejson.Value) error {
	if v.Get("kite").Truthy() {
		return &kite.KiteError{Status: int(gnum(v.Get("status"))), Message: v.Get("message").Str()}
	}
	return plainError(v.Get("message").Str())
}

type plainError string

func (e plainError) Error() string { return string(e) }
