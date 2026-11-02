// Package core serves the root routes of src/index.ts that no feature package owns:
// health and runtime status, the Zerodha (Kite) login, session and token routes, the
// admin risk-free rate, instruments and the F&O board, dividend yields, the history
// chart routes and spread stats. It also holds the helpers other packages share:
// DeriveFnoBoard, RequireMarketData, SendError, the risk-free-rate getter and the Kite
// session persistence (restored at boot on the same IST day). It places no orders.
package core

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	fjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// DefaultFrontendURL is index.ts's FRONTEND_URL default.
const DefaultFrontendURL = "http://localhost:5173"

// KiteClient is the part of *kite.Client the routes use (kite.ts KiteClient).
type KiteClient interface {
	LoginURL() string
	GenerateSession(ctx context.Context, requestToken string) (kite.SessionData, error)
	SetAccessToken(token string)
	HasSession() bool
	APIKey() string
	// AccessToken is "" when there is no session.
	AccessToken() string
	ClearSession()
	GetProfile(ctx context.Context) (json.RawMessage, error)
}

var _ KiteClient = (*kite.Client)(nil)

// Health is the part of the registry's activeHealth() (BrokerHealthState) the routes
// read.
type Health struct {
	Authenticated bool
	DataReady     bool
	TradingReady  bool
	Problems      []string
}

// RfStore persists the admin risk-free rate (app_settings 'rf_rate'); *store.Store
// implements it.
type RfStore interface {
	SaveRfRate(ctx context.Context, value float64) error
	LoadRfRate(ctx context.Context) (value float64, ok bool, err error)
}

// Deps are the collaborators, as index.ts wired them. Kite and Sessions are required;
// everything else has a default.
type Deps struct {
	// Kite is the Zerodha client (login URL, token exchange, session, profile).
	Kite KiteClient
	// Sessions is the admin session table (x-admin-token roles).
	Sessions *auth.Sessions

	// ActiveBroker is brokerManager.activeBroker; nil means Zerodha.
	ActiveBroker func() brokers.ID
	// ActiveHealth is brokerManager.activeHealth(); nil means Zerodha's health from the
	// Kite session alone (authenticated = data_ready = trading_ready = HasSession).
	ActiveHealth func() Health
	// FeedHealth is brokerManager.feedHealth(); nil means a feed that is down.
	FeedHealth func() brokers.FeedHealth
	// Generation is brokerManager.generation; nil means 0.
	Generation func() int64

	// Instruments is the ACTIVE broker's instrument universe
	// (brokerManager.instrumentProvider.load(): cached per broker, generation-scoped).
	// nil means an empty universe.
	Instruments func(ctx context.Context) ([]market.Instrument, error)
	// InstrumentsWire, when set, is the same universe as rows that write themselves the
	// way Node sent them (a Dhan row carries dhan_security_id, dhan_segment and
	// dhan_underlying_security_id after the Kite fields; registry.WireInstrument does
	// this). Only /api/instruments and /api/fno-stocks write whole rows; without it they
	// write the twelve Kite fields.
	InstrumentsWire func(ctx context.Context) ([]WireRow, error)

	// HistoricalOi is history.getHistoricalOi(token, from, to) on the active broker with
	// the default "interactive" priority (daily close + OI).
	HistoricalOi func(ctx context.Context, token int64, from, to string) ([]kite.DayOI, error)
	// Historical is history.getHistorical(token, from, to, interval), "interactive".
	Historical func(ctx context.Context, token int64, from, to, interval string) ([]kite.ClosePoint, error)

	// DividendYields is yahoo.ts getDividendYields(symbols) (captures.Service
	// DividendYields): every failure is a 0 % yield. nil means every symbol yields 0.
	DividendYields func(ctx context.Context, symbols []string) map[string]float64
	// SpreadSummary is SpreadSummary.findOne({symbol}).lean() (captures.Service
	// SpreadSummary): nil, nil when there is no row. nil means no database.
	SpreadSummary func(ctx context.Context, symbol string) (*captures.SpreadSummary, error)

	// Pool backs the default KiteSessions store; nil means no database.
	Pool *db.Pool
	// KiteSessions overrides the kite_session store (tests); nil means PGKiteSessions
	// over Pool.
	KiteSessions KiteSessionStore
	// RfStore persists the risk-free rate; nil means not persisted.
	RfStore RfStore

	// OnKiteLogin is triggerPostLoginBackfill: called after a successful token exchange
	// (POST /api/session, GET /callback), after the session is stored in memory and its
	// persistence queued. It must return quickly (start its work in the background).
	OnKiteLogin func()
	// OnKiteLogout is called after POST /api/logout cleared the session.
	OnKiteLogout func()
	// OnKiteSessionCleared is called whenever ClearKiteSession ran (logout, a Kite
	// 401/403 seen by SendError, a feed rejecting the token).
	OnKiteSessionCleared func()

	// FrontendURL is FRONTEND_URL (the /callback redirect base); "" means
	// DefaultFrontendURL.
	FrontendURL string
	// InternalTokenSecret is INTERNAL_TOKEN_SECRET (GET /api/internal/kite-token).
	InternalTokenSecret string
	// TokenRouteSecret is TOKEN_ROUTE_SECRET (GET /api/kite/token and GET /api/rf).
	TokenRouteSecret string

	// Now defaults to time.Now. It also drives the per-route rate limiters.
	Now func() time.Time
	// Location is the process time zone that index.ts's local-time Date arithmetic
	// (setMonth, setFullYear, setDate in the history routes) ran in; nil means
	// time.Local. Run with the TZ the Node service used.
	Location *time.Location
	// Sleep is the 200 ms pause between spread-history calls; nil means a timer that
	// ends early when ctx does.
	Sleep func(ctx context.Context, d time.Duration) error
	// Logf defaults to log.Printf.
	Logf func(format string, args ...any)
}

