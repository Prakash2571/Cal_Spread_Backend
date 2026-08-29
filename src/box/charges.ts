/**
 * Box charge estimation — a WRAPPER around the calendar engine's existing
 * Zerodha charge estimator, not a replacement for it.
 *
 * The estimator itself (`priceChargeGroups`, which posts to Kite's virtual
 * contract note API) is injected unchanged. This module only does the parts that
 * are specific to a box:
 *
 *   - builds the FOUR entry orders and the FOUR reversed exit orders
 *   - asks for both groups in ONE request (eight order lines)
 *   - caches the answer, because the scanner would otherwise hammer the API
 *   - dedupes concurrent requests for the same candidate at the same prices
 *
 * A box therefore costs one charge call, not eight, and repeated evaluation of a
 * stable book costs none.
 */

import type { BoxConfig } from "./config.js";
import { round2 } from "./math.js";
import { BOX_ENTRY_SIDES, BOX_LEG_ROLES, type BoxCandidate, type BoxLegEvaluation } from "./types.js";
import type { BoxChargeEstimate, BoxCharges } from "./types.js";

/** The leg shape the injected estimator expects (mirrors index.ts's ChargeLeg). */
export interface BoxChargeLeg {
  side: "BUY" | "SELL";
  token: number;
  expiry: string;
  tradingsymbol: string;
  exchange: string;
  quantity: number;
  price: number;
}

/** What the injected estimator returns per group. */
export interface PricedChargeGroup {
  charges: BoxCharges;
  logLegs: unknown[];
}

/** The injected calendar charge estimator. Returns null instead of throwing. */
export type PriceChargeGroupsFn = (
  groups: { legs: BoxChargeLeg[]; source: "kite" | "kite_estimate" }[],
) => Promise<PricedChargeGroup[] | null>;

/** The same legs with both sides reversed — i.e. the orders that close them. */
export function reverseBoxLegs(legs: BoxChargeLeg[]): BoxChargeLeg[] {
  return legs.map((l) => ({
    ...l,
    side: l.side === "BUY" ? ("SELL" as const) : ("BUY" as const),
  }));
}

/**
 * The four entry orders of a long box, priced at the touch each leg would fill
 * at. `evaluations` must be the entry-side evaluation (BUY→ask, SELL→bid).
 */
export function buildEntryChargeLegs(
  candidate: BoxCandidate,
  evaluations: BoxLegEvaluation[],
): BoxChargeLeg[] | null {
  const byRole = new Map(evaluations.map((e) => [e.role, e]));
  const legs: BoxChargeLeg[] = [];
  for (const role of BOX_LEG_ROLES) {
    const ev = byRole.get(role);
    const inst = candidate.legs[role];
    if (!ev || ev.price === null || !(ev.price > 0)) return null;
    legs.push({
      side: BOX_ENTRY_SIDES[role],
      token: inst.token,
      expiry: inst.expiry,
      tradingsymbol: inst.tradingsymbol,
      exchange: inst.exchange,
      quantity: candidate.lot_size,
      price: round2(ev.price),
    });
  }
  return legs;
}

/**
 * Build charge legs from an arbitrary set of evaluated legs (used for an exit,
 * where the sides are already reversed by the evaluation).
 */
export function buildChargeLegsFromEvaluations(
  candidateLegs: Record<string, { token: number; tradingsymbol: string; exchange: string; expiry: string }>,
  evaluations: BoxLegEvaluation[],
  quantity: number,
): BoxChargeLeg[] | null {
  const legs: BoxChargeLeg[] = [];
  for (const ev of evaluations) {
    const inst = candidateLegs[ev.role];
    if (!inst || ev.price === null || !(ev.price > 0)) return null;
    legs.push({
      side: ev.side,
      token: inst.token,
      expiry: inst.expiry,
      tradingsymbol: inst.tradingsymbol,
      exchange: inst.exchange,
      quantity,
      price: round2(ev.price),
    });
  }
  return legs;
}

/**
 * Cache key for a charge estimate.
 *
 * Prices are folded in (rounded to the rupee) because charges are a function of
 * turnover: a materially different fill must not reuse an old estimate. Rounding
 * to the rupee is what makes the cache actually hit while the book jitters in
 * paise, and any error it introduces is a few paise of brokerage on a decision
 * that carries a ₹150 safety buffer.
 */
export function chargeCacheKey(candidateKey: string, legs: BoxChargeLeg[]): string {
  const prices = legs.map((l) => `${l.side[0]}${Math.round(l.price)}`).join(",");
  return `${candidateKey}|${legs[0]?.quantity ?? 0}|${prices}`;
}

interface CacheEntry {
  at: number;
  value: BoxChargeEstimate | null;
}

/**
 * Charge estimator for boxes: four entry orders and four exit orders, cached.
 */
