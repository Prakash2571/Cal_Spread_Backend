package dhan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
)

// Dhan hosts (http.ts). Every Go entry point takes the root as configuration so tests
// never contact them.
const (
	DefaultAPIRoot  = "https://api.dhan.co/v2"
	DefaultAuthRoot = "https://auth.dhan.co"
	// ScripMasterURL is the public (no auth) instrument master CSV.
	ScripMasterURL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"
	// ScripMasterFallbackURL is the plain layout used when the detailed master fails.
	ScripMasterFallbackURL = "https://images.dhan.co/api-data/api-scrip-master.csv"
)

// HTTPConfig is DhanHttpConfig plus the Go-only injection points.
type HTTPConfig struct {
	// AccessToken reads the current access token; "" means there is no session.
	AccessToken func() string
	// ClientID reads the Dhan client id sent as `client-id` by the data endpoints.
	ClientID func() string
	// TimeoutMs is the per-attempt deadline.
	TimeoutMs int
	// MinIntervalMs is the minimum gap between request starts.
	MinIntervalMs int
	// MaxReadAttempts is the number of attempts for a retryable read (1 disables retry).
	MaxReadAttempts int

	// APIRoot replaces DefaultAPIRoot (tests point it at an httptest server).
	APIRoot string
	// Client is the HTTP client (default: a plain client; deadlines come from TimeoutMs).
	Client *http.Client
	// Now and Sleep are the clock used for pacing and retry back-off.
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
}

// HTTPConfigFromEnv is dhanHttpConfigFromEnv: DHAN_HTTP_TIMEOUT_MS (8000, 500..60000),
// DHAN_MIN_INTERVAL_MS (120, 0..5000), DHAN_MAX_READ_ATTEMPTS (3, 1..6) and a client id
// read from DHAN_CLIENT_ID (trimmed) at call time. Unset, blank or non-finite values
// give the default; others are rounded and clamped. Callers override fields after.
func HTTPConfigFromEnv(get config.Getter) HTTPConfig {
	num := func(name string, fallback, lo, hi int) int {
		raw := get(name)
		if jsTrim(raw) == "" {
			return fallback
		}
		v := jsStringToNumber(raw)
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fallback
		}
		return int(math.Min(float64(hi), math.Max(float64(lo), jsRound(v))))
	}
	return HTTPConfig{
		AccessToken:     func() string { return "" },
		ClientID:        func() string { return jsTrim(get("DHAN_CLIENT_ID")) },
		TimeoutMs:       num("DHAN_HTTP_TIMEOUT_MS", 8000, 500, 60000),
		MinIntervalMs:   num("DHAN_MIN_INTERVAL_MS", 120, 0, 5000),
		MaxReadAttempts: num("DHAN_MAX_READ_ATTEMPTS", 3, 1, 6),
	}
}

// RequestOptions describes one Dhan HTTP call.
type RequestOptions struct {
	Method string // GET, POST, PUT or DELETE (Read defaults to GET)
	Path   string
	// Body is JSON-encoded when non-nil (nil is JavaScript's undefined: no body).
	Body any
	// WithClientID sends the `client-id` header.
	WithClientID bool
	// AbsoluteURL replaces APIRoot+Path.
	AbsoluteURL string
	// Headers are extra headers (applied after Accept/Content-Type).
	Headers map[string]string
	// Anonymous skips the access-token header.
	Anonymous bool
}

// HTTP is DhanHttp: bounded deadlines, strict FIFO pacing (one request at a time, each
// starting at least MinIntervalMs after the previous start), typed errors, and
// retries for reads only.
type HTTP struct {
	cfgMu sync.RWMutex
	cfg   HTTPConfig

	pace   fifoLock
	lastAt int64 // ms of the previous request start; guarded by pace
}

