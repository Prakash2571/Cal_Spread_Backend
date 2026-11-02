package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	fjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

func ptr[T any](v T) *T { return &v }

// stubKite is a minimal KiteClient.
type stubKite struct {
	mu    sync.Mutex
	token *string
}

func (k *stubKite) LoginURL() string { return "https://kite.example/connect/login?api_key=k&v=3" }
func (k *stubKite) GenerateSession(context.Context, string) (kite.SessionData, error) {
	return kite.SessionData{}, &kite.KiteError{Status: 403, Message: "no"}
}
func (k *stubKite) SetAccessToken(t string) { k.mu.Lock(); k.token = &t; k.mu.Unlock() }
func (k *stubKite) HasSession() bool        { k.mu.Lock(); defer k.mu.Unlock(); return k.token != nil }
func (k *stubKite) APIKey() string          { return "k" }
func (k *stubKite) AccessToken() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.token == nil {
		return ""
	}
	return *k.token
}
func (k *stubKite) ClearSession() { k.mu.Lock(); k.token = nil; k.mu.Unlock() }
func (k *stubKite) GetProfile(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"user_id":"X"}`), nil
}

func board3(symbol string, base int64) []market.Instrument {
	rows := []market.Instrument{{InstrumentToken: base, Tradingsymbol: symbol, Name: symbol + " LTD", Exchange: "NSE", Segment: "NSE", InstrumentType: "EQ"}}
	for m, exp := range []string{"2026-10-27", "2026-11-24", "2026-12-29"} {
		rows = append(rows, market.Instrument{InstrumentToken: base + int64(m) + 1, Tradingsymbol: fmt.Sprintf("%sF%d", symbol, m), Name: symbol,
			Expiry: exp, LotSize: 50, Exchange: "NFO", Segment: "NFO-FUT", InstrumentType: "FUT"})
	}
	return rows
}

type routeFixture struct {
	core    *Core
	handler http.Handler
	clk     *testClock
	ready   atomic.Bool
	calls   atomic.Int64
	kite    *stubKite
}

func newRouteFixture(t *testing.T, mutate func(*Deps)) *routeFixture {
	f := &routeFixture{clk: &testClock{t: istTime(2026, 10, 27, 11, 0)}, kite: &stubKite{}}
	d := Deps{
		Kite:     f.kite,
		Sessions: auth.NewSessions(nil, nil),
		ActiveHealth: func() Health {
			if f.ready.Load() {
				return Health{Authenticated: true, DataReady: true, TradingReady: true}
			}
			return Health{Problems: []string{"Zerodha is not connected"}}
		},
		Instruments: func(context.Context) ([]market.Instrument, error) { return board3("ACME", 100), nil },
		HistoricalOi: func(_ context.Context, token int64, from, to string) ([]kite.DayOI, error) {
			f.calls.Add(1)
			return []kite.DayOI{{Date: to, Close: float64(token), OI: 1}}, nil
		},
		Historical: func(_ context.Context, token int64, from, to, interval string) ([]kite.ClosePoint, error) {
			f.calls.Add(1)
			return []kite.ClosePoint{{T: to, Close: float64(token)}}, nil
		},
		Now:   f.clk.now,
		Sleep: func(context.Context, time.Duration) error { return nil },
		Logf:  t.Logf,
	}
	if mutate != nil {
		mutate(&d)
	}
	c, err := New(d)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Dispose)
	f.core = c
	f.handler = server.New(server.Options{FrontendOrigin: "http://f", Now: f.clk.now}, c.Mount)
	return f
}

func (f *routeFixture) get(t *testing.T, target string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
	return w
}

// The market-data check runs before the cache: a cached chart is not served once the
// active broker loses its session. The caches are keyed by symbol only.
func TestHistoryRoutesCheckMarketDataBeforeTheCache(t *testing.T) {
	f := newRouteFixture(t, nil)
	routes := []string{"/api/history/ACME", "/api/spread-history/ACME", "/api/intraday/ACME", "/api/minute/ACME", "/api/fivemin/ACME"}
	for _, r := range routes {
		if w := f.get(t, r); w.Code != 401 ||
			w.Body.String() != `{"error":"Historical data requires a Zerodha session. Connect Zerodha.","broker":"zerodha","problems":["Zerodha is not connected"]}` {
			t.Fatalf("%s before login: %d %s", r, w.Code, w.Body)
		}
	}
	if f.calls.Load() != 0 {
		t.Fatal("a refused request reached the history provider")
	}
	f.ready.Store(true)
	bodies := map[string]string{}
	for _, r := range routes {
		w := f.get(t, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", r, w.Code, w.Body)
		}
		bodies[r] = w.Body.String()
	}
	fetched := f.calls.Load()
	if fetched != 5*3 {
		t.Fatalf("provider calls = %d, want 15 (3 futures x 5 routes)", fetched)
	}
	for _, r := range routes { // cached, also under another case of the symbol
		if w := f.get(t, strings.ToLower(r)); w.Code != 200 || w.Body.String() != bodies[r] {
			t.Fatalf("%s cached: %d %s", r, w.Code, w.Body)
		}
	}
	if f.calls.Load() != fetched {
		t.Fatal("a cached chart was fetched again")
	}
	f.ready.Store(false)
	for _, r := range routes {
		if w := f.get(t, r); w.Code != 401 {
			t.Fatalf("%s with a cached body but no session: %d", r, w.Code)
		}
	}
	// TTLs: the minute chart expires after 60 s, five-minute after 5 min, the day charts at
	// the IST day boundary.
	f.ready.Store(true)
	f.clk.set(f.clk.now().Add(time.Minute))
	f.get(t, "/api/minute/ACME")
	f.get(t, "/api/fivemin/ACME")
	f.get(t, "/api/history/ACME")
	if got := f.calls.Load() - fetched; got != 3 {
		t.Fatalf("after 60 s %d calls, want 3 (minute only)", got)
	}
}

// Route work is not tied to the client connection (Node kept running and cached the
// result; a Kite request token is single-use), but it ends on Dispose.
func TestRouteWorkOutlivesTheClientButNotDispose(t *testing.T) {
	block := make(chan struct{})
	var sawLiveCtx atomic.Bool
	f := newRouteFixture(t, func(d *Deps) {
		d.HistoricalOi = func(ctx context.Context, token int64, from, to string) ([]kite.DayOI, error) {
			sawLiveCtx.Store(ctx.Err() == nil)
			select {
			case <-block:
				return nil, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	})
	f.ready.Store(true)

	gone, cancel := context.WithCancel(context.Background())
	cancel() // the client has already gone away
	close(block)
	r := httptest.NewRequest("GET", "/api/history/ACME", nil).WithContext(gone)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != 200 || !sawLiveCtx.Load() {
		t.Fatalf("work was cancelled with the client: %d %s", w.Code, w.Body)
	}

	stuck := newRouteFixture(t, func(d *Deps) {
		d.Historical = func(ctx context.Context, _ int64, _, _, _ string) ([]kite.ClosePoint, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}
	})
	stuck.ready.Store(true)
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- stuck.get(t, "/api/intraday/ACME") }()
	time.Sleep(20 * time.Millisecond)
	stuck.core.Dispose()
	select {
	case w := <-done:
		if w.Code != 500 || w.Body.String() != `{"error":"context canceled"}` {
			t.Fatalf("after Dispose: %d %s", w.Code, w.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Dispose did not end the in-flight request")
	}
}

func TestDefaultsWithoutCollaborators(t *testing.T) {
	k := &stubKite{}
	c, err := New(Deps{Kite: k, Sessions: auth.NewSessions(nil, nil)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Dispose)
	h := server.New(server.Options{FrontendOrigin: "http://f"}, c.Mount)
	get := func(target string) string {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		return fmt.Sprintf("%d %s", w.Code, w.Body)
	}
	cases := []struct{ target, want string }{
		{"/api/status", `200 {"status":"ok","authenticated":false,"broker":"zerodha","broker_authenticated":false,"market_data_ready":false,"feed_connected":false,"feed_state":"DOWN","trading_ready":false,"problems":["Zerodha is not connected"],"generation":0,"zerodha_session":false}`},
		{"/api/fno-board", `200 {"count":0,"board":[]}`},
		{"/api/fno-stocks", `200 {"count":0,"instruments":[]}`},
		{"/api/instruments", `200 {"count":0,"instruments":[]}`},
		{"/api/spread-stats/ACME", `500 {"error":"database is not configured (set DATABASE_URL)"}`},
		{"/api/dividends", ""}, // checked by prefix below: cachedAt is the wall clock
		{"/api/rf/current", `200 {"rf":null}`},
	}
	for _, c := range cases {
		got := get(c.target)
		if c.target == "/api/dividends" {
			if !strings.HasPrefix(got, `200 {"yields":{},"cachedAt":`) {
				t.Errorf("%s = %s", c.target, got)
			}
			continue
		}
		if got != c.want {
			t.Errorf("%s\n got %s\nwant %s", c.target, got, c.want)
		}
	}
	k.SetAccessToken("t")
	if got := get("/api/status"); !strings.Contains(got, `"authenticated":true`) || !strings.Contains(got, `"feed_state":"DOWN"`) ||
		!strings.Contains(got, `"problems":[]`) {
		t.Errorf("status with a Kite session: %s", got)
	}
	if got := get("/api/history/ACME"); got != `404 {"error":"No F&O instrument found for \"ACME\"."}` {
		t.Errorf("history without instruments: %s", got)
	}
	if _, err := New(Deps{Sessions: auth.NewSessions(nil, nil)}); err == nil {
		t.Error("New without Kite must fail")
	}
	if _, err := New(Deps{Kite: k}); err == nil {
		t.Error("New without Sessions must fail")
	}
}

func TestHistoryWithoutAProviderIs500(t *testing.T) {
	f := newRouteFixture(t, func(d *Deps) { d.HistoricalOi, d.Historical = nil, nil })
	f.ready.Store(true)
	if w := f.get(t, "/api/history/ACME"); w.Code != 500 || w.Body.String() != `{"error":"history provider is not configured"}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestDhanRefusalAndExportedHelpers(t *testing.T) {
	f := newRouteFixture(t, func(d *Deps) {
		d.ActiveBroker = func() brokers.ID { return brokers.Dhan }
		d.ActiveHealth = func() Health { return Health{} }
	})
	w := httptest.NewRecorder()
	if f.core.RequireMarketData(w, "Taking a trade") {
		t.Fatal("not ready")
	}
	if w.Code != 401 || w.Body.String() != `{"error":"Taking a trade requires a Dhan session. Connect Dhan.","broker":"dhan","problems":[]}` {
		t.Fatalf("%d %s", w.Code, w.Body)
	}

	cleared := 0
	g := newRouteFixture(t, func(d *Deps) { d.OnKiteSessionCleared = func() { cleared++ } })
	g.kite.SetAccessToken("t")
	for _, c := range []struct {
		err   error
		code  int
		body  string
		clear bool
	}{
		{&kite.KiteError{Status: 429, Message: "Too many requests"}, 429, `{"error":"Too many requests"}`, false},
		{fmt.Errorf("wrapped: %w", &kite.KiteError{Status: 403, Message: "Forbidden"}), 403, `{"error":"Forbidden"}`, true},
		{errors.New("boom"), 500, `{"error":"boom"}`, false},
		{nil, 500, `{"error":"Unknown error"}`, false},
	} {
		g.kite.SetAccessToken("t")
		cleared = 0
		w := httptest.NewRecorder()
		g.core.SendError(w, c.err)
		g.core.queue.wait()
		if w.Code != c.code || w.Body.String() != c.body || (cleared == 1) != c.clear || g.kite.HasSession() == c.clear {
			t.Errorf("SendError(%v) = %d %s cleared=%d session=%v", c.err, w.Code, w.Body, cleared, g.kite.HasSession())
		}
	}

	board, err := f.core.Board(context.Background())
	if err != nil || len(board) != 1 || board[0].Symbol != "ACME" || len(board[0].Futures) != 3 || board[0].SpotToken != 100 {
		t.Fatalf("Board = %+v %v", board, err)
	}
	if f.core.RfPct() != nil {
		t.Fatal("rf before any POST")
	}
}

// Dhan rows keep their broker-native fields in /api/instruments and /api/fno-stocks
// (InstrumentsWire), with fno_lot_size after them.
func TestWireRowsKeepBrokerFields(t *testing.T) {
	type dhanExtra struct {
		market.Instrument
		DhanSecurityID int64   `json:"dhan_security_id"`
		DhanSegment    string  `json:"dhan_segment"`
		Underlying     *int64  `json:"dhan_underlying_security_id"`
		Ignored        float64 `json:"-"`
	}
	rows := board3("ACME", 1_000_000_100)
	f := newRouteFixture(t, func(d *Deps) {
		d.Instruments = func(context.Context) ([]market.Instrument, error) { return rows, nil }
		d.InstrumentsWire = func(context.Context) ([]WireRow, error) {
			out := make([]WireRow, len(rows))
			for i, r := range rows {
				x := dhanExtra{Instrument: r, DhanSecurityID: r.InstrumentToken - 1_000_000_000, DhanSegment: "NSE_EQ"}
				out[i] = WireRow{Instrument: r, JSON: fjson.RawObject(func(dst []byte) []byte { return fjson.Append(dst, x) })}
			}
			return out, nil
		}
	})
	w := f.get(t, "/api/fno-stocks")
	want := `{"count":1,"instruments":[{"instrument_token":1000000100,"exchange_token":0,"tradingsymbol":"ACME","name":"ACME LTD","last_price":0,"expiry":"","strike":0,"tick_size":0,"lot_size":0,"instrument_type":"EQ","segment":"NSE","exchange":"NSE","dhan_security_id":100,"dhan_segment":"NSE_EQ","dhan_underlying_security_id":null,"fno_lot_size":50}]}`
	if w.Body.String() != want {
		t.Fatalf("fno-stocks\n got %s\nwant %s", w.Body, want)
	}
	if w := f.get(t, "/api/instruments?type=FUT&exchange=NFO"); !strings.Contains(w.Body.String(), `"count":3`) ||
		!strings.Contains(w.Body.String(), `"exchange":"NFO","dhan_security_id":101,"dhan_segment":"NSE_EQ"`) {
		t.Fatalf("instruments: %s", w.Body)
	}
	if got := string(appendRow(nil, WireRow{JSON: fjson.RawObject(func(d []byte) []byte { return append(d, "{}"...) })}, ptr(5.0))); got != `{"fno_lot_size":5}` {
		t.Fatalf("lot after an empty object: %s", got)
	}
}

func TestSerialQueueRunsInOrderAndSurvivesPanics(t *testing.T) {
	q := newSerialQueue()
	var mu sync.Mutex
	var got []int
	for i := 0; i < 50; i++ {
		i := i
		q.push(func() {
			if i == 10 {
				panic("boom")
			}
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
		})
	}
	q.wait()
	if len(got) != 49 {
		t.Fatalf("ran %d tasks", len(got))
	}
	for k := 1; k < len(got); k++ {
		if got[k] <= got[k-1] {
			t.Fatalf("out of order: %v", got)
		}
	}
	q.wait() // idle: returns at once
}

// Parallel traffic on every stateful route (rf, caches, Kite session, dividends) is
// race-free.
func TestConcurrentRequestsAreRaceFree(t *testing.T) {
	sessions := auth.NewSessions(nil, nil)
	full := sessions.Mint(auth.RoleFull)
	f := newRouteFixture(t, func(d *Deps) { d.Sessions = sessions })
	f.ready.Store(true)
	var wg sync.WaitGroup
	var served, failed atomic.Int64
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				ip := fmt.Sprintf("10.0.%d.%d", g, i) // one limiter bucket per round
				send := func(r *http.Request) {
					r.Header.Set("X-Forwarded-For", ip)
					w := httptest.NewRecorder()
					f.handler.ServeHTTP(w, r)
					if served.Add(1); w.Code != 200 {
						failed.Add(1)
					}
				}
				for _, target := range []string{"/api/history/ACME", "/api/minute/ACME", "/api/rf/current", "/api/status", "/api/dividends", "/api/fno-board", "/"} {
					send(httptest.NewRequest("GET", target, nil))
				}
				r := httptest.NewRequest("POST", "/api/rf", strings.NewReader(fmt.Sprintf(`{"rf":%d}`, g*100+i)))
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("x-admin-token", full)
				send(r)
				lo := httptest.NewRequest("POST", "/api/logout", nil)
				lo.Header.Set("x-admin-token", full)
				send(lo)
				f.kite.SetAccessToken("t")
				f.clk.set(f.clk.now().Add(time.Second))
			}
		}(g)
	}
	wg.Wait()
	if served.Load() != 8*20*9 || failed.Load() != 0 {
		t.Fatalf("served %d requests, %d not 200", served.Load(), failed.Load())
	}
	if f.core.RfPct() == nil {
		t.Fatal("no rf after the POSTs")
	}
}

