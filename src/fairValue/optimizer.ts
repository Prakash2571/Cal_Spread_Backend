export interface OptimizationResult { point: number[]; value: number; iterations: number; converged: boolean }

/** Deterministic box-bounded Nelder–Mead, with finite objective/iteration guards. No random starts. */
export function boundedNelderMead(args: {
  objective: (point: number[]) => number;
  start: number[];
  bounds: [number, number][];
  steps: number[];
  maxIterations: number;
  tolerance: number;
}): OptimizationResult {
  const { objective, bounds, maxIterations, tolerance } = args;
  const n = args.start.length;
  const clamp = (point: number[]) => point.map((v, i) => Math.max(bounds[i]![0], Math.min(bounds[i]![1], v)));
  const evaluate = (point: number[]) => {
    const clipped = clamp(point);
    const value = objective(clipped);
    return { point: clipped, value: Number.isFinite(value) ? value : 1e100 };
  };
  const simplex = [evaluate(args.start)];
  for (let i = 0; i < n; i++) {
    const p = args.start.slice();
    const step = args.steps[i]!;
    p[i] = p[i]! + (p[i]! + step <= bounds[i]![1] ? step : -step);
    simplex.push(evaluate(p));
  }
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    simplex.sort((a, b) => a.value - b.value);
    const best = simplex[0]!;
    const worst = simplex[n]!;
    const valueRange = worst.value - best.value;
    const diameter = Math.max(...simplex.slice(1).map((p) => Math.max(...p.point.map((v, i) => Math.abs(v - best.point[i]!)))));
    if (iteration >= 40 && valueRange <= tolerance * Math.max(1, Math.abs(best.value)) && diameter <= .025) {
      return { point: best.point, value: best.value, iterations: iteration, converged: true };
    }
    const centroid = Array.from({ length: n }, (_, i) => simplex.slice(0, n).reduce((sum, s) => sum + s.point[i]!, 0) / n);
    const reflected = evaluate(centroid.map((v, i) => v + (v - worst.point[i]!)));
    if (reflected.value < best.value) {
      const expanded = evaluate(centroid.map((v, i) => v + 2 * (reflected.point[i]! - v)));
      simplex[n] = expanded.value < reflected.value ? expanded : reflected;
    } else if (reflected.value < simplex[n - 1]!.value) simplex[n] = reflected;
    else {
      const outside = reflected.value < worst.value;
      const contracted = evaluate(centroid.map((v, i) => v + .5 * ((outside ? reflected.point[i]! : worst.point[i]!) - v)));
      if (contracted.value < (outside ? reflected.value : worst.value)) simplex[n] = contracted;
      else {
        for (let i = 1; i <= n; i++) simplex[i] = evaluate(simplex[i]!.point.map((v, j) => best.point[j]! + .5 * (v - best.point[j]!)));
      }
    }
  }
  simplex.sort((a, b) => a.value - b.value);
  return { point: simplex[0]!.point, value: simplex[0]!.value, iterations: maxIterations, converged: false };
}
