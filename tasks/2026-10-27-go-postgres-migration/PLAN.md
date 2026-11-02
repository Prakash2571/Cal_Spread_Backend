# Plan: Cal_Spread backend Node → Go, MongoDB/Redis → PostgreSQL (without Box)
Task: `2026-10-27-go-postgres-migration` · Project: Cal_Spread_Backend (+ `../Cal_Spread` frontend) · Status: [STATUS.md](STATUS.md)

## Goal
User (2026-10-27): "migrate my entire backend from node to go entirely without breaking or changing the features
and for db use postgres for all operations locally removing mongo and redis, use pg for caching". Then: "over write
and do as if you are doing new from scratch" (an earlier session's partial Go port was discarded). Then:
"dont include the box part remove it completely that feature in my go calspread".

Resumption instruction (2026-11-02): the user asked to pick up where Kiro stopped after its credits ran out,
**not restart the migration**. Continue from the existing Go service, golden fixtures and later test ports.
The historical reset above applied to the 2026-10-27 session only. The retained-suite audit is now complete;
its case-by-case report and exact remaining decisions are in STATUS.md.

Final scope approved by the user (2026-11-02): remove the frontend Box page/tab/API calls too; start with a fresh
local PostgreSQL database and **do not import MongoDB/Redis data**; complete and deeply review the migration;
**commit and push both repositories to main** after verification. Local setup and CI are in scope. The user will
handle EC2 deployment themselves. Retire the old Node backend after preserving parity fixtures/provenance and
making the Go tests independent of the removed TypeScript source.

## Rules for this task
- Every feature except Box keeps its behaviour: HTTP paths/methods/JSON shapes/status codes, SSE semantics, env names
  and their effects (`docs/MIGRATION_CONTRACT.md`, `docs/GO_MIGRATION_BOUNDARIES.md`, `docs/CONFIGURATION.md`).
- PostgreSQL is the only store: durable data, history, sessions and caches (with TTL).
  No MongoDB or Redis client, URI or dependency remains.
- Port, don't redesign: same formulas, thresholds, state machines, broker request shapes.
- Never contact real brokers or remote databases during verification. The Go service places no orders at all.
- The Node backend stays in place until the Go service passes parity; then remove it (approved, in Git history).
- Commit/push to main is explicitly authorized by the user's 2026-11-02 instruction; publish only verified intended files.

## Scope: Box is removed (decision 2026-10-27)
Rule: the Go service behaves exactly like the Node service with the Box scanner stopped, no Box trades, no Box
storage and no `/api/box/*` routes.

Dropped (not ported):
- All Box features in `src/box/`: scanner, engine, position monitor, execution gateway, order manager, order intents,
  coordinator, reservations, underlying lock, paper simulator, calibration/timing, P&L archive and caches, trading
  session, live-mode transition, shadow/stress, metrics.
- All 26 `/api/box/*` routes, including the SSE `GET /api/box/stream`. They answer like any unknown route (404).
- Live order transports: `box/kiteBrokerAdapter.ts`, `box/dhanBrokerAdapter.ts`, `brokers/zerodha/liveAdapter.ts`,
  `ActiveBrokerManager.createLiveAdapter`, and the Dhan order endpoints in `brokers/dhan/client.ts` (place, modify,
  cancel, order book, order by id, by correlation id). Dhan order correlation ids go too if nothing else uses them.
- `DhanChargeCalculator` (`brokers/dhan/charges.ts`) and `LocalChargeCalculator`: only Box used them.
- Storage: the 14 `box_*` collections and the 3 Box Redis keys (`box:pnl:day:*`, `box:pnl:days`,
  `box:trades:closed:*`). `BOX_MONGODB_URI` goes with MongoDB.
- Box-only env (`BOX_*` apart from the ones listed under Kept).
- Tests: the Box suites in `tests/box/`, `tests/integration/mongoOrderIntentCas.test.mjs`, and
  `tests/migration-fixtures/box-parity/` plus every `migration-fixtures/box/` file except `charges.json`.

Kept, moved out of `src/box/` into neutral Go packages, because other features use them:
- `box/quotes.ts` (`BoxQuoteStore`, `SpotStore`): Synthetic's own order-book store; also used by the Dhan feed tests.
- `box/localCharges.ts` rate card (`loadBoxChargeRates`, `calculateLegCharges`, `roundStt`, `ipftFor`): Synthetic
  charges. Env names stay: `BOX_BROKERAGE_PER_ORDER`, `BOX_BROKERAGE_MAX_PCT`, `BOX_STT_SELL_PCT`,
  `BOX_STT_ROUND_NEAREST_RUPEE`, `BOX_EXCHANGE_TXN_PCT`, `BOX_IPFT_PER_CRORE`, `BOX_IPFT_PCT`, `BOX_SEBI_PCT`,
  `BOX_STAMP_DUTY_BUY_PCT`, `BOX_GST_PCT`, `BOX_STT_TYPE`, `BOX_CHARGE_RATE_VERSION`.
  `migration-fixtures/box/charges.json` stays as the rate-card golden check.
