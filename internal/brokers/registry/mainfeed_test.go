package registry

import (
	"bytes"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestBoxDhanSubscriptionsShareMainAndRetainOverlappingTokens(t *testing.T) {
	u := dhanActiveRig(t)
	// Box may subscribe first and must create only main.
	u.reg.SetSyntheticTokens([]int64{2, 3})
	u.reg.flushLane(brokers.LaneBox)
	main := u.reg.currentDhanFeed()
	if main == nil || len(u.feeds.feeds) != 1 || main.feed != u.feeds.get(0) || u.reg.boxLaneFeed != nil {
		t.Fatal("Box Dhan must use only the main Dhan feed")
	}
	assertWanted := func(want []int64) {
		t.Helper()
		u.reg.flushLane(brokers.LaneBox)
		if got := wantedTokens(u.feeds.get(0)); !reflect.DeepEqual(got, want) {
			t.Fatalf("main wanted %v, want %v", got, want)
		}
		if len(u.feeds.feeds) != 1 {
			t.Fatal("a subscription change constructed another Dhan feed")
		}
	}
	release := u.reg.AcquireBrowserTokens([]int64{1, 3})
	assertWanted([]int64{1, 2, 3})
	u.rec.take()
	u.reg.subscribeUpstream(brokers.LaneBox, []int64{2, 3})
	assertWanted([]int64{1, 2, 3})
	if got := u.rec.take(); len(got) != 0 {
		t.Fatalf("replay must be idempotent: %q", got)
	}
	// Releasing main's hold must retain the shared token for Box.
	release()
	assertWanted([]int64{2, 3})
	if got := u.rec.take(); !reflect.DeepEqual(got, []string{"feed1:unsubscribe [1]"}) {
		t.Fatalf("main release events %q", got)
	}
	release = u.reg.AcquireBrowserTokens([]int64{1, 3})
	assertWanted([]int64{1, 2, 3})
	u.rec.take()
	// Releasing Box's hold must retain the shared token for main too.
	u.reg.SetSyntheticTokens(nil)
	assertWanted([]int64{1, 3})
	if got := u.rec.take(); !reflect.DeepEqual(got, []string{"feed1:unsubscribe [2]"}) {
		t.Fatalf("Box release events %q", got)
	}
	release()
	assertWanted([]int64{})
}

type mainTickHub struct {
	*fakeHub
	ticks []market.Tick
}

func (h *mainTickHub) IngestExternalTicks(ticks []market.Tick) {
	h.ticks = append(h.ticks, ticks...)
	h.fakeHub.IngestExternalTicks(ticks)
}

func TestSharedMainDhanTickRouting(t *testing.T) {
	u := dhanActiveRig(t)
	hub := &mainTickHub{fakeHub: u.hub}
	u.reg.hub = hub
	var box []market.Tick
	u.reg.Attach(Hooks{OnBoxLaneTicks: func(ticks []market.Tick) { box = append(box, ticks...) }})
	release := u.reg.AcquireBrowserTokens([]int64{1, 3})
	u.reg.SetSyntheticTokens([]int64{2, 3})
	u.settle()
	feed := u.feeds.get(0)
	// 1 is main-only, 2 is box-only, 3 is shared, 4 is in neither table.
	// Preserve tick data, order and repeated ticks for both consumers.
	ticks := []market.Tick{{Token: 1, LastPrice: 10}, {Token: 2, LastPrice: 20},
		{Token: 3, LastPrice: 30}, {Token: 4, LastPrice: 40}, {Token: 3, LastPrice: 31}}
	feed.opts.OnTicks(ticks)
	if want := []market.Tick{ticks[0], ticks[2], ticks[3], ticks[4]}; !reflect.DeepEqual(hub.ticks, want) {
		t.Fatalf("hub ticks %v, want %v", hub.ticks, want)
	}
	if want := []market.Tick{ticks[1], ticks[2], ticks[4]}; !reflect.DeepEqual(box, want) {
		t.Fatalf("Box ticks %v, want %v", box, want)
	}
	hub.ticks, box = nil, nil
	u.clock.advance(7)
	feed.opts.OnTicks([]market.Tick{ticks[1]})
	if len(hub.ticks) != 0 || !reflect.DeepEqual(box, []market.Tick{ticks[1]}) {
		t.Fatal("a box-only batch must reach only Box")
	}
	if last := u.reg.lastTick(); last == nil || *last != u.clock.ms.Load() {
		t.Fatal("box-only ticks must still update feed liveness")
	}
	// Shared becomes box-only after main releases, then neither after Box releases.
	release()
	u.settle()
	hub.ticks, box = nil, nil
	feed.opts.OnTicks([]market.Tick{ticks[2]})
	if len(hub.ticks) != 0 || !reflect.DeepEqual(box, []market.Tick{ticks[2]}) {
		t.Fatal("a token released by main must continue to reach Box")
	}
	u.reg.SetSyntheticTokens(nil)
	u.settle()
	hub.ticks, box = nil, nil
	feed.opts.OnTicks([]market.Tick{ticks[2]})
	if len(box) != 0 || !reflect.DeepEqual(hub.ticks, []market.Tick{ticks[2]}) {
		t.Fatal("a tick wanted by neither table must retain main delivery")
	}
	u.reg.SetSyntheticTokens([]int64{2})
	u.settle()
	u.reg.Attach(Hooks{})
	hub.ticks = nil
	feed.opts.OnTicks([]market.Tick{ticks[1]})
	feed.opts.OnTicks(nil)
	if len(hub.ticks) != 0 {
		t.Fatal("a missing Box hook must not leak box-only ticks to the hub")
	}
}

func TestMainDhanConnectionEventsAlsoReachBox(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.StartActiveFeed()
	u.rec.take()
	feed := u.feeds.get(0)
	feed.opts.OnConnection(true)
	feed.opts.OnConnection(false)
	want := []string{"hub:external true", "boxLaneConnection true", "publish",
		"hub:external false", "boxLaneConnection false", "publish"}
	if got := u.rec.take(); !reflect.DeepEqual(got, want) {
		t.Fatalf("connection events %q, want %q", got, want)
	}
	u.reg.Attach(Hooks{})
	feed.opts.OnConnection(true)
	if got := u.rec.take(); !reflect.DeepEqual(got, []string{"hub:external true"}) {
		t.Fatalf("connection event with no hooks %q", got)
	}
}

type mainStatsFeed struct{ *fakeDhanFeed }

func (f *mainStatsFeed) SubscribedCount() int { return 3 }
func (f *mainStatsFeed) FeedAgeMs() *int64    { age := int64(17); return &age }

func TestBoxDhanLaneStatsUseMainHealthAndBoxWantedCount(t *testing.T) {
	u := dhanActiveRig(t)
	if got := u.reg.LaneStats(brokers.LaneBox); got.Connected || got.WantedTokens != 0 || got.LastTickAgeMs != nil {
		t.Fatalf("before main exists: %+v", got)
	}
	u.reg.deps.NewDhanFeed = func(opts dhan.FeedOptions) DhanFeed {
		return &mainStatsFeed{fakeDhanFeed: u.feeds.new(opts).(*fakeDhanFeed)}
	}
	u.reg.SetAnalyticsTokens([]int64{1, 3})
	u.reg.SetSyntheticTokens([]int64{2, 3})
	u.settle()
	feed := u.feeds.get(0)
	feed.mu.Lock()
	feed.connected = true
	feed.mu.Unlock()
	age := int64(17)
	want := brokers.LaneFeedStats{Lane: brokers.LaneBox, Connected: true,
		SubscribedTokens: 3, WantedTokens: 2, LastTickAgeMs: &age, Generation: 3}
	if got := u.reg.LaneStats(brokers.LaneBox); !reflect.DeepEqual(got, want) {
		t.Fatalf("Box stats %+v, want %+v", got, want)
	}
	if got := u.reg.LaneStats(brokers.LaneFutures); got.WantedTokens != 3 || !got.Connected || got.SubscribedTokens != 3 {
		t.Fatalf("main socket stats %+v", got)
	}
}

func TestMainDhanCapacityWarnsOnlyWhenUnionCrosses5000(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	u := dhanActiveRig(t)
	tokens := make([]int64, 5002)
	for i := range tokens {
		tokens[i] = int64(i + 1)
	}
	u.reg.SetAnalyticsTokens(tokens[:2800])
	// Include an overlap: table sizes may sum above the cap while the union fits.
	u.reg.SetSyntheticTokens(append([]int64{1}, tokens[2800:5000]...))
	u.settle()
	const message = "Dhan main feed exceeds the per-connection instrument cap"
	if strings.Contains(logs.String(), message) {
		t.Fatal("5000 distinct instruments must not warn")
	}
	// Spike overlaps the union at 5000, then adds the instrument crossing the cap.
	u.reg.SetSpikeTokens(tokens[4999:5001])
	u.settle()
	if strings.Count(logs.String(), message) != 1 || !strings.Contains(logs.String(), "level=WARN") || !strings.Contains(logs.String(), "wanted=5001 limit=5000") {
		t.Fatalf("expected one capacity warning: %s", logs.String())
	}
	u.reg.SetSpikeTokens(tokens[4999:5002])
	u.settle()
	if strings.Count(logs.String(), message) != 1 || u.feeds.get(0).WantedCount() != 5002 {
		t.Fatal("remaining above the cap should neither repeat warnings nor refuse subscriptions")
	}
	u.reg.SetSpikeTokens(tokens[4999:5000])
	u.settle()
	u.reg.SetSpikeTokens(tokens[4999:5001])
	u.settle()
	if strings.Count(logs.String(), message) != 2 {
		t.Fatal("crossing the cap again must warn again")
	}
}

func TestSharedDhanSubscriptionStateResetsOnStop(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.SetAnalyticsTokens([]int64{1, 3})
	u.reg.SetSyntheticTokens([]int64{2, 3})
	u.reg.SetSpikeTokens([]int64{5})
	u.settle()
	main := u.reg.currentDhanFeed()
	u.reg.StopFeeds()
	if len(u.feeds.feeds) != 1 || u.feeds.get(0).WantedCount() != 0 {
		t.Fatal("shutdown must stop the sole shared socket")
	}
	// Shutdown keeps the tables and a restartable main feed. Replay must rebuild
	// its union instead of treating pre-stop holds as already on the wire.
	u.reg.subscribeUpstream(brokers.LaneFutures, u.reg.Subscriptions().ActiveTokens())
	u.reg.subscribeUpstream(brokers.LaneBox, u.reg.BoxSubscriptions().ActiveTokens())
	u.reg.replaySpikeFeed()
	u.settle()
	if u.reg.currentDhanFeed() != main || len(u.feeds.feeds) != 1 {
		t.Fatal("stopped main should remain restartable")
	}
	if got := wantedTokens(u.feeds.get(0)); !reflect.DeepEqual(got, []int64{1, 2, 3, 5}) {
		t.Fatalf("replayed union %v", got)
	}
	u.reg.SetSyntheticTokens(nil)
	u.settle()
	if got := wantedTokens(u.feeds.get(0)); !reflect.DeepEqual(got, []int64{1, 3, 5}) {
		t.Fatalf("Box release after replay lost main tokens: %v", got)
	}
}

func TestCurrentDhanSessionLossStopsSharedSocketAndPreservesAllTables(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.SetAnalyticsTokens([]int64{1, 3})
	u.reg.SetSyntheticTokens([]int64{2, 3})
	u.reg.SetSpikeTokens([]int64{5})
	u.settle()
	if len(u.feeds.feeds) != 1 {
		t.Fatal("main, Box and Spike must construct only one feed")
	}
	u.rec.take()
	u.feeds.get(0).opts.OnSessionLost("current feed rejected the token")
	u.settle()
	if u.reg.SessionFor(brokers.Dhan).Authenticated || u.feeds.get(0).WantedCount() != 0 {
		t.Fatal("current feed auth loss must clear the session and stop the shared socket")
	}
	if got := u.rec.take(); countPrefix(got, "feed1:stop") != 1 || countPrefix(got, "boxLaneConnection false") != 1 {
		t.Fatalf("session loss events %q", got)
	}
	if u.reg.Subscriptions().Size() != 2 || u.reg.BoxSubscriptions().Size() != 2 || u.reg.spikeSubscriptions.Size() != 1 {
		t.Fatal("auth loss must preserve all three logical tables for replay")
	}
}
