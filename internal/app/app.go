// Package app wires the service together the way src/index.ts did at module scope. New
// builds every component exactly once and connects them (hub listeners, registry hooks,
// the Kite "token rejected" path, the post-login backfills); Handler is the shared
// middleware with every route group mounted; Start runs the boot chain of index.ts's
// listen callback; Shutdown runs its graceful-shutdown sequence. cmd/server is only the
// process shell around this (environment, listener, signals), so everything here can be
// tested without main.
//
// Box is gone: nothing here builds a Box module, /api/box/* answers like any unknown
// route, and the two Box shutdown steps are dropped.
package app

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/analytics"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/registry"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/calendar"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/core"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kv"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/lifecycle"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/marketdata"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/store"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/synthetic"
)

// Defaults of the Go-only timings.
const (
	// DefaultPurgeInterval is how often expired cache rows and expired admin-session rows
	// are deleted (Node relied on Redis TTLs and never deleted session rows).
	DefaultPurgeInterval = 10 * time.Minute
	// HTTPDrainGrace is index.ts HTTP_DRAIN_GRACE_MS: how long in-flight requests may
	// finish before the remaining connections (SSE streams) are closed.
	HTTPDrainGrace = 3 * time.Second

	dbOpenTimeout    = 30 * time.Second // Mongoose's default server-selection timeout
	dbMigrateTimeout = 5 * time.Minute
)

// Options are what tests (and only tests, apart from the defaults) change. Every zero
// value is the production behaviour.
type Options struct {
	// Pool, when not nil, is used instead of opening cfg.DatabaseURL (tests pass
	// dbtest.New). Migrations still run; Shutdown closes it.
	Pool *db.Pool
	// LookupEnv reads the environment for the feature packages; unset and empty differ,
	// as with process.env. nil means os.LookupEnv. cfg.Env, when set, must read the same
	// source.
	LookupEnv func(key string) (string, bool)

	// KiteAPIRoot, KiteLoginRoot and KiteHTTPClient replace the Kite REST endpoints.
	KiteAPIRoot    string
	KiteLoginRoot  string
	KiteHTTPClient *http.Client
	// TickerConnect and KiteTickerURL replace the Kite ticker WebSocket of the hub and of
	// the second lane.
	TickerConnect ticker.ConnectFunc
	KiteTickerURL string
	// Dhan points the Dhan integration at other hosts.
	Dhan                  registry.DhanConfig
	BrokerLoginHTTPClient *http.Client
	// YahooChartRoot and YahooHTTPClient replace the dividend-yield endpoint.
	YahooChartRoot  string
	YahooHTTPClient *http.Client

	// PurgeInterval is the expired-row purge cadence (DefaultPurgeInterval when <= 0).
	PurgeInterval time.Duration
	// Logf receives the app's own log lines (log.Printf when nil).
	Logf func(format string, args ...any)
}

// App is the assembled service.
type App struct {
	cfg    config.Config
	opts   Options
	get    config.Getter
	lookup func(string) (string, bool)
	logf   func(format string, args ...any)

	pool      *db.Pool
	cache     *kv.Cache
	store     *store.Store
	kite      *kite.Client
	hub       *hub.Hub
	sessions  *auth.Sessions
	reg       *registry.Registry
	mdStore   *marketdata.SessionStore
	core      *core.Core
	analytics *analytics.Service
	calendar  *calendar.Service
	captures  *captures.Service
	synth     *synthetic.Engine
	fv        *fairvalue.Engine
	fvRows    *fvInstruments

	handler  http.Handler
	server   *http.Server
	inflight atomic.Int64
	coord    *lifecycle.Coordinator

	mu               sync.Mutex
	started          bool
	stopping         bool
	bootCancel       context.CancelFunc
	bootDone         chan struct{}
	bootTasks        sync.WaitGroup // the Synthetic and Fair Value boots (void boot() in Node)
	analyticsStarted bool
	stopSweeper      func()
	stopPurge        func()

	// trace, when set (tests, before Start), sees the boot steps, the hooks and the
	// shutdown steps as they run. It must be safe for concurrent use.
	trace func(event string)
}

