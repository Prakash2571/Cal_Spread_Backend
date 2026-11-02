package synthetic

import (
	"encoding/json"
	"fmt"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// optNum is a leg field the TypeScript type marks optional (`?: number | null`): it is
// absent until recorded (and on rows stored before it existed), else null or a number.
type optNum struct {
	set bool
	v   *float64
}

func optOf(v *float64) optNum { return optNum{set: true, v: v} }
func optNull() optNum         { return optNum{set: true} }

// optDepth is an optional `SynthDepth | null` leg field.
type optDepth struct {
	set bool
	v   *Depth
}

func optDepthOf(d *Depth) optDepth { return optDepth{set: true, v: d} }

// TradeLeg is SynthTradeLeg. The entry side is stored; the closing side is always the
// opposite. Token is informational: legs are re-resolved by contract after a restart
// or broker switch.
type TradeLeg struct {
	Role            LegRole
	Side            ratecard.Side
	InstrumentType  string
	Strike          float64
	Tradingsymbol   string
	Token           int64
	EntryPrice      float64
	EntryBid        float64
	EntryAsk        float64
	EntryBidQty     optNum
	EntryAskQty     optNum
	EntryQtyAtTouch optNum
	EntryAgeMs      optNum
	EntryDepth      optDepth
	ExitPrice       *float64
	ExitBid         *float64
	ExitAsk         *float64
	ExitBidQty      optNum
	ExitAskQty      optNum
	ExitQtyAtTouch  optNum
	ExitAgeMs       optNum
	ExitDepth       optDepth
}

// MarshalJSON writes the leg in the TypeScript key order, leaving out optional fields
// that were never recorded.
func (l TradeLeg) MarshalJSON() ([]byte, error) {
	var w objWriter
	w.field("role", l.Role)
	w.field("side", l.Side)
	w.field("instrument_type", l.InstrumentType)
	w.field("strike", l.Strike)
	w.field("tradingsymbol", l.Tradingsymbol)
	w.field("token", l.Token)
	w.field("entry_price", l.EntryPrice)
	w.field("entry_bid", l.EntryBid)
	w.field("entry_ask", l.EntryAsk)
	optField(&w, "entry_bid_qty", l.EntryBidQty)
	optField(&w, "entry_ask_qty", l.EntryAskQty)
	optField(&w, "entry_qty_at_touch", l.EntryQtyAtTouch)
	optField(&w, "entry_age_ms", l.EntryAgeMs)
	if l.EntryDepth.set {
		w.field("entry_depth", l.EntryDepth.v)
	}
	w.field("exit_price", l.ExitPrice)
	w.field("exit_bid", l.ExitBid)
	w.field("exit_ask", l.ExitAsk)
	optField(&w, "exit_bid_qty", l.ExitBidQty)
	optField(&w, "exit_ask_qty", l.ExitAskQty)
	optField(&w, "exit_qty_at_touch", l.ExitQtyAtTouch)
	optField(&w, "exit_age_ms", l.ExitAgeMs)
	if l.ExitDepth.set {
		w.field("exit_depth", l.ExitDepth.v)
	}
	return w.bytes()
}

func optField(w *objWriter, key string, o optNum) {
	if o.set {
		w.field(key, o.v)
	}
}

// UnmarshalJSON reads a leg, keeping track of which optional fields were present.
func (l *TradeLeg) UnmarshalJSON(b []byte) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	var errs []error
	get := func(key string, dst any) {
		if raw, ok := m[key]; ok {
			if err := json.Unmarshal(raw, dst); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", key, err))
			}
		}
	}
	opt := func(key string) optNum {
		raw, ok := m[key]
		if !ok {
			return optNum{}
		}
		var v *float64
		if err := json.Unmarshal(raw, &v); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", key, err))
		}
		return optNum{set: true, v: v}
	}
	depth := func(key string) optDepth {
		raw, ok := m[key]
		if !ok {
			return optDepth{}
		}
		var v *Depth
		if err := json.Unmarshal(raw, &v); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", key, err))
		}
		return optDepth{set: true, v: v}
	}
	*l = TradeLeg{}
	get("role", &l.Role)
	get("side", &l.Side)
	get("instrument_type", &l.InstrumentType)
	get("strike", &l.Strike)
	get("tradingsymbol", &l.Tradingsymbol)
	get("token", &l.Token)
	get("entry_price", &l.EntryPrice)
	get("entry_bid", &l.EntryBid)
	get("entry_ask", &l.EntryAsk)
	l.EntryBidQty = opt("entry_bid_qty")
	l.EntryAskQty = opt("entry_ask_qty")
	l.EntryQtyAtTouch = opt("entry_qty_at_touch")
	l.EntryAgeMs = opt("entry_age_ms")
	l.EntryDepth = depth("entry_depth")
	get("exit_price", &l.ExitPrice)
	get("exit_bid", &l.ExitBid)
	get("exit_ask", &l.ExitAsk)
	l.ExitBidQty = opt("exit_bid_qty")
	l.ExitAskQty = opt("exit_ask_qty")
	l.ExitQtyAtTouch = opt("exit_qty_at_touch")
	l.ExitAgeMs = opt("exit_age_ms")
	l.ExitDepth = depth("exit_depth")
	if len(errs) > 0 {
		return errs[0]
	}
	return nil
}

