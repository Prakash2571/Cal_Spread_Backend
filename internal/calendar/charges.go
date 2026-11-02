package calendar

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Order-book and charge helpers of index.ts (resolveLadder, bestPrice, round2,
// toLegCharges, aggregateCharges, chargeTotals, unpricedLogLegs, reverseLegs,
// priceChargeGroups, serializeTrade). Every charge number comes from Zerodha's virtual
// contract note priced at the simulated fill; nothing is computed from a local rate card.

// round2 rounds money to paise: Math.round(v * 100) / 100.
func round2(v float64) float64 { return jsx.Round2(v) }

// truthy is JavaScript truthiness for a number (0 and NaN are falsy).
func truthy(v float64) bool { return v != 0 && !math.IsNaN(v) }

func f64(v float64) *float64 { return &v }

// ladder is the order book of one token: the hub's live book or a REST snapshot.
type ladder struct {
	last float64
	bids []market.DepthLevel
	asks []market.DepthLevel
}

// bestPrice is the fill at the TOUCH: the highest bid ("bid") or the lowest ask (any
// other side) among levels with a positive price, computed rather than trusting the
// array order. ok is false when that side of the book is empty.
func bestPrice(levels []market.DepthLevel, side string) (best float64, ok bool) {
	for _, lv := range levels {
		if !(lv.Price > 0) {
			continue
		}
		switch {
		case !ok:
			best, ok = lv.Price, true
		case side == "bid":
			best = math.Max(best, lv.Price)
		default:
			best = math.Min(best, lv.Price)
		}
	}
	return best, ok
}

// resolveLadder returns the books for tokens, preferring the hub's live book (received
// within 5 s and with at least one level) and asking Kite's REST /quote for the rest.
// Tokens the instrument universe cannot name are left out.
func (s *Service) resolveLadder(ctx context.Context, tokens []int64) (map[int64]ladder, error) {
	out := map[int64]ladder{}
	var missing []int64
	for _, tk := range tokens {
		if s.d.Hub != nil {
			if fresh, ok := s.d.Hub.GetFreshLadder(tk, LadderMaxAgeMs); ok && (len(fresh.Bids) > 0 || len(fresh.Asks) > 0) {
				out[tk] = ladder{last: fresh.Last, bids: fresh.Bids, asks: fresh.Asks}
				continue
			}
		}
		missing = append(missing, tk)
	}
	if len(missing) == 0 {
		return out, nil
	}
	all, err := s.d.Instruments(ctx)
	if err != nil {
		return nil, err
	}
	byToken := make(map[int64]string, len(all))
	for _, inst := range all {
		byToken[inst.InstrumentToken] = inst.Exchange + ":" + inst.Tradingsymbol
	}
	ids := []string{}
	for _, tk := range missing {
		if id, ok := byToken[tk]; ok {
			ids = append(ids, id)
		}
	}
	rest, err := s.d.Kite.GetQuoteLadder(ctx, ids)
	if err != nil {
		return nil, err
	}
	for tk, v := range rest {
		out[tk] = ladder{last: v.Last, bids: v.Bids, asks: v.Asks}
	}
	return out, nil
}

// toLegCharges folds Kite's per-order charge object into the flat per-leg record. The
// leg total is the sum of the ROUNDED heads (left to right), not Kite's own total.
func toLegCharges(leg ChargeLeg, oc kite.OrderCharges) LegCharges {
	c := oc.Charges
	brokerage := round2(c.Brokerage)
	stt := round2(c.TransactionTax)
	exchangeTxn := round2(c.ExchangeTurnoverCharge)
	sebi := round2(c.SebiTurnoverCharge)
	stampDuty := round2(c.StampDuty)
	gst := round2(c.GST.Total)
	return LegCharges{
		Side:          leg.Side,
		Tradingsymbol: leg.Tradingsymbol,
		Quantity:      leg.Quantity,
		Price:         round2(leg.Price),
		Value:         round2(leg.Quantity * leg.Price),
		Brokerage:     brokerage,
		Stt:           stt,
		SttType:       c.TransactionTaxType,
		ExchangeTxn:   exchangeTxn,
		Sebi:          sebi,
		StampDuty:     stampDuty,
		Gst:           gst,
		Total:         round2(brokerage + stt + exchangeTxn + sebi + stampDuty + gst),
	}
}

// aggregateCharges sums legs into the charges record stored on the trade; each head is
// round2 of the running sum.
func aggregateCharges(legs []LegCharges, source string, at time.Time) *TradeCharges {
	sum := func(pick func(l *LegCharges) float64) float64 {
		acc := 0.0
		for i := range legs {
			acc += pick(&legs[i])
		}
		return round2(acc)
	}
	if legs == nil {
		legs = []LegCharges{}
	}
	return &TradeCharges{
		Legs:        legs,
		Value:       sum(func(l *LegCharges) float64 { return l.Value }),
		Brokerage:   sum(func(l *LegCharges) float64 { return l.Brokerage }),
		Stt:         sum(func(l *LegCharges) float64 { return l.Stt }),
		ExchangeTxn: sum(func(l *LegCharges) float64 { return l.ExchangeTxn }),
		Sebi:        sum(func(l *LegCharges) float64 { return l.Sebi }),
		StampDuty:   sum(func(l *LegCharges) float64 { return l.StampDuty }),
		Gst:         sum(func(l *LegCharges) float64 { return l.Gst }),
		Total:       sum(func(l *LegCharges) float64 { return l.Total }),
		Source:      source,
		At:          jsx.ISO(at),
	}
}

// chargeTotals is the charge heads of one trade side, or zeros when it was not priced.
func chargeTotals(c *TradeCharges) ChargeHeads {
	if c == nil {
		return ChargeHeads{}
	}
	return ChargeHeads{
		Brokerage: c.Brokerage, Stt: c.Stt, ExchangeTxn: c.ExchangeTxn, Sebi: c.Sebi,
		StampDuty: c.StampDuty, Gst: c.Gst, Total: c.Total,
	}
}

// nullRaw is the raw charge object of an unpriced leg.
var nullRaw = json.RawMessage("null")

// logLegOf is the ledger row of a priced leg: {...legCharges, token, exchange, expiry, raw}.
func logLegOf(lc LegCharges, leg ChargeLeg, raw json.RawMessage) LogLeg {
	if raw == nil {
		raw = nullRaw
	}
	return LogLeg{
		Side: lc.Side, Token: leg.Token, Tradingsymbol: lc.Tradingsymbol, Exchange: leg.Exchange,
		Expiry: leg.Expiry, Quantity: lc.Quantity, Price: lc.Price, Value: lc.Value,
		Brokerage: lc.Brokerage, Stt: lc.Stt, SttType: lc.SttType, ExchangeTxn: lc.ExchangeTxn,
		Sebi: lc.Sebi, StampDuty: lc.StampDuty, Gst: lc.Gst, Total: lc.Total, Raw: raw,
	}
}

// unpricedLogLegs records legs Kite could not price: what was transacted, every charge
// head zero (the event's source says "unpriced").
func unpricedLogLegs(legs []ChargeLeg) []LogLeg {
	out := make([]LogLeg, 0, len(legs))
	for _, leg := range legs {
		out = append(out, LogLeg{
			Side: leg.Side, Token: leg.Token, Tradingsymbol: leg.Tradingsymbol, Exchange: leg.Exchange,
			Expiry: leg.Expiry, Quantity: leg.Quantity, Price: round2(leg.Price),
			Value: round2(leg.Quantity * leg.Price), Raw: nullRaw,
		})
	}
	return out
}

// reverseLegs is the same legs with the sides flipped: the orders that close them.
func reverseLegs(legs []ChargeLeg) []ChargeLeg {
	out := make([]ChargeLeg, len(legs))
	for i, l := range legs {
		if l.Side == "BUY" {
			l.Side = "SELL"
		} else {
			l.Side = "BUY"
		}
		out[i] = l
	}
	return out
}

// chargeGroup is one set of legs priced together, with the source its charges carry.
type chargeGroup struct {
	legs   []ChargeLeg
	source string // kite | kite_estimate
}

// pricedCharges is one priced group: the stored charges plus the ledger rows.
type pricedCharges struct {
	charges *TradeCharges
	logLegs []LogLeg
}

// priceChargeGroups prices every group in ONE /charges/orders call (the endpoint shares
// Kite's order-rate quota) and maps the rows back by the synthetic order ids, falling back
// to the position. nil, never an error, when Kite cannot price them: charges are a record
// of a trade, not a precondition for it.
func (s *Service) priceChargeGroups(ctx context.Context, groups []chargeGroup) []pricedCharges {
	var orders []kite.ChargeOrder
	for gi, g := range groups {
		for li, leg := range g.legs {
			orders = append(orders, kite.ChargeOrder{
				OrderID:         chargeOrderID(gi, li),
				Exchange:        leg.Exchange,
				Tradingsymbol:   leg.Tradingsymbol,
				TransactionType: leg.Side,
				Variety:         "regular",
				Product:         "NRML",
				OrderType:       "MARKET",
				Quantity:        leg.Quantity,
				AveragePrice:    round2(leg.Price),
			})
		}
	}
	if len(orders) == 0 {
		return nil
	}
	priced, err := s.d.Kite.GetOrderCharges(ctx, orders)
	if err != nil {
		s.d.Logf("[Charges] virtual contract note fetch failed: %v", err)
		return nil
	}
	if len(priced) != len(orders) {
		s.d.Logf("[Charges] expected %d priced orders, got %d — skipping.", len(orders), len(priced))
		return nil
	}
	byID := make(map[string]int, len(priced))
	for i, p := range priced {
		byID[p.OrderID] = i // a repeated id keeps the last row, as new Map(...) does
	}
	out := make([]pricedCharges, 0, len(groups))
	cursor := 0
	for gi, g := range groups {
		legCharges := make([]LegCharges, 0, len(g.legs))
		logLegs := make([]LogLeg, 0, len(g.legs))
		for li, leg := range g.legs {
			idx, ok := byID[chargeOrderID(gi, li)]
			if !ok {
				idx = cursor + li
			}
			oc := priced[idx]
			lc := toLegCharges(leg, oc)
			legCharges = append(legCharges, lc)
			logLegs = append(logLegs, logLegOf(lc, leg, oc.Raw))
		}
		cursor += len(g.legs)
		out = append(out, pricedCharges{charges: aggregateCharges(legCharges, g.source, s.d.Now()), logLegs: logLegs})
	}
	return out
}

func chargeOrderID(gi, li int) string {
	return "calspread-" + strconv.Itoa(gi) + "-" + strconv.Itoa(li)
}

// serializeTrade is the API shape of a trade (string id, ISO dates, null for unset).
func serializeTrade(t *Trade) tradeJSON {
	out := tradeJSON{
		ID: t.ID, Symbol: t.Symbol, Name: t.Name, IsIndex: t.IsIndex, LotSize: t.LotSize,
		Buy: t.Buy, Sell: t.Sell, Status: t.Status, OpenedAt: jsx.ISO(t.OpenedAt),
		ClosePnl: t.ClosePnl, BuyClose: t.BuyClose, SellClose: t.SellClose, Margin: t.Margin,
		EntryCharges: t.EntryCharges, ExitCharges: t.ExitCharges, EstExitCharges: t.EstExitCharges,
		EntryValue: t.EntryValue, ExitValue: t.ExitValue, TotalCharges: t.TotalCharges, NetPnl: t.NetPnl,
	}
	if t.ClosedAt != nil {
		iso := jsx.ISO(*t.ClosedAt)
		out.ClosedAt = &iso
	}
	return out
}
