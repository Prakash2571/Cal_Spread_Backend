# Two market-data lanes + Box execution coordination — pre-implementation audit

Phase 1 of the two-feed / same-leg-coordination work: the exact current architecture, the broker
limits that constrain the design, and the two conflicts between the intended design and what is
actually in this repository.

**Nothing in this document describes implemented behaviour.** It is the audit that must precede the
change, written down so the design decisions are reviewable before code exists. Where the intended
design assumed a mechanism that is not present, that is stated explicitly rather than worked around.

## 1. Architecture BEFORE — verified tick path

```
ZERODHA lane                              DHAN lane
src/ticker.ts — ONE WebSocket             src/brokers/dhan/feed.ts — ONE WebSocket
  connectTicker()            ticker.ts:69   ensureSocket()              feed.ts:180
        |                                         |
  TickerHub.ensureSocket()      hub.ts:206  decodeDhanFeed → merge → toTick
  (socket-identity guard        hub.ts:216  (identity guards      feed.ts:190,202,209,217)
        |                                         |
        |                                  onDhanTicks          index.ts:130
        |                                         |
        +--------> TickerHub.broadcast()    hub.ts:278 <---------+
                              |
        +---------------------+----------------------+
        |                     |                      |
  latest / latestLadder   tickListeners         HubClient SSE
  hub.ts:45-53                 |                → CalSpread board
  ONE shared cache:            |
  both brokers, all            v
  instrument classes    BoxEngine.onTicks()        engine.ts:1455
                               |
                    BoxQuoteStore + SpotStore     engine.ts:214-215
                               |
                    scanner.onTokensUpdated() / monitor.onTokensUpdated()
                               |
                    BoxScanner.attemptEntry()      scanner.ts:389
                               |
                    BoxExecutionGateway         executionGateway.ts:32   ← the paper/live seam
                       mode !== "live" ?
                       /                \
           BoxExecutionSimulator      BoxOrderManager.submit()
           (+ PaperLiquidityLedger)   → priority queue → pump() → durable intent → adapter
```

Subscription layer — single and flat:

```
Box engine ──setStrategyTokens("strategy")──┐
Browsers ────acquire("browser")─────────────┼──> SubscriptionCoordinator ──> ActiveBrokerManager
                                            │    ONE Map<token, TokenCounts>  .subscribeUpstream()
                                            │                                  → active socket only
```

### What the subscription layer does and does not do

- Refcounts per token with a coarse 4-value owner union (`subscriptions.ts:31`). Upstream sees only
  0→1 and 1→0 transitions, so there are no duplicate upstream subscriptions.
- `setOwnerTokens` is a single atomic diff (`subscriptions.ts:145`), deliberately not
  release-then-acquire, so a moving strike window does not flap tokens present in both sets.
- **There is no notion of a lane, domain or workload.** `SubscriptionOwner` is a *lifecycle* label
  used for refcount attribution and `stats()` only — it selects no socket and no budget. The
  `"scanner"` and `"analytics"` owners are never used by any caller; Box subscribes as
  `"strategy"`, browsers as `"browser"`.
- Resubscribe-on-reconnect is **not** done here. It is per-feed: Dhan replays `wanted` on
  `ws.onopen` (`feed.ts:190-199`) with capped-exponential backoff (`feed.ts:390-403`); Kite relies on
  `this.subscribed` surviving a close and being passed to the next `ensureSocket` (`hub.ts:211`).

### Assumptions that do not hold

| Assumed | Actual |
|---|---|
| `src/brokers/zerodha/*` contains feed code | It contains **only** `liveAdapter.ts` (order execution). Kite's feed is `src/ticker.ts` + `src/hub.ts` |
| A per-tick broker-generation guard exists | **It does not.** Ticks carry no generation. Cross-broker safety comes from teardown ordering, socket-identity guards, and `BoxEngine.tokenFeedGeneration` warmth (`engine.ts:532`) |
| Box and futures quote stores must be split | **Already separate objects**: `BoxQuoteStore`/`SpotStore` vs `hub.latest`/`latestLadder`. What is shared is the subscription layer, the socket, and hub liveness |
| Both feeds reconnect and resubscribe | Dhan reconnects; **Kite has no automatic reconnect at all** — `onClose` only nulls the handle (`hub.ts:236-241`) |
| `executionId` / `legId` exist | They do not. The identity vocabulary is `trade_id`, `attempt_id`, `client_order_id`, `broker_order_id`, `role` |

