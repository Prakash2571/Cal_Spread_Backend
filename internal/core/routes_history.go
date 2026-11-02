package core

import (
	"context"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	fjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	kjson "github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
)

// Cache lifetimes of the short-lived chart routes.
const (
	MinuteTTL  = 60 * time.Second // GET /api/minute/:symbol
	FiveMinTTL = 5 * time.Minute  // GET /api/fivemin/:symbol
	// spreadHistoryGap is the pause between the per-future daily-candle calls of
	// GET /api/spread-history (index.ts delay(200)).
	spreadHistoryGap = 200 * time.Millisecond
)

// historyWhat is the requireMarketData label of every history route.
const historyWhat = "Historical data"

var errNoHistory = errors.New("history provider is not configured")

var (
	negInf = math.Inf(-1)
	posInf = math.Inf(1)
)

func (c *Core) historicalOi(ctx context.Context, token int64, from, to string) ([]kite.DayOI, error) {
	if c.d.HistoricalOi == nil {
		return nil, errNoHistory
	}
	return c.d.HistoricalOi(ctx, token, from, to)
}

func (c *Core) historical(ctx context.Context, token int64, from, to, interval string) ([]kite.ClosePoint, error) {
	if c.d.Historical == nil {
		return nil, errNoHistory
	}
	return c.d.Historical(ctx, token, from, to, interval)
}

// isoDay is d.toISOString().slice(0, 10).
func isoDay(t time.Time) string { return t.UTC().Format("2006-01-02") }

// shiftLocal is index.ts's local-time Date arithmetic: setFullYear(getFullYear() + years),
// setMonth(getMonth() + months) or setDate(getDate() + days) on a copy of t, in the
// process time zone. Overflow normalises the way JavaScript's MakeDay does (31 May minus
// three months is 3 March), which time.Date also does.
func (c *Core) shiftLocal(t time.Time, years, months, days int) time.Time {
	l := t.In(c.loc)
	return time.Date(l.Year()+years, l.Month()+time.Month(months), l.Day()+days,
		l.Hour(), l.Minute(), l.Second(), l.Nanosecond(), c.loc)
}

// symbolParam reads and upper-cases :symbol; ok=false means the 400 page was sent.
func symbolParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	param, raw, ok := pathParam(r, "symbol")
	if !ok {
		badParam(w, raw)
		return "", false
	}
	return strings.ToUpper(param), true
}

// boardItem is deriveFnoBoard(all).find(b => b.symbol.toUpperCase() === symbol). ok=false
// means a response (404 or an error) was sent.
func (c *Core) boardItem(ctx context.Context, w http.ResponseWriter, symbol string) (BoardItem, bool) {
	board, err := c.Board(ctx)
	if err != nil {
		c.SendError(w, err)
		return BoardItem{}, false
	}
	for _, b := range board {
		if strings.ToUpper(b.Symbol) == symbol {
			return b, true
		}
	}
	httpx.Error(w, http.StatusNotFound, `No F&O instrument found for "`+symbol+`".`)
	return BoardItem{}, false
}

func (c *Core) dayCached(cache map[string]dayEntry, symbol, today string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := cache[symbol]
	if ok && e.day == today {
		return e.body, true
	}
	return nil, false
}

func (c *Core) timedCached(cache map[string]timedEntry, symbol string, ttl time.Duration) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := cache[symbol]
	if ok && c.now().UnixMilli()-e.at < ttl.Milliseconds() {
		return e.body, true
	}
	return nil, false
}

func (c *Core) storeDay(cache map[string]dayEntry, symbol, day string, body []byte) {
	c.mu.Lock()
	cache[symbol] = dayEntry{day: day, body: body}
	c.mu.Unlock()
}

func (c *Core) storeTimed(cache map[string]timedEntry, symbol string, body []byte) {
	c.mu.Lock()
	cache[symbol] = timedEntry{at: c.now().UnixMilli(), body: body}
	c.mu.Unlock()
}

