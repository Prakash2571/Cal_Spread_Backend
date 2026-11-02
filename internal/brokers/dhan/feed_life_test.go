package dhan

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// feed_life.json is written by testdata/gen_feed.mjs: the original DhanFeed driven by a
// scripted fake WebSocket and a manual timer queue. Here dhan.Feed runs against a
// loopback server the test scripts the same way: "open" completes the handshake,
// "close <code>" closes from the server (a pending handshake is refused, which the client
// sees as 1006, like a failed connect), "message" writes a binary frame. Reconnect
// delays are recorded and shortened, so "fire" waits for the reconnect instead of
// running a timer. Everything the feed did (sockets, frames sent, sockets it closed,
// callbacks, delays, counters) must match the Node recording.

type lifeGolden struct {
	Cases []lifeCase `json:"cases"`
}

type lifeCase struct {
	Name     string       `json:"name"`
	Token    string       `json:"token"`
	ClientID string       `json:"clientId"`
	NowMs    int64        `json:"nowMs"`
	Steps    []lifeStep   `json:"steps"`
	Results  []lifeResult `json:"results"`
}

type lifeStep struct {
	Op     string          `json:"op"`
	Tokens []int64         `json:"tokens"`
	Socket int             `json:"socket"`
	Code   int             `json:"code"`
	Frame  string          `json:"frame"`
	Ms     int64           `json:"ms"`
	Value  json.RawMessage `json:"value"`
}

type lifeStats struct {
	Connected  bool   `json:"connected"`
	Wanted     int    `json:"wanted"`
	Subscribed int    `json:"subscribed"`
	LastTickAt *int64 `json:"lastTickAt"`
	FeedAge    *int64 `json:"feedAge"`
	Generation int64  `json:"generation"`
}

type lifeResult struct {
	Sockets []string   `json:"sockets"`
	Sent    []string   `json:"sent"`
	Closed  []string   `json:"closed"`
	Calls   []string   `json:"calls"`
	Timers  []int64    `json:"timers"`
	Stats   *lifeStats `json:"stats"`
}

// lifeLog is the cumulative record of one replay.
type lifeLog struct {
	mu      sync.Mutex
	sockets []string
	sent    []string
	closed  []string
	calls   []string
	timers  []int64
}

func (l *lifeLog) snapshot() lifeResult {
	l.mu.Lock()
	defer l.mu.Unlock()
	cp := func(s []string) []string { return append([]string{}, s...) }
	return lifeResult{Sockets: cp(l.sockets), Sent: cp(l.sent), Closed: cp(l.closed), Calls: cp(l.calls), Timers: append([]int64{}, l.timers...)}
}

type lifeConn struct {
	idx           int
	decide        chan bool // true: complete the handshake, false: refuse it
	opened        chan struct{}
	mu            sync.Mutex
	ws            *websocket.Conn
	serverClosing atomic.Bool
}

type lifeServer struct {
	t   *testing.T
	log *lifeLog
	srv *httptest.Server
	mu  sync.Mutex
	cs  []*lifeConn
}

