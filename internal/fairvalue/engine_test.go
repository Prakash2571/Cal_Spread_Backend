package fairvalue

// Ports of the engine and worker cases of tests/fairValue/pipeline.test.mjs and
// hardening.test.mjs, plus worker-pool limits.

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
)

// Node froze published snapshots (Object.isFrozen, TypeError on assignment). Go has no
// freezing; the contract that matters, that later ticks and publications never change
// a published snapshot, is checked through its JSON.
func TestWorkerPublicationImmutableAtomicAndGenerationBound(t *testing.T) {
	f := newEngineFixture(t, fvtest.InputSnapshot(fvtest.InputOptions{}), fixtureOptions{})
	ingest := func() {
		f.engine.IngestTicksAt(bookTicks(f.input.Quotes, false, i64(int64(fvtest.Now-100))), fvtest.Now)
	}
	if err := f.engine.Watch("TEST"); err != nil {
		t.Fatal(err)
	}
	ingest()
	if _, err := f.engine.Refresh("TEST"); err != nil {
		t.Fatal(err)
	}
	result := f.engine.GetSnapshot("TEST").Snapshot
	if result == nil {
		t.Fatal("nothing published")
	}
	for _, q := range f.engine.GetInput("TEST").Quotes {
		if q.ReceiveTimestamp != model.ISOString(fvtest.Now) {
			t.Fatalf("receive timestamp %s", q.ReceiveTimestamp)
		}
	}
	if n := len(f.currentTokens()); n > 600 {
		t.Fatalf("%d tokens", n)
	}
	retained := string(jsjson.Marshal(result))
	ingest()
	if string(jsjson.Marshal(result)) != retained {
		t.Fatal("a published snapshot changed")
	}
	f.engine.Invalidate()
	if f.engine.GetSnapshot("TEST").Snapshot != nil {
		t.Fatal("snapshot survived invalidation")
	}
}

type fakeWorkers struct {
	mu      sync.Mutex
	surface func(*model.InputSnapshot) (*model.SurfaceSnapshot, error)
}

func (w *fakeWorkers) setSurface(fn func(*model.InputSnapshot) (*model.SurfaceSnapshot, error)) {
	w.mu.Lock()
	w.surface = fn
	w.mu.Unlock()
}

func (w *fakeWorkers) Surface(in *model.InputSnapshot) (*model.SurfaceSnapshot, error) {
	w.mu.Lock()
	fn := w.surface
	w.mu.Unlock()
	return fn(in)
}

func (w *fakeWorkers) Calculate(*model.InputSnapshot, *model.SurfaceSnapshot, model.CalculatorRequest) (*model.CalculatorResult, error) {
	return nil, errors.New("unused")
}

func (w *fakeWorkers) Independent(*model.InputSnapshot, string, float64) (*model.IndependentEstimate, error) {
	return nil, errors.New("unused")
}

func (w *fakeWorkers) Stats() WorkerStats { return WorkerStats{} }
func (w *fakeWorkers) Dispose()           {}

func TestStaleWorkerResultDiscardedAndFailuresIsolated(t *testing.T) {
	called := make(chan *model.InputSnapshot, 1)
	release := make(chan *model.SurfaceSnapshot)
	workers := &fakeWorkers{}
	workers.setSurface(func(in *model.InputSnapshot) (*model.SurfaceSnapshot, error) {
		called <- in
		return <-release, nil
	})
	f := newEngineFixture(t, fvtest.InputSnapshot(fvtest.InputOptions{}), fixtureOptions{workers: workers})
	if err := f.engine.Watch("TEST"); err != nil {
		t.Fatal(err)
	}
	f.engine.IngestTicksAt(bookTicks(f.input.Quotes, false, i64(int64(fvtest.Now-100))), fvtest.Now)
	done := make(chan error, 1)
	go func() { _, err := f.engine.Refresh("TEST"); done <- err }()
	captured := <-called
	f.bump()
	f.engine.Invalidate()
	surface := model.BuildSurface(captured)
	release <- &surface
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if f.engine.GetSnapshot("TEST").Snapshot != nil {
		t.Fatal("a result from an old generation was published")
	}
	workers.setSurface(func(*model.InputSnapshot) (*model.SurfaceSnapshot, error) {
		return nil, errors.New("scripted isolated calibration failure")
	})
	if _, err := f.engine.Refresh("TEST"); err != nil {
		t.Fatal(err)
	}
	if last := f.engine.Status().LastError; last == nil || !strings.Contains(*last, "isolated") {
		t.Fatalf("last_error %v", last)
	}
	ran := make(chan struct{})
	go close(ran) // the caller's scheduling continues
	<-ran
}

