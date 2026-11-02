package core

import (
	"net/http"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	fjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// GET / (index.ts:1086).
func (c *Core) health(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, struct {
		Status        string `json:"status"`
		Authenticated bool   `json:"authenticated"`
		Hint          string `json:"hint"`
	}{"ok", c.kite.HasSession(), "Visit /api/login to authenticate with Zerodha."})
}

type statusBody struct {
	Status              string            `json:"status"`
	Authenticated       bool              `json:"authenticated"`
	Broker              brokers.ID        `json:"broker"`
	BrokerAuthenticated bool              `json:"broker_authenticated"`
	MarketDataReady     bool              `json:"market_data_ready"`
	FeedConnected       bool              `json:"feed_connected"`
	FeedState           brokers.FeedState `json:"feed_state"`
	TradingReady        bool              `json:"trading_ready"`
	Problems            []string          `json:"problems"`
	Generation          int64             `json:"generation"`
	ZerodhaSession      bool              `json:"zerodha_session"`
}

// GET /api/status (index.ts:1107): the ACTIVE broker's readiness; zerodha_session is
// Kite's own session for the admin UI.
func (c *Core) status(w http.ResponseWriter, _ *http.Request) {
	h := c.activeHealth()
	feed := c.feedHealth()
	httpx.JSON(w, http.StatusOK, statusBody{
		Status:              "ok",
		Authenticated:       h.Authenticated && h.DataReady,
		Broker:              c.activeBroker(),
		BrokerAuthenticated: h.Authenticated,
		MarketDataReady:     h.DataReady,
		FeedConnected:       feed.Connected,
		FeedState:           feed.State,
		TradingReady:        h.TradingReady,
		Problems:            h.Problems,
		Generation:          c.generation(),
		ZerodhaSession:      c.kite.HasSession(),
	})
}

// accessTokenOrNull is kite.getAccessToken(): the token, or nil (JSON null) when there
// is no session.
func (c *Core) accessTokenOrNull() *string {
	if !c.kite.HasSession() {
		return nil
	}
	t := c.kite.AccessToken()
	return &t
}

// GET /api/internal/kite-token (index.ts:1131): the session for the local recorder,
// behind INTERNAL_TOKEN_SECRET (x-internal-secret or ?secret=). 200 even without a
// session.
func (c *Core) internalKiteToken(w http.ResponseWriter, r *http.Request) {
	secret, supplied := readPasscode(r, "x-internal-secret", "secret")
	switch auth.CheckPasscode(c.d.InternalTokenSecret, secret, supplied) {
	case auth.PasscodeNotConfigured:
		httpx.Error(w, http.StatusServiceUnavailable, "Internal token sharing is not configured.")
		return
	case auth.PasscodeForbidden:
		httpx.Error(w, http.StatusForbidden, "Forbidden.")
		return
	}
	token := c.accessTokenOrNull()
	httpx.JSON(w, http.StatusOK, struct {
		APIKey        string  `json:"api_key"`
		AccessToken   *string `json:"access_token"`
		Authenticated bool    `json:"authenticated"`
	}{c.kite.APIKey(), token, token != nil})
}

const (
	tokenRouteNotConfigured = "Token route is not configured. Set TOKEN_ROUTE_SECRET on the server."
	tokenRouteForbidden     = "Invalid or missing passcode."
)

// checkTokenRoute is the TOKEN_ROUTE_SECRET guard shared by /api/kite/token and
// GET /api/rf (x-token-passcode or ?passcode=). It answers and returns false on failure.
func (c *Core) checkTokenRoute(w http.ResponseWriter, r *http.Request) bool {
	passcode, supplied := readPasscode(r, "x-token-passcode", "passcode")
	switch auth.CheckPasscode(c.d.TokenRouteSecret, passcode, supplied) {
	case auth.PasscodeNotConfigured:
		httpx.Error(w, http.StatusServiceUnavailable, tokenRouteNotConfigured)
		return false
	case auth.PasscodeForbidden:
		httpx.Error(w, http.StatusForbidden, tokenRouteForbidden)
		return false
	}
	return true
}

// GET /api/kite/token (index.ts:1168): the curl-friendly token route.
func (c *Core) kiteToken(w http.ResponseWriter, r *http.Request) {
	if !c.checkTokenRoute(w, r) {
		return
	}
	token := c.kite.AccessToken()
	if token == "" {
		httpx.JSON(w, http.StatusConflict, struct {
			Authenticated bool   `json:"authenticated"`
			Error         string `json:"error"`
		}{false, "No active Zerodha session. The admin must connect to Zerodha first."})
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		Authenticated bool   `json:"authenticated"`
		APIKey        string `json:"api_key"`
		AccessToken   string `json:"access_token"`
		LoginDate     string `json:"login_date"`
	}{true, c.kite.APIKey(), token, jsx.IstDayKey(c.now())}) // today's IST day, not the login day
}

