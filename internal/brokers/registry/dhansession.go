package registry

import (
	"context"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// SessionState is BrokerSessionState: whether the BROKER session is usable (never
// derived from admin authentication). Key order is the contract.
type SessionState struct {
	Broker         brokers.ID `json:"broker"`
	Authenticated  bool       `json:"authenticated"`
	ClientID       *string    `json:"client_id"`
	ClientName     *string    `json:"client_name"`
	TokenExpiresAt *int64     `json:"token_expires_at"`
	TokenExpired   bool       `json:"token_expired"`
	LoginDay       *string    `json:"login_day"`
	LoginAt        *int64     `json:"login_at"`
}

// HealthState is BrokerHealthState: readiness split by capability.
type HealthState struct {
	Broker         brokers.ID `json:"broker"`
	Authenticated  bool       `json:"authenticated"`
	TokenExpiresAt *int64     `json:"token_expires_at"`
	TokenExpired   bool       `json:"token_expired"`
	DataReady      bool       `json:"data_ready"`
	TradingReady   bool       `json:"trading_ready"`
	// StaticIPConfigured is null for Zerodha (not applicable).
	StaticIPConfigured *bool    `json:"static_ip_configured"`
	FeedConnected      bool     `json:"feed_connected"`
	FeedAgeMs          *int64   `json:"feed_age_ms"`
	Problems           []string `json:"problems"`
}

// StaticIPState is dhanStaticIpState(): declared versus API-verified.
type StaticIPState struct {
	Ready        bool    `json:"ready"`
	Declared     bool    `json:"declared"`
	ConfiguredIP *string `json:"configured_ip"`
	APIVerified  *bool   `json:"api_verified"`
	PrimaryIP    *string `json:"primary_ip"`
	SecondaryIP  *string `json:"secondary_ip"`
	CheckedAt    *int64  `json:"checked_at"`
	Error        *string `json:"error"`
}

// VerifyIPResult is what verifyDhanStaticIp returns.
type VerifyIPResult struct {
	Verified     bool    `json:"verified"`
	ConfiguredIP string  `json:"configured_ip"`
	PrimaryIP    *string `json:"primary_ip"`
	SecondaryIP  *string `json:"secondary_ip"`
	CheckedAt    int64   `json:"checked_at"`
	Error        *string `json:"error"`
}

const (
	problemNotConnected = "Dhan is not connected"
	problemExpired      = "Dhan session expired — reconnect Dhan"
)

func strPtr(s string) *string { return &s }

// storeCtx bounds one persistence call. Request cancellation is deliberately not
// inherited by callers (a browser going away must not abort a half-done switch).
func storeCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

/* -------------------------- Dhan session state ------------------------- */

// usableDhanToken is the token, or "" when absent or expired; expiry is enforced on
// every read (every Dhan request and connection).
func (r *Registry) usableDhanToken() string {
	r.sessMu.Lock()
	defer r.sessMu.Unlock()
	if r.dhanToken == nil || *r.dhanToken == "" {
		return ""
	}
	if dhan.IsTokenExpired(r.dhanExpiry, r.nowMs()) {
		return ""
	}
	return *r.dhanToken
}

func (r *Registry) dhanSession() (token *string, expiry *int64, meta *dhanMeta) {
	r.sessMu.Lock()
	defer r.sessMu.Unlock()
	return r.dhanToken, r.dhanExpiry, r.dhanMeta
}

func (r *Registry) setDhanSession(token *string, expiry *int64, meta *dhanMeta) {
	r.sessMu.Lock()
	r.dhanToken, r.dhanExpiry, r.dhanMeta = token, expiry, meta
	r.sessMu.Unlock()
}

// Token-based Dhan sessions need only the account identity. App credentials belong
// to the separate consent endpoints, not to broker selection or market-data readiness.
func (r *Registry) DhanCredentials() (creds dhan.AppCredentials, ok bool, reason string) {
	creds.ClientID = jsTrim(r.get("DHAN_CLIENT_ID"))
	if creds.ClientID == "" {
		return creds, false, "Dhan is not configured: DHAN_CLIENT_ID missing."
	}
	return creds, true, ""
}

func (r *Registry) authOptions() dhan.AuthOptions {
	return dhan.AuthOptions{Root: r.deps.Dhan.AuthRoot, Client: r.deps.Dhan.HTTPClient}
}

// BeginDhanLogin is step 1 of the Dhan login: a consent and the browser URL.
func (r *Registry) BeginDhanLogin(ctx context.Context) (dhan.Consent, error) {
	creds, ok, reason := dhan.ReadCredentials(r.get)
	if !ok {
		return dhan.Consent{}, dhan.NewError(reason, 400, "CONFIG", nil)
	}
	return dhan.GenerateConsent(ctx, creds, r.authOptions())
}

// CompleteDhanLogin is step 3: exchange the redirect's tokenId for a session, persist it
// and, when Dhan is the active broker, bring its runtime back up on the new token. It
// never switches the broker.
func (r *Registry) CompleteDhanLogin(ctx context.Context, tokenID string) (SessionState, error) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	ctx = context.WithoutCancel(ctx)

	creds, ok, reason := dhan.ReadCredentials(r.get)
	if !ok {
		return SessionState{}, dhan.NewError(reason, 400, "CONFIG", nil)
	}
	session, err := dhan.ConsumeConsent(ctx, creds, tokenID, r.authOptions())
	if err != nil {
		return SessionState{}, err
	}

	now := r.now()
	day := jsx.IstDayKey(now)
	token := session.AccessToken
	r.setDhanSession(&token, session.ExpiryTime, &dhanMeta{
		clientID:        session.DhanClientID,
		clientName:      session.DhanClientName,
		clientUcc:       session.DhanClientUcc,
		powerOfAttorney: session.GivenPowerOfAttorney,
		loginDay:        day,
		loginAt:         now.UnixMilli(),
	})
	sctx, cancel := storeCtx()
	err = r.store.SaveDhanSession(sctx, DhanSessionRecord{
		AccessToken:          session.AccessToken,
		DhanClientID:         session.DhanClientID,
		DhanClientName:       session.DhanClientName,
		DhanClientUcc:        session.DhanClientUcc,
		GivenPowerOfAttorney: session.GivenPowerOfAttorney,
		ExpiryTime:           session.ExpiryTime,
		LoginDate:            jsx.IstDayKey(r.now()),
	})
	cancel()
	if err != nil {
		log.Printf("[Dhan] failed to persist the session: %v", err)
	}

	r.restartDhanRuntime(ctx, false)
	return r.SessionFor(brokers.Dhan), nil
}

