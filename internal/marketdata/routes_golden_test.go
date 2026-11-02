package marketdata

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// The golden replay: testdata/gen_routes.mjs drove the ORIGINAL src/marketDataRoutes.ts
// (with the real session store, quote cache and TickerHub, and index.ts's requireFullAdmin
// and sendError) through scripted steps. TestRoutesGolden replays every step against the Go
// routes over real HTTP (server.New + Mount + the Go hub) with equivalent fake broker
// deps, and compares, step by step: status and exact JSON body, the SSE headers, every
// frame each open stream received, every call the routes made to their deps in order, the
// session store's stats, the hub's onDead calls and Kite-session clears.

type goldenOp struct {
	Op      string                     `json:"op"`
	Method  string                     `json:"method"`
	Path    string                     `json:"path"`
	Query   *string                    `json:"query"`
	Body    *string                    `json:"body"`
	Headers map[string]string          `json:"headers"`
	Session *int                       `json:"session"`
	ID      *string                    `json:"id"`
	Stream  string                     `json:"stream"`
	Ticks   json.RawMessage            `json:"ticks"`
	Tokens  []int64                    `json:"tokens"`
	Ms      int64                      `json:"ms"`
	Set     map[string]json.RawMessage `json:"set"`
}

type goldenStep struct {
	Op           goldenOp            `json:"op"`
	Status       *int                `json:"status"`
	Body         *string             `json:"body"`
	SSE          bool                `json:"sse"`
	Headers      [][2]string         `json:"headers"`
	Flushed      bool                `json:"flushed"`
	Events       []string            `json:"events"`
	Frames       map[string][]string `json:"frames"`
	Sessions     SessionStats        `json:"sessions"`
	Dead         int                 `json:"dead"`
	ClearSession int                 `json:"clearSession"`
}

type goldenScenario struct {
	Name  string                     `json:"name"`
	Start int64                      `json:"start"`
	State map[string]json.RawMessage `json:"state"`
	Steps []goldenStep               `json:"steps"`
}

