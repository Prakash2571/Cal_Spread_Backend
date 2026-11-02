// Package lifecycle runs ordered, time-boxed graceful shutdown (shutdown.ts).
package lifecycle

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// DefaultTimeout is how long shutdown may take before the process exits anyway.
const DefaultTimeout = 12 * time.Second

// Step is one shutdown action. Steps run in order, one at a time.
type Step struct {
	Name string
	Run  func(ctx context.Context) error
}

// Failure records a step that returned an error.
type Failure struct {
	Step string
	Err  error
}

// Result is what a shutdown run achieved.
type Result struct {
	Signal    string
	Completed []string
	Failed    []Failure
	TimedOut  bool
	Duration  time.Duration
}

// ExitCode is 1 only if shutdown timed out; failed steps alone still exit 0.
func (r Result) ExitCode() int {
	if r.TimedOut {
		return 1
	}
	return 0
}

// Coordinator runs the steps once. A step that fails never stops the later ones. If the
// whole sequence exceeds the timeout, Run returns anyway and the sequence is left to
// finish in the background while the caller exits; it is never cancelled mid-step.
type Coordinator struct {
	steps   []Step
	timeout time.Duration
	logf    func(format string, args ...any)
	now     func() time.Time

	mu     sync.Mutex
	done   chan struct{}
	result Result
}

// NewCoordinator returns a coordinator. timeout <= 0 means DefaultTimeout; logf and now may be nil.
func NewCoordinator(steps []Step, timeout time.Duration, logf func(string, ...any), now func() time.Time) *Coordinator {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if now == nil {
		now = time.Now
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Coordinator{steps: steps, timeout: timeout, logf: logf, now: now}
}

// InProgress reports whether a shutdown has started.
func (c *Coordinator) InProgress() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.done != nil
}

// Run performs the shutdown for signal. A repeated call waits for and returns the first
// run's result.
func (c *Coordinator) Run(signal string) Result {
	c.mu.Lock()
	if c.done != nil {
		done := c.done
		c.mu.Unlock()
		c.logf("[shutdown] %s received while already shutting down — ignoring.", signal)
		<-done
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.result
	}
	done := make(chan struct{})
	c.done = done
	c.mu.Unlock()

	start := c.now()
	var mu sync.Mutex
	res := Result{Signal: signal}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		c.logf("[shutdown] %s received — starting graceful shutdown of %d step(s).", signal, len(c.steps))
		for _, s := range c.steps {
			err := runStep(s)
			mu.Lock()
			if err != nil {
				res.Failed = append(res.Failed, Failure{Step: s.Name, Err: err})
			} else {
				res.Completed = append(res.Completed, s.Name)
			}
			mu.Unlock()
			if err != nil {
				c.logf("[shutdown] FAILED: %s: %v (continuing)", s.Name, err)
			} else {
				c.logf("[shutdown] ok: %s", s.Name)
			}
		}
	}()

	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	timedOut := false
	select {
	case <-finished:
	case <-timer.C:
		timedOut = true
	}

	mu.Lock()
	out := Result{
		Signal:    signal,
		Completed: append([]string(nil), res.Completed...),
		Failed:    append([]Failure(nil), res.Failed...),
		TimedOut:  timedOut,
		Duration:  c.now().Sub(start),
	}
	mu.Unlock()

	if timedOut {
		seen := map[string]bool{}
		for _, n := range out.Completed {
			seen[n] = true
		}
		for _, f := range out.Failed {
			seen[f.Step] = true
		}
		var stuck []string
		for _, s := range c.steps {
			if !seen[s.Name] {
				stuck = append(stuck, s.Name)
			}
		}
		notFinished := strings.Join(stuck, ", ")
		if notFinished == "" {
			notFinished = "(none recorded)"
		}
		// shutdown.ts prints the configured timeout, not the elapsed time.
		c.logf("[shutdown] TIMED OUT after %dms. Completed %d/%d. Not finished: %s. Exiting non-zero. NO trading state has been altered or invented.",
			c.timeout.Milliseconds(), len(out.Completed), len(c.steps), notFinished)
	} else {
		c.logf("[shutdown] complete in %dms — %d ok, %d failed.", out.Duration.Milliseconds(), len(out.Completed), len(out.Failed))
	}

	c.mu.Lock()
	c.result = out
	c.mu.Unlock()
	close(done)
	return out
}

// runStep calls the step with a background context and turns a panic into an error so
// one bad step cannot abort the sequence. The panic value's text is recorded as is, as
// shutdown.ts records `err instanceof Error ? err.message : String(err)` for a throw.
func runStep(s Step) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	return s.Run(context.Background())
}
