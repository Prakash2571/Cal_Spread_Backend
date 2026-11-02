package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// PriceGridArgs are the inputs of ValidatePriceGrid. Variance returns nil for null.
type PriceGridArgs struct {
	F, D     float64
	Strikes  []float64
	Variance func(k float64) *float64
	Tick     float64
	Config   SmileConfig
}

// GridPrice is one validated strike.
type GridPrice struct {
	Strike, Call, Put float64
}

// PriceGridResult is the outcome of ValidatePriceGrid.
type PriceGridResult struct {
	Valid       bool
	Diagnostics []Diagnostic
	Prices      []GridPrice
}

// ValidatePriceGrid is validation.ts validatePriceGrid: actual strike spacing, CE/PE
// monotonicity and convexity, parity and bounds.
func ValidatePriceGrid(a PriceGridArgs) PriceGridResult {
	diagnostics := []Diagnostic{}
	prices := []GridPrice{}
	f, d, tick := a.F, a.D, a.Tick
	strikes := distinctNumbers(a.Strikes)
	sortNumbers(strikes)
	if len(strikes) == 0 {
		return PriceGridResult{Diagnostics: []Diagnostic{{Code: "empty_price_validation_grid", Severity: "error",
			Message: "No supported strikes for price validation."}}, Prices: []GridPrice{}}
	}
	if !isFinite(f) || !isFinite(d) || !isFinite(tick) || f <= 0 || d <= 0 || tick <= 0 {
		return PriceGridResult{Diagnostics: []Diagnostic{{Code: "invalid_price_validation_inputs", Severity: "error",
			Message: "Finite positive forward, discount and tick are required."}}, Prices: []GridPrice{}}
	}
	priceTolerance := math.Max(tick*a.Config.PriceToleranceTicks, 64*epsilon*d*f)
	for _, strike := range strikes {
		if !isFinite(strike) || strike <= 0 {
			diagnostics = append(diagnostics, Diagnostic{Code: "invalid_validation_strike", Severity: "error",
				Message: "Validation strike must be positive finite."})
			continue
		}
		w := a.Variance(jsmath.Log(strike) - jsmath.Log(f))
		if w == nil || !isFinite(*w) || *w < 0 {
			diagnostics = append(diagnostics, Diagnostic{Code: "variance_unavailable", Severity: "error",
				Message: "Variance unavailable at validation strike.", Strike: P(strike)})
			continue
		}
		call := BlackPrice(BlackInput{F: f, K: strike, D: d, W: *w, Side: CE})
		put := BlackPrice(BlackInput{F: f, K: strike, D: d, W: *w, Side: PE})
		prices = append(prices, GridPrice{Strike: strike, Call: call, Put: put})
		parity := call - put - float64(d*(f-strike))
		if math.Abs(parity) > priceTolerance {
			diagnostics = append(diagnostics, Diagnostic{Code: "parity_violation", Severity: "error",
				Message: "Model put-call parity failed.", Strike: P(strike), Value: P(parity)})
		}
		for _, side := range [2]string{CE, PE} {
			bounds := PriceBounds(f, strike, d, side)
			price := put
			if side == CE {
				price = call
			}
			if price < bounds.Lower-priceTolerance || price > bounds.Upper+priceTolerance {
				diagnostics = append(diagnostics, Diagnostic{Code: "price_bounds_violation", Severity: "error",
					Message: side + " outside European bounds.", Strike: P(strike), Value: P(price)})
			}
		}
	}
	type slopes struct{ call, put, tolerance float64 }
	var previous *slopes
	for i := 0; i < len(prices)-1; i++ {
		lo, hi := prices[i], prices[i+1]
		spacing := hi.Strike - lo.Strike
		callSlope := (hi.Call - lo.Call) / spacing
		putSlope := (hi.Put - lo.Put) / spacing
		tolerance := 2*priceTolerance/spacing + 1e-10
		if callSlope < -d-tolerance || callSlope > tolerance {
			diagnostics = append(diagnostics, Diagnostic{Code: "call_slope_violation", Severity: "error",
				Message: "CE slope outside [-D,0].", Strike: P(lo.Strike), Value: P(callSlope)})
		}
		if putSlope < -tolerance || putSlope > d+tolerance {
			diagnostics = append(diagnostics, Diagnostic{Code: "put_slope_violation", Severity: "error",
				Message: "PE slope outside [0,D].", Strike: P(lo.Strike), Value: P(putSlope)})
		}
		if previous != nil && callSlope < previous.call-tolerance-previous.tolerance {
			diagnostics = append(diagnostics, Diagnostic{Code: "call_convexity_violation", Severity: "error",
				Message: "CE slopes decrease across actual strike spacing.", Strike: P(lo.Strike), Value: P(callSlope - previous.call)})
		}
		if previous != nil && putSlope < previous.put-tolerance-previous.tolerance {
			diagnostics = append(diagnostics, Diagnostic{Code: "put_convexity_violation", Severity: "error",
				Message: "PE slopes decrease across actual strike spacing.", Strike: P(lo.Strike), Value: P(putSlope - previous.put)})
		}
		previous = &slopes{call: callSlope, put: putSlope, tolerance: tolerance}
	}
	return PriceGridResult{Valid: len(diagnostics) == 0, Diagnostics: diagnostics, Prices: prices}
}

// IntermediateStrikes is validation.ts intermediateStrikes: the distinct sorted strikes
// plus subdivisions-1 points inside every gap, sorted (duplicates possible).
func IntermediateStrikes(strikes []float64, subdivisions float64) []float64 {
	sorted := distinctNumbers(strikes)
	sortNumbers(sorted)
	all := append([]float64(nil), sorted...)
	for i := 0; i < len(sorted)-1; i++ {
		for j := 1.0; j < subdivisions; j++ {
			all = append(all, sorted[i]+float64((sorted[i+1]-sorted[i])*j)/subdivisions)
		}
	}
	sortNumbers(all)
	return all
}
