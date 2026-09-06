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

/**
 * LIVE-PARITY ONLY: the cancel-vs-fill race model.
 *
 * WHY THIS EXISTS (audit divergence D17)
 *
 * In real trading a cancel is a REQUEST, not an outcome. Between the DELETE leaving our wire
 * and the broker confirming a terminal state, the exchange can still match some or all of the
 * resting quantity. The live adapters already respect this — `confirmTerminalAfterCancel()`
 * re-reads the order until it is genuinely terminal, and the durable state machine explicitly
 * permits `CANCEL_REQUESTED → COMPLETE`. Paper did not model it at all: `abandon()` was
 * instantaneous, so a paper order could never be filled after a cancel was requested.
 *
 * That gap flatters paper in the most dangerous possible way. A live protective cancel that
 * loses the race leaves REAL, irreversible exposure that must be unwound; the paper equivalent
 * reported a clean cancellation and no exposure at all. Any statistic derived from that — fill
 * rate, residual rate, unwind frequency — was optimistic by construction.
 *
 * WHEN SUPPLIED, a cancel becomes a two-phase operation: the order enters
 * `CANCEL_REQUESTED` and REMAINS eligible to fill from observed books until the confirmation
 * deadline drawn from `latencyMs()`. WHEN UNDEFINED (standard paper) cancellation stays
 * instantaneous and behaviour is byte-for-byte what it was.
 *
 * NO INVENTED FILLS. Quantity taken during the race window comes from the same observed
 * WebSocket books, the same limit and the same shared liquidity ledger as any other fill. The
 * only thing being modelled is the WINDOW — its length comes from measured
 * `cancel_request_to_terminal_ms` samples, and nothing is fabricated inside it.
 */
export interface LegCancelRaceModel {
  /**
   * How long this cancel takes to reach a confirmed terminal state (ms), drawn from measured
   * live cancel latency. Called once per cancel request.
   */
  latencyMs(): number;
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
  /**
   * LIVE-PARITY ONLY. Models the real cancel-vs-fill race: a cancelled order keeps working,
   * and keeps being eligible to fill, until the broker confirms a terminal state. Undefined ⇒
   * cancellation is instantaneous exactly as before.
   */
  cancelRace?: LegCancelRaceModel | undefined;
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
  /**
   * Why a cancel was requested, which decides the terminal status once it confirms:
   * `timeout` resolves to TIMED_OUT and `abort` to CANCELLED/FAILED — the same statuses the
   * instantaneous path produced. Null when no cancel has been requested.
   */
  cancelCause: "abort" | "timeout" | null;
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
      cancelCause: null,
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
        // CANCEL_REQUESTED is deliberately in this set. An order with a cancel in flight is
        // still working at the exchange, so a book update inside the cancellation window can
        // still fill it — that IS the race.
        if (
          st.leg.status !== "PENDING" &&
          st.leg.status !== "PARTIALLY_FILLED" &&
          st.leg.status !== "CANCEL_REQUESTED"
        ) {
          continue;
        }
        if (!touched.has(st.req.inst.token)) continue;
        // A cancelled order must not be revived by a tick after its terminal confirmation.
        if (st.leg.cancel_confirmed_at !== null && at > st.leg.cancel_confirmed_at) continue;
        // A timed-out order must not be revived by a later tick. While a cancel is racing,
        // the cancel confirmation (checked above) is the binding deadline, not the timeout —
        // the order is genuinely still live at the exchange past its own deadline.
        if (
          st.leg.status !== "CANCEL_REQUESTED" &&
          st.leg.timeout_at !== null &&
          at > st.leg.timeout_at
        ) {
          continue;
        }
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

