# Inventory: Box core (non-execution) — `src/box/`

Phase 0 inventory for task `2026-10-27-go-postgres-migration`. Scope: every file in `src/box/` except Box
EXECUTION (legExecutor, executionGateway, executionCoordinator, orderManager, executionSimulator, reservations/,
liveModeTransition, underlyingLock, tradingSession*, partialEntryRecovery, residualFlatten,
calibration/latency/queue files), which is inventoried separately. Line references are `file:line` in
`src/box/` at backend HEAD `1ea1d95` unless another path is given. Read-only survey; nothing was executed.

Sections:
1. Configuration (`config.ts`) — every env var
2. Domain types (`types.ts`), barrel (`index.ts`), serialisation, instrument keys, model schemas
3. Pure core: math, order pricing, positions, capital/margin, stress profile, invariants, submission order
4. Charges, quotes, liquidity ledger, scanner
5. Position monitor, partial-exit P&L, metrics
6. P&L cache/archive/snapshot, closed cache, shadow mode, paper scheduler/timeline, parity/paired comparison, live entry guard
7. Repository (`repository.ts`) and routes (`routes.ts`)
8. Engine (`engine.ts`) — full lifecycle
9. Other non-execution files not named in the brief (broker adapters, execution* helpers, instruments, orderLifecycle)
10. Intended behaviour from docs
11. Golden fixture coverage
12. Node single-thread assumptions → Go locking
13. Porting order, hardest parts, ambiguities


---

## 1. Configuration (`config.ts`, plus `localCharges.ts` rate card and `reservations/identity.ts`)

Verified by grep: the table below lists all 122 env names read by `config.ts` (no name in config.ts is missing),
plus 12 in `localCharges.ts` and 4 in `reservations/identity.ts` (identity is execution-owned but listed so the
env total is complete). No other file in `src/box/` reads the environment. Total distinct env vars: **138**
(120 `BOX_*` + `MIN_BOX_GROSS_EDGE`, `MIN_BOX_NET_EDGE` in config.ts; 12 `BOX_*` charge rates; 4 identity).


Repo root: /home/prakash/Work/projects/CAl/Cal_Spread_Backend. I read config.ts (1225 lines) in full. I grepped the rest of `src/box/` (excluding `*.test.ts`) for `process.env`, `env[...]`, `env.X` and quoted `"BOX_*"` names. The only other env readers are `src/box/localCharges.ts` and `src/box/reservations/identity.ts`. `BOX_DEPLOYMENT_REGION`, `BOX_EXECUTION_CALIBRATION_REGION` and `BOX_LEG_EXECUTION_MODE` are read inline in config.ts itself (lines 1013, 1014, 1056), not in other files. No indirect env helper is imported anywhere in src/box. All line numbers below are 1-indexed and refer to config.ts unless another file is named.

#### 1. Parser helpers (config.ts)

All helpers read `process.env[name]` when called. "Unset" always means `raw === undefined` OR `raw.trim() === ""`; both return the fallback.

- **num(name, fallback)**, lines 23-28: `v = Number(raw)` (JS Number semantics), then `Number.isFinite(v) ? v : fallback`.
  - No clamping, no rounding, and negatives are accepted. So counts like `maxConcurrentExecutions` can be 8.5 or -3.
  - JS Number quirks matter for Go parity:
    - Surrounding whitespace is OK.
    - "1e3", "+5", ".5" and "5." parse.
    - "0x1F", "0b11" and "0o7" parse as integers.
    - "Infinity" parses but is non-finite, so it gives the fallback.
    - "1_000", "12px" and "1,000" give NaN, so they give the fallback.
  - Go's `strconv.ParseFloat` rejects "0x10" (it needs a p exponent) and accepts "inf"/"nan", which then give the fallback via the finite check.
- **bool(name, fallback)**, lines 30-37: `trim().toLowerCase()`.
  - "1", "true", "yes" give true. "0", "false", "no" give false.
  - Anything else (for example "on", "off", "y", "enabled") silently gives the fallback, with no warning.
- **hours(name, fallback)**, lines 39-49: `split(",")`, then `Number(s.trim())`, then keep only `Number.isInteger(n) && 0≤n≤23`.
  - If nothing survives, it returns the fallback. Otherwise it de-duplicates and sorts ascending.
  - GOTCHA: an empty or blank segment gives `Number("") = 0`, which is a valid hour. "22,,23" gives [0,22,23] and "22," gives [0,22].
  - "22.0" is accepted as 22. "22.5" is dropped.
- **clampHour(v, fallback)**, lines 51-57: non-finite gives the fallback. Then `n = Math.round(v)`. If n is below 0 or above 23 it returns the FALLBACK (it does not clamp). So 23.6 rounds to 24 and becomes 21, 24 becomes 21, and -0.4 becomes -0 (effectively 0).
- **clampStrikeLevel(v)** (exported), lines 59-65: `n = Math.round(v)`.
  - n≤1 gives 1, n≥3 gives 3, otherwise 2.
  - GOTCHA: NaN gives 2, because both comparisons are false. That path can't happen from env (num already filtered it) but can happen via `engine.setStrikeLevel` (engine.ts:1190).
- **clampInt(name, fallback, min, max)**, lines 66-80: unset gives the fallback; non-finite gives the fallback. Otherwise `Math.min(max, Math.max(min, Math.round(v)))`.
  - The fallback is returned UNCLAMPED. This matters for computed defaults (see section 4).
  - The clamping is silent (no log).
  - `Math.round` rounds halves toward +∞. That matches Go `math.Round` for positive values. Every clampInt `min` is ≥0, so negative-half differences don't matter.
- **clampPct(name, fallback)**, lines 82-89: like clampInt but range [0,100] and NOT rounded (floats are kept).
- **queueModel(name, fallback)**, lines 91-99: trim+lowercase. "none" or "haircut" are accepted. Anything else logs `console.warn("[Box] ignoring unknown ${name}=\"${raw}\" — using ${fallback}.")` (raw untrimmed) and returns the fallback.
- **paperProfile(name, fallback)**, lines 118-125: trim+lowercase. Accepts "standard", "live_parity", "stress". Anything else warns with the same message format and returns the fallback.
- **latencyMode(name, fallback)**, lines 127-135: trim+lowercase. Accepts "constant" or "recorded_samples". Anything else warns with the same message and returns the fallback.
- **msSamples(name)**, lines 137-146: unset or blank gives `[]` (there is no fallback parameter). Otherwise `split(",")`, `Number(trim)`, keep `isFinite && ≥0`, then `Math.round`.
  - Order is preserved and there is NO de-duplication or sorting.
  - GOTCHA: an empty segment becomes a 0 ms sample, so "100,,200" gives [100,0,200].
- **executionMode(name, fallback)**, lines 148-165: trim+lowercase. Accepts "paper_touch", "paper_latency", "paper_legging", "live". Unset or blank gives the fallback. Any other value THROWS `Error("[Box] invalid ${name}=\"${raw}\"; expected paper_touch, paper_latency, paper_legging, or live.")` (line 162).
- **Inline BOX_LEG_EXECUTION_MODE parser**, lines 1055-1058: `process.env.BOX_LEG_EXECUTION_MODE?.trim().toLowerCase() === "sequential"` gives "sequential". Anything else, including typos, gives "parallel", with no warning.
- **Inline deploymentRegion parser**, lines 1012-1015: `(BOX_DEPLOYMENT_REGION?.trim() || BOX_EXECUTION_CALIBRATION_REGION?.trim() || "") || null`. Case is preserved and there is no sanitising.
- **Inline defaultTickSize**, lines 1067-1070: `v = num("BOX_DEFAULT_TICK_SIZE", 0.05)`, then `v > 0 ? v : 0.05`.
- **localCharges.ts has its own helpers**:
  - `num` at localCharges.ts:67-72 differs from config.ts: it requires `Number.isFinite(v) && v >= 0`, so negatives give the fallback.
  - `bool` at localCharges.ts:165-172 is identical to config.ts.
  - Strings are read via `?.trim() || default`.

#### 2. Env var table

Abbreviations:
- "num" means config num(): float, unclamped, negatives allowed, non-finite gives the default.
- "[a,b]" means clampInt: Math.round, then clamp. The default itself is not clamped.
- "bool" means the bool() helper.

Effects are taken from the BoxConfig field doc comments (lines 167-~796) plus the engine call sites I checked.

##### A. config.ts → `loadBoxConfig()` (lines 879-1144)

| # | Env | Field | Type | Default | Validation / fallback | Effect | Line |
|---|---|---|---|---|---|---|---|
| 1 | BOX_EXECUTION_MODE | executionMode | enum | "paper_latency" | trim/lowercase; paper_touch, paper_latency, paper_legging, live; other non-blank value THROWS (162); live with !BOX_LIVE_TRADING_ENABLED THROWS (882-886) | selects fill simulator or live executor | 880 (field 916) |
| 2 | BOX_LIVE_TRADING_ENABLED | liveTradingEnabled | bool | false | must be true when mode=live, else throw | live kill switch | 881 (field 1017) |
| 3 | BOX_PAPER_EXECUTION_PROFILE | paperExecutionProfile | enum | "standard" | standard, live_parity, stress; unknown value warns and uses fallback (so a mistyped "stress" never throws); stress with mode=live THROWS (897-901) | paper profile layered on paper_legging, ignored under live; runtime-mutable (engine.ts:4739) | 888 (field 970) |
| 4 | BOX_SHADOW_MODE_ENABLED | shadowModeEnabled | bool | false | true with mode=live THROWS (908-913) | real feed + strategy, paper live_parity orders, never a broker order | 889 (field 1009) |
| 5 | BOX_SIMULATED_DECISION_MS | simulatedDecisionMs | number | 40 (ms) | num | simulated decision/processing time before send | 917 |
| 6 | BOX_SIMULATED_LATENCY_MS | simulatedLatencyMs | number | 250 (ms) | num | simulated send → exchange-arrival latency | 918 |
| 7 | BOX_EXECUTION_MAX_WAIT_MS | executionMaxWaitMs | number | 1500 (ms) | num; read a 2nd time at 961 to seed #21's default | wait for post-arrival book on every leg, else `missing_book` | 919, 961 |
| 8 | BOX_EXECUTION_POLL_MS | executionPollMs | number | 20 (ms) | num | re-check cadence for post-arrival books | 920 |
| 9 | BOX_MAX_CONCURRENT_EXECUTIONS | maxConcurrentExecutions | number | 8 | num (floats/negatives not rejected) | cap on simultaneous simulated pipelines | 921 |
| 10 | BOX_DEDICATED_MARKET_FEED | boxDedicatedMarketFeed | bool | true | – | 2nd WebSocket lane on the same active broker for box option tokens; false = shared feed | 923 |
| 11 | BOX_EXECUTION_COORDINATOR_ENABLED | executionCoordinatorEnabled | bool | true | – | master switch for shared-contract exclusion | 924 |
| 12 | BOX_CONFLICT_WAIT_MAX_MS | conflictWaitMaxMs | int | 250 | [0, 5000] | give-up bound waiting on a contract held by another execution | 927 |
| 13 | BOX_INSTRUMENT_LOCK_TTL_MS | instrumentLockTtlMs | int | 5000 | [250, 60000]; read again at 946 (same clamp) for #18 | reservation TTL / crash recovery | 930, 946 |
| 14 | BOX_MAX_CONCURRENT_PER_UNDERLYING | maxConcurrentPerUnderlying | int | 2 | [0, 16]; 0 disables | per-underlying execution budget on top of contract exclusion | 931 |
| 15 | BOX_CONFLICT_REVALIDATE_MIN_EDGE_RATIO | conflictRevalidateMinEdgeRatio | number | 0.8 | num (no bounds) | min fraction of detected gross edge that must survive after a conflict wait | 932 |
| 16 | BOX_RESERVATION_REQUIRE_DURABLE | reservationRequireDurable | bool | false | – | live fails CLOSED unless a durable reservation tier exists | 936 |
| 17 | BOX_DURABLE_RESERVATIONS_ENABLED | durableReservationsEnabled | bool | true | – | build Mongo cross-process reservation tier | 941 |
| 18 | BOX_RESERVATION_RENEW_INTERVAL_MS | reservationRenewIntervalMs | int | computed: `max(250, floor(clampInt(TTL,5000,250,60000)/3))`, which is 1666 at default TTL (range 250..20000) | explicit value [100, 30000]; no check vs TTL (explicit may exceed TTL) | lease renewal timer | 944-949 |
| 19 | BOX_RESERVATION_CLOCK_SKEW_GRACE_MS | reservationClockSkewGraceMs | int | 250 | [0, 5000] | asymmetric expiry dead band (holder stops early, challenger waits late) | 952 |
| 20 | BOX_RESERVATION_UNCERTAIN_HOLD_MAX_MS | reservationUncertainHoldMaxMs | int | 60000 | [1000, 600000] | how long to keep renewing over an unresolved broker state, then let TTL lapse | 955 |
| 21 | BOX_RESERVATION_OWNERSHIP_MARGIN_MS | reservationOwnershipMarginMs | int | computed: `max(250, Math.round(num(BOX_EXECUTION_MAX_WAIT_MS,1500)))`, which is 1500 | explicit value [0, 30000]; the computed default is NOT clamped (MAX_WAIT=50000 gives 50000) | stop opening legs this far ahead of lease expiry | 959-964 |
| 22 | BOX_INTERNAL_NETTING_ENABLED | internalNettingEnabled | bool | false | doc: must stay false | net opposite-side boxes on the same contract | 965 |
| 23 | BOX_PAPER_MAX_CONCURRENT_EXECUTIONS | paperMaxConcurrentExecutions | int | computed: `clampInt(BOX_LIVE_MAX_CONCURRENT_EXECUTIONS,1,1,4)`, which is 1 | explicit value [1, 8] | paper pipeline cap under live_parity | 973-977 |
| 24 | BOX_PAPER_LATENCY_MODE | paperLatencyMode | enum | "constant" | constant, recorded_samples; unknown warns and uses fallback | live_parity latency source | 979 |
| 25 | BOX_PAPER_LATENCY_SAMPLES | paperLatencySamples | list of int ms | [] | msSamples (≥0, rounded, empty segment = 0, order kept) | POST→ACK samples for recorded_samples; empty means use the constant | 980 |
| 26 | BOX_PAPER_LATENCY_ACK_TERMINAL_SAMPLES | paperLatencyAckToTerminalSamples | list of int ms | [] | msSamples | ACK→terminal samples for the slot-hold model; empty means a fraction of the constant | 981 |
| 27 | BOX_PAPER_LATENCY_SEED | paperLatencySeed | number | 0 | num (float/negative not rejected) | deterministic start offset into the samples | 982 |
| 28 | BOX_PAPER_CALIBRATION_MIN_SAMPLES | paperCalibrationMinSamples | int | 30 | [5, 100000] | min fresh samples to use a calibrated distribution (engine.ts:555) | 987 |
| 29 | BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES | paperCalibrationBucketMinSamples | int | 60 | [5, 100000]; no check that it is ≥ #28 | min samples to use a time-of-day bucket | 988 |
| 30 | BOX_PAPER_CALIBRATION_MAX_AGE_MS | paperCalibrationMaxAgeMs | int | 3*24*60*60*1000 = 259200000 (3 days) | [60000, 30*24*60*60*1000 = 2592000000]; needs int64 in Go (exceeds int32) | exclude older samples from active calibration | 991-996 |
| 31 | BOX_PAPER_CALIBRATION_TIME_BUCKETS | paperCalibrationTimeBuckets | bool | true | – | enable OPEN/NORMAL/CLOSE bucketing | 997 |
| 32 | BOX_PAPER_CANCEL_LATENCY_MS | paperCancelLatencyMs | int | 150 | [0, 60000] | fallback cancel→terminal window for the cancel-vs-fill race | 1000 |
| 33 | BOX_PAPER_PERSISTENCE_MS | paperPersistenceMs | int | 0 | [0, 60000] | fallback persistence delay between slot acquire and transmit | 1001 |
| 34 | BOX_LIVE_TIMING_PERSIST_ENABLED | liveTimingPersistEnabled | bool | false | – | persist calibration observations across restarts | 1003 |
| 35 | BOX_LIVE_TIMING_BATCH_SIZE | liveTimingBatchSize | int | 50 | [1, 10000] | observations buffered before a flush | 1004 |
| 36 | BOX_LIVE_TIMING_FLUSH_MS | liveTimingFlushMs | int | 15000 | [250, 600000 (10*60_000)] | max buffer wait before flush | 1005 |
| 37 | BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED | executionEventLoopMetricsEnabled | bool | true | – | event-loop/process-pressure monitor (engine.ts:547) | 1007 |
| 38 | BOX_EXECUTION_TIMING_METRICS_ENABLED | executionTimingMetricsEnabled | bool | true | – | collect live broker-operation timing (fail-open) | 1010 |
| 39 | BOX_EXECUTION_TIMING_WINDOW | executionTimingWindow | int | 500 | [50, 100000] | ring buffer size per timing distribution (engine.ts:551) | 1011 |
| 40 | BOX_DEPLOYMENT_REGION | deploymentRegion | string or null | null | trimmed; blank falls through to #41 | region label stamped on calibration datasets (engine.ts:554) | 1013 |
| 41 | BOX_EXECUTION_CALIBRATION_REGION | deploymentRegion (alias) | string | – | used only when #40 is unset/blank; trimmed; both blank gives null | same as #40 | 1014 |
| 42 | BOX_LIVE_RECONCILE_INTERVAL_MS | liveReconcileIntervalMs | int | 60000 | [5000, 900000 (15*60_000)] | broker reconciliation cadence | 1018 |
| 43 | BOX_LIVE_FEED_RECONNECT_WARMUP_MS | liveFeedReconnectWarmupMs | int | 5000 | [0, 300000 (5*60_000)] | quiet period after a feed reconnect before a new entry | 1019 |
| 44 | BOX_LIVE_MAX_OPEN_BOXES | liveMaxOpenBoxes | int | 1 | [0, 20] | max open live boxes | 1020 |
| 45 | BOX_LIVE_MAX_CONCURRENT_EXECUTIONS | liveMaxConcurrentExecutions | int | 1 | [1, 4]; also the default source for #23 | live concurrent pipelines | 975, 1021 |
| 46 | BOX_LIVE_MAX_RESIDUAL_LEGS | liveMaxResidualLegs | int | 1 | [0, 4] | max residual (unhedged) legs | 1022 |
| 47 | BOX_LIVE_DAILY_LOSS_LIMIT | liveDailyLossLimit | int (₹) | 5000 | [0, 10000000] | daily loss stop | 1023 |
| 48 | BOX_LIVE_REJECT_LIMIT | liveRejectLimit | int | 3 | [1, 100] | broker reject trip | 1024 |
| 49 | BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT | liveConsecutiveFailureLimit | int | 3 | [1, 100] | consecutive failure trip | 1025 |
| 50 | BOX_LIVE_MAX_OPEN_LEG_QUANTITY | liveMaxOpenLegQuantity | int | 100 | [1, 1000000] | max quantity in one live leg | 1026 |
| 51 | BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY | liveMaxGrossOpenLegQuantity | int | 400 | [1, 4000000] | sum of absolute open leg quantities | 1027 |
| 52 | BOX_LIVE_HTTP_TIMEOUT_MS | liveHttpTimeoutMs | int | 5000 | [250, 30000] | transport deadline | 1028 |
| 53 | BOX_LIVE_ACK_TIMEOUT_MS | liveAckTimeoutMs | int | 3000 | [250, 30000] | broker ACK deadline | 1029 |
| 54 | BOX_LIVE_WORKING_TIMEOUT_MS | liveWorkingTimeoutMs | int | 30000 | [1000, 600000] | working-order deadline | 1030 |
| 55 | BOX_LIVE_PARTIAL_TIMEOUT_MS | livePartialTimeoutMs | int | 10000 | [500, 300000] | partial-fill deadline | 1031 |
| 56 | BOX_LIVE_CANCEL_TIMEOUT_MS | liveCancelTimeoutMs | int | 5000 | [250, 60000] | cancel deadline | 1032 |
| 57 | BOX_LIVE_MAX_MODIFICATIONS | liveMaxModifications | int | 2 | [0, 10] | max order modifications | 1033 |
| 58 | BOX_LIVE_MAX_CHASE_TICKS | liveMaxChaseTicks | int | 2 | [0, 20] | live limit-chase ticks | 1034 |
| 59 | BOX_LIVE_BROKER_MIN_INTERVAL_MS | liveBrokerMinIntervalMs | int | 250 | [50, 5000] | pacing for GENERAL broker calls (status polls, order lists, positions, margins, health); no longer placement | 1035 |
| 60 | BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS | liveBrokerOrderMinIntervalMs | int | 0 | [0, 5000]; 0 = derive from broker profile; a positive value is clamped UP to the broker floor by resolveBrokerPacing() in brokerPacing.ts (not read) | place/modify/cancel pacing | 1038 |
| 61 | BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY | liveEntrySubmitConcurrency | int | ENTRY_SUBMIT_CONCURRENCY_MIN = 1 | clampInt [1, 4] (MIN=1/MAX=4 from executionSchedulingPolicy.ts:169-170), Math.round | ENTRY-purpose legs in transport at once per attempt_id | 1040-1045 |
| 62 | BOX_LIVE_MAX_BOX_CAPITAL_RUPEES | liveMaxBoxCapitalRupees | int (₹) | 0 | [0, 1000000000]; 0 disables | cap on SUM of abs(limit × qty) over 4 entry legs (not margin) | 1049 |
| 63 | BOX_ONE_ACTIVE_BOX_PER_UNDERLYING | oneActiveBoxPerUnderlying | bool | false | – | at most one active box per underlying (entry only) | 1051 |
| 64 | BOX_SESSION_MAX_COMPLETED_TRADES | sessionMaxCompletedTrades | int | 0 | [0, 10000]; 0 = unlimited | complete lifecycles per armed session | 1052 |
| 65 | BOX_PAPER_MAX_BOX_CAPITAL_RUPEES | paperMaxBoxCapitalRupees | int (₹) | 0 | [0, 1000000000]; 0 disables | paper mirror of #62 | 1053 |
| 66 | BOX_LEG_EXECUTION_MODE | legExecutionMode | enum | "parallel" | inline: trim/lowercase === "sequential" gives sequential, everything else parallel, no warn | paper_legging leg submission order | 1055-1058 |
| 67 | BOX_LEG_TIMEOUT_MS | legTimeoutMs | number | 500 (ms) | num | leg rest time before deemed unfilled, then box aborts | 1059 |
| 68 | BOX_LEG_UNWIND_LATENCY_MS | legUnwindLatencyMs | number | 150 (ms) | num | simulated emergency-unwind latency | 1060 |
| 69 | BOX_LEG_MAX_CHASE_TICKS | legMaxChaseTicks | int | 2 | [0, 100] | entry marketable-limit band (reference ± ticks × tick) | 1065 |
| 70 | BOX_UNWIND_MAX_CHASE_TICKS | unwindMaxChaseTicks | int | 5 | [0, 200] | emergency-unwind band | 1066 |
| 71 | BOX_DEFAULT_TICK_SIZE | defaultTickSize | number (₹) | 0.05 | num; ≤0 gives 0.05 | fallback tick size when instrument tick is unknown | 1067-1070 |
| 72 | BOX_QUEUE_MODEL | queueModel | enum | "haircut" | none, haircut; unknown warns and uses fallback | how displayed depth counts as executable | 1075 |
| 73 | BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT | queueLiquidityHaircutPct | number | 30 | clampPct [0, 100], not rounded | effective qty = floor(displayed × (1 − pct/100)) | 1076 |
| 74 | BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS | maxCrossLegExchangeDispersionMs | int | 250 | [0, 60000]; 0 disables | reject `cross_leg_time_skew` | 1080 |
| 75 | BOX_MIN_EXPECTED_NET_PROFIT | minExpectedNetProfit | number (₹) | 1200 | num (negative allowed at env level); runtime-tunable via validateTuning [0, 1000000]; effective gate = requiredNetProfit() | THE entry gate (net after all costs) | 1083 |
| 76 | MIN_BOX_GROSS_EDGE | minGrossEdge | number (₹) | 1200 | num; used as max(0, v); after tuning becomes min(baseMinGrossEdge, requiredNetProfit(cfg)) (engine.ts:538, applyTuning) | cheap gross prefilter | 1085 |
| 77 | MIN_BOX_NET_EDGE | minNetEdge | number (₹) | 0 | legacy; only counted when >0 | raises required net to max(gate, v) | 1086 |
| 78 | BOX_SAFETY_BUFFER | safetyBuffer | number (₹) | 150 | num; runtime-tunable [0, 1000000] | risk allowance deducted inside expected net | 1087 |
| 79 | BOX_EXPECTED_ENTRY_SLIPPAGE | expectedEntrySlippage | number (₹) | 250 | num | entry cost before measurement (projection) | 1088 |
| 80 | BOX_EXPECTED_EXIT_SLIPPAGE | expectedExitSlippage | number (₹) | 250 | num | exit cost allowance | 1089 |
| 81 | BOX_PREFILTER_CHARGE_ALLOWANCE | prefilterChargeAllowance | number (₹) | 160 | num | lower-bound round-trip charges for prefilter | 1090 |
| 82 | BOX_REQUIRE_PRICED_CHARGES | requirePricedCharges | bool | true | – | refuse auto-entry when charges are undetermined | 1091 |
| 83 | BOX_RECONCILE_CHARGES | reconcileCharges | bool | true | – | async verify local charges vs Zerodha after fill | 1093 |
| 84 | BOX_CHARGE_RECONCILE_WARN_PCT | chargeReconcileWarnPct | number (%) | 5 | num | warn when abs(local − Zerodha) exceeds this % | 1094 |
| 85 | BOX_CHARGE_RECONCILE_CONCURRENCY | chargeReconcileConcurrency | number | 2 | num | max concurrent reconcile calls | 1095 |
| 86 | BOX_CHARGE_RECONCILE_MAX_ATTEMPTS | chargeReconcileMaxAttempts | number | 3 | num | attempts before "unverified" | 1096 |
| 87 | BOX_CHARGE_RECONCILE_RETRY_BASE_MS | chargeReconcileRetryBaseMs | number (ms) | 5000 | num | linear backoff: attempt N waits N × base | 1097 |
| 88 | BOX_QUOTE_MAX_AGE_MS | quoteMaxAgeMs | number (ms) | 15000 | num | how long an UNCHANGED book is trusted | 1099 |
| 89 | BOX_FEED_MAX_AGE_MS | feedMaxAgeMs | number (ms) | 5000 | num | universe feed liveness; tripped means no entry and no auto-exit | 1100 |
| 90 | BOX_UNDERLYING_MAX_AGE_MS | underlyingMaxAgeMs | number (ms) | 10000 | num | max age of underlying used to place ATM | 1101 |
| 91 | BOX_STRIKE_LEVEL | defaultStrikeLevel | int 1, 2 or 3 | 3 | clampStrikeLevel(num(...,3)): round, ≤1 gives 1, ≥3 gives 3, else 2 | boot strikes-each-side level (engine.strikeLevel, engine.ts:537); runtime setStrikeLevel | 1104 |
| 92 | BOX_ATM_HYSTERESIS | atmHysteresis | number | 0.15 | num | extra fraction of strike step past the midpoint before ATM re-centres | 1105 |
| 93 | BOX_WINDOW_MIN_INTERVAL_MS | windowMinIntervalMs | number (ms) | 15000 | num | min gap between window rebuilds per underlying | 1106 |
| 94 | BOX_ENABLE_SHORT_BOX | enableShortBox | bool | true | – | false means LONG_BOX only (engine.ts:536) | 1107 |
| 95 | BOX_CONVERGENCE_FLOOR | convergenceFloor | number (₹) | 200 | num | floor of convergence exit threshold | 1109 |
| 96 | BOX_CONVERGENCE_PCT | convergencePct | number | 0.2 | num | fraction of entry net edge used as threshold | 1110 |
| 97 | BOX_MIN_EXIT_NET_PNL | minExitNetPnl | number (₹) | 600 | num | min realisable net for a normal exit | 1111 |
| 98 | BOX_EXIT_USE_REALISABLE | exitUseRealisableNet | bool | true | env name lacks "_NET" | judge exit floor on touch net minus exit-slippage allowance | 1112 |
| 99 | BOX_PROFIT_CAPTURE_PCT | profitCapturePct | number | 0.75 | num | net profit fraction of net edge that alone justifies exit | 1113 |
| 100 | BOX_MIN_CAPTURED_PCT | minCapturedPct | number | 0.75 | num | fraction of ORIGINAL edge captured that justifies exit | 1114 |
| 101 | BOX_EXPIRY_SAFETY_MINUTES | expirySafetyMinutesBeforeClose | number (min) | 45 | num | force exit this long before close on expiry day | 1116 |
| 102 | BOX_MONITOR_INTERVAL_MS | monitorIntervalMs | number (ms) | 1000 | num | watchdog cadence (ticks drive normal exits) | 1118 |
| 103 | BOX_PERSIST_INTERVAL_MS | persistIntervalMs | number (ms) | 30000 | num | flush open-trade live fields to Mongo | 1119 |
| 104 | BOX_PUBLISH_INTERVAL_MS | publishIntervalMs | number (ms) | 500 | num | SSE publish cadence | 1120 |
| 105 | BOX_UNIVERSE_REFRESH_MS | universeRefreshMs | number (ms) | 60000 | num | universe/expiry/window refresh | 1121 |
| 106 | BOX_INDICATIVE_REFRESH_MS | indicativeRefreshMs | number (ms) | 60000 | num | last-close view rebuild while market is shut | 1122 |
| 107 | BOX_INDICATIVE_DISCOVERY | indicativeDiscovery | bool | true | – | build REST-priced last-close view for the whole universe when stopped/closed | 1123 |
| 108 | BOX_INDICATIVE_MAX_UNDERLYINGS | indicativeMaxUnderlyings | number | 150 | num; 0 = no cap | cap on indicative-only underlyings | 1126 |
| 109 | BOX_MAX_SUBSCRIBED_TOKENS | maxSubscribedTokens | number | 2200 | num | cap on subscribed box option tokens | 1127 |
| 110 | BOX_MAX_UNDERLYINGS | maxUnderlyings | number | 0 | num; 0 = no cap beyond the token budget | cap on scanned underlyings | 1128 |
| 111 | BOX_CHARGE_CACHE_TTL_MS | chargeCacheTtlMs | number (ms) | 30000 | num | TTL of cached charge estimate | 1129 |
| 112 | BOX_CHARGE_CONCURRENCY | chargeConcurrency | number | 3 | num | max concurrent Zerodha charge estimations | 1130 |
| 113 | BOX_MAX_PUBLISHED_OPPORTUNITIES | maxPublishedOpportunities | number | 60 | num | opportunities published to UI | 1131 |
| 114 | BOX_METRICS_WINDOW | metricsWindow | number | 500 | num | BoxMetrics ring size (engine.ts:535) | 1132 |
| 115 | BOX_PNL_CACHE_ENABLED | pnlCacheEnabled | bool | false | – | Redis day-P&L mirror plus nightly archive | 1134 |
| 116 | BOX_PNL_CACHE_INTERVAL_MS | pnlCacheIntervalMs | number (ms) | 30000 | num | Redis mirror cadence | 1135 |
| 117 | BOX_PNL_CACHE_TTL_SEC | pnlCacheTtlSec | number (s) | 3*24*60*60 = 259200 | num | TTL of the day's P&L hash | 1136 |
| 118 | BOX_PNL_ARCHIVE_HOUR | pnlArchiveHour | int (IST hour) | 21 | clampHour(num(..,21),21): round; outside 0..23 gives 21 | drain Redis to Mongo `box_daily_pnl` | 1137 |
| 119 | BOX_PNL_VERIFY_HOURS | pnlVerifyHours | list of int (IST) | [22, 23] | hours(): integers 0..23, dedup, sort; empty segment = 0; none valid gives the default | archive re-check hours | 1138 |
| 120 | BOX_PNL_ARCHIVE_DRAIN_DELAY_MS | pnlArchiveDrainDelayMs | number (ms) | 50 | num | delay between docs while draining | 1139 |
| 121 | BOX_CLOSED_CACHE_ENABLED | closedCacheEnabled | bool | true | – | mirror today's closed trades to Redis (inert without Upstash) | 1141 |
| 122 | BOX_CLOSED_CACHE_TTL_SEC | closedCacheTtlSec | number (s) | 259200 | num | TTL of the closed-trade hash | 1142 |

