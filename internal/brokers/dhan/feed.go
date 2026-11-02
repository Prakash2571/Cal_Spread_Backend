package dhan

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// DefaultFeedURL is the Dhan v2 market-feed WebSocket root.
const DefaultFeedURL = "wss://api-feed.dhan.co"

// Upstream request codes. 15 (ticker) and 17 (quote) exist but are unused: every
// subscription is FULL, whatever the depth level.
const (
	requestSubscribeFull   = 21
	requestUnsubscribeFull = 22
	requestDisconnect      = 12
	// SubscribeBatch is the per-message instrument cap.
	SubscribeBatch = 100
	// maxFrameBytes bounds one downstream frame (a frame holds at most 10 000 packets
	// of 162 bytes), so a misbehaving peer cannot make the reader allocate without limit.
	maxFrameBytes = 16 << 20
)

// FeedInstrument is how the feed (and the order APIs) identify an instrument.
type FeedInstrument struct {
	Segment    Segment `json:"segment"`
	SecurityID int64   `json:"securityId"`
}

// FeedOptions configure a Feed (DhanFeedOptions plus the Go injection points).
//
// AccessToken, ClientID and Resolve are called with the feed's lock held: they must not
// block or call back into the Feed. OnTicks, OnConnection and OnSessionLost are called
// without the lock, in event order, and may call Feed methods — except that OnTicks must
// not call Stop, Dispose or UnsubscribeTokens synchronously (those wait for an in-flight
// tick delivery to finish).
type FeedOptions struct {
	AccessToken   func() string
	ClientID      func() string
	OnTicks       func(ticks []market.Tick)
	OnConnection  func(connected bool)
	OnSessionLost func(reason string)
	Resolve       func(token int64) (FeedInstrument, bool)
	// DepthLevel is 5, 20 or 200; every value subscribes FULL (code 21), as in Node.
	DepthLevel int

	// URL replaces DefaultFeedURL (tests use an httptest server).
	URL string
	// Dialer is the WebSocket dialer (default: no proxy, 45 s handshake timeout).
	Dialer *websocket.Dialer
	// Now is the clock for tick stamps and feed age.
	Now func() time.Time
	// ReconnectDelay overrides ReconnectDelay(attempt) (tests shorten it).
	ReconnectDelay func(attempt int) time.Duration
	// WriteTimeout bounds one upstream send (default 10 s).
	WriteTimeout time.Duration
}

// FeedState is the accumulated per-instrument state a partial packet is merged into.
type FeedState struct {
	Token      int64
	LastPrice  float64
	ClosePrice float64
	OI         float64
	Volume     float64
	Bids       []market.DepthLevel
	Asks       []market.DepthLevel
	ReceivedAt int64
}

// ToTick is toTick: accumulated state → Tick. Best bid/ask come from the ladders (0
// for a missing side). ExchangeTS is ALWAYS nil: Dhan's LTT is a trade time, not a
// book publication time. depthUpdated says whether THIS packet carried depth.
func ToTick(state FeedState, depthUpdated bool) market.Tick {
	bids, asks := state.Bids, state.Asks
	if bids == nil {
		bids = []market.DepthLevel{}
	}
	if asks == nil {
		asks = []market.DepthLevel{}
	}
	var bid, ask float64
	if len(bids) > 0 {
		bid = bids[0].Price
	}
	if len(asks) > 0 {
		ask = asks[0].Price
	}
	du := depthUpdated
	return market.Tick{
		Token:        state.Token,
		LastPrice:    state.LastPrice,
		ClosePrice:   state.ClosePrice,
		OI:           state.OI,
		Bid:          bid,
		Ask:          ask,
		Bids:         bids,
		Asks:         asks,
		DepthUpdated: &du,
	}
}

// ReconnectDelay is the capped exponential back-off: min(30 s, 500 ms × 2^min(6, n-1)).
func ReconnectDelay(attempt int) time.Duration {
	exp := attempt - 1
	if exp > 6 {
		exp = 6
	}
	if exp < 0 {
		exp = 0 // attempt is always >= 1 in practice
	}
	ms := math.Min(30000, 500*math.Pow(2, float64(exp)))
	return time.Duration(ms) * time.Millisecond
}

// IsAuthClose reports the close codes that mean the token will never work.
func IsAuthClose(code int) bool {
	return code == 1008 || code == 4001 || code == 4401 || code == 4403
}

