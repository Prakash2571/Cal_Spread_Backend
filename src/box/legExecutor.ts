/**
 * INDEPENDENT PAPER ORDER LIFECYCLES — one per box leg.
 *
 * WHY THIS MODULE EXISTS
 *
 * A box is four orders, and four-leg arbitrage is killed by the things a single
 * shared snapshot cannot express: legs filling at different instants, one leg
 * resting while the others are already on, a leg that only PARTIALLY fills and
 * rests for more liquidity, and a leg that never fills. So each leg here is a real
 * order with its own lifecycle:
 *
 *   CREATED → SUBMITTED → IN_FLIGHT → (arrival) walk the book within the LIMIT
 *      → FILLED                    (took the whole lot)
 *      → PARTIALLY_FILLED → rest → complete on a later book → FILLED
 *                                 → or TIMED_OUT at arrival + legTimeoutMs
 *      → PENDING (nothing executable within the limit yet) → …
 *
 * FOUR RULES THAT MUST NOT REGRESS
 *
 *  1. MARKETABLE LIMIT, NOT A MARKET ORDER. Every order carries a limit price a
 *     bounded number of ticks past the reference touch (see executionPolicy /
 *     orderPricing). The book is walked only down to that limit; a level worse
 *     than the limit is never taken. An order that cannot fill within its limit
 *     RESTS — it does not consume a runaway price.
 *
 *  2. NEVER INVENT A PRICE. Every fill slice is an observed executable level from a
 *     real WebSocket book, recorded with its version and receive timestamp. No
 *     random slippage anywhere.
 *
 *  3. RESTING BOOK. A book need not publish a new tick after arrival to be valid:
 *     at arrival we walk the latest known valid book. Only what it cannot fill
 *     rests, and a later update may complete it.
 *
 *  4. CONSERVATIVE QUEUE. Displayed depth is not assumed to be all ours (see the
 *     queue model in orderPricing). Deterministic; no randomness.
 *
 * EVENT-DRIVEN, YET DETERMINISTIC
 *
 * Pending/partial orders are woken by the quote store's `subscribe()` seam, which
 * fires synchronously as a depth packet is applied — so a fill is stamped with the
 * TICK'S OWN timestamp. Timers are used only for arrival and timeout deadlines. The
 * clock and the sleep are injected, so a recorded tick stream reproduces
 * byte-identical fills, prices and P&L. Scheduling is driven by ONE coordinating
 * loop, never four concurrent waiters (which would race a shared simulated clock).
 */

import type { BoxExecutionPolicy, ExecutionPhase } from "./executionPolicy.js";
import { round2, slippagePerUnit } from "./math.js";
import { touchPrice, walkDepth } from "./orderPricing.js";
import type { BoxQuoteStore } from "./quotes.js";
import type {
  BoxExecutionFailureReason,
  BoxLegRole,
  BoxOptionInstrument,
  BoxQuote,
  OrderSide,
  PaperLegExecution,
  PaperLegStatus,
  PaperOrderPricing,
} from "./types.js";

/** One order to work: what to trade, and the reference it is priced against. */
export interface LegOrderRequest {
  role: BoxLegRole;
  side: OrderSide;
  inst: BoxOptionInstrument;
  /** The touch visible at DETECTION — the reference the limit is priced against. */
  detected_price: number | null;
  detected_qty: number;
  /** Requested quantity (one lot on entry; the outstanding quantity on an unwind). */
  quantity: number;
  /** Optional authoritative LIMIT envelope supplied by a broker-neutral adapter. */
  pricing?: PaperOrderPricing;
}

/**
 * Dependencies shared by every run.
 *
 * CONCURRENCY CONTRACT: everything here must be immutable or safe to share across
 * simultaneous executions. NOTHING run-specific may live on the executor instance
 * — see the note on `run()`.
 */
/**
 * Shared paper liquidity reservation (live-parity only). Satisfied by
 * `PaperLiquidityLedger`; kept as a narrow interface so the executor does not depend on
 * the concrete class and tests can inject a stub.
 */
