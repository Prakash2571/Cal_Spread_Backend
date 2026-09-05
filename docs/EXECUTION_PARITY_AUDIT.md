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
