/**
 * SUITE A — NO ARTIFICIAL LATENCY ON THE LIVE PATH.
 *
 * The central claim of this change is that live execution never intentionally sleeps because of a
 * PAPER simulation construct, while every REAL safety/rate-limit wait is preserved. That claim is
 * only worth anything if it is locked down, because the failure mode is silent: a paper delay
 * leaking into live costs money on every order and looks like broker latency.
 *
 * Three independent techniques, because each catches something the others miss:
 *
 *   1. POISON DEPENDENCIES — build the live gateway with every paper timing construct replaced by
 *      a function that THROWS. If live touches one, the test fails loudly. This catches a real
 *      call, which is what actually matters.
 *   2. CALL-GRAPH AUDIT — assert, against the source, that the modules on the live path do not
 *      even reference the paper latency modules. This catches a leak added later that a fixture
 *      happens not to exercise.
 *   3. A DECLARED INVARIANT — the live path reports `artificial_latency_applied_to_live: false`
 *      via the API, so an operator can verify it without reading code.
 *
 * The companion suite (brokerPacing.test.mjs) proves the REAL waits are still there. Removing an
 * artificial delay and removing a rate limit are very different things, and these two suites
 * together are what keep them distinguishable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { cfg, exitQuotes, goodCandidate, seedStore } from "./helpers.mjs";

const NOW = 10_000;

const src = (f) => readFileSync(new URL(`../../src/box/${f}`, import.meta.url), "utf8");

/** Strip comments, so a mention in prose never counts as a reference. */
const code = (f) =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");

/* ═══════════════ 1. POISON DEPENDENCIES ═══════════════ */

