/**
 * Deterministic latency source for live-parity paper execution.
 *
 * WHY
 * The existing paper modes use one constant simulated latency for every leg forever.
 * Real server→broker→exchange latency is a distribution with a tail: most orders arrive
 * quickly, some arrive late enough that the book has moved. A single constant either
 * hides the tail (optimistic) or overweights it (pessimistic). This lets paper draw from
 * a supplied set of observed latencies instead — the eventual goal being to feed real
 * measured `server→ACK` / `server→first-fill` samples back in and have paper behave like
 * the account actually did.
 *
 * DETERMINISM IS NON-NEGOTIABLE. No `Math.random()`. `recorded_samples` is consumed in a
 * fixed order, and an optional seed only chooses a fixed starting offset — so the same
 * config + the same sequence of draws yields byte-identical results every run, which is
 * what keeps the simulator reproducible and the tests stable. A Go port consuming the
 * same samples in the same order gets the same schedule.
 *
 * IT MODELS ONLY LATENCY WE CAN MEASURE. It does not invent jitter, market impact or
 * broker rejects; those must come from real calibration data, not a random generator.
 */

export type LatencyMode = "constant" | "recorded_samples";

export interface LatencySourceConfig {
  mode: LatencyMode;
  /** Used for `constant`, and as the fallback when no samples are supplied. */
  constantMs: number;
  /** Observed latency samples (ms) for `recorded_samples`. */
  samples?: number[];
  /**
   * Fixed starting offset into `samples`. Deterministic: a seed only rotates the cycle
   * start, it never introduces randomness. Omitted ⇒ start at 0.
   */
  seed?: number;
}

/**
 * A latency source is a pure sequence generator: `next()` returns the latency (ms) for
 * the next order and advances an internal cursor. Sanitised to a finite, non-negative
 * integer so it can never produce a negative or NaN delay.
 */
export interface LatencySource {
  readonly mode: LatencyMode;
  next(): number;
  /** Restart the sequence — a fresh run reproduces the same draws. */
  reset(): void;
}

function sanitise(ms: number, fallback: number): number {
  if (!Number.isFinite(ms) || ms < 0) return Math.max(0, Math.round(fallback));
  return Math.round(ms);
}

class ConstantLatencySource implements LatencySource {
  readonly mode = "constant" as const;
  private readonly value: number;
  constructor(constantMs: number) {
    this.value = sanitise(constantMs, 0);
  }
  next(): number {
    return this.value;
  }
  reset(): void {
    /* stateless */
  }
}

class RecordedLatencySource implements LatencySource {
  readonly mode = "recorded_samples" as const;
  private readonly samples: number[];
  private readonly start: number;
  private cursor: number;

  constructor(samples: number[], constantMs: number, seed: number) {
    // Keep only usable samples; fall back to the constant if none survive, so this can
    // never divide by zero or return undefined.
    const clean = samples.map((s) => sanitise(s, constantMs)).filter((s) => Number.isFinite(s));
    this.samples = clean.length > 0 ? clean : [sanitise(constantMs, 0)];
    // A seed only picks a fixed starting index — deterministic, not random.
    this.start = ((Math.trunc(seed) % this.samples.length) + this.samples.length) % this.samples.length;
    this.cursor = this.start;
  }

  next(): number {
    const value = this.samples[this.cursor % this.samples.length]!;
    this.cursor++;
    return value;
  }

  reset(): void {
    this.cursor = this.start;
  }
}

/** Build a latency source from config. Always returns a usable, deterministic source. */
export function createLatencySource(config: LatencySourceConfig): LatencySource {
  if (config.mode === "recorded_samples") {
    return new RecordedLatencySource(config.samples ?? [], config.constantMs, config.seed ?? 0);
  }
  return new ConstantLatencySource(config.constantMs);
}
