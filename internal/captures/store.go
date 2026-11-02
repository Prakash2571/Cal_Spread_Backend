package captures

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// ErrNoDatabase is returned by every Store operation when no pool is configured: the
// Go counterpart of a Mongoose operation that buffers and then fails because no
// connection exists.
var ErrNoDatabase = errors.New("database is not configured (set DATABASE_URL)")

// Source selects the stock_futures partition (the old archive vs current databases).
type Source string

const (
	// SourceArchive is the read-only pre-2026 data (NSE_FNO_ARCHIVE_URI).
	SourceArchive Source = "archive"
	// SourceCurrent is the read-write data (NSE_FNO_CURRENT_URI).
	SourceCurrent Source = "current"
)

// HourlyPrice is one hourlyprices row (db.ts IHourlyPrice).
type HourlyPrice struct {
	Symbol            string   `json:"symbol"`
	Date              string   `json:"date"`
	Time              string   `json:"time"`
	Month             string   `json:"month"`
	CurrentMonthClose float64  `json:"current_month_close"`
	MidMonthClose     float64  `json:"mid_month_close"`
	FarMonthClose     *float64 `json:"far_month_close"`
	Spread            float64  `json:"spread"`
}

// DateTimeSlot is a stored (date, time) pair.
type DateTimeSlot struct {
	Date string `json:"date"`
	Time string `json:"time"`
}

// StockFuture is one stock_futures row (db.ts IStockFuture).
type StockFuture struct {
	TradingDate  time.Time `json:"trading_date"`
	Symbol       string    `json:"symbol"`
	Instrument   string    `json:"instrument"`
	Expiry       time.Time `json:"expiry"`
	Open         float64   `json:"open"`
	High         float64   `json:"high"`
	Low          float64   `json:"low"`
	Close        float64   `json:"close"`
	SettlePrice  float64   `json:"settle_price"`
	Contracts    float64   `json:"contracts"`
	ValueLakh    float64   `json:"value_lakh"`
	OpenInterest float64   `json:"open_interest"`
	ChangeInOI   float64   `json:"change_in_oi"`

	// castErr is set when a date could not be built (Invalid Date in Node); the write
	// then fails like a Mongoose CastError and the row stays at the queue head.
	castErr error
}

// SpreadDaily is one spread_daily row (db.ts ISpreadDaily).
type SpreadDaily struct {
	Symbol      string    `json:"symbol"`
	TradingDate time.Time `json:"trading_date"`
	NearExpiry  time.Time `json:"near_expiry"`
	MidExpiry   time.Time `json:"mid_expiry"`
	NearClose   float64   `json:"near_close"`
	MidClose    float64   `json:"mid_close"`
	Spread      float64   `json:"spread"`
}

// SpreadPoint is the projection recomputeSpreadSummary reads ({symbol, spread, trading_date}).
type SpreadPoint struct {
	Symbol      string
	Spread      float64
	TradingDate time.Time
}

// SpreadSummary is one spread_summary row (db.ts ISpreadSummary) plus its stable id.
// Its JSON (AppendJS, used by httpx.JSON, and MarshalJSON) is the lean Mongo document
// GET /api/spread-stats returned through res.json: _id first, then the fields in schema
// / replacement order, dates as ISO strings, numbers as JSON.stringify writes them; no
// __v (decision in the task plan). _id is left out when ID is empty.
type SpreadSummary struct {
	ID                       string
	Symbol                   string
	Observations             float64
	FirstDate                time.Time
	LastDate                 time.Time
	MeanSpread               float64
	MaxSpread                float64
	MinSpread                float64
	MeanDeviation            float64
	MaxAbsSpread             float64
	StdDevSpread             float64
	Percentile95             float64
	MeanReversionProbability float64
}

// AppendJS implements jsjson.Marshaler with the Node key order.
func (s SpreadSummary) AppendJS(dst []byte) []byte {
	o := jsjson.NewObject(dst)
	if s.ID != "" {
		o.Field("_id", s.ID)
	}
	return o.Field("symbol", s.Symbol).
		Field("observations", s.Observations).
		Field("first_date", jsx.ISO(s.FirstDate)).
		Field("last_date", jsx.ISO(s.LastDate)).
		Field("mean_spread", s.MeanSpread).
		Field("max_spread", s.MaxSpread).
		Field("min_spread", s.MinSpread).
		Field("mean_deviation", s.MeanDeviation).
		Field("max_abs_spread", s.MaxAbsSpread).
		Field("std_dev_spread", s.StdDevSpread).
		Field("percentile_95", s.Percentile95).
		Field("mean_reversion_probability", s.MeanReversionProbability).
		End()
}