type instKey struct {
	code int
	sec  int64
}

type feedSocket struct {
	epoch  uint64
	conn   *websocket.Conn
	cancel context.CancelFunc
}

type feedEventKind uint8

const (
	evTicks feedEventKind = iota
	evConnection
	evSessionLost
)

type feedEvent struct {
	kind      feedEventKind
	epoch     uint64
	ticks     []market.Tick
	connected bool
	reason    string
}

// Feed is DhanFeed: one shared WebSocket, partial packets merged into per-instrument
// state, capped exponential reconnect, auth close codes treated as a lost session.
type Feed struct {
	opts FeedOptions

	gate sync.RWMutex // held (read) while ticks are delivered; Stop/Unsubscribe take it

	mu                sync.Mutex
	sock              *feedSocket
	connected         bool
	wanted            map[int64]uint64 // token → insertion sequence
	wantSeq           uint64
	subscribed        map[int64]struct{}
	state             map[int64]*FeedState
	reconnectTimer    *time.Timer
	timerSeq          uint64
	reconnectAttempts int
	disposed          bool
	lastTickAt        int64
	generation        int64
	epoch             uint64
	index             map[instKey]int64
	indexValid        bool

	events   []feedEvent
	draining bool
}

// NewFeed is `new DhanFeed(opts)`.
func NewFeed(opts FeedOptions) *Feed {
	if opts.AccessToken == nil {
		opts.AccessToken = func() string { return "" }
	}
	if opts.ClientID == nil {
		opts.ClientID = func() string { return "" }
	}
	if opts.Resolve == nil {
		opts.Resolve = func(int64) (FeedInstrument, bool) { return FeedInstrument{}, false }
	}
	if opts.URL == "" {
		opts.URL = DefaultFeedURL
	}
	if opts.Dialer == nil {
		opts.Dialer = &websocket.Dialer{HandshakeTimeout: 45 * time.Second}
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ReconnectDelay == nil {
		opts.ReconnectDelay = ReconnectDelay
	}
	if opts.WriteTimeout <= 0 {
		opts.WriteTimeout = 10 * time.Second
	}
	return &Feed{
		opts:       opts,
		wanted:     map[int64]uint64{},
		subscribed: map[int64]struct{}{},
		state:      map[int64]*FeedState{},
	}
}

// IsConnected reports an open socket.
func (f *Feed) IsConnected() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.connected }

// SubscribedCount is the number of tokens that have ticked since the socket opened.
func (f *Feed) SubscribedCount() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.subscribed) }

// WantedCount is the number of tokens the feed has been asked for.
func (f *Feed) WantedCount() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.wanted) }

// LastTickAtMs is the epoch ms of the newest tick, nil when nothing arrived.
func (f *Feed) LastTickAtMs() *int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lastTickAt == 0 {
		return nil
	}
	v := f.lastTickAt
	return &v
}

// FeedAgeMs is the age of the newest tick, nil when nothing arrived.
func (f *Feed) FeedAgeMs() *int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lastTickAt == 0 {
		return nil
	}
	v := f.opts.Now().UnixMilli() - f.lastTickAt
	return &v
}

// FeedGeneration is bumped on every (re)connection; books from an older generation
// belong to a different socket session.
func (f *Feed) FeedGeneration() int64 { f.mu.Lock(); defer f.mu.Unlock(); return f.generation }

// SubscribeTokens adds tokens (idempotent) and sends FULL subscriptions for the fresh
// ones when the socket is open; otherwise they are sent on open.
func (f *Feed) SubscribeTokens(tokens []int64) {
	f.mu.Lock()
	var fresh []int64
	for _, t := range tokens {
		if _, ok := f.wanted[t]; !ok {
			fresh = append(fresh, t)
		}
	}
	for _, t := range fresh {
		if _, ok := f.wanted[t]; !ok {
			f.wantSeq++
			f.wanted[t] = f.wantSeq
		}
	}
	if len(fresh) == 0 {
		f.mu.Unlock()
		return
	}
	f.indexValid = false
	logf("[DhanFeed] subscribe request: fresh=%d wanted=%d subscribed=%d socketConnected=%t",
		len(fresh), len(f.wanted), len(f.subscribed), f.connected)
	f.ensureSocketLocked()
	if f.connected {
		f.sendInstrumentRequestLocked(requestSubscribeFull, fresh)
	} else {
		logf("[DhanFeed] socket not open yet; %d token(s) queued", len(f.wanted))
	}
	f.mu.Unlock()
	f.drain()
}

