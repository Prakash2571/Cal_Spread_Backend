package registry

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
)

// GetQuoteFull supplies the active broker's OI, price, previous close and trade
// timestamp. Unlike a tick/strategy quote, analytics needs all these fields.
func (q *QuoteProvider) GetQuoteFull(ctx context.Context, identifiers []string) ([]kite.FullQuote, error) {
	namespace, err := q.r.namespaceFor(ctx)
	if err != nil {
		return nil, err
	}
	ctx = brokers.WithNamespace(ctx, namespace)
	if namespace.Broker == brokers.Zerodha {
		return q.r.deps.Kite.GetQuoteFull(ctx, identifiers)
	}
	rows, err := q.r.dhanInstruments.Load(ctx, false)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]dhan.Instrument, len(rows))
	for _, row := range rows {
		byID[row.Exchange+":"+row.Tradingsymbol] = row
	}
	seen := map[int64]bool{}
	var wanted []dhan.Instrument
	for _, identifier := range identifiers {
		if row, ok := byID[identifier]; ok && !seen[row.InstrumentToken] {
			seen[row.InstrumentToken] = true
			wanted = append(wanted, row)
		}
	}
	out := []kite.FullQuote{}
	for offset := 0; offset < len(wanted); offset += DhanQuoteChunk {
		if _, err := q.r.namespaceFor(ctx); err != nil {
			return nil, err
		}
		batch := wanted[offset:min(offset+DhanQuoteChunk, len(wanted))]
		request := dhan.MarketFeedRequest{}
		for _, row := range batch {
			request[row.DhanSegment] = append(request[row.DhanSegment], row.DhanSecurityID)
		}
		response, err := q.r.analyticsQuote(ctx, request)
		if err != nil {
			return nil, err
		}
		for _, row := range batch {
			entry := response.Data.Get(string(row.DhanSegment)).Get(fmt.Sprint(row.DhanSecurityID))
			price, hasPrice := entry.Get("last_price").Num()
			oi, hasOI := entry.Get("oi").Num()
			derivative := row.InstrumentType == "CE" || row.InstrumentType == "PE" || row.InstrumentType == "FUT"
			if !hasPrice || !jsx.Finite(price) || price <= 0 || (derivative && (!hasOI || !jsx.Finite(oi) || oi < 0)) {
				continue // absent data remains absent, rather than a fabricated zero
			}
			close, _ := entry.Get("ohlc").Get("close").Num()
			stamp, _ := entry.Get("last_trade_time").Str()
			out = append(out, kite.FullQuote{InstrumentToken: row.InstrumentToken, LastPrice: price,
				Close: close, OI: oi, LastTradeTime: normalizeDhanTradeTime(stamp)})
		}
	}
	if _, err := q.r.namespaceFor(ctx); err != nil {
		return nil, err
	}
	if len(identifiers) > 0 && len(out) == 0 {
		return nil, fmt.Errorf("Dhan returned no usable analytics quotes")
	}
	return out, nil
}

// Dhan's quote endpoint allows one request per second. Share the pacing between
// option and futures captures, and let shutdown/switch cancellation interrupt it.
func (r *Registry) analyticsQuote(ctx context.Context, request dhan.MarketFeedRequest) (dhan.MarketFeedResponse, error) {
	select {
	case r.analyticsQuoteGate <- struct{}{}:
		defer func() { <-r.analyticsQuoteGate }()
	case <-ctx.Done():
		return dhan.MarketFeedResponse{}, ctx.Err()
	}
	if delay := time.Until(r.analyticsQuoteAt.Add(time.Second)); delay > 0 {
		if sleep := r.deps.Dhan.Sleep; sleep != nil {
			if err := sleep(ctx, delay); err != nil {
				return dhan.MarketFeedResponse{}, err
			}
		} else {
			timer := time.NewTimer(delay)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
				return dhan.MarketFeedResponse{}, ctx.Err()
			}
		}
	}
	if _, err := r.namespaceFor(ctx); err != nil {
		return dhan.MarketFeedResponse{}, err
	}
	r.analyticsQuoteAt = time.Now()
	return r.dhanClient.MarketFeedQuote(ctx, request)
}

// Dhan's documented last_trade_time is DD/MM/YYYY HH:MM:SS. Normalize a known
// timestamp for the day/holiday check; missing or unrecognized values stay as given.
func normalizeDhanTradeTime(stamp string) string {
	if parsed, err := time.ParseInLocation("02/01/2006 15:04:05", strings.TrimSpace(stamp), tokenIST); err == nil {
		if parsed.Year() <= 1980 {
			return "" // Dhan's documented no-trade placeholder, not a real session
		}
		return parsed.Format("2006-01-02 15:04:05")
	}
	return stamp
}
