package synthetic

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// The registry calls into the engine through its hooks (OnBoxLaneTicks → OnTicks,
// OnBoxLaneConnection → InvalidateBooks, StopScanner and OnSessionLost → Stop, the switch's
// InvalidateNamespace and ReloadUniverse), and the engine calls SetTokens =
// reg.SetSyntheticTokens, whose lane feed may deliver queued ticks on the same goroutine.
// These tests make every dependency call back synchronously and prove that nothing
// deadlocks: the engine never holds its mutex while calling a dependency that can call
// back (SetTokens runs from Engine.unlock, I/O without the lock).

// syncStore is an in-memory Store on the production runtime; onCall runs inside every
// call (a callback into the engine).
type syncStore struct {
	mu     sync.Mutex
	rows   map[string]*Trade
	status map[string]string
	seq    int
	onCall func()
}

func newSyncStore() *syncStore {
	return &syncStore{rows: map[string]*Trade{}, status: map[string]string{}}
}

func (s *syncStore) call() {
	if s.onCall != nil {
		s.onCall()
	}
}

func (s *syncStore) Enabled() bool { return true }
func (s *syncStore) NewID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	return fmt.Sprintf("6a%022x", s.seq)
}
func (s *syncStore) EnsureReady(context.Context) error { s.call(); return nil }
func (s *syncStore) Get(_ context.Context, id string) (*StoredTrade, error) {
	s.call()
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.rows[id]
	if t == nil {
		return nil, nil
	}
	c := t.Clone()
	if s.status[id] == "deleted" {
		c.Status = "closed"
		return &StoredTrade{Trade: c, Deleted: true, DeletedFrom: "open"}, nil
	}
	c.Status = s.status[id]
	return &StoredTrade{Trade: c}, nil
}
func (s *syncStore) InsertOpen(_ context.Context, t *Trade) (bool, error) {
	s.call()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, row := range s.rows {
		if s.status[id] == "open" && row.Underlying == t.Underlying {
			return true, nil
		}
	}
	s.rows[t.ID] = t.Clone()
	s.status[t.ID] = "open"
	return false, nil
}
func (s *syncStore) Close(_ context.Context, t *Trade) (bool, error) {
	s.call()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status[t.ID] != "open" {
		return false, nil
	}
	s.rows[t.ID] = t.Clone()
	s.status[t.ID] = "closed"
	return true, nil
}
func (s *syncStore) SetMargin(_ context.Context, id string, p MarginPatch) error {
	s.call()
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.rows[id]; t != nil {
		t.applyMargin(p)
	}
	return nil
}
func (s *syncStore) MarkDeleted(_ context.Context, id, from string, _ DeleteAudit) (bool, error) {
	s.call()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status[id] != from {
		return false, nil
	}
	s.status[id] = "deleted"
	return true, nil
}
func (s *syncStore) list(status string) []*Trade {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []*Trade{}
	for id, t := range s.rows {
		if s.status[id] == status {
			c := t.Clone()
			c.Status = status
			out = append(out, c)
		}
	}
	return out
}
func (s *syncStore) LoadOpen(context.Context) ([]*Trade, error) { s.call(); return s.list("open"), nil }
func (s *syncStore) LoadClosed(context.Context, int, *string) ([]*Trade, error) {
	s.call()
	return s.list("closed"), nil
}
func (s *syncStore) LoadSettings(context.Context) (map[string]float64, error) {
	s.call()
	return map[string]float64{}, nil
}
func (s *syncStore) SaveSettings(context.Context, Settings) error { s.call(); return nil }

// parityBooks are two-sided depth ticks for one underlying's future and options (nearest
// expiry), parity-consistent at F with the ATM call shifted by skew.
func parityBooks(all []market.Instrument, name string, F, skew float64) []market.Tick {
	yes := true
	book := func(token int64, mid float64) market.Tick {
		bid, ask := math.Round((mid-0.25)*100)/100, math.Round((mid+0.25)*100)/100
		return market.Tick{Token: token, LastPrice: mid, Bid: bid, Ask: ask, DepthUpdated: &yes,
			Bids: []market.DepthLevel{{Price: bid, Qty: 5000, Orders: 3}},
			Asks: []market.DepthLevel{{Price: ask, Qty: 5000, Orders: 2}}}
	}
	expiry := ""
	for _, i := range all {
		if i.Name == name && i.InstrumentType == "FUT" && (expiry == "" || i.Expiry < expiry) {
			expiry = i.Expiry
		}
	}
	var out []market.Tick
	for _, i := range all {
		if i.Name != name || i.Expiry != expiry || i.Exchange != "NFO" {
			continue
		}
		switch i.InstrumentType {
		case "FUT":
			out = append(out, book(i.InstrumentToken, F))
		case "CE":
			mid := math.Max(F-i.Strike, 0) + 40
			if math.Abs(i.Strike-F) < 26 {
				mid += skew
			}
			out = append(out, book(i.InstrumentToken, mid))
		case "PE":
			out = append(out, book(i.InstrumentToken, math.Max(F-i.Strike, 0)+40-(F-i.Strike)))
		}
	}
	return out
}

