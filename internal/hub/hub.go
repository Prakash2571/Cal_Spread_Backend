// Package hub is src/hub.ts TickerHub: the shared latest-tick and order-book cache, the
// SSE fan-out to browsers, headless tick and connection listeners, and the legacy
// hub-owned Kite socket (opened only by retain/subscribeTokens/addClient, never by
// attachClient or retainFanout).
//
// Go synchronisation (Node relied on its single thread):
//   - one mutex guards all state; ticker callbacks are matched to the current socket by
//     a per-socket id under that mutex, so a superseded socket cannot touch state;
//   - listener callbacks (ticks, connection changes, onDead) run outside the mutex
//     through one serial queue, so they see events in the order the state changed and
//     never concurrently, and may call back into the hub;
//   - each SSE client has its own writer goroutine and bounded frame queue, so a slow
//     browser cannot stall the tick path (see Deps.ClientQueue).
package hub

import (
	"log"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// DefaultLadderMaxAgeMs is getFreshLadder's default freshness bound.
const DefaultLadderMaxAgeMs = 5000

// DefaultClientQueue is the default per-client frame queue (Deps.ClientQueue).
const DefaultClientQueue = 1024

// Creds are the Kite credentials, read fresh whenever the hub opens its socket.
// AccessToken "" means no session (Node null).
type Creds struct {
	APIKey      string
	AccessToken string
}

// Deps are the hub's collaborators.
type Deps struct {
	// Creds is called only when the hub needs its own Kite socket.
	Creds func() Creds
	// OnDead is called when the hub's Kite socket fails (Node: clear the Kite session,
	// memory and persisted, and drop the Box books).
	OnDead func()
	// Connect opens a ticker socket; defaults to ticker.Connect. It must not invoke the
	// callbacks synchronously.
	Connect ticker.ConnectFunc
	// TickerURL replaces wss://ws.kite.trade for the default Connect.
	TickerURL string
	// Now defaults to time.Now.
	Now func() time.Time
	// ClientQueue is how many frames may wait for one slow SSE client before the hub drops
	// it (detaches it and calls Client.Close so the browser reconnects). Node buffered
	// without bound; this bound is the one deliberate deviation. Default 1024.
	ClientQueue int
}

// Ladder is the latest full order book for a token.
type Ladder struct {
	Last float64             `json:"last"`
	Bids []market.DepthLevel `json:"bids"`
	Asks []market.DepthLevel `json:"asks"`
}

// LadderSnapshot is a ladder with the receive instant (epoch ms).
type LadderSnapshot struct {
	Ladder
	At int64 `json:"at"`
}

// Hub is the ticker hub. It is safe for concurrent use.
type Hub struct {
	deps Deps

	mu             sync.Mutex
	sock           *socket
	sockSeq        uint64
	clients        map[*client]struct{}
	subscribed     *tokenSet
	retainers      map[uint64]struct{}
	retainSeq      uint64
	tickListeners  []*tickListener
	connListeners  []*connListener
	connected      bool
	latest         map[int64]market.Tick
	latestAt       map[int64]int64
	latestLadder   map[int64]Ladder
	latestLadderAt map[int64]int64

	events serialQueue
}

type socket struct {
	id uint64
	h  ticker.Handle
}

type tickListener struct {
	fn      func([]market.Tick)
	removed atomic.Bool
}

type connListener struct {
	fn      func(bool)
	removed atomic.Bool
}

// New builds a hub.
func New(deps Deps) *Hub {
	if deps.Connect == nil {
		deps.Connect = ticker.Connect
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.ClientQueue <= 0 {
		deps.ClientQueue = DefaultClientQueue
	}
	return &Hub{
		deps:           deps,
		clients:        map[*client]struct{}{},
		subscribed:     newTokenSet(),
		retainers:      map[uint64]struct{}{},
		latest:         map[int64]market.Tick{},
		latestAt:       map[int64]int64{},
		latestLadder:   map[int64]Ladder{},
		latestLadderAt: map[int64]int64{},
	}
}

func (h *Hub) nowMs() int64 { return h.deps.Now().UnixMilli() }

// ---------------------------------------------------------------------------
// SSE clients

// AttachClient registers c for fan-out only (never opens an upstream socket) and queues,
// before any later broadcast, one "data:" frame with the cached ticks for its tokens, if
// any. The returned detach function is idempotent. It removes the client, calls c.Close,
// and waits for the client's writer goroutine, so nothing is written to c after it
// returns (every call waits, not only the first); it must therefore not be called from
// inside c.WriteFrame. A route must call it before returning, also when the hub dropped
// the client, because the writer may still be inside a write when Done fires. It does
// not stop the upstream feed.
//
// Like Node, every broadcast goes to every client: the token set only selects the
// snapshot (and protects tokens from UnsubscribeTokens).
func (h *Hub) AttachClient(c Client, tokens []int64) func() {
	cl := newClient(c, tokens, h.deps.ClientQueue)
	h.mu.Lock()
	h.clients[cl] = struct{}{}
	h.snapshotLocked(cl, tokens)
	h.mu.Unlock()
	return func() { h.detach(cl, false) }
}

// AddClient is the deprecated legacy Zerodha path: attach AND open the hub's own Kite
// socket for tokens. Its detach stops the socket when no client and no retainer is left.
func (h *Hub) AddClient(c Client, tokens []int64) func() {
	creds := h.creds()
	cl := newClient(c, tokens, h.deps.ClientQueue)
	h.mu.Lock()
	h.clients[cl] = struct{}{}
	h.ensureSocketLocked(creds, tokens)
	h.snapshotLocked(cl, tokens)
	h.mu.Unlock()
	return func() { h.detach(cl, true) }
}

func (h *Hub) snapshotLocked(cl *client, tokens []int64) {
	var snap []market.Tick
	for _, t := range tokens {
		if tk, ok := h.latest[t]; ok {
			snap = append(snap, tk)
		}
	}
	if len(snap) > 0 {
		h.sendLocked(cl, DataFrame(TicksJSON(snap)))
	}
}

func (h *Hub) detach(cl *client, legacy bool) {
	first := false
	cl.detachOnce.Do(func() { first = true })
	if !first {
		// Another caller is detaching: still wait until the writer stopped using the
		// client, so a route may return (and net/http recycle the response) right after.
		<-cl.done
		return
	}
	h.mu.Lock()
	delete(h.clients, cl)
	stop := legacy && len(h.clients) == 0 && len(h.retainers) == 0
	h.mu.Unlock()
	cl.halt(false)
	// Close aborts a WriteFrame stuck on a dead peer, so waiting for the writer is bounded.
	cl.closeClient()
	<-cl.done
	if stop {
		h.Stop()
	}
}

// sendLocked queues a frame for one client; a full queue drops the client.
func (h *Hub) sendLocked(cl *client, frame []byte) {
	if _, live := h.clients[cl]; !live {
		return
	}
	select {
	case cl.frames <- frame:
	default:
		delete(h.clients, cl)
		cl.halt(true)
		// The writer may be stuck in a write to a peer that stopped reading, where it
		// cannot see the halt: Close (non-blocking by contract) aborts that write and
		// tells the route to end the stream.
		cl.closeClient()
		log.Printf("[Hub] SSE client dropped: %d frames behind", cap(cl.frames))
	}
}

func (h *Hub) sendAllLocked(frame []byte) {
	for cl := range h.clients {
		h.sendLocked(cl, frame)
	}
}

// ---------------------------------------------------------------------------
// Cache, retention, subscriptions

// Seed puts REST ticks into the cache (as given; no receive time).
func (h *Hub) Seed(ticks []market.Tick) {
	h.mu.Lock()
	for _, t := range ticks {
		h.latest[t.Token] = t
	}
	h.mu.Unlock()
}

// Retain holds the hub's own socket open (and opens it for tokens) without being an SSE
// client. Release stops the hub when no client and no retainer is left; like Node it is
// not idempotent in that respect (a second call may stop again).
func (h *Hub) Retain(tokens []int64) func() {
	h.mu.Lock()
	h.retainSeq++
	key := h.retainSeq
	h.retainers[key] = struct{}{}
	h.mu.Unlock()
	h.ensureSocket(tokens)
	return func() {
		h.mu.Lock()
		delete(h.retainers, key)
		stop := len(h.clients) == 0 && len(h.retainers) == 0
		h.mu.Unlock()
		if stop {
			h.Stop()
		}
	}
}

// RetainFanout keeps the downstream cache/fan-out retained without reading credentials
// or opening a socket. Its release is idempotent and never stops anything.
func (h *Hub) RetainFanout() func() {
	h.mu.Lock()
	h.retainSeq++
	key := h.retainSeq
	h.retainers[key] = struct{}{}
	h.mu.Unlock()
	return func() {
		h.mu.Lock()
		delete(h.retainers, key)
		h.mu.Unlock()
	}
}

// SubscribeTokens subscribes extra tokens on the hub's own socket (opening it).
func (h *Hub) SubscribeTokens(tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	h.ensureSocket(tokens)
}

// UnsubscribeTokens drops tokens no SSE client asks for: from the subscribed set, every
// cache and the socket.
func (h *Hub) UnsubscribeTokens(tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	stillWanted := map[int64]struct{}{}
	for cl := range h.clients {
		for t := range cl.tokens {
			stillWanted[t] = struct{}{}
		}
	}
	var drop []int64
	for _, t := range tokens {
		if _, keep := stillWanted[t]; !keep && h.subscribed.has(t) {
			drop = append(drop, t)
		}
	}
	if len(drop) == 0 {
		return
	}
	for _, t := range drop {
		h.subscribed.remove(t)
		delete(h.latest, t)
		delete(h.latestAt, t)
		delete(h.latestLadder, t)
		delete(h.latestLadderAt, t)
	}
	if h.sock != nil {
		h.sock.h.Unsubscribe(drop)
	}
}

// AddTickListener registers a headless tick consumer; the returned function removes it.
func (h *Hub) AddTickListener(fn func([]market.Tick)) func() {
	l := &tickListener{fn: fn}
	h.mu.Lock()
	h.tickListeners = append(h.tickListeners, l)
	h.mu.Unlock()
	return func() {
		l.removed.Store(true)
		h.mu.Lock()
		for i, x := range h.tickListeners {
			if x == l {
				h.tickListeners = append(h.tickListeners[:i:i], h.tickListeners[i+1:]...)
				break
			}
		}
		h.mu.Unlock()
	}
}

// AddConnectionListener observes socket generations; fn receives the current state at
// once, then every change. The initial call goes through the same serial queue as the
// changes, so a listener can never see an older state after a newer one; when no other
// callback is running it is made before AddConnectionListener returns.
func (h *Hub) AddConnectionListener(fn func(bool)) func() {
	l := &connListener{fn: fn}
	h.mu.Lock()
	h.connListeners = append(h.connListeners, l)
	connected := h.connected
	h.events.push(func() {
		if !l.removed.Load() {
			safeCall("connection listener", func() { l.fn(connected) })
		}
	})
	h.mu.Unlock()
	h.events.drain()
	return func() {
		l.removed.Store(true)
		h.mu.Lock()
		for i, x := range h.connListeners {
			if x == l {
				h.connListeners = append(h.connListeners[:i:i], h.connListeners[i+1:]...)
				break
			}
		}
		h.mu.Unlock()
	}
}

// IsConnected reports whether the feed is connected (own socket open, or the external
// feed reported connected).
func (h *Hub) IsConnected() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.connected
}

// SubscribedCount is how many tokens the hub's own socket is subscribed to.
func (h *Hub) SubscribedCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.subscribed.len()
}

