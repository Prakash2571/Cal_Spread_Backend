# Cal_Spread backend

Express + TypeScript service behind [calspread.online](https://calspread.online). It sits on
a single Zerodha Kite Connect session and turns it into three things the frontend can't get
on its own: a live market-data fan-out, a NIFTY options analytics engine with multi-day
history, and a persisted calendar-spread trade book.

Setup and credentials live in [`.env.example`](.env.example); admin auth lives in
[`../Cal_Spread/ADMIN_SETUP.md`](../Cal_Spread/ADMIN_SETUP.md). This file is about what the
service can actually do.

---

## 1. Live market data from one Kite session

- **Instrument dump cached** for an hour, so the F&O board and every strike lookup is served
  without re-downloading the CSV.
- **Ticker fan-out**: one Kite WebSocket, many browser clients. `GET /api/stream?tokens=…`
  is a Server-Sent Events feed; `GET /api/quotes` seeds a client before the first tick.
- **Session survives restarts.** The access token is persisted and restored on boot when it
  is from the same IST day (Kite tokens expire daily), so the capture schedulers and the
  recorder keep working through a redeploy without a re-login.
- **Token sharing** for out-of-process consumers: `GET /api/internal/kite-token` (shared
  secret) and a curl-friendly `GET /api/kite/token?passcode=…`. Both are disabled unless
  their secret is set.

## 2. NIFTY options analytics

The core of the service. Once a minute during market hours it snapshots the nearest NIFTY
expiry's whole chain — OI and LTP per strike, plus the index spot — and derives everything
below from it.

**Chart frames.** Total Call and Put OI over a moving 26-below / ATM / 24-above strike
window, the auto-ATM straddle premium, and the spot, in four timeframes:

| Frame | Bucket | Retained |
| ----- | ------ | -------- |
| `1m`  | 1 minute | 1 day |
| `5m`  | 5 minutes | 3 days |
| `15m` | 15 minutes | 1 week |
| `1h`  | 1 hour | 4 days |

The same four frames exist for **NIFTY futures OI**, one leg per monthly contract
(current / next / far), and a series keeps its label across a rollover so an expiring month
stays readable until it ages out.

**Comparison windows.** The chain's OI Δ% and buildup (long buildup / short buildup / short
covering / long unwinding) columns can each be set independently to 1m, 5m, 15m, 1h or
**Day**. The minute windows are served from per-token snapshots; Day compares against the
previous session's close, which is snapshotted at the IST rollover and reconstructed from
Kite daily candles on a cold start.

**Bucket semantics that make the charts trustworthy:**

- Points are stamped with their bucket **END** and aligned to the **IST calendar**, not the
  epoch — otherwise every 1h boundary would land on the IST half-hour.
- The still-forming bucket is never published, so every point on every chart is a finished
  interval.
- The last bucket of a session is clamped to the 15:40 close, so the closing bar carries the
  real closing value instead of opening one that never traded.
- Purely pre-open buckets are dropped on both the live and backfill paths, so the day's first
  bar doesn't depend on whether the process happened to be up before the open.

## 3. Gap-aware Kite backfill

Downtime doesn't leave a hole. On boot, after a login, and every 30 minutes, the service
works out what it is actually missing and asks Kite only for that.

- **Both kinds of gap are detected**: the tail (everything after the newest point) *and* a
  missing session **head** — a process whose first capture was at 12:22 would otherwise
  report itself fully covered and never fetch 09:15–12:22.
- **Reconstruction** walks minute candles, carries forward last-known OI per strike, and
  recomputes the moving window per minute, so a backfilled bucket agrees with the same bucket
  captured live.
- **Buckets are idempotent.** Each is a hash field keyed by its boundary, so re-running a
  backfill corrects a bucket rather than appending a second copy of it.
- **Honest about incomplete readings.** If a strike's history can't be fetched (one retry,
  then it gives up on that strike) or a quote response didn't cover the window, the bucket is
  published but flagged `partial`. A flagged bucket is *correctable*: a later complete
  reconstruction replaces it, and the gap detector keeps asking for it — capped per frame per
  day, so a strike Kite genuinely cannot serve isn't chased until close. The frontend draws a
  gap rather than the understated value.
- **Rate-budget aware**: historical calls are paced, and the option, futures, hourly and EOD
  pipelines are sequenced rather than fired in parallel.

## 4. Durable analytics caches (Upstash Redis)

