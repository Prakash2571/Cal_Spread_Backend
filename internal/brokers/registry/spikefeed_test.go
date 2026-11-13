package registry

import (
	"reflect"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestSpikeSubscriptionsShareMainSocketAndRetainAllLaneHolds(t *testing.T) {
	u := dhanActiveRig(t)
	// Spike may be first. Every table keeps its own budget and all three share wire holds.
	u.reg.SetSpikeTokens([]int64{3, 5, 6, 7})
	u.reg.SetAnalyticsTokens([]int64{1, 4, 5, 7})
	u.reg.SetSyntheticTokens([]int64{2, 4, 6, 7})
	u.settle()
	main := u.reg.currentDhanFeed()
	assertWanted := func(want []int64) {
		t.Helper()
		u.settle()
		if len(u.feeds.feeds) != 1 || main != u.reg.currentDhanFeed() || main.feed != u.feeds.get(0) {
			t.Fatal("main, Box and Spike must share exactly one Dhan feed")
		}
		if got := wantedTokens(u.feeds.get(0)); !reflect.DeepEqual(got, want) {
			t.Fatalf("shared wanted %v, want %v", got, want)
		}
	}
	assertWanted([]int64{1, 2, 3, 4, 5, 6, 7})
	if u.reg.Subscriptions().Size() != 4 || u.reg.BoxSubscriptions().Size() != 4 || u.reg.spikeSubscriptions.Size() != 4 {
		t.Fatal("the three logical subscription tables must stay independent")
	}
	u.rec.take()
	u.reg.replaySpikeFeed()
	if got := u.rec.take(); len(got) != 0 {
		t.Fatalf("idempotent replay touched the wire: %q", got)
	}
	u.reg.SetSpikeTokens(nil)
	assertWanted([]int64{1, 2, 4, 5, 6, 7})
	u.reg.SetSpikeTokens([]int64{3, 5, 6, 7})
	u.reg.SetAnalyticsTokens(nil)
	assertWanted([]int64{2, 3, 4, 5, 6, 7})
	u.reg.SetSyntheticTokens(nil)
	assertWanted([]int64{3, 5, 6, 7})
	u.reg.SetSpikeTokens(nil)
	assertWanted([]int64{})
}

func TestSharedDhanSpikeTickRoutingAndNamespaceIsolation(t *testing.T) {
	u := dhanActiveRig(t)
	hub := &mainTickHub{fakeHub: u.hub}
	u.reg.hub = hub
	var box, spike []market.Tick
	u.reg.Attach(Hooks{
		OnBoxLaneTicks: func(ticks []market.Tick) { box = append(box, ticks...) },
		OnSpikeTicks:   func(ticks []market.Tick) { spike = append(spike, ticks...) },
	})
	u.reg.SetAnalyticsTokens([]int64{1, 4, 5, 7})
	u.reg.SetSyntheticTokens([]int64{2, 4, 6, 7})
	u.reg.SetSpikeTokens([]int64{3, 5, 6, 7})
	u.settle()
	// Every membership combination, an unowned token, and a repeated shared tick.
	ticks := []market.Tick{{Token: 1, LastPrice: 10}, {Token: 2, LastPrice: 20},
		{Token: 3, LastPrice: 30}, {Token: 4, LastPrice: 40}, {Token: 5, LastPrice: 50},
		{Token: 6, LastPrice: 60}, {Token: 7, LastPrice: 70}, {Token: 8, LastPrice: 80},
		{Token: 7, LastPrice: 71}}
	original := append([]market.Tick(nil), ticks...)
	feed := u.feeds.get(0)
	feed.opts.OnTicks(ticks)
	if want := []market.Tick{ticks[0], ticks[3], ticks[4], ticks[6], ticks[7], ticks[8]}; !reflect.DeepEqual(hub.ticks, want) {
		t.Fatalf("hub ticks %+v, want %+v", hub.ticks, want)
	}
	if want := []market.Tick{ticks[1], ticks[3], ticks[5], ticks[6], ticks[8]}; !reflect.DeepEqual(box, want) {
		t.Fatalf("box ticks %+v, want %+v", box, want)
	}
	namespace := u.reg.Namespace()
	wantSpike := []market.Tick{ticks[2], ticks[4], ticks[5], ticks[6], ticks[8]}
	for i := range wantSpike {
		wantSpike[i].Namespace = &namespace
	}
	if !reflect.DeepEqual(spike, wantSpike) || !reflect.DeepEqual(ticks, original) {
		t.Fatalf("Spike must get only its ticks, stamped without mutating the input: %+v", spike)
	}
	// Retained hub and box batches must remain unstamped after Spike delivery.
	for _, batch := range [][]market.Tick{hub.ticks, box} {
		for _, tick := range batch {
			if tick.Namespace != nil {
				t.Fatal("Spike namespace leaked into another consumer's ticks")
			}
		}
	}
	hub.ticks, box, spike = nil, nil, nil
	feed.opts.OnTicks([]market.Tick{ticks[2]})
	if len(hub.ticks) != 0 || len(box) != 0 || len(spike) != 1 {
		t.Fatal("Spike-only batch must reach only Spike")
	}
	u.reg.Attach(Hooks{})
	hub.ticks = nil
	feed.opts.OnTicks([]market.Tick{ticks[2]})
	feed.opts.OnTicks(nil)
	if len(hub.ticks) != 0 {
		t.Fatal("missing Spike hook must not leak Spike-only ticks to the hub")
	}
}

func TestSpikeDeliveryKeepsDhanAndSwitchingGuards(t *testing.T) {
	for _, state := range []string{"Dhan", "switching", "Zerodha"} {
		t.Run(state, func(t *testing.T) {
			u := dhanActiveRig(t)
			hub := &mainTickHub{fakeHub: u.hub}
			u.reg.hub = hub
			var spike, box []market.Tick
			u.reg.Attach(Hooks{
				OnSpikeTicks:   func(ticks []market.Tick) { spike = append(spike, ticks...) },
				OnBoxLaneTicks: func(ticks []market.Tick) { box = append(box, ticks...) },
			})
			u.reg.SetSpikeTokens([]int64{1, 2})
			u.reg.SetAnalyticsTokens([]int64{2})
			u.reg.SetSyntheticTokens([]int64{2})
			u.settle()
			if state == "switching" {
				u.reg.transitioning.Store(true)
			} else if state == "Zerodha" {
				u.reg.state.Store(&brokerState{active: brokers.Zerodha, gen: 4})
			}
			u.feeds.get(0).opts.OnTicks([]market.Tick{{Token: 1}, {Token: 2}})
			want := 0
			if state == "Dhan" {
				want = 2
			}
			if len(spike) != want || len(hub.ticks) != 1 || len(box) != 1 || hub.ticks[0].Namespace != nil || box[0].Namespace != nil {
				t.Fatalf("guard changed routing: spike=%+v hub=%+v box=%+v", spike, hub.ticks, box)
			}
		})
	}
}

func TestSpikeSubscribesNothingUnderZerodha(t *testing.T) {
	u := newUnitRig(t, nil, nil)
	u.reg.SetSpikeTokens([]int64{1, 2})
	u.reg.replaySpikeFeed()
	u.settle()
	if len(u.feeds.feeds) != 0 || u.reg.spikeSubscriptions.Size() != 2 {
		t.Fatal("Zerodha must retain Spike's table without constructing a Dhan feed")
	}
	if connected, size := u.reg.SpikeFeedStatus(); connected || size != 2 {
		t.Fatalf("unconstructed main health = %v, %d", connected, size)
	}
	u.reg.SetSpikeTokens(nil)
	u.settle()
	if len(u.feeds.feeds) != 0 {
		t.Fatal("Spike unsubscribe must not construct a feed")
	}
}

func TestMainConnectionEventsReachSpikeAndStatusUsesMainHealth(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.SetAnalyticsTokens([]int64{1, 2, 3})
	u.reg.SetSpikeTokens([]int64{3, 4})
	u.settle()
	u.reg.Attach(Hooks{
		OnSpikeConnection:   func(connected bool) { u.rec.add("spikeConnection %t", connected) },
		OnBoxLaneConnection: func(connected bool) { u.rec.add("boxConnection %t", connected) },
		Publish:             func() { u.rec.add("publish") },
	})
	u.rec.take()
	feed := u.feeds.get(0)
	for _, connected := range []bool{true, false} {
		feed.mu.Lock()
		feed.connected = connected
		feed.mu.Unlock()
		feed.opts.OnConnection(connected)
		if got, size := u.reg.SpikeFeedStatus(); got != connected || size != 2 {
			t.Fatalf("Spike status = %v, %d; want main health %v, Spike count 2", got, size, connected)
		}
	}
	want := []string{"hub:external true", "boxConnection true", "spikeConnection true", "publish",
		"hub:external false", "boxConnection false", "spikeConnection false", "publish"}
	if got := u.rec.take(); !reflect.DeepEqual(got, want) {
		t.Fatalf("main connection events %q, want %q", got, want)
	}
	u.reg.Attach(Hooks{})
	feed.opts.OnConnection(true)
	if got := u.rec.take(); !reflect.DeepEqual(got, []string{"hub:external true"}) {
		t.Fatalf("connection event without hooks %q", got)
	}
}

func TestRecycleReplaySpikeOnlyChangesSharedHolds(t *testing.T) {
	u := dhanActiveRig(t)
	u.reg.SetAnalyticsTokens([]int64{1, 3})
	u.reg.SetSyntheticTokens([]int64{2, 3, 5})
	u.reg.SetSpikeTokens([]int64{3, 4, 5})
	u.settle()
	main := u.reg.currentDhanFeed()
	feed := u.feeds.get(0)
	feed.mu.Lock()
	feed.connected = true
	feed.mu.Unlock()
	u.rec.take()
	for i := 0; i < 2; i++ {
		u.reg.recycleSpikeFeed()
	}
	if got := wantedTokens(feed); !reflect.DeepEqual(got, []int64{1, 2, 3, 5}) {
		t.Fatalf("recycle must preserve main and box holds: %v", got)
	}
	if !feed.IsConnected() || u.reg.spikeSubscriptions.Size() != 3 {
		t.Fatal("recycle must keep the socket connected and Spike's replay table intact")
	}
	u.reg.replaySpikeFeed()
	u.reg.replaySpikeFeed()
	if got := wantedTokens(feed); !reflect.DeepEqual(got, []int64{1, 2, 3, 4, 5}) {
		t.Fatalf("replayed union %v", got)
	}
	if len(u.feeds.feeds) != 1 || main != u.reg.currentDhanFeed() || strings.Contains(strings.Join(u.rec.take(), "\n"), ":stop") {
		t.Fatal("recycle/replay must neither stop nor construct a socket")
	}
	u.reg.SetSpikeTokens(nil)
	u.settle()
	if got := wantedTokens(feed); !reflect.DeepEqual(got, []int64{1, 2, 3, 5}) {
		t.Fatalf("release after replay lost another lane's holds: %v", got)
	}
}
