# Test inventory: suites the Go port keeps (Box dropped)
Task `2026-10-27-go-postgres-migration`, phase 0. Backend HEAD `1ea1d95`. Read-only static analysis of `tests/`.
Nothing was built or run: `dist/` does not exist in the checkout, so every count below is a static `grep -cE '^(test|it)\('`
(no file uses `it(`, `describe(`, `t.test(` or `{concurrency}`), not a test-run result.
Scope rule (PLAN.md): keep only tests of code the Go service keeps; Box (`src/box/*` except `quotes`, `localCharges` rate card,
`math` strike-window trio, `brokerContext` types, `types.OrderSide`) is dropped with its tests.

Conventions:
- Cat: `PURE` (deterministic, no I/O) · `FAKE` (hand-rolled fake transport/repository/clock) · `DB` (needs a store) ·
  `HTTP` (real Express listener on 127.0.0.1:0 + `fetch`) · `TIME` (real timers/sleeps/`Date.now`). First tag dominant.
- Cases: `kept/total` static `test(` sites. "adapt" = keep the behaviour, rewrite the setup; "drop" = pins Box behaviour.
- dist paths are `../../dist/<x>.js` = compiled `src/<x>.ts`.

## 1. How the kept suites run today
| Item | Fact |
|---|---|
| Runner | `node:test` + `node:assert/strict`, ESM `.mjs`. No mocking library: `mock.fn/mock.timers/mock.method` occur 0 times. All fakes are hand-written objects. |
| Build gate | `npm test` = `tsc -b` then `test:unit` (`tests/box/*.test.mjs`), `test:fair-value` (`tests/fairValue/*.test.mjs`), `test:integration` (`tests/integration/*.test.mjs`). `noEmitOnError` → one type error fails every import. |
| Process model | `node --test` runs each file in its own child process: module singletons (`trackedTimers` registry, Dhan parse report, `globalThis.WebSocket`) do not leak across files; within a file, cases run sequentially in declaration order. |
| Integration dir | Only `tests/integration/mongoOrderIntentCas.test.mjs` (Box order intents, real Mongo). Dropped. **No kept suite touches a real database.** |
| Helpers (not globbed) | `tests/fairValue/fixtures.mjs` (kept), `tests/box/helpers.mjs` (only `chain()` is needed, for 4 math cases), `tests/box/liveEntryHarness.mjs` (Box, dropped). |
| Fixture generators | `tests/migration-fixtures/generate.mjs` (writes `box/*.json`; only `charges.json` kept), `generate-parity.mjs` (writes `box-parity/*`, dropped). Neither matches a test glob. |
| Network | Kept HTTP suites bind `127.0.0.1:0` only. No suite reaches a broker, Mongo or Redis. |

## 2. Summary of kept files
| File | Lines | Cases kept/total | Cat | Pins |
|---|---:|---:|---|---|
| fairValue/auth | 45 | 1/1 | HTTP TIME | router-wide full-admin guard, `no-store`, SSE closes on role revocation |
| fairValue/hardening | 128 | 8/8 | PURE FAKE HTTP | strict config merge, Black limits, pair/duplicate exclusion, analytics yield, hub fan-out, role re-check, namespace reset, history ceilings |
| fairValue/independent | 43 | 3/3 | PURE | leave-one-strike-out estimate, sensitivity range |
| fairValue/market | 92 | 6/6 | PURE | curve, quote cleaning, robust forward, carry/dividends, metadata timestamps |
| fairValue/maturity | 86 | 5/5 | PURE | calendar variance interpolation, calculator, research extrapolation |
| fairValue/pipeline | 112 | 5/5 | PURE FAKE TIME | surface units, unverified expiry, immutable publication, stale worker, worker timeout |
| fairValue/pricing | 91 | 7/7 | PURE | Black-76, normal tails, bounds, IV inversion statuses, Greeks |
| fairValue/service | 70 | 1/1 | HTTP FAKE | end-to-end admin workflow over HTTP |
| fairValue/storage | 13 | 1/1 | DB | unconfigured store is explicitly memory-only |
| fairValue/svi | 84 | 5/5 | PURE | SVI derivatives, Vogt counterexample, fit, fallback, convexity grid |
| box/adminToken | 81 | 7/7 | PURE | CSPRNG admin token properties |
| box/boundedCache | 103 | 9/9 | FAKE(clock) | TTL deletion, size cap, LRU-ish eviction |
| box/brokerIdentity | 134 | 7/10 | PURE | broker id set, legacy=zerodha, parse/label |
| box/dhanActiveNoKite | 355 | 15/16 | FAKE | Dhan active ⇒ zero Kite calls; token namespace; feed health |
| box/dhanBoardJoin | 332 | 18/18 | PURE TIME | Dhan scrip-master join by UNDERLYING_SECURITY_ID, board diagnostics |
| box/dhanFeedDecoder | 380 | 19/19 | PURE FAKE | Dhan v2 binary decoder, `toTick`, FULL vs partial provenance into quote store |
| box/dhanMarginAndIp | 595 | 44/44 | FAKE env | multi-margin wire body + fallback order, static-IP verification |
| box/dhanSupport | 473 | 37/44 | PURE TIME | segments, token identity, CSV/master parse, auth expiry, errors, candles, chunking |
| box/indexSpot | 170 | 10/10 | PURE | index spot symbol resolution both brokers |
| box/localCharges | 196 | 11/12 | PURE env | rate card arithmetic and shipped defaults |
| box/marketDataLanes | 201 | 11/11 | FAKE | two-lane isolation, tick-rate counter |
| box/marketDataTransport | 293 | 26/26 | FAKE(clock) | token-list validation, session store, browser refcount |
| box/shutdown | 266 | 15/15 | TIME | idempotent ordered shutdown with timeout |
| box/singleBroker | 393 | 13/23 | FAKE env | default broker, switch teardown order, transport isolation, health |
| box/subscriptionCoordinator | 179 | 14/14 | FAKE | refcounted subscription ownership |
| box/tickerHubLifecycle | 91 | 1/1 | FAKE(WebSocket) | socket generations ignore superseded sockets |
| box/tokenRouteAuth | 104 | 12/12 | PURE | passcode guard fails closed |
| box/trackedTimers | 58 | 4/4 | TIME | interval registry |
| box/math (partial) | 787 | 4/37 | PURE | `selectStrikeWindow`, `strikeStepOf`, `shouldRecentreWindow` (+`atmStrikeFor`) |
| box/config (partial) | 237 | 0/16 | — | no case touches kept env; drop the file |
| box/migrationFixtures (partial) | 250 | 1 replay (2 fixture cases) / 2+8 | PURE golden | `charges.json` |
| box/depthReadiness (grep) | 272 | 7+1 partial/11 | PURE | quote-store book provenance, Kite `parseBinary` provenance |
| box/serialize (grep) | 291 | 4/10 | PURE | quote store receive-time/ageing, `SpotStore` |
| box/dhanAdapter (grep) | 453 | 0/36 | — | correlation ids + Dhan order adapter: both dropped |

Totals: Fair Value 42/42; tests/box 290 kept or adapted (incl. 2 conditional, 1 rewrite) out of the listed files.
Imports of `dist/{synthetic/*,eodCapture,hourlyCapture,yahoo,redis,kite,marketDataRoutes,index,ratelimit}.js` anywhere in
`tests/`: **0** (the words appear only in comments, e.g. "Redis flush retry" in trackedTimers). `dist/db.js` is imported only by Box suites (`executionAttemptProjection`, `fillAttribution`,
`mongoReservationIntegration`, `mongoOrderIntentCas`) — all dropped. `dist/ticker.js` only via `depthReadiness`.
`dist/hub.js` via `tickerHubLifecycle`, `hardening`.


## 3. Fair Value suites (`tests/fairValue/`) — all kept
Fixture time base for every FV file: `NOW = Date.parse('2026-10-01T06:00:00Z')`, `EXPIRY = '2026-11-17T10:00:00Z'`
(from `fixtures.mjs`, §8). All timestamps are offset-bearing ISO strings, so FV tests are TZ-independent.

### 3.1 `auth.test.mjs` (45 lines, 1 case) — HTTP TIME
- dist: `fairValue/routes.js` (`registerFairValueRoutes`). Also `express`, `node:events.once`, global `fetch`.
- Pins: for 13 method/path pairs (`GET /status`, `GET /config`, `PATCH /config`, `GET /underlyings`, `GET /snapshot/TEST`,
  `POST /refresh`, `POST /pause`, `POST /calculate`, `POST /independent`, `GET /history/TEST`, `GET /history/TEST/id`,
  `GET /export/TEST`, `GET /stream`) × tokens `''`, `trade-test`, `expired` ⇒ 403 and `Cache-Control` matching `/no-store/`
  (`private, no-store` set router-wide before auth). `engine.status` call count stays 0 (no handler runs). `full-test` ⇒
  `/status` 200. SSE `GET /stream?x-admin-token=full-test` (query token accepted only on `/stream`) ⇒ 200, first chunk
  non-empty; flipping `role=null` makes the server close the stream on the next tick (`streamIntervalMs: 10`); then
  `/export/TEST` ⇒ 403.
- Seams: route deps `{engine, getAdminRole(token)→'full'|'trade'|null, requireFullAdmin(req,res,next), streamIntervalMs}`;
  fake engine methods used by routes: `status, getConfig, updateConfig, underlyings, getSnapshot, refresh, pause, history,
  historicalSnapshot, subscribe(listener)→unsubscribe` (`calculate`, `independent` are absent from the fake → 403 before use).
- Go: `httptest.NewServer`; SSE handler must re-check the role on every emission/heartbeat (ticker interval injectable).
- Flaky: the read loop `while (!(await reader.read()).done)` has no timeout; a Go handler that never re-checks the role
  hangs the test. Give the Go test a context deadline.

### 3.2 `hardening.test.mjs` (128 lines, 8 cases) — PURE FAKE HTTP
dist: `fairValue/config.js` (`defaultConfig, mergeConfig`), `pipeline.js` (`buildSurface`), `black.js`
(`blackPrice, frozenBlackGreeks, yearFraction`), `engine.js` (`FairValueEngine`), `brokers/subscriptions.js`
(`SubscriptionCoordinator`), `routes.js`, `history.js` (`SnapshotHistory`), `hub.js` (`TickerHub`).
1. `mergeConfig` throws for `{enabled:'true'}`, `{workers:100}`, `{quote:{max_age_ms:Infinity}}`, `{smile:{min_svi_strikes:5}}`,
   a JSON `__proto__` key, `{constructor:{}}`, `{curve:{as_of:'2026-10-01'}}` (date-only); `defaultConfig({})` has
   `enabled:false, expiry_policy:null`; `as_of '2026-10-01T12:00:00+05:30'` normalises to `'2026-10-01T06:30:00.000Z'`.
   Go: reject unknown keys at every level (`DisallowUnknownFields` is not enough for `__proto__`/`constructor`; check names).
2. `blackPrice` with `w=1e-30` at ATM ≈ `100/√(2π)·1e-15` within `1e-28`; `frozenBlackGreeks` with `w=0` at ATM gives
   `vega_1pct>0`, `forward_gamma === null`; `yearFraction('2026-11-01','2026-10-01')` throws (date-only rejected).
3. `buildSurface`: shifting the 100-strike call by +20 ⇒ `forward.excluded_pairs` has strike 100 with reason
   `robust_forward_outlier` and no observation at 100; a duplicated instrument (new token, same contract) ⇒ every
   80-CE row carries `duplicate_instrument_metadata`.
