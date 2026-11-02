package model

import (
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// The reference file is written by ../testdata/gen_model.mjs from the original
// TypeScript (Node 22). Bit patterns are compared exactly; structured results are
// compared as exact JSON.stringify bytes with every duration_ms set to 0.

var (
	goldenOnce sync.Once
	golden     *jsjson.Object
	goldenErr  error
)

func loadGolden(t *testing.T) *jsjson.Object {
	t.Helper()
	goldenOnce.Do(func() {
		raw, err := os.ReadFile("../testdata/model_golden.json")
		if err != nil {
			goldenErr = err
			return
		}
		v, err := jsjson.Parse(raw)
		if err != nil {
			goldenErr = err
			return
		}
		golden = v.(*jsjson.Object)
	})
	if goldenErr != nil {
		t.Fatalf("golden: %v", goldenErr)
	}
	return golden
}

func section(t *testing.T, name string) []any {
	t.Helper()
	v, ok := loadGolden(t).Get(name)
	if !ok {
		t.Fatalf("golden has no %s", name)
	}
	return v.([]any)
}

func hexF(t testing.TB, v any) float64 {
	t.Helper()
	s, ok := v.(string)
	if !ok {
		t.Fatalf("expected hex string, got %#v", v)
	}
	u, err := strconv.ParseUint(s, 16, 64)
	if err != nil {
		t.Fatalf("bad hex %q", s)
	}
	return math.Float64frombits(u)
}

func hexOf(x float64) string { return fmt.Sprintf("%016x", math.Float64bits(x)) }

func isHex16(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

func get(v any, key string) any { return getProp(v, key) }

func str(v any, key string) string { s, _ := getProp(v, key).(string); return s }

func num(v any, key string) float64 { f, _ := getProp(v, key).(float64); return f }

// zeroDurations sets every duration_ms to 0, like the generator's replacer.
func zeroDurations(v any) {
	switch x := v.(type) {
	case *jsjson.Object:
		for _, k := range x.Keys() {
			if k == "duration_ms" {
				x.Set(k, 0.0)
				continue
			}
			c, _ := x.Get(k)
			zeroDurations(c)
		}
	case []any:
		for _, e := range x {
			zeroDurations(e)
		}
	}
}

// js renders v as the generator wrote it.
func js(t testing.TB, v any) string {
	t.Helper()
	raw := jsjson.Marshal(v)
	parsed, err := jsjson.Parse(raw)
	if err != nil {
		t.Fatalf("re-parse own JSON: %v\n%s", err, raw)
	}
	zeroDurations(parsed)
	return string(jsjson.Marshal(parsed))
}

// run calls fn and returns its JSON or its thrown message, as the generator's attempt().
func run(t testing.TB, fn func() any) (out string, errMsg string, failed bool) {
	t.Helper()
	var result any
	if err := Catch(func() { result = fn() }); err != nil {
		return "", err.Error(), true
	}
	return js(t, result), "", false
}

// expect compares a case's recorded out/error with the Go result.
func expect(t *testing.T, label string, c any, fn func() any) {
	t.Helper()
	got, gotErr, failed := run(t, fn)
	if want, ok := getProp(c, "error").(string); ok {
		if !failed || gotErr != want {
			t.Errorf("%s: want error %q, got %q (error %v)", label, want, truncate(got), gotErr)
		}
		return
	}
	want, _ := getProp(c, "out").(string)
	if failed {
		t.Errorf("%s: unexpected error %q (want %s)", label, gotErr, truncate(want))
		return
	}
	if got != want {
		t.Errorf("%s: JSON differs at byte %d\n got  %s\n want %s", label, firstDiff(got, want), around(got, firstDiff(got, want)), around(want, firstDiff(got, want)))
	}
}

func truncate(s string) string {
	if len(s) > 300 {
		return s[:300] + "..."
	}
	return s
}

func firstDiff(a, b string) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) < len(b) {
		return len(a)
	}
	return len(b)
}

func around(s string, i int) string {
	lo, hi := i-160, i+160
	if lo < 0 {
		lo = 0
	}
	if hi > len(s) {
		hi = len(s)
	}
	return s[lo:hi]
}

