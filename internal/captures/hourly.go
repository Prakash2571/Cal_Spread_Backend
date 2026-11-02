package captures

import (
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Port of src/hourlyCapture.ts: current/mid/far month futures closes per board symbol at
// fixed IST slots, a gap-aware backfill from 60-minute candles, and an end-of-day
// completeness review.
//
// Writes without a database: Node never gated these writes; without a connection each
// Mongoose upsert buffered, failed after 10 s, and the row stayed queued (the queue grew
// for the life of the process). The Go port keeps that observable behaviour: captures
// still queue, every drain fails at the head with ErrNoDatabase, logs the failure and
// stops, and the rows stay queued (at most symbols x 7 per day, as in Node). The gap
// backfill likewise fails per symbol on the slot lookup, and the day review fails on its
// count, both logged as in Node; nothing is ever written.

// FnoCloseExtendedFrom is the first IST date with the 15:40 F&O close.
const FnoCloseExtendedFrom = "2026-08-03"

var (
	marketHoursTo1530 = []string{"10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:30"}
	marketHoursTo1540 = []string{"10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "15:40"}
)

// SlotsPerDay is the number of capture slots per session (both eras).
var SlotsPerDay = len(marketHoursTo1540)

// Hourly capture delays, as in hourlyCapture.ts.
const (
	hourlyDrainSpacing  = 100 * time.Millisecond
	hourlyHistoricalGap = 300 * time.Millisecond
	hourlyErrorBackoff  = 500 * time.Millisecond
)

// MarketHoursFor is marketHoursFor(date): the slot list of an IST date (string compare
// with FnoCloseExtendedFrom). The returned slice must not be modified.
func MarketHoursFor(date string) []string {
	if date >= FnoCloseExtendedFrom {
		return marketHoursTo1540
	}
	return marketHoursTo1530
}

// istHourKey is "HH:00" of the IST hour.
func istHourKey(now time.Time) string {
	_, _, _, hh, _, _, _ := jsx.IstClock(now)
	return padStart2(float64(hh)) + ":00"
}

// currentCaptureSlot is currentCaptureSlot(ist): the first slot of today's list whose
// window (slot minute .. +2) contains now.
func currentCaptureSlot(now time.Time) (string, bool) {
	_, _, _, hh, mm, _, _ := jsx.IstClock(now)
	h, m := float64(hh), float64(mm)
	for _, slot := range MarketHoursFor(jsx.IstDayKey(now)) {
		slotHour := jsParseInt10(jsSlice(slot, 0, 2))
		slotMin := jsParseInt10(jsSlice(slot, 3, 5))
		if h == slotHour && m >= slotMin && m <= slotMin+2 {
			return slot, true
		}
	}
	return "", false
}

// allExpectedSlots lists the weekday slots from startDate to endDate inclusive, without
// the end day's slots after endTime (string compare).
func allExpectedSlots(startDate, endDate, endTime string) []DateTimeSlot {
	var slots []DateTimeSlot
	cur, ok1 := parseJSDay(startDate)
	end, ok2 := parseJSDay(endDate)
	if !ok1 || !ok2 {
		return slots
	}
	for !cur.After(end) {
		d := isoDay(cur)
		if isWeekday(d) {
			for _, hour := range MarketHoursFor(d) {
				if d == endDate && hour > endTime {
					continue
				}
				slots = append(slots, DateTimeSlot{Date: d, Time: hour})
			}
		}
		cur = cur.AddDate(0, 0, 1)
	}
	return slots
}

// candleToSlotKey maps a Kite 60-minute candle timestamp (candle START, IST) to
// "YYYY-MM-DD_HH:MM": 09:15 -> 10:00 ... 14:15 -> 15:00, 15:15 -> the closing slot of
// that date; candles on the hour map to the next hour, else to the hour itself.
func candleToSlotKey(timestamp string) (string, bool) {
	clean := strings.Replace(timestamp, "T", " ", 1)
	datePart := jsSlice(clean, 0, 10)
	timePart := jsSlice(clean, 11, 16)
	if datePart == "" || timePart == "" {
		return "", false
	}
	hh := jsParseInt10(jsSlice(timePart, 0, 2))
	mm := jsParseInt10(jsSlice(timePart, 3, 5))
	slots := MarketHoursFor(datePart)
	closing := slots[len(slots)-1]

	if mm == 15 {
		if hh == 15 {
			return datePart + "_" + closing, true
		}
		key := padStart2(hh+1) + ":00"
		if slices.Contains(slots, key) {
			return datePart + "_" + key, true
		}
	}
	if mm == 0 {
		key := padStart2(hh+1) + ":00"
		if slices.Contains(slots, key) {
			return datePart + "_" + key, true
		}
		direct := padStart2(hh) + ":00"
		if slices.Contains(slots, direct) {
			return datePart + "_" + direct, true
		}
	}
	return "", false
}

// Hourly is the hourly capture job; its queue and markers are the module-level state of
// hourlyCapture.ts.
type Hourly struct {
	store             hourlyStore
	kite              Kite
	getBoard          func(context.Context) ([]BoardItem, error)
	getAllInstruments func(context.Context) ([]market.Instrument, error)
	getLatestTick     func(int64) (market.Tick, bool)
	env               func(key string) (string, bool) // process.env[key]; ok = defined
	clock             Clock
	logf              func(string, ...any)

	mu               sync.Mutex
	pendingWrites    []HourlyPrice
	draining         bool
	backfilling      bool
	lastCapturedSlot string
	lastReviewDay    string

	// afterDrain, when set (tests), runs when a drain has emptied the queue and ended.
	afterDrain func()
}

// NewHourly builds the job over store with the collaborators in d.
func NewHourly(store *Store, d Deps) *Hourly {
	d.defaults()
	return &Hourly{
		store: store, kite: d.Kite, getBoard: d.GetBoard, getAllInstruments: d.GetAllInstruments,
		getLatestTick: d.GetLatestTick, env: d.env, clock: d.Clock, logf: d.Logf,
	}
}

// Pending reports the queue length.
func (h *Hourly) Pending() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.pendingWrites)
}

