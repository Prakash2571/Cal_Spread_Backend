/**
 * The bounded quote cache.
 *
 * `POST /api/quotes` cached under a key derived from the CALLER'S token set. The TTL only
 * decided whether an entry was *served* — expired entries were never deleted and there was
 * no size cap. The route is unauthenticated and takes up to 4000 tokens, so every distinct
 * permutation (full board, filtered board, a detail page, a search result) left a permanent
 * entry holding full five-level depth ladders. It grew in normal use and unboundedly under
 * load until the process ran out of memory.
 *
 * These tests pin BOTH bounds: entries must actually be deleted on expiry, and the entry
 * count must never exceed the cap.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoundedTtlCache } from "../../dist/boundedCache.js";

/** A cache with a controllable clock, so TTL is tested without sleeping. */
function at(start = 1_000_000, opts = {}) {
  let now = start;
  const cache = new BoundedTtlCache({ ttlMs: 4000, maxEntries: 3, now: () => now, ...opts });
  return { cache, advance: (ms) => (now += ms) };
}

test("a fresh value is returned", () => {
  const { cache } = at();
  cache.set("k", [{ token: 1, last_price: 10 }]);
  assert.deepEqual(cache.get("k"), [{ token: 1, last_price: 10 }]);
});

test("an expired entry is DELETED, not merely skipped", () => {
  // The original bug: the TTL gated serving but never freed memory.
  const { cache, advance } = at();
  cache.set("k", [1]);
  assert.equal(cache.size, 1);
  advance(4001);
  assert.equal(cache.get("k"), undefined, "must not be served");
  assert.equal(cache.size, 0, "and must no longer occupy memory");
});

test("the entry count NEVER exceeds the cap, however many unique keys arrive", () => {
  // Simulates the attack/usage shape: a flood of distinct token permutations.
  const { cache } = at();
  for (let i = 0; i < 5000; i++) cache.set(`tokens-${i}`, [i]);
  assert.ok(cache.size <= 3, `size was ${cache.size}, cap is 3`);
});

test("eviction is oldest-first", () => {
  const { cache } = at();
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.set("d", 4); // evicts "a"
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("d"), 4);
});

test("re-setting a key refreshes its eviction position", () => {
  // Otherwise a hot key keeps its original position and is dropped while cold keys live.
  const { cache } = at();
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.set("a", 99); // "a" becomes newest
  cache.set("d", 4); // should evict "b", the true oldest
  assert.equal(cache.get("a"), 99);
  assert.equal(cache.get("b"), undefined);
});

test("expired entries are swept before anything live is evicted", () => {
  const { cache, advance } = at();
  cache.set("old1", 1);
  cache.set("old2", 2);
  advance(4001);
  cache.set("fresh", 3);
  // The two stale entries should have gone, leaving the newcomer alone.
  assert.equal(cache.size, 1);
  assert.equal(cache.get("fresh"), 3);
});

test("a missing key is undefined and does not create an entry", () => {
  const { cache } = at();
  assert.equal(cache.get("nope"), undefined);
  assert.equal(cache.size, 0);
});

test("clear() empties the cache", () => {
  const { cache } = at();
  cache.set("a", 1);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("a cap below one is coerced to one rather than disabling the cache", () => {
  const { cache } = at(1_000_000, { maxEntries: 0 });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("b"), 2);
});
