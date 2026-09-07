/**
 * SUITE F (durable) — the trading-session manager's PERSISTENCE and FAILURE POLICY.
 *
 * `tradingSession.test.mjs` covers the pure arithmetic. What matters here is what happens when
 * Mongo misbehaves, because that is where a safety counter is actually won or lost:
 *
 *   - a WRITE failure must roll the in-memory record back, so running and durable counters can
 *     never disagree (otherwise a restart resurrects a spent budget);
 *   - a READ failure must FAIL ENTRY CLOSED, because an unread session is not an unarmed one —
 *     assuming a clean slate on a transient error is exactly how "restart to get another trade"
 *     would work;
 *   - a cycle that reached FLAT during downtime must be reconciled from durable trade state.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxTradingSessionManager } from "../../dist/box/tradingSessionStore.js";

/** An in-memory persistence double with injectable faults. */
function persistence({ record = null, loadError = null, flat = [] } = {}) {
  const state = {
    stored: record,
    saves: 0,
    failSave: false,
    loadError,
    flat,
    flatQueries: [],
  };
  return {
    state,
    load: async () => (state.loadError ? { ok: false, error: state.loadError } : { ok: true, record: state.stored }),
    save: async (next) => {
      state.saves++;
      if (state.failSave) throw new Error("mongo down");
      // Deep copy, as a real round trip would.
      state.stored = JSON.parse(JSON.stringify(next));
    },
    flatTradeIds: async (ids) => {
      state.flatQueries.push([...ids]);
      return state.flat.filter((id) => ids.includes(id));
    },
  };
}

function manager(p, max = 1) {
  let clock = 1_000;
  let seq = 0;
  return new BoxTradingSessionManager({
    persistence: p,
    configuredMaxCompletedTrades: () => max,
    now: () => (clock += 1),
    newSessionId: () => `sess-${seq++}`,
    log: () => {},
  });
}

const QUIET_ARM = { armedBy: "full-admin", openBoxes: 0, residualLegs: 0, recoveryActive: false };

/* ── read failure fails ENTRY closed ─────────────────────────────────────────────────── */

test("before initialise() the session refuses entry: unread is not unarmed", async () => {
  const m = manager(persistence());
  const verdict = m.evaluateEntry(false);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_state_unreadable");
  assert.equal(m.isReady(), false);
});

test("a READ FAILURE fails entry closed and says why", async () => {
  const p = persistence({ loadError: "connection refused" });
  const m = manager(p);
  await m.initialise();
  assert.equal(m.isReady(), false);
  assert.equal(m.lastLoadError(), "connection refused");
  const verdict = m.evaluateEntry(false);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_state_unreadable");
  assert.match(verdict.detail, /cannot be proven to have budget left/);
  // And it states that reduction is unaffected, which is the whole safety asymmetry.
  assert.match(verdict.detail, /Exit, residual flattening and reconciliation are unaffected/);
});

test("a read failure also refuses ARMING, rather than arming a session it cannot persist against", async () => {
  const m = manager(persistence({ loadError: "boom" }));
  await m.initialise();
  const armed = await m.arm(QUIET_ARM);
  assert.equal(armed.ok, false);
  assert.match(armed.reason, /unreadable/);
});

test("a read failure does not invent a session: nothing is established or completed", async () => {
  const p = persistence({ loadError: "boom" });
  const m = manager(p);
  await m.initialise();
  await m.recordEstablished("trade-1");
  await m.recordCompleted("trade-1");
  await m.recordAborted();
  assert.equal(p.state.saves, 0, "an unreadable session must not write speculative state");
  assert.equal(m.consumed(), 0);
});

/* ── the happy path ──────────────────────────────────────────────────────────────────── */

test("a fresh deployment loads as IDLE and refuses entry until armed", async () => {
  const m = manager(persistence());
  await m.initialise();
  assert.equal(m.isReady(), true);
  const verdict = m.evaluateEntry(false);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_not_armed");
});

test("arming persists, and the snapshot reflects the configured budget", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  const armed = await m.arm(QUIET_ARM);
  assert.equal(armed.ok, true);
  assert.equal(p.state.stored.max_completed_trades, 1);
  assert.equal(p.state.stored.armed_by, "full-admin");
  assert.equal(m.evaluateEntry(false).allowed, true);
});

test("an explicit max overrides the configured default", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm({ ...QUIET_ARM, maxCompletedTrades: 3 });
  assert.equal(p.state.stored.max_completed_trades, 3);
});

