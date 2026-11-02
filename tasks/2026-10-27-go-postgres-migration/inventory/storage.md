# Storage inventory: MongoDB + Upstash Redis → PostgreSQL

Task `2026-10-27-go-postgres-migration`, phase 0. Source read at backend HEAD `1ea1d95` (read-only).
All `file:line` references are relative to `src/` unless stated. No database was contacted, so
data volumes are unknown (only code-level bounds are given). Nothing here was executed.

## 0. Counts at a glance

| Store | Count |
|---|---|
| Mongo connections | 6: default (`MONGODB_URI`), ledger (`TRADE_LOG_URI`→default), box (`BOX_MONGODB_URI`→default), nse_fno archive / current / spread |
| Mongo collections (distinct names) | **27** (`stock_futures` exists in two physical DBs → 28 physical) |
| Collections with partial-unique / idempotency / lease semantics | 7 (`box_trades`, `box_order_intents`, `box_execution_attempts`, `box_instrument_reservations`, `box_reservation_fences`, `synth_trades`, `box_pnl_day_states`) |
| TTL indexes | 3 (`box_calibration_samples` 14 d, `box_instrument_reservations` expireAfterSeconds 0, `fair_value_snapshots` expireAfterSeconds 0) |
| Multi-document transactions / sessions / change streams / `aggregate()` | **none** (grep for `startSession`, `withTransaction`, `.watch(`, `.aggregate(` returns nothing). Every guarantee is single-document atomicity + unique indexes. |
| Aggregation-pipeline updates | 3 sites: `box/repository.ts:656`, `:1590`, `:1879` |
| Redis key patterns | **9** live (+1 legacy v1 pattern that ages out) — all `calspread:`-prefixed, Upstash REST pipeline only |
| Filesystem persistence | **none** (no `fs` import anywhere in `src/`) |

## 1. Cross-cutting facts the Go/PG port must reproduce

1. **ObjectId ids.** Every non-`_id: String` collection uses Mongo ObjectIds, generated client-side for
   `box_trades` (`allocateBoxTradeId`, `box/repository.ts:445`), `synth_trades` (`synthetic/repository.ts:134`)
   and the fixed recovery attempt id. API ids are `_id.toString()` (24 lowercase hex). Validation uses
   `mongoose.isValidObjectId` (`db.ts:519`, `box/repository.ts:301`): in Mongoose 8 this also accepts any
   **12-character string** (cast to the ObjectId of its bytes), so `/api/trades/abcdefghijkl/close` is a 404, not
   a 400. Go must generate real ObjectIds (4-byte time + random + counter) so ids stay 24-hex and roughly
   time-ordered.
2. **`__v`.** Mongoose `versionKey` is on by default (writes `__v: 0` on `create`/`insertMany`). Disabled only for
   `box_trading_session`, `box_instrument_reservations`, `box_reservation_fences`. `__v` is **never used for
   optimistic concurrency** (the only `doc.save()` is `index.ts:3157`, which modifies no array, so Mongoose adds no
   version filter). It matters only where raw documents reach the API (item 4).
3. **`.lean()` does not apply schema defaults.** Almost every read is lean, so legacy documents missing a path come
   back *without* it and serializers use `?? null` / legacy helpers (`brokerOf`, `directionOf`). An importer must
   either materialise defaults (`broker='zerodha'`, `direction='LONG_BOX'`, `projection_version=0`, …) or keep the
   columns nullable and keep the same fallbacks in Go.
4. **Raw Mongo documents returned verbatim by the API** (field order = stored order, includes `_id` as hex string,
   probably `__v`, Dates as ISO):
   - `GET /api/spread-stats/:symbol` → whole `spread_summary` doc (`index.ts:2384-2393`).
   - `GET /api/box/events` → `box_trade_events` docs (`box/routes.ts:443-447`, `box/repository.ts:2536`).
   - `GET /api/box/execution-attempts` → `box_execution_attempts` docs (`box/routes.ts:432-436`, `box/repository.ts:1687`).
   Everything else is serialized field-by-field (`serializeTrade` `index.ts:2689`, `serializeBoxTrade`
   `box/serialize.ts:16`, synth `fromRecord` `synthetic/repository.ts:101`).
5. **Dates**: BSON Date = ms precision; JSON output is JS `toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`, always 3
   fraction digits). PG `timestamptz` is µs → truncate to ms on write, format with exactly 3 digits on output.
   `box_daily_pnl.opened_at/closed_at/updated_at` are **strings**, not Dates. `stock_futures.trading_date/expiry`,
   `spread_daily.*_date/*_expiry` are Dates at UTC midnight.
6. **Numbers** are JS doubles. Use `double precision` (not `numeric`) so `round2`, sums and JSON number formatting
   match; counters (`seq`, `generation`, `attempts`, `projection_version`) can be `bigint`.
7. **String ordering.** Mongo compares strings bytewise. Keyset pagination (`$gt` on `trade_id`, `_id`), the day-proof
   SHA-256 (rows hashed in `trade_id` order, `box/pnlSnapshot.ts:146-161`) and day-string comparisons depend on it.
   Every PG text column used in `ORDER BY`/range/keyset must be `COLLATE "C"`.
8. **`null` vs missing.** Mongo `{field: null}` matches null **and** missing (`region: null` in
   `box/repository.ts:2779`, `broker_order_id: null` in `:1586`). PG equivalent: `IS NOT DISTINCT FROM` / `IS NULL`.
   Mongo `$lte`/`$in` never match a missing field.
9. **JSON key order.** `jsonb` normalises key order; `json` preserves text. Opaque Mixed blobs that are passed
   straight to the API (`entry_execution`, `entry_legging`, `exit_execution`, `scanner_config_snapshot`, leg depth,
   `legging`, `residual_exposure`, event `execution`, fair-value `snapshot`, cached JSON values) keep their key order
   in Node. Store them as `json` (or decode into typed Go structs) if byte-identical output is required.
10. **Duplicate-key handling.** Code checks Mongo error `11000` (`box/repository.ts:67`, `synthetic/repository.ts:31`,
    `box/reservations/mongoStore.ts:66`) and, for reservations, *which* index fired (`keyPattern`, `mongoStore.ts:181-192`).
    PG: SQLSTATE `23505` + `ConstraintName`.
11. **Enablement gates** (`db.ts:325-517`): `isDbEnabled()` (default conn readyState 1), `isBoxConnectionReady()`,
    `isTradeLogEnabled()`, `isNseFnoDbEnabled()` (current **and** spread), `isArchiveDbEnabled()`. Many routes return
    `dbEnabled:false` / 503 `"…(set MONGODB_URI)."` from these; Fair Value reports `storage: "mongodb"|"memory_only"`
    (`fairValue/engine.ts:567`); box closed-history reports `source: "memory"|"redis"|"mongo"|"none"`
    (`box/engine.ts:5112`, `box/routes.ts:416`); the durable reservation tier is named `"mongo"`
    (`box/reservations/mongoStore.ts:212`, appears in fail-closed messages). These literals are API contract.

---

## 2. MongoDB collections

Notation: `field: Type = default [req] {enum}`. "best-effort" = errors logged and swallowed.

### 2.1 Default connection (`MONGODB_URI`)

#### `trades` — calendar spreads (`db.ts:162-193`, model `Trade`)
- Fields: `symbol: String [req, index]`, `name: String = ""`, `is_index: Boolean = false`, `lot_size: Number [req]`,
  `buy`/`sell: {token: Number [req], expiry: String [req] (YYYY-MM-DD), entry: Number [req]}` (`_id:false`, `db.ts:117`),
  `status: String = "open" {open,closed} [index]`, `opened_at: Date = now`, `closed_at: Date = null`,
  `close_pnl` (gross), `buy_close`, `sell_close`, `margin`, `entry_value`, `exit_value`, `total_charges`, `net_pnl`:
  `Number = null`; `entry_charges`, `exit_charges`, `est_exit_charges`: `TradeCharges = null`; `__v`.
- `TradeCharges` (`db.ts:145`): `legs: [LegCharges] = []`, `value, brokerage, stt, exchange_txn, sebi, stamp_duty,
  gst, total: Number = 0`, `source = "kite" {kite,kite_estimate}`, `at: Date = now`.
- `LegCharges` (`db.ts:126`): `side {BUY,SELL} [req]`, `tradingsymbol = ""`, `quantity, price, value, brokerage, stt = 0`,
  `stt_type = ""`, `exchange_txn, sebi, stamp_duty, gst, total = 0`.
- Indexes: `_id`; `{symbol:1}`; `{status:1}` (autoIndex).
- Operations:
  - `index.ts:2754` `findOne({symbol, status:"open"}).lean()` → 409 if found. **Not atomic** (no unique index):
    two concurrent POSTs can both open.
  - `index.ts:2924` `Trade.create(payload)`.
  - `index.ts:2958` `find().sort({opened_at:-1}).limit(200).lean()` (GET `/api/trades`).
  - `index.ts:2982` `findById` (hydrated) → mutate → `index.ts:3157 trade.save()` = `updateOne({_id},{$set: modified})`.
    **No `status:"open"` guard**: two concurrent closes both write; last wins; two `trade_log` exit rows.
  - `index.ts:3200` `findById` then `index.ts:3209 deleteOne({_id})` only if `status==="closed"` (read-then-delete).

#### `kite_session` — single doc `_id:"current"` (`db.ts:538-578`)
- `_id: String`, `access_token: String [req]`, `user_id = ""`, `user_name = ""`, `login_date: String [req]` (IST day),
  `updated_at: Date = now`.
- `saveKiteSession` `updateOne({_id:"current"},{$set:{…,updated_at}},{upsert})` (`db.ts:554`) ← `persistKiteSession`
  `index.ts:5189` (from `/api/session` `:1422`, `/callback` `:1452`), fire-and-forget.
- `loadKiteSession` `findById` (`db.ts:569`) ← `restoreSessionOnStartup` `index.ts:5208`: used only if
  `login_date === istDayKey()`, else cleared.
- `clearKiteSession` `deleteOne` (`db.ts:575`) ← ticker token rejected `index.ts:109`, `/api/logout` `:1465`,
  Kite-auth error path `:3354`.

#### `dhan_session` — single doc `_id:"current"` (`db.ts:614-668`)
- `access_token [req]`, `dhan_client_id = ""`, `dhan_client_name = ""`, `dhan_client_ucc = ""`,
  `given_power_of_attorney = false`, `expiry_time: Number = null` (epoch ms; null = unknown, never "no expiry"),
  `login_at: Date = now`, `login_date: String [req]`, `updated_at: Date = now`.
