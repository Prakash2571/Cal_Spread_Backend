package brokers

import (
	"fmt"
	"log"
	"sort"
	"sync"
)

// Owner says who wants a token. A token is subscribed upstream while at least one owner
// holds it, so one owner letting go never drops a token another still needs.
type Owner string

const (
	OwnerBrowser   Owner = "browser"
	OwnerScanner   Owner = "scanner"
	OwnerStrategy  Owner = "strategy"
	OwnerAnalytics Owner = "analytics"
)

var owners = []Owner{OwnerBrowser, OwnerScanner, OwnerStrategy, OwnerAnalytics}

// Lane is one of the two market-data sockets of the active broker. The second lane keeps
// its historic name "box" because that name appears in feed-status API responses; today
// it carries the Synthetic scanner's option strikes.
type Lane string

const (
	LaneFutures Lane = "futures"
	LaneBox     Lane = "box"
)

// Lanes are fixed at two, so no code path can open an unbounded number of sockets.
var Lanes = []Lane{LaneFutures, LaneBox}

// LaneLabel is the human-readable lane name.
func LaneLabel(l Lane) string {
	if l == LaneFutures {
		return "futures/calendar-spread"
	}
	return "box-arbitrage options"
}

// Counts is the per-owner reference count of one token.
type Counts struct {
	Browser   int `json:"browser"`
	Scanner   int `json:"scanner"`
	Strategy  int `json:"strategy"`
	Analytics int `json:"analytics"`
	Total     int `json:"total"`
}

func (c *Counts) ptr(o Owner) *int {
	switch o {
	case OwnerBrowser:
		return &c.Browser
	case OwnerScanner:
		return &c.Scanner
	case OwnerStrategy:
		return &c.Strategy
	default:
		return &c.Analytics
	}
}

// Transport receives only the TRANSITIONS: first holder subscribes, last holder drops.
type Transport interface {
	SubscribeTokens(tokens []int64)
	UnsubscribeTokens(tokens []int64)
}

type lease struct {
	id     string
	owner  Owner
	tokens []int64 // distinct, in request order
}

// Coordinator is the refcounted subscription table of one lane (subscriptions.ts).
//
// One mutex covers each whole operation, transport calls included, which is what the
// single-threaded Node code relied on. The transport and the analytics-yield handler must
// not call back into the same Coordinator from inside Subscribe/Unsubscribe; the yield
// handler IS allowed to (it runs with the lock released).
type Coordinator struct {
	Lane Lane

	mu             sync.Mutex
	transport      Transport
	counts         map[int64]*Counts
	leases         map[string]*lease
	leaseOrder     []string
	leaseSeq       int
	analyticsYield func(priority map[int64]struct{})
}

// NewCoordinator returns an empty coordinator for lane.
func NewCoordinator(t Transport, lane Lane) *Coordinator {
	return &Coordinator{Lane: lane, transport: t, counts: map[int64]*Counts{}, leases: map[string]*lease{}}
}

// Lease is a held acquisition. Release is idempotent.
type Lease struct {
	ID string
	c  *Coordinator
}

// Release drops the lease; a second call does nothing.
func (l *Lease) Release() { l.c.releaseLease(l.ID) }

func distinctValid(tokens []int64) []int64 {
	seen := make(map[int64]struct{}, len(tokens))
	out := make([]int64, 0, len(tokens))
	for _, t := range tokens {
		if t <= 0 {
			continue
		}
		if _, dup := seen[t]; !dup {
			seen[t] = struct{}{}
			out = append(out, t)
		}
	}
	return out
}

// Acquire registers a lease of tokens for owner and subscribes upstream only the tokens
// nobody held before. Duplicate and non-positive tokens are ignored.
func (c *Coordinator) Acquire(owner Owner, tokens []int64) *Lease {
	unique := distinctValid(tokens)
	c.yieldAnalytics(owner, unique, false)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.leaseSeq++
	id := fmt.Sprintf("%s:%d", owner, c.leaseSeq)
	c.addLease(&lease{id: id, owner: owner, tokens: unique})
	var sub []int64
	for _, t := range unique {
		e := c.counts[t]
		if e == nil {
			e = &Counts{}
			c.counts[t] = e
		}
		wasZero := e.Total == 0
		*e.ptr(owner)++
		e.Total++
		if wasZero {
			sub = append(sub, t)
		}
	}
	log.Printf("[Subscriptions] lane=%s owner=%s acquire=%d upstreamAdd=%d totalTokens=%d leases=%d",
		c.Lane, owner, len(unique), len(sub), len(c.counts), len(c.leases))
	if len(sub) > 0 {
		c.transport.SubscribeTokens(sub)
	}
	return &Lease{ID: id, c: c}
}

func (c *Coordinator) addLease(l *lease) {
	if _, exists := c.leases[l.id]; !exists {
		c.leaseOrder = append(c.leaseOrder, l.id)
	}
	c.leases[l.id] = l
}

func (c *Coordinator) removeLease(id string) {
	delete(c.leases, id)
	for i, v := range c.leaseOrder {
		if v == id {
			c.leaseOrder = append(c.leaseOrder[:i:i], c.leaseOrder[i+1:]...)
			break
		}
	}
}

// dec lowers one owner's count of token and reports whether nobody holds it any more.
func (c *Coordinator) dec(token int64, owner Owner) (gone bool) {
	e := c.counts[token]
	if e == nil {
		return false
	}
	if p := e.ptr(owner); *p > 0 {
		*p--
	}
	if e.Total > 0 {
		e.Total--
	}
	if e.Total == 0 {
		delete(c.counts, token)
		return true
	}
	return false
}

