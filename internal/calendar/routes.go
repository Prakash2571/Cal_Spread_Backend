package calendar

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kitejson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Response texts, exactly as index.ts sends them.
const (
	msgAdminRequired   = "Admin authentication required"
	msgNoPersistence   = "Trade persistence is not configured (set DATABASE_URL)."
	msgMarketClosed    = "Trades can only be taken during market hours (Mon–Fri, 9:15–15:40 IST)."
	msgNoSymbol        = "Provide a symbol."
	msgNeedTwoFutures  = "Need both current and next month futures to place a calendar spread."
	msgNoLivePrices    = "Could not fetch live prices for all legs right now. Try again shortly."
	msgNoTouch         = "No live bid/ask on one of the legs right now (illiquid or pre-open). Try again once both legs are quoted."
	msgInvalidID       = "Invalid trade id."
	msgNotFound        = "Trade not found."
	msgOnlyClosedTrade = "Only closed trades can be deleted."
)

// tradeResponse is {trade}.
type tradeResponse struct {
	Trade tradeJSON `json:"trade"`
}

// listResponse is {dbEnabled, trades}.
type listResponse struct {
	DBEnabled bool        `json:"dbEnabled"`
	Trades    []tradeJSON `json:"trades"`
}

// deleteResponse is {success, id}.
type deleteResponse struct {
	Success bool   `json:"success"`
	ID      string `json:"id"`
}

// requireAdmin lets any admin session through (full OR trade access); others get 403.
func (s *Service) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.d.Sessions == nil || s.d.Sessions.RoleOf(r) == auth.RoleNone {
			httpx.Error(w, http.StatusForbidden, msgAdminRequired)
			return
		}
		next(w, r)
	}
}

// sendError is index.ts sendError: a KiteError answers with its own status (a 401/403
// also clears the Kite session), anything else 500 with the error's message.
func (s *Service) sendError(w http.ResponseWriter, err error) {
	if ke, ok := kite.AsKiteError(err); ok {
		if kite.IsAuthFailure(err) {
			s.d.ClearKiteSession()
		}
		httpx.Error(w, ke.Status, ke.Message)
		return
	}
	httpx.Error(w, http.StatusInternalServerError, err.Error())
}

// marketData runs requireMarketData; false means the 401 was written.
func (s *Service) marketData(w http.ResponseWriter, what string) bool {
	ok, refusal := s.d.RequireMarketData(what)
	if ok {
		return true
	}
	if refusal.Problems == nil {
		refusal.Problems = []string{}
	}
	httpx.JSON(w, http.StatusUnauthorized, refusal)
	return false
}

// work is the context a handler does its work in: the request's values without its
// cancellation, because Node finished a request (Kite calls, the insert, the ledger)
// even when the client went away.
func work(r *http.Request) context.Context { return context.WithoutCancel(r.Context()) }

func (s *Service) now() time.Time { return jsx.TruncMs(s.d.Now()) }

// pathParam is Express's decoded req.params value (decodeURIComponent). chi routes on the
// escaped path when the request has one (URL.RawPath), so its parameters are then still
// percent-encoded. A parameter that does not decode to UTF-8 fails the way
// decodeURIComponent does. (A malformed escape such as "%A/" never gets here: net/http
// rejects the request line with its own 400.)
func pathParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	raw := chi.URLParam(r, name)
	v := raw
	if r.URL.RawPath != "" {
		var err error
		if v, err = url.PathUnescape(raw); err != nil {
			httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
			return "", false
		}
	} else {
		raw = url.PathEscape(raw)
	}
	if !utf8.ValidString(v) {
		httpx.HTMLError(w, http.StatusBadRequest, "URIError: Failed to decode param '"+raw+"'")
		return "", false
	}
	return v, true
}

type idKey struct{}

// withID decodes the :id parameter before anything else runs: Express decodes route
// parameters while matching the route, so a malformed escape fails with its 400 page
// before requireAdmin.
func withID(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathParam(w, r, "id")
		if !ok {
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), idKey{}, id)))
	}
}

