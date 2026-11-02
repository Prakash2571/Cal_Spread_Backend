package synthetic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// OpenUniqueIndex is the index the one-open-position-per-underlying guarantee rests on.
const OpenUniqueIndex = "synth_open_one_per_underlying"

// errNoStorage is returned by every Repository call when no database is configured.
var errNoStorage = errors.New("paper-trade storage is not connected (set DATABASE_URL)")

// Repository is the PostgreSQL Store (src/synthetic/repository.ts). Its writes are
// atomic: an entry is an insert the partial unique index rejects while the underlying
// has an open position; an exit is one UPDATE guarded on status 'open'; a delete is a
// soft delete guarded on the status the caller saw; margin is written only by
// SetMargin, so a close never overwrites a margin figure that landed meanwhile.
//
// A Repository on a nil pool reports Enabled() == false, which is how the Node code
// behaved without a MongoDB connection.
type Repository struct {
	pool  *db.Pool
	newID func() string
}

// NewRepository returns the store on pool (nil = no database).
func NewRepository(pool *db.Pool) *Repository { return &Repository{pool: pool, newID: db.NewID} }

// Enabled reports whether a database pool is configured.
func (r *Repository) Enabled() bool { return r != nil && r.pool.Enabled() }

// NewID allocates an ObjectId-style id.
func (r *Repository) NewID() string { return r.newID() }

// indexDescription is what EnsureReady reads back about the unique index.
type indexDescription struct {
	Unique    bool
	Valid     bool
	Keys      []string // key column names; "" for an expression
	Predicate string   // pg_get_expr of the partial-index predicate, "" when none
}

// indexValidationError says why the unique index cannot be trusted, or "" when it can
// (synthIndexValidationError). Pure, for tests.
func indexValidationError(d *indexDescription) string {
	if d == nil {
		return "missing " + OpenUniqueIndex + " index"
	}
	if !d.Unique {
		return OpenUniqueIndex + " is not unique"
	}
	if len(d.Keys) != 1 || d.Keys[0] != "underlying" {
		return OpenUniqueIndex + " has incompatible keys"
	}
	pred := strings.Join(strings.Fields(d.Predicate), " ")
	if pred != "(status = 'open'::text)" {
		return OpenUniqueIndex + " has an incompatible partial filter"
	}
	if !d.Valid {
		return OpenUniqueIndex + " is not valid"
	}
	return ""
}

// EnsureReady creates the indexes when missing and reads the unique one back. It fails
// (and the engine keeps paper entries off) when the index cannot be built, typically
// because two open rows for one underlying exist, or when an incompatible index of the
// same name is in the way. Nothing is dropped or rebuilt silently.
func (r *Repository) EnsureReady(ctx context.Context) error {
	if !r.Enabled() {
		return errNoStorage
	}
	_, err := r.pool.Exec(ctx, `
		create unique index if not exists synth_open_one_per_underlying on synth_trades (underlying) where status = 'open';
		create index if not exists synth_status_closed_at on synth_trades (status, closed_at desc nulls last);
		create index if not exists synth_closed_day on synth_trades (closed_day)`)
	if err != nil {
		return fmt.Errorf("failed to establish %s; duplicate open rows or an incompatible index may exist: %w",
			OpenUniqueIndex, err)
	}
	d, err := r.describeOpenIndex(ctx)
	if err != nil {
		return err
	}
	if problem := indexValidationError(d); problem != "" {
		return fmt.Errorf("synth_trades persistence is unsafe: %s", problem)
	}
	return nil
}

// describeOpenIndex reads the unique index on synth_trades in the current schema.
func (r *Repository) describeOpenIndex(ctx context.Context) (*indexDescription, error) {
	var d indexDescription
	var pred *string
	err := r.pool.QueryRow(ctx, `
		select i.indisunique, i.indisvalid,
		       array(select coalesce(a.attname::text, '')
		               from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
		               left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
		              where k.ord <= i.indnkeyatts
		              order by k.ord),
		       pg_get_expr(i.indpred, i.indrelid)
		  from pg_index i
		 where i.indexrelid = to_regclass($1)
		   and i.indrelid = to_regclass('synth_trades')`, OpenUniqueIndex).Scan(&d.Unique, &d.Valid, &d.Keys, &pred)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", OpenUniqueIndex, err)
	}
	if pred != nil {
		d.Predicate = *pred
	}
	return &d, nil
}

