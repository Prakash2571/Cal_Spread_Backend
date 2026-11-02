package registry

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// RouteDeps are what the broker routes need besides the registry.
type RouteDeps struct {
	Registry *Registry
	// Sessions is the admin session table (x-admin-token).
	Sessions *auth.Sessions
	// IndexSpotMap is the board's index map for the diagnostics; nil means none (Node's
	// `deps.indexSpotMap ?? {}`). Production: IndexSpotMap.
	IndexSpotMap map[string]string
	// Now is the rate limiters' clock; nil means time.Now.
	Now func() time.Time
}

// Mount registers /api/broker/* and /api/dhan/* (brokers/routes.ts). On each route the
// order is: the global /api limiter (server), the route's own limiter, then auth.
func Mount(r chi.Router, deps RouteDeps) {
	h := &routes{reg: deps.Registry, sessions: deps.Sessions, spotMap: deps.IndexSpotMap}
	if h.spotMap == nil {
		h.spotMap = map[string]string{}
	}
	// The Dhan login and session routes share ONE bucket: each spends the app credentials.
	authLimit := httpx.NewLimiter(5*time.Minute, 20, "Too many Dhan authentication attempts. Please wait a few minutes.", deps.Now)
	switchLimit := httpx.NewLimiter(time.Minute, 10, "Too many broker switch attempts. Slow down.", deps.Now)
	tokenLimit := httpx.NewLimiter(time.Minute, 30, "Too many token requests. Slow down.", deps.Now)

	admin := func(fn http.HandlerFunc) http.HandlerFunc { return h.sessions.RequireAdmin(fn).ServeHTTP }
	full := func(fn http.HandlerFunc) http.HandlerFunc { return h.sessions.RequireFull(fn).ServeHTTP }

	r.Get("/api/broker/status", admin(h.brokerStatus))
	r.Get("/api/broker/switch-blockers", admin(h.switchBlockers))
	r.Post("/api/broker/select", switchLimit.Wrap(full(h.selectBroker)))

	r.Post("/api/dhan/login", authLimit.Wrap(full(h.dhanLogin)))
	r.Post("/api/dhan/session", authLimit.Wrap(full(h.dhanSession)))
	r.Get("/api/dhan/status", admin(h.dhanStatus))
	r.Post("/api/dhan/verify-ip", full(h.verifyIP))
	r.Get("/api/dhan/instruments/diagnostics", full(h.instrumentDiagnostics))
	r.Post("/api/dhan/logout", full(h.dhanLogout))
	r.Post("/api/dhan/postback", h.postback)
	r.Get("/api/dhan/access-token", full(h.accessToken))
	r.Get("/api/dhan/token", tokenLimit.Wrap(h.passcodeToken))
}

type routes struct {
	reg      *Registry
	sessions *auth.Sessions
	spotMap  map[string]string
}

// fail is the broker routes' error mapper: a Dhan error answers with its own status when
// that is an HTTP error status, else 502 (no response at all); anything else is 500.
func fail(w http.ResponseWriter, err error) {
	if de, ok := dhan.AsError(err); ok {
		status := de.Status
		if status < 400 {
			status = http.StatusBadGateway
		}
		httpx.Error(w, status, de.Message)
		return
	}
	log.Printf("[Broker] request failed: %v", err)
	httpx.Error(w, http.StatusInternalServerError, err.Error())
}

/* --------------------------------- broker --------------------------------- */

func (h *routes) brokerStatus(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, h.reg.Snapshot())
}

func (h *routes) switchBlockers(w http.ResponseWriter, r *http.Request) {
	target := h.reg.ActiveBroker()
	// req.query.broker: a repeated parameter is an array, which parseBrokerId refuses.
	if vals := r.URL.Query()["broker"]; len(vals) == 1 {
		if b, ok := brokers.Parse(vals[0]); ok {
			target = b
		}
	}
	httpx.JSON(w, http.StatusOK, struct {
		Broker   brokers.ID     `json:"broker"`
		Blockers []auth.Blocker `json:"blockers"`
	}{target, h.reg.SwitchBlockers(target)})
}

