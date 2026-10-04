import { blackPrice } from "./black.js";
import { huber, weightedMedian } from "./forward.js";
import { boundedNelderMead } from "./optimizer.js";
import { basicSviConstraints, diagnoseSvi, sviDerivatives, sviVariance } from "./svi.js";
import { intermediateStrikes, validatePriceGrid } from "./validation.js";
import type { CalibrationObservation, FitResidual, SmileConfig, SmileModel, SviParameters } from "./types.js";

export function unavailableSmile(reason: string): SmileModel {
  return {
    method: "unavailable", parameters: null, nodes: [], support: null, valid: false,
    diagnostics: [{ code: "smile_unavailable", severity: "warning", message: reason }],
    butterfly: { min_g: null, checked_points: 0, domain: null, right_wing_slope: null, left_wing_slope: null,
      tail_condition: null, global_proof: false },
    calibration: { observation_count: 0, distinct_strikes: 0, normalized_rmse: null,
      inside_spread_percent: null, optimizer_status: "unsupported", optimizer_iterations: 0,
      optimizer_starts: 0, duration_ms: 0, residuals: [], rejected: [] },
  };
}

export function interpolateVariance(nodes: { k: number; w: number }[], k: number, maxGap: number): number | null {
  if (!Number.isFinite(k) || nodes.length === 0 || k < nodes[0]!.k - 1e-12 || k > nodes[nodes.length - 1]!.k + 1e-12) return null;
  const exact = nodes.find((n) => Math.abs(n.k - k) < 1e-12);
  if (exact) return exact.w;
  const i = nodes.findIndex((n) => n.k > k);
  if (i <= 0) return null;
  const a = nodes[i - 1]!;
  const b = nodes[i]!;
  if (b.k - a.k > maxGap) return null;
  const alpha = (k - a.k) / (b.k - a.k);
  return (1 - alpha) * a.w + alpha * b.w;
}

export function varianceAt(model: SmileModel, k: number, config: SmileConfig, research = false): number | null {
  if (!model.valid || !model.support || !Number.isFinite(k)) return null;
  const { min_k, max_k } = model.support;
  if (k < min_k - 1e-12 || k > max_k + 1e-12) {
    if (!research || model.method !== "svi" || Math.max(min_k - k, k - max_k) > config.strike_extrapolation_k) return null;
  }
  if (model.method === "svi" && model.parameters) {
    const variance = sviVariance(model.parameters, k);
    const g = sviDerivatives(model.parameters, k).g;
    return Number.isFinite(variance) && variance >= 0 && g !== null && g >= -config.butterfly_tolerance ? variance : null;
  }
  return interpolateVariance(model.nodes, k, config.max_interpolation_gap);
}

export function calibrationResiduals(observations: CalibrationObservation[], variance: (k: number) => number | null,
  f: number, d: number): { residuals: FitResidual[]; normalized_rmse: number; inside_spread_percent: number } {
  const residuals: FitResidual[] = [];
  let sum = 0;
  let weights = 0;
  for (const obs of observations) {
    const w = variance(obs.k);
    if (w === null) continue;
    const price = blackPrice({ f, k: obs.strike, d, w, side: obs.side });
    const residual = price - obs.quote.mid;
    const weight = obs.quote.weight * obs.dependence_factor;
    sum += weight * (residual / obs.quote.h) ** 2;
    weights += weight;
    residuals.push({ token: obs.token, strike: obs.strike, side: obs.side, model_price: price, residual,
      standardized_residual: residual / obs.quote.h,
      inside_spread: price >= obs.quote.bid! - 1e-8 && price <= obs.quote.ask! + 1e-8 });
  }
  return { residuals, normalized_rmse: weights > 0 ? Math.sqrt(sum / weights) : Infinity,
    inside_spread_percent: residuals.length ? 100 * residuals.filter((r) => r.inside_spread).length / residuals.length : 0 };
}

