/**
 * A TECHNICAL FAULT IS NOT A MARKET OUTCOME.
 *
 * The parent-entry path collapsed every thrown error into one label:
 *
 *     catch (err) { console.warn(...); finish("FAILED", "internal_error", ...) }
 *
 * so the dashboard could report that something broke N times and nothing else. A Mongo outage, an
 * unreachable durable-reservation authority, a missing live order manager and a genuine
 * programming bug were one indistinguishable bucket. Worse, the catch called neither
 * `recordExecutionFailure` nor `logRejection`, so a technical fault was invisible in the scanner
 * stats AND in the trade-event ledger — it existed only as that one counter.
 *
 * The opposite mistake is equally bad and is explicitly NOT what these tests allow: exposing
 * `error.message` as the label. Exception text is unbounded, so it would turn a counter into an
 * unbounded label space and leak candidate keys and symbols into telemetry.
 *
 * These tests therefore pin three things:
 *   1. the taxonomy is CLOSED and small, and classification is driven by the pipeline STAGE;
 *   2. a real throw from the real scanner produces a real class — never `edge_disappeared`,
 *      never a liquidity or fees rejection, and never an unbounded label;
 *   3. the detail an operator needs is retained in a BOUNDED store, and the identifying fields
 *      never reach the HTTP surface.
 *
 * Pure and offline.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_PARENT_ATTEMPT_REASONS,
  EXECUTION_FAULT_CLASSES,
  EXECUTION_STAGES,
  ExecutionFaultLog,
  classifyExecutionFault,
  faultErrorType,
  faultMessage,
  isBoxParentAttemptReason,
  isExecutionFaultClass,
} from "../../dist/box/executionFaults.js";
import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { GOOD_BOX, cfg, chargeStub, goodCandidate, localChargesStub, quotesFor } from "./helpers.mjs";

/* ══════════════════ 1. the taxonomy is closed and small ══════════════════ */

test("F1: the fault taxonomy is a small CLOSED set — the whole point is bounded cardinality", () => {
  assert.ok(EXECUTION_FAULT_CLASSES.length >= 8, "it must actually distinguish subsystems");
  assert.ok(
    EXECUTION_FAULT_CLASSES.length <= 12,
    `a taxonomy nobody can reason about is barely better than internal_error (got ${EXECUTION_FAULT_CLASSES.length})`,
  );
  assert.equal(new Set(EXECUTION_FAULT_CLASSES).size, EXECUTION_FAULT_CLASSES.length, "no duplicates");
  for (const cls of EXECUTION_FAULT_CLASSES) {
    assert.equal(typeof cls, "string");
    assert.equal(isExecutionFaultClass(cls), true);
  }
  assert.equal(isExecutionFaultClass("edge_disappeared"), false, "a market outcome is not a fault class");
  assert.equal(isExecutionFaultClass("something the broker said"), false);

  // The classes the brief requires, present by name.
  for (const required of [
    "reservation_error",
    "reservation_authority_unavailable",
    "execution_gateway_error",
    "execution_simulator_error",
    "execution_invariant_error",
    "trade_persistence_error",
    "position_book_error",
    "charge_calculation_error",
    "broker_state_error",
    "unknown_internal_error",
  ]) {
    assert.ok(EXECUTION_FAULT_CLASSES.includes(required), `${required} must exist`);
  }
});

test("F2: the parent-attempt label space is closed, and MARKET outcomes stay separate from FAULTS", () => {
  // Market outcomes remain valid labels — they are how the strategy is judged.
  for (const market of ["edge_disappeared", "insufficient_quantity", "missing_book", "below_expected_net_profit"]) {
    assert.equal(isBoxParentAttemptReason(market), true, `${market} is a legitimate market outcome`);
    assert.equal(isExecutionFaultClass(market), false, `${market} must NOT be a fault class`);
  }
  // Faults are valid labels too, but disjoint from the market vocabulary.
  for (const cls of EXECUTION_FAULT_CLASSES) {
    assert.equal(isBoxParentAttemptReason(cls), true);
  }
  // Anything else is refused.
  assert.equal(isBoxParentAttemptReason("Cannot read properties of undefined (reading 'x')"), false);
  assert.equal(isBoxParentAttemptReason("ECONNRESET"), false);
  // `internal_error` survives only as a backwards-compatible label for stored history.
  assert.equal(isBoxParentAttemptReason("internal_error"), true);
  assert.equal(new Set(BOX_PARENT_ATTEMPT_REASONS).size, BOX_PARENT_ATTEMPT_REASONS.length);
});

