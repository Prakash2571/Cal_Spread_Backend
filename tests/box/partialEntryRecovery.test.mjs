/**
 * SUITE G — PARTIAL ENTRY.
 *
 * The three rules the implementation must never break:
 *
 *   - never pretend unfilled quantity filled,
 *   - never discard a known fill,
 *   - never "cancel" a filled quantity.
 *
 * Plus the two that make a recovery safe rather than merely tidy: a cancel can RACE a fill, so
 * an unwind must never be sized from a pre-terminal snapshot; and an UNKNOWN broker state is
 * not zero, so it must quarantine rather than unwind.
 *
 * Exact quantity conservation is asserted for every role in every case.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  planPartialEntryRecovery,
  reverseSide,
  verifyQuantityConservation,
} from "../../dist/box/partialEntryRecovery.js";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
const SIDES = { k1_ce: "BUY", k2_ce: "SELL", k2_pe: "BUY", k1_pe: "SELL" };
const QTY = 100;

/** A leg outcome with sensible defaults: submitted, terminal, known state. */
function leg(role, confirmedFilled, over = {}) {
  return {
    role,
    side: SIDES[role],
    requested: QTY,
    confirmedFilled,
    terminal: true,
    submitted: true,
    brokerStateKnown: true,
    ...over,
  };
}

function plan(legs) {
  return planPartialEntryRecovery({ legs, expectedRoles: ROLES });
}

/** Assert per-role conservation: residual === confirmed - unwound, and never negative. */
function assertConserved(legs, unwoundByRole) {
  const result = verifyQuantityConservation({ entry: legs, unwoundByRole });
  for (const l of legs) {
    const unwound = unwoundByRole[l.role] ?? 0;
    assert.equal(
      result.residualByRole[l.role],
      Math.max(0, l.confirmedFilled - unwound),
      `${l.role}: residual must equal confirmed - unwound`,
    );
    assert.ok(result.residualByRole[l.role] >= 0, `${l.role}: residual must never be negative`);
  }
  return result;
}

test("reverseSide is the only expression of the entry->unwind inversion", () => {
  assert.equal(reverseSide("BUY"), "SELL");
  assert.equal(reverseSide("SELL"), "BUY");
});

// ── 4/4 ──────────────────────────────────────────────────────────────────────────────────

test("4/4 full: proceed to final economics qualification, unwind nothing", () => {
  const legs = ROLES.map((r) => leg(r, QTY));
  const p = plan(legs);
  assert.equal(p.action, "qualify_complete_box");
  assert.equal(p.complete, true);
  assert.deepEqual(p.unwind, []);
  assert.deepEqual(p.cancelRoles, []);
  assert.equal(p.totalConfirmedQuantity, QTY * 4);
  const c = assertConserved(legs, {});
  assert.equal(c.conserved, true);
  assert.equal(c.totalResidual, QTY * 4, "a complete Box IS the exposure; it is not residual to flatten");
});

// ── 3 full + 1 zero ──────────────────────────────────────────────────────────────────────

test("3 full + 1 zero: unwind exactly the three confirmed legs at exact quantities", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 0)];
  const p = plan(legs);
  assert.equal(p.action, "unwind_confirmed_exposure");
  assert.equal(p.complete, false);
  assert.equal(p.unwind.length, 3, "the zero-fill leg has nothing to unwind");
  for (const u of p.unwind) {
    assert.equal(u.quantity, QTY);
    assert.equal(u.side, reverseSide(SIDES[u.role]), "the unwind reverses the entry side");
  }
  assert.equal(p.confirmedByRole.k1_pe, 0);

  // Full unwind ⇒ nothing left.
  const unwound = { k1_ce: QTY, k2_ce: QTY, k2_pe: QTY };
  const c = assertConserved(legs, unwound);
  assert.equal(c.conserved, true);
  assert.equal(c.totalResidual, 0);
  assert.equal(c.requiresRecovery, false);
});

// ── 3 full + 1 partial ───────────────────────────────────────────────────────────────────

test("3 full + 1 partial: the partial leg is unwound at its CONFIRMED quantity, not its requested one", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 40)];
  const p = plan(legs);
  assert.equal(p.action, "unwind_confirmed_exposure");
  const partial = p.unwind.find((u) => u.role === "k1_pe");
  assert.equal(partial.quantity, 40, "must unwind 40, never the requested 100");
  assert.equal(p.totalConfirmedQuantity, QTY * 3 + 40);
  const c = assertConserved(legs, { k1_ce: QTY, k2_ce: QTY, k2_pe: QTY, k1_pe: 40 });
  assert.equal(c.totalResidual, 0);
});

