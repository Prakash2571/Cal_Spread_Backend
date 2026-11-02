package kite

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	fvjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// laneSocket is Node's connectTicker over gen_lanefeed.mjs's recording FakeWebSocket:
// tokens queue until open, then subscribe/mode/unsubscribe messages are "sent".
type laneSocket struct {
	mu      sync.Mutex
	opts    ticker.Options
	url     string
	pending []int64
	isOpen  bool
	sent    []string
	closes  int
}

func (s *laneSocket) Close() { s.mu.Lock(); s.closes++; s.mu.Unlock() }

func (s *laneSocket) Subscribe(tokens []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isOpen {
		s.sent = append(s.sent, ticker.SubscribeMessages(tokens)...)
		return
	}
	s.pending = append(s.pending, tokens...)
}

func (s *laneSocket) Unsubscribe(tokens []int64) {
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

func (s *laneSocket) open() {
	s.mu.Lock()
	s.isOpen = true
	s.sent = append(s.sent, ticker.SubscribeMessages(s.pending)...)
	s.pending = nil
	s.mu.Unlock()
	s.opts.OnOpen()
}

// rawTicksJSON is JSON.stringify of src/ticker.ts parseBinary output: every field,
// exchange_ts 0 when absent, empty depth arrays.
func rawTicksJSON(ticks []market.Tick) string {
	b := []byte{'['}
	levels := func(b []byte, ls []market.DepthLevel) []byte {
		b = append(b, '[')
		for i, l := range ls {
			if i > 0 {
				b = append(b, ',')
			}
			b = append(b, `{"price":`...)
			b = jsjson.AppendNumber(b, l.Price)
			b = append(b, `,"qty":`...)
			b = jsjson.AppendNumber(b, l.Qty)
			b = append(b, `,"orders":`...)
			b = jsjson.AppendNumber(b, l.Orders)
			b = append(b, '}')
		}
		return append(b, ']')
	}
	for i, t := range ticks {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"token":`...)
		b = strconv.AppendInt(b, t.Token, 10)
		for _, f := range []struct {
			k string
			v float64
		}{{"last_price", t.LastPrice}, {"close_price", t.ClosePrice}, {"oi", t.OI}, {"bid", t.Bid}, {"ask", t.Ask}} {
			b = append(b, `,"`+f.k+`":`...)
			b = jsjson.AppendNumber(b, f.v)
		}
		b = append(b, `,"bids":`...)
		b = levels(b, t.Bids)
		b = append(b, `,"asks":`...)
		b = levels(b, t.Asks)
		b = append(b, `,"depth_updated":`...)
		b = strconv.AppendBool(b, t.DepthUpdated != nil && *t.DepthUpdated)
		var ts int64
		if t.ExchangeTS != nil {
			ts = *t.ExchangeTS
		}
		b = append(b, `,"exchange_ts":`...)
		b = strconv.AppendInt(b, ts, 10)
		b = append(b, '}')
	}
	return string(append(b, ']'))
}

type laneTimer struct {
	delay     int64
	fn        func()
	cancelled bool
	fired     bool
}

type laneStep struct {
	Op struct {
		Op     string  `json:"op"`
		Tokens []int64 `json:"tokens"`
		Socket int     `json:"socket"`
		Hex    string  `json:"hex"`
		Token  *string `json:"accessToken"`
		Value  int64   `json:"value"`
		Ms     int64   `json:"ms"`
	} `json:"op"`
	Sockets []struct {
		Index  int      `json:"index"`
		Sent   []string `json:"sent"`
		Closes int      `json:"closes"`
		URL    *string  `json:"url"`
	} `json:"sockets"`
	Ticks     []string `json:"ticks"`
	Conns     []bool   `json:"conns"`
	Deads     []string `json:"deads"`
	Scheduled []int64  `json:"scheduled"`
	Cancelled int      `json:"cancelled"`
	Fired     *int64   `json:"fired"`
	Query     *struct {
		Connected  bool   `json:"connected"`
		Wanted     int    `json:"wanted"`
		Subscribed int    `json:"subscribed"`
		Stats      string `json:"stats"`
	} `json:"query"`
}

// TestZerodhaFeedGolden replays gen_lanefeed.mjs (src/brokers/zerodha/feed.ts) step by
// step: socket urls, messages and closes, scheduled reconnect delays, cancellations,
// ticks, connection changes, onDead and the lane's health. Node had no test for this
// class; the golden is the only reference.
func TestZerodhaFeedGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "lanefeed.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/kite/testdata/gen_lanefeed.mjs)", err)
	}
	var g struct {
		Scenarios []struct {
			Name  string     `json:"name"`
			Lane  Lane       `json:"lane"`
			Start int64      `json:"start"`
			Steps []laneStep `json:"steps"`
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
			token := "access-token"
			gen := int64(1)
			var sockets []*laneSocket
			var timers []*laneTimer
			var ticks, deads []string
			var conns []bool
			f := NewZerodhaFeed(ZerodhaFeedOptions{
				Lane: sc.Lane,
				Credentials: func() Credentials {
					mu.Lock()
					defer mu.Unlock()
					return Credentials{APIKey: "api-key", AccessToken: token}
				},
				OnTicks:            func(ts []market.Tick) { mu.Lock(); ticks = append(ticks, rawTicksJSON(ts)); mu.Unlock() },
				OnConnectionChange: func(c bool) { mu.Lock(); conns = append(conns, c); mu.Unlock() },
				OnDead:             func(m string) { mu.Lock(); deads = append(deads, m); mu.Unlock() },
				Generation:         func() int64 { mu.Lock(); defer mu.Unlock(); return gen },
				Now:                func() time.Time { mu.Lock(); defer mu.Unlock(); return time.UnixMilli(clock) },
				Connect: func(o ticker.Options) ticker.Handle {
					s := &laneSocket{opts: o, url: ticker.SocketURL(o.URL, o.APIKey, o.AccessToken), pending: append([]int64{}, o.Tokens...)}
					mu.Lock()
					sockets = append(sockets, s)
					mu.Unlock()
					return s
				},
				AfterFunc: func(d time.Duration, fn func()) func() {
					tm := &laneTimer{delay: d.Milliseconds(), fn: fn}
					mu.Lock()
					timers = append(timers, tm)
					mu.Unlock()
					return func() { mu.Lock(); tm.cancelled = true; mu.Unlock() }
				},
			})
			type mark struct{ sent, closes int }
			var socketMarks []mark
			tickMark, connMark, deadMark, timerMark, cancelMark := 0, 0, 0, 0, 0
			for i, st := range sc.Steps {
				op := st.Op
				where := fmt.Sprintf("step %d %s", i, op.Op)
				sock := func() *laneSocket {
					mu.Lock()
					defer mu.Unlock()
					if op.Socket >= len(sockets) {
						t.Fatalf("%s: no socket %d", where, op.Socket)
					}
					return sockets[op.Socket]
				}
				var fired *int64
				switch op.Op {
				case "creds":
					mu.Lock()
					token = ""
					if op.Token != nil {
						token = *op.Token
					}
					mu.Unlock()
				case "generation":
					mu.Lock()
					gen = op.Value
					mu.Unlock()
				case "setTokens":
					f.SetTokens(op.Tokens)
				case "subscribe":
					f.SubscribeTokens(op.Tokens)
				case "unsubscribe":
					f.UnsubscribeTokens(op.Tokens)
				case "ensure":
					f.EnsureSocket()
				case "open":
					sock().open()
				case "frame":
					b, err := hex.DecodeString(op.Hex)
					if err != nil {
						t.Fatal(err)
					}
					if ts := ticker.ParseBinary(b); len(ts) > 0 {
						sock().opts.OnTick(ts)
					}
				case "error":
					sock().opts.OnError(ticker.ErrorMessage)
				case "close":
					sock().opts.OnClose()
				case "fire":
					mu.Lock()
					var next *laneTimer
					for _, tm := range timers {
						if !tm.cancelled && !tm.fired {
							next = tm
							break
						}
					}
					if next == nil {
						mu.Unlock()
						t.Fatalf("%s: no pending reconnect", where)
					}
					next.fired = true
					d := next.delay
					fired = &d
					mu.Unlock()
					next.fn()
				case "advance":
					mu.Lock()
					clock += op.Ms
					mu.Unlock()
				case "stop":
					f.Stop()
				case "query":
					q := st.Query
					stats := string(fvjson.Marshal(f.Stats()))
					if f.IsConnected() != q.Connected || f.WantedCount() != q.Wanted || f.SubscribedCount() != q.Subscribed || stats != q.Stats {
						t.Fatalf("%s: connected %v wanted %d subscribed %d stats %s\nwant %v %d %d %s", where, f.IsConnected(),
							f.WantedCount(), f.SubscribedCount(), stats, q.Connected, q.Wanted, q.Subscribed, q.Stats)
					}
				default:
					t.Fatalf("%s: unknown op", where)
				}

				mu.Lock()
				socks := append([]*laneSocket(nil), sockets...)
				gotTicks, gotConns, gotDeads := append([]string{}, ticks[tickMark:]...), append([]bool{}, conns[connMark:]...), append([]string{}, deads[deadMark:]...)
				tickMark, connMark, deadMark = len(ticks), len(conns), len(deads)
				var scheduled []int64
				for _, tm := range timers[timerMark:] {
					scheduled = append(scheduled, tm.delay)
				}
				timerMark = len(timers)
				cancelled := 0
				for _, tm := range timers {
					if tm.cancelled {
						cancelled++
					}
				}
				gotCancelled := cancelled - cancelMark
				cancelMark = cancelled
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
				for _, s := range st.Sockets {
					if s.Index >= len(socks) {
						t.Fatalf("%s: Node opened socket %d, Go has %d", where, s.Index, len(socks))
					}
				}
				if !equalStrings(gotTicks, st.Ticks) {
					t.Fatalf("%s: ticks\n got %q\nwant %q", where, gotTicks, st.Ticks)
				}
				if len(gotConns) != len(st.Conns) || (len(gotConns) > 0 && !reflect.DeepEqual(gotConns, st.Conns)) {
					t.Fatalf("%s: connection changes %v, want %v", where, gotConns, st.Conns)
				}
				if !equalStrings(gotDeads, st.Deads) {
					t.Fatalf("%s: onDead %q, want %q", where, gotDeads, st.Deads)
				}
				if len(scheduled) != len(st.Scheduled) || (len(scheduled) > 0 && !reflect.DeepEqual(scheduled, st.Scheduled)) {
					t.Fatalf("%s: reconnects scheduled %v, want %v", where, scheduled, st.Scheduled)
				}
				if gotCancelled != st.Cancelled {
					t.Fatalf("%s: %d reconnects cancelled, want %d", where, gotCancelled, st.Cancelled)
				}
				if (fired == nil) != (st.Fired == nil) || (fired != nil && *fired != *st.Fired) {
					t.Fatalf("%s: fired %v, want %v", where, fired, st.Fired)
				}
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestZerodhaFeedRealTimerReconnects drives the default scheduler: a close schedules a
// real reconnect after ReconnectBase, and Stop cancels a pending one.
func TestZerodhaFeedRealTimerReconnects(t *testing.T) {
	var mu sync.Mutex
	var sockets []*laneSocket
	opened := make(chan struct{}, 8)
	f := NewZerodhaFeed(ZerodhaFeedOptions{
		Lane:          LaneFutures,
		Credentials:   func() Credentials { return Credentials{APIKey: "k", AccessToken: "t"} },
		ReconnectBase: 20 * time.Millisecond,
		ReconnectMax:  40 * time.Millisecond,
		Connect: func(o ticker.Options) ticker.Handle {
			s := &laneSocket{opts: o, pending: append([]int64{}, o.Tokens...)}
			mu.Lock()
			sockets = append(sockets, s)
			mu.Unlock()
			opened <- struct{}{}
			return s
		},
	})
	f.SetTokens([]int64{1})
	<-opened
	mu.Lock()
	first := sockets[0]
	mu.Unlock()
	first.opts.OnClose()
	select {
	case <-opened:
	case <-time.After(2 * time.Second):
		t.Fatal("no reconnect after a close")
	}
	mu.Lock()
	second := sockets[1]
	mu.Unlock()
	second.opts.OnClose()
	f.Stop()
	select {
	case <-opened:
		t.Fatal("Stop did not cancel the pending reconnect")
	case <-time.After(150 * time.Millisecond):
	}
	if st := f.Stats(); st.Connected || st.WantedTokens != 0 || st.Reconnects != 2 {
		t.Fatalf("stats after Stop %+v", st)
	}
}
