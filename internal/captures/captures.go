// Package captures ports the Node capture jobs: src/eodCapture.ts (NSE F&O stock-futures
// EOD rows, backfill, daily calendar spreads, spread summary), src/hourlyCapture.ts
// (hourly current/mid/far futures prices, gap backfill, end-of-day review) and
// src/yahoo.ts (dividend yields).
//
// Storage is PostgreSQL (migration 0005_captures.sql). Every "nse_fno DB connected" gate
// of the Node code is "pool ready" here; a nil pool behaves like Node with no MongoDB:
// EOD work is skipped, hourly captures stay queued (see Hourly).
//
// Wiring (index.ts): New at boot. StartHourly in the startup chain where index.ts set
// hourlyBackfillDeps: after the Kite session restore, the broker restore and runtime
// start, the admin-session and rf restores, and before the analytics warm load. StartEOD
// where index.ts ran its nse_fno block (initNseFnoConnections().then): once at boot,
// with or without DATABASE_URL. PostLogin from triggerPostLoginBackfill after every
// Zerodha login. Stop in the shutdown step "stop capture/flush schedulers", before the
// pool closes.
//
// Scheduling: the three Node intervals ("hourly-capture", "day-review", "eod-capture")
// are goroutines driven by an injectable Clock and stopped by Service.Stop. One
// deliberate difference from setInterval: a tick whose previous run is still busy is
// skipped instead of starting an overlapping run (the inventory's single-flight rule,
// which removes Node's duplicate-capture / concurrent-drain races). When every run ends
// within its 60 s period the ticks are exactly Node's.
package captures

import (
	"context"
	"errors"
	"log"
	"net/http"
	"reflect"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// ---------------------------------------------------------------------------------------
// Kite access: only what eodCapture.ts and hourlyCapture.ts call.

// Kite is the part of the Kite REST client the captures use; *kite.Client implements it.
// Identifiers are "EXCHANGE:TRADINGSYMBOL", from/to are YYYY-MM-DD. Every historical
// request the captures make uses kite.Background, so it yields to interactive chart
// requests in the shared historical gate, as in Node.
type Kite interface {
	HasSession() bool
	// GetQuoteOhlc is getQuoteOhlc (GET /quote/ohlc, chunks of 500).
	GetQuoteOhlc(ctx context.Context, identifiers []string) ([]kite.OhlcQuote, error)
	// GetQuoteFullOhlc is getQuoteFullOhlc (GET /quote, chunks of 500).
	GetQuoteFullOhlc(ctx context.Context, identifiers []string) ([]kite.FullQuoteOhlc, error)
	// GetHistoricalFull is getHistoricalFull (…/{interval}?from&to&oi=1).
	GetHistoricalFull(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.HistoricalCandle, error)
	// GetHistorical is getHistorical (…/{interval}?from&to).
	GetHistorical(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error)
}

var _ Kite = (*kite.Client)(nil)

func kiteHasSession(k Kite) bool { return k != nil && k.HasSession() }

// BoardFuture and BoardItem are the F&O board rows index.ts deriveFnoBoard produces
// (core.DeriveFnoBoard returns them).
type BoardFuture struct {
	Token   int64   `json:"token"`
	Expiry  string  `json:"expiry"` // YYYY-MM-DD
	LotSize float64 `json:"lot_size"`
}

// BoardItem is one board symbol with its futures in board order (current, mid, far).
type BoardItem struct {
	Symbol    string        `json:"symbol"`
	Name      string        `json:"name"`
	SpotToken int64         `json:"spot_token"`
	Futures   []BoardFuture `json:"futures"`
	IsIndex   bool          `json:"is_index,omitempty"`
}

// ---------------------------------------------------------------------------------------
// Clock

// Ticker is the part of time.Ticker the schedulers use.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// Clock supplies time, delays and tickers so tests can drive the schedulers.
type Clock interface {
	Now() time.Time
	// Sleep is the modules' delay(ms); it returns ctx.Err() if ctx ends first.
	Sleep(ctx context.Context, d time.Duration) error
	NewTicker(d time.Duration) Ticker
}

// RealClock is the wall clock.
type RealClock struct{}

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }

