package model

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// ModelVersion is config.ts MODEL_VERSION.
const ModelVersion = "black-act365f-raw-svi-price-huber-v1"

// DefaultSmileConfig is config.ts DEFAULT_SMILE_CONFIG.
var DefaultSmileConfig = SmileConfig{
	Model: "svi", MinSviStrikes: 9, MinKSpan: 0.10, MinEachWing: 3,
	AtmBand: 0.01, MinInterpolationStrike: 3, MaxInterpolationGap: 0.15,
	HuberDelta: 1.5, Regularization: 0.001, MaxNormalizedRmse: 4,
	OptimizerIterations: 700, OptimizerStarts: 5, OptimizerTolerance: 1e-7,
	ButterflyTolerance: 1e-8, VarianceFloor: 1e-12, MaxWingSlope: 1.999,
	DiagnosticPoints: 161, AdaptiveDepth: 4, StrikeExtrapolationK: 0.10,
	CalendarTolerance: 1e-8, PriceToleranceTicks: 0.02,
}

// Config is the Fair Value configuration (types.ts FairValueConfig).
//
// Raw is the JavaScript object exactly as the Node service held it: key order, values
// replaced wholesale by an admin (carry, expiry_policy, curve.nodes, dividends) in the
// order and with any extra keys they were sent with. Raw is the source of every JSON
// rendering of the configuration, of config_version and of the input-snapshot hash.
// The typed fields are decoded from Raw after validation and are what the model reads.
// A Config is immutable; the With* helpers return modified copies.
type Config struct {
	Raw *jsjson.Object

	Enabled                        bool
	RefreshMs                      float64
	SurfaceMaxAgeMs                float64
	MaxUnderlyings                 float64
	MaxTokens                      float64
	MaxExpiries                    float64
	UniverseRefreshMs              float64
	RecenterLogDistance            float64
	Workers                        float64
	WorkerTimeoutMs                float64
	MaxQueue                       float64
	HistoryLimit                   float64
	HistoryIntervalMs              float64
	HistoryRetentionDays           float64
	HistoryMemoryMaxBytes          float64
	IndependentCacheLimit          float64
	IndependentCacheTtlMs          float64
	ResearchEnabled                bool
	MaturityExtrapolation          string
	MaxMaturityExtrapolationDays   float64
	ForwardInterpolation           string
	ProportionalCalendarAssumption bool
	SensitivityRateBump            float64
	Quote                          QuotePolicy
	Iv                             IvConfig
	Forward                        ForwardConfig
	Smile                          SmileConfig
	Curve                          DiscountCurveSpec
	ExpiryPolicy                   *ExpiryPolicy
	Carry                          map[string]*CarrySpec
}

// AppendJS writes the configuration exactly as JSON.stringify did.
func (c Config) AppendJS(dst []byte) []byte { return c.Raw.AppendJS(dst) }

// CarryFor is config.carry[underlying] ?? null.
func (c *Config) CarryFor(underlying string) *CarrySpec { return c.Carry[underlying] }

// Version is configVersion(config): the first 20 hex digits of SHA-256 of the JSON.
func (c Config) Version() string {
	sum := sha256.Sum256(c.Raw.AppendJS(nil))
	return hex.EncodeToString(sum[:])[:20]
}

// Clone is structuredClone(config).
func (c Config) Clone() Config { return mustDecode(c.Raw.Clone()) }

// With returns a copy whose raw object was changed by edit (the TypeScript code and
// the tests assign config properties directly). The result is validated.
func (c Config) With(edit func(raw *jsjson.Object)) (Config, error) {
	raw := c.Raw.Clone()
	edit(raw)
	return DecodeConfig(raw)
}

// WithEnabled is `config.enabled = value` on a copy (no validation needed).
func (c Config) WithEnabled(enabled bool) Config {
	raw := c.Raw.Clone()
	raw.Set("enabled", enabled)
	return mustDecode(raw)
}

func mustDecode(raw *jsjson.Object) Config {
	cfg, err := DecodeConfig(raw)
	if err != nil {
		panic(err)
	}
	return cfg
}

