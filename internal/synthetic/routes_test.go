package synthetic

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// Route cases the Node golden cannot reach (it drove the handlers without a real HTTP
// server): the SSE stream over a socket, parameter decoding before the limiter and auth,
// the role checks on every route, and how failures are answered. Expected statuses and
// bodies are taken from src/synthetic/routes.ts and inventory/api.md §2.11 / §3.3.

type authedMarket struct{}

func (authedMarket) IsAuthenticated() bool { return true }
func (authedMarket) GetQuoteFull(context.Context, []string) ([]market.RestQuote, error) {
	return nil, nil
}

// failingStore is an enabled store whose reads fail (or panic) on demand.
type failingStore struct {
	Repository
	loadClosed func() ([]*Trade, error)
}

func (s *failingStore) Enabled() bool { return true }
func (s *failingStore) LoadClosed(context.Context, int, *string) ([]*Trade, error) {
	return s.loadClosed()
}

var testRoles = map[string]auth.Role{"tok-full": auth.RoleFull, "tok-trade": auth.RoleTrade}

func testRole(token string) auth.Role { return testRoles[token] }

func routeServer(t *testing.T, deps Deps, ping time.Duration) (*Engine, *httptest.Server) {
	t.Helper()
	cfg := LoadConfig(config.MapGetter(map[string]string{"SYNTH_PUBLISH_INTERVAL_MS": "200"}))
	deps.Config = &cfg
	if deps.MarketData == nil {
		deps.MarketData = authedMarket{}
	}
	eng := NewEngine(deps)
	h := server.New(server.Options{FrontendOrigin: "http://localhost:5173"},
		func(r chi.Router) { Register(r, eng, RouteDeps{Role: testRole, PingInterval: ping}) })
	srv := httptest.NewServer(h)
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
		eng.Dispose()
		eng.WaitIdle(5 * time.Second)
	})
	return eng, srv
}

func do(t *testing.T, srv *httptest.Server, method, path, token, body string) (int, http.Header, string) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, srv.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("X-Admin-Token", token)
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, string(b)
}

func TestRoutesNeedAnAdminRole(t *testing.T) {
	_, srv := routeServer(t, Deps{}, 0)
	id := strings.Repeat("a", 24)
	routes := []struct{ method, path string }{
		{"GET", "/api/synthetic/status"},
		{"POST", "/api/synthetic/start"},
		{"POST", "/api/synthetic/stop"},
		{"POST", "/api/synthetic/strike-level"},
		{"POST", "/api/synthetic/settings"},
		{"GET", "/api/synthetic/opportunities"},
		{"GET", "/api/synthetic/trades/open"},
		{"GET", "/api/synthetic/trades/history"},
		{"POST", "/api/synthetic/trades/" + id + "/close"},
		{"DELETE", "/api/synthetic/trades/" + id},
		{"GET", "/api/synthetic/chain/NIFTY"},
		{"GET", "/api/synthetic/stream"},
	}
	for _, rt := range routes {
		for _, token := range []string{"", "nope"} {
			code, hdr, body := do(t, srv, rt.method, rt.path, token, "")
			if code != 403 || body != `{"error":"Admin authentication required"}` {
				t.Errorf("%s %s token=%q: %d %s", rt.method, rt.path, token, code, body)
			}
			if ct := hdr.Get("Content-Type"); ct != "application/json; charset=utf-8" {
				t.Errorf("%s %s: content type %q", rt.method, rt.path, ct)
			}
		}
	}
	// The trade role may do everything but delete.
	code, _, body := do(t, srv, "DELETE", "/api/synthetic/trades/"+id, "tok-trade", "")
	if code != 403 || body != `{"error":"Full administrator access required."}` {
		t.Errorf("DELETE as trade: %d %s", code, body)
	}
	code, _, body = do(t, srv, "DELETE", "/api/synthetic/trades/"+id, "tok-full", "")
	if code != 503 || body != `{"error":"Paper-trade storage is not connected."}` {
		t.Errorf("DELETE without storage: %d %s", code, body)
	}
	// A repeated header is joined with ", " (as Node does) and so never matches.
	req, _ := http.NewRequest("GET", srv.URL+"/api/synthetic/status", nil)
	req.Header.Add("X-Admin-Token", "tok-full")
	req.Header.Add("X-Admin-Token", "tok-full")
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Errorf("repeated header: %d", res.StatusCode)
	}
}