func newLifeServer(t *testing.T, log *lifeLog) *lifeServer {
	s := &lifeServer{t: t, log: log}
	up := websocket.Upgrader{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := &lifeConn{decide: make(chan bool, 1), opened: make(chan struct{})}
		s.mu.Lock()
		c.idx = len(s.cs)
		s.cs = append(s.cs, c)
		s.mu.Unlock()
		log.mu.Lock()
		log.sockets = append(log.sockets, "wss://api-feed.dhan.co"+strings.TrimPrefix(r.URL.RequestURI(), "/"))
		log.mu.Unlock()
		select {
		case ok := <-c.decide:
			if !ok {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
		case <-r.Context().Done():
			// The client abandoned the handshake (Node: close() on a CONNECTING socket).
			log.mu.Lock()
			log.closed = append(log.closed, fmt.Sprint(c.idx))
			log.mu.Unlock()
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		c.mu.Lock()
		c.ws = ws
		c.mu.Unlock()
		close(c.opened)
		for {
			mt, msg, err := ws.ReadMessage()
			if err != nil {
				if !c.serverClosing.Load() {
					log.mu.Lock()
					log.closed = append(log.closed, fmt.Sprint(c.idx))
					log.mu.Unlock()
				}
				_ = ws.Close()
				return
			}
			if mt == websocket.TextMessage {
				log.mu.Lock()
				log.sent = append(log.sent, fmt.Sprintf("%d %s", c.idx, msg))
				log.mu.Unlock()
			}
		}
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *lifeServer) conn(i int) *lifeConn {
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.Lock()
		if i < len(s.cs) {
			c := s.cs[i]
			s.mu.Unlock()
			return c
		}
		s.mu.Unlock()
		if time.Now().After(deadline) {
			s.t.Fatalf("socket %d never connected", i)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (s *lifeServer) write(i, mt int, data []byte) {
	c := s.conn(i)
	<-c.opened
	c.mu.Lock()
	defer c.mu.Unlock()
	// A failed write means the feed already closed this socket (Node: the stale socket's
	// handler ignores the message). Either way nothing reaches the feed.
	_ = c.ws.WriteMessage(mt, data)
}

func (s *lifeServer) close(i, code int) {
	c := s.conn(i)
	select {
	case <-c.opened:
	default:
		if code != 1006 {
			s.t.Fatalf("a socket that never opened can only fail with 1006, not %d", code)
		}
		c.decide <- false
		return
	}
	c.serverClosing.Store(true)
	c.mu.Lock()
	defer c.mu.Unlock()
	if code != 1006 {
		_ = c.ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""), time.Now().Add(time.Second))
	}
	_ = c.ws.UnderlyingConn().Close()
}

func TestFeedLifecycleGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/feed_life.json")
	if err != nil {
		t.Fatal(err)
	}
	var g lifeGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("no cases")
	}
	SetLogger(func(string, ...any) {})
	t.Cleanup(func() { SetLogger(nil) })
	for _, c := range g.Cases {
		t.Run(c.Name, func(t *testing.T) { replayLifecycle(t, c) })
	}
}

const reconnectWait = 150 * time.Millisecond

func replayLifecycle(t *testing.T, c lifeCase) {
	log := &lifeLog{}
	srv := newLifeServer(t, log)
	var now atomic.Int64
	now.Store(c.NowMs)
	var mu sync.Mutex
	token, clientID := c.Token, c.ClientID
	f := NewFeed(FeedOptions{
		AccessToken: func() string { mu.Lock(); defer mu.Unlock(); return token },
		ClientID:    func() string { mu.Lock(); defer mu.Unlock(); return clientID },
		OnTicks: func(ticks []market.Tick) {
			log.mu.Lock()
			log.calls = append(log.calls, "ticks "+string(hub.TicksJSON(ticks)))
			log.mu.Unlock()
		},
		OnConnection: func(connected bool) {
			log.mu.Lock()
			log.calls = append(log.calls, fmt.Sprintf("connection %t", connected))
			log.mu.Unlock()
		},
		OnSessionLost: func(reason string) {
			log.mu.Lock()
			log.calls = append(log.calls, "sessionLost "+reason)
			log.mu.Unlock()
		},
		Resolve:    IdentityFromToken,
		DepthLevel: 5,
		URL:        "ws" + strings.TrimPrefix(srv.srv.URL, "http"),
		Now:        func() time.Time { return time.UnixMilli(now.Load()) },
		ReconnectDelay: func(attempt int) time.Duration {
			log.mu.Lock()
			log.timers = append(log.timers, ReconnectDelay(attempt).Milliseconds())
			log.mu.Unlock()
			return reconnectWait
		},
	})
	t.Cleanup(f.Dispose)

	var want lifeResult // cumulative Node record
	for i, step := range c.Steps {
		res := c.Results[i]
		want.Sockets = append(want.Sockets, res.Sockets...)
		want.Sent = append(want.Sent, res.Sent...)
		want.Closed = append(want.Closed, res.Closed...)
		want.Calls = append(want.Calls, res.Calls...)
		want.Timers = append(want.Timers, res.Timers...)

		switch step.Op {
		case "subscribe":
			f.SubscribeTokens(step.Tokens)
		case "unsubscribe":
			f.UnsubscribeTokens(step.Tokens)
		case "ensure":
			f.EnsureSocket()
		case "open":
			srv.conn(step.Socket).decide <- true
		case "message":
			b, err := hex.DecodeString(step.Frame)
			if err != nil {
				t.Fatal(err)
			}
			srv.write(step.Socket, websocket.BinaryMessage, b)
		case "text":
			srv.write(step.Socket, websocket.TextMessage, []byte(`{"type":"info"}`))
		case "close":
			srv.close(step.Socket, step.Code)
		case "fire":
			if len(res.Sockets) == 0 {
				time.Sleep(2 * reconnectWait) // Node fired nothing: nothing may reconnect
			}
		case "stop":
			f.Stop()
		case "dispose":
			f.Dispose()
		case "advance":
			now.Add(step.Ms)
		case "token", "clientId":
			var v *string
			_ = json.Unmarshal(step.Value, &v)
			s := ""
			if v != nil {
				s = *v
			}
			mu.Lock()
			if step.Op == "token" {
				token = s
			} else {
				clientID = s
			}
			mu.Unlock()
		case "stats":
		default:
			t.Fatalf("unknown op %q", step.Op)
		}

		got := waitLife(log, want)
		where := fmt.Sprintf("step %d (%s)", i, step.Op)
		compareLife(t, where, got, want)
		if res.Stats != nil {
			gotStats := lifeStats{
				Connected: f.IsConnected(), Wanted: f.WantedCount(), Subscribed: f.SubscribedCount(),
				LastTickAt: f.LastTickAtMs(), FeedAge: f.FeedAgeMs(), Generation: f.FeedGeneration(),
			}
			if !reflect.DeepEqual(gotStats, *res.Stats) {
				t.Errorf("%s: stats\n got  %+v\n want %+v", where, show(gotStats), show(*res.Stats))
			}
		}
		if t.Failed() {
			t.FailNow()
		}
	}
	time.Sleep(2 * reconnectWait) // nothing late may follow
	compareLife(t, "after the last step", log.snapshot(), want)
}

func show(s lifeStats) string { b, _ := json.Marshal(s); return string(b) }

// waitLife waits until the Go record has caught up with the Node one (or 3 s pass).
func waitLife(log *lifeLog, want lifeResult) lifeResult {
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := log.snapshot()
		if len(got.Sockets) >= len(want.Sockets) && len(got.Sent) >= len(want.Sent) && len(got.Closed) >= len(want.Closed) &&
			len(got.Calls) >= len(want.Calls) && len(got.Timers) >= len(want.Timers) {
			time.Sleep(10 * time.Millisecond) // let anything unexpected show up too
			return log.snapshot()
		}
		if time.Now().After(deadline) {
			return got
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func compareLife(t *testing.T, where string, got, want lifeResult) {
	t.Helper()
	pairs := []struct {
		name      string
		got, want any
	}{
		{"sockets", got.Sockets, nonEmpty(want.Sockets)},
		{"sent", got.Sent, nonEmpty(want.Sent)},
		{"closed", got.Closed, nonEmpty(want.Closed)},
		{"calls", got.Calls, nonEmpty(want.Calls)},
		{"timers", got.Timers, nonEmptyInts(want.Timers)},
	}
	for _, p := range pairs {
		if !reflect.DeepEqual(p.got, p.want) {
			t.Errorf("%s: %s\n got  %q\n want %q", where, p.name, p.got, p.want)
		}
	}
}

func nonEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func nonEmptyInts(s []int64) []int64 {
	if s == nil {
		return []int64{}
	}
	return s
}