        // Only ask once: after an abort the run is winding down, and re-evaluating the
        // predicate cannot change that.
        const abort: LegRunResult["aborted"] = aborted ?? args.abortReason?.() ?? null;
        if (abort && aborted === null) {
          aborted = abort;
          for (const st of states) {
            if (st.done) continue;
            this.requestCancel(st, "abort", abort.detail);
          }
          // WITHOUT a cancel-race model every leg is now terminal and the loop ends on the
          // next boundary check, exactly as before. WITH one, the legs are CANCEL_REQUESTED
          // and still fillable, so the loop must keep running until each cancel confirms —
          // otherwise we would be back to pretending a cancel request is a cancellation.
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

        // 2) Orders still working at their deadline: pull them (keeping any partial).
        //
        // WITHOUT a cancel-race model this expires the order immediately, as before. WITH one
        // it issues a protective cancel that must then be CONFIRMED — mirroring the live
        // adapters' `protectiveCancelAndConfirm`, where the order keeps working (and can keep
        // filling) until the broker reports a terminal state.
        for (const st of states) {
          if (st.done) continue;
          if (st.leg.status !== "PENDING" && st.leg.status !== "PARTIALLY_FILLED") continue;
          if (st.leg.timeout_at === null || st.leg.timeout_at > at) continue;
          this.expire(st, timeout);
          if (sequential && st.done) this.cancelRemaining(states, st);
        }

        // 3) Cancels whose confirmation deadline has arrived: settle the race.
        //
        // The order stops being fillable HERE, not when the cancel was requested. Whatever
        // cumulative quantity it reached in between is real and is what gets recorded.
        for (const st of states) {
          if (st.done) continue;
          if (st.leg.status !== "CANCEL_REQUESTED") continue;
          if (st.leg.cancel_confirmed_at === null || st.leg.cancel_confirmed_at > at) continue;
          this.confirmCancel(st, timeout);
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
      // LIVE-PARITY: the scheduler's arrival IS the broker ACK — the instant the order is live
      // at the exchange. Recorded as its own field so ACK latency is measurable and directly
      // comparable with the live path's `post_to_ack_ms`, and so nothing has to infer an ACK
      // from a fill. AN ACK IS NOT A FILL: this timestamp carries no quantity information.
      st.leg.ack_at = st.leg.arrival_at;
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

  /**
   * The order's deadline passed while it was still not fully filled.
   *
   * Without a cancel-race model this terminalises immediately (unchanged). With one it issues
   * a protective cancel and returns with the order STILL LIVE, because that is what happens:
   * our deadline is our own, and the exchange does not know about it.
   */
  private expire(st: LegState, timeoutMs: number): void {
    const detail =
      `still unfilled ${timeoutMs}ms after arriving — ` +
      (st.leg.fill_qty > 0
        ? `only ${st.leg.fill_qty} of ${st.leg.quantity} filled within the limit`
        : "no executable quantity within the limit");

    if (this.deps.cancelRace) {
      this.requestCancel(st, "timeout", detail);
      return;
    }

    st.leg.status = "TIMED_OUT";
    // Report the DEADLINE as the resolution instant, not a late wake-up.
    st.leg.resolved_at = st.leg.timeout_at ?? this.deps.now();
    st.leg.fail_reason = detail;
    st.done = true;
  }

  /**
   * Request a cancel. LIVE-PARITY: the order enters `CANCEL_REQUESTED` and stays fillable.
   *
   * Falls through to the instantaneous {@link abandon} when no cancel-race model is wired, so
   * standard paper is byte-for-byte unchanged.
   *
   * Idempotent: a second request for an order already being cancelled is ignored, because in
   * reality a duplicate DELETE does not restart the clock on the first one.
   */
  private requestCancel(st: LegState, cause: "abort" | "timeout", detail: string): void {
    if (TERMINAL.has(st.leg.status)) {
      st.done = true;
      return;
    }
    const race = this.deps.cancelRace;
    if (!race) {
      if (cause === "timeout") {
        // Preserve the exact pre-existing timeout semantics.
        st.leg.status = "TIMED_OUT";
        st.leg.resolved_at = st.leg.timeout_at ?? this.deps.now();
        st.leg.fail_reason = detail;
        st.done = true;
        return;
      }
      this.abandon(st, detail);
      return;
    }
    if (st.leg.cancel_requested_at !== null) return;

    const at = this.deps.now();
    const latency = Math.max(0, race.latencyMs());
    st.cancelCause = cause;
    st.leg.cancel_requested_at = at;
    // The cumulative quantity AT THE REQUEST. Kept only so the race is visible; it is never
    // the authoritative figure.
    st.leg.fill_qty_at_cancel_request = st.leg.fill_qty;
    st.leg.cancel_confirmed_at = at + latency;
    st.leg.status = "CANCEL_REQUESTED";
    st.leg.fail_reason = detail;
    // Deliberately NOT done. The order is live at the exchange until the confirmation lands.
  }

  /**
   * Settle a cancel that has now been confirmed terminal.
   *
   * THE AUTHORITATIVE QUANTITY IS THE FINAL ONE. If the order completed while the cancel was
   * in flight it is FILLED — we lost the race, and the position is real. If it only partially
   * filled, the fill is kept and the remainder is cancelled. The quantity observed at request
   * time is recorded separately, and is never substituted for the final total.
   */
  private confirmCancel(st: LegState, timeoutMs: number): void {
    const leg = st.leg;
    noteRacedQuantity(leg);
    const resolvedAt = leg.cancel_confirmed_at ?? this.deps.now();
    leg.resolved_at = resolvedAt;

    if (leg.remaining_qty <= 0 && leg.fill_qty > 0) {
      // RACE LOST: the exchange filled the whole order while our cancel was travelling. This
      // is a genuine, irreversible position — reporting it as a cancellation would lose real
      // exposure, which is the exact failure this model exists to prevent.
      leg.status = "FILLED";
      leg.fill_at = leg.fill_at ?? resolvedAt;
      leg.fail_reason = null;
      st.done = true;
      return;
    }

    if (st.cancelCause === "timeout") {
      leg.status = "TIMED_OUT";
      leg.fail_reason =
        `still unfilled ${timeoutMs}ms after arriving — ` +
        (leg.fill_qty > 0
          ? `only ${leg.fill_qty} of ${leg.quantity} filled within the limit`
          : "no executable quantity within the limit") +
        (leg.raced_fill_qty > 0 ? ` (${leg.raced_fill_qty} filled during cancellation)` : "");
    } else {
      // Matches the instantaneous path: a partial keeps its fill and stays visible as
      // CANCELLED; a zero-fill order could not be worked at all.
      leg.status = leg.fill_qty > 0 ? "CANCELLED" : "FAILED";
      if (leg.raced_fill_qty > 0) {
        leg.fail_reason = `${leg.fail_reason ?? "cancelled"} (${leg.raced_fill_qty} filled during cancellation)`;
      }
    }
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
      } else if (st.leg.status === "CANCEL_REQUESTED") {
        // The next thing that can happen to a cancelling order is its terminal confirmation.
        consider(st.leg.cancel_confirmed_at);
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
      // Completing while a cancel is in flight means the race was LOST — a real position.
      // Recording it as anything other than FILLED would discard genuine exposure.
      //
      // The order terminalises HERE, before its cancel confirmation was due, so the raced
      // quantity must be settled on this path too — otherwise a fully-raced order would report
      // the correct fill_qty but claim nothing had filled after the cancel request.
      noteRacedQuantity(leg);
      leg.status = "FILLED";
      leg.fill_at = at;
      leg.resolved_at = at;
      if (leg.cancel_requested_at !== null) {
        // The cancel reached its own resolution at this instant: too late to do anything.
        leg.cancel_confirmed_at = at;
      }
      st.done = true;
      return "filled";
    }
    // Some quantity taken; the remainder rests for later liquidity.
    //
    // A cancelling order must KEEP its CANCEL_REQUESTED status: overwriting it with
    // PARTIALLY_FILLED would forget that a cancel is in flight, and the order would then be
    // resolved by the timeout path instead of by its cancel confirmation.
    if (leg.status !== "CANCEL_REQUESTED") leg.status = "PARTIALLY_FILLED";
    return "partial";
  }
}

/**
 * Settle how much quantity filled AFTER a cancel was requested.
 *
 * Called from both terminal paths — the cancel confirmation, and an order that completed
 * mid-cancellation — so the race is always quantified wherever the order happens to end up. A
 * no-op when no cancel was requested.
 */
function noteRacedQuantity(leg: PaperLegExecution): void {
  if (leg.cancel_requested_at === null) return;
  const atRequest = leg.fill_qty_at_cancel_request ?? 0;
  leg.raced_fill_qty = Math.max(0, leg.fill_qty - atRequest);
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
    ack_at: null,
    pending_since: null,
    timeout_at: null,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
    fill_qty_at_cancel_request: null,
    raced_fill_qty: 0,
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
