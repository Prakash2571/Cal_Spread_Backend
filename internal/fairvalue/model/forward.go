package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// ForwardConfig is forward.ts ForwardConfig (field order = JSON order).
type ForwardConfig struct {
	MinPairs              float64 `json:"min_pairs"`
	HuberDelta            float64 `json:"huber_delta"`
	Refine                bool    `json:"refine"`
	RefinementIterations  float64 `json:"refinement_iterations"`
	OutlierScale          float64 `json:"outlier_scale"`
	MaxPairDispersionMs   float64 `json:"max_pair_dispersion_ms"`
	TickFloor             float64 `json:"tick_floor"`
	MaxRelativeDispersion float64 `json:"max_relative_dispersion"`
}

// DefaultForwardConfig is forward.ts DEFAULT_FORWARD_CONFIG.
var DefaultForwardConfig = ForwardConfig{
	MinPairs: 3, HuberDelta: 1.5, Refine: true, RefinementIterations: 30,
	OutlierScale: 6, MaxPairDispersionMs: 2000, TickFloor: 0.05, MaxRelativeDispersion: 0.005,
}

// WeightedValue is one input of WeightedMedian.
type WeightedValue struct{ Value, Weight float64 }

// WeightedMedian is forward.ts weightedMedian: the lower weighted median of the finite,
// positively weighted values. It throws when there are none.
func WeightedMedian(values []WeightedValue) float64 {
	eligible := []WeightedValue{}
	for _, v := range values {
		if isFinite(v.Value) && isFinite(v.Weight) && v.Weight > 0 {
			eligible = append(eligible, v)
		}
	}
	stableSortBy(eligible, func(v WeightedValue) float64 { return v.Value })
	total := 0.0
	for _, v := range eligible {
		total += v.Weight
	}
	if len(eligible) == 0 || !isFinite(total) {
		throw("Weighted median has no finite positive weights.")
	}
	cumulative := 0.0
	for _, item := range eligible {
		cumulative += item.Weight
		if cumulative >= total/2 {
			return item.Value
		}
	}
	return eligible[len(eligible)-1].Value
}

// Huber is forward.ts huber.
func Huber(value, delta float64) float64 {
	a := math.Abs(value)
	if a <= delta {
		return float64(value*value) / 2
	}
	return delta * (a - delta/2)
}

// ForwardArgs are the inputs of EstimateOptionsForward. Config nil means the default;
// ExcludeStrike nil is undefined.
type ForwardArgs struct {
	Metadata      []OptionMetadata
	Quotes        []CleanQuote
	D             float64
	Config        *ForwardConfig
	ExcludeStrike *float64
}

type strikePair struct {
	call, put *OptionMetadata
}