// UnsubscribeTokens drops tokens and their books, and unsubscribes upstream.
func (f *Feed) UnsubscribeTokens(tokens []int64) {
	f.gate.Lock()
	f.mu.Lock()
	var drop []int64
	for _, t := range tokens {
		if _, ok := f.wanted[t]; ok {
			drop = append(drop, t)
		}
	}
	if len(drop) == 0 {
		f.mu.Unlock()
		f.gate.Unlock()
		return
	}
	for _, t := range drop {
		delete(f.wanted, t)
		delete(f.subscribed, t)
		delete(f.state, t)
	}
	f.indexValid = false
	if f.connected {
		f.sendInstrumentRequestLocked(requestUnsubscribeFull, drop)
	}
	f.mu.Unlock()
	f.gate.Unlock()
	f.drain()
}

// RefreshResolutions drops the cached (segment, securityId) → token lookup so the next
// packet rebuilds it from Resolve. The Node feed asks Resolve again for every packet;
// this one asks once per change of the wanted set, so a resolver whose answers change
// (it should not: tokens encode their segment and id) must call this afterwards.
func (f *Feed) RefreshResolutions() {
	f.mu.Lock()
	f.indexValid = false
	f.mu.Unlock()
}

// EnsureSocket opens the socket if none is open and a token and client id exist.
func (f *Feed) EnsureSocket() {
	f.mu.Lock()
	f.ensureSocketLocked()
	f.mu.Unlock()
	f.drain()
}

func (f *Feed) ensureSocketLocked() {
	if f.disposed || f.sock != nil {
		return
	}
	token := f.opts.AccessToken()
	clientID := f.opts.ClientID()
	if token == "" || clientID == "" {
		return
	}
	u := f.opts.URL + "?version=2&token=" + encodeURIComponent(token) +
		"&clientId=" + encodeURIComponent(clientID) + "&authType=2"
	// The WebSocket constructor accepts http(s) URLs and maps them to ws(s), so a
	// test server's http:// address can be used as is.
	switch {
	case strings.HasPrefix(u, "http://"):
		u = "ws://" + strings.TrimPrefix(u, "http://")
	case strings.HasPrefix(u, "https://"):
		u = "wss://" + strings.TrimPrefix(u, "https://")
	}
	if parsed, err := url.Parse(u); err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") {
		reason := "invalid URL scheme"
		if err != nil {
			reason = err.Error()
		}
		f.scheduleReconnectLocked("socket construction failed: " + reason)
		return
	}
	f.epoch++
	ctx, cancel := context.WithCancel(context.Background())
	s := &feedSocket{epoch: f.epoch, cancel: cancel}
	f.sock = s
	go f.run(ctx, s, u)
}

func (f *Feed) run(ctx context.Context, s *feedSocket, u string) {
	conn, err := abandonableDial(ctx, f.opts.Dialer, u)
	s.cancel()
	if err != nil {
		// A failed connect is an error event followed by close 1006 in the browser API.
		f.handleClose(s, websocket.CloseAbnormalClosure)
		return
	}
	conn.SetReadLimit(maxFrameBytes)
	f.mu.Lock()
	if f.sock != s {
		f.mu.Unlock()
		_ = conn.Close()
		return
	}
	s.conn = conn
	f.connected = true
	f.reconnectAttempts = 0
	f.generation++
	// Retained state belongs to the previous socket generation.
	f.state = map[int64]*FeedState{}
	f.lastTickAt = 0
	f.subscribed = map[int64]struct{}{}
	if len(f.wanted) > 0 {
		f.sendInstrumentRequestLocked(requestSubscribeFull, f.wantedInOrderLocked())
	}
	f.enqueueLocked(feedEvent{kind: evConnection, connected: true})
	f.mu.Unlock()
	f.drain()

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			code := websocket.CloseAbnormalClosure
			if ce, ok := err.(*websocket.CloseError); ok {
				code = ce.Code
			}
			f.handleClose(s, code)
			_ = conn.Close()
			return
		}
		if mt != websocket.BinaryMessage {
			continue // text frames are informational only
		}
		f.mu.Lock()
		if f.sock != s {
			f.mu.Unlock()
			_ = conn.Close()
			return
		}
		f.handleFrameLocked(data, f.opts.Now().UnixMilli())
		f.mu.Unlock()
		f.drain()
	}
}

