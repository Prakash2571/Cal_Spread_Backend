// Package analytics is the NIFTY option/futures open-interest analytics of src/index.ts:
// the once-a-minute chain capture, the multi-timeframe OI frames (1m/5m/15m/1h) with
// their gap-aware active-broker backfill and coarsening, the per-token chain snapshots behind the
// chain's OI change columns, the previous-session close baseline, and the six public
// routes that serve them (/api/option-chain, /api/option-oi-baseline, /api/option-prev-close,
// /api/option-oi-series, /api/option-oi-frame, /api/futures-oi-frame).
//
// Memory is the read path, exactly as in Node. Every mutation is mirrored to the
// PostgreSQL key-value cache (internal/kv, which replaced Upstash Redis) through the same
// write-behind buffer src/index.ts used: buffered per key and field, flushed once per
// capture cycle, after each backfill chain and every 60 s, re-queued on failure, and
// warm-loaded at boot. Without a cache the service is memory-only, like Node without
// Redis.
//
// Node ran all of this on one thread; here every piece of state is guarded by one mutex
// (Service.mu) that is never held while a dependency is called. Background work runs on
// goroutines tied to the service context, so Stop cancels and waits for it.
package analytics

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Timer is a scheduled callback that can be cancelled (*time.Timer satisfies it).
type Timer interface {
	Stop() bool
}

// Readiness is the active broker's market-data health as requireMarketData reads it
// (brokerManager.activeHealth()).
type Readiness struct {
	// Ready is health.data_ready.
	Ready bool
	// Broker is the active broker ("zerodha" or "dhan").
	Broker brokers.ID
	// Problems is health.problems.
	Problems []string
}

