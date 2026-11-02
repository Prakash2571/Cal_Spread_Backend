package analytics

import (
	"context"
	"math"
	"sort"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// The once-a-minute captures and the previous-close baseline (index.ts :3572-3965,
// :4802-5019). All of them are Zerodha-only (CaptureAllowed).

// niftySel is niftyNearestExpiryOptions' result.
type niftySel struct {
	expiry    string
	spotToken int64
	meta      *tokenMeta
	ids       []string
	spotID    string
}

// uniqueSortedExpiries is Array.from(new Set(expiries.filter(e => e && e >= today))).sort().
func uniqueSortedExpiries(opts []market.Instrument, today string) []string {
	seen := map[string]bool{}
	var out []string
	for _, o := range opts {
		e := o.Expiry
		if e == "" || cmpUTF16(e, today) < 0 || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	jsSortStrings(out)
	return out
}

func isOption(i *market.Instrument) bool { return i.InstrumentType == "CE" || i.InstrumentType == "PE" }

// strikeTruthy is `!!o.strike`.
func strikeTruthy(s float64) bool { return s != 0 && !math.IsNaN(s) }

// niftyNearestExpiryOptions resolves the nearest NIFTY option expiry's tokens and
// strike/type metadata, or nil.
func niftyNearestExpiryOptions(all []market.Instrument, today string) *niftySel {
	var opts []market.Instrument
	for i := range all {
		o := &all[i]
		if o.Exchange == "NFO" && isOption(o) && o.Name == niftyUnderlying {
			opts = append(opts, *o)
		}
	}
	if len(opts) == 0 {
		return nil
	}
	expiries := uniqueSortedExpiries(opts, today)
	if len(expiries) == 0 {
		return nil
	}
	expiry := expiries[0]
	spot := findSpot(all, niftyUnderlying, false)
	if spot == nil {
		return nil
	}
	sel := &niftySel{expiry: expiry, spotToken: spot.InstrumentToken, meta: &tokenMeta{}, spotID: spot.Exchange + ":" + spot.Tradingsymbol}
	for _, o := range opts {
		if o.Expiry != expiry || !strikeTruthy(o.Strike) {
			continue
		}
		sel.meta.set(o.InstrumentToken, optMeta{strike: o.Strike, typ: o.InstrumentType})
		sel.ids = append(sel.ids, o.Exchange+":"+o.Tradingsymbol)
	}
	return sel
}

// findSpot resolves an underlying's spot instrument: the INDICES row of its index spot
// symbol, else (only when equityFallback) the NSE EQ row of the same name.
func findSpot(all []market.Instrument, underlying string, equityFallback bool) *market.Instrument {
	sym, ok := resolveIndexSpotSymbol(underlying, func(ts string) bool {
		for i := range all {
			if all[i].Segment == "INDICES" && all[i].Tradingsymbol == ts {
				return true
			}
		}
		return false
	})
	if ok {
		for i := range all {
			if all[i].Segment == "INDICES" && all[i].Tradingsymbol == sym {
				return &all[i]
			}
		}
		return nil
	}
	if !equityFallback {
		return nil
	}
	for i := range all {
		if all[i].Exchange == "NSE" && all[i].InstrumentType == "EQ" && all[i].Tradingsymbol == underlying {
			return &all[i]
		}
	}
	return nil
}

func quoteMap(quotes []kite.FullQuote) map[int64]kite.FullQuote {
	m := make(map[int64]kite.FullQuote, len(quotes))
	for _, q := range quotes {
		m[q.InstrumentToken] = q
	}
	return m
}

// noteMarketClosedLocked logs the holiday notice once per IST day.
func (s *Service) noteMarketClosedLocked(what, stamp string) {
	day := istDayKey(s.nowMs())
	if s.closedDayLogged == day {
		return
	}
	s.closedDayLogged = day
	s.logf("[OptionOI] %s looks like an exchange holiday — %s last traded at %s. Skipping capture; the frames stay untouched rather than gaining a day of carried-forward values. (Set EXTRA_SESSION_DAYS if this is wrong.)", day, what, stamp)
}

// captureOptionOi snapshots the nearest NIFTY expiry's OI/LTP and the index spot into the
// day cache, feeds the frames and the chain snapshots, and asks for the previous-close
// backfill when today has no baseline yet.
func (s *Service) captureOptionOi(ctx context.Context) {
	if !s.captureAllowed("option-OI capture") {
		return
	}
	// Stamped before any I/O, as in Node.
	now := s.nowMs()
	all, err := s.instruments(ctx)
	if err != nil {
		s.logf("[OptionOI] capture failed: %s", errText(err))
		return
	}
	sel := niftyNearestExpiryOptions(all, istDayKey(s.nowMs()))
	if sel == nil {
		return
	}
	day := istDayKey(s.nowMs())

	s.mu.Lock()
	if s.day == nil || s.day.day != day || s.day.expiry != sel.expiry {
		if s.day != nil && s.day.day != day && s.day.expiry == sel.expiry {
			s.snapshotPrevCloseLocked(s.day, day)
		}
		s.day = &oiDay{day: day, expiry: sel.expiry, spotToken: sel.spotToken, meta: sel.meta, series: map[int64][]oiSample{}}
	}
	store := s.day
	s.mu.Unlock()

	quotes, err := s.quoteFull(ctx, append([]string{sel.spotID}, sel.ids...))
	if err != nil {
		s.logf("[OptionOI] capture failed: %s", errText(err))
		return
	}
	qmap := quoteMap(quotes)

	s.mu.Lock()
	stamp := ""
	if q, ok := qmap[store.spotToken]; ok {
		stamp = q.LastTradeTime
	}
	if quoteDay(stamp, s.nowMs()) == 0 {
		s.noteMarketClosedLocked(niftyUnderlying+" spot", stamp)
		s.mu.Unlock()
		return
	}
	unseeded := map[int64]bool{}
	for _, tok := range store.meta.keys {
		q, ok := qmap[tok]
		arr := store.series[tok]
		var prev *oiSample
		if len(arr) > 0 {
			prev = &arr[len(arr)-1]
		}
		if !ok && prev == nil {
			unseeded[tok] = true
		}
		smp := oiSample{t: now}
		switch {
		case ok:
			smp.oi, smp.ltp = q.OI, q.LastPrice
		case prev != nil:
			smp.oi, smp.ltp = prev.oi, prev.ltp
		}
		store.series[tok] = append(arr, smp)
	}
	sp := spotSample{t: now}
	if q, ok := qmap[store.spotToken]; ok {
		sp.ltp = q.LastPrice
	} else if n := len(store.spot); n > 0 {
		sp.ltp = store.spot[n-1].ltp
	}
	store.spot = append(store.spot, sp)

	if agg, ok := s.currentWindowAggLocked(store, unseeded); ok {
		s.appendOiFrameLiveLocked(now, agg)
	}
	s.recordChainSnapshotLocked(store, now)

	needBaseline := (s.prevClose == nil || s.prevClose.ForDay != day) &&
		!s.prevCloseBackfillRunning && !s.oiBackfillRunning && !s.futBackfillRunning
	s.mu.Unlock()
	if needBaseline {
		s.voidBackfillPrevClose()
	}
}

// futSel is niftyMonthlyFutures' result.
type futSel struct {
	contracts []FutContract
	ids       []string
}

// niftyMonthlyFuturesLocked resolves the 3 nearest NIFTY futures (nearest first, one per
// expiry, expiring today or later) and remembers them.
func (s *Service) niftyMonthlyFuturesLocked(all []market.Instrument, today string) *futSel {
	var futs []market.Instrument
	for _, i := range all {
		if i.Exchange == "NFO" && i.InstrumentType == "FUT" && i.Name == niftyUnderlying && i.Expiry != "" && cmpUTF16(i.Expiry, today) >= 0 {
			futs = append(futs, i)
		}
	}
	sort.SliceStable(futs, func(a, b int) bool { return jsx.LocaleCompare(futs[a].Expiry, futs[b].Expiry) < 0 })
	if len(futs) == 0 {
		return nil
	}
	sel := &futSel{}
	seen := map[string]bool{}
	for _, f := range futs {
		if seen[f.Expiry] {
			continue
		}
		seen[f.Expiry] = true
		sel.contracts = append(sel.contracts, FutContract{Token: f.InstrumentToken, Tradingsymbol: f.Tradingsymbol, Expiry: f.Expiry, LotSize: f.LotSize})
		sel.ids = append(sel.ids, f.Exchange+":"+f.Tradingsymbol)
		if len(sel.contracts) == 3 {
			break
		}
	}
	s.rememberFutContractsLocked(sel.contracts)
	return sel
}

// rememberFutContractsLocked records every contract seen (keyed by expiry; a new token
// replaces the entry) and mirrors the set when it changed.
func (s *Service) rememberFutContractsLocked(contracts []FutContract) {
	changed := false
	for _, c := range contracts {
		known, ok := s.futKnown.Get(c.Expiry)
		if !ok || known.Token != c.Token {
			s.futKnown.Set(c.Expiry, c)
			changed = true
		}
	}
	if !changed || !s.cacheEnabled() {
		return
	}
	s.queuePlainWriteLocked("futcontracts", s.futKnown.Values(), (maxFrameRetentionMs()+redisTTLSlackMs)/1000)
}

// captureFuturesOi snapshots the 3 nearest NIFTY futures' OI and LTP into every frame;
// a leg with no positive value carries its last known one forward.
func (s *Service) captureFuturesOi(ctx context.Context) {
	if !s.captureAllowed("futures-OI capture") {
		return
	}
	now := s.nowMs()
	all, err := s.instruments(ctx)
	if err != nil {
		s.logf("[FuturesOI] capture failed: %s", errText(err))
		return
	}
	s.mu.Lock()
	sel := s.niftyMonthlyFuturesLocked(all, istDayKey(s.nowMs()))
	if sel == nil {
		s.mu.Unlock()
		return
	}
	s.futContracts = sel.contracts
	s.mu.Unlock()

	quotes, err := s.quoteFull(ctx, sel.ids)
	if err != nil {
		s.logf("[FuturesOI] capture failed: %s", errText(err))
		return
	}
	qmap := quoteMap(quotes)

	s.mu.Lock()
	defer s.mu.Unlock()
	stamp := ""
	if q, ok := qmap[sel.contracts[0].Token]; ok {
		stamp = q.LastTradeTime
	}
	if quoteDay(stamp, s.nowMs()) == 0 {
		s.noteMarketClosedLocked(niftyUnderlying+" futures", stamp)
		return
	}
	prevByExpiry := map[string]FutOiLeg{}
	if f := s.futFrames[0]; len(f) > 0 {
		for _, l := range f[len(f)-1].Legs {
			prevByExpiry[l.Expiry] = l
		}
	}
	legs := make([]FutOiLeg, len(sel.contracts))
	for i, c := range sel.contracts {
		q, ok := qmap[c.Token]
		p, hasP := prevByExpiry[c.Expiry]
		leg := FutOiLeg{Expiry: c.Expiry}
		if ok && q.OI > 0 {
			leg.OI = q.OI
		} else if hasP {
			leg.OI = p.OI
		}
		if ok && q.LastPrice > 0 {
			leg.LTP = q.LastPrice
		} else if hasP {
			leg.LTP = p.LTP
		}
		legs[i] = leg
	}
	s.appendFutOiFrameLiveLocked(now, legs)
}

// ---------------------------------------------------------------------------
// Previous-session close from daily candles (backfillPrevClose).

const prevCloseMaxAttempts = 4

// tryBeginPrevCloseBackfill is the synchronous head of backfillPrevClose: the IST day is
// read, the single-flight flag and the capture gate are checked and the flag is set.
func (s *Service) tryBeginPrevCloseBackfill() (today string, ok bool) {
	today = istDayKey(s.nowMs())
	s.mu.Lock()
	running := s.prevCloseBackfillRunning
	s.mu.Unlock()
	if running || !s.captureAllowed("previous-close backfill") {
		return today, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.prevCloseBackfillRunning {
		return today, false
	}
	s.prevCloseBackfillRunning = true
	return today, true
}

// voidBackfillPrevClose is `void backfillPrevClose()`.
func (s *Service) voidBackfillPrevClose() {
	today, ok := s.tryBeginPrevCloseBackfill()
	if !ok {
		return
	}
	s.mu.Lock()
	if s.stopped {
		s.prevCloseBackfillRunning = false
		s.mu.Unlock()
		return
	}
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		s.runPrevCloseBackfill(s.ctx, today)
	}()
}

// backfillPrevClose is `await backfillPrevClose()`.
func (s *Service) backfillPrevClose(ctx context.Context) {
	today, ok := s.tryBeginPrevCloseBackfill()
	if !ok {
		return
	}
	s.runPrevCloseBackfill(ctx, today)
}

type dayCandle = kite.OISeriesPoint

// lastPrevSession is the last candle (in array order) of a day before today.
func lastPrevSession(candles []dayCandle, today string) *dayCandle {
	var prev *dayCandle
	for i := range candles {
		if cmpUTF16(sliceUTF16(candles[i].T, 10), today) < 0 {
			prev = &candles[i]
		}
	}
	return prev
}

// jsFalsyNum is `!n` for a number.
func jsFalsyNum(n float64) bool { return n == 0 || math.IsNaN(n) }

func (s *Service) runPrevCloseBackfill(ctx context.Context, today string) {
	defer func() {
		s.mu.Lock()
		s.prevCloseBackfillRunning = false
		s.mu.Unlock()
	}()
	fail := func(err error) {
		s.logf("[OptionOI] previous-close backfill failed: %s", errText(err))
	}
	all, err := s.instruments(ctx)
	if err != nil {
		fail(err)
		return
	}
	sel := niftyNearestExpiryOptions(all, istDayKey(s.nowMs()))
	if sel == nil {
		return
	}

	s.mu.Lock()
	var have *PrevClose
	if s.prevClose != nil && s.prevClose.ForDay == today {
		have = s.prevClose
	}
	if have != nil && have.Expiry == sel.expiry && have.Complete {
		s.mu.Unlock()
		return
	}
	if s.prevCloseAttempts.day != today {
		s.prevCloseAttempts.day, s.prevCloseAttempts.n = today, 0
	}
	if s.prevCloseAttempts.n >= prevCloseMaxAttempts {
		s.mu.Unlock()
		return
	}
	s.prevCloseAttempts.n++
	attempt := s.prevCloseAttempts.n
	s.mu.Unlock()

	to := s.nowMs()
	from := to - 10*dayMs
	fromStr, toStr := istDateTime(from), istDateTime(to)

	l := frameLadder(sel.meta)
	if len(l.strikes) == 0 {
		return
	}
	s.mu.Lock()
	ref := 0.0
	if s.day != nil && len(s.day.spot) > 0 {
		ref = s.day.spot[len(s.day.spot)-1].ltp
	}
	s.mu.Unlock()
	if jsFalsyNum(ref) {
		ref = 0
		if q, err := s.quoteFull(ctx, []string{sel.spotID}); err == nil && len(q) > 0 {
			ref = q[0].LastPrice
		}
	}
	if jsFalsyNum(ref) {
		ref = 0
		if daily, err := s.historicalOiSeries(ctx, sel.spotToken, fromStr, toStr, "day"); err == nil {
			if p := lastPrevSession(daily, today); p != nil {
				ref = p.Close
			}
		}
	}
	if jsFalsyNum(ref) {
		s.logf("[OptionOI] Previous-close backfill: no spot reference.")
		return
	}
	atm := 0
	bestD := math.Inf(1)
	for k, st := range l.strikes {
		if d := math.Abs(st - ref); d < bestD {
			bestD = d
			atm = k
		}
	}
	bLo := max(0, atm-prevCloseBand)
	bHi := min(len(l.strikes)-1, atm+prevCloseBand)
	var wanted []int64
	for k := bLo; k <= bHi; k++ {
		if ce, ok := l.ceAt(l.strikes[k]); ok {
			wanted = append(wanted, ce)
		}
		if pe, ok := l.peAt(l.strikes[k]); ok {
			wanted = append(wanted, pe)
		}
	}

	tokens := map[int64]OiLtp{}
	var order []int64
	if have != nil && have.Expiry == sel.expiry {
		for _, tok := range have.Order {
			tokens[tok] = have.Tokens[tok]
			order = append(order, tok)
		}
	}
	votes := newOmap[string, int]()
	failed := 0
	for _, tok := range wanted {
		if _, ok := tokens[tok]; ok {
			continue
		}
		candles, err := s.historicalOiSeries(ctx, tok, fromStr, toStr, "day")
		if err != nil {
			failed++
		} else if p := lastPrevSession(candles, today); p != nil && p.OI > 0 {
			if _, dup := tokens[tok]; !dup {
				order = append(order, tok)
			}
			tokens[tok] = OiLtp{OI: p.OI, LTP: p.Close}
			d := sliceUTF16(p.T, 10)
			n, _ := votes.Get(d)
			votes.Set(d, n+1)
		}
		if err := s.d.Sleep(ctx, 220*msDur); err != nil {
			return
		}
	}

	if len(tokens) == 0 {
		s.logf("[OptionOI] Previous-close backfill found no data (attempt %d/%d).", attempt, prevCloseMaxAttempts)
		return
	}
	closedOn := ""
	if have != nil {
		closedOn = have.ClosedOn
	}
	top := 0
	for _, d := range votes.Keys() {
		if n, _ := votes.Get(d); n > top {
			top = n
			closedOn = d
		}
	}
	label := closedOn
	if label == "" {
		label = "unknown"
	}
	pc := &PrevClose{ForDay: today, ClosedOn: label, Expiry: sel.expiry, Complete: failed == 0, Tokens: tokens, Order: jsTokenOrder(order)}
	s.mu.Lock()
	s.prevClose = pc
	s.persistPrevCloseLocked()
	s.mu.Unlock()
	tail := ""
	if failed > 0 {
		tail = ", " + itoa(failed) + " failed — will retry"
	}
	s.logf("[OptionOI] Backfilled %s close for %d/%d band tokens (baseline for %s%s).", closedOn, len(tokens), len(wanted), today, tail)
}