4. `SubscriptionCoordinator.setAnalyticsYield(handler)`: owners `strategy [1,2]`, `analytics [1,3,4]`, upstream cap 4
   asserted inside the fake `subscribeTokens`; growing `strategy` to `[1,2,5,6]` must call the yield handler first, so the
   `drop` of 3 precedes the `add` of 5; analytics still owns 1; upstream = `{1,2,5,6}`. (`strategy` owner has no Go
   producer once Box is gone; the coordinator is generic, keep the owner label.)
5. `new TickerHub(credsFn, onDead).retainFanout()` never calls `credsFn`; release is idempotent.
6. Route re-check: fake `engine.history` returns a pending promise; role revoked before it resolves ⇒ 403
   `{"error":"Full admin access required."}` (the router wraps `res.json` to re-check the role at write time). Busy-waits
   `while(!finish)` with 1 ms sleeps. Go: re-check role inside the JSON writer helper, not only in middleware.
7. `FairValueEngine` (deps below) with `activeBroker:'dhan'`: after two refreshes 100 ms apart the input snapshot id
   changes; `engine.independent({underlying, expiry, strike:100, input_snapshot_id: first})` still resolves the *older*
   recent snapshot (`status:'available'`); `getInput('TEST').quotes[*].exchange_timestamp === null` (Dhan has no
   exchange stamp); bumping `brokerGeneration` ⇒ `getSnapshot().snapshot === null`, `status().watched_underlyings` empty,
   `setTokens([])`.
8. `new SnapshotHistory({maxBytes, maxUnderlyings:2, now})`; 20 `add(snapshot, limit=100, retentionDays=1)` ⇒
   `stats().snapshots <= 2`, `stats().bytes <= 2×JSON bytes + 100`; after `now += 2 days`, `list('TEST',1)` is empty.
   Go: byte size must be measured on the same JSON encoding (`Buffer.byteLength(JSON.stringify())` = UTF-8 length).
- Engine deps (exact names): `getAllInstruments() async, getBoard() async → [{symbol,name,spot_token}], metadataVersion(),
  activeBroker(), brokerGeneration(), dataReady(), switching(), setTokens(tokens), tokenBudget(), retainFeed()→release,
  feedStatus(), store, config, now(), workers?`. Engine methods: `watch, ingestTicks(ticks, now), refresh, getSnapshot,
  getInput, independent, invalidate, dispose, status, boot, updateConfig, calculate, history, historicalSnapshot, pause,
  subscribe, yieldToPriority`.
- Tick shape fed to `ingestTicks`: `{token,last_price,close_price,oi,bid,ask,bids[{price,qty,orders}],asks[…],depth_updated,exchange_ts?}`.

### 3.3 `independent.test.mjs` (43 lines, 3 cases) — PURE
dist: `independent.js` (`independentEstimate`), `pipeline.js`, `sensitivity.js` (`modelSensitivity`).
- Multiplying both 100-strike quotes ×10 leaves `independentEstimate(input, expiry, 100)` `values` and `forward.pairs`
  deep-equal to the original, excludes 2 tokens, no residual token at 100; full `buildSurface` IV at 100 *does* change.
- Sparse strikes `[95,100,105]` and endpoint strike 80 ⇒ `status:'insufficient_data'`.
- `modelSensitivity({f:100,strike:100,t:.5,d:.98,iv:.2,side:'CE',forwardDispersion:1,rateBump:.0025,quoteIvBid:.19,quoteIvAsk:.21})`
  ⇒ label `'Model sensitivity range'`, 7 scenarios, `low=min`, `high=max`, each `assumption.length>10`, `low<high`.
- Go: `structuredClone` → deep copy helper; `assert.deepEqual` on floats is exact equality.

### 3.4 `market.test.mjs` (92 lines, 6 cases) — PURE
dist: `curve.js` (`discountAt`), `quotes.js` (`cleanQuote, coherentSnapshot, DEFAULT_QUOTE_POLICY`), `forward.js`
(`estimateOptionsForward, resolveForward`), `metadata.js` (`resolveOptionMetadata, utcTimestamp`), `black.js`.
- Curve: log-discount interpolation with negative rates gives `d = e^{0.02}` at t=.75 (tol 1e-14), `d>1` allowed;
  flat fallback `method:'flat_rate_assumption'`; t beyond nodes with no fallback ⇒ `available:false`; duplicate node t throws.
- `cleanQuote` rejects `bid:null`, `ask:NaN`, crossed `bid:7`, wide `ask:20`, `bid_depth:0`, exchange stamp 31 s old,
  receive stamp 30 s in the future; missing exchange stamp ⇒ `freshness_basis:'receive'`, `mid:5`; zero bid with zero depth
  ⇒ ok but `calibration_eligible:false`. `coherentSnapshot` drops a quote 20 s older with `snapshot_time_dispersion`.
- Forward: 7-pair chain with a +100 outlier ⇒ value 100 (1e-9), `pair_count 6`, outlier reason `robust_forward_outlier`,
  `dispersion<1e-10`; `excludeStrike:100` ⇒ unavailable, `pair_count 2`; 5 s-skewed pair ⇒ `incoherent_pair_timestamps`.
- `resolveForward`: non-matching futures expiry ⇒ unavailable; matching ⇒ `source:'matching_expiry_futures'`;
  proportional carry `q=.02` ⇒ `100·e^{.03t}` (1e-10); discrete dividend before expiry only (after-expiry 1000 ignored)
  ⇒ `(100 − 2·D(t_div)) / D(t)` (1e-10); any corporate action ⇒ unavailable.
- Metadata: no expiry policy ⇒ not ok; policy 15:30 IST ⇒ `'2026-11-16T10:00:00.000Z'`; explicit `expiry_timestamp`
  wins; `exercise_style:'american'` ⇒ not ok; `utcTimestamp('2026-02-30T10:00:00Z')` and offsetless strings ⇒ null.
  Go: `time.Parse(RFC3339)` already rejects Feb 30 and offsetless strings; keep it strict (no `time.ParseInLocation` fallback).

### 3.5 `maturity.test.mjs` (86 lines, 5 cases) — PURE
dist: `pipeline.js`, `calculator.js` (`calculate, validateCalculatorRequest`), `maturity.js`
(`totalVarianceBetween, buildCalendarRegions`), `smile.js` (`varianceAt`).
- 3 expiries (`2026-10-20/11-17/12-15T10:00Z`), config `proportional_calendar_assumption:true`,
  `forward_interpolation:'log_carry_assumption'`. Midpoint total variance equals the mean of both slices' `varianceAt`
  **exactly** (`assert.equal`). Hypothetical calc: `contract:'hypothetical'`, `instrument_token:null`,
  `fair_value_per_lot:null`, `maturity_method:'maturity_interpolation'`, an assumption matching `/log carry/`, IV .3 (1e-7).
- Listed: `contract:'listed'`, per-lot = fair×50; strike 102 ⇒ `strike_method:'strike_interpolation'`; validator throws for
  string strike, 0 strike, side `'American'`; expiry = valuation time ⇒ unavailable.
- Scaling slice-2 variance ×0.1 then `buildCalendarRegions` ⇒ region 0 invalid with `calendar_variance_crossing`.
- Research: needs `research_mode:true`; 2026-12-30 ok with `quality:'research'`; 2027-06-30 beyond 40 days ⇒ no;
  short end 2026-10-10 ok with `/especially unreliable/`; strike 200 ⇒ no; negative forward variance ⇒ no.
- Non-proportional carry or a dividend inside the interval ⇒ unavailable.

### 3.6 `pipeline.test.mjs` (112 lines, 5 cases) — PURE FAKE TIME
dist: `pipeline.js`, `smile.js`, `engine.js`, `workers.js` (`AnalyticsWorkers`).
1. `smile.model:'interpolation'` ⇒ `method:'validated_interpolation'`, valid; row at 100 CE `surface_iv≈.3` (1e-8), per-lot = ×50,
   `bid_iv<ask_iv`, `|mid_deviation|<1e-8`, Σ `dependence_factor` at 100 ≤ 1, `varianceAt(k=2)` null; snapshot id/config version echoed.
2. No expiry policy and no `expiry_timestamp` ⇒ slice `expiry_timestamp:null`, every row `fair_value:null` with `expiry_time_unverified`.
3. Published snapshot is `Object.isFrozen` (deep: rows), assignment throws `TypeError`; quotes carry
   `receive_timestamp === new Date(NOW).toISOString()`; tokens ≤ 600 (`tokenBudget`); re-ingest does not mutate the
   published JSON; `invalidate()` ⇒ snapshot null. **Go has no freeze**: re-express as "returned snapshot is a value/deep
   copy; mutating it does not change the next `GetSnapshot`", and keep the JSON-unchanged assertion.
4. Fake `workers {surface(input)→Promise, stats(), dispose()}`: a refresh pending across `bump generation + invalidate()`
   is discarded (snapshot stays null); a throwing worker sets `status().last_error` matching `/isolated/`; `setImmediate`
   still runs. Uses a 5 ms sleep to let `refresh` reach the worker — ordering race on slow CI.
5. Real `AnalyticsWorkers({concurrency:1,maxQueue:1,timeoutMs:20,workerUrl: data: URL with an infinite loop})`: submit
   rejects `/time budget/`, `stats().failures>=1`, main loop keeps running. **Go cannot kill a spinning goroutine**: the
   pool must abandon the job on context timeout and the job code must poll `ctx`, or run in a subprocess. Port the test
   with a job that blocks on a channel; assert rejection with the same message and that the pool slot is reclaimed.

### 3.7 `pricing.test.mjs` (91 lines, 7 cases) — PURE
dist: `black.js` (`blackPrice, blackFromIv, priceBounds, frozenBlackGreeks, settlementPayoff, yearFraction, YEAR_MS`),
`normal.js` (`normalCdf, normalPdf`), `iv.js` (`invertIv, DEFAULT_IV_CONFIG`). Helper `near(a,e,tol=1e-10)`.
- Hull reference: CE 10.450583572185565, PE 5.573526022256971; `normalCdf(-8)=6.220960574271784e-16` (tol 1e-29),
  `normalCdf(0)=.5`, `normalPdf(0)=1/√(2π)`.
- Grid f∈{0.5,100,25000} × K/f∈{1e-4,.3,.95,1,1.2,10,1e4} × w∈{0,1e-10,.001,.04,1,25}, d=1.03: parity `C−P=d(f−k)`
  (tol 1e-7·max(1,f,k)); both inside `priceBounds` ±1e-8.
- `yearFraction` exact ACT/365F (1 year; 1000 ms / `YEAR_MS`); `w=0` ITM call = 19 at d=.95;
  `settlementPayoff`: indicative 120 ⇒ `indicative_payoff`, per lot 1500 (lot 75); settlement 118 ⇒ 18, `final_settlement`;
  none ⇒ value null.
- IV round trip CE/PE × K{80,100,120} × t{.05,.5,2} × iv{.2,.5,1}, tick 1e-8 ⇒ status `valid|low_vega`, |Δiv|≤2e-6.
- Status ladder: `outside_bounds` (price 100), `no_finite_solution` (98), `zero_volatility` (0), `expired` (t=0),
  `invalid_input` (f=Inf), `bracket_failure` (max_volatility .01), `iteration_failure` (max_iterations 1), `low_vega`.
- Greeks vs central bumps (h=.001): forward delta 1e-8, gamma 1e-7, vega_1pct 1e-5, rho `−t·p/100`, spot delta ×1.05,
  spot gamma ×1.05², theta per calendar day (dt 1e-5) 1e-8.