- save `updateOne` upsert `$set` incl. `login_at=updated_at=now` (`db.ts:634`) ← `brokers/registry.ts:653`.
- load `findById` (`db.ts:659`) ← boot restore `brokers/registry.ts:572` (expired → clear) and **per request** in
  `brokers/routes.ts:204, 347, 398`.
- clear (`db.ts:665`) ← `brokers/registry.ts:575, 729, 748`.

#### `active_broker` — single doc `_id:"current"` (`db.ts:698-757`)
- `broker: String [req]`, `selected_at: Date = now`, `selected_by = "admin"`, `generation: Number` (**no default on
  purpose**: `$setOnInsert` default + `$inc` on the same path is rejected by Mongo).
- `saveActiveBroker` `findOneAndUpdate({_id:"current"},{$set:{broker,selected_by,selected_at},$inc:{generation:1}},
  {upsert, returnDocument:"after"})` (`db.ts:728`) ← broker switch `brokers/registry.ts:1691`.
  **Semantic: durable monotonic generation counter**; stamped into reservations; new value returned atomically.
- `loadActiveBroker` (`db.ts:748`) missing/non-finite generation ⇒ 1 ← `brokers/registry.ts:557`.

#### `admin_sessions` (`db.ts:768-808`)
- `_id: String` (bearer token), `role {full,trade} [req]`, `expiry: Number [req]` (epoch ms; 24 h `index.ts:249`).
- save `updateOne` upsert `$set` ← `/api/admin/verify` `index.ts:1320`, `/api/access/verify` `:1369` (fire-and-forget).
- `loadAdminSessions` `find({expiry:{$gt:Date.now()}})` (`db.ts:798`) ← boot only `index.ts:5470`.
- delete (`db.ts:804`) ← only when an expired token is presented (`index.ts:265`).
- **No TTL index**; expired rows accumulate unless their token is replayed. Memory map is the read path.

#### `app_settings` (`db.ts:821-851`)
- `_id: String` (only `"rf_rate"`), `value: Number [req]`, `updated_at: Date = now`.
- `saveRfRate` upsert (`db.ts:836`) ← `POST /api/rf` `index.ts:1216`; `loadRfRate` (`db.ts:846`) ← boot `index.ts:5483`.

#### `hourlyprices` (`db.ts:868-885`, model `HourlyPrice`, pluralised name)
- `symbol, date (YYYY-MM-DD IST), time (HH:MM), month (YYYY-MM): String [req]`,
  `current_month_close, mid_month_close, spread: Number [req]`, `far_month_close: Number = null`.
- Unique `{symbol:1, date:1, time:1}`.
- `hourlyCapture.ts:276` `updateOne({symbol,date,time},{$set:doc},{upsert})` — drained from an **unbounded** in-memory
  queue (`pendingWrites` `:30`), 100 ms spacing, stop on first failure, retried next cycle. **Not gated** by
  `isDbEnabled()`: without a connection Mongoose buffers (10 s default) then throws.
- `hourlyCapture.ts:427` `find({symbol, date:{$gte:windowStart}},{date:1,time:1,_id:0})` — gap detection
  (`HOURLY_BACKFILL_LOOKBACK_DAYS`, default 7).
- `hourlyCapture.ts:688` `countDocuments({date:today, symbol:{$in}})` — day review (`DAY_REVIEW_TIME`, 16:30).
- Volume: ≤ symbols × 7 slots/day (`hourlyCapture.ts:83-106`). No reader outside capture.

#### `fair_value_settings` (`fairValue/store.ts:15-17`)
- `_id: "current"`, `version: String`, `config: Mixed`, `updated_at: Date`. `bufferCommands:false`, every op `maxTimeMS(3000)`.
- `loadConfig` `findById` (`:30`); `saveConfig` `updateOne` upsert `$set {config,version,updated_at}` (`:35`), throws when disabled.

#### `fair_value_snapshots` (`fairValue/store.ts:18-24`)
- `_id: String` (= `snapshot.id`), `underlying [index]`, `input_snapshot_id`, `model_version`, `config_version`,
  `at: Date [index]`, `expires_at: Date` (**TTL, `expires:0`**), `snapshot: Mixed`, `input: Mixed`
  (InputSnapshot minus `listing_catalog`).
- `append` (`:39-53`): `updateOne({_id},{$setOnInsert:{…, expires_at: at + retentionDays}},{upsert})` — **idempotent
  insert-once**; then prune `find({underlying}).sort({at:-1}).skip(limit).select(_id).limit(500)` → `deleteMany({_id:{$in}})`.
- `history` (`:54-67`): `find({underlying, expires_at:{$gt:now}}).sort({at:-1}).limit(n)` with a sub-document projection
  (`snapshot.id … snapshot.slices.smile.calibration.observation_count`).
- `snapshot` (`:69-73`): `findOne({_id, underlying, expires_at:{$gt:now}})`.
- Reads filter `expires_at > now` logically; TTL only garbage-collects. Writer: `fairValue/engine.ts:441-461`
  (one per underlying per `history_interval_ms`, queue `max_queue` 8 drop-oldest, retry-front on failure).

### 2.2 Ledger connection (`TRADE_LOG_URI`, else default)

#### `trade_log` (`db.ts:259-322`)
- `trade_id: String [req, index]`, `symbol [req, index]`, `name = ""`, `is_index = false`, `lot_size = 0`,
  `event {entry,exit} [req]`, `at: Date = now [index]`, `legs: [LogLeg] = []`, `value = 0`,
  `charges: {brokerage, stt, exchange_txn, sebi, stamp_duty, gst, total = 0}`,
  `source = "kite" {kite,kite_estimate,unpriced}`, `margin`, `gross_pnl`, `total_charges`, `net_pnl = null`.
- `LogLeg` (`db.ts:259`): `LegCharges` fields + `token = 0`, `exchange = ""`, `expiry = ""`, `raw: Mixed = null`.
- Only op: `appendTradeLog` → `TradeLog.create` (`db.ts:336-345`), best-effort, ← `index.ts:2927` (entry), `:3160` (exit).
  Append-only, never read or deleted by the app (survives trade deletion by design).

### 2.3 nse_fno connections

#### `stock_futures` — archive (`NSE_FNO_ARCHIVE_URI`, read-only) and current (`NSE_FNO_CURRENT_URI`) (`db.ts:908-931`)
- `trading_date: Date [req]`, `symbol [req]`, `instrument = "FUTSTK"`, `expiry: Date [req]`,
  `open, high, low, close: Number [req]`, `settle_price, contracts, value_lakh, open_interest, change_in_oi = 0`.
- Unique `{symbol, trading_date, expiry}`.
- `eodCapture.ts:107` current `updateOne(key,{$set},{upsert})` drained from an in-memory queue (50 ms spacing).
- `eodCapture.ts:280` current `findOne().sort({trading_date:-1})` (backfill start).
- `eodCapture.ts:409` current `find({trading_date:{$in}})` for dates ≥ `2026-01-01`; `:422` **archive**
  `find({trading_date:{$in}})` for dates < cutoff (archive holds data to 2025-08-31; Sep–Dec 2025 intentionally empty).

#### `spread_daily` (`NSE_FNO_SPREAD_URI`, `db.ts:943-956`)
- `symbol [req]`, `trading_date, near_expiry, mid_expiry: Date [req]`, `near_close, mid_close, spread: Number [req]`.
- Unique `{symbol, trading_date}`.
- `eodCapture.ts:137` upsert `$set`; `:500` full scan `find({}, {symbol,spread,trading_date})`;
  `:713` `findOne().sort({trading_date:-1}).select(trading_date)`.

#### `spread_summary` (`db.ts:974-992`)
- `symbol [req]`, `observations`, `first_date`, `last_date` (Dates), `mean_spread`, `max_spread`, `min_spread`,
  `mean_deviation`, `max_abs_spread`, `std_dev_spread`, `percentile_95`, `mean_reversion_probability` — all `[req]`.
- Unique `{symbol}`.
- `eodCapture.ts:626` `bulkWrite([{replaceOne:{filter:{symbol}, replacement, upsert:true}}…])` (ordered, default);
  `:630` `deleteMany({symbol:{$nin:active}})`; `:724` `findOne().sort({last_date:-1})`.
- `index.ts:2387` `findOne({symbol}).lean()` returned **raw** (item 1.4).

### 2.4 Box connection (`BOX_MONGODB_URI`, else default)

#### `box_trades` (`box/model.ts:240-424`)
- Top level: `execution_mode = "paper_touch" {paper_touch,paper_latency,paper_legging,live}`,
  `broker = "zerodha" {BROKER_IDS} [index]`, `underlying [req, index]`, `name = ""`, `is_index = false`,
  `expiry: String [req]`, `direction = "LONG_BOX" {LONG_BOX,SHORT_BOX}`, `lower_strike, upper_strike, lot_size,
  quantity, box_width, entry_box_cost, entry_gross_edge, entry_net_edge: Number [req]`,
  `status = "open" {open,closed,error} [index]`, `legs: [BoxLeg] = []`, `margin = null`, `safety_buffer = 0`,
  `entry_charges, estimated_exit_charges, exit_charges: BoxCharges = null`, `expected_net_profit,
  entry_execution_cost = null`, `charge_origin = "local" {local,kite,local_verified,dhan,dhan_estimate}`,
  `charge_rate_version: String = null`, `entry_charge_reconciliation, exit_charge_reconciliation:
  ChargeReconciliation = null`, `entry_execution, entry_legging, exit_execution, exit_legging, residual_exposure,
  remaining_qty_by_role, exit_attempts: Mixed = null`, `position_state = null {BOX,PARTIALLY_EXITED,RECOVERY,FLAT,null}`,
  `cumulative_exit_charges = null`, `opened_at: Date = now`, `current_remaining_edge, current_captured_edge,
  current_captured_pct, exit_box_value, gross_pnl, total_charges, net_pnl, realised_net_pnl = null`,
  `closed_at: Date = null`, `close_idempotency_key: String = null`,
  `exit_reason = null {EDGE_CONVERGED,PROFIT_CAPTURE,MANUAL,EXPIRY_SAFETY,null}`, `exit_blocked_reason = null`,
  `expiry_safety = false`, `scanner_config_snapshot: ScannerConfig = {}`, `error: String = null`, `__v`.
- `BoxLeg` (`:142-178`): `role {k1_ce,k2_ce,k2_pe,k1_pe} [req]`, `token, strike, entry_price [req]`,
  `tradingsymbol [req]`, `exchange = "NFO"`, `instrument_type {CE,PE} [req]`, `side {BUY,SELL} [req]`,
  `entry_bid, entry_bid_qty, entry_ask, entry_ask_qty = 0`, `entry_quote_at: Date = null`, `entry_depth: Depth = null`,
  `detected_price, entry_slippage, exit_price, exit_bid, exit_bid_qty, exit_ask, exit_ask_qty = null`,
  `exit_quote_at = null`, `exit_depth = null`, `exit_detected_price, exit_slippage = null`.
