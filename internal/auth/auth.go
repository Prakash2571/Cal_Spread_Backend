// Package auth is the admin session layer: opaque bearer tokens with a "full" or "trade"
// role, a 24-hour lifetime, the x-admin-token header, and the constant-time secret check
// shared by the verify and token routes.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
)

// Role is what a session may do. The zero value means "no valid session".
type Role string

const (
	RoleNone  Role = ""
	RoleFull  Role = "full"  // Zerodha connect, broker switch, settings, deletes
	RoleTrade Role = "trade" // view, take and close trades
)

// SessionTTL is how long a token lives. It is fixed at issue; there is no sliding renewal.
const SessionTTL = 24 * time.Hour

// StoredSession is a persisted session row.
type StoredSession struct {
	Token    string
	Role     Role
	ExpiryMs int64
}

// Persistence keeps sessions across restarts. Memory stays the read path; a nil
// Persistence (no database) simply means sessions do not survive a restart.
type Persistence interface {
	SaveAdminSession(ctx context.Context, token string, role Role, expiryMs int64) error
	DeleteAdminSession(ctx context.Context, token string) error
	LoadAdminSessions(ctx context.Context, nowMs int64) ([]StoredSession, error)
}

type session struct {
	expiryMs int64
	role     Role
}

// Sessions is the in-memory session table with write-behind persistence.
type Sessions struct {
	mu    sync.Mutex
	m     map[string]session
	store Persistence
	now   func() time.Time
	// background runs persistence work off the request path. Tests replace it with a
	// synchronous call.
	background func(func())
	pending    sync.WaitGroup
}

// NewSessions returns an empty table. store and now may be nil.
func NewSessions(store Persistence, now func() time.Time) *Sessions {
	if now == nil {
		now = time.Now
	}
	return &Sessions{m: map[string]session{}, store: store, now: now, background: func(f func()) { go f() }}
}

// SetBackground replaces how persistence calls are scheduled (tests).
func (s *Sessions) SetBackground(f func(func())) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.background = f
}

func (s *Sessions) persist(f func()) {
	s.mu.Lock()
	background := s.background
	s.pending.Add(1)
	s.mu.Unlock()
	background(func() {
		defer s.pending.Done()
		f()
	})
}

// WaitForWrites drains owned session persistence after HTTP/stream handlers have
// stopped issuing work, before the application closes the shared database pool.
func (s *Sessions) WaitForWrites(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		s.pending.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// GenerateToken returns 32 CSPRNG bytes as unpadded base64url: 43 characters of
// [A-Za-z0-9_-], safe in a header, a query string and a URL path without encoding.
func GenerateToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("auth: cannot read random bytes: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// Mint creates a session and returns its token. Persistence is best effort and never
// delays or fails the login.
func (s *Sessions) Mint(role Role) string {
	token := GenerateToken()
	expiry := s.now().UnixMilli() + SessionTTL.Milliseconds()
	s.mu.Lock()
	s.m[token] = session{expiryMs: expiry, role: role}
	s.mu.Unlock()
	if s.store != nil {
		s.persist(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.store.SaveAdminSession(ctx, token, role, expiry); err != nil {
				log.Printf("[Admin] saveAdminSession(%s) failed: %v", role, err)
			}
		})
	}
	return token
}

// Role returns the role of token, or RoleNone if it is empty, unknown or expired. An
// expired or unknown token is dropped from memory and from the persisted table.
func (s *Sessions) Role(token string) Role {
	if token == "" {
		return RoleNone
	}
	s.mu.Lock()
	sess, ok := s.m[token]
	if !ok || s.now().UnixMilli() > sess.expiryMs {
		delete(s.m, token)
		s.mu.Unlock()
		// Only a token we knew has a persisted row worth deleting; rows for tokens that
		// expired while the process was down are purged by the janitor.
		if ok && s.store != nil {
			s.persist(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if err := s.store.DeleteAdminSession(ctx, token); err != nil {
					log.Printf("[Admin] deleteAdminSession failed: %v", err)
				}
			})
		}
		return RoleNone
	}
	s.mu.Unlock()
	return sess.role
}

// Restore loads unexpired sessions from the database (boot only).
func (s *Sessions) Restore(ctx context.Context) (int, error) {
	if s.store == nil {
		return 0, nil
	}
	rows, err := s.store.LoadAdminSessions(ctx, s.now().UnixMilli())
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range rows {
		s.m[r.Token] = session{expiryMs: r.ExpiryMs, role: r.Role}
	}
	return len(rows), nil
}

// RoleOf reads the x-admin-token header of r.
func (s *Sessions) RoleOf(r *http.Request) Role { return s.Role(httpx.AdminToken(r)) }

// RequireAdmin lets any valid session through; others get 403 (never 401: a 401 in this
// API means the broker has no market-data session).
func (s *Sessions) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.RoleOf(r) == RoleNone {
			httpx.Error(w, http.StatusForbidden, "Admin authentication required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireFull lets only the full admin role through.
func (s *Sessions) RequireFull(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.RoleOf(r) != RoleFull {
			httpx.Error(w, http.StatusForbidden, "Full admin access required.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// PasscodeResult is the outcome of CheckPasscode.
type PasscodeResult int

const (
	PasscodeOK PasscodeResult = iota
	PasscodeForbidden
	PasscodeNotConfigured
)

// CheckPasscode compares a supplied secret with the configured one in constant time. The
// configured value is trimmed, the supplied one is not. An unset secret fails closed, as
// does a missing or empty supplied value (provided is false for "not supplied").
func CheckPasscode(configured, provided string, supplied bool) PasscodeResult {
	secret := strings.TrimSpace(configured)
	if secret == "" {
		return PasscodeNotConfigured
	}
	if !supplied || provided == "" {
		return PasscodeForbidden
	}
	a, b := sha256.Sum256([]byte(secret)), sha256.Sum256([]byte(provided))
	if subtle.ConstantTimeCompare(a[:], b[:]) == 1 {
		return PasscodeOK
	}
	return PasscodeForbidden
}

// ReadPasscode is tokenRouteAuth.ts readPasscode over a Node request: the header when it
// is present (even if empty: an empty header does not fall back to the query), else a
// single query value. A repeated header arrives joined with ", ", because Node's HTTP
// parser joins repeated custom headers into one string (probed on Node 22); a repeated
// query parameter is an array in Express and counts as not supplied.
func ReadPasscode(r *http.Request, header, query string) (value string, supplied bool) {
	if vals := r.Header.Values(header); len(vals) > 0 {
		return strings.Join(vals, ", "), true
	}
	if q := r.URL.Query()[query]; len(q) == 1 {
		return q[0], true
	}
	return "", false
}
