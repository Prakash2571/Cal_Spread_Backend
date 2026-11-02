package captures

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Test doubles shared by the capture tests: a log sink, a scripted clock, a fake Kite
// and a store wrapper that can fail writes or report "not ready".

// logSink records log lines. Error arguments are replaced by the literal "<error>", the
// same way the Node parity generator rendered Error objects.
type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *logSink) logf(format string, args ...any) {
	args = append([]any(nil), args...)
	for i, a := range args {
		if _, ok := a.(error); ok {
			args[i] = "<error>"
		}
	}
	line := fmt.Sprintf(format, args...)
	l.mu.Lock()
	l.lines = append(l.lines, line)
	l.mu.Unlock()
}

func (l *logSink) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

func (l *logSink) count(line string) int {
	n := 0
	for _, s := range l.all() {
		if s == line {
			n++
		}
	}
	return n
}

// fakeClock is a scripted clock: Now is set by the test, Sleep records the delay and
// returns at once (unless a hook blocks), and tickers are driven by hand.
type fakeClock struct {
	mu      sync.Mutex
	now     time.Time
	sleeps  []int64
	tickers []*manualTicker
	// sleepHook, when set, replaces the default Sleep (it receives every delay).
	sleepHook func(ctx context.Context, d time.Duration) error
}

func newFakeClock(now time.Time) *fakeClock { return &fakeClock{now: now} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) set(t time.Time) {
	c.mu.Lock()
	c.now = t
	c.mu.Unlock()
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	c.mu.Lock()
	hook := c.sleepHook
	c.sleeps = append(c.sleeps, d.Milliseconds())
	c.mu.Unlock()
	if hook != nil {
		return hook(ctx, d)
	}
	return ctx.Err()
}

func (c *fakeClock) recordedSleeps() []int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]int64(nil), c.sleeps...)
}

func (c *fakeClock) NewTicker(d time.Duration) Ticker {
	mt := &manualTicker{ch: make(chan time.Time, 1), period: d}
	c.mu.Lock()
	c.tickers = append(c.tickers, mt)
	c.mu.Unlock()
	return mt
}

func (c *fakeClock) allTickers() []*manualTicker {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*manualTicker(nil), c.tickers...)
}

// manualTicker delivers ticks on demand and, like time.Ticker, drops a tick when the
// receiver has not taken the previous one.
type manualTicker struct {
	ch      chan time.Time
	period  time.Duration
	mu      sync.Mutex
	stopped bool
}

func (m *manualTicker) C() <-chan time.Time { return m.ch }

func (m *manualTicker) Stop() {
	m.mu.Lock()
	m.stopped = true
	m.mu.Unlock()
}

func (m *manualTicker) isStopped() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopped
}

// tick reports whether the tick was accepted.
func (m *manualTicker) tick(t time.Time) bool {
	select {
	case m.ch <- t:
		return true
	default:
		return false
	}
}

// kiteSpec scripts a fakeKite (the "kite" block of a parity scenario).
type kiteSpec struct {
	Session    *bool                              `json:"session"`
	FailQuote  bool                               `json:"fail_quote"`
	FailTokens []int64                            `json:"fail_tokens"`
	Ohlc       map[string]kite.OhlcQuote          `json:"ohlc"`
	Full       map[string]kite.FullQuoteOhlc      `json:"full"`
	Daily      map[string][]kite.HistoricalCandle `json:"daily"`
	Hourly     map[string][]kite.ClosePoint       `json:"hourly"`
}

// fakeKite implements Kite and records every call as a generic map, the shape the Node
// generator recorded.
type fakeKite struct {
	spec kiteSpec

	mu      sync.Mutex
	session bool
	calls   []map[string]any
	// onCall, when set, runs after a call is recorded (before it answers).
	onCall func(ctx context.Context, call map[string]any) error
}

func newFakeKite(spec kiteSpec) *fakeKite {
	return &fakeKite{spec: spec, session: spec.Session == nil || *spec.Session}
}

func (k *fakeKite) setSession(v bool) {
	k.mu.Lock()
	k.session = v
	k.mu.Unlock()
}

func (k *fakeKite) HasSession() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.session
}

func (k *fakeKite) record(ctx context.Context, call map[string]any) error {
	k.mu.Lock()
	k.calls = append(k.calls, call)
	hook := k.onCall
	k.mu.Unlock()
	if hook != nil {
		return hook(ctx, call)
	}
	return nil
}

func (k *fakeKite) recorded() []map[string]any {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]map[string]any{}, k.calls...)
}

func (k *fakeKite) failsToken(token int64) bool {
	for _, t := range k.spec.FailTokens {
		if t == token {
			return true
		}
	}
	return false
}

