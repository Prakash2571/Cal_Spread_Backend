/**
 * SUITE B — REAL BROKER PACING REMAINS.
 *
 * The point of separating order-mutation pacing from poll pacing was to make the four-leg
 * entry burst reach the broker faster. That is only defensible if the placement gap remains a
 * REAL rate-limit wait derived from published broker limits. These tests pin that it does:
 * never zero, never below a per-broker floor, and with total transport rate still bounded.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_PACING_PROFILES,
  brokerPacingProfile,
  burstPacingBudgetMs,
  pacingWaitMs,
  resolveBrokerPacing,
  TransportPacer,
} from "../../dist/box/brokerPacing.js";

/** A virtual clock that records every wait it is asked to serve. */
function fakeClock() {
  let now = 0;
  const waits = [];
  return {
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
    waits,
    at: () => now,
  };
}

test("the published-limit profiles are frozen and per-broker", () => {
  assert.ok(Object.isFrozen(BROKER_PACING_PROFILES));
  assert.equal(BROKER_PACING_PROFILES.zerodha.floorMs, 100, "Kite documents 10 order req/sec");
  assert.equal(BROKER_PACING_PROFILES.zerodha.defaultOrderMutationMs, 110, "10% headroom over the floor");
  assert.equal(BROKER_PACING_PROFILES.dhan.floorMs, 120, "matches DHAN_MIN_INTERVAL_MS in the HTTP layer");
});

test("every profile has a non-zero floor: pacing can never be switched off", () => {
  for (const profile of Object.values(BROKER_PACING_PROFILES)) {
    assert.ok(profile.floorMs > 0, `${profile.broker} floor must be positive`);
    assert.ok(profile.defaultOrderMutationMs >= profile.floorMs);
    assert.ok(profile.rationale.length > 0, "a floor must carry its justification");
  }
});

test("an unrecognised broker falls back to the STRICTEST profile, not to no pacing", () => {
  const unknown = brokerPacingProfile("some-new-broker");
  const strictestFloor = Math.max(...Object.values(BROKER_PACING_PROFILES).map((p) => p.floorMs));
  assert.equal(unknown.floorMs, strictestFloor);
  assert.ok(unknown.defaultOrderMutationMs >= strictestFloor);
});

test("default resolution uses the broker profile and leaves the general interval alone", () => {
  const kite = resolveBrokerPacing("zerodha", 250, 0);
  assert.equal(kite.orderMutationMinIntervalMs, 110);
  assert.equal(kite.generalMinIntervalMs, 250, "poll cadence is unchanged for existing deployments");
  assert.equal(kite.source, "broker_default");

  const dhan = resolveBrokerPacing("dhan", 250, 0);
  assert.equal(dhan.orderMutationMinIntervalMs, 120);
  assert.equal(dhan.generalMinIntervalMs, 250);
});

test("an operator override ABOVE the floor is honoured", () => {
  const pacing = resolveBrokerPacing("zerodha", 250, 400);
  assert.equal(pacing.orderMutationMinIntervalMs, 400);
  assert.equal(pacing.source, "operator_override");
});

test("an override BELOW the floor is clamped UP, and says so", () => {
  const pacing = resolveBrokerPacing("zerodha", 250, 10);
  assert.equal(pacing.orderMutationMinIntervalMs, 100, "clamped to the Kite floor");
  assert.equal(pacing.source, "clamped_to_floor");
});

test("BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS cannot be used to disable pacing", () => {
  for (const attempt of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
    const pacing = resolveBrokerPacing("zerodha", 250, attempt);
    assert.ok(
      pacing.orderMutationMinIntervalMs >= BROKER_PACING_PROFILES.zerodha.floorMs,
      `override ${String(attempt)} must not defeat the floor`,
    );
  }
});

test("pacingWaitMs returns the remaining gap and never a negative number", () => {
  const pacing = resolveBrokerPacing("zerodha", 250, 0);
  // Nothing sent yet.
  assert.equal(pacingWaitMs({ pacing, klass: "order_mutation", lastCallAt: -Infinity, now: 0 }), 0);
  // 40ms after the last placement: 70ms of the 110ms gap remains.
  assert.equal(pacingWaitMs({ pacing, klass: "order_mutation", lastCallAt: 0, now: 40 }), 70);
  // Long past the gap.
  assert.equal(pacingWaitMs({ pacing, klass: "order_mutation", lastCallAt: 0, now: 5_000 }), 0);
  // General class uses the general interval.
  assert.equal(pacingWaitMs({ pacing, klass: "general", lastCallAt: 0, now: 50 }), 200);
});

