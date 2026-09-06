/**
 * OUTCOME AND REJECT STATISTICS — measured rates, never fabricated ones.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY LATENCY ALONE IS NOT ENOUGH (Phase 9, audit divergence D8)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * A simulator can reproduce live latency distributions perfectly and still be wrong about the only
 * thing that matters: how often a four-leg entry actually completes. Latency is an input; the
 * outcome is the result. So the OUTCOMES are measured directly — 4/4 fills, partials, timeouts,
 * cancel races, rejects, unwinds, residuals — per broker and per order profile.
 *
 * THE PURPOSE IS DIAGNOSIS, NOT MIMICRY. These rates are for comparing paper against live in a
 * parity report. Paper is emphatically NOT steered to hit them. Forcing a simulator to reproduce a
 * target failure rate by rolling dice would make it agree with live on average while being wrong
 * about every individual trade, and would destroy the reproducibility the whole model rests on.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * REJECTS: CLASSIFY WHAT REALLY HAPPENED (Phase 19)
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * There is no `Math.random() < rejectProbability` anywhere in this system, and there must not be.
 * Instead, ACTUAL live rejections are classified into families, counted, and reported. That gives a
 * real reject rate per family per broker, which is:
 *
 *   - useful (an RMS reject means something different from a rate-limit reject),
 *   - honest (every count corresponds to a rejection that really happened),
 *   - replayable (a recorded reject can be re-injected in a deterministic historical replay).
 *
 * For FORWARD paper simulation nothing is fabricated. A synthetic reject is available only under
 * the separate `stress` profile, which is never called live parity.
 */

import type { BrokerRejectFamily } from "./brokerAdapter.js";
import type { BoxExecutionOutcome } from "./brokerTimingStore.js";
import { BOX_EXECUTION_OUTCOMES } from "./brokerTimingStore.js";
import type { BrokerId, LatencyProfile } from "./latencyModel.js";

/**
 * The reject taxonomy, mapping the broker-neutral families onto the causes an operator cares about.
 *
 * Kept aligned with `BrokerRejectFamily` (which both adapters already populate) plus the two the
 * brief names separately and which the adapters express as `generic`: broker-internal faults and
 * genuinely unknown causes. Distinguishing them matters because "the broker had a problem" and "we
 * do not know" demand different responses.
 */
export const REJECT_CLASSES = [
  /** Risk-management-system refusal. */
  "rms",
  /** Insufficient margin. */
  "margin",
  /** Price outside the permitted band, or not tick-aligned. */
  "price_band",
  /** Quantity freeze limit breached. */
  "quantity_freeze",
  /** The market was not open for this instrument. */
  "market_closed",
  /** The instrument itself was unavailable/suspended. */
  "instrument_unavailable",
  /** Rate limited / throttled. */
  "rate_limit",
  /** Authentication or session failure. */
  "auth",
  /** Network or transport failure with no broker verdict. */
  "network_unknown",
  /** The broker reported an internal error. */
  "broker_internal",
  /** Classified by neither the adapter nor us. */
  "other",
] as const;
export type RejectClass = (typeof REJECT_CLASSES)[number];

/**
 * Map an adapter's reject family onto a reject class.
 *
 * `generic` becomes `other` rather than being guessed at. Inventing a cause for an unclassified
 * rejection would put fictional detail into the one statistic that is supposed to be evidence.
 */
export function rejectClassFor(family: BrokerRejectFamily | null, message?: string | null): RejectClass {
  switch (family) {
    case "rms":
      return "rms";
    case "margin":
      return "margin";
    case "price_band":
      return "price_band";
    case "quantity_freeze":
      return "quantity_freeze";
    case "market_closed":
      return "market_closed";
    case "instrument_unavailable":
      return "instrument_unavailable";
    case "rate_limit":
      return "rate_limit";
    case "auth":
      return "auth";
    case "generic":
    case null:
    case undefined: {
      // One narrow, evidence-based refinement: the adapters collapse transport failures and broker
      // faults into `generic`, and the message is the only signal available to separate them. The
      // patterns are conservative, and anything unmatched stays `other`.
      const text = (message ?? "").toLowerCase();
      if (/timeout|timed out|socket|econn|network|abort/.test(text)) return "network_unknown";
      if (/internal|5\d\d|unavailable|gateway/.test(text)) return "broker_internal";
      return "other";
    }
  }
}

export interface OutcomeCounts {
  readonly broker: BrokerId;
  readonly profile: LatencyProfile;
  readonly total: number;
  readonly counts: Readonly<Record<BoxExecutionOutcome, number>>;
  readonly rates: Readonly<Record<BoxExecutionOutcome, number>>;
}

