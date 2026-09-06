# Box execution parity — architecture audit and implementation plan

Audit of the Box execution architecture as it stood on `main` at commit `b74b64c`, and the
plan that follows from it. Written before any code changed, so the divergence list below is
a record of what was actually there — not of what was built afterwards.

The objective: make paper `live_parity` behave as closely as *observably* possible to real
Zerodha/Dhan LIMIT execution, **without ever inventing information a retail broker API and
level-2 depth cannot provide.**

---

## 1. The two lifecycles, side by side

### Live

```
BoxEngine
  → CentralBoxExecutionGateway          feed warmth, depth precheck, bounded-LIMIT build
  → BoxOrderManager                     durable intent BEFORE transport, priority queue,
                                        concurrency cap, safety gates, reconciliation
  → BrokerAdapter (Kite | Dhan)         pacing, HTTP, poll-to-terminal, protective cancel
  → transport
```

Stage by stage, and what the code actually did:

| Stage | Live implementation | Evidence |
| --- | --- | --- |
| detection | scanner evaluates candidate | `scanner.ts` |
| qualification | `math.ts` economics + gateway prechecks | `executionGateway.ts:307-321` |
| strategy decision | `entryDecision` | `math.ts` |
| scheduler enqueue | `BoxOrderManager.submit()` pushes onto priority queue | `orderManager.ts:381-410` |
| scheduler dequeue | `pump()` re-checks mutable gates, then `execute()` | `orderManager.ts:488-548` |
| broker request | durable `CREATED` → `SUBMITTING` → `adapter.submitOrder()` | `orderManager.ts:560-583` |
| broker ACK | `order.state = "ACKNOWLEDGED"` once the POST returns an order id | `kiteBrokerAdapter.ts:332` |
| exchange-working | `OPEN` / `PARTIALLY_FILLED` via REST poll | `kiteBrokerAdapter.ts:518-534` |
| partial fills | cumulative `filled_quantity` from each poll snapshot | `kiteBrokerAdapter.ts:660-676` |
| full fill | `COMPLETE` | `kiteState()` |
| timeout | `ackTimeoutMs` / `workingTimeoutMs` / `partialTimeoutMs` | `kiteBrokerAdapter.ts:521-527` |
| cancel request | `CANCEL_REQUESTED` then DELETE | `kiteBrokerAdapter.ts:350-370` |
| cancel confirmation | `confirmTerminalAfterCancel()` re-reads until terminal | `kiteBrokerAdapter.ts:559-574` |
| **fill during cancellation** | **handled** — the re-read can return `COMPLETE`; Mongo permits `CANCEL_REQUESTED → COMPLETE` and even `CANCELLED → COMPLETE` | `repository.ts:651-654` |
| unwind | gateway protective unwind of confirmed fills | `executionGateway.ts:323-355` |
| reconciliation | `performReconcile()` on a timer + at boot; adoption by client id → broker id → tag | `orderManager.ts:636-868` |
| final position state | attributed positions diffed against broker positions | `orderManager.ts:816-831` |
| P&L / charges | `charges.ts` estimate, `chargeReconciler.ts` reconciliation | — |

### Paper `live_parity`

```
BoxExecutionSimulator (profile === "live_parity")
  → planArrivals → planPaperSchedule        queue + concurrency + transport pacing
  → LegExecutor.run                          arrival, book walk, partial, timeout
  → PaperLiquidityLedger                     shared displayed liquidity
```

---

## 2. Divergences found

Grouped by the phase of the brief that addresses each. **D-numbers are referenced from the
code comments of every fix**, so a reader of any new module can find why it exists.

### Instrumentation

- **D1 — `brokerTimingStore.ts` was dead code.** Zero call sites anywhere in `src/`. It was
  instantiated only by tests, and `LIVE_EXECUTION.md:192` documented it as if wired. None of
  the eleven timestamps it wants (`acknowledged_at`, `first_fill_at`, `cancel_confirmed_at`, …)
  were captured on the live path at all.
