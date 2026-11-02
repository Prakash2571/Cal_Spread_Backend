package marketdata

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// Focused tests for what the golden replay cannot show: real keep-alive timers, the hub
// dropping a slow client, real admin sessions, cancellation, panics and concurrency.
// Expected statuses and bodies are taken from src/marketDataRoutes.ts.

// eventLog records dependency calls in order.
type eventLog struct {
	mu     sync.Mutex
	events []string
}

func (l *eventLog) add(e string) {
	l.mu.Lock()
	l.events = append(l.events, e)
	l.mu.Unlock()
}

func (l *eventLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

func (l *eventLog) count(e string) int {
	n := 0
	for _, v := range l.all() {
		if v == e {
			n++
		}
	}
	return n
}

// loggingHub records attach/detach around a real hub.
type loggingHub struct {
	h   *hub.Hub
	log *eventLog
	// atDetach runs just before the real detach (ordering checks).
	atDetach func()
}

func (x *loggingHub) AttachClient(c hub.Client, tokens []int64) func() {
	x.log.add("attach")
	d := x.h.AttachClient(c, tokens)
	return func() {
		x.log.add("detach")
		if x.atDetach != nil {
			x.atDetach()
		}
		d()
	}
}

func (x *loggingHub) Seed(ticks []market.Tick) { x.log.add("seed"); x.h.Seed(ticks) }

// testDeps is a ready Zerodha broker at generation 1 with every token owned.
func testDeps(h Hub, store Sessions, log *eventLog) RouteDeps {
	return RouteDeps{
		Sessions:          store,
		Hub:               h,
		ActiveBroker:      func() brokers.ID { return brokers.Zerodha },
		Generation:        func() int { return 1 },
		DataHealth:        func() (bool, []string) { return true, nil },
		QuotesByToken:     func(context.Context, []int64) ([]market.Tick, error) { return nil, nil },
		FeedHealth:        func() brokers.FeedHealth { return brokers.FeedHealth{State: brokers.FeedDown} },
		Subscriptions:     func() brokers.Stats { return brokers.Stats{Lane: brokers.LaneFutures} },
		BoxSubscriptions:  func() brokers.Stats { return brokers.Stats{Lane: brokers.LaneBox} },
		LaneStats:         func(l brokers.Lane) brokers.LaneFeedStats { return brokers.LaneFeedStats{Lane: l} },
		UpstreamFeedStats: func() UpstreamStats { return UpstreamStats{Broker: brokers.Zerodha} },
		AcquireBrowserTokens: func([]int64) func() {
			log.add("acquire")
			return func() { log.add("release") }
		},
	}
}

func startServer(t *testing.T, d RouteDeps) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(server.New(server.Options{FrontendOrigin: "http://localhost:5173", Now: spreadClock()},
		func(r chi.Router) { Mount(r, d) }))
	t.Cleanup(srv.Close)
	return srv
}

// openStream starts a GET and returns the response with a frame reader.
func openStream(t *testing.T, ctx context.Context, url string) (*http.Response, func() string) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(res.Body)
	return res, func() string {
		t.Helper()
		var b strings.Builder
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				t.Fatalf("read: %v (so far %q)", err, b.String())
			}
			b.WriteString(line)
			if line == "\n" {
				return b.String()
			}
		}
	}
}

func postJSON(t *testing.T, url, body string) (int, string) {
	t.Helper()
	res, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(raw)
}

func TestSSEHeadersSnapshotAndRealKeepAlive(t *testing.T) {
	log := &eventLog{}
	h := hub.New(hub.Deps{})
	h.Seed([]market.Tick{{Token: 5, LastPrice: 10.5, ClosePrice: 10}, {Token: 6, LastPrice: 1}})
	d := testDeps(h, NewSessionStore(SessionStoreOptions{}), log)
	d.PingInterval = 25 * time.Millisecond // the real ticker, shortened
	srv := startServer(t, d)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, next := openStream(t, ctx, srv.URL+"/api/stream?tokens=5,7")
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	for k, want := range map[string]string{
		"Content-Type": "text/event-stream", "Cache-Control": "no-cache", // overrides the CORS no-store
		"Connection": "keep-alive", "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": "http://localhost:5173",
	} {
		if got := res.Header.Get(k); got != want {
			t.Errorf("%s %q, want %q", k, got, want)
		}
	}
	if got := next(); got != `data: [{"token":5,"last_price":10.5,"close_price":10,"oi":0,"bid":0,"ask":0}]`+"\n\n" {
		t.Fatalf("snapshot %q (only the requested tokens)", got)
	}
	for i := 0; i < 2; i++ {
		if got := next(); got != ": ping\n\n" {
			t.Fatalf("keep-alive %d: %q", i, got)
		}
	}
	h.IngestExternalTicks([]market.Tick{{Token: 99, LastPrice: 2}}) // not requested: still delivered
	for {
		got := next()
		if got == ": ping\n\n" {
			continue
		}
		if got != `data: [{"token":99,"last_price":2,"close_price":0,"oi":0,"bid":0,"ask":0}]`+"\n\n" {
			t.Fatalf("broadcast %q", got)
		}
		break
	}
}

