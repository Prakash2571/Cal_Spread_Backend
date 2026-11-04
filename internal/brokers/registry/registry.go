// Package registry is src/brokers/registry.ts (ActiveBrokerManager), the single authority
// on which broker owns the system, together with the broker-neutral providers built on it
// (instrumentProvider.ts, quoteProvider.ts, history.ts), the board diagnostics
// (boardDiagnostics.ts, indexSpot.ts) and the /api/broker/* and /api/dhan/* routes
// (routes.ts).
//
// Exactly one broker (Zerodha or Dhan) owns the market-data feeds at any instant. A
// switch tears the old broker down before the new one becomes reachable, advances the
// durable generation and reloads the universe. The Box feature is gone: its exposure
// checks always report idle, so the only switch blocker left is an unconfigured Dhan, and
// no execution adapter exists.
//
// Go synchronisation (Node relied on its single thread):
//   - (active, generation) is one immutable pair behind an atomic pointer; reads never
//     block, a switch replaces the pair in one store;
//   - switches, Dhan logins and Dhan logouts are serialised by opMu (Node let them
//     interleave at every await);
//   - the Dhan session lives under its own leaf lock, because the Dhan feed reads the
//     token with the feed's lock held;
//   - the registry's own lock is never held while calling a feed, a coordinator, the hub
//     or a hook, and every Dhan feed operation goes through a per-feed queue (serial).
package registry

