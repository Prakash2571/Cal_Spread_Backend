package fairvalue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/boundedcache"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// watchIdleMs is engine.ts WATCH_IDLE_MS: a watched underlying nobody looked at for this
// long is dropped.
const watchIdleMs = 180_000

// defaultLaneReserve is yieldToPriority's laneReserveLimit (3000 lane tokens minus a
// 200-token reserve).
const defaultLaneReserve = 2800

// BoardItem is engine.ts FairValueBoardItem.
type BoardItem struct {
	Symbol    string
	Name      string
	SpotToken float64
	IsIndex   bool
}

// Deps are engine.ts FairValueDeps.
//
// Concurrency contract: the engine calls these functions while holding its own lock (as
// the Node engine called them synchronously), so none of them may call back into the
// engine, directly or by delivering ticks synchronously, and none may wait for a
// goroutine that does. Getters should be cheap (atomics).
type Deps struct {
	GetAllInstruments func(ctx context.Context) ([]model.Instrument, error)
	GetBoard          func(ctx context.Context) ([]BoardItem, error)
	MetadataVersion   func() string
	ActiveBroker      func() string
	BrokerGeneration  func() float64
	DataReady         func() bool
	Switching         func() bool
	// ForceDisabledReason, when not empty, keeps the engine disabled with that message.
	ForceDisabledReason string
	// SetTokens declares the analytics owner's tokens on the futures/data lane.
	SetTokens func(tokens []int64)
	// TokenBudget is the headroom on that lane after all other consumers.
	TokenBudget func() float64
	// RetainFeed keeps the tick fan-out alive; the returned function releases it.
	RetainFeed func() func()
	FeedStatus func() any
	Store      Store
	// Config is the starting configuration; nil means the environment defaults.
	Config *model.Config
	// Now is epoch milliseconds; nil means the system clock.
	Now func() float64
	// Workers replaces the worker pool (tests). Like Node, a configuration change or a
	// restored configuration still replaces it with a fresh pool.
	Workers Workers
	// Ticker starts the refresh timer; nil means time.NewTicker. Tests pass one that
	// never fires.
	Ticker func(d time.Duration) (<-chan time.Time, func())
}

type watchedEntry struct {
	underlying      string
	name            string
	spotToken       float64
	touched         float64
	instruments     []model.Instrument
	universe        model.Universe
	listingCatalog  []model.OptionMetadata
	metadataVersion string
	center          *float64
}

type spotRecord struct {
	value             float64
	timestamp         string
	exchangeTimestamp *string
	receiveTimestamp  string
	freshnessBasis    string
}

type retainedPair struct {
	input   *model.InputSnapshot
	surface *model.SurfaceSnapshot
}

type historyItem struct {
	snapshot *model.SurfaceSnapshot
	input    *model.InputSnapshot
}

type flight struct {
	done chan struct{}
	err  error
}

type independentCall struct {
	done chan struct{}
	res  *model.IndependentEstimate
	err  error
}

// Engine is engine.ts FairValueEngine: universe, ticks, scheduling, publication and
// caches around the worker pool. Published snapshots and inputs are immutable: nothing
// writes to them after publication (Node deep-froze them).
type Engine struct {
	deps   Deps
	now    func() float64
	ticker func(d time.Duration) (<-chan time.Time, func())

	mu                   sync.Mutex
	config               model.Config
	version              string
	workers              Workers
	watched              *orderedMap[string, *watchedEntry]
	wanted               *tokenSet
	quotes               map[float64]model.MarketQuote
	spots                map[float64]spotRecord
	latest               *orderedMap[string, *model.SurfaceSnapshot]
	inputs               map[string]*model.InputSnapshot
	histories            *SnapshotHistory
	pending              map[string]bool
	rebuilding           *flight
	lastUniverseRefresh  float64
	updatingConfig       bool
	feedGeneration       float64
	lastBrokerGeneration float64
	quoteVersion         float64
	publicationSequence  float64
	paused               bool
	stopTimer            func()
	releaseFeed          func()
	lastError            *string
	configPersisted      bool
	persistenceError     *string
	historyQueue         []historyItem
	persisting           bool
	lastHistory          *orderedMap[string, float64]
	listeners            *orderedMap[uint64, func()]
	listenerSeq          uint64
	disposed             bool
	independentCache     *boundedcache.Cache[*model.IndependentEstimate]
	retainedInputs       *boundedcache.Cache[retainedPair]
	independentPending   map[string]*independentCall
}

func systemNow() float64 { return float64(time.Now().UnixMilli()) }

func defaultTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

// NewEngine is the FairValueEngine constructor. The configuration is validated (not
// normalised), exactly like Node.
func NewEngine(deps Deps) (*Engine, error) {
	e := &Engine{deps: deps, now: deps.Now, ticker: deps.Ticker}
	if e.now == nil {
		e.now = systemNow
	}
	if e.ticker == nil {
		e.ticker = defaultTicker
	}
	var cfg model.Config
	var err error
	if deps.Config != nil {
		cfg, err = model.DecodeConfig(deps.Config.Raw.Clone())
	} else {
		cfg, err = model.DefaultConfig(os.LookupEnv, e.now())
	}
	if err != nil {
		return nil, err
	}
	if deps.ForceDisabledReason != "" {
		cfg = cfg.WithEnabled(false)
		e.lastError = ptr(deps.ForceDisabledReason)
	}
	e.config = cfg
	e.version = cfg.Version()
	e.workers = deps.Workers
	if e.workers == nil {
		e.workers = newPoolFor(cfg)
	}
	e.watched = newOrderedMap[string, *watchedEntry]()
	e.wanted = newTokenSet()
	e.quotes = map[float64]model.MarketQuote{}
	e.spots = map[float64]spotRecord{}
	e.latest = newOrderedMap[string, *model.SurfaceSnapshot]()
	e.inputs = map[string]*model.InputSnapshot{}
	e.pending = map[string]bool{}
	e.feedGeneration = 1
	e.lastBrokerGeneration = deps.BrokerGeneration()
	e.lastHistory = newOrderedMap[string, float64]()
	e.listeners = newOrderedMap[uint64, func()]()
	e.independentPending = map[string]*independentCall{}
	e.resetCachesLocked()
	return e, nil
}

func ptr[T any](v T) *T { return &v }

func (e *Engine) timeNow() time.Time { return time.UnixMilli(int64(e.now())) }

// resetCachesLocked recreates the bounded caches and the memory history from the
// current configuration.
func (e *Engine) resetCachesLocked() {
	c := e.config
	e.independentCache = boundedcache.New[*model.IndependentEstimate](time.Duration(c.IndependentCacheTtlMs)*time.Millisecond,
		int(c.IndependentCacheLimit), e.timeNow)
	e.retainedInputs = boundedcache.New[retainedPair](time.Duration(c.SurfaceMaxAgeMs)*time.Millisecond, 8, e.timeNow)
	e.histories = NewSnapshotHistory(int(c.HistoryMemoryMaxBytes), 20, e.now)
}

