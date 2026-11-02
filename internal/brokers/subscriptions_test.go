package brokers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"
)

// Ported from tests/box/subscriptionCoordinator.test.mjs and marketDataLanes.test.mjs.

type recorder struct {
	mu           sync.Mutex
	sub, unsub   [][]int64
	subscribed   []int64
	unsubscribed []int64
}

func (r *recorder) SubscribeTokens(t []int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := append([]int64(nil), t...)
	sort.Slice(cp, func(i, j int) bool { return cp[i] < cp[j] })
	r.sub = append(r.sub, cp)
	r.subscribed = append(r.subscribed, t...)
}
func (r *recorder) UnsubscribeTokens(t []int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := append([]int64(nil), t...)
	sort.Slice(cp, func(i, j int) bool { return cp[i] < cp[j] })
	r.unsub = append(r.unsub, cp)
	r.unsubscribed = append(r.unsubscribed, t...)
}
func (r *recorder) live() map[int64]bool {
	m := map[int64]bool{}
	for _, t := range r.subscribed {
		m[t] = true
	}
	for _, t := range r.unsubscribed {
		delete(m, t)
	}
	return m
}

func flat(list [][]int64) []int64 {
	out := []int64{}
	for _, l := range list {
		out = append(out, l...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func newCoord() (*Coordinator, *recorder) {
	r := &recorder{}
	return NewCoordinator(r, LaneFutures), r
}

func eq(t *testing.T, got, want any, msg string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s: got %v want %v", msg, got, want)
	}
}

func TestFirstAcquireSubscribesOnce(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{1, 2, 3})
	eq(t, r.sub, [][]int64{{1, 2, 3}}, "sub")
	eq(t, len(r.unsub), 0, "unsub")
}

func TestOverlappingClientsSubscribeEachTokenOnce(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{1, 2, 3})
	c.Acquire(OwnerBrowser, []int64{2, 3, 4})
	eq(t, flat(r.sub), []int64{1, 2, 3, 4}, "no duplicate upstream subscriptions")
	eq(t, r.sub[1], []int64{4}, "only the new token")
}

func TestReleaseKeepsTokensOthersWantAndDropsTheRestAtTheEnd(t *testing.T) {
	c, r := newCoord()
	a := c.Acquire(OwnerBrowser, []int64{1, 2, 3})
	b := c.Acquire(OwnerBrowser, []int64{2, 3, 4})
	r.unsub = nil
	a.Release()
	eq(t, flat(r.unsub), []int64{1}, "only 1 dropped")
	eq(t, c.ActiveTokens(), []int64{2, 3, 4}, "active")
	r.unsub = nil
	b.Release()
	eq(t, flat(r.unsub), []int64{2, 3, 4}, "last client releases the rest")
	eq(t, c.ActiveTokens(), []int64{}, "empty")
}

func TestStrategyTokenSurvivesBrowserDisconnect(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerStrategy, []int64{100})
	browser := c.Acquire(OwnerBrowser, []int64{100, 101})
	r.unsub = nil
	browser.Release()
	eq(t, flat(r.unsub), []int64{101}, "only the browser-only token")
	eq(t, c.ActiveTokens(), []int64{100}, "strategy keeps its token")
}

func TestPerOwnerCountsAndDuplicateTokensInOneLease(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{7})
	c.Acquire(OwnerBrowser, []int64{7})
	c.Acquire(OwnerStrategy, []int64{7})
	got := c.CountsFor(7)
	if got.Browser != 2 || got.Strategy != 1 || got.Total != 3 {
		t.Errorf("counts = %+v", got)
	}
	c2, r2 := newCoord()
	lease := c2.Acquire(OwnerBrowser, []int64{5, 5, 5})
	if c2.CountsFor(5).Total != 1 {
		t.Error("repeat within a lease counts once")
	}
	lease.Release()
	eq(t, flat(r2.unsub), []int64{5}, "unsub")
	if c2.CountsFor(5) != nil {
		t.Error("gone")
	}
	_ = r
}

func TestDoubleReleaseIsHarmless(t *testing.T) {
	c, r := newCoord()
	other := c.Acquire(OwnerStrategy, []int64{9})
	lease := c.Acquire(OwnerBrowser, []int64{9})
	lease.Release()
	lease.Release()
	eq(t, flat(r.unsub), []int64{}, "9 still held by strategy")
	if c.CountsFor(9).Total != 1 {
		t.Error("total")
	}
	other.Release()
}