import (
	"context"
	"log"
	"math"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// KiteAPI is the part of *kite.Client the registry and its providers use.
type KiteAPI interface {
	HasSession() bool
	APIKey() string
	AccessToken() string
	GetQuoteFull(ctx context.Context, identifiers []string) ([]kite.FullQuote, error)
	GetBasketMargin(ctx context.Context, orders []kite.BasketOrder, considerPositions bool) (kite.BasketMarginResult, error)
	GetInstruments(ctx context.Context, exchange string) ([]market.Instrument, error)
	GetHistoricalFull(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.HistoricalCandle, error)
	GetHistorical(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error)
	GetHistoricalOi(ctx context.Context, token int64, from, to string, prio kite.HistoricalPriority) ([]kite.DayOI, error)
	GetHistoricalOiSeries(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.OISeriesPoint, error)
}

// Hub is the part of *hub.Hub the registry drives: the Zerodha futures lane (the hub's
// own socket) and the fan-out that Dhan futures ticks are published through.
type Hub interface {
	IsConnected() bool
	SubscribedCount() int
	SubscribeTokens(tokens []int64)
	UnsubscribeTokens(tokens []int64)
	Stop()
	IngestExternalTicks(ticks []market.Tick)
	SetExternalConnected(connected bool)
}

// DhanFeed is the part of *dhan.Feed the registry drives.
type DhanFeed interface {
	IsConnected() bool
	SubscribedCount() int
	WantedCount() int
	LastTickAtMs() *int64
	FeedAgeMs() *int64
	SubscribeTokens(tokens []int64)
	UnsubscribeTokens(tokens []int64)
	EnsureSocket()
	Stop()
}

// LaneFeed is the part of *kite.ZerodhaFeed the registry drives (the second lane on
// Zerodha).
type LaneFeed interface {
	SubscribeTokens(tokens []int64)
	UnsubscribeTokens(tokens []int64)
	Stats() kite.LaneFeedStats
	Stop()
}

// DhanConfig points the Dhan integration at its hosts. Empty fields are production
// values; tests point every one at a loopback fake.
type DhanConfig struct {
	APIRoot         string   // default https://api.dhan.co/v2
	AuthRoot        string   // default https://auth.dhan.co
	FeedURL         string   // default wss://api-feed.dhan.co
	ScripMasterURLs []string // default the detailed master, then the plain one
	HTTPClient      *http.Client
	// Sleep is the REST pacing / retry wait (default a real timer).
	Sleep func(ctx context.Context, d time.Duration) error
	// ReconnectDelay overrides the feed back-off (default dhan.ReconnectDelay).
	ReconnectDelay func(attempt int) time.Duration
	Dialer         *websocket.Dialer
}

// Deps are the registry's collaborators.
type Deps struct {
	// Kite is the Zerodha client (*kite.Client); its in-memory token is the Zerodha
	// session.
	Kite KiteAPI
	// Hub is the ticker hub (*hub.Hub); nil means a hub that does nothing.
	Hub Hub
	// Store persists the selection and the Dhan session; nil means memory only (Node
	// without MongoDB). Production: &PGStore{Pool: pool}.
	Store Store
	// Lookup reads the environment at call time (unset and empty are different, as
	// with process.env); nil means os.LookupEnv.
	Lookup func(key string) (string, bool)
	// Now is the clock; nil means time.Now.
	Now func() time.Time

	Dhan DhanConfig
	// NewDhanFeed builds a Dhan socket; nil means dhan.NewFeed. The options arrive
	// complete (URL, dialer, clock, back-off filled in from Dhan and Now).
	NewDhanFeed func(opts dhan.FeedOptions) DhanFeed
	// NewLaneFeed builds the Zerodha second-lane socket; nil means kite.NewZerodhaFeed
	// with KiteConnect and KiteTickerURL.
	NewLaneFeed   func(opts kite.ZerodhaFeedOptions) LaneFeed
	KiteConnect   ticker.ConnectFunc
	KiteTickerURL string
	// BrokerLoginHTTPClient replaces only the shared token-service transport in tests.
	BrokerLoginHTTPClient *http.Client
	// BrokerLoginSleep substitutes the wait for a fresh token-API code in tests.
	BrokerLoginSleep func(context.Context, time.Duration) error
}

// Hooks are what the rest of the service plugs into the registry, attached once the
// consumers exist (Node: the constructor callbacks of index.ts and attach()). Every
// field may be nil. Hooks run without any registry lock held and must not block for
// long; the feed callbacks run on the feed's own goroutine.
type Hooks struct {
	// StopScanner stops discovery at the start of a switch (Node: Box stop, then
	// Synthetic stop; Go: Synthetic.Stop).
	StopScanner func()
	// DropMarketDataSessions invalidates every browser stream session (marketdata
	// SessionStore.DropAll) and returns how many were dropped.
	DropMarketDataSessions func() int
	// InvalidateBooks forgets every token of the old namespace (Synthetic and Fair Value
	// InvalidateNamespace). Also called when the active Dhan session ends.
	InvalidateBooks func()
	// ReloadUniverse rebuilds the consumers' token sets in the new namespace
	// (Synthetic.ReloadUniverse); an error is logged.
	ReloadUniverse func(ctx context.Context) error
	// Publish re-publishes runtime state (Node: the Box SSE snapshot, which no longer
	// exists; keep nil unless something wants the signal).
	Publish func()
	// OnBrokerChanged runs after a successful POST /api/broker/select (Node: Box
	// publishNow).
	OnBrokerChanged func(broker brokers.ID)
	// OnBoxLaneTicks receives every tick of the second lane (Synthetic.OnTicks). Box-lane
	// ticks never reach the hub.
	OnBoxLaneTicks func(ticks []market.Tick)
	// OnBoxLaneConnection receives the second lane's connection changes
	// (Synthetic.InvalidateBooks).
	OnBoxLaneConnection func(connected bool)
	// OnSessionLost runs when the active Dhan session dies (index.ts onSessionLost:
	// Synthetic.Stop).
	OnSessionLost func(broker brokers.ID, reason string)
}

type brokerState struct {
	active brokers.ID
	gen    int64
}

type dhanMeta struct {
	clientID        string
	clientName      string
	clientUcc       string
	powerOfAttorney bool
	loginDay        string
	loginAt         int64
	source          string
}

type ipVerdict struct {
	verified  *bool
	primary   *string
	secondary *string
	checkedAt *int64
	err       *string
}

const noTick = math.MinInt64

// Registry is ActiveBrokerManager.
type Registry struct {
	deps   Deps
	store  Store
	hub    Hub
	lookup func(string) (string, bool)
	get    config.Getter

	state         atomic.Pointer[brokerState]
	transitioning atomic.Bool
	lastTickAt    atomic.Int64

	opMu sync.Mutex
	// bg tracks the goroutines the registry starts on its own (the post-login master
	// warm-up, session-lost handling), so tests can wait for them.
	bg sync.WaitGroup

	sessMu      sync.Mutex
	dhanToken   *string
	dhanExpiry  *int64
	dhanMeta    *dhanMeta
	brokerLogin *brokerLoginController

	mu               sync.Mutex
	hooks            Hooks
	dhanFeed         *dhanLane
	boxDhanFeed      *dhanLane
	boxLaneFeed      LaneFeed
	lastMarginSource *market.MarginSource
	ip               ipVerdict

	dhanHTTP        *dhan.HTTP
	dhanClient      *dhan.Client
	dhanInstruments *dhan.InstrumentStore

	subscriptions    *brokers.Coordinator
	boxSubscriptions *brokers.Coordinator
	instruments      *InstrumentProvider
	quotes           *QuoteProvider
	history          *HistoryProvider
}

// New builds the registry: Dhan active by default, generation 1, no Dhan session,
// nothing connected. DEFAULT_BROKER changes the fresh-start fallback; Restore adopts
// a saved selection before StartActiveRuntime brings its session back up at boot.
func New(deps Deps) *Registry {
	if deps.Lookup == nil {
		deps.Lookup = os.LookupEnv
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	r := &Registry{deps: deps, store: deps.Store, hub: deps.Hub, lookup: deps.Lookup}
	if r.store == nil {
		r.store = memoryStore{}
	}
	if r.hub == nil {
		r.hub = noHub{}
	}
	r.get = func(k string) string { v, _ := r.lookup(k); return v }
	r.brokerLogin = newBrokerLoginController(r.get, deps.BrokerLoginHTTPClient)
	initial := brokers.Dhan
	if configured, ok := brokers.Parse(r.get("DEFAULT_BROKER")); ok {
		initial = configured
	}
	r.state.Store(&brokerState{active: initial, gen: 1})
	r.lastTickAt.Store(noTick)

	httpCfg := dhan.HTTPConfigFromEnv(r.get)
	httpCfg.AccessToken = r.usableDhanToken
	httpCfg.ClientID = r.dhanClientID
	httpCfg.APIRoot = deps.Dhan.APIRoot
	httpCfg.Client = deps.Dhan.HTTPClient
	httpCfg.Now = deps.Now
	httpCfg.Sleep = deps.Dhan.Sleep
	r.dhanHTTP = dhan.NewHTTP(httpCfg)
	r.dhanClient = dhan.NewClient(r.dhanHTTP, r.dhanClientID)
	r.dhanInstruments = dhan.NewInstrumentStore(dhan.InstrumentStoreOptions{
		URLs: deps.Dhan.ScripMasterURLs, Client: deps.Dhan.HTTPClient, Now: deps.Now,
	})

	// EVERY market-data subscription goes through a coordinator, which diffs refcounts and
	// only then touches the ACTIVE broker's socket for that lane.
	r.subscriptions = brokers.NewCoordinator(laneTransport{r, brokers.LaneFutures}, brokers.LaneFutures)
	r.boxSubscriptions = brokers.NewCoordinator(laneTransport{r, brokers.LaneBox}, brokers.LaneBox)
	r.instruments = &InstrumentProvider{r: r, caches: map[brokers.ID]*instrumentCache{},
		generationAt: map[brokers.ID]int64{}, inFlight: map[brokers.ID]*instrumentLoad{}}
	r.quotes = &QuoteProvider{r: r}
	r.history = &HistoryProvider{r: r}
	return r
}

// Attach installs the hooks (Node attach(), plus the constructor callbacks whose
// consumers are built after the registry). Calling it again replaces them.
func (r *Registry) Attach(h Hooks) {
	r.mu.Lock()
	r.hooks = h
	r.mu.Unlock()
}

func (r *Registry) getHooks() Hooks {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hooks
}

func (r *Registry) now() time.Time { return r.deps.Now() }
func (r *Registry) nowMs() int64   { return r.deps.Now().UnixMilli() }

// background runs fn on its own goroutine (Node's fire-and-forget promises).
func (r *Registry) background(fn func()) {
	r.bg.Add(1)
	go func() {
		defer r.bg.Done()
		fn()
	}()
}

// getParseReport is the most recent Dhan master parse report (a process-wide value, as
// the module-level lastParseReport was in Node); a variable so tests can isolate it.
var getParseReport = dhan.GetParseReport

/* ------------------------------- identity -------------------------------- */

// ActiveBroker is the broker that owns the system now (auth.BrokerControl).
func (r *Registry) ActiveBroker() brokers.ID { return r.state.Load().active }

// Generation is the broker/feed generation, bumped on every switch and durable across
// restarts.
func (r *Registry) Generation() int64 { return r.state.Load().gen }

// Switching is true while a broker switch is in progress.
func (r *Registry) Switching() bool { return r.transitioning.Load() }

// NoteTick records that a tick arrived (feed health). Both lanes call it; index.ts also
// called it from the Box engine's hub listener, which only existed while Box ran.
func (r *Registry) NoteTick() { r.lastTickAt.Store(r.nowMs()) }

func (r *Registry) lastTick() *int64 {
	v := r.lastTickAt.Load()
	if v == noTick {
		return nil
	}
	return &v
}

// Subscriptions is the futures/data lane's coordinator (board, browsers, Fair Value).
func (r *Registry) Subscriptions() *brokers.Coordinator { return r.subscriptions }

// BoxSubscriptions is the second lane's coordinator (API name "box"; Synthetic's
// scanner owner).
func (r *Registry) BoxSubscriptions() *brokers.Coordinator { return r.boxSubscriptions }

// InstrumentProvider is the active broker's instrument universe.
func (r *Registry) InstrumentProvider() *InstrumentProvider { return r.instruments }

// QuoteProvider is the active broker's REST quotes by internal token.
func (r *Registry) QuoteProvider() *QuoteProvider { return r.quotes }

// HistoryProvider is the active broker's historical candles (index.ts `history`).
func (r *Registry) HistoryProvider() *HistoryProvider { return r.history }

// DhanClient is the Dhan REST client (read-only endpoints).
func (r *Registry) DhanClient() *dhan.Client { return r.dhanClient }

// DhanInstrumentStore is the cached Dhan instrument master.
func (r *Registry) DhanInstrumentStore() *dhan.InstrumentStore { return r.dhanInstruments }

// AssertActiveBrokerToken reports whether token belongs to the active broker's loaded
// universe; with no universe loaded it cannot tell and allows it. A rejection is logged
// loudly: it means some caller holds a board from another broker.
func (r *Registry) AssertActiveBrokerToken(token int64, context string) bool {
	owned, known := r.instruments.OwnsToken(token)
	if !known || owned {
		return true
	}
	st := r.state.Load()
	log.Printf("[Broker] REJECTED token %d in %s: it does not belong to the active broker (%s, generation %d). This is a cross-broker token leak.",
		token, context, st.active, st.gen)
	return false
}

/* ------------------------------ subscriptions ----------------------------- */

type laneTransport struct {
	r    *Registry
	lane brokers.Lane
}

func (t laneTransport) SubscribeTokens(tokens []int64)   { t.r.subscribeUpstream(t.lane, tokens) }
func (t laneTransport) UnsubscribeTokens(tokens []int64) { t.r.unsubscribeUpstream(t.lane, tokens) }

// subscribeUpstream subscribes on the ACTIVE broker's socket for this lane only. It runs
// inside a coordinator call, so it must not block or call a coordinator.
func (r *Registry) subscribeUpstream(lane brokers.Lane, tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	active := r.ActiveBroker()
	if lane == brokers.LaneBox {
		if active == brokers.Zerodha {
			r.ensureBoxLaneFeed().SubscribeTokens(append([]int64(nil), tokens...))
		} else {
			r.ensureBoxDhanFeed().subscribe(tokens)
		}
		return
	}
	if active == brokers.Zerodha {
		r.hub.SubscribeTokens(append([]int64(nil), tokens...))
		return
	}
	r.ensureDhanFeed().subscribe(tokens)
}

func (r *Registry) unsubscribeUpstream(lane brokers.Lane, tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	active := r.ActiveBroker()
	r.mu.Lock()
	boxLane, boxDhan, futDhan := r.boxLaneFeed, r.boxDhanFeed, r.dhanFeed
	r.mu.Unlock()
	if lane == brokers.LaneBox {
		if active == brokers.Zerodha {
			if boxLane != nil {
				boxLane.UnsubscribeTokens(append([]int64(nil), tokens...))
			}
		} else if boxDhan != nil {
			boxDhan.unsubscribe(tokens)
		}
		return
	}
	if active == brokers.Zerodha {
		r.hub.UnsubscribeTokens(append([]int64(nil), tokens...))
		return
	}
	if futDhan != nil {
		futDhan.unsubscribe(tokens)
	}
}

// AcquireBrowserTokens takes a browser lease (one per SSE client) on the futures lane;
// the returned function releases it (idempotent).
func (r *Registry) AcquireBrowserTokens(tokens []int64) func() {
	return r.subscriptions.Acquire(brokers.OwnerBrowser, tokens).Release
}

// SetSyntheticTokens declares the Synthetic scanner's whole token set on the second lane
// (owner "scanner").
func (r *Registry) SetSyntheticTokens(tokens []int64) {
	r.boxSubscriptions.SetOwnerTokens(brokers.OwnerScanner, tokens)
}

// SetAnalyticsTokens declares Fair Value's whole token set on the futures lane (owner
// "analytics"; index.ts `subscriptions.setOwnerTokens("analytics", ...)`).
func (r *Registry) SetAnalyticsTokens(tokens []int64) {
	r.subscriptions.SetOwnerTokens(brokers.OwnerAnalytics, tokens)
}

// AnalyticsTokenBudget is index.ts Fair Value tokenBudget: 2800 minus the futures-lane
// tokens some other owner holds, never below 0.
func (r *Registry) AnalyticsTokenBudget() float64 {
	priority := 0
	for _, t := range r.subscriptions.ActiveTokens() {
		if c := r.subscriptions.CountsFor(t); c != nil && c.Total > c.Analytics {
			priority++
		}
	}
	return math.Max(0, float64(2800-priority))
}

/* ---------------------------------- feeds --------------------------------- */

func (r *Registry) dhanClientID() string {
	r.sessMu.Lock()
	meta := r.dhanMeta
	r.sessMu.Unlock()
	if meta != nil {
		return meta.clientID
	}
	return jsTrim(r.get("DHAN_CLIENT_ID"))
}

func (r *Registry) newDhanFeed(opts dhan.FeedOptions) DhanFeed {
	opts.URL = r.deps.Dhan.FeedURL
	opts.Dialer = r.deps.Dhan.Dialer
	opts.Now = r.deps.Now
	opts.ReconnectDelay = r.deps.Dhan.ReconnectDelay
	if r.deps.NewDhanFeed != nil {
		return r.deps.NewDhanFeed(opts)
	}
	return dhan.NewFeed(opts)
}

// ensureDhanFeed is the futures-lane Dhan socket, built lazily so a Zerodha-only
// deployment never makes one.
func (r *Registry) ensureDhanFeed() *dhanLane {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.dhanFeed == nil {
		lane := &dhanLane{}
		lane.feed = r.newDhanFeed(dhan.FeedOptions{
			AccessToken: r.usableDhanToken,
			ClientID:    r.dhanClientID,
			OnTicks: func(ticks []market.Tick) {
				// index.ts onDhanTicks: liveness, then the shared hub fan-out.
				r.NoteTick()
				r.hub.IngestExternalTicks(ticks)
			},
			OnConnection: func(connected bool) {
				r.hub.SetExternalConnected(connected)
				if h := r.getHooks(); h.Publish != nil {
					h.Publish()
				}
			},
			OnSessionLost: func(reason string) { r.background(func() { r.onDhanFeedSessionLost(lane, reason) }) },
			Resolve:       r.dhanInstruments.Identify,
			DepthLevel:    5,
		})
		r.dhanFeed = lane
	}
	return r.dhanFeed
}

// ensureBoxDhanFeed is the second lane's Dhan socket (Dhan permits five per user).
func (r *Registry) ensureBoxDhanFeed() *dhanLane {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.boxDhanFeed == nil {
		lane := &dhanLane{}
		lane.feed = r.newDhanFeed(dhan.FeedOptions{
			AccessToken: r.usableDhanToken,
			ClientID:    r.dhanClientID,
			OnTicks: func(ticks []market.Tick) {
				r.NoteTick()
				if h := r.getHooks(); h.OnBoxLaneTicks != nil {
					h.OnBoxLaneTicks(ticks)
				}
			},
			OnConnection: func(connected bool) {
				if h := r.getHooks(); h.OnBoxLaneConnection != nil {
					h.OnBoxLaneConnection(connected)
				}
			},
			OnSessionLost: func(reason string) { r.background(func() { r.onDhanFeedSessionLost(lane, reason) }) },
			Resolve:       r.dhanInstruments.Identify,
			DepthLevel:    5,
		})
		r.boxDhanFeed = lane
	}
	return r.boxDhanFeed
}

// ensureBoxLaneFeed is the second lane's Zerodha socket (the second of the three Kite
// allows per API key).
func (r *Registry) ensureBoxLaneFeed() LaneFeed {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.boxLaneFeed == nil {
		opts := kite.ZerodhaFeedOptions{
			Lane: kite.LaneBox,
			Credentials: func() kite.Credentials {
				return kite.Credentials{APIKey: r.deps.Kite.APIKey(), AccessToken: r.deps.Kite.AccessToken()}
			},
			Generation: r.Generation,
			OnTicks: func(ticks []market.Tick) {
				r.NoteTick()
				if h := r.getHooks(); h.OnBoxLaneTicks != nil {
					h.OnBoxLaneTicks(ticks)
				}
			},
			OnConnectionChange: func(connected bool) {
				if h := r.getHooks(); h.OnBoxLaneConnection != nil {
					h.OnBoxLaneConnection(connected)
				}
			},
			OnDead: func(message string) {
				log.Printf("[Broker] box lane (zerodha) feed died: %s", message)
			},
			Now:       r.deps.Now,
			Connect:   r.deps.KiteConnect,
			TickerURL: r.deps.KiteTickerURL,
		}
		if r.deps.NewLaneFeed != nil {
			r.boxLaneFeed = r.deps.NewLaneFeed(opts)
		} else {
			r.boxLaneFeed = kite.NewZerodhaFeed(opts)
		}
	}
	return r.boxLaneFeed
}

func (r *Registry) currentDhanFeed() *dhanLane {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dhanFeed
}

// stopAllLanes stops BOTH lanes of BOTH brokers. The second-lane feeds are forgotten
// (the next use builds fresh ones under the new generation); the futures Dhan feed is
// kept, stopped but restartable, as in Node.
func (r *Registry) stopAllLanes() {
	r.mu.Lock()
	futDhan, boxLane, boxDhan := r.dhanFeed, r.boxLaneFeed, r.boxDhanFeed
	r.boxLaneFeed, r.boxDhanFeed = nil, nil
	r.mu.Unlock()
	attempt := func(what string, fn func()) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[Broker] %s failed: %v", what, rec)
			}
		}()
		fn()
	}
	attempt("tickerHub.stop()", r.hub.Stop)
	if futDhan != nil {
		attempt("dhanFeed.stop()", futDhan.stop)
	}
	if boxLane != nil {
		attempt("boxZerodhaFeed.stop()", boxLane.Stop)
	}
	if boxDhan != nil {
		attempt("boxDhanFeed.stop()", boxDhan.stop)
	}
}

