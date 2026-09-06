# Box model — deep review findings

A defect-hunting review of the Box module (53 files, ~30k lines): the P&L / charge / direction
arithmetic, the execution and order-state path, and the exit / monitor / freshness gates.

This document exists so the findings that were **not** fixed are not silently lost. Each one below
is recorded with its consequence and the reason it was deferred rather than patched. Nothing here is
speculative — anything that turned out to be correct-on-inspection was dropped from the list, and
several suspicious-looking things were verified correct and are noted at the end so they are not
re-audited.

## Fixed in this pass

| # | Defect | Consequence | Fix |
|---|---|---|---|
| D1 | `evaluateCandidateIndicative` plausibility band was `0 < value < width` | Not a coherence test but a "the long box is profitable" test. The implied box value is identical for both directions, so **every profitable SHORT box was rejected as implausible** — the market-closed view could only ever show short boxes as losers | Band restated on this direction's **signed** edge: `0 < edge < width`. Long-box behaviour is byte-for-byte unchanged; the mirror region `width < value < 2×width` is now admitted |
| D2 | `persistPartialExit` at the partial-close branch had no `.catch`, unlike all four sibling persists | The store *rejects* (not returns false) on a socket error. The rejection escaped, skipping the quarantine, so the position still claimed full quantity on roles the broker had already closed and nothing was queued for retry. The next cycle re-closed an already-flat role — **reverse exposure**, the one outcome the class exists to prevent | Guarded to match its siblings, so the existing `RECOVERY` quarantine and retry queue actually run |
| D3 | `const price = leg.price ?? 0` on a leg with confirmed fill quantity | A priceless confirmed fill fabricated `±entryPrice × qty` of realised P&L (order of ₹20k+ on one leg) and priced that order's charges on ₹0 of turnover | Refuses the quantity, raises the invariant, leaves the role outstanding |
| D4 | `loadBoxLiveRiskSeed` summed `net_abort_pnl` but not `flatten_charges` | `net_abort_pnl` deliberately excludes residual-flatten cost, which the engine *does* charge against the daily loss limit in-session. After a restart the day looked **better** by the whole sum of flatten charges, so live entry could stay enabled with the true realised loss already past the limit. A risk seed erring generous is the one direction it must not err in | Selects and subtracts `flatten_charges` |
| D5 | `cancelWorkingBoxOrders` let a cancel rejection escape its loop | The operator's panic button. `enqueueCancel` rejects on any adapter error, and a slow/ambiguous cancel is exactly when this is called — so the first troublesome leg meant **legs 2-4 were never enqueued** and stayed working at the broker, while the endpoint reported a flat failure | Each intent gets its own attempt; failures are collected and raised as an invariant violation after all have been tried, and the caller still receives what *was* cancelled |
| D6 | `filled_quantity === quantity` used as the "fully filled" test in three places | A broker reporting *more* filled than requested read as **underfill**, sending a complete, correctly-hedged box into a four-leg protective unwind — paying a full round trip plus charges to reverse a position that was right. Overfill is separately detected and quarantined by the cumulative fill ledger, which is where it belongs | `>=` on the entry path, the exit path and `liveRecord` |
| D7 | Implementation shortfall was fed the **gate threshold** as the theoretical detected edge, and an expected *net* as an executed *gross* edge | Introduced by the wiring in PR #32. Every line of the attribution chain, `unexplained` included, was an attribution of nothing in particular | The detected gross edge is threaded explicitly from the scanner (which has it); when a caller does not know it the shortfall is **skipped** rather than computed from a stand-in |

Regression tests: `tests/box/deepReviewFixes.test.mjs`. Verified as genuine regressions — 5 of the 7
fail against the pre-fix tree. Two pass in both states by design: one pins behaviour the fix must
*preserve* (the band still rejecting incoherent closes), and one pins that the monitor cycle does not
throw, which passed before precisely because an outer generic handler swallowed the escaping
rejection — that silence is what made D2 invisible.

## Found, NOT fixed, and why

