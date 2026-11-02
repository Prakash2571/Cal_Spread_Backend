package marketdata

// The market-data HTTP surface (src/marketDataRoutes.ts): REST quote snapshots, the
// session and legacy SSE tick streams, and the feed status/diagnostics snapshots. Every
// broker-specific fact comes through RouteDeps, so cmd/server wires the broker registry
// in without this package importing it.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/boundedcache"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const (
	// MaxQuoteTokens caps one REST quote request.
	MaxQuoteTokens = 4000
	// QuotesTTL is how long a REST quote snapshot is served from the cache.
	QuotesTTL = 4000 * time.Millisecond
	// QuotesCacheEntries bounds the quote cache: its key holds the caller's token set and
	// the route is public.
	QuotesCacheEntries = 256
)

// Hub is the part of the ticker hub the routes use; *hub.Hub implements it.
type Hub interface {
	// AttachClient registers an SSE client for fan-out (never opens a socket) and queues the
	// cached ticks for its tokens. The returned detach must be called before the route
	// returns (see hub.Hub.AttachClient).
	AttachClient(c hub.Client, tokens []int64) (detach func())
	// Seed puts REST ticks into the hub's latest-tick cache.
	Seed(ticks []market.Tick)
}

// Sessions is the part of SessionStore the routes use; *SessionStore implements it.
type Sessions interface {
	Create(tokens []int64, broker brokers.ID, generation int) Session
	Resolve(id string, broker brokers.ID, generation int) (Session, Rejection)
	Open(id string)
	Close(id string)
	Stats() SessionStats
}

var (
	_ Hub      = (*hub.Hub)(nil)
	_ Sessions = (*SessionStore)(nil)
)

// UpstreamStats is registry.upstreamFeedStats(): what the active broker's socket was asked
// for and what it confirmed. Wanted and Subscribed are nil (null) while the Dhan feed
// object does not exist yet. Field order is the JSON key order.
type UpstreamStats struct {
	Broker          brokers.ID `json:"broker"`
	Wanted          *int       `json:"wanted"`
	Subscribed      *int       `json:"subscribed"`
	SocketConnected bool       `json:"socket_connected"`
	LastTickAt      *int64     `json:"last_tick_at"`
}

// RouteDeps are marketDataRoutes.ts MarketDataDeps, with the broker manager split into the
// small functions the routes call. Fields marked required make Mount panic when nil.
type RouteDeps struct {
	// Sessions is the shared session store, the one a broker switch empties (required).
	Sessions Sessions
	// Hub is the ticker hub (required).
	Hub Hub

	// ActiveBroker is brokerManager.activeBroker (required).
	ActiveBroker func() brokers.ID
	// Generation is brokerManager.generation (required).
	Generation func() int
	// DataHealth is activeHealth().data_ready and .problems (required).
	DataHealth func() (ready bool, problems []string)
	// AssertActiveBrokerToken is brokerManager.assertActiveBrokerToken(token, context):
	// false only for a token outside the loaded universe of the active broker (it logs the
	// rejection with context). nil accepts every token, like a universe not loaded yet.
	AssertActiveBrokerToken func(token int64, context string) bool
	// QuotesByToken is quoteProvider.quotesByToken (required): REST snapshot ticks of the
	// active broker. A *kite.KiteError answers with its own status (and a 401/403 also
	// calls ClearKiteSession); any other error answers 500 with its message (sendError).
	QuotesByToken func(ctx context.Context, tokens []int64) ([]market.Tick, error)
	// ClearKiteSession clears the Kite session in memory and in the database, as sendError
	// does on a Kite 401/403. nil does nothing.
	ClearKiteSession func()
	// AcquireBrowserTokens is brokerManager.acquireBrowserTokens (required): a browser
	// lease on the futures lane; the returned release is called exactly once.
	AcquireBrowserTokens func(tokens []int64) (release func())

	// FeedHealth is brokerManager.feedHealth() (required).
	FeedHealth func() brokers.FeedHealth
	// Subscriptions is brokerManager.subscriptions.stats(), the futures lane (required).
	Subscriptions func() brokers.Stats
	// BoxSubscriptions is brokerManager.boxSubscriptions.stats(), the second lane (required).
	BoxSubscriptions func() brokers.Stats
	// LaneStats is brokerManager.laneStats(lane) (required).
	LaneStats func(lane brokers.Lane) brokers.LaneFeedStats
	// UpstreamFeedStats is brokerManager.upstreamFeedStats() (required).
	UpstreamFeedStats func() UpstreamStats
	// BoardSize is the F&O board size for diagnostics. An error, a panic or a nil func
	// reports null (Node: boardSize().catch(() => null)).
	BoardSize func(ctx context.Context) (int, error)
	// IsFullAdmin is index.ts requireFullAdmin: whether the request's x-admin-token is a
	// live full-admin session (cmd/server: sessions.RoleOf(r) == auth.RoleFull). nil denies.
	IsFullAdmin func(r *http.Request) bool

	// PingInterval is the SSE keep-alive period (default hub.PingInterval, 20 s).
	PingInterval time.Duration
	// NewTicker makes the keep-alive ticker; tests replace it. Default time.NewTicker.
	NewTicker func(d time.Duration) (c <-chan time.Time, stop func())
	// Now is the quote cache's clock (default time.Now).
	Now func() time.Time
}

