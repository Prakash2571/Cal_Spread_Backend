package registry

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokerlogin"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

const (
	brokerRenewBefore = 5 * time.Minute
	brokerMinGap      = 5 * time.Minute
	brokerCheckEvery  = 5 * time.Minute
)

type brokerLoginController struct {
	mu     sync.Mutex
	cfg    brokerlogin.Config
	client *brokerlogin.Client

	lastAt, fetchedAt, next, lockedUntil, checkedAt time.Time
	lastErr, stopped, pausedDay                     string
	rejectedToken                                   string
	fetching, closed                                bool
	cancel                                          context.CancelFunc
	done                                            chan struct{}

	noTokenSince   time.Time
	noTokenAlerted bool
}

func newBrokerLoginController(get func(string) string, transport *http.Client) *brokerLoginController {
	cfg, err := brokerlogin.LoadConfig(get)
	b := &brokerLoginController{cfg: cfg}
	if err != nil {
		b.lastErr, b.stopped = err.Error(), err.Error()
		log.Printf("[Dhan] automatic token fetching is unavailable: %s", b.lastErr)
	} else if cfg.URL != "" {
		b.client = brokerlogin.New(cfg)
		if transport != nil {
			b.client.HTTP = transport
		}
	}
	return b
}

// BrokerLoginStatus is safe for a browser: no access token, seed, service token or host.
type BrokerLoginStatus struct {
	Configured    bool   `json:"configured"`
	AutoLoginTime string `json:"auto_login_time"`
	Fetching      bool   `json:"fetching"`
	LastAttemptAt *int64 `json:"last_attempt_at"`
	LastFetchedAt *int64 `json:"last_fetched_at"`
	NextAttemptAt *int64 `json:"next_attempt_at"`
	LastError     string `json:"last_error"`
	Stopped       bool   `json:"stopped"`
	Paused        bool   `json:"paused"`
}

func millisOrNil(t time.Time) *int64 {
	if t.IsZero() {
		return nil
	}
	v := t.UnixMilli()
	return &v
}

func (r *Registry) BrokerLoginStatus() *BrokerLoginStatus {
	b := r.brokerLogin
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.client == nil && b.lastErr == "" {
		return nil
	}
	now := r.now()
	next := b.next
	if b.client != nil && b.stopped == "" {
		window := r.brokerWindow(now)
		if now.Before(window) {
			next = maxTime(next, window)
		}
		if b.pausedDay == jsx.IstDayKey(now) {
			next = maxTime(next, window.AddDate(0, 0, 1))
		}
	}
	return &BrokerLoginStatus{Configured: b.client != nil, AutoLoginTime: b.cfg.AutoLoginTime,
		Fetching: b.fetching, LastAttemptAt: millisOrNil(b.lastAt), LastFetchedAt: millisOrNil(b.fetchedAt),
		NextAttemptAt: millisOrNil(next), LastError: b.lastErr, Stopped: b.stopped != "", Paused: b.pausedDay == jsx.IstDayKey(now)}
}

var tokenIST = time.FixedZone("IST", 330*60)

func (r *Registry) brokerWindow(now time.Time) time.Time {
	clock, _ := time.Parse("15:04", r.brokerLogin.cfg.AutoLoginTime)
	local := now.In(tokenIST)
	return time.Date(local.Year(), local.Month(), local.Day(), clock.Hour(), clock.Minute(), 0, 0, tokenIST)
}

func maxTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return b
	}
	return a
}

// StartDhanTokenService runs independently of browser visits and the boot context,
// which ends after startup. Shutdown owns and cancels this worker explicitly.
func (r *Registry) StartDhanTokenService() {
	b := r.brokerLogin
	b.mu.Lock()
	if b.closed || b.client == nil || b.cancel != nil {
		b.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	b.cancel, b.done = cancel, done
	b.mu.Unlock()
	go func() {
		defer close(done)
		r.brokerPass(ctx)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.brokerPass(ctx)
			}
		}
	}()
}