`strikesEachSide` (line 1103) is the literal `3` (readonly). It is NOT env-driven.

##### B. localCharges.ts → `loadBoxChargeRates()` (localCharges.ts:130-163)

This file uses its own num(), which rejects negatives (they give the default). Percent values are PERCENT (0.15 means 0.15%).

| # | Env | Field | Type | Default | Rules | Effect | Line |
|---|---|---|---|---|---|---|---|
| 123 | BOX_BROKERAGE_PER_ORDER | brokeragePerOrder | number (₹) | 20 | finite and ≥0 | flat brokerage per order | localCharges.ts:132 |
| 124 | BOX_BROKERAGE_MAX_PCT | brokerageMaxPct | number (%) | 0 | ≥0; 0 disables | brokerage cap as % of turnover | :133 |
| 125 | BOX_STT_SELL_PCT | sttSellPct | number (%) | 0.15 | ≥0 | STT on option sales, % of premium | :144 |
| 126 | BOX_STT_ROUND_NEAREST_RUPEE | sttRoundNearestRupee | bool | true | bool | STT rounded to the rupee (else to paise), roundStt :181 | :145 |
| 127 | BOX_EXCHANGE_TXN_PCT | exchangeTxnPct | number (%) | 0.03503 | ≥0 | exchange txn charge, both sides | :146 |
| 128 | BOX_IPFT_PER_CRORE | ipftPerCrore | number (₹/crore) | 50 | ≥0 | NSE IPFT folded into exchange head | :154 |
| 129 | BOX_IPFT_PCT | ipftPct | number (%) | 0 | ≥0; legacy, added to #128 | legacy IPFT | :155 |
| 130 | BOX_SEBI_PCT | sebiPct | number (%) | 0.0001 | ≥0 | SEBI fee | :156 |
| 131 | BOX_STAMP_DUTY_BUY_PCT | stampDutyBuyPct | number (%) | 0.003 | ≥0 | stamp duty on buys | :157 |
| 132 | BOX_GST_PCT | gstPct | number (%) | 18 | ≥0 | GST on brokerage + exchange + SEBI | :158 |
| 133 | BOX_STT_TYPE | sttType | string | "stt" | `?.trim() \|\| "stt"` | Kite tax label | :159 |
| 134 | BOX_CHARGE_RATE_VERSION | rateVersion | string | "zerodha-nse-options-2026-04-01" | `?.trim() \|\| default` | rate-card id stamped on trades | :160-161 |

##### C. reservations/identity.ts (env passed as a param, default `process.env`)

`sanitiseLabel` (identity.ts:42-46) replaces `[^A-Za-z0-9._-]+` with "-" and strips leading/trailing "-". An empty result gives the fallback, and the label is then truncated to the max length.

| # | Env | Field | Type | Default | Rules | Effect | Line |
|---|---|---|---|---|---|---|---|
| 135 | CALSPREAD_DEPLOYMENT_ID | identity.deployment | string | (none; then NODE_ENV) | trimmed, sanitised, max 64, fallback "development"; isDeploymentIdExplicit() = non-blank | durable lock namespace; live without it warns (engine.ts:969-974) | identity.ts:61, 70 |
| 136 | NODE_ENV | identity.deployment (fallback) | string | "development" | used only when #135 is blank; sanitised, max 64 | lock namespace | identity.ts:63 |
| 137 | CALSPREAD_INSTANCE_ID | identity.instance | string | os.hostname(), else "unknown-host" | sanitised, max 40, fallback "unknown-host" | host/replica label | identity.ts:96 |
| 138 | NODE_APP_INSTANCE | identity.instance suffix | string | – | if set, label = sanitise(`${instance}-w${worker}`, instance, 48) | PM2 worker label | identity.ts:102-103 |

#### 3. Exports of config.ts (and when env is read)

There are no module-load env reads in config.ts. Every `process.env` access happens inside the helpers, which are only called from `loadBoxConfig()`. So the env is re-read on EVERY call; nothing is memoised. In practice it is called once, in the BoxEngine constructor (`this.cfg = loadBoxConfig()`, engine.ts:531). The resulting object is then MUTATED at runtime:
- `minExpectedNetProfit` and `safetyBuffer` via `applyTuning` (engine.ts ~1272-1279).
- `minGrossEdge = Math.min(baseMinGrossEdge, requiredNetProfit(cfg))`, where `baseMinGrossEdge` is captured at engine.ts:538.
- `paperExecutionProfile` (engine.ts:4739).
- The strike level lives separately in `engine.strikeLevel`.

Persisted tunables load from Mongo `box_settings` (`loadPersistedTuning`, engine.ts ~1236-1255) through `validateTuning`. If validation fails, the code warns `[Box] ignoring persisted settings — <err>` and the whole saved set is ignored.

The other loaders behave the same way. `loadBoxChargeRates()` reads env per call; it is a constructor default at localCharges.ts:356 and is also called from src/synthetic/config.ts:128 and :146. `createProcessIdentity()` reads env per call; it is called at executionCoordinator.ts:400 and reservations/index.ts:63, once at startup.

| Export | Signature | Line | Notes |
|---|---|---|---|
| clampStrikeLevel | `(v: number): 1\|2\|3` | 60-65 | pure; see section 1 |
| BoxPaperProfile | `type = "standard"\|"live_parity"\|"stress"` | 116 | – |
| BoxConfig | interface | 167-~796 | 120 env-driven fields plus readonly `strikesEachSide: 3` |
| BoxTuning | `interface { minExpectedNetProfit: number; safetyBuffer: number }` | 815-820 | the only runtime-tunable fields |
| BOX_TUNING_LIMITS | `Record<keyof BoxTuning,{min,max}>` | 823-828 | both fields `{min: 0, max: 1_000_000}` |
| readTuning | `(cfg: BoxConfig): BoxTuning` | 831-836 | returns the two fields |
| validateTuning | `(patch: Partial<Record<keyof BoxTuning, unknown>>): {ok:true; values: Partial<BoxTuning>} \| {ok:false; error:string}` | 845-~868 | see below |
| BOX_TUNING_KEYS | `Record<keyof BoxTuning,string>` | 874-877 | Mongo keys `"min_expected_net_profit"`, `"safety_buffer"` |
| loadBoxConfig | `(): BoxConfig` | 879-1144 | reads env at call time; may throw (section 4) |
| requiredNetProfit | `(cfg: Pick<BoxConfig,"minExpectedNetProfit"\|"minNetEdge">): number` | 1152-1156 | `Math.max(minExpectedNetProfit, minNetEdge > 0 ? minNetEdge : 0)`, which floors a negative env gate at 0 |
| prefilterGrossThreshold | `(cfg: BoxConfig): number` | 1167-1169 | `Math.max(0, cfg.minGrossEdge)` |
| configSnapshot | `(cfg: BoxConfig): BoxScannerConfigSnapshot` | 1172-1224 | frozen onto every trade; fields listed below |

**validateTuning details:**
- It iterates keys in the order minExpectedNetProfit, then safetyBuffer.
- It skips `undefined`, `null` and `""`, then `v = Number(raw)`. JS coercion means `true` becomes 1, `false` 0, `"  "` 0 and `[]` 0, and these are all ACCEPTED.
- Non-finite returns `{ok:false, error:"<key> must be a number."}`.
- Out of [min,max] (checked BEFORE rounding) returns `"<key> must be between ₹0 and ₹1000000."`.
- Accepted values are stored as `Math.round(v)`. It returns on the first error.
- If nothing is accepted: `"Nothing to update — send minExpectedNetProfit and/or safetyBuffer."`.

**configSnapshot fields:**
- Edge, gate and costs: min_gross_edge, min_net_edge, min_expected_net_profit (= requiredNetProfit(cfg), not the raw value), safety_buffer, expected_entry_slippage, expected_exit_slippage.
- Strategy: quote_max_age_ms, strikes_each_side (always 3), convergence_floor, convergence_pct, min_exit_net_pnl, profit_capture_pct, min_captured_pct.
- Execution: execution_mode, simulated_decision_ms, simulated_latency_ms, paper_execution_profile.
- Live envelope: live_trading_enabled, live_reconcile_interval_ms, live_feed_reconnect_warmup_ms, live_max_open_boxes, live_max_concurrent_executions, live_max_residual_legs, live_daily_loss_limit, live_reject_limit, live_consecutive_failure_limit, live_max_open_leg_quantity, live_max_gross_open_leg_quantity, live_http_timeout_ms, live_ack_timeout_ms, live_working_timeout_ms, live_partial_timeout_ms, live_cancel_timeout_ms, live_max_modifications, live_max_chase_ticks, live_broker_min_interval_ms, live_broker_order_min_interval_ms, live_entry_submit_concurrency, live_max_box_capital_rupees.
- Entry restrictions: one_active_box_per_underlying, session_max_completed_trades.
- Paper order pricing: leg_max_chase_ticks, unwind_max_chase_ticks, queue_model, queue_liquidity_haircut_pct, max_cross_leg_exchange_dispersion_ms.

The type is `BoxScannerConfigSnapshot` at src/box/types.ts:1456-1516, where most fields are optional. Related types: `ExecutionMode` at types.ts:163, `BoxQueueModel` ("none"|"haircut") at types.ts:175, and `EXECUTION_MODES` array at types.ts:176.

**Non-exported helpers:** num :23, bool :30, hours :40, clampHour :52, clampInt :74, clampPct :83, queueModel :91, paperProfile :118, latencyMode :128, msSamples :138, executionMode :148.

#### 4. Cross-field validation, derived values, warnings, throws

**Throws, in evaluation order inside loadBoxConfig:**
1. An invalid BOX_EXECUTION_MODE throws at :162 (message in section 1).
2. `mode==="live" && !liveTradingEnabled` (:882) throws `"[Box] BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true; refusing to start live execution."` (:883-885).
3. The profile is parsed (it may warn) at :888 and shadow at :889.
4. `mode==="live" && profile==="stress"` (:897) throws `"[Box] BOX_PAPER_EXECUTION_PROFILE=stress cannot be combined with BOX_EXECUTION_MODE=live: the stress profile injects synthetic faults and must never run against a real account."` (:898-901).
5. `mode==="live" && shadow` (:908) throws `"[Box] BOX_SHADOW_MODE_ENABLED=true cannot be combined with BOX_EXECUTION_MODE=live: shadow mode must never be able to submit a broker order."` (:909-912).

**Warnings (console.warn):** only from queueModel (:97), paperProfile (:123) and latencyMode (:133), all with the format `[Box] ignoring unknown <NAME>="<raw>" — using <fallback>.`. Clamping, bool garbage and list garbage are all silent.

**Derived and computed defaults:**
- `reservationRenewIntervalMs` default = `max(250, floor(instrumentLockTtlMs/3))`. At the default TTL that is 1666.
- `reservationOwnershipMarginMs` default = `max(250, round(executionMaxWaitMs))`, which is 1500 and is NOT clamped to 30000 when the var is unset.
- `paperMaxConcurrentExecutions` default = `liveMaxConcurrentExecutions` (1..4, default 1); an explicit value is [1,8].
- `liveEntrySubmitConcurrency` is [ENTRY_SUBMIT_CONCURRENCY_MIN=1, ENTRY_SUBMIT_CONCURRENCY_MAX=4] (executionSchedulingPolicy.ts:169-170), default 1. config uses Math.round, while `clampEntrySubmitConcurrency()` in executionSchedulingPolicy.ts:173-179 uses Math.floor and maps non-finite to 1. So 2.5 becomes 3 in config but 2 via the policy helper.
- `defaultTickSize`: a value ≤0 becomes 0.05.
- `requiredNetProfit` = max(gate, minNetEdge if >0 else 0).
- `prefilterGrossThreshold` = max(0, minGrossEdge).
- At runtime, minGrossEdge = min(baseMinGrossEdge, requiredNetProfit) after every tuning change (engine applyTuning).

**Engine-level (not config.ts):**
- In live mode without CALSPREAD_DEPLOYMENT_ID it warns that the namespace was INFERRED (engine.ts:969-974).
- In live mode with the durable tier not ready it warns that LIVE ENTRY is disabled (engine.ts:976-980).

**Checks that do NOT exist:** renew < TTL, bucketMin ≥ min, partial < working, and others. config.ts has no other cross-field checks.

#### 5. Execution modes (`ExecutionMode`, types.ts:163)

`paper_touch | paper_latency | paper_legging | live`; the default is `paper_latency`. Nothing in config.ts changes a DEFAULT based on mode. Mode only gates the throws in section 4. The relevance of each mode below comes from the field docs.

- **paper_touch**: fills at the detection touch. Kept for comparison.
- **paper_latency** (default): waits simulatedDecisionMs (40) + simulatedLatencyMs (250), then fills from the first WS book at or after arrival. It polls every executionPollMs (20) for up to executionMaxWaitMs (1500), else `missing_book`. Capped by maxConcurrentExecutions (8).
- **paper_legging**: four independent orders.
  - Uses legExecutionMode, legTimeoutMs, legUnwindLatencyMs, legMaxChaseTicks, unwindMaxChaseTicks, defaultTickSize, queueModel, queueLiquidityHaircutPct and maxCrossLegExchangeDispersionMs.
  - paperExecutionProfile live_parity layers on top: shared liquidity ledger, the paper latency/calibration knobs, and paperMaxConcurrentExecutions (defaults to the live cap of 1).
  - stress profile: fault injection, paper only.
