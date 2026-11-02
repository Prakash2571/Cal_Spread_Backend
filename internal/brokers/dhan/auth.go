package dhan

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// AppCredentials are the Dhan app credentials (DhanAppCredentials).
type AppCredentials struct {
	ClientID    string
	APIKey      string
	APISecret   string
	RedirectURL string
	PostbackURL string
}

// ReadCredentials is readDhanCredentials: DHAN_CLIENT_ID, DHAN_API_KEY and
// DHAN_API_SECRET are required (else ok is false with "Dhan is not configured: <list>
// missing."); DHAN_REDIRECT_URL and DHAN_POSTBACK_URL are optional. All are trimmed.
func ReadCredentials(get config.Getter) (creds AppCredentials, ok bool, reason string) {
	creds = AppCredentials{
		ClientID:    jsTrim(get("DHAN_CLIENT_ID")),
		APIKey:      jsTrim(get("DHAN_API_KEY")),
		APISecret:   jsTrim(get("DHAN_API_SECRET")),
		RedirectURL: jsTrim(get("DHAN_REDIRECT_URL")),
		PostbackURL: jsTrim(get("DHAN_POSTBACK_URL")),
	}
	var missing []string
	if creds.ClientID == "" {
		missing = append(missing, "DHAN_CLIENT_ID")
	}
	if creds.APIKey == "" {
		missing = append(missing, "DHAN_API_KEY")
	}
	if creds.APISecret == "" {
		missing = append(missing, "DHAN_API_SECRET")
	}
	if len(missing) > 0 {
		return AppCredentials{}, false, fmt.Sprintf("Dhan is not configured: %s missing.", strings.Join(missing, ", "))
	}
	return creds, true, ""
}

// AuthOptions points the consent calls at an auth host (tests use httptest).
type AuthOptions struct {
	Root      string       // default DefaultAuthRoot
	Client    *http.Client // default a plain client
	TimeoutMs int          // default 10000
}

func (o AuthOptions) withDefaults() AuthOptions {
	if o.Root == "" {
		o.Root = DefaultAuthRoot
	}
	if o.Client == nil {
		o.Client = &http.Client{}
	}
	if o.TimeoutMs <= 0 {
		o.TimeoutMs = 10000
	}
	return o
}

// LoginURL is dhanLoginUrl: the browser login page for a consent id.
func LoginURL(authRoot, consentAppID string) string {
	if authRoot == "" {
		authRoot = DefaultAuthRoot
	}
	return authRoot + "/login/consentApp-login?consentAppId=" + encodeURIComponent(consentAppID)
}

// Consent is the result of step 1 of the login flow.
type Consent struct {
	ConsentAppID string `json:"consentAppId"`
	LoginURL     string `json:"loginUrl"`
}

// ConsentSession is what consume-consent yields (DhanConsentSession).
type ConsentSession struct {
	DhanClientID         string
	DhanClientName       string
	DhanClientUcc        string
	GivenPowerOfAttorney bool
	AccessToken          string
	// ExpiryTime is epoch ms, or nil when Dhan did not state one (UNKNOWN, not expired).
	ExpiryTime *int64
}

// authFetch is the bounded request against the AUTH host: Accept + app_id + app_secret
// only, no access-token, not paced by HTTP.
func authFetch(ctx context.Context, url string, creds AppCredentials, method string, o AuthOptions) (json.RawMessage, error) {
	attemptCtx, cancel := context.WithTimeout(ctx, time.Duration(o.TimeoutMs)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(attemptCtx, method, url, nil)
	if err != nil {
		return nil, NewError(fmt.Sprintf("Dhan authentication request failed: %v", err), 0, "NETWORK", nil)
	}
	req.Header.Set("Accept", "application/json")
	setRawHeader(req.Header, "app_id", creds.APIKey)
	setRawHeader(req.Header, "app_secret", creds.APISecret)
	res, err := o.Client.Do(req)
	if err != nil {
		if errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, NewError(fmt.Sprintf("Dhan authentication request timed out after %dms.", o.TimeoutMs), 0, "NETWORK", nil)
		}
		return nil, NewError(fmt.Sprintf("Dhan authentication request failed: %v", err), 0, "NETWORK", nil)
	}
	parsed := bodyJSON(readBodyText(res))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		record, _ := ParseJSON(parsed)
		message := fmt.Sprintf("Dhan authentication failed (HTTP %d).", res.StatusCode)
		for _, k := range []string{"errorMessage", "message"} {
			if s, ok := record.Get(k).Str(); ok && s != "" {
				message = s
				break
			}
		}
		if res.StatusCode == 401 || res.StatusCode == 403 {
			return nil, NewAuthError(message, res.StatusCode, "", nullable(parsed))
		}
		return nil, NewError(message, res.StatusCode, "", nullable(parsed))
	}
	return parsed, nil
}

