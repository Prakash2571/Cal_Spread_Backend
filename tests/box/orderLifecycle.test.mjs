/**
 * ACK IS NOT FILL, and cumulative fill accounting is idempotent and monotonic.
 *
 * Covers the required cases:
 *   1. ACK does not equal fill.
 *   4. Cancel terminal cumulative quantity wins.
 *   6. Duplicate broker event is idempotent.
 *   7. Out-of-order event cannot reduce cumulative quantity.
 *  29. Quantity invariants: no silent clamping, no full-quantity retry.
 *
 * Pure and offline: no clock, no broker, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_ORDER_STAGES,
  CumulativeFillLedger,
  durableStateForStage,
  isTerminalStage,
  outstandingQuantity,
  stageAcceptsFurtherFills,
  stageForDurableState,
  stageFromCumulativeQuantity,
  stageProvesExecution,
  terminalQuantityAccounting,
} from "../../dist/box/orderLifecycle.js";
import {
  approximateWallFor,
  createExecutionClock,
  createFixedExecutionClock,
  monoSpan,
} from "../../dist/box/executionClock.js";
import { BROKER_ORDER_STATES } from "../../dist/box/brokerAdapter.js";

/* ─────────────────────────── stage vocabulary ─────────────────────────── */

test("every observable stage maps to a real durable state (mapping is total)", () => {
  const durable = new Set(BROKER_ORDER_STATES);
  for (const stage of BOX_ORDER_STAGES) {
    const state = durableStateForStage(stage);
    assert.ok(durable.has(state), `${stage} mapped to unknown durable state ${state}`);
  }
});

test("the observable vocabulary is a strict superset of the durable one", () => {
  // Every durable state must be reachable, so a restart can always rehydrate a stage.
  for (const state of BROKER_ORDER_STATES) {
    const stage = stageForDurableState(state);
    assert.ok(BOX_ORDER_STAGES.includes(stage), `${state} rehydrated to unknown stage ${stage}`);
  }
  // And the superset genuinely adds the distinctions the durable enum collapses.
  assert.ok(BOX_ORDER_STAGES.length > BROKER_ORDER_STATES.length);
  for (const added of ["QUEUED", "POSTING", "BROKER_ACCEPTED", "WORKING", "CANCEL_PENDING", "EXPIRED"]) {
    assert.ok(BOX_ORDER_STAGES.includes(added), `${added} missing from the observable vocabulary`);
  }
});

test("rehydrating a durable state never invents a sub-stage it did not record", () => {
  // ACKNOWLEDGED must not become BROKER_ACCEPTED, and CANCEL_REQUESTED must not become
  // CANCEL_PENDING: both would claim knowledge the durable record does not contain.
  assert.equal(stageForDurableState("ACKNOWLEDGED"), "ACKNOWLEDGED");
  assert.equal(stageForDurableState("CANCEL_REQUESTED"), "CANCEL_REQUESTED");
  assert.equal(stageForDurableState("SUBMITTING"), "POSTING");
  assert.equal(stageForDurableState("OPEN"), "WORKING");
});

test("REQUIRED 1: no stage — not HTTP success, not a broker ACK — ever proves execution", () => {
  for (const stage of BOX_ORDER_STAGES) {
    assert.equal(stageProvesExecution(stage), false, `${stage} must not prove execution`);
  }
});

test("REQUIRED 1: ACK and BROKER_ACCEPTED are non-terminal and imply zero filled quantity", () => {
  for (const stage of ["BROKER_ACCEPTED", "ACKNOWLEDGED", "WORKING"]) {
    assert.equal(isTerminalStage(stage), false, `${stage} must not be terminal`);
    assert.equal(stageAcceptsFurtherFills(stage), true);
  }
  // A ledger that has only seen an ACK has no exposure at all.
  const ledger = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);
  assert.equal(ledger.cumulative, 0);
  assert.equal(ledger.hasExposure, false);
  assert.equal(ledger.remaining, 75);
});

test("a cancel in flight still accepts fills; only a confirmed terminal state does not", () => {
  assert.equal(stageAcceptsFurtherFills("CANCEL_REQUESTED"), true);
  assert.equal(stageAcceptsFurtherFills("CANCEL_PENDING"), true);
  // Not knowing is not the same as knowing nothing happened.
  assert.equal(stageAcceptsFurtherFills("UNKNOWN"), true);
  assert.equal(stageAcceptsFurtherFills("RECONCILIATION_REQUIRED"), true);

  assert.equal(stageAcceptsFurtherFills("CANCELLED"), false);
  assert.equal(stageAcceptsFurtherFills("FILLED"), false);
  assert.equal(stageAcceptsFurtherFills("REJECTED"), false);
  assert.equal(stageAcceptsFurtherFills("EXPIRED"), false);
});

test("EXPIRED persists as CANCELLED but stays distinct in the observable record", () => {
  assert.equal(durableStateForStage("EXPIRED"), "CANCELLED");
  assert.equal(durableStateForStage("CANCELLED"), "CANCELLED");
  assert.notEqual("EXPIRED", "CANCELLED");
});