// Mount registers the routes of registerMarketDataRoutes on r: POST/GET /api/quotes,
// POST /api/stream/session, GET /api/stream/session/{id} and GET /api/stream (SSE),
// GET /api/market-data/status and GET /api/market-data/diagnostics (full admin). CORS, the
// JSON body parser and the global /api limiter are the server's (internal/server). Every
// Mount has its own quote cache. It panics if a required dependency is missing.
func Mount(r chi.Router, d RouteDeps) {
	rt := newRoutes(d)
	r.Post("/api/quotes", rt.postQuotes)
	r.Get("/api/quotes", rt.getQuotes)
	r.Post("/api/stream/session", rt.createSession)
	r.Get("/api/stream/session/{id}", rt.sessionStream)
	r.Get("/api/stream", rt.legacyStream)
	r.Get("/api/market-data/status", rt.status)
	r.Get("/api/market-data/diagnostics", rt.diagnostics)
}

type routes struct {
	d     RouteDeps
	cache *boundedcache.Cache[[]market.Tick]
}

func newRoutes(d RouteDeps) *routes {
	var missing []string
	for _, dep := range []struct {
		name string
		nil  bool
	}{
		{"Sessions", d.Sessions == nil},
		{"Hub", d.Hub == nil},
		{"ActiveBroker", d.ActiveBroker == nil},
		{"Generation", d.Generation == nil},
		{"DataHealth", d.DataHealth == nil},
		{"QuotesByToken", d.QuotesByToken == nil},
		{"AcquireBrowserTokens", d.AcquireBrowserTokens == nil},
		{"FeedHealth", d.FeedHealth == nil},
		{"Subscriptions", d.Subscriptions == nil},
		{"BoxSubscriptions", d.BoxSubscriptions == nil},
		{"LaneStats", d.LaneStats == nil},
		{"UpstreamFeedStats", d.UpstreamFeedStats == nil},
	} {
		if dep.nil {
			missing = append(missing, dep.name)
		}
	}
	if len(missing) > 0 {
		panic("marketdata.Mount: missing RouteDeps." + strings.Join(missing, ", RouteDeps."))
	}
	if d.PingInterval <= 0 {
		d.PingInterval = hub.PingInterval
	}
	if d.NewTicker == nil {
		d.NewTicker = func(p time.Duration) (<-chan time.Time, func()) {
			t := time.NewTicker(p)
			return t.C, t.Stop
		}
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	return &routes{d: d, cache: boundedcache.New[[]market.Tick](QuotesTTL, QuotesCacheEntries, d.Now)}
}

// ---------------------------------------------------------------------------------------
// Response bodies. Field order is the JSON key order Node produced.

type notReadyBody struct {
	Error    string     `json:"error"`
	Broker   brokers.ID `json:"broker"`
	Problems []string   `json:"problems"`
}

type foreignTokensBody struct {
	Error       string     `json:"error"`
	Broker      brokers.ID `json:"broker"`
	Generation  int        `json:"generation"`
	StaleTokens []int64    `json:"stale_tokens"`
}

type sessionRefusalBody struct {
	Error      string     `json:"error"`
	Broker     brokers.ID `json:"broker"`
	Generation int        `json:"generation"`
}

type sessionCreatedBody struct {
	ID         string     `json:"id"`
	Tokens     int        `json:"tokens"`
	Broker     brokers.ID `json:"broker"`
	Generation int        `json:"generation"`
}

// tickList encodes ticks as JSON.stringify did: bids/asks are written whenever the
// producer supplied them, even when empty (encoding/json's omitempty would drop "[]").
type tickList []market.Tick

func (t tickList) AppendJS(dst []byte) []byte { return append(dst, hub.TicksJSON(t)...) }

type quotesBody struct {
	Ticks  tickList   `json:"ticks"`
	Broker brokers.ID `json:"broker"`
	Cached bool       `json:"cached"`
}

// ---------------------------------------------------------------------------------------
// REST quotes

// postQuotes is POST /api/quotes { tokens: [...] }, the transport the board uses.
func (rt *routes) postQuotes(w http.ResponseWriter, r *http.Request) {
	tokens, msg := ParseTokenList(bodyTokens(r), MaxQuoteTokens)
	if msg != "" {
		httpx.Error(w, http.StatusBadRequest, msg)
		return
	}
	rt.serveQuotes(w, r, tokens)
}

// getQuotes is the legacy GET /api/quotes?tokens=a,b,… (lenient CSV).
func (rt *routes) getQuotes(w http.ResponseWriter, r *http.Request) {
	tokens := queryTokens(r.URL.RawQuery)
	if len(tokens) == 0 {
		httpx.Error(w, http.StatusBadRequest, "Provide ?tokens=token1,token2,... or POST { tokens: [...] } for large sets.")
		return
	}
	if len(tokens) > MaxQuoteTokens {
		httpx.Error(w, http.StatusBadRequest, "Too many tokens; POST /api/quotes instead.")
		return
	}
	rt.serveQuotes(w, r, tokens)
}

// bodyTokens is (req.body as { tokens?: unknown } | undefined)?.tokens.
func bodyTokens(r *http.Request) any {
	if m, ok := httpx.Body(r).(map[string]any); ok {
		return m["tokens"]
	}
	return nil
}

// serveQuotes is the one path both quote transports take: readiness (401), the token
// namespace (409), the 4 s cache keyed by broker, generation and the sorted token set,
// then the active broker's REST quote, which also seeds the hub cache for late SSE
// joiners. Both GET and POST report "POST /api/quotes" to the namespace check, as Node did.
func (rt *routes) serveQuotes(w http.ResponseWriter, r *http.Request, tokens []int64) {
	broker := rt.d.ActiveBroker()
	if ready, problems := rt.d.DataHealth(); !ready {
		httpx.JSON(w, http.StatusUnauthorized, notReadyBody{
			Error: "Quotes require a " + string(broker) + " session.", Broker: broker, Problems: problems,
		})
		return
	}
	if rt.refuseForeign(w, tokens, "POST /api/quotes") {
		return
	}
	key := quoteCacheKey(broker, rt.d.Generation(), tokens)
	if ticks, ok := rt.cache.Get(key); ok {
		httpx.JSON(w, http.StatusOK, quotesBody{Ticks: ticks, Broker: broker, Cached: true})
		return
	}
	// Node kept going when the browser went away mid-request (the cache and the hub were
	// still filled), so the upstream call is not tied to this request's cancellation.
	ticks, err := rt.d.QuotesByToken(context.WithoutCancel(r.Context()), tokens)
	if err != nil {
		rt.sendError(w, err)
		return
	}
	rt.cache.Set(key, ticks)
	rt.d.Hub.Seed(ticks)
	// Node read the broker again after the await, for the log line and the response.
	broker = rt.d.ActiveBroker()
	log.Printf("[Quotes] broker=%s requested=%d returned=%d", broker, len(tokens), len(ticks))
	httpx.JSON(w, http.StatusOK, quotesBody{Ticks: ticks, Broker: broker, Cached: false})
}

// quoteCacheKey is `${broker}:${generation}:${tokens sorted ascending, joined by ","}`.
func quoteCacheKey(broker brokers.ID, generation int, tokens []int64) string {
	sorted := append([]int64(nil), tokens...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	b := make([]byte, 0, len(broker)+12+len(sorted)*11)
	b = append(b, broker...)
	b = append(b, ':')
	b = strconv.AppendInt(b, int64(generation), 10)
	b = append(b, ':')
	for i, t := range sorted {
		if i > 0 {
			b = append(b, ',')
		}
		b = strconv.AppendInt(b, t, 10)
	}
	return string(b)
}

// sendError is index.ts sendError: a Kite error answers with its own status (which can be
// 200 when Kite reported a failure in an HTTP 200), and a 401/403 also clears the Kite
// session; anything else is 500. The body is {"error": message}.
func (rt *routes) sendError(w http.ResponseWriter, err error) {
	if ke, ok := kite.AsKiteError(err); ok {
		if ke.Status == http.StatusUnauthorized || ke.Status == http.StatusForbidden {
			if rt.d.ClearKiteSession != nil {
				rt.d.ClearKiteSession()
			}
		}
		httpx.Error(w, ke.Status, ke.Message)
		return
	}
	httpx.Error(w, http.StatusInternalServerError, err.Error())
}

// refuseForeign answers 409 when any token is outside the active broker's namespace. Every
// token is checked (each rejection is logged by the registry); the body lists the first 10.
func (rt *routes) refuseForeign(w http.ResponseWriter, tokens []int64, context string) bool {
	var foreign []int64
	for _, t := range tokens {
		if rt.d.AssertActiveBrokerToken != nil && !rt.d.AssertActiveBrokerToken(t, context) {
			foreign = append(foreign, t)
		}
	}
	if len(foreign) == 0 {
		return false
	}
	broker := rt.d.ActiveBroker()
	stale := foreign
	if len(stale) > 10 {
		stale = stale[:10]
	}
	httpx.JSON(w, http.StatusConflict, foreignTokensBody{
		Error: fmt.Sprintf("%d requested token(s) do not belong to the active broker (%s). Refetch the board.",
			len(foreign), broker),
		Broker: broker, Generation: rt.d.Generation(), StaleTokens: stale,
	})
	return true
}

// refuseLivePrices is the 401 of the stream routes, which name the broker by its label.
func refuseLivePrices(w http.ResponseWriter, broker brokers.ID, problems []string) {
	label := "Zerodha"
	if broker == brokers.Dhan {
		label = "Dhan"
	}
	httpx.JSON(w, http.StatusUnauthorized, notReadyBody{
		Error:  "Live prices require a " + label + " session. Connect " + label + ".",
		Broker: broker, Problems: problems,
	})
}

// ---------------------------------------------------------------------------------------
// SSE

// createSession is POST /api/stream/session: exchange a token list for a session id, so
// the stream URL stays constant-size. Order: 400 (parse), 401 (readiness), 409 (namespace).
func (rt *routes) createSession(w http.ResponseWriter, r *http.Request) {
	tokens, msg := ParseTokenList(bodyTokens(r), MaxSessionTokens)
	if msg != "" {
		httpx.Error(w, http.StatusBadRequest, msg)
		return
	}
	if ready, problems := rt.d.DataHealth(); !ready {
		refuseLivePrices(w, rt.d.ActiveBroker(), problems)
		return
	}
	if rt.refuseForeign(w, tokens, "POST /api/stream/session") {
		return
	}
	s := rt.d.Sessions.Create(tokens, rt.d.ActiveBroker(), rt.d.Generation())
	log.Printf("[SSE] session created id=%s… tokens=%d broker=%s generation=%d", prefix8(s.ID), len(s.Tokens), s.Broker, s.Generation)
	httpx.JSON(w, http.StatusOK, sessionCreatedBody{ID: s.ID, Tokens: len(s.Tokens), Broker: s.Broker, Generation: s.Generation})
}

// sessionStream is GET /api/stream/session/{id}. An unknown id is 404 (mint a new one); a
// session from another broker or generation is 409 and deleted by Resolve.
func (rt *routes) sessionStream(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	broker, generation := rt.d.ActiveBroker(), rt.d.Generation()
	s, rejection := rt.d.Sessions.Resolve(id, broker, generation)
	switch rejection {
	case RejectNone:
	case RejectNotFound:
		httpx.JSON(w, http.StatusNotFound, sessionRefusalBody{
			Error: "Unknown or expired market-data session. Create a new one.", Broker: broker, Generation: generation,
		})
		return
	default:
		httpx.JSON(w, http.StatusConflict, sessionRefusalBody{
			Error:  "This market-data session belongs to a previous broker selection. Refetch the board.",
			Broker: broker, Generation: generation,
		})
		return
	}
	rt.d.Sessions.Open(s.ID)
	rt.openTickStream(w, r, s.Tokens, "session "+prefix8(s.ID)+"…", func() { rt.d.Sessions.Close(s.ID) })
}

// legacyStream is GET /api/stream?tokens=a,b,… (lenient CSV, no upper limit).
func (rt *routes) legacyStream(w http.ResponseWriter, r *http.Request) {
	tokens := queryTokens(r.URL.RawQuery)
	if len(tokens) == 0 {
		httpx.Error(w, http.StatusBadRequest, "Provide ?tokens=token1,token2,... — or POST /api/stream/session for a full board.")
		return
	}
	rt.openTickStream(w, r, tokens, "GET /api/stream", nil)
}

// openTickStream attaches the browser to the live tick stream. Refusals are JSON, before
// any SSE header. Then: the SSE headers, the hub attachment (one snapshot frame with the
// cached ticks of these tokens, then every broadcast, unfiltered, and the hub's kite_error
// event), a browser lease on the subscription coordinator, and ": ping" every
// PingInterval. The stream ends when the browser goes away or the hub drops the client
// for falling behind; cleanup then runs once, in Node's order: stop the keep-alive,
// release the lease (before detaching, so a token another client still wants survives),
// detach from the hub, onClose (the session's connection count), end the response.
func (rt *routes) openTickStream(w http.ResponseWriter, r *http.Request, tokens []int64, label string, onClose func()) {
	closed := func() {
		if onClose != nil {
			onClose()
		}
	}
	broker := rt.d.ActiveBroker()
	if ready, problems := rt.d.DataHealth(); !ready {
		refuseLivePrices(w, broker, problems)
		closed()
		return
	}
	if rt.refuseForeign(w, tokens, label) {
		closed()
		return
	}

	sse := hub.StartSSE(w)
	detach := rt.d.Hub.AttachClient(sse, tokens)
	// Deferred so the hub never keeps writing to a finished response, even if a dependency
	// below panics. It runs after the keep-alive/lease defer further down.
	defer func() {
		detach()
		closed()
		log.Printf("[SSE] client closed %s tokens=%d", label, len(tokens))
	}()
	release := rt.d.AcquireBrowserTokens(tokens)
	log.Printf("[SSE] client opened %s tokens=%d broker=%s generation=%d", label, len(tokens), rt.d.ActiveBroker(), rt.d.Generation())
	ping, stopPing := rt.d.NewTicker(rt.d.PingInterval)
	defer func() {
		stopPing()
		if release != nil {
			release()
		}
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sse.Done():
			// The hub dropped this client (it fell too far behind).
			return
		case <-ping:
			_ = sse.Ping() // write errors are ignored, as Node's try/catch did
		}
	}
}

// ---------------------------------------------------------------------------------------
// Observability

// FeedView is the feed block of the snapshot, re-keyed in the order Node wrote it.
type FeedView struct {
	State      brokers.FeedState `json:"state"`
	Connected  bool              `json:"connected"`
	Subscribed int               `json:"subscribed"`
	Universe   *int              `json:"universe"`
	FeedAgeMs  *int64            `json:"feed_age_ms"`
	LastTickAt *int64            `json:"last_tick_at"`
	Detail     string            `json:"detail"`
}

// BoxLaneView is the second lane's stats followed by its subscription stats
// ({...laneStats("box"), subscriptions}).
type BoxLaneView struct {
	brokers.LaneFeedStats
	Subscriptions brokers.Stats `json:"subscriptions"`
}

// LanesView is the per-lane health block.
type LanesView struct {
	Futures brokers.LaneFeedStats `json:"futures"`
	Box     BoxLaneView           `json:"box"`
}

// Snapshot is GET /api/market-data/status (marketDataSnapshot): the numbers that tell
// "nothing subscribed" from "no data arriving".
type Snapshot struct {
	Broker        brokers.ID    `json:"broker"`
	Generation    int           `json:"generation"`
	Subscriptions brokers.Stats `json:"subscriptions"`
	Sessions      SessionStats  `json:"sessions"`
	Feed          FeedView      `json:"feed"`
	Upstream      UpstreamStats `json:"upstream"`
	Lanes         LanesView     `json:"lanes"`
}

// Diagnostics is GET /api/market-data/diagnostics: the snapshot plus the board size and
// the named diagnosis.
type Diagnostics struct {
	Snapshot
	BoardSize *int   `json:"board_size"`
	Diagnosis string `json:"diagnosis"`
}

// The five diagnoses, in the order they are tested.
const (
	DiagnosisNoBrowser = "CASE A — no browser subscriptions. The browser never successfully reached the stream endpoint (historically: a ~9 KB request URL rejected by nginx with 414)."
	DiagnosisRouting   = "CASE B — browser leases exist but nothing reached the broker: routing bug."
	DiagnosisSubscribe = "CASE C — tokens wanted but none confirmed upstream: subscribe-send bug."
	DiagnosisNoTick    = "CASE D — subscribed upstream but no tick ever arrived: feed/protocol issue."
	DiagnosisHealthy   = "HEALTHY — ticks are arriving. A blank cell now implies frontend token mapping."
)

// fullAdminRequiredMsg is index.ts requireFullAdmin's 403 text.
const fullAdminRequiredMsg = "Full admin access required."

func (rt *routes) snapshot() Snapshot {
	// Same call order as Node: feedHealth, subscriptions, then the object literal.
	feed := rt.d.FeedHealth()
	subs := rt.d.Subscriptions()
	s := Snapshot{
		Broker:        rt.d.ActiveBroker(),
		Generation:    rt.d.Generation(),
		Subscriptions: subs,
		Sessions:      rt.d.Sessions.Stats(),
		Feed: FeedView{
			State: feed.State, Connected: feed.Connected, Subscribed: feed.Subscribed, Universe: feed.Universe,
			FeedAgeMs: feed.FeedAgeMs, LastTickAt: feed.LastTickAt, Detail: feed.Detail,
		},
		Upstream: rt.d.UpstreamFeedStats(),
	}
	s.Lanes.Futures = rt.d.LaneStats(brokers.LaneFutures)
	s.Lanes.Box.LaneFeedStats = rt.d.LaneStats(brokers.LaneBox)
	s.Lanes.Box.Subscriptions = rt.d.BoxSubscriptions()
	return s
}

// Diagnose names the failure the snapshot shows: no browser lease (A), leases that never
// reached the broker (B), wanted but not confirmed upstream (C), subscribed but no tick
// yet (D), else healthy.
func Diagnose(s Snapshot) string {
	switch {
	case s.Subscriptions.Browser == 0:
		return DiagnosisNoBrowser
	case s.Upstream.Wanted == nil || *s.Upstream.Wanted == 0:
		return DiagnosisRouting
	case s.Upstream.Subscribed == nil || *s.Upstream.Subscribed == 0:
		return DiagnosisSubscribe
	case s.Feed.LastTickAt == nil:
		return DiagnosisNoTick
	}
	return DiagnosisHealthy
}

// status is GET /api/market-data/status, public on purpose (no secrets).
func (rt *routes) status(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, rt.snapshot())
}