func bitsOrError(fn func() float64) string {
	var x float64
	if err := Catch(func() { x = fn() }); err != nil {
		return "E:" + err.Error()
	}
	if math.IsNaN(x) {
		return "7ff8000000000000" // V8's canonical NaN; payloads are not observable in JavaScript
	}
	return hexOf(x)
}

func TestGoldenNormal(t *testing.T) {
	for _, r := range section(t, "normal") {
		row := r.([]any)
		x := hexF(t, row[0])
		for i, f := range []func(float64) float64{Erf, Erfc, NormalCdf, NormalPdf} {
			got, want := f(x), hexF(t, row[i+1])
			// NaN payloads are not observable in JavaScript; any NaN matches.
			if math.Float64bits(got) != math.Float64bits(want) && !(math.IsNaN(got) && math.IsNaN(want)) {
				t.Fatalf("normal fn %d at %v (%s): got %s want %s", i, x, row[0], hexOf(got), row[i+1])
			}
		}
	}
}

func TestGoldenBlack(t *testing.T) {
	for _, r := range section(t, "black") {
		row := r.([]any)
		in := BlackInput{F: hexF(t, row[0]), K: hexF(t, row[1]), D: hexF(t, row[2]), W: hexF(t, row[3]), Side: row[4].(string)}
		if got := bitsOrError(func() float64 { return BlackPrice(in) }); got != row[5].(string) {
			t.Fatalf("blackPrice(%+v) = %s, want %s", in, got, row[5])
		}
	}
	for _, r := range section(t, "blackFromIv") {
		row := r.([]any)
		f, k, tt, d, iv := hexF(t, row[0]), hexF(t, row[1]), hexF(t, row[2]), hexF(t, row[3]), hexF(t, row[4])
		if got := bitsOrError(func() float64 { return BlackFromIv(f, k, tt, d, iv, row[5].(string)) }); got != row[6].(string) {
			t.Fatalf("blackFromIv %v: %s want %s", row, got, row[6])
		}
	}
	for i, c := range section(t, "greeks") {
		a := get(c, "args").([]any)
		var spot *float64
		if a[6] != nil {
			spot = P(hexF(t, a[6]))
		}
		args := GreeksArgs{BlackInput: BlackInput{F: hexF(t, a[0]), K: hexF(t, a[1]), D: hexF(t, a[2]), W: hexF(t, a[3]), Side: a[4].(string)},
			T: hexF(t, a[5]), Spot: spot, ProportionalCarry: a[7].(bool)}
		expect(t, fmt.Sprintf("greeks[%d]", i), c, func() any { return FrozenBlackGreeks(args) })
	}
	for i, c := range section(t, "settlement") {
		a := get(c, "args")
		nullable := func(key string) *float64 {
			if f, ok := get(a, key).(float64); ok {
				return &f
			}
			return nil
		}
		args := SettlementPayoffArgs{Strike: num(a, "strike"), Side: str(a, "side"), Lot: num(a, "lot"), Settlement: nullable("settlement"),
			Indicative: nullable("indicative"), SettlementUnderlying: str(a, "settlementUnderlying")}
		expect(t, fmt.Sprintf("settlement[%d]", i), c, func() any { return SettlementPayoff(args) })
	}
	for _, c := range section(t, "yearFraction") {
		a := get(c, "args").([]any)
		e, v := a[0].(string), a[1].(string)
		var got string
		switch {
		case isHex16(e) && isHex16(v):
			got = bitsOrError(func() float64 { return YearFraction(hexF(t, e), hexF(t, v)) })
		case isHex16(e):
			got = bitsOrError(func() float64 { return YearFraction(hexF(t, e), v) })
		case isHex16(v):
			got = bitsOrError(func() float64 { return YearFraction(e, hexF(t, v)) })
		default:
			got = bitsOrError(func() float64 { return YearFraction(e, v) })
		}
		if want := str(c, "bits"); got != want {
			t.Errorf("yearFraction(%q, %q) = %s, want %s", e, v, got, want)
		}
	}
}