Optional but strongly recommended — set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` to switch it on.

Memory stays the read path; every mutation is mirrored to Redis, and boot warm-loads before
the capture scheduler arms so the gap detector only asks Kite for what is genuinely missing.
Without it, each deploy throws the session away and rebuilds it with hundreds of Kite calls,
and multi-day history never accumulates.

- Dependency-free client over Upstash's REST `/pipeline` endpoint — one pipelined request per
  minute (~90K commands/month, inside the free tier).
- **It can never take the app down**: unconfigured means disabled, three consecutive failures
  buy a 60s cooldown, corrupt values are dropped, oversized bodies are chunked, and a failed
  batch is re-queued rather than lost. A Redis outage degrades to the previous
  memory-only behaviour.
- Retention is enforced in Redis too — pruned buckets are deleted and every key carries a
  TTL, so nothing needs cleaning up by hand.
- Only **closed** buckets are written, so a restart can't resurrect a half-formed reading.

## 5. Historical price capture (MongoDB)

Independent of the analytics caches, and independent of Redis.

- **Hourly** F&O prices for the whole board, with a lookback backfill on boot and after a
  login (`HOURLY_BACKFILL_LOOKBACK_DAYS`, default 7).
- **End-of-day** stock futures, plus computed `spread_daily` and a recomputed
  `spread_summary`.
- **Day review** an hour after the close (`DAY_REVIEW_TIME`, default 16:30 IST) verifies the
  day is complete and backfills whatever is missing.
- Split across archive (read-only, pre-Sep 2025), current (2026 onward) and spread databases;
  each is optional, and leaving a URI blank disables just that feature.

## 6. Trades and admin

Calendar-spread trade book (`POST /api/trades`, close, list) persisted in MongoDB, an
admin-settable risk-free rate shared with the frontend, and two privilege levels — full admin
(`ADMIN_SECRET`, includes Zerodha login control) and trade access (`ACCESS_SECRET`, view and
take trades only). Admin sessions are persisted, so an admin stays logged in across a
backend restart.

Fills and costs are modelled end to end, so a trade's P&L is what an account would actually
keep:

- **Slippage** — fills are taken at the touch of the live book: the long leg pays the best ask and
  the short leg receives the best bid, mirrored on exit, so the round trip pays the spread exactly
  twice. Touch quotes are real, tick-valid prices — a volume-weighted average across several
  levels would produce a price that doesn't exist on the exchange and slippage that can't be
  reconciled against the quotes. If a leg has no bid/ask, taking a trade is refused rather than
  filled from a last traded price; on exit (which can't be refused) that fallback is logged.
- **Charges** — brokerage and every statutory head (STT, exchange transaction charge, SEBI
  turnover charge, GST, stamp duty) come from Zerodha's virtual contract note API
  (`POST /charges/orders`) priced at those exact fills. They are never computed from a local
  rate card, because the rates change and a stale formula would misstate every trade.
  `close_pnl` stays gross; `total_charges` and `net_pnl` carry the after-cost result. While a
  trade is open the exit charges are projected at the entry fills, so a live P&L reflects the
  whole round trip instead of only the half already paid.
- **Ledger** — each entry and exit appends an immutable document to `trade_log` (its own
  database via `TRADE_LOG_URI`) holding the contract value, per-leg fills, the full charge
  breakdown and Zerodha's raw payload.

Charges fail soft: if Zerodha can't price the orders the trade is still taken and recorded, with
the charge fields left null and the UI saying so rather than implying a free trade.

---

## 7. Box arbitrage (paper by default, live only when explicitly armed)

An **independent** module in `src/box/`. It shares this app's Kite session, WebSocket, instrument
cache and charge estimator, and shares nothing else: the calendar engine's calculations, captures,
analytics, schema and collections are untouched, and box positions live in their own collections
(`box_trades`, `box_trade_events`) — optionally in their own **database** via `BOX_MONGODB_URI`.

Paper execution remains the default. Live execution exists behind two independent deployment gates:
`BOX_EXECUTION_MODE=live` **and** `BOX_LIVE_TRADING_ENABLED=true`. It also starts with all in-memory
entry/order/flatten controls disarmed, requires a ready Mongo journal and current Kite session, and
uses bounded LIMIT orders only. Unknown execution modes fail closed. Operators must read
[`src/box/LIVE_EXECUTION.md`](src/box/LIVE_EXECUTION.md) before enabling either gate; it documents
reconciliation, exact partial-fill recovery, health blockers, full-admin controls, and incident
operations.

> ### Paper execution — read this before trusting a number
>
> In the three paper modes, every fill is simulated and stored with an `execution_mode` of
> `paper_latency` (default), `paper_touch`, or `paper_legging`; no paper-mode path places a broker
> order.
>
> - **`paper_touch`** assumes all four one-lot legs were simultaneously executable at the touch in
>   the detection snapshot. Optimistic, kept for comparison.
> - **`paper_latency`** (default) waits a simulated decision + order-send delay and then fills from
>   the **latest valid WebSocket book at the simulated arrival instant** — a resting book that did
>   not tick is still valid; an in-flight move during the latency is used automatically; a book that
>   has aged past the trust window, or is missing, is rejected. There is **no invented slippage
>   percentage** — slippage is measured against the detection touch.
> - **`paper_legging`** — the **recommended realism mode** — models **four genuinely independent
>   orders**, each with its own lifecycle
>   (`CREATED → SUBMITTED → IN_FLIGHT → PENDING → PARTIALLY_FILLED → FILLED /
>   TIMED_OUT / CANCELLED / FAILED / UNWOUND / UNWIND_FAILED`) and its own timestamps and order id.
>   There is **no common snapshot**: each order arrives, walks the latest valid resting book **within
>   its own limit price** (see *Executable order pricing* below), fills as much as it can, and rests
>   the remainder as `PENDING` / `PARTIALLY_FILLED` until a later depth update completes it — or until
>   `arrival_at + BOX_LEG_TIMEOUT_MS`, an **arrival-relative** deadline. Pending orders are woken by
>   the quote store's subscription, so a fill is stamped with the **tick's own timestamp**. Legs land
>   at different instants, which is what makes legging risk measurable: `first_to_last_fill_ms` is
>   literally `max(fill_at) − min(fill_at)` (0 when they fill together), reported alongside
>   `decision_to_first_fill_ms` / `decision_to_last_fill_ms`, and `exposure_duration_ms` measures how
>   long the position was one-sided. If all four fill a box is opened (qualified on the **actual
>   average fill prices**); if some fill and others do not, the filled legs are **emergency-unwound**
>   through the *same order lifecycle* and the **legging loss** (partial-entry charges + unwind
>   charges + adverse round-trip) is booked to a separate `box_execution_attempts` collection so
>   failed executions never vanish from the strategy P&L. **Exits** use the same independent-order
>   model (`simulateLeggingExit`): a partial exit leaves visible **residual exposure** rather than a
>   fabricated clean close.
>
> **Executable order pricing (marketable limit, not a market order).** In `paper_legging` an order
> does not consume whatever the book shows on arrival. It carries a LIMIT a bounded number of ticks
> past the reference touch — `BUY limit = ask + chase×tick`, `SELL limit = bid − chase×tick` — and
> the book is **walked only down to that limit**. A move within the band fills (possibly across
> several depth levels, at the quantity-weighted average); a runaway move past the limit is
> **refused**, so the order rests instead of chasing. Entries use `BOX_LEG_MAX_CHASE_TICKS`;
> emergency unwinds use the wider `BOX_UNWIND_MAX_CHASE_TICKS` because flattening matters more than
> price. The real instrument tick size is used where available.
>
> **Conservative queue approximation.** Being *at* the touch is not being *first* at the touch, and
> level-2 depth cannot reveal NSE order-level queue priority. So with `BOX_QUEUE_MODEL=haircut`
> (default) only `floor(displayed × (1 − BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT/100))` of each displayed
> level is treated as executable for us; `BOX_QUEUE_MODEL=none` uses the raw displayed quantity as an
> optimistic baseline. Displayed and effective quantities are both recorded on every fill slice. This
> is **deterministic and transparent — NOT a reconstruction of true queue position**, which cannot be
> derived from the data we have.
>
> **Four-leg temporal coherence.** Each candidate records receive-time and (where the feed supplies
> exchange timestamps) exchange-time dispersion across the four legs, per-leg feed latency, and how
> many books changed during the decision latency. When all four legs carry a valid exchange timestamp
> and their dispersion exceeds `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS`, the candidate is rejected
> as `cross_leg_time_skew` (they are not a coherent cross-section). A missing exchange timestamp is
> never itself grounds for rejection — the receive-time freshness gate stands.
>
> **Residual exposure & durability.** Exposure the engine cannot resolve to flat — a partial entry
> that could not be fully unwound, a failed unwind, a partial exit — is recorded as
> `ResidualLegExposure` and **never treated as flat**. Once a simulated fill is owned, a Mongo insert
> failure does not discard it: the fill is retained and re-persisted with bounded backoff, and the
> engine reports `degraded` in `/api/box/status` until it succeeds. On startup the engine re-adopts
> open positions **and** unresolved residual exposure, so an interrupted execution is resumed whether
> or not RUN is pressed.
>
> **Abort after a 4/4 fill.** A dislocation can decay *while the orders are in flight*. If all four
> legs fill but the economics recomputed on the **executed** prices no longer clear the gate (say
> ₹1,700 at detection became ₹800 against a ₹1,200 requirement), the entry is **not** quietly
> refused — the orders really filled, so a complete box briefly existed. All four legs are reversed
> immediately, the true round-trip cost (adverse spread + charges both ways) is booked as
> `abort_after_fill`, and **no box is opened**. Such an attempt is counted as an **abort**, never as
> a 4/4 fill, so `fill_rate_4_of_4` keeps meaning "a box was actually opened". A leg that cannot be
> reversed is marked `UNWIND_FAILED` and reported as `unwind_failed` rather than a clean abort.
>
> **Slippage accounting.** The measured entry slippage is an ANALYTICS figure, never a second
> deduction: the executed gross edge already contains any adverse entry move, so final
> qualification is `executedGross − entryCharges − projectedExitCharges − futureExitSlippage
> allowance − buffer`. Likewise, once an exit actually executes the expected exit-slippage allowance
> is dropped (realisable → realised).
>
> Either way these are **simulated fills at observed quotes**, not exchange fills, and do not
> guarantee the same result live, which can also experience:
>
> - inter-leg latency (four orders do not fill at the same instant)
> - queue position (being at the touch is not being first at the touch)
> - depth disappearing between the decision and the fill
> - partial fills
> - order rejection
> - legging risk (some legs filled, others not, leaving an unhedged position)
>
> These are **simulated fills at observed quotes**, not exchange fills, and are labelled as such
> in the API and the UI.

### The box — LONG and SHORT

For strikes `K1 < K2` on the same underlying and expiry, both directions are evaluated:

```
LONG_BOX    BUY  K1 CE   SELL K2 CE   BUY  K2 PE   SELL K1 PE
SHORT_BOX   SELL K1 CE   BUY  K2 CE   SELL K2 PE   BUY  K1 PE
```

Both settle at a fixed `K2 - K1` per unit wherever the underlying goes: the long box **receives**
that width at expiry, the short box **pays** it. So the mispricing is signed by direction. One
formula covers both (`sign = +1` long, `-1` short):

```
netDebitPerUnit  = Σ (+ask for each BUY leg, -bid for each SELL leg)   # executable touch only
grossEdgePerUnit = sign x (K2 - K1) - netDebitPerUnit
grossEdge        = grossEdgePerUnit x lotSize
```

A long box is the opportunity when the box trades **below** its width; a short box when it trades
**above** it. Direction is part of a box's identity — the candidate/position key is
`underlying|expiry|K1|K2|DIRECTION`, so a long and a short box on the same strikes are distinct
positions. Old documents with no direction load as `LONG_BOX`. Short boxes can be turned off with
`BOX_ENABLE_SHORT_BOX=false`.

All pricing is **executable only** — a BUY uses the best **ask**, a SELL uses the best **bid**.
LTP, mid-price and theoretical values are never used to size, qualify or close a position.

### Entry: ₹1,200 of EXPECTED NET PROFIT

The decisive gate is realistic **expected net profit**, evaluated on the **executed** snapshot
(after the simulated latency), with every term visible:

```
expectedNet = grossEdge
            - entryCharges              # local calculator, see below
            - estimatedExitCharges
            - executionCost             # MEASURED entry slippage + an exit allowance
            - safetyBuffer
