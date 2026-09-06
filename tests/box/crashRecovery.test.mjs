/**
 * CRASH AND RESTART RECOVERY — the dangerous boundaries.
 *
 * A process can die at any instant. The durable intent journal exists so that after a restart the
 * system can establish broker truth and never: double-submit, double-count a fill, lose owned
 * exposure, or assume it is flat when it is not.
 *
 * Covers the required cases:
 *   8. Crash after POST does not double-submit.
 *   9. Crash after fill does not lose exposure.
 *  10. Reconciliation restores the correct remainder.
 *
 * Plus the boundaries either side of those: before POST, after ACK, after a partial, during a
 * cancel, and after a cancel request but before the terminal confirmation.
 *
 * Offline: an in-memory intent journal and a fake adapter. No broker, no Mongo, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";
import {
  CumulativeFillLedger,
  outstandingQuantity,
  terminalQuantityAccounting,
} from "../../dist/box/orderLifecycle.js";

const clone = (v) => structuredClone(v);
const tick = () => new Promise((r) => setImmediate(r));

const request = (overrides = {}) => {
  const role = overrides.role ?? "k1_ce";
  const purpose = overrides.purpose ?? "ENTRY";
  const trade = overrides.trade_id ?? "trade-crash";
  const attempt = overrides.attempt_id ?? "attempt-1";
  return {
    client_order_id: overrides.client_order_id ?? `BOX:${trade}:${purpose}:${role}:${attempt}`,
    role,
    trade_id: trade,
    attempt_id: attempt,
    purpose,
    phase: overrides.phase ?? "entry",
    exchange: "NFO",
    tradingsymbol: overrides.tradingsymbol ?? "SYM-k1_ce",
    token: 1001,
    side: overrides.side ?? "BUY",
    quantity: overrides.quantity ?? 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
    ...(overrides.tag ? { tag: overrides.tag } : {}),
  };
};

function intentFrom(req, state, filled = 0) {
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
  const state = overrides.state ?? (filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED");
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
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state,
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? 100 : null,
    fills: filled > 0 ? [{ fill_id: `fill-${req.client_order_id}-${filled}`, quantity: filled, price: 100, at: 2_000 }] : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

/**
 * An intent journal that SURVIVES a simulated crash: the same instance is handed to a fresh
 * manager, exactly as Mongo would be after a restart.
 */
class DurableJournal {
  constructor(intents = []) {
    this.rows = new Map(intents.map((i) => [i.client_order_id, clone(i)]));
    this.events = [];
  }
  async create(intent) {
    this.events.push(["create", intent.client_order_id, intent.state]);
    const current = this.rows.get(intent.client_order_id);
    // An upsert: an existing durable intent is RETURNED, not overwritten. This is the mechanism
    // that makes a post-restart resubmission impossible.
    if (current) return clone(current);
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit) {
    const current = this.rows.get(clientOrderId);
    this.events.push(["update", clientOrderId, patch.state ?? current?.state]);
    if (!current) return { intent: null, applied: false };
    // The monotonic-fill guard the real repository enforces.
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      return { intent: clone(current), applied: false };
    }
    const next = { ...current, ...clone(patch) };
    if (!next.audit.some((a) => a.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return { intent: clone(next), applied: true };
  }
  async loadNonterminal() {
    return [...this.rows.values()]
      .filter((i) => !["COMPLETE", "CANCELLED", "REJECTED"].includes(i.state))
      .map(clone);
  }
  async loadOwned() {
    return [...this.rows.values()].map(clone);
  }
  async findByClientId(id) {
    return this.rows.has(id) ? clone(this.rows.get(id)) : null;
  }
  async findByBrokerId(id) {
    const f = [...this.rows.values()].find((i) => i.broker_order_id === id);
    return f ? clone(f) : null;
  }
}

function fakeAdapter(options = {}) {
  const calls = [];
  const orders = new Map((options.orders ?? []).map((o) => [o.client_order_id, clone(o)]));
  const adapter = {
    mode: "live",
    calls,
    orders,
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: req.tag ?? `TAG${req.role}` }),
    submitOrder: async (req) => {
      calls.push(["submit", req.client_order_id]);
      const result = options.submit ? await options.submit(req, adapter) : orderFrom(req);
      if (result) orders.set(req.client_order_id, clone(result));
      return clone(result);
    },
    cancelOrder: async (id) => {
      calls.push(["cancel", id]);
      return orders.has(id) ? clone(orders.get(id)) : undefined;
    },
    getOrder: async (id) => {
      calls.push(["get", id]);
      return orders.has(id) ? clone(orders.get(id)) : undefined;
    },
    listOrders: async () => {
      calls.push(["listOrders"]);
      return options.listOrders ? options.listOrders() : [...orders.values()].map(clone);
    },
    listPositions: async () => clone(options.positions ?? []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => {
      calls.push(["adopt", intent.client_order_id]);
      if (
        snapshot.quantity !== intent.quantity ||
        snapshot.tradingsymbol !== intent.tradingsymbol ||
        snapshot.side !== intent.side
      ) {
        throw new Error("immutable broker snapshot mismatch");
      }
      return { ...clone(snapshot), client_order_id: intent.client_order_id };
    },
  };
  return adapter;
}

