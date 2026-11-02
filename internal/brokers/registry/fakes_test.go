package registry

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Test doubles shared by the registry tests. They mirror the fakes of
// testdata/gen_registry.mjs one for one, so a scenario recorded from the TypeScript can
// be replayed here: every call the registry makes on Kite, the hub and the hooks is
// recorded as the same event string, and every outbound Dhan HTTP request in the same
// "<host> <METHOD> <path> <headers> <body>" form.

// recorder collects event strings.
type recorder struct {
	mu     sync.Mutex
	events []string
}

func (r *recorder) add(format string, args ...any) {
	r.mu.Lock()
	r.events = append(r.events, fmt.Sprintf(format, args...))
	r.mu.Unlock()
}

func (r *recorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.events
	r.events = nil
	if out == nil {
		out = []string{}
	}
	return out
}

func intsJSON(t []int64) string { return string(jsjson.Marshal(t)) }

// fakeClock is a settable epoch-ms clock.
type fakeClock struct{ ms atomic.Int64 }

func (c *fakeClock) Now() time.Time       { return time.UnixMilli(c.ms.Load()) }
func (c *fakeClock) set(ms int64)         { c.ms.Store(ms) }
func (c *fakeClock) advance(d int64)      { c.ms.Add(d) }
func newClock(ms int64) *fakeClock        { c := &fakeClock{}; c.set(ms); return c }
func (c *fakeClock) fn() func() time.Time { return c.Now }

// fakeEnv is process.env: unset and empty are different.
type fakeEnv struct {
	mu sync.Mutex
	m  map[string]string
}

func newEnv(m map[string]string) *fakeEnv {
	e := &fakeEnv{m: map[string]string{}}
	for k, v := range m {
		e.m[k] = v
	}
	return e
}

func (e *fakeEnv) lookup(k string) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	v, ok := e.m[k]
	return v, ok
}

func (e *fakeEnv) set(k, v string) { e.mu.Lock(); e.m[k] = v; e.mu.Unlock() }
func (e *fakeEnv) unset(k string)  { e.mu.Lock(); delete(e.m, k); e.mu.Unlock() }

// fakeKite is the generator's kite fake.
type fakeKite struct {
	rec   *recorder
	mu    sync.Mutex
	token *string
	rows  []market.Instrument
}

func (k *fakeKite) setToken(t *string) { k.mu.Lock(); k.token = t; k.mu.Unlock() }
func (k *fakeKite) HasSession() bool   { k.mu.Lock(); defer k.mu.Unlock(); return k.token != nil }
func (k *fakeKite) APIKey() string     { return "kite-key" }
func (k *fakeKite) AccessToken() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.token == nil {
		return ""
	}
	return *k.token
}

func (k *fakeKite) GetQuoteFull(_ context.Context, ids []string) ([]kite.FullQuote, error) {
	k.rec.add("kite:quote %s", jsjson.Marshal(ids))
	out := make([]kite.FullQuote, len(ids))
	for i := range ids {
		ltt := "2026-10-28 09:15:00"
		if i == 0 {
			ltt = ""
		}
		out[i] = kite.FullQuote{InstrumentToken: int64(100 + i), LastPrice: float64(10 + i), Close: 9, OI: float64(i), LastTradeTime: ltt}
	}
	return out, nil
}

func (k *fakeKite) GetBasketMargin(_ context.Context, orders []kite.BasketOrder, considerPositions bool) (kite.BasketMarginResult, error) {
	k.rec.add("kite:basket %s %t", jsjson.Marshal(orders), considerPositions)
	return kite.BasketMarginResult{Initial: 1, Final: 2, Total: 2}, nil
}

func (k *fakeKite) GetInstruments(context.Context, string) ([]market.Instrument, error) {
	k.rec.add("kite:instruments")
	return append([]market.Instrument(nil), k.rows...), nil
}

func (k *fakeKite) GetHistoricalFull(_ context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.HistoricalCandle, error) {
	k.rec.add("kite:historicalFull %d %s %s %s %s", token, from, to, interval, prio)
	return []kite.HistoricalCandle{{Date: "2026-10-27", Open: 1, High: 2, Low: 0, Close: 1.5, Volume: 10, OI: 3}}, nil
}

func (k *fakeKite) GetHistorical(_ context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error) {
	k.rec.add("kite:historical %d %s %s %s %s", token, from, to, interval, prio)
	return []kite.ClosePoint{{T: "2026-10-27T09:15:00+0530", Close: 1.5}}, nil
}

func (k *fakeKite) GetHistoricalOi(_ context.Context, token int64, from, to string, prio kite.HistoricalPriority) ([]kite.DayOI, error) {
	k.rec.add("kite:historicalOi %d %s %s %s", token, from, to, prio)
	return []kite.DayOI{{Date: "2026-10-27", Close: 1.5, OI: 3}}, nil
}

