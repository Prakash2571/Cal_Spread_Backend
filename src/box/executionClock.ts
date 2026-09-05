/**
 * EXECUTION CLOCK — one monotonic clock for measuring, one wall clock for auditing.
 *
 * WHY TWO CLOCKS (audit divergence D2)
 *
 * Every latency number in this system was previously derived by subtracting two
 * `Date.now()` readings. `Date.now()` is a WALL clock: it is adjusted by NTP, it can step
 * backwards, and on a VM it can jump by seconds after a live migration or a host suspend.
 * A latency distribution built from wall-clock differences therefore contains fabricated
 * outliers — and worse, it can contain negative spans that get silently discarded, which
 * biases the surviving samples.
 *
 * `performance.now()` is monotonic: it never goes backwards and is not adjusted. It is the
 * only correct basis for a duration.
 *
 * But a monotonic reading is meaningless to a human — it is milliseconds since an arbitrary
 * process-local origin, and it is not comparable across processes or restarts. So an audit
 * trail needs the wall clock.
 *
 * Hence the rule this module exists to enforce:
 *
 *   MEASURE with `mono()`.  AUDIT with `wall()`.  NEVER mix them in one subtraction.
 *
 * {@link ExecutionInstant} captures both at once, so a recorded stage carries a duration-safe
 * reading and a human-meaningful timestamp that were taken at the same moment.
 *
 * DETERMINISM. The clock is injectable, and {@link createFixedExecutionClock} gives tests a
 * fully controlled pair of timelines. Nothing here reads a random source, and nothing here
 * performs I/O.
 *
 * FAIL-OPEN. If `performance.now()` is somehow unavailable the clock degrades to the wall
 * clock and says so via {@link ExecutionClock.monotonic}. It never throws: a clock failure
 * must not be able to stop an order from being cancelled.
 */

/**
 * A single moment, read on both clocks.
 *
 * `mono` and `wall` are NOT interchangeable and must never be subtracted from each other.
 */
export interface ExecutionInstant {
  /** Monotonic ms from an arbitrary process-local origin. For DURATIONS only. */
  readonly mono: number;
  /** Wall-clock ms since the Unix epoch. For AUDIT/display only. */
  readonly wall: number;
}

export interface ExecutionClock {
  /** Monotonic reading. Use for every duration. */
  mono(): number;
  /** Wall-clock reading. Use for audit trails, never for durations. */
  wall(): number;
  /** Both clocks read together, so a stage timestamp is duration-safe AND auditable. */
  stamp(): ExecutionInstant;
  /**
   * False when the platform could not supply a monotonic source and `mono()` is really the
   * wall clock. Surfaced in diagnostics so a latency distribution is never presented as
   * monotonic when it is not.
   */
  readonly monotonic: boolean;
}

/**
 * Difference between two MONOTONIC readings, in ms.
 *
 * Returns null when either endpoint is missing, non-finite, or the pair is inverted. An
 * inverted pair is a bug (or a wall clock masquerading as monotonic) and must be reported as
 * "unknown", never as a negative or an absolute value — a fabricated number in a latency
 * distribution is worse than a missing one.
 */
export function monoSpan(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const span = to - from;
  return span >= 0 ? span : null;
}

/**
 * Approximate the wall-clock time of a past monotonic reading, for audit rendering only.
 *
 * Anchored on an {@link ExecutionInstant} that captured both clocks simultaneously. The
 * result is an approximation (the two clocks can drift between the anchor and now) and must
 * never be fed back into a duration calculation.
 */
export function approximateWallFor(anchor: ExecutionInstant, mono: number): number {
  if (!Number.isFinite(mono)) return anchor.wall;
  return Math.round(anchor.wall + (mono - anchor.mono));
}

/** The real clock: `performance.now()` for measurement, `Date.now()` for audit. */
export function createExecutionClock(deps: {
  performanceNow?: () => number;
  dateNow?: () => number;
} = {}): ExecutionClock {
  const dateNow = deps.dateNow ?? Date.now;

  // Resolve the monotonic source ONCE, defensively. A platform without a usable
  // performance.now() degrades to the wall clock rather than throwing.
  let perfNow: (() => number) | null = null;
  if (deps.performanceNow) {
    perfNow = deps.performanceNow;
  } else {
    try {
      const candidate = typeof performance !== "undefined" ? performance : null;
      if (candidate && typeof candidate.now === "function") {
        const probe = candidate.now();
        if (Number.isFinite(probe)) perfNow = () => candidate.now();
      }
    } catch {
      perfNow = null;
    }
  }

  const monotonic = perfNow !== null;
  const mono = perfNow ?? dateNow;

  return {
    monotonic,
    mono,
    wall: dateNow,
    stamp(): ExecutionInstant {
      // Read the monotonic clock first: it is the one a duration depends on.
      const m = mono();
      const w = dateNow();
      return { mono: m, wall: w };
    },
  };
}

/**
 * A fully controlled clock for tests and deterministic replay.
 *
 * Both timelines advance only when the caller says so, and they advance independently — so a
 * test can simulate an NTP step (wall jumps, monotonic does not) and prove that latency
 * measurement is unaffected.
 */
export interface FixedExecutionClock extends ExecutionClock {
  /** Advance both clocks by the same amount — the normal case. */
  advance(ms: number): void;
  /** Advance only the monotonic clock. */
  advanceMono(ms: number): void;
  /** Move only the wall clock, including backwards — simulates an NTP correction. */
  setWall(ms: number): void;
}

export function createFixedExecutionClock(start: { mono?: number; wall?: number } = {}): FixedExecutionClock {
  let m = start.mono ?? 0;
  let w = start.wall ?? 0;
  return {
    monotonic: true,
    mono: () => m,
    wall: () => w,
    stamp: () => ({ mono: m, wall: w }),
    advance(ms: number): void {
      const d = Number.isFinite(ms) ? ms : 0;
      m += d;
      w += d;
    },
    advanceMono(ms: number): void {
      if (Number.isFinite(ms)) m += ms;
    },
    setWall(ms: number): void {
      if (Number.isFinite(ms)) w = ms;
    },
  };
}
