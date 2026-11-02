package model

import (
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// IndependentEstimateFor is independent.ts independentEstimate: both CE and PE at the
// target strike are removed before quote filtering, parity estimation, IV selection and
// calibration, then the target is repriced from the remaining surface.
func IndependentEstimateFor(input *InputSnapshot, expiry string, strike float64) IndependentEstimate {
	started := perfNow()
	if !isFinite(strike) || strike <= 0 {
		throw("Independent estimate requires a positive numeric strike.")
	}
	target := []Instrument{}
	excluded := []float64{}
	for _, i := range input.Instruments {
		if jsPrefix(i.Expiry, 10) == expiry && i.Strike == strike {
			target = append(target, i)
			excluded = append(excluded, i.InstrumentToken)
		}
	}
	smile := UnavailableSmile("")
	smile.Diagnostics = []Diagnostic{}
	result := IndependentEstimate{Status: "unavailable", InputSnapshotID: input.ID, ConfigVersion: input.ConfigVersion,
		Expiry: expiry, Strike: strike, Values: []IndependentValue{}, Forward: EmptyForward(), Smile: smile,
		ExcludedTokens: excluded, DurationMs: 0, Reasons: []string{}}
	if len(target) == 0 {
		result.Reasons = append(result.Reasons, "target_strike_not_in_input_snapshot")
		return result
	}
	for _, inst := range target {
		if !ResolveOptionMetadata(inst, input.Config.ExpiryPolicy, input.MetadataVersion).OK {
			result.Reasons = append(result.Reasons, "invalid_target_instrument_metadata_or_style")
			return result
		}
	}
	// BuildSlice removes the target instrument set before any forward/smile work.
	slice := BuildSlice(input, expiry, &strike)
	result.Forward, result.Smile = slice.Forward, slice.Smile
	result.DurationMs = perfNow() - started
	if !slice.Smile.Valid || slice.Forward.Value == nil || slice.Discount == nil || slice.Discount.D == nil ||
		slice.T == nil || *slice.T <= 0 {
		result.Status = "insufficient_data"
		result.Reasons = append(append(result.Reasons, "insufficient_valid_remaining_observations"), slice.Reasons...)
		return result
	}
	f, d := *slice.Forward.Value, *slice.Discount.D
	wp := VarianceAt(&slice.Smile, jsmath.Log(strike/f), input.Config.Smile, false)
	if wp == nil {
		result.Status = "insufficient_data"
		result.Reasons = append(result.Reasons, "target_outside_remaining_strike_support")
		return result
	}
	w := *wp
	validation := ValidatePriceGrid(PriceGridArgs{F: f, D: d,
		Strikes:  IntermediateStrikes(append(append([]float64{}, slice.Smile.Support.Strikes...), strike), 8),
		Variance: func(k float64) *float64 { return VarianceAt(&slice.Smile, k, input.Config.Smile, false) },
		Tick:     input.Config.Quote.TickFloor, Config: input.Config.Smile})
	if !validation.Valid {
		result.Reasons = append(result.Reasons, "independent_target_price_validation_failed")
		withDiagnostics := slice.Smile
		withDiagnostics.Diagnostics = append(append([]Diagnostic{}, slice.Smile.Diagnostics...), validation.Diagnostics...)
		result.Smile = withDiagnostics
		return result
	}
	for _, side := range [2]string{CE, PE} {
		var lot *float64
		for _, i := range target {
			if i.InstrumentType == side {
				lot = P(i.LotSize)
				break
			}
		}
		value := BlackPrice(BlackInput{F: f, K: strike, D: d, W: w, Side: side})
		var perLot *float64
		if lot != nil && isSafeInteger(*lot) && *lot > 0 {
			perLot = P(value * *lot)
		}
		result.Values = append(result.Values, IndependentValue{Side: side, FairValue: value, PerLot: perLot})
	}
	result.Status = "available"
	result.Reasons = append(append(result.Reasons, "both_target_sides_excluded_from_forward_and_smile"), slice.Reasons...)
	result.DurationMs = perfNow() - started
	return result
}