// New builds every component once, in index.ts's dependency order, and wires them.
// It fails when Node failed at startup: without KITE_API_KEY / KITE_API_SECRET (the
// KiteClient constructor threw at module load) or with an invalid Fair Value
// configuration that the engine refuses. A DATABASE_URL that cannot be opened or
// migrated is logged and the service continues memory-only, as Node did when MongoDB
// could not be reached.
func New(cfg config.Config, opts Options) (*App, error) {
	a := &App{cfg: cfg, opts: opts, lookup: opts.LookupEnv, logf: opts.Logf}
	if a.lookup == nil {
		a.lookup = os.LookupEnv
	}
	if a.logf == nil {
		a.logf = log.Printf
	}
	a.get = cfg.Env
	if a.get == nil {
		a.get = func(k string) string { v, _ := a.lookup(k); return v }
	}
	if a.opts.PurgeInterval <= 0 {
		a.opts.PurgeInterval = DefaultPurgeInterval
	}

	// index.ts: `const kite = new KiteClient(...)`, the first thing the module did.
	kc, err := kite.NewClient(kite.Config{
		APIKey: cfg.KiteAPIKey, APISecret: cfg.KiteAPISecret,
		APIRoot: opts.KiteAPIRoot, LoginRoot: opts.KiteLoginRoot, HTTPClient: opts.KiteHTTPClient,
	})
	if err != nil {
		return nil, err
	}
	a.kite = kc

	a.pool = a.openDatabase()
	built := false
	defer func() {
		// A pool this call opened must not outlive a failed New.
		if !built && opts.Pool == nil {
			a.pool.Close()
		}
	}()
	a.cache = kv.New(a.pool, nil)
	a.store = store.New(a.pool, nil)
	a.sessions = auth.NewSessions(a.store, nil)

	// One shared Kite WebSocket fanned out to every SSE client. Its "token rejected"
	// callback is index.ts's: clear the Kite session (memory and the persisted copy),
	// then onFeedSessionLost.
	a.hub = hub.New(hub.Deps{
		Creds:     func() hub.Creds { return hub.Creds{APIKey: kc.APIKey(), AccessToken: kc.AccessToken()} },
		OnDead:    a.onFeedTokenRejected,
		Connect:   opts.TickerConnect,
		TickerURL: opts.KiteTickerURL,
	})

	a.reg = registry.New(registry.Deps{
		Kite:                  kc,
		Hub:                   a.hub,
		Store:                 &registry.PGStore{Pool: a.pool},
		Lookup:                a.lookup,
		Dhan:                  opts.Dhan,
		KiteConnect:           opts.TickerConnect,
		KiteTickerURL:         opts.KiteTickerURL,
		BrokerLoginHTTPClient: opts.BrokerLoginHTTPClient,
	})
	reg := a.reg
	history := reg.HistoryProvider()
	quotes := reg.QuoteProvider()
	a.fvRows = &fvInstruments{provider: reg.InstrumentProvider()}

	// Browser market-data subscription sessions (the store a broker switch empties).
	a.mdStore = marketdata.NewSessionStore(marketdata.SessionStoreOptions{})

	a.core, err = core.New(core.Deps{
		Kite:                kc,
		Sessions:            a.sessions,
		ActiveBroker:        reg.ActiveBroker,
		ActiveHealth:        a.coreHealth,
		FeedHealth:          reg.FeedHealth,
		Generation:          reg.Generation,
		Instruments:         a.loadInstruments,
		InstrumentsWire:     a.wireRows,
		HistoricalOi:        a.historicalOi,
		Historical:          a.historical,
		DividendYields:      a.dividendYields,
		SpreadSummary:       a.spreadSummary,
		Pool:                a.pool,
		RfStore:             a.store,
		OnKiteLogin:         a.onKiteLogin,
		FrontendURL:         cfg.FrontendURL,
		InternalTokenSecret: cfg.InternalTokenSecret,
		TokenRouteSecret:    cfg.TokenRouteSecret,
	})
	if err != nil {
		return nil, err
	}
	c := a.core

	a.analytics = analytics.New(analytics.Deps{
		Instruments:        c.AllInstruments,
		QuoteFull:          kc.GetQuoteFull,
		Historical:         history.GetHistorical,
		HistoricalOiSeries: history.GetHistoricalOiSeries,
		QuotesByToken:      quotes.QuotesByToken,
		CaptureAllowed:     analytics.ZerodhaCaptureGate(reg.ActiveBroker, kc.HasSession, log.Printf),
		MarketData:         a.analyticsReadiness,
		SendError:          c.SendError,
		Cache:              a.cache,
		ExtraSessionDays:   cfg.ExtraSessionDays,
	})

	a.calendar = calendar.New(calendar.Deps{
		Pool:              a.pool,
		Sessions:          a.sessions,
		RequireMarketData: a.calendarMarketData,
		Instruments:       c.AllInstruments,
		Board:             core.DeriveFnoBoard,
		Hub:               a.hub,
		Kite:              kc,
		ClearKiteSession:  c.ClearKiteSession,
	})

	a.captures = captures.New(captures.Deps{
		Pool:              a.pool,
		Kite:              kc,
		GetBoard:          c.Board,
		GetAllInstruments: c.AllInstruments,
		GetLatestTick:     a.hub.GetLatestTick,
		Env:               a.get,
		LookupEnv:         a.lookup,
		YahooChartRoot:    opts.YahooChartRoot,
		HTTPClient:        opts.YahooHTTPClient,
	})

	// Futures vs synthetic-futures scanner, paper trading only. Its tokens ride the
	// second lane under the "scanner" owner; with Box gone the lane's other user is
	// always idle.
	synthCfg := synthetic.LoadConfig(a.get)
	a.synth = synthetic.NewEngine(synthetic.Deps{
		GetAllInstruments: c.AllInstruments,
		GetBoard:          a.synthBoard,
		MarketData:        reg.MarketData(),
		GetRfPct:          c.RfPct,
		ActiveBroker:      reg.ActiveBroker,
		SetTokens:         reg.SetSyntheticTokens,
		Store:             synthetic.NewRepository(a.pool),
		Margins:           reg.Margins(),
		BoxLane:           synthetic.IdleBoxLane(a.get),
		Switching:         reg.Switching,
		BrokerGeneration:  reg.Generation,
		Config:            &synthCfg,
	})

	// Full-admin read-only analytics on the futures lane's spare budget.
	fvCfg, fvDisabled := fairvalue.ConfigFromEnv(a.lookup, float64(time.Now().UnixMilli()))
	a.fv, err = fairvalue.NewEngine(fairvalue.Deps{
		GetAllInstruments:   a.fvRows.load,
		GetBoard:            a.fairValueBoard,
		MetadataVersion:     a.metadataVersion,
		ActiveBroker:        func() string { return string(reg.ActiveBroker()) },
		BrokerGeneration:    func() float64 { return float64(reg.Generation()) },
		DataReady:           func() bool { return reg.ActiveHealth().DataReady },
		Switching:           reg.Switching,
		ForceDisabledReason: fvDisabled,
		SetTokens:           reg.SetAnalyticsTokens,
		TokenBudget:         reg.AnalyticsTokenBudget,
		RetainFeed:          a.hub.RetainFanout,
		FeedStatus:          func() any { return reg.LaneStats(brokers.LaneFutures) },
		Store:               &fairvalue.PGStore{Pool: a.pool},
		Config:              &fvCfg,
	})
	if err != nil {
		return nil, fmt.Errorf("fair value: %w", err)
	}
	reg.Subscriptions().SetAnalyticsYield(a.fv.YieldToPriority)
	// Futures feed liveness belongs to the app, independent of an analytics
	// scanner. Box formerly supplied this listener; it no longer exists.
	a.hub.AddTickListener(func(ticks []market.Tick) {
		if reg.ActiveBroker() == brokers.Zerodha && len(ticks) > 0 {
			reg.NoteTick()
		}
	})
	a.hub.AddTickListener(a.fv.IngestTicks)
	a.hub.AddConnectionListener(func(bool) { a.fv.Invalidate() })

	// brokerManager.attach(): the teardown hooks a switch needs, plus the constructor
	// callbacks whose consumers exist only now.
	reg.Attach(registry.Hooks{
		StopScanner: func() {
			a.note("hook: stop scanner")
			a.synth.Stop()
		},
		DropMarketDataSessions: func() int {
			a.note("hook: drop market-data sessions")
			return a.mdStore.DropAll()
		},
		InvalidateBooks: func() {
			a.note("hook: invalidate books")
			a.synth.InvalidateNamespace()
			a.fv.InvalidateNamespace()
		},
		ReloadUniverse: func(ctx context.Context) error {
			a.note("hook: reload universe")
			if err := a.synth.ReloadUniverse(ctx); err != nil {
				a.logf("[Synthetic] universe reload after broker switch failed: %v", err)
			}
			return nil
		},
		// Publish and OnBrokerChanged were Box's SSE publishNow; nothing listens now.
		OnBoxLaneTicks:      a.synth.OnTicks,
		OnBoxLaneConnection: func(bool) { a.synth.InvalidateBooks() },
		OnSessionLost: func(brokers.ID, string) {
			a.note("hook: session lost")
			a.synth.Stop()
		},
	})

	a.handler = server.New(server.Options{FrontendOrigin: cfg.FrontendURL}, a.mounts()...)
	a.server = &http.Server{
		Handler: a.track(a.handler),
		// Node 22's server defaults: headersTimeout 60 s, keepAliveTimeout 5 s, 16 KiB of
		// headers. There is no write timeout: SSE responses are long-lived.
		ReadHeaderTimeout: 60 * time.Second,
		IdleTimeout:       5 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	a.coord = lifecycle.NewCoordinator(a.shutdownSteps(), shutdownTimeout(a.get), a.logf, nil)
	built = true
	return a, nil
}

// openDatabase is initDb: connect and migrate when DATABASE_URL is set. A failure is
// logged and the service runs memory-only, as Node did when MongoDB was unreachable.
func (a *App) openDatabase() *db.Pool {
	pool := a.opts.Pool
	if pool == nil {
		if a.cfg.DatabaseURL == "" {
			a.logf("DATABASE_URL is not set — persistence is DISABLED (trades, sessions, captures and caches are memory-only). Set it in .env to enable it.")
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), dbOpenTimeout)
		p, err := db.Open(ctx, a.cfg.DatabaseURL)
		cancel()
		if err != nil {
			a.logf("Failed to connect to PostgreSQL: %v — persistence is DISABLED.", err)
			return nil
		}
		pool = p
	}
	if !pool.Enabled() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), dbMigrateTimeout)
	err := pool.Migrate(ctx)
	cancel()
	if err != nil {
		a.logf("PostgreSQL migrations failed: %v — persistence is DISABLED.", err)
		pool.Close()
		return nil
	}
	a.logf("Connected to PostgreSQL.")
	return pool
}

