package model

import (
	"math"
	"strings"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

func blankRow(inst Instrument) ValuationRow {
	var lot *float64
	if isSafeInteger(inst.LotSize) && inst.LotSize > 0 {
		lot = P(inst.LotSize)
	}
	return ValuationRow{Token: inst.InstrumentToken, Tradingsymbol: inst.Tradingsymbol, Strike: inst.Strike,
		Side: inst.InstrumentType, LotSize: lot, IndependentStatus: "on_demand", Quality: "unavailable",
		Reasons: []string{}, EstimationMethod: "unavailable"}
}

// Selection is the outcome of SelectObservations.
type Selection struct {
	Observations []CalibrationObservation
	Rejected     []Rejected
}

// SelectObservations is pipeline.ts selectObservations: invert every calibration quote,
// prefer the OTM side away from the money and split ATM CE/PE dependence. rows are
// updated in place (observed/bid/ask IV and rejection reasons).
func SelectObservations(metadata []OptionMetadata, quotes []CleanQuote, f, d, t float64, input *InputSnapshot, rows []ValuationRow) Selection {
	byToken := map[float64]int{}
	for i := range rows {
		byToken[rows[i].Token] = i
	}
	meta := map[float64]*OptionMetadata{}
	for i := range metadata {
		meta[metadata[i].Token] = &metadata[i]
	}
	strikeOrder := []float64{}
	byStrike := map[float64][]CalibrationObservation{}
	rejected := []Rejected{}
	ivConfig := input.Config.Iv
	for _, quote := range quotes {
		inst := meta[quote.Token]
		ri, ok := byToken[quote.Token]
		if inst == nil || !ok {
			continue
		}
		row := &rows[ri]
		h := quote.H
		inversion := InvertIv(IvArgs{F: f, K: inst.Strike, T: t, D: d, Price: quote.Mid, Side: inst.Side, Tick: inst.TickSize,
			Uncertainty: &h, Config: &ivConfig})
		row.ObservedIv = &inversion
		bidIv := InvertIv(IvArgs{F: f, K: inst.Strike, T: t, D: d, Price: *quote.Bid, Side: inst.Side, Tick: inst.TickSize, Config: &ivConfig})
		askIv := InvertIv(IvArgs{F: f, K: inst.Strike, T: t, D: d, Price: *quote.Ask, Side: inst.Side, Tick: inst.TickSize, Config: &ivConfig})
		row.BidIv, row.AskIv = &bidIv, &askIv
		if inversion.Status != "valid" || inversion.Iv == nil {
			rejected = append(rejected, Rejected{Token: quote.Token, Reason: "iv_" + inversion.Status})
			row.Reasons = append(row.Reasons, "iv_"+inversion.Status)
			continue
		}
		iv := *inversion.Iv
		k := jsmath.Log(inst.Strike / f)
		if _, seen := byStrike[inst.Strike]; !seen {
			strikeOrder = append(strikeOrder, inst.Strike)
		}
		byStrike[inst.Strike] = append(byStrike[inst.Strike], CalibrationObservation{Strike: inst.Strike, K: k,
			W: float64(iv*iv) * t, Iv: iv, Side: inst.Side, Token: inst.Token, Quote: quote, DependenceFactor: 1})
	}
	observations := []CalibrationObservation{}
	for _, strike := range strikeOrder {
		candidates := byStrike[strike]
		k := candidates[0].K
		if math.Abs(k) <= input.Config.Smile.AtmBand {
			// Same economic strike: normalise dependence so CE+PE do not count twice.
			for _, o := range candidates {
				o.DependenceFactor = 1 / float64(len(candidates))
				observations = append(observations, o)
			}
			continue
		}
		side := CE
		if k < 0 {
			side = PE
		}
		preferred := -1
		for i, o := range candidates {
			if o.Side == side {
				preferred = i
				break
			}
		}
		if preferred >= 0 {
			observations = append(observations, candidates[preferred])
			for _, o := range candidates {
				if o.Side != side {
					rejected = append(rejected, Rejected{Token: o.Token, Reason: "itm_side_diagnostic_only_otm_preferred"})
				}
			}
		} else {
			for _, o := range candidates {
				rejected = append(rejected, Rejected{Token: o.Token, Reason: "otm_side_unavailable"})
			}
		}
	}
	return Selection{Observations: observations, Rejected: rejected}
}

var incoherentReasons = map[string]bool{
	"incoherent_pair_metadata": true, "incoherent_pair_timestamps": true, "robust_forward_outlier": true,
	"invalid_pair_forward": true, "pair_premiums_outside_european_bounds": true,
}

// BuildSlice is pipeline.ts buildSlice: one listed expiry, with every instrument at
// excludeStrike (nil = none) removed before quote filtering, forwards and fitting.
// Like the TypeScript it has no error handling of its own: a thrown model error fails
// the whole surface job.
func BuildSlice(input *InputSnapshot, expiry string, excludeStrike *float64) ExpirySlice {
	config := &input.Config
	now := DateParse(input.ValuationTime)
	instruments := []Instrument{}
	for _, i := range input.Instruments {
		if jsPrefix(i.Expiry, 10) == expiry && (excludeStrike == nil || i.Strike != *excludeStrike) {
			instruments = append(instruments, i)
		}
	}
	rows := make([]ValuationRow, len(instruments))
	for i, inst := range instruments {
		rows[i] = blankRow(inst)
	}
	sortStable(rows, func(a, b ValuationRow) bool {
		if a.Strike != b.Strike {
			return a.Strike < b.Strike
		}
		return a.Side < b.Side // localeCompare on CE/PE (ASCII upper case: byte order)
	})
	metadata := []OptionMetadata{}
	clean := []CleanQuote{}
	diagnostics := []Diagnostic{}
	quotes := map[float64]*MarketQuote{}
	for i := range input.Quotes {
		quotes[input.Quotes[i].Token] = &input.Quotes[i]
	}
	contractKey := func(strike float64, side string) string { return jsjson.FormatNumber(strike) + ":" + side }
	duplicateTokens, duplicateContracts := newNumberSet(), map[string]bool{}
	seenTokens, seenContracts := newNumberSet(), map[string]bool{}
	for _, inst := range instruments {
		key := contractKey(inst.Strike, inst.InstrumentType)
		if seenTokens.has(inst.InstrumentToken) {
			duplicateTokens.add(inst.InstrumentToken)
		}
		if seenContracts[key] {
			duplicateContracts[key] = true
		}
		seenTokens.add(inst.InstrumentToken)
		seenContracts[key] = true
	}
	for ri := range rows {
		row := &rows[ri]
		var inst Instrument
		for _, i := range instruments {
			if i.InstrumentToken == row.Token {
				inst = i
				break
			}
		}
		resolved := ResolveOptionMetadata(inst, config.ExpiryPolicy, input.MetadataVersion)
		raw := quotes[row.Token]
		if raw != nil {
			row.Bid, row.Ask = raw.Bid, raw.Ask
		}
		if duplicateTokens.has(row.Token) || duplicateContracts[contractKey(row.Strike, row.Side)] {
			row.Reasons = append(row.Reasons, "duplicate_instrument_metadata")
			continue
		}
		if !resolved.OK {
			row.Reasons = append(row.Reasons, resolved.Reasons...)
			continue
		}
		md := resolved.Metadata
		row.Metadata = &md
		metadata = append(metadata, md)
		q, rejection := CleanQuoteFor(md, raw, now, config.Quote)
		if q != nil {
			clean = append(clean, *q)
			row.Quote = q
			if q.CalibrationEligible {
				row.Mid = P(q.Mid)
			}
			row.Reasons = append(row.Reasons, q.Reasons...)
		} else {
			row.Reasons = append(row.Reasons, rejection.Reasons...)
		}
	}
	timestamps := []string{}
	seenTimestamp := map[string]bool{}
	for _, m := range metadata {
		if !seenTimestamp[m.ExpiryTimestamp] {
			seenTimestamp[m.ExpiryTimestamp] = true
			timestamps = append(timestamps, m.ExpiryTimestamp)
		}
	}
	slice := ExpirySlice{Expiry: expiry, Forward: EmptyForward(), Smile: UnavailableSmile("No validated smile yet."),
		Rows: rows, Observations: []CalibrationObservation{}, Quality: "unavailable", Reasons: []string{}, Diagnostics: diagnostics}
	if len(timestamps) != 1 || timestamps[0] == "" {
		if len(timestamps) > 1 {
			slice.Reasons = append(slice.Reasons, "inconsistent_expiry_timestamps")
		} else {
			slice.Reasons = append(slice.Reasons, "expiry_time_unverified")
		}
		return slice
	}
	timestamp := timestamps[0]
	t := YearFraction(timestamp, now)
	slice.ExpiryTimestamp, slice.T = PS(timestamp), P(t)
	if t <= 0 {
		var indicative *float64
		if input.Spot != nil {
			indicative = P(input.Spot.Value)
		}
		for ri := range rows {
			row := &rows[ri]
			if row.Metadata != nil && row.LotSize != nil {
				payoff := SettlementPayoff(SettlementPayoffArgs{Strike: row.Strike, Side: row.Side, Lot: *row.LotSize,
					Indicative: indicative, SettlementUnderlying: row.Metadata.SettlementUnderlying})
				row.ExpiryPayoff = &payoff
				row.Quality = "limited"
				row.Reasons = append(row.Reasons, "expired", "official_settlement_unknown")
				row.EstimationMethod = "indicative_expiry_payoff"
			}
		}
		slice.Reasons = append(slice.Reasons, "expired", "official_settlement_unknown")
		return slice
	}
	discount := DiscountAt(&config.Curve, t)
	slice.Discount = &discount
	if discount.D == nil {
		slice.Reasons = append(slice.Reasons, "discount_unavailable")
		return slice
	}
	d := *discount.D
	coherent := CoherentSnapshot(clean, config.Quote)
	slice.SnapshotDispersionMs = coherent.DispersionMs
	for _, rejection := range coherent.Excluded {
		for ri := range rows {
			if rows[ri].Token == rejection.Token {
				rows[ri].Reasons = append(rows[ri].Reasons, rejection.Reasons...)
				break
			}
		}
	}
	forwardConfig := config.Forward
	forwardConfig.MaxPairDispersionMs = math.Min(config.Forward.MaxPairDispersionMs, config.Quote.MaxPairDispersionMs)
	options := EstimateOptionsForward(ForwardArgs{Metadata: metadata, Quotes: coherent.Eligible, D: d, Config: &forwardConfig})
	futureQuotes := []ForwardFuture{}
	for i := range input.Futures {
		future := &input.Futures[i]
		futureMeta := metadata[0]
		futureMeta.Token = future.Quote.Token
		futureMeta.TickSize = future.TickSize
		if !truthyNumber(futureMeta.Token) {
			continue
		}
		if q, _ := CleanQuoteFor(futureMeta, &future.Quote, now, config.Quote); q != nil {
			futureQuotes = append(futureQuotes, ForwardFuture{ExpiryTimestamp: future.ExpiryTimestamp, Quote: *q})
		}
	}
	forward := ResolveForward(ResolveArgs{Options: options, Expiry: timestamp, Now: now, Curve: &config.Curve,
		Futures: futureQuotes, Spot: input.Spot, Carry: config.CarryFor(input.Underlying), MaxAgeMs: config.Quote.MaxAgeMs})
	slice.Forward = forward
	if forward.Value == nil {
		slice.Reasons = append(slice.Reasons, "forward_unavailable")
		return slice
	}
	F := *forward.Value
	incoherentStrikes := newNumberSet()
	for _, p := range forward.ExcludedPairs {
		for _, reason := range p.Reasons {
			if incoherentReasons[reason] {
				incoherentStrikes.add(p.Strike)
				break
			}
		}
	}
	for ri := range rows {
		if incoherentStrikes.has(rows[ri].Strike) {
			rows[ri].Reasons = append(rows[ri].Reasons, "incoherent_call_put_pair_excluded_from_calibration")
		}
	}
	calibrationQuotes := []CleanQuote{}
	for _, q := range coherent.Eligible {
		strike := math.NaN()
		for _, m := range metadata {
			if m.Token == q.Token {
				strike = m.Strike
				break
			}
		}
		if !incoherentStrikes.has(strike) {
			calibrationQuotes = append(calibrationQuotes, q)
		}
	}
	selection := SelectObservations(metadata, calibrationQuotes, F, d, t, input, rows)
	// Both sides remain quote diagnostics after pair exclusion; zero bids never get a
	// normal midpoint inversion or calibration weight.
	ivConfig := config.Iv
	for ri := range rows {
		row := &rows[ri]
		if row.Metadata == nil || row.Quote == nil || row.ObservedIv != nil {
			continue
		}
		args := IvArgs{F: F, K: row.Strike, T: t, D: d, Side: row.Side, Tick: row.Metadata.TickSize, Config: &ivConfig}
		if row.Quote.Bid != nil {
			a := args
			a.Price = *row.Quote.Bid
			r := InvertIv(a)
			row.BidIv = &r
		}
		if row.Quote.Ask != nil {
			a := args
			a.Price = *row.Quote.Ask
			r := InvertIv(a)
			row.AskIv = &r
		}
		if row.Quote.CalibrationEligible {
			a := args
			a.Price = row.Quote.Mid
			h := row.Quote.H
			a.Uncertainty = &h
			r := InvertIv(a)
			row.ObservedIv = &r
		}
	}
	slice.Observations = selection.Observations
	slice.Smile = FitSmile(selection.Observations, F, d, config.Smile)
	smile := &slice.Smile
	smile.Calibration.Rejected = append(smile.Calibration.Rejected, selection.Rejected...)
	for ri := range rows {
		row := &rows[ri]
		observed := false
		for _, o := range selection.Observations {
			if o.Token == row.Token {
				observed = true
				break
			}
		}
		if observed || len(row.Reasons) == 0 {
			continue
		}
		listed := false
		for _, r := range smile.Calibration.Rejected {
			if r.Token == row.Token {
				listed = true
				break
			}
		}
		if !listed {
			smile.Calibration.Rejected = append(smile.Calibration.Rejected, Rejected{Token: row.Token, Reason: strings.Join(row.Reasons, ", ")})
		}
	}
	if smile.Valid && smile.Support != nil {
		requested := []float64{}
		for _, r := range rows {
			if r.Metadata == nil {
				continue
			}
			k := jsmath.Log(r.Strike / F)
			if k >= smile.Support.MinK-1e-12 && k <= smile.Support.MaxK+1e-12 {
				requested = append(requested, r.Strike)
			}
		}
		validation := ValidatePriceGrid(PriceGridArgs{F: F, D: d,
			Strikes:  IntermediateStrikes(append(append([]float64{}, smile.Support.Strikes...), requested...), 8),
			Variance: func(k float64) *float64 { return VarianceAt(smile, k, config.Smile, false) },
			Tick:     config.Quote.TickFloor, Config: config.Smile})
		if !validation.Valid {
			smile.Valid = false
			smile.Diagnostics = append(smile.Diagnostics, validation.Diagnostics...)
			smile.Diagnostics = append(smile.Diagnostics, Diagnostic{Code: "listed_price_validation_failure", Severity: "error",
				Message: "Price-space validation failed on listed/intermediate strikes; slice prices suppressed."})
		}
	}
	carry := config.CarryFor(input.Underlying)
	proportionalCarry := carry != nil && carry.Verified && carry.Proportional && len(carry.Dividends) == 0 && len(carry.CorporateActions) == 0
	var spotValue *float64
	if input.Spot != nil {
		spotValue = P(input.Spot.Value)
	}
	robust := forward.Source == "robust_options_implied"
	for ri := range rows {
		row := &rows[ri]
		if row.Metadata == nil {
			continue
		}
		k := jsmath.Log(row.Strike / F)
		wp := VarianceAt(smile, k, config.Smile, false)
		if wp == nil {
			if smile.Valid {
				row.Reasons = append(row.Reasons, "strike_outside_supported_range")
			} else {
				row.Reasons = append(row.Reasons, "smile_invalid_or_unavailable")
			}
			continue
		}
		w := *wp
		row.TotalVariance = P(w)
		surfaceIv := math.Sqrt(w / t)
		row.SurfaceIv = P(surfaceIv)
		fairValue := BlackPrice(BlackInput{F: F, K: row.Strike, D: d, W: w, Side: row.Side})
		row.FairValue = P(fairValue)
		if row.LotSize != nil {
			row.FairValuePerLot = P(*row.LotSize * fairValue)
		}
		greeks := FrozenBlackGreeks(GreeksArgs{BlackInput: BlackInput{F: F, K: row.Strike, D: d, W: w, Side: row.Side},
			T: t, Spot: spotValue, ProportionalCarry: proportionalCarry})
		row.Greeks = &greeks
		row.EstimationMethod = smile.Method
		if smile.Method == "svi" && len(row.Reasons) == 0 && discount.Assumption == nil && robust {
			row.Quality = "supported"
		} else {
			row.Quality = "limited"
		}
		if discount.Assumption != nil {
			row.Reasons = append(row.Reasons, "flat_discount_assumption")
		}
		if !robust {
			row.Reasons = append(row.Reasons, "forward_"+forward.Source)
		}
		if smile.Method == "validated_interpolation" {
			row.Reasons = append(row.Reasons, "validated_interpolation_limited_support")
		}
		if forward.Interval != nil && !forward.Interval.Compatible {
			row.Quality = "limited"
			row.Reasons = append(row.Reasons, "incompatible_forward_intervals")
		}
		if input.Universe.Bounded {
			row.Quality = "limited"
			row.Reasons = append(row.Reasons, "bounded_input_chain_support")
		}
		if row.Quote == nil {
			row.Reasons = append(row.Reasons, "observed_quote_unavailable_model_only")
		}
		sensitivity := ModelSensitivity(SensitivityArgs{F: F, Strike: row.Strike, T: t, D: d, Iv: surfaceIv, Side: row.Side,
			ForwardDispersion: forward.Dispersion, RateBump: config.SensitivityRateBump,
			QuoteIvBid: validIv(row.BidIv), QuoteIvAsk: validIv(row.AskIv)})
		row.Sensitivity = &sensitivity
		if row.Mid != nil && row.Quote != nil && row.LotSize != nil {
			lot := *row.LotSize
			deviation := *row.Mid - fairValue
			buy := fairValue - *row.Ask
			sell := *row.Bid - fairValue
			label := "Below model"
			switch {
			case math.Abs(deviation) < row.Metadata.TickSize*.01:
				label = "At model"
			case deviation > 0:
				label = "Above model"
			}
			row.Comparison = &PriceComparison{MidDeviation: deviation,
				MidDeviationPercent: 100 * deviation / math.Max(fairValue, config.Quote.PremiumFloor), Label: label,
				TheoreticalBuyDiff: buy, TheoreticalSellDiff: sell, LotMidDeviation: deviation * lot,
				LotBuyDifference: buy * lot, LotSellDifference: sell * lot,
				Convention: "Model comparisons before fees and execution costs; not trade recommendations."}
		}
	}
	if atm := VarianceAt(smile, 0, config.Smile, false); atm != nil {
		slice.AtmIv = P(math.Sqrt(*atm / t))
	}
	switch {
	case smile.Valid:
		if smile.Method == "svi" && discount.Assumption == nil && robust &&
			(forward.Interval == nil || forward.Interval.Compatible) && !input.Universe.Bounded {
			slice.Quality = "supported"
		} else {
			slice.Quality = "limited"
		}
	case smile.Method == "unavailable":
		slice.Quality = "unavailable"
	default:
		slice.Quality = "invalid"
	}
	if !smile.Valid {
		slice.Reasons = append(slice.Reasons, "smile_invalid_or_unavailable")
	}
	if discount.Assumption != nil {
		slice.Reasons = append(slice.Reasons, "flat_discount_assumption")
	}
	if input.Universe.Bounded {
		slice.Reasons = append(slice.Reasons, "bounded_input_chain_support")
	}
	slice.Diagnostics = append(slice.Diagnostics, forward.Diagnostics...)
	slice.Diagnostics = append(slice.Diagnostics, smile.Diagnostics...)
	return slice
}

func validIv(r *IvResult) *float64 {
	if r != nil && r.Status == "valid" {
		return r.Iv
	}
	return nil
}

func truthyNumber(x float64) bool { return x != 0 && !math.IsNaN(x) }

// BuildSurface is pipeline.ts buildSurface: every listed expiry of the input, then the
// calendar regions between them.
func BuildSurface(input *InputSnapshot) SurfaceSnapshot {
	start := perfNow()
	seen := map[string]bool{}
	expiries := []string{}
	for _, i := range input.Instruments {
		e := jsPrefix(i.Expiry, 10)
		if !seen[e] {
			seen[e] = true
			expiries = append(expiries, e)
		}
	}
	sortStable(expiries, func(a, b string) bool { return a < b })
	slices := make([]ExpirySlice, len(expiries))
	for i, e := range expiries {
		slices[i] = BuildSlice(input, e, nil)
	}
	diagnostics := []Diagnostic{}
	if input.Universe.Bounded {
		diagnostics = append(diagnostics, Diagnostic{Code: "bounded_capture", Severity: "warning",
			Message: jsjson.FormatNumber(input.Universe.CapturedContracts) + "/" + jsjson.FormatNumber(input.Universe.ListedContracts) +
				" listed contracts in bounded input snapshot; full-chain means all eligible observations in this captured snapshot."})
	}
	regions := BuildCalendarRegions(slices, input)
	return SurfaceSnapshot{ID: input.ID, InputSnapshotID: input.ID, ModelVersion: ModelVersion,
		ConfigVersion: input.ConfigVersion, Sequence: 0, Underlying: input.Underlying, Name: input.Name,
		Broker: input.Broker, BrokerGeneration: input.BrokerGeneration, FeedGeneration: input.FeedGeneration,
		ValuationTime: input.ValuationTime, PublishedAt: input.ValuationTime, Timezone: "Asia/Kolkata",
		DayCount: DayCount, PremiumUnit: "INR per underlying unit; per lot uses instrument multiplier",
		Slices: slices, CalendarRegions: regions, Spot: input.Spot, SpotProvenance: input.SpotProvenance,
		Curve: &input.Config.Curve, Carry: input.Config.CarryFor(input.Underlying), Universe: input.Universe,
		Diagnostics: diagnostics, DurationMs: perfNow() - start}
}
