package synthetic

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/quotes"
)

// The SyntheticEngine (src/synthetic/engine.ts): one loop drives discovery (windows,
// opportunities, automatic entries, only while RUN is on) and the monitoring of open
// paper positions (marks, exit rules, expiry settlement), from Boot onwards.
//
// Market data: tokens are declared on the dedicated second lane (the "Box lane") under
// this scanner's own owner. The budget is SYNTH_MAX_TOKENS, plus, while the lane's
// other user is idle, the part of its budget it is not holding. YieldToBox lets that
// user take priority synchronously. Books live in this engine's OWN quote store.
//
// Concurrency: Node ran all of this on one event loop, where the awaits were the only
// interleaving points. Here one mutex (mu) guards all state. It is never held across a
// call that was an await in the TypeScript (store, REST quotes, instrument dump, board,
// basket margin, sleeps, waits for a refresh, a close or a settings turn), and state is
// re-checked after those calls exactly where the TypeScript re-checks it. The
// synchronous prefix of every TypeScript async function (the code before its first
// await) runs inside the caller's critical section, so its state changes are seen at
// once, as in Node.
//
// Side effects a critical section produces are queued, not performed: SetTokens calls
// and background work (Node's un-awaited promises). Engine.unlock runs them in order,
// with mu released, so a dependency may call back into the engine synchronously (OnTicks,
// InvalidateBooks, InvalidateNamespace, Stop, YieldToBox, Publish) without deadlocking,
// and the lane still receives the token sets in the order they were computed.
// Background work runs through e.rt (runtime.go), which the parity tests replace with a
// deterministic scheduler.
//
// Dependencies called WITH mu held are the cheap getters only: IsMarketOpen, IstDayKey,
// MakeIDResolver, GetRfPct, ActiveBroker, Switching, BrokerGeneration, BoxLane, Now,
// MarketData.IsAuthenticated, Store.Enabled and Store.NewID. They must not call back
// into the engine.

// BoxLaneUsage is how the lane's other user (Box in Node) is using the shared lane.
type BoxLaneUsage struct {
	Running    bool    // its scanner is running: it may grow to its full budget
	HeldTokens float64 // tokens it holds on the lane now
	Budget     float64 // its own budget on this lane (0 when it is not on the lane)
}

// IdleBoxLane is the production BoxLane dependency now that Box is gone: never running,
// holding no tokens, with the budget Node computed for an idle Box:
// BOX_DEDICATED_MARKET_FEED (default true) ? BOX_MAX_SUBSCRIBED_TOKENS (default 2200) : 0.
func IdleBoxLane(get config.Getter) func() BoxLaneUsage {
	budget := 0.0
	if config.Bool(get, "BOX_DEDICATED_MARKET_FEED", true) {
		budget = 2200
		if v, ok := config.NumAny(get, "BOX_MAX_SUBSCRIBED_TOKENS"); ok { // Box's num(): any finite value
			budget = v
		}
	}
	usage := BoxLaneUsage{Budget: budget}
	return func() BoxLaneUsage { return usage }
}

// IDResolver is index.ts makeIdResolver: token → "EXCHANGE:TRADINGSYMBOL".
func IDResolver(all []market.Instrument) func(token int64) (string, bool) {
	byToken := make(map[int64]string, len(all))
	for _, i := range all {
		byToken[i.InstrumentToken] = i.Exchange + ":" + i.Tradingsymbol
	}
	return func(token int64) (string, bool) {
		id, ok := byToken[token]
		return id, ok
	}
}

// Deps mirrors the index.ts wiring of the engine.
type Deps struct {
	// GetAllInstruments is the active broker's (cached) instrument dump.
	GetAllInstruments func(ctx context.Context) ([]market.Instrument, error)
	// GetBoard is the F&O board (deriveFnoBoard of the dump).
	GetBoard func(ctx context.Context) ([]BoardItem, error)
	// MarketData is the active broker's REST market data.
	MarketData market.MarketDataProvider
	// IsMarketOpen defaults to jsx.IsMarketOpen at Now.
	IsMarketOpen func() bool
	// IstDayKey defaults to jsx.IstDayKey.
	IstDayKey func(atMs int64) string
	// MakeIDResolver defaults to IDResolver.
	MakeIDResolver func(all []market.Instrument) func(token int64) (string, bool)
	// GetRfPct is the admin-entered risk-free rate (%), nil when unset.
	GetRfPct func() *float64
	// ActiveBroker defaults to Zerodha.
	ActiveBroker func() brokers.ID
	// SetTokens declares this scanner's ENTIRE token set on the lane (one diff). It is
	// called without the engine lock, in the order the sets were computed.
	SetTokens func(tokens []int64)
	// Store defaults to a Repository without a database (storage disabled).
	Store Store
	// Margins is the active broker's basket-margin calculator; nil = no margin figures.
	Margins market.MarginProvider
	// BoxLane reports the lane's other user; nil = the budget is fixed at SYNTH_MAX_TOKENS.
	BoxLane func() BoxLaneUsage
	// Switching is true while a broker switch is in progress.
	Switching func() bool
	// BrokerGeneration changes on every broker switch; a refresh that sees it move is
	// discarded.
	BrokerGeneration func() int64
	// Now defaults to time.Now.
	Now func() time.Time
	// Config defaults to LoadConfig(config.OS).
	Config *Config
}

// Timings and limits (engine.ts constants).
const (
	positionTokens       = 3 // future + CE + PE per open position
	firstRefreshRetryMs  = 10_000
	refreshDebounceMs    = 5_000
	unbuiltRetryMs       = 60_000
	closeRetryMs         = 5_000
	loadRetryMs          = 30_000
	relinkRetryMs        = 10_000
	marginAttempts       = 3
	marginBackfillMs     = 60_000
	maxMarginBackfills   = 3
	storeTimeout         = 30 * time.Second
	closedTodayLoadLimit = 2000
)

func logf(format string, args ...any) { log.Printf("[Synthetic] "+format, args...) }

func storeCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), storeTimeout)
}

// msDuration is a setInterval/setTimeout delay in milliseconds (fractions dropped).
func msDuration(ms float64) time.Duration {
	if !(ms >= 1) {
		ms = 1
	}
	return time.Duration(math.Trunc(ms)) * time.Millisecond
}

// flight is a single-flight universe refresh.
type flight struct {
	done *signal
	err  error
}

// positionMap is an insertion-ordered id → trade map (a JavaScript Map).
type positionMap struct {
	ids []string
	m   map[string]*Trade
}

func (p *positionMap) get(id string) (*Trade, bool) { t, ok := p.m[id]; return t, ok }
func (p *positionMap) size() int                    { return len(p.ids) }

func (p *positionMap) set(t *Trade) {
	if _, ok := p.m[t.ID]; !ok {
		p.ids = append(p.ids, t.ID)
	}
	p.m[t.ID] = t
}

func (p *positionMap) del(id string) {
	if _, ok := p.m[id]; !ok {
		return
	}
	delete(p.m, id)
	for i, v := range p.ids {
		if v == id {
			p.ids = append(p.ids[:i:i], p.ids[i+1:]...)
			break
		}
	}
}

func (p *positionMap) values() []*Trade {
	out := make([]*Trade, len(p.ids))
	for i, id := range p.ids {
		out[i] = p.m[id]
	}
	return out
}

// tokenSet is an insertion-ordered set of tokens (a JavaScript Set).
type tokenSet struct {
	list []int64
	has  map[int64]bool
}

func newTokenSet() *tokenSet { return &tokenSet{has: map[int64]bool{}} }

func (s *tokenSet) add(t int64) {
	if !s.has[t] {
		s.has[t] = true
		s.list = append(s.list, t)
	}
}

func (s *tokenSet) same(o *tokenSet) bool {
	if len(s.list) != len(o.list) {
		return false
	}
	for _, t := range s.list {
		if !o.has[t] {
			return false
		}
	}
	return true
}

// settingsTurn is one place in the settings queue: loads and saves run one at a time,
// in order (Node: the settingsLock promise chain).
type settingsTurn struct{ prev, done *signal }

// Engine is the SyntheticEngine.
type Engine struct {
	deps Deps
	cfg  Config
	rt   runtime

	mu sync.Mutex
	// effects are the side effects queued under mu (SetTokens calls, background work);
	// unlock runs them in order once mu is released. draining is set while one caller
	// runs them, so effects queued meanwhile join that caller's queue and keep order.
	effects  []func()
	draining bool
	// settingsTail is the end of the last queued settings turn.
	settingsTail *signal

	running, booted, loaded, indexReady, loading bool
	lastLoadAttemptAt                            int64
	strikeLevel                                  int
	minExpectedNetProfit, safetyBuffer           float64
	maxOpenPositions                             float64
	settingsLoaded, settingsDirty                bool

	board                map[string]BoardItem
	chains               map[string]*ChainIndex
	windows              map[string]*Window
	selection            []string
	watched              *tokenSet
	quotes               *quotes.Store
	closes               map[int64]float64
	seededRef            map[string]float64
	closeSessionDay      *string
	universeAt           *int64
	lastRefreshAttemptAt int64
	refreshing           *flight
	skippedForBudget     int
	reservedCount        int
	unbuiltCount         int
	budgetGrowPending    bool
	closeViewPending     bool
	namespaceEpoch       int64
	namespaceStale       bool
	lastRawTickAt        *int64
	lastMarketOpen       *bool

	opportunities  []*Opportunity
	eligibleStreak map[string]int
	eligibleSig    map[string]string
	evaluatedAt    *int64

	positions         *positionMap
	metrics           map[string]*ExitMetrics
	unlinked          map[string]bool
	exitStreak        map[string]int
	exitSig           map[string]string
	closedIDs         map[string]bool
	deletedIDs        map[string]bool
	marginInFlight    map[string]bool
	marginBackfills   map[string]int
	lastMarginSweepAt int64
	relinking         bool
	lastRelinkAt      int64
	pendingEntries    map[string]bool
	closing           map[string]bool
	retryAt           map[string]int64
	cooldownUntil     map[string]float64
	closedToday       []*Trade
	closedDay         string

	lastError   *string
	loopStop    func()
	publishStop func()
	sseClients  map[*sseClient]struct{}
}

// NewEngine builds the engine. Nothing runs until Boot (or Start).
func NewEngine(deps Deps) *Engine { return newEngine(deps, newSysRuntime()) }

