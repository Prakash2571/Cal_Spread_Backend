package model

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// InputSnapshot is the immutable captured input of one surface (types.ts InputSnapshot).
type InputSnapshot struct {
	ID               string
	Underlying       string
	Name             string
	Broker           string
	BrokerGeneration float64
	FeedGeneration   float64
	ValuationTime    string
	MetadataVersion  string
	Instruments      []Instrument
	Quotes           []MarketQuote
	Spot             *Spot
	Futures          []Future
	Config           Config
	ConfigVersion    string
	Universe         Universe
	// SpotProvenance is written only when HasSpotProvenance (the engine always sets it,
	// to an object or null; inputs built elsewhere may leave it undefined).
	SpotProvenance    *SpotProvenance
	HasSpotProvenance bool
	// ListingCatalog is the complete verified listing metadata of the underlying,
	// attached after hashing; written only when HasListingCatalog.
	ListingCatalog    []OptionMetadata
	HasListingCatalog bool
}

// AppendJS writes the snapshot with the TypeScript object's key order.
func (in *InputSnapshot) AppendJS(dst []byte) []byte {
	o := jsjson.NewObject(dst).Field("id", in.ID).Field("underlying", in.Underlying).Field("name", in.Name).
		Field("broker", in.Broker).Field("broker_generation", in.BrokerGeneration).Field("feed_generation", in.FeedGeneration).
		Field("valuation_time", in.ValuationTime).Field("metadata_version", in.MetadataVersion).
		Field("instruments", in.Instruments).Field("quotes", in.Quotes).Field("spot", in.Spot).Field("futures", in.Futures).
		Field("config", in.Config).Field("config_version", in.ConfigVersion).Field("universe", in.Universe)
	if in.HasSpotProvenance {
		o.Field("spot_provenance", in.SpotProvenance)
	}
	if in.HasListingCatalog {
		o.Field("listing_catalog", in.ListingCatalog)
	}
	return o.End()
}

// HashID is engine.ts's input id: the first 32 hex digits of SHA-256 of the JSON with
// id "" (listing_catalog must not be attached yet).
func (in *InputSnapshot) HashID() string {
	saved := in.ID
	in.ID = ""
	sum := sha256.Sum256(in.AppendJS(nil))
	in.ID = saved
	return hex.EncodeToString(sum[:])[:32]
}

// WithoutListingCatalog is `const { listing_catalog: _catalog, ...rest } = input`.
func (in InputSnapshot) WithoutListingCatalog() InputSnapshot {
	in.ListingCatalog, in.HasListingCatalog = nil, false
	return in
}

// SurfaceSnapshot is one published surface (types.ts SurfaceSnapshot).
type SurfaceSnapshot struct {
	ID               string             `json:"id"`
	InputSnapshotID  string             `json:"input_snapshot_id"`
	ModelVersion     string             `json:"model_version"`
	ConfigVersion    string             `json:"config_version"`
	Sequence         float64            `json:"sequence"`
	Underlying       string             `json:"underlying"`
	Name             string             `json:"name"`
	Broker           string             `json:"broker"`
	BrokerGeneration float64            `json:"broker_generation"`
	FeedGeneration   float64            `json:"feed_generation"`
	ValuationTime    string             `json:"valuation_time"`
	PublishedAt      string             `json:"published_at"`
	Timezone         string             `json:"timezone"`
	DayCount         string             `json:"day_count"`
	PremiumUnit      string             `json:"premium_unit"`
	Slices           []ExpirySlice      `json:"slices"`
	CalendarRegions  []CalendarRegion   `json:"calendar_regions"`
	Spot             *Spot              `json:"spot"`
	SpotProvenance   *SpotProvenance    `json:"spot_provenance"`
	Curve            *DiscountCurveSpec `json:"curve"`
	Carry            *CarrySpec         `json:"carry"`
	Universe         Universe           `json:"universe"`
	Diagnostics      []Diagnostic       `json:"diagnostics"`
	DurationMs       float64            `json:"duration_ms"`
}