// abandonableDial is Dialer.DialContext, except that cancelling ctx also aborts a
// handshake already under way. gorilla/websocket watches ctx only while connecting TCP
// and then waits for the server or HandshakeTimeout (45 s by default), so Stop or
// Dispose during a pending connect left the dial (and its connection) running that long;
// Node's close() drops a CONNECTING socket at once (feed_life.json). The watch is
// detached as soon as the dial returns, so it never touches an established connection.
func abandonableDial(ctx context.Context, d *websocket.Dialer, u string) (*websocket.Conn, error) {
	var mu sync.Mutex
	var nc net.Conn
	done := false
	cp := *d
	base := d.NetDialContext
	if base == nil && d.NetDial != nil {
		netDial := d.NetDial
		base = func(_ context.Context, network, addr string) (net.Conn, error) { return netDial(network, addr) }
	}
	if base == nil {
		var nd net.Dialer
		base = nd.DialContext
	}
	cp.NetDialContext = func(dctx context.Context, network, addr string) (net.Conn, error) {
		c, err := base(dctx, network, addr)
		if err == nil {
			mu.Lock()
			if done {
				mu.Unlock()
				_ = c.Close()
				return nil, ctx.Err()
			}
			nc = c
			mu.Unlock()
		}
		return c, err
	}
	stop := context.AfterFunc(ctx, func() {
		mu.Lock()
		defer mu.Unlock()
		done = true
		if nc != nil {
			_ = nc.Close()
		}
	})
	conn, _, err := cp.DialContext(ctx, u, nil)
	if !stop() && err == nil {
		// ctx ended while the dial was finishing: the connection is already closed.
		_ = conn.Close()
		return nil, ctx.Err()
	}
	return conn, err
}

func (f *Feed) handleClose(s *feedSocket, code int) {
	f.mu.Lock()
	if f.sock != s {
		f.mu.Unlock()
		return
	}
	f.sock = nil
	f.connected = false
	f.subscribed = map[int64]struct{}{}
	f.state = map[int64]*FeedState{}
	f.lastTickAt = 0
	f.enqueueLocked(feedEvent{kind: evConnection, connected: false})
	if IsAuthClose(code) {
		f.enqueueLocked(feedEvent{kind: evSessionLost, reason: fmt.Sprintf(
			"Dhan feed rejected the session (close code %d) — the access token is invalid or expired.", code)})
	} else {
		f.scheduleReconnectLocked(fmt.Sprintf("socket closed (code %d)", code))
	}
	f.mu.Unlock()
	f.drain()
}

// handleFrameLocked decodes a frame, merges each attributable packet into its token's
// state and queues the resulting ticks.
func (f *Feed) handleFrameLocked(buf []byte, now int64) {
	res := DecodeFeed(buf)
	for _, m := range res.Errors {
		logf("[Dhan feed] %s", m)
	}
	if len(res.Packets) == 0 {
		return
	}
	var ticks []market.Tick
	for i := range res.Packets {
		p := &res.Packets[i]
		if p.Code == FeedCodeDisconnect {
			var dc int64
			if p.DisconnectCode != nil {
				dc = *p.DisconnectCode
			}
			logf("[Dhan feed] server requested disconnect (code %d).", dc)
			continue
		}
		if p.Code == FeedCodeMarketStatus {
			continue
		}
		token, ok := f.tokenForLocked(p)
		if !ok {
			continue
		}
		f.subscribed[token] = struct{}{}
		merged := f.mergeLocked(token, p, now)
		// Provenance comes from THIS packet, never from the merged state.
		ticks = append(ticks, ToTick(*merged, p.Bids != nil || p.Asks != nil))
	}
	if len(ticks) == 0 {
		return
	}
	if f.lastTickAt == 0 {
		logf("[DhanFeed] firstTick internalToken=%d ltp=%s batch=%d wanted=%d subscribed=%d",
			ticks[0].Token, jsNumberString(ticks[0].LastPrice), len(ticks), len(f.wanted), len(f.subscribed))
	}
	f.lastTickAt = now
	var epoch uint64
	if f.sock != nil {
		epoch = f.sock.epoch
	}
	f.enqueueLocked(feedEvent{kind: evTicks, epoch: epoch, ticks: ticks})
}

