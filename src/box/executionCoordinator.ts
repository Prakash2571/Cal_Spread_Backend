/**
 * BOX EXECUTION COORDINATION — one contract, one execution at a time.
 *
 * THE PROBLEM, CONCRETELY
 * Every duplicate guard in this engine is keyed on the strike pair
 * (`underlying|expiry|K1|K2|DIRECTION`). A 1300/1320 box and a 1320/1340 box are
 * therefore treated as unrelated, even though both trade the 1320 strike. Nothing
 * stopped them submitting in the same instant, each assuming the FULL displayed size
 * resting at 1320. Real closed-trade history shows exactly that: overlapping-strike
 * pairs opened in the same second. In paper it overstates achievable fills, because
 * the same resting lot is spent twice.
 *
 * WHERE THIS SITS, AND WHY THERE
 * It decorates `BoxExecutionGateway` — the interface where, and only where, the
 * paper/live branch happens. That placement is the whole design:
 *
 *   scanner / monitor  ->  THIS  ->  CentralBoxExecutionGateway  ->  paper | live
 *
 * so paper gets no shortcut around coordination. Paper realism is the reason to
 * insist on that: a simulator that lets two boxes consume one lot is not modelling
 * anything real. It also means the scanner and monitor need no changes at all, and
 * none of this lands in the already-oversized engine.ts.
 *
 * WHY NOT A SLEEP
 * A fixed `await sleep(250)` before every second execution would be both wrong and
 * slow: wrong because it does not actually establish exclusion, and slow because the
 * dislocation is usually gone. The loser of a conflict instead registers for the
 * winner's release and is woken by it — typically within a millisecond — then
 * REPRICES against the current book before it is allowed to proceed. A poll interval
 * exists only as a backstop for a release that somehow never fires.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not serialise unrelated boxes. Two boxes sharing no contract never wait on
 * each other; there is no global execution mutex here. It does not lock a whole
 * underlying either — RELIANCE 2500CE and RELIANCE 2800CE are independent. And it
 * does not net opposite sides internally: that needs the ledger to represent virtual
 * ownership of both boxes while broker net exposure is zero, which has not been
 * proven, so the safe path (serialise, confirm, re-evaluate) is taken for both
 * same-side and opposite-side overlaps.
 */

import { entrySideFor, evaluateCandidate } from "./math.js";
import {
  boxInstrumentRefs,
  classifyConflict,
  keysOf,
  type InstrumentConflict,
  type InstrumentLegRef,
} from "./instrumentKey.js";
import type { InProcessInstrumentReservations, InstrumentReservationStore } from "./instrumentReservations.js";
import type { BoxExecutionGateway } from "./executionGateway.js";
import type { BoxConfig } from "./config.js";
import type { BoxQuoteStore } from "./quotes.js";
import type { BoxExecutionSimulator } from "./executionSimulator.js";
import {
  BOX_LEG_ROLES,
  type BoxCandidate,
  type BoxDirection,
  type BoxEvaluation,
  type BoxExecutionFailureReason,
  type BoxLegRole,
  type BoxOptionInstrument,
  type OrderSide,
  type PaperLeggingExecutionRecord,
} from "./types.js";

/**
 * Coordination outcome for one execution, extending the observational vocabulary
 * rather than the durable `BoxOrderIntentState` (which is enforced as a Mongo
 * predecessor guard, so widening it would need a migration).
 */
export type CoordinationState =
  | "RESERVED"
  | "WAITING_FOR_INSTRUMENT"
  | "REVALIDATING"
  | "EXECUTING"
  | "ABORTED_DETERIORATED"
  | "EXPIRED_WHILE_WAITING"
  | "SUPPRESSED_DUPLICATE"
  | "REFUSED_NO_COORDINATION";

