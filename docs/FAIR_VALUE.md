# Fair Value — market-consistent European option analytics

This module estimates theoretical prices consistent with eligible **current
market quotes and documented model assumptions**. It does not discover an
objectively true price, predict realized volatility, guarantee profit or submit
orders. Full-chain fitting is in-sample; leave-one-strike-out is a separate
estimate. Quote IV ranges and model sensitivities are not confidence intervals.

## Units, contract metadata and settlement

- `S`: current spot; `F(T)`: expiry forward; `K`: positive strike.
- `T = (expiry_UTC_ms − valuation_UTC_ms)/(365×24×60×60×1000)`: **ACT/365F**,
  using exact timestamps, including intraday seconds. UTC is stored; the page
  displays **Asia/Kolkata (IST)** explicitly. Leap years still use 365.
- `D(T)>0`: discount factor; `r(T)=−ln(D)/T`: continuous annual zero rate.
- IV `σ` is an annualized **decimal**, so 20%=0.20. `w=σ²T` is total variance.
- All premiums, residuals and comparisons are **INR per underlying unit**.
  Per-lot premium/difference is multiplied by the **actual instrument `lot_size`**.
  Hypothetical contracts do not have an invented instrument ID or lot size.
- Only the NFO European CE/PE metadata mapping is supported. Invalid positive
  strike/tick/lot metadata, nonfinite numbers, unsupported styles and invalid
  discounts are rejected.
- Dates come from the active broker's cached instrument master, never a weekday
  expiry rule. Exact instrument timestamps/verified overrides take precedence.
  Date-only masters require an explicit verified expiry-time policy: source,
  timestamp, version, timezone and time. **No policy is preconfigured**, per the
  user's decision after inspecting conflicting 15:30/15:40 conventions. Special
  sessions require exact instrument overrides.
- At `T<=0`, no IV/surface Greeks: `max(settlement−K,0)` for CE and
  `max(K−settlement,0)` for PE. Official index close/official stock settlement
  underlying is required for a final value. Spot-based payoff is labelled
  **indicative**, never final settlement. Physical delivery is not an order or
  settlement service provided by this module.