// Core holds the state index.ts kept at module scope for these routes.
type Core struct {
	d         Deps
	kite      KiteClient
	sessions  *auth.Sessions
	kiteStore KiteSessionStore
	now       func() time.Time
	loc       *time.Location
	sleep     func(ctx context.Context, d time.Duration) error
	logf      func(format string, args ...any)

	// base ends in-flight route work on Dispose. Route work does not end when a client
	// disconnects (Node kept running and filled its caches, and a Kite request_token is
	// single-use).
	base   context.Context
	cancel context.CancelFunc
	queue  *serialQueue

	mu            sync.Mutex
	rf            *float64 // adminRfRate; nil until an admin sets it
	dividends     *dividendEntry
	history       map[string]dayEntry
	spreadHistory map[string]dayEntry
	intraday      map[string]dayEntry
	minute        map[string]timedEntry
	fiveMin       map[string]timedEntry
}

type dayEntry struct {
	day  string
	body []byte
}

type timedEntry struct {
	at   int64 // epoch ms the data was stored
	body []byte
}

// New builds the routes' state. Nothing runs until Mount; call RestoreKiteSession and
// RestoreRfRate at boot.
func New(d Deps) (*Core, error) {
	if d.Kite == nil {
		return nil, errors.New("core: Deps.Kite is required")
	}
	if d.Sessions == nil {
		return nil, errors.New("core: Deps.Sessions is required")
	}
	c := &Core{
		d:             d,
		kite:          d.Kite,
		sessions:      d.Sessions,
		kiteStore:     d.KiteSessions,
		now:           d.Now,
		loc:           d.Location,
		sleep:         d.Sleep,
		logf:          d.Logf,
		queue:         newSerialQueue(),
		history:       map[string]dayEntry{},
		spreadHistory: map[string]dayEntry{},
		intraday:      map[string]dayEntry{},
		minute:        map[string]timedEntry{},
		fiveMin:       map[string]timedEntry{},
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.kiteStore == nil {
		c.kiteStore = &PGKiteSessions{Pool: d.Pool, Now: c.now}
	}
	if c.loc == nil {
		c.loc = time.Local
	}
	if c.sleep == nil {
		c.sleep = sleepCtx
	}
	if c.logf == nil {
		c.logf = log.Printf
	}
	if c.d.FrontendURL == "" {
		c.d.FrontendURL = DefaultFrontendURL
	}
	c.base, c.cancel = context.WithCancel(context.Background())
	return c, nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Dispose ends in-flight route work (history fetches, token exchanges) and waits until
// queued persistence (Kite session, risk-free rate) has been written.
func (c *Core) Dispose() {
	c.cancel()
	c.queue.wait()
}

// persistTimeout bounds one background database write.
const persistTimeout = 10 * time.Second

// background queues a persistence call (Node's fire-and-forget `void save().catch()`).
// Calls run one at a time in submission order, so a login followed by a logout is
// applied in that order.
func (c *Core) background(fn func(ctx context.Context)) {
	c.queue.push(func() {
		ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
		defer cancel()
		fn(ctx)
	})
}

// work returns the context route work runs under: it ignores the client going away
// and ends on Dispose.
func (c *Core) work(r *http.Request) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	stop := context.AfterFunc(c.base, cancel)
	return ctx, func() { stop(); cancel() }
}

// --- collaborators with defaults ---

func (c *Core) activeBroker() brokers.ID {
	if c.d.ActiveBroker == nil {
		return brokers.Zerodha
	}
	return c.d.ActiveBroker()
}

func (c *Core) activeHealth() Health {
	if c.d.ActiveHealth != nil {
		return c.d.ActiveHealth()
	}
	ok := c.kite.HasSession()
	h := Health{Authenticated: ok, DataReady: ok, TradingReady: ok, Problems: []string{}}
	if !ok {
		h.Problems = []string{"Zerodha is not connected"}
	}
	return h
}

func (c *Core) feedHealth() brokers.FeedHealth {
	if c.d.FeedHealth != nil {
		return c.d.FeedHealth()
	}
	return brokers.ComputeFeedHealth(brokers.FeedHealthInput{
		Authenticated: c.activeHealth().Authenticated, NowMs: c.now().UnixMilli(),
	})
}

func (c *Core) generation() int64 {
	if c.d.Generation == nil {
		return 0
	}
	return c.d.Generation()
}

// AllInstruments is getAllInstrumentsCached: the ACTIVE broker's instrument universe.
func (c *Core) AllInstruments(ctx context.Context) ([]market.Instrument, error) {
	if c.d.Instruments == nil {
		return nil, nil
	}
	return c.d.Instruments(ctx)
}

// WireRow is one instrument row together with the JSON object Node sent for it.
type WireRow struct {
	Instrument market.Instrument
	// JSON writes the row object; nil means the twelve Kite fields of Instrument.
	JSON fjson.Marshaler
}

// wireInstruments is the universe as wire rows (InstrumentsWire, else plain rows).
func (c *Core) wireInstruments(ctx context.Context) ([]WireRow, error) {
	if c.d.InstrumentsWire != nil {
		return c.d.InstrumentsWire(ctx)
	}
	all, err := c.AllInstruments(ctx)
	if err != nil {
		return nil, err
	}
	rows := make([]WireRow, len(all))
	for i := range all {
		rows[i].Instrument = all[i]
	}
	return rows, nil
}

// Board is deriveFnoBoard(await getAllInstrumentsCached()): what index.ts handed to the
// capture jobs, Synthetic and Fair Value as getBoard.
func (c *Core) Board(ctx context.Context) ([]BoardItem, error) {
	all, err := c.AllInstruments(ctx)
	if err != nil {
		return nil, err
	}
	return DeriveFnoBoard(all), nil
}

// RfPct is the admin-entered risk-free rate (%), nil until one is set (adminRfRate; the
// shape synthetic.Deps.GetRfPct takes).
func (c *Core) RfPct() *float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rf == nil {
		return nil
	}
	v := *c.rf
	return &v
}

