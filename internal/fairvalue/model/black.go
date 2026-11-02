package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// YearMs is black.ts YEAR_MS (365 days in milliseconds).
const YearMs = 365 * 24 * 60 * 60 * 1000

// DayCount is the day-count label published in every surface (note the U+00D7 signs).
const DayCount = "ACT/365F: exact UTC seconds / (365 × 24 × 60 × 60)"

// YearFraction is black.ts yearFraction. A string argument must be an exact UTC/offset
// timestamp; a number is epoch milliseconds. It panics (throws) on invalid input.
func YearFraction[E, V ~string | ~float64](expiry E, valuation V) float64 {
	e := timeArg(any(expiry))
	v := timeArg(any(valuation))
	if !isFinite(e) || !isFinite(v) {
		throw("Invalid UTC valuation/expiry timestamp.")
	}
	return (e - v) / YearMs
}

func timeArg(x any) float64 {
	switch t := x.(type) {
	case string:
		ts, ok := UTCTimestamp(t)
		if !ok {
			return DateParse("")
		}
		return DateParse(ts)
	case float64:
		return t
	}
	return math.NaN()
}

// ValidateBlackInput is black.ts validateBlackInput.
func ValidateBlackInput(in BlackInput) {
	f, k, d, w := in.F, in.K, in.D, in.W
	if !isFinite(f) || !isFinite(k) || !isFinite(d) || !isFinite(w) || f <= 0 || k <= 0 || d <= 0 || w < 0 {
		throw("Black requires finite F>0, K>0, D>0 and total variance w>=0.")
	}
	if in.Side != CE && in.Side != PE {
		throw("Unsupported option side/style; European CE/PE only.")
	}
	if !isFinite(d * math.Max(f, k)) {
		throw("Discounted notional exceeds numeric range.")
	}
}

// Bounds are the European no-arbitrage premium bounds.
type Bounds struct{ Lower, Upper float64 }

// PriceBounds is black.ts priceBounds.
func PriceBounds(f, k, d float64, side string) Bounds {
	ValidateBlackInput(BlackInput{F: f, K: k, D: d, W: 0, Side: side})
	if side == CE {
		return Bounds{Lower: d * math.Max(f-k, 0), Upper: d * f}
	}
	return Bounds{Lower: d * math.Max(k-f, 0), Upper: d * k}
}

// BlackPrice is black.ts blackPrice: stable OTM evaluation, then put-call parity for
// ITM. All final prices use w, never an interpolated IV.
func BlackPrice(in BlackInput) float64 {
	ValidateBlackInput(in)
	f, k, d, w, side := in.F, in.K, in.D, in.W, in.Side
	if w == 0 {
		x := k - f
		if side == CE {
			x = f - k
		}
		return d * math.Max(x, 0)
	}
	root := math.Sqrt(w)
	logMoneyness := jsmath.Log(k) - jsmath.Log(f)
	d1 := float64(-logMoneyness/root) + float64(0.5*root)
	d2 := d1 - root
	if logMoneyness == 0 {
		// ATM reduces to D F erf(sqrt(w)/(2sqrt(2))) without subtracting nearly equal CDF values.
		return float64(d*f) * Erf(root/(2*sqrt2))
	}
	var call, put float64
	if f <= k {
		call = float64(d*k) * math.Max(0, float64(float64(f/k)*NormalCdf(d1))-NormalCdf(d2))
		put = call + float64(d*(k-f))
	} else {
		put = float64(d*f) * math.Max(0, float64(float64(k/f)*NormalCdf(-d2))-NormalCdf(-d1))
		call = put + float64(d*(f-k))
	}
	if side == CE {
		return call
	}
	return put
}

// BlackFromIv is black.ts blackFromIv.
func BlackFromIv(f, k, t, d, iv float64, side string) float64 {
	if !isFinite(t) || t <= 0 || !isFinite(iv) || iv < 0 {
		throw("IV pricing requires T>0 and finite decimal IV>=0; use settlementPayoff at expiry.")
	}
	return BlackPrice(BlackInput{F: f, K: k, D: d, W: float64(iv*iv) * t, Side: side})
}

// SettlementPayoffArgs are the inputs of SettlementPayoff.
type SettlementPayoffArgs struct {
	Strike               float64
	Side                 string
	Lot                  float64
	Settlement           *float64
	Indicative           *float64
	SettlementUnderlying string
}

