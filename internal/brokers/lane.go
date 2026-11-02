package brokers

import (
	"sync"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// LaneFeedStats is the per-lane feed summary in the status endpoints.
type LaneFeedStats struct {
	Lane             Lane    `json:"lane"`
	Connected        bool    `json:"connected"`
	SubscribedTokens int     `json:"subscribedTokens"`
	WantedTokens     int     `json:"wantedTokens"`
	TicksPerSecond   float64 `json:"ticksPerSecond"`
	LastTickAgeMs    *int64  `json:"lastTickAgeMs"`
	Reconnects       int     `json:"reconnects"`
	Generation       int     `json:"generation"`
}

// TickRateCounter is marketDataLane.ts TickRateCounter: a fixed ring of per-second
// buckets, so memory stays bounded however fast ticks arrive.
type TickRateCounter struct {
	mu       sync.Mutex
	seconds  int
	buckets  []int
	bucketAt []int64
	cursor   int
}

// NewTickRateCounter returns a counter over the given number of seconds (default 10).
func NewTickRateCounter(seconds int) *TickRateCounter {
	if seconds <= 0 {
		seconds = 10
	}
	return &TickRateCounter{seconds: seconds, buckets: make([]int, seconds), bucketAt: make([]int64, seconds)}
}

// Mark adds count ticks seen at nowMs.
func (t *TickRateCounter) Mark(count int, nowMs int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	second := nowMs / 1000
	if t.bucketAt[t.cursor] == second {
		t.buckets[t.cursor] += count
		return
	}
	t.cursor = (t.cursor + 1) % t.seconds
	t.bucketAt[t.cursor] = second
	t.buckets[t.cursor] = count
}

// PerSecond is the mean ticks per second over the completed seconds in the window,
// rounded to one decimal; the current, still-filling second is excluded.
func (t *TickRateCounter) PerSecond(nowMs int64) float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	newest := nowMs / 1000
	total, counted := 0, 0
	for i := 0; i < t.seconds; i++ {
		at := t.bucketAt[i]
		if at == 0 || at >= newest || newest-at > int64(t.seconds) {
			continue
		}
		total += t.buckets[i]
		counted++
	}
	if counted == 0 {
		return 0
	}
	return jsx.Round(float64(total)/float64(counted)*10) / 10
}

// Reset clears the ring.
func (t *TickRateCounter) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i := range t.buckets {
		t.buckets[i], t.bucketAt[i] = 0, 0
	}
	t.cursor = 0
}
