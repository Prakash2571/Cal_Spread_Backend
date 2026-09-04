/**
 * The graceful-shutdown coordinator.
 *
 * The properties that matter are all failure-mode properties, so they are tested
 * directly rather than inferred from a running process:
 *
 *   - a second SIGTERM must not run cleanup twice (a double `dispose()` could release a
 *     refcount the first pass already released)
 *   - one failing step must not skip the later ones, because the later steps are the
 *     database closes
 *   - order must be deterministic: entries are disabled before the feed stops, and the
 *     database closes last
 *   - a hung step must not hang the process forever
 *
 * No step in these tests touches a broker. Nothing here can place an order.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ShutdownCoordinator, shutdownExitCode } from "../../dist/shutdown.js";

/** Records call order across steps. */
function recorder() {
  const calls = [];
  return {
    calls,
    step: (name, impl) => ({
      name,
      run: async () => {
        calls.push(name);
        if (impl) await impl();
      },
    }),
  };
}

const silent = () => {};

/* --------------------------------- idempotency ---------------------------------- */

test("a second signal does NOT run cleanup twice", () => {
  // Two SIGTERMs in quick succession is normal (orchestrator + shell).
  const r = recorder();
  const c = new ShutdownCoordinator({
    steps: [r.step("a"), r.step("b")],
    log: silent,
  });
  return Promise.all([c.run("SIGTERM"), c.run("SIGTERM"), c.run("SIGINT")]).then(
    ([first, second, third]) => {
      assert.deepEqual(r.calls, ["a", "b"], "each step ran exactly once");
      // All callers observe the SAME result rather than the later ones getting nothing.
      assert.equal(second, first);
      assert.equal(third, first);
    },
  );
});

test("repeated calls after completion still do not re-run steps", async () => {
  const r = recorder();
  const c = new ShutdownCoordinator({ steps: [r.step("a")], log: silent });
  await c.run("SIGTERM");
  await c.run("SIGTERM");
  assert.deepEqual(r.calls, ["a"]);
});

test("inProgress flips as soon as shutdown begins", async () => {
  const r = recorder();
  const c = new ShutdownCoordinator({ steps: [r.step("a")], log: silent });
  assert.equal(c.inProgress, false);
  const running = c.run("SIGTERM");
  assert.equal(c.inProgress, true, "must be observable synchronously after run()");
  await running;
  assert.equal(c.inProgress, true);
});

/* ------------------------------ deterministic order ----------------------------- */

