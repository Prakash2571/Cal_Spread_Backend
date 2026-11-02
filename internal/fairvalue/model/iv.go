package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// DefaultIvConfig is iv.ts DEFAULT_IV_CONFIG.
var DefaultIvConfig = IvConfig{
	InitialHigh: 0.5, MaxVolatility: 5, MaxExpansions: 8, MaxIterations: 120,
	PriceTolerance: 1e-9, TickToleranceFraction: 0.01, VolatilityTolerance: 1e-9,
	LowVegaThreshold: 1e-6, MaxIvUncertainty: 0.10,
}

// IvArgs are the inputs of InvertIv. Uncertainty nil is undefined; Config nil means
// DefaultIvConfig.
type IvArgs struct {
	F, K, T, D, Price float64
	Side              string
	Tick              float64
	Uncertainty       *float64
	Config            *IvConfig
}

func ivResult(status, reason string, iv *float64, iterations float64, residual, vega *float64) IvResult {
	return IvResult{Status: status, Reason: reason, Iv: iv, Iterations: iterations, Residual: residual, Vega: vega}
}

// InvertIv is iv.ts invertIv: bisection with a maintained bracket. Ill-conditioning is
// returned with the computed IV, not hidden. It never throws.
func InvertIv(a IvArgs) IvResult {
	f, k, t, d, price, side, tick := a.F, a.K, a.T, a.D, a.Price, a.Side, a.Tick
	cfg := DefaultIvConfig
	if a.Config != nil {
		cfg = *a.Config
	}
	if !isFinite(f) || !isFinite(k) || !isFinite(t) || !isFinite(d) || !isFinite(price) || !isFinite(tick) ||
		f <= 0 || k <= 0 || d <= 0 || price < 0 || tick <= 0 || (side != CE && side != PE) ||
		!isFinite(f*d) || !isFinite(k*d) || (a.Uncertainty != nil && (!isFinite(*a.Uncertainty) || *a.Uncertainty < 0)) {
		return ivResult("invalid_input", "Finite positive F, K, D, tick and nonnegative premium are required.", nil, 0, nil, nil)
	}
	if t <= 0 {
		return ivResult("expired", "Expired contract: use its settlement underlying, not implied volatility.", nil, 0, nil, nil)
	}
	if !isFinite(t * cfg.MaxVolatility * cfg.MaxVolatility) {
		return ivResult("invalid_input", "IV total variance exceeds numeric range.", nil, 0, nil, nil)
	}
	for _, v := range []float64{cfg.InitialHigh, cfg.MaxVolatility, cfg.MaxExpansions, cfg.MaxIterations, cfg.PriceTolerance,
		cfg.TickToleranceFraction, cfg.VolatilityTolerance, cfg.LowVegaThreshold, cfg.MaxIvUncertainty} {
		if !isFinite(v) || v < 0 {
			return ivResult("invalid_input", "Invalid IV solver configuration.", nil, 0, nil, nil)
		}
	}
	if cfg.InitialHigh <= 0 || cfg.MaxVolatility <= 0 || cfg.MaxIterations < 1 || cfg.VolatilityTolerance <= 0 {
		return ivResult("invalid_input", "Invalid IV solver configuration.", nil, 0, nil, nil)
	}
	bounds := PriceBounds(f, k, d, side)
	tolerance := math.Max(math.Max(cfg.PriceTolerance, tick*cfg.TickToleranceFraction), 32*epsilon*bounds.Upper)
	if price < bounds.Lower-tolerance || price > bounds.Upper+tolerance {
		return ivResult("outside_bounds", "Premium outside European bounds ["+jsjson.FormatNumber(bounds.Lower)+", "+
			jsjson.FormatNumber(bounds.Upper)+"].", nil, 0, nil, nil)
	}
	if price <= bounds.Lower+tolerance {
		return ivResult("zero_volatility", "Premium at the tick-aware lower bound; IV is zero/undetermined below tick resolution.",
			P(0), 0, P(bounds.Lower-price), P(0))
	}
	// The upper bound is approached only as sigma -> infinity, not a finite IV.
	if price >= bounds.Upper-tolerance {
		return ivResult("no_finite_solution", "Premium at the upper bound has no finite-volatility solution.", nil, 0, nil, nil)
	}
	low := 0.0
	high := math.Min(cfg.InitialHigh, cfg.MaxVolatility)
	highError := BlackFromIv(f, k, t, d, high, side) - price
	expansions := 0.0
	for highError < 0 && high < cfg.MaxVolatility && expansions < cfg.MaxExpansions {
		high = math.Min(high*2, cfg.MaxVolatility)
		highError = BlackFromIv(f, k, t, d, high, side) - price
		expansions++
	}
	if highError < 0 {
		return ivResult("bracket_failure", "No root bracket within maximum decimal IV "+jsjson.FormatNumber(cfg.MaxVolatility)+".", nil, 0, nil, nil)
	}
	finish := func(iv, iteration, residual float64) IvResult {
		root := iv * math.Sqrt(t)
		d1 := float64((jsmath.Log(f)-jsmath.Log(k))/root) + root/2
		vega := float64(float64(d*f)*NormalPdf(d1)) * math.Sqrt(t)
		u := tolerance
		if a.Uncertainty != nil {
			u = *a.Uncertainty
		}
		uncertainty := math.Max(u, tolerance)
		if vega < cfg.LowVegaThreshold || uncertainty/vega > cfg.MaxIvUncertainty {
			return ivResult("low_vega", "Computed IV is ill-conditioned: quote/tick uncertainty is large relative to vega.",
				P(iv), iteration, P(residual), P(vega))
		}
		return ivResult("valid", "Bracketed IV inversion converged.", P(iv), iteration, P(residual), P(vega))
	}
	for iteration := 1.0; iteration <= cfg.MaxIterations; iteration++ {
		iv := (low + high) / 2
		residual := BlackFromIv(f, k, t, d, iv, side) - price
		// Shrink the volatility bracket as well, even when the premium already rounds to
		// the target; finish() separately reports the price/vega condition number.
		if high-low <= cfg.VolatilityTolerance && math.Abs(residual) <= math.Max(tolerance, cfg.PriceTolerance) {
			return finish(iv, iteration, residual)
		}
		if residual > 0 {
			high = iv
		} else {
			low = iv
		}
	}
	return ivResult("iteration_failure", "IV inversion exceeded its iteration budget.", nil, cfg.MaxIterations, nil, nil)
}