type oiPoint struct {
	Date  string  `json:"date"`
	OI    float64 `json:"oi"`
	Close float64 `json:"close"`
}

type oiFuture struct {
	Token  int64     `json:"token"`
	Expiry string    `json:"expiry"`
	Points []oiPoint `json:"points"`
}

type oiHistoryBody struct {
	Symbol  string     `json:"symbol"`
	Name    string     `json:"name"`
	IsIndex bool       `json:"is_index"`
	Futures []oiFuture `json:"futures"`
}

// GET /api/history/:symbol (index.ts:1733): three months of daily close + OI per board
// future, cached per symbol (not per broker) for the IST day. The market-data check runs
// before the cache.
func (c *Core) historyRoute(w http.ResponseWriter, r *http.Request) {
	// Express decodes :symbol while matching the route, before the handler runs.
	symbol, ok := symbolParam(w, r)
	if !ok || !c.RequireMarketData(w, historyWhat) {
		return
	}
	today := jsx.IstDayKey(c.now())
	if body, hit := c.dayCached(c.history, symbol, today); hit {
		httpx.RawJSON(w, http.StatusOK, body)
		return
	}
	ctx, done := c.work(r)
	defer done()
	item, ok := c.boardItem(ctx, w, symbol)
	if !ok {
		return
	}
	now := c.now()
	from, to := isoDay(c.shiftLocal(now, 0, -3, 0)), isoDay(now)
	futures := []oiFuture{}
	for _, f := range item.Futures {
		candles, err := c.historicalOi(ctx, f.Token, from, to)
		if err != nil {
			c.SendError(w, err)
			return
		}
		points := make([]oiPoint, len(candles))
		for i, k := range candles {
			points[i] = oiPoint{Date: k.Date, OI: k.OI, Close: k.Close}
		}
		futures = append(futures, oiFuture{Token: f.Token, Expiry: f.Expiry, Points: points})
	}
	body := fjson.Marshal(oiHistoryBody{item.Symbol, item.Name, item.IsIndex, futures})
	c.storeDay(c.history, symbol, today, body)
	httpx.RawJSON(w, http.StatusOK, body)
}

type spreadPoint struct {
	Date   string  `json:"date"`
	Spread float64 `json:"spread"`
}

type dataRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type spreadStats struct {
	Mean  float64 `json:"mean"`
	Max   float64 `json:"max"`
	Min   float64 `json:"min"`
	Count int     `json:"count"`
}

type spreadHistoryBody struct {
	Symbol    string        `json:"symbol"`
	Name      string        `json:"name"`
	IsIndex   bool          `json:"is_index"`
	DataRange dataRange     `json:"dataRange"`
	Points    []spreadPoint `json:"points"`
	Stats     spreadStats   `json:"stats"`
}

// orderedCloses is a Map<date, close>: insertion order kept, a repeated date updates the
// value in place.
type orderedCloses struct {
	keys []string
	vals map[string]float64
}

func (m *orderedCloses) set(k string, v float64) {
	if _, ok := m.vals[k]; !ok {
		m.keys = append(m.keys, k)
	}
	m.vals[k] = v
}

