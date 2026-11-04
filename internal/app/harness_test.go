package app

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/registry"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
)

// Loopback fakes and a harness that runs the whole App on 127.0.0.1. Nothing here talks
// to a remote host: Kite REST, the Kite ticker, Dhan (REST, auth, scrip master, feed)
// and Yahoo all point at local fakes or at a closed local port.

// fakeInstrumentsCSV is a tiny Kite instrument dump: the NIFTY index and future, and one
// stock with its future.
const fakeInstrumentsCSV = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n" +
	"256265,1001,NIFTY 50,\"NIFTY 50\",0,,0,0,0,EQ,INDICES,NSE\n" +
	"13238786,51714,NIFTY26NOVFUT,\"NIFTY\",0,2026-11-24,0,0.1,75,FUT,NFO-FUT,NFO\n" +
	"738561,2885,RELIANCE,\"RELIANCE INDUSTRIES\",0,,0,0.05,1,EQ,NSE,NSE\n" +
	"16801794,65632,RELIANCE26NOVFUT,\"RELIANCE\",0,2026-11-24,0,0.1,500,FUT,NFO-FUT,NFO\n"

// fakeHTTP is a loopback server that records request lines. Kite: /instruments answers
// the CSV, everything else 404 JSON. Dhan and Yahoo: everything 503.
type fakeHTTP struct {
	srv *httptest.Server
	mu  sync.Mutex
	got []string
}

func newFakeHTTP(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) *fakeHTTP {
	t.Helper()
	f := &fakeHTTP{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.got = append(f.got, r.Method+" "+r.URL.Path)
		f.mu.Unlock()
		handle(w, r)
	}))
	return f
}

func (f *fakeHTTP) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.got...)
}

func fakeKiteHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/instruments" {
		w.Header().Set("Content-Type", "text/csv")
		_, _ = io.WriteString(w, fakeInstrumentsCSV)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_, _ = io.WriteString(w, `{"status":"error","message":"not served by the fake","error_type":"GeneralException"}`)
}

func unavailableHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = io.WriteString(w, "fake: unavailable")
}

// fakeTicker replaces the Kite ticker WebSocket: it records every connect and
// subscription and never opens; a test may fire a socket's callbacks itself (never
// from inside connect, as ticker.Connect never does).
type fakeTicker struct {
	mu      sync.Mutex
	events  []string
	sockets []ticker.Options
}

type fakeHandle struct {
	t  *fakeTicker
	id int
}

func (f *fakeTicker) connect(o ticker.Options) ticker.Handle {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := len(f.sockets)
	f.sockets = append(f.sockets, o)
	f.events = append(f.events, fmt.Sprintf("connect#%d %v", id, o.Tokens))
	return &fakeHandle{t: f, id: id}
}

// socket returns the callbacks of the id-th socket.
func (f *fakeTicker) socket(id int) ticker.Options {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sockets[id]
}

func (f *fakeTicker) log() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}

func containsEvent(events []string, e string) bool {
	for _, x := range events {
		if x == e {
			return true
		}
	}
	return false
}

func (h *fakeHandle) record(s string) {
	h.t.mu.Lock()
	h.t.events = append(h.t.events, fmt.Sprintf("%s#%d", s, h.id))
	h.t.mu.Unlock()
}
func (h *fakeHandle) Close()                { h.record("close") }
func (h *fakeHandle) Subscribe(t []int64)   { h.record(fmt.Sprintf("subscribe%v", t)) }
func (h *fakeHandle) Unsubscribe(t []int64) { h.record(fmt.Sprintf("unsubscribe%v", t)) }

// recorder is the App's trace hook.
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) with(prefix string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, e := range r.events {
		if strings.HasPrefix(e, prefix) {
			out = append(out, strings.TrimPrefix(e, prefix))
		}
	}
	return out
}

func (r *recorder) has(e string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.events {
		if x == e {
			return true
		}
	}
	return false
}

func (r *recorder) reset() {
	r.mu.Lock()
	r.events = nil
	r.mu.Unlock()
}

// Credentials of the test environment.
const (
	testAdminSecret  = "admin-secret"
	testAccessSecret = "access-secret"
	testFrontend     = "http://127.0.0.1:5173"
)

type harnessOptions struct {
	db  bool              // a fresh migrated PostgreSQL schema (dbtest.New)
	env map[string]string // extra environment
	// seed runs against the pool before the App is built.
	seed func(t *testing.T, pool *db.Pool)
	// kite replaces the fake Kite REST handler.
	kite http.HandlerFunc
	// dhan replaces the unavailable Dhan REST/master fixture.
	dhan         http.HandlerFunc
	analyticsNow func() time.Time
}

type harness struct {
	t        *testing.T
	app      *App
	base     string
	pool     *db.Pool
	kite     *fakeHTTP
	dhan     *fakeHTTP
	yahoo    *fakeHTTP
	ticker   *fakeTicker
	trace    *recorder
	client   *http.Client
	outbound []*http.Transport // the App's clients to the fakes
	baseline int               // goroutines before New
	served   chan error
	shutDown bool
}

