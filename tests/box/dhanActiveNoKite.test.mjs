/**
 * THE ACCEPTANCE TEST: Dhan active, no Zerodha session, ZERO Kite usage.
 *
 * Every Kite market-data method is replaced with a throw. If any live-runtime path
 * still reaches Zerodha while Dhan owns the runtime, these tests fail loudly instead of
 * the failure showing up in production as `LTP -` with a "Connect to Zerodha" banner —
 * which is exactly how the original bug presented.
 *
 * This is a REGRESSION GUARD, not a happy-path test. Its value is that it fails when
 * someone reintroduces a direct `kite.*` call on a broker-neutral path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveBrokerManager } from "../../dist/brokers/registry.js";
import { InstrumentProvider } from "../../dist/brokers/instrumentProvider.js";
import { QuoteProvider } from "../../dist/brokers/quoteProvider.js";
import { computeFeedHealth } from "../../dist/brokers/feedHealth.js";
import { dhanInternalToken } from "../../dist/brokers/dhan/instruments.js";

const KITE_FORBIDDEN = "KITE MUST NOT BE USED";

/** A Kite client where every market-data method is a landmine. */
function forbiddenKite() {
  return {
    // No Zerodha session at all — the production state under test.
    getAccessToken: () => null,
    hasSession: () => false,
    getApiKey: () => "kite-key",
    getInstruments: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getQuoteFull: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getQuoteOhlc: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getQuoteDepth: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getQuoteLadder: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getHistorical: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getHistoricalFull: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    getBasketMargin: () => {
      throw new Error(KITE_FORBIDDEN);
    },
  };
}

/** A hub that records whether anything tried to open a Kite socket. */
function forbiddenHub(state) {
  return {
    isConnected: () => false,
    subscribedCount: () => 0,
    subscribeTokens: (tokens) => {
      state.kiteSubscribes.push(...tokens);
      throw new Error(KITE_FORBIDDEN);
    },
    unsubscribeTokens: () => {
      throw new Error(KITE_FORBIDDEN);
    },
    stop: () => state.kiteStops.push(1),
    seed: () => {},
    retain: () => () => {},
    addTickListener: () => () => {},
    addConnectionListener: () => () => {},
    ingestExternalTicks: (t) => state.fannedOut.push(...t),
    setExternalConnected: () => {},
    attachClient: () => () => {},
  };
}

/** Four Dhan F&O futures + a spot, in the internal Instrument shape. */
function dhanUniverse() {
  const fut = (i, expiry) => ({
    instrument_token: dhanInternalToken("NSE_FNO", 45000 + i),
    exchange_token: 45000 + i,
    tradingsymbol: `ASTRAL${expiry.replace(/-/g, "")}FUT`,
    name: "ASTRAL",
    last_price: 0,
    expiry,
    strike: 0,
    tick_size: 0.05,
    lot_size: 275,
    instrument_type: "FUT",
    segment: "NFO-FUT",
    exchange: "NFO",
    dhan_security_id: 45000 + i,
    dhan_segment: "NSE_FNO",
    dhan_underlying_security_id: 1512,
  });
  return [
    fut(0, "2026-09-29"),
    fut(1, "2026-10-27"),
    {
      instrument_token: dhanInternalToken("NSE_EQ", 1512),
      exchange_token: 1512,
      tradingsymbol: "ASTRAL",
      name: "ASTRAL",
      last_price: 0,
      expiry: "",
      strike: 0,
      tick_size: 0.05,
      lot_size: 1,
      instrument_type: "EQ",
      segment: "NSE",
      exchange: "NSE",
      dhan_security_id: 1512,
      dhan_segment: "NSE_EQ",
      dhan_underlying_security_id: 1512,
    },
  ];
}