- Invalid inputs throw: k=0, f<0, d=0, d=NaN, w<0, side 'american'; `blackFromIv(t=0)` throws.
- Go tolerance note: `analytics.md §0.1` (V8 libm vs Go `math.Exp`): these tests use tolerances ≥1e-10 except the CDF tail
  (absolute 1e-29 on 6.2e-16 ≈ 1.6e-14 relative) — needs the Cephes port verbatim.

### 3.8 `service.test.mjs` (70 lines, 1 case) — HTTP FAKE
dist: `engine.js`, `routes.js`. Real Express + `fetch`; engine with `memoryStore()` and controllable `now`.
- Config patch: `history_interval_ms:10000, history_limit:2`, 2 expiries. Flow: `boot`, `watch`, ingest (spot token 1 with
  `depth_updated:false`, then the chain) ⇒ `POST /refresh` 200 with priced rows; `POST /calculate` strike 102 expiry
  2026-11-01 ⇒ 200, available, hypothetical, `instrument_token:null`, ≥3 sensitivity scenarios;
  two concurrent `engine.independent(req)` return the **same object** (`assert.equal` identity) and a third call is cached
  (identity again) — Go: return the same pointer from a singleflight/cache; `POST /independent` with a stale
  `input_snapshot_id` ⇒ 400; 3 more refreshes at +10 s ⇒ `GET /history/TEST` returns exactly 2 summaries, no `rows` in
  slices, each with `model_version, config_version, input_snapshot_id`; `GET /history/TEST/:id` ⇒ `historical:true`;
  `GET /export/TEST` 200; after `surface_max_age_ms+1` ⇒ `/snapshot` `stale:true` and `/calculate` 400;
  `POST /pause {paused:true}` ⇒ `setTokens([])`, `/refresh` 503; `updateConfig({enabled:false})` ⇒ disabled, no tokens,
  `/snapshot` `snapshot:null`.
- Rate limit: `/refresh`, `/calculate`, `/independent`, `PATCH /config` share a 30/min per-IP budget created inside
  `registerFairValueRoutes`; this test spends 8. It uses real `Date.now` (no seam).
- DB: the PG version of `memoryStore.append(snapshot,input,limit)` must keep only `limit` newest per underlying.