// tokenForLocked maps (segment, securityId) back to the FIRST wanted token (in
// insertion order) that resolves to it; unattributable packets are dropped.
func (f *Feed) tokenForLocked(p *Packet) (int64, bool) {
	if p.Segment == "" {
		return 0, false
	}
	code := CodeBySegment[p.Segment]
	if !f.indexValid {
		f.index = map[instKey]int64{}
		for _, t := range f.wantedInOrderLocked() {
			inst, ok := f.opts.Resolve(t)
			if !ok {
				continue
			}
			c, known := CodeBySegment[inst.Segment]
			if !known {
				continue
			}
			k := instKey{c, inst.SecurityID}
			if _, dup := f.index[k]; !dup {
				f.index[k] = t
			}
		}
		f.indexValid = true
	}
	t, ok := f.index[instKey{code, p.SecurityID}]
	return t, ok
}

func (f *Feed) mergeLocked(token int64, p *Packet, now int64) *FeedState {
	next, ok := f.state[token]
	if !ok {
		next = &FeedState{Token: token, Bids: []market.DepthLevel{}, Asks: []market.DepthLevel{}, ReceivedAt: now}
	} else {
		cp := *next // copy-on-write: ticks already handed out keep their values
		next = &cp
	}
	if p.LastPrice != nil {
		next.LastPrice = *p.LastPrice
	}
	if p.Close != nil {
		next.ClosePrice = *p.Close
	}
	if p.PrevClose != nil && next.ClosePrice == 0 {
		next.ClosePrice = *p.PrevClose
	}
	if p.OI != nil {
		next.OI = float64(*p.OI)
	}
	if p.PrevOI != nil && next.OI == 0 {
		next.OI = float64(*p.PrevOI)
	}
	if p.Volume != nil {
		next.Volume = float64(*p.Volume)
	}
	// An empty ladder on a FULL packet is a real observation and overwrites.
	if p.Bids != nil {
		next.Bids = p.Bids
	}
	if p.Asks != nil {
		next.Asks = p.Asks
	}
	next.ReceivedAt = now
	f.state[token] = next
	return next
}

func (f *Feed) wantedInOrderLocked() []int64 {
	out := make([]int64, 0, len(f.wanted))
	for t := range f.wanted {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return f.wanted[out[i]] < f.wanted[out[j]] })
	return out
}

type instrumentRef struct {
	ExchangeSegment Segment `json:"ExchangeSegment"`
	SecurityID      string  `json:"SecurityId"`
}

type instrumentRequest struct {
	RequestCode     int             `json:"RequestCode"`
	InstrumentCount int             `json:"InstrumentCount"`
	InstrumentList  []instrumentRef `json:"InstrumentList"`
}

// sendInstrumentRequestLocked sends a chunked (≤100 per message) instrument request;
// unresolvable tokens are skipped with a warning, and a send failure aborts the rest.
func (f *Feed) sendInstrumentRequestLocked(code int, tokens []int64) {
	s := f.sock
	if s == nil || s.conn == nil || !f.connected {
		return
	}
	list := make([]instrumentRef, 0, len(tokens))
	for _, t := range tokens {
		inst, ok := f.opts.Resolve(t)
		if !ok {
			continue
		}
		list = append(list, instrumentRef{ExchangeSegment: inst.Segment, SecurityID: strconv.FormatInt(inst.SecurityID, 10)})
	}
	if len(list) < len(tokens) {
		logf("[DhanFeed] %d of %d token(s) could not be resolved to a Dhan (segment, securityId) and were NOT sent upstream.",
			len(tokens)-len(list), len(tokens))
	}
	label := "subscribe"
	if code == requestUnsubscribeFull {
		label = "unsubscribe"
	}
	for i := 0; i < len(list); i += SubscribeBatch {
		end := i + SubscribeBatch
		if end > len(list) {
			end = len(list)
		}
		batch := list[i:end]
		logf("[DhanFeed] sending %s batch=%d (%d/%d)", label, len(batch), end, len(list))
		msg, _ := json.Marshal(instrumentRequest{RequestCode: code, InstrumentCount: len(batch), InstrumentList: batch})
		if err := f.writeLocked(s, msg); err != nil {
			logf("[Dhan feed] failed to send request %d: %v", code, err)
			return
		}
	}
}