- `box/math.ts`: `strikeStepOf`, `selectStrikeWindow`, `shouldRecentreWindow` (Synthetic strike windows).
- `box/brokerContext.ts` provider types: market data (`BoxRestQuote`, `BoxMarketDataProvider`) and margins
  (`BoxMarginOrder`, `BoxMarginSource`, `BoxBasketMargin`, `BoxMarginProvider`), used by the registry and Synthetic.
- `box/types.ts`: `OrderSide` only.
- The dedicated second market-data lane (called the "Box lane" in Node). Synthetic uses it. With Box gone it holds no
  Box tokens and Box is never running, so Synthetic's extra budget is `BOX_DEDICATED_MARKET_FEED (default true) ?
  BOX_MAX_SUBSCRIBED_TOKENS (default 2200) : 0` when `SYNTH_SHARE_BOX_BUDGET` is on, as in Node with Box idle.
  Those env names and defaults stay.
- Broker switching: the Box exposure checks always report idle (no scanner, positions, working orders, in-flight
  work, residuals, unknown orders or unresolved intents). Response shapes that carry these fields keep them with
  idle values, so the broker panel and Synthetic pages work unchanged.

Frontend (`../Cal_Spread`): remove the Box page, Box tab and Box API calls (approved 2026-11-02).
Shared pieces the other pages import: `BrokerBadge` (from
`BoxBroker.tsx`, used by BrokerPanel, Synthetic, SynthPositions), plus `ChargeOriginTag`/`BoxChargeOrigin` (used by
ExecutionBreakdown).

## Phases
0. Inventory → `inventory/`: `api.md`, `storage.md`, `brokers.md` (done); `analytics.md` (Fair Value, Synthetic,
   captures, NIFTY analytics, calendar trades); `tests.md` (non-Box suites only). `box-core.md` and `box-exec.md`
   are kept only as reference for the shared pieces above (quotes, local charges, strike-window math).
1. Skeleton: Go module, config, Chi server, PostgreSQL migrations + store, PG cache, auth/rate limit, lifecycle.
2. Pure core: rate card, strike-window math, quote store, Synthetic math, Fair Value math. Checked against
   `charges.json` and the ported unit suites.
3. Persistence: the non-Box Mongo collections and the analytics Redis keys as PostgreSQL tables (same JSON fields).
4. Brokers + market data: Kite and Dhan REST/auth/instruments/margins/binary feeds, registry, subscriptions, lanes,
   SSE sessions. No order placement.
5. Analytics/captures: chain snapshots, frames, history/backfill, EOD/hourly capture, calendar trades.
6. Synthetic and Fair Value services + routes.
7. Outer shell: every non-Box route, schedulers, shutdown; frontend contract/integration checks; fresh local PostgreSQL
   setup; docs/CI; remove the Node backend. No import tool or EC2 deployment is needed (user decision 2026-11-02).
8. Final deep review, full backend/frontend checks, final handoff and verified commits pushed to both mains.

## Completion criteria
- Every non-Box route in the inventory is served by Go with the same contract; `/api/box/*` is gone.
- The frontend build/tests and real-Go integration workflows pass, with the Box UI/API removed and shared functionality preserved.
- `charges.json` and all ported non-Box suites pass with `-race` on a real local PostgreSQL.
- No MongoDB/Redis code or dependency, and no order-placement code, remains; local setup is reproducible.
- Fresh local PostgreSQL setup is documented and verified; CI checks the Go backend with PostgreSQL.
- The old Node backend is retired, retained goldens have pinned provenance, and tests do not silently skip checks after its removal.
- Both intended repository changes are committed and pushed to main with successful verification recorded.

## Decisions (phase 0 closed 2026-10-27)
Inventories: `api.md`, `storage.md`, `brokers.md`, `analytics.md`, `tests.md` are the Go reference.
`box-core.md` / `box-exec.md` are kept only for the shared pieces (quote store, rate card, strike-window math).

Storage and config
- One env: `DATABASE_URL`. It replaces `MONGODB_URI`, `TRADE_LOG_URI`, `NSE_FNO_ARCHIVE_URI`, `NSE_FNO_CURRENT_URI`,
  `NSE_FNO_SPREAD_URI`, `BOX_MONGODB_URI`, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Every old gate
  (`isDbEnabled`, trade log, nse_fno, archive) becomes "pool is ready". Gate messages say `DATABASE_URL`.
- Without `DATABASE_URL` the service still starts with the same memory-only fallbacks as Node (routes that need the
  database answer `dbEnabled:false` / 503 as before). Local dev uses a local PostgreSQL, never a remote one.
- Fair Value `status.storage` becomes `"postgres"` or `"memory_only"` (shown as plain text in the UI). The
  memory-only error text names PostgreSQL instead of MongoDB.
- Caches: one `kv_cache(key, field, value json, expires_at)` table covers all 6 analytics Redis key patterns, with a
  purge job for expired rows. The in-process `BoundedTtlCache` stays in process (it bounds memory per request).
  Write-behind cadence is unchanged (per capture minute, after backfills, every 60 s); the one intended change is a
  final flush during shutdown. No Redis data import: caches rebuild from the Kite backfill.
- Ids: real ObjectId-style 24-hex ids. Anything else, a 12-character string included, is 400 as in Node (corrected
  2026-10-29: the pinned bson 6.10.4 accepts only 24 hex characters; the earlier "12 characters → 404" came from an
  outdated Mongoose comment). Timestamps: ms precision, JSON always has 3 fraction digits. Numbers: `double precision`.
  Text used for ordering: `COLLATE "C"`. Pass-through blobs (Fair Value snapshot) use `json` to keep key order.
- `stock_futures`: one table with a `source` column (`archive`, `current`) so the 2026-01-01 routing stays exact.
- `spread-stats` returns the stored fields plus `_id`; `__v` is omitted (the frontend reads neither).
- Legacy rows: `broker` is nullable and read as `zerodha` when null (as `brokerOf` does).
- Calendar-trade races are ported as-is (no new guards).
- Single process. Admin sessions: memory + table restored at boot, as in Node.

HTTP
- Same paths, methods, statuses and bodies for every non-Box route. Unknown routes: 404 with Express's text body.
  Malformed JSON: 400, body over 100 kB: 413. `POST /api/access/verify` without a JSON body is treated as an empty
  body instead of Node's accidental 500.
- CORS: `FRONTEND_URL` origin, methods `GET,POST,PATCH,DELETE,OPTIONS`. PATCH is added: the frontend already sends
  `PATCH /api/fair-value/config` and Node's list made that fail cross-origin.
- Copied as in Node: tick SSE is not filtered per client; calendar writes accept the trade role; the rate limiter keys
  on `X-Forwarded-For` first; calendar margin/charges/ladder call Kite even when Dhan is active; history caches are
  keyed by symbol only; analytics routes ignore `:underlying`; `login_date` reports today's IST day; `POST /api/rf`
  coercions; the Fair Value guard returns 403 for unknown `/api/fair-value/*` paths.

Box removal
- Box has no routes, tables, caches, env or tests in Go. The broker registry reports idle Box exposure (see Scope).
- Frontend: remove the Box page/tab/API; retain shared pieces that the other pages need (approved 2026-11-02; see Scope).

## Go package layout (module `github.com/Prakash2571/Cal_Spread_Backend`)
Done (shared, tested): `internal/config`, `jsx`, `db` (+ `migrations/`), `dbtest`, `kv`, `store`, `httpx`, `auth`,
`brokers` (ID type), `lifecycle`, `server`, `ratecard`, `boundedcache`, `quotes` (book store + strike window),
`market` (Instrument, Tick, DepthLevel, RestQuote, MarketDataProvider, MarginOrder, BasketMargin, MarginProvider).

Ported in parallel, one owner per package:
| Package | Node source | Migration file |
|---|---|---|
| `internal/fairvalue` | `src/fairValue/*` | `0003_fair_value.sql` |
| `internal/synthetic` | `src/synthetic/*` | `0004_synthetic.sql` |
| `internal/kite`, `internal/hub` | `kite.ts`, `ticker.ts`, `brokers/zerodha/feed.ts`, `hub.ts` | none |
| `internal/brokers/dhan` | `brokers/dhan/*` (no orders, no charges) | none |
| `internal/captures` | `eodCapture.ts`, `hourlyCapture.ts`, `yahoo.ts` | `0005_captures.sql` |
Then: `internal/brokers` registry/subscriptions/lanes/providers/routes + `internal/marketdata` (sessions, SSE);
then `internal/analytics`, `internal/calendar` (`0002_calendar_trades.sql`) and `cmd/server`.

Rules for every package: depend only on the shared packages above (read-only) and stdlib, chi, pgx, gorilla/websocket,
x/sync; take collaborators as small interfaces or func fields in a `Deps` struct; build/vet/test only your own
packages (`scratch/go-migration/check.sh go test -race ./internal/<pkg>/...`); DB tests use `dbtest.New`;
Node reference values come from running the original TypeScript with Node 22 type stripping (see
`internal/ratecard/testdata/gen_leg_cases.mjs`).