func (c *Coordinator) releaseLease(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	l := c.leases[id]
	if l == nil {
		return
	}
	c.removeLease(id)
	var unsub []int64
	for _, t := range l.tokens {
		if c.dec(t, l.owner) {
			unsub = append(unsub, t)
		}
	}
	log.Printf("[Subscriptions] lane=%s owner=%s release=%d upstreamDrop=%d totalTokens=%d leases=%d",
		c.Lane, l.owner, len(l.tokens), len(unsub), len(c.counts), len(c.leases))
	if len(unsub) > 0 {
		c.transport.UnsubscribeTokens(unsub)
	}
}

// SetOwnerTokens declares the whole set an owner wants: held tokens it no longer wants
// are released, new ones acquired, and a token it keeps is untouched, so a moving window
// never re-subscribes shared tokens. Any earlier leases of that owner are replaced.
func (c *Coordinator) SetOwnerTokens(owner Owner, tokens []int64) {
	want := distinctValid(tokens)
	c.yieldAnalytics(owner, want, true)

	c.mu.Lock()
	defer c.mu.Unlock()
	wantSet := make(map[int64]struct{}, len(want))
	for _, t := range want {
		wantSet[t] = struct{}{}
	}
	var held []int64
	heldSet := map[int64]struct{}{}
	for _, id := range append([]string(nil), c.leaseOrder...) {
		l := c.leases[id]
		if l == nil || l.owner != owner {
			continue
		}
		for _, t := range l.tokens {
			if _, ok := heldSet[t]; !ok {
				heldSet[t] = struct{}{}
				held = append(held, t)
			}
		}
		c.removeLease(id)
	}
	var sub, unsub []int64
	for _, t := range held {
		if _, keep := wantSet[t]; keep {
			continue
		}
		if c.counts[t] == nil {
			continue
		}
		if c.dec(t, owner) {
			unsub = append(unsub, t)
		}
	}
	for _, t := range want {
		if _, already := heldSet[t]; already {
			continue
		}
		e := c.counts[t]
		if e == nil {
			e = &Counts{}
			c.counts[t] = e
		}
		wasZero := e.Total == 0
		*e.ptr(owner)++
		e.Total++
		if wasZero {
			sub = append(sub, t)
		}
	}
	if len(want) > 0 {
		c.addLease(&lease{id: string(owner) + ":set", owner: owner, tokens: want})
	}
	if len(unsub) > 0 {
		c.transport.UnsubscribeTokens(unsub)
	}
	if len(sub) > 0 {
		c.transport.SubscribeTokens(sub)
	}
}

// ResetForBrokerSwitch forgets every token and lease WITHOUT telling the transport: the
// old tokens belong to the outgoing broker's namespace and must never be unsubscribed
// from the new one.
func (c *Coordinator) ResetForBrokerSwitch() (droppedTokens, droppedLeases int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	droppedTokens, droppedLeases = len(c.counts), len(c.leases)
	c.counts = map[int64]*Counts{}
	c.leases = map[string]*lease{}
	c.leaseOrder = nil
	return
}

// Owns reports whether owner currently holds token.
func (c *Coordinator) Owns(owner Owner, token int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.counts[token]
	return e != nil && *e.ptr(owner) > 0
}

// ActiveTokens lists every subscribed token, ascending.
func (c *Coordinator) ActiveTokens() []int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]int64, 0, len(c.counts))
	for t := range c.counts {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// Size is the number of subscribed tokens.
func (c *Coordinator) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.counts)
}

// CountsFor returns a copy of a token's counts, nil if it is not subscribed.
func (c *Coordinator) CountsFor(token int64) *Counts {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e := c.counts[token]; e != nil {
		cp := *e
		return &cp
	}
	return nil
}

// SetAnalyticsYield installs the handler the analytics owner (Fair Value) uses to give
// tokens back when a higher-priority owner is about to acquire; the argument is the set of
// tokens that must stay.
func (c *Coordinator) SetAnalyticsYield(h func(priority map[int64]struct{})) {
	c.mu.Lock()
	c.analyticsYield = h
	c.mu.Unlock()
}

// yieldAnalytics runs before a non-analytics owner changes its holdings. It runs with the
// lock released because the handler normally calls SetOwnerTokens(analytics) back.
func (c *Coordinator) yieldAnalytics(owner Owner, tokens []int64, replacing bool) {
	c.mu.Lock()
	h := c.analyticsYield
	if owner == OwnerAnalytics || h == nil {
		c.mu.Unlock()
		return
	}
	priority := make(map[int64]struct{}, len(tokens))
	for _, t := range tokens {
		priority[t] = struct{}{}
	}
	for t, e := range c.counts {
		other := e.Total - e.Analytics
		if replacing {
			other -= *e.ptr(owner)
		}
		if other > 0 {
			priority[t] = struct{}{}
		}
	}
	c.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Subscriptions] analytics yield failed: %v", r)
		}
	}()
	h(priority)
}

// Stats is the per-lane summary reported by the status endpoints; key order is the contract.
type Stats struct {
	Browser   int  `json:"browser"`
	Scanner   int  `json:"scanner"`
	Strategy  int  `json:"strategy"`
	Analytics int  `json:"analytics"`
	Tokens    int  `json:"tokens"`
	Leases    int  `json:"leases"`
	Lane      Lane `json:"lane"`
}

// Stats counts, per owner, the tokens it holds.
func (c *Coordinator) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := Stats{Tokens: len(c.counts), Leases: len(c.leases), Lane: c.Lane}
	for _, e := range c.counts {
		for _, o := range owners {
			if *e.ptr(o) > 0 {
				switch o {
				case OwnerBrowser:
					s.Browser++
				case OwnerScanner:
					s.Scanner++
				case OwnerStrategy:
					s.Strategy++
				default:
					s.Analytics++
				}
			}
		}
	}
	return s
}