// tradeColumns are written by InsertOpen in this order; closeColumns (everything but
// the id and the margin fields) by Close.
var tradeColumns = []string{
	"id", "status", "key", "broker", "execution_mode", "order_type", "underlying", "name", "is_index",
	"expiry", "strike", "atm_strike", "atm_offset", "direction", "lot_size", "quantity", "opened_at",
	"opened_day", "legs", "entry_future_price", "entry_synthetic_price", "entry_lock_per_unit",
	"entry_carry_per_unit", "entry_edge", "entry_gross_edge", "entry_charges", "estimated_exit_charges",
	"entry_net_edge", "expected_net_profit", "min_expected_net_profit", "safety_buffer",
	"expected_slippage", "rf_pct", "option_rate_version", "futures_rate_version", "closed_at",
	"closed_day", "exit_reason", "gross_pnl", "exit_charges", "total_charges", "net_pnl", "exit_note",
	"margin", "margin_source", "margin_hedge_benefit", "margin_at", "margin_error",
}

var marginColumns = map[string]bool{
	"margin": true, "margin_source": true, "margin_hedge_benefit": true, "margin_at": true, "margin_error": true,
}

func msTime(ms *int64) *time.Time {
	if ms == nil {
		return nil
	}
	t := jsx.FromMs(*ms)
	return &t
}

func nullStr(s NullStr) *string {
	if s == "" {
		return nil
	}
	v := string(s)
	return &v
}

// tradeValues returns t's column values (tradeColumns order). Legs get the stored
// defaults Mongoose applied when a trade was created (every optional field null).
func tradeValues(t *Trade) ([]any, error) {
	legs := make([]TradeLeg, len(t.Legs))
	for i, l := range t.Legs {
		legs[i] = l.withStoredDefaults()
	}
	legsJSON, err := encodeJS(legs)
	if err != nil {
		return nil, fmt.Errorf("encode legs: %w", err)
	}
	opened := jsx.FromMs(t.OpenedAt)
	var broker *string
	if t.Broker != "" {
		broker = &t.Broker
	}
	return []any{
		t.ID, t.Status, t.Key, broker, t.ExecutionMode, t.OrderType, t.Underlying, t.Name, t.IsIndex,
		t.Expiry, t.Strike, t.AtmStrike, t.AtmOffset, string(t.Direction), t.LotSize, t.Quantity, opened,
		t.OpenedDay, string(legsJSON), t.EntryFuturePrice, t.EntrySyntheticPrice, t.EntryLockPerUnit,
		t.EntryCarryPerUnit, t.EntryEdge, t.EntryGrossEdge, t.EntryCharges, t.EstimatedExitCharges,
		t.EntryNetEdge, t.ExpectedNetProfit, t.MinExpectedNetProfit, t.SafetyBuffer,
		t.ExpectedSlippage, t.RfPct, t.OptionRateVersion, t.FuturesRateVersion, msTime(t.ClosedAt),
		t.ClosedDay, nullStr(t.ExitReason), t.GrossPnl, t.ExitCharges, t.TotalCharges, t.NetPnl, t.ExitNote,
		t.Margin, t.MarginSource, t.MarginHedgeBenefit, msTime(t.MarginAt), t.MarginError,
	}, nil
}

// InsertOpen stores a new open trade. Any unique violation (the partial index, or the
// id itself when a retried write lands twice) is "duplicate", as Mongo's E11000 was.
func (r *Repository) InsertOpen(ctx context.Context, t *Trade) (bool, error) {
	if !r.Enabled() {
		return false, errNoStorage
	}
	vals, err := tradeValues(t)
	if err != nil {
		return false, err
	}
	ph := make([]string, len(tradeColumns))
	for i, col := range tradeColumns {
		ph[i] = fmt.Sprintf("$%d", i+1)
		if col == "legs" {
			ph[i] += "::jsonb"
		}
	}
	_, err = r.pool.Exec(ctx, "insert into synth_trades ("+strings.Join(tradeColumns, ", ")+") values ("+
		strings.Join(ph, ", ")+")", vals...)
	if err != nil {
		if _, dup := db.UniqueViolation(err); dup {
			return true, nil
		}
		return false, err
	}
	return false, nil
}

