/**
 * SUITE I — BOX ENTRY BURST ADMISSION.
 *
 * The burst exists to shrink the unhedged window between the first and fourth entry leg
 * reaching the broker. It is only acceptable if it cannot:
 *
 *   - let two candidate Boxes overlap (which would sidestep contract reservations),
 *   - delay emergency / protective-cancel / exit work,
 *   - open alongside protective work,
 *   - exceed four.
 *
 * Each of those is pinned below.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  admitBoxOperation,
  BOX_ORDER_PRIORITY,
  clampEntrySubmitConcurrency,
  ENTRY_SUBMIT_CONCURRENCY_MAX,
  ENTRY_SUBMIT_CONCURRENCY_MIN,
} from "../../dist/box/executionSchedulingPolicy.js";

const EMPTY = { baseInFlight: 0, burstInFlight: 0, entryAttemptId: null, nonEntryInFlight: 0 };

function admit(purpose, occupancy, { base = 1, burst = 4, attemptId = "A" } = {}) {
  return admitBoxOperation({
    request: { purpose, attemptId },
    occupancy: { ...EMPTY, ...occupancy },
    baseConcurrency: base,
    entrySubmitConcurrency: burst,
  });
}

/** Simulate admitting `n` ENTRY legs of one attempt, tracking occupancy as the manager does. */
function fillEntryBurst(n, { base = 1, burst = 4, attemptId = "A" } = {}) {
  let occ = { ...EMPTY };
  const slots = [];
  for (let i = 0; i < n; i++) {
    const verdict = admitBoxOperation({
      request: { purpose: "ENTRY", attemptId },
      occupancy: occ,
      baseConcurrency: base,
      entrySubmitConcurrency: burst,
    });
    if (!verdict.admit) break;
    slots.push(verdict.slot);
    occ = {
      baseInFlight: occ.baseInFlight + (verdict.slot === "base" ? 1 : 0),
      burstInFlight: occ.burstInFlight + (verdict.slot === "entry_burst" ? 1 : 0),
      entryAttemptId: attemptId,
      nonEntryInFlight: occ.nonEntryInFlight,
    };
  }
  return { slots, occupancy: occ };
}

test("the width is clamped into 1..4, and garbage collapses to the safe value", () => {
  assert.equal(ENTRY_SUBMIT_CONCURRENCY_MIN, 1);
  assert.equal(ENTRY_SUBMIT_CONCURRENCY_MAX, 4);
  assert.equal(clampEntrySubmitConcurrency(0), 1);
  assert.equal(clampEntrySubmitConcurrency(-7), 1);
  assert.equal(clampEntrySubmitConcurrency(1), 1);
  assert.equal(clampEntrySubmitConcurrency(4), 4);
  assert.equal(clampEntrySubmitConcurrency(99), 4, "never above four: a Box has four legs");
  assert.equal(clampEntrySubmitConcurrency(2.9), 2);
  assert.equal(clampEntrySubmitConcurrency(Number.NaN), 1);
  assert.equal(clampEntrySubmitConcurrency(undefined), 1, "unset config must be the safe value");
});

// ── configured widths 1, 2, 4 ────────────────────────────────────────────────────────────

test("width 1 reproduces the pre-burst behaviour exactly: strictly one leg at a time", () => {
  const { slots } = fillEntryBurst(4, { base: 1, burst: 1 });
  assert.deepEqual(slots, ["base"], "only one leg may be in flight");
});

test("width 2 admits exactly two entry submissions", () => {
  const { slots } = fillEntryBurst(4, { base: 1, burst: 2 });
  assert.deepEqual(slots, ["base", "entry_burst"]);
});

test("width 4 admits all four entry legs: one base slot plus three burst slots", () => {
  const { slots, occupancy } = fillEntryBurst(4, { base: 1, burst: 4 });
  assert.deepEqual(slots, ["base", "entry_burst", "entry_burst", "entry_burst"]);
  assert.equal(occupancy.baseInFlight, 1);
  assert.equal(occupancy.burstInFlight, 3);
});

test("a fifth entry submission is refused even at width 4", () => {
  const { occupancy } = fillEntryBurst(4, { base: 1, burst: 4 });
  const fifth = admit("ENTRY", occupancy, { base: 1, burst: 4 });
  assert.equal(fifth.admit, false);
  assert.match(fifth.reason, /fully occupied/);
});

test("a raised BASE cap makes the burst unnecessary and loses nothing", () => {
  const { slots } = fillEntryBurst(4, { base: 4, burst: 1 });
  assert.deepEqual(slots, ["base", "base", "base", "base"]);
});

// ── two Boxes may never overlap ──────────────────────────────────────────────────────────

test("a SECOND Box pipeline is refused while the first has ENTRY legs in flight", () => {
  const { occupancy } = fillEntryBurst(4, { base: 1, burst: 4, attemptId: "A" });
  const other = admit("ENTRY", occupancy, { base: 1, burst: 4, attemptId: "B" });
  assert.equal(other.admit, false);
  assert.match(other.reason, /second Box pipeline may never overlap/);
});