func TestDefaultKeepAliveIsTwentySeconds(t *testing.T) {
	log := &eventLog{}
	d := testDeps(hub.New(hub.Deps{}), NewSessionStore(SessionStoreOptions{}), log)
	got := make(chan time.Duration, 1)
	d.NewTicker = func(p time.Duration) (<-chan time.Time, func()) {
		got <- p
		return make(chan time.Time), func() {}
	}
	srv := startServer(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, _ := openStream(t, ctx, srv.URL+"/api/stream?tokens=1")
	if p := <-got; p != 20*time.Second {
		t.Errorf("keep-alive period %v, want 20s", p)
	}
	cancel()
	res.Body.Close()
}

// TestCleanupOrderOnDisconnect: the lease goes before the hub detach, and the session's
// connection is released after the detach (Node: clearInterval, release, detach, onClose).
func TestCleanupOrderOnDisconnect(t *testing.T) {
	log := &eventLog{}
	store := NewSessionStore(SessionStoreOptions{})
	lh := &loggingHub{h: hub.New(hub.Deps{}), log: log}
	var connectionsAtDetach atomic.Int64
	lh.atDetach = func() { connectionsAtDetach.Store(int64(store.Stats().Connections)) }
	d := testDeps(lh, store, log)
	d.NewTicker = func(time.Duration) (<-chan time.Time, func()) {
		return make(chan time.Time), func() { log.add("stopPing") }
	}
	handlerDone := make(chan struct{})
	mux := server.New(server.Options{FrontendOrigin: "x", Now: spreadClock()}, func(r chi.Router) { Mount(r, d) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/stream/session/") {
			close(handlerDone)
		}
	}))
	defer srv.Close()

	status, body := postJSON(t, srv.URL+"/api/stream/session", `{"tokens":[1,2,2]}`)
	var created struct {
		ID     string `json:"id"`
		Tokens int    `json:"tokens"`
	}
	if err := json.Unmarshal([]byte(body), &created); status != 200 || err != nil || created.Tokens != 2 {
		t.Fatalf("%d %s", status, body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // a failure below must not leave the stream (and srv.Close) hanging
	res, _ := openStream(t, ctx, srv.URL+"/api/stream/session/"+created.ID)
	if !waitUntil(2*time.Second, func() bool { return log.count("acquire") == 1 }) {
		t.Fatal("no lease")
	}
	if c := store.Stats().Connections; c != 1 {
		t.Fatalf("connections %d while streaming", c)
	}
	cancel()
	res.Body.Close()
	select {
	case <-handlerDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the stream handler did not finish after the browser left")
	}
	want := []string{"attach", "acquire", "stopPing", "release", "detach"}
	if got := log.all(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("calls %v, want %v", got, want)
	}
	if connectionsAtDetach.Load() != 1 {
		t.Error("the session connection was released before the hub detach")
	}
	if c := store.Stats().Connections; c != 0 {
		t.Errorf("connections %d after the stream ended", c)
	}
}

// TestHubDroppedClientEndsTheStream: a browser that stops reading is dropped by the hub
// once its queue is full; the route must then release the lease (once), detach and end
// the response instead of hanging.
func TestHubDroppedClientEndsTheStream(t *testing.T) {
	log := &eventLog{}
	h := hub.New(hub.Deps{ClientQueue: 4})
	store := NewSessionStore(SessionStoreOptions{})
	d := testDeps(&loggingHub{h: h, log: log}, store, log)
	handlerDone := make(chan struct{})
	mux := server.New(server.Options{FrontendOrigin: "x", Now: spreadClock()}, func(r chi.Router) { Mount(r, d) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r)
		if r.URL.Path == "/api/stream" {
			close(handlerDone)
		}
	}))
	defer srv.Close()
	res, err := http.Get(srv.URL + "/api/stream?tokens=1") // the body is never read
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if !waitUntil(2*time.Second, func() bool { return log.count("acquire") == 1 }) {
		t.Fatal("no lease")
	}
	big := []market.Tick{{Token: 1, Bids: make([]market.DepthLevel, 4000)}}
	deadline := time.Now().Add(10 * time.Second)
	for {
		h.IngestExternalTicks(big)
		select {
		case <-handlerDone:
			if got := log.all(); strings.Join(got, ",") != "attach,acquire,release,detach" {
				t.Fatalf("calls %v", got)
			}
			return
		case <-time.After(5 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("the stream stayed open after the hub dropped the client")
		}
	}
}