// Express decodes path parameters while matching the route, before any of its handlers:
// a bad escape is a 400 page even without a token, and does not count for the limiter.
func TestBadPathParameterIsRejectedBeforeAuth(t *testing.T) {
	_, srv := routeServer(t, Deps{}, 0)
	want := "<pre>URIError: Failed to decode param &#39;%FF&#39;</pre>"
	for _, rt := range []struct{ method, path string }{
		{"GET", "/api/synthetic/chain/%FF"},
		{"POST", "/api/synthetic/trades/%FF/close"},
		{"DELETE", "/api/synthetic/trades/%FF"},
	} {
		code, hdr, body := do(t, srv, rt.method, rt.path, "", "")
		if code != 400 || !strings.Contains(body, want) || !strings.HasPrefix(hdr.Get("Content-Type"), "text/html") {
			t.Errorf("%s %s: %d %q", rt.method, rt.path, code, body)
		}
	}
	for i := 0; i < 25; i++ {
		do(t, srv, "DELETE", "/api/synthetic/trades/%FF", "", "")
	}
	// The delete bucket is still empty: the next 20 are answered by auth, the 21st is 429.
	for i := 1; i <= 21; i++ {
		code, hdr, body := do(t, srv, "DELETE", "/api/synthetic/trades/"+strings.Repeat("b", 24), "", "")
		if i <= 20 && code != 403 {
			t.Fatalf("delete %d: %d %s", i, code, body)
		}
		if i == 21 && (code != 429 || body != `{"error":"Too many delete requests. Slow down."}` || hdr.Get("Retry-After") != "60") {
			t.Fatalf("delete 21: %d %s retry-after=%q", code, body, hdr.Get("Retry-After"))
		}
	}
	// Decoded parameters reach the engine: %26 is "&".
	code, _, body := do(t, srv, "GET", "/api/synthetic/chain/m%26m", "tok-trade", "")
	if code != 404 || body != `{"error":"M&M is not being monitored."}` {
		t.Errorf("chain m%%26m: %d %s", code, body)
	}
}

func TestAsyncHandlerFailuresAnswer500(t *testing.T) {
	calls := 0
	store := &failingStore{loadClosed: func() ([]*Trade, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("connection refused")
		}
		panic(errors.New("cursor exploded"))
	}}
	_, srv := routeServer(t, Deps{Store: store}, 0)
	code, _, body := do(t, srv, "GET", "/api/synthetic/trades/history", "tok-trade", "")
	if code != 500 || body != `{"error":"connection refused"}` {
		t.Errorf("history error: %d %s", code, body)
	}
	code, _, body = do(t, srv, "GET", "/api/synthetic/trades/history?scope=all", "tok-trade", "")
	if code != 500 || body != `{"error":"cursor exploded"}` {
		t.Errorf("history panic: %d %s", code, body)
	}
	if code, _, body := do(t, srv, "POST", "/api/synthetic/settings", "tok-trade", `{"safety_buffer":`); code != 400 ||
		!strings.Contains(body, "SyntaxError") {
		t.Errorf("malformed JSON: %d %s", code, body)
	}
}

// sseReader reads frames ("event: ...\ndata: ...\n\n" or ": ping\n\n") from a stream.
type sseReader struct {
	br     *bufio.Reader
	frames chan string
	done   chan error
}

func readSSE(body io.Reader) *sseReader {
	r := &sseReader{br: bufio.NewReader(body), frames: make(chan string, 64), done: make(chan error, 1)}
	go func() {
		var cur strings.Builder
		for {
			line, err := r.br.ReadString('\n')
			if err != nil {
				r.done <- err
				close(r.frames)
				return
			}
			cur.WriteString(line)
			if line == "\n" {
				r.frames <- cur.String()
				cur.Reset()
			}
		}
	}()
	return r
}

func (r *sseReader) next(t *testing.T, timeout time.Duration) (string, bool) {
	t.Helper()
	select {
	case f, ok := <-r.frames:
		return f, ok
	case <-time.After(timeout):
		t.Fatalf("no SSE frame within %v", timeout)
		return "", false
	}
}

