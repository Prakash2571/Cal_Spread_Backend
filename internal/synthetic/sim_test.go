package synthetic

import (
	"fmt"
	"runtime/debug"
	"sync"
	"time"
)

// sim is the deterministic runtime of the parity replay: Node's event loop on a fake
// clock, as testdata/gen_engine.mjs drives the original engine.
//
//   - One task (goroutine) runs at a time. The driver hands the baton to the task at the
//     head of the run queue and waits until it blocks or ends.
//   - spawn runs the new task at once, up to its first block, then resumes the spawner
//     before anything else: an async function runs synchronously up to its first await.
//   - A task that becomes runnable (an I/O answer delivered, a signal fired, a yield, a
//     timer) joins the back of the run queue: a promise continuation is a microtask.
//   - Every I/O call parks its task until the driver releases it (settle releases them one
//     at a time, oldest first, skipping held kinds, running the queue empty after each).
//   - Timers fire only in advance, one at a time in (due, creation) order, each followed by
//     a settle.
type sim struct {
	mu       sync.Mutex
	runq     []*simTask
	cur      *simTask
	back     chan struct{}
	now      int64
	timers   []*simTimer
	timerSeq int
	taskSeq  int
	fired    map[*signal]bool
	waiters  map[*signal][]*simTask
	pending  []*simCall
	callSeq  int
	failures []string
	// stall is how long the driver waits for a running task before declaring it stuck
	// (blocked on something the scheduler does not manage, e.g. a mutex held across a park).
	stall time.Duration
}

type simTask struct {
	id   int
	wake chan struct{}
}

type simTimer struct {
	id       int
	due      int64
	interval int64    // 0 for a one-shot sleep
	task     *simTask // the sleeper (one-shot)
	fn       func()   // the interval callback
}

type simCall struct {
	seq  int
	kind string
	task *simTask
}

func newSim(nowMs int64) *sim {
	return &sim{
		back:    make(chan struct{}),
		now:     nowMs,
		fired:   map[*signal]bool{},
		waiters: map[*signal][]*simTask{},
		stall:   20 * time.Second,
	}
}

var _ runtime = (*sim)(nil)

func (s *sim) nowMs() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now
}

func (s *sim) nowTime() time.Time { return time.UnixMilli(s.nowMs()) }

func (s *sim) fail(format string, args ...any) {
	s.mu.Lock()
	s.failures = append(s.failures, fmt.Sprintf(format, args...))
	s.mu.Unlock()
}

// newTask creates a parked task that runs f once the driver wakes it.
func (s *sim) newTask(f func()) *simTask {
	s.mu.Lock()
	s.taskSeq++
	t := &simTask{id: s.taskSeq, wake: make(chan struct{})}
	s.mu.Unlock()
	go func() {
		<-t.wake
		defer func() {
			if r := recover(); r != nil {
				s.fail("task %d panicked: %v\n%s", t.id, r, debug.Stack())
			}
			s.back <- struct{}{}
		}()
		f()
	}()
	return t
}

// current is the running task; runtime calls from outside a task are harness bugs.
func (s *sim) currentLocked(op string) *simTask {
	if s.cur == nil {
		panic("sim: " + op + " called outside a task")
	}
	return s.cur
}

// block hands the baton back to the driver and waits to be woken. The caller has
// already registered itself where it will be woken from.
func (s *sim) block(t *simTask) {
	s.back <- struct{}{}
	<-t.wake
}

func (s *sim) spawn(f func()) {
	child := s.newTask(f)
	s.mu.Lock()
	p := s.cur
	if p == nil {
		s.runq = append(s.runq, child)
		s.mu.Unlock()
		return
	}
	s.runq = append([]*simTask{child, p}, s.runq...)
	s.mu.Unlock()
	s.block(p)
}

func (s *sim) await(sig *signal) {
	s.mu.Lock()
	if s.fired[sig] {
		s.mu.Unlock()
		return
	}
	p := s.currentLocked("await")
	s.waiters[sig] = append(s.waiters[sig], p)
	s.mu.Unlock()
	s.block(p)
}

func (s *sim) fire(sig *signal) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fired[sig] {
		return
	}
	s.fired[sig] = true
	s.runq = append(s.runq, s.waiters[sig]...)
	delete(s.waiters, sig)
}

func (s *sim) yield() {
	s.mu.Lock()
	p := s.currentLocked("yield")
	s.runq = append(s.runq, p)
	s.mu.Unlock()
	s.block(p)
}

// delayMs is the fake setTimeout delay: Math.trunc(ms), at least 1.
func delayMs(d time.Duration) int64 {
	ms := d.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	return ms
}

func (s *sim) sleep(d time.Duration) {
	s.mu.Lock()
	p := s.currentLocked("sleep")
	s.timerSeq++
	s.timers = append(s.timers, &simTimer{id: s.timerSeq, due: s.now + delayMs(d), task: p})
	s.mu.Unlock()
	s.block(p)
}

