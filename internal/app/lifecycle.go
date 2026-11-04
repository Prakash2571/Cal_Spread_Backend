package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/marketdata"
)

// Boot and shutdown. The boot chain is the listen callback of src/index.ts; the
// shutdown steps are its ShutdownCoordinator, without the two Box steps.

const (
	// bootStopWait bounds how long Shutdown waits for a boot chain still running (it is
	// cancelled first), so no component starts after it has been stopped.
	bootStopWait = 5 * time.Second
	// handlerDrainWait bounds the wait for handlers whose connections the HTTP step closed.
	handlerDrainWait = 2 * time.Second
	// schedulerStopWait bounds the analytics Stop (captures in flight are cancelled).
	schedulerStopWait = 10 * time.Second
	// flushTimeout bounds the final analytics cache flush.
	flushTimeout = 10 * time.Second
	// synthIdleWait bounds the wait for Synthetic background writes before the pool
	// closes.
	synthIdleWait = 5 * time.Second
	// purgeTimeout bounds one purge run.
	purgeTimeout = 30 * time.Second
)

// Start runs index.ts's boot chain once and returns when it has finished; the Synthetic
// and Fair Value boots keep running in the background (`void module.boot()`). Requests
// may be served while it runs, as in Node. A step that panics ends the chain with
// "[Startup] initialisation chain failed" and the service keeps serving, like Node's
// .catch on the chain. Cancelling ctx (or Shutdown) stops the chain between steps.
//
// Order (index.ts:5441-5555):
//  1. the market-data session sweeper (a module-level 60 s interval in Node);
//  2. the nse_fno block: EOD scheduler, stock-futures backfill and summary
//     reconciliation. Node started it from the same listen callback, concurrently with
//     the main chain (its connections were opened at module load); one pool serves both
//     here, so it starts before the chain's first step;
//  3. the purge job for expired cache and admin-session rows (PLAN decision; Node relied
//     on Redis TTLs);
//  4. the main chain: restore today's Kite session, restore the active broker, start its
//     runtime, restore admin sessions, restore the risk-free rate, the hourly scheduler
//     with its backfill and the day review, the analytics warm load followed by the
//     flush-retry timer and the option-OI capture, then the Synthetic and Fair Value
//     boots in the background.
func (a *App) Start(ctx context.Context) {
	a.mu.Lock()
	if a.started || a.stopping {
		a.mu.Unlock()
		return
	}
	a.started = true
	ctx, cancel := context.WithCancel(ctx)
	a.bootCancel = cancel
	done := make(chan struct{})
	a.bootDone = done
	a.mu.Unlock()
	defer close(done)
	defer cancel()

	a.bootStep("market-data session sweeper", func() {
		stop := marketdata.StartSessionSweeper(a.mdStore, 0)
		a.mu.Lock()
		a.stopSweeper = stop
		a.mu.Unlock()
	})
	a.bootStep("EOD capture scheduler and startup backfill", func() {
		defer a.recoverAs("[Startup] nse_fno initialisation failed: %v")
		a.captures.StartEOD()
	})
	a.bootStep("expired-row purge job", a.startPurge)

	defer a.recoverAs("[Startup] initialisation chain failed: %v")
	steps := []struct {
		name string
		run  func()
	}{
		{"restore the Zerodha session", func() { a.core.RestoreKiteSession(ctx) }},
		{"restore the active broker", func() { a.reg.Restore(ctx) }},
		{"start the active broker runtime", func() { a.reg.StartActiveRuntime(ctx); a.reg.StartDhanTokenService() }},
		{"restore admin sessions", func() { a.restoreAdminSessions(ctx) }},
		{"restore the risk-free rate", func() { a.core.RestoreRfRate(ctx) }},
		{"hourly capture scheduler, backfill and day review", a.captures.StartHourly},
		{"analytics warm load and capture schedulers", func() {
			a.analytics.Boot(ctx)
			a.mu.Lock()
			a.analyticsStarted = true
			a.mu.Unlock()
		}},
		{"Spike boot", func() {
			if err := a.spike.Start(ctx); err != nil {
				a.logf("[Spike] boot: %v", err)
			}
		}},
		{"Synthetic boot", func() { a.background(a.synth.Boot, "[Synthetic] boot failed: %v") }},
		{"Fair Value boot", func() { a.background(a.fv.Boot, "[Fair Value] boot failed: %v") }},
	}
	for _, s := range steps {
		if !a.bootStep(s.name, s.run) {
			return
		}
	}
}