enter if      expectedNet >= BOX_MIN_EXPECTED_NET_PROFIT      (default ₹1,200)
```

The gross spread is now only a **cheap prefilter** (`MIN_BOX_GROSS_EDGE`, default ₹1,200) that
decides whether a candidate is worth costing out — it can never on its own open a trade. Worked
examples:

- gross ₹1,900, fees ₹350, slippage ₹250, buffer ₹150 → expected net **₹1,150 → REJECT**
- gross ₹2,400, fees ₹350, slippage ₹200, buffer ₹150 → expected net **₹1,700 → eligible**

The legacy `MIN_BOX_NET_EDGE` still works: if set above 0 it raises the effective gate to
`max(BOX_MIN_EXPECTED_NET_PROFIT, MIN_BOX_NET_EDGE)`.

#### Charges are computed LOCALLY, then reconciled

The decision path no longer waits on Zerodha. A **local, synchronous, deterministic** calculator
(`localCharges.ts`) prices the eight box orders in a few dozen float operations, reusing the exact
heads and rounding the calendar ledger uses (brokerage, STT sell-side only, exchange transaction
charge, SEBI, stamp duty buy-side only, GST). Every rate is centralised and env-overridable.

After a paper trade is opened, Zerodha's virtual contract note (`POST /charges/orders`) is called
**asynchronously** to reconcile — it never delays a fill. The trade stores the local total, the
reconciled total, the absolute and percentage difference, and a status; when they agree the charge
record is promoted to `local_verified`. A discrepancy over `BOX_CHARGE_RECONCILE_WARN_PCT`
(default 5%) logs a warning and is surfaced in `/api/box/status`. Reconciliation is
concurrency-limited and cached, so Zerodha is never hammered.

Guards on every automatic entry:

- **Market open.** Outside NSE equity-derivatives hours nothing is entered at
  all: there is no executable book, so a paper fill would be a fiction.
- **One lot, always.** `quantity` is the contract's current `lot_size` from
  instrument metadata. There is no multiplier and no custom size.
- **One-lot touch liquidity.** Each leg needs `ask > 0 && askQty >= lotSize`
  (BUY) or `bid > 0 && bidQty >= lotSize` (SELL), counting only what rests at
  that **exact** best price. V1 does not walk deeper levels.
- **Feed liveness.** The newest tick across the WHOLE universe must be within
  `BOX_FEED_MAX_AGE_MS` (default 5s). This is the check that catches a silently
  dropped connection, where every cached book still looks normal while being of
  unknown age. When it trips, entries and automatic exits pause.
- **Book trust window.** Each of the four books must have changed within
  `BOX_QUOTE_MAX_AGE_MS` (default 15s). Note this is NOT a "price age" limit: a
  depth feed only sends a message when the book *changes*, so silence on a quiet
  strike is not staleness — an untouched book is still the current, executable
  book. Illiquid F&O strikes are routinely quiet for seconds at a time, so a
  sub-second limit here makes the scanner unable to trade anything but the most
  active names without making it any safer.
- **Revalidation.** Charge estimation is asynchronous, so after it returns the
  four quotes are re-read and the freshness, liquidity and ₹1,200 spread tests
  are re-applied to the **current** book. A decision is never executed on a
  pre-API-call snapshot.
- **One open box per exact strike pair**, enforced by a synchronous in-memory
  reservation *and* a unique partial index on
  `{underlying, expiry, lower_strike, upper_strike}` where `status: "open"`.

### When the market is closed

Pressing RUN outside market hours does not trade. Instead the scanner publishes
an **indicative** view built from each contract's **last traded / closing**
price, so a box that was mispriced at the close is still visible:

```
indicativeCostPerUnit = Last(K1 CE) - Last(K2 CE) + Last(K2 PE) - Last(K1 PE)
```

Two guards keep that view honest, because **a last-traded price is not a closing
price**: a strike that has not traded for days carries a price struck when the
underlying was somewhere else, and four legs each stale from a different session
produce an enormous fictional edge.

1. **Session filter.** Only legs whose `last_trade_time` falls in the newest
   session present in the data are used (derived from the quotes themselves, so no
   holiday calendar is needed). Legs that last traded earlier are dropped and
   counted in `indicative_stale_legs`.
2. **Plausibility bound.** A long box always costs money and can never cost more
   than it pays, so the implied cost must sit strictly inside `(0, width)`. A
   negative cost would imply free money of unlimited size; a cost above the width
   would mean paying more than the guaranteed payoff. Outside that range no cost
   and no edge are reported at all — the row is simply absent rather than shown
   with an impossible number.

Those rows carry `price_source: "last_close"` and status `INDICATIVE`, are never
`liquidity_ok`, and cannot reach the entry path — the market-open gate sits in
front of it independently. Open positions are likewise **not** auto-exited while
the exchange is shut (their metrics keep refreshing, but "the market is shut" is
not a liquidity event and is not written to the ledger). The view refreshes every
`BOX_INDICATIVE_REFRESH_MS` (default 60s) via one REST `/quote` call per 500
instruments.

### Universe: ATM ±3 only

NSE **F&O stock and index OPTIONS only** — every F&O underlying that has listed option
contracts and a resolvable spot (an NSE equity, or one of the supported indices), each on its
nearest non-expired expiry, and for each one **at most seven strikes**: `ATM-3 … ATM … ATM+3`. That gives
at most `C(7,2) = 21` strike pairs per underlying, which is the entire V1 search space. The ATM
window re-centres when the underlying drifts past a hysteresis band (and no more often than
`BOX_WINDOW_MIN_INTERVAL_MS`), so a price sitting on a strike boundary cannot cause continuous
resubscription.

### Exit: convergence, measured explicitly

The strategy is not held to expiry — it enters a temporary mispricing and leaves once it has
converged enough to bank a worthwhile net profit. The exit reverses every leg (direction-aware),
and `evaluateExitDecision()` returns one structured verdict rather than scattered booleans:

```
exitCreditPerUnit = Σ (+price for each closing SELL, -price for each closing BUY)   # executable touch
grossPnL          = (exitCreditPerUnit - entryNetDebitPerUnit) x lotSize
currentNetPnL     = grossPnL - (entryCharges + currentEstimatedExitCharges)
remainingEdge     = (sign x (K2 - K1) - exitCreditPerUnit) x lotSize
capturedEdge      = entryEdge - remainingEdge
capturedPct       = capturedEdge / |entryEdge|
threshold         = max(₹200, 20% x entryNetEdge)
```

A box closes automatically when it is executable **and** either

1. `remainingEdge <= threshold` **AND** `currentNetPnL >= ₹600` (`EDGE_CONVERGED`), or
2. `currentNetPnL >= ₹600` **AND** (`currentNetPnL >= 75% x entryNetEdge` **or**
   `capturedPct >= BOX_MIN_CAPTURED_PCT`) (`PROFIT_CAPTURE`).

In **all** cases the net P&L is computed from executable exit prices plus current exit fees, so a
theoretical threshold being crossed can never close a trade that would not actually pay — that case
is reported as a held `net_below_floor` reason rather than acted on. Sign handling is identical for
long and short boxes (no inverted P&L). Expiry safety is a separate emergency rule that overrides
profitability but still refuses to invent a price.

If the arithmetic says close but the touch cannot supply a whole lot, the exit is **not faked**:
the position stays open, `EXIT_SKIPPED_LIQUIDITY` is recorded with the specific shortfall, and
monitoring continues. Manual close behaves the same way — it refuses with an explanation rather
than inventing a price. Near expiry an expiry-safety state attempts an executable close and, if
the market is not there, records and exposes that condition instead of fabricating one.

### RUN / STOP, and who owns a position

`RUN` starts discovery. `STOP` stops **opening new** boxes only:

- open positions keep being monitored by the backend
- their automatic exits keep working
- this is independent of the browser — closing the tab or leaving `/box` changes nothing

Open positions are re-adopted from MongoDB on boot, so a restart does not orphan one. The
monitoring loop never depends on React being mounted.

### Running day P&L + nightly archive (optional)

`/api/box/status` always reports a `day_pnl` block — the **running** net P&L of the day's box
trades: the summed current net of every open position plus the realised net of every trade closed
today, and their total. It is computed off the same touch-based metrics the monitor uses (no
valuation model, nothing invented) and reads no database on a status call — the open side is
in-memory and the closed side is a tally seeded from Mongo at boot and folded forward on each close.
The Box page shows it as a compact strip above the execution-health panel.

When `BOX_PNL_CACHE_ENABLED=true` **and** Upstash Redis is configured, that day P&L is also:

- **mirrored to Redis** every `BOX_PNL_CACHE_INTERVAL_MS` (default 30s) — a fast,
  restart-surviving copy of "how today is going" under `calspread:box:pnl:day:<YYYY-MM-DD>`. This is
  **not** a replacement for `box_trades`: entries and exits still persist to Mongo exactly as
  before. It is a reporting mirror.
- **archived to Mongo** once a night into a dedicated `box_daily_pnl` collection (one document per
  trade per day, plus a per-day summary). The drain is **streamed** — one document at a time with a
  small delay (`BOX_PNL_ARCHIVE_DRAIN_DELAY_MS`, default 50ms) — so a day's rows never land as a
  single bulk write, and a failure part-way through is retried rather than losing data. The drain
  runs at `BOX_PNL_ARCHIVE_HOUR` (default 21:00 IST); two later passes at `BOX_PNL_VERIFY_HOURS`
  (default 22:00 & 23:00 IST) re-check the day and finish anything the first pass missed. Every
  upsert is idempotent, keyed on `(day, trade_id)`, so re-draining an already-written row is safe.
  A process that comes up after the archive hour reconciles the day (and any still-pending earlier
  day) on boot.

With `BOX_PNL_CACHE_ENABLED` unset the whole subsystem is inert: no Redis writes, no new collection,
and the module behaves exactly as before.

### Performance

The decision path is entirely backend-side and event-driven:

```
Kite WebSocket -> quote map -> affected candidates -> fast local calculation
  -> liquidity/freshness validation -> charge validation -> paper trade