// GetFreshLadder is the latest book for token if it was received within maxAgeMs.
func (h *Hub) GetFreshLadder(token int64, maxAgeMs int64) (Ladder, bool) {
	now := h.nowMs()
	h.mu.Lock()
	defer h.mu.Unlock()
	l, ok := h.latestLadder[token]
	at, okAt := h.latestLadderAt[token]
	if !ok || !okAt || now-at > maxAgeMs {
		return Ladder{}, false
	}
	return l, true
}

// GetLatestTick is the cached tick for token.
func (h *Hub) GetLatestTick(token int64) (market.Tick, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t, ok := h.latest[token]
	return t, ok
}

// GetLadderSnapshot is the latest book with its receive instant; the caller applies its
// own freshness policy.
func (h *Hub) GetLadderSnapshot(token int64) (LadderSnapshot, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l, ok := h.latestLadder[token]
	at, okAt := h.latestLadderAt[token]
	if !ok || !okAt {
		return LadderSnapshot{}, false
	}
	return LadderSnapshot{Ladder: l, At: at}, true
}

// IngestExternalTicks publishes ticks from another feed (Dhan, or a Zerodha lane owned by
// the registry) through the same caches, listeners and fan-out. It opens no socket.
func (h *Hub) IngestExternalTicks(ticks []market.Tick) {
	if len(ticks) == 0 {
		return
	}
	h.mu.Lock()
	h.broadcastLocked(ticks)
	h.mu.Unlock()
	h.events.drain()
}

