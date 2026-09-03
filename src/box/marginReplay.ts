/**
 * Peak concurrent margin, computed by replaying trade intervals.
 *
 * Pure: no Mongo, no clock, no network — like math.ts and pnlSnapshot.ts — so the
 * one calculation that is easy to get subtly wrong can be unit-tested exhaustively
 * offline.
 *
 * WHY A REPLAY AND NOT A RUNNING MAXIMUM
 * The live engine keeps a sampled high-water mark: it notices the open-margin sum
 * whenever a status read happens to occur. That is honest but lossy, and it is
 * MONOTONE — it never comes back down. So when a trade is deleted, the recorded
 * peak may be a figure that only that trade ever produced, and no amount of
 * arithmetic on the remaining trades can recover the truth from it.
 *
 * `peak -= deleted.margin` is the tempting fix and it is simply wrong: a maximum is
 * not a sum, and subtracting from it does not yield the maximum of the remaining
 * set. Two trades of ₹5L that never overlapped give a peak of ₹5L, not ₹10L, so
 * deleting one must leave the peak at ₹5L — subtraction would report ₹0.
 *
 * WHY SWEEPING THE START POINTS IS EXACT
 * Margin is blocked over the half-open interval [opened_at, closed_at). The total
 * concurrent margin is a step function that can only ever INCREASE at an interval
 * start — closing a trade releases margin, it never adds any. So the maximum is
 * always attained at some start point, and evaluating the sum at every start point
 * finds the true maximum exactly rather than approximating it.
 */

/** One trade's margin-holding interval. */
export interface MarginInterval {
  /** Epoch ms the margin began to be blocked. */
  from: number;
  /**
   * Epoch ms the margin was released — exclusive.
   *
   * For a still-open trade the caller passes "now". Half-open is deliberate: a
   * trade closing at exactly the instant another opens did NOT hold margin
   * simultaneously, and counting both would invent a peak that never occurred.
   */
  to: number;
  /** Margin blocked over that interval (₹). Must be > 0 to count. */
  margin: number;
}

/**
 * Keep only intervals that can contribute to a peak.
 *
 * Rejects a null/NaN/non-positive margin and any zero-or-negative-length interval.
 * A trade whose margin is UNKNOWN must be excluded rather than counted as zero:
 * treating an unmeasured value as ₹0 would silently understate the peak and present
 * a guess as a measurement. Callers report the unknown count separately.
 */
export function usableMarginIntervals(
  rows: { from: number; to: number; margin: number | null | undefined }[],
): MarginInterval[] {
  const out: MarginInterval[] = [];
  for (const row of rows) {
    const { from, to, margin } = row;
    if (margin === null || margin === undefined) continue;
    if (!Number.isFinite(margin) || margin <= 0) continue;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (to <= from) continue;
    out.push({ from, to, margin });
  }
  return out;
}

/**
 * The largest total margin blocked at any single instant.
 *
 * Returns null when no interval qualifies — meaning "never measured", which is
 * different from ₹0 and must stay distinguishable for the dashboard.
 */
export function peakConcurrentMargin(intervals: MarginInterval[]): number | null {
  if (intervals.length === 0) return null;
  let peak = 0;
  for (const probe of intervals) {
    let concurrent = 0;
    for (const other of intervals) {
      // Half-open containment: does `other` hold margin at the instant `probe` opens?
      if (other.from <= probe.from && probe.from < other.to) concurrent += other.margin;
    }
    if (concurrent > peak) peak = concurrent;
  }
  return peak > 0 ? peak : null;
}
