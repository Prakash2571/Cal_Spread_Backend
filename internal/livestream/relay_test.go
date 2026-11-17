package livestream

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// Credentials are generated at runtime, never stored as secret literals in tests.
func randomCredential(t *testing.T) string {
	t.Helper()
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		t.Fatal("could not generate test credential")
	}
	return hex.EncodeToString(raw[:])
}

type testSource struct {
	mu      sync.Mutex
	fn      func([]market.Tick)
	added   int
	removed int
}

func (s *testSource) AddTickListener(fn func([]market.Tick)) func() {
	s.mu.Lock()
	s.fn = fn
	s.added++
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		s.fn = nil
		s.removed++
		s.mu.Unlock()
	}
}

func (s *testSource) emit(ticks []market.Tick) {
	s.mu.Lock()
	fn := s.fn
	s.mu.Unlock()
	if fn != nil {
		fn(ticks)
	}
}

type fixture struct {
	relay  *Relay
	source *testSource
	server *httptest.Server
	secret string
}

func newFixture(t *testing.T, secret string) *fixture {
	t.Helper()
	source := &testSource{}
	r := New(source, secret)
	f := &fixture{relay: r, source: source, secret: secret}
	// Use the real shared middleware as well as the real route registration.
	f.server = httptest.NewServer(server.New(server.Options{}, r.Mount))
	t.Cleanup(func() {
		r.Close()
		f.server.Close()
		waitFor(t, func() bool { return active(r) == 0 })
	})
	return f
}

func active(r *Relay) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.clients)
}

func waitFor(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for relay cleanup")
		}
		time.Sleep(time.Millisecond)
	}
}

func (f *fixture) wsURL(query string) string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http") + Path + query
}

func (f *fixture) connect(t *testing.T) *websocket.Conn {
	t.Helper()
	conn, response, err := websocket.DefaultDialer.Dial(
		f.wsURL("?secret="+url.QueryEscape(f.secret)), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		// Dial errors may contain the credential-bearing URL; do not print them.
		t.Fatal("websocket handshake failed")
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readMessage(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	kind, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket message: %v", err)
	}
	if kind != websocket.TextMessage {
		t.Fatalf("message kind = %d, want text", kind)
	}
	return raw
}

func TestAuthFormsAndRejections(t *testing.T) {
	secret, wrong := randomCredential(t), randomCredential(t)
	f := newFixture(t, secret)
	cases := []struct {
		name   string
		header http.Header
		query  string
		status int
	}{
		{"bearer", http.Header{"Authorization": {"Bearer " + secret}}, "", 101},
		{"header", http.Header{"X-Stream-Secret": {secret}}, "", 101},
		{"query_browser", http.Header{"Origin": {"https://consumer.example"}}, "?secret=" + url.QueryEscape(secret), 101},
		{"wrong_bearer", http.Header{"Authorization": {"Bearer " + wrong}}, "", 403},
		{"wrong_header", http.Header{"X-Stream-Secret": {wrong}}, "", 403},
		{"wrong_query", nil, "?secret=" + url.QueryEscape(wrong), 403},
		{"missing", nil, "", 403},
		{"empty", nil, "?secret=", 403},
		{"duplicate_query", nil, "?secret=" + secret + "&secret=" + secret, 403},
		{"duplicate_header", http.Header{"X-Stream-Secret": {secret, secret}}, "", 403},
		{"duplicate_bearer", http.Header{"Authorization": {"Bearer " + secret, "Bearer " + secret}}, "", 403},
		{"no_fallback", http.Header{"Authorization": {"Bearer " + wrong}}, "?secret=" + secret, 403},
		{"invalid_scheme", http.Header{"Authorization": {secret}}, "?secret=" + secret, 403},
		{"admin_is_unrelated", http.Header{"X-Admin-Token": {secret}}, "", 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn, response, err := websocket.DefaultDialer.Dial(f.wsURL(tc.query), tc.header)
			if response != nil && response.Body != nil {
				defer response.Body.Close()
			}
			if conn != nil {
				defer conn.Close()
			}
			if response == nil || response.StatusCode != tc.status {
				t.Fatalf("unexpected handshake response; want HTTP %d", tc.status)
			}
			if (tc.status == 101) != (err == nil) {
				t.Fatal("handshake result does not match status")
			}
		})
		waitFor(t, func() bool { return active(f.relay) == 0 })
	}
}

func TestUnsetOrEmptyEnvironmentFailsClosed(t *testing.T) {
	for _, name := range []string{"unset", "empty", "whitespace"} {
		t.Run(name, func(t *testing.T) {
			env := map[string]string{}
			if name == "empty" {
				env["CALSPREAD_STREAM_SECRET"] = ""
			} else if name == "whitespace" {
				env["CALSPREAD_STREAM_SECRET"] = " \t "
			}
			cfg := config.Load(config.MapGetter(env))
			f := newFixture(t, cfg.StreamSecret)
			for _, query := range []string{"", "?secret=" + randomCredential(t)} {
				response, err := http.Get(f.server.URL + Path + query)
				if err != nil {
					t.Fatal("HTTP request failed")
				}
				_ = response.Body.Close()
				if response.StatusCode != 503 {
					t.Fatalf("disabled status = %d, want 503", response.StatusCode)
				}
			}
			if f.source.added != 0 || active(f.relay) != 0 {
				t.Fatal("disabled relay registered a listener or consumer")
			}
		})
	}
}