export interface CoordinatorMetricsSnapshot {
  activeExecutions: number;
  activeInstrumentReservations: number;
  waitingExecutions: number;
  reservationConflicts: number;
  duplicateSuppressed: number;
  expiredWhileWaiting: number;
  revalidationRejected: number;
  revalidationPassed: number;
  reservationsHeldOnUncertainty: number;
  failedClosed: number;
  waitMs: { p50: number | null; p95: number | null; samples: number };
  store: string;
  durable: boolean;
}

export interface CoordinatorLogFields {
  execution: string;
  broker: string;
  underlying: string;
  status: string;
  [extra: string]: string | number | boolean | null;
}

/** Percentiles over a bounded sample window — no unbounded arrays on a hot path. */
class BoundedSamples {
  private buf: number[] = [];
  constructor(private readonly max = 256) {}
  add(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.buf.length >= this.max) this.buf.shift();
    this.buf.push(v);
  }
  percentile(p: number): number | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx] ?? null;
  }
  get samples(): number {
    return this.buf.length;
  }
}

export interface CoordinatorDeps {
  /** The real gateway. Every call is delegated once coordination succeeds. */
  inner: BoxExecutionGateway;
  reservations: InstrumentReservationStore;
  /** Present only when the store supports event-driven wakeups. */
  waitable?: Pick<InProcessInstrumentReservations, "onRelease">;
  cfg: BoxConfig;
  quotes: BoxQuoteStore;
  broker: () => string;
  now?: () => number;
  /** Injected so tests can drive waiting deterministically. */
  sleep?: (ms: number) => Promise<void>;
  log?: (fields: CoordinatorLogFields) => void;
}

const DEFAULT_POLL_MS = 100;

export class CoordinatedBoxExecutionGateway implements BoxExecutionGateway {
  readonly mode: BoxConfig["executionMode"];

  private seq = 0;
  private active = new Map<string, { keys: string[]; underlying: string }>();
  /** Canonical opportunity identity -> execution id, for duplicate suppression. */
  private activeOpportunities = new Map<string, string>();
  private waiting = 0;
  private stats = {
    reservationConflicts: 0,
    duplicateSuppressed: 0,
    expiredWhileWaiting: 0,
    revalidationRejected: 0,
    revalidationPassed: 0,
    reservationsHeldOnUncertainty: 0,
    failedClosed: 0,
  };
  private waitSamples = new BoundedSamples();

