/**
 * `BoxPositionMonitor.forgetPosition` — the deletion cleanup hook.
 *
 * Removing a trade from the position book is NOT sufficient on its own. The
 * monitor holds retry queues (`pendingFinalPersists`, `pendingPartialPersists`)
 * that are drained every cycle and deliberately do not consult the book — that is
 * the whole point of them, since a confirmed fill must be persisted even after the
 * position has left memory. A deleted trade left in those queues would be
 * re-persisted on the next cycle, resurrecting the document moments after an
 * administrator deleted it.
 *
 * These are contract tests: the method must exist, be safe to call for an unknown
 * id, and be idempotent. The queue-draining behaviour itself is exercised by
 * monitor.test.mjs / partialExit.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxPositionMonitor } from "../../dist/box/positionMonitor.js";

/**
 * forgetPosition touches only the monitor's own id-keyed maps, so an empty deps
 * object is enough — and keeps this a genuine unit test with no engine, no clock
 * and no database.
 */
const monitor = () => new BoxPositionMonitor({});

test("forgetPosition reports false when nothing was being held for that id", () => {
  const m = monitor();
  assert.equal(m.forgetPosition("6512f0a0a0a0a0a0a0a0a0a0"), false);
});

test("forgetPosition is safe for an id the monitor has never seen", () => {
  const m = monitor();
  assert.doesNotThrow(() => m.forgetPosition("unknown-id"));
  assert.doesNotThrow(() => m.forgetPosition(""));
});

test("forgetPosition is idempotent — a repeated delete cleanup is harmless", () => {
  const m = monitor();
  assert.equal(m.forgetPosition("t1"), false);
  assert.equal(m.forgetPosition("t1"), false);
});

test("forgetPosition does not disturb the monitor's cycle statistics", () => {
  // Deletion is an administrative correction, not a market event: it must not
  // appear in the exit/cycle counters the operator reads as execution health.
  const m = monitor();
  const before = m.getStats();
  m.forgetPosition("t1");
  assert.deepEqual(m.getStats(), before);
});