- **D2 — no monotonic clock.** Every adapter used `Date.now()`. Latency arithmetic on a
  wall clock is corrupted by NTP steps; there was no separate audit-vs-measurement clock.
- **D3 — no time-of-day or per-profile bucketing.** `LatencyOperationKind` existed, but open
  / normal-session / close conditions were pooled, as were marketable and passive orders.

### ACK is not fill

- **D4 — the observable lifecycle was coarser than reality.** `QUEUED`, `POSTING`,
  `BROKER_ACCEPTED`, `WORKING`, `CANCEL_PENDING` and `EXPIRED` were not distinguished.
  The durable vocabulary (`BoxOrderIntentState`) is enforced by Mongo's
  `INTENT_STATE_PREDECESSORS` guard, so it cannot be widened without a migration.
- **D16 — paper had no ACK stage at all.** `ack_at` was folded straight into
  `leg.arrival_at` (`legExecutor.ts:322-325`); there was no `ACKNOWLEDGED`/`WORKING` status,
  no ACK timeout and no broker-accept stage.

### Fill accounting

- **D5 — `fillIdentities` in the OrderManager was dead.** `orderManager.ts:874-877`'s
  `continue` skipped nothing and the set was never read. Worse, live-Kite's `fills[]` is a
  single *synthetic aggregate* whose `fill_id` mutates as the cumulative quantity grows
  (`kiteBrokerAdapter.ts:667-672`), so it is not a fill history and per-fill dedupe was
  impossible. Monotonicity was protected only by Mongo's `filled_quantity: {$lte}` guard.

### Cancel-vs-fill race

- **D17 — paper did not model the race at all.** `abandon()` was instantaneous
  (`legExecutor.ts:374-387`): a paper order could never be filled after a cancel was
  requested. The vocabulary existed but was unreachable — the `cancel_race` outcome
  (`brokerTimingStore.ts:77`), the `CANCEL` operation kind (`latencyModel.ts:50`) and the
  `cancel_confirmation_ms` component were produced by nothing.

### Ambiguous transport

- **D6 — Kite and Dhan were asymmetric.** Dhan reconciles inline by correlation id on an
  ambiguous POST and never re-POSTs (`dhanBrokerAdapter.ts:310-348`). Kite had **no** inline
  lookup: ambiguity always became `RECONCILIATION_REQUIRED` and waited for the periodic
  reconciler, even though the stable tag makes a lookup possible.
  `kiteBrokerAdapter.ts:778`'s `isTimeoutLike` was dead code.

### Order-event ingestion

- **D7 — no fast path, by deliberate choice.** Kite WS text frames are ignored
  (`ticker.ts:93`) and the Dhan postback route is intentionally inert
  (`brokers/routes.ts:319-336`) because an unauthenticated webhook must not move a live
  order's state. The consequence is real: the only asynchronous convergence was the
  60-second reconciler, and there was no idempotent ingestion path to attach a trusted
  event source to later.

### Latency model

- **D18 — the scheduler's slot-hold model was computed then thrown away.**
  `planArrivals` mapped `planPaperSchedule(...)` to `s.ack_at` only
  (`executionSimulator.ts:258`); `terminal_at`, `queue_wait_ms` and `transport_wait_ms` were
  discarded, so paper recorded none of the stage timings it had just derived.
- **D19 — `BOX_SIMULATED_LATENCY_MS=250` was permanent.** The structured source could read
  samples from config, but nothing ever fed measured live samples back into it, and
  `classifyCalibration` / `StructuredLatencySource.calibrated` were computed and never
  surfaced into an execution record.

### Queue / liquidity honesty

- **D11 — no queue evidence was captured.** Displayed depth at submission, executable
  quantity within the limit, limit distance from touch, marketability and the eventual
  realisation ratio were never recorded, so the 30 % haircut could not be validated against
  anything.
- **D20 — `PaperOrderType` was a single-member union** (`types.ts:723`). Passive and
  marketable statistics were structurally impossible to separate.
- **D23 — the ledger models only our own double-spend.** Correct and honest as far as it
  goes, but it does not compare successive book versions, so displayed size was implicitly
  assumed to persist until the next version replaced it wholesale.

