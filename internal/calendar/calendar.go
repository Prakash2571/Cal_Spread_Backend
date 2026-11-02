// Package calendar ports the calendar-spread trade book of src/index.ts (the four
// /api/trades routes, their order-book, charge and serialisation helpers) and the Trade
// and TradeLog models of src/db.ts. A trade BUYS the lower-premium leg and SELLS the
// other one of the current and next month futures, exactly one lot, with paper fills at
// the touch of the live book. Nothing here places an order: Kite is asked only for
// quotes, a basket margin and the virtual contract note (/charges/orders).
//
// Storage is PostgreSQL (migration 0002_calendar_trades.sql): `trades` and the
// append-only ledger `trade_log`. A nil pool behaves like Node without MongoDB: writes
// answer 503 and the list answers {dbEnabled:false, trades:[]}.
//
// Behaviour copied from Node on purpose (PLAN.md Decisions): any admin role, including
// the trade-only role, may take, close and delete trades; quotes, margin and charges
// come from Kite even when Dhan is the active broker; the duplicate-open check and the
// close are not atomic (two concurrent requests can both succeed, as in Node).
package calendar

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// ---------------------------------------------------------------------------------------
// Stored and serialised shapes. Struct fields are declared in the key order Node emitted
// (the TypeScript construction order, which is also the Mongoose schema order Mongo
// stored), because the JSON encoder writes fields in declaration order.

// Leg is one leg of a trade (db.ts TradeLeg).
type Leg struct {
	Token  int64   `json:"token"`
	Expiry string  `json:"expiry"` // YYYY-MM-DD
	Entry  float64 `json:"entry"`  // fill price at entry
}

// LegCharges is one order's charges as billed by Zerodha's virtual contract note,
// flattened (db.ts ILegCharges).
type LegCharges struct {
	Side          string  `json:"side"` // BUY | SELL
	Tradingsymbol string  `json:"tradingsymbol"`
	Quantity      float64 `json:"quantity"`
	Price         float64 `json:"price"` // fill price the charges were computed on
	Value         float64 `json:"value"` // quantity * price
	Brokerage     float64 `json:"brokerage"`
	Stt           float64 `json:"stt"`
	SttType       string  `json:"stt_type"`
	ExchangeTxn   float64 `json:"exchange_txn"`
	Sebi          float64 `json:"sebi"`
	StampDuty     float64 `json:"stamp_duty"`
	Gst           float64 `json:"gst"`
	Total         float64 `json:"total"`
}

// TradeCharges is the charges of one side of a trade, both legs together (db.ts
// ITradeCharges). Source is "kite" (the contract note for the actual fills) or
// "kite_estimate" (the same API priced at the entry fills). At is the Date as
// Date.toJSON wrote it.
type TradeCharges struct {
	Legs        []LegCharges `json:"legs"`
	Value       float64      `json:"value"`
	Brokerage   float64      `json:"brokerage"`
	Stt         float64      `json:"stt"`
	ExchangeTxn float64      `json:"exchange_txn"`
	Sebi        float64      `json:"sebi"`
	StampDuty   float64      `json:"stamp_duty"`
	Gst         float64      `json:"gst"`
	Total       float64      `json:"total"`
	Source      string       `json:"source"`
	At          string       `json:"at"`
}

// Trade is one stored trade (db.ts ITrade plus its id). Optional numbers and charges
// are nil until set, which the API writes as null.
type Trade struct {
	ID             string
	Symbol         string
	Name           string
	IsIndex        bool
	LotSize        float64
	Buy            Leg
	Sell           Leg
	Status         string // "open" | "closed"
	OpenedAt       time.Time
	ClosedAt       *time.Time
	ClosePnl       *float64 // GROSS realised P&L
	BuyClose       *float64
	SellClose      *float64
	Margin         *float64
	EntryCharges   *TradeCharges
	ExitCharges    *TradeCharges
	EstExitCharges *TradeCharges
	EntryValue     *float64
	ExitValue      *float64
	TotalCharges   *float64
	NetPnl         *float64
}

