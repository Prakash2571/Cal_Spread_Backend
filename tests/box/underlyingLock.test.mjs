/**
 * SUITE D — ONE ACTIVE BOX PER UNDERLYING.
 *
 * The restriction is broader than the exact-contract reservation and OPTIONAL. The properties
 * that matter:
 *
 *   - it blocks a second Box on the same underlying at DIFFERENT strikes (zero shared contracts),
 *   - it is reported as `underlying_already_active`, NEVER as a contract reservation conflict,
 *   - open / partial / recovery / residual / uncertain-intent state all block it,
 *   - a FLAT Box does NOT block it (the lock must not become permanent),
 *   - it survives a restart, because it derives from durable state rather than a lease,
 *   - with the restriction OFF it is a complete no-op.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  activeUnderlyings,
  assertNoKeyClassCollision,
  evaluateUnderlyingAdmission,
  isUnderlyingReservationKey,
  mayReleaseUnderlyingLease,
  parseUnderlyingReservationKey,
  underlyingReservationKey,
  UNDERLYING_ALREADY_ACTIVE_REASON,
  UNDERLYING_KEY_CLASS,
} from "../../dist/box/underlyingLock.js";
import { instrumentKey } from "../../dist/box/instrumentKey.js";

const FOUR_LOTS = { k1_ce: 100, k2_ce: 100, k2_pe: 100, k1_pe: 100 };
const FLAT = { k1_ce: 0, k2_ce: 0, k2_pe: 0, k1_pe: 0 };

function admit(underlying, input, enabled = true) {
  return evaluateUnderlyingAdmission({
    enabled,
    underlying,
    active: activeUnderlyings(input),
  });
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────

test("the key is broker-namespaced, like every other reservation key", () => {
  // Broker namespacing is not cosmetic: fencing, generation and deployment scoping in the
  // reservation layer all key off the leading namespace, and the error-redaction regex in
  // reservations/types.ts matches on it.
  assert.equal(underlyingReservationKey("zerodha", "reliance"), "ZERODHA:UNDERLYING:RELIANCE");
  assert.equal(underlyingReservationKey("dhan", "RELIANCE"), "DHAN:UNDERLYING:RELIANCE");
  assert.equal(underlyingReservationKey(" ZERODHA ", " reliance "), "ZERODHA:UNDERLYING:RELIANCE");
});

test("one broker's underlying lock cannot block the other broker's", () => {
  assert.notEqual(
    underlyingReservationKey("zerodha", "RELIANCE"),
    underlyingReservationKey("dhan", "RELIANCE"),
  );
});

test("an underlying key can never collide with a contract key", () => {
  const contract = instrumentKey("zerodha", {
    token: 12345,
    tradingsymbol: "RELIANCE25SEP2500CE",
    exchange: "NFO",
  });
  const underlying = "ZERODHA:UNDERLYING:RELIANCE";
  assert.notEqual(contract, underlying);
  assert.equal(isUnderlyingReservationKey(contract), false);
  assert.equal(isUnderlyingReservationKey(underlying), true);
  // The token-fallback shape must not alias either.
  const tokenKey = instrumentKey("zerodha", { token: 9, tradingsymbol: "", exchange: "" });
  assert.equal(isUnderlyingReservationKey(tokenKey), false);
});

test("the key class is not a real exchange code, so the two key spaces stay disjoint", () => {
  assert.doesNotThrow(() => assertNoKeyClassCollision(["NFO", "NSE", "BSE", "BFO", "MCX", "CDS"]));
  assert.throws(() => assertNoKeyClassCollision(["NFO", UNDERLYING_KEY_CLASS]), /collides/);
});

test("parsing is total: malformed keys degrade to null rather than throwing", () => {
  assert.equal(parseUnderlyingReservationKey("ZERODHA:UNDERLYING:RELIANCE"), "RELIANCE");
  for (const bad of ["", "ZERODHA:NFO:SYM", "UNDERLYING:RELIANCE", "A:UNDERLYING:", "a:b:c:d"]) {
    assert.equal(parseUnderlyingReservationKey(bad), null, `${bad} must not parse`);
  }
});

// ── the core restriction ─────────────────────────────────────────────────────────────────

test("RELIANCE active blocks a DIFFERENT-STRIKE RELIANCE Box (zero shared contracts)", () => {
  // Box A is RELIANCE 2500/2600; the candidate is RELIANCE 2550/2650. No contract overlaps.
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, UNDERLYING_ALREADY_ACTIVE_REASON);
  assert.equal(verdict.underlying, "RELIANCE");
});

test("the refusal is NOT reported as a contract reservation conflict", () => {
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  });
  assert.equal(verdict.reason, "underlying_already_active");
  assert.notEqual(verdict.reason, "contract_reserved");
  assert.match(verdict.detail, /NOT a contract reservation conflict/);
  assert.match(verdict.detail, /regardless of strike pair, expiry or direction/);
});

test("a DIFFERENT underlying is allowed", () => {
  const input = {
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  };
  assert.equal(admit("TCS", input).allowed, true);
  assert.equal(admit("INFY", input).allowed, true);
});

test("MAX_OPEN_BOXES=3 with the restriction ON allows three DIFFERENT underlyings", () => {
  // Interaction pinned by Part 14: three underlyings fine, two of one underlying not.
  const three = {
    positions: [
      { underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS },
      { underlying: "TCS", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS },
      { underlying: "INFY", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS },
    ],
  };
  const active = activeUnderlyings(three);
  assert.equal(active.size, 3);
  for (const u of ["RELIANCE", "TCS", "INFY"]) {
    assert.equal(admit(u, three).allowed, false, `${u} already active`);
  }
  assert.equal(admit("HDFCBANK", three).allowed, true, "a fourth underlying is not blocked by THIS gate");
});

// ── every blocking state ─────────────────────────────────────────────────────────────────

test("a PARTIALLY_EXITED RELIANCE position blocks a new RELIANCE Box", () => {
  const verdict = admit("RELIANCE", {
    positions: [{
      underlying: "RELIANCE",
      position_state: "PARTIALLY_EXITED",
      remaining_qty_by_role: { k1_ce: 100, k2_ce: 0, k2_pe: 100, k1_pe: 0 },
    }],
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.activity.kinds.includes("partially_exited"));
});

test("a RECOVERY RELIANCE position blocks a new RELIANCE Box", () => {
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "RECOVERY", remaining_qty_by_role: FOUR_LOTS }],
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.activity.kinds.includes("recovery"));
});

test("a RECOVERY position blocks even when its quantities LOOK flat", () => {
  // RECOVERY means the quantities are not trusted, so flatness cannot clear it.
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "RECOVERY", remaining_qty_by_role: FLAT }],
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.activity.kinds.includes("recovery"));
});

test("unresolved RESIDUAL exposure blocks a new RELIANCE Box", () => {
  const verdict = admit("RELIANCE", { residuals: [{ underlying: "RELIANCE", legs: 2 }] });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.activity.kinds.includes("residual_exposure"));
});

test("a residual entry with zero legs does not block", () => {
  assert.equal(admit("RELIANCE", { residuals: [{ underlying: "RELIANCE", legs: 0 }] }).allowed, true);
});

test("a WORKING entry order blocks a new RELIANCE Box", () => {
  for (const state of ["CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED"]) {
    const verdict = admit("RELIANCE", { intents: [{ underlying: "RELIANCE", state }] });
    assert.equal(verdict.allowed, false, `${state} must block`);
    assert.ok(verdict.activity.kinds.includes("working_entry_order"), `${state} kind`);
  }
});

test("an UNCERTAIN intent blocks, and is reported as worse than merely working", () => {
  for (const state of ["UNKNOWN", "RECONCILIATION_REQUIRED"]) {
    const verdict = admit("RELIANCE", { intents: [{ underlying: "RELIANCE", state }] });
    assert.equal(verdict.allowed, false, `${state} must block`);
    assert.ok(verdict.activity.kinds.includes("uncertain_intent"));
  }
});

test("a TERMINAL intent does not block the underlying forever", () => {
  for (const state of ["COMPLETE", "CANCELLED", "REJECTED"]) {
    assert.equal(
      admit("RELIANCE", { intents: [{ underlying: "RELIANCE", state }] }).allowed,
      true,
      `${state} must not block once the position itself is flat`,
    );
  }
});

test("an ENTRY PIPELINE in flight blocks a new RELIANCE Box", () => {
  const verdict = admit("RELIANCE", { pipelines: [{ underlying: "RELIANCE" }] });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.activity.kinds.includes("entry_in_flight"));
});

// ── the lock must not become permanent ───────────────────────────────────────────────────

test("a FULLY FLAT Box does NOT block: the lock is released, not retained", () => {
  // Retaining it here would silently turn the setting into "one Box per underlying per
  // process lifetime", a different and unrequested restriction.
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FLAT }],
  });
  assert.equal(verdict.allowed, true);
});

test("an explicitly FLAT position state does not block", () => {
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "FLAT", remaining_qty_by_role: FLAT }],
  });
  assert.equal(verdict.allowed, true);
});

test("after everything clears, the underlying is admissible again", () => {
  const cleared = activeUnderlyings({ positions: [], residuals: [], intents: [], pipelines: [] });
  assert.equal(cleared.size, 0);
  assert.equal(evaluateUnderlyingAdmission({ enabled: true, underlying: "RELIANCE", active: cleared }).allowed, true);
});

// ── restart safety ───────────────────────────────────────────────────────────────────────

test("RESTART: durable state alone still blocks, with no lease involved", () => {
  // The input here is exactly what a boot-time Mongo load produces. No TTL, no in-process Set.
  const durableOnly = {
    positions: [{ underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }],
  };
  const afterRestart = JSON.parse(JSON.stringify(durableOnly));
  assert.equal(admit("RELIANCE", afterRestart).allowed, false);
});

test("RESTART: a residual row loaded at boot still blocks", () => {
  const afterRestart = JSON.parse(JSON.stringify({ residuals: [{ underlying: "RELIANCE", legs: 1 }] }));
  assert.equal(admit("RELIANCE", afterRestart).allowed, false);
});

// ── disabled ─────────────────────────────────────────────────────────────────────────────

test("with the restriction OFF it is a complete no-op", () => {
  const busy = {
    positions: [
      { underlying: "RELIANCE", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS },
      { underlying: "RELIANCE", position_state: "RECOVERY", remaining_qty_by_role: FOUR_LOTS },
    ],
    residuals: [{ underlying: "RELIANCE", legs: 3 }],
    intents: [{ underlying: "RELIANCE", state: "UNKNOWN" }],
    pipelines: [{ underlying: "RELIANCE" }],
  };
  const verdict = admit("RELIANCE", busy, false);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.enabled, false);
});

// ── details ──────────────────────────────────────────────────────────────────────────────

test("case and whitespace in the underlying are normalised on both sides", () => {
  const input = { positions: [{ underlying: " reliance ", position_state: "BOX", remaining_qty_by_role: FOUR_LOTS }] };
  assert.equal(admit("RELIANCE", input).allowed, false);
  assert.equal(admit("  ReLiAnCe ", input).allowed, false);
});

test("multiple reasons are reported together, deterministically ordered", () => {
  const verdict = admit("RELIANCE", {
    positions: [{ underlying: "RELIANCE", position_state: "PARTIALLY_EXITED", remaining_qty_by_role: FOUR_LOTS }],
    residuals: [{ underlying: "RELIANCE", legs: 1 }],
    pipelines: [{ underlying: "RELIANCE" }],
  });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.activity.kinds, ["entry_in_flight", "partially_exited", "residual_exposure"]);
  // Stable across calls, so a snapshot assertion does not depend on insertion order.
  const again = admit("RELIANCE", {
    pipelines: [{ underlying: "RELIANCE" }],
    residuals: [{ underlying: "RELIANCE", legs: 1 }],
    positions: [{ underlying: "RELIANCE", position_state: "PARTIALLY_EXITED", remaining_qty_by_role: FOUR_LOTS }],
  });
  assert.deepEqual(again.activity.kinds, verdict.activity.kinds);
});

test("the entry-pipeline LEASE may be released on a clean settle, but held when uncertain", () => {
  assert.equal(mayReleaseUnderlyingLease("clean"), true);
  assert.equal(mayReleaseUnderlyingLease("uncertain"), false);
});
