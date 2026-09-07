/**
 * LIVE RESIDUAL FLATTENING MUST BE A REAL RETRY LOOP.
 *
 * A residual leg is naked option exposure we hold and did not want. The engine works it every
 * two seconds until it is flat. Before this fix that loop could not retry: the durable
 * `client_order_id` was derived from `(attemptId, residual.created_at, role)`, and `created_at`
 * is deliberately PRESERVED when the shrunken residual is written back — so every pass
 * regenerated a byte-identical identity.
 *
 *   filled 0  -> the durable intent upsert returned the existing non-CREATED intent, so
 *                `OrderManager.execute()` took its "a prior submission exists" branch, re-read
 *                the stale order and resolved. NO SECOND ORDER WAS EVER SENT.
 *   filled 40 -> the remaining quantity changed but the identity did not, so
 *                `assertIntentImmutableMatch` threw on `quantity` — and that error matched
 *                neither branch of the old catch, so it was swallowed, forever.
 *
 * WHY THESE TESTS ARE NOT MIRRORS OF THE IMPLEMENTATION
 * They drive the REAL `BoxOrderManager` over a REAL durable-journal double and the REAL
 * `CentralBoxExecutionGateway` in live mode, and they assert on what reached the ADAPTER — i.e.
 * on whether an order was actually sent to the broker, which is the only thing that matters for
 * money. `loop()` below reproduces the engine's durable write-back (persist `res.remaining`,
 * then work it again) so identity reuse across passes is exercised exactly as in production.
 *
 * The negative control at the end re-introduces the OLD write-back (generation never advances)
 * against the SAME new code and proves the second POST disappears — so these tests are pinned to
 * the durable generation, not to any incidental detail of the new code.
 *
 * Pure and offline: no broker, no Mongo, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { CentralBoxExecutionGateway } from "../../dist/box/executionGateway.js";
import { BrokerAmbiguousSubmitError } from "../../dist/box/brokerAdapter.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { loadBoxConfig } from "../../dist/box/config.js";
import { quote } from "./helpers.mjs";

const clone = (v) => structuredClone(v);
const TERMINAL = ["COMPLETE", "CANCELLED", "REJECTED"];
const IMMUTABLE = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase",
  "exchange", "tradingsymbol", "token", "side", "quantity",
  "reference_price", "tick_size", "max_chase_ticks", "limit_price",
];

const TOKENS = { k1_ce: 9001, k2_ce: 9002, k2_pe: 9003, k1_pe: 9004 };

/**
 * The durable intent journal, modelling the two properties that decide the outcome:
 * an upsert that RETURNS the existing row rather than overwriting it, and the immutable-field
 * comparison that made the old partial-fill case throw.
 */
