package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// UnavailableSmile is smile.ts unavailableSmile.
func UnavailableSmile(reason string) SmileModel {
	return SmileModel{
		Method: "unavailable", Nodes: []SmileNode{}, Valid: false,
		Diagnostics: []Diagnostic{{Code: "smile_unavailable", Severity: "warning", Message: reason}},
		Calibration: Calibration{OptimizerStatus: "unsupported", Residuals: []FitResidual{}, Rejected: []Rejected{}},
	}
}

// InterpolateVariance is smile.ts interpolateVariance: piecewise-linear total variance
// inside the node support, nil outside it or across a gap wider than maxGap.
func InterpolateVariance(nodes []SmileNode, k, maxGap float64) *float64 {
	if !isFinite(k) || len(nodes) == 0 || k < nodes[0].K-1e-12 || k > nodes[len(nodes)-1].K+1e-12 {
		return nil
	}
	for _, n := range nodes {
		if math.Abs(n.K-k) < 1e-12 {
			return P(n.W)
		}
	}
	i := -1
	for j, n := range nodes {
		if n.K > k {
			i = j
			break
		}
	}
	if i <= 0 {
		return nil
	}
	a, b := nodes[i-1], nodes[i]
	if b.K-a.K > maxGap {
		return nil
	}
	alpha := (k - a.K) / (b.K - a.K)
	return P(float64((1-alpha)*a.W) + float64(alpha*b.W))
}

// VarianceAt is smile.ts varianceAt: the model total variance at log-moneyness k, nil
// where the smile does not support k.
func VarianceAt(model *SmileModel, k float64, cfg SmileConfig, research bool) *float64 {
	if !model.Valid || model.Support == nil || !isFinite(k) {
		return nil
	}
	minK, maxK := model.Support.MinK, model.Support.MaxK
	if k < minK-1e-12 || k > maxK+1e-12 {
		if !research || model.Method != "svi" || math.Max(minK-k, k-maxK) > cfg.StrikeExtrapolationK {
			return nil
		}
	}
	if model.Method == "svi" && model.Parameters != nil {
		variance := SviVariance(*model.Parameters, k)
		g := SviDerivatives(*model.Parameters, k).G
		if isFinite(variance) && variance >= 0 && g != nil && *g >= -cfg.ButterflyTolerance {
			return P(variance)
		}
		return nil
	}
	return InterpolateVariance(model.Nodes, k, cfg.MaxInterpolationGap)
}

type residualSummary struct {
	residuals           []FitResidual
	normalizedRmse      float64
	insideSpreadPercent float64
}

// calibrationResiduals is smile.ts calibrationResiduals. It throws (via BlackPrice)
// when the variance function yields a negative total variance.
func calibrationResiduals(observations []CalibrationObservation, variance func(k float64) *float64, f, d float64) residualSummary {
	residuals := []FitResidual{}
	sum, weights := 0.0, 0.0
	inside := 0
	for _, obs := range observations {
		w := variance(obs.K)
		if w == nil {
			continue
		}
		price := BlackPrice(BlackInput{F: f, K: obs.Strike, D: d, W: *w, Side: obs.Side})
		residual := price - obs.Quote.Mid
		weight := obs.Quote.Weight * obs.DependenceFactor
		standardized := residual / obs.Quote.H
		sum += float64(weight * float64(standardized*standardized))
		weights += weight
		in := price >= *obs.Quote.Bid-1e-8 && price <= *obs.Quote.Ask+1e-8
		if in {
			inside++
		}
		residuals = append(residuals, FitResidual{Token: obs.Token, Strike: obs.Strike, Side: obs.Side, ModelPrice: price,
			Residual: residual, StandardizedResidual: residual / obs.Quote.H, InsideSpread: in})
	}
	out := residualSummary{residuals: residuals, normalizedRmse: math.Inf(1)}
	if weights > 0 {
		out.normalizedRmse = math.Sqrt(sum / weights)
	}
	if len(residuals) > 0 {
		out.insideSpreadPercent = float64(100*inside) / float64(len(residuals))
	}
	return out
}

func minH(observations []CalibrationObservation) float64 {
	hs := make([]float64, len(observations))
	for i, o := range observations {
		hs[i] = o.Quote.H
	}
	return jsMin(hs...)
}