// objectOf renders a typed struct as an ordered object (struct field order is the
// TypeScript object-literal order of the defaults).
func objectOf(v any) *jsjson.Object {
	parsed, err := jsjson.Parse(jsjson.Marshal(v))
	if err != nil {
		panic(err)
	}
	return parsed.(*jsjson.Object)
}

// LookupEnv reads one environment variable (os.LookupEnv in production).
type LookupEnv func(key string) (string, bool)

// DefaultConfig is config.ts defaultConfig(env). nowMs is the boot time, which becomes
// the unconfigured curve's as_of (so the default version changes on every restart, as
// in Node). FAIR_VALUE_CONFIG_JSON, when not blank, is parsed and merged; its errors are
// the JSON.parse or validation messages Node produced.
func DefaultConfig(env LookupEnv, nowMs float64) (cfg Config, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = AsError(r)
		}
	}()
	if env == nil {
		env = func(string) (string, bool) { return "", false }
	}
	enabled, _ := env("FAIR_VALUE_ENABLED")
	raw := jsjson.NewObjectValue()
	for _, kv := range []struct {
		k string
		v any
	}{
		{"enabled", enabled == "true"}, {"refresh_ms", 5000.0}, {"surface_max_age_ms", 60000.0},
		{"max_underlyings", 3.0}, {"max_tokens", 600.0}, {"max_expiries", 4.0},
		{"universe_refresh_ms", 60000.0}, {"recenter_log_distance", 0.02}, {"workers", 1.0},
		{"worker_timeout_ms", 8000.0}, {"max_queue", 8.0}, {"history_limit", 100.0}, {"history_interval_ms", 60000.0},
		{"history_retention_days", 7.0}, {"history_memory_max_bytes", float64(16 * 1024 * 1024)},
		{"independent_cache_limit", 64.0}, {"independent_cache_ttl_ms", 60000.0},
		{"research_enabled", false}, {"maturity_extrapolation", "none"}, {"max_maturity_extrapolation_days", 30.0},
		{"forward_interpolation", "unavailable"}, {"proportional_calendar_assumption", false},
		{"sensitivity_rate_bump", 0.0025},
		{"quote", objectOf(DefaultQuotePolicy)}, {"iv", objectOf(DefaultIvConfig)},
		{"forward", objectOf(DefaultForwardConfig)}, {"smile", objectOf(DefaultSmileConfig)},
	} {
		raw.Set(kv.k, kv.v)
	}
	curve := jsjson.NewObjectValue()
	curve.Set("source", "unconfigured discount curve")
	curve.Set("as_of", ISOString(nowMs))
	curve.Set("version", "unconfigured-v1")
	curve.Set("convention", "continuous_zero_act365f")
	curve.Set("nodes", []any{})
	curve.Set("flat_rate", nil)
	curve.Set("allow_flat_fallback", false)
	raw.Set("curve", curve)
	raw.Set("expiry_policy", nil)
	raw.Set("carry", jsjson.NewObjectValue())
	if text, ok := env("FAIR_VALUE_CONFIG_JSON"); ok && jsTrim(text) != "" {
		base, err := DecodeConfig(raw)
		if err != nil {
			return Config{}, err
		}
		patch, err := jsjson.Parse([]byte(text))
		if err != nil {
			return Config{}, err
		}
		return MergeConfig(base, patch)
	}
	return DecodeConfig(raw)
}

var nestedSettings = map[string]bool{"quote": true, "iv": true, "forward": true, "smile": true, "curve": true}

// MergeConfig is config.ts mergeConfig: full validation for persisted and HTTP
// configuration, failing closed on unknown settings. patch is a JSON value as
// JSON.parse produced it.
func MergeConfig(current Config, patch any) (cfg Config, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = AsError(r)
		}
	}()
	entries, ok := patch.(*jsjson.Object)
	if !ok {
		throw("Configuration must be an object.")
	}
	for _, key := range entries.Keys() {
		if !current.Raw.Has(key) {
			throw("Unknown Fair Value setting: " + key + ".")
		}
	}
	next := current.Raw.Clone()
	for _, key := range entries.Keys() {
		value, _ := entries.Get(key)
		if nestedSettings[key] {
			patchObj, ok := value.(*jsjson.Object)
			if !ok {
				throw("Invalid " + key + " configuration.")
			}
			prevValue, _ := current.Raw.Get(key)
			previous := prevValue.(*jsjson.Object)
			for _, sub := range patchObj.Keys() {
				if !previous.Has(sub) {
					throw("Unknown " + key + "." + sub + " setting.")
				}
			}
			merged := previous.Clone() // {...previous, ...value}: previous keys keep their order
			for _, sub := range patchObj.Keys() {
				v, _ := patchObj.Get(sub)
				merged.Set(sub, jsjson.CloneValue(v))
			}
			next.Set(key, merged)
		} else {
			next.Set(key, jsjson.CloneValue(value))
		}
	}
	validateConfigObject(next)
	normalizeTimestamps(next)
	return decodeValidated(next), nil
}