func TestSetOwnerTokensDiffsAWindow(t *testing.T) {
	c, r := newCoord()
	c.SetOwnerTokens(OwnerScanner, []int64{1, 2, 3})
	r.sub, r.unsub = nil, nil
	c.SetOwnerTokens(OwnerScanner, []int64{2, 3, 4})
	eq(t, flat(r.unsub), []int64{1}, "abandoned")
	eq(t, flat(r.sub), []int64{4}, "new")
}

func TestSetOwnerTokensLeavesOtherOwnersAlone(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{1, 2})
	c.SetOwnerTokens(OwnerScanner, []int64{2, 3})
	r.unsub = nil
	c.SetOwnerTokens(OwnerScanner, nil)
	eq(t, flat(r.unsub), []int64{3}, "2 is still wanted by the browser")
	eq(t, c.ActiveTokens(), []int64{1, 2}, "active")
}

func TestResetForBrokerSwitchIssuesNoUnsubscribe(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{1, 2})
	c.SetOwnerTokens(OwnerScanner, []int64{3, 4})
	r.sub, r.unsub = nil, nil
	dropped, _ := c.ResetForBrokerSwitch()
	if dropped != 4 || len(r.unsub) != 0 || c.Size() != 0 {
		t.Errorf("dropped=%d unsub=%v size=%d", dropped, r.unsub, c.Size())
	}
	c.Acquire(OwnerBrowser, []int64{2_000_045_678})
	eq(t, flat(r.sub), []int64{2_000_045_678}, "clean re-subscribe in the new namespace")
}

func TestStatsAndInvalidTokens(t *testing.T) {
	c, r := newCoord()
	c.Acquire(OwnerBrowser, []int64{1, 2})
	c.SetOwnerTokens(OwnerScanner, []int64{2, 3})
	s := c.Stats()
	if s.Browser != 2 || s.Scanner != 2 || s.Tokens != 3 || s.Lane != LaneFutures {
		t.Errorf("stats %+v", s)
	}
	b, _ := json.Marshal(s)
	if string(b) != `{"browser":2,"scanner":2,"strategy":0,"analytics":0,"tokens":3,"leases":2,"lane":"futures"}` {
		t.Errorf("stats json = %s", b)
	}
	c2, r2 := newCoord()
	c2.Acquire(OwnerBrowser, []int64{0, -1, 5})
	eq(t, flat(r2.sub), []int64{5}, "invalid ignored")
	_ = r
}

func TestAnalyticsYieldRunsFirstAndMayReenter(t *testing.T) {
	// fairValue hardening #4: growing the strategy set must call the yield handler before
	// anything is added upstream, and analytics may shrink in response.
	r := &recorder{}
	c := NewCoordinator(r, LaneFutures)
	c.SetOwnerTokens(OwnerStrategy, []int64{1, 2})
	c.SetOwnerTokens(OwnerAnalytics, []int64{1, 3, 4})
	var order []string
	c.SetAnalyticsYield(func(priority map[int64]struct{}) {
		order = append(order, "yield")
		keep := []int64{}
		for _, tok := range []int64{1, 3, 4} {
			if _, ok := priority[tok]; ok || tok == 1 {
				keep = append(keep, tok)
			}
		}
		// Drop 3 and 4 for room, re-entering the coordinator from the handler.
		c.SetOwnerTokens(OwnerAnalytics, []int64{1})
		_ = keep
	})
	r.sub, r.unsub = nil, nil
	c.SetOwnerTokens(OwnerStrategy, []int64{1, 2, 5, 6})
	eq(t, order, []string{"yield"}, "handler called once")
	eq(t, flat(r.unsub), []int64{3, 4}, "analytics-only tokens dropped")
	eq(t, flat(r.sub), []int64{5, 6}, "new strategy tokens added")
	if !c.Owns(OwnerAnalytics, 1) {
		t.Error("analytics keeps the shared token")
	}
	eq(t, c.ActiveTokens(), []int64{1, 2, 5, 6}, "upstream set")
	// A yield handler that panics must not break the operation.
	c.SetAnalyticsYield(func(map[int64]struct{}) { panic("boom") })
	c.Acquire(OwnerBrowser, []int64{9})
	if !c.Owns(OwnerBrowser, 9) {
		t.Error("acquire must proceed after a failed yield")
	}
}

