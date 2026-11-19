package spike

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

type Deps struct {
	Namespace   func() brokers.Namespace
	Ready       func() bool
	Instruments func(context.Context) ([]market.Instrument, error)
	SetTokens   func([]int64)
	Store       *Store
	Now         func() time.Time
}

type quote struct {
	LTP, VWAP, Bid, Ask, BidQty, AskQty float64
	PriceAt, BookAt                     int64
	Volume                              *float64 // last known cumulative day volume; nil until observed
}

func (q quote) freshBook(now int64) bool {
	return q.BookAt > 0 && now >= q.BookAt && now-q.BookAt <= bookAgeMs &&
		finite(q.Bid) && finite(q.Ask) && q.Bid > 0 && q.Ask >= q.Bid &&
		finite(q.BidQty) && finite(q.AskQty) && q.BidQty >= 0 && q.AskQty >= 0
}

type candidate struct {
	Trade     Trade
	Namespace brokers.Namespace
}

type Engine struct {
	d      Deps
	mu     sync.Mutex
	opMu   sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	started   bool
	stopped   bool
	loaded    bool
	active    bool
	connected bool
	paper     bool

	day, lastError string
	namespace      brokers.Namespace
	universes      map[string]universe
	wanted         map[int64]bool
	quotes         map[int64]quote
	views          map[string]IndexView
	previous       map[string]Sample
	windows        map[string]*priceWindow
	armed          map[string]*armedState
	spotTokens     map[int64]string
	spots          map[string]spotHistory
	forming        map[string]Bar
	chartVWAP      map[string]*chartVWAPAccumulator
	bars           map[string]map[int64]Bar
	pendingBars    map[string]Bar
	open           map[string]Trade
	closed         []Trade
	pending        map[string]string
	refresh        chan struct{}
	candidates     chan candidate
	watchers       map[uint64]chan Snapshot
	watchSeq       uint64
}

func New(d Deps) *Engine {
	if d.Now == nil {
		d.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &Engine{d: d, ctx: ctx, cancel: cancel, paper: true,
		universes: map[string]universe{}, wanted: map[int64]bool{}, quotes: map[int64]quote{}, views: map[string]IndexView{},
		previous: map[string]Sample{}, windows: map[string]*priceWindow{}, forming: map[string]Bar{}, bars: map[string]map[int64]Bar{},
		chartVWAP: map[string]*chartVWAPAccumulator{},
		armed:     map[string]*armedState{}, spotTokens: map[int64]string{}, spots: map[string]spotHistory{},
		pendingBars: map[string]Bar{}, open: map[string]Trade{}, pending: map[string]string{}, closed: []Trade{},
		refresh: make(chan struct{}, 1), candidates: make(chan candidate, 2), watchers: map[uint64]chan Snapshot{}}
	for _, symbol := range Symbols {
		e.views[symbol] = IndexView{Symbol: symbol, Note: "Waiting for Dhan data"}
		e.bars[symbol] = map[int64]Bar{}
	}
	return e
}

func (e *Engine) now() int64 { return e.d.Now().UnixMilli() }
func (e *Engine) namespaceNow() brokers.Namespace {
	if e.d.Namespace != nil {
		return e.d.Namespace()
	}
	return brokers.Namespace{Broker: brokers.Dhan}
}
func (e *Engine) dataReady() bool {
	return e.namespaceNow().Broker == brokers.Dhan && e.d.Ready != nil && e.d.Ready()
}
func (e *Engine) dbEnabled() bool { return e.d.Store.Enabled() }

func (e *Engine) Start(ctx context.Context) error {
	e.mu.Lock()
	if e.started || e.stopped {
		e.mu.Unlock()
		return nil
	}
	e.started = true
	e.wg.Add(1)
	e.mu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(e.ctx, cancel)
	defer stop()
	if err := e.reconcile(ctx); err != nil {
		e.setError(err)
	}
	go e.run()
	return nil
}

func (e *Engine) run() {
	defer e.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	refresh := time.NewTicker(5 * time.Minute)
	defer refresh.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case cand := <-e.candidates:
			e.enter(cand)
		case <-e.refresh:
			if err := e.reconcile(e.ctx); err != nil {
				e.setError(err)
			}
		case <-refresh.C:
			if err := e.reconcile(e.ctx); err != nil {
				e.setError(err)
			}
		case <-ticker.C:
			e.mu.Lock()
			needs := !e.loaded || e.day != dayKey(e.now()) || e.namespace != e.namespaceNow() || e.active != e.dataReady()
			e.completeBarsLocked(e.now(), false)
			e.updateMarksLocked(e.now())
			e.publishLocked()
			e.mu.Unlock()
			if needs {
				if err := e.reconcile(e.ctx); err != nil {
					e.setError(err)
				}
			}
			e.flushBars()
		}
	}
}