- `Depth` (`:50-65`): `bids, asks: [{price, qty, orders = 0}] = []`.
- `BoxCharges` (`:91-117`): LegCharges-shaped `legs`, heads `= 0`, `source`, `computed_by = "local"
  {local,kite,local_verified,dhan,dhan_estimate}`, `broker = "zerodha"`, `at: Date = now`.
- `ChargeReconciliation` (`:119-139`): `status = "pending" {pending,verified,failed}`, `local_total, reconciled_total,
  abs_diff, pct_diff = null`, `head_diffs: Mixed = null`, `at: Date = null`, `error = null`.
- `ScannerConfig` (`:181-237`, all defaulted): `min_gross_edge, min_net_edge, min_expected_net_profit, safety_buffer,
  expected_entry_slippage, expected_exit_slippage, quote_max_age_ms, convergence_floor, convergence_pct,
  min_exit_net_pnl, profit_capture_pct, min_captured_pct, simulated_decision_ms, simulated_latency_ms = 0`,
  `strikes_each_side = 3`, `execution_mode = "paper_touch"`, and `= null`: `live_trading_enabled (Bool),
  live_reconcile_interval_ms, live_feed_reconnect_warmup_ms, live_max_open_boxes, live_max_concurrent_executions,
  live_max_residual_legs, live_daily_loss_limit, live_reject_limit, live_consecutive_failure_limit,
  live_max_open_leg_quantity, live_max_gross_open_leg_quantity, live_http_timeout_ms, live_ack_timeout_ms,
  live_working_timeout_ms, live_partial_timeout_ms, live_cancel_timeout_ms, live_max_modifications,
  live_max_chase_ticks, live_broker_min_interval_ms, live_broker_order_min_interval_ms, live_entry_submit_concurrency,
  live_max_box_capital_rupees, one_active_box_per_underlying (Bool), session_max_completed_trades,
  leg_max_chase_ticks, unwind_max_chase_ticks, queue_model (String), queue_liquidity_haircut_pct,
  max_cross_leg_exchange_dispersion_ms`. Mongoose strict mode drops unknown keys in typed subdocs.
- Indexes: **`box_open_unique_pair_dir` unique `{underlying, expiry, lower_strike, upper_strike, direction}`
  partial `{status:"open"}`** (`:383-390`; older deployments may still carry `box_open_unique_pair` without
  `direction`); `{opened_at:-1}` (`:392`); `{status:1, closed_at:-1}` (`:408`); `{broker}`, `{underlying}`, `{status}`.
- `LIST_EXCLUDE_AUDIT` projection (`box/repository.ts:363-379`): drops `entry_execution, entry_legging,
  exit_execution, exit_legging, exit_attempts, legs.entry_depth, legs.exit_depth`. Closed queries use
  `status $in ["closed","error"]` (`:347`) so the index serves the sort.
- Operations (`box/repository.ts`):

| Line | Function | Operation | Semantics relied on |
|---|---|---|---|
| 318 | loadOpenBoxTrades | `find({status:"open"}).sort({opened_at:-1})` | boot adoption |
| 325 | loadBoxTrades(300) | `find().sort({opened_at:-1}).limit` full docs | `GET /api/box/trades` |
| 385 | loadClosedBoxTrades(limit≤1000, since?) | `find({status∈closed/error, closed_at≥since}).select(EXCLUDE).sort({closed_at:-1,opened_at:-1}).limit` | history |
| 399 | findBoxTradeById | `findById` | |
| 423 | filterExistingBoxTradeIds | chunks of 200, `find({_id:{$in}},{_id:1})`; throws if DB off | archive source check |
| 449 | insertBoxTrade | `create` with optional pre-allocated `_id`; on 11000 → return existing by `_id` if preallocated else `null` | **partial unique = atomic duplicate-open guard**; pre-allocated id makes retry idempotent |
| 472 | setBoxTradeMargin | `updateOne({_id},{$set:{margin}})` best-effort | |
| 482 | updateBoxTradeLive | `updateOne({_id},{$set:fields})` best-effort, every `BOX_PERSIST_INTERVAL_MS` | |
| 507 | setBoxChargeReconciliation | `$set {<phase>_charge_reconciliation, "<phase>_charges.computed_by":"local_verified", charge_origin}` | nested-path set |
| 535 | closeBoxTrade | `findOneAndUpdate({_id,status:"open"},{$set},{new:true})`; miss + key → `findOne({_id,status:"closed",close_idempotency_key})` | **conditional update = exactly-once close; idempotent replay** |
| 568 | applyBoxPartialExit | `updateOne({_id,status:"open"},{$set:{remaining_qty_by_role,position_state,cumulative_exit_charges,exit_attempts,residual_exposure,exit_legging[,current_remaining_edge]}})` → matched>0 | single-doc atomic partial exit |
| 621 | deleteBoxTrade | `deleteOne({_id, execution_mode:{$ne:"live"}})` | **guard in filter**, never delete live |
| 697 | invalidArchivedTradeIds | `find({_id:{$in}},{_id:1})` | |
| 1117 | reconcile | `BoxTrade.exists({_id})` | |
| 1249 | loadBoxTradesClosedBetween | closed∈, `closed_at ∈ [from,to)`, EXCLUDE, sort | |
| 1270 | loadBoxMarginIntervalsSince | `find({$or:[{status:"open"},{closed_at≥since}]},{opened_at,closed_at,margin})` | |
| 1291 | applyBoxReconciledProjection | `updateOne({_id,status:"open"},{$set:{remaining_qty_by_role,position_state}})` | |
| 1304 | markBoxTradeRecovery | `updateOne({_id,status:"open"},{$set:{position_state:"RECOVERY",error,exit_blocked_reason}})` | |
| 1313 | markBoxTradeError | `$set {error}` best-effort | |
| 2040 | loadBoxLiveRiskSeed | `find({closed_at≥since}).select(realised_net_pnl,net_pnl)` | |
| 2144 | loadBoxTradesClosedSince | closed∈, `closed_at≥since`, EXCLUDE, `sort({closed_at:-1})`, **unlimited** | closed-today tier 3 |
| 2696 | loadFlatBoxTradeIds | `find({_id:{$in}, status:"closed"},{_id:1})` | session reconciliation |

- Retry: `box/engine.ts:3495` `insertWithRetry` 3 attempts, 250/500 ms; then `retainOwnedExecution` re-tries every
  15 s (`:471, 3519-3541`). `box/positionMonitor.ts:135, 387-396, 996` keeps in-memory retry queues for final/partial
  persists (lost on restart; exposure stays recoverable from order intents).

#### `box_trade_events` (`box/model.ts:428-492`) — append-only ledger
- `event: String [req, index]`, `at: Date = now [index]`, `trade_id: String = null [index]`,
  `candidate_key = "" [index]`, `underlying = ""`, `expiry = ""`, `direction = "LONG_BOX"`,
  `lower_strike, upper_strike, lot_size, quantity = 0`, `execution_mode = "paper_touch"`,
  `broker = "zerodha" [index]`, `box_width, box_cost, gross_edge, entry_charges_total, exit_charges_total,
  safety_buffer, net_edge, expected_net_profit, execution_cost, gross_pnl, net_pnl, remaining_edge, captured_edge,
  captured_pct = null`, `execution: Mixed = null`, `legs: [{role [req], side [req], token = 0, tradingsymbol = "",
  price = null, bid, bid_qty, ask, ask_qty = 0, quote_at: Date = null, age_ms = null}] = []`, `reason = null`,
  `detail = null`, `__v`.
- `appendBoxEvent` `create` best-effort (`box/repository.ts:1366-1408`); `loadBoxEvents` `find().sort({at:-1}).limit(≤1000, def 200)`
  (`:2536`) → raw API. No retention.

#### `box_order_intents` (`box/model.ts:503-600`) — recovery backbone
- `client_order_id [req]`, `broker_order_id = null`, `broker_mode {paper,live} [req]`, `broker = "zerodha" [index]`,
  `broker_correlation_id = null` (≤30 chars for Dhan), `trade_id = null`, `attempt_id [req]`, `role {k1_ce…} [req]`,
  `purpose {ENTRY,EXIT,EMERGENCY_RESIDUAL,PROTECTIVE_CANCEL} [req]`, `phase {entry,exit,unwind} [req]`,
  `exchange, tradingsymbol [req]`, `token, quantity, reference_price, tick_size, max_chase_ticks, limit_price [req]`,
  `side [req]`, `state = "CREATED" {CREATED,SUBMITTING,ACKNOWLEDGED,OPEN,PARTIALLY_FILLED,COMPLETE,CANCEL_REQUESTED,
  CANCELLED,REJECTED,UNKNOWN,RECONCILIATION_REQUIRED}`, `filled_quantity = 0`, `previous_filled_quantity = null`,
  `average_price, broker_tag, reject_family, reject_reason = null`, `created_at, updated_at: Date [req]`,
  `terminal_at = null`, `audit: [{audit_id [req], at: Date [req], from_state = null, to_state [req],
  broker_order_id = null, message = null, fill_identity = null, payload: Mixed = null}] = []`, `__v`.
- Indexes: `box_order_intent_client_order_id` unique; `box_order_intent_broker_order_id` unique sparse partial
  `{broker_order_id:{$type:"string"}}`; `{trade_id:1,created_at:-1}`; `{attempt_id:1,created_at:-1}`;
  `{state:1,updated_at:1}`; `{broker}`.