func (h *Hourly) push(p HourlyPrice) {
	h.mu.Lock()
	h.pendingWrites = append(h.pendingWrites, p)
	h.mu.Unlock()
}

func (h *Hourly) tickPrice(token int64) (float64, bool) {
	if h.getLatestTick == nil {
		return 0, false
	}
	t, ok := h.getLatestTick(token)
	if !ok {
		return 0, false
	}
	return t.LastPrice, true
}

func farOrNull(price float64, ok bool) *float64 {
	if ok && price > 0 {
		return &price
	}
	return nil
}

// CaptureHourlyPrices is captureHourlyPrices(board, getLatestTick, kite?, allInstruments?,
// slot?): for every board item with at least two futures, the live last price of
// futures[0] (current) and futures[1] (mid), plus futures[2] (far) when listed, is
// queued with spread = mid - current. Items without both live prices fall back to one
// REST /quote/ohlc call, made only when kc has a session and allInstruments is non-nil
// (an empty slice is a present list). slot "" means the current "HH:00".
func (h *Hourly) CaptureHourlyPrices(ctx context.Context, board []BoardItem, kc Kite, allInstruments []market.Instrument, slot string) {
	now := h.clock.Now()
	date := jsx.IstDayKey(now)
	t := slot
	if t == "" {
		t = istHourKey(now)
	}
	month := jsSlice(date, 0, 7)

	type pendingItem struct {
		item                 BoardItem
		currentToken, midTok int64
		farToken             int64
		hasFar               bool
	}
	var needsRest []pendingItem

	for _, item := range board {
		if len(item.Futures) < 2 {
			continue
		}
		cur, mid := item.Futures[0], item.Futures[1]
		curPrice, curOK := h.tickPrice(cur.Token)
		midPrice, midOK := h.tickPrice(mid.Token)
		var farPrice float64
		var farOK bool
		if len(item.Futures) >= 3 {
			farPrice, farOK = h.tickPrice(item.Futures[2].Token)
		}
		if curOK && curPrice > 0 && midOK && midPrice > 0 {
			h.push(HourlyPrice{
				Symbol: item.Symbol, Date: date, Time: t, Month: month,
				CurrentMonthClose: curPrice, MidMonthClose: midPrice,
				FarMonthClose: farOrNull(farPrice, farOK), Spread: midPrice - curPrice,
			})
			continue
		}
		p := pendingItem{item: item, currentToken: cur.Token, midTok: mid.Token}
		if len(item.Futures) >= 3 {
			p.farToken, p.hasFar = item.Futures[2].Token, true
		}
		needsRest = append(needsRest, p)
	}

	if len(needsRest) > 0 && kiteHasSession(kc) && allInstruments != nil {
		if err := func() error {
			tokenToIdentifier := map[int64]string{}
			for _, inst := range allInstruments {
				if inst.Exchange == "NFO" && inst.InstrumentType == "FUT" {
					tokenToIdentifier[inst.InstrumentToken] = "NFO:" + inst.Tradingsymbol
				}
			}
			var ids []string
			for _, p := range needsRest {
				if id, ok := tokenToIdentifier[p.currentToken]; ok {
					ids = append(ids, id)
				}
				if id, ok := tokenToIdentifier[p.midTok]; ok {
					ids = append(ids, id)
				}
				if p.hasFar && p.farToken != 0 { // `pending.farToken ? ... : undefined`
					if id, ok := tokenToIdentifier[p.farToken]; ok {
						ids = append(ids, id)
					}
				}
			}
			if len(ids) == 0 {
				return nil
			}
			quotes, err := kc.GetQuoteOhlc(ctx, ids)
			if err != nil {
				return err
			}
			rest := map[int64]float64{}
			for _, q := range quotes {
				if q.LastPrice > 0 {
					rest[q.InstrumentToken] = q.LastPrice
				}
			}
			for _, p := range needsRest {
				curPrice, curOK := rest[p.currentToken]
				midPrice, midOK := rest[p.midTok]
				var farPrice float64
				var farOK bool
				if p.hasFar && p.farToken != 0 {
					farPrice, farOK = rest[p.farToken]
				}
				if curOK && curPrice > 0 && midOK && midPrice > 0 {
					h.push(HourlyPrice{
						Symbol: p.item.Symbol, Date: date, Time: t, Month: month,
						CurrentMonthClose: curPrice, MidMonthClose: midPrice,
						FarMonthClose: farOrNull(farPrice, farOK), Spread: midPrice - curPrice,
					})
				}
			}
			return nil
		}(); err != nil && ctx.Err() == nil {
			h.logf("[HourlyCapture] REST fallback failed: %v", err)
		}
	}

	h.logf("[HourlyCapture] Captured %d records at %s %s", h.Pending(), date, t)
}