// tradeJSON is serializeTrade's output, the API shape of a trade.
type tradeJSON struct {
	ID             string        `json:"id"`
	Symbol         string        `json:"symbol"`
	Name           string        `json:"name"`
	IsIndex        bool          `json:"is_index"`
	LotSize        float64       `json:"lot_size"`
	Buy            Leg           `json:"buy"`
	Sell           Leg           `json:"sell"`
	Status         string        `json:"status"`
	OpenedAt       string        `json:"opened_at"`
	ClosedAt       *string       `json:"closed_at"`
	ClosePnl       *float64      `json:"close_pnl"`
	BuyClose       *float64      `json:"buy_close"`
	SellClose      *float64      `json:"sell_close"`
	Margin         *float64      `json:"margin"`
	EntryCharges   *TradeCharges `json:"entry_charges"`
	ExitCharges    *TradeCharges `json:"exit_charges"`
	EstExitCharges *TradeCharges `json:"est_exit_charges"`
	EntryValue     *float64      `json:"entry_value"`
	ExitValue      *float64      `json:"exit_value"`
	TotalCharges   *float64      `json:"total_charges"`
	NetPnl         *float64      `json:"net_pnl"`
}

// ChargeLeg is a leg to price charges for: the instrument plus the fill it executed at
// (index.ts ChargeLeg).
type ChargeLeg struct {
	Side          string  `json:"side"` // BUY | SELL
	Token         int64   `json:"token"`
	Expiry        string  `json:"expiry"`
	Tradingsymbol string  `json:"tradingsymbol"`
	Exchange      string  `json:"exchange"`
	Quantity      float64 `json:"quantity"`
	Price         float64 `json:"price"`
}

// LogLeg is one leg of a ledger event (db.ts ITradeLogLeg) in the order the TradeLog
// schema stored it, with Kite's untouched charge object in Raw (JSON null when unpriced).
type LogLeg struct {
	Side          string          `json:"side"`
	Token         int64           `json:"token"`
	Tradingsymbol string          `json:"tradingsymbol"`
	Exchange      string          `json:"exchange"`
	Expiry        string          `json:"expiry"`
	Quantity      float64         `json:"quantity"`
	Price         float64         `json:"price"`
	Value         float64         `json:"value"`
	Brokerage     float64         `json:"brokerage"`
	Stt           float64         `json:"stt"`
	SttType       string          `json:"stt_type"`
	ExchangeTxn   float64         `json:"exchange_txn"`
	Sebi          float64         `json:"sebi"`
	StampDuty     float64         `json:"stamp_duty"`
	Gst           float64         `json:"gst"`
	Total         float64         `json:"total"`
	Raw           json.RawMessage `json:"raw"`
}

// ChargeHeads is the summed charge heads of one event (chargeTotals).
type ChargeHeads struct {
	Brokerage   float64 `json:"brokerage"`
	Stt         float64 `json:"stt"`
	ExchangeTxn float64 `json:"exchange_txn"`
	Sebi        float64 `json:"sebi"`
	StampDuty   float64 `json:"stamp_duty"`
	Gst         float64 `json:"gst"`
	Total       float64 `json:"total"`
}

// JSTime is a Date field, written like Date.prototype.toJSON.
type JSTime time.Time

// AppendJS writes the ISO-8601 text with millisecond precision.
func (t JSTime) AppendJS(dst []byte) []byte { return jsjson.AppendString(dst, jsx.ISO(time.Time(t))) }

// LedgerEntry is one trade_log event (db.ts ITradeLog). Source is "kite",
// "kite_estimate" or "unpriced" (Kite could not price the orders: the fills are on
// record but every charge head is zero).
type LedgerEntry struct {
	TradeID      string      `json:"trade_id"`
	Symbol       string      `json:"symbol"`
	Name         string      `json:"name"`
	IsIndex      bool        `json:"is_index"`
	LotSize      float64     `json:"lot_size"`
	Event        string      `json:"event"` // entry | exit
	At           JSTime      `json:"at"`
	Legs         []LogLeg    `json:"legs"`
	Value        float64     `json:"value"`
	Charges      ChargeHeads `json:"charges"`
	Source       string      `json:"source"`
	Margin       *float64    `json:"margin"`
	GrossPnl     *float64    `json:"gross_pnl"`
	TotalCharges *float64    `json:"total_charges"`
	NetPnl       *float64    `json:"net_pnl"`
}