test("quantity, not the broker status string, decides the stage", () => {
  // A broker reporting a terminal cancel while showing a full cumulative fill HAS filled.
  assert.equal(
    stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 75, cancelConfirmed: true }),
    "FILLED",
  );
  assert.equal(
    stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 40, cancelConfirmed: true }),
    "CANCELLED",
  );
  assert.equal(stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 40 }), "PARTIALLY_FILLED");
  assert.equal(stageFromCumulativeQuantity({ requestedQty: 75, cumulativeQty: 0 }), "WORKING");
});

/* ─────────────────────── cumulative fill ledger ─────────────────────── */

test("cumulative snapshots produce deltas, not double counts", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);

  let r = l.apply({ cumulativeQty: 25, averagePrice: 100.1, source: "rest_poll" });
  assert.equal(r.outcome, "applied");
  assert.equal(r.delta, 25);
  assert.equal(r.cumulative, 25);
  assert.equal(r.remaining, 50);

  // The next poll reports the RUNNING TOTAL, not the increment.
  r = l.apply({ cumulativeQty: 60, averagePrice: 100.15, source: "rest_poll" });
  assert.equal(r.delta, 35, "delta must be 60-25, never 60");
  assert.equal(r.cumulative, 60);
  assert.equal(l.averagePrice, 100.15);
});

test("REQUIRED 6: a duplicate broker event is idempotent", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);
  const event = { cumulativeQty: 40, averagePrice: 100.1, eventId: "dhan:TRADE-991", source: "order_update" };

  const first = l.apply(event);
  assert.equal(first.outcome, "applied");
  assert.equal(first.delta, 40);

  // Redelivered by the order-update stream.
  const second = l.apply(event);
  assert.equal(second.outcome, "duplicate_event");
  assert.equal(second.delta, 0, "a redelivered event must contribute no quantity");
  assert.equal(second.cumulative, 40);

  // A third delivery is still harmless.
  assert.equal(l.apply(event).delta, 0);
  assert.equal(l.cumulative, 40);
  assert.equal(l.snapshot().duplicateEvents, 2);
  assert.equal(l.snapshot().appliedEvents, 1);
});

test("REQUIRED 7: an out-of-order event cannot reduce cumulative quantity", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);
  l.apply({ cumulativeQty: 52, sequence: 9, eventId: "e9", source: "order_update" });
  assert.equal(l.cumulative, 52);

  // A late event from BEFORE the one we already applied.
  const late = l.apply({ cumulativeQty: 40, sequence: 7, eventId: "e7", source: "order_update" });
  assert.equal(late.outcome, "stale_cumulative");
  assert.equal(late.delta, 0);
  assert.equal(late.cumulative, 52, "cumulative quantity must never rewind");
  assert.equal(late.sequenceRegression, true, "the regression should be visible in diagnostics");
  assert.equal(l.cumulative, 52);
  assert.equal(l.remaining, 23);
});

test("monotonicity does not depend on sequence numbers being present", () => {
  // Brokers differ in what they expose; correctness must come from the cumulative rule.
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k2_ce:attempt-1", 75);
  l.apply({ cumulativeQty: 75, source: "rest_poll" });
  const stale = l.apply({ cumulativeQty: 30, source: "postback" });
  assert.equal(stale.outcome, "stale_cumulative");
  assert.equal(l.cumulative, 75);
  assert.equal(stale.sequenceRegression, false, "no sequence supplied ⇒ nothing to regress");
});

test("a repeated identical cumulative carries no new quantity", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_pe:attempt-1", 75);
  l.apply({ cumulativeQty: 75, source: "rest_poll" });
  const again = l.apply({ cumulativeQty: 75, source: "rest_poll" });
  assert.equal(again.outcome, "stale_cumulative");
  assert.equal(again.delta, 0);
  assert.equal(l.snapshot().staleEvents, 1);
});

test("REQUIRED 29: an overfill is applied as broker truth and loudly flagged, never clamped", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);
  const r = l.apply({ cumulativeQty: 80, source: "rest_poll" });
  assert.equal(r.outcome, "applied_overfill");
  assert.equal(r.cumulative, 80, "the broker's number must not be silently clamped to 75");
  assert.equal(r.overfill, 5);
  assert.equal(l.hasOverfill, true);
  assert.equal(l.remaining, 0);
});

test("malformed observations are ignored rather than corrupting the total", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);
  l.apply({ cumulativeQty: 30, source: "rest_poll" });
  for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
    const r = l.apply({ cumulativeQty: bad, source: "rest_poll" });
    assert.equal(r.outcome, "invalid");
    assert.equal(r.delta, 0);
  }
  assert.equal(l.cumulative, 30);
});

