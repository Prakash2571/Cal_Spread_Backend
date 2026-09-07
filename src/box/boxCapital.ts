/**
 * MAXIMUM ₹ EXPOSURE PER BOX — the admission metric and its gate.
 *
 * WHAT THIS NUMBER IS
 *
 * `gross_entry_order_notional_rupees` = SUM over the four ENTRY legs of
 *
 *     |limit_price x quantity|
 *
 * computed from the ACTUAL bounded LIMIT order requests that would be transmitted. It is
 * the largest rupee amount those four immutable orders can transact, because a LIMIT order
 * can never fill worse than its limit and the Box never uses MARKET orders.
 *
 * WHAT THIS NUMBER IS **NOT**
 *
 * It is NOT broker margin. It is NOT SPAN+exposure. It is NOT the capital the broker will
 * actually block. A four-leg Box is a hedged structure and its real margin requirement is
 * typically a small fraction of gross option notional — sometimes it is a NET CREDIT. The
 * naming is deliberate and the code must never be edited to call this "margin", because an
 * operator who reads "margin: ₹120,000" and sets a ₹120,000 cap would be setting a limit
 * roughly an order of magnitude away from what they intended.
 *
 * If a reliable broker margin API is available its answer is exposed SEPATATELY as
 * `broker_estimated_margin_rupees` (see {@link BoxCapitalReport}) and is never substituted
 * for the admission metric: one is an observable property of our own bounded orders, the
 * other is a remote estimate that can fail, lag, or be denied.
 *
 * WHY GROSS NOTIONAL IS STILL THE RIGHT ADMISSION GATE
 *
 * It is deterministic, computable offline from data we already hold, monotone in quantity
 * and price, and CONSERVATIVE (it always over-states the economic risk of a hedged Box).
 * An operator using it is expressing "do not let one Box transact more than ₹X of option
 * premium", which is a meaningful, auditable sentence. It requires no broker round trip, so
 * it can be evaluated at the last safe moment before submission — which a remote margin
 * call cannot.
 *
 * PRECISION
 *
 * All comparisons are done in INTEGER PAISE. Rupee floats cannot represent ₹0.01 exactly,
 * and the specification requires that ₹0.01 over the cap is refused while exactly at the
 * cap is admitted. Comparing paise integers makes that boundary exact rather than
 * dependent on IEEE-754 rounding.
 */

import type { BoxLegRole, OrderSide } from "./types.js";

/** ₹ -> integer paise, half-up. Total: non-finite input yields 0. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * 100);
}

/** Integer paise -> ₹, to 2dp. */
export function fromPaise(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise) / 100;
}

/** The minimal shape of an order request this module needs. */
export interface BoxCapitalOrderLike {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  readonly quantity: number;
  readonly pricing: { readonly limit_price: number };
}

/** One leg's contribution to the gross entry notional. */
export interface BoxCapitalLegBreakdown {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  readonly quantity: number;
  /** The bounded LIMIT price used — never an LTP, never a mid. */
  readonly limit_price: number;
  readonly notional_rupees: number;
}

/**
 * The computed metric, plus whether it is TRUSTWORTHY.
 *
 * `complete` is the safety-critical field. A metric computed from three priced legs and one
 * unpriced leg understates the true total, and admitting on an understated total is exactly
 * how a cap gets bypassed. Callers must treat `complete === false` as "cannot prove
 * compliance" and refuse when a cap is configured.
 */
export interface BoxCapitalMetrics {
  readonly gross_entry_order_notional_rupees: number;
  readonly gross_entry_order_notional_paise: number;
  readonly legs: readonly BoxCapitalLegBreakdown[];
  readonly leg_count: number;
  /** True only when every leg carried a finite, positive quantity and limit price. */
  readonly complete: boolean;
  /** Human-readable reason `complete` is false, else null. */
  readonly incomplete_reason: string | null;
}

/**
 * Compute the gross entry-order notional from the bounded LIMIT requests.
 *
 * `expectedLegCount` defaults to 4 (a Box). Passing the count explicitly lets the caller
 * assert "I built four requests" so a silently-dropped leg is caught here rather than
 * becoming an under-stated total.
 */
export function grossEntryOrderNotional(
  requests: readonly BoxCapitalOrderLike[],
  expectedLegCount = 4,
): BoxCapitalMetrics {
  const legs: BoxCapitalLegBreakdown[] = [];
  const problems: string[] = [];
  let totalPaise = 0;

  for (const request of requests) {
    const quantity = request.quantity;
    const limit = request.pricing?.limit_price;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      problems.push(`${request.role} has a non-positive or non-integer quantity (${String(quantity)})`);
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      problems.push(`${request.role} has no usable bounded LIMIT price (${String(limit)})`);
      continue;
    }
    // Absolute value: a Box mixes BUY and SELL legs, and the metric is GROSS transacted
    // value, not a net debit. Netting BUY against SELL would let an arbitrarily large Box
    // through by pairing offsetting legs — the exact opposite of a conservative cap.
    const legPaise = Math.abs(toPaise(limit) * quantity);
    totalPaise += legPaise;
    legs.push({
      role: request.role,
      side: request.side,
      tradingsymbol: request.tradingsymbol,
      quantity,
      limit_price: limit,
      notional_rupees: fromPaise(legPaise),
    });
  }

  if (legs.length !== expectedLegCount) {
    problems.push(`expected ${expectedLegCount} priced legs, computed ${legs.length}`);
  }

  return {
    gross_entry_order_notional_rupees: fromPaise(totalPaise),
    gross_entry_order_notional_paise: totalPaise,
    legs,
    leg_count: legs.length,
    complete: problems.length === 0,
    incomplete_reason: problems.length === 0 ? null : problems.join("; "),
  };
}