// NewHTTP builds the transport. Zero-valued injection points get real defaults.
func NewHTTP(cfg HTTPConfig) *HTTP {
	if cfg.AccessToken == nil {
		cfg.AccessToken = func() string { return "" }
	}
	if cfg.ClientID == nil {
		cfg.ClientID = func() string { return "" }
	}
	if cfg.APIRoot == "" {
		cfg.APIRoot = DefaultAPIRoot
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Sleep == nil {
		cfg.Sleep = sleepCtx
	}
	if cfg.MaxReadAttempts < 1 {
		cfg.MaxReadAttempts = 1
	}
	if cfg.TimeoutMs <= 0 {
		cfg.TimeoutMs = 8000 // an unset deadline would expire every request at once
	}
	if cfg.MinIntervalMs < 0 {
		cfg.MinIntervalMs = 0
	}
	return &HTTP{cfg: cfg}
}

// SetAccessTokenReader swaps the token source (a session was established or cleared).
func (h *HTTP) SetAccessTokenReader(reader func() string) {
	if reader == nil {
		reader = func() string { return "" }
	}
	h.cfgMu.Lock()
	h.cfg.AccessToken = reader
	h.cfgMu.Unlock()
}

// APIRoot is the REST root, for logs and diagnostics.
func (h *HTTP) APIRoot() string { return h.config().APIRoot }

func (h *HTTP) config() HTTPConfig {
	h.cfgMu.RLock()
	defer h.cfgMu.RUnlock()
	return h.cfg
}

func (h *HTTP) headersFor(cfg HTTPConfig, opts RequestOptions) (http.Header, error) {
	hdr := http.Header{}
	hdr.Set("Accept", "application/json")
	hdr.Set("Content-Type", "application/json")
	for k, v := range opts.Headers {
		setRawHeader(hdr, k, v)
	}
	if !opts.Anonymous {
		token := cfg.AccessToken()
		if token == "" {
			return nil, NewAuthError("No Dhan session: connect Dhan before calling its API.", 401, "", nil)
		}
		// Dhan v2 authenticates with a bare `access-token` header, not a Bearer scheme.
		setRawHeader(hdr, "access-token", token)
	}
	if opts.WithClientID {
		clientID := cfg.ClientID()
		if clientID == "" {
			return nil, NewError("DHAN_CLIENT_ID is not configured.", 0, "CONFIG", nil)
		}
		setRawHeader(hdr, "client-id", clientID)
	}
	return hdr, nil
}

// setRawHeader replaces any spelling of name with exactly name (the wire keeps the
// lower-case / underscore names the Node client sends).
func setRawHeader(h http.Header, name, value string) {
	for k := range h {
		if strings.EqualFold(k, name) {
			delete(h, k)
		}
	}
	h[name] = []string{value}
}

// Request is one attempt; it never retries. The result is the response body as JSON:
// the body itself when it parsed, {"message": first 500 chars} when it did not, and
// null when it was empty.
func (h *HTTP) Request(ctx context.Context, opts RequestOptions) (json.RawMessage, error) {
	cfg := h.config()
	hdr, err := h.headersFor(cfg, opts)
	if err != nil {
		return nil, err
	}
	url := opts.AbsoluteURL
	if url == "" {
		url = cfg.APIRoot + opts.Path
	}
	var payload []byte
	if opts.Body != nil {
		payload, err = encodeJSON(opts.Body)
		if err != nil {
			return nil, fmt.Errorf("dhan: encoding the %s %s body: %w", opts.Method, opts.Path, err)
		}
	}

	if err := h.pace.lock(ctx); err != nil {
		return nil, NewNetworkError(fmt.Sprintf("Dhan request failed (%s %s): %v", opts.Method, opts.Path, err), nil)
	}
	defer h.pace.unlock()

	gap := int64(cfg.MinIntervalMs) - (cfg.Now().UnixMilli() - h.lastAt)
	if gap > 0 {
		if err := cfg.Sleep(ctx, time.Duration(gap)*time.Millisecond); err != nil {
			return nil, NewNetworkError(fmt.Sprintf("Dhan request failed (%s %s): %v", opts.Method, opts.Path, err), nil)
		}
	}
	h.lastAt = cfg.Now().UnixMilli()

	attemptCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.TimeoutMs)*time.Millisecond)
	defer cancel()
	var bodyReader io.Reader
	if payload != nil {
		bodyReader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(attemptCtx, opts.Method, url, bodyReader)
	if err != nil {
		return nil, NewNetworkError(fmt.Sprintf("Dhan request failed (%s %s): %v", opts.Method, opts.Path, err), nil)
	}
	req.Header = hdr
	res, err := cfg.Client.Do(req)
	if err != nil {
		if errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
			return nil, NewNetworkError(fmt.Sprintf("Dhan request timed out after %dms (%s %s)", cfg.TimeoutMs, opts.Method, opts.Path), nil)
		}
		return nil, NewNetworkError(fmt.Sprintf("Dhan request failed (%s %s): %v", opts.Method, opts.Path, err), nil)
	}
	text := readBodyText(res)

	parsed := bodyJSON(text)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if res.StatusCode == 429 {
			var retryAfter *float64
			if v := jsStringToNumber(strings.Join(res.Header.Values("Retry-After"), ", ")); !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 {
				retryAfter = &v
			}
			return nil, NewRateLimitError(fmt.Sprintf("Dhan rate limit hit (%s %s).", opts.Method, opts.Path), retryAfter, nullable(parsed))
		}
		return nil, NormalizeError(res.StatusCode, nullable(parsed), fmt.Sprintf("Dhan API error %d (%s %s).", res.StatusCode, opts.Method, opts.Path))
	}
	// Dhan sometimes wraps a failure in a 200 with a status field.
	if v, err := ParseJSON(parsed); err == nil {
		if s, ok := v.Get("status").Str(); ok && asciiEqualFold(s, "failed") {
			return nil, NormalizeError(400, parsed, fmt.Sprintf("Dhan API reported failure (%s).", opts.Path))
		}
	}
	return parsed, nil
}