// Feed continuity resets discard quote/spot history, but day qualification and
// an already measured direction pin remain latched until consumed or day load.
func (e *Engine) resetSpotHistoryLocked() {
	e.spots = map[string]spotHistory{}
}

func sameSpotTokens(a, b map[int64]string) bool {
	if len(a) != len(b) {
		return false
	}
	for token, symbol := range a {
		if b[token] != symbol {
			return false
		}
	}
	return true
}

func (e *Engine) OnRuntimeReady() {
	e.mu.Lock()
	e.quotes, e.previous = map[int64]quote{}, map[string]Sample{}
	e.resetSpotHistoryLocked()
	e.updateMarksLocked(e.now())
	e.mu.Unlock()
	select {
	case e.refresh <- struct{}{}:
	default:
	}
}
func (e *Engine) setError(err error) {
	if err == nil {
		return
	}
	e.mu.Lock()
	e.lastError = err.Error()
	e.publishLocked()
	e.mu.Unlock()
	log.Printf("[Spike] %s", err)
}

func (e *Engine) reconcile(parent context.Context) error {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	now, namespace := e.now(), e.namespaceNow()
	e.mu.Lock()
	if e.stopped {
		e.mu.Unlock()
		return nil
	}
	load := !e.loaded || e.day != dayKey(now)
	e.mu.Unlock()
	if load {
		e.flushBars()
		enabled, open, closed, bars, err := e.d.Store.Load(ctx, dayKey(now))
		if err != nil {
			return err
		}
		e.mu.Lock()
		e.day, e.paper, e.loaded = dayKey(now), enabled, true
		e.open, e.closed = map[string]Trade{}, closed
		for _, trade := range open {
			e.open[trade.Symbol] = trade
		}
		e.bars, e.windows, e.forming = map[string]map[int64]Bar{}, map[string]*priceWindow{}, map[string]Bar{}
		e.chartVWAP = map[string]*chartVWAPAccumulator{}
		e.armed = map[string]*armedState{}
		for _, symbol := range Symbols {
			e.bars[symbol] = map[int64]Bar{}
			e.windows[symbol] = &priceWindow{}
			view := e.views[symbol]
			view.RecordingSince = nil
			e.views[symbol] = view
		}
		for _, bar := range bars {
			e.bars[bar.Symbol][bar.T] = bar
			if now-bar.T <= WindowMs && bar.T <= now {
				points := []Sample{}
				if bar.LowAt > 0 {
					points = append(points, Sample{T: bar.LowAt, Premium: bar.Low})
				}
				if bar.HighAt > 0 {
					points = append(points, Sample{T: bar.HighAt, Premium: bar.High})
				}
				if len(points) == 0 {
					points = append(points, bar.Sample)
				}
				sort.Slice(points, func(i, j int) bool { return points[i].T < points[j].T })
				for _, point := range points {
					e.windows[bar.Symbol].Add(point)
				}
			}
			view := e.views[bar.Symbol]
			if view.RecordingSince == nil {
				at := bar.T
				view.RecordingSince = &at
				e.views[bar.Symbol] = view
			}
		}
		e.quotes, e.previous = map[int64]quote{}, map[string]Sample{}
		e.resetSpotHistoryLocked()
		e.mu.Unlock()
	}
	if !e.dataReady() {
		e.mu.Lock()
		e.active, e.connected, e.namespace = false, false, namespace
		e.quotes, e.previous, e.pending = map[int64]quote{}, map[string]Sample{}, map[string]string{}
		e.resetSpotHistoryLocked()
		for _, symbol := range Symbols {
			view := e.views[symbol]
			view.Note = "Waiting for active Dhan session"
			e.views[symbol] = view
		}
		e.publishLocked()
		e.mu.Unlock()
		if e.d.SetTokens != nil {
			e.d.SetTokens(nil)
		}
		return nil
	}
	if e.d.Instruments == nil {
		return fmt.Errorf("Spike instrument provider is unavailable")
	}
	all, err := e.d.Instruments(brokers.WithNamespace(ctx, namespace))
	if err != nil {
		return err
	}
	universes := buildUniverses(all, dayKey(now))
	spotTokens := resolveSpotTokens(all)
	wanted := map[int64]bool{}
	for token := range spotTokens {
		wanted[token] = true
	}
	for _, u := range universes {
		for _, row := range append(append([]market.Instrument{}, u.Calls...), u.Puts...) {
			wanted[row.InstrumentToken] = true
		}
	}
	e.mu.Lock()
	for _, trade := range e.open {
		wanted[trade.Short.Token], wanted[trade.Hedge.Token] = true, true
	}
	if e.stopped || namespace != e.namespaceNow() {
		e.mu.Unlock()
		return nil
	}
	if len(wanted) > maxTokens {
		e.mu.Unlock()
		return fmt.Errorf("Spike full chains exceed the dedicated feed's %d-token limit", maxTokens)
	}
	continuityReset := load || e.namespace != namespace || !sameSpotTokens(e.spotTokens, spotTokens)
	if e.namespace != namespace {
		e.quotes, e.previous, e.pending = map[int64]quote{}, map[string]Sample{}, map[string]string{}
		e.resetSpotHistoryLocked()
	}
	if !sameSpotTokens(e.spotTokens, spotTokens) {
		e.resetSpotHistoryLocked()
	}
	e.spotTokens = spotTokens
	e.namespace, e.active, e.universes, e.wanted, e.lastError = namespace, true, universes, wanted, ""
	for _, symbol := range Symbols {
		u, view := universes[symbol], e.views[symbol]
		view.Expiry, view.Pairs = u.Expiry, len(u.Pairs)
		// Preserve the evaluated note and qualification/pin on an unchanged refresh.
		if continuityReset || view.Current == nil || e.previous[symbol].T == 0 {
			view.Note = "Waiting for full WebSocket quotes"
		}
		if len(u.Pairs) > 0 {
			view.LotSize = int(u.Pairs[0].CE.LotSize)
		} else {
			view.Note = "No paired options found for nearest expiry"
		}
		e.views[symbol] = view
	}
	tokens := make([]int64, 0, len(wanted))
	for token := range wanted {
		tokens = append(tokens, token)
	}
	sort.Slice(tokens, func(i, j int) bool { return tokens[i] < tokens[j] })
	e.publishLocked()
	e.mu.Unlock()
	if e.d.SetTokens != nil {
		e.d.SetTokens(tokens)
	}
	return nil
}