### Broker generation

Counter `private gen = 1` at `registry.ts:192`, incremented in exactly one place — `registry.ts:1374`,
inside `switchBroker`, immediately after `this.active = target`. Generation is enforced on **inbound
requests** (`assertActiveBrokerToken` `registry.ts:250`, SSE session `marketDataSession.ts:118`, the
REST quote cache key, the instrument cache) — never on a tick.

`switchBroker` (`registry.ts:1316-1410`) already performs an ordered teardown: stop scanner → stop
outgoing feed → `resetForBrokerSwitch()` → drop SSE sessions → clear instruments and
`invalidateBooks()` → **switch + `gen += 1`** → load new universe → `reloadUniverse()` →
`startActiveFeed()`. Note books and subscriptions are dropped *before* the generation moves, so
during teardown the old generation is still current.

## 2. The same-leg problem, as it exists today

Four layers of duplicate protection exist, and **all four are keyed on the candidate key**
`underlying|expiry|K1|K2|DIRECTION` (`math.ts:313`):

1. `BoxPositionBook.reserve(key)` — synchronous, atomic w.r.t. the event loop (`positions.ts:154`)
2. `BoxScanner.entryInFlight` (`scanner.ts:138`)
3. `BoxExecutionSimulator.inFlight` (`executionSimulator.ts:189`)
4. Mongo partial unique index `box_open_unique_pair_dir` (`model.ts:378`) — the atomic durable half

**None of them is keyed on an instrument token.** Two *different* candidate keys sharing a leg — for
example `…|1300|1320|LONG_BOX` and `…|1320|1340|SHORT_BOX`, which share the 1320 strike — are not
mutually excluded at any layer.

What accidentally limits this is the global pipeline cap:

- Paper standard: `cfg.maxConcurrentExecutions` = `num("BOX_MAX_CONCURRENT_EXECUTIONS", 8)`
  (`config.ts:737`). Note `num()`, **not** `clampInt()` — unbounded and unvalidated, unlike the live
  knob. Consumed only by `BoxExecutionSimulator.hasCapacity()` (`executionSimulator.ts:471`).
- Paper `live_parity`: `paperMaxConcurrentExecutions`, defaults to the live value.
- Live: the gateway degenerates to a global binary lock —
  `status.inFlight === 0 && status.queued === 0` (`executionGateway.ts:80`), deliberately, to close
  the micro-window between roles of one pipeline.

**Consequence:** in standard paper mode up to 8 overlapping Boxes can execute simultaneously and each
assumes the full displayed size at a shared strike. Live is accidentally serialised. There is no
queue of waiting Boxes, no fairness, no aging, and no per-underlying limit anywhere — a rejected
candidate is simply dropped and re-evaluated on the next tick.

### The correct interception seam

`BoxExecutionGateway` (`executionGateway.ts:32`) is the interface where the paper/live branch happens
(`mode !== "live"` at `:84`, `:171`, `:175`, `:223`). A coordinator implemented as a **decorator of
that interface**, injected at the single construction site `engine.ts:527`, sits above the paper/live
split, covers entries *and* exits, intercepts `hasCapacity()` as well, and requires **no** changes to
`BoxScanner` or `BoxPositionMonitor`. It also keeps the new subsystem out of `engine.ts`.

Constraint discovered: the scanner checks `hasCapacity()` (`scanner.ts:315`) and then `void`-calls
`attemptEntry` without awaiting. `positions.reserve()` is the only synchronous claim. **A coordinator's
reservation must therefore be synchronous, or complete before the first await**, or two candidates in
the same event-loop turn will both pass.