// bootStep runs one step unless shutdown has begun (then it reports false).
func (a *App) bootStep(name string, run func()) bool {
	a.mu.Lock()
	stopping := a.stopping
	a.mu.Unlock()
	if stopping {
		return false
	}
	a.note("boot: " + name)
	run()
	return true
}

// background starts a boot that Node did not await (`void boot().catch(warn)`), tracked
// so Shutdown can let it pass its first critical section before disposing the engine.
func (a *App) background(boot func(), failure string) {
	a.mu.Lock()
	if a.stopping {
		a.mu.Unlock()
		return
	}
	a.bootTasks.Add(1)
	a.mu.Unlock()
	go func() {
		defer a.bootTasks.Done()
		defer a.recoverAs(failure)
		boot()
	}()
}

func (a *App) recoverAs(format string) {
	if r := recover(); r != nil {
		a.logf(format, r)
	}
}

// restoreAdminSessions is the admin-session block of the boot chain.
func (a *App) restoreAdminSessions(ctx context.Context) {
	n, err := a.sessions.Restore(ctx)
	if err != nil {
		a.logf("[Admin] session restore failed: %v", err)
		return
	}
	if n > 0 {
		a.logf("[Admin] Restored %d persisted admin session(s).", n)
	}
}

// startPurge runs the purge once now and then every PurgeInterval until the shutdown
// step "stop capture/flush schedulers". Without a database there is nothing to purge.
func (a *App) startPurge() {
	if !a.pool.Enabled() {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(a.opts.PurgeInterval)
		defer t.Stop()
		for {
			a.purgeOnce(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	var once sync.Once
	a.mu.Lock()
	a.stopPurge = func() {
		once.Do(cancel)
		<-done
	}
	a.mu.Unlock()
}

// purgeOnce deletes expired cache keys (Redis expired them by itself) and expired admin
// sessions (reads already ignore both, so nothing a client sees changes).
func (a *App) purgeOnce(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, purgeTimeout)
	defer cancel()
	n, err := a.cache.Purge(ctx)
	switch {
	case err != nil && ctx.Err() == nil:
		a.logf("[Cache] purge of expired keys failed: %v", err)
	case n > 0:
		a.logf("[Cache] purged %d expired key(s).", n)
	}
	m, err := a.store.PurgeExpiredAdminSessions(ctx)
	switch {
	case err != nil && ctx.Err() == nil:
		a.logf("[Admin] purge of expired sessions failed: %v", err)
	case m > 0:
		a.logf("[Admin] purged %d expired session(s).", m)
	}
	a.note("purge")
}

// Shutdown step names: index.ts's, in its order, without "disable new Box entry
// discovery" (first) and "dispose Box engine (positions preserved)" (after the
// schedulers). Two steps are new: the final cache flush (a PLAN decision) and the wait
// for background writes, both before the pool closes, which stays LAST.
const (
	stepSynthetic  = "stop the synthetic-futures scanner"
	stepFairValue  = "stop Fair Value analytics workers"
	stepHTTP       = "stop accepting new HTTP connections"
	stepSchedulers = "stop capture/flush schedulers"
	stepFeeds      = "stop broker market-data feeds"
	stepFlush      = "flush the analytics cache"
	stepWrites     = "finish background database writes"
	stepDatabase   = "close PostgreSQL connections"
)

func (a *App) shutdownSteps() []lifecycle.Step {
	step := func(name string, run func(context.Context) error) lifecycle.Step {
		return lifecycle.Step{Name: name, Run: func(ctx context.Context) error {
			a.note("shutdown: " + name)
			return run(ctx)
		}}
	}
	return []lifecycle.Step{
		// Detection only; it ends its SSE streams so the HTTP drain is not held open.
		step(stepSynthetic, func(ctx context.Context) error { a.synth.Dispose(); return a.spike.Stop(ctx) }),
		step(stepFairValue, func(context.Context) error { a.fv.Dispose(); return nil }),
		step(stepHTTP, a.stopHTTP),
		step(stepSchedulers, a.stopSchedulers),
		// Positions, orders and persisted state are untouched.
		step(stepFeeds, func(context.Context) error { a.reg.StopFeeds(); return nil }),
		step(stepFlush, func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, flushTimeout)
			defer cancel()
			return a.analytics.FlushNow(ctx)
		}),
		step(stepWrites, a.finishWrites),
		// LAST: everything above may still have written on its way out.
		step(stepDatabase, func(context.Context) error {
			if a.pool.Enabled() {
				a.pool.Close()
				a.logf("[shutdown] PostgreSQL pool closed.")
			}
			return nil
		}),
	}
}