// withStoredDefaults fills every optional field that was never recorded with null, as
// the Mongoose schema did when a trade was first written.
func (l TradeLeg) withStoredDefaults() TradeLeg {
	for _, o := range []*optNum{&l.EntryBidQty, &l.EntryAskQty, &l.EntryQtyAtTouch, &l.EntryAgeMs,
		&l.ExitBidQty, &l.ExitAskQty, &l.ExitQtyAtTouch, &l.ExitAgeMs} {
		o.set = true
	}
	l.EntryDepth.set = true
	l.ExitDepth.set = true
	return l
}

// Trade is SynthTrade: one paper trade, open or closed. Times are epoch ms; days are IST
// YYYY-MM-DD. Nullable fields are pointers (or NullStr).
type Trade struct {
	ID                   string
	Status               string // "open" | "closed"
	Key                  string
	Broker               string
	ExecutionMode        string // "paper_touch"
	OrderType            string // "LIMIT"
	Underlying           string
	Name                 string
	IsIndex              bool
	Expiry               string
	Strike               float64
	AtmStrike            float64
	AtmOffset            float64
	Direction            Direction
	LotSize              float64
	Quantity             float64
	OpenedAt             int64
	OpenedDay            string
	Legs                 []TradeLeg
	EntryFuturePrice     float64
	EntrySyntheticPrice  float64
	EntryLockPerUnit     float64
	EntryCarryPerUnit    float64
	EntryEdge            float64
	EntryGrossEdge       float64
	EntryCharges         float64
	EstimatedExitCharges float64
	EntryNetEdge         float64
	ExpectedNetProfit    float64
	MinExpectedNetProfit float64
	SafetyBuffer         float64
	ExpectedSlippage     float64
	RfPct                float64
	OptionRateVersion    string
	FuturesRateVersion   string
	ClosedAt             *int64
	ClosedDay            *string
	ExitReason           NullStr
	GrossPnl             *float64
	ExitCharges          *float64
	TotalCharges         *float64
	NetPnl               *float64
	ExitNote             *string
	Margin               *float64
	MarginSource         *string
	MarginHedgeBenefit   *float64
	MarginAt             *int64
	MarginError          *string
}

// Clone returns a copy that shares nothing mutable with t.
func (t *Trade) Clone() *Trade {
	c := *t
	c.Legs = append([]TradeLeg(nil), t.Legs...)
	return &c
}

// MarginPatch is SynthMarginPatch: the margin fields of a trade, written together.
type MarginPatch struct {
	Margin             *float64
	MarginSource       *string
	MarginHedgeBenefit *float64
	MarginAt           *int64
	MarginError        *string
}

func marginOf(t *Trade) MarginPatch {
	return MarginPatch{t.Margin, t.MarginSource, t.MarginHedgeBenefit, t.MarginAt, t.MarginError}
}

func (t *Trade) applyMargin(p MarginPatch) {
	t.Margin, t.MarginSource, t.MarginHedgeBenefit, t.MarginAt, t.MarginError =
		p.Margin, p.MarginSource, p.MarginHedgeBenefit, p.MarginAt, p.MarginError
}

// pnlOverride replaces gross_pnl, total_charges and net_pnl in place (the open view's
// "if closed now" figures keep the keys' positions, as an object spread does).
type pnlOverride struct {
	gross, total, net *float64
}

