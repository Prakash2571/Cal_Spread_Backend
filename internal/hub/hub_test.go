package hub

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// fakeSocket is Node's connectTicker over the recording FakeWebSocket of gen_hub.mjs:
// tokens queue until open, then subscribe/mode/unsubscribe messages are "sent". It never
// calls back by itself; the replay fires open/frame/error/close.
type fakeSocket struct {
	mu      sync.Mutex
	opts    ticker.Options
	url     string
	pending []int64
	isOpen  bool
	sent    []string
	closes  int
}

func (s *fakeSocket) Close() {
	s.mu.Lock()
	s.closes++
	s.mu.Unlock()
}

func (s *fakeSocket) Subscribe(tokens []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isOpen {
		s.sent = append(s.sent, ticker.SubscribeMessages(tokens)...)
		return
	}
	s.pending = append(s.pending, tokens...)
}

func (s *fakeSocket) Unsubscribe(tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isOpen {
		s.sent = append(s.sent, ticker.UnsubscribeMessage(tokens))
		return
	}
	drop := map[int64]bool{}
	for _, t := range tokens {
		drop[t] = true
	}
	kept := []int64{}
	for _, t := range s.pending {
		if !drop[t] {
			kept = append(kept, t)
		}
	}
	s.pending = kept
}

func (s *fakeSocket) open() {
	s.mu.Lock()
	s.isOpen = true
	s.sent = append(s.sent, ticker.SubscribeMessages(s.pending)...)
	s.pending = nil
	s.mu.Unlock()
	if s.opts.OnOpen != nil {
		s.opts.OnOpen()
	}
}

// recordingClient is an SSE client that keeps every frame.
type recordingClient struct {
	mu     sync.Mutex
	frames []string
	closed int
}

func (c *recordingClient) WriteFrame(f []byte) error {
	c.mu.Lock()
	c.frames = append(c.frames, string(f))
	c.mu.Unlock()
	return nil
}

func (c *recordingClient) Close() {
	c.mu.Lock()
	c.closed++
	c.mu.Unlock()
}

func (c *recordingClient) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.frames)
}

func (c *recordingClient) since(n int) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string{}, c.frames[n:]...)
}