func (e *Engine) Invalidate() {
	e.mu.Lock()
	e.active, e.connected = false, false
	e.quotes, e.previous, e.pending = map[int64]quote{}, map[string]Sample{}, map[string]string{}
	e.resetSpotHistoryLocked()
	e.publishLocked()
	e.mu.Unlock()
	e.OnRuntimeReady()
}

func (e *Engine) OnConnection(connected bool) {
	e.mu.Lock()
	e.connected = connected
	if !connected {
		e.quotes, e.previous = map[int64]quote{}, map[string]Sample{}
		e.resetSpotHistoryLocked()
		e.updateMarksLocked(e.now())
	}
	e.publishLocked()
	e.mu.Unlock()
}

func (e *Engine) OnTicks(ticks []market.Tick) {
	now, namespace := e.now(), e.namespaceNow()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopped || !e.active || !e.connected || e.namespace != namespace || namespace.Broker != brokers.Dhan || e.day != dayKey(now) {
		return
	}
	optionUpdate := false
	for _, tick := range ticks {
		if !e.wanted[tick.Token] || (tick.Namespace != nil && *tick.Namespace != namespace) {
			continue
		}
		if symbol, isSpot := e.spotTokens[tick.Token]; isSpot {
			if tick.PriceUpdated == nil || *tick.PriceUpdated {
				history := e.spots[symbol]
				history.add(spotSample{T: now, Price: tick.LastPrice})
				e.spots[symbol] = history
			}
			continue
		}
		optionUpdate = true
		q := e.quotes[tick.Token]
		if (tick.PriceUpdated == nil || *tick.PriceUpdated) && tick.LastPrice > 0 && finite(tick.LastPrice) {
			q.LTP, q.PriceAt = tick.LastPrice, now
		} else if tick.PriceUpdated != nil && *tick.PriceUpdated {
			q.LTP, q.PriceAt = 0, 0
		}
		if (tick.AverageUpdated == nil || *tick.AverageUpdated) && tick.AveragePrice != nil {
			q.VWAP = 0
			if *tick.AveragePrice > 0 && finite(*tick.AveragePrice) {
				q.VWAP = *tick.AveragePrice
			}
		}
		if tick.VolumeUpdated != nil && *tick.VolumeUpdated && tick.Volume != nil && *tick.Volume >= 0 && finite(*tick.Volume) {
			volume := *tick.Volume
			q.Volume = &volume
		}
		if tick.DepthUpdated != nil && *tick.DepthUpdated {
			q.Bid, q.Ask, q.BidQty, q.AskQty, q.BookAt = tick.Bid, tick.Ask, 0, 0, now
			if len(tick.Bids) > 0 {
				q.BidQty = tick.Bids[0].Qty
			}
			if len(tick.Asks) > 0 {
				q.AskQty = tick.Asks[0].Qty
			}
		}
		e.quotes[tick.Token] = q
	}
	e.completeBarsLocked(now, false)
	e.updateMarksLocked(now)
	if !marketOpen(now) || !optionUpdate {
		return
	}
	for _, symbol := range Symbols {
		e.evaluateLocked(symbol, now)
	}
}

