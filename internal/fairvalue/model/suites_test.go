package model_test

// Ports of tests/fairValue/{pricing,svi,market,maturity,independent}.test.mjs and the pure
// parts of pipeline.test.mjs and hardening.test.mjs. Assertions and tolerances are the
// Node ones; fixtures come from fvtest (checked against the Node inputs below).

import (
	"math"
	"os"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
	. "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

func near(t *testing.T, actual, expected, tolerance float64, label string) {
	t.Helper()
	if !(math.Abs(actual-expected) <= tolerance) {
		t.Errorf("%s: %v != %v (tolerance %v)", label, actual, expected, tolerance)
	}
}

// Some Node suites use assert.ok(abs(error) < tolerance), rather than the pricing
// suite's <= helper. Keep that strict comparison, including its rejection of NaN.
func nearStrict(t *testing.T, actual, expected, tolerance float64, label string) {
	t.Helper()
	if !(math.Abs(actual-expected) < tolerance) {
		t.Errorf("%s: %v != %v (strict tolerance %v)", label, actual, expected, tolerance)
	}
}

func throws(fn func()) bool { return Catch(fn) != nil }

func obj(kv ...any) *jsjson.Object {
	o := jsjson.NewObjectValue()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func f64(v float64) *float64 { return &v }

// ---- fixtures are the Node fixtures ----------------------------------------------------

func TestFixturesMatchNode(t *testing.T) {
	raw, err := os.ReadFile("../testdata/model_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	pipeline, _ := v.(*jsjson.Object).Get("pipeline")
	recorded := map[string]string{}
	for _, c := range pipeline.([]any) {
		name, _ := c.(*jsjson.Object).Get("name")
		input, _ := c.(*jsjson.Object).Get("input")
		recorded[name.(string)] = string(jsjson.Marshal(input))
	}
	expiries3 := []string{"2026-10-20T10:00:00Z", "2026-11-17T10:00:00Z", "2026-12-15T10:00:00Z"}
	skew := func(strike, _ float64) float64 {
		l := jsmath.Log(strike / 100)
		return .3 - .12*l + .25*(l*l)
	}
	interpSmile := fvtest.SmileObject()
	interpSmile.Set("model", "interpolation")
	cases := map[string]*InputSnapshot{
		"default":       fvtest.InputSnapshot(fvtest.InputOptions{}),
		"small":         fvtest.InputSnapshot(fvtest.InputOptions{Strikes: []float64{80, 90, 100, 110, 120}}),
		"interpolation": fvtest.InputSnapshot(fvtest.InputOptions{Patch: fvtest.Set("smile", interpSmile)}),
		"calendar": fvtest.InputSnapshot(fvtest.InputOptions{Expiries: expiries3,
			Patch: fvtest.Set("proportional_calendar_assumption", true, "forward_interpolation", "log_carry_assumption")}),
		"skew": fvtest.InputSnapshot(fvtest.InputOptions{Strikes: seq(60, 5, 17), IV: skew}),
	}
	for name, input := range cases {
		if got := string(jsjson.Marshal(input)); got != recorded[name] {
			t.Errorf("fixture %s differs from the Node input (len %d vs %d)", name, len(got), len(recorded[name]))
		}
	}
}

func seq(start, step float64, n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = start + float64(i)*step
	}
	return out
}

// ---- pricing.test.mjs ------------------------------------------------------------------

func TestPricingKnownBlackScholesAndNormalTails(t *testing.T) {
	near(t, BlackFromIv(100*jsmath.Exp(.05), 100, 1, jsmath.Exp(-.05), .2, CE), 10.450583572185565, 1e-10, "Hull call")
	near(t, BlackFromIv(100*jsmath.Exp(.05), 100, 1, jsmath.Exp(-.05), .2, PE), 5.573526022256971, 1e-10, "Hull put")
	near(t, NormalCdf(-8), 6.220960574271784e-16, 1e-29, "cdf(-8)")
	near(t, NormalCdf(0), .5, 1e-10, "cdf(0)")
	near(t, NormalPdf(0), 1/math.Sqrt(2*math.Pi), 1e-10, "pdf(0)")
}

func TestPricingParityBoundsNegativeRatesDeepMoneyness(t *testing.T) {
	for _, f := range []float64{0.5, 100, 25000} {
		for _, factor := range []float64{.0001, .3, .95, 1, 1.2, 10, 10000} {
			k := f * factor
			for _, w := range []float64{0, 1e-10, .001, .04, 1, 25} {
				d := 1.03
				c := BlackPrice(BlackInput{F: f, K: k, D: d, W: w, Side: CE})
				p := BlackPrice(BlackInput{F: f, K: k, D: d, W: w, Side: PE})
				near(t, c-p, d*(f-k), 1e-7*math.Max(1, math.Max(f, k)), "parity")
				for side, price := range map[string]float64{CE: c, PE: p} {
					b := PriceBounds(f, k, d, side)
					if !(price >= b.Lower-1e-8 && price <= b.Upper+1e-8) {
						t.Errorf("%s %v outside bounds %+v", side, price, b)
					}
				}
			}
		}
	}
}

func TestPricingZeroVarianceExactYearFractionSettlement(t *testing.T) {
	near(t, YearFraction("2027-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), 1, 1e-10, "one year")
	near(t, YearFraction(DateParse("2026-10-01T10:00:00Z")+1000, "2026-10-01T10:00:00Z"), 1000.0/YearMs, 1e-10, "one second")
	near(t, BlackPrice(BlackInput{F: 120, K: 100, D: .95, W: 0, Side: CE}), 19, 1e-10, "intrinsic")
	args := SettlementPayoffArgs{Strike: 100, Side: CE, Lot: 75, Indicative: f64(120), SettlementUnderlying: "official_index_close"}
	if r := SettlementPayoff(args); r.Status != "indicative_payoff" || *r.ValuePerLot != 1500 {
		t.Errorf("indicative %+v", r)
	}
	final := args
	final.Settlement = f64(118)
	if r := SettlementPayoff(final); *r.Value != 18 || r.Status != "final_settlement" {
		t.Errorf("final %+v", r)
	}
	none := args
	none.Indicative = nil
	if r := SettlementPayoff(none); r.Value != nil {
		t.Errorf("unknown %+v", r)
	}
}

func TestPricingIvRoundTrips(t *testing.T) {
	for _, side := range []string{CE, PE} {
		for _, k := range []float64{80, 100, 120} {
			for _, tt := range []float64{.05, .5, 2} {
				for _, iv := range []float64{.2, .5, 1} {
					price := BlackFromIv(100, k, tt, 1.01, iv, side)
					r := InvertIv(IvArgs{F: 100, K: k, T: tt, D: 1.01, Price: price, Side: side, Tick: 1e-8})
					if r.Status != "valid" && r.Status != "low_vega" {
						t.Fatalf("status %s: %+v", r.Status, r)
					}
					near(t, *r.Iv, iv, 2e-6, "iv round trip")
				}
			}
		}
	}
}

func TestPricingIvExplicitFailures(t *testing.T) {
	base := IvArgs{F: 100, K: 100, T: .5, D: .98, Price: 8, Side: CE, Tick: .01}
	with := func(edit func(*IvArgs)) string { a := base; edit(&a); return InvertIv(a).Status }
	for want, edit := range map[string]func(*IvArgs){
		"outside_bounds":     func(a *IvArgs) { a.Price = 100 },
		"no_finite_solution": func(a *IvArgs) { a.Price = 98 },
		"zero_volatility":    func(a *IvArgs) { a.Price = 0 },
		"expired":            func(a *IvArgs) { a.T = 0 },
		"invalid_input":      func(a *IvArgs) { a.F = math.Inf(1) },
		"bracket_failure":    func(a *IvArgs) { c := DefaultIvConfig; c.MaxVolatility = .01; a.Config = &c },
		"iteration_failure":  func(a *IvArgs) { c := DefaultIvConfig; c.MaxIterations = 1; a.Config = &c },
	} {
		if got := with(edit); got != want {
			t.Errorf("want %s, got %s", want, got)
		}
	}
	price := BlackFromIv(100, 150, .01, .99, 1, CE)
	if got := with(func(a *IvArgs) { a.K, a.T, a.D, a.Price, a.Tick, a.Uncertainty = 150, .01, .99, price, 1e-12, f64(1) }); got != "low_vega" {
		t.Errorf("low vega: %s", got)
	}
}

func TestPricingFrozenGreeksMatchCentralBumps(t *testing.T) {
	d := jsmath.Exp(-.03 * .6)
	args := GreeksArgs{BlackInput: BlackInput{F: 105, K: 100, D: d, W: .25 * .25 * .6, Side: CE}, T: .6, Spot: f64(100), ProportionalCarry: true}
	g := FrozenBlackGreeks(args)
	price := func(f float64) float64 { in := args.BlackInput; in.F = f; return BlackPrice(in) }
	p := price(105)
	h := .001
	near(t, g.ForwardDelta, (price(105+h)-price(105-h))/(2*h), 1e-8, "delta")
	near(t, *g.ForwardGamma, (price(105+h)-2*p+price(105-h))/(h*h), 1e-7, "gamma")
	near(t, g.Vega1Pct, (BlackFromIv(105, 100, .6, d, .25+h, CE)-BlackFromIv(105, 100, .6, d, .25-h, CE))/(2*h)/100, 1e-5, "vega")
	near(t, g.Rho1Pct, -.6*p/100, 1e-10, "rho")
	near(t, *g.SpotDelta, g.ForwardDelta*1.05, 1e-10, "spot delta")
	near(t, *g.SpotGamma, *g.ForwardGamma*(1.05*1.05), 1e-10, "spot gamma")
	dt := 1e-5
	before := BlackFromIv(105, 100, .6-dt, jsmath.Exp(-.03*(.6-dt)), .25, CE)
	after := BlackFromIv(105, 100, .6+dt, jsmath.Exp(-.03*(.6+dt)), .25, CE)
	near(t, *g.ThetaCalendarDay, (before-after)/(2*dt)/365, 1e-8, "theta")
}

func TestPricingInvalidInputsNeverPrice(t *testing.T) {
	base := BlackInput{F: 100, K: 100, D: 1, W: .04, Side: CE}
	for _, edit := range []func(*BlackInput){
		func(b *BlackInput) { b.K = 0 }, func(b *BlackInput) { b.F = -1 }, func(b *BlackInput) { b.D = 0 },
		func(b *BlackInput) { b.D = math.NaN() }, func(b *BlackInput) { b.W = -1 }, func(b *BlackInput) { b.Side = "american" },
	} {
		in := base
		edit(&in)
		if !throws(func() { BlackPrice(in) }) {
			t.Errorf("priced %+v", in)
		}
	}
	if !throws(func() { BlackFromIv(100, 100, 0, 1, .2, CE) }) {
		t.Error("priced an expired IV")
	}
}

// ---- svi.test.mjs ----------------------------------------------------------------------

func TestSviDerivativesMatchFiniteDifferences(t *testing.T) {
	p := SviParameters{A: .012, B: .09, Rho: -.4, M: .015, Eta: .15}
	h := 1e-4
	for _, k := range []float64{-1, -.25, 0, .2, 1} {
		d := SviDerivatives(p, k)
		first := (SviVariance(p, k+h) - SviVariance(p, k-h)) / (2 * h)
		second := (SviVariance(p, k+h) - 2*d.W + SviVariance(p, k-h)) / (h * h)
		if !(math.Abs(d.First-first) < 1e-8) || !(math.Abs(d.Second-second) < 1e-7) {
			t.Errorf("k=%v: derivatives %v %v vs %v %v", k, d.First, d.Second, first, second)
		}
		lead := 1 - k*first/(2*d.W)
		g := lead*lead - first*first/4*(1/d.W+1.0/4) + second/2
		if !(math.Abs(*d.G-g) < 1e-7) {
			t.Errorf("k=%v: g %v vs %v", k, *d.G, g)
		}
	}
}

func TestSviVogtCounterexampleFailsButterfly(t *testing.T) {
	vogt := SviParameters{A: -.0410, B: .1331, M: .3586, Rho: .3060, Eta: .4153}
	if !BasicSviConstraints(vogt) {
		t.Fatal("basic constraints should hold")
	}
	d := DiagnoseSvi(vogt, []float64{-.5, 0, .5}, DefaultSmileConfig)
	if d.Valid || !(*d.Butterfly.MinG < 0) || d.Butterfly.GlobalProof || !(d.Butterfly.CheckedPoints > DefaultSmileConfig.DiagnosticPoints) {
		t.Errorf("diagnosis %+v", d.Butterfly)
	}
}

func sviObservations(p SviParameters, count int) []CalibrationObservation {
	out := []CalibrationObservation{}
	for i := 0; i < count; i++ {
		k := -.3 + float64(i)*.6/float64(count-1)
		strike, w := 100*jsmath.Exp(k), SviVariance(p, k)
		side := CE
		if k < 0 {
			side = PE
		}
		mid := BlackPrice(BlackInput{F: 100, K: strike, D: .98, W: w, Side: side})
		out = append(out, CalibrationObservation{Strike: strike, K: k, W: w, Iv: math.Sqrt(w / .5), Side: side, Token: float64(i + 1),
			Quote: fvtest.Clean(float64(i+1), mid), DependenceFactor: 1})
	}
	return out
}

func TestSviFitsKnownSmileReproducibly(t *testing.T) {
	obs := sviObservations(SviParameters{A: .01, B: .06, Rho: -.4, M: .01, Eta: .15}, 19)
	first := FitSvi(obs, 100, .98, DefaultSmileConfig)
	second := FitSvi(obs, 100, .98, DefaultSmileConfig)
	if !first.Valid || first.Method != "svi" || !(*first.Calibration.NormalizedRmse < .3) || *first.Parameters != *second.Parameters ||
		first.Calibration.OptimizerStarts < 2 || !(*first.Butterfly.MinG >= -DefaultSmileConfig.ButterflyTolerance) {
		t.Fatalf("fit %+v", first.Calibration)
	}
	if VarianceAt(&first, .35, DefaultSmileConfig, false) != nil {
		t.Error("variance outside support without research")
	}
	if w := VarianceAt(&first, .35, DefaultSmileConfig, true); w == nil || !(*w > 0) {
		t.Error("research extrapolation within distance should price")
	}
	if VarianceAt(&first, 1, DefaultSmileConfig, true) != nil {
		t.Error("extrapolation beyond the distance limit")
	}
}

func TestSviSparseDataIsInterpolationOrUnavailable(t *testing.T) {
	obs := sviObservations(SviParameters{A: .02, B: .02, Rho: -.1, M: 0, Eta: .2}, 5)
	fit := FitSmile(obs, 100, .98, DefaultSmileConfig)
	if fit.Method == "svi" || !strings.Contains(fit.Calibration.OptimizerStatus, "insufficient_support") {
		t.Errorf("sparse fit %s %s", fit.Method, fit.Calibration.OptimizerStatus)
	}
	if m := FitSmile(obs[:2], 100, .98, DefaultSmileConfig).Method; m != "unavailable" {
		t.Errorf("two observations: %s", m)
	}
}

func TestSviPriceValidationUsesActualSpacing(t *testing.T) {
	values := map[float64]float64{}
	for _, kp := range [][2]float64{{80, 25}, {100, 12}, {103, 9.6}} {
		iv := InvertIv(IvArgs{F: 100, K: kp[0], T: 1, D: 1, Price: kp[1], Side: CE, Tick: 1e-8})
		if iv.Status != "valid" {
			t.Fatalf("iv %+v", iv)
		}
		values[kp[0]] = *iv.Iv * *iv.Iv
	}
	r := ValidatePriceGrid(PriceGridArgs{F: 100, D: 1, Strikes: []float64{80, 100, 103}, Tick: .001, Config: DefaultSmileConfig,
		Variance: func(k float64) *float64 {
			if w, ok := values[jsx.Round(100*jsmath.Exp(k))]; ok {
				return &w
			}
			return nil
		}})
	convexity, slope := false, false
	for _, d := range r.Diagnostics {
		convexity = convexity || d.Code == "call_convexity_violation"
		slope = slope || strings.Contains(d.Code, "slope_violation")
	}
	if r.Valid || !convexity || slope {
		t.Errorf("validation %+v", r.Diagnostics)
	}
}

// ---- market.test.mjs -------------------------------------------------------------------

func curveWith(edit func(*jsjson.Object)) DiscountCurveSpec {
	o := fvtest.CurveObject()
	edit(o)
	return DecodeCurve(o)
}

func node(t, r float64) *jsjson.Object { return obj("t", t, "zero_rate", r) }

func TestMarketLogDiscountInterpolationAndCoverage(t *testing.T) {
	spec := curveWith(func(o *jsjson.Object) {
		o.Set("nodes", []any{node(.5, -.02), node(1, -.03)})
		o.Set("allow_flat_fallback", false)
	})
	d := DiscountAt(&spec, .75)
	if !(math.Abs(*d.D-jsmath.Exp(.02)) < 1e-14) || !(*d.D > 1) {
		t.Errorf("interpolated %v", *d.D)
	}
	curve := fvtest.Curve()
	if m := DiscountAt(&curve, 1).Method; m != "flat_rate_assumption" {
		t.Errorf("flat: %s", m)
	}
	if DiscountAt(&spec, 2).Available {
		t.Error("beyond coverage")
	}
	bad := curveWith(func(o *jsjson.Object) { o.Set("nodes", []any{node(1, .03), node(1, .05)}) })
	if !throws(func() { DiscountAt(&bad, .5) }) {
		t.Error("non-increasing nodes accepted")
	}
}

func TestMarketQuoteCleaning(t *testing.T) {
	inst := fvtest.MetadataFor(100, CE)
	base := fvtest.Quote(inst.Token, 5)
	clean := func(edit func(*MarketQuote)) (*CleanQuote, *QuoteRejection) {
		q := base
		if edit != nil {
			edit(&q)
		}
		return CleanQuoteFor(inst, &q, fvtest.Now, DefaultQuotePolicy)
	}
	if q, _ := clean(nil); q == nil {
		t.Fatal("base quote rejected")
	}
	iso := func(ms float64) *string { s := ISOString(ms); return &s }
	for i, edit := range []func(*MarketQuote){
		func(q *MarketQuote) { q.Bid = nil }, func(q *MarketQuote) { q.Ask = f64(math.NaN()) }, func(q *MarketQuote) { q.Bid = f64(7) },
		func(q *MarketQuote) { q.Ask = f64(20) }, func(q *MarketQuote) { q.BidDepth = 0 },
		func(q *MarketQuote) { q.ExchangeTimestamp = iso(fvtest.Now - 31000) },
		func(q *MarketQuote) { q.ReceiveTimestamp = ISOString(fvtest.Now + 30000) },
	} {
		if q, _ := clean(edit); q != nil {
			t.Errorf("patch %d accepted", i)
		}
	}
	noExchange, _ := clean(func(q *MarketQuote) { q.ExchangeTimestamp = nil })
	if noExchange.FreshnessBasis != "receive" || noExchange.Mid != 5 {
		t.Errorf("no exchange time %+v", noExchange)
	}
	zero, _ := clean(func(q *MarketQuote) { q.Bid, q.BidDepth = f64(0), 0 })
	if zero == nil || zero.CalibrationEligible {
		t.Errorf("zero bid %+v", zero)
	}
	old := fvtest.Clean(2, 5)
	old.QuoteTimestamp = ISOString(fvtest.Now - 20000)
	s := CoherentSnapshot([]CleanQuote{fvtest.Clean(1, 5), old}, DefaultQuotePolicy)
	if len(s.Eligible) != 1 || s.Excluded[0].Reasons[0] != "snapshot_time_dispersion" {
		t.Errorf("coherent %+v", s)
	}
}

func TestMarketRobustForwardRejectsOutlier(t *testing.T) {
	in := fvtest.ChainDefault(70, 85, 95, 100, 105, 120, 150)
	for i := range in.Quotes {
		if in.Quotes[i].Token == fvtest.DefaultToken(150, CE) {
			q := &in.Quotes[i]
			q.Mid += 100
			q.Bid, q.Ask = f64(*q.Bid+100), f64(*q.Ask+100)
		}
	}
	r := EstimateOptionsForward(ForwardArgs{Metadata: in.Metadata, Quotes: in.Quotes, D: in.D})
	outlier := false
	for _, p := range r.ExcludedPairs {
		for _, reason := range p.Reasons {
			outlier = outlier || (p.Strike == 150 && reason == "robust_forward_outlier")
		}
	}
	if !(math.Abs(*r.Value-100) < 1e-9) || r.PairCount != 6 || !outlier || !(*r.Dispersion < 1e-10) {
		t.Errorf("forward %+v", r)
	}
}

func TestMarketTargetStrikeExcludedAndIncoherentPairs(t *testing.T) {
	in := fvtest.ChainDefault(90, 100, 110)
	r := EstimateOptionsForward(ForwardArgs{Metadata: in.Metadata, Quotes: in.Quotes, D: in.D, ExcludeStrike: f64(100)})
	if r.Available || r.PairCount != 2 {
		t.Errorf("excluded %+v", r)
	}
	for _, p := range r.Pairs {
		if p.Strike == 100 {
			t.Error("target strike used")
		}
	}
	inc := fvtest.ChainDefault(80, 90, 100, 110)
	inc.Quotes[0].QuoteTimestamp = ISOString(fvtest.Now - 5000)
	found := false
	for _, p := range EstimateOptionsForward(ForwardArgs{Metadata: inc.Metadata, Quotes: inc.Quotes, D: inc.D}).ExcludedPairs {
		for _, reason := range p.Reasons {
			found = found || reason == "incoherent_pair_timestamps"
		}
	}
	if !found {
		t.Error("incoherent timestamps not excluded")
	}
}

func carryObject(edit func(*jsjson.Object)) *jsjson.Object {
	o := obj("source", "verified carry test", "as_of", "2026-10-01T06:00:00Z", "version", "v1", "convention", "deterministic carry",
		"verified", true, "proportional", true, "dividend_yield", .02, "dividends", []any{}, "corporate_actions", []any{})
	if edit != nil {
		edit(o)
	}
	return o
}

func TestMarketFuturesAndVerifiedCarry(t *testing.T) {
	ch := fvtest.ChainDefault(100)
	curve := fvtest.Curve()
	base := ResolveArgs{Expiry: fvtest.Expiry, Now: fvtest.Now, Curve: &curve,
		Futures: []ForwardFuture{{ExpiryTimestamp: "2026-12-17T10:00:00Z", Quote: fvtest.Clean(1, 104)}},
		Spot:    &Spot{Value: 100, Timestamp: ISOString(fvtest.Now - 100)}, MaxAgeMs: 30000}
	resolve := func(edit func(*ResolveArgs)) ForwardResult {
		a := base
		a.Options = EstimateOptionsForward(ForwardArgs{Metadata: ch.Metadata, Quotes: ch.Quotes, D: ch.D})
		edit(&a)
		return ResolveForward(a)
	}
	if resolve(func(*ResolveArgs) {}).Available {
		t.Error("other-expiry future used")
	}
	if s := resolve(func(a *ResolveArgs) {
		a.Futures = []ForwardFuture{{ExpiryTimestamp: fvtest.Expiry, Quote: fvtest.Clean(1, 101)}}
	}).Source; s != "matching_expiry_futures" {
		t.Errorf("source %s", s)
	}
	tt := YearFraction(fvtest.Expiry, fvtest.Now)
	carry := DecodeCarry(carryObject(nil))
	nearStrict(t, *resolve(func(a *ResolveArgs) { a.Carry = carry }).Value, 100*jsmath.Exp(.03*tt), 1e-10, "proportional carry")
	dividendTime := "2026-10-15T03:45:00Z"
	discrete := DecodeCarry(carryObject(func(o *jsjson.Object) {
		o.Set("proportional", false)
		o.Set("dividend_yield", nil)
		o.Set("dividends", []any{obj("timestamp", dividendTime, "amount", 2.0), obj("timestamp", "2027-01-01T00:00:00Z", "amount", 1000.0)})
	}))
	expected := (100 - 2*jsmath.Exp(-.05*YearFraction(dividendTime, fvtest.Now))) / jsmath.Exp(-.05*tt)
	nearStrict(t, *resolve(func(a *ResolveArgs) { a.Carry = discrete }).Value, expected, 1e-10, "discrete dividends")
	actions := DecodeCarry(carryObject(func(o *jsjson.Object) { o.Set("corporate_actions", []any{"2026-10-10T00:00:00Z"}) }))
	if resolve(func(a *ResolveArgs) { a.Carry = actions }).Available {
		t.Error("corporate action ignored")
	}
}

func TestMarketExactMetadataAndVerifiedPolicy(t *testing.T) {
	inst := Instrument{InstrumentToken: 123, Name: "NIFTY", Tradingsymbol: "NIFTY-HOLIDAY-CE", Exchange: "NFO", InstrumentType: CE,
		Expiry: "2026-11-16", LotSize: 75, TickSize: .05, Strike: 25000}
	if ResolveOptionMetadata(inst, nil, "v1").OK {
		t.Error("date-only expiry without policy")
	}
	if r := ResolveOptionMetadata(inst, fvtest.ExpiryPolicy(), "v1"); r.Metadata.ExpiryTimestamp != "2026-11-16T10:00:00.000Z" {
		t.Errorf("policy timestamp %+v", r)
	}
	exact := inst
	exact.ExpiryTimestamp = func() *string { s := "2026-11-16T10:10:00Z"; return &s }()
	if r := ResolveOptionMetadata(exact, nil, "v1"); r.Metadata.ExpiryTimestamp != "2026-11-16T10:10:00.000Z" {
		t.Errorf("exact %+v", r)
	}
	american := inst
	american.ExerciseStyle = func() *string { s := "american"; return &s }()
	if ResolveOptionMetadata(american, fvtest.ExpiryPolicy(), "v1").OK {
		t.Error("american accepted")
	}
	if _, ok := UTCTimestamp("2026-02-30T10:00:00Z"); ok {
		t.Error("rollover accepted")
	}
	if _, ok := UTCTimestamp("2026-10-01T10:00:00"); ok {
		t.Error("offset-less accepted")
	}
}

// ---- maturity.test.mjs -----------------------------------------------------------------

var expiries3 = []string{"2026-10-20T10:00:00Z", "2026-11-17T10:00:00Z", "2026-12-15T10:00:00Z"}

func supportedInput(extra ...any) *InputSnapshot {
	kv := append([]any{"proportional_calendar_assumption", true, "forward_interpolation", "log_carry_assumption"}, extra...)
	return fvtest.InputSnapshot(fvtest.InputOptions{Expiries: expiries3, Patch: fvtest.Set(kv...)})
}

func request(expiry string, strike float64, research bool) CalculatorRequest {
	return CalculatorRequest{Underlying: "TEST", Strike: strike, ExpiryTimestamp: expiry, Side: CE, ResearchMode: research}
}

func defaultRequest() CalculatorRequest { return request("2026-11-01T10:00:00Z", 100, false) }

func scaleSlice(s *ExpirySlice) {
	for i := range s.Smile.Nodes {
		s.Smile.Nodes[i].W *= .1
	}
	if s.Smile.Parameters != nil {
		s.Smile.Parameters.A *= .1
		s.Smile.Parameters.B *= .1
	}
}

func TestMaturityInterpolationAtSameK(t *testing.T) {
	input := supportedInput()
	surface := BuildSurface(input)
	for _, r := range surface.CalendarRegions {
		if !r.Valid {
			t.Fatalf("region invalid %+v", r.Diagnostics)
		}
	}
	a, b := &surface.Slices[0], &surface.Slices[1]
	tt, k := (*a.T+*b.T)/2, .03
	actual := TotalVarianceBetween(a, b, tt, k, &input.Config, false)
	expected := (*VarianceAt(&a.Smile, k, input.Config.Smile, false) + *VarianceAt(&b.Smile, k, input.Config.Smile, false)) / 2
	if *actual != expected {
		t.Errorf("total variance %v != %v", *actual, expected)
	}
	r := Calculate(input, &surface, defaultRequest())
	logCarry := false
	for _, a := range r.Assumptions {
		logCarry = logCarry || strings.Contains(a, "log carry")
	}
	if !r.Available || r.Contract != "hypothetical" || r.InstrumentToken != nil || r.FairValuePerLot != nil ||
		r.MaturityMethod != "maturity_interpolation" || !logCarry || !(math.Abs(*r.SurfaceIv-.3) < 1e-7) {
		t.Errorf("calculator %+v", r)
	}
}

func TestMaturityListedAndHypotheticalContracts(t *testing.T) {
	input := supportedInput()
	surface := BuildSurface(input)
	listed := Calculate(input, &surface, request(expiries3[1], 100, false))
	if listed.Contract != "listed" || *listed.FairValuePerLot != *listed.FairValue*50 {
		t.Errorf("listed %+v", listed)
	}
	hyp := Calculate(input, &surface, request(expiries3[1], 102, false))
	if hyp.Contract != "hypothetical" || hyp.StrikeMethod != "strike_interpolation" {
		t.Errorf("hypothetical %+v", hyp)
	}
	base := func() *jsjson.Object {
		return obj("underlying", "TEST", "strike", 100.0, "expiry_timestamp", "2026-11-01T10:00:00Z", "side", "CE", "research_mode", false)
	}
	for key, value := range map[string]any{"strike": "100", "side": "American"} {
		o := base()
		o.Set(key, value)
		if _, err := ValidateCalculatorRequest(o); err == nil {
			t.Errorf("%s=%v accepted", key, value)
		}
	}
	zero := base()
	zero.Set("strike", 0.0)
	if _, err := ValidateCalculatorRequest(zero); err == nil {
		t.Error("strike 0 accepted")
	}
	if Calculate(input, &surface, request(ISOString(fvtest.Now), 100, false)).Available {
		t.Error("valued an already-expired request")
	}
}

func TestMaturityCrossingInvalidatesRegion(t *testing.T) {
	input := supportedInput()
	surface := BuildSurface(input)
	scaleSlice(&surface.Slices[1])
	surface.CalendarRegions = BuildCalendarRegions(surface.Slices, input)
	crossing := false
	for _, d := range surface.CalendarRegions[0].Diagnostics {
		crossing = crossing || d.Code == "calendar_variance_crossing"
	}
	if surface.CalendarRegions[0].Valid || !crossing {
		t.Errorf("region %+v", surface.CalendarRegions[0])
	}
	if Calculate(input, &surface, defaultRequest()).Available {
		t.Error("valued across a crossing")
	}
}

func TestMaturityResearchOptInAndLimits(t *testing.T) {
	input := supportedInput("research_enabled", true, "maturity_extrapolation", "constant_short_end_and_forward_variance", "max_maturity_extrapolation_days", 40.0)
	surface := BuildSurface(input)
	if Calculate(input, &surface, request("2026-12-30T10:00:00Z", 100, false)).Available {
		t.Error("extrapolated without research mode")
	}
	long := Calculate(input, &surface, request("2026-12-30T10:00:00Z", 100, true))
	if !long.Available || long.Quality != "research" {
		t.Errorf("long %+v", long)
	}
	if Calculate(input, &surface, request("2027-06-30T10:00:00Z", 100, true)).Available {
		t.Error("beyond the distance limit")
	}
	short := Calculate(input, &surface, request("2026-10-10T10:00:00Z", 100, true))
	unreliable := false
	for _, a := range short.Assumptions {
		unreliable = unreliable || strings.Contains(a, "especially unreliable")
	}
	if !short.Available || !unreliable {
		t.Errorf("short %+v", short)
	}
	if Calculate(input, &surface, request(expiries3[1], 200, true)).Available {
		t.Error("strike far outside support")
	}
	scaleSlice(&surface.Slices[2])
	if Calculate(input, &surface, request("2026-12-30T10:00:00Z", 100, true)).Available {
		t.Error("negative forward variance repaired")
	}
}

func TestMaturityUnsupportedCarryAndEvents(t *testing.T) {
	input := supportedInput("proportional_calendar_assumption", false)
	surface := BuildSurface(input)
	if Calculate(input, &surface, defaultRequest()).Available {
		t.Error("interpolated without a carry assumption")
	}
	cfg, err := input.Config.With(func(raw *jsjson.Object) {
		raw.Set("proportional_calendar_assumption", true)
		raw.Set("carry", obj("TEST", obj("source", "test", "version", "v1", "as_of", ISOString(fvtest.Now), "convention", "known cash dividends",
			"verified", true, "proportional", false, "dividend_yield", nil,
			"dividends", []any{obj("timestamp", "2026-10-25T00:00:00Z", "amount", 1.0)}, "corporate_actions", []any{})))
	})
	if err != nil {
		t.Fatal(err)
	}
	input.Config = cfg // config_version is left as it was, as the Node test mutates the object
	surface = BuildSurface(input)
	if Calculate(input, &surface, defaultRequest()).Available {
		t.Error("event-insensitive interpolation with discrete dividends")
	}
}

// ---- independent.test.mjs --------------------------------------------------------------

func cloneQuotes(in *InputSnapshot) *InputSnapshot {
	c := *in
	c.Quotes = make([]MarketQuote, len(in.Quotes))
	for i, q := range in.Quotes {
		cp := q
		if q.Bid != nil {
			cp.Bid = f64(*q.Bid)
		}
		if q.Ask != nil {
			cp.Ask = f64(*q.Ask)
		}
		c.Quotes[i] = cp
	}
	return &c
}

func js(v any) string { return string(jsjson.Marshal(v)) }

func TestIndependentLeaveOneStrikeOut(t *testing.T) {
	input := fvtest.InputSnapshot(fvtest.InputOptions{})
	expiry := input.Instruments[0].Expiry
	original := IndependentEstimateFor(input, expiry, 100)
	if original.Status != "available" {
		t.Fatalf("original %+v", original.Reasons)
	}
	changed := cloneQuotes(input)
	tokens := map[float64]bool{}
	for _, i := range changed.Instruments {
		if i.Strike == 100 {
			tokens[i.InstrumentToken] = true
		}
	}
	for i := range changed.Quotes {
		if q := &changed.Quotes[i]; tokens[q.Token] {
			*q.Bid *= 10
			*q.Ask *= 10
		}
	}
	excluded := IndependentEstimateFor(changed, expiry, 100)
	if js(excluded.Values) != js(original.Values) || js(excluded.Forward.Pairs) != js(original.Forward.Pairs) || len(excluded.ExcludedTokens) != 2 {
		t.Error("target quotes influenced the estimate")
	}
	for _, p := range excluded.Forward.Pairs {
		if p.Strike == 100 {
			t.Error("target strike in the forward")
		}
	}
	for _, r := range excluded.Smile.Calibration.Residuals {
		if tokens[r.Token] {
			t.Error("target token calibrated")
		}
	}
	row := func(s SurfaceSnapshot) *ValuationRow {
		for i := range s.Slices[0].Rows {
			if r := &s.Slices[0].Rows[i]; r.Strike == 100 && r.Side == CE {
				return r
			}
		}
		return nil
	}
	ivOf := func(r *ValuationRow) any {
		if r.ObservedIv == nil || r.ObservedIv.Iv == nil {
			return nil
		}
		return *r.ObservedIv.Iv
	}
	if ivOf(row(BuildSurface(input))) == ivOf(row(BuildSurface(changed))) {
		t.Error("the full surface should see the changed quotes")
	}
}

func TestIndependentInsufficientData(t *testing.T) {
	sparse := fvtest.InputSnapshot(fvtest.InputOptions{Strikes: []float64{95, 100, 105}})
	if s := IndependentEstimateFor(sparse, sparse.Instruments[0].Expiry, 100).Status; s != "insufficient_data" {
		t.Errorf("sparse %s", s)
	}
	supported := fvtest.InputSnapshot(fvtest.InputOptions{})
	if s := IndependentEstimateFor(supported, supported.Instruments[0].Expiry, 80).Status; s != "insufficient_data" {
		t.Errorf("edge %s", s)
	}
}

func TestIndependentSensitivityRange(t *testing.T) {
	r := ModelSensitivity(SensitivityArgs{F: 100, Strike: 100, T: .5, D: .98, Iv: .2, Side: CE, ForwardDispersion: f64(1), RateBump: .0025,
		QuoteIvBid: f64(.19), QuoteIvAsk: f64(.21)})
	low, high := math.Inf(1), math.Inf(-1)
	for _, s := range r.Scenarios {
		low, high = math.Min(low, s.Price), math.Max(high, s.Price)
		if len(s.Assumption) <= 10 {
			t.Errorf("assumption %q", s.Assumption)
		}
	}
	if r.Label != "Model sensitivity range" || r.Low != low || r.High != high || len(r.Scenarios) != 7 || !(r.Low < r.High) {
		t.Errorf("range %+v", r)
	}
}

// ---- pipeline.test.mjs (pure parts) ----------------------------------------------------

func TestPipelineListedExpiryIdentityAndUnits(t *testing.T) {
	smile := fvtest.SmileObject()
	smile.Set("model", "interpolation")
	input := fvtest.InputSnapshot(fvtest.InputOptions{Patch: fvtest.Set("smile", smile)})
	result := BuildSurface(input)
	if result.InputSnapshotID != input.ID || result.ConfigVersion != input.ConfigVersion {
		t.Fatal("identity")
	}
	slice := &result.Slices[0]
	if slice.Smile.Method != "validated_interpolation" || !slice.Smile.Valid {
		t.Fatalf("smile %s %v %+v", slice.Smile.Method, slice.Smile.Valid, slice.Smile.Diagnostics)
	}
	var row *ValuationRow
	for i := range slice.Rows {
		if slice.Rows[i].Strike == 100 && slice.Rows[i].Side == CE {
			row = &slice.Rows[i]
		}
	}
	if !(math.Abs(*row.SurfaceIv-.3) < 1e-8) || *row.FairValuePerLot != *row.FairValue*50 || !(*row.BidIv.Iv < *row.AskIv.Iv) ||
		!(math.Abs(row.Comparison.MidDeviation) < 1e-8) {
		t.Errorf("row %+v", row)
	}
	dependence := 0.0
	for _, o := range slice.Observations {
		if o.Strike == 100 {
			dependence += o.DependenceFactor
		}
	}
	if !(dependence <= 1) || VarianceAt(&slice.Smile, 2, input.Config.Smile, false) != nil {
		t.Errorf("dependence %v", dependence)
	}
}

func withoutExpiryTimestamps(in *InputSnapshot) {
	for i := range in.Instruments {
		inst := &in.Instruments[i]
		inst.ExpiryTimestamp = nil
		if inst.Raw != nil {
			inst.Raw = inst.Raw.Clone()
			inst.Raw.Delete("expiry_timestamp")
		}
	}
}

func TestPipelineUnverifiedDateOnlyExpiry(t *testing.T) {
	input := fvtest.InputSnapshot(fvtest.InputOptions{})
	cfg, err := input.Config.With(func(raw *jsjson.Object) { raw.Set("expiry_policy", nil) })
	if err != nil {
		t.Fatal(err)
	}
	input.Config = cfg
	withoutExpiryTimestamps(input)
	slice := BuildSurface(input).Slices[0]
	if slice.ExpiryTimestamp != nil {
		t.Fatal("guessed an expiry time")
	}
	for _, r := range slice.Rows {
		if r.FairValue != nil || !contains(r.Reasons, "expiry_time_unverified") {
			t.Errorf("row %v %v", r.FairValue, r.Reasons)
		}
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ---- hardening.test.mjs (pure parts) ---------------------------------------------------

func TestHardeningStrictConfiguration(t *testing.T) {
	config, err := DefaultConfig(nil, fvtest.Now)
	if err != nil || config.Enabled || config.ExpiryPolicy != nil {
		t.Fatalf("defaults %v", err)
	}
	for i, patch := range []any{obj("enabled", "true"), obj("workers", 100.0), obj("quote", obj("max_age_ms", math.Inf(1))),
		obj("smile", obj("min_svi_strikes", 5.0)), obj("__proto__", obj("enabled", true)), obj("constructor", obj()),
		obj("curve", obj("as_of", "2026-10-01"))} {
		if _, err := MergeConfig(config, patch); err == nil {
			t.Errorf("patch %d accepted", i)
		}
	}
	normalized, err := MergeConfig(config, obj("curve", obj("as_of", "2026-10-01T12:00:00+05:30")))
	if err != nil || normalized.Curve.AsOf != "2026-10-01T06:30:00.000Z" {
		t.Errorf("normalised as_of %v %v", normalized.Curve.AsOf, err)
	}
}

func TestHardeningTinyAtmVarianceAndZeroVolVega(t *testing.T) {
	price := BlackPrice(BlackInput{F: 100, K: 100, D: 1, W: 1e-30, Side: CE})
	if !(math.Abs(price-100/math.Sqrt(2*math.Pi)*1e-15) < 1e-28) {
		t.Errorf("tiny ATM %v", price)
	}
	g := FrozenBlackGreeks(GreeksArgs{BlackInput: BlackInput{F: 100, K: 100, D: 1, W: 0, Side: CE}, T: 1})
	if !(g.Vega1Pct > 0) || g.ForwardGamma != nil {
		t.Errorf("zero-vol greeks %+v", g)
	}
	if !throws(func() { YearFraction("2026-11-01", "2026-10-01") }) {
		t.Error("date-only year fraction accepted")
	}
}

func TestHardeningIncoherentPairsAndDuplicatesNeverCalibrate(t *testing.T) {
	input := fvtest.InputSnapshot(fvtest.InputOptions{})
	var target []float64
	for _, i := range input.Instruments {
		if i.Strike == 100 {
			target = append(target, i.InstrumentToken)
		}
	}
	for i := range input.Quotes {
		if q := &input.Quotes[i]; q.Token == target[0] {
			q.Bid, q.Ask = f64(*q.Bid+20), f64(*q.Ask+20)
			break
		}
	}
	slice := BuildSurface(input).Slices[0]
	outlier := false
	for _, p := range slice.Forward.ExcludedPairs {
		outlier = outlier || (p.Strike == 100 && contains(p.Reasons, "robust_forward_outlier"))
	}
	if !outlier {
		t.Error("incoherent pair not excluded")
	}
	for _, o := range slice.Observations {
		if o.Strike == 100 {
			t.Error("incoherent strike calibrated")
		}
	}
	dup := input.Instruments[0]
	dup.InstrumentToken = 99999
	dup.Raw = dup.Raw.Clone()
	dup.Raw.Set("instrument_token", 99999.0)
	input.Instruments = append(input.Instruments, dup)
	for _, r := range BuildSurface(input).Slices[0].Rows {
		if r.Strike == 80 && r.Side == CE && !contains(r.Reasons, "duplicate_instrument_metadata") {
			t.Errorf("duplicate row %v", r.Reasons)
		}
	}
}
