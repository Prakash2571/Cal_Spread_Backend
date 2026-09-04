/**
 * The shared execution scheduling policy.
 *
 * This is the SINGLE source of truth consumed by both the live BoxOrderManager and the
 * paper live_parity scheduler, so the properties pinned here are exactly the live
 * ordering: EMERGENCY_RESIDUAL > PROTECTIVE_CANCEL > EXIT > ENTRY, with sanitised knobs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_ORDER_PRIORITY,
  CANCEL_PRIORITY,
  priorityFor,
  compareScheduling,
  createSchedulingPolicy,
} from "../../dist/box/executionSchedulingPolicy.js";

test("priority ordering matches the live manager exactly", () => {
  assert.equal(BOX_ORDER_PRIORITY.EMERGENCY_RESIDUAL, 0);
  assert.equal(BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL, 1);
  assert.equal(BOX_ORDER_PRIORITY.EXIT, 2);
  assert.equal(BOX_ORDER_PRIORITY.ENTRY, 3);
  // Lower number sorts first (runs sooner).
  assert.ok(BOX_ORDER_PRIORITY.EMERGENCY_RESIDUAL < BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL);
  assert.ok(BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL < BOX_ORDER_PRIORITY.EXIT);
  assert.ok(BOX_ORDER_PRIORITY.EXIT < BOX_ORDER_PRIORITY.ENTRY);
});

test("the priority map is frozen so no consumer can mutate the shared policy", () => {
  assert.ok(Object.isFrozen(BOX_ORDER_PRIORITY));
});

test("a bare cancel carries the protective-cancel priority", () => {
  assert.equal(CANCEL_PRIORITY, BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL);
});

test("priorityFor is a pure lookup", () => {
  assert.equal(priorityFor("ENTRY"), 3);
  assert.equal(priorityFor("EMERGENCY_RESIDUAL"), 0);
});

test("compareScheduling sorts by priority then FIFO sequence", () => {
  // Same priority → FIFO by sequence.
  assert.ok(compareScheduling({ priority: 3, sequence: 1 }, { priority: 3, sequence: 2 }) < 0);
  // Better priority wins regardless of sequence.
  assert.ok(compareScheduling({ priority: 0, sequence: 99 }, { priority: 3, sequence: 1 }) < 0);
});

test("createSchedulingPolicy sanitises a zero/negative cap to at least 1 (never deadlock)", () => {
  assert.equal(createSchedulingPolicy({ maxConcurrentOperations: 0, minBrokerIntervalMs: 250 }).maxConcurrentOperations, 1);
  assert.equal(createSchedulingPolicy({ maxConcurrentOperations: -5, minBrokerIntervalMs: 250 }).maxConcurrentOperations, 1);
});

test("createSchedulingPolicy sanitises a negative interval to 0 (never negative pacing)", () => {
  assert.equal(createSchedulingPolicy({ maxConcurrentOperations: 1, minBrokerIntervalMs: -10 }).minBrokerIntervalMs, 0);
});

test("createSchedulingPolicy preserves valid values and carries priorityFor", () => {
  const p = createSchedulingPolicy({ maxConcurrentOperations: 2, minBrokerIntervalMs: 250 });
  assert.equal(p.maxConcurrentOperations, 2);
  assert.equal(p.minBrokerIntervalMs, 250);
  assert.equal(p.priorityFor("EXIT"), 2);
});
