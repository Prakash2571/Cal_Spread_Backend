package model

import (
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// This file holds the contract shapes of src/fairValue/types.ts. Struct fields are
// declared in the order the TypeScript functions build the objects, because that order
// is the JSON key order (and feeds the config and input-snapshot hashes). A TypeScript
// `number | null` is a *float64 (nil is null; a pointer to NaN or Infinity still prints
// null, like JSON.stringify). Only pointer fields carry `omitempty`, and they mean "the
// property is undefined", never "null".
//
// Unexported helpers never carry state that is not also derivable from the JSON, except
// the two ordering flags documented on ForwardResult and Calibration.

// P returns a pointer to v (a non-null number).
func P(v float64) *float64 { return &v }

// PS returns a pointer to s (a non-null string).
func PS(s string) *string { return &s }

// Side names: option sides are plain strings because the TypeScript functions are also
// called with invalid sides (they throw), and JSON carries whatever was given.
const (
	CE = "CE"
	PE = "PE"
)

// Diagnostic is a validation or model note. strike, k and value are omitted when absent.
type Diagnostic struct {
	Code     string   `json:"code"`
	Severity string   `json:"severity"`
	Message  string   `json:"message"`
	Strike   *float64 `json:"strike,omitempty"`
	K        *float64 `json:"k,omitempty"`
	Value    *float64 `json:"value,omitempty"`
}

// SourceStamp is the provenance of a curve, policy or carry specification.
type SourceStamp struct {
	Source     string `json:"source"`
	AsOf       string `json:"as_of"`
	Version    string `json:"version"`
	Convention string `json:"convention"`
}

// OptionMetadata is the verified contract description derived from an instrument row.
type OptionMetadata struct {
	Token                float64 `json:"token"`
	Tradingsymbol        string  `json:"tradingsymbol"`
	Underlying           string  `json:"underlying"`
	Exchange             string  `json:"exchange"`
	Side                 string  `json:"side"`
	Strike               float64 `json:"strike"`
	Expiry               string  `json:"expiry"`
	ExpiryTimestamp      string  `json:"expiry_timestamp"`
	ExpirySource         string  `json:"expiry_source"`
	Timezone             string  `json:"timezone"`
	Style                string  `json:"style"`
	SettlementUnderlying string  `json:"settlement_underlying"`
	LotSize              float64 `json:"lot_size"`
	TickSize             float64 `json:"tick_size"`
	MetadataVersion      string  `json:"metadata_version"`
}

// Instrument is one instrument-master row as the Fair Value input snapshot carries it:
// the broker-neutral fields plus the optional exact expiry timestamp and exercise style
// that metadata resolution honours when present. Raw, set when the row was decoded from
// JSON, keeps that row's own key order for JSON output; rows built from the instrument
// provider have none and use the Kite CSV order below.
type Instrument struct {
	InstrumentToken float64        `json:"instrument_token"`
	ExchangeToken   float64        `json:"exchange_token"`
	Tradingsymbol   string         `json:"tradingsymbol"`
	Name            string         `json:"name"`
	LastPrice       float64        `json:"last_price"`
	Expiry          string         `json:"expiry"`
	Strike          float64        `json:"strike"`
	TickSize        float64        `json:"tick_size"`
	LotSize         float64        `json:"lot_size"`
	InstrumentType  string         `json:"instrument_type"`
	Segment         string         `json:"segment"`
	Exchange        string         `json:"exchange"`
	ExpiryTimestamp *string        `json:"expiry_timestamp,omitempty"`
	ExerciseStyle   *string        `json:"exercise_style,omitempty"`
	Raw             *jsjson.Object `json:"-"`
}

// AppendJS writes the row.
func (i Instrument) AppendJS(dst []byte) []byte {
	if i.Raw != nil {
		return i.Raw.AppendJS(dst)
	}
	type plain Instrument
	return jsjson.Append(dst, plain(i))
}

// MarketQuote is the latest top-of-book for a token.
type MarketQuote struct {
	Token             float64  `json:"token"`
	Bid               *float64 `json:"bid"`
	Ask               *float64 `json:"ask"`
	BidDepth          float64  `json:"bid_depth"`
	AskDepth          float64  `json:"ask_depth"`
	ExchangeTimestamp *string  `json:"exchange_timestamp"`
	ReceiveTimestamp  string   `json:"receive_timestamp"`
	Source            string   `json:"source"`
	Version           float64  `json:"version"`
}

// CleanQuote is a MarketQuote that passed the quote policy, with derived fields.
type CleanQuote struct {
	MarketQuote
	Mid                 float64  `json:"mid"`
	Spread              float64  `json:"spread"`
	RelativeSpread      float64  `json:"relative_spread"`
	AgeMs               float64  `json:"age_ms"`
	FreshnessBasis      string   `json:"freshness_basis"`
	QuoteTimestamp      string   `json:"quote_timestamp"`
	AvailableDepth      float64  `json:"available_depth"`
	Weight              float64  `json:"weight"`
	H                   float64  `json:"h"`
	CalibrationEligible bool     `json:"calibration_eligible"`
	Reasons             []string `json:"reasons"`
}

// QuotePolicy is the quote-cleaning configuration.
type QuotePolicy struct {
	MaxAgeMs                   float64 `json:"max_age_ms"`
	MaxRelativeSpread          float64 `json:"max_relative_spread"`
	MaxAbsoluteSpread          float64 `json:"max_absolute_spread"`
	MinDepth                   float64 `json:"min_depth"`
	PremiumFloor               float64 `json:"premium_floor"`
	TickFloor                  float64 `json:"tick_floor"`
	DepthTarget                float64 `json:"depth_target"`
	FreshnessTauMs             float64 `json:"freshness_tau_ms"`
	MaxPairDispersionMs        float64 `json:"max_pair_dispersion_ms"`
	MaxSnapshotDispersionMs    float64 `json:"max_snapshot_dispersion_ms"`
	FutureTimestampToleranceMs float64 `json:"future_timestamp_tolerance_ms"`
	ZeroBidPolicy              string  `json:"zero_bid_policy"`
}

// QuoteRejection explains why a quote was not usable.
type QuoteRejection struct {
	Token   float64  `json:"token"`
	Strike  *float64 `json:"strike"`
	Side    *string  `json:"side"`
	Reasons []string `json:"reasons"`
}

// CurveNode is one continuous-zero-rate node (T in ACT/365F years). Raw, when set, is
// the object exactly as configured (extra keys and key order included) and is what is
// written to JSON.
type CurveNode struct {
	T        float64        `json:"t"`
	ZeroRate float64        `json:"zero_rate"`
	Raw      *jsjson.Object `json:"-"`
}

// AppendJS writes the node as configured.
func (n CurveNode) AppendJS(dst []byte) []byte {
	if n.Raw != nil {
		return n.Raw.AppendJS(dst)
	}
	return jsjson.NewObject(dst).Field("t", n.T).Field("zero_rate", n.ZeroRate).End()
}

// DiscountCurveSpec is the configured discount curve. Raw, when set, is the curve object
// exactly as configured (key order, extra node keys) and is what is written to JSON.
type DiscountCurveSpec struct {
	SourceStamp
	Nodes             []CurveNode    `json:"nodes"`
	FlatRate          *float64       `json:"flat_rate"`
	AllowFlatFallback bool           `json:"allow_flat_fallback"`
	Raw               *jsjson.Object `json:"-"`
}

// AppendJS writes the curve as configured.
func (s *DiscountCurveSpec) AppendJS(dst []byte) []byte {
	if s.Raw != nil {
		return s.Raw.AppendJS(dst)
	}
	type plain DiscountCurveSpec
	return jsjson.Append(dst, (*plain)(s))
}

// DiscountResult is the outcome of a discount-factor lookup.
type DiscountResult struct {
	Available  bool        `json:"available"`
	D          *float64    `json:"d"`
	ZeroRate   *float64    `json:"zero_rate"`
	Method     string      `json:"method"`
	Assumption *string     `json:"assumption"`
	Reason     *string     `json:"reason"`
	Provenance SourceStamp `json:"provenance"`
}

// Dividend is one known cash dividend.
type Dividend struct {
	Timestamp string  `json:"timestamp"`
	Amount    float64 `json:"amount"`
}

// CarrySpec is a verified carry description for one underlying. Raw, when set, is the
// object as configured and is what is written to JSON.
type CarrySpec struct {
	SourceStamp
	Verified         bool           `json:"verified"`
	Proportional     bool           `json:"proportional"`
	DividendYield    *float64       `json:"dividend_yield"`
	Dividends        []Dividend     `json:"dividends"`
	CorporateActions []string       `json:"corporate_actions"`
	Raw              *jsjson.Object `json:"-"`
}

// AppendJS writes the spec as configured.
func (c *CarrySpec) AppendJS(dst []byte) []byte {
	if c.Raw != nil {
		return c.Raw.AppendJS(dst)
	}
	type plain CarrySpec
	return jsjson.Append(dst, (*plain)(c))
}

// ExpiryPolicy turns date-only expiries into exact timestamps. Raw as for CarrySpec.
type ExpiryPolicy struct {
	SourceStamp
	Exchange  string            `json:"exchange"`
	Timezone  string            `json:"timezone"`
	LocalTime string            `json:"local_time"`
	Overrides map[string]string `json:"overrides"`
	Raw       *jsjson.Object    `json:"-"`
}

// AppendJS writes the policy as configured.
func (p *ExpiryPolicy) AppendJS(dst []byte) []byte {
	if p.Raw != nil {
		return p.Raw.AppendJS(dst)
	}
	type plain ExpiryPolicy
	return jsjson.Append(dst, (*plain)(p))
}

// ForwardPair is one call-put parity forward.
type ForwardPair struct {
	Strike    float64 `json:"strike"`
	Forward   float64 `json:"forward"`
	Lower     float64 `json:"lower"`
	Upper     float64 `json:"upper"`
	Weight    float64 `json:"weight"`
	Scale     float64 `json:"scale"`
	CallToken float64 `json:"call_token"`
	PutToken  float64 `json:"put_token"`
	Residual  float64 `json:"residual"`
}

// ExcludedPair is a strike left out of the forward estimate.
type ExcludedPair struct {
	Strike  float64  `json:"strike"`
	Reasons []string `json:"reasons"`
}

// ForwardInterval is the intersection of the pair bid/ask forward intervals.
type ForwardInterval struct {
	Lower      float64 `json:"lower"`
	Upper      float64 `json:"upper"`
	Compatible bool    `json:"compatible"`
}

// ForwardResult is the forward estimate. The TypeScript object literals differ in key
// order: the successful options estimate lists diagnostics before assumptions, while the
// unavailable result (and anything resolved from it with a spread) lists assumptions
// first. SuccessOrder selects the first form.
type ForwardResult struct {
	Available     bool             `json:"available"`
	Value         *float64         `json:"value"`
	Source        string           `json:"source"`
	PairCount     float64          `json:"pair_count"`
	Dispersion    *float64         `json:"dispersion"`
	Interval      *ForwardInterval `json:"interval"`
	Pairs         []ForwardPair    `json:"pairs"`
	ExcludedPairs []ExcludedPair   `json:"excluded_pairs"`
	Assumptions   []string         `json:"assumptions"`
	Diagnostics   []Diagnostic     `json:"diagnostics"`
	SuccessOrder  bool             `json:"-"`
}

// AppendJS writes the forward result in the key order the TypeScript produced.
func (f ForwardResult) AppendJS(dst []byte) []byte {
	o := jsjson.NewObject(dst).Field("available", f.Available).Field("value", f.Value).Field("source", f.Source).
		Field("pair_count", f.PairCount).Field("dispersion", f.Dispersion).Field("interval", f.Interval).
		Field("pairs", f.Pairs).Field("excluded_pairs", f.ExcludedPairs)
	if f.SuccessOrder {
		return o.Field("diagnostics", f.Diagnostics).Field("assumptions", f.Assumptions).End()
	}
	return o.Field("assumptions", f.Assumptions).Field("diagnostics", f.Diagnostics).End()
}

// IvConfig is the implied-volatility solver configuration.
type IvConfig struct {
	InitialHigh           float64 `json:"initial_high"`
	MaxVolatility         float64 `json:"max_volatility"`
	MaxExpansions         float64 `json:"max_expansions"`
	MaxIterations         float64 `json:"max_iterations"`
	PriceTolerance        float64 `json:"price_tolerance"`
	TickToleranceFraction float64 `json:"tick_tolerance_fraction"`
	VolatilityTolerance   float64 `json:"volatility_tolerance"`
	LowVegaThreshold      float64 `json:"low_vega_threshold"`
	MaxIvUncertainty      float64 `json:"max_iv_uncertainty"`
}

// IvResult is an implied-volatility inversion outcome; failures are statuses.
type IvResult struct {
	Status     string   `json:"status"`
	Reason     string   `json:"reason"`
	Iv         *float64 `json:"iv"`
	Iterations float64  `json:"iterations"`
	Residual   *float64 `json:"residual"`
	Vega       *float64 `json:"vega"`
}

// BlackInput is the input of the Black-76 price.
type BlackInput struct {
	F    float64
	K    float64
	D    float64
	W    float64
	Side string
}

// BlackGreeks are frozen-volatility Greeks.
type BlackGreeks struct {
	ForwardDelta     float64  `json:"forward_delta"`
	ForwardGamma     *float64 `json:"forward_gamma"`
	Vega1Pct         float64  `json:"vega_1pct"`
	SpotDelta        *float64 `json:"spot_delta"`
	SpotGamma        *float64 `json:"spot_gamma"`
	ThetaCalendarDay *float64 `json:"theta_calendar_day"`
	Rho1Pct          float64  `json:"rho_1pct"`
	Convention       string   `json:"convention"`
}

// ExpiryPayoff is the payoff of an expired contract.
type ExpiryPayoff struct {
	Value       *float64 `json:"value"`
	ValuePerLot *float64 `json:"value_per_lot"`
	Status      string   `json:"status"`
	Reason      string   `json:"reason"`
}

// CalibrationObservation is one quote prepared for smile calibration.
type CalibrationObservation struct {
	Strike           float64    `json:"strike"`
	K                float64    `json:"k"`
	W                float64    `json:"w"`
	Iv               float64    `json:"iv"`
	Side             string     `json:"side"`
	Token            float64    `json:"token"`
	Quote            CleanQuote `json:"quote"`
	DependenceFactor float64    `json:"dependence_factor"`
}

// SviParameters are raw SVI parameters (eta is the SVI sigma).
type SviParameters struct {
	A   float64 `json:"a"`
	B   float64 `json:"b"`
	Rho float64 `json:"rho"`
	M   float64 `json:"m"`
	Eta float64 `json:"eta"`
}

// SmileConfig is the smile calibration configuration.
type SmileConfig struct {
	Model                  string  `json:"model"`
	MinSviStrikes          float64 `json:"min_svi_strikes"`
	MinKSpan               float64 `json:"min_k_span"`
	MinEachWing            float64 `json:"min_each_wing"`
	AtmBand                float64 `json:"atm_band"`
	MinInterpolationStrike float64 `json:"min_interpolation_strikes"`
	MaxInterpolationGap    float64 `json:"max_interpolation_gap"`
	HuberDelta             float64 `json:"huber_delta"`
	Regularization         float64 `json:"regularization"`
	MaxNormalizedRmse      float64 `json:"max_normalized_rmse"`
	OptimizerIterations    float64 `json:"optimizer_iterations"`
	OptimizerStarts        float64 `json:"optimizer_starts"`
	OptimizerTolerance     float64 `json:"optimizer_tolerance"`
	ButterflyTolerance     float64 `json:"butterfly_tolerance"`
	VarianceFloor          float64 `json:"variance_floor"`
	MaxWingSlope           float64 `json:"max_wing_slope"`
	DiagnosticPoints       float64 `json:"diagnostic_points"`
	AdaptiveDepth          float64 `json:"adaptive_depth"`
	StrikeExtrapolationK   float64 `json:"strike_extrapolation_k"`
	CalendarTolerance      float64 `json:"calendar_tolerance"`
	PriceToleranceTicks    float64 `json:"price_tolerance_ticks"`
}

// FitResidual is one calibration residual row.
type FitResidual struct {
	Token                float64 `json:"token"`
	Strike               float64 `json:"strike"`
	Side                 string  `json:"side"`
	ModelPrice           float64 `json:"model_price"`
	Residual             float64 `json:"residual"`
	StandardizedResidual float64 `json:"standardized_residual"`
	InsideSpread         bool    `json:"inside_spread"`
}

// Rejected is an observation that was not used.
type Rejected struct {
	Token  float64 `json:"token"`
	Reason string  `json:"reason"`
}

// SmileNode is a (k, w) pair of an interpolation smile.
type SmileNode struct {
	K float64 `json:"k"`
	W float64 `json:"w"`
}

// SmileSupport is the strike support of a smile.
type SmileSupport struct {
	MinK    float64   `json:"min_k"`
	MaxK    float64   `json:"max_k"`
	Strikes []float64 `json:"strikes"`
}

// Butterfly summarises the density diagnostics of a smile.
type Butterfly struct {
	MinG           *float64    `json:"min_g"`
	CheckedPoints  float64     `json:"checked_points"`
	Domain         *[2]float64 `json:"domain"`
	RightWingSlope *float64    `json:"right_wing_slope"`
	LeftWingSlope  *float64    `json:"left_wing_slope"`
	TailCondition  *bool       `json:"tail_condition"`
	GlobalProof    bool        `json:"global_proof"`
}

// Calibration reports how a smile was fitted. SVI models list the residual block first;
// every other model lists the counts first (SviOrder selects the first form).
type Calibration struct {
	ObservationCount    float64       `json:"observation_count"`
	DistinctStrikes     float64       `json:"distinct_strikes"`
	NormalizedRmse      *float64      `json:"normalized_rmse"`
	InsideSpreadPercent *float64      `json:"inside_spread_percent"`
	OptimizerStatus     string        `json:"optimizer_status"`
	OptimizerIterations float64       `json:"optimizer_iterations"`
	OptimizerStarts     float64       `json:"optimizer_starts"`
	DurationMs          float64       `json:"duration_ms"`
	Residuals           []FitResidual `json:"residuals"`
	Rejected            []Rejected    `json:"rejected"`
	SviOrder            bool          `json:"-"`
}

// AppendJS writes the calibration in the key order the TypeScript produced.
func (c Calibration) AppendJS(dst []byte) []byte {
	o := jsjson.NewObject(dst)
	if c.SviOrder {
		return o.Field("residuals", c.Residuals).Field("normalized_rmse", c.NormalizedRmse).
			Field("inside_spread_percent", c.InsideSpreadPercent).Field("observation_count", c.ObservationCount).
			Field("distinct_strikes", c.DistinctStrikes).Field("optimizer_status", c.OptimizerStatus).
			Field("optimizer_iterations", c.OptimizerIterations).Field("optimizer_starts", c.OptimizerStarts).
			Field("duration_ms", c.DurationMs).Field("rejected", c.Rejected).End()
	}
	return o.Field("observation_count", c.ObservationCount).Field("distinct_strikes", c.DistinctStrikes).
		Field("normalized_rmse", c.NormalizedRmse).Field("inside_spread_percent", c.InsideSpreadPercent).
		Field("optimizer_status", c.OptimizerStatus).Field("optimizer_iterations", c.OptimizerIterations).
		Field("optimizer_starts", c.OptimizerStarts).Field("duration_ms", c.DurationMs).
		Field("residuals", c.Residuals).Field("rejected", c.Rejected).End()
}

// SmileModel is a fitted (or unavailable) smile for one expiry.
type SmileModel struct {
	Method      string         `json:"method"`
	Parameters  *SviParameters `json:"parameters"`
	Nodes       []SmileNode    `json:"nodes"`
	Support     *SmileSupport  `json:"support"`
	Valid       bool           `json:"valid"`
	Diagnostics []Diagnostic   `json:"diagnostics"`
	Butterfly   Butterfly      `json:"butterfly"`
	Calibration Calibration    `json:"calibration"`
}

// PriceComparison compares a market mid with the model value.
type PriceComparison struct {
	MidDeviation        float64 `json:"mid_deviation"`
	MidDeviationPercent float64 `json:"mid_deviation_percent"`
	Label               string  `json:"label"`
	TheoreticalBuyDiff  float64 `json:"theoretical_buy_difference"`
	TheoreticalSellDiff float64 `json:"theoretical_sell_difference"`
	LotMidDeviation     float64 `json:"lot_mid_deviation"`
	LotBuyDifference    float64 `json:"lot_buy_difference"`
	LotSellDifference   float64 `json:"lot_sell_difference"`
	Convention          string  `json:"convention"`
}

// Scenario is one sensitivity repricing.
type Scenario struct {
	Name       string  `json:"name"`
	Forward    float64 `json:"forward"`
	Discount   float64 `json:"discount"`
	Iv         float64 `json:"iv"`
	Price      float64 `json:"price"`
	Assumption string  `json:"assumption"`
}

// SensitivityRange is the documented scenario range of a price.
type SensitivityRange struct {
	Label     string     `json:"label"`
	Low       float64    `json:"low"`
	High      float64    `json:"high"`
	Scenarios []Scenario `json:"scenarios"`
	Reasons   []string   `json:"reasons"`
}

// ValuationRow is one contract row of an expiry slice.
type ValuationRow struct {
	Token             float64           `json:"token"`
	Tradingsymbol     string            `json:"tradingsymbol"`
	Strike            float64           `json:"strike"`
	Side              string            `json:"side"`
	Metadata          *OptionMetadata   `json:"metadata"`
	LotSize           *float64          `json:"lot_size"`
	Bid               *float64          `json:"bid"`
	Ask               *float64          `json:"ask"`
	Mid               *float64          `json:"mid"`
	Quote             *CleanQuote       `json:"quote"`
	ObservedIv        *IvResult         `json:"observed_iv"`
	BidIv             *IvResult         `json:"bid_iv"`
	AskIv             *IvResult         `json:"ask_iv"`
	SurfaceIv         *float64          `json:"surface_iv"`
	TotalVariance     *float64          `json:"total_variance"`
	FairValue         *float64          `json:"fair_value"`
	FairValuePerLot   *float64          `json:"fair_value_per_lot"`
	IndependentValue  *float64          `json:"independent_value"`
	IndependentStatus string            `json:"independent_status"`
	Comparison        *PriceComparison  `json:"comparison"`
	Greeks            *BlackGreeks      `json:"greeks"`
	Quality           string            `json:"quality"`
	Reasons           []string          `json:"reasons"`
	EstimationMethod  string            `json:"estimation_method"`
	ExpiryPayoff      *ExpiryPayoff     `json:"expiry_payoff"`
	Sensitivity       *SensitivityRange `json:"sensitivity"`
}

// ExpirySlice is the valuation of one listed expiry.
type ExpirySlice struct {
	Expiry               string                   `json:"expiry"`
	ExpiryTimestamp      *string                  `json:"expiry_timestamp"`
	T                    *float64                 `json:"t"`
	Discount             *DiscountResult          `json:"discount"`
	Forward              ForwardResult            `json:"forward"`
	Smile                SmileModel               `json:"smile"`
	Rows                 []ValuationRow           `json:"rows"`
	Observations         []CalibrationObservation `json:"observations"`
	SnapshotDispersionMs float64                  `json:"snapshot_dispersion_ms"`
	AtmIv                *float64                 `json:"atm_iv"`
	Quality              string                   `json:"quality"`
	Reasons              []string                 `json:"reasons"`
	Diagnostics          []Diagnostic             `json:"diagnostics"`
}

// CalendarRegion is a validated (or not) common-support calendar region.
type CalendarRegion struct {
	FirstExpiry  string       `json:"first_expiry"`
	SecondExpiry string       `json:"second_expiry"`
	MinK         float64      `json:"min_k"`
	MaxK         float64      `json:"max_k"`
	Valid        bool         `json:"valid"`
	Diagnostics  []Diagnostic `json:"diagnostics"`
}

// Spot is the underlying spot. The engine's spot also carries the tick provenance
// (exchange_timestamp, receive_timestamp, freshness_basis) as extra properties, which
// are part of the JSON and of the input hash; Provenance is nil for a plain {value,
// timestamp} spot.
type Spot struct {
	Value      float64
	Timestamp  string
	Provenance *SpotProvenance
}

// AppendJS writes {value, timestamp[, exchange_timestamp, receive_timestamp, freshness_basis]}.
func (s Spot) AppendJS(dst []byte) []byte {
	o := jsjson.NewObject(dst).Field("value", s.Value).Field("timestamp", s.Timestamp)
	if s.Provenance != nil {
		o.Field("exchange_timestamp", s.Provenance.ExchangeTimestamp).
			Field("receive_timestamp", s.Provenance.ReceiveTimestamp).
			Field("freshness_basis", s.Provenance.FreshnessBasis)
	}
	return o.End()
}

// Universe describes how much of the listed chain an input snapshot captured.
type Universe struct {
	ListedContracts   float64  `json:"listed_contracts"`
	CapturedContracts float64  `json:"captured_contracts"`
	OmittedExpiries   []string `json:"omitted_expiries"`
	Bounded           bool     `json:"bounded"`
}

// SpotProvenance records which timestamp the spot came from.
type SpotProvenance struct {
	ExchangeTimestamp *string `json:"exchange_timestamp"`
	ReceiveTimestamp  string  `json:"receive_timestamp"`
	FreshnessBasis    string  `json:"freshness_basis"`
}

// Future is one futures quote used for the forward.
type Future struct {
	ExpiryTimestamp string      `json:"expiry_timestamp"`
	Quote           MarketQuote `json:"quote"`
	TickSize        float64     `json:"tick_size"`
}
