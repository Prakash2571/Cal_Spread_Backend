/**
 * Peak-concurrent-margin replay.
 *
 * These tests exist because the obvious implementation is wrong. When a trade is
 * deleted it is tempting to do `peak -= deleted.margin`, and the first test below
 * is the counterexample that proves it cannot work: two non-overlapping trades of
 * ₹5L each have a peak of ₹5L, so removing one must LEAVE it at ₹5L. Subtraction
 * would report ₹0.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  peakConcurrentMargin,
  usableMarginIntervals,
} from "../../dist/box/marginReplay.js";

const MIN = 60_000;
/** A readable epoch base so intervals in these tests are easy to reason about. */
const T = 1_760_000_000_000;
const at = (minutes) => T + minutes * MIN;

test("non-overlapping trades never sum: the peak is the largest single margin", () => {
  const intervals = [
    { from: at(0), to: at(10), margin: 500_000 },
    { from: at(20), to: at(30), margin: 500_000 },
  ];
  assert.equal(peakConcurrentMargin(intervals), 500_000);

  // The whole point: deleting one leaves the peak unchanged. A subtraction-based
  // implementation would have produced 0 here.
  assert.equal(peakConcurrentMargin([intervals[0]]), 500_000);
});

test("fully overlapping trades sum at the later start", () => {
  assert.equal(
    peakConcurrentMargin([
      { from: at(0), to: at(60), margin: 300_000 },
      { from: at(10), to: at(50), margin: 200_000 },
    ]),
    500_000,
  );
});

test("the maximum is found even when it occurs at the last of several starts", () => {
  // Three trades all still open at at(20): 100k + 200k + 400k.
  assert.equal(
    peakConcurrentMargin([
      { from: at(0), to: at(90), margin: 100_000 },
      { from: at(10), to: at(90), margin: 200_000 },
      { from: at(20), to: at(90), margin: 400_000 },
    ]),
    700_000,
  );
});

test("a staggered ladder peaks in the middle, not at the ends", () => {
  //  A ---------              (0 → 40)  100k
  //        B ---------        (20 → 60) 200k   overlap A+B at 20 = 300k
  //              C -------    (50 → 80) 400k   overlap B+C at 50 = 600k  <- peak
  assert.equal(
    peakConcurrentMargin([
      { from: at(0), to: at(40), margin: 100_000 },
      { from: at(20), to: at(60), margin: 200_000 },
      { from: at(50), to: at(80), margin: 400_000 },
    ]),
    600_000,
  );
});

test("intervals are HALF-OPEN: a close exactly at another's open does not overlap", () => {
  // B opens at the very instant A closes. They never held margin simultaneously.
  assert.equal(
    peakConcurrentMargin([
      { from: at(0), to: at(30), margin: 250_000 },
      { from: at(30), to: at(60), margin: 250_000 },
    ]),
    250_000,
  );
});

test("an unknown (null) margin is EXCLUDED, never counted as zero", () => {
  const rows = [
    { from: at(0), to: at(60), margin: 400_000 },
    { from: at(5), to: at(60), margin: null },
    { from: at(5), to: at(60), margin: undefined },
  ];
  const usable = usableMarginIntervals(rows);
  assert.equal(usable.length, 1, "only the measured interval survives");
  assert.equal(peakConcurrentMargin(usable), 400_000);
});

test("non-positive, non-finite and zero-length intervals are discarded", () => {
  const usable = usableMarginIntervals([
    { from: at(0), to: at(10), margin: 0 },        // zero margin
    { from: at(0), to: at(10), margin: -5000 },    // negative margin
    { from: at(0), to: at(10), margin: NaN },      // not a number
    { from: at(0), to: at(0), margin: 100_000 },   // zero length
    { from: at(10), to: at(5), margin: 100_000 },  // inverted
    { from: NaN, to: at(10), margin: 100_000 },    // bad bound
  ]);
  assert.deepEqual(usable, []);
  assert.equal(peakConcurrentMargin(usable), null);
});

test("no measurable interval yields null, which is NOT the same as zero", () => {
  // null must stay distinguishable from 0 so the dashboard can say "never
  // measured" rather than claiming no margin was ever blocked.
  assert.equal(peakConcurrentMargin([]), null);
  assert.notEqual(peakConcurrentMargin([]), 0);
});

test("an open trade's interval runs to the supplied 'now' and still counts", () => {
  const now = at(45);
  const usable = usableMarginIntervals([
    { from: at(0), to: now, margin: 150_000 },   // still open
    { from: at(30), to: now, margin: 150_000 },  // still open, overlapping
  ]);
  assert.equal(peakConcurrentMargin(usable), 300_000);
});

test("deleting the trade that set the peak lowers it to the true remaining maximum", () => {
  //  A and B overlap at 300k; C alone is 900k and set the peak.
  const a = { from: at(0), to: at(40), margin: 100_000 };
  const b = { from: at(10), to: at(40), margin: 200_000 };
  const c = { from: at(60), to: at(90), margin: 900_000 };

  assert.equal(peakConcurrentMargin([a, b, c]), 900_000);
  // Remove C: the honest answer is A+B's overlap, which only a replay can find.
  assert.equal(peakConcurrentMargin([a, b]), 300_000);
});
