import type { DiscountCurveSpec, DiscountResult } from "./types.js";
import { utcTimestamp } from "./metadata.js";

export function validateCurve(spec: DiscountCurveSpec): void {
  if (spec.convention !== "continuous_zero_act365f" || !spec.source?.trim() || !spec.version?.trim() ||
      !utcTimestamp(spec.as_of)) throw new Error("Curve requires source, UTC timestamp, convention and version.");
  if (spec.nodes.length > 100) throw new Error("Discount curve exceeds 100 nodes.");
  let previous = -1;
  for (const node of spec.nodes) {
    if (!Number.isFinite(node.t) || node.t < 0 || node.t <= previous || !Number.isFinite(node.zero_rate) ||
        !Number.isFinite(Math.exp(-node.zero_rate * node.t)) || Math.exp(-node.zero_rate * node.t) <= 0) {
      throw new Error("Curve nodes require increasing nonnegative T, finite continuous zero rates and positive finite D.");
    }
    previous = node.t;
  }
  if (spec.flat_rate !== null && !Number.isFinite(spec.flat_rate)) throw new Error("Flat rate must be a finite decimal.");
}

export function discountAt(spec: DiscountCurveSpec, t: number): DiscountResult {
  validateCurve(spec);
  if (!Number.isFinite(t) || t < 0) throw new Error("Discount time must be finite and nonnegative.");
  const provenance = { source: spec.source, as_of: spec.as_of, version: spec.version, convention: spec.convention };
  const unavailable = (reason: string): DiscountResult => ({ available: false, d: null, zero_rate: null,
    method: "unavailable", assumption: null, reason, provenance });
  if (t === 0) return { available: true, d: 1, zero_rate: 0, method: "curve_node", assumption: null, reason: null, provenance };
  const nodes = spec.nodes[0]?.t === 0 ? spec.nodes : [{ t: 0, zero_rate: 0 }, ...spec.nodes];
  const exact = nodes.find((n) => n.t === t);
  let logD: number;
  let method: DiscountResult["method"];
  let assumption: string | null = null;
  if (exact) {
    logD = -exact.zero_rate * t;
    method = "curve_node";
  } else {
    const upperIndex = nodes.findIndex((n) => n.t > t);
    if (upperIndex > 0) {
      const a = nodes[upperIndex - 1]!;
      const b = nodes[upperIndex]!;
      const alpha = (t - a.t) / (b.t - a.t);
      logD = (1 - alpha) * (-a.zero_rate * a.t) + alpha * (-b.zero_rate * b.t);
      method = "log_discount_interpolation";
    } else if (spec.allow_flat_fallback && spec.flat_rate !== null) {
      logD = -spec.flat_rate * t;
      method = "flat_rate_assumption";
      assumption = "Configured flat continuously compounded rate; not an observed term structure.";
    } else return unavailable("No discount curve coverage and flat-rate fallback is not configured.");
  }
  const d = Math.exp(logD);
  if (!Number.isFinite(d) || d <= 0) return unavailable("Discount factor is nonpositive or outside numeric range.");
  // Negative zero rates legitimately give D>1; there is no universal upper-bound check.
  return { available: true, d, zero_rate: -logD / t, method, assumption, reason: null, provenance };
}
