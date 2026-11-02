package model

import (
	"math"
	"slices"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// SviVariance is svi.ts sviVariance: a + b (rho x + hypot(x, eta)), x = k - m.
func SviVariance(p SviParameters, k float64) float64 {
	x := k - p.M
	return p.A + float64(p.B*(float64(p.Rho*x)+jsmath.Hypot2(x, p.Eta)))
}

// SviDerivativeValues are the total variance, its first two k-derivatives and the
// Gatheral density factor g (nil when w <= 0).
type SviDerivativeValues struct {
	W, First, Second float64
	G                *float64
}

// SviDerivatives is svi.ts sviDerivatives.
func SviDerivatives(p SviParameters, k float64) SviDerivativeValues {
	x := k - p.M
	root := jsmath.Hypot2(x, p.Eta)
	w := SviVariance(p, k)
	first := p.B * (p.Rho + x/root)
	second := float64(p.B*p.Eta) * p.Eta / jsmath.Pow(root, 3)
	out := SviDerivativeValues{W: w, First: first, Second: second}
	if w > 0 {
		lead := 1 - float64(k*first)/float64(2*w)
		g := float64(lead*lead) - float64(float64(first*first)/4*(1/w+1.0/4)) + second/2
		out.G = &g
	}
	return out
}

// BasicSviConstraints is svi.ts basicSviConstraints.
func BasicSviConstraints(p SviParameters) bool {
	for _, v := range []float64{p.A, p.B, p.Rho, p.M, p.Eta} {
		if !isFinite(v) {
			return false
		}
	}
	return p.B >= 0 && math.Abs(p.Rho) < 1 && p.Eta > 0 &&
		p.A+float64(float64(p.B*p.Eta)*math.Sqrt(1-float64(p.Rho*p.Rho))) >= 0
}

// SviDiagnosis is the outcome of DiagnoseSvi.
type SviDiagnosis struct {
	Valid       bool
	Diagnostics []Diagnostic
	Butterfly   Butterfly
}

type sviSample struct {
	g *float64
	w float64
}

// DiagnoseSvi is svi.ts diagnoseSvi: an adaptive finite-domain diagnostic plus the
// analytic wing/tail restrictions. Never a global density proof.
func DiagnoseSvi(p SviParameters, observedK []float64, cfg SmileConfig) SviDiagnosis {
	diagnostics := []Diagnostic{}
	if !BasicSviConstraints(p) {
		diagnostics = append(diagnostics, Diagnostic{Code: "svi_parameter_constraints", Severity: "error",
			Message: "Raw SVI nonnegative-variance parameter constraints failed."})
	}
	right := p.B * (1 + p.Rho)
	left := p.B * (1 - p.Rho)
	// Slopes strictly less than 2 imply d1(k)->-infinity on the right.
	tail := right < 2 && left < 2
	if right > cfg.MaxWingSlope || left > cfg.MaxWingSlope || !tail {
		diagnostics = append(diagnostics, Diagnostic{Code: "svi_wing_tail_violation", Severity: "error",
			Message: "SVI wing slopes exceed configured Lee bound (<2), or the right tail condition fails."})
	}
	low := jsMin(append([]float64{-2}, observedK...)...) - cfg.StrikeExtrapolationK
	high := jsMax(append([]float64{2}, observedK...)...) + cfg.StrikeExtrapolationK
	seeds := newNumberSet()
	for _, k := range observedK {
		seeds.add(k)
	}
	seeds.add(0)
	seeds.add(p.M)
	seeds.add(p.M - float64(p.Rho*p.Eta)/math.Sqrt(1-float64(p.Rho*p.Rho)))
	for i := 0.0; i < cfg.DiagnosticPoints; i++ {
		seeds.add(low + float64((high-low)*i)/(cfg.DiagnosticPoints-1))
	}
	values := map[float64]sviSample{}
	minimum := math.Inf(1)
	worstK := 0.0
	sample := func(k float64) sviSample {
		if v, ok := values[k]; ok {
			return v
		}
		r := SviDerivatives(p, k)
		v := sviSample{g: r.G, w: r.W}
		values[k] = v
		if v.g != nil && *v.g < minimum {
			minimum = *v.g
			worstK = k
		}
		return v
	}
	var refine func(a, b float64, depth float64)
	refine = func(a, b float64, depth float64) {
		if len(values) >= 8192 {
			return
		}
		va, vb := sample(a), sample(b)
		midpoint := (a + b) / 2
		vm := sample(midpoint)
		if depth >= cfg.AdaptiveDepth || va.g == nil || vb.g == nil || vm.g == nil {
			return
		}
		curvature := math.Abs(*vm.g - (*va.g+*vb.g)/2)
		if depth == 0 || math.Min(math.Min(*va.g, *vb.g), *vm.g) < .1 || curvature > .005 {
			refine(a, midpoint, depth+1)
			refine(midpoint, b, depth+1)
		}
	}
	sorted := []float64{}
	for _, k := range seeds.values() {
		if isFinite(k) && k >= low && k <= high {
			sorted = append(sorted, k)
		}
	}
	sortNumbers(sorted)
	for _, k := range sorted {
		sample(k)
	}
	for i := 0; i < len(sorted)-1; i++ {
		refine(sorted[i], sorted[i+1], 0)
	}
	for _, v := range values {
		if !isFinite(v.w) || v.w <= 0 || v.g == nil || !isFinite(*v.g) {
			diagnostics = append(diagnostics, Diagnostic{Code: "svi_nonpositive_variance", Severity: "error",
				Message: "Nonpositive/nonfinite variance or density diagnostic on the adaptive domain."})
			break
		}
	}
	if minimum < -cfg.ButterflyTolerance {
		diagnostics = append(diagnostics, Diagnostic{Code: "butterfly_density_violation", Severity: "error",
			Message: "Negative g(k) on the adaptive diagnostic domain; SVI valuation suppressed.", K: P(worstK), Value: P(minimum)})
	}
	diagnostics = append(diagnostics, Diagnostic{Code: "finite_grid_not_global_proof", Severity: "info",
		Message: "SVI parameter/wing/tail checks and adaptive finite-domain g(k) tests are numerical diagnostics, not a global arbitrage proof."})
	valid := true
	for _, d := range diagnostics {
		if d.Severity == "error" {
			valid = false
		}
	}
	var minG *float64
	if isFinite(minimum) {
		minG = P(minimum)
	}
	domain := [2]float64{low, high}
	return SviDiagnosis{Valid: valid, Diagnostics: diagnostics, Butterfly: Butterfly{
		MinG: minG, CheckedPoints: float64(len(values)), Domain: &domain,
		RightWingSlope: P(right), LeftWingSlope: P(left), TailCondition: &tail, GlobalProof: false,
	}}
}

// numberSet is a JavaScript Set of numbers: insertion order, SameValueZero (one NaN,
// +0 and -0 equal).
type numberSet struct {
	order  []float64
	seen   map[float64]bool
	hasNaN bool
}

func newNumberSet() *numberSet { return &numberSet{seen: map[float64]bool{}} }

func (s *numberSet) add(v float64) {
	if math.IsNaN(v) {
		if !s.hasNaN {
			s.hasNaN = true
			s.order = append(s.order, v)
		}
		return
	}
	if s.seen[v] {
		return
	}
	s.seen[v] = true
	s.order = append(s.order, v)
}

func (s *numberSet) has(v float64) bool {
	if math.IsNaN(v) {
		return s.hasNaN
	}
	return s.seen[v]
}

func (s *numberSet) size() int { return len(s.order) }

func (s *numberSet) values() []float64 { return append([]float64(nil), s.order...) }

// distinctNumbers is [...new Set(values)].
func distinctNumbers(values []float64) []float64 {
	s := newNumberSet()
	for _, v := range values {
		s.add(v)
	}
	return s.order
}

// sortNumbers is array.sort((a, b) => a - b) for arrays without NaN: a stable
// ascending sort (equal values keep their order).
func sortNumbers(values []float64) {
	slices.SortStableFunc(values, func(a, b float64) int {
		switch {
		case a < b:
			return -1
		case a > b:
			return 1
		}
		return 0
	})
}

// jsMin is Math.min(...values): Infinity for none, NaN if any is NaN.
func jsMin(values ...float64) float64 {
	out := math.Inf(1)
	for _, v := range values {
		out = math.Min(out, v)
	}
	return out
}

// jsMax is Math.max(...values): -Infinity for none, NaN if any is NaN.
func jsMax(values ...float64) float64 {
	out := math.Inf(-1)
	for _, v := range values {
		out = math.Max(out, v)
	}
	return out
}
