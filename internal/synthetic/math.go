package synthetic

import (
	"math"
	"sort"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/quotes"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/ratecard"
)

// The pure core (src/synthetic/math.ts). No clock and no I/O: `now` (epoch ms) is
// always passed in.
//
// By put-call parity a call bought and a put sold at strike K behave like a long future
// at K: synthetic = K + C(K) − P(K).
//
//	CONVERSION (future cheap): BUY FUT, SELL CE(K), BUY PE(K)
//	    locked per unit = K + (CE.bid − PE.ask) − FUT.ask
//	REVERSAL   (future rich):  SELL FUT, BUY CE(K), SELL PE(K)
//	    locked per unit = FUT.bid − K − (CE.ask − PE.bid)
//
// Prices are the executable TOUCH (BUY at the ask, SELL at the bid), a leg needs a full
// lot at that touch, options must share the future's expiry, and strikes are limited
// to ATM±1..3.

func round2(v float64) float64 { return jsx.Round2(v) }

func fptr(v float64) *float64 { return &v }
func iptr(v int64) *int64     { return &v }
func sptr(v string) *string   { return &v }

// NullStr is a string enumeration that JSON-encodes "" as null (TypeScript `X | null`).
type NullStr string

// MarshalJSON writes null for the empty value.
func (s NullStr) MarshalJSON() ([]byte, error) {
	if s == "" {
		return []byte("null"), nil
	}
	return encodeJS(string(s))
}

// UnmarshalJSON reads null as the empty value.
func (s *NullStr) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*s = ""
		return nil
	}
	var v string
	if err := jsonUnmarshal(b, &v); err != nil {
		return err
	}
	*s = NullStr(v)
	return nil
}

/* ---------------------------------- types ---------------------------------- */

// Direction is SynthDirection.
type Direction string

// The two directions, in SYNTH_DIRECTIONS order.
const (
	Conversion Direction = "CONVERSION"
	Reversal   Direction = "REVERSAL"
)

// Directions is SYNTH_DIRECTIONS.
var Directions = []Direction{Conversion, Reversal}

// LegRole is SynthLegRole.
type LegRole string

// The leg roles, in SYNTH_LEG_ROLES order.
const (
	RoleFut LegRole = "fut"
	RoleCE  LegRole = "ce"
	RolePE  LegRole = "pe"
)

// LegRoles is SYNTH_LEG_ROLES.
var LegRoles = []LegRole{RoleFut, RoleCE, RolePE}

// EntrySide is SYNTH_ENTRY_SIDES[direction][role].
func EntrySide(d Direction, role LegRole) ratecard.Side {
	buyFutures := d == Conversion
	switch role {
	case RoleFut, RolePE:
		if buyFutures {
			return ratecard.Buy
		}
		return ratecard.Sell
	}
	if buyFutures {
		return ratecard.Sell
	}
	return ratecard.Buy
}

func flipSide(s ratecard.Side) ratecard.Side {
	if s == ratecard.Buy {
		return ratecard.Sell
	}
	return ratecard.Buy
}

// Contract is SynthInstrument: one leg's contract.
type Contract struct {
	Token          int64    `json:"token"`
	Tradingsymbol  string   `json:"tradingsymbol"`
	Exchange       string   `json:"exchange"`
	Strike         float64  `json:"strike"` // 0 for the future
	InstrumentType string   `json:"instrument_type"`
	Expiry         string   `json:"expiry"`
	LotSize        float64  `json:"lot_size"`
	TickSize       *float64 `json:"tick_size,omitempty"`
}

// ChainIndex is SynthChainIndex: one underlying's future and the option chain of the
// SAME expiry.
type ChainIndex struct {
	Underlying string
	Expiry     string
	LotSize    float64
	StrikeStep float64
	Future     Contract
	Strikes    []float64 // every strike with both a CE and a PE, ascending
	CE         map[float64]Contract
	PE         map[float64]Contract
}

// BoardItem is the part of an F&O board row this module reads.
type BoardItem struct {
	Symbol  string `json:"symbol"`
	Name    string `json:"name"`
	IsIndex bool   `json:"is_index,omitempty"`
}

// Window is SynthWindow: the monitored ATM±N window of one underlying.
type Window struct {
	Underlying string
	Name       string
	IsIndex    bool
	Expiry     string
	LotSize    float64
	StrikeStep float64
	AtmStrike  float64
	Strikes    []float64
	Future     Contract
	CE         map[float64]Contract
	PE         map[float64]Contract
	RefPrice   float64
	WindowAt   int64
}

// QuoteLike is SynthQuoteLike: the book fields the evaluator reads.
type QuoteLike struct {
	Bid    float64 `json:"bid"`
	BidQty float64 `json:"bid_qty"`
	Ask    float64 `json:"ask"`
	AskQty float64 `json:"ask_qty"`
	Last   float64 `json:"last"`
	At     int64   `json:"at"`
}

// Status is SynthStatus.
type Status string

// Opportunity statuses.
const (
	StatusEligible   Status = "ELIGIBLE"
	StatusOpen       Status = "OPEN"
	StatusWatching   Status = "WATCHING"
	StatusRejected   Status = "REJECTED"
	StatusIndicative Status = "INDICATIVE"
)

var statusRank = map[Status]int{
	StatusEligible: 0, StatusOpen: 1, StatusWatching: 2, StatusIndicative: 3, StatusRejected: 4,
}

// LegEvaluation is SynthLegEvaluation.
type LegEvaluation struct {
	Role           LegRole       `json:"role"`
	Side           ratecard.Side `json:"side"`
	Token          int64         `json:"token"`
	Tradingsymbol  string        `json:"tradingsymbol"`
	Strike         float64       `json:"strike"`
	InstrumentType string        `json:"instrument_type"`
	Price          *float64      `json:"price"`
	QtyAtTouch     float64       `json:"qty_at_touch"`
	Bid            float64       `json:"bid"`
	BidQty         float64       `json:"bid_qty"`
	Ask            float64       `json:"ask"`
	AskQty         float64       `json:"ask_qty"`
	Last           float64       `json:"last"`
	AgeMs          *int64        `json:"age_ms"`
	Fresh          bool          `json:"fresh"`
	Executable     bool          `json:"executable"`
}

