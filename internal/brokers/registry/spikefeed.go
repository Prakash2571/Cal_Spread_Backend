package registry

import (
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// One fixed, dedicated Dhan socket keeps full NIFTY/SENSEX chains from consuming
// the existing browser/Fair Value or Synthetic lanes' token budgets.
const spikeLane brokers.Lane = "spike"

type spikeTransport struct{ r *Registry }

func (t spikeTransport) SubscribeTokens(tokens []int64) {
	if t.r.ActiveBroker() == brokers.Dhan {
		t.r.ensureSpikeFeed().subscribe(tokens)
	}
}

func (t spikeTransport) UnsubscribeTokens(tokens []int64) {
	t.r.mu.Lock()
	feed := t.r.spikeDhanFeed
	t.r.mu.Unlock()
	if feed != nil {
		feed.unsubscribe(tokens)
	}
}

func (r *Registry) SetSpikeTokens(tokens []int64) {
	r.spikeSubscriptions.SetOwnerTokens(brokers.OwnerStrategy, tokens)
}

func (r *Registry) SpikeFeedStatus() (bool, int) {
	r.mu.Lock()
	feed := r.spikeDhanFeed
	r.mu.Unlock()
	return feed != nil && feed.feed.IsConnected(), r.spikeSubscriptions.Size()
}

func (r *Registry) currentSpikeFeed(lane *dhanLane) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return lane == r.spikeDhanFeed
}

func (r *Registry) ensureSpikeFeed() *dhanLane {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.spikeDhanFeed == nil {
		lane := &dhanLane{}
		lane.feed = r.newDhanFeed(dhan.FeedOptions{
			AccessToken: r.usableDhanToken, ClientID: r.dhanClientID,
			Resolve: r.dhanInstruments.Identify, DepthLevel: 5,
			OnTicks: func(ticks []market.Tick) {
				if !r.currentSpikeFeed(lane) || r.ActiveBroker() != brokers.Dhan || r.Switching() {
					return
				}
				namespace := r.Namespace()
				for i := range ticks {
					ticks[i].Namespace = &namespace
				}
				if hook := r.getHooks().OnSpikeTicks; hook != nil {
					hook(ticks)
				}
			},
			OnConnection: func(connected bool) {
				if r.currentSpikeFeed(lane) {
					if hook := r.getHooks().OnSpikeConnection; hook != nil {
						hook(connected)
					}
				}
			},
			OnSessionLost: func(reason string) { r.background(func() { r.onDhanFeedSessionLost(lane, reason) }) },
		})
		r.spikeDhanFeed = lane
	}
	return r.spikeDhanFeed
}

func (r *Registry) recycleSpikeFeed() {
	r.mu.Lock()
	old := r.spikeDhanFeed
	r.spikeDhanFeed = nil
	r.mu.Unlock()
	if old != nil {
		old.stop()
	}
}

func (r *Registry) replaySpikeFeed() {
	if tokens := r.spikeSubscriptions.ActiveTokens(); len(tokens) > 0 && r.ActiveBroker() == brokers.Dhan {
		feed := r.ensureSpikeFeed()
		feed.subscribe(tokens)
		feed.flush()
	}
}