Also: `orderManager.canEnter()` deliberately does *not* reject sibling role-orders of the same Box on
concurrency grounds (`orderManager.ts:410-414`). Any coordinator must preserve that, or a
`maxConcurrentExecutions = 1` deployment will deadlock against its own second leg.

### What to reuse rather than rebuild

`executionSchedulingPolicy.ts` is already the shared source of truth for ordering:
`BOX_ORDER_PRIORITY` (`EMERGENCY_RESIDUAL:0, PROTECTIVE_CANCEL:1, EXIT:2, ENTRY:3`) and
`compareScheduling` = priority then FIFO by enqueue sequence. It is consumed by both the live manager
(`orderManager.ts:645`) and the paper scheduler (`paperScheduler.ts:239`). A waiting queue should sort
with it. Caveat: all entries share priority 3, so between two waiting Boxes it degenerates to FIFO —
which is defensible and is what live already does.

`executionPolicy.ts` is **not** a scheduler (it is per-order pricing/timeout policy). Nothing to reuse
there.

New states belong on `BoxOrderStage` (`orderLifecycle.ts:70`, 15 observational values), **not** on
`BoxOrderIntentState` (11 durable values) — the latter is enforced as a Mongo predecessor guard
(`repository.ts:637`), so widening it requires a migration. That split is the documented extension
point.

## 3. Broker WebSocket limits