// StartActiveFeed starts the ACTIVE broker's feed, never the inactive one. Zerodha's hub
// connects lazily on subscribe, so there is nothing to do for it. It returns once the
// Dhan socket has been initiated (after any feed operation queued before it), so it must
// not be called while holding a lock a market-data consumer takes.
func (r *Registry) StartActiveFeed() {
	if r.ActiveBroker() == brokers.Dhan {
		r.ensureDhanFeed().ensureSocket()
	}
}

// StopFeeds stops both lanes of both brokers (shutdown). Positions, orders and
// persisted state are untouched, and the coordinators keep their tables.
func (r *Registry) StopFeeds() { r.stopAllLanes() }

// flushFeeds waits until every queued Dhan feed operation has run (tests).
func (r *Registry) flushFeeds() {
	r.mu.Lock()
	lanes := []*dhanLane{r.dhanFeed, r.boxDhanFeed}
	r.mu.Unlock()
	for _, l := range lanes {
		if l != nil {
			l.flush()
		}
	}
}

// flushLane waits for one lane's queued Dhan feed operations. Only for callers that hold
// no consumer lock (switch, login): a queued unsubscribe may be waiting for a tick
// delivery that needs one.
func (r *Registry) flushLane(lane brokers.Lane) {
	r.mu.Lock()
	l := r.dhanFeed
	if lane == brokers.LaneBox {
		l = r.boxDhanFeed
	}
	r.mu.Unlock()
	if l != nil {
		l.flush()
	}
}