// DrainCacheToDB is drainCacheToDB: upsert queued rows one at a time, 100 ms apart,
// removing a row only after its write succeeded and stopping at the first failure. A
// concurrent call returns at once.
//
// The drain that finds the queue empty clears the draining flag in the same critical
// section. Node checked the queue and reset the flag with no await in between, so a row
// queued by a capture whose own drain call returned early ("already draining") was
// always picked up; resetting the flag later would leave such a row queued until the
// next capture.
func (h *Hourly) DrainCacheToDB(ctx context.Context) {
	h.mu.Lock()
	if h.draining {
		h.mu.Unlock()
		return
	}
	h.draining = true
	h.mu.Unlock()
	release := func() {
		h.mu.Lock()
		h.draining = false
		h.mu.Unlock()
	}
	for {
		h.mu.Lock()
		if len(h.pendingWrites) == 0 {
			h.draining = false
			h.mu.Unlock()
			if h.afterDrain != nil {
				h.afterDrain()
			}
			return
		}
		doc := h.pendingWrites[0]
		h.mu.Unlock()
		if err := h.store.UpsertHourlyPrice(ctx, doc); err != nil {
			if ctx.Err() == nil {
				h.logf("[HourlyCapture] Failed to upsert %s %s %s: %v", doc.Symbol, doc.Date, doc.Time, err)
			}
			release()
			return
		}
		h.mu.Lock()
		h.pendingWrites = h.pendingWrites[1:]
		h.mu.Unlock()
		if h.clock.Sleep(ctx, hourlyDrainSpacing) != nil {
			release()
			return
		}
	}
}