// restartDhanRuntime restores each lane's own subscriptions on the new token.
// Token-service/paste replacements recycle both sockets, including Synthetic's lane.
func (r *Registry) restartDhanRuntime(ctx context.Context, bothLanes bool) {
	// Warm the universe now so the first scan is not waiting on a multi-MB CSV.
	r.background(func() {
		if _, err := r.dhanInstruments.Load(context.Background(), false); err != nil {
			log.Printf("[Dhan] instrument master load failed after login: %v", err)
		}
	})

	// A reconnect replaces the access token, so the socket opened with the previous
	// token must not survive. The second-lane Dhan feed is not recycled (as in Node).
	r.mu.Lock()
	old := r.dhanFeed
	r.dhanFeed = nil
	var oldBox *dhanLane
	if bothLanes {
		oldBox, r.boxDhanFeed = r.boxDhanFeed, nil
	}
	r.mu.Unlock()
	if old != nil {
		log.Printf("[Broker] recycling the Dhan feed onto the new access token")
		old.stop()
		r.lastTickAt.Store(noTick)
	}
	if oldBox != nil {
		oldBox.stop()
	}

	// Establishing a session is the first moment the static IP can be checked.
	r.VerifyDhanStaticIP(ctx)

	if r.ActiveBroker() == brokers.Dhan {
		if _, err := r.instruments.Load(ctx, true); err != nil {
			log.Printf("[Dhan] universe load after login failed: %v", err)
		}
		r.StartActiveFeed()
		// Replay EACH lane's own table onto its own socket, lane by lane, so the frames
		// are on the wire before the state is published (Node did this synchronously).
		wanted := r.subscriptions.ActiveTokens()
		wantedBox := r.boxSubscriptions.ActiveTokens()
		if len(wanted) > 0 || len(wantedBox) > 0 {
			log.Printf("[Broker] restoring %d futures + %d box Dhan subscription(s) after reconnect", len(wanted), len(wantedBox))
			r.subscribeUpstream(brokers.LaneFutures, wanted)
			r.flushLane(brokers.LaneFutures)
			r.subscribeUpstream(brokers.LaneBox, wantedBox)
			r.flushLane(brokers.LaneBox)
		}
		if h := r.getHooks(); h.Publish != nil {
			h.Publish()
		}
	}
}

