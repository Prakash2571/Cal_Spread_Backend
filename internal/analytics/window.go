package analytics

import (
	"math"
	"sort"
)

// The per-day option cache and the pinned strike window (index.ts :3975-4126).

const (
	// WINDOW_DOWN / WINDOW_UP: strikes below / above the ATM in the totals window.
	windowDown = 26
	windowUp   = 24
	// OI_BACKFILL_BAND: strikes either side of the ATM fetched by the frame backfill.
	oiBackfillBand = 45
	// PREV_CLOSE_BAND: strikes either side of the ATM fetched for the previous close.
	prevCloseBand = 60
	// OPTION_OI_UNDERLYING / FUT_OI_UNDERLYING.
	niftyUnderlying = "NIFTY"
)

type oiSample struct {
	t   int64
	oi  float64
	ltp float64
}

type spotSample struct {
	t   int64
	ltp float64
}

type optMeta struct {
	strike float64
	typ    string // "CE" | "PE"
}

// tokenMeta is the Map<token, {strike, type}> of a day, in dump order (a duplicate token
// keeps its first position and takes the later value).
type tokenMeta struct {
	keys []int64
	m    map[int64]optMeta
}

func (t *tokenMeta) set(tok int64, v optMeta) {
	if t.m == nil {
		t.m = map[int64]optMeta{}
	}
	if _, ok := t.m[tok]; !ok {
		t.keys = append(t.keys, tok)
	}
	t.m[tok] = v
}

// oiDay is index.ts OptionOiDay: today's samples for the nearest expiry. Sample i of
// every series and of spot belongs to the same capture cycle.
type oiDay struct {
	day       string
	expiry    string
	spotToken int64
	meta      *tokenMeta
	series    map[int64][]oiSample
	spot      []spotSample
	window    *strikeWindow
}

// strikeWindow is an inclusive strike range (by strike VALUE).
type strikeWindow struct {
	lo, hi float64
}

func (w strikeWindow) contains(strike float64) bool { return strike >= w.lo && strike <= w.hi }

// nearestStrikeIndex is the ladder index of the strike nearest spot; the lowest strike
// wins a tie and a NaN spot gives 0.
func nearestStrikeIndex(strikes []float64, spot float64) int {
	best := 0
	bestD := math.Inf(1)
	for k, s := range strikes {
		if d := math.Abs(s - spot); d < bestD {
			bestD = d
			best = k
		}
	}
	return best
}

// pinStrikeWindow is the session's totals window from its first spot reading.
func pinStrikeWindow(strikes []float64, spot float64) *strikeWindow {
	if len(strikes) == 0 || !(spot > 0) {
		return nil
	}
	atm := nearestStrikeIndex(strikes, spot)
	lo := atm - windowDown
	if lo < 0 {
		lo = 0
	}
	hi := atm + windowUp
	if hi > len(strikes)-1 {
		hi = len(strikes) - 1
	}
	return &strikeWindow{lo: strikes[lo], hi: strikes[hi]}
}

// ladder is frameLadder(meta): the sorted unique strikes and strike→token maps (the
// last token in dump order wins a duplicate strike).
type ladder struct {
	strikes []float64
	ce      map[float64]int64
	pe      map[float64]int64
}

func (l ladder) ceAt(strike float64) (int64, bool) { t, ok := l.ce[strike]; return t, ok }
func (l ladder) peAt(strike float64) (int64, bool) { t, ok := l.pe[strike]; return t, ok }

func frameLadder(meta *tokenMeta) ladder {
	l := ladder{ce: map[float64]int64{}, pe: map[float64]int64{}}
	seen := map[float64]bool{}
	for _, tok := range meta.keys {
		m := meta.m[tok]
		if m.typ == "CE" {
			l.ce[m.strike] = tok
		} else {
			l.pe[m.strike] = tok
		}
		if !seen[m.strike] {
			seen[m.strike] = true
			l.strikes = append(l.strikes, m.strike)
		}
	}
	sort.SliceStable(l.strikes, func(i, j int) bool { return l.strikes[i] < l.strikes[j] })
	return l
}

// lastOf is the newest sample of a token, zeros when there is none.
func (d *oiDay) lastOf(tok int64, ok bool) (oi, ltp float64) {
	if !ok {
		return 0, 0
	}
	arr := d.series[tok]
	if len(arr) == 0 {
		return 0, 0
	}
	s := arr[len(arr)-1]
	return s.oi, s.ltp
}

// currentWindowAggLocked is currentWindowAgg: the totals over the session's pinned
// window at the latest sample, pinning the window on the first reading with spot > 0.
// unseeded holds the tokens this cycle had no reading for at all.
func (s *Service) currentWindowAggLocked(d *oiDay, unseeded map[int64]bool) (OiAggPoint, bool) {
	if len(d.spot) == 0 {
		return OiAggPoint{}, false
	}
	spot := d.spot[len(d.spot)-1].ltp
	if !(spot > 0) {
		return OiAggPoint{}, false
	}
	l := frameLadder(d.meta)
	if len(l.strikes) == 0 {
		return OiAggPoint{}, false
	}
	if d.window == nil {
		pinned := pinStrikeWindow(l.strikes, spot)
		if pinned == nil {
			return OiAggPoint{}, false
		}
		d.window = pinned
		s.logf("[OptionOI] %s %s: totals window pinned to strikes %s–%s (first spot %s).",
			d.day, d.expiry, fmtNum(pinned.lo), fmtNum(pinned.hi), fmtNum(spot))
	}
	win := *d.window
	atmIdx := nearestStrikeIndex(l.strikes, spot)

	var totalCe, totalPe float64
	missing := 0
	for _, strike := range l.strikes {
		if !win.contains(strike) {
			continue
		}
		ce, ceOK := l.ceAt(strike)
		pe, peOK := l.peAt(strike)
		ceOi, _ := d.lastOf(ce, ceOK)
		peOi, _ := d.lastOf(pe, peOK)
		totalCe += ceOi
		totalPe += peOi
		if unseeded != nil && ((ceOK && unseeded[ce]) || (peOK && unseeded[pe])) {
			missing++
		}
	}
	atm := l.strikes[atmIdx]
	ceTok, ceOK := l.ceAt(atm)
	peTok, peOK := l.peAt(atm)
	_, ceAtm := d.lastOf(ceTok, ceOK)
	_, peAtm := d.lastOf(peTok, peOK)
	straddle := 0.0
	if ceAtm > 0 && peAtm > 0 {
		straddle = ceAtm + peAtm
	}
	return OiAggPoint{
		T:        s.nowMs(),
		TotalCe:  totalCe,
		TotalPe:  totalPe,
		Straddle: straddle,
		Spot:     spot,
		HasWLo:   true,
		WLo:      win.lo,
		HasWHi:   true,
		WHi:      win.hi,
		Partial:  missing > 0,
	}, true
}
