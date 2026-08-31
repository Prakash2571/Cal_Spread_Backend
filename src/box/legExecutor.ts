/**
 * INDEPENDENT PAPER ORDER LIFECYCLES — one per box leg.
 *
 * WHY THIS MODULE EXISTS
 *
 * The first paper_legging model still resolved all four legs against a SINGLE
 * snapshot taken at one common arrival instant. That cannot express the thing that
 * actually kills four-leg arbitrage: legs filling at different moments, one leg
 * resting unfilled while the others are already on, and one leg never filling at
 * all. If every leg is decided from the same book at the same millisecond, legging
 * risk is structurally invisible.
 *
 * So each leg here is a real order with its own lifecycle:
 *
 *   CREATED → SUBMITTED → IN_FLIGHT → (at arrival) fill? → FILLED
 *                                              └ no → PENDING → fill on a later
 *                                                     book update → FILLED
 *                                                     └ or TIMED_OUT at
 *                                                       arrival_at + legTimeoutMs
 *
 * TWO RULES THAT MUST NOT REGRESS
 *
 *  1. RESTING BOOK. A book does NOT have to publish a new tick after arrival to be
 *     valid. At arrival we read the latest known valid book; an option quoted
 *     `Ask 100 x 500` that has not ticked for 200ms is still executable. Only if
 *     THAT book cannot fill the lot does the order rest as PENDING, after which a
 *     later update may fill it.
 *
 *  2. NEVER INVENT A PRICE. Every fill is an observed executable touch from a real
 *     WebSocket book, recorded with its version and receive timestamp. There is no
 *     random slippage anywhere.
 *
 * EVENT-DRIVEN, YET DETERMINISTIC
 *
 * Pending orders are woken by the quote store's `subscribe()` seam, which fires
 * synchronously as a depth packet is applied — so a fill is stamped with the
 * TICK'S OWN timestamp, not whenever a poller happened to look. Timers are used
 * only for arrival and timeout deadlines. The clock and the sleep are injected, so
 * a recorded tick stream reproduces byte-identical fill times, prices and P&L.
 *
 * Scheduling is driven by ONE coordinating loop rather than four concurrent
 * waiters: concurrent sleeps against a shared simulated clock would race and
 * advance it past a deadline, which would quietly destroy determinism.
 */

import type { BoxConfig } from "./config.js";
import { round2, slippagePerUnit } from "./math.js";
import type { BoxQuoteStore } from "./quotes.js";
import type {
  BoxExecutionFailureReason,
  BoxLegEvaluation,
  BoxLegRole,
  BoxOptionInstrument,
  BoxQuote,
  OrderSide,
  PaperLegExecution,
} from "./types.js";

/** One order to work: what to trade, and when it was sent. */
export interface LegOrderRequest {
  role: BoxLegRole;
  side: OrderSide;
  inst: BoxOptionInstrument;
  /** The touch visible at DETECTION, for slippage measurement. */
  detected_price: number | null;
  detected_qty: number;
  /** One lot. */
  quantity: number;
}

export interface LegExecutorDeps {
  cfg: Pick<
    BoxConfig,
    | "legExecutionMode"
    | "legTimeoutMs"
    | "quoteMaxAgeMs"
    | "simulatedLatencyMs"
    | "executionPollMs"
  >;
  quotes: BoxQuoteStore;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /**
   * Price one leg against one book. Injected so the touch/liquidity rules live in
   * exactly one place (the simulator's `legFromQuote`) and cannot drift.
   */
  evaluate: (args: {
    role: BoxLegRole;
    side: OrderSide;
    inst: BoxOptionInstrument;
    quote: BoxQuote;
    lotSize: number;
    now: number;
    maxAgeMs: number;
  }) => BoxLegEvaluation;
  /**
   * Reason to abandon everything still working (feed died, market closed,
   * discovery stopped). Checked on every wake; already-FILLED legs are untouched,
   * because those fills really happened.
   */
  abortReason?: () => { reason: BoxExecutionFailureReason; detail: string } | null;
}

/** What the run produced. */
export interface LegRunResult {
  legs: PaperLegExecution[];
  /** Set when the run was cut short (feed/market/discovery), else null. */
  aborted: { reason: BoxExecutionFailureReason; detail: string } | null;
  /**
   * token → the EXACT book each filled leg filled from.
   *
   * Essential for final qualification: legs fill at different instants, so the
   * store's current books are not what we traded. Re-qualifying on these means the
   * decision is made on the actual fill prices.
   */
  booksAtFill: Map<number, BoxQuote>;
}

/** An order plus the bookkeeping the scheduler needs. */
interface LegState {
  leg: PaperLegExecution;
  req: LegOrderRequest;
  /** Terminal states need no further scheduling. */
  done: boolean;
}

const TERMINAL: ReadonlySet<string> = new Set([
  "FILLED",
  "PARTIALLY_FILLED",
  "TIMED_OUT",
  "FAILED",
]);