  constructor(private readonly deps: CoordinatorDeps) {
    this.mode = deps.inner.mode;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(fields: CoordinatorLogFields): void {
    if (this.deps.log) {
      this.deps.log(fields);
      return;
    }
    const rest = Object.entries(fields)
      .filter(([k]) => !["execution", "broker", "underlying", "status"].includes(k))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    console.log(
      `[BoxCoord] execution=${fields.execution} broker=${fields.broker} ` +
        `underlying=${fields.underlying} status=${fields.status}${rest ? ` ${rest}` : ""}`,
    );
  }

  /* ------------------------------------------------------------------ *
   * Pass-through members. Coordination applies to submission, not to
   * read-only estimation or diagnostics.
   * ------------------------------------------------------------------ */

  hasCapacity(): boolean {
    return this.deps.inner.hasCapacity();
  }

  estimateExecutableExit(...args: Parameters<BoxExecutionGateway["estimateExecutableExit"]>) {
    return this.deps.inner.estimateExecutableExit(...args);
  }

  invariantViolation(reason: string): void {
    this.deps.inner.invariantViolation(reason);
  }

  /**
   * Residual flattening is NOT gated.
   *
   * It reduces exposure that already exists, and it runs on the highest scheduling
   * priority for exactly that reason. Making it wait behind an entry's reservation
   * would let a naked leg sit open while a speculative box held the contract — the
   * precise inversion of the safety this class is for.
   */
  flattenResidual(...args: Parameters<BoxExecutionGateway["flattenResidual"]>) {
    return this.deps.inner.flattenResidual(...args);
  }

  /* ------------------------------------------------------------------ *
   * Entries — fully coordinated.
   * ------------------------------------------------------------------ */

  async simulateLeggingEntry(
    args: Parameters<BoxExecutionSimulator["simulateLeggingEntry"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateLeggingEntry"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateLeggingEntry(args);
    }
    const gate = await this.coordinateEntry(args.candidate, args.detection);
    if (!gate.ok) {
      return {
        ok: false,
        reason: gate.reason,
        detail: gate.detail,
        legging: emptyLeggingRecord(this.mode, args.detection.at, this.now(), gate.reason, gate.detail),
      };
    }
    try {
      const result = await this.deps.inner.simulateLeggingEntry(args);
      this.settle(gate.executionId, gate.keys, gate.opportunityId, uncertaintyOf(result));
      return result;
    } catch (error) {
      // An exception leaves broker state genuinely unknown. Hold the reservation for
      // its TTL rather than releasing: the alternative is a second box firing into a
      // contract whose first order may well have been accepted.
      this.holdOnUncertainty(gate.executionId, gate.opportunityId, "entry threw");
      throw error;
    }
  }

  async simulateEntry(
    args: Parameters<BoxExecutionSimulator["simulateEntry"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateEntry"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateEntry(args);
    }
    const gate = await this.coordinateEntry(args.candidate, args.detection);
    if (!gate.ok) {
      return { ok: false, reason: gate.reason, detail: gate.detail } as Awaited<
        ReturnType<BoxExecutionSimulator["simulateEntry"]>
      >;
    }
    try {
      const result = await this.deps.inner.simulateEntry(args);
      // The atomic entry path reports no residual, so a plain failure is clean.
      this.settle(gate.executionId, gate.keys, gate.opportunityId, result.ok ? "clean" : "clean");
      return result;
    } catch (error) {
      this.holdOnUncertainty(gate.executionId, gate.opportunityId, "entry threw");
      throw error;
    }
  }

  /* ------------------------------------------------------------------ *
   * Exits — reserved, but never made to wait.
   * ------------------------------------------------------------------ */

  /**
   * An exit takes the same contract reservation, so an entry cannot submit into a
   * leg an exit is closing. It does NOT wait on a conflict: it returns the failure
   * the monitor already handles by holding the position and retrying next cycle.
   * Waiting would be worse than retrying — the monitor owns exit urgency (including
   * the expiry-safety window) and must not be blocked behind a speculative entry.
   */
  async simulateLeggingExit(
    args: Parameters<BoxExecutionSimulator["simulateLeggingExit"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateLeggingExit"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateLeggingExit(args);
    }
    const refs = this.refsForExit(args.position);
    const executionId = this.mintId("exit");
    const acquired = this.acquire(executionId, refs);
    if (!acquired.ok) {
      this.stats.reservationConflicts++;
      this.log({
        execution: executionId,
        broker: this.deps.broker(),
        underlying: args.position.underlying,
        status: "exit_conflict",
        conflicts: acquired.conflicts.length,
      });
      const detail = `exit deferred: ${acquired.conflicts.length} leg(s) reserved by another execution`;
      return {
        ok: false,
        reason: "insufficient_quantity",
        detail,
        record: emptyLeggingRecord(this.mode, args.detectedAt ?? this.now(), this.now(), "insufficient_quantity", detail),
      };
    }
    this.active.set(executionId, { keys: keysOf(refs), underlying: args.position.underlying });
    try {
      const result = await this.deps.inner.simulateLeggingExit(args);
      this.settle(executionId, keysOf(refs), null, uncertaintyOf(result));
      return result;
    } catch (error) {
      this.holdOnUncertainty(executionId, null, "exit threw");
      throw error;
    }
  }

  async simulateExit(
    args: Parameters<BoxExecutionSimulator["simulateExit"]>[0],
  ): ReturnType<BoxExecutionSimulator["simulateExit"]> {
    if (!this.deps.cfg.executionCoordinatorEnabled) {
      return this.deps.inner.simulateExit(args);
    }
    const refs = this.refsForExit(args.position);
    const executionId = this.mintId("exit");
    const acquired = this.acquire(executionId, refs);
    if (!acquired.ok) {
      this.stats.reservationConflicts++;
      return {
        ok: false,
        reason: "insufficient_quantity",
        detail: "exit deferred: leg reserved by another execution",
      } as Awaited<ReturnType<BoxExecutionSimulator["simulateExit"]>>;
    }
    this.active.set(executionId, { keys: keysOf(refs), underlying: args.position.underlying });
    try {
      const result = await this.deps.inner.simulateExit(args);
      this.settle(executionId, keysOf(refs), null, "clean");
      return result;
    } catch (error) {
      this.holdOnUncertainty(executionId, null, "exit threw");
      throw error;
    }
  }

  /* ------------------------------------------------------------------ *
   * The coordination algorithm.
   * ------------------------------------------------------------------ */

  private async coordinateEntry(
    candidate: BoxCandidate,
    detection: BoxEvaluation,
  ): Promise<
    | { ok: true; executionId: string; keys: string[]; opportunityId: string }
    | { ok: false; reason: "duplicate" | "price_moved" | "edge_disappeared" | "feed_unhealthy"; detail: string }
  > {
    const broker = this.deps.broker();
    const executionId = this.mintId("entry");
    const opportunityId = `${broker.toUpperCase()}:${candidate.key}`;

    // FAIL CLOSED. If a durable tier is required (multi-worker deployments) and the
    // configured store cannot provide one, live execution must not proceed
    // uncoordinated. Paper is allowed to continue on the in-process store so
    // development and tests still work, and it says so.
    if (this.deps.cfg.reservationRequireDurable && !this.deps.reservations.durable) {
      if (this.mode === "live") {
        this.stats.failedClosed++;
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "failed_closed",
          reason: "durable_reservations_required",
          store: this.deps.reservations.name,
        });
        return {
          ok: false,
          reason: "feed_unhealthy",
          detail:
            `live execution refused: BOX_RESERVATION_REQUIRE_DURABLE is set but the reservation ` +
            `store "${this.deps.reservations.name}" is not durable`,
        };
      }
    }