// SpreadSeries is the arithmetic of GET /api/spread-history: closes[i] is future i's daily
// candles (date = first 10 characters of the timestamp, a later candle of the same date
// replacing an earlier one); for each consecutive pair the spread next - current is taken
// on dates both have, the earlier pair winning a date; points are sorted by date and
// rounded to paise; stats are over the rounded points.
func SpreadSeries(closes [][]kite.ClosePoint, fromStr, toStr string) ([]spreadPoint, dataRange, spreadStats) {
	maps := make([]*orderedCloses, len(closes))
	for i, candles := range closes {
		m := &orderedCloses{vals: map[string]float64{}}
		for _, k := range candles {
			m.set(kjson.SliceUTF16(k.T, 10), k.Close)
		}
		maps[i] = m
	}
	spreads := &orderedCloses{vals: map[string]float64{}}
	for p := 0; p+1 < len(maps); p++ {
		cur, next := maps[p], maps[p+1]
		for _, date := range next.keys {
			curClose, ok := cur.vals[date]
			if _, taken := spreads.vals[date]; ok && !taken {
				spreads.set(date, next.vals[date]-curClose)
			}
		}
	}
	dates := append([]string(nil), spreads.keys...)
	sort.SliceStable(dates, func(a, b int) bool { return jsx.LocaleCompare(dates[a], dates[b]) < 0 })
	points := make([]spreadPoint, len(dates))
	for i, d := range dates {
		points[i] = spreadPoint{Date: d, Spread: jsx.Round(spreads.vals[d]*100) / 100}
	}

	sum := 0.0
	maxV, minV := negInf, posInf
	for _, pt := range points {
		sum += pt.Spread
		if pt.Spread > maxV {
			maxV = pt.Spread
		}
		if pt.Spread < minV {
			minV = pt.Spread
		}
	}
	count := len(points)
	mean := 0.0
	if count > 0 {
		mean = jsx.Round((sum/float64(count))*100) / 100
	} else {
		maxV, minV = 0, 0
	}
	rng := dataRange{From: fromStr, To: toStr}
	if count > 0 {
		rng = dataRange{From: points[0].Date, To: points[count-1].Date}
	}
	return points, rng, spreadStats{Mean: mean, Max: maxV, Min: minV, Count: count}
}

// GET /api/spread-history/:symbol (index.ts:1791): two years of the combined calendar
// spread (next - current close) with stats, cached per symbol for the IST day.
func (c *Core) spreadHistoryRoute(w http.ResponseWriter, r *http.Request) {
	// Express decodes :symbol while matching the route, before the handler runs.
	symbol, ok := symbolParam(w, r)
	if !ok || !c.RequireMarketData(w, historyWhat) {
		return
	}
	today := jsx.IstDayKey(c.now())
	if body, hit := c.dayCached(c.spreadHistory, symbol, today); hit {
		httpx.RawJSON(w, http.StatusOK, body)
		return
	}
	ctx, done := c.work(r)
	defer done()
	item, ok := c.boardItem(ctx, w, symbol)
	if !ok {
		return
	}
	now := c.now()
	fromStr, toStr := isoDay(c.shiftLocal(now, -2, 0, 0)), isoDay(now)
	closes := make([][]kite.ClosePoint, 0, len(item.Futures))
	for i, f := range item.Futures {
		if i > 0 {
			if err := c.sleep(ctx, spreadHistoryGap); err != nil {
				c.SendError(w, err)
				return
			}
		}
		candles, err := c.historical(ctx, f.Token, fromStr, toStr, "day")
		if err != nil {
			c.SendError(w, err)
			return
		}
		closes = append(closes, candles)
	}
	points, rng, stats := SpreadSeries(closes, fromStr, toStr)
	body := fjson.Marshal(spreadHistoryBody{item.Symbol, item.Name, item.IsIndex, rng, points, stats})
	c.storeDay(c.spreadHistory, symbol, today, body)
	httpx.RawJSON(w, http.StatusOK, body)
}

type closePoint struct {
	T     string  `json:"t"`
	Close float64 `json:"close"`
}

type closeFuture struct {
	Token  int64        `json:"token"`
	Expiry string       `json:"expiry"`
	Points []closePoint `json:"points"`
}

type closeSeriesBody struct {
	Symbol  string        `json:"symbol"`
	Name    string        `json:"name"`
	IsIndex bool          `json:"is_index"`
	Futures []closeFuture `json:"futures"`
}