// goldenNum is a JSON number or the loader's {"$num": …} for NaN and the infinities.
func goldenNum(t *testing.T, raw json.RawMessage) float64 {
	t.Helper()
	if len(raw) > 0 && raw[0] == '{' {
		var o struct {
			Num string `json:"$num"`
		}
		if err := json.Unmarshal(raw, &o); err != nil {
			t.Fatal(err)
		}
		switch o.Num {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		}
		t.Fatalf("bad $num %q", o.Num)
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// goldenTicks decodes scripted ticks, keeping "present but empty" bids/asks apart from
// absent ones (Node checked own properties).
func goldenTicks(t *testing.T, raw json.RawMessage) []market.Tick {
	t.Helper()
	var objs []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &objs); err != nil {
		t.Fatal(err)
	}
	levels := func(raw json.RawMessage) []market.DepthLevel {
		var ls []map[string]json.RawMessage
		if err := json.Unmarshal(raw, &ls); err != nil {
			t.Fatal(err)
		}
		out := make([]market.DepthLevel, 0, len(ls))
		for _, l := range ls {
			out = append(out, market.DepthLevel{Price: goldenNum(t, l["price"]), Qty: goldenNum(t, l["qty"]), Orders: goldenNum(t, l["orders"])})
		}
		return out
	}
	out := []market.Tick{}
	for _, o := range objs {
		tk := market.Tick{Token: int64(goldenNum(t, o["token"])), LastPrice: goldenNum(t, o["last_price"]),
			ClosePrice: goldenNum(t, o["close_price"]), OI: goldenNum(t, o["oi"]), Bid: goldenNum(t, o["bid"]), Ask: goldenNum(t, o["ask"])}
		if raw, ok := o["bids"]; ok {
			tk.Bids = levels(raw)
		}
		if raw, ok := o["asks"]; ok {
			tk.Asks = levels(raw)
		}
		if raw, ok := o["depth_updated"]; ok {
			var b bool
			if err := json.Unmarshal(raw, &b); err != nil {
				t.Fatal(err)
			}
			tk.DepthUpdated = &b
		}
		if raw, ok := o["exchange_ts"]; ok {
			ts := int64(goldenNum(t, raw))
			tk.ExchangeTS = &ts
		}
		out = append(out, tk)
	}
	return out
}

func ladderJSON(l Ladder, at *int64) string {
	b := append([]byte(`{"last":`), jsjson.FormatNumber(l.Last)...)
	b = append(b, `,"bids":`...)
	b = appendLevels(b, l.Bids)
	b = append(b, `,"asks":`...)
	b = appendLevels(b, l.Asks)
	if at != nil {
		b = append(b, `,"at":`...)
		b = strconv.AppendInt(b, *at, 10)
	}
	return string(append(b, '}'))
}

type hubOp struct {
	Op        string          `json:"op"`
	ID        string          `json:"id"`
	Client    string          `json:"client"`
	Tokens    *[]int64        `json:"tokens"`
	Ticks     json.RawMessage `json:"ticks"`
	Socket    int             `json:"socket"`
	Hex       string          `json:"hex"`
	APIKey    *string         `json:"apiKey"`
	Token     *string         `json:"accessToken"`
	Connected bool            `json:"connected"`
	Ms        int64           `json:"ms"`
}

type hubQuery struct {
	Connected  bool `json:"connected"`
	Subscribed int  `json:"subscribed"`
	Tokens     map[string]struct {
		Latest   *string `json:"latest"`
		Snapshot string  `json:"snapshot"`
		Fresh    string  `json:"fresh"`
		Fresh1s  string  `json:"fresh1s"`
	} `json:"tokens"`
}

type hubStep struct {
	Op      hubOp `json:"op"`
	Sockets []struct {
		Index  int      `json:"index"`
		Sent   []string `json:"sent"`
		Closes int      `json:"closes"`
		URL    *string  `json:"url"`
	} `json:"sockets"`
	Frames map[string][]string `json:"frames"`
	Ticks  map[string][]string `json:"ticks"`
	Conns  map[string][]bool   `json:"conns"`
	Dead   int                 `json:"dead"`
	Query  *hubQuery           `json:"query"`
}

// TestHubGolden replays gen_hub.mjs (src/hub.ts TickerHub) operation by operation and
// compares everything each operation changed: SSE frames per client, socket urls,
// messages and closes, listener calls, onDead calls and the caches. Its first scenario
// is tests/box/tickerHubLifecycle.test.mjs step for step.
func TestHubGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "hub.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/kite/testdata/gen_hub.mjs)", err)
	}
	var g struct {
		Scenarios []struct {
			Name  string    `json:"name"`
			Start int64     `json:"start"`
			Steps []hubStep `json:"steps"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Scenarios) < 10 {
		t.Fatalf("golden has only %d scenarios", len(g.Scenarios))
	}
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			var mu sync.Mutex
			clock := sc.Start
			creds := Creds{APIKey: "api-key", AccessToken: "access-token"}
			var sockets []*fakeSocket
			dead := 0
			h := New(Deps{
				Creds:  func() Creds { mu.Lock(); defer mu.Unlock(); return creds },
				OnDead: func() { mu.Lock(); dead++; mu.Unlock() },
				Connect: func(o ticker.Options) ticker.Handle {
					s := &fakeSocket{opts: o, url: ticker.SocketURL(o.URL, o.APIKey, o.AccessToken), pending: append([]int64{}, o.Tokens...)}
					mu.Lock()
					sockets = append(sockets, s)
					mu.Unlock()
					return s
				},
				Now: func() time.Time { mu.Lock(); defer mu.Unlock(); return time.UnixMilli(clock) },
			})
			clients := map[string]*recordingClient{}
			detach := map[string]func(){}
			release := map[string]func(){}
			remove := map[string]func(){}
			tickCalls := map[string][]string{}
			connCalls := map[string][]bool{}
			var calls sync.Mutex
			defer func() {
				for _, d := range detach {
					d()
				}
			}()
			type mark struct{ sent, closes int }
			socketMarks := []mark{}
			frameMarks := map[string]int{}
			tickMarks := map[string]int{}
			connMarks := map[string]int{}
			deadMark := 0

			for i, st := range sc.Steps {
				op := st.Op
				where := fmt.Sprintf("step %d %s", i, op.Op)
				tokens := func() []int64 {
					if op.Tokens == nil {
						return nil
					}
					return *op.Tokens
				}
				sock := func() *fakeSocket {
					mu.Lock()
					defer mu.Unlock()
					if op.Socket >= len(sockets) {
						t.Fatalf("%s: no socket %d", where, op.Socket)
					}
					return sockets[op.Socket]
				}
				switch op.Op {
				case "creds":
					mu.Lock()
					creds = Creds{APIKey: "api-key", AccessToken: ""}
					if op.APIKey != nil {
						creds.APIKey = *op.APIKey
					}
					if op.Token != nil {
						creds.AccessToken = *op.Token
					}
					mu.Unlock()
				case "attach", "addClient":
					c := &recordingClient{}
					clients[op.Client] = c
					if op.Op == "attach" {
						detach[op.Client] = h.AttachClient(c, tokens())
					} else {
						detach[op.Client] = h.AddClient(c, tokens())
					}
				case "detach":
					detach[op.Client]()
				case "seed":
					h.Seed(goldenTicks(t, op.Ticks))
				case "retain":
					release[op.ID] = h.Retain(tokens())
				case "release":
					release[op.ID]()
				case "retainFanout":
					release[op.ID] = h.RetainFanout()
				case "subscribe":
					h.SubscribeTokens(tokens())
				case "unsubscribe":
					h.UnsubscribeTokens(tokens())
				case "tickListener":
					id := op.ID
					remove[id] = h.AddTickListener(func(ts []market.Tick) {
						calls.Lock()
						tickCalls[id] = append(tickCalls[id], string(TicksJSON(ts)))
						calls.Unlock()
					})
				case "connListener":
					id := op.ID
					remove[id] = h.AddConnectionListener(func(c bool) {
						calls.Lock()
						connCalls[id] = append(connCalls[id], c)
						calls.Unlock()
					})
				case "remove":
					remove[op.ID]()
				case "open":
					sock().open()
				case "frame":
					b, err := hex.DecodeString(op.Hex)
					if err != nil {
						t.Fatal(err)
					}
					if ticks := ticker.ParseBinary(b); len(ticks) > 0 {
						sock().opts.OnTick(ticks)
					}
				case "error":
					sock().opts.OnError(ticker.ErrorMessage)
				case "close":
					sock().opts.OnClose()
				case "ingest":
					h.IngestExternalTicks(goldenTicks(t, op.Ticks))
				case "external":
					h.SetExternalConnected(op.Connected)
				case "stop":
					h.Stop()
				case "advance":
					mu.Lock()
					clock += op.Ms
					mu.Unlock()
				case "query":
					q := st.Query
					if q == nil {
						t.Fatalf("%s: golden has no query result", where)
					}
					if h.IsConnected() != q.Connected || h.SubscribedCount() != q.Subscribed {
						t.Fatalf("%s: connected %v subscribed %d, want %v %d", where, h.IsConnected(), h.SubscribedCount(), q.Connected, q.Subscribed)
					}
					for key, want := range q.Tokens {
						tok, _ := strconv.ParseInt(key, 10, 64)
						latest := "<none>"
						if tk, ok := h.GetLatestTick(tok); ok {
							s := string(TicksJSON([]market.Tick{tk}))
							latest = s[1 : len(s)-1]
						}
						if (want.Latest == nil && latest != "<none>") || (want.Latest != nil && latest != *want.Latest) {
							t.Fatalf("%s: latest %d\n got %s\nwant %v", where, tok, latest, ptrString(want.Latest))
						}
						snap := "null"
						if l, ok := h.GetLadderSnapshot(tok); ok {
							snap = ladderJSON(l.Ladder, &l.At)
						}
						fresh, fresh1s := "null", "null"
						if l, ok := h.GetFreshLadder(tok, DefaultLadderMaxAgeMs); ok {
							fresh = ladderJSON(l, nil)
						}
						if l, ok := h.GetFreshLadder(tok, 1000); ok {
							fresh1s = ladderJSON(l, nil)
						}
						if snap != want.Snapshot || fresh != want.Fresh || fresh1s != want.Fresh1s {
							t.Fatalf("%s: ladders %d\n got %s | %s | %s\nwant %s | %s | %s", where, tok, snap, fresh, fresh1s, want.Snapshot, want.Fresh, want.Fresh1s)
						}
					}
				default:
					t.Fatalf("%s: unknown op", where)
				}

				// Sockets: new urls, messages and closes.
				mu.Lock()
				socks := append([]*fakeSocket(nil), sockets...)
				gotDead := dead - deadMark
				deadMark = dead
				mu.Unlock()
				wantSock := map[int]int{}
				for j, s := range st.Sockets {
					wantSock[s.Index] = j
				}
				for idx, s := range socks {
					if idx >= len(socketMarks) {
						socketMarks = append(socketMarks, mark{})
						j, ok := wantSock[idx]
						if !ok || st.Sockets[j].URL == nil || *st.Sockets[j].URL != s.url {
							t.Fatalf("%s: unexpected new socket %d (%s)", where, idx, s.url)
						}
					}
					s.mu.Lock()
					sent := append([]string{}, s.sent[socketMarks[idx].sent:]...)
					closes := s.closes - socketMarks[idx].closes
					socketMarks[idx] = mark{len(s.sent), s.closes}
					s.mu.Unlock()
					var wantSent []string
					wantCloses := 0
					if j, ok := wantSock[idx]; ok {
						wantSent, wantCloses = st.Sockets[j].Sent, st.Sockets[j].Closes
					}
					if len(sent) != len(wantSent) || (len(sent) > 0 && !reflect.DeepEqual(sent, wantSent)) || closes != wantCloses {
						t.Fatalf("%s: socket %d sent %q closes %d, want %q %d", where, idx, sent, closes, wantSent, wantCloses)
					}
				}
				if len(socks) < len(st.Sockets) && len(st.Sockets) > 0 {
					t.Fatalf("%s: %d sockets, golden reports %+v", where, len(socks), st.Sockets)
				}
				if gotDead != st.Dead {
					t.Fatalf("%s: onDead %d times, want %d", where, gotDead, st.Dead)
				}

				// SSE frames: wait for each client's writer, then compare what is new.
				for name, c := range clients {
					want := st.Frames[name]
					from := frameMarks[name]
					deadline := time.Now().Add(2 * time.Second)
					for c.count() < from+len(want) && time.Now().Before(deadline) {
						time.Sleep(time.Millisecond)
					}
					got := c.since(from)
					if len(got) != len(want) || (len(got) > 0 && !reflect.DeepEqual(got, want)) {
						t.Fatalf("%s: client %s frames\n got %q\nwant %q", where, name, got, want)
					}
					frameMarks[name] = from + len(got)
				}

				// Listener calls.
				calls.Lock()
				for id, list := range tickCalls {
					got := list[tickMarks[id]:]
					if want := st.Ticks[id]; len(got) != len(want) || (len(got) > 0 && !reflect.DeepEqual(got, want)) {
						calls.Unlock()
						t.Fatalf("%s: tick listener %s\n got %q\nwant %q", where, id, got, want)
					}
					tickMarks[id] = len(list)
				}
				for id, list := range connCalls {
					got := list[connMarks[id]:]
					if want := st.Conns[id]; len(got) != len(want) || (len(got) > 0 && !reflect.DeepEqual(got, want)) {
						calls.Unlock()
						t.Fatalf("%s: connection listener %s got %v, want %v", where, id, got, want)
					}
					connMarks[id] = len(list)
				}
				calls.Unlock()
			}
			time.Sleep(20 * time.Millisecond)
			for name, c := range clients {
				if extra := c.since(frameMarks[name]); len(extra) > 0 {
					t.Fatalf("client %s got frames after the last step: %q", name, extra)
				}
			}
		})
	}
}

func ptrString(p *string) string {
	if p == nil {
		return "<none>"
	}
	return *p
}

// TestSSEWriterStreamsFramesWithNodeHeaders checks the tick stream's wire format through
// a real HTTP connection: the headers marketDataRoutes.ts set, frames flushed one by one,
// and no writes after Close.
func TestSSEWriterStreamsFramesWithNodeHeaders(t *testing.T) {
	h := New(Deps{})
	ready := make(chan *SSEWriter, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := StartSSE(w)
		detach := h.AttachClient(s, []int64{1})
		ready <- s
		select {
		case <-r.Context().Done():
		case <-s.Done():
		}
		detach()
	}))
	defer srv.Close()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	for k, want := range map[string]string{"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
		"Connection": "keep-alive", "X-Accel-Buffering": "no"} {
		if got := res.Header.Get(k); got != want {
			t.Errorf("%s %q, want %q", k, got, want)
		}
	}
	s := <-ready
	r := bufio.NewReader(res.Body)
	readFrame := func() string {
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
	h.IngestExternalTicks([]market.Tick{{Token: 1, LastPrice: 100.5, ClosePrice: 99, Bid: 100.45, Ask: 100.55}})
	if got := readFrame(); got != `data: [{"token":1,"last_price":100.5,"close_price":99,"oi":0,"bid":100.45,"ask":100.55}]`+"\n\n" {
		t.Fatalf("frame %q", got)
	}
	if err := s.Ping(); err != nil {
		t.Fatal(err)
	}
	if got := readFrame(); got != ": ping\n\n" {
		t.Fatalf("ping %q", got)
	}
	s.Close()
	if err := s.WriteFrame([]byte("data: x\n\n")); err != ErrSSEClosed {
		t.Fatalf("write after Close: %v", err)
	}
	if _, err := io.ReadAll(r); err != nil {
		t.Fatalf("stream did not end cleanly: %v", err)
	}
}

// TestSlowPeerCannotWedgeTheHub: a browser that stops reading leaves the client's writer
// blocked in a socket write, where it cannot see a halt. Detaching such a client must
// still return promptly, and so must the route when the hub drops it for falling
// ClientQueue frames behind: Close aborts the blocked write.
func TestSlowPeerCannotWedgeTheHub(t *testing.T) {
	for _, tc := range []struct {
		name  string
		queue int
		drop  bool
	}{{"detach", 0, false}, {"dropped for falling behind", 4, true}} {
		t.Run(tc.name, func(t *testing.T) {
			h := New(Deps{ClientQueue: tc.queue})
			var written atomic.Int64
			attached := make(chan func(), 1)
			handlerDone := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				s := StartSSE(w)
				detach := h.AttachClient(&countingClient{SSEWriter: s, n: &written}, nil)
				attached <- detach
				select {
				case <-s.Done():
				case <-r.Context().Done():
				}
				detach() // the route pattern: never return while the writer may still write
			}))
			defer srv.Close()
			res, err := http.Get(srv.URL) // the body is never read
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			detach := <-attached
			big := []market.Tick{{Token: 1, Bids: make([]market.DepthLevel, 4000)}}
			last, still := int64(-1), 0
			for still < 30 { // until the writer is stuck: no progress for ~300 ms
				h.IngestExternalTicks(big)
				time.Sleep(10 * time.Millisecond)
				if n := written.Load(); n == last {
					still++
				} else {
					last, still = n, 0
				}
			}
			if tc.drop {
				select {
				case <-handlerDone: // the hub dropped the client and the stream ended
				case <-time.After(3 * time.Second):
					t.Fatal("a dropped client's stream stayed open behind a blocked write")
				}
			}
			done := make(chan struct{})
			go func() { detach(); close(done) }()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("detach blocked behind a write to a peer that stopped reading")
			}
		})
	}
}

type countingClient struct {
	*SSEWriter
	n *atomic.Int64
}

func (c *countingClient) WriteFrame(f []byte) error {
	err := c.SSEWriter.WriteFrame(f)
	if err == nil {
		c.n.Add(int64(len(f)))
	}
	return err
}
