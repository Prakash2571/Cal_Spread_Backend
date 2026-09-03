/**
 * Market-data transport: sessions, token validation, and subscription refcounting.
 *
 * THE FAILURE THIS COVERS
 * The browser requested the whole board with `GET /api/stream?tokens=<816 ten-digit
 * ids>` — a 9022-byte request line. nginx caps a request line at one header buffer
 * (`large_client_header_buffers` defaults to `4 8k`) and answers 414 while parsing it,
 * so Express never ran the handler: no browser lease, nothing subscribed upstream, no
 * ticks, and "-" in every cell. Verified locally — at an 8192-byte limit the request is
 * rejected and the handler does not run; at Node's 16 KB default the same request
 * succeeds, which is why nothing appeared in the backend logs.
 *
 * Tokens now travel in a POST body and are exchanged for a session id, so the SSE URL
 * is constant-size. These tests pin the store's safety properties: bounded, TTL'd,
 * generation-scoped, and reconnect-tolerant.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketDataSessionStore,
  parseTokenList,
  MAX_SESSION_TOKENS,
} from "../../dist/marketDataSession.js";
import { SubscriptionCoordinator } from "../../dist/brokers/subscriptions.js";

const tokens816 = Array.from({ length: 816 }, (_, i) => 2_000_000_000 + i);

/** A store with a controllable clock, so TTL is tested without sleeping. */
function storeAt(start = 1_000_000, opts = {}) {
  let now = start;
  const store = new MarketDataSessionStore({ now: () => now, ...opts });
  return { store, advance: (ms) => (now += ms), now: () => now };
}

/* ---------------------------- token validation ---------------------------- */

test("a full board's token list is accepted in a body", () => {
  const parsed = parseTokenList(tokens816);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tokens.length, 816);
});

test("token lists are deduplicated", () => {
  // A duplicate would be refcounted twice under one lease and strand the upstream
  // subscription when that lease is released.
  const parsed = parseTokenList([7, 7, 8, 9, 9, 9]);
  assert.deepEqual(parsed.tokens, [7, 8, 9]);
});

test("only positive integers are accepted", () => {
  for (const bad of [[0], [-1], [1.5], [Number.NaN], [Infinity], ["123"], [null], [{}]]) {
    const parsed = parseTokenList(bad);
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("a numeric STRING is rejected rather than coerced", () => {
  // Silent coercion is how a malformed board ends up subscribing garbage.
  assert.equal(parseTokenList(["2000000001"]).ok, false);
});

test("a non-array, empty, or oversized body is rejected", () => {
  assert.equal(parseTokenList(undefined).ok, false);
  assert.equal(parseTokenList({}).ok, false);
  assert.equal(parseTokenList([]).ok, false);
  const tooMany = Array.from({ length: MAX_SESSION_TOKENS + 1 }, (_, i) => i + 1);
  const parsed = parseTokenList(tooMany);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Too many tokens/);
});

test("the token limit comfortably exceeds today's board", () => {
  // 204 stocks is not the maximum; the design target is 2000+.
  assert.ok(MAX_SESSION_TOKENS >= 2000, `limit ${MAX_SESSION_TOKENS} must allow 2000+`);
  assert.equal(parseTokenList(Array.from({ length: 2000 }, (_, i) => i + 1)).ok, true);
});

/* ------------------------------ session store ----------------------------- */

test("a session round-trips the whole board", () => {
  const { store } = storeAt();
  const session = store.create(tokens816, "dhan", 3);
  assert.equal(session.tokens.length, 816);
  const resolved = store.resolve(session.id, "dhan", 3);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.session.tokens.length, 816);
});

test("session ids are opaque, unguessable and unique", () => {
  const { store } = storeAt();
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(store.create([1], "dhan", 1).id);
  assert.equal(ids.size, 50, "no collisions");
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/, "128 bits of hex");
});

test("the SSE path for a session is tiny regardless of token count", () => {
  const { store } = storeAt();
  const session = store.create(tokens816, "dhan", 1);
  const path = `/api/stream/session/${session.id}`;
  assert.ok(path.length < 100, `path was ${path.length} bytes`);
  // The whole point: 816 tokens, but nothing token-shaped in the URL.
  assert.ok(!path.includes(","));
});

test("an unknown session is not_found, so the client mints a new one", () => {
  const { store } = storeAt();
  const resolved = store.resolve("deadbeef", "dhan", 1);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "not_found");
});

/* --------------------------- reconnect tolerance -------------------------- */

test("a session SURVIVES repeated resolves, so EventSource can reconnect", () => {
  // A single-use id would turn a 3-second network blip into a permanently dead board.
  const { store } = storeAt();
  const session = store.create(tokens816, "dhan", 1);
  for (let i = 0; i < 5; i++) {
    assert.equal(store.resolve(session.id, "dhan", 1).ok, true, `resolve #${i + 1}`);
  }
});

test("a session with a LIVE connection is never reaped", () => {
  const { store, advance } = storeAt();
  const session = store.create([1, 2, 3], "dhan", 1);
  store.open(session.id);
  advance(60 * 60_000); // an hour of wall clock
  assert.equal(store.sweep(), 0, "a live connection holds the session");
  assert.equal(store.resolve(session.id, "dhan", 1).ok, true);
});

test("an idle session is reaped after its TTL", () => {
  const { store, advance } = storeAt(1_000_000, { ttlMs: 60_000 });
  const session = store.create([1, 2, 3], "dhan", 1);
  store.open(session.id);
  store.close(session.id);
  advance(30_000);
  assert.equal(store.sweep(), 0, "still inside the TTL");
  advance(31_000);
  assert.equal(store.sweep(), 1);
  assert.equal(store.resolve(session.id, "dhan", 1).reason, "not_found");
});