// FitInterpolation is smile.ts fitInterpolation: the explicit piecewise-linear
// total-variance fallback, validated on actual-spacing CE/PE prices between nodes too.
func FitInterpolation(observations []CalibrationObservation, f, d float64, cfg SmileConfig) SmileModel {
	start := perfNow()
	type agg struct{ k, total, weight float64 }
	order := []float64{}
	distinct := map[float64]*agg{}
	for _, obs := range observations {
		prev := distinct[obs.Strike]
		if prev == nil {
			prev = &agg{k: obs.K}
			distinct[obs.Strike] = prev
			order = append(order, obs.Strike)
		}
		weight := obs.Quote.Weight * obs.DependenceFactor
		prev.total += float64(weight * obs.W)
		prev.weight += weight
	}
	if float64(len(order)) < cfg.MinInterpolationStrike {
		return UnavailableSmile("Interpolation needs " + jsjson.FormatNumber(cfg.MinInterpolationStrike) +
			" distinct eligible strikes; have " + jsjson.FormatNumber(float64(len(order))) + ".")
	}
	aggs := make([]*agg, len(order))
	for i, s := range order {
		aggs[i] = distinct[s]
	}
	stableSortBy(aggs, func(a *agg) float64 { return a.k })
	nodes := make([]SmileNode, len(aggs))
	for i, a := range aggs {
		nodes[i] = SmileNode{K: a.k, W: a.total / a.weight}
	}
	for _, n := range nodes {
		if !isFinite(n.W) || n.W < 0 {
			return UnavailableSmile("Invalid interpolation variance nodes.")
		}
	}
	strikes := append([]float64(nil), order...)
	sortNumbers(strikes)
	model := UnavailableSmile("")
	model.Method = "validated_interpolation"
	model.Nodes = nodes
	model.Support = &SmileSupport{MinK: nodes[0].K, MaxK: nodes[len(nodes)-1].K, Strikes: strikes}
	knotNeighbors := []float64{}
	for _, strike := range strikes {
		for _, s := range [3]float64{strike * jsmath.Exp(-1e-5), strike, strike * jsmath.Exp(1e-5)} {
			if s >= strikes[0] && s <= strikes[len(strikes)-1] {
				knotNeighbors = append(knotNeighbors, s)
			}
		}
	}
	variance := func(k float64) *float64 { return InterpolateVariance(nodes, k, cfg.MaxInterpolationGap) }
	validation := ValidatePriceGrid(PriceGridArgs{F: f, D: d, Strikes: append(IntermediateStrikes(strikes, 8), knotNeighbors...),
		Variance: variance, Tick: minH(observations), Config: cfg})
	residuals := calibrationResiduals(observations, variance, f, d)
	model.Valid = validation.Valid && residuals.normalizedRmse <= cfg.MaxNormalizedRmse
	model.Diagnostics = append([]Diagnostic{{Code: "interpolation_fallback", Severity: "warning",
		Message: "Piecewise-linear total-variance interpolation within observed support, numerically validated; no global butterfly proof or wing extrapolation."}},
		validation.Diagnostics...)
	model.Calibration.Residuals = residuals.residuals
	model.Calibration.NormalizedRmse = P(residuals.normalizedRmse)
	model.Calibration.InsideSpreadPercent = P(residuals.insideSpreadPercent)
	model.Calibration.ObservationCount = float64(len(observations))
	model.Calibration.DistinctStrikes = float64(len(order))
	model.Calibration.DurationMs = perfNow() - start
	model.Calibration.OptimizerStatus = "interpolation_no_optimizer"
	if !model.Valid {
		model.Diagnostics = append(model.Diagnostics, Diagnostic{Code: "interpolation_invalid", Severity: "error",
			Message: "Fallback failed price-space or residual validation; valuation suppressed."})
	}
	return model
}

// FitSmile is smile.ts fitSmile: SVI first, the validated interpolation fallback when
// SVI is not valid (or when the configuration asks for interpolation).
func FitSmile(observations []CalibrationObservation, f, d float64, cfg SmileConfig) SmileModel {
	if cfg.Model == "interpolation" {
		return FitInterpolation(observations, f, d, cfg)
	}
	fitted := FitSvi(observations, f, d, cfg)
	if fitted.Valid {
		return fitted
	}
	fallback := FitInterpolation(observations, f, d, cfg)
	fallback.Diagnostics = append(append([]Diagnostic{}, fitted.Diagnostics...), fallback.Diagnostics...)
	fallback.Calibration.OptimizerStatus = fitted.Calibration.OptimizerStatus + "; " + fallback.Calibration.OptimizerStatus
	fallback.Calibration.OptimizerIterations = fitted.Calibration.OptimizerIterations
	fallback.Calibration.OptimizerStarts = fitted.Calibration.OptimizerStarts
	fallback.Calibration.DurationMs += fitted.Calibration.DurationMs
	if !fallback.Valid && fallback.Method == "validated_interpolation" {
		fallback.Calibration.OptimizerStatus += "; fallback_validation_failure"
	}
	return fallback
}