### Observability gaps

- **D9** — no event-loop lag or process-pressure measurement, so a Node scheduling stall was
  indistinguishable from broker latency.
- **D10** — quote age was checked (`quoteMaxAgeMs`) but never *recorded per decision*, and
  cross-leg timestamp dispersion was checked only at qualification.
- **D8** — `BrokerRejectFamily` existed and was persisted, but no reject-rate statistics
  were derived from it.
- **D24** — no edge-decay, adverse-selection or implementation-shortfall attribution.
- **D13 / D21** — `parityReport.ts` had **no production caller**; there was no paper-side
  snapshot producer, so a live-vs-paper report could not be built outside a unit test.
- **D12** — no calibration persistence; every sample died with the process.
- **D14** — no shadow mode. **D25** — no stress profile distinct from `live_parity`.
- **D22** — feed generation exists and correctly gates the ledger and the live depth
  precheck, but paper replay cannot reproduce a feed gap.

### What was already right, and must not regress

Worth stating plainly, because several of these are the hard parts and they were already
correct:

1. Durable intent is written to Mongo **before** any transport call (`orderManager.ts:565`).
2. Cumulative broker quantity is authoritative; there is no delta accumulation in live.
3. The Mongo state machine deliberately permits `CANCEL_REQUESTED → COMPLETE` and
   `CANCELLED → COMPLETE` — the cancel race was already respected on the live side.
4. `assertBoundedLimit` makes a MARKET order unrepresentable.
5. Adapters are double-gated: a disabled adapter makes zero broker calls, including reads.
6. Controls start `false`; `BOX_EXECUTION_MODE=live` throws at boot without
   `BOX_LIVE_TRADING_ENABLED=true`.
7. There is no `Math.random()` anywhere in `src/box/`.

---

## 3. Implementation plan

Ordered, each step naming the divergences it closes. Every step is additive: the default
configuration must keep producing byte-identical behaviour.

| # | Work | Closes |
| --- | --- | --- |
| 1 | `executionClock.ts` — monotonic measurement clock paired with a wall clock for audit | D2 |
| 2 | `orderLifecycle.ts` — 15-stage observable vocabulary mapped onto the *unchanged* durable states, plus an idempotent cumulative-authoritative fill ledger | D4, D5, D16 |
| 3 | `eventLoopMonitor.ts` — event-loop delay + process pressure, fail-open | D9 |
| 4 | `executionCalibration.ts` — rolling bounded distributions per (broker, kind, profile, time bucket) with min-sample gating, bucket fallback, freshness and confidence | D3, D19 |
| 5 | `calibratedLatencySource.ts` — paper draws from measured distributions when valid, documented fallback otherwise, never mislabelled | D19 |
| 6 | Leg executor: explicit ACK/WORKING stages and a real cancel-vs-fill race window | D16, D17 |
| 7 | Marketable vs passive classification, statistics never mixed | D20 |
| 8 | Wire the timing recorder into the live OrderManager and both adapters, fail-open | D1, D18 |
| 9 | Kite inline reconcile-by-tag on ambiguous POST; idempotent fill application | D6, D5 |
| 10 | `queueCalibration.ts` — offline haircut recommender from live evidence, with confidence | D11, D23 |
| 11 | Reject-family statistics from real observations only | D8 |
| 12 | Shortfall / adverse-selection attribution and paired live-vs-paper comparison | D24, D13, D21 |
| 13 | Shadow mode; stress profile separate from `live_parity` | D14, D25 |
| 14 | Bounded async calibration persistence | D12 |
| 15 | Admin diagnostics; config; docs; deterministic tests; golden fixtures | — |

### Constraints held throughout

- Strategy mathematics, thresholds, direction logic, option selection, expiry logic and fee
  semantics are **not touched**. Existing golden fixtures prove this.