// Cache is the subset of internal/kv.Cache the write-behind layer and the warm load use.
// *kv.Cache implements it. Keys are given WITHOUT the "calspread:" prefix; the cache adds
// it, as redis.ts did.
type Cache interface {
	Enabled() bool
	Ping(ctx context.Context) error
	Get(ctx context.Context, key string) (string, bool, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	HGetAll(ctx context.Context, key string) (map[string]string, error)
	HSet(ctx context.Context, key string, fields map[string]string) error
	HDel(ctx context.Context, key string, fields ...string) error
	Expire(ctx context.Context, key string, ttl time.Duration) (bool, error)
}

// Deps are the collaborators src/index.ts reached through module globals.
type Deps struct {
	// Instruments is getAllInstrumentsCached(): the ACTIVE broker's instrument universe
	// (brokerManager.instrumentProvider.load()). The slice is treated as read-only.
	Instruments func(ctx context.Context) ([]market.Instrument, error)
	// QuoteFull is the active broker's price/OI/close/trade-time snapshot for
	// "EXCHANGE:TRADINGSYMBOL" identifiers, in the shared internal FullQuote shape.
	QuoteFull func(ctx context.Context, ids []string) ([]kite.FullQuote, error)
	// Historical is history.getHistorical (brokers/history.ts, routed to the active
	// broker); the analytics always ask with kite.Background priority.
	Historical func(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error)
	// HistoricalOiSeries is history.getHistoricalOiSeries.
	HistoricalOiSeries func(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.OISeriesPoint, error)
	// QuotesByToken is brokerManager.quoteProvider.quotesByToken (the active broker's REST
	// quote), used only for the option-chain spot. Nil means the spot is 0.
	QuotesByToken func(ctx context.Context, tokens []int64) ([]market.Tick, error)
	// CaptureAllowed is the active broker's data readiness. Nil means no
	// capture or backfill ever runs.
	CaptureAllowed func(what string) bool
	// MarketData is the readiness behind requireMarketData. Nil means always ready.
	MarketData func() Readiness
	// Namespace is the active broker and token generation, read atomically.
	// When configured, state/cache ownership and asynchronous reads are fenced.
	Namespace func() brokers.Namespace
	// SendError is index.ts sendError. Nil uses DefaultSendError(KiteAuthFailed).
	SendError func(w http.ResponseWriter, err error)
	// KiteAuthFailed is called by the default SendError for a KiteError 401/403 (Node
	// cleared the Kite session in memory and in kite_session). Ignored when SendError is set.
	KiteAuthFailed func()
	// Cache is the PostgreSQL cache. Nil or disabled means memory only.
	Cache Cache
	// ExtraSessionDays is EXTRA_SESSION_DAYS (config.Config.ExtraSessionDays).
	ExtraSessionDays map[string]bool
	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// AfterFunc schedules f after d; nil means time.AfterFunc.
	AfterFunc func(d time.Duration, f func()) Timer
	// Sleep is the pacing delay (delay(ms) in index.ts); nil sleeps for real and returns
	// early with ctx.Err() when ctx is cancelled.
	Sleep func(ctx context.Context, d time.Duration) error
	// Logf receives the log lines; nil means log.Printf. It is called with the service
	// lock held at times, so it must not call back into the service.
	Logf func(format string, args ...any)
}

// Service holds the analytics state and runs the captures. Create it with New.
type Service struct {
	d     Deps
	extra map[string]bool

	mu                             sync.Mutex
	scope                          operationScope
	scopeCtx                       context.Context
	scopeCancel                    context.CancelFunc
	scopeWarm                      bool
	backfillOwners                 map[*bool]uint64
	prevCloseOwner                 uint64
	recoveryRunning, recoveryAgain bool

	// optionOiDay: today's per-token samples for the nearest expiry (memory only).
	day *oiDay
	// optionPrevClose: the previous session's close baseline.
	prevClose *PrevClose
	// oiFrameStores / futOiFrameStores, indexed like frames.
	oiFrames  [frameCount][]*OiAggPoint
	futFrames [frameCount][]*FutOiPoint
	// futOiContracts and futOiKnownContracts.
	futContracts []FutContract
	futKnown     *omap[string, FutContract]
	// chainMinuteSnaps / chainHourSnaps, ascending by t.
	chainMin  []*ChainSnapshot
	chainHour []*ChainSnapshot

	partialRepairs    map[string]repairMark
	headRepairs       map[string]repairMark
	prevCloseAttempts struct {
		day string
		n   int
	}
	closedDayLogged string

	oiBackfillRunning        bool
	futBackfillRunning       bool
	prevCloseBackfillRunning bool

	// Write-behind buffer (pendingHashWrites / pendingPlainWrites / flushInFlight /
	// flushAgain / ttlRefreshedAt) and the redis.ts transport state.
	pendingHash         *omap[string, *pendingHash]
	pendingPlain        *omap[string, plainWrite]
	flushInFlight       bool
	flushAgain          bool
	flushDone           chan struct{}
	ttlRefreshedAt      map[string]int64
	consecutiveFailures int
	mutedUntil          int64
	warnedDisabled      bool

	// Lifecycle.
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	started    bool
	stopped    bool
	tickTimer  Timer
	gapTimer   Timer
	flushTimer Timer

	// onFlushOps sees every flush's commands before they are sent (tests only).
	onFlushOps func(ops []cacheOp)
}

// New builds the service. Work starts through Boot and active-broker ready events.
func New(d Deps) *Service {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.AfterFunc == nil {
		d.AfterFunc = func(dur time.Duration, f func()) Timer { return time.AfterFunc(dur, f) }
	}
	if d.Sleep == nil {
		d.Sleep = sleepCtx
	}
	if d.Logf == nil {
		d.Logf = log.Printf
	}
	if d.SendError == nil {
		d.SendError = DefaultSendError(d.KiteAuthFailed)
	}
	extra := map[string]bool{}
	for k, v := range d.ExtraSessionDays {
		if v {
			extra[k] = true
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		d:              d,
		extra:          extra,
		futKnown:       newOmap[string, FutContract](),
		partialRepairs: map[string]repairMark{},
		headRepairs:    map[string]repairMark{},
		pendingHash:    newOmap[string, *pendingHash](),
		pendingPlain:   newOmap[string, plainWrite](),
		ttlRefreshedAt: map[string]int64{},
		ctx:            ctx,
		cancel:         cancel,
		backfillOwners: map[*bool]uint64{},
	}
	s.syncNamespace()
	return s
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) nowMs() int64 { return s.d.Now().UnixMilli() }

func (s *Service) logf(format string, args ...any) { s.d.Logf(format, args...) }

// captureAllowed checks the configured data-readiness gate.
func (s *Service) captureAllowed(what string) bool {
	if s.d.CaptureAllowed == nil {
		return false
	}
	return s.d.CaptureAllowed(what)
}

// goAsync is `void (async () => …)()`: f runs on its own goroutine with the service
// context. Nothing starts once the service is stopped.
func (s *Service) goAsync(f func(ctx context.Context)) {
	ctx, _, cleanup, valid := s.beginOperation(s.ctx)
	if !valid {
		return
	}
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		cleanup()
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		defer cleanup()
		// Run cleanup/deferred ownership handling even if this scope was
		// superseded before dispatch. Each reader rejects the stale context.
		f(ctx)
	}()
}

func (s *Service) instruments(ctx context.Context) ([]market.Instrument, error) {
	if err := s.checkOperation(ctx); err != nil {
		return nil, err
	}
	if s.d.Instruments == nil {
		return nil, nil
	}
	rows, err := s.d.Instruments(ctx)
	if err == nil {
		err = s.checkOperation(ctx)
	}
	return rows, err
}

func (s *Service) quoteFull(ctx context.Context, ids []string) ([]kite.FullQuote, error) {
	if err := s.checkOperation(ctx); err != nil {
		return nil, err
	}
	if s.d.QuoteFull == nil {
		return nil, errNotConfigured("QuoteFull")
	}
	quotes, err := s.d.QuoteFull(ctx, ids)
	if err == nil {
		err = s.checkOperation(ctx)
	}
	return quotes, err
}

func (s *Service) historical(ctx context.Context, token int64, from, to, interval string) ([]kite.ClosePoint, error) {
	if err := s.checkOperation(ctx); err != nil {
		return nil, err
	}
	if s.d.Historical == nil {
		return nil, errNotConfigured("Historical")
	}
	rows, err := s.d.Historical(ctx, token, from, to, interval, kite.Background)
	if err == nil {
		err = s.checkOperation(ctx)
	}
	return rows, err
}

func (s *Service) historicalOiSeries(ctx context.Context, token int64, from, to, interval string) ([]kite.OISeriesPoint, error) {
	if err := s.checkOperation(ctx); err != nil {
		return nil, err
	}
	if s.d.HistoricalOiSeries == nil {
		return nil, errNotConfigured("HistoricalOiSeries")
	}
	rows, err := s.d.HistoricalOiSeries(ctx, token, from, to, interval, kite.Background)
	if err == nil {
		err = s.checkOperation(ctx)
	}
	return rows, err
}

type notConfigured string

func (e notConfigured) Error() string { return "analytics: " + string(e) + " is not configured" }

func errNotConfigured(what string) error { return notConfigured(what) }