// Opportunity is SynthOpportunity (field order = JSON key order).
type Opportunity struct {
	Key                  string          `json:"key"`
	Underlying           string          `json:"underlying"`
	Name                 string          `json:"name"`
	IsIndex              bool            `json:"is_index"`
	Expiry               string          `json:"expiry"`
	DaysToExpiry         float64         `json:"days_to_expiry"`
	Strike               float64         `json:"strike"`
	AtmStrike            float64         `json:"atm_strike"`
	AtmOffset            float64         `json:"atm_offset"`
	StrikeStep           float64         `json:"strike_step"`
	LotSize              float64         `json:"lot_size"`
	Quantity             float64         `json:"quantity"`
	Direction            Direction       `json:"direction"`
	FuturePrice          *float64        `json:"future_price"`
	SyntheticPrice       *float64        `json:"synthetic_price"`
	MidBasis             *float64        `json:"mid_basis"`
	MispricingPerUnit    *float64        `json:"mispricing_per_unit"`
	CarryPerUnit         float64         `json:"carry_per_unit"`
	GrossPerUnit         *float64        `json:"gross_per_unit"`
	GrossEdge            *float64        `json:"gross_edge"`
	EntryCharges         *float64        `json:"entry_charges"`
	EstimatedExitCharges *float64        `json:"estimated_exit_charges"`
	ExpectedSlippage     float64         `json:"expected_slippage"`
	SafetyBuffer         float64         `json:"safety_buffer"`
	ExpectedNetProfit    *float64        `json:"expected_net_profit"`
	MinExpectedNetProfit float64         `json:"min_expected_net_profit"`
	RfPct                float64         `json:"rf_pct"`
	DepthOK              bool            `json:"depth_ok"`
	LiquidityOK          bool            `json:"liquidity_ok"`
	WorstAgeMs           *int64          `json:"worst_age_ms"`
	PriceSource          string          `json:"price_source"`
	Status               Status          `json:"status"`
	Reject               NullStr         `json:"reject"`
	EntryBlocked         NullStr         `json:"entry_blocked"`
	PositionID           *string         `json:"position_id"`
	Legs                 []LegEvaluation `json:"legs"`
	UpdatedAt            int64           `json:"updated_at"`
}

/* --------------------------------- universe -------------------------------- */

func toContract(i market.Instrument, typ string) Contract {
	c := Contract{
		Token:          i.InstrumentToken,
		Tradingsymbol:  i.Tradingsymbol,
		Exchange:       i.Exchange,
		Strike:         i.Strike,
		InstrumentType: typ,
		Expiry:         i.Expiry,
		LotSize:        i.LotSize,
	}
	if typ == "FUT" {
		c.Strike = 0
	}
	if i.TickSize > 0 {
		c.TickSize = fptr(i.TickSize)
	}
	return c
}

// IndexSyntheticChains is indexSyntheticChains: for each underlying, the NEAREST live
// future paired with the option chain of the same expiry. An underlying whose option
// lot differs from the future's lot on that pair is dropped.
func IndexSyntheticChains(all []market.Instrument, today string) map[string]*ChainIndex {
	futures := map[string][]market.Instrument{}
	var futureOrder []string
	options := map[string]map[string][]market.Instrument{}
	for _, i := range all {
		if i.Exchange != "NFO" || i.Name == "" || i.Expiry == "" || i.Expiry < today {
			continue
		}
		if i.InstrumentType == "FUT" {
			if _, ok := futures[i.Name]; !ok {
				futureOrder = append(futureOrder, i.Name)
			}
			futures[i.Name] = append(futures[i.Name], i)
		} else if (i.InstrumentType == "CE" || i.InstrumentType == "PE") && i.Strike > 0 {
			byExpiry := options[i.Name]
			if byExpiry == nil {
				byExpiry = map[string][]market.Instrument{}
				options[i.Name] = byExpiry
			}
			byExpiry[i.Expiry] = append(byExpiry[i.Expiry], i)
		}
	}
	out := map[string]*ChainIndex{}
	for _, underlying := range futureOrder {
		futs := futures[underlying]
		byExpiry := options[underlying]
		if byExpiry == nil {
			continue
		}
		sort.SliceStable(futs, func(a, b int) bool { return localeCompare(futs[a].Expiry, futs[b].Expiry) < 0 })
		for _, fut := range futs {
			if !(fut.LotSize > 0) {
				continue
			}
			contracts, ok := byExpiry[fut.Expiry]
			if !ok {
				continue
			}
			ce := map[float64]Contract{}
			pe := map[float64]Contract{}
			var ceOrder []float64
			lotMismatch := false
			for _, c := range contracts {
				if c.LotSize > 0 && c.LotSize != fut.LotSize {
					lotMismatch = true
				}
				if c.InstrumentType == "CE" {
					if _, seen := ce[c.Strike]; !seen {
						ceOrder = append(ceOrder, c.Strike)
					}
					ce[c.Strike] = toContract(c, "CE")
				} else {
					pe[c.Strike] = toContract(c, "PE")
				}
			}
			if lotMismatch {
				break // a mismatch on the nearest pair means the underlying is unusable
			}
			strikes := make([]float64, 0, len(ceOrder))
			for _, s := range ceOrder {
				if _, ok := pe[s]; ok {
					strikes = append(strikes, s)
				}
			}
			sort.SliceStable(strikes, func(a, b int) bool { return strikes[a] < strikes[b] })
			if len(strikes) == 0 {
				continue
			}
			out[underlying] = &ChainIndex{
				Underlying: underlying,
				Expiry:     fut.Expiry,
				LotSize:    fut.LotSize,
				StrikeStep: quotes.StrikeStep(strikes),
				Future:     toContract(fut, "FUT"),
				Strikes:    strikes,
				CE:         ce,
				PE:         pe,
			}
			break
		}
	}
	return out
}

