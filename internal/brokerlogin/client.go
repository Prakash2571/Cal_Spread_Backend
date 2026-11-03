package brokerlogin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxBody = 64 << 10

type Client struct {
	cfg Config
	// HTTP permits loopback transports in tests. Fetch still enforces its deadline
	// and redirect policy when using an injected client.
	HTTP *http.Client
}

func New(c Config) *Client {
	return &Client{cfg: c, HTTP: &http.Client{Timeout: 20 * time.Second}}
}

type Token struct {
	ClientID, AccessToken string
	ExpiresAt             time.Time
}

// Error contains only known codes and safe hints, never the remote response text.
type Error struct {
	Status     int
	Code       string
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	hint := "Unexpected reply; retry fetching or paste an access token."
	switch e.Code {
	case "unauthorized":
		hint = "Check the token API seed, Dhan client ID, Cloudflare service token and server clock."
	case "code_already_used":
		hint = "This 30-second token API code has already been used."
	case "no_token_yet":
		hint = "The shared service has no valid token yet; check its morning login or paste a token."
	case "not_configured":
		hint = "The shared service is not configured; check it or paste a token."
	case "locked":
		hint = "The token API is locked after incorrect codes; wait before fetching again."
	case "rate_limited":
		hint = "The token API rate limit was reached; wait before fetching again."
	case "cloudflare_blocked", "access_redirect":
		hint = "Cloudflare Access refused the service token; check BROKER_LOGIN_CF_CLIENT_ID / BROKER_LOGIN_CF_CLIENT_SECRET."
	case "cloudflare_1010":
		hint = "Cloudflare's browser integrity check refused the request."
	case "wrong_account":
		hint = "The token reply belongs to another Dhan client ID and was not installed."
	case "bad_request":
		hint = "The token API refused the request as malformed."
	case "bad_response":
		hint = "The token API returned an invalid or oversized reply."
	}
	return fmt.Sprintf("Broker login service: HTTP %d %s. %s", e.Status, e.Code, hint)
}

func (e *Error) Permanent() bool {
	return e.Status == 401 || e.Status == 403 || e.Status == 400 ||
		e.Code == "access_redirect" || e.Code == "wrong_account" || e.Code == "not_configured" ||
		(e.Status >= 400 && e.Status < 500 && e.Status != 409 && e.Status != 429)
}

func (c *Client) Fetch(ctx context.Context, now time.Time) (*Token, error) {
	code, err := CodeAt(c.cfg.TokenAPISeed, now)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"client_id": c.cfg.ClientID, "totp": code})
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.URL+"/api/v1/token", bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("Broker login service URL is invalid.")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "calspread-backend/1")
	req.Header.Set("CF-Access-Client-Id", c.cfg.CFClientID)
	req.Header.Set("CF-Access-Client-Secret", c.cfg.CFClientSecret)
	httpClient := *c.HTTP
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := httpClient.Do(req)
	if err != nil {
		// Transport errors can include the private URL, headers or DNS hostname.
		if ctx.Err() != nil {
			return nil, errors.New("Broker login service request was cancelled or timed out.")
		}
		return nil, errors.New("Broker login service is unreachable. Retry fetching or paste an access token.")
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if readErr != nil || len(raw) > maxBody {
		return nil, &Error{Status: resp.StatusCode, Code: "bad_response"}
	}
	retry := retryAfter(resp.Header.Get("Retry-After"), now)
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return nil, &Error{Status: resp.StatusCode, Code: "access_redirect"}
	}
	if resp.StatusCode == http.StatusOK {
		var out struct {
			ClientID    string `json:"client_id"`
			AccessToken string `json:"access_token"`
			ExpiresIn   int64  `json:"expires_in"`
		}
		if json.Unmarshal(raw, &out) != nil || strings.TrimSpace(out.AccessToken) == "" || out.ExpiresIn <= 0 || out.ExpiresIn > 7*24*60*60 {
			return nil, &Error{Status: resp.StatusCode, Code: "bad_response"}
		}
		if out.ClientID != c.cfg.ClientID {
			return nil, &Error{Status: resp.StatusCode, Code: "wrong_account"}
		}
		return &Token{ClientID: out.ClientID, AccessToken: strings.TrimSpace(out.AccessToken),
			ExpiresAt: now.Add(time.Duration(out.ExpiresIn) * time.Second)}, nil
	}
	var refusal struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(raw, &refusal)
	codeName := fmt.Sprintf("http_%d", resp.StatusCode)
	switch resp.StatusCode {
	case 400:
		codeName = "bad_request"
	case 401:
		codeName = "unauthorized"
	case 403:
		codeName = "cloudflare_blocked"
		if bytes.Contains(raw, []byte("error code: 1010")) {
			codeName = "cloudflare_1010"
		}
	case 409:
		codeName = "code_already_used"
	case 429:
		codeName = "rate_limited"
		if refusal.Error == "locked" {
			codeName = "locked"
		}
	case 503:
		if refusal.Error == "no_token_yet" || refusal.Error == "not_configured" {
			codeName = refusal.Error
		}
	}
	return nil, &Error{Status: resp.StatusCode, Code: codeName, RetryAfter: retry}
}

func retryAfter(raw string, now time.Time) time.Duration {
	if n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil && n >= 0 {
		return time.Duration(min(n, 24*60*60)) * time.Second
	}
	if at, err := http.ParseTime(raw); err == nil && at.After(now) {
		return min(at.Sub(now), 24*time.Hour)
	}
	return 0
}
