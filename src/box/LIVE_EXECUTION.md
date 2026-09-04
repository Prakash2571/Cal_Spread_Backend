# Live Box execution operations

This document describes the safety contract and operator workflow for live Box execution. Paper modes remain the default and continue through the paper simulator.

## Safety model

Live broker access is disabled unless both deployment gates are explicitly set:

```dotenv
BOX_EXECUTION_MODE=live
BOX_LIVE_TRADING_ENABLED=true
```

`BOX_EXECUTION_MODE` defaults to `paper_latency`; `BOX_LIVE_TRADING_ENABLED` defaults to `false`. Unknown execution modes fail during configuration instead of falling back to paper. Live startup also requires a ready Box Mongo connection, `KITE_API_KEY`, and a current restored Kite access-token session.

Every process start resets these in-memory runtime controls to `false`:

- `box_entry_enabled`: permits new Box entries.
- `box_live_order_enabled`: permits live exposure-management submissions. Leave this enabled when stopping entries if exits and recovery must continue.
- `box_emergency_flatten`: additionally arms the explicit flatten operation.

Scanner RUN/STOP is separate from these controls. STOP prevents discovery of new opportunities but does not stop monitoring or risk-reducing exits. A circuit-breaker trip disables entry but deliberately preserves the ability to cancel or reduce owned exposure.

## Source of truth and persistence

Broker orders and broker positions are authoritative for live fills and exposure. Mongo stores the durable strategy/accounting projection and the append-only order-intent journal. A stable identity such as `BOX:<trade-id>:ENTRY:k1_ce:attempt-1` is persisted before submission. Ambiguous transport outcomes are reconciled by identity; they are never blindly resubmitted.

Redis is a cache, **not** a write-ahead log. There is no filesystem WAL or broker-only recovery mode. During a total Mongo outage the service fails closed and cannot create a new durable exit or residual intent. If live boot fails because Mongo is unavailable, restore Mongo and restart the process before operating live Box execution. A mid-session persistence failure blocks new risk, trips the circuit breaker, and moves affected projections to recovery where applicable.

## Startup and reconciliation

Live boot performs these steps before discovery can be enabled:

1. Require Mongo and a current Kite session.
2. Restore open Box projections and unresolved residual attempts.
3. Seed daily P&L, rejection, and failure counters from durable state.
4. Reconcile the complete nonterminal intent/ownership journal with broker orders and positions.
5. Start the position monitor and low-frequency reconciliation loop.

Reconciliation runs immediately and then every `BOX_LIVE_RECONCILE_INTERVAL_MS` (default 60 seconds). It adopts orders only through durable client/broker identity or a unique validated Box tag. Missing, duplicate, ambiguous, orphaned-looking, or position-mismatched ownership enters reconciliation/recovery handling and blocks entry.

The system never treats arbitrary account positions as Box exposure. Cancel and flatten operations are limited to safely attributed Box orders, trade projections, and crash-only exposure reconstructed from the durable Box intent journal.

## Order policy and deadlines

All live entry, exit, and emergency-reduction orders are regular NRML DAY **LIMIT** orders. Market orders are not supported. Limits are bounded marketable prices derived from current depth and configured chase ticks; depth is a pre-check and limit-construction input, not fill authority. The full requested quantity must be executable within the bounded limit after the configured queue haircut.

Broker operations are paced by `BOX_LIVE_BROKER_MIN_INTERVAL_MS` (default 250 ms). Distinct deadlines apply:

- HTTP request: `BOX_LIVE_HTTP_TIMEOUT_MS=5000`
- broker acknowledgement: `BOX_LIVE_ACK_TIMEOUT_MS=3000`
- working order: `BOX_LIVE_WORKING_TIMEOUT_MS=30000`
- partial-fill continuation: `BOX_LIVE_PARTIAL_TIMEOUT_MS=10000`
- cancellation/terminal confirmation: `BOX_LIVE_CANCEL_TIMEOUT_MS=5000`

A working or partial timeout triggers protective cancellation followed by terminal cumulative-quantity confirmation. If terminal quantity cannot be established, the order becomes `RECONCILIATION_REQUIRED`; no blind retry is allowed. The configured modification/chase bounds are safety ceilings; the current manager does not actively modify working orders.

The central priority is emergency residual reduction, protective cancellation, exit, then entry. `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS` defaults to 1, so multi-role work is queued and serialized rather than rejected.