// BuildWindow is buildSynthWindow: the ATM±eachSide window around ref (the future's
// price), or nil when ref is not positive or the chain is empty.
func BuildWindow(board BoardItem, chain *ChainIndex, ref float64, eachSide int, now int64) *Window {
	if !(ref > 0) {
		return nil
	}
	atm, picked, ok := quotes.SelectStrikeWindow(chain.Strikes, ref, eachSide)
	if !ok {
		return nil
	}
	ce := map[float64]Contract{}
	pe := map[float64]Contract{}
	for _, s := range picked {
		c, okc := chain.CE[s]
		p, okp := chain.PE[s]
		if okc && okp {
			ce[s] = c
			pe[s] = p
		}
	}
	strikes := make([]float64, 0, len(picked))
	for _, s := range picked {
		if _, ok := ce[s]; ok {
			strikes = append(strikes, s)
		}
	}
	return &Window{
		Underlying: chain.Underlying,
		Name:       board.Name,
		IsIndex:    board.IsIndex,
		Expiry:     chain.Expiry,
		LotSize:    chain.LotSize,
		StrikeStep: chain.StrikeStep,
		AtmStrike:  atm,
		Strikes:    strikes,
		Future:     chain.Future,
		CE:         ce,
		PE:         pe,
		RefPrice:   ref,
		WindowAt:   now,
	}
}

// WindowNeedsRebuild is synthWindowNeedsRebuild.
func WindowNeedsRebuild(w *Window, ref float64, now int64, hysteresis, minIntervalMs float64) bool {
	if !(ref > 0) {
		return false
	}
	if float64(now-w.WindowAt) < minIntervalMs {
		return false
	}
	return quotes.ShouldRecentreWindow(w.AtmStrike, ref, w.StrikeStep, hysteresis)
}

// WindowTokens is synthWindowTokens: the future plus a CE and a PE per strike.
func WindowTokens(w *Window) []int64 {
	out := []int64{w.Future.Token}
	for _, s := range w.Strikes {
		out = append(out, w.CE[s].Token, w.PE[s].Token)
	}
	return out
}

// TokensFor is synthTokensFor: tokens a window of eachSide would need.
func TokensFor(eachSide int) int { return 1 + 2*(2*eachSide+1) }

/* --------------------------------- pricing --------------------------------- */

// YearsToExpiry is yearsToExpiry: fractional years from now to 15:30 IST on the expiry
// date, never negative; 0 when the date does not parse.
func YearsToExpiry(expiry string, now int64) float64 {
	settle, ok := jsDateParseDayAt10Z(expiry)
	if !ok {
		return 0
	}
	return math.Max(0, float64(settle-now)) / (365 * 24 * 60 * 60 * 1000)
}

// CandidateKey is candidateKeyFor.
func CandidateKey(underlying, expiry string, strike float64, d Direction) string {
	return underlying + "|" + expiry + "|" + jsNumberString(strike) + "|" + string(d)
}

type touchPrice struct{ price, qty float64 }

func touchOf(q *QuoteLike, side ratecard.Side) touchPrice {
	if side == ratecard.Buy {
		return touchPrice{q.Ask, q.AskQty}
	}
	return touchPrice{q.Bid, q.BidQty}
}

// Reject reasons (SynthRejectReason).
const (
	rejectNoQuote         NullStr = "no_quote"
	rejectStaleQuote      NullStr = "stale_quote"
	rejectMissingBid      NullStr = "missing_bid"
	rejectMissingAsk      NullStr = "missing_ask"
	rejectInsufficientQty NullStr = "insufficient_qty"
	rejectBelowNet        NullStr = "below_expected_net_profit"
	rejectMarketClosed    NullStr = "market_closed"
	rejectNoClose         NullStr = "no_close"
	rejectCrossedBook     NullStr = "crossed_book"
)

func evaluateLeg(role LegRole, side ratecard.Side, inst Contract, q *QuoteLike, quantity float64, now int64, maxAgeMs float64) (LegEvaluation, NullStr) {
	leg := LegEvaluation{
		Role: role, Side: side, Token: inst.Token, Tradingsymbol: inst.Tradingsymbol,
		Strike: inst.Strike, InstrumentType: inst.InstrumentType,
	}
	if q == nil {
		return leg, rejectNoQuote
	}
	age := now - q.At
	if age < 0 {
		age = 0
	}
	fresh := float64(age) <= maxAgeMs
	t := touchOf(q, side)
	var reject NullStr
	switch {
	case !(t.price > 0):
		if side == ratecard.Buy {
			reject = rejectMissingAsk
		} else {
			reject = rejectMissingBid
		}
	case q.Bid > 0 && q.Ask > 0 && q.Bid >= q.Ask:
		reject = rejectCrossedBook
	case t.qty < quantity:
		reject = rejectInsufficientQty
	case !fresh:
		reject = rejectStaleQuote
	}
	if t.price > 0 {
		leg.Price = fptr(t.price)
	}
	leg.QtyAtTouch = t.qty
	leg.Bid, leg.BidQty, leg.Ask, leg.AskQty, leg.Last = q.Bid, q.BidQty, q.Ask, q.AskQty, q.Last
	leg.AgeMs = iptr(age)
	leg.Fresh = fresh
	leg.Executable = reject == ""
	return leg, reject
}

func mid(q *QuoteLike) *float64 {
	if q == nil || !(q.Bid > 0) || !(q.Ask > 0) {
		return nil
	}
	return fptr((q.Bid + q.Ask) / 2)
}

// ChargeOrder is SynthChargeOrder: one order to be costed. Futures legs use the futures
// card, options the option card.
type ChargeOrder struct {
	Role          LegRole       `json:"role"`
	Side          ratecard.Side `json:"side"`
	Tradingsymbol string        `json:"tradingsymbol"`
	Price         float64       `json:"price"`
}

// OrderCharges is synthOrderCharges: total charges (₹) for orders at their prices.
func OrderCharges(orders []ChargeOrder, quantity float64, optionRates, futuresRates ratecard.Rates) float64 {
	total := 0.0
	for _, o := range orders {
		rates := optionRates
		if o.Role == RoleFut {
			rates = futuresRates
		}
		total += ratecard.LegCharges(ratecard.Order{
			Side: o.Side, Tradingsymbol: o.Tradingsymbol, Quantity: quantity, Price: round2(o.Price),
		}, rates).Total
	}
	return round2(total)
}

// Charges is synthCharges: entry charges for the legs and the estimated cost of
// unwinding them, projected at the entry prices.
func Charges(legs []ChargeOrder, quantity float64, optionRates, futuresRates ratecard.Rates) (entry, exit float64) {
	flipped := make([]ChargeOrder, len(legs))
	for i, l := range legs {
		l.Side = flipSide(l.Side)
		flipped[i] = l
	}
	return OrderCharges(legs, quantity, optionRates, futuresRates),
		OrderCharges(flipped, quantity, optionRates, futuresRates)
}

