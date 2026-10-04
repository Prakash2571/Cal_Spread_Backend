import { yearFraction } from "./black.js";
import { discountAt } from "./curve.js";
import { resolveForward } from "./forward.js";
import { varianceAt } from "./smile.js";
import { validatePriceGrid } from "./validation.js";
import type { CalendarRegion, Diagnostic, ExpirySlice, FairValueConfig, ForwardResult, InputSnapshot } from "./types.js";

export function proportionalCalendarSupported(input: InputSnapshot): boolean {
  const carry = input.config.carry[input.underlying];
  if (carry && (carry.dividends.length > 0 || carry.corporate_actions.length > 0)) return false;
  return (carry?.verified === true && carry.proportional) || input.config.proportional_calendar_assumption;
}

export function commonSupport(a: ExpirySlice, b: ExpirySlice): [number, number] | null {
  if (!a.smile.valid || !b.smile.valid || !a.smile.support || !b.smile.support) return null;
  const low = Math.max(a.smile.support.min_k, b.smile.support.min_k);
  const high = Math.min(a.smile.support.max_k, b.smile.support.max_k);
  return high > low ? [low, high] : null;
}

export function totalVarianceBetween(a: ExpirySlice, b: ExpirySlice, t: number, k: number,
  config: FairValueConfig, research = false): number | null {
  if (a.t === null || b.t === null || !(a.t <= t && t <= b.t) || b.t <= a.t) return null;
  // Both expiry functions are evaluated at THE SAME forward log-moneyness.
  const wa = varianceAt(a.smile, k, config.smile, research);
  const wb = varianceAt(b.smile, k, config.smile, research);
  if (wa === null || wb === null || wb < wa - config.smile.calendar_tolerance) return null;
  const alpha = (t - a.t) / (b.t - a.t);
  return (1 - alpha) * wa + alpha * wb;
}

const emptyForward = (): ForwardResult => ({ available: false, value: null, source: "unavailable", pair_count: 0,
  dispersion: null, interval: null, pairs: [], excluded_pairs: [], assumptions: [], diagnostics: [] });

/** Explicit event-aware verified carry first; otherwise labelled log-carry assumption, never another expiry's future. */
export function hypotheticalForward(input: InputSnapshot, t: number, a: ExpirySlice, b: ExpirySlice | null,
  mode: "interpolation" | "short_research" | "long_research"): { value: number | null; assumptions: string[]; reason: string | null } {
  const carry = input.config.carry[input.underlying] ?? null;
  const valuation = Date.parse(input.valuation_time);
  const expiry = new Date(valuation + t * 365 * 86400000).toISOString();
  if (carry?.verified && input.spot) {
    const result = resolveForward({ options: emptyForward(), expiry, now: valuation,
      curve: input.config.curve, spot: input.spot, carry, futures: [], maxAgeMs: input.config.quote.max_age_ms });
    if (result.value !== null) return { value: result.value, assumptions: result.assumptions, reason: null };
    return { value: null, assumptions: [], reason: "Verified carry cannot value this maturity (curve/events/corporate actions)." };
  }
  if (input.config.forward_interpolation !== "log_carry_assumption" || !input.spot || input.spot.value <= 0 ||
      a.forward.value === null || a.t === null) return { value: null, assumptions: [], reason: "Hypothetical forward interpolation policy/spot support is unavailable." };
  const s = input.spot.value;
  const c1 = Math.log(a.forward.value / s);
  let c: number;
  let assumption: string;
  if (mode === "short_research") {
    c = c1 * t / a.t;
    assumption = "Research short-end log-carry interpolation anchored at current spot F(0)=S; event-insensitive assumption.";
  } else {
    if (!b || b.forward.value === null || b.t === null || b.t <= a.t) return { value: null, assumptions: [], reason: "Two positive forward-curve nodes are required." };
    const alpha = (t - a.t) / (b.t - a.t);
    c = (1 - alpha) * c1 + alpha * Math.log(b.forward.value / s);
    assumption = mode === "long_research" ? "Research linear extrapolation of log carry from the final two listed nodes; event-insensitive assumption."
      : "Hypothetical forward assumes linear interpolation of log carry ln(F(T)/S); not a universally correct forward model.";
  }
  const value = s * Math.exp(c);
  return Number.isFinite(value) && value > 0 ? { value, assumptions: [assumption], reason: null }
    : { value: null, assumptions: [], reason: "Hypothetical forward is nonpositive or nonfinite." };
}

