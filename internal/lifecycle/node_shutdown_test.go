package lifecycle_test

// Ports of tests/box/shutdown.test.mjs cases that the earlier Go tests did not assert
// with Node's inputs and expectations. Go steps are blocking calls: a returned error is
// a rejected promise, a panic is a thrown value.

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
)

// "repeated calls after completion still do not re-run steps"
func TestNodeRepeatedCallsAfterCompletionDoNotRerun(t *testing.T) {
	var calls []string
	c := lifecycle.NewCoordinator([]lifecycle.Step{{Name: "a", Run: func(context.Context) error {
		calls = append(calls, "a")
		return nil
	}}}, 0, nil, nil)
	r1 := c.Run("SIGTERM")
	r2 := c.Run("SIGTERM")
	if !reflect.DeepEqual(calls, []string{"a"}) {
		t.Fatalf("calls = %v, want [a]", calls)
	}
	if !reflect.DeepEqual(r1, r2) {
		t.Errorf("the second call must return the first run's result: %+v vs %+v", r1, r2)
	}
}

// "inProgress flips as soon as shutdown begins": false before Run, true while the first
// step runs (Run blocks in Go, so "synchronously after run()" is observed from inside
// the step) and still true after completion.
func TestNodeInProgressFlipsAsSoonAsShutdownBegins(t *testing.T) {
	var c *lifecycle.Coordinator
	during := false
	c = lifecycle.NewCoordinator([]lifecycle.Step{{Name: "a", Run: func(context.Context) error {
		during = c.InProgress()
		return nil
	}}}, 0, nil, nil)
	if c.InProgress() {
		t.Fatal("in progress before Run")
	}
	c.Run("SIGTERM")
	if !during {
		t.Error("must be in progress once shutdown has begun")
	}
	if !c.InProgress() {
		t.Error("must stay in progress after completion")
	}
}

// "every step failing still reaches the end and reports each one"
func TestNodeEveryStepFailingStillReachesTheEnd(t *testing.T) {
	var steps []lifecycle.Step
	for _, name := range []string{"a", "b", "c"} {
		steps = append(steps, lifecycle.Step{Name: name, Run: func(context.Context) error { return errors.New(name + " boom") }})
	}
	res := lifecycle.NewCoordinator(steps, 0, nil, nil).Run("SIGTERM")
	if len(res.Completed) != 0 {
		t.Errorf("completed = %v, want []", res.Completed)
	}
	var failed []string
	for _, f := range res.Failed {
		failed = append(failed, f.Step)
	}
	if !reflect.DeepEqual(failed, []string{"a", "b", "c"}) {
		t.Errorf("failed = %v, want [a b c]", failed)
	}
	if res.TimedOut {
		t.Error("timed out")
	}
}

// "a non-Error throw is still recorded": Promise.reject("a string") records the bare
// String(err); the Go equivalent of throwing a non-Error value is a panic with it.
func TestNodeNonErrorThrowIsRecorded(t *testing.T) {
	res := lifecycle.NewCoordinator([]lifecycle.Step{{Name: "odd", Run: func(context.Context) error {
		panic("a string")
	}}}, 0, nil, nil).Run("SIGTERM")
	if len(res.Failed) != 1 || res.Failed[0].Step != "odd" {
		t.Fatalf("failed = %+v", res.Failed)
	}
	if got := res.Failed[0].Err.Error(); got != "a string" {
		t.Errorf("error = %q, want %q", got, "a string")
	}
}

// "the timeout reports which steps did not finish"
func TestNodeTimeoutReportsWhichStepsDidNotFinish(t *testing.T) {
	hung := make(chan struct{})
	t.Cleanup(func() { close(hung) })
	lg := &logs{}
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "fast", Run: func(context.Context) error { return nil }},
		{Name: "hung", Run: func(context.Context) error { <-hung; return nil }},
		{Name: "never-reached", Run: func(context.Context) error { return nil }},
	}, 40*time.Millisecond, lg.logf, nil).Run("SIGTERM")
	if !reflect.DeepEqual(res.Completed, []string{"fast"}) {
		t.Errorf("completed = %v, want [fast]", res.Completed)
	}
	var line string
	lg.mu.Lock()
	for _, l := range lg.l {
		if strings.Contains(l, "TIMED OUT") {
			line = l
			break
		}
	}
	lg.mu.Unlock()
	if line == "" {
		t.Fatalf("the timeout must be logged clearly:\n%s", lg.joined())
	}
	for _, want := range []string{"hung", "never-reached", "NO trading state has been altered or invented"} {
		if !strings.Contains(line, want) {
			t.Errorf("timeout line %q is missing %q", line, want)
		}
	}
	// The whole line as src/shutdown.ts writes it for these steps (recorded by running
	// the TypeScript coordinator with the same steps and timeoutMs 40).
	const node = "[shutdown] TIMED OUT after 40ms. Completed 1/3. Not finished: hung, never-reached. Exiting non-zero. NO trading state has been altered or invented."
	if line != node {
		t.Errorf("timeout line\n got %q\nwant %q", line, node)
	}
}

// "the signal name and duration are reported": now() advances 5 ms per call from 1000.
func TestNodeSignalNameAndDurationAreReported(t *testing.T) {
	ms := int64(1000)
	now := func() time.Time { ms += 5; return time.UnixMilli(ms) }
	res := lifecycle.NewCoordinator([]lifecycle.Step{{Name: "a", Run: func(context.Context) error { return nil }}}, 0, nil, now).Run("SIGINT")
	if res.Signal != "SIGINT" {
		t.Errorf("signal = %q", res.Signal)
	}
	if res.Duration < 0 {
		t.Errorf("duration = %v, want >= 0", res.Duration)
	}
	// Node reads the clock at the start and at the end, so durationMs is 5 there too.
	if res.Duration != 5*time.Millisecond {
		t.Errorf("duration = %v, want 5ms (two clock reads)", res.Duration)
	}
}

// "an empty step list is a clean no-op"
func TestNodeEmptyStepListIsACleanNoOp(t *testing.T) {
	res := lifecycle.NewCoordinator(nil, 0, nil, nil).Run("SIGTERM")
	if len(res.Completed) != 0 || len(res.Failed) != 0 || res.TimedOut || res.ExitCode() != 0 {
		t.Fatalf("result %+v exit %d", res, res.ExitCode())
	}
}
