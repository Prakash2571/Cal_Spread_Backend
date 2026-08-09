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
- The last bucket of a session is clamped to the 15:30 close, so the closing bar carries the
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

Sensitive routes are rate-limited (the verify routes more aggressively than the rest).

## Running it

```bash
npm install
cp .env.example .env   # fill in at least KITE_API_KEY / KITE_API_SECRET / ADMIN_SECRET
npm run dev            # build + start
```

Every integration is optional and fails soft: with no `MONGODB_URI` the trade book is off,
with no Redis the caches are memory-only, with no `NSE_FNO_*_URI` the EOD pipelines are off.
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