func ivConfigOf(v any) IvConfig {
	return IvConfig{InitialHigh: num(v, "initial_high"), MaxVolatility: num(v, "max_volatility"), MaxExpansions: num(v, "max_expansions"),
		MaxIterations: num(v, "max_iterations"), PriceTolerance: num(v, "price_tolerance"), TickToleranceFraction: num(v, "tick_tolerance_fraction"),
		VolatilityTolerance: num(v, "volatility_tolerance"), LowVegaThreshold: num(v, "low_vega_threshold"), MaxIvUncertainty: num(v, "max_iv_uncertainty")}
}

func smileConfigOf(v any) SmileConfig {
	return SmileConfig{Model: str(v, "model"), MinSviStrikes: num(v, "min_svi_strikes"), MinKSpan: num(v, "min_k_span"), MinEachWing: num(v, "min_each_wing"),
		AtmBand: num(v, "atm_band"), MinInterpolationStrike: num(v, "min_interpolation_strikes"), MaxInterpolationGap: num(v, "max_interpolation_gap"),
		HuberDelta: num(v, "huber_delta"), Regularization: num(v, "regularization"), MaxNormalizedRmse: num(v, "max_normalized_rmse"),
		OptimizerIterations: num(v, "optimizer_iterations"), OptimizerStarts: num(v, "optimizer_starts"), OptimizerTolerance: num(v, "optimizer_tolerance"),
		ButterflyTolerance: num(v, "butterfly_tolerance"), VarianceFloor: num(v, "variance_floor"), MaxWingSlope: num(v, "max_wing_slope"),
		DiagnosticPoints: num(v, "diagnostic_points"), AdaptiveDepth: num(v, "adaptive_depth"), StrikeExtrapolationK: num(v, "strike_extrapolation_k"),
		CalendarTolerance: num(v, "calendar_tolerance"), PriceToleranceTicks: num(v, "price_tolerance_ticks")}
}

func forwardConfigOf(v any) ForwardConfig {
	return ForwardConfig{MinPairs: num(v, "min_pairs"), HuberDelta: num(v, "huber_delta"), Refine: get(v, "refine") == true,
		RefinementIterations: num(v, "refinement_iterations"), OutlierScale: num(v, "outlier_scale"),
		MaxPairDispersionMs: num(v, "max_pair_dispersion_ms"), TickFloor: num(v, "tick_floor"), MaxRelativeDispersion: num(v, "max_relative_dispersion")}
}

func quotePolicyOf(v any) QuotePolicy {
	return QuotePolicy{MaxAgeMs: num(v, "max_age_ms"), MaxRelativeSpread: num(v, "max_relative_spread"), MaxAbsoluteSpread: num(v, "max_absolute_spread"),
		MinDepth: num(v, "min_depth"), PremiumFloor: num(v, "premium_floor"), TickFloor: num(v, "tick_floor"), DepthTarget: num(v, "depth_target"),
		FreshnessTauMs: num(v, "freshness_tau_ms"), MaxPairDispersionMs: num(v, "max_pair_dispersion_ms"),
		MaxSnapshotDispersionMs: num(v, "max_snapshot_dispersion_ms"), FutureTimestampToleranceMs: num(v, "future_timestamp_tolerance_ms"),
		ZeroBidPolicy: str(v, "zero_bid_policy")}
}

func TestGoldenIv(t *testing.T) {
	for i, c := range section(t, "iv") {
		a := get(c, "args")
		args := IvArgs{F: hexF(t, get(a, "f")), K: hexF(t, get(a, "k")), T: hexF(t, get(a, "t")), D: hexF(t, get(a, "d")),
			Price: hexF(t, get(a, "price")), Side: str(a, "side"), Tick: hexF(t, get(a, "tick"))}
		if u := get(a, "uncertainty"); !isUndefined(u) {
			args.Uncertainty = P(hexF(t, u))
		}
		if cfg := get(a, "config"); !isUndefined(cfg) {
			c := ivConfigOf(cfg)
			args.Config = &c
		}
		expect(t, fmt.Sprintf("iv[%d]", i), c, func() any { return InvertIv(args) })
	}
}