func (s *sim) every(d time.Duration, f func()) func() {
	s.mu.Lock()
	s.timerSeq++
	tm := &simTimer{id: s.timerSeq, due: s.now + delayMs(d), interval: delayMs(d), fn: f}
	s.timers = append(s.timers, tm)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		s.removeTimerLocked(tm)
		s.mu.Unlock()
	}
}

func (s *sim) removeTimerLocked(tm *simTimer) {
	for i, x := range s.timers {
		if x == tm {
			s.timers = append(s.timers[:i:i], s.timers[i+1:]...)
			return
		}
	}
}

// park is the end of a fake I/O call: the running task waits until the driver releases
// the call (the answer was computed when the call arrived, like a database's effect).
func (s *sim) park(kind string) {
	s.mu.Lock()
	p := s.currentLocked("park " + kind)
	s.callSeq++
	s.pending = append(s.pending, &simCall{seq: s.callSeq, kind: kind, task: p})
	s.mu.Unlock()
	s.block(p)
}

// start queues f as a new task (an operation or a timer callback started by the driver).
func (s *sim) start(f func()) {
	t := s.newTask(f)
	s.mu.Lock()
	s.runq = append(s.runq, t)
	s.mu.Unlock()
}

// run hands the baton round until no task can move.
func (s *sim) run() {
	for steps := 0; ; steps++ {
		s.mu.Lock()
		if len(s.runq) == 0 || steps > 1_000_000 {
			if steps > 1_000_000 {
				s.failures = append(s.failures, "sim: runaway run queue")
			}
			s.cur = nil
			s.mu.Unlock()
			return
		}
		t := s.runq[0]
		s.runq = s.runq[1:]
		s.cur = t
		s.mu.Unlock()
		t.wake <- struct{}{}
		select {
		case <-s.back:
		case <-time.After(s.stall):
			panic(fmt.Sprintf("sim: task %d did not block or finish within %v (blocked outside the scheduler?)\n", t.id, s.stall))
		}
	}
}

// pendingKinds lists the parked calls, oldest first.
func (s *sim) pendingKinds() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []string{}
	for _, c := range s.pending {
		out = append(out, c.kind)
	}
	return out
}

// releaseAt delivers the answer of the i-th parked call and runs until nothing moves.
func (s *sim) releaseAt(i int) {
	s.mu.Lock()
	c := s.pending[i]
	s.pending = append(s.pending[:i:i], s.pending[i+1:]...)
	s.runq = append(s.runq, c.task)
	s.mu.Unlock()
	s.run()
}

// release delivers the oldest parked call of kind; false when there is none.
func (s *sim) release(kind string) bool {
	s.mu.Lock()
	idx := -1
	for i, c := range s.pending {
		if c.kind == kind {
			idx = i
			break
		}
	}
	s.mu.Unlock()
	if idx < 0 {
		return false
	}
	s.releaseAt(idx)
	return true
}

// settle runs the queue empty, then delivers parked answers one at a time, oldest
// first, skipping held kinds.
func (s *sim) settle(held map[string]bool) {
	s.run()
	for guard := 0; guard < 100_000; guard++ {
		s.mu.Lock()
		idx := -1
		for i, c := range s.pending {
			if !held[c.kind] {
				idx = i
				break
			}
		}
		s.mu.Unlock()
		if idx < 0 {
			return
		}
		s.releaseAt(idx)
	}
	s.fail("settle: runaway")
}

// advance moves the clock by ms, firing due timers one at a time in (due, creation)
// order, each followed by a settle.
func (s *sim) advance(ms int64, held map[string]bool) {
	s.mu.Lock()
	target := s.now + ms
	s.mu.Unlock()
	for {
		s.mu.Lock()
		var next *simTimer
		for _, tm := range s.timers {
			if tm.due <= target && (next == nil || tm.due < next.due || (tm.due == next.due && tm.id < next.id)) {
				next = tm
			}
		}
		if next == nil {
			s.mu.Unlock()
			break
		}
		s.now = next.due
		if next.interval > 0 {
			next.due += next.interval
		} else {
			s.removeTimerLocked(next)
		}
		fn, task := next.fn, next.task
		s.mu.Unlock()
		if fn != nil {
			s.start(fn)
		} else {
			s.mu.Lock()
			s.runq = append(s.runq, task)
			s.mu.Unlock()
		}
		s.settle(held)
	}
	s.mu.Lock()
	s.now = target
	s.mu.Unlock()
}

// dropTimers forgets every timer (a process restart: the old engine's timers die).
func (s *sim) dropTimers() {
	s.mu.Lock()
	s.timers = nil
	s.mu.Unlock()
}

func (s *sim) takeFailures() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := s.failures
	s.failures = nil
	return f
}
