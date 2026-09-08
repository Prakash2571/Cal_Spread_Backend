/**
 * DEFECT 6 — HEDGE-FIRST ENTRY POST ORDER.
 *
 * The canonical role array is `[k1_ce, k2_ce, k2_pe, k1_pe]` and the live entry path used it as the
 * transport order. For a SHORT_BOX the entry sides are `SELL, BUY, SELL, BUY`, so the FIRST order
 * to reach the broker was a naked SELL and its hedge went second. These tests fail against that
 * code and pass against the hedge-first ordering.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  entrySubmissionOrder,
  entrySubmissionRoles,
  entryTransportRank,
  isHedgeFirstSequence,
} from "../../dist/box/entrySubmissionOrder.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { brokerOrderFor, entryPosts, liveStack, runEntry } from "./liveEntryHarness.mjs";

/* ── the pure ordering function ───────────────────────────────────────────────────────── */

test("LONG_BOX transport order is explicit, and puts both BUY hedges first", () => {
  assert.deepEqual(entrySubmissionRoles("LONG_BOX"), ["k1_ce", "k2_pe", "k2_ce", "k1_pe"]);
  assert.deepEqual(
    entrySubmissionOrder("LONG_BOX").map((slot) => [slot.role, slot.side, slot.rank, slot.hedge]),
    [
      ["k1_ce", "BUY", 0, true],
      ["k2_pe", "BUY", 1, true],
      ["k2_ce", "SELL", 2, false],
      ["k1_pe", "SELL", 3, false],
    ],
  );
});

test("SHORT_BOX transport order is explicit, and no longer leads with the naked SELL", () => {
  assert.deepEqual(entrySubmissionRoles("SHORT_BOX"), ["k2_ce", "k1_pe", "k1_ce", "k2_pe"]);
  assert.deepEqual(
    entrySubmissionOrder("SHORT_BOX").map((slot) => [slot.role, slot.side, slot.rank, slot.hedge]),
    [
      ["k2_ce", "BUY", 0, true],
      ["k1_pe", "BUY", 1, true],
      ["k1_ce", "SELL", 2, false],
      ["k2_pe", "SELL", 3, false],
    ],
  );
  // The defect, stated directly: the canonical order would have sent a SELL first.
  assert.equal(entrySideFor(BOX_LEG_ROLES[0], "SHORT_BOX"), "SELL");
  assert.equal(isHedgeFirstSequence(BOX_LEG_ROLES.map((r) => entrySideFor(r, "SHORT_BOX"))), false);
});

test("both directions satisfy the hedge-first property, and preserve the four role identities", () => {
  for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
    const order = entrySubmissionOrder(direction);
    assert.equal(order.length, 4);
    // Same four roles as canonical — a permutation, never a substitution or a loss.
    assert.deepEqual([...order.map((s) => s.role)].sort(), [...BOX_LEG_ROLES].sort());
    // Sides are still taken from the direction table; ordering must not rewrite economics.
    for (const slot of order) assert.equal(slot.side, entrySideFor(slot.role, direction));
    assert.ok(isHedgeFirstSequence(order.map((slot) => slot.side)), `${direction} is hedge-first`);
    // Exactly two hedges per box, and they occupy ranks 0 and 1.
    assert.deepEqual(order.filter((s) => s.hedge).map((s) => s.rank), [0, 1]);
    assert.deepEqual(order.map((s) => s.rank), [0, 1, 2, 3]);
  }
});

test("entryTransportRank agrees with the order and is total", () => {
  for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
    for (const slot of entrySubmissionOrder(direction)) {
      assert.equal(entryTransportRank(direction, slot.role), slot.rank);
    }
  }
  assert.equal(entryTransportRank("LONG_BOX", "not_a_role"), -1);
});

test("isHedgeFirstSequence is a real predicate, not a tautology", () => {
  assert.equal(isHedgeFirstSequence(["BUY", "BUY", "SELL", "SELL"]), true);
  assert.equal(isHedgeFirstSequence(["BUY", "SELL", "BUY", "SELL"]), false);
  assert.equal(isHedgeFirstSequence(["SELL", "BUY"]), false);
  assert.equal(isHedgeFirstSequence([]), true);
});

/* ── the live gateway actually transmits in that order ────────────────────────────────── */

test("SHORT_BOX: every BUY hedge reaches the broker before any uncovered SELL", async () => {
  const stack = await liveStack({ direction: "SHORT_BOX" });
  const result = await runEntry(stack);

  assert.equal(result.ok, true);
  const posts = entryPosts(stack.adapter);
  assert.equal(posts.length, 4);
  // THE REGRESSION. Under the old canonical ordering this array began ["k1_ce","SELL"].
  assert.deepEqual(posts.map((p) => [p.role, p.side]), [
    ["k2_ce", "BUY"],
    ["k1_pe", "BUY"],
    ["k1_ce", "SELL"],
    ["k2_pe", "SELL"],
  ]);
  assert.ok(isHedgeFirstSequence(posts.map((p) => p.side)));
  assert.deepEqual(stack.violations, []);
});

test("LONG_BOX: hedge-first also holds, and all four roles are still submitted once", async () => {
  const stack = await liveStack({ direction: "LONG_BOX" });
  const result = await runEntry(stack);

  assert.equal(result.ok, true);
  const posts = entryPosts(stack.adapter);
  assert.deepEqual(posts.map((p) => [p.role, p.side]), [
    ["k1_ce", "BUY"],
    ["k2_pe", "BUY"],
    ["k2_ce", "SELL"],
    ["k1_pe", "SELL"],
  ]);
  assert.ok(isHedgeFirstSequence(posts.map((p) => p.side)));
});

