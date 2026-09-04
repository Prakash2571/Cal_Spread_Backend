/**
 * The passcode guard on the curl-friendly broker token routes.
 *
 * These routes hand out a live broker access token — a bearer credential that can place
 * and cancel orders — so the guard is security-critical. The property that matters most
 * is that an UNSET secret disables the route rather than opening it: a forgotten
 * environment variable must not publish a trading credential to the internet while
 * looking like a healthy deployment.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkTokenPasscode, readPasscode } from "../../dist/tokenRouteAuth.js";

const SECRET = "s3cr3t-passcode-value";

/* ------------------------------- fails closed ----------------------------- */

test("an UNSET secret disables the route, it never grants access", () => {
  // The one that would be catastrophic to get backwards.
  for (const configured of [undefined, "", "   ", "\t\n"]) {
    assert.equal(
      checkTokenPasscode(configured, "anything"),
      "not_configured",
      `configured=${JSON.stringify(configured)} must disable the route`,
    );
  }
});

test("an unset secret is not_configured even when the caller sends nothing", () => {
  // i.e. empty-vs-empty must not be read as a match.
  assert.equal(checkTokenPasscode("", ""), "not_configured");
  assert.equal(checkTokenPasscode(undefined, undefined), "not_configured");
});

test("a missing or empty passcode is forbidden", () => {
  for (const provided of [undefined, "", null, 123, {}]) {
    assert.equal(
      checkTokenPasscode(SECRET, provided),
      "forbidden",
      `provided=${JSON.stringify(provided)} must be refused`,
    );
  }
});

/* -------------------------------- matching -------------------------------- */

test("the exact passcode is accepted", () => {
  assert.equal(checkTokenPasscode(SECRET, SECRET), "ok");
});

test("the configured secret is trimmed, the supplied one is NOT", () => {
  // Trailing whitespace in an env file is an accident; in a request it is a mismatch.
  assert.equal(checkTokenPasscode(`  ${SECRET}  `, SECRET), "ok");
  assert.equal(checkTokenPasscode(SECRET, ` ${SECRET}`), "forbidden");
});

test("near-miss passcodes are refused", () => {
  for (const wrong of [
    SECRET.toUpperCase(),
    SECRET.slice(0, -1),
    `${SECRET}x`,
    SECRET.replace("3", "e"),
    "",
  ]) {
    assert.equal(checkTokenPasscode(SECRET, wrong), "forbidden", `"${wrong}"`);
  }
});

test("comparison tolerates length differences without throwing", () => {
  // timingSafeEqual throws on unequal lengths, so both sides are hashed first.
  assert.equal(checkTokenPasscode("short", "a".repeat(5000)), "forbidden");
  assert.equal(checkTokenPasscode("a".repeat(5000), "short"), "forbidden");
});

/* ------------------------------ passcode source ---------------------------- */

test("the header wins over the query string", () => {
  assert.equal(readPasscode("from-header", "from-query"), "from-header");
});

test("the query string is used when no header is present", () => {
  assert.equal(readPasscode(undefined, "from-query"), "from-query");
});

test("a repeated header takes the first value, never a joined string", () => {
  // Express hands back an array; stringifying it would produce "a,b" and never match.
  assert.equal(readPasscode(["first", "second"], undefined), "first");
});

test("a non-string query value is ignored rather than coerced", () => {
  // ?passcode=a&passcode=b arrives as an array; coercing it could match by accident.
  assert.equal(readPasscode(undefined, ["a", "b"]), undefined);
  assert.equal(readPasscode(undefined, { a: 1 }), undefined);
  assert.equal(readPasscode(undefined, undefined), undefined);
});

test("end to end: only the real passcode from either source is accepted", () => {
  assert.equal(checkTokenPasscode(SECRET, readPasscode(SECRET, undefined)), "ok");
  assert.equal(checkTokenPasscode(SECRET, readPasscode(undefined, SECRET)), "ok");
  assert.equal(checkTokenPasscode(SECRET, readPasscode(undefined, undefined)), "forbidden");
  assert.equal(checkTokenPasscode(SECRET, readPasscode("nope", SECRET)), "forbidden");
});