// Shutdown runs the shutdown sequence once (a repeated call logs and waits for the
// first): the boot chain is cancelled and given bootStopWait to return, then the steps
// run in order, each one isolated from the others' failures, under SHUTDOWN_TIMEOUT_MS
// (default 12 s). Positions are never flattened. It returns when the steps finished,
// when the deadline passed (TimedOut; the remaining steps go on in the background, as
// Node's did until process.exit), or when ctx ends. Exit with Result.ExitCode().
func (a *App) Shutdown(ctx context.Context, signal string) lifecycle.Result {
	a.mu.Lock()
	a.stopping = true
	cancel, bootDone := a.bootCancel, a.bootDone
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	tokenStopCtx, tokenStopCancel := context.WithTimeout(ctx, bootStopWait)
	if err := a.reg.StopDhanTokenService(tokenStopCtx); err != nil {
		a.logf("[shutdown] token-service worker did not stop: %v", err)
	}
	tokenStopCancel()
	if bootDone != nil {
		select {
		case <-bootDone:
		case <-time.After(bootStopWait):
			a.logf("[shutdown] the boot chain is still running after %v; shutting down anyway.", bootStopWait)
		}
	}
	if !waitTimeout(&a.bootTasks, bootStopWait) {
		a.logf("[shutdown] a background boot is still running after %v; shutting down anyway.", bootStopWait)
	}

	res := make(chan lifecycle.Result, 1)
	go func() { res <- a.coord.Run(signal) }()
	select {
	case r := <-res:
		return r
	case <-ctx.Done():
		return lifecycle.Result{Signal: signal, TimedOut: true}
	}
}

// stopHTTP is index.ts's HTTP step: stop listening, close idle keep-alive connections,
// give in-flight requests HTTPDrainGrace, then close what remains (SSE streams; the
// browsers reconnect to the next process). It then waits briefly for the handlers of the
// closed connections to finish their cleanup.
func (a *App) stopHTTP(ctx context.Context) error {
	grace, cancel := context.WithTimeout(ctx, HTTPDrainGrace)
	err := a.server.Shutdown(grace)
	cancel()
	if err != nil {
		_ = a.server.Close()
		if errors.Is(err, context.DeadlineExceeded) {
			a.logf("[shutdown] HTTP drain grace of %dms elapsed; remaining connections (SSE clients) closed.", HTTPDrainGrace.Milliseconds())
		}
	}
	deadline := time.Now().Add(handlerDrainWait)
	for a.inflight.Load() > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}

// stopSchedulers is "stop capture/flush schedulers": the capture schedulers and their
// background runs, the analytics timers (flush retry, option-OI capture and its gap
// check) with the captures in flight, the market-data session sweeper and the purge job.
func (a *App) stopSchedulers(ctx context.Context) error {
	names := a.captures.Stop()
	a.mu.Lock()
	analyticsStarted := a.analyticsStarted
	stopSweeper, stopPurge := a.stopSweeper, a.stopPurge
	a.mu.Unlock()
	stopCtx, cancel := context.WithTimeout(ctx, schedulerStopWait)
	err := a.analytics.Stop(stopCtx)
	cancel()
	if analyticsStarted {
		if a.cache.Enabled() {
			names = append(names, "redis-flush-retry")
		}
		names = append(names, "option-oi-capture")
	}
	if stopSweeper != nil {
		stopSweeper()
	}
	if stopPurge != nil {
		stopPurge()
	}
	if len(names) > 0 {
		a.logf("[shutdown] cleared timers: %s", strings.Join(names, ", "))
	}
	return err
}

// finishWrites waits for the writes still running in the background before the pool
// closes: Synthetic's store and margin work, the Kite-session and risk-free-rate queue
// (core.Dispose also ends route work still in flight), the calendar ledger and
// admin-session saves/deletes. HTTP and stream handlers have already stopped.
func (a *App) finishWrites(ctx context.Context) error {
	if !a.synth.WaitIdle(synthIdleWait) {
		a.logf("[shutdown] Synthetic background work still running after %v.", synthIdleWait)
	}
	a.core.Dispose()
	a.calendar.Stop()
	return a.sessions.WaitForWrites(ctx)
}

// waitTimeout waits for wg up to d and reports whether it finished.
func waitTimeout(wg *sync.WaitGroup, d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}
