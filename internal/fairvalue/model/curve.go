package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// ValidateCurve is curve.ts validateCurve (also run on every DiscountAt call).
func ValidateCurve(spec *DiscountCurveSpec) {
	if _, ok := UTCTimestamp(spec.AsOf); spec.Convention != "continuous_zero_act365f" || jsTrim(spec.Source) == "" ||
		jsTrim(spec.Version) == "" || !ok {
		throw("Curve requires source, UTC timestamp, convention and version.")
	}
	if len(spec.Nodes) > 100 {
		throw("Discount curve exceeds 100 nodes.")
	}
	previous := -1.0
	for _, node := range spec.Nodes {
		if !isFinite(node.T) || node.T < 0 || node.T <= previous || !isFinite(node.ZeroRate) ||
			!isFinite(jsmath.Exp(float64(-node.ZeroRate*node.T))) || jsmath.Exp(float64(-node.ZeroRate*node.T)) <= 0 {
			throw("Curve nodes require increasing nonnegative T, finite continuous zero rates and positive finite D.")
		}
		previous = node.T
	}
	if spec.FlatRate != nil && !isFinite(*spec.FlatRate) {
		throw("Flat rate must be a finite decimal.")
	}
}

// DiscountAt is curve.ts discountAt: continuous-zero ACT/365F discounting with
// log-discount interpolation between nodes.
func DiscountAt(spec *DiscountCurveSpec, t float64) DiscountResult {
	ValidateCurve(spec)
	if !isFinite(t) || t < 0 {
		throw("Discount time must be finite and nonnegative.")
	}
	provenance := SourceStamp{Source: spec.Source, AsOf: spec.AsOf, Version: spec.Version, Convention: spec.Convention}
	unavailable := func(reason string) DiscountResult {
		return DiscountResult{Available: false, Method: "unavailable", Reason: PS(reason), Provenance: provenance}
	}
	if t == 0 {
		return DiscountResult{Available: true, D: P(1), ZeroRate: P(0), Method: "curve_node", Provenance: provenance}
	}
	nodes := spec.Nodes
	if len(nodes) == 0 || nodes[0].T != 0 {
		nodes = append([]CurveNode{{T: 0, ZeroRate: 0}}, spec.Nodes...)
	}
	var logD float64
	var method string
	var assumption *string
	exact := -1
	for i, n := range nodes {
		if n.T == t {
			exact = i
			break
		}
	}
	if exact >= 0 {
		logD = float64(-nodes[exact].ZeroRate) * t
		method = "curve_node"
	} else {
		upper := -1
		for i, n := range nodes {
			if n.T > t {
				upper = i
				break
			}
		}
		switch {
		case upper > 0:
			a, b := nodes[upper-1], nodes[upper]
			alpha := (t - a.T) / (b.T - a.T)
			logD = float64((1-alpha)*float64(float64(-a.ZeroRate)*a.T)) + float64(alpha*float64(float64(-b.ZeroRate)*b.T))
			method = "log_discount_interpolation"
		case spec.AllowFlatFallback && spec.FlatRate != nil:
			logD = float64(-*spec.FlatRate) * t
			method = "flat_rate_assumption"
			assumption = PS("Configured flat continuously compounded rate; not an observed term structure.")
		default:
			return unavailable("No discount curve coverage and flat-rate fallback is not configured.")
		}
	}
	d := jsmath.Exp(logD)
	if !isFinite(d) || d <= 0 {
		return unavailable("Discount factor is nonpositive or outside numeric range.")
	}
	// Negative zero rates legitimately give D>1; there is no universal upper-bound check.
	return DiscountResult{Available: true, D: P(d), ZeroRate: P(-logD / t), Method: method, Assumption: assumption, Provenance: provenance}
}

var _ = math.Abs
