package core

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	fjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// DividendTTL is how long GET /api/dividends serves its cached yields (24 h).
const DividendTTL = 24 * time.Hour

type dividendEntry struct {
	at     int64         // epoch ms the yields were stored
	yields *fjson.Object // symbol -> percent, in board order
}

// searchTerm is String(req.query.q ?? "").trim().toLowerCase().
func searchTerm(q map[string][]string) string {
	v, _ := queryString(q, "q")
	return strings.ToLower(kjson.TrimJS(v))
}

func matches(term string, fields ...string) bool {
	for _, f := range fields {
		if strings.Contains(strings.ToLower(f), term) {
			return true
		}
	}
	return false
}

// rowsJSON writes instrument rows the way Node sent them.
type rowsJSON struct {
	rows []WireRow
	lots []float64 // fno_lot_size per row; nil for plain rows
}

func (r rowsJSON) AppendJS(dst []byte) []byte {
	dst = append(dst, '[')
	for i := range r.rows {
		if i > 0 {
			dst = append(dst, ',')
		}
		var lot *float64
		if r.lots != nil {
			lot = &r.lots[i]
		}
		dst = appendRow(dst, r.rows[i], lot)
	}
	return append(dst, ']')
}

type listBody struct {
	Count       int      `json:"count"`
	Instruments rowsJSON `json:"instruments"`
}