- No new randomness. `Math.random()` stays absent from `src/box/`.
- Live trading is not enabled, and the default execution mode is not changed.
- Telemetry is fail-open; a diagnostics failure can never block a cancel or an unwind.
- No Mongo query per tick, no network I/O in qualification, no per-packet logging.

### Deliberately NOT built

Because the data to support them does not exist:

- True NSE queue position, hidden liquidity, or matching-engine sequence.
- A market-impact price model. Size-vs-depth ratios are *exposed*; impact is not invented.
- Random broker rejects or random slippage in `live_parity`. Recorded rejects can be
  replayed; a stress profile may inject them, and that profile is never called live parity.


---
---

# PART 2 — Post-implementation audit

Everything above was written *before* any code changed. This part is the audit performed *after*,
answering each required question from the code as it now stands. Where the honest answer is "no",
it says no.

## 1. Files changed

**New modules (16)**

| File | Purpose |
| --- | --- |
| `src/box/executionClock.ts` | monotonic clock for durations, wall clock for audit |
| `src/box/orderLifecycle.ts` | 15-stage observable vocabulary + `CumulativeFillLedger` |
| `src/box/executionEnvironment.ts` | event-loop delay + process pressure |
| `src/box/executionCalibration.ts` | dimensioned rolling distributions + fallback ladder |
| `src/box/calibratedLatencySource.ts` | paper's measured-latency source + honesty contract |
| `src/box/executionTiming.ts` | per-order stage recorder, fail-open |
| `src/box/queueCalibration.ts` | realisation-ratio measurement + advisory haircut |
| `src/box/executionShortfall.ts` | shortfall attribution + adverse selection |
| `src/box/pairedComparison.ts` | paired live-vs-paper error distributions |
| `src/box/executionOutcomes.ts` | measured outcome + reject-family rates |
| `src/box/calibrationPersistence.ts` | bounded async persistence buffer |
| `src/box/shadowMode.ts` | shadow guard |
| `src/box/stressProfile.ts` | fault-injection profile, structurally isolated |
| `docs/EXECUTION_PARITY_AUDIT.md` | this document |
| 9 new test suites | see §13 |
| 8 new golden-fixture files | see §13 |

**Modified (19):** `types.ts`, `legExecutor.ts`, `executionSimulator.ts`, `paperScheduler.ts`,
`orderPricing.ts`, `latencyModel.ts`, `brokerAdapter.ts`, `executionGateway.ts`, `orderManager.ts`,
`kiteBrokerAdapter.ts`, `dhanBrokerAdapter.ts`, `brokerContext.ts`, `engine.ts`, `config.ts`,
`model.ts`, `repository.ts`, `routes.ts`, `boundedCache.ts`, `brokers/registry.ts`,
`brokers/zerodha/liveAdapter.ts`.

**Untouched, deliberately:** `math.ts`, `scanner.ts`, `charges.ts`, `localCharges.ts`,
`positions.ts`, `positionMonitor.ts`, and every frontend file. Strategy mathematics, thresholds,
direction logic, option selection, expiry logic and fee semantics are unchanged, proven by the
pre-existing golden fixtures still passing byte-for-byte.

## 2. Execution lifecycle, before vs after

| Stage | Before | After |
| --- | --- | --- |
| detection → decision | unmeasured | `detected` / `qualified` marks available |
| durable persistence | happened, unmeasured, modelled as 0 in paper | **`intent_persisted` measured**; paper models the measured p50, else 0 and says so |
| scheduler wait | live only | measured `scheduler_wait_ms`; paper reproduces from the shared policy |
| transport pacing | conflated with persistence | `transport_wait_ms` now genuinely pacing |
| HTTP submission | Kite quarantined all ambiguity | Kite adopts by tag when uniquely identified; still never re-POSTs |
| broker ACK | set, never timestamped | `broker_order_id` + `acknowledged` marks; `ack_at` in paper |
| exchange-working | live only | see §7 — **partially** distinct |
| partial fills | live cumulative; paper book-walk | unchanged, now both funnelled through an idempotent ledger |
| cancel/fill race | live respected; **paper not modelled** | **paper models it**; 52/23 pinned by test + fixture |
| four-leg completion / unwind | unchanged | unchanged |
| residual flatten | charges discarded (paper) / never computed (live) | **billed, persisted via `$inc`, counted against daily risk** |
| all actual charges | flatten missing | flatten included as its own `flatten_charges` field |
| final P&L | flatten cost absent | flatten cost recorded; historical `net_abort_pnl` deliberately not rewritten |