// TestKiteErrorEventKeepsTheStreamOpen: the hub's own Kite socket failing sends the named
// kite_error event to every stream; the stream is not ended (Node did not end it).
func TestKiteErrorEventKeepsTheStreamOpen(t *testing.T) {
	log := &eventLog{}
	var opts ticker.Options
	var mu sync.Mutex
	h := hub.New(hub.Deps{
		Creds: func() hub.Creds { return hub.Creds{APIKey: "k", AccessToken: "t"} },
		Connect: func(o ticker.Options) ticker.Handle {
			mu.Lock()
			opts = o
			mu.Unlock()
			return fakeSocketHandle{}
		},
	})
	d := testDeps(h, NewSessionStore(SessionStoreOptions{}), log)
	pings := make(chan time.Time, 1)
	d.NewTicker = func(time.Duration) (<-chan time.Time, func()) { return pings, func() {} }
	srv := startServer(t, d)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, next := openStream(t, ctx, srv.URL+"/api/stream?tokens=3")
	defer res.Body.Close()
	if !waitUntil(2*time.Second, func() bool { return log.count("acquire") == 1 }) {
		t.Fatal("no lease")
	}
	h.SubscribeTokens([]int64{3}) // the registry's Zerodha transport opens the hub socket
	mu.Lock()
	onError := opts.OnError
	mu.Unlock()
	onError(ticker.ErrorMessage)
	if got := next(); got != "event: kite_error\ndata: {\"message\":\"Kite WebSocket error.\"}\n\n" {
		t.Fatalf("frame %q", got)
	}
	pings <- time.Now()
	if got := next(); got != ": ping\n\n" {
		t.Fatalf("after kite_error: %q", got)
	}
}

