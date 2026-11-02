package kite

import (
	"context"
	"sync"
	"time"
)

// HistoricalPriority says who is asking for historical candles (kite.ts
// HistoricalPriority). Only "background" is background; anything else, including "",
// is interactive.
type HistoricalPriority string

const (
	// Interactive is a request a user is waiting on (a chart endpoint).
	Interactive HistoricalPriority = "interactive"
	// Background is a scheduler or backfill; it yields to interactive work.
	Background HistoricalPriority = "background"
)

const (
	// HistoricalMinGap is the spacing between historical request STARTS (kite.ts
	// HISTORICAL_MIN_GAP_MS): Kite allows ~3/s on that endpoint.
	HistoricalMinGap = 350 * time.Millisecond
	// HistoricalSlotTimeout hands a slot back after this long whatever the request is
	// doing (kite.ts HISTORICAL_SLOT_TIMEOUT_MS), so one stalled call cannot wedge the
	// queue; the call keeps running, so two may briefly be in flight.
	HistoricalSlotTimeout = 20 * time.Second
)

// HistoricalGate serialises and paces every historical-candle request in the process
// (kite.ts HistoricalGate): one slot, request starts at least minGap apart, interactive
// callers queued ahead of every queued background caller (FIFO within a class), and a
// watchdog that releases a slot after slotTimeout. Release hands the slot straight to
// the next waiter.
type HistoricalGate struct {
	minGap      time.Duration
	slotTimeout time.Duration

	mu            sync.Mutex
	busy          bool
	lastStartedAt time.Time
	waiting       []*gateWaiter
}

type gateWaiter struct {
	background bool
	ready      chan struct{}
}

// NewHistoricalGate builds a gate. The timings are parameters only so tests can use short
// ones; production uses the process-wide gate (DefaultHistoricalGate).
func NewHistoricalGate(minGap, slotTimeout time.Duration) *HistoricalGate {
	return &HistoricalGate{minGap: minGap, slotTimeout: slotTimeout}
}

// defaultGate is the single process-wide gate (kite.ts `historicalGate`): the rate limit
// belongs to the account, not to a client instance.
var defaultGate = NewHistoricalGate(HistoricalMinGap, HistoricalSlotTimeout)

// DefaultHistoricalGate returns the process-wide gate every Client uses by default.
func DefaultHistoricalGate() *HistoricalGate { return defaultGate }

// HistoricalQueueDepth is how many historical requests are queued on the process-wide
// gate, excluding the one in flight (kite.ts historicalQueueDepth).
func HistoricalQueueDepth() int { return defaultGate.Queued() }

// Queued is how many calls wait behind the one in flight.
func (g *HistoricalGate) Queued() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.waiting)
}

// Run acquires the slot for prio, waits out the start gap, stamps the start and runs
// call. The slot is released exactly once, by whichever of the watchdog or call's return
// comes first. A cancelled ctx abandons the wait (an addition: Node had no cancellation);
// with context.Background it behaves exactly like the Node gate.
func (g *HistoricalGate) Run(ctx context.Context, prio HistoricalPriority, call func() error) error {
	if err := g.acquire(ctx, prio); err != nil {
		return err
	}
	var once sync.Once
	releaseOnce := func() { once.Do(g.release) }
	watchdog := time.AfterFunc(g.slotTimeout, releaseOnce)
	defer func() {
		watchdog.Stop()
		releaseOnce()
	}()

	g.mu.Lock()
	gap := g.minGap - time.Since(g.lastStartedAt)
	g.mu.Unlock()
	if gap > 0 {
		t := time.NewTimer(gap)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		}
	}
	// Stamped at START, so the gap paces request starts rather than adding to however
	// long the previous response took.
	g.mu.Lock()
	g.lastStartedAt = time.Now()
	g.mu.Unlock()
	return call()
}

func (g *HistoricalGate) acquire(ctx context.Context, prio HistoricalPriority) error {
	g.mu.Lock()
	if !g.busy {
		g.busy = true
		g.mu.Unlock()
		return nil
	}
	w := &gateWaiter{background: prio == Background, ready: make(chan struct{})}
	if w.background {
		g.waiting = append(g.waiting, w)
	} else {
		// Ahead of every queued background call, behind interactive ones already waiting.
		i := 0
		for i < len(g.waiting) && !g.waiting[i].background {
			i++
		}
		g.waiting = append(g.waiting, nil)
		copy(g.waiting[i+1:], g.waiting[i:])
		g.waiting[i] = w
	}
	g.mu.Unlock()

	select {
	case <-w.ready:
		return nil
	case <-ctx.Done():
		g.mu.Lock()
		for i, x := range g.waiting {
			if x == w {
				g.waiting = append(g.waiting[:i], g.waiting[i+1:]...)
				g.mu.Unlock()
				return ctx.Err()
			}
		}
		g.mu.Unlock()
		// The slot was handed to us as we gave up: pass it on.
		g.release()
		return ctx.Err()
	}
}

// release hands the slot to the next waiter, or marks the gate free.
func (g *HistoricalGate) release() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.waiting) > 0 {
		next := g.waiting[0]
		g.waiting = g.waiting[1:]
		close(next.ready)
		return
	}
	g.busy = false
}