// Now returns time.Now().
func (RealClock) Now() time.Time { return time.Now() }

// NewTicker wraps time.NewTicker.
func (RealClock) NewTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }

// Sleep waits for d or the end of ctx.
func (RealClock) Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ---------------------------------------------------------------------------------------
// Service: the wiring index.ts did at startup and after a login.

// SchedulerInterval is the 60 s period of all three Node intervals.
const SchedulerInterval = 60 * time.Second

// Scheduler names, as tracked by trackInterval in Node.
const (
	IntervalEOD       = "eod-capture"
	IntervalHourly    = "hourly-capture"
	IntervalDayReview = "day-review"
)

// Deps are the collaborators. Every field may be left zero: Pool nil = no DATABASE_URL,
// Kite nil = no Zerodha client (never a session), GetLatestTick nil = no live ticks,
// GetBoard / GetAllInstruments nil = an empty board and universe.
type Deps struct {
	// Pool is the PostgreSQL pool (nil: EOD work is skipped, hourly rows stay queued).
	Pool *db.Pool
	// Kite is the Zerodha client (index.ts `kite`); pass the *kite.Client itself.
	Kite Kite
	// GetBoard is `async () => deriveFnoBoard(await getAllInstrumentsCached())`:
	// core.DeriveFnoBoard over the active broker's instrument universe.
	GetBoard func(ctx context.Context) ([]BoardItem, error)
	// GetAllInstruments is getAllInstrumentsCached (the active broker's universe).
	GetAllInstruments func(ctx context.Context) ([]market.Instrument, error)
	// GetLatestTick is tickerHub.getLatestTick (hub.Hub.GetLatestTick).
	GetLatestTick func(token int64) (market.Tick, bool)
	// Env supplies HOURLY_BACKFILL_LOOKBACK_DAYS and DAY_REVIEW_TIME (default config.OS).
	Env config.Getter
	// LookupEnv, when set (os.LookupEnv), tells a set-but-empty DAY_REVIEW_TIME from an
	// unset one: Node read "" as 00:30 and unset as 16:30. Without it "" counts as unset.
	LookupEnv func(key string) (string, bool)
	// Clock drives time, delays and the 60 s tickers (default RealClock).
	Clock Clock
	// Logf receives every log line (default log.Printf).
	Logf func(format string, args ...any)
	// YahooChartRoot and HTTPClient configure the dividend client ("" / nil = defaults).
	YahooChartRoot string
	HTTPClient     *http.Client
}

func (d *Deps) defaults() {
	if d.Clock == nil {
		d.Clock = RealClock{}
	}
	if d.Logf == nil {
		d.Logf = log.Printf
	}
	if d.Env == nil {
		d.Env = config.OS
	}
	if d.GetBoard == nil {
		d.GetBoard = func(context.Context) ([]BoardItem, error) { return nil, nil }
	}
	if d.GetAllInstruments == nil {
		d.GetAllInstruments = func(context.Context) ([]market.Instrument, error) { return nil, nil }
	}
	// A nil *kite.Client stored in the interface would panic in HasSession.
	if d.Kite != nil {
		if v := reflect.ValueOf(d.Kite); v.Kind() == reflect.Pointer && v.IsNil() {
			d.Kite = nil
		}
	}
}

// env reads key the way process.env[key] was read: ok is false when it is unset.
func (d *Deps) env(key string) (string, bool) {
	if d.LookupEnv != nil {
		return d.LookupEnv(key)
	}
	v := d.Env(key)
	return v, v != ""
}

// Service owns the EOD and hourly jobs, the dividend client and their schedulers.
type Service struct {
	Store  *Store
	EOD    *EOD
	Hourly *Hourly
	Yahoo  *Yahoo

	clock Clock
	logf  func(string, ...any)

	// base ends at Stop; every scheduler tick and background run uses it, so work keeps
	// going after the request that triggered it (a login) has been answered.
	base   context.Context
	cancel context.CancelFunc
	loops  sync.WaitGroup // scheduler goroutines
	tasks  sync.WaitGroup // background runs (startup and post-login backfills)

	mu            sync.Mutex
	stopped       bool
	running       map[string]bool
	order         []string
	hourlyStarted bool
	eodStarted    bool

	// afterTick, when set (tests), runs on the scheduler goroutine after each tick.
	afterTick func(name string)
}