/* ------------------------------ observability ------------------------------ */

// LaneStats is the per-lane feed summary (laneStats).
func (r *Registry) LaneStats(lane brokers.Lane) brokers.LaneFeedStats {
	st := r.state.Load()
	gen := int(st.gen)
	var wanted int
	if lane == brokers.LaneBox {
		wanted = r.boxSubscriptions.Size()
	} else {
		wanted = r.subscriptions.Size()
	}
	empty := brokers.LaneFeedStats{Lane: lane, WantedTokens: wanted, Generation: gen}
	r.mu.Lock()
	boxLane, boxDhan, futDhan := r.boxLaneFeed, r.boxDhanFeed, r.dhanFeed
	r.mu.Unlock()
	dhanStats := func(l *dhanLane) brokers.LaneFeedStats {
		return brokers.LaneFeedStats{
			Lane: lane, Connected: l.feed.IsConnected(), SubscribedTokens: l.feed.SubscribedCount(),
			WantedTokens: l.feed.WantedCount(), LastTickAgeMs: l.feed.FeedAgeMs(), Generation: gen,
		}
	}
	if lane == brokers.LaneBox {
		if st.active == brokers.Zerodha {
			if boxLane == nil {
				return empty
			}
			s := boxLane.Stats()
			return brokers.LaneFeedStats{
				Lane: brokers.Lane(s.Lane), Connected: s.Connected, SubscribedTokens: s.SubscribedTokens,
				WantedTokens: s.WantedTokens, TicksPerSecond: s.TicksPerSecond, LastTickAgeMs: s.LastTickAgeMs,
				Reconnects: s.Reconnects, Generation: int(s.Generation),
			}
		}
		if boxDhan == nil {
			return empty
		}
		return dhanStats(boxDhan)
	}
	if st.active == brokers.Dhan {
		if futDhan == nil {
			return empty
		}
		return dhanStats(futDhan)
	}
	var age *int64
	if last := r.lastTick(); last != nil {
		a := max(0, r.nowMs()-*last)
		age = &a
	}
	return brokers.LaneFeedStats{
		Lane: brokers.LaneFutures, Connected: r.hub.IsConnected(), SubscribedTokens: r.hub.SubscribedCount(),
		WantedTokens: wanted, LastTickAgeMs: age, Generation: gen,
	}
}