func TestLanesAreIsolated(t *testing.T) {
	ft, bt := &recorder{}, &recorder{}
	futures, box := NewCoordinator(ft, LaneFutures), NewCoordinator(bt, LaneBox)
	futures.SetOwnerTokens(OwnerStrategy, []int64{111, 222})
	box.SetOwnerTokens(OwnerStrategy, []int64{900, 901, 902})
	for _, tok := range box.ActiveTokens() {
		for _, f := range futures.ActiveTokens() {
			if tok == f {
				t.Fatal("a box token leaked into futures")
			}
		}
	}
	df, _ := futures.ResetForBrokerSwitch()
	db, _ := box.ResetForBrokerSwitch()
	if df != 2 || db != 3 || futures.Size() != 0 || box.Size() != 0 {
		t.Errorf("reset: %d %d", df, db)
	}
	if futures.Stats().Lane != LaneFutures || box.Stats().Lane != LaneBox {
		t.Error("lane names")
	}
	eq(t, Lanes, []Lane{LaneFutures, LaneBox}, "exactly two lanes")
}

func TestSameTokenInBothLanesIsCountedIndependently(t *testing.T) {
	ft, bt := &recorder{}, &recorder{}
	futures, box := NewCoordinator(ft, LaneFutures), NewCoordinator(bt, LaneBox)
	f := futures.Acquire(OwnerBrowser, []int64{42})
	box.Acquire(OwnerStrategy, []int64{42})
	f.Release()
	if futures.CountsFor(42) != nil || box.CountsFor(42) == nil {
		t.Error("lanes must not share counts")
	}
}

func TestThreeThousandBoxTokensDiffOnMove(t *testing.T) {
	bt := &recorder{}
	box := NewCoordinator(bt, LaneBox)
	many := make([]int64, 3000)
	for i := range many {
		many[i] = 500_000 + int64(i)
	}
	box.SetOwnerTokens(OwnerStrategy, many)
	if box.Size() != 3000 || len(bt.live()) != 3000 {
		t.Fatal("all tracked and subscribed once")
	}
	moved := make([]int64, 3000)
	for i := range moved {
		moved[i] = 500_500 + int64(i)
	}
	before := len(bt.subscribed)
	box.SetOwnerTokens(OwnerStrategy, moved)
	if added := len(bt.subscribed) - before; added != 500 || box.Size() != 3000 {
		t.Errorf("added=%d size=%d", added, box.Size())
	}
}

func TestConcurrentUseIsRaceFree(t *testing.T) {
	c, _ := newCoord()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				l := c.Acquire(OwnerBrowser, []int64{int64(1 + i%20), int64(100 + g)})
				c.SetOwnerTokens(OwnerScanner, []int64{int64(1 + i%7)})
				c.Stats()
				l.Release()
			}
		}(g)
	}
	wg.Wait()
}

// --- TickRateCounter ---

func TestTickRateCounterMatchesNode(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "lane_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Scenarios []struct {
			Seconds int `json:"seconds"`
			Ops     []struct {
				Op       string  `json:"op"`
				Count    int     `json:"count"`
				Now      int64   `json:"now"`
				Expected float64 `json:"expected"`
			} `json:"ops"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for i, s := range f.Scenarios {
		c := NewTickRateCounter(s.Seconds)
		for j, op := range s.Ops {
			switch op.Op {
			case "mark":
				c.Mark(op.Count, op.Now)
			case "reset":
				c.Reset()
			case "rate":
				checked++
				if got := c.PerSecond(op.Now); got != op.Expected {
					t.Fatalf("scenario %d op %d: got %v want %v", i, j, got, op.Expected)
				}
			}
		}
	}
	if len(f.Scenarios) < 50 || checked < 100 {
		t.Fatalf("too few reference points: %d scenarios, %d rates", len(f.Scenarios), checked)
	}
}

func TestTickRateCounterStaysBounded(t *testing.T) {
	c := NewTickRateCounter(10)
	start := int64(1_700_000_000_000)
	for sec := int64(0); sec < 60; sec++ {
		for b := int64(0); b < 50; b++ {
			c.Mark(100, start+sec*1000+b)
		}
	}
	if rate := c.PerSecond(start + 60_000); rate != 5000 {
		t.Errorf("rate = %v", rate)
	}
	if len(c.buckets) != 10 || len(c.bucketAt) != 10 {
		t.Error("ring grew")
	}
}

func TestLaneLabels(t *testing.T) {
	if LaneLabel(LaneFutures) != "futures/calendar-spread" || LaneLabel(LaneBox) != "box-arbitrage options" {
		t.Error("labels")
	}
}
