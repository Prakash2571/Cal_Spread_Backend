/**
 * The deterministic paper scheduler — proves it reproduces the live BoxOrderManager
 * scheduling semantics: whole-lifecycle serialisation under cap=1, exactly N concurrent
 * under cap=N, shared transport pacing between POSTs, and priority pre-emption of the
 * QUEUE (never of an in-flight operation).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { planPaperSchedule } from "../../dist/box/paperScheduler.js";
import { createSchedulingPolicy } from "../../dist/box/executionSchedulingPolicy.js";

// Four entry legs released together at t=0, each 80ms POST→ACK, 120ms ACK→terminal.
function fourEntryLegs() {
  return ["k1_ce", "k2_ce", "k2_pe", "k1_pe"].map((role, i) => ({
    id: role,
    purpose: "ENTRY",
    sequence: i,
    readyAt: 0,
    postToAckMs: 80,
    ackToTerminalMs: 120,
  }));
}

test("cap=1 serialises WHOLE lifecycles — leg B dequeues only after leg A is terminal", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
  const s = planPaperSchedule(fourEntryLegs(), policy);
  // Sorted by dequeue.
  const byDequeue = [...s].sort((a, b) => a.dequeued_at - b.dequeued_at);
  for (let i = 1; i < byDequeue.length; i++) {
    assert.ok(
      byDequeue[i].dequeued_at >= byDequeue[i - 1].terminal_at - 1e-6,
      `leg ${i} must not start before leg ${i - 1} resolves`,
    );
  }
  // First leg: dequeue 0, ack 80, terminal 200. Second: dequeue 200, ack 280, terminal 400.
  assert.equal(byDequeue[0].dequeued_at, 0);
  assert.equal(byDequeue[0].terminal_at, 200);
  assert.equal(byDequeue[1].dequeued_at, 200);
  assert.equal(byDequeue[3].terminal_at, 800);
});

test("cap=2 allows EXACTLY two operations in flight at once", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 0 });
  const s = planPaperSchedule(fourEntryLegs(), policy);
  // At any instant count overlapping [dequeued_at, terminal_at). Peak must be 2.
  const events = [];
  for (const op of s) {
    events.push([op.dequeued_at, 1]);
    events.push([op.terminal_at, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  assert.equal(peak, 2, "no more than two lifecycles may overlap");
  // First two dequeue at 0; the third waits for the earliest terminal (200).
  const byDequeue = [...s].sort((a, b) => a.dequeued_at - b.dequeued_at);
  assert.equal(byDequeue[0].dequeued_at, 0);
  assert.equal(byDequeue[1].dequeued_at, 0);
  assert.equal(byDequeue[2].dequeued_at, 200);
});

test("min broker interval spaces adjacent POSTs even under cap=2", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 250 });
  const s = planPaperSchedule(fourEntryLegs(), policy);
  const posts = s.map((o) => o.post_started_at).sort((a, b) => a - b);
  for (let i = 1; i < posts.length; i++) {
    assert.ok(posts[i] - posts[i - 1] >= 250 - 1e-6, `POSTs ${i - 1}->${i} spaced >= 250ms`);
  }
  // Even though two slots are free at t=0, the second POST is paced to 250, not 0.
  assert.equal(posts[0], 0);
  assert.equal(posts[1], 250);
});

test("transport pacing adds transport_wait_ms after a slot is acquired", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 250 });
  const s = planPaperSchedule(fourEntryLegs(), policy);
  const byDequeue = [...s].sort((a, b) => a.dequeued_at - b.dequeued_at);
  // Second op acquires its slot at t=0 but its POST waits until 250 → transport_wait 250.
  assert.equal(byDequeue[1].dequeued_at, 0);
  assert.equal(byDequeue[1].transport_wait_ms, 250);
});

test("an EMERGENCY_RESIDUAL that becomes ready jumps ahead of a queued ENTRY", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
  // Two entries queued at t=0; an emergency becomes ready at t=50 while entry A is in flight.
  const ops = [
    { id: "entryA", purpose: "ENTRY", sequence: 0, readyAt: 0, postToAckMs: 80, ackToTerminalMs: 120 },
    { id: "entryB", purpose: "ENTRY", sequence: 1, readyAt: 0, postToAckMs: 80, ackToTerminalMs: 120 },
    { id: "unwind", purpose: "EMERGENCY_RESIDUAL", sequence: 2, readyAt: 50, postToAckMs: 80, ackToTerminalMs: 120 },
  ];
  const s = planPaperSchedule(ops, policy);
  const byId = Object.fromEntries(s.map((o) => [o.id, o]));
  // entryA runs first (dequeued 0, terminal 200). When the slot frees at 200 both entryB
  // and the emergency are ready — the emergency (priority 0) MUST win over entryB (3).
  assert.equal(byId.entryA.dequeued_at, 0);
  assert.equal(byId.unwind.dequeued_at, 200, "emergency claims the freed slot");
  assert.ok(byId.entryB.dequeued_at > byId.unwind.dequeued_at, "queued ENTRY waits behind the emergency");
});

test("an in-flight operation is NEVER pre-empted by a higher priority arrival", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
  const ops = [
    { id: "entryA", purpose: "ENTRY", sequence: 0, readyAt: 0, postToAckMs: 80, ackToTerminalMs: 120 },
    { id: "unwind", purpose: "EMERGENCY_RESIDUAL", sequence: 1, readyAt: 10, postToAckMs: 80, ackToTerminalMs: 120 },
  ];
  const s = planPaperSchedule(ops, policy);
  const byId = Object.fromEntries(s.map((o) => [o.id, o]));
  // entryA was already in flight when the emergency became ready at 10; it runs to its
  // terminal at 200 uninterrupted, and the emergency starts only then.
  assert.equal(byId.entryA.terminal_at, 200);
  assert.equal(byId.unwind.dequeued_at, 200);
});

test("queue wait contributes to when the order is live at the exchange (ack)", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
  const s = planPaperSchedule(fourEntryLegs(), policy);
  const byDequeue = [...s].sort((a, b) => a.dequeued_at - b.dequeued_at);
  // The 4th leg waited through three whole lifecycles (queue_wait 600) before its ACK.
  assert.equal(byDequeue[3].queue_wait_ms, 600);
  assert.equal(byDequeue[3].ack_at, 680);
});

test("determinism — identical inputs yield byte-identical schedules", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 250 });
  const a = planPaperSchedule(fourEntryLegs(), policy);
  const b = planPaperSchedule(fourEntryLegs(), policy);
  assert.deepEqual(a, b);
});

test("results are returned in input order regardless of dequeue order", () => {
  const policy = createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: 0 });
  const legs = fourEntryLegs();
  const s = planPaperSchedule(legs, policy);
  assert.deepEqual(s.map((o) => o.id), legs.map((l) => l.id));
});