// EvalParams is SynthEvalParams.
type EvalParams struct {
	Quantity             float64        `json:"quantity"`
	Now                  int64          `json:"now"`
	QuoteMaxAgeMs        float64        `json:"quoteMaxAgeMs"`
	RfPct                float64        `json:"rfPct"`
	IncludeCarry         bool           `json:"includeCarry"`
	MinExpectedNetProfit float64        `json:"minExpectedNetProfit"`
	SafetyBuffer         float64        `json:"safetyBuffer"`
	ExpectedSlippage     float64        `json:"expectedSlippage"`
	OptionRates          ratecard.Rates `json:"optionRates"`
	FuturesRates         ratecard.Rates `json:"futuresRates"`
	Indicative           bool           `json:"indicative"`
}

// QuoteFunc returns a token's book, or nil when there is none.
type QuoteFunc func(token int64) *QuoteLike

// EvaluateSynthetic is evaluateSynthetic: one strike of a window in one direction.
// quoteFor returns the live book, or a close-only quote (bid = ask = 0, last = close)
// when p.Indicative.
func EvaluateSynthetic(w *Window, strike float64, direction Direction, quoteFor QuoteFunc, p EvalParams) *Opportunity {
	insts := map[LegRole]Contract{RoleFut: w.Future, RoleCE: w.CE[strike], RolePE: w.PE[strike]}
	qs := map[LegRole]*QuoteLike{
		RoleFut: quoteFor(insts[RoleFut].Token),
		RoleCE:  quoteFor(insts[RoleCE].Token),
		RolePE:  quoteFor(insts[RolePE].Token),
	}
	legs := make([]LegEvaluation, 0, 3)
	var reject NullStr
	var worstAge *int64
	price := map[LegRole]float64{}
	for _, role := range LegRoles {
		inst := insts[role]
		side := EntrySide(direction, role)
		q := qs[role]
		if p.Indicative {
			last := 0.0
			if q != nil {
				last = q.Last
			}
			leg := LegEvaluation{
				Role: role, Side: side, Token: inst.Token, Tradingsymbol: inst.Tradingsymbol,
				Strike: inst.Strike, InstrumentType: inst.InstrumentType, Last: last,
			}
			if last > 0 {
				leg.Price = fptr(last)
				price[role] = last
			} else if reject == "" {
				reject = rejectNoClose
			}
			legs = append(legs, leg)
			continue
		}
		leg, r := evaluateLeg(role, side, inst, q, p.Quantity, p.Now, p.QuoteMaxAgeMs)
		legs = append(legs, leg)
		if leg.Price != nil {
			price[role] = *leg.Price
		}
		if leg.AgeMs != nil {
			cur := int64(0)
			if worstAge != nil {
				cur = *worstAge
			}
			worstAge = iptr(max(cur, *leg.AgeMs))
		}
		if reject == "" {
			reject = r
		}
	}

	years := YearsToExpiry(w.Expiry, p.Now)
	fut, hasFut := price[RoleFut]
	ce, hasCE := price[RoleCE]
	pe, hasPE := price[RolePE]
	allPriced := hasFut && hasCE && hasPE

	var synthetic, mispricing *float64
	carry := 0.0
	if allPriced {
		// The net option premium: received on a conversion, paid on a reversal. Either
		// way it is financed until expiry.
		netPremium := ce - pe
		s := strike + netPremium
		synthetic = &s
		m := s - fut
		if direction != Conversion {
			m = fut - s
		}
		mispricing = &m
		if p.IncludeCarry && p.RfPct != 0 {
			interest := netPremium * (p.RfPct / 100) * years
			carry = interest
			if direction != Conversion {
				carry = -interest
			}
		}
	}

	midOf := func(role LegRole) *float64 {
		q := qs[role]
		if p.Indicative {
			if q != nil && q.Last != 0 && !math.IsNaN(q.Last) { // `q?.last || null`
				return fptr(q.Last)
			}
			return nil
		}
		return mid(q)
	}
	futMid, ceMid, peMid := midOf(RoleFut), midOf(RoleCE), midOf(RolePE)
	var midBasis *float64
	if futMid != nil && ceMid != nil && peMid != nil {
		midBasis = fptr(round2(*futMid - (strike + *ceMid - *peMid)))
	}

	var gross, grossEdge *float64
	if mispricing != nil {
		g := *mispricing + carry
		gross = &g
		grossEdge = fptr(round2(g * p.Quantity))
	}

	var entryCharges, exitCharges *float64
	if allPriced {
		en, ex := Charges([]ChargeOrder{
			{Role: RoleFut, Side: EntrySide(direction, RoleFut), Tradingsymbol: insts[RoleFut].Tradingsymbol, Price: fut},
			{Role: RoleCE, Side: EntrySide(direction, RoleCE), Tradingsymbol: insts[RoleCE].Tradingsymbol, Price: ce},
			{Role: RolePE, Side: EntrySide(direction, RolePE), Tradingsymbol: insts[RolePE].Tradingsymbol, Price: pe},
		}, p.Quantity, p.OptionRates, p.FuturesRates)
		entryCharges, exitCharges = &en, &ex
	}

	var expectedNet *float64
	if grossEdge != nil && entryCharges != nil && exitCharges != nil {
		expectedNet = fptr(round2(*grossEdge - *entryCharges - *exitCharges - p.ExpectedSlippage - p.SafetyBuffer))
	}

	depthOK, liquidityOK := !p.Indicative, !p.Indicative
	for _, l := range legs {
		if !(l.Price != nil && l.QtyAtTouch >= p.Quantity) {
			depthOK = false
		}
		if !l.Executable {
			liquidityOK = false
		}
	}

	var status Status
	switch {
	case p.Indicative:
		status = StatusIndicative
		if reject == "" {
			reject = rejectMarketClosed
		}
	case reject != "":
		status = StatusRejected
	case expectedNet != nil && *expectedNet >= p.MinExpectedNetProfit:
		status = StatusEligible
	default:
		status = StatusWatching
		reject = rejectBelowNet
	}

	atmIdx, idx := indexOf(w.Strikes, w.AtmStrike), indexOf(w.Strikes, strike)
	atmOffset := 0.0
	if atmIdx >= 0 && idx >= 0 {
		atmOffset = float64(idx - atmIdx)
	}
	priceSource := "touch"
	if p.Indicative {
		priceSource = "last_close"
	}
	o := &Opportunity{
		Key:                  CandidateKey(w.Underlying, w.Expiry, strike, direction),
		Underlying:           w.Underlying,
		Name:                 w.Name,
		IsIndex:              w.IsIndex,
		Expiry:               w.Expiry,
		DaysToExpiry:         round2(years * 365),
		Strike:               strike,
		AtmStrike:            w.AtmStrike,
		AtmOffset:            atmOffset,
		StrikeStep:           w.StrikeStep,
		LotSize:              w.LotSize,
		Quantity:             p.Quantity,
		Direction:            direction,
		CarryPerUnit:         round2(carry),
		GrossEdge:            grossEdge,
		EntryCharges:         entryCharges,
		EstimatedExitCharges: exitCharges,
		ExpectedSlippage:     p.ExpectedSlippage,
		SafetyBuffer:         p.SafetyBuffer,
		ExpectedNetProfit:    expectedNet,
		MinExpectedNetProfit: p.MinExpectedNetProfit,
		RfPct:                p.RfPct,
		DepthOK:              depthOK,
		LiquidityOK:          liquidityOK,
		WorstAgeMs:           worstAge,
		PriceSource:          priceSource,
		Status:               status,
		Reject:               reject,
		Legs:                 legs,
		UpdatedAt:            p.Now,
		MidBasis:             midBasis,
	}
	if hasFut {
		o.FuturePrice = fptr(fut)
	}
	if synthetic != nil {
		o.SyntheticPrice = fptr(round2(*synthetic))
	}
	if mispricing != nil {
		o.MispricingPerUnit = fptr(round2(*mispricing))
	}
	if gross != nil {
		o.GrossPerUnit = fptr(round2(*gross))
	}
	return o
}

