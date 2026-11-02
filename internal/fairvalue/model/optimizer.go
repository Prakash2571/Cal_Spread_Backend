package model

import (
	"math"
	"sort"
)

// OptimizationResult is the outcome of BoundedNelderMead.
type OptimizationResult struct {
	Point      []float64
	Value      float64
	Iterations float64
	Converged  bool
}

// NelderMeadArgs are the inputs of BoundedNelderMead.
type NelderMeadArgs struct {
	Objective     func(point []float64) float64
	Start         []float64
	Bounds        [][2]float64
	Steps         []float64
	MaxIterations float64
	Tolerance     float64
}

type vertex struct {
	point []float64
	value float64
}

// BoundedNelderMead is optimizer.ts boundedNelderMead: deterministic box-bounded
// Nelder-Mead with finite objective and iteration guards. No random starts.
func BoundedNelderMead(a NelderMeadArgs) OptimizationResult {
	n := len(a.Start)
	clamp := func(point []float64) []float64 {
		out := make([]float64, len(point))
		for i, v := range point {
			out[i] = math.Max(a.Bounds[i][0], math.Min(a.Bounds[i][1], v))
		}
		return out
	}
	evaluate := func(point []float64) vertex {
		clipped := clamp(point)
		value := a.Objective(clipped)
		if !isFinite(value) {
			value = 1e100
		}
		return vertex{point: clipped, value: value}
	}
	simplex := []vertex{evaluate(a.Start)}
	for i := 0; i < n; i++ {
		p := append([]float64(nil), a.Start...)
		step := a.Steps[i]
		if p[i]+step <= a.Bounds[i][1] {
			p[i] = p[i] + step
		} else {
			p[i] = p[i] + -step
		}
		simplex = append(simplex, evaluate(p))
	}
	sortSimplex := func() {
		sort.SliceStable(simplex, func(i, j int) bool { return simplex[i].value < simplex[j].value })
	}
	for iteration := 0.0; iteration < a.MaxIterations; iteration++ {
		sortSimplex()
		best := simplex[0]
		worst := simplex[n]
		valueRange := worst.value - best.value
		diameter := math.Inf(-1)
		for _, v := range simplex[1:] {
			d := math.Inf(-1)
			for i, x := range v.point {
				d = math.Max(d, math.Abs(x-best.point[i]))
			}
			diameter = math.Max(diameter, d)
		}
		if iteration >= 40 && valueRange <= a.Tolerance*math.Max(1, math.Abs(best.value)) && diameter <= .025 {
			return OptimizationResult{Point: best.point, Value: best.value, Iterations: iteration, Converged: true}
		}
		centroid := make([]float64, n)
		for i := 0; i < n; i++ {
			sum := 0.0
			for _, s := range simplex[:n] {
				sum += s.point[i]
			}
			centroid[i] = sum / float64(n)
		}
		trial := make([]float64, n)
		for i, v := range centroid {
			trial[i] = v + (v - worst.point[i])
		}
		reflected := evaluate(trial)
		if reflected.value < best.value {
			for i, v := range centroid {
				trial[i] = v + float64(2*(reflected.point[i]-v))
			}
			expanded := evaluate(trial)
			if expanded.value < reflected.value {
				simplex[n] = expanded
			} else {
				simplex[n] = reflected
			}
		} else if reflected.value < simplex[n-1].value {
			simplex[n] = reflected
		} else {
			outside := reflected.value < worst.value
			for i, v := range centroid {
				target := worst.point[i]
				if outside {
					target = reflected.point[i]
				}
				trial[i] = v + float64(.5*(target-v))
			}
			contracted := evaluate(trial)
			limit := worst.value
			if outside {
				limit = reflected.value
			}
			if contracted.value < limit {
				simplex[n] = contracted
			} else {
				for i := 1; i <= n; i++ {
					shrunk := make([]float64, len(simplex[i].point))
					for j, v := range simplex[i].point {
						shrunk[j] = best.point[j] + float64(.5*(v-best.point[j]))
					}
					simplex[i] = evaluate(shrunk)
				}
			}
		}
	}
	sortSimplex()
	return OptimizationResult{Point: simplex[0].point, Value: simplex[0].value, Iterations: a.MaxIterations, Converged: false}
}
