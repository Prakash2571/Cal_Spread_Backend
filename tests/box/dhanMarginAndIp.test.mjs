/**
 * Dhan multi-order basket margin, and API-verified static-IP readiness.
 *
 * TWO CORRECTNESS CLAIMS UNDER TEST
 *
 * 1. A four-leg box is margined as a BASKET. The offsetting legs earn a hedge benefit
 *    that is most of the point of the structure, so the multi-order calculator must be
 *    preferred and the per-leg sum must only ever be a labelled fallback. Critically,
 *    a FAILED multi call must never produce an UNDERSTATED figure — the direction of
 *    the error is what matters.
 *
 * 2. Static-IP readiness must be evidence-based. Dhan exposes its whitelist, so a
 *    configured server IP is verified against it rather than trusted from a boolean,
 *    and every unverified state fails closed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveBrokerManager } from "../../dist/brokers/registry.js";
import { normalizeDhanMultiMargin } from "../../dist/brokers/dhan/client.js";

/* ------------------------- multi-margin normalization ---------------------- */

test("a hedge-adjusted total is read from any of Dhan's spellings", () => {
  for (const key of ["totalMargin", "totalMarginRequired", "total_margin"]) {
    const out = normalizeDhanMultiMargin({ [key]: 41_250 });
    assert.ok(out, `${key} was not recognised`);
    assert.equal(out.total, 41_250);
  }
});

test("span, exposure, F&O and hedge benefit are preserved when present", () => {
  const out = normalizeDhanMultiMargin({
    totalMargin: 41_250,
    spanMargin: 30_000,
    exposureMargin: 11_250,
    foMargin: 41_250,
    marginBenefit: 158_750,
  });
  assert.equal(out.span, 30_000);
  assert.equal(out.exposure, 11_250);
  assert.equal(out.foMargin, 41_250);
  assert.equal(out.hedgeBenefit, 158_750, "the benefit is the whole reason to use this call");
});

test("a payload wrapped in `data` is unwrapped", () => {
  const out = normalizeDhanMultiMargin({ data: { totalMargin: 1234 } });
  assert.ok(out);
  assert.equal(out.total, 1234);
});

test("an UNREADABLE total returns null, so the caller falls back rather than recording zero", () => {
  // This is the important negative case: treating an unreadable response as
  // "no margin required" would understate the figure.
  assert.equal(normalizeDhanMultiMargin({}), null);
  assert.equal(normalizeDhanMultiMargin(null), null);
  assert.equal(normalizeDhanMultiMargin(undefined), null);
  assert.equal(normalizeDhanMultiMargin({ totalMargin: "abc" }), null);
});

test("a zero or negative total is NOT a credible four-leg requirement", () => {
  // Accepting 0 here would silently mark a real box as margin-free.
  assert.equal(normalizeDhanMultiMargin({ totalMargin: 0 }), null);
  assert.equal(normalizeDhanMultiMargin({ totalMargin: -5 }), null);
});

/* ---------------------------- the basket margin ---------------------------- */

const BOX_ORDERS = [
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2500CE", transaction_type: "BUY", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 50 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2520CE", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 30 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2520PE", transaction_type: "BUY", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 40 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2500PE", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 20 },
];

/**
 * A manager whose Dhan instrument store already resolves the four box legs, with the
 * Dhan client stubbed so the margin calls are observable.
 */
function marginManager({ multi, perLeg } = {}) {
  const calls = { multi: 0, perLeg: 0, multiLegs: null };
  const m = new ActiveBrokerManager({
    kite: {
      getAccessToken: () => "k",
      getApiKey: () => "k",
      getQuoteFull: async () => [],
      getBasketMargin: async () => ({ initial: 1, final: 2, total: 2 }),
    },
    tickerHub: {
      isConnected: () => true, subscribedCount: () => 0, subscribeTokens: () => {},
      unsubscribeTokens: () => {}, stop: () => {}, seed: () => {}, retain: () => () => {},
      addTickListener: () => () => {}, addConnectionListener: () => () => {},
      ingestExternalTicks: () => {}, setExternalConnected: () => {},
    },
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-03",
    onDhanTicks: () => {},
  });

  // Seed the instrument store so every leg resolves to a Dhan security id.
  const store = m.dhanInstrumentStore;
  store.load = async () => [];
  const instruments = BOX_ORDERS.map((o, i) => ({
    exchange: "NFO",
    tradingsymbol: o.tradingsymbol,
    dhan_segment: "NSE_FNO",
    dhan_security_id: 45000 + i,
    instrument_token: 2_000_045_000 + i,
  }));
  Object.defineProperty(store, "instruments", { get: () => instruments, configurable: true });

  // Stub the Dhan client.
  const client = m.dhan;
  client.calculateMultiMargin = async (legs) => {
    calls.multi++;
    calls.multiLegs = legs;
    if (typeof multi === "function") return multi(legs);
    if (multi === "throw") throw new Error("multi endpoint unavailable");
    return multi ?? { totalMargin: 41_250, spanMargin: 30_000, exposureMargin: 11_250, marginBenefit: 158_750 };
  };
  client.calculateMargin = async () => {
    calls.perLeg++;
    if (perLeg === "throw") throw new Error("per-leg unavailable");
    return perLeg ?? { totalMargin: 50_000, spanMargin: 40_000 };
  };
  return { m, calls };
}