func (f *Feed) writeLocked(s *feedSocket, msg []byte) error {
	// The deadline is wall-clock on purpose: Now may be a test clock.
	_ = s.conn.SetWriteDeadline(time.Now().Add(f.opts.WriteTimeout))
	return s.conn.WriteMessage(websocket.TextMessage, msg)
}

func (f *Feed) scheduleReconnectLocked(reason string) {
	if f.disposed || f.reconnectTimer != nil {
		return
	}
	f.reconnectAttempts++
	delay := f.opts.ReconnectDelay(f.reconnectAttempts)
	logf("[Dhan feed] %s; reconnecting in %dms.", reason, delay.Milliseconds())
	f.timerSeq++
	seq := f.timerSeq
	f.reconnectTimer = time.AfterFunc(delay, func() {
		f.mu.Lock()
		if f.timerSeq != seq || f.reconnectTimer == nil {
			f.mu.Unlock()
			return
		}
		f.reconnectTimer = nil
		f.ensureSocketLocked()
		f.mu.Unlock()
		f.drain()
	})
}

// Stop stops the feed and DISCARDS every book (broker switch, session loss). A stopped
// feed restarts on the next SubscribeTokens/EnsureSocket unless disposed.
func (f *Feed) Stop() {
	f.gate.Lock()
	f.mu.Lock()
	f.stopLocked()
	f.mu.Unlock()
	f.gate.Unlock()
	f.drain()
}

// Dispose stops the feed for good.
func (f *Feed) Dispose() {
	f.gate.Lock()
	f.mu.Lock()
	f.disposed = true
	f.stopLocked()
	f.mu.Unlock()
	f.gate.Unlock()
	f.drain()
}

func (f *Feed) stopLocked() {
	if f.reconnectTimer != nil {
		f.reconnectTimer.Stop()
		f.reconnectTimer = nil
		f.timerSeq++
	}
	s := f.sock
	f.sock = nil
	f.connected = false
	f.subscribed = map[int64]struct{}{}
	f.wanted = map[int64]uint64{}
	f.state = map[int64]*FeedState{}
	f.indexValid = false
	f.lastTickAt = 0
	if s != nil {
		if s.conn != nil {
			_ = f.writeLocked(s, []byte(`{"RequestCode":12}`))
			_ = s.conn.WriteControl(websocket.CloseMessage, []byte{}, time.Now().Add(time.Second))
			_ = s.conn.Close()
		} else {
			s.cancel()
		}
	}
	f.enqueueLocked(feedEvent{kind: evConnection, connected: false})
}

func (f *Feed) enqueueLocked(ev feedEvent) { f.events = append(f.events, ev) }

// drain delivers queued events in order. Only one goroutine drains at a time; a
// reentrant call (from inside a callback) returns at once and the active drainer
// delivers the new events after the current callback returns.
func (f *Feed) drain() {
	f.mu.Lock()
	if f.draining {
		f.mu.Unlock()
		return
	}
	f.draining = true
	for len(f.events) > 0 {
		ev := f.events[0]
		f.events = f.events[1:]
		f.mu.Unlock()
		f.deliver(ev)
		f.mu.Lock()
	}
	f.draining = false
	f.mu.Unlock()
}

func (f *Feed) deliver(ev feedEvent) {
	switch ev.kind {
	case evTicks:
		f.gate.RLock()
		defer f.gate.RUnlock()
		f.mu.Lock()
		var cur uint64
		if f.sock != nil {
			cur = f.sock.epoch
		}
		var ticks []market.Tick
		if cur == ev.epoch {
			for _, t := range ev.ticks {
				if _, ok := f.wanted[t.Token]; ok {
					ticks = append(ticks, t)
				}
			}
		}
		f.mu.Unlock()
		if len(ticks) > 0 && f.opts.OnTicks != nil {
			safeCall(func() { f.opts.OnTicks(ticks) })
		}
	case evConnection:
		if f.opts.OnConnection != nil {
			safeCall(func() { f.opts.OnConnection(ev.connected) })
		}
	case evSessionLost:
		if f.opts.OnSessionLost != nil {
			safeCall(func() { f.opts.OnSessionLost(ev.reason) })
		}
	}
}

func safeCall(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			logf("[Dhan feed] listener failed: %v", r)
		}
	}()
	fn()
}
