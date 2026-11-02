package fairvalue

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

// Store is store.ts FairValueStore: configuration and bounded history persistence.
type Store interface {
	// Enabled reports whether persistence is available ("postgres" vs "memory_only").
	Enabled() bool
	// LoadConfig returns the saved configuration as its JSON value, or nil when none is
	// saved (row.config ?? null).
	LoadConfig(ctx context.Context) (any, error)
	SaveConfig(ctx context.Context, config model.Config, version string) error
	// Append stores a published snapshot once (idempotent by id) with its input (minus
	// the listing catalog), then prunes the underlying's history beyond limit.
	Append(ctx context.Context, snapshot *model.SurfaceSnapshot, input *model.InputSnapshot, limit, retentionDays float64) error
	History(ctx context.Context, underlying string, limit float64) ([]model.HistorySummary, error)
	// Snapshot returns a stored snapshot, or nil.
	Snapshot(ctx context.Context, underlying, id string) (*StoredSnapshot, error)
}

// StoredSnapshot is a snapshot read back from the store: its JSON exactly as written
// plus the publication time the engine filters on.
type StoredSnapshot struct {
	PublishedAt string
	JSON        []byte
}

// AppendJS writes the stored JSON.
func (s *StoredSnapshot) AppendJS(dst []byte) []byte { return append(dst, s.JSON...) }

// errMemoryOnly is saveConfig's error without a database (the Node text named MongoDB).
var errMemoryOnly = errors.New("Fair Value configuration is memory-only: PostgreSQL is not available.")

// storeTimeout is Mongo's maxTimeMS(3000) on every store operation.
const storeTimeout = 3 * time.Second

// PGStore is the PostgreSQL store. A nil or disabled pool is memory-only, like the Node
// store without a Mongo connection.
type PGStore struct {
	Pool *db.Pool
	// Now is the clock for the retention filter and the expiry delete (nil: time.Now).
	// Node filtered reads with the application clock (new Date()).
	Now func() time.Time
}

// Enabled reports whether the pool is configured.
func (s *PGStore) Enabled() bool { return s != nil && s.Pool.Enabled() }

func (s *PGStore) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func opContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, storeTimeout)
}

// LoadConfig is MongoFairValueStore.loadConfig.
func (s *PGStore) LoadConfig(ctx context.Context) (any, error) {
	if !s.Enabled() {
		return nil, nil
	}
	ctx, cancel := opContext(ctx)
	defer cancel()
	var text string
	err := s.Pool.QueryRow(ctx, `select config::text from fair_value_settings where id = 'current'`).Scan(&text)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return jsjson.Parse([]byte(text))
}

// SaveConfig is MongoFairValueStore.saveConfig (upsert of the 'current' row).
func (s *PGStore) SaveConfig(ctx context.Context, config model.Config, version string) error {
	if !s.Enabled() {
		return errMemoryOnly
	}
	ctx, cancel := opContext(ctx)
	defer cancel()
	_, err := s.Pool.Exec(ctx, `insert into fair_value_settings (id, version, config, updated_at)
		values ('current', $1, $2::json, now())
		on conflict (id) do update set version = excluded.version, config = excluded.config, updated_at = excluded.updated_at`,
		version, string(jsjson.Marshal(config)))
	return err
}