func sviParamsOf(v any) SviParameters {
	return SviParameters{A: num(v, "a"), B: num(v, "b"), Rho: num(v, "rho"), M: num(v, "m"), Eta: num(v, "eta")}
}

func TestGoldenSvi(t *testing.T) {
	for i, r := range section(t, "sviPoints") {
		row := r.([]any)
		p, k := sviParamsOf(row[0]), hexF(t, row[1])
		d := SviDerivatives(p, k)
		g := any(nil)
		if d.G != nil {
			g = hexOf(*d.G)
		}
		got := []any{hexOf(SviVariance(p, k)), hexOf(d.W), hexOf(d.First), hexOf(d.Second), g, BasicSviConstraints(p)}
		for j, want := range row[2:] {
			if got[j] != want {
				t.Fatalf("sviPoints[%d] field %d: got %v want %v (p=%+v k=%v)", i, j, got[j], want, p, k)
			}
		}
	}
	for i, c := range section(t, "sviDiagnose") {
		p := sviParamsOf(get(c, "p"))
		ks := []float64{}
		for _, k := range get(c, "observedK").([]any) {
			ks = append(ks, hexF(t, k))
		}
		cfg := smileConfigOf(get(c, "config"))
		expect(t, fmt.Sprintf("sviDiagnose[%d]", i), c, func() any {
			d := DiagnoseSvi(p, ks, cfg)
			return jsjson.RawObject(func(dst []byte) []byte {
				return jsjson.NewObject(dst).Field("valid", d.Valid).Field("diagnostics", d.Diagnostics).Field("butterfly", d.Butterfly).End()
			})
		})
	}
}

func floats(v any) []float64 {
	out := []float64{}
	for _, e := range v.([]any) {
		out = append(out, e.(float64))
	}
	return out
}

func TestGoldenOptimizer(t *testing.T) {
	objectives := map[string]func([]float64) float64{
		"rosenbrock": func(p []float64) float64 {
			a := 1 - p[0]
			b := p[1] - float64(p[0]*p[0])
			return float64(a*a) + float64(100*float64(b*b))
		},
		"shiftedSquares": func(p []float64) float64 {
			sum := 0.0
			for i, v := range p {
				d := v - float64(float64(i+1)*0.3)
				sum += float64(d * d)
			}
			return sum
		},
		"nanLeft": func(p []float64) float64 {
			if p[0] < 0 {
				return math.NaN()
			}
			a, b := p[0]-0.7, p[1]+0.2
			return float64(a*a) + float64(b*b)
		},
	}
	for i, c := range section(t, "optimizer") {
		bounds := [][2]float64{}
		for _, b := range get(c, "bounds").([]any) {
			pair := floats(b)
			bounds = append(bounds, [2]float64{pair[0], pair[1]})
		}
		args := NelderMeadArgs{Objective: objectives[str(c, "name")], Start: floats(get(c, "start")), Bounds: bounds,
			Steps: floats(get(c, "steps")), MaxIterations: num(c, "maxIterations"), Tolerance: num(c, "tolerance")}
		expect(t, fmt.Sprintf("optimizer[%d] %s", i, str(c, "name")), c, func() any {
			r := BoundedNelderMead(args)
			return jsjson.RawObject(func(dst []byte) []byte {
				return jsjson.NewObject(dst).Field("point", r.Point).Field("value", r.Value).Field("iterations", r.Iterations).Field("converged", r.Converged).End()
			})
		})
	}
}

