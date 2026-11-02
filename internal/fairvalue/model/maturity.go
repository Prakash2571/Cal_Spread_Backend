package model

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// ProportionalCalendarSupported is maturity.ts proportionalCalendarSupported.
func ProportionalCalendarSupported(input *InputSnapshot) bool {
	carry := input.Config.CarryFor(input.Underlying)
	if carry != nil && (len(carry.Dividends) > 0 || len(carry.CorporateActions) > 0) {
		return false
	}
	return (carry != nil && carry.Verified && carry.Proportional) || input.Config.ProportionalCalendarAssumption
}

// CommonSupport is maturity.ts commonSupport.
func CommonSupport(a, b *ExpirySlice) (low, high float64, ok bool) {
	if !a.Smile.Valid || !b.Smile.Valid || a.Smile.Support == nil || b.Smile.Support == nil {
		return 0, 0, false
	}
	low = math.Max(a.Smile.Support.MinK, b.Smile.Support.MinK)
	high = math.Min(a.Smile.Support.MaxK, b.Smile.Support.MaxK)
	return low, high, high > low
}

// TotalVarianceBetween is maturity.ts totalVarianceBetween: linear interpolation in
// total variance between two slices evaluated at THE SAME forward log-moneyness.
func TotalVarianceBetween(a, b *ExpirySlice, t, k float64, config *Config, research bool) *float64 {
	if a.T == nil || b.T == nil || !(*a.T <= t && t <= *b.T) || *b.T <= *a.T {
		return nil
	}
	wa := VarianceAt(&a.Smile, k, config.Smile, research)
	wb := VarianceAt(&b.Smile, k, config.Smile, research)
	if wa == nil || wb == nil || *wb < *wa-config.Smile.CalendarTolerance {
		return nil
	}
	alpha := (t - *a.T) / (*b.T - *a.T)
	return P(float64((1-alpha)**wa) + float64(alpha**wb))
}

// HypotheticalResult is the outcome of HypotheticalForward.
type HypotheticalResult struct {
	Value       *float64
	Assumptions []string
	Reason      *string
}

// HypotheticalForward is maturity.ts hypotheticalForward: explicit event-aware
// verified carry first, otherwise the labelled log-carry assumption, never another
// expiry's future. mode is "interpolation", "short_research" or "long_research".
func HypotheticalForward(input *InputSnapshot, t float64, a, b *ExpirySlice, mode string) HypotheticalResult {
	none := func(reason string) HypotheticalResult {
		return HypotheticalResult{Assumptions: []string{}, Reason: PS(reason)}
	}
	carry := input.Config.CarryFor(input.Underlying)
	valuation := DateParse(input.ValuationTime)
	expiry := ISOString(valuation + float64(float64(t*365)*86400000))
	if carry != nil && carry.Verified && input.Spot != nil {
		result := ResolveForward(ResolveArgs{Options: EmptyForward(), Expiry: expiry, Now: valuation, Curve: &input.Config.Curve,
			Spot: input.Spot, Carry: carry, Futures: nil, MaxAgeMs: input.Config.Quote.MaxAgeMs})
		if result.Value != nil {
			return HypotheticalResult{Value: result.Value, Assumptions: result.Assumptions}
		}
		return none("Verified carry cannot value this maturity (curve/events/corporate actions).")
	}
	if input.Config.ForwardInterpolation != "log_carry_assumption" || input.Spot == nil || input.Spot.Value <= 0 ||
		a.Forward.Value == nil || a.T == nil {
		return none("Hypothetical forward interpolation policy/spot support is unavailable.")
	}
	s := input.Spot.Value
	c1 := jsmath.Log(*a.Forward.Value / s)
	var c float64
	var assumption string
	if mode == "short_research" {
		c = c1 * t / *a.T
		assumption = "Research short-end log-carry interpolation anchored at current spot F(0)=S; event-insensitive assumption."
	} else {
		if b == nil || b.Forward.Value == nil || b.T == nil || *b.T <= *a.T {
			return none("Two positive forward-curve nodes are required.")
		}
		alpha := (t - *a.T) / (*b.T - *a.T)
		c = float64((1-alpha)*c1) + float64(alpha*jsmath.Log(*b.Forward.Value/s))
		if mode == "long_research" {
			assumption = "Research linear extrapolation of log carry from the final two listed nodes; event-insensitive assumption."
		} else {
			assumption = "Hypothetical forward assumes linear interpolation of log carry ln(F(T)/S); not a universally correct forward model."
		}
	}
	value := s * jsmath.Exp(c)
	if isFinite(value) && value > 0 {
		return HypotheticalResult{Value: P(value), Assumptions: []string{assumption}}
	}
	return none("Hypothetical forward is nonpositive or nonfinite.")
}

