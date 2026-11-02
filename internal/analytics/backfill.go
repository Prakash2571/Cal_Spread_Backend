package analytics

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// The gap detectors and the Kite reconstruction of the frames (index.ts :4467-4800,
// :4950-5118).

const (
	msDur = time.Millisecond

	partialRepairMaxAttempts = 3
	headRepairMaxAttempts    = 4
	headRepairMinGapMs       = int64(25 * 60 * 1000)
	backfillSkipMs           = int64(90 * 1000)
	retryDelay               = 1200 * time.Millisecond
	pacingDelay              = 220 * time.Millisecond
)

func itoa(n int) string { return strconv.Itoa(n) }

func isoMs(ms int64) string { return jsx.ISO(time.UnixMilli(ms)) }

type repairMark struct {
	n  int
	at int64
}

// oiBackfillFromMsLocked is the earliest time any option frame still needs: its tail
// (or the whole retention when empty), a missing session head, and the oldest partial
// bucket.
func (s *Service) oiBackfillFromMsLocked(now int64) int64 {
	from := now
	for i, cfg := range frames {
		retentionStart := now - cfg.RetentionMs
		pts := s.oiFrames[i]
		if len(pts) == 0 {
			from = min(from, retentionStart)
			continue
		}
		need := max(retentionStart, pts[len(pts)-1].T)
		if head, ok := s.missingHeadMsLocked("opt", pts[0].T, cfg, retentionStart); ok {
			need = min(need, head)
		}
		if part, ok := s.partialRepairFromMsLocked(pts, cfg, retentionStart); ok {
			need = min(need, part)
		}
		from = min(from, need)
	}
	return from
}

// futOiBackfillFromMsLocked is the same for the futures frames, without the partial rule.
func (s *Service) futOiBackfillFromMsLocked(now int64) int64 {
	from := now
	for i, cfg := range frames {
		retentionStart := now - cfg.RetentionMs
		pts := s.futFrames[i]
		if len(pts) == 0 {
			from = min(from, retentionStart)
			continue
		}
		need := max(retentionStart, pts[len(pts)-1].T)
		if head, ok := s.missingHeadMsLocked("fut", pts[0].T, cfg, retentionStart); ok {
			need = min(need, head)
		}
		from = min(from, need)
	}
	return from
}

func (s *Service) oiBackfillFromMs(now int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.oiBackfillFromMsLocked(now)
}

func (s *Service) futOiBackfillFromMs(now int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.futOiBackfillFromMsLocked(now)
}

// partialRepairFromMsLocked is the from needed to rebuild the oldest partial bucket,
// rate-limited per (interval, IST day): at most 3 attempts, 25 minutes apart.
func (s *Service) partialRepairFromMsLocked(pts []*OiAggPoint, cfg frameCfg, retentionStart int64) (int64, bool) {
	var oldest *OiAggPoint
	for _, p := range pts {
		if p.Partial {
			oldest = p
			break
		}
	}
	if oldest == nil {
		return 0, false
	}
	from := max(retentionStart, oldest.T-cfg.IntervalMin*minuteMs)
	key := strconv.FormatInt(cfg.IntervalMin, 10) + ":" + istDayKey(oldest.T)
	seen, ok := s.partialRepairs[key]
	now := s.nowMs()
	if ok {
		if seen.n >= partialRepairMaxAttempts {
			return 0, false
		}
		if now-seen.at < headRepairMinGapMs {
			return from, true
		}
		s.partialRepairs[key] = repairMark{n: seen.n + 1, at: now}
	} else {
		s.partialRepairs[key] = repairMark{n: 1, at: now}
		s.logf("[OptionOI] %dm frame has an incomplete bucket at %s — reconstructing it again from Kite.", cfg.IntervalMin, isoMs(oldest.T))
	}
	return from, true
}

// missingHeadMsLocked is the from needed to repair a session whose head is missing (its
// oldest point is later than the open plus one bucket), rate-limited per (family,
// interval, day): at most 4 attempts, 25 minutes apart.
func (s *Service) missingHeadMsLocked(family string, oldest int64, cfg frameCfg, retentionStart int64) (int64, bool) {
	open := sessionOpenMs(oldest)
	if oldest <= open+cfg.IntervalMin*minuteMs {
		return 0, false
	}
	if open < retentionStart {
		return 0, false
	}
	key := family + ":" + strconv.FormatInt(cfg.IntervalMin, 10) + ":" + istDayKey(open)
	seen, ok := s.headRepairs[key]
	now := s.nowMs()
	if ok {
		if seen.n >= headRepairMaxAttempts {
			return 0, false
		}
		if now-seen.at < headRepairMinGapMs {
			return open, true
		}
		s.headRepairs[key] = repairMark{n: seen.n + 1, at: now}
	} else {
		s.headRepairs[key] = repairMark{n: 1, at: now}
		s.logf("[OptionOI] %s %dm frame is missing the head of %s (oldest point %s) — backfilling from the open.",
			family, cfg.IntervalMin, istDayKey(open), isoMs(oldest))
	}
	return open, true
}

