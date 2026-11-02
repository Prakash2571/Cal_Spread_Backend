package quotes

import (
	"math"
	"sort"
)

func uniqueSorted(strikes []float64) []float64 {
	seen := make(map[float64]bool, len(strikes))
	out := make([]float64, 0, len(strikes))
	for _, s := range strikes {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Float64s(out)
	return out
}

// AtmStrike is the strike nearest to spot; on a tie the lower strike wins. ok is false
// for an empty chain.
func AtmStrike(strikes []float64, spot float64) (float64, bool) {
	if len(strikes) == 0 {
		return 0, false
	}
	sorted := append([]float64(nil), strikes...)
	sort.Float64s(sorted)
	best, bestDist := sorted[0], math.Abs(sorted[0]-spot)
	for _, s := range sorted {
		if d := math.Abs(s - spot); d < bestDist {
			best, bestDist = s, d
		}
	}
	return best, true
}

// StrikeStep is the median gap between adjacent distinct strikes (the upper median for an
// even number of gaps); 0 for fewer than two strikes.
func StrikeStep(strikes []float64) float64 {
	sorted := uniqueSorted(strikes)
	if len(sorted) < 2 {
		return 0
	}
	gaps := make([]float64, 0, len(sorted)-1)
	for i := 1; i < len(sorted); i++ {
		gaps = append(gaps, sorted[i]-sorted[i-1])
	}
	sort.Float64s(gaps)
	return gaps[len(gaps)/2]
}

// SelectStrikeWindow returns the ATM strike and up to eachSide existing strikes either side
// of it. Near the end of a chain fewer are returned rather than reaching further the other way.
func SelectStrikeWindow(strikes []float64, spot float64, eachSide int) (atm float64, window []float64, ok bool) {
	sorted := uniqueSorted(strikes)
	atm, ok = AtmStrike(sorted, spot)
	if !ok {
		return 0, nil, false
	}
	idx := sort.SearchFloat64s(sorted, atm)
	lo := max(0, idx-eachSide)
	hi := min(len(sorted)-1, idx+eachSide)
	return atm, append([]float64(nil), sorted[lo:hi+1]...), true
}

// ShouldRecentreWindow reports whether spot has moved past the midpoint to the next strike
// by the extra hysteresis fraction of a step.
func ShouldRecentreWindow(currentAtm, spot, strikeStep, hysteresis float64) bool {
	if !(strikeStep > 0) {
		return false
	}
	return math.Abs(spot-currentAtm) > strikeStep*(0.5+hysteresis)
}
