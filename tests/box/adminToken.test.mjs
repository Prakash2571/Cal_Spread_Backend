/**
 * Admin session tokens must be unguessable.
 *
 * They were generated with `Math.random().toString(36) + Date.now().toString(36)`.
 * `Math.random()` is a non-cryptographic PRNG whose internal state is recoverable from
 * observed outputs, and the `Date.now()` suffix is predictable — so it added length
 * without entropy. An admin token is a bearer credential for the FULL admin role
 * (placing, closing and deleting trades, switching broker), so it needs a CSPRNG.
 *
 * These tests pin the properties that matter, not the exact encoding.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { generateAdminToken } from "../../dist/adminToken.js";

test("a token is a non-empty string", () => {
  const token = generateAdminToken();
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
});

test("a token carries at least 128 bits of entropy", () => {
  // 32 random bytes base64url-encode to 43 chars. Asserting a floor rather than an
  // exact length keeps the encoding free to change without weakening the guarantee.
  const token = generateAdminToken();
  assert.ok(
    token.length >= 22,
    `token was ${token.length} chars, too short to carry 128 bits`,
  );
});

test("successive tokens differ", () => {
  const a = generateAdminToken();
  const b = generateAdminToken();
  assert.notEqual(a, b);
});

test("1000 tokens are all distinct", () => {
  // A collision here would mean one admin session could be hijacked by another.
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateAdminToken());
  assert.equal(seen.size, 1000);
});

test("tokens are URL and header safe with no escaping", () => {
  // The token travels in an `x-admin-token` header, in an SSE query string, and as a
  // Mongo _id. base64url avoids '+', '/' and '=' so none of those need encoding.
  for (let i = 0; i < 200; i++) {
    const token = generateAdminToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/, `unsafe characters in "${token}"`);
    assert.equal(encodeURIComponent(token), token, "must survive URL encoding unchanged");
    // A header value cannot contain control characters, whitespace or non-ASCII.
    assert.ok(!/[\s\x00-\x1f\x7f-\uffff]/.test(token), "not header safe");
  }
});

test("a token embeds NO timestamp", () => {
  // The old format ended with Date.now().toString(36), which leaked issue time and was
  // fully predictable. Two tokens taken a moment apart must share no trailing run.
  const a = generateAdminToken();
  const b = generateAdminToken();
  let shared = 0;
  while (
    shared < Math.min(a.length, b.length) &&
    a[a.length - 1 - shared] === b[b.length - 1 - shared]
  ) {
    shared++;
  }
  // A short coincidental match is possible; a timestamp would share ~7 chars.
  assert.ok(shared < 5, `tokens share a ${shared}-char suffix, suggesting a timestamp`);
});

test("output is not obviously biased", () => {
  // A crude sanity check that we are reading real random bytes rather than, say, a
  // constant or a low-entropy pool: a large sample should use most of the alphabet.
  const alphabet = new Set();
  for (let i = 0; i < 500; i++) for (const ch of generateAdminToken()) alphabet.add(ch);
  assert.ok(alphabet.size > 40, `only ${alphabet.size} distinct characters observed`);
});
