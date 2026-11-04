package analytics

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kv"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func brokerUniverse(t *testing.T, broker brokers.ID) []market.Instrument {
	t.Helper()
	rows := append([]market.Instrument(nil), goldenUniverse(t, "small")...)
	if broker == brokers.Dhan {
		for i := range rows {
			rows[i].InstrumentToken = 2_000_030_000 + int64(i)
			if rows[i].Segment == "INDICES" {
				rows[i].InstrumentToken = 13
			}
		}
	}
	return rows
}

func TestDhanHistoryPersistsInItsOwnNamespaceAcrossSwitchAndRestart(t *testing.T) {
	pool := dbtest.New(t)
	ctx := context.Background()
	clock := &testClock{}
	clock.set(istT(2026, 10, 27, 9, 58, 57))
	cache := kv.New(pool, clock.now)
	var namespace atomic.Pointer[brokers.Namespace]
	namespace.Store(&brokers.Namespace{Broker: brokers.Dhan, Generation: 1})
	dhanRows, kiteRows := brokerUniverse(t, brokers.Dhan), brokerUniverse(t, brokers.Zerodha)
	rows := func() []market.Instrument {
		if namespace.Load().Broker == brokers.Dhan {
			return dhanRows
		}
		return kiteRows
	}
	deps := func() Deps {
		return Deps{Namespace: func() brokers.Namespace { return *namespace.Load() }, CaptureAllowed: allow,
			Instruments: func(context.Context) ([]market.Instrument, error) { return rows(), nil },
			QuoteFull: func(ctx context.Context, ids []string) ([]kite.FullQuote, error) {
				return syntheticQuotes(rows(), clock, nil)(ctx, ids)
			}, Cache: cache, Now: clock.now, AfterFunc: (&fakeTimers{}).afterFunc,
			Sleep: func(context.Context, time.Duration) error { return nil }, Logf: t.Logf}
	}
	a := New(deps())
	seedBaseline := func(s *Service) {
		s.mu.Lock()
		s.prevClose = &PrevClose{ForDay: "2026-10-27", ClosedOn: "2026-10-26", Expiry: "2026-10-27", Complete: true,
			Order: []int64{rows()[1].InstrumentToken}, Tokens: map[int64]OiLtp{rows()[1].InstrumentToken: {OI: 100, LTP: 10}}}
		s.persistPrevCloseLocked()
		s.mu.Unlock()
		s.wg.Wait()
	}
	seedBaseline(a)
	for _, minute := range []int{58, 59, 60, 61, 62} {
		clock.set(istT(2026, 10, 27, 9, minute, 57))
		a.captureOptionOi(ctx)
		a.captureFuturesOi(ctx)
	}
	lastCapture := clock.ms.Load()
	clock.set(istT(2026, 10, 27, 10, 3, 0))
	wantDhan := frameJSON(a, lastCapture)
	a.mu.Lock()
	wantSnapshots := js(a.chainMin)
	a.mu.Unlock()
	// Switch before flushing the closing frames: their queued keys must remain
	// Dhan-owned even while the in-memory view has already become Zerodha's.
	a.InvalidateNamespace()
	namespace.Store(&brokers.Namespace{Broker: brokers.Zerodha, Generation: 2})
	a.syncNamespace()
	if err := a.FlushNow(ctx); err != nil {
		t.Fatal(err)
	}
	zero := New(deps())
	zero.WarmLoad(ctx)
	zero.mu.Lock()
	if len(zero.oiFrames[0]) != 0 || len(zero.chainMin) != 0 || zero.prevClose != nil || len(zero.futContracts) != 0 {
		t.Fatal("Zerodha restored Dhan's token/history namespace")
	}
	zero.mu.Unlock()
	seedBaseline(a)
	a.captureOptionOi(ctx)
	a.captureFuturesOi(ctx)
	a.flush()
	namespace.Store(&brokers.Namespace{Broker: brokers.Dhan, Generation: 9})
	restarted := New(deps())
	restarted.WarmLoad(ctx)
	if got := frameJSON(restarted, lastCapture); got != wantDhan {
		t.Fatal("Dhan frames changed through switch/restart or inherited Zerodha data")
	}
	restarted.mu.Lock()
	if js(restarted.chainMin) != wantSnapshots || restarted.prevClose == nil || len(restarted.prevClose.Order) != 1 || restarted.prevClose.Order[0] != dhanRows[1].InstrumentToken {
		t.Fatal("Dhan snapshots or previous-close tokens did not restore in their own namespace")
	}
	restarted.mu.Unlock()
	var dhanKeys, zerodhaKeys int
	if err := pool.QueryRow(ctx, `select count(*) from kv_keys where key like 'calspread:analytics:dhan:%'`).Scan(&dhanKeys); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from kv_keys where key like 'calspread:oiframe:%'`).Scan(&zerodhaKeys); err != nil {
		t.Fatal(err)
	}
	if dhanKeys == 0 || zerodhaKeys == 0 {
		t.Fatal("both broker histories were not persisted independently")
	}
}

func TestDelayedDhanQuoteCannotWriteAfterNamespaceSwitch(t *testing.T) {
	clock := &testClock{}
	clock.set(istT(2026, 10, 27, 10, 5, 57))
	var namespace atomic.Pointer[brokers.Namespace]
	namespace.Store(&brokers.Namespace{Broker: brokers.Dhan, Generation: 1})
	universe := brokerUniverse(t, brokers.Dhan)
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	cache := newFakeCache(func() int64 { return clock.ms.Load() }, nil)
	s := New(Deps{Namespace: func() brokers.Namespace { return *namespace.Load() }, CaptureAllowed: allow,
		Instruments: func(context.Context) ([]market.Instrument, error) { return universe, nil },
		QuoteFull: func(ctx context.Context, ids []string) ([]kite.FullQuote, error) {
			close(started)
			<-release
			// Simulate a transport that returns its old response despite cancellation.
			return syntheticQuotes(universe, clock, nil)(context.Background(), ids)
		}, Cache: cache, Now: clock.now, Logf: t.Logf})
	go func() { defer close(finished); s.captureOptionOi(context.Background()) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("Dhan quote did not start")
	}
	s.InvalidateNamespace()
	namespace.Store(&brokers.Namespace{Broker: brokers.Zerodha, Generation: 2})
	router := chi.NewRouter()
	s.Mount(router)
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("superseded quote did not finish")
	}
	s.syncNamespace()
	s.flush()
	s.mu.Lock()
	if s.day != nil || len(s.chainMin) > 0 || len(s.oiFrames[0]) > 0 {
		t.Fatal("delayed old-broker quote populated the incoming namespace")
	}
	s.mu.Unlock()
	if len(cache.dump()) != 0 {
		t.Fatal("delayed old-broker response wrote persisted history")
	}
	response := get(router, "/api/option-oi-frame/NIFTY?frame=1m")
	var frames struct{ Points []json.RawMessage }
	if json.Unmarshal(response.Body.Bytes(), &frames) != nil || len(frames.Points) != 0 {
		t.Fatal("old token history leaked through the public frame endpoint")
	}
}