```

A `token -> candidates` index means a tick only recalculates the boxes that reference the token
that moved (a strike is a leg of at most six of an underlying's 21 pairs), never a chain scan.
MongoDB is never in the hot path — open positions are held in memory and written on entry, on exit
and on a slow periodic snapshot. A charge call is only ever considered once a box's **gross** edge
clears `₹1,200 + safety + a deliberate lower bound on charges`, and results are cached and
de-duplicated, so the charge API can never become the bottleneck. The UI is a control surface: it
receives a batched snapshot a couple of times a second and takes part in no decision.

The module reuses the **single** shared Kite WebSocket via the ticker hub rather than opening a
second connection. **Executable option books are WebSocket-only**: REST depth is never admitted to
the Box quote store, feed-health clock, entry path, automatic exit path, or manual-close path.
Relevant WebSocket depth updates also re-evaluate affected open positions immediately; the
one-second monitor is only a fallback watchdog. After any asynchronous charge lookup, all four
books are captured again and that immutable final snapshot supplies the stored touch prices,
touch quantities, and five-level depth.

Because Zerodha caps instruments per connection, `BOX_MAX_SUBSCRIBED_TOKENS`
(default 2,200) bounds the live subscription; underlyings that do not fit are reported in
`skipped_symbols` on the status endpoint. Legs of an **open position are always subscribed**,
whatever the budget.

### Configuration

Every threshold is env-overridable; the defaults are the shipped specification.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `BOX_MONGODB_URI` | *(unset)* | Dedicated database for `box_trades` + `box_trade_events`; falls back to `MONGODB_URI` |
| `BOX_MIN_EXPECTED_NET_PROFIT` | `1200` | **The entry gate**: minimum expected NET profit (₹) after every cost |
| `MIN_BOX_GROSS_EDGE` | `1200` | Cheap gross prefilter (₹) — never the decision |
| `MIN_BOX_NET_EDGE` | `0` | Legacy *additional* net floor (₹). `>0` raises the effective gate |
| `BOX_EXECUTION_MODE` | `paper_latency` | `paper_latency`, `paper_touch`, `paper_legging`, or explicitly gated `live`; unknown values fail closed |
| `BOX_LIVE_TRADING_ENABLED` | `false` | Independent deployment kill switch; live requires this and `BOX_EXECUTION_MODE=live` |
| `BOX_LIVE_MAX_OPEN_BOXES` | `1` | Live maximum open Box projections |
| `BOX_LIVE_MAX_CONCURRENT_EXECUTIONS` | `1` | Live broker-operation concurrency; role orders queue by safety priority |
| `BOX_LIVE_MAX_RESIDUAL_LEGS` | `1` | Live residual-leg circuit-breaker limit |
| `BOX_LIVE_RECONCILE_INTERVAL_MS` | `60000` | Low-frequency broker order/position reconciliation cadence |
| `BOX_LIVE_FEED_RECONNECT_WARMUP_MS` | `5000` | Quiet period after reconnect, in addition to current-generation leg ticks |
| `BOX_SIMULATED_LATENCY_MS` | `250` | Simulated order-send → exchange arrival delay |
| `BOX_SIMULATED_DECISION_MS` | `40` | Simulated internal decision time before an order is "sent" |
| `BOX_EXECUTION_MAX_WAIT_MS` | `1500` | Bound on how long the simulator waits to reach the arrival instant |
| `BOX_LEG_EXECUTION_MODE` | `parallel` | `paper_legging` leg submission: `parallel` or `sequential` |
| `BOX_LEG_TIMEOUT_MS` | `500` | `paper_legging` per-leg rest time before it is deemed unfilled |
| `BOX_LEG_UNWIND_LATENCY_MS` | `150` | Simulated latency of the emergency unwind of partial fills |
| `BOX_LEG_MAX_CHASE_TICKS` | `2` | `paper_legging` entry marketable-limit chase, in ticks past the reference touch |
| `BOX_UNWIND_MAX_CHASE_TICKS` | `5` | Wider chase band (ticks) for an emergency unwind — flattening over price |
| `BOX_DEFAULT_TICK_SIZE` | `0.05` | Fallback tick size (₹) when the instrument dump has none |
| `BOX_QUEUE_MODEL` | `haircut` | `haircut` (conservative, only part of displayed depth is ours) or `none` (raw displayed) |
| `BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT` | `30` | % of each displayed level assumed queued ahead of us (haircut model) |
| `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` | `250` | Reject a candidate whose four legs' exchange timestamps span more than this (0 disables) |
| `BOX_EXIT_USE_REALISABLE` | `true` | Judge the auto-exit profit floor on realisable net (touch net − exit-slippage allowance) pre-execution; the final check uses the actual executed price |
| `BOX_STT_ROUND_NEAREST_RUPEE` | `true` | Round the STT head to the nearest rupee, as the contract note does |
| `BOX_IPFT_PER_CRORE` | `0` | NSE IPFT expressed as ₹ per crore of premium (folded into the exchange head) |
| `BOX_ENABLE_SHORT_BOX` | `true` | Evaluate SHORT/reverse boxes as well as long boxes |
| `BOX_EXPECTED_ENTRY_SLIPPAGE` / `BOX_EXPECTED_EXIT_SLIPPAGE` | `250` / `250` | Slippage allowances (₹) used before/for the un-measured side |
| `BOX_RECONCILE_CHARGES` | `true` | Verify local charge maths against Zerodha asynchronously after a fill |
| `BOX_CHARGE_RECONCILE_WARN_PCT` | `5` | Warn when local vs Zerodha charges differ by more than this % |
| `BOX_CHARGE_RECONCILE_MAX_ATTEMPTS` | `3` | Bounded retries before charges are recorded unverified (never a hot loop) |
| `BOX_CHARGE_RECONCILE_RETRY_BASE_MS` | `5000` | Linear backoff base: attempt N waits N × this |
| `BOX_BROKERAGE_PER_ORDER` | `20` | Flat ₹ per executed option order |
| `BOX_STT_SELL_PCT` | `0.15` | Option STT, **percent of premium**, sell side. 0.15% since 1 Apr 2026 (was 0.10%) |
| `BOX_EXCHANGE_TXN_PCT` | `0.03503` | NSE options transaction charge, percent of premium |
| `BOX_IPFT_PER_CRORE` | `50` | NSE IPFT, **₹ per crore** of premium (folded into the exchange head) |
| `BOX_SEBI_PCT` | `0.0001` | SEBI turnover fee, percent of premium |
| `BOX_STAMP_DUTY_BUY_PCT` | `0.003` | Stamp duty, percent of premium, buy side only |
| `BOX_GST_PCT` | `18` | GST on (brokerage + exchange + SEBI), percent |
| `BOX_CHARGE_RATE_VERSION` | `zerodha-nse-options-2026-04-01` | Stamped on every trade/attempt so results survive a rate change |
| `BOX_REQUIRE_PRICED_CHARGES` | `true` | Skip a box whose charges could not be determined |
| `BOX_SAFETY_BUFFER` | `150` | Risk allowance (₹) deducted inside the expected-net figure |
| `BOX_QUOTE_MAX_AGE_MS` | `15000` | How long an UNCHANGED book is still trusted |
| `BOX_FEED_MAX_AGE_MS` | `5000` | Feed liveness: newest tick across the whole universe |
| `BOX_INDICATIVE_REFRESH_MS` | `60000` | How often the last-close view is rebuilt while the market is shut |
| `BOX_PREFILTER_CHARGE_ALLOWANCE` | `160` | Lower bound on round-trip charges, prefilter only |
| `BOX_CONVERGENCE_FLOOR` / `BOX_CONVERGENCE_PCT` | `200` / `0.2` | Convergence threshold |
| `BOX_MIN_EXIT_NET_PNL` | `600` | Minimum net profit for a normal convergence exit |
| `BOX_PROFIT_CAPTURE_PCT` | `0.75` | Fraction of the entry edge that alone justifies exiting |
| `BOX_MIN_CAPTURED_PCT` | `0.75` | Fraction of the ORIGINAL edge captured that alone justifies exiting |
| `BOX_EXPIRY_SAFETY_MINUTES` | `45` | Minutes before the close on expiry day to force an exit |
| `BOX_MAX_SUBSCRIBED_TOKENS` | `2200` | Live-feed instrument budget |
| `BOX_MAX_CONCURRENT_EXECUTIONS` | `8` | Cap on simultaneous simulated execution pipelines |
| `BOX_METRICS_WINDOW` | `500` | Samples kept in each bounded rolling-metrics ring buffer |
| `BOX_PNL_CACHE_ENABLED` | `false` | Mirror the running day P&L to Redis and archive it nightly to `box_daily_pnl` (needs Upstash) |
| `BOX_PNL_CACHE_INTERVAL_MS` | `30000` | How often the running day-P&L snapshot is written to Redis |
| `BOX_PNL_CACHE_TTL_SEC` | `259200` | TTL (s) on a day's cached P&L hash (must outlive the verify passes) |
| `BOX_PNL_ARCHIVE_HOUR` | `21` | IST hour (0–23) at which the day's cached P&L is drained to Mongo |
| `BOX_PNL_VERIFY_HOURS` | `22,23` | IST hours (comma-sep) at which the archive is re-checked and completed |
| `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS` | `50` | Delay (ms) between each document while streaming the archive to Mongo |
| `BOX_MONITOR_INTERVAL_MS` | `1000` | Fallback watchdog cadence; open positions normally re-evaluate immediately on relevant WebSocket depth ticks |

**Observability.** `/api/box/status` now also exposes bounded rolling metrics: evaluations/sec,
WS updates/sec, receive→evaluation and event-loop-lag percentiles, decision→fill latency
percentiles, simulated slippage distributions, execution failure rate by reason, and charge
reconciliation discrepancy stats — all from fixed-size ring buffers, never unbounded arrays.

**Architecture.** New focused modules keep `engine.ts` from growing: `localCharges.ts` (the rate
card + calculator), `executionSimulator.ts` (the detection→latency→fill pipeline),
`chargeReconciler.ts` (async Zerodha verification) and `metrics.ts` (ring buffers). The quote
store exposes a `replay()` + `subscribe()` seam so recorded tick batches can be driven through the
exact live code path (store → scanner → execution simulator → monitor) without a Zerodha
connection — the basis of a deterministic replay harness.

| `BOX_STRIKE_LEVEL` | `3` | Boot value of the active strikes-each-side level (1, 2 or 3), admin-adjustable at runtime |

**ATM ±3 is the hard maximum.** The admin can *narrow* the monitored window to ATM ±1 or ±2 at
runtime via `POST /api/box/strike-level` (admin-guarded, `{ "level": 1|2|3 }`); it can never be
widened past ±3. Narrowing takes effect immediately for **new** discovery — the windows rebuild at
the chosen width and only boxes within ATM ±level are entered from that point. **Positions already
open are never affected**: they keep their own legs, stay subscribed unconditionally, and are
managed and exited on their own rules regardless of the new width. The active level is reported as
`strike_level` on `/api/box/status` and `/api/box/config`.

### Tests

`npm test` builds and runs the box suite (`tests/box/`, Node's built-in runner, no extra
dependency) — **118 deterministic tests**, no clock, network or database. Alongside the original
math/scanner/monitor/serialize coverage it adds:

- **Direction** — long and short side maps, opposite edge signs on the same book, the short-box
  opportunity being "box above width", direction in the identity key, and old documents loading as
  `LONG_BOX`.
- **Execution simulator** — zero / favourable / adverse post-latency moves, insufficient quantity
  after the delay, a missing post-arrival book (never faked into a fill), a dead feed during the
  delay, the edge disappearing, expected-net falling below the gate, and duplicate-pipeline
  prevention — all with an injected clock so latency is exercised deterministically.
- **Local charges** — known deterministic examples, `sum(heads) == leg total` and
  `sum(legs) == group total`, sell-side STT / buy-side stamp duty, the reversed exit projection,
  and env-override of a rate.
- **Entry decision** — gross-high-but-net-below-₹1,200 → reject, gross-high-and-net-above →
  eligible, the exact ₹1,200 boundary, slippage biting the decision, and the legacy floor.
- **Exit/convergence** — no/partial/threshold convergence, high captured %, converged-but-
  unprofitable held, profitable executable exit, insufficient exit liquidity, short-box signs, and
  expiry safety.
- **Replay harness** — recorded batches driven through `store.replay()` notify observers exactly
  as a live tick would.

---

## Endpoint surface

Analytics:

| Endpoint | Returns |
| -------- | ------- |
| `GET /api/option-chain/:underlying` | Strike ladder around ATM with CE/PE tokens, expiries, lot size |
| `GET /api/option-oi-frame/:underlying?frame=` | Call/Put total OI + straddle + spot for one frame |
| `GET /api/futures-oi-frame/:underlying?frame=` | Per-contract futures OI for one frame |
| `GET /api/option-oi-baseline/:underlying?minutes=` | Per-token OI/LTP as of N minutes ago, with the span the cache can serve |
| `GET /api/option-prev-close/:underlying` | Previous session's close per token (the Day baseline) |
| `GET /api/option-oi-series/:underlying` | Today's per-minute aggregates |

Market data: `/api/status`, `/api/instruments`, `/api/fno-stocks`, `/api/fno-stocks/:symbol`,
`/api/fno-board`, `/api/quotes`, `/api/stream`, `/api/dividends`, `/api/profile`.

History: `/api/history/:symbol`, `/api/intraday/:symbol`, `/api/minute/:symbol`,
`/api/fivemin/:symbol`, `/api/spread-history/:symbol`, `/api/spread-stats/:symbol`.

Auth and session: `/login`, `/callback`, `POST /api/session`, `POST /api/admin/verify`,
`POST /api/access/verify`, `GET /api/admin/status`, `POST /api/logout`,
`GET /api/kite/access-token`, `GET /api/internal/kite-token`, `GET /api/kite/token`.

Risk-free rate: `POST /api/rf` (full admin), `GET /api/rf` (passcode), `GET /api/rf/current`.

Trades: `POST /api/trades`, `GET /api/trades`, `POST /api/trades/:id/close`,
`DELETE /api/trades/:id`.

Box arbitrage (paper, admin-only — full admin or trade access):

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/box/status` | Scanner state, `market_open`, universe/candidate counts, execution + reconciliation stats, rolling latency/slippage metrics |
| `GET /api/box/config` | Active thresholds (₹1,200 expected net, execution mode + latency, long/short, ATM ±3, 1 lot) |
| `POST /api/box/start` | RUN — begin discovering and auto-opening paper boxes |
| `POST /api/box/stop` | STOP — stop opening NEW boxes (open ones stay monitored) |
| `POST /api/box/strike-level` | ADMIN — set monitored/traded window to ATM ±1, ±2 or ±3 (open positions unaffected) |
| `GET /api/box/opportunities` | Current opportunities, best net edge first |
| `GET /api/box/chains` | Monitored underlyings; `?underlying=` for its ATM ±3 chain with legs marked |
| `GET /api/box/trades` | Open positions + persisted box trades |
| `GET /api/box/trades/open` | Live open positions with current exit arithmetic |
| `GET /api/box/trades/history` | Closed box trades |
| `POST /api/box/trades/:id/close` | Manual close at the executable touch (409 if not fillable) |
| `GET /api/box/events` | The append-only decision ledger |
| `GET /api/box/stream` | SSE: scanner state, opportunities, entries, position updates, exits |