func TestGoldenQuotes(t *testing.T) {
	for i, c := range section(t, "cleanQuote") {
		md := DecodeOptionMetadata(get(c, "metadata"))
		var q *MarketQuote
		if qv := get(c, "quote"); qv != nil {
			mq := DecodeMarketQuote(qv)
			q = &mq
		}
		now, policy := hexF(t, get(c, "now")), quotePolicyOf(get(c, "policy"))
		expect(t, fmt.Sprintf("cleanQuote[%d]", i), c, func() any {
			clean, rejection := CleanQuoteFor(md, q, now, policy)
			return jsjson.RawObject(func(dst []byte) []byte {
				if clean != nil {
					return jsjson.NewObject(dst).Field("ok", true).Field("quote", clean).End()
				}
				return jsjson.NewObject(dst).Field("ok", false).Field("rejection", rejection).End()
			})
		})
	}
	for i, c := range section(t, "coherent") {
		quotes := []CleanQuote{}
		for _, q := range get(c, "quotes").([]any) {
			quotes = append(quotes, DecodeCleanQuote(q))
		}
		expect(t, fmt.Sprintf("coherent[%d]", i), c, func() any {
			r := CoherentSnapshot(quotes, DefaultQuotePolicy)
			return jsjson.RawObject(func(dst []byte) []byte {
				return jsjson.NewObject(dst).Field("eligible", r.Eligible).Field("excluded", r.Excluded).Field("dispersion_ms", r.DispersionMs).End()
			})
		})
	}
}

func cleanQuotes(v any) []CleanQuote {
	out := []CleanQuote{}
	for _, q := range v.([]any) {
		out = append(out, DecodeCleanQuote(q))
	}
	return out
}

func metadataList(v any) []OptionMetadata {
	out := []OptionMetadata{}
	for _, m := range v.([]any) {
		out = append(out, DecodeOptionMetadata(m))
	}
	return out
}

func TestGoldenForward(t *testing.T) {
	for i, c := range section(t, "weightedMedian") {
		values := []WeightedValue{}
		for _, pair := range get(c, "values").([]any) {
			p := pair.([]any)
			values = append(values, WeightedValue{Value: hexF(t, p[0]), Weight: hexF(t, p[1])})
		}
		if got, want := bitsOrError(func() float64 { return WeightedMedian(values) }), str(c, "bits"); got != want {
			t.Errorf("weightedMedian[%d]: %s want %s", i, got, want)
		}
	}
	for _, r := range section(t, "huber") {
		row := r.([]any)
		if got := hexOf(Huber(hexF(t, row[0]), hexF(t, row[1]))); got != row[2].(string) {
			t.Fatalf("huber %v: %s", row, got)
		}
	}
	for _, c := range section(t, "forward") {
		args := ForwardArgs{Metadata: metadataList(get(c, "metadata")), Quotes: cleanQuotes(get(c, "quotes")), D: hexF(t, get(c, "d"))}
		if cfg := get(c, "config"); cfg != nil {
			fc := forwardConfigOf(cfg)
			args.Config = &fc
		}
		if ex := get(c, "excludeStrike"); ex != nil {
			args.ExcludeStrike = P(ex.(float64))
		}
		expect(t, "forward "+str(c, "name"), c, func() any { return EstimateOptionsForward(args) })
	}
	for _, c := range section(t, "resolve") {
		ch, a := get(c, "chain"), get(c, "args")
		options := ForwardArgs{Metadata: metadataList(get(ch, "metadata")), Quotes: cleanQuotes(get(ch, "quotes")), D: hexF(t, get(ch, "d"))}
		curve := decodeCurve(get(a, "curve"))
		futures := []ForwardFuture{}
		for _, f := range get(a, "futures").([]any) {
			futures = append(futures, ForwardFuture{ExpiryTimestamp: str(f, "expiry_timestamp"), Quote: DecodeCleanQuote(get(f, "quote"))})
		}
		var carry *CarrySpec
		if cv := get(a, "carry"); cv != nil {
			carry = decodeCarry(cv)
		}
		args := ResolveArgs{Expiry: str(a, "expiry"), Now: hexF(t, get(a, "now")), Curve: &curve, Futures: futures,
			Spot: decodeSpot(get(a, "spot")), Carry: carry, MaxAgeMs: num(a, "maxAgeMs")}
		expect(t, "resolve "+str(c, "name"), c, func() any {
			args.Options = EstimateOptionsForward(options)
			return ResolveForward(args)
		})
	}
}