test("steps run strictly in the declared order", async () => {
  const r = recorder();
  const order = [
    "mark-shutting-down",
    "disable-box-entries",
    "http-close",
    "stop-timers",
    "box-engine-dispose",
    "stop-broker-feed",
    "close-databases",
  ];
  const c = new ShutdownCoordinator({
    steps: order.map((n) => r.step(n)),
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.deepEqual(r.calls, order);
  assert.deepEqual(result.completed, order);
});

test("an async step is awaited before the next begins", async () => {
  // Closing Mongo while the engine is mid-dispose would race persistence.
  const r = recorder();
  const c = new ShutdownCoordinator({
    steps: [
      r.step("slow", () => new Promise((resolve) => setTimeout(resolve, 25))),
      r.step("after"),
    ],
    log: silent,
  });
  await c.run("SIGTERM");
  assert.deepEqual(r.calls, ["slow", "after"]);
});

/* ------------------------------- error isolation -------------------------------- */

test("a failing step does NOT prevent later steps", async () => {
  // The critical case: the database closes are LAST, so an early throw must not skip
  // them. This is the whole reason each step is individually wrapped.
  const r = recorder();
  const c = new ShutdownCoordinator({
    steps: [
      r.step("stop-scanner", () => {
        throw new Error("scanner already stopped");
      }),
      r.step("stop-feed"),
      r.step("close-databases"),
    ],
    log: silent,
  });
  const result = await c.run("SIGTERM");

  assert.deepEqual(r.calls, ["stop-scanner", "stop-feed", "close-databases"]);
  assert.deepEqual(result.completed, ["stop-feed", "close-databases"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].step, "stop-scanner");
  assert.match(result.failed[0].error, /already stopped/);
});

test("every step failing still reaches the end and reports each one", async () => {
  const c = new ShutdownCoordinator({
    steps: ["a", "b", "c"].map((name) => ({
      name,
      run: () => {
        throw new Error(`${name} boom`);
      },
    })),
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.deepEqual(result.completed, []);
  assert.deepEqual(
    result.failed.map((f) => f.step),
    ["a", "b", "c"],
  );
  assert.equal(result.timedOut, false);
});

test("a rejected promise is handled like a thrown error", async () => {
  const c = new ShutdownCoordinator({
    steps: [
      { name: "async-fail", run: () => Promise.reject(new Error("nope")) },
      { name: "after", run: () => {} },
    ],
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.deepEqual(result.completed, ["after"]);
  assert.equal(result.failed[0].step, "async-fail");
});

test("a non-Error throw is still recorded", async () => {
  const c = new ShutdownCoordinator({
    steps: [{ name: "odd", run: () => Promise.reject("a string") }],
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.equal(result.failed[0].error, "a string");
});

/* -------------------------------- timeout safety -------------------------------- */

test("a hung step does not hang shutdown forever", async () => {
  const c = new ShutdownCoordinator({
    // Never resolves, as a wedged socket close would behave.
    steps: [{ name: "hung", run: () => new Promise(() => {}) }],
    timeoutMs: 40,
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.completed, []);
  assert.equal(shutdownExitCode(result), 1, "a timeout must exit non-zero");
});

test("the timeout reports which steps did not finish", async () => {
  const logs = [];
  const c = new ShutdownCoordinator({
    steps: [
      { name: "fast", run: () => {} },
      { name: "hung", run: () => new Promise(() => {}) },
      { name: "never-reached", run: () => {} },
    ],
    timeoutMs: 40,
    log: (m) => logs.push(m),
  });
  const result = await c.run("SIGTERM");
  assert.deepEqual(result.completed, ["fast"]);
  const timeoutLine = logs.find((l) => l.includes("TIMED OUT"));
  assert.ok(timeoutLine, "the timeout must be logged clearly");
  assert.match(timeoutLine, /hung/);
  assert.match(timeoutLine, /never-reached/);
  // It must be explicit that nothing was liquidated or fabricated.
  assert.match(timeoutLine, /NO trading state has been altered or invented/);
});

test("finishing inside the deadline is not a timeout", async () => {
  const c = new ShutdownCoordinator({
    steps: [{ name: "quick", run: () => new Promise((r) => setTimeout(r, 5)) }],
    timeoutMs: 500,
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.equal(result.timedOut, false);
  assert.equal(shutdownExitCode(result), 0);
});

/* ---------------------------------- reporting ----------------------------------- */

test("a step that throws is NOT by itself a failed shutdown", async () => {
  // Exit code reflects "did we finish", not "was every hook happy". An already-closed
  // socket complaining must not make every deploy look broken.
  const c = new ShutdownCoordinator({
    steps: [
      {
        name: "noisy",
        run: () => {
          throw new Error("already closed");
        },
      },
    ],
    log: silent,
  });
  const result = await c.run("SIGTERM");
  assert.equal(result.failed.length, 1);
  assert.equal(result.timedOut, false);
  assert.equal(shutdownExitCode(result), 0);
});

test("the signal name and duration are reported", async () => {
  let t = 1000;
  const c = new ShutdownCoordinator({
    steps: [{ name: "a", run: () => {} }],
    log: silent,
    now: () => (t += 5),
  });
  const result = await c.run("SIGINT");
  assert.equal(result.signal, "SIGINT");
  assert.ok(result.durationMs >= 0);
});

test("an empty step list is a clean no-op", async () => {
  const c = new ShutdownCoordinator({ steps: [], log: silent });
  const result = await c.run("SIGTERM");
  assert.deepEqual(result.completed, []);
  assert.equal(result.timedOut, false);
  assert.equal(shutdownExitCode(result), 0);
});
