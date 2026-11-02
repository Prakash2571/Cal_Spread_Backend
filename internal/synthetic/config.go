// Package synthetic is the futures-vs-synthetic-futures arbitrage scanner and PAPER
// trader (src/synthetic/*). It watches each underlying's nearest future with the
// same-expiry option pair at ATM, ATM±1, ATM±2 or ATM±3, prices a conversion and a
// reversal at every strike from the executable touch and, while RUN is on, opens a
// one-lot PAPER position whenever an opportunity is ELIGIBLE. Nothing here can send a
// real order.
//
// The arithmetic follows the TypeScript operation for operation (same rounding, same
// order of floating-point operations, same sort tie-breaks) and is checked against
// outputs recorded from the original code (testdata/gen_math.mjs, math_golden.json).
package synthetic

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

// ClampStrikeLevel is clampSynthStrikeLevel: Number(v) must be exactly 1, 2 or 3.
// v is a decoded JSON value (or a float64); ok is false otherwise.
func ClampStrikeLevel(v any) (level int, ok bool) {
	n := jsNumber(v)
	if n == 1 || n == 2 || n == 3 {
		return int(n), true
	}
	return 0, false
}

// Config is SynthConfig. Times are milliseconds. JSON names are the TypeScript field
// names (used by the parity fixtures only; the API exposes ConfigView).
type Config struct {
	StrikeLevel               int            `json:"strikeLevel"`
	QuoteMaxAgeMs             float64        `json:"quoteMaxAgeMs"`
	FeedMaxAgeMs              float64        `json:"feedMaxAgeMs"`
	AtmHysteresis             float64        `json:"atmHysteresis"`
	WindowMinIntervalMs       float64        `json:"windowMinIntervalMs"`
	EvalIntervalMs            float64        `json:"evalIntervalMs"`
	PublishIntervalMs         float64        `json:"publishIntervalMs"`
	UniverseRefreshMs         float64        `json:"universeRefreshMs"`
	MaxTokens                 float64        `json:"maxTokens"`
	ShareBoxBudget            bool           `json:"shareBoxBudget"`
	LaneTokenLimit            float64        `json:"laneTokenLimit"`
	MaxUnderlyings            float64        `json:"maxUnderlyings"`
	MaxPublishedOpportunities float64        `json:"maxPublishedOpportunities"`
	MinExpectedNetProfit      float64        `json:"minExpectedNetProfit"`
	SafetyBuffer              float64        `json:"safetyBuffer"`
	ExpectedSlippage          float64        `json:"expectedSlippage"`
	IncludeCarry              bool           `json:"includeCarry"`
	DefaultRfPct              float64        `json:"defaultRfPct"`
	EnableConversion          bool           `json:"enableConversion"`
	EnableReversal            bool           `json:"enableReversal"`
	SkipExpiryDay             bool           `json:"skipExpiryDay"`
	PaperTrading              bool           `json:"paperTrading"`
	MaxOpenPositions          float64        `json:"maxOpenPositions"`
	SignalConfirmations       float64        `json:"signalConfirmations"`
	ReentryCooldownMs         float64        `json:"reentryCooldownMs"`
	ConvergenceFloor          float64        `json:"convergenceFloor"`
	ConvergencePct            float64        `json:"convergencePct"`
	MinExitNetPnl             float64        `json:"minExitNetPnl"`
	ProfitCapturePct          float64        `json:"profitCapturePct"`
	MinCapturedPct            float64        `json:"minCapturedPct"`
	ExpirySafetyMinutes       float64        `json:"expirySafetyMinutes"`
	OptionRates               ratecard.Rates `json:"optionRates"`
	FuturesRates              ratecard.Rates `json:"futuresRates"`
}

