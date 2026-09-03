/**
 * THE SINGLE-ACTIVE-BROKER INVARIANT.
 *
 * The rule under test: exactly one broker owns the feed, the scanner, execution,
 * positions, reconciliation and charges at any instant. Two failure modes matter and
 * both are asserted here:
 *
 *   1. A switch must be REFUSED while exposure exists — otherwise a real position is
 *      left monitored by the wrong feed and reconciled against the wrong order-id
 *      space.
 *   2. When a switch does proceed, the OLD broker must be torn down BEFORE the new
 *      one becomes reachable, so there is no instant when two feeds could both drive
 *      a Box decision and no way for one broker's books to price the other's trade.
 *
 * The manager is driven with stub probes/hooks so the ordering is observable.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveBrokerManager } from "../../dist/brokers/registry.js";

/** A manager with no exposure and both brokers configured. */
function manager(overrides = {}) {
  const events = [];
  const kite = {
    getAccessToken: () => "kite-token",
    getApiKey: () => "kite-key",
    getQuoteFull: async () => [],
    getBasketMargin: async () => ({ initial: 0, final: 0, total: 0 }),
  };
  const tickerHub = {
    isConnected: () => true,
    subscribedCount: () => 0,
    subscribeTokens: () => events.push("kite:subscribe"),
    unsubscribeTokens: () => events.push("kite:unsubscribe"),
    stop: () => events.push("kite:stop"),
    seed: () => {},
    retain: () => () => {},
    addTickListener: () => () => {},
    addConnectionListener: () => () => {},
    ingestExternalTicks: () => {},
    setExternalConnected: () => {},
  };
  const m = new ActiveBrokerManager({
    kite,
    tickerHub,
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-03",
    onDhanTicks: () => {},
    onDhanConnection: () => {},
    onSessionLost: () => {},
    ...overrides,
  });

  const probe = {
    scannerRunning: () => false,
    openPositionCount: () => 0,
    brokersWithOpenPositions: () => [],
    workingOrderCount: () => 0,
    executionInFlight: () => false,
    reconciliationComplete: () => true,
    residualLegCount: () => 0,
    unknownOrderCount: () => 0,
    unresolvedIntentsFor: async () => 0,
  };
  const hooks = {
    stopScanner: () => events.push("stopScanner"),
    invalidateBooks: () => events.push("invalidateBooks"),
    reloadUniverse: async () => events.push("reloadUniverse"),
    publish: () => events.push("publish"),
  };
  return { m, probe, hooks, events };
}

/**
 * Dhan credentials must be present for a switch TO Dhan to be allowed.
 *
 * Awaits inside the try: restoring on the synchronous return of an async `fn` would
 * tear the environment down while the body was still running.
 */
async function withDhanEnv(fn) {
  const saved = {
    id: process.env.DHAN_CLIENT_ID,
    key: process.env.DHAN_API_KEY,
    secret: process.env.DHAN_API_SECRET,
  };
  process.env.DHAN_CLIENT_ID = "C1";
  process.env.DHAN_API_KEY = "key";
  process.env.DHAN_API_SECRET = "secret";
  try {
    return await fn();
  } finally {
    restore("DHAN_CLIENT_ID", saved.id);
    restore("DHAN_API_KEY", saved.key);
    restore("DHAN_API_SECRET", saved.secret);
  }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/* ------------------------------- default state ----------------------------- */

test("the default active broker is zerodha", () => {
  const { m } = manager();
  assert.equal(m.activeBroker, "zerodha");
});

test("Dhan is reported as not configured when its env vars are absent", () => {
  const saved = process.env.DHAN_API_KEY;
  delete process.env.DHAN_API_KEY;
  try {
    const { m } = manager();
    const creds = m.dhanCredentials();
    assert.equal(creds.ok, false);
    assert.match(creds.reason, /DHAN_API_KEY/);
  } finally {
    restore("DHAN_API_KEY", saved);
  }
});

/* ------------------------------ switch guards ------------------------------ */

test("switching is REFUSED while the scanner is running", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach({ ...probe, scannerRunning: () => true }, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "scanner_running"));
    assert.equal(m.activeBroker, "zerodha", "the broker did NOT change");
  });
});