export interface LegLiquidityReservation {
  reservedAt(gen: number, token: number, side: OrderSide, price: number, version: number): number;
  reserve(gen: number, token: number, side: OrderSide, price: number, version: number, qty: number): number;
}

/** A deterministic per-order latency source (live-parity only). */
export interface LegLatencySource {
  next(): number;
}

export interface LegExecutorDeps {
  policy: BoxExecutionPolicy;
  quotes: BoxQuoteStore;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** Optional: records an internal per-order retry. Never a new strategy attempt. */
  metrics?: { recordLogicalRetry: () => void } | undefined;
  /**
   * LIVE-PARITY ONLY. When present, displayed liquidity is a shared finite resource:
   * each fill reserves what it consumed so a concurrent attempt cannot take it again.
   * Undefined in standard paper ⇒ the fill path is byte-identical to before.
   */
  reservation?: LegLiquidityReservation | undefined;
  /**
   * LIVE-PARITY ONLY. Per-order latency draw; undefined ⇒ the run-level constant is
   * used exactly as before.
   */
  latency?: LegLatencySource | undefined;
  /**
   * LIVE-PARITY ONLY. Computes each leg's simulated EXCHANGE-ARRIVAL time from the shared
   * scheduler — i.e. the four legs pass through the same priority queue + concurrency cap +
   * transport pacing the live OrderManager enforces, instead of all arriving at
   * `submit + latency`. Returns absolute arrival times per leg, in the run's leg order.
   *
   * When present (and the run is parallel) it OVERRIDES the per-leg `latency` draw for
   * arrival timing. Undefined ⇒ arrivals fall back to `latency`/the constant exactly as
   * before, so standard paper is byte-identical. Applied only to the initial parallel
   * submit; sequential releases remain fill-gated.
   */
  arrivalPlanner?:
    | ((args: { count: number; submitAt: number; phase: ExecutionPhase }) => number[])
    | undefined;
  /** Feed/broker generation for reservation keys; defaults to 0. */
  generation?: (() => number) | undefined;
}

/** What the run produced. */
export interface LegRunResult {
  legs: PaperLegExecution[];
  /** Set when the run was cut short (feed/market/discovery), else null. */
  aborted: { reason: BoxExecutionFailureReason; detail: string } | null;
  /**
   * token → the EXACT book each leg last filled a slice from.
   *
   * Essential for final qualification and depth audit: legs fill at different
   * instants, so the store's current books are not what we traded.
   */
  booksAtFill: Map<number, BoxQuote>;
}

/** An order plus the bookkeeping the scheduler needs. */
interface LegState {
  leg: PaperLegExecution;
  req: LegOrderRequest;
  /** Terminal states need no further scheduling. */
  done: boolean;
  /** How many times `tryFill` has already been attempted for this order. */
  fillAttempts: number;
}

/** Statuses that are fully resolved — no further fills possible. */
const TERMINAL: ReadonlySet<PaperLegStatus> = new Set<PaperLegStatus>([
  "FILLED",
  "TIMED_OUT",
  "CANCELLED",
  "FAILED",
  "UNWOUND",
  "UNWIND_FAILED",
]);

export class LegExecutor {
  constructor(private deps: LegExecutorDeps) {}