// idParam is the decoded :id (String(req.params.id)).
func idParam(r *http.Request) string {
	id, _ := r.Context().Value(idKey{}).(string)
	return id
}

// bodySymbol is String(req.body?.symbol ?? "").trim().toUpperCase().
func bodySymbol(r *http.Request) string {
	raw := httpx.RawBody(r)
	if raw == nil {
		return ""
	}
	root, err := kitejson.Parse(string(raw))
	if err != nil {
		return ""
	}
	v := root.Get("symbol")
	if v.Nullish() {
		return ""
	}
	return jsUpper(kitejson.TrimJS(kitejson.ToString(v)))
}

// jsUpper is String.prototype.toUpperCase for symbols: Unicode upper-casing plus the
// Latin special casings that expand to several letters.
func jsUpper(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToUpper(s)
	}
	var b strings.Builder
	for _, r := range s {
		switch r {
		case 'ß':
			b.WriteString("SS")
		case 'ŉ':
			b.WriteString("ʼN")
		case 'ﬀ':
			b.WriteString("FF")
		case 'ﬁ':
			b.WriteString("FI")
		case 'ﬂ':
			b.WriteString("FL")
		case 'ﬃ':
			b.WriteString("FFI")
		case 'ﬄ':
			b.WriteString("FFL")
		case 'ﬅ', 'ﬆ':
			b.WriteString("ST")
		default:
			b.WriteString(strings.ToUpper(string(r)))
		}
	}
	return b.String()
}

// lookupTrade validates the path id (isValidId) and loads the trade (findById).
// ok=false means the response (400 or an error) was written; a nil trade means "not
// found".
func (s *Service) lookupTrade(ctx context.Context, w http.ResponseWriter, r *http.Request) (id string, t *Trade, ok bool) {
	id = idParam(r)
	kind, canon := db.CheckID(id)
	if kind != db.IDValid {
		httpx.Error(w, http.StatusBadRequest, msgInvalidID)
		return "", nil, false
	}
	t, err := s.store.get(ctx, canon)
	if err != nil {
		s.sendError(w, err)
		return "", nil, false
	}
	return id, t, true
}

// ---------------------------------------------------------------------------------------
// POST /api/trades: buy the discount leg, sell the premium leg (current + next month).

func (s *Service) takeTrade(w http.ResponseWriter, r *http.Request) {
	if !s.store.enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, msgNoPersistence)
		return
	}
	// Calendar entry prices from the ACTIVE broker's feed/quotes.
	if !s.marketData(w, "Taking a trade") {
		return
	}
	if !jsx.IsMarketOpen(s.d.Now()) {
		httpx.Error(w, http.StatusBadRequest, msgMarketClosed)
		return
	}
	symbol := bodySymbol(r)
	if symbol == "" {
		httpx.Error(w, http.StatusBadRequest, msgNoSymbol)
		return
	}
	if err := s.take(work(r), w, symbol); err != nil {
		s.sendError(w, err)
	}
}