/** Force Dhan active without going through the guarded switch. */
function activateDhan(m) {
  Object.defineProperty(m, "active", { value: "dhan", writable: true, configurable: true });
}

test("the MULTI-ORDER endpoint is preferred over per-leg margins", async () => {
  const { m, calls } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.multi, 1);
  assert.equal(calls.perLeg, 0, "per-leg must not be called when multi succeeds");
  assert.equal(res.source, "dhan_multi");
});

test("all FOUR box legs are sent in one request", async () => {
  // Margining a subset would understate the requirement: the hedge benefit of three
  // legs is not the hedge benefit of four.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.multiLegs.length, 4);
});

test("BUY/SELL direction is preserved per leg", async () => {
  // Sending them one-directionally would defeat the hedge recognition entirely.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS);
  assert.deepEqual(
    calls.multiLegs.map((l) => l.transactionType),
    ["BUY", "SELL", "BUY", "SELL"],
  );
});

test("the MARGIN (carry-forward) product is used, never INTRADAY", async () => {
  // INTRADAY is margined differently AND auto-squared-off.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS);
  assert.ok(calls.multiLegs.every((l) => l.productType === "MARGIN"));
  assert.ok(calls.multiLegs.every((l) => l.exchangeSegment === "NSE_FNO"));
  assert.ok(calls.multiLegs.every((l) => l.quantity === 275));
  assert.ok(calls.multiLegs.every((l) => l.price > 0));
});

test("the hedge-adjusted total is returned, with span/exposure/benefit preserved", async () => {
  const { m } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.total, 41_250, "the hedge-adjusted basket figure");
  assert.equal(res.span, 30_000);
  assert.equal(res.exposure, 11_250);
  assert.equal(res.hedge_benefit, 158_750);
});

test("the multi total is used even though it is FAR below the per-leg sum", async () => {
  // Per-leg would report 4 x 50,000 = 200,000 against a true basket requirement of
  // 41,250. Summing standalone margins is exactly the ~5x over-statement this fixes.
  const { m } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.ok(res.total < 200_000);
  assert.equal(res.source, "dhan_multi");
});

test("a FAILED multi call falls back to the per-leg sum, clearly labelled", async () => {
  const { m, calls } = marginManager({ multi: "throw" });
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.multi, 1);
  assert.equal(calls.perLeg, 4, "every leg was priced individually");
  assert.equal(res.source, "dhan_per_leg_fallback");
  assert.equal(res.hedge_benefit, null, "no benefit is recognised in this path");
});

test("the fallback is CONSERVATIVE — it can never understate the requirement", async () => {
  // The whole safety property: a broken multi endpoint must err high, not low.
  const { m } = marginManager({ multi: "throw" });
  activateDhan(m);
  const fallback = await m.margins().basketMargin(BOX_ORDERS);

  const { m: m2 } = marginManager();
  activateDhan(m2);
  const hedged = await m2.margins().basketMargin(BOX_ORDERS);

  assert.ok(
    fallback.total >= hedged.total,
    `fallback ${fallback.total} must be >= hedge-adjusted ${hedged.total}`,
  );
  assert.equal(fallback.total, 200_000);
});

test("an unreadable multi response falls back rather than recording zero", async () => {
  const { m, calls } = marginManager({ multi: {} });
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.perLeg, 4);
  assert.equal(res.source, "dhan_per_leg_fallback");
  assert.ok(res.total > 0, "a failed multi API must not produce an understated value");
});

test("when NOTHING can be priced the result is `unavailable`, not zero margin", async () => {
  // Reported as unknown so the dashboard counts it separately instead of treating the
  // box as margin-free.
  const { m } = marginManager({ multi: "throw", perLeg: "throw" });
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.source, "unavailable");
  assert.equal(res.total, 0);
});

