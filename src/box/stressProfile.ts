/**
 * STRESS PROFILE — deliberate fault injection for RESILIENCE testing. Explicitly NOT live parity.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE PROFILE, AND WHY THE NAME MATTERS
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * There are two completely different questions one might ask a simulator:
 *
 *   "What would have happened?"      — answered by EVIDENCE. That is `live_parity`, and every
 *                                      number in it must be traceable to a real observation.
 *   "Does the system survive X?"     — answered by INJECTING X. That is this profile.
 *
 * Both are valuable. Mixing them is not: the moment a fabricated broker reject can appear in a
 * `live_parity` run, every statistic that run produces becomes uninterpretable, because a reader
 * cannot tell which failures were observed and which were invented. Worse, it would let the
 * system report a realistic-looking reject rate that came from a constant in a config file.
 *
 * So the separation is structural, not conventional:
 *
 *  - the profile is a distinct value (`stress`), never a fallback, never reached by default;
 *  - `loadBoxConfig` REFUSES TO START if `stress` is combined with live execution;
 *  - `BoxExecutionSimulator.calibrationStatus()` reports `evidence_driven: false` and forces
 *    confidence to LOW for this profile, so a stress run can never claim measured confidence;
 *  - nothing in this module is reachable from the `live_parity` code path.
 *
 * IT IS STILL DETERMINISTIC. Faults are injected from an explicit SCHEDULE — "fail operation 3,
 * then operation 7" — not from `Math.random()`. A resilience test that cannot be reproduced is
 * not a test, and a random simulator cannot be pinned by a golden fixture. This is the same
 * discipline the rest of the execution model follows.
 */

/**
 * The fault classes worth testing, from the brief.
 *
 * Each corresponds to a real failure this system has to survive, and each has a specific correct
 * behaviour that a resilience test asserts:
 */
export const STRESS_FAULTS = [
  /** The broker answers, but slowly enough to breach our deadlines. */
  "broker_slowdown",
  /** The market-data feed stops entirely. Qualification must stop, not use stale books. */
  "feed_outage",
  /** The feed reconnects, so pre-gap books are stale and a warmup is required. */
  "websocket_gap",
  /** A POST that never returns. Outcome UNKNOWN; must reconcile, never resubmit. */
  "http_timeout",
  /** An ACK that arrives after our ACK deadline. */
  "delayed_ack",
  /** A cancel confirmation that arrives late — the cancel-vs-fill race, widened. */
  "delayed_cancel",
  /** An order that only partially fills, leaving a remainder. */
  "partial_fill",
  /** A definitive broker refusal. NEVER injected under live_parity. */
  "broker_reject",
  /** Persistence unavailable. A fill that cannot be recorded must trip the breaker. */
  "mongo_failure",
  /** Cache/coordination unavailable. */
  "redis_failure",
  /** The process dies and restarts; durable state must reconcile broker truth. */
  "process_restart",
  /** The same broker event delivered twice. Must not double-count. */
  "duplicate_broker_event",
  /** Broker events delivered out of order. Must not reduce cumulative quantity. */
  "out_of_order_broker_event",
] as const;
export type StressFault = (typeof STRESS_FAULTS)[number];

/**
 * When a fault fires.
 *
 * `everyNth` and `atOperations` are both explicit and reproducible. There is no probability
 * field, on purpose: a probability would make a run unreproducible and would let the profile
 * quietly resemble a statistical model of real failures, which is exactly the confusion this
 * profile is designed to prevent.
 */
export interface StressFaultSchedule {
  readonly fault: StressFault;
  /** Fire on operations whose 1-based index is a multiple of this. Omit for none. */
  readonly everyNth?: number;
  /** Fire on these specific 1-based operation indices. */
  readonly atOperations?: readonly number[];
  /** Fault-specific magnitude, e.g. added latency in ms, or the quantity to fill. */
  readonly magnitude?: number;
}

export interface StressProfileConfig {
  readonly schedules: readonly StressFaultSchedule[];
}

/**
 * A deterministic fault injector.
 *
 * Ask it, per operation, which faults fire. The answer depends ONLY on the operation index and
 * the schedule, so the same configuration always produces the same run — which is what lets a
 * resilience test assert an exact outcome and what lets a golden fixture pin the behaviour.
 */
export class StressInjector {
  private operationCount = 0;
  private readonly fired = new Map<StressFault, number>();

  constructor(private readonly config: StressProfileConfig) {}

  /** Advance to the next operation and return the faults that fire for it. */
  nextOperation(): StressFault[] {
    this.operationCount++;
    const index = this.operationCount;
    const faults: StressFault[] = [];
    for (const schedule of this.config.schedules) {
      const byNth =
        schedule.everyNth !== undefined && schedule.everyNth > 0 && index % Math.floor(schedule.everyNth) === 0;
      const byIndex = schedule.atOperations?.includes(index) ?? false;
      if (byNth || byIndex) {
        faults.push(schedule.fault);
        this.fired.set(schedule.fault, (this.fired.get(schedule.fault) ?? 0) + 1);
      }
    }
    return faults;
  }

  /** Whether a specific fault fires for the CURRENT operation, without advancing. */
  firesNow(fault: StressFault): boolean {
    const index = this.operationCount;
    if (index <= 0) return false;
    return this.config.schedules.some((schedule) => {
      if (schedule.fault !== fault) return false;
      const byNth =
        schedule.everyNth !== undefined && schedule.everyNth > 0 && index % Math.floor(schedule.everyNth) === 0;
      return byNth || (schedule.atOperations?.includes(index) ?? false);
    });
  }

  /** Magnitude configured for a fault, or the supplied default. */
  magnitudeFor(fault: StressFault, fallback: number): number {
    const schedule = this.config.schedules.find((s) => s.fault === fault);
    const value = schedule?.magnitude;
    return value !== undefined && Number.isFinite(value) ? value : fallback;
  }

  /** How many times each fault has fired. For asserting a resilience test really exercised it. */
  report(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [fault, count] of this.fired) out[fault] = count;
    return out;
  }

  get operations(): number {
    return this.operationCount;
  }
}

/**
 * Build an injector, refusing to do so outside the stress profile.
 *
 * THIS IS THE LOAD-BEARING GUARD of this module. It makes "stress faults cannot appear in a
 * live_parity run" a property of the code rather than a convention someone has to remember: there
 * is no way to obtain an injector unless the profile is explicitly `stress`.
 */
export function createStressInjector(args: {
  profile: string;
  config: StressProfileConfig;
}): StressInjector {
  if (args.profile !== "stress") {
    throw new Error(
      `[Box] refusing to create a stress fault injector under the "${args.profile}" profile. ` +
        `Fault injection is only available under BOX_PAPER_EXECUTION_PROFILE=stress, because an injected ` +
        `fault must never be mistakable for observed behaviour in a live_parity run.`,
    );
  }
  return new StressInjector(args.config);
}

/**
 * A label for any report produced under a given profile.
 *
 * Used so a rendered report can never be mistaken for evidence. The stress banner is deliberately
 * blunt.
 */
export function profileReportBanner(profile: string): string {
  if (profile === "stress") {
    return (
      "⚠ STRESS PROFILE — SYNTHETIC FAULTS INJECTED. These figures are NOT measured execution " +
      "behaviour and must NEVER be quoted as live parity or used for calibration."
    );
  }
  if (profile === "live_parity") {
    return "live_parity — evidence-driven. Latency and cancel windows come from measured live observations where calibration is valid.";
  }
  return `${profile} — configured constants; not calibrated against live observations.`;
}