### 1. A partially-exited box re-values its already-closed legs (accounting)
`positionMonitor.ts` — `measure()`

`pos.quantity` and `pos.lot_size` are never decremented by a partial exit (only
`remaining_qty_by_role` is), so `measure()` re-marks **all four** roles at the current touch and
prices a fresh **full-lot four-leg** exit estimate, while the exit charges already paid on the closed
legs (`cumulative_exit_charges`) are not passed in. Every ₹1/unit move in an already-flat leg moves
the reported figure by a full lot. This flows into `open_running_net_pnl` and the archived day total
for as long as the position is partial.

Not a trading-decision bug: a `PARTIALLY_EXITED` box skips the convergence rules and goes straight to
flatten, and the **final** close is correct (it overrides with cumulative gross and cumulative exit
charges, so nothing is double-counted).

**Deferred because** the correct fix is to freeze realised P&L on closed roles and mark only the
outstanding ones — a redesign of `measure()`'s inputs, not a patch. Half-fixing live P&L accounting is
worse than leaving a known, bounded, documented error in place.

### 2. Live residual flattening is one-shot (real money, highest remaining severity)
`executionGateway.flattenResidual`, `orderManager.execute`, `repository.createBoxOrderIntent`

The residual order identity is `stableAttemptId(keyPrefix, residual.created_at, role)`, and
`created_at` is **preserved** when the shrunken residual is written back — so every pass of the
flatten loop regenerates the identical client order id.

- If the first flatten filled **0** (the normal reason a residual exists), the intent upsert returns
  the existing intent, immutable fields match, and `execute()` takes the "prior submission exists"
  branch: it re-reads the stale order and resolves. **No order is ever sent again.**
- If it filled **partially**, the quantity now differs, so `assertIntentImmutableMatch` throws; that
  error matches neither branch of `flattenResidual`'s catch and is **swallowed entirely**.

Either way, after the first attempt live residual legs can never be flattened again, and naked option
exposure stays open.

**Deferred because** the fix needs a per-pass component in the durable order identity (a flatten
attempt counter on the residual record, persisted with it) plus tightening the catch. That touches the
durable intent identity on the live path, and I will not change order-identity semantics for real
orders in the same change as seven unrelated fixes — it deserves its own change with its own
crash-recovery tests. It is the single most important remaining item.

### 3. `persistOrder` ignores the guarded-write result and can double-count exposure
`orderManager.ts`

`result.applied` is never read, and the fill delta is computed against the *caller's* in-memory
snapshot rather than the pre-write document. A reconcile pass that loaded intents before an await, then
persisted a fill the live path had already recorded, credits the same quantity twice.
`attributedBoxPositions` is the permission gate for reduction and residual orders, so an inflated net
could authorise reducing more than is actually held. Bounded by the same reconcile pass rebuilding the
map from the journal — but reduction submits happen inside that window.

**Deferred because** the correct fix is to make the delta authoritative from the guarded write
(`applied` plus the pre-image), which is a change to the durable write contract and wants its own
concurrency tests.

### 4. Paper abort path can fill legs that never arrived
`legExecutor.requestCancel`

The abort loop moves **every** not-done leg to `CANCEL_REQUESTED` without checking arrival, and the
tick listener deliberately treats that state as fillable while skipping the timeout guard. Legs still
in flight — or, in sequential mode, never submitted at all — can therefore fill, producing
`fill_at < arrival_at`.

Paper-only (the cancel-race model is wired only under `live_parity`), so no real money. But it invents
exposure that then drives an emergency unwind, and it corrupts exactly the parity statistics the module
exists to measure. **Deferred** as a behavioural change to the cancel-race model that should be made
with the parity fixtures regenerated in the same pass.

### 5. Deleting a trade evicts its cached P&L row from today's day hash only
`engine.deleteTrade` / `pnlCache.evictTrade`