// LoadFuturesChargeRates is loadFuturesChargeRates: Box's brokerage/SEBI/GST and STT
// rounding, with futures STT, exchange charge, IPFT and stamp duty, each overridable.
func LoadFuturesChargeRates(get config.Getter, base ratecard.Rates) ratecard.Rates {
	r := base
	r.SttSellPct = config.Num(get, "SYNTH_FUT_STT_SELL_PCT", 0.05)
	r.ExchangeTxnPct = config.Num(get, "SYNTH_FUT_EXCHANGE_TXN_PCT", 0.00173)
	r.IpftPerCrore = config.Num(get, "SYNTH_FUT_IPFT_PER_CRORE", 10)
	r.IpftPct = 0
	r.StampDutyBuyPct = config.Num(get, "SYNTH_FUT_STAMP_DUTY_BUY_PCT", 0.002)
	r.RateVersion = config.Str(get, "SYNTH_FUT_CHARGE_RATE_VERSION", "nse-futures-2026-04-01")
	return r
}

// LoadConfig is loadSynthConfig: every SYNTH_* value with the Node defaults and clamps.
func LoadConfig(get config.Getter) Config {
	num := func(key string, def float64) float64 { return config.Num(get, key, def) }
	flag := func(key string, def bool) bool { return config.Bool(get, key, def) }
	level, ok := ClampStrikeLevel(num("SYNTH_STRIKE_LEVEL", 3))
	if !ok {
		level = 3
	}
	optionRates := ratecard.Load(get)
	return Config{
		StrikeLevel:               level,
		QuoteMaxAgeMs:             num("SYNTH_QUOTE_MAX_AGE_MS", 15_000),
		FeedMaxAgeMs:              num("SYNTH_FEED_MAX_AGE_MS", 10_000),
		AtmHysteresis:             num("SYNTH_ATM_HYSTERESIS", 0.15),
		WindowMinIntervalMs:       num("SYNTH_WINDOW_MIN_INTERVAL_MS", 15_000),
		EvalIntervalMs:            math.Max(100, num("SYNTH_EVAL_INTERVAL_MS", 500)),
		PublishIntervalMs:         math.Max(200, num("SYNTH_PUBLISH_INTERVAL_MS", 1000)),
		UniverseRefreshMs:         math.Max(60_000, num("SYNTH_UNIVERSE_REFRESH_MS", 15*60_000)),
		MaxTokens:                 num("SYNTH_MAX_TOKENS", 750),
		ShareBoxBudget:            flag("SYNTH_SHARE_BOX_BUDGET", true),
		LaneTokenLimit:            num("SYNTH_LANE_TOKEN_LIMIT", 3000),
		MaxUnderlyings:            num("SYNTH_MAX_UNDERLYINGS", 0),
		MaxPublishedOpportunities: math.Max(10, num("SYNTH_MAX_PUBLISHED_OPPORTUNITIES", 150)),
		MinExpectedNetProfit:      num("SYNTH_MIN_EXPECTED_NET_PROFIT", 500),
		SafetyBuffer:              num("SYNTH_SAFETY_BUFFER", 100),
		ExpectedSlippage:          num("SYNTH_EXPECTED_SLIPPAGE", 0),
		IncludeCarry:              flag("SYNTH_INCLUDE_CARRY", true),
		DefaultRfPct:              num("SYNTH_DEFAULT_RF_PCT", 0),
		EnableConversion:          flag("SYNTH_ENABLE_CONVERSION", true),
		EnableReversal:            flag("SYNTH_ENABLE_REVERSAL", true),
		SkipExpiryDay:             flag("SYNTH_SKIP_EXPIRY_DAY", false),
		PaperTrading:              flag("SYNTH_PAPER_TRADING", true),
		MaxOpenPositions:          math.Floor(num("SYNTH_MAX_OPEN_POSITIONS", 0)),
		SignalConfirmations:       math.Max(1, math.Floor(num("SYNTH_SIGNAL_CONFIRMATIONS", 2))),
		ReentryCooldownMs:         num("SYNTH_REENTRY_COOLDOWN_MS", 60_000),
		ConvergenceFloor:          num("SYNTH_CONVERGENCE_FLOOR", 100),
		ConvergencePct:            num("SYNTH_CONVERGENCE_PCT", 0.2),
		MinExitNetPnl:             num("SYNTH_MIN_EXIT_NET_PNL", 250),
		ProfitCapturePct:          num("SYNTH_PROFIT_CAPTURE_PCT", 0.75),
		MinCapturedPct:            num("SYNTH_MIN_CAPTURED_PCT", 0.75),
		ExpirySafetyMinutes:       num("SYNTH_EXPIRY_SAFETY_MINUTES", 45),
		OptionRates:               optionRates,
		FuturesRates:              LoadFuturesChargeRates(get, optionRates),
	}
}