type okSnapshot struct {
	OK bool `json:"ok"`
	Snapshot
}

func (h *routes) selectBroker(w http.ResponseWriter, r *http.Request) {
	broker, ok := brokers.Parse(httpx.BodyObject(r)["broker"])
	if !ok {
		httpx.Error(w, http.StatusBadRequest, `broker must be "zerodha" or "dhan".`)
		return
	}
	actor := string(h.sessions.RoleOf(r))
	if actor == "" {
		actor = "admin"
	}
	res := h.reg.SwitchTo(r.Context(), broker, actor)
	if !res.OK {
		httpx.JSON(w, http.StatusConflict, struct {
			Error    string         `json:"error"`
			Blockers []auth.Blocker `json:"blockers"`
			Broker   brokers.ID     `json:"broker"`
		}{"Cannot change broker while Box exposure or in-flight work exists.", res.Blockers, h.reg.ActiveBroker()})
		return
	}
	if hk := h.reg.getHooks(); hk.OnBrokerChanged != nil {
		hk.OnBrokerChanged(res.Broker)
	}
	httpx.JSON(w, http.StatusOK, okSnapshot{OK: true, Snapshot: h.reg.Snapshot()})
}

/* ---------------------------------- Dhan ---------------------------------- */

func (h *routes) dhanLogin(w http.ResponseWriter, r *http.Request) {
	consent, err := h.reg.BeginDhanLogin(context.WithoutCancel(r.Context()))
	if err != nil {
		fail(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		OK           bool   `json:"ok"`
		ConsentAppID string `json:"consent_app_id"`
		LoginURL     string `json:"login_url"`
	}{true, consent.ConsentAppID, consent.LoginURL})
}

func (h *routes) dhanSession(w http.ResponseWriter, r *http.Request) {
	// String(req.body?.tokenId ?? "").trim()
	tokenID := ""
	if v, present := httpx.BodyObject(r)["tokenId"]; present && v != nil {
		tokenID = jsString(v)
	}
	tokenID = jsTrim(tokenID)
	if tokenID == "" {
		httpx.Error(w, http.StatusBadRequest, "Missing tokenId.")
		return
	}
	session, err := h.reg.CompleteDhanLogin(r.Context(), tokenID)
	if err != nil {
		fail(w, err)
		return
	}
	// Selecting Dhan is a separate, guarded step: this never switches the broker.
	httpx.JSON(w, http.StatusOK, struct {
		OK             bool       `json:"ok"`
		Authenticated  bool       `json:"authenticated"`
		Broker         brokers.ID `json:"broker"`
		ClientID       *string    `json:"client_id"`
		ClientName     *string    `json:"client_name"`
		TokenExpiresAt *int64     `json:"token_expires_at"`
	}{true, session.Authenticated, h.reg.ActiveBroker(), session.ClientID, session.ClientName, session.TokenExpiresAt})
}

type dhanStatusResponse struct {
	Broker             string         `json:"broker"`
	Active             bool           `json:"active"`
	Configured         bool           `json:"configured"`
	Authenticated      bool           `json:"authenticated"`
	TokenExpired       bool           `json:"token_expired"`
	TokenExpiresAt     *int64         `json:"token_expires_at"`
	DataReady          bool           `json:"data_ready"`
	TradingReady       bool           `json:"trading_ready"`
	StaticIPConfigured *bool          `json:"static_ip_configured"`
	StaticIP           StaticIPState  `json:"static_ip"`
	FeedConnected      bool           `json:"feed_connected"`
	FeedAgeMs          *int64         `json:"feed_age_ms"`
	Problems           []string       `json:"problems"`
	Instruments        int            `json:"instruments"`
	Session            *dhan.Redacted `json:"session"`
}

