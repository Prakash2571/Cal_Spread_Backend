package httpx

import (
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// DefaultLimitMessage is the 429 body text when a limiter has no message of its own.
const DefaultLimitMessage = "Too many requests. Please slow down."

type bucket struct {
	count   int
	resetAt int64 // epoch ms
}

// Limiter is ratelimit.ts: an in-memory fixed window per client IP. The window starts at
// a client's first request, every request counts (rejected ones too), and a request is
// rejected when its count exceeds max. Each Limiter has its own counters, so a global
// limiter and a route limiter both count the same request. Time is whole milliseconds,
// as in Node.
type Limiter struct {
	windowMs  int64
	max       int
	message   string
	now       func() time.Time
	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep int64
}

// NewLimiter returns a limiter. An empty message means DefaultLimitMessage; now may be nil.
func NewLimiter(window time.Duration, max int, message string, now func() time.Time) *Limiter {
	if message == "" {
		message = DefaultLimitMessage
	}
	if now == nil {
		now = time.Now
	}
	return &Limiter{
		windowMs: window.Milliseconds(), max: max, message: message, now: now,
		buckets: map[string]*bucket{}, lastSweep: now().UnixMilli(),
	}
}

// Allow counts a request from ip and reports whether it may proceed; retryAfter is the
// Retry-After header value (seconds) for a rejection.
func (l *Limiter) Allow(ip string) (ok bool, retryAfter int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now().UnixMilli()
	l.sweep(now)
	b := l.buckets[ip]
	if b == nil || now > b.resetAt { // strictly after: a request on the boundary still belongs to the old window
		b = &bucket{resetAt: now + l.windowMs}
		l.buckets[ip] = b
	}
	b.count++
	if b.count > l.max {
		return false, int(math.Ceil(float64(b.resetAt-now) / 1000))
	}
	return true, 0
}

// sweep drops expired buckets at most once per window (Node ran an interval for this).
func (l *Limiter) sweep(now int64) {
	if now-l.lastSweep < l.windowMs {
		return
	}
	l.lastSweep = now
	for ip, b := range l.buckets {
		if now > b.resetAt {
			delete(l.buckets, ip)
		}
	}
}

// Middleware rejects over-limit requests with 429, Retry-After and {"error": message}.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok, retry := l.Allow(ClientIP(r)); !ok {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			Error(w, http.StatusTooManyRequests, l.message)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Wrap applies the limiter to one handler function.
func (l *Limiter) Wrap(h http.HandlerFunc) http.HandlerFunc { return l.Middleware(h).ServeHTTP }