// DecodeConfig validates a configuration object (validateConfig) and decodes it. Unlike
// MergeConfig it does not normalise timestamps, exactly like the FairValueEngine
// constructor, which validates the configuration it is given as is.
func DecodeConfig(raw *jsjson.Object) (cfg Config, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = AsError(r)
		}
	}()
	validateConfigObject(raw)
	return decodeValidated(raw), nil
}

// ValidateConfig is config.ts validateConfig on a configuration object.
func ValidateConfig(raw *jsjson.Object) error {
	return Catch(func() { validateConfigObject(raw) })
}

func rangeCheck(name string, value any, low, high float64, integer bool) {
	f, ok := value.(float64)
	if !ok || !isFinite(f) || f < low || f > high || (integer && !isSafeInteger(f)) {
		prefix := ""
		if integer {
			prefix = "integer "
		}
		throw(name + " requires " + prefix + jsjson.FormatNumber(low) + ".." + jsjson.FormatNumber(high) + ".")
	}
}

func oneOf(v any, options ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, o := range options {
		if s == o {
			return true
		}
	}
	return false
}

func validateConfigObject(c *jsjson.Object) {
	get := func(key string) any { return getProp(c, key) }
	for _, key := range []string{"enabled", "research_enabled", "proportional_calendar_assumption"} {
		if typeOf(get(key)) != "boolean" {
			throw(key + " must be boolean.")
		}
	}
	rangeCheck("refresh_ms", get("refresh_ms"), 2000, 300000, true)
	rangeCheck("surface_max_age_ms", get("surface_max_age_ms"), 5000, 600000, true)
	rangeCheck("max_underlyings", get("max_underlyings"), 1, 5, true)
	rangeCheck("max_tokens", get("max_tokens"), 20, 1000, true)
	rangeCheck("max_expiries", get("max_expiries"), 1, 12, true)
	rangeCheck("universe_refresh_ms", get("universe_refresh_ms"), 15000, 300000, true)
	rangeCheck("recenter_log_distance", get("recenter_log_distance"), .001, .20, false)
	rangeCheck("workers", get("workers"), 1, 2, true)
	rangeCheck("worker_timeout_ms", get("worker_timeout_ms"), 100, 30000, true)
	rangeCheck("max_queue", get("max_queue"), 1, 16, true)
	rangeCheck("history_limit", get("history_limit"), 1, 500, true)
	rangeCheck("history_interval_ms", get("history_interval_ms"), 10000, 3600000, true)
	rangeCheck("history_retention_days", get("history_retention_days"), 1, 30, true)
	rangeCheck("history_memory_max_bytes", get("history_memory_max_bytes"), 1048576, 67108864, true)
	rangeCheck("independent_cache_limit", get("independent_cache_limit"), 1, 128, true)
	rangeCheck("independent_cache_ttl_ms", get("independent_cache_ttl_ms"), 1000, 600000, true)
	rangeCheck("max_maturity_extrapolation_days", get("max_maturity_extrapolation_days"), 0, 90, false)
	rangeCheck("sensitivity_rate_bump", get("sensitivity_rate_bump"), 0, 0.05, false)
	if !oneOf(get("maturity_extrapolation"), "none", "constant_short_end_and_forward_variance") {
		throw("Unknown maturity extrapolation policy.")
	}
	if !oneOf(get("forward_interpolation"), "unavailable", "log_carry_assumption") {
		throw("Unknown forward interpolation policy.")
	}
	q := get("quote")
	rangeCheck("quote.max_age_ms", getProp(q, "max_age_ms"), 500, 300000, false)
	rangeCheck("quote.max_relative_spread", getProp(q, "max_relative_spread"), .001, 2, false)
	rangeCheck("quote.max_absolute_spread", getProp(q, "max_absolute_spread"), .01, 10000, false)
	for _, key := range []string{"min_depth", "depth_target"} {
		rangeCheck("quote."+key, getProp(q, key), 1, 1e8, false)
	}
	for _, key := range []string{"premium_floor", "tick_floor"} {
		rangeCheck("quote."+key, getProp(q, key), 1e-8, 1000, false)
	}
	rangeCheck("quote.freshness_tau_ms", getProp(q, "freshness_tau_ms"), 1, 300000, false)
	for _, key := range []string{"max_pair_dispersion_ms", "max_snapshot_dispersion_ms", "future_timestamp_tolerance_ms"} {
		rangeCheck("quote."+key, getProp(q, key), 0, 300000, false)
	}
	if !oneOf(getProp(q, "zero_bid_policy"), "exclude", "diagnostic_only") {
		throw("Unknown zero bid policy.")
	}
	f := get("forward")
	rangeCheck("forward.min_pairs", getProp(f, "min_pairs"), 2, 50, true)
	rangeCheck("forward.huber_delta", getProp(f, "huber_delta"), .1, 10, false)
	if typeOf(getProp(f, "refine")) != "boolean" {
		throw("forward.refine must be boolean.")
	}
	rangeCheck("forward.refinement_iterations", getProp(f, "refinement_iterations"), 1, 100, true)
	rangeCheck("forward.outlier_scale", getProp(f, "outlier_scale"), 1, 20, false)
	rangeCheck("forward.max_pair_dispersion_ms", getProp(f, "max_pair_dispersion_ms"), 0, 300000, false)
	rangeCheck("forward.tick_floor", getProp(f, "tick_floor"), 1e-8, 1000, false)
	rangeCheck("forward.max_relative_dispersion", getProp(f, "max_relative_dispersion"), 1e-8, .1, false)
	iv := get("iv")
	rangeCheck("iv.initial_high", getProp(iv, "initial_high"), .01, 10, false)
	rangeCheck("iv.max_volatility", getProp(iv, "max_volatility"), .1, 10, false)
	rangeCheck("iv.max_expansions", getProp(iv, "max_expansions"), 0, 16, true)
	rangeCheck("iv.max_iterations", getProp(iv, "max_iterations"), 10, 300, true)
	for _, key := range []string{"price_tolerance", "volatility_tolerance", "low_vega_threshold"} {
		rangeCheck("iv."+key, getProp(iv, key), 1e-14, .1, false)
	}
	rangeCheck("iv.tick_tolerance_fraction", getProp(iv, "tick_tolerance_fraction"), 0, .5, false)
	rangeCheck("iv.max_iv_uncertainty", getProp(iv, "max_iv_uncertainty"), .001, 1, false)
	s := get("smile")
	if model := getProp(s, "model"); !strictEqual(model, "svi") && !strictEqual(model, "interpolation") {
		throw("Unknown smile model.")
	}
	rangeCheck("smile.min_svi_strikes", getProp(s, "min_svi_strikes"), 7, 100, true)
	rangeCheck("smile.min_interpolation_strikes", getProp(s, "min_interpolation_strikes"), 3, 100, true)
	rangeCheck("smile.min_each_wing", getProp(s, "min_each_wing"), 2, 20, true)
	for _, key := range []string{"min_k_span", "max_interpolation_gap"} {
		rangeCheck("smile."+key, getProp(s, key), .001, 2, false)
	}
	rangeCheck("smile.atm_band", getProp(s, "atm_band"), 0, .05, false)
	rangeCheck("smile.huber_delta", getProp(s, "huber_delta"), .1, 10, false)
	rangeCheck("smile.regularization", getProp(s, "regularization"), 0, 10, false)
	rangeCheck("smile.max_normalized_rmse", getProp(s, "max_normalized_rmse"), .1, 20, false)
	rangeCheck("smile.optimizer_iterations", getProp(s, "optimizer_iterations"), 20, 2000, true)
	rangeCheck("smile.optimizer_starts", getProp(s, "optimizer_starts"), 2, 8, true)
	rangeCheck("smile.optimizer_tolerance", getProp(s, "optimizer_tolerance"), 1e-12, .01, false)
	rangeCheck("smile.butterfly_tolerance", getProp(s, "butterfly_tolerance"), 0, 1e-4, false)
	rangeCheck("smile.variance_floor", getProp(s, "variance_floor"), 1e-14, 1e-4, false)
	rangeCheck("smile.max_wing_slope", getProp(s, "max_wing_slope"), .01, 1.99999, false)
	rangeCheck("smile.diagnostic_points", getProp(s, "diagnostic_points"), 51, 501, true)
	rangeCheck("smile.adaptive_depth", getProp(s, "adaptive_depth"), 1, 6, true)
	rangeCheck("smile.strike_extrapolation_k", getProp(s, "strike_extrapolation_k"), 0, .5, false)
	rangeCheck("smile.calendar_tolerance", getProp(s, "calendar_tolerance"), 0, 1e-5, false)
	rangeCheck("smile.price_tolerance_ticks", getProp(s, "price_tolerance_ticks"), 0, .5, false)
	curve := get("curve")
	validateCurveValue(curve)
	if typeOf(getProp(curve, "allow_flat_fallback")) != "boolean" {
		throw("curve.allow_flat_fallback must be boolean.")
	}
	validateExpiryPolicyValue(get("expiry_policy"))
	carryMap := get("carry")
	if !truthy(carryMap) || typeOf(carryMap) != "object" || isArray(carryMap) || len(objectKeys(carryMap)) > 100 {
		throw("Invalid carry map.")
	}
	for _, e := range objectEntries(carryMap) {
		underlying, carry := e.key, e.value
		if underlying == "" || !truthy(carry) || !truthy(trimCall(getProp(carry, "source"), "carry.source?.trim")) ||
			!truthy(trimCall(getProp(carry, "version"), "carry.version?.trim")) || !utcOK(getProp(carry, "as_of")) ||
			typeOf(getProp(carry, "verified")) != "boolean" || typeOf(getProp(carry, "proportional")) != "boolean" ||
			!truthy(trimCall(getProp(carry, "convention"), "carry.convention?.trim")) ||
			!isArray(getProp(carry, "dividends")) || lengthGreater(getProp(carry, "dividends"), 100) ||
			!isArray(getProp(carry, "corporate_actions")) || lengthGreater(getProp(carry, "corporate_actions"), 100) {
			throw("Invalid verified carry for " + underlying + ".")
		}
		yield := getProp(carry, "dividend_yield")
		if yield != nil {
			rangeCheck("dividend_yield", yield, -.5, 2, false)
		}
		dividends := getProp(carry, "dividends").([]any)
		if len(dividends) > 0 && yield != nil && !strictEqual(yield, 0.0) {
			throw("Choose continuous proportional dividends or known discrete dividends; their combined carry model is unsupported.")
		}
		for _, event := range dividends {
			if !utcOK(getProp(event, "timestamp")) {
				throw("Dividend requires exact UTC/offset timestamp.")
			}
			rangeCheck("dividend amount", getProp(event, "amount"), 0, 1e8, false)
		}
		for _, action := range getProp(carry, "corporate_actions").([]any) {
			if !utcOK(action) {
				throw("Corporate action requires exact timestamp.")
			}
		}
	}
}

