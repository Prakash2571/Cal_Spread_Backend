// Package quotes is the executable order-book store (src/box/quotes.ts, kept because
// Synthetic prices its paper trades from it) plus the strike-window helpers Synthetic
// uses (src/box/math.ts atmStrikeFor, strikeStepOf, selectStrikeWindow,
// shouldRecentreWindow).
//
// The store keeps the newest book per token, stamped with its RECEIVE time, and is fed
// only by the WebSocket path. It is safe for concurrent use.
package quotes

import (
	"log"
	"math"
	"sort"
	"sync"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Quote is one executable book.
type Quote struct {
	Token  int64               `json:"token"`
	Bid    float64             `json:"bid"`
	BidQty float64             `json:"bid_qty"`
	Ask    float64             `json:"ask"`
	AskQty float64             `json:"ask_qty"`
	Last   float64             `json:"last"`
	Bids   []market.DepthLevel `json:"bids"`
	Asks   []market.DepthLevel `json:"asks"`
	// Version is a monotonic local sequence assigned when the packet arrived.
	Version int64 `json:"version"`
	// At is the receive time in epoch ms; freshness is measured against it.
	At int64 `json:"at"`
	// ExchangeAt is the exchange timestamp in epoch ms, nil when the feed sent none.
	ExchangeAt *int64 `json:"exchange_at"`
	Source     string `json:"source"` // always "ws"
}

// Diagnostics are fixed-cardinality counters.
type Diagnostics struct {
	AuthoritativeObservations int `json:"authoritative_observations"`
	UsableBookUpdates         int `json:"usable_book_updates"`
	DepthlessIgnored          int `json:"depthless_ignored"`
	EmptyInvalidations        int `json:"empty_invalidations"`
	MalformedLevelsDropped    int `json:"malformed_levels_dropped"`
	GenerationInvalidations   int `json:"generation_invalidations"`
	ReadyBooks                int `json:"ready_books"`
}

// Listener is notified after every batch that changed at least one token.
type Listener func(changed []int64, at int64)

// Store is the quote store.
type Store struct {
	mu          sync.RWMutex
	quotes      map[int64]*Quote
	updates     int
	lastUpdate  *int64
	nextVersion int64
	listeners   []*listenerEntry // subscription order, which notification follows
	diag        Diagnostics
}

type listenerEntry struct{ fn Listener }

// NewStore returns an empty store.
func NewStore() *Store { return &Store{quotes: map[int64]*Quote{}, nextVersion: 1} }

// Size is the number of tokens with a book.
func (s *Store) Size() int { s.mu.RLock(); defer s.mu.RUnlock(); return len(s.quotes) }

// UpdateCount is the number of authoritative tick applications since start.
func (s *Store) UpdateCount() int { s.mu.RLock(); defer s.mu.RUnlock(); return s.updates }

// LastUpdateAt is when any book last updated (epoch ms), nil if never.
func (s *Store) LastUpdateAt() *int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.lastUpdate == nil {
		return nil
	}
	v := *s.lastUpdate
	return &v
}

// Get returns the book for token. Books are never mutated after they are stored.
func (s *Store) Get(token int64) (*Quote, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q, ok := s.quotes[token]
	return q, ok
}

// View returns a snapshot copy of the token → book map.
func (s *Store) View() map[int64]*Quote {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[int64]*Quote, len(s.quotes))
	for k, v := range s.quotes {
		out[k] = v
	}
	return out
}

// Subscribe registers a listener and returns its unsubscribe function.
func (s *Store) Subscribe(fn Listener) func() {
	e := &listenerEntry{fn: fn}
	s.mu.Lock()
	s.listeners = append(s.listeners, e)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, l := range s.listeners {
			if l == e {
				s.listeners = append(s.listeners[:i:i], s.listeners[i+1:]...)
				return
			}
		}
	}
}

// ListenerCount is how many listeners are subscribed.
func (s *Store) ListenerCount() int { s.mu.RLock(); defer s.mu.RUnlock(); return len(s.listeners) }

// Diagnostics returns the counters.
func (s *Store) Diagnostics() Diagnostics {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d := s.diag
	d.ReadyBooks = len(s.quotes)
	return d
}

// IsFresh reports whether token has a book no older than maxAgeMs at nowMs.
func (s *Store) IsFresh(token int64, maxAgeMs, nowMs int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q, ok := s.quotes[token]
	return ok && nowMs-q.At <= maxAgeMs
}