test("accounting stays keyed BY ROLE, not by transport position", async () => {
  const stack = await liveStack({ direction: "SHORT_BOX" });
  const result = await runEntry(stack);

  assert.equal(result.ok, true);
  // The record still reports the four roles in CANONICAL order with their correct sides and
  // quantities, even though they were transmitted in a different order.
  assert.deepEqual(result.legging.legs.map((leg) => leg.role), [...BOX_LEG_ROLES]);
  for (const leg of result.legging.legs) {
    assert.equal(leg.side, entrySideFor(leg.role, "SHORT_BOX"), `${leg.role} side`);
    assert.equal(leg.fill_qty, stack.candidate.lot_size, `${leg.role} filled quantity`);
    assert.equal(leg.requested_qty, stack.candidate.lot_size, `${leg.role} requested quantity`);
  }
  // And the transport order genuinely differed from the reported order, so the assertion above
  // is not accidentally true.
  assert.deepEqual(entryPosts(stack.adapter).map((p) => p.role), ["k2_ce", "k1_pe", "k1_ce", "k2_pe"]);
});

/* ── the barrier: ordering must survive concurrent submission ─────────────────────────── */

test("with entry concurrency 4 and a slow hedge, the uncovered SELL still POSTs last", async () => {
  // THE RACE THIS PINS DOWN. Building requests hedge-first is not sufficient: with all four legs
  // dequeued together, each does its own durable writes and whichever finishes first would reach
  // the broker first. Here the two BUY hedges are made deliberately SLOW in pacing, so without the
  // barrier the uncovered SELLs would overtake them.
  const stack = await liveStack({
    direction: "SHORT_BOX",
    limitOverrides: { maxConcurrentExecutions: 4, entrySubmitConcurrency: 4 },
    adapterOptions: {
      duringPacing: async (req) => {
        if (req.side === "BUY") {
          for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
        }
      },
    },
  });
  const result = await runEntry(stack);

  assert.equal(result.ok, true);
  const posts = entryPosts(stack.adapter);
  assert.equal(posts.length, 4);
  assert.ok(
    isHedgeFirstSequence(posts.map((p) => p.side)),
    `expected hedge-first, transmitted: ${posts.map((p) => `${p.role}:${p.side}`).join(", ")}`,
  );
  assert.deepEqual(posts.slice(0, 2).map((p) => p.side), ["BUY", "BUY"]);
});

test("a rejected BUY hedge stops the dependent uncovered SELLs BEFORE they POST", async () => {
  const stack = await liveStack({
    direction: "SHORT_BOX",
    limitOverrides: { maxConcurrentExecutions: 4, entrySubmitConcurrency: 4 },
    adapterOptions: {
      // The first hedge (k2_ce BUY) is refused by the broker. The uncovered SELLs are parked
      // behind the hedge barrier at this moment and must never be transmitted.
      submit: async (req) => brokerOrderFor(req, 0, req.role === "k2_ce" ? "REJECTED" : undefined),
    },
  });
  const result = await runEntry(stack);

  assert.equal(result.ok, false);
  const posts = entryPosts(stack.adapter);
  const sells = posts.filter((p) => p.side === "SELL");
  assert.deepEqual(sells, [], `no uncovered SELL may POST after a hedge rejection; got ${JSON.stringify(sells)}`);
  // The hedges themselves were legitimately attempted; only the dependents were stopped.
  assert.ok(posts.every((p) => p.side === "BUY"));

  // The stopped SELLs are terminalized as PROVEN LOCAL NO-POST, not as broker rejections.
  const sellRoles = ["k1_ce", "k2_pe"];
  for (const role of sellRoles) {
    const row = [...stack.persistence.rows.values()].find((r) => r.role === role && r.purpose === "ENTRY");
    assert.ok(row, `${role} durable intent exists`);
    assert.equal(row.state, "REJECTED");
    assert.equal(row.filled_quantity, 0);
    assert.equal(row.broker_order_id, null, `${role} never obtained a broker id`);
    const audit = row.audit.find((event) => event.payload?.origin === "local_pre_submit_refusal");
    assert.ok(audit, `${role} carries local-no-POST provenance`);
    assert.equal(audit.payload.no_broker_post, true);
    assert.match(audit.payload.reason, /hedge/i);
  }
});

test("a hedge whose submission is AMBIGUOUS also stops the dependent SELL", async () => {
  // An unproven hedge is not a hedge. Guessing in the permissive direction here would send a naked
  // short against a hedge that may not exist.
  const { BrokerAmbiguousSubmitError } = await import("../../dist/box/brokerAdapter.js");
  const stack = await liveStack({
    direction: "SHORT_BOX",
    limitOverrides: { maxConcurrentExecutions: 4, entrySubmitConcurrency: 4 },
    adapterOptions: {
      submit: async (req) => {
        if (req.role === "k2_ce") throw new BrokerAmbiguousSubmitError(req.client_order_id, "transport timeout");
        return brokerOrderFor(req);
      },
    },
  });
  const result = await runEntry(stack);

  assert.equal(result.ok, false);
  assert.deepEqual(entryPosts(stack.adapter).filter((p) => p.side === "SELL"), []);
});