test("closing one of two connections keeps the session alive", () => {
  const { store, advance } = storeAt(1_000_000, { ttlMs: 60_000 });
  const session = store.create([1], "dhan", 1);
  store.open(session.id);
  store.open(session.id);
  store.close(session.id);
  advance(120_000);
  assert.equal(store.sweep(), 0, "one connection remains");
});

/* --------------------------- broker-switch safety ------------------------- */

test("a session from a previous GENERATION is refused", () => {
  // A Kite token is not a Dhan token even when the integers coincide.
  const { store } = storeAt();
  const session = store.create(tokens816, "dhan", 3);
  const resolved = store.resolve(session.id, "dhan", 4);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "stale_generation");
});

test("a session from a different BROKER is refused", () => {
  const { store } = storeAt();
  const session = store.create([1, 2], "zerodha", 1);
  assert.equal(store.resolve(session.id, "dhan", 1).reason, "stale_generation");
});

test("a refused session is dropped, not left to be retried forever", () => {
  const { store } = storeAt();
  const session = store.create([1], "dhan", 1);
  store.resolve(session.id, "dhan", 2);
  assert.equal(store.size, 0);
  assert.equal(store.resolve(session.id, "dhan", 2).reason, "not_found");
});

test("a broker switch drops every session", () => {
  const { store } = storeAt();
  store.create([1], "dhan", 1);
  store.create([2], "dhan", 1);
  store.create([3], "dhan", 1);
  assert.equal(store.dropAll(), 3);
  assert.equal(store.size, 0);
});

/* -------------------------------- bounded -------------------------------- */

test("the store is BOUNDED, since unauthenticated callers can create sessions", () => {
  const { store } = storeAt(1_000_000, { maxSessions: 10, ttlMs: 10 ** 9 });
  for (let i = 0; i < 40; i++) store.create([i + 1], "dhan", 1);
  assert.ok(store.size <= 10, `size ${store.size} must stay within the cap`);
});

test("eviction never kills a session with a live connection", () => {
  const { store } = storeAt(1_000_000, { maxSessions: 3, ttlMs: 10 ** 9 });
  const keep = store.create([1], "dhan", 1);
  store.open(keep.id);
  for (let i = 0; i < 20; i++) store.create([i + 100], "dhan", 1);
  assert.equal(store.resolve(keep.id, "dhan", 1).ok, true, "the live session survived");
});

test("stats report sessions, connections and tokens", () => {
  const { store } = storeAt();
  const a = store.create([1, 2, 3], "dhan", 1);
  store.create([4, 5], "dhan", 1);
  store.open(a.id);
  const stats = store.stats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.connections, 1);
  assert.equal(stats.tokens, 5);
});

/* ------------------- refcounting across browser streams ------------------- */

/** Records what actually reached the upstream socket. */
function recordingCoordinator() {
  const subscribed = [];
  const unsubscribed = [];
  const coordinator = new SubscriptionCoordinator({
    subscribeTokens: (t) => subscribed.push([...t]),
    unsubscribeTokens: (t) => unsubscribed.push([...t]),
  });
  return { coordinator, subscribed, unsubscribed };
}

test("two browser leases with OVERLAPPING tokens subscribe upstream ONCE", () => {
  const { coordinator, subscribed } = recordingCoordinator();
  const a = coordinator.acquire("browser", [1, 2, 3]);
  const b = coordinator.acquire("browser", [2, 3, 4]);

  assert.deepEqual(subscribed[0], [1, 2, 3]);
  assert.deepEqual(subscribed[1], [4], "only the genuinely new token goes upstream");
  assert.equal(coordinator.size, 4);
  a.release();
  b.release();
});

test("releasing one lease keeps tokens another lease still wants", () => {
  const { coordinator, unsubscribed } = recordingCoordinator();
  const a = coordinator.acquire("browser", [1, 2, 3]);
  const b = coordinator.acquire("browser", [2, 3, 4]);

  a.release();
  assert.deepEqual(unsubscribed[0], [1], "only the token nobody else wants is dropped");
  assert.equal(coordinator.size, 3);

  b.release();
  assert.deepEqual(unsubscribed[1].sort((x, y) => x - y), [2, 3, 4]);
  assert.equal(coordinator.size, 0);
});

test("a DOUBLE release cannot unsubscribe another client's tokens", () => {
  // An SSE 'close' fires on both the request and the response, so cleanup runs twice.
  const { coordinator, unsubscribed } = recordingCoordinator();
  const a = coordinator.acquire("browser", [1, 2]);
  const b = coordinator.acquire("browser", [1, 2]);

  a.release();
  a.release();
  a.release();

  assert.equal(unsubscribed.length, 0, "b still wants both tokens");
  assert.equal(coordinator.size, 2);
  b.release();
  assert.equal(coordinator.size, 0);
});

test("a browser lease does not disturb the scanner's tokens", () => {
  const { coordinator, unsubscribed } = recordingCoordinator();
  coordinator.setOwnerTokens("scanner", [10, 11]);
  const browser = coordinator.acquire("browser", [11, 12]);
  browser.release();

  assert.deepEqual(unsubscribed.flat(), [12], "the scanner's token 11 survives");
  assert.equal(coordinator.countsFor(11).scanner, 1);
});

test("a full board lease reports a browser subscription count > 0", () => {
  // CASE A in the diagnostics: browser === 0 means the request never arrived.
  const { coordinator } = recordingCoordinator();
  const lease = coordinator.acquire("browser", tokens816);
  const stats = coordinator.stats();
  assert.equal(stats.browser, 816);
  assert.equal(stats.tokens, 816);
  assert.equal(stats.leases, 1);
  lease.release();
  assert.equal(coordinator.stats().tokens, 0);
});
