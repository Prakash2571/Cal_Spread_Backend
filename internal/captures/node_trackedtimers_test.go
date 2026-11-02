package captures

// Port of tests/box/trackedTimers.test.mjs "clearing an empty registry is a no-op": Go
// has no global interval registry; the capture service owns its schedulers, and Stop is
// clearTrackedIntervals for them (it returns the names it stopped).

import "testing"

func TestNodeClearingAnEmptyRegistryIsANoOp(t *testing.T) {
	logs := &logSink{}
	clk := newFakeClock(istTime("2026-08-04", "09:00"))
	fk := newFakeKite(kiteSpec{Session: new(bool)}) // no Kite session
	svc := New(Deps{Kite: fk, Clock: clk, Logf: logs.logf})
	if got := svc.Intervals(); len(got) != 0 {
		t.Fatalf("a new service tracks %v", got)
	}
	got := svc.Stop() // nothing was started
	if got == nil || len(got) != 0 {
		t.Fatalf("Stop() = %#v, want []string{}", got)
	}
	if again := svc.Stop(); again == nil || len(again) != 0 {
		t.Fatalf("second Stop() = %#v, want []string{}", again)
	}
	if n := len(clk.allTickers()); n != 0 {
		t.Fatalf("%d tickers were created", n)
	}
}
