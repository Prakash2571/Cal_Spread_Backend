import test from "node:test";
import assert from "node:assert/strict";

import { BrokerAmbiguousSubmitError } from "../../dist/box/brokerAdapter.js";
import {
  BoxOrderManager,
  OrderPersistenceAfterFillError,
} from "../../dist/box/orderManager.js";

const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];
const immutable = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase",
  "exchange", "tradingsymbol", "token", "side", "quantity",
  "reference_price", "tick_size", "max_chase_ticks", "limit_price",
];

const clone = (value) => structuredClone(value);

const request = (overrides = {}) => {
  const role = overrides.role ?? "k1_ce";
  const purpose = overrides.purpose ?? "ENTRY";
  const attempt = overrides.attempt_id ?? `attempt-${role}`;
  const trade = overrides.trade_id ?? "trade-1";
  return {
    client_order_id: overrides.client_order_id ?? `BOX:${trade}:${purpose}:${role}:${attempt}`,
    role,
    trade_id: trade,
    attempt_id: attempt,
    purpose,
    phase: overrides.phase ?? (purpose === "ENTRY" ? "entry" : purpose === "EMERGENCY_RESIDUAL" ? "unwind" : "exit"),
    exchange: overrides.exchange ?? "NFO",
    tradingsymbol: overrides.tradingsymbol ?? `SYM-${role}`,
    token: overrides.token ?? 1000 + ROLES.indexOf(role),
    side: overrides.side ?? (purpose === "ENTRY" ? "BUY" : "SELL"),
    quantity: overrides.quantity ?? 75,
    pricing: overrides.pricing ?? {
      order_type: "LIMIT",
      reference_price: 100,
      tick_size: 0.05,
      max_chase_ticks: 2,
      limit_price: overrides.side === "SELL" ? 99.9 : 100.1,
    },
    ...(overrides.tag ? { tag: overrides.tag } : {}),
  };
};

function intentFrom(req, state = "CREATED", filled = 0) {
  const at = new Date(1_000);
  return {
    client_order_id: req.client_order_id,
    broker_order_id: state === "CREATED" || state === "SUBMITTING" ? null : `B-${req.client_order_id}`,
    broker_mode: "live",
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    role: req.role,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    reference_price: req.pricing.reference_price,
    tick_size: req.pricing.tick_size,
    max_chase_ticks: req.pricing.max_chase_ticks,
    limit_price: req.pricing.limit_price,
    state,
    filled_quantity: filled,
    average_price: filled > 0 ? 100 : null,
    broker_tag: req.tag ?? null,
    reject_family: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    terminal_at: ["COMPLETE", "CANCELLED", "REJECTED"].includes(state) ? at : null,
    audit: [],
  };
}