    // DUPLICATE GUARD — a different problem from instrument reservation. This one
    // catches the SAME strategy fired twice; the reservation catches DIFFERENT
    // strategies sharing a contract. Both are needed.
    const incumbent = this.activeOpportunities.get(opportunityId);
    if (incumbent !== undefined && this.active.has(incumbent)) {
      this.stats.duplicateSuppressed++;
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "suppressed_duplicate",
        incumbent,
      });
      return { ok: false, reason: "duplicate", detail: `identical opportunity already executing as ${incumbent}` };
    }

    const refs = this.refsForEntry(candidate);
    const keys = keysOf(refs);

    // Optional per-underlying budget. It NEVER replaces exact-leg exclusion — it is a
    // risk cap on top of it, and 0 disables it.
    const perUnderlying = this.deps.cfg.maxConcurrentPerUnderlying;
    if (perUnderlying > 0) {
      let sameUnderlying = 0;
      for (const entry of this.active.values()) if (entry.underlying === candidate.underlying) sameUnderlying++;
      if (sameUnderlying >= perUnderlying) {
        return {
          ok: false,
          reason: "duplicate",
          detail: `per-underlying execution budget reached (${sameUnderlying}/${perUnderlying})`,
        };
      }
    }

    const waitStarted = this.now();
    let attempt = this.acquire(executionId, refs);

    if (!attempt.ok) {
      this.stats.reservationConflicts++;
      const described = attempt.conflicts.map((c) => c.kind).join(",");
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "waiting",
        conflicts: attempt.conflicts.length,
        kinds: described,
      });
      this.waiting++;
      try {
        attempt = await this.waitForKeys(executionId, refs, waitStarted);
      } finally {
        this.waiting--;
      }
      if (!attempt.ok) {
        this.stats.expiredWhileWaiting++;
        this.waitSamples.add(this.now() - waitStarted);
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "expired_while_waiting",
          waitMs: this.now() - waitStarted,
        });
        return {
          ok: false,
          reason: "price_moved",
          detail: `waited ${this.now() - waitStarted}ms for a shared contract and gave up`,
        };
      }

      // REVALIDATE. Arriving at the front of the queue is not a reason to trade. The
      // book has moved while waiting, so the opportunity is re-measured and only
      // executed if it still qualifies on CURRENT prices.
      const waitMs = this.now() - waitStarted;
      this.waitSamples.add(waitMs);
      const verdict = this.revalidate(candidate, detection);
      if (!verdict.ok) {
        this.stats.revalidationRejected++;
        this.release(executionId, keys);
        this.log({
          execution: executionId,
          broker,
          underlying: candidate.underlying,
          status: "abort",
          reason: verdict.reason,
          waitMs,
          edgeBefore: detection.gross_edge ?? "null",
          edgeNow: verdict.edgeNow ?? "null",
        });
        return { ok: false, reason: "edge_disappeared", detail: `revalidation after ${waitMs}ms: ${verdict.reason}` };
      }
      this.stats.revalidationPassed++;
      this.log({
        execution: executionId,
        broker,
        underlying: candidate.underlying,
        status: "execute",
        waitMs,
        revalidated: true,
        edgeBefore: detection.gross_edge ?? "null",
        edgeNow: verdict.edgeNow ?? "null",
      });
    }

    this.active.set(executionId, { keys, underlying: candidate.underlying });
    this.activeOpportunities.set(opportunityId, executionId);
    return { ok: true, executionId, keys, opportunityId };
  }

  /**
   * Wait for every required contract to become free, event-driven.
   *
   * Woken by the holder's release. The poll interval is a backstop only — if it were
   * the primary mechanism this would just be a sleep with extra steps.
   */
  private async waitForKeys(
    executionId: string,
    refs: InstrumentLegRef[],
    startedAt: number,
  ): Promise<ReturnType<CoordinatedBoxExecutionGateway["acquire"]>> {
    const deadline = startedAt + this.deps.cfg.conflictWaitMaxMs;
    const keys = keysOf(refs);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    while (this.now() < deadline) {
      let wake: (() => void) | null = null;
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const off = this.deps.waitable?.onRelease(keys, () => wake?.());
      const remaining = Math.max(1, deadline - this.now());
      try {
        await Promise.race([woken, sleep(Math.min(DEFAULT_POLL_MS, remaining))]);
      } finally {
        off?.();
      }
      const retry = this.acquire(executionId, refs);
      if (retry.ok) return retry;
    }
    return { ok: false, conflicts: [] };
  }

  /**
   * Re-measure the opportunity on the CURRENT book.
   *
   * Reuses `evaluateCandidate`, the same pure function the scanner uses, so this can
   * never drift from the real qualification arithmetic. Three independent reasons to
   * abort: the legs are no longer executable, the edge has gone, or the edge has
   * decayed past the configured tolerance relative to what was detected.
   */
  private revalidate(
    candidate: BoxCandidate,
    detection: BoxEvaluation,
  ): { ok: true; edgeNow: number | null } | { ok: false; reason: string; edgeNow: number | null } {
    const now = this.now();
    const fresh = evaluateCandidate({
      candidate,
      quotes: this.deps.quotes.view(),
      now,
      maxAgeMs: this.deps.cfg.quoteMaxAgeMs,
      captureDepth: false,
    });
    const edgeNow = fresh.gross_edge;
    if (!fresh.tradable) return { ok: false, reason: `not_tradable:${fresh.reject ?? "unknown"}`, edgeNow };
    if (edgeNow === null) return { ok: false, reason: "edge_unpriced", edgeNow };
    if (edgeNow <= 0) return { ok: false, reason: "edge_gone", edgeNow };

    const before = detection.gross_edge;
    if (before !== null && before > 0) {
      const retained = edgeNow / before;
      const floor = this.deps.cfg.conflictRevalidateMinEdgeRatio;
      if (retained < floor) {
        return { ok: false, reason: `edge_deteriorated:${Math.round(retained * 100)}%`, edgeNow };
      }
    }
    return { ok: true, edgeNow };
  }

  private refsForEntry(candidate: BoxCandidate): InstrumentLegRef[] {
    const direction = candidate.direction ?? "LONG_BOX";
    return boxInstrumentRefs(
      this.deps.broker(),
      candidate.legs,
      (role: BoxLegRole): OrderSide => entrySideFor(role, direction),
      BOX_LEG_ROLES,
    );
  }

  private refsForExit(position: {
    underlying: string;
    legs: Record<BoxLegRole, BoxOptionInstrument>;
    direction?: BoxDirection;
  }): InstrumentLegRef[] {
    const direction = position.direction ?? "LONG_BOX";
    // The exit works the reverse side of each leg, so the reservation names the
    // contract on the side it will actually be traded.
    return boxInstrumentRefs(
      this.deps.broker(),
      position.legs,
      (role: BoxLegRole): OrderSide => (entrySideFor(role, direction) === "BUY" ? "SELL" : "BUY"),
      BOX_LEG_ROLES,
    );
  }

  private acquire(
    executionId: string,
    refs: InstrumentLegRef[],
  ): { ok: true } | { ok: false; conflicts: InstrumentConflict[] } {
    const now = this.now();
    const keys = keysOf(refs);
    const sideByKey = new Map<string, string>();
    for (const ref of refs) sideByKey.set(ref.key, ref.side);

    const outcome = this.deps.reservations.tryAcquireAll({
      owner: executionId,
      keys,
      ttlMs: this.deps.cfg.instrumentLockTtlMs,
      now,
      sideByKey,
    });
    if (outcome.ok) return { ok: true };

    const byKey = new Map(refs.map((r) => [r.key, r.side] as const));
    const conflicts = outcome.conflicts.map((c) =>
      classifyConflict(
        c.key,
        c.heldBy,
        this.deps.reservations.sideOf(c.key, now) as OrderSide | null,
        byKey.get(c.key) ?? "BUY",
      ),
    );
    return { ok: false, conflicts };
  }

  private release(executionId: string, keys: readonly string[]): void {
    this.deps.reservations.release({ owner: executionId, keys, now: this.now() });
  }

  /**
   * Decide whether an execution's reservation may be released.
   *
   * `clean` means the broker's position is knowable and settled — released, so a
   * later box may legitimately work the same contract for its own lot. `uncertain`
   * means residual exposure exists or the terminal state is ambiguous, and the
   * reservation is HELD until its TTL expires. Holding is the conservative choice:
   * releasing would let a second box assume there is no exposure on a contract that
   * may still carry some.
   */
  private settle(
    executionId: string,
    keys: readonly string[],
    opportunityId: string | null,
    outcome: "clean" | "uncertain",
  ): void {
    this.active.delete(executionId);
    if (opportunityId !== null) this.activeOpportunities.delete(opportunityId);
    if (outcome === "clean") {
      this.release(executionId, keys);
      return;
    }
    this.stats.reservationsHeldOnUncertainty++;
    this.log({
      execution: executionId,
      broker: this.deps.broker(),
      underlying: "-",
      status: "reservation_held",
      reason: "uncertain_terminal_state",
      ttlMs: this.deps.cfg.instrumentLockTtlMs,
    });
  }

  private holdOnUncertainty(executionId: string, opportunityId: string | null, why: string): void {
    this.active.delete(executionId);
    if (opportunityId !== null) this.activeOpportunities.delete(opportunityId);
    this.stats.reservationsHeldOnUncertainty++;
    this.log({
      execution: executionId,
      broker: this.deps.broker(),
      underlying: "-",
      status: "reservation_held",
      reason: why,
      ttlMs: this.deps.cfg.instrumentLockTtlMs,
    });
  }

  private mintId(kind: string): string {
    this.seq += 1;
    return `${kind}-${this.seq.toString(36)}-${this.now().toString(36)}`;
  }

  /** Broker switch: keys change namespace wholesale, so nothing may survive. */
  resetForBrokerSwitch(): void {
    this.deps.reservations.clear();
    this.active.clear();
    this.activeOpportunities.clear();
  }

  metrics(): CoordinatorMetricsSnapshot {
    const now = this.now();
    return {
      activeExecutions: this.active.size,
      activeInstrumentReservations: this.deps.reservations.activeCount(now),
      waitingExecutions: this.waiting,
      reservationConflicts: this.stats.reservationConflicts,
      duplicateSuppressed: this.stats.duplicateSuppressed,
      expiredWhileWaiting: this.stats.expiredWhileWaiting,
      revalidationRejected: this.stats.revalidationRejected,
      revalidationPassed: this.stats.revalidationPassed,
      reservationsHeldOnUncertainty: this.stats.reservationsHeldOnUncertainty,
      failedClosed: this.stats.failedClosed,
      waitMs: {
        p50: this.waitSamples.percentile(0.5),
        p95: this.waitSamples.percentile(0.95),
        samples: this.waitSamples.samples,
      },
      store: this.deps.reservations.name,
      durable: this.deps.reservations.durable,
    };
  }
}