// take is the body of the take-trade handler's try block: a returned error goes to
// sendError, everything else writes its own response.
func (s *Service) take(ctx context.Context, w http.ResponseWriter, symbol string) error {
	all, err := s.d.Instruments(ctx)
	if err != nil {
		return err
	}
	var item *BoardItem
	board := s.d.Board(all)
	for i := range board {
		if jsUpper(board[i].Symbol) == symbol {
			item = &board[i]
			break
		}
	}
	if item == nil {
		httpx.Error(w, http.StatusNotFound, `No F&O instrument found for "`+symbol+`".`)
		return nil
	}
	if len(item.Futures) < 2 {
		httpx.Error(w, http.StatusBadRequest, msgNeedTwoFutures)
		return nil
	}
	current, next := item.Futures[0], item.Futures[1]

	// Guard against an already-open trade on the same symbol (check, then insert).
	open, err := s.store.hasOpen(ctx, item.Symbol)
	if err != nil {
		return err
	}
	if open {
		httpx.Error(w, http.StatusConflict, "A trade for "+item.Symbol+" is already open.")
		return nil
	}

	// Live order book for spot + both legs (WebSocket first, REST fallback).
	ladders, err := s.resolveLadder(ctx, []int64{item.SpotToken, current.Token, next.Token})
	if err != nil {
		return err
	}
	spotL, hasSpot := ladders[item.SpotToken]
	curL, hasCur := ladders[current.Token]
	nextL, hasNext := ladders[next.Token]
	if !hasSpot || !truthy(spotL.last) || !hasCur || !hasNext || !truthy(curL.last) || !truthy(nextL.last) {
		httpx.Error(w, http.StatusBadGateway, msgNoLivePrices)
		return nil
	}
	spot := spotL.last

	// Premium over spot (last prices): buy the cheaper leg, sell the richer one; a tie
	// buys the current month.
	type tradeLeg struct {
		token  int64
		expiry string
		book   ladder
	}
	buyLeg, sellLeg := tradeLeg{current.Token, current.Expiry, curL}, tradeLeg{next.Token, next.Expiry, nextL}
	if !(curL.last-spot <= nextL.last-spot) {
		buyLeg, sellLeg = sellLeg, buyLeg
	}

	// Fills at the touch: the long leg pays the best ASK, the short leg receives the best
	// BID. No quote on the side to trade against means the trade is refused.
	buyEntry, okBuy := bestPrice(buyLeg.book.asks, "ask")
	sellEntry, okSell := bestPrice(sellLeg.book.bids, "bid")
	if !okBuy || !okSell {
		httpx.Error(w, http.StatusBadGateway, msgNoTouch)
		return nil
	}

	// tradingsymbol + exchange per token (the last duplicate wins, as in a Map).
	instByToken := make(map[int64]market.Instrument, len(all))
	for _, inst := range all {
		instByToken[inst.InstrumentToken] = inst
	}
	buyInst, okBuyInst := instByToken[buyLeg.token]
	sellInst, okSellInst := instByToken[sellLeg.token]
	bothInst := okBuyInst && okSellInst

	// Net basket margin for [BUY 1 lot, SELL 1 lot] (both at the CURRENT month's lot
	// size). Non-fatal: a failure records margin = null.
	var margin *float64
	if bothInst {
		res, err := s.d.Kite.GetBasketMargin(ctx, []kite.BasketOrder{
			{Exchange: buyInst.Exchange, Tradingsymbol: buyInst.Tradingsymbol, TransactionType: "BUY",
				Variety: "regular", Product: "NRML", OrderType: "MARKET", Quantity: current.LotSize, Price: 0},
			{Exchange: sellInst.Exchange, Tradingsymbol: sellInst.Tradingsymbol, TransactionType: "SELL",
				Variety: "regular", Product: "NRML", OrderType: "MARKET", Quantity: current.LotSize, Price: 0},
		}, true)
		if err != nil {
			s.d.Logf("Basket margin fetch failed: %v", err)
		} else {
			margin = f64(jsx.Round(res.Total))
		}
	}

	// Charges: the contract note for the entry fills plus the exit projected at those
	// fills, in one /charges/orders call.
	var entryLegs []ChargeLeg
	if bothInst {
		entryLegs = []ChargeLeg{
			{Side: "BUY", Token: buyLeg.token, Expiry: buyLeg.expiry, Tradingsymbol: buyInst.Tradingsymbol,
				Exchange: buyInst.Exchange, Quantity: current.LotSize, Price: buyEntry},
			{Side: "SELL", Token: sellLeg.token, Expiry: sellLeg.expiry, Tradingsymbol: sellInst.Tradingsymbol,
				Exchange: sellInst.Exchange, Quantity: current.LotSize, Price: sellEntry},
		}
	}
	var entryCharges, estExitCharges *TradeCharges
	entryLogLegs := unpricedLogLegs(entryLegs)
	if len(entryLegs) > 0 {
		if priced := s.priceChargeGroups(ctx, []chargeGroup{
			{legs: entryLegs, source: "kite"},
			{legs: reverseLegs(entryLegs), source: "kite_estimate"},
		}); priced != nil {
			entryCharges = priced[0].charges
			entryLogLegs = priced[0].logLegs
			estExitCharges = priced[1].charges
		}
	}

	// Contract value from the fills, recorded even when the charges could not be priced.
	entryValue := round2(current.LotSize * (buyEntry + sellEntry))
	openedAt := s.now()

	t := &Trade{
		ID:             s.d.NewID(),
		Symbol:         item.Symbol,
		Name:           item.Name,
		IsIndex:        item.IsIndex,
		LotSize:        current.LotSize,
		Buy:            Leg{Token: buyLeg.token, Expiry: buyLeg.expiry, Entry: buyEntry},
		Sell:           Leg{Token: sellLeg.token, Expiry: sellLeg.expiry, Entry: sellEntry},
		Status:         "open",
		OpenedAt:       openedAt,
		Margin:         margin,
		EntryCharges:   entryCharges,
		EstExitCharges: estExitCharges,
		EntryValue:     f64(entryValue),
	}
	if err := s.store.insert(ctx, t); err != nil {
		return err
	}

	source := "unpriced"
	if entryCharges != nil {
		source = "kite"
	}
	s.appendLog(LedgerEntry{
		TradeID: t.ID, Symbol: t.Symbol, Name: t.Name, IsIndex: t.IsIndex, LotSize: t.LotSize,
		Event: "entry", At: JSTime(openedAt), Legs: entryLogLegs, Value: entryValue,
		Charges: chargeTotals(entryCharges), Source: source, Margin: margin,
	})
	httpx.JSON(w, http.StatusOK, tradeResponse{Trade: serializeTrade(t)})
	return nil
}