// closeSeries fetches {t, close} candles for every board future of item.
func (c *Core) closeSeries(ctx context.Context, item BoardItem, from, to, interval string) ([]byte, error) {
	futures := []closeFuture{}
	for _, f := range item.Futures {
		candles, err := c.historical(ctx, f.Token, from, to, interval)
		if err != nil {
			return nil, err
		}
		points := make([]closePoint, len(candles))
		for i, k := range candles {
			points[i] = closePoint{T: k.T, Close: k.Close}
		}
		futures = append(futures, closeFuture{Token: f.Token, Expiry: f.Expiry, Points: points})
	}
	return fjson.Marshal(closeSeriesBody{item.Symbol, item.Name, item.IsIndex, futures}), nil
}

// GET /api/intraday/:symbol (index.ts:1889): a week of hourly closes, cached per symbol
// for the IST day.
func (c *Core) intradayRoute(w http.ResponseWriter, r *http.Request) {
	// Express decodes :symbol while matching the route, before the handler runs.
	symbol, ok := symbolParam(w, r)
	if !ok || !c.RequireMarketData(w, historyWhat) {
		return
	}
	today := jsx.IstDayKey(c.now())
	if body, hit := c.dayCached(c.intraday, symbol, today); hit {
		httpx.RawJSON(w, http.StatusOK, body)
		return
	}
	ctx, done := c.work(r)
	defer done()
	item, ok := c.boardItem(ctx, w, symbol)
	if !ok {
		return
	}
	now := c.now()
	body, err := c.closeSeries(ctx, item, isoDay(c.shiftLocal(now, 0, 0, -7)), isoDay(now), "60minute")
	if err != nil {
		c.SendError(w, err)
		return
	}
	c.storeDay(c.intraday, symbol, today, body)
	httpx.RawJSON(w, http.StatusOK, body)
}

// GET /api/minute/:symbol (index.ts:1950): the last two hours of minute closes (from/to
// as IST date-times), cached per symbol for 60 s from when the data arrived.
func (c *Core) minuteRoute(w http.ResponseWriter, r *http.Request) {
	// Express decodes :symbol while matching the route, before the handler runs.
	symbol, ok := symbolParam(w, r)
	if !ok || !c.RequireMarketData(w, historyWhat) {
		return
	}
	if body, hit := c.timedCached(c.minute, symbol, MinuteTTL); hit {
		httpx.RawJSON(w, http.StatusOK, body)
		return
	}
	ctx, done := c.work(r)
	defer done()
	item, ok := c.boardItem(ctx, w, symbol)
	if !ok {
		return
	}
	now := c.now()
	from := jsx.IstDateTime(jsx.FromMs(now.UnixMilli() - (2 * time.Hour).Milliseconds()))
	body, err := c.closeSeries(ctx, item, from, jsx.IstDateTime(now), "minute")
	if err != nil {
		c.SendError(w, err)
		return
	}
	c.storeTimed(c.minute, symbol, body)
	httpx.RawJSON(w, http.StatusOK, body)
}

// GET /api/fivemin/:symbol (index.ts:2007): today's 5-minute closes, cached per symbol
// for 5 minutes from when the data arrived.
func (c *Core) fiveMinRoute(w http.ResponseWriter, r *http.Request) {
	// Express decodes :symbol while matching the route, before the handler runs.
	symbol, ok := symbolParam(w, r)
	if !ok || !c.RequireMarketData(w, historyWhat) {
		return
	}
	if body, hit := c.timedCached(c.fiveMin, symbol, FiveMinTTL); hit {
		httpx.RawJSON(w, http.StatusOK, body)
		return
	}
	ctx, done := c.work(r)
	defer done()
	item, ok := c.boardItem(ctx, w, symbol)
	if !ok {
		return
	}
	today := jsx.IstDayKey(c.now())
	body, err := c.closeSeries(ctx, item, today, today, "5minute")
	if err != nil {
		c.SendError(w, err)
		return
	}
	c.storeTimed(c.fiveMin, symbol, body)
	httpx.RawJSON(w, http.StatusOK, body)
}