/* ══════════════════ 2. classification is stage-driven ══════════════════ */

test("F3: the STAGE decides the class — the same error text classifies differently per subsystem", () => {
  const err = new Error("write failed");
  assert.equal(classifyExecutionFault({ stage: "reservation", error: err }), "reservation_error");
  assert.equal(classifyExecutionFault({ stage: "pre_decision", error: err }), "charge_calculation_error");
  assert.equal(classifyExecutionFault({ stage: "final_qualification", error: err }), "charge_calculation_error");
  assert.equal(classifyExecutionFault({ stage: "position_book", error: err }), "position_book_error");
  assert.equal(classifyExecutionFault({ stage: "trade_persistence", error: err }), "trade_persistence_error");
  // Every declared stage must classify to something in the closed set.
  for (const stage of EXECUTION_STAGES) {
    assert.equal(isExecutionFaultClass(classifyExecutionFault({ stage, error: err })), true);
  }
});

test("F4: the durable-authority family is separated from ordinary reservation failure", () => {
  assert.equal(
    classifyExecutionFault({ stage: "reservation", error: new Error("box MongoDB connection is not ready") }),
    "reservation_authority_unavailable",
    "a live entry must fail CLOSED on this class, so it cannot be pooled with a plain refusal",
  );
  assert.equal(
    classifyExecutionFault({ stage: "reservation", error: new Error("MongoDB did not return a fencing token") }),
    "reservation_authority_unavailable",
  );
  assert.equal(
    classifyExecutionFault({ stage: "reservation", error: new Error("box_instrument_reservations is missing the unique index") }),
    "reservation_authority_unavailable",
  );
  assert.equal(
    classifyExecutionFault({ stage: "reservation", error: new Error("all four contracts could not be claimed") }),
    "reservation_error",
    "a genuine claim refusal is not an authority outage",
  );
});

test("F5: within the execution stage, the message legitimately refines the class", () => {
  const at = (message) => classifyExecutionFault({ stage: "execution", error: new Error(message) });
  assert.equal(at("Live execution manager is unavailable; live execution is blocked."), "execution_gateway_error");
  assert.equal(at("broker terminal quantity is uncertain; entry quarantined"), "broker_state_error");
  assert.equal(at("submit timed out"), "broker_state_error");
  assert.equal(at("Existing durable intent requires reconciliation before resubmit."), "broker_state_error");
  assert.equal(at("Box persistence is unavailable; live order intent was not created."), "trade_persistence_error");
  assert.equal(at("execution invariant violation: overfill"), "execution_invariant_error");
  assert.equal(at("MongoDB did not return a server timestamp"), "reservation_authority_unavailable");
});

test("F6: a programming error is never dressed up as a market or infrastructure outcome", () => {
  const bug = new TypeError("Cannot read properties of undefined (reading 'legs')");
  assert.equal(classifyExecutionFault({ stage: "pre_decision", error: bug }), "execution_invariant_error");
  assert.equal(classifyExecutionFault({ stage: "reservation", error: bug }), "execution_invariant_error");
  assert.equal(classifyExecutionFault({ stage: "trade_persistence", error: bug }), "execution_invariant_error");
  assert.equal(
    classifyExecutionFault({ stage: "execution", error: bug }),
    "execution_simulator_error",
    "the paper simulator is result-typed and never throws by design, so a throw there is a modelling bug",
  );
  assert.equal(faultErrorType(bug), "TypeError");
});

test("F7: non-Error throws are handled without throwing again", () => {
  assert.equal(faultMessage("a bare string"), "a bare string");
  assert.equal(faultMessage({ code: 42 }), '{"code":42}');
  assert.equal(faultMessage(undefined), "undefined");
  const circular = {};
  circular.self = circular;
  assert.equal(typeof faultMessage(circular), "string", "a circular value must not crash the classifier");
  assert.equal(isExecutionFaultClass(classifyExecutionFault({ stage: "execution", error: circular })), true);
});

/* ══════════════════ 3. the diagnostic store is bounded and redacted ══════════════════ */

const faultEvent = (over = {}) => ({
  at: 1_000,
  fault_class: "trade_persistence_error",
  stage: "trade_persistence",
  execution_mode: "paper_legging",
  paper_profile: "live_parity",
  broker: "zerodha",
  error_type: "Error",
  message: "mongo down",
  stack: "Error: mongo down\n  at somewhere",
  candidate_key: "NIFTY|2026-09-25|19900|20100",
  reservation_held: true,
  exposure_existed: false,
  reached_broker: null,
  ...over,
});