func TestStreamHeadersFramesPingAndDispose(t *testing.T) {
	eng, srv := routeServer(t, Deps{}, 60*time.Millisecond)
	// EventSource cannot set headers: the token may come as ?x-admin-token=.
	res, err := srv.Client().Get(srv.URL + "/api/synthetic/stream?x-admin-token=tok-trade")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	for k, v := range map[string]string{"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive"} {
		if got := res.Header.Get(k); got != v {
			t.Errorf("header %s = %q, want %q", k, got, v)
		}
	}
	rd := readSSE(res.Body)
	first, _ := rd.next(t, 5*time.Second)
	if !strings.HasPrefix(first, "event: snapshot\ndata: {\"status\":{\"running\":false,") || !strings.HasSuffix(first, "}\n\n") {
		t.Fatalf("first frame: %.200q", first)
	}
	var snap struct {
		Status        json.RawMessage `json:"status"`
		Opportunities []any           `json:"opportunities"`
		OpenTrades    []any           `json:"open_trades"`
	}
	data := strings.TrimSuffix(strings.TrimPrefix(first, "event: snapshot\ndata: "), "\n\n")
	if err := json.Unmarshal([]byte(data), &snap); err != nil || snap.Opportunities == nil || snap.OpenTrades == nil {
		t.Fatalf("snapshot payload: %v %.200s", err, data)
	}
	// The shared publish timer (200 ms here) and the keep-alive ping (60 ms here).
	sawPing, sawSnapshot := false, false
	for deadline := time.Now().Add(5 * time.Second); (!sawPing || !sawSnapshot) && time.Now().Before(deadline); {
		f, _ := rd.next(t, 5*time.Second)
		switch {
		case f == ": ping\n\n":
			sawPing = true
		case strings.HasPrefix(f, "event: snapshot\ndata: "):
			sawSnapshot = true
		default:
			t.Fatalf("unexpected frame %.120q", f)
		}
	}
	if !sawPing || !sawSnapshot {
		t.Fatalf("ping %v, timer snapshot %v", sawPing, sawSnapshot)
	}
	// Stop publishes but keeps the stream open; Dispose ends it after its last snapshot.
	eng.Stop()
	eng.Dispose()
	var last string
	for {
		f, ok := rd.next(t, 5*time.Second)
		if !ok {
			break
		}
		if f != ": ping\n\n" {
			last = f
		}
	}
	if err := <-rd.done; err != io.EOF {
		t.Errorf("stream ended with %v, want EOF", err)
	}
	if !strings.HasPrefix(last, "event: snapshot\n") {
		t.Errorf("last frame before the end: %.120q", last)
	}
}

func TestStreamTokenRules(t *testing.T) {
	eng, srv := routeServer(t, Deps{}, 0)
	get := func(path string, header []string) (int, string) {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		for _, h := range header {
			req.Header.Add("X-Admin-Token", h)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		res, err := srv.Client().Do(req.WithContext(ctx))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			b, _ := io.ReadAll(res.Body)
			return res.StatusCode, string(b)
		}
		return res.StatusCode, ""
	}
	forbidden := `{"error":"Admin authentication required"}`
	cases := []struct {
		path   string
		header []string
		want   int
	}{
		{"/api/synthetic/stream", nil, 403},
		{"/api/synthetic/stream?x-admin-token=nope", nil, 403},
		{"/api/synthetic/stream?x-admin-token=tok-full&x-admin-token=tok-full", nil, 403}, // an array, not a string
		{"/api/synthetic/stream?x-admin-token=tok-full", []string{"nope"}, 403},           // the header wins when present
		{"/api/synthetic/stream?x-admin-token=tok-full", []string{""}, 403},               // even empty
		{"/api/synthetic/stream", []string{"tok-full", "tok-full"}, 403},                  // joined with ", "
		{"/api/synthetic/stream", []string{"tok-trade"}, 200},
		{"/api/synthetic/stream?x-admin-token=tok-full", nil, 200},
	}
	for _, c := range cases {
		code, body := get(c.path, c.header)
		if code != c.want || (c.want == 403 && body != forbidden) {
			t.Errorf("%s %q: %d %s", c.path, c.header, code, body)
		}
	}
	// Every stream that went away removed its client, and the publish timer stopped with
	// the last one.
	deadline := time.Now().Add(5 * time.Second)
	for {
		eng.lock()
		n, timer := len(eng.sseClients), eng.publishStop != nil
		eng.unlock()
		if n == 0 && !timer {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d clients left, publish timer running %v", n, timer)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A stream whose peer stopped reading falls behind; it is dropped instead of queueing
// without bound, and the request ends.
func TestStalledStreamIsDropped(t *testing.T) {
	eng := NewEngine(Deps{MarketData: authedMarket{}})
	c, remove := eng.addSSEClient()
	defer remove()
	for i := 0; i < sseMaxBacklog+5; i++ {
		eng.Publish()
	}
	select {
	case <-c.ended:
	default:
		t.Fatal("a client 128 frames behind was not dropped")
	}
	if got := len(c.take()); got != sseMaxBacklog {
		t.Errorf("queued %d frames, want %d", got, sseMaxBacklog)
	}
}