func utcOK(v any) bool { _, ok := utcTimestampAny(v); return ok }

// expNeg is Math.exp(-zeroRate * t).
func expNeg(zeroRate, t float64) float64 { return jsmath.Exp(float64(-zeroRate * t)) }

// validateCurveValue is curve.ts validateCurve applied to an untyped curve object.
func validateCurveValue(spec any) {
	if !strictEqual(getProp(spec, "convention"), "continuous_zero_act365f") ||
		!truthy(trimCall(getProp(spec, "source"), "spec.source?.trim")) ||
		!truthy(trimCall(getProp(spec, "version"), "spec.version?.trim")) || !utcOK(getProp(spec, "as_of")) {
		throw("Curve requires source, UTC timestamp, convention and version.")
	}
	nodes := getProp(spec, "nodes")
	if lengthGreater(nodes, 100) {
		throw("Discount curve exceeds 100 nodes.")
	}
	previous := -1.0
	for _, node := range iterate(nodes, "spec.nodes") {
		t, tok := finiteNumber(getProp(node, "t"))
		zr, zok := finiteNumber(getProp(node, "zero_rate"))
		if !tok || t < 0 || t <= previous || !zok {
			throw("Curve nodes require increasing nonnegative T, finite continuous zero rates and positive finite D.")
		}
		if d := expNeg(zr, t); !isFinite(d) || d <= 0 {
			throw("Curve nodes require increasing nonnegative T, finite continuous zero rates and positive finite D.")
		}
		previous = t
	}
	if flat := getProp(spec, "flat_rate"); flat != nil {
		if _, ok := finiteNumber(flat); !ok {
			throw("Flat rate must be a finite decimal.")
		}
	}
}