// writeTrade writes t's fields in SynthTrade key order; iso turns the three times into
// ISO strings (SynthTradeView).
func writeTrade(w *objWriter, t *Trade, iso bool, ov *pnlOverride) {
	at := func(ms *int64) any {
		if ms == nil {
			return nil
		}
		if iso {
			return jsx.ISO(jsx.FromMs(*ms))
		}
		return *ms
	}
	opened := t.OpenedAt
	gross, total, net := t.GrossPnl, t.TotalCharges, t.NetPnl
	if ov != nil {
		gross, total, net = ov.gross, ov.total, ov.net
	}
	legs := t.Legs
	if legs == nil {
		legs = []TradeLeg{}
	}
	w.field("id", t.ID)
	w.field("status", t.Status)
	w.field("key", t.Key)
	w.field("broker", t.Broker)
	w.field("execution_mode", t.ExecutionMode)
	w.field("order_type", t.OrderType)
	w.field("underlying", t.Underlying)
	w.field("name", t.Name)
	w.field("is_index", t.IsIndex)
	w.field("expiry", t.Expiry)
	w.field("strike", t.Strike)
	w.field("atm_strike", t.AtmStrike)
	w.field("atm_offset", t.AtmOffset)
	w.field("direction", t.Direction)
	w.field("lot_size", t.LotSize)
	w.field("quantity", t.Quantity)
	w.field("opened_at", at(&opened))
	w.field("opened_day", t.OpenedDay)
	w.field("legs", legs)
	w.field("entry_future_price", t.EntryFuturePrice)
	w.field("entry_synthetic_price", t.EntrySyntheticPrice)
	w.field("entry_lock_per_unit", t.EntryLockPerUnit)
	w.field("entry_carry_per_unit", t.EntryCarryPerUnit)
	w.field("entry_edge", t.EntryEdge)
	w.field("entry_gross_edge", t.EntryGrossEdge)
	w.field("entry_charges", t.EntryCharges)
	w.field("estimated_exit_charges", t.EstimatedExitCharges)
	w.field("entry_net_edge", t.EntryNetEdge)
	w.field("expected_net_profit", t.ExpectedNetProfit)
	w.field("min_expected_net_profit", t.MinExpectedNetProfit)
	w.field("safety_buffer", t.SafetyBuffer)
	w.field("expected_slippage", t.ExpectedSlippage)
	w.field("rf_pct", t.RfPct)
	w.field("option_rate_version", t.OptionRateVersion)
	w.field("futures_rate_version", t.FuturesRateVersion)
	w.field("closed_at", at(t.ClosedAt))
	w.field("closed_day", t.ClosedDay)
	w.field("exit_reason", t.ExitReason)
	w.field("gross_pnl", gross)
	w.field("exit_charges", t.ExitCharges)
	w.field("total_charges", total)
	w.field("net_pnl", net)
	w.field("exit_note", t.ExitNote)
	w.field("margin", t.Margin)
	w.field("margin_source", t.MarginSource)
	w.field("margin_hedge_benefit", t.MarginHedgeBenefit)
	w.field("margin_at", at(t.MarginAt))
	w.field("margin_error", t.MarginError)
}

// MarshalJSON writes the trade with epoch-ms times (the in-memory SynthTrade).
func (t Trade) MarshalJSON() ([]byte, error) {
	var w objWriter
	writeTrade(&w, &t, false, nil)
	return w.bytes()
}