// LogoutDhan drops the Dhan session and everything derived from it: token, feed (the
// futures one), instruments, the persisted row.
func (r *Registry) LogoutDhan(ctx context.Context) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.brokerLogin.mu.Lock()
	r.brokerLogin.pausedDay = jsx.IstDayKey(r.now())
	r.brokerLogin.mu.Unlock()
	_, _, meta := r.dhanSession()
	r.setDhanSession(nil, nil, nil)
	if f := r.currentDhanFeed(); f != nil {
		f.stop()
	}
	if meta != nil && meta.source != "" {
		r.mu.Lock()
		box := r.boxDhanFeed
		r.boxDhanFeed = nil
		r.mu.Unlock()
		if box != nil {
			box.stop()
		}
	}
	r.dhanInstruments.Clear()
	sctx, cancel := storeCtx()
	_ = r.store.ClearDhanSession(sctx)
	cancel()
	if r.ActiveBroker() == brokers.Dhan {
		h := r.getHooks()
		if h.InvalidateBooks != nil {
			h.InvalidateBooks()
		}
		if h.Publish != nil {
			h.Publish()
		}
	}
}

// A stopped, superseded feed must not clear a token installed while its callback
// was queued. Credential changes and the ownership check share opMu.
func (r *Registry) onDhanFeedSessionLost(lane *dhanLane, reason string) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	current := lane == r.dhanFeed || lane == r.boxDhanFeed
	r.mu.Unlock()
	if current {
		r.onDhanSessionLost(reason)
	}
}

// onDhanSessionLost handles a session that died mid-flight: fail closed. Token-based
// sessions stop both Dhan lanes; legacy consent sessions keep their original behavior.
func (r *Registry) onDhanSessionLost(reason string) {
	log.Printf("[Dhan] session lost: %s", reason)
	r.sessMu.Lock()
	token, meta := r.dhanToken, r.dhanMeta
	r.dhanToken, r.dhanExpiry = nil, nil
	r.sessMu.Unlock()
	if meta != nil && meta.source != "" {
		r.brokerLogin.mu.Lock()
		if token != nil {
			r.brokerLogin.rejectedToken = *token
		}
		r.brokerLogin.lastErr = "Dhan rejected the saved token. Fetch a new token or paste a fallback."
		r.brokerLogin.mu.Unlock()
		r.mu.Lock()
		box := r.boxDhanFeed
		r.boxDhanFeed = nil
		r.mu.Unlock()
		if box != nil {
			box.stop()
		}
	}
	if f := r.currentDhanFeed(); f != nil {
		f.stop()
	}
	sctx, cancel := storeCtx()
	_ = r.store.ClearDhanSession(sctx)
	cancel()
	if r.ActiveBroker() == brokers.Dhan {
		h := r.getHooks()
		if h.InvalidateBooks != nil {
			h.InvalidateBooks()
		}
		log.Printf("[Broker] dhan session lost: %s", reason)
		if h.OnSessionLost != nil {
			h.OnSessionLost(brokers.Dhan, reason)
		}
		if h.Publish != nil {
			h.Publish()
		}
	}
}

/* ------------------------------- readiness ------------------------------- */

func envFlag(raw string) bool {
	v := strings.ToLower(jsTrim(raw))
	return v == "1" || v == "true" || v == "yes"
}

func (r *Registry) dhanStaticIPDeclared() bool { return envFlag(r.get("DHAN_STATIC_IP_EXPECTED")) }

func (r *Registry) dhanConfiguredIP() string { return jsTrim(r.get("DHAN_STATIC_PUBLIC_IP")) }

func (r *Registry) dhanDataEnabled() bool {
	v := strings.ToLower(jsTrim(r.get("DHAN_DATA_ENABLED")))
	return v == "" || v == "1" || v == "true" || v == "yes"
}

func (r *Registry) dhanLiveTradingEnabled() bool { return envFlag(r.get("DHAN_LIVE_TRADING_ENABLED")) }