// goSafe runs fn in a goroutine; an error or a panic is recorded as the last error,
// the way Node's `void promise.catch(recordFailure)` did.
func (e *Engine) goSafe(fn func() error) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[FairValue] background work failed: %v", r)
				e.recordFailure(model.AsError(r))
			}
		}()
		if err := fn(); err != nil {
			e.recordFailure(err)
		}
	}()
}

// Boot restores the saved configuration, then arms the refresh timer when enabled.
// Restore errors only set the persistence error.
func (e *Engine) Boot() {
	saved, err := e.deps.Store.LoadConfig(context.Background())
	e.mu.Lock()
	defer e.mu.Unlock()
	if err == nil && saved != nil {
		var merged model.Config
		merged, err = model.MergeConfig(e.config, saved)
		if err == nil {
			if e.deps.ForceDisabledReason != "" {
				merged = merged.WithEnabled(false)
			}
			e.config = merged
			e.version = merged.Version()
			old := e.workers
			e.workers = newPoolFor(merged)
			old.Dispose()
			e.configPersisted = true
			e.resetCachesLocked()
		}
	}
	if err != nil {
		e.persistenceError = ptr(err.Error())
	}
	if e.config.Enabled {
		e.armTimerLocked()
	}
}

// ConfigView is getConfig()'s response.
type ConfigView struct {
	Config    model.Config `json:"config"`
	Version   string       `json:"version"`
	Persisted bool         `json:"persisted"`
}

// GetConfig returns the configuration, its version and whether it is persisted.
func (e *Engine) GetConfig() ConfigView {
	e.mu.Lock()
	defer e.mu.Unlock()
	return ConfigView{Config: e.config.Clone(), Version: e.version, Persisted: e.configPersisted}
}

// UpdateResult is updateConfig()'s result.
type UpdateResult struct {
	Version   string `json:"version"`
	Persisted bool   `json:"persisted"`
}

// UpdateConfig merges, validates and applies a configuration patch (a JSON value), then
// persists it. One update at a time.
func (e *Engine) UpdateConfig(patch any) (UpdateResult, error) {
	e.mu.Lock()
	if e.updatingConfig {
		e.mu.Unlock()
		return UpdateResult{}, errors.New("A Fair Value configuration update is already in progress.")
	}
	e.updatingConfig = true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.updatingConfig = false
		e.mu.Unlock()
	}()
	return e.applyConfig(patch)
}

func (e *Engine) applyConfig(patch any) (UpdateResult, error) {
	e.mu.Lock()
	next, err := model.MergeConfig(e.config, patch)
	if err != nil {
		e.mu.Unlock()
		return UpdateResult{}, err
	}
	if next.Enabled && e.deps.ForceDisabledReason != "" {
		e.mu.Unlock()
		return UpdateResult{}, errors.New(e.deps.ForceDisabledReason)
	}
	nextVersion := next.Version()
	e.config = next
	e.version = nextVersion
	e.configPersisted = false
	e.invalidateLocked()
	old := e.workers
	e.workers = newPoolFor(next)
	old.Dispose()
	oldHistory := e.histories
	e.resetCachesLocked()
	for _, symbol := range e.lastHistory.Keys() {
		list := oldHistory.List(symbol, next.HistoryRetentionDays)
		for i := len(list) - 1; i >= 0; i-- {
			e.histories.Add(list[i], next.HistoryLimit, next.HistoryRetentionDays)
		}
	}
	e.stopTimerLocked()
	running := next.Enabled && !e.paused
	if running {
		e.armTimerLocked()
	} else {
		e.releaseSubscriptionsLocked()
	}
	e.mu.Unlock()
	if running {
		if err := e.rebuild(); err != nil {
			return UpdateResult{}, err
		}
	}
	saveErr := e.deps.Store.SaveConfig(context.Background(), next.Clone(), nextVersion)
	e.mu.Lock()
	defer e.mu.Unlock()
	if saveErr == nil {
		e.configPersisted = true
		e.persistenceError = nil
	} else {
		e.persistenceError = ptr(saveErr.Error())
	}
	e.notifyLocked()
	return UpdateResult{Version: nextVersion, Persisted: e.configPersisted}, nil
}

// Underlying is one entry of underlyings().
type Underlying struct {
	Symbol   string   `json:"symbol"`
	Name     string   `json:"name"`
	Expiries []string `json:"expiries"`
}

// istToday is the IST calendar day: new Date(now + 19800000).toISOString().slice(0, 10).
func (e *Engine) istToday() string { return model.ISOString(e.now() + 19800000)[:10] }

// Underlyings lists the board underlyings that have unexpired NFO options.
func (e *Engine) Underlyings() ([]Underlying, error) {
	generation := e.deps.BrokerGeneration()
	all, err := e.deps.GetAllInstruments(context.Background())
	if err != nil {
		return nil, err
	}
	board, err := e.deps.GetBoard(context.Background())
	if err != nil {
		return nil, err
	}
	if generation != e.deps.BrokerGeneration() || e.deps.Switching() {
		return nil, errors.New("Broker namespace changed while loading underlyings.")
	}
	today := e.istToday()
	exp := map[string]map[string]bool{}
	for _, i := range all {
		if i.Exchange == "NFO" && (i.InstrumentType == model.CE || i.InstrumentType == model.PE) && i.Expiry >= today {
			key := strings.ToUpper(i.Name)
			if exp[key] == nil {
				exp[key] = map[string]bool{}
			}
			exp[key][prefix(i.Expiry, 10)] = true
		}
	}
	out := []Underlying{}
	for _, b := range board {
		key := strings.ToUpper(b.Symbol)
		dates, ok := exp[key]
		if !ok {
			continue
		}
		expiries := make([]string, 0, len(dates))
		for d := range dates {
			expiries = append(expiries, d)
		}
		sort.Strings(expiries)
		out = append(out, Underlying{Symbol: key, Name: b.Name, Expiries: expiries})
	}
	sort.SliceStable(out, func(i, j int) bool { return jsx.LocaleCompare(out[i].Symbol, out[j].Symbol) < 0 })
	return out, nil
}