// mounts lists every route group, in index.ts's registration order.
func (a *App) mounts() []func(chi.Router) {
	sessions := a.sessions
	return []func(chi.Router){
		a.core.Mount,
		(&auth.Routes{Sessions: sessions, AdminSecret: a.cfg.AdminSecret, AccessSecret: a.cfg.AccessSecret, Brokers: a.reg}).Mount,
		a.analytics.Mount,
		a.calendar.Mount,
		func(r chi.Router) { synthetic.Register(r, a.synth, synthetic.RouteDeps{Role: sessions.Role}) },
		func(r chi.Router) {
			fairvalue.Mount(r, fairvalue.RouteDeps{Engine: a.fv, IsFullAdmin: func(t string) bool { return sessions.Role(t) == auth.RoleFull }})
		},
		func(r chi.Router) {
			marketdata.Mount(r, marketdata.RouteDeps{
				Sessions:                a.mdStore,
				Hub:                     a.hub,
				ActiveBroker:            a.reg.ActiveBroker,
				Generation:              func() int { return int(a.reg.Generation()) },
				DataHealth:              a.dataHealth,
				AssertActiveBrokerToken: a.reg.AssertActiveBrokerToken,
				QuotesByToken:           a.reg.QuoteProvider().QuotesByToken,
				ClearKiteSession:        a.core.ClearKiteSession,
				AcquireBrowserTokens:    a.reg.AcquireBrowserTokens,
				FeedHealth:              a.reg.FeedHealth,
				Subscriptions:           a.reg.Subscriptions().Stats,
				BoxSubscriptions:        a.reg.BoxSubscriptions().Stats,
				LaneStats:               a.reg.LaneStats,
				UpstreamFeedStats:       a.upstreamStats,
				BoardSize:               a.boardSize,
				IsFullAdmin:             func(r *http.Request) bool { return sessions.RoleOf(r) == auth.RoleFull },
			})
		},
		func(r chi.Router) {
			registry.Mount(r, registry.RouteDeps{Registry: a.reg, Sessions: sessions, IndexSpotMap: registry.IndexSpotMap})
		},
	}
}

