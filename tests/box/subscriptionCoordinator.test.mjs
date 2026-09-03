/**
 * Refcounted subscription ownership.
 *
 * The bug this prevents: `/api/stream` registered browser tokens straight into the
 * Kite hub, so (a) the last client to disconnect could unsubscribe a token the Box
 * scanner still needed, and (b) opening a browser tab created a ZERODHA WebSocket even
 * when Dhan was the active broker. Both follow from having no notion of who wants a
 * token, so ownership and counting are asserted here directly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SubscriptionCoordinator } from "../../dist/brokers/subscriptions.js";

/** A transport that records only the TRANSITIONS it is told about. */
function coordinator() {
  const calls = { sub: [], unsub: [] };
  const c = new SubscriptionCoordinator({
    subscribeTokens: (t) => calls.sub.push([...t].sort((a, b) => a - b)),
    unsubscribeTokens: (t) => calls.unsub.push([...t].sort((a, b) => a - b)),
  });
  return { c, calls };
}

/** Every token ever pushed upstream, flattened. */
const flat = (list) => list.flat().sort((a, b) => a - b);

test("a first acquire subscribes upstream exactly once", () => {
  const { c, calls } = coordinator();
  c.acquire("browser", [1, 2, 3]);
  assert.deepEqual(calls.sub, [[1, 2, 3]]);
  assert.deepEqual(calls.unsub, []);
});

test("TWO SSE clients with overlapping tokens subscribe each token once", () => {
  // Client A: 1,2,3 · Client B: 2,3,4 → upstream must see 1,2,3,4 exactly once.
  const { c, calls } = coordinator();
  c.acquire("browser", [1, 2, 3]);
  c.acquire("browser", [2, 3, 4]);
  assert.deepEqual(flat(calls.sub), [1, 2, 3, 4], "no duplicate upstream subscriptions");
  assert.deepEqual(calls.sub[1], [4], "only the genuinely new token was sent");
});

test("disconnecting ONE client keeps tokens the other still wants", () => {
  const { c, calls } = coordinator();
  const a = c.acquire("browser", [1, 2, 3]);
  c.acquire("browser", [2, 3, 4]);
  calls.unsub.length = 0;

  a.release();
  // 1 was A's alone; 2 and 3 are still held by B.
  assert.deepEqual(flat(calls.unsub), [1]);
  assert.deepEqual(c.activeTokens().sort((x, y) => x - y), [2, 3, 4]);
});

test("disconnecting the LAST client releases the remaining tokens", () => {
  const { c, calls } = coordinator();
  const a = c.acquire("browser", [1, 2, 3]);
  const b = c.acquire("browser", [2, 3, 4]);
  a.release();
  calls.unsub.length = 0;
  b.release();
  assert.deepEqual(flat(calls.unsub), [2, 3, 4]);
  assert.deepEqual(c.activeTokens(), []);
});

test("a Box scanner token SURVIVES an SSE disconnect", () => {
  // The exact cross-consumer bug: a browser leaving must not blind the strategy.
  const { c, calls } = coordinator();
  c.acquire("strategy", [100]);
  const browser = c.acquire("browser", [100, 101]);
  calls.unsub.length = 0;

  browser.release();
  assert.deepEqual(flat(calls.unsub), [101], "only the browser-only token was dropped");
  assert.deepEqual(c.activeTokens(), [100], "the strategy keeps its token");
});

test("refcounts are tracked per owner class", () => {
  const { c } = coordinator();
  c.acquire("browser", [7]);
  c.acquire("browser", [7]);
  c.acquire("strategy", [7]);
  const counts = c.countsFor(7);
  assert.equal(counts.browser, 2);
  assert.equal(counts.strategy, 1);
  assert.equal(counts.total, 3);
});

test("a repeated token within ONE lease counts once", () => {
  // Otherwise a client whose query string repeats a token would strand the
  // subscription forever after release.
  const { c, calls } = coordinator();
  const lease = c.acquire("browser", [5, 5, 5]);
  assert.equal(c.countsFor(5).total, 1);
  lease.release();
  assert.deepEqual(flat(calls.unsub), [5]);
  assert.equal(c.countsFor(5), null);
});

test("a double release is harmless", () => {
  // An SSE 'close' can fire more than once.
  const { c, calls } = coordinator();
  const other = c.acquire("strategy", [9]);
  const lease = c.acquire("browser", [9]);
  lease.release();
  lease.release();
  assert.deepEqual(flat(calls.unsub), [], "9 is still held by the strategy");
  assert.equal(c.countsFor(9).total, 1);
  other.release();
});

test("setOwnerTokens diffs a moving window without flapping shared tokens", () => {
  // The scanner's strike window drifts. Tokens present in BOTH sets must not be
  // unsubscribed and resubscribed, which a release-then-acquire would do.
  const { c, calls } = coordinator();
  c.setOwnerTokens("scanner", [1, 2, 3]);
  calls.sub.length = 0;
  calls.unsub.length = 0;

  c.setOwnerTokens("scanner", [2, 3, 4]);
  assert.deepEqual(flat(calls.unsub), [1], "only the abandoned token");
  assert.deepEqual(flat(calls.sub), [4], "only the newly wanted token");
});

test("setOwnerTokens does not disturb another owner's holdings", () => {
  const { c, calls } = coordinator();
  c.acquire("browser", [1, 2]);
  c.setOwnerTokens("scanner", [2, 3]);
  calls.unsub.length = 0;

  // The scanner walks away from everything.
  c.setOwnerTokens("scanner", []);
  assert.deepEqual(flat(calls.unsub), [3], "2 is still wanted by the browser");
  assert.deepEqual(c.activeTokens().sort((a, b) => a - b), [1, 2]);
});

test("resetForBrokerSwitch drops everything and issues NO upstream unsubscribe", () => {
  // The old socket is being stopped anyway, and the old tokens have no meaning to the
  // new broker — translating them would be the namespace leak the switch prevents.
  const { c, calls } = coordinator();
  c.acquire("browser", [1, 2]);
  c.setOwnerTokens("scanner", [3, 4]);
  calls.sub.length = 0;
  calls.unsub.length = 0;

  const dropped = c.resetForBrokerSwitch();
  assert.equal(dropped.droppedTokens, 4);
  assert.deepEqual(calls.unsub, [], "no cross-namespace unsubscribe attempted");
  assert.deepEqual(c.activeTokens(), []);
  assert.equal(c.size, 0);
});

test("after a reset, re-registering subscribes cleanly in the new namespace", () => {
  const { c, calls } = coordinator();
  c.acquire("browser", [1, 2]);
  c.resetForBrokerSwitch();
  calls.sub.length = 0;

  c.acquire("browser", [2_000_045_678]);
  assert.deepEqual(flat(calls.sub), [2_000_045_678]);
});

test("stats report per-owner token counts", () => {
  const { c } = coordinator();
  c.acquire("browser", [1, 2]);
  c.setOwnerTokens("scanner", [2, 3]);
  const stats = c.stats();
  assert.equal(stats.browser, 2);
  assert.equal(stats.scanner, 2);
  assert.equal(stats.tokens, 3);
});

test("invalid tokens are ignored rather than subscribed", () => {
  const { c, calls } = coordinator();
  c.acquire("browser", [0, -1, NaN, 5]);
  assert.deepEqual(flat(calls.sub), [5]);
});