func (k *fakeKite) GetHistoricalOiSeries(_ context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.OISeriesPoint, error) {
	k.rec.add("kite:historicalOiSeries %d %s %s %s %s", token, from, to, interval, prio)
	return []kite.OISeriesPoint{{T: "2026-10-27T09:15:00+0530", Close: 1.5, OI: 3}}, nil
}

// fakeHub records the hub calls.
type fakeHub struct {
	rec        *recorder
	connected  atomic.Bool
	subscribed atomic.Int64
}

func (h *fakeHub) IsConnected() bool                       { return h.connected.Load() }
func (h *fakeHub) SubscribedCount() int                    { return int(h.subscribed.Load()) }
func (h *fakeHub) SubscribeTokens(t []int64)               { h.rec.add("hub:subscribe %s", intsJSON(t)) }
func (h *fakeHub) UnsubscribeTokens(t []int64)             { h.rec.add("hub:unsubscribe %s", intsJSON(t)) }
func (h *fakeHub) Stop()                                   { h.rec.add("hub:stop") }
func (h *fakeHub) IngestExternalTicks(ticks []market.Tick) { h.rec.add("hub:ingest %d", len(ticks)) }
func (h *fakeHub) SetExternalConnected(c bool)             { h.rec.add("hub:external %t", c) }

// recordingHooks are the generator's attach() hooks and constructor callbacks.
func recordingHooks(rec *recorder) Hooks {
	return Hooks{
		StopScanner:            func() { rec.add("stopScanner") },
		InvalidateBooks:        func() { rec.add("invalidateBooks") },
		ReloadUniverse:         func(context.Context) error { rec.add("reloadUniverse"); return nil },
		Publish:                func() { rec.add("publish") },
		DropMarketDataSessions: func() int { rec.add("dropSessions"); return 0 },
		OnBrokerChanged:        func(b brokers.ID) { rec.add("changed %s", b) },
		OnBoxLaneTicks:         func(t []market.Tick) { rec.add("boxLaneTicks %d", len(t)) },
		OnBoxLaneConnection:    func(c bool) { rec.add("boxLaneConnection %t", c) },
		OnSessionLost:          func(b brokers.ID, reason string) { rec.add("sessionLost %s %s", b, reason) },
	}
}

// fixedSessions is an auth.Persistence holding the generator's two admin tokens.
type fixedSessions struct{ expiry int64 }

func (fixedSessions) SaveAdminSession(context.Context, string, auth.Role, int64) error { return nil }
func (fixedSessions) DeleteAdminSession(context.Context, string) error                 { return nil }
func (f fixedSessions) LoadAdminSessions(context.Context, int64) ([]auth.StoredSession, error) {
	return []auth.StoredSession{
		{Token: "full-token", Role: auth.RoleFull, ExpiryMs: f.expiry},
		{Token: "trade-token", Role: auth.RoleTrade, ExpiryMs: f.expiry},
	}, nil
}