// BuildCalendarRegions is maturity.ts buildCalendarRegions: common-k calendar checks
// and interpolated price validation. A crossing invalidates the whole common region.
func BuildCalendarRegions(slices []ExpirySlice, input *InputSnapshot) []CalendarRegion {
	config := &input.Config
	ordered := []*ExpirySlice{}
	for i := range slices {
		s := &slices[i]
		if s.T != nil && *s.T > 0 && s.Smile.Valid {
			ordered = append(ordered, s)
		}
	}
	stableSortBy(ordered, func(s *ExpirySlice) float64 { return *s.T })
	regions := []CalendarRegion{}
	for i := 0; i < len(ordered)-1; i++ {
		a, b := ordered[i], ordered[i+1]
		low, high, ok := CommonSupport(a, b)
		if !ok {
			continue
		}
		diagnostics := []Diagnostic{}
		if !ProportionalCalendarSupported(input) {
			diagnostics = append(diagnostics, Diagnostic{Code: "calendar_carry_assumption_unsupported", Severity: "error",
				Message: "Same-k calendar validation needs a verified proportional/deterministic carry model or explicit proportional-carry assumption; discrete events are unsupported for maturity interpolation."})
		}
		ks := newNumberSet()
		for _, n := range a.Smile.Nodes {
			if n.K >= low && n.K <= high {
				ks.add(n.K)
			}
		}
		for _, n := range b.Smile.Nodes {
			if n.K >= low && n.K <= high {
				ks.add(n.K)
			}
		}
		points := config.Smile.DiagnosticPoints
		for j := 0.0; j <= points; j++ {
			ks.add(low + float64((high-low)*j)/points)
		}
		minimum, minimumK := math.Inf(1), low
		delta := func(k float64) *float64 {
			wa, wb := VarianceAt(&a.Smile, k, config.Smile, false), VarianceAt(&b.Smile, k, config.Smile, false)
			if wa == nil || wb == nil {
				return nil
			}
			difference := *wb - *wa
			if difference < minimum {
				minimum, minimumK = difference, k
			}
			return &difference
		}
		sorted := ks.values()
		sortNumbers(sorted)
		var refine func(x, y, depth float64)
		refine = func(x, y, depth float64) {
			dx, dy := delta(x), delta(y)
			middle := (x + y) / 2
			dm := delta(middle)
			if dx == nil || dy == nil || dm == nil {
				return
			}
			if depth < config.Smile.AdaptiveDepth &&
				(depth == 0 || math.Min(math.Min(*dx, *dy), *dm) < 1e-5 || math.Abs(*dm-(*dx+*dy)/2) > 1e-5) {
				refine(x, middle, depth+1)
				refine(middle, y, depth+1)
			}
		}
		for j := 0; j < len(sorted)-1; j++ {
			refine(sorted[j], sorted[j+1], 0)
		}
		if minimum < -config.Smile.CalendarTolerance {
			diagnostics = append(diagnostics, Diagnostic{Code: "calendar_variance_crossing", Severity: "error",
				Message: "Later expiry total variance is smaller at the same k; affected common maturity region is unavailable, with no silent clamping.",
				K:       P(minimumK), Value: P(minimum)})
		}
		if len(diagnostics) == 0 {
			for _, alpha := range [3]float64{.25, .5, .75} {
				t := float64((1-alpha)**a.T) + float64(alpha**b.T)
				forward := HypotheticalForward(input, t, a, b, "interpolation")
				discount := DiscountAt(&config.Curve, t)
				if forward.Value == nil || discount.D == nil {
					message := "Interpolated curve inputs unavailable."
					if forward.Reason != nil {
						message = *forward.Reason
					} else if discount.Reason != nil {
						message = *discount.Reason
					}
					diagnostics = append(diagnostics, Diagnostic{Code: "intermediate_curve_unavailable", Severity: "error", Message: message})
					break
				}
				f := *forward.Value
				strikes := make([]float64, len(sorted))
				for j, k := range sorted {
					strikes[j] = f * jsmath.Exp(k)
				}
				validation := ValidatePriceGrid(PriceGridArgs{F: f, D: *discount.D, Strikes: strikes,
					Variance: func(k float64) *float64 { return TotalVarianceBetween(a, b, t, k, config, false) },
					Tick:     config.Quote.TickFloor, Config: config.Smile})
				if !validation.Valid {
					diagnostics = append(diagnostics, validation.Diagnostics...)
				}
			}
		}
		valid := true
		for _, d := range diagnostics {
			if d.Severity == "error" {
				valid = false
			}
		}
		regions = append(regions, CalendarRegion{FirstExpiry: a.Expiry, SecondExpiry: b.Expiry, MinK: low, MaxK: high,
			Valid: valid, Diagnostics: diagnostics})
	}
	return regions
}

// RequestedTime is maturity.ts requestedTime.
func RequestedTime(input *InputSnapshot, expiry string) float64 {
	return YearFraction(expiry, input.ValuationTime)
}
