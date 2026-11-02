package registry

import (
	"context"
	"fmt"
	"log"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Margins is the ACTIVE broker's basket-margin provider (margins()). Broker() is the
// broker active when Margins was called, as in Node (index.ts called it once, before
// the selection was restored, so it read "zerodha"); BasketMargin routes on the broker
// active at each call.
func (r *Registry) Margins() market.MarginProvider {
	return marginProvider{r: r, broker: r.ActiveBroker()}
}

type marginProvider struct {
	r      *Registry
	broker brokers.ID
}

func (m marginProvider) Broker() brokers.ID { return m.broker }

func (m marginProvider) BasketMargin(ctx context.Context, orders []market.MarginOrder, considerPositions bool) (market.BasketMargin, error) {
	r := m.r
	if r.ActiveBroker() == brokers.Zerodha {
		// Mapped field by field: reference_price is a Dhan-only hint.
		basket := make([]kite.BasketOrder, len(orders))
		for i, o := range orders {
			basket[i] = kite.BasketOrder{
				Exchange: o.Exchange, Tradingsymbol: o.Tradingsymbol, TransactionType: o.TransactionType,
				Variety: o.Variety, Product: o.Product, OrderType: o.OrderType, Quantity: o.Quantity, Price: o.Price,
			}
		}
		res, err := r.deps.Kite.GetBasketMargin(ctx, basket, considerPositions)
		if err != nil {
			return market.BasketMargin{}, err
		}
		r.setMarginSource(market.MarginKiteBasket)
		return market.BasketMargin{Initial: res.Initial, Final: res.Final, Total: res.Total, Source: market.MarginKiteBasket}, nil
	}
	return r.dhanBasketMargin(ctx, orders), nil
}

func (r *Registry) setMarginSource(s market.MarginSource) {
	r.mu.Lock()
	r.lastMarginSource = &s
	r.mu.Unlock()
}

// pickLegPrice is the per-unit price a leg is margined at by Dhan: the first finite
// positive of reference_price and price, else 0.05 (Dhan rejects a zero price).
func pickLegPrice(o market.MarginOrder) float64 {
	if o.ReferencePrice != nil && jsx.Finite(*o.ReferencePrice) && *o.ReferencePrice > 0 {
		return *o.ReferencePrice
	}
	if jsx.Finite(o.Price) && o.Price > 0 {
		return o.Price
	}
	return 0.05
}

// dhanBasketMargin prefers the hedge-aware multi-order calculator and falls back to the
// conservative per-leg sum, clearly labelled.
func (r *Registry) dhanBasketMargin(ctx context.Context, orders []market.MarginOrder) market.BasketMargin {
	_, _ = r.dhanInstruments.Load(ctx, false)
	all := r.dhanInstruments.Instruments()
	bySymbol := make(map[string]int, len(all))
	for i := range all {
		bySymbol[all[i].Exchange+":"+all[i].Tradingsymbol] = i
	}

	// Resolve every leg first: a partial basket must not be margined as a whole.
	var legs []dhan.MarginLeg
	for _, o := range orders {
		i, ok := bySymbol[o.Exchange+":"+o.Tradingsymbol]
		if !ok {
			continue
		}
		inst := all[i]
		// inst.dhan_segment ?? dhanSegmentFor(exchange): a master row always carries its
		// segment, so the fallback never applies; an empty one is skipped like `!segment`.
		segment := inst.DhanSegment
		if segment == "" {
			continue
		}
		legs = append(legs, dhan.MarginLeg{
			ExchangeSegment: segment,
			TransactionType: o.TransactionType,
			Quantity:        o.Quantity,
			ProductType:     "MARGIN",
			SecurityID:      fmt.Sprint(inst.DhanSecurityID),
			Price:           pickLegPrice(o),
		})
	}
	if len(legs) == 0 {
		return market.BasketMargin{Source: market.MarginUnavailable}
	}

	if len(legs) == len(orders) {
		raw, err := r.dhanClient.CalculateMultiMargin(ctx, legs, dhan.MultiMarginOptions{})
		if err == nil {
			if n := dhan.NormalizeMultiMargin(raw); n != nil {
				r.setMarginSource(market.MarginDhanMulti)
				span := 0.0
				if n.Span != nil {
					span = *n.Span
				}
				return market.BasketMargin{
					Initial:      jsx.Round(span),
					Final:        jsx.Round(n.Total),
					Total:        jsx.Round(n.Total),
					Source:       market.MarginDhanMulti,
					HedgeBenefit: n.HedgeBenefit,
					Span:         n.Span,
					Exposure:     n.Exposure,
				}
			}
			log.Printf("[Dhan] multi-order margin returned no readable total — falling back to the "+
				"per-leg sum, which OVER-STATES a hedged box. Response fields: %s", dhan.DescribeMarginPayload(raw))
		} else {
			log.Printf("[Dhan] multi-order margin failed — falling back to the per-leg sum, which "+
				"OVER-STATES a hedged box: %v", err)
		}
	} else {
		log.Printf("[Dhan] only %d/%d basket legs resolved to a security id — "+
			"using the conservative per-leg sum rather than margining a partial basket.", len(legs), len(orders))
	}

	// Fallback: the sum of standalone legs, conservative by construction.
	total, span := 0.0, 0.0
	priced := 0
	for _, leg := range legs {
		res, err := r.dhanClient.CalculateMarginRaw(ctx, leg)
		if err == nil && res.IsNullish() {
			err = fmt.Errorf("Cannot read properties of %s (reading 'totalMargin')", nullishName(res))
		}
		if err != nil {
			log.Printf("[Dhan] per-leg margin failed for securityId %s: %v", leg.SecurityID, err)
			continue
		}
		total += res.Get("totalMargin").OrZero()
		span += res.Get("spanMargin").OrZero()
		priced++
	}
	if priced == 0 {
		// Unknown, not ₹0: the dashboard counts it separately.
		r.setMarginSource(market.MarginUnavailable)
		return market.BasketMargin{Source: market.MarginUnavailable}
	}
	r.setMarginSource(market.MarginDhanPerLegFallback)
	spanOut := span + 0
	return market.BasketMargin{
		Initial: jsx.Round(span),
		Final:   jsx.Round(total),
		Total:   jsx.Round(total),
		Source:  market.MarginDhanPerLegFallback,
		// No hedge benefit is recognised in this path; Node sends null, which the
		// omitempty pointer leaves out.
		Span: &spanOut,
	}
}