// minuteKey is t.slice(0, 16): "YYYY-MM-DDTHH:MM".
func minuteKey(t string) string { return sliceUTF16(t, 16) }

// beginBackfill sets a single-flight flag after the capture gate passed.
func (s *Service) beginBackfill(flag *bool, what string) bool {
	s.mu.Lock()
	running := *flag
	s.mu.Unlock()
	if running || !s.captureAllowed(what) {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if *flag {
		return false
	}
	*flag = true
	return true
}

func (s *Service) endBackfill(flag *bool) {
	s.mu.Lock()
	*flag = false
	s.mu.Unlock()
}

// backfillOiFrames reconstructs the option frames from Kite minute candles from the
// earliest still-missing time (fromOverride when the caller snapshotted it before a
// capture), using the CURRENT nearest expiry's strikes.
func (s *Service) backfillOiFrames(ctx context.Context, fromOverride *int64) {
	if !s.beginBackfill(&s.oiBackfillRunning, "option-OI frame backfill") {
		return
	}
	defer s.endBackfill(&s.oiBackfillRunning)
	fail := func(err error) {
		s.logf("[OptionOI] frame backfill failed: %s", errText(err))
	}
	now := s.nowMs()
	var fromMs int64
	if fromOverride != nil {
		fromMs = *fromOverride
	} else {
		fromMs = s.oiBackfillFromMs(now)
	}
	if now-fromMs < backfillSkipMs {
		return
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
	l := frameLadder(sel.meta)
	if len(l.strikes) == 0 {
		return
	}
	fromStr, toStr := istDateTime(fromMs), istDateTime(now)

	spotCandles, err := s.historical(ctx, sel.spotToken, fromStr, toStr, "minute")
	if err != nil {
		fail(err)
		return
	}
	if len(spotCandles) == 0 {
		return
	}
	spotByMin := newOmap[string, float64]()
	tsByMin := map[string]string{}
	for _, c := range spotCandles {
		k := minuteKey(c.T)
		spotByMin.Set(k, c.Close)
		tsByMin[k] = c.T
	}

	lastSpot := spotCandles[len(spotCandles)-1].Close
	atmNow := 0
	bestD := math.Inf(1)
	for k, st := range l.strikes {
		if d := math.Abs(st - lastSpot); d < bestD {
			bestD = d
			atmNow = k
		}
	}
	bLo := max(0, atmNow-oiBackfillBand)
	bHi := min(len(l.strikes)-1, atmNow+oiBackfillBand)

	oiByToken := map[int64]map[string]float64{}
	closeByToken := map[int64]map[string]float64{}
	unfetched := newOmap[int64, struct{}]()
	fetchTok := func(tok int64, ok bool) error {
		if !ok {
			return nil
		}
		if _, done := oiByToken[tok]; done {
			return nil
		}
		candles, err := s.historicalOiSeries(ctx, tok, fromStr, toStr, "minute")
		if err != nil {
			if err := s.d.Sleep(ctx, retryDelay); err != nil {
				return err
			}
			candles, err = s.historicalOiSeries(ctx, tok, fromStr, toStr, "minute")
			if err != nil {
				unfetched.Set(tok, struct{}{})
				s.logf("[OptionOI] backfill: no history for token %d (%s) — affected buckets stay partial.", tok, errText(err))
				candles = nil
			}
		}
		mOi := map[string]float64{}
		mClose := map[string]float64{}
		for _, c := range candles {
			k := minuteKey(c.T)
			mOi[k] = c.OI
			mClose[k] = c.Close
		}
		oiByToken[tok] = mOi
		closeByToken[tok] = mClose
		return s.d.Sleep(ctx, pacingDelay)
	}
	for k := bLo; k <= bHi; k++ {
		ce, ceOK := l.ceAt(l.strikes[k])
		if err := fetchTok(ce, ceOK); err != nil {
			return
		}
		pe, peOK := l.peAt(l.strikes[k])
		if err := fetchTok(pe, peOK); err != nil {
			return
		}
	}

	sortedMins := spotByMin.Keys()
	jsSortStrings(sortedMins)
	lastOi := map[int64]float64{}
	lastClose := map[int64]float64{}
	var perMinute []OiAggPoint
	dayWindows := map[string]strikeWindow{}
	for _, mk := range sortedMins {
		spot, _ := spotByMin.Get(mk)
		if !(spot > 0) {
			continue
		}
		dayKey := sliceUTF16(mk, 10)
		win, ok := dayWindows[dayKey]
		if !ok {
			pinned := pinStrikeWindow(l.strikes, spot)
			if pinned == nil {
				continue
			}
			win = *pinned
			dayWindows[dayKey] = win
		}
		atmIdx := nearestStrikeIndex(l.strikes, spot)
		sumOi := func(tok int64, ok bool) float64 {
			if !ok {
				return 0
			}
			if v, has := oiByToken[tok][mk]; has {
				lastOi[tok] = v
			}
			return lastOi[tok]
		}
		closeOf := func(tok int64, ok bool) float64 {
			if !ok {
				return 0
			}
			if v, has := closeByToken[tok][mk]; has {
				lastClose[tok] = v
			}
			return lastClose[tok]
		}
		unknownTok := func(tok int64, ok bool) bool {
			if !ok {
				return false
			}
			_, fetched := oiByToken[tok]
			return !fetched || unfetched.Has(tok)
		}
		var totalCe, totalPe float64
		missing := 0
		for _, strike := range l.strikes {
			if !win.contains(strike) {
				continue
			}
			ce, ceOK := l.ceAt(strike)
			pe, peOK := l.peAt(strike)
			totalCe += sumOi(ce, ceOK)
			totalPe += sumOi(pe, peOK)
			if unknownTok(ce, ceOK) || unknownTok(pe, peOK) {
				missing++
			}
		}
		ceTok, ceOK := l.ceAt(l.strikes[atmIdx])
		peTok, peOK := l.peAt(l.strikes[atmIdx])
		ceAtm := closeOf(ceTok, ceOK)
		peAtm := closeOf(peTok, peOK)
		straddle := 0.0
		if ceAtm > 0 && peAtm > 0 {
			straddle = ceAtm + peAtm
		}
		stamp, ok := tsByMin[mk]
		if !ok {
			stamp = mk + ":00"
		}
		t, ok := parseCandleTime(stamp, nil)
		if ok {
			perMinute = append(perMinute, OiAggPoint{
				T: t, TotalCe: totalCe, TotalPe: totalPe, Straddle: straddle, Spot: spot,
				HasWLo: true, WLo: win.lo, HasWHi: true, WHi: win.hi, Partial: missing > 0,
			})
		}
	}

	s.mu.Lock()
	for i := range frames {
		s.mergeOiFrameLocked(i, perMinute)
	}
	s.mu.Unlock()
	partialMins := 0
	for _, p := range perMinute {
		if p.Partial {
			partialMins++
		}
	}
	tail := ""
	if partialMins > 0 {
		tail = ", " + itoa(partialMins) + " partial — " + itoa(unfetched.Len()) + " token(s) unavailable, will retry"
	}
	s.logf("[OptionOI] Backfilled frames from %s (%d minutes reconstructed%s).", fromStr, len(perMinute), tail)
}

// backfillFutOiFrames reconstructs the futures frames; any failed contract aborts the
// whole run (a zeroed leg would be frozen into the frames).
func (s *Service) backfillFutOiFrames(ctx context.Context, fromOverride *int64) {
	if !s.beginBackfill(&s.futBackfillRunning, "futures-OI frame backfill") {
		return
	}
	defer s.endBackfill(&s.futBackfillRunning)
	fail := func(err error) {
		s.logf("[FuturesOI] frame backfill failed: %s", errText(err))
	}
	now := s.nowMs()
	var fromMs int64
	if fromOverride != nil {
		fromMs = *fromOverride
	} else {
		fromMs = s.futOiBackfillFromMs(now)
	}
	if now-fromMs < backfillSkipMs {
		return
	}
	all, err := s.instruments(ctx)
	if err != nil {
		fail(err)
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

	fromStr, toStr := istDateTime(fromMs), istDateTime(now)
	type oc struct{ oi, close float64 }
	byExpiry := map[string]map[string]oc{}
	tsByMin := newOmap[string, string]()
	for _, c := range sel.contracts {
		candles, err := s.historicalOiSeries(ctx, c.Token, fromStr, toStr, "minute")
		if err != nil {
			fail(err)
			return
		}
		m := map[string]oc{}
		for _, cd := range candles {
			k := minuteKey(cd.T)
			m[k] = oc{oi: cd.OI, close: cd.Close}
			tsByMin.Set(k, cd.T)
		}
		byExpiry[c.Expiry] = m
		if err := s.d.Sleep(ctx, pacingDelay); err != nil {
			return
		}
	}

	lastOi := map[string]float64{}
	lastLtp := map[string]float64{}
	mins := tsByMin.Keys()
	jsSortStrings(mins)
	var perMinute []FutOiPoint
	for _, mk := range mins {
		legs := make([]FutOiLeg, len(sel.contracts))
		for i, c := range sel.contracts {
			if v, ok := byExpiry[c.Expiry][mk]; ok {
				lastOi[c.Expiry] = v.oi
				lastLtp[c.Expiry] = v.close
			}
			legs[i] = FutOiLeg{Expiry: c.Expiry, OI: lastOi[c.Expiry], LTP: lastLtp[c.Expiry]}
		}
		stamp, _ := tsByMin.Get(mk)
		if t, ok := parseCandleTime(stamp, nil); ok {
			perMinute = append(perMinute, FutOiPoint{T: t, Legs: legs})
		}
	}

	s.mu.Lock()
	for i := range frames {
		s.mergeFutOiFrameLocked(i, perMinute)
	}
	s.mu.Unlock()
	s.logf("[FuturesOI] Backfilled frames from %s (%d minutes reconstructed).", fromStr, len(perMinute))
}