func TestNonWebsocketRequestReleasesSlot(t *testing.T) {
	f := newFixture(t, randomCredential(t))
	for i := 0; i < MaxConsumers+1; i++ {
		req, _ := http.NewRequest(http.MethodGet, f.server.URL+Path, nil)
		req.Header.Set("X-Stream-Secret", f.secret)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal("HTTP request failed")
		}
		_ = response.Body.Close()
		if response.StatusCode != 400 {
			t.Fatalf("non-upgrade status = %d, want 400", response.StatusCode)
		}
	}
	waitFor(t, func() bool { return active(f.relay) == 0 })
	f.connect(t)
}

func TestTickBatchExactJSON(t *testing.T) {
	f := newFixture(t, randomCredential(t))
	f.relay.now = func() time.Time { return time.UnixMilli(1794902400000) }
	conn := f.connect(t)
	depth := true
	f.source.emit([]market.Tick{{
		Token: 2000045678, LastPrice: 100.5, ClosePrice: 99, OI: 1200,
		Bid: 100.4, Ask: 100.6, DepthUpdated: &depth,
		Bids: []market.DepthLevel{{Price: 100.4, Qty: 25, Orders: 2}},
		Asks: []market.DepthLevel{{Price: 100.6, Qty: 30, Orders: 3}},
	}})
	want := `[{"token":2000045678,"last_price":100.5,"close_price":99,"oi":1200,"bid":100.4,"ask":100.6,"bids":[{"price":100.4,"qty":25,"orders":2}],"asks":[{"price":100.6,"qty":30,"orders":3}],"depth_updated":true,"exchange_ts":null,"received_at":1794902400000,"volume":null,"tradingsymbol":null,"name":null}]`
	if got := string(readMessage(t, conn)); got != want {
		t.Fatalf("JSON = %s, want %s", got, want)
	}
	// Natural batches are preserved, including ticks from unrelated instruments.
	ts, volume := int64(1794902399000), 500.0
	f.source.emit([]market.Tick{
		{Token: 4, LastPrice: 12, ExchangeTS: &ts, Volume: &volume},
		{Token: 9, LastPrice: 7},
	})
	var rows []map[string]any
	if err := json.Unmarshal(readMessage(t, conn), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0]["token"] != float64(4) || rows[1]["token"] != float64(9) ||
		rows[0]["volume"] != 500.0 || rows[0]["exchange_ts"] != float64(ts) {
		t.Fatalf("batch or optional metadata lost: %v", rows)
	}
}

func TestQueuedBatchOwnsItsData(t *testing.T) {
	depth, ts, volume := true, int64(1234), 200.0
	ticks := []market.Tick{{
		Token: 7, LastPrice: 10, DepthUpdated: &depth, ExchangeTS: &ts, Volume: &volume,
		Bids: []market.DepthLevel{{Price: 9, Qty: 3}},
		Asks: []market.DepthLevel{{Price: 11, Qty: 4}},
	}}
	b := copyBatch(ticks, 5678)
	want := string(encodeBatch(b))
	ticks[0].Token = 99
	ticks[0].Bids[0].Qty = 100
	ticks[0].Asks[0].Price = 100
	depth, ts, volume = false, 99, 99
	if got := string(encodeBatch(b)); got != want {
		t.Fatal("queued batch aliases source values")
	}
}

func TestSlowConsumerNeverBlocksHubPublisher(t *testing.T) {
	var upstream atomic.Int32
	h := hub.New(hub.Deps{
		Creds: func() hub.Creds { upstream.Add(1); return hub.Creds{} },
		Connect: func(ticker.Options) ticker.Handle {
			upstream.Add(1)
			panic("relay attempted upstream construction")
		},
	})
	r := New(h, randomCredential(t))
	defer r.Close()
	// No writer is attached to slow: deterministic complete writer starvation,
	// independent of operating-system websocket/socket buffer sizes.
	slow, healthy := r.reserve(), r.reserve()
	defer r.release(slow)
	defer r.release(healthy)
	finished := make(chan struct{})
	var received atomic.Int32
	// Prove even a held admission/cleanup lock cannot block the hub callback.
	r.mu.Lock()
	go func() {
		defer close(finished)
		for i := 0; i <= MaxReplacements; i++ {
			h.IngestExternalTicks([]market.Tick{{Token: int64(i + 1), LastPrice: float64(i)}})
			select {
			case <-healthy.queue:
				healthy.replacements.Store(0)
				received.Add(1)
			default:
			}
		}
	}()
	select {
	case <-finished:
		r.mu.Unlock()
	case <-time.After(2 * time.Second):
		r.mu.Unlock()
		t.Fatal("slow consumer blocked the hub publisher")
	}
	select {
	case <-slow.done:
		reason := slow.closing.Load()
		if reason.code != websocket.ClosePolicyViolation || reason.text != "slow consumer" {
			t.Fatal("slow consumer did not receive a policy close")
		}
	default:
		t.Fatal("persistently slow consumer was not disconnected")
	}
	if received.Load() != MaxReplacements+1 || upstream.Load() != 0 || h.SubscribedCount() != 0 {
		t.Fatal("healthy delivery or upstream isolation failed")
	}
}