/** Common k calendar checks and interpolated price validation. Crossing invalidates the whole common region conservatively. */
export function buildCalendarRegions(slices: ExpirySlice[], input: InputSnapshot): CalendarRegion[] {
  const ordered = slices.filter((s) => s.t !== null && s.t > 0 && s.smile.valid).sort((a, b) => a.t! - b.t!);
  const regions: CalendarRegion[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!, b = ordered[i + 1]!;
    const support = commonSupport(a, b);
    if (!support) continue;
    const diagnostics: Diagnostic[] = [];
    const [low, high] = support;
    if (!proportionalCalendarSupported(input)) diagnostics.push({ code: "calendar_carry_assumption_unsupported", severity: "error",
      message: "Same-k calendar validation needs a verified proportional/deterministic carry model or explicit proportional-carry assumption; discrete events are unsupported for maturity interpolation." });
    const ks = new Set([...a.smile.nodes.map((n) => n.k), ...b.smile.nodes.map((n) => n.k)].filter((k) => k >= low && k <= high));
    for (let j = 0; j <= input.config.smile.diagnostic_points; j++) ks.add(low + (high - low) * j / input.config.smile.diagnostic_points);
    let minimum = Infinity, minimumK = low;
    const delta = (k: number): number | null => {
      const wa = varianceAt(a.smile, k, input.config.smile), wb = varianceAt(b.smile, k, input.config.smile);
      if (wa === null || wb === null) return null;
      const difference = wb - wa;
      if (difference < minimum) { minimum = difference; minimumK = k; }
      return difference;
    };
    const sorted = [...ks].sort((x, y) => x - y);
    const refine = (x: number, y: number, depth: number) => {
      const dx = delta(x), dy = delta(y), middle = (x + y) / 2, dm = delta(middle);
      if (dx === null || dy === null || dm === null) return;
      if (depth < input.config.smile.adaptive_depth &&
          (depth === 0 || Math.min(dx, dy, dm) < 1e-5 || Math.abs(dm - (dx + dy) / 2) > 1e-5)) {
        refine(x, middle, depth + 1); refine(middle, y, depth + 1);
      }
    };
    for (let j = 0; j < sorted.length - 1; j++) refine(sorted[j]!, sorted[j + 1]!, 0);
    if (minimum < -input.config.smile.calendar_tolerance) diagnostics.push({ code: "calendar_variance_crossing", severity: "error",
      message: "Later expiry total variance is smaller at the same k; affected common maturity region is unavailable, with no silent clamping.", k: minimumK, value: minimum });
    if (diagnostics.length === 0) {
      for (const alpha of [.25, .5, .75]) {
        const t = (1 - alpha) * a.t! + alpha * b.t!;
        const forward = hypotheticalForward(input, t, a, b, "interpolation");
        const discount = discountAt(input.config.curve, t);
        if (forward.value === null || discount.d === null) {
          diagnostics.push({ code: "intermediate_curve_unavailable", severity: "error", message: forward.reason ?? discount.reason ?? "Interpolated curve inputs unavailable." });
          break;
        }
        const f = forward.value;
        const strikes = sorted.map((k) => f * Math.exp(k));
        const validation = validatePriceGrid({ f, d: discount.d, strikes,
          variance: (k) => totalVarianceBetween(a, b, t, k, input.config), tick: input.config.quote.tick_floor, config: input.config.smile });
        if (!validation.valid) diagnostics.push(...validation.diagnostics);
      }
    }
    regions.push({ first_expiry: a.expiry, second_expiry: b.expiry, min_k: low, max_k: high,
      valid: !diagnostics.some((d) => d.severity === "error"), diagnostics });
  }
  return regions;
}

export function requestedTime(input: InputSnapshot, expiry: string): number { return yearFraction(expiry, input.valuation_time); }