/** Broker positions consistent with a given net quantity, so the position-mismatch gate is not
 * tripped by an incomplete fixture rather than by the behaviour under test. */
function positionsFor(req, netQty) {
  return netQty === 0
    ? []
    : [{ token: req.token, exchange: req.exchange, tradingsymbol: req.tradingsymbol, net_quantity: netQty, average_price: 100 }];
}

const limits = (o = {}) => ({
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
  ...o,
});

/** Boot a manager against an existing journal — i.e. a process restart. */
async function boot({ journal, adapter, reconcile = true }) {
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence: journal,
    limits: limits(),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-02",
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  let report = null;
  if (reconcile) report = await manager.reconcile();
  return { manager, report };
}

/* ───────────── 8. crash after POST does not double-submit ───────────── */

test("REQUIRED 8: a crash AFTER the POST but before the response does not double-submit", async () => {
  const req = request();
  // The pre-crash process wrote CREATED then SUBMITTING, then died. The order EXISTS at the broker.
  const journal = new DurableJournal([intentFrom(req, "SUBMITTING")]);
  const brokerOrder = orderFrom(req, { state: "COMPLETE", filled_quantity: 75 });
  const adapter = fakeAdapter({ orders: [brokerOrder], positions: positionsFor(req, 75) });

  const { manager } = await boot({ journal, adapter });
  adapter.calls.length = 0;

  // The restarted process re-attempts the same client order id.
  const result = await manager.submit(req);

  assert.equal(
    adapter.calls.filter((c) => c[0] === "submit").length,
    0,
    "a durable intent past CREATED must NEVER be re-POSTed",
  );
  assert.ok(adapter.calls.some((c) => c[0] === "get"), "it reconciles the existing order instead");
  assert.equal(result.filled_quantity, 75, "the real broker fill is adopted");
  assert.equal(journal.rows.get(req.client_order_id).filled_quantity, 75);
});

test("a crash BEFORE the POST leaves a CREATED intent that is QUARANTINED, not resubmitted", async () => {
  const req = request();
  // Nothing was transmitted, so in principle resubmitting would be safe. The system deliberately
  // does NOT do that: absence from one order-book read is not proof the order does not exist, and
  // the cost of being wrong (a duplicate live order) is far higher than the cost of stopping. So a
  // durable non-terminal intent the broker does not know about trips the breaker and waits for a
  // human, exactly as it does for every other unexplained discrepancy.
  const journal = new DurableJournal([intentFrom(req, "CREATED")]);
  const adapter = fakeAdapter({ orders: [], listOrders: () => [] });
  const { manager, report } = await boot({ journal, adapter });

  assert.deepEqual(report.missingAtBroker, [req.client_order_id]);
  assert.notEqual(manager.status().circuitBreaker.reason, null, "the discrepancy must be surfaced");
  assert.equal(manager.canEnter(), false, "and entry blocked until it is resolved");
  assert.equal(
    adapter.calls.filter((c) => c[0] === "submit").length,
    0,
    "reconciliation must never resubmit on its own",
  );
});

