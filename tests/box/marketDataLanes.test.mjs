/**
 * TWO MARKET-DATA LANES — isolation between the futures and Box subscription domains.
 *
 * The property under test is that the two lanes cannot contaminate each other. That
 * isolation is structural: there are two `SubscriptionCoordinator` objects, each holding
 * a reference to only its own transport, so a diff computed for one is physically
 * incapable of emitting a subscribe or unsubscribe on the other's socket. These tests
 * pin that, plus the reconnect/resubscribe behaviour each lane owns.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SubscriptionCoordinator } from "../../dist/brokers/subscriptions.js";
import { TickRateCounter, MARKET_DATA_LANES } from "../../dist/brokers/marketDataLane.js";

/** A transport that records exactly what reached it, so leakage is observable. */
function recordingTransport(label) {
  const subscribed = [];
  const unsubscribed = [];
  return {
    label,
    subscribed,
    unsubscribed,
    live() {
      const set = new Set();
      for (const t of subscribed) set.add(t);
      for (const t of unsubscribed) set.delete(t);
      return set;
    },
    subscribeTokens: (tokens) => subscribed.push(...tokens),
    unsubscribeTokens: (tokens) => unsubscribed.push(...tokens),
  };
}

function twoLanes() {
  const futuresTransport = recordingTransport("futures");
  const boxTransport = recordingTransport("box");
  return {
    futuresTransport,
    boxTransport,
    futures: new SubscriptionCoordinator(futuresTransport, "futures"),
    box: new SubscriptionCoordinator(boxTransport, "box"),
  };
}

/* ═════════════════════════ lane isolation ═════════════════════════ */

test("T1: the futures and box subscription domains stay isolated", () => {
  const { futures, box, futuresTransport, boxTransport } = twoLanes();

  futures.setOwnerTokens("strategy", [111, 222]);
  box.setOwnerTokens("strategy", [900, 901, 902]);

  assert.deepEqual([...futuresTransport.live()].sort(), [111, 222]);
  assert.deepEqual([...boxTransport.live()].sort(), [900, 901, 902]);
  assert.equal(futures.size, 2, "futures counts only its own tokens");
  assert.equal(box.size, 3, "box counts only its own tokens");
  assert.equal(futures.lane, "futures");
  assert.equal(box.lane, "box");
});

test("T2: a futures token never becomes box-owned", () => {
  const { futures, box, boxTransport } = twoLanes();
  futures.setOwnerTokens("strategy", [111, 222]);

  assert.equal(box.countsFor(111), null, "the box lane has no knowledge of a futures token");
  assert.equal(boxTransport.subscribed.length, 0, "and never subscribed it");

  // Moving the futures window must not touch the box lane at all.
  futures.setOwnerTokens("strategy", [222, 333]);
  assert.equal(boxTransport.subscribed.length, 0);
  assert.equal(boxTransport.unsubscribed.length, 0);
});

test("T3: a box token never pollutes the futures coordinator", () => {
  const { futures, box, futuresTransport } = twoLanes();
  futures.setOwnerTokens("browser", [111]);
  const beforeSub = futuresTransport.subscribed.length;
  const beforeUnsub = futuresTransport.unsubscribed.length;

  box.setOwnerTokens("strategy", [900, 901]);
  box.setOwnerTokens("strategy", [901, 902]); // the strike window moves

  assert.equal(futures.countsFor(900), null, "futures never learns a box token");
  assert.equal(futuresTransport.subscribed.length, beforeSub, "no futures subscribe was emitted");
  assert.equal(futuresTransport.unsubscribed.length, beforeUnsub, "no futures unsubscribe was emitted");
  assert.deepEqual([...futuresTransport.live()], [111], "the board's token is untouched");
});

test("the SAME token in both lanes is refcounted independently", () => {
  // Legitimate: the Box scanner needs the underlying's spot price, and so does the
  // board. Each lane subscribes it on its OWN socket, and one releasing must not
  // unsubscribe the other's.
  const { futures, box, futuresTransport, boxTransport } = twoLanes();
  futures.setOwnerTokens("strategy", [555]);
  box.setOwnerTokens("strategy", [555]);
  assert.deepEqual([...futuresTransport.live()], [555]);
  assert.deepEqual([...boxTransport.live()], [555]);

  box.setOwnerTokens("strategy", []); // box drops it
  assert.deepEqual([...boxTransport.live()], [], "box unsubscribed on its own socket");
  assert.deepEqual([...futuresTransport.live()], [555], "the futures lane still has it");
});

