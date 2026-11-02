package fairvalue

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// memoryStore is fixtures.mjs memoryStore().
type memoryStore struct {
	mu      sync.Mutex
	history []*model.SurfaceSnapshot
	config  any
}

func (s *memoryStore) Enabled() bool { return true }

func (s *memoryStore) LoadConfig(context.Context) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.config, nil
}

func (s *memoryStore) SaveConfig(_ context.Context, c model.Config, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.config = c.Raw.Clone()
	return nil
}

func (s *memoryStore) Append(_ context.Context, snapshot *model.SurfaceSnapshot, _ *model.InputSnapshot, limit, _ float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.history = append([]*model.SurfaceSnapshot{snapshot}, s.history...)
	s.history = s.history[:sliceEnd(len(s.history), limit)]
	return nil
}

func (s *memoryStore) History(_ context.Context, symbol string, limit float64) ([]model.HistorySummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []model.HistorySummary{}
	for _, h := range s.history {
		if h.Underlying == symbol {
			out = append(out, h.Summary())
		}
	}
	return out[:sliceEnd(len(out), limit)], nil
}

func (s *memoryStore) Snapshot(_ context.Context, symbol, id string) (*StoredSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range s.history {
		if h.Underlying == symbol && h.ID == id {
			return &StoredSnapshot{PublishedAt: h.PublishedAt, JSON: jsjson.Marshal(h)}, nil
		}
	}
	return nil, nil
}

func neverTicker(time.Duration) (<-chan time.Time, func()) { return make(chan time.Time), func() {} }

// engineFixture is pipeline.test.mjs engineFixture() and its variants.
type engineFixture struct {
	t          *testing.T
	input      *model.InputSnapshot
	engine     *Engine
	store      Store
	mu         sync.Mutex
	now        float64
	generation float64
	tokens     []int64
}

type fixtureOptions struct {
	broker          string
	metadataVersion string
	boardName       string
	workers         Workers
	store           Store
}

func newEngineFixture(t *testing.T, input *model.InputSnapshot, o fixtureOptions) *engineFixture {
	t.Helper()
	f := &engineFixture{t: t, input: input, now: fvtest.Now, generation: 1}
	if o.broker == "" {
		o.broker = "zerodha"
	}
	if o.metadataVersion == "" {
		o.metadataVersion = "test-v1"
	}
	if o.boardName == "" {
		o.boardName = "Test underlying"
	}
	if o.store == nil {
		o.store = &memoryStore{}
	}
	f.store = o.store
	cfg := input.Config
	engine, err := NewEngine(Deps{
		GetAllInstruments: func(context.Context) ([]model.Instrument, error) { return input.Instruments, nil },
		GetBoard: func(context.Context) ([]BoardItem, error) {
			return []BoardItem{{Symbol: "TEST", Name: o.boardName, SpotToken: 1}}, nil
		},
		MetadataVersion:  func() string { return o.metadataVersion },
		ActiveBroker:     func() string { return o.broker },
		BrokerGeneration: f.getGeneration,
		DataReady:        func() bool { return true },
		Switching:        func() bool { return false },
		SetTokens: func(tokens []int64) {
			f.mu.Lock()
			f.tokens = tokens
			f.mu.Unlock()
		},
		TokenBudget: func() float64 { return 600 },
		RetainFeed:  func() func() { return func() {} },
		FeedStatus:  func() any { return map[string]any{"connected": true} },
		Store:       o.store,
		Config:      &cfg,
		Now:         f.getNow,
		Workers:     o.workers,
		Ticker:      neverTicker,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.engine = engine
	t.Cleanup(engine.Dispose)
	return f
}

func (f *engineFixture) getNow() float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *engineFixture) advance(ms float64) {
	f.mu.Lock()
	f.now += ms
	f.mu.Unlock()
}

func (f *engineFixture) getGeneration() float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.generation
}

func (f *engineFixture) bump() {
	f.mu.Lock()
	f.generation++
	f.mu.Unlock()
}

func (f *engineFixture) currentTokens() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int64(nil), f.tokens...)
}

func boolPtr(b bool) *bool { return &b }

// bookTicks are the fixture quotes as full-depth ticks. lastFromMid uses (bid+ask)/2 as
// last_price (service test) instead of the bid; exchangeTs nil omits exchange_ts.
func bookTicks(quotes []model.MarketQuote, lastFromMid bool, exchangeTs *int64) []market.Tick {
	out := make([]market.Tick, 0, len(quotes))
	for _, q := range quotes {
		bid, ask := *q.Bid, *q.Ask
		last := bid
		if lastFromMid {
			last = (bid + ask) / 2
		}
		out = append(out, market.Tick{Token: int64(q.Token), LastPrice: last, Bid: bid, Ask: ask,
			Bids: []market.DepthLevel{{Price: bid, Qty: 1000, Orders: 1}}, Asks: []market.DepthLevel{{Price: ask, Qty: 1000, Orders: 1}},
			DepthUpdated: boolPtr(true), ExchangeTS: exchangeTs})
	}
	return out
}

func i64(v int64) *int64 { return &v }

// parsed is a decoded JSON response.
type parsed struct {
	status int
	header http.Header
	data   any
}

func decode(t *testing.T, res *http.Response) parsed {
	t.Helper()
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if len(raw) > 0 && (raw[0] == '{' || raw[0] == '[') {
		if v, err = jsjson.Parse(raw); err != nil {
			t.Fatalf("response is not JSON: %v\n%s", err, raw)
		}
	} else {
		v = string(raw)
	}
	return parsed{status: res.StatusCode, header: res.Header, data: v}
}

// at walks a decoded JSON value: object keys and array indexes (as ints).
func at(v any, path ...any) any {
	for _, p := range path {
		switch k := p.(type) {
		case string:
			o, ok := v.(*jsjson.Object)
			if !ok {
				return nil
			}
			v, _ = o.Get(k)
		case int:
			a, ok := v.([]any)
			if !ok || k >= len(a) {
				return nil
			}
			v = a[k]
		}
	}
	return v
}

func request(t *testing.T, method, url, token, body string) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("x-admin-token", token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}
