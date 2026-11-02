package registry

// Ports of the tests/box/dhanActiveNoKite.test.mjs cases the routes golden did not
// assert. Node's "strategy" owner (setStrategyTokens) was fed only by the Box engine; the
// futures-lane non-browser owner in Go is "analytics" (SetAnalyticsTokens), which takes
// the same routing path. Node's fake Dhan feed counted subscribed tokens; fakeDhanFeed
// records each call and keeps the wanted set.

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
)

// dhanUniverseTokens are the suite's dhanUniverse() instrument tokens.
var dhanUniverseTokens = []int64{
	dhan.InternalToken(dhan.Segment("NSE_FNO"), 45000),
	dhan.InternalToken(dhan.Segment("NSE_FNO"), 45001),
	dhan.InternalToken(dhan.Segment("NSE_EQ"), 1512),
}

// dhanActiveRig is the suite's dhanActive(): Dhan active with a session, no Zerodha
// session.
func dhanActiveRig(t *testing.T) *unitRig {
	t.Helper()
	u := newUnitRig(t, nil, nil)
	u.kite.setToken(nil)
	u.activateDhan("tok")
	u.rec.take()
	return u
}

func wantedTokens(f *fakeDhanFeed) []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []int64{}
	for tok := range f.wanted {
		out = append(out, tok)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func sorted(t []int64) []int64 {
	out := append([]int64(nil), t...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// noKite fails on any Zerodha hub or Kite REST event.
func noKite(t *testing.T, events []string) {
	t.Helper()
	for _, e := range events {
		if strings.HasPrefix(e, "hub:") || strings.HasPrefix(e, "kite:") {
			t.Errorf("Kite was used: %q (all events %q)", e, events)
		}
	}
}

func countPrefix(events []string, prefix string) int {
	n := 0
	for _, e := range events {
		if strings.HasPrefix(e, prefix) {
			n++
		}
	}
	return n
}

// "SSE subscriptions reach DHAN and create ZERO Kite subscriptions"
func TestNodeSSESubscriptionsReachDhanOnly(t *testing.T) {
	u := dhanActiveRig(t)
	release := u.reg.AcquireBrowserTokens(dhanUniverseTokens)
	u.settle()
	events := u.rec.take()
	noKite(t, events)
	if got := wantedTokens(u.feeds.get(0)); !reflect.DeepEqual(got, sorted(dhanUniverseTokens)) {
		t.Errorf("Dhan feed holds %v, want all three %v (events %q)", got, dhanUniverseTokens, events)
	}
	if countPrefix(events, "feed1:subscribe ") != 1 {
		t.Errorf("events %q, want one Dhan subscribe", events)
	}
	release()
}

// "the strategy's tokens also route to Dhan only"
func TestNodeNonBrowserFuturesTokensRouteToDhanOnly(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.SetAnalyticsTokens(dhanUniverseTokens)
	u.settle()
	events := u.rec.take()
	noKite(t, events)
	if got := wantedTokens(u.feeds.get(0)); !reflect.DeepEqual(got, sorted(dhanUniverseTokens)) {
		t.Errorf("Dhan feed holds %v, want %v (events %q)", got, dhanUniverseTokens, events)
	}
}

// "browser and strategy SHARE a token without duplicating the upstream subscription"
func TestNodeBrowserAndNonBrowserOwnerShareATokenWithoutASecondSubscribe(t *testing.T) {
	u := dhanActiveRig(t)
	token := dhanUniverseTokens[0]
	u.reg.SetAnalyticsTokens([]int64{token})
	u.settle()
	if n := countPrefix(u.rec.take(), "feed1:subscribe "); n != 1 {
		t.Fatalf("%d subscribes for the first owner", n)
	}
	before := u.feeds.get(0).WantedCount()
	release := u.reg.AcquireBrowserTokens([]int64{token})
	u.settle()
	if events := u.rec.take(); countPrefix(events, "feed1:subscribe ") != 0 || u.feeds.get(0).WantedCount() != before {
		t.Errorf("a second upstream subscribe: %q", events)
	}
	// Releasing the browser must not blind the other owner.
	release()
	u.settle()
	if events := u.rec.take(); countPrefix(events, "feed1:unsubscribe ") != 0 {
		t.Errorf("release unsubscribed a shared token: %q", events)
	}
	if got := u.reg.Subscriptions().ActiveTokens(); !reflect.DeepEqual(got, []int64{token}) {
		t.Errorf("activeTokens = %v, want [%d]", got, token)
	}
}

// "token assertion is permissive only while the universe is UNLOADED"
func TestNodeTokenAssertionIsPermissiveWhileTheUniverseIsUnloaded(t *testing.T) {
	u := dhanActiveRig(t)
	if !u.reg.AssertActiveBrokerToken(408065, "test") {
		t.Fatal("unknown universe => allow")
	}
}

// "feed health is LIVE only when connected AND subscribed AND ticking"
func TestNodeRegistryFeedHealthIsLiveWhenConnectedSubscribedAndTicking(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.NoteTick()
	u.reg.SetAnalyticsTokens(dhanUniverseTokens)
	u.settle()
	f := u.feeds.get(0) // the stub socket reports connected, as Node's fake feed did
	f.mu.Lock()
	f.connected = true
	f.mu.Unlock()
	h := u.reg.FeedHealth()
	if !h.Connected || h.Subscribed <= 0 || h.State != brokers.FeedLive {
		t.Fatalf("feed health %+v", h)
	}
}

// "with ZERODHA active, a live Dhan session does NOT drive subscriptions"
func TestNodeZerodhaActiveDhanSessionDoesNotDriveSubscriptions(t *testing.T) {
	u := newUnitRig(t, nil, nil) // Zerodha active with a Kite session
	tok := "dhan-tok"
	u.reg.setDhanSession(&tok, nil, &dhanMeta{clientID: "1100001", clientName: "T", loginDay: "2026-10-28", loginAt: 1})
	u.rec.take()
	if u.reg.ActiveBroker() != brokers.Zerodha {
		t.Fatalf("active %q", u.reg.ActiveBroker())
	}
	u.reg.SetAnalyticsTokens([]int64{408065, 408321})
	u.settle()
	events := u.rec.take()
	if !reflect.DeepEqual(events, []string{"hub:subscribe [408065,408321]"}) {
		t.Errorf("events %q, want only the Kite hub subscribe", events)
	}
	u.feeds.mu.Lock()
	feeds := append([]*fakeDhanFeed(nil), u.feeds.feeds...)
	u.feeds.mu.Unlock()
	for _, f := range feeds {
		if n := f.WantedCount(); n != 0 {
			t.Errorf("the inactive Dhan feed %s holds %d tokens", f.name, n)
		}
	}
}
