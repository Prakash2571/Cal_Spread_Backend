package analytics

import (
	"errors"
	"math"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/httpx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// The six public analytics routes (index.ts :2073-2380). None needs admin auth; only the
// option chain needs market data. `:underlying` is ignored by all but the chain (the
// analytics are NIFTY only), but it is still decoded, as Express does.

// Mount registers the routes.
func (s *Service) Mount(r chi.Router) {
	r.Get("/api/option-chain/{underlying}", s.optionChain)
	r.Get("/api/option-oi-baseline/{underlying}", s.oiBaseline)
	r.Get("/api/option-prev-close/{underlying}", s.prevCloseRoute)
	r.Get("/api/option-oi-series/{underlying}", s.oiSeries)
	r.Get("/api/option-oi-frame/{underlying}", s.oiFrame)
	r.Get("/api/futures-oi-frame/{underlying}", s.futuresOiFrame)
}

// requireMarketData answers 401 unless the active broker's market data is ready.
func (s *Service) requireMarketData(w http.ResponseWriter, what string) bool {
	h := Readiness{Ready: true}
	if s.d.MarketData != nil {
		h = s.d.MarketData()
	}
	if h.Ready {
		return true
	}
	label := "Zerodha"
	if h.Broker == brokers.Dhan {
		label = "Dhan"
	}
	problems := h.Problems
	if problems == nil {
		problems = []string{}
	}
	httpx.JSON(w, http.StatusUnauthorized, struct {
		Error    string     `json:"error"`
		Broker   brokers.ID `json:"broker"`
		Problems []string   `json:"problems"`
	}{what + " requires a " + label + " session. Connect " + label + ".", h.Broker, problems})
	return false
}

type strikeRow struct {
	Strike   float64 `json:"strike"`
	CeToken  int64   `json:"ce_token"`
	PeToken  int64   `json:"pe_token"`
	CeSymbol string  `json:"ce_symbol"`
	PeSymbol string  `json:"pe_symbol"`
}

type chainResponse struct {
	Underlying string      `json:"underlying"`
	Name       string      `json:"name"`
	SpotToken  int64       `json:"spot_token"`
	Spot       float64     `json:"spot"`
	AtmStrike  float64     `json:"atm_strike"`
	Expiry     string      `json:"expiry"`
	Expiries   []string    `json:"expiries"`
	LotSize    float64     `json:"lot_size"`
	Strikes    []strikeRow `json:"strikes"`
}

// errStrikeUndefined is the TypeError Node threw for a fractional band (allStrikes[lo] is
// undefined when lo is not an integer); sendError answered it with 500.
var errStrikeUndefined = errors.New("Cannot read properties of undefined (reading 'ce')")

// optionChain is GET /api/option-chain/:underlying: the CE/PE tokens of a band of strikes
// around the ATM of one expiry.
func (s *Service) optionChain(w http.ResponseWriter, r *http.Request) {
	s.syncNamespace()
	ctx, _, cleanup, valid := s.beginOperation(r.Context())
	if valid {
		defer cleanup()
		r = r.WithContext(ctx)
	}
	raw, ok := pathParam(w, r, "underlying")
	if !ok {
		return
	}
	underlying := jsToUpper(raw)
	expiryParam := jsTrim(queryString(r, "expiry", ""))
	band := math.Min(80, math.Max(5, queryNumber(r, "band", 40)))

	if !s.requireMarketData(w, "Option chain") {
		return
	}
	all, err := s.instruments(r.Context())
	if err != nil {
		s.d.SendError(w, err)
		return
	}
	var opts []market.Instrument
	for i := range all {
		o := &all[i]
		if o.Exchange == "NFO" && isOption(o) && o.Name == underlying {
			opts = append(opts, *o)
		}
	}
	if len(opts) == 0 {
		httpx.Error(w, http.StatusNotFound, `No options found for "`+underlying+`".`)
		return
	}
	expiries := uniqueSortedExpiries(opts, istDayKey(s.nowMs()))
	if len(expiries) == 0 {
		httpx.Error(w, http.StatusNotFound, `No live expiries for "`+underlying+`".`)
		return
	}
	expiry := expiries[0]
	if expiryParam != "" {
		for _, e := range expiries {
			if e == expiryParam {
				expiry = expiryParam
				break
			}
		}
	}
	spotInst := findSpot(all, underlying, true)
	if spotInst == nil {
		httpx.Error(w, http.StatusNotFound, `No spot instrument for "`+underlying+`".`)
		return
	}
	spot := 0.0
	if s.d.QuotesByToken != nil {
		if q, err := s.d.QuotesByToken(r.Context(), []int64{spotInst.InstrumentToken}); err == nil && len(q) > 0 {
			spot = q[0].LastPrice
		}
	}

	type legs struct{ ce, pe *market.Instrument }
	byStrike := map[float64]*legs{}
	var allStrikes []float64
	lotSize := 0.0
	for i := range opts {
		o := &opts[i]
		if o.Expiry != expiry || !strikeTruthy(o.Strike) {
			continue
		}
		e, ok := byStrike[o.Strike]
		if !ok {
			e = &legs{}
			byStrike[o.Strike] = e
			allStrikes = append(allStrikes, o.Strike)
		}
		if o.InstrumentType == "CE" {
			e.ce = o
		} else {
			e.pe = o
		}
		if jsFalsyNum(lotSize) {
			lotSize = o.LotSize
		}
	}
	sort.SliceStable(allStrikes, func(i, j int) bool { return allStrikes[i] < allStrikes[j] })
	if len(allStrikes) == 0 {
		httpx.Error(w, http.StatusNotFound, "No strikes for expiry "+expiry+".")
		return
	}
	atm := allStrikes[len(allStrikes)/2]
	if spot > 0 {
		atm = allStrikes[0]
		for _, st := range allStrikes {
			if math.Abs(st-spot) < math.Abs(atm-spot) {
				atm = st
			}
		}
	}
	atmIdx := 0
	for i, st := range allStrikes {
		if st == atm {
			atmIdx = i
			break
		}
	}
	lo := math.Max(0, float64(atmIdx)-band)
	hi := math.Min(float64(len(allStrikes)-1), float64(atmIdx)+band)
	rows := []strikeRow{}
	if lo <= hi { // NaN band: the loop never runs
		if lo != math.Trunc(lo) {
			s.d.SendError(w, errStrikeUndefined)
			return
		}
		for i := int(lo); float64(i) <= hi; i++ {
			e := byStrike[allStrikes[i]]
			if e.ce == nil || e.pe == nil {
				continue
			}
			rows = append(rows, strikeRow{Strike: allStrikes[i], CeToken: e.ce.InstrumentToken, PeToken: e.pe.InstrumentToken, CeSymbol: e.ce.Tradingsymbol, PeSymbol: e.pe.Tradingsymbol})
		}
	}
	httpx.JSON(w, http.StatusOK, chainResponse{
		Underlying: underlying,
		Name:       spotInst.Tradingsymbol,
		SpotToken:  spotInst.InstrumentToken,
		Spot:       spot,
		AtmStrike:  atm,
		Expiry:     expiry,
		Expiries:   expiries,
		LotSize:    lotSize,
		Strikes:    rows,
	})
}

// tokenObject writes {"<token>": {oi, ltp, t}, …} for the baseline route.
type baselineTokens struct {
	snap *ChainSnapshot
}

func (b baselineTokens) AppendJS(dst []byte) []byte {
	if b.snap == nil {
		return append(dst, "{}"...)
	}
	order := make([]int64, len(b.snap.Tokens))
	vals := make(map[int64]snapTok, len(b.snap.Tokens))
	for i, t := range b.snap.Tokens {
		order[i] = t.Token
		vals[t.Token] = t
	}
	t := b.snap.T
	return appendTokenObject(dst, order, func(dst []byte, tok int64) []byte {
		v := vals[tok]
		return jsjson.NewObject(dst).Field("oi", v.OI).Field("ltp", v.LTP).Field("t", t).End()
	})
}

type baselineResponse struct {
	Day     string         `json:"day"`
	Expiry  *string        `json:"expiry"`
	Minutes float64        `json:"minutes"`
	Oldest  *int64         `json:"oldest"`
	Newest  *int64         `json:"newest"`
	BaseT   *int64         `json:"baseT"`
	Tokens  baselineTokens `json:"tokens"`
}

// oiBaseline is GET /api/option-oi-baseline/:underlying: per-token OI and LTP as of
// `minutes` ago from today's chain snapshots (nothing rather than a too-recent one).
func (s *Service) oiBaseline(w http.ResponseWriter, r *http.Request) {
	s.syncNamespace()
	if _, ok := pathParam(w, r, "underlying"); !ok {
		return
	}
	requested := queryNumber(r, "minutes", 5)
	minutes := 5.0
	if !math.IsNaN(requested) && !math.IsInf(requested, 0) {
		minutes = math.Min(240, math.Max(1, jsx.Round(requested)))
	}
	now := s.nowMs()
	day := istDayKey(now)
	s.mu.Lock()
	oldest, newest := s.chainSnapshotSpanLocked(now)
	snap := s.chainBaselineAtLocked(now-int64(minutes)*minuteMs, now)
	s.mu.Unlock()
	resp := baselineResponse{Day: day, Minutes: minutes, Oldest: oldest, Newest: newest}
	if snap != nil {
		exp := snap.Expiry
		t := snap.T
		resp.Expiry, resp.BaseT, resp.Tokens = &exp, &t, baselineTokens{snap: snap}
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// prevCloseRoute is GET /api/option-prev-close/:underlying: today's baseline as stored,
// or an empty one when it is missing or from another day.
func (s *Service) prevCloseRoute(w http.ResponseWriter, r *http.Request) {
	s.syncNamespace()
	if _, ok := pathParam(w, r, "underlying"); !ok {
		return
	}
	today := istDayKey(s.nowMs())
	s.mu.Lock()
	pc := s.prevClose
	s.mu.Unlock()
	if pc == nil || pc.ForDay != today {
		httpx.JSON(w, http.StatusOK, struct {
			ForDay   string   `json:"forDay"`
			ClosedOn *string  `json:"closedOn"`
			Expiry   *string  `json:"expiry"`
			Complete bool     `json:"complete"`
			Tokens   struct{} `json:"tokens"`
		}{ForDay: today})
		return
	}
	httpx.RawJSON(w, http.StatusOK, pc.AppendJS(nil))
}

type seriesPoint struct {
	T        int64   `json:"t"`
	TotalCe  float64 `json:"totalCe"`
	TotalPe  float64 `json:"totalPe"`
	Straddle float64 `json:"straddle"`
}

// oiSeries is GET /api/option-oi-series/:underlying: today's per-capture totals over the
// pinned window (every strike before it is pinned) and the per-sample ATM straddle.
func (s *Service) oiSeries(w http.ResponseWriter, r *http.Request) {
	s.syncNamespace()
	if _, ok := pathParam(w, r, "underlying"); !ok {
		return
	}
	day := istDayKey(s.nowMs())
	type resp struct {
		Day    string        `json:"day"`
		Expiry *string       `json:"expiry"`
		Points []seriesPoint `json:"points"`
	}
	s.mu.Lock()
	store := s.day
	if store == nil || store.day != day {
		s.mu.Unlock()
		httpx.JSON(w, http.StatusOK, resp{Day: day, Points: []seriesPoint{}})
		return
	}
	l := frameLadder(store.meta)
	sample := func(tok int64, ok bool, i int) (oiSample, bool) {
		if !ok {
			return oiSample{}, false
		}
		arr := store.series[tok]
		if i >= len(arr) {
			return oiSample{}, false
		}
		return arr[i], true
	}
	points := make([]seriesPoint, 0, len(store.spot))
	for i, sp := range store.spot {
		atmIdx := nearestStrikeIndex(l.strikes, sp.ltp)
		var totalCe, totalPe float64
		for _, strike := range l.strikes {
			if store.window != nil && !store.window.contains(strike) {
				continue
			}
			ce, ceOK := l.ceAt(strike)
			pe, peOK := l.peAt(strike)
			if ceOK {
				v, _ := sample(ce, true, i)
				totalCe += v.oi
			}
			if peOK {
				v, _ := sample(pe, true, i)
				totalPe += v.oi
			}
		}
		var ceLtp, peLtp float64
		if len(l.strikes) > 0 {
			atm := l.strikes[atmIdx]
			ce, ceOK := l.ceAt(atm)
			pe, peOK := l.peAt(atm)
			if v, ok := sample(ce, ceOK, i); ok {
				ceLtp = v.ltp
			}
			if v, ok := sample(pe, peOK, i); ok {
				peLtp = v.ltp
			}
		}
		straddle := 0.0
		if ceLtp > 0 && peLtp > 0 {
			straddle = ceLtp + peLtp
		}
		points = append(points, seriesPoint{T: sp.t, TotalCe: totalCe, TotalPe: totalPe, Straddle: straddle})
	}
	exp := store.expiry
	s.mu.Unlock()
	httpx.JSON(w, http.StatusOK, resp{Day: day, Expiry: &exp, Points: points})
}

// frameQuery is parseFrameKey(req.query.frame).
func frameQuery(r *http.Request) int {
	return parseFrameKey(queryString(r, "frame", "5m"))
}

// oiFrame is GET /api/option-oi-frame/:underlying: a frame's completed buckets.
func (s *Service) oiFrame(w http.ResponseWriter, r *http.Request) {
	s.syncNamespace()
	if _, ok := pathParam(w, r, "underlying"); !ok {
		return
	}
	i := frameQuery(r)
	cfg := frames[i]
	now := s.nowMs()
	s.mu.Lock()
	pts := s.oiFrames[i]
	n := completedCount(pts, oiStamp, now)
	out := make([]OiAggPoint, n)
	for k := 0; k < n; k++ {
		out[k] = *pts[k]
	}
	s.mu.Unlock()
	httpx.JSON(w, http.StatusOK, struct {
		Frame       string       `json:"frame"`
		IntervalMin int64        `json:"intervalMin"`
		RetentionMs int64        `json:"retentionMs"`
		Points      []OiAggPoint `json:"points"`
	}{cfg.Key, cfg.IntervalMin, cfg.RetentionMs, out})
}

// futuresOiFrame is GET /api/futures-oi-frame/:underlying: a futures frame's completed
// buckets plus every contract they (or the current capture) cover, sorted by expiry.
func (s *Service) futuresOiFrame(w http.ResponseWriter, r *http.Request) {
	s.syncNamespace()
	if _, ok := pathParam(w, r, "underlying"); !ok {
		return
	}
	i := frameQuery(r)
	cfg := frames[i]
	now := s.nowMs()
	s.mu.Lock()
	pts := s.futFrames[i]
	n := completedCount(pts, futStamp, now)
	out := make([]FutOiPoint, n)
	seen := map[string]bool{}
	var expiries []string
	add := func(e string) {
		if !seen[e] {
			seen[e] = true
			expiries = append(expiries, e)
		}
	}
	for k := 0; k < n; k++ {
		out[k] = FutOiPoint{T: pts[k].T, Legs: append([]FutOiLeg{}, pts[k].Legs...)}
		for _, l := range pts[k].Legs {
			add(l.Expiry)
		}
	}
	for _, c := range s.futContracts {
		add(c.Expiry)
	}
	jsSortStrings(expiries)
	contracts := make([]FutContract, len(expiries))
	for k, e := range expiries {
		if c, ok := s.futKnown.Get(e); ok {
			contracts[k] = c
		} else {
			contracts[k] = FutContract{Expiry: e}
		}
	}
	s.mu.Unlock()
	httpx.JSON(w, http.StatusOK, struct {
		Frame       string        `json:"frame"`
		IntervalMin int64         `json:"intervalMin"`
		RetentionMs int64         `json:"retentionMs"`
		Contracts   []FutContract `json:"contracts"`
		Points      []FutOiPoint  `json:"points"`
	}{cfg.Key, cfg.IntervalMin, cfg.RetentionMs, contracts, out})
}