func (h *routes) dhanStatus(w http.ResponseWriter, r *http.Request) {
	ctx := context.WithoutCancel(r.Context())
	// Resolve a pending static-IP verification before reporting it.
	h.reg.EnsureDhanStaticIPVerified(ctx)
	health := h.reg.HealthFor(brokers.Dhan)
	stored := h.reg.loadStoredDhanSession()
	var session *dhan.Redacted
	if stored != nil {
		red := redact(stored, h.reg.now())
		session = &red
	}
	_, configured, _ := h.reg.DhanCredentials()
	httpx.JSON(w, http.StatusOK, dhanStatusResponse{
		Broker:             "dhan",
		Active:             h.reg.ActiveBroker() == brokers.Dhan,
		Configured:         configured,
		Authenticated:      health.Authenticated,
		TokenExpired:       health.TokenExpired,
		TokenExpiresAt:     health.TokenExpiresAt,
		DataReady:          health.DataReady,
		TradingReady:       health.TradingReady,
		StaticIPConfigured: health.StaticIPConfigured,
		StaticIP:           h.reg.DhanStaticIPState(),
		FeedConnected:      health.FeedConnected,
		FeedAgeMs:          health.FeedAgeMs,
		Problems:           health.Problems,
		Instruments:        h.reg.dhanInstruments.Size(),
		Session:            session,
	})
}

func redact(s *DhanSessionRecord, now time.Time) dhan.Redacted {
	loginAt := s.LoginAt
	return dhan.RedactedSession(dhan.SessionRecord{
		DhanClientID: s.DhanClientID, DhanClientName: s.DhanClientName, DhanClientUcc: s.DhanClientUcc,
		GivenPowerOfAttorney: s.GivenPowerOfAttorney, ExpiryTime: s.ExpiryTime, LoginDate: s.LoginDate,
		LoginAt: &loginAt,
	}, now)
}

// loadStoredDhanSession is `loadDhanSession().catch(() => null)`.
func (r *Registry) loadStoredDhanSession() *DhanSessionRecord {
	ctx, cancel := storeCtx()
	defer cancel()
	rec, err := r.store.LoadDhanSession(ctx)
	if err != nil {
		return nil
	}
	return rec
}

func (h *routes) verifyIP(w http.ResponseWriter, r *http.Request) {
	res := h.reg.VerifyDhanStaticIP(context.WithoutCancel(r.Context()))
	httpx.JSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
		VerifyIPResult
		StaticIP StaticIPState `json:"static_ip"`
	}{res.Verified, res, h.reg.DhanStaticIPState()})
}

// parserReport is `{...report, header_line, header: report.header.slice(0, 40)}`: the
// header keeps its first position with the capped value, header_line comes last.
type parserReport struct {
	dhan.ParseReport
	HeaderLine string `json:"header_line"`
}

func (h *routes) instrumentDiagnostics(w http.ResponseWriter, r *http.Request) {
	store := h.reg.dhanInstruments
	// Force a parse so the report reflects the CURRENT master.
	_, _ = store.Load(context.WithoutCancel(r.Context()), true)
	report := getParseReport()
	if report == nil {
		httpx.JSON(w, http.StatusServiceUnavailable, struct {
			Error string `json:"error"`
			Hint  string `json:"hint"`
		}{"The Dhan instrument master has not been parsed yet.", "Connect Dhan, then retry."})
		return
	}
	rows := store.Instruments()
	universe := make([]market.Instrument, len(rows))
	for i := range rows {
		universe[i] = rows[i].Instrument
	}
	board := DiagnoseBoard(universe, h.spotMap)
	known := CheckKnownSymbols(universe, nil)

	pr := parserReport{ParseReport: *report, HeaderLine: strings.Join(report.Header, ",")}
	if len(pr.Header) > 40 {
		pr.Header = pr.Header[:40]
	}
	httpx.JSON(w, http.StatusOK, struct {
		Broker                 string             `json:"broker"`
		ActiveBroker           brokers.ID         `json:"active_broker"`
		Generation             int64              `json:"generation"`
		Healthy                bool               `json:"healthy"`
		InstrumentUniverseSize int                `json:"instrument_universe_size"`
		ParserReport           parserReport       `json:"parser_report"`
		Board                  BoardDiagnostics   `json:"board"`
		KnownSymbols           []KnownSymbolCheck `json:"known_symbols"`
		Subscriptions          brokers.Stats      `json:"subscriptions"`
		Feed                   brokers.FeedHealth `json:"feed"`
	}{
		Broker:       "dhan",
		ActiveBroker: h.reg.ActiveBroker(),
		Generation:   h.reg.Generation(),
		Healthy: report.FnoFutures >= 100 && report.DistinctFutureUnderlyings >= 50 &&
			board.BoardSize >= 50 && len(report.MissingColumns) == 0,
		InstrumentUniverseSize: len(rows),
		ParserReport:           pr,
		Board:                  board,
		KnownSymbols:           known,
		Subscriptions:          h.reg.subscriptions.Stats(),
		Feed:                   h.reg.FeedHealth(),
	})
}