  /**
   * Work all four orders.
   *
   * parallel   — every order is submitted at `submitAt` and travels concurrently.
   * sequential — the next order is submitted only once the previous one FILLED.
   *
   * CONCURRENCY: every piece of run-specific state below (leg states, fill books,
   * the quote listener, the abort predicate) is a LOCAL of this method. Nothing is
   * stored on `this`, so any number of executions may share one executor instance
   * without observing or corrupting each other.
   */
  async run(args: {
    requests: LegOrderRequest[];
    /** When the strategy released the orders. */
    submitAt: number;
    /** Per-leg travel time; arrival = submit + this. */
    latencyMs?: number;
    /** entry (default) or unwind — decides the chase band the policy applies. */
    phase?: ExecutionPhase;
    /** Deterministic id prefix for order ids ("<key>:entry", "<key>:unwind"). */
    orderIdPrefix: string;
    /**
     * Reason to abandon everything still working — supplied PER RUN, never held on
     * the instance. Already-filled quantity is never touched: those fills happened.
     */
    abortReason?: () => { reason: BoxExecutionFailureReason; detail: string } | null;
  }): Promise<LegRunResult> {
    const policy = this.deps.policy;
    const phase: ExecutionPhase = args.phase ?? "entry";
    const latency = Math.max(0, args.latencyMs ?? policy.latencyMs);
    const timeout = policy.legTimeoutMs;
    const sequential = policy.legExecutionMode === "sequential";
    const maxAgeMs = policy.quoteMaxAgeMs;

    const states: LegState[] = args.requests.map((req) => ({
      req,
      done: false,
      fillAttempts: 0,
      leg: blankLeg(req, args.orderIdPrefix, phase),
    }));

    // LIVE-PARITY: when a scheduler is wired in, the legs' EXCHANGE-ARRIVAL times come from
    // the shared queue + concurrency + transport-pacing model, not from an independent
    // per-leg latency draw. Computed once, for the initial parallel submit only.
    const plannedArrivals =
      this.deps.arrivalPlanner && !sequential
        ? this.deps.arrivalPlanner({ count: states.length, submitAt: args.submitAt, phase })
        : null;

    // Submit: in parallel every order goes now; sequentially only the first does.
    for (const [i, st] of states.entries()) {
      if (!sequential || i === 0) this.submit(st, args.submitAt, latency, plannedArrivals?.[i]);
    }

    const booksAtFill = new Map<number, BoxQuote>();

    // Pending/partial orders are filled by book updates at the TICK's own timestamp.
    const unsubscribe = this.deps.quotes.subscribe((changed, at) => {
      const touched = new Set(changed);
      for (const st of states) {
        if (st.done) continue;
        if (st.leg.status !== "PENDING" && st.leg.status !== "PARTIALLY_FILLED") continue;
        if (!touched.has(st.req.inst.token)) continue;
        // A timed-out order must not be revived by a later tick.
        if (st.leg.timeout_at !== null && at > st.leg.timeout_at) continue;
        // A book update woke an order that already tried and failed/partially
        // filled at least once — this is a genuine internal retry of the SAME
        // order, never a new strategy attempt.
        if (st.fillAttempts > 0) this.deps.metrics?.recordLogicalRetry();
        st.fillAttempts++;
        this.tryFill(st, at, phase, maxAgeMs, booksAtFill);
      }
    });

    let aborted: LegRunResult["aborted"] = null;

    try {
      let guard = 0;
      for (;;) {
        if (++guard > 10_000) break; // never spin forever on a stuck clock

        const abort = args.abortReason?.() ?? null;
        if (abort) {
          aborted = abort;
          for (const st of states) {
            if (st.done) continue;
            this.abandon(st, abort.detail);
          }
          break;
        }

        const next = this.nextBoundary(states);
        if (next === null) break; // everything resolved

        if (next > this.deps.now()) {
          const step = policy.executionPollMs;
          await this.deps.wait(Math.min(next - this.deps.now(), step));
          if (this.deps.now() < next) continue; // not at the boundary yet
        }
        const at = this.deps.now();

        // 1) Orders that have now ARRIVED: begin resting and try the current book.
        for (const st of states) {
          if (st.done || st.leg.status !== "IN_FLIGHT") continue;
          if (st.leg.arrival_at > at) continue;
          st.leg.status = "PENDING";
          st.leg.pending_since = at;
          st.leg.timeout_at = st.leg.arrival_at + timeout;

          // EVENT-LOOP OVERSHOOT: if we woke after this order's deadline, it expired
          // in the market — it must not fill at a price from after its own timeout.
          if (at > st.leg.timeout_at) {
            this.expire(st, timeout);
            if (sequential) this.cancelRemaining(states, st);
            continue;
          }

          if (st.fillAttempts > 0) this.deps.metrics?.recordLogicalRetry();
          st.fillAttempts++;
          const result = this.tryFill(st, at, phase, maxAgeMs, booksAtFill);
          // Sequential: only a COMPLETE fill releases the next order.
          if (sequential && result === "filled") this.submitNext(states, st, at, latency);
        }

        // 2) Orders still working at their deadline: give up (keeping any partial).
        for (const st of states) {
          if (st.done) continue;
          if (st.leg.status !== "PENDING" && st.leg.status !== "PARTIALLY_FILLED") continue;
          if (st.leg.timeout_at === null || st.leg.timeout_at > at) continue;
          this.expire(st, timeout);
          if (sequential) this.cancelRemaining(states, st);
        }
      }
    } finally {
      unsubscribe();
    }

    // Anything still open (guard tripped) is recorded honestly, never as a fill.
    for (const st of states) {
      if (!st.done) this.abandon(st, st.leg.fail_reason ?? "unresolved when the run ended");
    }

    return { legs: states.map((s) => s.leg), aborted, booksAtFill };
  }

