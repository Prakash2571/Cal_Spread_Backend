package synthetic

import (
	"sync"
	"time"
)

// runtime is how the engine runs background work, waits for it and keeps time. The
// production runtime (sysRuntime) uses goroutines, channels and the system clock. The
// parity tests install a scheduler that runs one goroutine at a time in a fixed order on
// a fake clock, which reproduces Node's single event loop:
//
//   - spawn runs the new work at once, up to its first wait, before the caller goes on,
//     exactly as calling an async function ran its body up to its first await;
//   - work that becomes runnable (an answer arrived, a signal fired, yield) queues
//     behind the work already waiting, as a promise continuation queued a microtask;
//   - timers fire only when the test advances the fake clock.
//
// The engine never holds its mutex across await, sleep or yield (or any I/O call), and
// spawns only with the mutex released (see Engine.unlock), so one-at-a-time scheduling
// cannot deadlock on it.
type runtime interface {
	// spawn runs f in the background (Node: a promise nobody awaits).
	spawn(f func())
	// await blocks until s has fired; it returns at once when s already has.
	await(s *signal)
	// fire releases every waiter of s and makes later awaits return at once.
	fire(s *signal)
	// yield lets background work that is already runnable go first (Node: the
	// microtask boundary of a `.then` callback). A no-op in production.
	yield()
	// sleep pauses the caller (Node: await of a setTimeout promise).
	sleep(d time.Duration)
	// every calls f every d until stop is called (Node: setInterval).
	every(d time.Duration, f func()) (stop func())
}

// signal is a one-shot event: a refresh, a close or a settings turn that has finished.
// The production runtime closes ch; the test scheduler keeps its own bookkeeping.
type signal struct {
	once sync.Once
	ch   chan struct{}
}

func newSignal() *signal { return &signal{ch: make(chan struct{})} }

// sysRuntime is the production runtime.
type sysRuntime struct {
	mu    sync.Mutex
	cond  *sync.Cond
	count int // background tasks still running
}

func newSysRuntime() *sysRuntime {
	r := &sysRuntime{}
	r.cond = sync.NewCond(&r.mu)
	return r
}

func (r *sysRuntime) spawn(f func()) {
	r.mu.Lock()
	r.count++
	r.mu.Unlock()
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				logf("background task failed: %v", rec)
			}
			r.mu.Lock()
			r.count--
			if r.count == 0 {
				r.cond.Broadcast()
			}
			r.mu.Unlock()
		}()
		f()
	}()
}

func (r *sysRuntime) await(s *signal) { <-s.ch }

func (r *sysRuntime) fire(s *signal) { s.once.Do(func() { close(s.ch) }) }

func (r *sysRuntime) yield() {}

func (r *sysRuntime) sleep(d time.Duration) { time.Sleep(d) }

func (r *sysRuntime) every(d time.Duration, f func()) func() {
	if d < time.Millisecond {
		d = time.Millisecond // setInterval's minimum delay
	}
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(d)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				select {
				case <-stop: // stopped while waiting: a cleared interval never fires again
					return
				default:
				}
				f()
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(stop) }) }
}

// idle blocks until no background task is running (tests on the production runtime).
func (r *sysRuntime) idle() {
	r.mu.Lock()
	for r.count > 0 {
		r.cond.Wait()
	}
	r.mu.Unlock()
}
