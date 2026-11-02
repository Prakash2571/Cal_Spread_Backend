package kite

import (
	"log"
	"sort"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Lane is a market-data workload (brokers/marketDataLane.ts MarketDataLane).
type Lane string

const (
	// LaneFutures is the calendar-spread board, spot prices and futures analytics.
	LaneFutures Lane = "futures"
	// LaneBox is the dedicated second lane (option strikes); Synthetic uses it in Go.
	LaneBox Lane = "box"
)

// LaneFeedStats is per-lane feed health (marketDataLane.ts LaneFeedStats; same JSON keys).
type LaneFeedStats struct {
	Lane             Lane    `json:"lane"`
	Connected        bool    `json:"connected"`
	SubscribedTokens int     `json:"subscribedTokens"`
	WantedTokens     int     `json:"wantedTokens"`
	TicksPerSecond   float64 `json:"ticksPerSecond"`
	LastTickAgeMs    *int64  `json:"lastTickAgeMs"`
	Reconnects       int     `json:"reconnects"`
	Generation       int64   `json:"generation"`
}

// TickRateCounter is marketDataLane.ts TickRateCounter: one count per one-second bucket
// over a fixed ring. Not safe for concurrent use (the feed guards it).
type TickRateCounter struct {
	seconds  int
	buckets  []float64
	bucketAt []int64
	cursor   int
}

// NewTickRateCounter builds a counter over the given number of seconds (Node default 10).
func NewTickRateCounter(seconds int) *TickRateCounter {
	return &TickRateCounter{seconds: seconds, buckets: make([]float64, seconds), bucketAt: make([]int64, seconds)}
}

func floorSecond(ms int64) int64 {
	s := ms / 1000
	if ms%1000 < 0 {
		s--
	}
	return s
}

// Mark adds count ticks at nowMs.
func (r *TickRateCounter) Mark(count int, nowMs int64) {
	second := floorSecond(nowMs)
	if r.bucketAt[r.cursor] == second {
		r.buckets[r.cursor] += float64(count)
		return
	}
	r.cursor = (r.cursor + 1) % r.seconds
	r.bucketAt[r.cursor] = second
	r.buckets[r.cursor] = float64(count)
}

// PerSecond is the mean of the complete buckets inside the window, to one decimal.
func (r *TickRateCounter) PerSecond(nowMs int64) float64 {
	newest := floorSecond(nowMs)
	total, counted := 0.0, 0
	for i := 0; i < r.seconds; i++ {
		at := r.bucketAt[i]
		if at == 0 || at >= newest || newest-at > int64(r.seconds) {
			continue
		}
		total += r.buckets[i]
		counted++
	}
	if counted == 0 {
		return 0
	}
	return jsx.Round(total/float64(counted)*10) / 10
}

// Reset clears every bucket.
func (r *TickRateCounter) Reset() {
	for i := range r.buckets {
		r.buckets[i] = 0
		r.bucketAt[i] = 0
	}
	r.cursor = 0
}

// Reconnect backoff bounds (zerodha/feed.ts RECONNECT_BASE_MS / RECONNECT_MAX_MS).
const (
	ReconnectBase = 500 * time.Millisecond
	ReconnectMax  = 15 * time.Second
)

// Credentials are the Kite credentials a feed reads fresh on every connect;
// AccessToken "" means no session.
type Credentials struct {
	APIKey      string
	AccessToken string
}

// ZerodhaFeedOptions configures a ZerodhaFeed (zerodha/feed.ts ZerodhaFeedOptions plus
// injectable connector, URL, clock and backoff).
type ZerodhaFeedOptions struct {
	Lane               Lane
	Credentials        func() Credentials
	OnTicks            func(ticks []market.Tick)
	OnConnectionChange func(connected bool)
	// OnDead: Kite rejected the feed; not reconnectable.
	OnDead func(message string)
	// Generation is the broker generation; ticks from a socket opened under another
	// generation are dropped.
	Generation func() int64
	Now        func() time.Time
	// Connect defaults to ticker.Connect; it must not invoke callbacks synchronously.
	Connect   ticker.ConnectFunc
	TickerURL string
	// ReconnectBase / ReconnectMax override the backoff (tests).
	ReconnectBase time.Duration
	ReconnectMax  time.Duration
	// AfterFunc schedules the reconnect (default time.AfterFunc); it returns a function
	// that cancels the call. It is called with the feed's lock held, so it must not run
	// fn synchronously. Tests use it to fire reconnects by hand.
	AfterFunc func(d time.Duration, fn func()) (cancel func())
}

// ZerodhaFeed is ONE lane-scoped Kite socket (src/brokers/zerodha/feed.ts): its wanted
// and confirmed token sets, its reconnect policy (capped exponential backoff after a
// close; an error is terminal) and its health. A stopped feed is never reused.
//
// Safe for concurrent use: state is guarded by a mutex and every socket callback is
// matched to the current socket; the option callbacks run outside the lock, one at a
// time, in the order the state changed.
type ZerodhaFeed struct {
	opts ZerodhaFeedOptions

	mu                sync.Mutex
	sock              *feedSocket
	sockSeq           uint64
	wanted            *tokenSet
	subscribed        *tokenSet
	connected         bool
	disposed          bool
	reconnectAttempts int
	reconnects        int
	reconnectCancel   func() // nil when no reconnect is pending
	timerSeq          uint64
	lastTickAt        *int64
	rate              *TickRateCounter
	socketGeneration  int64

	events serialQueue
}

type feedSocket struct {
	id uint64
	h  ticker.Handle
}

// NewZerodhaFeed builds an idle feed (no socket until tokens are set).
func NewZerodhaFeed(opts ZerodhaFeedOptions) *ZerodhaFeed {
	if opts.Connect == nil {
		opts.Connect = ticker.Connect
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ReconnectBase <= 0 {
		opts.ReconnectBase = ReconnectBase
	}
	if opts.ReconnectMax <= 0 {
		opts.ReconnectMax = ReconnectMax
	}
	if opts.Generation == nil {
		opts.Generation = func() int64 { return 0 }
	}
	if opts.Credentials == nil {
		opts.Credentials = func() Credentials { return Credentials{} }
	}
	if opts.AfterFunc == nil {
		opts.AfterFunc = func(d time.Duration, fn func()) func() {
			t := time.AfterFunc(d, fn)
			return func() { t.Stop() }
		}
	}
	return &ZerodhaFeed{
		opts:             opts,
		wanted:           newTokenSet(),
		subscribed:       newTokenSet(),
		rate:             NewTickRateCounter(10),
		socketGeneration: opts.Generation(),
	}
}

// Lane is the feed's lane.
func (f *ZerodhaFeed) Lane() Lane { return f.opts.Lane }

func (f *ZerodhaFeed) nowMs() int64 { return f.opts.Now().UnixMilli() }

// EnsureSocket opens the socket if credentials allow it. Idempotent.
func (f *ZerodhaFeed) EnsureSocket() {
	f.mu.Lock()
	idle := !f.disposed && f.sock == nil
	f.mu.Unlock()
	if !idle {
		return
	}
	creds := f.opts.Credentials()
	if creds.AccessToken == "" {
		return
	}
	gen := f.opts.Generation()

	f.mu.Lock()
	defer f.mu.Unlock()
	if f.disposed || f.sock != nil {
		return
	}
	f.socketGeneration = gen
	f.sockSeq++
	id := f.sockSeq
	s := &feedSocket{id: id}
	s.h = f.opts.Connect(ticker.Options{
		URL:         f.opts.TickerURL,
		APIKey:      creds.APIKey,
		AccessToken: creds.AccessToken,
		Tokens:      f.wanted.list(),
		OnTick:      func(ticks []market.Tick) { f.onTick(id, ticks) },
		OnOpen:      func() { f.onOpen(id) },
		OnError:     func(msg string) { f.onError(id, msg) },
		OnClose:     func() { f.onClose(id) },
	})
	f.sock = s
}

func (f *ZerodhaFeed) currentLocked(id uint64) bool {
	return f.sock != nil && f.sock.id == id && !f.disposed
}

func (f *ZerodhaFeed) onTick(id uint64, ticks []market.Tick) {
	gen := f.opts.Generation()
	f.mu.Lock()
	if !f.currentLocked(id) || f.socketGeneration != gen {
		// Generation guard: a socket opened under an older broker generation must not
		// publish into the new one (the token namespaces differ).
		f.mu.Unlock()
		return
	}
	now := f.nowMs()
	f.lastTickAt = &now
	f.rate.Mark(len(ticks), now)
	if f.opts.OnTicks != nil {
		fn := f.opts.OnTicks
		f.events.push(func() { fn(ticks) })
	}
	f.mu.Unlock()
	f.events.drain()
}

func (f *ZerodhaFeed) onOpen(id uint64) {
	f.mu.Lock()
	if !f.currentLocked(id) {
		f.mu.Unlock()
		return
	}
	f.reconnectAttempts = 0
	// connectTicker already sent the wanted list it was opened with (plus anything queued
	// since); record what is now live.
	f.subscribed = f.wanted.clone()
	f.setConnectedLocked(true)
	f.mu.Unlock()
	f.events.drain()
}

func (f *ZerodhaFeed) onError(id uint64, message string) {
	f.mu.Lock()
	if !f.currentLocked(id) {
		f.mu.Unlock()
		return
	}
	// A credential failure is terminal: retrying would just spin.
	if f.opts.OnDead != nil {
		fn := f.opts.OnDead
		f.events.push(func() { fn(message) })
	}
	f.teardownLocked()
	f.mu.Unlock()
	f.events.drain()
}

func (f *ZerodhaFeed) onClose(id uint64) {
	f.mu.Lock()
	if !f.currentLocked(id) {
		f.mu.Unlock()
		return
	}
	f.sock = nil
	f.subscribed = newTokenSet()
	f.setConnectedLocked(false)
	f.scheduleReconnectLocked()
	f.mu.Unlock()
	f.events.drain()
}

// SetTokens declares the lane's ENTIRE token set (positive tokens only) and diffs it
// against what is live: drops are unsubscribed before adds are subscribed.
func (f *ZerodhaFeed) SetTokens(tokens []int64) {
	f.mu.Lock()
	want := newTokenSet()
	for _, t := range tokens {
		if t > 0 {
			want.add(t)
		}
	}
	var toAdd, toDrop []int64
	for _, t := range want.list() {
		if !f.wanted.has(t) {
			toAdd = append(toAdd, t)
		}
	}
	for _, t := range f.wanted.list() {
		if !want.has(t) {
			toDrop = append(toDrop, t)
		}
	}
	f.wanted = want
	if f.sock == nil {
		ensure := want.len() > 0
		f.mu.Unlock()
		if ensure {
			f.EnsureSocket()
		}
		return
	}
	if len(toDrop) > 0 {
		f.sock.h.Unsubscribe(toDrop)
		for _, t := range toDrop {
			f.subscribed.remove(t)
		}
	}
	if len(toAdd) > 0 {
		f.sock.h.Subscribe(toAdd)
		for _, t := range toAdd {
			f.subscribed.add(t)
		}
	}
	f.mu.Unlock()
}

// SubscribeTokens adds tokens to the lane (positive ones not already wanted).
func (f *ZerodhaFeed) SubscribeTokens(tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	f.mu.Lock()
	var fresh []int64
	for _, t := range tokens {
		if t > 0 && !f.wanted.has(t) {
			fresh = append(fresh, t)
		}
	}
	for _, t := range fresh {
		f.wanted.add(t)
	}
	if f.sock == nil {
		f.mu.Unlock()
		f.EnsureSocket()
		return
	}
	if len(fresh) > 0 {
		f.sock.h.Subscribe(fresh)
		for _, t := range fresh {
			f.subscribed.add(t)
		}
	}
	f.mu.Unlock()
}

// UnsubscribeTokens removes tokens this lane wants.
func (f *ZerodhaFeed) UnsubscribeTokens(tokens []int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var drop []int64
	for _, t := range tokens {
		if f.wanted.has(t) {
			drop = append(drop, t)
		}
	}
	if len(drop) == 0 {
		return
	}
	for _, t := range drop {
		f.wanted.remove(t)
		f.subscribed.remove(t)
	}
	if f.sock != nil {
		f.sock.h.Unsubscribe(drop)
	}
}

// IsConnected reports whether the socket is open.
func (f *ZerodhaFeed) IsConnected() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.connected
}

// WantedCount is how many tokens the lane has been asked for.
func (f *ZerodhaFeed) WantedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.wanted.len()
}