func TestWorkerPoolTimeoutRejectsOnlyTheJob(t *testing.T) {
	p := NewPool(1, 1, 20*time.Millisecond)
	defer p.Dispose()
	block := make(chan struct{})
	defer close(block)
	errCh := make(chan error, 1)
	go func() { _, err := p.Submit(func() any { <-block; return nil }); errCh <- err }()
	var protective atomic.Bool
	time.AfterFunc(2*time.Millisecond, func() { protective.Store(true) })
	err := <-errCh
	if err == nil || !strings.Contains(err.Error(), "time budget") {
		t.Fatalf("poison job: %v", err)
	}
	if !protective.Load() {
		t.Fatal("other work did not run while the job overran")
	}
	if p.Stats().Failures < 1 {
		t.Fatal("timeout not counted")
	}
	if v, err := p.Submit(func() any { return 42 }); err != nil || v != 42 {
		t.Fatalf("a fresh slot should run the next job: %v %v", v, err)
	}
}

func TestWorkerPoolLimits(t *testing.T) {
	p := NewPool(1, 1, time.Minute)
	block := make(chan struct{})
	started := make(chan struct{})
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() { _, err := p.Submit(func() any { close(started); <-block; return nil }); first <- err }()
	<-started
	go func() { _, err := p.Submit(func() any { return nil }); second <- err }()
	for p.Stats().Queued != 1 {
		time.Sleep(time.Millisecond)
	}
	if _, err := p.Submit(func() any { return nil }); err == nil || err.Error() != "Analytics worker queue is full." {
		t.Fatalf("queue full: %v", err)
	}
	if s := p.Stats(); s.Running != 1 || s.Workers != 1 {
		t.Fatalf("stats %+v", s)
	}
	p.Dispose()
	close(block)
	for _, ch := range []chan error{first, second} {
		if err := <-ch; err == nil || err.Error() != "Analytics workers stopped." {
			t.Fatalf("dispose: %v", err)
		}
	}
	if _, err := p.Submit(func() any { return nil }); err == nil || err.Error() != "Analytics workers disabled/disposed." {
		t.Fatalf("after dispose: %v", err)
	}
	q := NewPool(1, 4, time.Minute)
	defer q.Dispose()
	if _, err := q.Submit(func() any { panic(&model.Error{Message: "model threw"}) }); err == nil || err.Error() != "model threw" {
		t.Fatalf("thrown model error: %v", err)
	}
	if q.Stats().Failures != 1 {
		t.Fatal("failure not counted")
	}
}

type fakeTransport struct {
	t        *testing.T
	ops      []string
	upstream map[int64]bool
}

func (f *fakeTransport) SubscribeTokens(tokens []int64) {
	f.ops = append(f.ops, fmt.Sprint("add", tokens))
	for _, t := range tokens {
		f.upstream[t] = true
	}
	if len(f.upstream) > 4 {
		f.t.Errorf("upstream holds %d tokens", len(f.upstream))
	}
}

func (f *fakeTransport) UnsubscribeTokens(tokens []int64) {
	f.ops = append(f.ops, fmt.Sprint("drop", tokens))
	for _, t := range tokens {
		delete(f.upstream, t)
	}
}

func TestAnalyticsYieldsBeforeProtectiveSubscription(t *testing.T) {
	tr := &fakeTransport{t: t, upstream: map[int64]bool{}}
	c := brokers.NewCoordinator(tr, brokers.LaneFutures)
	c.SetOwnerTokens(brokers.OwnerStrategy, []int64{1, 2})
	c.SetOwnerTokens(brokers.OwnerAnalytics, []int64{1, 3, 4})
	c.SetAnalyticsYield(func(priority map[int64]struct{}) {
		var current []int64
		for _, tok := range c.ActiveTokens() {
			if c.Owns(brokers.OwnerAnalytics, tok) {
				current = append(current, tok)
			}
		}
		keep := []int64{}
		var rest []int64
		for _, tok := range current {
			if _, ok := priority[tok]; ok {
				keep = append(keep, tok)
			} else {
				rest = append(rest, tok)
			}
		}
		spare := 4 - len(priority)
		if spare < 0 {
			spare = 0
		}
		if spare < len(rest) {
			rest = rest[:spare]
		}
		c.SetOwnerTokens(brokers.OwnerAnalytics, append(keep, rest...))
	})
	c.SetOwnerTokens(brokers.OwnerStrategy, []int64{1, 2, 5, 6})
	if len(tr.upstream) != 4 || !tr.upstream[1] || !tr.upstream[2] || !tr.upstream[5] || !tr.upstream[6] {
		t.Fatalf("upstream %v", tr.upstream)
	}
	if !c.Owns(brokers.OwnerAnalytics, 1) {
		t.Fatal("shared token evicted from analytics")
	}
	drop, add := -1, -1
	for i, op := range tr.ops {
		if drop < 0 && strings.HasPrefix(op, "drop") && strings.Contains(op, "3") {
			drop = i
		}
		if add < 0 && strings.HasPrefix(op, "add") && strings.Contains(op, "5") {
			add = i
		}
	}
	if !(drop >= 0 && drop < add) {
		t.Fatalf("analytics must yield before the protective subscribe: %v", tr.ops)
	}
}