// validateExpiryPolicyValue is metadata.ts validateExpiryPolicy on an untyped value.
func validateExpiryPolicyValue(policy any) {
	if policy == nil {
		return
	}
	if !strictEqual(getProp(policy, "exchange"), "NFO") || !strictEqual(getProp(policy, "timezone"), "Asia/Kolkata") ||
		!validLocalTime(jsToString(getProp(policy, "local_time"))) ||
		!truthy(trimCall(getProp(policy, "source"), "policy.source?.trim")) ||
		!truthy(trimCall(getProp(policy, "version"), "policy.version?.trim")) || !utcOK(getProp(policy, "as_of")) ||
		!truthy(trimCall(getProp(policy, "convention"), "policy.convention?.trim")) ||
		len(objectKeys(getProp(policy, "overrides"))) > 1000 {
		throw("Expiry policy requires NFO, Asia/Kolkata, HH:mm:ss, verified source/time/version and bounded overrides.")
	}
	for _, e := range objectEntries(getProp(policy, "overrides")) {
		if e.key == "" || !utcOK(e.value) {
			throw("Invalid exact instrument expiry override.")
		}
	}
}

// normalizeTimestamps is config.ts normalizeTimestamps (after validation).
func normalizeTimestamps(c *jsjson.Object) {
	norm := func(v any) string { s, _ := utcTimestampAny(v); return s }
	curve := getProp(c, "curve").(*jsjson.Object)
	curve.Set("as_of", norm(getProp(curve, "as_of")))
	if policy, ok := getProp(c, "expiry_policy").(*jsjson.Object); ok {
		policy.Set("as_of", norm(getProp(policy, "as_of")))
		switch o := getProp(policy, "overrides").(type) {
		case *jsjson.Object:
			for _, k := range o.Keys() {
				v, _ := o.Get(k)
				o.Set(k, norm(v))
			}
		case []any:
			for i := range o {
				o[i] = norm(o[i])
			}
		}
	}
	for _, e := range objectEntries(getProp(c, "carry")) {
		carry := e.value.(*jsjson.Object)
		carry.Set("as_of", norm(getProp(carry, "as_of")))
		for _, event := range getProp(carry, "dividends").([]any) {
			ev := event.(*jsjson.Object)
			ev.Set("timestamp", norm(getProp(ev, "timestamp")))
		}
		actions := getProp(carry, "corporate_actions").([]any)
		mapped := make([]any, len(actions))
		for i, a := range actions {
			mapped[i] = norm(a)
		}
		carry.Set("corporate_actions", mapped)
	}
}

