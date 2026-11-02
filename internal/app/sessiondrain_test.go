package app

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
)

func TestShutdownDrainsPendingAdminSessionBeforeClosingPostgres(t *testing.T) {
	h := newHarness(t, harnessOptions{db: true})
	entered, release, drained := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	h.app.sessions.SetBackground(func(f func()) {
		go func() {
			close(entered)
			<-release
			f()
			close(drained)
		}()
	})
	h.fullToken()
	<-entered
	writes, database := make(chan struct{}), make(chan struct{})
	h.app.trace = func(event string) {
		h.trace.add(event)
		if event == "shutdown: "+stepWrites {
			close(writes)
		}
		if event == "shutdown: "+stepDatabase {
			close(database)
		}
	}
	h.shutDown = true
	done := make(chan lifecycle.Result, 1)
	go func() { done <- h.app.Shutdown(context.Background(), "session-drain-test") }()
	select {
	case <-writes:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown never reached the background-write drain")
	}
	select {
	case <-database:
		t.Error("PostgreSQL closed while the admin-session persistence job was still pending")
	case <-time.After(100 * time.Millisecond):
	}
	unblock()
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("pending admin-session job did not finish")
	}
	select {
	case result := <-done:
		if result.TimedOut || len(result.Failed) != 0 {
			t.Fatalf("shutdown result: %+v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish after the session write")
	}
	if err := <-h.served; err != http.ErrServerClosed {
		t.Fatalf("Serve returned %v", err)
	}
	h.closeIdle()
}