An open position is mirrored into **every** day it survives, and a trade closed on D1 but deleted on D2
is evicted from D2's hash. The archiver prefers the cache over a fresh snapshot, so a stale row can be
re-drained into `box_daily_pnl`, resurrecting a deleted trade's P&L in that day's archived total.
Mongo is cleared for all days; only the cache is not. **Deferred**: needs eviction across the day index
(or the closed-day range), and a test that exercises the archiver's cache-preference path.

### 6. STT nearest-rupee rounding is applied per leg, not per contract note
`localCharges.calculateLegCharges`

The statutory rounding belongs to the STT head of the note; applying it per order line drifts ±₹1 per
sell leg (±₹2 per round trip, either direction). **Deferred deliberately**: it is a modelling-granularity
question, the charge reconciler already surfaces a persistent `stt` bias against the broker's own note,
and changing charge granularity would move every stored charge figure and its golden fixtures. Worth
doing only as an explicit, separately-reviewed decision.

### 7. Lower-severity, latent
- **Depth-less ticks** admit an empty book as "fresh" and satisfy feed health when no prior book exists.
  No bad fill results (size 0 is not executable), but feed health and the reject taxonomy are overstated.
- **Retry queues consult the position book**, contradicting their own documented invariant that a
  confirmed fill must be persisted even if the position has left memory. Harmless today because nothing
  clears the book; a real defect the moment anything does.
- **`buildFinalExitLegs` fabricates freshness** (`fresh: true`, `bid/ask: 0`) for post-hoc accounting on
  an already-executed close. No decision is taken on it, but a future reader trusting `metrics.liquidity_ok`
  on a closed trade would be misled.
- **The one-lot exit gate is only exact because `quantity === lot_size`** today. A multi-lot mode would
  under-check depth by a factor of `lots`.
- **Dhan `waitForResolution`** returns a non-terminal order without a protective cancel on one branch,
  asymmetric with the Kite adapter. Currently unreachable (nothing deletes from the order map), but the
  wrong default.

## Verified CORRECT — do not re-audit

Recorded so the next review does not spend its budget here.

- **Direction algebra** in `math.ts`. `capturedEdge ≡ grossPnl` for both directions; every side comes
  from `BOX_ENTRY_SIDES_BY_DIRECTION` / `exitSideFor` with no hand-written sign. Traced numerically for a
  short box.
- **Charge rate card.** STT sell-only, stamp duty buy-only, GST base = brokerage + exchange + SEBI (never
  STT or stamp), ₹20 per order × 4 legs, and the "leg total = sum of rounded heads" invariant.
- **No entry-slippage double count** (pre-execution deducts the allowance; final qualification passes 0
  because the executed gross edge already contains it), and **no exit-charge double count** at close.
- **Margin.** Null/NaN margin is excluded rather than zeroed; `peak_concurrent_margin` sweeps half-open
  intervals and is `null` until first sampled; the day figure is a documented SUM, not a peak.
- **Exit decision structure.** No `&&`/`||` precedence trap; "converged into a loss" is recorded as
  `net_below_floor` and never exits; boundary inequalities are the inclusive/safe ones.
- **Expiry safety.** 14:45 IST from a 15:30 close, expiry-day-only, IST throughout with no server-local
  time leak.
- **Freshness.** One clock; a missing quote is `fresh: false` with `age_ms: null`, never age 0; a
  future-dated quote is stale, not fresh.
- **Liquidity side** is the reversing side, and size is read *at* the touch price, not total depth.
- **Monitor loop.** One position's exception cannot abort the cycle; `closingIds` is added synchronously
  before the first await, so no double-close.
- **`BoundedTtlCache`** genuinely bounds; **`CumulativeFillLedger`** is idempotent and monotonic, with the
  durable `$lte` guard preventing a stale poll from rewinding a stored fill.
- **`liquidityLedger`** has no `release` by design: reservations are keyed by quote version and a newer
  version prunes older keys, so a superseded reservation reads as 0 rather than corrupting the current one.
- **Terminal-state overwrite** is blocked by `INTENT_STATE_PREDECESSORS`, which still allows the
  legitimate `CANCEL_REQUESTED → COMPLETE` cancel-race transition.