test("a backwards clock step serves the FULL interval rather than bypassing pacing", () => {
  const pacing = resolveBrokerPacing("zerodha", 250, 0);
  // `now` earlier than the last call: elapsed would be negative.
  const wait = pacingWaitMs({ pacing, klass: "order_mutation", lastCallAt: 1_000, now: 500 });
  assert.equal(wait, 110, "a clock step must not be a free pass through the rate limiter");
});

// ── the pacer, on a virtual clock ────────────────────────────────────────────────────────

test("four successive order mutations are spaced at the ORDER interval", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  const at = [];
  await Promise.all(
    [0, 1, 2, 3].map(() => pacer.run(async () => at.push(clock.at()), "order_mutation")),
  );
  assert.deepEqual(at, [0, 110, 220, 330], "110ms apart, not 250ms apart");
  // Three gaps paid, matching the advertised budget.
  assert.equal(burstPacingBudgetMs(pacer.effective(), 4), 330);
});

test("the four-leg burst is still PACED — it is not a free-for-all", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  await Promise.all([0, 1, 2, 3].map(() => pacer.run(async () => {}, "order_mutation")));
  const stats = pacer.stats();
  assert.equal(stats.orderMutations, 4);
  assert.ok(stats.totalWaitMs > 0, "a burst must still pay real rate-limit waits");
  assert.equal(stats.orderMutationWaitMs, 330);
});

test("status polls keep the 250ms cadence, unaffected by the split", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  const at = [];
  await Promise.all([0, 1, 2].map(() => pacer.run(async () => at.push(clock.at()), "general")));
  assert.deepEqual(at, [0, 250, 500]);
});

test("an unclassified call is paced by the SLOWER general interval", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  const at = [];
  // No class argument at all.
  await Promise.all([0, 1].map(() => pacer.run(async () => at.push(clock.at()))));
  assert.deepEqual(at, [0, 250], "defaulting to the fast bucket would be a silent rate-limit risk");
});

test("the ABSOLUTE floor bounds total transport rate across the two buckets", async () => {
  const clock = fakeClock();
  const pacing = resolveBrokerPacing("zerodha", 250, 0);
  const pacer = new TransportPacer(pacing, clock);
  const at = [];
  // Alternate classes. Per-class watermarks alone would allow both to fire at t=0.
  await pacer.run(async () => at.push(clock.at()), "general");
  await pacer.run(async () => at.push(clock.at()), "order_mutation");
  await pacer.run(async () => at.push(clock.at()), "general");
  // Every consecutive pair is at least the order interval apart.
  for (let i = 1; i < at.length; i++) {
    assert.ok(
      at[i] - at[i - 1] >= pacing.orderMutationMinIntervalMs,
      `calls ${i - 1}->${i} were ${at[i] - at[i - 1]}ms apart, under the absolute floor`,
    );
  }
  assert.ok(pacer.stats().absoluteFloorBinds > 0, "the absolute floor should have bound at least once");
});

test("a placement immediately after a poll is not forced to wait the POLL interval", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  await pacer.run(async () => {}, "general");
  const before = clock.at();
  await pacer.run(async () => {}, "order_mutation");
  // Pays the absolute floor (110ms), NOT the 250ms poll cadence. This is the conflation the
  // split removed: a poll must not delay an entry leg by the poll interval.
  assert.equal(clock.at() - before, 110);
});

test("a failed call does not break the pacing chain", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  await assert.rejects(pacer.run(async () => { throw new Error("broker 500"); }, "order_mutation"));
  // The next call must still be paced relative to the failed one: a rejected request still
  // consumed rate-limit budget at the broker.
  const before = clock.at();
  await pacer.run(async () => {}, "order_mutation");
  assert.equal(clock.at() - before, 110);
});

test("repoint changes the interval but RETAINS the watermarks", async () => {
  const clock = fakeClock();
  const pacer = new TransportPacer(resolveBrokerPacing("zerodha", 250, 0), clock);
  await pacer.run(async () => {}, "order_mutation");
  // A broker switch must not be usable as a way to issue an immediate unpaced burst.
  pacer.repoint(resolveBrokerPacing("dhan", 250, 0));
  const before = clock.at();
  await pacer.run(async () => {}, "order_mutation");
  assert.ok(clock.at() - before > 0, "watermarks must survive a repoint");
  assert.equal(pacer.effective().broker, "dhan");
});

test("burstPacingBudgetMs is honest about a single-leg or empty burst", () => {
  const pacing = resolveBrokerPacing("zerodha", 250, 0);
  assert.equal(burstPacingBudgetMs(pacing, 0), 0);
  assert.equal(burstPacingBudgetMs(pacing, 1), 0, "one placement pays no gap");
  assert.equal(burstPacingBudgetMs(pacing, 2), 110);
});
