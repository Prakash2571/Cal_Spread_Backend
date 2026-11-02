# Inventory: Box EXECUTION subsystem (Node → Go parity reference)

Scope: `src/box/` execution files (gateway, order manager, coordinator, simulator, leg executor,
reservations, locks, sessions, live-mode transition, recovery, flatten, calibration, timing, pacing)
plus the execution parts of `engine.ts` and the durable intent layer in `repository.ts`/`model.ts`.
Scanner/math/P&L are in `box-core.md`. Line refs are `file:line` against backend HEAD at inventory time
(`src/box/` unless a path is given). "Go note" marks a Node single-thread / timer-order assumption that
needs an explicit mutex, transaction or ordering guarantee in Go.

Sources read: `src/box/LIVE_EXECUTION.md`, `docs/EXECUTION_PARITY_AUDIT.md`,
`docs/MULTI_PROCESS_RESERVATIONS.md`, `docs/BOX_FEEDS_AND_EXECUTION_COORDINATION_AUDIT.md`, and the code.

---

## 1. Durable order intent (`box_order_intents`)

### 1.1 Fields (`types.ts:1174-1247`, schema `model.ts:503-591`)

| field | type | notes |
|---|---|---|
| `client_order_id` | string | deterministic, e.g. `BOX:<trade-id>:ENTRY:k1_ce:attempt-1`; **unique index** `box_order_intent_client_order_id` (`model.ts:576`) |
| `broker_order_id` | string\|null | **unique partial index** on `{broker_order_id}` where `$type: "string"` (`model.ts:580-587`) |
| `broker_mode` | `"paper"\|"live"` | immutable |
| `broker` | BrokerId, default `"zerodha"` | immutable, indexed; legacy rows without it = zerodha |
| `broker_correlation_id` | string\|null | Dhan correlationId (≤30 chars) |
| `trade_id` | string\|null | immutable |
| `attempt_id` | string | immutable |
| `role` | `k1_ce\|k2_ce\|k2_pe\|k1_pe` | immutable |
| `purpose` | `ENTRY\|EXIT\|EMERGENCY_RESIDUAL\|PROTECTIVE_CANCEL` (`types.ts:1162`) | immutable |
| `phase` | `entry\|exit\|unwind` (`types.ts:1163`) | immutable |
| `exchange, tradingsymbol, token, side, quantity, reference_price, tick_size, max_chase_ticks, limit_price` | | all immutable |
| `state` | BoxOrderIntentState, default `CREATED` | CAS-guarded |
| `filled_quantity` | number, default 0 | monotonic (`$lte` guard) |
| `previous_filled_quantity` | number\|null | pre-image stamped by the same atomic update; absent on legacy rows |
| `average_price, broker_tag, reject_family, reject_reason` | | mutable |
| `created_at, updated_at, terminal_at` | Date | |
| `audit[]` | `{audit_id, at, from_state, to_state, broker_order_id, message, fill_identity, payload?}` (`types.ts:1164-1173`) | append-only, idempotent by `audit_id` |

Other indexes: `{trade_id:1, created_at:-1}`, `{attempt_id:1, created_at:-1}`, `{state:1, updated_at:1}` (`model.ts:589-591`).

Patchable fields (`BoxOrderIntentPatch`, `types.ts:1248-1261`): `broker_order_id, state, filled_quantity,
average_price, broker_tag, reject_family, reject_reason, updated_at, terminal_at`.
Immutable fields checked on create (`repository.ts:1656-1660` `IMMUTABLE_INTENT_FIELDS`): `broker_mode, trade_id,
attempt_id, role, purpose, phase, exchange, tradingsymbol, token, side, quantity, reference_price, tick_size,
max_chase_ticks, limit_price` — mismatch throws "Client order id … was reused with different immutable field …".

### 1.2 Durable state machine (the restart-safety state machine)

States (`types.ts:1149-1161`): `CREATED, SUBMITTING, ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, COMPLETE,
CANCEL_REQUESTED, CANCELLED, REJECTED, UNKNOWN, RECONCILIATION_REQUIRED`.
Nonterminal (`repository.ts:1412-1421`): all except `COMPLETE, CANCELLED, REJECTED`.

Allowed predecessors per target (`repository.ts:1506-1540`, `INTENT_STATE_PREDECESSORS`) — a write to state X
matches only if current state ∈ list:

| target | allowed current states |
|---|---|
| CREATED | CREATED |
| SUBMITTING | CREATED, SUBMITTING |
| ACKNOWLEDGED | SUBMITTING, ACKNOWLEDGED, UNKNOWN, RECONCILIATION_REQUIRED |
| OPEN | SUBMITTING, ACKNOWLEDGED, OPEN, UNKNOWN, RECONCILIATION_REQUIRED |
| PARTIALLY_FILLED | ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, UNKNOWN, RECONCILIATION_REQUIRED |
| COMPLETE | SUBMITTING, ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, CANCEL_REQUESTED, **CANCELLED**, UNKNOWN, RECONCILIATION_REQUIRED, COMPLETE |
| CANCEL_REQUESTED | ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, CANCEL_REQUESTED, UNKNOWN, RECONCILIATION_REQUIRED |
| CANCELLED | ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, CANCEL_REQUESTED, UNKNOWN, RECONCILIATION_REQUIRED, CANCELLED |
| REJECTED | CREATED, SUBMITTING, ACKNOWLEDGED, OPEN, REJECTED |
| UNKNOWN | CREATED, SUBMITTING, ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, CANCEL_REQUESTED, UNKNOWN, RECONCILIATION_REQUIRED |
| RECONCILIATION_REQUIRED | same as UNKNOWN |

Notes: self-transitions are allowed for every state except none (CREATED→CREATED, SUBMITTING→SUBMITTING …
are allowed; ACKNOWLEDGED→ACKNOWLEDGED allowed). `CANCELLED → COMPLETE` is legal (late fill after cancel).
`PARTIALLY_FILLED → REJECTED` is NOT legal. `COMPLETE` and `REJECTED` are absorbing except self.

### 1.3 Atomic operations the intent layer depends on (must be reproduced in PostgreSQL)

1. **Create-or-adopt** `createBoxOrderIntent(intent: IBoxOrderIntent): Promise<BoxOrderIntentRecord>`
   (`repository.ts:1426-1441`): `findOneAndUpdate({client_order_id}, {$setOnInsert: intent}, {upsert:true, new:true})`
   then `assertIntentImmutableMatch`. Throws if Box DB disabled. PG: `INSERT … ON CONFLICT (client_order_id) DO NOTHING`
   then `SELECT` (or `DO UPDATE SET client_order_id = EXCLUDED.client_order_id RETURNING *`), then compare immutables.