func indexOf(xs []float64, v float64) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}

// SortOpportunities is sortOpportunities (in place, stable): ELIGIBLE first, then by
// expected net (best first; unpriced last), then by key in localeCompare order.
func SortOpportunities(list []*Opportunity) []*Opportunity {
	sort.SliceStable(list, func(i, j int) bool { return compareOpportunities(list[i], list[j]) < 0 })
	return list
}

func compareOpportunities(a, b *Opportunity) int {
	if r := statusRank[a.Status] - statusRank[b.Status]; r != 0 {
		return r
	}
	an, bn := math.Inf(-1), math.Inf(-1)
	if a.ExpectedNetProfit != nil {
		an = *a.ExpectedNetProfit
	}
	if b.ExpectedNetProfit != nil {
		bn = *b.ExpectedNetProfit
	}
	if an != bn {
		if bn-an < 0 {
			return -1
		}
		return 1
	}
	return localeCompare(a.Key, b.Key)
}

/* ------------------------------ paper positions ----------------------------- */

// Exit reasons (SYNTH_EXIT_REASONS order).
const (
	ExitEdgeConverged NullStr = "EDGE_CONVERGED"
	ExitProfitCapture NullStr = "PROFIT_CAPTURE"
	ExitExpirySafety  NullStr = "EXPIRY_SAFETY"
	ExitExpired       NullStr = "EXPIRED"
	ExitManual        NullStr = "MANUAL"
)

// ExitReasons is SYNTH_EXIT_REASONS.
var ExitReasons = []NullStr{ExitEdgeConverged, ExitProfitCapture, ExitExpirySafety, ExitExpired, ExitManual}

// Exit-blocked reasons (SynthExitBlockedReason).
const (
	blockedUnpriced     NullStr = "unpriced"
	blockedNetBelow     NullStr = "net_below_floor"
	blockedExitLiquidty NullStr = "insufficient_exit_liquidity"
)

// DepthLevel is one recorded book level.
type DepthLevel struct {
	Price float64 `json:"price"`
	Qty   float64 `json:"qty"`
}

// Depth is SynthDepth: up to five levels a side, best first.
type Depth struct {
	Bids []DepthLevel `json:"bids"`
	Asks []DepthLevel `json:"asks"`
}

// DepthOf is depthOf: the top of a book (at most five levels a side), nil without one.
func DepthOf(bids, asks []market.DepthLevel, present bool) *Depth {
	if !present {
		return nil
	}
	pick := func(levels []market.DepthLevel) []DepthLevel {
		out := make([]DepthLevel, 0, min(5, len(levels)))
		for i, l := range levels {
			if i == 5 {
				break
			}
			out = append(out, DepthLevel{Price: l.Price, Qty: l.Qty})
		}
		return out
	}
	return &Depth{Bids: pick(bids), Asks: pick(asks)}
}

// DepthFunc returns the book behind a token at this instant (nil when none).
type DepthFunc func(token int64) *Depth