func TestFanoutRetentionNeverOpensKite(t *testing.T) {
	calls := 0
	h := hub.New(hub.Deps{Creds: func() hub.Creds { calls++; panic("Kite must not be opened") }, OnDead: func() {}})
	release := h.RetainFanout()
	if calls != 0 {
		t.Fatal("credentials read")
	}
	release()
	release()
	if calls != 0 {
		t.Fatal("credentials read on release")
	}
}

type blockingService struct {
	fakeService
	started chan struct{}
	finish  chan struct{}
}

func (s *blockingService) History(string, float64) ([]model.HistorySummary, error) {
	close(s.started)
	<-s.finish
	return []model.HistorySummary{}, nil
}

func TestRoleRevokedDuringAsyncAnalyticsReturns403(t *testing.T) {
	var role atomic.Value
	role.Store("full")
	svc := &blockingService{started: make(chan struct{}), finish: make(chan struct{})}
	origin := newTestServer(t, svc, func(token string) bool { return token == "full" && role.Load() == "full" }, RouteDeps{})
	resCh := make(chan *http.Response, 1)
	go func() { resCh <- request(t, "GET", origin+"/history/TEST", "full", "") }()
	<-svc.started
	role.Store("")
	close(svc.finish)
	res := decode(t, <-resCh)
	if res.status != 403 || string(jsjson.Marshal(res.data)) != `{"error":"Full admin access required."}` {
		t.Fatalf("%d %s", res.status, jsjson.Marshal(res.data))
	}
}

func TestRecentSnapshotAddressableAcrossPublication(t *testing.T) {
	input := fvtest.InputSnapshot(fvtest.InputOptions{})
	f := newEngineFixture(t, input, fixtureOptions{broker: "dhan", metadataVersion: "test", boardName: "Test"})
	ingest := func() { f.engine.IngestTicksAt(bookTicks(input.Quotes, false, nil), f.getNow()) }
	if err := f.engine.Watch("TEST"); err != nil {
		t.Fatal(err)
	}
	ingest()
	if _, err := f.engine.Refresh("TEST"); err != nil {
		t.Fatal(err)
	}
	first := f.engine.GetSnapshot("TEST").Snapshot
	f.advance(100)
	ingest()
	if _, err := f.engine.Refresh("TEST"); err != nil {
		t.Fatal(err)
	}
	if first.InputSnapshotID == f.engine.GetSnapshot("TEST").Snapshot.InputSnapshotID {
		t.Fatal("a new publication should have a new input id")
	}
	req := jsjson.NewObjectValue()
	req.Set("underlying", "TEST")
	req.Set("expiry", first.Slices[0].Expiry)
	req.Set("strike", 100.0)
	req.Set("input_snapshot_id", first.InputSnapshotID)
	independent, err := f.engine.Independent(req)
	if err != nil || independent.InputSnapshotID != first.InputSnapshotID || independent.Status != "available" {
		t.Fatalf("independent on the retained snapshot: %v %+v", err, independent)
	}
	for _, q := range f.engine.GetInput("TEST").Quotes {
		if q.ExchangeTimestamp != nil {
			t.Fatal("exchange timestamp invented")
		}
	}
	f.bump()
	if f.engine.GetSnapshot("TEST").Snapshot != nil || len(f.engine.Status().WatchedUnderlyings) != 0 || len(f.currentTokens()) != 0 {
		t.Fatal("namespace change kept private state")
	}
}

func TestHistoryByteCountAndAgeCeilings(t *testing.T) {
	input := fvtest.InputSnapshot(fvtest.InputOptions{})
	base := model.BuildSurface(input)
	bytes := len(jsjson.Marshal(&base))
	now := fvtest.Now
	h := NewSnapshotHistory(bytes*2+100, 2, func() float64 { return now })
	for i := 0; i < 20; i++ {
		s := base
		s.ID = fmt.Sprintf("history-%d", i)
		s.PublishedAt = model.ISOString(fvtest.Now + float64(i))
		h.Add(&s, 100, 1)
	}
	if st := h.Stats(); st.Snapshots > 2 || st.Bytes > float64(bytes*2+100) {
		t.Fatalf("stats %+v", st)
	}
	now += 2 * 86400000
	if n := len(h.List("TEST", 1)); n != 0 {
		t.Fatalf("%d snapshots beyond retention", n)
	}
}
