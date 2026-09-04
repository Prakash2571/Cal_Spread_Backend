/**
 * The Box golden fixtures, replayed against the CURRENT TypeScript implementation.
 *
 * The fixtures in tests/migration-fixtures/box/*.json are language-neutral: the same
 * files will be replayed by the future Go implementation, which must produce identical
 * `expected` values. This test is the other half of that contract — it proves the
 * TypeScript reference still produces exactly what the fixtures record.
 *
 * If one of these fails, it means a pure Box function's output moved. That is a
 * behavioural change to freeze-and-review, NOT something to fix by regenerating the
 * fixtures. Regeneration (tests/migration-fixtures/generate.mjs) is a deliberate act.
 *
 * Everything replayed here is pure and deterministic; nothing touches a broker, a
 * database, a clock or the network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  entrySideFor,
  exitSideFor,
  slippagePerUnit,
  evaluateCandidate,
  projectedNetEdge,
  convergenceThreshold,
  exitNetCreditPerUnit,
} from "../../dist/box/math.js";
import {
  roundToTick,
  computeLimitPrice,
  buildOrderPricing,
  effectiveQty,
} from "../../dist/box/orderPricing.js";
import { calculateBoxCharges, calculateRoundTrip } from "../../dist/box/localCharges.js";
import {
  fullLotByRole,
  isBoxPositionFlat,
  deriveBoxPositionState,
  outstandingRoles,
} from "../../dist/box/positions.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migration-fixtures",
  "box",
);

function loadFixture(file) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
}

/** Deep structural equality with a clear message naming the fixture + case. */
function expectMatch(fixtureName, caseName, actual, expected) {
  assert.deepStrictEqual(
    // Round-trip through JSON so `undefined`, Map, class instances etc. are compared as
    // the fixture would serialise them — exactly what Go will read.
    JSON.parse(JSON.stringify(actual)),
    expected,
    `${fixtureName} / "${caseName}" no longer matches the golden fixture. ` +
      `A pure Box output changed — freeze-and-review, do not regenerate to hide it.`,
  );
}

const FIXED_AT = new Date("2026-09-03T10:00:00.000Z");

function stripAt(charges) {
  const { at, ...rest } = charges;
  return rest;
}

/** Reproduce evalSummary from the generator, so we compare the same projection. */
function evalSummary(ev) {
  return {
    entry_net_debit_per_unit: ev.entry_net_debit_per_unit,
    gross_edge_per_unit: ev.gross_edge_per_unit,
    gross_edge: ev.gross_edge,
    tradable: ev.tradable,
    depth_ok: ev.depth_ok,
    worst_age_ms: ev.worst_age_ms,
    quote_version: ev.quote_version,
    reject: ev.reject,
    legs: ev.legs.map((l) => ({
      role: l.role,
      side: l.side,
      price: l.price,
      qty_at_touch: l.qty_at_touch,
      age_ms: l.age_ms,
      fresh: l.fresh,
      executable: l.executable,
    })),
  };
}

/**
 * Each fixture operation has a replay function that consumes `case.input` and returns
 * the same shape the generator stored in `case.expected`.
 */