// FeedConnected reports the active broker's futures-lane socket.
func (r *Registry) FeedConnected() bool {
	if r.ActiveBroker() == brokers.Zerodha {
		return r.hub.IsConnected()
	}
	if f := r.currentDhanFeed(); f != nil {
		return f.feed.IsConnected()
	}
	return false
}

// SubscribedCount is how many tokens the futures coordinator wants upstream.
func (r *Registry) SubscribedCount() int { return r.subscriptions.Size() }

// UpstreamFeedStats is what the active broker's socket was asked for versus what it
// confirmed (upstreamFeedStats). Key order is the contract.
type UpstreamFeedStats struct {
	Broker          brokers.ID `json:"broker"`
	Wanted          *int       `json:"wanted"`
	Subscribed      *int       `json:"subscribed"`
	SocketConnected bool       `json:"socket_connected"`
	LastTickAt      *int64     `json:"last_tick_at"`
}

// UpstreamFeedStats reports the futures-lane socket of the active broker.
func (r *Registry) UpstreamFeedStats() UpstreamFeedStats {
	if r.ActiveBroker() == brokers.Dhan {
		out := UpstreamFeedStats{Broker: brokers.Dhan}
		if f := r.currentDhanFeed(); f != nil {
			w, s := f.feed.WantedCount(), f.feed.SubscribedCount()
			out.Wanted, out.Subscribed = &w, &s
			out.SocketConnected = f.feed.IsConnected()
			out.LastTickAt = f.feed.LastTickAtMs()
		}
		return out
	}
	n := r.hub.SubscribedCount()
	n2 := n
	return UpstreamFeedStats{
		Broker: brokers.Zerodha, Wanted: &n, Subscribed: &n2,
		SocketConnected: r.hub.IsConnected(), LastTickAt: r.lastTick(),
	}
}