func TestGoldenValidation(t *testing.T) {
	for i, c := range section(t, "priceGrid") {
		strikes := []float64{}
		for _, s := range get(c, "strikes").([]any) {
			strikes = append(strikes, hexF(t, s))
		}
		args := PriceGridArgs{F: hexF(t, get(c, "f")), D: hexF(t, get(c, "d")), Strikes: strikes, Tick: hexF(t, get(c, "tick")),
			Config: smileConfigOf(get(c, "config"))}
		switch str(c, "kind") {
		case "roundedMap":
			values := map[float64]float64{}
			for _, e := range get(c, "map").([]any) {
				pair := e.([]any)
				values[pair[0].(float64)] = hexF(t, pair[1])
			}
			args.Variance = func(k float64) *float64 {
				if w, ok := values[jsx.Round(100*jsmath.Exp(k))]; ok {
					return P(w)
				}
				return nil
			}
		case "svi":
			p := sviParamsOf(get(c, "p"))
			if len(strikes) == 0 || args.D == 0 {
				args.Variance = func(float64) *float64 { return P(.04) }
			} else {
				args.Variance = func(k float64) *float64 { return P(SviVariance(p, k)) }
			}
		}
		expect(t, fmt.Sprintf("priceGrid[%d]", i), c, func() any {
			r := ValidatePriceGrid(args)
			prices := make([]any, len(r.Prices))
			for j, p := range r.Prices {
				pr := p
				prices[j] = jsjson.RawObject(func(dst []byte) []byte {
					return jsjson.NewObject(dst).Field("strike", pr.Strike).Field("call", pr.Call).Field("put", pr.Put).End()
				})
			}
			return jsjson.RawObject(func(dst []byte) []byte {
				return jsjson.NewObject(dst).Field("valid", r.Valid).Field("diagnostics", r.Diagnostics).Field("prices", prices).End()
			})
		})
	}
	for i, c := range section(t, "intermediate") {
		got := IntermediateStrikes(floats(get(c, "strikes")), num(c, "sub"))
		want := get(c, "out").([]any)
		if len(got) != len(want) {
			t.Fatalf("intermediate[%d]: %d values, want %d", i, len(got), len(want))
		}
		for j := range got {
			if hexOf(got[j]) != want[j].(string) {
				t.Fatalf("intermediate[%d][%d]: %s want %s", i, j, hexOf(got[j]), want[j])
			}
		}
	}
}

func observationsOf(v any) []CalibrationObservation {
	out := []CalibrationObservation{}
	for _, o := range v.([]any) {
		out = append(out, CalibrationObservation{Strike: num(o, "strike"), K: num(o, "k"), W: num(o, "w"), Iv: num(o, "iv"),
			Side: str(o, "side"), Token: num(o, "token"), Quote: DecodeCleanQuote(get(o, "quote")), DependenceFactor: num(o, "dependence_factor")})
	}
	return out
}

func TestGoldenSmile(t *testing.T) {
	for _, c := range section(t, "smile") {
		obs := observationsOf(get(c, "observations"))
		f, d, cfg := hexF(t, get(c, "f")), hexF(t, get(c, "d")), smileConfigOf(get(c, "config"))
		fn := map[string]func([]CalibrationObservation, float64, float64, SmileConfig) SmileModel{
			"fitSvi": FitSvi, "fitSmile": FitSmile, "fitInterpolation": FitInterpolation}[str(c, "fn")]
		expect(t, "smile "+str(c, "name"), c, func() any { return fn(obs, f, d, cfg) })
	}
}

func TestGoldenSensitivity(t *testing.T) {
	for i, c := range section(t, "sensitivity") {
		a := get(c, "args")
		nullable := func(key string) *float64 {
			if f, ok := get(a, key).(float64); ok {
				return &f
			}
			return nil
		}
		args := SensitivityArgs{F: hexF(t, get(a, "f")), Strike: hexF(t, get(a, "strike")), T: hexF(t, get(a, "t")), D: hexF(t, get(a, "d")),
			Iv: hexF(t, get(a, "iv")), Side: str(a, "side"), ForwardDispersion: nullable("forwardDispersion"), RateBump: num(a, "rateBump"),
			QuoteIvBid: nullable("quoteIvBid"), QuoteIvAsk: nullable("quoteIvAsk")}
		if alt := get(a, "alternativePrice"); !isUndefined(alt) {
			args.Alternative = &AlternativePrice{Iv: num(alt, "iv"), Forward: num(alt, "forward"), Label: str(alt, "label")}
		}
		expect(t, fmt.Sprintf("sensitivity[%d]", i), c, func() any { return ModelSensitivity(args) })
	}
}