test("Zerodha still uses its own basket API, labelled kite_basket", async () => {
  const { m, calls } = marginManager();
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.source, "kite_basket");
  assert.equal(calls.multi, 0, "no Dhan call while Zerodha is active");
});

/* ------------------------------- static IP -------------------------------- */

/**
 * Run `fn` with a controlled Dhan environment, then restore it.
 *
 * MUST await inside the try. `try { return fn() } finally { restore() }` restores the
 * environment the instant `fn()` returns its promise — while the async body is still
 * running — so the body would observe the original env and every assertion would be
 * meaningless.
 */
async function ipEnv(values, fn) {
  const keys = ["DHAN_STATIC_IP_EXPECTED", "DHAN_STATIC_PUBLIC_IP", "DHAN_LIVE_TRADING_ENABLED"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function ipManager(getStaticIp) {
  const { m } = marginManager();
  activateDhan(m);
  // A live session, so verification is attempted rather than short-circuited.
  Object.defineProperty(m, "dhanAccessToken", { value: "tok", writable: true, configurable: true });
  Object.defineProperty(m, "dhanTokenExpiry", { value: null, writable: true, configurable: true });
  if (getStaticIp) m.dhan.getStaticIp = getStaticIp;
  return m;
}

test("with NO configured IP, readiness falls back to the manual declaration", async () => {
  await ipEnv({ DHAN_STATIC_IP_EXPECTED: "true" }, async () => {
    const m = ipManager();
    assert.equal(m.dhanStaticIpReady(), true);
    const state = m.dhanStaticIpState();
    assert.equal(state.configured_ip, null);
    assert.equal(state.declared, true);
  });
});

test("with nothing configured at all, it FAILS CLOSED", async () => {
  await ipEnv({}, async () => {
    const m = ipManager();
    assert.equal(m.dhanStaticIpReady(), false);
    assert.equal(m.healthFor("dhan").trading_ready, false);
  });
});

test("a configured IP that MATCHES Dhan's primary verifies and becomes ready", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "203.0.113.7", secondaryIP: "" }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, true);
    assert.equal(m.dhanStaticIpReady(), true);
    assert.equal(m.dhanStaticIpState().api_verified, true);
  });
});

test("a configured IP matching the SECONDARY also verifies", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.9" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "198.51.100.1", secondaryIP: "203.0.113.9" }));
    assert.equal((await m.verifyDhanStaticIp()).verified, true);
    assert.equal(m.dhanStaticIpReady(), true);
  });
});

test("a MISMATCHED IP blocks trading and names both sides", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "198.51.100.1", secondaryIP: "198.51.100.2" }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.equal(m.dhanStaticIpReady(), false);
    assert.match(result.error, /203\.0\.113\.7/);
    assert.match(result.error, /198\.51\.100\.1/);
    assert.equal(m.healthFor("dhan").trading_ready, false);
  });
});

test("a configured IP that has NOT been verified yet is NOT ready", async () => {
  // null (never checked) must fail closed — the boolean alone is not enough once an
  // IP has been configured for verification.
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7", DHAN_STATIC_IP_EXPECTED: "true" }, async () => {
    const m = ipManager();
    assert.equal(m.dhanStaticIpState().api_verified, null);
    assert.equal(m.dhanStaticIpReady(), false);
  });
});

test("an UNREACHABLE verification call fails closed", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const m = ipManager(async () => {
      throw new Error("network down");
    });
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.equal(m.dhanStaticIpReady(), false);
    assert.match(result.error, /verification failed/i);
  });
});

test("verification without a Dhan session fails closed", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const { m } = marginManager();
    activateDhan(m);
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.match(result.error, /without a Dhan session/);
  });
});

test("the manual flag remains an override that can still BLOCK a verified IP", async () => {
  // API evidence supersedes a declaration for permitting, but an explicit false is
  // still an operator kill switch.
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7", DHAN_STATIC_IP_EXPECTED: "false" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "203.0.113.7" }));
    await m.verifyDhanStaticIp();
    assert.equal(m.dhanStaticIpReady(), false, "explicit false still blocks");
  });
});

test("readiness on the manual flag alone is reported as weaker evidence", async () => {
  await ipEnv({ DHAN_STATIC_IP_EXPECTED: "true", DHAN_LIVE_TRADING_ENABLED: "true" }, async () => {
    const m = ipManager();
    const problems = m.healthFor("dhan").problems;
    assert.ok(
      problems.some((p) => /DHAN_STATIC_PUBLIC_IP/.test(p)),
      `expected a note recommending API verification, got: ${problems.join(" | ")}`,
    );
  });
});
