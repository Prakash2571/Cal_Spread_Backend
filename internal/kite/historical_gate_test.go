package kite

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func waitGate(t *testing.T, g *HistoricalGate, depth int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for g.Queued() != depth {
		if time.Now().After(deadline) {
			t.Fatalf("historical queue = %d, want %d", g.Queued(), depth)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestHistoricalGatePrioritizesInteractiveFIFOAndPacesStarts(t *testing.T) {
	const gap = 15 * time.Millisecond
	g := NewHistoricalGate(gap, 2*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	done := make(chan error, 5)
	go func() { done <- g.Run(ctx, Background, func() error { close(entered); <-release; return nil }) }()
	<-entered
	type started struct {
		name string
		at   time.Time
	}
	starts := make(chan started, 4)
	queue := func(name string, priority HistoricalPriority, depth int) {
		go func() { done <- g.Run(ctx, priority, func() error { starts <- started{name, time.Now()}; return nil }) }()
		waitGate(t, g, depth)
	}
	queue("background-1", Background, 1)
	queue("interactive-1", Interactive, 2)
	queue("interactive-2", Interactive, 3)
	queue("background-2", Background, 4)
	unblock()
	var previous time.Time
	for _, want := range []string{"interactive-1", "interactive-2", "background-1", "background-2"} {
		select {
		case got := <-starts:
			if got.name != want {
				t.Fatalf("historical start = %s, want %s", got.name, want)
			}
			if !previous.IsZero() && got.at.Sub(previous) < gap-time.Millisecond {
				t.Fatalf("historical starts were not paced: %v", got.at.Sub(previous))
			}
			previous = got.at
		case <-ctx.Done():
			t.Fatal("historical queue stalled")
		}
	}
	for n := 0; n < 5; n++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestHistoricalWatchdogDoesNotReleaseTheNextJobsSlot(t *testing.T) {
	g := NewHistoricalGate(time.Millisecond, 100*time.Millisecond)
	firstEntered, secondEntered, thirdEntered := make(chan struct{}), make(chan struct{}), make(chan struct{})
	firstRelease, secondRelease := make(chan struct{}), make(chan struct{})
	var firstOnce, secondOnce sync.Once
	unblockFirst := func() { firstOnce.Do(func() { close(firstRelease) }) }
	unblockSecond := func() { secondOnce.Do(func() { close(secondRelease) }) }
	defer unblockFirst()
	defer unblockSecond()
	done := make(chan error, 3)
	go func() {
		done <- g.Run(context.Background(), Background, func() error { close(firstEntered); <-firstRelease; return nil })
	}()
	<-firstEntered
	go func() {
		done <- g.Run(context.Background(), Interactive, func() error { close(secondEntered); <-secondRelease; return nil })
	}()
	select {
	case <-secondEntered: // watchdog handed over the stalled first request's slot
	case <-time.After(time.Second):
		t.Fatal("historical watchdog did not release a stalled request")
	}
	go func() {
		done <- g.Run(context.Background(), Interactive, func() error { close(thirdEntered); return nil })
	}()
	waitGate(t, g, 1)
	unblockFirst() // its late return must not release the second request's ownership
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case <-thirdEntered:
		t.Error("a completed old request released the newer historical slot")
	case <-time.After(10 * time.Millisecond):
	}
	unblockSecond()
	for n := 0; n < 2; n++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestHistoricalQueuedCancellationDoesNotConsumeTheNextSlot(t *testing.T) {
	g := NewHistoricalGate(time.Millisecond, time.Second)
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	done := make(chan error, 2)
	go func() {
		done <- g.Run(context.Background(), Background, func() error { close(entered); <-release; return nil })
	}()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() {
		canceled <- g.Run(ctx, Interactive, func() error { t.Error("cancelled historical callback ran"); return nil })
	}()
	waitGate(t, g, 1)
	go func() { done <- g.Run(context.Background(), Background, func() error { return nil }) }()
	waitGate(t, g, 2)
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled historical request: %v", err)
	}
	waitGate(t, g, 1)
	close(release)
	for n := 0; n < 2; n++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}