/** Explicit piecewise-linear w fallback; validate actual-spacing CE/PE prices including between nodes. */
export function fitInterpolation(observations: CalibrationObservation[], f: number, d: number, config: SmileConfig): SmileModel {
  const start = performance.now();
  const distinct = new Map<number, { k: number; total: number; weight: number }>();
  for (const obs of observations) {
    const previous = distinct.get(obs.strike) ?? { k: obs.k, total: 0, weight: 0 };
    const weight = obs.quote.weight * obs.dependence_factor;
    previous.total += weight * obs.w;
    previous.weight += weight;
    distinct.set(obs.strike, previous);
  }
  if (distinct.size < config.min_interpolation_strikes) return unavailableSmile(`Interpolation needs ${config.min_interpolation_strikes} distinct eligible strikes; have ${distinct.size}.`);
  const nodes = [...distinct.values()].sort((a, b) => a.k - b.k).map((n) => ({ k: n.k, w: n.total / n.weight }));
  if (nodes.some((n) => !Number.isFinite(n.w) || n.w < 0)) return unavailableSmile("Invalid interpolation variance nodes.");
  const strikes = [...distinct.keys()].sort((a, b) => a - b);
  const model = unavailableSmile("");
  model.method = "validated_interpolation";
  model.nodes = nodes;
  model.support = { min_k: nodes[0]!.k, max_k: nodes[nodes.length - 1]!.k, strikes };
  const knotNeighbors = strikes.flatMap((strike) => [strike * Math.exp(-1e-5), strike, strike * Math.exp(1e-5)])
    .filter((strike) => strike >= strikes[0]! && strike <= strikes[strikes.length - 1]!);
  const validation = validatePriceGrid({ f, d, strikes: [...intermediateStrikes(strikes, 8), ...knotNeighbors],
    variance: (k) => interpolateVariance(nodes, k, config.max_interpolation_gap),
    tick: Math.min(...observations.map((o) => o.quote.h)), config });
  const residuals = calibrationResiduals(observations, (k) => interpolateVariance(nodes, k, config.max_interpolation_gap), f, d);
  model.valid = validation.valid && residuals.normalized_rmse <= config.max_normalized_rmse;
  model.diagnostics = [{ code: "interpolation_fallback", severity: "warning",
    message: "Piecewise-linear total-variance interpolation within observed support, numerically validated; no global butterfly proof or wing extrapolation." }, ...validation.diagnostics];
  model.calibration = { ...model.calibration, ...residuals, observation_count: observations.length,
    distinct_strikes: distinct.size, duration_ms: performance.now() - start, optimizer_status: "interpolation_no_optimizer" };
  if (!model.valid) model.diagnostics.push({ code: "interpolation_invalid", severity: "error", message: "Fallback failed price-space or residual validation; valuation suppressed." });
  return model;
}

export function fitSmile(observations: CalibrationObservation[], f: number, d: number, config: SmileConfig): SmileModel {
  if (config.model === "interpolation") return fitInterpolation(observations, f, d, config);
  const fitted = fitSvi(observations, f, d, config);
  if (fitted.valid) return fitted;
  const fallback = fitInterpolation(observations, f, d, config);
  fallback.diagnostics.unshift(...fitted.diagnostics);
  fallback.calibration.optimizer_status = `${fitted.calibration.optimizer_status}; ${fallback.calibration.optimizer_status}`;
  fallback.calibration.optimizer_iterations = fitted.calibration.optimizer_iterations;
  fallback.calibration.optimizer_starts = fitted.calibration.optimizer_starts;
  fallback.calibration.duration_ms += fitted.calibration.duration_ms;
  if (!fallback.valid && fallback.method === "validated_interpolation") fallback.calibration.optimizer_status += "; fallback_validation_failure";
  return fallback;
}

