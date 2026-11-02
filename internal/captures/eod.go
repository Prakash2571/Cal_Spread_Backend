package captures

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Port of src/eodCapture.ts (Zerodha Kite only). Writes go through in-memory queues that
// are drained one row at a time with 50 ms spacing; a failed write stops the drain and
// leaves the row at the head for the next drain (which only happens on the next
// capture / backfill / spread computation, as in Node).

// SpreadArchiveCutoff is computeSpreads' CUTOFF: earlier dates read the archive rows.
const SpreadArchiveCutoff = "2026-01-01"

// EOD capture delays, as in eodCapture.ts.
const (
	eodDrainSpacing   = 50 * time.Millisecond
	eodHistoricalGap  = 300 * time.Millisecond
	eodErrorBackoff   = 500 * time.Millisecond
	eodSummarySpacing = 200 * time.Millisecond
)

// EOD is the stock-futures EOD job. Its queues and once-per-day markers are the
// module-level state of eodCapture.ts.
type EOD struct {
	store             eodStore
	kite              Kite
	getBoard          func(context.Context) ([]BoardItem, error)
	getAllInstruments func(context.Context) ([]market.Instrument, error)
	clock             Clock
	logf              func(string, ...any)

	mu                   sync.Mutex
	pendingStockFutures  []StockFuture
	pendingSpreadDaily   []SpreadDaily
	drainingStockFutures bool
	lastCapturedDay      string
	lastComputedDay      string

	// spreadDrain serialises drainSpreadDaily (Node had no guard and could write one row
	// twice and drop the next when two drains overlapped).
	spreadDrain sync.Mutex

	// afterDrain, when set (tests), runs when drainStockFutures has emptied the queue and
	// ended.
	afterDrain func()
}

// NewEOD builds the job over store with the collaborators in d.
func NewEOD(store *Store, d Deps) *EOD {
	d.defaults()
	return &EOD{
		store: store, kite: d.Kite, getBoard: d.GetBoard, getAllInstruments: d.GetAllInstruments,
		clock: d.Clock, logf: d.Logf,
	}
}

// PendingStockFutures and PendingSpreadDaily report the queue lengths.
func (e *EOD) PendingStockFutures() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.pendingStockFutures)
}

// PendingSpreadDaily reports the spread_daily queue length.
func (e *EOD) PendingSpreadDaily() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.pendingSpreadDaily)
}

// getWeekdaysBetween lists the weekdays after startDate up to endDate (both YYYY-MM-DD).
func getWeekdaysBetween(startDate, endDate string) []string {
	days := []string{}
	cur, ok1 := parseJSDay(startDate)
	end, ok2 := parseJSDay(endDate)
	if !ok1 || !ok2 {
		return days // Invalid Date: the loop condition is false
	}
	cur = cur.AddDate(0, 0, 1)
	for !cur.After(end) {
		d := isoDay(cur)
		if isWeekday(d) {
			days = append(days, d)
		}
		cur = cur.AddDate(0, 0, 1)
	}
	return days
}

// nfoFutures maps instrument tokens to NFO FUT instruments (later rows win, like Map.set).
func nfoFutures(all []market.Instrument) map[int64]market.Instrument {
	m := map[int64]market.Instrument{}
	for _, inst := range all {
		if inst.Exchange == "NFO" && inst.InstrumentType == "FUT" {
			m[inst.InstrumentToken] = inst
		}
	}
	return m
}

// utcMidnight is new Date(day + "T00:00:00.000Z"); a bad string yields a cast error.
func utcMidnight(day, path string) (time.Time, error) {
	t, ok := parseJSDay(day)
	if !ok {
		return time.Time{}, fmt.Errorf(`Cast to date failed for value "Invalid Date" (type Date) at path "%s"`, path)
	}
	return t, nil
}

func (e *EOD) pushStockFuture(f StockFuture) {
	e.mu.Lock()
	e.pendingStockFutures = append(e.pendingStockFutures, f)
	e.mu.Unlock()
}