// GET /login and GET /api/login (index.ts:1399): full admin by ?x-admin-token= (which
// wins when non-empty; browser navigation cannot send headers) or the header, then 302
// to Kite's login page.
func (c *Core) login(w http.ResponseWriter, r *http.Request) {
	var role auth.Role
	switch vals := parseQuery(r.URL.RawQuery)["x-admin-token"]; {
	case len(vals) > 1:
		role = auth.RoleNone // an array: truthy, so the header is not consulted, and no session matches
	case len(vals) == 1 && vals[0] != "":
		role = c.sessions.Role(vals[0])
	default:
		role = c.sessions.RoleOf(r)
	}
	if role != auth.RoleFull {
		httpx.Error(w, http.StatusForbidden, "Full admin access required.")
		return
	}
	redirect(w, r, c.kite.LoginURL())
}

// sessionReply is {authenticated: true, user_id, user_name} with the two values exactly as
// Kite sent them (a missing one is omitted, as JSON.stringify drops undefined).
func sessionReply(s kite.SessionData) fjson.Marshaler {
	return fjson.RawObject(func(dst []byte) []byte {
		o := fjson.NewObject(dst).Field("authenticated", true)
		raw, err := kjson.Parse(string(s.Raw))
		if err != nil || raw.Kind() != kjson.Object {
			return o.Field("user_id", s.UserID).Field("user_name", s.UserName).End()
		}
		for _, key := range []string{"user_id", "user_name"} {
			if v := raw.Get(key); v.Kind() != kjson.Undefined {
				o.Field(key, fjson.RawObject(func(b []byte) []byte { return append(b, kjson.Marshal(v)...) }))
			}
		}
		return o.End()
	})
}

// completeLogin is what both login paths do after a successful exchange: persist the
// token with today's IST day and trigger the post-login backfills.
func (c *Core) completeLogin(s kite.SessionData) {
	c.logf("Authenticated as %s (%s).", s.UserName, s.UserID)
	c.persistKiteSession(s.AccessToken, s.UserID, s.UserName)
	if c.d.OnKiteLogin != nil {
		c.d.OnKiteLogin()
	}
}

// POST /api/session (index.ts:1413): exchange the request_token the frontend received.
// Failures do NOT go through SendError: a failed or duplicate exchange must not clear a
// session that is still valid.
func (c *Core) session(w http.ResponseWriter, r *http.Request) {
	requestToken := stringOrEmpty(bodyField(r, "request_token"))
	if requestToken == "" {
		httpx.Error(w, http.StatusBadRequest, "Missing request_token.")
		return
	}
	ctx, done := c.work(r)
	defer done()
	s, err := c.kite.GenerateSession(ctx, requestToken)
	if err != nil {
		status, msg := http.StatusInternalServerError, err.Error()
		if ke, ok := kite.AsKiteError(err); ok {
			status, msg = ke.Status, ke.Message
		}
		httpx.Error(w, status, msg)
		return
	}
	c.completeLogin(s)
	httpx.JSON(w, http.StatusOK, sessionReply(s))
}

// GET /callback (index.ts:1440): Kite redirecting straight to the backend. Unprotected
// and not rate limited, as in Node.
func (c *Core) callback(w http.ResponseWriter, r *http.Request) {
	q := parseQuery(r.URL.RawQuery)
	requestToken, _ := queryString(q, "request_token")
	status, _ := queryString(q, "status")
	if status != "success" || requestToken == "" {
		redirect(w, r, c.d.FrontendURL+"/?auth=failed")
		return
	}
	ctx, done := c.work(r)
	defer done()
	s, err := c.kite.GenerateSession(ctx, requestToken)
	if err != nil {
		c.logf("Session generation failed: %s", err.Error())
		redirect(w, r, c.d.FrontendURL+"/?auth=failed")
		return
	}
	c.completeLogin(s)
	redirect(w, r, c.d.FrontendURL+"/?auth=success")
}

// POST /api/logout (index.ts:1463): forget the Kite session (memory now, the persisted
// copy in the background). Admin sessions and Dhan are untouched.
func (c *Core) logout(w http.ResponseWriter, _ *http.Request) {
	c.ClearKiteSession()
	if c.d.OnKiteLogout != nil {
		c.d.OnKiteLogout()
	}
	httpx.JSON(w, http.StatusOK, struct {
		Authenticated bool `json:"authenticated"`
	}{false})
}

// GET /api/kite/access-token (index.ts:1475), full admin.
func (c *Core) accessToken(w http.ResponseWriter, _ *http.Request) {
	token := c.kite.AccessToken()
	if token == "" {
		httpx.Error(w, http.StatusConflict, "No active Zerodha session. Connect to Zerodha first.")
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		APIKey      string `json:"api_key"`
		AccessToken string `json:"access_token"`
		LoginDate   string `json:"login_date"`
	}{c.kite.APIKey(), token, jsx.IstDayKey(c.now())})
}

// GET /api/profile (index.ts:1491): Kite's /user/profile data, verbatim. Always Kite,
// whichever broker is active; errors go through SendError.
func (c *Core) profile(w http.ResponseWriter, r *http.Request) {
	ctx, done := c.work(r)
	defer done()
	raw, err := c.kite.GetProfile(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	httpx.RawJSON(w, http.StatusOK, raw)
}