// MarshalJSON implements json.Marshaler with the same bytes as AppendJS.
func (s SpreadSummary) MarshalJSON() ([]byte, error) { return s.AppendJS(nil), nil }

// numField is one Number path of a document being written.
type numField struct {
	path string
	v    float64
}

// castNumbers is Mongoose's Number cast on a write: NaN fails the cast ("Cast to Number
// failed for value "NaN" (type number) at path …"), so Node never stored a NaN; the
// write failed and the drain stopped with the row at the head of its queue. The first
// NaN path in document order is reported. Infinity and -0 pass, as in Mongoose.
func castNumbers(fields ...numField) error {
	for _, f := range fields {
		if math.IsNaN(f.v) {
			return fmt.Errorf(`Cast to Number failed for value "NaN" (type number) at path "%s"`, f.path)
		}
	}
	return nil
}

// Store is the PostgreSQL persistence of the capture tables. A nil pool is allowed:
// Ready reports false and every operation returns ErrNoDatabase.
type Store struct {
	pool *db.Pool
}

// eodStore and hourlyStore are the Store methods each job uses (tests wrap them to
// inject write failures).
type eodStore interface {
	Ready() bool
	UpsertStockFuture(ctx context.Context, f StockFuture) error
	LatestStockFutureDate(ctx context.Context) (time.Time, bool, error)
	StockFuturesOn(ctx context.Context, src Source, dates []time.Time) ([]StockFuture, error)
	UpsertSpreadDaily(ctx context.Context, d SpreadDaily) error
	SpreadDailyAll(ctx context.Context) ([]SpreadPoint, error)
	LatestSpreadDailyDate(ctx context.Context) (time.Time, bool, error)
	ReplaceSpreadSummaries(ctx context.Context, docs []SpreadSummary, active []string) error
	LatestSummaryLastDate(ctx context.Context) (time.Time, bool, error)
}

type hourlyStore interface {
	UpsertHourlyPrice(ctx context.Context, p HourlyPrice) error
	HourlySlotsSince(ctx context.Context, symbol, from string) ([]DateTimeSlot, error)
	CountHourlyPrices(ctx context.Context, date string, symbols []string) (int, error)
}

// NewStore wraps pool (nil allowed).
func NewStore(pool *db.Pool) *Store { return &Store{pool: pool} }

// Ready is the "pool ready" gate that replaces isNseFnoDbEnabled / isArchiveDbEnabled.
func (s *Store) Ready() bool { return s != nil && s.pool.Enabled() }

func ms(t time.Time) time.Time { return jsx.TruncMs(t).UTC() }

// --- hourlyprices -------------------------------------------------------------------