func (e *Engine) evaluateLocked(symbol string, now int64) {
	u, view := e.universes[symbol], e.views[symbol]
	var minimum *pair
	var sample Sample
	for i := range u.Pairs {
		p := &u.Pairs[i]
		ce, pe := e.quotes[p.CE.InstrumentToken], e.quotes[p.PE.InstrumentToken]
		if ce.PriceAt == 0 || pe.PriceAt == 0 || now-ce.PriceAt > quoteAgeMs || now-pe.PriceAt > quoteAgeMs {
			continue
		}
		premium := ce.LTP + pe.LTP
		if !finite(premium) || premium <= 0 {
			continue
		}
		if minimum == nil || premium < sample.Premium {
			minimum = p
			sample = Sample{T: now, Premium: premium, Strike: p.CE.Strike, Expiry: u.Expiry, CEToken: p.CE.InstrumentToken, PEToken: p.PE.InstrumentToken}
			if ce.VWAP > 0 && pe.VWAP > 0 {
				sample.VWAP = ce.VWAP + pe.VWAP
			}
		}
	}
	if minimum == nil {
		view.Note = "Waiting for fresh paired option prices"
		e.views[symbol] = view
		return
	}
	view.Current, view.LotSize = &sample, int(minimum.CE.LotSize)
	if view.RecordingSince == nil {
		at := now
		view.RecordingSince = &at
	}
	chartVWAP := e.chartVWAPAtLocked(symbol, now)
	previous := e.previous[symbol]
	previousChartVWAP := e.chartVWAPAtLocked(symbol, previous.T)
	view.Note = "Monitoring for +5% qualification"
	window := e.windows[symbol]
	if window == nil {
		window = &priceWindow{}
		e.windows[symbol] = window
	}
	history := e.spots[symbol]
	history.prune(now)
	e.spots[symbol] = history
	_, open := e.open[symbol]
	if open || e.pending[symbol] != "" {
		delete(e.armed, symbol)
		view.Note = "Primary paper spread already open or pending"
	} else {
		state, triggered, note := advanceArmed(e.armed[symbol], previous, sample, window.References(now), previousChartVWAP, chartVWAP, history)
		view.Note = note
		if state == nil {
			delete(e.armed, symbol)
		} else {
			e.armed[symbol] = state
		}
		if chartVWAP <= 0 {
			view.Note = "Waiting for first completed chart bar with valid VWAP"
		}
		if triggered != nil {
			spotNow := history.atOrBefore(now)
			// Direction is fixed at the first pin, but entry still needs fresh
			// current spot to select its ATM contracts.
			if spotNow.T <= 0 || spotNow.T > now || now-spotNow.T > quoteAgeMs || spotNow.Price <= 0 || !finite(spotNow.Price) {
				view.Note = "Signal skipped: underlying spot was unavailable or stale"
			} else {
				signal := Signal{Direction: triggered.Direction, T: now, Reference: triggered.Reference.Premium, ReferenceAt: triggered.Reference.T,
					MovePct: (sample.Premium/triggered.Reference.Premium - 1) * 100, Premium: sample.Premium, VWAP: chartVWAP}
				view.Signal = &signal
				view.Note = note
				if !e.paper {
					view.Note = "Signal observed; paper entries paused"
				} else if !e.dbEnabled() {
					view.Note = "Paper entry needs PostgreSQL"
				} else if atm, ok := atmPair(u, spotNow.Price); !ok {
					view.Note = "Signal skipped: no listed ATM strike for underlying spot"
				} else {
					// Sell the strike nearest spot, not the minimum-straddle strike.
					short, hedge, exists := creditSpreadLegs(u, atm, signal.Direction)
					if !exists {
						view.Note = "Qualified signal has no fourth-OTM hedge"
					} else if trade, err := e.tradeAtCrossLocked(symbol, short, hedge, signal, now); err != nil {
						view.Note = err.Error()
					} else {
						select {
						case e.candidates <- candidate{trade, e.namespace}:
							e.pending[symbol] = trade.ID
							view.Note = "Saving one-lot paper spread"
						default:
							view.Note = "Paper entry queue is busy"
						}
					}
				}
			}
		}
	}
	window.Add(sample)
	e.previous[symbol], e.views[symbol] = sample, view
	// A tick exactly on a minute boundary belongs to the next forming bucket.
	// Completed-bar timestamps still use inclusive bucketEnd in Series.
	end := bucketEnd(now+1, 1)
	bar, exists := e.forming[symbol]
	if !exists || bar.T != end {
		bar = Bar{Symbol: symbol, Day: e.day, Low: sample.Premium, High: sample.Premium, LowAt: now, HighAt: now}
	}
	bar.Sample = sample
	bar.T = end
	if sample.Premium < bar.Low {
		bar.Low, bar.LowAt = sample.Premium, now
	}
	if sample.Premium > bar.High {
		bar.High, bar.HighAt = sample.Premium, now
	}
	e.forming[symbol] = bar
}

