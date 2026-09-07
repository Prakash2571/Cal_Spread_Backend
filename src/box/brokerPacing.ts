/**
 * BROKER-AWARE LIVE TRANSPORT PACING POLICY.
 *
 * WHY THIS MODULE EXISTS
 *
 * `BOX_LIVE_BROKER_MIN_INTERVAL_MS` (default 250ms) was a SINGLE knob applied by the
 * adapters' shared `call()` throttle to EVERY transport operation alike: order placement,
 * modification, cancellation, order-status polls, positions reads, margins and health.
 * That conflates two genuinely different things:
 *
 *   1. A REAL broker rate limit on order mutation. Exceeding it earns a 429 and, at
 *      Zerodha, counts the rejected request against the daily order-request budget. This
 *      is a hard external constraint and must be honoured.
 *
 *   2. A POLL CADENCE we chose ourselves. How often we re-read a working order's status
 *      is our decision, and 250ms is a sensible, deliberately unhurried choice.
 *
 * Because both used one number, making the four-leg entry burst reach the broker faster
 * would have required lowering the status-poll cadence too — spending real API budget to
 * buy submission speed. Splitting them lets the four ENTRY placements be spaced at the
 * broker's actual published placement limit while polling stays calm.
 *
 * THIS IS NOT "REMOVING A DELAY". The gap between successive placements remains a REAL
 * rate-limit wait derived from published broker limits, never zero, and never below a
 * per-broker floor. See {@link BROKER_PACING_PROFILES}.
 *
 * PUBLISHED LIMITS THE DEFAULTS ARE DERIVED FROM
 *
 *   Zerodha / Kite Connect — order placement is limited to 10 requests/second, with a
 *   further 400 orders/minute and 5000 orders/day account cap, and NSE's algo framework
 *   permits individual traders up to 10 orders/second with a static IP. 10/s ⇒ a 100ms
 *   floor; the default adds 10% headroom (110ms) because the limiter is enforced on the
 *   broker's clock, not ours, and a burst that lands microseconds early is a 429.
 *   See docs/CONFIGURATION.md for the citation.
 *
 *   Dhan — order placement permits materially more than 10/s, but this repository's own
 *   `src/brokers/dhan/http.ts` already paces every HTTP call at `DHAN_MIN_INTERVAL_MS`
 *   (default 120ms). Any Box-level value below that is absorbed by the lower layer and
 *   would be a lie in the diagnostics, so the profile floor matches it at 120ms.
 *
 * NOTHING HERE PERFORMS I/O, reads the clock, or holds mutable state. It is a pure
 * description of policy so the adapters, the diagnostics endpoint and the paper
 * live_parity scheduler all read the SAME effective numbers and cannot drift.
 */

import type { BrokerId } from "./latencyModel.js";

/**
 * Which rate-limit bucket a transport operation belongs to.
 *
 *   "order_mutation" — place / modify / cancel. Governed by the broker's ORDER rate
 *                      limit. Cancellation is deliberately in the fast bucket: a
 *                      protective cancel is the operation we least want to slow down.
 *
 *   "general"        — order-status polls, order lists, positions, margins, health.
 *                      Governed by our own chosen cadence.
 */
export type BrokerPacingClass = "order_mutation" | "general";

/**
 * The per-broker floors and defaults for order-mutation pacing.
 *
 * `floorMs` is a HARD floor. An operator override below it is clamped UP, not honoured:
 * the floor encodes an external constraint (or a lower transport layer that will impose
 * the wait anyway), so permitting a smaller value would only make the reported number
 * dishonest while the wait still happened.
 */
export interface BrokerPacingProfile {
  readonly broker: BrokerId;
  /** Default gap (ms) between successive order mutations when no override is set. */
  readonly defaultOrderMutationMs: number;
  /** Hard minimum gap (ms). Overrides below this are clamped up to it. */
  readonly floorMs: number;
  /** Human-readable justification, surfaced verbatim in diagnostics. */
  readonly rationale: string;
}

