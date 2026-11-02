package calendar

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// store is the PostgreSQL replacement of the Mongoose models Trade and TradeLog. Every
// method needs an enabled pool; the routes check enabled() first, as Node checked
// isDbEnabled().
type store struct {
	pool *db.Pool
}

var errNoStorage = errors.New("trade persistence is not configured (set DATABASE_URL)")

func (s *store) enabled() bool { return s != nil && s.pool.Enabled() }

// hasOpen is Trade.findOne({symbol, status: "open"}): is a trade for symbol open?
func (s *store) hasOpen(ctx context.Context, symbol string) (bool, error) {
	if !s.enabled() {
		return false, errNoStorage
	}
	var open bool
	err := s.pool.QueryRow(ctx,
		`select exists(select 1 from trades where symbol = $1 and status = 'open')`, symbol).Scan(&open)
	return open, err
}

// encodeCharges is the json column value of a charges document (nil = SQL NULL).
func encodeCharges(c *TradeCharges) *string {
	if c == nil {
		return nil
	}
	text := string(jsjson.Marshal(c))
	return &text
}

func msTime(t time.Time) time.Time { return jsx.TruncMs(t).UTC() }

func msTimePtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := msTime(*t)
	return &v
}

// insert is Trade.create(payload).
func (s *store) insert(ctx context.Context, t *Trade) error {
	if !s.enabled() {
		return errNoStorage
	}
	_, err := s.pool.Exec(ctx, `insert into trades (id, symbol, name, is_index, lot_size,
		buy_token, buy_expiry, buy_entry, sell_token, sell_expiry, sell_entry, status, opened_at, closed_at,
		close_pnl, buy_close, sell_close, margin, entry_charges, exit_charges, est_exit_charges,
		entry_value, exit_value, total_charges, net_pnl)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
		$19::json, $20::json, $21::json, $22, $23, $24, $25)`,
		t.ID, t.Symbol, t.Name, t.IsIndex, t.LotSize,
		t.Buy.Token, t.Buy.Expiry, t.Buy.Entry, t.Sell.Token, t.Sell.Expiry, t.Sell.Entry,
		t.Status, msTime(t.OpenedAt), msTimePtr(t.ClosedAt),
		t.ClosePnl, t.BuyClose, t.SellClose, t.Margin,
		encodeCharges(t.EntryCharges), encodeCharges(t.ExitCharges), encodeCharges(t.EstExitCharges),
		t.EntryValue, t.ExitValue, t.TotalCharges, t.NetPnl)
	return err
}

const selectTrade = `select id, symbol, name, is_index, lot_size, buy_token, buy_expiry, buy_entry,
	sell_token, sell_expiry, sell_entry, status, opened_at, closed_at, close_pnl, buy_close, sell_close,
	margin, entry_charges, exit_charges, est_exit_charges, entry_value, exit_value, total_charges, net_pnl
	from trades`

func scanTrade(row pgx.Row) (*Trade, error) {
	var t Trade
	var closedAt *time.Time
	var entry, exit, est []byte
	err := row.Scan(&t.ID, &t.Symbol, &t.Name, &t.IsIndex, &t.LotSize, &t.Buy.Token, &t.Buy.Expiry,
		&t.Buy.Entry, &t.Sell.Token, &t.Sell.Expiry, &t.Sell.Entry, &t.Status, &t.OpenedAt, &closedAt,
		&t.ClosePnl, &t.BuyClose, &t.SellClose, &t.Margin, &entry, &exit, &est,
		&t.EntryValue, &t.ExitValue, &t.TotalCharges, &t.NetPnl)
	if err != nil {
		return nil, err
	}
	t.OpenedAt = t.OpenedAt.UTC()
	if closedAt != nil {
		c := closedAt.UTC()
		t.ClosedAt = &c
	}
	for _, f := range []struct {
		raw []byte
		dst **TradeCharges
		col string
	}{{entry, &t.EntryCharges, "entry_charges"}, {exit, &t.ExitCharges, "exit_charges"}, {est, &t.EstExitCharges, "est_exit_charges"}} {
		c, err := decodeCharges(f.raw)
		if err != nil {
			return nil, fmt.Errorf("trades %s: decode %s: %w", t.ID, f.col, err)
		}
		*f.dst = c
	}
	return &t, nil
}

// get is Trade.findById(id) for a canonical (lower-case 24-hex) id; nil when absent.
func (s *store) get(ctx context.Context, id string) (*Trade, error) {
	if !s.enabled() {
		return nil, errNoStorage
	}
	t, err := scanTrade(s.pool.QueryRow(ctx, selectTrade+` where id = $1`, id))
	if db.NoRows(err) {
		return nil, nil
	}
	return t, err
}