test("switching is REFUSED while an open Box position exists", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach(
      { ...probe, openPositionCount: () => 2, brokersWithOpenPositions: () => ["zerodha"] },
      hooks,
    );
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    const blocker = result.blockers.find((b) => b.reason === "open_box_positions");
    assert.ok(blocker);
    assert.match(blocker.detail, /2 open Box position/);
  });
});

test("switching is REFUSED while broker orders are working", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach({ ...probe, workingOrderCount: () => 3 }, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "working_orders"));
  });
});

test("switching is REFUSED while an entry/exit is in flight", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach({ ...probe, executionInFlight: () => true }, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "execution_in_flight"));
  });
});

test("switching is REFUSED while reconciliation is incomplete", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach({ ...probe, reconciliationComplete: () => false }, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "unresolved_reconciliation"));
  });
});

test("switching is REFUSED while residual exposure remains", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach({ ...probe, residualLegCount: () => 2 }, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "residual_exposure"));
  });
});

test("switching is REFUSED while any order is in an unknown state", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach({ ...probe, unknownOrderCount: () => 1 }, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "unknown_order_state"));
  });
});

test("switching is REFUSED while the OUTGOING broker has unresolved intents", async () => {
  // An intent can only be reconciled through the broker that created it, and after
  // the switch that broker's adapter is gone.
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach(
      { ...probe, unresolvedIntentsFor: async (broker) => (broker === "zerodha" ? 2 : 0) },
      hooks,
    );
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    const blocker = result.blockers.find((b) => b.reason === "foreign_unresolved_intents");
    assert.ok(blocker);
    assert.match(blocker.detail, /only be reconciled through zerodha/);
  });
});

test("switching to an UNCONFIGURED broker is refused", async () => {
  const saved = process.env.DHAN_API_SECRET;
  delete process.env.DHAN_API_SECRET;
  try {
    const { m, probe, hooks } = manager();
    m.attach(probe, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((b) => b.reason === "broker_not_configured"));
  } finally {
    restore("DHAN_API_SECRET", saved);
  }
});

test("ALL blockers are reported at once, not just the first", async () => {
  // An operator with three problems should see three, not discover them one 409 at a time.
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach(
      {
        ...probe,
        scannerRunning: () => true,
        openPositionCount: () => 1,
        brokersWithOpenPositions: () => ["zerodha"],
        residualLegCount: () => 1,
      },
      hooks,
    );
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, false);
    assert.ok(result.blockers.length >= 3, `expected several blockers, got ${result.blockers.length}`);
  });
});

/* ------------------------------ safe switching ----------------------------- */

test("a switch with NO exposure succeeds and moves the active broker", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks } = manager();
    m.attach(probe, hooks);
    const result = await m.switchBroker("dhan", "full");
    assert.equal(result.ok, true);
    assert.equal(m.activeBroker, "dhan");
  });
});

test("a safe switch TEARS DOWN the old broker before bringing up the new one", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks, events } = manager();
    m.attach(probe, hooks);
    await m.switchBroker("dhan", "full");

    // The ordering IS the safety property: scanner stopped, old feed stopped and its
    // books dropped, only then the universe reloaded for the new broker.
    const stopScanner = events.indexOf("stopScanner");
    const kiteStop = events.indexOf("kite:stop");
    const invalidate = events.indexOf("invalidateBooks");
    const reload = events.indexOf("reloadUniverse");

    assert.ok(stopScanner >= 0, "the scanner was stopped");
    assert.ok(kiteStop >= 0, "the outgoing Kite feed was stopped");
    assert.ok(invalidate >= 0, "books were invalidated");
    assert.ok(stopScanner < kiteStop, "scanner stops before the feed");
    assert.ok(kiteStop < invalidate, "the feed stops before books are dropped");
    assert.ok(invalidate < reload, "books are dropped BEFORE the new universe loads");
  });
});