func TestLatestWinsAndProgressResetsBound(t *testing.T) {
	c := newConsumer()
	for i := 0; i < MaxReplacements; i++ {
		c.offer(batch{receivedAt: int64(i)})
	}
	if len(c.queue) != 1 || (<-c.queue).receivedAt != MaxReplacements-1 {
		t.Fatal("stale queued batches were not replaced by the latest")
	}
	c.replacements.Store(0) // the writer's action after dequeueing
	for i := 0; i < MaxReplacements; i++ {
		c.offer(batch{receivedAt: int64(i)})
	}
	select {
	case <-c.done:
		t.Fatal("consumer was closed despite writer progress")
	default:
	}
	c.offer(batch{})
	select {
	case <-c.done:
	default:
		t.Fatal("replacement bound did not close the consumer")
	}
}

func TestSlowConsumerCloseFrame(t *testing.T) {
	// Run the production writer after deterministic queue overflow, to verify the
	// downstream close frame independently of OS buffer sizes and writer scheduling.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, req, nil)
		if err != nil {
			return
		}
		c := newConsumer()
		for i := 0; i <= MaxReplacements; i++ {
			c.offer(batch{})
		}
		(&Relay{}).write(conn, c)
	}))
	defer srv.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal("handshake failed")
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
		t.Fatalf("expected slow-consumer policy close, got %v", err)
	}
}

func TestConnectionCapAndSlotReuse(t *testing.T) {
	f := newFixture(t, randomCredential(t))
	connections := make([]*websocket.Conn, MaxConsumers)
	for i := range connections {
		connections[i] = f.connect(t)
	}
	conn, response, err := websocket.DefaultDialer.Dial(f.wsURL("?secret="+f.secret), nil)
	if conn != nil {
		_ = conn.Close()
	}
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err == nil || response == nil || response.StatusCode != 503 || active(f.relay) != MaxConsumers {
		t.Fatal("connection cap was not enforced immediately")
	}
	_ = connections[0].Close()
	waitFor(t, func() bool { return active(f.relay) == MaxConsumers-1 })
	f.connect(t)
	if active(f.relay) != MaxConsumers {
		t.Fatal("closed connection did not release its slot")
	}
}

func TestClientDataIgnoredAndPingHandled(t *testing.T) {
	f := newFixture(t, randomCredential(t))
	conn := f.connect(t)
	pong := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error { pong <- struct{}{}; return nil })
	read := make(chan error, 1)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	go func() {
		_, _, err := conn.ReadMessage()
		read <- err
	}()
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"subscribe":[999]}`)); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-pong:
	case <-time.After(time.Second):
		t.Fatal("server did not answer ping")
	}
	f.source.emit([]market.Tick{{Token: 1, LastPrice: 2}})
	if err := <-read; err != nil {
		t.Fatalf("client message disrupted the stream: %v", err)
	}
}

func TestShutdownClosesAndDetaches(t *testing.T) {
	f := newFixture(t, randomCredential(t))
	conn := f.connect(t)
	f.relay.Close()
	f.relay.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.CloseGoingAway) {
		t.Fatalf("shutdown close = %v, want 1001", err)
	}
	waitFor(t, func() bool { return active(f.relay) == 0 })
	f.source.mu.Lock()
	removed := f.source.removed
	f.source.mu.Unlock()
	if removed != 1 {
		t.Fatalf("listener removals = %d, want 1", removed)
	}
	if c := f.relay.reserve(); c != nil {
		t.Fatal("shutdown relay admitted a new consumer")
	}
}

func TestRelayHasNoUpstreamOperations(t *testing.T) {
	// Source-level guard, not a live Dhan test. The deliberately narrow TickSource
	// contract and the hub construction trap above provide independent checks.
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		for _, forbidden := range []string{
			"internal/brokers", "internal/auth", "internal/kite", "internal/core",
			".NewFeed(", ".Subscribe(", ".SubscribeTokens(", ".AddClient(",
			".AcquireBrowserTokens(", ".SetSpikeTokens(", ".Retain(",
			".Dial(", ".DialContext(", "http.Get(", "http.NewRequest(",
			".QuotesByToken(", ".GetQuoteFull(", ".GetInstruments(",
		} {
			if strings.Contains(string(data), forbidden) {
				t.Errorf("%s contains forbidden upstream/session operation %s", path, forbidden)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no production relay files checked")
	}
}