const REPLAY = {
  "direction.json": (input) => ({
    entry_side: entrySideFor(input.role, input.direction),
    exit_side: exitSideFor(input.role, input.direction),
  }),

  "slippage.json": (input) => ({
    slippage_per_unit: slippagePerUnit(input.side, input.detected, input.executed),
  }),

  "order-pricing.json": (input, name) => {
    if (name.startsWith("BUY") || name.startsWith("SELL")) {
      const out = {
        limit_price: computeLimitPrice({
          side: input.side,
          referencePrice: input.referencePrice,
          tickSize: input.tickSize,
          maxChaseTicks: input.maxChaseTicks,
        }),
      };
      if (input.side === "BUY" || input.side === "SELL") {
        // The two "bounded limit" cases also stored a full pricing envelope.
        if (name.includes("bounded limit")) {
          out.pricing = buildOrderPricing({
            side: input.side,
            quantity: 50,
            referencePrice: input.referencePrice,
            tickSize: input.tickSize,
            maxChaseTicks: input.maxChaseTicks,
          });
        }
      }
      return out;
    }
    if (name.startsWith("zero chase")) {
      return {
        limit_price: computeLimitPrice({
          side: input.side,
          referencePrice: input.referencePrice,
          tickSize: input.tickSize,
          maxChaseTicks: input.maxChaseTicks,
        }),
      };
    }
    if (name.startsWith("tick rounding")) {
      return { rounded: input.cases.map((c) => roundToTick(c.price, c.tick)) };
    }
    if (name.startsWith("a non-positive tick")) {
      return { rounded: roundToTick(input.price, input.tick) };
    }
    if (name.startsWith("queue haircut")) {
      return {
        effective: input.cases.map((c) => effectiveQty(c.displayed, c.model, c.haircutPct)),
      };
    }
    throw new Error(`unmapped order-pricing case: ${name}`);
  },

  "quotes-and-evaluation.json": (input) => {
    const quotes = new Map(input.quotes.map((q) => [q.token, q]));
    return evalSummary(
      evaluateCandidate({
        candidate: input.candidate,
        quotes,
        now: input.now,
        maxAgeMs: input.maxAgeMs,
      }),
    );
  },

  "candidate-economics.json": (input) => ({
    projected_net_edge: projectedNetEdge(input),
  }),

  "charges.json": (input, name) => {
    if (name.startsWith("four-leg")) {
      return stripAt(calculateBoxCharges(input.orders, input.rates, "kite", "local", FIXED_AT));
    }
    const rt = calculateRoundTrip(input.orders, input.rates, FIXED_AT);
    return {
      entry: stripAt(rt.entry),
      estimated_exit: stripAt(rt.estimated_exit),
      entry_total: rt.entry_total,
      estimated_exit_total: rt.estimated_exit_total,
    };
  },

  "exit-economics.json": (input, name) => {
    if (name.startsWith("net credit") || name.startsWith("an unpriced")) {
      return { exit_net_credit_per_unit: exitNetCreditPerUnit(input.legs) };
    }
    return {
      threshold: convergenceThreshold(input.entryNetEdge, {
        convergenceFloor: input.convergenceFloor,
        convergencePct: input.convergencePct,
      }),
    };
  },

  "position-state.json": (input, name) => {
    if (name.startsWith("fullLotByRole")) return { by_role: fullLotByRole(input.quantity) };
    if (name.includes("sticky") || name.includes("becomes FLAT")) {
      return { state: deriveBoxPositionState(input.remaining_qty_by_role, input.current) };
    }
    return {
      state: deriveBoxPositionState(input.remaining_qty_by_role),
      flat: isBoxPositionFlat(input.remaining_qty_by_role),
      outstanding: outstandingRoles({ remaining_qty_by_role: input.remaining_qty_by_role }),
    };
  },
};

const fixtureFiles = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

test("every fixture file has a replay mapping", () => {
  for (const file of fixtureFiles) {
    assert.ok(REPLAY[file], `no replay function for fixture ${file}`);
  }
});

test("at least the expected fixture coverage exists", () => {
  // Guards against a fixture file silently disappearing.
  const expected = [
    "direction.json",
    "slippage.json",
    "order-pricing.json",
    "quotes-and-evaluation.json",
    "candidate-economics.json",
    "charges.json",
    "exit-economics.json",
    "position-state.json",
  ];
  for (const f of expected) assert.ok(fixtureFiles.includes(f), `missing fixture ${f}`);
});

for (const file of fixtureFiles) {
  const fixture = loadFixture(file);
  const replay = REPLAY[file];
  if (!replay) continue;

  test(`${file}: ${fixture.cases.length} case(s) match the current implementation`, () => {
    assert.ok(fixture.cases.length > 0, `${file} has no cases`);
    for (const c of fixture.cases) {
      const actual = replay(c.input, c.name);
      expectMatch(file, c.name, actual, c.expected);
    }
  });
}
