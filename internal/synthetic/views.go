package synthetic

import (
	"math"
	"sort"
	"sync"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

/* ---------------------------------- views ----------------------------------- */

// GetOpportunities is the best limit rows of the full sorted list when limit is a
// positive number, else the capped set the stream publishes.
func (e *Engine) GetOpportunities(limit *float64) []*Opportunity {
	e.lock()
	defer e.unlock()
	if limit != nil && *limit > 0 { // `limit && limit > 0`
		n := math.Trunc(*limit) // slice(0, limit)
		all := e.opportunities
		if n < float64(len(all)) {
			all = all[:int(n)]
		}
		return append([]*Opportunity{}, all...)
	}
	return e.publishedOpportunitiesLocked()
}

// publishedOpportunitiesLocked: every ELIGIBLE row that could still be entered, then
// the best row of each underlying, then the next best, up to the cap.
func (e *Engine) publishedOpportunitiesLocked() []*Opportunity {
	all := e.opportunities
	if float64(len(all)) <= e.cfg.MaxPublishedOpportunities {
		return append([]*Opportunity{}, all...)
	}
	limit := e.cfg.MaxPublishedOpportunities
	picked := []*Opportunity{}
	taken := map[string]bool{}
	seen := map[string]bool{}
	take := func(o *Opportunity) {
		picked = append(picked, o)
		taken[o.Key] = true
		seen[o.Underlying] = true
	}
	for _, o := range all {
		if o.Status == StatusEligible && o.EntryBlocked != "position_open" {
			take(o)
		}
	}
	for _, o := range all {
		if float64(len(picked)) >= limit {
			break
		}
		if !taken[o.Key] && !seen[o.Underlying] {
			take(o)
		}
	}
	for _, o := range all {
		if float64(len(picked)) >= limit {
			break
		}
		if !taken[o.Key] {
			take(o)
		}
	}
	return SortOpportunities(picked)
}

// GetOpenPositions lists the open positions, oldest first, with their live marks.
func (e *Engine) GetOpenPositions() []OpenView {
	e.lock()
	defer e.unlock()
	return e.openPositionsLocked()
}

func (e *Engine) openPositionsLocked() []OpenView {
	ts := e.positions.values()
	sort.SliceStable(ts, func(i, j int) bool { return ts[i].OpenedAt < ts[j].OpenedAt })
	out := make([]OpenView, len(ts))
	for i, t := range ts {
		out[i] = e.openViewLocked(t)
	}
	return out
}

func (e *Engine) openViewLocked(t *Trade) OpenView {
	m := e.metrics[t.ID]
	rules := e.exitRules()
	v := OpenView{
		t:             t.Clone(),
		Linked:        !e.namespaceStale && !e.unlinked[t.ID],
		Closing:       e.closing[t.ID],
		MinExitNetPnl: rules.MinExitNetPnl,
	}
	if m == nil {
		v.ConvergenceThreshold = math.Max(rules.ConvergenceFloor, rules.ConvergencePct*t.EntryNetEdge)
		v.ProfitCaptureTarget = rules.ProfitCapturePct * t.EntryNetEdge
		return v
	}
	v.ExitLegs = append([]ExitLeg{}, m.Legs...)
	v.MtmLtp = m.MtmLtp
	// "If closed now" figures; exit_charges stays null until the trade is really closed.
	v.pnl = pnlOverride{gross: m.GrossPnl, total: m.TotalCharges, net: m.NetPnl}
	v.CurrentExitCharges = m.ExitCharges
	v.RemainingEdge = m.RemainingEdge
	v.CapturedEdge = m.CapturedEdge
	v.CapturedPct = m.CapturedPct
	v.ConvergenceThreshold = m.ConvergenceThreshold
	v.ProfitCaptureTarget = m.ProfitCaptureTarget
	v.ExpirySafety = m.ExpirySafety
	v.ExitEligible = m.ShouldExit
	v.ExitRuleReason = m.RuleReason
	v.ExitBlockedReason = m.BlockedReason
	return v
}

// HistoryView is the GET /trades/history body.
type HistoryView struct {
	DBEnabled bool        `json:"db_enabled"`
	Scope     string      `json:"scope"`
	Trades    []TradeView `json:"trades"`
}

func viewsOf(ts []*Trade) []TradeView {
	out := make([]TradeView, len(ts))
	for i, t := range ts {
		out[i] = toTradeView(t)
	}
	return out
}

// GetHistory lists closed paper trades, newest first: today from memory (or the whole
// list when storage is off), else the store merged with today's in-memory list.
func (e *Engine) GetHistory(scope string, limit int) (HistoryView, error) {
	e.lock()
	dbOn := e.deps.Store.Enabled()
	if scope == "today" || !dbOn {
		defer e.unlock()
		return HistoryView{DBEnabled: dbOn, Scope: scope, Trades: viewsOf(e.closedToday)}, nil
	}
	e.unlock()
	ctx, cancel := storeCtx()
	rows, err := e.deps.Store.LoadClosed(ctx, limit, nil)
	cancel()
	if err != nil {
		return HistoryView{}, err
	}
	e.lock()
	defer e.unlock()
	byID := &positionMap{m: map[string]*Trade{}} // insertion-ordered, as a JS Map
	for _, t := range rows {
		byID.set(t)
	}
	for _, t := range e.closedToday {
		byID.set(t)
	}
	trades := byID.values()
	sortByClosedDesc(trades)
	if limit < len(trades) {
		trades = trades[:max(0, limit)]
	}
	return HistoryView{DBEnabled: dbOn, Scope: scope, Trades: viewsOf(trades)}, nil
}

func (e *Engine) dayPnlLocked() DayPnl {
	ts := e.positions.values()
	open := make([]OpenMark, len(ts))
	for i, t := range ts {
		mk := OpenMark{Margin: t.Margin}
		if m := e.metrics[t.ID]; m != nil {
			mk.MtmLtp, mk.GrossPnl, mk.NetPnl = m.MtmLtp, m.GrossPnl, m.NetPnl
		}
		open[i] = mk
	}
	return ComputeDayPnl(e.closedDay, open, e.closedToday)
}

// StatusView is getStatus() (field order = JSON key order).
type StatusView struct {
	Running              bool       `json:"running"`
	MarketOpen           bool       `json:"market_open"`
	Authenticated        bool       `json:"authenticated"`
	Broker               string     `json:"broker"`
	DetectionOnly        bool       `json:"detection_only"`
	ExecutionMode        string     `json:"execution_mode"`
	PaperTrading         bool       `json:"paper_trading"`
	PaperBlockedReason   NullStr    `json:"paper_blocked_reason"`
	DBEnabled            bool       `json:"db_enabled"`
	StrikeLevel          int        `json:"strike_level"`
	PairedUnderlyings    int        `json:"paired_underlyings"`
	MonitoredUnderlyings int        `json:"monitored_underlyings"`
	SkippedForBudget     int        `json:"skipped_for_budget"`
	UnbuiltWindows       int        `json:"unbuilt_windows"`
	SubscribedTokens     int        `json:"subscribed_tokens"`
	ReadyBooks           int        `json:"ready_books"`
	TokenBudget          float64    `json:"token_budget"`
	BaseTokenBudget      float64    `json:"base_token_budget"`
	BorrowedFromBox      float64    `json:"borrowed_from_box"`
	BoxScannerRunning    *bool      `json:"box_scanner_running"`
	BoxLaneTokens        *float64   `json:"box_lane_tokens"`
	FeedAgeMs            *int64     `json:"feed_age_ms"`
	FeedHealthy          bool       `json:"feed_healthy"`
	UniverseAt           *int64     `json:"universe_at"`
	EvaluatedAt          *int64     `json:"evaluated_at"`
	CloseSessionDay      *string    `json:"close_session_day"`
	EligibleCount        int        `json:"eligible_count"`
	OpportunityCount     int        `json:"opportunity_count"`
	OpenCount            int        `json:"open_count"`
	MaxOpenPositions     float64    `json:"max_open_positions"`
	MarginEnabled        bool       `json:"margin_enabled"`
	UnlinkedPositions    int        `json:"unlinked_positions"`
	DayPnl               DayPnl     `json:"day_pnl"`
	RfPct                float64    `json:"rf_pct"`
	RfSource             string     `json:"rf_source"`
	LastError            *string    `json:"last_error"`
	Config               ConfigView `json:"config"`
}

// ConfigView is getConfigView() (field order = JSON key order).
type ConfigView struct {
	StrikeLevel               int          `json:"strike_level"`
	MinExpectedNetProfit      float64      `json:"min_expected_net_profit"`
	SafetyBuffer              float64      `json:"safety_buffer"`
	ExpectedSlippage          float64      `json:"expected_slippage"`
	IncludeCarry              bool         `json:"include_carry"`
	DefaultRfPct              float64      `json:"default_rf_pct"`
	QuoteMaxAgeMs             float64      `json:"quote_max_age_ms"`
	FeedMaxAgeMs              float64      `json:"feed_max_age_ms"`
	MaxTokens                 float64      `json:"max_tokens"`
	ShareBoxBudget            bool         `json:"share_box_budget"`
	LaneTokenLimit            float64      `json:"lane_token_limit"`
	MaxUnderlyings            float64      `json:"max_underlyings"`
	MaxPublishedOpportunities float64      `json:"max_published_opportunities"`
	EnableConversion          bool         `json:"enable_conversion"`
	EnableReversal            bool         `json:"enable_reversal"`
	SkipExpiryDay             bool         `json:"skip_expiry_day"`
	PaperTrading              bool         `json:"paper_trading"`
	MaxOpenPositions          float64      `json:"max_open_positions"`
	DefaultMaxOpenPositions   float64      `json:"default_max_open_positions"`
	SettingsPersisted         bool         `json:"settings_persisted"`
	SignalConfirmations       float64      `json:"signal_confirmations"`
	ReentryCooldownMs         float64      `json:"reentry_cooldown_ms"`
	ConvergenceFloor          float64      `json:"convergence_floor"`
	ConvergencePct            float64      `json:"convergence_pct"`
	MinExitNetPnl             float64      `json:"min_exit_net_pnl"`
	ProfitCapturePct          float64      `json:"profit_capture_pct"`
	MinCapturedPct            float64      `json:"min_captured_pct"`
	ExpirySafetyMinutes       float64      `json:"expiry_safety_minutes"`
	OptionRateVersion         string       `json:"option_rate_version"`
	FuturesRateVersion        string       `json:"futures_rate_version"`
	Tunable                   TuningLimits `json:"tunable"`
}

// GetStatus is getStatus().
func (e *Engine) GetStatus() StatusView {
	e.lock()
	defer e.unlock()
	return e.statusLocked()
}

// DBEnabled reports whether paper trades can be stored (status.db_enabled).
func (e *Engine) DBEnabled() bool { return e.deps.Store.Enabled() }

func (e *Engine) statusLocked() StatusView {
	now := e.nowMs()
	marketOpen := e.marketOpen()
	var feedAge *int64
	if e.lastRawTickAt != nil {
		feedAge = iptr(now - *e.lastRawTickAt)
	}
	budget := e.tokenBudgetLocked(nil)
	dbOn := e.deps.Store.Enabled()
	s := StatusView{
		Running:              e.running,
		MarketOpen:           marketOpen,
		Authenticated:        e.authenticated(),
		Broker:               e.activeBroker(),
		DetectionOnly:        !e.cfg.PaperTrading,
		ExecutionMode:        "paper_touch",
		PaperTrading:         e.cfg.PaperTrading && dbOn && e.storeReadyLocked(),
		DBEnabled:            dbOn,
		StrikeLevel:          e.strikeLevel,
		PairedUnderlyings:    len(e.chains),
		MonitoredUnderlyings: len(e.selection),
		SkippedForBudget:     e.skippedForBudget,
		UnbuiltWindows:       e.unbuiltCount,
		SubscribedTokens:     len(e.watched.list),
		ReadyBooks:           e.quotes.Size(),
		TokenBudget:          budget,
		BaseTokenBudget:      e.cfg.MaxTokens,
		BorrowedFromBox:      math.Max(0, budget-e.cfg.MaxTokens),
		FeedAgeMs:            feedAge,
		FeedHealthy:          !e.activeLocked() || !marketOpen || (feedAge != nil && float64(*feedAge) <= e.cfg.FeedMaxAgeMs),
		UniverseAt:           e.universeAt,
		EvaluatedAt:          e.evaluatedAt,
		OpportunityCount:     len(e.opportunities),
		OpenCount:            e.positions.size(),
		MaxOpenPositions:     e.maxOpenPositions,
		MarginEnabled:        e.deps.Margins != nil,
		DayPnl:               e.dayPnlLocked(),
		RfPct:                e.rfPctLocked(),
		RfSource:             "default",
		LastError:            e.lastError,
		Config:               e.configViewLocked(),
	}
	switch {
	case !e.cfg.PaperTrading:
		s.PaperBlockedReason = "disabled"
	case !dbOn:
		s.PaperBlockedReason = "no_db"
	case !e.settingsLoaded || !e.loaded:
		s.PaperBlockedReason = "loading"
	case !e.indexReady:
		s.PaperBlockedReason = "unsafe_index"
	}
	if e.deps.BoxLane != nil {
		lane := e.deps.BoxLane()
		s.BoxScannerRunning = &lane.Running
		s.BoxLaneTokens = fptr(lane.HeldTokens)
	}
	if !marketOpen {
		s.CloseSessionDay = e.closeSessionDay
	}
	for _, o := range e.opportunities {
		if o.Status == StatusEligible {
			s.EligibleCount++
		}
	}
	for _, id := range e.positions.ids {
		if e.unlinked[id] {
			s.UnlinkedPositions++
		}
	}
	if e.deps.GetRfPct() != nil {
		s.RfSource = "admin"
	}
	return s
}

// GetConfigView is getConfigView().
func (e *Engine) GetConfigView() ConfigView {
	e.lock()
	defer e.unlock()
	return e.configViewLocked()
}

func (e *Engine) configViewLocked() ConfigView {
	c := e.cfg
	return ConfigView{
		StrikeLevel:               e.strikeLevel,
		MinExpectedNetProfit:      e.minExpectedNetProfit,
		SafetyBuffer:              e.safetyBuffer,
		ExpectedSlippage:          c.ExpectedSlippage,
		IncludeCarry:              c.IncludeCarry,
		DefaultRfPct:              c.DefaultRfPct,
		QuoteMaxAgeMs:             c.QuoteMaxAgeMs,
		FeedMaxAgeMs:              c.FeedMaxAgeMs,
		MaxTokens:                 c.MaxTokens,
		ShareBoxBudget:            c.ShareBoxBudget,
		LaneTokenLimit:            c.LaneTokenLimit,
		MaxUnderlyings:            c.MaxUnderlyings,
		MaxPublishedOpportunities: c.MaxPublishedOpportunities,
		EnableConversion:          c.EnableConversion,
		EnableReversal:            c.EnableReversal,
		SkipExpiryDay:             c.SkipExpiryDay,
		PaperTrading:              c.PaperTrading,
		MaxOpenPositions:          e.maxOpenPositions,
		DefaultMaxOpenPositions:   c.MaxOpenPositions,
		SettingsPersisted:         !e.settingsDirty,
		SignalConfirmations:       c.SignalConfirmations,
		ReentryCooldownMs:         c.ReentryCooldownMs,
		ConvergenceFloor:          c.ConvergenceFloor,
		ConvergencePct:            c.ConvergencePct,
		MinExitNetPnl:             c.MinExitNetPnl,
		ProfitCapturePct:          c.ProfitCapturePct,
		MinCapturedPct:            c.MinCapturedPct,
		ExpirySafetyMinutes:       c.ExpirySafetyMinutes,
		OptionRateVersion:         c.OptionRates.RateVersion,
		FuturesRateVersion:        c.FuturesRates.RateVersion,
		Tunable:                   Limits,
	}
}

// ChainSide is SynthChainSide.
type ChainSide struct {
	Token         int64   `json:"token"`
	Tradingsymbol string  `json:"tradingsymbol"`
	Bid           float64 `json:"bid"`
	BidQty        float64 `json:"bid_qty"`
	Ask           float64 `json:"ask"`
	AskQty        float64 `json:"ask_qty"`
	Last          float64 `json:"last"`
	AgeMs         *int64  `json:"age_ms"`
}

// ChainStrike is one strike row of the chain view.
type ChainStrike struct {
	Strike float64   `json:"strike"`
	IsAtm  bool      `json:"is_atm"`
	CE     ChainSide `json:"ce"`
	PE     ChainSide `json:"pe"`
}

// ChainView is SynthChainView: the watched window of one underlying with live books.
type ChainView struct {
	Underlying string        `json:"underlying"`
	Name       string        `json:"name"`
	IsIndex    bool          `json:"is_index"`
	Expiry     string        `json:"expiry"`
	LotSize    float64       `json:"lot_size"`
	AtmStrike  float64       `json:"atm_strike"`
	StrikeStep float64       `json:"strike_step"`
	Future     ChainSide     `json:"future"`
	Strikes    []ChainStrike `json:"strikes"`
}

// GetChain is the watched window of one underlying, or nil when it is not monitored.
func (e *Engine) GetChain(underlying string) *ChainView {
	e.lock()
	defer e.unlock()
	w := e.windows[underlying]
	if w == nil {
		return nil
	}
	now := e.nowMs()
	marketOpen := e.marketOpen()
	side := func(token int64, tradingsymbol string) ChainSide {
		s := ChainSide{Token: token, Tradingsymbol: tradingsymbol}
		q, ok := e.quotes.Get(token)
		if ok {
			s.Bid, s.BidQty, s.Ask, s.AskQty = q.Bid, q.BidQty, q.Ask, q.AskQty
			s.AgeMs = iptr(now - q.At)
		}
		if ok && q.Last != 0 && !math.IsNaN(q.Last) { // `q?.last || (open ? 0 : close)`
			s.Last = q.Last
		} else if !marketOpen {
			s.Last = e.closes[token]
		}
		return s
	}
	v := &ChainView{
		Underlying: w.Underlying, Name: w.Name, IsIndex: w.IsIndex, Expiry: w.Expiry, LotSize: w.LotSize,
		AtmStrike: w.AtmStrike, StrikeStep: w.StrikeStep, Future: side(w.Future.Token, w.Future.Tradingsymbol),
		Strikes: make([]ChainStrike, 0, len(w.Strikes)),
	}
	for _, s := range w.Strikes {
		ce, pe := w.CE[s], w.PE[s]
		v.Strikes = append(v.Strikes, ChainStrike{
			Strike: s, IsAtm: s == w.AtmStrike,
			CE: side(ce.Token, ce.Tradingsymbol), PE: side(pe.Token, pe.Tradingsymbol),
		})
	}
	return v
}

/* ----------------------------------- SSE ------------------------------------ */

// sseClient is one stream. The engine queues frames; the request's own goroutine
// writes them, so a slow peer never holds the engine lock.
type sseClient struct {
	mu      sync.Mutex
	queue   [][]byte
	notify  chan struct{}
	ended   chan struct{}
	endOnce sync.Once
}

func newSSEClient() *sseClient {
	return &sseClient{notify: make(chan struct{}, 1), ended: make(chan struct{})}
}

// sseMaxBacklog bounds the frames queued for one stream. A client that has fallen this far
// behind (a stalled connection; at one snapshot a second, two minutes) is dropped, and its
// EventSource reconnects to a fresh snapshot, instead of the queue growing without bound.
// Node never dropped a client (its response buffer grew instead). A variable so the parity
// replay, which drains after every step, can lift it.
var sseMaxBacklog = 128

func (c *sseClient) push(frame []byte) {
	c.mu.Lock()
	overflow := len(c.queue) >= sseMaxBacklog
	if !overflow {
		c.queue = append(c.queue, frame)
	}
	c.mu.Unlock()
	if overflow {
		c.end()
		return
	}
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *sseClient) take() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	q := c.queue
	c.queue = nil
	return q
}