// :symbol decodes the same whether chi matched the escaped or the decoded path: at the
// root, under a sub-router, and after the trailing-slash rewrite.
func TestPathParamIndependentOfMounting(t *testing.T) {
	var got string
	var ok bool
	h := func(w http.ResponseWriter, r *http.Request) { got, _, ok = pathParam(r, "symbol") }
	root := chi.NewRouter()
	root.Use(chimw.StripSlashes)
	root.Get("/api/history/{symbol}", h)
	root.Route("/sub", func(r chi.Router) { r.Get("/history/{symbol}", h) })
	for _, c := range []struct{ target, want string }{
		{"/api/history/M%26M", "M&M"},
		{"/api/history/M%26M/", "M&M"},
		{"/api/history/M&M", "M&M"},
		{"/api/history/A%2525", "A%25"},
		{"/api/history/A%2525/", "A%25"},
		{"/api/history/M%2FM", "M/M"},
		{"/api/history/a+b", "a+b"},
		{"/sub/history/M%26M", "M&M"},
		{"/sub/history/J%26KBANK/", "J&KBANK"},
	} {
		got, ok = "", false
		w := httptest.NewRecorder()
		root.ServeHTTP(w, httptest.NewRequest("GET", c.target, nil))
		if w.Code != 200 || !ok || got != c.want {
			t.Errorf("%s: %d %q ok=%v, want %q", c.target, w.Code, got, ok, c.want)
		}
	}
}