export interface RejectCounts {
  readonly broker: BrokerId;
  readonly total: number;
  readonly counts: Readonly<Record<RejectClass, number>>;
  readonly rates: Readonly<Record<RejectClass, number>>;
}

/**
 * Bounded counters for execution outcomes and reject classes.
 *
 * Counters, not ring buffers: a rate needs a total, and totals are what a rate is. Memory is
 * O(brokers × profiles × classes), i.e. fixed and tiny. FAIL-OPEN throughout.
 */
export class ExecutionOutcomeStore {
  private readonly outcomes = new Map<string, number>();
  private readonly outcomeTotals = new Map<string, number>();
  private readonly rejects = new Map<string, number>();
  private readonly rejectTotals = new Map<BrokerId, number>();

  /** Record one Box attempt's outcome. Never throws. */
  recordOutcome(broker: BrokerId, profile: LatencyProfile, outcome: BoxExecutionOutcome): void {
    try {
      const key = `${broker}|${profile}|${outcome}`;
      this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
      const totalKey = `${broker}|${profile}`;
      this.outcomeTotals.set(totalKey, (this.outcomeTotals.get(totalKey) ?? 0) + 1);
    } catch {
      /* observability must never affect execution */
    }
  }

  /**
   * Record one REAL rejection, as classified from what the broker actually said.
   *
   * There is no counterpart that records a synthetic rejection: this method is only ever called
   * from a path that observed a genuine broker refusal.
   */
  recordReject(broker: BrokerId, family: BrokerRejectFamily | null, message?: string | null): RejectClass {
    const cls = rejectClassFor(family, message);
    try {
      const key = `${broker}|${cls}`;
      this.rejects.set(key, (this.rejects.get(key) ?? 0) + 1);
      this.rejectTotals.set(broker, (this.rejectTotals.get(broker) ?? 0) + 1);
    } catch {
      /* fail-open */
    }
    return cls;
  }

  outcomeCounts(broker: BrokerId, profile: LatencyProfile): OutcomeCounts {
    const total = this.outcomeTotals.get(`${broker}|${profile}`) ?? 0;
    const counts = {} as Record<BoxExecutionOutcome, number>;
    const rates = {} as Record<BoxExecutionOutcome, number>;
    for (const outcome of BOX_EXECUTION_OUTCOMES) {
      const c = this.outcomes.get(`${broker}|${profile}|${outcome}`) ?? 0;
      counts[outcome] = c;
      // A rate with a zero denominator is 0, not NaN — and the total is always reported alongside
      // so a 0 rate over 0 attempts is never mistaken for a measured 0 %.
      rates[outcome] = total > 0 ? Math.round((c / total) * 1000) / 1000 : 0;
    }
    return { broker, profile, total, counts, rates };
  }

  rejectCounts(broker: BrokerId): RejectCounts {
    const total = this.rejectTotals.get(broker) ?? 0;
    const counts = {} as Record<RejectClass, number>;
    const rates = {} as Record<RejectClass, number>;
    for (const cls of REJECT_CLASSES) {
      const c = this.rejects.get(`${broker}|${cls}`) ?? 0;
      counts[cls] = c;
      rates[cls] = total > 0 ? Math.round((c / total) * 1000) / 1000 : 0;
    }
    return { broker, total, counts, rates };
  }
}

/**
 * A recorded real rejection, for DETERMINISTIC HISTORICAL REPLAY.
 *
 * Replaying a rejection that genuinely occurred is evidence-based and reproducible. It is the
 * opposite of fabricating one: the event happened, at a known point, with a known cause, and
 * re-injecting it tests that the system still handles it correctly.
 */
export interface RecordedReject {
  readonly broker: BrokerId;
  readonly clientOrderId: string;
  readonly rejectClass: RejectClass;
  readonly family: BrokerRejectFamily | null;
  readonly message: string | null;
  readonly atWall: number;
}

/**
 * Replay recorded rejections by client order id.
 *
 * Deterministic and closed: it can only return rejections that were actually recorded. There is no
 * code path by which it can invent one, which is what makes it safe to use inside a replay while
 * remaining useless as a way to fabricate a reject rate.
 */
export class RecordedRejectReplayer {
  private readonly byClientOrderId = new Map<string, RecordedReject>();

  constructor(recorded: readonly RecordedReject[] = []) {
    for (const reject of recorded) this.byClientOrderId.set(reject.clientOrderId, reject);
  }

  /** The recorded rejection for an order, or null when that order was not rejected. */
  rejectFor(clientOrderId: string): RecordedReject | null {
    return this.byClientOrderId.get(clientOrderId) ?? null;
  }

  get size(): number {
    return this.byClientOrderId.size;
  }
}