test("the shortfall is NEVER treated as filled", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 40)];
  const p = plan(legs);
  assert.equal(p.complete, false, "60 units short is not a valid Box");
  // Nothing anywhere claims 100 on the short leg.
  assert.equal(p.confirmedByRole.k1_pe, 40);
});

// ── 2 partial + 2 zero ───────────────────────────────────────────────────────────────────

test("2 partial + 2 zero: unwind only the two legs that actually filled", () => {
  const legs = [leg("k1_ce", 30), leg("k2_ce", 70), leg("k2_pe", 0), leg("k1_pe", 0)];
  const p = plan(legs);
  assert.equal(p.action, "unwind_confirmed_exposure");
  assert.equal(p.unwind.length, 2);
  assert.equal(p.unwind.find((u) => u.role === "k1_ce").quantity, 30);
  assert.equal(p.unwind.find((u) => u.role === "k2_ce").quantity, 70);
  assert.equal(p.totalConfirmedQuantity, 100);
  const c = assertConserved(legs, { k1_ce: 30, k2_ce: 70 });
  assert.equal(c.totalResidual, 0);
});

// ── no fill ──────────────────────────────────────────────────────────────────────────────

test("no fill anywhere: nothing to unwind", () => {
  const legs = ROLES.map((r) => leg(r, 0));
  const p = plan(legs);
  assert.equal(p.action, "no_exposure");
  assert.deepEqual(p.unwind, []);
  assert.equal(p.totalConfirmedQuantity, 0);
});

// ── never-submitted legs are stopped ─────────────────────────────────────────────────────

test("roles that were never submitted are reported for STOPPING, not for cancelling", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", 0, { submitted: false })];
  const p = plan(legs);
  // k2_pe and k1_pe are absent from `legs` entirely, so they too were never submitted.
  assert.deepEqual([...p.stopSubmitRoles].sort(), ["k1_pe", "k2_ce", "k2_pe"]);
  assert.ok(!p.cancelRoles.includes("k2_ce"), "an unsubmitted order cannot be cancelled");
  assert.equal(p.confirmedByRole.k2_pe, 0);
});

// ── the cancel/fill race ─────────────────────────────────────────────────────────────────

test("a still-working leg produces a CANCEL request and DEFERS the unwind", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 20, { terminal: false })];
  const p = plan(legs);
  assert.equal(p.action, "await_terminal");
  assert.deepEqual(p.cancelRoles, ["k1_pe"]);
  assert.deepEqual(p.awaitTerminalRoles, ["k1_pe"]);
  assert.deepEqual(p.unwind, [], "sizing an unwind from a pre-terminal snapshot would strand a raced fill");
  assert.match(p.detail, /cancel can race a fill/);
});

test("a cancel that RACED a fill is unwound at the larger terminal quantity", () => {
  // Snapshot before the cancel: 20 filled, still working.
  const before = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 20, { terminal: false })];
  assert.equal(plan(before).action, "await_terminal");

  // The cancel raced: by the time the broker reported terminal, 55 had filled.
  const after = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 55)];
  const p = plan(after);
  assert.equal(p.action, "unwind_confirmed_exposure");
  assert.equal(
    p.unwind.find((u) => u.role === "k1_pe").quantity,
    55,
    "the raced quantity must be unwound, not stranded at the stale 20",
  );
  const c = assertConserved(after, { k1_ce: QTY, k2_ce: QTY, k2_pe: QTY, k1_pe: 55 });
  assert.equal(c.totalResidual, 0);
});

test("cancellation applies to the WORKING remainder: a fully-filled leg is not cancelled", () => {
  const legs = ROLES.map((r) => leg(r, QTY));
  const p = plan(legs);
  assert.deepEqual(p.cancelRoles, [], "a filled quantity is never cancelled");
});

// ── unknown broker state ─────────────────────────────────────────────────────────────────

test("UNKNOWN broker state QUARANTINES: it neither unwinds nor opens", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 0, { brokerStateKnown: false })];
  const p = plan(legs);
  assert.equal(p.action, "quarantine_unknown");
  assert.equal(p.quantityUnknown, true);
  assert.equal(p.complete, false);
  assert.deepEqual(p.unwind, [], "unwinding an unprovable quantity would create opposite naked exposure");
  assert.match(p.detail, /unprovable/);
});