// SetExternalConnected reports an external feed's connection state to the connection
// listeners (deduplicated).
func (h *Hub) SetExternalConnected(connected bool) {
	h.mu.Lock()
	h.notifyLocked(connected)
	h.mu.Unlock()
	h.events.drain()
}

// Stop closes the hub's socket, reports disconnected and discards every cached tick and
// book (clients stay attached).
func (h *Hub) Stop() {
	h.mu.Lock()
	s := h.sock
	h.sock = nil
	if s != nil {
		s.h.Close()
	}
	h.notifyLocked(false)
	h.subscribed = newTokenSet()
	h.latest = map[int64]market.Tick{}
	h.latestLadder = map[int64]Ladder{}
	h.latestLadderAt = map[int64]int64{}
	h.latestAt = map[int64]int64{}
	h.mu.Unlock()
	h.events.drain()
}

// ---------------------------------------------------------------------------
// Own socket

// creds reads the Kite credentials (outside the hub lock: the callback is the caller's).
func (h *Hub) creds() Creds {
	if h.deps.Creds == nil {
		return Creds{}
	}
	return h.deps.Creds()
}

func (h *Hub) ensureSocket(tokens []int64) {
	creds := h.creds()
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureSocketLocked(creds, tokens)
}

// ensureSocketLocked is hub.ts ensureSocket: without an access token nothing happens;
// otherwise the not-yet-subscribed tokens (duplicates in tokens are kept, as in Node)
// are recorded, and either a socket is opened with the whole subscribed set or the new
// tokens are subscribed on the live one.
func (h *Hub) ensureSocketLocked(creds Creds, tokens []int64) {
	if creds.AccessToken == "" {
		return
	}
	var fresh []int64
	for _, t := range tokens {
		if !h.subscribed.has(t) {
			fresh = append(fresh, t)
		}
	}
	for _, t := range fresh {
		h.subscribed.add(t)
	}
	if h.sock == nil {
		h.sockSeq++
		id := h.sockSeq
		s := &socket{id: id}
		s.h = h.deps.Connect(ticker.Options{
			URL:         h.deps.TickerURL,
			APIKey:      creds.APIKey,
			AccessToken: creds.AccessToken,
			Tokens:      h.subscribed.list(),
			OnTick:      func(ticks []market.Tick) { h.onSocketTick(id, ticks) },
			OnOpen:      func() { h.onSocketOpen(id) },
			OnError:     func(msg string) { h.onSocketError(id, msg) },
			OnClose:     func() { h.onSocketClose(id) },
		})
		h.sock = s
	} else if len(fresh) > 0 {
		h.sock.h.Subscribe(fresh)
	}
}

