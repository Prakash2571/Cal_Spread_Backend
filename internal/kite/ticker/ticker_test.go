package ticker

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const wait = 5 * time.Second

// recorder collects a socket's callbacks in the golden's event notation.
type recorder struct {
	mu     sync.Mutex
	events []string
	ticks  [][]market.Tick
	opened chan struct{}
	closed chan struct{}
}

func newRecorder() *recorder {
	return &recorder{opened: make(chan struct{}, 1), closed: make(chan struct{}, 4)}
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.events...)
}

func (r *recorder) options(url, apiKey, accessToken string, tokens []int64) Options {
	return Options{URL: url, APIKey: apiKey, AccessToken: accessToken, Tokens: tokens,
		OnTick: func(ticks []market.Tick) {
			r.mu.Lock()
			r.ticks = append(r.ticks, ticks)
			r.mu.Unlock()
			r.add(fmt.Sprintf("tick:%d", len(ticks)))
		},
		OnOpen: func() {
			r.add("open")
			r.opened <- struct{}{}
		},
		OnError: func(m string) { r.add("error:" + m) },
		OnClose: func() {
			r.add("close")
			r.closed <- struct{}{}
		},
	}
}

func (r *recorder) waitOpen(t *testing.T) {
	t.Helper()
	select {
	case <-r.opened:
	case <-time.After(wait):
		t.Fatalf("socket did not open; events %v", r.list())
	}
}

func (r *recorder) waitClosed(t *testing.T) {
	t.Helper()
	select {
	case <-r.closed:
	case <-time.After(wait):
		t.Fatalf("socket did not close; events %v", r.list())
	}
	time.Sleep(20 * time.Millisecond) // nothing may follow the close
}

type messagesCase struct {
	Name        string  `json:"name"`
	APIKey      string  `json:"apiKey"`
	AccessToken string  `json:"accessToken"`
	Tokens      []int64 `json:"tokens"`
	Ops         []struct {
		Op     string  `json:"op"`
		Tokens []int64 `json:"tokens"`
	} `json:"ops"`
	URL        string   `json:"url"`
	BinaryType string   `json:"binaryType"`
	Sent       []string `json:"sent"`
	Events     []string `json:"events"`
}

// fakeKite is a local ticker endpoint. The handshake waits for open(), so a test can act
// on a socket that is still connecting; every frame the client sends is recorded.
type fakeKite struct {
	srv    *httptest.Server
	gate   chan struct{}
	once   sync.Once
	query  chan string
	frames chan string
}

func newFakeKite(t *testing.T) *fakeKite {
	k := &fakeKite{gate: make(chan struct{}), query: make(chan string, 1), frames: make(chan string, 64)}
	up := websocket.Upgrader{}
	k.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		k.query <- r.URL.RawQuery
		<-k.gate
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			mt, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if mt == websocket.TextMessage {
				k.frames <- string(data)
			} else {
				k.frames <- "binary:" + hex.EncodeToString(data)
			}
		}
	}))
	t.Cleanup(func() {
		k.open()
		k.srv.Close()
	})
	return k
}

func (k *fakeKite) open() { k.once.Do(func() { close(k.gate) }) }

func (k *fakeKite) url() string { return "ws" + strings.TrimPrefix(k.srv.URL, "http") }

func (k *fakeKite) next(t *testing.T) string {
	t.Helper()
	select {
	case f := <-k.frames:
		return f
	case <-time.After(wait):
		t.Fatal("no frame from the client")
		return ""
	}
}

