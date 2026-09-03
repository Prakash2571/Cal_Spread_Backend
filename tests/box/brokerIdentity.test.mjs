/**
 * Broker identity and its backwards-compatibility contract.
 *
 * The central claim under test: a record written before broker identity existed
 * must keep loading, and must read as Zerodha — because Zerodha was the only
 * broker the application ever had. If that ever regresses, every historical trade
 * silently changes venue, so it is asserted rather than assumed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_IDS,
  LEGACY_BROKER,
  brokerLabel,
  brokerOf,
  isBrokerId,
  parseBrokerId,
} from "../../dist/brokers/types.js";
import { serializeBoxTrade } from "../../dist/box/serialize.js";

/** The minimum shape serializeBoxTrade needs, so these stay pure unit tests. */
function tradeDoc(overrides = {}) {
  return {
    _id: { toString: () => "6512f0a0a0a0a0a0a0a0a0a0" },
    execution_mode: "paper_latency",
    underlying: "ASTRAL",
    name: "Astral Ltd",
    is_index: false,
    expiry: "2026-09-29",
    direction: "LONG_BOX",
    lower_strike: 2500,
    upper_strike: 2520,
    lot_size: 275,
    quantity: 275,
    status: "open",
    legs: [],
    box_width: 20,
    entry_box_cost: 4613,
    entry_gross_edge: 388,
    estimated_exit_charges: null,
    safety_buffer: 150,
    entry_net_edge: 155,
    opened_at: new Date("2026-09-03T04:00:00.000Z"),
    current_remaining_edge: 388,
    exit_box_value: null,
    exit_charges: null,
    gross_pnl: null,
    total_charges: null,
    net_pnl: null,
    closed_at: null,
    exit_reason: null,
    exit_blocked_reason: null,
    expiry_safety: false,
    scanner_config_snapshot: {},
    error: null,
    ...overrides,
  };
}

test("the broker id set is exactly zerodha and dhan", () => {
  assert.deepEqual([...BROKER_IDS], ["zerodha", "dhan"]);
});

test("the legacy broker is zerodha", () => {
  // Not a stylistic default: it is a statement of historical fact about every
  // document written before this field existed.
  assert.equal(LEGACY_BROKER, "zerodha");
});

test("brokerOf resolves an absent, null or unknown broker to zerodha", () => {
  assert.equal(brokerOf({}), "zerodha", "absent field");
  assert.equal(brokerOf({ broker: null }), "zerodha", "explicit null");
  assert.equal(brokerOf({ broker: undefined }), "zerodha");
  assert.equal(brokerOf(null), "zerodha", "no record at all");
  assert.equal(brokerOf(undefined), "zerodha");
  assert.equal(brokerOf({ broker: "upstox" }), "zerodha", "unrecognised value");
});

test("brokerOf preserves an explicitly recorded broker", () => {
  assert.equal(brokerOf({ broker: "dhan" }), "dhan");
  assert.equal(brokerOf({ broker: "zerodha" }), "zerodha");
});

test("isBrokerId accepts only the two known ids", () => {
  assert.equal(isBrokerId("zerodha"), true);
  assert.equal(isBrokerId("dhan"), true);
  assert.equal(isBrokerId("DHAN"), false, "case-sensitive by design");
  assert.equal(isBrokerId(""), false);
  assert.equal(isBrokerId(undefined), false);
  assert.equal(isBrokerId(null), false);
  assert.equal(isBrokerId(1), false);
});

test("parseBrokerId returns null for unknown input rather than defaulting", () => {
  // A request meant for Dhan must never quietly become a Zerodha request, so an
  // unrecognised value has to be rejectable (HTTP 400) by the caller.
  assert.equal(parseBrokerId("dhan"), "dhan");
  assert.equal(parseBrokerId("  Dhan  "), "dhan", "trimmed and lowercased");
  assert.equal(parseBrokerId("ZERODHA"), "zerodha");
  assert.equal(parseBrokerId("upstox"), null);
  assert.equal(parseBrokerId(""), null);
  assert.equal(parseBrokerId(undefined), null);
  assert.equal(parseBrokerId(null), null);
  assert.equal(parseBrokerId(7), null);
});

test("brokerLabel gives the compact badge text the UI shows", () => {
  assert.equal(brokerLabel("dhan"), "DHAN");
  assert.equal(brokerLabel("zerodha"), "ZERODHA");
});

test("serializeBoxTrade stamps a legacy document as zerodha", () => {
  const out = serializeBoxTrade(tradeDoc());
  assert.equal(out.broker, "zerodha");
});

test("serializeBoxTrade preserves an explicit dhan broker", () => {
  const out = serializeBoxTrade(tradeDoc({ broker: "dhan" }));
  assert.equal(out.broker, "dhan");
});

test("serializeBoxTrade still reports execution_mode independently of broker", () => {
  // The two are orthogonal: paper/live says how the fill was produced, broker says
  // whose feed and fee schedule produced it. Neither implies the other.
  const dhanPaper = serializeBoxTrade(tradeDoc({ broker: "dhan", execution_mode: "paper_legging" }));
  assert.equal(dhanPaper.broker, "dhan");
  assert.equal(dhanPaper.execution_mode, "paper_legging");

  const zerodhaLive = serializeBoxTrade(tradeDoc({ broker: "zerodha", execution_mode: "live" }));
  assert.equal(zerodhaLive.broker, "zerodha");
  assert.equal(zerodhaLive.execution_mode, "live");
});