/** Price-space Huber calibration with bounded deterministic multi-start optimization. */
export function fitSvi(observations: CalibrationObservation[], f: number, d: number, config: SmileConfig): SmileModel {
  const started = performance.now();
  const ks = [...new Set(observations.map((o) => o.k))].sort((a, b) => a - b);
  const minK = ks[0] ?? 0, maxK = ks[ks.length - 1] ?? 0;
  if (ks.length < config.min_svi_strikes || maxK - minK < config.min_k_span ||
      ks.filter((k) => k < -config.atm_band).length < config.min_each_wing ||
      ks.filter((k) => k > config.atm_band).length < config.min_each_wing) {
    const unavailable = unavailableSmile(`SVI needs at least ${config.min_svi_strikes} distinct, well-spread strikes (k span ${config.min_k_span}, ${config.min_each_wing} per wing).`);
    unavailable.calibration.optimizer_status = "svi_insufficient_support";
    return unavailable;
  }
  const scale = weightedMedian(observations.map((o) => ({ value: o.w, weight: o.quote.weight * o.dependence_factor })));
  if (scale <= config.variance_floor || !Number.isFinite(scale)) return unavailableSmile("SVI variance scale is unsupported.");
  const span = Math.max(maxK - minK, .05);
  const toParameters = (point: number[]): SviParameters => {
    const minimum = point[0]! * scale;
    const b = point[1]! * scale / span;
    const rho = point[2]!;
    const eta = point[4]! * span;
    return { a: minimum - b * eta * Math.sqrt(1 - rho ** 2), b, rho, m: point[3]! * span, eta };
  };
  const bounds: [number, number][] = [[config.variance_floor / scale, 4], [0, Math.min(30, config.max_wing_slope * span / scale)],
    [-.98, .98], [minK / span - 1, maxK / span + 1], [.005, 3]];
  const checkK = [...ks, ...Array.from({ length: 41 }, (_, i) => -2 + i / 10)];
  const weightSum = observations.reduce((sum, o) => sum + o.quote.weight * o.dependence_factor, 0);
  const objective = (point: number[]): number => {
    const p = toParameters(point);
    if (!basicSviConstraints(p) || p.b * (1 + Math.abs(p.rho)) > config.max_wing_slope) return 1e50;
    let loss = 0;
    for (const obs of observations) {
      const w = sviVariance(p, obs.k);
      if (!Number.isFinite(w) || w <= 0) return 1e50;
      const price = blackPrice({ f, k: obs.strike, d, w, side: obs.side });
      loss += obs.quote.weight * obs.dependence_factor * huber((price - obs.quote.mid) / obs.quote.h, config.huber_delta);
    }
    let densityPenalty = 0;
    for (const k of checkK) {
      const g = sviDerivatives(p, k).g;
      if (g === null || !Number.isFinite(g)) return 1e50;
      densityPenalty += Math.min(g, 0) ** 2;
    }
    // Regularization discourages unnecessarily steep wings and shifted/narrow
    // curvature. Numerical density penalty assists, but final hard validation owns acceptance.
    return loss + config.regularization * (point[1]! ** 2 + .1 * point[3]! ** 2 + .001 / point[4]! ** 2) +
      weightSum * 1e4 * densityPenalty / checkK.length;
  };
  const minW = Math.min(...observations.map((o) => o.w));
  const starts = [
    [minW / scale * .85, .4, -.3, 0, .25],
    [minW / scale * .7, .7, -.65, .05, .4],
    [minW / scale * .8, .5, .3, -.05, .3],
    [minW / scale * .6, 1, 0, 0, .5],
    [minW / scale * .95, .15, -.1, 0, .15],
    [minW / scale * .5, 1.3, -.8, .2, .7],
    [minW / scale * .9, .3, .6, -.2, .2],
    [minW / scale * .8, .01, 0, 0, .4],
  ].slice(0, config.optimizer_starts);
  const results = starts.map((start) => boundedNelderMead({ start, bounds, steps: [.12, .15, .15, .12, .12], objective,
    maxIterations: config.optimizer_iterations, tolerance: config.optimizer_tolerance }));
  const converged = results.filter((r) => r.converged).sort((a, b) => a.value - b.value);
  if (converged.length === 0) {
    const unavailable = unavailableSmile("All bounded SVI optimizer starts exhausted their budgets; interpolation only if validated.");
    unavailable.calibration.optimizer_status = "svi_iteration_failure";
    unavailable.calibration.optimizer_iterations = results.reduce((sum, r) => sum + r.iterations, 0);
    unavailable.calibration.optimizer_starts = results.length;
    unavailable.calibration.duration_ms = performance.now() - started;
    return unavailable;
  }
  // Prefer the best objective among candidates that actually pass hard diagnostics.
  let best: SmileModel | null = null;
  for (const result of converged) {
    const parameters = toParameters(result.point);
    const diagnostics = diagnoseSvi(parameters, ks, config);
    const strikes = [...new Set(observations.map((o) => o.strike))].sort((a, b) => a - b);
    const priceValidation = validatePriceGrid({ f, d, strikes: intermediateStrikes(strikes, 8),
      variance: (k) => sviVariance(parameters, k), tick: Math.min(...observations.map((o) => o.quote.h)), config });
    const residuals = calibrationResiduals(observations, (k) => sviVariance(parameters, k), f, d);
    const valid = diagnostics.valid && priceValidation.valid && residuals.normalized_rmse <= config.max_normalized_rmse;
    const model: SmileModel = {
      method: "svi", parameters, nodes: ks.map((k) => ({ k, w: sviVariance(parameters, k) })),
      support: { min_k: minK, max_k: maxK, strikes }, valid,
      diagnostics: [...diagnostics.diagnostics, ...priceValidation.diagnostics], butterfly: diagnostics.butterfly,
      calibration: { ...residuals, observation_count: observations.length, distinct_strikes: strikes.length,
        optimizer_status: valid ? "svi_converged_validated" : "svi_validation_failure",
        optimizer_iterations: results.reduce((sum, r) => sum + r.iterations, 0), optimizer_starts: results.length,
        duration_ms: performance.now() - started, rejected: [] },
    };
    if (residuals.normalized_rmse > config.max_normalized_rmse) model.diagnostics.push({ code: "price_residual_limit", severity: "error", message: "Fitted price residuals exceed the configured normalized RMSE limit." });
    if (!best) best = model;
    if (valid) return model;
  }
  return best ?? unavailableSmile("No supported SVI calibration.");
}