func prefix(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

var reWatchSymbol = regexp.MustCompile(`^[A-Z0-9&._-]{1,40}$`)

// Watch starts tracking an underlying (or touches it) and rebuilds the universe.
func (e *Engine) Watch(underlying string) error {
	e.mu.Lock()
	if err := e.assertAvailableLocked(); err != nil {
		e.mu.Unlock()
		return err
	}
	symbol := strings.ToUpper(kitejson.TrimJS(underlying))
	if !reWatchSymbol.MatchString(symbol) {
		e.mu.Unlock()
		return errors.New("Invalid underlying symbol.")
	}
	if w, ok := e.watched.Get(symbol); ok {
		w.touched = e.now()
		e.mu.Unlock()
		return nil
	}
	generation := e.deps.BrokerGeneration()
	e.mu.Unlock()
	items, err := e.deps.GetBoard(context.Background())
	if err != nil {
		return err
	}
	var board *BoardItem
	for i := range items {
		if strings.ToUpper(items[i].Symbol) == symbol {
			board = &items[i]
			break
		}
	}
	e.mu.Lock()
	if err := e.assertAvailableLocked(); err != nil {
		e.mu.Unlock()
		return err
	}
	if generation != e.deps.BrokerGeneration() {
		e.mu.Unlock()
		return errors.New("Broker namespace changed while selecting the underlying.")
	}
	if board == nil {
		e.mu.Unlock()
		return errors.New("Underlying is not present in the existing instrument/spot universe.")
	}
	for float64(e.watched.Len()) >= e.config.MaxUnderlyings {
		var oldest *watchedEntry
		for _, w := range e.watched.Values() {
			if oldest == nil || w.touched < oldest.touched {
				oldest = w
			}
		}
		e.watched.Delete(oldest.underlying)
		e.latest.Delete(oldest.underlying)
		delete(e.inputs, oldest.underlying)
	}
	e.watched.Set(symbol, &watchedEntry{underlying: symbol, name: board.Name, spotToken: board.SpotToken, touched: e.now(),
		instruments: []model.Instrument{}, listingCatalog: []model.OptionMetadata{}, metadataVersion: "unloaded",
		universe: model.Universe{OmittedExpiries: []string{}}})
	e.mu.Unlock()
	return e.rebuild()
}

// RefreshResult is refresh()'s result.
type RefreshResult struct {
	Snapshot *model.SurfaceSnapshot `json:"snapshot"`
	Pending  bool                   `json:"pending"`
}

// Refresh watches the underlying and captures a surface now.
func (e *Engine) Refresh(underlying string) (RefreshResult, error) {
	if err := e.Watch(underlying); err != nil {
		return RefreshResult{}, err
	}
	symbol := strings.ToUpper(underlying) // capture uses the untrimmed name, as in Node
	if err := e.capture(symbol); err != nil {
		return RefreshResult{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	snapshot, _ := e.latest.Get(symbol)
	return RefreshResult{Snapshot: snapshot, Pending: e.pending[symbol]}, nil
}

// Pause stops (true) or resumes (false) analytics. Pausing drops every quote and
// subscription; the timer keeps running and its cycles do nothing.
func (e *Engine) Pause(paused bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.paused = paused
	if paused {
		e.invalidateLocked()
		e.releaseSubscriptionsLocked()
	} else if e.config.Enabled {
		e.armTimerLocked()
		e.goSafe(e.rebuild)
	}
	e.notifyLocked()
}

func (e *Engine) assertAvailableLocked() error {
	switch {
	case !e.config.Enabled:
		return errors.New("Fair Value analytics is disabled. Enable its independent configuration switch.")
	case e.paused:
		return errors.New("Fair Value analytics is paused.")
	case e.disposed:
		return errors.New("Fair Value analytics is stopped.")
	case e.deps.ForceDisabledReason != "":
		return errors.New(e.deps.ForceDisabledReason)
	case !e.deps.DataReady() || e.deps.Switching():
		return errors.New("Current broker market data is unavailable or switching.")
	}
	return nil
}

// IngestTicks records the wanted tokens' spot prices and books, received now.
func (e *Engine) IngestTicks(ticks []market.Tick) { e.IngestTicksAt(ticks, e.now()) }

// IngestTicksAt is ingestTicks(ticks, at).
func (e *Engine) IngestTicksAt(ticks []market.Tick, at float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.config.Enabled || e.paused || e.disposed {
		return
	}
	if e.deps.BrokerGeneration() != e.lastBrokerGeneration {
		e.invalidateNamespaceLocked()
		return
	}
	for i := range ticks {
		tick := &ticks[i]
		token := float64(tick.Token)
		if !e.wanted.Has(token) {
			continue
		}
		var exchangeTimestamp *string
		if tick.ExchangeTS != nil && *tick.ExchangeTS != 0 {
			ts := *tick.ExchangeTS
			s := "invalid_exchange_timestamp"
			if ts > 0 && float64(ts) <= 8640000000000000 {
				s = model.ISOString(float64(ts))
			}
			exchangeTimestamp = &s
		}
		receiveTimestamp := model.ISOString(at)
		if isFinite(tick.LastPrice) && tick.LastPrice > 0 {
			rec := spotRecord{value: tick.LastPrice, timestamp: receiveTimestamp, exchangeTimestamp: exchangeTimestamp,
				receiveTimestamp: receiveTimestamp, freshnessBasis: "receive"}
			if exchangeTimestamp != nil {
				rec.timestamp, rec.freshnessBasis = *exchangeTimestamp, "exchange"
			}
			e.spots[token] = rec
		}
		depth := (tick.DepthUpdated != nil && *tick.DepthUpdated) || (tick.DepthUpdated == nil && (tick.Bids != nil || tick.Asks != nil))
		if !depth {
			continue // LTP packets cannot refresh a retained bid/ask book
		}
		var bid, ask *float64
		if len(tick.Bids) > 0 {
			bid = ptr(tick.Bids[0].Price)
		} else if tick.Bid == 0 {
			bid = ptr(0.0)
		}
		if len(tick.Asks) > 0 {
			ask = ptr(tick.Asks[0].Price)
		}
		bidDepth, askDepth := 0.0, 0.0
		for _, l := range tick.Bids {
			if bid != nil && l.Price == *bid {
				bidDepth += l.Qty
			}
		}
		for _, l := range tick.Asks {
			if ask != nil && l.Price == *ask {
				askDepth += l.Qty
			}
		}
		e.quoteVersion++
		e.quotes[token] = model.MarketQuote{Token: token, Bid: bid, Ask: ask, BidDepth: bidDepth, AskDepth: askDepth,
			ExchangeTimestamp: exchangeTimestamp, ReceiveTimestamp: receiveTimestamp, Source: "websocket", Version: e.quoteVersion}
	}
}

// Invalidate drops every quote, spot and published surface (a new feed generation).
func (e *Engine) Invalidate() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.invalidateLocked()
}

func (e *Engine) invalidateLocked() {
	e.feedGeneration++
	e.lastBrokerGeneration = e.deps.BrokerGeneration()
	e.quotes = map[float64]model.MarketQuote{}
	e.spots = map[float64]spotRecord{}
	e.latest.Clear()
	e.inputs = map[string]*model.InputSnapshot{}
	e.independentCache.Clear()
	e.retainedInputs.Clear()
	e.notifyLocked()
}

// InvalidateNamespace forgets every watched underlying and subscription too (broker
// switch).
func (e *Engine) InvalidateNamespace() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.invalidateNamespaceLocked()
}

func (e *Engine) invalidateNamespaceLocked() {
	e.watched.Clear()
	e.releaseSubscriptionsLocked()
	e.invalidateLocked()
}

// YieldToPriority gives low-priority capacity back before protective consumers
// subscribe (the subscription coordinator's analytics-yield handler).
func (e *Engine) YieldToPriority(priority map[int64]struct{}) {
	e.yieldToPriority(priority, defaultLaneReserve)
}

func (e *Engine) yieldToPriority(priority map[int64]struct{}, laneReserveLimit float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	inPriority := func(t float64) bool {
		if !isSafeInt(t) {
			return false
		}
		_, ok := priority[int64(t)]
		return ok
	}
	spare := math.Max(0, laneReserveLimit-float64(len(priority)))
	shared, exclusive := []float64{}, []float64{}
	for _, t := range e.wanted.Keys() {
		if inPriority(t) {
			shared = append(shared, t)
		} else {
			exclusive = append(exclusive, t)
		}
	}
	exclusive = exclusive[:sliceEnd(len(exclusive), spare)]
	next := newTokenSet(append(shared, exclusive...)...)
	if next.Len() == e.wanted.Len() {
		return
	}
	e.wanted = next
	e.pruneLocked()
	e.deps.SetTokens(int64Tokens(next.Keys()))
	e.invalidateLocked()
}

func (e *Engine) pruneLocked() {
	for t := range e.quotes {
		if !e.wanted.Has(t) {
			delete(e.quotes, t)
		}
	}
	for t := range e.spots {
		if !e.wanted.Has(t) {
			delete(e.spots, t)
		}
	}
}

func isSafeInt(x float64) bool {
	return isFinite(x) && math.Trunc(x) == x && math.Abs(x) <= 9007199254740991
}

func int64Tokens(tokens []float64) []int64 {
	out := make([]int64, 0, len(tokens))
	for _, t := range tokens {
		if isSafeInt(t) {
			out = append(out, int64(t))
		}
	}
	return out
}

// sliceEnd is the end index of array.slice(0, end) for an array of length n.
func sliceEnd(n int, end float64) int {
	if math.IsNaN(end) {
		return 0
	}
	x := math.Trunc(end)
	if x < 0 {
		x = math.Max(float64(n)+x, 0)
	}
	return int(math.Min(x, float64(n)))
}

func (e *Engine) armTimerLocked() {
	if e.stopTimer != nil || e.disposed {
		return
	}
	ch, stop := e.ticker(time.Duration(e.config.RefreshMs) * time.Millisecond)
	quit := make(chan struct{})
	e.stopTimer = func() {
		close(quit)
		stop()
	}
	go func() {
		for {
			select {
			case <-quit:
				return
			case <-ch:
				e.goSafe(e.cycle)
			}
		}
	}()
}

func (e *Engine) stopTimerLocked() {
	if e.stopTimer != nil {
		e.stopTimer()
		e.stopTimer = nil
	}
}

// cycle is one refresh-timer tick: drop idle underlyings, rebuild the universe when
// due, persist history and capture every watched underlying that is not in flight.
func (e *Engine) cycle() error {
	e.mu.Lock()
	if !e.config.Enabled || e.paused || e.disposed {
		e.mu.Unlock()
		return nil
	}
	if e.lastBrokerGeneration != e.deps.BrokerGeneration() {
		e.invalidateNamespaceLocked()
	}
	if !e.deps.DataReady() || e.deps.Switching() {
		e.mu.Unlock()
		return nil
	}
	changed := false
	for _, symbol := range e.watched.Keys() {
		w, _ := e.watched.Get(symbol)
		if e.now()-w.touched > watchIdleMs {
			e.watched.Delete(symbol)
			e.latest.Delete(symbol)
			delete(e.inputs, symbol)
			changed = true
		}
	}
	freshSpotMoved := false
	for _, w := range e.watched.Values() {
		spot, ok := e.spots[w.spotToken]
		if ok && e.now()-model.DateParse(spot.timestamp) <= e.config.Quote.MaxAgeMs &&
			(w.center == nil || math.Abs(jsmath.Log(spot.value / *w.center)) > e.config.RecenterLogDistance) {
			freshSpotMoved = true
			break
		}
	}
	due := e.now()-e.lastUniverseRefresh >= e.config.UniverseRefreshMs
	rebuild := changed || float64(e.wanted.Len()) > e.deps.TokenBudget() || due ||
		(freshSpotMoved && e.now()-e.lastUniverseRefresh >= 15000)
	e.mu.Unlock()
	if rebuild {
		if err := e.rebuild(); err != nil {
			return err
		}
	}
	e.mu.Lock()
	if len(e.historyQueue) > 0 {
		go e.drainHistory()
	}
	symbols := []string{}
	for _, s := range e.watched.Keys() {
		if !e.pending[s] {
			symbols = append(symbols, s)
		}
	}
	e.mu.Unlock()
	for _, s := range symbols {
		symbol := s
		e.goSafe(func() error { return e.capture(symbol) })
	}
	return nil
}

// rebuild is single-flight: concurrent callers share one universe rebuild.
func (e *Engine) rebuild() error {
	e.mu.Lock()
	if f := e.rebuilding; f != nil {
		e.mu.Unlock()
		<-f.done
		return f.err
	}
	f := &flight{done: make(chan struct{})}
	e.rebuilding = f
	e.mu.Unlock()
	func() {
		defer func() {
			if r := recover(); r != nil {
				f.err = model.AsError(r)
			}
		}()
		f.err = e.rebuildNow()
	}()
	e.mu.Lock()
	e.rebuilding = nil
	e.mu.Unlock()
	close(f.done)
	return f.err
}

func (e *Engine) rebuildNow() error {
	e.mu.Lock()
	if !e.config.Enabled || e.paused || e.deps.Switching() {
		e.mu.Unlock()
		return nil
	}
	generation := e.deps.BrokerGeneration()
	version := e.version
	e.mu.Unlock()
	all, err := e.deps.GetAllInstruments(context.Background())
	if err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if generation != e.deps.BrokerGeneration() || e.deps.Switching() || e.paused || e.disposed ||
		!e.config.Enabled || e.version != version {
		return nil
	}
	c := e.config
	tokens := []float64{}
	metadataVersion := e.deps.MetadataVersion()
	budget := math.Max(0, math.Min(c.MaxTokens, e.deps.TokenBudget()))
	perUnderlying := math.Floor(budget / math.Max(1, float64(e.watched.Len())))
	today := e.istToday()
	for _, w := range e.watched.Values() {
		chain := []model.Instrument{}
		listing := []model.Instrument{}
		for _, i := range all {
			if i.Exchange == "NFO" && strings.ToUpper(i.Name) == w.underlying && (i.InstrumentType == model.CE || i.InstrumentType == model.PE) {
				listing = append(listing, i)
				if i.Expiry >= today {
					chain = append(chain, i)
				}
			}
		}
		seen := map[string]bool{}
		expiries := []string{}
		for _, i := range chain {
			if d := prefix(i.Expiry, 10); !seen[d] {
				seen[d] = true
				expiries = append(expiries, d)
			}
		}
		sort.Strings(expiries)
		supported := expiries[:sliceEnd(len(expiries), c.MaxExpiries)]
		isSupported := map[string]bool{}
		for _, d := range supported {
			isSupported[d] = true
		}
		futureContracts := []model.Instrument{}
		for _, i := range all {
			if strings.ToUpper(i.Name) == w.underlying && i.Exchange == "NFO" && i.InstrumentType == "FUT" && isSupported[prefix(i.Expiry, 10)] {
				futureContracts = append(futureContracts, i)
			}
		}
		var spot *float64
		if s, ok := e.spots[w.spotToken]; ok {
			if ts := model.DateParse(s.timestamp); isFinite(ts) && e.now()-ts <= c.Quote.MaxAgeMs {
				spot = ptr(s.value)
			}
		}
		w.center = spot
		if len(listing) > 20000 {
			return errors.New("Underlying listing catalog exceeds the bounded metadata budget.")
		}
		catalog := []model.OptionMetadata{}
		for _, i := range listing {
			if r := model.ResolveOptionMetadata(i, c.ExpiryPolicy, metadataVersion); r.OK {
				catalog = append(catalog, r.Metadata)
			}
		}
		w.listingCatalog = catalog
		w.metadataVersion = metadataVersion
		maxOptions := math.Max(0, perUnderlying-1-float64(len(futureContracts)))
		eachExpiry := math.Floor(maxOptions / math.Max(1, float64(len(supported))))
		selected := []model.Instrument{}
		for _, expiry := range supported {
			eligible := []model.Instrument{}
			for _, i := range chain {
				if prefix(i.Expiry, 10) == expiry {
					eligible = append(eligible, i)
				}
			}
			strikeSeen := map[float64]bool{}
			strikes := []float64{}
			for _, i := range eligible {
				if !strikeSeen[i.Strike] {
					strikeSeen[i.Strike] = true
					strikes = append(strikes, i.Strike)
				}
			}
			sort.SliceStable(strikes, func(a, b int) bool { return strikes[a] < strikes[b] })
			center := 0.0
			if spot != nil {
				center = *spot
			} else if len(strikes) > 0 {
				center = strikes[len(strikes)/2]
			}
			closest := append([]float64(nil), strikes...)
			sort.SliceStable(closest, func(a, b int) bool {
				da, db := math.Abs(closest[a]-center), math.Abs(closest[b]-center)
				if da != db {
					return da < db
				}
				return closest[a] < closest[b]
			})
			closest = closest[:sliceEnd(len(closest), math.Floor(eachExpiry/2))]
			keep := map[float64]bool{}
			for _, s := range closest {
				keep[s] = true
			}
			for _, i := range eligible {
				if keep[i.Strike] {
					selected = append(selected, i)
				}
			}
		}
		w.instruments = selected
		omitted := []string{}
		for _, d := range expiries {
			if !isSupported[d] {
				omitted = append(omitted, d)
			}
		}
		w.universe = model.Universe{ListedContracts: float64(len(chain)), CapturedContracts: float64(len(selected)),
			OmittedExpiries: omitted, Bounded: len(selected) < len(chain)}
		if perUnderlying > 0 {
			tokens = append(tokens, w.spotToken)
			for _, f := range futureContracts {
				tokens = append(tokens, f.InstrumentToken)
			}
			for _, i := range selected {
				tokens = append(tokens, i.InstrumentToken)
			}
		}
	}
	next := newTokenSet(tokens[:sliceEnd(len(tokens), budget)]...)
	e.wanted = next
	e.pruneLocked()
	e.lastUniverseRefresh = e.now()
	e.deps.SetTokens(int64Tokens(next.Keys()))
	if next.Len() > 0 && e.releaseFeed == nil {
		e.releaseFeed = e.deps.RetainFeed()
	}
	if next.Len() == 0 {
		e.releaseSubscriptionsLocked()
	}
	return nil
}

func randomID8() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// capture builds an input snapshot for a watched underlying, runs the surface job and
// publishes the result unless anything it depended on changed meanwhile.
func (e *Engine) capture(symbol string) error {
	e.mu.Lock()
	if e.pending[symbol] {
		e.mu.Unlock()
		return nil
	}
	if err := e.assertAvailableLocked(); err != nil {
		e.mu.Unlock()
		return err
	}
	w, ok := e.watched.Get(symbol)
	if !ok {
		e.mu.Unlock()
		return nil
	}
	brokerGeneration := e.deps.BrokerGeneration()
	feedGeneration := e.feedGeneration
	version := e.version
	e.mu.Unlock()
	all, err := e.deps.GetAllInstruments(context.Background())
	if err != nil {
		return err
	}
	e.mu.Lock()
	if e.pending[symbol] || brokerGeneration != e.deps.BrokerGeneration() || e.deps.Switching() || version != e.version ||
		feedGeneration != e.feedGeneration || e.paused || !e.config.Enabled {
		e.mu.Unlock()
		return nil
	}
	c := e.config
	now := e.now()
	futures := []model.Future{}
	for _, i := range all {
		if i.Exchange != "NFO" || i.InstrumentType != "FUT" || strings.ToUpper(i.Name) != symbol || !e.wanted.Has(i.InstrumentToken) ||
			!isSafeInt(i.LotSize) || i.LotSize <= 0 || !isFinite(i.TickSize) || i.TickSize <= 0 {
			continue
		}
		quote, hasQuote := e.quotes[i.InstrumentToken]
		var exact string
		policy := c.ExpiryPolicy
		switch {
		case i.ExpiryTimestamp != nil:
			exact = *i.ExpiryTimestamp
		case policy != nil && hasOverride(policy, i.Tradingsymbol):
			exact = policy.Overrides[i.Tradingsymbol]
		case policy != nil:
			exact = prefix(i.Expiry, 10) + "T" + policy.LocalTime + "+05:30"
		default:
			exact = i.Expiry
		}
		timestamp, okTS := model.UTCTimestamp(exact)
		if hasQuote && okTS {
			futures = append(futures, model.Future{ExpiryTimestamp: timestamp, Quote: quote, TickSize: i.TickSize})
		}
	}
	var spot *model.Spot
	var provenance *model.SpotProvenance
	if s, ok := e.spots[w.spotToken]; ok {
		age := now - model.DateParse(s.timestamp)
		if isFinite(age) && age >= -c.Quote.FutureTimestampToleranceMs && age <= c.Quote.MaxAgeMs &&
			now-model.DateParse(s.receiveTimestamp) <= c.Quote.MaxAgeMs {
			provenance = &model.SpotProvenance{ExchangeTimestamp: s.exchangeTimestamp, ReceiveTimestamp: s.receiveTimestamp, FreshnessBasis: s.freshnessBasis}
			spot = &model.Spot{Value: s.value, Timestamp: s.timestamp, Provenance: provenance}
		}
	}
	quotes := []model.MarketQuote{}
	for _, i := range w.instruments {
		if q, ok := e.quotes[i.InstrumentToken]; ok {
			quotes = append(quotes, q)
		}
	}
	input := &model.InputSnapshot{Underlying: symbol, Name: w.name, Broker: e.deps.ActiveBroker(), BrokerGeneration: brokerGeneration,
		FeedGeneration: feedGeneration, ValuationTime: model.ISOString(now), MetadataVersion: w.metadataVersion,
		Instruments: append([]model.Instrument{}, w.instruments...), Quotes: quotes, Spot: spot, Futures: futures,
		Config: c, ConfigVersion: version,
		Universe:       model.Universe{ListedContracts: w.universe.ListedContracts, CapturedContracts: w.universe.CapturedContracts, OmittedExpiries: append([]string{}, w.universe.OmittedExpiries...), Bounded: w.universe.Bounded},
		SpotProvenance: provenance, HasSpotProvenance: true}
	input.ID = input.HashID()
	input.ListingCatalog, input.HasListingCatalog = w.listingCatalog, true
	e.pending[symbol] = true
	workers := e.workers
	e.mu.Unlock()

	result, err := workers.Surface(input)

	e.mu.Lock()
	defer e.mu.Unlock()
	defer delete(e.pending, symbol)
	if err == nil && (result.InputSnapshotID != input.ID || result.ConfigVersion != version || result.BrokerGeneration != brokerGeneration ||
		result.FeedGeneration != feedGeneration) {
		err = errors.New("Analytics worker returned an inconsistent snapshot identity.")
	}
	if err != nil {
		e.recordFailureLocked(err)
		return nil
	}
	current, _ := e.watched.Get(symbol)
	if e.disposed || e.paused || !e.config.Enabled || e.version != version || e.feedGeneration != feedGeneration ||
		e.deps.BrokerGeneration() != brokerGeneration || e.deps.Switching() || current != w || e.deps.MetadataVersion() != input.MetadataVersion {
		return nil
	}
	e.publicationSequence++
	result.Sequence = e.publicationSequence
	result.ID = input.ID + "-" + jsjson.FormatNumber(result.Sequence) + "-" + randomID8()
	result.PublishedAt = model.ISOString(e.now())
	e.latest.Set(symbol, result)
	e.inputs[symbol] = input
	e.retainedInputs.Set(input.ID, retainedPair{input: input, surface: result})
	e.lastError = nil
	e.recordHistoryLocked(result, input)
	e.notifyLocked()
	return nil
}

func hasOverride(p *model.ExpiryPolicy, symbol string) bool {
	_, ok := p.Overrides[symbol]
	return ok
}

func (e *Engine) recordHistoryLocked(snapshot *model.SurfaceSnapshot, input *model.InputSnapshot) {
	now := e.now()
	last, _ := e.lastHistory.Get(snapshot.Underlying)
	if now-last < e.config.HistoryIntervalMs {
		return
	}
	e.lastHistory.Set(snapshot.Underlying, now)
	for e.lastHistory.Len() > 20 {
		e.lastHistory.Delete(e.lastHistory.Keys()[0])
	}
	e.histories.Add(snapshot, e.config.HistoryLimit, e.config.HistoryRetentionDays)
	if e.deps.Store.Enabled() {
		e.historyQueue = append(e.historyQueue, historyItem{snapshot: snapshot, input: input})
		if float64(len(e.historyQueue)) > e.config.MaxQueue {
			e.historyQueue = e.historyQueue[1:]
			e.persistenceError = ptr("History persistence queue full; oldest pending analytics snapshot omitted.")
		}
		go e.drainHistory()
	}
}

// drainHistory persists queued history in order; a failure puts the item back at the
// head and stops (retried on the next cycle, never a hot failure loop).
func (e *Engine) drainHistory() {
	e.mu.Lock()
	if e.persisting {
		e.mu.Unlock()
		return
	}
	e.persisting = true
	for len(e.historyQueue) > 0 && !e.disposed {
		item := e.historyQueue[0]
		e.historyQueue = e.historyQueue[1:]
		limit, retention := e.config.HistoryLimit, e.config.HistoryRetentionDays
		e.mu.Unlock()
		err := e.deps.Store.Append(context.Background(), item.snapshot, item.input, limit, retention)
		e.mu.Lock()
		if err != nil {
			e.persistenceError = ptr(err.Error())
			e.historyQueue = append([]historyItem{item}, e.historyQueue...)
			break
		}
		e.persistenceError = nil
	}
	e.persisting = false
	e.mu.Unlock()
}

// SnapshotView is getSnapshot()'s result.
type SnapshotView struct {
	Snapshot     *model.SurfaceSnapshot `json:"snapshot"`
	SurfaceAgeMs *float64               `json:"surface_age_ms"`
	Stale        bool                   `json:"stale"`
	Status       StatusView             `json:"status"`
}

// GetSnapshot returns the latest surface of an underlying (touching it) with its age.
func (e *Engine) GetSnapshot(underlying string) SnapshotView {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.deps.BrokerGeneration() != e.lastBrokerGeneration {
		e.invalidateNamespaceLocked()
	}
	symbol := strings.ToUpper(underlying)
	if w, ok := e.watched.Get(symbol); ok {
		w.touched = e.now()
	}
	snapshot, _ := e.latest.Get(symbol)
	var age *float64
	if snapshot != nil {
		age = ptr(e.now() - model.DateParse(snapshot.ValuationTime))
	}
	return SnapshotView{Snapshot: snapshot, SurfaceAgeMs: age, Stale: age != nil && *age > e.config.SurfaceMaxAgeMs, Status: e.statusLocked()}
}

// GetInput returns the input of the latest surface, or nil.
func (e *Engine) GetInput(symbol string) *model.InputSnapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.inputs[strings.ToUpper(symbol)]
}