func newEngine(deps Deps, rt runtime) *Engine {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.IsMarketOpen == nil {
		now := deps.Now
		deps.IsMarketOpen = func() bool { return jsx.IsMarketOpen(now()) }
	}
	if deps.IstDayKey == nil {
		deps.IstDayKey = func(at int64) string { return jsx.IstDayKey(jsx.FromMs(at)) }
	}
	if deps.MakeIDResolver == nil {
		deps.MakeIDResolver = IDResolver
	}
	if deps.GetRfPct == nil {
		deps.GetRfPct = func() *float64 { return nil }
	}
	if deps.ActiveBroker == nil {
		deps.ActiveBroker = func() brokers.ID { return brokers.Zerodha }
	}
	if deps.SetTokens == nil {
		deps.SetTokens = func([]int64) {}
	}
	if deps.Store == nil {
		deps.Store = NewRepository(nil)
	}
	cfg := LoadConfig(config.OS)
	if deps.Config != nil {
		cfg = *deps.Config
	}
	e := &Engine{
		deps:                 deps,
		cfg:                  cfg,
		rt:                   rt,
		strikeLevel:          cfg.StrikeLevel,
		minExpectedNetProfit: cfg.MinExpectedNetProfit,
		safetyBuffer:         cfg.SafetyBuffer,
		maxOpenPositions:     cfg.MaxOpenPositions,
		board:                map[string]BoardItem{},
		chains:               map[string]*ChainIndex{},
		windows:              map[string]*Window{},
		watched:              newTokenSet(),
		quotes:               quotes.NewStore(),
		closes:               map[int64]float64{},
		seededRef:            map[string]float64{},
		opportunities:        []*Opportunity{},
		eligibleStreak:       map[string]int{},
		eligibleSig:          map[string]string{},
		positions:            &positionMap{m: map[string]*Trade{}},
		metrics:              map[string]*ExitMetrics{},
		unlinked:             map[string]bool{},
		exitStreak:           map[string]int{},
		exitSig:              map[string]string{},
		closedIDs:            map[string]bool{},
		deletedIDs:           map[string]bool{},
		marginInFlight:       map[string]bool{},
		marginBackfills:      map[string]int{},
		pendingEntries:       map[string]bool{},
		closing:              map[string]bool{},
		retryAt:              map[string]int64{},
		cooldownUntil:        map[string]float64{},
		closedToday:          []*Trade{},
		sseClients:           map[*sseClient]struct{}{},
	}
	e.closedDay = e.dayKey(e.nowMs())
	return e
}

// Config returns the configuration the engine runs with.
func (e *Engine) Config() Config { return e.cfg }

func (e *Engine) nowMs() int64            { return e.deps.Now().UnixMilli() }
func (e *Engine) dayKey(at int64) string  { return e.deps.IstDayKey(at) }
func (e *Engine) marketOpen() bool        { return e.deps.IsMarketOpen() }
func (e *Engine) switching() bool         { return e.deps.Switching != nil && e.deps.Switching() }
func (e *Engine) activeBroker() string    { return string(e.deps.ActiveBroker()) }
func (e *Engine) setLastError(msg string) { e.lastError = &msg }
func (e *Engine) authenticated() bool {
	return e.deps.MarketData != nil && e.deps.MarketData.IsAuthenticated()
}
func (e *Engine) storeReadyLocked() bool { return e.settingsLoaded && e.loaded && e.indexReady }
func (e *Engine) activeLocked() bool     { return e.running || e.positions.size() > 0 }
func (e *Engine) generation() int64 {
	if e.deps.BrokerGeneration == nil {
		return 0
	}
	return e.deps.BrokerGeneration()
}

/* ------------------------------ lock and effects ----------------------------- */

func (e *Engine) lock() { e.mu.Lock() }

// unlock releases mu after running the side effects queued while it was held, in
// order, each with mu released. When another caller is already running effects, the
// new ones join its queue instead (that caller runs them next, keeping the order).
func (e *Engine) unlock() {
	if e.draining || len(e.effects) == 0 {
		e.mu.Unlock()
		return
	}
	e.draining = true
	for len(e.effects) > 0 {
		fx := e.effects[0]
		e.effects[0] = nil
		e.effects = e.effects[1:]
		e.mu.Unlock()
		func() {
			defer func() {
				if r := recover(); r != nil {
					logf("side effect failed: %v", r)
				}
			}()
			fx()
		}()
		e.mu.Lock()
	}
	e.draining = false
	e.mu.Unlock()
}

// goLocked queues background work (an un-awaited async call in Node).
func (e *Engine) goLocked(f func()) {
	e.effects = append(e.effects, func() { e.rt.spawn(f) })
}

// setTokensLocked queues one SetTokens call.
func (e *Engine) setTokensLocked(tokens []int64, failure string) {
	e.effects = append(e.effects, func() {
		defer func() {
			if r := recover(); r != nil {
				logf("%s: %v", failure, r)
			}
		}()
		e.deps.SetTokens(tokens)
	})
}

// waitIdle blocks until no background task is running (tests on the production runtime).
func (e *Engine) waitIdle() {
	if r, ok := e.rt.(*sysRuntime); ok {
		r.idle()
	}
}

