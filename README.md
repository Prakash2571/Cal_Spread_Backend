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

## 7. Box arbitrage (paper trading)

An **independent** module in `src/box/`. It shares this app's Kite session, WebSocket, instrument
cache and charge estimator, and shares nothing else: the calendar engine's calculations, captures,
analytics, schema and collections are untouched, and box positions live in their own collections
(`box_trades`, `box_trade_events`) — optionally in their own **database** via `BOX_MONGODB_URI`.

> ### Paper execution — read this before trusting a number
>
> **This module never places a real order.** No Zerodha order-placement API is called anywhere in
> it. Every fill is simulated and stored with `execution_mode: "paper_touch"`.
>
> A paper box fill assumes **all four one-lot legs were simultaneously executable at the touch
> recorded in that decision snapshot**. That is a real, tick-valid price that was genuinely quoted
> — but it **does not guarantee the same result in live trading**, because a real execution can
> also experience:
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

### The box

For strikes `K1 < K2` on the same underlying and expiry, a **long box** is

```
BUY  K1 CE      SELL K2 CE      BUY  K2 PE      SELL K1 PE
```

Its payoff at expiry is a fixed `K2 - K1` per unit wherever the underlying settles, so the edge is
the difference between that width and what the four legs cost to put on.

All pricing is **executable only** — a BUY uses the best **ask**, a SELL uses the best **bid**.
LTP, mid-price and theoretical values are never used to size, qualify or close a position.

```
entryBoxCostPerUnit = Ask(K1 CE) - Bid(K2 CE) + Ask(K2 PE) - Bid(K1 PE)
grossEdgePerUnit    = (K2 - K1) - entryBoxCostPerUnit
grossEdge           = grossEdgePerUnit x lotSize
```

### Entry: ₹1,200 from the SPREAD

The gate is the **gross** arbitrage the executable prices actually show:

```
grossEdge = ((K2 - K1) - entryBoxCostPerUnit) x lotSize
enter if    grossEdge >= MIN_BOX_GROSS_EDGE          (default ₹1,200)
```

Charges are **still** estimated, stored and displayed — they are simply not
deducted before deciding to enter, because fees are managed by hand. The
after-cost figure is reported alongside every opportunity and frozen onto every
trade:

```
projectedNetEdge = grossEdge - entryCharges - estimatedExitCharges - safetyBuffer
```

If you later want a net cushion as well, set `MIN_BOX_NET_EDGE` to a positive
number and it becomes an **additional** floor. It is `0` (off) by default.

Charges come from the **same Zerodha virtual contract note** the calendar trades
use (`POST /charges/orders`), wrapped for a box: four entry orders and four
reversed exit orders priced in **one** request, with a per-leg breakdown and
totals stored on the trade. A box whose charges cannot be priced is shown
`UNPRICED` and skipped — not because of the threshold, but because the exit rules
are evaluated net of charges, so such a position could never have its net P&L
computed and would never auto-exit. Set `BOX_REQUIRE_PRICED_CHARGES=false` to
allow it anyway and manage those by hand.

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

### Exit: convergence, but only while genuinely profitable

The exit reverses every leg — the two longs sell into the **bid**, the two shorts are bought back
at the **ask**:

```
exitBoxValuePerUnit = Bid(K1 CE) - Ask(K2 CE) + Bid(K2 PE) - Ask(K1 PE)
grossPnL            = (exitBoxValuePerUnit - entryBoxCostPerUnit) x lotSize
currentNetPnL       = grossPnL - (entryCharges + currentEstimatedExitCharges)
remainingEdge       = ((K2 - K1) - exitBoxValuePerUnit) x lotSize
threshold           = max(₹200, 20% x entryNetEdge)
```

A box closes automatically when **either**

1. `remainingEdge <= threshold` **AND** `currentNetPnL >= ₹600`, or
2. `currentNetPnL >= 75% x entryNetEdge` (profit capture, even if the raw edge has not converged)

and in **both** cases only while `currentNetPnL > 0` and all four reversed legs have fresh one-lot
touch liquidity. **Convergence alone never closes a losing or break-even box** — the decision
always uses executable exit prices plus currently estimated exit fees.

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
| `MIN_BOX_GROSS_EDGE` | `1200` | **The entry gate**: minimum GROSS edge (₹) from the spread alone |
| `MIN_BOX_NET_EDGE` | `0` | Optional *additional* net floor (₹). `0` = fees do not gate entry |
| `BOX_REQUIRE_PRICED_CHARGES` | `true` | Skip a box whose charges Kite could not price (so exits stay manageable) |
| `BOX_SAFETY_BUFFER` | `150` | Slippage allowance (₹) reported in the net figure, **not** part of the gate |
| `BOX_QUOTE_MAX_AGE_MS` | `15000` | How long an UNCHANGED book is still trusted |
| `BOX_FEED_MAX_AGE_MS` | `5000` | Feed liveness: newest tick across the whole universe |
| `BOX_INDICATIVE_REFRESH_MS` | `60000` | How often the last-close view is rebuilt while the market is shut |

| `BOX_PREFILTER_CHARGE_ALLOWANCE` | `160` | Lower bound on round-trip charges, prefilter only |
| `BOX_CONVERGENCE_FLOOR` / `BOX_CONVERGENCE_PCT` | `200` / `0.2` | Convergence threshold |
| `BOX_MIN_EXIT_NET_PNL` | `600` | Minimum net profit for a normal convergence exit |
| `BOX_PROFIT_CAPTURE_PCT` | `0.75` | Fraction of the entry edge that alone justifies exiting |
| `BOX_EXPIRY_SAFETY_MINUTES` | `45` | Minutes before the close on expiry day to force an exit |
| `BOX_MAX_SUBSCRIBED_TOKENS` | `2200` | Live-feed instrument budget |
| `BOX_MONITOR_INTERVAL_MS` | `1000` | Fallback watchdog cadence; open positions normally re-evaluate immediately on relevant WebSocket depth ticks |

Strikes are fixed at **ATM ±3** in V1 and deliberately not configurable.

### Tests

`npm test` builds and runs the box suite (`tests/box/`, Node's built-in runner, no extra
dependency). It covers the trading core deterministically: strike-window selection and the
seven-strike/21-pair limits, the long-box legs, ask-for-BUY and bid-for-SELL, box cost, expiry
payoff and gross edge, one-lot enforcement and touch-quantity validation, freshness and
missing-bid/missing-ask rejection, fee and safety-buffer reporting, ₹1,199 vs ₹1,200 of spread,
duplicate rejection, token-dependent recalculation, reversed exit sides, the convergence
threshold, the market-closed gate, the indicative last-close view and its plausibility bound, the refusal to exit at a loss or under ₹600, the 75% capture rule, insufficient exit
liquidity leaving a position open, manual close (including its refusal), serialization, and that
STOP blocks new entries while still managing open positions.

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
| `GET /api/box/status` | Scanner state, `market_open`, universe/candidate counts, monitor + charge stats |
| `GET /api/box/config` | Active thresholds (₹1,200 spread, ₹150 safety, 1,500 ms, ATM ±3, 1 lot) |
| `POST /api/box/start` | RUN — begin discovering and auto-opening paper boxes |
| `POST /api/box/stop` | STOP — stop opening NEW boxes (open ones stay monitored) |
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