func (e *Engine) tradeAtCrossLocked(symbol string, short, hedge market.Instrument, signal Signal, now int64) (Trade, error) {
	lot := int(short.LotSize)
	if lot <= 0 || float64(lot) != short.LotSize || hedge.LotSize != short.LotSize {
		return Trade{}, fmt.Errorf("Contract lot sizes are unavailable or differ")
	}
	a, b := e.quotes[short.InstrumentToken], e.quotes[hedge.InstrumentToken]
	if !a.freshBook(now) || !b.freshBook(now) || a.BidQty < float64(lot) || b.AskQty < float64(lot) {
		return Trade{}, fmt.Errorf("Signal skipped: fresh one-lot executable depth is unavailable")
	}
	if a.Bid < b.Ask {
		return Trade{}, fmt.Errorf("Signal skipped: hedge is not a credit spread at the observed touch")
	}
	return Trade{ID: db.NewIDAt(time.UnixMilli(now)), Symbol: symbol, Status: "open", Direction: signal.Direction, Expiry: short.Expiry,
		LotSize: lot, Quantity: lot, OpenedAt: now, Short: Leg{Token: short.InstrumentToken, Symbol: short.Tradingsymbol, Strike: short.Strike, Entry: a.Bid},
		Hedge: Leg{Token: hedge.InstrumentToken, Symbol: hedge.Tradingsymbol, Strike: hedge.Strike, Entry: b.Ask}, Signal: signal,
		EntryCredit: float64(lot) * (a.Bid - b.Ask), MarkStale: true}, nil
}

func (e *Engine) enter(cand candidate) {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	e.mu.Lock()
	valid := !e.stopped && e.paper && e.active && e.connected && e.dataReady() && e.namespace == cand.Namespace && e.namespaceNow() == cand.Namespace && e.now()-cand.Trade.OpenedAt <= 5000
	_, already := e.open[cand.Trade.Symbol]
	e.mu.Unlock()
	var err error
	if valid && !already {
		ctx, cancel := context.WithTimeout(e.ctx, 5*time.Second)
		err = e.d.Store.Insert(ctx, cand.Trade)
		cancel()
	}
	e.mu.Lock()
	if e.pending[cand.Trade.Symbol] == cand.Trade.ID {
		delete(e.pending, cand.Trade.Symbol)
	}
	if valid && !already && err == nil {
		e.open[cand.Trade.Symbol] = cand.Trade
		delete(e.armed, cand.Trade.Symbol)
		view := e.views[cand.Trade.Symbol]
		view.Note = "Primary one-lot paper spread open"
		e.views[cand.Trade.Symbol] = view
		e.updateMarksLocked(e.now())
	}
	if err != nil {
		e.lastError = err.Error()
	}
	e.publishLocked()
	e.mu.Unlock()
}

