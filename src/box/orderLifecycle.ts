/**
 * ORDER LIFECYCLE — the observable stages of a real broker order, and authoritative
 * cumulative-fill accounting.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PART 1: ACK IS NOT FILL  (audit divergences D4, D16)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The durable vocabulary (`BoxOrderIntentState`) is deliberately narrow, because it is
 * enforced as a Mongo query guard (`repository.ts` INTENT_STATE_PREDECESSORS) and every
 * value in it must survive a restart and a schema migration. It collapses several genuinely
 * distinct observable moments into one state:
 *
 *   - "the request is sitting in our queue"  vs  "the POST is on the wire"   → both CREATED/SUBMITTING
 *   - "HTTP 200 with an order id"            vs  "the broker/RMS accepted it" → both ACKNOWLEDGED
 *   - "a cancel was sent"                    vs  "the cancel is confirmed"    → both CANCEL_REQUESTED
 *
 * Those distinctions matter enormously for calibration and for safety reasoning, because
 * each boundary has its own latency distribution and its own failure mode. So this module
 * adds a WIDER, purely-observational stage vocabulary ({@link BoxOrderStage}) and a total
 * mapping from it back onto the durable states ({@link durableStateForStage}).
 *
 * WHY NOT JUST WIDEN THE DURABLE ENUM. Because the Mongo predecessor table is the real
 * state machine for restart safety. Adding states to it means a migration, a new transition
 * table, and a window in which a running process and a stored document disagree about what
 * is legal — for zero safety benefit, since the extra stages are all sub-states of existing
 * ones. Observability gets the richer vocabulary; durability keeps the proven one.
 *
 * THE THREE RULES THIS FILE ENCODES
 *
 *  1. An ACK is not an execution. Neither is an HTTP 200. {@link stageProvesExecution}
 *     returns true for NOTHING — because no stage proves execution. Only cumulative filled
 *     quantity does.
 *  2. A cancel RESPONSE is not proof that no fill occurred. {@link stageAcceptsFurtherFills}
 *     is deliberately TRUE for `CANCEL_REQUESTED` and `CANCEL_PENDING`.
 *  3. Cumulative broker-filled quantity is authoritative. Part 2 is the only sanctioned way
 *     to apply it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PART 2: CUMULATIVE FILL ACCOUNTING  (audit divergences D5, D7)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Both brokers report a CUMULATIVE filled quantity, not a delta. That is a gift, because a
 * cumulative snapshot is naturally idempotent — but only if it is applied through a ledger
 * that enforces monotonicity. Applied naively it is not: a duplicated order-update event
 * double-counts, and an out-of-order event silently rewinds the position.
 *
 * {@link CumulativeFillLedger} is that ledger. It guarantees:
 *
 *   - duplicate events (same broker event identity) are ignored exactly once;
 *   - cumulative quantity NEVER decreases, whatever order events arrive in;
 *   - an overfill is applied (broker truth wins) but LOUDLY FLAGGED, never silently clamped;
 *   - the remainder is always derived, so a retry can never re-request the full quantity.
 *
 * PURITY. No clock, no I/O, no randomness. Timestamps are supplied by the caller from the
 * injected {@link ../executionClock}, so a recorded event stream replays identically.
 */

import type { BoxOrderIntentState } from "./types.js";

/* ═══════════════════════════════ PART 1: stages ═══════════════════════════════ */

/**
 * The observable stages of one broker order.
 *
 * Ordered as a normal lifecycle progresses. Every stage is something we can actually
 * OBSERVE from a retail broker API — none of them require knowledge of the exchange's
 * internal matching state.
 */