## Exact quantity and position state

The irreversible invariant is:

> Once the broker/execution engine owns a fill, that filled quantity is irreversible state.

Every trade persists exact outstanding quantity as `remaining_qty_by_role` for `k1_ce`, `k2_ce`, `k2_pe`, and `k1_pe`. An exit submits only the one to four roles whose remaining quantity is nonzero, and each submitted quantity equals that role's exact remainder. Broker-confirmed cumulative fill quantity is applied only to its role.

Position states are:

- `BOX`: all four roles have the same positive remaining quantity.
- `PARTIALLY_EXITED`: known terminal fills leave unequal or zero per-role remainders.
- `RECOVERY`: quantity is uncertain, an invariant was violated, persistence of a confirmed result failed, or reconciliation found an ownership mismatch.
- `FLAT`: all four role quantities are zero.

Over-close is never clamped to zero. A fill greater than the persisted role remainder preserves the prior quantity projection, records the invariant violation, enters `RECOVERY`, and blocks new entry. For a known partial close, retry uses only the exact remainder—for example, a 75-unit role with 40 confirmed closed retries 35, never 75. Manual and automatic close share the same execution engine and cumulative accounting path. `exit_attempts[]` is append-only; heavy audit data is omitted from bulk list/history responses.

Normal automatic flattening is intentionally paused for an uncertain `RECOVERY` projection until reconciliation establishes broker truth. The explicit attributed flatten workflow may then resume exact reduction.

## Feed health and reconnect warm-up

Live entry requires a healthy current feed. On feed loss the manager blocks entries and automatic exits. After reconnect it waits `BOX_LIVE_FEED_RECONNECT_WARMUP_MS` (default 5 seconds), and each requested candidate leg must receive at least one tick in the new feed generation. This prevents decisions from stale pre-reconnect books.

## Runtime limits and circuit breaker

Conservative defaults are:

- `BOX_LIVE_MAX_OPEN_BOXES=1`
- `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS=1`
- `BOX_LIVE_MAX_RESIDUAL_LEGS=1`
- `BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100`
- `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400`
- `BOX_LIVE_DAILY_LOSS_LIMIT=5000` (`0` disables)
- `BOX_LIVE_REJECT_LIMIT=3`
- `BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT=3`

The circuit breaker trips on invariant/quantity ambiguity, reconciliation failure, persistence loss after confirmed fills, attribution mismatch, or a configured risk limit. It is sticky: fixing the cause or toggling entry does not clear it, and day rollover does not re-arm it. Reconcile and inspect the incident, cancel/flatten only safely attributed exposure as needed, then restart the process to re-arm entry.

## Health and blockers

`GET /api/box/status` includes separate health for persistence/database, daily-risk seeding, broker authentication, broker orders API, broker positions API, reconciliation, market data/feed, and circuit state. It also reports unknown orders, recovery activity, orphan orders, open boxes, residual legs, queued/in-flight work, risk counters, and the live manager controls.

New entry requires all of the following: closed circuit, both entry and live-order controls enabled, healthy persistence and daily-risk seed, completed reconciliation, healthy broker auth/orders/positions APIs, no unknown orders, no active recovery, healthy warmed feed, and all exposure/concurrency/risk limits passing.

Treat `RECOVERY`, unknown orders, unhealthy persistence, failed/incomplete reconciliation, or an open circuit as an incident. Do not attempt to bypass a blocker by switching execution modes or resubmitting an ambiguous order.

## Full-admin operations

These POST routes require a full-admin token (`x-admin-token`):

- `/api/box/controls/box_entry_enabled`
- `/api/box/controls/box_live_order_enabled`
- `/api/box/controls/box_emergency_flatten`
- `/api/box/live/reconcile`
- `/api/box/live/cancel-working`
- `/api/box/live/flatten`

Recommended incident sequence:

1. Set `box_entry_enabled=false` while leaving `box_live_order_enabled=true` if risk reduction must continue.
2. Run `/api/box/live/reconcile` and inspect status/ownership blockers.
3. Use `/api/box/live/cancel-working` for durable nonterminal Box orders if required.
4. Set `box_emergency_flatten=true`, then call `/api/box/live/flatten` only after attribution is safe.
5. Confirm broker positions and Box status are flat, remediate the root cause, and restart if the sticky circuit breaker must be cleared.

Emergency flatten requires the explicit runtime arm plus completed reconciliation or the narrower safe-attributed-reduction proof. It does not flatten unrelated account positions.