test("F8: the fault log is bounded on BOTH axes — ring size and closed class keys", () => {
  const log = new ExecutionFaultLog(5);
  for (let i = 0; i < 500; i++) {
    log.record(faultEvent({ at: i, message: `failure ${i}` }));
  }
  assert.equal(log.recent().length, 5, "the ring is capped regardless of traffic");
  assert.equal(log.total, 500, "but the total is still counted honestly");
  assert.equal(log.recent().at(-1).message, "failure 499", "newest last, oldest dropped");

  const counts = log.counts();
  assert.equal(
    Object.keys(counts).length,
    EXECUTION_FAULT_CLASSES.length,
    "counts always carry every class, so a zero reads as a zero rather than as missing data",
  );
  assert.equal(counts.trade_persistence_error, 500);
  assert.equal(counts.unknown_internal_error, 0);
  for (const key of Object.keys(counts)) assert.equal(isExecutionFaultClass(key), true);
});

test("F9: the HTTP view strips the candidate key and stack; the log keeps them for audit", () => {
  const log = new ExecutionFaultLog(10);
  log.record(faultEvent());

  const [audit] = log.recent();
  assert.equal(audit.candidate_key, "NIFTY|2026-09-25|19900|20100", "logs and audit legitimately need it");
  assert.ok(audit.stack.includes("somewhere"));

  const [published] = log.publicRecent();
  assert.equal(published.candidate_key, undefined, "a symbol must never leave through the diagnostics endpoint");
  assert.equal(published.stack, undefined, "nor a stack trace");
  // Everything an operator needs is still there.
  for (const field of [
    "at", "fault_class", "stage", "execution_mode", "paper_profile", "broker",
    "error_type", "message", "reservation_held", "exposure_existed", "reached_broker",
  ]) {
    assert.ok(field in published, `${field} must survive redaction`);
  }
});

test("F10: secrets are redacted and oversized text truncated before storage", () => {
  const log = new ExecutionFaultLog(10);
  const stored = log.record(faultEvent({
    message: `auth failed api_key=SUPERSECRETVALUE and access_token: abcdef123456 ${"x".repeat(2_000)}`,
    stack: `Bearer eyJhbGciOiJIUzI1NiJ9.${"a".repeat(40)}.${"b".repeat(40)}\n${"y".repeat(5_000)}`,
  }));
  assert.ok(!stored.message.includes("SUPERSECRETVALUE"), "a credential must never be stored");
  assert.ok(!stored.message.includes("abcdef123456"));
  assert.ok(stored.message.includes("[redacted]"));
  assert.ok(stored.message.length <= 401, `message must be truncated, got ${stored.message.length}`);
  assert.ok(stored.stack.includes("[redacted-jwt]"), "a JWT-shaped token is redacted");
  assert.ok(stored.stack.length <= 2_001);
});

/* ══════════════════ 4. the real scanner, with a real throw ══════════════════ */

/**
 * The REAL scanner, over the real simulator, with a real throw injected at a chosen stage.
 * Mirrors the harness in `scanner.test.mjs` so the pipeline being exercised is production's.
 */
function harness({ throwFrom } = {}) {
  const { candidate, all } = goodCandidate();
  const conf = cfg({});
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const metrics = new BoxMetrics(conf.metricsWindow);
  const faults = new ExecutionFaultLog(20);
  const events = [];
  const local = localChargesStub({ entryTotal: 150, exitTotal: 150 });

  const executionSim = new BoxExecutionSimulator({
    cfg: conf,
    quotes,
    isMarketOpen: () => true,
    isFeedHealthy: () => true,
    metrics,
  });
  // Faults raised from inside the EXECUTION stage: the durable reservation authority and the
  // broker both live behind the gateway, so this is where those classes really originate.
  const gatewayThrows = {
    authority: "box MongoDB connection is not ready",
    brokerUnknown: "broker terminal quantity is uncertain; entry quarantined",
    gateway: "Live execution manager is unavailable; live execution is blocked.",
  };
  if (throwFrom in gatewayThrows) {
    const message = gatewayThrows[throwFrom];
    executionSim.simulateEntry = async () => { throw new Error(message); };
    executionSim.simulateLeggingEntry = async () => { throw new Error(message); };
  }

  const scanner = new BoxScanner({
    cfg: conf,
    quotes,
    charges: new BoxChargeEstimator(chargeStub({ entryTotal: 150, exitTotal: 150 }).fn, conf),
    localCharges: throwFrom === "charges"
      ? {
          ...local,
          // Thrown from `localDecisionFor`, which used to run OUTSIDE the try.
          totals: () => { throw new Error("rate card unavailable"); },
        }
      : local,
    executionSim,
    positions,
    metrics,
    faults,
    activeBroker: () => "zerodha",
    openPaperTrade: async () => {
      if (throwFrom === "persistence") throw new Error("Box persistence is unavailable; write refused");
      if (throwFrom === "bug") throw new TypeError("Cannot read properties of undefined (reading 'legs')");
      if (throwFrom === "chargeLegs") throw new Error("charge legs could not be priced for this fill");
      return "trade-1";
    },
    onEvent: (event, cand, evaluation, detail) => events.push({ event, key: cand.key, detail }),
  });

  scanner.setCandidatesForUnderlying("NIFTY", all);
  scanner.setMarketOpen(true);
  scanner.setFeedHealthy(true);
  scanner.setDiscovering(true);

  const seedGood = () => {
    const now = Date.now();
    const map = quotesFor(candidate, {}, { at: now });
    for (const [token, q] of map) {
      quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);
    }
    return [...map.keys()];
  };

  return { scanner, quotes, positions, metrics, faults, events, candidate, conf, seedGood };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

