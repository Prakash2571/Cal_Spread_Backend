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

import { createHash } from "node:crypto";

/** The Redis hash field that holds the day's aggregate summary. */
export const SUMMARY_FIELD = "__summary__";

/** Versioned, fixed-size proof for one exact durable day representation. */
export interface BoxPnlDayProof {
  snapshot_version: 2;
  row_count: number;
  content_sha256: string;
}

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

/** Minimal archive shape accepted by the content-proof helpers. */
export interface BoxPnlProofDocument extends Partial<Omit<BoxDailyPnlRow, "status">> {
  day: string;
  trade_id: string;
  status?: "open" | "closed" | "summary";
  summary?: BoxDailyPnlSummary | null;
}

export function canonicalBoxPnlSummary(summary: BoxDailyPnlSummary) {
  return {
    day: summary.day,
    open_count: summary.open_count,
    closed_count: summary.closed_count,
    open_running_net_pnl: summary.open_running_net_pnl,
    open_running_gross_pnl: summary.open_running_gross_pnl,
    closed_realised_net_pnl: summary.closed_realised_net_pnl,
    closed_realised_gross_pnl: summary.closed_realised_gross_pnl,
    total_net_pnl: summary.total_net_pnl,
    total_gross_pnl: summary.total_gross_pnl,
  };
}