// ApplyTicks applies a batch of live ticks received at atMs and returns the tokens
// whose book changed (including authoritative empty books, which delete the old book).
//
// A tick is authoritative when DepthUpdated is true, or when DepthUpdated is nil and
// the producer supplied a ladder (Bids or Asks non-nil; an empty non-nil slice counts as
// supplied). Others are ignored.
func (s *Store) ApplyTicks(ticks []market.Tick, atMs int64) []int64 {
	s.mu.Lock()
	var changed []int64
	for i := range ticks {
		t := &ticks[i]
		supplied := t.Bids != nil || t.Asks != nil
		authoritative := (t.DepthUpdated != nil && *t.DepthUpdated) || (t.DepthUpdated == nil && supplied)
		if !authoritative {
			s.diag.DepthlessIgnored++
			continue
		}
		s.diag.AuthoritativeObservations++
		bids := s.sanitize(t.Bids, true)
		asks := s.sanitize(t.Asks, false)
		s.updates++
		at := atMs
		s.lastUpdate = &at
		changed = append(changed, t.Token)

		if len(bids) == 0 && len(asks) == 0 {
			delete(s.quotes, t.Token)
			s.diag.EmptyInvalidations++
			s.nextVersion++ // an invalidation consumes a version
			continue
		}
		var bid, ask, bidQty, askQty float64
		if len(bids) > 0 {
			bid = bids[0].Price
		}
		if len(asks) > 0 {
			ask = asks[0].Price
		}
		for _, l := range bids {
			if l.Price == bid {
				bidQty += l.Qty
			}
		}
		for _, l := range asks {
			if l.Price == ask {
				askQty += l.Qty
			}
		}
		last := t.LastPrice
		if math.IsNaN(last) || math.IsInf(last, 0) {
			last = 0
		}
		var exch *int64
		if t.ExchangeTS != nil && *t.ExchangeTS > 0 {
			v := *t.ExchangeTS
			exch = &v
		}
		s.quotes[t.Token] = &Quote{
			Token: t.Token, Bid: bid, BidQty: bidQty, Ask: ask, AskQty: askQty, Last: last,
			Bids: bids, Asks: asks, Version: s.nextVersion, At: atMs, ExchangeAt: exch, Source: "ws",
		}
		s.nextVersion++
		s.diag.UsableBookUpdates++
	}
	listeners := append([]*listenerEntry(nil), s.listeners...)
	s.mu.Unlock()

	if len(changed) > 0 {
		for _, l := range listeners {
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[Quotes] quote listener failed: %v", r)
					}
				}()
				l.fn(changed, atMs)
			}()
		}
	}
	return changed
}

// sanitize drops malformed levels (non-positive or non-finite price, quantity that is not
// a positive safe integer), floors the order count (0 when invalid), sorts best first and
// keeps at most five levels.
func (s *Store) sanitize(levels []market.DepthLevel, isBid bool) []market.DepthLevel {
	valid := make([]market.DepthLevel, 0, len(levels))
	for _, l := range levels {
		if !finite(l.Price) || l.Price <= 0 || !finite(l.Qty) || !safeInteger(l.Qty) || l.Qty <= 0 {
			s.diag.MalformedLevelsDropped++
			continue
		}
		orders := 0.0
		if finite(l.Orders) && l.Orders >= 0 {
			orders = math.Floor(l.Orders)
		}
		valid = append(valid, market.DepthLevel{Price: l.Price, Qty: l.Qty, Orders: orders})
	}
	sort.SliceStable(valid, func(i, j int) bool {
		if isBid {
			return valid[i].Price > valid[j].Price
		}
		return valid[i].Price < valid[j].Price
	})
	if len(valid) > 5 {
		valid = valid[:5]
	}
	return valid
}

func finite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

func safeInteger(x float64) bool { return x == math.Trunc(x) && math.Abs(x) <= 9007199254740991 }

// Forget drops books for tokens that are no longer monitored.
func (s *Store) Forget(tokens []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range tokens {
		delete(s.quotes, t)
	}
}

// Clear drops every book and the last-update time.
func (s *Store) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.quotes = map[int64]*Quote{}
	s.lastUpdate = nil
}

// InvalidateGeneration drops every book at a socket-generation boundary.
func (s *Store) InvalidateGeneration() {
	s.mu.Lock()
	s.diag.GenerationInvalidations++
	s.mu.Unlock()
	s.Clear()
}

// Spot is an underlying's last value and when it was seen (epoch ms).
type Spot struct {
	Value float64
	At    int64
}

// SpotStore holds the last value of each underlying, used to place the ATM window.
type SpotStore struct {
	mu    sync.RWMutex
	spots map[int64]Spot
}

// NewSpotStore returns an empty store.
func NewSpotStore() *SpotStore { return &SpotStore{spots: map[int64]Spot{}} }

// Set records a value; non-positive values are ignored.
func (s *SpotStore) Set(token int64, value float64, atMs int64) {
	if !(value > 0) {
		return
	}
	s.mu.Lock()
	s.spots[token] = Spot{Value: value, At: atMs}
	s.mu.Unlock()
}

// Get returns the stored spot.
func (s *SpotStore) Get(token int64) (Spot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.spots[token]
	return v, ok
}

// IsFresh reports whether the spot is no older than maxAgeMs.
func (s *SpotStore) IsFresh(token int64, maxAgeMs, nowMs int64) bool {
	v, ok := s.Get(token)
	return ok && nowMs-v.At <= maxAgeMs
}

// Clear forgets every spot.
func (s *SpotStore) Clear() { s.mu.Lock(); s.spots = map[int64]Spot{}; s.mu.Unlock() }