// TestQuoteFetchOutlivesTheBrowser: Node finished the REST quote (filling the cache and
// the hub) even when the browser left, so the upstream call must not be cancelled.
func TestQuoteFetchOutlivesTheBrowser(t *testing.T) {
	log := &eventLog{}
	h := hub.New(hub.Deps{})
	d := testDeps(&loggingHub{h: h, log: log}, NewSessionStore(SessionStoreOptions{}), log)
	entered := make(chan context.Context, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	var calls atomic.Int32
	d.QuotesByToken = func(ctx context.Context, tokens []int64) ([]market.Tick, error) {
		calls.Add(1)
		entered <- ctx
		<-release
		return []market.Tick{{Token: 8, LastPrice: 80}}, nil
	}
	srv := startServer(t, d)
	t.Cleanup(unblock) // runs before srv.Close, so a failure cannot leave the handler blocked
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/api/quotes", strings.NewReader(`{"tokens":[8]}`))
	req.Header.Set("Content-Type", "application/json")
	errc := make(chan error, 1)
	go func() {
		res, err := http.DefaultClient.Do(req)
		if err == nil {
			res.Body.Close()
		}
		errc <- err
	}()
	upstream := <-entered
	cancel()
	<-errc
	time.Sleep(20 * time.Millisecond)
	if upstream.Err() != nil {
		t.Fatalf("the upstream quote was cancelled with the browser: %v", upstream.Err())
	}
	unblock()
	if !waitUntil(2*time.Second, func() bool { return log.count("seed") == 1 }) {
		t.Fatal("the hub was not seeded")
	}
	if _, ok := h.GetLatestTick(8); !ok {
		t.Fatal("the hub cache misses the quote")
	}
	status, body := postJSON(t, srv.URL+"/api/quotes", `{"tokens":[8]}`)
	if status != 200 || body != `{"ticks":[{"token":8,"last_price":80,"close_price":0,"oi":0,"bid":0,"ask":0}],"broker":"zerodha","cached":true}` {
		t.Fatalf("%d %s", status, body)
	}
	if calls.Load() != 1 {
		t.Errorf("%d upstream calls", calls.Load())
	}
}

// TestQuoteCacheExpiresAtExactlyFourSeconds checks the TTL boundary and the key without
// going through HTTP twice per assertion.
func TestQuoteCacheExpiresAtExactlyFourSeconds(t *testing.T) {
	var clock atomic.Int64
	clock.Store(1_000_000)
	log := &eventLog{}
	d := testDeps(&loggingHub{h: hub.New(hub.Deps{}), log: log}, NewSessionStore(SessionStoreOptions{}), log)
	d.Now = func() time.Time { return time.UnixMilli(clock.Load()) }
	var calls atomic.Int32
	d.QuotesByToken = func(_ context.Context, tokens []int64) ([]market.Tick, error) {
		calls.Add(1)
		return []market.Tick{}, nil
	}
	srv := startServer(t, d)
	get := func() string {
		res, err := http.Get(srv.URL + "/api/quotes?tokens=30,10,20")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return string(raw)
	}
	miss := `{"ticks":[],"broker":"zerodha","cached":false}`
	hit := `{"ticks":[],"broker":"zerodha","cached":true}`
	for i, step := range []struct {
		advance int64
		want    string
	}{{0, miss}, {0, hit}, {3999, hit}, {1, miss}, {3999, hit}, {1, miss}} {
		clock.Add(step.advance)
		if got := get(); got != step.want {
			t.Fatalf("request %d: %s, want %s", i, got, step.want)
		}
	}
	if calls.Load() != 3 {
		t.Errorf("%d upstream calls, want 3", calls.Load())
	}
	if k := quoteCacheKey(brokers.Dhan, 12, []int64{30, 4, 200, 1}); k != "dhan:12:1,4,30,200" {
		t.Errorf("key %q", k)
	}
}

func TestSendErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		status  int
		body    string
		clears  int32
		wrapped bool
	}{
		{"kite 403 clears the session", &kite.KiteError{Status: 403, Message: "Invalid token"}, 403, `{"error":"Invalid token"}`, 1, false},
		{"kite 401 wrapped", &kite.KiteError{Status: 401, Message: "expired"}, 401, `{"error":"expired"}`, 1, true},
		{"kite 502", &kite.KiteError{Status: 502, Message: "Bad gateway"}, 502, `{"error":"Bad gateway"}`, 0, false},
		{"kite HTTP 200 with an error status", &kite.KiteError{Status: 200, Message: "Kite returned an error."}, 200, `{"error":"Kite returned an error."}`, 0, false},
		{"transport failure", &kite.FetchError{Err: io.ErrUnexpectedEOF}, 500, `{"error":"fetch failed"}`, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			log := &eventLog{}
			d := testDeps(&loggingHub{h: hub.New(hub.Deps{}), log: log}, NewSessionStore(SessionStoreOptions{}), log)
			var clears atomic.Int32
			d.ClearKiteSession = func() { clears.Add(1) }
			err := tc.err
			if tc.wrapped {
				err = &wrapErr{err}
			}
			d.QuotesByToken = func(context.Context, []int64) ([]market.Tick, error) { return nil, err }
			srv := startServer(t, d)
			status, body := postJSON(t, srv.URL+"/api/quotes", `{"tokens":[1]}`)
			if status != tc.status || body != tc.body || clears.Load() != tc.clears {
				t.Fatalf("%d %s (cleared %d), want %d %s (%d)", status, body, clears.Load(), tc.status, tc.body, tc.clears)
			}
		})
	}
}

type wrapErr struct{ err error }

func (w *wrapErr) Error() string { return "wrapped: " + w.err.Error() }
func (w *wrapErr) Unwrap() error { return w.err }