var sviStarts = [8][5]float64{
	{.85, .4, -.3, 0, .25},
	{.7, .7, -.65, .05, .4},
	{.8, .5, .3, -.05, .3},
	{.6, 1, 0, 0, .5},
	{.95, .15, -.1, 0, .15},
	{.5, 1.3, -.8, .2, .7},
	{.9, .3, .6, -.2, .2},
	{.8, .01, 0, 0, .4},
}

// FitSvi is smile.ts fitSvi: price-space Huber calibration with bounded deterministic
// multi-start optimisation.
func FitSvi(observations []CalibrationObservation, f, d float64, cfg SmileConfig) SmileModel {
	started := perfNow()
	allK := make([]float64, len(observations))
	for i, o := range observations {
		allK[i] = o.K
	}
	ks := distinctNumbers(allK)
	sortNumbers(ks)
	minK, maxK := 0.0, 0.0
	if len(ks) > 0 {
		minK, maxK = ks[0], ks[len(ks)-1]
	}
	leftWing, rightWing := 0, 0
	for _, k := range ks {
		if k < -cfg.AtmBand {
			leftWing++
		}
		if k > cfg.AtmBand {
			rightWing++
		}
	}
	if float64(len(ks)) < cfg.MinSviStrikes || maxK-minK < cfg.MinKSpan ||
		float64(leftWing) < cfg.MinEachWing || float64(rightWing) < cfg.MinEachWing {
		unavailable := UnavailableSmile("SVI needs at least " + jsjson.FormatNumber(cfg.MinSviStrikes) +
			" distinct, well-spread strikes (k span " + jsjson.FormatNumber(cfg.MinKSpan) + ", " +
			jsjson.FormatNumber(cfg.MinEachWing) + " per wing).")
		unavailable.Calibration.OptimizerStatus = "svi_insufficient_support"
		return unavailable
	}
	weightedW := make([]WeightedValue, len(observations))
	for i, o := range observations {
		weightedW[i] = WeightedValue{Value: o.W, Weight: o.Quote.Weight * o.DependenceFactor}
	}
	scale := WeightedMedian(weightedW)
	if scale <= cfg.VarianceFloor || !isFinite(scale) {
		return UnavailableSmile("SVI variance scale is unsupported.")
	}
	span := math.Max(maxK-minK, .05)
	toParameters := func(point []float64) SviParameters {
		minimum := point[0] * scale
		b := point[1] * scale / span
		rho := point[2]
		eta := point[4] * span
		return SviParameters{A: minimum - float64(float64(b*eta)*math.Sqrt(1-float64(rho*rho))), B: b, Rho: rho, M: point[3] * span, Eta: eta}
	}
	bounds := [][2]float64{
		{cfg.VarianceFloor / scale, 4},
		{0, math.Min(30, cfg.MaxWingSlope*span/scale)},
		{-.98, .98},
		{minK/span - 1, maxK/span + 1},
		{.005, 3},
	}
	checkK := append([]float64(nil), ks...)
	for i := 0; i < 41; i++ {
		checkK = append(checkK, -2+float64(i)/10)
	}
	weightSum := 0.0
	for _, o := range observations {
		weightSum += float64(o.Quote.Weight * o.DependenceFactor)
	}
	objective := func(point []float64) float64 {
		p := toParameters(point)
		if !BasicSviConstraints(p) || p.B*(1+math.Abs(p.Rho)) > cfg.MaxWingSlope {
			return 1e50
		}
		loss := 0.0
		for _, obs := range observations {
			w := SviVariance(p, obs.K)
			if !isFinite(w) || w <= 0 {
				return 1e50
			}
			price := BlackPrice(BlackInput{F: f, K: obs.Strike, D: d, W: w, Side: obs.Side})
			loss += float64(float64(obs.Quote.Weight*obs.DependenceFactor) * Huber((price-obs.Quote.Mid)/obs.Quote.H, cfg.HuberDelta))
		}
		densityPenalty := 0.0
		for _, k := range checkK {
			g := SviDerivatives(p, k).G
			if g == nil || !isFinite(*g) {
				return 1e50
			}
			m := math.Min(*g, 0)
			densityPenalty += float64(m * m)
		}
		// Regularisation discourages unnecessarily steep wings and shifted/narrow
		// curvature. The density penalty assists; final hard validation owns acceptance.
		inner := float64(point[1]*point[1]) + float64(.1*float64(point[3]*point[3])) + .001/float64(point[4]*point[4])
		return loss + float64(cfg.Regularization*inner) + float64(float64(weightSum*1e4)*densityPenalty)/float64(len(checkK))
	}
	minW := jsMin(allW(observations)...)
	starts := [][]float64{}
	for _, s := range sviStarts[:jsSliceEnd(len(sviStarts), cfg.OptimizerStarts)] {
		start := append([]float64(nil), s[:]...)
		start[0] = minW / scale * s[0]
		starts = append(starts, start)
	}
	results := make([]OptimizationResult, len(starts))
	totalIterations := 0.0
	for i, start := range starts {
		results[i] = BoundedNelderMead(NelderMeadArgs{Start: start, Bounds: bounds, Steps: []float64{.12, .15, .15, .12, .12},
			Objective: objective, MaxIterations: cfg.OptimizerIterations, Tolerance: cfg.OptimizerTolerance})
	}
	for _, r := range results {
		totalIterations += r.Iterations
	}
	converged := []OptimizationResult{}
	for _, r := range results {
		if r.Converged {
			converged = append(converged, r)
		}
	}
	stableSortBy(converged, func(r OptimizationResult) float64 { return r.Value })
	if len(converged) == 0 {
		unavailable := UnavailableSmile("All bounded SVI optimizer starts exhausted their budgets; interpolation only if validated.")
		unavailable.Calibration.OptimizerStatus = "svi_iteration_failure"
		unavailable.Calibration.OptimizerIterations = totalIterations
		unavailable.Calibration.OptimizerStarts = float64(len(results))
		unavailable.Calibration.DurationMs = perfNow() - started
		return unavailable
	}
	allStrikes := make([]float64, len(observations))
	for i, o := range observations {
		allStrikes[i] = o.Strike
	}
	// Prefer the best objective among candidates that actually pass hard diagnostics.
	var best *SmileModel
	for _, result := range converged {
		parameters := toParameters(result.Point)
		diagnosis := DiagnoseSvi(parameters, ks, cfg)
		strikes := distinctNumbers(allStrikes)
		sortNumbers(strikes)
		variance := func(k float64) *float64 { return P(SviVariance(parameters, k)) }
		priceValidation := ValidatePriceGrid(PriceGridArgs{F: f, D: d, Strikes: IntermediateStrikes(strikes, 8),
			Variance: variance, Tick: minH(observations), Config: cfg})
		residuals := calibrationResiduals(observations, variance, f, d)
		valid := diagnosis.Valid && priceValidation.Valid && residuals.normalizedRmse <= cfg.MaxNormalizedRmse
		nodes := make([]SmileNode, len(ks))
		for i, k := range ks {
			nodes[i] = SmileNode{K: k, W: SviVariance(parameters, k)}
		}
		status := "svi_validation_failure"
		if valid {
			status = "svi_converged_validated"
		}
		params := parameters
		model := SmileModel{
			Method: "svi", Parameters: &params, Nodes: nodes,
			Support: &SmileSupport{MinK: minK, MaxK: maxK, Strikes: strikes}, Valid: valid,
			Diagnostics: append(append([]Diagnostic{}, diagnosis.Diagnostics...), priceValidation.Diagnostics...),
			Butterfly:   diagnosis.Butterfly,
			Calibration: Calibration{
				Residuals: residuals.residuals, NormalizedRmse: P(residuals.normalizedRmse),
				InsideSpreadPercent: P(residuals.insideSpreadPercent), ObservationCount: float64(len(observations)),
				DistinctStrikes: float64(len(strikes)), OptimizerStatus: status, OptimizerIterations: totalIterations,
				OptimizerStarts: float64(len(results)), DurationMs: perfNow() - started, Rejected: []Rejected{}, SviOrder: true,
			},
		}
		if residuals.normalizedRmse > cfg.MaxNormalizedRmse {
			model.Diagnostics = append(model.Diagnostics, Diagnostic{Code: "price_residual_limit", Severity: "error",
				Message: "Fitted price residuals exceed the configured normalized RMSE limit."})
		}
		if best == nil {
			m := model
			best = &m
		}
		if valid {
			return model
		}
	}
	return *best
}

func allW(observations []CalibrationObservation) []float64 {
	ws := make([]float64, len(observations))
	for i, o := range observations {
		ws[i] = o.W
	}
	return ws
}
