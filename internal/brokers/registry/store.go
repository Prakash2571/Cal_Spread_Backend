package registry

import (
	"context"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// DhanSessionRecord is the persisted Dhan session (db.ts IDhanSession, table
// dhan_session, single row id 'current').
type DhanSessionRecord struct {
	AccessToken          string
	DhanClientID         string
	DhanClientName       string
	DhanClientUcc        string
	GivenPowerOfAttorney bool
	// ExpiryTime is epoch ms, nil when Dhan did not state one (unknown, not "never").
	ExpiryTime *int64
	LoginAt    time.Time
	LoginDate  string // IST YYYY-MM-DD
	UpdatedAt  time.Time
}

// ActiveBrokerRecord is the persisted broker selection (table active_broker).
type ActiveBrokerRecord struct {
	Broker     string
	Generation int64
}

// Store persists the broker selection and the Dhan session. Every method of a disabled
// store (no database) is a no-op returning nothing, which is how the Node code behaved
// without MongoDB: the selection and the session live in memory only.
type Store interface {
	// SaveDhanSession upserts the session; login_at and updated_at become now.
	SaveDhanSession(ctx context.Context, rec DhanSessionRecord) error
	// LoadDhanSession returns the stored session, nil when there is none.
	LoadDhanSession(ctx context.Context) (*DhanSessionRecord, error)
	// ClearDhanSession deletes the stored session.
	ClearDhanSession(ctx context.Context) error
	// SaveActiveBroker stores the selection and advances the durable generation in one
	// statement; ok is false when nothing could be stored (no database).
	SaveActiveBroker(ctx context.Context, broker, selectedBy string) (generation int64, ok bool, err error)
	// LoadActiveBroker returns the stored selection (generation 1 when the row predates
	// the counter), nil when there is none.
	LoadActiveBroker(ctx context.Context) (*ActiveBrokerRecord, error)
}

// PGStore is Store on PostgreSQL (tables from 0001_core.sql). A nil or disabled pool
// makes it a no-op store.
type PGStore struct {
	Pool *db.Pool
	// Now stamps login_at / updated_at / selected_at; nil means time.Now.
	Now func() time.Time
}

func (s *PGStore) enabled() bool { return s != nil && s.Pool.Enabled() }

func (s *PGStore) now() time.Time {
	if s.Now != nil {
		return jsx.TruncMs(s.Now())
	}
	return jsx.TruncMs(time.Now())
}

// SaveDhanSession implements Store (db.ts saveDhanSession: $set {...data, login_at,
// updated_at} with upsert).
func (s *PGStore) SaveDhanSession(ctx context.Context, rec DhanSessionRecord) error {
	if !s.enabled() {
		return nil
	}
	now := s.now()
	_, err := s.Pool.Exec(ctx, `
		insert into dhan_session (id, access_token, dhan_client_id, dhan_client_name, dhan_client_ucc,
			given_power_of_attorney, expiry_time, login_at, login_date, updated_at)
		values ('current', $1, $2, $3, $4, $5, $6, $7, $8, $7)
		on conflict (id) do update set
			access_token = excluded.access_token,
			dhan_client_id = excluded.dhan_client_id,
			dhan_client_name = excluded.dhan_client_name,
			dhan_client_ucc = excluded.dhan_client_ucc,
			given_power_of_attorney = excluded.given_power_of_attorney,
			expiry_time = excluded.expiry_time,
			login_at = excluded.login_at,
			login_date = excluded.login_date,
			updated_at = excluded.updated_at`,
		rec.AccessToken, rec.DhanClientID, rec.DhanClientName, rec.DhanClientUcc,
		rec.GivenPowerOfAttorney, rec.ExpiryTime, now, rec.LoginDate)
	return err
}

// LoadDhanSession implements Store.
func (s *PGStore) LoadDhanSession(ctx context.Context) (*DhanSessionRecord, error) {
	if !s.enabled() {
		return nil, nil
	}
	var rec DhanSessionRecord
	err := s.Pool.QueryRow(ctx, `
		select access_token, dhan_client_id, dhan_client_name, dhan_client_ucc,
			given_power_of_attorney, expiry_time, login_at, login_date, updated_at
		from dhan_session where id = 'current'`).Scan(
		&rec.AccessToken, &rec.DhanClientID, &rec.DhanClientName, &rec.DhanClientUcc,
		&rec.GivenPowerOfAttorney, &rec.ExpiryTime, &rec.LoginAt, &rec.LoginDate, &rec.UpdatedAt)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rec.LoginAt = jsx.TruncMs(rec.LoginAt).UTC()
	rec.UpdatedAt = jsx.TruncMs(rec.UpdatedAt).UTC()
	return &rec, nil
}

// ClearDhanSession implements Store.
func (s *PGStore) ClearDhanSession(ctx context.Context) error {
	if !s.enabled() {
		return nil
	}
	_, err := s.Pool.Exec(ctx, `delete from dhan_session where id = 'current'`)
	return err
}

// SaveActiveBroker implements Store (db.ts saveActiveBroker: $set + $inc {generation: 1}
// with upsert, returning the new document). A first insert stores generation 1, and a
// row whose generation is NULL (written before the counter existed) also becomes 1, as
// $inc on a missing field does.
func (s *PGStore) SaveActiveBroker(ctx context.Context, broker, selectedBy string) (int64, bool, error) {
	if !s.enabled() {
		return 0, false, nil
	}
	var gen *int64
	err := s.Pool.QueryRow(ctx, `
		insert into active_broker (id, broker, selected_at, selected_by, generation)
		values ('current', $1, $2, $3, 1)
		on conflict (id) do update set
			broker = excluded.broker,
			selected_by = excluded.selected_by,
			selected_at = excluded.selected_at,
			generation = coalesce(active_broker.generation, 0) + 1
		returning generation`, broker, s.now(), selectedBy).Scan(&gen)
	if err != nil {
		return 0, false, err
	}
	if gen == nil {
		return 0, false, nil
	}
	return *gen, true, nil
}

// LoadActiveBroker implements Store (db.ts loadActiveBroker: nothing without a broker;
// a missing generation reads as 1).
func (s *PGStore) LoadActiveBroker(ctx context.Context) (*ActiveBrokerRecord, error) {
	if !s.enabled() {
		return nil, nil
	}
	var broker string
	var gen *int64
	err := s.Pool.QueryRow(ctx, `select broker, generation from active_broker where id = 'current'`).Scan(&broker, &gen)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if broker == "" {
		return nil, nil
	}
	rec := &ActiveBrokerRecord{Broker: broker, Generation: 1}
	if gen != nil {
		rec.Generation = *gen
	}
	return rec, nil
}

// memoryStore is the store of a registry without a database.
type memoryStore struct{}

func (memoryStore) SaveDhanSession(context.Context, DhanSessionRecord) error { return nil }
func (memoryStore) LoadDhanSession(context.Context) (*DhanSessionRecord, error) {
	return nil, nil
}
func (memoryStore) ClearDhanSession(context.Context) error { return nil }
func (memoryStore) SaveActiveBroker(context.Context, string, string) (int64, bool, error) {
	return 0, false, nil
}
func (memoryStore) LoadActiveBroker(context.Context) (*ActiveBrokerRecord, error) { return nil, nil }
