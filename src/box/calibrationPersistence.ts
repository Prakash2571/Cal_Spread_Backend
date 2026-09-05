/**
 * CALIBRATION PERSISTENCE — bounded, asynchronous, and never on the hot path.
 *
 * WHY (audit divergence D12)
 *
 * The in-memory calibration store is the right structure for hot-path metrics: O(1) writes, fixed
 * memory, no I/O. But it dies with the process. A restart at 09:30 therefore throws away the
 * morning's evidence and drops paper back to its constant fallback — precisely when calibration is
 * most valuable.
 *
 * So observations need to be persisted. The danger is obvious: persistence means I/O, and I/O on
 * the order path means latency, which is the very thing being measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE RULES THIS BUFFER ENFORCES
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 *  1. NO SYNCHRONOUS WRITE PER MICRO-EVENT. `record()` appends to an in-memory array and returns.
 *     It never awaits, never touches the network, and never blocks the caller.
 *  2. BOUNDED. The buffer has a hard cap. When it is full, the OLDEST observations are dropped and
 *     the loss is COUNTED. An unbounded buffer under a slow sink is just a memory leak with extra
 *     steps, and in a trading process that is an outage.
 *  3. BATCHED. Observations flush when the batch size is reached or the flush interval elapses,
 *     whichever comes first — so a quiet period still persists, and a busy period still batches.
 *  4. FAILURE IS REPORTED, NEVER FAKED. If the sink fails, execution continues, the loss appears in
 *     {@link CalibrationPersistenceBuffer.diagnostics}, and NO substitute samples are generated. A
 *     fabricated sample would corrupt the calibration that persistence exists to protect.
 *  5. ONE FLUSH AT A TIME. A slow sink cannot cause overlapping writes that reorder or duplicate.
 *
 * The buffer is deliberately agnostic about WHERE observations go. It takes a sink function, so
 * Mongo, a file, or a test spy are all the same to it — and the hot path never learns which.
 */

import type { CalibrationSample } from "./executionCalibration.js";

/** Where a batch of observations is written. May be slow; may fail; must not be trusted. */
export type CalibrationSink = (batch: readonly CalibrationSample[]) => Promise<void>;

export interface CalibrationPersistenceOptions {
  enabled: boolean;
  sink: CalibrationSink;
  /** Observations buffered before an automatic flush. */
  batchSize: number;
  /** Maximum time (ms) an observation waits before being flushed. */
  flushMs: number;
  /**
   * Hard cap on buffered observations. Beyond this the oldest are dropped and counted.
   * Defaults to 20× the batch size, floored at 1000.
   */
  maxBuffered?: number;
  /** Wall clock, injected so tests control flush timing exactly. */
  now?: () => number;
  /** Schedules the interval timer. Injected so tests can drive flushes without real time. */
  setInterval?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (handle: NodeJS.Timeout) => void;
}

export interface CalibrationPersistenceDiagnostics {
  enabled: boolean;
  /** Observations accepted into the buffer. */
  buffered_total: number;
  /** Observations currently waiting. */
  pending: number;
  /** Observations successfully written. */
  persisted_total: number;
  /**
   * Observations LOST — dropped because the buffer was full, or discarded after a failed flush.
   *
   * Surfaced prominently because silent sample loss is indistinguishable from a broker that got
   * faster, and would quietly corrupt every distribution downstream.
   */
  lost_total: number;
  /** Flushes that failed. */
  flush_failures: number;
  /** The most recent failure message, for diagnosis. */
  last_error: string | null;
  /** Whether a flush is in progress right now. */
  flushing: boolean;
}

export class CalibrationPersistenceBuffer {
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly maxBuffered: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;

  private buffer: CalibrationSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;
  private bufferedTotal = 0;
  private persistedTotal = 0;
  private lostTotal = 0;
  private flushFailures = 0;
  private lastError: string | null = null;
  private disposed = false;