func newSessions(t *testing.T, clock *fakeClock) *auth.Sessions {
	t.Helper()
	s := auth.NewSessions(fixedSessions{expiry: clock.ms.Load() + 365*86_400_000}, clock.Now)
	s.SetBackground(func(f func()) { f() })
	if _, err := s.Restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

// httpSpec is one canned response of the fake Dhan hosts.
type httpSpec struct {
	Status  int               `json:"status"`
	Body    json.RawMessage   `json:"body"`
	Headers map[string]string `json:"headers"`
	Echo    string            `json:"echo"`
}

// fakeDhan serves the Dhan API (/v2), auth (/auth) and scrip-master (/master/...) hosts
// from per-key response queues (the last response repeats), and records each request.
type fakeDhan struct {
	srv *httptest.Server

	mu     sync.Mutex
	queues map[string][]httpSpec
	out    []string
	// masterServed is set once a scrip master was served successfully.
	masterServed *atomic.Bool
}

var recordedHeaders = []string{"accept", "access-token", "app_id", "app_secret", "client-id", "content-type"}

func newFakeDhan(t *testing.T, specs map[string][]httpSpec, masterServed *atomic.Bool) *fakeDhan {
	t.Helper()
	f := &fakeDhan{queues: map[string][]httpSpec{}, masterServed: masterServed}
	for k, v := range specs {
		f.queues[k] = append([]httpSpec(nil), v...)
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeDhan) apiRoot() string  { return f.srv.URL + "/v2" }
func (f *fakeDhan) authRoot() string { return f.srv.URL + "/auth" }
func (f *fakeDhan) masterURLs() []string {
	return []string{f.srv.URL + "/master/detailed", f.srv.URL + "/master/plain"}
}

func (f *fakeDhan) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	uri := r.URL.RequestURI()
	var host, key, path string
	switch {
	case strings.HasPrefix(uri, "/v2/"):
		host, path = "api", strings.TrimPrefix(uri, "/v2")
		key = "api " + r.Method + " " + strings.SplitN(path, "?", 2)[0]
	case strings.HasPrefix(uri, "/auth/"):
		host, path = "auth", strings.TrimPrefix(uri, "/auth")
		key = "auth " + r.Method + " " + strings.SplitN(path, "?", 2)[0]
	case strings.HasPrefix(uri, "/master/"):
		host, path = "master", strings.TrimPrefix(uri, "/master/")
		key = "master " + r.Method + " " + path
	default:
		http.Error(w, "unexpected", http.StatusTeapot)
		return
	}
	hdr := map[string]string{}
	for _, name := range recordedHeaders {
		if vals := r.Header.Values(name); len(vals) > 0 {
			hdr[name] = strings.Join(vals, ", ")
		}
	}
	f.mu.Lock()
	f.out = append(f.out, fmt.Sprintf("%s %s %s %s %s", host, r.Method, path, jsjson.Marshal(hdr), body))
	var spec *httpSpec
	if q := f.queues[key]; len(q) > 0 {
		s := q[0]
		if len(q) > 1 {
			f.queues[key] = q[1:]
		}
		spec = &s
	}
	f.mu.Unlock()

	if spec == nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "not found")
		return
	}
	if spec.Echo != "" {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(echo(spec.Echo, body))
		return
	}
	for k, v := range spec.Headers {
		w.Header().Set(k, v)
	}
	text := []byte(spec.Body)
	var s string
	if json.Unmarshal(spec.Body, &s) == nil {
		text = []byte(s) // a string body is sent as is, like Node's spec.body
	}
	if host == "master" && spec.Status == 200 && f.masterServed != nil {
		f.masterServed.Store(true)
	}
	w.WriteHeader(spec.Status)
	_, _ = w.Write(text)
}

func (f *fakeDhan) takeOut() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.out
	f.out = nil
	sort.Strings(out)
	if out == nil {
		out = []string{}
	}
	return out
}

/* --------------------------- deterministic echoes --------------------------- */
// Mirrors ECHO in gen_registry.mjs.

type orderedObject struct {
	keys []string
	vals map[string]string
}

