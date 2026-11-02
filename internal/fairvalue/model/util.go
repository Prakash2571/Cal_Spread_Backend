package model

import (
	"math"
	"sort"
	"time"
)

var perfOrigin = time.Now()

// perfNow is performance.now(): fractional milliseconds from a monotonic origin. It
// only feeds duration_ms fields, which are timing diagnostics.
func perfNow() float64 { return float64(time.Since(perfOrigin).Nanoseconds()) / 1e6 }

// sortStable is array.sort with a comparator that is negative exactly when less(a, b).
func sortStable[T any](items []T, less func(a, b T) bool) {
	sort.SliceStable(items, func(i, j int) bool { return less(items[i], items[j]) })
}

// jsSliceEnd is the end index array.slice(0, end) uses for an array of length n.
func jsSliceEnd(n int, end float64) int {
	if math.IsNaN(end) {
		return 0
	}
	e := math.Trunc(end)
	if e < 0 {
		e = math.Max(float64(n)+e, 0)
	}
	return int(math.Min(e, float64(n)))
}