// tradeWire decodes a SynthTrade (epoch-ms times).
type tradeWire struct {
	ID                   string     `json:"id"`
	Status               string     `json:"status"`
	Key                  string     `json:"key"`
	Broker               string     `json:"broker"`
	ExecutionMode        string     `json:"execution_mode"`
	OrderType            string     `json:"order_type"`
	Underlying           string     `json:"underlying"`
	Name                 string     `json:"name"`
	IsIndex              bool       `json:"is_index"`
	Expiry               string     `json:"expiry"`
	Strike               float64    `json:"strike"`
	AtmStrike            float64    `json:"atm_strike"`
	AtmOffset            float64    `json:"atm_offset"`
	Direction            Direction  `json:"direction"`
	LotSize              float64    `json:"lot_size"`
	Quantity             float64    `json:"quantity"`
	OpenedAt             int64      `json:"opened_at"`
	OpenedDay            string     `json:"opened_day"`
	Legs                 []TradeLeg `json:"legs"`
	EntryFuturePrice     float64    `json:"entry_future_price"`
	EntrySyntheticPrice  float64    `json:"entry_synthetic_price"`
	EntryLockPerUnit     float64    `json:"entry_lock_per_unit"`
	EntryCarryPerUnit    float64    `json:"entry_carry_per_unit"`
	EntryEdge            float64    `json:"entry_edge"`
	EntryGrossEdge       float64    `json:"entry_gross_edge"`
	EntryCharges         float64    `json:"entry_charges"`
	EstimatedExitCharges float64    `json:"estimated_exit_charges"`
	EntryNetEdge         float64    `json:"entry_net_edge"`
	ExpectedNetProfit    float64    `json:"expected_net_profit"`
	MinExpectedNetProfit float64    `json:"min_expected_net_profit"`
	SafetyBuffer         float64    `json:"safety_buffer"`
	ExpectedSlippage     float64    `json:"expected_slippage"`
	RfPct                float64    `json:"rf_pct"`
	OptionRateVersion    string     `json:"option_rate_version"`
	FuturesRateVersion   string     `json:"futures_rate_version"`
	ClosedAt             *int64     `json:"closed_at"`
	ClosedDay            *string    `json:"closed_day"`
	ExitReason           NullStr    `json:"exit_reason"`
	GrossPnl             *float64   `json:"gross_pnl"`
	ExitCharges          *float64   `json:"exit_charges"`
	TotalCharges         *float64   `json:"total_charges"`
	NetPnl               *float64   `json:"net_pnl"`
	ExitNote             *string    `json:"exit_note"`
	Margin               *float64   `json:"margin"`
	MarginSource         *string    `json:"margin_source"`
	MarginHedgeBenefit   *float64   `json:"margin_hedge_benefit"`
	MarginAt             *int64     `json:"margin_at"`
	MarginError          *string    `json:"margin_error"`
}

// UnmarshalJSON reads the epoch-ms form written by MarshalJSON.
func (t *Trade) UnmarshalJSON(b []byte) error {
	var w tradeWire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*t = Trade(w)
	return nil
}

// TradeView is SynthTradeView: a trade as the API returns it, with ISO times. It holds
// its own copy, so it can be encoded after the engine lock is released.
type TradeView struct{ t *Trade }

func toTradeView(t *Trade) TradeView { return TradeView{t.Clone()} }

// MarshalJSON writes the view.
func (v TradeView) MarshalJSON() ([]byte, error) {
	var w objWriter
	writeTrade(&w, v.t, true, nil)
	return w.bytes()
}

// OpenView is SynthOpenView: an open position with its live marks.
type OpenView struct {
	t                    *Trade
	pnl                  pnlOverride
	Linked               bool
	Closing              bool
	ExitLegs             []ExitLeg
	MtmLtp               *float64
	CurrentExitCharges   *float64
	RemainingEdge        *float64
	CapturedEdge         *float64
	CapturedPct          *float64
	ConvergenceThreshold float64
	ProfitCaptureTarget  float64
	MinExitNetPnl        float64
	ExpirySafety         bool
	ExitEligible         bool
	ExitRuleReason       NullStr
	ExitBlockedReason    NullStr
}

// MarshalJSON writes the trade view, then the live fields.
func (v OpenView) MarshalJSON() ([]byte, error) {
	var w objWriter
	writeTrade(&w, v.t, true, &v.pnl)
	legs := v.ExitLegs
	if legs == nil {
		legs = []ExitLeg{}
	}
	w.field("linked", v.Linked)
	w.field("closing", v.Closing)
	w.field("exit_legs", legs)
	w.field("mtm_ltp", v.MtmLtp)
	w.field("current_exit_charges", v.CurrentExitCharges)
	w.field("remaining_edge", v.RemainingEdge)
	w.field("captured_edge", v.CapturedEdge)
	w.field("captured_pct", v.CapturedPct)
	w.field("convergence_threshold", v.ConvergenceThreshold)
	w.field("profit_capture_target", v.ProfitCaptureTarget)
	w.field("min_exit_net_pnl", v.MinExitNetPnl)
	w.field("expiry_safety", v.ExpirySafety)
	w.field("exit_eligible", v.ExitEligible)
	w.field("exit_rule_reason", v.ExitRuleReason)
	w.field("exit_blocked_reason", v.ExitBlockedReason)
	return w.bytes()
}