export type BoxOrderStage =
  /** Intent constructed; nothing has been queued or sent. */
  | "CREATED"
  /** Accepted into our own scheduler queue. Not yet at the broker in any sense. */
  | "QUEUED"
  /** Dequeued, pacing satisfied, the HTTP request is on the wire. Outcome unknown. */
  | "POSTING"
  /** Transport succeeded and returned a broker order id. Says nothing about the exchange. */
  | "BROKER_ACCEPTED"
  /** The broker reports the order as accepted by its own risk/RMS layer. STILL NOT A FILL. */
  | "ACKNOWLEDGED"
  /** The broker reports the order live at the exchange, resting or crossing. */
  | "WORKING"
  /** Cumulative filled quantity is above zero and below the requested quantity. */
  | "PARTIALLY_FILLED"
  /** Cumulative filled quantity equals the requested quantity. */
  | "FILLED"
  /** We have sent a cancel. FILLS MAY STILL ARRIVE — see stageAcceptsFurtherFills. */
  | "CANCEL_REQUESTED"
  /** The broker accepted the cancel request but has not yet reported a terminal state. */
  | "CANCEL_PENDING"
  /** Terminal: the broker confirmed the residual quantity is cancelled. */
  | "CANCELLED"
  /** Terminal: the broker refused the order. */
  | "REJECTED"
  /** Terminal: the order lapsed at the exchange (validity elapsed) without completing. */
  | "EXPIRED"
  /** We do not know the state. Never treated as "no fill". */
  | "UNKNOWN"
  /** We cannot establish the truth from this session; the durable reconciler must resolve it. */
  | "RECONCILIATION_REQUIRED";

export const BOX_ORDER_STAGES: readonly BoxOrderStage[] = [
  "CREATED",
  "QUEUED",
  "POSTING",
  "BROKER_ACCEPTED",
  "ACKNOWLEDGED",
  "WORKING",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_REQUESTED",
  "CANCEL_PENDING",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
] as const;

/**
 * Map an observable stage onto the durable state it persists as.
 *
 * Total by construction (the switch is exhaustive and the compiler enforces it via
 * `noImplicitReturns`), so a new stage cannot be added without deciding how it persists.
 *
 * The non-obvious choices, stated explicitly because they are lossy:
 *
 *   QUEUED          → CREATED    Nothing has been transmitted, so durably nothing has happened.
 *   POSTING         → SUBMITTING Exactly what SUBMITTING has always meant.
 *   BROKER_ACCEPTED → ACKNOWLEDGED  The durable layer does not distinguish transport
 *                                   acceptance from RMS acceptance. It does not need to:
 *                                   both mean "an order may exist at the broker", which is
 *                                   the only fact restart safety depends on.
 *   WORKING         → OPEN
 *   CANCEL_PENDING  → CANCEL_REQUESTED  Both mean "a cancel is in flight and a fill may
 *                                       still land". Collapsing them is safe precisely
 *                                       because the durable table already allows
 *                                       CANCEL_REQUESTED → COMPLETE.
 *   EXPIRED         → CANCELLED  The durable vocabulary has no EXPIRED. CANCELLED is the
 *                                honest existing terminal-without-completion state, and the
 *                                distinction is preserved in the observability record rather
 *                                than being invented in the durable one.
 */
export function durableStateForStage(stage: BoxOrderStage): BoxOrderIntentState {
  switch (stage) {
    case "CREATED":
    case "QUEUED":
      return "CREATED";
    case "POSTING":
      return "SUBMITTING";
    case "BROKER_ACCEPTED":
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "WORKING":
      return "OPEN";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "COMPLETE";
    case "CANCEL_REQUESTED":
    case "CANCEL_PENDING":
      return "CANCEL_REQUESTED";
    case "CANCELLED":
    case "EXPIRED":
      return "CANCELLED";
    case "REJECTED":
      return "REJECTED";
    case "UNKNOWN":
      return "UNKNOWN";
    case "RECONCILIATION_REQUIRED":
      return "RECONCILIATION_REQUIRED";
  }
}

/**
 * The narrowest observable stage implied by a durable state.
 *
 * Used when rehydrating after a restart: the durable state is all we have, so we must not
 * pretend to know which sub-stage the order was in. Deliberately maps to the CONSERVATIVE
 * member of each collapsed pair (e.g. `ACKNOWLEDGED`, not `BROKER_ACCEPTED`; and
 * `CANCEL_REQUESTED`, not `CANCEL_PENDING`) so nothing is claimed that was not recorded.
 */