// DhanStaticIPReady is whether Dhan's static-IP requirement is satisfied: with
// DHAN_STATIC_PUBLIC_IP set, only a positive API verification counts (and an explicit
// non-true DHAN_STATIC_IP_EXPECTED still blocks); without it, the manual declaration.
func (r *Registry) DhanStaticIPReady() bool {
	declared := r.dhanStaticIPDeclared()
	if r.dhanConfiguredIP() == "" {
		return declared
	}
	if _, set := r.lookup("DHAN_STATIC_IP_EXPECTED"); set && !declared {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ip.verified != nil && *r.ip.verified
}

// VerifyDhanStaticIP confirms the configured server IP against Dhan's whitelist
// (GET /ip/getIP). It never fails: an unreachable check sets the verdict to false.
func (r *Registry) VerifyDhanStaticIP(ctx context.Context) VerifyIPResult {
	configured := r.dhanConfiguredIP()
	checkedAt := r.nowMs()
	r.mu.Lock()
	r.ip.checkedAt = &checkedAt
	if configured == "" {
		// Nothing to compare: the verdict stays UNKNOWN and readiness falls back to the
		// manual declaration.
		r.ip.verified, r.ip.primary, r.ip.secondary, r.ip.err = nil, nil, nil, nil
		r.mu.Unlock()
		return VerifyIPResult{CheckedAt: checkedAt}
	}
	r.mu.Unlock()

	if r.usableDhanToken() == "" {
		msg := "Cannot verify the static IP without a Dhan session."
		f := false
		r.mu.Lock()
		r.ip.verified, r.ip.err = &f, &msg
		r.mu.Unlock()
		return VerifyIPResult{ConfiguredIP: configured, CheckedAt: checkedAt, Error: strPtr(msg)}
	}

	res, err := r.dhanClient.GetStaticIP(ctx)
	if err != nil {
		msg := "Static-IP verification failed: " + err.Error()
		f := false
		r.mu.Lock()
		r.ip.verified, r.ip.err = &f, &msg
		r.mu.Unlock()
		return VerifyIPResult{ConfiguredIP: configured, CheckedAt: checkedAt, Error: strPtr(msg)}
	}
	addresses := dhan.ExtractIPv4Addresses(res)
	var primary, secondary *string
	if len(addresses) > 0 {
		primary = strPtr(addresses[0])
	}
	if len(addresses) > 1 {
		secondary = strPtr(addresses[1])
	}
	matched := slices.Contains(addresses, configured)
	var errMsg *string
	switch {
	case matched:
	case len(addresses) == 0:
		fields := strings.Join(res.Keys(), ", ")
		if fields == "" {
			fields = "none"
		}
		errMsg = strPtr("Dhan returned no IP address in its whitelist response, so " +
			"DHAN_STATIC_PUBLIC_IP (" + configured + ") could not be verified. " +
			"Response fields: [" + fields + "]. " +
			"Add a Static IP under My Profile → Access DhanHQ APIs → Static IP Setting.")
	default:
		errMsg = strPtr("DHAN_STATIC_PUBLIC_IP (" + configured + ") does not match Dhan's whitelist (" +
			strings.Join(addresses, ", ") + ").")
	}
	r.mu.Lock()
	r.ip.verified, r.ip.primary, r.ip.secondary, r.ip.err = &matched, primary, secondary, errMsg
	r.mu.Unlock()
	if !matched {
		log.Printf("[Dhan] %s", *errMsg)
	}
	return VerifyIPResult{
		Verified: matched, ConfiguredIP: configured, PrimaryIP: primary, SecondaryIP: secondary,
		CheckedAt: checkedAt, Error: errMsg,
	}
}

// EnsureDhanStaticIPVerified verifies only when an IP is configured, no verdict exists
// yet and a session can do the check (the status endpoint calls it).
func (r *Registry) EnsureDhanStaticIPVerified(ctx context.Context) {
	if r.dhanConfiguredIP() == "" {
		return
	}
	r.mu.Lock()
	known := r.ip.verified != nil
	r.mu.Unlock()
	if known || r.usableDhanToken() == "" {
		return
	}
	r.VerifyDhanStaticIP(ctx)
}

// DhanStaticIPState is the static-IP detail for the status endpoints.
func (r *Registry) DhanStaticIPState() StaticIPState {
	configured := r.dhanConfiguredIP()
	ready := r.DhanStaticIPReady()
	r.mu.Lock()
	defer r.mu.Unlock()
	st := StaticIPState{
		Ready:       ready,
		Declared:    r.dhanStaticIPDeclared(),
		APIVerified: r.ip.verified,
		PrimaryIP:   r.ip.primary,
		SecondaryIP: r.ip.secondary,
		CheckedAt:   r.ip.checkedAt,
		Error:       r.ip.err,
	}
	if configured != "" {
		st.ConfiguredIP = &configured
	}
	return st
}

// DhanProblems is computeDhanProblems: every operator-facing Dhan problem, in order.
func (r *Registry) DhanProblems() []string {
	problems := []string{}
	if _, ok, reason := r.DhanCredentials(); !ok {
		problems = append(problems, reason)
	}
	token, expiry, _ := r.dhanSession()
	hasToken := token != nil && *token != ""
	if !hasToken {
		problems = append(problems, problemNotConnected)
	} else if dhan.IsTokenExpired(expiry, r.nowMs()) {
		problems = append(problems, problemExpired)
	}
	if !r.dhanDataEnabled() {
		problems = append(problems, "Dhan data API is disabled (DHAN_DATA_ENABLED=false)")
	}
	configured := r.dhanConfiguredIP()
	if !r.DhanStaticIPReady() {
		r.mu.Lock()
		ipErr := r.ip.err
		r.mu.Unlock()
		switch {
		case ipErr != nil && *ipErr != "":
			problems = append(problems, *ipErr)
		case configured == "":
			problems = append(problems, "Static IP not configured — set DHAN_STATIC_PUBLIC_IP (preferred, API-verified) "+
				"or DHAN_STATIC_IP_EXPECTED=true. Dhan live order placement is blocked.")
		default:
			problems = append(problems, "Static IP not yet verified against Dhan — live order placement is blocked.")
		}
	} else if !r.dhanLiveTradingEnabled() {
		problems = append(problems, "Dhan live trading is disabled (DHAN_LIVE_TRADING_ENABLED=false)")
	} else if configured == "" {
		problems = append(problems, "Static IP is accepted on the manual DHAN_STATIC_IP_EXPECTED flag only — "+
			"set DHAN_STATIC_PUBLIC_IP to have it verified against Dhan.")
	}
	if f := r.currentDhanFeed(); f != nil && !f.feed.IsConnected() && hasToken {
		problems = append(problems, "Feed reconnecting")
	}
	if parse := getParseReport(); parse != nil {
		if len(parse.MissingColumns) > 0 {
			problems = append(problems, fmt.Sprintf("Dhan instrument master is missing columns (%s) — "+
				"see /api/dhan/instruments/diagnostics", strings.Join(parse.MissingColumns, ", ")))
		}
		if parse.FnoFutures < 50 {
			problems = append(problems, fmt.Sprintf("Only %d Dhan F&O futures were recognised (expected ~600). "+
				"The board and scanner will be incomplete — see /api/dhan/instruments/diagnostics", parse.FnoFutures))
		}
	}
	return problems
}

// SessionFor is the session state of a broker.
func (r *Registry) SessionFor(broker brokers.ID) SessionState {
	if broker == brokers.Zerodha {
		// Kite tokens die at the IST day boundary; there is no stated instant.
		return SessionState{Broker: brokers.Zerodha, Authenticated: r.deps.Kite.HasSession()}
	}
	token, expiry, meta := r.dhanSession()
	expired := dhan.IsTokenExpired(expiry, r.nowMs())
	s := SessionState{
		Broker:         brokers.Dhan,
		Authenticated:  token != nil && !expired,
		TokenExpiresAt: copyInt(expiry),
		TokenExpired:   expired,
	}
	if meta != nil {
		s.ClientID = strPtr(meta.clientID)
		s.ClientName = strPtr(meta.clientName)
		s.LoginDay = strPtr(meta.loginDay)
		at := meta.loginAt
		s.LoginAt = &at
	}
	return s
}

// HealthFor is the capability readiness of a broker.
func (r *Registry) HealthFor(broker brokers.ID) HealthState {
	session := r.SessionFor(broker)
	if broker == brokers.Zerodha {
		problems := []string{}
		if !session.Authenticated {
			problems = append(problems, "Zerodha is not connected")
		}
		return HealthState{
			Broker:        brokers.Zerodha,
			Authenticated: session.Authenticated,
			DataReady:     session.Authenticated,
			// Zerodha has no static-IP requirement.
			TradingReady:  session.Authenticated,
			FeedConnected: r.hub.IsConnected(),
			Problems:      problems,
		}
	}
	problems := r.DhanProblems()
	dataReady := session.Authenticated && r.dhanDataEnabled()
	ipReady := r.DhanStaticIPReady()
	h := HealthState{
		Broker:             brokers.Dhan,
		Authenticated:      session.Authenticated,
		TokenExpiresAt:     session.TokenExpiresAt,
		TokenExpired:       session.TokenExpired,
		DataReady:          dataReady,
		TradingReady:       dataReady && ipReady && r.dhanLiveTradingEnabled(),
		StaticIPConfigured: &ipReady,
		Problems:           problems,
	}
	if f := r.currentDhanFeed(); f != nil {
		h.FeedConnected = f.feed.IsConnected()
		h.FeedAgeMs = f.feed.FeedAgeMs()
	}
	return h
}

// ActiveSession is the active broker's session.
func (r *Registry) ActiveSession() SessionState { return r.SessionFor(r.ActiveBroker()) }

// ActiveHealth is the active broker's health (route guards use data_ready).
func (r *Registry) ActiveHealth() HealthState { return r.HealthFor(r.ActiveBroker()) }

func copyInt(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