// EstimateOptionsForward is forward.ts estimateOptionsForward: a robust multi-pair
// put-call-parity forward.
func EstimateOptionsForward(a ForwardArgs) ForwardResult {
	d := a.D
	cfg := DefaultForwardConfig
	if a.Config != nil {
		cfg = *a.Config
	}
	if !isFinite(d) || d <= 0 {
		throw("Forward estimation requires positive finite discount factor.")
	}
	byToken := map[float64]*CleanQuote{}
	for i := range a.Quotes {
		q := &a.Quotes[i]
		if q.CalibrationEligible && q.Weight > 0 {
			byToken[q.Token] = q
		}
	}
	strikeOrder := []float64{}
	byStrike := map[float64]*strikePair{}
	for i := range a.Metadata {
		inst := &a.Metadata[i]
		if a.ExcludeStrike != nil && inst.Strike == *a.ExcludeStrike {
			continue
		}
		pair := byStrike[inst.Strike]
		if pair == nil {
			pair = &strikePair{}
			byStrike[inst.Strike] = pair
			strikeOrder = append(strikeOrder, inst.Strike)
		}
		if inst.Side == CE {
			pair.call = inst
		} else {
			pair.put = inst
		}
	}
	excluded := []ExcludedPair{}
	pairs := []ForwardPair{}
	for _, strike := range strikeOrder {
		call, put := byStrike[strike].call, byStrike[strike].put
		reasons := []string{}
		if call == nil || put == nil {
			excluded = append(excluded, ExcludedPair{Strike: strike, Reasons: []string{"missing_call_put_metadata"}})
			continue
		}
		c, p := byToken[call.Token], byToken[put.Token]
		if c == nil || p == nil {
			excluded = append(excluded, ExcludedPair{Strike: strike, Reasons: []string{"call_put_quote_ineligible"}})
			continue
		}
		if call.Style != "european" || put.Style != "european" || call.Underlying != put.Underlying ||
			call.ExpiryTimestamp != put.ExpiryTimestamp || call.LotSize != put.LotSize ||
			call.SettlementUnderlying != put.SettlementUnderlying {
			reasons = append(reasons, "incoherent_pair_metadata")
		}
		if c.FreshnessBasis != p.FreshnessBasis ||
			math.Abs(DateParse(c.QuoteTimestamp)-DateParse(p.QuoteTimestamp)) > cfg.MaxPairDispersionMs ||
			math.Abs(DateParse(c.ReceiveTimestamp)-DateParse(p.ReceiveTimestamp)) > cfg.MaxPairDispersionMs {
			reasons = append(reasons, "incoherent_pair_timestamps")
		}
		forward := strike + (c.Mid-p.Mid)/d
		lower := strike + (*c.Bid-*p.Ask)/d
		upper := strike + (*c.Ask-*p.Bid)/d
		if !isFinite(forward) || forward <= 0 || !isFinite(lower) || !isFinite(upper) || upper <= 0 {
			reasons = append(reasons, "invalid_pair_forward")
		}
		if len(reasons) > 0 {
			excluded = append(excluded, ExcludedPair{Strike: strike, Reasons: reasons})
			continue
		}
		scale := jsMax((c.Spread+p.Spread)/2, call.TickSize, put.TickSize, cfg.TickFloor)
		callBounds, putBounds := PriceBounds(forward, strike, d, CE), PriceBounds(forward, strike, d, PE)
		tolerance := jsMax(call.TickSize, put.TickSize, cfg.TickFloor) * .02
		if c.Mid < callBounds.Lower-tolerance || c.Mid > callBounds.Upper+tolerance ||
			p.Mid < putBounds.Lower-tolerance || p.Mid > putBounds.Upper+tolerance {
			excluded = append(excluded, ExcludedPair{Strike: strike, Reasons: []string{"pair_premiums_outside_european_bounds"}})
			continue
		}
		pairs = append(pairs, ForwardPair{Strike: strike, Forward: forward, Lower: lower, Upper: upper,
			Weight: math.Min(c.Weight, p.Weight), Scale: scale, CallToken: call.Token, PutToken: put.Token, Residual: 0})
	}
	diagnostics := []Diagnostic{}
	unavailable := func(reason string, selected []ForwardPair) ForwardResult {
		return ForwardResult{Available: false, Source: "unavailable", PairCount: float64(len(selected)),
			Pairs: append([]ForwardPair{}, selected...), ExcludedPairs: append([]ExcludedPair{}, excluded...),
			Assumptions: []string{},
			Diagnostics: append(append([]Diagnostic{}, diagnostics...), Diagnostic{Code: "forward_unavailable", Severity: "warning", Message: reason})}
	}
	if float64(len(pairs)) < cfg.MinPairs {
		return unavailable("Need "+jsjson.FormatNumber(cfg.MinPairs)+" eligible call-put pairs, have "+jsjson.FormatNumber(float64(len(pairs)))+".", pairs)
	}
	weighted := func(list []ForwardPair, value func(ForwardPair) float64) []WeightedValue {
		out := make([]WeightedValue, len(list))
		for i, p := range list {
			out[i] = WeightedValue{Value: value(p), Weight: p.Weight}
		}
		return out
	}
	f0 := WeightedMedian(weighted(pairs, func(p ForwardPair) float64 { return p.Forward }))
	mad := WeightedMedian(weighted(pairs, func(p ForwardPair) float64 { return math.Abs(p.Forward - f0) }))
	selected := []ForwardPair{}
	for _, p := range pairs {
		limit := cfg.OutlierScale * jsMax(1.4826*mad, p.Scale/d, cfg.TickFloor/d)
		if math.Abs(p.Forward-f0) <= limit {
			selected = append(selected, p)
		} else {
			excluded = append(excluded, ExcludedPair{Strike: p.Strike, Reasons: []string{"robust_forward_outlier"}})
		}
	}
	if float64(len(selected)) < cfg.MinPairs {
		return unavailable("Insufficient coherent pairs after robust outlier exclusion.", selected)
	}
	estimate := WeightedMedian(weighted(selected, func(p ForwardPair) float64 { return p.Forward }))
	if cfg.Refine {
		// IRLS solves the convex one-dimensional Huber objective on standardised parity
		// residuals. Base weights are min(call freshness x depth, put freshness x depth).
		for iteration := 0.0; iteration < cfg.RefinementIterations; iteration++ {
			numerator, denominator := 0.0, 0.0
			for _, p := range selected {
				residual := float64(d*(p.Forward-estimate)) / p.Scale
				robust := 1.0
				if math.Abs(residual) > cfg.HuberDelta {
					robust = cfg.HuberDelta / math.Abs(residual)
				}
				weight := float64(p.Weight*robust) / float64(p.Scale*p.Scale)
				numerator += float64(weight * p.Forward)
				denominator += weight
			}
			next := numerator / denominator
			if !isFinite(next) || next <= 0 {
				return unavailable("Robust forward refinement failed.", selected)
			}
			change := math.Abs(next - estimate)
			estimate = next
			if change <= cfg.TickFloor*1e-6 {
				break
			}
		}
	}
	dispersion := WeightedMedian(weighted(selected, func(p ForwardPair) float64 { return math.Abs(p.Forward - estimate) }))
	lowers, uppers := make([]float64, len(selected)), make([]float64, len(selected))
	for i, p := range selected {
		lowers[i], uppers[i] = p.Lower, p.Upper
	}
	lower, upper := jsMax(lowers...), jsMin(uppers...)
	compatible := lower <= upper
	if !compatible {
		diagnostics = append(diagnostics, Diagnostic{Code: "incompatible_forward_intervals", Severity: "warning",
			Message: "Call-put bid/ask forward intervals have no common intersection; inspect stale/noisy pairs."})
	}
	if dispersion/estimate > cfg.MaxRelativeDispersion {
		return unavailable("Options-implied forward dispersion exceeds the configured quality limit.", selected)
	}
	outPairs := make([]ForwardPair, len(selected))
	for i, p := range selected {
		p.Residual = d * (p.Forward - estimate)
		outPairs[i] = p
	}
	return ForwardResult{Available: true, Value: P(estimate), Source: "robust_options_implied", PairCount: float64(len(selected)),
		Dispersion: P(dispersion), Interval: &ForwardInterval{Lower: lower, Upper: upper, Compatible: compatible},
		Pairs: outPairs, ExcludedPairs: excluded, Diagnostics: diagnostics, SuccessOrder: true,
		Assumptions: []string{
			"European parity; fixed supplied D. Weighted-median initialization; Huber delta " + jsjson.FormatNumber(cfg.HuberDelta) +
				"; uncertainty scale=max((call spread+put spread)/2, ticks).",
			"Freshness/depth weights and robust-outlier tuning are configurable engineering heuristics.",
		}}
}