test("the ONE-SHOT sequence: establish blocks entry, completion reports COMPLETED", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);

  await m.recordEstablished("trade-1");
  assert.equal(m.consumed(), 1);
  assert.equal(m.completed(), 0);
  assert.equal(m.evaluateEntry(false).allowed, false, "second candidate refused while the first is open");
  assert.equal(m.evaluateEntry(false).reason, "session_budget_exhausted");

  await m.recordCompleted("trade-1");
  assert.equal(m.completed(), 1);
  const activity = { entryInProgress: false, openBoxes: 0, exitInProgress: false, recoveryActive: false, entryBlockedExternally: false };
  assert.equal(m.state(activity), "COMPLETED");
  assert.equal(m.evaluateEntry(false).allowed, false, "still refused after completion");
});

test("an ABORTED attempt is persisted but consumes no cycle", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);
  await m.recordAborted();
  await m.recordAborted();
  assert.equal(p.state.stored.aborted_attempts, 2);
  assert.equal(m.consumed(), 0);
  assert.equal(m.evaluateEntry(false).allowed, true, "a failed attempt must not burn the one permitted trade");
});

test("establishment is ignored when no session is armed", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.recordEstablished("trade-1");
  assert.equal(m.consumed(), 0);
  assert.equal(p.state.saves, 0);
});

/* ── write failure rolls back ────────────────────────────────────────────────────────── */

test("a WRITE FAILURE rolls the in-memory record back", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);

  p.state.failSave = true;
  await m.recordEstablished("trade-1");
  // The cycle was NOT consumed in memory, because it was not consumed durably either.
  assert.equal(m.consumed(), 0, "running and durable counters must never disagree");
  assert.equal(p.state.stored.established_trade_ids.length, 0);

  // Once the write works again the cycle is consumed for real.
  p.state.failSave = false;
  await m.recordEstablished("trade-1");
  assert.equal(m.consumed(), 1);
  assert.deepEqual(p.state.stored.established_trade_ids, ["trade-1"]);
});

test("a write failure while ARMING refuses the arm rather than half-arming", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  p.state.failSave = true;
  const armed = await m.arm(QUIET_ARM);
  assert.equal(armed.ok, false);
  assert.match(armed.reason, /could not be persisted/);
  assert.equal(m.evaluateEntry(false).reason, "session_not_armed", "the session must not look armed");
});

test("a write failure on COMPLETION leaves the cycle in flight, never silently completed", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);
  await m.recordEstablished("trade-1");
  p.state.failSave = true;
  await m.recordCompleted("trade-1");
  assert.equal(m.completed(), 0);
  assert.equal(p.state.stored.completed_trade_ids.length, 0);
});

/* ── restart ─────────────────────────────────────────────────────────────────────────── */

test("RESTART: a consumed one-shot budget still blocks after a fresh manager loads it", async () => {
  const p = persistence();
  const first = manager(p, 1);
  await first.initialise();
  await first.arm(QUIET_ARM);
  await first.recordEstablished("trade-1");

  // A brand-new manager over the SAME durable record: this is what a process restart looks like.
  const rebooted = manager(p, 1);
  await rebooted.initialise();
  assert.equal(rebooted.consumed(), 1);
  const verdict = rebooted.evaluateEntry(false);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_budget_exhausted");
});

test("RESTART: restarting does not reset the counter even with a different configured max", async () => {
  const p = persistence();
  const first = manager(p, 1);
  await first.initialise();
  await first.arm(QUIET_ARM);
  await first.recordEstablished("trade-1");

  // Operator changed the env var to 5 and restarted. The ARMED session snapshot still says 1.
  const rebooted = manager(p, 5);
  await rebooted.initialise();
  assert.equal(rebooted.snapshot().max_completed_trades, 1);
  assert.equal(rebooted.evaluateEntry(false).allowed, false);
});

test("RESTART: a cycle that reached FLAT during downtime is reconciled and reported COMPLETED", async () => {
  const p = persistence();
  const first = manager(p, 1);
  await first.initialise();
  await first.arm(QUIET_ARM);
  await first.recordEstablished("trade-1");

  // The Box was exited while the process was down; the trade document is now closed.
  p.state.flat = ["trade-1"];
  const rebooted = manager(p, 1);
  await rebooted.initialise();
  assert.equal(rebooted.completed(), 1);
  assert.deepEqual(p.state.flatQueries.at(-1), ["trade-1"], "only in-flight ids are queried");
  const activity = { entryInProgress: false, openBoxes: 0, exitInProgress: false, recoveryActive: false, entryBlockedExternally: false };
  assert.equal(rebooted.state(activity), "COMPLETED");
});