- Operations (`box/repository.ts`):
  - `:1427` create: `findOneAndUpdate({client_order_id},{$setOnInsert:intent},{upsert,new})` then
    `assertIntentImmutableMatch` over `IMMUTABLE_INTENT_FIELDS` (`:1649-1665`) → throws on reuse with different
    values. **Unique index = idempotent intent creation before any broker call.** (Concurrent first upserts can raise
    E11000 in Mongo; not retried.)
  - `:1443` `findOne({client_order_id})`; `:1450` `findOne({broker_order_id})`.
  - `:1457` `find({state:{$in:NONTERMINAL}}).sort({updated_at:1})` unbounded; throws if DB off.
  - `:1482` `countDocuments({broker_mode:"live", state∈NONTERMINAL, broker filter})` — `"zerodha"` also matches
    missing/null broker (legacy). Broker-switch guard.
  - `:1495` `find({broker_mode:"live"}).sort({created_at:-1})` unbounded (crash-recovery exposure).
  - `:1569-1640` **CAS update**: filter `client_order_id` + `{$or:[{broker_order_id:null},{broker_order_id:X}]}`
    (when patch has a broker id) + `state ∈ INTENT_STATE_PREDECESSORS[patch.state]` (`:1506-1533`) + optional
    `state ∈ expectedStates` + `filled_quantity ≤ patch.filled_quantity` (non-strict); pipeline `$set`: every patch key
    via `$literal`, `previous_filled_quantity = ifNull($filled_quantity,0)` (**pre-image from the same write**),
    `audit` appended only if `audit_id` not already present (exactly-once audit). Miss ⇒ re-read, report
    `applied:false` with zero-width transition. Patchable keys: `broker_order_id, state, filled_quantity,
    average_price, broker_tag, reject_family, reject_reason, updated_at, terminal_at` (`box/types.ts:1250`).
  - `:2058` risk seed `countDocuments({state:"REJECTED", updated_at≥since, $nor:[{filled_quantity:0,
    broker_order_id:null, audit:{$elemMatch:{to_state:"REJECTED","payload.origin":"local_pre_submit_refusal",
    "payload.no_broker_post":true}}}]})`.
  - `:2073` `find({updated_at≥since}).select(state,filled_quantity,broker_order_id,audit).sort({updated_at:-1})`.
- Tested by `tests/integration/mongoOrderIntentCas.test.mjs` (exactly-once CAS, stale refusal, pre-image, delta sum,
  regression refusal, predecessor guard, broker-id fence) — port these to PG.

#### `box_execution_attempts` (`box/model.ts:610-720`)
- `candidate_key = "" [index]`, `direction = "LONG_BOX"`, `underlying = "" [index]`, `name = ""`, `is_index = false`,
  `expiry = ""`, `lower_strike, upper_strike, lot_size, quantity = 0`, `execution_mode = "paper_legging"`,
  `broker = "zerodha" [index]`, `leg_execution_mode = null`, `detected_at: Date = now`, `resolved_at: Date = now [index]`,
  `detected_gross_edge, expected_net_profit = null`, `filled_leg_count = 0`, `failed_legs: [String] = []`,
  `failure_reason, failure_detail = null`, `abort_after_fill = false`, `outcome_class = null`,
  `required_expected_net_profit = null`, `charge_rate_version = null`, `legging: Mixed = null`,
  `partial_entry_charges, unwind_charges = null`, `flatten_charges = 0`, `flatten_charge_day: String = null`,
  `flatten_charges_for_day = 0`, `projection_version = 0`, `residual_projection_identity = null`,
  `applied_flatten_applications: [String] = []` (ring of ≤ 32, `box/executionAttemptProjection.ts:9`),
  `gross_abort_pnl, net_abort_pnl = null`, `residual_exposure: Mixed = null`, `resolved = true [index]`, `__v`.
- Indexes: `{resolved_at:-1}`; `{resolved:1,resolved_at:-1}`; `box_execution_attempt_flatten_charge_day
  {flatten_charge_day:1, flatten_charges_for_day:-1}`; **`box_single_unresolved_crash_recovery` unique `{candidate_key}`
  partial `{candidate_key:"boot-recovery", resolved:false}`** (also created + read back explicitly,
  `box/repository.ts:249-283`, validated `:112-131`, gated by `BoxRecoveryPersistenceGate` `:152-233`: fail closed,
  re-verify after reconnect, 30 s backoff).
- Operations (`box/repository.ts`):
  - `:1673` `create` best-effort → id. `:1687` `find().sort({resolved_at:-1}).limit(≤500, def 100)` → raw API.
  - `:1709` `find({resolved:false [, candidate_key:{$ne:"boot-recovery"} unless gate ready]}).sort({resolved_at:-1}).limit(200)`.
  - `:1752-1825` `ensureBoxRecoveryExecutionAttempt`: `findOne({candidate_key:"boot-recovery",resolved:false}).sort({resolved_at:1})`
    → else `findOneAndUpdate({_id:<fixed>},{$setOnInsert:{…}},{upsert,new,setDefaultsOnInsert})` → on 11000 re-read
    the winner. **Partial unique = at most one unresolved crash-recovery row across workers.**
  - `:1863-1943` **projection CAS**: filter `_id` + `applied_flatten_applications ≠ application_id` +
    `(projection_version = expected` [or missing/null when expected 0]`)` + `(residual_projection_identity = expected`
    [or null identity **and** `residual_exposure` BSON-equal to expected when expected 0]`)`; pipeline `$set`:
    `residual_exposure` literal, `resolved = (len==0)`, `projection_version += 1`, identity, ring append + `$slice -32`,
    `flatten_charges = $round(old + delta, 2)`, day bucket reset/accumulate with `$round`. Miss ⇒ `findById` →
    `already_applied` / `stale` / `not_found`. **Version + application-id = exactly-once charge accounting.**
    Note Mongo `$round` is round-half-to-even.
  - `:2043/2048/2053` risk seed: `find({flatten_charge_day:day}).sort({flatten_charges_for_day:-1}).limit(200)`,
    `find({resolved_at≥since}).sort({resolved_at:-1}).limit(200)`, `find({resolved:false}).sort({resolved_at:-1}).limit(200)`;
    a full page ⇒ `incomplete:true` (entry stays closed).

#### `box_daily_pnl` (`box/model.ts:750-790`) — nightly reporting archive
- `day: String [req, index]`, `trade_id: String [req]` (ObjectId hex, or `"__summary__"`), `underlying = ""`,
  `direction = "LONG_BOX"` (plain String), `lower_strike, upper_strike = 0`, `expiry = ""`,
  `status = "open"` (open|closed|summary), `gross_pnl, net_pnl, realisable_net_pnl, realised_net_pnl = null`,
  `opened_at, closed_at, updated_at: String = null` (ISO strings), `summary: Mixed = null`, `archived_at: Date = now`.
- Indexes: `box_daily_pnl_day_trade` unique `{day, trade_id}` (**idempotent re-drain**); `box_daily_pnl_trade_day`
  `{trade_id, day}`; `{day}`.
- Operations (`box/repository.ts`): `:755` keyset `find({day, trade_id:{$ne:"__summary__",$gt:after}}).sort({trade_id:1}).limit(200)`;
  `:786` summary upsert `updateOne({day,trade_id:"__summary__"},{$set:{…}},{upsert})`; `:959` `deleteOne({day,trade_id})`;
  `:978` `find({trade_id}).select(day).limit(200)` loop; `:1063` `findOne({day,trade_id:"__summary__"}).select(summary)`;
  `:1146` orphan scan keyset on **`_id` (ObjectId) asc**, `.select(_id,trade_id).limit(200)`;
  `:1236` `deleteMany({day,trade_id:{$in}})`; `:2497` row upsert `$set {...doc, archived_at}`; `:2506` self-clean delete;
  `:2516/2529` `find({day})`.
- Every row write is wrapped by `runBoxPnlDayMutation` (`:712-737`): invalidate day state → mutate → invalidate again;
  `upsertBoxDailyPnl` (`:2485-2511`) does source-exists/fence check → write → re-check → self-clean (`:2163-2176`).

#### `box_pnl_deletions` (`box/model.ts:796-831`) — permanent deletion fences
- `_id: String` (trade id), `status = "pending" {pending,complete}`, `candidate_days: [String] = []`, `attempts = 0`,
  `created_at, updated_at: Date = now`, `completed_at = null`, `last_error = null`, `__v`. Index `{status:1,_id:1}`.
- `:638` prepare `updateOne({_id},{$setOnInsert:{status:"pending",attempts:0,created_at,completed_at:null,candidate_days:[]},
  $set:{updated_at,last_error:null}},{upsert})` (does **not** reset a completed fence); `:656` pipeline update
  `candidate_days = $slice($setUnion(ifNull(candidate_days,[]), candidates), -64)` (`$setUnion` order unspecified);
  `:675` cancel `deleteOne({_id,status:"pending"})`; `:700` `find({_id:{$in}, status:"complete"})`;
  `:817` `updateOne({_id,status:"pending"},{$set:{updated_at,last_error},$inc:{attempts:1}})`; `:930` `findById`;
  `:992` complete `$set {status:"complete",candidate_days,updated_at,completed_at,last_error:null}, $inc attempts`;
  `:1007` on error `$set status:"pending"` unconditionally + `$inc attempts`; `:1101` keyset
  `find({status:"pending",_id:{$gt}}).sort({_id:1}).limit(200)`.
- **Semantic:** cross-process tombstone so a late writer cannot resurrect a deleted trade's P&L. Never pruned.
  Engine flow `box/engine.ts:3300-3366`: prepare fence → guarded source delete → cancel fence if delete refused →
  evict caches → `deleteBoxDailyPnlForTrade`.

#### `box_pnl_day_states` (`box/model.ts:839-881`) — completion proofs
- `_id: String` (IST day), `complete = false`, `snapshot_version = null` (2 for v2), `row_count = null`,
  `content_sha256 = null` (64 hex), `needs_reproof = false`, `expected_trade_ids: [String]` (legacy v1, default
  `undefined`, only `$unset`), `updated_at: Date = now`, `__v`.
- Indexes `{snapshot_version,complete,_id}`, `{snapshot_version,needs_reproof,_id}`.
- **CAS on the proof triple** (`{_id, snapshot_version, row_count, content_sha256}`): `:868` mark-retry, `:902` publish
  (`$set` + `$unset expected_trade_ids`, must match 1), `:2384` legacy finalize (must match 1). Others: `:2187`
  mark-incomplete upsert (`$set` + `$setOnInsert:{_id}`), `:2370/2395` legacy (`expected_trade_ids:{$exists:true}`),
  `:2431` mark-complete upsert, `findById` at `:878, 938, 1042, 2379, 2451`, keyset scans `:1171` (v2, `complete` or
  `needs_reproof`, no legacy list) and `:1194` (legacy list present).

#### `box_settings` (`box/model.ts:903-913`)
- `_id: String` ∈ {`min_expected_net_profit`, `safety_buffer`} (`box/config.ts:874-877`), `value: Number [req]`,
  `updated_at: Date = now`.
- `:2557` `find()` (boot, `box/engine.ts:1238`; env value is the default); `:2586` `bulkWrite` updateOne-upsert,
  `ordered:false`, **throws** (`box/engine.ts:1318`).

#### `box_calibration_samples` (`box/model.ts:926-970`)
- `broker, kind, profile, bucket, stage, session: String [req]`, `value_ms: Number [req]` (round2),
  `region: String = null`, `observed_at: Date [req]`, `__v`.
- Indexes `box_calibration_region_recent {region:1, observed_at:-1}`; **`box_calibration_ttl {observed_at:1}
  expireAfterSeconds 1209600` (14 d)**.