// ForwardFuture is a cleaned futures quote for ResolveForward.
type ForwardFuture struct {
	ExpiryTimestamp string
	Quote           CleanQuote
}

// ResolveArgs are the inputs of ResolveForward.
type ResolveArgs struct {
	Options  ForwardResult
	Expiry   string
	Now      float64
	Curve    *DiscountCurveSpec
	Futures  []ForwardFuture
	Spot     *Spot
	Carry    *CarrySpec
	MaxAgeMs float64
}

// ResolveForward is forward.ts resolveForward: the options-implied forward when
// available, else a fresh exact-expiry future, else verified spot carry.
func ResolveForward(a ResolveArgs) ForwardResult {
	if a.Options.Available {
		return a.Options
	}
	assumptions := []string{}
	resolved := func(value float64, source string) ForwardResult {
		out := a.Options
		out.SuccessOrder = false
		out.Available = true
		out.Value = P(value)
		out.Source = source
		out.Assumptions = append(append([]string{}, a.Options.Assumptions...), assumptions...)
		return out
	}
	for _, f := range a.Futures {
		if f.ExpiryTimestamp == a.Expiry && f.Quote.CalibrationEligible && f.Quote.AgeMs <= a.MaxAgeMs {
			if f.Quote.Mid > 0 {
				assumptions = append(assumptions, "Fresh exact-expiry futures midpoint approximates forward; deterministic rates and no material futures/forward convexity adjustment.")
				return resolved(f.Quote.Mid, "matching_expiry_futures")
			}
			break // the first match decides
		}
	}
	spot, carry := a.Spot, a.Carry
	if spot == nil || carry == nil || !carry.Verified || !isFinite(spot.Value) || spot.Value <= 0 {
		return a.Options
	}
	spotTime := DateParse(spot.Timestamp)
	if !isFinite(spotTime) || a.Now-spotTime > a.MaxAgeMs || spotTime > a.Now || len(carry.CorporateActions) > 0 {
		return a.Options
	}
	t := YearFraction(a.Expiry, a.Now)
	if t <= 0 {
		return a.Options
	}
	discount := DiscountAt(a.Curve, t)
	if discount.D == nil {
		return a.Options
	}
	var value float64
	switch {
	case len(carry.Dividends) > 0:
		pv := 0.0
		expiryTime := DateParse(a.Expiry)
		for _, event := range carry.Dividends {
			at := DateParse(event.Timestamp)
			if !isFinite(at) || !isFinite(event.Amount) || event.Amount < 0 {
				return a.Options
			}
			if at <= a.Now || at >= expiryTime {
				continue
			}
			eventD := DiscountAt(a.Curve, YearFraction(at, a.Now)).D
			if eventD == nil {
				return a.Options
			}
			pv += float64(event.Amount * *eventD)
		}
		value = (spot.Value - pv) / *discount.D
		assumptions = append(assumptions, "Verified deterministic carry with known cash dividends strictly before expiry: (spot−PV dividends)/D; no borrow/funding basis or corporate-action adjustment.")
	case carry.Proportional && carry.DividendYield != nil && isFinite(*carry.DividendYield):
		value = spot.Value * jsmath.Exp(-*carry.DividendYield*t) / *discount.D
		assumptions = append(assumptions, "Verified proportional carry with continuous dividend yield: S exp((r−q)T); no borrow/funding basis.")
	default:
		return a.Options
	}
	if !isFinite(value) || value <= 0 {
		return a.Options
	}
	assumptions = append(assumptions, "Carry source "+carry.Source+", version "+carry.Version+", as of "+carry.AsOf+".")
	return resolved(value, "verified_spot_carry")
}

// EmptyForward is pipeline.ts emptyForward().
func EmptyForward() ForwardResult {
	return ForwardResult{Available: false, Source: "unavailable", Pairs: []ForwardPair{}, ExcludedPairs: []ExcludedPair{},
		Assumptions: []string{}, Diagnostics: []Diagnostic{}}
}

// stableSortBy sorts by key ascending, keeping equal keys in order (the
// (a, b) => key(a) - key(b) comparator on finite keys).
func stableSortBy[T any](items []T, key func(T) float64) {
	sortStable(items, func(a, b T) bool { return key(a) < key(b) })
}
