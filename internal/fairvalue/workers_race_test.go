package fairvalue

import (
	"testing"
	"time"
)

// A timer callback can already be runnable when finish stops its timer. If it
// was waiting for the pool lock, the slot may hold the NEXT job when it runs.
func TestRetiredJobTimeoutCannotRejectTheNextJobOnItsReusedSlot(t *testing.T) {
	pool := NewPool(1, 4, time.Hour)
	defer pool.Dispose()
	firstStarted, firstRelease := make(chan struct{}), make(chan struct{})
	firstResult := make(chan error, 1)
	go func() {
		_, err := pool.Submit(func() any { close(firstStarted); <-firstRelease; return 1 })
		firstResult <- err
	}()
	<-firstStarted
	pool.mu.Lock()
	slot, oldJob := pool.slots[0], pool.slots[0].job
	pool.mu.Unlock()
	close(firstRelease)
	if err := <-firstResult; err != nil {
		t.Fatal(err)
	}

	secondStarted, secondRelease := make(chan struct{}), make(chan struct{})
	defer close(secondRelease)
	secondResult := make(chan error, 1)
	go func() {
		_, err := pool.Submit(func() any { close(secondStarted); <-secondRelease; return 2 })
		secondResult <- err
	}()
	<-secondStarted
	pool.mu.Lock()
	reused := len(pool.slots) == 1 && pool.slots[0] == slot && slot.job != oldJob
	pool.mu.Unlock()
	if !reused {
		t.Fatal("the next job did not reuse the original slot")
	}

	// Deliver the first job's stale callback after the slot was reused.
	pool.failSlot(slot, oldJob, errTimeBudget)
	if got := pool.Stats(); got.Failures != 0 || got.Running != 1 {
		t.Fatalf("the stale timeout rejected a fresh job: %+v", got)
	}
	select {
	case err := <-secondResult:
		t.Fatalf("the new job settled before its release: %v", err)
	default:
	}
}