func (k *fakeKite) GetQuoteOhlc(ctx context.Context, ids []string) ([]kite.OhlcQuote, error) {
	if err := k.record(ctx, map[string]any{"method": "getQuoteOhlc", "ids": append([]string(nil), ids...)}); err != nil {
		return nil, err
	}
	if k.spec.FailQuote {
		return nil, errors.New("kite down")
	}
	var out []kite.OhlcQuote
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if q, ok := k.spec.Ohlc[id]; ok {
			out = append(out, q)
		}
	}
	return out, nil
}

func (k *fakeKite) GetQuoteFullOhlc(ctx context.Context, ids []string) ([]kite.FullQuoteOhlc, error) {
	if err := k.record(ctx, map[string]any{"method": "getQuoteFullOhlc", "ids": append([]string(nil), ids...)}); err != nil {
		return nil, err
	}
	if k.spec.FailQuote {
		return nil, errors.New("kite down")
	}
	var out []kite.FullQuoteOhlc
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if q, ok := k.spec.Full[id]; ok {
			out = append(out, q)
		}
	}
	return out, nil
}

func (k *fakeKite) GetHistoricalFull(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.HistoricalCandle, error) {
	if err := k.record(ctx, map[string]any{
		"method": "getHistoricalFull", "token": token, "from": from, "to": to, "interval": interval, "prio": string(prio),
	}); err != nil {
		return nil, err
	}
	if k.failsToken(token) {
		return nil, errors.New("kite down")
	}
	return append([]kite.HistoricalCandle(nil), k.spec.Daily[strconv.FormatInt(token, 10)]...), nil
}

func (k *fakeKite) GetHistorical(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error) {
	if err := k.record(ctx, map[string]any{
		"method": "getHistorical", "token": token, "from": from, "to": to, "interval": interval, "prio": string(prio),
	}); err != nil {
		return nil, err
	}
	if k.failsToken(token) {
		return nil, errors.New("kite down")
	}
	return append([]kite.ClosePoint(nil), k.spec.Hourly[strconv.FormatInt(token, 10)]...), nil
}

// testStore wraps a Store: Ready can be forced to false, and writes can be made to fail
// after N further successes per model (the generator's fail_writes).
type testStore struct {
	*Store
	mu        sync.Mutex
	notReady  bool
	writes    map[string]int
	failAfter map[string]int
	// writeLog records every successful write as "<model>:<key>".
	writeLog []string
}

func newTestStore(s *Store) *testStore {
	return &testStore{Store: s, writes: map[string]int{}, failAfter: map[string]int{}}
}

func (s *testStore) setReady(v bool) {
	s.mu.Lock()
	s.notReady = !v
	s.mu.Unlock()
}

// failWritesAfter makes the model's writes fail once n more writes have succeeded;
// n < 0 clears the failure.
func (s *testStore) failWritesAfter(model string, n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n < 0 {
		delete(s.failAfter, model)
		return
	}
	s.failAfter[model] = s.writes[model] + n
}

func (s *testStore) gate(model, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit, ok := s.failAfter[model]; ok && s.writes[model] >= limit {
		return errors.New("write failed")
	}
	s.writes[model]++
	s.writeLog = append(s.writeLog, model+":"+key)
	return nil
}

func (s *testStore) writeKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.writeLog...)
}

func (s *testStore) Ready() bool {
	s.mu.Lock()
	off := s.notReady
	s.mu.Unlock()
	return !off && s.Store.Ready()
}

func (s *testStore) UpsertHourlyPrice(ctx context.Context, p HourlyPrice) error {
	if err := s.gate("hourlyprices", p.Symbol+" "+p.Date+" "+p.Time); err != nil {
		return err
	}
	return s.Store.UpsertHourlyPrice(ctx, p)
}

func (s *testStore) UpsertStockFuture(ctx context.Context, f StockFuture) error {
	if err := s.gate("stock_futures_current", f.Symbol+" "+isoDay(f.TradingDate)+" "+isoDay(f.Expiry)); err != nil {
		return err
	}
	return s.Store.UpsertStockFuture(ctx, f)
}

func (s *testStore) UpsertSpreadDaily(ctx context.Context, d SpreadDaily) error {
	if err := s.gate("spread_daily", d.Symbol+" "+isoDay(d.TradingDate)); err != nil {
		return err
	}
	return s.Store.UpsertSpreadDaily(ctx, d)
}

// Compile-time checks that the wrapper satisfies both job interfaces.
var (
	_ eodStore    = (*testStore)(nil)
	_ hourlyStore = (*testStore)(nil)
)

// istTime builds the instant of an IST wall-clock time.
func istTime(day, hhmm string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", day+" "+hhmm)
	if err != nil {
		panic(err)
	}
	return t.Add(-5*time.Hour - 30*time.Minute)
}

func inst(token int64, tradingsymbol string) market.Instrument {
	return market.Instrument{
		InstrumentToken: token, ExchangeToken: token, Tradingsymbol: tradingsymbol, Name: tradingsymbol,
		TickSize: 0.05, LotSize: 100, InstrumentType: "FUT", Segment: "NFO-FUT", Exchange: "NFO",
	}
}