// RestoreRfRate loads the persisted risk-free rate at boot (index.ts startup chain);
// failures are logged.
func (c *Core) RestoreRfRate(ctx context.Context) {
	if c.d.RfStore == nil {
		return
	}
	v, ok, err := c.d.RfStore.LoadRfRate(ctx)
	if err != nil {
		c.logf("[rf] restore failed: %v", err)
		return
	}
	if !ok {
		return
	}
	c.mu.Lock()
	c.rf = &v
	c.mu.Unlock()
	c.logf("[rf] Restored persisted risk-free rate: %s%%", jsNumberString(v))
}

// --- shared helpers other packages use ---

// SendError is index.ts sendError: a Kite error answers with its own status (which can
// be 200 when Kite answered HTTP 200 without "success") and {error: message}; a Kite
// 401/403 also clears the Kite session (memory and the persisted copy). Anything else
// is 500 {error: message}.
func (c *Core) SendError(w http.ResponseWriter, err error) {
	if ke, ok := kite.AsKiteError(err); ok {
		if ke.Status == http.StatusUnauthorized || ke.Status == http.StatusForbidden {
			c.ClearKiteSession()
		}
		httpx.Error(w, ke.Status, ke.Message)
		return
	}
	msg := "Unknown error"
	if err != nil {
		msg = err.Error()
	}
	httpx.Error(w, http.StatusInternalServerError, msg)
}

type marketDataRefusal struct {
	Error    string     `json:"error"`
	Broker   brokers.ID `json:"broker"`
	Problems []string   `json:"problems"`
}