export const BROKER_PACING_PROFILES: Readonly<Record<BrokerId, BrokerPacingProfile>> = Object.freeze({
  zerodha: Object.freeze({
    broker: "zerodha" as const,
    defaultOrderMutationMs: 110,
    floorMs: 100,
    rationale:
      "Kite Connect permits 10 order requests/second (100ms floor); the default adds 10% headroom " +
      "because the limiter runs on the broker's clock and a rejected request still consumes the " +
      "daily order-request budget.",
  }),
  dhan: Object.freeze({
    broker: "dhan" as const,
    defaultOrderMutationMs: 120,
    floorMs: 120,
    rationale:
      "Dhan permits more than 10 order requests/second, but src/brokers/dhan/http.ts already paces " +
      "every HTTP call at DHAN_MIN_INTERVAL_MS (default 120ms), so a smaller Box-level value would " +
      "be absorbed by the lower layer and misreported here.",
  }),
});

/**
 * The pacing actually in force for one broker, with its provenance.
 *
 * `source` exists so the diagnostics endpoint can answer "why is it this number?" without
 * the reader having to reconstruct the clamp chain in their head.
 */
export interface EffectiveBrokerPacing {
  readonly broker: BrokerId;
  /** Gap (ms) enforced between successive place/modify/cancel calls. */
  readonly orderMutationMinIntervalMs: number;
  /** Gap (ms) enforced between all other transport calls, incl. status polls. */
  readonly generalMinIntervalMs: number;
  /** Where `orderMutationMinIntervalMs` came from. */
  readonly source: "broker_default" | "operator_override" | "clamped_to_floor" | "clamped_to_general";
  /** The broker's hard floor, for display. */
  readonly floorMs: number;
  readonly rationale: string;
}

/**
 * Resolve the effective pacing for a broker.
 *
 * @param broker              the broker the adapter is talking to.
 * @param generalMinIntervalMs `BOX_LIVE_BROKER_MIN_INTERVAL_MS` — the existing knob, still
 *                             governing polls and every non-mutating call. Unchanged in
 *                             meaning, which is why existing deployments see no behaviour
 *                             change for those calls.
 * @param orderOverrideMs      `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS`. `0` (the default)
 *                             means "use the broker profile default". Any positive value
 *                             is an operator override, clamped up to the broker floor.
 *
 * Total and pure: unknown brokers fall back to the STRICTEST profile rather than to no
 * pacing, because an unrecognised broker is exactly the case where we know least about
 * its limits.
 */
export function resolveBrokerPacing(
  broker: BrokerId | string,
  generalMinIntervalMs: number,
  orderOverrideMs: number,
): EffectiveBrokerPacing {
  const profile = brokerPacingProfile(broker);
  const general = Number.isFinite(generalMinIntervalMs) ? Math.max(0, Math.floor(generalMinIntervalMs)) : 250;

  let order: number;
  let source: EffectiveBrokerPacing["source"];
  if (Number.isFinite(orderOverrideMs) && Math.floor(orderOverrideMs) > 0) {
    const requested = Math.floor(orderOverrideMs);
    if (requested < profile.floorMs) {
      order = profile.floorMs;
      source = "clamped_to_floor";
    } else {
      order = requested;
      source = "operator_override";
    }
  } else {
    order = profile.defaultOrderMutationMs;
    source = "broker_default";
  }

  // NEVER SLOWER THAN THE GENERAL INTERVAL WOULD HAVE BEEN is NOT a rule: the general
  // interval may legitimately be tightened below the order floor by an operator, in which
  // case order mutation must still respect its own (larger) floor. But the reverse — an
  // order interval LARGER than the general one — is honoured as-is, since a deliberately
  // slow placement cadence is a safe direction to err in.
  //
  // The one correction worth making: if the general interval is TIGHTER than the order
  // interval the operator asked for, the operator has not been misled, so nothing changes.
  // If the general interval is looser, the effective spacing of a placement is still the
  // order interval because the two buckets are tracked independently below.
  if (order < profile.floorMs) {
    order = profile.floorMs;
    source = "clamped_to_floor";
  }

  return {
    broker: profile.broker,
    orderMutationMinIntervalMs: order,
    generalMinIntervalMs: general,
    source,
    floorMs: profile.floorMs,
    rationale: profile.rationale,
  };
}