// FeedHealth is the truthful feed summary: connection AND subscriptions AND data.
func (r *Registry) FeedHealth() brokers.FeedHealth {
	st := r.state.Load()
	return r.feedHealthFor(st.active)
}

func (r *Registry) feedHealthFor(active brokers.ID) brokers.FeedHealth {
	session := r.SessionFor(active)
	var universe *int
	if n := r.instruments.sizeFor(active); n > 0 {
		universe = &n
	}
	return brokers.ComputeFeedHealth(brokers.FeedHealthInput{
		Connected:     r.feedConnectedFor(active),
		Connecting:    r.transitioning.Load(),
		Authenticated: session.Authenticated && (active == brokers.Zerodha || r.dhanDataEnabled()),
		Subscribed:    r.subscriptions.Size(),
		Universe:      universe,
		LastTickAt:    r.lastTick(),
		NowMs:         r.nowMs(),
	})
}

func (r *Registry) feedConnectedFor(active brokers.ID) bool {
	if active == brokers.Zerodha {
		return r.hub.IsConnected()
	}
	if f := r.currentDhanFeed(); f != nil {
		return f.feed.IsConnected()
	}
	return false
}

// Snapshot is the body of GET /api/broker/status (registry.ts snapshot()). Key order is
// the contract.
type Snapshot struct {
	Broker                  brokers.ID           `json:"broker"`
	Session                 SessionState         `json:"session"`
	Health                  HealthState          `json:"health"`
	DhanConfigured          bool                 `json:"dhan_configured"`
	DhanInstruments         int                  `json:"dhan_instruments"`
	DhanInstrumentsLoadedAt *int64               `json:"dhan_instruments_loaded_at"`
	DhanStaticIP            StaticIPState        `json:"dhan_static_ip"`
	LastMarginSource        *market.MarginSource `json:"last_margin_source"`
	Generation              int64                `json:"generation"`
	Feed                    brokers.FeedHealth   `json:"feed"`
	Subscriptions           brokers.Stats        `json:"subscriptions"`
	Instruments             int                  `json:"instruments"`
	InstrumentsLoadedAt     *int64               `json:"instruments_loaded_at"`
}