// TestTickerMessagesGolden replays tests through src/ticker.ts connectTicker (recorded with
// a fake global WebSocket by gen_ticker_messages.mjs) against a real local socket: the URL
// with encoded credentials, and every text frame in order, including subscriptions queued
// or dropped before the socket opened.
func TestTickerMessagesGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "ticker_messages.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/kite/testdata/gen_ticker_messages.mjs)", err)
	}
	var g struct {
		Cases []messagesCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 13 {
		t.Fatalf("golden has only %d cases", len(g.Cases))
	}
	const marker = 987654321
	markerFrame := fmt.Sprintf(`{"a":"subscribe","v":[%d]}`, marker)
	for _, c := range g.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if got := SocketURL("", c.APIKey, c.AccessToken); got != c.URL {
				t.Fatalf("url %q, want %q", got, c.URL)
			}
			if c.BinaryType != "arraybuffer" {
				t.Fatalf("binaryType %q", c.BinaryType)
			}
			opens := false
			for _, op := range c.Ops {
				opens = opens || op.Op == "open"
			}
			if !opens {
				if len(c.Sent) != 0 || len(c.Events) != 0 {
					t.Fatal("a socket that never opened sent frames in Node")
				}
				return
			}
			k := newFakeKite(t)
			rec := newRecorder()
			h := Connect(rec.options(k.url(), c.APIKey, c.AccessToken, c.Tokens))
			select {
			case q := <-k.query:
				if want := strings.TrimPrefix(c.URL, DefaultURL); "?"+q != want {
					t.Fatalf("query %q, want %q", "?"+q, want)
				}
			case <-time.After(wait):
				t.Fatal("no connection")
			}
			for _, op := range c.Ops {
				switch op.Op {
				case "open":
					k.open()
					rec.waitOpen(t)
				case "subscribe":
					h.Subscribe(op.Tokens)
				case "unsubscribe":
					h.Unsubscribe(op.Tokens)
				default:
					t.Fatalf("unknown op %q", op.Op)
				}
			}
			h.Subscribe([]int64{marker}) // everything sent before it arrives first
			sent := []string{}
			for f := k.next(t); f != markerFrame; f = k.next(t) {
				sent = append(sent, f)
			}
			if mode := k.next(t); mode != fmt.Sprintf(`{"a":"mode","v":["full",[%d]]}`, marker) {
				t.Fatalf("marker mode frame %q", mode)
			}
			if !reflect.DeepEqual(sent, c.Sent) {
				t.Fatalf("sent\n got %q\nwant %q", sent, c.Sent)
			}
			if got := rec.list(); !reflect.DeepEqual(got, c.Events) {
				t.Fatalf("events %v, want %v", got, c.Events)
			}
			h.Close()
			rec.waitClosed(t)
			if got := rec.list(); !reflect.DeepEqual(got, append(append([]string{}, c.Events...), "close")) {
				t.Fatalf("events after Close %v", got)
			}
		})
	}
}

// rawKite accepts one connection and, when handshake is set, completes the WebSocket
// handshake by hand; script then owns the raw connection, so a test can send frames that
// a WebSocket library would refuse to write. The connection closes when script returns.
func rawKite(t *testing.T, handshake bool, script func(c net.Conn, r *bufio.Reader)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var mu sync.Mutex
	var accepted net.Conn
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		if accepted != nil {
			accepted.Close() // unblocks a script waiting on a read
		}
		mu.Unlock()
		<-done
	})
	go func() {
		defer close(done)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		mu.Lock()
		accepted = c
		mu.Unlock()
		r := bufio.NewReader(c)
		req, err := http.ReadRequest(r)
		if err != nil {
			return
		}
		if handshake {
			sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
			fmt.Fprintf(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
				base64.StdEncoding.EncodeToString(sum[:]))
		}
		script(c, r)
	}()
	return "ws://" + ln.Addr().String()
}

// wsFrame is an unmasked server frame with FIN set.
func wsFrame(opcode byte, payload []byte) []byte {
	b := []byte{0x80 | opcode}
	switch n := len(payload); {
	case n < 126:
		b = append(b, byte(n))
	case n < 65536:
		b = append(b, 126, byte(n>>8), byte(n))
	default:
		b = append(b, 127)
		b = binary.BigEndian.AppendUint64(b, uint64(n))
	}
	return append(b, payload...)
}

// readClientFrame reads one masked client frame and returns its opcode.
func readClientFrame(r *bufio.Reader) (byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, err
	}
	n := int(head[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, err
		}
		n = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, err
		}
		n = int(binary.BigEndian.Uint64(ext[:]))
	}
	if _, err := io.CopyN(io.Discard, r, int64(4+n)); err != nil { // mask key + payload
		return 0, err
	}
	return head[0] & 0x0f, nil
}