// appendLog appends one event to the charges ledger after the response (best effort: a
// failure is logged and swallowed, the trade stands). Ledger ids are never exposed.
func (s *Service) appendLog(e LedgerEntry) {
	if !s.store.enabled() {
		return
	}
	id := db.NewIDAt(s.d.Now())
	s.background(func() {
		ctx, cancel := context.WithTimeout(context.Background(), ledgerTimeout)
		defer cancel()
		if err := s.store.appendLog(ctx, id, &e); err != nil {
			s.d.Logf("[TradeLog] failed to append %s event: %v", e.Event, err)
		}
	})
}

// ---------------------------------------------------------------------------------------
// GET /api/trades: all trades (open + closed), newest first, at most 200.

func (s *Service) listTrades(w http.ResponseWriter, r *http.Request) {
	if !s.store.enabled() {
		httpx.JSON(w, http.StatusOK, listResponse{DBEnabled: false, Trades: []tradeJSON{}})
		return
	}
	trades, err := s.store.list(work(r), 200)
	if err != nil {
		s.sendError(w, err)
		return
	}
	out := make([]tradeJSON, len(trades))
	for i, t := range trades {
		out[i] = serializeTrade(t)
	}
	httpx.JSON(w, http.StatusOK, listResponse{DBEnabled: true, Trades: out})
}

// ---------------------------------------------------------------------------------------
// POST /api/trades/:id/close: lock in the final P&L at the touch.

func (s *Service) closeTrade(w http.ResponseWriter, r *http.Request) {
	if !s.store.enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, msgNoPersistence)
		return
	}
	ctx := work(r)
	_, t, ok := s.lookupTrade(ctx, w, r)
	if !ok {
		return
	}
	if t == nil {
		httpx.Error(w, http.StatusNotFound, msgNotFound)
		return
	}
	if t.Status == "closed" {
		httpx.JSON(w, http.StatusOK, tradeResponse{Trade: serializeTrade(t)})
		return
	}
	if !s.marketData(w, "Closing a trade") {
		return
	}
	if err := s.close(ctx, w, t); err != nil {
		s.sendError(w, err)
	}
}

