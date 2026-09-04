/**
 * HARD SAFETY INVARIANT: no paper mode can ever reach a real broker adapter.
 *
 * paper_touch / paper_latency / paper_legging — and paper_legging under the live_parity
 * profile — must ALL route execution to the deterministic simulator and never to the
 * order manager (which is the only thing that talks to Kite/Dhan). This is enforced by
 * the gateway fork `if (this.mode !== "live") return simulator...`, and reinforced by the
 * engine only ever constructing a manager in live mode.
 *
 * The test wires a POISON manager whose every method throws. If any paper path so much
 * as reads it, the test explodes. A live positive-control proves the poison is genuinely
 * reachable — so the paper silence is meaningful, not a false pass.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { cfg } from "./helpers.mjs";

/** Every access throws — standing in for a real Kite/Dhan-backed order manager. */
function poisonManager() {
  const boom = (name) => () => {
    throw new Error(`PAPER REACHED THE BROKER via manager.${name}`);
  };
  return {
    status: boom("status"),
    submit: boom("submit"),
    reconcile: boom("reconcile"),
    cancelWorkingBoxOrders: boom("cancelWorkingBoxOrders"),
    invariantViolation: boom("invariantViolation"),
  };
}

/** Records which delegations happened; returns benign values. */
function stubSimulator() {
  const calls = [];
  const async = (name) => async () => {
    calls.push(name);
    return { ok: false, mode: name };
  };
  return {
    calls,
    hasCapacity: () => {
      calls.push("hasCapacity");
      return true;
    },
    simulateEntry: async("simulateEntry"),
    simulateLeggingEntry: async("simulateLeggingEntry"),
    simulateExit: async("simulateExit"),
    simulateLeggingExit: async("simulateLeggingExit"),
    estimateExecutableExit: () => {
      calls.push("estimateExecutableExit");
      return [];
    },
    flattenResidual: async("flattenResidual"),
  };
}

const PAPER_CASES = [
  { mode: "paper_touch", profile: "standard" },
  { mode: "paper_latency", profile: "standard" },
  { mode: "paper_legging", profile: "standard" },
  { mode: "paper_legging", profile: "live_parity" },
];

for (const { mode, profile } of PAPER_CASES) {
  test(`${mode} (${profile}) routes to the simulator and NEVER touches the manager`, async () => {
    const simulator = stubSimulator();
    const gateway = new CentralBoxExecutionGateway({
      cfg: cfg({ executionMode: mode, paperExecutionProfile: profile }),
      simulator,
      quotes: new BoxQuoteStore(),
      manager: poisonManager(), // present, but must never be read
      allocateTradeId: () => {
        throw new Error("PAPER allocated a live trade id");
      },
    });

    // Exercise every execution surface. If any reads the poison manager, it throws.
    assert.equal(gateway.hasCapacity(), true);
    await gateway.simulateEntry({});
    await gateway.simulateLeggingEntry({});
    await gateway.simulateExit({});
    await gateway.simulateLeggingExit({});
    await gateway.flattenResidual({});
    gateway.estimateExecutableExit({}, 0);

    // Everything delegated to the simulator.
    assert.deepEqual(
      new Set(simulator.calls),
      new Set([
        "hasCapacity",
        "simulateEntry",
        "simulateLeggingEntry",
        "simulateExit",
        "simulateLeggingExit",
        "flattenResidual",
        "estimateExecutableExit",
      ]),
    );
  });
}

test("POSITIVE CONTROL: live mode DOES reach the manager (so the poison is real)", () => {
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({ executionMode: "live", liveTradingEnabled: true }),
    simulator: stubSimulator(),
    quotes: new BoxQuoteStore(),
    manager: poisonManager(),
  });
  // In live mode hasCapacity() reads manager.status() — the poison must fire here.
  assert.throws(() => gateway.hasCapacity(), /PAPER REACHED THE BROKER via manager\.status/);
});

test("the simulator itself refuses to run an entry in live mode (defense in depth)", async () => {
  // Even if the fork were bypassed, the simulator guards its own paper-only contract:
  // it REFUSES (never a paper fallback) rather than simulating a fill for a live order.
  const { BoxExecutionSimulator } = await import("../../dist/box/executionSimulator.js");
  const sim = new BoxExecutionSimulator({
    cfg: cfg({ executionMode: "live", liveTradingEnabled: true }),
    quotes: new BoxQuoteStore(),
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
  });
  const result = await sim.simulateEntry({
    candidate: { key: "x" },
    detection: { at: 0, legs: [] },
    qualify: () => ({}),
  });
  assert.equal(result.ok, false, "must refuse, never simulate a live fill");
  assert.match(result.detail, /live OrderManager is not integrated/i);
});