// schedulerTick is one 60 s tick of startHourlyScheduler: during market hours, inside a
// slot's window, capture and drain once per (day, slot); the slot is marked only after
// both returned (REST and write failures are logged inside and still mark it).
func (h *Hourly) schedulerTick(ctx context.Context) {
	if err := h.tick(ctx); err != nil && ctx.Err() == nil {
		h.logf("[HourlyCapture] Scheduler error: %v", err)
	}
}

func (h *Hourly) tick(ctx context.Context) error {
	now := h.clock.Now()
	if !jsx.IsMarketOpen(now) {
		return nil
	}
	slot, ok := currentCaptureSlot(now)
	if !ok {
		return nil
	}
	slotKey := jsx.IstDayKey(now) + "_" + slot
	h.mu.Lock()
	done := slotKey == h.lastCapturedSlot
	h.mu.Unlock()
	if done {
		return nil
	}
	board, err := h.getBoard(ctx)
	if err != nil {
		return err
	}
	instruments, err := h.getAllInstruments(ctx)
	if err != nil {
		return err
	}
	if instruments == nil {
		instruments = []market.Instrument{} // the awaited list is always an array
	}
	h.CaptureHourlyPrices(ctx, board, h.kite, instruments, slot)
	h.DrainCacheToDB(ctx)
	h.mu.Lock()
	h.lastCapturedSlot = slotKey
	h.mu.Unlock()
	return nil
}

// errInvalidTime is the RangeError toISOString throws for an out-of-range Date.
var errInvalidTime = errors.New("RangeError: Invalid time value")

// lookbackDays is Number(process.env.HOURLY_BACKFILL_LOOKBACK_DAYS ?? "7") || 7.
func (h *Hourly) lookbackDays() float64 {
	raw, ok := h.env("HOURLY_BACKFILL_LOOKBACK_DAYS")
	if !ok {
		raw = "7"
	}
	v, ok := jsx.ParseNumber(raw)
	if !ok || v == 0 || math.IsNaN(v) {
		return 7
	}
	return v
}

// BackfillMissedHours is backfillMissedHours: for each board item with at least two
// futures, every expected slot of the lookback window (HOURLY_BACKFILL_LOOKBACK_DAYS,
// default 7) that is not stored is filled from 60-minute candles. Runs once at a time;
// a second call while one runs logs and returns.
func (h *Hourly) BackfillMissedHours(ctx context.Context) error {
	// Read before taking the lock (the Kite client has its own); Node checked the guard
	// first and the session second with nothing in between, so the outcome is the same.
	hasSession := kiteHasSession(h.kite)
	h.mu.Lock()
	if h.backfilling {
		h.mu.Unlock()
		h.logf("[HourlyCapture] Backfill already running; skipping duplicate request.")
		return nil
	}
	if !hasSession {
		h.mu.Unlock()
		h.logf("[HourlyCapture] No Kite session available. Skipping backfill.")
		return nil
	}
	h.backfilling = true
	h.mu.Unlock()
	release := func() {
		h.mu.Lock()
		h.backfilling = false
		h.mu.Unlock()
	}

	board, err := h.getBoard(ctx)
	if err != nil {
		if ctx.Err() == nil { // Stop is not a failure to report
			h.logf("[HourlyCapture] Could not get board for backfill: %v", err)
		}
		release()
		return nil
	}

	now := h.clock.Now()
	todayStr := jsx.IstDayKey(now)
	nowHour := istHourKey(now)

	// istNow().getTime() - lookbackDays * 24 * 60 * 60 * 1000, multiplied in Node's order.
	span := h.lookbackDays()
	span *= 24
	span *= 60
	span *= 60
	span *= 1000
	iso, ok := jsISOString(float64(now.UnixMilli()+19800000) - span)
	if !ok {
		// Node threw here, outside the try/finally, so the guard was never released and
		// every later backfill reported "already running". Kept as-is.
		return errInvalidTime
	}
	windowStart := jsSlice(iso, 0, 10)

	for _, item := range board {
		if len(item.Futures) < 2 {
			continue
		}
		if err := h.backfillSymbol(ctx, item, windowStart, todayStr, nowHour); err != nil {
			if ctx.Err() != nil {
				release()
				return ctx.Err()
			}
			h.logf("[HourlyCapture] Backfill failed for %s: %v", item.Symbol, err)
			if err := h.clock.Sleep(ctx, hourlyErrorBackoff); err != nil {
				release()
				return err
			}
		}
	}

	defer release()
	if n := h.Pending(); n > 0 {
		h.logf("[HourlyCapture] Backfill queued %d records. Draining...", n)
		h.DrainCacheToDB(ctx)
	} else {
		h.logf("[HourlyCapture] Backfill: no missing slots found.")
	}
	return nil
}