  /* ------------------------------- internals ------------------------------ */

  private submit(st: LegState, submitAt: number, latencyMs: number, plannedArrivalAt?: number): void {
    st.leg.status = "IN_FLIGHT";
    st.leg.submit_at = submitAt;
    // LIVE-PARITY: a scheduler-computed arrival reflects the leg's whole trip through the
    // queue + transport pacing; it wins over any per-leg latency draw. Clamped so an
    // arrival can never precede submission.
    if (plannedArrivalAt !== undefined && Number.isFinite(plannedArrivalAt)) {
      st.leg.arrival_at = Math.max(submitAt, plannedArrivalAt);
      return;
    }
    // Live-parity draws a per-order latency from the deterministic source; standard uses
    // the single run-level constant, unchanged.
    const latency = this.deps.latency ? Math.max(0, this.deps.latency.next()) : latencyMs;
    st.leg.arrival_at = submitAt + latency;
  }

  /** Sequential mode: release the order after `afterState`, timed from its fill. */
  private submitNext(states: LegState[], afterState: LegState, at: number, latencyMs: number): void {
    const i = states.indexOf(afterState);
    const next = states[i + 1];
    if (!next || next.leg.status !== "CREATED") return;
    this.submit(next, at, latencyMs);
  }

  /** Sequential mode: never submit the legs behind a failed one. */
  private cancelRemaining(states: LegState[], afterState: LegState): void {
    for (let i = states.indexOf(afterState) + 1; i < states.length; i++) {
      const st = states[i];
      if (!st || st.done || st.leg.status !== "CREATED") continue;
      st.leg.status = "FAILED";
      st.leg.resolved_at = st.leg.submit_at;
      st.leg.fail_reason = "not submitted — an earlier leg failed (sequential mode)";
      st.done = true;
    }
  }

  /** The order's deadline passed while it was still not fully filled. */
  private expire(st: LegState, timeoutMs: number): void {
    st.leg.status = "TIMED_OUT";
    // Report the DEADLINE as the resolution instant, not a late wake-up.
    st.leg.resolved_at = st.leg.timeout_at ?? this.deps.now();
    st.leg.fail_reason =
      `still unfilled ${timeoutMs}ms after arriving — ` +
      (st.leg.fill_qty > 0
        ? `only ${st.leg.fill_qty} of ${st.leg.quantity} filled within the limit`
        : "no executable quantity within the limit");
    st.done = true;
  }

  /**
   * Abandon an unfilled/partial order because the run was cut short.
   *
   * A partial keeps its fill (that quantity was really acquired) and becomes
   * CANCELLED so the outstanding exposure stays visible; a zero-fill order becomes
   * FAILED. A leg that already reached a terminal state is left untouched.
   */
  private abandon(st: LegState, detail: string): void {
    if (TERMINAL.has(st.leg.status)) {
      st.done = true;
      return;
    }
    st.leg.status = st.leg.fill_qty > 0 ? "CANCELLED" : "FAILED";
    st.leg.resolved_at = this.deps.now();
    st.leg.fail_reason = detail;
    st.done = true;
  }

