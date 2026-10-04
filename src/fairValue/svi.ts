import type { Diagnostic, SmileConfig, SviParameters } from "./types.js";

export function sviVariance(p: SviParameters, k: number): number {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.hypot(x, p.eta));
}

export function sviDerivatives(p: SviParameters, k: number): { w: number; first: number; second: number; g: number | null } {
  const x = k - p.m;
  const root = Math.hypot(x, p.eta);
  const w = sviVariance(p, k);
  const first = p.b * (p.rho + x / root);
  const second = p.b * p.eta * p.eta / root ** 3;
  const g = w > 0 ? (1 - k * first / (2 * w)) ** 2 - first * first / 4 * (1 / w + 1 / 4) + second / 2 : null;
  return { w, first, second, g };
}

export function basicSviConstraints(p: SviParameters): boolean {
  return Object.values(p).every(Number.isFinite) && p.b >= 0 && Math.abs(p.rho) < 1 && p.eta > 0 &&
    p.a + p.b * p.eta * Math.sqrt(1 - p.rho ** 2) >= 0;
}

/** Adaptive finite-domain diagnostic, plus analytic wing/tail restrictions. Never a global density proof. */
export function diagnoseSvi(p: SviParameters, observedK: number[], config: SmileConfig): {
  valid: boolean; diagnostics: Diagnostic[];
  butterfly: { min_g: number | null; checked_points: number; domain: [number, number];
    right_wing_slope: number; left_wing_slope: number; tail_condition: boolean; global_proof: false };
} {
  const diagnostics: Diagnostic[] = [];
  if (!basicSviConstraints(p)) diagnostics.push({ code: "svi_parameter_constraints", severity: "error", message: "Raw SVI nonnegative-variance parameter constraints failed." });
  const right = p.b * (1 + p.rho);
  const left = p.b * (1 - p.rho);
  // Slopes strictly less than 2 imply d1(k)->-infinity on the right.
  const tail = right < 2 && left < 2;
  if (right > config.max_wing_slope || left > config.max_wing_slope || !tail) diagnostics.push({ code: "svi_wing_tail_violation", severity: "error", message: "SVI wing slopes exceed configured Lee bound (<2), or the right tail condition fails." });
  const low = Math.min(-2, ...observedK) - config.strike_extrapolation_k;
  const high = Math.max(2, ...observedK) + config.strike_extrapolation_k;
  const domain: [number, number] = [low, high];
  const seeds = new Set([...observedK, 0, p.m, p.m - p.rho * p.eta / Math.sqrt(1 - p.rho ** 2)]);
  for (let i = 0; i < config.diagnostic_points; i++) seeds.add(low + (high - low) * i / (config.diagnostic_points - 1));
  const values = new Map<number, { g: number | null; w: number }>();
  let minimum = Infinity;
  let worstK = 0;
  const sample = (k: number) => {
    const previous = values.get(k);
    if (previous) return previous;
    const result = sviDerivatives(p, k);
    const value = { g: result.g, w: result.w };
    values.set(k, value);
    if (value.g !== null && value.g < minimum) { minimum = value.g; worstK = k; }
    return value;
  };
  const refine = (a: number, b: number, depth: number) => {
    if (values.size >= 8192) return;
    const va = sample(a), vb = sample(b), midpoint = (a + b) / 2, vm = sample(midpoint);
    if (depth >= config.adaptive_depth || va.g === null || vb.g === null || vm.g === null) return;
    const curvature = Math.abs(vm.g - (va.g + vb.g) / 2);
    if (depth === 0 || Math.min(va.g, vb.g, vm.g) < .1 || curvature > .005) {
      refine(a, midpoint, depth + 1); refine(midpoint, b, depth + 1);
    }
  };
  const sorted = [...seeds].filter((k) => Number.isFinite(k) && k >= low && k <= high).sort((a, b) => a - b);
  for (const k of sorted) sample(k);
  for (let i = 0; i < sorted.length - 1; i++) refine(sorted[i]!, sorted[i + 1]!, 0);
  if ([...values.values()].some((v) => !Number.isFinite(v.w) || v.w <= 0 || v.g === null || !Number.isFinite(v.g))) {
    diagnostics.push({ code: "svi_nonpositive_variance", severity: "error", message: "Nonpositive/nonfinite variance or density diagnostic on the adaptive domain." });
  }
  if (minimum < -config.butterfly_tolerance) diagnostics.push({ code: "butterfly_density_violation", severity: "error", message: "Negative g(k) on the adaptive diagnostic domain; SVI valuation suppressed.", k: worstK, value: minimum });
  diagnostics.push({ code: "finite_grid_not_global_proof", severity: "info", message: "SVI parameter/wing/tail checks and adaptive finite-domain g(k) tests are numerical diagnostics, not a global arbitrage proof." });
  return { valid: !diagnostics.some((d) => d.severity === "error"), diagnostics,
    butterfly: { min_g: Number.isFinite(minimum) ? minimum : null, checked_points: values.size,
      domain, right_wing_slope: right, left_wing_slope: left, tail_condition: tail, global_proof: false } };
}
