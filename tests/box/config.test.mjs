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

/**
 * Run with an isolated Box execution environment. `loadBoxConfig` reads env at
 * call time, so the single cached ESM import is safe; restoring both keys in a
 * finally block also keeps concurrently-loaded test modules uncontaminated.
 */
function withExecutionEnv({ mode, liveEnabled }, fn) {
  const values = {
    BOX_EXECUTION_MODE: mode,
    BOX_LIVE_TRADING_ENABLED: liveEnabled,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key)
      ? { present: true, value: process.env[key] }
      : { present: false });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, old] of previous) {
      if (old.present) process.env[key] = old.value;
      else delete process.env[key];
    }
  }
}

function withMode(mode, fn) {
  return withExecutionEnv({ mode, liveEnabled: undefined }, fn);
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

test("unset or blank mode keeps the paper_latency default with live disabled", () => {
  for (const mode of [undefined, "", "   "]) {
    withExecutionEnv({ mode, liveEnabled: undefined }, () => {
      const config = loadBoxConfig();
      assert.equal(config.executionMode, "paper_latency");
      assert.equal(config.liveTradingEnabled, false);
    });
  }
});

test("unknown BOX_EXECUTION_MODE values fail closed", () => {
  for (const mode of ["paper", "real", "zerodha", "paper_legging_v2", "nonsense"]) {
    withExecutionEnv({ mode, liveEnabled: undefined }, () => {
      assert.throws(() => loadBoxConfig(), /invalid BOX_EXECUTION_MODE/);
    });
  }
});

test("live mode is rejected when the independent live gate is absent or false", () => {
  for (const liveEnabled of [undefined, "", "false", "0", "no"]) {
    withExecutionEnv({ mode: "live", liveEnabled }, () => {
      assert.throws(
        () => loadBoxConfig(),
        /BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true/,
      );
    });
  }
});

test("live mode loads only when BOX_LIVE_TRADING_ENABLED=true", () => {
  withExecutionEnv({ mode: " LiVe ", liveEnabled: "true" }, () => {
    const config = loadBoxConfig();
    assert.equal(config.executionMode, "live");
    assert.equal(config.liveTradingEnabled, true);
  });
});

test("paper modes are unchanged even when the live gate is false", () => {
  for (const mode of ["paper_touch", "paper_latency", "paper_legging"]) {
    withExecutionEnv({ mode, liveEnabled: "false" }, () => {
      assert.equal(loadBoxConfig().executionMode, mode);
    });
  }
});

test("charge-reconciliation retry is bounded by default", () => {
  const cfg = loadBoxConfig();
  assert.ok(cfg.chargeReconcileMaxAttempts >= 1, "at least one attempt");
  assert.ok(cfg.chargeReconcileMaxAttempts <= 10, "must stay bounded — never a hot retry loop");
  assert.ok(cfg.chargeReconcileRetryBaseMs > 0, "backoff must space the retries out");
});


/* --------------------- paper live-parity profile config --------------------- */

/** Set/restore an arbitrary set of env keys around fn. */
function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key)
        ? { present: true, value: process.env[key] }
        : { present: false },
    );
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, old] of previous) {
      if (old.present) process.env[key] = old.value;
      else delete process.env[key];
    }
  }
}

test("the paper profile DEFAULTS to standard — existing deployments are unchanged", () => {
  withEnv(
    {
      BOX_PAPER_EXECUTION_PROFILE: undefined,
      BOX_PAPER_LATENCY_MODE: undefined,
      BOX_PAPER_LATENCY_SAMPLES: undefined,
    },
    () => {
      const cfg = loadBoxConfig();
      assert.equal(cfg.paperExecutionProfile, "standard");
      assert.equal(cfg.paperLatencyMode, "constant");
      assert.deepEqual(cfg.paperLatencySamples, []);
    },
  );
});

test("live_parity is accepted and an unknown profile falls back to standard", () => {
  withEnv({ BOX_PAPER_EXECUTION_PROFILE: "live_parity" }, () => {
    assert.equal(loadBoxConfig().paperExecutionProfile, "live_parity");
  });
  withEnv({ BOX_PAPER_EXECUTION_PROFILE: "nonsense" }, () => {
    assert.equal(loadBoxConfig().paperExecutionProfile, "standard");
  });
});

test("paper concurrency defaults to the LIVE cap (conservative baseline)", () => {
  withEnv(
    { BOX_PAPER_MAX_CONCURRENT_EXECUTIONS: undefined, BOX_LIVE_MAX_CONCURRENT_EXECUTIONS: "1" },
    () => {
      assert.equal(loadBoxConfig().paperMaxConcurrentExecutions, 1);
    },
  );
  withEnv({ BOX_PAPER_MAX_CONCURRENT_EXECUTIONS: "3" }, () => {
    assert.equal(loadBoxConfig().paperMaxConcurrentExecutions, 3);
  });
});

test("recorded latency samples parse into a clean numeric array", () => {
  withEnv(
    { BOX_PAPER_LATENCY_MODE: "recorded_samples", BOX_PAPER_LATENCY_SAMPLES: "180, 210, bad, -5, 420" },
    () => {
      const cfg = loadBoxConfig();
      assert.equal(cfg.paperLatencyMode, "recorded_samples");
      // "bad" dropped, negative dropped, order preserved.
      assert.deepEqual(cfg.paperLatencySamples, [180, 210, 420]);
    },
  );
});