- `:2726` `insertMany(…, {ordered:false})` from `CalibrationPersistenceBuffer` (`box/calibrationPersistence.ts`;
  `box/engine.ts:573-578`; batch `BOX_LIVE_TIMING_BATCH_SIZE`, flush `BOX_LIVE_TIMING_FLUSH_MS`, buffer cap
  `max(1000, batch×20)` drop-oldest; enabled by `BOX_LIVE_TIMING_PERSIST_ENABLED`).
- `:2763` `find({region, observed_at≥now−maxAge}).sort({observed_at:1}).limit(50000)` — ascending + limit keeps the
  **oldest** 50 k in the window (`box/engine.ts:4031`). `region:null` also matches missing.

#### `box_trading_session` (`box/model.ts:988-1026`) — single doc `_id:"current"`, `versionKey:false`
- `session_id = ""`, `armed_at: Date = null`, `armed_by = null`, `max_completed_trades = 0`,
  `established_trade_ids, completed_trade_ids: [String] = []`, `aborted_attempts = 0`, `arm_count = 0`,
  `updated_at: Date = null`. **No TTL by design** (a consumed one-shot budget must stay consumed).
- `:2629` `findById` → `{ok:false}` on read error (distinct from "never armed"); `:2666` `updateOne` upsert `$set`
  whole record, **throws** (caller rolls memory back). **Blind overwrite, no CAS** (last writer wins across processes).

#### `box_instrument_reservations` (`box/reservations/mongoStore.ts:60-145`) — cross-process instrument leases
- `_id: String` (owner id, prefix `deployment:instance:p<pid>:<boot>:`), `deployment, broker: String [req]`,
  `generation: Number [req]`, `mode = ""`, `keys: [String] [req]` (canonical contract keys, deduped),
  `sides: [{key [req], side = ""}] = []`, `fence: Number [req]`, `instance = ""`,
  `created_at, expires_at, renewed_at: Date [req]` (authority clock). `versionKey:false`, `autoIndex:false`.
- Indexes created **and read back** in `ensureReady` (`:243-298`, fail closed if missing/not unique):
  **`box_reservation_unique_contract` unique multikey `{deployment:1, keys:1}`** (= no contract key in two live
  documents — the whole safety property), `box_reservation_ttl {expires_at:1} expireAfterSeconds 0` (GC only),
  `box_reservation_scope {deployment, broker, generation}`.
- Operations: `:344` insert (native `insertOne`; dup on `_id` ⇒ `owner_exists`, on `keys` ⇒ `key_conflict`,
  unknown dup ⇒ `key_conflict`); `:372` `deleteMany({deployment, expires_at≤notAfter[, keys:{$in}]})`;
  `:386` `find({deployment, keys:{$in}, expires_at>now})`; `:399` `findById`; `:405` `deleteOne({_id[,fence]})`;
  `:420` renew `findOneAndUpdate({_id, expires_at>now[, fence, broker, generation]},{$set:{expires_at,renewed_at}},
  {returnDocument:"after"})`; `:451` `deleteMany({_id:{$regex:"^"+escaped}})`; `:459` `countDocuments({deployment,
  expires_at>now})`.
- Algorithm (`box/reservations/durable.ts:329-480`): fence → insert → owner_exists: delete own + reinsert →
  key_conflict: `deleteExpired(keys, authNow − grace)` then reinsert once → still conflicting: name holders; treat
  "only my own row" as success (retried-write case). Holder valid while `now < expiresAt − grace`; challenger may reclaim
  once `now ≥ expiresAt + grace` (default grace 250 ms). Startup `reapExpired` (`reservations/index.ts:96`). TTL default
  `BOX_INSTRUMENT_LOCK_TTL_MS` 5000, renew every ttl/3. Tests: `tests/box/mongoReservationIntegration.test.mjs` MI1–MI9.

#### `box_reservation_fences` (`box/reservations/mongoStore.ts:61, 114-127`)
- `_id: String` (`"__clock__"` or `"fence:<deployment>"`), `seq = 0`, `at: Date = null`. `versionKey:false`.
- `:304` `serverTimeMs`: `findOneAndUpdate({_id:"__clock__"},{$currentDate:{at:true}},{upsert,after})` — **server clock
  is the single time authority** (offset re-measured every 15 s, blocking if > 150 s stale; `durable.ts:281-325`).
- `:325` `nextFence`: `findOneAndUpdate({_id:"fence:"+deployment},{$inc:{seq:1}},{upsert,after})` — **strictly
  monotonic fencing token**; unused tokens recycled locally (≤ 8).

#### `synth_trades` (`synthetic/model.ts:49-145`, `autoIndex:false`)
- `status = "open" {open,closed,deleted}` (soft delete), `key: String [req]`, `broker = "zerodha"`,
  `execution_mode = "paper_touch"`, `order_type = "LIMIT"`, `underlying, expiry: String [req]`,
  `strike, lot_size, quantity [req]`, `name = ""`, `is_index = false`, `atm_strike, atm_offset = 0`,
  `direction {CONVERSION,REVERSAL} [req]`, `opened_at: Date [req]`, `opened_day: String [req]`,
  `legs: [SynthLeg] = []`, `entry_future_price, entry_synthetic_price, entry_lock_per_unit, entry_edge,
  entry_gross_edge, entry_charges, estimated_exit_charges, entry_net_edge, expected_net_profit: Number [req]`,
  `entry_carry_per_unit, min_expected_net_profit, safety_buffer, expected_slippage, rf_pct = 0`,
  `option_rate_version, futures_rate_version = ""`, `closed_at: Date = null`, `closed_day = null`,
  `exit_reason = null {SYNTH_EXIT_REASONS,null}`, `gross_pnl, exit_charges, total_charges, net_pnl = null`,
  `exit_note = null`, `margin = null`, `margin_source = null`, `margin_hedge_benefit = null`, `margin_at: Date = null`,
  `margin_error = null`, `deleted_at: Date = null`, `deleted_from = null {open,closed,null}`, `delete_reason = null`,
  `deleted_by = null`, `__v` (stripped on read, `synthetic/repository.ts:112`).
- `SynthLeg`: `role {fut,ce,pe} [req]`, `side [req]`, `instrument_type {FUT,CE,PE} [req]`, `strike = 0`,
  `tradingsymbol [req]`, `token = 0`, `entry_price [req]`, `entry_bid, entry_ask = 0`, `entry_bid_qty, entry_ask_qty,
  entry_qty_at_touch, entry_age_ms = null`, `entry_depth = null`, `exit_price, exit_bid, exit_ask, exit_bid_qty,
  exit_ask_qty, exit_qty_at_touch, exit_age_ms = null`, `exit_depth = null`; depth level `{price, qty = 0}`.
- Indexes created + verified in `ensureReady` (`synthetic/repository.ts:144-166`): **`synth_open_one_per_underlying`
  unique `{underlying}` partial `{status:"open"}`** (entries refused until verified), `synth_status_closed_at
  {status:1, closed_at:-1}`, `synth_closed_day {closed_day:1}`.
- Ops: `:169` `create` → 11000 ⇒ `"duplicate"`; `:179` close `updateOne({_id,status:"open"},{$set: fields minus margin*})`
  matched==1; `:194` setMargin `updateOne({_id,status:{$ne:"deleted"}},{$set: margin*})`; `:211` soft delete
  `updateOne({_id,status:from},{$set:{status:"deleted",…}})`; `:232` `findById`; `:240` `find({status:"open"}).sort({opened_at:1})`;
  `:276` `find({status:"closed"[, closed_day≥since]}).sort({closed_at:-1}).limit`.
- **Column ownership**: margin fields written only by `setMargin`, never by close (avoids lost update).

#### `synth_settings` (`synthetic/model.ts:150-170`, `autoIndex:false`)
- `_id: String` ∈ {`min_expected_net_profit`, `safety_buffer`, `max_open_positions`} (`synthetic/config.ts:195`),
  `value: Number [req]`, `updated_at: Date = now`. Ops: `find()` (`synthetic/repository.ts:248`), `bulkWrite`
  upsert all keys `ordered:false`, throws (`:262`).

---

## 3. Redis (Upstash REST) — `redis.ts`

Transport: `POST {UPSTASH_REDIS_REST_URL}/pipeline` with Bearer token; body chunked < 800 000 bytes (`redis.ts:34, 99-138`);
8 s timeout; 3 consecutive failures ⇒ muted 60 s (`:28-31, 160-176`). **Never throws**: disabled/muted/failed ⇒ `null`.
Per-command errors ⇒ `null` for that slot. Values are `JSON.stringify` strings; corrupt JSON is dropped on read (`:284-292`).
Every key is prefixed `calspread:` (`:37`). Commands used: `GET`, `SET … EX`, `DEL` (helper unused by callers),
`HGETALL`, `HSET` (multi-field), `HDEL`, `EXPIRE`, `PING`. No lists, sets, sorted sets, streams, `INCR` or `MULTI`
(pipelines are **not** transactional — partial application is possible and handled).

### 3.1 Analytics caches (`index.ts:493-1043`), memory is the read path, Redis is write-through for warm boot

| Key (after prefix) | Type | Field → value | TTL (s) | Writers | Readers |
|---|---|---|---|---|---|
| `oiframe:v2:{1m,5m,15m,1h}` | hash | bucket-end ms → `OiAggPoint {t,totalCe,totalPe,straddle,spot,wLo?,wHi?,partial?:1}` (`index.ts:384-420`) | retention+1 d: 1m 172800, 5m 345600, 15m/1h 691200 (`:366-376, 747`) | `appendOiFrameLive` `:4171-4176` (last 2 closed buckets + HDEL pruned), `mergeOiFrame` `:4229`, `coarsenOiFrame` `:4383` via `persistWholeFrame` `:4316` | `warmLoadFromRedis` `:967` |
| `futoiframe:{1m,5m,15m,1h}` | hash | bucket ms → `FutOiPoint {t, legs:[{expiry,oi,ltp}]}` | same as above | `appendFutOiFrameLive` `:4905-4909`, `mergeFutOiFrame` `:4941`, `coarsenFutOiFrame` `:4420` | `:975` |
| `futcontracts` | string | `FutContract[] {token,tradingsymbol,expiry,lot_size}` | 691200, refreshed only when the set changes (`:4850-4868`) | `rememberFutContracts` | `:986` |
| `prevclose` | string | `OptionPrevClose {forDay,closedOn,expiry,complete,tokens:{token:{oi,ltp}}}` (`:340-350`) | 172800 (`:3783`) | `persistPrevClose` `:3779`, flushed immediately | `:994`, used only if `forDay == today` |
| `chainsnap:min:{IST day}` | hash | minute-end ms → `ChainSnapshot {t,expiry,tokens:{token:[oi,ltp]}}` (~12 KB) | 172800 | `recordChainSnapshot` `:826` | `:1006` (today only) |
| `chainsnap:hour:{IST day}` | hash | hour-end ms → `ChainSnapshot` (overwritten each minute ⇒ hour close) | 432000 | `:833` | `:1015` days 0..4 |
| `oiframe:{f}` (v1, legacy) | hash | — | ages out | not written | not read |

