/**
 * Position-book behaviour that the broker-switch guard and the delete path rely on.
 *
 * Two separate guarantees:
 *  1. Removing a position FREES its strike-pair key, so the same box can be opened
 *     again immediately after a deletion (duplicate-open protection must not leak).
 *  2. The book can report which brokers hold open exposure, which is what makes
 *     "never both brokers at once" enforceable rather than aspirational.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxPositionBook } from "../../dist/box/positions.js";

/** A position carrying only the fields these tests read. */
function position(id, { key = `ASTRAL|2026-09-29|2500|2520|LONG_BOX`, broker = "zerodha", mode = "paper_latency" } = {}) {
  return {
    id,
    key,
    broker,
    execution_mode: mode,
    legs: {
      k1_ce: { token: 1001 },
      k2_ce: { token: 1002 },
      k2_pe: { token: 1003 },
      k1_pe: { token: 1004 },
    },
  };
}

test("removing a position frees its strike-pair key so the box can reopen", () => {
  const book = new BoxPositionBook();
  const key = "ASTRAL|2026-09-29|2500|2520|LONG_BOX";

  book.add(position("t1", { key }));
  assert.equal(book.isTaken(key), true);
  assert.equal(book.size, 1);

  const removed = book.remove("t1");
  assert.equal(removed.id, "t1");

  // This is the deletion contract: the duplicate-open guard must NOT keep blocking
  // a box whose trade was deleted, or the operator could never re-enter it.
  assert.equal(book.isTaken(key), false, "key released");
  assert.equal(book.size, 0);
  assert.equal(book.getByKey(key), undefined);
  assert.equal(book.reserve(key), true, "the pair can be claimed again");
});

test("removing an unknown id is a no-op returning undefined", () => {
  const book = new BoxPositionBook();
  assert.equal(book.remove("nope"), undefined);
  assert.equal(book.size, 0);
});

test("remove also clears a lingering reservation for that key", () => {
  const book = new BoxPositionBook();
  const key = "BSE|2026-09-29|3200|3400|LONG_BOX";
  assert.equal(book.reserve(key), true);
  assert.equal(book.reserve(key), false, "a reserved pair cannot be double-claimed");
  book.add(position("t2", { key }));
  book.remove("t2");
  assert.equal(book.isTaken(key), false);
});

test("brokersInUse reports the distinct brokers holding open exposure", () => {
  const book = new BoxPositionBook();
  assert.deepEqual(book.brokersInUse(), [], "an empty book blocks no switch");

  book.add(position("a", { key: "K|1", broker: "zerodha" }));
  book.add(position("b", { key: "K|2", broker: "zerodha" }));
  assert.deepEqual(book.brokersInUse(), ["zerodha"], "de-duplicated");

  book.add(position("c", { key: "K|3", broker: "dhan" }));
  assert.deepEqual([...book.brokersInUse()].sort(), ["dhan", "zerodha"]);
});

test("foreignPositions finds exposure belonging to a non-active broker", () => {
  const book = new BoxPositionBook();
  book.add(position("a", { key: "K|1", broker: "zerodha" }));
  book.add(position("b", { key: "K|2", broker: "dhan" }));

  // Activating Dhan must be refused while a Zerodha box is still open: nothing
  // would be watching it with the right feed, and reconciliation would be routed
  // to the wrong order-id space.
  assert.deepEqual(book.foreignPositions("dhan").map((p) => p.id), ["a"]);
  assert.deepEqual(book.foreignPositions("zerodha").map((p) => p.id), ["b"]);
});

test("an empty book has no foreign exposure, so a switch is safe", () => {
  const book = new BoxPositionBook();
  assert.deepEqual(book.foreignPositions("dhan"), []);
  assert.deepEqual(book.foreignPositions("zerodha"), []);
});

test("livePositions isolates real exposure from simulated exposure", () => {
  const book = new BoxPositionBook();
  book.add(position("p1", { key: "K|1", mode: "paper_touch" }));
  book.add(position("p2", { key: "K|2", mode: "paper_latency" }));
  book.add(position("p3", { key: "K|3", mode: "paper_legging" }));
  book.add(position("l1", { key: "K|4", mode: "live" }));

  // The delete endpoint and the switch guard both need this distinction: a paper
  // position can be removed freely, a live one may have real broker exposure.
  assert.deepEqual(book.livePositions().map((p) => p.id), ["l1"]);
});

test("tokens() drops a deleted position's legs so subscriptions can be released", () => {
  const book = new BoxPositionBook();
  book.add(position("t1", { key: "K|1" }));
  assert.deepEqual(book.tokens().sort(), [1001, 1002, 1003, 1004]);
  book.remove("t1");
  assert.deepEqual(book.tokens(), [], "no ghost tokens stay subscribed");
});