type callbackEnv struct {
	eng     *Engine
	all     []market.Instrument
	board   []BoardItem
	setCnt  atomic.Int64
	enabled atomic.Bool // callbacks armed (off while the engine is being built)
}

func newCallbackEngine(t *testing.T, onSetTokens func(env *callbackEnv, tokens []int64)) *callbackEnv {
	t.Helper()
	g := loadEngineGolden(t)
	env := &callbackEnv{all: g.Universes["kite"], board: g.Board}
	reenter := func() {
		if !env.enabled.Load() {
			return
		}
		e := env.eng
		e.OnTicks(parityBooks(env.all, "NIFTY", 25010, 0))
		e.InvalidateBooks()
		_ = e.GetStatus()
		_ = e.GetOpenPositions()
	}
	store := newSyncStore()
	store.onCall = reenter
	cfg := LoadConfig(config.MapGetter(map[string]string{
		"SYNTH_STRIKE_LEVEL": "1", "SYNTH_EVAL_INTERVAL_MS": "100", "SYNTH_PUBLISH_INTERVAL_MS": "200",
		"SYNTH_SIGNAL_CONFIRMATIONS": "1", "SYNTH_REENTRY_COOLDOWN_MS": "50",
	}))
	env.eng = NewEngine(Deps{
		GetAllInstruments: func(context.Context) ([]market.Instrument, error) {
			reenter()
			return append([]market.Instrument(nil), env.all...), nil
		},
		GetBoard: func(context.Context) ([]BoardItem, error) {
			reenter()
			return append([]BoardItem(nil), env.board...), nil
		},
		MarketData: seededMarket{quotes: futureQuotes(env.all, map[string]float64{"NIFTY": 25010.25, "RELIANCE": 2901.5}), onCall: reenter},
		SetTokens: func(tokens []int64) {
			env.setCnt.Add(1)
			if env.enabled.Load() && onSetTokens != nil {
				onSetTokens(env, tokens)
			}
		},
		Store:        store,
		Margins:      marginCallback{onCall: reenter},
		IsMarketOpen: func() bool { return true }, // the real clock may be outside market hours
		BoxLane:      IdleBoxLane(config.MapGetter(nil)),
		Config:       &cfg,
	})
	env.enabled.Store(true)
	return env
}

// futureQuotes are REST quotes for each named underlying's nearest future.
func futureQuotes(all []market.Instrument, prices map[string]float64) map[string]market.RestQuote {
	nearest := map[string]market.Instrument{}
	for _, i := range all {
		if _, ok := prices[i.Name]; ok && i.InstrumentType == "FUT" {
			if cur, seen := nearest[i.Name]; !seen || i.Expiry < cur.Expiry {
				nearest[i.Name] = i
			}
		}
	}
	out := map[string]market.RestQuote{}
	for name, i := range nearest {
		out[i.Exchange+":"+i.Tradingsymbol] = market.RestQuote{InstrumentToken: i.InstrumentToken, LastPrice: prices[name],
			LastTradeTime: "2026-10-28 09:59:58"}
	}
	return out
}

// seededMarket answers futures prices (to centre the windows) after calling back.
type seededMarket struct {
	quotes map[string]market.RestQuote
	onCall func()
}

func (m seededMarket) IsAuthenticated() bool { return true }
func (m seededMarket) GetQuoteFull(_ context.Context, ids []string) ([]market.RestQuote, error) {
	if m.onCall != nil {
		m.onCall()
	}
	out := []market.RestQuote{}
	for _, id := range ids {
		if q, ok := m.quotes[id]; ok {
			out = append(out, q)
		}
	}
	return out, nil
}

type marginCallback struct{ onCall func() }

func (m marginCallback) Broker() brokers.ID { return brokers.Zerodha }
func (m marginCallback) BasketMargin(context.Context, []market.MarginOrder, bool) (market.BasketMargin, error) {
	if m.onCall != nil {
		m.onCall()
	}
	return market.BasketMargin{Total: 98765, Source: market.MarginKiteBasket}, nil
}

// disposeWithin shuts the engine down without hanging the test binary when an earlier
// failure left it deadlocked.
func disposeWithin(t *testing.T, e *Engine) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.Dispose()
		e.WaitIdle(5 * time.Second)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Error("Dispose is stuck (the engine lock is held by a deadlocked goroutine)")
	}
}

// within runs f and fails the test if it has not returned after d (a deadlock).
func within(t *testing.T, d time.Duration, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("%s did not finish within %v: deadlock", what, d)
	}
}