/** Where in the pipeline a capital check ran. Recorded so a refusal is attributable. */
export type BoxCapitalCheckStage =
  /** During candidate qualification, for visibility. Advisory only. */
  | "qualification"
  /** From the immutable bounded order requests, immediately before durable submission. */
  | "pre_submit"
  /** Re-checked at dequeue, because requests may have been rebuilt or prices re-read. */
  | "dequeue";

/** The refusal reason string persisted and reported for a capital-cap block. */
export const BOX_CAPITAL_LIMIT_REASON = "box_capital_limit" as const;

export interface BoxCapitalReport {
  readonly stage: BoxCapitalCheckStage;
  /** Whether a cap is configured at all. `false` ⇒ this gate is disabled. */
  readonly enabled: boolean;
  readonly allowed: boolean;
  /** `box_capital_limit` when refused, else null. */
  readonly reason: typeof BOX_CAPITAL_LIMIT_REASON | null;
  readonly detail: string | null;
  readonly calculated_rupees: number;
  readonly configured_max_rupees: number;
  readonly broker: string;
  /** The Box candidate key. Internal identifier; not a secret, but not surfaced to end users. */
  readonly candidate_key: string;
  readonly at: number;
  readonly metrics: BoxCapitalMetrics;
  /**
   * A broker's own margin estimate, when one was obtained. NEVER used for admission and
   * NEVER substituted for `calculated_rupees`. Null when unavailable, which is the common
   * case and must not be mistaken for zero.
   */
  readonly broker_estimated_margin_rupees: number | null;
}

/**
 * Evaluate the configured ₹ cap against a computed metric.
 *
 * SEMANTICS, pinned by tests:
 *   - `limitRupees <= 0` ⇒ the gate is DISABLED and everything is admitted. This is the
 *     default, so an existing deployment upgrading to this build changes behaviour in no
 *     way whatsoever.
 *   - amount strictly below the cap ⇒ admitted.
 *   - amount EXACTLY at the cap ⇒ admitted (the cap is a maximum, inclusive).
 *   - amount ₹0.01 over the cap ⇒ refused.
 *   - metric NOT `complete` while a cap is configured ⇒ REFUSED. We cannot prove
 *     compliance from an under-stated total, and an unprovable safety gate is not a
 *     safety gate.
 *
 * This function is pure and performs no submission. Refusing here is a PRE-TRADE refusal:
 * the caller must invoke it before any broker mutation.
 */
export function evaluateBoxCapitalAdmission(args: {
  readonly metrics: BoxCapitalMetrics;
  readonly limitRupees: number;
  readonly broker: string;
  readonly candidateKey: string;
  readonly at: number;
  readonly stage: BoxCapitalCheckStage;
  readonly brokerEstimatedMarginRupees?: number | null;
}): BoxCapitalReport {
  const limit = Number.isFinite(args.limitRupees) ? args.limitRupees : 0;
  const base = {
    stage: args.stage,
    calculated_rupees: args.metrics.gross_entry_order_notional_rupees,
    configured_max_rupees: limit > 0 ? limit : 0,
    broker: args.broker,
    candidate_key: args.candidateKey,
    at: args.at,
    metrics: args.metrics,
    broker_estimated_margin_rupees: args.brokerEstimatedMarginRupees ?? null,
  } as const;

  if (limit <= 0) {
    // Disabled. Deliberately does NOT inspect `complete`: with no cap configured there is
    // nothing to prove, and refusing an entry because a metric we are not using is
    // incomplete would be a behaviour regression for every existing deployment.
    return { ...base, enabled: false, allowed: true, reason: null, detail: null };
  }

  if (!args.metrics.complete) {
    return {
      ...base,
      enabled: true,
      allowed: false,
      reason: BOX_CAPITAL_LIMIT_REASON,
      detail:
        `cannot verify the ₹${limit} per-Box cap: ${args.metrics.incomplete_reason ?? "metric incomplete"}. ` +
        "Refusing rather than admitting on an under-stated total.",
    };
  }

  const limitPaise = toPaise(limit);
  if (args.metrics.gross_entry_order_notional_paise > limitPaise) {
    return {
      ...base,
      enabled: true,
      allowed: false,
      reason: BOX_CAPITAL_LIMIT_REASON,
      detail:
        `gross_entry_order_notional_rupees ₹${args.metrics.gross_entry_order_notional_rupees} exceeds the ` +
        `configured BOX_LIVE_MAX_BOX_CAPITAL_RUPEES ₹${limit} (checked at ${args.stage}). ` +
        "This is gross option-order notional from the bounded LIMIT requests, NOT broker margin.",
    };
  }

  return { ...base, enabled: true, allowed: true, reason: null, detail: null };
}

/**
 * A compact, low-cardinality projection for status/diagnostics.
 *
 * Deliberately omits the per-leg breakdown and the candidate key: a status endpoint polled
 * every second must not grow unbounded, and per-leg tradingsymbols are high-cardinality
 * labels of the kind the metrics contract already forbids.
 */
export function boxCapitalSummary(report: BoxCapitalReport | null): {
  enabled: boolean;
  configured_max_rupees: number;
  last_calculated_rupees: number | null;
  last_stage: BoxCapitalCheckStage | null;
  last_allowed: boolean | null;
  last_at: number | null;
} {
  if (!report) {
    return {
      enabled: false,
      configured_max_rupees: 0,
      last_calculated_rupees: null,
      last_stage: null,
      last_allowed: null,
      last_at: null,
    };
  }
  return {
    enabled: report.enabled,
    configured_max_rupees: report.configured_max_rupees,
    last_calculated_rupees: report.calculated_rupees,
    last_stage: report.stage,
    last_allowed: report.allowed,
    last_at: report.at,
  };
}