Metadata references inspected 2026-10-03:
[NSE contract specifications](https://www.nseindia.com/products-services/equity-derivatives-contract-specifications),
[NSE market timings](https://www.nseindia.com/market-data/market-timings),
[NSE individual security options](https://www.nseindia.com/products-services/equity-derivatives-individual-securities),
[NSE Clearing final settlement underlying](https://www.nseclearing.in/clearing-settlement/equity-derivatives/settlement-price).

## Discount curve

For supplied continuously compounded nodes, `ln D_j=−r_j T_j`. Between increasing
nodes, `α=(T−T1)/(T2−T1)` and `ln D=(1−α)ln D1+α ln D2`.
`D(0)=1` is included as an anchor. `D>1` is legitimate at negative rates.
Outside node support a configured flat-rate fallback is available only when
explicitly enabled, labelled **flat rate assumption**. No options regression
invents a curve. Every result includes source, UTC as-of, convention and version.

## Quote cleaning

`Mid=(Bid+Ask)/2`, `Spread=Ask−Bid`,
`RelativeSpread=Spread/max(Mid,premium_floor)`.
Exchange and receive timestamps are retained independently; exchange timestamp is
preferred for age when present, otherwise freshness is labelled receive-based.
Stale receive timestamps still exclude quotes. Future timestamps outside clock
tolerance, missing/invalid/crossed/wide quotes and insufficient depth are excluded.
Cross-sectional dispersion is `max(eligible times)−min(eligible times)`; older
quotes outside the configured cross-section window are excluded explicitly.
LTP is never substituted for the midpoint.

Zero-bid policy: `exclude` or default `diagnostic_only`. A zero bid carries no
normal midpoint calibration weight and is never a parity-forward input.
Analytics freshness is independent of entry/execution limits.

Price loss scale `h=max(Spread/2, instrument tick, tick_floor)`.
Weight `exp(−QuoteAge/τ_age) × min(1,AvailableDepth/DepthTarget)` uses the smaller
two-sided touch depth. These are configurable **engineering heuristics**.

## Expiry forward

European parity `C−P=D(F−K)` gives `F_i=K+(C_mid−P_mid)/D`.
Pairs require matching metadata/settlement/lot and coherent exchange/receive
timestamps. Base pair weight is the **minimum** call/put quote weight.

Initialize with weighted median `F0`. Robust outlier exclusion uses
`6×max(1.4826×weighted MAD, pair_scale/D, tick_floor/D)` by default. Optional
deterministic IRLS minimizes `Σω Huber(D(F_i−F)/s_i)` with Huber tuning 1.5,
`s_i=max((Spread_call+Spread_put)/2, both instrument ticks, tick_floor)` and 30
iterations. A minimum of three pairs is required by default.

Pair forward intervals:
`lower=K+(C_bid−P_ask)/D`, `upper=K+(C_ask−P_bid)/D`.
The intersection (including incompatibility), pair count, weighted median
`|F_i−F_hat|` dispersion, parity residuals and excluded pairs are exposed.
Excessive relative dispersion makes the options-implied forward unavailable.

Fallback hierarchy:
1. robust options-implied forward;
2. fresh **exact-expiry** futures midpoint, assuming deterministic rates and
   negligible futures/forward convexity adjustment;
3. verified carry: `F=S exp((r−q)T)` for supported proportional continuous
   dividends; or `F=(S−Σ d_j D(t_j))/D(T)` for known cash dividends strictly before
   expiry, under deterministic funding/no borrow basis assumptions;
4. unavailable.

Unknown dividend/corporate-action carry is never inferred from the app's indicative
Yahoo dividend yields. A different-expiry future is never silently substituted.

## Black price, inversion and Greeks

`φ(x)=exp(−x²/2)/sqrt(2π)` and `N(x)=.5(1+erf(x/sqrt(2)))`.
Cephes/SciPy erf/erfc rational approximations preserve normal tails; attribution is
in `src/fairValue/THIRD_PARTY.md`.

Final surface prices use `k=ln(K/F)`, `w=σ²T`,
`d1=−k/sqrt(w)+sqrt(w)/2`, `d2=d1−sqrt(w)`:

`C=D[F N(d1)−K N(d2)]`, `P=D[K N(−d2)−F N(−d1)]`.
OTM pricing plus parity avoids deep-ITM cancellation. At `w=0` use discounted
forward intrinsic, with no division by zero.

Bounds: CE `[D max(F−K,0),D F]`; PE `[D max(K−F,0),D K]`.
Bound tolerance is `max(price_tolerance,tick×tick_tolerance_fraction,
32 machine_epsilon×discounted notional)`.
IV solves Black price minus premium with a maintained bisection bracket, initial
high 0.5, bounded doubling, maximum IV 5, 120 iterations by default. Termination
requires both price tolerance and volatility bracket tolerance. Outcomes are
`valid`, `zero_volatility`, `outside_bounds`, `low_vega`, `no_finite_solution`,
`bracket_failure`, `iteration_failure`, `expired`, `invalid_input`.
Quote/tick uncertainty divided by vega diagnoses ill conditioning. Bid/mid/ask
are inverted separately; ask-minus-bid IV is a **quote-implied range**.

Frozen-volatility Greeks at fixed local IV:
- CE forward delta `D N(d1)`; PE `D(N(d1)−1)`;
- forward gamma `Dφ(d1)/(Fσsqrt(T))`;
- vega `D F φ(d1)sqrt(T)`, displayed **per 1 IV percentage point**, divided by 100;
- proportional-carry spot delta `forward_delta×F/S`, gamma
  `forward_gamma×(F/S)²`, only for a verified proportional model;
- fixed-F/r/IV calendar-year theta `rV−D Fφ(d1)σ/(2sqrt(T))`, divided by 365 per day;
- fixed-forward rho `−TV`, divided by 100 per 1 rate percentage point.

These omit changes in surface IV as spot/forward moves. At zero variance the
ATM gamma/theta singularity is unavailable rather than an invented finite number.

## Verification

Run `npm run build && npm run test:fair-value`.
Independent reference check:
`PYTHONPATH=scratch/quantlib python3 scripts/fair_value_quantlib.py`.
QuantLib is verification-only, not a production dependency. Reference prices span
calls/puts, extreme moneyness, short/long maturities and negative discount rates;
IV reference checks are limited to well-conditioned premiums.

## Listed expiry smiles and calibration

Coordinates are `k=ln(K/F)`, `w=IV² T`. OTM PE below the forward and OTM CE above
are preferred. Around ATM (default `|k|<=0.01`), eligible CE/PE weights are divided
by the number of sides so one economic strike is not double-counted. Both sides
retain bid/mid/ask IV diagnostics; ill-conditioned IVs do not initialize a fit.

Calibrate in price space: `Σω Huber((Black(wθ)−Mid)/h) + λ R(θ)`.
`h=max(spread/2,tick,tick_floor)`; weights are freshness×capped depth with ATM
dependence normalization. Huber tuning defaults to 1.5; regularization defaults
to 0.001. An engineering density penalty assists calibration; **hard acceptance
checks below**, not the penalty, decide validity. No bid/ask-only objective is
assumed to identify a unique smile. Diagnostics retain price residuals, normalized
price RMSE, % inside bid/ask, observation/distinct strike counts, all optimizer
starts/iterations/status, rejects and duration.

Raw SVI:
`w(k)=a+b[ρ(k−m)+sqrt((k−m)²+η²)]`. Width is named `η`, not IV `σ`.
Optimization uses deterministic, box-bounded Nelder–Mead, five fixed starts by
default and 700 iterations per start. Parameterization enforces positive minimum
variance `a+bη sqrt(1−ρ²)`, `b>=0`, `|ρ|<1`, `η>0`. Wings obey
`b(1±ρ)<=1.999<2` by default. These bounds establish positive variance and the
appropriate right-tail `d1→−∞` restriction, **not** global butterfly freedom.
At least nine distinct strikes, k span 0.10 and three strikes on each wing are
required by default; all are configurable within bounded ranges.

For `x=k−m`, `w'=b[ρ+x/sqrt(x²+η²)]`,
`w''=bη²/(x²+η²)^(3/2)` and
`g(k)=[1−k w'/(2w)]²−w'²/4[1/w+1/4]+w''/2`.
An adaptive grid includes observations, between-strike points, smile minimum,
ATM, supported wings and at least `[-2,2]` k, with midpoints refined near low g
and curvature. Negative/nonfinite g suppresses the candidate. The grid is finite
and is never represented as a global proof or an “arbitrage-free SVI” guarantee.
SSVI analytic sufficient conditions are not implemented.

Failed/unsupported SVI attempts retain failure evidence. The only fallback is
explicit **validated piecewise-linear total-variance interpolation** inside
observed support. Large k gaps are unavailable. CE/PE prices at observed and
eight subdivisions of actual strike spacing are checked before accepting it.
Fallback cannot extrapolate and receives **limited** quality; a failed fallback
returns unavailable. This finite price validation does not prove smooth density
at interpolation knots.
Small neighbors on both sides of knots are also tested to detect slope
discontinuities. Unsupported gaps invalidate the fallback slice conservatively.

## Final price-space validation

For sorted actual strikes, `slope=(price_next−price)/(K_next−K)`.
CE slopes must be in `[-D,0]`, PE in `[0,D]`, and both nondecreasing. Parity
`C−P−D(F−K)` and European bounds are checked with tick-aware numeric tolerance.
Observed and intermediate strikes are validated, as are requested/interpolated
prices. Violations return structured code/location/value evidence
and suppress the affected fit/region rather than presenting a reliable price.

Mathematical reference: Gatheral & Jacquier,
[Arbitrage-free SVI volatility surfaces, 1204.0646v3](https://arxiv.org/abs/1204.0646),
Sections 2–4. The Vogt counterexample is a regression demonstrating that valid
basic parameters can still have negative g.

## Admin isolation and snapshots

The `Fair Value` route/button requires the **full** admin role. All routes beneath
`/api/fair-value` (including settings, history, exports and streams) have a
router-wide backend guard; trade-access users are denied. SSE rechecks the session
role on every emission/heartbeat, closes revoked/expired or slow consumers, and
throttles publications to five seconds. Private values are not browser-persisted.

Reuse the active broker's InstrumentProvider and the refcounted existing
futures/data lane under the `analytics` owner. No broker connection, order adapter
or REST quote-polling loop is added. Only bounded spare subscription capacity is
used. LTP-only packets cannot freshen retained bid/ask books. Existing market-data
and execution state remains owned by its respective consumers.

CPU fitting runs in worker threads (one by default, maximum two), with bounded
memory, queue and wall-clock time. Input/config/metadata and UTC quote timestamps
are captured immutably. Publication atomically swaps one complete result after
checking input ID, broker generation, feed generation and configuration version.
An old-generation result is discarded. A failed/poison worker affects analytics
only. No execution/exit/reconciliation lock is held.

New Mongo collections `fair_value_settings` and `fair_value_snapshots` reuse the
existing app connection. History is rate-limited, count- and age-bounded and
retains model/config versions, diagnostics, source data and input IDs. No Mongo
configuration means explicitly memory-only storage. Analytics can be disabled
independently and is disabled by default; pause releases its subscriptions.

## Maturity interpolation and hypothetical valuation

For `T1<=T<=T2`, evaluate both slices at **the same** `k=ln(K/F(T))`:
`α=(T−T1)/(T2−T1)`, `w(k,T)=(1−α)w(k,T1)+αw(k,T2)` and
`SurfaceIV=sqrt(w/T)`. Annualized IV is not interpolated directly.

The calendar check `w(k,T2)>=w(k,T1)` requires documented proportional-dividend/
deterministic-carry assumptions. Supply verified proportional carry or explicitly
enable `proportional_calendar_assumption`. Known discrete dividends/corporate
actions disable this maturity interpolation implementation. An adaptive
common-support k grid checks crossings. Crossing invalidates the **whole common
region** conservatively; no silent variance clamp/repair is used. Intermediate
maturities at α=.25,.5,.75 are repriced and price-space validated; the requested
maturity is validated again. Finite checks are not a global arbitrage guarantee.

Hypothetical forward policy:
- verified carry uses the documented deterministic formulas where supported;
- otherwise explicitly selected `log_carry_assumption` interpolates
  `c_j=ln(F(T_j)/S)`, `c(T)=(1−α)c1+αc2`, `F(T)=S exp(c(T))`;
- no policy/current spot/support means unavailable. This assumption does not
  account for unknown dividends, corporate actions or borrow/funding basis.

Calculator inputs: listed underlying, **numeric positive** strike, exact future
UTC/offset-bearing expiry and CE/PE. The UI date/time input is explicitly **IST**,
converted to UTC independently of the browser's timezone.
`F*=ForwardCurve(T*)`, `D*=DiscountCurve(T*)`, `k*=ln(K*/F*)`,
`w*=VarianceSurface(k*,T*)`, `σ*=sqrt(w*/T*)`; final value is Black(F*,K*,D*,w*).
The complete verified listing catalog distinguishes listed contracts even when
the quote-capture budget omits one. Hypothetical valuations have
`instrument_token=null` and `lot_size=null`.

Strike methods: `listed_strike`, `strike_interpolation`, `strike_extrapolation`,
`unavailable`. Maturity methods: `listed_expiry`, `maturity_interpolation`,
`maturity_extrapolation`, `unavailable`. All extrapolation requires **both**
`research_enabled=true` and request `research_mode=true`. SVI wings outside
observed strikes are extrapolation, bounded by `strike_extrapolation_k`; the
interpolation fallback cannot extrapolate. Extrapolated output is **research**.

Optional maturity research policy, disabled by default:
- short end: `w(k,T)=(T/T1)w(k,T1)`, labelled the especially unreliable
  constant-short-end-variance-rate assumption near events/expiry;
- long end: `v_forward=(w_n−w_(n−1))/(T_n−T_(n−1))`,
  `w(k,T)=w_n+v_forward(T−T_n)`; negative forward variance is rejected, never clamped;
- log carry uses the spot anchor for the short end and final two node slope for
  the long end, unless verified carry is supplied;
- maturity distance is bounded by `max_maturity_extrapolation_days`, with fresh
  source snapshots and requested price validation.

## Independent estimates and sensitivities

**Full-chain fitted value** is in-sample using all eligible observations within
the bounded captured chain. Captured/listed counts and omitted expiries are exposed.

**Leave-one-strike-out** removes **both CE and PE at the target strike before
forward estimation, IV selection and fitting**, refits the remaining slice and
reprices the target. Insufficient remaining pairs/coverage returns
`insufficient_data`, including endpoints outside remaining support. Cache keys
include input ID, expiry/strike and model/config version. Requests are deduplicated,
count/TTL bounded and worker-based. Up to eight recent immutable inputs remain
addressable during refreshes, never beyond surface freshness. Independent results
are separate from the immutable full-chain snapshot.

**Model sensitivity range**, not a confidence interval, is min/max over explicit
scenario repricings at a frozen local IV/carry convention:
1. baseline fitted forward, discount and surface IV;
2. forward ± weighted median absolute forward dispersion, when nonzero/available;
3. valid target bid-IV and ask-IV, when available;
4. continuous-zero rate ± configured `sensitivity_rate_bump`, holding F/IV fixed:
   `D_scenario=D exp(∓bump T)`.

Each scenario exposes name, F, D, IV, price and assumption. Missing scenarios are
not invented. The helper supports a separately supplied calibration alternative;
the shipped UI uses the scenarios above and shows independent estimates separately.
The range has no calibrated probability/coverage and ignores unmodeled events and
joint parameter dependence.

Comparisons, **before fees and execution costs**:
`MidDeviation=Mid−FairValue`,
`MidDeviationPercent=100(Mid−FairValue)/max(FairValue,premium_floor)`,
`TheoreticalBuyDifference=FairValue−Ask`,
`TheoreticalSellDifference=Bid−FairValue`.
Multiply each by the actual lot multiplier for per-lot comparisons. Labels are
**Above model**, **Below model**, **At model**; no recommendation/profit guarantee.

## Quality and unavailable labels

| Label | Meaning |
|---|---|
| `supported` | Accepted SVI, supplied curve, robust forward with compatible intervals, eligible quote conditions and complete captured support. Not a probability/global proof. |
| `limited` | Valid interpolation, hypothetical/maturity interpolation, fallback forward/flat curve, receive-only freshness, missing/stale target quote or bounded captured support; reasons accompany it. |
| `research` | Explicitly opted-in, bounded, revalidated extrapolation. |
| `invalid` | Density, price-space or residual validation fails; affected prices suppressed. |
| `unavailable` | Required data, verified expiry, curve/forward, support or policy missing. Nulls have reasons. |

Important reasons: `expiry_time_unverified`, `invalid_instrument_metadata`,
`unsupported_contract_style`, `duplicate_instrument_metadata`, `missing_quote`,
`invalid_quote`, `crossed_quote`, `stale_quote`, `wide_spread`, `insufficient_depth`,
`future_quote_timestamp`, `zero_bid_low_information`, `receive_time_freshness`,
`snapshot_time_dispersion`, `incoherent_call_put_pair_excluded_from_calibration`,
`iv_low_vega`, `discount_unavailable`, `forward_unavailable`,
`incompatible_forward_intervals`, `flat_discount_assumption`,
`bounded_input_chain_support`, `strike_outside_supported_range`,
`smile_invalid_or_unavailable`. Rejected pairs/observations retain specific reasons.
Stale/expired viewing is marked; current calculations reject it. Source timestamps
and versions expose curve/surface/metadata age; a curve's publication schedule is
not inferred automatically.

## Complete configuration reference

`GET/PATCH /api/fair-value/config` supplies the full settings object. PATCH accepts
validated partial nested settings. Unknown/prototype keys, wrong types and invalid
bounds are rejected; timestamps normalize to UTC. The complete object is hashed
to a config version and persisted in Mongo; failed persistence is explicitly
memory-only. Priority: defaults, `FAIR_VALUE_CONFIG_JSON`, then saved validated
full-admin settings.

### Environment gates

| Variable | Default | Meaning |
|---|---|---|
| `FAIR_VALUE_ENABLED` | false | Initial analytics default; saved full-admin `enabled` may override it. |
| `FAIR_VALUE_DISABLED` | false | Hard deployment disable; true cannot be overridden by saved/UI settings. |
| `FAIR_VALUE_CONFIG_JSON` | empty | Validated JSON settings patch. Invalid config disables only Fair Value. |

### Runtime/resources/history

| JSON setting | Default | Unit / accepted bounds / policy |
|---|---|---|
| `enabled` | false | Independent Boolean analytics switch. |
| `refresh_ms` | 5000 | ms, integer 2000..300000; fitting cadence, no broker REST polling. |
| `surface_max_age_ms` | 60000 | ms, integer 5000..600000; current/recent input freshness. |
| `max_underlyings` | 3 | integer 1..5; oldest watch evicted at cap. |
| `max_tokens` | 600 | integer 20..1000; further limited by spare lane headroom. |
| `max_expiries` | 4 | integer 1..12; nearest listed dates, omissions exposed. |
| `universe_refresh_ms` | 60000 | ms, integer 15000..300000; cached universe/window refresh. |
| `recenter_log_distance` | .02 | absolute log spot movement, .001.. .20; 15-second minimum interval. |
| `workers` | 1 | integer 1..2; independent worker threads. |
| `worker_timeout_ms` | 8000 | ms, integer 100..30000; reject/terminate over-budget worker. |
| `max_queue` | 8 | integer 1..16; worker/refit/persistence resource caps. |
| `history_limit` | 100 | integer 1..500; snapshots per underlying. |
| `history_interval_ms` | 60000 | ms, integer 10000..3600000. |
| `history_retention_days` | 7 | integer 1..30; API filter and Mongo TTL. |
| `history_memory_max_bytes` | 16777216 | bytes, integer 1048576..67108864; total memory history; at most 20 underlying histories. |
| `independent_cache_limit` | 64 | integer 1..128. |
| `independent_cache_ttl_ms` | 60000 | ms, integer 1000..600000; surface freshness remains authoritative. |
| `research_enabled` | false | Boolean prerequisite for request opt-in. |
| `maturity_extrapolation` | `none` | `none` or `constant_short_end_and_forward_variance`. |
| `max_maturity_extrapolation_days` | 30 | ACT/365F days beyond endpoints, 0..90. |
| `forward_interpolation` | `unavailable` | `unavailable` or `log_carry_assumption`; verified carry may independently provide F. |
| `proportional_calendar_assumption` | false | Explicit same-k calendar assumption; discrete events disable this implementation. |
| `sensitivity_rate_bump` | .0025 | decimal annual rate, 0.. .05; .0025=0.25 percentage points. |

Fixed bounds: analytics yields **before** higher-priority subscription transport,
preserving 200 tokens below the 3000-token lane limit; execution limits are not
modified. Watches expire after 180 seconds idle. Verified listing metadata is
capped at 20000 contracts per underlying and excluded from fit transfer/archived
quote input. Workers use 96 MiB old/16 MiB young generation limits. At most 20
streams; consumers above 256000 queued output bytes close. Heavy requests have
a 30/minute cap under the existing app limiter. Frontend updates throttle to five
seconds; a 15-second auth/status heartbeat continues during display pause.

### `quote` settings — analytics only

| Field | Default | Unit / accepted bounds |
|---|---|---|
| `max_age_ms` | 30000 | ms, 500..300000. |
| `max_relative_spread` | .25 | ratio .001..2, .25 means 25%. |
| `max_absolute_spread` | 100 | ₹/unit, .01..10000. |
| `min_depth` | 1 | underlying units, 1..1e8; observed depths are safe nonnegative integers. |
| `premium_floor` | 1 | ₹/unit, 1e-8..1000; spread/deviation denominator floor. |
| `tick_floor` | .05 | ₹/unit, 1e-8..1000; actual instrument tick also applies. |
| `depth_target` | 100 | underlying units, 1..1e8; capped weight target, not execution liquidity. |
| `freshness_tau_ms` | 15000 | ms, 1..300000. |
| `max_pair_dispersion_ms` | 2000 | ms, 0..300000; stricter quote/forward cap applies. |
| `max_snapshot_dispersion_ms` | 10000 | ms, 0..300000. |
| `future_timestamp_tolerance_ms` | 1000 | ms, 0..300000. |
| `zero_bid_policy` | `diagnostic_only` | `diagnostic_only` or `exclude`; no normal midpoint calibration. |

### `iv` solver

| Field | Default | Unit / accepted bounds |
|---|---|---|
| `initial_high` | .5 | decimal IV, .01..10, capped by max. |
| `max_volatility` | 5 | decimal IV, .1..10; 5 means 500%. |
| `max_expansions` | 8 | integer 0..16. |
| `max_iterations` | 120 | integer 10..300. |
| `price_tolerance` | 1e-9 | ₹/unit, 1e-14.. .1. |
| `tick_tolerance_fraction` | .01 | 0.. .5, bound classification. |
| `volatility_tolerance` | 1e-9 | decimal IV, 1e-14.. .1. |
| `low_vega_threshold` | 1e-6 | ₹/unit per decimal IV, 1e-14.. .1. |
| `max_iv_uncertainty` | .10 | decimal IV, .001..1; uncertainty/vega threshold. |

### `forward` settings

| Field | Default | Unit / accepted bounds |
|---|---|---|
| `min_pairs` | 3 | integer 2..50. |
| `huber_delta` | 1.5 | standardized residual, .1..10. |
| `refine` | true | Boolean deterministic robust refinement. |
| `refinement_iterations` | 30 | integer 1..100. |
| `outlier_scale` | 6 | robust scale multiplier, 1..20. |
| `max_pair_dispersion_ms` | 2000 | ms, 0..300000. |
| `tick_floor` | .05 | ₹/unit, 1e-8..1000. |
| `max_relative_dispersion` | .005 | ratio 1e-8.. .1; .005=0.5% of F. |

Huber: `z²/2` when `|z|<=δ`, otherwise `δ(|z|−δ/2)`. Refinement stops when F
movement is at most `tick_floor×1e-6` or iterations expire. MAD is not a confidence
width.

### `smile` settings

| Field | Default | Unit / accepted bounds |
|---|---|---|
| `model` | `svi` | `svi` with fallback, or `interpolation`. |
| `min_svi_strikes` | 9 | integer 7..100. |
| `min_k_span` | .10 | k, .001..2. |
| `min_each_wing` | 3 | integer 2..20. |
| `atm_band` | .01 | absolute k, 0.. .05. |
| `min_interpolation_strikes` | 3 | integer 3..100. |
| `max_interpolation_gap` | .15 | k spacing, .001..2. |
| `huber_delta` | 1.5 | standardized residual, .1..10. |
| `regularization` | .001 | engineering penalty scale, 0..10. |
| `max_normalized_rmse` | 4 | standardized price residual, .1..20. |
| `optimizer_iterations` | 700 | integer 20..2000 per start. |
| `optimizer_starts` | 5 | integer 2..8 fixed tuples. |
| `optimizer_tolerance` | 1e-7 | objective tolerance, 1e-12.. .01. |
| `butterfly_tolerance` | 1e-8 | g numerical tolerance, 0..1e-4. |
| `variance_floor` | 1e-12 | total variance, 1e-14..1e-4. |
| `max_wing_slope` | 1.999 | variance/k, .01..1.99999, strictly <2. |
| `diagnostic_points` | 161 | integer 51..501 base grid. |
| `adaptive_depth` | 4 | integer 1..6; SVI adaptive cap 8192 points. |
| `strike_extrapolation_k` | .10 | distance past observed endpoints, 0.. .5, research only. |
| `calendar_tolerance` | 1e-8 | total-variance difference, 0..1e-5. |
| `price_tolerance_ticks` | .02 | validation tick fraction, 0.. .5. |

Scaled optimizer variables: `s=weighted median(w)`, `h=max(k_span,.05)`,
`u=min_variance/s`, `β=b h/s`, `μ=m/h`, `ν=η/h`. Bounds:
`u∈[variance_floor/s,4]`, `β∈[0,min(30,max_wing_slope h/s)]`,
`ρ∈[−.98,.98]`, `μ∈[k_min/h−1,k_max/h+1]`, `ν∈[.005,3]`.
Regularization is `R=β²+.1μ²+.001/ν²`; numerical density penalty is
`1e4 Σω × mean(min(g,0)²)` on observed k and a 41-point `[-2,2]` helper grid.
Hard adaptive diagnostics/price-space tests decide acceptance.

### Curves, verified expiry and carry

| Object/field | Default / rule |
|---|---|
| `curve.source`, `as_of`, `version` | Required source/version/exact UTC-normalized timestamp; explicitly unconfigured default. |
| `curve.convention` | Exactly `continuous_zero_act365f`. |
| `curve.nodes` | Empty default; up to 100 increasing nonnegative `t` years, finite decimal `zero_rate`, positive finite D. |
| `curve.flat_rate` | null default; finite continuous annual decimal, negative permitted. |
| `curve.allow_flat_fallback` | false default; explicit Boolean outside-node fallback. |
| `expiry_policy` | null default; date-only valuations unavailable until verified. |
| `expiry_policy.exchange`, `timezone` | Exactly `NFO`, `Asia/Kolkata`. |
| `expiry_policy.local_time` | Verified `HH:mm:ss`; no 15:30/15:40 default. |
| `expiry_policy.source`, `as_of`, `version`, `convention` | Required verified source/exact timestamp/version/time convention. |
| `expiry_policy.overrides` | Trading symbol → exact timestamp, at most 1000 exceptions. |
| `carry` | Empty default; at most 100 underlying models with source/as-of/version/convention. |
| `carry.<underlying>.verified` | Required Boolean; unverified carry not used as fallback. |
| `carry.<underlying>.proportional` | Required Boolean for continuous q and spot Greeks. |
| `carry.<underlying>.dividend_yield` | null or decimal −.5..2; no Yahoo inference. |
| `carry.<underlying>.dividends` | At most 100 exact timestamp/amount events; 0..1e8 ₹/unit; after valuation and strictly before expiry only. Do not combine nonzero q and cash dividends. |
| `carry.<underlying>.corporate_actions` | At most 100 exact timestamps; blocks unmodeled carry/maturity interpolation. |

Verified expiry policy shape (replace placeholders with actual evidence, not a
default exchange-time assumption):

```json
{
  "expiry_policy": {
    "exchange": "NFO",
    "timezone": "Asia/Kolkata",
    "local_time": "<verified HH:mm:ss>",
    "source": "<verified exchange circular/configuration>",
    "as_of": "<exact UTC/offset timestamp>",
    "version": "<source version>",
    "convention": "expiry timestamp on the metadata expiry date",
    "overrides": {}
  }
}
```

## API and frontend behavior

Full-admin `x-admin-token` required; streams may use the same query parameter.
Async JSON revalidates role at emission. Responses use `private, no-store`.

| Endpoint under `/api/fair-value` | Behavior |
|---|---|
| `GET /status` | Feed/worker/surface ages, readiness, versions, errors. |
| `GET /config`, `PATCH /config` | Independent validated settings and persistence. |
| `GET /underlyings` | Existing option/spot universe and metadata expiry dates. |
| `POST /refresh` | `{underlying}`; capture/publish worker result. |
| `GET /snapshot/:underlying` | Immutable current surface and age/stale status. |
| `POST /pause` | `{paused:boolean}`; release/resume analytics subscriptions. |
| `POST /calculate` | `{underlying,strike,expiry_timestamp,side,research_mode,input_snapshot_id?}`; future expiry, optional pinned ID. |
| `POST /independent` | `{underlying,expiry,strike,input_snapshot_id}`; both sides excluded. |
| `GET /history/:underlying?limit=...` | Lightweight bounded version/quality summaries. |
| `GET /history/:underlying/:id` | Full immutable historical snapshot. |
| `GET /export/:underlying` | JSON current snapshot with explicit age/stale status. |
| `GET /stream?underlying=...` | Throttled snapshots/status, per-emission auth/backpressure. |

Pause-display freezes data rendering, not age/auth status. Pause-analytics releases
subscriptions. Auth failure unmounts private data. Numeric chart axes preserve
nonuniform spacing; straight paths do not invent smoothing. Tables scroll within
the container. Drawer supports Escape, initial focus and focus containment.
Historical viewing is labelled and disables current calculators/refits.

## Known limitations and verification scope

- Live broker data/production deployment are **not exercised** locally; analytics
  stays disabled until independently configured.
- Date-only expiry-time evidence is an operator requirement. Contract metadata,
  special sessions and settlement rules need actual verification; no weekday rule.
- NFO European vanilla only: no American/exotic/BFO/commodity pricing or automatic
  official settlement retrieval. Unknown official settlement stays indicative.
- Raw SVI, finite diagnostics and interpolation are **not analytic global
  arbitrage guarantees**. No constrained SSVI proof or automatic crossing repair;
  invalid regions are conservatively unavailable.
- Low-vega/zero-bid/sparse/wide/stale chains can legitimately be unavailable.
  No statistical calibration confidence is claimed.
- Maturity interpolation with discrete dividends/events is unavailable; listed
  forwards may use verified discrete carry but hypothetical surface maturity needs
  supported proportional assumptions.
- Quote books are analytics observations, not evidence that size will execute.
  Dhan uses receive-time freshness without an exchange book timestamp; hidden
  upstream latency is unknown.
- Budgets limit captured support. Full-chain means all eligible **captured**
  observations, visibly distinct from all broker listings.
- Frozen local-IV Greeks only; no surface-aware/sticky-delta/full spot-carry theta
  or rho. Scenario sensitivities are alternatives, not confidence intervals.
- Memory history may retain fewer rows due to byte caps. Mongo is optional; failed
  writes retry within bounded queues with visible degradation.
- Optional 3D surface is not included; IV/variance/ATM-maturity/residual charts are.

Verification (local fixture/reference data):

```bash
# Backend
npm test
PYTHONPATH=scratch/quantlib python3 scripts/fair_value_quantlib.py
node scripts/fair_value_mongo_test.mjs
node scripts/fair_value_mongo_test.mjs --box-integration
node scripts/fair_value_app_smoke.mjs
# Frontend
npm run build && npm test
PLAYWRIGHT_BROWSERS_PATH=scratch/browsers node scripts/fair_value_browser_test.mjs
```

QuantLib 1.40 is verification-only. Reference check: 1344 call/put prices and 786
well-conditioned IV inversions, observed maximum price difference
5.820766091346741e-11. Tests cover mathematical failures, target exclusion,
admin/stream revocation, consistent snapshots and real worker timeout isolation.
Ephemeral Mongo verifies persistence/restart reads; Chromium verifies actual
React/API workflows, mobile containment and non-admin zero-data requests. Actual
app smoke uses dummy credentials, no broker session, paper execution and invalid
analytics config to verify isolation. Exact outcomes are in task STATUS.md;
pre-existing optional database tests remain explicitly skipped without fixtures;
`--box-integration` runs the existing 16-test integration file on the ephemeral
server's separate throwaway database, with mocked broker adapters.
