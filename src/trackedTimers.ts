/**
 * A registry of long-lived intervals, so shutdown can stop them.
 *
 * WHY THIS EXISTS
 * A handful of module-level `setInterval` calls discarded their handles, so nothing could
 * stop them. That is harmless while the process runs — they are meant to run forever —
 * but it matters during shutdown: a Redis flush or an option-OI capture firing *after*
 * the Mongo connections have begun closing produces write-after-close errors, and in the
 * worst case a partially written capture.
 *
 * Deliberately minimal. This is NOT a scheduler abstraction and does not change any
 * timing, callback or interval: `trackInterval` records a handle that was already
 * created and returns it unchanged. Components that already manage their own timers
 * (`BoxEngine`, `PositionMonitor`, `OrderManager`, `DhanFeed`, `TickerHub`, the metrics
 * sampler and the P&L archiver) keep doing so and are untouched — they are stopped
 * through their own `stop()`/`dispose()` hooks.
 */

type IntervalHandle = ReturnType<typeof setInterval>;

const tracked: { name: string; handle: IntervalHandle }[] = [];

/**
 * Record an interval so it can be cleared at shutdown. Returns the handle unchanged, so
 * it can wrap an existing `setInterval(...)` call without altering behaviour.
 */
export function trackInterval(name: string, handle: IntervalHandle): IntervalHandle {
  tracked.push({ name, handle });
  return handle;
}

/** Clear every tracked interval. Idempotent: the registry is emptied as it goes. */
export function clearTrackedIntervals(): string[] {
  const cleared: string[] = [];
  for (const { name, handle } of tracked.splice(0)) {
    clearInterval(handle);
    cleared.push(name);
  }
  return cleared;
}

/** How many intervals are currently tracked. For diagnostics and tests. */
export function trackedIntervalCount(): number {
  return tracked.length;
}