// diagnostics is GET /api/market-data/diagnostics, full admin only (403 otherwise).
func (rt *routes) diagnostics(w http.ResponseWriter, r *http.Request) {
	if rt.d.IsFullAdmin == nil || !rt.d.IsFullAdmin(r) {
		httpx.Error(w, http.StatusForbidden, fullAdminRequiredMsg)
		return
	}
	snap := rt.snapshot()
	size := rt.boardSize(context.WithoutCancel(r.Context()))
	httpx.JSON(w, http.StatusOK, Diagnostics{Snapshot: snap, BoardSize: size, Diagnosis: Diagnose(snap)})
}

// boardSize never fails: an error or a panic is null, as Node's .catch(() => null).
func (rt *routes) boardSize(ctx context.Context) (size *int) {
	if rt.d.BoardSize == nil {
		return nil
	}
	defer func() {
		if rec := recover(); rec != nil {
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			log.Printf("[market-data] board size failed: %v", rec)
			size = nil
		}
	}()
	n, err := rt.d.BoardSize(ctx)
	if err != nil {
		return nil
	}
	return &n
}

// ---------------------------------------------------------------------------------------
// Helpers

// pathParam is req.params[name]: Express decodes the raw path segment. chi matches the raw
// path only when the URL has one (escapes the default encoding would not produce), so only
// then is the segment still encoded.
func pathParam(r *http.Request, name string) string {
	v := chi.URLParam(r, name)
	if r.URL.RawPath == "" {
		return v
	}
	if s, err := url.PathUnescape(v); err == nil {
		return s
	}
	return v
}

// prefix8 is id.slice(0, 8).
func prefix8(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
