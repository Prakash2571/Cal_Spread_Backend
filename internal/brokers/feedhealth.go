package brokers

import (
	"fmt"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// FeedState is the coarse health of the active broker's feed.
type FeedState string

const (
	FeedDown                    FeedState = "DOWN"
	FeedConnecting              FeedState = "CONNECTING"
	FeedConnectedNoSubscription FeedState = "CONNECTED_NO_SUBSCRIPTIONS"
	FeedLive                    FeedState = "LIVE"
	FeedStale                   FeedState = "STALE"
)

// FeedHealth is the feed summary shown to the UI. Key order is part of the contract.
type FeedHealth struct {
	Connected  bool   `json:"connected"`
	Subscribed int    `json:"subscribed"`
	Universe   *int   `json:"universe"`
	FeedAgeMs  *int64 `json:"feed_age_ms"`
	LastTickAt *int64 `json:"last_tick_at"`
	// State and Detail follow the base fields: Node builds the object as {...base, state,
	// detail}, so that is the order clients have always received.
	State  FeedState `json:"state"`
	Detail string    `json:"detail"`
}

// FeedHealthInput is what ComputeFeedHealth classifies.
type FeedHealthInput struct {
	Connected     bool
	Connecting    bool
	Authenticated bool
	Subscribed    int
	Universe      *int
	LastTickAt    *int64
	StaleAfterMs  int64 // 0 means 30000
	NowMs         int64
}

// ComputeFeedHealth classifies the feed (feedHealth.ts). The checks run in order:
// no session, not connected, nothing subscribed, no tick yet, stale, live.
func ComputeFeedHealth(in FeedHealthInput) FeedHealth {
	stale := in.StaleAfterMs
	if stale == 0 {
		stale = 30_000
	}
	var age *int64
	if in.LastTickAt != nil {
		a := max(0, in.NowMs-*in.LastTickAt)
		age = &a
	}
	h := FeedHealth{Connected: in.Connected, Subscribed: in.Subscribed, Universe: in.Universe, FeedAgeMs: age, LastTickAt: in.LastTickAt}
	switch {
	case !in.Authenticated:
		h.State, h.Detail = FeedDown, "No broker session — connect the broker."
	case !in.Connected && in.Connecting:
		h.State, h.Detail = FeedConnecting, "Connecting to the broker feed…"
	case !in.Connected:
		h.State, h.Detail = FeedDown, "The broker feed is not connected."
	case in.Subscribed == 0:
		h.State = FeedConnectedNoSubscription
		h.Detail = "Feed connected but nothing is subscribed — open the board or start the scanner. " +
			"No prices will arrive until something asks for instruments."
	case in.LastTickAt == nil:
		h.State = FeedConnecting
		h.Detail = fmt.Sprintf("Subscribed to %d instrument(s), waiting for the first tick.", in.Subscribed)
	case *age > stale:
		h.State = FeedStale
		h.Detail = fmt.Sprintf("No tick for %.0fs across %d subscribed instrument(s).", jsx.Round(float64(*age)/1000), in.Subscribed)
	default:
		h.State = FeedLive
		h.Detail = fmt.Sprintf("%d instrument(s) subscribed, last tick %dms ago.", in.Subscribed, *age)
	}
	return h
}

// IsUsable reports whether prices can be trusted right now.
func (h FeedHealth) IsUsable() bool { return h.State == FeedLive }
