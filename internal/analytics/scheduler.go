package analytics

import (
	"context"
	"time"
)

// Scheduling (index.ts startOptionOiCapture :5120-5187, startRedisFlushRetry :703,
// triggerPostLoginBackfill :3371-3415) and the shutdown hooks.

const gapCheckInterval = 30 * time.Minute

// Boot is the boot order of index.ts: the warm load, then the flush-retry timer and the
// capture schedulers.
func (s *Service) Boot(ctx context.Context) {
	s.WarmLoad(ctx)
	s.Start()
}

// Start arms the schedulers (startRedisFlushRetry then startOptionOiCapture): the
// cold-start backfill windows are snapshotted first, a tick runs at once and then 3 s
// before every minute boundary (captures only within isIstMarketHours), the cold-start
// chain runs once, and a 30-minute gap check runs during market hours. Call WarmLoad
// first. Start is a no-op after the first call and after Stop.
func (s *Service) Start() {
	s.mu.Lock()
	if s.started || s.stopped {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.mu.Unlock()

	if s.cacheEnabled() {
		s.armFlushRetry()
	}

	coldOpt := s.oiBackfillFromMs(s.nowMs())
	coldFut := s.futOiBackfillFromMs(s.nowMs())

	s.tick()

	s.goAsync(func(ctx context.Context) {
		s.backfillOiFrames(ctx, &coldOpt)
		s.backfillFutOiFrames(ctx, &coldFut)
		s.backfillPrevClose(ctx)
		s.coarsenFrames()
		s.flush()
	})
	s.armGapCheck()
}

// tick is one capture tick: within market hours the capture chain runs (option capture,
// futures capture, then one flush), and the next tick is armed regardless.
func (s *Service) tick() {
	s.mu.Lock()
	stopped := s.stopped
	s.mu.Unlock()
	if stopped {
		return
	}
	if s.isIstMarketHours(s.nowMs()) {
		s.goAsync(func(ctx context.Context) {
			s.captureOptionOi(ctx)
			s.captureFuturesOi(ctx)
			s.flush()
		})
	}
	s.scheduleNextTick()
}

// nextTickDelay is scheduleNextTick's arithmetic: the next hh:mm:57, never sooner than 1 s.
func nextTickDelay(now int64) int64 {
	step := captureIntervalMs
	target := ceilDiv(now+captureLeadMs, step)*step - captureLeadMs
	if target-now < 1000 {
		target += step
	}
	return target - now
}

func (s *Service) scheduleNextTick() {
	delay := time.Duration(nextTickDelay(s.nowMs())) * time.Millisecond
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	s.tickTimer = s.d.AfterFunc(delay, s.tick)
}

// armGapCheck is the 30-minute setInterval (anchored at Start, not the wall clock).
func (s *Service) armGapCheck() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	s.gapTimer = s.d.AfterFunc(gapCheckInterval, func() {
		s.armGapCheck()
		s.gapCheck()
	})
}

// gapCheck is one run of the 30-minute timer: in market hours, snapshot both windows and
// run the backfill chain.
func (s *Service) gapCheck() {
	if !s.isIstMarketHours(s.nowMs()) {
		return
	}
	optFrom := s.oiBackfillFromMs(s.nowMs())
	futFrom := s.futOiBackfillFromMs(s.nowMs())
	s.goAsync(func(ctx context.Context) {
		s.backfillOiFrames(ctx, &optFrom)
		s.backfillFutOiFrames(ctx, &futFrom)
		s.backfillPrevClose(ctx)
		s.coarsenFrames()
		s.flush()
	})
}

// armFlushRetry is startRedisFlushRetry: every 60 s, whatever the market hours, flush if
// anything is pending (rescues the closing buckets after an outage).
func (s *Service) armFlushRetry() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	s.flushTimer = s.d.AfterFunc(flushRetryInterval, func() {
		s.armFlushRetry()
		s.mu.Lock()
		pending := s.hasPendingLocked()
		s.mu.Unlock()
		if pending {
			s.voidFlush()
		}
	})
}

// OnKiteLogin is the analytics half of triggerPostLoginBackfill, for POST /api/session and
// GET /callback after a successful login: the backfill windows are snapshotted first
// (a capture stamps every frame at now), then option capture → futures capture → option
// backfill → futures backfill → previous close → coarsening → flush run in sequence on a
// goroutine. Not market-hours gated. The hourly/EOD backfills are the captures package's.
func (s *Service) OnKiteLogin() {
	s.startRecovery(true)
}

// OnBrokerReady reconciles the active broker after a selection or token change.
// Boot already runs the cold-start chain; repeated ready events coalesce.
func (s *Service) OnBrokerReady() {
	s.startRecovery(false)
}

func (s *Service) startRecovery(force bool) {
	s.syncNamespace()
	s.mu.Lock()
	if s.stopped || (!s.started && !force) {
		s.mu.Unlock()
		return
	}
	if s.recoveryRunning {
		s.recoveryAgain = true
		s.mu.Unlock()
		return
	}
	s.recoveryRunning = true
	s.mu.Unlock()
	s.goAsync(func(ctx context.Context) {
		defer func() {
			s.mu.Lock()
			s.recoveryRunning = false
			again := s.recoveryAgain
			s.recoveryAgain = false
			s.mu.Unlock()
			if again {
				s.OnBrokerReady()
			}
		}()
		s.mu.Lock()
		warm := s.scopeWarm
		s.mu.Unlock()
		if !warm {
			s.WarmLoad(ctx)
		}
		if s.checkOperation(ctx) != nil {
			return
		}
		optFrom := s.oiBackfillFromMs(s.nowMs())
		futFrom := s.futOiBackfillFromMs(s.nowMs())
		s.captureOptionOi(ctx)
		s.captureFuturesOi(ctx)
		s.backfillOiFrames(ctx, &optFrom)
		s.backfillFutOiFrames(ctx, &futFrom)
		s.backfillPrevClose(ctx)
		s.coarsenFrames()
		s.flush()
	})
}

// Stop stops the timers, cancels the captures and backfills in flight (their Kite calls
// and pacing delays return early) and waits for every goroutine; a cache flush in flight
// is allowed to finish. Writes still buffered stay for FlushNow. Safe to call twice.
func (s *Service) Stop(ctx context.Context) error {
	s.mu.Lock()
	if !s.stopped {
		s.stopped = true
		for _, t := range []Timer{s.tickTimer, s.gapTimer, s.flushTimer} {
			if t != nil {
				t.Stop()
			}
		}
	}
	s.mu.Unlock()
	s.cancel()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