export function stageForDurableState(state: BoxOrderIntentState): BoxOrderStage {
  switch (state) {
    case "CREATED":
      return "CREATED";
    case "SUBMITTING":
      return "POSTING";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "OPEN":
      return "WORKING";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "COMPLETE":
      return "FILLED";
    case "CANCEL_REQUESTED":
      return "CANCEL_REQUESTED";
    case "CANCELLED":
      return "CANCELLED";
    case "REJECTED":
      return "REJECTED";
    case "UNKNOWN":
      return "UNKNOWN";
    case "RECONCILIATION_REQUIRED":
      return "RECONCILIATION_REQUIRED";
  }
}

/** Terminal stages: no further fills are possible and the order needs no more work. */
const TERMINAL_STAGES: ReadonlySet<BoxOrderStage> = new Set<BoxOrderStage>([
  "FILLED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

export function isTerminalStage(stage: BoxOrderStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

/**
 * Stages during which the broker may still report additional cumulative fills.
 *
 * THE POINT OF THIS FUNCTION is that `CANCEL_REQUESTED` and `CANCEL_PENDING` are TRUE.
 *
 * A cancel request is a request. Between our DELETE leaving the wire and the broker
 * confirming a terminal state, the exchange may match some or all of the resting quantity.
 * Treating the cancel response as proof of "no further fills" is the single most expensive
 * mistake available here: it silently drops real, irreversible exposure.
 *
 * `UNKNOWN` and `RECONCILIATION_REQUIRED` are also TRUE, for the same reason — not knowing
 * is not the same as knowing nothing happened.
 */
export function stageAcceptsFurtherFills(stage: BoxOrderStage): boolean {
  return !isTerminalStage(stage);
}

/**
 * Whether reaching this stage, on its own, proves that quantity was executed.
 *
 * ALWAYS FALSE. This function exists to be called and to return false, so that the rule is
 * expressed in code rather than in a comment somebody can skip:
 *
 *   - an HTTP 200 proves the request was received, not filled;
 *   - a broker ACK proves the order was accepted, not filled;
 *   - even `FILLED` is a *derived* stage — it is set BECAUSE cumulative quantity reached the
 *     requested quantity, so the quantity is the evidence and the stage is the summary.
 *
 * Execution is proven by {@link CumulativeFillLedger.cumulative} and nothing else.
 */
export function stageProvesExecution(_stage: BoxOrderStage): false {
  return false;
}

/**
 * The stage implied by an authoritative cumulative quantity, when the broker's own status
 * string is absent or unmappable.
 *
 * Quantity first, always: a broker that says "CANCELLED" while reporting a full cumulative
 * fill has filled the order, and this returns FILLED for that case.
 */
export function stageFromCumulativeQuantity(args: {
  requestedQty: number;
  cumulativeQty: number;
  /** True when the broker has confirmed a terminal cancellation of the remainder. */
  cancelConfirmed?: boolean;
}): BoxOrderStage {
  const requested = Math.max(0, Math.floor(args.requestedQty));
  const filled = Math.max(0, Math.floor(args.cumulativeQty));
  if (requested > 0 && filled >= requested) return "FILLED";
  if (args.cancelConfirmed) return "CANCELLED";
  if (filled > 0) return "PARTIALLY_FILLED";
  return "WORKING";
}

/* ═══════════════════════ PART 2: cumulative fill ledger ═══════════════════════ */

/** Where a cumulative-quantity observation came from. Recorded for audit and diagnostics. */
export type FillEventSource =
  /** A REST order-status poll — the reconciliation/verification path. */
  | "rest_poll"
  /** A broker order-update stream event — the fast path. */
  | "order_update"
  /** A broker webhook/postback. Lowest trust; never the sole basis for a state change. */
  | "postback"
  /** The broker's trade book, which carries stable per-trade identities. */
  | "trade_book"
  /** The durable reconciler, resolving an uncertain order after the fact. */
  | "reconciliation"
  /** Deterministic paper simulation. */
  | "paper";

/**
 * One observation of a broker's CUMULATIVE filled quantity for one order.
 *
 * Note what this is NOT: it is not a delta, and it is not "a fill". It is a snapshot of the
 * broker's running total. Modelling it this way is what makes duplicate delivery harmless.
 */
export interface CumulativeFillEvent {
  /** The broker's cumulative filled quantity for this order AFTER the event. Authoritative. */
  readonly cumulativeQty: number;
  /** The broker's cumulative average fill price, when reported. */
  readonly averagePrice?: number | null;
  /**
   * A stable identity for this event, when the broker supplies one (an exchange trade id, an
   * order-update sequence token). Two events with the same identity are the same event, and
   * the second is ignored. Absent ⇒ dedupe falls back to cumulative monotonicity alone,
   * which is still safe, just less precise.
   */
  readonly eventId?: string | null;
  /**
   * A monotonically increasing broker-side sequence number, when available. Used only to
   * DETECT and report out-of-order delivery; correctness never depends on it, because
   * cumulative monotonicity already guarantees it.
   */
  readonly sequence?: number | null;
  /** Monotonic ms the event was observed locally. For latency measurement. */
  readonly observedAtMono?: number | null;
  /** Wall-clock ms the event was observed locally. For audit. */
  readonly observedAtWall?: number | null;
  readonly source: FillEventSource;
}

export type FillApplyOutcome =
  /** New cumulative quantity accepted. `delta` is the newly-observed quantity. */
  | "applied"
  /**
   * Accepted, but the broker reports MORE filled than we requested. Applied because broker
   * truth wins, and flagged because it is an invariant violation the caller must quarantine.
   */
  | "applied_overfill"
  /** Same broker event identity already applied. Ignored; delta 0. */
  | "duplicate_event"
  /**
   * The event carries no new information: its cumulative quantity is at or below what we
   * have already recorded. This is the branch that makes an out-of-order event harmless.
   */
  | "stale_cumulative"
  /** The event was malformed (non-finite / negative quantity). Ignored; delta 0. */
  | "invalid";

export interface FillApplyResult {
  readonly outcome: FillApplyOutcome;
  /** Newly-observed quantity attributable to this event. Zero unless it was applied. */
  readonly delta: number;
  /** Cumulative filled quantity after applying. Never lower than before. */
  readonly cumulative: number;
  /** Requested − cumulative, floored at zero. What a retry may ask for; never more. */
  readonly remaining: number;
  readonly averagePrice: number | null;
  /** cumulative − requested when positive, else 0. Non-zero ⇒ invariant violation. */
  readonly overfill: number;
  /**
   * True when this event arrived with a sequence number at or below the highest already
   * seen. Purely diagnostic — the cumulative rule has already kept the ledger correct.
   */
  readonly sequenceRegression: boolean;
}

export interface FillLedgerSnapshot {
  readonly clientOrderId: string;
  readonly requestedQty: number;
  readonly cumulative: number;
  readonly remaining: number;
  readonly averagePrice: number | null;
  readonly overfill: number;
  /** Events that changed the cumulative quantity. */
  readonly appliedEvents: number;
  /** Events ignored as duplicates by broker event identity. */
  readonly duplicateEvents: number;
  /** Events ignored because they carried no new cumulative information. */
  readonly staleEvents: number;
  /** Events whose sequence number went backwards. */
  readonly sequenceRegressions: number;
  readonly lastSource: FillEventSource | null;
  readonly firstFillAtMono: number | null;
  readonly lastFillAtMono: number | null;
  readonly firstFillAtWall: number | null;
  readonly lastFillAtWall: number | null;
}

/**
 * Idempotent, monotonic, cumulative-authoritative fill accounting for ONE order.
 *
 * Create one per client order id and route EVERY observation of that order's filled quantity
 * through {@link apply} — REST polls, order-update events, postbacks, trade-book reads and
 * reconciliation alike. That single funnel is what makes duplicate and out-of-order delivery
 * a non-event rather than a position-accounting bug.
 */
export class CumulativeFillLedger {
  private readonly requested: number;
  private cumulativeQty = 0;
  private avgPrice: number | null = null;
  private overfillQty = 0;
  private appliedCount = 0;
  private duplicateCount = 0;
  private staleCount = 0;
  private regressionCount = 0;
  private highestSequence: number | null = null;
  private lastSourceSeen: FillEventSource | null = null;
  private firstFillMono: number | null = null;
  private lastFillMono: number | null = null;
  private firstFillWall: number | null = null;
  private lastFillWall: number | null = null;
  /**
   * Broker event identities already applied. Bounded by the number of events for ONE order,
   * which is bounded by the order's own lifetime — so this cannot grow without limit. A
   * per-process set would; that is why the ledger is per-order.
   */
  private readonly seenEventIds = new Set<string>();

  constructor(
    readonly clientOrderId: string,
    requestedQty: number,
  ) {
    this.requested = Number.isFinite(requestedQty) ? Math.max(0, Math.floor(requestedQty)) : 0;
  }

  get requestedQty(): number {
    return this.requested;
  }

  /** Authoritative cumulative filled quantity. THE evidence that execution occurred. */
  get cumulative(): number {
    return this.cumulativeQty;
  }

  /**
   * Outstanding quantity. A retry, a cancel or an unwind must use THIS, never the original
   * requested quantity — re-requesting the full amount after a partial fill doubles exposure.
   */
  get remaining(): number {
    return Math.max(0, this.requested - this.cumulativeQty);
  }

  get averagePrice(): number | null {
    return this.avgPrice;
  }

  /** Non-zero when the broker reported more filled than requested. Must be quarantined. */
  get overfill(): number {
    return this.overfillQty;
  }

  get hasOverfill(): boolean {
    return this.overfillQty > 0;
  }

  /** True once any quantity has been confirmed — i.e. real, irreversible exposure exists. */
  get hasExposure(): boolean {
    return this.cumulativeQty > 0;
  }

  /**
   * Apply one cumulative-quantity observation.
   *
   * The rules, in the order they are checked:
   *
   *  1. MALFORMED → ignore. A non-finite or negative quantity is not information.
   *  2. DUPLICATE IDENTITY → ignore exactly once. This is what stops a redelivered
   *     order-update event from double-counting.
   *  3. NOT-HIGHER CUMULATIVE → ignore. This is what stops an out-of-order event from
   *     rewinding the position, and it is why correctness does not depend on sequence
   *     numbers being present or trustworthy.
   *  4. Otherwise apply. If the new cumulative exceeds the requested quantity the excess is
   *     recorded and reported as `applied_overfill` — applied because the broker's number is
   *     the truth, reported because it means our own quantity model was wrong.
   */
  apply(event: CumulativeFillEvent): FillApplyResult {
    const raw = event.cumulativeQty;
    if (!Number.isFinite(raw) || raw < 0) {
      return this.result("invalid", 0, false);
    }
    const observed = Math.floor(raw);

    // A recognised identity means we have already accounted for this exact event.
    const id = event.eventId?.trim();
    if (id) {
      if (this.seenEventIds.has(id)) {
        this.duplicateCount++;
        return this.result("duplicate_event", 0, false);
      }
      this.seenEventIds.add(id);
    }

    // Detect (but do not depend on) out-of-order delivery.
    let regression = false;
    if (event.sequence != null && Number.isFinite(event.sequence)) {
      if (this.highestSequence !== null && event.sequence <= this.highestSequence) {
        regression = true;
        this.regressionCount++;
      } else {
        this.highestSequence = event.sequence;
      }
    }

    // Cumulative quantity is monotonic. An observation that does not exceed what we already
    // know carries no new quantity — whether it is a re-poll, a redelivery, or a genuinely
    // late event that overtook a newer one.
    if (observed <= this.cumulativeQty) {
      this.staleCount++;
      // A stale event may still carry a better average price for quantity we already hold,
      // but it must never move the quantity. Prices are only trusted from events that also
      // advanced the fill, so nothing is updated here.
      return this.result("stale_cumulative", 0, regression);
    }

    const delta = observed - this.cumulativeQty;
    this.cumulativeQty = observed;
    this.appliedCount++;
    this.lastSourceSeen = event.source;

    if (event.averagePrice != null && Number.isFinite(event.averagePrice) && event.averagePrice > 0) {
      this.avgPrice = event.averagePrice;
    }

    if (event.observedAtMono != null && Number.isFinite(event.observedAtMono)) {
      if (this.firstFillMono === null) this.firstFillMono = event.observedAtMono;
      this.lastFillMono = event.observedAtMono;
    }
    if (event.observedAtWall != null && Number.isFinite(event.observedAtWall)) {
      if (this.firstFillWall === null) this.firstFillWall = event.observedAtWall;
      this.lastFillWall = event.observedAtWall;
    }

    // Overfill: applied, never clamped, always surfaced.
    this.overfillQty = Math.max(0, this.cumulativeQty - this.requested);
    return this.result(this.overfillQty > 0 ? "applied_overfill" : "applied", delta, regression);
  }

  snapshot(): FillLedgerSnapshot {
    return {
      clientOrderId: this.clientOrderId,
      requestedQty: this.requested,
      cumulative: this.cumulativeQty,
      remaining: this.remaining,
      averagePrice: this.avgPrice,
      overfill: this.overfillQty,
      appliedEvents: this.appliedCount,
      duplicateEvents: this.duplicateCount,
      staleEvents: this.staleCount,
      sequenceRegressions: this.regressionCount,
      lastSource: this.lastSourceSeen,
      firstFillAtMono: this.firstFillMono,
      lastFillAtMono: this.lastFillMono,
      firstFillAtWall: this.firstFillWall,
      lastFillAtWall: this.lastFillWall,
    };
  }

  private result(outcome: FillApplyOutcome, delta: number, sequenceRegression: boolean): FillApplyResult {
    return {
      outcome,
      delta,
      cumulative: this.cumulativeQty,
      remaining: this.remaining,
      averagePrice: this.avgPrice,
      overfill: this.overfillQty,
      sequenceRegression,
    };
  }
}

/**
 * The quantity a follow-up operation may legitimately request.
 *
 * Phase 29 invariant: never retry the full quantity when only a remainder is outstanding.
 * Returns 0 when nothing is outstanding, which callers must treat as "do not submit".
 */
export function outstandingQuantity(requestedQty: number, cumulativeQty: number): number {
  const requested = Number.isFinite(requestedQty) ? Math.max(0, Math.floor(requestedQty)) : 0;
  const filled = Number.isFinite(cumulativeQty) ? Math.max(0, Math.floor(cumulativeQty)) : 0;
  return Math.max(0, requested - filled);
}

/**
 * Final quantity accounting for an order that has finished, cancel race included.
 *
 * This is the arithmetic from the brief, made explicit and testable: an order for 75 that had
 * 40 filled when a cancel was requested, took 12 more while the cancel was in flight, and
 * whose remainder was then cancelled, ends as `filled 52 / cancelled 23` — NOT `filled 40`.
 *
 * The only input that decides `filled` is the broker's final cumulative quantity. The
 * quantity known at cancel-request time is recorded separately, purely so the race is
 * visible in diagnostics.
 */
export interface TerminalQuantityAccounting {
  readonly requested: number;
  /** Authoritative final cumulative filled quantity. */
  readonly filled: number;
  /** requested − filled: the quantity the broker confirmed it would not fill. */
  readonly cancelled: number;
  /** Cumulative quantity at the moment the cancel was requested, when a cancel happened. */
  readonly filledAtCancelRequest: number | null;
  /** Quantity that filled AFTER the cancel request — the race, quantified. */
  readonly racedQuantity: number;
  /** True when any quantity filled after the cancel was requested. */
  readonly cancelRaced: boolean;
}

export function terminalQuantityAccounting(args: {
  requestedQty: number;
  /** The broker's FINAL cumulative filled quantity. Authoritative. */
  finalCumulativeQty: number;
  /** Cumulative quantity observed at the instant the cancel request was sent, if any. */
  cumulativeAtCancelRequest?: number | null;
}): TerminalQuantityAccounting {
  const requested = Math.max(0, Math.floor(args.requestedQty));
  const filled = Math.max(0, Math.floor(args.finalCumulativeQty));
  const atCancel =
    args.cumulativeAtCancelRequest == null || !Number.isFinite(args.cumulativeAtCancelRequest)
      ? null
      : Math.max(0, Math.floor(args.cumulativeAtCancelRequest));
  const raced = atCancel === null ? 0 : Math.max(0, filled - atCancel);
  return {
    requested,
    filled,
    cancelled: Math.max(0, requested - filled),
    filledAtCancelRequest: atCancel,
    racedQuantity: raced,
    cancelRaced: raced > 0,
  };
}