func TestGoldenMetadataAndCurve(t *testing.T) {
	for _, r := range section(t, "utc") {
		row := r.([]any)
		ts, ok := utcTimestampAny(row[0])
		var got any
		if ok {
			got = ts
		}
		if got != row[1] {
			t.Errorf("utcTimestamp(%#v) = %#v, want %#v", row[0], got, row[1])
		}
		if s, isStr := row[0].(string); isStr {
			if ValidDate(jsPrefix(s, 10)) != row[2].(bool) {
				t.Errorf("validDate(%q) differs", jsPrefix(s, 10))
			}
		}
	}
	for i, c := range section(t, "optionMetadata") {
		iv := get(c, "inst").(*jsjson.Object).Clone()
		strike, _ := iv.Get("strike")
		iv.Set("strike", hexF(t, strike))
		inst := DecodeInstrument(iv)
		var policy *ExpiryPolicy
		if p, ok := get(c, "policy").(*jsjson.Object); ok {
			policy = decodeExpiryPolicy(p)
		}
		expect(t, fmt.Sprintf("optionMetadata[%d]", i), c, func() any {
			r := ResolveOptionMetadata(inst, policy, "v1")
			return jsjson.RawObject(func(dst []byte) []byte {
				if r.OK {
					return jsjson.NewObject(dst).Field("ok", true).Field("metadata", r.Metadata).End()
				}
				return jsjson.NewObject(dst).Field("ok", false).Field("reasons", r.Reasons).End()
			})
		})
	}
	for i, c := range section(t, "discount") {
		spec := decodeCurve(get(c, "spec"))
		tt := hexF(t, get(c, "t"))
		expect(t, fmt.Sprintf("discount[%d]", i), c, func() any { return DiscountAt(&spec, tt) })
	}
}

func TestGoldenConfig(t *testing.T) {
	cfgSection, _ := loadGolden(t).Get("config")
	fixed := hexF(t, get(cfgSection, "fixedMs"))
	check := func(label string, c any, cfg Config, err error) {
		t.Helper()
		if want, ok := get(c, "error").(string); ok {
			if err == nil || err.Error() != want {
				t.Errorf("%s: want error %q, got %v", label, want, err)
			}
			return
		}
		if err != nil {
			t.Errorf("%s: unexpected error %v", label, err)
			return
		}
		if got := string(jsjson.Marshal(cfg)); got != str(c, "out") {
			t.Errorf("%s: config JSON differs at %d\n got  %s\n want %s", label, firstDiff(got, str(c, "out")),
				around(got, firstDiff(got, str(c, "out"))), around(str(c, "out"), firstDiff(got, str(c, "out"))))
		}
		if got := cfg.Version(); got != str(c, "version") {
			t.Errorf("%s: version %s, want %s", label, got, str(c, "version"))
		}
	}
	for i, c := range get(cfgSection, "env").([]any) {
		env := get(c, "env").(*jsjson.Object)
		lookup := func(key string) (string, bool) {
			v, ok := env.Get(key)
			s, _ := v.(string)
			return s, ok
		}
		cfg, err := DefaultConfig(lookup, fixed)
		check(fmt.Sprintf("env[%d] %s", i, jsjson.Marshal(env)), c, cfg, err)
	}
	base, err := DefaultConfig(nil, fixed)
	if err != nil {
		t.Fatal(err)
	}
	for i, c := range get(cfgSection, "merge").([]any) {
		cfg, err := MergeConfig(base, get(c, "patch"))
		check(fmt.Sprintf("merge[%d] %s", i, truncate(string(jsjson.Marshal(get(c, "patch"))))), c, cfg, err)
	}
}