// WaitIdle waits up to timeout for background work already started (store writes,
// REST calls, margin captures) to finish, for an orderly shutdown after Dispose: the
// database can then be closed without failing those writes. It reports whether the
// engine went idle in time.
func (e *Engine) WaitIdle(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		e.waitIdle()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

/* --------------------------------- lifecycle -------------------------------- */

// Boot adopts open paper positions and starts the loop. Call once, after the database
// is up. Storage errors are recorded in last_error and retried from the loop.
func (e *Engine) Boot() {
	e.lock()
	if e.booted {
		e.unlock()
		return
	}
	e.booted = true
	e.ensureLoopLocked()
	load := e.beginLoadLocked()
	e.unlock()
	if load != nil {
		load()
	}
}

// loadStep is where a store load starts.
type loadStep int

const (
	loadSettingsStep loadStep = iota
	loadTradesStep
	loadIndexStep
)

// beginLoadLocked is the synchronous start of loadFromStore. It returns the rest of the
// load (to run or to queue), or nil when there is nothing to load now.
func (e *Engine) beginLoadLocked() func() {
	if e.loading || e.storeReadyLocked() {
		return nil
	}
	e.lastLoadAttemptAt = e.nowMs()
	if !e.deps.Store.Enabled() {
		return nil
	}
	e.loading = true
	first := loadIndexStep
	var turn *settingsTurn
	switch {
	case !e.settingsLoaded:
		// Settings first: an entry must never be taken under the env defaults when the
		// operator has saved different ones.
		first = loadSettingsStep
		turn = e.settingsTurnLocked()
	case !e.loaded:
		first = loadTradesStep
	}
	return func() {
		err := e.loadSteps(first, turn)
		e.lock()
		if err != nil {
			e.setLastError("Paper-trade storage is not ready: " + err.Error())
			logf("paper-trade storage not ready: %v", err)
		}
		e.loading = false
		e.unlock()
	}
}

// loadSteps reads settings, then trades, then verifies the unique index. Entries wait
// for all three; monitoring needs only the trades.
func (e *Engine) loadSteps(first loadStep, turn *settingsTurn) error {
	if first == loadSettingsStep {
		if err := e.loadSettings(turn); err != nil {
			return err
		}
		e.lock()
		first = loadIndexStep
		if !e.loaded {
			first = loadTradesStep
		}
		e.unlock()
	}
	if first == loadTradesStep {
		if err := e.loadTrades(); err != nil {
			return err
		}
	}
	e.lock()
	needIndex := !e.indexReady
	e.unlock()
	if !needIndex {
		return nil
	}
	ctx, cancel := storeCtx()
	err := e.deps.Store.EnsureReady(ctx)
	cancel()
	if err != nil {
		return err
	}
	e.lock()
	e.indexReady = true
	e.unlock()
	return nil
}

// settingsTurnLocked takes the next place in the settings queue.
func (e *Engine) settingsTurnLocked() *settingsTurn {
	t := &settingsTurn{prev: e.settingsTail, done: newSignal()}
	e.settingsTail = t.done
	return t
}

// beginTurn waits for every settings load or save queued before t. Like the `.then(fn,
// fn)` of Node's settingsLock, the turn starts after a microtask boundary even when
// nothing is queued.
func (e *Engine) beginTurn(t *settingsTurn) {
	if t.prev != nil {
		e.rt.await(t.prev)
	}
	e.rt.yield()
}

func (e *Engine) endTurn(t *settingsTurn) { e.rt.fire(t.done) }

// loadSettings applies the saved settings over the env defaults. A change the admin made
// while storage was down is newer and wins; it is saved now instead.
func (e *Engine) loadSettings(turn *settingsTurn) error {
	e.beginTurn(turn)
	defer e.endTurn(turn)
	e.lock()
	done := e.settingsLoaded
	e.unlock()
	if done {
		return nil
	}
	ctx, cancel := storeCtx()
	defer cancel()
	stored, err := e.deps.Store.LoadSettings(ctx)
	if err != nil {
		return err
	}
	e.lock()
	if !e.settingsDirty {
		next := e.settingsSnapshotLocked()
		var applied []string
		for _, key := range SettingKeys {
			raw, ok := stored[key]
			if !ok {
				continue
			}
			if v, msg := ParseSetting(key, raw); msg == "" {
				next.set(key, v)
				applied = append(applied, key+"="+jsNumberString(v))
			} else {
				logf("ignoring saved %s: %s", key, msg)
			}
		}
		e.applySettingsLocked(next)
		if len(applied) > 0 {
			logf("applied saved settings: %s", strings.Join(applied, ", "))
		}
	}
	dirty := e.settingsDirty
	snap := e.settingsSnapshotLocked()
	e.unlock()
	if dirty {
		if err := e.deps.Store.SaveSettings(ctx, snap); err != nil {
			return err
		}
		e.lock()
		e.settingsDirty = false
		e.unlock()
	}
	e.lock()
	e.settingsLoaded = true
	e.unlock()
	return nil
}

func (e *Engine) settingsSnapshotLocked() Settings {
	return Settings{e.minExpectedNetProfit, e.safetyBuffer, e.maxOpenPositions}
}

func (e *Engine) applySettingsLocked(s Settings) {
	e.minExpectedNetProfit, e.safetyBuffer, e.maxOpenPositions = s.MinExpectedNetProfit, s.SafetyBuffer, s.MaxOpenPositions
}

// underMaxOpenLocked: another position may be opened under max-open (0 = no limit).
func (e *Engine) underMaxOpenLocked() bool {
	return e.maxOpenPositions <= 0 ||
		float64(e.positions.size()+len(e.pendingEntries)) < e.maxOpenPositions
}

// roomForAnotherPositionLocked: the budget can carry one more position's three legs.
func (e *Engine) roomForAnotherPositionLocked(budget float64) bool {
	return float64((e.positions.size()+len(e.pendingEntries)+1)*positionTokens) <= budget
}

func (e *Engine) loadTrades() error {
	ctx, cancel := storeCtx()
	defer cancel()
	open, err := e.deps.Store.LoadOpen(ctx)
	if err != nil {
		return err
	}
	e.lock()
	e.adoptLocked(open)
	today := e.dayKey(e.nowMs())
	e.unlock()
	closed, err := e.deps.Store.LoadClosed(ctx, closedTodayLoadLimit, &today)
	if err != nil {
		return err
	}
	e.lock()
	defer e.unlock()
	known := map[string]bool{}
	for _, t := range e.closedToday {
		known[t.ID] = true
	}
	merged := append([]*Trade(nil), e.closedToday...)
	for _, t := range closed {
		if !known[t.ID] && !e.deletedIDs[t.ID] {
			merged = append(merged, t)
		}
	}
	sortByClosedDesc(merged)
	e.closedToday = merged
	e.closedDay = today
	e.loaded = true
	if len(open) > 0 {
		logf("adopted %d open paper position(s)", len(open))
	}
	return nil
}

func closedAtOr0(t *Trade) int64 {
	if t.ClosedAt == nil {
		return 0
	}
	return *t.ClosedAt
}

// sortByClosedDesc is `sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0))` (stable).
func sortByClosedDesc(ts []*Trade) {
	sort.SliceStable(ts, func(i, j int) bool { return closedAtOr0(ts[j])-closedAtOr0(ts[i]) < 0 })
}

// adoptLocked takes stored open rows into memory. Each starts unlinked: its tokens may
// belong to another broker, so nothing is subscribed until its legs are re-resolved.
func (e *Engine) adoptLocked(rows []*Trade) {
	added := 0
	for _, t := range rows {
		if t.Status != "open" || e.closedIDs[t.ID] {
			continue
		}
		if _, ok := e.positions.get(t.ID); ok {
			continue
		}
		if e.deletedIDs[t.ID] {
			continue
		}
		e.positions.set(t)
		e.unlinked[t.ID] = true
		added++
	}
	if added > 0 {
		e.lastRelinkAt = 0
	}
}

// Start turns discovery on. errMsg is set (and ok false) when it cannot start.
func (e *Engine) Start() (ok bool, errMsg string) {
	e.lock()
	if !e.authenticated() {
		e.unlock()
		return false, "No broker session: connect the active broker first."
	}
	if e.switching() {
		e.unlock()
		return false, "A broker switch is in progress. Try again in a moment."
	}
	if e.running {
		e.unlock()
		return true, ""
	}
	e.running = true
	e.lastError = nil
	e.ensureLoopLocked()
	load := e.beginLoadLocked()
	e.unlock()
	if load != nil {
		load()
	}
	// A refresh already in flight was planned without discovery: let it finish, then
	// build the windows with RUN on.
	e.lock()
	inFlight := e.refreshing
	e.unlock()
	if inFlight != nil {
		e.rt.await(inFlight.done)
	}
	e.lock()
	f := e.refreshUniverseLocked(false)
	e.unlock()
	e.rt.await(f.done)
	e.lock()
	defer e.unlock()
	if f.err != nil {
		e.setLastError(f.err.Error())
	}
	e.evaluateLocked(e.nowMs(), e.marketOpen(), false)
	e.publishLocked()
	return true, ""
}

// Stop turns discovery off and releases every window token. Open positions stay
// subscribed, keep being marked and can still auto-exit.
func (e *Engine) Stop() {
	e.lock()
	defer e.unlock()
	e.stopLocked()
}

func (e *Engine) stopLocked() {
	e.running = false
	e.windows = map[string]*Window{}
	e.selection = nil
	e.opportunities = []*Opportunity{}
	e.eligibleStreak = map[string]int{}
	e.skippedForBudget = 0
	e.reservedCount = 0
	e.unbuiltCount = 0
	e.budgetGrowPending = false
	e.applySubscriptionsLocked()
	e.publishLocked()
}

// Dispose stops the timers and ends every stream, for process shutdown. Positions stay
// open (they are durable).
func (e *Engine) Dispose() {
	e.lock()
	defer e.unlock()
	e.stopLocked()
	if e.loopStop != nil {
		e.loopStop()
		e.loopStop = nil
	}
	if e.publishStop != nil {
		e.publishStop()
		e.publishStop = nil
	}
	for c := range e.sseClients {
		c.end()
	}
	e.sseClients = map[*sseClient]struct{}{}
}

// InvalidateBooks drops every cached book: the lane reconnected.
func (e *Engine) InvalidateBooks() { e.quotes.InvalidateGeneration() }

// InvalidateNamespace forgets every token this engine knows: the broker's token
// namespace is being replaced (switch, logout, lost session). Nothing is subscribed
// again until the universe is reloaded and every open leg re-resolved.
func (e *Engine) InvalidateNamespace() {
	e.lock()
	defer e.unlock()
	// Release the whole lease first: after a lost or logged-out session it is what stops
	// the old set being replayed onto the next socket.
	e.setTokensLocked([]int64{}, "releasing subscriptions failed")
	e.namespaceEpoch++
	e.namespaceStale = true
	e.quotes.InvalidateGeneration()
	e.closes = map[int64]float64{}
	e.seededRef = map[string]float64{}
	e.windows = map[string]*Window{}
	e.selection = nil
	e.reservedCount = 0
	e.unbuiltCount = 0
	e.watched = newTokenSet()
	e.opportunities = []*Opportunity{}
	e.eligibleStreak = map[string]int{}
	e.eligibleSig = map[string]string{}
	e.exitStreak = map[string]int{}
	e.exitSig = map[string]string{}
	e.universeAt = nil
	for _, id := range e.positions.ids {
		e.unlinked[id] = true
	}
}

// ReloadUniverse rebuilds in the new namespace and re-links open positions after a
// broker switch (the registry's ReloadUniverse hook; ctx is not used: the refresh runs to
// completion as in Node). Bumping the epoch first discards any refresh still in flight.
func (e *Engine) ReloadUniverse(_ context.Context) error {
	e.lock()
	e.namespaceEpoch++
	inFlight := e.refreshing
	e.unlock()
	if inFlight != nil {
		e.rt.await(inFlight.done)
	}
	e.lock()
	e.universeAt = nil
	if !e.activeLocked() {
		e.unlock()
		return nil
	}
	f := e.refreshUniverseLocked(true)
	e.unlock()
	e.rt.await(f.done)
	return f.err
}

// SetStrikeLevel changes ATM±level (1, 2 or 3); errMsg is set for anything else.
func (e *Engine) SetStrikeLevel(level any) (errMsg string) {
	lvl, ok := ClampStrikeLevel(level)
	if !ok {
		return "level must be 1, 2 or 3"
	}
	e.lock()
	defer e.unlock()
	if lvl == e.strikeLevel {
		return ""
	}
	e.strikeLevel = lvl
	if e.running {
		// Rebuild every window at the new width around its current reference price.
		now := e.nowMs()
		for _, u := range e.selection {
			w, chain := e.windows[u], e.chains[u]
			b, okb := e.board[u]
			if w == nil || chain == nil || !okb {
				continue
			}
			if next := BuildWindow(b, chain, e.refPriceForLocked(w), lvl, now); next != nil {
				e.windows[u] = next
			}
		}
		e.fitToBudgetLocked(e.tokenBudgetLocked(nil), true)
		e.evaluateLocked(now, e.marketOpen(), false)
	}
	return ""
}

// UpdateSettings changes the entry gate, the safety buffer and/or max open positions
// (0 = no limit) and saves them. A failed save is rolled back (503). Without storage the
// change applies to this process only (persisted false) and is saved once it connects.
// Only NEW entries are affected: lowering max open never closes an open position.
func (e *Engine) UpdateSettings(body map[string]any) (persisted bool, status int, errMsg string) {
	e.lock()
	turn := e.settingsTurnLocked()
	e.unlock()
	e.beginTurn(turn)
	defer e.endTurn(turn)

	e.lock()
	next := e.settingsSnapshotLocked()
	changed := false
	for _, key := range SettingKeys {
		raw, ok := body[key]
		if !ok {
			continue
		}
		v, msg := ParseSetting(key, raw)
		if msg != "" {
			e.unlock()
			return false, 400, msg
		}
		next.set(key, v)
		changed = true
	}
	if !changed {
		e.unlock()
		return false, 400, "Nothing to change: send any of " + strings.Join(SettingKeys, ", ") + "."
	}
	before := e.settingsSnapshotLocked()
	e.applySettingsLocked(next)
	enabled := e.deps.Store.Enabled()
	e.unlock()
	var saveErr error
	if enabled {
		ctx, cancel := storeCtx()
		saveErr = e.deps.Store.SaveSettings(ctx, next)
		cancel()
	}
	e.lock()
	defer e.unlock()
	if enabled {
		if saveErr != nil {
			e.applySettingsLocked(before)
			return false, 503, "Could not save the settings: " + saveErr.Error()
		}
		e.settingsDirty = false
	} else {
		e.settingsDirty = true
	}
	state := "saved"
	if e.settingsDirty {
		state = "changed (not saved: storage unavailable)"
	}
	limit := func(v float64) string {
		if v == 0 || math.IsNaN(v) { // `v || "no limit"`
			return "no limit"
		}
		return jsNumberString(v)
	}
	logf("settings %s: gate ₹%s → ₹%s, safety ₹%s → ₹%s, max open %s → %s", state,
		jsNumberString(before.MinExpectedNetProfit), jsNumberString(next.MinExpectedNetProfit),
		jsNumberString(before.SafetyBuffer), jsNumberString(next.SafetyBuffer),
		limit(before.MaxOpenPositions), limit(next.MaxOpenPositions))
	// Not an observation: the books are the same, so it must not confirm a signal.
	e.evaluateLocked(e.nowMs(), e.marketOpen(), false)
	e.publishLocked()
	return !e.settingsDirty, 0, ""
}

/* ----------------------------------- ticks ---------------------------------- */

// OnTicks takes lane ticks. Every tick counts for feed liveness; only tokens this
// engine watches reach its books.
func (e *Engine) OnTicks(ticks []market.Tick) {
	if len(ticks) == 0 {
		return
	}
	e.lock()
	defer e.unlock()
	if !e.activeLocked() {
		return
	}
	now := e.nowMs()
	e.lastRawTickAt = &now
	if len(e.watched.list) == 0 {
		return
	}
	var mine []market.Tick
	for _, t := range ticks {
		if e.watched.has[t.Token] {
			mine = append(mine, t)
		}
	}
	if len(mine) > 0 {
		e.quotes.ApplyTicks(mine, now)
	}
}

/* -------------------------------- token budget ------------------------------- */

// TokenBudget is the number of tokens this engine may hold on the lane now.
func (e *Engine) TokenBudget() float64 {
	e.lock()
	defer e.unlock()
	return e.tokenBudgetLocked(nil)
}

// tokenBudgetLocked: boxIncoming is the size of the set the lane's other user is ABOUT
// to declare (from YieldToBox), so the budget is computed against its next state.
func (e *Engine) tokenBudgetLocked(boxIncoming *float64) float64 {
	base := e.cfg.MaxTokens
	if e.deps.BoxLane == nil {
		return base
	}
	lane := e.deps.BoxLane()
	held := lane.HeldTokens
	if boxIncoming != nil {
		held = *boxIncoming
	}
	// A running Box may grow to its full budget at its next refresh: reserve all of it.
	reserve := held
	if lane.Running {
		reserve = math.Max(held, lane.Budget)
	}
	budget := base
	if e.cfg.ShareBoxBudget && !lane.Running {
		budget = base + math.Max(0, lane.Budget-held)
	}
	return math.Max(0, math.Min(budget, e.cfg.LaneTokenLimit-reserve))
}

// YieldToBox is called synchronously BEFORE the lane's other user declares boxTokens,
// so this engine drops windows first and the socket never exceeds the lane limit. With
// Box gone nothing calls it; it is kept for the lane contract.
func (e *Engine) YieldToBox(boxTokens float64) {
	e.lock()
	defer e.unlock()
	if !e.activeLocked() || e.namespaceStale {
		return
	}
	e.fitToBudgetLocked(e.tokenBudgetLocked(&boxTokens), false)
}

func (e *Engine) underlyingCap() float64 {
	if e.cfg.MaxUnderlyings > 0 {
		return e.cfg.MaxUnderlyings
	}
	return math.Inf(1)
}

// pickWithinBudgetLocked: the underlyings (in order) whose windows fit in budget after
// the open positions.
func (e *Engine) pickWithinBudgetLocked(order []string, budget float64) []string {
	perWindow := float64(TokensFor(e.strikeLevel))
	limit := e.underlyingCap()
	used := float64(e.positions.size() * positionTokens)
	out := []string{}
	for _, u := range order {
		if float64(len(out)) >= limit || used+perWindow > budget {
			break
		}
		out = append(out, u)
		used += perWindow
	}
	return out
}

// fitToBudgetLocked drops the lowest-priority windows until they fit. It never drops
// an open position's legs.
func (e *Engine) fitToBudgetLocked(budget float64, forceApply bool) {
	keep := e.pickWithinBudgetLocked(e.selection, budget)
	dropped := len(e.selection) - len(keep)
	if dropped > 0 {
		for _, u := range e.selection[len(keep):] {
			delete(e.windows, u)
		}
		e.selection = keep
		// Unbuilt reservations lose their slot too: both are now out for budget.
		e.skippedForBudget += dropped + e.unbuiltCount
		e.reservedCount = len(keep)
		e.unbuiltCount = 0
	} else if e.running && e.skippedForBudget > 0 {
		// Room for one more RESERVED candidate (not one more built window): a window
		// that failed to build must not keep re-arming the refresh.
		perWindow := float64(TokensFor(e.strikeLevel))
		room := float64(e.positions.size()*positionTokens)+float64(e.reservedCount+1)*perWindow <= budget
		if room && float64(e.reservedCount) < e.underlyingCap() {
			e.budgetGrowPending = true
		}
	}
	if dropped > 0 || forceApply {
		e.applySubscriptionsLocked()
	}
}

/* --------------------------------- universe --------------------------------- */

// refreshUniverseLocked starts (or joins) the single-flight universe rebuild.
// allowDuringSwitch is set only by ReloadUniverse, the switch's own hook.
func (e *Engine) refreshUniverseLocked(allowDuringSwitch bool) *flight {
	if e.refreshing != nil {
		return e.refreshing
	}
	f := &flight{done: newSignal()}
	e.refreshing = f
	run := e.beginRefreshLocked(allowDuringSwitch)
	e.goLocked(func() {
		var err error
		if run != nil {
			err = run()
		} else {
			e.rt.yield() // the `.finally` of an async function that returned at once
		}
		e.lock()
		if e.refreshing == f {
			e.refreshing = nil
		}
		f.err = err
		e.unlock()
		e.rt.fire(f.done)
	})
	return f
}

// staleCheckLocked returns a closure (call it with the lock held) that says whether
// work begun now belongs to a superseded namespace.
func (e *Engine) staleCheckLocked() func() bool {
	epoch, gen := e.namespaceEpoch, e.generation()
	return func() bool { return epoch != e.namespaceEpoch || gen != e.generation() }
}

func (e *Engine) instruments() ([]market.Instrument, error) {
	if e.deps.GetAllInstruments == nil {
		return nil, errors.New("no instrument source")
	}
	return e.deps.GetAllInstruments(context.Background())
}

// loadUniverse is `Promise.all([getAllInstruments(), getBoard()])`: both requests go
// out at once; it returns when both answered, or at the first failure.
func (e *Engine) loadUniverse() ([]market.Instrument, []BoardItem, error) {
	var mu sync.Mutex
	var all []market.Instrument
	var board []BoardItem
	var firstErr error
	left := 2
	done := newSignal()
	finish := func(err error) {
		mu.Lock()
		left--
		failed := err != nil && firstErr == nil
		if failed {
			firstErr = err
		}
		over := failed || (left == 0 && firstErr == nil)
		mu.Unlock()
		if over {
			e.rt.fire(done)
		}
	}
	e.rt.spawn(func() {
		a, err := e.instruments()
		mu.Lock()
		all = a
		mu.Unlock()
		finish(err)
	})
	e.rt.spawn(func() {
		var b []BoardItem
		var err error
		if e.deps.GetBoard != nil {
			b, err = e.deps.GetBoard(context.Background())
		}
		mu.Lock()
		board = b
		mu.Unlock()
		finish(err)
	})
	e.rt.await(done)
	mu.Lock()
	defer mu.Unlock()
	if firstErr != nil {
		return nil, nil, firstErr
	}
	return all, board, nil
}

// beginRefreshLocked is the synchronous start of doRefreshUniverse; it returns the rest
// of the refresh, or nil when the refresh returns at once.
func (e *Engine) beginRefreshLocked(allowDuringSwitch bool) func() error {
	if !e.activeLocked() || !e.authenticated() {
		return nil
	}
	if !allowDuringSwitch && e.switching() {
		return nil
	}
	superseded := e.staleCheckLocked()
	e.lastRefreshAttemptAt = e.nowMs()
	today := e.dayKey(e.nowMs())
	return func() error { return e.runRefresh(superseded, today) }
}

// runRefresh rebuilds expiry pairing, windows, position links and subscriptions.
func (e *Engine) runRefresh(superseded func() bool, today string) error {
	all, board, err := e.loadUniverse()
	if err != nil {
		return err
	}
	e.lock()
	defer e.unlock()
	if superseded() || !e.activeLocked() {
		return nil
	}
	e.chains = IndexSyntheticChains(all, today)
	e.board = make(map[string]BoardItem, len(board))
	for _, b := range board {
		e.board[b.Symbol] = b
	}
	e.relinkPositionsLocked(all)
	resolve := e.deps.MakeIDResolver(all)

	// Indices first (deepest books), then stocks alphabetically: a stable selection
	// when the token budget binds.
	var ordered []BoardItem
	if e.running {
		for _, b := range board {
			chain, ok := e.chains[b.Symbol]
			if !ok || (e.cfg.SkipExpiryDay && chain.Expiry == today) {
				continue
			}
			ordered = append(ordered, b)
		}
		sort.SliceStable(ordered, func(i, j int) bool {
			a, b := ordered[i], ordered[j]
			if a.IsIndex == b.IsIndex {
				return localeCompare(a.Symbol, b.Symbol) < 0
			}
			return a.IsIndex
		})
	}
	symbols := make([]string, len(ordered))
	for i, b := range ordered {
		symbols[i] = b.Symbol
	}
	picked := e.pickWithinBudgetLocked(symbols, e.tokenBudgetLocked(nil))
	// Only windows that do not exist yet need a REST price to be centred on.
	var unseeded []string
	for _, u := range picked {
		if _, ok := e.windows[u]; !ok {
			unseeded = append(unseeded, u)
		}
	}
	if len(unseeded) > 0 {
		e.seedFromRestLocked(unseeded, resolve, superseded)
		if superseded() || !e.activeLocked() {
			return nil
		}
	}

	now := e.nowMs()
	nextWindows := map[string]*Window{}
	var order []string
	if e.running {
		for _, u := range picked {
			chain := e.chains[u]
			b, okb := e.board[u]
			if chain == nil || !okb {
				continue
			}
			ref := 0.0
			if existing := e.windows[u]; existing != nil && existing.Future.Token == chain.Future.Token {
				ref = e.refPriceForLocked(existing)
			}
			if ref == 0 || math.IsNaN(ref) { // `|| this.seededRef.get(u) || 0`
				ref = e.seededRef[u]
			}
			if w := BuildWindow(b, chain, ref, e.strikeLevel, now); w != nil {
				nextWindows[u] = w
				order = append(order, u)
			}
		}
	}
	e.windows = nextWindows
	e.selection = order
	e.skippedForBudget = len(ordered) - len(picked)
	e.reservedCount, e.unbuiltCount = 0, 0
	if e.running {
		e.reservedCount = len(picked)
		e.unbuiltCount = len(picked) - len(order)
	}
	e.namespaceStale = false
	e.budgetGrowPending = false
	// The budget may have moved while this refresh was awaiting: honour it before
	// anything is subscribed.
	e.fitToBudgetLocked(e.tokenBudgetLocked(nil), true)

	if !e.marketOpen() {
		e.seedClosesLocked(resolve, superseded)
		if superseded() {
			return nil
		}
		e.closeViewPending = false
	}
	at := e.nowMs()
	e.universeAt = &at
	logf("universe: %d paired underlyings, watching %d at ATM ±%d + %d open position(s) (%d/%s tokens, %d skipped for budget)",
		len(e.chains), len(e.selection), e.strikeLevel, e.positions.size(), len(e.watched.list),
		jsNumberString(e.tokenBudgetLocked(nil)), e.skippedForBudget)
	return nil
}

// relinkPositionsLocked resolves every open leg in the ACTIVE broker's dump by
// (underlying, expiry, type, strike). A leg that cannot be found keeps the position
// unlinked: shown, never subscribed, and settled at expiry.
func (e *Engine) relinkPositionsLocked(all []market.Instrument) {
	if e.positions.size() == 0 {
		return
	}
	wanted := map[string]bool{}
	for _, t := range e.positions.values() {
		for _, leg := range t.Legs {
			wanted[legKey(t.Underlying, t.Expiry, leg.InstrumentType, leg.Strike)] = true
		}
	}
	found := map[string]int64{}
	for _, i := range all {
		if i.Exchange != "NFO" || i.Name == "" || i.Expiry == "" {
			continue
		}
		typ := i.InstrumentType
		if typ != "FUT" && typ != "CE" && typ != "PE" {
			continue
		}
		if k := legKey(i.Name, i.Expiry, typ, i.Strike); wanted[k] {
			found[k] = i.InstrumentToken
		}
	}
	for _, t := range e.positions.values() {
		ok := true
		for li := range t.Legs {
			leg := &t.Legs[li]
			if token, hit := found[legKey(t.Underlying, t.Expiry, leg.InstrumentType, leg.Strike)]; hit {
				leg.Token = token
			} else {
				ok = false
			}
		}
		if ok {
			delete(e.unlinked, t.ID)
		} else {
			e.unlinked[t.ID] = true
		}
	}
}

// relinkLocked is relinkNow: re-resolve unlinked positions from the cached dump (no
// REST) and subscribe them. It is retried every few seconds while any position is
// unlinked: an unlinked position cannot be priced or exited.
func (e *Engine) relinkLocked() {
	if e.relinking {
		return
	}
	e.relinking = true
	e.lastRelinkAt = e.nowMs()
	superseded := e.staleCheckLocked()
	e.goLocked(func() {
		all, err := e.instruments()
		e.lock()
		defer e.unlock()
		defer func() { e.relinking = false }()
		if err != nil {
			logf("re-linking open positions failed: %v", err)
			return
		}
		if superseded() || e.namespaceStale || e.switching() {
			return
		}
		e.relinkPositionsLocked(all)
		e.applySubscriptionsLocked()
	})
}

// seedFromRestLocked takes one REST snapshot of every picked future, to centre windows
// before the first tick. The lock is released during the request.
func (e *Engine) seedFromRestLocked(picked []string, resolve func(int64) (string, bool), superseded func() bool) {
	byToken := map[int64]string{}
	var tokens []int64
	for _, u := range picked {
		if chain := e.chains[u]; chain != nil {
			if _, seen := byToken[chain.Future.Token]; !seen {
				tokens = append(tokens, chain.Future.Token)
			}
			byToken[chain.Future.Token] = u
		}
	}
	var ids []string
	for _, t := range tokens {
		if id, ok := resolve(t); ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	qs, err := e.quoteFullUnlocked(ids)
	if err != nil {
		logf("future price seed failed: %v", err)
		e.setLastError("Could not fetch futures prices to centre the strike windows.")
		return
	}
	if superseded() {
		return
	}
	for _, q := range qs {
		if u, ok := byToken[q.InstrumentToken]; ok && q.LastPrice > 0 {
			e.seededRef[u] = q.LastPrice
		}
	}
}

// quoteFullUnlocked calls the REST quote endpoint with the lock released.
func (e *Engine) quoteFullUnlocked(ids []string) ([]market.RestQuote, error) {
	md := e.deps.MarketData
	e.unlock()
	defer e.lock()
	if md == nil {
		return nil, errors.New("no market-data provider")
	}
	return md.GetQuoteFull(context.Background(), ids)
}

// seedClosesLocked fetches the last-session closes of every watched token. Only prints
// from the LATEST session are kept, so a strike that has not traded for days cannot
// pair with today's future and fake a mispricing.
func (e *Engine) seedClosesLocked(resolve func(int64) (string, bool), superseded func() bool) {
	var ids []string
	for _, t := range e.watched.list {
		if id, ok := resolve(t); ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return
	}
	qs, err := e.quoteFullUnlocked(ids)
	if err != nil {
		logf("close seed failed: %v", err)
		return
	}
	if superseded() {
		return
	}
	sessionDay := ""
	for _, q := range qs {
		if d := utf16Prefix(q.LastTradeTime, 10); d > sessionDay {
			sessionDay = d
		}
	}
	e.closes = map[int64]float64{}
	for _, q := range qs {
		if q.LastPrice > 0 && sessionDay != "" && utf16Prefix(q.LastTradeTime, 10) == sessionDay {
			e.closes[q.InstrumentToken] = q.LastPrice
		}
	}
	e.closeSessionDay = nil
	if sessionDay != "" {
		e.closeSessionDay = sptr(sessionDay)
	}
}

// applySubscriptionsLocked declares windows ∪ linked open legs as the whole token set.
func (e *Engine) applySubscriptionsLocked() {
	if e.namespaceStale {
		return
	}
	next := newTokenSet()
	for _, t := range e.positions.values() {
		if e.unlinked[t.ID] {
			continue
		}
		for _, leg := range t.Legs {
			next.add(leg.Token)
		}
	}
	for _, u := range e.selection {
		if w := e.windows[u]; w != nil {
			for _, tok := range WindowTokens(w) {
				next.add(tok)
			}
		}
	}
	if next.same(e.watched) {
		return
	}
	var dropped []int64
	for _, t := range e.watched.list {
		if !next.has[t] {
			dropped = append(dropped, t)
		}
	}
	e.watched = next
	if len(dropped) > 0 {
		e.quotes.Forget(dropped)
		for _, t := range dropped {
			delete(e.closes, t)
		}
	}
	e.setTokensLocked(append([]int64{}, next.list...), "declaring subscriptions failed")
}

func quoteLikeOf(q *quotes.Quote) *QuoteLike {
	return &QuoteLike{Bid: q.Bid, BidQty: q.BidQty, Ask: q.Ask, AskQty: q.AskQty, Last: q.Last, At: q.At}
}

func (e *Engine) liveQuote(token int64) *QuoteLike {
	if q, ok := e.quotes.Get(token); ok {
		return quoteLikeOf(q)
	}
	return nil
}

// refPriceForLocked: the future's mid with a two-sided book, else its last, else the
// REST seed, else the window's own reference.
func (e *Engine) refPriceForLocked(w *Window) float64 {
	q, ok := e.quotes.Get(w.Future.Token)
	if ok && q.Bid > 0 && q.Ask > 0 {
		return (q.Bid + q.Ask) / 2
	}
	if ok && q.Last > 0 {
		return q.Last
	}
	if v, seeded := e.seededRef[w.Underlying]; seeded {
		return v
	}
	return w.RefPrice
}

// ltpForLocked: the live last, else the last session's close.
func (e *Engine) ltpForLocked(token int64) *float64 {
	if q, ok := e.quotes.Get(token); ok && q.Last > 0 {
		return fptr(q.Last)
	}
	if c, ok := e.closes[token]; ok && c > 0 {
		return fptr(c)
	}
	return nil
}

/* ----------------------------------- loop ----------------------------------- */

func (e *Engine) ensureLoopLocked() {
	if e.loopStop != nil {
		return
	}
	e.loopStop = e.rt.every(msDuration(e.cfg.EvalIntervalMs), e.tick)
}

// tick is one pass of the loop: storage retry, day roll, universe refresh, margin
// backfill, budget, evaluation, position monitoring and automatic entries.
func (e *Engine) tick() {
	e.lock()
	defer e.unlock()
	defer func() {
		if r := recover(); r != nil {
			e.setLastError(fmt.Sprint(r))
			logf("loop failed: %v", r)
		}
	}()
	now := e.nowMs()
	marketOpen := e.marketOpen()
	if !e.storeReadyLocked() && now-e.lastLoadAttemptAt >= loadRetryMs {
		if load := e.beginLoadLocked(); load != nil {
			e.goLocked(load)
		}
	}
	e.rollDayLocked(now)
	if e.lastMarketOpen != nil && *e.lastMarketOpen && !marketOpen {
		e.closeViewPending = true
	}
	e.lastMarketOpen = &marketOpen
	e.maybeRefreshUniverseLocked(now)
	e.backfillMarginsLocked(now)
	if e.activeLocked() && !e.namespaceStale {
		e.fitToBudgetLocked(e.tokenBudgetLocked(nil), false)
	}
	e.evaluateLocked(now, marketOpen, true)
	e.monitorPositionsLocked(now, marketOpen)
	e.autoEnterLocked(now, marketOpen)
}

// rollDayLocked: at IST midnight today's closed list starts empty.
func (e *Engine) rollDayLocked(now int64) {
	today := e.dayKey(now)
	if today == e.closedDay {
		return
	}
	e.closedDay = today
	kept := []*Trade{}
	for _, t := range e.closedToday {
		if t.ClosedDay != nil && *t.ClosedDay == today {
			kept = append(kept, t)
		}
	}
	e.closedToday = kept
	// Only needed while a load could still return a row closed or deleted moments ago.
	e.closedIDs = map[string]bool{}
	e.deletedIDs = map[string]bool{}
}

func (e *Engine) maybeRefreshUniverseLocked(now int64) {
	if !e.activeLocked() || !e.authenticated() {
		return
	}
	// Mid-switch the dump still belongs to the outgoing broker: the switch reloads.
	if e.switching() {
		return
	}
	// Independent of any refresh in flight: that refresh may have re-linked BEFORE a
	// position was adopted, and an unlinked position cannot be priced or exited.
	if len(e.unlinked) > 0 && !e.namespaceStale && !e.relinking && now-e.lastRelinkAt >= relinkRetryMs {
		e.relinkLocked()
	}
	if e.refreshing != nil {
		return
	}
	sinceAttempt := now - e.lastRefreshAttemptAt
	var due bool
	if e.universeAt == nil {
		due = sinceAttempt >= firstRefreshRetryMs
	} else {
		due = float64(now-*e.universeAt) >= e.cfg.UniverseRefreshMs ||
			(e.closeViewPending && sinceAttempt >= refreshDebounceMs) ||
			(e.budgetGrowPending && e.running && sinceAttempt >= refreshDebounceMs) ||
			(e.unbuiltCount > 0 && e.running && sinceAttempt >= unbuiltRetryMs)
	}
	if !due {
		return
	}
	f := e.refreshUniverseLocked(false)
	e.goLocked(func() {
		e.rt.await(f.done)
		if f.err != nil {
			e.lock()
			e.setLastError(f.err.Error())
			e.unlock()
		}
	})
}

func (e *Engine) feedHealthyLocked(now int64, marketOpen bool) bool {
	return marketOpen && e.lastRawTickAt != nil && float64(now-*e.lastRawTickAt) <= e.cfg.FeedMaxAgeMs
}

/* -------------------------------- evaluation -------------------------------- */

func (e *Engine) rfPctLocked() float64 {
	if rf := e.deps.GetRfPct(); rf != nil && jsx.Finite(*rf) {
		return *rf
	}
	return e.cfg.DefaultRfPct
}

func (e *Engine) directions() []Direction {
	var out []Direction
	for _, d := range Directions {
		if (d == Conversion && e.cfg.EnableConversion) || (d == Reversal && e.cfg.EnableReversal) {
			out = append(out, d)
		}
	}
	return out
}

func (e *Engine) exitRules() ExitRules {
	return ExitRules{
		ConvergenceFloor: e.cfg.ConvergenceFloor, ConvergencePct: e.cfg.ConvergencePct,
		MinExitNetPnl: e.cfg.MinExitNetPnl, ProfitCapturePct: e.cfg.ProfitCapturePct,
		MinCapturedPct: e.cfg.MinCapturedPct,
	}
}

// evaluateLocked re-centres drifting windows, then re-prices every strike in every
// enabled direction. observe is false for re-pricing the same books (after an entry,
// an exit or a settings change): that must not count as another confirmation.
func (e *Engine) evaluateLocked(now int64, marketOpen bool, observe bool) {
	if !e.running || e.namespaceStale {
		e.opportunities = []*Opportunity{}
		e.eligibleStreak = map[string]int{}
		return
	}
	if marketOpen {
		moved := false
		for _, u := range e.selection {
			w := e.windows[u]
			if w == nil {
				continue
			}
			ref := e.refPriceForLocked(w)
			if WindowNeedsRebuild(w, ref, now, e.cfg.AtmHysteresis, e.cfg.WindowMinIntervalMs) {
				chain := e.chains[u]
				b, okb := e.board[u]
				var next *Window
				if chain != nil && okb {
					next = BuildWindow(b, chain, ref, e.strikeLevel, now)
				}
				if next != nil {
					e.windows[u] = next
					moved = true
				}
			}
		}
		if moved {
			e.applySubscriptionsLocked()
		}
	}
	quoteFor := e.liveQuote
	if !marketOpen {
		quoteFor = func(token int64) *QuoteLike {
			last, ok := e.closes[token]
			if !ok {
				return nil
			}
			return &QuoteLike{Last: last, At: now}
		}
	}
	params := EvalParams{
		Now: now, QuoteMaxAgeMs: e.cfg.QuoteMaxAgeMs, RfPct: e.rfPctLocked(), IncludeCarry: e.cfg.IncludeCarry,
		MinExpectedNetProfit: e.minExpectedNetProfit, SafetyBuffer: e.safetyBuffer,
		ExpectedSlippage: e.cfg.ExpectedSlippage, OptionRates: e.cfg.OptionRates,
		FuturesRates: e.cfg.FuturesRates, Indicative: !marketOpen,
	}
	dirs := e.directions()
	out := []*Opportunity{}
	for _, u := range e.selection {
		w := e.windows[u]
		if w == nil {
			continue
		}
		params.Quantity = w.LotSize // one lot
		for _, strike := range w.Strikes {
			for _, d := range dirs {
				out = append(out, EvaluateSynthetic(w, strike, d, quoteFor, params))
			}
		}
	}
	// A signal must hold across N evaluations on NEW books before it is entered: an
	// evaluation over the same books (a settings change, a quiet tick) confirms nothing.
	if observe {
		streak := map[string]int{}
		sigs := map[string]string{}
		for _, o := range out {
			if o.Status != StatusEligible {
				continue
			}
			sig := e.bookSigLegs(o.Legs)
			prev := e.eligibleStreak[o.Key]
			if prevSig, ok := e.eligibleSig[o.Key]; ok && prevSig == sig {
				streak[o.Key] = max(prev, 1)
			} else {
				streak[o.Key] = prev + 1
			}
			sigs[o.Key] = sig
		}
		e.eligibleStreak = streak
		e.eligibleSig = sigs
	}
	e.annotateLocked(out, now, marketOpen)
	e.opportunities = SortOpportunities(out)
	e.evaluatedAt = iptr(now)
}

// bookSig is the book versions of the tokens: it changes whenever any of their books does.
func (e *Engine) bookSig(tokens []int64) string {
	parts := make([]string, len(tokens))
	for i, t := range tokens {
		v := int64(0)
		if q, ok := e.quotes.Get(t); ok {
			v = q.Version
		}
		parts[i] = fmt.Sprint(v)
	}
	return strings.Join(parts, ":")
}

func (e *Engine) bookSigLegs(legs []LegEvaluation) string {
	tokens := make([]int64, len(legs))
	for i, l := range legs {
		tokens[i] = l.Token
	}
	return e.bookSig(tokens)
}

// annotateLocked marks the rows that are held and says why an ELIGIBLE row is not
// being entered.
func (e *Engine) annotateLocked(out []*Opportunity, now int64, marketOpen bool) {
	openByKey := map[string]string{}
	openUnderlyings := map[string]bool{}
	for _, t := range e.positions.values() {
		openByKey[t.Key] = t.ID
		openUnderlyings[t.Underlying] = true
	}
	today := e.dayKey(now)
	dbOK := e.deps.Store.Enabled() && e.storeReadyLocked()
	feedOK := e.feedHealthyLocked(now, marketOpen)
	full := !e.underMaxOpenLocked()
	tokensFull := !e.roomForAnotherPositionLocked(e.tokenBudgetLocked(nil))
	for _, o := range out {
		if pid, ok := openByKey[o.Key]; ok {
			o.Status = StatusOpen
			o.PositionID = sptr(pid)
			continue
		}
		if o.Status != StatusEligible {
			continue
		}
		var block NullStr
		switch {
		case !e.cfg.PaperTrading:
			block = "paper_off"
		case !dbOK:
			block = "no_db"
		case !feedOK:
			block = "feed_stale"
		case openUnderlyings[o.Underlying]:
			block = "position_open"
		case e.pendingEntries[o.Underlying]:
			block = "entering"
		case e.cooldownUntil[o.Underlying] > float64(now):
			block = "cooldown"
		case InExpirySafetyWindow(o.Expiry, today, now, e.cfg.ExpirySafetyMinutes):
			block = "expiry_cutoff"
		case full:
			block = "max_open"
		case tokensFull:
			block = "token_budget"
		case float64(e.eligibleStreak[o.Key]) < e.cfg.SignalConfirmations:
			block = "confirming"
		}
		o.EntryBlocked = block
	}
}

/* ------------------------------- paper trading ------------------------------ */

// refreshRowsLocked re-prices after an entry or exit so rows show OPEN / blocked at once.
func (e *Engine) refreshRowsLocked() {
	if e.running {
		e.evaluateLocked(e.nowMs(), e.marketOpen(), false)
	}
}

func (e *Engine) hasOpenLocked(underlying string) bool {
	for _, t := range e.positions.values() {
		if t.Underlying == underlying {
			return true
		}
	}
	return false
}

// autoEnterLocked paper-enters every ELIGIBLE, unblocked opportunity, best first.
func (e *Engine) autoEnterLocked(now int64, marketOpen bool) {
	if !e.running || !e.cfg.PaperTrading || !marketOpen || e.namespaceStale {
		return
	}
	if !e.deps.Store.Enabled() || !e.storeReadyLocked() || !e.feedHealthyLocked(now, marketOpen) {
		return
	}
	budget := e.tokenBudgetLocked(nil)
	for _, o := range e.opportunities {
		if o.Status != StatusEligible {
			break // sorted: every ELIGIBLE row comes first
		}
		if o.EntryBlocked != "" {
			continue
		}
		// Each entry adds to pendingEntries synchronously, so these re-check per row.
		if !e.underMaxOpenLocked() || !e.roomForAnotherPositionLocked(budget) {
			break
		}
		if e.pendingEntries[o.Underlying] || e.hasOpenLocked(o.Underlying) {
			continue
		}
		e.enterLocked(o)
	}
}

// enterLocked opens one paper position at the touch the opportunity was priced at. The
// pending mark is set before any I/O, so a second row for the same underlying in this
// pass is skipped.
func (e *Engine) enterLocked(o *Opportunity) {
	u := o.Underlying
	e.pendingEntries[u] = true
	epoch := e.namespaceEpoch
	now := e.nowMs()
	// Same instant as the pricing: the book each limit order was filled against.
	trade := OpenTradeFromOpportunity(o, e.deps.Store.NewID(), e.activeBroker(), now, e.dayKey(now),
		e.cfg.OptionRates.RateVersion, e.cfg.FuturesRates.RateVersion, e.depthForLocked)
	if trade == nil {
		delete(e.pendingEntries, u)
		return
	}
	key := o.Key
	e.goLocked(func() { e.finishEnter(trade, u, key, epoch) })
}

func (e *Engine) cooldownLocked(underlying string) {
	e.cooldownUntil[underlying] = float64(e.nowMs()) + e.cfg.ReentryCooldownMs
}

func (e *Engine) finishEnter(trade *Trade, u, key string, epoch int64) {
	ctx, cancel := storeCtx()
	defer cancel()
	dup, err := e.deps.Store.InsertOpen(ctx, trade.Clone())
	e.lock()
	defer e.unlock()
	defer delete(e.pendingEntries, u)
	failed := func(err error) {
		e.cooldownLocked(u)
		e.setLastError(fmt.Sprintf("Paper entry on %s failed: %s", u, err.Error()))
		logf("paper entry failed: %v", err)
	}
	if err != nil {
		failed(err)
		return
	}
	e.cooldownLocked(u)
	if dup {
		// The underlying is already open in the store: another process's position, or
		// this insert landing twice. Never open it twice; adopt whatever is stored so it
		// is monitored here too.
		e.unlock()
		open, lerr := e.deps.Store.LoadOpen(ctx)
		e.lock()
		if lerr != nil {
			failed(lerr)
			return
		}
		e.adoptLocked(open)
		return
	}
	e.positions.set(trade)
	// The namespace changed while the insert was in flight: re-link before subscribing.
	if epoch != e.namespaceEpoch {
		e.unlinked[trade.ID] = true
		e.lastRelinkAt = 0
	}
	delete(e.eligibleStreak, key)
	e.fitToBudgetLocked(e.tokenBudgetLocked(nil), true)
	logf("paper ENTRY %s %s %s K=%s lock ₹%s expected net ₹%s", trade.Direction, u, trade.Expiry,
		jsNumberString(trade.Strike), jsNumberString(trade.EntryEdge), jsNumberString(trade.ExpectedNetProfit))
	e.broadcastLocked("entry", tradeEvent{Trade: toTradeView(trade)})
	e.refreshRowsLocked()
	e.publishLocked()
	// Off the fill path: the trade already exists, margin is enrichment.
	e.captureMarginLocked(trade.ID)
}

// tradeEvent is the payload of the entry and exit stream events.
type tradeEvent struct {
	Trade TradeView `json:"trade"`
}

// monitorPositionsLocked prices every open position and acts on exits and settlement.
func (e *Engine) monitorPositionsLocked(now int64, marketOpen bool) {
	if e.positions.size() == 0 {
		return
	}
	today := e.dayKey(now)
	feedOK := e.feedHealthyLocked(now, marketOpen)
	for _, t := range e.positions.values() {
		if e.closing[t.ID] || e.retryAt[t.ID] > now {
			continue
		}
		if IsPastSettlement(t.Expiry, today, now, marketOpen) {
			e.finalizeLocked(t, SettleTradeAtExpiry(t, now, today))
			continue
		}
		linked := !e.namespaceStale && !e.unlinked[t.ID]
		m := e.priceExitLocked(t, now, today, marketOpen, linked)
		e.metrics[t.ID] = m
		// Rule exits must hold across N evaluations on new books; expiry safety acts at once.
		if m.RuleReason != "" && m.Executable {
			tokens := make([]int64, len(t.Legs))
			for i, l := range t.Legs {
				tokens[i] = l.Token
			}
			sig := e.bookSig(tokens)
			if prev, ok := e.exitSig[t.ID]; !ok || prev != sig {
				e.exitStreak[t.ID]++
				e.exitSig[t.ID] = sig
			}
		} else {
			delete(e.exitStreak, t.ID)
			delete(e.exitSig, t.ID)
		}
		streak := e.exitStreak[t.ID]
		if !marketOpen || !feedOK || !linked || !m.ShouldExit || m.Reason == "" {
			continue
		}
		if m.Reason != ExitExpirySafety && float64(streak) < e.cfg.SignalConfirmations {
			continue
		}
		if closed := CloseTradeAtTouch(t, m, m.Reason, now, today, e.depthForLocked); closed != nil {
			e.finalizeLocked(t, closed)
		}
	}
}

func (e *Engine) priceExitLocked(t *Trade, now int64, today string, marketOpen, linked bool) *ExitMetrics {
	return EvaluateExit(t,
		// No touch while the market is shut: nothing is executable then.
		func(tok int64) *QuoteLike {
			if linked && marketOpen {
				return e.liveQuote(tok)
			}
			return nil
		},
		func(tok int64) *float64 {
			if linked {
				return e.ltpForLocked(tok)
			}
			return nil
		},
		ExitParams{
			Now: now, QuoteMaxAgeMs: e.cfg.QuoteMaxAgeMs,
			ExpirySafety: InExpirySafetyWindow(t.Expiry, today, now, e.cfg.ExpirySafetyMinutes),
			Rules:        e.exitRules(), OptionRates: e.cfg.OptionRates, FuturesRates: e.cfg.FuturesRates,
		})
}

// finalizeOp is the outcome of persisting a close.
type finalizeOp struct {
	done  *signal
	ok    bool
	trade *Trade
	err   string
}

// finishOpLocked records the outcome and wakes whoever waits for it.
func (e *Engine) finishOpLocked(op *finalizeOp, ok bool, t *Trade, err string) {
	op.ok, op.trade, op.err = ok, t, err
	e.rt.fire(op.done)
}

// finalizeLocked persists a close, atomically. The position leaves memory only once
// that succeeded.
func (e *Engine) finalizeLocked(open, closed *Trade) *finalizeOp {
	op := &finalizeOp{done: newSignal()}
	if e.closing[open.ID] {
		e.finishOpLocked(op, false, nil, "This position is already closing.")
		return op
	}
	e.closing[open.ID] = true
	if !e.deps.Store.Enabled() {
		msg := "paper-trade storage is unavailable, so the close cannot be recorded"
		e.closeFailedLocked(open, msg)
		delete(e.closing, open.ID)
		e.finishOpLocked(op, false, nil, msg)
		return op
	}
	e.goLocked(func() { e.finishFinalize(open, closed, op) })
	return op
}

// closeFailedLocked: the position stays open and monitored; the close is retried shortly.
func (e *Engine) closeFailedLocked(open *Trade, msg string) {
	e.retryAt[open.ID] = e.nowMs() + closeRetryMs
	e.setLastError(fmt.Sprintf("Closing %s failed: %s", open.Underlying, msg))
	logf("close failed: %s", msg)
}

func (e *Engine) finishFinalize(open, closed *Trade, op *finalizeOp) {
	ctx, cancel := storeCtx()
	defer cancel()
	won, err := e.deps.Store.Close(ctx, closed.Clone())
	e.lock()
	defer e.unlock()
	defer delete(e.closing, open.ID)
	if err != nil {
		e.closeFailedLocked(open, err.Error())
		e.finishOpLocked(op, false, nil, err.Error())
		return
	}
	id := open.ID
	e.closedIDs[id] = true
	e.positions.del(id)
	delete(e.metrics, id)
	delete(e.exitStreak, id)
	delete(e.exitSig, id)
	delete(e.retryAt, id)
	delete(e.unlinked, id)
	e.cooldownLocked(open.Underlying)
	if !won {
		// Closed elsewhere (a racing request or another process): never close twice, but
		// do count the close that DID land, so today's P&L is not short of it.
		e.applySubscriptionsLocked()
		e.unlock()
		stored, gerr := e.deps.Store.Get(ctx, id)
		e.lock()
		if gerr == nil && stored != nil && !stored.Deleted && stored.Status == "closed" &&
			stored.ClosedDay != nil && *stored.ClosedDay == e.closedDay && !e.inClosedTodayLocked(stored.ID) {
			e.closedToday = append([]*Trade{stored.Trade}, e.closedToday...)
		}
		e.finishOpLocked(op, false, nil, "This position was already closed.")
		return
	}
	// A margin figure may have landed on the open record while the close was in flight
	// (the store keeps margin out of closes, so the database has it too).
	if closed.Margin == nil && open.Margin != nil {
		closed.applyMargin(marginOf(open))
	}
	if closed.ClosedDay != nil && *closed.ClosedDay == e.closedDay {
		e.closedToday = append([]*Trade{closed}, e.closedToday...)
	}
	e.applySubscriptionsLocked()
	logf("paper EXIT %s %s %s K=%s gross ₹%s charges ₹%s net ₹%s", closed.ExitReason, closed.Direction,
		closed.Underlying, jsNumberString(closed.Strike), numOrNull(closed.GrossPnl),
		numOrNull(closed.TotalCharges), numOrNull(closed.NetPnl))
	e.broadcastLocked("exit", tradeEvent{Trade: toTradeView(closed)})
	e.refreshRowsLocked()
	e.publishLocked()
	e.finishOpLocked(op, true, closed, "")
}

func numOrNull(p *float64) string {
	if p == nil {
		return "null"
	}
	return jsNumberString(*p)
}

func (e *Engine) inClosedTodayLocked(id string) bool {
	for _, c := range e.closedToday {
		if c.ID == id {
			return true
		}
	}
	return false
}

// depthForLocked is the top of a token's current book, as evidence of a fill's price.
func (e *Engine) depthForLocked(token int64) *Depth {
	q, ok := e.quotes.Get(token)
	if !ok {
		return nil
	}
	return DepthOf(q.Bids, q.Asks, true)
}

/* ---------------------------------- margin ---------------------------------- */

// captureMarginLocked asks the active broker what the trade's three legs block
// TOGETHER (one standalone basket) and stores it. Only for trades opened on the active
// broker (their tradingsymbols are in its naming); best-effort, retried, never on the
// fill path.
func (e *Engine) captureMarginLocked(id string) {
	provider := e.deps.Margins
	if provider == nil || e.marginInFlight[id] {
		return
	}
	t, ok := e.positions.get(id)
	if !ok || t.Margin != nil {
		return
	}
	if t.Broker != e.activeBroker() || !e.authenticated() {
		return
	}
	if e.deletedIDs[id] { // deleted meanwhile: nothing left to enrich
		return
	}
	e.marginInFlight[id] = true
	orders := MarginOrders(t)
	e.goLocked(func() { e.captureMarginJob(id, t, orders, provider) })
}

func (e *Engine) captureMarginJob(id string, t *Trade, orders []market.MarginOrder, provider market.MarginProvider) {
	defer func() {
		e.lock()
		delete(e.marginInFlight, id)
		e.unlock()
	}()
	store := e.deps.Store
	setMargin := func(p MarginPatch) error {
		ctx, cancel := storeCtx()
		defer cancel()
		return store.SetMargin(ctx, id, p)
	}
	lastErr := "no response"
	for attempt := 1; attempt <= marginAttempts; attempt++ {
		if attempt > 1 {
			e.lock()
			deleted := e.deletedIDs[id]
			e.unlock()
			if deleted {
				return
			}
		}
		// STANDALONE basket: a paper trade must not be netted against whatever real
		// positions the broker account holds, which could shrink the figure.
		res, err := provider.BasketMargin(context.Background(), orders, false)
		if err == nil && (res.Source == market.MarginUnavailable || !jsx.Finite(res.Total)) {
			err = errors.New("the broker's margin calculator returned no figure")
		}
		if err == nil {
			e.lock()
			patch := MarginPatch{
				// A hedged basket can legitimately need little margin: accept a small figure.
				Margin:       fptr(math.Max(0, jsx.Round(res.Total))),
				MarginSource: sptr(string(res.Source)),
				MarginAt:     iptr(e.nowMs()),
			}
			if res.HedgeBenefit != nil && jsx.Finite(*res.HedgeBenefit) {
				patch.MarginHedgeBenefit = fptr(jsx.Round(*res.HedgeBenefit))
			}
			if res.Source == market.MarginDhanPerLegFallback {
				logf("margin for %s is a PER-LEG SUM (₹%s), not a netted basket figure: it OVERSTATES a hedged conversion/reversal.",
					t.Underlying, jsNumberString(*patch.Margin))
			}
			if e.deletedIDs[id] {
				e.unlock()
				return
			}
			e.applyMarginLocked(id, patch)
			e.unlock()
			if err := setMargin(patch); err != nil {
				logf("storing margin for %s failed: %v", t.Underlying, err)
			}
			e.lock()
			e.publishLocked()
			e.unlock()
			return
		}
		lastErr = err.Error()
		if attempt < marginAttempts {
			e.rt.sleep(time.Duration(1500*attempt) * time.Millisecond)
		}
	}
	logf("basket margin for %s unavailable: %s", t.Underlying, lastErr)
	e.lock()
	if e.deletedIDs[id] {
		e.unlock()
		return
	}
	// Stored too, so the reason survives a restart and shows on the closed row.
	failed := marginOf(t)
	failed.Margin = nil
	failed.MarginError = sptr(lastErr)
	e.applyMarginLocked(id, failed)
	e.unlock()
	_ = setMargin(failed)
	e.lock()
	e.publishLocked()
	e.unlock()
}

// applyMarginLocked patches margin onto whichever in-memory copy of the trade exists.
func (e *Engine) applyMarginLocked(id string, p MarginPatch) {
	if open, ok := e.positions.get(id); ok {
		open.applyMargin(p)
	}
	for _, c := range e.closedToday {
		if c.ID == id {
			c.applyMargin(p)
			break
		}
	}
}

// backfillMarginsLocked retries margin for open positions that still lack it (adopted
// after a restart, opened while the session was down, or whose capture failed), a few
// rounds each.
func (e *Engine) backfillMarginsLocked(now int64) {
	if e.deps.Margins == nil || now-e.lastMarginSweepAt < marginBackfillMs {
		return
	}
	e.lastMarginSweepAt = now
	active := e.activeBroker()
	authed := e.authenticated()
	for _, t := range e.positions.values() {
		if t.Margin != nil || e.marginInFlight[t.ID] {
			continue
		}
		if t.Broker != active {
			// Its tradingsymbols use the other broker's naming: say so rather than
			// showing "fetching…" for ever.
			if t.MarginError == nil {
				t.MarginError = sptr("Opened on " + t.Broker + "; margin is only asked from the broker a trade was opened on.")
			}
			continue
		}
		// Session down (or mid-switch): nothing would be asked, so it is not a round.
		if !authed || e.namespaceStale {
			continue
		}
		tries := e.marginBackfills[t.ID]
		if tries >= maxMarginBackfills {
			continue
		}
		e.marginBackfills[t.ID] = tries + 1
		e.captureMarginLocked(t.ID)
	}
}

/* ---------------------------------- delete ---------------------------------- */

// DeleteResult is the outcome of DeleteTrade. Status is the HTTP status of a refusal.
type DeleteResult struct {
	OK      bool
	From    string
	Already bool
	Status  int
	Error   string
}

func refuse(status int, msg string) DeleteResult { return DeleteResult{Status: status, Error: msg} }

// DeleteTrade soft-deletes a PAPER trade, open or closed, from every list and P&L
// figure. expected is the status the operator saw ("open", "closed" or ""): a trade that
// changed state meanwhile is refused (409), never deleted with the P&L it just booked.
// Retrying a delete whose write landed is safe. err is an unexpected storage failure.
func (e *Engine) DeleteTrade(id string, reason *string, actor, expected string) (DeleteResult, error) {
	e.lock()
	if !e.deps.Store.Enabled() {
		e.unlock()
		return refuse(503, "Paper-trade storage is not connected."), nil
	}
	audit := DeleteAudit{Reason: reason, Actor: actor, At: e.nowMs()}
	if open, ok := e.positions.get(id); ok {
		if expected == "closed" {
			e.unlock()
			return refuse(409, "This trade is open, not closed. Reload the page and try again."), nil
		}
		if e.closing[id] {
			e.unlock()
			return refuse(409, "This position is being closed right now. Wait for the exit, then delete it."), nil
		}
		// Hold it like a close, so the monitor cannot exit it while the delete is in flight.
		e.closing[id] = true
		e.unlock()
		outcome, err := e.markDeletedReconciled(id, "open", audit)
		e.lock()
		defer e.unlock()
		if err == nil && outcome == "deleted" {
			e.forgetOpenLocked(open)
		}
		delete(e.closing, id)
		if err != nil {
			return DeleteResult{}, err
		}
		if outcome == "closed" {
			return refuse(409, "This position closed while the delete was in flight. Nothing was deleted: it is "+
				"under Closed trades now, and can be deleted there."), nil
		}
		if outcome != "deleted" {
			return refuse(409, "The trade could not be deleted."), nil
		}
		e.afterDeleteLocked(id, open, "open", reason)
		return DeleteResult{OK: true, From: "open"}, nil
	}
	e.unlock()

	ctx, cancel := storeCtx()
	stored, err := e.deps.Store.Get(ctx, id)
	cancel()
	if err != nil {
		return DeleteResult{}, err
	}
	if stored == nil {
		return refuse(404, "No such paper trade."), nil
	}
	if stored.Deleted {
		// Already deleted (an earlier attempt whose answer was lost, or elsewhere): make
		// memory agree and report success, so retrying a delete is safe.
		e.lock()
		if e.forgetClosedLocked(id) {
			e.afterDeleteLocked(id, stored.Trade, "closed", reason)
		}
		e.unlock()
		from := stored.DeletedFrom
		if from == "" {
			from = "closed"
		}
		return DeleteResult{OK: true, From: from, Already: true}, nil
	}
	if stored.Status == "open" {
		// Open in the store but not in this process: another process is managing it.
		return refuse(409, "This position is open but not managed by this server process; it cannot be deleted here."), nil
	}
	if expected == "open" {
		reasonText := "closed"
		if stored.ExitReason != "" {
			reasonText = string(stored.ExitReason)
		}
		return refuse(409, fmt.Sprintf("This position closed while the confirmation was open (%s, net ₹%s after charges). "+
			"Nothing was deleted: it is under Closed trades now, and can be deleted there if you still want to.",
			reasonText, formatRoundedENIN(deref(stored.NetPnl)))), nil
	}
	outcome, err := e.markDeletedReconciled(id, "closed", audit)
	if err != nil {
		return DeleteResult{}, err
	}
	if outcome != "deleted" {
		return refuse(409, "The trade could not be deleted."), nil
	}
	e.lock()
	defer e.unlock()
	e.forgetClosedLocked(id)
	e.afterDeleteLocked(id, stored.Trade, "closed", reason)
	return DeleteResult{OK: true, From: "closed"}, nil
}

// markDeletedReconciled soft-deletes; when the write fails or matches nothing it reads
// the row back to learn what really happened (an acknowledgement can be lost after the
// write landed). Call without the lock.
func (e *Engine) markDeletedReconciled(id, from string, audit DeleteAudit) (string, error) {
	ctx, cancel := storeCtx()
	defer cancel()
	ok, writeErr := e.deps.Store.MarkDeleted(ctx, id, from, audit)
	if writeErr == nil && ok {
		return "deleted", nil
	}
	stored, err := e.deps.Store.Get(ctx, id)
	if err != nil {
		if writeErr != nil {
			return "", writeErr
		}
		return "", err
	}
	if stored != nil && stored.Deleted {
		return "deleted", nil
	}
	if writeErr != nil {
		return "", writeErr
	}
	if stored != nil {
		return stored.Status, nil
	}
	return "missing", nil
}

// forgetOpenLocked drops a deleted open position from memory and releases its legs.
func (e *Engine) forgetOpenLocked(t *Trade) {
	id := t.ID
	e.deletedIDs[id] = true
	e.closedIDs[id] = true
	e.positions.del(id)
	delete(e.metrics, id)
	delete(e.exitStreak, id)
	delete(e.exitSig, id)
	delete(e.retryAt, id)
	delete(e.unlinked, id)
	delete(e.marginBackfills, id)
	e.cooldownLocked(t.Underlying)
	e.applySubscriptionsLocked()
}

// forgetClosedLocked drops a deleted closed trade from today's list; true when listed.
func (e *Engine) forgetClosedLocked(id string) bool {
	e.deletedIDs[id] = true
	kept := make([]*Trade, 0, len(e.closedToday))
	for _, c := range e.closedToday {
		if c.ID != id {
			kept = append(kept, c)
		}
	}
	listed := len(kept) != len(e.closedToday)
	e.closedToday = kept
	return listed
}

// deletedEvent is the payload of the trade_deleted stream event.
type deletedEvent struct {
	ID   string `json:"id"`
	From string `json:"from"`
}

func (e *Engine) afterDeleteLocked(id string, t *Trade, from string, reason *string) {
	suffix := ""
	if reason != nil && *reason != "" {
		suffix = " — " + *reason
	}
	logf("paper trade DELETED (%s) %s %s K=%s%s", from, t.Direction, t.Underlying, jsNumberString(t.Strike), suffix)
	e.broadcastLocked("trade_deleted", deletedEvent{ID: id, From: from})
	e.refreshRowsLocked()
	e.publishLocked()
}

// CloseResult is the outcome of CloseManually.
type CloseResult struct {
	Trade  *Trade
	Status int
	Error  string
}

// CloseManually closes an open paper position now, at the executable touch. No
// feed-health or confirmation requirement; a price is never invented.
func (e *Engine) CloseManually(id string) CloseResult {
	e.lock()
	t, ok := e.positions.get(id)
	if !ok {
		e.unlock()
		return CloseResult{Status: 404, Error: "No open paper position with that id."}
	}
	now := e.nowMs()
	marketOpen := e.marketOpen()
	if !marketOpen {
		e.unlock()
		return CloseResult{Status: 409, Error: "The market is closed. A paper position can only be closed at a live touch."}
	}
	if e.namespaceStale || e.unlinked[id] {
		e.unlock()
		return CloseResult{Status: 409, Error: "This position's contracts are not resolved on the active broker yet."}
	}
	today := e.dayKey(now)
	m := e.priceExitLocked(t, now, today, marketOpen, true)
	e.metrics[id] = m
	closed := CloseTradeAtTouch(t, m, ExitManual, now, today, e.depthForLocked)
	if closed == nil {
		var thin []string
		for _, l := range m.Legs {
			if l.Executable {
				continue
			}
			var why string
			switch {
			case l.Price == nil:
				why = "no bid"
				if l.Side == "BUY" {
					why = "no ask"
				}
			case l.Reject == rejectCrossedBook:
				why = "crossed book: best bid ≥ best ask"
			case !l.Fresh:
				why = "stale book"
			default:
				why = "under one lot at the touch"
			}
			thin = append(thin, l.Tradingsymbol+" ("+why+")")
		}
		e.unlock()
		list := strings.Join(thin, ", ")
		if list == "" {
			list = "legs are not executable"
		}
		return CloseResult{Status: 409, Error: "Cannot close at the touch right now: " + list +
			". No fill is invented; the position stays open."}
	}
	op := e.finalizeLocked(t, closed)
	e.unlock()
	e.rt.await(op.done)
	if !op.ok {
		return CloseResult{Status: 409, Error: op.err}
	}
	return CloseResult{Trade: op.trade}
}
