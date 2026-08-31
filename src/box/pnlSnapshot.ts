/**
 * Pure shaping for the daily box-P&L snapshot.
 *
 * Kept dependency-free (types only, no Redis, no Mongo, no clock) so the exact
 * arithmetic of "how is today going" — the running net P&L of open positions
 * plus the realised net P&L of trades closed today — is a deterministic function
 * that can be unit-tested on its own. The cache (pnlCache.ts) and the archiver
 * (pnlArchive.ts) do the I/O; this only decides what the numbers are.
 *
 * DELIBERATELY NOT a valuation model. Every figure here is a passthrough of what
 * the engine already computed for a trade: an open position's running net P&L is
 * the monitor's current touch-based net, and a closed trade's realised net P&L is
 * the net it actually closed at. Nothing is invented, discounted or theoretical.
 */

/** The Redis hash field that holds the day's aggregate summary. */
export const SUMMARY_FIELD = "__summary__";

/** One open position's live P&L, as the engine publishes it. */
export interface OpenPnlInput {
  id: string;
  underlying: string;
  direction: string;
  lower_strike: number;
  upper_strike: number;
  expiry: string;
  opened_at: string;
  /** Gross P&L if closed at the current touch (₹). */
  gross_pnl: number | null;
  /** Running NET P&L at the current touch (₹). */
  net_pnl: number | null;
  /** Running net minus the expected exit-slippage allowance (₹). */
  realisable_net_pnl: number | null;
}

/** One trade closed today, as stored on the box document. */
export interface ClosedPnlInput {
  id: string;
  underlying: string;
  direction: string;
  lower_strike: number;
  upper_strike: number;
  expiry: string;
  opened_at: string;
  closed_at: string | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  /** The net the trade actually realised at the executed exit (₹). */
  realised_net_pnl: number | null;
}

/** One per-trade row of the day's P&L, cached in Redis and archived to Mongo. */
export interface BoxDailyPnlRow {
  day: string;
  trade_id: string;
  underlying: string;
  direction: string;
  lower_strike: number;
  upper_strike: number;
  expiry: string;
  status: "open" | "closed";
  gross_pnl: number | null;
  /** Running net for an open trade; realised net for a closed one (₹). */
  net_pnl: number | null;
  /** Open trades only: running net minus the exit-slippage allowance. */
  realisable_net_pnl: number | null;
  /** Closed trades only: the net actually realised at exit. */
  realised_net_pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
}

/** The day's aggregate: open running P&L + closed realised P&L. */
export interface BoxDailyPnlSummary {
  day: string;
  open_count: number;
  closed_count: number;
  /** Sum of the running net P&L across open positions (₹). */
  open_running_net_pnl: number;
  open_running_gross_pnl: number;
  /** Sum of the realised net P&L across trades closed today (₹). */
  closed_realised_net_pnl: number;
  closed_realised_gross_pnl: number;
  /** open_running_net_pnl + closed_realised_net_pnl — the day's running total. */
  total_net_pnl: number;
  total_gross_pnl: number;
  updated_at: string;
}

export interface DaySnapshot {
  rows: BoxDailyPnlRow[];
  summary: BoxDailyPnlSummary;
}

/** Treat a null P&L as zero for aggregation (a trade with no computable P&L). */
function n(v: number | null): number {
  return v === null || !Number.isFinite(v) ? 0 : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Build the day's P&L snapshot: one row per trade (open + closed-today) plus the
 * aggregate summary. `nowIso` is injected so the result is deterministic.
 */
export function buildDaySnapshot(args: {
  day: string;
  open: OpenPnlInput[];
  closed: ClosedPnlInput[];
  nowIso: string;
}): DaySnapshot {
  const { day, open, closed, nowIso } = args;

  const rows: BoxDailyPnlRow[] = [];

  let openNet = 0;
  let openGross = 0;
  for (const p of open) {
    openNet += n(p.net_pnl);
    openGross += n(p.gross_pnl);
    rows.push({
      day,
      trade_id: p.id,
      underlying: p.underlying,
      direction: p.direction,
      lower_strike: p.lower_strike,
      upper_strike: p.upper_strike,
      expiry: p.expiry,
      status: "open",
      gross_pnl: p.gross_pnl,
      net_pnl: p.net_pnl,
      realisable_net_pnl: p.realisable_net_pnl,
      realised_net_pnl: null,
      opened_at: p.opened_at,
      closed_at: null,
      updated_at: nowIso,
    });
  }

  let closedNet = 0;
  let closedGross = 0;
  for (const t of closed) {
    // A closed trade's authoritative net is its realised net; fall back to net_pnl
    // for documents written before realised_net_pnl existed.
    const realised = t.realised_net_pnl ?? t.net_pnl;
    closedNet += n(realised);
    closedGross += n(t.gross_pnl);
    rows.push({
      day,
      trade_id: t.id,
      underlying: t.underlying,
      direction: t.direction,
      lower_strike: t.lower_strike,
      upper_strike: t.upper_strike,
      expiry: t.expiry,
      status: "closed",
      gross_pnl: t.gross_pnl,
      net_pnl: realised,
      realisable_net_pnl: null,
      realised_net_pnl: t.realised_net_pnl ?? t.net_pnl,
      opened_at: t.opened_at,
      closed_at: t.closed_at,
      updated_at: nowIso,
    });
  }

  const summary: BoxDailyPnlSummary = {
    day,
    open_count: open.length,
    closed_count: closed.length,
    open_running_net_pnl: round2(openNet),
    open_running_gross_pnl: round2(openGross),
    closed_realised_net_pnl: round2(closedNet),
    closed_realised_gross_pnl: round2(closedGross),
    total_net_pnl: round2(openNet + closedNet),
    total_gross_pnl: round2(openGross + closedGross),
    updated_at: nowIso,
  };

  return { rows, summary };
}

/**
 * Which cached rows are not yet in Mongo — the set the verify pass must still
 * drain. Pure set difference on trade ids so it is trivially testable.
 */
export function missingRowIds(cachedIds: string[], persistedIds: string[]): string[] {
  const have = new Set(persistedIds);
  return cachedIds.filter((id) => !have.has(id));
}