/* ----------------------------- runtime settings ---------------------------- */

// Setting keys, in SYNTH_SETTING_KEYS order. Saved in synth_settings.
const (
	SettingMinExpectedNetProfit = "min_expected_net_profit"
	SettingSafetyBuffer         = "safety_buffer"
	SettingMaxOpenPositions     = "max_open_positions"
)

// SettingKeys is SYNTH_SETTING_KEYS.
var SettingKeys = []string{SettingMinExpectedNetProfit, SettingSafetyBuffer, SettingMaxOpenPositions}

// Limit is one entry of SYNTH_TUNING_LIMITS.
type Limit struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// TuningLimits is SYNTH_TUNING_LIMITS (field order = JSON key order).
type TuningLimits struct {
	MinExpectedNetProfit Limit `json:"min_expected_net_profit"`
	SafetyBuffer         Limit `json:"safety_buffer"`
	MaxOpenPositions     Limit `json:"max_open_positions"`
}

// Limits holds the bounds for the settings an admin may change from the UI.
var Limits = TuningLimits{
	MinExpectedNetProfit: Limit{Min: 0, Max: 100_000},
	SafetyBuffer:         Limit{Min: 0, Max: 50_000},
	MaxOpenPositions:     Limit{Min: 0, Max: 10_000},
}

func limitFor(key string) Limit {
	switch key {
	case SettingMinExpectedNetProfit:
		return Limits.MinExpectedNetProfit
	case SettingSafetyBuffer:
		return Limits.SafetyBuffer
	}
	return Limits.MaxOpenPositions
}

// Settings is SynthSettings: every runtime setting by its API/storage name.
type Settings struct {
	MinExpectedNetProfit float64
	SafetyBuffer         float64
	MaxOpenPositions     float64
}

func (s Settings) get(key string) float64 {
	switch key {
	case SettingMinExpectedNetProfit:
		return s.MinExpectedNetProfit
	case SettingSafetyBuffer:
		return s.SafetyBuffer
	}
	return s.MaxOpenPositions
}

func (s *Settings) set(key string, v float64) {
	switch key {
	case SettingMinExpectedNetProfit:
		s.MinExpectedNetProfit = v
	case SettingSafetyBuffer:
		s.SafetyBuffer = v
	default:
		s.MaxOpenPositions = v
	}
}

// ParseSetting is parseSynthSetting: a valid value for key, or the reason raw is not
// one. raw is a decoded JSON value: a non-blank string is converted with Number(),
// anything else must already be a number.
func ParseSetting(key string, raw any) (float64, string) {
	v := raw
	if s, ok := raw.(string); ok && jsTrim(s) != "" {
		v = jsNumberFromString(s)
	}
	lim := limitFor(key)
	n, isNum := v.(float64)
	if !isNum || math.IsNaN(n) || math.IsInf(n, 0) || n < lim.Min || n > lim.Max {
		if key == SettingMaxOpenPositions {
			return 0, "max_open_positions must be a whole number from " + jsNumberString(lim.Min) +
				" to " + jsNumberString(lim.Max) + " (0 = no limit)"
		}
		return 0, key + " must be a number from " + jsNumberString(lim.Min) + " to " + jsNumberString(lim.Max)
	}
	if key == SettingMaxOpenPositions && n != math.Trunc(n) {
		return 0, "max_open_positions must be a whole number (0 = no limit)"
	}
	return n + 0, "" // +0 folds -0 into 0, which JSON.stringify prints anyway
}