// UpsertHourlyPrice is HourlyPrice.updateOne({symbol,date,time}, {$set: doc}, {upsert}).
func (s *Store) UpsertHourlyPrice(ctx context.Context, p HourlyPrice) error {
	if !s.Ready() {
		return ErrNoDatabase
	}
	far := 0.0
	if p.FarMonthClose != nil {
		far = *p.FarMonthClose
	}
	if err := castNumbers(numField{"current_month_close", p.CurrentMonthClose},
		numField{"mid_month_close", p.MidMonthClose}, numField{"far_month_close", far},
		numField{"spread", p.Spread}); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		insert into hourlyprices (symbol, date, time, month, current_month_close, mid_month_close, far_month_close, spread)
		values ($1, $2, $3, $4, $5, $6, $7, $8)
		on conflict (symbol, date, time) do update set
			month = excluded.month,
			current_month_close = excluded.current_month_close,
			mid_month_close = excluded.mid_month_close,
			far_month_close = excluded.far_month_close,
			spread = excluded.spread`,
		p.Symbol, p.Date, p.Time, p.Month, p.CurrentMonthClose, p.MidMonthClose, p.FarMonthClose, p.Spread)
	return err
}

// HourlySlotsSince is HourlyPrice.find({symbol, date: {$gte: from}}, {date, time}).
func (s *Store) HourlySlotsSince(ctx context.Context, symbol, from string) ([]DateTimeSlot, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	rows, err := s.pool.Query(ctx,
		`select date, time from hourlyprices where symbol = $1 and date >= $2 order by id`, symbol, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DateTimeSlot
	for rows.Next() {
		var d DateTimeSlot
		if err := rows.Scan(&d.Date, &d.Time); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// CountHourlyPrices is HourlyPrice.countDocuments({date, symbol: {$in: symbols}}).
func (s *Store) CountHourlyPrices(ctx context.Context, date string, symbols []string) (int, error) {
	if !s.Ready() {
		return 0, ErrNoDatabase
	}
	var n int
	err := s.pool.QueryRow(ctx,
		`select count(*) from hourlyprices where date = $1 and symbol = any($2::text[])`, date, symbols).Scan(&n)
	return n, err
}

// HourlyPrices returns every row of one IST date ordered by symbol and time (tests and
// diagnostics; Node had no reader outside the capture).
func (s *Store) HourlyPrices(ctx context.Context, date string) ([]HourlyPrice, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	rows, err := s.pool.Query(ctx, `
		select symbol, date, time, month, current_month_close, mid_month_close, far_month_close, spread
		from hourlyprices where date = $1 order by symbol, time`, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HourlyPrice
	for rows.Next() {
		var p HourlyPrice
		if err := rows.Scan(&p.Symbol, &p.Date, &p.Time, &p.Month, &p.CurrentMonthClose,
			&p.MidMonthClose, &p.FarMonthClose, &p.Spread); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- stock_futures ------------------------------------------------------------------

// UpsertStockFuture is StockFuture.updateOne({symbol, trading_date, expiry}, {$set: doc},
// {upsert}) on the current database: the app only ever writes source = 'current'.
func (s *Store) UpsertStockFuture(ctx context.Context, f StockFuture) error {
	if !s.Ready() {
		return ErrNoDatabase
	}
	if f.castErr != nil {
		return f.castErr
	}
	if err := castNumbers(numField{"open", f.Open}, numField{"high", f.High}, numField{"low", f.Low},
		numField{"close", f.Close}, numField{"settle_price", f.SettlePrice}, numField{"contracts", f.Contracts},
		numField{"value_lakh", f.ValueLakh}, numField{"open_interest", f.OpenInterest},
		numField{"change_in_oi", f.ChangeInOI}); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		insert into stock_futures (source, trading_date, symbol, instrument, expiry, open, high, low, close,
			settle_price, contracts, value_lakh, open_interest, change_in_oi)
		values ('current', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		on conflict (source, symbol, trading_date, expiry) do update set
			instrument = excluded.instrument,
			open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
			settle_price = excluded.settle_price, contracts = excluded.contracts,
			value_lakh = excluded.value_lakh, open_interest = excluded.open_interest,
			change_in_oi = excluded.change_in_oi`,
		ms(f.TradingDate), f.Symbol, f.Instrument, ms(f.Expiry), f.Open, f.High, f.Low, f.Close,
		f.SettlePrice, f.Contracts, f.ValueLakh, f.OpenInterest, f.ChangeInOI)
	return err
}

// LatestStockFutureDate is StockFuture.findOne().sort({trading_date: -1}) on the current
// database. ok is false when there is no row.
func (s *Store) LatestStockFutureDate(ctx context.Context) (t time.Time, ok bool, err error) {
	if !s.Ready() {
		return time.Time{}, false, ErrNoDatabase
	}
	err = s.pool.QueryRow(ctx,
		`select trading_date from stock_futures where source = 'current' order by trading_date desc limit 1`).Scan(&t)
	if db.NoRows(err) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return t.UTC(), true, nil
}