### 3.9 `storage.test.mjs` (13 lines, 1 case) — DB
dist: `store.js` (`MongoFairValueStore`), `config.js`. With no Mongo configured: `enabled()===false`, `loadConfig()→null`,
`history()→[]`, `snapshot()→null`, `saveConfig()` rejects `/memory-only/` (message today: "Fair Value configuration is
memory-only: MongoDB is not available."). Go: construct the PG store with no pool (or a "database unavailable" flag) and
keep `memory-only` in the message; decide whether the word MongoDB becomes PostgreSQL (visible API text).

### 3.10 `svi.test.mjs` (84 lines, 5 cases) — PURE
dist: `svi.js` (`sviVariance, sviDerivatives, basicSviConstraints, diagnoseSvi`), `smile.js` (`fitSvi, fitSmile, varianceAt`),
`config.js` (`DEFAULT_SMILE_CONFIG`), `black.js`, `validation.js` (`validatePriceGrid`), `iv.js`.
- Analytic first/second derivative and `g` vs finite differences (h=1e-4; tol 1e-8 / 1e-7 / 1e-7) at k∈{-1,-.25,0,.2,1}.
- Vogt params `{a:-.0410,b:.1331,m:.3586,rho:.3060,eta:.4153}`: basic constraints true; `diagnoseSvi` invalid,
  `min_g<0`, `global_proof:false`, `checked_points > diagnostic_points`.
- 19 synthetic observations from `{a:.01,b:.06,rho:-.4,m:.01,eta:.15}`: `fitSvi` twice ⇒ identical `parameters`
  (`deepEqual` exact — determinism of Nelder-Mead order), `method:'svi'`, `normalized_rmse<.3`, `optimizer_starts>=2`,
  `min_g >= -butterfly_tolerance`; `varianceAt(k=.35)` null, with research flag >0; k=1 null even in research.
- 5 observations ⇒ not SVI, `optimizer_status` matches `/insufficient_support/`; 2 observations ⇒ `method:'unavailable'`.
- `validatePriceGrid` on prices [25,12,9.6] at strikes [80,100,103] ⇒ invalid with `call_convexity_violation`, no
  `*slope_violation*`.
- Go: exact parameter equality across two runs is easy; equality with Node is **not** asserted here (no golden), so the
  Kahan `hypot`/`pow` notes in `analytics.md §0.1` matter only if FV golden files are added later.

## 4. Kept `tests/box/*` suites that test non-Box modules

### 4.1 `adminToken.test.mjs` (81 lines, 7/7) — PURE
- dist: `adminToken.js` (`generateAdminToken()`).
- Pins: string, length ≥ 22 (today 43 = base64url of 32 bytes), two calls differ, 1000 distinct, `^[A-Za-z0-9_-]+$` and
  `encodeURIComponent(t)===t`, no control/whitespace/non-ASCII, shared trailing run < 5 chars (no timestamp suffix), ≥ 41
  distinct characters over 500 tokens.
- Go: `crypto/rand` 32 bytes + `base64.RawURLEncoding`. Token is the admin-session key (Mongo `_id` today → PG text PK).
- Flaky: probabilistic (suffix/alphabet/collision) but negligible.

### 4.2 `boundedCache.test.mjs` (103 lines, 9/9) — FAKE(clock)
- dist: `boundedCache.js` (`BoundedTtlCache({ttlMs, maxEntries, now})`, `get, set, size, clear`).
- Pins (ttl 4000, cap 3): fresh value returned; expired entry is deleted on `get` (`size` drops to 0); 5000 distinct keys keep
  `size<=3`; eviction oldest-first; re-`set` refreshes position; expired entries swept before evicting live ones; missing
  key returns undefined and creates nothing; `clear()`; `maxEntries:0` coerced to 1.
- Seam: injected `now()`. Go: `NewBoundedTTLCache(ttl, max, clock)`; values are `any` (`[]Tick` in production, `POST /api/quotes`).
- No DB. Note: PLAN says "use pg for caching" — this cache is in-process and must stay in-process (it bounds memory per
  request permutation); do not move it to PG.

### 4.3 `brokerIdentity.test.mjs` (134 lines, 7/10) — PURE
- dist: `brokers/types.js` (`BROKER_IDS, LEGACY_BROKER, brokerLabel, brokerOf, isBrokerId, parseBrokerId`), `box/serialize.js`.
- Kept (7): ids exactly `["zerodha","dhan"]` in order; `LEGACY_BROKER="zerodha"`; `brokerOf({}|{broker:null}|undefined|null|{broker:"upstox"})`
  → zerodha; explicit dhan/zerodha preserved; `isBrokerId` case-sensitive, rejects ""/null/1; `parseBrokerId` trims +
  lowercases, unknown → null (callers turn null into HTTP 400); `brokerLabel` → `"DHAN"`, `"ZERODHA"`.
- Drop (3): `serializeBoxTrade …` cases. The Go file must not import a Box serializer.
- DB: `brokerOf` is the read-path default for rows written before the `broker` field existed; PG rows imported from Mongo
  exports may have `broker IS NULL` → must read as zerodha (do not add `NOT NULL DEFAULT` that rewrites history silently
  unless the import fills it explicitly).

### 4.4 `dhanActiveNoKite.test.mjs` (355 lines, 15/16) — FAKE
- dist: `brokers/registry.js` (`ActiveBrokerManager`), `instrumentProvider.js`, `quoteProvider.js`, `feedHealth.js`
  (`computeFeedHealth`), `dhan/instruments.js` (`dhanInternalToken`).
- Fakes: `forbiddenKite()` — `getAccessToken→null, hasSession→false, getApiKey`, and `getInstruments, getQuoteFull,
  getQuoteOhlc, getQuoteDepth, getQuoteLadder, getHistorical, getHistoricalFull, getBasketMargin` all throw
  `KITE MUST NOT BE USED`. `forbiddenHub(state)` — `isConnected, subscribedCount, subscribeTokens(throws+records),
  unsubscribeTokens(throws), stop, seed, retain, addTickListener, addConnectionListener, ingestExternalTicks,
  setExternalConnected, attachClient`.
- Manager ctor deps: `{kite, tickerHub, boxConfig:()=>({}), istDayKey:()=>"2026-09-03", onDhanTicks}`.
- Private-state injection via `Object.defineProperty`: `active="dhan"`, `dhanAccessToken="tok"`, `dhanTokenExpiry=null`,
  `dhanSessionMeta={clientId,clientName,clientUcc,powerOfAttorney,loginDay,loginAt:Date.now()}`, `dhanFeed=fake`
  (`isConnected, subscribedCount, feedAgeMs, subscribeTokens, unsubscribeTokens, ensureSocket, stop, dispose, feedGeneration`).
  Monkeypatches `m.dhanInstrumentStore.load/get/identify` + `instruments` getter, and `m.dhan.marketFeedQuote(req)` (returns
  `{data:{[segment]:{[id]:{last_price, ohlc, oi, depth:{buy,sell}}}}}`).
- Pins: active dhan with session and no Kite session; `instrumentProvider.load(true)` returns 3 Dhan rows (no Kite call);
  internal tokens `= dhanInternalToken(seg,id) > 1e9`; `quoteProvider.quotesByToken` keyed by internal token with LTP and
  bid/ask from depth; `acquireBrowserTokens` → 3 Dhan subscribes, 0 Kite; `setStrategyTokens` → Dhan only; browser+strategy
  share a token without a second upstream subscribe, release keeps it; `assertActiveBrokerToken(408065)` false once the
  universe is loaded, true while unloaded; `marketData().isAuthenticated()` true; `feedHealth().state==="LIVE"` after
  `noteTick` + subscriptions; `computeFeedHealth({connected:true,authenticated:true,subscribed:0,universe:18492,lastTickAt:null})`
  → `CONNECTED_NO_SUBSCRIPTIONS` with `/nothing is subscribed/`; Zerodha active + live Dhan session ⇒ Kite subscribes only.
- Drop (1): `createLiveAdapter still refuses a non-active broker` (live adapters are dropped).
- Adapt (4 cases using `setStrategyTokens`): the futures-lane `strategy` owner was fed only by `BoxEngine`
  (`index.ts:5273`). In Go either keep `SetStrategyTokens` as a registry method with no production caller, or switch the
  cases to the `analytics` owner (`subscriptions.setOwnerTokens("analytics")`, Fair Value) — same routing property.
- Go seams: registry options must accept interfaces `KiteMarketData`, `TickerHub`, `DhanClient`, `DhanInstrumentStore`,
  `DhanFeedFactory`, plus a session setter/constructor option for test state (no reflection-style field poking).
- TIME: `loginAt: Date.now()` only; no sleeps.

### 4.5 `dhanBoardJoin.test.mjs` (332 lines, 18/18) — PURE TIME
- dist: `dhan/instruments.js` (`parseDhanScripMaster, getDhanParseReport, stripContractSuffix, normalizeUnderlyingKey,
  dhanInternalToken`), `brokers/boardDiagnostics.js` (`diagnoseBoard(rows, indexSpotMap), checkKnownSymbols(rows, symbols)`).
- Pins: `stripContractSuffix` on `BHEL-Sep2026-FUT`, `BHEL-SEP26-FUT`, `BHEL26SEPFUT`, `RELIANCE 2026-09-29 FUT`,
  `NIFTY 25 SEP FUT`, options incl. `BHEL300.5CE`, hyphenated `BAJAJ-AUTO…`; bare symbols (`RELIANCE`, `M&M`, `L&TFH`, `IDEA`…)
  unchanged; `normalizeUnderlyingKey` trims/uppercases/collapses spaces; 5 underlyings × 3 futures with display-style
  `SYMBOL_NAME` and empty `UNDERLYING_SYMBOL` resolve by `UNDERLYING_SECURITY_ID` (`report.underlyingResolution.byForeignKey=15`,
  `distinctFutureUnderlyings=5`); BHEL FUT/EQ normalised shape (`exchange NFO/NSE`, `segment NFO-FUT/NFO-OPT/NSE`, token from
  `NSE_FNO`); board = 5 cards, `matchedEquities 5`; `checkKnownSymbols` stage flags; orphan future ⇒ `no_spot_equity`;
  missing equity ⇒ `failsAt` `/no NSE equity row/`; index futures join through the spot map; index future keeps
  `name:"NIFTY"`/`"BANKNIFTY"` (not the index trading symbol); >400-day expiry excluded (`skippedImplausibleExpiry>=1`);
  `INSETEST` rows excluded; token ≠ raw security id.
- TIME: expiries are `Date.now()+20/48/76/3700 days` (`isoDaysFromNow`), because the parser drops derivatives
  > `MAX_FUTURE_EXPIRY_DAYS=400` ahead of `Date.now()` (`instruments.ts:187,281,326`). Go: inject `now` into the parser.
- Order dependence: `getDhanParseReport()` returns a module-level "last parse" report; each assertion must follow its own
  parse. Go: return the report from `Parse()` and keep a "last report" holder only for `/api/debug/*`.

### 4.6 `dhanFeedDecoder.test.mjs` (380 lines, 19/19) — PURE FAKE
- dist: `dhan/feedDecoder.js` (`decodeDhanFeed(buf)→{packets, errors}`, `DHAN_FEED_CODE`, `DHAN_HEADER_BYTES=8`),
  `dhan/feed.js` (`DhanFeed`, `toTick`), `box/quotes.js` (`BoxQuoteStore`, kept).
- Byte builder (little-endian): header `u8 code, i16 len, u8 segmentCode, i32 securityId`; TICKER 16 B (`f32 ltp @8,
  i32 ltt @12`); QUOTE 50 B (ltp, ltq i16 @12, ltt @14, atp @18, vol @22, sell qty @26, buy qty @30, OHLC f32 @34..46);
  OI 12 B (`i32 @8`); PREV_CLOSE 16 B (`f32 @8, i32 prev_oi @12`); FULL 162 B (… OI @34, OI hi @38, OI lo @42, OHLC @46..58,
  5 depth levels × 20 B from @62: `i32 bidQty, i32 askQty, i16 bidOrders, i16 askOrders, f32 bid, f32 ask`); DISCONNECT 10 B
  (`i16 code @8`). Float compare tolerance 1e-4 (1e-3 for 123.45).
- Pins: ltt seconds→ms and 0 ⇒ absent; QUOTE has no depth; FULL OHLC offset 12 B after QUOTE; zero-priced levels dropped;
  multi-packet frames in order; unknown code 99 skipped by declared length with error `/unknown Dhan feed response code 99/`;
  truncated ⇒ `/truncated packet/`; FULL with len 40 ⇒ `/full packet too short/`; len 0 ⇒ `/non-positive length/` (no
  infinite loop); empty frame = heartbeat (no error); < 8 B ⇒ `/shorter than the 8-byte header/`; unknown segment ⇒
  `segment:null, segmentCode:99`; `toTick` best bid/ask from ladders, `exchange_ts` absent, missing side ⇒ 0.
- Last case drives a real `DhanFeed({accessToken, clientId, onTicks, resolve})` without a socket by writing the private
  `feed.wanted` set and calling `feed.handleFrame(buf)`: FULL ⇒ `depth_updated:true`, later TICKER ⇒ `depth_updated:false`
  with retained ladders; `BoxQuoteStore.applyTicks` keeps the FULL version/`at=1000` after the partial at 2000.
  Go: same-package test (`package dhan`) or an exported `HandleFrame` + `Want(token)` test hook.

### 4.7 `dhanMarginAndIp.test.mjs` (595 lines, 44/44) — FAKE env
- dist: `brokers/registry.js`, `dhan/client.js` (`DhanClient(http, clientIdFn)`, `describeDhanMarginPayload`,
  `extractIpv4Addresses`, `normalizeDhanMultiMargin`).
- Pure (14): `normalizeDhanMultiMargin` reads `totalMargin|totalMarginRequired|total_margin`, unwraps `data`, keeps
  `span, exposure, foMargin, hedgeBenefit`; `{}`/null/`"abc"`/0/-5 ⇒ null. `describeDhanMarginPayload` names keys only
  (`"errorType, errorMessage"`, `"<no fields>"`, `"null"`). `extractIpv4Addresses` scans `ipAddress1/2`, `primaryIP/secondaryIP`,
  `data`-wrapped, arrays, skips `NA/na/""/null`, rejects `2.0.1`, `275`, `999.1.1.1`, dedupes, tolerates null/number/string.
- Wire contract (4): `DhanClient` over a recording `http.read(opts)`: `POST /margincalculator/multi` body keys exactly
  `dhanClientId, includeOrder, includePosition, scripList`; legs under `scripList` (no `orders`), no per-leg client id,
  `includePosition/includeOrder` default false, overridable.
- Basket margin via `m.margins().basketMargin(orders)` (13): stubbed `m.dhan.calculateMultiMargin(legs)` /
  `calculateMargin()`; Dhan active via `defineProperty(m,"active","dhan")`; seeded `dhanInstrumentStore.instruments`.
  Multi preferred (`source:"dhan_multi"`, total 41250, span/exposure/`hedge_benefit` 158750), all 4 legs in one call, BUY/SELL
  preserved, `productType:"MARGIN"`, `exchangeSegment:"NSE_FNO"`, qty 275, price = `reference_price` when order price 0, never
  0; multi throws or unreadable ⇒ 4 per-leg calls, `source:"dhan_per_leg_fallback"`, `hedge_benefit:null`, total 200000 ≥ hedged;
  both fail ⇒ `source:"unavailable"`, total 0; Zerodha active ⇒ `kite_basket`, no Dhan call.
- Static IP (10) + payload-shape end-to-end (3): env `DHAN_STATIC_IP_EXPECTED`, `DHAN_STATIC_PUBLIC_IP`,
  `DHAN_LIVE_TRADING_ENABLED` set/restored by `ipEnv` (awaits inside `try`). `dhanStaticIpReady()`, `dhanStaticIpState()
  {configured_ip, declared, api_verified}`, `verifyDhanStaticIp()→{verified, error, primary_ip}` with stubbed
  `m.dhan.getStaticIp`; fail-closed when nothing configured, unverified, unreachable (`/verification failed/i`), no session
  (`/without a Dhan session/`), explicit `false` overrides a verified match; mismatch names both IPs; empty whitelist
  `/returned no IP address/` + `/Response fields/`; manual-flag-only readiness adds a problem mentioning `DHAN_STATIC_PUBLIC_IP`.
- Box wording only (orders called `BOX_ORDERS`); the margin provider is kept (registry + Synthetic). Keep all 44.
- `healthFor("dhan").trading_ready` stays in the shape even though Go places no orders (PLAN: shapes unchanged).
- Go: env via `t.Setenv` (forbids `t.Parallel`) or inject an env-lookup func into the registry config.

### 4.8 `dhanSupport.test.mjs` (473 lines, 37/44) — PURE TIME
- dist: `dhan/segments.js`, `dhan/instruments.js`, `dhan/charges.js` (dropped), `dhan/auth.js`
  (`isDhanTokenExpired, parseExpiry, redactedSession`), `brokers/history.js` (`chunkDateRange, dhanCandlesToRows`),
  `dhan/errors.js` (`normalizeDhanError, isRetryableRead, DhanAuthError, DhanRateLimitError, DhanNetworkError, DhanError`).
- Kept 37: segments (5: NFO→NSE_FNO, NSE→NSE_EQ, BSE→BSE_EQ, MCX→MCX_COMM, index→IDX_I, unknown→null, code round-trip,
  99→null, back-mapping to NFO/NSE/INDICES); token identity (4: segment folded in, round-trip, stable, 0→null);
  CSV/master (7: quoted commas + `""` escapes, expiry `YYYY-MM-DD|DD/MM/YYYY|… HH:MM:SS`→ISO and `NA`→"", instrument
  classes, full option/equity row mapping, by column name, missing `SECURITY_ID` throws `/no SECURITY_ID column/`,
  malformed rows skipped); auth (5: ms/seconds/ISO expiry, unparseable→null, unknown expiry not expired, past/equal expired,
  `redactedSession` never contains access token/secret, maps `dhan_client_id→client_id`, `given_power_of_attorney→power_of_attorney`);
  errors (4: 401→`DhanAuthError` not retryable, 429→`DhanRateLimitError` retryable, `isDefinitive` true for 400/404 false for
  429/500/network, 5xx+network retryable); history (6: column→row transpose with Kite `YYYY-MM-DD HH:mm:ss` date, oldest
  first, NaN timestamp dropped, missing columns 0, `chunkDateRange` contiguous/complete, single chunk);
  master quality (6: TEST scrips excluded, >400 days excluded, EQ/INDEX not expiry-filtered, parse report counters
  `totalRows/skippedTest/skippedNoSecurityId/parsed/fnoFutures/columns/missingColumns`, missing `LOT_SIZE/TICK_SIZE` named,
  `samples` capped at 8 with Dhan-namespaced tokens).
- Drop 7 (charges block): `calculateDhanCharges`, `calculateDhanLegCharges`, `dhanRoundTrip`, `loadDhanChargeRates` —
  `DhanChargeCalculator` is dropped (PLAN). The import of `dist/brokers/dhan/charges.js` goes too.
- TIME: `Date.now()+3736/26 days` in two cases. `dhanCandlesToRows` formats IST as epoch+5h30 read with UTC getters
  (`history.ts:91-95`), so it is TZ-independent; tests match only the pattern, so add a Go value check (e.g. 1760000000 →
  `2025-10-09 14:23:20`).
- DB: `redactedSession` input is the Mongo `dhan_sessions` document shape (`login_at` is a `Date`) → PG row struct.
- Order dependence: same `getDhanParseReport()` singleton as §4.5.

### 4.9 `indexSpot.test.mjs` (170 lines, 10/10) — PURE
- dist: `indexSpot.js` (`INDEX_SPOT_MAP, indexSpotCandidates, resolveIndexSpotSymbol(underlying, has)`), `boardDiagnostics.js`.
- Pins: Dhan names (`NIFTY`, `BANKNIFTY`, `FINNIFTY`) resolve to themselves; Kite names (`NIFTY 50`, `NIFTY BANK`,
  `NIFTY MID SELECT` for `MIDCPNIFTY`, `NIFTY NEXT 50` for `NIFTYNXT50`); curated name wins when both exist; every map entry
  resolves under both conventions; no spot row ⇒ null; non-index (`RELIANCE`, `INDIA VIX`, `NIFTYIT`) never matched, even
  with `has=()=>true`; candidates `["NIFTY 50","NIFTY"]`, deduped; `diagnoseBoard` index joins under both namings
  (`matchedIndices 1, boardSize 1`); missing spot ⇒ `reason:"no_index_mapping"`.
- Go: the map's iteration order matters only for the "every entry" loop (order-free assertion).

### 4.10 `localCharges.test.mjs` (196 lines, 11/12) — PURE env
- dist: `box/localCharges.js` (`LocalChargeCalculator, calculateLegCharges, calculateBoxCharges, calculateRoundTrip, ipftFor,
  loadBoxChargeRates, reverseOrders, roundStt`). `round2 = Math.round(v*100)/100`.
- Kept direct (8): SELL STT = `roundStt(value·sttSellPct/100)` = `Math.round` (not paise), `stt_type:"stt"`, BUY STT 0
  and `stt_type:""`; stamp duty BUY only `round2(value·0.00003)`; `roundStt` 22.5→23, 22.49→22, paise mode 22.5;
  brokerage 20, exchange = `round2(value·exchangeTxnPct/100 + ipftFor)`, sebi, GST 18% of brokerage+exchange+sebi;
  `BOX_IPFT_PER_CRORE=50` ⇒ ₹50 on ₹1 crore; leg total = Σ rounded heads (BUY/SELL × prices 1.5/105/300.25/999.9);
  shipped defaults (`sttSellPct .15, exchangeTxnPct .03503, ipftPerCrore 50, sebiPct .0001, stampDutyBuyPct .003, gstPct 18,
  brokeragePerOrder 20, sttRoundNearestRupee true`); `rateVersion` contains `YYYY-MM-DD`; no negative head, IPFT>0 on ₹22,500.
- Conditional (2): "group total equals sum of legs" (`calculateBoxCharges`, `computed_by:"local"`) and "round trip reverses
  every side" (`calculateRoundTrip`, `source:"kite"/"kite_estimate"`, `reverseOrders`). Synthetic only calls
  `calculateLegCharges`, but `charges.json` (§4.20) replays exactly these two functions, so port them (pure, ~40 lines) and
  keep both cases.
- Rewrite (1): "environment overrides feed straight through" used `new LocalChargeCalculator(...).legs(...)`; re-express as
  `BOX_STT_SELL_PCT=0.05` ⇒ `calculateLegCharges(SELL 75@300, loadBoxChargeRates()).stt == 11`.
- Drop (1): `totals()` (hot-path helper of the dropped `LocalChargeCalculator`).
- Env read at call time by `loadBoxChargeRates()` (`num()` ignores blank/negative/non-finite; `bool()` accepts 1/true/yes/0/false/no).
  Go: `LoadChargeRates(getenv func(string) string)`; tests set `BOX_IPFT_PER_CRORE`, `BOX_STT_SELL_PCT`.

### 4.11 `marketDataLanes.test.mjs` (201 lines, 11/11) — FAKE
- dist: `brokers/subscriptions.js` (`new SubscriptionCoordinator(transport, lane)`), `brokers/marketDataLane.js`
  (`TickRateCounter(windowSeconds)`, `MARKET_DATA_LANES`).
- Pins: two coordinators with separate recording transports never cross-emit; `.lane` is `"futures"`/`"box"`; a token in
  both lanes is refcounted per lane; within a lane only the 0→1 transition subscribes and last release unsubscribes;
  `resetForBrokerSwitch()` per lane returns `{droppedTokens}`; `activeTokens()` per lane for reconnect replay;
  `MARKET_DATA_LANES` is exactly `["futures","box"]`; `stats().lane/tokens`; `TickRateCounter.mark(n, at)` for 300k marks keeps
  `JSON.stringify(counter).length < 2000` and a finite `perSecond(now)`; 3000-token window moved by 500 subscribes exactly 500.
- Keep the lane id string `"box"` (it is the Synthetic lane in Go; it appears in diagnostics JSON). The `JSON.stringify` size
  check has no Go analogue: assert the ring buffer length is fixed instead.

### 4.12 `marketDataTransport.test.mjs` (293 lines, 26/26) — FAKE(clock)
- dist: `marketDataSession.js` (`MarketDataSessionStore({now, ttlMs, maxSessions})`, `parseTokenList(v, limit?)`,
  `MAX_SESSION_TOKENS=4000`), `brokers/subscriptions.js`.
- `parseTokenList` (6): 816 tokens ok; dedupe preserving order; rejects 0, -1, 1.5, NaN, Infinity, numeric strings, null,
  objects, non-array, `{}`, `[]`, and `MAX+1` with `/Too many tokens/`; ≥2000 allowed.
- Store (14): `create(tokens, broker, generation)→{id,tokens}`; `resolve(id, broker, gen)→{ok,session}|{ok:false, reason:
  "not_found"|"stale_generation"}`; ids `^[0-9a-f]{32}$`, 50 unique; `/api/stream/session/<id>` < 100 bytes; repeated
  resolves allowed (EventSource reconnect); `open(id)` pins against `sweep()`; idle session reaped after `ttlMs` (60 s
  boundary: 30 s no, 61 s yes); closing one of two connections keeps it; different generation or broker ⇒ `stale_generation`
  and the session is deleted; `dropAll()` returns count; `maxSessions:10` cap; eviction never removes an open session;
  `stats() {sessions, connections, tokens}`. Defaults: `MAX_SESSIONS=500`, `DEFAULT_TTL_MS=300000` (`marketDataSession.ts:36,45`).
- Coordinator (6): overlapping browser leases subscribe once; release keeps shared tokens; triple release is harmless;
  browser lease does not disturb `scanner` tokens (`countsFor(11).scanner===1`); `stats() {browser, tokens, leases}`.
- Storage: in-memory only today (not Redis). PLAN "PG for caching" — keep it in-process; a PG copy would break the
  open-connection pinning and the 128-bit unguessable id property is unchanged either way.

### 4.13 `shutdown.test.mjs` (266 lines, 15/15) — TIME
- dist: `shutdown.js` (`ShutdownCoordinator({steps:[{name,run}], timeoutMs?, log, now?})`, `shutdownExitCode(result)`).
- Pins: concurrent `run()` calls run each step once and return the **same result object**; re-run after completion is a
  no-op; `inProgress` true synchronously after `run()` and stays true; strict declared order (sample names include
  `disable-box-entries`, `box-engine-dispose` — rename in Go, order property only); async steps awaited; a throwing or
  rejecting step does not stop later ones (`completed`, `failed[{step,error}]`, non-Error throw recorded as the string);
  hung step with `timeoutMs:40` ⇒ `timedOut:true`, exit code 1; timeout log line contains `TIMED OUT`, the unfinished step
  names and `NO trading state has been altered or invented`; finishing inside 500 ms ⇒ exit 0; failures alone ⇒ exit 0;
  `result.signal`, `durationMs>=0`; empty list ⇒ clean.
- Real timers (25/40/5/500 ms). Go: `context.WithTimeout`; abandoned hung step goroutine is acceptable (process exits).
- Result identity across callers → Go returns the same `*Result` (via `sync.Once`).

### 4.14 `singleBroker.test.mjs` (393 lines, 13/23) — FAKE env
- dist: `brokers/registry.js`. Fakes: kite `{getAccessToken, getApiKey, getQuoteFull, getBasketMargin}`, hub recording
  `kite:subscribe|unsubscribe|stop` events; probe `{scannerRunning, openPositionCount, brokersWithOpenPositions,
  workingOrderCount, executionInFlight, reconciliationComplete, residualLegCount, unknownOrderCount, unresolvedIntentsFor}`;
  hooks `{stopScanner, invalidateBooks, reloadUniverse, publish}`; `m.attach(probe, hooks)`; env `DHAN_CLIENT_ID`,
  `DHAN_API_KEY`, `DHAN_API_SECRET`, `DHAN_STATIC_IP_EXPECTED` via `withDhanEnv`/`restore`.
- Kept (12): default `zerodha`; missing `DHAN_API_KEY` ⇒ `dhanCredentials() {ok:false, reason:/DHAN_API_KEY/}`; missing
  secret ⇒ blocker `broker_not_configured`; no-exposure switch ⇒ `{ok:true}`, active dhan; re-selecting current broker is a
  no-op success with no `kite:stop`/`invalidateBooks`; Zerodha active ⇒ subscriptions go to the hub; Dhan active ⇒ no
  `kite:*` events; Zerodha health `static_ip_configured:null`, `authenticated:true`, `trading_ready:true`; Dhan without session
  not data/trading ready with a `/not connected/i` problem; missing static IP ⇒ `dhanStaticIpReady()===false` and
  `/Static IP not configured/`; session never derived from admin auth (`getAccessToken→null` ⇒ not authenticated, not data ready);
  `snapshot() {broker, session.broker, health.broker, dhan_configured:boolean}`.
- Adapt (1): "safe switch tears down the old broker first" — Go has no `stopScanner` hook; assert
  `kite:stop < invalidateBooks < reloadUniverse` only.
- Drop (10): the 8 refusal cases (`scanner_running`, `open_box_positions`, `working_orders`, `execution_in_flight`,
  `unresolved_reconciliation`, `residual_exposure`, `unknown_order_state`, `foreign_unresolved_intents`), "ALL blockers at once"
  (needs ≥3 Box blockers), and `createLiveAdapter REFUSES …`. In Go the exposure probe is a constant idle value
  (PLAN); add one Go case asserting `switchBlockers` returns only `broker_not_configured` when Dhan creds are missing.

### 4.15 `subscriptionCoordinator.test.mjs` (179 lines, 14/14) — FAKE
- dist: `brokers/subscriptions.js`. Transport records sorted token arrays per call.
- Pins: first acquire subscribes once; overlapping browser leases send only new tokens; release of one lease keeps shared
  tokens; last release unsubscribes the rest; a `strategy` token survives a browser disconnect; `countsFor(t)
  {browser, strategy, total}` and `null` when unknown; repeated token in one lease counts once; double release harmless;
  `setOwnerTokens` diffs (only abandoned/new tokens move) and does not disturb other owners;
  `resetForBrokerSwitch()` ⇒ `{droppedTokens:4}`, **no** upstream unsubscribe, `size 0`; clean resubscribe after reset;
  `stats() {browser, scanner, tokens}`; invalid tokens (0, -1, NaN) ignored.
- Owners are the fixed union `browser|scanner|strategy|analytics` (`subscriptions.ts:34`); keep all four in Go so
  `stats()` JSON keys stay identical.

### 4.16 `tickerHubLifecycle.test.mjs` (91 lines, 1/1) — FAKE(WebSocket)
- dist: `hub.js` (`new TickerHub(getCreds→{apiKey, accessToken}, onDead)`).
- Seam: replaces `globalThis.WebSocket` with `FakeWebSocket` (static `instances`, `send`, `open/close/error`, `tick(token,
  price)` writes a Kite big-endian frame `i16 count=1, i16 len=8, u32 token, u32 price·100`).
- Pins: `addConnectionListener` replays the current state (`[false]`); socket 1 open/close toggles `isConnected`;
  `subscribeTokens([202])` after close opens socket 2; states `[false,true,false,true]`; ticks/errors/close from the
  superseded socket 1 are ignored (no ticks, `onDead` not called, still connected); removed listeners get nothing.
- Go: `TickerHub` must take a `Dialer` interface; generation counter per socket; restore is per test (no global).

### 4.17 `tokenRouteAuth.test.mjs` (104 lines, 12/12) — PURE
- dist: `tokenRouteAuth.js` (`checkTokenPasscode(configured, provided)→"ok"|"forbidden"|"not_configured"`,
  `readPasscode(header, query)`).
- Pins: unset/blank/whitespace secret ⇒ `not_configured` (even for empty-vs-empty); non-string/empty provided ⇒ `forbidden`;
  exact match `ok`; configured trimmed, provided not; near misses refused; 5000-char length mismatch does not throw
  (hash-then-`timingSafeEqual`); header beats query; header array ⇒ first element; non-string query (array/object) ⇒ undefined.
- Go: `sha256` both sides + `subtle.ConstantTimeCompare`; header from `r.Header.Values()[0]`; query only if exactly one value
  (`?passcode=a&passcode=b` must be ignored, i.e. `len(q["passcode"])==1`).

### 4.18 `trackedTimers.test.mjs` (58 lines, 4/4) — TIME
- dist: `trackedTimers.js` (`trackInterval(name, handle)→handle`, `clearTrackedIntervals()→names[]`, `trackedIntervalCount()`).
- Pins: passthrough handle; clear returns names in registration order, stops timers (1 ms intervals, 20 ms wait, 0 fires);
  double clear returns `[]`; empty clear `[]`.
- Module-level registry: cases depend on starting empty (each case clears). Go: a `Registry` value owned by the app
  (`*time.Ticker` + stop), test creates its own. Production names: `redis-flush-retry`, `option-oi-capture` (`index.ts:705,5169`),
  `eod-capture` (`eodCapture.ts:653`), `hourly-capture`, `day-review` (`hourlyCapture.ts:341,737`); the Redis one becomes a
  PG cache flush (or disappears if PG writes are synchronous).

### 4.19 `math.test.mjs` (787 lines) — partial: 4/37 kept, PURE
- dist: `box/math.js` (19 named imports), `box/types.js`, `box/config.js`, `./helpers.mjs` (`chain, GOOD_BOX, LOT, …`).
- Kept cases (lines 50-90):
  1. "the monitored window is the ATM strike plus three either side": `chain({first:19700, step:100, count:11})`,
     `selectStrikeWindow(strikes, 20120, 3)` ⇒ `atm 20100`, `window [19800 … 20400]` (7), 3 below / 3 above.
  2. "never more than seven strikes": counts 7/11/41/200 with spot at the middle strike ⇒ window length exactly 7; a
     5-strike chain with spot at the first strike ⇒ length ≤ 7 and `window[0] === strikes[0]` (truncates, never reaches further).
  3. "ATM is the strike closest to spot …": `atmStrikeFor([100,200,300], 260)=300`, `(…,240)=200`, `([],100)=null`;
     `strikeStepOf([19700,19800,19900,20000])=100`, `strikeStepOf([100])=0` (median gap). `atmStrikeFor` is not in the PLAN
     keep-list but `selectStrikeWindow` calls it (`math.ts:275`); keep it (exported or package-internal).
  4. "re-centres only once spot clears the hysteresis band": `shouldRecentreWindow(20000, 20060, 100, .15)=false`,
     `20070 → true`, `19930 → true`, step 0 ⇒ false (`|spot−atm| > step·(0.5+hysteresis)`, strict, `math.ts:291-300`).
- `chain()` here only needs `.strikes` (`first + i·step`); the Go test should generate strikes inline (helpers.mjs pulls in
  `loadBoxConfig` and `buildCandidates`, both dropped).
- Dropped: the other 33 (candidates, pricing, qualification, exit rules, indicative edge) — all Box.

### 4.20 `migrationFixtures.test.mjs` (250 lines) + `migration-fixtures/box/charges.json` (324 lines) — partial, PURE golden
- Test structure: 2 static cases ("every fixture file has a replay mapping", "at least the expected coverage exists"
  listing 8 files) + one generated case per `box/*.json` file (`${file}: N case(s) match`). Kept: the `charges.json`
  replay only. Re-express the two static cases as "`charges.json` exists and has ≥1 case" (after the other 7 Box fixture
  files are deleted, the 8-file list would fail).
- Replay (`REPLAY["charges.json"]`): case name starting `four-leg` ⇒ `stripAt(calculateBoxCharges(orders, rates, "kite",
  "local", FIXED_AT))`; otherwise `calculateRoundTrip(orders, rates, FIXED_AT)` projected to `{entry: stripAt(entry),
  estimated_exit: stripAt(estimated_exit), entry_total, estimated_exit_total}`. `FIXED_AT = 2026-09-03T10:00:00.000Z`; `at` is
  removed before comparing. Comparison: `assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected)` —
  **exact equality, no tolerance**, key order irrelevant, missing/extra keys fail.
- File schema: `{category:"charges", operation:"calculateBoxCharges / calculateRoundTrip", description, generated_from:
  "TypeScript reference implementation (src/box)", cases:[{name, input:{orders, rates}, expected}]}`.
  - `orders[]`: `{side:"BUY"|"SELL", tradingsymbol, price, quantity}` — 4 NIFTY legs, qty 50:
    BUY 25000CE @260.5, SELL 25200CE @130, BUY 25200PE @95.5, SELL 25000PE @30.
  - `rates`: all 12 fields explicit — `brokeragePerOrder 20, brokerageMaxPct 0, sttSellPct 0.15, sttRoundNearestRupee true,
    exchangeTxnPct 0.03503, ipftPerCrore 50, ipftPct 0, sebiPct 0.0001, stampDutyBuyPct 0.003, gstPct 18, sttType "stt",
    rateVersion "zerodha-nse-options-2026-04-01"` (= shipped `loadBoxChargeRates` defaults, written out, not read from env).
  - `expected` group: `{legs[], value, brokerage, stt, exchange_txn, sebi, stamp_duty, gst, total, source, computed_by}`;
    leg: `{side, tradingsymbol, quantity, price, value, brokerage, stt, stt_type, exchange_txn, sebi, stamp_duty, gst, total}`.
  - Case 1 `four-leg long-box entry charges`: totals value 25800, brokerage 80, stt 12, exchange 9.17, sebi 0.02, stamp 0.53,
    gst 16.06, total 117.78, `source:"kite"`, `computed_by:"local"`.
  - Case 2 `round trip: entry plus the reversed estimated exit`: entry as case 1; exit legs sides reversed at entry prices,
    stt 27, stamp 0.25, total 132.5, `source:"kite_estimate"`; `entry_total 117.78`, `estimated_exit_total 132.5`.
- Generation (`generate.mjs`, run manually after `npm run build`: `node tests/migration-fixtures/generate.mjs`): imports
  `calculateBoxCharges, calculateRoundTrip` from `dist/box/localCharges.js`, a hard-coded `RATES` object and `entryOrders`,
  `chargesSummary(c)` drops `at` and copies legs; `fixture()` registers files; writes `box/<file>` with
  `JSON.stringify(body, null, 2) + "\n"` and prints case counts. It always regenerates all 8 Box files together; the header
  says regeneration is deliberate (changed output = changed behaviour).
- Go port: the replay needs `calculateBoxCharges` + `reverseOrders` + `calculateRoundTrip` (not only `calculateLegCharges`).
  Rounding must match `Math.round(v*100)/100` and `Math.round(x)` (half toward +∞; inputs here are positive so
  `math.Floor(x+0.5)` with the V8 tie fix in `analytics.md §0.1` suffices). JSON numbers: `130`, `30`, `0` stay integers in
  the file; decode expected into `float64` and compare numerically, strings exactly.
- Keep the file path or move it to `testdata/charges.json`; record the Node commit it came from.

### 4.21 `config.test.mjs` (237 lines) — partial: 0/16 kept
All 16 cases test `loadBoxConfig()` Box keys (`BOX_EXECUTION_MODE`, `BOX_LIVE_TRADING_ENABLED`, charge-reconcile retry,
`BOX_PAPER_*`, `BOX_EXECUTION_TIMING_*`, `BOX_DEPLOYMENT_REGION`/`BOX_EXECUTION_CALIBRATION_REGION`). No case reads
`BOX_DEDICATED_MARKET_FEED`, `BOX_MAX_SUBSCRIBED_TOKENS` or any charge-rate env. Grep of all `tests/` for
`BOX_DEDICATED_MARKET_FEED|BOX_MAX_SUBSCRIBED_TOKENS|SYNTH_` returns nothing. Drop the file; the Synthetic lane budget
(`BOX_DEDICATED_MARKET_FEED` default true ? `BOX_MAX_SUBSCRIBED_TOKENS` default 2200 : 0, under `SYNTH_SHARE_BOX_BUDGET`) has
**no test** today.

### 4.22 `depthReadiness.test.mjs` (272 lines) — grep-found: 7 kept + 1 partial / 11, PURE
- dist: `box/quotes.js` (kept), `brokers/dhan/feed.js` (`toTick(state, depthUpdated)`), `ticker.js` (`parseBinary`), plus
  dropped `box/engine.js`, `box/executionGateway.js`, `box/orderPricing.js`.
- Kept (7): (1) first LTP-only tick (`depth_updated:false`) creates no book: `applyTicks→[]`, `get→undefined`,
  `updateCount 0`, no listener call, `diagnostics().depthless_ignored 1`; (2) LTP-only after a book does not change the stored
  object (`strictEqual`), `at`, or notify; (3) Dhan `toTick(state,true|false)` ⇒ `depth_updated` true/false and the partial does
  not bump `version`/`at`; (4) authoritative empty depth deletes the book, returns `[101]`, notifies `{tokens:[101], at:2000}`,
  `empty_invalidations 1`; (5) legacy ticks without `depth_updated` but with ladders are authoritative; malformed levels
  (Inf/NaN price, NaN/fractional/0/negative qty) dropped, `malformed_levels_dropped 6`; (7) `invalidateGeneration()` then an
  LTP tick ⇒ `size 0`, `lastUpdateAt null`, diagnostics deep-equal `{authoritative_observations:1, usable_book_updates:1,
  depthless_ignored:1, empty_invalidations:0, malformed_levels_dropped:0, generation_invalidations:1, ready_books:0}` (key set
  and values exact); (8) Kite `parseBinary` packets of 8/44/184 bytes ⇒ `depth_updated` false/false/true, empty ladders for
  zero levels (`kitePacket` builder, big-endian).
- Partial (6) "one-sided books": keep the store half (bid-only book stored with `bids [99.9×75]`, `asks []`); drop the
  `touchPrice`/`walkDepth` assertions (Box `orderPricing`).
- Drop (3): `walkDepth/touchPrice` malformed levels; `checkedFeedBlockReason` queued feed stamp (Box gateway);
  `BoxEngine` reconnect harness.
- This file plus §4.6's last case and §4.23 are the **only** tests of the kept quote store.

### 4.23 `serialize.test.mjs` (291 lines) — grep-found: 4/10, PURE
- Kept: (a) `applyTicks([tick], 5000)` ⇒ `[42]`, `get(42) {at:5000, bid:100, ask_qty:75, source:"ws"}`, `isFresh(42,1500,6000)`
  true, at 6600 false, unknown token false; (b) a depthless tick (`bid:0, ask:0`, no ladders) at 9000 returns `[]` and keeps
  `at 1000`, so `isFresh(7,1500,9000)` is false; (c) `store.applyLadder === undefined` (REST ladders are not an execution
  source), `version>0`, `forget([11])` removes; (d) `SpotStore.set(1, 20050, 1000)`, `get → {value, at}`,
  `isFresh(1, 10000, 5000)` true / at 20000 false, `set(1, 0, …)` ignored.
- Dropped (6): `serializeBoxTrade`, `tradeKey`, `toEventLegs`, `configSnapshot`, `clampStrikeLevel` cases.
- Go: (c)'s "no applyLadder method" is a type-level property — no runtime test needed.

### 4.24 Dropped files that import kept modules
- `dhanAdapter.test.mjs` (453 lines, 36 cases): 11 cases test `brokers/dhan/correlation.js` (`dhanCorrelationId`,
  `isValidDhanCorrelationId`, `DHAN_CORRELATION_MAX_LENGTH=30`), 25 test `DhanBrokerAdapter`. Correlation ids are used
  only by Dhan order placement (`/api/dhan/postback` merely logs `body.correlationId`), so both go with live orders.
  `DhanNetworkError/DhanError` are already covered by `dhanSupport`.
- `executionAttemptProjection`, `fillAttribution`, `mongoReservationIntegration` (import `dist/db.js`) and
  `tests/integration/mongoOrderIntentCas.test.mjs`: Box persistence; dropped with the 14 `box_*` collections.
- Everything else in `tests/box/` (65 of the 92 `*.test.mjs` files) and `tests/migration-fixtures/box-parity/*`, `generate-parity.mjs`,
  and the other 7 `migration-fixtures/box/*.json` files: Box only.

## 5. Cross-cutting notes for the Go suites

### 5.1 Mongo/Redis assumptions to re-express for PostgreSQL
| Where | Today | Go/PG |
|---|---|---|
| `fairValue/storage` | `MongoFairValueStore.enabled()` = `isDbEnabled()` (no `MONGODB_URI` in tests ⇒ memory-only) | PG store constructed without a pool ⇒ same five results; message keeps `memory-only` |
| `fairValue/fixtures.memoryStore` | `append(snapshot,input,limit)` keeps newest `limit` (unshift+splice); real store also takes `retentionDays` and prunes | PG `fair_value_snapshots` insert + prune to `limit` per underlying and by age; `history()` returns `historySummary` rows (no `rows` in slices) newest first |
| `adminToken` | token used as Mongo `_id` of the admin session | PG text primary key; same alphabet means no escaping in SQL params either |
| `brokerIdentity.brokerOf` | legacy Mongo docs lack `broker` | nullable `broker` column read through `brokerOf` |
| `dhanSupport.redactedSession` | input = `dhan_sessions` Mongo doc (`login_at: Date`) | PG row → same struct; access token column never serialised |
| `trackedTimers` | guards the Redis flush retry interval against write-after-close | PG cache writer stopped before pool close (shutdown step order) |
| `marketDataTransport`, `boundedCache`, `SnapshotHistory`, quote store | in-process memory, not Redis | stay in-process (bounded memory, liveness pinning); PLAN's "PG for caching" applies to the analytics Redis keys, not these |
| `shutdown` sample step `close-databases` last | Mongo connections | `pgxpool.Close()` last |
No kept test exercises a real database, a Redis key, a TTL index or a Mongo query operator.

### 5.2 Flaky / order-dependent / environment-dependent parts
- Real-time waits: `shutdown` (5/25/40/500 ms), `trackedTimers` (1 ms intervals, 20 ms wait), `pipeline` (5 ms race, 20 ms
  worker timeout, `setTimeout(…,2)`), `hardening` revocation busy-wait (1 ms polls), `auth` SSE (10 ms interval, unbounded read).
- `Date.now()`-relative fixtures: `dhanBoardJoin` (all expiries), `dhanSupport` (2 cases), `dhanActiveNoKite` (`loginAt`).
- Module singletons: `getDhanParseReport()` (last parse), `trackedTimers` registry, `globalThis.WebSocket` + `FakeWebSocket.instances`.
- Env mutation (sequential only): `singleBroker` (`DHAN_CLIENT_ID/API_KEY/API_SECRET/STATIC_IP_EXPECTED`), `dhanMarginAndIp`
  (`DHAN_STATIC_IP_EXPECTED/STATIC_PUBLIC_IP/LIVE_TRADING_ENABLED`), `localCharges` (`BOX_IPFT_PER_CRORE`, `BOX_STT_SELL_PCT`).
  In Go use `t.Setenv` (no `t.Parallel` in those tests) or an injected getenv.
- Ambient env leakage: `singleBroker` "default broker"/"health" cases and `dhanMarginAndIp` assume no `DHAN_*` vars in the
  developer shell (only some keys are cleared). Go tests should clear every `DHAN_*`/`BOX_*` key they read.
- Probabilistic: `adminToken` (collision/alphabet/suffix), `marketDataTransport` (50 unique session ids).
- Private-state poking (must become explicit Go seams): `dhanActiveNoKite`, `dhanMarginAndIp` (`defineProperty` on
  `active`, `dhanAccessToken`, `dhanTokenExpiry`, `dhanSessionMeta`, `dhanFeed`; patched `dhanInstrumentStore`, `m.dhan.*`),
  `dhanFeedDecoder` (`feed.wanted`, `feed.handleFrame`).
- Rate limiter in `service.test` uses wall clock and a per-registration bucket map (8 of 30 calls used).
- Not TZ-sensitive: FV uses offset ISO; Dhan candle formatting uses UTC getters on epoch+5h30.

## 6. Coverage map (kept subsystems → covering tests)
`NONE` = no Node test at all; the Go tests must be written from the Node source (and, where noted, golden output captured
from Node first). "partial" = some behaviour pinned, the rest open.

| Subsystem (source) | Covering tests | Gap |
|---|---|---|
| Admin token generation (`adminToken.ts`) | adminToken (7) | — |
| Admin login/session/status routes, `requireAdmin`/`requireFullAdmin`, `getAdminRole`, session store (`index.ts` ~1386, Mongo sessions) | FV `auth`/`hardening` cover only the FV router guard with fake roles | **NONE** for login, session expiry, trade vs full role, `/api/admin/*` |
| Curl token routes passcode (`tokenRouteAuth.ts`) | tokenRouteAuth (12) | route wiring (`/api/kite/access-token`, `/api/dhan/access-token`): **NONE** |
| Rate limiter (`ratelimit.ts`, fixed window per IP, `X-Forwarded-For` first hop, `Retry-After`) | indirectly constructed by FV routes, never exceeded | **NONE** |
| Bounded quote cache (`boundedCache.ts`) | boundedCache (9) | its use in `POST /api/quotes`: NONE |
| Tracked timers (`trackedTimers.ts`) | trackedTimers (4) | — |
| Shutdown (`shutdown.ts`) | shutdown (15) | the real step list/order in `index.ts`: NONE |
| Kite REST (`kite.ts` `KiteClient`: instruments CSV, quote/ohlc/depth/ladder, historical, basket margin) | only as forbidden/stub fakes (dhanActiveNoKite, singleBroker, dhanMarginAndIp `kite_basket`) | **NONE** (request shapes, CSV parse, chunking, errors) |
| Kite login/token persistence (`index.ts`, `/login`, `/api/kite/*`) | — | **NONE** |
| Kite ticker (`ticker.ts`: `parseBinary`, socket) | depthReadiness (packet provenance 8/44/184 B), tickerHubLifecycle (LTP frame) | partial: quote/full field offsets, index packets, subscribe/mode messages, reconnect: NONE |
| `ZerodhaFeed` lane socket (`brokers/zerodha/feed.ts`) | — | **NONE** |
| `TickerHub` (`hub.ts`) | tickerHubLifecycle (1), hardening `retainFanout` (1) | partial: tick cache/seed, `ingestExternalTicks`, SSE client attach, `onDead` path |
| Dhan auth (`dhan/auth.ts`) | dhanSupport (5: expiry, redaction) | consent/login flow, session persistence/load: **NONE** |
| Dhan HTTP transport (`dhan/http.ts` `DhanHttp`: hosts, headers, retry, pacing) | — | **NONE** (errors classification only, via dhanSupport) |
| Dhan errors (`dhan/errors.ts`) | dhanSupport (4) | — |
| Dhan REST client (`dhan/client.ts`) | dhanMarginAndIp (multi-margin body, payload helpers) | `marketFeedQuote`, `calculateMargin`, `getStaticIp`, historical, fund endpoints wire shapes: NONE |
| Dhan margins (registry `margins().basketMargin`) | dhanMarginAndIp (13) | — |
| Dhan feed decoder (`dhan/feedDecoder.ts`) | dhanFeedDecoder (17) | — |
| `DhanFeed` socket (`dhan/feed.ts`) | dhanFeedDecoder (`handleFrame`, `toTick`), depthReadiness (`toTick`) | subscribe batching, auth URL, reconnect, generation, disconnect codes: **NONE** |
| Dhan instruments (`dhan/instruments.ts`) | dhanBoardJoin (18), dhanSupport (17) | `DhanInstrumentStore` download/TTL/`identify`: NONE |
| Dhan segments (`dhan/segments.ts`) | dhanSupport (5) | — |
| Broker types (`brokers/types.ts`) | brokerIdentity (7) | — |
| Registry / broker switch (`brokers/registry.ts`) | singleBroker (13), dhanActiveNoKite (15), dhanMarginAndIp (26 registry-level) | lane wiring (`setSyntheticTokens`, box-lane feeds, `laneStats`), `stopFeeds`, session-lost handling, reconnect replay: NONE |
| Instrument / quote providers, feed health | dhanActiveNoKite | Zerodha-active paths: NONE |
| History provider (`brokers/history.ts`) | dhanSupport (6: transpose, chunk) | provider routing per broker, Kite path: NONE |
| Subscriptions (`brokers/subscriptions.ts`) | subscriptionCoordinator (14), marketDataLanes (8), marketDataTransport (6), hardening (yield) | — |
| Lanes (`brokers/marketDataLane.ts`) | marketDataLanes (`MARKET_DATA_LANES`, `TickRateCounter`) | Synthetic lane budget env (`BOX_DEDICATED_MARKET_FEED`/`BOX_MAX_SUBSCRIBED_TOKENS`/`SYNTH_SHARE_BOX_BUDGET`): **NONE** |
| Market-data sessions (`marketDataSession.ts`) | marketDataTransport (20) | — |
| Market-data routes + SSE (`marketDataRoutes.ts`: `/api/quotes`, `/api/stream`, `/api/stream/session/:id`, feed status) | — | **NONE** at HTTP/SSE level (frame format, heartbeats, lease release on close, 414-avoidance flow) |
| Index spot (`indexSpot.ts`) | indexSpot (10) | — |
| Board (`deriveFnoBoard`, `index.ts:3237`; board/instrument routes) | dhanBoardJoin/indexSpot test `diagnoseBoard`, a **separate** re-implementation in `boardDiagnostics.ts` | production board builder: **NONE** |
| Analytics frames/snapshots/backfill + Redis write-through caches (`index.ts:493-1043`, `redis.ts`) | — | **NONE** |
| EOD capture (`eodCapture.ts`) | — | **NONE** |
| Hourly capture / day review (`hourlyCapture.ts`) | — | **NONE** |
| Calendar trades + ledger + charges (`index.ts:2625 priceChargeGroups`, `/api/trades*` 2716-3189) | — | **NONE** |
| Risk-free rate routes, Yahoo dividend yields (`yahoo.ts`), health/runtime status | — | **NONE** |
| Broker panel routes (`brokers/routes.ts`, 12 routes incl. Dhan login, postback, static IP, access token) | — | **NONE** at HTTP level |
| Synthetic config (`synthetic/config.ts`, incl. its futures rate card) | — | **NONE** |
| Synthetic math (`synthetic/math.ts`, 26 exports) | only its imported Box helpers: math (4 strike-window cases), localCharges | Synthetic's own formulas: **NONE** |
| Synthetic engine / repository / routes / SSE | — | **NONE** |
| Fair Value normal/black/iv | pricing (7), hardening (1) | — |
| FV svi/optimizer/smile/validation | svi (5), pipeline (1), maturity | optimizer only indirect |
| FV curve/quotes/forward/metadata | market (6), hardening (1) | — |
| FV maturity/calculator/sensitivity/independent | maturity (5), independent (3), service | — |
| FV pipeline | pipeline (2), hardening (1), maturity, independent | — |
| FV history (`SnapshotHistory`) | hardening (1), service (via engine) | — |
| FV engine + workers (real worker threads run `worker.ts`) | hardening (1), pipeline (3), service (1) | — |
| FV config (`defaultConfig(env)`, `mergeConfig`, `configVersion`) | hardening (1), fixtures | `FAIR_VALUE_*` env parsing: NONE |
| FV store (`store.ts`) | storage (1, unconfigured only) | real persistence (save/load config, append+prune, history, snapshot): **NONE** |
| FV routes + SSE | auth (1), service (1), hardening (1) | 404 paths, `limit` clamp, export headers: partial |
| Quote store (`box/quotes.ts` `BoxQuoteStore`, `SpotStore`) | depthReadiness (7½), serialize (4), dhanFeedDecoder (1) | listener/version edge cases beyond these: partial |
| Rate card (`box/localCharges.ts`) | localCharges (11), charges.json (2 golden) | — |
| Strike-window math (`box/math.ts` trio) | math (4) | — |
| PostgreSQL store/migrations/PG cache with TTL (new) | — | **NONE** (new code; no Node equivalent test) |

Kept-feature HTTP routes with any HTTP-level test: the 13 Fair Value routes only. Of ~83 non-Box routes, ~70 have none.

## 7. Proposed Go porting order (pure → DB/HTTP) and the seams each stage needs
Every stage runs `go test -race ./...`. Golden files live in `testdata/`; Node-generated goldens are captured once from
`1ea1d95` after `npm run build` (never hand-edited).

0. **Test kit** (before any port): `internal/testkit` with a manual clock (`Clock{Now() time.Time}` + `Advance`), JSON
   golden loader with numeric compare, JS-compatible `Round` / `Round2` / number formatting (`analytics.md §0.1`), env
   helper (`Getenv func(string) string`), byte-frame builders (Dhan LE, Kite BE), `httptest` SSE reader with deadline.
1. **Pure leaf functions** (no seams beyond inputs):
   - rate card `charges`: `LoadChargeRates(getenv)`, `LegCharges`, `GroupCharges`, `ReverseOrders`, `RoundTrip`, `RoundSTT`,
     `IPFTFor` ← localCharges (11) + `charges.json` (2).
   - strike window `strikes`: `ATMStrikeFor`, `StrikeStepOf`, `SelectStrikeWindow`, `ShouldRecentreWindow` ← math (4).
   - `adminToken`, `tokenRouteAuth`, `brokers/types`, `indexSpot`, `boardDiagnostics` ← 7+12+7+10+(board parts).
   - Dhan pure: `segments`, `instruments` parser (`Parse(csv, now) (rows, report)`), `errors`, `auth` helpers, history
     transforms (`CandlesToRows`, `ChunkDateRange`), `feedDecoder`, `client` payload helpers ← dhanSupport, dhanBoardJoin,
     dhanFeedDecoder (17 pure), dhanMarginAndIp (14 pure).
   - Kite `ParseBinary` ← depthReadiness (1) (+ new golden for quote/full offsets).
   - `feedHealth.Compute`, `TickRateCounter`, `ParseTokenList`.
   - Fair Value math in dependency order: normal → black → iv → svi → optimizer → smile/validation → curve → quotes →
     forward → metadata → maturity → sensitivity → pipeline → independent → calculator ← pricing, svi, market, maturity,
     independent, pipeline (2), hardening (3). Seam: `Config` passed explicitly; `now` as a value.
2. **Stateful in-memory with an injected clock**: `BoundedTTLCache(clock)`, `SessionStore(clock, ttl, max)`,
   `SubscriptionCoordinator(transport Transport{Subscribe([]int), Unsubscribe([]int)}, lane)` with `SetAnalyticsYield`,
   `QuoteStore`/`SpotStore` (+ `Subscribe(listener)`), `SnapshotHistory(maxBytes, maxUnderlyings, clock)`,
   `ShutdownCoordinator(steps, timeout, log, clock)`, timer `Registry`, `RateLimiter(window, max, clock)` (new test).
3. **Transports behind fakes**:
   - `TickerHub(creds func() Creds, onDead func(), dial Dialer)`; `Dialer.Dial(url) (Conn, error)`; `Conn{Send, Close,
     events}` ← tickerHubLifecycle, hardening `retainFanout`.
   - `DhanFeed(opts{AccessToken, ClientID, OnTicks, OnConnection, OnSessionLost, Resolve, DepthLevel}, dial Dialer)` with
     package-level `handleFrame` test ← dhanFeedDecoder (last case); add reconnect/subscribe-batch tests from source.
   - `DhanClient(http Reader{Read(ctx, ReadOpts) (json.RawMessage, error)}, clientID func() string)` ← wire contract (4).
   - `DhanHTTP(baseURL, doer HTTPDoer, clock)`, `KiteClient(baseURL, doer)`: `httptest.Server` fakes (new tests; no Node test).
   - Registry `ActiveBrokerManager(Options{Kite KiteMarketData, Hub TickerHub, Dhan DhanAPI, DhanInstruments InstrumentStore,
     DhanFeedFactory, ISTDayKey func() string, Getenv, OnDhanTicks, OnDhanConnection, OnSessionLost, InitialState})`
     where `KiteMarketData{AccessToken() string; APIKey(); QuoteFull(ctx, ids); BasketMargin(ctx, orders); Instruments; Historical…}`
     and `DhanAPI{MarketFeedQuote, CalculateMultiMargin, CalculateMargin, GetStaticIP, …}`. Exposure probe = constant idle;
     `SwitchHooks{InvalidateBooks, ReloadUniverse(ctx), Publish}` ← singleBroker (13), dhanActiveNoKite (15), dhanMarginAndIp (26).
4. **Fair Value engine** with `EngineDeps{AllInstruments(ctx), Board(ctx), MetadataVersion, ActiveBroker, BrokerGeneration,
   DataReady, Switching, SetTokens([]int), TokenBudget, RetainFeed() func(), FeedStatus, Store FVStore, Config, Now,
   Workers Pool}`; `Pool{Surface(ctx, input) (Surface, error); Stats(); Close()}` with per-job timeout ←
   hardening (1), pipeline (3), service (engine half).
5. **PostgreSQL** (real local PG, schema per test or `TRUNCATE` between tests; `-race`): store interfaces with the exact
   method sets the services call, e.g. `FVStore{Enabled() bool; LoadConfig(ctx) (*Config, error); SaveConfig(ctx, cfg, version);
   Append(ctx, snapshot, input, limit, retentionDays); History(ctx, symbol, limit); Snapshot(ctx, symbol, id)}` ← storage (1,
   no-pool case) + new round-trip tests. Then admin sessions, broker sessions (Kite/Dhan), calendar trades + `trade_log`,
   analytics caches with TTL (replacing Redis keys), Synthetic repository, EOD/hourly capture tables, Mongo-export import tool.
   All new tests (no Node equivalent).
6. **HTTP/SSE** (`httptest.Server`, real handlers, fake engines/stores): FV routes ← auth (1), service (1), hardening role
   re-check (1); then market-data routes/SSE, broker panel routes, admin/Kite login routes, analytics/board/trades routes,
   Synthetic routes/SSE, `/api/box/*` ⇒ 404. All except FV are new; derive expected JSON from Node by recording responses of
   the Node service against fakes (golden) before the Node backend is removed.
7. **Captures/schedulers and Synthetic engine**: inject clock + `MarketCalendar` + broker fakes; goldens from Node runs
   on recorded tick tapes (Synthetic math first as pure goldens in stage 1 once written).

## 8. Shared test helpers and what they provide
| Helper | Provides | Used by (kept) | Go equivalent |
|---|---|---|---|
| `tests/fairValue/fixtures.mjs` | `NOW` (2026-10-01T06:00Z), `EXPIRY` (2026-11-17T10:00Z); `curve` (flat 5 %, `allow_flat_fallback`, convention `continuous_zero_act365f`); `expiryPolicy` (NFO 15:30 IST); `metadata(strike, side, token=strike·2+(PE?1:0), expiry)`; `quote(token, mid, overrides)` (±0.05, depth 1000, stamps NOW−100/−50, `source:'websocket'`); `clean(token, mid, overrides)` (cleaned-quote shape with `weight 1, h .05`); `chain(strikes, f=100, t=.5, d=.98, iv=.2)` → `{metadata, quotes, d}` at Black prices; `inputSnapshot({strikes=[80..120 step 5], expiries=[EXPIRY], iv=.3 or fn, configPatch})` → full `InputSnapshot` (tokens from 10, `exchange_token = token+1`, bid/ask ±0.001, spot 100, `broker:'zerodha'`, `config_version`); `memoryStore()` (in-memory FV store, `append` keeps `limit` newest) | all 10 FV files | `fvtest` package: same builders returning Go structs; `NewMemoryStore()` implementing `FVStore` |
| `tests/box/helpers.mjs` | only `chain({first, step, count})` → `.strikes` is needed | math (4) | inline `strikes(first, step, n)` |
| in-file `recorder()` (shutdown) | step factory recording call order | shutdown | slice-recording step funcs |
| in-file recording transports (`coordinator()`, `recordingTransport(label)` with `live()`, `recordingCoordinator()`) | subscribe/unsubscribe call capture, live-set reconstruction | subscriptionCoordinator, marketDataLanes, marketDataTransport, hardening | `fakeTransport{subs, unsubs [][]int}` + `Live()` |
| `at()` / `storeAt()` | stores with a mutable `now` and `advance(ms)` | boundedCache, marketDataTransport | `testkit.Clock` |
| `forbiddenKite()`, `forbiddenHub(state)`, `dhanActive()`, `dhanUniverse()` | Kite landmines, hub recorder, Dhan-active manager with patched store/client/feed | dhanActiveNoKite | `panicKite`, `recHub`, `NewRegistry(Options{InitialState: DhanActive(...)})` |
| `manager(overrides)`, `withDhanEnv`, `restore` | registry with stub kite/hub, idle probe, event-recording hooks; scoped Dhan env | singleBroker | `newTestRegistry(t, opts)` + `t.Setenv` |
| `recordingClient`, `marginManager`, `activateDhan`, `ipEnv`, `ipManager` | recording Dhan HTTP reader; registry with stubbed margin calls and seeded instruments; scoped IP env | dhanMarginAndIp | fake `Reader`, fake `DhanAPI`, `t.Setenv` |
| `packet()`, `fullPacket()`, `concat()` (Dhan LE), `kitePacket(len)` (Kite BE), `FakeWebSocket.tick()` | binary frame builders | dhanFeedDecoder, depthReadiness, tickerHubLifecycle | `testkit/frames` |
| `FakeWebSocket` (global swap) | controllable socket lifecycle + instance list | tickerHubLifecycle | `fakeDialer` returning `fakeConn`s |
| `masterWithDisplayNames()`, `isoDaysFromNow(d)` | Dhan scrip-master CSV with display names; now-relative expiries | dhanBoardJoin | same CSV text + injected `now` |
| `tick()`, `level()` (depthReadiness) | minimal tick and ladder level | depthReadiness | struct literals |
| `REPLAY`, `expectMatch`, `stripAt`, `FIXED_AT` (migrationFixtures) | golden replay + JSON-normalised deep compare | charges.json | `testkit.Golden(t, "charges.json", replayFn)` |
| `tests/migration-fixtures/generate.mjs` | regenerates `box/*.json` from `dist/` (deliberate act) | charges.json | keep as provenance; no Go generator (Go must *match*, not regenerate) |