// SettlementPayoff is black.ts settlementPayoff.
func SettlementPayoff(a SettlementPayoffArgs) ExpiryPayoff {
	if !isFinite(a.Strike) || a.Strike <= 0 || !isSafeInteger(a.Lot) || a.Lot <= 0 || (a.Side != CE && a.Side != PE) {
		throw("Invalid expiry contract inputs.")
	}
	for _, v := range []*float64{a.Settlement, a.Indicative} {
		if v != nil && (!isFinite(*v) || *v < 0) {
			throw("Invalid settlement underlying.")
		}
	}
	under := a.Settlement
	if under == nil {
		under = a.Indicative
	}
	var value, perLot *float64
	if under != nil {
		x := a.Strike - *under
		if a.Side == CE {
			x = *under - a.Strike
		}
		v := math.Max(x, 0)
		value = &v
		pl := a.Lot * v
		perLot = &pl
	}
	out := ExpiryPayoff{Value: value, ValuePerLot: perLot}
	switch {
	case a.Settlement != nil:
		out.Status = "final_settlement"
		out.Reason = "Final payoff using verified " + a.SettlementUnderlying + "."
	case a.Indicative != nil:
		out.Status = "indicative_payoff"
		out.Reason = "Indicative payoff only; official " + a.SettlementUnderlying + " is unknown."
	default:
		out.Status = "settlement_unknown"
		out.Reason = "Official " + a.SettlementUnderlying + " and an indicative underlying are unavailable."
	}
	return out
}

// GreeksConvention is the convention text published with every Greeks block.
const GreeksConvention = "Frozen-volatility Black; forward delta/gamma; vega per 1 IV percentage point; " +
	"theta per calendar day at fixed F, r, IV (ACT/365F); rho per 1 rate percentage point at fixed F. " +
	"Spot transforms require proportional carry and do not move the surface."

// GreeksArgs are the inputs of FrozenBlackGreeks.
type GreeksArgs struct {
	BlackInput
	T                 float64
	Spot              *float64
	ProportionalCarry bool
}

// FrozenBlackGreeks is black.ts frozenBlackGreeks.
func FrozenBlackGreeks(a GreeksArgs) BlackGreeks {
	ValidateBlackInput(a.BlackInput)
	f, k, d, w, side, t, spot := a.F, a.K, a.D, a.W, a.Side, a.T, a.Spot
	if !isFinite(t) || t <= 0 {
		throw("Greeks unavailable for expired contracts.")
	}
	if spot != nil && (!isFinite(*spot) || *spot <= 0) {
		throw("Invalid spot for Greeks.")
	}
	value := BlackPrice(a.BlackInput)
	r := -jsmath.Log(d) / t
	carry := a.ProportionalCarry && spot != nil
	if w == 0 {
		var callDelta float64
		switch {
		case f > k:
			callDelta = d * 1
		case f < k:
			callDelta = d * 0
		default:
			callDelta = d * 0.5
		}
		delta := callDelta - d
		if side == CE {
			delta = callDelta
		}
		g := BlackGreeks{ForwardDelta: delta, Rho1Pct: float64(-t*value) / 100, Convention: GreeksConvention}
		if f == k {
			g.Vega1Pct = float64(float64(float64(d*f)*NormalPdf(0))*math.Sqrt(t)) / 100
		} else {
			g.ForwardGamma = P(0)
			g.ThetaCalendarDay = P(float64(r*value) / 365)
		}
		if carry {
			g.SpotDelta = P(float64(delta*f) / *spot)
			if f != k {
				g.SpotGamma = P(0)
			}
		}
		return g
	}
	root := math.Sqrt(w)
	d1 := float64((jsmath.Log(f)-jsmath.Log(k))/root) + root/2
	density := NormalPdf(d1)
	pe := 0.0
	if side == PE {
		pe = 1
	}
	delta := d * (NormalCdf(d1) - pe)
	gamma := float64(d*density) / float64(f*root)
	iv := math.Sqrt(w / t)
	g := BlackGreeks{
		ForwardDelta: delta, ForwardGamma: P(gamma),
		Vega1Pct:         float64(float64(float64(d*f)*density)*math.Sqrt(t)) / 100,
		ThetaCalendarDay: P((float64(r*value) - float64(float64(float64(d*f)*density)*iv)/float64(2*math.Sqrt(t))) / 365),
		Rho1Pct:          float64(-t*value) / 100, Convention: GreeksConvention,
	}
	if carry {
		g.SpotDelta = P(float64(delta*f) / *spot)
		ratio := f / *spot
		g.SpotGamma = P(gamma * float64(ratio*ratio))
	}
	return g
}

// ensure the jsjson import is used by files that only need Marshal in tests.
var _ = jsjson.Marshal