func (e *Engine) currentInputsLocked(symbol string, snapshotID *string) (*model.InputSnapshot, *model.SurfaceSnapshot, error) {
	if err := e.assertAvailableLocked(); err != nil {
		return nil, nil, err
	}
	hasID := snapshotID != nil && *snapshotID != ""
	var input *model.InputSnapshot
	var surface *model.SurfaceSnapshot
	if r, ok := e.retainedLocked(hasID, snapshotID); ok {
		input, surface = r.input, r.surface
	} else {
		input = e.inputs[symbol]
		surface, _ = e.latest.Get(symbol)
	}
	if input == nil || surface == nil {
		return nil, nil, errors.New("No published input/surface snapshot for the requested underlying.")
	}
	if input.Underlying != symbol || (hasID && input.ID != *snapshotID) {
		return nil, nil, errors.New("Input snapshot is no longer retained; refresh the chain.")
	}
	if e.now()-model.DateParse(input.ValuationTime) > e.config.SurfaceMaxAgeMs || input.BrokerGeneration != e.deps.BrokerGeneration() ||
		input.FeedGeneration != e.feedGeneration || input.ConfigVersion != e.version {
		return nil, nil, errors.New("Surface is stale or its broker/feed/configuration changed; refresh first.")
	}
	return input, surface, nil
}