func (e *Engine) updateMarksLocked(now int64) {
	for symbol, trade := range e.open {
		a, b := e.quotes[trade.Short.Token], e.quotes[trade.Hedge.Token]
		trade.MarkStale = !e.active || !e.connected || !e.dataReady() || e.namespace != e.namespaceNow() ||
			!a.freshBook(now) || !b.freshBook(now) || a.AskQty < float64(trade.Quantity) || b.BidQty < float64(trade.Quantity)
		if !trade.MarkStale {
			short, hedge, pnl, at := a.Ask, b.Bid, grossPNL(trade, a.Ask, b.Bid), now
			trade.MarkShort, trade.MarkHedge, trade.PNL, trade.MarkAt = &short, &hedge, &pnl, &at
			trade.updatePeak(pnl, at)
		}
		e.open[symbol] = trade
	}
}

// chartVWAPAtLocked uses the latest completed bar at this sample's time, including
// bars restored by reconcile. Never fall back to an older valid stamp when the
// latest bar has no VWAP, or to the non-persisted volume accumulator.
func (e *Engine) chartVWAPAtLocked(symbol string, at int64) float64 {
	var latest Bar
	for _, bar := range e.bars[symbol] {
		if bar.Day == e.day && bar.T <= at && bar.T > latest.T {
			latest = bar
		}
	}
	if latest.VWAP > 0 && finite(latest.VWAP) {
		return latest.VWAP
	}
	return 0
}

func (e *Engine) completeBarsLocked(now int64, force bool) {
	for symbol, bar := range e.forming {
		if bar.T <= now || force {
			// Stamp only the chart copy; live samples retain their unrounded premium
			// and Dhan average-price sum. Rules read the completed chart stamp.
			bar.Premium = math.Round(bar.Premium*100) / 100
			acc := e.chartVWAP[symbol]
			if acc == nil {
				acc = &chartVWAPAccumulator{marks: map[int64]float64{}}
				e.chartVWAP[symbol] = acc
			}
			minuteVolume := func(token int64) float64 {
				current := e.quotes[token].Volume
				prior, ok := acc.marks[token]
				if current == nil || !ok {
					return 0
				}
				return math.Max(0, *current-prior)
			}
			weight := math.Min(minuteVolume(bar.CEToken), minuteVolume(bar.PEToken))
			if weight > 0 {
				acc.weighted += bar.Premium * weight
				acc.total += weight
			}
			bar.VWAP = 0
			if acc.total > 0 {
				bar.VWAP = acc.weighted / acc.total
			}
			// Mark every quoted token at each completion, including unselected
			// strikes, so a pair switch uses this minute's volume only. Missing
			// readings must establish a new baseline when they next appear.
			acc.marks = map[int64]float64{}
			for token, q := range e.quotes {
				if q.Volume != nil {
					acc.marks[token] = *q.Volume
				}
			}
			e.bars[symbol][bar.T] = bar
			e.pendingBars[fmt.Sprintf("%s:%s:%d", symbol, bar.Day, bar.T)] = bar
			delete(e.forming, symbol)
		}
	}
}

func (e *Engine) flushBars() {
	e.mu.Lock()
	pending := e.pendingBars
	e.pendingBars = map[string]Bar{}
	e.mu.Unlock()
	bars := make([]Bar, 0, len(pending))
	for _, bar := range pending {
		bars = append(bars, bar)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err := e.d.Store.SaveBars(ctx, bars)
	cancel()
	if err != nil {
		e.mu.Lock()
		for key, bar := range pending {
			if _, newer := e.pendingBars[key]; !newer {
				e.pendingBars[key] = bar
			}
		}
		e.lastError = err.Error()
		e.mu.Unlock()
	}
}

func (e *Engine) Stop(ctx context.Context) error {
	e.mu.Lock()
	if !e.stopped {
		e.stopped = true
		e.completeBarsLocked(e.now(), true)
		for id, ch := range e.watchers {
			close(ch)
			delete(e.watchers, id)
		}
	}
	e.mu.Unlock()
	e.cancel()
	done := make(chan struct{})
	go func() { e.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	}
	e.opMu.Lock()
	e.flushBars()
	e.opMu.Unlock()
	if e.d.SetTokens != nil {
		e.d.SetTokens(nil)
	}
	return nil
}