// OpenTradeFromOpportunity is openTradeFromOpportunity: a paper trade at exactly the
// touch the opportunity was priced at, or nil when any leg lacks a real touch.
func OpenTradeFromOpportunity(opp *Opportunity, id string, broker string, now int64, day, optionRateVersion, futuresRateVersion string, depthFor DepthFunc) *Trade {
	if opp.PriceSource != "touch" || opp.FuturePrice == nil || opp.SyntheticPrice == nil ||
		opp.MispricingPerUnit == nil || opp.GrossEdge == nil || opp.EntryCharges == nil ||
		opp.EstimatedExitCharges == nil || opp.ExpectedNetProfit == nil {
		return nil
	}
	legs := make([]TradeLeg, 0, len(opp.Legs))
	for _, l := range opp.Legs {
		// Never invent a fill: every leg must have had a real touch.
		if l.Price == nil || !(*l.Price > 0) || !l.Executable {
			return nil
		}
		var depth *Depth
		if depthFor != nil {
			depth = depthFor(l.Token)
		}
		var age *float64
		if l.AgeMs != nil {
			age = fptr(float64(*l.AgeMs))
		}
		legs = append(legs, TradeLeg{
			Role: l.Role, Side: l.Side, InstrumentType: l.InstrumentType, Strike: l.Strike,
			Tradingsymbol: l.Tradingsymbol, Token: l.Token,
			EntryPrice: *l.Price, EntryBid: l.Bid, EntryAsk: l.Ask,
			EntryBidQty:     optOf(fptr(l.BidQty)),
			EntryAskQty:     optOf(fptr(l.AskQty)),
			EntryQtyAtTouch: optOf(fptr(l.QtyAtTouch)),
			EntryAgeMs:      optOf(age),
			EntryDepth:      optDepthOf(depth),
		})
	}
	entryEdge := round2(*opp.MispricingPerUnit * opp.Quantity)
	return &Trade{
		ID:                   id,
		Status:               "open",
		Key:                  opp.Key,
		Broker:               broker,
		ExecutionMode:        "paper_touch",
		OrderType:            "LIMIT",
		Underlying:           opp.Underlying,
		Name:                 opp.Name,
		IsIndex:              opp.IsIndex,
		Expiry:               opp.Expiry,
		Strike:               opp.Strike,
		AtmStrike:            opp.AtmStrike,
		AtmOffset:            opp.AtmOffset,
		Direction:            opp.Direction,
		LotSize:              opp.LotSize,
		Quantity:             opp.Quantity,
		OpenedAt:             now,
		OpenedDay:            day,
		Legs:                 legs,
		EntryFuturePrice:     *opp.FuturePrice,
		EntrySyntheticPrice:  *opp.SyntheticPrice,
		EntryLockPerUnit:     *opp.MispricingPerUnit,
		EntryCarryPerUnit:    opp.CarryPerUnit,
		EntryEdge:            entryEdge,
		EntryGrossEdge:       *opp.GrossEdge,
		EntryCharges:         *opp.EntryCharges,
		EstimatedExitCharges: *opp.EstimatedExitCharges,
		EntryNetEdge:         round2(entryEdge - *opp.EntryCharges - *opp.EstimatedExitCharges),
		ExpectedNetProfit:    *opp.ExpectedNetProfit,
		MinExpectedNetProfit: opp.MinExpectedNetProfit,
		SafetyBuffer:         opp.SafetyBuffer,
		ExpectedSlippage:     opp.ExpectedSlippage,
		RfPct:                opp.RfPct,
		OptionRateVersion:    optionRateVersion,
		FuturesRateVersion:   futuresRateVersion,
	}
}

// ExitRules is SynthExitRules.
type ExitRules struct {
	ConvergenceFloor float64 `json:"convergenceFloor"`
	ConvergencePct   float64 `json:"convergencePct"`
	MinExitNetPnl    float64 `json:"minExitNetPnl"`
	ProfitCapturePct float64 `json:"profitCapturePct"`
	MinCapturedPct   float64 `json:"minCapturedPct"`
}

// ExitLeg is SynthExitLeg: one leg as it would be CLOSED now.
type ExitLeg struct {
	Role          LegRole       `json:"role"`
	Side          ratecard.Side `json:"side"` // the closing side
	Tradingsymbol string        `json:"tradingsymbol"`
	Token         int64         `json:"token"`
	EntryPrice    float64       `json:"entry_price"`
	Price         *float64      `json:"price"`
	QtyAtTouch    float64       `json:"qty_at_touch"`
	Bid           float64       `json:"bid"`
	BidQty        float64       `json:"bid_qty"`
	Ask           float64       `json:"ask"`
	AskQty        float64       `json:"ask_qty"`
	Ltp           *float64      `json:"ltp"`
	AgeMs         *int64        `json:"age_ms"`
	Fresh         bool          `json:"fresh"`
	Executable    bool          `json:"executable"`
	Reject        NullStr       `json:"reject"`
}

// ExitMetrics is SynthExitMetrics.
type ExitMetrics struct {
	Legs                 []ExitLeg `json:"legs"`
	Executable           bool      `json:"executable"`
	MtmLtp               *float64  `json:"mtm_ltp"`
	GrossPnl             *float64  `json:"gross_pnl"`
	ExitCharges          *float64  `json:"exit_charges"`
	TotalCharges         *float64  `json:"total_charges"`
	NetPnl               *float64  `json:"net_pnl"`
	RemainingEdge        *float64  `json:"remaining_edge"`
	CapturedEdge         *float64  `json:"captured_edge"`
	CapturedPct          *float64  `json:"captured_pct"`
	ConvergenceThreshold float64   `json:"convergence_threshold"`
	ProfitCaptureTarget  float64   `json:"profit_capture_target"`
	MinExitNetPnl        float64   `json:"min_exit_net_pnl"`
	ExpirySafety         bool      `json:"expiry_safety"`
	ShouldExit           bool      `json:"should_exit"`
	Reason               NullStr   `json:"reason"`
	RuleReason           NullStr   `json:"rule_reason"`
	BlockedReason        NullStr   `json:"blocked_reason"`
}

// LtpFunc returns the LTP used for the broker-screen mark, or nil.
type LtpFunc func(token int64) *float64

// ExitParams carries evaluateSynthExit's scalar arguments.
type ExitParams struct {
	Now           int64
	QuoteMaxAgeMs float64
	ExpirySafety  bool
	Rules         ExitRules
	OptionRates   ratecard.Rates
	FuturesRates  ratecard.Rates
}

