package registry

import (
	"context"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestSpikeLaneIsIsolatedAndRecyclesOnTokenReplacement(t *testing.T) {
	u, _ := newTokenRig(t, nil, nil)
	u.activateDhan("synthetic-old-token")
	ticks := make(chan []market.Tick, 4)
	u.reg.Attach(Hooks{OnSpikeTicks: func(batch []market.Tick) { ticks <- batch }})
	u.reg.SetSpikeTokens([]int64{2_000_030_000, 2_000_030_001})
	u.settle()
	if u.reg.Subscriptions().Size() != 0 || u.reg.BoxSubscriptions().Size() != 0 {
		t.Fatal("Spike consumed an existing lane's subscription budget")
	}
	old := u.reg.spikeDhanFeed
	u.feeds.get(0).opts.OnTicks([]market.Tick{{Token: 2_000_030_000, LastPrice: 100}})
	batch := <-ticks
	if batch[0].Namespace == nil || *batch[0].Namespace != u.reg.Namespace() {
		t.Fatal("Spike tick did not carry its broker generation")
	}
	if _, err := u.reg.FetchBrokerToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	u.settle()
	if u.reg.spikeDhanFeed == old || u.reg.spikeSubscriptions.Size() != 2 {
		t.Fatal("replacement token did not recycle/replay Spike's full chain")
	}
	u.feeds.get(0).opts.OnTicks([]market.Tick{{Token: 2_000_030_000, LastPrice: 1}})
	select {
	case <-ticks:
		t.Fatal("superseded Spike feed published a tick")
	default:
	}
	u.feeds.get(0).opts.OnSessionLost("superseded Spike socket")
	u.settle()
	if !u.reg.SessionFor("dhan").Authenticated {
		t.Fatal("superseded Spike feed cleared the replacement token")
	}
	u.reg.SetSpikeTokens(nil)
	u.reg.StopFeeds()
	if _, count := u.reg.SpikeFeedStatus(); count != 0 {
		t.Fatal("Spike subscriptions were not released")
	}
}