// backfillSymbol is the try block of backfillMissedHours for one board item.
func (h *Hourly) backfillSymbol(ctx context.Context, item BoardItem, windowStart, todayStr, nowHour string) error {
	cur, mid := item.Futures[0], item.Futures[1]
	existing, err := h.store.HourlySlotsSince(ctx, item.Symbol, windowStart)
	if err != nil {
		return err
	}
	present := map[string]bool{}
	for _, d := range existing {
		present[d.Date+"_"+d.Time] = true
	}
	var missing []DateTimeSlot
	for _, s := range allExpectedSlots(windowStart, todayStr, nowHour) {
		if !present[s.Date+"_"+s.Time] {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	from, to := missing[0].Date, missing[len(missing)-1].Date

	fetch := func(token int64) (map[string]float64, error) {
		candles, err := h.kite.GetHistorical(ctx, token, from, to, "60minute", kite.Background)
		if err != nil {
			return nil, err
		}
		if err := h.clock.Sleep(ctx, hourlyHistoricalGap); err != nil {
			return nil, err
		}
		bySlot := map[string]float64{}
		for _, c := range candles {
			if key, ok := candleToSlotKey(c.T); ok {
				bySlot[key] = c.Close
			}
		}
		return bySlot, nil
	}
	currentBySlot, err := fetch(cur.Token)
	if err != nil {
		return err
	}
	midBySlot, err := fetch(mid.Token)
	if err != nil {
		return err
	}
	farBySlot := map[string]float64{}
	if len(item.Futures) >= 3 {
		if farBySlot, err = fetch(item.Futures[2].Token); err != nil {
			return err
		}
	}

	for _, s := range missing {
		key := s.Date + "_" + s.Time
		curPrice, curOK := currentBySlot[key]
		midPrice, midOK := midBySlot[key]
		farPrice, farOK := farBySlot[key]
		if curOK && curPrice > 0 && midOK && midPrice > 0 {
			h.push(HourlyPrice{
				Symbol: item.Symbol, Date: s.Date, Time: s.Time, Month: jsSlice(s.Date, 0, 7),
				CurrentMonthClose: curPrice, MidMonthClose: midPrice,
				FarMonthClose: farOrNull(farPrice, farOK), Spread: midPrice - curPrice,
			})
		}
	}
	return nil
}

// DayReview is what reviewDayCompleteness found (Node only logged it).
type DayReview struct {
	Day        string `json:"day"`
	Outcome    string `json:"outcome"` // weekend | no_board | no_symbols | pass | no_session | pass_after_backfill | still_missing
	Symbols    int    `json:"symbols"`
	Expected   int    `json:"expected"`
	Before     int    `json:"before"`
	After      int    `json:"after"`
	Backfilled bool   `json:"backfilled"`
}

// ReviewDayCompleteness is reviewDayCompleteness: count today's stored slot rows of the
// board's eligible symbols against symbols x SlotsPerDay; if short and a session
// exists, run the backfill and count again.
func (h *Hourly) ReviewDayCompleteness(ctx context.Context) (DayReview, error) {
	today := jsx.IstDayKey(h.clock.Now())
	r := DayReview{Day: today}
	if !isWeekday(today) {
		h.logf("[DayReview] %s is a weekend — nothing to review.", today)
		r.Outcome = "weekend"
		return r, nil
	}
	h.logf("[DayReview] Running end-of-day completeness check for %s...", today)

	board, err := h.getBoard(ctx)
	if err != nil {
		if ctx.Err() == nil { // Stop is not a failure to report
			h.logf("[DayReview] Could not get board: %v", err)
		}
		r.Outcome = "no_board"
		return r, nil
	}
	symbols := []string{}
	for _, b := range board {
		if len(b.Futures) >= 2 {
			symbols = append(symbols, b.Symbol)
		}
	}
	if len(symbols) == 0 {
		h.logf("[DayReview] No eligible symbols on the board — skipping.")
		r.Outcome = "no_symbols"
		return r, nil
	}
	r.Symbols = len(symbols)
	r.Expected = len(symbols) * SlotsPerDay

	before, err := h.store.CountHourlyPrices(ctx, today, symbols)
	if err != nil {
		return r, err
	}
	r.Before = before
	h.logf("[DayReview] Stored %d/%d slot-records for %s (%d symbols x %d slots).",
		before, r.Expected, today, len(symbols), SlotsPerDay)
	if before >= r.Expected {
		h.logf("[DayReview] CHECK PASS — the full day is stored for %s.", today)
		r.Outcome = "pass"
		return r, nil
	}
	h.logf("[DayReview] INCOMPLETE — %d slot-records missing. Backfilling...", r.Expected-before)
	if !kiteHasSession(h.kite) {
		h.logf("[DayReview] No Kite session — cannot backfill now. Log in and it will recover the gap.")
		r.Outcome = "no_session"
		return r, nil
	}
	if err := h.BackfillMissedHours(ctx); err != nil {
		return r, err
	}
	r.Backfilled = true
	after, err := h.store.CountHourlyPrices(ctx, today, symbols)
	if err != nil {
		return r, err
	}
	r.After = after
	if after >= r.Expected {
		h.logf("[DayReview] CHECK PASS after backfill — full day now stored (%d/%d).", after, r.Expected)
		r.Outcome = "pass_after_backfill"
	} else {
		h.logf("[DayReview] Still %d missing after backfill (%d/%d). Some contracts may lack historical data for those slots.",
			r.Expected-after, after, r.Expected)
		r.Outcome = "still_missing"
	}
	return r, nil
}

// reviewTime parses DAY_REVIEW_TIME like startDayReviewScheduler:
// (process.env.DAY_REVIEW_TIME ?? "16:30").split(":"), each part Number(part) when
// finite, else 16 / 30. A set-but-empty value is "" (Number("") = 0, so 00:30) when
// Deps.LookupEnv is given; through a plain Getter it reads as unset (16:30).
func (h *Hourly) reviewTime() (hour, minute float64) {
	raw, ok := h.env("DAY_REVIEW_TIME")
	if !ok {
		raw = "16:30"
	}
	parts := strings.Split(raw, ":")
	part := func(i int, def float64) float64 {
		if i >= len(parts) {
			return def // Number(undefined) is NaN
		}
		v, ok := jsx.ParseNumber(parts[i])
		if !ok || !jsx.Finite(v) {
			return def
		}
		return v
	}
	return part(0, 16), part(1, 30)
}

// dayReviewTick is one 60 s tick of startDayReviewScheduler: on weekdays inside
// [reviewM, reviewM+2] of hour reviewH, once per day. The day is marked BEFORE the
// review runs, as in Node.
func (h *Hourly) dayReviewTick(ctx context.Context, reviewH, reviewM float64) {
	now := h.clock.Now()
	_, _, _, hh, mm, _, wd := jsx.IstClock(now)
	if wd == 0 || wd == 6 {
		return
	}
	if float64(hh) != reviewH || float64(mm) < reviewM || float64(mm) > reviewM+2 {
		return
	}
	today := jsx.IstDayKey(now)
	h.mu.Lock()
	if today == h.lastReviewDay {
		h.mu.Unlock()
		return
	}
	h.lastReviewDay = today
	h.mu.Unlock()
	if _, err := h.ReviewDayCompleteness(ctx); err != nil && ctx.Err() == nil {
		h.logf("[DayReview] Scheduler error: %v", err)
	}
}
