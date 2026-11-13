package registry

import "github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"

// Spike keeps its own subscription table and shares the sole main Dhan socket.
const spikeLane brokers.Lane = "spike"

type spikeTransport struct{ r *Registry }

func (t spikeTransport) SubscribeTokens(tokens []int64) {
	if t.r.ActiveBroker() == brokers.Dhan {
		t.r.ensureDhanFeed().subscribeShared(spikeLane, tokens)
	}
}

func (t spikeTransport) UnsubscribeTokens(tokens []int64) {
	if feed := t.r.currentDhanFeed(); feed != nil {
		feed.unsubscribeShared(spikeLane, tokens)
	}
}

func (r *Registry) SetSpikeTokens(tokens []int64) {
	r.spikeSubscriptions.SetOwnerTokens(brokers.OwnerStrategy, tokens)
}

func (r *Registry) SpikeFeedStatus() (bool, int) {
	feed := r.currentDhanFeed()
	return feed != nil && feed.feed.IsConnected(), r.spikeSubscriptions.Size()
}

// recycleSpikeFeed releases only Spike's shared holds, preserving its table for
// replay. Callers own the main socket's stop/replacement; this never stops it.
func (r *Registry) recycleSpikeFeed() {
	if feed := r.currentDhanFeed(); feed != nil {
		feed.unsubscribeShared(spikeLane, r.spikeSubscriptions.ActiveTokens())
		feed.flush()
	}
}

func (r *Registry) replaySpikeFeed() {
	if tokens := r.spikeSubscriptions.ActiveTokens(); len(tokens) > 0 && r.ActiveBroker() == brokers.Dhan {
		feed := r.ensureDhanFeed()
		feed.subscribeShared(spikeLane, tokens)
		feed.flush()
	}
}