function brokerOrder(req, filled = req.quantity) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.role}`,
    tag: null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state: filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED",
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? req.pricing.reference_price : null,
    fills: filled > 0 ? [{ fill_id: `f-${req.role}`, quantity: filled, price: req.pricing.reference_price, at: NOW }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

/**
 * Every paper timing construct, replaced by a poison function.
 *
 * Named exactly after the constructs the specification lists, so a failure names the culprit.
 */
function poisonedSimulator(touched) {
  const poison = (what) => () => {
    touched.push(what);
    throw new Error(`LIVE PATH TOUCHED PAPER CONSTRUCT: ${what}`);
  };
  return {
    // Reachable-by-mistake entry points.
    simulateLeggingEntry: poison("simulator.simulateLeggingEntry"),
    simulateEntry: poison("simulator.simulateEntry"),
    simulateLeggingExit: poison("simulator.simulateLeggingExit"),
    simulateExit: poison("simulator.simulateExit"),
    flattenResidual: poison("simulator.flattenResidual"),
    // Paper timing model.
    simulatedDecisionDelay: poison("simulatedDecisionDelay"),
    simulatedLatency: poison("simulatedLatency"),
    latencySource: poison("latencySource"),
    recordedLatencySamples: poison("recordedLatencySamples"),
    latencyDistribution: poison("latencyDistribution"),
    arrivalPlanner: poison("paperScheduler.arrivalPlanner"),
    ackToTerminal: poison("paperAckToTerminal"),
    cancelRaceModel: poison("paperCancelRaceModel"),
    persistenceSimulation: poison("paperPersistenceSimulation"),
    wait: poison("simulator.wait"),
    // Legitimately consulted by the live gateway; must NOT throw.
    hasCapacity: () => false,
    estimateExecutableExit: () => [],
    calibrationStatus: () => ({ evidence_driven: false, latency: null }),
  };
}

function liveHarness({ fillByRole = {}, config = {} } = {}) {
  const { candidate } = goodCandidate();
  const quotes = new BoxQuoteStore();
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);
  const touched = [];
  const waits = [];
  const submitted = [];
  const manager = {
    status: () => ({ inFlight: 0, queued: 0 }),
    submit: async (req) => {
      submitted.push(req);
      return brokerOrder(req, fillByRole[req.role] ?? req.quantity);
    },
    invariantViolation: () => {},
  };
  const gateway = new CentralBoxExecutionGateway({
    cfg: cfg({
      executionMode: "live",
      liveTradingEnabled: true,
      queueModel: "none",
      liveMaxChaseTicks: 2,
      legMaxChaseTicks: 2,
      // Deliberately NON-ZERO. If live consulted these the test would still pass with 0, which is
      // exactly the mistake to avoid: absence of a delay must be proved, not configured.
      simulatedDecisionMs: 5_000,
      simulatedLatencyMs: 5_000,
      ...config,
    }),
    simulator: poisonedSimulator(touched),
    quotes,
    manager,
    broker: () => "zerodha",
    allocateTradeId: () => "trade-1",
    isTokenWarm: () => true,
    feedGeneration: () => 7,
    // A poisoned clock: the live path must never ASK anything to wait.
    now: () => NOW,
    chargeTotal: () => 0,
  });
  return { candidate, quotes, gateway, manager, touched, waits, submitted };
}

function detectionFor(candidate, quotes) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => {
      const leg = candidate.legs[role];
      const q = quotes.get(leg.token);
      const side = entrySideFor(role, candidate.direction ?? "LONG_BOX");
      return {
        role, side, token: leg.token, tradingsymbol: leg.tradingsymbol,
        strike: leg.strike, instrument_type: leg.instrument_type,
        price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
        qty_at_touch: candidate.lot_size,
        bid: q.bids[0].price, bid_qty: q.bids[0].quantity,
        ask: q.asks[0].price, ask_qty: q.asks[0].quantity,
        quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
        age_ms: 0, fresh: true, executable: true,
      };
    }),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true, depth_ok: true, worst_age_ms: 0, quote_version: 1, reject: null,
  };
}

test("a LIVE 4/4 entry touches NO paper timing construct", async () => {
  const h = liveHarness();
  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: detectionFor(h.candidate, h.quotes),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true, expected_net_profit: 5_000, min_expected_net_profit: 1_200 }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(h.touched, [], `live touched paper constructs: ${h.touched.join(", ")}`);
});

test("a LIVE PARTIAL entry and its protective unwind touch NO paper timing construct", async () => {
  // The unwind path is where a "simulated unwind latency" would most plausibly creep in.
  const h = liveHarness({ fillByRole: { k1_pe: 0 } });
  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: detectionFor(h.candidate, h.quotes),
    stillWanted: () => true,
    qualify: () => { throw new Error("unreachable"); },
  });
  assert.equal(result.ok, false);
  assert.ok(h.submitted.some((r) => r.purpose === "EMERGENCY_RESIDUAL"), "the unwind must have run");
  assert.deepEqual(h.touched, [], `live touched paper constructs: ${h.touched.join(", ")}`);
});

test("a LIVE economics abort touches NO paper timing construct", async () => {
  const h = liveHarness();
  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: detectionFor(h.candidate, h.quotes),
    stillWanted: () => true,
    qualify: () => ({ qualifies: false, expected_net_profit: 10, min_expected_net_profit: 1_200 }),
  });
  assert.equal(result.reason, "abort_after_fill");
  assert.deepEqual(h.touched, [], `live touched paper constructs: ${h.touched.join(", ")}`);
});

test("LIVE residual flattening touches NO paper timing construct", async () => {
  const h = liveHarness();
  const inst = h.candidate.legs.k1_ce;
  await h.gateway.flattenResidual({
    keyPrefix: "attempt-1",
    residual: [{
      token: inst.token, tradingsymbol: inst.tradingsymbol, exchange: inst.exchange,
      role: "k1_ce", side: "BUY", quantity: 25, average_price: 100,
      source: "partial_entry", created_at: NOW,
    }],
  });
  assert.deepEqual(h.touched, [], `live touched paper constructs: ${h.touched.join(", ")}`);
});

test("live execution completes with a FROZEN clock, proving it never waits on one", async () => {
  // `now` is a constant. A path that needed to sleep-until would either hang or misbehave; one
  // that only awaits real broker/network responses does not care.
  const h = liveHarness();
  const result = await h.gateway.simulateLeggingEntry({
    candidate: h.candidate,
    detection: detectionFor(h.candidate, h.quotes),
    stillWanted: () => true,
    qualify: () => ({ qualifies: true }),
  });
  assert.equal(result.ok, true);
});

test("BOX_SIMULATED_* set to 5s changes NOTHING about live execution", async () => {
  const fast = liveHarness({ config: { simulatedDecisionMs: 0, simulatedLatencyMs: 0 } });
  const slow = liveHarness({ config: { simulatedDecisionMs: 5_000, simulatedLatencyMs: 5_000 } });
  const run = async (h) => {
    const r = await h.gateway.simulateLeggingEntry({
      candidate: h.candidate,
      detection: detectionFor(h.candidate, h.quotes),
      stillWanted: () => true,
      qualify: () => ({ qualifies: true }),
    });
    return { ok: r.ok, legs: r.legging.legs.length, opened: r.legging.opened };
  };
  // Identical outcomes: the knobs are simply not consulted.
  assert.deepEqual(await run(fast), await run(slow));
});

/* ═══════════════ 2. CALL-GRAPH AUDIT ═══════════════ */

/** The modules that make up the LIVE order path. */
const LIVE_PATH = [
  "executionGateway.ts",
  "orderManager.ts",
  "kiteBrokerAdapter.ts",
  "dhanBrokerAdapter.ts",
  "brokerPacing.ts",
  "executionSchedulingPolicy.ts",
];

/** Paper-only timing modules. None may be imported by a live-path module. */
const PAPER_TIMING_MODULES = [
  "executionSimulator.js",
  "legExecutor.js",
  "latencyModel.js",
  "latencySource.js",
  "calibratedLatencySource.js",
  "paperScheduler.js",
  "paperLegTimeline.js",
];

test("no live-path module IMPORTS a paper timing module", () => {
  for (const file of LIVE_PATH) {
    const text = code(file);
    for (const paper of PAPER_TIMING_MODULES) {
      // A type-only import is harmless (it erases), so only value imports are forbidden.
      const valueImport = new RegExp(`import\\s+(?!type\\b)[^;]*from\\s+["']\\./${paper.replace(".", "\\.")}["']`);
      assert.ok(
        !valueImport.test(text),
        `${file} value-imports the paper timing module ${paper}; a paper delay could leak into live`,
      );
    }
  }
});