// StockFuturesOn is find({trading_date: {$in: dates}}) on one database, in natural order.
func (s *Store) StockFuturesOn(ctx context.Context, src Source, dates []time.Time) ([]StockFuture, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	ts := make([]time.Time, len(dates))
	for i, d := range dates {
		ts[i] = ms(d)
	}
	rows, err := s.pool.Query(ctx, `
		select trading_date, symbol, instrument, expiry, open, high, low, close, settle_price,
			contracts, value_lakh, open_interest, change_in_oi
		from stock_futures where source = $1 and trading_date = any($2::timestamptz[]) order by id`,
		string(src), ts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StockFuture
	for rows.Next() {
		var f StockFuture
		if err := rows.Scan(&f.TradingDate, &f.Symbol, &f.Instrument, &f.Expiry, &f.Open, &f.High, &f.Low,
			&f.Close, &f.SettlePrice, &f.Contracts, &f.ValueLakh, &f.OpenInterest, &f.ChangeInOI); err != nil {
			return nil, err
		}
		f.TradingDate, f.Expiry = f.TradingDate.UTC(), f.Expiry.UTC()
		out = append(out, f)
	}
	return out, rows.Err()
}

// --- spread_daily -------------------------------------------------------------------

// UpsertSpreadDaily is SpreadDaily.updateOne({symbol, trading_date}, {$set: doc}, {upsert}).
func (s *Store) UpsertSpreadDaily(ctx context.Context, d SpreadDaily) error {
	if !s.Ready() {
		return ErrNoDatabase
	}
	if err := castNumbers(numField{"near_close", d.NearClose}, numField{"mid_close", d.MidClose},
		numField{"spread", d.Spread}); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		insert into spread_daily (symbol, trading_date, near_expiry, mid_expiry, near_close, mid_close, spread)
		values ($1, $2, $3, $4, $5, $6, $7)
		on conflict (symbol, trading_date) do update set
			near_expiry = excluded.near_expiry, mid_expiry = excluded.mid_expiry,
			near_close = excluded.near_close, mid_close = excluded.mid_close, spread = excluded.spread`,
		d.Symbol, ms(d.TradingDate), ms(d.NearExpiry), ms(d.MidExpiry), d.NearClose, d.MidClose, d.Spread)
	return err
}

// SpreadDailyAll is SpreadDaily.find({}, {symbol, spread, trading_date}) in natural order.
func (s *Store) SpreadDailyAll(ctx context.Context) ([]SpreadPoint, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	rows, err := s.pool.Query(ctx, `select symbol, spread, trading_date from spread_daily order by id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpreadPoint
	for rows.Next() {
		var p SpreadPoint
		if err := rows.Scan(&p.Symbol, &p.Spread, &p.TradingDate); err != nil {
			return nil, err
		}
		p.TradingDate = p.TradingDate.UTC()
		out = append(out, p)
	}
	return out, rows.Err()
}

// SpreadDailyRows returns full rows ordered by symbol and trading_date (tests).
func (s *Store) SpreadDailyRows(ctx context.Context) ([]SpreadDaily, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	rows, err := s.pool.Query(ctx, `
		select symbol, trading_date, near_expiry, mid_expiry, near_close, mid_close, spread
		from spread_daily order by symbol, trading_date`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpreadDaily
	for rows.Next() {
		var d SpreadDaily
		if err := rows.Scan(&d.Symbol, &d.TradingDate, &d.NearExpiry, &d.MidExpiry, &d.NearClose,
			&d.MidClose, &d.Spread); err != nil {
			return nil, err
		}
		d.TradingDate, d.NearExpiry, d.MidExpiry = d.TradingDate.UTC(), d.NearExpiry.UTC(), d.MidExpiry.UTC()
		out = append(out, d)
	}
	return out, rows.Err()
}

// LatestSpreadDailyDate is SpreadDaily.findOne().sort({trading_date: -1}).
func (s *Store) LatestSpreadDailyDate(ctx context.Context) (t time.Time, ok bool, err error) {
	if !s.Ready() {
		return time.Time{}, false, ErrNoDatabase
	}
	err = s.pool.QueryRow(ctx, `select trading_date from spread_daily order by trading_date desc limit 1`).Scan(&t)
	if db.NoRows(err) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return t.UTC(), true, nil
}

// --- spread_summary -----------------------------------------------------------------

// ReplaceSpreadSummaries is the bulkWrite of replaceOne({symbol}, doc, {upsert}) followed
// by deleteMany({symbol: {$nin: active}}), in one transaction. A replaced row keeps its
// id; a new symbol gets a fresh ObjectId-style id. Every document is cast first, as the
// ordered bulkWrite did, so a NaN statistic writes nothing.
func (s *Store) ReplaceSpreadSummaries(ctx context.Context, docs []SpreadSummary, active []string) error {
	if !s.Ready() {
		return ErrNoDatabase
	}
	for _, d := range docs {
		if err := castNumbers(numField{"observations", d.Observations}, numField{"mean_spread", d.MeanSpread},
			numField{"max_spread", d.MaxSpread}, numField{"min_spread", d.MinSpread},
			numField{"mean_deviation", d.MeanDeviation}, numField{"max_abs_spread", d.MaxAbsSpread},
			numField{"std_dev_spread", d.StdDevSpread}, numField{"percentile_95", d.Percentile95},
			numField{"mean_reversion_probability", d.MeanReversionProbability}); err != nil {
			return err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, d := range docs {
		if _, err := tx.Exec(ctx, `
			insert into spread_summary (id, symbol, observations, first_date, last_date, mean_spread, max_spread,
				min_spread, mean_deviation, max_abs_spread, std_dev_spread, percentile_95, mean_reversion_probability)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			on conflict (symbol) do update set
				observations = excluded.observations, first_date = excluded.first_date,
				last_date = excluded.last_date, mean_spread = excluded.mean_spread,
				max_spread = excluded.max_spread, min_spread = excluded.min_spread,
				mean_deviation = excluded.mean_deviation, max_abs_spread = excluded.max_abs_spread,
				std_dev_spread = excluded.std_dev_spread, percentile_95 = excluded.percentile_95,
				mean_reversion_probability = excluded.mean_reversion_probability`,
			db.NewID(), d.Symbol, d.Observations, ms(d.FirstDate), ms(d.LastDate), d.MeanSpread, d.MaxSpread,
			d.MinSpread, d.MeanDeviation, d.MaxAbsSpread, d.StdDevSpread, d.Percentile95,
			d.MeanReversionProbability); err != nil {
			return err
		}
	}
	if active == nil {
		active = []string{}
	}
	if _, err := tx.Exec(ctx, `delete from spread_summary where symbol <> all($1::text[])`, active); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LatestSummaryLastDate is SpreadSummary.findOne().sort({last_date: -1}).
func (s *Store) LatestSummaryLastDate(ctx context.Context) (t time.Time, ok bool, err error) {
	if !s.Ready() {
		return time.Time{}, false, ErrNoDatabase
	}
	err = s.pool.QueryRow(ctx, `select last_date from spread_summary order by last_date desc limit 1`).Scan(&t)
	if db.NoRows(err) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	return t.UTC(), true, nil
}

const summaryColumns = `id, symbol, observations, first_date, last_date, mean_spread, max_spread, min_spread,
	mean_deviation, max_abs_spread, std_dev_spread, percentile_95, mean_reversion_probability`

type rowScanner interface{ Scan(dest ...any) error }

func scanSummary(r rowScanner) (SpreadSummary, error) {
	var d SpreadSummary
	err := r.Scan(&d.ID, &d.Symbol, &d.Observations, &d.FirstDate, &d.LastDate, &d.MeanSpread, &d.MaxSpread,
		&d.MinSpread, &d.MeanDeviation, &d.MaxAbsSpread, &d.StdDevSpread, &d.Percentile95,
		&d.MeanReversionProbability)
	d.FirstDate, d.LastDate = d.FirstDate.UTC(), d.LastDate.UTC()
	return d, err
}

// SpreadSummary is SpreadSummary.findOne({symbol}).lean() (GET /api/spread-stats/:symbol;
// the route upper-cases the symbol). nil, nil when there is no row.
func (s *Store) SpreadSummary(ctx context.Context, symbol string) (*SpreadSummary, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	d, err := scanSummary(s.pool.QueryRow(ctx, `select `+summaryColumns+` from spread_summary where symbol = $1`, symbol))
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// SpreadSummaries returns every row ordered by symbol (tests and diagnostics).
func (s *Store) SpreadSummaries(ctx context.Context) ([]SpreadSummary, error) {
	if !s.Ready() {
		return nil, ErrNoDatabase
	}
	rows, err := s.pool.Query(ctx, `select `+summaryColumns+` from spread_summary order by symbol`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpreadSummary
	for rows.Next() {
		d, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