## 3. What new measurements are REAL

Genuinely measured from live operations, monotonic, per broker / kind / profile / time bucket:
`scheduler_wait_ms`, `persistence_wait_ms`, `transport_wait_ms`, `post_to_http_response_ms`,
`post_to_ack_ms`, `ack_to_first_fill_ms`, `ack_to_terminal_ms`, `partial_to_terminal_ms`,
`cancel_request_to_terminal_ms`; event-loop p50/p95/p99 and stall events; CPU/memory; reject
families from real refusals; outcome rates; queue realisation ratio; size vs visible depth.

## 4. What still uses a fallback

| Stage | Fallback | Reported as |
| --- | --- | --- |
| POST→ACK | `BOX_SIMULATED_LATENCY_MS` (250) | `measured: false`, `confidence: LOW` |
| ACK→terminal | 40 % of that constant | `measured: false` |
| cancel window | `BOX_PAPER_CANCEL_LATENCY_MS` (150) | `cancel_window_measured: false` |
| **durable persistence** | `BOX_PAPER_PERSISTENCE_MS` (**0**) | `persistence_window_measured: false` |
| queue share | 30 % haircut | advisory recommendation only |

The persistence fallback of 0 makes paper **optimistic** on that stage. That is a deliberate
choice over guessing, and it is surfaced rather than hidden.

## 5. What remains fundamentally unknowable

`live_parity` cannot reconstruct, and never fabricates:

- **true NSE queue position** of our order;
- **hidden or iceberg liquidity**;
- **matching-engine ordering**;
- **another participant's future order**;
- **exact market impact** of our own order.

**This is not an exact exchange simulator.** It is a deterministic digital twin of the observable
execution path.

## 6. Do live and paper share the same scheduler semantics?

**Largely yes — one shared policy module, with four documented divergences.**

Shared: `executionSchedulingPolicy.ts` defines `BOX_ORDER_PRIORITY`, `compareScheduling`, the cap
and `minBrokerIntervalMs`. Live's `sortQueue` and paper's `planPaperSchedule` both consume it. Both
hold a concurrency slot for the **whole order lifecycle**.

Divergences:

1. **Poll traffic is not modelled.** Live pays the shared throttle for every status poll of every
   working order; paper debits the wire once, for the POST. With a cap above 1, paper
   under-estimates POST delay. Dhan is worse: it polls the order *and* the trade book, so two paced
   calls per poll versus Kite's one.
2. **Paper plans per run, live queues globally.** All four legs share one purpose and one
   `readyAt`, so priority never actually reorders anything intra-run; real cross-pipeline
   pre-emption (an EXIT jumping a queued ENTRY from another candidate) is live-only.
3. **Live re-validates at dequeue** (`queuedActionBlockReason`) and can reject an already-queued
   order; paper has no such outcome.
4. **Different cap knobs** (`liveMaxConcurrentExecutions` vs `paperMaxConcurrentExecutions`); they
   match only if configured to, which is why the recommended configuration sets both.

## 7. Are broker ACK and exchange-working now distinct?

**Live: yes. Paper: only partially — and this is the largest remaining honest gap.**

- Kite distinguishes `ACKNOWLEDGED` from `OPEN` and applies **three** deadlines: `ackTimeoutMs`,
  `workingTimeoutMs`, `partialTimeoutMs`. Dhan does the same, plus a `maxPolls` budget.
- Paper records `ack_at` as its own timestamp, and `BROKER_ACCEPTED` / `WORKING` exist in the
  observable vocabulary — but the leg executor still treats ACK and working as **the same instant**
  and has **one** deadline (`legTimeoutMs`). `PaperLegStatus.ACKNOWLEDGED` is declared and never
  assigned by the executor.