func (r *Registry) StopDhanTokenService(ctx context.Context) error {
	b := r.brokerLogin
	b.mu.Lock()
	b.closed = true
	cancel, done := b.cancel, b.done
	b.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// brokerDue mirrors Live Index Algo's daily window and recovery policy. A valid
// pasted fallback is not replaced by an automatic service token.
func (r *Registry) brokerDue(now time.Time) bool {
	b := r.brokerLogin
	b.mu.Lock()
	blocked := b.closed || b.client == nil || b.stopped != "" || b.pausedDay == jsx.IstDayKey(now) || now.Before(b.next) || now.Before(b.lockedUntil)
	b.mu.Unlock()
	if blocked || now.Before(r.brokerWindow(now)) {
		return false
	}
	token, expiry, meta := r.dhanSession()
	if token == nil || *token == "" || (expiry != nil && *expiry-now.UnixMilli() < brokerRenewBefore.Milliseconds()) {
		return true
	}
	if meta != nil && meta.source == "MANUAL" {
		return false
	}
	return expiry == nil || jsx.IstDayKey(time.UnixMilli(*expiry)) <= jsx.IstDayKey(now)
}

func (r *Registry) brokerPass(ctx context.Context) {
	if ctx.Err() != nil || !r.opMu.TryLock() {
		return
	}
	defer r.opMu.Unlock()
	r.checkDhanToken(ctx)
	if r.brokerDue(r.now()) {
		_ = r.fetchBrokerToken(ctx, true)
	}
}

func (r *Registry) checkDhanToken(ctx context.Context) {
	b := r.brokerLogin
	token := r.usableDhanToken()
	if token == "" {
		return
	}
	b.mu.Lock()
	due := !b.closed && b.client != nil && r.now().Sub(b.checkedAt) >= brokerCheckEvery
	if due {
		b.checkedAt = r.now()
	}
	b.mu.Unlock()
	if !due {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, err := r.dhanClient.GetProfile(ctx)
	if dhan.IsAuthError(err) {
		r.onDhanSessionLost("Dhan rejected the access token; fetch a new token or paste one.")
	}
}

func (r *Registry) FetchBrokerToken(ctx context.Context) (SessionState, error) {
	if !r.opMu.TryLock() {
		return SessionState{}, dhan.NewError("A broker operation is already running. Try again shortly.", 409, "BUSY", nil)
	}
	defer r.opMu.Unlock()
	b := r.brokerLogin
	b.mu.Lock()
	if b.closed || b.client == nil {
		msg := b.lastErr
		if msg == "" {
			msg = "Automatic token fetching is not configured. Set BROKER_LOGIN_URL and its server credentials, or paste an access token."
		}
		b.mu.Unlock()
		return SessionState{}, dhan.NewError(msg, 409, "CONFIG", nil)
	}
	if r.now().Before(b.lockedUntil) {
		b.mu.Unlock()
		return SessionState{}, dhan.NewError("The token API is locked. Wait before fetching again, or paste an access token.", 429, "LOCKED", nil)
	}
	b.stopped, b.pausedDay = "", ""
	b.mu.Unlock()
	err := r.fetchBrokerToken(ctx, false)
	return r.SessionFor(brokers.Dhan), err
}

// opMu covers the whole fetch/install, so a late automatic response cannot overwrite
// an operator's pasted fallback. One used-code retry waits for a new TOTP step.
func (r *Registry) fetchBrokerToken(ctx context.Context, automatic bool) error {
	b := r.brokerLogin
	ctx, cancel := context.WithTimeout(ctx, 75*time.Second)
	defer cancel()
	b.mu.Lock()
	b.fetching = true
	b.mu.Unlock()
	defer func() { b.mu.Lock(); b.fetching = false; b.mu.Unlock() }()
	fetch := func() (*brokerlogin.Token, error) {
		now := r.now()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if automatic && now.Before(r.brokerWindow(now)) {
			return nil, context.Canceled
		}
		b.mu.Lock()
		b.lastAt = now
		b.mu.Unlock()
		return b.client.Fetch(ctx, now)
	}
	tok, err := fetch()
	var refusal *brokerlogin.Error
	if errors.As(err, &refusal) && refusal.Code == "code_already_used" {
		now := r.now()
		wait := time.Unix((now.Unix()/30+1)*30, 0).Sub(now) + 250*time.Millisecond
		wait = max(wait, min(refusal.RetryAfter, 31*time.Second))
		sleep := r.deps.BrokerLoginSleep
		if sleep == nil {
			sleep = waitForTokenStep
		}
		if err = sleep(ctx, wait); err == nil {
			tok, err = fetch()
		}
	}
	if err == nil {
		b.mu.Lock()
		rejected := tok.AccessToken == b.rejectedToken
		b.mu.Unlock()
		if rejected {
			err = dhan.NewError("The shared service still serves a token Dhan rejected. Check its login or paste a new access token.", 503, "REJECTED_TOKEN", nil)
		} else {
			err = r.installDhanAccessToken(ctx, tok.ClientID, tok.AccessToken, millisOrNil(tok.ExpiresAt), "BROKER_LOGIN")
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.brokerFailed(err)
		if errors.As(err, &refusal) {
			status := refusal.Status
			if status < 400 {
				status = 502
			}
			return dhan.NewError(refusal.Error(), status, refusal.Code, nil)
		}
		return err
	}
	now := r.now()
	b.mu.Lock()
	b.fetchedAt, b.lastErr, b.stopped = now, "", ""
	b.noTokenSince, b.noTokenAlerted = time.Time{}, false
	b.next = now.Add(brokerMinGap)
	if jsx.IstDayKey(tok.ExpiresAt) <= jsx.IstDayKey(now) {
		b.next = now.Add(time.Minute)
	}
	b.mu.Unlock()
	return nil
}

func waitForTokenStep(ctx context.Context, wait time.Duration) error {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (r *Registry) brokerFailed(err error) {
	b := r.brokerLogin
	now := r.now()
	var refusal *brokerlogin.Error
	b.mu.Lock()
	previousError := b.lastErr
	b.lastErr = err.Error()
	wait := time.Minute
	if de, ok := dhan.AsError(err); ok && de.Code == "REJECTED_TOKEN" {
		wait = brokerMinGap
	}
	if errors.As(err, &refusal) {
		switch {
		case refusal.Permanent():
			b.stopped = b.lastErr
		case refusal.Code == "locked":
			wait = max(10*time.Minute, refusal.RetryAfter)
			b.lockedUntil = now.Add(wait)
		case refusal.Code == "no_token_yet":
			wait = max(wait, refusal.RetryAfter)
			if b.noTokenSince.IsZero() {
				b.noTokenSince = now
			}
			if now.Sub(b.noTokenSince) >= 30*time.Minute {
				b.lastErr += " No token has been available for 30 minutes; check the shared service's morning login."
				if !b.noTokenAlerted {
					log.Printf("[Dhan] shared token service has no token after 30 minutes; operator recovery is required")
					b.noTokenAlerted = true
				}
			}
		default:
			wait = max(wait, refusal.RetryAfter)
		}
	}
	b.next = now.Add(wait)
	message := b.lastErr
	b.mu.Unlock()
	if message != previousError {
		log.Printf("[Dhan] token fetch failed: %s", message)
	}
}

// SetManualDhanToken validates the pasted token with Dhan before changing any saved
// token or either runtime lane. The service configuration is not needed for a paste.
func (r *Registry) SetManualDhanToken(ctx context.Context, token string) (SessionState, error) {
	if !r.opMu.TryLock() {
		return SessionState{}, dhan.NewError("A broker operation is already running. Try again shortly.", 409, "BUSY", nil)
	}
	defer r.opMu.Unlock()
	r.brokerLogin.mu.Lock()
	closed := r.brokerLogin.closed
	r.brokerLogin.mu.Unlock()
	if closed {
		return SessionState{}, dhan.NewError("The backend is shutting down. Retry after it restarts.", 503, "STOPPING", nil)
	}
	creds, ok, reason := r.DhanCredentials()
	if !ok {
		return SessionState{}, dhan.NewError(reason, 409, "CONFIG", nil)
	}
	token = strings.TrimSpace(token)
	if token == "" || len(token) > 32<<10 || strings.ContainsAny(token, "\r\n\t ") {
		return SessionState{}, dhan.NewError("Paste a valid Dhan access token.", 400, "TOKEN", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cfg := dhan.HTTPConfigFromEnv(r.get)
	cfg.APIRoot, cfg.Client = r.deps.Dhan.APIRoot, r.deps.Dhan.HTTPClient
	cfg.AccessToken, cfg.ClientID = func() string { return token }, func() string { return creds.ClientID }
	cfg.MaxReadAttempts = 1
	client := dhan.NewClient(dhan.NewHTTP(cfg), func() string { return creds.ClientID })
	profile, err := client.GetProfile(ctx)
	if err != nil {
		status := 502
		if dhan.IsAuthError(err) {
			status = 400
		}
		return SessionState{}, dhan.NewError("Dhan could not validate the pasted access token. Check the token and try again.", status, "TOKEN_VALIDATION", nil)
	}
	id, _ := profile.DhanClientID.Str()
	if id != creds.ClientID {
		return SessionState{}, dhan.NewError("The pasted token does not belong to the configured DHAN_CLIENT_ID.", 400, "WRONG_ACCOUNT", nil)
	}
	expiry := dhan.ParseExpiry(profile.TokenValidity)
	if jwt := jwtExpiry(token); jwt != nil && (expiry == nil || *jwt < *expiry) {
		expiry = jwt
	}
	if dhan.IsTokenExpired(expiry, r.nowMs()) {
		return SessionState{}, dhan.NewError("The pasted access token has expired.", 400, "EXPIRED", nil)
	}
	if err := r.installDhanAccessToken(ctx, creds.ClientID, token, expiry, "MANUAL"); err != nil {
		return SessionState{}, err
	}
	r.brokerLogin.mu.Lock()
	r.brokerLogin.pausedDay = ""
	r.brokerLogin.rejectedToken = ""
	r.brokerLogin.next = r.now().Add(brokerMinGap)
	r.brokerLogin.mu.Unlock()
	return r.SessionFor(brokers.Dhan), nil
}

func jwtExpiry(token string) *int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	var claims struct {
		Exp json.Number `json:"exp"`
	}
	if err != nil || json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	seconds, err := claims.Exp.Int64()
	if err != nil || seconds <= 0 || seconds > 253402300799 {
		return nil
	}
	ms := seconds * 1000
	return &ms
}

func (r *Registry) installDhanAccessToken(ctx context.Context, clientID, token string, expiry *int64, source string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	oldToken, _, oldMeta := r.dhanSession()
	name, ucc := "", ""
	poa := false
	if oldMeta != nil && oldMeta.clientID == clientID {
		name, ucc, poa = oldMeta.clientName, oldMeta.clientUcc, oldMeta.powerOfAttorney
	}
	now := r.now()
	rec := DhanSessionRecord{AccessToken: token, DhanClientID: clientID, DhanClientName: name, DhanClientUcc: ucc,
		GivenPowerOfAttorney: poa, ExpiryTime: expiry, LoginDate: jsx.IstDayKey(now), Source: source}
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err := r.store.SaveDhanSession(sctx, rec)
	cancel()
	if err != nil {
		return dhan.NewError("The Dhan token could not be saved. Check PostgreSQL and retry fetching or pasting it.", 503, "PERSISTENCE", nil)
	}
	r.setDhanSession(&token, copyInt(expiry), &dhanMeta{clientID: clientID, clientName: name, clientUcc: ucc,
		powerOfAttorney: poa, loginDay: rec.LoginDate, loginAt: now.UnixMilli(), source: source})
	if oldToken == nil || *oldToken != token {
		r.restartDhanRuntime(ctx, true)
	}
	log.Printf("[Dhan] access token installed (%s); session saved when PostgreSQL is enabled", source)
	return nil
}