// decodeValidated reads the typed configuration out of a validated raw object.
func decodeValidated(raw *jsjson.Object) Config {
	num := func(o any, key string) float64 { f, _ := getProp(o, key).(float64); return f }
	boolean := func(o any, key string) bool { b, _ := getProp(o, key).(bool); return b }
	str := func(o any, key string) string { s, _ := getProp(o, key).(string); return s }
	c := Config{Raw: raw}
	c.Enabled = boolean(raw, "enabled")
	c.RefreshMs = num(raw, "refresh_ms")
	c.SurfaceMaxAgeMs = num(raw, "surface_max_age_ms")
	c.MaxUnderlyings = num(raw, "max_underlyings")
	c.MaxTokens = num(raw, "max_tokens")
	c.MaxExpiries = num(raw, "max_expiries")
	c.UniverseRefreshMs = num(raw, "universe_refresh_ms")
	c.RecenterLogDistance = num(raw, "recenter_log_distance")
	c.Workers = num(raw, "workers")
	c.WorkerTimeoutMs = num(raw, "worker_timeout_ms")
	c.MaxQueue = num(raw, "max_queue")
	c.HistoryLimit = num(raw, "history_limit")
	c.HistoryIntervalMs = num(raw, "history_interval_ms")
	c.HistoryRetentionDays = num(raw, "history_retention_days")
	c.HistoryMemoryMaxBytes = num(raw, "history_memory_max_bytes")
	c.IndependentCacheLimit = num(raw, "independent_cache_limit")
	c.IndependentCacheTtlMs = num(raw, "independent_cache_ttl_ms")
	c.ResearchEnabled = boolean(raw, "research_enabled")
	c.MaturityExtrapolation = str(raw, "maturity_extrapolation")
	c.MaxMaturityExtrapolationDays = num(raw, "max_maturity_extrapolation_days")
	c.ForwardInterpolation = str(raw, "forward_interpolation")
	c.ProportionalCalendarAssumption = boolean(raw, "proportional_calendar_assumption")
	c.SensitivityRateBump = num(raw, "sensitivity_rate_bump")
	q := getProp(raw, "quote")
	c.Quote = QuotePolicy{
		MaxAgeMs: num(q, "max_age_ms"), MaxRelativeSpread: num(q, "max_relative_spread"), MaxAbsoluteSpread: num(q, "max_absolute_spread"),
		MinDepth: num(q, "min_depth"), PremiumFloor: num(q, "premium_floor"), TickFloor: num(q, "tick_floor"), DepthTarget: num(q, "depth_target"),
		FreshnessTauMs: num(q, "freshness_tau_ms"), MaxPairDispersionMs: num(q, "max_pair_dispersion_ms"),
		MaxSnapshotDispersionMs: num(q, "max_snapshot_dispersion_ms"), FutureTimestampToleranceMs: num(q, "future_timestamp_tolerance_ms"),
		ZeroBidPolicy: str(q, "zero_bid_policy"),
	}
	iv := getProp(raw, "iv")
	c.Iv = IvConfig{
		InitialHigh: num(iv, "initial_high"), MaxVolatility: num(iv, "max_volatility"), MaxExpansions: num(iv, "max_expansions"),
		MaxIterations: num(iv, "max_iterations"), PriceTolerance: num(iv, "price_tolerance"), TickToleranceFraction: num(iv, "tick_tolerance_fraction"),
		VolatilityTolerance: num(iv, "volatility_tolerance"), LowVegaThreshold: num(iv, "low_vega_threshold"), MaxIvUncertainty: num(iv, "max_iv_uncertainty"),
	}
	f := getProp(raw, "forward")
	c.Forward = ForwardConfig{
		MinPairs: num(f, "min_pairs"), HuberDelta: num(f, "huber_delta"), Refine: boolean(f, "refine"),
		RefinementIterations: num(f, "refinement_iterations"), OutlierScale: num(f, "outlier_scale"),
		MaxPairDispersionMs: num(f, "max_pair_dispersion_ms"), TickFloor: num(f, "tick_floor"), MaxRelativeDispersion: num(f, "max_relative_dispersion"),
	}
	s := getProp(raw, "smile")
	c.Smile = SmileConfig{
		Model: str(s, "model"), MinSviStrikes: num(s, "min_svi_strikes"), MinKSpan: num(s, "min_k_span"), MinEachWing: num(s, "min_each_wing"),
		AtmBand: num(s, "atm_band"), MinInterpolationStrike: num(s, "min_interpolation_strikes"), MaxInterpolationGap: num(s, "max_interpolation_gap"),
		HuberDelta: num(s, "huber_delta"), Regularization: num(s, "regularization"), MaxNormalizedRmse: num(s, "max_normalized_rmse"),
		OptimizerIterations: num(s, "optimizer_iterations"), OptimizerStarts: num(s, "optimizer_starts"), OptimizerTolerance: num(s, "optimizer_tolerance"),
		ButterflyTolerance: num(s, "butterfly_tolerance"), VarianceFloor: num(s, "variance_floor"), MaxWingSlope: num(s, "max_wing_slope"),
		DiagnosticPoints: num(s, "diagnostic_points"), AdaptiveDepth: num(s, "adaptive_depth"), StrikeExtrapolationK: num(s, "strike_extrapolation_k"),
		CalendarTolerance: num(s, "calendar_tolerance"), PriceToleranceTicks: num(s, "price_tolerance_ticks"),
	}
	c.Curve = decodeCurve(getProp(raw, "curve"))
	if p, ok := getProp(raw, "expiry_policy").(*jsjson.Object); ok {
		c.ExpiryPolicy = decodeExpiryPolicy(p)
	}
	c.Carry = map[string]*CarrySpec{}
	for _, e := range objectEntries(getProp(raw, "carry")) {
		c.Carry[e.key] = decodeCarry(e.value)
	}
	return c
}