Paper therefore cannot express "acknowledged but never reached the exchange", and gives a partial
fill no separate, shorter clock. The ACK≠fill *rule* is fully enforced (no stage proves execution;
quantity is the only evidence); the ACK-vs-working *two-state model* is not.

## 8. Is persistence latency represented?

**Now yes, on both sides — where before it was neither measured nor modelled.** Measured as
`persistence_wait_ms` (`intent_persisted` mark), removed from `transport_wait_ms` so pacing means
pacing, and modelled by paper via `persistenceMs` — the measured p50 when available, else 0.

## 9. Are ZERODHA live order updates consumed?

**No.** Kite's WebSocket text frames — which carry order postbacks — are explicitly discarded in
`src/ticker.ts` ("Text frames are postbacks (order updates / error messages) — ignore"), and
`ConnectOptions` has no order callback. There is no Kite HTTP postback route. Fills are discovered
**exclusively by REST polling** (`waitForResolution` → `refresh`, paced at
`BOX_LIVE_BROKER_MIN_INTERVAL_MS`, default 250 ms) with the 60-second reconciler as the safety net.

## 10. Are DHAN live order updates consumed?

**No.** `POST /api/dhan/postback` exists but is **deliberately inert**: it validates shape, logs,
returns 200, and mutates nothing — trusting an unauthenticated webhook to move a live order's state
would be a second state machine and a security hole. Dhan's order-update socket is not implemented;
`feed.ts` drops non-binary frames. Fills come from REST polling plus trade-book reads.

**Consequence, stated plainly:** the idempotent ingestion primitive (`CumulativeFillLedger`, with
`order_update` and `postback` as declared sources) is built, wired and tested, but **only
`rest_poll` is ever emitted**. The fast path is prepared, not connected. Worst-case fill-discovery
latency remains ~one poll interval.

## 11. Do recovery charges include residual flattening?

**Now yes — before, no.** Paper computed `flatten_charges` and every caller discarded it; live
returned a hard `0`, so fees on real `EMERGENCY_RESIDUAL` orders were never even estimated; no Mongo
field existed and nothing reached P&L.

Now: live bills the flatten from orders that actually filled at the price the broker reported;
charges accumulate onto a new `flatten_charges` attempt field with `$inc`, applied in the *same*
update as the residual projection (atomic, retry-safe); and they count against the live daily risk
limit. The attempt's historical `net_abort_pnl` is **not** retroactively rewritten — already-recorded
execution economics are not mutated after the fact.

## 12. Remaining differences: paper `live_parity` vs live

### vs live ZERODHA

1. No durable-intent layer in paper: no `CREATED`/`SUBMITTING`, no audit journal, no restart
   adoption, no "existing intent" branch.
2. Submission cannot fail: no 4xx/5xx/429, no timeout, no ambiguity, no `RECONCILIATION_REQUIRED`,
   no `UNKNOWN`, no kill-switch refusal.
3. One deadline vs three (§7).
4. No poll model, so no poll pacing and no poll-driven state discovery.
5. No `modifyOrder` / price chase; `liveMaxModifications` has no paper counterpart. (Note: no
   production code calls `modifyOrder` on either adapter, so this is an unexercised live capability,
   not an active divergence.)
6. No broker reject families; paper's `reject` is snapshot tradability, not a broker verdict.
7. Paper's cancel always confirms; Kite's can fail, time out, and end in a thrown ambiguous error.
8. No overfill possibility in paper — its `fill_qty` is its own construction and nothing can
   contradict it. Live has a ledger that trips the breaker on overfill.
9. Paper has no reconciliation, orphan detection, or foreign-order concept.
10. Paper-only, with no live counterpart: depth walking with per-level slice provenance, the shared
    liquidity ledger, quote-staleness gating, sequential leg mode, mid-flight abort predicates, and
    `raced_fill_qty` quantification.

### vs live DHAN

All of the above, plus Dhan-specific behaviour paper's single code path cannot represent:

11. **Static-IP gate** — a per-mutation, fail-closed refusal with no Kite equivalent.
12. Instrument identity resolution (`token → {segment, securityId}`) that can fail pre-transport.
13. Correlation-id reconciliation via a **direct lookup**, versus Kite's order-book walk with a
    uniqueness-and-attributes check.
14. **Trade-book fills** with real per-trade exchange ids, versus Kite's single synthetic aggregate
    whose `fill_id` mutates — which changes ledger dedupe granularity per broker.
15. Two paced calls per poll (order + trades) versus Kite's one.
16. `maxPolls` / `maxConfirmPolls` iteration budgets as a second, non-wall-clock exit.
17. An unconfirmed cancel **returns** a quarantined order (no `unknownOrders++`) where Kite
    **throws** — the same physical situation, different live accounting.
18. Read-failure conservatism: keep the last known projection versus Kite's `UNKNOWN`.
19. Reject classification from a stable `omsErrorCode` versus Kite's free-text matching.
20. `Date.now()` + module `sleep` (not clock-injectable) and IST-naive timestamp parsing.
21. `MARGIN` product versus Kite's `NRML`.

## 13. Test results

- **839 tests, 836 passing, 3 failing.** The 3 failures are **environment-only**: they import
  `src/db.js`, which requires the real `mongoose`, unavailable in this offline sandbox. CI, with real
  dependencies, passes all of them. Baseline before this work: 652 passing.
- All 20 required cases are individually labelled and greppable (`grep -rn "REQUIRED " tests/`).
- Golden fixtures: **71 cases across 14 files**, all generated from the implementation.
- No test was deleted, skipped or weakened. A guard test asserts the twenty most-exposed
  pre-existing suites still exist and still assert.

## 14. TypeScript build

`npm run typecheck`, `npm run build` and the build step inside `npm test` all pass with **zero
errors**. CI (`Typecheck + Box tests`) is green with the real dependency tree, which also confirms
no error was masked by the offline type stubs used locally.

## 15. Migration impact

- **Mongo:** one new collection `box_calibration_samples` (TTL-bounded, 14 days) and one new
  optional field `flatten_charges` on execution attempts (defaults to 0). **No migration required**
  — both are additive, and no existing field's meaning or type changed.
- **Durable state machine:** `BoxOrderIntentState` and `INTENT_STATE_PREDECESSORS` are
  **unchanged**. The richer 15-stage vocabulary is a separate observational layer mapped onto them,
  chosen specifically to avoid a migration.
- **Config:** 11 new variables, all defaulting to current behaviour. No existing default changed.
- **Public API / frontend:** unchanged, plus one additive read-only endpoint
  (`GET /api/box/execution-diagnostics`).
- **Go/Rust port:** 8 new fixture files pin the new semantics; `ScheduledOperation` gains
  `persisted_at` and `persistence_wait_ms`.

## 16. Latency / performance regressions discovered

None. Measured on the hot path:

| Operation | Cost |
| --- | --- |
| `calibration.record()` | 0.56 µs/op |
| `timing.mark()` enabled | 0.18 µs/op |
| `timing.mark()` disabled | 0.017 µs/op |

No new module performs I/O, awaits, or touches Mongo/Redis/the network on the order path
(`calibrationPersistence` is the sole `await`, by design, off the hot path). Every structure is
bounded: ring buffers, TTL caches, fixed-key maps. Persistence is batched and `unref()`ed; a full
buffer drops oldest and counts the loss rather than growing.

One **pre-existing** risk was found and is documented rather than silently absorbed: the two
pre-submit Mongo writes sit inside the held concurrency slot, so with `maxConcurrentExecutions = 1`
database latency directly delays the next leg. It is now measured, so it can be seen.

## 17. Honest summary

The core goal was the closest defensible deterministic digital twin buildable from observable
retail-API data. Against that:

- **Achieved:** ACK is never mistaken for a fill; the cancel/fill race is modelled with measured
  windows and pinned by the brief's own 52/23 arithmetic; latency is measured per broker and fed
  back so the twin improves by itself; the scheduler is one shared policy; residual flattening is
  finally billed; every figure carries its evidence and refuses to overstate it.