// GET /api/instruments (index.ts:1505): the active broker's dump filtered by exchange
// (default "NSE"; present but empty = no filter), instrument type (default "EQ"; empty =
// no filter) and q (substring of the trading symbol or name).
func (c *Core) instruments(w http.ResponseWriter, r *http.Request) {
	q := parseQuery(r.URL.RawQuery)
	exchange, ok := queryString(q, "exchange")
	if !ok {
		exchange = "NSE"
	}
	typ, ok := queryString(q, "type")
	if !ok {
		typ = "EQ"
	}
	term := searchTerm(q)

	ctx, done := c.work(r)
	defer done()
	all, err := c.wireInstruments(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	data := make([]WireRow, 0, len(all))
	for i := range all {
		in := &all[i].Instrument
		if exchange != "" && in.Exchange != exchange {
			continue
		}
		if typ != "" && in.InstrumentType != typ {
			continue
		}
		if term != "" && !matches(term, in.Tradingsymbol, in.Name) {
			continue
		}
		data = append(data, all[i])
	}
	httpx.JSON(w, http.StatusOK, listBody{len(data), rowsJSON{rows: data}})
}

// GET /api/fno-stocks (index.ts:1537): NSE equities that have NFO stock futures, each
// with its F&O lot size.
func (c *Core) fnoStocks(w http.ResponseWriter, r *http.Request) {
	term := searchTerm(parseQuery(r.URL.RawQuery))
	ctx, done := c.work(r)
	defer done()
	wire, err := c.wireInstruments(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	all := make([]market.Instrument, len(wire))
	for i := range wire {
		all[i] = wire[i].Instrument
	}
	rows := []WireRow{}
	lots := []float64{}
	for _, s := range DeriveFnoStocks(all) {
		if term != "" && !matches(term, s.Instrument.Tradingsymbol, s.Instrument.Name) {
			continue
		}
		rows = append(rows, wire[s.Row])
		lots = append(lots, s.FnoLotSize)
	}
	httpx.JSON(w, http.StatusOK, listBody{len(rows), rowsJSON{rows: rows, lots: lots}})
}

type fnoStockSpot struct {
	InstrumentToken int64  `json:"instrument_token"`
	Tradingsymbol   string `json:"tradingsymbol"`
	Name            string `json:"name"`
}

type fnoStockFuture struct {
	InstrumentToken int64   `json:"instrument_token"`
	Tradingsymbol   string  `json:"tradingsymbol"`
	Expiry          string  `json:"expiry"`
	LotSize         float64 `json:"lot_size"`
}

type fnoStockBody struct {
	Symbol  string           `json:"symbol"`
	Spot    fnoStockSpot     `json:"spot"`
	Futures []fnoStockFuture `json:"futures"`
}

// GET /api/fno-stocks/:symbol (index.ts:1559): the NSE equity and its three nearest
// NFO futures.
func (c *Core) fnoStock(w http.ResponseWriter, r *http.Request) {
	param, raw, ok := pathParam(r, "symbol")
	if !ok {
		badParam(w, raw)
		return
	}
	symbol := strings.ToUpper(param)
	ctx, done := c.work(r)
	defer done()
	all, err := c.AllInstruments(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	spot := -1
	for i := range all { // Array.find: the first match
		if in := &all[i]; in.Exchange == "NSE" && in.InstrumentType == "EQ" && in.Tradingsymbol == symbol {
			spot = i
			break
		}
	}
	if spot < 0 {
		httpx.Error(w, http.StatusNotFound, `No NSE equity found for "`+symbol+`".`)
		return
	}
	var futs []int
	for i := range all {
		if in := &all[i]; in.Exchange == "NFO" && in.InstrumentType == "FUT" && in.Name == symbol {
			futs = append(futs, i)
		}
	}
	sort.SliceStable(futs, func(a, b int) bool { return jsx.LocaleCompare(all[futs[a]].Expiry, all[futs[b]].Expiry) < 0 })
	if len(futs) > 3 {
		futs = futs[:3]
	}
	futures := make([]fnoStockFuture, len(futs))
	for k, i := range futs {
		f := &all[i]
		futures[k] = fnoStockFuture{f.InstrumentToken, f.Tradingsymbol, f.Expiry, f.LotSize}
	}
	s := &all[spot]
	httpx.JSON(w, http.StatusOK, fnoStockBody{
		Symbol:  symbol,
		Spot:    fnoStockSpot{s.InstrumentToken, s.Tradingsymbol, s.Name},
		Futures: futures,
	})
}

type dividendsBody struct {
	Yields   *fjson.Object `json:"yields"`
	CachedAt int64         `json:"cachedAt"`
}

// GET /api/dividends (index.ts:1627): Yahoo dividend yields for every non-index board
// symbol, cached for 24 h; failures are 0 %. The yields object lists the symbols in board
// order (Node's was in Yahoo completion order).
func (c *Core) dividendYields(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	cached := c.dividends
	c.mu.Unlock()
	if cached != nil && c.now().UnixMilli()-cached.at < DividendTTL.Milliseconds() {
		httpx.JSON(w, http.StatusOK, dividendsBody{cached.yields, cached.at})
		return
	}
	ctx, done := c.work(r)
	defer done()
	all, err := c.AllInstruments(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	var symbols []string
	for _, b := range DeriveFnoBoard(all) {
		if !b.IsIndex { // indices have no Yahoo dividend yield
			symbols = append(symbols, b.Symbol)
		}
	}
	yields := c.fetchYields(ctx, symbols)
	obj := fjson.NewObjectValue()
	for _, s := range symbols {
		if v, ok := yields[s]; ok {
			obj.Set(s, v)
		}
	}
	entry := &dividendEntry{at: c.now().UnixMilli(), yields: obj}
	if ctx.Err() == nil { // a fetch cut short by shutdown is not cached as zeros
		c.mu.Lock()
		c.dividends = entry
		c.mu.Unlock()
	}
	httpx.JSON(w, http.StatusOK, dividendsBody{entry.yields, entry.at})
}

func (c *Core) fetchYields(ctx context.Context, symbols []string) map[string]float64 {
	if c.d.DividendYields != nil {
		return c.d.DividendYields(ctx, symbols)
	}
	out := make(map[string]float64, len(symbols))
	for _, s := range symbols {
		if s != "" {
			out[s] = 0
		}
	}
	return out
}

type indexResolution struct {
	Underlying         string   `json:"underlying"`
	HasFutures         bool     `json:"hasFutures"`
	Candidates         []string `json:"candidates"`
	ZerodhaSpotSymbol  string   `json:"zerodhaSpotSymbol"`
	ResolvedSpotSymbol *string  `json:"resolvedSpotSymbol"`
	SpotFound          bool     `json:"spotFound"`
}

type indexBoardRow struct {
	Symbol  string `json:"symbol"`
	Name    string `json:"name"`
	Futures int    `json:"futures"`
}

type debugIndicesBody struct {
	TotalIndexInstruments     int               `json:"totalIndexInstruments"`
	SampleIndexTradingSymbols []string          `json:"sampleIndexTradingSymbols"`
	Resolved                  []indexResolution `json:"resolved"`
	IndexRowsInBoard          []indexBoardRow   `json:"indexRowsInBoard"`
	TotalBoardRows            int               `json:"totalBoardRows"`
}

// GET /api/debug/indices (index.ts:1646): how index underlyings are resolved to spots.
func (c *Core) debugIndices(w http.ResponseWriter, r *http.Request) {
	ctx, done := c.work(r)
	defer done()
	all, err := c.AllInstruments(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	var indexSymbols []string
	indexSet := map[string]bool{}
	futNames := map[string]bool{}
	for i := range all {
		in := &all[i]
		if in.Segment == "INDICES" {
			indexSymbols = append(indexSymbols, in.Tradingsymbol)
			indexSet[in.Tradingsymbol] = true
		}
		if in.Exchange == "NFO" && in.InstrumentType == "FUT" {
			futNames[in.Name] = true
		}
	}
	resolved := make([]indexResolution, len(IndexSpotMap))
	for k, e := range IndexSpotMap {
		res := indexResolution{
			Underlying: e.Underlying, HasFutures: futNames[e.Underlying],
			Candidates: IndexSpotCandidates(e.Underlying), ZerodhaSpotSymbol: e.Spot,
		}
		if m, ok := ResolveIndexSpotSymbol(e.Underlying, func(s string) bool { return indexSet[s] }); ok {
			res.ResolvedSpotSymbol, res.SpotFound = &m, true
		}
		resolved[k] = res
	}
	board := DeriveFnoBoard(all)
	rows := []indexBoardRow{}
	for _, b := range board {
		if b.IsIndex {
			rows = append(rows, indexBoardRow{b.Symbol, b.Name, len(b.Futures)})
		}
	}
	sample := indexSymbols
	if len(sample) > 25 {
		sample = sample[:25]
	}
	httpx.JSON(w, http.StatusOK, debugIndicesBody{
		TotalIndexInstruments:     len(indexSymbols),
		SampleIndexTradingSymbols: sample,
		Resolved:                  resolved,
		IndexRowsInBoard:          rows,
		TotalBoardRows:            len(board),
	})
}

type boardBody struct {
	Count int         `json:"count"`
	Board []BoardItem `json:"board"`
}

// GET /api/fno-board (index.ts:2055): the board, optionally filtered by q (substring of
// the symbol or name).
func (c *Core) fnoBoard(w http.ResponseWriter, r *http.Request) {
	term := searchTerm(parseQuery(r.URL.RawQuery))
	ctx, done := c.work(r)
	defer done()
	board, err := c.Board(ctx)
	if err != nil {
		c.SendError(w, err)
		return
	}
	if term != "" {
		kept := board[:0]
		for _, b := range board {
			if matches(term, b.Symbol, b.Name) {
				kept = append(kept, b)
			}
		}
		board = kept
	}
	if board == nil {
		board = []BoardItem{}
	}
	httpx.JSON(w, http.StatusOK, boardBody{len(board), board})
}

// GET /api/spread-stats/:symbol (index.ts:2384): the stored spread_summary row (with
// _id; Mongo's __v is not reproduced).
func (c *Core) spreadStats(w http.ResponseWriter, r *http.Request) {
	param, raw, ok := pathParam(r, "symbol")
	if !ok {
		badParam(w, raw)
		return
	}
	symbol := strings.ToUpper(param)
	ctx, done := c.work(r)
	defer done()
	var doc *captures.SpreadSummary
	var err error
	if c.d.SpreadSummary != nil {
		doc, err = c.d.SpreadSummary(ctx, symbol)
	} else {
		err = captures.ErrNoDatabase
	}
	if err != nil {
		c.SendError(w, err)
		return
	}
	if doc == nil {
		httpx.Error(w, http.StatusNotFound, `No spread summary found for "`+symbol+`".`)
		return
	}
	httpx.JSON(w, http.StatusOK, *doc)
}