// currentLocked reports whether id is the live socket generation.
func (h *Hub) currentLocked(id uint64) bool { return h.sock != nil && h.sock.id == id }

func (h *Hub) onSocketTick(id uint64, ticks []market.Tick) {
	h.mu.Lock()
	if !h.currentLocked(id) {
		h.mu.Unlock()
		return
	}
	h.broadcastLocked(ticks)
	h.mu.Unlock()
	h.events.drain()
}

func (h *Hub) onSocketOpen(id uint64) {
	h.mu.Lock()
	if !h.currentLocked(id) {
		h.mu.Unlock()
		return
	}
	h.notifyLocked(true)
	h.mu.Unlock()
	h.events.drain()
}

func (h *Hub) onSocketError(id uint64, message string) {
	h.mu.Lock()
	if !h.currentLocked(id) {
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()
	h.fail(message)
}

func (h *Hub) onSocketClose(id uint64) {
	h.mu.Lock()
	if !h.currentLocked(id) {
		h.mu.Unlock()
		return
	}
	h.sock = nil
	h.notifyLocked(false)
	h.mu.Unlock()
	h.events.drain()
}

// fail is the dead-token path: onDead, a kite_error frame to every client, then Stop.
func (h *Hub) fail(message string) {
	// Node called onDead first, with the hub state intact, then wrote the frames, then
	// stopped: onDead runs through the serial queue, ahead of the stop's own events.
	if h.deps.OnDead != nil {
		h.events.push(h.deps.OnDead)
		h.events.drain()
	}
	h.mu.Lock()
	h.sendAllLocked(KiteErrorFrame(message))
	h.mu.Unlock()
	h.Stop()
}

// ---------------------------------------------------------------------------
// Broadcast

// broadcastLocked caches slim copies of ticks, updates the order books, queues the
// listener delivery and queues one frame for every client.
func (h *Hub) broadcastLocked(ticks []market.Tick) {
	now := h.nowMs()
	slim := make([]market.Tick, 0, len(ticks))
	for i := range ticks {
		t := &ticks[i]
		s := market.Tick{
			Token: t.Token, LastPrice: t.LastPrice, ClosePrice: t.ClosePrice,
			OI: t.OI, Bid: t.Bid, Ask: t.Ask, Bids: t.Bids, Asks: t.Asks,
		}
		if t.DepthUpdated != nil {
			v := *t.DepthUpdated
			s.DepthUpdated = &v
		}
		if t.ExchangeTS != nil && *t.ExchangeTS != 0 {
			v := *t.ExchangeTS
			s.ExchangeTS = &v
		}
		h.latest[t.Token] = s
		h.latestAt[t.Token] = now
		legacyDepth := t.DepthUpdated == nil && (t.Bids != nil || t.Asks != nil)
		authoritative := (t.DepthUpdated != nil && *t.DepthUpdated) || legacyDepth
		if authoritative {
			bids, asks := t.Bids, t.Asks
			if bids == nil {
				bids = []market.DepthLevel{}
			}
			if asks == nil {
				asks = []market.DepthLevel{}
			}
			if len(bids) > 0 || len(asks) > 0 {
				h.latestLadder[t.Token] = Ladder{Last: t.LastPrice, Bids: bids, Asks: asks}
				h.latestLadderAt[t.Token] = now
			} else {
				// An authoritative empty ladder invalidates the retained snapshot too.
				delete(h.latestLadder, t.Token)
				delete(h.latestLadderAt, t.Token)
			}
		}
		slim = append(slim, s)
	}
	// Headless consumers first (queued in order, run outside the lock), then one frame
	// for every client, not filtered by the client's tokens.
	listeners := append([]*tickListener(nil), h.tickListeners...)
	if len(listeners) > 0 {
		h.events.push(func() {
			for _, l := range listeners {
				if l.removed.Load() {
					continue
				}
				safeCall("tick listener", func() { l.fn(slim) })
			}
		})
	}
	if len(h.clients) > 0 {
		h.sendAllLocked(DataFrame(TicksJSON(slim)))
	}
}

// notifyLocked records a connection change (deduplicated) and queues its delivery.
func (h *Hub) notifyLocked(connected bool) {
	if h.connected == connected {
		return
	}
	h.connected = connected
	listeners := append([]*connListener(nil), h.connListeners...)
	if len(listeners) == 0 {
		return
	}
	h.events.push(func() {
		for _, l := range listeners {
			if l.removed.Load() {
				continue
			}
			safeCall("connection listener", func() { l.fn(connected) })
		}
	})
}

func safeCall(what string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Hub] %s failed: %v", what, r)
		}
	}()
	fn()
}