- **Partial:** ACK-vs-exchange-working is two states live but one instant in paper; poll traffic is
  unmodelled; paper's scheduler plans per run rather than globally.
- **Not done, and prepared rather than pretended:** broker order-update ingestion for either broker.
  The idempotent primitive exists and is tested; nothing emits into it. Fills are still discovered
  by REST polling.

Nothing in this work enables live trading, changes the default execution mode, or weakens the
double gate.


---
---

# PART 3 — Wired-vs-inert follow-up

Part 2 answered the required questions but did not ask a question it should have: *which of these
modules is actually called in production?* Auditing that found **ten** modules built, unit-tested and
never invoked. A module that is never called reports empty forever while looking finished — and two
documentation statements had already been written as though they were live. Both are now fixed.

## What was inert, and what changed

| Module | Before | Now |
| --- | --- | --- |
| `classifyOrderProfile` | 0 call sites; the calibration profile was the hardcoded literal `"MARKETABLE_LIMIT"` | **Called in the fill path** against the observed book; result stored on the order, with the signed tick offset |
| `ExecutionOutcomeStore.recordOutcome` | 0 call sites → every outcome rate permanently zero | **Called on both the success and the abort path** |
| `QueueCalibrationEstimator.record` | 0 call sites → estimator had no data source and could only report "insufficient evidence" | **Fed per leg** from finished attempts |
| `computeExecutionShortfall` | 0 call sites | **Computed at attempt completion**, surfaced in diagnostics |
| `buildParityReports` | 0 call sites — the paper half was never produced | **Produced**: a paper-side `BrokerTimingStore` is fed from finished paper legs |
| `buildPairedComparison` | 0 call sites | still a primitive — needs a live micro-size run to pair against |
| `computeAdverseSelection` | 0 call sites | still a primitive — needs book-at-submit/ACK/post-fill snapshots |
| `RecordedRejectReplayer` | 0 call sites | still a primitive — no replay harness |
| `shadowGuardedAdapter` | 0 call sites | **unreachable by construction**, deliberately: layers 1–2 mean no live adapter exists in shadow mode. Documented, not forced |
| `createStressInjector` | self-referential only | isolation complete; **fault injection not plumbed** into the fill path |

## The overclaims that were corrected

1. `LIVE_EXECUTION.md` said marketable/passive was *"decided from an observed book rather than from
   an assumption"*. It was a hardcoded literal. Now genuinely decided — and the doc was corrected
   **before** the wiring, so it was never left false on `main`.
2. The stress profile was described by listing the fault classes it injects. It injects none yet; its
   *isolation* is what is complete. Now stated explicitly.
3. "Three layers" of shadow enforcement read as three active layers. Layer 3 has no call site by
   design; now labelled.
4. The queue estimator was described as measuring the realisation ratio while having no data source.

## Why some things are still primitives

Deliberate, not abandoned:

- **Paired comparison** needs the *same candidate id* captured on both sides. Paper predictions and
  live outcomes for one candidate only coexist during a live micro-size validation run, which has
  not happened. Fabricating a pairing would be worse than having none.
- **Adverse selection** needs book snapshots at submit, ACK and a post-fill horizon. Those are not
  captured, and inventing them would defeat the purpose.
- **Reject replay** needs recorded real rejects, which requires live rejections to have occurred.
- **Shadow layer 3** is insurance against a future refactor. Wiring it artificially — by
  constructing a live adapter in shadow mode purely so the guard has something to wrap — would
  *create* the risk it exists to prevent.
- **Stress injection** is a genuine feature, not a gap in this one: the containment guarantees are
  what mattered, and they hold.

A regression test (`tests/box/wiredNotInert.test.mjs`) now asserts that each wired module has a
production call site and produces non-empty output when fed, and that anything still inert remains
labelled as such in the documentation. The specific failure mode it guards against is a module
quietly reverting to scaffolding while the docs still claim it works.