async function driveOneEntry(h) {
  h.seedGood();
  h.scanner.onTokensUpdated([h.candidate.legs.k1_ce.token]);
  await settle();
}

test("F11: a durable-persistence throw is classified as trade_persistence_error, NOT as a market outcome", async () => {
  const h = harness({ throwFrom: "persistence" });
  await driveOneEntry(h);

  const snap = h.metrics.snapshot().execution;
  const categories = snap.rejection_categories;
  assert.ok(
    "trade_persistence_error" in categories,
    `expected a real class, got ${JSON.stringify(categories)}`,
  );
  assert.equal("internal_error" in categories, false, "the useless label is no longer produced");
  for (const market of ["edge_disappeared", "insufficient_quantity", "missing_book", "below_expected_net_profit"]) {
    assert.equal(
      market in categories,
      false,
      `a technical fault must never be reported as the market outcome ${market}`,
    );
  }

  // The detail is retained, with the stage.
  const [fault] = h.faults.recent();
  assert.equal(fault.fault_class, "trade_persistence_error");
  assert.equal(fault.stage, "trade_persistence", "the stage is recorded, so the subsystem is identifiable");
  assert.equal(fault.execution_mode, "paper_touch");
  assert.equal(fault.broker, "zerodha");
  assert.equal(fault.candidate_key, h.candidate.key, "the key is kept for audit");
  assert.equal(fault.reached_broker, null, "paper has no broker, so this is null rather than false");
  assert.equal(h.faults.counts().trade_persistence_error, 1);

  // And the fault is no longer invisible in the scanner stats and the ledger.
  assert.ok(h.scanner.getStats().rejectedExecution >= 1, "the scanner counts it");
  assert.ok(h.events.some((e) => e.detail.includes("trade_persistence_error")), "the ledger records it");
  // The reservation is released, so the strike pair is not stranded.
  assert.equal(h.positions.isTaken(h.candidate.key), false);
});

test("F12: faults raised from the EXECUTION stage split into their real subsystems", async () => {
  // The durable reservation authority, the broker and the gateway all live behind the gateway
  // seam, so a single `internal_error` for all three was the least useful possible answer.
  const cases = [
    ["authority", "reservation_authority_unavailable"],
    ["brokerUnknown", "broker_state_error"],
    ["gateway", "execution_gateway_error"],
  ];
  for (const [inject, expected] of cases) {
    const h = harness({ throwFrom: inject });
    await driveOneEntry(h);
    const categories = h.metrics.snapshot().execution.rejection_categories;
    assert.ok(
      expected in categories,
      `injecting ${inject} must report ${expected}, got ${JSON.stringify(categories)}`,
    );
    // Each is a DISTINCT class — the whole point is that they are no longer pooled.
    for (const [, other] of cases) {
      if (other !== expected) {
        assert.equal(other in categories, false, `${expected} must not be pooled with ${other}`);
      }
    }
    assert.equal(h.faults.recent()[0].stage, "execution", "attributed to the subsystem that ran");
    assert.equal(h.positions.isTaken(h.candidate.key), false, "and the reservation is released");
  }
});