func TestSetTokensMayCallBackIntoTheEngine(t *testing.T) {
	var nested atomic.Int64
	env := newCallbackEngine(t, func(env *callbackEnv, tokens []int64) {
		// What a lane feed can do on the caller's goroutine: deliver queued ticks, report a
		// reconnect; and what the registry's hooks do.
		e := env.eng
		e.OnTicks(parityBooks(env.all, "NIFTY", 25010, 30))
		e.InvalidateBooks()
		e.YieldToBox(0)
		e.Publish()
		_ = e.GetStatus()
		_ = e.TokenBudget()
		if nested.Add(1) == 3 {
			e.Stop() // queues another SetTokens from inside this one
		}
	})
	e := env.eng
	defer disposeWithin(t, e)
	within(t, 10*time.Second, "Boot + Start with re-entrant dependencies", func() {
		e.Boot()
		if ok, msg := e.Start(); !ok {
			t.Errorf("start: %s", msg)
		}
	})
	within(t, 10*time.Second, "strike-level changes", func() {
		for _, lvl := range []float64{2, 3, 1} {
			if msg := e.SetStrikeLevel(lvl); msg != "" {
				t.Errorf("strike level: %s", msg)
			}
		}
	})
	within(t, 10*time.Second, "Stop from inside SetTokens", func() {
		e.Stop()
		if _, msg := e.Start(); msg != "" {
			t.Errorf("restart: %s", msg)
		}
	})
	within(t, 10*time.Second, "namespace switch", func() {
		e.InvalidateNamespace()
		if err := e.ReloadUniverse(context.Background()); err != nil {
			t.Errorf("reload: %v", err)
		}
	})
	if env.setCnt.Load() < 4 {
		t.Errorf("SetTokens called %d times, want several", env.setCnt.Load())
	}
	if nested.Load() < 3 {
		t.Errorf("the nested Stop never ran (%d SetTokens callbacks)", nested.Load())
	}
}

// Everything at once on the production runtime, under -race: the loop (100 ms), the
// publish timer, a stream, ticks, the registry's hooks, admin routes, entries, exits and
// deletes, with every dependency calling back into the engine.
func TestConcurrentUseWithReentrantDependencies(t *testing.T) {
	env := newCallbackEngine(t, func(env *callbackEnv, _ []int64) {
		env.eng.OnTicks(parityBooks(env.all, "RELIANCE", 2901, 0))
		env.eng.InvalidateBooks()
	})
	e := env.eng
	h := server.New(server.Options{}, func(r chi.Router) { Register(r, e, RouteDeps{Role: testRole}) })
	srv := httptest.NewServer(h)
	defer srv.Close()
	stream, remove := e.addSSEClient()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	worker := func(name string, f func(i int)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				f(i)
			}
		}()
	}
	within(t, 10*time.Second, "boot", func() {
		e.Boot()
		e.Start()
	})
	worker("ticks", func(i int) {
		skew := 0.0 // rich and fair books in blocks of ~150 ms: entries, then exits
		if (i/60)%2 == 0 {
			skew = 30
		}
		e.OnTicks(parityBooks(env.all, "NIFTY", 25010, skew))
		e.OnTicks(parityBooks(env.all, "RELIANCE", 2901, skew/10))
		time.Sleep(2 * time.Millisecond)
	})
	worker("hooks", func(i int) {
		switch i % 40 {
		case 0:
			e.InvalidateBooks()
		case 1:
			e.YieldToBox(float64(i % 50))
		case 2:
			e.Stop()
		case 3:
			e.Start()
		case 4:
			e.InvalidateNamespace()
			_ = e.ReloadUniverse(context.Background())
		case 5:
			e.SetStrikeLevel(float64(1 + i%3))
		case 6:
			e.UpdateSettings(map[string]any{"safety_buffer": float64(i % 200)})
		}
		time.Sleep(5 * time.Millisecond)
	})
	worker("routes", func(i int) {
		paths := []string{"/api/synthetic/status", "/api/synthetic/opportunities?limit=5", "/api/synthetic/trades/open",
			"/api/synthetic/trades/history", "/api/synthetic/chain/NIFTY"}
		req, _ := http.NewRequest("GET", srv.URL+paths[i%len(paths)], nil)
		req.Header.Set("X-Admin-Token", "tok-trade")
		if res, err := srv.Client().Do(req); err == nil {
			res.Body.Close()
		}
		if i%20 == 19 {
			for _, v := range e.GetOpenPositions() {
				if i%40 == 19 {
					e.CloseManually(v.t.ID)
				} else {
					e.DeleteTrade(v.t.ID, nil, "full", "")
				}
			}
		}
	})
	worker("stream", func(int) {
		select {
		case <-stream.notify:
			stream.take()
		case <-time.After(20 * time.Millisecond):
		}
	})
	time.Sleep(2500 * time.Millisecond)
	close(stop)
	within(t, 20*time.Second, "workers to stop", wg.Wait)
	remove()
	within(t, 20*time.Second, "dispose and drain", func() {
		e.Dispose()
		if !e.WaitIdle(15 * time.Second) {
			t.Error("background work still running 15 s after Dispose")
		}
	})
	if env.setCnt.Load() == 0 {
		t.Error("SetTokens was never called")
	}
}
