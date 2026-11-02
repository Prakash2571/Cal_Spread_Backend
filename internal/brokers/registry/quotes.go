package registry

import (
	"context"
	"fmt"
	"log"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// DhanQuoteChunk is how many security ids one Dhan market-feed request carries per
// segment.
const DhanQuoteChunk = 1000

// QuoteProvider is quoteProvider.ts: REST snapshot quotes for internal tokens of the
// ACTIVE broker, in the Tick shape the frontend consumes.
type QuoteProvider struct{ r *Registry }

// QuotesByToken quotes what it can resolve; one unknown instrument never blanks the
// batch. Kite quotes carry no depth (bid/ask 0); Dhan quotes carry the book.
func (q *QuoteProvider) QuotesByToken(ctx context.Context, tokens []int64) ([]market.Tick, error) {
	if len(tokens) == 0 {
		return []market.Tick{}, nil
	}
	if q.r.ActiveBroker() == brokers.Dhan {
		return q.dhanQuotes(ctx, tokens), nil
	}
	return q.kiteQuotes(ctx, tokens)
}

func (q *QuoteProvider) kiteQuotes(ctx context.Context, tokens []int64) ([]market.Tick, error) {
	all, err := q.r.instruments.Load(ctx, false)
	if err != nil {
		return nil, err
	}
	byToken := make(map[int64]int, len(all))
	for i := range all {
		byToken[all[i].InstrumentToken] = i
	}
	var identifiers []string
	for _, t := range tokens {
		if i, ok := byToken[t]; ok {
			identifiers = append(identifiers, all[i].Exchange+":"+all[i].Tradingsymbol)
		}
	}
	if len(identifiers) == 0 {
		return []market.Tick{}, nil
	}
	quotes, err := q.r.deps.Kite.GetQuoteFull(ctx, identifiers)
	if err != nil {
		return nil, err
	}
	out := make([]market.Tick, len(quotes))
	for i, k := range quotes {
		// Kite's /quote has no depth; the live feed supplies bid/ask.
		out[i] = market.Tick{Token: k.InstrumentToken, LastPrice: k.LastPrice, ClosePrice: k.Close, OI: k.OI}
	}
	return out, nil
}

// segmentBuckets groups security ids by segment in first-seen order (a JavaScript Map).
type segmentBuckets struct {
	order []dhan.Segment
	ids   map[dhan.Segment][]int64
	back  map[string]*dhan.Instrument
}

func newSegmentBuckets() *segmentBuckets {
	return &segmentBuckets{ids: map[dhan.Segment][]int64{}, back: map[string]*dhan.Instrument{}}
}

// backKey is the Map key `${segment}:${Number(securityId)}`.
func backKey(seg dhan.Segment, id float64) string {
	return string(seg) + ":" + jsjson.FormatNumber(id)
}

func (b *segmentBuckets) add(inst *dhan.Instrument) {
	if _, ok := b.ids[inst.DhanSegment]; !ok {
		b.order = append(b.order, inst.DhanSegment)
	}
	b.ids[inst.DhanSegment] = append(b.ids[inst.DhanSegment], inst.DhanSecurityID)
	b.back[backKey(inst.DhanSegment, float64(inst.DhanSecurityID))] = inst
}

// eachChunk calls fn for every ≤1000-id request, segment by segment.
func (b *segmentBuckets) eachChunk(fn func(seg dhan.Segment, chunk []int64)) {
	for _, seg := range b.order {
		ids := b.ids[seg]
		for i := 0; i < len(ids); i += DhanQuoteChunk {
			fn(seg, ids[i:min(i+DhanQuoteChunk, len(ids))])
		}
	}
}

// typeError is the TypeError a property read of null/undefined (or a missing method)
// throws in Node; it aborts the rest of one chunk, as the try/catch per chunk did.
type typeError struct{ msg string }

func (e *typeError) Error() string { return e.msg }

// feedBook is `res.data?.[segment] ?? {}` as [securityId, entry] pairs in JavaScript key
// order (integer-like ids ascending).
func feedBook(res dhan.MarketFeedResponse, seg dhan.Segment) ([]string, []dhan.Value) {
	book := res.Data.Get(string(seg))
	if !book.IsObjectLike() {
		return nil, nil
	}
	return book.Keys(), book.Values()
}

func (q *QuoteProvider) dhanQuotes(ctx context.Context, tokens []int64) []market.Tick {
	store := q.r.dhanInstruments
	_, _ = store.Load(ctx, false)
	buckets := newSegmentBuckets()
	for _, t := range tokens {
		inst, ok := store.Get(t)
		if !ok {
			continue
		}
		buckets.add(&inst)
	}
	out := []market.Tick{}
	if len(buckets.order) == 0 {
		return out
	}
	buckets.eachChunk(func(seg dhan.Segment, chunk []int64) {
		res, err := q.r.dhanClient.MarketFeedQuote(ctx, dhan.MarketFeedRequest{seg: chunk})
		if err == nil {
			var ticks []market.Tick
			ticks, err = quoteTicks(res, seg, buckets.back)
			out = append(out, ticks...)
		}
		if err != nil {
			log.Printf("[Dhan] REST quote failed for %s (%d ids): %v", seg, len(chunk), err)
		}
	})
	return out
}

// quoteTicks maps one market-feed response to ticks with the TypeScript's property-read
// semantics; on a TypeError the ticks built so far are kept and the rest of the chunk is
// lost, exactly as in Node.
func quoteTicks(res dhan.MarketFeedResponse, seg dhan.Segment, back map[string]*dhan.Instrument) ([]market.Tick, error) {
	var out []market.Tick
	keys, vals := feedBook(res, seg)
	for i, securityID := range keys {
		n, _ := jsx.ParseNumber(securityID)
		inst := back[backKey(seg, n)]
		if inst == nil {
			continue
		}
		entry := vals[i]
		if entry.IsNullish() {
			return out, &typeError{fmt.Sprintf("Cannot read properties of %s (reading 'depth')", nullishName(entry))}
		}
		depth := entry.Get("depth")
		bids := depth.Get("buy")
		if depth.IsNullish() || bids.IsNullish() {
			bids = dhan.Value{}
		}
		asks := depth.Get("sell")
		if depth.IsNullish() || asks.IsNullish() {
			asks = dhan.Value{}
		}
		tick := market.Tick{
			Token:      inst.InstrumentToken,
			LastPrice:  entry.Get("last_price").OrZero(),
			ClosePrice: entry.Get("ohlc").Get("close").OrZero(),
			OI:         entry.Get("oi").OrZero(),
			Bid:        bids.Get("0").Get("price").OrZero(),
			Ask:        asks.Get("0").Get("price").OrZero(),
		}
		var err error
		if tick.Bids, err = depthLevels(bids); err != nil {
			return out, err
		}
		if tick.Asks, err = depthLevels(asks); err != nil {
			return out, err
		}
		out = append(out, tick)
	}
	return out, nil
}

// depthLevels is `bids.length > 0 ? bids.filter(l => Number(l.price) > 0).map(...) :
// absent`. nil means the field is absent; an empty non-nil slice is `[]`.
func depthLevels(side dhan.Value) ([]market.DepthLevel, error) {
	var length float64
	switch side.Kind() {
	case dhan.KindArray:
		length = float64(side.Len())
	case dhan.KindString:
		s, _ := side.Str()
		length = float64(len([]rune(s)))
	case dhan.KindObject:
		length = side.Get("length").ToNumber()
	}
	if !(length > 0) {
		return nil, nil
	}
	if !side.IsArray() {
		return nil, &typeError{"bids.filter is not a function"}
	}
	levels := []market.DepthLevel{}
	for _, l := range side.Array() {
		if l.IsNullish() {
			return nil, &typeError{fmt.Sprintf("Cannot read properties of %s (reading 'price')", nullishName(l))}
		}
		price := l.Get("price").ToNumber()
		if !(price > 0) {
			continue
		}
		levels = append(levels, market.DepthLevel{
			Price:  price,
			Qty:    l.Get("quantity").OrZero(),
			Orders: l.Get("orders").OrZero(),
		})
	}
	return levels, nil
}

func nullishName(v dhan.Value) string {
	if v.IsNull() {
		return "null"
	}
	return "undefined"
}

/* ------------------------------ market data ------------------------------- */

// MarketData is the ACTIVE broker's REST market data (marketData()). It reads the
// active broker on every call, so a switch takes effect at once.
func (r *Registry) MarketData() market.MarketDataProvider { return marketDataProvider{r} }

type marketDataProvider struct{ r *Registry }

func (m marketDataProvider) IsAuthenticated() bool {
	if m.r.ActiveBroker() == brokers.Zerodha {
		return m.r.deps.Kite.HasSession()
	}
	return m.r.usableDhanToken() != "" && m.r.dhanDataEnabled()
}

func (m marketDataProvider) GetQuoteFull(ctx context.Context, identifiers []string) ([]market.RestQuote, error) {
	if m.r.ActiveBroker() == brokers.Zerodha {
		quotes, err := m.r.deps.Kite.GetQuoteFull(ctx, identifiers)
		if err != nil {
			return nil, err
		}
		out := make([]market.RestQuote, len(quotes))
		for i, q := range quotes {
			out[i] = market.RestQuote{InstrumentToken: q.InstrumentToken, LastPrice: q.LastPrice, LastTradeTime: q.LastTradeTime}
		}
		return out, nil
	}
	return m.r.dhanQuoteFull(ctx, identifiers), nil
}

// dhanQuoteFull is REST snapshot quotes from Dhan shaped like Kite's, for
// "EXCHANGE:TRADINGSYMBOL" identifiers; unresolvable identifiers are skipped.
func (r *Registry) dhanQuoteFull(ctx context.Context, identifiers []string) []market.RestQuote {
	_, _ = r.dhanInstruments.Load(ctx, false)
	all := r.dhanInstruments.Instruments()
	bySymbol := make(map[string]int, len(all))
	for i := range all {
		bySymbol[all[i].Exchange+":"+all[i].Tradingsymbol] = i
	}
	buckets := newSegmentBuckets()
	for _, id := range identifiers {
		i, ok := bySymbol[id]
		if !ok {
			continue
		}
		inst := all[i]
		buckets.add(&inst)
	}
	out := []market.RestQuote{}
	if len(buckets.order) == 0 {
		return out
	}
	buckets.eachChunk(func(seg dhan.Segment, chunk []int64) {
		res, err := r.dhanClient.MarketFeedQuote(ctx, dhan.MarketFeedRequest{seg: chunk})
		if err == nil {
			keys, vals := feedBook(res, seg)
			for i, securityID := range keys {
				n, _ := jsx.ParseNumber(securityID)
				inst := buckets.back[backKey(seg, n)]
				if inst == nil {
					continue
				}
				entry := vals[i]
				if entry.IsNullish() {
					err = &typeError{fmt.Sprintf("Cannot read properties of %s (reading 'last_price')", nullishName(entry))}
					break
				}
				ltt, _ := entry.Get("last_trade_time").Str()
				out = append(out, market.RestQuote{
					InstrumentToken: inst.InstrumentToken,
					LastPrice:       entry.Get("last_price").OrZero(),
					// An absent time stays "" so a stale strike never looks current.
					LastTradeTime: ltt,
				})
			}
		}
		if err != nil {
			log.Printf("[Dhan] market feed quote failed for %s: %v", seg, err)
		}
	})
	return out
}