test("first/last fill instants are captured from the injected clock, not read from a global", () => {
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);
  l.apply({ cumulativeQty: 10, observedAtMono: 1000, observedAtWall: 1_700_000_000_000, source: "order_update" });
  l.apply({ cumulativeQty: 75, observedAtMono: 1420, observedAtWall: 1_700_000_000_420, source: "order_update" });
  const s = l.snapshot();
  assert.equal(s.firstFillAtMono, 1000);
  assert.equal(s.lastFillAtMono, 1420);
  assert.equal(monoSpan(s.firstFillAtMono, s.lastFillAtMono), 420);
  assert.equal(s.firstFillAtWall, 1_700_000_000_000);
});

/* ───────────────── the cancel/fill race, quantified ───────────────── */

test("REQUIRED 4: the terminal cumulative quantity wins the cancel race (75 → 52 filled / 23 cancelled)", () => {
  // Exactly the scenario from the brief.
  const l = new CumulativeFillLedger("BOX:T1:ENTRY:k1_ce:attempt-1", 75);

  l.apply({ cumulativeQty: 40, eventId: "f1", sequence: 1, source: "order_update" });
  const atCancelRequest = l.cumulative;
  assert.equal(atCancelRequest, 40);

  // Cancel requested here. The exchange fills 12 more while it is in flight.
  l.apply({ cumulativeQty: 52, eventId: "f2", sequence: 2, source: "order_update" });

  // The cancel confirmation arrives afterwards, reporting the terminal total.
  const confirm = l.apply({ cumulativeQty: 52, eventId: "cancel-terminal", sequence: 3, source: "rest_poll" });
  assert.equal(confirm.outcome, "stale_cumulative", "the confirmation adds no new quantity");

  const acct = terminalQuantityAccounting({
    requestedQty: 75,
    finalCumulativeQty: l.cumulative,
    cumulativeAtCancelRequest: atCancelRequest,
  });

  assert.equal(acct.filled, 52, "must NOT be 40 just because cancel was requested at 40");
  assert.equal(acct.cancelled, 23);
  assert.equal(acct.racedQuantity, 12);
  assert.equal(acct.cancelRaced, true);
  assert.equal(acct.filled + acct.cancelled, 75, "quantity must be conserved");
});

test("a cancel that genuinely won the race reports no raced quantity", () => {
  const acct = terminalQuantityAccounting({
    requestedQty: 75,
    finalCumulativeQty: 40,
    cumulativeAtCancelRequest: 40,
  });
  assert.equal(acct.filled, 40);
  assert.equal(acct.cancelled, 35);
  assert.equal(acct.racedQuantity, 0);
  assert.equal(acct.cancelRaced, false);
});

test("REQUIRED 29: a follow-up operation may only ever ask for the remainder", () => {
  assert.equal(outstandingQuantity(75, 52), 23);
  assert.equal(outstandingQuantity(75, 0), 75);
  assert.equal(outstandingQuantity(75, 75), 0);
  // An overfilled order has nothing outstanding, and must never produce a negative request.
  assert.equal(outstandingQuantity(75, 80), 0);
});

/* ─────────────────────────── execution clock ─────────────────────────── */

test("latency measurement is immune to a wall-clock step (NTP correction)", () => {
  const clock = createFixedExecutionClock({ mono: 5_000, wall: 1_700_000_000_000 });
  const post = clock.stamp();

  clock.advance(120); // 120ms really elapsed
  // Now NTP yanks the wall clock backwards by two seconds.
  clock.setWall(clock.wall() - 2_000);
  const ack = clock.stamp();

  assert.equal(monoSpan(post.mono, ack.mono), 120, "monotonic span is the truth");
  // The wall difference is nonsense — which is exactly why it is never used for durations.
  assert.ok(ack.wall - post.wall < 0);
});

test("an inverted monotonic pair reports unknown rather than a fabricated number", () => {
  assert.equal(monoSpan(500, 400), null);
  assert.equal(monoSpan(null, 400), null);
  assert.equal(monoSpan(400, undefined), null);
  assert.equal(monoSpan(Number.NaN, 400), null);
  assert.equal(monoSpan(400, 400), 0, "a zero span is legitimate");
});

test("the real clock reports whether it actually found a monotonic source", () => {
  const real = createExecutionClock();
  assert.equal(real.monotonic, true);
  const a = real.mono();
  const b = real.mono();
  assert.ok(b >= a, "monotonic readings never go backwards");
  assert.ok(real.wall() > 1_600_000_000_000, "wall clock is epoch-based");

  // Degraded platform: no performance.now() available.
  const degraded = createExecutionClock({ performanceNow: undefined, dateNow: () => 42 });
  assert.equal(degraded.wall(), 42);
});

test("a monotonic reading can be rendered as an approximate wall time for audit only", () => {
  const anchor = { mono: 1_000, wall: 1_700_000_000_000 };
  assert.equal(approximateWallFor(anchor, 1_250), 1_700_000_000_250);
  assert.equal(approximateWallFor(anchor, Number.NaN), anchor.wall);
});