// SubscribedCount is how many tokens the lane believes are live.
func (f *ZerodhaFeed) SubscribedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.subscribed.len()
}

// Stats is the lane's health.
func (f *ZerodhaFeed) Stats() LaneFeedStats {
	now := f.nowMs()
	f.mu.Lock()
	defer f.mu.Unlock()
	var age *int64
	if f.lastTickAt != nil {
		a := now - *f.lastTickAt
		if a < 0 {
			a = 0
		}
		age = &a
	}
	return LaneFeedStats{
		Lane:             f.opts.Lane,
		Connected:        f.connected,
		SubscribedTokens: f.subscribed.len(),
		WantedTokens:     f.wanted.len(),
		TicksPerSecond:   f.rate.PerSecond(now),
		LastTickAgeMs:    age,
		Reconnects:       f.reconnects,
		Generation:       f.socketGeneration,
	}
}

// Stop tears the lane down and forgets its subscriptions (broker switch, shutdown).
func (f *ZerodhaFeed) Stop() {
	f.mu.Lock()
	f.disposed = true
	f.teardownLocked()
	f.wanted = newTokenSet()
	f.rate.Reset()
	f.lastTickAt = nil
	f.mu.Unlock()
	f.events.drain()
}

func (f *ZerodhaFeed) teardownLocked() {
	if f.reconnectCancel != nil {
		f.reconnectCancel()
		f.reconnectCancel = nil
		f.timerSeq++
	}
	s := f.sock
	f.sock = nil
	f.subscribed = newTokenSet()
	if s != nil {
		s.h.Close()
	}
	f.setConnectedLocked(false)
}