/** A manager with Dhan active, a live Dhan session, and Kite booby-trapped. */
function dhanActive() {
  const state = { kiteSubscribes: [], kiteStops: [], fannedOut: [], dhanSubscribes: [] };
  const kite = forbiddenKite();
  const m = new ActiveBrokerManager({
    kite,
    tickerHub: forbiddenHub(state),
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-03",
    onDhanTicks: (t) => state.fannedOut.push(...t),
  });

  // Dhan is the active broker with a live session.
  Object.defineProperty(m, "active", { value: "dhan", writable: true, configurable: true });
  Object.defineProperty(m, "dhanAccessToken", { value: "tok", writable: true, configurable: true });
  Object.defineProperty(m, "dhanTokenExpiry", { value: null, writable: true, configurable: true });
  Object.defineProperty(m, "dhanSessionMeta", {
    value: { clientId: "C1", clientName: "T", clientUcc: "U", powerOfAttorney: false, loginDay: "2026-09-03", loginAt: Date.now() },
    writable: true,
    configurable: true,
  });

  // Dhan instrument store, preloaded.
  const universe = dhanUniverse();
  const store = m.dhanInstrumentStore;
  store.load = async () => universe;
  Object.defineProperty(store, "instruments", { get: () => universe, configurable: true });
  store.get = (token) => universe.find((i) => i.instrument_token === token);
  store.identify = (token) => {
    const inst = universe.find((i) => i.instrument_token === token);
    return inst ? { segment: inst.dhan_segment, securityId: inst.dhan_security_id } : null;
  };

  // Dhan REST quote.
  m.dhan.marketFeedQuote = async (req) => {
    const segment = Object.keys(req)[0];
    const ids = req[segment];
    const data = {};
    for (const id of ids) {
      data[String(id)] = {
        last_price: 1000 + id,
        ohlc: { open: 1, close: 999 + id, high: 2, low: 0 },
        oi: 5000,
        depth: { buy: [{ price: 999 + id, quantity: 275, orders: 2 }], sell: [{ price: 1001 + id, quantity: 275, orders: 3 }] },
      };
    }
    return { data: { [segment]: data } };
  };

  // Intercept the Dhan feed so no real socket is created.
  const feed = {
    isConnected: () => true,
    subscribedCount: () => state.dhanSubscribes.length,
    feedAgeMs: () => 40,
    subscribeTokens: (t) => state.dhanSubscribes.push(...t),
    unsubscribeTokens: () => {},
    ensureSocket: () => {},
    stop: () => {},
    dispose: () => {},
    feedGeneration: () => 1,
  };
  Object.defineProperty(m, "dhanFeed", { value: feed, writable: true, configurable: true });

  return { m, state, universe, kite };
}

/* ------------------------- the acceptance conditions ----------------------- */

test("active broker is dhan with an authenticated session and NO Kite session", () => {
  const { m, kite } = dhanActive();
  assert.equal(m.activeBroker, "dhan");
  assert.equal(kite.hasSession(), false, "no Zerodha session exists");
  const session = m.sessionFor("dhan");
  assert.equal(session.authenticated, true);
});

test("the instrument universe loads from DHAN, never touching kite.getInstruments", async () => {
  const { m } = dhanActive();
  // Would throw KITE MUST NOT BE USED if it reached Zerodha.
  const rows = await m.instrumentProvider.load(true);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => typeof r.dhan_security_id === "number"));
});

test("board-shaped tokens belong to the DHAN namespace", async () => {
  const { m, universe } = dhanActive();
  await m.instrumentProvider.load(true);
  // Dhan internal tokens fold the segment into the high bits, so they are far above
  // any Kite token and cannot be confused with one.
  for (const inst of universe) {
    assert.equal(inst.instrument_token, dhanInternalToken(inst.dhan_segment, inst.dhan_security_id));
    assert.ok(inst.instrument_token > 1_000_000_000, `${inst.instrument_token} is not a Dhan token`);
  }
});

test("REST quotes come from DHAN and are keyed by the INTERNAL token", async () => {
  const { m, universe } = dhanActive();
  await m.instrumentProvider.load(true);
  const tokens = universe.map((i) => i.instrument_token);

  const ticks = await m.quoteProvider.quotesByToken(tokens);
  assert.equal(ticks.length, 3, "every instrument was quoted");
  // The browser's tick map is keyed by the board's tokens, so returning Dhan's raw
  // security id here would silently match nothing on the page.
  for (const tick of ticks) {
    assert.ok(tokens.includes(tick.token), `${tick.token} is not a board token`);
    assert.ok(tick.last_price > 0, "LTP present");
  }
});

test("Dhan REST quotes carry executable bid/ask depth", async () => {
  // Kite's REST quote has no depth; Dhan's does. The Box liquidity view depends on it.
  const { m, universe } = dhanActive();
  await m.instrumentProvider.load(true);
  const ticks = await m.quoteProvider.quotesByToken([universe[0].instrument_token]);
  assert.ok(ticks[0].bid > 0, "bid present");
  assert.ok(ticks[0].ask > ticks[0].bid, "ask above bid");
});

test("SSE subscriptions reach DHAN and create ZERO Kite subscriptions", () => {
  const { m, state, universe } = dhanActive();
  const release = m.acquireBrowserTokens(universe.map((i) => i.instrument_token));

  assert.deepEqual(state.kiteSubscribes, [], "no Kite subscription was attempted");
  assert.equal(state.dhanSubscribes.length, 3, "all three went to Dhan");
  release();
});

