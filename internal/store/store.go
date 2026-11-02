// Package store holds the small persistence helpers for single-row and key-value style
// data (admin sessions, app settings). Larger features keep their own repositories next
// to the feature code.
package store

import (
	"context"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
)

// Store is the shared persistence handle. With a nil pool every operation is a no-op that
// reports "nothing stored", the same as the Node code when no database was configured.
type Store struct {
	pool *db.Pool
	now  func() time.Time
}

// New returns a Store over pool (nil allowed). now may be nil.
func New(pool *db.Pool, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{pool: pool, now: now}
}

// Enabled reports whether a database is available (isDbEnabled).
func (s *Store) Enabled() bool { return s != nil && s.pool.Enabled() }

// --- admin sessions (auth.Persistence) ---

// SaveAdminSession upserts a session row.
func (s *Store) SaveAdminSession(ctx context.Context, token string, role auth.Role, expiryMs int64) error {
	if !s.Enabled() {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		insert into admin_sessions (id, role, expiry) values ($1, $2, $3)
		on conflict (id) do update set role = excluded.role, expiry = excluded.expiry`,
		token, string(role), expiryMs)
	return err
}

// DeleteAdminSession removes a session row.
func (s *Store) DeleteAdminSession(ctx context.Context, token string) error {
	if !s.Enabled() {
		return nil
	}
	_, err := s.pool.Exec(ctx, `delete from admin_sessions where id = $1`, token)
	return err
}

// LoadAdminSessions returns sessions that expire after nowMs.
func (s *Store) LoadAdminSessions(ctx context.Context, nowMs int64) ([]auth.StoredSession, error) {
	if !s.Enabled() {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `select id, role, expiry from admin_sessions where expiry > $1`, nowMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []auth.StoredSession
	for rows.Next() {
		var t, role string
		var exp int64
		if err := rows.Scan(&t, &role, &exp); err != nil {
			return nil, err
		}
		out = append(out, auth.StoredSession{Token: t, Role: auth.Role(role), ExpiryMs: exp})
	}
	return out, rows.Err()
}

// PurgeExpiredAdminSessions deletes sessions that have expired. Node never did this (rows
// piled up until the token was replayed); it changes nothing a client can see.
func (s *Store) PurgeExpiredAdminSessions(ctx context.Context) (int64, error) {
	if !s.Enabled() {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx, `delete from admin_sessions where expiry <= $1`, s.now().UnixMilli())
	return tag.RowsAffected(), err
}

// --- app settings ---

const rfRateID = "rf_rate"

// SaveRfRate stores the risk-free rate (percent).
func (s *Store) SaveRfRate(ctx context.Context, value float64) error {
	if !s.Enabled() {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		insert into app_settings (id, value, updated_at) values ($1, $2, $3)
		on conflict (id) do update set value = excluded.value, updated_at = excluded.updated_at`,
		rfRateID, value, s.now())
	return err
}

// LoadRfRate returns the stored risk-free rate; ok is false when none is stored.
func (s *Store) LoadRfRate(ctx context.Context) (value float64, ok bool, err error) {
	if !s.Enabled() {
		return 0, false, nil
	}
	err = s.pool.QueryRow(ctx, `select value from app_settings where id = $1`, rfRateID).Scan(&value)
	if db.NoRows(err) {
		return 0, false, nil
	}
	return value, err == nil, err
}
