// Package livestream accepts read-only websocket consumers of the existing hub.
// Its only source capability is AddTickListener; it cannot open a feed or subscribe.
package livestream

import (
	"crypto/sha256"
	"crypto/subtle"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const (
	Path             = "/api/stream/live"
	MaxConsumers     = 10
	MaxReplacements  = 128
	writeWait        = 5 * time.Second
	closeWait        = time.Second
	pongWait         = 60 * time.Second
	pingInterval     = 25 * time.Second
	maxClientMessage = 4096
)

// TickSource deliberately excludes all upstream and subscription operations.
type TickSource interface {
	AddTickListener(func([]market.Tick)) func()
}

type batch struct {
	ticks      []market.Tick
	receivedAt int64
}

type consumer struct {
	queue        chan batch
	done         chan struct{}
	replacements atomic.Int32
	closing      atomic.Pointer[closeReason]
}

type closeReason struct {
	code int
	text string
}

func newConsumer() *consumer {
	return &consumer{queue: make(chan batch, 1), done: make(chan struct{})}
}

func (c *consumer) stop(code int, reason string) {
	if c.closing.CompareAndSwap(nil, &closeReason{code: code, text: reason}) {
		close(c.done)
	}
}

// offer never waits for a writer. Only the hub's serial listener delivery calls it.
func (c *consumer) offer(b batch) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.queue <- b:
		return
	default:
	}
	select {
	case <-c.queue:
		if c.replacements.Add(1) >= MaxReplacements {
			c.stop(websocket.ClosePolicyViolation, "slow consumer")
			return
		}
	default:
		// The writer took the stale batch between the two channel operations.
	}
	select {
	case c.queue <- b:
	default:
	}
}

// Relay owns only downstream consumers. The immutable audience snapshot lets its
// callback fan out without waiting on admission, cleanup, serialization or I/O.
type Relay struct {
	enabled  bool
	digest   [sha256.Size]byte
	now      func() time.Time
	unlisten func()

	mu       sync.Mutex
	closed   bool
	clients  map[*consumer]struct{}
	audience atomic.Pointer[[]*consumer]
}

// New captures the startup configuration. An empty secret disables admissions and
// does not even register a listener. The caller owns Close at server shutdown.
func New(source TickSource, secret string) *Relay {
	r := &Relay{
		enabled: secret != "", digest: sha256.Sum256([]byte(secret)),
		now: time.Now, clients: map[*consumer]struct{}{},
	}
	if r.enabled {
		r.unlisten = source.AddTickListener(r.publish)
	}
	return r
}

func (r *Relay) Mount(router chi.Router) { router.Get(Path, r.ServeHTTP) }

func (r *Relay) snapshotLocked() {
	if r.closed {
		r.audience.Store(nil)
		return
	}
	clients := make([]*consumer, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.audience.Store(&clients)
}

// reserve includes pending upgrades in the cap. It never waits for an available slot.
func (r *Relay) reserve() *consumer {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || len(r.clients) >= MaxConsumers {
		return nil
	}
	c := newConsumer()
	r.clients[c] = struct{}{}
	r.snapshotLocked()
	return c
}

func (r *Relay) release(c *consumer) {
	r.mu.Lock()
	delete(r.clients, c)
	r.snapshotLocked()
	r.mu.Unlock()
}

// Close signals writers and removes the read-only listener, without touching the feed.
// Writers send a bounded close frame and close their sockets, unblocking readers.
func (r *Relay) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.audience.Store(nil)
	for c := range r.clients {
		c.stop(websocket.CloseGoingAway, "server shutdown")
	}
	r.mu.Unlock()
	if r.unlisten != nil {
		r.unlisten()
	}
}

func (r *Relay) publish(ticks []market.Tick) {
	clients := r.audience.Load()
	if clients == nil || len(*clients) == 0 || len(ticks) == 0 {
		return
	}
	b := copyBatch(ticks, r.now().UnixMilli())
	for _, c := range *clients {
		c.offer(b)
	}
}

func (r *Relay) authenticated(req *http.Request) bool {
	credential := ""
	if values, present := req.Header["Authorization"]; present {
		if len(values) != 1 {
			return false
		}
		parts := strings.SplitN(values[0], " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return false
		}
		credential = parts[1]
	} else if values, present := req.Header["X-Stream-Secret"]; present {
		if len(values) != 1 {
			return false
		}
		credential = values[0]
	} else {
		values := req.URL.Query()["secret"]
		if len(values) != 1 {
			return false
		}
		credential = values[0]
	}
	got := sha256.Sum256([]byte(credential))
	return subtle.ConstantTimeCompare(got[:], r.digest[:]) == 1
}

func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !r.enabled {
		httpx.Error(w, http.StatusServiceUnavailable, "Live stream is disabled")
		return
	}
	if !r.authenticated(req) {
		httpx.Error(w, http.StatusForbidden, "Stream authentication required")
		return
	}
	if req.Method != http.MethodGet {
		httpx.Error(w, http.StatusMethodNotAllowed, "Websocket GET required")
		return
	}
	c := r.reserve()
	if c == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Live stream unavailable or at capacity")
		return
	}
	defer r.release(c)
	upgrader := websocket.Upgrader{
		HandshakeTimeout: writeWait,
		// Auth is explicit shared-secret possession, independent of cookies/Origin.
		CheckOrigin: func(*http.Request) bool { return true },
		// Never include an upgrader error (potentially containing request input).
		Error: func(w http.ResponseWriter, _ *http.Request, status int, _ error) {
			httpx.Error(w, status, "Websocket upgrade required")
		},
	}
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxClientMessage)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		r.write(conn, c)
	}()
	defer func() {
		c.stop(websocket.CloseNormalClosure, "")
		<-writerDone
	}()
	for {
		_, reader, err := conn.NextReader()
		if err != nil {
			return
		}
		// Control frames are processed by Gorilla; application data has no protocol.
		if _, err = io.Copy(io.Discard, reader); err != nil {
			return
		}
	}
}

func (r *Relay) write(conn *websocket.Conn, c *consumer) {
	defer conn.Close()
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	closeFrame := func() {
		reason := c.closing.Load()
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(reason.code, reason.text), time.Now().Add(closeWait))
	}
	for {
		// Prioritize closure even if batches remain ready.
		select {
		case <-c.done:
			closeFrame()
			return
		default:
		}
		select {
		case <-c.done:
			closeFrame()
			return
		case b := <-c.queue:
			c.replacements.Store(0)
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.TextMessage, encodeBatch(b)); err != nil {
				return
			}
		case <-ping.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
				return
			}
		}
	}
}