// TestDiagnosticsWithRealAdminSessions wires IsFullAdmin the way cmd/server will.
func TestDiagnosticsWithRealAdminSessions(t *testing.T) {
	sessions := auth.NewSessions(nil, nil)
	full, trade := sessions.Mint(auth.RoleFull), sessions.Mint(auth.RoleTrade)
	log := &eventLog{}
	d := testDeps(&loggingHub{h: hub.New(hub.Deps{}), log: log}, NewSessionStore(SessionStoreOptions{}), log)
	d.IsFullAdmin = func(r *http.Request) bool { return sessions.RoleOf(r) == auth.RoleFull }
	srv := startServer(t, d)
	get := func(token string) (int, string) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/market-data/diagnostics", nil)
		if token != "" {
			req.Header.Set("x-admin-token", token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(raw)
	}
	for _, tok := range []string{"", trade, full + "x"} {
		if status, body := get(tok); status != 403 || body != `{"error":"Full admin access required."}` {
			t.Errorf("token %q: %d %s", tok, status, body)
		}
	}
	status, body := get(full)
	if status != 200 || !strings.HasSuffix(body, `"board_size":null,"diagnosis":"`+DiagnosisNoBrowser+`"}`) {
		t.Fatalf("%d %s", status, body)
	}
	// A repeated header is joined like Node's req.headers and matches no session.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/market-data/diagnostics", nil)
	req.Header.Add("x-admin-token", full)
	req.Header.Add("x-admin-token", full)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Errorf("repeated header: %d", res.StatusCode)
	}
}

func TestBoardSizePanicReportsNull(t *testing.T) {
	log := &eventLog{}
	d := testDeps(&loggingHub{h: hub.New(hub.Deps{}), log: log}, NewSessionStore(SessionStoreOptions{}), log)
	d.IsFullAdmin = func(*http.Request) bool { return true }
	d.BoardSize = func(context.Context) (int, error) { panic("instrument universe exploded") }
	srv := startServer(t, d)
	res, err := http.Get(srv.URL + "/api/market-data/diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(raw), `"board_size":null`) {
		t.Fatalf("%d %s", res.StatusCode, raw)
	}
}

// TestEncodedSessionIDIsDecodedLikeExpress: Express decodes req.params, so a percent-
// encoded id still names the session.
func TestEncodedSessionIDIsDecodedLikeExpress(t *testing.T) {
	log := &eventLog{}
	store := NewSessionStore(SessionStoreOptions{})
	d := testDeps(&loggingHub{h: hub.New(hub.Deps{}), log: log}, store, log)
	srv := startServer(t, d)
	s := store.Create([]int64{1}, brokers.Zerodha, 1)
	encoded := ""
	for _, c := range []byte(s.ID) {
		encoded += fmt.Sprintf("%%%02X", c)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, _ := openStream(t, ctx, srv.URL+"/api/stream/session/"+encoded)
	defer res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status %d %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	res2, err := http.Get(srv.URL + "/api/stream/session/" + s.ID + "%2Fx")
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	raw, _ := io.ReadAll(res2.Body)
	if res2.StatusCode != 404 || string(raw) != `{"error":"Unknown or expired market-data session. Create a new one.","broker":"zerodha","generation":1}` {
		t.Fatalf("%d %s", res2.StatusCode, raw)
	}
}

// TestManyConcurrentStreams opens, feeds and closes streams concurrently (run with -race):
// every lease is released once and every attach is detached.
func TestManyConcurrentStreams(t *testing.T) {
	log := &eventLog{}
	h := hub.New(hub.Deps{})
	store := NewSessionStore(SessionStoreOptions{})
	d := testDeps(&loggingHub{h: h, log: log}, store, log)
	d.PingInterval = 5 * time.Millisecond
	srv := startServer(t, d)
	const n = 24
	stop := make(chan struct{})
	var feeder sync.WaitGroup
	feeder.Add(1)
	go func() {
		defer feeder.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			h.IngestExternalTicks([]market.Tick{{Token: int64(i%5 + 1), LastPrice: float64(i)}})
			time.Sleep(time.Millisecond)
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			url := srv.URL + "/api/stream?tokens=1,2,3"
			if i%2 == 0 {
				res, err := http.Post(srv.URL+"/api/stream/session", "application/json", strings.NewReader(`{"tokens":[1,2,3,4,5]}`))
				if err != nil {
					t.Error(err)
					return
				}
				raw, _ := io.ReadAll(res.Body)
				res.Body.Close()
				var c struct {
					ID string `json:"id"`
				}
				if res.StatusCode != 200 || json.Unmarshal(raw, &c) != nil {
					t.Errorf("%d %s", res.StatusCode, raw)
					return
				}
				url = srv.URL + "/api/stream/session/" + c.ID
			}
			ctx, cancel := context.WithCancel(context.Background())
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				cancel()
				t.Error(err)
				return
			}
			r := bufio.NewReader(res.Body)
			for frames := 0; frames < 3; {
				line, err := r.ReadString('\n')
				if err != nil {
					t.Error(err)
					break
				}
				if line == "\n" {
					frames++
				}
			}
			cancel()
			res.Body.Close()
		}(i)
	}
	wg.Wait()
	close(stop)
	feeder.Wait()
	if !waitUntil(3*time.Second, func() bool { return log.count("detach") == n }) {
		t.Fatalf("attach %d detach %d", log.count("attach"), log.count("detach"))
	}
	if a, r, at := log.count("acquire"), log.count("release"), log.count("attach"); a != n || r != n || at != n {
		t.Errorf("acquire %d release %d attach %d, want %d each", a, r, at, n)
	}
	if c := store.Stats().Connections; c != 0 {
		t.Errorf("connections %d after every stream closed", c)
	}
}

