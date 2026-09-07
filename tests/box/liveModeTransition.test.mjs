/**
 * SUITE H — MODE SAFETY.
 *
 * Two separate questions, and conflating them is the failure mode this suite guards:
 *
 *   DEPLOYMENT CAPABILITY — decided at startup from the environment. A UI click can never
 *   create it. When the kill switch is off, LIVE is REFUSED outright, not merely deferred.
 *
 *   RUNTIME SESSION STATE — which paper profile is active, and whether live order handling is
 *   armed. Mutable, but always subordinate to capability.
 *
 * Also pinned: the arming asymmetry. Enabling ENTRY demands every precondition; enabling
 * EXPOSURE MANAGEMENT and EMERGENCY FLATTEN demand far less, because refusing those is itself
 * dangerous — a feed hiccup must never be the reason a position cannot be closed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  currentSelection,
  evaluateLiveArm,
  evaluateModeTransition,
  executionModeLabel,
  selectionIsLive,
  transitionBlockers,
} from "../../dist/box/liveModeTransition.js";

/** A completely quiet, live-capable process. */
const QUIET = {
  deploymentLiveCapable: true,
  liveCapabilityDetail: "",
  openBoxes: 0,
  partiallyExitedBoxes: 0,
  recoveryBoxes: 0,
  residualLegs: 0,
  recoveryActive: false,
  workingBrokerOrders: 0,
  queuedExecutions: 0,
  inFlightExecutions: 0,
  unresolvedIntents: 0,
  unknownOrders: 0,
  reconciliationHealthy: true,
  reconciliationIncidentActive: false,
  scannerRunning: false,
  paperSimulationsInFlight: 0,
};

const ALL_PRE_OK = {
  deploymentLiveCapable: true,
  brokerAuthenticated: true,
  reconciliationHealthy: true,
  reconciliationComplete: true,
  feedHealthy: true,
  feedWarmedUp: true,
  circuitClosed: true,
  recoveryActive: false,
  unknownOrders: 0,
  durableReservationsAvailable: true,
};

// ── labels ───────────────────────────────────────────────────────────────────────────────

test("standard paper legging is NEVER labelled live parity", () => {
  // The single most misleading thing this screen could say.
  assert.equal(executionModeLabel("paper_legging", "standard", "zerodha"), "PAPER · LEGGING");
  assert.equal(executionModeLabel("paper_legging", "live_parity", "zerodha"), "PAPER · LEGGING LIVE-PARITY");
  assert.equal(executionModeLabel("paper_legging", "stress", "zerodha"), "PAPER · LEGGING");
});

test("live is labelled with the ACTUAL broker", () => {
  assert.equal(executionModeLabel("live", "standard", "zerodha"), "LIVE · ZERODHA");
  assert.equal(executionModeLabel("live", "standard", "dhan"), "LIVE · DHAN");
});

test("paper latency and touch are labelled as paper", () => {
  assert.equal(executionModeLabel("paper_latency", "standard", "zerodha"), "PAPER · LATENCY");
  assert.equal(executionModeLabel("paper_touch", "standard", "zerodha"), "PAPER · TOUCH");
});

test("currentSelection distinguishes the two paper legging profiles", () => {
  assert.equal(currentSelection("paper_legging", "standard"), "paper_legging");
  assert.equal(currentSelection("paper_legging", "live_parity"), "paper_legging_live_parity");
  assert.equal(currentSelection("paper_latency", "standard"), "paper_latency");
  assert.equal(currentSelection("live", "standard"), "live");
});

test("only the live selection counts as live", () => {
  assert.equal(selectionIsLive("live"), true);
  for (const s of ["paper_latency", "paper_legging", "paper_legging_live_parity"]) {
    assert.equal(selectionIsLive(s), false);
  }
});

// ── the deployment kill switch ───────────────────────────────────────────────────────────

test("LIVE is REFUSED when the deployment gate is off, even with everything else quiet", () => {
  const verdict = evaluateModeTransition({
    from: "paper_legging",
    to: "live",
    snapshot: { ...QUIET, deploymentLiveCapable: false, liveCapabilityDetail: "BOX_LIVE_TRADING_ENABLED is false" },
  });
  assert.equal(verdict.outcome, "refused", "not 'restart_required': restarting alone would not make it legal");
  const codes = verdict.blockers.map((b) => b.code);
  assert.ok(codes.includes("deployment_gate_disabled"));
});