Write path: `queueHashField`/`queueHashDrop`/`queuePlainWrite` (`:594-625`) buffer per key (field-keyed, so re-writes
collapse; a re-add cancels a pending HDEL); `flushRedisWrites` (`:631-698`) sends one pipeline per capture minute
(`:5133`), after backfills (`:3413, :5167, :5183`) and every 60 s regardless of market hours (`:703-709`).
`EXPIRE` is sent at most every 15 min per key, and the stamp is set only after a successful send (`:580, 654-679`).
Failed batch ⇒ requeued with precedence to newer writes; backlog capped per key (3000 frame fields / 60 snapshot fields,
oldest dropped) (`:576-577, 712-745`). Forming (future-stamped) buckets are never persisted (`:4163-4175, 4306-4329`).
Warm load (`:953-1043`, boot, before capture starts `:5505-5511`): `PING` fails ⇒ skip; merge so live/backfilled values win
(`:922-951`); partial load is fine (gap-aware Kite backfill fills the rest). **Shutdown does not flush** the buffer
(`index.ts:5632-5656`).

### 3.2 Box caches

| Key | Type | Field → value | TTL | Writers | Readers / fallback |
|---|---|---|---|---|---|
| `box:pnl:day:{day}` (`box/pnlCache.ts:25`) | hash | trade_id → `BoxDailyPnlRow`; `__summary__` → `BoxDailyPnlSummary` (`box/pnlSnapshot.ts:61-110`) | `BOX_PNL_CACHE_TTL_SEC` 259200, EXPIRE on every write | `writeSnapshot` `:121` every `BOX_PNL_CACHE_INTERVAL_MS` (HSET rows+summary, HDEL vanished ids); `evictTrade*` `:193, 221` | `readDay` `:156` (archiver `collectDay`, `box/pnlArchive.ts:259`) — miss on a past day ⇒ only a complete durable proof is used, else throws |
| `box:pnl:days` (`:26`) | hash | day → `DayIndexEntry {day,archived,updated_at,archived_at,row_count,expires_at?}` | same TTL on writes; per-field `expires_at` pruned logically (`:81-101, 168-181`) without refreshing the key TTL | `writeSnapshot`, `markArchived` `:230` | `listDays` (throws `"Box P&L Redis day index is unavailable"` when HGETALL fails); `pendingDays` ⇒ startup verify |
| `box:trades:closed:{day}` (`box/closedCache.ts:30`) | hash | trade id → lite `SerializedBoxTrade` (audit blobs + leg depth nulled, `:42-50`) | `BOX_CLOSED_CACHE_TTL_SEC` 259200 | close `box/engine.ts:2941`, boot seed `:5093`, re-mirror `:5165`; HDEL on delete `:3353` | `getClosedToday` `box/engine.ts:5111-5170`: memory → Redis (trusted only if ≥ tally) → Mongo `loadBoxTradesClosedSince`; returns `source` |

Enablement: `BOX_PNL_CACHE_ENABLED` (default **false**) and `BOX_CLOSED_CACHE_ENABLED` (default **true**), each AND
`isRedisEnabled()`. Unavailable ⇒ closed cache falls back to Mongo; pnl cache write returns false, archiver retries
(`requestFullReconcile` 30 s / 5 min, `box/pnlArchive.ts:42, 146-174`).

### 3.3 When Redis is unavailable
Unconfigured: queue functions no-op, warm load skipped, box caches report disabled — pure memory + Mongo. Unreachable:
writes stay buffered (bounded), warm load degrades to Kite backfill, closed-today reads fall back to Mongo, archiver
marks retry. Nothing on a trading path depends on Redis (`box/LIVE_EXECUTION.md:71`).

---

## 4. In-process caches and other persistence

| Cache | Location | Bound / TTL | Share across processes? |
|---|---|---|---|
| Admin sessions `Map<token,{expiry,role}>` | `index.ts:247` | 24 h; persisted write-through to `admin_sessions`, loaded at boot only | **Yes if >1 process** (today a token minted in worker A is unknown to B until restart). Single process ⇒ memory + PG write-through is equivalent. |
| Kite access token | `kite.ts` (memory) + `kite_session` | same IST day | durable row already shared |
| Dhan token + meta | `brokers/registry.ts` (memory) + `dhan_session` | `expiry_time` | durable row already shared |
| Active broker + generation | `brokers/registry.ts` + `active_broker` | — | generation **must** be durable (reservations) |
| OI frames, fut frames, prev close, chain snapshots | `index.ts:421-492, 779-781, 351` | retention per frame | memory read path; PG write-through replaces Redis |
| Box closed-today list, P&L summary | `box/engine.ts`, `box/pnlArchive.ts` | per IST day | memory; PG cache replaces Redis |
| Instrument list | `index.ts:300` (1 h), `brokers/instrumentProvider.ts:28` (1 h) | — | in-memory |
| Dividend yields | `index.ts:1047` | 24 h | in-memory |
| Kite historical responses | `index.ts:1696, 1789, 1887` (day-keyed), `:1947` (60 s), `:2004` (5 min) | — | in-memory |
| `POST /api/quotes` responses | `marketDataRoutes.ts:70` `BoundedTtlCache` | 4 s, 256 entries | in-memory |
| Fill ledgers | `box/orderManager.ts:512` | 512 / 1 h | in-memory (per-order dedupe; durable truth is `box_order_intents`) |
| Order timing traces | `box/executionTiming.ts:411` | 512 / 10 min | in-memory |
| Broker timing ring buffers | `box/brokerTimingStore.ts` | fixed rings, no I/O | in-memory |
| Fair Value independent cache, retained inputs, snapshot history | `fairValue/engine.ts:93-96`, `fairValue/history.ts` | 64 / 60 s; 8 / surface age; 16 MiB, 20 underlyings, per-underlying limit, retention days | in-memory (durable copy in `fair_value_snapshots`) |
| Rate-limit buckets | `ratelimit.ts` | fixed window per IP | per process (shared only if multi-process) |
| Market-data SSE sessions | `marketDataSession.ts:74` | 5 min idle | per process |
| Box charge cache | `BOX_CHARGE_CACHE_TTL_MS` 30 s | — | in-memory |
| Box in-process reservations tier | `box/reservations/inProcess.ts` | lock TTL | in-memory first tier, chained before durable |
| Persist retry queues | `box/engine.ts` `pendingPersists`, `box/positionMonitor.ts:135` | unbounded | in-memory (lost on restart) |

No filesystem persistence exists.

---

## 5. Configuration that affects storage

| Env | Default | Effect today | Note for PG |
|---|---|---|---|
| `MONGODB_URI` | unset | default conn; unset ⇒ trades/sessions/settings/fair-value durable store disabled; box falls back to it | replace (one PG URL?) — see §8 |
| `TRADE_LOG_URI` | unset | ledger conn, else default | |
| `BOX_MONGODB_URI` | unset | box + synth conn, else default; both unset ⇒ box refuses to start | |
| `NSE_FNO_ARCHIVE_URI`, `NSE_FNO_CURRENT_URI`, `NSE_FNO_SPREAD_URI` | unset | per-DB gates; EOD needs current+spread | |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | unset | analytics + box caches | removed |
| Hard-coded Redis | timeout 8 s, 3 fails ⇒ 60 s mute, 800 kB body, slack 24 h, EXPIRE every 15 min, caps 3000/60, retry 60 s | `redis.ts:28-37`, `index.ts:518-584, 703` | |
| Mongoose defaults | no pool/timeout config in code (driver default pool 100, `bufferCommands` on, 10 s buffer timeout); Fair Value: `bufferCommands:false`, `maxTimeMS 3000` | | PG pool size/statement timeout are new knobs |
| `BOX_PNL_CACHE_ENABLED` / `_INTERVAL_MS` / `_TTL_SEC` | false / 30000 / 259200 | `box/config.ts:1134-1136` | |
| `BOX_PNL_ARCHIVE_HOUR` / `BOX_PNL_VERIFY_HOURS` / `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS` | 21 / [22,23] / 50 | `:1137-1139` | |
| `BOX_CLOSED_CACHE_ENABLED` / `_TTL_SEC` | true / 259200 | `:1141-1142` | |
| `BOX_PERSIST_INTERVAL_MS` | 30000 | live-figure persist cadence `:1119` | |
| `BOX_LIVE_TIMING_PERSIST_ENABLED` / `_BATCH_SIZE` / `_FLUSH_MS` | false / 50 (1–10000) / 15000 (250–600000) | `:1003-1005` | |
| `BOX_PAPER_CALIBRATION_MAX_AGE_MS` | 3 d (60 s–30 d) | read window `:991-996` | |
| `BOX_DEPLOYMENT_REGION` → `BOX_EXECUTION_CALIBRATION_REGION` | null | calibration `region` `:1012-1015` | |
| `BOX_DURABLE_RESERVATIONS_ENABLED` / `BOX_RESERVATION_REQUIRE_DURABLE` | true / false | `:936-941` | |
| `BOX_INSTRUMENT_LOCK_TTL_MS` / `BOX_RESERVATION_RENEW_INTERVAL_MS` / `BOX_RESERVATION_CLOCK_SKEW_GRACE_MS` / `BOX_RESERVATION_UNCERTAIN_HOLD_MAX_MS` / `BOX_RESERVATION_OWNERSHIP_MARGIN_MS` | 5000 (250–60000) / max(250, ttl/3) / 250 (0–5000) / 60000 / max(250, `BOX_EXECUTION_MAX_WAIT_MS` 1500) | `:930-964` | |
| `CALSPREAD_DEPLOYMENT_ID` → `NODE_ENV` → `"development"`; `CALSPREAD_INSTANCE_ID` → hostname; `NODE_APP_INSTANCE` | | reservation namespace / owner prefix (`box/reservations/identity.ts:60-110`) | |
| `BOX_SESSION_MAX_COMPLETED_TRADES` | 0 (unlimited) | needs durable session `:1052` | |
| `HOURLY_BACKFILL_LOOKBACK_DAYS` / `DAY_REVIEW_TIME` | 7 / 16:30 | `hourlyCapture.ts:413, 733` | |
| `FAIR_VALUE_CONFIG_JSON` (`history_limit` 100 [1–500], `history_interval_ms` 60000, `history_retention_days` 7 [1–30], `history_memory_max_bytes` 16 MiB, `max_queue` 8), `FAIR_VALUE_ENABLED`, `FAIR_VALUE_DISABLED` | | `fairValue/config.ts:20-40, 101-106`; saved config in `fair_value_settings` overrides at boot | |
| Test only: `BOX_TEST_MONGODB_URI`, `BOX_REQUIRE_MONGODB` (CI uses `mongo:7.0.14`, `.github/workflows/ci.yml:173-191`) | | | replace with a PG test URL |