// ---------------------------------------------------------------------------
// Helpers

// serialQueue runs queued callbacks one at a time, in push order, outside the hub lock.
// Whoever finds the queue idle drains it; a push from inside a callback is run after the
// current one instead of recursing.
type serialQueue struct {
	mu       sync.Mutex
	queue    []func()
	draining bool
}

func (q *serialQueue) push(fn func()) {
	q.mu.Lock()
	q.queue = append(q.queue, fn)
	q.mu.Unlock()
}

func (q *serialQueue) drain() {
	q.mu.Lock()
	if q.draining {
		q.mu.Unlock()
		return
	}
	q.draining = true
	for len(q.queue) > 0 {
		fn := q.queue[0]
		q.queue[0] = nil
		q.queue = q.queue[1:]
		q.mu.Unlock()
		safeCall("callback", fn)
		q.mu.Lock()
	}
	q.draining = false
	q.mu.Unlock()
}

// client is one attached SSE consumer with its writer goroutine.
type client struct {
	c          Client
	tokens     map[int64]struct{}
	frames     chan []byte
	stop       chan struct{}
	done       chan struct{}
	haltOnce   sync.Once
	detachOnce sync.Once
	dropped    bool // set before stop is closed
}

func newClient(c Client, tokens []int64, queue int) *client {
	cl := &client{
		c:      c,
		tokens: make(map[int64]struct{}, len(tokens)),
		frames: make(chan []byte, queue),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
	for _, t := range tokens {
		cl.tokens[t] = struct{}{}
	}
	go cl.loop()
	return cl
}

func (cl *client) halt(dropped bool) {
	cl.haltOnce.Do(func() {
		cl.dropped = dropped
		close(cl.stop)
	})
}

// closeClient closes the underlying Client so a WriteFrame stuck on a dead peer returns.
// Client.Close is idempotent and never blocks.
func (cl *client) closeClient() { cl.c.Close() }

func (cl *client) loop() {
	defer close(cl.done)
	for {
		select {
		case <-cl.stop:
			if cl.dropped {
				cl.c.Close()
			}
			return
		case f := <-cl.frames:
			select {
			case <-cl.stop:
				if cl.dropped {
					cl.c.Close()
				}
				return
			default:
			}
			_ = cl.c.WriteFrame(f)
		}
	}
}

// tokenSet is an insertion-ordered set (JavaScript Set semantics: a re-added token goes
// to the end).
type tokenSet struct {
	seq  map[int64]uint64
	next uint64
}

func newTokenSet() *tokenSet { return &tokenSet{seq: map[int64]uint64{}} }

func (s *tokenSet) has(t int64) bool { _, ok := s.seq[t]; return ok }

func (s *tokenSet) add(t int64) {
	if _, ok := s.seq[t]; !ok {
		s.next++
		s.seq[t] = s.next
	}
}

func (s *tokenSet) remove(t int64) { delete(s.seq, t) }

func (s *tokenSet) len() int { return len(s.seq) }

func (s *tokenSet) list() []int64 {
	out := make([]int64, 0, len(s.seq))
	for t := range s.seq {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return s.seq[out[i]] < s.seq[out[j]] })
	return out
}