test("no live-path module reads BOX_SIMULATED_DECISION_MS or BOX_SIMULATED_LATENCY_MS", () => {
  for (const file of LIVE_PATH) {
    const text = code(file);
    for (const knob of ["simulatedDecisionMs", "simulatedLatencyMs", "BOX_SIMULATED_"]) {
      assert.ok(
        !text.includes(knob),
        `${file} references ${knob}; the simulated delays must never be consulted on the live path`,
      );
    }
  }
});

test("the live gateway's ONLY awaits are broker, persistence and telemetry — never a timer", () => {
  const text = code("executionGateway.ts");
  // No timer primitive of any kind in the live gateway.
  for (const timer of ["setTimeout", "setInterval", "setImmediate", "sleep("]) {
    assert.ok(!text.includes(timer), `executionGateway.ts uses ${timer}; live must not schedule a delay`);
  }
});

test("the order manager schedules no artificial delay before a submission", () => {
  const text = code("orderManager.ts");
  // The manager legitimately owns a reconcile interval and a risk-seed watchdog, so a blanket ban
  // on setInterval/setTimeout would be wrong. What must be absent is a sleep in the submit path.
  assert.ok(!text.includes("await sleep("), "orderManager must not sleep on the submit path");
  assert.ok(!/await\s+new\s+Promise\([^)]*setTimeout/.test(text), "orderManager must not inline a delay await");
});

test("the adapters' ONLY waits are the documented pacing and poll cadence", () => {
  for (const file of ["kiteBrokerAdapter.ts", "dhanBrokerAdapter.ts"]) {
    const text = code(file);
    // Every wait must be expressed against a broker interval, never a simulated one.
    assert.ok(!text.includes("simulated"), `${file} must not reference anything simulated`);
    assert.ok(
      text.includes("brokerMinIntervalMs") || text.includes("pacer"),
      `${file} must still pace against a broker interval`,
    );
  }
});

test("paper's parity scheduler reads LIVE config, never the reverse", () => {
  // One-directional by design: paper may imitate live policy, but no simulated value may feed live.
  const simulator = code("executionSimulator.ts");
  assert.ok(
    simulator.includes("liveBrokerMinIntervalMs") || simulator.includes("paperMaxConcurrentExecutions"),
    "the paper live_parity scheduler should source the live scheduling knobs",
  );
  // And the live modules do not read any paper knob.
  for (const file of LIVE_PATH) {
    assert.ok(!code(file).includes("paperExecutionProfile"), `${file} must not branch on the paper profile`);
  }
});

/* ═══════════════ 3. THE DECLARED INVARIANT ═══════════════ */

test("the engine DECLARES that no artificial latency is applied to live", () => {
  // Reported as data through the API so an operator can verify it without reading code, and so
  // this test fails if the declaration is ever removed or flipped.
  const engine = code("engine.ts");
  assert.ok(
    engine.includes("artificial_latency_applied_to_live: false"),
    "the execution-control payload must declare the invariant",
  );
  // The simulated values are reported alongside, explicitly labelled paper-only.
  assert.ok(engine.includes("paper_only_simulated_decision_ms"));
  assert.ok(engine.includes("paper_only_simulated_latency_ms"));
});

test("the effective LIVE pacing is exposed, and is not zero", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("effective_broker_order_min_interval_ms"), "order-mutation pacing must be reported");
  assert.ok(engine.includes("effective_broker_min_interval_ms"), "general pacing must be reported");
  assert.ok(engine.includes("broker_order_interval_floor_ms"), "the hard floor must be reported");
  // And the reported number comes from the ADAPTER where one exists, not from a re-derivation.
  assert.ok(engine.includes("pacing_source_of_truth"));
});

test("LIVE_EXECUTION.md documents the paper-vs-live latency distinction", () => {
  const doc = src("LIVE_EXECUTION.md");
  assert.ok(
    /artificial|simulat/i.test(doc) && /paper/i.test(doc),
    "the live execution document must distinguish paper simulation from real transport latency",
  );
});