---

## 6. Retention, pruning and volumes

| Data | Mechanism | Where |
|---|---|---|
| `box_calibration_samples` | TTL 14 d; reads bounded 50 k rows / max-age window | `box/model.ts:948-951`, `box/repository.ts:2779-2785` |
| `box_instrument_reservations` | logical expiry; reclaim on conflict + startup reap; TTL index GC (~60 s monitor) | `mongoStore.ts:251-253`, `durable.ts:393-401, 765-783`, `reservations/index.ts:96` |
| `fair_value_snapshots` | per-underlying keep newest `history_limit` (prune ≤ 500 per append) + TTL at `at + retention_days` | `fairValue/store.ts:44-53` |
| `fair_value` memory history | count / days / bytes / 20 underlyings | `fairValue/history.ts:7-30` |
| Redis frames / snapshots | in-memory prune by retention + HDEL; key TTL = retention + 1 d | `index.ts:4166-4176, 841-848, 518, 747` |
| `box:pnl:*`, `box:trades:closed:*` | key TTL 3 d; day-index per-field expiry | `box/pnlCache.ts:81-101` |
| `box_pnl_deletions` | **never pruned** (permanent fences, by design) | `box/model.ts:796-803` |
| `box_trade_events`, `trade_log`, `box_order_intents`, `box_execution_attempts`, `box_trades`, `trades`, `box_daily_pnl`, `synth_trades` (soft delete), `hourlyprices`, `stock_futures`, `spread_daily` | **no retention** | — |
| `admin_sessions` | expired rows only removed when the token is presented again | `index.ts:257-268` |
| `spread_summary` | fully recomputed 16:00 IST; symbols absent from `spread_daily` deleted | `eodCapture.ts:523, 626-630, 679-685` (scheduler `:650`, startup catch-up `:708`) |
| Calendar trades UI list | latest 200 | `index.ts:2958-2961` |
| Volumes | unknown (no DB access). Code hints: box trade docs "tens of KB" with audit blobs vs ~2 KB lite (`box/repository.ts:350-362`); chain snapshot ~12 KB × 375/day; frame point ~100 B; hourly ≤ symbols × 7/day | — |

---

## 7. Semantics that must survive (riskiest first)

1. **Durable instrument leases** (`box_instrument_reservations` + fences): multikey unique = all-or-none claim of 4
   contracts; server clock; monotonic fence; owner/fence-pinned delete and renew; expired-only reclaim. PG has no
   multikey unique: use a child key table with PK `(deployment, key)` inserted in the same transaction as the parent.
2. **Order-intent CAS** (`box_order_intents`): guarded single-statement update with pre-image and exactly-once audit;
   idempotent create by `client_order_id`; partial-unique `broker_order_id`.
3. **Execution-attempt projection CAS**: version + identity + application-id ring; `$round` half-even; legacy
   missing-field equivalence; BSON-equality on `residual_exposure` for version 0.
4. **Partial unique indexes as atomic guards**: one open box per strike pair+direction, one open synth per underlying,
   one unresolved crash-recovery attempt. Boot code reads indexes back and **fails closed** if missing/incompatible.
5. **Conditional updates as exactly-once transitions**: box close (+ idempotency key replay), partial exit, recovery
   marking, guarded delete (`execution_mode != live`), synth close/soft delete, day-state proof CAS.
6. **Durable monotonic counters**: `active_broker.generation` (`$inc` with returned value), fence `seq`.
7. **Idempotent upserts**: `box_daily_pnl {day,trade_id}`, `hourlyprices`, `stock_futures`, `spread_daily`,
   `spread_summary` (replace), `fair_value_snapshots` (insert-once), settings, single-doc sessions.
8. **Deletion fences + proofs** for the P&L archive (cross-process tombstones, SHA-256 over `C`-ordered rows).
9. **Non-atomic legacy paths to preserve or consciously fix**: calendar duplicate-open check, calendar close `save()`,
   calendar delete read-then-delete, trading-session blind overwrite.

---

## 8. Ambiguities and open decisions

1. **Env mapping.** Six Mongo URIs + Upstash collapse into PostgreSQL. Which env name(s) replace them, and how do the
   per-connection gates (`dbEnabled`, box "refuses to start", trade-log fallback, nse_fno current+spread) and messages
   such as `"(set MONGODB_URI)"` behave? Suggest one `DATABASE_URL` and all gates = "pool ready", keeping response
   shapes; the literal error text needs a decision.
2. **Storage-name literals in API responses**: `source:"redis"|"mongo"`, `storage:"mongodb"`, tier name `"mongo"`.
   Keep verbatim for compatibility, or rename? Frontend usage not checked here.
3. **Cache-enabled flags flip**: today `cacheEnabled`/`closed_cache_enabled` are false without Upstash. With PG as the
   cache they become true whenever PG is up (closed cache defaults on). Confirm that is acceptable.
4. **`_id`/`__v` in raw-doc routes**: whether `__v` is present on `spread_summary` (bulkWrite `replaceOne` path) and on
   upserted recovery attempts needs a real export sample; the Go output must match it.
5. **Key order** of pass-through blobs: decide `json` vs `jsonb` (§1.9) — `jsonb` changes byte order but not meaning.
6. **ObjectId 12-character-string acceptance** (§1.1): replicate or tighten to 24-hex (changes 404→400 for odd ids).
7. **`$round` half-even** in the projection CAS vs JS `Math.round` / PG `round(numeric)` (half away from zero).
8. **`$setUnion` + `$slice -64`** keeps an unspecified 64 in Mongo; PG must pick an order (sorted ⇒ latest 64).
9. **stock_futures split** by the 2026-01-01 cutoff: one table with a `source` column (archive/current) keeps the
   routing exact; a plain merge would need a duplicate policy if both DBs overlap.
10. **Multi-process**: only reservations + fence tokens, order intents, execution attempts and the P&L deletion
    fences/day proofs are designed cross-process. Admin
    sessions, rate limits and SSE sessions are per process. Is the Go service single-process? If not, admin token
    lookup should fall back to PG on a memory miss.
11. **Legacy shapes in an import**: missing `broker`, `direction`, `projection_version`, `resolved`, legacy v1
    `expected_trade_ids`, legacy index `box_open_unique_pair`. Decide materialise-defaults vs nullable.
12. **Calendar trade races** (§7.9): port as-is ("port, don't redesign") or add `WHERE status='open'` / partial unique.
    Adding guards changes nothing except under a race.
13. **Redis data import**: caches are reconstructible from Kite; `prevclose` costs ~240 Kite calls. Probably no import.
14. **Redis flush on shutdown** is not done today; PG write-through could flush in the shutdown step (behaviour change).
15. hourlyprices writes are not DB-gated and queue without bound — keep or gate.

---

## 9. Proposed PostgreSQL mapping

Conventions for all tables: names = collection names; text keys `COLLATE "C"`; `timestamptz` (ms-truncated);
`double precision` for JS numbers; ObjectId ids as `text CHECK (id ~ '^[0-9a-f]{24}$')` generated in Go; nested
subdocuments as `jsonb` (typed in Go) and opaque pass-through blobs as `json` (§8.5); JSON field names identical to
the Mongo field names; `v int NOT NULL DEFAULT 0` where `__v` must be re-emitted. Single-document Mongo operations map
to single SQL statements (autocommit); multi-statement flows use a transaction. "Key columns" are real columns; the
rest of the document lives in `doc jsonb` unless noted.