2. **Guarded update** `updateBoxOrderIntent(clientOrderId, patch, audit, expectedStates?) : Promise<BoxOrderIntentUpdateResult>`
   (`repository.ts:1563-1627`). Single `findOneAndUpdate` with an aggregation-pipeline `$set`. Filter is the AND of:
   - `client_order_id = id`;
   - if `patch.broker_order_id` truthy: `broker_order_id IS NULL OR broker_order_id = patch.broker_order_id`;
   - if `patch.state`: `state IN INTENT_STATE_PREDECESSORS[patch.state]`;
   - if `expectedStates`: `state IN expectedStates` (the explicit CAS, e.g. CREATED→SUBMITTING);
   - if `patch.filled_quantity !== undefined`: `filled_quantity <= patch.filled_quantity` (**non-strict**).
   Update (single statement): all patch fields set literally; `previous_filled_quantity = COALESCE(old.filled_quantity,0)`
   (pre-image, evaluated against the input doc); `audit = audit` unchanged if `audit.audit_id` already present else
   `audit || [audit]`. Returns `{intent, applied:true, previous_filled_quantity, current_filled_quantity}`.
   On no match: a **separate non-atomic re-read** and returns `{intent: fresh, applied:false, previous=current=fresh.filled_quantity}`.
   PG: one `UPDATE … SET …, previous_filled_quantity = COALESCE(filled_quantity,0) WHERE … RETURNING *` (in PG the
   right-hand side of SET sees the old row, which matches Mongo's semantics); audit as a JSONB array append
   guarded by `NOT (audit @> '[{"audit_id": …}]')` or a child table with `UNIQUE(client_order_id, audit_id)`
   inside the same transaction. The fallback read can stay separate (it is informational).
   Note: an update carrying a `broker_order_id` already used by another row would hit the unique index → Mongo
   throws duplicate-key; PG must also throw (unique violation), not silently succeed.
3. Reads: `findBoxOrderIntentByClientId`, `findBoxOrderIntentByBrokerId` (null when DB disabled),
   `loadNonterminalBoxOrderIntents()` (state ∈ nonterminal, sort `updated_at` ASC, **throws** when DB disabled — never
   silently empty), `loadOwnedBoxOrderIntents()` (all `broker_mode:"live"`, sort `created_at` DESC, throws when disabled),
   `countUnresolvedBoxOrderIntentsForBroker(broker)` (live + nonterminal + broker; zerodha also matches missing/null broker).
   Injected into the manager as `boxOrderIntentPersistence = {create, update, loadNonterminal, loadOwned, findByClientId, findByBrokerId}` (`repository.ts:1647-1654`).

### 1.4 Observable stage vocabulary (`orderLifecycle.ts`)

`BoxOrderStage` (15, `orderLifecycle.ts:70-100`): `CREATED, QUEUED, POSTING, BROKER_ACCEPTED, ACKNOWLEDGED, WORKING,
PARTIALLY_FILLED, FILLED, CANCEL_REQUESTED, CANCEL_PENDING, CANCELLED, REJECTED, EXPIRED, UNKNOWN, RECONCILIATION_REQUIRED`.
Purely observational; never persisted as a state.

- `durableStateForStage(stage): BoxOrderIntentState` (`:144`): CREATED,QUEUED→CREATED; POSTING→SUBMITTING;
  BROKER_ACCEPTED,ACKNOWLEDGED→ACKNOWLEDGED; WORKING→OPEN; PARTIALLY_FILLED→PARTIALLY_FILLED; FILLED→COMPLETE;
  CANCEL_REQUESTED,CANCEL_PENDING→CANCEL_REQUESTED; CANCELLED,EXPIRED→CANCELLED; REJECTED, UNKNOWN,
  RECONCILIATION_REQUIRED→same.
- `stageForDurableState(state): BoxOrderStage` (`:183`): inverse to the conservative member (SUBMITTING→POSTING, OPEN→WORKING, COMPLETE→FILLED, …).
- `isTerminalStage(stage)` (`:218`): FILLED, CANCELLED, REJECTED, EXPIRED.
- `stageAcceptsFurtherFills(stage)` (`:235`) = `!isTerminalStage` (true for CANCEL_REQUESTED/PENDING/UNKNOWN/RECON).
- `stageProvesExecution(_): false` (`:252`) — always false.
- `stageFromCumulativeQuantity({requestedQty, cumulativeQty, cancelConfirmed?}): BoxOrderStage` (`:263`):
  floor+clamp≥0; `requested>0 && filled>=requested`→FILLED; else cancelConfirmed→CANCELLED; else filled>0→PARTIALLY_FILLED; else WORKING.

### 1.5 `CumulativeFillLedger` (`orderLifecycle.ts:391-568`, `apply` at `:470`) — the only sanctioned fill application

`constructor(clientOrderId: string, requestedQty: number)` — requested = finite ? max(0, floor) : 0.
Getters: `requestedQty, cumulative, remaining (=max(0, requested-cumulative)), averagePrice, overfill, hasOverfill, hasExposure (cumulative>0)`.
`apply(event: CumulativeFillEvent): FillApplyResult`, rules in order:
1. non-finite or <0 → `invalid` (delta 0). `observed = floor(raw)`.
2. `eventId?.trim()` non-empty and already seen → `duplicate_event` (delta 0); else add to seen set (added BEFORE the stale check, so a stale event's id is still consumed).
3. `sequence` finite: if `highestSequence !== null && sequence <= highestSequence` → regression flag + count; else highestSequence = sequence (diagnostic only).
4. `observed <= cumulative` → `stale_cumulative` (delta 0; price NOT updated).
5. apply: delta = observed − cumulative; cumulative = observed; avg price updated only if finite >0; first/last fill mono/wall set; `overfill = max(0, cumulative − requested)` → outcome `applied_overfill` if >0 else `applied`.
`FillEventSource`: `rest_poll | order_update | postback | trade_book | reconciliation | paper`.
`snapshot(): FillLedgerSnapshot` (counts applied/duplicate/stale/regressions, first/last fill mono+wall).
Helpers: `outstandingQuantity(requested, cumulative)` (`:571`) = max(0, floor(req)−floor(filled)) with non-finite→0;
`terminalQuantityAccounting({requestedQty, finalCumulativeQty, cumulativeAtCancelRequest?})` (`:602`) →
`{requested, filled, cancelled = max(0, req−filled), filledAtCancelRequest, racedQuantity = max(0, filled−atCancel), cancelRaced}`.
Golden: 75 req, 40 at cancel, final 52 → filled 52 / cancelled 23 / raced 12.
Go note: the ledger is per-order, mutable, unsynchronised; in Go each ledger must be owned by one goroutine or guarded.


---

## 2. Broker adapter contract used by execution (`brokerAdapter.ts`)

- `BrokerOrderState = BoxOrderIntentState` (same 11 values). `isBrokerOrderTerminal(state)` (`brokerAdapter.ts:233`) = COMPLETE|CANCELLED|REJECTED.
- `BrokerRejectFamily`: `margin | price_band | instrument_unavailable | market_closed | rate_limit | rms | quantity_freeze | auth | generic`.
- `BrokerOrderRequest {client_order_id, role, trade_id, attempt_id, purpose, phase, exchange, tradingsymbol, token, side, quantity,
  pricing: {order_type:"LIMIT", reference_price, tick_size, max_chase_ticks, limit_price}, tag?, paper?: {instrument, detected_price, detected_qty, submit_at, latency_ms?}}`.
- `BrokerOrder {client_order_id, broker_order_id, tag, role, trade_id, attempt_id, purpose, phase, exchange, tradingsymbol, token, side, quantity, pricing,
  limit_price, state, filled_quantity, pending_quantity, average_price, fills: {fill_id, quantity, price, at}[], reject_family, reject_reason, created_at, updated_at}` (ms epoch).
- `BrokerAdapter` (`:178-195`): `mode; prepareOrder?(req); submitOrder(req, beforePost?: () => void): Promise<BrokerOrder>; cancelOrder(clientOrderId): Promise<BrokerOrder|undefined>;
  modifyOrder?(clientOrderId, {limit_price, quantity?}); getOrder(clientOrderId); listOrders(); listPositions(): BrokerPosition[] {token, exchange, tradingsymbol, net_quantity, average_price};
  adoptOrder?(intent, snapshot); margins?(); health?(): {ok, transport, authenticated, message, checked_at}`.
- `beforePost` contract: adapter calls it after pacing, as the very last step before the HTTP POST; a throw proves no mutation.
- Errors: `BrokerPreSubmitRefusedError(clientOrderId, stage: "dequeue"|"post_persist"|"pre_post", durableIdentitySpent: boolean, reason)` (`:165`);
  `BrokerAmbiguousSubmitError(clientOrderId, message, causeValue?, order?)` (`:197`); `BrokerOrderRejectedError(order, causeValue?)` (`:216`, message = reject_reason ?? "Broker rejected order.");
  `BrokerDisabledError` (`:226`).

---

## 3. `BoxOrderManager` (`orderManager.ts`) — live order coordinator

### 3.1 Construction, controls, limits

`constructor(deps: {adapter, persistence: OrderIntentPersistence, limits: OrderManagerLimits, controls?, clock?, istDayKey?, onPersistenceLossAfterFill?, onReconciliationIssue?,
loadDailyRiskSeed?(day): Promise<DailyRiskSeed>, dailyRiskSeedTimeoutMs?, dailyRiskSeedTimer?, isCrashRecoveryPersistenceReady?, onCircuitTrip?, timing?, onBrokerReject?,
revalidateQueuedRequest?(request, stamp): string|null, broker?(): BrokerId})` (`:459-522`).

- Controls `{entryEnabled, liveOrderEnabled, emergencyFlatten}` default **all false** (`:517-521`); `setControls(patch)` merges (`:537`).
- Fill ledgers: `BoundedTtlCache<CumulativeFillLedger>({maxEntries: 512, ttlMs: 60*60_000})` (`:512-516`).
- `OrderManagerLimits` from config (`orderManagerLimitsFromConfig`, `:289-304`): `maxOpenBoxes=liveMaxOpenBoxes, maxConcurrentExecutions=liveMaxConcurrentExecutions,
  entrySubmitConcurrency=liveEntrySubmitConcurrency, maxBoxCapitalRupees=liveMaxBoxCapitalRupees, maxResidualLegs, dailyLossLimit, rejectLimit, consecutiveFailureLimit,
  maxOpenLegQuantity, maxGrossOpenLegQuantity, reconcileIntervalMs, feedReconnectWarmupMs` (defaults per LIVE_EXECUTION.md: open boxes 1, concurrency 1, residual legs 1,
  open leg qty 100, gross 400, daily loss 5000 (0 disables), reject limit 3, consecutive failure 3, reconcile 60000, warmup 5000; entry submit concurrency 1, range 1–4).
- `OrderManagerHealth` fields (`:180-190`): persistence, daily_risk_seed (healthy|seeding|failed|unknown), broker_auth, broker_orders_api, broker_positions_api,
  reconciliation (idle|running|failed), reconciliation_complete, feed (healthy|warming|unhealthy|unknown), circuit (closed|open). All start `unknown`/`idle`/false/`closed` (`:362-372`).

### 3.2 Admission predicates

`canEnter(request?)` (`:737-757`) — ALL must hold, in this order: rollTradingDay(); refreshFeedHealth(); not disposed; breaker not tripped; entryEnabled && liveOrderEnabled;
persistence healthy && daily_risk_seed healthy && reconciliation_complete; broker_auth/orders/positions healthy; `unknownOrders == 0 && !recoveryActive`;
not crash-recovery-quarantined (`crashOnlyAttributedExposure && !isCrashRecoveryPersistenceReady()`, throw ⇒ quarantined, `:2288-2295`);
`feedHealthy && now >= feedWarmUntil`; `openBoxes < maxOpenBoxes`; `residualLegs <= maxResidualLegs` (note: `>` blocks, so equal is allowed); `withinQuantityLimits(request)` if given.
Concurrency is deliberately NOT checked here (sibling legs of one Box must queue, `:752-755`).

`canManageExposure()` = `!disposed && liveOrderEnabled` (`:759`). `canSafelyReduceAttributedExposure()` = that && `safeAttributedReductionReady` (`:763`).

`withinQuantityLimits(request)` (`:2117-2130`): `quantity > maxOpenLegQuantity` ⇒ false. ENTRY: `gross + reservedEntry + quantity <= maxGross`. PROTECTIVE_CANCEL: true.
Else (EXIT/EMERGENCY_RESIDUAL): net = attributedBoxPositions[`exchange:tradingsymbol`] ?? 0; side must reduce (net>0 ⇒ SELL, net<0 ⇒ BUY) and `quantity + alreadyReservedForSymbol <= |net|`.

Feed health: `setFeedHealthy(h)` (`:723-729`): on false→true sets `feedWarmUntil = now + feedReconnectWarmupMs`; on false sets +∞; health = unhealthy|warming|healthy.

### 3.3 `submit(request, checkedFeed?, capital?, entry?)` (`:767-840`)

Order of checks (each early rejection releases the hedge rank as `no_post`):
1. `entryGuard = purpose==="ENTRY" ? entry : undefined`; register gate rank (`ensureEntryTransportGate`) BEFORE any return.
2. ENTRY guard at stage `pre_enqueue` (entryAdmissible forced true at this stage) → `BrokerPreSubmitRefusedError(id, "dequeue", false, reason)` (note: stage label passed is `"dequeue"`, identity not spent).
3. ENTRY && !canEnter(request) → Error "OrderManager entry controls or limits are closed."
4. non-ENTRY && !canManageExposure() → Error "OrderManager exposure management is disabled." (no rank release; no guard for non-entry).
5. !withinQuantityLimits → "Order exceeds configured live leg quantity limits."
6. **in-process duplicate guard**: `activeClientIds.has(client_order_id)` → "Order … is already queued or active." then add.
7. Reserve: ENTRY → `reservations[id]=qty; reservedEntryQuantity += qty`; EXIT/EMERGENCY_RESIDUAL → per-symbol reduction reservation; PROTECTIVE_CANCEL → none.
8. `beginTrace` (marks `scheduler_enqueued`), push `{kind:"submit", …, sequence: this.sequence++}`, `sortQueue()`, `pump()`.

### 3.4 Priority queue and slots (`pump`, `:1076-1127`; policy `executionSchedulingPolicy.ts`)

- `BOX_ORDER_PRIORITY` (`executionSchedulingPolicy.ts:47-52`): `EMERGENCY_RESIDUAL:0, PROTECTIVE_CANCEL:1, EXIT:2, ENTRY:3`. A `cancel` queue action uses PROTECTIVE_CANCEL.
  Sort: priority ASC then sequence ASC (`:1052-1054`; `compareScheduling` `:67-72`).
- `pump()` PEEKS head; `admitBoxOperation` (`executionSchedulingPolicy.ts:225-288`):
  - base = finite ? max(1, floor(baseConcurrency)) : 1; burstWidth = clampEntrySubmitConcurrency (`:173`, MIN 1 `:169`, MAX 4 `:170`, non-finite→1).
  - non-ENTRY: admit `base` slot iff `baseInFlight < base`.
  - ENTRY: refuse if `entryAttemptId !== null && !== request.attemptId` (one pipeline at a time, base slots included); admit `base` if `baseInFlight < base`;
    else refuse if `burstWidth <= base`; refuse if `nonEntryInFlight > 0`; refuse if `baseInFlight + burstInFlight >= burstWidth`; else admit `entry_burst`.
  - Head not admissible ⇒ **stop pumping** (no look-ahead).
- After shift: `queuedActionBlockReason` (`:1396-1422`) re-checks: cancel → canManageExposure; ENTRY → canEnter(), qty ≤ maxOpenLeg and `gross + reservedEntry ≤ maxGross` (note: request qty already in reservedEntry), capital stamp (`capitalBlockReason` `:1197-1226`: cap ≤0/non-finite ⇒ no opinion; cap>0 and no stamp ⇒ refuse; `box_notional_paise > round(cap*100)` ⇒ refuse);
  EXIT/EMERGENCY → canManageExposure, then (except PROTECTIVE_CANCEL purpose) qty ≤ maxOpenLeg, reducing side, `reservedForSymbol ≤ |net|`. Blocked ⇒ release reservation + activeClientId, reject, continue loop.
- `occupySlot`/`releaseSlot` (`:1129-1159`): counters inFlight/baseInFlight/burstInFlight/entryInFlight/nonEntryInFlight; `entryAttemptInFlight` set on ENTRY occupy, cleared when entryInFlight hits 0. Clamped at 0.
- `execution.finally`: release slot; if known intent state NOT in {UNKNOWN, RECONCILIATION_REQUIRED} release the quantity reservation (uncertain orders keep their reservation); delete activeClientId; `pump()` again.
- The slot is held for the **entire order lifecycle** (adapter `submitOrder` resolves only when terminal or timed-out).

### 3.5 `execute(action)` — durable-intent-before-POST (`:1434-1644`)

1. `request = adapter.prepareOrder?.(req) ?? req`; `intent = intentFromRequest(request, adapter.mode, now)` (state CREATED, filled 0, audit `[{audit_id: "<id>:CREATED", from:null, to:CREATED, message:"durable order intent created before submission"}]`, `:2368-2411`).
2. `intent = await persistence.create(intent)` (create-or-adopt). `persistedRequest = requestFromIntent(intent)` (the DURABLE row is what is POSTed, `:2344-2366`). health.persistence = healthy.
3. **If durable state ≠ CREATED** (prior submission exists): `adapter.getOrder(id)`; none ⇒ throw "Existing durable intent requires reconciliation before resubmit." (→ outer catch: persistence unhealthy!); else persistOrder + resolve. Never re-POST.
   This happens BEFORE feed validation ("adoption before validation").
4. **Checkpoint 3 (dequeue)**: `checkedFeedBlockReason(request, stamp)` (validator throw ⇒ "current executable-feed validation failed closed") ?? ENTRY guard `dequeue`. Refusal ⇒ `persistLocalPreSubmitRefusal`; if CAS lost ⇒ `resolveConcurrentSubmissionOwner`.
5. **CAS** `transitionResult(intent, "SUBMITTING", null, "transport submission starting", ["CREATED"])`. Not applied ⇒ `resolveConcurrentSubmissionOwner` (never POST). Applied but state ≠ SUBMITTING ⇒ throw. Mark `intent_persisted`.
6. **Checkpoint 4 (post_persist)** ENTRY guard; refusal ⇒ local-refusal path. Then **hedge barrier** `awaitEntryTransportTurn` (SELL waits until every hedge rank `[0,hedgeCount)` decided).
7. `adapter.submitOrder(persistedRequest, beforePost)`; **checkpoint 5 (pre_post)** inside `beforePost`: feed check ?? ENTRY guard `pre_post`; throw `BrokerPreSubmitRefusedError(…,"pre_post", true, reason)`; else `postBegan = true`.
8. Error handling:
   - `BrokerPreSubmitRefusedError` ⇒ local refusal (CAS from current state to REJECTED).
   - `BrokerOrderRejectedError` ⇒ persistOrder(error.order); `rejects++`; onBrokerReject; noteFailure; evaluateLimits; hedgeFailure.
   - **anything else** (the condition `Ambiguous || timeoutLike || !(Rejected)` is always true here; the trailing `REJECTED` branch `:1615-1622` is **dead code**): if ambiguous with `.order` ⇒ persistOrder(order) else transition → `RECONCILIATION_REQUIRED`; `unknownOrders++`; noteFailure("ambiguous broker submission"); hedgeFailure.
9. Success: if `order.state ∈ {UNKNOWN, RECONCILIATION_REQUIRED}` ⇒ persistOrder, noteFailure, hedgeFailure ("not proof of a hedge"). Else persistOrder; REJECTED ⇒ rejects++, noteFailure, hedgeFailure; COMPLETE ⇒ `consecutiveFailures = 0`. evaluateLimits; resolve(order). (Note: CANCELLED/partial do not reset or increment failures.)
10. Outer catch (persistence/other throws) ⇒ health.persistence = "unhealthy", noteFailure("order intent persistence failure"), reject.
11. `finally`: `decideEntryTransportRank(request, guard, postBegan ? "posted" : "no_post", hedgeFailureReason)`.

`persistLocalPreSubmitRefusal(intent, refusal)` (`:1664-1685`): `transitionResult(intent, "REJECTED", null, "local pre-submit refusal; no broker POST attempted (<stage>): <reason>", [intent.state],
payload {origin:"local_pre_submit_refusal", no_broker_post:true, stage, reason})`; returns `applied && state==="REJECTED"`. Not counted as reject or failure.

`resolveConcurrentSubmissionOwner(action, current)` (`:1687-1704`): `adapter.getOrder(id)`; found ⇒ persistOrder + resolve; else if current nonterminal `unknownOrders++`; reject `BrokerAmbiguousSubmitError("Another process advanced durable intent … this process attempted no broker POST and reconciliation is required.")`.

### 3.6 Hedge-first barrier (`EntryTransportGate`, `:1274-1394`)

Gate per `attempt_id`: `{registered:Set<rank>, decided:Map<rank,"posted"|"no_post">, waiters:[{rank,wake}], hedgeFailure:string|null, hedgeCount}`.
- `ensureEntryTransportGate` registers rank; `hedgeCount = max(seen)`.
- `decideEntryTransportRank` is idempotent per rank; for a hedge leg with a `reason` sets `hedgeFailure = "<role> (<side>) did not reach the broker|failed at the broker: <reason>"` (first one wins); wakes waiters whose hedges are all decided; deletes gate only when no waiters AND every registered rank decided.
- `entryHedgesDecided(gate, rank)`: rank < hedgeCount ⇒ true; else all ranks `0..hedgeCount-1` decided.
- `hedgeFailure` is read by the ENTRY guard for non-hedge legs only (`hedgeFailure: guard.hedge ? null : gate?.hedgeFailure`, `:1243`).
- `dispose()` drains all waiters (woken legs re-check guard, see disposed, refuse) and rejects queued actions with "OrderManager disposed before broker action." (`:1021-1042`).
- Go note: implement with a per-attempt struct under the manager mutex + channels/cond; the "wake then re-check full guard in beforePost" semantics must stay.

### 3.7 Entry guard (`liveEntryGuard.ts`)

Stages (`:29-39`): `pre_build, pre_enqueue, dequeue, post_persist, pre_post`. `evaluateLiveEntryGuard(inputs)` (`:92-122`) checks in order:
`stillWanted` → `not_still_wanted`; `liveOrderEntryEnabled` → `live_orders_disarmed`; `entryEnabled` → `entry_disarmed`; `circuitClosed` → `circuit_open`;
`attemptAborted !== null` → `attempt_aborted` (manager always passes null); `hedgeFailure !== null` → `hedge_leg_failed`; `entryAdmissible` → `entry_not_admissible`.
Reason strings: e.g. "entry is no longer wanted at <stage>: ownership/lease lost, or the scanner decision was withdrawn".
`stillWantedSafely(pred)` (`:134-141`): undefined ⇒ true; returns `pred() === true`; throw ⇒ false. Refusal counts per stage in `entryGuardDiagnostics()`.

### 3.8 Entry submission order (`entrySubmissionOrder.ts`)

`entrySubmissionOrder(direction): EntrySubmissionSlot[] {role, side, rank, hedge}` (`:64-78`): iterate canonical `BOX_LEG_ROLES = [k1_ce, k2_ce, k2_pe, k1_pe]` (`types.ts:193`),
BUYs first then SELLs, ranks 0..3, `hedge = side==="BUY"`. Sides (`types.ts:208-213`): LONG_BOX `{k1_ce:BUY, k2_ce:SELL, k2_pe:BUY, k1_pe:SELL}`, SHORT_BOX inverse.
Result: LONG `[k1_ce, k2_pe, k2_ce, k1_pe]`; SHORT `[k2_ce, k1_pe, k1_ce, k2_pe]`. Also `entrySubmissionRoles`, `entryTransportRank(dir, role)` (−1 if absent), `isHedgeFirstSequence(sides)`.

### 3.9 `persistOrder(intent, order, message)` (`:1939-2007`) and `transitionResult` (`:2020-2087`)

persistOrder: timing markFill/terminal (fail-open); `rememberFillIdentities(order)` (ledger; eventId = last `fills[].fill_id`; overfill ⇒ **trip**);
`persistence.update(id, {broker_order_id, state, filled_quantity, average_price, broker_tag: order.tag, reject_family, reject_reason, updated_at: order.updated_at,
terminal_at: terminal ? order.updated_at : null}, auditFor(...))` (no expectedStates; predecessor table + `$lte` + broker-id guard only).
Then `delta = durableFillDelta(result)`: not applied ⇒ 0; previous/current not numbers ⇒ invariantViolation + 0; delta < 0 ⇒ invariantViolation + 0.
delta > 0 ⇒ `attributedBoxPositions[exchange:symbol] += (BUY ? +delta : -delta)`, recompute gross (= Σ|net|). Terminal ⇒ release reservation + publish timing.
On throw: health.persistence unhealthy; if `order.filled_quantity > 0` ⇒ trip("persistence lost after confirmed fill …"), `onPersistenceLossAfterFill`, throw `OrderPersistenceAfterFillError(order, cause)`.

transitionResult: patch `{state, broker_order_id: brokerOrderId, updated_at: now, terminal_at: state∈{COMPLETE,CANCELLED,REJECTED} ? now : null}` + optional expectedStates + payload.
Not applied ⇒ `durableTransitionRefusals++`, warn; if target RECONCILIATION_REQUIRED and current not in {UNKNOWN,RECON} ⇒ **trip** directly.

`auditFor` (`:2413-2432`): `audit_id = "<client_order_id>:<snapshotState>-><toState>:<brokerOrderId ?? none>:<fillIdentity ?? none>"` — uses the CALLER'S snapshot state, so idempotency is per (from,to,broker id,fill id).

AMBIGUITY (port exactly): `transitionResult` always writes `broker_order_id: brokerOrderId` even when null, and `persistOrder` writes `order.broker_order_id` even when null. The broker-id guard only applies when the value is truthy,
so a null patch **overwrites** an existing broker_order_id with null. Current callers pass null only when none exists (CREATED/SUBMITTING) or pass `intent.broker_order_id`, but a Go port must keep the same "set even if null" semantics, not COALESCE.

### 3.10 Reconciliation (`reconcile` `:973-981`, `performReconcile` `:1706-1937`)

- `start()` (`:525-535`): arms `setInterval(reconcile, max(5_000, reconcileIntervalMs))` (unref) BEFORE first pass; then `reconcile()`.
- `reconcile()`: rollTradingDay; if daily seed not healthy ⇒ refreshDailyRiskSeed; **single-flight** via `reconcilePromise` (concurrent callers share the promise).
- performReconcile: `reconciliation="running"`, `safeAttributedReductionReady=false`. Load nonterminal + owned intents (owned defaults to nonterminal if no `loadOwned`); failure ⇒ persistence unhealthy, throw.
  Seed `knownIntents` with owned. `adapter.health()` ⇒ broker_auth (null health counts as healthy). `listOrders()` / `listPositions()` set orders/positions API health; failure throws.
- Matching each broker order: by client id → broker order id → tag (tag only if exactly one owned intent has it). Unmatched ⇒ orphan; if `client_order_id` starts `BOX:` or tag starts `BOX` ⇒ ownedLookingOrphan, `recoveryActive=true`, **trip**.
  Same intent matched twice ⇒ recoveryActive, trip. Else `adoptOrder?.(intent, order)` (default `{...order, client_order_id: intent.client_order_id}`) then persistOrder; adopt/persist throw ⇒ identity mismatch symbol, recoveryActive, trip.
- Nonterminal intents not matched ⇒ `missingAtBroker`; if state ≠ CREATED transition → RECONCILIATION_REQUIRED ("durable nonterminal intent not found in broker order list; no resubmit"); recoveryActive, trip. (A CREATED row missing at broker also trips.)
- First reconcile only (`lastReconciledAt === null`): rebuild entry/reduction quantity reservations from nonterminal intents' `quantity − filled_quantity`.
- Attribution rebuild: for every owned intent with filled>0, net per symbol += ±filled; `attributedBoxPositions[symbol]` set for every symbol ever owned (exact zero included). `remainingByTrade[trade][role] = |net per trade:role|`.
- Position mismatches: identity-mismatch symbols (actual NaN) + any symbol where expected ≠ broker actual and (expected≠0 or owned) ⇒ recoveryActive, trip.
- `unknownOrders` = count of nonterminal intents in UNKNOWN/RECON. `safeAttributedReductionReady` = no missing, no owned-looking orphans, unknown==0, and every mismatch has finite actual, expected≠0, same sign, |actual| ≥ |expected|.
- `reconciliation_complete = daily_risk_seed healthy && no missing && no mismatches && no owned-looking orphans && unknown==0`. `onReconciliationIssue(report)` awaited.
- Failure ⇒ reconciliation failed, complete=false, (live) unknown API health → unhealthy, **trip("reconciliation failed: …")**, rethrow.
- Report: `{matched, missingAtBroker, orphanOrders, positions, positionMismatches, affectedTradeIds, remainingByTrade}`.

### 3.11 Circuit breaker and risk counters

- `trip(reason)` (`:2321-2328`): first reason wins (sticky; never cleared in-process; day roll does not clear); sets circuit open, `controls.entryEnabled=false`, `onCircuitTrip(reason)`.
- `invariantViolation(reason)` (`:649-653`): recoveryActive=true; trip("execution invariant violation: …"); fire-and-forget reconcile.
- `noteFailure(reason)` (`:2302-2307`): `consecutiveFailures++`; `>= consecutiveFailureLimit` ⇒ trip("<reason>: consecutive failure limit reached").
- `evaluateLimits()` (`:2309-2319`): `dailyLossLimit>0 && realisedPnlToday <= -dailyLossLimit`; `rejects >= rejectLimit`; `residualLegs > maxResidualLegs`; `openBoxes > maxOpenBoxes`; `gross > maxGross` ⇒ trip each.
- `recordRealisedPnl(delta)` (`:731`), `setExposure({openBoxes?, residualLegs?, grossOpenLegQuantity?})` (`:655`), `setAttributedBoxPositions(positions)` (`:672`, replaces map), `attributedRecoveryExposure()` (`:690`, residuals from non-zero nets matched to a known intent by symbol; `source:"partial_entry"`).
- `cancelWorkingBoxOrders()` (`:942-971`): requires canManageExposure; for each nonterminal intent with id prefix `BOX:` enqueue a cancel (PROTECTIVE_CANCEL priority) **sequentially awaited**, per-intent try/catch; any failures ⇒ invariantViolation listing them. `executeCancel` = adapter.cancelOrder + persistOrder.

### 3.12 Trading day and daily-risk seed

- `dayKey()` default = `new Date(now + 5.5h).toISOString().slice(0,10)` (`:2297-2300`) (IST date).
- `rollTradingDay()` (`:2190-2217`): on day change: settle/cancel prior-day loaders, drop other days' mutation journals, **zero** realisedPnl/rejects/consecutiveFailures, `daily_risk_seed="seeding"`, `reconciliation_complete=false`, refreshDailyRiskSeed. Breaker/controls untouched.
- `refreshDailyRiskSeed()` (`:2219-2274`): single active load; no loader ⇒ "failed". Token `{tradingDay, mutationGeneration, loadGeneration}`; timeout `max(1, dailyRiskSeedTimeoutMs ?? 30_000)` ms ⇒ settle, "failed", roll + retry. Success (only if same generation/day/token active) ⇒ `seedLimits(...)` then `setTimeout(reconcile, 0)`. Failure ⇒ "failed".
- `seedLimits(args)` (`:612-647`): ignore if token no longer active; realised = `mergePostLoadFlattenCharges` (subtract local flatten-charge increments newer than the loader's mutation generation and above its per-attempt baseline, rounded to 0.01); floors counters; `daily_risk_seed = incomplete ? "failed" : "healthy"`.
- `recordFlattenCharge({attemptId, chargeDay, previousChargesForDay, chargesForDay})` (`:579-610`): round 2dp; ignore if not increasing or not today; journal mutation if any active loader could need it; `realisedPnlToday -= (current - previous)`; evaluateLimits.
- Go note: all of the above mutate shared counters from timers, promise continuations and request handlers; in Go put the whole manager state behind one mutex (or an actor goroutine) and make the generation checks happen under it.

### 3.13 Node single-thread assumptions in the manager (Go must make explicit)

- `submit()` performs check (`activeClientIds`, limits) + reserve + enqueue with no await: atomic per event-loop turn. Go: one critical section.
- `pump()` runs synchronously after every enqueue and every completion; admission + occupy happen without interleaving.
- `reconcilePromise` single-flight; daily-seed `activeDailyRiskLoad` single slot.
- Fill attribution relies on the DB pre-image (safe across processes); the in-memory map update after it is not atomic with the DB write — two goroutines persisting the same order must still serialize the map update (mutex).
- Timer ordering: `setTimeout(reconcile, 0)` after seed install; `setInterval` reconcile armed before first pass.

---

## 4. `CentralBoxExecutionGateway` (`executionGateway.ts`) — the paper/live seam

Interface `BoxExecutionGateway` (`:72-82`): `mode; hasCapacity(); simulateEntry; simulateLeggingEntry; simulateExit; simulateLeggingExit; estimateExecutableExit(position, now?);
flattenResidual; invariantViolation(reason)`. Every method delegates to `BoxExecutionSimulator` when `mode !== "live"` (byte-for-byte paper). `simulateEntry`, `simulateExit`,
`estimateExecutableExit` always delegate to the simulator, even in live.

`constructor(deps: {cfg, simulator, quotes: BoxQuoteStore, manager?, broker?(), allocateTradeId?(), isTokenWarm?(token), feedGeneration?(), now?(), chargeTotal?(orders)})` (`:139-162`).

### 4.1 Identity helpers

- `boxClientOrderId({tradeId, purpose, role, attempt})` (`brokerAdapter.ts:269-277`) = `BOX:<tradeId>:<purpose>:<role>:<attempt>` where numeric attempt → `attempt-<n>`.
- `stableAttemptId(scope, at, purpose)` (`executionGateway.ts:1112-1114`) = `<purpose.toLowerCase()>-<stableHash(scope:at:purpose)>`;
  `stableHash` (`:1116-1123`) = 32-bit FNV-1a (offset `0x811c9dc5`, prime `0x01000193`, `Math.imul`), iterating `for (const char of value)` and XOR-ing `char.charCodeAt(0)` (code-point iteration, first UTF-16 unit), output `(hash>>>0).toString(36)`.
  Go: iterate runes, use `utf16.Encode([]rune{r})[0]`, uint32 multiply, `strconv.FormatUint(uint64(h), 36)`.
- Entry attempt `entry-<h>` from `(candidate.key, detection.at)`; client ids `BOX:<tradeId>:ENTRY:<role>:entry-<h>`. Unwind attempt `entry-<h>:unwind`; economics unwind `entry-<h>:economics-unwind` (both purpose EMERGENCY_RESIDUAL, phase unwind).
  Exit attempt `exit-<h>` from `(position.id, detectedAt)`. Residual base `residual-<role-lowercased>-<h>` from `(keyPrefix, residual.created_at, "RESIDUAL-<role>")`, attempt id `<base>-attempt-<N>`.
  Determinism ⇒ a re-run of the same decision maps onto the same durable intent (create-or-adopt), which is the cross-restart duplicate-execution protection.
- `request(args)` (`:900-946`): `buildOrderPricing({side, quantity, referencePrice, tickSize: inst.tick_size ?? cfg.defaultTickSize,
  maxChaseTicks: min(cfg.liveMaxChaseTicks, phase==="unwind" ? cfg.unwindMaxChaseTicks : cfg.legMaxChaseTicks)})`; LIMIT only.

### 4.2 `hasCapacity()` (`:164-172`)
Paper → `simulator.hasCapacity()`. Live → no manager ⇒ false; else `status.inFlight === 0 && status.queued === 0` (global binary gate between pipelines).

### 4.3 Live entry `simulateLeggingEntry(args)` (`:178-411`) — leg ordering and abort rules

1. `singleLotCandidateViolation(candidate)` (`singleLotInvariant.ts:16`) ⇒ invariantViolation + failure `insufficient_quantity`.
2. attemptId; `tradeId = allocateTradeId()`; missing ⇒ invariantViolation + `legging_incomplete`.
3. **Checkpoint 1 `pre_build`** (`entryGuardRefusal` uses only `stillWanted`, other inputs true, `:413-430`). Refusal ⇒ `refusedBeforeSubmit` (failure_reason `discovery_stopped`, outcome_class `REFUSED_BEFORE_SUBMIT`, no intents created).
4. Build 4 requests in **hedge-first order** (`entrySubmissionOrder`), qty = `candidate.lot_size`, reference = detection leg price (null ⇒ throw). `precheck(requests)` (§4.5). Throw ⇒ failure `insufficient_quantity`.
5. Capital: `evaluateEntryCapital(requests, candidate, "pre_submit")` (live cap `cfg.liveMaxBoxCapitalRupees`, paper `cfg.paperMaxBoxCapitalRupees`); refused ⇒ `box_capital_limit`. Stamp `{candidate_key, box_notional_paise, configured_max_rupees, checked_at}`.
6. **Checkpoint 2 `pre_enqueue`** ⇒ refusedBeforeSubmit.
7. `Promise.allSettled(requests.map(r => manager.submit(r, stamp, capitalStamp, {stillWanted, transportRank, hedge, hedgeCount})))` — all four are enqueued in the same turn in rank order (FIFO sequence ⇒ rank 0 dequeued first).
8. `orders = canonicalRoleOrder(ordersFromSettled(settled))` (fulfilled values + `.order` of ambiguous / persistence-after-fill rejections, `:1392-1402`).
9. **Uncertain** if any rejection is `OrderPersistenceAfterFillError` or message matches `/unknown|ambiguous|reconcil/i`, or any order UNKNOWN/RECON ⇒ invariantViolation, failure `legging_incomplete` ("broker terminal quantity is uncertain; entry quarantined"). No unwind.
10. `fullyFilled = orders.length === requests.length && every filled >= quantity` (`>=`: overfill counts as filled).
11. Not fully filled ⇒ `planPartialEntryRecovery` (§5): `quarantine_unknown`/`await_terminal` ⇒ invariantViolation + outcome `QUARANTINED_UNKNOWN`; `no_exposure` ⇒ no unwind, outcome `NO_FILL`;
    else `unwindConfirmed` then residual = entry fill − unwind fill per role; `verifyEntryConservation`; outcome `PARTIAL_ENTRY_RESIDUAL` (residual>0) or `PARTIAL_ENTRY_UNWOUND`. failure `legging_incomplete`.
12. 4/4 filled: `evaluation = evaluationFromFills` (gross = round2((dirSign·box_width − Σ(±avg)) · lot)); `measured = slippageFromFills` (Σ (BUY: fill−detected, SELL: detected−fill)·filled, round2);
    `decision = args.qualify(evaluation, measured)`. **Abort-after-fill**: `!decision.qualifies` ⇒ `unwindConfirmed(... ":economics-unwind")`, residual, conservation check,
    failure `abort_after_fill`, `abort_after_fill=true`, outcome `FILLED_THEN_ECONOMICS_ABORT`, final/required expected net profit stamped.
13. Else outcome `OPENED`, `{ok:true, evaluation, decision, legging}`.
Once 4/4 are filled, no stillWanted / lease signal can abort; only `qualify` economics can.

`unwindConfirmed(orders, instruments, tradeId, attemptId)` (`:1016-1050`): **sequential** per order with filled>0: reverse side; reference = `touchPrice(reverseSide, bids, asks)` (none ⇒ invariantViolation, skip);
request qty = **exact filled_quantity**, purpose EMERGENCY_RESIDUAL; precheck; `await manager.submit`. On throw: persistence-after-fill ⇒ keep its order; always invariantViolation("protective unwind failed …").

`verifyEntryConservation` (`:471-524`): `verifyQuantityConservation` per role; violation ⇒ `manager.invariantViolation` (raised outside the try); check failure itself ⇒ its own violation message.

`liveEntryFailure(...)` (`:1145-1172`) / `liveRecord(...)` (`:1174-1217`) build the `PaperLeggingExecutionRecord` shape (mode "live", `submitted_leg_count = 4` for entries, `emergency_unwind = !opened && any filled`, timing fields from `updated_at`); residual defaults to every filled entry order (source `partial_entry`).
`paperLeg(order)` (`:1219-1270`) maps state: COMPLETE→FILLED; CANCELLED→PARTIALLY_FILLED if filled>0 else CANCELLED; REJECTED→FAILED; else PENDING. Pricing `order_type` always `"MARKETABLE_LIMIT"` in this projection.

### 4.4 Live exit `simulateLeggingExit(args)` (`:530-581`)
Requests only for `outstandingRoles(position)` (`positions.ts:270`, exact remaining qty per role), side `exitSideFor(role, direction ?? "LONG_BOX")`, reference = detection price ?? 0.
None ⇒ `{ok:false, reason:"legging_incomplete", detail:"position already flat"}`. precheck throw ⇒ `insufficient_quantity`. Submit all with `allSettled` (no entry guard, no capital).
Uncertain = any rejection that is NOT `BrokerPreSubmitRefusedError`, or any UNKNOWN/RECON order ⇒ invariantViolation. Clean = !uncertain && count match && every filled ≥ qty ⇒ ok; else `legging_incomplete` ("exit terminal quantity uncertain; position moved to recovery" | "live exit partially filled").

### 4.5 Feed authority

`precheck(requests)` (`:978-1014`): `feedGeneration = deps.feedGeneration?.() ?? 0`. Live with `isTokenWarm` false ⇒ throw "<sym> has not received a WebSocket tick in the current feed generation.";
no quote ⇒ "<sym> has no live depth."; if `isTokenWarm` is wired: age not finite/<0/> `cfg.quoteMaxAgeMs` ⇒ "<sym> has no current executable depth.";
`walkDepth({side, levels: BUY?asks:bids, remainingQty: qty, limitPrice, queueModel: cfg.queueModel, haircutPct: cfg.queueLiquidityHaircutPct, at, quoteVersion})`;
`executable_within_limit < qty` ⇒ throw "<sym> has <n> safe quantity within bounded limit; needs <qty>.". Stamp `{token, feed_generation, quote_version, quote_at, checked_at}`.

`checkedFeedBlockReason(args)` (exported, `:89-128`) — installed as the manager's `revalidateQueuedRequest` (engine). Refusal order: no stamp; token mismatch; generation changed; token not current;
no quote; `quote.version < stamp.quote_version || quote.at < stamp.quote_at` or non-safe-int version ("identity regressed"); `checked_at` invalid / < quote_at / > now, or age invalid / > quoteMaxAgeMs ("stale");
walkDepth executable < qty ("no longer covers bounded order quantity"). A newer book in the same generation is accepted if it still covers the immutable qty within the immutable limit.

### 4.6 Live residual flatten `flattenResidual(args)` (`:598-721`) — see §6 for the state machine

Per residual, sequentially `flattenOneResidual` (`:741-853`):
1. `base = stableAttemptId(keyPrefix, residual.created_at, "RESIDUAL-<role>")`; `firstAdoptableResidualAttempt(manager, keyPrefix, residual, base, residualFlattenAttempt(residual))` (`:855-894`):
   probe durable intents for attempts `first .. first+63` (`MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE = 64`, `residualFlatten.ts:56`): read error ⇒ use current; absent ⇒ use it;
   REJECTED with `hasDurableLocalNoPostProvenance` ⇒ skip to next; other REJECTED / COMPLETE / CANCELLED ⇒ return with `terminalIntent`; working/ambiguous ⇒ reuse (no terminal). Exhausted ⇒ `first+64`.
2. terminalIntent present ⇒ project `brokerOrderFromDurableIntent` (REJECTED ⇒ fail `broker_rejected`; else `classifyResidualOrder`). No POST.
3. Reducing side = opposite of residual side; reference = touch; refuse (`no_executable_book`, identity reused) if no reference, token not warm, no quote, or (when isTokenWarm wired) age > quoteMaxAgeMs.
4. Build request (synthetic instrument: exchange ?? "NFO", type from role suffix, lot = residual qty), purpose EMERGENCY_RESIDUAL, `attemptId = residualFlattenAttemptId(base, attempt)`. precheck (throw ⇒ `no_executable_book`). `await manager.submit` (no checkedFeed bypass: reduction still needs fresh depth & same generation, but NOT entry warm-up, discovery or reservations).
5. Error mapping: `OrderPersistenceAfterFillError` ⇒ `persistence_after_fill` (with order); `BrokerPreSubmitRefusedError` ⇒ `local_pre_submit_refused`; `BrokerOrderRejectedError` ⇒ `broker_rejected`;
   `BrokerAmbiguousSubmitError` ⇒ `broker_state_unknown`; else `classifyResidualFlattenErrorMessage(msg)`. Non-terminal returned order ⇒ `broker_state_unknown`.
   `residualFailureIsInvariant(kind)` ⇒ `manager.invariantViolation("residual <prefix> <role> attempt-<N> [<kind>]: <phrase> — <detail>")`.

Accounting per pass (`:608-711`) — cumulative watermarks on the residual (`flatten_accounted_filled`, `flatten_accounted_charges`):
- Watermarks are used only if `pass.attempt === residualFlattenAttempt(residual)` (same generation). Legacy = both undefined. Invalid (non-finite/negative or only one present) ⇒ invariantViolation, disposition `adopt_attempt`, normalise (keep positive fill watermark else 0).
- Legacy with an order: `accountedFilled = max(0, order.quantity − residual.quantity)`, `accountedCharges = residualCumulativeCharges(order, accountedFilled, 0)`.
- `brokerCumulativeCharges = residualCumulativeCharges(order, brokerFilled, accountedCharges)` (= round2(chargeTotal([{side, symbol, qty: filled, price: avg}])) when filled>0 and avg non-null, else fallback).
- Regression if brokerFilled non-finite, < accountedFilled, < 0, or > order.quantity; or `fillDelta > residual.quantity` ⇒ invariantViolation, `adopt_attempt`, watermarks unchanged.
- Else `fillDelta = brokerFilled − accountedFilled`, `chargeDelta = round2(max(0, brokerCharges − accountedCharges))`, new watermarks `filled = brokerFilled`, `charges = max(accounted, broker)` (monotonic).
- `outstanding = residual.quantity − fillDelta`; >0 ⇒ `carryResidualForward(residual, outstanding, attempt, disposition, {cumulativeFilled, cumulativeCharges})`.
- Result `{flattened_by_role, flatten_charges (round2 sum), remaining, legs: orders.map(paperLeg)}`.

`hasDurableLocalNoPostProvenance(intent)` (`:1097-1110`): state REJECTED, filled 0, broker_order_id null, and some audit event to REJECTED with payload `{origin:"local_pre_submit_refusal", no_broker_post:true, stage ∈ {dequeue, post_persist, pre_post}}`.

---

## 5. Partial-entry recovery (`partialEntryRecovery.ts`) — pure planner

`EntryLegOutcome {role, side, requested, confirmedFilled, terminal, submitted, brokerStateKnown}`. Gateway projection `entryLegOutcomes` (`executionGateway.ts:1322-1352`):
missing order ⇒ `{confirmedFilled:0, terminal:true, submitted:false, brokerStateKnown:true}`; present ⇒ provable = state ∉ {UNKNOWN, RECON}; terminal = brokerStateKnown = provable (a settled PARTIALLY_FILLED is terminal).

`planPartialEntryRecovery({legs, expectedRoles})` (`:130-263`) — per expected role: missing/unsubmitted ⇒ stopSubmit, not met, confirmed 0;
filled = finite ? max(0, confirmed) : 0; `!brokerStateKnown` ⇒ quantityUnknown; `!terminal` ⇒ cancel + awaitTerminal; `filled < requested` ⇒ not met.
Precedence: all met (and roles>0) ⇒ `qualify_complete_box`; quantityUnknown ⇒ `quarantine_unknown`; awaitTerminal non-empty ⇒ `await_terminal`; total 0 ⇒ `no_exposure`;
else `unwind_confirmed_exposure` with `unwind = [{role, side: reverseSide(side), quantity: filled}]` for filled>0. Detail strings are fixed text (see file).

`verifyQuantityConservation({entry, unwoundByRole})` (`:310-376`): per leg confirmed (non-finite→0), residual = confirmed − unwound; violations: `overfill` (confirmed > requested), `unwound_more_than_confirmed`, `negative_residual`;
residual clamped ≥0 for totals; `conserved = no violations`; `requiresRecovery` if any.

---

## 6. Residual flatten state machine (`residualFlatten.ts`)

- `FIRST_RESIDUAL_FLATTEN_ATTEMPT = 1` (`:49`), `MAX_RESIDUAL_FLATTEN_ATTEMPT_PROBE = 64` (`:56`).
- `residualFlattenAttempt(residual)` (`:132-137`): `flatten_attempt` finite ⇒ max(1, floor) else 1. `residualFlattenAttemptId(base, n)` (`:147-149`) = `<base>-attempt-<max(1, floor(n))>`.
- Dispositions (`:65-86`): `flattened` (done), `retire_attempt` (identity spent ⇒ next pass N+1, watermarks reset to 0), `reuse_attempt` (nothing sent ⇒ same N), `adopt_attempt` (working/unknown/rejected ⇒ same N, reconcile).
- `carryResidualForward(residual, qty, attempt, disposition, accounting?)` (`:167-191`): next attempt = retire ? N+1 : N; watermarks: retire ⇒ 0; else accounting value ?? existing; undefined ⇒ field deleted.
- `classifyResidualOrder(order, requested)` (`:201-208`): non-terminal ⇒ adopt; REJECTED ⇒ adopt; filled ≥ requested ⇒ flattened; else retire.
- `classifyResidualFlattenErrorMessage(msg)` (`:218-229`): `/reused with different immutable field/i` ⇒ identity_conflict; `/already queued or active/i` ⇒ already_in_flight;
  `/unknown|ambiguous|reconcil|timed? ?out/i` ⇒ broker_state_unknown; `/quantity limits|exposure management|controls or limits|exposure changed while|disabled while/i` ⇒ gate_refused; else unexpected.
- `dispositionForFailure(kind)` (`:232-258`): no_executable_book, gate_refused, already_in_flight ⇒ reuse; local_pre_submit_refused ⇒ retire; broker_rejected ⇒ adopt;
  identity_conflict ⇒ retire; persistence_after_fill, broker_state_unknown, unexpected ⇒ adopt.
- `residualFailureIsInvariant(kind)` (`:284-289`): persistence_after_fill | broker_state_unknown | identity_conflict | unexpected.
- Rule: same logical submission ⇒ same identity; new attempt on outstanding qty ⇒ new identity; `flatten_attempt` advances only after a terminal broker result (partial ⇒ retire) or a proven local no-POST REJECTED. Partial retries submit the exact remainder.
- Residual flattening is not reservation-gated and not entry-guarded; it requires `canManageExposure()` and the reduction-side/quantity checks in the manager.

---

## 7. Execution-related config defaults (`config.ts`, used throughout)

| key → field | default | clamp | line |
|---|---|---|---|
| BOX_EXECUTION_COORDINATOR_ENABLED → executionCoordinatorEnabled | true | bool | 924 |
| BOX_CONFLICT_WAIT_MAX_MS → conflictWaitMaxMs | 250 | 0..5000 | 927 |
| BOX_INSTRUMENT_LOCK_TTL_MS → instrumentLockTtlMs | 5000 | 250..60000 | 930 |
| BOX_MAX_CONCURRENT_PER_UNDERLYING → maxConcurrentPerUnderlying | 2 (0 disables) | 0..16 | 931 |
| BOX_CONFLICT_REVALIDATE_MIN_EDGE_RATIO → conflictRevalidateMinEdgeRatio | 0.8 | num (unclamped) | 932 |
| BOX_RESERVATION_REQUIRE_DURABLE | false | bool | 936 |
| BOX_DURABLE_RESERVATIONS_ENABLED | true | bool | 941 |
| BOX_RESERVATION_RENEW_INTERVAL_MS | max(250, floor(TTL/3)) (=1666) | 100..30000 | 944-949 |
| BOX_RESERVATION_CLOCK_SKEW_GRACE_MS | 250 | 0..5000 | 952 |
| BOX_RESERVATION_UNCERTAIN_HOLD_MAX_MS | 60000 | 1000..600000 | 955 |
| BOX_RESERVATION_OWNERSHIP_MARGIN_MS | max(250, round(BOX_EXECUTION_MAX_WAIT_MS=1500)) | 0..30000 | 959-963 |
| BOX_SIMULATED_DECISION_MS / BOX_SIMULATED_LATENCY_MS / BOX_EXECUTION_MAX_WAIT_MS | 40 / 250 / 1500 | num | 917-919 |
| BOX_MAX_CONCURRENT_EXECUTIONS → maxConcurrentExecutions (paper standard) | 8 | **num, unclamped** | 921 |
| BOX_PAPER_CANCEL_LATENCY_MS / BOX_PAPER_PERSISTENCE_MS | 150 / 0 | 0..60000 | 1000-1001 |
| BOX_LIVE_RECONCILE_INTERVAL_MS | 60000 | 5000..900000 | 1018 |
| BOX_LIVE_FEED_RECONNECT_WARMUP_MS | 5000 | 0..300000 | 1019 |
| BOX_LIVE_MAX_OPEN_BOXES | 1 | 0..20 | 1020 |
| BOX_LIVE_MAX_CONCURRENT_EXECUTIONS | 1 | 1..4 | 1021 |
| BOX_LIVE_MAX_RESIDUAL_LEGS | 1 | 0..4 | 1022 |
| BOX_LIVE_DAILY_LOSS_LIMIT | 5000 (0 disables) | 0..1e7 | 1023 |
| BOX_LIVE_REJECT_LIMIT / BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT | 3 / 3 | 1..100 | 1024-1025 |
| BOX_LIVE_MAX_OPEN_LEG_QUANTITY / _GROSS_ | 100 / 400 | 1..1e6 / 1..4e6 | 1026-1027 |
| BOX_LIVE_HTTP_TIMEOUT_MS / ACK / WORKING / PARTIAL / CANCEL | 5000 / 3000 / 30000 / 10000 / 5000 | 250..30000 / 250..30000 / 1000..600000 / 500..300000 / 250..60000 | 1028-1032 |
| BOX_LIVE_MAX_MODIFICATIONS | 2 (ceiling only; manager never modifies) | 0..10 | 1033 |
| BOX_LIVE_MAX_CHASE_TICKS | 2 | 0..20 | 1034 |
| BOX_LIVE_BROKER_MIN_INTERVAL_MS | 250 | 50..5000 | 1035 |
| BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS | 0 (derive) | 0..5000 | 1038 |
| BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY | 1 | 1..4 | 1040-1045 |
| BOX_LIVE_MAX_BOX_CAPITAL_RUPEES / BOX_PAPER_MAX_BOX_CAPITAL_RUPEES | 0 (disabled) | 0..1e9 | 1049, 1053 |
| BOX_ONE_ACTIVE_BOX_PER_UNDERLYING | false | bool | 1051 |
| BOX_SESSION_MAX_COMPLETED_TRADES | 0 (disabled) | 0..10000 | 1052 |
| BOX_LEG_EXECUTION_MODE | `parallel` (`sequential` only if exactly that) | | 1054-1057 |
| BOX_LEG_TIMEOUT_MS / BOX_LEG_UNWIND_LATENCY_MS | 500 / 150 | num | 1059-1060 |
| BOX_LEG_MAX_CHASE_TICKS / BOX_UNWIND_MAX_CHASE_TICKS | 2 / 5 | 0..100 / 0..200 | 1065-1066 |
| BOX_DEFAULT_TICK_SIZE | 0.05 | | 1068 |
| BOX_QUEUE_MODEL / BOX_QUEUE_LIQUIDITY_HAIRCUT_PCT | `haircut` / 30 | pct | 1075-1076 |
| BOX_QUOTE_MAX_AGE_MS | 15000 | num | 1099 |

---

## 8. `CoordinatedBoxExecutionGateway` (`executionCoordinator.ts`) — decorator over the gateway

Deps (`CoordinatorDeps`, `:221-269`): `inner, reservations (chain), local?, waitable?, cfg, quotes, broker(), generation?(), identity?, activeUnderlyings?() (SYNC), sessionEntryGate?() (SYNC),
now?, sleep?, setTimer?, clearTimer?, log?`. `DEFAULT_POLL_MS = 100` (`:271`). Reason tokens: `DURABLE_UNAVAILABLE_REASON = "durable_reservation_unavailable"`, `STALE_GENERATION_REASON = "stale_broker_generation"` (`:142-143`).
Jitter seed (`:398-406`): `seed = (imul(seed,31) + charCode) >>> 0` over `identity.processTag`.

### 8.1 Coordination states (`CoordinationState`, `:122-137`, observational only)
`RESERVED, WAITING_FOR_INSTRUMENT, REVALIDATING, EXECUTING, ABORTED_DETERIORATED, EXPIRED_WHILE_WAITING, SUPPRESSED_DUPLICATE, REFUSED_NO_COORDINATION, REFUSED_DURABLE_UNAVAILABLE, OWNERSHIP_LOST, ABORTED_STALE_GENERATION`.
(Declared vocabulary; the implementation expresses them through log `status` strings: `suppressed_duplicate, suppressed_session_limit, suppressed_underlying_active, waiting, expired_while_waiting, abort, execute, failed_closed, local_only, exit_conflict, exit_local_only, ownership_lost, reservation_held, reservation_hold_expiring, reservation_hold_renew_unavailable, reservation_hold_lost, underlying_claim_*`.)

Execution lifecycle per entry: **claimed** (sync `claim`, lease null) → **leased** (`grant`) → **settled** (clean ⇒ release lease; uncertain ⇒ moved to `holds`) or **abandoned** (any refusal).

### 8.2 `coordinateEntry(candidate, detection)` (`:676-1014`) — exact order

1. `executionId = mintId("entry")`; `opportunityId = "<BROKER upper>:<candidate.key>"`; context `{deployment, broker, generation, mode}`.
2. Fail closed (live only): `reservationRequireDurable && !reservations.durable` ⇒ `{reason:"feed_unhealthy", detail:"live execution refused: BOX_RESERVATION_REQUIRE_DURABLE is set but …"}`.
3. **Synchronous prologue** (no await allowed until `claim`):
   a. duplicate guard: `activeOpportunities[opportunityId]` exists and still in `active` ⇒ `duplicate`.
   b. session gate `sessionEntryGate()` not allowed ⇒ `session_limit_reached` (detail from gate).
   c. if `oneActiveBoxPerUnderlying`: Layer 1a `evaluateUnderlyingAdmission({enabled:true, underlying, active: activeUnderlyings()})` ⇒ `underlying_already_active`.
   d. if `oneActiveBoxPerUnderlying`: Layer 1b `await holdUnderlying(underlying, "pipeline:<execId>", exclusive=true)` — **this IS an await before `claim`** (see §8.8).
   e. per-underlying budget: `maxConcurrentPerUnderlying > 0` and count of `active` with same underlying ≥ budget ⇒ `duplicate` ("per-underlying execution budget reached (n/m)").
   f. `claim(executionId, opportunityId, underlying, keys, context)` — `active.set`, `activeOpportunities.set`.
4. `acquire` (chain `tryAcquireAll`, ttl `instrumentLockTtlMs`); throw ⇒ abandon + rethrow.
5. `unavailable` ⇒ `handleUnavailable` (`:1116-1177`): live ⇒ refuse `feed_unhealthy` "durable_reservation_unavailable: live entry refused …"; paper with `local` ⇒ `acquireWith(local)` (count `localOnlyFallbacks`); no local ⇒ refuse.
6. `conflict` ⇒ `waitForKeys` (`:1231-1260`): deadline = start + `conflictWaitMaxMs`; each round: subscribe `waitable.onRelease(keys)`, race against `sleep(min(pollDelay(), max(1, deadline-now)))`, unsubscribe, retry acquire; return on acquired/unavailable; else loop. Timeout ⇒ `price_moved` ("waited Nms for a shared contract and gave up").
   `pollDelay()` (`:1276-1292`): `jitterSeq++`; `mixed = imul(seed ^ seq, 2654435761) >>> 0`; `frac = (mixed % 1024)/1024`; `round(100 * (0.8 + 0.4*frac))` ⇒ 80..120 ms.
   After a successful wait: **revalidate** (`:1294-1320`) with `evaluateCandidate({candidate, quotes.view(), now, maxAgeMs: quoteMaxAgeMs, captureDepth:false})`:
   not tradable ⇒ `not_tradable:<reject>`; edge null ⇒ `edge_unpriced`; edge ≤ 0 ⇒ `edge_gone`; detected edge >0 and `edgeNow/before < conflictRevalidateMinEdgeRatio (0.8)` ⇒ `edge_deteriorated:<round(pct)>%`.
   Failure ⇒ release lease, `edge_disappeared`.
7. Still not acquired (e.g. local fallback unavailable) ⇒ `feed_unhealthy` (fail closed).
8. `confirmBeforeSubmit` (`:1179-1222`): broker or generation changed ⇒ `stale_broker_generation`; if waited AND lease durable ⇒ `reservations.verify({owner, keys, now, fence, context})`; not owned ⇒ `stale_broker_generation` (reason superseded) or `reservation_ownership_lost`. Failure ⇒ release lease, `feed_unhealthy` with token prefix.
9. `grant` ⇒ attach lease, ensureHeartbeat.

### 8.3 Entry wrapper (`simulateLeggingEntry` `:476-517`, `simulateEntry` `:519-554`)
Coordinator disabled ⇒ pass-through. Gate refusal ⇒ `{ok:false, reason, detail, legging: emptyLeggingRecord(...)}`. Else inner call with `stillWanted = ownershipGuard(execId, args.stillWanted)`.
After result: `uncertainty = uncertaintyOf(result)`; `settleUnderlyingHold({established: ok, tradeId: legging.trade_id, retainForUncertainty})`; `settle(execId, opportunityId, uncertainty)`. Throw ⇒ `holdOnUncertainty(…, "entry threw")` then rethrow.
`uncertaintyOf(result)` (`:2120-2140`): non-object ⇒ uncertain; residual_exposure non-empty ⇒ uncertain; ok ⇒ clean; reason `legging_incomplete`|`unwind_failed` ⇒ uncertain; else clean (abort_after_fill fully reversed is clean).

### 8.4 Ownership guard (`:1681-1695`)
`() => inner false ⇒ false; exec missing ⇒ false (fail closed); lease null ⇒ true; ownershipLost ⇒ false; now < lease.expiresAt − reservationOwnershipMarginMs`. ENTRY only — never composed into exits or residual flatten.

### 8.5 Exits (`simulateLeggingExit` `:569-615`, `simulateExit` `:617-653`)
Refs on the reverse side of each entry side; `acquireForExit` (`:655-674`): chain; on `unavailable` fall back to `local` tier (logged `exit_local_only`). Conflict/unavailable ⇒ no waiting, return
`{ok:false, reason:"insufficient_quantity", detail:"exit deferred: <n> leg(s) reserved by another execution" | "exit deferred: <detail>"}` (monitor retries next cycle). `registerActive` then inner call (no ownership guard); settle with `uncertaintyOf` (simulateExit always "clean"); throw ⇒ hold.
Exits take neither the duplicate guard, session gate, budget nor underlying lock.

### 8.6 Heartbeat / renewal (`ensureHeartbeat` `:1697-1714`, `renewTick` `:1737-1886`)
Interval `reservationRenewIntervalMs` (setInterval, unref); started when any of active/holds/positionClaims non-empty; stopped when all empty. `renewTick` is non-reentrant (`heartbeatRunning`).
Uses the CURRENT context (broker/generation) for every renewal.
1. Active executions: renewed **concurrently** (`allSettled`); success ⇒ update expiresAt/fence; failure ⇒ `ownershipLost=true`, stats, log, `inner.invariantViolation("box reservation ownership <reason> mid-execution (<detail>)")`.
2. Uncertain holds (sequential): age ≥ `reservationUncertainHoldMaxMs` ⇒ drop from map (NOT released; left to expire); renew; `unavailable` ⇒ keep; other failure ⇒ drop.
3. Position claims (sequential): renew forever; failure ⇒ `ownershipLost=true` (logged once) but claim kept.
`renewLease` (`:1888-1917`): `local_only` lease renews against `local`, else chain.

### 8.7 Settle / hold / release (`:1919-1964`, `releaseLease` `:1613-1627`)
`settle(clean)` ⇒ abandon + `releaseLease` (chain release `{owner, keys, fence}` plus `local.release({owner})` if local is a separate object). `settle(uncertain)`/`holdOnUncertainty` ⇒ abandon + `retain`: lease kept in `holds` with `heldSince` only if lease non-null and not ownershipLost.
`resetForBrokerSwitch()` (`:1981-1994`): `reservations.clear()` (this process's rows only), `local.clear()`, clear active/holds/positionClaims/activeOpportunities. `holdsReservations` getter. `dispose()` stops heartbeat.
`liveEntryBlockedReason()` (`:2011-2020`): live only; require-durable && !durable; or `durableReservationsEnabled && !reservations.ready` ⇒ "durable_reservation_unavailable: the durable reservation authority is not ready".
`mintId(kind)` ⇒ `mintOwnerId(identity, kind, ++seq)` (globally unique, §9.2).

### 8.8 Underlying claims (Layer 1b/1c, `:1418-1611`)
- Claim key `"<BROKER>:<UNDERLYING>"` (trim+upper). Holders: `pipeline:<execId>`, `trade:<tradeId>`, `residual:<attemptId>`.
- `holdUnderlying(underlying, holder, exclusive)`: disabled ⇒ false. Existing in-process claim: exclusive ⇒ false, else add holder ⇒ true. Else owner `mintId("underlying")`, acquire a single `underlyingLegRef(broker, underlying, "k1_ce")` key through the chain; not acquired ⇒ false (`positionClaimFailures++`); store claim; ensureHeartbeat. Never throws.
- `dropUnderlyingHolder`: remove holder; when empty delete claim, `releaseLease(owner, lease)`.
- `settleUnderlyingHold`: established with tradeId ⇒ add `trade:` holder BEFORE dropping `pipeline:` (re-acquire non-exclusively if the claim vanished); uncertain ⇒ keep pipeline holder (return); always else drop pipeline holder.
- Public: `claimUnderlyingForPosition(u, tradeId)`, `releaseUnderlyingForPosition`, `claimUnderlyingForResidual(u, attemptId)`, `releaseUnderlyingForResidual`, `claimedUnderlyings()`.
- AMBIGUITY / Go note: `holdUnderlying` checks `positionClaims` synchronously then awaits the acquire before inserting; two concurrent non-exclusive callers in one process can both miss the map, the second then loses at the store (same key, different owner) and returns false (degraded protection, logged). The comment "no await between guards and claim()" is violated by step 3d when the underlying lock is on; exclusivity of the underlying key (store-level) is what still blocks a same-underlying duplicate. In Go, take one mutex around 3a–3f including an in-memory "pending underlying" marker, or accept identical semantics knowingly.

### 8.9 Node single-thread assumptions (coordinator)
- Prologue 3a–3f relies on run-to-completion; Go needs a coordinator mutex held from the duplicate check through `claim`.
- `active`, `holds`, `positionClaims`, `activeOpportunities`, `stats` mutated from heartbeat callbacks and request paths ⇒ mutex.
- `renewTick` overlap guard is a boolean flag ⇒ use `atomic.Bool`/mutex or a single ticker goroutine.
- Timer ordering: waiter wakeups race an in-memory release emitter vs a jittered timer; release emitter fires synchronously inside `release()` (§9.4) so in-process waiters retry before the releasing call returns to its caller's next statement.

---

## 9. Reservation system (`src/box/reservations/*`, `instrumentKey.ts`)

### 9.1 Keys and conflict rules (`instrumentKey.ts`)
- `instrumentKey(broker, inst)` (`:67-77`): `"<BROKER upper>:<EXCHANGE upper (default NFO)>:<tradingsymbol trimmed>"`, or `"<BROKER>:TOKEN:<token>"` when no symbol.
- `boxInstrumentRefs(broker, legs, sideFor, roles)` (`:93-112`) → refs `{key, role, side, token, tradingsymbol, exchange}` **sorted by key** (byte order). `keysOf(refs)` dedupes preserving order (`:115-124`).
- `classifyConflict(key, heldBy, incumbentSide, challengerSide)` (`:142-153`): `opposite_side` iff incumbent side known and different, else `same_side`. Diagnostics only: **any** overlap on a key conflicts regardless of side.
- Entry refs use entry sides; exit refs use reversed sides (`executionCoordinator.ts:1322-1359`). The underlying key is a separate single-key reservation (§10).

### 9.2 Identity (`reservations/identity.ts`)
- `resolveDeploymentId(env)` (`:60-66`): `CALSPREAD_DEPLOYMENT_ID` sanitised, else `NODE_ENV`, else `"development"`. Sanitise (`:42-46`): replace `/[^A-Za-z0-9._-]+/g` with `-`, trim leading/trailing `-`, max 64 chars, empty → fallback.
- `createProcessIdentity(env)` (`:93-113`): instance = sanitise(`CALSPREAD_INSTANCE_ID` || hostname() || "unknown-host", max 40); with `NODE_APP_INSTANCE` → `<instance>-w<n>` (max 48);
  `boot = randomUUID()` without dashes, first 8 chars; `processTag = "<instance>:p<pid>:<boot>"`.
- `mintOwnerId(identity, kind, seq)` (`:122-125`) = `"<deployment>:<processTag>:<sanitise(kind, max16)>-<seq base36>:<randomUUID()>"`.
- `processOwnerPrefix(identity)` = `"<deployment>:<processTag>:"`; `isOwnedByProcess(owner, identity)` = prefix match.

### 9.3 Store interface (`reservations/types.ts`)
`InstrumentReservationStore` (`:210-281`): `name, durable, ready; tryAcquireAll(AcquireArgs): ReservationOutcome; release(ReleaseArgs): number; renew(RenewArgs): RenewOutcome; verify(VerifyArgs): OwnershipVerdict;
ownerOf(key, now); sideOf(key, now); activeCount(now); activeKeys(now); clear(); diagnostics()`.
- `AcquireArgs {owner, keys, ttlMs, now, sideByKey?, context?}`; `ReleaseArgs {owner, keys?, now, fence?}`; `RenewArgs {owner, keys, ttlMs, now, fence?, context?}`; `VerifyArgs {owner, keys, now, fence?, context?}`.
- `ReservationOutcome`: `{ok:true, owner, keys, expiresAt, fence, durability}` | `{ok:false, reason:"conflict", conflicts:[{key, heldBy, heldSide, tier}]}` | `{ok:false, reason:"unavailable", tier, detail}`.
- `RenewOutcome`: ok `{expiresAt, fence}` | `{reason: "lost"|"expired"|"unavailable", detail}`. `OwnershipVerdict`: owned `{expiresAt, fence}` | `{reason:"expired"|"lost"|"superseded"|"unavailable", detail}`.
- `ReservationContext {deployment, broker, generation, mode}`. `ReservationDurability = "durable" | "local_only"`.
- `ReservationWaitable.onRelease(keys, cb) => unsubscribe`. `BoundedSamples(max=256)` ring, `percentile(p) = sorted[min(n-1, floor(p*n))]` (`:299-316`).
- `normaliseTtl(ttl)` = finite>0 ? floor : **1000** (`:331-333`). `dedupeKeys` order-preserving. `safeErrorMessage(err, max=200)` scrubs `mongodb(+srv)://…` → `mongodb://<redacted>` and `(ZERODHA|DHAN):<...>` → `$1:<contract>`, truncates with `…` (`:345-351`).
  (Go port must scrub `postgres(ql)://…` DSNs the same way.)

### 9.4 In-process tier (`reservations/inProcess.ts`) — name `in-process`, durable=false, ready=true
State: `Map<key, {owner, expiresAt, side, fence}>`, waiters `Map<key, Set<cb>>`, `fenceSeq` (process counter).
- `tryAcquireAll` (`:92-137`): dedupe; for each key: missing ⇒ ok; `expiresAt <= now` ⇒ treat free (count expired); same owner ⇒ ok (re-entrant); else conflict. Any conflict ⇒ return all conflicts, write nothing.
  Else `expiresAt = now + ttl`, `fence = ++fenceSeq`, write every key. Returns durability `local_only`. **Check pass and write pass have no await between them** — atomic per event-loop turn (Go: one mutex).
- `release` (`:139-159`): keys ?? all keys; delete only entries with same owner and (fence undefined or equal); then `notify` each released key **synchronously**.
- `renew` (`:161-194`): every key must exist, same owner (`lost`), `expiresAt > now` (`expired`), fence equal (`lost` "belongs to a newer lease"); then set new expiresAt for all; returns fence of last entry (0 if no keys).
- `verify` (`:196-216`): same checks; zero keys ⇒ `lost`; expiresAt = min over keys.
- `ownerOfSync` deletes+notifies an expired entry; `sideOfSync`; `activeCount/activeKeys` sweep expired (notify); `clear()` drops all + notify. No grace anywhere in this tier.

### 9.5 Chained tier (`reservations/chained.ts`) — `name = tier names joined by "+"` (e.g. `in-process+mongo`)
- `durable` = any tier durable; `ready` = every tier ready; authority = last durable tier (else first).
- Per-owner, per-tier fence bookkeeping `fences: Map<owner, Map<tierName, fence>>` (`:103`).
- `tryAcquireAll` (`:131-176`): tiers in order (local → durable). Throw ⇒ rollback taken tiers (reverse, release `{owner, keys}`), return `unavailable`. Non-ok ⇒ rollback, return that outcome (conflict or unavailable). All ok ⇒ fence/expiresAt from the durable tier (else first), durability durable if any tier durable.
- `release` (`:243-258`): if caller's fence ≠ authority-issued fence ⇒ return 0 (stale). Else release each tier (reverse order) with that tier's OWN fence (`retarget`), swallow errors, return max count; forget fences.
- `renew` (`:269-311`): fence mismatch ⇒ `lost` "the lease has been superseded"; renew every tier with its own fence; any failure ⇒ prefer an `unavailable` failure over others; non-unavailable failure forgets fences. Success ⇒ min expiresAt, durable fence.
- `verify` (`:314-345`): mismatch ⇒ lost; worst failure by rank unavailable(3) > superseded(2) > others(1).
- `ownerOf/sideOf` authority first then local. `activeCount/activeKeys` from tier 0 (local). `clear()` forgets fences then clears tiers (reverse).
- Unanimity: a lease exists only if every tier granted it; ownership questions resolve against all tiers.

### 9.6 Durable tier (`reservations/durable.ts`) — the authority
Constructor defaults (`:190-197`): `skewGraceMs = max(0, deps ?? 250)`, `clockSyncIntervalMs = max(1000, deps ?? 15_000)`, `clockSyncMaxStaleMs = max(interval, deps ?? 150_000)`, `readyRetryMs = max(100, deps ?? 1000)`.
`MAX_SPARE_FENCES = 8` (`:175`). `ready = port.ready && initialised` (not latched: port.ready re-checks the connection each read).
- `initialise()` (`:223-240`): single-flight; `port.ensureReady()` + `syncClock()` ⇒ initialised. `ensureUsable()` (`:249-267`): ready ⇒ true; join in-flight init; else retry init at most every `readyRetryMs`.
- **Clock** (`:273-323`): `offset = round(serverMs − (before + (after−before)/2))`; `toAuthority(local) = local + offset`; `toLocal(auth) = auth − offset`. `refreshClockIfNeeded()`: age < 15 s ⇒ nothing; age ≥ 150 s ⇒ **blocking** re-sync (throw ⇒ caller reports unavailable); else background re-sync (errors counted).
- **Acquire** (`:329-468`):
  1. empty keys ⇒ `unavailable` "refusing to reserve an empty instrument set"; `!ensureUsable()` ⇒ `unavailable`.
  2. `authNow = toAuthority(args.now)`, `authExpiresAt = authNow + ttl`; `fence = spareFences.pop() ?? port.nextFence(deployment)`.
  3. doc `{owner, deployment, broker, generation, mode, keys, sides:[{key, side ?? ""}], fence, instance: ownerPrefix, createdAt=renewedAt=authNow, expiresAt}`.
  4. `insert` ⇒ `owner_exists` ⇒ `deleteOwned({owner})` and insert once more.
  5. `key_conflict` ⇒ `deleteExpired({deployment, keys, notAfter: authNow − skewGraceMs})`; reclaimed > 0 ⇒ insert once more.
  6. `inserted` ⇒ held map, success (expiresAt converted to local), durability `durable`.
  7. Else `findLiveByKeys({deployment, keys, now: authNow})`; if a live doc is ours and ALL live overlapping docs are ours ⇒ success with OUR stored fence/keys (lost-ack retry). Else conflicts (first holder per key), `recycleFence(fence)` (≤8 kept), `conflict`.
  8. Any throw ⇒ `unavailable` (never "free", never "conflict").
- **Release** (`:503-531`): forget held; not ready ⇒ return 0 (expire by TTL); `deleteOwned({owner, fence?})`; error ⇒ 0.
- **Renew** (`:533-604`): `!ensureUsable` ⇒ `unavailable`; `renewOwned({owner, fence?, broker: ctx.broker, generation: ctx.generation, now: authNow, expiresAt: authNow+ttl})`;
  null ⇒ ownershipLost++, forget, `findByOwner` (errors → null): different broker/generation ⇒ `lost` with detail; doc missing ⇒ `lost`; else `expired`. Throw ⇒ `unavailable`.
- **Verify** (`:606-664`): `findByOwner`; missing ⇒ lost; fence ≠ ⇒ lost; `doc.expiresAt − skewGraceMs <= authNow` ⇒ **expired** (holder-side grace); deployment ≠ ⇒ superseded; broker/generation ≠ ⇒ superseded; any requested key not covered ⇒ lost; else owned.
- `ownerOf/sideOf` via `findLiveByKeys` (null when not ready/error). `activeCount/activeKeys` from local `held` (pruned by local expiry).
- `clear()` (`:737-754`): forget held; `deleteByOwnerPrefix(ownerPrefix)` (this process only). `reapExpired()` (`:765-782`): `deleteExpired({deployment, notAfter: authNow − grace})` (all keys) — called at startup by `createReservationStack().initialise()`.
- Expiry asymmetry: holder considers itself owner only while `authNow < expiresAt − grace` (verify) and the coordinator guard additionally requires `now < expiresAt − ownershipMargin`; a challenger may reclaim only when `expires_at <= authNow − grace`; renewal requires `expires_at > authNow` (no grace).

### 9.7 Durable port and the exact database operations (`reservations/port.ts`, `mongoStore.ts`)

Collection `box_instrument_reservations` (`mongoStore.ts:60`), row `{_id: owner, deployment, broker, generation, mode, keys[], sides[{key, side}], fence, instance, created_at, expires_at, renewed_at}` (Dates in authority time).
Collection `box_reservation_fences` (`:61`): `{_id, seq, at}`; docs `fence:<deployment>` and `__clock__`. Indexes created explicitly with `autoIndex:false` (`:248-289`), then read back and verified:
`box_reservation_unique_contract {deployment:1, keys:1} UNIQUE` (multikey ⇒ no `(deployment,key)` pair in two docs), `box_reservation_ttl {expires_at:1} expireAfterSeconds:0` (GC only), `box_reservation_scope {deployment:1, broker:1, generation:1}`.
Missing / non-unique / wrong-key unique index ⇒ `ensureReady` throws ⇒ live entry fails closed. `ready` = connection ready && indexesVerified; a disconnect resets `indexesVerified`.

| port op | Mongo implementation | required PostgreSQL equivalent |
|---|---|---|
| `serverTimeMs()` | `findOneAndUpdate({_id:"__clock__"}, {$currentDate:{at:true}}, upsert)` | `SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint` (not `now()`, which is txn start) |
| `nextFence(dep)` | `findOneAndUpdate({_id:"fence:<dep>"}, {$inc:{seq:1}}, upsert, after)` | `INSERT INTO box_reservation_fences(id, seq) VALUES ($1, 1) ON CONFLICT (id) DO UPDATE SET seq = box_reservation_fences.seq + 1 RETURNING seq` (or a per-deployment SEQUENCE) |
| `insert(doc)` | `insertOne`; dup-key on `_id` ⇒ `owner_exists`; dup-key on `keys`/unique index ⇒ `key_conflict`; unknown dup ⇒ `key_conflict`; other errors throw | ONE transaction: insert parent row (PK owner) + one child row per key into `box_instrument_reservation_keys(deployment, key) PRIMARY KEY/UNIQUE` (FK owner ON DELETE CASCADE). Unique violation on parent PK ⇒ owner_exists, on child ⇒ key_conflict, rollback ⇒ nothing written (all-or-none). An `EXCLUDE … keys WITH &&` constraint would also work but needs GiST support for text[]; the child table is simpler. |
| `deleteExpired({dep, keys?, notAfter})` | `deleteMany({deployment, expires_at:{$lte}, keys:{$in}})` | `DELETE FROM parent WHERE deployment=$1 AND expires_at <= $2 [AND owner IN (SELECT owner FROM keys WHERE deployment=$1 AND key = ANY($3))]` (cascade) |
| `findLiveByKeys({dep, keys, now})` | `find({deployment, keys:{$in}, expires_at:{$gt: now}})` | join on keys table, `expires_at > $now` |
| `findByOwner(owner)` | `findById` | `SELECT … WHERE owner=$1` |
| `deleteOwned({owner, fence?})` | `deleteOne({_id, fence?})` | `DELETE … WHERE owner=$1 [AND fence=$2]` |
| `renewOwned({owner, fence?, broker?, generation?, now, expiresAt})` | `findOneAndUpdate({_id, expires_at:{$gt:now}, fence?, broker?, generation?}, {$set:{expires_at, renewed_at: now}}, after)` | single `UPDATE … SET expires_at=$, renewed_at=$ WHERE owner=$ AND expires_at > $now [AND fence=$] [AND broker=$] [AND generation=$] RETURNING *` — guards in the WHERE, never checked afterwards |
| `deleteByOwnerPrefix(prefix)` | `deleteMany({_id: {$regex: "^"+escaped}})` | `DELETE … WHERE owner LIKE $1 || '%'` with `%`/`_`/`\` escaped (or `starts_with(owner, $1)`) |
| `countLive({dep, now})` | `countDocuments({deployment, expires_at:{$gt}})` | `SELECT count(*) …` |

Also `InMemoryReservationPort`/`InMemoryReservationDatabase` (`memoryStore.ts`, `crossProcess` explicit) model the same semantics for offline tests; port them as the Go test double.

### 9.8 Stack assembly (`reservations/index.ts:62-106`)
`createReservationStack({durableEnabled, context, skewGraceMs?, now?, log?, identity?})`: local = new in-process tier; durable disabled ⇒ `{store: local, durable: null, initialise: async () => false}`;
else `DurableInstrumentReservations({port: new MongoReservationPort(), context, ownerPrefix: processOwnerPrefix(identity), …})`, `store = Chained([local, durable])`,
`initialise()` = `durable.initialise()` then `durable.reapExpired()`; returns `durable.ready`; errors logged ⇒ false (no throw).

### 9.9 Reservation lease state machine (per owner)
`(none)` —tryAcquireAll ok→ **HELD(fence, expiresAt)** —renew ok→ HELD (new expiresAt, same fence) —release→ **RELEASED** (row deleted).
HELD —renew null/fence-mismatch→ **LOST** (coordinator sets ownershipLost, invariantViolation; entry legs refuse) ; HELD —renew unavailable→ **UNKNOWN** (active execution: treated as lost; uncertain hold: kept);
HELD —time passes beyond `expires_at`→ **EXPIRED (logical)**; beyond `expires_at + grace`→ **RECLAIMABLE** by any challenger (deleteExpired) or by `reapExpired` at boot; TTL monitor deletes eventually.
Coordinator wrappers: execution HELD —settle clean→ RELEASED; —settle uncertain / throw→ **UNCERTAIN_HOLD** (renewed up to `reservationUncertainHoldMaxMs`, then dropped from renewal and left to expire, never released); position claim HELD indefinitely until last holder drops.
Fencing tokens: per-deployment monotonic counter (durable) / per-process counter (local); used to pin release/renew/verify to a lease; never sent to brokers. Spare (unused) durable fences are recycled (≤8) after a conflict — a later lease may therefore carry a SMALLER fence than an earlier one from the same process (monotonic allocation, not monotonic use).

---

## 10. Underlying lock (`underlyingLock.ts`) — `BOX_ONE_ACTIVE_BOX_PER_UNDERLYING` (default false)

- `UNDERLYING_KEY_CLASS = "UNDERLYING"` (`:75`), `UNDERLYING_ALREADY_ACTIVE_REASON = "underlying_already_active"` (`:85`).
- `underlyingReservationKey(broker, underlying)` (`:104-108`) = `"<BROKER>:UNDERLYING:<SYMBOL>"` (trim+upper). `parseUnderlyingReservationKey(key)` (`:162-168`): exactly 3 `:` parts, middle `UNDERLYING`.
  `assertNoKeyClassCollision(exchanges)` throws if any exchange is `UNDERLYING`. `underlyingLegRef(broker, underlying, role)` (`:134-154`) side BUY, token 0, exchange `UNDERLYING`.
- Three layers: **1a** `activeUnderlyings(input)` from DURABLE state, checked synchronously; **1b** exclusive pipeline hold (single-key lease) before the contract lease; **1c** position claim (trade/residual holders) renewed indefinitely.
- `activeUnderlyings({positions, residuals, intents, pipelines})` (`:301-348`): position_state RECOVERY ⇒ `recovery`; FLAT or all `remaining_qty_by_role` values 0 (non-empty) ⇒ skip; PARTIALLY_EXITED ⇒ `partially_exited`; else `open_box`;
  residual legs>0 ⇒ `residual_exposure`; intent state UNKNOWN/RECON ⇒ `uncertain_intent`; CREATED/SUBMITTING/ACKNOWLEDGED/OPEN/PARTIALLY_FILLED/CANCEL_REQUESTED ⇒ `working_entry_order`; pipelines ⇒ `entry_in_flight`.
  Kinds sorted; detail `"<U> is already active (<kinds>)"`. Keys normalised trim+upper.
- `evaluateUnderlyingAdmission({enabled, underlying, active})` (`:372-392`); `mayReleaseUnderlyingLease(outcome) = outcome === "clean"` (`:405`).
- Entry only; exits never take it. Engine re-claims at boot for every adopted position/residual (`claimUnderlyingForPosition/Residual`).

---

## 11. Trading session (`tradingSession.ts`, `tradingSessionStore.ts`) — `BOX_SESSION_MAX_COMPLETED_TRADES`

Durable singleton `box_trading_session` `_id:"current"` (`model.ts:973-1026`), fields `session_id, armed_at, armed_by, max_completed_trades, established_trade_ids[], completed_trade_ids[], aborted_attempts, arm_count, updated_at`. **No TTL**.
Load `loadBoxTradingSession()` (`repository.ts:2629-2659`): DB disabled ⇒ `{ok:false}`; missing ⇒ `{ok:true, record:null}`; arrays coerced to string-only. Save `saveBoxTradingSession(record)` (`:2666-2685`): `updateOne({_id:"current"}, {$set: whole record}, {upsert:true})` — **full overwrite, last writer wins, no CAS** (throws on failure).
`loadFlatBoxTradeIds(ids)` (`:2696-2713`): valid ObjectIds with `status:"closed"`; errors ⇒ [].

### 11.1 Derived session states (`BoxSessionState`, `tradingSession.ts:75-91`) — `deriveSessionState(record, activity)` (`:230-243`), precedence:
`RECOVERY` (activity.recoveryActive) → `IDLE` (not armed: `session_id === "" || armed_at === null`) → `EXIT_IN_PROGRESS` → `POSITION_OPEN` (openBoxes>0) → `ENTRY_IN_PROGRESS` →
`COMPLETED` (budget exhausted && completed ≥ consumed) → `BLOCKED` (exhausted || entryBlockedExternally) → `ARMED`.
State is derived, never stored. consumed = `established_trade_ids.length`; completed = `completed_trade_ids.length`; remaining = max>0 ? max(0, max−consumed) : null; exhausted = max>0 && consumed ≥ max.

### 11.2 Transitions (pure functions)
- `armSession({sessionId, maxCompletedTrades, armedBy, previous, now})` (`:279-298`): fresh lists, aborted 0, `arm_count = previous.arm_count + 1`, max = finite ? max(0, floor) : 0. Guard `canArm` (`:256-276`): refuse if recoveryActive, openBoxes>0, residualLegs>0, or consumed−completed>0.
- `disarmSession` (`:306-308`): `armed_at = null` (lists kept).
- `recordEstablishedBox(record, tradeId)` (`:316-324`): append once (consumes a cycle at ESTABLISHMENT, not completion). `recordCompletedBox` (`:333-342`): only if established and not yet completed.
- `recordAbortedAttempt` (`:345-347`): `aborted_attempts++` (gates nothing). `reconcileCompletions(record, flatIds)` (`:360-368`). `inFlightCycleIds` = established − completed.
- `evaluateSessionEntry({record, recoveryActive})` (`:178-208`): recovery ⇒ `session_recovery`; not armed ⇒ `session_not_armed`; exhausted ⇒ `session_budget_exhausted`; else allowed.

### 11.3 `BoxTradingSessionManager` (`tradingSessionStore.ts:73-387`)
deps `{persistence: {load, save, flatTradeIds}, configuredMaxCompletedTrades(), persistenceAvailable(), now?, newSessionId?, log?}`. Session id `sess-<now base36>-<uuid no dashes first 12>` (`:107-110`).
- `initialise()` (`:134-173`): no persistence ⇒ `loaded=false` (budget inert); load failure ⇒ `loaded=false, loadError`; else record (or idle); then close any in-flight cycles whose trade is durably FLAT (commit with rollback).
- `commit(next, what, rollbackOnFailure)` (`:183-215`): set in-memory first, `await save`; failure ⇒ rollback OR (consumption) keep + `writeFailed=true`.
- `enforcing()` (`:225-230`): `configuredMax > 0 || (armed && record.max > 0)`.
- `evaluateEntry(recoveryActive)` (`:238-274`): not enforcing ⇒ allowed; **no persistence ⇒ allowed** (inert); not loaded ⇒ `session_state_unreadable`; writeFailed ⇒ `session_state_unreadable`; else `evaluateSessionEntry`.
- `arm({maxCompletedTrades?, armedBy, openBoxes, residualLegs, recoveryActive})` (`:277-307`) requires loaded + canArm; commit with rollback. `disarm()`; `recordEstablished(tradeId)` (no-op unless persistence+loaded+armed; commit WITHOUT rollback ⇒ writeFailed blocks entry); `retryPendingWrite()`; `recordCompleted(tradeId)` (rollback); `recordAborted()` (armed only, rollback). `status(activity)` adds `readable, enforcing, write_failed`.
- Go note: in-memory record is mutated before the await of save; concurrent commits in Go must be serialised (mutex) and, for multi-process, the PG write should be a CAS on `updated_at`/version or an append (`array_append` with `NOT (… = ANY(…))`) — the Node code has no cross-process protection here (ambiguity to resolve; "port, don't redesign" suggests identical last-writer-wins).

---

## 12. Live-mode transition (`liveModeTransition.ts`)

Selections (`:55-63`): `paper_latency | paper_legging | paper_legging_live_parity | live`. `currentSelection(mode, profile)` (`:83-87`: live; paper_legging + live_parity profile ⇒ `paper_legging_live_parity`; paper_legging; anything else incl. `paper_touch` ⇒ `paper_latency`).
`executionModeLabel(mode, profile, broker)` (`:73-80`): `LIVE · <BROKER>`, `PAPER · LEGGING LIVE-PARITY`, `PAPER · LEGGING`, `PAPER · TOUCH`, `PAPER · LATENCY`.

`transitionBlockers(snapshot)` (`:163-190`) codes in order: `open_box, partial_box, recovery_box, residual_exposure, recovery_active, working_broker_order, queued_execution, in_flight_execution, unresolved_intent, unknown_order, reconciliation_unhealthy (if !reconciliationHealthy), reconciliation_incident, scanner_running`.

`evaluateModeTransition({from, to, snapshot})` (`:207-265`) — verdict state machine:
- `from === to` ⇒ `allowed`.
- Same side of the live boundary (paper↔paper): blockers + `paper_simulation_in_flight` if `paperSimulationsInFlight > 0`; any ⇒ `refused`; else `allowed` (runtime switch).
- Crossing into live with `!deploymentLiveCapable` ⇒ `refused` with `deployment_gate_disabled` first.
- Otherwise crossing paper↔live ⇒ **`restart_required`** with `envChanges` (`["BOX_EXECUTION_MODE=live","BOX_LIVE_TRADING_ENABLED=true"]` or `["BOX_EXECUTION_MODE=paper_legging (or paper_latency)"]`) and the blockers listed (still reported, not refusing). The process never switches paper↔live at runtime.

`evaluateLiveArm({permission, pre})` (`:308-354`) — per runtime control:
- any permission: `!deploymentLiveCapable` ⇒ only `deployment_gate_disabled`.
- `emergencyFlatten`: requires broker authenticated only.
- `liveOrderEnabled`: broker authenticated + reconciliation complete.
- `entryEnabled`: authenticated, reconciliation healthy, reconciliation complete, feed healthy, feed warmed up, circuit closed, !recoveryActive, unknownOrders==0, durable reservations available.
Runtime controls start false on every boot (manager constructor); arming entry/order/flatten goes through this evaluation (routes/engine).

---

## 13. Paper simulator model (`executionSimulator.ts`, `legExecutor.ts`, `orderPricing.ts`, `executionPolicy.ts`, `paperScheduler.ts`, `liquidityLedger.ts`)

There is **no probabilistic fill model and no random slippage**: fills come only from walking observed WebSocket depth within a fixed LIMIT, after a deterministic arrival time, with a deterministic queue haircut. `Math.random` is banned in `src/box` (a test asserts it).

### 13.1 Modes and profiles
- `executionMode`: `paper_touch` (zero latency, current book), `paper_latency` (default; atomic-ish: one decision+latency delay, then all four legs from the first books at/after arrival), `paper_legging` (four independent LIMIT orders via `LegExecutor`), `live` (never simulated; `simulateEntry`/`simulateExit` refuse with `discovery_stopped` "live OrderManager is not integrated with BoxExecutionSimulator; refusing a paper fallback").
- `paperExecutionProfile`: `standard` | `live_parity` | `stress`. `liveParity = live_parity || stress`; `evidenceDriven = live_parity` (`executionSimulator.ts:230-233`). live-parity adds: `PaperLiquidityLedger`, calibrated/structured latency, cancel-race model, scheduling policy `createSchedulingPolicy({maxConcurrentOperations: paperMaxConcurrentExecutions, minBrokerIntervalMs: liveBrokerMinIntervalMs})` and `arrivalPlanner` (`:234-293`).
- `hasCapacity()` (`:470-477`): `active < (liveParity ? paperMaxConcurrentExecutions : maxConcurrentExecutions(8))`. Duplicate guard: `inFlight` Set keyed by `candidate.key` (entry) or `exit:<position.id>` (exit) ⇒ `duplicate`.

### 13.2 Atomic paths (`simulateEntry` `:493-610`, `simulateExit` `:1513-1614`)
`timingFor(detectedAt)` (`:1618-1632`): paper_touch ⇒ all = detectedAt; else `sentAt = detectedAt + max(0, simulatedDecisionMs=40)`, `arrivalAt = sentAt + max(0, simulatedLatencyMs=250)`.
`awaitBooks(tokens, arrivalAt)` (`:1653-1691`): sleep in steps `min(remaining, max(1, executionPollMs=20))` until now ≥ arrivalAt (guard 100 000 iterations), then snapshot current quotes.
Entry checks after delay: stillWanted → `discovery_stopped`; market closed → `market_closed`; feed unhealthy → `feed_unhealthy`; missing book → `missing_book`; `evaluateCandidate(captured, executedAt = max(arrivalAt, now))`;
not tradable ⇒ `insufficient_quantity` (reject insufficient_qty) / `missing_book` (stale_quote|no_quote) / `price_moved`; gross ≤ 0 ⇒ `edge_disappeared`; `qualify` fails ⇒ `below_expected_net_profit` (or `edge_disappeared` for `below_gross_prefilter`).
Exit: same delay; each leg priced at best opposite-side level (scalar bid/ask fallback), executable iff price>0 && qty at that price ≥ lot; not executable ⇒ `price_moved` (no price) / `insufficient_quantity`; optional `validate`.

### 13.3 Legging entry (`simulateLeggingEntry` `:629-931`)
- `sentAt = detection.at + simulatedDecisionMs`. Cross-leg skew gate: `maxCrossLegExchangeDispersionMs > 0 && temporal.exchange_dispersion_ms > max` ⇒ `cross_leg_time_skew`.
- `LegExecutor.run` with 4 requests (canonical role order; paper does NOT use hedge-first ordering), quantity = lot, `orderIdPrefix "<key>:entry"`, `abortReason` = market closed → `market_closed`; feed unhealthy → `feed_unhealthy`; `stillWanted()` false → `discovery_stopped` (`:430-451`).
- filledCount = legs with status FILLED. `run.aborted && filledCount === 0` ⇒ refuse (outcome `PARTIAL_ENTRY_UNWOUND` if any leg has fill_qty>0, else `REFUSED_BEFORE_SUBMIT`).
- 4/4 FILLED: `evaluationFromFills` at last fill using `booksAtFill`; `qualify(execution, totalEntrySlippage)`; fail ⇒ **abort-after-fill**: `abort_after_fill=true`, outcome `FILLED_THEN_ECONOMICS_ABORT`, `emergencyUnwind`, failure `unwind_failed` if residual else `abort_after_fill`. Pass ⇒ `OPENED`.
- 0 FILLED (not aborted) ⇒ `legging_incomplete` "no leg filled at arrival" **without unwind**.
- 1–3 FILLED ⇒ `emergencyUnwind`; failure `unwind_failed` | aborted reason | `legging_incomplete`.
- AMBIGUITY (paper-only, port as-is or fix knowingly): when no leg reached FILLED but some legs PARTIALLY filled (CANCELLED/TIMED_OUT with fill_qty>0), both early returns skip `emergencyUnwind` and leave `residual_exposure = []`, i.e. the partial simulated exposure is dropped (outcome may still say `PARTIAL_ENTRY_UNWOUND`). Live (§4.3) unwinds any filled_quantity>0.

### 13.4 Emergency unwind (`emergencyUnwind` `:1234-1357`) — paper
For every leg with `fill_qty > 0`: reverse side, reference = current touch on the unwind side (may be null ⇒ priced at first book), quantity = exact fill_qty, `latencyMs = legUnwindLatencyMs (150)`, phase `unwind` (chase `unwindMaxChaseTicks = 5`), prefix `<key>:unwind`, abort only on market closed / feed unhealthy.
Per leg: cost = BUY ? (entry − unwind)·qty : (unwind − entry)·qty (round2); outstanding = fill − unwound ⇒ residual `{source:"failed_unwind"}` + status `UNWIND_FAILED` (if it was FILLED); else FILLED ⇒ `UNWOUND`.
`partial_entry_charges = round2(chargeTotal(entry fills))`, `unwind_charges = round2(chargeTotal(unwind fills))`, `legging_gross_loss = round2(−Σcost)`, `legging_net_loss = round2(gross − partial − unwind)`.

### 13.5 Legging exit / flatten (paper)
- `simulateLeggingExit` (`:944-1104`): requests only for `outstandingRoles(position)` with exact quantities, phase `entry` chase band, prefix `exit:<id>:exit`. Clean iff no remaining qty and all submitted FILLED. Else residual from `residualFromPartialExit` (`:1160-1188`): per role `remaining_qty_by_role[role] − fill_qty` > 0 ⇒ residual on the ENTRY side, `source:"partial_exit"`, avg = entry price.
- `flattenResidual` (`:1370-1441`): one order per residual, reverse side, exchange forced `"NFO"`, latency 150, phase unwind, prefix `<keyPrefix>:flatten`; remaining = qty − fill; `flatten_charges = round2(chargeTotal(fills))`. (No attempt generations in paper.)
- `estimateExecutableExit(position, now)` (`:1117-1153`): per outstanding role, fresh = 0 ≤ age ≤ quoteMaxAgeMs; executable = walkDepth(...).executable_within_limit at entry-band limit from touch.

### 13.6 `LegExecutor.run` (`legExecutor.ts:239-431`) — per-leg state machine (paper)

Paper leg statuses (`PaperLegStatus`): `CREATED → IN_FLIGHT → PENDING ⇄ PARTIALLY_FILLED → FILLED`; `→ CANCEL_REQUESTED` (live-parity only) `→ FILLED | CANCELLED | FAILED | TIMED_OUT`; `→ TIMED_OUT`; `→ CANCELLED` (partial) / `FAILED` (zero fill); post-unwind `UNWOUND`, `UNWIND_FAILED`. Terminal set (`:216-223`): FILLED, TIMED_OUT, CANCELLED, FAILED, UNWOUND, UNWIND_FAILED. (`ACKNOWLEDGED`, `SUBMITTED` exist in the type but are never assigned.)
- Parameters: `latency = max(0, args.latencyMs ?? policy.latencyMs (250))`, `timeout = policy.legTimeoutMs (500)`, `sequential = legExecutionMode === "sequential"`, `maxAgeMs = quoteMaxAgeMs (15000)`, poll `executionPollMs = max(1, 20)`.
- **submit** (`:433-452`): status IN_FLIGHT, `submit_at`; live-parity planned arrival ⇒ `arrival_at = max(submitAt, planned)`, `ack_at = arrival_at`; else `arrival_at = submitAt + (latencySource ? max(0, next()) : latency)`. Parallel: all legs at `submitAt`; sequential: leg 0 only, next leg submitted at the fill instant of the previous (`submitNext`), and a failure marks all later CREATED legs FAILED "not submitted — an earlier leg failed (sequential mode)".
- **arriveAtExchange** (`:580-584`): PENDING, `pending_since = at`, `timeout_at = arrival_at + legTimeoutMs`.
- Event loop (guard 10 000 iterations): evaluate abort once (cancel every open leg via `requestCancel(…, "abort")`); `next = nextBoundary` (IN_FLIGHT→arrival_at; PENDING/PARTIAL→timeout_at; CANCEL_REQUESTED→cancel_confirmed_at; null ⇒ done); wait `min(next − now, poll)`; then (1) arrivals (overshoot past timeout ⇒ expire), tryFill; (2) expire working orders past `timeout_at`; (3) confirm due cancels.
- **Quote subscription** fills between loop iterations: `quotes.subscribe((changed, at) => …)` calls `tryFill` for PENDING/PARTIALLY_FILLED/CANCEL_REQUESTED legs whose token changed, if `pending_since !== null && at >= arrival_at`, not past `cancel_confirmed_at`, and (unless cancelling) not past `timeout_at`. Each retry after the first increments `metrics.recordLogicalRetry()`.
- **expire** (`:481-501`): with cancel race ⇒ `requestCancel(…, "timeout")`; else TIMED_OUT, `resolved_at = timeout_at`, reason "still unfilled <timeout>ms after arriving — only X of Y filled within the limit | no executable quantity within the limit".
- **requestCancel** (`:509-578`): terminal ⇒ done. CREATED ⇒ `cancel_stage="pre_submission"`, abandon. IN_FLIGHT and `arrival_at > now` ⇒ `cancel_stage="in_transport"`, abandon; else promote arrival first. No race model ⇒ timeout→TIMED_OUT, abort→abandon. Race model: idempotent; `cancel_requested_at = now`, `fill_qty_at_cancel_request = fill_qty`, `cancel_confirmed_at = now + max(0, latencyMs())`, status CANCEL_REQUESTED, `cancel_stage="at_exchange"`, still fillable.
- **confirmCancel** (`:594-635`): raced = fill − fill_at_request; remaining 0 && fill>0 ⇒ FILLED (race lost); timeout cause ⇒ TIMED_OUT (+ " (N filled during cancellation)"); abort ⇒ CANCELLED if fill>0 else FAILED.
- **abandon** (`:637-650`): CANCELLED (fill>0) / FAILED; `resolved_at = now`.
- Invariant: `filled_quantity > 0 ⇒ first fill_at >= arrival_at`; `paperRunTimelineViolations(legs)` is asserted and logged (`console.error`) after every run.

### 13.7 Fill formula (`tryFill` `legExecutor.ts:681-837` + `orderPricing.ts`)
1. Refuse if not yet arrived; no quote; book age not in `[0, quoteMaxAgeMs]`.
2. First book seen fixes pricing: reference = `detected_price ?? touch(side)`; `policy.priceOrder` ⇒ `buildOrderPricing` (`orderPricing.ts:84-107`): tick = tickSize>0 ? tickSize : 0.05; `limit = roundToTick(ref ± max(0, round(chaseTicks))·tick)` (+ for BUY, − for SELL); `roundToTick(p, t) = round2(round(p/t)·t)`; chase = `legMaxChaseTicks (2)` entry / `unwindMaxChaseTicks (5)` unwind. Then `classifyOrderProfile` (`:260-289`): no touch ⇒ MARKETABLE_LIMIT assumed; marketable iff BUY limit ≥ touch−1e-9 (SELL ≤ touch+1e-9); `offsetTicks = round2((BUY ? limit−touch : touch−limit)/tick)`.
3. `walkDepth` (`orderPricing.ts:152-220`): levels filtered (finite price>0, safe-int qty>0) and sorted best-first; stop at first level outside limit (EPS 1e-9); per level `effective = effectiveQty(displayed) − reserved` where `effectiveQty = model "none" ? displayed : floor(displayed · (1 − clamp(haircut,0,100)/100))` (`:116-122`, default haircut 30%, model `haircut`); `executable_within_limit += effective`; take `min(remaining, effective)`; avg = round2(Σp·q/Σq).
4. Record `executable_within_limit_at_arrival` and `displayed_qty_at_arrival` on the FIRST book (even if nothing filled).
5. filled 0 ⇒ reason "touch X is past the limit L" or "no executable quantity within the limit L".
6. Live-parity: `ledger.reserve(gen, token, side, price, version, qty)` per slice. Apply: fills appended, `fill_qty += filled`, `remaining = max(0, qty − fill)`, avg = round2 weighted, `slippage = round2(slippagePerUnit · fill_qty)` with `slippagePerUnit(side, detected, executed) = round2(BUY ? exec − det : det − exec)` (`math.ts:71-78`).
7. remaining 0 ⇒ FILLED (`fill_at = resolved_at = at`; a cancelling order sets `cancel_confirmed_at = at`). Else PARTIALLY_FILLED (unless CANCEL_REQUESTED, which keeps its status).

### 13.8 Shared liquidity ledger (`liquidityLedger.ts`, live-parity only)
Level key `"<gen>|<token>|<side>|<round(price*100)>|<quoteVersion>"`; series key without version. `reservedAt`: a version older than the latest for the series ⇒ 0; else stored. `reserve`: newer version ⇒ drop the old version's reservation (new book = fresh liquidity), set latest, evict oldest series beyond `DEFAULT_MAX_SERIES = 4096` (insertion order); older version ⇒ 0 (ignored); add qty. `clearGeneration(gen)`, `clear()`.

### 13.9 Paper scheduler (`paperScheduler.ts:139-235`, live-parity `planArrivals` `executionSimulator.ts:398-421`)
`planArrivals`: purpose `EMERGENCY_RESIDUAL` for unwind else `ENTRY`; persistence = measured p50 of `persistence_wait_ms` else `paperPersistenceMs (0)`; one op per leg `{sequence:i, readyAt: submitAt, postToAckMs, ackToTerminalMs}` from `structuredLatency.next()`; returns each op's `ack_at` as the arrival.
`planPaperSchedule(ops, policy)`: cap slots (`slotFreeAt = −∞`), pick the earliest-free slot; choose the ready op (`readyAt <= slotFree + 1e-6`) with lowest (priority, sequence); none ready ⇒ advance slot to earliest readyAt;
`dequeued = max(slotFree, readyAt)`, `persisted = dequeued + persistence`, `post = max(persisted, transportFreeAt)`, `ack = post + postToAck`, `terminal = ack + ackToTerminal`; `transportFreeAt = post + minBrokerIntervalMs`; `slotFreeAt[slot] = terminal` (slot held for the whole lifecycle).

### 13.10 Cancel window and persistence window (`executionSimulator.ts:323-346`)
`cancelWindowMs()` = calibrated p50 of `cancel_request_to_terminal_ms` for kind CANCEL (rounded) else `paperCancelLatencyMs (150)`. `persistenceWindowMs(kind)` = calibrated p50 of `persistence_wait_ms` else `paperPersistenceMs (0)`.
Calibration dimensions used by paper (`:306-313`): broker = `deps.broker?.() ?? "zerodha"`, profile fixed `MARKETABLE_LIMIT`, bucket = `classifyTimeOfDayBucket(istMinutesOfDay)` if `paperCalibrationTimeBuckets` else `NORMAL`.

### 13.11 Node assumptions in the simulator (Go)
- The leg run mixes an async poll loop with synchronous tick callbacks mutating the same leg state. In Go, tick delivery must be serialised with the run loop (e.g. deliver ticks into the run goroutine through a channel, or lock a per-run mutex in both paths); otherwise fills race with expiry/cancel confirmation.
- Timer ordering matters: within one wake-up the order is abort → arrivals (with overshoot check) → expiry → cancel confirmation; tick callbacks can run between any two awaits. Golden fixtures (e.g. 75/40/52/23) depend on this order.
- `inFlight`/`active` check-and-add is synchronous ⇒ needs a mutex. `PaperLiquidityLedger` is shared across concurrent runs ⇒ mutex.
- Determinism: all sleeps go through injected `wait`/`now`; Go must keep injectable clocks to reproduce fixtures.

---

## 14. Live order lifecycle inside the adapters (timing / cancel / retry rules) and pacing

(Adapters themselves are in the brokers inventory; these are the execution-relevant rules.)

### 14.1 Kite (`kiteBrokerAdapter.ts`)
- `submitOrder(req, beforePost)` (`:338-436`): `prepareOrder` + `assertBoundedLimit(req, maxChaseTicks)`; **session-local idempotency**: an existing in-memory order for the client id is returned without POST (`:344-345`).
  State SUBMITTING, tag `stableKiteTag(clientId, req.tag)` (`:822-831`: requested tag stripped to `[A-Za-z0-9]` ≤20 chars, else `"BOX" + FNV-1a(clientId) base36 UPPER`, ≤20 chars).
  POST inside `pacer.run(…, "order_mutation")`; `beforePost()` is the first statement inside the paced callback. Body: LIMIT, product NRML, validity DAY, price = limit_price, tag.
  Errors: pre-submit refusal ⇒ drop local projection, rethrow. Ambiguous (timeout/5xx/429/not a definitive rejection) ⇒ `reconcileByTag` (adopt only if uniquely identified) else RECONCILIATION_REQUIRED + `BrokerAmbiguousSubmitError` — **never re-POST**. Definitive rejection ⇒ REJECTED with `classifyKiteReject` family ⇒ `BrokerOrderRejectedError`.
  Success ⇒ broker_order_id, ACKNOWLEDGED, then `waitForResolution`; any throw there ⇒ RECONCILIATION_REQUIRED ambiguous.
- `waitForResolution(order)` (`:705-721`): loop until terminal: `deadline = state==ACKNOWLEDGED ? ackTimeoutMs (3000) : workingTimeoutMs (30000)` measured from loop start; also `partialTimeoutMs (10000)` from the first PARTIALLY_FILLED observation; `elapsed >= deadline` ⇒ `protectiveCancelAndConfirm`; else wait `max(1, brokerMinIntervalMs (250))` and `refresh` (getOrder; missing ⇒ UNKNOWN).
- `protectiveCancelAndConfirm` (`:723-746`): no broker id or terminal ⇒ return; CANCEL_REQUESTED; DELETE via pacer `order_mutation` under `withDeadline(cancelTimeoutMs 5000)`; then `confirmTerminalAfterCancel`; any failure ⇒ RECONCILIATION_REQUIRED + ambiguous error carrying the snapshot.
- `confirmTerminalAfterCancel` (`:748-763`): re-read until terminal while `now <= now0 + cancelTimeoutMs`, waiting brokerMinIntervalMs between reads; timeout ⇒ RECONCILIATION_REQUIRED ambiguous ("Cancellation was acknowledged locally but broker terminal quantity remains uncertain."). A late fill can turn the cancel into COMPLETE.
- `cancelOrder(clientId)` (`:438-467`): unknown ⇒ undefined; terminal ⇒ snapshot; no broker id ⇒ RECONCILIATION_REQUIRED; else DELETE (deadline) then confirm.
- No automatic modify/chase: `modifyOrder` exists (`:469+`) but the manager never calls it; `BOX_LIVE_MAX_MODIFICATIONS=2` is only a ceiling. **No retry of a failed POST exists anywhere**; re-submission only happens as a new residual-flatten generation (§6) with a new identity.
### 14.2 Dhan (`dhanBrokerAdapter.ts`) differences
Ambiguous POST reconciled inline by correlation id (never re-POST). Resolution loop (`:452-482`) uses `Date.now()` directly and **strict `>`** comparisons; partial clock starts at first `filled_quantity > 0` (Kite: first PARTIALLY_FILLED state);
extra poll budget `maxPolls = max(10, ceil((workingTimeoutMs + partialTimeoutMs)/max(1, brokerMinIntervalMs)) + 10)` (= 170 at defaults) ⇒ protective cancel when exhausted. Polls order AND trade book (two paced calls per poll).

### 14.3 Pacing (`brokerPacing.ts`)
- Profiles (`:78-97`): zerodha `defaultOrderMutationMs 110, floorMs 100`; dhan `120 / 120`; unknown broker ⇒ strictest (`max` of each, labelled zerodha) (`:198-211`).
- `resolveBrokerPacing(broker, generalMinIntervalMs, orderOverrideMs)` (`:134-181`): general = finite ? max(0, floor) : 250; override > 0 ⇒ `< floor` ⇒ floor (`clamped_to_floor`) else override (`operator_override`); else default (`broker_default`); final clamp to floor. (`clamped_to_general` is declared but never produced.)
- `pacingWaitMs({pacing, klass, lastCallAt, now})` (`:223-240`): required = class interval; lastCallAt non-finite ⇒ 0; elapsed negative/non-finite ⇒ full interval; else `max(0, required − elapsed)`. `burstPacingBudgetMs(p, n) = n ≤ 1 ? 0 : (n−1)·orderInterval`.
- `TransportPacer.run(op, klass="general")` (`:345-384`): **FIFO promise chain**: each call waits for the previous call's operation to FINISH (`tail = run.then(…)`), then waits `max(classWait, absoluteWait)` where absoluteWait uses the order-mutation interval against the last call of ANY class; stamps last-call times **after** the wait (before the HTTP call). So all broker HTTP calls of one adapter are strictly serial, and also spaced. Go: one goroutine/mutex held for wait + HTTP call, FIFO-fair (use a ticket queue or channel, not `sync.Mutex`, which is not FIFO).
- Reported to the API as `execution.effective_broker_order_min_interval_ms` (engine `resolveBrokerPacing` at `engine.ts:4505`, read from the adapter).

---

## 15. Timing, calibration and feedback loop

Chain: live adapter + manager marks → `ExecutionTimingRecorder` (per order) → on terminal publish: `ExecutionCalibrationStore` (dimensioned rings, consumed by paper live-parity), `BrokerTimingStore` (live diagnostics), `CalibrationPersistenceBuffer` → `box_calibration_samples` (rehydrated at boot). Paper legs feed a separate `paperTiming` BrokerTimingStore (never the calibration store) so parity can fail.

### 15.1 Clock (`executionClock.ts`)
`ExecutionClock {mono(), wall(), stamp(): {mono, wall}, monotonic}`; `createExecutionClock({performanceNow?, dateNow?})` (`:91-128`) uses `performance.now()` when available else `Date.now` (monotonic=false). Durations use mono only; wall only for audit/bucketing.
`monoSpan(from, to)` (`:71-76`): null if either null/non-finite or `to < from`. `approximateWallFor(anchor, mono) = round(anchor.wall + (mono − anchor.mono))`. `createFixedExecutionClock` for tests. Go: `time.Now()` monotonic reading for spans; never mix with wall.

### 15.2 Trace (`executionTiming.ts`)
Stages (`:78-122`): `detected, qualified, scheduler_enqueued, scheduler_dequeued, intent_persisted, transport_started, http_request_started, http_response, broker_order_id, acknowledged, first_fill, last_fill, full_fill, cancel_requested, cancel_acknowledged, terminal, reconciled`.
First mark wins except overwritable `last_fill, reconciled, terminal` (`:337-341`). `markFill(cum)` only when cum > highest seen; sets first/last fill, records ≤64 partial marks, `full_fill` when cum ≥ requested.
Spans (`spans()` `:287-333`): `scheduler_wait_ms = enq→deq`; `persistence_wait_ms = deq→intent_persisted`; `transport_wait_ms = (persisted ?? deq)→(transport_started ?? http_request_started)`; `post_to_http_response_ms = http_start→http_response`;
`post_to_ack_ms = http_start→(acknowledged ?? broker_order_id)`; `ack_to_first_fill_ms`; `ack_to_terminal_ms`; `partial_to_terminal_ms = first_fill→terminal` only if the first partial mark < requested; `cancel_request_to_terminal_ms`.
`kindForPurpose` (`:349-360`): ENTRY→ENTRY, EXIT→EXIT, EMERGENCY_RESIDUAL→UNWIND, PROTECTIVE_CANCEL→CANCEL.
Recorder (`:402-630`): traces in `BoundedTtlCache(maxEntries 512, ttl 10 min)`; `trace(id, identity)` creates only with identity; `publish(id)` once (idempotent): spans, `atWall = (terminal ?? last_fill ?? http_response).wall`, environment annotation since `scheduler_enqueued ?? detected ?? http_request_started`;
**samples measured during a loop stall (`environment.stalled`) are NOT sent to calibration** (`:575`) but still go to the timing store and `onPublish`. Cancel span filed under kind `CANCEL`. Every method try/catch, no I/O, counted failures. Manager publishes only after the terminal snapshot is durably persisted.
Engine `onPublish` (`engine.ts:592-604`) mirrors every span into `CalibrationPersistenceBuffer` with bucket from `istMinutesOfDayFor(atWall)` (note: this path does NOT skip stalled samples, so persisted samples can include stall-contaminated ones that will be rehydrated into calibration — AMBIGUITY).

### 15.3 Latency model (`latencyModel.ts`, `latencySource.ts`, `calibratedLatencySource.ts`)
- Brokers `zerodha|dhan`; kinds `ENTRY|EXIT|UNWIND|CANCEL|MODIFY`; profiles `MARKETABLE_LIMIT|PASSIVE_LIMIT`; buckets `OPEN|NORMAL|CLOSE`.
- `IST_MARKET_OPEN_MINUTES = 555` (09:15), `IST_MARKET_CLOSE_MINUTES = 930` (15:30) (`latencyModel.ts:111-112`); default windows open 15 / close 15 min (`:121-124`). `classifyTimeOfDayBucket(m)` (`:133-146`): non-finite or outside [555, 930] ⇒ NORMAL; `< 570` ⇒ OPEN; `> 915` ⇒ CLOSE; else NORMAL. `istMinutesOfDayFor(wall)`, `istSessionKey(wall)` = IST `YYYY-MM-DD` (UTC+5:30 arithmetic, no DST).
- `classifyCalibration(n, ageMs, {calibratedMinSamples: 200, staleAfterMs: 8h})` (`:187-207`): n ≤ 0 or age null ⇒ UNCALIBRATED; n ≥ 200 ⇒ (age > 8h ? STALE : CALIBRATED); else PARTIALLY_CALIBRATED.
- `classifyConfidence({status, sampleCount, measured, fellBack?, thresholds {high 200, medium 30}})` (`:232-261`): !measured ⇒ LOW; UNCALIBRATED/STALE ⇒ LOW; n < 30 ⇒ LOW; fellBack ⇒ MEDIUM; CALIBRATED && n ≥ 200 ⇒ HIGH; else MEDIUM.
- `createLatencySource({mode, constantMs, samples?, seed?})` (`latencySource.ts:97-102`): constant ⇒ `round(constant)` (invalid → 0); recorded_samples ⇒ samples sanitised (non-finite/negative → round(constant)), empty ⇒ `[constant]`; start = `((trunc(seed) % n) + n) % n`; `next()` returns `samples[cursor++ % n]` (fixed rotation, no randomness); `reset()` returns to start.
- `createStructuredLatencySource` (`latencyModel.ts:307-326`): postToAck from `constantMs` + `BOX_PAPER_LATENCY_SAMPLES`; ackToTerminal from `round(constantMs · 0.4)` (`UNCALIBRATED_ACK_TO_TERMINAL_FRACTION = 0.4`, `:305`) + `BOX_PAPER_LATENCY_ACK_TERMINAL_SAMPLES`; `calibrated` = any samples given.
- `CalibratedStructuredLatencySource` (`calibratedLatencySource.ts:159-330`): fallback constant = round(max(0, simulatedLatencyMs 250)); ack fraction 0.4 (`:63`); `refreshEveryDraws = 200` (`:174`); re-resolves when the dimensions key changes or after 200 draws (cursor restarts at seed). Per stage (`post_to_ack_ms`, `ack_to_terminal_ms`): usable iff `resolution.measured && values.length > 0` ⇒ recorded_samples over the resolved values, else constant.
  Status: `measured` = BOTH stages measured; confidence/status = weaker of the two; note text names the fallback constant. `formatCalibrationBlock(status)` (`:340-362`) fixed text block.
- AMBIGUITY (doc vs code): LIVE_EXECUTION.md says a STALE set falls back; in code `resolve()` excludes only distributions whose newest sample is older than `maxAgeMs` (3 days); a distribution 8 h–3 days old resolves `measured: true` with status STALE / confidence LOW and IS used for draws.

### 15.4 Calibration store (`executionCalibration.ts`)
Stages (`:87-112`): `scheduler_wait_ms, persistence_wait_ms, transport_wait_ms, post_to_http_response_ms, post_to_ack_ms, ack_to_first_fill_ms, ack_to_terminal_ms, partial_to_terminal_ms, cancel_request_to_terminal_ms`.
Defaults (`:243-246`): window 500 (`BOX_EXECUTION_TIMING_WINDOW`, 50..100000), minSamples 30 (`BOX_PAPER_CALIBRATION_MIN_SAMPLES`, 5..100000), bucketMinSamples 60 (≥ minSamples), maxAge 3 days (`BOX_PAPER_CALIBRATION_MAX_AGE_MS`).
Key `broker|kind|profile|bucket|stage`; ring buffer per key; `record()` drops non-finite/negative value or non-finite atWall (counted); session = `sample.session ?? istSessionKey(atWall)`; newest updated when `atWall >= newest`.
`resolve(dims, stage)` (`:371-437`) fallback ladder (freshness is per DISTRIBUTION: newest sample within maxAge):
1. exact key fresh with ≥ bucketMinSamples ⇒ fallback `none`;
2. pool all 3 buckets (same broker/kind/profile) ≥ minSamples ⇒ `bucket_pooled`;
3. pool all 5 kinds × 3 buckets (same broker/profile) ≥ minSamples ⇒ `kind_pooled`;
4. else `unavailable`, measured false, percentiles null, confidence LOW, status PARTIALLY_CALIBRATED if any samples else UNCALIBRATED.
Never crosses broker or profile. `describe` status via `classifyCalibration(pooled n, age)`, confidence `classifyConfidence(measured true, fellBack = fallback≠none)`.
`percentilesOf(values)` (`:682-690`): sorted, `idx = min(n−1, max(0, floor(p·n)))`, round2; p50/p75/p90/p95/p99. `export()`/`import(payload)` (region must match exactly, unknown dims skipped; every value re-recorded at the entry's newest timestamp). `snapshot()`, `brokerStatus(broker)`, `allBrokerStatus()`.

### 15.5 Persistence of calibration samples
- `CalibrationPersistenceBuffer` (`calibrationPersistence.ts:81-217`): enabled by `BOX_LIVE_TIMING_PERSIST_ENABLED` (false); `batchSize = clamp(BOX_LIVE_TIMING_BATCH_SIZE 50, 1..maxBuffered)`; `maxBuffered = max(1000, batchSize·20)`; overflow drops OLDEST (counted lost); flush when buffer ≥ batch or every `BOX_LIVE_TIMING_FLUSH_MS` (15000) interval; single-flight flush (a second flush while one runs returns the same promise, buffer accumulates); sink failure ⇒ whole batch counted lost (not retried); `dispose()` final flush.
- Sink `persistBoxCalibrationSamples(batch, region)` (`repository.ts:2716-2743`): `insertMany(ordered:false)` rows `{broker, kind, profile, bucket, stage, value_ms: round2, session: sample.session ?? "", region, observed_at}` (session is always "" from the engine path).
- Rehydrate `rehydrateCalibration()` (`engine.ts:4028-4060`, only if persist enabled): `loadBoxCalibrationSamples({region, maxAgeMs: paperCalibrationMaxAgeMs})` (`repository.ts:2744-2778`): `region = $region` (null matches null), `observed_at >= now − maxAge`, sort ascending, limit 50 000; recorded into the store unvalidated with `session` "" (so `newestSession` becomes "").
- Collection TTL 14 days (`model.ts:948-951`); index `{region:1, observed_at:-1}`. PG: table + periodic `DELETE … WHERE observed_at < now() − interval '14 days'`.

### 15.6 Queue calibration (`queueCalibration.ts`) — advisory only
`classifyLiquidity(exec, req)` (`:109-115`): req ≤ 0 ⇒ NORMAL; ratio < 1 ⇒ THIN; ≥ 5 ⇒ DEEP; else NORMAL. Estimator defaults window 500, minSamples 30 (engine passes `paperCalibrationMinSamples`), high 200 (`:171-173`).
`record(obs)`: drop if executable-within-limit ≤ 0 / non-finite or filled < 0; `realised = min(1, filled / min(requested, visible))`; sizeRatio = requested/visible (>1 counted).
`recommend(broker, profile, liquidity)` (`:268-324`): n < min ⇒ none; else p50/p25/p10 (round3); **recommended haircut = round(clamp((1 − p25)·100, 0, 100))**; confidence HIGH if n ≥ 200, MEDIUM if n ≥ 2·min, else LOW. Never applied automatically.
Fed per paper leg by `BoxEngine.observeAttempt()` from `executable_within_limit_at_arrival` / `displayed_qty_at_arrival` (legs with no executable depth are skipped).

### 15.7 Execution environment (`executionEnvironment.ts`)
Defaults (`:198-201`): stall threshold 50 ms, drift-sampler interval 500 ms (min 50), histogram resolution 20 ms, stall history 50. Drift sampler: `setInterval(500)`; `drift = now − expected`; drift ≥ 50 ⇒ `recordStall`; expected = now + 500.
`annotate(sinceMono)` (`:303-320`): stalls at/after `sinceMono` ⇒ `{loop_p99_ms, stalls_during, worst_stall_ms, stalled: count>0}`. Node `monitorEventLoopDelay` histogram p50/p95/p99; memory/CPU only in snapshot. Go equivalent: a ticker-drift sampler (same constants) plus `runtime/metrics` GC pauses; keep the "stalled ⇒ exclude from calibration" rule.

### 15.8 Broker timing store (`brokerTimingStore.ts`)
Leg components (`:107-119`) from `BoxBrokerTiming` marks: `queue_wait_ms (queued→dequeued), transport_wait_ms (dequeued→post_started), broker_post_duration_ms, submit_to_ack_ms, submit_to_first_fill_ms, submit_to_terminal_ms, ack_to_first_fill_ms, ack_to_terminal_ms, first_fill_to_last_fill_ms, first_fill_to_terminal_ms, cancel_confirmation_ms`.
Box components (`:122-130`): `detection_to_first_submit_ms, detection_to_last_submit_ms, detection_to_first_fill_ms, detection_to_all_four_filled_ms, first_fill_to_last_fill_ms, unhedged_exposure_duration_ms, unwind_duration_ms`.
Outcomes `BoxExecutionOutcome` (`:68-91`): `filled_4_of_4, partial, no_fill, timeout, cancel_race, broker_reject, abort_after_fill, clean_unwind, failed_unwind, residual`. Window 500, timeline ring 200; status via `classifyCalibration(sampleCount, age)`.

---

## 16. Faults and outcomes taxonomy

- **Failure reasons** `BoxExecutionFailureReason` (`types.ts:593-612`): `price_moved, insufficient_quantity, missing_book, feed_unhealthy, market_closed, edge_disappeared, below_expected_net_profit, discovery_stopped, duplicate, legging_incomplete, unwind_failed, cross_leg_time_skew, abort_after_fill, box_capital_limit, underlying_already_active, session_limit_reached`.
- **Entry outcome classes** `BoxEntryOutcomeClass` (`types.ts:1021-1028`): `OPENED, REFUSED_BEFORE_SUBMIT, NO_FILL, PARTIAL_ENTRY_UNWOUND, PARTIAL_ENTRY_RESIDUAL, FILLED_THEN_ECONOMICS_ABORT, QUARANTINED_UNKNOWN`.
- **Paper leg statuses** `PaperLegStatus` (`types.ts:749-763`): `CREATED, SUBMITTED, IN_FLIGHT, ACKNOWLEDGED, PENDING, PARTIALLY_FILLED, FILLED, CANCEL_REQUESTED, TIMED_OUT, CANCELLED, FAILED, UNWINDING, UNWOUND, UNWIND_FAILED` (SUBMITTED/ACKNOWLEDGED/UNWINDING never assigned by the executor). `cancel_stage`: `pre_submission | in_transport | at_exchange | null`.
- **Technical fault classes** (`executionFaults.ts:36-61`): `reservation_error, reservation_authority_unavailable, execution_gateway_error, execution_simulator_error, execution_invariant_error, trade_persistence_error, position_book_error, charge_calculation_error, broker_state_error, unknown_internal_error`. Stages (`:79-91`): `reservation, pre_decision, execution, final_qualification, trade_persistence, position_book`.
  `classifyExecutionFault({stage, error})` (`:130-171`) uses message regexes (`:100-105`): DURABLE_AUTHORITY `/reservation|fencing token|server timestamp|is missing the .* index|connection is not ready/i`; PERSISTENCE `/persistence is unavailable|order intent|mongo|topology|E11000|server selection|write concern|disappeared/i`; BROKER_UNKNOWN `/unknown|ambiguous|reconcil|uncertain|timed? ?out|quarantin/i`; INVARIANT `/invariant|must never|overfill|regressed|impossible/i`; GATEWAY `/execution manager is unavailable|live execution is blocked|no executable reference price/i`; CHARGES `/charge|unpriced|fee|brokerage|stt|gst/i`. Programming errors = TypeError/RangeError/ReferenceError.
  Go note: these depend on JS error names and **Mongo driver messages** (`E11000`, `topology`, `server selection`); a PG/Go port must map equivalent errors (e.g. SQLSTATE 23505, pool/connection errors) or the classification silently changes — decide explicitly.
  `ExecutionFaultLog(maxEntries = 50)` (`:222-269`): messages sanitised (`api_key|access_token|authorization|password|secret|bearer` ⇒ `[redacted]`, JWT-looking ⇒ `[redacted-jwt]`), message ≤ 400, stack ≤ 2000 chars; public view drops candidate_key and stack.
  `BOX_PARENT_ATTEMPT_REASONS` = market reasons (13) + fault classes + `persistence_unavailable`, `internal_error` (`:286-308`; note the market list omits `box_capital_limit, underlying_already_active, session_limit_reached`).
- **Reject classes** (`executionOutcomes.ts:47-70`): `rms, margin, price_band, quantity_freeze, market_closed, instrument_unavailable, rate_limit, auth, network_unknown, broker_internal, other`; `rejectClassFor(family, msg)` (`:79-109`): direct map, else `generic`/null by message: `/timeout|timed out|socket|econn|network|abort/` ⇒ network_unknown; `/internal|5\d\d|unavailable|gateway/` ⇒ broker_internal; else other. `ExecutionOutcomeStore` rates `round3(c/total)`. `RecordedRejectReplayer` has no production caller.
- **Distinct non-fault outcomes**: broker rejection (counts toward `rejects`), broker uncertainty (UNKNOWN/RECON ⇒ `unknownOrders`), local pre-submit refusal (neither).

---

## 17. Durable residual/charge projection on `box_execution_attempts` (`executionAttemptProjection.ts`, `repository.ts:1752-1950`)

- Command (`createResidualProjectionCommand`, `:99-136`): `{application_id, expected_version (safe int ≥0 else 0), expected_projection_identity, expected_residual_exposure, next_projection_identity, residual_exposure, flatten_charge_delta (finite>0 ? round2 : 0), flatten_charge_day (YYYY-MM-DD else "unattributed")}`;
  `application_id = sha256(JSON.stringify({attempt_id, expected_version, expected_projection_identity, next_projection_identity, flatten_charge_delta, flatten_charge_day}))`.
- `residualProjectionIdentity(residual)` (`:84-86`) = `sha256(JSON.stringify(canonicalResidual))`, canonical = per leg `{role, token, tradingsymbol, exchange ?? "NFO", side, quantity, average_price, source, created_at, flatten_attempt ?? 1}` sorted by `JSON.stringify(a).localeCompare(JSON.stringify(b))`.
  **Go parity hazard**: identities are persisted and compared across restarts; Go must reproduce JS `JSON.stringify` exactly (key order as listed, JS number formatting incl. `1e+21`, `-0`→`0`) and JS `localeCompare` ordering (ICU collation, not byte order). Recommend: Go uses byte-order comparison only if it is proven identical for the actual key space, otherwise implement ICU-compatible collation; add golden fixtures.
- `recoveryExecutionAttemptId(recoveryKey, residual)` = first 24 hex chars of `sha256({recovery_key, residual: canonical})` (a valid ObjectId hex).
- Pure transition `transitionResidualProjectionSnapshot(snapshot, cmd)` (`:182-221`): none ⇒ `not_found`; app id seen ⇒ `already_applied`; version/identity mismatch ⇒ `stale`; else version+1, identity, residual, `flatten_charges = round2(old + delta)`, day/for-day bookkeeping (same day accumulates, new day restarts), applications ring of last `MAX_FLATTEN_APPLICATION_IDS = 32`, `resolved = residual empty`.
- **Atomic DB op** `applyBoxExecutionAttemptProjection(id, cmd)` (`repository.ts:1863-1945`): ONE `findOneAndUpdate` with filter `_id AND applied_flatten_applications ≠ app_id AND (projection_version = expected [OR missing/null when expected 0]) AND (residual_projection_identity = expected [OR (identity null AND residual_exposure == expected_residual_exposure) when expected 0])`,
  pipeline update setting residual, resolved, `projection_version = COALESCE(v,0)+1`, identity, `applied_flatten_applications = last 32 of (old || [app_id])`, `flatten_charges = $round(COALESCE(c,0) + delta, 2)`, `flatten_charge_day`/`flatten_charges_for_day` as above. No match ⇒ separate read ⇒ `already_applied` or `stale` (or `not_found`).
  PG: single `UPDATE … WHERE id=$ AND NOT ($app = ANY(applied)) AND (…) RETURNING *` with arrays as `text[]` and residual as JSONB. Hazards: (a) Mongo `$round` is **round-half-to-even**, the pure function uses JS `Math.round` (half-up) and PG `round(numeric,2)` is half-away-from-zero — pick one and match fixtures; (b) the legacy guard compares `residual_exposure` by Mongo exact array/document equality (key-order sensitive); JSONB equality ignores key order.
- Crash-only recovery row `ensureBoxRecoveryExecutionAttempt({id, recoveryKey:"boot-recovery", residual, executionMode, broker, at})` (`repository.ts:1752-1817`): requires `isBoxRecoveryPersistenceReady()` (verified unique partial index `box_single_unresolved_crash_recovery {candidate_key} unique WHERE candidate_key="boot-recovery" AND resolved=false`, `model.ts:703-710`); read existing unresolved row; else `findOneAndUpdate({_id:id}, {$setOnInsert: …}, upsert)`; duplicate-key ⇒ re-read winner; every returned row validated (`validatedRecoveryExecutionAttempt` `:1716-1735`) or throws (quarantine). PG: partial unique index `ON box_execution_attempts(candidate_key) WHERE candidate_key='boot-recovery' AND NOT resolved` + `INSERT … ON CONFLICT DO NOTHING` + re-read.
- `loadUnresolvedBoxExecutionAttempts(limit=200)` (`repository.ts:~1686-1706`): `resolved:false`, excluding `boot-recovery` rows unless recovery persistence is ready; errors ⇒ [].
- Charge watermark helpers (in-memory, per attempt and per attempt+day, key `attemptId\u0000day`): `seedObservedFlattenCharges`, `seedObservedFlattenChargesForDay`, `adoptObservedFlattenCharges`, `reconcileObservedFlattenCharges` (delta only when cumulative/day value increases; `onNewCharge(delta, observation)` debits daily risk via `manager.recordFlattenCharge`), `compactObservedFlattenChargeWatermarks`, `compactResidualProjectionBookkeeping`, `runInitialRegisteredResidualPass`, `persistOwnedResidualProjection` (`:228-456`).