// Snapshot is the status-endpoint diagnostics.
func (r *Registry) Snapshot() Snapshot {
	st := r.state.Load()
	_, credsOK, _ := r.DhanCredentials()
	r.mu.Lock()
	var source *market.MarginSource
	if r.lastMarginSource != nil {
		s := *r.lastMarginSource
		source = &s
	}
	r.mu.Unlock()
	return Snapshot{
		Broker:                  st.active,
		Session:                 r.SessionFor(st.active),
		Health:                  r.HealthFor(st.active),
		DhanConfigured:          credsOK,
		DhanInstruments:         r.dhanInstruments.Size(),
		DhanInstrumentsLoadedAt: r.dhanInstruments.LastLoadedAt(),
		DhanStaticIP:            r.DhanStaticIPState(),
		LastMarginSource:        source,
		Generation:              st.gen,
		Feed:                    r.feedHealthFor(st.active),
		Subscriptions:           r.subscriptions.Stats(),
		Instruments:             r.instruments.sizeFor(st.active),
		InstrumentsLoadedAt:     r.instruments.loadedAtFor(st.active),
	}
}

// noHub is the hub of a registry built without one.
type noHub struct{}

// The production collaborators satisfy the interfaces.
var (
	_ KiteAPI  = (*kite.Client)(nil)
	_ Hub      = (*hub.Hub)(nil)
	_ DhanFeed = (*dhan.Feed)(nil)
	_ LaneFeed = (*kite.ZerodhaFeed)(nil)
)

func (noHub) IsConnected() bool                 { return false }
func (noHub) SubscribedCount() int              { return 0 }
func (noHub) SubscribeTokens([]int64)           {}
func (noHub) UnsubscribeTokens([]int64)         {}
func (noHub) Stop()                             {}
func (noHub) IngestExternalTicks([]market.Tick) {}
func (noHub) SetExternalConnected(bool)         {}