export class BoxChargeEstimator {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<BoxChargeEstimate | null>>();
  private active = 0;
  private stats = { calls: 0, hits: 0, misses: 0, failures: 0 };

  constructor(
    private priceChargeGroups: PriceChargeGroupsFn,
    private cfg: BoxConfig,
  ) {}

  /** Counters for the status endpoint. */
  getStats(): { calls: number; hits: number; misses: number; failures: number; inFlight: number } {
    return { ...this.stats, inFlight: this.inFlight.size };
  }

  /** True when another charge call may be started right now. */
  hasCapacity(): boolean {
    return this.active < this.cfg.chargeConcurrency;
  }

  /** A cached estimate for these exact legs, if one is still valid. */
  peek(candidateKey: string, legs: BoxChargeLeg[]): BoxChargeEstimate | null | undefined {
    const key = chargeCacheKey(candidateKey, legs);
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.cfg.chargeCacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /**
   * Estimate the entry + projected exit charges of a box.
   *
   * Returns null when Kite could not price the orders. A null is CACHED (briefly)
   * as well, so a persistent pricing failure cannot turn into a request storm —
   * the opportunity is shown as UNPRICED and simply never auto-traded.
   */
  async estimate(
    candidateKey: string,
    entryLegs: BoxChargeLeg[],
  ): Promise<BoxChargeEstimate | null> {
    const key = chargeCacheKey(candidateKey, entryLegs);

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at <= this.cfg.chargeCacheTtlMs) {
      this.stats.hits++;
      return cached.value;
    }

    // Collapse concurrent requests for the same legs onto one API call.
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    this.stats.misses++;
    const task = this.run(key, entryLegs);
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async run(
    key: string,
    entryLegs: BoxChargeLeg[],
  ): Promise<BoxChargeEstimate | null> {
    this.active++;
    this.stats.calls++;
    try {
      // ONE request carrying the four entry orders AND the four exit orders.
      // The exit group is priced at the entry fills, which is the conservative
      // projection: it assumes the unwind costs at least what putting it on did.
      const priced = await this.priceChargeGroups([
        { legs: entryLegs, source: "kite" },
        { legs: reverseBoxLegs(entryLegs), source: "kite_estimate" },
      ]);
      if (!priced || priced.length < 2) {
        this.stats.failures++;
        this.cache.set(key, { at: Date.now(), value: null });
        return null;
      }
      const entry = priced[0]!.charges;
      const exit = priced[1]!.charges;
      const value: BoxChargeEstimate = {
        entry,
        estimated_exit: exit,
        entry_total: round2(entry.total),
        estimated_exit_total: round2(exit.total),
        entry_legs: entry.legs,
        exit_legs: exit.legs,
      };
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      // The injected estimator already swallows Kite errors; this is belt and
      // braces so a charge failure can never abort a scan cycle.
      this.stats.failures++;
      console.warn("[Box] charge estimation failed:", err);
      this.cache.set(key, { at: Date.now(), value: null });
      return null;
    } finally {
      this.active--;
    }
  }

  /**
   * Price ONLY the exit of an existing position, at the touches it would close
   * at right now. Used by the monitor so the net P&L is always charged at the
   * current book rather than the entry-time projection.
   */
  async estimateExitOnly(
    cacheKey: string,
    exitLegs: BoxChargeLeg[],
  ): Promise<BoxCharges | null> {
    const key = `exit:${chargeCacheKey(cacheKey, exitLegs)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at <= this.cfg.chargeCacheTtlMs) {
      this.stats.hits++;
      return cached.value ? cached.value.entry : null;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      const v = await pending;
      return v ? v.entry : null;
    }

    this.stats.misses++;
    const task = (async (): Promise<BoxChargeEstimate | null> => {
      this.active++;
      this.stats.calls++;
      try {
        const priced = await this.priceChargeGroups([
          { legs: exitLegs, source: "kite_estimate" },
        ]);
        if (!priced || priced.length < 1) {
          this.stats.failures++;
          this.cache.set(key, { at: Date.now(), value: null });
          return null;
        }
        const charges = priced[0]!.charges;
        const value: BoxChargeEstimate = {
          entry: charges,
          estimated_exit: charges,
          entry_total: round2(charges.total),
          estimated_exit_total: round2(charges.total),
          entry_legs: charges.legs,
          exit_legs: charges.legs,
        };
        this.cache.set(key, { at: Date.now(), value });
        return value;
      } catch (err) {
        this.stats.failures++;
        console.warn("[Box] exit charge estimation failed:", err);
        this.cache.set(key, { at: Date.now(), value: null });
        return null;
      } finally {
        this.active--;
      }
    })();

    this.inFlight.set(key, task);
    try {
      const v = await task;
      return v ? v.entry : null;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Drop cache entries older than the TTL (called on the slow path). */
  prune(): void {
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (now - v.at > this.cfg.chargeCacheTtlMs) this.cache.delete(k);
    }
  }
}