func newHarness(t *testing.T, o harnessOptions) *harness {
	t.Helper()
	h := &harness{t: t, ticker: &fakeTicker{}, trace: &recorder{}, served: make(chan error, 1)}
	kiteHandler := fakeKiteHandler
	if o.kite != nil {
		kiteHandler = o.kite
	}
	h.kite = newFakeHTTP(t, kiteHandler)
	dhanHandler := unavailableHandler
	if o.dhan != nil {
		dhanHandler = o.dhan
	}
	h.dhan = newFakeHTTP(t, dhanHandler)
	h.yahoo = newFakeHTTP(t, unavailableHandler)
	t.Cleanup(func() {
		h.kite.srv.Close()
		h.dhan.srv.Close()
		h.yahoo.srv.Close()
	})
	if o.db {
		h.pool = dbtest.New(t)
		if o.seed != nil {
			o.seed(t, h.pool)
		}
	}
	env := map[string]string{
		"DEFAULT_BROKER":  "zerodha", // explicit starting broker for retained Kite cases
		"KITE_API_KEY":    "test-api-key",
		"KITE_API_SECRET": "test-api-secret",
		"ADMIN_SECRET":    testAdminSecret,
		"ACCESS_SECRET":   testAccessSecret,
		"FRONTEND_URL":    testFrontend,
	}
	for k, v := range o.env {
		env[k] = v
	}
	lookup := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	newTransport := func() *http.Transport {
		tr := &http.Transport{}
		h.outbound = append(h.outbound, tr)
		return tr
	}
	h.client = &http.Client{Transport: &http.Transport{}, Timeout: 20 * time.Second}
	h.baseline = runtime.NumGoroutine()

	a, err := New(config.Load(config.MapGetter(env)), Options{
		Pool:           h.pool,
		LookupEnv:      lookup,
		KiteAPIRoot:    h.kite.srv.URL,
		KiteLoginRoot:  h.kite.srv.URL + "/connect/login",
		KiteHTTPClient: &http.Client{Transport: newTransport()},
		TickerConnect:  h.ticker.connect,
		KiteTickerURL:  "ws://127.0.0.1:1",
		Dhan: registry.DhanConfig{
			APIRoot:         h.dhan.srv.URL + "/v2",
			AuthRoot:        h.dhan.srv.URL,
			FeedURL:         "ws://127.0.0.1:1",
			ScripMasterURLs: []string{h.dhan.srv.URL + "/scrip-master.csv"},
			HTTPClient:      &http.Client{Transport: newTransport()},
		},
		YahooChartRoot:  h.yahoo.srv.URL,
		YahooHTTPClient: &http.Client{Transport: newTransport()},
		AnalyticsNow:    o.analyticsNow,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	a.trace = h.trace.add
	h.app = a

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.base = "http://" + l.Addr().String()
	go func() { h.served <- a.Serve(l) }()
	t.Cleanup(func() {
		if !h.shutDown {
			h.shutdown("cleanup")
		}
	})
	return h
}

// shutdown runs the App's shutdown, then drops every idle client connection so the
// goroutine count can return to the baseline.
func (h *harness) shutdown(signal string) lifecycle.Result {
	h.t.Helper()
	h.shutDown = true
	res := h.app.Shutdown(context.Background(), signal)
	select {
	case err := <-h.served:
		if err != http.ErrServerClosed {
			h.t.Errorf("Serve returned %v, want http.ErrServerClosed", err)
		}
	case <-time.After(5 * time.Second):
		h.t.Errorf("Serve did not return after Shutdown")
	}
	h.closeIdle()
	return res
}

func (h *harness) closeIdle() {
	h.client.CloseIdleConnections()
	for _, tr := range h.outbound {
		tr.CloseIdleConnections()
	}
}

// waitGoroutines waits until at most baseline+tolerance goroutines remain.
func (h *harness) waitGoroutines(tolerance int) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		n := runtime.NumGoroutine()
		if n <= h.baseline+tolerance {
			return
		}
		if time.Now().After(deadline) {
			buf := make([]byte, 1<<20)
			buf = buf[:runtime.Stack(buf, true)]
			h.t.Fatalf("goroutines: %d after shutdown, baseline %d (+%d allowed)\n%s", n, h.baseline, tolerance, buf)
		}
		h.closeIdle()
		time.Sleep(20 * time.Millisecond)
	}
}

type response struct {
	status int
	header http.Header
	body   string
}

// do sends one request to the App. token is the x-admin-token ("" for none).
func (h *harness) do(method, path, token, body string, extra ...[2]string) response {
	h.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, h.base+path, rd)
	if err != nil {
		h.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("x-admin-token", token)
	}
	for _, kv := range extra {
		req.Header.Set(kv[0], kv[1])
	}
	resp, err := h.client.Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatalf("%s %s: read: %v", method, path, err)
	}
	return response{status: resp.StatusCode, header: resp.Header, body: string(b)}
}

// login returns an admin token of the role the secret grants.
func (h *harness) login(path, secret string) string {
	h.t.Helper()
	r := h.do("POST", path, "", `{"secret":"`+secret+`"}`)
	if r.status != 200 {
		h.t.Fatalf("POST %s = %d %s", path, r.status, r.body)
	}
	var v struct {
		Success bool   `json:"success"`
		Token   string `json:"token"`
	}
	if err := json.Unmarshal([]byte(r.body), &v); err != nil || !v.Success || v.Token == "" {
		h.t.Fatalf("POST %s body %s (%v)", path, r.body, err)
	}
	return v.Token
}

func (h *harness) fullToken() string  { return h.login("/api/admin/verify", testAdminSecret) }
func (h *harness) tradeToken() string { return h.login("/api/access/verify", testAccessSecret) }

// expect checks status and exact body.
func expect(t *testing.T, what string, r response, status int, body string) {
	t.Helper()
	if r.status != status || r.body != body {
		t.Errorf("%s:\n got %d %s\nwant %d %s", what, r.status, r.body, status, body)
	}
}

// topKeys lists the keys of a JSON object in document order.
func topKeys(t *testing.T, body string) []string {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		t.Fatalf("not an object: %s", body)
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, tok.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}

// sseFrame reads one SSE frame (up to the blank line).
func sseFrame(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	var b strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("SSE read: %v (so far %q)", err, b.String())
		}
		b.WriteString(line)
		if line == "\n" {
			return b.String()
		}
	}
}