/** The profile for a broker id, defaulting to the strictest known profile. */
export function brokerPacingProfile(broker: BrokerId | string): BrokerPacingProfile {
  const key = typeof broker === "string" ? broker.trim().toLowerCase() : broker;
  if (key === "zerodha") return BROKER_PACING_PROFILES.zerodha;
  if (key === "dhan") return BROKER_PACING_PROFILES.dhan;
  return strictestProfile();
}

/**
 * The most conservative profile across all known brokers.
 *
 * Used for an unrecognised broker id. Picking the LARGEST floor and the LARGEST default is
 * the fail-closed direction: pacing too slowly costs latency, pacing too quickly costs a
 * rate-limit rejection on a real order.
 */
function strictestProfile(): BrokerPacingProfile {
  const all = [BROKER_PACING_PROFILES.zerodha, BROKER_PACING_PROFILES.dhan];
  const floorMs = Math.max(...all.map((p) => p.floorMs));
  const defaultOrderMutationMs = Math.max(...all.map((p) => p.defaultOrderMutationMs));
  return {
    // The strictest profile is not attributable to one broker; report the safest label.
    broker: "zerodha",
    defaultOrderMutationMs,
    floorMs,
    rationale:
      "Unrecognised broker id: falling back to the strictest known pacing profile, because an " +
      "unknown broker is exactly the case where its published limits are least certain.",
  };
}

/**
 * The wait (ms) an operation must serve before it may touch the transport.
 *
 * Pure: the caller owns the clock and the "last call" bookkeeping, one watermark PER
 * CLASS. Returns 0 when the required gap has already elapsed, and never a negative number.
 *
 * Separate watermarks are what makes the split real. Sharing one watermark would mean a
 * status poll 10ms ago forced the next PLACEMENT to wait the general interval, which is
 * the very conflation this module removes.
 */
export function pacingWaitMs(args: {
  readonly pacing: EffectiveBrokerPacing;
  readonly klass: BrokerPacingClass;
  readonly lastCallAt: number;
  readonly now: number;
}): number {
  const required = args.klass === "order_mutation"
    ? args.pacing.orderMutationMinIntervalMs
    : args.pacing.generalMinIntervalMs;
  if (!Number.isFinite(args.lastCallAt)) return 0;
  const elapsed = args.now - args.lastCallAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    // A non-monotonic clock reading. Serve the FULL interval rather than trusting a
    // negative elapsed time, which would otherwise let a clock step bypass pacing.
    return required;
  }
  return Math.max(0, required - elapsed);
}

/**
 * Worst-case wall-clock cost (ms) of pacing a burst of `legCount` order mutations.
 *
 * The first placement pays nothing (its predecessor is a poll on the other watermark, or
 * nothing at all), so `legCount - 1` gaps are paid. Reported in diagnostics so an operator
 * can see the pacing floor on first-to-last submit WITHOUT having to place a real order.
 */
export function burstPacingBudgetMs(pacing: EffectiveBrokerPacing, legCount: number): number {
  const legs = Number.isFinite(legCount) ? Math.max(0, Math.floor(legCount)) : 0;
  if (legs <= 1) return 0;
  return (legs - 1) * pacing.orderMutationMinIntervalMs;
}

/** Cumulative pacing observations, for diagnostics. Bounded and low-cardinality. */
export interface TransportPacerStats {
  readonly orderMutations: number;
  readonly generalCalls: number;
  readonly totalWaitMs: number;
  readonly orderMutationWaitMs: number;
  readonly generalWaitMs: number;
  /** Times the ABSOLUTE floor (not the class interval) was the binding constraint. */
  readonly absoluteFloorBinds: number;
  readonly maxObservedWaitMs: number;
}

