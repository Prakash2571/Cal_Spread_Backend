/**
 * The shared paper liquidity reservation ledger.
 *
 * The property that matters: two concurrent paper Box attempts must not both consume the
 * same displayed depth from ONE observed book, but a genuinely new book version is fresh
 * liquidity and reservations against the old version must not suppress it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PaperLiquidityLedger } from "../../dist/box/liquidityLedger.js";

const GEN = 1;
const TOKEN = 12345;

test("a fresh level shows the full effective quantity", () => {
  const l = new PaperLiquidityLedger();
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 70);
});

test("two attempts on the SAME book version cannot double-consume a level", () => {
  // Displayed 75, walked to effective 70. Box A takes 70; Box B must see 0 left.
  const l = new PaperLiquidityLedger();
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 70);
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 70); // Box A fills 70
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 0, "Box B sees nothing left");
});

test("a partial reservation leaves the remainder for the next attempt", () => {
  const l = new PaperLiquidityLedger();
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 45); // Box A takes 45 of 70
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 25, "25 remains for Box B");
});

test("reservations accumulate on the same version", () => {
  const l = new PaperLiquidityLedger();
  assert.equal(l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 30), 30);
  assert.equal(l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 20), 50);
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 20);
});

test("a NEW book version is fresh liquidity — old reservations do not carry over", () => {
  // The crucial correctness point from the spec.
  const l = new PaperLiquidityLedger();
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 70); // fully consumed on version 7
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 0, "v7 is spent");
  assert.equal(
    l.availableAt(GEN, TOKEN, "BUY", 100.1, 8, 70),
    70,
    "v8 is a freshly published book — full depth again",
  );
});

test("a reservation against a SUPERSEDED version is ignored, not applied to current", () => {
  const l = new PaperLiquidityLedger();
  l.reserve(GEN, TOKEN, "BUY", 100.1, 8, 40); // current is v8
  assert.equal(l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 30), 0, "late v7 reserve is a no-op");
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 8, 70), 30, "v8 untouched by the stale reserve");
});

test("levels are independent: price, side and token do not cross-contaminate", () => {
  const l = new PaperLiquidityLedger();
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 70);
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.15, 7, 70), 70, "different price is separate");
  assert.equal(l.availableAt(GEN, TOKEN, "SELL", 100.1, 7, 70), 70, "different side is separate");
  assert.equal(l.availableAt(GEN, 999, "BUY", 100.1, 7, 70), 70, "different token is separate");
});

test("price is bucketed to paise so float noise maps to one level", () => {
  const l = new PaperLiquidityLedger();
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 40);
  assert.equal(
    l.availableAt(GEN, TOKEN, "BUY", 100.10000001, 7, 70),
    30,
    "100.10000001 is the same level as 100.10",
  );
});

test("a different generation is fully independent, and clearGeneration wipes only its own", () => {
  const l = new PaperLiquidityLedger();
  l.reserve(1, TOKEN, "BUY", 100.1, 7, 70);
  l.reserve(2, TOKEN, "BUY", 100.1, 7, 70);
  assert.equal(l.availableAt(2, TOKEN, "BUY", 100.1, 7, 70), 0);
  l.clearGeneration(1);
  assert.equal(l.availableAt(1, TOKEN, "BUY", 100.1, 7, 70), 70, "gen 1 wiped");
  assert.equal(l.availableAt(2, TOKEN, "BUY", 100.1, 7, 70), 0, "gen 2 intact");
});

test("zero / negative reserve is a no-op", () => {
  const l = new PaperLiquidityLedger();
  assert.equal(l.reserve(GEN, TOKEN, "BUY", 100.1, 7, 0), 0);
  assert.equal(l.reserve(GEN, TOKEN, "BUY", 100.1, 7, -5), 0);
  assert.equal(l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, 70), 70);
});

test("memory is bounded: the series map cannot grow past maxSeries", () => {
  const l = new PaperLiquidityLedger({ maxSeries: 10 });
  for (let i = 0; i < 500; i++) l.reserve(GEN, i, "BUY", 100.1, 1, 5);
  assert.ok(l.size <= 10, `ledger held ${l.size} entries, cap is 10`);
});

test("a full two-box contention sequence resolves deterministically", () => {
  // Box A and Box B both want 75 of the same leg; displayed→effective is 70.
  const l = new PaperLiquidityLedger();
  const effective = 70;
  const wantA = 75;
  const wantB = 75;

  const availA = l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, effective);
  const fillA = Math.min(wantA, availA);
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, fillA);

  const availB = l.availableAt(GEN, TOKEN, "BUY", 100.1, 7, effective);
  const fillB = Math.min(wantB, availB);
  l.reserve(GEN, TOKEN, "BUY", 100.1, 7, fillB);

  assert.equal(fillA, 70, "A takes all effective depth");
  assert.equal(fillB, 0, "B gets nothing from the same book");
  assert.ok(fillA + fillB <= effective, "combined fills never exceed displayed effective depth");
});