- **live**: requires BOX_LIVE_TRADING_ENABLED=true. Forbidden with profile=stress and with shadow=true. Uses the BOX_LIVE_* envelope (#42-#62). The profile is ignored under live. LIVE is not runtime-selectable; only the paper profile is (engine.ts:539-542).

#### 6. Counts

- config.ts: 122 distinct env vars. Verified by extracting the unique quoted names plus `process.env.X`. Three are read twice: BOX_EXECUTION_MAX_WAIT_MS, BOX_INSTRUMENT_LOCK_TTL_MS, BOX_LIVE_MAX_CONCURRENT_EXECUTIONS.
- localCharges.ts: 12.
- reservations/identity.ts: 4 (two are generic: NODE_ENV, NODE_APP_INSTANCE).
- Total distinct under src/box (non-test): 138.

#### Go-port gotchas

1. JS `Number()` parsing semantics (hex/binary/octal, whitespace, "Infinity").
2. An empty list segment becomes 0 in hours() and msSamples().
3. clampInt never clamps its fallback (ownership-margin default).
4. config num() accepts negatives and floats; localCharges num() rejects negatives.
5. clampStrikeLevel(NaN) returns 2.
6. paperCalibrationMaxAgeMs max of 2,592,000,000 needs int64.
7. validateTuning coerces booleans and whitespace strings to numbers.
8. loadBoxConfig re-reads env on every call but is called once; the cfg is then mutated in place for the tunables, minGrossEdge and paperExecutionProfile.


---

## 2. Domain types (`types.ts`), barrel (`index.ts`), `serialize.ts`, `instrumentKey.ts`, `instrumentReservations.ts`, `model.ts`

> Reader gaps (not verified in this pass): None of these files documents the BoxOrderIntentState or IBoxExitAttempt.status transitions; the transition logic lives elsewhere (order manager / orderLifecycle.ts), which I did not read. I did not read the BoxEngine constructor internals, reservations/inProcess.ts or repository.ts, so lean vs hydrated reads (which affect which default keys appear in serialized JSON) are unverified. Still open: whether IBoxTrade.entry_box_cost is per unit or total, whether queue_liquidity_haircut_pct is a fraction or a percent, and whether the sparse+partial broker_order_id index actually exists in the live DB.


All six files were read in full. Line numbers come from `grep -n`, plus offsets counted while reading. I also checked these helpers: `math.ts:314` candidateKey, `paperLegTimeline.ts:41`, `partialExitPnl.ts:94`, `brokers/types.ts`, `pnlSnapshot.ts:62-92`, `db.ts:355`.

---------------------------------------------------------------------
#### 1. src/box/types.ts (1875 lines)

**Purpose.** Pure domain types plus a few pure helpers and constants for box arbitrage. It has no Mongoose or Express dependency, so the decision path can be tested on its own.
- LONG_BOX = BUY K1CE / SELL K2CE / BUY K2PE / SELL K1PE.
- SHORT_BOX is the mirror. At expiry the long box receives (K2−K1) per unit and the short box pays it (header, lines 1-25).

**Imports and re-exports.**
- `BrokerId` from `../brokers/types.js`.
- `PaperLegCancelStage` from `paperLegTimeline.ts:41` = `"pre_submission" | "in_transport" | "at_exchange"`.
- `PartialExitMark` from `partialExitPnl.ts:94`. Both are re-exported at line 31.
- Lines 1869-1870 re-export `brokerOf, brokerLabel, BROKER_IDS, LEGACY_BROKER, isBrokerId` and `type BrokerId` from brokers/types.

**brokers/types.ts behaviour (re-exported):**
- `BrokerId = "zerodha" | "dhan"`; `BROKER_IDS = ["zerodha","dhan"]`; `LEGACY_BROKER = "zerodha"`.
- `isBrokerId(v)` is a strict `===` check.
- `brokerOf(rec)` returns `rec.broker` only if it is a valid BrokerId. Anything else (absent, null, garbage) gives "zerodha".
- `brokerLabel`: dhan gives "DHAN", anything else gives "ZERODHA".
- `parseBrokerId(trim+lowercase)` is NOT re-exported.

##### Exported runtime values (all pure, immutable)

| line | symbol | value / signature |
|---|---|---|
| 176 | `EXECUTION_MODES: readonly ExecutionMode[]` | `["paper_touch","paper_latency","paper_legging","live"]` |
| 183 | `EXECUTION_MODE` (@deprecated) | `"paper_touch"` |
| 187 | `BOX_DIRECTIONS` | `["LONG_BOX","SHORT_BOX"]` |
| 193 | `BOX_LEG_ROLES` | `["k1_ce","k2_ce","k2_pe","k1_pe"]` (canonical index 0..3 everywhere) |
| 208 | `BOX_ENTRY_SIDES_BY_DIRECTION: Readonly<Record<BoxDirection, Readonly<Record<BoxLegRole, OrderSide>>>>` | LONG_BOX `{k1_ce:BUY,k2_ce:SELL,k2_pe:BUY,k1_pe:SELL}`; SHORT_BOX `{k1_ce:SELL,k2_ce:BUY,k2_pe:SELL,k1_pe:BUY}` |
| 216 | `BOX_ENTRY_SIDES` | = `BOX_ENTRY_SIDES_BY_DIRECTION.LONG_BOX` |
| 226 | `function directionSign(direction: BoxDirection): 1 \| -1` | LONG_BOX gives +1, anything else gives −1 |
| 1851 | `function directionOf(doc: { direction?: BoxDirection \| null }): BoxDirection` | `=== "SHORT_BOX"` gives SHORT_BOX, ELSE LONG_BOX (absent, null or unknown all become LONG_BOX) |
| 1856 | `function directionLabel(direction: BoxDirection): string` | `"SHORT BOX"` / `"LONG BOX"` |
| 1873 | `function isPaperExecutionMode(mode: ExecutionMode): boolean` | `mode !== "live"` |

**Numeric constants.** types.ts defines none. Its comments reference external knobs: `BOX_LEG_TIMEOUT_MS`, `BOX_DEFAULT_TICK_SIZE`, `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES`, `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING`, `BOX_SESSION_MAX_COMPLETED_TRADES`. Other documented sizes:
- Strike window is ATM-3..ATM+3, so at most 7 strikes (BoxUnderlyingState, ~line 330).
- Up to C(7,2)=21 pairs × 2 directions = 42 candidates per underlying (~line 345).
- Dhan correlationId is limited to 30 characters (IBoxOrderIntent comment, ~line 1200).
- Example client order id format: `"BOX:<24-char-oid>:ENTRY:k1_ce:attempt-1"`.

##### Formulas documented in types.ts (the code lives in math.ts etc.)
- `entry_net_debit_per_unit = Σ(+price of BUY legs) + Σ(−price of SELL legs)` at the executable touch (ask for BUY, bid for SELL). Positive means a debit, negative a credit. `entry_box_cost_per_unit` is the same number (BoxEvaluation, line 427).
- `gross_edge_per_unit = directionSign × box_width − netDebit`; `gross_edge = gross_edge_per_unit × lot_size`.
- `expected_net = gross − entry_charges − estimated_exit_charges − execution_cost − safety_buffer`; `qualifies = expected_net >= min_expected_net_profit` (BoxEntryDecision, line 490).
- `execution_cost = entry_slippage_allowance + future_exit_slippage_allowance`. The entry allowance is 0 at the FINAL qualification because executed gross already includes the slippage. `measured_entry_slippage` is analytics-only and never subtracted.
- `executable = price > 0 && qty_at_touch >= lot_size` (BoxLegEvaluation).
- `exit_net_credit_per_unit = Σ(+price of closing SELLs) − Σ(price of closing BUYs)`. For a long box that is `Bid(K1CE) − Ask(K2CE) + Bid(K2PE) − Ask(K1PE)` (BoxExitMetrics, line 1781).
- `convergence_threshold = max(floor, pct × entry expected net edge)`; `captured_edge = entryEdge − remainingEdge`; `captured_pct = captured_edge / |entry edge|`.
- Slippage sign: positive means adverse. `slippage = slippage_per_unit × lot_size`.
- Order pricing (PaperOrderPricing, line 792): BUY `limit = reference + max_chase_ticks × tick_size`; SELL `limit = reference − max_chase_ticks × tick_size`.
- `order_sent_at = detected_at + decision delay + send latency`; `decision_to_fill_ms = executed_at − detected_at`.
- `first_to_last_fill_ms = max(fill_at) − min(fill_at)` over FILLED legs. A single fill gives 0.
- `legging_net_loss = legging_gross_loss − partial_entry_charges − unwind_charges` (both ≤ 0).
- `timeout_at = arrival_at + BOX_LEG_TIMEOUT_MS`.
- Intent fill attribution: `delta = filled_quantity − previous_filled_quantity`. If `previous_filled_quantity` is absent, attribute NOTHING.
- Temporal: `receive_dispersion = newest − oldest receive ts`. `exchange_dispersion` is computed only when all four legs have an exchange_at.
- Candidate key: `underlying|expiry|K1|K2|DIRECTION` (math.ts:314-322; `direction` defaults to "LONG_BOX").

##### Types by area (every export; `?` = optional)

**A. Charges**
- `BoxLegCharges` (43): side: OrderSide; tradingsymbol: string; quantity, price, value, brokerage, stt: number; stt_type: string; exchange_txn, sebi, stamp_duty, gst, total: number. All in ₹. model.ts asserts it is structurally identical to calendar `ILegCharges`.
- `BoxCharges` (60): legs: BoxLegCharges[]; value, brokerage, stt, exchange_txn, sebi, stamp_duty, gst, total: number; source: "kite" | "kite_estimate"; at: Date. Must stay identical to calendar `ITradeCharges`.
- `BoxChargeOrigin` (96): "local" | "kite" | "local_verified" | "dhan" | "dhan_estimate".
- `BoxChargesWithOrigin extends BoxCharges` (112): computed_by?: BoxChargeOrigin; broker?: BrokerId (absent means zerodha).
- `BoxChargeReconciliation` (124):
  - status: "pending" | "verified" | "failed" (pending moves to verified or failed)
  - local_total, reconciled_total: number|null
  - abs_diff: number|null (₹, |zerodha−local|)
  - pct_diff: number|null (a PERCENT, abs_diff/zerodha_total)
  - head_diffs?: {brokerage, stt, exchange_txn, sebi, stamp_duty, gst: number}|null (₹, local−Zerodha)
  - at: Date|null; error: string|null
- `BoxChargeEstimate` (466): entry: BoxCharges; estimated_exit: BoxCharges; entry_total, estimated_exit_total: number; entry_legs, exit_legs: BoxLegCharges[].

**B. Config / mode enums**
- `ExecutionMode` (163): "paper_touch" | "paper_latency" | "paper_legging" | "live".
- `BoxQueueModel` (175): "none" | "haircut".
- `BoxDirection` (186): "LONG_BOX" | "SHORT_BOX".
- `BoxLegRole` (190): "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe".
- `OrderSide` (200): "BUY" | "SELL".
- `BoxLegExecutionMode` (717): "parallel" | "sequential".
- `PaperOrderType` (779): "MARKETABLE_LIMIT" | "PASSIVE_LIMIT".
- `BoxScannerConfigSnapshot` (1456), frozen onto each trade. Units: ₹ unless the name ends in `_ms` (ms) or `_pct`/`_ticks`.
  - min_gross_edge (₹ prefilter), min_net_edge (legacy, 0 = none), min_expected_net_profit? (THE gate, ₹), safety_buffer
  - expected_entry_slippage?, expected_exit_slippage? (₹)
  - quote_max_age_ms, strikes_each_side, convergence_floor (₹), convergence_pct (fraction), min_exit_net_pnl (₹), profit_capture_pct, min_captured_pct? (fraction of the original edge)
  - execution_mode: ExecutionMode; simulated_decision_ms?, simulated_latency_ms?
  - paper_execution_profile?: "standard" | "live_parity" | "stress"
  - Live safety envelope: live_trading_enabled?: boolean; live_reconcile_interval_ms?, live_feed_reconnect_warmup_ms?, live_max_open_boxes?, live_max_concurrent_executions?, live_max_residual_legs?, live_daily_loss_limit? (₹), live_reject_limit?, live_consecutive_failure_limit?, live_max_open_leg_quantity?, live_max_gross_open_leg_quantity?
  - Live timeouts and pacing: live_http_timeout_ms?, live_ack_timeout_ms?, live_working_timeout_ms?, live_partial_timeout_ms?, live_cancel_timeout_ms?, live_max_modifications?, live_max_chase_ticks?, live_broker_min_interval_ms?, live_broker_order_min_interval_ms? (0 = derive from the broker limit), live_entry_submit_concurrency? (1..4)
  - live_max_box_capital_rupees? (₹ GROSS entry-order notional, NOT margin; 0 = disabled)
  - one_active_box_per_underlying?: boolean; session_max_completed_trades? (0 = unlimited)
  - leg_max_chase_ticks?, unwind_max_chase_ticks?, queue_model?: BoxQueueModel, queue_liquidity_haircut_pct? (fraction vs percent not stated), max_cross_leg_exchange_dispersion_ms?

**C. Quotes / books / instruments**
- `BoxDepthLevel` (231): price, qty, orders: number.
- `BoxDepthSnapshot` (1371): bids, asks: BoxDepthLevel[].
- `BoxQuote` (245) is IMMUTABLE: it is replaced whole and never mutated.
  - token, bid, bid_qty, ask, ask_qty, last: number; bids, asks: BoxDepthLevel[]
  - version: number (monotonic local WS sequence)
  - at: number (epoch ms RECEIVE time, which drives freshness)
  - exchange_at: number|null (epoch ms exchange timestamp)
  - source: "ws" (literal)
- `BoxTouch` (282): token; side: OrderSide; price: number|null (ask for BUY, bid for SELL); qty (qty at exactly that price); bid, bid_qty, ask, ask_qty; version; at (epoch ms); age_ms; fresh: boolean.
- `BoxOptionInstrument` (300): token; tradingsymbol; exchange; strike; instrument_type: "CE"|"PE"; expiry: string; lot_size; tick_size?: number (₹; falls back to BOX_DEFAULT_TICK_SIZE).
- `BoxUnderlyingState` (320): underlying, name: string; is_index: boolean; spot_token; expiry: string; lot_size; strike_step (median gap); atm_strike; strikes: number[] (≤7); ce, pe: Map of number to BoxOptionInstrument; spot; spot_at (epoch ms); window_at (epoch ms).

**D. Candidates / evaluations / opportunities**
- `BoxCandidate` (350): key (underlying|expiry|K1|K2|DIRECTION); underlying; name; is_index; expiry; direction; lower_strike; upper_strike; box_width; lot_size; legs: Record of BoxLegRole to BoxOptionInstrument.
- `BoxRejectReason` (367), 14 values: "no_quote", "stale_quote", "missing_bid", "missing_ask", "insufficient_qty", "below_gross_prefilter", "below_net_edge", "below_expected_net_profit", "execution_failed", "unpriced_charges", "duplicate_open", "stale_underlying", "market_closed", "implausible_close".
- `BoxLegEvaluation` (391): role; side; token; tradingsymbol; strike; instrument_type: "CE"|"PE"; price: number|null; qty_at_touch; bid, bid_qty, ask, ask_qty; quote_at: number|null (epoch ms); exchange_at?: number|null; quote_version?: number|null; depth?: BoxDepthSnapshot|null (only when capture was requested, null on the hot path); age_ms: number|null; fresh: boolean; executable: boolean.
- `BoxEvaluation` (427): candidate: BoxCandidate; at: number; legs: BoxLegEvaluation[]; entry_net_debit_per_unit, entry_box_cost_per_unit, gross_edge_per_unit, gross_edge: number|null; tradable: boolean (all quoted, fresh and one-lot executable); depth_ok: boolean (ignores freshness); worst_age_ms: number|null; quote_version: number|null (max of the 4 legs); reject: BoxRejectReason|null.
- `BoxEntryDecision` (490): gross_edge, entry_charges, estimated_exit_charges: number|null; execution_cost: number; entry_slippage_allowance: number; future_exit_slippage_allowance: number; measured_entry_slippage: number|null; safety_buffer: number; expected_net_profit: number|null; min_expected_net_profit: number; passes_gross_prefilter: boolean; qualifies: boolean; reject: BoxRejectReason|null.
- `BoxOpportunity` (528), the UI/SSE shape:
  - Identity: key; underlying; name; is_index; expiry; direction; lower_strike; upper_strike; box_width; lot_size; quantity
  - Economics: entry_box_cost: number|null (signed, negative = credit); gross_edge|null; entry_charges|null; estimated_exit_charges|null; execution_cost: number; safety_buffer: number; projected_net_edge|null; expected_net_profit|null; min_expected_net_profit: number; charge_origin: BoxChargeOrigin
  - entry_sides: {role: BoxLegRole; side: OrderSide; tradingsymbol: string}[]
  - Liquidity: liquidity_ok: boolean; depth_ok: boolean; worst_age_ms|null; price_source: "touch" | "last_close"
  - status: "WATCHING" | "INDICATIVE" | "UNPRICED" | "ELIGIBLE" | "PAPER_OPENED" | "LIVE_OPENED" | "OPEN" | "REJECTED" (INDICATIVE and UNPRICED are never auto-traded)
  - reject|null; legs: BoxLegEvaluation[]; updated_at: number (epoch ms)

**E. Execution simulation (atomic modes)**
- `BoxExecutionFailureReason` (593), 16 values: "price_moved", "insufficient_quantity", "missing_book", "feed_unhealthy", "market_closed", "edge_disappeared", "below_expected_net_profit", "discovery_stopped", "duplicate", "legging_incomplete", "unwind_failed", "cross_leg_time_skew", "abort_after_fill", "box_capital_limit" (pre-trade, gross notional), "underlying_already_active", "session_limit_reached" (blocks NEW ENTRY only).
- `BoxExecutionLeg` (649): role; side; token; tradingsymbol; detected_price|null; detected_qty; detected_quote_version|null; detected_quote_at|null; detected_exchange_at?|null; detected_depth?: BoxDepthSnapshot|null; executed_price|null; executed_qty; executed_quote_version|null; executed_quote_at|null; executed_exchange_at?|null; slippage_per_unit|null; slippage|null (× lot size); executed_book_age_ms?|null; book_changed?: boolean; executed_depth: BoxDepthSnapshot|null.
- `BoxExecutionRecord` (687): mode: ExecutionMode; detected_at; order_sent_at; executed_at|null; decision_to_fill_ms|null; simulated_decision_ms; simulated_latency_ms; detection_quote_version|null; execution_quote_version|null; detected_net_debit_per_unit|null; executed_net_debit_per_unit|null; detected_gross_edge|null; executed_gross_edge|null; total_slippage: number (₹); legs: BoxExecutionLeg[]; filled: boolean; failure_reason|null; failure_detail: string|null. Every *_at here is an epoch-ms number.

**F. paper_legging / independent leg orders**
- `PaperLegStatus` (749) is a STATE MACHINE, documented at lines ~719-748. 14 values: "CREATED", "SUBMITTED", "IN_FLIGHT", "ACKNOWLEDGED", "PENDING", "PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "TIMED_OUT", "CANCELLED", "FAILED", "UNWINDING", "UNWOUND", "UNWIND_FAILED". Flow as documented:
  - Main path: CREATED (sequential: waiting its turn) → SUBMITTED (at submit_at) → IN_FLIGHT (cannot fill before arrival_at) → [ACKNOWLEDGED, live_parity only; an ACK is NEVER a fill] → PENDING (resting, nothing filled) → PARTIALLY_FILLED → FILLED.
  - TIMED_OUT: not fully filled at arrival_at+BOX_LEG_TIMEOUT_MS. Can carry fill_qty>0.
  - CANCELLED: withdrawn before completing (STOP/feed/market).
  - FAILED: never worked (e.g. a sequential skip).
  - CANCEL_REQUESTED (live_parity): cancel in flight, can STILL fill (the cancel-vs-fill race). Only cancel_stage="at_exchange" may race.
  - Unwind path: filled/partial → UNWINDING → UNWOUND, or UNWIND_FAILED (exposure still outstanding).
  - The exact transition guards are not in this file (see orderLifecycle.stageProvesExecution / paperLegTimeline.ts).
- `PaperOrderPricing` (792): order_type: PaperOrderType; side; quantity; reference_price; tick_size (₹); max_chase_ticks; limit_price (₹).
- `PaperFillSlice` (807): price; qty; displayed_qty; effective_qty (≤ displayed, after the queue haircut); at (epoch ms of the book); quote_version|null.
- `PaperLegExecution` (826):
  - Identity: role; side; token; tradingsymbol; order_id; client_order_id; pricing: PaperOrderPricing|null; detected_price|null; detected_qty
  - Timeline (all epoch ms): submit_at; arrival_at; ack_at|null; pending_since|null; timeout_at|null; cancel_requested_at|null; cancel_confirmed_at|null
  - Cancel race: fill_qty_at_cancel_request|null; raced_fill_qty: number; cancel_stage: PaperLegCancelStage|null
  - Arrival depth: executable_within_limit_at_arrival|null; displayed_qty_at_arrival|null; limit_offset_ticks|null (signed, + = through the touch)
  - Fills: fill_at|null; resolved_at|null; fill_price|null (VWAP); average_fill_price|null (same value); quantity; requested_qty; fill_qty; remaining_qty; fills: PaperFillSlice[]
  - Book: quote_version|null; book_at|null (receive ts); book_exchange_at|null; book_age_ms|null
  - Outcome: slippage|null (₹ total over filled qty, + = worse); status: PaperLegStatus; unwind_price|null; unwind_slippage|null; unwound_qty: number; fail_reason: string|null
- `ResidualExposureSource` (944): "partial_entry" | "partial_exit" | "failed_unwind".
- `ResidualLegExposure` (946): token; tradingsymbol; exchange?: string; role; side (the side HELD); quantity; average_price (₹); source; created_at: number (epoch ms, preserved across shrink); flatten_attempt?: number (absent means attempt 1); flatten_accounted_filled?: number (absent means 0); flatten_accounted_charges?: number.
- `BoxEntryOutcomeClass` (1021), the terminal classification, 7 values: "OPENED", "REFUSED_BEFORE_SUBMIT", "NO_FILL", "PARTIAL_ENTRY_UNWOUND", "PARTIAL_ENTRY_RESIDUAL", "FILLED_THEN_ECONOMICS_ABORT", "QUARANTINED_UNKNOWN".
- `PaperLeggingExecutionRecord` (1030):
  - mode: "paper_legging" | "live"; trade_id?: string|null; leg_execution_mode; detected_at; order_sent_at
  - filled_leg_count (0..4); opened: boolean; failed_legs: BoxLegRole[]; legs: PaperLegExecution[]
  - Timing: first_to_last_fill_ms|null; decision_to_first_fill_ms|null; decision_to_last_fill_ms|null; timed_out_legs: BoxLegRole[]; partial_fill_legs: BoxLegRole[]; exposure_started_at|null; exposure_ended_at|null; exposure_duration_ms|null; decision_to_complete_ms|null
  - Abort accounting: total_entry_slippage: number; emergency_unwind: boolean; partial_entry_charges|null; unwind_charges|null; legging_gross_loss|null; legging_net_loss|null; abort_after_fill: boolean; final_expected_net_profit|null; required_expected_net_profit|null; outcome_class?: BoxEntryOutcomeClass
  - temporal: BoxTemporalCoherence|null; residual_exposure: ResidualLegExposure[]
  - Counts: submitted_leg_count (NOT always 4 on exits/flattens); fully_closed_role_count; remaining_role_count; fills_by_role: Partial Record of BoxLegRole to number
  - failure_reason|null; failure_detail|null
- `BoxTemporalCoherence` (1132): oldest_quote_age_ms|null; newest_quote_age_ms|null; receive_dispersion_ms|null; exchange_dispersion_ms|null; legs_with_exchange_ts: number; receive_to_exchange_delay_ms: (number|null)[]; books_changed_during_latency: number.

**G. Live order intents (durable journal, `box_order_intents`)**
- `BoxOrderIntentState` (1149) is a STATE MACHINE. 11 values: "CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "COMPLETE", "CANCEL_REQUESTED", "CANCELLED", "REJECTED", "UNKNOWN", "RECONCILIATION_REQUIRED". This file does not document the transitions (from/to only appear in the audit). Terminal states are implied by `terminal_at`, probably COMPLETE/CANCELLED/REJECTED; verify in the order manager.
- `BoxOrderPurpose` (1162): "ENTRY" | "EXIT" | "EMERGENCY_RESIDUAL" | "PROTECTIVE_CANCEL".
- `BoxOrderPhase` (1163): "entry" | "exit" | "unwind".
- `BoxOrderIntentAudit` (1166): audit_id (idempotency key); at: Date; from_state: BoxOrderIntentState|null; to_state: BoxOrderIntentState; broker_order_id|null; message|null; fill_identity|null; payload?: Record of string to unknown, or null.
- `IBoxOrderIntent` (1183):
  - Identity: client_order_id; broker_order_id|null; broker_mode: "paper"|"live"; broker?: BrokerId (IMMUTABLE; reconciliation routes on it); broker_correlation_id?: string|null; trade_id|null; attempt_id
  - Order: role; purpose; phase; exchange; tradingsymbol; token; side; quantity; reference_price; tick_size; max_chase_ticks; limit_price
  - Fill state: state; filled_quantity; previous_filled_quantity?: number|null; average_price|null; broker_tag|null; reject_family|null; reject_reason|null
  - Timestamps: created_at, updated_at: Date; terminal_at: Date|null
  - audit: BoxOrderIntentAudit[] (append-only, idempotent by audit_id)
- `BoxOrderIntentPatch` (1250): Partial of Pick of IBoxOrderIntent for broker_order_id, state, filled_quantity, average_price, broker_tag, reject_family, reject_reason, updated_at, terminal_at. Note that previous_filled_quantity is NOT patchable; the persistence layer stamps it.

**H. Execution attempts (`box_execution_attempts`)**
- `IBoxExecutionAttempt` (1266):
  - Identity: candidate_key; direction; underlying; name; is_index; expiry; lower_strike; upper_strike; lot_size; quantity; execution_mode; broker?; leg_execution_mode: BoxLegExecutionMode|null
  - Timing and economics: detected_at: Date; resolved_at: Date; detected_gross_edge|null; expected_net_profit|null; required_expected_net_profit?|null; charge_rate_version?|null
  - Outcome: abort_after_fill?: boolean; outcome_class?: BoxEntryOutcomeClass|null; filled_leg_count; failed_legs: BoxLegRole[]; failure_reason|null; failure_detail|null; legging: PaperLeggingExecutionRecord|null
  - Charges: partial_entry_charges|null; unwind_charges|null; flatten_charges?|null (cumulative across passes); flatten_charge_day?: string|null (IST day); flatten_charges_for_day?|null
  - Projection: projection_version?|null (legacy = 0); residual_projection_identity?|null; applied_flatten_applications?: string[]|null (bounded ring)
  - P&L and residuals: gross_abort_pnl|null; net_abort_pnl|null; residual_exposure?: ResidualLegExposure[]; resolved?: boolean (false while any residual remains)

**I. Trades / legs / positions / exits**
- `IBoxLeg` (1338):
  - Contract: role; token; tradingsymbol; exchange; strike; instrument_type; side
  - Entry: entry_price: number; entry_bid; entry_bid_qty; entry_ask; entry_ask_qty; entry_quote_at: Date|null; entry_depth: BoxDepthSnapshot|null; detected_price?|null; entry_slippage?|null
  - Exit: exit_price|null; exit_bid|null; exit_bid_qty|null; exit_ask|null; exit_ask_qty|null; exit_quote_at: Date|null; exit_depth|null; exit_detected_price?|null; exit_slippage?|null
- `BoxTradeStatus` (1376): "open" | "closed" | "error". Simple lifecycle: open becomes closed or error.
- `BoxPositionState` (1385) is a STATE MACHINE: "BOX" | "PARTIALLY_EXITED" | "RECOVERY" | "FLAT". RECOVERY is STICKY while any canonical role qty ≠ 0. FLAT is derived only when all four role quantities are exactly 0. Absent/null means "BOX".
- `IBoxExitAttempt` (1397):
  - attempt_id; source: "auto"|"manual"|"recovery"
  - status: "SUBMITTED" | "PARTIAL" | "COMPLETE" | "FAILED" | "INVARIANT_VIOLATION" | "UNCERTAIN" (a per-attempt state machine; transitions not documented)
  - origin: "auto"|"manual" (@deprecated alias); reason: BoxExitReason
  - Timing: detected_at, requested_at: Date; submitted_at|null; completed_at|null
  - Quantities: requested_qty_by_role (full Record of role to number); filled_qty_by_role (Partial); fills_by_role (Partial, alias); avg_price_by_role (Partial)
  - Charges and P&L: charges: BoxChargesWithOrigin|null; charges_total: number; gross_pnl|null
  - remaining_after (full Record of role to number); submitted_role_count; fully_filled_role_count; remaining_role_count; submitted_leg_count; filled_leg_count
  - broker_orders?: Array of {client_order_id; broker_order_id|null; state: BoxOrderIntentState; requested_quantity; filled_quantity; average_price|null}
  - invariant_violation?: string|null
- `BoxExitReason` (1440): "EDGE_CONVERGED" | "PROFIT_CAPTURE" | "MANUAL" | "EXPIRY_SAFETY".
- `BoxExitBlockedReason` (1447): "insufficient_exit_liquidity" | "net_below_floor" | "unpriced_charges" | "market_closed" | "feed_unhealthy" | null. Null is part of the union.
- `IBoxTrade` (1519):
  - Identity: execution_mode; broker?: BrokerId (immutable); underlying; name; is_index; expiry; direction?: BoxDirection (absent means LONG_BOX); lower_strike; upper_strike; lot_size; quantity; status: BoxTradeStatus
  - Position: remaining_qty_by_role?: Partial Record or null (absent means every role = quantity); position_state?|null; exit_attempts?: IBoxExitAttempt[]|null; cumulative_exit_charges?|null (₹)
  - legs: IBoxLeg[]; box_width; margin: number|null (₹ SPAN+exposure for the 4 one-lot orders, best-effort)
  - Entry economics: entry_box_cost: number (signed net debit; whether it is per-unit or ×qty is not stated here, verify in the engine); entry_gross_edge; entry_charges: BoxChargesWithOrigin|null; estimated_exit_charges|null; safety_buffer; entry_net_edge; expected_net_profit?|null; entry_execution_cost?|null; charge_origin?: BoxChargeOrigin; charge_rate_version?|null; entry_charge_reconciliation?|null; exit_charge_reconciliation?|null
  - Audit blobs: entry_execution?: BoxExecutionRecord|null; entry_legging?: PaperLeggingExecutionRecord|null; exit_execution?|null; exit_legging?|null; residual_exposure?: ResidualLegExposure[]|null
  - Monitoring: opened_at: Date; current_remaining_edge|null; current_captured_edge?|null; current_captured_pct?|null
  - Close and P&L: exit_box_value|null; exit_charges|null; gross_pnl|null; total_charges|null; net_pnl|null; realised_net_pnl?|null (closed only); closed_at: Date|null; exit_reason: BoxExitReason|null; close_idempotency_key?|null
  - Other: exit_blocked_reason: string|null; expiry_safety: boolean; scanner_config_snapshot: BoxScannerConfigSnapshot; error: string|null

**J. Events (append-only ledger)**
- `BoxEventType` (1659), 20 values: "DETECTED", "ENTRY", "ENTRY_REJECTED_STALE", "ENTRY_REJECTED_LIQUIDITY", "ENTRY_REJECTED_FEES", "ENTRY_REJECTED_DUPLICATE", "ENTRY_REJECTED_NET_PROFIT", "ENTRY_REJECTED_EXECUTION", "EXIT_TRIGGERED", "EXIT", "EXIT_SKIPPED_LIQUIDITY", "EXPIRY_SAFETY", "CHARGES_RECONCILED", "EXECUTION_ABORTED", "SCANNER_STARTED", "SCANNER_STOPPED", "SCANNER_CONFIG", "TRADE_DELETED", "BROKER_SWITCHED", "ERROR".
- `IBoxTradeEvent` (1694):
  - event; at: Date; trade_id|null; candidate_key; underlying; expiry; direction?; lower_strike; upper_strike; lot_size; quantity; execution_mode; broker?
  - Figures: box_width|null; box_cost|null; gross_edge|null; entry_charges_total|null; exit_charges_total|null; safety_buffer|null; net_edge|null; expected_net_profit?|null; execution_cost?|null; gross_pnl|null; net_pnl|null; remaining_edge|null; captured_edge?|null; captured_pct?|null
  - execution?: BoxExecutionRecord|null; legs: BoxEventLeg[]; reason: string|null; detail: string|null
- `BoxEventLeg` (1736): role; side; token; tradingsymbol; price|null; bid; bid_qty; ask; ask_qty; quote_at: Date|null; age_ms|null.

**K. Exit / convergence**
- `BoxExitDecision` (1763): should_exit: boolean; reason: BoxExitReason|null; rule_reason|null; remaining_edge|null (₹); captured_edge|null; captured_pct|null; gross_pnl|null; net_pnl|null; executable: boolean; blocked_reason: BoxExitBlockedReason.
- `BoxExitMetrics` (1781):
  - at (epoch ms); direction; legs: BoxLegEvaluation[]
  - Exit value: exit_net_credit_per_unit|null; exit_box_value_per_unit|null (same value); exit_box_value|null
  - P&L: gross_pnl_if_closed_now|null; estimated_exit_charges|null; total_round_trip_charges|null; current_net_pnl|null; estimated_execution_cost: number; realisable_net_pnl|null
  - Edge: remaining_edge|null; entry_edge: number; captured_edge|null; captured_pct|null; convergence_threshold: number; min_exit_net_pnl: number; profit_capture_target: number; min_captured_pct: number
  - time_in_trade_ms|null; liquidity_ok: boolean; worst_age_ms|null; rule_reason|null; exit_eligible: boolean; exit_reason|null; blocked_reason; decision: BoxExitDecision
  - partial_exit_mark?: PartialExitMark. When present, the P&L fields are partial-aware but the edge family stays whole-box.
- `PartialExitMark` (partialExitPnl.ts:94): realised_gross: number; unrealised_gross|null; gross|null; exit_charges_incurred: number; estimated_remaining_exit_charges|null; exit_charges_total|null; round_trip_charges|null; net|null; realisable_net|null; marked_quantity_by_role: Record of BoxLegRole to number.

##### Units (where they matter)
- Prices are ₹ per unit (option premium; strike width is also ₹/unit). Fields ending `_per_unit` are per unit. Their non-suffixed siblings (gross_edge, slippage) are × lot_size.
- All charges, edges, P&L and allowances are ₹ floats, not paise.
- Time representations are mixed:
  - In-memory and audit-blob records use epoch-ms numbers: BoxQuote.at/exchange_at, BoxLegEvaluation.quote_at, BoxExecutionRecord.*, PaperLegExecution.*, ResidualLegExposure.created_at, BoxExitMetrics.at, BoxOpportunity.updated_at.
  - Persisted top-level fields use Date: IBoxLeg.*_quote_at, BoxEventLeg.quote_at, IBoxTrade.opened_at/closed_at, IBoxExecutionAttempt.detected_at/resolved_at, intent created/updated/terminal_at, BoxCharges.at.
- `pct_diff` is a percent. `captured_pct`, `convergence_pct` and `min_captured_pct` are fractions. `queue_liquidity_haircut_pct` is ambiguous.

---------------------------------------------------------------------
#### 2. src/box/index.ts (179 lines)

**Purpose.** The DI seam between the app's index.ts and the box module. It adapts the concrete KiteClient and TickerHub into broker-neutral providers, builds the engine and registers routes.

**Exports:**
- `interface BoxModuleDeps` (39)
- `interface BoxModule { boot: () => Promise<void>; engine: BoxEngine }` (114)
- `function registerBoxModule(app: Express, deps: BoxModuleDeps): BoxModule` (141)
- `export { BoxEngine }` (178) and `export type { BoxBoardItem }` (179)

**BoxModuleDeps fields:**
- Required:
  - kite: KiteClient; tickerHub: TickerHub
  - getAllInstruments(): Promise of Instrument[]; getBoard(): Promise of BoxBoardItem[]
  - priceChargeGroups: PriceChargeGroupsFn; istDayKey(at?: number): string
  - makeIdResolver(all: Instrument[]): (token: number) => string|null
  - isMarketOpen(): boolean
  - getBasketMargin(orders: {exchange, tradingsymbol, transaction_type: "BUY"|"SELL", variety, product, order_type, quantity, price}[]): Promise of {initial, final, total}
  - requireAdmin: RequestHandler; getAdminRole(token?: string): "full"|"trade"|null
- Optional: activeBroker?(): BrokerId; brokerGeneration?(): number; marketData?: BoxMarketDataProvider; margins?: BoxMarginProvider; feed?: BoxFeedProvider; charges?: BoxChargeCalculatorLike; createLiveAdapter?: BoxLiveAdapterFactory (required for live mode; the engine refuses to start live without it).

**Private `kiteMarketData(kite)` (~127):** returns `{ isAuthenticated: () => kite.getAccessToken() !== null, getQuoteFull: ids => kite.getQuoteFull(ids) }`.

**Bootstrap order inside `registerBoxModule` (all synchronous, nothing awaited):**
1. `new BoxEngine({...})` (ONE instance per call; effectively an app singleton). Each dependency, with its default:
   - marketData = `deps.marketData ?? kiteMarketData(deps.kite)`
   - activeBroker = `deps.activeBroker ?? (() => "zerodha")`
   - brokerGeneration is spread in ONLY if defined. The engine uses `?.() ?? 0` (engine.ts:736,766).
   - feed = `deps.feed ?? deps.tickerHub` (structurally typed)
   - charges = `deps.charges ?? new LocalChargeCalculator()` (a fresh instance)
   - getAllInstruments, getBoard, priceChargeGroups, istDayKey, makeIdResolver, isMarketOpen are passed through unchanged
   - margins = `deps.margins ?? { broker: "zerodha", basketMargin: async orders => ({ ...(await deps.getBasketMargin(orders)), source: "kite_basket" }) }`
   - createLiveAdapter is spread in only if truthy
2. `registerBoxRoutes(app, { engine, requireAdmin, getAdminRole })` mounts the HTTP routes immediately.
3. Returns `{ boot: () => engine.boot(), engine }`. The caller must call boot() after the DB is connected; boot adopts open positions and starts the always-on monitor.

There is no module-level mutable state in index.ts. All mutable state lives inside the BoxEngine instance (not read here).

---------------------------------------------------------------------
#### 3. src/box/serialize.ts (128 lines)

**Purpose.** Pure wire-format functions with no DB, no clock and no network.

**Exports:**
- `interface BoxTradeDocLike extends IBoxTrade { _id: { toString(): string } }` (13)
- `function serializeBoxTrade(doc: BoxTradeDocLike)` (18-98). Pure; return type inferred.
- `type SerializedBoxTrade = ReturnType of serializeBoxTrade` (100)
- `function tradeKey(t: {underlying: string; expiry: string; lower_strike: number; upper_strike: number; direction?: string|null}): string` (103). Pure: `candidateKey(underlying, expiry, lower, upper, directionOf(t))`, i.e. `${u}|${e}|${k1}|${k2}|${LONG_BOX|SHORT_BOX}`. Any direction other than exact "SHORT_BOX" gives LONG_BOX. Strikes use JS Number→string (22500, 22512.5, no ".0"); in Go use `strconv.FormatFloat(x,'f',-1,64)`.
- `function toEventLegs(legs: BoxLegEvaluation[]): BoxEventLeg[]` (114). Pure. Copies role, side, token, tradingsymbol, price, bid, bid_qty, ask, ask_qty, age_ms as-is. `quote_at`: null stays null, otherwise `new Date(epochMs)`. Drops qty_at_touch, strike, instrument_type, exchange_at, quote_version, depth, fresh and executable.

**serializeBoxTrade field mapping, in output key order.** There is NO rounding anywhere. Dates use `Date.toISOString()`, which is ALWAYS UTC with exactly 3 ms digits and a "Z" (e.g. `2024-09-26T03:45:00.000Z`). In Go that is `t.UTC().Format("2006-01-02T15:04:05.000Z")`, NOT RFC3339Nano.

| out key | source | transform |
|---|---|---|
| id | `_id.toString()` | hex ObjectId string |
| execution_mode | doc.execution_mode | as-is |
| broker | `brokerOf(doc)` | invalid or absent gives "zerodha" |
| underlying, name, is_index, expiry | as-is | |
| direction | `directionOf(doc)` | absent gives LONG_BOX |
| lower_strike, upper_strike, lot_size, quantity, status | as-is | |
| legs[] | per-leg map, see below | |
| box_width | as-is | |
| margin | `?? null` | |
| entry_box_cost, entry_gross_edge | as-is | |
| entry_charges, estimated_exit_charges | `?? null` | object passed raw; its nested `at` Date becomes ISO through JSON.stringify |
| safety_buffer, entry_net_edge | as-is | |
| expected_net_profit, entry_execution_cost | `?? null` | |
| charge_origin | `?? "local"` | |
| charge_rate_version, entry_charge_reconciliation, exit_charge_reconciliation, entry_execution, entry_legging, exit_execution | `?? null` | raw blobs (epoch-ms numbers inside) |
| opened_at | `.toISOString()` | throws if missing |
| current_remaining_edge | as-is (NO `?? null`) | |
| current_captured_edge, current_captured_pct | `?? null` | |
| exit_box_value | as-is | |
| exit_charges | `?? null` | |
| gross_pnl, total_charges, net_pnl | as-is | |
| realised_net_pnl | `?? null` | |
| closed_at | ISO or null | |
| exit_reason, exit_blocked_reason, expiry_safety | as-is | |
| scanner_config_snapshot | as-is (raw subdoc) | |
| error | as-is | |

**Legs mapping**, in this key order:
- role, token, tradingsymbol, exchange, strike, instrument_type, side
- entry_price, entry_bid, entry_bid_qty, entry_ask, entry_ask_qty
- entry_quote_at (ISO or null); entry_depth `?? null`; detected_price `?? null`; entry_slippage `?? null`
- exit_price, exit_bid, exit_bid_qty, exit_ask, exit_ask_qty (as-is, no `?? null`)
- exit_quote_at (ISO or null); exit_depth `?? null`; exit_detected_price `?? null`; exit_slippage `?? null`

**OMITTED from the API shape:** exit_legging, residual_exposure, remaining_qty_by_role, position_state, exit_attempts, cumulative_exit_charges, close_idempotency_key, __v. All IBoxTrade fields not listed above are dropped.

**Gotcha: undefined vs null.** Fields copied "as-is" without `?? null` (current_remaining_edge, exit_box_value, gross_pnl, total_charges, net_pnl, exit_reason, exit_blocked_reason, error, the leg exit_* scalars) are OMITTED from the JSON when undefined, not emitted as null. Mongoose defaults write them as null, so on normal docs they appear as null. The nested raw objects (scanner_config_snapshot, charges, depth) serialize with whatever keys exist in the stored document. Whether these come from lean or hydrated docs decides whether schema defaults appear; repository.ts was not checked.

---------------------------------------------------------------------
#### 4. src/box/instrumentKey.ts (153 lines)

**Purpose.** A canonical per-CONTRACT identity, broker-namespaced, used by same-leg reservation (finer than the pair-level candidateKey). Every function is pure.

**Exports:**
- `type InstrumentKeyBroker = "zerodha" | "dhan"` (35)
- `interface InstrumentLegRef { readonly key: string; readonly role: BoxLegRole; readonly side: OrderSide; readonly token: number; readonly tradingsymbol: string; readonly exchange: string }` (46)
- `function instrumentKey(broker: InstrumentKeyBroker | string, inst: Pick of BoxOptionInstrument for "token"|"tradingsymbol"|"exchange"): string` (67)
- `function boxInstrumentRefs(broker: InstrumentKeyBroker | string, legs: Record of BoxLegRole to BoxOptionInstrument, sideFor: (role: BoxLegRole) => OrderSide, roles: readonly BoxLegRole[]): InstrumentLegRef[]` (93)
- `function keysOf(refs: readonly InstrumentLegRef[]): string[]` (115)
- `type InstrumentConflictKind = "same_side" | "opposite_side"` (133)
- `interface InstrumentConflict { readonly key: string; readonly kind: InstrumentConflictKind; readonly heldBy: string }` (135)
- `function classifyConflict(key: string, heldBy: string, incumbentSide: OrderSide | null, challengerSide: OrderSide): InstrumentConflict` (142)

**Key format (exact):**
- `ns = broker.trim().toUpperCase()` (private `normaliseBroker`, ~line 55).
- `symbol = inst.tradingsymbol?.trim()`. It is NOT uppercased.
- If symbol is non-empty: `${ns}:${(inst.exchange || "NFO").trim().toUpperCase()}:${symbol}`, e.g. `ZERODHA:NFO:RELIANCE24SEP2550CE`.
  - Edge case: the `||` fallback is applied BEFORE trim. An exchange of "" or undefined becomes "NFO", but a whitespace-only exchange becomes "" (`ZERODHA::SYM`).
- Otherwise: `${ns}:TOKEN:${inst.token}`.

**boxInstrumentRefs:**
- Maps `roles` in the given order. For each role it calls `instrumentKey`, `sideFor(role)` and copies token, tradingsymbol and exchange (raw, un-normalised).
- `legs[role]` has no null guard; a missing role throws a TypeError.
- Then sorts ascending by key with `<`/`>` (UTF-16 code-unit order, which equals Go byte order for ASCII). JS sort is stable, so use `sort.SliceStable` in Go.
- The sort gives a total lock order for future multi-key stores (deadlock avoidance) and deterministic conflict logs.

**keysOf.** Dedupes by key and preserves first-seen order.

**classifyConflict.** Returns `opposite_side` only if `incumbentSide !== null && incumbentSide !== challengerSide`, otherwise `same_side`. An unknown incumbent counts as same-side (the more restrictive option). Both kinds currently take the same "serialise and re-evaluate" path.

---------------------------------------------------------------------
#### 5. src/box/instrumentReservations.ts (90 lines)

**Purpose.** Re-export only, kept for import-path compatibility. It re-exports from `./reservations/core.js`, deliberately NOT `reservations/index.js`, because index pulls in mongoose → db.ts and would break offline unit tests.

**Re-exported list:**
- Types: AcquireArgs, InstrumentReservationStore, OwnershipVerdict, ReleaseArgs, RenewArgs, RenewOutcome, ReservationConflictDetail, ReservationContext, ReservationDurability, ReservationLease, ReservationOutcome, ReservationStoreDiagnostics, ReservationWaitable, VerifyArgs.
- Values: isWaitable, BoundedSamples, dedupeKeys, normaliseTtl, safeErrorMessage.
- Classes: InProcessInstrumentReservations, DurableInstrumentReservations, ChainedInstrumentReservations.
- Durable port: types DurableReservationDoc, DurableReservationPort, InsertReservationResult; values InMemoryReservationDatabase, InMemoryReservationPort.
- Identity: type ProcessIdentity; createProcessIdentity, mintOwnerId, isOwnedByProcess, processOwnerPrefix, resolveDeploymentId, isDeploymentIdExplicit.

**Documented architecture (header comment):**
- Tiers live in reservations/{types, identity, inProcess, port, durable, mongoStore, memoryStore, chained}.ts.
- The in-process tier is a fast pre-filter. MongoDB, through a unique multikey index, is the AUTHORITY for atomic four-leg claims across processes.
- `requireDurableReservations` makes live execution fail closed when the durable tier is unavailable.

**NODE SINGLE-THREAD DEPENDENCY.** `InProcessInstrumentReservations.tryAcquireAll` is atomic ONLY because it checks every key and then writes every key with no `await` in between, inside one event-loop turn. A Go port needs a `sync.Mutex` around the whole check-and-commit, and also around release/renew. The implementation is in reservations/inProcess.ts, which I did not read.

---------------------------------------------------------------------
#### 6. src/box/model.ts (1026 lines), brief

**General.**
- No `timestamps` option anywhere.
- No pre/post hooks and no virtuals.
- Every subdocument schema uses `{ _id: false }`.
- Default `versionKey` (`__v`) everywhere EXCEPT box_trading_session (`versionKey: false`, line 1007).
- Many fields default to `() => new Date()`.
- Lines 42-46 hold compile-time `AssertAssignable` checks: BoxLegCharges ⇄ ILegCharges and BoxCharges ⇄ ITradeCharges.
- `boxModel(name, schema)` (419) binds to `boxConnection` (db.ts:355, a module-level connection created when BOX_MONGODB_URI is set), otherwise the default mongoose connection. Models are registered at module import.
- `isBoxEventLedgerEnabled(): boolean` (495) returns true when the relevant connection's `readyState === 1`.

**Subdocument schemas:**
- depthLevel (50): price, qty, orders, all default 0.
- depthSnapshot (59): bids, asks, default [].
- boxLegCharges (72): side enum BUY/SELL required; the other fields default 0 or "".
- boxCharges (91):
  - legs; value, brokerage, stt, exchange_txn, sebi, stamp_duty, gst, total (default 0)
  - source enum [kite, kite_estimate] default "kite"
  - computed_by enum [local, kite, local_verified, dhan, dhan_estimate] default "local"
  - broker enum BROKER_IDS default "zerodha"; at default now
- chargeReconciliation (119): status enum [pending, verified, failed] default pending; local_total, reconciled_total, abs_diff, pct_diff null; head_diffs Mixed null; at null; error null.
- boxLeg (142):
  - role enum [k1_ce, k2_ce, k2_pe, k1_pe] required; token, tradingsymbol, strike required; exchange default "NFO"; instrument_type enum CE/PE required; side required
  - entry_price required; entry_bid/qty/ask/qty default 0; entry_quote_at, entry_depth, detected_price, entry_slippage default null
  - every exit_* defaults to null
- scannerConfig (181):
  - min_gross_edge, min_net_edge, min_expected_net_profit, safety_buffer, expected_entry/exit_slippage, quote_max_age_ms, convergence_floor/pct, min_exit_net_pnl, profit_capture_pct, min_captured_pct, simulated_decision/latency_ms all default 0
  - strikes_each_side default **3**
  - execution_mode enum default "paper_touch"
  - every live_*, one_active_box_per_underlying, session_max_completed_trades, leg_max_chase_ticks, unwind_max_chase_ticks, queue_model (String, no enum), queue_liquidity_haircut_pct, max_cross_leg_exchange_dispersion_ms default null
  - **GOTCHA:** `paper_execution_profile` (present in the type) is NOT in this schema, so Mongoose strict mode silently drops it on write.

**Models / collections:**

1. **BoxTrade → `box_trades`** (240-366, model 424)
   - Fields:
     - execution_mode enum default paper_touch; broker enum default zerodha (indexed); underlying required (indexed); name ""; is_index false; expiry required; direction enum default LONG_BOX
     - lower_strike, upper_strike, lot_size, quantity required; status enum [open, closed, error] default open (indexed); legs [boxLeg]; box_width required; margin null
     - entry_box_cost, entry_gross_edge, entry_net_edge required; entry_charges, estimated_exit_charges, exit_charges are boxCharges|null; safety_buffer 0; expected_net_profit, entry_execution_cost null; charge_origin enum default "local"; charge_rate_version null; entry/exit_charge_reconciliation null
     - Mixed, default null: entry_execution, entry_legging, exit_execution, exit_legging, residual_exposure, remaining_qty_by_role, exit_attempts
     - position_state enum [BOX, PARTIALLY_EXITED, RECOVERY, FLAT, null] default null; cumulative_exit_charges null; opened_at default now; current_remaining/captured_edge/pct null; exit_box_value, gross_pnl, total_charges, net_pnl, realised_net_pnl, closed_at, close_idempotency_key null
     - exit_reason enum [EDGE_CONVERGED, PROFIT_CAPTURE, MANUAL, EXPIRY_SAFETY, null] default null; exit_blocked_reason null; expiry_safety false; scanner_config_snapshot default {}; error null
   - Indexes:
     - UNIQUE PARTIAL `{underlying, expiry, lower_strike, upper_strike, direction}` where `{status:"open"}`, named `box_open_unique_pair_dir` (383-390). This is the atomic duplicate guard. The comment says the legacy `box_open_unique_pair` index should be dropped.
     - `{opened_at:-1}` (392)
     - `{status:1, closed_at:-1}` (408). Queries must use `$in:["closed","error"]`, not `$ne`.

2. **BoxTradeEvent → `box_trade_events`** (445-485, model 492)
   - Fields:
     - event (required, indexed, no enum); at (default now, indexed); trade_id (null, indexed); candidate_key ("" default, indexed); underlying, expiry ""; direction enum default LONG_BOX; strikes, lot_size, quantity default 0
     - execution_mode enum default paper_touch; broker enum default zerodha (indexed); every numeric figure defaults to null; execution Mixed
     - legs [boxEventLeg]. That subschema is at 428; its role is a String with no enum, side enum.
     - reason, detail null
   - Indexes: only the single-field ones listed above.

3. **BoxOrderIntent → `box_order_intents`** (517-573, model 597)
   - Fields:
     - Required: client_order_id; broker_mode enum [paper, live]; attempt_id; role enum; purpose enum [ENTRY, EXIT, EMERGENCY_RESIDUAL, PROTECTIVE_CANCEL]; phase enum [entry, exit, unwind]; exchange; tradingsymbol; token; side; quantity; reference_price; tick_size; max_chase_ticks; limit_price; created_at; updated_at
     - broker enum default zerodha (indexed; treated as immutable); broker_order_id, broker_correlation_id, trade_id null
     - state enum (11 values) default CREATED; filled_quantity 0; previous_filled_quantity null; average_price, broker_tag, reject_family, reject_reason, terminal_at null
     - audit [auditSchema]. auditSchema (503): audit_id required, at required, from_state null, to_state required, broker_order_id/message/fill_identity null, payload Mixed.
   - Indexes:
     - UNIQUE `{client_order_id}` named `box_order_intent_client_order_id`
     - UNIQUE `{broker_order_id}` with `sparse:true` AND `partialFilterExpression {broker_order_id: {$type:"string"}}`, named `box_order_intent_broker_order_id` (580-588). **GOTCHA:** as far as I know, MongoDB refuses to build an index with both sparse and partialFilterExpression. This index may never have been created in the live DB; check `getIndexes()`.
     - `{trade_id:1, created_at:-1}`, `{attempt_id:1, created_at:-1}`, `{state:1, updated_at:1}`

4. **BoxExecutionAttempt → `box_execution_attempts`** (610-686, model 717)
   - Fields:
     - candidate_key "" (indexed); direction enum default LONG_BOX; underlying "" (indexed); name; is_index; expiry; strikes, lot_size, quantity 0
     - execution_mode enum default **paper_legging**; broker default zerodha (indexed); leg_execution_mode String null (no enum)
     - detected_at default now; resolved_at default now (indexed); detected_gross_edge, expected_net_profit null; filled_leg_count 0; failed_legs [String]; failure_reason, failure_detail null
     - abort_after_fill false; outcome_class String null (no enum); required_expected_net_profit, charge_rate_version null; legging Mixed
     - partial_entry_charges, unwind_charges null
     - flatten_charges default **0** (type says nullable; accumulated with `$inc`); flatten_charge_day null; flatten_charges_for_day 0; projection_version 0; residual_projection_identity null; applied_flatten_applications [String] default []
     - gross_abort_pnl, net_abort_pnl null; residual_exposure Mixed null; resolved default **true** (indexed)
   - Indexes:
     - `{resolved_at:-1}`, `{resolved:1, resolved_at:-1}`
     - `{flatten_charge_day:1, flatten_charges_for_day:-1}` named `box_execution_attempt_flatten_charge_day`
     - UNIQUE PARTIAL `{candidate_key}` where `{candidate_key:"boot-recovery", resolved:false}`, named `box_single_unresolved_crash_recovery` (703-710). At most one unresolved crash-recovery row.

5. **BoxDailyPnl → `box_daily_pnl`** (750-772, model 786). A reporting archive drained nightly from Redis (the comment mentions a 9 PM drain).
   - Fields: day required (indexed); trade_id required (`"__summary__"` for the day aggregate); underlying; direction (String, default LONG_BOX); strikes; expiry; status String default "open" (values open, closed, summary); gross_pnl, net_pnl, realisable_net_pnl, realised_net_pnl null; opened_at, closed_at, updated_at are STRINGS; summary Mixed; archived_at default now.
   - Indexes: UNIQUE `{day, trade_id}` named `box_daily_pnl_day_trade`; `{trade_id, day}` named `box_daily_pnl_trade_day`.
   - `IBoxDailyPnl` (738) = Partial of BoxDailyPnlRow minus status, plus day, trade_id, status?, summary?, archived_at?.

6. **BoxPnlDeletion → `box_pnl_deletions`** (810-821, model 828)
   - `IBoxPnlDeletion` (799): _id: string (the trade id); status enum [pending, complete] default pending (pending moves to complete; completed fences are kept forever); candidate_days: string[]; attempts 0; created_at, updated_at default now; completed_at null; last_error null.
   - Index: `{status:1, _id:1}` named `box_pnl_deletions_status_id`.

7. **BoxPnlDayState → `box_pnl_day_states`** (850-863, model 878)
   - `IBoxPnlDayState` (838): _id: string (day); complete false; snapshot_version?, row_count?, content_sha256? (null defaults); needs_reproof false; expected_trade_ids? (legacy, default undefined, never written); updated_at now.
   - Indexes: `{snapshot_version, complete, _id}` and `{snapshot_version, needs_reproof, _id}`.

8. **BoxSetting → `box_settings`** (903-909, model 913)
   - `IBoxSetting` (896): _id: string (the setting key, e.g. "min_expected_net_profit"); value: number (required); updated_at now.
   - The env var is the default; a saved value overrides it at boot. No indexes.

9. **BoxCalibrationSample → `box_calibration_samples`** (926-940, model 966)
   - Fields (all required strings except where noted): broker, kind, profile, bucket, stage; value_ms Number (required); session (IST "YYYY-MM-DD", required); region String null; observed_at Date (required).
   - Indexes: `{region:1, observed_at:-1}` named `box_calibration_region_recent`; **TTL** `{observed_at:1}` with `expireAfterSeconds: 14*24*60*60 = 1,209,600` named `box_calibration_ttl` (948-951). The comment refers to `BOX_PAPER_CALIBRATION_MAX_AGE_MS` = 3 days.
   - `IBoxCalibrationSample` interface at 953.

10. **BoxTradingSession → `box_trading_session`** (988-1007, model 1023). A SINGLETON document with `_id:"current"`, NO TTL, `versionKey:false`.
    - `IBoxTradingSessionDoc` (1010): _id; session_id ""; armed_at null; armed_by (admin role label) null; max_completed_trades 0 (snapshotted at arm time); established_trade_ids [] (a cycle is consumed here); completed_trade_ids [] (a cycle is completed here); aborted_attempts 0; arm_count 0; updated_at null.
    - It is durable so that restarting the process cannot reset the session budget.

**Record interfaces exported:** BoxTradeRecord (410), BoxOrderIntentRecord (593), BoxExecutionAttemptRecord (712) and BoxDailyPnlRecord (781). Each one adds `_id: ObjectId` to its base type.

**Enum notes for Go.** These fields are String with NO enum in Mongo: event.event, eventLeg.role, attempt.leg_execution_mode, attempt.outcome_class, attempt.failure_reason, scanner.queue_model, dailyPnl.status/direction. The values match the TS unions but are not enforced in the DB.

---------------------------------------------------------------------
#### 7. Node single-thread / shared-state hazards (need Go synchronisation)

1. **instrumentReservations / reservations/inProcess.** `tryAcquireAll` relies on synchronous check-then-write within one event-loop turn (header comment of instrumentReservations.ts; also instrumentKey.ts comment ~line 85, "commits all-or-none inside a single synchronous pass"). In Go, hold a mutex over the whole multi-key check+commit, and over release/renew.
2. **BoxQuote immutability** (types.ts:236-244). The quote store replaces the object and never mutates it, and readers hold references as permanent snapshots. In Go, store immutable structs behind `atomic.Pointer`, or a map guarded by an RWMutex with copy-on-write. Never mutate in place, including the `bids`/`asks` slices.
3. **IBoxOrderIntent.previous_filled_quantity** (~1225). It documents that two async contexts (live submit and reconcile) hold the same stale snapshot. Goroutines make this worse. Fill deltas must come from a single atomic DB update (findOneAndUpdate with the pre-image), never from in-memory snapshots.
4. **model.ts module-level singletons.** `boxConnection` is created at import (db.ts:355), and the mongoose model registry is populated at import; a duplicate registration would throw. In Go, create collection handles once (`sync.Once`) and make them read-only afterwards. `isBoxEventLedgerEnabled` polls connection readiness.
5. **index.ts.** The BoxEngine is a de-facto process singleton holding all mutable scanner and position state, accessed from routes, the ticker callbacks and timers. In Node these interleave only at awaits; in Go every engine map/field needs a mutex, or a single-goroutine actor.
6. **`brokerGeneration`/`activeBroker`** are closures read live on every call; they can change during a broker switch. Read them atomically in Go.
7. **LocalChargeCalculator** is constructed per engine (index.ts default). Whether it is stateful was not checked.
8. The **constants in types.ts are frozen literals** (`as const`, `Readonly`) and safe to share. In Go, use package-level values that are never mutated, or functions that return copies.


---

## 3. Pure core: `math.ts`, `orderPricing.ts`, `positions.ts`, `boxCapital.ts`, `marginReplay.ts`, `stressProfile.ts`, `singleLotInvariant.ts`, `entrySubmissionOrder.ts`

> Reader gaps (not verified in this pass): No annualised-return formula anywhere in src/box. No VWAP or depth walk in math.ts (it is in orderPricing.walkDepth). No multi-step limit-price ladder in orderPricing.ts: it computes a single bounded chase limit, and any re-pricing loop would be in executionPolicy.ts, executionGateway.ts or legExecutor.ts, which were not read. No broker-margin requirement formula: margin is broker-supplied, and boxCapital is gross notional only. The paper execution-profile parameter sets (live_parity etc.) are defined outside stressProfile.ts (likely config.ts loadBoxConfig or executionSimulator.ts), not read.

SCOPE NOTE. I read all 8 files in full (math.ts 1–1199, orderPricing.ts 1–302, positions.ts 1–285, boxCapital.ts 1–295, marginReplay.ts 1–85, stressProfile.ts 1–190, singleLotInvariant.ts 1–98, entrySubmissionOrder.ts 1–107). I also read the supporting definitions in types.ts (lines 175, 186–228, 367–385, 779, 1385, 1440–1453) and config.ts (1152–1169). Paths below are relative to src/box/.

Things that are NOT in these files:
- No annualised-return formula. grep for "annuali" across src/box finds nothing.
- No VWAP/depth walk in math.ts. Its rule 2 says it never walks the book. The VWAP walk is orderPricing.walkDepth.
- No multi-step re-pricing ladder in orderPricing.ts. The "chase" is one bounded limit. Callers that might loop are executionPolicy.ts:89 and executionGateway.ts:911 (buildOrderPricing), and executionSimulator.ts:1140, legExecutor.ts:749, executionGateway.ts:114 and :992 (walkDepth).
- No margin-requirement formula. Margin comes from the broker and is stored on positions as `margin`. boxCapital only computes gross order notional.
- The paper-profile parameter sets (live_parity, etc.) are not defined in stressProfile.ts. That file only holds the fault schedule and the report banner.

=====================================================================
SHARED DEFINITIONS (types.ts / config.ts) used everywhere
=====================================================================
- types.ts:186 `type BoxDirection = "LONG_BOX" | "SHORT_BOX"`; BOX_DIRECTIONS = ["LONG_BOX","SHORT_BOX"].
- types.ts:190 `type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe"`.
- types.ts:193–198 BOX_LEG_ROLES = ["k1_ce","k2_ce","k2_pe","k1_pe"]. This canonical order drives every loop, every first-error message and every output ordering.
- types.ts:208–214 BOX_ENTRY_SIDES_BY_DIRECTION:
    LONG_BOX : k1_ce BUY,  k2_ce SELL, k2_pe BUY,  k1_pe SELL
    SHORT_BOX: k1_ce SELL, k2_ce BUY,  k2_pe SELL, k1_pe BUY
  BOX_ENTRY_SIDES = the LONG_BOX map (types.ts:216–217).
- types.ts:226–228 directionSign(d) = LONG_BOX ? +1 : -1.
- types.ts:1385 BoxPositionState = "BOX" | "PARTIALLY_EXITED" | "RECOVERY" | "FLAT".
- types.ts:1440 BoxExitReason = EDGE_CONVERGED | PROFIT_CAPTURE | MANUAL | EXPIRY_SAFETY.
- types.ts:1447 BoxExitBlockedReason = insufficient_exit_liquidity | net_below_floor | unpriced_charges | market_closed | feed_unhealthy | null.
- types.ts:367+ BoxRejectReason includes no_quote, stale_quote, missing_bid, missing_ask, insufficient_qty, below_gross_prefilter, below_net_edge, below_expected_net_profit, execution_failed, unpriced_charges, duplicate_open, stale_underlying, market_closed, implausible_close.
- types.ts:175 BoxQueueModel = "none" | "haircut".
- types.ts:779 PaperOrderType = "MARKETABLE_LIMIT" | "PASSIVE_LIMIT".
- config.ts:1152–1156 requiredNetProfit(cfg) = max(cfg.minExpectedNetProfit, cfg.minNetEdge > 0 ? cfg.minNetEdge : 0).
- config.ts:1167–1169 prefilterGrossThreshold(cfg) = max(0, cfg.minGrossEdge). evaluateEntryDecision does NOT use this; it compares against raw cfg.minGrossEdge (see below).

=====================================================================
GLOBAL ROUNDING / JS→GO PARITY HAZARDS (apply to all files)
=====================================================================
R1. round2(v) = Math.round(v*100)/100. It is defined twice, identically: exported at math.ts:60–62 and private at orderPricing.ts:47–49.
  - JS Math.round rounds to the nearest integer, and ties go toward +∞. So Math.round(2.5)=3 and Math.round(-2.5)=-2.
  - Go math.Round sends ties away from zero, so math.Round(-2.5)=-3. math.RoundToEven also differs.
  - They agree for positives and differ only for negative exact ties. Note: an "exact tie" means after the v*100 float multiply. For example 1.005*100 = 100.49999999999999, which gives 100.
  - Faithful Go: `f := math.Floor(x); if x-f >= 0.5 { f++ }`. Do NOT use math.Floor(x+0.5): it is wrong for 0.49999999999999994 (JS returns 0) and for large odd values.
  - JS also returns -0 for x in [-0.5, 0). JSON.stringify(-0) gives "0", but Go encoding/json emits "-0". Normalise -0 to +0 before marshalling.
R2. Places where negative values reach Math.round, so the tie behaviour matters:
  - math.ts:77 slippagePerUnit (favourable slippage is negative).
  - math.ts:151 receive_to_exchange_delay_ms (clock skew).
  - math.ts:536 netDebitPerUnit (always negative for SHORT_BOX).
  - math.ts:540/541 gross per-unit and gross edge (negative when unprofitable).
  - math.ts:575 projectedNetEdge.
  - math.ts:639–646 allowances, if negative config.
  - math.ts:784, 844, 845 (indicative path).
  - math.ts:912 convergenceThreshold (if entryNetEdge is negative and the floor is negative).
  - math.ts:931 exitNetCreditPerUnit (negative for SHORT_BOX).
  - math.ts:1004 grossPnl, 1009 netPnl, 1016 floorNet, 1021 remainingEdge, 1022 capturedEdge, 1026 capturedPct, 1029 captureTarget, 1127 entryEdge, 1147 exitBoxValue, 1154 realisable.
  - orderPricing.ts:54 roundToTick, when a SELL reference minus chase goes negative.
  - orderPricing.ts:286 offsetTicks (negative for PASSIVE orders).
  - Safe (always positive): boxCapital toPaise/fromPaise (limit is checked > 0 first), orderPricing.ts:70/99 Math.round(maxChaseTicks) (then clamped by max(0,·), so any tie difference collapses to 0), and Math.floor sites (math.ts:258 index; orderPricing.ts:121 positive; stressProfile.ts:111/128 positive).
R3. FMA. The Go spec allows x*y+z fusion on arm64/ppc64/s390x and amd64 v3. Force rounding with an explicit float64(x*y) at these sites:
  - math.ts:525 netDebit += sign*price
  - math.ts:540 / 844 / 1021 / 1127 sign*width - x
  - math.ts:912 pct*edge inside max (no add, so low risk)
  - orderPricing.ts:70–71 ref ± n*tick
  - orderPricing.ts:209 valueSum += price*take
  - math.ts:930 credit += -sign*price
R4. Summation order matters bit-for-bit. Sum in BOX_LEG_ROLES order (math.ts loops), in level order after a STABLE sort (walkDepth), and in input order (peakConcurrentMargin).
R5. JS sort is stable (ES2019+). Use sort.SliceStable in walkDepth (orderPricing.ts:186) so equal-price levels keep their original order.
R6. Number.isSafeInteger means integral and |v| ≤ 2^53-1. JS has no int/float split, so 75.0 passes. Number.isInteger (boxCapital.ts:116) also accepts integers above 2^53.
R7. JS `a || b` on numbers falls back when a is 0 or NaN (math.ts:214/219). `??` falls back only on null/undefined. `!(x > 0)` is also true for NaN.
R8. Template-literal number formatting (candidateKey, error/detail strings) uses JS shortest round-trip format. strconv.FormatFloat(v,'f',-1,64) matches for normal magnitudes. JS switches to exponent form at ≥1e21 or below 1e-6. String(undefined)="undefined", String(NaN)="NaN", String(null)="null".

=====================================================================
1. math.ts — Box arithmetic core
=====================================================================
PURPOSE. Pure functions (no clock, I/O or DB; "now" is passed in). Covers touch pricing, the ATM strike window, candidate enumeration, entry evaluation and decision, indicative (market-closed) evaluation, and exit evaluation and decision. No classes, no module state.

IMPORTS (math.ts:37–58):
- config.js: type BoxConfig, requiredNetProfit.
- singleLotInvariant.js: singleLotLegViolation.
- types.js: BOX_ENTRY_SIDES_BY_DIRECTION, BOX_LEG_ROLES, directionSign, plus the types BoxCandidate, BoxDirection, BoxEntryDecision, BoxEvaluation, BoxExitBlockedReason, BoxExitDecision, BoxExitMetrics, BoxExitReason, BoxLegEvaluation, BoxLegRole, BoxOptionInstrument, BoxQuote, BoxRejectReason, OrderSide.
- temporalCoherence also returns import("./types.js").BoxTemporalCoherence.

CORE IDENTITY (header math.ts:19–33):
  netDebitPerUnit  = Σ over legs (+price if BUY, −price if SELL)
  grossEdgePerUnit = directionSign × width − netDebitPerUnit
  LONG : netDebit = Ask(K1CE) − Bid(K2CE) + Ask(K2PE) − Bid(K1PE); edge = width − cost
  SHORT: netDebit = Ask(K2CE) + Ask(K1PE) − Bid(K1CE) − Bid(K2PE) = −credit; edge = credit − width

EXPORTS / FUNCTIONS

- `export function round2(v: number): number` (60–62). Math.round(v*100)/100. See R1.

- `export function slippagePerUnit(side: OrderSide, detected: number | null, executed: number | null): number | null` (71–78).
  null if either input is null. Else round2(BUY ? executed − detected : detected − executed). Positive is adverse.

- `export function entrySideFor(role: BoxLegRole, direction: BoxDirection = "LONG_BOX"): OrderSide` (81–83).
  Returns BOX_ENTRY_SIDES_BY_DIRECTION[direction][role].

- `export function exitSideFor(role: BoxLegRole, direction: BoxDirection = "LONG_BOX"): OrderSide` (86–88).
  The reverse of the entry side.
  LONG exit : k1_ce SELL, k2_ce BUY, k2_pe SELL, k1_pe BUY.
  SHORT exit: k1_ce BUY, k2_ce SELL, k2_pe BUY, k1_pe SELL.

- `function debitSign(side): 1 | -1` (91–93, private). BUY gives +1, SELL gives −1.

- `export function temporalCoherence(legs: {received_at: number|null; exchange_at: number|null; current_version: number|null; detection_version: number|null}[], now: number): BoxTemporalCoherence` (112–154). Measures only; never rejects.
  - received = non-null received_at values; exchange = non-null exchange_at values; ages = now − received (can be negative).
  - receive_dispersion_ms = (received.length ≥ 2) ? round2(max − min) : null (125–126).
  - exchange_dispersion_ms = (exchange.length === legs.length AND legs.length ≥ 2) ? round2(max − min) : null (128–131).
  - books_changed_during_latency = count of legs where both versions are non-null and current ≠ detection (133–142).
  - oldest_quote_age_ms = round2(max(ages)) or null; newest_quote_age_ms = round2(min(ages)) or null.
  - legs_with_exchange_ts = exchange.length.
  - receive_to_exchange_delay_ms[] = per leg round2(received − exchange) or null.

- `export function bestPrice(levels: {price:number; qty:number}[], side: "bid"|"ask"): number | null` (169–180).
  - Skips levels where !(price > 0), which also skips NaN.
  - Takes the max for bid and the min for ask. IGNORES qty: a level with qty 0 can still be the best price. Contrast orderPricing.touchPrice, which requires qty > 0.
  - Returns null if the side is empty.

- `export function qtyAtPrice(levels, price: number): number` (189–197).
  Σ qty over levels with lv.price === price (exact float equality) AND qty > 0. Duplicated price levels are summed. No deeper walk.

- `export function touchFor(quote: BoxQuote, side: OrderSide): { price: number | null; qty: number }` (207–221).
  - BUY: price = bestPrice(asks,"ask") ?? (quote.ask > 0 ? quote.ask : null). If null, return {null, 0}.
    qty = qtyAtPrice(asks, price) || (quote.ask === price ? quote.ask_qty : 0).
  - SELL: the same with bids, bid and bid_qty.
  - The `||` fallback fires when the depth qty at that price is 0 (R7).

- `export function cloneDepth(quote: BoxQuote): {bids; asks}` (224–229). Shallow copy of each level.

- `export function atmStrikeFor(strikes: number[], spot: number): number | null` (236–248).
  - Empty input gives null.
  - Sorts ascending (no dedupe). best = sorted[0]; replaces only when distance is strictly smaller (243), so TIES GO TO THE LOWER strike.

- `export function strikeStepOf(strikes: number[]): number` (252–259).
  - Dedupe and sort; fewer than 2 strikes gives 0.
  - gaps = adjacent differences, sorted ascending; returns gaps[Math.floor(gaps.length/2)].
  - For an even gap count this is the UPPER-middle element, not an average.

- `export function selectStrikeWindow(strikes: number[], spot: number, eachSide = 3): { atm: number; window: number[] } | null` (269–281).
  - Dedupe and sort ascending; atm = atmStrikeFor; idx = indexOf(atm).
  - lo = max(0, idx − eachSide); hi = min(len − 1, idx + eachSide); window = sorted[lo..hi] inclusive.
  - At most 2·eachSide+1 strikes. Lopsided near chain ends: no compensation on the other side.
  - Default eachSide = 3 (line 272).

- `export function shouldRecentreWindow(currentAtm: number, spot: number, strikeStep: number, hysteresis: number): boolean` (291–300).
  false if !(strikeStep > 0). Else |spot − currentAtm| > strikeStep × (0.5 + hysteresis), a STRICT comparison (299). The constant 0.5 is at line 299.

- `export function candidateKey(underlying: string, expiry: string, k1: number, k2: number, direction: BoxDirection = "LONG_BOX"): string` (314–322).
  Returns `${underlying}|${expiry}|${k1}|${k2}|${direction}`. Numbers use JS formatting (R8).

- `export function buildCandidates(args: { underlying: string; name: string; is_index: boolean; expiry: string; lot_size: number; strikes: number[]; ce: Map<number, BoxOptionInstrument>; pe: Map<number, BoxOptionInstrument>; directions?: readonly BoxDirection[] }): BoxCandidate[]` (334–385).
  END TO END:
  (1) Line 347: if !Number.isSafeInteger(lot_size) OR lot_size ≤ 0, return [].
  (2) Line 348: sorted = dedupe(strikes), sorted ascending numerically. The caller passes the window, normally from selectStrikeWindow; this function does NOT window or ATM-filter.
  (3) Line 349: directions = args.directions ?? ["LONG_BOX"].
  (4) Lines 351–352: double loop over i, then j from i+1. k1 = sorted[i], k2 = sorted[j], so k1 is always strictly below k2. Seven strikes give 21 pairs.
  (5) Lines 355–359: needs ce.get(k1), ce.get(k2), pe.get(k2) and pe.get(k1). If any is missing, skip the pair.
  (6) Line 360: legs = {k1_ce, k2_ce, k2_pe, k1_pe}. This key insertion order matters for Object.values in positions.tokens().
  (7) Line 361: if singleLotLegViolation(lot_size, legs) is non-null, skip. Every leg's instrument.lot_size must be a positive safe integer and equal to lot_size.
  (8) Line 362: for each direction, in the given order, push a candidate.
  FILTERS, IN ORDER: candidate lot validity → leg presence → per-leg lot equality.
  There are NO width, edge, price or liquidity filters and NO sorting. Output order is (i asc, j asc, then the order of the directions array).
  CANDIDATE FIELDS: key (candidateKey(underlying, expiry, k1, k2, direction)), underlying, name, is_index, expiry, direction, lower_strike = k1, upper_strike = k2, box_width = round2(k2 − k1) (line 372), lot_size, legs.

- `function evaluateLeg(args: {role; side; inst; quote: BoxQuote|undefined; lotSize; now; maxAgeMs; captureDepth}): BoxLegEvaluation` (395–454, private).
  - No quote: price null, qty_at_touch 0, bid/ask/qty all 0, quote_at/exchange_at/quote_version/depth/age_ms null, fresh false, executable false.
  - Otherwise:
    - age = now − quote.at (429).
    - fresh = age ≥ 0 ? age ≤ maxAgeMs : false (430). A negative age (quote from the future) is NOT fresh. The ≤ is inclusive.
    - touch = touchFor(quote, side). Copies bid, bid_qty, ask, ask_qty, quote_at = quote.at, exchange_at, quote_version = quote.version.
    - depth = captureDepth ? cloneDepth : null.
    - executable = touch.price !== null AND touch.price > 0 AND touch.qty ≥ lotSize (452). A whole lot must sit at the exact touch. Freshness is NOT part of `executable`.

- `function firstRejectReason(legs, lotSize): BoxRejectReason | null` (457–470, private). Priority order. Each category is checked across all four legs before moving on:
  (a) any quote_at === null gives "no_quote" (461);
  (b) any !fresh gives "stale_quote" (462);
  (c) any price null or !(price > 0) gives "missing_ask" if that leg's side is BUY, else "missing_bid" (463–466). The first such leg decides;
  (d) any qty_at_touch < lotSize gives "insufficient_qty" (468);
  (e) otherwise null.

- `export function evaluateCandidate(args: {candidate: BoxCandidate; quotes: Map<number, BoxQuote>; now: number; maxAgeMs: number; captureDepth?: boolean}): BoxEvaluation` (486–558).
  - direction = candidate.direction ?? "LONG_BOX"; sides from the map. Loops roles in canonical order (508).
  - For priced legs: netDebit += debitSign(side)·price. Unrounded accumulation in role order; havePrices = false if any leg price is null.
  - worstAge = max of leg age_ms, counting agesSeen. version = max of quote_version (non-null, non-undefined).
  - depthOk = false if any leg fails (price > 0 AND qty ≥ lot) (533). Freshness is not considered.
  - Formulas:
    netDebitPerUnit = havePrices ? round2(netDebit) : null (536)
    grossPerUnit = round2(sign·box_width − netDebitPerUnit) (538–540). Uses the ROUNDED netDebitPerUnit.
    grossEdge = round2(grossPerUnit · lot_size) (541). Uses the ROUNDED per-unit value.
  - Output: candidate; at = now; legs; entry_net_debit_per_unit = entry_box_cost_per_unit = netDebitPerUnit; gross_edge_per_unit; gross_edge.
    tradable = reject === null AND grossEdge !== null (553); depth_ok; worst_age_ms = (agesSeen === 4) ? worstAge : null (555); quote_version; reject = firstRejectReason.
  - Edges are reported even when stale or thin, so the UI can show near-misses.

- `export function projectedNetEdge(args: {grossEdge: number; entryCharges: number; estimatedExitCharges: number; safetyBuffer: number; executionCost?: number}): number` (568–580).
  round2(grossEdge − entryCharges − estimatedExitCharges − (executionCost ?? 0) − safetyBuffer). Left-to-right subtraction, one rounding at the end.

- `export function evaluateEntryDecision(args: {grossEdge: number|null; entryCharges: number|null; estimatedExitCharges: number|null; executionCost?: number; entrySlippageAllowance?: number; futureExitSlippageAllowance?: number; measuredEntrySlippage?: number|null; cfg: Pick<BoxConfig,"minExpectedNetProfit"|"minNetEdge"|"minGrossEdge"|"safetyBuffer">}): BoxEntryDecision` (614–703).
  Allowance resolution (636–646):
    usingExplicit   = entrySlippageAllowance !== undefined OR futureExitSlippageAllowance !== undefined
    entryAllowance  = usingExplicit ? round2(entrySlippageAllowance ?? 0) : round2(executionCost ?? 0)
    futureExitAllow = usingExplicit ? round2(futureExitSlippageAllowance ?? 0) : 0
    executionCost   = round2(entryAllowance + futureExitAllow)
    measured        = (undefined or null) ? null : round2(measured). RECORDED ONLY, never deducted.
  minNet = requiredNetProfit(cfg) (648).
  passesPrefilter = grossEdge !== null AND grossEdge ≥ cfg.minGrossEdge (649). Uses the raw minGrossEdge (no max(0,·)).
  base fields: gross_edge, entry_charges, estimated_exit_charges, execution_cost, entry_slippage_allowance, future_exit_slippage_allowance, measured_entry_slippage, safety_buffer = cfg.safetyBuffer (unrounded), min_expected_net_profit = minNet, passes_gross_prefilter.
  Decision order:
    1. grossEdge null → expected null, qualifies false, reject "no_quote" (665).
    2. entryCharges or estimatedExitCharges null → expected null, reject "unpriced_charges" (667–675).
    3. expectedNet = projectedNetEdge(grossEdge, entryCharges, estimatedExitCharges, executionCost, cfg.safetyBuffer)
       = round2(gross − entryCh − exitCh − (entryAllow + futureExitAllow) − safetyBuffer).
    4. !passesPrefilter → reject "below_gross_prefilter". expected_net_profit is still reported (686–692).
    5. expectedNet < minNet → reject "below_expected_net_profit" (694–700).
    6. Otherwise qualifies true, reject null. Qualification is INCLUSIVE: expectedNet ≥ minNet passes.
  Two contexts:
  - Pre-execution: gross = detection gross, entryAllow = cfg.expectedEntrySlippage, futureExit = cfg.expectedExitSlippage.
  - Final: gross = executed gross, entryAllow = 0, futureExit = cfg.expectedExitSlippage, measured = actual (not deducted).

- `export function qualifiesForEntry(grossEdge: number|null, netEdge: number|null, cfg: Pick<BoxConfig,"minGrossEdge"|"minNetEdge">): boolean` (712–724). Legacy check:
  - gross null → false; gross < minGrossEdge → false.
  - If minNetEdge > 0: net null → false; net < minNetEdge → false.
  - Otherwise true.

- `export function passesGrossPrefilter(grossEdge: number|null, threshold: number): boolean` (727–729). grossEdge !== null AND grossEdge ≥ threshold.

- `export function evaluateCandidateIndicative(args: {candidate; lastPrices: Map<number, number>; now: number}): BoxEvaluation` (743–877). Market-closed view; never tradable.
  - Per leg: price = (lastPrices.get(token) ?? 0) > 0 ? last : null. qty_at_touch, bid and ask are 0; quote_at, exchange_at, version, depth and age are null; fresh and executable are false.
  - havePrices = every price non-null. rawDebit = Σ debitSign·price; netDebit = round2(rawDebit) (784).
  - signedCost   = sign · netDebit (830)
    impliedEdge  = sign · width − netDebit (831–832). NOT rounded before comparison.
    plausible    = signedCost > 0 AND impliedEdge > 0 AND impliedEdge < box_width (833–838), all strict.
    In words: LONG requires 0 < value < width; SHORT requires width < value < 2·width.
  - netDebitPerUnit = plausible ? netDebit : null; grossPerUnit = round2(sign·width − ndpu) (844); grossEdge = round2(gpu · lot) (845).
  - reject (848–850): !havePrices → "no_quote"; !plausible → "implausible_close"; else "market_closed".
  - tradable false, depth_ok false, worst_age_ms null, quote_version null.

- `export function evaluateExitLegs(args: {legs: {role: BoxLegRole; inst: BoxOptionInstrument}[]; quotes: Map<number, BoxQuote>; lotSize: number; now: number; maxAgeMs: number; direction?: BoxDirection; captureDepth?: boolean}): BoxLegEvaluation[]` (883–902).
  Maps each leg to evaluateLeg with side = exitSideFor(role, direction ?? LONG_BOX). Order is the order of args.legs.

- `export function convergenceThreshold(entryNetEdge: number, cfg: Pick<BoxConfig,"convergenceFloor"|"convergencePct">): number` (908–913).
  round2(max(convergenceFloor, convergencePct · entryNetEdge)).

- `export function exitNetCreditPerUnit(legs: BoxLegEvaluation[]): number | null` (924–932).
  For each leg: if price null or !(price > 0) return null. Else credit += −debitSign(side)·price, i.e. +price for a closing SELL and −price for a closing BUY.
  Returns round2(credit). Leg count is not checked.
  LONG: Bid(K1CE) − Ask(K2CE) + Bid(K2PE) − Ask(K1PE). SHORT gives a negative number.

- `export function exitLiquidityOk(legs: BoxLegEvaluation[]): boolean` (938–940). legs.length === 4 AND every leg is fresh AND executable.

- `export function evaluateExitDecision(args: {direction: BoxDirection; boxWidth: number; lotSize: number; entryNetDebitPerUnit: number; entryEdge: number; entryNetEdge: number; entryChargesTotal: number|null; currentExitChargesTotal: number|null; legs: BoxLegEvaluation[]; expirySafety?: boolean; executionAllowance?: number; useRealisableForFloor?: boolean; cfg: Pick<BoxConfig,"convergenceFloor"|"convergencePct"|"minExitNetPnl"|"profitCapturePct"|"minCapturedPct">}): BoxExitDecision` (969–1084).
  Formulas:
    exitCredit    = exitNetCreditPerUnit(legs)
    grossPnl      = round2((exitCredit − entryNetDebitPerUnit) · lotSize) (1003–1004)
    roundTrip     = round2(entryChargesTotal + currentExitChargesTotal), or null if either is null (1005–1008)
    netPnl        = round2(grossPnl − roundTrip) (1009)
    allowance     = useRealisableForFloor === true ? round2(executionAllowance ?? 0) : 0 (1015)
    floorNet      = round2(netPnl − allowance) (1016)
    remainingEdge = round2((sign·boxWidth − exitCredit) · lotSize) (1018–1021)
    capturedEdge  = round2(entryEdge − remainingEdge) (1022)
    capturedPct   = (|entryEdge| > 0) ? round2(capturedEdge / |entryEdge|) : null (1023–1026)
                    This is a FRACTION rounded to 2 dp; minCapturedPct is compared against it.
    threshold     = convergenceThreshold(entryNetEdge)
    captureTarget = round2(profitCapturePct · entryNetEdge) (1029)
    executable    = exitLiquidityOk(legs)
  Rules (1039–1057):
    if netPnl null OR floorNet null → blocked = "unpriced_charges"
      This also covers missing exit prices: then exitCredit is null, so grossPnl and netPnl are null. "unpriced_charges" therefore shows up even when the real problem is a missing quote.
    else if netPnl > 0 AND remainingEdge !== null:
      clearsFloor    = floorNet ≥ minExitNetPnl
      converged      = remainingEdge ≤ threshold
      capturedEnough = floorNet ≥ captureTarget OR (capturedPct !== null AND capturedPct ≥ minCapturedPct)
      converged AND clearsFloor          → ruleReason EDGE_CONVERGED
      else clearsFloor AND capturedEnough → ruleReason PROFIT_CAPTURE
      else converged OR capturedEnough   → blocked "net_below_floor"
    else if remainingEdge !== null AND remainingEdge ≤ threshold → blocked "net_below_floor" (converged into a loss)
    "In profit" is netPnl > 0 on the TOUCH net, while the profit tests use floorNet.
  reason = executable ? (ruleReason ?? (expirySafety ? "EXPIRY_SAFETY" : null)) : null (1063–1065).
  If (ruleReason !== null OR expirySafety) AND !executable → blocked = "insufficient_exit_liquidity" (1067–1069). This OVERWRITES an earlier blocked value.
  GOTCHA: when executable AND expirySafety AND charges are unpriced, should_exit is true (EXPIRY_SAFETY) while blocked_reason is still "unpriced_charges".
  Returns: should_exit = reason !== null AND executable; reason (same guard); rule_reason; remaining_edge; captured_edge; captured_pct; gross_pnl; net_pnl; executable; blocked_reason.

- `export function computeExitMetrics(args: {boxWidth; lotSize; entryBoxCostPerUnit; entryNetEdge; entryChargesTotal: number|null; currentExitChargesTotal: number|null; legs; now; direction?; entryEdge?; executionCost?; useRealisableForFloor?; openedAt?; expirySafety?; cfg: (same 5 fields)}): BoxExitMetrics` (1094–1199).
  - direction = args.direction ?? LONG_BOX.
  - entryEdge = args.entryEdge ?? round2((sign·width − entryBoxCostPerUnit)·lot) (1125–1127).
  - executionCost = round2(executionCost ?? 0).
  - decision = evaluateExitDecision(..., executionAllowance = executionCost, useRealisableForFloor).
  - exitCredit = decision.gross_pnl === null ? null : exitNetCreditPerUnit(legs) (recomputed).
  - exitBoxValue = round2(exitCredit·lot).
  - roundTrip recomputed the same way.
  - realisable = round2(net_pnl − executionCost). Always deducted, whatever useRealisableForFloor is.
  - worst_age_ms only when every leg has an age AND agesSeen > 0 (1192).
  - eligible = rule_reason !== null AND executable (1167). Expiry safety is NOT "eligible"; it only shows up through decision.reason.
  - time_in_trade_ms = openedAt undefined ? null : max(0, now − openedAt).
  Output fields: at, direction, legs, exit_net_credit_per_unit = exit_box_value_per_unit = exitCredit, exit_box_value, gross_pnl_if_closed_now, estimated_exit_charges = currentExitChargesTotal, total_round_trip_charges, current_net_pnl, estimated_execution_cost, realisable_net_pnl, remaining_edge, entry_edge, captured_edge, captured_pct, convergence_threshold, min_exit_net_pnl, profit_capture_target = round2(pct·entryNetEdge), min_captured_pct, time_in_trade_ms, liquidity_ok, worst_age_ms, rule_reason, exit_eligible, exit_reason = eligible ? rule_reason : null, blocked_reason, decision.

CONSTANTS:
- Paise factor 100 (61).
- eachSide default 3 (272).
- Hysteresis base 0.5 (299).
- Default direction LONG_BOX: 81, 86, 319, 349, plus the `?? "LONG_BOX"` in evaluateCandidate, indicative, evaluateExitLegs and computeExitMetrics.
- legs.length === 4 (939).
- No epsilon in math.ts. All comparisons are exact on round2'd values; the indicative plausibility check (838) compares UNROUNDED impliedEdge.

=====================================================================
2. orderPricing.ts — marketable-limit pricing, depth walk, queue haircut
=====================================================================
PURPOSE. Pure and deterministic, with no randomness. Computes the bounded limit price, a VWAP walk of the book down to that limit with a queue haircut, and marketable/passive classification. No state.
IMPORTS (37–42): types only (BoxDepthLevel, BoxQueueModel, OrderSide, PaperFillSlice, PaperOrderPricing, PaperOrderType).
CONSTANTS: EPS = 1e-9 (44); default tick 0.05 (92, 269); haircut clamped to [0,100] (120); Number.MAX_SAFE_INTEGER cap (197).

- `function round2(v: number): number` (47–49). Private, same as math.ts.

- `export function roundToTick(price: number, tick: number): number` (52–55).
  If !(tick > 0), return round2(price). Else round2(Math.round(price/tick) · tick).
  This is NEAREST tick (JS half-up, toward +∞). It is NOT directional floor/ceil, so a BUY limit can be snapped below reference+chase when the reference is off-grid.

- `export function computeLimitPrice(args: {side: OrderSide; referencePrice: number; tickSize: number; maxChaseTicks: number}): number` (63–73).
  chase = max(0, Math.round(maxChaseTicks)) · (tickSize > 0 ? tickSize : 0)
  raw   = BUY ? referencePrice + chase : referencePrice − chase
  return roundToTick(raw, tickSize)
  With tickSize ≤ 0, chase is 0 and the result is round2(ref). A SELL raw value can go ≤ 0, and then Math.round of a negative applies (R2).

- `export function buildOrderPricing(args: {side; quantity: number; referencePrice: number; tickSize: number; maxChaseTicks: number; orderType?: PaperOrderType}): PaperOrderPricing` (84–108).
  tick = tickSize > 0 ? tickSize : 0.05. Returns:
  { order_type: orderType ?? "MARKETABLE_LIMIT", side, quantity, reference_price: round2(ref), tick_size: tick, max_chase_ticks: max(0, Math.round(maxChaseTicks)), limit_price: computeLimitPrice(side, RAW referencePrice, tick, maxChaseTicks) }.
  The limit is computed from the unrounded reference.

- `export function effectiveQty(displayed: number, model: BoxQueueModel, haircutPct: number): number` (116–122).
  - !isSafeInteger(displayed) OR displayed ≤ 0 → 0.
  - model "none" → displayed.
  - !isFinite(haircutPct) → 0.
  - pct = clamp(haircutPct, 0, 100); return Math.floor(displayed · (1 − pct/100)).
  Float hazard: 100·(1 − 0.29) = 70.999… floors to 70. Go must use the identical expression order.

- `function withinLimit(side, price, limit): boolean` (125–128).
  False if price or limit is non-finite or ≤ 0. BUY: price ≤ limit + EPS. SELL: price ≥ limit − EPS.

- `export interface DepthWalkResult { filled_qty: number; average_price: number | null; slices: PaperFillSlice[]; executable_within_limit: number }` (130–141).

- `export function walkDepth(args: {side; levels: BoxDepthLevel[]; remainingQty: number; limitPrice: number; queueModel: BoxQueueModel; haircutPct: number; at: number; quoteVersion: number | null; reserved?: ((price: number, quoteVersion: number | null) => number) | undefined}): DepthWalkResult` (152–220). This is the VWAP / bounded walk:
  1. Guard: remainingQty not a positive safe integer, or limit non-finite / ≤ 0 → {0, null, [], 0} (174–177).
  2. Filter a COPY of levels (184–185): price finite and > 0, price·100 finite, qty a positive safe integer, price·qty finite.
     Sort (186): BUY ascending price, SELL descending. Use a stable sort (R5).
  3. For each level:
     - if !withinLimit, BREAK (189);
     - effectiveRaw = effectiveQty(qty, model, haircut);
     - reservedQty = reserved ? reserved(lv.price, quoteVersion) : 0;
     - already = (safe integer AND > 0) ? reservedQty : 0;
     - effective = max(0, effectiveRaw − already) (196);
     - executableWithinLimit = min(MAX_SAFE_INTEGER, ewl + effective) (197). This keeps accumulating after the order is satisfied;
     - if remaining ≤ 0 OR effective ≤ 0, continue;
     - take = min(remaining, effective);
     - slice {price: round2(lv.price), qty: take, displayed_qty: lv.qty, effective_qty: effective, at, quote_version};
     - filled += take; valueSum += lv.price·take (RAW price); remaining −= take.
  4. average_price = filled > 0 ? round2(valueSum / filled) : null.
  Notes:
  - Duplicate same-price levels each call reserved(price) and each subtract the full reserved amount.
  - The book is not mutated.

- `export interface OrderProfileClassification { profile: PaperOrderType; marketable: boolean; touch: number|null; offsetTicks: number|null; assumed: boolean }` (242–258).

- `export function classifyOrderProfile(args: {side; limitPrice: number; bids: BoxDepthLevel[]; asks: BoxDepthLevel[]; tickSize: number}): OrderProfileClassification` (260–289).
  - touch = touchPrice(side, bids, asks); tick = tickSize > 0 ? tickSize : 0.05.
  - If touch is null OR !(limit > 0) → {MARKETABLE_LIMIT, marketable: true, touch: null, offsetTicks: null, assumed: true}.
  - marketable = BUY ? limit ≥ touch − EPS : limit ≤ touch + EPS.
  - rawOffset = BUY ? limit − touch : touch − limit.
  - offsetTicks = Math.round((rawOffset/tick)·100)/100. Negative for passive orders (R2 divergence).
  - touch = round2(touch); profile is MARKETABLE_LIMIT or PASSIVE_LIMIT; assumed false.

- `export function touchPrice(side: OrderSide, bids: BoxDepthLevel[], asks: BoxDepthLevel[]): number | null` (292–302).
  levels = BUY ? asks : bids. Skips a level if price is non-finite or ≤ 0, OR qty is not a positive safe integer. BUY takes the min, SELL the max.
  DIFFERS from math.bestPrice, which ignores qty.

=====================================================================
3. positions.ts — in-memory open-position book (STATEFUL)
=====================================================================
PURPOSE. The authoritative live view of open boxes, so the hot path avoids Mongo. Enforces one open box per exact key (strike pair + direction) with a synchronous reserve().
STATEFUL CLASS: BoxPositionBook (129–230).
IMPORTS (19–31): BOX_LEG_ROLES and types (BoxChargeOrigin, BoxDirection, BoxExecutionRecord, BoxExitMetrics, BoxLegRole, BoxOptionInstrument, BoxPositionState, BoxScannerConfigSnapshot, BrokerId, ExecutionMode, IBoxExitAttempt).

`export interface BoxOpenPosition` (33–127) fields:
- Identity and context: id, key ("underlying|expiry|K1|K2|DIRECTION"), broker: BrokerId, execution_mode: ExecutionMode, underlying, name, is_index, expiry, direction? (absent means LONG_BOX), lower_strike, upper_strike, box_width, lot_size, quantity.
- Entry figures: entry_box_cost_per_unit (signed net debit; positive long, negative short), entry_gross_edge, entry_net_edge, entry_charges_total: number|null, estimated_exit_charges_total: number|null, safety_buffer, expected_net_profit?: number|null, entry_execution_cost?: number|null, charge_origin?: BoxChargeOrigin, entry_execution?: BoxExecutionRecord|null, margin: number|null, opened_at.
- Legs: legs: Record<BoxLegRole, BoxOptionInstrument>, entry_prices: Record<BoxLegRole, number>, remaining_qty_by_role: Record<BoxLegRole, number> (exact open qty per role).
- Exit tracking: position_state: BoxPositionState, cumulative_exit_charges, exit_attempts: IBoxExitAttempt[], last_exit_attempt_at?, metrics: BoxExitMetrics|null, current_captured_edge?, current_captured_pct?, exit_blocked_reason: string|null, expiry_safety: boolean, closing: boolean (race guard between manual close and monitor), last_persist_at, config: BoxScannerConfigSnapshot.

BoxPositionBook API. Private state: byId = Map<string, BoxOpenPosition>, byKey = Map<string, string> (key → id), reserved = Set<string>.
- `get size(): number` (135). byId.size.
- `list(): BoxOpenPosition[]` (139). Array of LIVE object references, in Map insertion order.
- `get(id: string): BoxOpenPosition | undefined` (143).
- `getByKey(key: string): BoxOpenPosition | undefined` (147). Via byKey, then byId.
- `isTaken(key: string): boolean` (153). byKey.has(key) OR reserved.has(key).
- `reserve(key: string): boolean` (164). If isTaken, return false; else add to reserved and return true. Check-then-act.
- `release(key: string): void` (170). reserved.delete.
- `add(pos: BoxOpenPosition): void` (175). byId.set(id, pos); byKey.set(key, id); reserved.delete(key).
  No duplicate-key check: a second id under the same key remaps byKey and leaves the old id in byId.
- `remove(id: string): BoxOpenPosition | undefined` (181). Deletes from byId. Deletes byKey[key] only if it still maps to this id. Also clears the reservation for that key.
- `brokersInUse(): BrokerId[]` (197). Distinct brokers in first-seen order.
- `foreignPositions(active: BrokerId): BoxOpenPosition[]` (202). Positions where broker ≠ active.
- `livePositions(): BoxOpenPosition[]` (207). Positions where execution_mode === "live".
- `tokens(): number[]` (212). For each position, Object.values(legs).token. Insertion order of the legs object (k1_ce, k2_ce, k2_pe, k1_pe when built by buildCandidates). NOT deduplicated.
- `openKeys(): Set<string>` (221). The byKey keys; reserved keys are excluded.
- `clear(): void` (225). Clears all three collections.

Derived-state functions (pure):
- `export function fullLotByRole(quantity: number): Record<BoxLegRole, number>` (233–237). Every role set to quantity.
- `export function isBoxPositionFlat(remainingQtyByRole: Record<BoxLegRole, number>): boolean` (247–249). Every role === 0, strict. undefined or NaN is not flat.
- `export function deriveBoxPositionState(remainingQtyByRole: Record<BoxLegRole, number>, current?: BoxPositionState): BoxPositionState` (257–266):
    flat → "FLAT" (261). Overrides even RECOVERY.
    current === "RECOVERY" → "RECOVERY" (262). Sticky.
    first = k1_ce; first > 0 AND all roles === first → "BOX"; else "PARTIALLY_EXITED".
  STATE MACHINE:
  - Entry sets fullLotByRole, giving BOX.
  - Any unequal reduction gives PARTIALLY_EXITED.
  - All zero gives FLAT, which is terminal.
  - RECOVERY is entered by the caller (for example an overfill flagged by singleLotPositionViolation). It stays until FLAT, or until the caller passes a different `current`.
  - GOTCHAS: "BOX" means "all four equal and > 0", not "a full lot". Equal partial remainders (all 35) derive BOX, and so does an equal overfill (all 150). PARTIALLY_EXITED can move back to BOX. Negative values give PARTIALLY_EXITED.
- `export function outstandingRoles(pos: Pick<BoxOpenPosition, "remaining_qty_by_role">): { role: BoxLegRole; quantity: number }[]` (270–285).
  Canonical role order. If any q is not a safe integer or is below 0, THROWS Error(`${role} outstanding quantity must be a non-negative safe integer`). Includes roles with q > 0. Deliberately NOT capped at one lot.
  (Partial-fill "remaining by role" is exactly remaining_qty_by_role. Exits decrement only the roles they closed.)

=====================================================================
4. boxCapital.ts — per-Box gross entry-order notional cap
=====================================================================
PURPOSE. Pure. Computes SUM over the 4 entry legs of |limit_price × quantity| in INTEGER PAISE, and gates it against BOX_LIVE_MAX_BOX_CAPITAL_RUPEES. It is explicitly NOT margin. No state.
IMPORTS (45): types BoxLegRole, OrderSide.
CONSTANTS: BOX_CAPITAL_LIMIT_REASON = "box_capital_limit" (163); expectedLegCount default 4 (105–108); paise factor 100 (50, 56).

- `export function toPaise(rupees: number): number` (48–51). Non-finite gives 0; else Math.round(rupees·100) (half-up; inputs are positive here).
- `export function fromPaise(paise: number): number` (54–57). Non-finite gives 0; else Math.round(paise)/100.
- Interfaces:
  - BoxCapitalOrderLike {role, side, tradingsymbol, quantity, pricing: {limit_price}} (60–66).
  - BoxCapitalLegBreakdown {role, side, tradingsymbol, quantity, limit_price, notional_rupees} (69–78).
  - BoxCapitalMetrics {gross_entry_order_notional_rupees, gross_entry_order_notional_paise, legs, leg_count, complete, incomplete_reason} (87–98).
- `export function grossEntryOrderNotional(requests: readonly BoxCapitalOrderLike[], expectedLegCount = 4): BoxCapitalMetrics` (105–150). For each request:
  - quantity must be finite, > 0 and Number.isInteger. Else push the problem `${role} has a non-positive or non-integer quantity (${String(quantity)})` and skip (116–119).
  - limit = pricing?.limit_price must be finite and > 0. Else push `${role} has no usable bounded LIMIT price (${String(limit)})` and skip (120–123).
  - legPaise = |toPaise(limit) · quantity| (127). Round the price to paise first, then multiply.
  - totalPaise += legPaise; leg notional_rupees = fromPaise(legPaise).
  - After the loop, if legs.length ≠ expected, push `expected ${expected} priced legs, computed ${n}` (139–141).
  - Returns rupees = fromPaise(totalPaise), paise = totalPaise, legs, leg_count, complete = (no problems), incomplete_reason = problems.join("; ") or null.
- `export type BoxCapitalCheckStage = "qualification" | "pre_submit" | "dequeue"` (154–160).
- `export interface BoxCapitalReport {stage, enabled, allowed, reason, detail, calculated_rupees, configured_max_rupees, broker, candidate_key, at, metrics, broker_estimated_margin_rupees: number|null}` (165–188).
- `export function evaluateBoxCapitalAdmission(args: {metrics; limitRupees: number; broker: string; candidateKey: string; at: number; stage; brokerEstimatedMarginRupees?: number|null}): BoxCapitalReport` (205–262):
  - limit = isFinite(limitRupees) ? limitRupees : 0.
  - base = {stage, calculated_rupees = metrics rupees, configured_max_rupees = limit > 0 ? limit : 0, broker, candidate_key, at, metrics, broker_estimated_margin_rupees ?? null}.
  - limit ≤ 0 → enabled false, allowed true (disabled; completeness not checked) (226–231).
  - !metrics.complete → enabled true, allowed false, reason box_capital_limit, detail "cannot verify the ₹${limit} per-Box cap: ${incomplete_reason ?? "metric incomplete"}. Refusing rather than admitting on an under-stated total." (233–243).
  - total paise > toPaise(limit) → refused, detail "gross_entry_order_notional_rupees ₹${rupees} exceeds the configured BOX_LIVE_MAX_BOX_CAPITAL_RUPEES ₹${limit} (checked at ${stage}). This is gross option-order notional from the bounded LIMIT requests, NOT broker margin." (245–257).
  - Otherwise allowed. Exactly at the cap is ADMITTED; ₹0.01 over is refused.
- `export function boxCapitalSummary(report: BoxCapitalReport | null): {enabled; configured_max_rupees; last_calculated_rupees; last_stage; last_allowed; last_at}` (269–295).
  null gives {false, 0, null, null, null, null}; otherwise a projection of the report.

=====================================================================
5. marginReplay.ts — peak concurrent margin (pure, no imports)
=====================================================================
- `export interface MarginInterval { from: number; to: number; margin: number }` (29–44). The interval is half-open [from, to). An open trade passes to = now.
- `export function usableMarginIntervals(rows: { from: number; to: number; margin: number | null | undefined }[]): MarginInterval[]` (52–66). Drops a row when:
  - margin is null or undefined (58);
  - margin is non-finite or ≤ 0 (59);
  - from or to is non-finite (60);
  - to ≤ from (61).
  Input order is preserved.
- `export function peakConcurrentMargin(intervals: MarginInterval[]): number | null` (73–85).
  Empty gives null. O(n²) sweep over START points:
    for each probe: concurrent = Σ other.margin over other with other.from ≤ probe.from < other.to (80)
    peak = max(peak, concurrent), strict > update (82)
  Returns peak > 0 ? peak : null.
  - No rounding. Float sums are in input order (R4).
  - Correct because the step function only rises at starts.
  - Touching intervals (a.to === b.from) do NOT overlap.
  Caller: engine.ts:3466.

=====================================================================
6. stressProfile.ts — deterministic fault injection (no imports)
=====================================================================
PURPOSE. Resilience-test fault schedule, explicitly not live parity. STATEFUL class StressInjector.
- `export const STRESS_FAULTS` (39–66), 13 entries in order: broker_slowdown, feed_outage, websocket_gap, http_timeout, delayed_ack, delayed_cancel, partial_fill, broker_reject, mongo_failure, redis_failure, process_restart, duplicate_broker_event, out_of_order_broker_event.
- `export type StressFault` (67).
- `export interface StressFaultSchedule { fault: StressFault; everyNth?: number; atOperations?: readonly number[]; magnitude?: number }` (77–85). There is no probability field.
- `export interface StressProfileConfig { schedules: readonly StressFaultSchedule[] }` (87–89).
- `export class StressInjector` (98–150). State: operationCount = 0; fired = Map<StressFault, number>. constructor(private readonly config).
  - `nextOperation(): StressFault[]` (105–119).
    - Increments count; index = count (1-based).
    - For each schedule in order: byNth = everyNth defined AND everyNth > 0 AND index % Math.floor(everyNth) === 0; byIndex = atOperations?.includes(index) ?? false.
    - If either matches, push the fault (duplicates possible if several schedules name the same fault) and increment fired[fault].
    - GOTCHA: an everyNth in (0,1) floors to 0, and JS gives index % 0 = NaN, so it never fires. Go integer % 0 PANICS, so it needs a guard.
  - `firesNow(fault: StressFault): boolean` (122–131). For the CURRENT index, without advancing. index ≤ 0 gives false. Otherwise true if any schedule for that fault matches by the same rules.
  - `magnitudeFor(fault: StressFault, fallback: number): number` (134–138). Uses the FIRST schedule for that fault (find). Its magnitude if finite, else fallback.
  - `report(): Record<string, number>` (141–145). The fired counts, in first-fire insertion order.
  - `get operations(): number` (147–149).
- `export function createStressInjector(args: {profile: string; config: StressProfileConfig}): StressInjector` (159–171).
  Throws if profile !== "stress", with message: `[Box] refusing to create a stress fault injector under the "${profile}" profile. Fault injection is only available under BOX_PAPER_EXECUTION_PROFILE=stress, because an injected fault must never be mistakable for observed behaviour in a live_parity run.`
- `export function profileReportBanner(profile: string): string` (179–190):
  - "stress" → "⚠ STRESS PROFILE — SYNTHETIC FAULTS INJECTED. These figures are NOT measured execution behaviour and must NEVER be quoted as live parity or used for calibration."
  - "live_parity" → "live_parity — evidence-driven. Latency and cancel windows come from measured live observations where calibration is valid."
  - anything else → `${profile} — configured constants; not calibrated against live observations.`
  - The header also documents guards that live elsewhere: loadBoxConfig refuses stress combined with live execution, and BoxExecutionSimulator.calibrationStatus() reports evidence_driven false with LOW confidence.

=====================================================================
7. singleLotInvariant.ts — one-lot invariants (pure)
=====================================================================
IMPORTS (1–6): BOX_LEG_ROLES and types BoxCandidate, BoxLegRole, BoxOptionInstrument. Imported by math.ts.
- `export function singleLotCandidateViolation(candidate: Pick<BoxCandidate,"lot_size"|"legs">): string | null` (16–21). Delegates to singleLotLegViolation(candidate.lot_size, candidate.legs).
- `export function singleLotLegViolation(lotSize: number, legs: Record<BoxLegRole, BoxOptionInstrument>): string | null` (23–41):
  - !isPositiveSafeInteger(lotSize) → "candidate lot size must be a positive safe integer".
  - Per role in canonical order, with legLot = legs[role]?.lot_size:
    - not a positive safe integer → `${role} instrument lot size must be a positive safe integer`;
    - legLot !== lotSize → `${role} instrument lot size ${legLot} does not match candidate lot size ${lotSize}`.
  - Otherwise null.
- `export function singleLotPositionViolation(position: {lot_size: number; quantity: number; remaining_qty_by_role: Partial<Record<BoxLegRole, unknown>>; legs?: Partial<Record<BoxLegRole, Pick<BoxOptionInstrument,"lot_size">>>}): string | null` (49–79). Checks in order:
  1. lot_size is not a positive safe integer → "position lot size must be a positive safe integer".
  2. quantity is not a safe integer, or quantity ≠ lot_size → `position quantity ${String(quantity)} must equal exactly one lot (${lot_size})`.
  3. If legs are present, for each role: legLot not a positive safe integer, or ≠ lot_size → `${role} instrument lot size ${String(legLot)} does not match position lot size ${lot_size}`.
  4. Then, in a separate loop, for each role's remaining value:
     - not a safe integer, or below 0 → `${role} remaining quantity must be a non-negative safe integer`;
     - above lot_size → `${role} remaining quantity ${remaining} exceeds the one-lot maximum ${lot_size}`. This means overfill, and the caller quarantines the position in RECOVERY.
  Remainders do NOT need to be lot multiples.
- `export function exactEntryFillViolation(lotSize: number, fills: Partial<Record<BoxLegRole, unknown>>): string | null` (82–93):
  - lot invalid → "entry lot size must be a positive safe integer".
  - Per role: fill is not a safe integer, or ≠ lotSize → `${role} entry fill ${String(filled)} must equal exactly one lot (${lotSize})`.
- `export function isPositiveSafeInteger(value: unknown): value is number` (96–98). Number.isSafeInteger(value) AND value > 0 (R6).

=====================================================================
8. entrySubmissionOrder.ts — hedge-first transport order (pure)
=====================================================================
IMPORTS (29–35): BOX_ENTRY_SIDES_BY_DIRECTION, BOX_LEG_ROLES, types BoxDirection, BoxLegRole, OrderSide.
- `export interface EntrySubmissionSlot { role: BoxLegRole; side: OrderSide; rank: number; hedge: boolean }` (38–55).
  rank is 0-based. Rank n may not POST until every lower rank has reached a decided outcome; that is enforced by the caller, executionGateway.ts:220. hedge = (side === BUY). A definitive hedge failure must stop the dependent SELLs.
- `export function entrySubmissionOrder(direction: BoxDirection): readonly EntrySubmissionSlot[]` (64–78).
  RULE: all BUY legs first, then all SELL legs, each group in STABLE canonical order:
    LONG_BOX : k1_ce BUY(0, hedge), k2_pe BUY(1, hedge), k2_ce SELL(2), k1_pe SELL(3)
    SHORT_BOX: k2_ce BUY(0, hedge), k1_pe BUY(1, hedge), k1_ce SELL(2), k2_pe SELL(3)
  It changes only transport order. Roles, sides, quantities and economics are unchanged, and downstream accounting is keyed by role.
- `export function entrySubmissionRoles(direction): readonly BoxLegRole[]` (81–83). Roles only.
- `export function entryTransportRank(direction, role): number` (89–91). The slot's rank, or −1 if not found.
- `export function isHedgeFirstSequence(sides: readonly OrderSide[]): boolean` (100–107). False if any BUY appears after a SELL. Independent test oracle.

=====================================================================
NODE SINGLE-THREAD ASSUMPTIONS → GO LOCKING
=====================================================================
1. BoxPositionBook (positions.ts:129–230). The docs say reserve() is atomic "with respect to the event loop" (positions.ts:13–15, 159–163).
   - In Go, reserve, isTaken, add, release, remove, getByKey and the list/derived methods need one mutex. reserve's check-then-insert must happen under one lock.
   - The reservation is held across async work (the charge call) and must be released on every failure path.
   - JS Map/Set iterate in insertion order, and Map.set on an existing key keeps its original position. Go maps are random, so list(), brokersInUse(), tokens(), foreignPositions() and livePositions() need an ordered slice plus an index to keep the same ordering.
2. BoxOpenPosition objects are shared, MUTABLE live references: list() and get() return the same objects. These fields are mutated in place by the monitor, manual close and persistence: closing, metrics, remaining_qty_by_role, position_state, exit_attempts, cumulative_exit_charges, last_exit_attempt_at, exit_blocked_reason, expiry_safety, current_captured_*, last_persist_at.
   - `closing` is a test-and-set race guard (positions.ts:122) that relies on there being no interleaving. In Go it needs a per-position mutex/CAS, or single-goroutine ownership, and API readers must get deep-copied snapshots.
3. StressInjector (stressProfile.ts:98–150). operationCount and the fired Map are mutable. nextOperation() followed by firesNow() assumes nothing runs in between. Go needs a mutex, and firesNow's "current operation" is meaningless under concurrency unless serialized.
4. walkDepth's `reserved` callback (orderPricing.ts:161–168, 194). It reads a reservation ledger owned elsewhere (live-parity paper) and shared across concurrent attempts. In Go the read-and-reserve sequence must be atomic so two attempts cannot both consume one level.
5. evaluateCandidate, evaluateExitLegs and touchFor read several fields of a BoxQuote (bids, asks, bid, ask, qty, at, version) and a quotes Map that a feed handler updates. Node guarantees a consistent snapshot within one synchronous call. Go needs RWMutex-protected or copy-on-write immutable quote snapshots, so one evaluation never sees a torn book.
6. Everything else in these 8 files is pure and stateless. BOX_LEG_ROLES and BOX_ENTRY_SIDES_BY_DIRECTION are read-only constants, safe to share once you guarantee they are never mutated.


---

## 4. Charges (`charges.ts`, `localCharges.ts`, `chargeReconciler.ts`), quotes (`quotes.ts`), `liquidityLedger.ts`, `scanner.ts`

> Reader gaps (not verified in this pass): Not read: index.ts toLegCharges/aggregateCharges (how Kite's response is mapped), the engine.ts call sites of reconciler.submit (L2703, L2958), the code that calls estimateExitOnly or estimate/peek outside these files (the position monitor), executionSimulator.ts's use of the ledger, and whether reconciliation is skipped for Dhan trades. The exact BOX_LEG_ROLES order was not read directly. I could not confirm whether exchange_ts is in seconds or milliseconds. Exercise or intrinsic STT is not modelled in these files.

Repo root: /home/prakash/Work/projects/CAl/Cal_Spread_Backend. I read all six files in full: charges.ts 339 lines, localCharges.ts 371, chargeReconciler.ts 281, quotes.ts 274, liquidityLedger.ts 202, scanner.ts 1027. I also read the parts of math.ts, config.ts, types.ts, engine.ts, index.ts, instruments.ts, brokerContext.ts and brokers/dhan/charges.ts that these files call into.

Line numbers: where I counted exactly they are exact. Where I write "~" they may be off by 1 or 2. I did not change anything.

======================================================================
1. src/box/localCharges.ts — the local charge calculator (this is what the hot path uses)
======================================================================
WHAT IT IS
- The hot path's charge calculator. It is pure, synchronous and does no I/O.
- The only state is a rate card, read from the environment once when `LocalChargeCalculator` is constructed.
- There is no caching and there are no timers.

IMPORTS
- Types only, from ./types.js: BoxChargeOrigin, BoxCharges, BoxChargesWithOrigin, BoxLegCharges, OrderSide.
- It has its own private copy of round2.

PRIVATE HELPERS
- round2(v) = Math.round(v*100)/100 (L63-65).
- num(name, fallback) (L67-72): reads an env var. Missing or blank → fallback. Non-finite or negative → fallback.
- bool(name, fallback) (L165-172):
  - "1", "true", "yes" → true.
  - "0", "false", "no" → false.
  - Anything else → fallback.
  - Matching is case-insensitive and trims whitespace.
- const pct = (value, percent) => (value*percent)/100 (L200). Percentages are in PERCENT units.

EXPORTS
- interface BoxChargeRates (L81-127). Fields: brokeragePerOrder, brokerageMaxPct, sttSellPct, sttRoundNearestRupee, exchangeTxnPct, ipftPerCrore, ipftPct (deprecated), sebiPct, stampDutyBuyPct, gstPct, sttType, rateVersion.
- function loadBoxChargeRates(): BoxChargeRates (L130-163). Defaults:
  - brokeragePerOrder = BOX_BROKERAGE_PER_ORDER, default 20 (L132)
  - brokerageMaxPct = BOX_BROKERAGE_MAX_PCT, default 0, meaning no cap (L133)
  - sttSellPct = BOX_STT_SELL_PCT, default 0.15 (L144)
  - sttRoundNearestRupee = BOX_STT_ROUND_NEAREST_RUPEE, default true (L145)
  - exchangeTxnPct = BOX_EXCHANGE_TXN_PCT, default 0.03503 (L146)
  - ipftPerCrore = BOX_IPFT_PER_CRORE, default 50 (L154)
  - ipftPct = BOX_IPFT_PCT, default 0 (L155)
  - sebiPct = BOX_SEBI_PCT, default 0.0001 (L156)
  - stampDutyBuyPct = BOX_STAMP_DUTY_BUY_PCT, default 0.003 (L157)
  - gstPct = BOX_GST_PCT, default 18 (L158)
  - sttType = BOX_STT_TYPE, default "stt" (L159)
  - rateVersion = BOX_CHARGE_RATE_VERSION, default "zerodha-nse-options-2026-04-01" (L160-161)
  - WARNING: the header comment disagrees with the code. It says exchange is "0.035530%" (L37) and IPFT is "0 by default" (L41). The code defaults are 0.03503 and 50 per crore. Port the code values.
- function roundStt(value, rates: Pick<BoxChargeRates,"sttRoundNearestRupee">): number (L181-183). Returns Math.round(value), i.e. nearest RUPEE, when the flag is set; otherwise round2.
- function ipftFor(value, rates): number (L186-190). Returns round2( value*ipftPerCrore/10_000_000 + pct(value, ipftPct) ). IPFT is rounded to paise here, BEFORE it is added to the exchange head.
- interface BoxChargeOrder {side, tradingsymbol, quantity, price} (L193-198).
- function calculateLegCharges(order: BoxChargeOrder, rates: BoxChargeRates): BoxLegCharges (L211-247). This is ONE order, i.e. one leg. The formulas below are in evaluation order.

KEY FORMULAS (per leg; every head is rounded to paise on its own)
  value        = round2(quantity * price)                                             L215
  cap          = brokerageMaxPct > 0 ? pct(value, brokerageMaxPct) : Infinity          L217
  brokerage    = round2(min(brokeragePerOrder, cap))                                   L218   (₹20 flat per order, per leg)
  stt          = side == SELL ? roundStt(pct(value, sttSellPct)) : 0                   L222   (0.15% of SELL premium, rounded to the nearest RUPEE by default)
  exchange_txn = round2( pct(value, exchangeTxnPct) + ipftFor(value) )                 L225   (IPFT is pre-rounded inside ipftFor, then rounded again)
  sebi         = round2(pct(value, sebiPct))                                           L226
  stamp_duty   = side == BUY ? round2(pct(value, stampDutyBuyPct)) : 0                 L228
  gst          = round2(pct(brokerage + exchange_txn + sebi, gstPct))                  L230   (base is the already-ROUNDED brokerage, exchange (including IPFT) and SEBI heads; no GST on STT or stamp)
  price        = round2(order.price)                                                   L236
  stt_type     = side == SELL ? rates.sttType : ""                                     L240
  total        = round2(brokerage + stt + exchange_txn + sebi + stamp_duty + gst)      L245

Things this calculator does NOT model:
- STT on exercise or intrinsic value. Everything is on premium turnover.
- CTT.
- Different exchange rates for NSE and BSE. The order's exchange is never read.
- Any margin call.

GROUPING AND OTHER EXPORTS
- function calculateBoxCharges(orders, rates, source = "kite", computedBy = "local", at = new Date()): BoxChargesWithOrigin (L257-281).
  - legs = orders.map(calculateLegCharges).
  - Each group head is round2(sum of the legs' rounded heads) (L265-266). This applies to value, brokerage, stt, exchange_txn, sebi, stamp_duty, gst and total. The group total is round2(Σ leg.total).
  - It also sets source, at and computed_by.
- function ordersFromLegs(legs: {side, tradingsymbol, price: number|null}[], quantity): BoxChargeOrder[] | null (L291-306). Returns null if any price is null or ≤ 0. Prices are round2'd.
- function reverseOrders(orders): BoxChargeOrder[] (L309-314). Flips BUY and SELL.
- function calculateRoundTrip(entryOrders, rates, at = new Date()) (L323-347). Returns {entry, estimated_exit, entry_total, estimated_exit_total}.
  - entry = calculateBoxCharges(entry, "kite", "local").
  - estimated_exit = calculateBoxCharges(reverseOrders(entry), "kite_estimate", "local"). The exit is priced at the ENTRY prices.
  - The totals are the group totals, with no extra rounding.
- class LocalChargeCalculator (L355-371):
  - constructor(readonly rates = loadBoxChargeRates()).
  - legs(orders, source = "kite"): calls calculateBoxCharges.
  - roundTrip(entryOrders, at?): calls calculateRoundTrip.
  - totals(entryOrders): returns {entry: rt.entry_total, exit: rt.estimated_exit_total} (L367-370).

PER-BROKER DIFFERENCES
The calculator is injected through BoxChargeCalculatorLike (brokerContext.ts ~L225-240: legs, roundTrip, totals, rates.rateVersion). The Dhan version is DhanChargeCalculator in src/brokers/dhan/charges.ts. It has the same structure, with these differences:
- STT default is 0.1, from DHAN_STT_SELL_PCT (dhan L90). Zerodha's is 0.15.
- value is NOT pre-rounded: value = quantity*price (L118). It is only round2'd in the output (L138).
- ipftFor is NOT rounded separately (L110-111).
- stt_type is always rates.sttType, even on a BUY (L141).
- Brokerage is DHAN_BROKERAGE_PER_ORDER, default 20.
- rateVersion default is "dhan-nse-options-2026-04-01".
The Go port therefore needs two calculators that differ in both rates AND rounding order.

A box has 4 entry orders and 4 exit orders, so brokerage is 8 × ₹20 for the round trip. With the exit reversed, every leg pays STT exactly once over the round trip, on either the entry or the exit side.

======================================================================
2. src/box/charges.ts — BoxChargeEstimator, a caching wrapper around Kite's virtual contract note
======================================================================
WHAT IT IS
- Stateful: it holds a cache Map, an inFlight Map, an active counter and stats.
- No timers. Expired entries are dropped by prune(), or lazily by peek().

IMPORTS
- BoxConfig (type).
- round2 from ./math.js.
- BOX_LEG_ROLES, and the types BoxCandidate, BoxLegEvaluation, BoxChargeEstimate, BoxCharges.

EXPORTS
- interface BoxChargeLeg {side: "BUY"|"SELL"; token: number; expiry: string; tradingsymbol: string; exchange: string; quantity: number; price: number} (L24-32).
- interface PricedChargeGroup {charges: BoxCharges; logLegs: unknown[]} (L35-38).
- type PriceChargeGroupsFn = (groups: {legs: BoxChargeLeg[]; source: "kite"|"kite_estimate"}[]) => Promise<PricedChargeGroup[] | null> (L41-43). Returns null rather than throwing.
- reverseBoxLegs(legs: BoxChargeLeg[]): BoxChargeLeg[] (L46-51). Flips the sides.
- buildEntryChargeLegs(candidate: BoxCandidate, evaluations: BoxLegEvaluation[]): BoxChargeLeg[] | null (L60-81).
  - Builds a role → evaluation map and iterates BOX_LEG_ROLES in order.
  - Returns null if a role is missing, or its price is null or ≤ 0.
  - The side comes from the evaluation, which makes it direction-aware.
  - quantity = candidate.lot_size. price = round2(ev.price). Instrument fields come from candidate.legs[role].
- buildChargeLegsFromEvaluations(candidateLegs: Record<string,{token,tradingsymbol,exchange,expiry}>, evaluations: BoxLegEvaluation[], quantity: number): BoxChargeLeg[] | null (L87-107).
  - Same as above, but iterates the evaluations in the order given. Used for exits.
- chargeCacheKey(candidateKey: string, legs: BoxChargeLeg[]): string (L117-122).
  - Format: `${candidateKey}|${legs[0]?.quantity ?? 0}|${legs.map(l => l.side[0] + l.price.toFixed(2)).join(",")}`.
  - Example: "KEY|75|B123.45,S67.80,…".
  - Tokens are not in the key; the candidateKey implies them.
- sameChargeLegs(a, b): boolean (L125-137). Equal length, and side, token, quantity and price equal per index.
- class BoxChargeEstimator (L147-339).
  - constructor(private priceChargeGroups: PriceChargeGroupsFn, private cfg: BoxConfig) (L153-156).
  - State (L148-151):
    - cache: Map<string, {at: number; value: BoxChargeEstimate|null}>
    - inFlight: Map<string, Promise<BoxChargeEstimate|null>>
    - active = 0
    - stats {calls, hits, misses, failures}
  - getStats(): {calls, hits, misses, failures, inFlight: inFlight.size} (L159-161).
  - hasCapacity(): boolean = active < cfg.chargeConcurrency (L164-166). The default is 3 (config.ts:1130). This check is ADVISORY ONLY; estimate and estimateExitOnly never enforce it.
  - peek(candidateKey, legs): BoxChargeEstimate | null | undefined (L169-178).
    - undefined on a miss. Also undefined when expired, and it deletes the entry (age > TTL).
    - A cached failure comes back as null.
  - async estimate(candidateKey, entryLegs): Promise<BoxChargeEstimate|null> (L187-211).
    - If the cached age ≤ cfg.chargeCacheTtlMs (default 30_000, config.ts:1129): hits++ and return.
    - Else, if a request is already in flight, return the SAME pending promise. No counter changes.
    - Else misses++, task = run(), inFlight.set; in finally, inFlight.delete.
  - private async run(key, entryLegs) (L213-255):
    - active++ and calls++.
    - Makes ONE call to priceChargeGroups with [{legs: entry, source: "kite"}, {legs: reverseBoxLegs(entry), source: "kite_estimate"}]. That is eight order lines, and the exit is priced at the entry prices.
    - If the result is null or has fewer than 2 groups: failures++, and null is CACHED with at = now for the full TTL.
    - On success, value = {entry, estimated_exit: exit, entry_total: round2(entry.total), estimated_exit_total: round2(exit.total), entry_legs: entry.legs, exit_legs: exit.legs}. It is cached.
    - catch: failures++, warn, cache null.
    - finally: active--.
  - async priceOrders(cacheKey, legs): Promise<BoxCharges|null> (L265-267). Simply calls estimateExitOnly. The reconciler uses this.
  - async estimateExitOnly(cacheKey, exitLegs): Promise<BoxCharges|null> (L274-~330).
    - key = "exit:" + chargeCacheKey(...).
    - Cache hit: hits++ and return value?.entry ?? null.
    - Pending request: AWAIT it and return v?.entry.
    - Else misses++, then an IIFE that does: active++, calls++, a single-group call [{legs: exitLegs, source: "kite_estimate"}]. If the result is null or has fewer than 1 group, failures++ and cache null.
    - On success, value has entry = estimated_exit = that charges object, and both totals = round2(charges.total). It is cached.
    - inFlight.set, await, then inFlight.delete in finally.
  - prune(): void (~L331-338). Deletes every cache entry with now − at > TTL. engine.ts calls it at the end of every universe rebuild (~L2202).

THE BROKER CALL (src/index.ts L2625-2689, priceChargeGroups)
- Calls kite.getOrderCharges(orders), which is Kite POST /charges/orders (the virtual contract note).
- One order line is sent per leg across all groups:
  - order_id `calspread-${gi}-${li}`
  - exchange: leg.exchange
  - tradingsymbol
  - transaction_type: side
  - variety "regular", product "NRML", order_type "MARKET"
  - quantity
  - average_price: round2(price)
- Returns null if there are no orders, if Kite throws, or if the response count differs from the request count.
- Responses are mapped back by order_id, falling back to position. toLegCharges and aggregateCharges(legCharges, source) build each group; I did not read those two functions.
- No margin API is called anywhere in these six files.
- The scanner holds `charges` in its deps but NEVER calls it (scanner.ts uses only localCharges). In these files, the estimator's remaining callers are the reconciler (priceOrders) and, per its comment, the position monitor (estimateExitOnly). I did not verify the monitor.

======================================================================
3. src/box/chargeReconciler.ts — after-the-fact check of local charges against Zerodha
======================================================================
WHAT IT IS
- Stateful: queue[], a workers count, a seen Set and stats.
- Runs on no interval. Work arrives only through submit(). Retries use setTimeout(...).unref().

IMPORTS
- BoxChargeEstimator and BoxChargeLeg (types).
- BoxConfig, BoxMetrics.
- round2 from ./math.js.
- BoxCharges, BoxChargeReconciliation, BoxChargesWithOrigin.

EXPORTS
- type BoxChargePhase = "entry"|"exit" (L35).
- interface BoxChargeReconcilerDeps (L37-56):
  - cfg; charges: BoxChargeEstimator; metrics?: BoxMetrics.
  - persist(tradeId, phase, verdict): Promise<void>.
  - onReconciled?(tradeId, phase, verdict, warned): void.
  - isAuthenticated(): boolean.
- Private interface QueueItem (L58-68): {tradeId, phase, localTotal, legs: BoxChargeLeg[], label, localCharges: BoxChargesWithOrigin|null, attempt}.
- headDiffs(local: BoxCharges|null, zerodha: BoxCharges|null) (L71-84).
  - Returns null if either side is missing.
  - Otherwise returns round2(local − zerodha) for each of brokerage, stt, exchange_txn, sebi, stamp_duty and gst. Values can be negative (see the rounding warning in section 7).
- class BoxChargeReconciler (L86-281):
  - stats (L91-102): queued, completed, failed, skipped, warnings, retries, max_abs_diff (starts at 0), last_abs_diff, last_pct_diff, last_at.
  - getStats() (L106-114): the stats plus pending = queue.length, in_flight = workers, enabled = cfg.reconcileCharges, warn_pct = cfg.chargeReconcileWarnPct.
  - submit(args: {tradeId, phase, localTotal, legs, label?, localCharges?}): void (L122-147).
    - Returns immediately if !cfg.reconcileCharges (default true, config.ts:1093) or if legs is empty.
    - Dedupe key `${tradeId}|${phase}` in seen. The seen set is never pruned, so it grows without bound.
    - queued++, then push {localTotal: round2(localTotal), label: label ?? tradeId, localCharges ?? null, attempt: 0}, then pump().
  - pump() (L150-161):
    - limit = max(1, cfg.chargeReconcileConcurrency); default 2 (config.ts:1095).
    - While workers < limit and the queue is not empty: shift, workers++, `void run(item).finally(() => { workers--; if (queue.length) pump() })`.
  - run(item) (L163-228):
    - If !isAuthenticated(): skipped++, and safePersist a failed verdict with error "no Zerodha session available to verify the local charge calculation". There is NO retry, no metrics call and no onReconciled.
    - Otherwise priced = await charges.priceOrders(`reconcile:${tradeId}:${phase}`, legs). If null, call retryOrFail("Zerodha could not price the box orders").
    - Comparison (L191-194):
        reconciled = round2(priced.total)
        absDiff    = round2(|reconciled − localTotal|)
        pctDiff    = reconciled > 0 ? round2(absDiff/reconciled*100) : 0     (the denominator is the ZERODHA total)
        warned     = pctDiff > cfg.chargeReconcileWarnPct                    (strict >, default 5, config.ts:1094)
    - Then: completed++; set the last_* stats; update max_abs_diff; warnings++ if warned; metrics.recordReconciliation(absDiff, pctDiff, warned); console.warn if warned.
    - verdict = {status: "verified", local_total, reconciled_total, abs_diff, pct_diff, head_diffs: headDiffs(localCharges, priced), at: new Date(), error: null}.
    - safePersist, then onReconciled(…, warned).
    - catch → retryOrFail(err.message).
  - retryOrFail(item, error) (L242-270):
    - maxAttempts = max(1, cfg.chargeReconcileMaxAttempts); default 3 (config.ts:1096).
    - next = attempt + 1.
    - If next < maxAttempts: retries++, delay = max(0, cfg.chargeReconcileRetryBaseMs (default 5000, config.ts:1097)) * next. This is LINEAR: 5 s, then 10 s. After the delay it pushes {...item, attempt: next} and calls pump(). This path bypasses `seen`.
    - Otherwise: failed++, metrics.recordReconciliationFailure(), and safePersist a failed verdict with error `${error} (gave up after ${maxAttempts} attempt(s))`.
    - Failed verdicts have no head_diffs key at all, rather than null. That difference matters for the stored document.
  - safePersist (L272-281): awaits deps.persist inside a try/catch and only warns on error.

WIRING (engine.ts ~L776-801)
- persist calls setBoxChargeReconciliation(tradeId, phase, verdict), which writes to MongoDB.
- onReconciled calls appendBoxEvent({event: "CHARGES_RECONCILED", trade_id, reason: warned ? "discrepancy_over_threshold" : "verified", detail: "<phase>: local ₹X vs Zerodha ₹Y (Z%)"}).
- isAuthenticated calls marketData.isAuthenticated().
- submit is called from engine.ts L2703 and L2958, presumably after entry and exit persistence. I did not read those call sites.

BEHAVIOUR TO KEEP IN THE PORT: with the default settings, retries never reach Kite again.
- The estimator caches a null result under the same "exit:"+key for chargeCacheTtlMs = 30 s.
- The retries fire at 5 s and again 10 s later (15 s in total), so both find the cached null and the reconciler gives up.
- Exceptions cannot reach the catch either, because estimateExitOnly swallows them.

======================================================================
4. src/box/quotes.ts — BoxQuoteStore and SpotStore
======================================================================
IMPORTS: only the BoxQuote type.

BoxTickInput (L20-30)
  {token, last_price, bid, ask, bids?, asks?, depth_updated?, exchange_ts?}
  Each level is {price, qty, orders}.

BoxQuoteDiagnostics (L32-40), BoxQuoteListener = (changed: number[], at: number) => void (L43)

BoxQuote (types.ts L245-~275)
- Fields: token, bid, bid_qty, ask, ask_qty, last, bids, asks, version, at (RECEIVE ms), exchange_at (number|null), source: "ws".
- Immutable: the object is replaced on every packet, never mutated in place.

class BoxQuoteStore (L45-249)
- State (L46-59):
  - quotes: Map<number, BoxQuote>
  - updates
  - lastUpdate: number|null
  - nextVersion = 1
  - listeners: Set<BoxQuoteListener>
  - counters: authoritativeObservations, usableBookUpdates, depthlessIgnored, emptyInvalidations, malformedLevelsDropped, generationInvalidations
- Getters:
  - size (L62)
  - updateCount (L67)
  - lastUpdateAt (L78): the feed-liveness timestamp for the whole universe
  - get(token) (L82)
  - view(): Map (L87): returns the LIVE map itself
  - subscribe(listener): () => void (L102-107): returns the unsubscribe function
  - listenerCount (L110)
  - diagnostics() (L114-124): ready_books = quotes.size
- isFresh(token, maxAgeMs, now = Date.now()): boolean (L127-131): now − q.at ≤ maxAgeMs. There is NO guard against negative age. math.evaluateLeg, by contrast, treats a negative age as not fresh.
- applyTicks(ticks: BoxTickInput[], at = Date.now()): number[] (L142-199). Per tick:
  1. Decide whether the tick is authoritative: depth_updated === true, OR (depth_updated === undefined AND the object has its own "bids" or "asks" property, checked with hasOwnProperty) (L145-148).
     - Not authoritative: depthlessIgnored++ and skip. An LTP-only tick never touches the store.
  2. authoritativeObservations++. bids = sanitizeLevels(t.bids ?? [], BUY) and asks = sanitizeLevels(t.asks ?? [], SELL). updates++, lastUpdate = at, changed.push(token) (L154-159).
  3. If both sides are empty: quotes.delete(token), emptyInvalidations++, nextVersion++. A version number is consumed so a later book can never share identity with the pre-invalidation one. The token is still reported as changed (L161-168).
  4. Otherwise (L170-187):
     - bid = bids[0]?.price ?? 0 and ask = asks[0]?.price ?? 0.
     - bid_qty = Σ qty of levels with price === bid. ask_qty likewise.
     - last = isFinite(last_price) ? last_price : 0.
     - version = nextVersion++, at.
     - exchange_at = exchange_ts if it is a finite number > 0, else null. NO unit conversion is applied; see the note below.
     - source "ws". usableBookUpdates++.
     - The tick's scalar bid and ask fields are IGNORED. Only the ladders are used.
  5. After the batch: if changed is non-empty and there are listeners, call each listener(changed, at) in Set insertion order. Each call is wrapped in try/catch so a listener error is only warned (L189-197).
- sanitizeLevels (L201-221):
  - Drops a level, counting it in malformedLevelsDropped, when price is non-finite or ≤ 0, or qty is non-finite, not a safe integer, or ≤ 0.
  - orders = finite and ≥ 0 ? floor(orders) : 0.
  - Sorts BUY by descending price and SELL by ascending price. JS sort is stable, so use sort.SliceStable in Go.
  - Keeps only the first 5 levels: slice(0, 5).
- forget(tokens) (L224-226).
- clear() (L229-232): clears quotes and sets lastUpdate = null. It does NOT reset nextVersion, the listeners or the counters.
- invalidateGeneration() (L235-238): generationInvalidations++, then clear(). engine.invalidateFeedGeneration (~L1883) calls it on every socket open or close, together with spots.clear() and scanner.clearOpportunities().
- replay(ticks, at) (L246-248): just calls applyTicks.

How long a quote stays valid:
- An unchanged book stays valid for quoteMaxAgeMs, default 15_000 from BOX_QUOTE_MAX_AGE_MS (config.ts:1099; the doc is at L650-658). Silence is not treated as staleness.
- Dead-feed protection is separate: feedMaxAgeMs applies to the newest raw tick (engine.ts ~L1949).
- Freshness is always measured from receive time (`at`). exchange_at is only used for temporal-coherence metrics (math.temporalCoherence).

UNVERIFIED: the timestamp unit. engine.onTicks says the exchange_ts is "a Unix SECOND" but subtracts it from Date.now() in ms. BoxQuote's doc says epoch ms. The store copies the value through unchanged. Check what the ticker actually supplies.

class SpotStore (L252-274)
- spots: Map<number, {value, at}>.
- set(token, value, at = Date.now()) ignores value ≤ 0 (L255-258).
- get (L260).
- isFresh(token, maxAgeMs, now) = now − s.at ≤ maxAgeMs (L265-269).
- clear (L271).
- Written by engine.onTicks for subscribed spot tokens with last_price > 0 (engine ~L1912-1915), and by seedSpots after an async REST getQuoteFull (engine ~L2215-2229). The freshness rule used by callers is cfg.underlyingMaxAgeMs.

======================================================================
5. src/box/liquidityLedger.ts — PaperLiquidityLedger
======================================================================
WHAT IT IS
- Deterministic: no clock, no randomness and no imports.
- Stateful: two Maps.
- Used only in live-parity paper mode: `this.ledger = this.liveParity ? new PaperLiquidityLedger() : null` (executionSimulator.ts:234).
- It records how much displayed depth our OWN concurrent paper attempts have already consumed at each level, so they cannot double-spend it. It does not model the queue position of other market participants.

KEYS
- levelKey(gen, token, side, price, quoteVersion) = `${gen}|${token}|${side}|${Math.round(price*100)}|${quoteVersion}` (L37-46). Price is stored in paise.
- priceSeriesKey(gen, token, side, price) = `${gen}|${token}|${side}|${Math.round(price*100)}` (L77-84).

CONSTANTS: DEFAULT_MAX_SERIES = 4096 (L57). LiquidityLedgerOptions {maxSeries?} (L48-55).

class PaperLiquidityLedger (L59-202)
- State:
  - reserved: Map<levelKey, qty> (L65)
  - latestVersion: Map<seriesKey, version> (L70)
  - maxSeries = max(1, opts.maxSeries ?? 4096) (L74)
- reservedAt(gen, token, side, price, quoteVersion): number (L93-105). Returns 0 if quoteVersion < the latest version of that series. Otherwise returns reserved.get(levelKey) ?? 0.
- availableAt(gen, token, side, price, quoteVersion, effectiveForLevel): number (L116-126) = max(0, effectiveForLevel − reservedAt(...)). The caller has already applied the queue haircut.
- reserve(gen, token, side, price, quoteVersion, qty): number (L134-165):
  - qty not > 0: return reservedAt(...).
  - If there is no latest version yet, or quoteVersion > latest: delete the reservation held under the old latest version, set latestVersion[series] = quoteVersion, and call evictIfNeeded().
  - Else if quoteVersion < latest: return 0 and ignore the request.
  - Then reserved[key] += qty, and return the new total.
- clearGeneration(gen) (L171-179): deletes keys in both maps that start with `${gen}|`.
- clear() (L182-185).
- size = reserved.size (L187-189).
- evictIfNeeded() (L192-201): while latestVersion.size > maxSeries, drop the FIRST-INSERTED series and its `${series}|${version}` reservation.
  - In JS, updating an existing key in a Map keeps its insertion position. So eviction is by first sighting, not least-recently-used.
  - The Go port needs an insertion-ordered map with the same semantics.
- Expiry: there is none in time. A level's reservations are reset only when a newer quote version arrives, when its generation is cleared, or by eviction.

Determinism depends on the reserve calls happening in the same order every run. In Node that order comes from the quote-store listeners firing in subscription order within one synchronous applyTicks call.

======================================================================
6. src/box/scanner.ts — BoxScanner (event-driven discovery and entry)
======================================================================
IMPORTS
- From config: BoxConfig, configSnapshot (unused), prefilterGrossThreshold, requiredNetProfit.
- From charges: BoxChargeEstimator, buildEntryChargeLegs, BoxChargeLeg.
- BoxExecutionGateway from ./executionGateway.
- BoxChargeCalculatorLike from ./brokerContext.
- From ./executionFaults: classifyExecutionFault, faultErrorType, faultMessage, and the types BoxParentAttemptReason, ExecutionFaultLog, ExecutionStage.
- BoxMetrics.
- From math: evaluateCandidate, evaluateCandidateIndicative, evaluateEntryDecision, passesGrossPrefilter, round2.
- BoxQuoteStore, BoxPositionBook.
- From types: BOX_LEG_ROLES, directionOf (unused), and assorted types.

CONSTANTS
- EVALUATION_FAULT_LOG_INTERVAL_MS = 5_000 (L59).
- REJECT_LOG_COOLDOWN_MS = 60_000 (~L160).

DEPS: interface BoxScannerDeps (~L62-131)
- cfg, quotes: BoxQuoteStore
- charges: BoxChargeEstimator (unused here)
- localCharges: BoxChargeCalculatorLike (the active broker's calculator)
- executionSim: BoxExecutionGateway. Used here: hasCapacity(), simulateLeggingEntry({candidate, detection, stillWanted, qualify}), simulateEntry({...}).
- positions: BoxPositionBook. Used here: getByKey, isTaken, reserve, release, openKeys.
- metrics?: evaluations.mark, receiveToEvaluation.push, beginLogicalAttempt, finishLogicalAttempt.
- faults?: ExecutionFaultLog.record(...)
- reachedBroker?(): boolean, activeBroker?(): string
- openPaperTrade(args): Promise<string|null>
- onExecutionAttempt?(candidate, legging, reason, detail, detectedGrossEdge?)
- onEvent(event, candidate, evaluation, detail?). The event union is: DETECTED | ENTRY_REJECTED_STALE | _LIQUIDITY | _FEES | _DUPLICATE | _NET_PROFIT | _EXECUTION. DETECTED and FEES are never emitted by the scanner.
- Engine wiring is at engine.ts ~L803-840. onEvent calls appendBoxEvent. localCharges is this.localCharges, the active broker's calculator. reachedBroker is orderManager.status().inFlight > 0.

BoxScannerStats (~L134-154)
- ticksApplied, evaluations, prefilterPasses, qualifyAttempts, executionsAttempted, entriesOpened
- rejectedStale, rejectedLiquidity, rejectedNetProfit, rejectedExecution, rejectedDuplicate
- evaluationFaults, lastEvaluationAt
- getStats() returns a shallow copy.

STATE (~L162-192)
- candidates: Map<key, BoxCandidate>
- tokenIndex: Map<token, Set<key>> (the dependency index)
- opportunities: Map<key, BoxOpportunity>
- entryInFlight: Set<key>
- lastRejectLogAt: Map<"event|key", ms>. Never pruned.
- discovering = false, marketOpen = true, feedHealthy = true
- stats
- lastEvaluationFaultLogAt = 0

LIFECYCLE (L198-224)
- setDiscovering, isDiscovering, setMarketOpen, isMarketOpen, setFeedHealthy, isFeedHealthy, getStats.
- Engine calls: setDiscovering(true/false) at L1390 and L1440; setMarketOpen at L925, L1012 and L1699; setFeedHealthy from the feed-liveness timer (L1685), onTicks recovery (L1939) and generation invalidation (L1892).

CANDIDATES (L228-272)
- setCandidatesForUnderlying(underlying, next: BoxCandidate[]): void (L228-252).
  - Removes every candidate of that underlying from candidates and opportunities, and from tokenIndex across the four leg tokens (an empty set deletes its token).
  - Then inserts next and indexes all four leg tokens.
- removeUnderlying(u) (L254-256).
- candidateCount, monitoredTokenCount, getCandidate(key), candidatesFor(u).

UNIVERSE (built by the engine and instruments.ts, not the scanner)
- Expiry: indexOptionChains (instruments.ts ~L59-105) picks the NEAREST non-expired expiry. Expiries are ISO strings; it drops expiry < today (IST) and takes the first after sorting.
- Window: buildUnderlyingState (instruments.ts L122-160) calls math.selectStrikeWindow(chain.strikes, spot, eachSide).
  - eachSide = engine.strikeLevel, which is 1, 2 or 3, capped by cfg.strikesEachSide = 3 (config.ts:675 and :1103).
  - ATM = math.atmStrikeFor: the strike with the minimum |strike − spot|. Ties go to the LOWER strike.
  - The window is sorted unique strikes [idx − eachSide, idx + eachSide], clipped at the ends of the chain. Missing strikes on one side are not borrowed from the other side.
  - CE and PE maps are filled for each window strike.
- Re-centring: windowNeedsRebuild calls shouldRecentreWindow, which requires |spot − ATM| > step × (0.5 + hysteresis), plus a minIntervalMs damp. step = strikeStepOf, the median gap between strikes.
- Candidates: math.buildCandidates. Every pair K1 < K2 in the window where both strikes have a CE and a PE and singleLotLegViolation passes, for each direction in engine.directions.
  - Returns [] if lot_size is not a positive safe integer.
  - key = `${underlying}|${expiry}|${k1}|${k2}|${direction}`, box_width = round2(k2 − k1), legs {k1_ce, k2_ce, k2_pe, k1_pe}.
- engine.ts ~L2120-2203 runs this on a universe setInterval (~L1407). It calls setCandidatesForUnderlying only when the window state object changed, calls removeUnderlying for windows that dropped out, and then calls charges.prune().

SCAN CADENCE (tick-driven; no debounce or throttle)
- engine.onTicks (~L1903-1942):
  1. Update spots.
  2. changed = quotes.applyTicks(ticks, now).
  3. monitor.onTokensUpdated(changed) runs FIRST, then scanner.onTokensUpdated(changed, now).
- onTokensUpdated(tokens: number[], receivedAt?: number): void (L282-301):
  - ticksApplied += tokens.length.
  - Takes the union of tokenIndex keys into an `affected` Set (in insertion order).
  - Uses its own now = Date.now(), NOT receivedAt.
  - Calls safeEvaluate on each affected candidate.
- refreshAll(): void (L303-308). Evaluates every candidate. The engine calls it at L1214 (if the market is open), L1357 and L1707, which look like discovery start, market-open and feed-recovery transitions; I did not verify.
- publishIndicative(lastPrices: Map<number,number>): number (L963-~981). Used while the market is closed (engine indicative timer ~L1728/1825).
  - Evaluates every candidate with evaluateCandidateIndicative and publishes it with decision null, priceSource "last_close", and openKeyTaken from positions.openKeys().
  - Returns how many were priced and sets stats.lastEvaluationAt.

safeEvaluate(cand, now, receivedAt?) (L322-~355)
- Runs evaluateAndMaybeEnter inside a try. On an error:
  - classifyExecutionFault({stage: "pre_decision", error}).
  - evaluationFaults++.
  - faults.record({at, fault_class, stage: "pre_decision", execution_mode, paper_profile, broker, error_type, message, stack, candidate_key, reservation_held: positions.isTaken(key), exposure_existed: getByKey !== undefined, reached_broker: null}).
  - console.warn, at most once every 5 s.

PER-CANDIDATE PIPELINE: evaluateAndMaybeEnter (~L357-419), in order
 1. evaluations++, lastEvaluationAt = now, metrics.evaluations.mark(1, now).
 2. evaluation = evaluateCandidate({candidate, quotes: quotes.view(), now, maxAgeMs: cfg.quoteMaxAgeMs, captureDepth: false}). What evaluateCandidate does (math.ts):
    - Per leg, the side comes from BOX_ENTRY_SIDES_BY_DIRECTION:
      - LONG: k1_ce BUY, k2_ce SELL, k2_pe BUY, k1_pe SELL.
      - SHORT is the mirror.
    - Touch: BUY uses the best (lowest) ask and SELL the best (highest) bid. qty = Σ qty at exactly that price. The scalar bid/ask is a fallback only.
    - age = now − quote.at. fresh = age ≥ 0 AND age ≤ maxAgeMs.
    - executable = price > 0 AND qty ≥ lot_size. Deeper levels are never walked.
    - netDebit = round2(Σ (BUY ? +price : −price)).
    - grossPerUnit = round2(sign × width − netDebit). grossEdge = round2(grossPerUnit × lot_size).
    - reject is the first that applies: no_quote, then stale_quote, then missing_ask/missing_bid (by side), then insufficient_qty.
    - tradable = reject === null AND grossEdge !== null.
    - worst_age_ms is set only if all 4 legs have an age. quote_version is the maximum leg version.
 3. If receivedAt is defined: metrics.receiveToEvaluation.push(max(0, now − receivedAt)).
 4. openKeyTaken = positions.getByKey(key) !== undefined.
    threshold = prefilterGrossThreshold(cfg) = max(0, cfg.minGrossEdge). MIN_BOX_GROSS_EDGE defaults to 1200 (config.ts:1085, 1167-1169).
    passedPrefilter = gross ≠ null AND gross ≥ threshold. If it passes, prefilterPasses++.
 5. publish(evaluation, {openKeyTaken, passedPrefilter, decision: localDecisionFor(evaluation, cfg.expectedEntrySlippage)}). This ALWAYS runs, before any gate.
 6. Gates, in order. Each one is a silent return unless noted:
    - !discovering
    - !marketOpen
    - !feedHealthy
    - openKeyTaken
    - !tradable → noteRejection, then return
    - !passedPrefilter
    - entryInFlight.has(key)
    - !executionSim.hasCapacity()
 7. localDecision = localDecisionFor(...) again; it is deterministic and gives the same result. If it is null or does not qualify: noteNetProfitRejection only when reject === "below_expected_net_profit"; then return.
 8. executionDetection = evaluateCandidate(..., captureDepth: true). This is an immutable snapshot that includes depth. Then `void attemptEntry(cand, executionDetection)`.

localDecisionFor(evaluation, entrySlippageAllowance): BoxEntryDecision|null (~L428-453)
- Returns null if gross is null, or if buildEntryChargeLegs returns null.
- totals = localCharges.totals(legs mapped to {side, tradingsymbol, quantity, price}).
- Returns evaluateEntryDecision({grossEdge, entryCharges: totals.entry, estimatedExitCharges: totals.exit, entrySlippageAllowance, futureExitSlippageAllowance: cfg.expectedExitSlippage, cfg}).

THE ENTRY GATE FORMULA (math.evaluateEntryDecision)
  entryAllowance  = round2(entrySlippageAllowance)            BOX_EXPECTED_ENTRY_SLIPPAGE, default 250 (config.ts:1088)
  exitAllowance   = round2(futureExitSlippageAllowance)       BOX_EXPECTED_EXIT_SLIPPAGE, default 250 (config.ts:1089)
  execution_cost  = round2(entryAllowance + exitAllowance)
  expectedNet     = round2(gross − entryCharges − exitCharges − execution_cost − safetyBuffer)
                    BOX_SAFETY_BUFFER, default 150 (config.ts:1087)
  minNet          = requiredNetProfit = max(minExpectedNetProfit, minNetEdge > 0 ? minNetEdge : 0)
                    BOX_MIN_EXPECTED_NET_PROFIT default 1200 (config.ts:1083); MIN_BOX_NET_EDGE default 0 (config.ts:1086); formula at config.ts:1152-1156
  passes_gross_prefilter = gross ≥ cfg.minGrossEdge   (note: NOT max(0, …))
  reject order: no_quote (gross null), then unpriced_charges, then below_gross_prefilter, then below_expected_net_profit (expectedNet < minNet); otherwise qualifies.

attemptEntry(cand, detection): Promise<void> (~L470-702)
 1. If !positions.reserve(key): rejectedDuplicate++, logRejection(DUPLICATE, "strike pair already taken"), return. Nothing is reserved, so there is nothing to release.
 2. Synchronously, before the first await: entryInFlight.add(key), qualifyAttempts++, executionsAttempted++.
    attemptId = `entry:${key}:${detection.at}`; metrics.beginLogicalAttempt(attemptId).
    stage = "pre_decision"; detectionDecision = null.
 3. finish(outcome, reason, realisedNet, decisionToFillMs, arrivalSlip) calls metrics.finishLogicalAttempt(attemptId, outcome, reason, {...}) with:
    - decisionDeterioration = round2(detectionDecision.expected_net_profit − realisedNet), or null
    - arrivalExecutionSlippage
    - detectionToDecisionMs: 0, decisionToOrderSendMs: 0
    - orderLatencyMs = decisionToFillMs, decisionToFillMs
 4. stillWanted() = discovering AND marketOpen AND feedHealthy AND getByKey(key) === undefined. It is re-evaluated by the gateway, before the first fill only.
 5. qualifyStaged(execution, measuredSlippage) temporarily sets stage = "final_qualification", calls finalQualify, then restores stage.
 6. Inside the try:
    - detectionDecision = localDecisionFor(detection, cfg.expectedEntrySlippage); stage = "execution".
    - Mode "paper_legging" or "live": legging = await executionSim.simulateLeggingEntry({candidate, detection, stillWanted, qualify}).
      - If !legging.ok:
        - Call onExecutionAttempt if filled_leg_count > 0 or emergency_unwind is set, passing detection.gross_edge.
        - recordExecutionFailure.
        - finish with: PARTIAL_UNRESOLVED if residual_exposure is non-empty; else ABORTED if abort_after_fill; else PARTIAL_RECOVERED if filled_leg_count > 0; else FAILED. Pass reason, final_expected_net_profit, decision_to_last_fill_ms and null.
        - positions.release(key) and return.
      - Otherwise: stage = "trade_persistence", opened = await finalizeOpen(cand, legging.evaluation, legging.decision, null, legging.legging), then finish(opened ? SUCCESS : PARTIAL_UNRESOLVED, opened ? null : "persistence_unavailable", decision.expected_net_profit, decision_to_last_fill_ms, null).
    - Any other mode (the default is "paper_latency", config.ts:880): result = await executionSim.simulateEntry({...}).
      - If !ok: recordExecutionFailure; finish("FAILED", reason, null, record.decision_to_fill_ms, record.executed_at === null ? null : 0); release.
      - Otherwise: stage = "trade_persistence"; finalizeOpen(…, result.record, null); finish(SUCCESS or PARTIAL_UNRESOLVED, …, arrival slippage 0).
    - Once any leg has filled, discovery state is never re-checked. The execution owns the position.
 7. catch:
    - classifyExecutionFault({stage, error}).
    - faults.record(...). reached_broker = reachedBroker() in live mode, null otherwise.
    - console.error for the severe classes (trade_persistence_error, broker_state_error, execution_invariant_error, reservation_authority_unavailable); console.warn otherwise.
    - rejectedExecution++; logRejection(EXECUTION, `${faultClass}: ${stage}`); finish("FAILED", faultClass, null, null, null); positions.release(key).
    - finally: entryInFlight.delete(key).

finalQualify(execution, measuredSlippage): BoxEntryDecision (~L712-750)
- If the legs are null: return a hard-coded decision with execution_cost 0, both allowances 0, measured null, safety_buffer = cfg, expected null, min = requiredNetProfit, passes_gross_prefilter false, qualifies false, reject "unpriced_charges".
- Otherwise: evaluateEntryDecision with the EXECUTED gross, the local totals, entrySlippageAllowance 0, futureExit = cfg.expectedExitSlippage and measuredEntrySlippage = measuredSlippage (recorded, not deducted).

finalizeOpen(cand, evaluation, decision, execution, legging): Promise<boolean> (~L752-810)
- legs = buildEntryChargeLegs(evaluation). If null: console.error "LOST FILL", release, return false.
- local = localCharges.roundTrip(orders).
- id = await openPaperTrade({candidate, evaluation, entryLegs: legs, entryChargesTotal: local.entry_total, estimatedExitChargesTotal: local.estimated_exit_total, chargeOrigin: "local", decision, execution, legging}).
- If id: entriesOpened++ and markStatus(key, live ? "LIVE_OPENED" : "PAPER_OPENED").
- Otherwise: console.error "LOST FILL" and release.
- Returns id !== null.

REJECTION ROUTING
- recordExecutionFailure(cand, detection, reason, detail) (~L812-835):
  - "below_expected_net_profit" → rejectedNetProfit, event NET_PROFIT(detail).
  - insufficient_quantity, missing_book or price_moved → rejectedLiquidity, but the event is ENTRY_REJECTED_EXECUTION with `${reason}: ${detail}`.
  - Everything else → rejectedExecution, event EXECUTION.
- noteRejection(cand, eval, detail?) (~L839-856):
  - stale_quote or no_quote → rejectedStale, event STALE.
  - insufficient_qty, missing_bid or missing_ask → rejectedLiquidity, event LIQUIDITY.
- noteNetProfitRejection (~L858-869): rejectedNetProfit, with detail `expected net ₹${expected ?? "?"} < required ₹${min}`.
- logRejection(event, cand, eval, detail?) (~L871-881):
  - Emits NOTHING unless the evaluation's gross passes the prefilter threshold.
  - Cooldown: if now − lastRejectLogAt["event|key"] < 60_000, skip. Otherwise set it and call deps.onEvent.
  - Counters are incremented even when the event is suppressed.

PUBLICATION
- markStatus(key, status) (~L885-888): copies the existing row with the new status and updated_at = Date.now().
- publish(evaluation, ctx {openKeyTaken, passedPrefilter, decision, priceSource?}) (~L890-957). The status is the first rule that matches:
  - OPEN if openKeyTaken
  - else the previous status, if it was PAPER_OPENED or LIVE_OPENED (it sticks until the position shows up, and then becomes OPEN)
  - else INDICATIVE if priceSource is last_close
  - else, if !tradable: REJECTED when passedPrefilter, otherwise WATCHING
  - else ELIGIBLE if decision.qualifies
  - else WATCHING
  - UNPRICED is never assigned.
- BoxOpportunity fields (types.ts L528+):
  - key, underlying, name, is_index, expiry, direction, lower_strike, upper_strike, box_width, lot_size, quantity = lot_size
  - entry_box_cost = round2(netDebitPerUnit × lot_size), or null
  - gross_edge, entry_charges, estimated_exit_charges
  - execution_cost = decision.execution_cost; without a decision it is cfg.expectedEntrySlippage + cfg.expectedExitSlippage, unrounded
  - safety_buffer = cfg.safetyBuffer
  - projected_net_edge = expected_net_profit = decision.expected_net_profit
  - min_expected_net_profit = requiredNetProfit(cfg)
  - charge_origin "local"
  - entry_sides [{role, side, tradingsymbol}]
  - liquidity_ok = tradable, depth_ok, worst_age_ms
  - price_source = priceSource ?? "touch"
  - status, reject
  - legs = evaluation.legs without `depth` and `quote_version`
  - updated_at = evaluation.at
- listOpportunities(limit): BoxOpportunity[] (~L987-1017):
  - Status OPEN, PAPER_OPENED or LIVE_OPENED: always included.
  - Any other status: included only if gross_edge is non-null and > 0. This works because min(threshold, 0) is always 0.
  - Sorted by (expected_net_profit ?? gross_edge ?? −∞), highest first. The sort is stable, so ties keep Map insertion order; use SliceStable.
  - Returns slice(0, limit). The engine passes maxPublishedOpportunities.
- opportunitiesFor(u), clearOpportunities().
- The UI is pushed on its own cfg.publishIntervalMs timer, not by the scanner.

STATE MACHINES
- Opportunity status, as above.
- Entry stage: pre_decision → execution → (final_qualification only while the qualify callback runs) → trade_persistence.
- Parent attempt outcomes: SUCCESS, FAILED, PARTIAL_RECOVERED, PARTIAL_UNRESOLVED, ABORTED.
- Reconciler item: queued → running → verified, or retry(attempt n) → … → failed. With no session it goes straight to failed (skipped).

======================================================================
7. What the Go port must get exactly right: rounding and concurrency
======================================================================
ROUNDING
- JS Math.round(x) equals floor(x + 0.5): halves round toward +∞. Go's math.Round rounds halves AWAY from zero.
- They give different answers for negative halves. That affects headDiffs, negative gross or slippage values, decisionDeterioration, and round2 of any negative money value.
- Implement round2 as math.Floor(x*100 + 0.5)/100.
- Keep the floating-point operation order exactly: (value*percent)/100, then round.
- Use the same rule for STT rounding to the rupee and for the paise key in the liquidity ledger.
- toFixed(2) appears only in charge cache keys, which are internal.

CONCURRENCY
In Node, everything below runs on one thread. Each item says what needs a lock or atomic in Go.
- BoxQuoteStore.quotes, nextVersion, lastUpdate, updates, the counters and listeners:
  - Written by applyTicks on the WS path. Read by view() during scanner, monitor and simulator evaluation, and by the API.
  - view() hands out the LIVE map. Go needs a RWMutex, or a single event-loop goroutine. Keep BoxQuote immutable and store pointers to it.
  - listeners are added and removed from async simulator code, possibly in the middle of a notification. JS Set iteration visits listeners added during the loop and skips ones deleted before they are visited.
  - Listener notification order must stay deterministic, in subscription order, because PaperLiquidityLedger results depend on it.
- SpotStore.spots: written by onTicks and by seedSpots after an await; read by the universe timer.
- BoxScanner.candidates, tokenIndex and opportunities:
  - Mutated by the universe timer, by clearOpportunities on feed-generation change, and by markStatus after awaits in finalizeOpen.
  - Read by the tick path and the publish timer.
- BoxScanner.entryInFlight:
  - The test in evaluateAndMaybeEnter and the add in attemptEntry are atomic only because attemptEntry runs synchronously up to its first await.
  - In Go, positions.reserve and entryInFlight.add must happen as one atomic test-and-set BEFORE a goroutine is spawned. The delete happens in finally from the async goroutine.
- BoxScanner.stats counters: incremented from both the tick path and async completions.
- BoxScanner.lastRejectLogAt: check-then-set from the tick path and from async failure paths. It is never pruned.
- BoxScanner.lastEvaluationFaultLogAt.
- discovering, marketOpen, feedHealthy: read inside stillWanted() from the gateway after awaits. Use atomic.Bool.
- The `stage` local in attemptEntry: mutated by the qualify callback the gateway invokes. It needs sync if that callback runs on another goroutine.
- BoxChargeEstimator.cache, inFlight, active and stats:
  - The cache-check, inFlight-check and inFlight-set sequence must be atomic. Use a mutex plus a singleflight-style pattern.
  - estimate returns the shared promise; estimateExitOnly awaits it.
  - Both functions share one cache and one inFlight map, separated only by the "exit:" key prefix.
- BoxChargeReconciler.queue, workers, seen and stats:
  - Touched by submit (async engine code), by pump on worker completion, and by timer callbacks.
  - Use a mutex, workers as goroutines, and time.AfterFunc for retries.
- PaperLiquidityLedger.reserved and latestVersion:
  - Mutated by concurrent paper attempts through quote listeners.
  - Calls must be serialized in the same deterministic order, not merely locked.
  - Eviction depends on first-insertion order.