Sensitive routes are rate-limited (the verify routes more aggressively than the rest).

## Running it

```bash
npm install
cp .env.example .env   # fill in at least KITE_API_KEY / KITE_API_SECRET / ADMIN_SECRET
npm run dev            # build + start
```

Every integration is optional and fails soft: with no `MONGODB_URI` the trade book is off,
with no Redis the caches are memory-only, with no `NSE_FNO_*_URI` the EOD pipelines are off,
and with no `TRADE_LOG_URI` the charges ledger falls back to the `MONGODB_URI` database.
The service starts and the rest keeps working.

## Known limitations

- Analytics is **NIFTY-only**. The endpoints take an `:underlying` parameter but the capture
  pipelines are hard-wired to NIFTY.
- A backfill reconstructs the window from the **currently listed** strikes, so a period before
  those contracts existed (an already-expired weekly) can't be rebuilt.
- The per-minute chain snapshots behind the comparison windows are **not** themselves
  backfilled — after downtime those windows refill going forward rather than being
  reconstructed.
- Today's per-minute aggregate cache (`/api/option-oi-series`) is memory-only, so it restarts
  empty even when Redis is configured. The chart frames are unaffected.

### Box paper execution — what `paper_legging` still cannot reproduce

Even the `paper_legging` model, with marketable-limit pricing, depth walking, partial fills and a
queue haircut, is **not** equivalent to live Zerodha → NSE execution. It cannot derive from
WebSocket level-2 data:

