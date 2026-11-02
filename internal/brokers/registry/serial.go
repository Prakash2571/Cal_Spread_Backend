package registry

import (
	"log"
	"sync"
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
}

func (l *dhanLane) subscribe(tokens []int64) {
	cp := append([]int64(nil), tokens...)
	l.wire.Go(func() { l.feed.SubscribeTokens(cp) })
}

func (l *dhanLane) unsubscribe(tokens []int64) {
	cp := append([]int64(nil), tokens...)
	l.wire.Go(func() { l.feed.UnsubscribeTokens(cp) })
}

func (l *dhanLane) ensureSocket() { l.wire.Do(l.feed.EnsureSocket) }

// stop runs after every queued operation and returns once the feed has stopped, so a
// broker switch never continues while the old socket can still be (re)opened.
func (l *dhanLane) stop() { l.wire.Do(l.feed.Stop) }

// flush waits for every queued operation (tests and diagnostics).
func (l *dhanLane) flush() { l.wire.Do(func() {}) }