// New builds the service. Nothing runs until StartHourly / StartEOD.
func New(d Deps) *Service {
	d.defaults()
	store := NewStore(d.Pool)
	base, cancel := context.WithCancel(context.Background())
	return &Service{
		Store:   store,
		EOD:     NewEOD(store, d),
		Hourly:  NewHourly(store, d),
		Yahoo:   NewYahoo(d.YahooChartRoot, d.HTTPClient, d.Clock.Now),
		clock:   d.Clock,
		logf:    d.Logf,
		base:    base,
		cancel:  cancel,
		running: map[string]bool{},
	}
}

// StartHourly is the hourly block of index.ts's startup chain, run after the Kite
// session, the active broker and the admin sessions are restored:
// startHourlyScheduler, backfillMissedHours in the background (a failure logs
// "[HourlyCapture] startup backfill failed: …") and startDayReviewScheduler
// (DAY_REVIEW_TIME is read now). It also arms the hourly half of PostLogin (index.ts
// set hourlyBackfillDeps here). Only the first call does anything.
func (s *Service) StartHourly() {
	s.mu.Lock()
	if s.stopped || s.hourlyStarted {
		s.mu.Unlock()
		return
	}
	s.hourlyStarted = true
	s.mu.Unlock()
	s.startHourlyScheduler()
	s.goTask(func(ctx context.Context) {
		s.logFailure(s.Hourly.BackfillMissedHours(ctx), "[HourlyCapture] startup backfill failed: %v")
	})
	s.startDayReviewScheduler()
}

// StartEOD is the nse_fno block of index.ts's startup (initNseFnoConnections().then):
// startEodScheduler, then backfillStockFutures and checkAndRecomputeSummary in the
// background. Call it once at boot after the pool is opened, with or without
// DATABASE_URL (without one the ticks and both runs skip, as Node did without the
// nse_fno databases). It also arms the EOD half of PostLogin (index.ts set
// eodBackfillDeps here). Only the first call does anything.
func (s *Service) StartEOD() {
	s.mu.Lock()
	if s.stopped || s.eodStarted {
		s.mu.Unlock()
		return
	}
	s.eodStarted = true
	s.mu.Unlock()
	s.startEODScheduler()
	s.goTask(func(ctx context.Context) {
		s.logFailure(s.EOD.BackfillStockFutures(ctx), "[EODCapture] startup stock-futures backfill failed: %v")
	})
	s.goTask(func(ctx context.Context) {
		s.logFailure(s.EOD.CheckAndRecomputeSummary(ctx), "[EODCapture] startup summary recompute failed: %v")
	})
}

// PostLogin is the capture half of triggerPostLoginBackfill, called after every Zerodha
// login (POST /api/session, GET /callback): backfill the hourly slots and EOD days missed
// while logged out and reconcile the summary. It returns at once; the work runs in the
// background until done or Stop, independent of the caller's request. As in Node, the
// hourly half does nothing before StartHourly and the EOD half nothing before StartEOD;
// after Stop it does nothing at all.
func (s *Service) PostLogin() {
	s.mu.Lock()
	hourly, eod := s.hourlyStarted && !s.stopped, s.eodStarted && !s.stopped
	s.mu.Unlock()
	if hourly {
		s.logf("[HourlyCapture] Login detected — backfilling any missed slots.")
		s.goTask(func(ctx context.Context) {
			s.logFailure(s.Hourly.BackfillMissedHours(ctx), "[HourlyCapture] post-login backfill failed: %v")
		})
	}
	if eod {
		s.goTask(func(ctx context.Context) {
			s.logFailure(s.EOD.BackfillStockFutures(ctx), "[EODCapture] post-login backfill failed: %v")
		})
		s.goTask(func(ctx context.Context) {
			s.logFailure(s.EOD.CheckAndRecomputeSummary(ctx), "[EODCapture] post-login summary recompute failed: %v")
		})
	}
}

