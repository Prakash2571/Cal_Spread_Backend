// Package marketdata serves the browser market-data endpoints: quote snapshots, the tick
// SSE stream, and the session store that lets a large board's token list travel in a
// POST body instead of a URL.
package marketdata

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
)

const (
	// DefaultSessionTTL is how long an idle session (no open stream) survives.
	DefaultSessionTTL = 5 * time.Minute
	// MaxSessions caps the store; it is reachable by unauthenticated callers.
	MaxSessions = 500
	// MaxSessionTokens is the largest token list accepted in one request.
	MaxSessionTokens = 4000
)

// Session is one stored token list, bound to the broker and generation it was created for.
type Session struct {
	ID          string
	Tokens      []int64
	Broker      brokers.ID
	Generation  int
	CreatedAt   int64 // epoch ms
	LastUsedAt  int64
	Connections int
}

// Rejection says why a session could not be used.
type Rejection string

const (
	// RejectNone means the session is usable.
	RejectNone Rejection = ""
	// RejectNotFound: unknown or reaped; the client should mint a new session.
	RejectNotFound Rejection = "not_found"
	// RejectStale: created under another broker or generation; the token namespace is gone.
	RejectStale Rejection = "stale_generation"
)

// SessionStore keeps market-data sessions (marketDataSession.ts). Safe for concurrent use.
type SessionStore struct {
	mu          sync.Mutex
	sessions    map[string]*Session
	order       []string // creation order, which breaks eviction ties like Map insertion order
	ttlMs       int64
	maxSessions int
	now         func() time.Time
}

// SessionStoreOptions override the defaults (tests).
type SessionStoreOptions struct {
	TTL         time.Duration
	MaxSessions int
	Now         func() time.Time
}

// NewSessionStore returns an empty store.
func NewSessionStore(o SessionStoreOptions) *SessionStore {
	s := &SessionStore{sessions: map[string]*Session{}, ttlMs: DefaultSessionTTL.Milliseconds(), maxSessions: MaxSessions, now: time.Now}
	if o.TTL > 0 {
		s.ttlMs = o.TTL.Milliseconds()
	}
	if o.MaxSessions > 0 {
		s.maxSessions = o.MaxSessions
	}
	if o.Now != nil {
		s.now = o.Now
	}
	return s
}

func (s *SessionStore) nowMs() int64 { return s.now().UnixMilli() }

// Create stores a new session (tokens de-duplicated, order kept) and returns a copy.
func (s *SessionStore) Create(tokens []int64, broker brokers.ID, generation int) Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	s.evictIfFullLocked()
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic("marketdata: cannot read random bytes: " + err.Error())
	}
	seen := make(map[int64]struct{}, len(tokens))
	unique := make([]int64, 0, len(tokens))
	for _, t := range tokens {
		if _, dup := seen[t]; !dup {
			seen[t] = struct{}{}
			unique = append(unique, t)
		}
	}
	at := s.nowMs()
	sess := &Session{ID: hex.EncodeToString(raw[:]), Tokens: unique, Broker: broker, Generation: generation, CreatedAt: at, LastUsedAt: at}
	s.sessions[sess.ID] = sess
	s.order = append(s.order, sess.ID)
	return *sess
}

// Resolve returns the session if it exists and matches the active broker and generation. A
// session from another broker or generation is deleted and reported stale; it is returned
// so the caller can log what it held.
func (s *SessionStore) Resolve(id string, broker brokers.ID, generation int) (Session, Rejection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	sess := s.sessions[id]
	if sess == nil {
		return Session{}, RejectNotFound
	}
	if sess.Broker != broker || sess.Generation != generation {
		s.deleteLocked(id)
		return *sess, RejectStale
	}
	sess.LastUsedAt = s.nowMs()
	return *sess, RejectNone
}

// Open records a stream attached to the session.
func (s *SessionStore) Open(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess := s.sessions[id]; sess != nil {
		sess.Connections++
		sess.LastUsedAt = s.nowMs()
	}
}

// Close records a stream detached from the session.
func (s *SessionStore) Close(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess := s.sessions[id]; sess != nil {
		if sess.Connections > 0 {
			sess.Connections--
		}
		sess.LastUsedAt = s.nowMs()
	}
}

// Sweep removes idle sessions (no stream, unused for longer than the TTL) and returns how many.
func (s *SessionStore) Sweep() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sweepLocked()
}

func (s *SessionStore) sweepLocked() int {
	cutoff := s.nowMs() - s.ttlMs
	removed := 0
	for _, id := range append([]string(nil), s.order...) {
		if sess := s.sessions[id]; sess != nil && sess.Connections == 0 && sess.LastUsedAt < cutoff {
			s.deleteLocked(id)
			removed++
		}
	}
	return removed
}

func (s *SessionStore) deleteLocked(id string) {
	delete(s.sessions, id)
	for i, v := range s.order {
		if v == id {
			s.order = append(s.order[:i:i], s.order[i+1:]...)
			break
		}
	}
}

// DropAll removes every session (a broker switch) and returns how many there were.
func (s *SessionStore) DropAll() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(s.sessions)
	s.sessions = map[string]*Session{}
	s.order = nil
	return n
}

// evictIfFullLocked drops the least recently used session that has no stream. When every
// session has a live stream nothing is evicted and the cap can be exceeded.
func (s *SessionStore) evictIfFullLocked() {
	if len(s.sessions) < s.maxSessions {
		return
	}
	var oldest *Session
	for _, id := range s.order {
		sess := s.sessions[id]
		if sess == nil || sess.Connections > 0 {
			continue
		}
		if oldest == nil || sess.LastUsedAt < oldest.LastUsedAt {
			oldest = sess
		}
	}
	if oldest != nil {
		s.deleteLocked(oldest.ID)
	}
}

// SessionStats is the summary in the feed-status response.
type SessionStats struct {
	Sessions    int `json:"sessions"`
	Connections int `json:"connections"`
	Tokens      int `json:"tokens"`
}

// Stats totals sessions, open streams and stored tokens.
func (s *SessionStore) Stats() SessionStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := SessionStats{Sessions: len(s.sessions)}
	for _, sess := range s.sessions {
		st.Connections += sess.Connections
		st.Tokens += len(sess.Tokens)
	}
	return st
}

// Size is the number of stored sessions.
func (s *SessionStore) Size() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.sessions) }

// ParseTokenList validates a `tokens` value decoded from JSON. It must be a non-empty
// array of at most limit positive integers; numeric strings are rejected, not coerced.
// The result is de-duplicated in first-seen order. limit <= 0 means MaxSessionTokens.
func ParseTokenList(input any, limit int) (tokens []int64, errMsg string) {
	if limit <= 0 {
		limit = MaxSessionTokens
	}
	arr, ok := input.([]any)
	if !ok {
		return nil, `Provide a JSON body of the form { "tokens": [123, 456] }.`
	}
	if len(arr) == 0 {
		return nil, "`tokens` must contain at least one instrument token."
	}
	if len(arr) > limit {
		return nil, fmt.Sprintf("Too many tokens: %d requested, limit is %d.", len(arr), limit)
	}
	seen := make(map[int64]struct{}, len(arr))
	out := make([]int64, 0, len(arr))
	for _, raw := range arr {
		f, isNum := raw.(float64)
		if !isNum || f != f || f > 9007199254740991 || f != float64(int64(f)) || f <= 0 {
			return nil, "`tokens` must contain positive integers only."
		}
		t := int64(f)
		if _, dup := seen[t]; !dup {
			seen[t] = struct{}{}
			out = append(out, t)
		}
	}
	return out, ""
}