// BoardFuture and BoardItem are the F&O board rows index.ts deriveFnoBoard produces:
// one underlying with its spot token and its (up to three) nearest futures, nearest
// first. They are the captures types, so any deriveFnoBoard port that returns them can
// be passed as Deps.Board directly.
type (
	BoardFuture = captures.BoardFuture
	BoardItem   = captures.BoardItem
)

// MarketDataRefusal is the 401 body of index.ts requireMarketData.
type MarketDataRefusal struct {
	Error    string   `json:"error"`
	Broker   string   `json:"broker"`
	Problems []string `json:"problems"`
}

// NewMarketDataRefusal builds requireMarketData's body for the active broker:
// "<what> requires a <Zerodha|Dhan> session. Connect <Zerodha|Dhan>.".
func NewMarketDataRefusal(what, activeBroker string, problems []string) MarketDataRefusal {
	label := "Zerodha"
	if activeBroker == "dhan" {
		label = "Dhan"
	}
	if problems == nil {
		problems = []string{}
	}
	return MarketDataRefusal{
		Error:    what + " requires a " + label + " session. Connect " + label + ".",
		Broker:   activeBroker,
		Problems: problems,
	}
}

// ---------------------------------------------------------------------------------------
// Collaborators

// Roles resolves the x-admin-token header to a session role. *auth.Sessions implements it.
type Roles interface {
	RoleOf(r *http.Request) auth.Role
}

// LadderSource is the ticker hub's latest order books. *hub.Hub implements it.
type LadderSource interface {
	GetFreshLadder(token int64, maxAgeMs int64) (hub.Ladder, bool)
}

// Kite is the part of the Zerodha REST client the trade routes call. *kite.Client
// implements it. Identifiers are "EXCHANGE:TRADINGSYMBOL".
type Kite interface {
	GetQuoteLadder(ctx context.Context, identifiers []string) (map[int64]kite.QuoteLadder, error)
	GetBasketMargin(ctx context.Context, orders []kite.BasketOrder, considerPositions bool) (kite.BasketMarginResult, error)
	GetOrderCharges(ctx context.Context, orders []kite.ChargeOrder) ([]kite.OrderCharges, error)
}

// Deps are the collaborators cmd/server wires in. Only Pool, Sessions, RequireMarketData,
// Instruments, Board, Hub, Kite and ClearKiteSession carry behaviour; the rest default.
type Deps struct {
	// Pool is the PostgreSQL pool; nil (or not Enabled) means no DATABASE_URL.
	Pool *db.Pool
	// Sessions is requireAdmin's role lookup (any role passes). nil refuses everyone.
	Sessions Roles
	// RequireMarketData is index.ts requireMarketData(res, what): true when the ACTIVE
	// broker is data-ready, else false and the 401 body. nil refuses (Zerodha label).
	RequireMarketData func(what string) (bool, MarketDataRefusal)
	// Instruments is getAllInstrumentsCached: the ACTIVE broker's instrument universe.
	// nil means an empty universe.
	Instruments func(ctx context.Context) ([]market.Instrument, error)
	// Board is deriveFnoBoard over that universe. nil means an empty board.
	Board func(all []market.Instrument) []BoardItem
	// Hub supplies live books (getFreshLadder, 5 s bound). nil means none.
	Hub LadderSource
	// Kite is the Zerodha REST client. It is used whatever the active broker is, as in
	// Node. nil behaves like a client without a session.
	Kite Kite
	// ClearKiteSession is what sendError does on a Kite 401/403: drop the access token
	// from memory and from the kite_session table. nil does nothing.
	ClearKiteSession func()
	// Now is the clock (market hours, timestamps, default ids). nil means time.Now.
	Now func() time.Time
	// NewID allocates trade ids. nil means db.NewIDAt(Now()).
	NewID func() string
	// Logf receives the warnings Node wrote with console.warn. nil means log.Printf.
	Logf func(format string, args ...any)
}