// list is Trade.find().sort({opened_at: -1}).limit(limit). Ties in opened_at are broken
// by id, newest first (ObjectIds are time-ordered); Mongo left them unordered.
func (s *store) list(ctx context.Context, limit int) ([]*Trade, error) {
	if !s.enabled() {
		return nil, errNoStorage
	}
	rows, err := s.pool.Query(ctx, selectTrade+` order by opened_at desc, id desc limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Trade{}
	for rows.Next() {
		t, err := scanTrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// documentNotFound is the error Mongoose's save() raised when the trade was deleted
// between the read and the write (DocumentNotFoundError).
func documentNotFound(id string) error {
	return fmt.Errorf(`No document found for query "{ _id: new ObjectId('%s') }" on model "Trade"`, id)
}

// saveClose is the close route's trade.save(): it writes the fields the close sets, by
// id only (no status guard, as in Node: of two concurrent closes the last write wins).
// entry_charges is written only when it was backfilled and entry_value only when it was
// missing, the two fields Node set conditionally.
func (s *store) saveClose(ctx context.Context, t *Trade, setEntryCharges, setEntryValue bool) error {
	if !s.enabled() {
		return errNoStorage
	}
	sets := []string{"status = $2", "closed_at = $3", "close_pnl = $4", "buy_close = $5", "sell_close = $6",
		"exit_charges = $7::json", "exit_value = $8", "total_charges = $9", "net_pnl = $10"}
	args := []any{t.ID, t.Status, msTimePtr(t.ClosedAt), t.ClosePnl, t.BuyClose, t.SellClose,
		encodeCharges(t.ExitCharges), t.ExitValue, t.TotalCharges, t.NetPnl}
	if setEntryCharges {
		args = append(args, encodeCharges(t.EntryCharges))
		sets = append(sets, fmt.Sprintf("entry_charges = $%d::json", len(args)))
	}
	if setEntryValue {
		args = append(args, t.EntryValue)
		sets = append(sets, fmt.Sprintf("entry_value = $%d", len(args)))
	}
	tag, err := s.pool.Exec(ctx, "update trades set "+strings.Join(sets, ", ")+" where id = $1", args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return documentNotFound(t.ID)
	}
	return nil
}

// remove is Trade.deleteOne({_id}): a hard delete; the trade's ledger rows stay.
func (s *store) remove(ctx context.Context, id string) error {
	if !s.enabled() {
		return errNoStorage
	}
	_, err := s.pool.Exec(ctx, `delete from trades where id = $1`, id)
	return err
}

// appendLog is TradeLog.create(entry) under the given id.
func (s *store) appendLog(ctx context.Context, id string, e *LedgerEntry) error {
	if !s.enabled() {
		return errNoStorage
	}
	legs := e.Legs
	if legs == nil {
		legs = []LogLeg{}
	}
	_, err := s.pool.Exec(ctx, `insert into trade_log (id, trade_id, symbol, name, is_index, lot_size,
		event, at, legs, value, charges, source, margin, gross_pnl, total_charges, net_pnl)
		values ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10, $11::json, $12, $13, $14, $15, $16)`,
		id, e.TradeID, e.Symbol, e.Name, e.IsIndex, e.LotSize, e.Event, msTime(time.Time(e.At)),
		string(jsjson.Marshal(legs)), e.Value, string(jsjson.Marshal(e.Charges)), e.Source,
		e.Margin, e.GrossPnl, e.TotalCharges, e.NetPnl)
	return err
}

// ---------------------------------------------------------------------------------------
// Decoding stored charge documents. Fields a document lacks read as the schema defaults
// Mongoose applied on hydration (numbers 0, strings "", source "kite", legs []); a null
// number reads as NaN, because only a non-finite value (which JSON.stringify writes as
// null) can have produced one, and the API writes it as null again.

func decodeCharges(raw []byte) (*TradeCharges, error) {
	if raw == nil {
		return nil, nil
	}
	v, err := kitejson.Parse(string(raw))
	if err != nil {
		return nil, err
	}
	if v.Nullish() {
		return nil, nil
	}
	c := &TradeCharges{
		Legs:        []LegCharges{},
		Value:       numField(v, "value"),
		Brokerage:   numField(v, "brokerage"),
		Stt:         numField(v, "stt"),
		ExchangeTxn: numField(v, "exchange_txn"),
		Sebi:        numField(v, "sebi"),
		StampDuty:   numField(v, "stamp_duty"),
		Gst:         numField(v, "gst"),
		Total:       numField(v, "total"),
		Source:      strField(v, "source", "kite"),
		At:          strField(v, "at", ""),
	}
	for _, l := range v.Get("legs").Elems() {
		c.Legs = append(c.Legs, LegCharges{
			Side:          strField(l, "side", ""),
			Tradingsymbol: strField(l, "tradingsymbol", ""),
			Quantity:      numField(l, "quantity"),
			Price:         numField(l, "price"),
			Value:         numField(l, "value"),
			Brokerage:     numField(l, "brokerage"),
			Stt:           numField(l, "stt"),
			SttType:       strField(l, "stt_type", ""),
			ExchangeTxn:   numField(l, "exchange_txn"),
			Sebi:          numField(l, "sebi"),
			StampDuty:     numField(l, "stamp_duty"),
			Gst:           numField(l, "gst"),
			Total:         numField(l, "total"),
		})
	}
	return c, nil
}

func numField(v *kitejson.Value, key string) float64 {
	f := v.Get(key)
	switch f.Kind() {
	case kitejson.Undefined:
		return 0
	case kitejson.Null:
		return math.NaN()
	case kitejson.Number:
		return f.Num()
	}
	return kitejson.ToNumber(f)
}

func strField(v *kitejson.Value, key, def string) string {
	f := v.Get(key)
	if f.Nullish() {
		return def
	}
	return kitejson.ToString(f)
}