func decodeCurve(v any) DiscountCurveSpec {
	str := func(key string) string { s, _ := getProp(v, key).(string); return s }
	spec := DiscountCurveSpec{SourceStamp: SourceStamp{Source: str("source"), AsOf: str("as_of"), Version: str("version"), Convention: str("convention")}}
	spec.Raw, _ = v.(*jsjson.Object)
	spec.Nodes = []CurveNode{}
	if nodes, ok := getProp(v, "nodes").([]any); ok {
		for _, n := range nodes {
			t, _ := getProp(n, "t").(float64)
			zr, _ := getProp(n, "zero_rate").(float64)
			raw, _ := n.(*jsjson.Object)
			spec.Nodes = append(spec.Nodes, CurveNode{T: t, ZeroRate: zr, Raw: raw})
		}
	}
	if flat, ok := getProp(v, "flat_rate").(float64); ok {
		spec.FlatRate = &flat
	}
	spec.AllowFlatFallback, _ = getProp(v, "allow_flat_fallback").(bool)
	return spec
}

func decodeExpiryPolicy(p *jsjson.Object) *ExpiryPolicy {
	str := func(key string) string { s, _ := getProp(p, key).(string); return s }
	policy := &ExpiryPolicy{
		SourceStamp: SourceStamp{Source: str("source"), AsOf: str("as_of"), Version: str("version"), Convention: str("convention")},
		Exchange:    str("exchange"), Timezone: str("timezone"), LocalTime: jsToString(getProp(p, "local_time")),
		Overrides: map[string]string{}, Raw: p,
	}
	overrides := getProp(p, "overrides")
	if _, ok := overrides.(string); !ok { // a (validated, hence empty) string has no usable entries
		for _, e := range objectEntries(overrides) {
			if s, ok := e.value.(string); ok {
				policy.Overrides[e.key] = s
			}
		}
	}
	return policy
}

func decodeCarry(v any) *CarrySpec {
	str := func(key string) string { s, _ := getProp(v, key).(string); return s }
	spec := &CarrySpec{SourceStamp: SourceStamp{Source: str("source"), AsOf: str("as_of"), Version: str("version"), Convention: str("convention")}}
	spec.Raw, _ = v.(*jsjson.Object)
	spec.Verified, _ = getProp(v, "verified").(bool)
	spec.Proportional, _ = getProp(v, "proportional").(bool)
	if y, ok := getProp(v, "dividend_yield").(float64); ok {
		spec.DividendYield = &y
	}
	spec.Dividends = []Dividend{}
	if list, ok := getProp(v, "dividends").([]any); ok {
		for _, e := range list {
			ts, _ := getProp(e, "timestamp").(string)
			amount, _ := getProp(e, "amount").(float64)
			spec.Dividends = append(spec.Dividends, Dividend{Timestamp: ts, Amount: amount})
		}
	}
	spec.CorporateActions = []string{}
	if list, ok := getProp(v, "corporate_actions").([]any); ok {
		for _, a := range list {
			s, _ := a.(string)
			spec.CorporateActions = append(spec.CorporateActions, s)
		}
	}
	return spec
}