// LadderMaxAgeMs is getFreshLadder's default freshness bound, which the trade routes use.
const LadderMaxAgeMs = 5000

// ledgerTimeout bounds one trade_log insert running after the response was sent.
const ledgerTimeout = 30 * time.Second

// Service owns the trade routes and the ledger writes they start.
type Service struct {
	d     Deps
	store *store

	mu      sync.Mutex
	stopped bool
	wg      sync.WaitGroup
}

// New builds the service. Nothing runs until requests arrive.
func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logf == nil {
		d.Logf = log.Printf
	}
	if d.NewID == nil {
		now := d.Now
		d.NewID = func() string { return db.NewIDAt(now()) }
	}
	if d.RequireMarketData == nil {
		d.RequireMarketData = func(what string) (bool, MarketDataRefusal) {
			return false, NewMarketDataRefusal(what, "zerodha", nil)
		}
	}
	if d.Instruments == nil {
		d.Instruments = func(context.Context) ([]market.Instrument, error) { return nil, nil }
	}
	if d.Board == nil {
		d.Board = func([]market.Instrument) []BoardItem { return nil }
	}
	if d.Kite == nil {
		d.Kite = noSessionKite{}
	}
	if d.ClearKiteSession == nil {
		d.ClearKiteSession = func() {}
	}
	return &Service{d: d, store: &store{pool: d.Pool}}
}

// Mount registers the four routes (index.ts order). The global /api limiter, CORS and
// the JSON body parser come from internal/server; these routes have no limiter of their
// own and every one of them requires an admin session of either role.
func (s *Service) Mount(r chi.Router) {
	r.Post("/api/trades", s.requireAdmin(s.takeTrade))
	r.Get("/api/trades", s.requireAdmin(s.listTrades))
	r.Post("/api/trades/{id}/close", withID(s.requireAdmin(s.closeTrade)))
	r.Delete("/api/trades/{id}", withID(s.requireAdmin(s.deleteTrade)))
}

// Stop waits for ledger writes still in flight. Writes started afterwards run on the
// caller's goroutine.
func (s *Service) Stop() {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
	s.wg.Wait()
}

// background runs fn after the response, like Node's `void appendTradeLog(...)`.
func (s *Service) background(fn func()) {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		fn()
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		fn()
	}()
}

// The production collaborators satisfy the interfaces (wiring checked at compile time).
var (
	_ Roles        = (*auth.Sessions)(nil)
	_ LadderSource = (*hub.Hub)(nil)
	_ Kite         = (*kite.Client)(nil)
)

// noSessionKite is the Kite client of a process that never logged in: every call fails
// the way kite.ts authHeader() does.
type noSessionKite struct{}

func notAuthenticated() error {
	return &kite.KiteError{Status: http.StatusUnauthorized,
		Message: "Not authenticated. Complete the Zerodha login flow first (/login)."}
}

func (noSessionKite) GetQuoteLadder(_ context.Context, ids []string) (map[int64]kite.QuoteLadder, error) {
	if len(ids) == 0 {
		return map[int64]kite.QuoteLadder{}, nil
	}
	return nil, notAuthenticated()
}

func (noSessionKite) GetBasketMargin(context.Context, []kite.BasketOrder, bool) (kite.BasketMarginResult, error) {
	return kite.BasketMarginResult{}, notAuthenticated()
}

func (noSessionKite) GetOrderCharges(_ context.Context, orders []kite.ChargeOrder) ([]kite.OrderCharges, error) {
	if len(orders) == 0 {
		return []kite.OrderCharges{}, nil
	}
	return nil, notAuthenticated()
}
