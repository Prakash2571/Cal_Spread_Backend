package analytics

import (
	"context"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

func TestDhanUnseededQuotesRemainPartialAcrossCaptures(t *testing.T) {
	clock := &testClock{}
	clock.set(istT(2026, 10, 27, 10, 5, 57))
	universe := brokerUniverse(t, brokers.Dhan)
	selection := niftyNearestExpiryOptions(universe, "2026-10-27")
	missing := selection.meta.keys[0]
	s := New(Deps{Namespace: func() brokers.Namespace { return brokers.Namespace{Broker: brokers.Dhan, Generation: 1} },
		CaptureAllowed: allow, Instruments: func(context.Context) ([]market.Instrument, error) { return universe, nil },
		QuoteFull: func(ctx context.Context, ids []string) ([]kite.FullQuote, error) {
			quotes, err := syntheticQuotes(universe, clock, nil)(ctx, ids)
			out := quotes[:0]
			for _, quote := range quotes {
				if quote.InstrumentToken != missing {
					out = append(out, quote)
				}
			}
			return out, err
		}, Now: clock.now, Sleep: func(context.Context, time.Duration) error { return nil }, Logf: t.Logf})
	s.mu.Lock()
	s.prevClose = &PrevClose{ForDay: "2026-10-27"}
	s.mu.Unlock()
	for i := 0; i < 2; i++ {
		s.captureOptionOi(context.Background())
		clock.set(clock.ms.Load() + minuteMs)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, point := range s.oiFrames[0] {
		if !point.Partial {
			t.Fatal("a never-seen option was silently carried as a known zero")
		}
	}
}