| Collection / key | Table | PK | Key columns (rest in `doc`) | Constraints / indexes | Atomic / lease / TTL mapping |
|---|---|---|---|---|---|
| `trades` | `trades` | `id` (ObjectId) | symbol, status, opened_at, closed_at; `buy`/`sell`/charges as jsonb | `(symbol)`, `(status)`, `(opened_at DESC)` | create = INSERT; close = UPDATE by id (optionally `AND status='open'`, §8.12); delete = `DELETE … WHERE id=$1 AND status='closed'` |
| `trade_log` | `trade_log` | `id` (ObjectId) | trade_id, symbol, event, at, source; legs/charges jsonb (`raw` json) | `(trade_id)`, `(symbol)`, `(at)` | append-only INSERT, best-effort |
| `kite_session` | `kite_session` | `id text` (= 'current') | all scalar columns | — | `INSERT … ON CONFLICT (id) DO UPDATE` |
| `dhan_session` | `dhan_session` | `id` | all scalar columns (`expiry_time bigint NULL`) | — | upsert as above |
| `active_broker` | `active_broker` | `id` | broker, selected_at, selected_by, `generation bigint NULL` | — | `INSERT … VALUES('current',$b,…,1) ON CONFLICT (id) DO UPDATE SET broker=…, generation = COALESCE(active_broker.generation,0)+1 RETURNING generation` |
| `admin_sessions` | `admin_sessions` | `id text` (token) | role, `expiry bigint` | `(expiry)` | upsert; load `WHERE expiry > $now`; optional purge job (behaviour-neutral) |
| `app_settings` | `app_settings` | `id text` | `value float8`, updated_at | — | upsert |
| `hourlyprices` | `hourlyprices` | `id` (ObjectId or bigserial) | all columns | `UNIQUE (symbol, date, time)` | `ON CONFLICT (symbol,date,time) DO UPDATE` |
| `stock_futures` (×2) | `stock_futures` | `id` | `source text CHECK IN ('archive','current')`, all columns | `UNIQUE (source, symbol, trading_date, expiry)` | upsert into `source='current'` only; reads route by cutoff as today (§8.9) |
| `spread_daily` | `spread_daily` | `id` | all columns | `UNIQUE (symbol, trading_date)`, `(trading_date DESC)` | upsert |
| `spread_summary` | `spread_summary` | `id` (ObjectId, kept stable across replace) | all columns (+ `v`) | `UNIQUE (symbol)`, `(last_date DESC)` | tx: per-symbol `ON CONFLICT (symbol) DO UPDATE` (replace all fields) + `DELETE WHERE symbol <> ALL($active)` |
| `fair_value_settings` | `fair_value_settings` | `id` | version, updated_at, `config json` | — | upsert; `SET LOCAL statement_timeout='3s'` |
| `fair_value_snapshots` | `fair_value_snapshots` | `id text` | underlying, input_snapshot_id, model_version, config_version, at, expires_at, `snapshot json`, `input json` | `(underlying, at DESC)`, `(expires_at)` | `INSERT … ON CONFLICT (id) DO NOTHING`; prune `DELETE … WHERE id IN (SELECT id … ORDER BY at DESC OFFSET $limit LIMIT 500)`; reads filter `expires_at > now()`; purge job replaces TTL. History projection: select the summary fields via `json` path or decode in Go |
| `box_trades` | `box_trades` | `id` (ObjectId, pre-allocatable) | execution_mode, broker, underlying, expiry, direction, lower_strike, upper_strike, status, position_state, opened_at, closed_at, close_idempotency_key, margin, net_pnl, realised_net_pnl; `legs jsonb`; audit blobs `entry_execution, entry_legging, exit_execution, exit_legging, exit_attempts json` as **separate columns** (list queries skip them; leg depth stripped in Go); rest in `doc jsonb` | `UNIQUE (underlying, expiry, lower_strike, upper_strike, direction) WHERE status='open'` (name `box_open_unique_pair_dir`); `(opened_at DESC)`; `(status, closed_at DESC)`; `(broker)` | insert: 23505 on PK ⇒ return existing, on partial index ⇒ null; close: `UPDATE … WHERE id=$1 AND status='open' RETURNING *`, else `SELECT … WHERE status='closed' AND close_idempotency_key=$k`; partial exit / recovery / reconciled projection: `UPDATE … WHERE id=$1 AND status='open'`; delete: `DELETE … WHERE id=$1 AND execution_mode <> 'live'`; nested `$set` path ⇒ `jsonb_set`; boot verifies the partial index via `pg_indexes` |
| `box_trade_events` | `box_trade_events` | `id` (ObjectId) | event, at, trade_id, candidate_key, broker (+ `v`); `execution json`, rest `doc` | `(at DESC)`, `(trade_id)`, `(candidate_key)`, `(event)`, `(broker)` | append-only INSERT best-effort; API rebuilds the raw doc shape incl. `_id` (+`__v`) |
| `box_order_intents` | `box_order_intents` | `client_order_id text` | **all scalar fields as columns** (state, filled_quantity, previous_filled_quantity, broker_order_id, broker, broker_mode, trade_id, attempt_id, created_at, updated_at, terminal_at, …); `audit jsonb` (array); keep `id` ObjectId column | `UNIQUE (broker_order_id) WHERE broker_order_id IS NOT NULL`; `(trade_id, created_at DESC)`; `(attempt_id, created_at DESC)`; `(state, updated_at)`; `(broker)` | create: `INSERT … ON CONFLICT (client_order_id) DO NOTHING` then `SELECT` + immutable-field check; CAS: one `UPDATE … SET …, previous_filled_quantity = COALESCE(filled_quantity,0), audit = CASE WHEN audit @> jsonb_build_array(jsonb_build_object('audit_id',$a)) THEN audit ELSE audit || $audit END WHERE client_order_id=$1 AND state = ANY($preds) [AND state = ANY($expected)] [AND filled_quantity <= $fq] [AND (broker_order_id IS NULL OR broker_order_id=$b)] RETURNING *` (READ COMMITTED re-evaluates the WHERE after a row-lock wait ⇒ exactly one winner); `$elemMatch` count ⇒ `jsonb_path_exists` / `@>` |
| `box_execution_attempts` | `box_execution_attempts` | `id` (ObjectId) | candidate_key, underlying, broker, resolved, resolved_at, detected_at, flatten_charges, flatten_charge_day, flatten_charges_for_day, `projection_version bigint NULL`, residual_projection_identity, `applied_flatten_applications text[]`, net_abort_pnl (+ `v`); `residual_exposure json`, `legging json`, rest `doc` | `UNIQUE (candidate_key) WHERE candidate_key='boot-recovery' AND resolved = false` (name `box_single_unresolved_crash_recovery`); `(resolved_at DESC)`; `(resolved, resolved_at DESC)`; `(flatten_charge_day, flatten_charges_for_day DESC)` | recovery row: `INSERT … ON CONFLICT DO NOTHING RETURNING *` then select winner; projection: one guarded `UPDATE … WHERE id=$1 AND NOT ($app = ANY(applied_flatten_applications)) AND <version/identity guards, legacy NULL = 0> RETURNING *`, ring = last 32 of `array_append`, rounding via an SQL half-even helper (or `SELECT … FOR UPDATE` + compute in Go, same tx); miss ⇒ `SELECT` to classify |
| `box_daily_pnl` | `box_daily_pnl` | `(day, trade_id)` | all row columns (`opened_at/closed_at/updated_at text`), `summary jsonb`, archived_at, `id` ObjectId kept for import | `(trade_id, day)` | upsert `ON CONFLICT (day, trade_id) DO UPDATE`; keyset `WHERE day=$1 AND trade_id <> '__summary__' AND trade_id > $after ORDER BY trade_id LIMIT 200` (`C` collation); orphan scan pages by PK instead of `_id` |
| `box_pnl_deletions` | `box_pnl_deletions` | `id text` (trade id) | status, `candidate_days text[]`, `attempts int`, created_at, updated_at, completed_at, last_error | `(status, id)` | prepare: `INSERT … ON CONFLICT (id) DO UPDATE SET updated_at=…, last_error=NULL`; candidate merge: `candidate_days = (sorted distinct union)[last 64]`; failure: `… SET attempts = attempts+1 WHERE id=$1 AND status='pending'`; cancel: `DELETE … WHERE status='pending'`; never purged |
| `box_pnl_day_states` | `box_pnl_day_states` | `id text` (day) | complete, snapshot_version, row_count, content_sha256, needs_reproof, `expected_trade_ids text[] NULL`, updated_at | `(snapshot_version, complete, id)`, `(snapshot_version, needs_reproof, id)` | proof CAS: `UPDATE … WHERE id=$1 AND snapshot_version=$v AND row_count=$n AND content_sha256=$h` and check rowcount = 1; `$unset` ⇒ `SET expected_trade_ids = NULL`; `$exists` ⇒ `IS [NOT] NULL` |
| `box_settings` | `box_settings` | `id text` | `value float8`, updated_at | — | one tx of upserts (stricter than `ordered:false`, matches the stated intent) |
| `box_calibration_samples` | `box_calibration_samples` | `id bigserial` (or ObjectId) | all columns | `(region, observed_at DESC)`, `(observed_at)` | batch `INSERT` (multi-row / COPY); read `WHERE region IS NOT DISTINCT FROM $1 AND observed_at >= $cut ORDER BY observed_at ASC LIMIT 50000`; purge job `DELETE WHERE observed_at < now() - interval '14 days'` replaces TTL |
| `box_trading_session` | `box_trading_session` | `id text` ('current') | all columns; id arrays `text[]` | — | upsert whole row (blind, as today); read error ≠ missing row |
| `box_instrument_reservations` | `box_instrument_reservations` + `box_instrument_reservation_keys` | parent `id text` (owner); child `(deployment, key)` | parent: deployment, broker, generation, mode, `keys text[]`, `sides jsonb`, fence, instance, created_at, expires_at, renewed_at; child: owner FK `ON DELETE CASCADE` | child PK `(deployment, key)` = the multikey unique; parent `(expires_at)`, `(deployment, broker, generation)`, `id text_pattern_ops` | acquire = tx { `INSERT parent ON CONFLICT (id) DO NOTHING` (0 rows ⇒ `owner_exists`); `INSERT` child rows (23505 on child PK ⇒ rollback ⇒ `key_conflict`) }; deleteExpired = `DELETE parent WHERE deployment=$1 AND expires_at <= $2 [AND keys && $3]`; renew = `UPDATE … WHERE id=$1 AND expires_at > $now [AND fence/broker/generation] RETURNING *`; prefix delete = `starts_with(id, $p)`; GC job replaces TTL; boot verifies child PK exists (fail closed). GiST exclusion on `text[]` overlap is not available without extensions, hence the child table |
| `box_reservation_fences` | `box_reservation_fences` | `id text` | `seq bigint`, at | — | fence: `INSERT … VALUES($id,1) ON CONFLICT (id) DO UPDATE SET seq = box_reservation_fences.seq + 1 RETURNING seq`; server clock: `SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint` (not `now()`, which is frozen per transaction); the `__clock__` row becomes unnecessary |
| `synth_trades` | `synth_trades` | `id` (ObjectId, client-generated) | status, underlying, expiry, key, broker, opened_at, opened_day, closed_at, closed_day, margin fields; `legs jsonb`; rest `doc` | `UNIQUE (underlying) WHERE status='open'` (`synth_open_one_per_underlying`); `(status, closed_at DESC)`; `(closed_day)` | insert 23505 ⇒ "duplicate"; close `UPDATE … WHERE id=$1 AND status='open'` touching no margin columns; margin `… WHERE status <> 'deleted'`; soft delete `… WHERE status=$from`; boot verifies index (fail closed) |
| `synth_settings` | `synth_settings` | `id text` | `value float8`, updated_at | — | one tx of upserts |
| Redis hashes (`calspread:oiframe:v2:*`, `futoiframe:*`, `chainsnap:min:*`, `chainsnap:hour:*`, `box:pnl:day:*`, `box:pnl:days`, `box:trades:closed:*`) | `cache_hash` | `(key, field)` | `key text` (full Redis key incl. `calspread:` so formats stay contract), `field text`, `value json`, updated_at | FK `key` → `cache_keys(key) ON DELETE CASCADE` | HSET ⇒ `ON CONFLICT (key, field) DO UPDATE`; HDEL ⇒ DELETE; HGETALL ⇒ `SELECT … WHERE key=$1` joined to a non-expired `cache_keys` row; one tx per flush (stronger than a pipeline) |
| Redis strings (`calspread:futcontracts`, `calspread:prevclose`) | `cache_hash` with `field=''` (or `cache_kv`) | `(key, field)` | as above | — | `SET … EX` ⇒ upsert value + set `cache_keys.expires_at` |
| Redis key TTL (`EXPIRE`) | `cache_keys` | `key text` | `expires_at timestamptz NULL` | `(expires_at)` | EXPIRE ⇒ update `expires_at`; HSET alone does not change it (Redis semantics); reads ignore expired keys; purge job deletes expired keys (cascade). Day-index per-field `expires_at` stays logical inside the value |

PG mechanisms not needed by any current semantic: `SKIP LOCKED` (no work queue is consumed across processes),
advisory locks (all coordination is row-level CAS or unique constraints; the P&L archiver's lifecycle lock is
in-process only). Introducing them would be a redesign.