export class LegExecutor {
  constructor(private deps: LegExecutorDeps) {}

  /**
   * Work all four orders.
   *
   * parallel   — every order is submitted at `submitAt` and travels concurrently;
   *              each fills (or rests, or times out) on its own timeline.
   * sequential — the next order is submitted only once the previous one FILLED, so
   *              its submit/arrival times are derived from that fill.
   */
  async run(args: {
    requests: LegOrderRequest[];
    /** When the strategy released the orders. */
    submitAt: number;
    /** Per-leg travel time; arrival = submit + this. */
    latencyMs?: number;
    lotSize: number;
  }): Promise<LegRunResult> {
    const latency = Math.max(0, args.latencyMs ?? this.deps.cfg.simulatedLatencyMs);
    const timeout = Math.max(0, this.deps.cfg.legTimeoutMs);
    const sequential = this.deps.cfg.legExecutionMode === "sequential";

    const states: LegState[] = args.requests.map((req) => ({
      req,
      done: false,
      leg: blankLeg(req, args.lotSize),
    }));

    // Submit: in parallel every order goes now; sequentially only the first does.
    for (const [i, st] of states.entries()) {
      if (!sequential || i === 0) this.submit(st, args.submitAt, latency);
    }

    // Pending orders are filled by book updates at the TICK's own timestamp.
    const unsubscribe = this.deps.quotes.subscribe((changed, at) => {
      const touched = new Set(changed);
      for (const st of states) {
        if (st.done || st.leg.status !== "PENDING") continue;
        if (!touched.has(st.req.inst.token)) continue;
        // A timed-out order must not be revived by a later tick.
        if (st.leg.timeout_at !== null && at > st.leg.timeout_at) continue;
        this.tryFill(st, at, args.lotSize);
      }
    });

    let aborted: LegRunResult["aborted"] = null;
    const booksAtFill = new Map<number, BoxQuote>();
    this.booksAtFill = booksAtFill;

    try {
      // ONE coordinating loop. Each pass advances the clock to the next boundary —
      // an arrival or a timeout — and processes everything due at that instant.
      let guard = 0;
      for (;;) {
        if (++guard > 10_000) break; // never spin forever on a stuck clock

        const abort = this.deps.abortReason?.() ?? null;
        if (abort) {
          aborted = abort;
          for (const st of states) {
            if (st.done) continue;
            this.fail(st, abort.detail);
          }
          break;
        }

        const next = this.nextBoundary(states);
        if (next === null) break; // everything resolved

        if (next > this.deps.now()) {
          // Sleep toward the boundary in BOUNDED steps. Ticks landing inside a step
          // fire the subscription above and fill pending orders at their exact
          // timestamps, so stepping costs no accuracy — it only bounds how long a
          // feed death / market close / STOP can go unnoticed while orders rest.
          const step = Math.max(1, this.deps.cfg.executionPollMs);
          await this.deps.wait(Math.min(next - this.deps.now(), step));
          // Not at the boundary yet: re-check the abort conditions first.
          if (this.deps.now() < next) continue;
        }
        const at = this.deps.now();

        // 1) Orders that have now ARRIVED: try the latest valid resting book.
        for (const st of states) {
          if (st.done || st.leg.status !== "IN_FLIGHT") continue;
          if (st.leg.arrival_at > at) continue;
          st.leg.status = "PENDING";
          st.leg.pending_since = at;
          st.leg.timeout_at = st.leg.arrival_at + timeout;
          const filled = this.tryFill(st, at, args.lotSize);
          // Sequential: a fill releases the next order from this very instant.
          if (sequential && filled) this.submitNext(states, st, at, latency);
        }

        // 2) Orders still resting at their deadline: give up.
        for (const st of states) {
          if (st.done || st.leg.status !== "PENDING") continue;
          if (st.leg.timeout_at === null || st.leg.timeout_at > at) continue;
          st.leg.status = "TIMED_OUT";
          st.leg.resolved_at = at;
          st.leg.fail_reason =
            `still unfilled ${timeout}ms after arriving — ` +
            (st.leg.fill_qty > 0
              ? `only ${st.leg.fill_qty} of ${st.leg.quantity} available`
              : "the touch never showed a full lot");
          st.done = true;
          // Sequential: nothing after a failed leg is ever sent.
          if (sequential) this.cancelRemaining(states, st);
        }
      }
    } finally {
      unsubscribe();
    }

    // Anything still open (guard tripped) is recorded honestly, never as a fill.
    for (const st of states) {
      if (!st.done) this.fail(st, st.leg.fail_reason ?? "unresolved when the run ended");
    }

    return { legs: states.map((s) => s.leg), aborted, booksAtFill };
  }

  /** The books of the run currently in progress (see LegRunResult.booksAtFill). */
  private booksAtFill: Map<number, BoxQuote> | null = null;

  /* ------------------------------- internals ------------------------------ */