test("the refusal carries the exact wording the UI must show", () => {
  const verdict = evaluateModeTransition({
    from: "paper_latency",
    to: "live",
    snapshot: { ...QUIET, deploymentLiveCapable: false, liveCapabilityDetail: "no live adapter factory" },
  });
  const blocker = verdict.blockers.find((b) => b.code === "deployment_gate_disabled");
  assert.match(blocker.detail, /LIVE UNAVAILABLE — deployment gate disabled/);
  assert.match(blocker.detail, /cannot be changed from the UI/);
  assert.match(blocker.detail, /BOX_EXECUTION_MODE=live/);
  assert.match(blocker.detail, /BOX_LIVE_TRADING_ENABLED=true/);
});

test("a UI toggle cannot bypass deployment authorisation at ANY level of quiet", () => {
  // Sweep every field to its safest value; the gate still refuses.
  const verdict = evaluateModeTransition({
    from: "paper_legging",
    to: "live",
    snapshot: { ...QUIET, deploymentLiveCapable: false, liveCapabilityDetail: "gate off" },
  });
  assert.equal(verdict.outcome, "refused");
});

// ── crossing the live boundary requires a restart ────────────────────────────────────────

test("PAPER -> LIVE on a live-capable deployment reports restart_required with the env changes", () => {
  const verdict = evaluateModeTransition({ from: "paper_legging", to: "live", snapshot: QUIET });
  assert.equal(verdict.outcome, "restart_required");
  assert.deepEqual(verdict.envChanges, ["BOX_EXECUTION_MODE=live", "BOX_LIVE_TRADING_ENABLED=true"]);
  assert.match(verdict.detail, /startup-only construction boundary/);
  assert.match(verdict.detail, /no object able to place a real order/);
});

test("LIVE -> PAPER also requires a restart", () => {
  const verdict = evaluateModeTransition({ from: "live", to: "paper_legging", snapshot: QUIET });
  assert.equal(verdict.outcome, "restart_required");
  assert.deepEqual(verdict.envChanges, ["BOX_EXECUTION_MODE=paper_legging (or paper_latency)"]);
});

test("a live transition still reports outstanding blockers alongside restart_required", () => {
  const verdict = evaluateModeTransition({
    from: "paper_legging",
    to: "live",
    snapshot: { ...QUIET, openBoxes: 1, residualLegs: 2 },
  });
  assert.equal(verdict.outcome, "restart_required");
  const codes = verdict.blockers.map((b) => b.code);
  assert.ok(codes.includes("open_box"));
  assert.ok(codes.includes("residual_exposure"));
});

// ── every blocker ────────────────────────────────────────────────────────────────────────

test("every unsafe condition is reported as its own blocker", () => {
  const cases = [
    ["openBoxes", 1, "open_box"],
    ["partiallyExitedBoxes", 1, "partial_box"],
    ["recoveryBoxes", 1, "recovery_box"],
    ["residualLegs", 1, "residual_exposure"],
    ["recoveryActive", true, "recovery_active"],
    ["workingBrokerOrders", 1, "working_broker_order"],
    ["queuedExecutions", 1, "queued_execution"],
    ["inFlightExecutions", 1, "in_flight_execution"],
    ["unresolvedIntents", 1, "unresolved_intent"],
    ["unknownOrders", 1, "unknown_order"],
    ["reconciliationIncidentActive", true, "reconciliation_incident"],
    ["scannerRunning", true, "scanner_running"],
  ];
  for (const [field, value, code] of cases) {
    const codes = transitionBlockers({ ...QUIET, [field]: value }).map((b) => b.code);
    assert.ok(codes.includes(code), `${field}=${String(value)} must yield ${code}`);
  }
  // Unhealthy reconciliation is the inverse-polarity one.
  const codes = transitionBlockers({ ...QUIET, reconciliationHealthy: false }).map((b) => b.code);
  assert.ok(codes.includes("reconciliation_unhealthy"));
});

test("a quiet process has no blockers", () => {
  assert.deepEqual(transitionBlockers(QUIET), []);
});

test("the scanner must be STOPPED before any mode change", () => {
  const verdict = evaluateModeTransition({
    from: "paper_legging",
    to: "paper_legging_live_parity",
    snapshot: { ...QUIET, scannerRunning: true },
  });
  assert.equal(verdict.outcome, "refused");
  assert.ok(verdict.blockers.some((b) => b.code === "scanner_running"));
});

// ── paper <-> paper ──────────────────────────────────────────────────────────────────────

test("PAPER -> PAPER is allowed at runtime when nothing is in flight", () => {
  const verdict = evaluateModeTransition({
    from: "paper_legging",
    to: "paper_legging_live_parity",
    snapshot: QUIET,
  });
  assert.equal(verdict.outcome, "allowed");
});