/**
 * Was the terminal state knowable?
 *
 * Residual exposure or a failure that implies orders may still be working means the
 * contract must stay reserved. `abort_after_fill` is explicitly CLEAN: the box was
 * briefly complete and fully reversed, so nothing is outstanding.
 */
function uncertaintyOf(result: unknown): "clean" | "uncertain" {
  if (typeof result !== "object" || result === null) return "uncertain";
  const r = result as {
    ok?: boolean;
    reason?: string;
    legging?: { residual_exposure?: unknown[] };
    record?: { residual_exposure?: unknown[] };
  };
  const residual = r.legging?.residual_exposure ?? r.record?.residual_exposure;
  if (Array.isArray(residual) && residual.length > 0) return "uncertain";
  if (r.ok === true) return "clean";
  if (r.reason === "legging_incomplete" || r.reason === "unwind_failed") return "uncertain";
  return "clean";
}

/**
 * A minimal record for a refusal that never reached the executor.
 *
 * Explicitly typed as `PaperLeggingExecutionRecord` rather than cast, so the compiler
 * keeps verifying it against the real shape — a cast here would silently rot the
 * moment a field is added to the record.
 */
function emptyLeggingRecord(
  mode: BoxConfig["executionMode"],
  detectedAt: number,
  now: number,
  reason: BoxExecutionFailureReason,
  detail: string,
): PaperLeggingExecutionRecord {
  return {
    mode: mode === "live" ? "live" : "paper_legging",
    leg_execution_mode: "parallel",
    remaining_role_count: 0,
    failure_reason: reason,
    failure_detail: detail,
    detected_at: detectedAt,
    order_sent_at: now,
    filled_leg_count: 0,
    opened: false,
    failed_legs: [],
    legs: [],
    first_to_last_fill_ms: null,
    decision_to_first_fill_ms: null,
    decision_to_last_fill_ms: null,
    timed_out_legs: [],
    partial_fill_legs: [],
    exposure_started_at: null,
    exposure_ended_at: null,
    exposure_duration_ms: null,
    decision_to_complete_ms: null,
    total_entry_slippage: 0,
    emergency_unwind: false,
    partial_entry_charges: null,
    unwind_charges: null,
    legging_gross_loss: null,
    legging_net_loss: null,
    abort_after_fill: false,
    final_expected_net_profit: null,
    required_expected_net_profit: null,
    temporal: null,
    residual_exposure: [],
    submitted_leg_count: 0,
    fully_closed_role_count: 0,
    fills_by_role: {},
  };
}