// EvaluateExit is evaluateSynthExit: price the unwind of an open paper position and
// decide whether to close it (Box's exit rules on the same quantities).
func EvaluateExit(t *Trade, quoteFor QuoteFunc, ltpFor LtpFunc, p ExitParams) *ExitMetrics {
	rules := p.Rules
	legs := make([]ExitLeg, 0, len(t.Legs))
	var closing []ChargeOrder
	gross, mtm := 0.0, 0.0
	priced, marked := true, true
	for _, leg := range t.Legs {
		side := flipSide(leg.Side)
		inst := Contract{
			Token: leg.Token, Tradingsymbol: leg.Tradingsymbol, Exchange: "NFO", Strike: leg.Strike,
			InstrumentType: leg.InstrumentType, Expiry: t.Expiry, LotSize: t.LotSize,
		}
		r, reject := evaluateLeg(leg.Role, side, inst, quoteFor(leg.Token), t.Quantity, p.Now, p.QuoteMaxAgeMs)
		ltp := ltpFor(leg.Token)
		legs = append(legs, ExitLeg{
			Role: leg.Role, Side: side, Tradingsymbol: leg.Tradingsymbol, Token: leg.Token,
			EntryPrice: leg.EntryPrice, Price: r.Price, QtyAtTouch: r.QtyAtTouch,
			Bid: r.Bid, BidQty: r.BidQty, Ask: r.Ask, AskQty: r.AskQty, Ltp: ltp,
			AgeMs: r.AgeMs, Fresh: r.Fresh, Executable: r.Executable, Reject: reject,
		})
		// A long leg (entered BUY) gains when its price rises, a short leg when it falls.
		sign := -1.0
		if leg.Side == ratecard.Buy {
			sign = 1
		}
		if r.Price == nil {
			priced = false
		} else {
			gross += float64(sign * (*r.Price - leg.EntryPrice))
			closing = append(closing, ChargeOrder{Role: leg.Role, Side: side, Tradingsymbol: leg.Tradingsymbol, Price: *r.Price})
		}
		if ltp == nil || !(*ltp > 0) {
			marked = false
		} else {
			mtm += float64(sign * (*ltp - leg.EntryPrice))
		}
	}

	var grossPnl, exitCharges, totalCharges, netPnl, remaining, capturedPct *float64
	if priced {
		grossPnl = fptr(round2(gross * t.Quantity))
		exitCharges = fptr(OrderCharges(closing, t.Quantity, p.OptionRates, p.FuturesRates))
		totalCharges = fptr(round2(t.EntryCharges + *exitCharges))
		netPnl = fptr(round2(*grossPnl - *totalCharges))
		remaining = fptr(round2(t.EntryEdge - *grossPnl))
		if math.Abs(t.EntryEdge) > 0 {
			capturedPct = fptr(round2(*grossPnl / math.Abs(t.EntryEdge)))
		}
	}
	threshold := round2(math.Max(rules.ConvergenceFloor, rules.ConvergencePct*t.EntryNetEdge))
	captureTarget := round2(rules.ProfitCapturePct * t.EntryNetEdge)
	executable := len(legs) == 3
	for _, l := range legs {
		if !l.Executable {
			executable = false
		}
	}

	var ruleReason, blocked NullStr
	switch {
	case netPnl == nil:
		blocked = blockedUnpriced
	case *netPnl > 0 && remaining != nil:
		clearsFloor := *netPnl >= rules.MinExitNetPnl
		converged := *remaining <= threshold
		capturedEnough := *netPnl >= captureTarget || (capturedPct != nil && *capturedPct >= rules.MinCapturedPct)
		switch {
		case converged && clearsFloor:
			ruleReason = ExitEdgeConverged
		case clearsFloor && capturedEnough:
			ruleReason = ExitProfitCapture
		case converged || capturedEnough:
			blocked = blockedNetBelow
		}
	case remaining != nil && *remaining <= threshold:
		// Converged into a loss: hold, the lock still pays at expiry.
		blocked = blockedNetBelow
	}

	var reason NullStr
	if executable {
		reason = ruleReason
		if reason == "" && p.ExpirySafety {
			reason = ExitExpirySafety
		}
	}
	if (ruleReason != "" || p.ExpirySafety) && !executable {
		blocked = blockedExitLiquidty
	}
	var mtmLtp *float64
	if marked {
		mtmLtp = fptr(round2(mtm * t.Quantity))
	}
	return &ExitMetrics{
		Legs:                 legs,
		Executable:           executable,
		MtmLtp:               mtmLtp,
		GrossPnl:             grossPnl,
		ExitCharges:          exitCharges,
		TotalCharges:         totalCharges,
		NetPnl:               netPnl,
		RemainingEdge:        remaining,
		CapturedEdge:         grossPnl,
		CapturedPct:          capturedPct,
		ConvergenceThreshold: threshold,
		ProfitCaptureTarget:  captureTarget,
		MinExitNetPnl:        rules.MinExitNetPnl,
		ExpirySafety:         p.ExpirySafety,
		ShouldExit:           reason != "",
		Reason:               reason,
		RuleReason:           ruleReason,
		BlockedReason:        blocked,
	}
}

// CloseTradeAtTouch is closeTradeAtTouch: close t at the touch priced in m (which must
// be executable); each leg is a closing LIMIT at the best bid or best ask.
func CloseTradeAtTouch(t *Trade, m *ExitMetrics, reason NullStr, now int64, day string, depthFor DepthFunc) *Trade {
	if !m.Executable || m.GrossPnl == nil || m.ExitCharges == nil {
		return nil
	}
	byRole := map[LegRole]ExitLeg{}
	for _, l := range m.Legs {
		byRole[l.Role] = l
	}
	out := t.Clone()
	for i := range out.Legs {
		leg := &out.Legs[i]
		ex, ok := byRole[leg.Role]
		if !ok {
			leg.ExitPrice, leg.ExitBid, leg.ExitAsk = nil, nil, nil
			leg.ExitBidQty, leg.ExitAskQty, leg.ExitQtyAtTouch, leg.ExitAgeMs = optNull(), optNull(), optNull(), optNull()
			leg.ExitDepth = optDepthOf(nil)
			continue
		}
		leg.ExitPrice = ex.Price
		leg.ExitBid = fptr(ex.Bid)
		leg.ExitAsk = fptr(ex.Ask)
		leg.ExitBidQty = optOf(fptr(ex.BidQty))
		leg.ExitAskQty = optOf(fptr(ex.AskQty))
		leg.ExitQtyAtTouch = optOf(fptr(ex.QtyAtTouch))
		var age *float64
		if ex.AgeMs != nil {
			age = fptr(float64(*ex.AgeMs))
		}
		leg.ExitAgeMs = optOf(age)
		var depth *Depth
		if depthFor != nil {
			depth = depthFor(ex.Token)
		}
		leg.ExitDepth = optDepthOf(depth)
	}
	out.Status = "closed"
	out.ClosedAt = iptr(now)
	out.ClosedDay = sptr(day)
	out.ExitReason = reason
	out.GrossPnl = fptr(*m.GrossPnl)
	out.ExitCharges = fptr(*m.ExitCharges)
	out.TotalCharges = fptr(round2(t.EntryCharges + *m.ExitCharges))
	out.NetPnl = fptr(round2(*m.GrossPnl - t.EntryCharges - *m.ExitCharges))
	out.ExitNote = nil
	return out
}

const settleNote = "Held to expiry and settled at the parity lock. Exit charges are the unwind estimate " +
	"recorded at entry; exercise and delivery charges are not modelled."