test("F13: a programming bug on the entry path is reported as an invariant error", async () => {
  const h = harness({ throwFrom: "bug" });
  await driveOneEntry(h);
  const categories = h.metrics.snapshot().execution.rejection_categories;
  assert.ok(
    "execution_invariant_error" in categories,
    `expected an invariant class, got ${JSON.stringify(categories)}`,
  );
  const [fault] = h.faults.recent();
  assert.equal(fault.error_type, "TypeError", "the exception TYPE is retained, unlike before");
  assert.ok(fault.stack !== null, "and its stack, for the server log");
});

test("F14: a charge-calculator throw on the HOT PATH cannot escape into the tick handler or abort the batch", async () => {
  // `evaluateAndMaybeEnter` is synchronous, runs in a loop over every candidate the tick touched,
  // and calls the charge calculator twice. An escaping error skipped every remaining candidate AND
  // propagated out of `onTokensUpdated` into the WebSocket tick handler, stopping discovery for the
  // whole universe.
  const h = harness({ throwFrom: "charges" });
  h.seedGood();

  assert.doesNotThrow(
    () => h.scanner.onTokensUpdated([h.candidate.legs.k1_ce.token]),
    "one unpriceable candidate must never take down the tick handler",
  );
  await settle();

  const stats = h.scanner.getStats();
  assert.ok(stats.evaluationFaults >= 1, "the fault is counted, not swallowed");
  assert.ok(stats.evaluations >= 1);
  const [fault] = h.faults.recent();
  assert.equal(fault.fault_class, "charge_calculation_error", "and classified by the stage that ran");
  assert.equal(fault.stage, "pre_decision");
  assert.equal(
    h.positions.isTaken(h.candidate.key),
    false,
    "no strike pair may be stranded by a pre-entry fault",
  );

  // Every other candidate the tick touched must still have been evaluated.
  const before = h.scanner.getStats().evaluations;
  h.scanner.refreshAll();
  assert.ok(
    h.scanner.getStats().evaluations > before,
    "a persistent fault must not stop later evaluation passes either",
  );
});

test("F14b: a charge fault INSIDE the entry pipeline terminates the attempt and releases the reservation", async () => {
  const h = harness({ throwFrom: "chargeLegs" });
  await driveOneEntry(h);

  const snap = h.metrics.snapshot().execution;
  assert.ok(
    "charge_calculation_error" in snap.rejection_categories,
    `expected charge_calculation_error, got ${JSON.stringify(snap.rejection_categories)}`,
  );
  assert.equal(
    snap.attempted,
    snap.completed,
    "every started parent attempt must be terminated — a leaked attempt corrupts every rate",
  );
  assert.equal(
    h.positions.isTaken(h.candidate.key),
    false,
    "and the strike pair must be released, not stranded for the rest of the session",
  );

  // A second tick must be able to try again rather than being blocked by an entryInFlight leak.
  await driveOneEntry(h);
  assert.ok(h.metrics.snapshot().execution.attempted >= 2, "the candidate is not permanently in flight");
});

/* ══════════════════ 5. the metric label space cannot be widened at runtime ══════════════════ */

test("F15: an unrecognised label is folded into unknown_internal_error and the drift is counted", () => {
  const metrics = new BoxMetrics(100);
  metrics.beginLogicalAttempt("a1");
  metrics.finishLogicalAttempt("a1", "FAILED", "some unbounded ECONNRESET string from a library");

  const snap = metrics.snapshot().execution;
  assert.equal(
    "some unbounded ECONNRESET string from a library" in snap.rejection_categories,
    false,
    "an arbitrary string must NEVER become a permanent metric label",
  );
  assert.equal(snap.rejection_categories.unknown_internal_error, 1, "it is folded into the honest bucket");
  assert.ok(
    metrics.snapshot().execution.unclassified_rejection_labels >= 1,
    "and the drift itself is visible rather than silent",
  );
});

test("F16: legitimate market reasons still pass through untouched", () => {
  const metrics = new BoxMetrics(100);
  for (const [i, reason] of ["missing_book", "duplicate", "edge_disappeared", "legging_incomplete"].entries()) {
    metrics.beginLogicalAttempt(`a${i}`);
    metrics.finishLogicalAttempt(`a${i}`, "FAILED", reason);
  }
  const categories = metrics.snapshot().execution.rejection_categories;
  assert.deepEqual(
    Object.keys(categories).sort(),
    ["duplicate", "edge_disappeared", "legging_incomplete", "missing_book"],
    "the market vocabulary is unchanged",
  );
  assert.equal(metrics.snapshot().execution.unclassified_rejection_labels, 0);
});
