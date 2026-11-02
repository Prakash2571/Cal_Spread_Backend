package core

import (
	"context"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// KiteSessionRecord is the persisted Zerodha session (db.ts IKiteSession, table
// kite_session, single row id 'current').
type KiteSessionRecord struct {
	AccessToken string
	UserID      string
	UserName    string
	LoginDate   string // IST day the token was generated on, YYYY-MM-DD
	UpdatedAt   time.Time
}

// KiteSessionStore persists the Kite access token across restarts (db.ts
// saveKiteSession / loadKiteSession / clearKiteSession). Every method is a no-op without
// a database: Save and Clear return nil, Load returns nil, nil.
type KiteSessionStore interface {
	SaveKiteSession(ctx context.Context, rec KiteSessionRecord) error
	LoadKiteSession(ctx context.Context) (*KiteSessionRecord, error)
	ClearKiteSession(ctx context.Context) error
}

// PGKiteSessions is the PostgreSQL KiteSessionStore over the kite_session table
// (0001_core.sql). A nil Pool means no database.
type PGKiteSessions struct {
	Pool *db.Pool
	// Now stamps updated_at; nil means time.Now.
	Now func() time.Time
}

const kiteSessionID = "current"

func (s *PGKiteSessions) enabled() bool { return s != nil && s.Pool.Enabled() }

// SaveKiteSession upserts the row (updateOne({_id:"current"}, {$set: {...}}, {upsert})).
func (s *PGKiteSessions) SaveKiteSession(ctx context.Context, rec KiteSessionRecord) error {
	if !s.enabled() {
		return nil
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	_, err := s.Pool.Exec(ctx, `
		insert into kite_session (id, access_token, user_id, user_name, login_date, updated_at)
		values ($1, $2, $3, $4, $5, $6)
		on conflict (id) do update set
			access_token = excluded.access_token, user_id = excluded.user_id,
			user_name = excluded.user_name, login_date = excluded.login_date,
			updated_at = excluded.updated_at`,
		kiteSessionID, rec.AccessToken, rec.UserID, rec.UserName, rec.LoginDate, jsx.TruncMs(now()))
	return err
}

// LoadKiteSession is findById("current"): nil, nil when there is no row.
func (s *PGKiteSessions) LoadKiteSession(ctx context.Context) (*KiteSessionRecord, error) {
	if !s.enabled() {
		return nil, nil
	}
	var r KiteSessionRecord
	err := s.Pool.QueryRow(ctx, `
		select access_token, user_id, user_name, login_date, updated_at
		from kite_session where id = $1`, kiteSessionID).
		Scan(&r.AccessToken, &r.UserID, &r.UserName, &r.LoginDate, &r.UpdatedAt)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.UpdatedAt = r.UpdatedAt.UTC()
	return &r, nil
}

// ClearKiteSession deletes the row (deleteOne({_id:"current"})).
func (s *PGKiteSessions) ClearKiteSession(ctx context.Context) error {
	if !s.enabled() {
		return nil
	}
	_, err := s.Pool.Exec(ctx, `delete from kite_session where id = $1`, kiteSessionID)
	return err
}

// persistKiteSession is index.ts persistKiteSession: store the token with today's IST
// day, in the background (a failure is logged, never reported to the client).
func (c *Core) persistKiteSession(accessToken, userID, userName string) {
	rec := KiteSessionRecord{
		AccessToken: accessToken, UserID: userID, UserName: userName, LoginDate: jsx.IstDayKey(c.now()),
	}
	c.background(func(ctx context.Context) {
		if err := c.kiteStore.SaveKiteSession(ctx, rec); err != nil {
			c.logf("[Session] persist failed: %v", err)
		}
	})
}

// ClearKiteSession forgets the Kite session in memory and, in the background, the
// persisted copy (kite.clearSession() + clearKiteSession()). It is what logout, a Kite
// 401/403 (SendError) and a feed rejecting the token do. OnKiteSessionCleared runs
// afterwards.
func (c *Core) ClearKiteSession() {
	c.kite.ClearSession()
	c.background(func(ctx context.Context) {
		if err := c.kiteStore.ClearKiteSession(ctx); err != nil {
			c.logf("[Session] clearKiteSession failed: %v", err)
		}
	})
	if c.d.OnKiteSessionCleared != nil {
		c.d.OnKiteSessionCleared()
	}
}

// RestoreKiteSession is restoreSessionOnStartup: restore the persisted Zerodha token,
// but only when it was created on the current IST day (Kite tokens expire daily); a
// stale row is deleted. Failures are logged. Call it at boot, after the database is up
// and before the schedulers start.
func (c *Core) RestoreKiteSession(ctx context.Context) {
	saved, err := c.kiteStore.LoadKiteSession(ctx)
	if err != nil {
		c.logf("[Session] restore failed: %v", err)
		return
	}
	if saved == nil {
		c.logf("[Session] No persisted Zerodha session found.")
		return
	}
	if saved.LoginDate != jsx.IstDayKey(c.now()) {
		c.logf("[Session] Persisted token is from %s (stale) — daily Zerodha login required.", saved.LoginDate)
		if err := c.kiteStore.ClearKiteSession(ctx); err != nil {
			c.logf("[Session] restore failed: %v", err)
		}
		return
	}
	c.kite.SetAccessToken(saved.AccessToken)
	c.logf("[Session] Restored today's Zerodha session for %s (%s) — no re-login needed.", saved.UserName, saved.UserID)
}