test("re-selecting the CURRENT broker is an idempotent no-op success", async () => {
  const { m, probe, hooks, events } = manager();
  m.attach(probe, hooks);
  const result = await m.switchBroker("zerodha", "full");
  assert.equal(result.ok, true);
  // Nothing was torn down: a repeated admin verify must not disrupt a live session.
  assert.equal(events.includes("kite:stop"), false);
  assert.equal(events.includes("invalidateBooks"), false);
});

/* --------------------------- transport isolation --------------------------- */

test("while ZERODHA is active, subscriptions go to the Kite hub only", () => {
  const { m, probe, hooks, events } = manager();
  m.attach(probe, hooks);
  m.subscribeTokens([1, 2, 3]);
  assert.deepEqual(events, ["kite:subscribe"]);
});

test("while DHAN is active, subscriptions do NOT touch the Kite hub", async () => {
  await withDhanEnv(async () => {
    const { m, probe, hooks, events } = manager();
    m.attach(probe, hooks);
    await m.switchBroker("dhan", "full");
    events.length = 0;
    m.subscribeTokens([1, 2, 3]);
    // No Kite call: the Dhan feed owns the subscription while Dhan is active.
    assert.equal(events.filter((e) => e.startsWith("kite:")).length, 0);
  });
});

test("createLiveAdapter REFUSES a broker that is not the active one", () => {
  // Silently returning a Kite adapter for a Dhan request would place real orders at
  // the wrong broker — the worst outcome this architecture can produce.
  const { m, probe, hooks } = manager();
  m.attach(probe, hooks);
  assert.equal(m.activeBroker, "zerodha");
  assert.throws(
    () => m.createLiveAdapter({ broker: "dhan", cfg: {} }),
    /refusing to build a dhan execution adapter while zerodha is the active broker/,
  );
});

/* -------------------------------- readiness -------------------------------- */

test("Zerodha health has no static-IP concept, reported as null not false", () => {
  // null means "not applicable"; false would imply a missing configuration.
  const { m } = manager();
  const health = m.healthFor("zerodha");
  assert.equal(health.static_ip_configured, null);
  assert.equal(health.authenticated, true);
  assert.equal(health.trading_ready, true);
});

test("Dhan is not trading_ready without a session, even with a static IP", () => {
  const savedIp = process.env.DHAN_STATIC_IP_EXPECTED;
  process.env.DHAN_STATIC_IP_EXPECTED = "true";
  try {
    const { m } = manager();
    const health = m.healthFor("dhan");
    assert.equal(health.authenticated, false);
    assert.equal(health.data_ready, false);
    assert.equal(health.trading_ready, false);
    assert.ok(health.problems.some((p) => /not connected/i.test(p)));
  } finally {
    restore("DHAN_STATIC_IP_EXPECTED", savedIp);
  }
});

test("a missing static IP is surfaced as an explicit operator problem", () => {
  const saved = process.env.DHAN_STATIC_IP_EXPECTED;
  delete process.env.DHAN_STATIC_IP_EXPECTED;
  try {
    const { m } = manager();
    assert.equal(m.dhanStaticIpReady(), false, "fail closed by default");
    const health = m.healthFor("dhan");
    assert.equal(health.static_ip_configured, false);
    assert.ok(health.problems.some((p) => /Static IP not configured/.test(p)));
  } finally {
    restore("DHAN_STATIC_IP_EXPECTED", saved);
  }
});

test("session state is never derived from admin authentication", () => {
  // A verified admin password must not make a broker look connected.
  const { m } = manager({
    kite: {
      getAccessToken: () => null,
      getApiKey: () => "k",
      getQuoteFull: async () => [],
      getBasketMargin: async () => ({ initial: 0, final: 0, total: 0 }),
    },
  });
  const session = m.sessionFor("zerodha");
  assert.equal(session.authenticated, false);
  assert.equal(m.healthFor("zerodha").data_ready, false);
});

test("the snapshot reports the active broker plus its session and health", () => {
  const { m } = manager();
  const snap = m.snapshot();
  assert.equal(snap.broker, "zerodha");
  assert.equal(snap.session.broker, "zerodha");
  assert.equal(snap.health.broker, "zerodha");
  assert.equal(typeof snap.dhan_configured, "boolean");
});