// drainStockFutures writes the queue head by head. A second concurrent call returns at
// once (Node's single-flight flag), leaving the running drain to pick up new rows; the
// drain that finds the queue empty clears the flag in the same critical section, as
// Node did with no await in between (see Hourly.DrainCacheToDB).
func (e *EOD) drainStockFutures(ctx context.Context) {
	e.mu.Lock()
	if e.drainingStockFutures {
		e.mu.Unlock()
		return
	}
	e.drainingStockFutures = true
	e.mu.Unlock()
	drained := 0
	defer func() {
		if drained > 0 {
			e.logf("[EODCapture] Drained %d stock_futures docs to DB.", drained)
		}
	}()
	release := func() {
		e.mu.Lock()
		e.drainingStockFutures = false
		e.mu.Unlock()
	}
	for {
		e.mu.Lock()
		if len(e.pendingStockFutures) == 0 {
			e.drainingStockFutures = false
			e.mu.Unlock()
			if e.afterDrain != nil {
				e.afterDrain()
			}
			return
		}
		doc := e.pendingStockFutures[0]
		e.mu.Unlock()
		if err := e.store.UpsertStockFuture(ctx, doc); err != nil {
			if ctx.Err() == nil {
				e.logf("[EODCapture] Failed to upsert stock_futures %s: %v", doc.Symbol, err)
			}
			release()
			return
		}
		e.mu.Lock()
		e.pendingStockFutures = e.pendingStockFutures[1:]
		e.mu.Unlock()
		drained++
		if e.clock.Sleep(ctx, eodDrainSpacing) != nil {
			release()
			return
		}
	}
}

// drainSpreadDaily writes the spread_daily queue; overlapping calls run one after another.
func (e *EOD) drainSpreadDaily(ctx context.Context) {
	e.spreadDrain.Lock()
	defer e.spreadDrain.Unlock()
	drained := 0
	defer func() {
		if drained > 0 {
			e.logf("[EODCapture] Drained %d spread_daily docs to DB.", drained)
		}
	}()
	for {
		e.mu.Lock()
		if len(e.pendingSpreadDaily) == 0 {
			e.mu.Unlock()
			return
		}
		doc := e.pendingSpreadDaily[0]
		e.mu.Unlock()
		if err := e.store.UpsertSpreadDaily(ctx, doc); err != nil {
			if ctx.Err() == nil {
				e.logf("[EODCapture] Failed to upsert spread_daily %s: %v", doc.Symbol, err)
			}
			return
		}
		e.mu.Lock()
		e.pendingSpreadDaily = e.pendingSpreadDaily[1:]
		e.mu.Unlock()
		drained++
		if e.clock.Sleep(ctx, eodDrainSpacing) != nil {
			return
		}
	}
}

