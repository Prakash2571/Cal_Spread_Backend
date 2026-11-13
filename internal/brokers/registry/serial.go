package registry

import (
	"log"
	"log/slog"
	"sync"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

// serial runs functions one at a time, in submission order, on a goroutine that exists
// only while work is queued.
//
// Every wire operation on a Dhan feed goes through one of these. dhan.Feed blocks
// UnsubscribeTokens and Stop until an in-flight tick delivery has returned, and the tick
// consumers (hub listeners, Synthetic) take their own locks, which they also hold while
// declaring token sets through the coordinators. Calling the feed directly from a
// coordinator transport would therefore deadlock (consumer lock -> coordinator -> feed
// gate, while the delivery holds the gate and waits for the consumer lock). Queueing
// keeps the transport non-blocking and the order of subscribe/unsubscribe frames exactly
// as the coordinator issued them.
type serial struct {
	mu      sync.Mutex
	queue   []func()
	running bool
}

// Go queues fn.
func (s *serial) Go(fn func()) {
	s.mu.Lock()
	s.queue = append(s.queue, fn)
	if !s.running {
		s.running = true
		go s.run()
	}
	s.mu.Unlock()
}

// Do queues fn and waits until it (and everything queued before it) has run.
func (s *serial) Do(fn func()) {
	done := make(chan struct{})
	s.Go(func() {
		defer close(done)
		fn()
	})
	<-done
}

func (s *serial) run() {
	for {
		s.mu.Lock()
		if len(s.queue) == 0 {
			s.running = false
			s.mu.Unlock()
			return
		}
		fn := s.queue[0]
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.mu.Unlock()
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[Broker] feed operation failed: %v", r)
				}
			}()
			fn()
		}()
	}
}

// dhanLane is one Dhan feed with its wire queue. Reads (IsConnected, counts, ages) go to
// the feed directly; anything that changes the socket goes through the queue.
type dhanLane struct {
	feed DhanFeed
	wire serial
	// Main only: one bit per logical lane retains overlapping subscriptions.
	// Owned by wire, including reset on stop; replay is idempotent per lane.
	sharedWanted map[int64]uint8
	// Owned by wire. A replaced lane must never reopen from a late queued operation.
	retired bool
}

func sharedLaneBit(lane brokers.Lane) uint8 {
	switch lane {
	case brokers.LaneBox:
		return 2
	case spikeLane:
		return 4
	default:
		return 1
	}
}

// subscribeShared merges the main, box and Spike tables without subscribing twice. Like
// all feed mutations, it queues work and never calls back into a coordinator.
func (l *dhanLane) subscribeShared(lane brokers.Lane, tokens []int64) {
	cp := append([]int64(nil), tokens...)
	l.wire.Go(func() {
		if l.retired {
			return
		}
		if l.sharedWanted == nil {
			l.sharedWanted = map[int64]uint8{}
		}
		bit := sharedLaneBit(lane)
		var fresh []int64
		for _, token := range cp {
			if l.sharedWanted[token] == 0 {
				fresh = append(fresh, token)
			}
			l.sharedWanted[token] |= bit
		}
		if len(fresh) > 0 {
			before := l.feed.WantedCount()
			l.feed.SubscribeTokens(fresh)
			if wanted := l.feed.WantedCount(); before <= 5000 && wanted > 5000 {
				slog.Warn("Dhan main feed exceeds the per-connection instrument cap", "wanted", wanted, "limit", 5000)
			}
		}
	})
}

func (l *dhanLane) unsubscribeShared(lane brokers.Lane, tokens []int64) {
	cp := append([]int64(nil), tokens...)
	l.wire.Go(func() {
		bit := sharedLaneBit(lane)
		var drop []int64
		for _, token := range cp {
			bits := l.sharedWanted[token]
			if bits&bit == 0 {
				continue
			}
			if bits&^bit == 0 {
				delete(l.sharedWanted, token)
				drop = append(drop, token)
			} else {
				l.sharedWanted[token] = bits &^ bit
			}
		}
		if len(drop) > 0 {
			l.feed.UnsubscribeTokens(drop)
		}
	})
}

func (l *dhanLane) ensureSocket() {
	l.wire.Do(func() {
		if !l.retired {
			l.feed.EnsureSocket()
		}
	})
}

// retire permanently closes a replaced lane. The registry keeps it installed until
// this returns, so no replacement socket can open while the old one is still stopping.
func (l *dhanLane) retire() {
	l.wire.Do(func() {
		l.retired = true
		l.sharedWanted = nil
		l.feed.Stop()
	})
}

// stop runs after every queued operation and returns once the feed has stopped, so a
// broker switch never continues while the old socket can still be (re)opened.
func (l *dhanLane) stop() {
	l.wire.Do(func() {
		l.sharedWanted = nil
		l.feed.Stop()
	})
}

// flush waits for every queued operation (tests and diagnostics).
func (l *dhanLane) flush() { l.wire.Do(func() {}) }