- **True exchange queue position.** The haircut is a deterministic *approximation* of the queue
  ahead of us, not the real order-level priority NSE maintains. Two orders at the same price do not
  fill pro-rata by displayed size.
- **Broker/RMS latency and acknowledgements.** Real orders traverse Zerodha's OMS/RMS, receive
  acknowledgements, and can be delayed or throttled. The simulator models a single configurable
  network latency, not this pipeline.
- **Real broker rejects** (margin, freeze-quantity, price-band, circuit, OI limit, RMS blocks).
- **Exchange order priority and matching** (price-time priority, iceberg/hidden orders, auction and
  pre-open behaviour).
- **Hidden / transient liquidity.** Depth flickers between our snapshots; quantity shown may vanish
  or appear in microseconds we never observe.
- **Network jitter and packet loss**, and the second-resolution exchange timestamps Kite provides
  (fine for coherence gating, too coarse for microsecond sequencing).
- **Market impact** of our own order, and the reaction of other participants to it.

Because of these, a `paper_legging` result is a *conservative, honest lower bound on execution
quality given the data we can see* — useful for shadow-testing and calibration, **not** a promise of
live fills. Never read "the tests pass" or "not degraded" as "production-ready".

**Partial exits are modelled exactly, not simplified.** Every open box carries per-role remaining
quantity (`remaining_qty_by_role`). A `paper_legging` exit sizes each closing order from that exact
outstanding quantity — so a role already flat is never re-closed and a partial close can never become
reverse exposure. A partial exit decrements the per-role remaining, is persisted atomically before
the execution is treated as clean (a crash cannot resurrect closed quantity), appends to an
`exit_attempts` audit, and accumulates charges/realised-gross; the box is `closed` only once **every
role is flat**. A partially-exited position is worked to flat (prioritising cleanup over convergence),
and residual exposure from a failed unwind is flattened by a runtime loop that runs independently of
RUN/STOP whenever the market is open and the feed is healthy. Manual and automatic closes share one
code path and differ only in the exit reason; a manual close reports partial execution honestly
rather than pretending nothing happened.