func (h *routes) dhanLogout(w http.ResponseWriter, r *http.Request) {
	h.reg.LogoutDhan(context.WithoutCancel(r.Context()))
	httpx.JSON(w, http.StatusOK, okSnapshot{OK: true, Snapshot: h.reg.Snapshot()})
}

// postback is Dhan's webhook: always 200, logged as a hint, never mutates order state.
func (h *routes) postback(w http.ResponseWriter, r *http.Request) {
	body := httpx.BodyObject(r)
	orderID, _ := body["orderId"].(string)
	if orderID == "" {
		httpx.JSON(w, http.StatusOK, struct {
			OK      bool   `json:"ok"`
			Ignored string `json:"ignored"`
		}{true, "no orderId"})
		return
	}
	status, ok := body["orderStatus"].(string)
	if !ok {
		status = "unknown"
	}
	line := "[Dhan postback] order " + orderID + " status " + status
	if corr, ok := body["correlationId"].(string); ok && corr != "" {
		line += " correlation " + corr
	}
	log.Print(line + " — recorded as a hint; REST reconciliation remains authoritative.")
	httpx.JSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
	}{true})
}

func (h *routes) accessToken(w http.ResponseWriter, _ *http.Request) {
	stored := h.reg.loadStoredDhanSession()
	if stored == nil || dhan.IsTokenExpired(stored.ExpiryTime, h.reg.nowMs()) {
		httpx.Error(w, http.StatusConflict, "No live Dhan session. Connect Dhan first.")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Authenticated bool   `json:"authenticated"`
		ClientID      string `json:"client_id"`
		AccessToken   string `json:"access_token"`
		ExpiresAt     *int64 `json:"expires_at"`
	}{true, stored.DhanClientID, stored.AccessToken, stored.ExpiryTime})
}

// passcodeToken is GET /api/dhan/token: the same token for an unattended script, guarded
// by TOKEN_ROUTE_SECRET (read per request) instead of an admin session.
func (h *routes) passcodeToken(w http.ResponseWriter, r *http.Request) {
	passcode, supplied := auth.ReadPasscode(r, "x-token-passcode", "passcode")
	switch auth.CheckPasscode(h.reg.get("TOKEN_ROUTE_SECRET"), passcode, supplied) {
	case auth.PasscodeNotConfigured:
		httpx.Error(w, http.StatusServiceUnavailable, "Token route is not configured. Set TOKEN_ROUTE_SECRET on the server.")
		return
	case auth.PasscodeForbidden:
		httpx.Error(w, http.StatusForbidden, "Invalid or missing passcode.")
		return
	}
	stored := h.reg.loadStoredDhanSession()
	if stored == nil || dhan.IsTokenExpired(stored.ExpiryTime, h.reg.nowMs()) {
		httpx.JSON(w, http.StatusConflict, struct {
			Authenticated bool   `json:"authenticated"`
			Error         string `json:"error"`
		}{false, "No live Dhan session. The admin must connect Dhan first."})
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Authenticated bool   `json:"authenticated"`
		ClientID      string `json:"client_id"`
		AccessToken   string `json:"access_token"`
		ExpiresAt     *int64 `json:"expires_at"`
		LoginDate     string `json:"login_date"`
	}{true, stored.DhanClientID, stored.AccessToken, stored.ExpiryTime, stored.LoginDate})
}