  constructor(private readonly opts: CalibrationPersistenceOptions) {
    this.enabled = opts.enabled === true;
    // THE CAP IS AUTHORITATIVE. `maxBuffered` is a memory-safety bound; `batchSize` is a
    // throughput preference. If a configuration asks for a batch larger than the cap, the cap
    // wins and the batch shrinks — the opposite would let a throughput knob quietly raise a
    // memory ceiling, which is how a diagnostics buffer becomes an outage.
    this.maxBuffered = Math.max(1, Math.floor(opts.maxBuffered ?? Math.max(1_000, Math.floor(opts.batchSize) * 20)));
    this.batchSize = Math.max(1, Math.min(Math.floor(opts.batchSize), this.maxBuffered));
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.cancel = opts.clearInterval ?? ((handle) => clearInterval(handle));
  }

  /** Begin the periodic flush. Idempotent, and a no-op when disabled. */
  start(): void {
    if (!this.enabled || this.timer !== null || this.disposed) return;
    try {
      const handle = this.schedule(() => {
        void this.flush();
      }, Math.max(1, Math.floor(this.opts.flushMs)));
      // Never hold the process open for a diagnostics flush.
      (handle as { unref?: () => void }).unref?.();
      this.timer = handle;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Buffer one observation.
   *
   * HOT PATH SAFE: one array push, one comparison. No await, no I/O, cannot throw.
   */
  record(sample: CalibrationSample): void {
    if (!this.enabled || this.disposed) return;
    try {
      this.buffer.push(sample);
      this.bufferedTotal++;
      if (this.buffer.length > this.maxBuffered) {
        // Drop the OLDEST: recent observations describe current conditions, which is what
        // calibration is for. Losing them silently is the failure mode to avoid, so the count is
        // reported.
        const overflow = this.buffer.length - this.maxBuffered;
        this.buffer.splice(0, overflow);
        this.lostTotal += overflow;
      }
      if (this.buffer.length >= this.batchSize) void this.flush();
    } catch (error) {
      this.lostTotal++;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Write the pending batch.
   *
   * Serialised: a second call while a flush is in flight returns the SAME promise rather than
   * starting an overlapping write, which could reorder or duplicate observations at the sink.
   *
   * NEVER REJECTS. A sink failure is recorded and swallowed, because the caller is the trading
   * process and it has more important work to do.
   */
  flush(): Promise<void> {
    if (!this.enabled || this.disposed) return Promise.resolve();
    if (this.flushInFlight) return this.flushInFlight;
    if (this.buffer.length === 0) return Promise.resolve();

    const batch = this.buffer;
    this.buffer = [];
    const run = (async (): Promise<void> => {
      try {
        await this.opts.sink(batch);
        this.persistedTotal += batch.length;
      } catch (error) {
        this.flushFailures++;
        this.lastError = error instanceof Error ? error.message : String(error);
        // The batch is DISCARDED rather than retried indefinitely.
        //
        // Retrying forever would grow memory without bound while the sink is down, turning a
        // diagnostics outage into a process outage. Losing latency samples is survivable; losing the
        // trading process is not. The loss is counted so it is visible, and no replacement samples
        // are invented.
        this.lostTotal += batch.length;
      } finally {
        this.flushInFlight = null;
      }
    })();
    this.flushInFlight = run;
    return run;
  }

  /** Stop the timer and make a final attempt to persist what is pending. */
  async dispose(): Promise<void> {
    if (this.timer !== null) {
      try {
        this.cancel(this.timer);
      } catch {
        /* fail-open */
      }
      this.timer = null;
    }
    // A final flush BEFORE disposing, so a clean shutdown does not throw away the session's tail.
    await this.flush().catch(() => undefined);
    this.disposed = true;
  }

  diagnostics(): CalibrationPersistenceDiagnostics {
    return {
      enabled: this.enabled,
      buffered_total: this.bufferedTotal,
      pending: this.buffer.length,
      persisted_total: this.persistedTotal,
      lost_total: this.lostTotal,
      flush_failures: this.flushFailures,
      last_error: this.lastError,
      flushing: this.flushInFlight !== null,
    };
  }
}