test("PAPER -> PAPER is refused while a simulation is mid-flight", () => {
  // Changing the timing model under a running simulated execution would corrupt its record.
  const verdict = evaluateModeTransition({
    from: "paper_legging",
    to: "paper_legging_live_parity",
    snapshot: { ...QUIET, paperSimulationsInFlight: 2 },
  });
  assert.equal(verdict.outcome, "refused");
  assert.ok(verdict.blockers.some((b) => b.code === "paper_simulation_in_flight"));
});

test("a no-op transition is always allowed", () => {
  for (const s of ["paper_latency", "paper_legging", "paper_legging_live_parity", "live"]) {
    const verdict = evaluateModeTransition({
      from: s,
      to: s,
      snapshot: { ...QUIET, openBoxes: 3, scannerRunning: true },
    });
    assert.equal(verdict.outcome, "allowed", `${s} -> ${s} is a no-op`);
  }
});

// ── the arming asymmetry ─────────────────────────────────────────────────────────────────

test("without deployment capability NO live permission may be armed", () => {
  for (const permission of ["entryEnabled", "liveOrderEnabled", "emergencyFlatten"]) {
    const verdict = evaluateLiveArm({
      permission,
      pre: { ...ALL_PRE_OK, deploymentLiveCapable: false },
    });
    assert.equal(verdict.ok, false, `${permission} must be refused`);
    assert.equal(verdict.blockers[0].code, "deployment_gate_disabled");
  }
});

test("arming ENTRY demands the full gauntlet", () => {
  assert.equal(evaluateLiveArm({ permission: "entryEnabled", pre: ALL_PRE_OK }).ok, true);
  const cases = [
    ["brokerAuthenticated", false, "broker_unauthenticated"],
    ["reconciliationHealthy", false, "reconciliation_unhealthy"],
    ["reconciliationComplete", false, "reconciliation_incomplete"],
    ["feedHealthy", false, "feed_unhealthy"],
    ["feedWarmedUp", false, "feed_warming"],
    ["circuitClosed", false, "circuit_open"],
    ["recoveryActive", true, "recovery_active"],
    ["unknownOrders", 1, "unknown_order"],
    ["durableReservationsAvailable", false, "durable_reservations_unavailable"],
  ];
  for (const [field, value, code] of cases) {
    const verdict = evaluateLiveArm({ permission: "entryEnabled", pre: { ...ALL_PRE_OK, [field]: value } });
    assert.equal(verdict.ok, false, `${field} must block entry arming`);
    assert.ok(verdict.blockers.some((b) => b.code === code), `${field} -> ${code}`);
  }
});

test("EMERGENCY FLATTEN is NOT withheld by a bad feed or an open circuit", () => {
  // Withholding the emergency brake in exactly the circumstances it exists for would be
  // indefensible.
  const hostile = {
    ...ALL_PRE_OK,
    feedHealthy: false,
    feedWarmedUp: false,
    circuitClosed: false,
    reconciliationHealthy: false,
    reconciliationComplete: false,
    recoveryActive: true,
    unknownOrders: 5,
    durableReservationsAvailable: false,
  };
  assert.equal(evaluateLiveArm({ permission: "emergencyFlatten", pre: hostile }).ok, true);
});

test("EMERGENCY FLATTEN still requires an authenticated broker", () => {
  const verdict = evaluateLiveArm({
    permission: "emergencyFlatten",
    pre: { ...ALL_PRE_OK, brokerAuthenticated: false },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((b) => b.code === "broker_unauthenticated"));
});

test("EXPOSURE MANAGEMENT is not withheld by a bad feed or an open circuit either", () => {
  const verdict = evaluateLiveArm({
    permission: "liveOrderEnabled",
    pre: { ...ALL_PRE_OK, feedHealthy: false, feedWarmedUp: false, circuitClosed: false },
  });
  assert.equal(verdict.ok, true, "a feed hiccup must not be why a position cannot be closed");
});

test("EXPOSURE MANAGEMENT does require completed reconciliation, so reductions are attributed", () => {
  const verdict = evaluateLiveArm({
    permission: "liveOrderEnabled",
    pre: { ...ALL_PRE_OK, reconciliationComplete: false },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.blockers.some((b) => b.code === "reconciliation_incomplete"));
});

test("the three permissions are INDEPENDENT: arming one never implies another", () => {
  // A state where exposure management and emergency flatten are armable but entry is not.
  const feedDown = { ...ALL_PRE_OK, feedHealthy: false };
  assert.equal(evaluateLiveArm({ permission: "entryEnabled", pre: feedDown }).ok, false);
  assert.equal(evaluateLiveArm({ permission: "liveOrderEnabled", pre: feedDown }).ok, true);
  assert.equal(evaluateLiveArm({ permission: "emergencyFlatten", pre: feedDown }).ok, true);
});