  private submit(st: LegState, submitAt: number, latencyMs: number): void {
    st.leg.status = "IN_FLIGHT";
    st.leg.submit_at = submitAt;
    st.leg.arrival_at = submitAt + latencyMs;
  }

  /** Sequential mode: release the order after `afterState`, timed from its fill. */
  private submitNext(
    states: LegState[],
    afterState: LegState,
    at: number,
    latencyMs: number,
  ): void {
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

  private fail(st: LegState, detail: string): void {
    // A leg that already filled keeps its fill: that money was really spent.
    if (TERMINAL.has(st.leg.status)) {
      st.done = true;
      return;
    }
    st.leg.status = "FAILED";
    st.leg.resolved_at = this.deps.now();
    st.leg.fail_reason = detail;
    st.done = true;
  }

  /**
   * The next instant anything can happen: the earliest pending arrival, or the
   * earliest resting order's deadline. null when every order is resolved.
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
      else if (st.leg.status === "PENDING") consider(st.leg.timeout_at);
      // CREATED legs (sequential, not yet released) are driven by the leg ahead.
    }
    return next;
  }

  /**
   * Attempt a fill from the CURRENT book. Returns true when it filled.
   *
   * Records the book it looked at either way, so a leg that never filled still
   * shows what it was seeing — which is what makes an abort diagnosable.
   */
  private tryFill(st: LegState, at: number, lotSize: number): boolean {
    const { leg, req } = st;
    const quote = this.deps.quotes.get(req.inst.token);
    if (!quote) {
      leg.fail_reason = "no book for this instrument yet";
      return false;
    }

    const ev = this.deps.evaluate({
      role: req.role,
      side: req.side,
      inst: req.inst,
      quote,
      lotSize,
      now: at,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
    });

    leg.quote_version = ev.quote_version ?? quote.version;
    leg.book_at = quote.at;
    leg.book_age_ms = at - quote.at;

    // A book that has aged out is not evidence of an executable price. The order
    // keeps resting: a refresh may make it fillable before the deadline.
    if (!ev.fresh) {
      leg.fail_reason = `book is stale (${leg.book_age_ms}ms) — waiting for a refresh`;
      return false;
    }
    if (ev.price === null || !(ev.price > 0)) {
      leg.fail_reason = `no ${req.side === "BUY" ? "ask" : "bid"} to trade against`;
      return false;
    }
    // TOUCH-ONLY: the whole lot must be resting at the touch. Depth walking (and
    // therefore PARTIALLY_FILLED) arrives with Phase 3; a thin touch rests instead
    // of half-filling, because a half-filled box leg is not a box.
    if (ev.qty_at_touch < lotSize) {
      leg.fill_qty = 0;
      leg.remaining_qty = lotSize;
      leg.fail_reason = `only ${ev.qty_at_touch} of ${lotSize} resting at ${ev.price}`;
      return false;
    }

    leg.status = "FILLED";
    // Keep the exact book this leg filled from, so final qualification prices the
    // real fills rather than whatever the store holds once all four are done.
    this.booksAtFill?.set(req.inst.token, quote);
    leg.fill_price = ev.price;
    leg.fill_at = at;
    leg.resolved_at = at;
    leg.fill_qty = lotSize;
    leg.remaining_qty = 0;
    leg.fail_reason = null;
    const perUnit = slippagePerUnit(req.side, req.detected_price, ev.price);
    leg.slippage = perUnit === null ? null : round2(perUnit * lotSize);
    st.done = true;
    return true;
  }
}

/** A freshly created order, before submission. */
function blankLeg(req: LegOrderRequest, lotSize: number): PaperLegExecution {
  return {
    role: req.role,
    side: req.side,
    token: req.inst.token,
    tradingsymbol: req.inst.tradingsymbol,
    detected_price: req.detected_price,
    detected_qty: req.detected_qty,
    submit_at: 0,
    arrival_at: 0,
    pending_since: null,
    timeout_at: null,
    fill_at: null,
    resolved_at: null,
    fill_price: null,
    quantity: lotSize,
    fill_qty: 0,
    remaining_qty: lotSize,
    quote_version: null,
    book_at: null,
    book_age_ms: null,
    slippage: null,
    status: "CREATED",
    unwind_price: null,
    unwind_slippage: null,
    fail_reason: null,
  };
}

/* ------------------------------ fill analytics ----------------------------- */

/** Fill-timing summary over a finished set of orders. */
export interface FillTiming {
  /** max(fill_at) − min(fill_at) across FILLED legs — the dispersion. */
  first_to_last_fill_ms: number | null;
  decision_to_first_fill_ms: number | null;
  decision_to_last_fill_ms: number | null;
  first_fill_at: number | null;
  last_fill_at: number | null;
}

/**
 * Fill timings measured from the legs themselves.
 *
 * Deliberately derived here rather than assumed from a common arrival instant:
 * `first_to_last_fill_ms` is the literal spread between the earliest and latest
 * fill, so it is 0 for a single fill and grows only when legs really did land
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