func (o *orderedObject) set(k, raw string) {
	if o.vals == nil {
		o.vals = map[string]string{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = raw
}

func (o *orderedObject) String() string {
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(jsjson.Marshal(k))
		b.WriteByte(':')
		b.WriteString(o.vals[k])
	}
	b.WriteByte('}')
	return b.String()
}

func quoteEntryJSON(id int64, depth string, withLTT bool, lastPrice string) string {
	ltt := ""
	if withLTT {
		ltt = fmt.Sprintf(`"last_trade_time":"2026-10-28 10:00:%02d",`, id%60)
	}
	if lastPrice == "" {
		lastPrice = strconv.FormatInt(100+id%7, 10)
	}
	if depth == "" {
		depth = `{"buy":[{"quantity":10,"orders":2,"price":99.5},{"quantity":5,"orders":1,"price":0}],"sell":[{"quantity":12,"orders":3,"price":100.5}]}`
	}
	return fmt.Sprintf(`{"last_price":%s,"last_quantity":1,%s"average_price":100,"volume":%d,"oi":%d,"net_change":0,`+
		`"ohlc":{"open":1,"close":%d,"high":2,"low":0},"depth":%s}`, lastPrice, ltt, id%1000, id%100, 99+id%3, depth)
}

func echo(kind string, body []byte) []byte {
	switch kind {
	case "quote":
		var req map[string][]int64
		_ = json.Unmarshal(body, &req)
		var seg string
		for k := range req {
			seg = k
		}
		var entries orderedObject
		for _, id := range req[seg] {
			key := strconv.FormatInt(id, 10)
			if id == 60010 {
				key = "060010"
			}
			switch id {
			case 60500:
				entries.set(key, `"junk"`)
			case 61001:
				entries.set(key, `null`)
			case 60001:
				entries.set(key, quoteEntryJSON(id, `{"buy":[],"sell":[{"quantity":1,"orders":1,"price":0}]}`, true, ""))
			case 60002:
				entries.set(key, quoteEntryJSON(id, `null`, true, ""))
			case 60998:
				entries.set(key, quoteEntryJSON(id, `{"buy":[null,{"price":1}],"sell":[]}`, true, ""))
			case 438:
				entries.set(key, quoteEntryJSON(id, "", false, `"1234.5"`))
			default:
				entries.set(key, quoteEntryJSON(id, "", true, ""))
			}
		}
		entries.set("1", `{"last_price":1}`)
		return []byte(fmt.Sprintf(`{"status":"success","data":{%s:%s}}`, jsjson.Marshal(seg), entries.String()))
	case "intraday", "daily":
		var req struct {
			FromDate string `json:"fromDate"`
			ToDate   string `json:"toDate"`
			Interval string `json:"interval"`
		}
		_ = json.Unmarshal(body, &req)
		from, _ := time.Parse("2006-01-02", req.FromDate)
		to, _ := time.Parse("2006-01-02", req.ToDate)
		cols := map[string][]string{}
		push := func(k string, v any) { cols[k] = append(cols[k], string(jsjson.Marshal(v))) }
		names := []string{"open", "high", "low", "close", "volume", "timestamp", "open_interest"}
		for _, n := range names {
			cols[n] = []string{}
		}
		if kind == "intraday" {
			step, _ := strconv.ParseInt(req.Interval, 10, 64)
			step *= 60
			i := int64(0)
			for d := from.UnixMilli(); d <= to.UnixMilli(); d += 86_400_000 {
				for k := int64(0); k < 3; k++ {
					push("timestamp", d/1000+3*3600+45*60+k*step)
					push("open", i+k)
					push("high", i+k+1)
					push("low", i+k-1)
					push("close", float64(i+k)+0.5)
					push("volume", 10*k)
					push("open_interest", 1000+k)
				}
				i++
			}
			if req.Interval == "60" {
				delete(cols, "open_interest")
			}
		} else {
			i := int64(0)
			for d := to.UnixMilli(); d >= from.UnixMilli(); d -= 86_400_000 {
				push("timestamp", d/1000-19800)
				push("open", i)
				push("high", i+2)
				push("low", i-2)
				if i == 0 {
					cols["close"] = append(cols["close"], "null")
				} else {
					push("close", float64(i)+0.25)
				}
				push("volume", i*100)
				push("open_interest", 5000+i)
				i++
			}
			cols["timestamp"] = append(cols["timestamp"], `"bad"`)
		}
		var o orderedObject
		for _, n := range names {
			if v, ok := cols[n]; ok {
				o.set(n, "["+strings.Join(v, ",")+"]")
			}
		}
		return []byte(o.String())
	}
	return []byte("null")
}

/* ------------------------------- the sockets ------------------------------- */

// blackHole accepts WebSocket handshakes and never answers them, like the generator's
// FakeWebSocket that never opens: the Dhan feed stays "connecting". It records each
// handshake as the URL Node would have opened.
type blackHole struct {
	ln    net.Listener
	mu    sync.Mutex
	urls  []string
	conns []net.Conn
}

func newBlackHole(t *testing.T) *blackHole {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	b := &blackHole{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			b.mu.Lock()
			b.conns = append(b.conns, c)
			b.mu.Unlock()
			go b.handle(c)
		}
	}()
	t.Cleanup(b.close)
	return b
}

func (b *blackHole) handle(c net.Conn) {
	r := bufio.NewReader(c)
	line, err := r.ReadString('\n')
	if err != nil {
		return
	}
	parts := strings.Fields(line)
	if len(parts) >= 2 {
		b.mu.Lock()
		b.urls = append(b.urls, "wss://api-feed.dhan.co"+strings.TrimPrefix(parts[1], "/"))
		b.mu.Unlock()
	}
	_, _ = io.Copy(io.Discard, r) // hold the connection until the client goes away
}

func (b *blackHole) url() string { return "ws://" + b.ln.Addr().String() }

func (b *blackHole) waitFor(n int, timeout time.Duration) []string {
	deadline := time.Now().Add(timeout)
	for {
		b.mu.Lock()
		got := append([]string(nil), b.urls...)
		b.mu.Unlock()
		if len(got) >= n || time.Now().After(deadline) {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (b *blackHole) close() {
	_ = b.ln.Close()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, c := range b.conns {
		_ = c.Close()
	}
}

// kiteSockets is a ticker.ConnectFunc that records the URL connectTicker would open and
// hands back a handle that never opens.
type kiteSockets struct {
	mu   sync.Mutex
	urls []string
}

type idleHandle struct{}

func (idleHandle) Close()              {}
func (idleHandle) Subscribe([]int64)   {}
func (idleHandle) Unsubscribe([]int64) {}

func (k *kiteSockets) connect(o ticker.Options) ticker.Handle {
	k.mu.Lock()
	k.urls = append(k.urls, "wss://ws.kite.trade?api_key="+kite.EncodeURIComponent(o.APIKey)+
		"&access_token="+kite.EncodeURIComponent(o.AccessToken))
	k.mu.Unlock()
	return idleHandle{}
}

func (k *kiteSockets) list() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]string{}, k.urls...)
}