// captureEodData is captureEodData: today's closing quotes of every board stock future
// into stock_futures, then today's spreads. Skips (no error) without a session, without
// a database, or on a weekend.
func (e *EOD) captureEodData(ctx context.Context) error {
	if !kiteHasSession(e.kite) {
		e.logf("[EODCapture] No Kite session available. Skipping EOD capture.")
		return nil
	}
	if !e.store.Ready() {
		e.logf("[EODCapture] nse_fno DB not connected. Skipping EOD capture.")
		return nil
	}
	today := jsx.IstDayKey(e.clock.Now())
	if !isWeekday(today) {
		e.logf("[EODCapture] Today is not a weekday. Skipping.")
		return nil
	}

	board, err := e.getBoard(ctx)
	if err != nil {
		return err
	}
	all, err := e.getAllInstruments(ctx)
	if err != nil {
		return err
	}
	tokenToInstrument := nfoFutures(all)

	// Map insertion order: first time a token is seen.
	var identifiers []string
	seen := map[int64]int{}
	for _, item := range board {
		if item.IsIndex {
			continue
		}
		for _, f := range item.Futures {
			inst, ok := tokenToInstrument[f.Token]
			if !ok {
				continue
			}
			id := "NFO:" + inst.Tradingsymbol
			if i, dup := seen[f.Token]; dup {
				identifiers[i] = id
			} else {
				seen[f.Token] = len(identifiers)
				identifiers = append(identifiers, id)
			}
		}
	}
	if len(identifiers) == 0 {
		e.logf("[EODCapture] No FNO identifiers found. Skipping.")
		return nil
	}

	quotes, err := e.kite.GetQuoteFullOhlc(ctx, identifiers)
	if err != nil {
		return err
	}
	quoteByToken := map[int64]kite.FullQuoteOhlc{}
	for _, q := range quotes {
		quoteByToken[q.InstrumentToken] = q
	}

	tradingDate, dateErr := utcMidnight(today, "trading_date")
	queued := 0
	for _, item := range board {
		if item.IsIndex {
			continue
		}
		for _, f := range item.Futures {
			q, ok := quoteByToken[f.Token]
			if !ok || q.Close == 0 {
				continue
			}
			expiry, expErr := utcMidnight(f.Expiry, "expiry")
			doc := StockFuture{
				TradingDate: tradingDate, Symbol: item.Symbol, Instrument: "FUTSTK", Expiry: expiry,
				Open: q.Open, High: q.High, Low: q.Low, Close: q.Close, SettlePrice: q.Close,
				OpenInterest: q.OI,
			}
			if dateErr != nil {
				doc.castErr = dateErr
			} else if expErr != nil {
				doc.castErr = expErr
			}
			e.pushStockFuture(doc)
			queued++
		}
	}

	e.logf("[EODCapture] Queued %d stock_futures docs for %s. Draining to DB...", queued, today)
	e.drainStockFutures(ctx)
	return e.ComputeSpreads(ctx, []string{today})
}

