package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// DefaultQuotePolicy is quotes.ts DEFAULT_QUOTE_POLICY.
var DefaultQuotePolicy = QuotePolicy{
	MaxAgeMs: 30000, MaxRelativeSpread: 0.25, MaxAbsoluteSpread: 100,
	MinDepth: 1, PremiumFloor: 1, TickFloor: 0.05, DepthTarget: 100,
	FreshnessTauMs: 15000, MaxPairDispersionMs: 2000,
	MaxSnapshotDispersionMs: 10000, FutureTimestampToleranceMs: 1000,
	ZeroBidPolicy: "diagnostic_only",
}

// CleanQuote is quotes.ts cleanQuote. It returns the cleaned quote, or the rejection
// when the quote is unusable. quote nil is undefined. It throws (panics) on a
// non-finite valuation time.
func CleanQuoteFor(metadata OptionMetadata, quote *MarketQuote, now float64, policy QuotePolicy) (*CleanQuote, *QuoteRejection) {
	reasons := []string{}
	reject := func() (*CleanQuote, *QuoteRejection) {
		return nil, &QuoteRejection{Token: metadata.Token, Strike: P(metadata.Strike), Side: PS(metadata.Side), Reasons: reasons}
	}
	if !isFinite(now) {
		throw("Invalid valuation timestamp.")
	}
	if quote == nil {
		reasons = append(reasons, "missing_quote")
		return reject()
	}
	if quote.Token != metadata.Token || quote.Bid == nil || quote.Ask == nil {
		reasons = append(reasons, "invalid_quote")
		return reject()
	}
	bid, ask, bidDepth, askDepth := *quote.Bid, *quote.Ask, quote.BidDepth, quote.AskDepth
	if !isFinite(bid) || !isFinite(ask) || !isFinite(bidDepth) || !isFinite(askDepth) ||
		bid < 0 || ask <= 0 || bidDepth < 0 || askDepth < 0 ||
		!isSafeInteger(bidDepth) || !isSafeInteger(askDepth) || !isFinite(quote.Version) || quote.Version < 0 {
		reasons = append(reasons, "invalid_quote")
		return reject()
	}
	if ask < bid {
		reasons = append(reasons, "crossed_quote")
	}
	received := DateParse(quote.ReceiveTimestamp)
	var exchanged *float64
	if quote.ExchangeTimestamp != nil {
		e := DateParse(*quote.ExchangeTimestamp)
		exchanged = &e
	}
	if !isFinite(received) || (exchanged != nil && !isFinite(*exchanged)) {
		reasons = append(reasons, "invalid_quote_timestamp")
		return reject()
	}
	timestamp := received
	if exchanged != nil {
		timestamp = *exchanged
	}
	age := now - timestamp
	if age < -policy.FutureTimestampToleranceMs || received > now+policy.FutureTimestampToleranceMs ||
		(exchanged != nil && *exchanged > received+policy.FutureTimestampToleranceMs) {
		reasons = append(reasons, "future_quote_timestamp")
	}
	if age > policy.MaxAgeMs || now-received > policy.MaxAgeMs {
		reasons = append(reasons, "stale_quote")
	}
	mid := bid/2 + ask/2
	spread := ask - bid
	relative := spread / math.Max(mid, policy.PremiumFloor)
	zeroBid := bid == 0
	if zeroBid && policy.ZeroBidPolicy == "exclude" {
		reasons = append(reasons, "zero_bid_low_information")
	}
	if !zeroBid && (relative > policy.MaxRelativeSpread || spread > policy.MaxAbsoluteSpread) {
		reasons = append(reasons, "wide_spread")
	}
	depth := math.Min(bidDepth, askDepth)
	if !zeroBid && depth < policy.MinDepth {
		reasons = append(reasons, "insufficient_depth")
	}
	if zeroBid && askDepth < policy.MinDepth {
		reasons = append(reasons, "insufficient_depth")
	}
	if len(reasons) > 0 {
		return reject()
	}
	availableDepth := depth
	if zeroBid {
		availableDepth = askDepth
	}
	positiveAge := math.Max(0, age)
	weight := 0.0
	if !zeroBid {
		weight = jsmath.Exp(-positiveAge/policy.FreshnessTauMs) * math.Min(1, availableDepth/policy.DepthTarget)
	}
	basis := "exchange"
	if exchanged == nil {
		basis = "receive"
	}
	quoteReasons := []string{}
	switch {
	case zeroBid:
		quoteReasons = []string{"zero_bid_low_information", "diagnostic_only_no_midpoint_calibration"}
	case exchanged == nil:
		quoteReasons = []string{"receive_time_freshness"}
	}
	return &CleanQuote{
		MarketQuote: *quote, Mid: mid, Spread: spread, RelativeSpread: relative, AgeMs: positiveAge,
		FreshnessBasis: basis, QuoteTimestamp: ISOString(timestamp), AvailableDepth: availableDepth, Weight: weight,
		H:                   math.Max(math.Max(spread/2, metadata.TickSize), policy.TickFloor),
		CalibrationEligible: !zeroBid, Reasons: quoteReasons,
	}, nil
}

// TokenReasons is an excluded token with its reasons.
type TokenReasons struct {
	Token   float64  `json:"token"`
	Reasons []string `json:"reasons"`
}

// CoherentResult is the outcome of CoherentSnapshot.
type CoherentResult struct {
	Eligible     []CleanQuote
	Excluded     []TokenReasons
	DispersionMs float64
}

// CoherentSnapshot is quotes.ts coherentSnapshot: synchronise a cross-section to its
// newest eligible timestamp, retaining exclusion evidence.
func CoherentSnapshot(quotes []CleanQuote, policy QuotePolicy) CoherentResult {
	calibration := []CleanQuote{}
	for _, q := range quotes {
		if q.CalibrationEligible {
			calibration = append(calibration, q)
		}
	}
	if len(calibration) == 0 {
		return CoherentResult{Eligible: []CleanQuote{}, Excluded: []TokenReasons{}}
	}
	times := make([]float64, len(calibration))
	for i, q := range calibration {
		times[i] = DateParse(q.QuoteTimestamp)
	}
	newest := jsMax(times...)
	eligible := []CleanQuote{}
	keep := newNumberSet()
	eligibleTimes := []float64{}
	for i, q := range calibration {
		if newest-times[i] <= policy.MaxSnapshotDispersionMs {
			eligible = append(eligible, q)
			keep.add(q.Token)
			eligibleTimes = append(eligibleTimes, times[i])
		}
	}
	excluded := []TokenReasons{}
	for _, q := range calibration {
		if !keep.has(q.Token) {
			excluded = append(excluded, TokenReasons{Token: q.Token, Reasons: []string{"snapshot_time_dispersion"}})
		}
	}
	dispersion := 0.0
	if len(eligible) > 1 {
		dispersion = newest - jsMin(eligibleTimes...)
	}
	return CoherentResult{Eligible: eligible, Excluded: excluded, DispersionMs: dispersion}
}