/**
 * The transport pacer both live adapters share.
 *
 * WHY A CLASS RATHER THAN TWO COPIES OF THE ARITHMETIC: the Kite and Dhan adapters
 * previously each had their own inline `call()` throttle. Duplicated pacing arithmetic in a
 * safety-critical path is how the two brokers silently drift apart, and it also meant the
 * effective interval could not be reported honestly from one place.
 *
 * THREE WATERMARKS, and why each exists:
 *
 *   lastOrderMutationAt — gates place/modify/cancel at the broker's ORDER limit.
 *   lastGeneralAt       — gates polls/reads at our chosen cadence.
 *   lastAnyCallAt       — an ABSOLUTE floor across every call regardless of class.
 *
 * The third is the important one. Splitting one bucket into two independent buckets raises
 * the achievable TOTAL request rate: with only per-class watermarks, alternating a poll and a
 * placement could exceed the broker's overall cap even while each class respected its own
 * interval. The absolute floor bounds total transport at `1 / orderMutationMinIntervalMs`
 * (10/s for Zerodha — exactly its published ceiling), so splitting the buckets buys entry
 * speed WITHOUT raising the peak rate the broker sees.
 *
 * The pacer holds no timers: the caller injects `now` and `wait`, which is what lets the
 * tests drive it on a virtual clock and assert the exact gaps.
 */
export class TransportPacer {
  private lastOrderMutationAt = Number.NEGATIVE_INFINITY;
  private lastGeneralAt = Number.NEGATIVE_INFINITY;
  private lastAnyCallAt = Number.NEGATIVE_INFINITY;
  /** FIFO chain: one transport call at a time, so waiters space out instead of colliding. */
  private tail: Promise<void> = Promise.resolve();

  private orderMutations = 0;
  private generalCalls = 0;
  private totalWaitMs = 0;
  private orderMutationWaitMs = 0;
  private generalWaitMs = 0;
  private absoluteFloorBinds = 0;
  private maxObservedWaitMs = 0;

  constructor(
    private pacing: EffectiveBrokerPacing,
    private readonly clock: { now: () => number; wait: (ms: number) => Promise<void> },
  ) {}

  /** The pacing currently in force. */
  effective(): EffectiveBrokerPacing {
    return this.pacing;
  }

  /**
   * Replace the pacing in force, e.g. after a broker switch.
   *
   * Watermarks are deliberately RETAINED: the requests already sent still happened, and
   * resetting them would let a broker switch be used to issue an immediate unpaced burst.
   */
  repoint(pacing: EffectiveBrokerPacing): void {
    this.pacing = pacing;
  }

  stats(): TransportPacerStats {
    return {
      orderMutations: this.orderMutations,
      generalCalls: this.generalCalls,
      totalWaitMs: this.totalWaitMs,
      orderMutationWaitMs: this.orderMutationWaitMs,
      generalWaitMs: this.generalWaitMs,
      absoluteFloorBinds: this.absoluteFloorBinds,
      maxObservedWaitMs: this.maxObservedWaitMs,
    };
  }

  /**
   * Run `operation` after serving its pacing wait.
   *
   * `klass` defaults to `"general"` so that a call site which forgets to classify itself is
   * paced by the SLOWER interval. Defaulting the other way would silently grant an
   * unclassified call the order-mutation rate.
   */
  run<T>(operation: () => Promise<T>, klass: BrokerPacingClass = "general"): Promise<T> {
    const run = this.tail.then(async () => {
      const now = this.clock.now();
      const classWait = pacingWaitMs({
        pacing: this.pacing,
        klass,
        lastCallAt: klass === "order_mutation" ? this.lastOrderMutationAt : this.lastGeneralAt,
        now,
      });
      // The absolute floor uses the order-mutation interval as the tightest permissible gap
      // between ANY two transport calls, bounding total request rate.
      const absoluteWait = pacingWaitMs({
        pacing: this.pacing,
        klass: "order_mutation",
        lastCallAt: this.lastAnyCallAt,
        now,
      });
      const wait = Math.max(classWait, absoluteWait);
      if (absoluteWait > classWait) this.absoluteFloorBinds++;
      if (wait > 0) await this.clock.wait(wait);

      const at = this.clock.now();
      this.lastAnyCallAt = at;
      if (klass === "order_mutation") {
        this.lastOrderMutationAt = at;
        this.orderMutations++;
        this.orderMutationWaitMs += wait;
      } else {
        this.lastGeneralAt = at;
        this.generalCalls++;
        this.generalWaitMs += wait;
      }
      this.totalWaitMs += wait;
      if (wait > this.maxObservedWaitMs) this.maxObservedWaitMs = wait;
      return operation();
    });
    // Keep the pacing chain alive after failures without swallowing the caller's error.
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