test("RESTART: no in-flight cycles means no flatness query at all", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  assert.deepEqual(p.state.flatQueries, []);
});

/* ── re-arming is not a bypass ───────────────────────────────────────────────────────── */

test("RE-ARMING is refused while a Box is open, a residual is unresolved, or recovery is active", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);
  await m.recordEstablished("trade-1");

  for (const [label, args] of [
    ["open box", { openBoxes: 1, residualLegs: 0, recoveryActive: false }],
    ["residual", { openBoxes: 0, residualLegs: 2, recoveryActive: false }],
    ["recovery", { openBoxes: 0, residualLegs: 0, recoveryActive: true }],
    ["unfinished cycle", { openBoxes: 0, residualLegs: 0, recoveryActive: false }],
  ]) {
    const attempt = await m.arm({ armedBy: "full-admin", ...args });
    assert.equal(attempt.ok, false, `${label} must refuse re-arming`);
  }
  assert.equal(m.consumed(), 1, "a refused arm must not clear the counter");
});

test("RE-ARMING succeeds once the cycle is complete, and resets the budget", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);
  await m.recordEstablished("trade-1");
  await m.recordCompleted("trade-1");

  const rearmed = await m.arm(QUIET_ARM);
  assert.equal(rearmed.ok, true);
  assert.equal(m.consumed(), 0);
  assert.equal(m.snapshot().arm_count, 2);
  assert.equal(m.evaluateEntry(false).allowed, true);
});

test("DISARM preserves the counters, so disarm-then-arm cannot skip the exposure guard", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);
  await m.recordEstablished("trade-1");
  await m.disarm();
  assert.equal(m.consumed(), 1, "counters survive a disarm");
  const attempt = await m.arm(QUIET_ARM);
  assert.equal(attempt.ok, false, "the unfinished cycle still blocks");
});

/* ── recovery, and the entry/reduction asymmetry ─────────────────────────────────────── */

test("RECOVERY blocks entry with its own distinct reason", async () => {
  const p = persistence();
  const m = manager(p, 0);
  await m.initialise();
  await m.arm(QUIET_ARM);
  const verdict = m.evaluateEntry(true);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "session_recovery");
  assert.match(verdict.detail, /reduction stays open/);
});

test("an UNLIMITED session never refuses entry however many cycles run", async () => {
  const p = persistence();
  const m = manager(p, 0);
  await m.initialise();
  await m.arm(QUIET_ARM);
  for (let i = 0; i < 10; i++) {
    assert.equal(m.evaluateEntry(false).allowed, true);
    await m.recordEstablished(`t${i}`);
    await m.recordCompleted(`t${i}`);
  }
  assert.equal(m.completed(), 10);
  assert.equal(m.snapshot().max_completed_trades, 0);
});

/* ── status ──────────────────────────────────────────────────────────────────────────── */

test("the status payload carries state, budget, current trade and block reason", async () => {
  const p = persistence();
  const m = manager(p, 2);
  await m.initialise();
  await m.arm(QUIET_ARM);
  await m.recordEstablished("trade-1");
  const status = m.status({
    entryInProgress: false, openBoxes: 1, exitInProgress: false, recoveryActive: false, entryBlockedExternally: false,
  });
  assert.equal(status.state, "POSITION_OPEN");
  assert.equal(status.max_completed_trades, 2);
  assert.equal(status.consumed_cycles, 1);
  assert.equal(status.completed_trades, 0);
  assert.equal(status.remaining_trades, 1);
  assert.equal(status.current_trade_id, "trade-1");
  assert.equal(status.readable, true);
  assert.equal(status.block_reason, null, "one cycle remains, so nothing blocks");
});

test("the status payload reports unreadability rather than pretending to be IDLE", async () => {
  const m = manager(persistence({ loadError: "down" }));
  await m.initialise();
  const status = m.status({
    entryInProgress: false, openBoxes: 0, exitInProgress: false, recoveryActive: false, entryBlockedExternally: false,
  });
  assert.equal(status.readable, false);
  assert.equal(status.block_reason, "session_state_unreadable");
});

test("the status payload never contains a token or credential-shaped field", async () => {
  const p = persistence();
  const m = manager(p, 1);
  await m.initialise();
  await m.arm(QUIET_ARM);
  const serialised = JSON.stringify(m.status({
    entryInProgress: false, openBoxes: 0, exitInProgress: false, recoveryActive: false, entryBlockedExternally: false,
  }));
  assert.ok(!/token|secret|password|api[_-]?key/i.test(serialised), serialised);
  // `armed_by` is a ROLE label, never a credential.
  assert.match(serialised, /"armed_by":"full-admin"/);
});