func loadRoutesGolden(t *testing.T) []goldenScenario {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "routes.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/marketdata/testdata/gen_routes.mjs)", err)
	}
	var g struct {
		Scenarios []goldenScenario `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g.Scenarios
}

// decodeTick reads a scripted tick, keeping "present but empty" bids/asks apart from
// absent ones (Node wrote whatever own properties the object had).
func decodeTick(t *testing.T, raw json.RawMessage) market.Tick {
	t.Helper()
	var o map[string]json.RawMessage
	if err := json.Unmarshal(raw, &o); err != nil {
		t.Fatal(err)
	}
	num := func(k string) float64 {
		var f float64
		if v, ok := o[k]; ok {
			if err := json.Unmarshal(v, &f); err != nil {
				t.Fatalf("%s: %v", k, err)
			}
		}
		return f
	}
	levels := func(v json.RawMessage) []market.DepthLevel {
		var ls []market.DepthLevel
		if err := json.Unmarshal(v, &ls); err != nil {
			t.Fatal(err)
		}
		if ls == nil {
			ls = []market.DepthLevel{}
		}
		return ls
	}
	tk := market.Tick{Token: int64(num("token")), LastPrice: num("last_price"), ClosePrice: num("close_price"),
		OI: num("oi"), Bid: num("bid"), Ask: num("ask")}
	if v, ok := o["bids"]; ok {
		tk.Bids = levels(v)
	}
	if v, ok := o["asks"]; ok {
		tk.Asks = levels(v)
	}
	if v, ok := o["depth_updated"]; ok {
		var b bool
		if err := json.Unmarshal(v, &b); err != nil {
			t.Fatal(err)
		}
		tk.DepthUpdated = &b
	}
	if _, ok := o["exchange_ts"]; ok {
		ts := int64(num("exchange_ts"))
		tk.ExchangeTS = &ts
	}
	return tk
}

func decodeTicks(t *testing.T, raw json.RawMessage) []market.Tick {
	t.Helper()
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	out := []market.Tick{}
	for _, r := range list {
		out = append(out, decodeTick(t, r))
	}
	return out
}

func jsonInts(ts []int64) string {
	b := []byte{'['}
	for i, v := range ts {
		if i > 0 {
			b = append(b, ',')
		}
		b = strconv.AppendInt(b, v, 10)
	}
	return string(append(b, ']'))
}

// fakeBroker is the scripted broker-manager state of gen_routes.mjs.
type fakeBroker struct {
	Broker     brokers.ID
	Generation int
	DataReady  bool
	Problems   []string
	Owned      map[int64]bool // nil: universe not loaded, every token accepted
	Quotes     map[int64]market.Tick
	QuoteError *struct {
		Kind    string `json:"kind"`
		Status  int    `json:"status"`
		Message string `json:"message"`
	}
	Feed      brokers.FeedHealth
	Subs      brokers.Stats
	BoxSubs   brokers.Stats
	Upstream  UpstreamStats
	Lanes     struct{ Futures, Box brokers.LaneFeedStats }
	BoardSize json.RawMessage
}

func (f *fakeBroker) apply(t *testing.T, set map[string]json.RawMessage) {
	t.Helper()
	dec := func(raw json.RawMessage, v any) {
		if err := json.Unmarshal(raw, v); err != nil {
			t.Fatalf("state %s: %v", raw, err)
		}
	}
	for k, raw := range set {
		switch k {
		case "broker":
			dec(raw, &f.Broker)
		case "generation":
			dec(raw, &f.Generation)
		case "dataReady":
			dec(raw, &f.DataReady)
		case "problems":
			f.Problems = nil
			dec(raw, &f.Problems)
		case "owned":
			var list *[]int64
			dec(raw, &list)
			f.Owned = nil
			if list != nil {
				f.Owned = map[int64]bool{}
				for _, v := range *list {
					f.Owned[v] = true
				}
			}
		case "quotes":
			var m map[string]json.RawMessage
			dec(raw, &m)
			f.Quotes = map[int64]market.Tick{}
			for key, tr := range m {
				tok, err := strconv.ParseInt(key, 10, 64)
				if err != nil {
					t.Fatal(err)
				}
				f.Quotes[tok] = decodeTick(t, tr)
			}
		case "quoteError":
			f.QuoteError = nil
			dec(raw, &f.QuoteError)
		case "feed":
			f.Feed = brokers.FeedHealth{}
			dec(raw, &f.Feed)
		case "subs":
			dec(raw, &f.Subs)
		case "boxSubs":
			dec(raw, &f.BoxSubs)
		case "upstream":
			f.Upstream = UpstreamStats{}
			dec(raw, &f.Upstream)
		case "lanes":
			dec(raw, &f.Lanes)
		case "boardSize":
			f.BoardSize = append(json.RawMessage(nil), raw...)
		default:
			t.Fatalf("unknown state key %q", k)
		}
	}
}

// replay holds one scenario's fakes and recordings.
type replay struct {
	t *testing.T

	mu           sync.Mutex
	st           fakeBroker
	clock        int64
	events       []string
	lastAssert   string // context of events[len-1] when it is an assert
	assertTokens []int64
	ids          []string // session index -> Go id
	dead         int
	clears       int
	sockets      []ticker.Options
	pingers      []*fakePinger

	hub   *hub.Hub
	store *SessionStore
}

type fakePinger struct{ c chan time.Time }

func (rp *replay) now() time.Time {
	rp.mu.Lock()
	defer rp.mu.Unlock()
	return time.UnixMilli(rp.clock)
}

func (rp *replay) record(e string) {
	rp.mu.Lock()
	rp.events = append(rp.events, e)
	rp.lastAssert = ""
	rp.mu.Unlock()
}

func (rp *replay) recordAssert(ctx string, token int64) {
	rp.mu.Lock()
	defer rp.mu.Unlock()
	if rp.lastAssert == ctx && len(rp.events) > 0 {
		rp.assertTokens = append(rp.assertTokens, token)
		rp.events[len(rp.events)-1] = "assert " + ctx + " " + jsonInts(rp.assertTokens)
		return
	}
	rp.lastAssert = ctx
	rp.assertTokens = []int64{token}
	rp.events = append(rp.events, "assert "+ctx+" "+jsonInts(rp.assertTokens))
}

func (rp *replay) takeEvents() []string {
	rp.mu.Lock()
	defer rp.mu.Unlock()
	out := rp.events
	rp.events, rp.lastAssert, rp.assertTokens = nil, "", nil
	return out
}

func (rp *replay) eventCount() int {
	rp.mu.Lock()
	defer rp.mu.Unlock()
	return len(rp.events)
}

func (rp *replay) placeholder(id string) string {
	for i, v := range rp.ids {
		if v == id {
			return fmt.Sprintf("<s%d>", i)
		}
	}
	return id
}

var sessionLabel = regexp.MustCompile(`^session ([0-9a-f]{8})…$`)

func (rp *replay) labelOf(ctx string) string {
	m := sessionLabel.FindStringSubmatch(ctx)
	if m == nil {
		return ctx
	}
	rp.mu.Lock()
	defer rp.mu.Unlock()
	for i, id := range rp.ids {
		if strings.HasPrefix(id, m[1]) {
			return fmt.Sprintf("session <s%d>…", i)
		}
	}
	return ctx
}

// recordingSessions wraps the real store and logs every call the routes make.
type recordingSessions struct{ rp *replay }

func (s recordingSessions) Create(tokens []int64, broker brokers.ID, generation int) Session {
	sess := s.rp.store.Create(tokens, broker, generation)
	s.rp.mu.Lock()
	s.rp.ids = append(s.rp.ids, sess.ID)
	n := len(s.rp.ids) - 1
	s.rp.mu.Unlock()
	s.rp.record(fmt.Sprintf("create %s %s %d -> <s%d>", jsonInts(tokens), broker, generation, n))
	return sess
}

func (s recordingSessions) Resolve(id string, broker brokers.ID, generation int) (Session, Rejection) {
	sess, rej := s.rp.store.Resolve(id, broker, generation)
	outcome := "ok"
	if rej != RejectNone {
		outcome = string(rej)
	}
	s.rp.mu.Lock()
	ph := s.rp.placeholder(id)
	s.rp.mu.Unlock()
	s.rp.record(fmt.Sprintf("resolve %s %s %d -> %s", ph, broker, generation, outcome))
	return sess, rej
}

func (s recordingSessions) Open(id string) {
	s.rp.mu.Lock()
	ph := s.rp.placeholder(id)
	s.rp.mu.Unlock()
	s.rp.record("open " + ph)
	s.rp.store.Open(id)
}

func (s recordingSessions) Close(id string) {
	s.rp.mu.Lock()
	ph := s.rp.placeholder(id)
	s.rp.mu.Unlock()
	s.rp.record("close " + ph)
	s.rp.store.Close(id)
}

func (s recordingSessions) Stats() SessionStats { return s.rp.store.Stats() }

// recordingHub wraps the real hub and logs attach/detach/seed like gen_routes.mjs.
type recordingHub struct{ rp *replay }

func (h recordingHub) AttachClient(c hub.Client, tokens []int64) func() {
	h.rp.record("attach " + jsonInts(tokens))
	detach := h.rp.hub.AttachClient(c, tokens)
	return func() {
		h.rp.record("detach")
		detach()
	}
}

func (h recordingHub) Seed(ticks []market.Tick) {
	h.rp.record("seed " + string(hub.TicksJSON(ticks)))
	h.rp.hub.Seed(ticks)
}

type fakeSocketHandle struct{}

func (fakeSocketHandle) Close()              {}
func (fakeSocketHandle) Subscribe([]int64)   {}
func (fakeSocketHandle) Unsubscribe([]int64) {}
func (rp *replay) connect(o ticker.Options) ticker.Handle {
	rp.mu.Lock()
	rp.sockets = append(rp.sockets, o)
	rp.mu.Unlock()
	return fakeSocketHandle{}
}

func (rp *replay) deps() RouteDeps {
	return RouteDeps{
		Sessions:     recordingSessions{rp},
		Hub:          recordingHub{rp},
		ActiveBroker: func() brokers.ID { rp.mu.Lock(); defer rp.mu.Unlock(); return rp.st.Broker },
		Generation:   func() int { rp.mu.Lock(); defer rp.mu.Unlock(); return rp.st.Generation },
		DataHealth: func() (bool, []string) {
			rp.mu.Lock()
			defer rp.mu.Unlock()
			return rp.st.DataReady, append([]string(nil), rp.st.Problems...)
		},
		AssertActiveBrokerToken: func(token int64, ctx string) bool {
			rp.recordAssert(rp.labelOf(ctx), token)
			rp.mu.Lock()
			defer rp.mu.Unlock()
			return rp.st.Owned == nil || rp.st.Owned[token]
		},
		QuotesByToken: func(_ context.Context, tokens []int64) ([]market.Tick, error) {
			rp.record("quotes " + jsonInts(tokens))
			rp.mu.Lock()
			defer rp.mu.Unlock()
			if e := rp.st.QuoteError; e != nil {
				if e.Kind == "kite" {
					return nil, &kite.KiteError{Status: e.Status, Message: e.Message}
				}
				return nil, errors.New(e.Message)
			}
			out := []market.Tick{}
			for _, tok := range tokens {
				if tk, ok := rp.st.Quotes[tok]; ok {
					out = append(out, tk)
				}
			}
			return out, nil
		},
		ClearKiteSession: func() { rp.mu.Lock(); rp.clears++; rp.mu.Unlock() },
		AcquireBrowserTokens: func(tokens []int64) func() {
			rp.record("acquire " + jsonInts(tokens))
			return func() { rp.record("release") }
		},
		FeedHealth:        func() brokers.FeedHealth { rp.mu.Lock(); defer rp.mu.Unlock(); return rp.st.Feed },
		Subscriptions:     func() brokers.Stats { rp.mu.Lock(); defer rp.mu.Unlock(); return rp.st.Subs },
		BoxSubscriptions:  func() brokers.Stats { rp.mu.Lock(); defer rp.mu.Unlock(); return rp.st.BoxSubs },
		UpstreamFeedStats: func() UpstreamStats { rp.mu.Lock(); defer rp.mu.Unlock(); return rp.st.Upstream },
		LaneStats: func(lane brokers.Lane) brokers.LaneFeedStats {
			rp.mu.Lock()
			defer rp.mu.Unlock()
			if lane == brokers.LaneBox {
				return rp.st.Lanes.Box
			}
			return rp.st.Lanes.Futures
		},
		BoardSize: func(context.Context) (int, error) {
			rp.record("boardSize")
			rp.mu.Lock()
			raw := rp.st.BoardSize
			rp.mu.Unlock()
			var n *int
			if err := json.Unmarshal(raw, &n); err == nil {
				if n == nil {
					return 0, errors.New("board size unknown")
				}
				return *n, nil
			}
			var thrown struct {
				Throw string `json:"throw"`
			}
			if err := json.Unmarshal(raw, &thrown); err != nil {
				rp.t.Fatalf("boardSize %s", raw)
			}
			return 0, errors.New(thrown.Throw)
		},
		IsFullAdmin: func(r *http.Request) bool { return httpx.AdminToken(r) == "full-token" },
		NewTicker: func(d time.Duration) (<-chan time.Time, func()) {
			p := &fakePinger{c: make(chan time.Time, 1)}
			rp.mu.Lock()
			rp.pingers = append(rp.pingers, p)
			rp.mu.Unlock()
			// The replay waits for this event before choosing the stream's pinger.
			// Publish the channel first: otherwise it can choose nil or the previous
			// stream's channel, losing the scripted heartbeat under -race.
			rp.record(fmt.Sprintf("interval %d", d.Milliseconds()))
			return p.c, func() { rp.record("clearInterval") }
		},
		Now: rp.now,
	}
}

// sseStream reads frames ("...\n\n") off one open stream.
type sseStream struct {
	cancel context.CancelFunc
	pinger *fakePinger
	mu     sync.Mutex
	frames []string
	done   chan struct{}
}

func (s *sseStream) read(body io.ReadCloser) {
	defer close(s.done)
	defer body.Close()
	r := bufio.NewReader(body)
	var b strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		b.WriteString(line)
		if line == "\n" {
			s.mu.Lock()
			s.frames = append(s.frames, b.String())
			s.mu.Unlock()
			b.Reset()
		}
	}
}

func (s *sseStream) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.frames)
}

func (s *sseStream) since(n int) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.frames[n:]...)
}

func waitUntil(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(time.Millisecond)
	}
	return true
}

// spreadClock gives the global /api limiter a fresh window for every request, so a
// scenario with hundreds of requests is not cut off at 150 (the limiter is not under test).
func spreadClock() func() time.Time {
	var n atomic.Int64
	return func() time.Time { return time.Unix(0, 0).Add(time.Duration(n.Add(1)) * 2 * time.Minute) }
}

func TestRoutesGolden(t *testing.T) {
	scenarios := loadRoutesGolden(t)
	if len(scenarios) < 12 {
		t.Fatalf("golden has only %d scenarios", len(scenarios))
	}
	for _, sc := range scenarios {
		t.Run(sc.Name, func(t *testing.T) { replayScenario(t, sc) })
	}
}

func replayScenario(t *testing.T, sc goldenScenario) {
	rp := &replay{t: t, clock: sc.Start}
	rp.st.apply(t, sc.State)
	rp.store = NewSessionStore(SessionStoreOptions{Now: rp.now})
	rp.hub = hub.New(hub.Deps{
		Creds:   func() hub.Creds { return hub.Creds{APIKey: "api-key", AccessToken: "access-token"} },
		OnDead:  func() { rp.mu.Lock(); rp.dead++; rp.mu.Unlock() },
		Connect: rp.connect,
		Now:     rp.now,
	})
	handler := server.New(server.Options{FrontendOrigin: "http://localhost:5173", Now: spreadClock()},
		func(r chi.Router) { Mount(r, rp.deps()) })
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		if r.Header.Get("X-Test-Stream") != "" {
			rp.record("end") // the handler returned: res.end()
		}
	}))
	defer srv.Close()
	client := &http.Client{}

	streams := map[string]*sseStream{}
	marks := map[string]int{}
	defer func() {
		for _, s := range streams {
			s.cancel()
			<-s.done
		}
	}()

	for i, st := range sc.Steps {
		op := st.Op
		where := fmt.Sprintf("step %d %s %s %s", i, op.Op, op.Method, op.Path)
		switch op.Op {
		case "request":
			p := op.Path
			if strings.Contains(p, ":id") {
				var id string
				switch {
				case op.Session != nil:
					rp.mu.Lock()
					if *op.Session >= len(rp.ids) {
						rp.mu.Unlock()
						t.Fatalf("%s: no session %d", where, *op.Session)
					}
					id = rp.ids[*op.Session]
					rp.mu.Unlock()
				case op.ID != nil:
					id = *op.ID
				}
				p = strings.Replace(p, ":id", url.PathEscape(id), 1)
			}
			u := srv.URL + p
			if op.Query != nil {
				u += "?" + *op.Query
			}
			var body io.Reader
			if op.Body != nil {
				body = strings.NewReader(*op.Body)
			}
			ctx, cancel := context.WithCancel(context.Background())
			req, err := http.NewRequestWithContext(ctx, op.Method, u, body)
			if err != nil {
				cancel()
				t.Fatalf("%s: %v", where, err)
			}
			if op.Body != nil {
				req.Header.Set("Content-Type", "application/json")
			}
			for k, v := range op.Headers {
				req.Header.Set(k, v)
			}
			if op.Stream != "" {
				req.Header.Set("X-Test-Stream", op.Stream)
			}
			res, err := client.Do(req)
			if err != nil {
				cancel()
				t.Fatalf("%s: %v", where, err)
			}
			if st.Status == nil || res.StatusCode != *st.Status {
				cancel()
				t.Fatalf("%s: status %d, want %v", where, res.StatusCode, st.Status)
			}
			if st.SSE {
				if op.Stream == "" {
					cancel()
					t.Fatalf("%s: golden stream without a name", where)
				}
				for _, h := range st.Headers {
					if got := res.Header.Get(h[0]); got != h[1] {
						cancel()
						t.Fatalf("%s: header %s %q, want %q", where, h[0], got, h[1])
					}
				}
				s := &sseStream{cancel: cancel, done: make(chan struct{})}
				go s.read(res.Body)
				streams[op.Stream] = s
				// The ticker is made while the handler opens the stream; wait for it.
				if !waitUntil(2*time.Second, func() bool { return rp.eventCount() >= len(st.Events) }) {
					t.Fatalf("%s: events %q, want %q", where, rp.takeEvents(), st.Events)
				}
				rp.mu.Lock()
				if len(rp.pingers) > 0 {
					s.pinger = rp.pingers[len(rp.pingers)-1]
				}
				rp.mu.Unlock()
			} else {
				raw, err := io.ReadAll(res.Body)
				res.Body.Close()
				cancel()
				if err != nil {
					t.Fatalf("%s: %v", where, err)
				}
				got := string(raw)
				rp.mu.Lock()
				for n, id := range rp.ids {
					got = strings.ReplaceAll(got, strconv.Quote(id), strconv.Quote(fmt.Sprintf("<s%d>", n)))
				}
				rp.mu.Unlock()
				if st.Body == nil || got != *st.Body {
					t.Fatalf("%s: body\n got %s\nwant %s", where, got, ptrStr(st.Body))
				}
				if ct := res.Header.Get("Content-Type"); ct != "application/json; charset=utf-8" {
					t.Fatalf("%s: content type %q", where, ct)
				}
			}
		case "seed":
			rp.hub.Seed(decodeTicks(t, op.Ticks))
		case "ingest":
			rp.hub.IngestExternalTicks(decodeTicks(t, op.Ticks))
		case "hubSocket":
			rp.hub.SubscribeTokens(op.Tokens)
		case "socketError":
			rp.mu.Lock()
			if len(rp.sockets) == 0 {
				rp.mu.Unlock()
				t.Fatalf("%s: no hub socket", where)
			}
			o := rp.sockets[len(rp.sockets)-1]
			rp.mu.Unlock()
			o.OnError(ticker.ErrorMessage)
		case "ping":
			s := streams[op.Stream]
			if s == nil || s.pinger == nil {
				t.Fatalf("%s: no keep-alive for %s", where, op.Stream)
			}
			s.pinger.c <- time.Now()
		case "disconnect":
			s := streams[op.Stream]
			s.cancel()
			<-s.done
			if !waitUntil(2*time.Second, func() bool { return rp.eventCount() >= len(st.Events) }) {
				t.Fatalf("%s: events %q, want %q", where, rp.takeEvents(), st.Events)
			}
		case "advance":
			rp.mu.Lock()
			rp.clock += op.Ms
			rp.mu.Unlock()
		case "state":
			// Applied to a copy so a decoding failure never exits while holding the lock.
			rp.mu.Lock()
			next := rp.st
			rp.mu.Unlock()
			next.apply(t, op.Set)
			rp.mu.Lock()
			rp.st = next
			rp.mu.Unlock()
		default:
			t.Fatalf("%s: unknown op", where)
		}

		// Frames: wait for what Node wrote, then compare exactly.
		for name, s := range streams {
			want := st.Frames[name]
			from := marks[name]
			if len(want) > 0 && !waitUntil(2*time.Second, func() bool { return s.count() >= from+len(want) }) {
				t.Fatalf("%s: stream %s frames %q, want %q", where, name, s.since(from), want)
			}
			got := s.since(from)
			if len(got) != len(want) || (len(got) > 0 && !reflect.DeepEqual(got, want)) {
				t.Fatalf("%s: stream %s frames\n got %q\nwant %q", where, name, got, want)
			}
			marks[name] = from + len(got)
		}
		if got := rp.takeEvents(); len(got) != len(st.Events) || (len(got) > 0 && !reflect.DeepEqual(got, st.Events)) {
			t.Fatalf("%s: events\n got %q\nwant %q", where, got, st.Events)
		}
		if got := rp.store.Stats(); got != st.Sessions {
			t.Fatalf("%s: sessions %+v, want %+v", where, got, st.Sessions)
		}
		rp.mu.Lock()
		dead, clears := rp.dead, rp.clears
		rp.dead, rp.clears = 0, 0
		rp.mu.Unlock()
		if dead != st.Dead || clears != st.ClearSession {
			t.Fatalf("%s: onDead %d, Kite session cleared %d; want %d, %d", where, dead, clears, st.Dead, st.ClearSession)
		}
	}
	time.Sleep(20 * time.Millisecond)
	for name, s := range streams {
		if extra := s.since(marks[name]); len(extra) > 0 {
			t.Fatalf("stream %s got frames after the last step: %q", name, extra)
		}
	}
}

func ptrStr(p *string) string {
	if p == nil {
		return "<none>"
	}
	return *p
}