// HistorySummary is history.ts historySummary.
type HistorySummary struct {
	ID              string         `json:"id"`
	InputSnapshotID string         `json:"input_snapshot_id"`
	ModelVersion    string         `json:"model_version"`
	ConfigVersion   string         `json:"config_version"`
	Sequence        float64        `json:"sequence"`
	Underlying      string         `json:"underlying"`
	Broker          string         `json:"broker"`
	ValuationTime   string         `json:"valuation_time"`
	PublishedAt     string         `json:"published_at"`
	Slices          []SliceSummary `json:"slices"`
}

// SliceSummary is one slice of a HistorySummary.
type SliceSummary struct {
	Expiry          string   `json:"expiry"`
	ExpiryTimestamp *string  `json:"expiry_timestamp"`
	AtmIv           *float64 `json:"atm_iv"`
	Quality         string   `json:"quality"`
	Method          string   `json:"method"`
	Observations    float64  `json:"observations"`
}

// Summary is historySummary(snapshot).
func (s *SurfaceSnapshot) Summary() HistorySummary {
	out := HistorySummary{ID: s.ID, InputSnapshotID: s.InputSnapshotID, ModelVersion: s.ModelVersion,
		ConfigVersion: s.ConfigVersion, Sequence: s.Sequence, Underlying: s.Underlying, Broker: s.Broker,
		ValuationTime: s.ValuationTime, PublishedAt: s.PublishedAt, Slices: []SliceSummary{}}
	for _, sl := range s.Slices {
		out.Slices = append(out.Slices, SliceSummary{Expiry: sl.Expiry, ExpiryTimestamp: sl.ExpiryTimestamp, AtmIv: sl.AtmIv,
			Quality: sl.Quality, Method: sl.Smile.Method, Observations: sl.Smile.Calibration.ObservationCount})
	}
	return out
}

// IndependentValue is one side of an independent estimate.
type IndependentValue struct {
	Side      string   `json:"side"`
	FairValue float64  `json:"fair_value"`
	PerLot    *float64 `json:"per_lot"`
}

// IndependentEstimate is the leave-one-strike-out result (types.ts IndependentEstimate).
type IndependentEstimate struct {
	Status          string             `json:"status"`
	InputSnapshotID string             `json:"input_snapshot_id"`
	ConfigVersion   string             `json:"config_version"`
	Expiry          string             `json:"expiry"`
	Strike          float64            `json:"strike"`
	Values          []IndependentValue `json:"values"`
	Forward         ForwardResult      `json:"forward"`
	Smile           SmileModel         `json:"smile"`
	ExcludedTokens  []float64          `json:"excluded_tokens"`
	DurationMs      float64            `json:"duration_ms"`
	Reasons         []string           `json:"reasons"`
}

// CalculatorRequest is a validated calculator request. InputSnapshotID nil is absent.
type CalculatorRequest struct {
	Underlying      string
	Strike          float64
	ExpiryTimestamp string
	Side            string
	ResearchMode    bool
	InputSnapshotID *string
}

// CalculatorResult is the calculator outcome (types.ts CalculatorResult).
type CalculatorResult struct {
	Available       bool              `json:"available"`
	InputSnapshotID string            `json:"input_snapshot_id"`
	ConfigVersion   string            `json:"config_version"`
	ModelVersion    string            `json:"model_version"`
	ValuationTime   string            `json:"valuation_time"`
	Contract        string            `json:"contract"`
	InstrumentToken *float64          `json:"instrument_token"`
	StrikeMethod    string            `json:"strike_method"`
	MaturityMethod  string            `json:"maturity_method"`
	Strike          float64           `json:"strike"`
	ExpiryTimestamp string            `json:"expiry_timestamp"`
	Side            string            `json:"side"`
	T               float64           `json:"t"`
	Forward         *float64          `json:"forward"`
	Discount        *float64          `json:"discount"`
	K               *float64          `json:"k"`
	TotalVariance   *float64          `json:"total_variance"`
	SurfaceIv       *float64          `json:"surface_iv"`
	FairValue       *float64          `json:"fair_value"`
	FairValuePerLot *float64          `json:"fair_value_per_lot"`
	LotSize         *float64          `json:"lot_size"`
	Greeks          *BlackGreeks      `json:"greeks"`
	Quality         string            `json:"quality"`
	Reasons         []string          `json:"reasons"`
	Assumptions     []string          `json:"assumptions"`
	Diagnostics     []Diagnostic      `json:"diagnostics"`
	Sensitivity     *SensitivityRange `json:"sensitivity"`
}