func (e *Engine) retainedLocked(hasID bool, id *string) (retainedPair, bool) {
	if !hasID {
		return retainedPair{}, false
	}
	return e.retainedInputs.Get(*id)
}

// Calculate values a listed or hypothetical contract from the current surface.
func (e *Engine) Calculate(value any) (*model.CalculatorResult, error) {
	request, err := model.ValidateCalculatorRequest(value)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	if model.DateParse(request.ExpiryTimestamp) <= e.now() {
		e.mu.Unlock()
		return nil, errors.New("Calculator requires a future expiry timestamp.")
	}
	input, surface, err := e.currentInputsLocked(request.Underlying, request.InputSnapshotID)
	if err != nil {
		e.mu.Unlock()
		return nil, err
	}
	requested := []model.OptionMetadata{}
	for _, m := range input.ListingCatalog {
		if m.Strike == request.Strike && m.Side == request.Side && m.ExpiryTimestamp == request.ExpiryTimestamp {
			requested = append(requested, m)
		}
	}
	payload := *input
	payload.ListingCatalog, payload.HasListingCatalog = requested, true
	workers := e.workers
	e.mu.Unlock()
	result, err := workers.Calculate(&payload, surface, request)
	if err != nil {
		return nil, err
	}
	if result.InputSnapshotID != input.ID || result.ConfigVersion != input.ConfigVersion {
		return nil, errors.New("Calculator worker returned inconsistent snapshot identity.")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, _, err := e.currentInputsLocked(request.Underlying, &input.ID); err != nil {
		return nil, err
	}
	if input.ConfigVersion != e.version || input.FeedGeneration != e.feedGeneration || input.BrokerGeneration != e.deps.BrokerGeneration() {
		return nil, errors.New("Calculator snapshot was invalidated while computing.")
	}
	if model.DateParse(request.ExpiryTimestamp) <= e.now() {
		return nil, errors.New("Requested contract expired during calculation.")
	}
	return result, nil
}

// Independent runs (or returns the cached / in-flight) leave-one-strike-out estimate.
func (e *Engine) Independent(value any) (*model.IndependentEstimate, error) {
	r, err := model.ValidateIndependentRequest(value)
	if err != nil {
		return nil, err
	}
	symbol := strings.ToUpper(r.Underlying)
	e.mu.Lock()
	input, surface, err := e.currentInputsLocked(symbol, &r.InputSnapshotID)
	if err != nil {
		e.mu.Unlock()
		return nil, err
	}
	if input.ID != r.InputSnapshotID {
		e.mu.Unlock()
		return nil, errors.New("Input snapshot changed; select a target from the current chain.")
	}
	var targetExpiry *string
	for i := range surface.Slices {
		if surface.Slices[i].Expiry == r.Expiry {
			targetExpiry = surface.Slices[i].ExpiryTimestamp
			break
		}
	}
	if targetExpiry == nil || model.DateParse(*targetExpiry) <= e.now() {
		e.mu.Unlock()
		return nil, errors.New("Independent estimate requires a verified unexpired listed expiry.")
	}
	key := input.ID + ":" + r.Expiry + ":" + jsjson.FormatNumber(r.Strike) + ":" + model.ModelVersion + ":" + input.ConfigVersion
	if cached, ok := e.independentCache.Get(key); ok {
		e.mu.Unlock()
		return cached, nil
	}
	if call, ok := e.independentPending[key]; ok {
		e.mu.Unlock()
		<-call.done
		return call.res, call.err
	}
	if float64(len(e.independentPending)) >= e.config.MaxQueue {
		e.mu.Unlock()
		return nil, errors.New("Independent-estimate resource budget exceeded.")
	}
	call := &independentCall{done: make(chan struct{})}
	e.independentPending[key] = call
	workers := e.workers
	calibrationInput := input.WithoutListingCatalog()
	e.mu.Unlock()

	result, err := workers.Independent(&calibrationInput, r.Expiry, r.Strike)

	e.mu.Lock()
	if err == nil {
		switch {
		case result.InputSnapshotID != input.ID || result.ConfigVersion != input.ConfigVersion || result.Strike != r.Strike || result.Expiry != r.Expiry:
			err = errors.New("Independent worker returned inconsistent snapshot identity.")
		default:
			if _, _, cerr := e.currentInputsLocked(symbol, &input.ID); cerr != nil {
				err = cerr
			} else if input.ConfigVersion != e.version || input.FeedGeneration != e.feedGeneration || input.BrokerGeneration != e.deps.BrokerGeneration() {
				err = errors.New("Independent estimate was invalidated while refitting.")
			} else if model.DateParse(*targetExpiry) <= e.now() {
				err = errors.New("Target contract expired during the independent refit.")
			} else {
				e.independentCache.Set(key, result)
			}
		}
	}
	if err != nil {
		result = nil
	}
	delete(e.independentPending, key)
	e.mu.Unlock()
	call.res, call.err = result, err
	close(call.done)
	return result, err
}

// History merges the memory and durable history summaries of an underlying, newest
// first, within retention.
func (e *Engine) History(underlying string, limit float64) ([]model.HistorySummary, error) {
	symbol := strings.ToUpper(underlying)
	e.mu.Lock()
	memorySnapshots := e.histories.List(symbol, e.config.HistoryRetentionDays)
	historyLimit := e.config.HistoryLimit
	e.mu.Unlock()
	memory := make([]model.HistorySummary, len(memorySnapshots))
	for i, s := range memorySnapshots {
		memory[i] = s.Summary()
	}
	durable, err := e.deps.Store.History(context.Background(), symbol, math.Min(limit, historyLimit))
	e.mu.Lock()
	if err != nil {
		e.persistenceError = ptr(err.Error())
		durable = nil
	}
	cutoff := e.now() - e.config.HistoryRetentionDays*86400000
	historyLimit = e.config.HistoryLimit
	e.mu.Unlock()
	merged := newOrderedMap[string, model.HistorySummary]()
	for _, s := range durable {
		merged.Set(s.ID, s)
	}
	for _, s := range memory {
		merged.Set(s.ID, s)
	}
	out := []model.HistorySummary{}
	for _, s := range merged.Values() {
		if model.DateParse(s.PublishedAt) >= cutoff {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return jsx.LocaleCompare(out[j].PublishedAt, out[i].PublishedAt) < 0 })
	return out[:sliceEnd(len(out), math.Min(math.Floor(limit), historyLimit))], nil
}

// HistoricalSnapshot returns a retained snapshot (memory first, then the store) or nil.
func (e *Engine) HistoricalSnapshot(underlying, id string) (any, error) {
	symbol := strings.ToUpper(underlying)
	e.mu.Lock()
	memory := e.histories.Get(symbol, id, e.config.HistoryRetentionDays)
	e.mu.Unlock()
	var publishedAt string
	var snapshot any
	if memory != nil {
		snapshot, publishedAt = memory, memory.PublishedAt
	} else {
		stored, err := e.deps.Store.Snapshot(context.Background(), symbol, id)
		if err != nil {
			return nil, err
		}
		if stored == nil {
			return nil, nil
		}
		snapshot, publishedAt = stored, stored.PublishedAt
	}
	e.mu.Lock()
	cutoff := e.now() - e.config.HistoryRetentionDays*86400000
	e.mu.Unlock()
	if model.DateParse(publishedAt) >= cutoff {
		return snapshot, nil
	}
	return nil, nil
}

// SurfaceStatus is one published surface in status().
type SurfaceStatus struct {
	Underlying    string  `json:"underlying"`
	ID            string  `json:"id"`
	Sequence      float64 `json:"sequence"`
	AgeMs         float64 `json:"age_ms"`
	ValidExpiries float64 `json:"valid_expiries"`
}

// StatusView is status()'s response.
type StatusView struct {
	Enabled                bool            `json:"enabled"`
	Paused                 bool            `json:"paused"`
	ModelVersion           string          `json:"model_version"`
	ConfigVersion          string          `json:"config_version"`
	ForceDisabledReason    *string         `json:"force_disabled_reason"`
	SurfaceMaxAgeMs        float64         `json:"surface_max_age_ms"`
	ConfigPersisted        bool            `json:"config_persisted"`
	ExpiryPolicyConfigured bool            `json:"expiry_policy_configured"`
	CurveConfigured        bool            `json:"curve_configured"`
	Broker                 string          `json:"broker"`
	BrokerGeneration       float64         `json:"broker_generation"`
	FeedGeneration         float64         `json:"feed_generation"`
	Feed                   any             `json:"feed"`
	DataReady              bool            `json:"data_ready"`
	SubscribedTokens       float64         `json:"subscribed_tokens"`
	WatchedUnderlyings     []string        `json:"watched_underlyings"`
	Workers                WorkerStats     `json:"workers"`
	LastError              *string         `json:"last_error"`
	Storage                string          `json:"storage"`
	PersistenceError       *string         `json:"persistence_error"`
	HistoryMemory          HistoryStats    `json:"history_memory"`
	Surfaces               []SurfaceStatus `json:"surfaces"`
}

// Status reports the engine state.
func (e *Engine) Status() StatusView {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.statusLocked()
}

func (e *Engine) statusLocked() StatusView {
	if e.deps.BrokerGeneration() != e.lastBrokerGeneration {
		e.invalidateNamespaceLocked()
	}
	c := e.config
	var reason *string
	if e.deps.ForceDisabledReason != "" {
		reason = ptr(e.deps.ForceDisabledReason)
	}
	storage := "memory_only"
	if e.deps.Store.Enabled() {
		storage = "postgres"
	}
	surfaces := []SurfaceStatus{}
	for _, s := range e.latest.Values() {
		valid := 0
		for _, slice := range s.Slices {
			if slice.Smile.Valid {
				valid++
			}
		}
		surfaces = append(surfaces, SurfaceStatus{Underlying: s.Underlying, ID: s.ID, Sequence: s.Sequence,
			AgeMs: e.now() - model.DateParse(s.ValuationTime), ValidExpiries: float64(valid)})
	}
	var feed any
	if e.deps.FeedStatus != nil {
		feed = e.deps.FeedStatus()
	}
	return StatusView{
		Enabled: c.Enabled, Paused: e.paused, ModelVersion: model.ModelVersion, ConfigVersion: e.version,
		ForceDisabledReason: reason, SurfaceMaxAgeMs: c.SurfaceMaxAgeMs, ConfigPersisted: e.configPersisted,
		ExpiryPolicyConfigured: c.ExpiryPolicy != nil,
		CurveConfigured:        len(c.Curve.Nodes) > 0 || (c.Curve.FlatRate != nil && c.Curve.AllowFlatFallback),
		Broker:                 e.deps.ActiveBroker(), BrokerGeneration: e.deps.BrokerGeneration(), FeedGeneration: e.feedGeneration,
		Feed: feed, DataReady: e.deps.DataReady(), SubscribedTokens: float64(e.wanted.Len()),
		WatchedUnderlyings: e.watched.Keys(), Workers: e.workers.Stats(), LastError: e.lastError, Storage: storage,
		PersistenceError: e.persistenceError, HistoryMemory: e.histories.Stats(), Surfaces: surfaces,
	}
}

var errSubscriptionLimit = errors.New("Fair Value subscription limit reached.")

// Subscribe registers a change listener (at most 20). Listeners run under the engine's
// lock: they must only record that something changed (the SSE route sets a flag).
func (e *Engine) Subscribe(listener func()) (func(), error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.listeners.Len() >= 20 {
		return nil, errSubscriptionLimit
	}
	e.listenerSeq++
	id := e.listenerSeq
	e.listeners.Set(id, listener)
	return func() {
		e.mu.Lock()
		e.listeners.Delete(id)
		e.mu.Unlock()
	}, nil
}

func (e *Engine) notifyLocked() {
	for _, fn := range e.listeners.Values() {
		func() {
			defer func() { _ = recover() }() // a downstream failure stays isolated
			fn()
		}()
	}
}

func (e *Engine) recordFailure(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.recordFailureLocked(err)
}

func (e *Engine) recordFailureLocked(err error) {
	e.lastError = ptr(err.Error())
	e.notifyLocked()
}

func (e *Engine) releaseSubscriptionsLocked() {
	e.deps.SetTokens([]int64{})
	e.wanted = newTokenSet()
	e.quotes = map[float64]model.MarketQuote{}
	e.spots = map[float64]spotRecord{}
	if e.releaseFeed != nil {
		e.releaseFeed()
		e.releaseFeed = nil
	}
}

// Dispose stops the timer, releases every subscription and stops the workers.
func (e *Engine) Dispose() {
	e.mu.Lock()
	e.disposed = true
	e.stopTimerLocked()
	e.releaseSubscriptionsLocked()
	e.listeners.Clear()
	workers := e.workers
	e.mu.Unlock()
	workers.Dispose()
}
