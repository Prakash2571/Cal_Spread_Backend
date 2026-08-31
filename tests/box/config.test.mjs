/**
 * Box configuration parsing.
 *
 * These exist because a silently-ignored env var is the worst kind of bug: the
 * system runs, reports a mode it is not in, and every number it produces is about
 * a different strategy than the one configured. `paper_legging` was in the type
 * union and fully implemented, but the parser did not accept it — so setting
 * BOX_EXECUTION_MODE=paper_legging quietly ran paper_latency instead.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadBoxConfig } from "../../dist/box/config.js";

/** Run `fn` with BOX_EXECUTION_MODE set, always restoring the previous value. */
function withMode(value, fn) {
  const key = "BOX_EXECUTION_MODE";
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

test("BOX_EXECUTION_MODE=paper_legging is accepted (never silently downgraded)", () => {
  withMode("paper_legging", () => {
    assert.equal(loadBoxConfig().executionMode, "paper_legging");
  });
});

test("every supported execution mode round-trips through the parser", () => {
  for (const mode of ["paper_touch", "paper_latency", "paper_legging"]) {
    withMode(mode, () => {
      assert.equal(loadBoxConfig().executionMode, mode);
    });
  }
});

test("the mode parser is case- and whitespace-insensitive", () => {
  for (const raw of ["  paper_legging  ", "PAPER_LEGGING", "Paper_Legging"]) {
    withMode(raw, () => {
      assert.equal(loadBoxConfig().executionMode, "paper_legging", `failed for ${JSON.stringify(raw)}`);
    });
  }
});

test("an unknown or empty mode falls back to the paper_latency default", () => {
  for (const raw of ["", "   ", "live", "paper", "paper_legging_v2", "nonsense"]) {
    withMode(raw, () => {
      assert.equal(loadBoxConfig().executionMode, "paper_latency", `failed for ${JSON.stringify(raw)}`);
    });
  }
  withMode(undefined, () => {
    assert.equal(loadBoxConfig().executionMode, "paper_latency");
  });
});

test("live order placement can never be configured", () => {
  for (const raw of ["live", "real", "zerodha", "LIVE"]) {
    withMode(raw, () => {
      const mode = loadBoxConfig().executionMode;
      assert.ok(mode.startsWith("paper_"), `${raw} must not select a non-paper mode (got ${mode})`);
    });
  }
});

test("charge-reconciliation retry is bounded by default", () => {
  const cfg = loadBoxConfig();
  assert.ok(cfg.chargeReconcileMaxAttempts >= 1, "at least one attempt");
  assert.ok(cfg.chargeReconcileMaxAttempts <= 10, "must stay bounded — never a hot retry loop");
  assert.ok(cfg.chargeReconcileRetryBaseMs > 0, "backoff must space the retries out");
});