func (f *ZerodhaFeed) setConnectedLocked(connected bool) {
	if f.connected == connected {
		return
	}
	f.connected = connected
	if f.opts.OnConnectionChange != nil {
		fn := f.opts.OnConnectionChange
		f.events.push(func() { fn(connected) })
	}
}

func (f *ZerodhaFeed) scheduleReconnectLocked() {
	if f.disposed || f.reconnectCancel != nil {
		return
	}
	if f.wanted.len() == 0 {
		return // nothing to stream: do not hold a socket open
	}
	// min(max, base * 2^attempts), doubling with a cap so it cannot overflow.
	delay := f.opts.ReconnectBase
	for i := 0; i < f.reconnectAttempts && delay < f.opts.ReconnectMax; i++ {
		delay *= 2
	}
	if delay > f.opts.ReconnectMax {
		delay = f.opts.ReconnectMax
	}
	f.reconnectAttempts++
	f.reconnects++
	f.timerSeq++
	seq := f.timerSeq
	f.reconnectCancel = f.opts.AfterFunc(delay, func() {
		f.mu.Lock()
		if f.timerSeq != seq {
			f.mu.Unlock()
			return
		}
		f.reconnectCancel = nil
		disposed := f.disposed
		f.mu.Unlock()
		if !disposed {
			f.EnsureSocket()
		}
	})
}

// ---------------------------------------------------------------------------

// tokenSet is an insertion-ordered set with JavaScript Set semantics.
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

func (s *tokenSet) clone() *tokenSet {
	c := &tokenSet{seq: make(map[int64]uint64, len(s.seq)), next: s.next}
	for k, v := range s.seq {
		c.seq[k] = v
	}
	return c
}

// serialQueue runs callbacks one at a time in push order, outside the feed lock.
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
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[ZerodhaFeed] callback failed: %v", r)
				}
			}()
			fn()
		}()
		q.mu.Lock()
	}
	q.draining = false
	q.mu.Unlock()
}