// Handler is the HTTP handler: CORS, the body parser and the /api limiter, every route
// group, and Express's HTML 404 for anything else (including /api/box/*).
func (a *App) Handler() http.Handler { return a.handler }

// Serve accepts connections on l until Shutdown (http.ErrServerClosed then).
func (a *App) Serve(l net.Listener) error { return a.server.Serve(l) }

// track counts handlers in flight, so the HTTP shutdown step can wait for the ones its
// forced close interrupted (SSE cleanup: lease release, hub detach).
func (a *App) track(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.inflight.Add(1)
		defer a.inflight.Add(-1)
		next.ServeHTTP(w, r)
	})
}

// onFeedTokenRejected is the TickerHub callback of index.ts: Zerodha rejected the token,
// so the session is cleared in memory and in kite_session, then onFeedSessionLost runs
// (Box's book reset is gone; Synthetic stops discovery).
func (a *App) onFeedTokenRejected() {
	a.note("hook: kite token rejected")
	a.core.ClearKiteSession()
	a.synth.Stop()
}

// onKiteLogin is triggerPostLoginBackfill: the hourly and EOD backfills, then the
// option-OI chain (captures, backfills, previous close, coarsening, flush).
func (a *App) onKiteLogin() {
	a.captures.PostLogin()
	a.analytics.OnKiteLogin()
}

func (a *App) note(event string) {
	if a.trace != nil {
		a.trace(event)
	}
}

// shutdownTimeout is SHUTDOWN_TIMEOUT_MS (default 12000). Values that are not a positive
// number of milliseconds fall back to the default.
func shutdownTimeout(get config.Getter) time.Duration {
	ms := config.Num(get, "SHUTDOWN_TIMEOUT_MS", float64(lifecycle.DefaultTimeout.Milliseconds()))
	if ms <= 0 {
		return lifecycle.DefaultTimeout
	}
	return time.Duration(ms * float64(time.Millisecond))
}