// GenerateConsent is generateDhanConsent (step 1): POST
// <root>/app/generate-consent?client_id=… and return the consent id with the browser
// login URL.
func GenerateConsent(ctx context.Context, creds AppCredentials, opts AuthOptions) (Consent, error) {
	o := opts.withDefaults()
	url := o.Root + "/app/generate-consent?client_id=" + encodeURIComponent(creds.ClientID)
	raw, err := authFetch(ctx, url, creds, http.MethodPost, o)
	if err != nil {
		return Consent{}, err
	}
	body, _ := ParseJSON(raw)
	id, ok := body.Get("consentAppId").Str()
	if !ok || id == "" {
		return Consent{}, NewError(
			"Dhan did not return a consentAppId. Check DHAN_API_KEY / DHAN_API_SECRET and that the app is active.",
			502, "NO_CONSENT", nullable(raw))
	}
	return Consent{ConsentAppID: id, LoginURL: LoginURL(o.Root, id)}, nil
}

// ConsumeConsent is consumeDhanConsent (step 3): GET
// <root>/app/consumeApp-consent?tokenId=… and exchange the single-use tokenId for an
// access token.
func ConsumeConsent(ctx context.Context, creds AppCredentials, tokenID string, opts AuthOptions) (ConsentSession, error) {
	o := opts.withDefaults()
	url := o.Root + "/app/consumeApp-consent?tokenId=" + encodeURIComponent(tokenID)
	raw, err := authFetch(ctx, url, creds, http.MethodGet, o)
	if err != nil {
		return ConsentSession{}, err
	}
	body, _ := ParseJSON(raw)
	accessToken, _ := body.Get("accessToken").Str()
	if accessToken == "" {
		// The body is deliberately not echoed: it is an auth response.
		return ConsentSession{}, NewError(
			"Dhan did not return an access token for this tokenId. It may already have been used or expired.",
			502, "NO_ACCESS_TOKEN", nil)
	}
	str := func(k string) string { s, _ := body.Get(k).Str(); return s }
	clientID := str("dhanClientId")
	if clientID == "" {
		clientID = creds.ClientID
	}
	poa := body.Get("givenPowerOfAttorney")
	b, isBool := poa.Bool()
	s, isStr := poa.Str()
	return ConsentSession{
		AccessToken:          accessToken,
		DhanClientID:         clientID,
		DhanClientName:       str("dhanClientName"),
		DhanClientUcc:        str("dhanClientUcc"),
		GivenPowerOfAttorney: (isBool && b) || (isStr && s == "true"),
		ExpiryTime:           ParseExpiry(body.Get("expiryTime")),
	}, nil
}

// ParseExpiry is parseExpiry: a finite number (or numeric string) below 1e11 is epoch
// seconds, otherwise epoch ms (both rounded like Math.round); another non-blank string
// goes through Date.parse with zone-less date-times in the process time zone. nil is
// UNKNOWN.
func ParseExpiry(value Value) *int64 { return parseExpiryIn(value, time.Local) }

func parseExpiryIn(value Value, loc *time.Location) *int64 {
	scale := func(v float64) *int64 {
		var r float64
		if v < 1e11 {
			r = jsRound(v * 1000)
		} else {
			r = jsRound(v)
		}
		out := clampToInt64(r)
		return &out
	}
	if n, ok := value.Num(); ok && !math.IsNaN(n) && !math.IsInf(n, 0) {
		return scale(n)
	}
	if s, ok := value.Str(); ok && jsTrim(s) != "" {
		if n := jsStringToNumber(s); !math.IsNaN(n) && !math.IsInf(n, 0) {
			return scale(n)
		}
		if ms := jsDateParse(s, loc); !math.IsNaN(ms) {
			out := int64(ms)
			return &out
		}
	}
	return nil
}

// IsTokenExpired is isDhanTokenExpired: an unknown (nil) expiry is NOT expired; a
// stated one is expired when it is at or before now.
func IsTokenExpired(expiryTime *int64, nowMs int64) bool {
	if expiryTime == nil {
		return false
	}
	return *expiryTime <= nowMs
}

// SessionRecord is the persisted Dhan session (the dhan_session row) without its
// access token, which RedactedSession never needs.
type SessionRecord struct {
	DhanClientID         string
	DhanClientName       string
	DhanClientUcc        string
	GivenPowerOfAttorney bool
	ExpiryTime           *int64
	LoginDate            string
	LoginAt              *time.Time
}

// Redacted is the ONLY session shape that may be sent to a browser.
type Redacted struct {
	ClientID        string  `json:"client_id"`
	ClientName      string  `json:"client_name"`
	ClientUcc       string  `json:"client_ucc"`
	PowerOfAttorney bool    `json:"power_of_attorney"`
	TokenExpiresAt  *int64  `json:"token_expires_at"`
	TokenExpired    bool    `json:"token_expired"`
	LoginDate       string  `json:"login_date"`
	LoginAt         *string `json:"login_at"`
}

// RedactedSession is redactedSession; token_expired is evaluated at now.
func RedactedSession(s SessionRecord, now time.Time) Redacted {
	var loginAt *string
	if s.LoginAt != nil {
		v := jsx.ISO(*s.LoginAt)
		loginAt = &v
	}
	return Redacted{
		ClientID:        s.DhanClientID,
		ClientName:      s.DhanClientName,
		ClientUcc:       s.DhanClientUcc,
		PowerOfAttorney: s.GivenPowerOfAttorney,
		TokenExpiresAt:  s.ExpiryTime,
		TokenExpired:    IsTokenExpired(s.ExpiryTime, now.UnixMilli()),
		LoginDate:       s.LoginDate,
		LoginAt:         loginAt,
	}
}