test("the strategy's tokens also route to Dhan only", () => {
  const { m, state, universe } = dhanActive();
  m.setStrategyTokens(universe.map((i) => i.instrument_token));
  assert.deepEqual(state.kiteSubscribes, []);
  assert.equal(state.dhanSubscribes.length, 3);
});

test("browser and strategy SHARE a token without duplicating the upstream subscription", () => {
  const { m, state, universe } = dhanActive();
  const token = universe[0].instrument_token;
  m.setStrategyTokens([token]);
  const before = state.dhanSubscribes.length;
  const release = m.acquireBrowserTokens([token]);
  assert.equal(state.dhanSubscribes.length, before, "no second upstream subscribe");

  // And releasing the browser must not blind the strategy.
  release();
  assert.deepEqual(m.subscriptions.activeTokens(), [token]);
});

test("a KITE token is REJECTED while Dhan is active", async () => {
  // Kite tokens are small integers; a Dhan-active runtime must refuse them rather than
  // guess which instrument was meant.
  const { m } = dhanActive();
  await m.instrumentProvider.load(true);
  assert.equal(m.assertActiveBrokerToken(408065, "test"), false, "a Kite token must be refused");
});

test("a DHAN token is accepted while Dhan is active", async () => {
  const { m, universe } = dhanActive();
  await m.instrumentProvider.load(true);
  assert.equal(m.assertActiveBrokerToken(universe[0].instrument_token, "test"), true);
});

test("token assertion is permissive only while the universe is UNLOADED", () => {
  // "Cannot tell" must not become "reject", or startup would break.
  const { m } = dhanActive();
  assert.equal(m.assertActiveBrokerToken(408065, "test"), true, "unknown universe => allow");
});

test("market data reports ready without any Zerodha session", () => {
  const { m } = dhanActive();
  const provider = m.marketData();
  assert.equal(provider.isAuthenticated(), true, "Dhan session is what matters");
});

test("feed health is LIVE only when connected AND subscribed AND ticking", () => {
  const { m, universe } = dhanActive();
  m.noteTick();
  m.setStrategyTokens(universe.map((i) => i.instrument_token));
  const health = m.feedHealth();
  assert.equal(health.connected, true);
  assert.ok(health.subscribed > 0);
  assert.equal(health.state, "LIVE");
});

test("a connected socket with NOTHING subscribed is not reported as LIVE", () => {
  // The specific lie the old boolean told: Feed=Live while the board showed LTP -.
  const health = computeFeedHealth({
    connected: true,
    authenticated: true,
    subscribed: 0,
    universe: 18_492,
    lastTickAt: null,
  });
  assert.equal(health.state, "CONNECTED_NO_SUBSCRIPTIONS");
  assert.match(health.detail, /nothing is subscribed/);
});

test("createLiveAdapter still refuses a non-active broker", () => {
  const { m } = dhanActive();
  assert.throws(
    () => m.createLiveAdapter({ broker: "zerodha", cfg: {} }),
    /refusing to build a zerodha execution adapter while dhan is the active broker/,
  );
});

/* ---------------------- the reverse invariant (Zerodha) -------------------- */

test("with ZERODHA active, a live Dhan session does NOT drive subscriptions", () => {
  // Symmetry: the inactive broker's session must be inert.
  const state = { kiteSubscribes: [], kiteStops: [], fannedOut: [], dhanSubscribes: [] };
  const hub = {
    ...forbiddenHub(state),
    // Zerodha is legitimately allowed here, so record instead of throwing.
    subscribeTokens: (t) => state.kiteSubscribes.push(...t),
    unsubscribeTokens: () => {},
    isConnected: () => true,
  };
  const m = new ActiveBrokerManager({
    kite: { ...forbiddenKite(), getAccessToken: () => "kite-tok", hasSession: () => true },
    tickerHub: hub,
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-03",
    onDhanTicks: () => {},
  });
  // A Dhan session also exists, but Zerodha is active.
  Object.defineProperty(m, "dhanAccessToken", { value: "dhan-tok", writable: true, configurable: true });
  Object.defineProperty(m, "dhanTokenExpiry", { value: null, writable: true, configurable: true });

  assert.equal(m.activeBroker, "zerodha");
  m.setStrategyTokens([408065, 408321]);
  assert.deepEqual(state.kiteSubscribes.sort((a, b) => a - b), [408065, 408321]);
  assert.equal(state.dhanSubscribes.length, 0, "the inactive Dhan feed stayed idle");
});