---

## 9. Two brokers, one active: Zerodha and Dhan

Calspread supports **Zerodha** and **DhanHQ v2**. Historical trades from both live in the
database forever; **only one broker is ever active** for market data, the Box scanner, the
quote/depth feed, new trades, live execution, positions, reconciliation, margins and charges.

That rule is enforced structurally, not by convention. Everything broker-specific is
reachable only through `ActiveBrokerManager.runtime()`, which returns exactly one runtime —
there is no way to ask for "the Dhan feed" while Zerodha is active. `BoxEngine` consumes only
the interfaces in `src/box/brokerContext.ts` (`BoxMarketDataProvider`, `BoxFeedProvider`,
`BoxMarginProvider`, `BoxChargeCalculatorLike`, `BoxLiveAdapterFactory`) and cannot name a
venue, so there are no `if (broker === "dhan")` branches in the strategy.

### Login URLs

| Broker | Login redirect | Postback |
|---|---|---|
| Zerodha | `https://calspread.online/zerodha/verify` | — |
| Dhan | `https://calspread.online/dhan/verify` | `https://calspread.online/api/dhan/postback` |

Both must match the redirect URL configured on the broker's app **exactly**.

### Choosing a broker

`/admin/verify` now asks for a broker before the admin password:

```
Choose broker      [ ZERODHA ]  [ DHAN ]
Admin secret       ••••••••
```

`POST /api/admin/verify` accepts `{ "secret": "…", "broker": "dhan" }`. The field is optional,
so an older client sending only `secret` keeps working. `GET /api/admin/status` returns
`{ authenticated, role, broker }`.

Trade-access users under `/admin/access` **inherit** the active broker and cannot choose one —
switching brokers moves the whole system, so it is full-admin only.

### Connecting Dhan

1. `POST /api/dhan/login` (full admin) → the backend calls Dhan's `generate-consent` with the
   API key/secret and returns a browser login URL.
2. The browser completes Dhan's login (password + 2FA).
3. Dhan redirects to `/dhan/verify?tokenId=…`; the frontend posts the `tokenId` to
   `POST /api/dhan/session`, which exchanges it via `consumeApp-consent` and persists the
   session in the `dhan_session` collection.

The **`tokenId` is single-use**, so the frontend carries the same StrictMode double-invoke
guard the Zerodha flow uses. **The API secret and the access token never reach the browser** —
`GET /api/dhan/status` returns only account identifiers and timestamps.

Other routes: `GET /api/dhan/status`, `POST /api/dhan/logout`,
`GET /api/dhan/access-token` (full admin), `POST /api/dhan/postback`.

### Token expiry

Dhan states an explicit `expiryTime`, which is honoured directly rather than inferred from a
login date the way the Zerodha session is (Kite tokens die at the IST day boundary; Dhan's do
not necessarily). An **absent** expiry means UNKNOWN — validated by using it, never treated as
"never expires".

On expiry the system **fails closed**: the feed stops, executable books are invalidated, live
execution is blocked, and the UI shows **"Dhan session expired — reconnect Dhan"**.

### Static IP is required for live Dhan orders

Dhan requires the server's **public IP to be whitelisted** before it accepts order placement,
modification or cancellation. There is no API to query this, so it is an explicit operator
declaration via `DHAN_STATIC_IP_EXPECTED`, which **defaults to false and fails closed**.

Setting it to `true` without actually whitelisting the IP does not make orders work — it only
removes the local guard, and Dhan then rejects orders at the edge, potentially part-way
through building a four-leg box. Whitelist the IP in the Dhan API dashboard first.

Readiness is reported per capability, because data and trading fail independently:

```json
{ "broker": "dhan", "authenticated": true, "data_ready": true,
  "static_ip_configured": false, "trading_ready": false,
  "problems": ["Static IP not configured — Dhan live order placement is blocked"] }
```

### Switching brokers

`POST /api/broker/select` refuses with **HTTP 409** — and lists **every** blocker, not just the
first — while any of these exist:

- the scanner is running
- an open Box position exists
- broker orders are still working
- an entry/exit is in flight
- reconciliation is incomplete
- residual leg exposure is outstanding
- any order is in an unknown state
- the broker being **left** still has unresolved durable order intents

A switch is refused rather than queued because there is no safe automatic resolution: a real
position would be left monitored by the wrong feed and reconciled against the wrong order-id
space. `GET /api/broker/switch-blockers?broker=dhan` reports the same list without attempting
the switch.

When a switch **is** allowed, the ordering is the safety property. The old broker is fully torn
down before the new one is reachable:

1. stop the scanner
2. stop the old feed and drop its subscriptions
3. invalidate every cached quote/depth book and bump the feed generation
4. clear broker-specific runtime caches (instrument master)
5. move the active broker
6. load the new broker's instruments
7. start **only** the new broker's feed

There is therefore no instant at which two feeds could both drive a Box decision, and no way
for one broker's book to price the other's trade.

