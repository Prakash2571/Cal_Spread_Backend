/**
 * SUITE F — ONE-SHOT / BOUNDED-CYCLE SESSION.
 *
 * The defining requirement: with max=1, the FIRST Box enters and every subsequent entry is
 * blocked — including while the first Box is still open, when no cycle has yet COMPLETED. A
 * single "completed" counter cannot express that, which is why there are two counters
 * (consumed at establishment, completed at FLAT). These tests pin both, and pin that a
 * restart, a re-arm and an aborted entry cannot be used to win a second trade.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  armSession,
  canArm,
  completedCycles,
  consumedCycles,
  deriveSessionState,
  disarmSession,
  evaluateSessionEntry,
  idleSessionRecord,
  inFlightCycleIds,
  isArmed,
  isBudgetExhausted,
  recordAbortedAttempt,
  recordCompletedBox,
  recordEstablishedBox,
  reconcileCompletions,
  remainingCycles,
  sessionStatus,
} from "../../dist/box/tradingSession.js";

const QUIET = {
  entryInProgress: false,
  openBoxes: 0,
  exitInProgress: false,
  recoveryActive: false,
  entryBlockedExternally: false,
};

function armed(max, now = 1_000) {
  return armSession({
    sessionId: "sess-1",
    maxCompletedTrades: max,
    armedBy: "full-admin",
    previous: idleSessionRecord(0),
    now,
  });
}

test("an unarmed session refuses entry and reports IDLE", () => {
  const record = idleSessionRecord(0);
  assert.equal(isArmed(record), false);
  const verdict = evaluateSessionEntry({ record, recoveryActive: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_not_armed");
  assert.equal(deriveSessionState(record, QUIET), "IDLE");
});

test("max 0 is UNLIMITED: never exhausted, remaining reported as null not Infinity", () => {
  let record = armed(0);
  assert.equal(remainingCycles(record), null, "must serialise honestly to JSON");
  for (let i = 0; i < 25; i++) {
    record = recordEstablishedBox(record, `t${i}`, 2_000);
    record = recordCompletedBox(record, `t${i}`, 2_100);
    assert.equal(isBudgetExhausted(record), false);
    assert.equal(evaluateSessionEntry({ record, recoveryActive: false }).allowed, true);
  }
  assert.equal(completedCycles(record), 25);
});

// ── the one-shot sequence ────────────────────────────────────────────────────────────────

test("max 1: the first Box enters", () => {
  const record = armed(1);
  assert.equal(evaluateSessionEntry({ record, recoveryActive: false }).allowed, true);
  assert.equal(deriveSessionState(record, QUIET), "ARMED");
  assert.equal(remainingCycles(record), 1);
});

test("max 1: a SECOND candidate cannot enter while the first Box is still OPEN", () => {
  // The decisive case. Nothing has COMPLETED yet, so a completed-only counter would admit.
  const record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  assert.equal(completedCycles(record), 0);
  assert.equal(consumedCycles(record), 1);
  const verdict = evaluateSessionEntry({ record, recoveryActive: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_budget_exhausted");
  assert.equal(remainingCycles(record), 0);
  // And it is visibly still holding a position, not "finished".
  assert.equal(deriveSessionState(record, { ...QUIET, openBoxes: 1 }), "POSITION_OPEN");
});

test("max 1: once the Box is fully FLAT the session reports COMPLETED", () => {
  let record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  record = recordCompletedBox(record, "trade-1", 3_000);
  assert.equal(completedCycles(record), 1);
  assert.deepEqual(inFlightCycleIds(record), []);
  assert.equal(deriveSessionState(record, QUIET), "COMPLETED");
});

test("max 1: a later candidate still cannot enter after COMPLETED", () => {
  let record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  record = recordCompletedBox(record, "trade-1", 3_000);
  const verdict = evaluateSessionEntry({ record, recoveryActive: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_budget_exhausted");
  assert.match(verdict.detail, /only new entry is refused/);
});

test("the block detail states that exit and reduction continue", () => {
  const record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  const verdict = evaluateSessionEntry({ record, recoveryActive: false });
  assert.match(verdict.detail, /Monitoring, exit, residual flattening and reconciliation continue/);
});

test("COMPLETED is never asserted while a consumed cycle is unfinished", () => {
  const record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  // Budget exhausted but the cycle has not reached FLAT.
  assert.equal(isBudgetExhausted(record), true);
  assert.equal(deriveSessionState(record, QUIET), "BLOCKED");
  assert.notEqual(deriveSessionState(record, QUIET), "COMPLETED");
});

test("max N permits exactly N cycles", () => {
  let record = armed(3);
  for (const id of ["a", "b", "c"]) {
    assert.equal(evaluateSessionEntry({ record, recoveryActive: false }).allowed, true);
    record = recordEstablishedBox(record, id, 1);
  }
  assert.equal(consumedCycles(record), 3);
  assert.equal(evaluateSessionEntry({ record, recoveryActive: false }).allowed, false);
  assert.equal(remainingCycles(record), 0);
});

// ── what must NOT consume a cycle ────────────────────────────────────────────────────────

test("an ABORTED entry does not consume a cycle", () => {
  let record = armed(1);
  record = recordAbortedAttempt(record, 2_000);
  record = recordAbortedAttempt(record, 2_100);
  assert.equal(record.aborted_attempts, 2);
  assert.equal(consumedCycles(record), 0, "a failed attempt must not burn the operator's one trade");
  assert.equal(evaluateSessionEntry({ record, recoveryActive: false }).allowed, true);
});

test("a trade that never ESTABLISHED cannot be recorded as completed", () => {
  // Guards against an unrelated closed trade (e.g. an adopted position from a prior session)
  // counting towards this session's budget.
  const record = recordCompletedBox(armed(1), "some-other-trade", 3_000);
  assert.equal(completedCycles(record), 0);
});

test("establishment and completion are both IDEMPOTENT by trade id", () => {
  let record = armed(2);
  record = recordEstablishedBox(record, "trade-1", 1);
  record = recordEstablishedBox(record, "trade-1", 2);
  record = recordEstablishedBox(record, "trade-1", 3);
  assert.equal(consumedCycles(record), 1, "a replayed establishment must not consume two cycles");
  record = recordCompletedBox(record, "trade-1", 4);
  record = recordCompletedBox(record, "trade-1", 5);
  assert.equal(completedCycles(record), 1);
});

test("an empty trade id is ignored rather than counted", () => {
  let record = armed(1);
  record = recordEstablishedBox(record, "", 1);
  assert.equal(consumedCycles(record), 0);
});

// ── restart safety ───────────────────────────────────────────────────────────────────────

test("RESTART: the durable record still blocks a second trade", () => {
  const beforeRestart = recordEstablishedBox(armed(1), "trade-1", 2_000);
  // Simulate a process restart by round-tripping the record through JSON, as a durable load
  // would. Nothing is recomputed from live state, so nothing can be lost.
  const afterRestart = JSON.parse(JSON.stringify(beforeRestart));
  assert.equal(consumedCycles(afterRestart), 1);
  assert.equal(evaluateSessionEntry({ record: afterRestart, recoveryActive: false }).allowed, false);
});

test("RESTART: a cycle that reached FLAT while the process was down is reconciled", () => {
  const before = recordEstablishedBox(armed(1), "trade-1", 2_000);
  assert.deepEqual(inFlightCycleIds(before), ["trade-1"]);
  // Boot supplies the durably-flat ids.
  const after = reconcileCompletions(before, ["trade-1"], 9_000);
  assert.equal(completedCycles(after), 1);
  assert.deepEqual(inFlightCycleIds(after), []);
  assert.equal(deriveSessionState(after, QUIET), "COMPLETED");
});

test("RESTART: reconciliation cannot invent a completion for an unestablished trade", () => {
  const before = recordEstablishedBox(armed(2), "trade-1", 2_000);
  const after = reconcileCompletions(before, ["trade-1", "trade-999"], 9_000);
  assert.equal(completedCycles(after), 1);
  assert.ok(!after.completed_trade_ids.includes("trade-999"));
});

// ── arming is not a bypass ───────────────────────────────────────────────────────────────

test("RE-ARMING is refused while a Box is still open", () => {
  const record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  const verdict = canArm({ record, openBoxes: 1, residualLegs: 0, recoveryActive: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still open/);
});

test("RE-ARMING is refused while residual legs are unresolved", () => {
  const verdict = canArm({ record: armed(1), openBoxes: 0, residualLegs: 2, recoveryActive: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /residual/);
});

test("RE-ARMING is refused during recovery", () => {
  const verdict = canArm({ record: armed(1), openBoxes: 0, residualLegs: 0, recoveryActive: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /recovery/i);
});

test("RE-ARMING is refused while a consumed cycle has not reached FLAT, even with no open box reported", () => {
  // Defence in depth: the session's own bookkeeping blocks the bypass even if the caller
  // under-reports live exposure.
  const record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  const verdict = canArm({ record, openBoxes: 0, residualLegs: 0, recoveryActive: false });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /have not reached FLAT/);
});

test("RE-ARMING is permitted once every cycle is fully flat, and resets the budget", () => {
  let record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  record = recordCompletedBox(record, "trade-1", 3_000);
  const verdict = canArm({ record, openBoxes: 0, residualLegs: 0, recoveryActive: false });
  assert.equal(verdict.ok, true);
  const rearmed = armSession({
    sessionId: "sess-2", maxCompletedTrades: 1, armedBy: "full-admin", previous: record, now: 4_000,
  });
  assert.equal(consumedCycles(rearmed), 0);
  assert.equal(rearmed.arm_count, 2, "arm count is monotonic for audit");
  assert.equal(evaluateSessionEntry({ record: rearmed, recoveryActive: false }).allowed, true);
});

test("DISARMING preserves the counters: disarm-then-arm cannot skip the exposure guard", () => {
  const record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  const disarmed = disarmSession(record, 2_500);
  assert.equal(consumedCycles(disarmed), 1, "counters must survive a disarm");
  assert.equal(isArmed(disarmed), false);
  // The guard still sees the unfinished cycle.
  assert.equal(canArm({ record: disarmed, openBoxes: 0, residualLegs: 0, recoveryActive: false }).ok, false);
});

test("the limit is SNAPSHOTTED at arm time, so changing config cannot widen an armed session", () => {
  const record = armed(1);
  assert.equal(record.max_completed_trades, 1);
  // Even after a hypothetical config change to 10, this record still says 1.
  const consumed = recordEstablishedBox(record, "trade-1", 2_000);
  assert.equal(isBudgetExhausted(consumed), true);
});

// ── state machine ────────────────────────────────────────────────────────────────────────

test("RECOVERY outranks every other state", () => {
  const record = armed(1);
  assert.equal(deriveSessionState(record, { ...QUIET, recoveryActive: true }), "RECOVERY");
  assert.equal(
    deriveSessionState(record, { ...QUIET, recoveryActive: true, openBoxes: 1, exitInProgress: true }),
    "RECOVERY",
  );
});

test("recovery blocks session entry but is reported separately from a spent budget", () => {
  const verdict = evaluateSessionEntry({ record: armed(1), recoveryActive: true });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_recovery");
  assert.match(verdict.detail, /reduction stays open/);
});

test("activity states are reported ahead of COMPLETED so open exposure stays visible", () => {
  let record = recordEstablishedBox(armed(1), "trade-1", 2_000);
  record = recordCompletedBox(record, "trade-1", 3_000);
  // Budget spent and all flat, but an exit is somehow still running: show the activity.
  assert.equal(deriveSessionState(record, { ...QUIET, exitInProgress: true }), "EXIT_IN_PROGRESS");
  assert.equal(deriveSessionState(record, { ...QUIET, openBoxes: 1 }), "POSITION_OPEN");
});

test("ENTRY_IN_PROGRESS and BLOCKED are distinguished", () => {
  const record = armed(1);
  assert.equal(deriveSessionState(record, { ...QUIET, entryInProgress: true }), "ENTRY_IN_PROGRESS");
  assert.equal(deriveSessionState(record, { ...QUIET, entryBlockedExternally: true }), "BLOCKED");
});

// ── status projection ────────────────────────────────────────────────────────────────────

test("the status projection exposes the full required surface", () => {
  let record = recordEstablishedBox(armed(2), "trade-1", 2_000);
  const status = sessionStatus(record, { ...QUIET, openBoxes: 1 }, "session_budget_exhausted");
  assert.equal(status.state, "POSITION_OPEN");
  assert.equal(status.max_completed_trades, 2);
  assert.equal(status.completed_trades, 0);
  assert.equal(status.consumed_cycles, 1);
  assert.equal(status.remaining_trades, 1);
  assert.equal(status.current_trade_id, "trade-1");
  assert.equal(status.block_reason, "session_budget_exhausted");
  assert.equal(status.armed, true);
  assert.equal(status.armed_by, "full-admin");
  assert.equal(status.arm_count, 1);
});

test("current_trade_id is null rather than an arbitrary pick when several cycles are in flight", () => {
  let record = armed(3);
  record = recordEstablishedBox(record, "trade-1", 1);
  record = recordEstablishedBox(record, "trade-2", 2);
  const status = sessionStatus(record, QUIET, null);
  assert.equal(status.current_trade_id, null);
  assert.deepEqual(status.in_flight_trade_ids, ["trade-1", "trade-2"]);
});

test("an unlimited session reports remaining_trades as null in the status payload", () => {
  const status = sessionStatus(armed(0), QUIET, null);
  assert.equal(status.max_completed_trades, 0);
  assert.equal(status.remaining_trades, null);
});