function orderFrom(req, overrides = {}) {
  const filled = overrides.filled_quantity ?? req.quantity;
  const state = overrides.state ?? (filled === req.quantity ? "COMPLETE" : "PARTIALLY_FILLED");
  return {
    client_order_id: req.client_order_id,
    broker_order_id: overrides.broker_order_id ?? `B-${req.client_order_id}`,
    tag: overrides.tag ?? req.tag ?? null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: overrides.quantity ?? req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state,
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? 100 : null,
    fills: filled > 0 ? [{ fill_id: overrides.fill_id ?? `fill-${req.client_order_id}-${filled}`, quantity: filled, price: 100, at: 2_000 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

class MemoryPersistence {
  constructor(intents = []) {
    this.rows = new Map(intents.map((intent) => [intent.client_order_id, clone(intent)]));
    this.events = [];
  }
  async create(intent) {
    this.events.push(["create", intent.client_order_id, intent.state]);
    const current = this.rows.get(intent.client_order_id);
    if (current) {
      for (const key of immutable) {
        if (current[key] !== intent[key]) throw new Error(`immutable mismatch: ${key}`);
      }
      return clone(current);
    }
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit) {
    const current = this.rows.get(clientOrderId);
    this.events.push(["update", clientOrderId, patch.state ?? current?.state]);
    if (!current) return { intent: null, applied: false };
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      return { intent: clone(current), applied: false };
    }
    const next = { ...current, ...clone(patch) };
    if (!next.audit.some((item) => item.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return { intent: clone(next), applied: true };
  }
  async loadNonterminal() {
    return [...this.rows.values()]
      .filter((intent) => !["COMPLETE", "CANCELLED", "REJECTED"].includes(intent.state))
      .map(clone);
  }
  async loadOwned() { return [...this.rows.values()].map(clone); }
  async findByClientId(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async findByBrokerId(id) {
    const found = [...this.rows.values()].find((intent) => intent.broker_order_id === id);
    return found ? clone(found) : null;
  }
}

function fakeAdapter(options = {}) {
  const calls = [];
  const orders = new Map((options.orders ?? []).map((order) => [order.client_order_id, clone(order)]));
  let active = 0;
  let maxActive = 0;
  const adapter = {
    mode: "live",
    calls,
    orders,
    get maxActive() { return maxActive; },
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: req.tag ?? `TAG${req.role}` }),
    submitOrder: async (req) => {
      calls.push(["submit", req.purpose, req.role, req.client_order_id, req.quantity]);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const result = options.submit ? await options.submit(req, adapter) : orderFrom(req);
        if (result) orders.set(req.client_order_id, clone(result));
        return clone(result);
      } finally {
        active--;
      }
    },
    cancelOrder: async (id) => { calls.push(["cancel", id]); return orders.get(id); },
    getOrder: async (id) => { calls.push(["get", id]); return orders.has(id) ? clone(orders.get(id)) : undefined; },
    listOrders: async () => (options.listOrders ? options.listOrders() : [...orders.values()].map(clone)),
    listPositions: async () => clone(options.positions ?? []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => {
      if (options.adopt) return options.adopt(intent, snapshot);
      if (snapshot.quantity !== intent.quantity || snapshot.tradingsymbol !== intent.tradingsymbol || snapshot.side !== intent.side) {
        throw new Error("immutable broker snapshot mismatch");
      }
      return { ...clone(snapshot), client_order_id: intent.client_order_id };
    },
  };
  return adapter;
}

const limits = (overrides = {}) => ({
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  ...overrides,
});

async function managerHarness({ persistence = new MemoryPersistence(), adapter = fakeAdapter(), limitOverrides = {}, reconcile = true } = {}) {
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: limits(limitOverrides),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  if (reconcile) await manager.reconcile();
  return { manager, persistence, adapter };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("CREATED and SUBMITTING are durable before transport submission", async () => {
  const persistence = new MemoryPersistence();
  let adapter;
  adapter = fakeAdapter({
    submit: async (req) => {
      assert.equal(persistence.rows.get(req.client_order_id).state, "SUBMITTING");
      persistence.events.push(["transport", req.client_order_id]);
      return orderFrom(req);
    },
  });
  const h = await managerHarness({ persistence, adapter });
  persistence.events.length = 0;

  await h.manager.submit(request());
  assert.deepEqual(
    persistence.events.slice(0, 3).map((event) => [event[0], event[2]]),
    [["create", "CREATED"], ["update", "SUBMITTING"], ["transport", undefined]],
  );
});

test("reused client ID with immutable mismatch is rejected without a second submit", async () => {
  const h = await managerHarness();
  const original = request();
  await h.manager.submit(original);
  await tick();
  await assert.rejects(
    () => h.manager.submit({ ...original, quantity: 74 }),
    /immutable mismatch: quantity/,
  );
  assert.equal(h.adapter.calls.filter(([name]) => name === "submit").length, 1);
});

test("one Box queues all four role orders with max concurrency one", async () => {
  const adapter = fakeAdapter({
    submit: async (req) => { await tick(); return orderFrom(req); },
  });
  const h = await managerHarness({ adapter, limitOverrides: { maxConcurrentExecutions: 1 } });
  const requests = ROLES.map((role) => request({ role, attempt_id: "box-attempt" }));

  await Promise.all(requests.map((item) => h.manager.submit(item)));
  assert.equal(adapter.maxActive, 1);
  assert.deepEqual(adapter.calls.filter(([name]) => name === "submit").map(([, , role]) => role), ROLES);
});

test("queued work is ordered emergency > cancel > exit > entry", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let first = true;
  const adapter = fakeAdapter({
    submit: async (req) => {
      if (first) { first = false; await blocked; }
      return orderFrom(req);
    },
  });
  const h = await managerHarness({ adapter });
  h.manager.setAttributedBoxPositions([{ token: 99, exchange: "NFO", tradingsymbol: "REDUCE", net_quantity: 500, average_price: 100 }]);

  const blocker = h.manager.submit(request({ role: "k1_ce", attempt_id: "blocker" }));
  await tick();
  const queuedEntry = h.manager.submit(request({ role: "k2_ce", attempt_id: "queued-entry" }));
  const queuedExit = h.manager.submit(request({ role: "k2_pe", purpose: "EXIT", attempt_id: "queued-exit", tradingsymbol: "REDUCE", token: 99, side: "SELL" }));
  const queuedCancel = h.manager.cancelWorkingBoxOrders();
  await tick();
  const queuedEmergency = h.manager.submit(request({ role: "k1_ce", purpose: "EMERGENCY_RESIDUAL", attempt_id: "queued-emergency", tradingsymbol: "REDUCE", token: 99, side: "SELL" }));
  release();
  await Promise.all([blocker, queuedEntry, queuedExit, queuedCancel, queuedEmergency]);

  assert.deepEqual(
    adapter.calls
      .filter(([name]) => name === "submit" || name === "cancel")
      .map(([name, purpose]) => name === "cancel" ? "PROTECTIVE_CANCEL" : purpose),
    ["ENTRY", "EMERGENCY_RESIDUAL", "PROTECTIVE_CANCEL", "EXIT", "ENTRY"],
  );
});

test("reductions must use the exact reducing side/quantity and cannot cross flat", async () => {
  const h = await managerHarness();
  h.manager.setAttributedBoxPositions([{ token: 99, exchange: "NFO", tradingsymbol: "HELD", net_quantity: 75, average_price: 100 }]);
  const base = { purpose: "EXIT", tradingsymbol: "HELD", token: 99, phase: "exit" };

  await assert.rejects(() => h.manager.submit(request({ ...base, attempt_id: "wrong-side", side: "BUY", quantity: 75 })), /quantity limits/);
  await assert.rejects(() => h.manager.submit(request({ ...base, attempt_id: "cross-flat", side: "SELL", quantity: 76 })), /quantity limits/);
  const exact = await h.manager.submit(request({ ...base, attempt_id: "exact", side: "SELL", quantity: 75 }));
  assert.equal(exact.filled_quantity, 75);
  await assert.rejects(() => h.manager.submit(request({ ...base, attempt_id: "after-flat", side: "SELL", quantity: 1 })), /quantity limits/);
  assert.equal(h.adapter.calls.filter(([name]) => name === "submit").length, 1);
});

test("ambiguous submit is durable and never blindly retried", async () => {
  const adapter = fakeAdapter({
    submit: async (req) => {
      const uncertain = orderFrom(req, { state: "RECONCILIATION_REQUIRED", filled_quantity: 0 });
      throw new BrokerAmbiguousSubmitError(req.client_order_id, "placement ambiguous", undefined, uncertain);
    },
  });
  const h = await managerHarness({ adapter });
  const req = request({ purpose: "PROTECTIVE_CANCEL", phase: "exit", attempt_id: "ambiguous-cancel" });

  await assert.rejects(() => h.manager.submit(req), BrokerAmbiguousSubmitError);
  await tick();
  assert.equal(h.persistence.rows.get(req.client_order_id).state, "RECONCILIATION_REQUIRED");
  await assert.rejects(() => h.manager.submit(req), /requires reconciliation before resubmit/);
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 1);
});

test("reconciliation missing intent or immutable mismatch trips recovery and blocks entry", async (t) => {
  for (const scenario of ["missing", "mismatch"]) {
    await t.test(scenario, async () => {
      const req = request({ trade_id: `trade-${scenario}`, attempt_id: scenario });
      const durable = intentFrom(req, "SUBMITTING", 0);
      const persistence = new MemoryPersistence([durable]);
      const broker = orderFrom(req, scenario === "mismatch" ? { quantity: 74, filled_quantity: 0, state: "OPEN" } : { filled_quantity: 0, state: "OPEN" });
      const adapter = fakeAdapter({
        orders: scenario === "mismatch" ? [broker] : [],
        listOrders: () => scenario === "mismatch" ? [clone(broker)] : [],
      });
      const h = await managerHarness({ persistence, adapter, reconcile: false });

      const report = await h.manager.reconcile();
      assert.equal(h.manager.status().recoveryActive, true);
      assert.equal(h.manager.status().circuitBreaker.tripped, true);
      assert.equal(h.manager.status().health.reconciliation_complete, false);
      if (scenario === "missing") assert.deepEqual(report.missingAtBroker, [req.client_order_id]);
      else assert.equal(report.affectedTradeIds.includes(req.trade_id), true);
      await assert.rejects(() => h.manager.submit(request({ trade_id: "new", attempt_id: `blocked-${scenario}` })), /entry controls or limits are closed/);
      assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 0);
    });
  }
});

test("duplicate cumulative fill snapshots are idempotent", async () => {
  const req = request({ trade_id: "filled-trade", attempt_id: "filled" });
  const durable = intentFrom(req, "COMPLETE", 75);
  const broker = orderFrom(req, { fill_id: "same-fill" });
  const persistence = new MemoryPersistence([durable]);
  const adapter = fakeAdapter({
    orders: [broker],
    listOrders: () => [clone(broker), clone(broker)].slice(0, 1),
    positions: [{ token: req.token, exchange: req.exchange, tradingsymbol: req.tradingsymbol, net_quantity: 75, average_price: 100 }],
  });
  const h = await managerHarness({ persistence, adapter });
  await h.manager.reconcile();

  await assert.rejects(
    () => h.manager.submit(request({ purpose: "EXIT", phase: "exit", trade_id: "filled-trade", attempt_id: "too-much", tradingsymbol: req.tradingsymbol, token: req.token, side: "SELL", quantity: 76 })),
    /quantity limits/,
  );
  const reduced = await h.manager.submit(request({ purpose: "EXIT", phase: "exit", trade_id: "filled-trade", attempt_id: "exact-reduce", tradingsymbol: req.tradingsymbol, token: req.token, side: "SELL", quantity: 75 }));
  assert.equal(reduced.filled_quantity, 75);
});

test("restart loads nonterminal work and reconstructs only the unfilled reservation", async () => {
  const req = request({ trade_id: "restart-trade", attempt_id: "restart", quantity: 75 });
  const durable = intentFrom(req, "PARTIALLY_FILLED", 40);
  const broker = orderFrom(req, { state: "PARTIALLY_FILLED", filled_quantity: 40, fill_id: "restart-fill-40" });
  const persistence = new MemoryPersistence([durable]);
  const adapter = fakeAdapter({
    orders: [broker],
    listOrders: () => [clone(broker)],
    positions: [{ token: req.token, exchange: req.exchange, tradingsymbol: req.tradingsymbol, net_quantity: 40, average_price: 100 }],
  });

  const h = await managerHarness({ persistence, adapter });
  assert.equal(h.manager.status().reservedEntryQuantity, 35, "75 requested - 40 cumulatively filled = 35 reserved after restart");
  assert.equal(h.manager.status().unknownOrders, 0);
});


test("confirmed broker fills remain attached when their durable snapshot update fails", async () => {
  class FailingAfterFillPersistence extends MemoryPersistence {
    async update(clientOrderId, patch, audit) {
      if (patch.filled_quantity > 0) throw new Error("mongo unavailable after fill");
      return super.update(clientOrderId, patch, audit);
    }
  }
  const persistence = new FailingAfterFillPersistence();
  const h = await managerHarness({ persistence });
  const req = request({ attempt_id: "fill-persistence-loss" });

  await assert.rejects(
    () => h.manager.submit(req),
    (error) => {
      assert.equal(error instanceof OrderPersistenceAfterFillError, true);
      assert.equal(error.order.client_order_id, req.client_order_id);
      assert.equal(error.order.filled_quantity, 75);
      return true;
    },
  );
  assert.equal(h.manager.status().health.persistence, "unhealthy");
  assert.equal(h.manager.status().circuitBreaker.tripped, true);
});

test("queued entries re-check runtime controls before broker submission", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let first = true;
  const adapter = fakeAdapter({
    submit: async (req) => {
      if (first) { first = false; await blocked; }
      return orderFrom(req);
    },
  });
  const h = await managerHarness({ adapter });
  const firstOrder = h.manager.submit(request({ role: "k1_ce", attempt_id: "active-before-disable" }));
  await tick();
  const queued = ROLES.slice(1).map((role) =>
    h.manager.submit(request({ role, attempt_id: "queued-before-disable" })),
  );
  h.manager.setControls({ entryEnabled: false, liveOrderEnabled: false });
  release();

  const results = await Promise.allSettled([firstOrder, ...queued]);
  assert.equal(results[0].status, "fulfilled", "already-submitted broker work is observed to completion");
  assert.equal(results.slice(1).every((item) => item.status === "rejected"), true);
  assert.equal(adapter.calls.filter(([name]) => name === "submit").length, 1);
  assert.equal(h.manager.status().queued, 0);
  assert.equal(h.manager.status().reservedEntryQuantity, 0);
});

test("reconciliation derives exact exposure from the adopted broker snapshot in the same pass", async () => {
  const entryReq = request({ trade_id: "restart-exact", attempt_id: "entry", side: "BUY" });
  const exitReq = request({
    trade_id: "restart-exact",
    attempt_id: "exit",
    purpose: "EXIT",
    phase: "exit",
    side: "SELL",
    tradingsymbol: entryReq.tradingsymbol,
    token: entryReq.token,
  });
  const entryIntent = intentFrom(entryReq, "COMPLETE", 75);
  const exitIntent = intentFrom(exitReq, "PARTIALLY_FILLED", 40);
  const entryOrder = orderFrom(entryReq, { state: "COMPLETE", filled_quantity: 75 });
  const completedExit = orderFrom(exitReq, { state: "COMPLETE", filled_quantity: 75 });
  const persistence = new MemoryPersistence([entryIntent, exitIntent]);
  const adapter = fakeAdapter({
    orders: [entryOrder, completedExit],
    listOrders: () => [clone(entryOrder), clone(completedExit)],
    positions: [],
  });
  const h = await managerHarness({ persistence, adapter, reconcile: false });

  const report = await h.manager.reconcile();
  assert.equal(report.positionMismatches.length, 0);
  assert.equal(report.remainingByTrade["restart-exact"].k1_ce, 0);
  assert.equal(h.manager.status().health.reconciliation_complete, true);
  assert.equal(h.manager.status().reservedReductionQuantity, 0);
});

test("feed reconnect warm-up blocks entry until its deterministic deadline", async () => {
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence: new MemoryPersistence(),
    limits: limits({ feedReconnectWarmupMs: 5_000 }),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: false },
    clock: { now: () => now },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  await manager.reconcile();
  manager.setFeedHealthy(false);
  manager.setFeedHealthy(true);

  assert.equal(manager.status().health.feed, "warming");
  assert.equal(manager.canEnter(), false);
  now += 4_999;
  assert.equal(manager.canEnter(), false);
  now += 1;
  assert.equal(manager.status().health.feed, "healthy");
  assert.equal(manager.canEnter(), true);
});


test("startup reconciliation failure keeps the retry timer armed and persistence unhealthy", async () => {
  class FlakyPersistence extends MemoryPersistence {
    failLoads = true;
    async loadNonterminal() {
      if (this.failLoads) throw new Error("mongo read unavailable");
      return super.loadNonterminal();
    }
  }
  const persistence = new FlakyPersistence();
  const manager = new BoxOrderManager({
    adapter: fakeAdapter(),
    persistence,
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: false },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);

  await assert.rejects(() => manager.start(), /mongo read unavailable/);
  assert.notEqual(manager.reconcileTimer, null, "periodic reconciliation remains armed after initial failure");
  assert.equal(manager.status().health.persistence, "unhealthy");
  assert.equal(manager.status().health.reconciliation_complete, false);

  persistence.failLoads = false;
  await manager.reconcile();
  assert.equal(manager.status().health.persistence, "healthy");
  manager.dispose();
});