// readBodyText is `await res.text().catch(() => "")`: a failed body read is an empty
// body, and a leading UTF-8 BOM is dropped as TextDecoder does.
func readBodyText(res *http.Response) string {
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(string(b), "\ufeff")
}

// bodyJSON is the transport's body rule: "" → null, JSON → itself, else
// {"message": text.slice(0, 500)}.
func bodyJSON(text string) json.RawMessage {
	if text == "" {
		return json.RawMessage("null")
	}
	if _, err := ParseJSON([]byte(text)); err == nil {
		return json.RawMessage(text)
	}
	return json.RawMessage(marshalNoEscape(map[string]string{"message": utf16Prefix(text, 500)}))
}

// nullable maps a JSON null body to nil (the TS `body` of null).
func nullable(raw json.RawMessage) json.RawMessage {
	if string(raw) == "null" {
		return nil
	}
	return raw
}

// Read is a READ with bounded retries for transient failures (isRetryableRead): the
// wait is Retry-After (capped at 10 s) when Dhan sent one, else attempt × 300 ms.
// Reads that are POSTs (margin, quotes, charts) retry too. Method defaults to GET.
func (h *HTTP) Read(ctx context.Context, opts RequestOptions) (json.RawMessage, error) {
	if opts.Method == "" {
		opts.Method = http.MethodGet
	}
	if opts.Method != http.MethodGet && opts.Method != http.MethodPost {
		return nil, fmt.Errorf("dhan: Read does not accept method %s", opts.Method)
	}
	cfg := h.config()
	var lastErr error
	for attempt := 1; attempt <= cfg.MaxReadAttempts; attempt++ {
		res, err := h.Request(ctx, opts)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if !IsRetryableRead(err) || attempt == cfg.MaxReadAttempts || ctx.Err() != nil {
			return nil, err
		}
		wait := float64(attempt * 300)
		if de, ok := AsError(err); ok && de.Class == ClassRateLimit && de.RetryAfterSec != nil && *de.RetryAfterSec != 0 {
			wait = math.Min(10000, *de.RetryAfterSec*1000)
		}
		if serr := cfg.Sleep(ctx, time.Duration(wait*float64(time.Millisecond))); serr != nil {
			return nil, err
		}
	}
	return nil, lastErr
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// fifoLock is a mutex granted in arrival order, mirroring the single promise chain
// DhanHttp serialises its requests on (Go's sync.Mutex is not FIFO).
type fifoLock struct {
	mu      sync.Mutex
	held    bool
	waiters []chan struct{}
}

func (l *fifoLock) lock(ctx context.Context) error {
	l.mu.Lock()
	if !l.held {
		l.held = true
		l.mu.Unlock()
		return nil
	}
	ch := make(chan struct{})
	l.waiters = append(l.waiters, ch)
	l.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		l.mu.Lock()
		for i, w := range l.waiters {
			if w == ch {
				l.waiters = append(l.waiters[:i], l.waiters[i+1:]...)
				l.mu.Unlock()
				return ctx.Err()
			}
		}
		l.mu.Unlock()
		// Ownership was handed over while we were giving up: pass it on.
		l.unlock()
		return ctx.Err()
	}
}

func (l *fifoLock) unlock() {
	l.mu.Lock()
	if len(l.waiters) > 0 {
		ch := l.waiters[0]
		l.waiters = l.waiters[1:]
		l.mu.Unlock()
		close(ch) // ownership passes directly to the next waiter
		return
	}
	l.held = false
	l.mu.Unlock()
}