export function canonicalBoxPnlRow(row: BoxPnlProofDocument) {
  return {
    trade_id: row.trade_id,
    underlying: row.underlying ?? "",
    direction: row.direction ?? "LONG_BOX",
    lower_strike: row.lower_strike ?? 0,
    upper_strike: row.upper_strike ?? 0,
    expiry: row.expiry ?? "",
    status: row.status ?? "open",
    gross_pnl: row.gross_pnl ?? null,
    net_pnl: row.net_pnl ?? null,
    realisable_net_pnl: row.realisable_net_pnl ?? null,
    realised_net_pnl: row.realised_net_pnl ?? null,
    opened_at: row.opened_at ?? null,
    closed_at: row.closed_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** Fixed-memory builder; callers must add rows in canonical trade-id order. */
export class BoxPnlDayProofBuilder {
  private readonly hash = createHash("sha256");
  private rowCount = 0;
  private openNet = 0;
  private openGross = 0;
  private closedNet = 0;
  private closedGross = 0;
  private openCount = 0;
  private closedCount = 0;

  constructor(private readonly day: string) {}

  add(row: BoxPnlProofDocument): void {
    const canonical = canonicalBoxPnlRow(row);
    this.hash.update(JSON.stringify(canonical)).update("\n");
    this.rowCount++;
    if (canonical.status === "open") {
      this.openCount++;
      this.openNet += n(canonical.net_pnl);
      this.openGross += n(canonical.gross_pnl);
    } else {
      this.closedCount++;
      this.closedNet += n(canonical.realised_net_pnl ?? canonical.net_pnl);
      this.closedGross += n(canonical.gross_pnl);
    }
  }

  finish(nowIso = ""): { proof: BoxPnlDayProof; summary: BoxDailyPnlSummary } {
    const summary: BoxDailyPnlSummary = {
      day: this.day,
      open_count: this.openCount,
      closed_count: this.closedCount,
      open_running_net_pnl: round2(this.openNet),
      open_running_gross_pnl: round2(this.openGross),
      closed_realised_net_pnl: round2(this.closedNet),
      closed_realised_gross_pnl: round2(this.closedGross),
      total_net_pnl: round2(this.openNet + this.closedNet),
      total_gross_pnl: round2(this.openGross + this.closedGross),
      updated_at: nowIso,
    };
    this.hash.update(JSON.stringify(canonicalBoxPnlSummary(summary)));
    return {
      summary,
      proof: {
        snapshot_version: 2,
        row_count: this.rowCount,
        content_sha256: this.hash.digest("hex"),
      },
    };
  }
}

/** Stable exact-content proof over canonical sorted rows and regenerated summary. */
export function buildBoxPnlDayProof(docs: readonly BoxPnlProofDocument[]): BoxPnlDayProof {
  const rows = docs
    .filter((doc) => doc.trade_id !== SUMMARY_FIELD &&
      (doc.status === "open" || doc.status === "closed"))
    .sort((a, b) => a.trade_id.localeCompare(b.trade_id));
  const builder = new BoxPnlDayProofBuilder(docs[0]?.day ?? "");
  for (const row of rows) builder.add(row);
  return builder.finish().proof;
}

export function boxPnlSummariesEqual(
  a: BoxDailyPnlSummary,
  b: BoxDailyPnlSummary,
): boolean {
  return JSON.stringify(canonicalBoxPnlSummary(a)) ===
    JSON.stringify(canonicalBoxPnlSummary(b));
}

/** Stored summary content must agree with the same rows covered by the proof. */
export function boxPnlSummaryMatchesRows(docs: readonly BoxPnlProofDocument[]): boolean {
  const stored = docs.find((doc) => doc.trade_id === SUMMARY_FIELD)?.summary;
  if (!stored) return false;
  const rows = docs.filter((doc): doc is BoxPnlProofDocument & { status: "open" | "closed" } =>
    doc.trade_id !== SUMMARY_FIELD && (doc.status === "open" || doc.status === "closed"));
  const regenerated = summarizeDayRows({
    day: stored.day,
    rows: rows as Pick<BoxDailyPnlRow, "status" | "gross_pnl" | "net_pnl" | "realised_net_pnl">[],
    nowIso: "",
  });
  return boxPnlSummariesEqual(stored, regenerated);
}

export function boxPnlDayProofsEqual(a: BoxPnlDayProof, b: BoxPnlDayProof): boolean {
  return a.snapshot_version === b.snapshot_version &&
    a.row_count === b.row_count && a.content_sha256 === b.content_sha256;
}

/** Treat a null P&L as zero for aggregation (a trade with no computable P&L). */
function n(v: number | null): number {
  return v === null || !Number.isFinite(v) ? 0 : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Rebuild a day's aggregate exclusively from its surviving per-trade rows.
 *
 * Cache rows can outlive a deleted source trade, and the cached summary includes
 * that row too. Archive validation therefore discards the cached summary and
 * calls this after filtering rows against the durable trade collection.
 */
export function summarizeDayRows(args: {
  day: string;
  rows: readonly Pick<
    BoxDailyPnlRow,
    "status" | "gross_pnl" | "net_pnl" | "realised_net_pnl"
  >[];
  nowIso: string;
}): BoxDailyPnlSummary {
  const { day, rows, nowIso } = args;
  let openNet = 0;
  let openGross = 0;
  let closedNet = 0;
  let closedGross = 0;
  let openCount = 0;
  let closedCount = 0;

  for (const row of rows) {
    if (row.status === "open") {
      openCount++;
      openNet += n(row.net_pnl);
      openGross += n(row.gross_pnl);
    } else {
      closedCount++;
      closedNet += n(row.realised_net_pnl ?? row.net_pnl);
      closedGross += n(row.gross_pnl);
    }
  }

  return {
    day,
    open_count: openCount,
    closed_count: closedCount,
    open_running_net_pnl: round2(openNet),
    open_running_gross_pnl: round2(openGross),
    closed_realised_net_pnl: round2(closedNet),
    closed_realised_gross_pnl: round2(closedGross),
    total_net_pnl: round2(openNet + closedNet),
    total_gross_pnl: round2(openGross + closedGross),
    updated_at: nowIso,
  };
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

  for (const p of open) {
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

  for (const t of closed) {
    // A closed trade's authoritative net is its realised net; fall back to net_pnl
    // for documents written before realised_net_pnl existed.
    const realised = t.realised_net_pnl ?? t.net_pnl;
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
      realised_net_pnl: realised,
      opened_at: t.opened_at,
      closed_at: t.closed_at,
      updated_at: nowIso,
    });
  }

  return { rows, summary: summarizeDayRows({ day, rows, nowIso }) };
}

/**
 * Which cached rows are not yet in Mongo — the set the verify pass must still
 * drain. Pure set difference on trade ids so it is trivially testable.
 */
export function missingRowIds(cachedIds: string[], persistedIds: string[]): string[] {
  const have = new Set(persistedIds);
  return cachedIds.filter((id) => !have.has(id));
}