func (s *Service) close(ctx context.Context, w http.ResponseWriter, t *Trade) error {
	// Exit at the touch, the mirror of the entry: the long leg is sold into the best BID,
	// the short leg bought back at the best ASK.
	ladders, err := s.resolveLadder(ctx, []int64{t.Buy.Token, t.Sell.Token})
	if err != nil {
		return err
	}
	buyL, hasBuy := ladders[t.Buy.Token]
	sellL, hasSell := ladders[t.Sell.Token]
	var exitBid, exitAsk float64
	okBid, okAsk := false, false
	if hasBuy {
		exitBid, okBid = bestPrice(buyL.bids, "bid")
	}
	if hasSell {
		exitAsk, okAsk = bestPrice(sellL.asks, "ask")
	}
	// A close cannot be refused (that would trap the position): fall back to the last
	// traded price, then to the entry (a flat leg), and say so.
	if !okBid || !okAsk {
		s.d.Logf("[Trade %s] closing %s without a full bid/ask: falling back to last traded price — exit slippage is approximate.",
			t.ID, t.Symbol)
	}
	curBuy := t.Buy.Entry
	switch {
	case okBid:
		curBuy = exitBid
	case hasBuy:
		curBuy = buyL.last
	}
	curSell := t.Sell.Entry
	switch {
	case okAsk:
		curSell = exitAsk
	case hasSell:
		curSell = sellL.last
	}

	// GROSS P&L: the price move only; charges are reported separately.
	pnl := t.LotSize * ((curBuy - t.Buy.Entry) + (t.Sell.Entry - curSell))

	// The instrument lookup only names the legs for the charges call, so its failure must
	// not block the close: skip the real exit charges and use the entry-fill projection.
	var longInst, shortInst market.Instrument
	haveInsts := false
	if all, err := s.d.Instruments(ctx); err != nil {
		s.d.Logf("[Charges] instrument lookup for exit legs failed; closing with the entry-fill charge estimate: %v", err)
	} else {
		byToken := make(map[int64]market.Instrument, len(all))
		for _, inst := range all {
			byToken[inst.InstrumentToken] = inst
		}
		var okLong, okShort bool
		longInst, okLong = byToken[t.Buy.Token]
		shortInst, okShort = byToken[t.Sell.Token]
		haveInsts = okLong && okShort
	}

	var exitLegs []ChargeLeg
	if haveInsts {
		exitLegs = []ChargeLeg{
			{Side: "SELL", Token: t.Buy.Token, Expiry: t.Buy.Expiry, Tradingsymbol: longInst.Tradingsymbol,
				Exchange: longInst.Exchange, Quantity: t.LotSize, Price: curBuy},
			{Side: "BUY", Token: t.Sell.Token, Expiry: t.Sell.Expiry, Tradingsymbol: shortInst.Tradingsymbol,
				Exchange: shortInst.Exchange, Quantity: t.LotSize, Price: curSell},
		}
	}
	exitLogLegs := unpricedLogLegs(exitLegs)
	var exitCharges *TradeCharges
	if len(exitLegs) > 0 {
		if priced := s.priceChargeGroups(ctx, []chargeGroup{{legs: exitLegs, source: "kite"}}); priced != nil {
			exitCharges = priced[0].charges
			exitLogLegs = priced[0].logLegs
		}
	}

	// Legacy trades taken before charges were tracked: price the stored entry fills now
	// (an estimate, so source "kite_estimate") so the close still nets.
	entryChargesFinal := t.EntryCharges
	if entryChargesFinal == nil && haveInsts {
		if priced := s.priceChargeGroups(ctx, []chargeGroup{{legs: []ChargeLeg{
			{Side: "BUY", Token: t.Buy.Token, Expiry: t.Buy.Expiry, Tradingsymbol: longInst.Tradingsymbol,
				Exchange: longInst.Exchange, Quantity: t.LotSize, Price: t.Buy.Entry},
			{Side: "SELL", Token: t.Sell.Token, Expiry: t.Sell.Expiry, Tradingsymbol: shortInst.Tradingsymbol,
				Exchange: shortInst.Exchange, Quantity: t.LotSize, Price: t.Sell.Entry},
		}, source: "kite_estimate"}}); priced != nil {
			entryChargesFinal = priced[0].charges
		}
	}

	// If Kite could not price the exit, fall back to the projection taken at entry.
	exitChargesFinal := exitCharges
	if exitChargesFinal == nil {
		exitChargesFinal = t.EstExitCharges
	}
	var totalCharges *float64
	if entryChargesFinal != nil && exitChargesFinal != nil {
		totalCharges = f64(round2(entryChargesFinal.Total + exitChargesFinal.Total))
	}
	closedAt := s.now()
	grossPnl := round2(pnl)
	// Net off the ROUNDED gross so net == gross - total_charges to the paisa.
	var netPnl *float64
	if totalCharges != nil {
		netPnl = f64(round2(grossPnl - *totalCharges))
	}

	setEntryCharges := t.EntryCharges == nil && entryChargesFinal != nil
	setEntryValue := t.EntryValue == nil
	t.Status = "closed"
	t.ClosedAt = &closedAt
	t.ClosePnl = f64(grossPnl)
	t.BuyClose = f64(curBuy)
	t.SellClose = f64(curSell)
	if setEntryCharges {
		t.EntryCharges = entryChargesFinal
	}
	if setEntryValue {
		t.EntryValue = f64(round2(t.LotSize * (t.Buy.Entry + t.Sell.Entry)))
	}
	t.ExitCharges = exitChargesFinal
	t.ExitValue = nil
	if len(exitLegs) > 0 {
		t.ExitValue = f64(round2(t.LotSize * (curBuy + curSell)))
	}
	t.TotalCharges = totalCharges
	t.NetPnl = netPnl
	if err := s.store.saveClose(ctx, t, setEntryCharges, setEntryValue); err != nil {
		return err
	}

	source := "unpriced"
	switch {
	case exitCharges != nil:
		source = "kite"
	case exitChargesFinal != nil:
		source = "kite_estimate"
	}
	value := 0.0
	if t.ExitValue != nil {
		value = *t.ExitValue
	}
	s.appendLog(LedgerEntry{
		TradeID: t.ID, Symbol: t.Symbol, Name: t.Name, IsIndex: t.IsIndex, LotSize: t.LotSize,
		Event: "exit", At: JSTime(closedAt), Legs: exitLogLegs, Value: value,
		Charges: chargeTotals(exitChargesFinal), Source: source, Margin: t.Margin,
		GrossPnl: f64(grossPnl), TotalCharges: totalCharges, NetPnl: netPnl,
	})
	httpx.JSON(w, http.StatusOK, tradeResponse{Trade: serializeTrade(t)})
	return nil
}

// ---------------------------------------------------------------------------------------
// DELETE /api/trades/:id: remove a CLOSED trade from history (its ledger rows stay).

func (s *Service) deleteTrade(w http.ResponseWriter, r *http.Request) {
	if !s.store.enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, msgNoPersistence)
		return
	}
	ctx := work(r)
	id, t, ok := s.lookupTrade(ctx, w, r)
	if !ok {
		return
	}
	if t == nil {
		httpx.Error(w, http.StatusNotFound, msgNotFound)
		return
	}
	if t.Status != "closed" {
		httpx.Error(w, http.StatusBadRequest, msgOnlyClosedTrade)
		return
	}
	if err := s.store.remove(ctx, t.ID); err != nil {
		s.sendError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, deleteResponse{Success: true, ID: id})
}
