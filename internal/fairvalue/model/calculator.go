package model

import (
	"math"
	"regexp"
	"strings"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

var (
	// /^[A-Z0-9&._-]{1,40}$/i without Unicode case folding (JavaScript /i without the u
	// flag never folds non-ASCII letters onto ASCII ones).
	reCalculatorUnderlying = regexp.MustCompile(`^[A-Za-z0-9&._-]{1,40}$`)
	reSnapshotID           = regexp.MustCompile(`^[A-Za-z0-9-]{1,100}$`)
)

const calculatorRequestError = "Calculator needs underlying, positive numeric strike, exact UTC/offset expiry, CE/PE and boolean research_mode."

// ValidateCalculatorRequest is calculator.ts validateCalculatorRequest on a JSON value
// (a request body).
func ValidateCalculatorRequest(value any) (req CalculatorRequest, err error) {
	err = Catch(func() {
		if !truthy(value) || typeOf(value) != "object" {
			throw("Calculator request must be an object.")
		}
		timestamp, tsOK := utcTimestampAny(getProp(value, "expiry_timestamp"))
		underlying, uOK := getProp(value, "underlying").(string)
		strike, sOK := getProp(value, "strike").(float64)
		side, _ := getProp(value, "side").(string)
		research, rOK := getProp(value, "research_mode").(bool)
		if !uOK || !reCalculatorUnderlying.MatchString(underlying) || !sOK || !isFinite(strike) || strike <= 0 || !tsOK ||
			(side != CE && side != PE) || !rOK {
			throw(calculatorRequestError)
		}
		req = CalculatorRequest{Underlying: strings.ToUpper(underlying), Strike: strike, ExpiryTimestamp: timestamp, Side: side, ResearchMode: research}
		if id := getProp(value, "input_snapshot_id"); !isUndefined(id) {
			s, ok := id.(string)
			if !ok || !reSnapshotID.MatchString(s) {
				throw("Invalid input_snapshot_id.")
			}
			req.InputSnapshotID = &s
		}
	})
	return req, err
}

// revalidate is validateCalculatorRequest applied to an already typed request (the
// worker re-validates what the engine passes).
func (r CalculatorRequest) revalidate() CalculatorRequest {
	timestamp, ok := UTCTimestamp(r.ExpiryTimestamp)
	if !reCalculatorUnderlying.MatchString(r.Underlying) || !isFinite(r.Strike) || r.Strike <= 0 || !ok ||
		(r.Side != CE && r.Side != PE) {
		throw(calculatorRequestError)
	}
	if r.InputSnapshotID != nil && !reSnapshotID.MatchString(*r.InputSnapshotID) {
		throw("Invalid input_snapshot_id.")
	}
	out := r
	out.Underlying = strings.ToUpper(r.Underlying)
	out.ExpiryTimestamp = timestamp
	return out
}

// Calculate is calculator.ts calculate: a listed or hypothetical contract valued from
// the published surface. It throws on an invalid request.
func Calculate(input *InputSnapshot, surface *SurfaceSnapshot, request CalculatorRequest) CalculatorResult {
	r := request.revalidate()
	t := RequestedTime(input, r.ExpiryTimestamp)
	var listedRow *ValuationRow
	for si := range surface.Slices {
		for ri := range surface.Slices[si].Rows {
			row := &surface.Slices[si].Rows[ri]
			if row.Strike == r.Strike && row.Side == r.Side && row.Metadata != nil && row.Metadata.ExpiryTimestamp == r.ExpiryTimestamp {
				listedRow = row
				break
			}
		}
		if listedRow != nil {
			break
		}
	}
	var listedMetadata *OptionMetadata
	if listedRow != nil {
		listedMetadata = listedRow.Metadata
	} else {
		for i := range input.ListingCatalog {
			m := &input.ListingCatalog[i]
			if m.Strike == r.Strike && m.Side == r.Side && m.ExpiryTimestamp == r.ExpiryTimestamp {
				listedMetadata = m
				break
			}
		}
	}
	result := CalculatorResult{InputSnapshotID: input.ID, ConfigVersion: input.ConfigVersion, ModelVersion: ModelVersion,
		ValuationTime: input.ValuationTime, Contract: "hypothetical", StrikeMethod: "unavailable", MaturityMethod: "unavailable",
		Strike: r.Strike, ExpiryTimestamp: r.ExpiryTimestamp, Side: r.Side, T: t, Quality: "unavailable",
		Reasons: []string{}, Assumptions: []string{}, Diagnostics: []Diagnostic{}}
	if listedMetadata != nil {
		result.Contract = "listed"
		result.InstrumentToken = P(listedMetadata.Token)
		result.LotSize = P(listedMetadata.LotSize)
	}
	fail := func(reason string) CalculatorResult {
		result.Reasons = append(result.Reasons, reason)
		return result
	}
	if input.Underlying != r.Underlying || surface.InputSnapshotID != input.ID || surface.ConfigVersion != input.ConfigVersion {
		return fail("inconsistent_snapshot_identity")
	}
	if !isFinite(t) || t <= 0 {
		return fail("future_expiry_required")
	}
	config := &input.Config
	research := r.ResearchMode && config.ResearchEnabled
	slices := []*ExpirySlice{}
	for i := range surface.Slices {
		s := &surface.Slices[i]
		if s.T != nil && *s.T > 0 && s.Smile.Valid && s.Forward.Value != nil && s.Discount != nil && s.Discount.D != nil {
			slices = append(slices, s)
		}
	}
	stableSortBy(slices, func(s *ExpirySlice) float64 { return *s.T })
	if len(slices) == 0 {
		return fail("no_valid_maturity_slices")
	}
	var f *float64
	var variance func(k float64) *float64
	var low, high float64
	var reference *ExpirySlice
	var exact *ExpirySlice
	for _, s := range slices {
		if s.ExpiryTimestamp != nil && *s.ExpiryTimestamp == r.ExpiryTimestamp {
			exact = s
			break
		}
	}
	if exact == nil {
		for i := range surface.Slices {
			if ts := surface.Slices[i].ExpiryTimestamp; ts != nil && *ts == r.ExpiryTimestamp {
				return fail("listed_expiry_slice_invalid_or_unavailable")
			}
		}
	}
	if exact != nil {
		reference = exact
		f = exact.Forward.Value
		variance = func(k float64) *float64 { return VarianceAt(&exact.Smile, k, config.Smile, research) }
		low, high = exact.Smile.Support.MinK, exact.Smile.Support.MaxK
		result.MaturityMethod = "listed_expiry"
		result.Assumptions = append(result.Assumptions, exact.Forward.Assumptions...)
	} else {
		if !ProportionalCalendarSupported(input) {
			return fail("maturity_carry_or_event_assumption_unsupported")
		}
		upperIndex := -1
		for i, s := range slices {
			if *s.T > t {
				upperIndex = i
				break
			}
		}
		if upperIndex > 0 {
			a, b := slices[upperIndex-1], slices[upperIndex]
			reference = a
			var region *CalendarRegion
			for i := range surface.CalendarRegions {
				g := &surface.CalendarRegions[i]
				if g.FirstExpiry == a.Expiry && g.SecondExpiry == b.Expiry {
					region = g
					break
				}
			}
			if region == nil || !region.Valid {
				if region != nil {
					result.Diagnostics = append(result.Diagnostics, region.Diagnostics...)
				}
				return fail("maturity_region_invalid_or_unavailable")
			}
			low, high = region.MinK, region.MaxK
			variance = func(k float64) *float64 { return TotalVarianceBetween(a, b, t, k, config, research) }
			forward := HypotheticalForward(input, t, a, b, "interpolation")
			f = forward.Value
			result.Assumptions = append(result.Assumptions, forward.Assumptions...)
			if f == nil {
				if forward.Reason != nil {
					return fail(*forward.Reason)
				}
				return fail("hypothetical_forward_unavailable")
			}
			result.MaturityMethod = "maturity_interpolation"
			result.Assumptions = append(result.Assumptions, "Linear interpolation of total variance at the SAME forward log-moneyness; no full arbitrage guarantee.")
		} else {
			if !research {
				return fail("maturity_extrapolation_requires_research_opt_in_and_enabled_configuration")
			}
			if config.MaturityExtrapolation != "constant_short_end_and_forward_variance" {
				return fail("maturity_extrapolation_disabled")
			}
			first, last := slices[0], slices[len(slices)-1]
			distance := t - *last.T
			if t < *first.T {
				distance = *first.T - t
			}
			if distance*365 > config.MaxMaturityExtrapolationDays {
				return fail("maturity_extrapolation_distance_limit")
			}
			if t < *first.T {
				reference = first
				low, high = first.Smile.Support.MinK, first.Smile.Support.MaxK
				variance = func(k float64) *float64 {
					w := VarianceAt(&first.Smile, k, config.Smile, research)
					if w == nil {
						return nil
					}
					return P(t / *first.T * *w)
				}
				forward := HypotheticalForward(input, t, first, nil, "short_research")
				f = forward.Value
				result.Assumptions = append(result.Assumptions, forward.Assumptions...)
				result.Assumptions = append(result.Assumptions, "Research constant-short-end-variance-rate assumption w(T)=T/T1×w(T1); especially unreliable near events or expiry.")
			} else {
				if len(slices) < 2 {
					return fail("forward_variance_extrapolation_needs_two_maturities")
				}
				previous := slices[len(slices)-2]
				reference = last
				low = math.Max(previous.Smile.Support.MinK, last.Smile.Support.MinK)
				high = math.Min(previous.Smile.Support.MaxK, last.Smile.Support.MaxK)
				variance = func(k float64) *float64 {
					wn := VarianceAt(&last.Smile, k, config.Smile, research)
					wp := VarianceAt(&previous.Smile, k, config.Smile, research)
					if wn == nil || wp == nil {
						return nil
					}
					forwardVariance := (*wn - *wp) / (*last.T - *previous.T)
					// No clamping: negative forward variance is an explicit unavailable region.
					if forwardVariance < 0 {
						return nil
					}
					return P(*wn + float64(forwardVariance*(t-*last.T)))
				}
				forward := HypotheticalForward(input, t, previous, last, "long_research")
				f = forward.Value
				result.Assumptions = append(result.Assumptions, forward.Assumptions...)
				result.Assumptions = append(result.Assumptions, "Research continuation of validated nonnegative forward total-variance slope from the final two maturities; no silent negative-variance repair.")
			}
			result.MaturityMethod = "maturity_extrapolation"
		}
	}
	if f == nil || !isFinite(*f) || *f <= 0 {
		return fail("hypothetical_forward_unavailable")
	}
	F := *f
	discount := DiscountAt(&config.Curve, t)
	if discount.D == nil {
		return fail("requested_discount_unavailable")
	}
	d := *discount.D
	k := jsmath.Log(r.Strike) - jsmath.Log(F)
	if !isFinite(k) {
		return fail("invalid_log_moneyness")
	}
	extra := k < low-1e-12 || k > high+1e-12
	if extra && !research {
		return fail("strike_extrapolation_requires_research_opt_in_and_enabled_configuration")
	}
	if extra && math.Max(low-k, k-high) > config.Smile.StrikeExtrapolationK {
		return fail("strike_extrapolation_distance_limit")
	}
	if extra && config.Smile.StrikeExtrapolationK == 0 {
		return fail("strike_extrapolation_disabled")
	}
	wp := variance(k)
	if wp == nil || !isFinite(*wp) || *wp < 0 {
		return fail("requested_variance_unavailable_or_negative_forward_variance")
	}
	w := *wp
	switch {
	case extra:
		result.StrikeMethod = "strike_extrapolation"
	case exact != nil && rowAtStrike(exact, r.Strike):
		result.StrikeMethod = "listed_strike"
	default:
		result.StrikeMethod = "strike_interpolation"
	}
	domainLow, domainHigh := math.Min(low, k), math.Max(high, k)
	n := config.Smile.DiagnosticPoints
	validationKs := []float64{}
	for i := 0.0; i < n; i++ {
		validationKs = append(validationKs, domainLow+float64((domainHigh-domainLow)*i)/(n-1))
	}
	// Add local requested neighbours and listed strike coordinates to the validation grid.
	validationKs = append(validationKs, k, math.Max(domainLow, k-1e-4), math.Min(domainHigh, k+1e-4))
	for _, node := range reference.Smile.Nodes {
		for _, x := range [3]float64{node.K - 1e-5, node.K, node.K + 1e-5} {
			if x >= domainLow && x <= domainHigh {
				validationKs = append(validationKs, x)
			}
		}
	}
	strikes := make([]float64, len(validationKs))
	for i, x := range validationKs {
		strikes[i] = F * jsmath.Exp(x)
	}
	for _, s := range strikes {
		if !isFinite(s) || s <= 0 {
			return fail("requested_strike_numeric_range")
		}
	}
	validation := ValidatePriceGrid(PriceGridArgs{F: F, D: d, Strikes: strikes, Variance: variance, Tick: config.Quote.TickFloor, Config: config.Smile})
	result.Diagnostics = append(result.Diagnostics, validation.Diagnostics...)
	if !validation.Valid {
		return fail("requested_price_space_validation_failed")
	}
	result.Available = true
	result.Forward, result.Discount, result.K, result.TotalVariance = P(F), P(d), P(k), P(w)
	surfaceIv := math.Sqrt(w / t)
	result.SurfaceIv = P(surfaceIv)
	fairValue := BlackPrice(BlackInput{F: F, K: r.Strike, D: d, W: w, Side: r.Side})
	result.FairValue = P(fairValue)
	if result.LotSize != nil {
		result.FairValuePerLot = P(fairValue * *result.LotSize)
	}
	carry := config.CarryFor(input.Underlying)
	var spot *float64
	if input.Spot != nil {
		spot = P(input.Spot.Value)
	}
	greeks := FrozenBlackGreeks(GreeksArgs{BlackInput: BlackInput{F: F, K: r.Strike, D: d, W: w, Side: r.Side}, T: t, Spot: spot,
		ProportionalCarry: carry != nil && carry.Verified && carry.Proportional && len(carry.Dividends) == 0 && len(carry.CorporateActions) == 0})
	result.Greeks = &greeks
	switch {
	case extra || result.MaturityMethod == "maturity_extrapolation":
		result.Quality = "research"
	case result.Contract == "hypothetical" || result.MaturityMethod == "maturity_interpolation" || reference.Quality != "supported":
		result.Quality = "limited"
	default:
		result.Quality = "supported"
	}
	if discount.Assumption != nil {
		result.Assumptions = append(result.Assumptions, *discount.Assumption)
	}
	if result.Contract == "hypothetical" {
		result.Reasons = append(result.Reasons, "hypothetical_non_tradeable_no_broker_id_or_lot")
	}
	if extra {
		result.Reasons = append(result.Reasons, "limited_svi_wing_extrapolation")
	}
	if result.MaturityMethod == "maturity_extrapolation" {
		result.Reasons = append(result.Reasons, "research_maturity_extrapolation")
	}
	result.Reasons = append(result.Reasons, reference.Reasons...)
	var bidIv, askIv *float64
	if listedRow != nil {
		bidIv, askIv = validIv(listedRow.BidIv), validIv(listedRow.AskIv)
	}
	sensitivity := ModelSensitivity(SensitivityArgs{F: F, Strike: r.Strike, T: t, D: d, Iv: surfaceIv, Side: r.Side,
		ForwardDispersion: reference.Forward.Dispersion, RateBump: config.SensitivityRateBump, QuoteIvBid: bidIv, QuoteIvAsk: askIv})
	result.Sensitivity = &sensitivity
	return result
}

func rowAtStrike(slice *ExpirySlice, strike float64) bool {
	for _, row := range slice.Rows {
		if row.Strike == strike {
			return true
		}
	}
	return false
}

// IndependentRequest is a validated independent-estimate request.
type IndependentRequest struct {
	Underlying, Expiry, InputSnapshotID string
	Strike                              float64
}

// ValidateIndependentRequest is the request check at the top of engine.ts independent().
func ValidateIndependentRequest(value any) (req IndependentRequest, err error) {
	err = Catch(func() {
		if !truthy(value) || typeOf(value) != "object" {
			throw("Independent estimate request must be an object.")
		}
		underlying, uOK := getProp(value, "underlying").(string)
		expiry, eOK := getProp(value, "expiry").(string)
		strike, sOK := getProp(value, "strike").(float64)
		id, iOK := getProp(value, "input_snapshot_id").(string)
		if !uOK || !eOK || !sOK || !isFinite(strike) || strike <= 0 || !iOK {
			throw("Provide underlying, listed expiry, numeric strike and input_snapshot_id.")
		}
		req = IndependentRequest{Underlying: underlying, Expiry: expiry, Strike: strike, InputSnapshotID: id}
	})
	return req, err
}