  /**
   * The next instant anything can happen: the earliest pending arrival, or the
   * earliest working order's deadline. null when every order is resolved.
   */
  private nextBoundary(states: LegState[]): number | null {
    let next: number | null = null;
    const consider = (t: number | null) => {
      if (t === null) return;
      if (next === null || t < next) next = t;
    };
    for (const st of states) {
      if (st.done) continue;
      if (st.leg.status === "IN_FLIGHT") consider(st.leg.arrival_at);
      else if (st.leg.status === "PENDING" || st.leg.status === "PARTIALLY_FILLED") {
        consider(st.leg.timeout_at);
      }
      // CREATED legs (sequential, not yet released) are driven by the leg ahead.
    }
    return next;
  }

  /**
   * Attempt to fill (more of) an order from the CURRENT book by walking depth
   * within the order's limit.
   *
   * Returns "filled" (order complete), "partial" (some quantity taken, remainder
   * rests) or "none" (nothing executable within the limit on this book). Records
   * the book it looked at either way, so an order that never filled still shows
   * what it was seeing — which is what makes an abort diagnosable.
   */
  private tryFill(
    st: LegState,
    at: number,
    phase: ExecutionPhase,
    maxAgeMs: number,
    booksAtFill: Map<number, BoxQuote>,
  ): "filled" | "partial" | "none" {
    const { leg, req } = st;
    const quote = this.deps.quotes.get(req.inst.token);
    if (!quote) {
      leg.fail_reason = "no book for this instrument yet";
      return "none";
    }

    const age = at - quote.at;
    // A book that has aged out is not evidence of an executable price. Keep resting.
    if (!(age >= 0 && age <= maxAgeMs)) {
      leg.fail_reason = `book is stale (${age}ms) — waiting for a refresh`;
      return "none";
    }

    // Price the order the first time it can see a book (reference = detection touch,
    // or the current touch when detection had none). The limit is FIXED from here.
    if (!leg.pricing) {
      const ref = leg.detected_price ?? touchPrice(req.side, quote.bids, quote.asks);
      if (ref === null || !(ref > 0)) {
        leg.fail_reason = `no ${req.side === "BUY" ? "ask" : "bid"} to price against`;
        return "none";
      }
      leg.pricing = this.deps.policy.priceOrder({
        side: req.side,
        quantity: req.quantity,
        referencePrice: ref,
        inst: req.inst,
        phase,
      });
    }

    const levels = req.side === "BUY" ? quote.asks : quote.bids;
    // Live-parity: shrink each level by what concurrent attempts already reserved.
    // Undefined in standard paper ⇒ walkDepth receives no `reserved` and is unchanged.
    const gen = this.deps.generation?.() ?? 0;
    const reservation = this.deps.reservation;
    const reservedLookup = reservation
      ? (price: number, version: number | null): number =>
          reservation.reservedAt(gen, req.inst.token, req.side, price, version ?? quote.version)
      : undefined;
    const walk = walkDepth({
      side: req.side,
      levels,
      remainingQty: leg.remaining_qty,
      limitPrice: leg.pricing.limit_price,
      queueModel: this.deps.policy.queueModel,
      haircutPct: this.deps.policy.queueHaircutPct,
      at,
      quoteVersion: quote.version,
      reserved: reservedLookup,
    });

    if (walk.filled_qty <= 0) {
      // Either nothing within the limit, or the queue haircut left nothing for us.
      const touch = touchPrice(req.side, quote.bids, quote.asks);
      leg.fail_reason =
        touch !== null && ((req.side === "BUY" && touch > leg.pricing.limit_price) ||
          (req.side === "SELL" && touch < leg.pricing.limit_price))
          ? `touch ${touch} is past the limit ${leg.pricing.limit_price}`
          : `no executable quantity within the limit ${leg.pricing.limit_price}`;
      return "none";
    }

    // Live-parity: commit what we consumed so a concurrent attempt sees it gone. Done
    // before aggregating (order irrelevant; both are synchronous). No-op in standard.
    if (reservation) {
      for (const s of walk.slices) {
        reservation.reserve(gen, req.inst.token, req.side, s.price, s.quote_version ?? quote.version, s.qty);
      }
    }

    // Apply the slices and update the running aggregate.
    for (const s of walk.slices) leg.fills.push(s);
    leg.fill_qty += walk.filled_qty;
    leg.remaining_qty = Math.max(0, leg.quantity - leg.fill_qty);
    const avg = weightedAverage(leg.fills);
    leg.fill_price = avg;
    leg.average_fill_price = avg;
    leg.quote_version = quote.version;
    leg.book_at = quote.at;
    leg.book_exchange_at = quote.exchange_at;
    leg.book_age_ms = age;
    const perUnit = slippagePerUnit(req.side, req.detected_price, avg);
    leg.slippage = perUnit === null ? null : round2(perUnit * leg.fill_qty);
    leg.fail_reason = null;
    booksAtFill.set(req.inst.token, quote);

    if (leg.remaining_qty <= 0) {
      leg.status = "FILLED";
      leg.fill_at = at;
      leg.resolved_at = at;
      st.done = true;
      return "filled";
    }
    // Some quantity taken; the remainder rests for later liquidity.
    leg.status = "PARTIALLY_FILLED";
    return "partial";
  }
}