// RequireMarketData is index.ts requireMarketData: true when the active broker's
// market-data session is usable; otherwise it answers 401 {error: "<what> requires a
// <Zerodha|Dhan> session. Connect <Zerodha|Dhan>.", broker, problems} and returns false.
func (c *Core) RequireMarketData(w http.ResponseWriter, what string) bool {
	h := c.activeHealth()
	if h.DataReady {
		return true
	}
	broker := c.activeBroker()
	label := "Zerodha"
	if broker == brokers.Dhan {
		label = "Dhan"
	}
	httpx.JSON(w, http.StatusUnauthorized, marketDataRefusal{
		Error:    what + " requires a " + label + " session. Connect " + label + ".",
		Broker:   broker,
		Problems: h.Problems,
	})
	return false
}

// requireFull is index.ts requireFullAdmin (header x-admin-token only).
func (c *Core) requireFull(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c.sessions.RoleOf(r) != auth.RoleFull {
			httpx.Error(w, http.StatusForbidden, "Full admin access required.")
			return
		}
		next(w, r)
	}
}

// Rate limits of the token routes (inventory api.md §0.4): 30 per minute per IP, one
// limiter instance per route.
const (
	tokenRouteWindow = time.Minute
	tokenRouteMax    = 30
)

// Mount registers the routes. The server applies CORS, the body parser and the global
// /api limiter first; per-route limiters run before authentication, as in Node.
func (c *Core) Mount(r chi.Router) {
	limiter := func() *httpx.Limiter { return httpx.NewLimiter(tokenRouteWindow, tokenRouteMax, "", c.now) }

	r.Get("/", c.health)
	r.Get("/api/status", c.status)
	r.Get("/api/internal/kite-token", limiter().Wrap(c.internalKiteToken))
	r.Get("/api/kite/token", limiter().Wrap(c.kiteToken))
	r.Post("/api/rf", c.requireFull(c.setRf))
	r.Get("/api/rf/current", c.rfCurrent)
	r.Get("/api/rf", limiter().Wrap(c.rfByPasscode))

	r.Get("/login", c.login)
	r.Get("/api/login", c.login)
	r.Post("/api/session", c.requireFull(c.session))
	r.Get("/callback", c.callback)
	r.Post("/api/logout", c.requireFull(c.logout))
	r.Get("/api/kite/access-token", c.requireFull(c.accessToken))
	r.Get("/api/profile", c.profile)

	r.Get("/api/instruments", c.instruments)
	r.Get("/api/fno-stocks", c.fnoStocks)
	r.Get("/api/fno-stocks/{symbol}", c.fnoStock)
	r.Get("/api/dividends", c.dividendYields)
	r.Get("/api/debug/indices", c.debugIndices)

	r.Get("/api/history/{symbol}", c.historyRoute)
	r.Get("/api/spread-history/{symbol}", c.spreadHistoryRoute)
	r.Get("/api/intraday/{symbol}", c.intradayRoute)
	r.Get("/api/minute/{symbol}", c.minuteRoute)
	r.Get("/api/fivemin/{symbol}", c.fiveMinRoute)
	r.Get("/api/fno-board", c.fnoBoard)
	r.Get("/api/spread-stats/{symbol}", c.spreadStats)
}

// --- the background queue ---

// serialQueue runs functions one at a time, in submission order, on its own goroutine.
type serialQueue struct {
	mu      sync.Mutex
	idle    *sync.Cond
	pending []func()
	active  bool
}

func newSerialQueue() *serialQueue {
	q := &serialQueue{}
	q.idle = sync.NewCond(&q.mu)
	return q
}

func (q *serialQueue) push(f func()) {
	q.mu.Lock()
	q.pending = append(q.pending, f)
	start := !q.active
	q.active = true
	q.mu.Unlock()
	if start {
		go q.drain()
	}
}

func (q *serialQueue) drain() {
	for {
		q.mu.Lock()
		if len(q.pending) == 0 {
			q.active = false
			q.idle.Broadcast()
			q.mu.Unlock()
			return
		}
		f := q.pending[0]
		q.pending = q.pending[1:]
		q.mu.Unlock()
		runSafely(f)
	}
}

// runSafely runs f, logging a panic instead of ending the queue goroutine (which would
// leave wait blocked for ever).
func runSafely(f func()) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("[core] background task panicked: %v", rec)
		}
	}()
	f()
}

// wait blocks until everything queued so far has run.
func (q *serialQueue) wait() {
	q.mu.Lock()
	for q.active {
		q.idle.Wait()
	}
	q.mu.Unlock()
}
