/**
 * Top-level graceful shutdown coordination.
 *
 * WHAT THIS IS FOR
 * The process owns an HTTP server, the Box engine (scanner, position monitor, order
 * manager, metrics, P&L archiver), a broker market-data feed, refcounted subscriptions,
 * several capture schedulers, and up to six Mongo connections. On `SIGTERM` none of that
 * was stopped: the process just died. That is survivable — the durable recovery path
 * adopts open positions on restart — but it means in-flight writes are cut mid-flight
 * and timers can fire against a closing database.
 *
 * This runs the EXISTING `stop()` / `dispose()` hooks in a deliberate order. It does not
 * reimplement any of them.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * IT MUST NEVER FLATTEN POSITIONS.
 *
 * A graceful shutdown is NOT an instruction to close open boxes. Placing broker orders
 * because the process received a signal would turn a routine redeploy into a forced
 * liquidation at whatever the book happens to be — the single most expensive thing this
 * file could get wrong. Open positions stay open; the durable recovery mechanism adopts
 * them after restart, exactly as it does today after a crash.
 *
 * Every hook used here has been checked against that rule:
 *   engine.stop()      documented as NOT dropping positions; disables discovery only
 *   engine.dispose()   sets entryEnabled=false, then stop(), monitor.stop(), timers
 *   orderManager       rejects QUEUED actions that never reached the broker, and
 *                      releases their reservations — it does not invent fills
 *   monitor.stop()     clears a timer
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * DESIGN NOTES
 * No `process.on` and no `process.exit` in here. Signals are wired at the call site and
 * the exit code is the caller's decision, which is what lets the ordering, idempotency
 * and error-isolation logic be unit-tested without spawning processes or killing the
 * test runner.
 */

/** One cleanup action. Named so the log says which step hung or threw. */
export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

export interface ShutdownResult {
  signal: string;
  /** Steps that finished without throwing, in execution order. */
  completed: string[];
  /** Steps that threw. Recorded, never fatal to the remaining steps. */
  failed: { step: string; error: string }[];
  /** True when the deadline expired before every step finished. */
  timedOut: boolean;
  durationMs: number;
}

export interface ShutdownOptions {
  steps: ShutdownStep[];
  /**
   * Hard ceiling on the whole sequence.
   *
   * Conservative on purpose: a redeploy that hangs forever is worse than one that gives
   * up and exits non-zero, because an orchestrator will SIGKILL it anyway and the
   * non-zero exit is at least visible.
   */
  timeoutMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export class ShutdownCoordinator {
  private readonly steps: ShutdownStep[];
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  /**
   * The in-flight run, if any.
   *
   * Holding the PROMISE rather than a boolean is what makes a second signal both
   * idempotent AND awaitable: two `SIGTERM`s produce one cleanup pass, and both callers
   * observe the same result instead of the second returning early with nothing.
   */
  private pending: Promise<ShutdownResult> | null = null;

  constructor(opts: ShutdownOptions) {
    this.steps = opts.steps;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? ((m) => console.log(m));
    this.now = opts.now ?? Date.now;
  }

  /** True once a shutdown has begun. Read by health/diagnostic surfaces. */
  get inProgress(): boolean {
    return this.pending !== null;
  }

  /**
   * Run every step once, in order.
   *
   * Repeated calls return the FIRST run's promise: a second `SIGTERM` must not start a
   * second pass, or `dispose()` would run twice and the second one could release a
   * refcount the first already released.
   */
  run(signal: string): Promise<ShutdownResult> {
    if (this.pending) {
      this.log(`[shutdown] ${signal} received while already shutting down — ignoring.`);
      return this.pending;
    }
    this.pending = this.execute(signal);
    return this.pending;
  }

  private async execute(signal: string): Promise<ShutdownResult> {
    const startedAt = this.now();
    const completed: string[] = [];
    const failed: { step: string; error: string }[] = [];
    this.log(`[shutdown] ${signal} received — starting graceful shutdown of ${this.steps.length} step(s).`);

    const sequence = (async (): Promise<"done"> => {
      for (const step of this.steps) {
        try {
          await step.run();
          completed.push(step.name);
          this.log(`[shutdown] ok: ${step.name}`);
        } catch (err) {
          // ISOLATED ON PURPOSE. A failure to stop the scanner must not prevent the
          // database connections from closing — the later steps are the ones that
          // protect data, so an early throw must never skip them.
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ step: step.name, error: message });
          this.log(`[shutdown] FAILED: ${step.name}: ${message} (continuing)`);
        }
      }
      return "done";
    })();

    // The deadline timer is deliberately NOT unref'd: an unref'd timer does not hold the
    // event loop open, so if a step hung with nothing else pending the timer would never
    // fire and the deadline would silently not exist. It is always cleared below.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });

    const outcome = await Promise.race([sequence, deadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);

    const timedOut = outcome === "timeout";
    if (timedOut) {
      const stuck = this.steps
        .map((s) => s.name)
        .filter((name) => !completed.includes(name) && !failed.some((f) => f.step === name));
      this.log(
        `[shutdown] TIMED OUT after ${this.timeoutMs}ms. Completed ${completed.length}/` +
          `${this.steps.length}. Not finished: ${stuck.join(", ") || "(none recorded)"}. ` +
          `Exiting non-zero. NO trading state has been altered or invented.`,
      );
    }

    const result: ShutdownResult = {
      signal,
      completed,
      failed,
      timedOut,
      durationMs: this.now() - startedAt,
    };
    if (!timedOut) {
      this.log(
        `[shutdown] complete in ${result.durationMs}ms — ${completed.length} ok, ` +
          `${failed.length} failed.`,
      );
    }
    return result;
  }
}

/**
 * Exit code for a finished shutdown.
 *
 * A timeout is non-zero so an orchestrator surfaces it. A step that THREW is not, on its
 * own, a failed shutdown: the sequence still reached the end, and reporting failure
 * would make every deploy look broken because, say, an already-closed socket complained.
 */
export function shutdownExitCode(result: ShutdownResult): number {
  return result.timedOut ? 1 : 0;
}