test("a crash after ACK is reconciled from broker truth, not from our own last belief", async () => {
  const req = request();
  const journal = new DurableJournal([intentFrom(req, "ACKNOWLEDGED", 0)]);
  // While we were dead the order filled completely.
  const adapter = fakeAdapter({
    orders: [orderFrom(req, { state: "COMPLETE", filled_quantity: 75 })],
    positions: positionsFor(req, 75),
  });

  const { manager } = await boot({ journal, adapter });
  const stored = journal.rows.get(req.client_order_id);
  assert.equal(stored.filled_quantity, 75, "reconciliation must adopt the broker's quantity");
  assert.equal(stored.state, "COMPLETE");
  assert.equal(manager.status().health.reconciliation_complete, true);
  assert.equal(manager.status().circuitBreaker.tripped, false, "a clean reconciliation must not trip");
});

/* ───────── 9. crash after fill does not lose exposure ───────── */

test("REQUIRED 9: a crash after a PARTIAL fill does not lose the acquired exposure", async () => {
  const req = request();
  // We recorded 40 filled, then died.
  const journal = new DurableJournal([intentFrom(req, "PARTIALLY_FILLED", 40)]);
  const adapter = fakeAdapter({
    orders: [orderFrom(req, { state: "PARTIALLY_FILLED", filled_quantity: 40 })],
    positions: positionsFor(req, 40),
  });

  const { manager } = await boot({ journal, adapter });

  const stored = journal.rows.get(req.client_order_id);
  assert.equal(stored.filled_quantity, 40, "the 40 we own must survive the restart");
  assert.equal(outstandingQuantity(75, stored.filled_quantity), 35, "35 is still outstanding");
  // The manager must still be actively tracking the outstanding 35 — i.e. it has NOT concluded the
  // order is finished and the position is flat. Reconciliation rebuilds the reservation from the
  // durable remainder, which is the mechanism by which owned exposure keeps being worked after a
  // restart instead of being forgotten.
  const status = manager.status();
  assert.equal(status.reservedEntryQuantity, 35, "the outstanding remainder must still be reserved");
  const nonterminal = await journal.loadNonterminal();
  assert.equal(
    nonterminal.some((i) => i.client_order_id === req.client_order_id),
    true,
    "the order must remain non-terminal so the engine keeps resolving it",
  );
});

test("REQUIRED 9: a crash after a FULL fill but before persistence is caught by reconciliation", async () => {
  const req = request();
  // Our journal thinks the order is merely acknowledged; the broker filled all 75.
  const journal = new DurableJournal([intentFrom(req, "ACKNOWLEDGED", 0)]);
  const adapter = fakeAdapter({ orders: [orderFrom(req, { state: "COMPLETE", filled_quantity: 75 })] });

  await boot({ journal, adapter });

  assert.equal(
    journal.rows.get(req.client_order_id).filled_quantity,
    75,
    "a fill the broker owns must never be lost because our write did not land",
  );
});

test("a non-terminal intent MISSING from the broker is quarantined, never assumed flat", async () => {
  const req = request();
  const journal = new DurableJournal([intentFrom(req, "OPEN", 0)]);
  // The broker reports no such order. That is not evidence of "no position".
  const adapter = fakeAdapter({ orders: [], listOrders: () => [] });

  const { manager } = await boot({ journal, adapter });
  const status = manager.status();
  assert.notEqual(status.circuitBreaker.reason, null, "an unexplained disappearance must trip the breaker");
  assert.equal(manager.canEnter(), false, "and entry must be blocked until a human looks");
});

/* ───────── 10. reconciliation restores the correct remainder ───────── */

