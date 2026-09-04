/**
 * The tracked-interval registry.
 *
 * Two module-level `setInterval` calls (the Redis flush retry and the option-OI capture)
 * discarded their handles, so nothing could stop them. Harmless while running — they are
 * meant to run forever — but during shutdown a flush or capture firing after the Mongo
 * connections start closing produces write-after-close errors, and at worst a partially
 * written capture.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  trackInterval,
  clearTrackedIntervals,
  trackedIntervalCount,
} from "../../dist/trackedTimers.js";

test("trackInterval returns the handle unchanged", () => {
  // It must be usable as a transparent wrapper around an existing setInterval call, so
  // adopting it cannot alter timing or behaviour.
  const handle = setInterval(() => {}, 10_000);
  assert.equal(trackInterval("passthrough", handle), handle);
  clearTrackedIntervals();
});

test("clearing stops the timers and empties the registry", () => {
  let fired = 0;
  trackInterval("a", setInterval(() => fired++, 1));
  trackInterval("b", setInterval(() => fired++, 1));
  assert.equal(trackedIntervalCount(), 2);

  const cleared = clearTrackedIntervals();
  assert.deepEqual(cleared, ["a", "b"], "names are reported in registration order");
  assert.equal(trackedIntervalCount(), 0);

  // Nothing may fire after clearing, which is the whole point: a capture running after
  // the database has closed is the failure being prevented.
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(fired, 0, "a cleared interval must not fire");
      resolve();
    }, 20);
  });
});

test("clearing twice is safe and reports nothing the second time", () => {
  trackInterval("only", setInterval(() => {}, 10_000));
  assert.deepEqual(clearTrackedIntervals(), ["only"]);
  // Shutdown steps can be retried; a double clear must not throw or re-report.
  assert.deepEqual(clearTrackedIntervals(), []);
  assert.equal(trackedIntervalCount(), 0);
});

test("clearing an empty registry is a no-op", () => {
  assert.deepEqual(clearTrackedIntervals(), []);
});
