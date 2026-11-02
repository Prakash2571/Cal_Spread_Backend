package marketdata

import (
	"sync"
	"time"
)

// SessionSweepInterval is how often index.ts reaped idle sessions
// (setInterval(() => marketDataSessions.sweep(), 60_000)). Create and Resolve sweep as well.
const SessionSweepInterval = time.Minute

// Sweeper is the part of SessionStore the background sweep uses.
type Sweeper interface{ Sweep() int }

// StartSessionSweeper sweeps s every interval (<= 0 means SessionSweepInterval) until the
// returned stop is called; stop is idempotent and returns once no sweep is running.
func StartSessionSweeper(s Sweeper, interval time.Duration) (stop func()) {
	if interval <= 0 {
		interval = SessionSweepInterval
	}
	t := time.NewTicker(interval)
	quit := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for {
			select {
			case <-quit:
				return
			case <-t.C:
				s.Sweep()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			t.Stop()
			close(quit)
		})
		<-finished
	}
}