test("REQUIRED 10: reconciliation restores the correct remainder after a partial", async () => {
  const req = request({ quantity: 75 });
  const journal = new DurableJournal([intentFrom(req, "PARTIALLY_FILLED", 40)]);
  // The broker had actually filled 52 by the time we came back.
  const adapter = fakeAdapter({ orders: [orderFrom(req, { state: "PARTIALLY_FILLED", filled_quantity: 52 })] });

  await boot({ journal, adapter });

  const stored = journal.rows.get(req.client_order_id);
  assert.equal(stored.filled_quantity, 52, "broker cumulative quantity is authoritative");
  assert.equal(outstandingQuantity(stored.quantity, stored.filled_quantity), 23, "the remainder is 23");
  // And a follow-up operation must ask for the REMAINDER, never the original quantity.
  assert.notEqual(outstandingQuantity(75, 52), 75);
});

test("REQUIRED 10: a stale lower broker snapshot cannot rewind the recorded remainder", async () => {
  const req = request();
  const journal = new DurableJournal([intentFrom(req, "PARTIALLY_FILLED", 52)]);
  // A lagging read reports only 40.
  const adapter = fakeAdapter({ orders: [orderFrom(req, { state: "PARTIALLY_FILLED", filled_quantity: 40 })] });

  await boot({ journal, adapter });

  assert.equal(
    journal.rows.get(req.client_order_id).filled_quantity,
    52,
    "the monotonic guard must refuse a regression",
  );
});

test("a cancel that raced a fill restores filled 52 / cancelled 23 after a restart", async () => {
  const req = request();
  // We died just after requesting the cancel, holding 40.
  const journal = new DurableJournal([intentFrom(req, "CANCEL_REQUESTED", 40)]);
  // The broker's terminal truth: 52 filled, remainder cancelled.
  const adapter = fakeAdapter({ orders: [orderFrom(req, { state: "CANCELLED", filled_quantity: 52 })] });

  await boot({ journal, adapter });

  const stored = journal.rows.get(req.client_order_id);
  const accounting = terminalQuantityAccounting({
    requestedQty: stored.quantity,
    finalCumulativeQty: stored.filled_quantity,
    cumulativeAtCancelRequest: 40,
  });
  assert.equal(accounting.filled, 52, "NOT 40 — the cancel request did not stop the exchange");
  assert.equal(accounting.cancelled, 23);
  assert.equal(accounting.racedQuantity, 12);
  assert.equal(accounting.filled + accounting.cancelled, 75, "quantity is conserved across the restart");
});

/* ───── the fill ledger's own restart-safety properties ───── */

test("replaying the SAME broker snapshots after a restart cannot double-count", async () => {
  // A restarted process re-reads the order book and sees states it has already accounted for.
  const ledger = new CumulativeFillLedger("BOX:t:ENTRY:k1_ce:attempt-1", 75);
  const snapshots = [
    { cumulativeQty: 25, eventId: "s25", source: "rest_poll" },
    { cumulativeQty: 52, eventId: "s52", source: "rest_poll" },
  ];
  for (const s of snapshots) ledger.apply(s);
  assert.equal(ledger.cumulative, 52);

  // Replay every snapshot again, and in reverse for good measure.
  for (const s of [...snapshots].reverse()) ledger.apply(s);
  for (const s of snapshots) ledger.apply(s);

  assert.equal(ledger.cumulative, 52, "a full replay must be a no-op");
  assert.equal(ledger.snapshot().appliedEvents, 2, "only the two genuine advances counted");
  assert.equal(ledger.remaining, 23);
});

test("an unknown post-restart state is never treated as 'no fill'", async () => {
  const req = request();
  const journal = new DurableJournal([intentFrom(req, "UNKNOWN", 40)]);
  const adapter = fakeAdapter({ orders: [orderFrom(req, { state: "UNKNOWN", filled_quantity: 40 })] });
  const { manager } = await boot({ journal, adapter });
  assert.equal(
    journal.rows.get(req.client_order_id).filled_quantity,
    40,
    "quantity already acquired stays acquired while the state is uncertain",
  );
  assert.equal(manager.canEnter(), false, "and an uncertain order blocks new entries");
});