test("a second Box cannot take a FREED BASE slot while the first still holds burst slots", () => {
  // The subtle case: leg 1 (base) has completed, legs 2-4 are still in flight on burst slots.
  // A base slot is free, so a naive check would admit an unrelated candidate here.
  const occupancy = {
    baseInFlight: 0,
    burstInFlight: 3,
    entryAttemptId: "A",
    nonEntryInFlight: 0,
  };
  const other = admit("ENTRY", occupancy, { base: 1, burst: 4, attemptId: "B" });
  assert.equal(other.admit, false, "a free base slot must not admit an overlapping Box");
  assert.match(other.reason, /may never overlap/);

  // The SAME pipeline may of course use it.
  const same = admit("ENTRY", occupancy, { base: 1, burst: 4, attemptId: "A" });
  assert.equal(same.admit, true);
});

test("overlapping candidates still serialise at width 4", () => {
  // Even with the widest burst, a different attempt id is refused at every occupancy level.
  for (let held = 1; held <= 4; held++) {
    const { occupancy } = fillEntryBurst(held, { base: 1, burst: 4, attemptId: "A" });
    const other = admit("ENTRY", occupancy, { base: 1, burst: 4, attemptId: "B" });
    assert.equal(other.admit, false, `refused with ${held} leg(s) of A in flight`);
  }
});

// ── protective and exit priority ─────────────────────────────────────────────────────────

test("EMERGENCY_RESIDUAL and PROTECTIVE_CANCEL count BASE occupancy only", () => {
  // Three burst slots held by an entry burst; the base slot is free.
  const occupancy = { baseInFlight: 0, burstInFlight: 3, entryAttemptId: "A", nonEntryInFlight: 0 };
  for (const purpose of ["EMERGENCY_RESIDUAL", "PROTECTIVE_CANCEL", "EXIT"]) {
    const verdict = admit(purpose, occupancy, { base: 1, burst: 4 });
    assert.equal(verdict.admit, true, `${purpose} must not be delayed by entry-burst slots`);
    assert.equal(verdict.slot, "base");
  }
});

test("an entry burst NEVER makes protective work wait longer than it would without the burst", () => {
  // Without a burst, one entry leg occupies the single base slot and protective work waits.
  const noBurst = { baseInFlight: 1, burstInFlight: 0, entryAttemptId: "A", nonEntryInFlight: 0 };
  // With a burst, the same single base slot is occupied plus three burst slots.
  const withBurst = { baseInFlight: 1, burstInFlight: 3, entryAttemptId: "A", nonEntryInFlight: 0 };
  for (const purpose of ["EMERGENCY_RESIDUAL", "PROTECTIVE_CANCEL", "EXIT"]) {
    const a = admit(purpose, noBurst, { base: 1, burst: 1 });
    const b = admit(purpose, withBurst, { base: 1, burst: 4 });
    assert.equal(a.admit, b.admit, `${purpose} admission must be identical with and without the burst`);
    assert.equal(b.admit, false);
  }
});

test("the entry burst does not open alongside protective or exit work", () => {
  const occupancy = { baseInFlight: 1, burstInFlight: 0, entryAttemptId: null, nonEntryInFlight: 1 };
  const entry = admit("ENTRY", occupancy, { base: 1, burst: 4 });
  assert.equal(entry.admit, false);
  assert.match(entry.reason, /non-ENTRY operation\(s\) are in flight/);
});

test("priority ordering itself is unchanged: emergency outranks cancel outranks exit outranks entry", () => {
  assert.ok(BOX_ORDER_PRIORITY.EMERGENCY_RESIDUAL < BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL);
  assert.ok(BOX_ORDER_PRIORITY.PROTECTIVE_CANCEL < BOX_ORDER_PRIORITY.EXIT);
  assert.ok(BOX_ORDER_PRIORITY.EXIT < BOX_ORDER_PRIORITY.ENTRY);
});

// ── general invariants ───────────────────────────────────────────────────────────────────

test("burst slots are never granted to a non-ENTRY purpose", () => {
  const occupancy = { baseInFlight: 1, burstInFlight: 0, entryAttemptId: null, nonEntryInFlight: 1 };
  for (const purpose of ["EMERGENCY_RESIDUAL", "PROTECTIVE_CANCEL", "EXIT"]) {
    const verdict = admit(purpose, occupancy, { base: 1, burst: 4 });
    // Refused rather than given a burst slot: the burst is an ENTRY-only mechanism.
    assert.equal(verdict.admit, false);
  }
});

test("a burst width at or below the base cap adds no headroom and says so", () => {
  const occupancy = { baseInFlight: 1, burstInFlight: 0, entryAttemptId: "A", nonEntryInFlight: 0 };
  const verdict = admit("ENTRY", occupancy, { base: 2, burst: 2 });
  assert.equal(verdict.admit, true, "base still has room");
  const full = admit("ENTRY", { baseInFlight: 2, burstInFlight: 0, entryAttemptId: "A", nonEntryInFlight: 0 }, { base: 2, burst: 2 });
  assert.equal(full.admit, false);
  assert.match(full.reason, /adds no headroom/);
});

test("an idle manager admits any purpose on a base slot", () => {
  for (const purpose of ["ENTRY", "EXIT", "PROTECTIVE_CANCEL", "EMERGENCY_RESIDUAL"]) {
    const verdict = admit(purpose, {}, { base: 1, burst: 4 });
    assert.equal(verdict.admit, true);
    assert.equal(verdict.slot, "base");
  }
});

test("a zero or negative base concurrency is sanitised to 1 rather than deadlocking", () => {
  for (const base of [0, -3, Number.NaN]) {
    const verdict = admit("ENTRY", {}, { base, burst: 4 });
    assert.equal(verdict.admit, true, `base ${String(base)} must not deadlock the queue`);
  }
});