### Broker-scoped reconciliation

Every durable order intent persists its `broker`. On restart a Zerodha intent is reconciled
**only** through Zerodha and a Dhan intent **only** through Dhan: the two order-id spaces are
unrelated, so a cross-broker lookup would either 404 (misread as "the order never existed",
losing real exposure) or collide with an unrelated real order. Legacy intents have no `broker`
field and are Zerodha's.

### Broker identity on trades

Every trade permanently records the broker that created it (`broker` on `box_trades`,
`box_trade_events`, `box_execution_attempts`, `box_order_intents`). It is **immutable** after
creation and orthogonal to `execution_mode`: paper/live says how a fill was produced, broker
says whose feed priced it and whose fees costed it.

**Existing documents load unchanged.** Every field is optional with a `"zerodha"` schema
default, resolved through one reader (`brokerOf()`) — Zerodha was the only broker the app ever
had, so that is a statement of fact, not a convenience. **No migration is needed to boot.**

The UI shows a compact `[ZERODHA]` / `[DHAN]` badge on every open card, every closed-history
row and in trade details, plus a `BROKER` tile on the Box page. Each trade shows **its own**
broker, never the currently active one — otherwise switching would silently relabel history.
The closed-history filter (`All | Zerodha | Dhan`) appears only when both brokers are present.

### Dhan charges and margin are Dhan's

The statutory heads are identical at every broker; **brokerage is not**. A four-leg box round
trip is **eight orders**, so a per-order difference is multiplied eightfold against a ₹1,200
entry gate. Dhan trades are therefore costed with Dhan's rate card and labelled
`computed_by: "dhan_estimate"`, `broker: "dhan"` — never as `local` (the Zerodha calculator) or
`kite`. The Box expected-net gate always spends the **active** broker's charges.

Margin uses Dhan's calculator, summed across the four legs. That is a conservative **upper**
bound — it ignores the offsetting benefit a real box receives — so the figure can only be too
high, never too low. Under-stating margin would be dangerous; over-stating it is merely
pessimistic, and the figure is display/accounting only and never gates a trade.

### Dhan market data

- **Feed:** one shared binary WebSocket (`wss://api-feed.dhan.co`), FULL packet mode, fanned
  out through the existing hub so no consumer knows which broker produced a tick. Subscriptions
  are batched at Dhan's 100-instrument-per-message limit; reconnect uses capped exponential
  backoff; books are dropped on every switch.
- **`exchange_at` is always null.** Dhan's FULL packet carries a *Last Trade Time*, which is
  when the last trade printed — **not** when the order book was published. For an illiquid
  option those differ by minutes. The Box cross-leg temporal-coherence check needs a book
  timestamp, so feeding it a trade time would corrupt an executability decision. The engine
  falls back to local receive time, which is honest and already supported.
- **Box always uses executable bid/ask depth, never the LTP.**
- **History:** `/api/history/:symbol`, `/api/intraday/:symbol`, `/api/minute/:symbol` and
  `/api/fivemin/:symbol` are unchanged for the frontend and route to the active broker. Dhan
  returns candles **column-wise** (parallel arrays) where Kite returns rows, so the
  transposition is explicit; intraday ranges are **chunked** because Dhan bounds how much one
  request may cover.

### Dhan order safety

`src/box/dhanBrokerAdapter.ts` implements the existing `BrokerAdapter` and reuses the same
`BoxOrderManager`, durable intents and reconciliation state machine. There is no second
strategy and no second order manager.

- **Bounded marketable LIMIT only.** `assertBoundedLimit` runs before anything is sent, and a
  modification is re-validated inside the *original* envelope so chasing cannot walk outside
  the configured band. Product type is `MARGIN` (F&O carry-forward) — never `INTRADAY`, which
  would be auto-squared-off. Box is never switched to unrestricted MARKET orders.
- **Never a blind re-submit.** On an ambiguous `POST /orders` (timeout, 5xx, 429) the order may
  be live. The adapter reconciles via `GET /orders/external/{correlation-id}` and **never**
  POSTs again — a second POST is how a four-leg box grows a fifth leg. A definitive 4xx (not
  429) is recorded as a rejection; anything it cannot prove becomes
  `RECONCILIATION_REQUIRED` rather than a guessed terminal state.
- **Correlation IDs.** Dhan caps `correlationId` at 25 characters, well below a Box client
  order id. Truncating would be catastrophic — the trade id sits in the *middle*, so two
  different trades' `k1_ce` legs share a prefix and could collide. Instead a deterministic
  64-bit hash of the whole client id is used, so it is recomputable after a crash with no
  stored mapping. Both ids are persisted (`client_order_id`, `broker_correlation_id`).
- **Status normalization** maps `TRANSIT / PENDING / PART_TRADED / TRADED / CANCELLED /
  REJECTED / EXPIRED` onto the existing `BrokerOrderState`, consulting filled quantity rather
  than trusting the label (Dhan reports some partial fills as `PENDING`). An unrecognised
  status becomes `UNKNOWN`, never a fabricated `COMPLETE`.

## 10. Deleting Box trades

`DELETE /api/box/trades/:id` — **full admin only**, rate limited separately from the global
`/api` bucket.

A close is a market event that realises P&L and belongs in history. A delete is an
**administrative correction**: the trade should never have counted, so nothing about it may
survive in any of the four places box state lives — in-process memory, Redis, Mongo and the
daily-P&L archive.

**Allowed:** `paper_touch`, `paper_latency`, `paper_legging` — in `open`, `closed` or `error`
status.

**Refused with 409:**
- an **open LIVE** trade — real broker exposure would be orphaned: still at the broker, with
  nothing in our database pointing at it, so no reconciliation, monitor or flatten could ever
  find it again. Flatten it first.
- a **closed LIVE** trade — retained deliberately as the audit record of real executed orders.
- a paper trade **mid-exit** — a confirmed fill may already be queued for persistence, and
  deleting underneath it could resurrect the document.

Deletion removes the Mongo row, the `BoxPositionBook` entry (freeing the duplicate-open key so
the box can be re-entered), the monitor's retry/evaluation state, feed subscriptions no longer
needed, the Redis closed-trade and P&L cache entries, and the `box_daily_pnl` archive rows. A
deleted open position **stops being monitored and can never close later**.

Every trade-derived number is then **recomputed from what remains** — not adjusted:

open running net · closed today net · day net · open count · closed count · open margin ·
closed margin · cumulative trade margin · total margin · **peak concurrent margin**

Peak concurrent margin is **replayed** from the surviving trade intervals. `peak -=
deleted.margin` is mathematically wrong: two non-overlapping ₹5L trades peak at ₹5L, so
deleting one must leave ₹5L, while subtraction reports ₹0. Margin is held over the half-open
interval `[opened_at, closed_at)` and the total can only rise at an interval **start**, so
sweeping the start points finds the true maximum exactly. Unknown (null) margins are excluded,
never counted as zero.

An append-only `TRADE_DELETED` event records the id, broker, underlying, direction, status
before deletion, execution mode, opened/closed/deleted timestamps, the acting admin role and an
optional reason — deleting a trade cannot erase the evidence that it was deleted.

The response returns the already-recomputed status, open positions and closed-today list, and a
`trade_deleted` event plus a full snapshot go out over Box SSE, so every open tab corrects
itself with no reload.