func TestMountRequiresTheBrokerDeps(t *testing.T) {
	defer func() {
		rec := recover()
		msg, _ := rec.(string)
		if !strings.Contains(msg, "RouteDeps.Sessions") || !strings.Contains(msg, "RouteDeps.UpstreamFeedStats") {
			t.Fatalf("panic %v", rec)
		}
	}()
	Mount(chi.NewRouter(), RouteDeps{})
}

func TestQueryValuesFollowNodeQuerystring(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want []string
	}{
		{"", nil},
		{"tokens", []string{""}},
		{"tokens=1&tokens=2", []string{"1", "2"}},
		{"tokens=a+b%2Bc", []string{"a b+c"}},
		{"tokens=%zz%4", []string{"%zz%4"}},
		{"tokens=%41%", []string{"A%"}},
		{"tok%65ns=1", []string{"1"}},
		{"tokens==1", []string{"=1"}},
		{"&&tokens=7&&", []string{"7"}},
		{"x=1&tokens=%E2%80%A85", []string{"\u20285"}},
	} {
		if got := queryValues(tc.raw, "tokens"); strings.Join(got, "|") != strings.Join(tc.want, "|") || len(got) != len(tc.want) {
			t.Errorf("%q: %q, want %q", tc.raw, got, tc.want)
		}
	}
	// U+2028 is JavaScript whitespace, so Number(" 5".trim()) is 5.
	if got := queryTokens("tokens=%E2%80%A85,%EF%BB%BF6"); len(got) != 2 || got[0] != 5 || got[1] != 6 {
		t.Errorf("JavaScript whitespace: %v", got)
	}
	if got := queryTokens("tokens=9223372036854775807,1e19,9223372036854774784"); len(got) != 1 || got[0] != 9223372036854774784 {
		t.Errorf("int64 range: %v", got)
	}
}

func TestSessionSweeperReapsIdleSessions(t *testing.T) {
	var clock atomic.Int64
	clock.Store(1_000_000)
	store := NewSessionStore(SessionStoreOptions{TTL: time.Minute, Now: func() time.Time { return time.UnixMilli(clock.Load()) }})
	idle := store.Create([]int64{1}, brokers.Zerodha, 1)
	live := store.Create([]int64{2}, brokers.Zerodha, 1)
	store.Open(live.ID)
	stop := StartSessionSweeper(store, 5*time.Millisecond)
	clock.Add(61_000)
	if !waitUntil(2*time.Second, func() bool { return store.Size() == 1 }) {
		t.Fatalf("size %d", store.Size())
	}
	stop()
	stop()
	if _, rej := store.Resolve(idle.ID, brokers.Zerodha, 1); rej != RejectNotFound {
		t.Error("the idle session survived")
	}
	if _, rej := store.Resolve(live.ID, brokers.Zerodha, 1); rej != RejectNone {
		t.Error("a streaming session was reaped")
	}
}
