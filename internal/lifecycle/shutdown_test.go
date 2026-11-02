package lifecycle_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
)

type logs struct {
	mu sync.Mutex
	l  []string
}

func (l *logs) logf(f string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.l = append(l.l, strings.TrimSpace(fmt.Sprintf(f, a...)))
}
func (l *logs) joined() string { l.mu.Lock(); defer l.mu.Unlock(); return strings.Join(l.l, "\n") }

func TestStepsRunInOrderAndFailuresDoNotStopLaterSteps(t *testing.T) {
	var order []string
	steps := []lifecycle.Step{
		{Name: "a", Run: func(context.Context) error { order = append(order, "a"); return nil }},
		{Name: "b", Run: func(context.Context) error { order = append(order, "b"); return errors.New("boom") }},
		{Name: "c", Run: func(context.Context) error { order = append(order, "c"); panic("kaboom") }},
		{Name: "d", Run: func(context.Context) error { order = append(order, "d"); return nil }},
	}
	lg := &logs{}
	res := lifecycle.NewCoordinator(steps, time.Second, lg.logf, nil).Run("SIGTERM")
	if strings.Join(order, "") != "abcd" {
		t.Fatalf("order = %v", order)
	}
	if got := strings.Join(res.Completed, ","); got != "a,d" {
		t.Errorf("completed = %s", got)
	}
	if len(res.Failed) != 2 || res.Failed[0].Step != "b" || res.Failed[1].Step != "c" || !strings.Contains(res.Failed[1].Err.Error(), "kaboom") {
		t.Errorf("failed = %+v", res.Failed)
	}
	if res.TimedOut || res.ExitCode() != 0 {
		t.Errorf("failed steps alone exit 0, got timedOut=%v code=%d", res.TimedOut, res.ExitCode())
	}
	for _, want := range []string{"SIGTERM received — starting graceful shutdown of 4 step(s).", "ok: a", "FAILED: b: boom (continuing)", "complete in", "2 ok, 2 failed."} {
		if !strings.Contains(lg.joined(), want) {
			t.Errorf("log is missing %q:\n%s", want, lg.joined())
		}
	}
}

func TestTimeoutReturnsWhileStuckStepKeepsRunning(t *testing.T) {
	release := make(chan struct{})
	finished := make(chan struct{})
	steps := []lifecycle.Step{
		{Name: "fast", Run: func(context.Context) error { return nil }},
		{Name: "stuck", Run: func(context.Context) error { <-release; close(finished); return nil }},
		{Name: "after", Run: func(context.Context) error { return nil }},
	}
	lg := &logs{}
	start := time.Now()
	res := lifecycle.NewCoordinator(steps, 50*time.Millisecond, lg.logf, nil).Run("SIGINT")
	if time.Since(start) > 2*time.Second {
		t.Fatal("Run must return at the timeout")
	}
	if !res.TimedOut || res.ExitCode() != 1 {
		t.Fatalf("timedOut=%v code=%d", res.TimedOut, res.ExitCode())
	}
	if strings.Join(res.Completed, ",") != "fast" {
		t.Errorf("completed = %v", res.Completed)
	}
	if !strings.Contains(lg.joined(), "Not finished: stuck, after.") {
		t.Errorf("stuck steps not reported:\n%s", lg.joined())
	}
	close(release) // the sequence is not cancelled: it finishes in the background
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("the stuck step was cancelled instead of left running")
	}
}

func TestRepeatedRunReturnsTheSameResultWithoutRerunning(t *testing.T) {
	var mu sync.Mutex
	runs := 0
	gate := make(chan struct{})
	c := lifecycle.NewCoordinator([]lifecycle.Step{{Name: "once", Run: func(context.Context) error {
		mu.Lock()
		runs++
		mu.Unlock()
		<-gate
		return nil
	}}}, time.Second, nil, nil)

	first := make(chan lifecycle.Result, 1)
	go func() { first <- c.Run("SIGTERM") }()
	for !c.InProgress() {
		time.Sleep(time.Millisecond)
	}
	second := make(chan lifecycle.Result, 1)
	go func() { second <- c.Run("SIGINT") }()
	time.Sleep(20 * time.Millisecond)
	close(gate)
	r1, r2 := <-first, <-second
	if r1.Signal != "SIGTERM" || r2.Signal != "SIGTERM" {
		t.Errorf("both callers see the first run's result: %q %q", r1.Signal, r2.Signal)
	}
	if runs != 1 {
		t.Errorf("steps ran %d times", runs)
	}
}

func TestDefaultTimeout(t *testing.T) {
	if lifecycle.DefaultTimeout != 12*time.Second {
		t.Fatal("SHUTDOWN_TIMEOUT_MS defaults to 12000")
	}
}