// Close writes the closed trade over the open row. Margin is owned by SetMargin and
// never written here.
func (r *Repository) Close(ctx context.Context, t *Trade) (bool, error) {
	if !r.Enabled() {
		return false, errNoStorage
	}
	vals, err := tradeValues(t)
	if err != nil {
		return false, err
	}
	var sets []string
	args := []any{t.ID}
	for i, col := range tradeColumns {
		if col == "id" || marginColumns[col] {
			continue
		}
		args = append(args, vals[i])
		cast := ""
		if col == "legs" {
			cast = "::jsonb"
		}
		sets = append(sets, fmt.Sprintf("%s = $%d%s", col, len(args), cast))
	}
	tag, err := r.pool.Exec(ctx, "update synth_trades set "+strings.Join(sets, ", ")+
		" where id = $1 and status = 'open'", args...)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// SetMargin records the margin fields of an open or closed trade; a deleted row is an
// audit record and stays as it was. A malformed id is a no-op.
func (r *Repository) SetMargin(ctx context.Context, id string, p MarginPatch) error {
	if !r.Enabled() {
		return errNoStorage
	}
	kind, canon := db.CheckID(id)
	if kind != db.IDValid {
		return nil
	}
	_, err := r.pool.Exec(ctx, `update synth_trades
		set margin = $2, margin_source = $3, margin_hedge_benefit = $4, margin_at = $5, margin_error = $6
		where id = $1 and status <> 'deleted'`,
		canon, p.Margin, p.MarginSource, p.MarginHedgeBenefit, msTime(p.MarginAt), p.MarginError)
	return err
}

// MarkDeleted soft-deletes a trade whose status is still from. False when it no longer
// is (closed or deleted in between) or the id is malformed.
func (r *Repository) MarkDeleted(ctx context.Context, id, from string, audit DeleteAudit) (bool, error) {
	if !r.Enabled() {
		return false, errNoStorage
	}
	kind, canon := db.CheckID(id)
	if kind != db.IDValid {
		return false, nil
	}
	tag, err := r.pool.Exec(ctx, `update synth_trades
		set status = 'deleted', deleted_at = $3, deleted_from = $2, delete_reason = $4, deleted_by = $5
		where id = $1 and status = $2`,
		canon, from, jsx.FromMs(audit.At), audit.Reason, audit.Actor)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

const selectTrade = `select id, status, key, broker, execution_mode, order_type, underlying, name, is_index,
	expiry, strike, atm_strike, atm_offset, direction, lot_size, quantity, opened_at, opened_day, legs,
	entry_future_price, entry_synthetic_price, entry_lock_per_unit, entry_carry_per_unit, entry_edge,
	entry_gross_edge, entry_charges, estimated_exit_charges, entry_net_edge, expected_net_profit,
	min_expected_net_profit, safety_buffer, expected_slippage, rf_pct, option_rate_version,
	futures_rate_version, closed_at, closed_day, exit_reason, gross_pnl, exit_charges, total_charges,
	net_pnl, exit_note, margin, margin_source, margin_hedge_benefit, margin_at, margin_error, deleted_from
	from synth_trades`

// scanTrade reads one selectTrade row (fromRecord): status 'open' stays open, anything
// else reads as closed; order_type is always LIMIT.
func scanTrade(row pgx.Row) (*StoredTrade, error) {
	var t Trade
	var status, direction string
	var broker, exitReason, deletedFrom *string
	var legs []byte
	var opened time.Time
	var closedAt, marginAt *time.Time
	err := row.Scan(&t.ID, &status, &t.Key, &broker, &t.ExecutionMode, &t.OrderType, &t.Underlying, &t.Name,
		&t.IsIndex, &t.Expiry, &t.Strike, &t.AtmStrike, &t.AtmOffset, &direction, &t.LotSize, &t.Quantity,
		&opened, &t.OpenedDay, &legs, &t.EntryFuturePrice, &t.EntrySyntheticPrice, &t.EntryLockPerUnit,
		&t.EntryCarryPerUnit, &t.EntryEdge, &t.EntryGrossEdge, &t.EntryCharges, &t.EstimatedExitCharges,
		&t.EntryNetEdge, &t.ExpectedNetProfit, &t.MinExpectedNetProfit, &t.SafetyBuffer, &t.ExpectedSlippage,
		&t.RfPct, &t.OptionRateVersion, &t.FuturesRateVersion, &closedAt, &t.ClosedDay, &exitReason,
		&t.GrossPnl, &t.ExitCharges, &t.TotalCharges, &t.NetPnl, &t.ExitNote, &t.Margin, &t.MarginSource,
		&t.MarginHedgeBenefit, &marginAt, &t.MarginError, &deletedFrom)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(legs, &t.Legs); err != nil {
		return nil, fmt.Errorf("synth_trades %s: decode legs: %w", t.ID, err)
	}
	if t.Legs == nil {
		t.Legs = []TradeLeg{}
	}
	t.Broker = string(brokers.Of(broker))
	t.OrderType = "LIMIT"
	t.Direction = Direction(direction)
	t.OpenedAt = opened.UnixMilli()
	if closedAt != nil {
		t.ClosedAt = iptr(closedAt.UnixMilli())
	}
	if marginAt != nil {
		t.MarginAt = iptr(marginAt.UnixMilli())
	}
	if exitReason != nil {
		t.ExitReason = NullStr(*exitReason)
	}
	out := &StoredTrade{Trade: &t}
	t.Status = "closed"
	switch status {
	case "open":
		t.Status = "open"
	case "deleted":
		out.Deleted = true
		out.DeletedFrom = "closed"
		if deletedFrom != nil && *deletedFrom == "open" {
			out.DeletedFrom = "open"
		}
	}
	return out, nil
}

// Get returns the stored row; nil when there is none or the id is malformed.
func (r *Repository) Get(ctx context.Context, id string) (*StoredTrade, error) {
	if !r.Enabled() {
		return nil, errNoStorage
	}
	kind, canon := db.CheckID(id)
	if kind != db.IDValid {
		return nil, nil
	}
	st, err := scanTrade(r.pool.QueryRow(ctx, selectTrade+` where id = $1`, canon))
	if db.NoRows(err) {
		return nil, nil
	}
	return st, err
}

func (r *Repository) list(ctx context.Context, query string, args ...any) ([]*Trade, error) {
	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Trade{}
	for rows.Next() {
		st, err := scanTrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st.Trade)
	}
	return out, rows.Err()
}

// LoadOpen lists the open trades, oldest first.
func (r *Repository) LoadOpen(ctx context.Context) ([]*Trade, error) {
	if !r.Enabled() {
		return nil, errNoStorage
	}
	return r.list(ctx, selectTrade+` where status = 'open' order by opened_at asc, id asc`)
}

// LoadClosed lists closed trades newest first (at most limit; Mongo's limit(0) meant no
// limit), optionally only those closed on or after sinceDay.
func (r *Repository) LoadClosed(ctx context.Context, limit int, sinceDay *string) ([]*Trade, error) {
	if !r.Enabled() {
		return nil, errNoStorage
	}
	q := selectTrade + ` where status = 'closed'`
	var args []any
	if sinceDay != nil {
		args = append(args, *sinceDay)
		q += ` and closed_day >= $1`
	}
	q += ` order by closed_at desc nulls last, id desc`
	if limit > 0 {
		args = append(args, limit)
		q += fmt.Sprintf(` limit $%d`, len(args))
	}
	return r.list(ctx, q, args...)
}

// LoadSettings returns the saved settings with a finite value; unknown keys are ignored.
func (r *Repository) LoadSettings(ctx context.Context) (map[string]float64, error) {
	if !r.Enabled() {
		return nil, errNoStorage
	}
	rows, err := r.pool.Query(ctx, `select id, value from synth_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var key string
		var value float64
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		for _, k := range SettingKeys {
			if k == key && !math.IsNaN(value) && !math.IsInf(value, 0) {
				out[key] = value
			}
		}
	}
	return out, rows.Err()
}

// SaveSettings upserts every setting in one statement (Mongo used one unordered bulk
// write; a single statement is atomic as well).
func (r *Repository) SaveSettings(ctx context.Context, s Settings) error {
	if !r.Enabled() {
		return errNoStorage
	}
	now := jsx.TruncMs(time.Now())
	_, err := r.pool.Exec(ctx, `insert into synth_settings (id, value, updated_at)
		values ($1, $2, $7), ($3, $4, $7), ($5, $6, $7)
		on conflict (id) do update set value = excluded.value, updated_at = excluded.updated_at`,
		SettingKeys[0], s.get(SettingKeys[0]), SettingKeys[1], s.get(SettingKeys[1]),
		SettingKeys[2], s.get(SettingKeys[2]), now)
	return err
}