func goldenInputs(t *testing.T) map[string]*InputSnapshot {
	t.Helper()
	inputs := map[string]*InputSnapshot{}
	for _, c := range section(t, "pipeline") {
		in, err := DecodeInputSnapshot(get(c, "input"))
		if err != nil {
			t.Fatalf("decode input %s: %v", str(c, "name"), err)
		}
		inputs[str(c, "name")] = &in
	}
	return inputs
}

func TestGoldenPipeline(t *testing.T) {
	inputs := goldenInputs(t)
	for _, c := range section(t, "pipeline") {
		input := inputs[str(c, "name")]
		if got := string(jsjson.Marshal(input)); got != string(jsjson.Marshal(get(c, "input"))) {
			t.Errorf("input %s does not round-trip at byte %d", str(c, "name"), firstDiff(got, string(jsjson.Marshal(get(c, "input")))))
		}
		expect(t, "pipeline "+str(c, "name"), c, func() any { return BuildSurface(input) })
	}
}

func TestGoldenCalculatorAndIndependent(t *testing.T) {
	inputs := goldenInputs(t)
	surfaces := map[string]*SurfaceSnapshot{}
	surface := func(name string) *SurfaceSnapshot {
		if s, ok := surfaces[name]; ok {
			return s
		}
		s := BuildSurface(inputs[name])
		surfaces[name] = &s
		return &s
	}
	scale := func(s *ExpirySlice) {
		for i := range s.Smile.Nodes {
			s.Smile.Nodes[i].W *= .1
		}
		if s.Smile.Parameters != nil {
			s.Smile.Parameters.A *= .1
			s.Smile.Parameters.B *= .1
		}
	}
	crossing := BuildSurface(inputs["calendar"])
	scale(&crossing.Slices[1])
	crossing.CalendarRegions = BuildCalendarRegions(crossing.Slices, inputs["calendar"])
	if c, _ := loadGolden(t).Get("crossing"); js(t, crossing.CalendarRegions) != str(c, "regions") {
		t.Errorf("crossing regions differ:\n got  %s\n want %s", truncate(js(t, crossing.CalendarRegions)), truncate(str(c, "regions")))
	}
	negative := BuildSurface(inputs["research"])
	scale(&negative.Slices[2])
	for _, c := range section(t, "calculate") {
		name := str(c, "name")
		in := inputs[str(c, "input")]
		s := surface(str(c, "input"))
		switch name {
		case "crossing":
			s = &crossing
		case "negativeForwardVariance":
			s = &negative
		}
		expect(t, "calculate "+name, c, func() any {
			req, err := ValidateCalculatorRequest(get(c, "request"))
			if err != nil {
				panic(err)
			}
			return Calculate(in, s, req)
		})
	}
	cal := surface("calendar")
	for _, r := range section(t, "totalVariance") {
		row := r.([]any)
		v := TotalVarianceBetween(&cal.Slices[0], &cal.Slices[1], hexF(t, row[0]), hexF(t, row[1]), &inputs["calendar"].Config, false)
		var got any
		if v != nil {
			got = hexOf(*v)
		}
		if got != row[2] {
			t.Errorf("totalVarianceBetween %v: %v", row, got)
		}
	}
	for _, c := range section(t, "independent") {
		in, err := DecodeInputSnapshot(get(c, "input"))
		if err != nil {
			t.Fatal(err)
		}
		expiry, strike := str(c, "expiry"), hexF(t, get(c, "strike"))
		expect(t, "independent "+str(c, "name"), c, func() any { return IndependentEstimateFor(&in, expiry, strike) })
	}
	for i, c := range section(t, "calculatorRequests") {
		expect(t, fmt.Sprintf("calculatorRequests[%d]", i), c, func() any {
			req, err := ValidateCalculatorRequest(get(c, "value"))
			if err != nil {
				panic(err)
			}
			return jsjson.RawObject(func(dst []byte) []byte {
				o := jsjson.NewObject(dst).Field("underlying", req.Underlying).Field("strike", req.Strike).
					Field("expiry_timestamp", req.ExpiryTimestamp).Field("side", req.Side).Field("research_mode", req.ResearchMode)
				if req.InputSnapshotID != nil {
					o.Field("input_snapshot_id", *req.InputSnapshotID)
				}
				return o.End()
			})
		})
	}
}