func (c *sseClient) end() { c.endOnce.Do(func() { close(c.ended) }) }

// snapshotView is the payload of the snapshot event.
type snapshotView struct {
	Status        StatusView     `json:"status"`
	Opportunities []*Opportunity `json:"opportunities"`
	OpenTrades    []OpenView     `json:"open_trades"`
}

func (e *Engine) snapshotLocked() snapshotView {
	return snapshotView{
		Status:        e.statusLocked(),
		Opportunities: e.publishedOpportunitiesLocked(),
		OpenTrades:    e.openPositionsLocked(),
	}
}

// addSSEClient registers a stream, queues its first snapshot and starts the shared
// publish timer. The returned function removes it (and stops the timer with the last).
func (e *Engine) addSSEClient() (*sseClient, func()) {
	c := newSSEClient()
	e.lock()
	defer e.unlock()
	e.sseClients[c] = struct{}{}
	if e.publishStop == nil {
		e.publishStop = e.rt.every(msDuration(e.cfg.PublishIntervalMs), e.Publish)
	}
	c.push(sseFrame("snapshot", e.snapshotLocked()))
	var once sync.Once
	return c, func() {
		once.Do(func() {
			e.lock()
			defer e.unlock()
			delete(e.sseClients, c)
			if len(e.sseClients) == 0 && e.publishStop != nil {
				e.publishStop()
				e.publishStop = nil
			}
		})
	}
}

// Publish pushes a snapshot to every stream.
func (e *Engine) Publish() {
	e.lock()
	defer e.unlock()
	e.publishLocked()
}

func (e *Engine) publishLocked() {
	if len(e.sseClients) == 0 {
		return
	}
	e.broadcastLocked("snapshot", e.snapshotLocked())
}

func (e *Engine) broadcastLocked(event string, payload any) {
	if len(e.sseClients) == 0 {
		return
	}
	frame := sseFrame(event, payload)
	for c := range e.sseClients {
		c.push(frame)
	}
}

// sseFrame is `event: <name>\ndata: <JSON.stringify(payload)>\n\n`.
func sseFrame(event string, payload any) []byte {
	b := jsjson.Marshal(payload)
	frame := make([]byte, 0, len(b)+len(event)+16)
	frame = append(frame, "event: "+event+"\ndata: "...)
	frame = append(frame, b...)
	frame = append(frame, "\n\n"...)
	return frame
}