---

## Paper live-parity profile (`BOX_PAPER_EXECUTION_PROFILE=live_parity`)

Default is `standard` — today's paper behaviour, byte-for-byte. `live_parity` is an
opt-in layer **on top of `paper_legging`** that makes paper a closer shadow of the live
path. It changes nothing about the box maths, thresholds, fees, direction logic, exit
logic, live behaviour, API shapes or schemas.

### What each paper mode is

- **PAPER_LATENCY** — simplified: one simulated decision + send delay, then fill the four
  legs from the first book at/after arrival. Atomic-ish.
- **PAPER_LEGGING** — four genuinely independent bounded-LIMIT orders, each with its own
  arrival, resting, partial fills and timeout; emergency unwind on a partial; abort after
  a 4/4 fill whose executed economics no longer qualify.
- **PAPER LIVE PARITY** — `paper_legging` plus:
  - **shared-liquidity reservation** (`liquidityLedger.ts`) — concurrent attempts cannot
    double-consume one observed level; a new quote version is fresh liquidity;
  - **deterministic latency source** (`latencySource.ts`) — `constant | recorded_samples`,
    consumed in a fixed seeded order, ready for real measured samples;
  - **live-equivalent concurrency cap** — `BOX_PAPER_MAX_CONCURRENT_EXECUTIONS`, defaulting
    to the live cap (`BOX_LIVE_MAX_CONCURRENT_EXECUTIONS`).

### How it stays safe

- **Default off.** The profile is `standard` unless explicitly set. Every live-parity
  behaviour is gated on `paperExecutionProfile === "live_parity"`; the leg executor gets
  the ledger/latency deps only then, so the `standard` fill and submit paths are
  unchanged (proven by the existing execution suites passing untouched).
- **No new broker contact.** Paper still routes entirely through the simulator; the order
  manager and broker adapter are only constructed in `live` mode (`tests/box/
  paperNeverReachesBroker.test.mjs` pins this with a poison manager).
- **Same LIMIT pricing.** Reuses `orderPricing.buildOrderPricing` / `walkDepth`; the
  reservation only *subtracts already-reserved quantity* from a level's effective depth —
  it never widens a limit or turns a LIMIT into a market order.

### Config

| Variable | Default | Meaning |
|---|---|---|
| `BOX_PAPER_EXECUTION_PROFILE` | `standard` | `standard` or `live_parity` |
| `BOX_PAPER_MAX_CONCURRENT_EXECUTIONS` | live cap (`1`) | concurrent paper pipelines under `live_parity` |
| `BOX_PAPER_LATENCY_MODE` | `constant` | `constant` or `recorded_samples` |
| `BOX_PAPER_LATENCY_SAMPLES` | (empty) | comma-separated observed latencies (ms) |
| `BOX_PAPER_LATENCY_SEED` | `0` | deterministic start offset into the samples |

Timeouts are inherited from the existing live/`paper_legging` config
(`BOX_LEG_TIMEOUT_MS`, and the `BOX_LIVE_*_TIMEOUT_MS` family for the live path); the
profile does not invent separate paper timeout numbers.

### What it still CANNOT simulate (honest gaps)

It only uses what actually arrived: real WebSocket books, the configured conservative
queue haircut, and measured/supplied latency. It does **not** and will not fabricate:

- true NSE order-level queue position (level-2 depth cannot reveal it — the haircut is a
  deliberate approximation, not a reconstruction);
- hidden/iceberg liquidity, or other participants consuming a level;
- broker OMS/RMS acceptance quirks, or random rejects;
- microsecond exchange matching order or market impact;
- price movement that was never observed on the feed.

### Deferred (not in this change), with rationale

- **Mirroring the live `OrderManager` scheduler exactly** (serialising the four legs
  through the same priority queue + `BOX_LIVE_BROKER_MIN_INTERVAL_MS` pacing). The
  concurrency cap is mirrored; full scheduler mirroring would mean threading live-adjacent
  scheduling into the paper leg loop, which risks drifting existing `paper_legging` results
  and cannot be responsibly validated without a real run. Tracked as follow-up.
- **A dedicated parity-report HTTP endpoint** and additional metrics percentile fields
  beyond those already exposed in `/api/box/status`. The existing metrics infra already
  records execution/legging latency percentiles; a separate report is additive and can be
  layered without touching execution code.