// TestConnectEventsMatchNode pins the callback sequence for every way a socket ends.
// Node 22 (undici) was probed with the same raw frames (see Connect's comment).
func TestConnectEventsMatchNode(t *testing.T) {
	var tickPayload []byte
	var tickCount int
	for _, c := range loadGolden(t) {
		if c.Error == nil && len(c.Ticks) > 1 {
			tickPayload, _ = hex.DecodeString(c.Hex)
			tickCount = len(c.Ticks)
			break
		}
	}
	if tickPayload == nil {
		t.Fatal("no multi-tick frame in the parse golden")
	}
	errEvent := "error:" + ErrorMessage
	write := func(frames ...[]byte) func(net.Conn, *bufio.Reader) {
		return func(c net.Conn, _ *bufio.Reader) {
			for _, f := range frames {
				_, _ = c.Write(f)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	cases := []struct {
		name      string
		handshake bool
		script    func(net.Conn, *bufio.Reader)
		want      []string
	}{
		{"failed handshake", false, write([]byte("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")), []string{errEvent, "close"}},
		{"tcp drop after open", true, write(), []string{"open", "close"}},
		{"close frame then drop", true, write(wsFrame(0x8, nil)), []string{"open", "close"}},
		{"close frame with code", true, write(wsFrame(0x8, []byte{0x03, 0xe8})), []string{"open", "close"}},
		{"reserved bit set", true, write([]byte{0xc2, 0x01, 0x00}), []string{"open", errEvent, "close"}},
		{"masked server frame", true, write([]byte{0x82, 0x81, 1, 2, 3, 4, 5}), []string{"open", errEvent, "close"}},
		{"text frame not utf-8", true, write(wsFrame(0x1, []byte{0xff})), []string{"open", errEvent, "close"}},
		{"ticks, postbacks and heartbeats", true, write(wsFrame(0x2, tickPayload), wsFrame(0x1, []byte(`{"type":"order","data":{}}`)),
			wsFrame(0x2, []byte{0}), wsFrame(0x8, nil)), []string{"open", fmt.Sprintf("tick:%d", tickCount), "close"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := newRecorder()
			h := Connect(rec.options(rawKite(t, c.handshake, c.script), "key", "tok", nil))
			defer h.Close()
			rec.waitClosed(t)
			if got := rec.list(); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("events %v, want %v", got, c.want)
			}
		})
	}
	t.Run("tick contents", func(t *testing.T) {
		rec := newRecorder()
		h := Connect(rec.options(rawKite(t, true, write(wsFrame(0x2, tickPayload), wsFrame(0x8, nil))), "key", "tok", nil))
		defer h.Close()
		rec.waitClosed(t)
		rec.mu.Lock()
		defer rec.mu.Unlock()
		if len(rec.ticks) != 1 || !reflect.DeepEqual(rec.ticks[0], ParseBinary(tickPayload)) {
			t.Fatalf("ticks %v", rec.ticks)
		}
	})
	t.Run("close before open", func(t *testing.T) {
		// The server reads the upgrade request and never answers, so only Close can end
		// the dial (well before the 45 s handshake timeout).
		release := make(chan struct{})
		url := rawKite(t, false, func(net.Conn, *bufio.Reader) { <-release })
		t.Cleanup(func() { close(release) }) // runs before rawKite's cleanup waits
		rec := newRecorder()
		h := Connect(rec.options(url, "key", "tok", nil))
		time.Sleep(50 * time.Millisecond)
		start := time.Now()
		h.Close()
		rec.waitClosed(t)
		if d := time.Since(start); d > time.Second {
			t.Fatalf("Close before open took %v", d)
		}
		if got := rec.list(); !reflect.DeepEqual(got, []string{errEvent, "close"}) {
			t.Fatalf("events %v", got)
		}
	})
	t.Run("close after open", func(t *testing.T) {
		rec := newRecorder()
		url := rawKite(t, true, func(c net.Conn, r *bufio.Reader) {
			for {
				op, err := readClientFrame(r)
				if err != nil {
					return
				}
				if op == 0x8 {
					_, _ = c.Write(wsFrame(0x8, nil))
					return
				}
			}
		})
		h := Connect(rec.options(url, "key", "tok", []int64{1}))
		rec.waitOpen(t)
		h.Close()
		h.Close() // idempotent
		rec.waitClosed(t)
		if got := rec.list(); !reflect.DeepEqual(got, []string{"open", "close"}) {
			t.Fatalf("events %v", got)
		}
	})
}
