package lifecycle_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
)

// Remaining failure-mode assertions from tests/box/shutdown.test.mjs.

func TestNodeSecondSignalRunsEachStepOnce(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls []string
	c := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "a", Run: func(context.Context) error { calls = append(calls, "a"); close(started); <-release; return nil }},
		{Name: "b", Run: func(context.Context) error { calls = append(calls, "b"); return nil }},
	}, time.Second, nil, nil)
	first := make(chan lifecycle.Result, 1)
	go func() { first <- c.Run("SIGTERM") }()
	<-started
	results := make(chan lifecycle.Result, 2)
	go func() { results <- c.Run("SIGTERM") }()
	go func() { results <- c.Run("SIGINT") }()
	close(release)
	want := <-first
	for i := 0; i < 2; i++ {
		if got := <-results; !reflect.DeepEqual(got, want) {
			t.Errorf("all callers must see the first run's result: %+v, want %+v", got, want)
		}
	}
	if !reflect.DeepEqual(calls, []string{"a", "b"}) {
		t.Fatalf("each step must run exactly once: %v", calls)
	}
}

func TestNodeShutdownDeclaredOrderAndCompleteReporting(t *testing.T) {
	// These are the Node suite's arbitrary step labels, not Box dependencies.
	order := []string{"mark-shutting-down", "disable-box-entries", "http-close", "stop-timers", "box-engine-dispose", "stop-broker-feed", "close-databases"}
	var steps []lifecycle.Step
	var calls []string
	for _, name := range order {
		steps = append(steps, lifecycle.Step{Name: name, Run: func(context.Context) error { calls = append(calls, name); return nil }})
	}
	res := lifecycle.NewCoordinator(steps, 0, nil, nil).Run("SIGTERM")
	if !reflect.DeepEqual(calls, order) || !reflect.DeepEqual(res.Completed, order) {
		t.Fatalf("declared order = %v, completed = %v; want %v", calls, res.Completed, order)
	}
}

func TestNodeShutdownAwaitsAnAsyncStep(t *testing.T) {
	var calls []string
	finished := false
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "slow", Run: func(context.Context) error {
			calls = append(calls, "slow")
			timer := time.NewTimer(25 * time.Millisecond)
			defer timer.Stop()
			<-timer.C
			finished = true
			return nil
		}},
		{Name: "after", Run: func(context.Context) error {
			if !finished {
				return errors.New("next step began before the async step finished")
			}
			calls = append(calls, "after")
			return nil
		}},
	}, time.Second, nil, nil).Run("SIGTERM")
	if len(res.Failed) != 0 || !reflect.DeepEqual(calls, []string{"slow", "after"}) {
		t.Fatalf("async ordering = %v; failures %+v", calls, res.Failed)
	}
}

func TestNodeShutdownFailureDoesNotSkipDatabaseClose(t *testing.T) {
	var calls []string
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "stop-scanner", Run: func(context.Context) error {
			calls = append(calls, "stop-scanner")
			panic(errors.New("scanner already stopped"))
		}},
		{Name: "stop-feed", Run: func(context.Context) error { calls = append(calls, "stop-feed"); return nil }},
		{Name: "close-databases", Run: func(context.Context) error { calls = append(calls, "close-databases"); return nil }},
	}, 0, nil, nil).Run("SIGTERM")
	if !reflect.DeepEqual(calls, []string{"stop-scanner", "stop-feed", "close-databases"}) ||
		!reflect.DeepEqual(res.Completed, []string{"stop-feed", "close-databases"}) || len(res.Failed) != 1 ||
		res.Failed[0].Step != "stop-scanner" || !strings.Contains(res.Failed[0].Err.Error(), "already stopped") {
		t.Fatalf("failure isolation: calls %v; result %+v", calls, res)
	}
}

func TestNodeShutdownRejectedPromiseIsRecorded(t *testing.T) {
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "async-fail", Run: func(context.Context) error { return errors.New("nope") }},
		{Name: "after", Run: func(context.Context) error { return nil }},
	}, 0, nil, nil).Run("SIGTERM")
	if !reflect.DeepEqual(res.Completed, []string{"after"}) || len(res.Failed) != 1 || res.Failed[0].Step != "async-fail" {
		t.Fatalf("rejected async step = %+v", res)
	}
}

func TestNodeHungOnlyStepTimesOut(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "hung", Run: func(context.Context) error { <-release; return nil }},
	}, 40*time.Millisecond, nil, nil).Run("SIGTERM")
	if !res.TimedOut || len(res.Completed) != 0 || res.ExitCode() != 1 {
		t.Fatalf("hung shutdown must finish non-zero: %+v, exit %d", res, res.ExitCode())
	}
}

func TestNodeQuickStepFinishesInsideItsDeadline(t *testing.T) {
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "quick", Run: func(context.Context) error { time.Sleep(5 * time.Millisecond); return nil }},
	}, 500*time.Millisecond, nil, nil).Run("SIGTERM")
	if res.TimedOut || res.ExitCode() != 0 {
		t.Fatalf("quick shutdown must finish cleanly: %+v", res)
	}
}

func TestNodeFailedStepAloneIsNotAFailedShutdown(t *testing.T) {
	res := lifecycle.NewCoordinator([]lifecycle.Step{
		{Name: "noisy", Run: func(context.Context) error { panic(errors.New("already closed")) }},
	}, 0, nil, nil).Run("SIGTERM")
	if len(res.Failed) != 1 || res.TimedOut || res.ExitCode() != 0 {
		t.Fatalf("a completed failed hook must still exit zero: %+v", res)
	}
}