// logFailure logs a rejected background run, except the cancellation Stop causes (Node
// had no cancellation, so it never logged one).
func (s *Service) logFailure(err error, format string) {
	if err == nil || (s.base.Err() != nil && errors.Is(err, context.Canceled)) {
		return
	}
	s.logf(format, err)
}

// startHourlyScheduler is startHourlyScheduler.
func (s *Service) startHourlyScheduler() {
	if s.loop(IntervalHourly, s.Hourly.schedulerTick) {
		s.logf("[HourlyCapture] Hourly scheduler started (checking every 60s).")
	}
}

// startDayReviewScheduler is startDayReviewScheduler.
func (s *Service) startDayReviewScheduler() {
	h, m := s.Hourly.reviewTime()
	if s.loop(IntervalDayReview, func(c context.Context) { s.Hourly.dayReviewTick(c, h, m) }) {
		s.logf("[DayReview] End-of-day review scheduler started (checking for %s:%s IST).", padStart2(h), padStart2(m))
	}
}

// startEODScheduler is startEodScheduler.
func (s *Service) startEODScheduler() {
	if s.loop(IntervalEOD, s.EOD.schedulerTick) {
		s.logf("[EODCapture] EOD scheduler started (checking every 60s for 15:45 & 16:00 IST).")
	}
}

// loop runs body on every tick until Stop. The body runs on the loop goroutine, so a
// slow run makes the ticker drop ticks rather than overlap.
func (s *Service) loop(name string, body func(context.Context)) bool {
	s.mu.Lock()
	if s.stopped || s.running[name] {
		s.mu.Unlock()
		return false
	}
	s.running[name] = true
	s.order = append(s.order, name)
	s.loops.Add(1)
	s.mu.Unlock()

	ticker := s.clock.NewTicker(SchedulerInterval)
	go func() {
		defer s.loops.Done()
		defer ticker.Stop()
		for {
			select {
			case <-s.base.Done():
				return
			case <-ticker.C():
				if s.base.Err() != nil {
					return // Stop won the race with this tick
				}
				body(s.base)
				if s.afterTick != nil {
					s.afterTick(name)
				}
			}
		}
	}()
	return true
}

// goTask runs fn on its own goroutine under the service lifetime (never after Stop).
func (s *Service) goTask(fn func(context.Context)) {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.tasks.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.tasks.Done()
		fn(s.base)
	}()
}

// waitTasks waits for the background runs started so far (tests).
func (s *Service) waitTasks() { s.tasks.Wait() }

// Intervals lists the running schedulers in start order (trackedIntervals).
func (s *Service) Intervals() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return []string{}
	}
	return append([]string{}, s.order...)
}

// DividendYields is getDividendYields(symbols) with the default concurrency (GET
// /api/dividends): symbol → trailing dividend yield in percent, 0 on any failure.
func (s *Service) DividendYields(ctx context.Context, symbols []string) map[string]float64 {
	return s.Yahoo.GetDividendYields(ctx, symbols, DefaultYahooConcurrency)
}

// SpreadSummary is SpreadSummary.findOne({symbol}).lean() for GET
// /api/spread-stats/:symbol (the route upper-cases the symbol): nil, nil when there is
// no row; ErrNoDatabase without a pool.
func (s *Service) SpreadSummary(ctx context.Context, symbol string) (*SpreadSummary, error) {
	return s.Store.SpreadSummary(ctx, symbol)
}

// Stop is the shutdown step "stop capture/flush schedulers" for this package: it stops
// the schedulers and cancels the background runs, waits for them, and returns the
// scheduler names it stopped in start order (clearTrackedIntervals, for the
// "[shutdown] cleared timers: …" line). Work in flight ends at its next database call,
// Kite call or delay, so nothing is written once Stop has returned; queued rows are
// dropped, as they were when Node exited. Later calls return an empty list.
func (s *Service) Stop() []string {
	s.mu.Lock()
	var names []string
	if !s.stopped {
		names = append([]string{}, s.order...)
	}
	s.stopped = true
	s.order = nil
	s.mu.Unlock()
	s.cancel()
	s.loops.Wait()
	s.tasks.Wait()
	if names == nil {
		names = []string{}
	}
	return names
}