// Append is MongoFairValueStore.append.
func (s *PGStore) Append(ctx context.Context, snapshot *model.SurfaceSnapshot, input *model.InputSnapshot, limit, retentionDays float64) error {
	if !s.Enabled() {
		return nil
	}
	at := model.DateParse(snapshot.PublishedAt)
	if !isFinite(at) {
		return errors.New("Cast to date failed for value \"" + snapshot.PublishedAt + "\" (type string) at path \"at\"")
	}
	expires := at + retentionDays*86400000
	calibrationInput := input.WithoutListingCatalog()
	summary := snapshot.Summary()
	ctx, cancel := opContext(ctx)
	defer cancel()
	if _, err := s.Pool.Exec(ctx, `insert into fair_value_snapshots
		(id, underlying, input_snapshot_id, model_version, config_version, at, expires_at, snapshot, input, summary)
		values ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json, $10::json)
		on conflict (id) do nothing`,
		snapshot.ID, snapshot.Underlying, input.ID, snapshot.ModelVersion, snapshot.ConfigVersion,
		msTime(at), msTime(expires), string(jsjson.Marshal(snapshot)), string(jsjson.Marshal(&calibrationInput)),
		string(jsjson.Marshal(summary))); err != nil {
		return err
	}
	// Only this module's bounded analytics history is pruned. The age bound (Mongo's TTL
	// index) is enforced here too, for every underlying.
	skip := int64(math.Max(0, math.Floor(limit)))
	if _, err := s.Pool.Exec(ctx, `delete from fair_value_snapshots where id in (
		select id from fair_value_snapshots where underlying = $1 order by at desc, id desc offset $2 limit 500)`,
		snapshot.Underlying, skip); err != nil {
		return err
	}
	_, err := s.Pool.Exec(ctx, `delete from fair_value_snapshots where expires_at <= $1`, s.now())
	return err
}

// History is MongoFairValueStore.history (summaries only, newest first).
func (s *PGStore) History(ctx context.Context, underlying string, limit float64) ([]model.HistorySummary, error) {
	if !s.Enabled() {
		return []model.HistorySummary{}, nil
	}
	ctx, cancel := opContext(ctx)
	defer cancel()
	n := int64(math.Max(0, math.Floor(limit)))
	rows, err := s.Pool.Query(ctx, `select summary::text from fair_value_snapshots
		where underlying = $1 and expires_at > $2 order by at desc, id desc limit $3`, underlying, s.now(), n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.HistorySummary{}
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			return nil, err
		}
		v, err := jsjson.Parse([]byte(text))
		if err != nil {
			return nil, err
		}
		out = append(out, decodeSummary(v))
	}
	return out, rows.Err()
}

// Snapshot is MongoFairValueStore.snapshot.
func (s *PGStore) Snapshot(ctx context.Context, underlying, id string) (*StoredSnapshot, error) {
	if !s.Enabled() {
		return nil, nil
	}
	ctx, cancel := opContext(ctx)
	defer cancel()
	var text, publishedAt string
	err := s.Pool.QueryRow(ctx, `select snapshot::text, coalesce(snapshot->>'published_at', '') from fair_value_snapshots
		where id = $1 and underlying = $2 and expires_at > $3`, id, underlying, s.now()).Scan(&text, &publishedAt)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &StoredSnapshot{PublishedAt: publishedAt, JSON: []byte(text)}, nil
}

func msTime(ms float64) time.Time { return time.UnixMilli(int64(ms)).UTC() }

func isFinite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// decodeSummary reads a stored history summary.
func decodeSummary(v any) model.HistorySummary {
	o := v.(*jsjson.Object)
	str := func(o *jsjson.Object, k string) string { x, _ := o.Get(k); s, _ := x.(string); return s }
	num := func(o *jsjson.Object, k string) float64 { x, _ := o.Get(k); f, _ := x.(float64); return f }
	s := model.HistorySummary{ID: str(o, "id"), InputSnapshotID: str(o, "input_snapshot_id"), ModelVersion: str(o, "model_version"),
		ConfigVersion: str(o, "config_version"), Sequence: num(o, "sequence"), Underlying: str(o, "underlying"), Broker: str(o, "broker"),
		ValuationTime: str(o, "valuation_time"), PublishedAt: str(o, "published_at"), Slices: []model.SliceSummary{}}
	slices, _ := o.Get("slices")
	list, _ := slices.([]any)
	for _, e := range list {
		so, ok := e.(*jsjson.Object)
		if !ok {
			continue
		}
		slice := model.SliceSummary{Expiry: str(so, "expiry"), Quality: str(so, "quality"), Method: str(so, "method"), Observations: num(so, "observations")}
		if x, _ := so.Get("expiry_timestamp"); x != nil {
			if ts, ok := x.(string); ok {
				slice.ExpiryTimestamp = &ts
			}
		}
		if x, _ := so.Get("atm_iv"); x != nil {
			if f, ok := x.(float64); ok {
				slice.AtmIv = &f
			}
		}
		s.Slices = append(s.Slices, slice)
	}
	return s
}