class Journal {
  constructor(rows = []) {
    this.rows = new Map(rows.map((r) => [r.client_order_id, clone(r)]));
    this.creates = [];
  }
  async create(intent) {
    this.creates.push(intent.client_order_id);
    const current = this.rows.get(intent.client_order_id);
    if (current) {
      for (const key of IMMUTABLE) {
        if (current[key] !== intent[key]) {
          throw new Error(
            `Client order id ${intent.client_order_id} was reused with different immutable field ${key}.`,
          );
        }
      }
      return clone(current);
    }
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit) {
    const current = this.rows.get(clientOrderId);
    if (!current) return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      return {
        intent: clone(current), applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    const next = { ...current, ...clone(patch) };
    if (!next.audit.some((a) => a.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return {
      intent: clone(next), applied: true,
      previous_filled_quantity: current.filled_quantity,
      current_filled_quantity: next.filled_quantity,
    };
  }
  async loadNonterminal() {
    return [...this.rows.values()].filter((i) => !TERMINAL.includes(i.state)).map(clone);
  }
  async loadOwned() { return [...this.rows.values()].map(clone); }
  async findByClientId(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async findByBrokerId(id) {
    const f = [...this.rows.values()].find((i) => i.broker_order_id === id);
    return f ? clone(f) : null;
  }
}

function orderFor(req, { state, filled, avg = 99.9 }) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.client_order_id}`,
    tag: req.tag ?? null,
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
    average_price: filled > 0 ? avg : null,
    fills: filled > 0
      ? [{ fill_id: `fill-${req.client_order_id}-${filled}`, quantity: filled, price: avg, at: 2_000 }]
      : [],
    reject_family: null,
    reject_reason: null,
    created_at: 1_000,
    updated_at: 2_000,
  };
}

/**
 * `script` is consulted per SUBMIT, keyed by the attempt generation embedded in the client id,
 * so a test says "attempt 1 fills 0, attempt 2 fills everything" without caring about hashes.
 */
function adapterFor(script, options = {}) {
  const submits = [];
  const gets = [];
  const orders = new Map(options.seedOrders ?? []);
  return {
    mode: "live",
    submits,
    gets,
    orders,
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: `TAG${req.role}` }),
    submitOrder: async (req) => {
      submits.push({ id: req.client_order_id, role: req.role, quantity: req.quantity, side: req.side });
      const generation = Number(/attempt-(\d+)$/.exec(req.client_order_id)?.[1] ?? 0);
      const outcome = script({ req, generation, submitIndex: submits.length - 1 });
      if (outcome instanceof Error) throw outcome;
      const order = orderFor(req, outcome);
      orders.set(req.client_order_id, clone(order));
      return clone(order);
    },
    cancelOrder: async (id) => orders.get(id),
    getOrder: async (id) => {
      gets.push(id);
      return orders.has(id) ? clone(orders.get(id)) : undefined;
    },
    listOrders: async () => [...orders.values()].map(clone),
    listPositions: async () => clone(options.positions ?? []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    adoptOrder: async (intent, snapshot) => {
      if (snapshot.quantity !== intent.quantity) throw new Error("immutable broker snapshot mismatch");
      return { ...clone(snapshot), client_order_id: intent.client_order_id };
    },
  };
}

const LIMITS = {
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 1_000,
  consecutiveFailureLimit: 1_000,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 3_600_000,
  feedReconnectWarmupMs: 0,
};

/**
 * A live gateway over a real manager. `held` seeds the ATTRIBUTED exposure the residual is
 * reducing — without it the manager's reduction gate (correctly) refuses every order.
 */
async function build({ script, journal = new Journal(), held, invariants = [] } = {}) {
  const adapter = adapterFor(script);
  let now = 10_000;
  const manager = new BoxOrderManager({
    adapter,
    persistence: journal,
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-07",
  });
  // Spy on the REAL invariant hook rather than replacing it: the breaker must still trip.
  const realInvariant = manager.invariantViolation.bind(manager);
  manager.invariantViolation = (reason) => {
    invariants.push(reason);
    realInvariant(reason);
  };
  manager.seedLimits({ tradingDay: "2026-09-07" });
  manager.setFeedHealthy(true);
  manager.setAttributedBoxPositions(held);

  const quotes = new BoxQuoteStore();
  quotes.applyTicks(
    Object.values(TOKENS).map((t) => quote(t, { bid: 99.9, bidQty: 900, ask: 100.1, askQty: 900 })),
    1_000,
  );

  const gateway = new CentralBoxExecutionGateway({
    cfg: { ...loadBoxConfig(), executionMode: "live" },
    simulator: {
      flattenResidual: async () => { throw new Error("PAPER PATH MUST NOT BE REACHED IN LIVE MODE"); },
    },
    quotes,
    manager,
    chargeTotal: () => 20,
  });

  return { manager, gateway, adapter, journal, quotes, invariants };
}

const residual = (role, overrides = {}) => ({
  role,
  token: TOKENS[role],
  tradingsymbol: `SYM-${role}`,
  exchange: "NFO",
  side: "BUY",
  quantity: 75,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000,
  ...overrides,
});

/**
 * Reproduce the engine's flatten loop: work the residual, then durably write back exactly what
 * `res.remaining` says (quantity AND generation together, as one atomic document write), then
 * work THAT. `writeBack` lets a test substitute the old, broken projection.
 */
async function loop(gateway, start, passes, { keyPrefix = "att-1", writeBack = (r) => r } = {}) {
  let work = start;
  const history = [];
  for (let i = 0; i < passes && work.length > 0; i++) {
    const res = await gateway.flattenResidual({ residual: work, keyPrefix });
    history.push(res);
    work = res.remaining.map((r) => writeBack(r));
  }
  return { history, remaining: work };
}

/* ══════════════════ 1-2. a zero-fill attempt must be retryable ══════════════════ */

test("R1/R2: after a residual attempt fills 0, the NEXT attempt uses a different client order id and actually reaches the broker", async () => {
  const b = await build({
    // Attempt 1 is cancelled unfilled — the ordinary reason a residual survives a pass.
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 0 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 2);

  assert.equal(b.adapter.submits.length, 2, "the second pass must SEND a second order, not re-read the first");
  assert.notEqual(
    b.adapter.submits[0].id,
    b.adapter.submits[1].id,
    "a new logical flatten attempt must have a NEW durable identity",
  );
  assert.match(b.adapter.submits[0].id, /attempt-1$/);
  assert.match(b.adapter.submits[1].id, /attempt-2$/);
  assert.equal(b.adapter.submits[1].quantity, 75, "nothing filled, so the whole residual is retried");

  assert.equal(history[0].remaining.length, 1, "pass 1 leaves the exposure outstanding");
  assert.equal(history[0].remaining[0].flatten_attempt, 2, "and retires the spent generation durably");
  assert.equal(remaining.length, 0, "pass 2 flattens it");
  assert.equal(history[1].flattened_by_role.k1_ce, 75);
});

test("R2b: the retry is a real POST — the durable journal holds two distinct intents", async () => {
  const b = await build({
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 0 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  await loop(b.gateway, [residual("k1_ce")], 2);

  const ids = [...b.journal.rows.keys()].filter((k) => k.includes("EMERGENCY_RESIDUAL"));
  assert.equal(ids.length, 2, "each logical attempt is represented explicitly in the journal");
  assert.equal(new Set(ids).size, 2);
  // The generation is the ONLY thing that differs — the scope hash is still stable.
  assert.deepEqual(
    ids.map((id) => id.replace(/attempt-\d+$/, "attempt-N")),
    [ids[0].replace(/attempt-\d+$/, "attempt-N"), ids[0].replace(/attempt-\d+$/, "attempt-N")],
  );
});

/* ══════════════════ 3-7. a partial fill must be retryable for the remainder ══════════════════ */

test("R3/R4/R5: a partially filled residual persists the remainder, and the next attempt submits EXACTLY the remainder under a new identity", async () => {
  const b = await build({
    // 30 of 75 fill, then the order terminates. 45 remain.
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 30 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 2);

  // 5. the remaining quantity is persisted
  assert.equal(history[0].remaining.length, 1);
  assert.equal(history[0].remaining[0].quantity, 45, "exactly the unflattened remainder is carried");
  assert.equal(history[0].flattened_by_role.k1_ce, 30);

  // 6. a DIFFERENT identity
  assert.equal(b.adapter.submits.length, 2);
  assert.notEqual(b.adapter.submits[0].id, b.adapter.submits[1].id);
  assert.equal(history[0].remaining[0].flatten_attempt, 2);

  // 7. submitting exactly the remainder — and NOT throwing on the immutable `quantity` field,
  //    which is what silently killed every later pass before this fix.
  assert.equal(b.adapter.submits[0].quantity, 75);
  assert.equal(b.adapter.submits[1].quantity, 45, "the retry is sized to the remainder, never the original");
  assert.equal(remaining.length, 0);
});

test("R13: a prior attempt's immutable durable fields can never block a legitimate later attempt", async () => {
  // Three passes, each partially filling, so the quantity changes on EVERY pass. Under the old
  // identity this threw `reused with different immutable field quantity` from pass 2 onward and
  // the error was swallowed whole.
  const b = await build({
    script: ({ generation }) => ({ state: "CANCELLED", filled: generation === 1 ? 30 : generation === 2 ? 25 : 20 }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 3);

  assert.equal(b.adapter.submits.length, 3, "every pass must reach the broker");
  assert.deepEqual(b.adapter.submits.map((s) => s.quantity), [75, 45, 20]);
  assert.deepEqual(history.map((h) => h.remaining[0]?.quantity ?? 0), [45, 20, 0]);
  assert.deepEqual(history.map((h) => h.remaining[0]?.flatten_attempt ?? null), [2, 3, null]);
  assert.equal(remaining.length, 0, "the residual is fully flattened by repeated legitimate retries");
  assert.equal(b.invariants.length, 0, "a normal partial-fill retry is not an invariant violation");
});

/* ══════════════════ 8-9. crash BEFORE the broker submit ══════════════════ */

/** Discover the durable identity attempt N would use, without leaving state behind. */
async function identityFor(attempt, r = residual("k1_ce"), keyPrefix = "att-1") {
  const probe = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: r.tradingsymbol, net_quantity: r.quantity }],
  });
  await probe.gateway.flattenResidual({ residual: [{ ...r, flatten_attempt: attempt }], keyPrefix });
  return { id: probe.adapter.submits[0].id, intent: probe.journal.rows.get(probe.adapter.submits[0].id) };
}

test("R8/R9: a crash after the durable attempt was created but BEFORE the broker POST does not invent a duplicate attempt", async () => {
  // The exact torn state: `createBoxOrderIntent` committed CREATED and the process died before
  // the SUBMITTING transition, so nothing ever reached the broker.
  const { id, intent } = await identityFor(1);
  const torn = new Journal([{ ...intent, state: "CREATED", filled_quantity: 0, average_price: null, broker_order_id: null, terminal_at: null }]);

  // RESTART. The residual is re-read from Mongo with its generation UNCHANGED (the write-back
  // never happened), so the SAME identity is worked again — which is correct: no POST happened.
  const after = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    journal: torn,
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const res = await after.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });

  assert.equal(
    [...torn.rows.keys()].length,
    1,
    "the restart must NOT create a second logical attempt for work that never reached the broker",
  );
  assert.equal(after.adapter.submits.length, 1, "and it must send the order that was never sent");
  assert.equal(after.adapter.submits[0].id, id, "under the SAME identity");
  assert.equal(res.remaining.length, 0);
});

test("R9b: a crash mid-submit (durably SUBMITTING, broker outcome unknown) is reconciled, never resubmitted", async () => {
  const { id, intent } = await identityFor(1);
  // SUBMITTING means the POST may or may not have landed. The broker has nothing to show.
  const torn = new Journal([{ ...intent, state: "SUBMITTING", filled_quantity: 0, average_price: null, broker_order_id: null, terminal_at: null }]);
  const after = await build({
    script: () => { throw new Error("A MID-SUBMIT CRASH MUST NOT BE BLINDLY RESUBMITTED"); },
    journal: torn,
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const res = await after.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });

  assert.equal(after.adapter.submits.length, 0, "an unknown POST outcome is never duplicated");
  assert.ok(after.adapter.gets.includes(id), "it is reconciled by client id first");
  assert.equal(res.remaining.length, 1, "the exposure stays outstanding and visible");
  assert.equal(res.remaining[0].flatten_attempt, 1, "and the identity is retained for reconciliation");
  assert.ok(after.invariants.some((r) => /broker_state_unknown/.test(r)), "the uncertainty is surfaced");
});

/* ══════════════════ 10-11. crash AFTER the broker submit ══════════════════ */

test("R10/R11: a crash after the broker POST but before the durable terminal update adopts rather than blindly resubmitting", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  // Simulate the crash window: the order EXISTS at the broker and the intent is durably
  // SUBMITTING, but no terminal snapshot was ever written.
  const r = residual("k1_ce");
  const probe = await b.gateway.flattenResidual({ residual: [r], keyPrefix: "att-1" });
  assert.equal(probe.remaining.length, 0);
  const clientId = b.adapter.submits[0].id;

  const torn = new Journal([{ ...b.journal.rows.get(clientId), state: "SUBMITTING", filled_quantity: 0, terminal_at: null }]);
  const after = await build({
    script: () => { throw new Error("A RESTART MUST NOT RESUBMIT AN ORDER THE BROKER ALREADY HAS"); },
    journal: torn,
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  // The broker still has the real, filled order.
  after.adapter.orders.set(clientId, b.adapter.orders.get(clientId));

  const res = await after.gateway.flattenResidual({ residual: [r], keyPrefix: "att-1" });

  assert.equal(after.adapter.submits.length, 0, "no second POST for an order the broker already has");
  assert.ok(after.adapter.gets.includes(clientId), "the existing submission is reconciled by client id");
  assert.equal(res.flattened_by_role.k1_ce, 75, "the broker's real fill is adopted");
  assert.equal(res.remaining.length, 0, "so the exposure is correctly recorded as flat");
  assert.equal(torn.rows.get(clientId).filled_quantity, 75, "and the durable snapshot is repaired");
});

/* ══════════════════ 12. independent identities per role ══════════════════ */

test("R12: multiple residual roles use independent identities and independent generations", async () => {
  const b = await build({
    // k1_ce needs two passes; k2_pe flattens on the first.
    script: ({ req, generation }) => {
      if (req.role === "k2_pe") return { state: "COMPLETE", filled: req.quantity };
      return generation === 1 ? { state: "CANCELLED", filled: 0 } : { state: "COMPLETE", filled: req.quantity };
    },
    held: [
      { exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 },
      { exchange: "NFO", tradingsymbol: "SYM-k2_pe", net_quantity: 75 },
    ],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce"), residual("k2_pe")], 2);

  const ids = b.adapter.submits.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "no two submissions may share an identity");
  assert.equal(history[0].remaining.length, 1, "only the unflattened role survives pass 1");
  assert.equal(history[0].remaining[0].role, "k1_ce");
  assert.equal(history[0].remaining[0].flatten_attempt, 2, "the flattened role's generation is irrelevant to k1_ce's");
  assert.equal(history[0].flattened_by_role.k2_pe, 75);
  assert.equal(history[0].flattened_by_role.k1_ce, 0);
  assert.equal(remaining.length, 0);

  // Each role's identity carries its own role and its own generation.
  assert.ok(ids.every((id) => /:(k1_ce|k2_pe):/.test(id)));
  assert.equal(ids.filter((id) => id.includes(":k1_ce:")).length, 2);
  assert.equal(ids.filter((id) => id.includes(":k2_pe:")).length, 1);
});

test("R12b: two residual entries sharing one role are accounted separately, not collapsed", async () => {
  // The old code matched an order back to its residual BY ROLE, so a second entry for the same
  // role silently inherited the first's fill and its own exposure vanished from the books.
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 110 }],
  });
  const res = await b.gateway.flattenResidual({
    residual: [
      residual("k1_ce", { quantity: 75, created_at: 1_000 }),
      residual("k1_ce", { quantity: 35, created_at: 2_000 }),
    ],
    keyPrefix: "att-1",
  });
  assert.equal(b.adapter.submits.length, 2, "both entries must be worked");
  assert.deepEqual(b.adapter.submits.map((s) => s.quantity).sort((a, c) => a - c), [35, 75]);
  assert.equal(res.flattened_by_role.k1_ce, 110, "the role's flattened quantity is the SUM of both");
  assert.equal(res.remaining.length, 0);
});

/* ══════════════════ 14. ambiguity must never become a duplicate POST ══════════════════ */

test("R14: an ambiguous broker response never becomes a duplicate POST, and is quarantined", async () => {
  const b = await build({
    script: () => new BrokerAmbiguousSubmitError("submit timed out; broker state unknown"),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  const { history, remaining } = await loop(b.gateway, [residual("k1_ce")], 4);

  assert.equal(b.adapter.submits.length, 1, "an ambiguous submission must be attempted exactly ONCE");
  assert.equal(history[0].remaining[0].flatten_attempt, 1, "the generation must NOT advance past an unknown outcome");
  assert.equal(remaining.length, 1, "the exposure stays visible rather than being silently dropped");
  assert.equal(remaining[0].quantity, 75, "and keeps its exact quantity");
  assert.ok(
    b.invariants.some((r) => /broker_state_unknown/.test(r)),
    `an unknown broker outcome must raise an invariant, got: ${JSON.stringify(b.invariants)}`,
  );
  // Quarantine is real: the reduction reservation is still held, so nothing can double-reduce.
  assert.equal(b.manager.status().unknownOrders > 0, true, "the order manager reports the quarantine");
});

test("R14b: a working (non-terminal) order keeps its identity instead of racing a second reduction", async () => {
  const b = await build({
    script: () => ({ state: "UNKNOWN", filled: 0 }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  const res = await b.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });
  assert.equal(res.remaining[0].flatten_attempt, 1, "an order that may still fill keeps its identity");
  assert.ok(b.invariants.some((r) => /broker_state_unknown/.test(r)));
});

/* ══════════════════ nothing-was-sent must NOT burn a generation ══════════════════ */

test("R15: a pass with no executable book keeps the identity — a generation is only spent by the broker", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });
  // A token with no book at all.
  const orphan = residual("k1_ce", { token: 999_999 });
  const res = await b.gateway.flattenResidual({ residual: [orphan], keyPrefix: "att-1" });

  assert.equal(b.adapter.submits.length, 0, "nothing can be sent without an executable touch");
  assert.equal(res.remaining.length, 1);
  assert.equal(res.remaining[0].flatten_attempt, 1, "an unused identity must be reused, not retired");
  assert.equal(res.flatten_charges, 0);
});

test("R16: a gate refusal keeps the identity and never reports a phantom fill", async () => {
  const b = await build({
    script: ({ req }) => ({ state: "COMPLETE", filled: req.quantity }),
    // No attributed exposure at all, so the manager's reduction gate must refuse.
    held: [],
  });
  const res = await b.gateway.flattenResidual({ residual: [residual("k1_ce")], keyPrefix: "att-1" });

  assert.equal(b.adapter.submits.length, 0, "a reduction with no attributed exposure must never reach the broker");
  assert.equal(res.remaining[0].quantity, 75, "the exposure is unchanged");
  assert.equal(res.remaining[0].flatten_attempt, 1, "and the unused identity is preserved");
});

/* ══════════════════ NEGATIVE CONTROL ══════════════════ */

test("NEGATIVE CONTROL: with the OLD write-back (generation never advances) the second POST disappears again", async () => {
  const b = await build({
    script: ({ generation, req }) => generation === 1
      ? { state: "CANCELLED", filled: 0 }
      : { state: "COMPLETE", filled: req.quantity },
    held: [{ exchange: "NFO", tradingsymbol: "SYM-k1_ce", net_quantity: 75 }],
  });

  // This is precisely the pre-fix projection: carry the shrunken residual forward but PIN the
  // generation, so the identity regenerates byte-identically on every pass exactly as the old
  // `stableAttemptId(keyPrefix, residual.created_at, role)` did.
  const { remaining } = await loop(b.gateway, [residual("k1_ce")], 3, {
    writeBack: (r) => ({ ...r, flatten_attempt: 1 }),
  });

  assert.equal(
    b.adapter.submits.length,
    1,
    "PROOF OF CAUSALITY: without the durable generation the residual is submitted once and never again",
  );
  assert.equal(remaining.length, 1, "and the naked exposure survives every later pass");
  assert.equal(remaining[0].quantity, 75);
  // ...whereas the same script WITH the generation flattens it (asserted in R1/R2 above).
});
