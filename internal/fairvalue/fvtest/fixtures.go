// Package fvtest ports tests/fairValue/fixtures.mjs for the Go Fair Value tests (test
// support only). The builders produce the same numbers and the same JSON as the Node
// fixtures; TestFixturesMatchNode checks that against the recorded Node inputs.
package fvtest

import (
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

// Now is fixtures.mjs NOW.
var Now = model.DateParse("2026-10-01T06:00:00Z")

// Expiry is fixtures.mjs EXPIRY.
const Expiry = "2026-11-17T10:00:00Z"

func object(kv ...any) *jsjson.Object {
	o := jsjson.NewObjectValue()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// CurveObject is fixtures.mjs curve.
func CurveObject() *jsjson.Object {
	return object("source", "test deterministic curve", "as_of", "2026-10-01T06:00:00Z", "version", "fixture-v1",
		"convention", "continuous_zero_act365f", "nodes", []any{}, "flat_rate", 0.05, "allow_flat_fallback", true)
}

// Curve is the typed fixture curve.
func Curve() model.DiscountCurveSpec { return model.DecodeCurve(CurveObject()) }

// ExpiryPolicyObject is fixtures.mjs expiryPolicy.
func ExpiryPolicyObject() *jsjson.Object {
	return object("exchange", "NFO", "timezone", "Asia/Kolkata", "local_time", "15:30:00",
		"source", "verified test fixture, not production configuration", "as_of", "2026-10-01T00:00:00Z",
		"version", "fixture-v1", "convention", "last trading time on metadata expiry date", "overrides", jsjson.NewObjectValue())
}

// ExpiryPolicy is the typed fixture policy.
func ExpiryPolicy() *model.ExpiryPolicy { return model.DecodeExpiryPolicy(ExpiryPolicyObject()) }

// DefaultToken is metadata()'s default token: strike*2, +1 for a put.
func DefaultToken(strike float64, side string) float64 {
	if side == model.PE {
		return strike*2 + 1
	}
	return strike * 2
}

// Metadata is fixtures.mjs metadata(strike, side, token, expiry).
func Metadata(strike float64, side string, token float64, expiry string) model.OptionMetadata {
	return model.OptionMetadata{Token: token, Tradingsymbol: "TEST-" + jsjson.FormatNumber(strike) + "-" + side, Underlying: "TEST",
		Exchange: "NFO", Side: side, Strike: strike, Expiry: expiry[:10], ExpiryTimestamp: expiry, ExpirySource: "exact fixture metadata",
		Timezone: "Asia/Kolkata", Style: "european", SettlementUnderlying: "official_stock_settlement", LotSize: 50, TickSize: 0.01,
		MetadataVersion: "fixture-v1"}
}

// MetadataFor is metadata(strike, side) with the default token and expiry.
func MetadataFor(strike float64, side string) model.OptionMetadata {
	return Metadata(strike, side, DefaultToken(strike, side), Expiry)
}

// Quote is fixtures.mjs quote(token, mid).
func Quote(token, mid float64) model.MarketQuote {
	bid, ask := mid-0.05, mid+0.05
	exch := model.ISOString(Now - 100)
	return model.MarketQuote{Token: token, Bid: &bid, Ask: &ask, BidDepth: 1000, AskDepth: 1000, ExchangeTimestamp: &exch,
		ReceiveTimestamp: model.ISOString(Now - 50), Source: "websocket", Version: 1}
}

// Clean is fixtures.mjs clean(token, mid).
func Clean(token, mid float64) model.CleanQuote {
	return model.CleanQuote{MarketQuote: Quote(token, mid), Mid: mid, Spread: 0.1, RelativeSpread: 0.1 / math.Max(mid, 1), AgeMs: 100,
		FreshnessBasis: "exchange", QuoteTimestamp: model.ISOString(Now - 100), AvailableDepth: 1000, Weight: 1, H: 0.05,
		CalibrationEligible: true, Reasons: []string{}}
}

// ChainInput is fixtures.mjs chain(): parity-consistent metadata and clean quotes.
type ChainInput struct {
	Metadata []model.OptionMetadata
	Quotes   []model.CleanQuote
	D        float64
}

// Chain is chain(strikes, f, t, d, iv).
func Chain(strikes []float64, f, t, d, iv float64) ChainInput {
	out := ChainInput{D: d}
	for _, k := range strikes {
		for _, side := range []string{model.CE, model.PE} {
			inst := MetadataFor(k, side)
			out.Metadata = append(out.Metadata, inst)
			out.Quotes = append(out.Quotes, Clean(inst.Token, model.BlackFromIv(f, k, t, d, iv, side)))
		}
	}
	return out
}

// ChainDefault is chain(strikes) with f=100, t=.5, d=.98, iv=.2.
func ChainDefault(strikes ...float64) ChainInput { return Chain(strikes, 100, .5, .98, .2) }

// InputOptions are inputSnapshot()'s options. Nil fields take the fixture defaults.
type InputOptions struct {
	Strikes  []float64
	Expiries []string
	// IV gives the quoted IV of a strike at time t (default .3 everywhere).
	IV func(strike, t float64) float64
	// Patch edits the configuration object like `...configPatch` (keys are set in place).
	Patch func(config *jsjson.Object)
}

// DefaultStrikes is inputSnapshot()'s default strike list.
var DefaultStrikes = []float64{80, 85, 90, 95, 100, 105, 110, 115, 120}

// ConfigObject is the fixture configuration object (before the quote tweak is applied
// by InputSnapshot): defaults, enabled, fixture curve and policy, then the patch.
func configObject(patch func(*jsjson.Object)) *jsjson.Object {
	base, err := model.DefaultConfig(nil, 0)
	if err != nil {
		panic(err)
	}
	raw := base.Raw.Clone()
	raw.Set("enabled", true)
	raw.Set("curve", CurveObject())
	raw.Set("expiry_policy", ExpiryPolicyObject())
	if patch != nil {
		patch(raw)
	}
	qv, _ := raw.Get("quote")
	q := qv.(*jsjson.Object).Clone()
	q.Set("tick_floor", .001)
	q.Set("premium_floor", 1.0)
	q.Set("max_relative_spread", 1.0)
	raw.Set("quote", q)
	return raw
}

// SmileObject returns the default smile configuration object (for patches such as
// { ...config.smile, model: "interpolation" }).
func SmileObject() *jsjson.Object {
	v, _ := configObject(nil).Get("smile")
	return v.(*jsjson.Object).Clone()
}

// InputSnapshot is fixtures.mjs inputSnapshot(options).
func InputSnapshot(o InputOptions) *model.InputSnapshot {
	strikes, expiries := o.Strikes, o.Expiries
	if strikes == nil {
		strikes = DefaultStrikes
	}
	if expiries == nil {
		expiries = []string{Expiry}
	}
	cfg, err := model.DecodeConfig(configObject(o.Patch))
	if err != nil {
		panic(err)
	}
	in := &model.InputSnapshot{ID: "input-fixture-v1", Underlying: "TEST", Name: "Test underlying", Broker: "zerodha",
		BrokerGeneration: 1, FeedGeneration: 1, ValuationTime: model.ISOString(Now), MetadataVersion: "test-v1",
		Instruments: []model.Instrument{}, Quotes: []model.MarketQuote{}, Spot: &model.Spot{Value: 100, Timestamp: model.ISOString(Now)},
		Futures: []model.Future{}, Config: cfg, ConfigVersion: cfg.Version()}
	token := 10.0
	for _, expiry := range expiries {
		t := model.YearFraction(expiry, Now)
		f := 100 * jsmath.Exp(.05*t)
		d := jsmath.Exp(-.05 * t)
		for _, strike := range strikes {
			for _, side := range []string{model.CE, model.PE} {
				instToken := token
				token++
				raw := object("instrument_token", instToken, "exchange_token", token,
					"tradingsymbol", "TEST-"+expiry+"-"+jsjson.FormatNumber(strike)+"-"+side, "name", "TEST", "last_price", 0.0,
					"expiry", expiry[:10], "expiry_timestamp", expiry, "strike", strike, "tick_size", .001, "lot_size", 50.0,
					"instrument_type", side, "segment", "NFO-OPT", "exchange", "NFO")
				in.Instruments = append(in.Instruments, model.DecodeInstrument(raw))
				iv := .3
				if o.IV != nil {
					iv = o.IV(strike, t)
				}
				mid := model.BlackFromIv(f, strike, t, d, iv, side)
				q := Quote(instToken, mid)
				bid, ask := math.Max(.000001, mid-.001), mid+.001
				q.Bid, q.Ask = &bid, &ask
				in.Quotes = append(in.Quotes, q)
			}
		}
	}
	n := float64(len(in.Instruments))
	in.Universe = model.Universe{ListedContracts: n, CapturedContracts: n, OmittedExpiries: []string{}, Bounded: false}
	return in
}

// Set returns a Patch that sets key/value pairs in order.
func Set(kv ...any) func(*jsjson.Object) {
	return func(o *jsjson.Object) {
		for i := 0; i < len(kv); i += 2 {
			o.Set(kv[i].(string), kv[i+1])
		}
	}
}