// SettleTradeAtExpiry is settleTradeAtExpiry: a position still open at expiry settles
// at its parity lock; the exit cost is the unwind estimate recorded at entry.
func SettleTradeAtExpiry(t *Trade, now int64, day string) *Trade {
	exitCharges := t.EstimatedExitCharges
	total := round2(t.EntryCharges + exitCharges)
	out := t.Clone()
	out.Status = "closed"
	out.ClosedAt = iptr(now)
	out.ClosedDay = sptr(day)
	out.ExitReason = ExitExpired
	out.GrossPnl = fptr(t.EntryEdge)
	out.ExitCharges = fptr(exitCharges)
	out.TotalCharges = fptr(total)
	out.NetPnl = fptr(round2(t.EntryEdge - total))
	out.ExitNote = sptr(settleNote)
	return out
}

// ISTCloseMinutes is IST_CLOSE_MINUTES (15:30).
const ISTCloseMinutes = 15*60 + 30

// ISTMinutesOfDay is istMinutesOfDay: minutes since IST midnight.
func ISTMinutesOfDay(now int64) int {
	ist := time.UnixMilli(now + 19_800_000).UTC()
	return ist.Hour()*60 + ist.Minute()
}

// InExpirySafetyWindow is inExpirySafetyWindow: on expiry day, from `minutes` before
// 15:30 IST.
func InExpirySafetyWindow(expiry, today string, now int64, minutes float64) bool {
	return expiry == today && float64(ISTMinutesOfDay(now)) >= ISTCloseMinutes-minutes
}

// IsPastSettlement is isPastSettlement: past expiry, or expiry day after the close with
// the market shut.
func IsPastSettlement(expiry, today string, now int64, marketOpen bool) bool {
	if expiry < today {
		return true
	}
	return expiry == today && !marketOpen && ISTMinutesOfDay(now) >= ISTCloseMinutes
}

// DayPnl is SynthDayPnl.
type DayPnl struct {
	Day                    string  `json:"day"`
	OpenCount              int     `json:"open_count"`
	OpenMtmLtp             float64 `json:"open_mtm_ltp"`
	OpenUnmarkedCount      int     `json:"open_unmarked_count"`
	OpenRunningGrossPnl    float64 `json:"open_running_gross_pnl"`
	OpenRunningNetPnl      float64 `json:"open_running_net_pnl"`
	OpenUnpricedCount      int     `json:"open_unpriced_count"`
	ClosedCount            int     `json:"closed_count"`
	ClosedRealisedGrossPnl float64 `json:"closed_realised_gross_pnl"`
	ClosedCharges          float64 `json:"closed_charges"`
	ClosedRealisedNetPnl   float64 `json:"closed_realised_net_pnl"`
	TotalNetPnl            float64 `json:"total_net_pnl"`
	TotalGrossPnl          float64 `json:"total_gross_pnl"`
	OpenMargin             float64 `json:"open_margin"`
	OpenMarginUnknown      int     `json:"open_margin_unknown"`
	ClosedMargin           float64 `json:"closed_margin"`
	ClosedMarginUnknown    int     `json:"closed_margin_unknown"`
}

// OpenMark is one open position's live figures for the day P&L.
type OpenMark struct {
	MtmLtp   *float64 `json:"mtm_ltp"`
	GrossPnl *float64 `json:"gross_pnl"`
	NetPnl   *float64 `json:"net_pnl"`
	Margin   *float64 `json:"margin"`
}

// ComputeDayPnl is computeSynthDayPnl.
func ComputeDayPnl(day string, open []OpenMark, closedToday []*Trade) DayPnl {
	var mtm, openGross, openNet, openMargin float64
	var unmarked, unpriced, openMarginUnknown int
	for _, o := range open {
		if o.Margin == nil {
			openMarginUnknown++
		} else {
			openMargin += *o.Margin
		}
		if o.MtmLtp == nil {
			unmarked++
		} else {
			mtm += *o.MtmLtp
		}
		if o.GrossPnl == nil || o.NetPnl == nil {
			unpriced++
		} else {
			openGross += *o.GrossPnl
			openNet += *o.NetPnl
		}
	}
	var gross, charges, net, closedMargin float64
	closedMarginUnknown := 0
	for _, t := range closedToday {
		gross += deref(t.GrossPnl)
		charges += deref(t.TotalCharges)
		net += deref(t.NetPnl)
		if t.Margin == nil {
			closedMarginUnknown++
		} else {
			closedMargin += *t.Margin
		}
	}
	return DayPnl{
		Day:                    day,
		OpenCount:              len(open),
		OpenMtmLtp:             round2(mtm),
		OpenUnmarkedCount:      unmarked,
		OpenRunningGrossPnl:    round2(openGross),
		OpenRunningNetPnl:      round2(openNet),
		OpenUnpricedCount:      unpriced,
		ClosedCount:            len(closedToday),
		ClosedRealisedGrossPnl: round2(gross),
		ClosedCharges:          round2(charges),
		ClosedRealisedNetPnl:   round2(net),
		TotalNetPnl:            round2(openNet + net),
		TotalGrossPnl:          round2(openGross + gross),
		OpenMargin:             jsx.Round(openMargin),
		OpenMarginUnknown:      openMarginUnknown,
		ClosedMargin:           jsx.Round(closedMargin),
		ClosedMarginUnknown:    closedMarginUnknown,
	}
}

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// MarginOrders is synthMarginOrders: the basket-margin orders for a trade's three
// ENTRY legs, sent in one request so the broker recognises the hedge.
func MarginOrders(t *Trade) []market.MarginOrder {
	out := make([]market.MarginOrder, 0, len(t.Legs))
	for _, l := range t.Legs {
		price := round2(l.EntryPrice)
		out = append(out, market.MarginOrder{
			Exchange: "NFO", Tradingsymbol: l.Tradingsymbol, TransactionType: string(l.Side),
			Variety: "regular", Product: "NRML", OrderType: "LIMIT", Quantity: t.Quantity,
			Price: price, ReferencePrice: fptr(price),
		})
	}
	return out
}

// legKey identifies a leg's contract independent of any broker's token namespace.
func legKey(underlying, expiry, typ string, strike float64) string {
	if typ == "FUT" {
		strike = 0
	}
	return strings.Join([]string{underlying, expiry, typ, jsNumberString(strike)}, "|")
}