**Dhan — verified.** Up to 5000 instruments on a single Live Market Feed connection, and up to 5
sockets per user. For 20-level market depth the cap is far tighter: 50 instruments per connection.
Two lanes therefore fit comfortably within Dhan's allowance.
Sources: [Dhan support — instruments per socket](https://dhan.freshdesk.com/support/solutions/articles/82000909107-how-many-instruments-can-i-subscribe-on-websockets-),
[DhanHQ-py README](https://github.com/Ayushhhhh30/DhanHQ-py-1),
[DhanHQ v2 — full market depth](https://dhanhq.co/docs/v2/full-market-depth/).
*Content was rephrased for compliance with licensing restrictions.*

This corroborates the existing code comment at `feed.ts:62-69` that 20/200-level depth "is a separate
Dhan architecture with far tighter instrument limits and is not suitable for thousands of strikes".
The registry always requests `depthLevel: 5` (`registry.ts:1094`). The only Dhan limit enforced in
code today is `SUBSCRIBE_BATCH = 100` — the per-message instrument cap (`feed.ts:46`).

**Zerodha — NOT verified, and must be before implementation.** `kite.trade/docs` returns HTTP 403 and
no authoritative source was reachable. The repository asserts "~3 connections per API key" as a
**comment only** (`hub.ts:9-14`, echoed `index.ts:91`), and the commonly cited 3000-instruments-per-
connection figure appears **nowhere in this codebase** — grepping `3000` matches only an unrelated
`MAX_BUFFERED_FRAME_FIELDS`. This must be confirmed against the actual Kite developer console for the
API key and plan in use. Two lanes would consume 2 of 3 connections, leaving one spare — and an
overlapping deploy briefly needs double, so the margin matters.

Application-level caps that actually bind today: `BOX_MAX_SUBSCRIBED_TOKENS` default **2200**
(`config.ts:881`), `MAX_SESSION_TOKENS` 4000, `MAX_QUOTE_TOKENS` 4000, `MAX_SESSIONS` 500,
`indicativeMaxUnderlyings` 150. The CalSpread/browser side has **no** feed-token budget at all — the
real upstream count is `browser ∪ strategy`, and nothing in the codebase bounds that union.

## 4. Conflict 1 — Redis cannot be the hot-path reservation as intended

`src/redis.ts` is **Upstash REST over HTTP**, not a Redis TCP client:

- One `fetch` POST per call, `TIMEOUT_MS = 8000`
- **Never throws, by explicit documented design** — returns `null` when unreachable, and self-mutes
  for 60 s after 3 consecutive failures
- Optional, and blank by default in `.env.example`
- No `EVAL` helper, no `SET NX` helper, no `MULTI`/`EXEC`. `pipeline()` is explicitly *not* a
  transaction — per-command errors surface as `null` without failing the request
- Nothing on the box execution path uses Redis today (only `closedCache.ts`, `pnlCache.ts`, `index.ts`)

The intended wake-and-execute timeline is ~46 ms. A single Upstash round trip from an Indian VPS is
typically 30–150 ms and worst-case 8 s, so the reservation would cost more than the arbitrage's entire
useful lifetime. Separately, `null` meaning "carry on" is the exact inversion of what a safety
primitive requires, so it would have to be wrapped in a strict mode that contradicts the module's
documented contract.

Meanwhile `deploy.sh:157` runs `pm2 start npm --name … -- start` — **fork mode, single instance**.
There is no second worker today, and `BoxPositionBook`, `entryInFlight` and `BoxOrderManager` are all
already in-process authorities.

**Recommended design — one `InstrumentReservationStore` interface, three tiers:**

1. **In-process, synchronous** — the authoritative fast path. Zero latency, and atomic with respect to
   the event loop: the same property `BoxPositionBook.reserve` already documents and depends on.
2. **MongoDB unique index** on the canonical instrument key — the true cross-process atomic guard.
   Mongo is **mandatory** for the box scanner (it refuses to start without it), uses a real TCP
   driver, and this repo already treats a unique index as *"the atomic half of duplicate protection"*.
3. **Redis** — optional advisory mirror and cross-service visibility, with an explicit
   `BOX_RESERVATION_REQUIRE_REDIS` flag for a future multi-worker deployment.

This is both faster and stronger than Upstash-REST-primary. It does move the fail-closed condition
from "Redis unavailable" to "Mongo unavailable" — which is already a hard requirement for the box
scanner, so it strictly tightens rather than loosens the safety model.

**This decision is outstanding and blocks implementation of the reservation layer.**

## 5. Conflict 2 — a second Zerodha socket requires extracting a feed module first

There is no Zerodha feed module to add a lane to. `TickerHub` currently conflates three
responsibilities: the Kite socket lifecycle, the shared `latest`/`latestLadder` caches, and SSE
fan-out to the board. A second Zerodha lane therefore requires:

- extracting a `ZerodhaFeed` class from `ticker.ts` + `hub.ts`
- deciding whether the CalSpread board keeps reading the hub caches or moves to a futures-lane store
- **adding Kite reconnect**, which does not exist today — otherwise "reconnect resubscribes each
  lane's own tokens" cannot hold for Zerodha

Blast radius is `hub.ts`, `registry.ts`, `index.ts` (5562 lines), SSE, and the CalSpread board.

## 6. Proposed sequencing

Two feed lanes, a coordinator, 27 tests and a load benchmark is not one reviewable change. Proposed as
three independently-green PRs:

- **PR 1 — `BoxExecutionCoordinator`.** Canonical broker-namespaced instrument key, reservation store
  behind the interface above, all-or-none acquire, revalidation-before-execute, opportunity duplicate
  guard, states on `BoxOrderStage`, fairness via existing `compareScheduling`, metrics. Implemented as
  a `BoxExecutionGateway` decorator at `engine.ts:527` — above the paper/live split, no scanner or
  monitor changes, nothing added to `engine.ts`. This is the PR that fixes the observed same-second
  overlapping-strike entries.
- **PR 2 — `MarketDataLane`**, split coordinators, `ZerodhaFeed` extraction, per-tick generation
  stamping, Kite reconnect.
- **PR 3 —** lane diagnostics, coordinator metrics, backpressure/tick coalescing, load benchmark.

## 7. Known limitation being documented, not yet fixed

Until PR 1 lands, the behaviour visible in production stands: overlapping Box opportunities sharing an
option strike can be entered in the same second, each assuming the full displayed size at that strike.
In paper this can overstate achievable fills. The user-facing `?` panel on the Box page has been
updated to disclose this rather than leave it implied.