test("UNKNOWN outranks a still-working leg: quarantine wins over await_terminal", () => {
  const legs = [
    leg("k1_ce", QTY),
    leg("k2_ce", QTY, { terminal: false }),
    leg("k2_pe", QTY),
    leg("k1_pe", 10, { brokerStateKnown: false }),
  ];
  assert.equal(plan(legs).action, "quarantine_unknown");
});

test("an UNKNOWN leg is not silently read as zero", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", QTY), leg("k1_pe", 33, { brokerStateKnown: false })];
  const p = plan(legs);
  // Its observed quantity is still counted in the total, so the operator sees it exists.
  assert.equal(p.confirmedByRole.k1_pe, 33);
  assert.equal(p.totalConfirmedQuantity, QTY * 3 + 33);
});

// ── partial and failed unwind ────────────────────────────────────────────────────────────

test("a PARTIAL unwind leaves exact durable residual, never a rounded one", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", QTY), leg("k2_pe", 60), leg("k1_pe", 0)];
  // The unwind itself only partially filled.
  const c = assertConserved(legs, { k1_ce: 100, k2_ce: 45, k2_pe: 0 });
  assert.equal(c.conserved, true);
  assert.equal(c.residualByRole.k1_ce, 0);
  assert.equal(c.residualByRole.k2_ce, 55);
  assert.equal(c.residualByRole.k2_pe, 60);
  assert.equal(c.residualByRole.k1_pe, 0);
  assert.equal(c.totalResidual, 115);
  assert.equal(c.requiresRecovery, false, "an incomplete unwind is residual exposure, not a violation");
});

test("a FAILED unwind (zero unwound) carries the whole confirmed exposure forward", () => {
  const legs = [leg("k1_ce", QTY), leg("k2_ce", 80), leg("k2_pe", 0), leg("k1_pe", 0)];
  const c = assertConserved(legs, {});
  assert.equal(c.conserved, true);
  assert.equal(c.totalResidual, 180);
  assert.equal(c.residualByRole.k2_ce, 80);
});

// ── conservation violations must reach RECOVERY ──────────────────────────────────────────

test("unwinding MORE than confirmed is a violation and requires RECOVERY", () => {
  const legs = [leg("k1_ce", 50)];
  const c = verifyQuantityConservation({ entry: legs, unwoundByRole: { k1_ce: 70 } });
  assert.equal(c.conserved, false);
  assert.equal(c.requiresRecovery, true);
  const kinds = c.violations.map((v) => v.kind);
  assert.ok(kinds.includes("unwound_more_than_confirmed"));
  assert.ok(kinds.includes("negative_residual"));
  // Clamped for accounting, but the violation is NOT hidden.
  assert.equal(c.residualByRole.k1_ce, 0);
});

test("a broker OVERFILL is surfaced and requires RECOVERY, never clamped away", () => {
  const legs = [leg("k1_ce", 130)]; // requested 100
  const c = verifyQuantityConservation({ entry: legs, unwoundByRole: { k1_ce: 130 } });
  assert.equal(c.requiresRecovery, true);
  const overfill = c.violations.find((v) => v.kind === "overfill");
  assert.ok(overfill, "broker truth proving an overfill must trigger RECOVERY");
  assert.equal(overfill.confirmed, 130);
  assert.equal(overfill.requested, 100);
  assert.match(overfill.detail, /RECOVERY/);
});

test("residual is never negative unless broker truth genuinely proves an overfill", () => {
  // Ordinary cases: always non-negative, never flagged.
  for (const [confirmed, unwound] of [[0, 0], [100, 0], [100, 100], [40, 40], [40, 10]]) {
    const c = verifyQuantityConservation({
      entry: [leg("k1_ce", confirmed)],
      unwoundByRole: { k1_ce: unwound },
    });
    assert.ok(c.residualByRole.k1_ce >= 0);
    assert.equal(c.requiresRecovery, false, `confirmed ${confirmed} / unwound ${unwound} must be clean`);
  }
});

test("every role appears in the conservation result, including zero-fill roles", () => {
  const legs = ROLES.map((r, i) => leg(r, i === 0 ? QTY : 0));
  const c = verifyQuantityConservation({ entry: legs, unwoundByRole: { k1_ce: QTY } });
  for (const role of ROLES) {
    assert.ok(role in c.residualByRole, `${role} must be accounted for even at zero`);
  }
  assert.equal(c.totalResidual, 0);
});