test("within one lane, refcounting still prevents a duplicate upstream subscription", () => {
  const { box, boxTransport } = twoLanes();
  const a = box.acquire("strategy", [900]);
  const b = box.acquire("browser", [900]);
  assert.equal(boxTransport.subscribed.filter((t) => t === 900).length, 1, "only the 0->1 transition reaches upstream");

  a.release();
  assert.equal(boxTransport.unsubscribed.length, 0, "still wanted by the other consumer");
  b.release();
  assert.deepEqual(boxTransport.unsubscribed, [900], "unsubscribed only when the last holder went");
});

/* ═════════════════════════ broker switch ═════════════════════════ */

test("T4: a broker switch resets BOTH lanes", () => {
  const { futures, box } = twoLanes();
  futures.setOwnerTokens("strategy", [111, 222]);
  box.setOwnerTokens("strategy", [900, 901, 902]);

  const droppedFutures = futures.resetForBrokerSwitch();
  const droppedBox = box.resetForBrokerSwitch();

  assert.equal(droppedFutures.droppedTokens, 2);
  assert.equal(droppedBox.droppedTokens, 3);
  assert.equal(futures.size, 0, "no old-namespace futures token survives");
  assert.equal(box.size, 0, "no old-namespace box token survives");
});

test("T6: each lane replays only its OWN tokens after a reconnect", () => {
  const { futures, box } = twoLanes();
  futures.setOwnerTokens("strategy", [111, 222]);
  box.setOwnerTokens("strategy", [900, 901]);

  // This is what the registry replays per lane on a reconnect.
  assert.deepEqual(futures.activeTokens().sort(), [111, 222]);
  assert.deepEqual(box.activeTokens().sort(), [900, 901]);
  // The decisive property: neither list contains the other lane's tokens, so a replay
  // cannot put option strikes on the board's socket or futures on the Box lane's.
  for (const token of box.activeTokens()) {
    assert.equal(futures.activeTokens().includes(token), false);
  }
});

/* ═════════════════════════ lane plumbing ═════════════════════════ */

test("there are exactly two lanes, and they are named not boolean", () => {
  assert.deepEqual([...MARKET_DATA_LANES], ["futures", "box"]);
  // Fixed at two by construction: no code path can open an unbounded number of sockets.
  assert.equal(MARKET_DATA_LANES.length, 2);
});

test("lane stats appear per-lane in the coordinator's own summary", () => {
  const { futures, box } = twoLanes();
  futures.setOwnerTokens("strategy", [111]);
  box.setOwnerTokens("strategy", [900, 901]);
  assert.equal(futures.stats().lane, "futures");
  assert.equal(box.stats().lane, "box");
  assert.equal(futures.stats().tokens, 1);
  assert.equal(box.stats().tokens, 2);
});

/* ═════════════════════════ backpressure ═════════════════════════ */

test("T27: the tick-rate counter stays bounded under a high tick rate", () => {
  const counter = new TickRateCounter(10);
  const start = 1_700_000_000_000;
  // 60 seconds of 5000 ticks/second. A naive implementation accumulating samples would
  // hold 300k entries; this must hold at most its fixed window.
  for (let second = 0; second < 60; second++) {
    for (let batch = 0; batch < 50; batch++) {
      counter.mark(100, start + second * 1000 + batch);
    }
  }
  const rate = counter.perSecond(start + 60_000);
  assert.equal(Number.isFinite(rate), true, "still produces a finite rate");
  // Bounded memory: the ring is fixed at construction, so its own arrays are the only
  // storage and they cannot grow.
  const json = JSON.stringify(counter);
  assert.ok(json.length < 2000, `counter state must stay small (was ${json.length} bytes)`);
});

test("T26: thousands of box subscriptions remain bounded and correct", () => {
  const { box, boxTransport } = twoLanes();
  const many = Array.from({ length: 3000 }, (_, i) => 500_000 + i);
  box.setOwnerTokens("strategy", many);
  assert.equal(box.size, 3000, "all tracked");
  assert.equal(boxTransport.live().size, 3000, "all subscribed exactly once");

  // A window move of 3000 tokens must diff, not re-subscribe everything.
  const moved = Array.from({ length: 3000 }, (_, i) => 500_500 + i);
  const subBefore = boxTransport.subscribed.length;
  box.setOwnerTokens("strategy", moved);
  const added = boxTransport.subscribed.length - subBefore;
  assert.equal(added, 500, "only the genuinely new tokens were subscribed");
  assert.equal(box.size, 3000, "and the set size is unchanged");
});