/** Quantity-weighted average price across a set of fill slices. */
function weightedAverage(slices: { price: number; qty: number }[]): number | null {
  let q = 0;
  let v = 0;
  for (const s of slices) {
    q += s.qty;
    v += s.price * s.qty;
  }
  return q > 0 ? round2(v / q) : null;
}

/** A freshly created order, before submission. */
function blankLeg(req: LegOrderRequest, orderIdPrefix: string, phase: ExecutionPhase): PaperLegExecution {
  const orderId = `${orderIdPrefix}:${req.role}`;
  return {
    role: req.role,
    side: req.side,
    token: req.inst.token,
    tradingsymbol: req.inst.tradingsymbol,
    order_id: orderId,
    client_order_id: orderId,
    pricing: req.pricing ? { ...req.pricing } : null,
    detected_price: req.detected_price,
    detected_qty: req.detected_qty,
    submit_at: 0,
    arrival_at: 0,
    pending_since: null,
    timeout_at: null,
    fill_at: null,
    resolved_at: null,
    fill_price: null,
    average_fill_price: null,
    quantity: req.quantity,
    requested_qty: req.quantity,
    fill_qty: 0,
    remaining_qty: req.quantity,
    fills: [],
    quote_version: null,
    book_at: null,
    book_exchange_at: null,
    book_age_ms: null,
    slippage: null,
    status: "CREATED",
    unwind_price: null,
    unwind_slippage: null,
    unwound_qty: 0,
    fail_reason: null,
    // `phase` is not stored on the leg; it is captured by the order id prefix
    // ("…:entry" / "…:unwind") and used only to select the chase band.
  };
}

/* ------------------------------ fill analytics ----------------------------- */

/** Fill-timing summary over a finished set of orders. */
export interface FillTiming {
  /** max(fill_at) − min(fill_at) across FULLY FILLED legs — the dispersion. */
  first_to_last_fill_ms: number | null;
  decision_to_first_fill_ms: number | null;
  decision_to_last_fill_ms: number | null;
  first_fill_at: number | null;
  last_fill_at: number | null;
}

/**
 * Fill timings measured from the legs themselves.
 *
 * `first_to_last_fill_ms` is the literal spread between the earliest and latest
 * FULL fill, so it is 0 for a single fill and grows only when legs really did land
 * apart. Detection-relative figures are reported separately.
 */
export function fillTiming(legs: PaperLegExecution[], detectedAt: number): FillTiming {
  const times = legs
    .filter((l) => l.status === "FILLED" && l.fill_at !== null)
    .map((l) => l.fill_at as number);
  if (times.length === 0) {
    return {
      first_to_last_fill_ms: null,
      decision_to_first_fill_ms: null,
      decision_to_last_fill_ms: null,
      first_fill_at: null,
      last_fill_at: null,
    };
  }
  const first = Math.min(...times);
  const last = Math.max(...times);
  return {
    first_to_last_fill_ms: round2(last - first),
    decision_to_first_fill_ms: round2(first - detectedAt),
    decision_to_last_fill_ms: round2(last - detectedAt),
    first_fill_at: first,
    last_fill_at: last,
  };
}