// BackfillStockFutures is backfillStockFutures: every weekday after the latest stored
// trading_date (current rows) up to yesterday (IST) is fetched as daily candles for the
// board's current stock futures, then the spreads of those days are computed.
func (e *EOD) BackfillStockFutures(ctx context.Context) error {
	if !kiteHasSession(e.kite) {
		e.logf("[EODCapture] No Kite session. Skipping backfill.")
		return nil
	}
	if !e.store.Ready() {
		e.logf("[EODCapture] nse_fno DB not connected. Skipping backfill.")
		return nil
	}

	latest, ok, err := e.store.LatestStockFutureDate(ctx)
	if err != nil {
		return err
	}
	if !ok {
		e.logf("[EODCapture] No existing stock_futures data. Backfill requires at least some seed data.")
		return nil
	}
	lastDateStr := isoDay(latest)
	yesterdayStr := jsx.IstDayKey(e.clock.Now().Add(-24 * time.Hour))

	missingDays := getWeekdaysBetween(lastDateStr, yesterdayStr)
	if len(missingDays) == 0 {
		e.logf("[EODCapture] Backfill: no missing days found.")
		return nil
	}
	e.logf("[EODCapture] Backfilling %d missing day(s): %s to %s.",
		len(missingDays), missingDays[0], missingDays[len(missingDays)-1])

	board, err := e.getBoard(ctx)
	if err != nil {
		return err
	}
	all, err := e.getAllInstruments(ctx)
	if err != nil {
		return err
	}
	tokenToInstrument := nfoFutures(all)

	fromDate, toDate := missingDays[0], missingDays[len(missingDays)-1]
	missingSet := map[string]bool{}
	for _, d := range missingDays {
		missingSet[d] = true
	}
	totalQueued := 0
	for _, item := range board {
		if item.IsIndex {
			continue
		}
		for _, f := range item.Futures {
			if _, ok := tokenToInstrument[f.Token]; !ok {
				continue
			}
			candles, err := e.kite.GetHistoricalFull(ctx, f.Token, fromDate, toDate, "day", kite.Background)
			if err == nil {
				if err := e.clock.Sleep(ctx, eodHistoricalGap); err != nil {
					return err
				}
				for _, c := range candles {
					if !missingSet[c.Date] || c.Close == 0 {
						continue
					}
					td, tdErr := utcMidnight(c.Date, "trading_date")
					expiry, expErr := utcMidnight(f.Expiry, "expiry")
					doc := StockFuture{
						TradingDate: td, Symbol: item.Symbol, Instrument: "FUTSTK", Expiry: expiry,
						Open: c.Open, High: c.High, Low: c.Low, Close: c.Close, SettlePrice: c.Close,
						OpenInterest: c.OI,
					}
					if tdErr != nil {
						doc.castErr = tdErr
					} else if expErr != nil {
						doc.castErr = expErr
					}
					e.pushStockFuture(doc)
					totalQueued++
				}
				continue
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			e.logf("[EODCapture] Backfill failed for %s token %d: %v", item.Symbol, f.Token, err)
			if err := e.clock.Sleep(ctx, eodErrorBackoff); err != nil {
				return err
			}
		}
	}

	e.logf("[EODCapture] Backfill queued %d stock_futures docs. Draining to DB...", totalQueued)
	e.drainStockFutures(ctx)
	e.logf("[EODCapture] Backfill drain complete.")
	return e.ComputeSpreads(ctx, missingDays)
}

// ComputeSpreads is computeSpreads: for each (symbol, trading_date) of dates, the two
// nearest expiries give spread = mid.close - near.close, queued into spread_daily.
// Dates before SpreadArchiveCutoff read the archive rows, the rest the current rows.
func (e *EOD) ComputeSpreads(ctx context.Context, dates []string) error {
	if !e.store.Ready() || len(dates) == 0 {
		return nil
	}
	var archiveDates, currentDates []time.Time
	for _, d := range dates {
		t, err := utcMidnight(d, "trading_date")
		if err != nil {
			return err
		}
		if d < SpreadArchiveCutoff {
			archiveDates = append(archiveDates, t)
		} else {
			currentDates = append(currentDates, t)
		}
	}

	var records []StockFuture
	if len(currentDates) > 0 {
		rows, err := e.store.StockFuturesOn(ctx, SourceCurrent, currentDates)
		if err != nil {
			return err
		}
		records = append(records, rows...)
	}
	// The archive holds data up to 2025-08-31; Sep-Dec 2025 return nothing by design.
	// (isArchiveDbEnabled is the same pool as the current rows, so the "archive not
	// connected" warning of Node cannot occur here.)
	if len(archiveDates) > 0 {
		rows, err := e.store.StockFuturesOn(ctx, SourceArchive, archiveDates)
		if err != nil {
			return err
		}
		records = append(records, rows...)
	}

	// Group by `${symbol}_${ISO date}` in first-seen order.
	var keys []string
	groups := map[string][]StockFuture{}
	for _, r := range records {
		key := r.Symbol + "_" + isoDay(r.TradingDate)
		if _, ok := groups[key]; !ok {
			keys = append(keys, key)
		}
		groups[key] = append(groups[key], r)
	}

	queued := 0
	for _, key := range keys {
		contracts := groups[key]
		if len(contracts) < 2 {
			continue
		}
		sort.SliceStable(contracts, func(i, j int) bool {
			return contracts[i].Expiry.UnixMilli() < contracts[j].Expiry.UnixMilli()
		})
		near, mid := contracts[0], contracts[1]
		if near.Close == 0 || mid.Close == 0 {
			continue
		}
		doc := SpreadDaily{
			Symbol: near.Symbol, TradingDate: near.TradingDate, NearExpiry: near.Expiry, MidExpiry: mid.Expiry,
			NearClose: near.Close, MidClose: mid.Close, Spread: mid.Close - near.Close,
		}
		e.mu.Lock()
		e.pendingSpreadDaily = append(e.pendingSpreadDaily, doc)
		e.mu.Unlock()
		queued++
	}

	e.logf("[EODCapture] Queued %d spread_daily docs. Draining to DB...", queued)
	e.drainSpreadDaily(ctx)
	return nil
}

// round4 is Math.round(x * 10000) / 10000.
func round4(x float64) float64 { return jsx.Round(x*10000) / 10000 }

// computeSummary is the per-symbol statistics block of recomputeSpreadSummary. records
// are sorted in place by trading_date (stable), exactly as Node sorted them.
func computeSummary(symbol string, records []SpreadPoint) SpreadSummary {
	sort.SliceStable(records, func(i, j int) bool {
		return records[i].TradingDate.UnixMilli() < records[j].TradingDate.UnixMilli()
	})
	spreads := make([]float64, len(records))
	for i, r := range records {
		spreads[i] = r.Spread
	}
	n := len(spreads)
	nf := float64(n)

	sum := 0.0
	maxSpread, minSpread := math.Inf(-1), math.Inf(1)
	maxAbs := 0.0
	firstDate, lastDate := records[0].TradingDate, records[0].TradingDate
	for _, r := range records {
		sum += r.Spread
		if r.Spread > maxSpread {
			maxSpread = r.Spread
		}
		if r.Spread < minSpread {
			minSpread = r.Spread
		}
		if a := math.Abs(r.Spread); a > maxAbs {
			maxAbs = a
		}
		if r.TradingDate.Before(firstDate) {
			firstDate = r.TradingDate
		}
		if r.TradingDate.After(lastDate) {
			lastDate = r.TradingDate
		}
	}
	mean := sum / nf

	// Mean deviation: average of |spread - mean|.
	deviationSum := 0.0
	for _, s := range spreads {
		deviationSum += math.Abs(s - mean)
	}
	meanDeviation := deviationSum / nf

	// Population standard deviation; (s-mean)**2 is exactly d*d in V8. float64() keeps
	// the product from being fused into the addition.
	varianceSum := 0.0
	for _, s := range spreads {
		d := s - mean
		varianceSum += float64(d * d)
	}
	stdDev := math.Sqrt(varianceSum / nf)

	// Percentile 95: ascending sort, index ceil(0.95*n) - 1 clamped to [0, n-1].
	sorted := append([]float64(nil), spreads...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	p95Index := int(math.Ceil(0.95*nf)) - 1
	p95Index = max(0, min(p95Index, n-1))
	percentile95 := sorted[p95Index]

	// Mean reversion: crossings of the mean over deviations from it, in time order; a
	// spread exactly at the mean is ignored.
	crossings, totalDeviations := 0, 0
	var prevAbove, havePrev bool
	for _, s := range spreads {
		above, below := s > mean, s < mean
		if above || below {
			totalDeviations++
			if havePrev && above != prevAbove {
				crossings++
			}
			prevAbove, havePrev = above, true
		}
	}
	mrp := 0.0
	if totalDeviations > 0 {
		mrp = jsx.Round((float64(crossings)/float64(totalDeviations))*10000) / 100
	}

	return SpreadSummary{
		Symbol:                   symbol,
		Observations:             nf,
		FirstDate:                firstDate,
		LastDate:                 lastDate,
		MeanSpread:               round4(mean),
		MaxSpread:                round4(maxSpread),
		MinSpread:                round4(minSpread),
		MeanDeviation:            round4(meanDeviation),
		MaxAbsSpread:             round4(maxAbs),
		StdDevSpread:             round4(stdDev),
		Percentile95:             round4(percentile95),
		MeanReversionProbability: mrp,
	}
}

// RecomputeSpreadSummary is recomputeSpreadSummary: the whole spread_summary table is
// rebuilt from spread_daily (symbols serially, 200 ms apart), then rows of symbols that
// no longer have spread_daily data are deleted, in one transaction.
func (e *EOD) RecomputeSpreadSummary(ctx context.Context) error {
	if !e.store.Ready() {
		return nil
	}
	e.logf("[EODCapture] Recomputing spread_summary...")
	all, err := e.store.SpreadDailyAll(ctx)
	if err != nil {
		return err
	}
	if len(all) == 0 {
		e.logf("[EODCapture] No spread_daily records found. Skipping summary.")
		return nil
	}
	var symbols []string
	grouped := map[string][]SpreadPoint{}
	for _, r := range all {
		if _, ok := grouped[r.Symbol]; !ok {
			symbols = append(symbols, r.Symbol)
		}
		grouped[r.Symbol] = append(grouped[r.Symbol], r)
	}
	docs := make([]SpreadSummary, 0, len(symbols))
	for i, symbol := range symbols {
		if i > 0 {
			if err := e.clock.Sleep(ctx, eodSummarySpacing); err != nil {
				return err
			}
		}
		docs = append(docs, computeSummary(symbol, grouped[symbol]))
	}
	if err := e.store.ReplaceSpreadSummaries(ctx, docs, symbols); err != nil {
		return err
	}
	e.logf("[EODCapture] Spread summary recomputed: %d symbols.", len(symbols))
	return nil
}

// CheckAndRecomputeSummary is checkAndRecomputeSummary: recompute when spread_summary is
// empty or older than the newest spread_daily row. Errors are logged, not returned (the
// cancellation Stop causes is not logged).
func (e *EOD) CheckAndRecomputeSummary(ctx context.Context) error {
	if !e.store.Ready() {
		return nil
	}
	if err := e.checkAndRecompute(ctx); err != nil && ctx.Err() == nil {
		e.logf("[EODCapture] Startup reconciliation error: %v", err)
	}
	return nil
}

func (e *EOD) checkAndRecompute(ctx context.Context) error {
	daily, ok, err := e.store.LatestSpreadDailyDate(ctx)
	if err != nil {
		return err
	}
	if !ok {
		e.logf("[EODCapture] No spread_daily records. Skipping startup reconciliation.")
		return nil
	}
	summary, ok, err := e.store.LatestSummaryLastDate(ctx)
	if err != nil {
		return err
	}
	if !ok {
		e.logf("[EODCapture] No spread_summary records found. Triggering startup recomputation...")
		return e.RecomputeSpreadSummary(ctx)
	}
	if daily.UnixMilli() > summary.UnixMilli() {
		e.logf("[EODCapture] spread_daily has newer data (%s) than spread_summary (%s). Triggering startup recomputation...",
			isoDay(daily), isoDay(summary))
		return e.RecomputeSpreadSummary(ctx)
	}
	e.logf("[EODCapture] Spread summary is up to date. No startup recomputation needed.")
	return nil
}

// schedulerTick is one 60 s tick of startEodScheduler: the EOD capture once per weekday
// in 15:45-15:47 IST and the summary recompute once in 16:00-16:02 IST. A day is marked
// only after its job returned without error (a skipped capture still marks it).
func (e *EOD) schedulerTick(ctx context.Context) {
	if err := e.tick(ctx); err != nil && ctx.Err() == nil {
		e.logf("[EODCapture] Scheduler error: %v", err)
	}
}

func (e *EOD) tick(ctx context.Context) error {
	if !e.store.Ready() {
		return nil
	}
	now := e.clock.Now()
	_, _, _, hh, mm, _, wd := jsx.IstClock(now)
	if wd == 0 || wd == 6 {
		return nil
	}
	today := jsx.IstDayKey(now)

	if hh == 15 && mm >= 45 && mm <= 47 {
		e.mu.Lock()
		due := today != e.lastCapturedDay
		e.mu.Unlock()
		if due {
			e.logf("[EODCapture] Triggering EOD capture at 15:45 IST...")
			if err := e.captureEodData(ctx); err != nil {
				return err
			}
			e.mu.Lock()
			e.lastCapturedDay = today
			e.mu.Unlock()
		}
	}
	if hh == 16 && mm >= 0 && mm <= 2 {
		e.mu.Lock()
		due := today != e.lastComputedDay
		e.mu.Unlock()
		if due {
			e.logf("[EODCapture] Triggering spread summary recomputation at 16:00 IST...")
			if err := e.RecomputeSpreadSummary(ctx); err != nil {
				return err
			}
			e.mu.Lock()
			e.lastComputedDay = today
			e.mu.Unlock()
		}
	}
	return nil
}
