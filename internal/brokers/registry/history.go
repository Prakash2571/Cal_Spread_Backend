package registry

import (
	"context"
	"log"
	"math"
	"sort"
	"strconv"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
)

// dhanIntradayMaxDays bounds one Dhan intraday request by interval (deliberately small:
// Dhan truncates silently instead of failing).
var dhanIntradayMaxDays = map[string]float64{"1": 5, "5": 30, "15": 60, "25": 60, "60": 90}

// dhanInterval maps the internal interval label to Dhan's minute string; "" means the
// daily path.
func dhanInterval(interval string) string {
	switch interval {
	case "minute":
		return "1"
	case "3minute":
		return "5" // Dhan has no 3-minute bucket
	case "5minute":
		return "5"
	case "15minute":
		return "15"
	case "30minute":
		return "25" // nearest supported
	case "60minute", "hour":
		return "60"
	}
	return ""
}

// HistoryProvider is history.ts: the Kite historical methods' signatures and shapes,
// routed to the active broker on every call. Dhan ignores the priority (its pacing is
// the transport's serial chain).
type HistoryProvider struct {
	r      *Registry
	native bool
}

// ForAnalytics retains Dhan's native class, exact intraday time bounds and
// upstream errors. Legacy historical callers retain their compatibility contract.
func (h *HistoryProvider) ForAnalytics() *HistoryProvider {
	return &HistoryProvider{r: h.r, native: true}
}

func (h *HistoryProvider) isDhan() bool { return h.r.ActiveBroker() == brokers.Dhan }

// defaultPrio is the TypeScript default parameter `prio = "interactive"`.
func defaultPrio(p kite.HistoricalPriority) kite.HistoricalPriority {
	if p == "" {
		return kite.Interactive
	}
	return p
}

// GetHistoricalFull is kite.GetHistoricalFull (interval "" means "day").
func (h *HistoryProvider) GetHistoricalFull(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.HistoricalCandle, error) {
	if interval == "" {
		interval = "day"
	}
	if !h.isDhan() {
		return h.r.deps.Kite.GetHistoricalFull(ctx, token, from, to, interval, defaultPrio(prio))
	}
	return h.dhanCandles(ctx, token, from, to, interval)
}

// GetHistorical is kite.GetHistorical: {t, close}.
func (h *HistoryProvider) GetHistorical(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error) {
	namespace, err := h.r.namespaceFor(ctx)
	if err != nil {
		return nil, err
	}
	ctx = brokers.WithNamespace(ctx, namespace)
	if namespace.Broker != brokers.Dhan {
		return h.r.deps.Kite.GetHistorical(ctx, token, from, to, interval, defaultPrio(prio))
	}
	rows, err := h.dhanCandles(ctx, token, from, to, interval)
	if err != nil {
		return nil, err
	}
	out := make([]kite.ClosePoint, len(rows))
	for i, c := range rows {
		out[i] = kite.ClosePoint{T: c.Date, Close: c.Close}
	}
	return out, nil
}

// GetHistoricalOi is kite.GetHistoricalOi: daily {date, close, oi}. Dhan dates are the
// full IST stamp (19 characters), not Kite's 10, as in Node.
func (h *HistoryProvider) GetHistoricalOi(ctx context.Context, token int64, from, to string, prio kite.HistoricalPriority) ([]kite.DayOI, error) {
	if !h.isDhan() {
		return h.r.deps.Kite.GetHistoricalOi(ctx, token, from, to, defaultPrio(prio))
	}
	rows, err := h.dhanCandles(ctx, token, from, to, "day")
	if err != nil {
		return nil, err
	}
	out := make([]kite.DayOI, len(rows))
	for i, c := range rows {
		out[i] = kite.DayOI{Date: c.Date, Close: c.Close, OI: c.OI}
	}
	return out, nil
}

// GetHistoricalOiSeries is kite.GetHistoricalOiSeries: {t, close, oi}.
func (h *HistoryProvider) GetHistoricalOiSeries(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.OISeriesPoint, error) {
	namespace, err := h.r.namespaceFor(ctx)
	if err != nil {
		return nil, err
	}
	ctx = brokers.WithNamespace(ctx, namespace)
	if namespace.Broker != brokers.Dhan {
		return h.r.deps.Kite.GetHistoricalOiSeries(ctx, token, from, to, interval, defaultPrio(prio))
	}
	rows, err := h.dhanCandles(ctx, token, from, to, interval)
	if err != nil {
		return nil, err
	}
	out := make([]kite.OISeriesPoint, len(rows))
	for i, c := range rows {
		out[i] = kite.OISeriesPoint{T: c.Date, Close: c.Close, OI: c.OI}
	}
	return out, nil
}

type dhanTarget struct {
	securityID string
	segment    dhan.Segment
	instrument string
}

// dhanTarget resolves an internal token to what Dhan's charts API needs: the master row,
// else the arithmetic identity (a NSE_FNO id is then assumed to be an index future).
func (h *HistoryProvider) dhanTarget(token int64) (dhanTarget, bool) {
	store := h.r.dhanInstruments
	if inst, ok := store.Get(token); ok {
		return dhanTarget{strconv.FormatInt(inst.DhanSecurityID, 10), inst.DhanSegment, dhanInstrumentClass(inst)}, true
	}
	id, ok := store.Identify(token)
	if !ok {
		return dhanTarget{}, false
	}
	class := "EQUITY"
	if id.Segment == dhan.SegmentNSEFNO {
		class = "FUTIDX"
	}
	return dhanTarget{strconv.FormatInt(id.SecurityID, 10), id.Segment, class}, true
}

// dhanInstrumentClass is Dhan's `instrument` classification for the charts API. Index
// options/futures classify as OPTSTK/FUTSTK because their own segment is NSE_FNO
// (inherited quirk).
func dhanInstrumentClass(inst dhan.Instrument) string {
	isIndexUnderlying := inst.Segment == "INDICES" || inst.DhanSegment == dhan.SegmentIdxI
	switch inst.InstrumentType {
	case "CE", "PE":
		if isIndexUnderlying {
			return "OPTIDX"
		}
		return "OPTSTK"
	case "FUT":
		if isIndexUnderlying {
			return "FUTIDX"
		}
		return "FUTSTK"
	case "INDEX":
		return "INDEX"
	}
	return "EQUITY"
}

// sliceUTF16 is String.prototype.slice(0, n) for the ASCII date strings callers pass;
// for other text it cuts at the n-th UTF-16 unit like JavaScript.
func sliceUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// dhanCandles fetches Dhan candles for [from, to], chunking intraday ranges. Request
// failures are logged and the partial series returned; the only error is the
// RangeError of an unparseable intraday date, as in Node.
func (h *HistoryProvider) dhanCandles(ctx context.Context, token int64, from, to, interval string) ([]kite.HistoricalCandle, error) {
	if h.native {
		return h.nativeDhanCandles(ctx, token, from, to, interval)
	}
	_, _ = h.r.dhanInstruments.Load(ctx, false)
	target, ok := h.dhanTarget(token)
	if !ok {
		return []kite.HistoricalCandle{}, nil
	}
	fromMs := timeClip(dhan.DateParse(sliceUTF16(from, 10)))
	toMs := timeClip(dhan.DateParse(sliceUTF16(to, 10)))
	minutes := dhanInterval(interval)
	oi := true

	if minutes == "" {
		fromDay, err1 := isoDay(fromMs)
		toDay, err2 := isoDay(toMs)
		if err := firstErr(err1, err2); err != nil {
			log.Printf("[Dhan] daily candles failed for token %d: %v", token, err)
			return []kite.HistoricalCandle{}, nil
		}
		res, err := h.r.dhanClient.HistoricalCandles(ctx, dhan.HistoricalRequest{
			SecurityID: target.securityID, ExchangeSegment: target.segment, Instrument: target.instrument,
			OI: &oi, FromDate: fromDay, ToDate: toDay,
		})
		if err != nil {
			log.Printf("[Dhan] daily candles failed for token %d: %v", token, err)
			return []kite.HistoricalCandle{}, nil
		}
		return DhanCandlesToRows(res), nil
	}

	maxDays, ok := dhanIntradayMaxDays[minutes]
	if !ok {
		maxDays = 5
	}
	var merged []kite.HistoricalCandle
	for _, chunk := range ChunkDateRange(fromMs, toMs, maxDays) {
		fromDay, err1 := isoDay(chunk.From)
		toDay, err2 := isoDay(chunk.To)
		if err := firstErr(err1, err2); err != nil {
			// The TypeScript catch block formats the dates again and throws.
			return nil, err
		}
		res, err := h.r.dhanClient.IntradayCandles(ctx, dhan.IntradayRequest{
			SecurityID: target.securityID, ExchangeSegment: target.segment, Instrument: target.instrument,
			Interval: minutes, OI: &oi, FromDate: fromDay, ToDate: toDay,
		})
		if err != nil {
			log.Printf("[Dhan] intraday candles failed for token %d (%s→%s): %v", token, fromDay, toDay, err)
			continue
		}
		merged = append(merged, DhanCandlesToRows(res)...)
	}
	// Chunk boundaries share a day: keep the first candle per timestamp, oldest first.
	seen := map[string]bool{}
	out := []kite.HistoricalCandle{}
	for _, c := range merged {
		if seen[c.Date] {
			continue
		}
		seen[c.Date] = true
		out = append(out, c)
	}
	sort.SliceStable(out, func(i, j int) bool { return jsx.LocaleCompare(out[i].Date, out[j].Date) < 0 })
	return out, nil
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// DateRange is one chunk of ChunkDateRange, in epoch ms (NaN for an invalid date).
type DateRange struct {
	From float64 `json:"from"`
	To   float64 `json:"to"`
}

const dayMs = 24 * 60 * 60 * 1000

// ChunkDateRange is history.ts chunkDateRange: [from, to] as consecutive chunks of at
// most maxDays; neighbouring chunks share their boundary instant. A non-positive
// maxDays, an empty or inverted range, or an invalid date gives the single input range.
func ChunkDateRange(from, to float64, maxDays float64) []DateRange {
	cursor, end := from, to
	if !(maxDays > 0) || end <= cursor {
		return []DateRange{{from, to}}
	}
	var out []DateRange
	for cursor < end {
		next := math.Min(end, cursor+maxDays*dayMs)
		out = append(out, DateRange{timeClip(cursor), timeClip(next)})
		cursor = next
	}
	if len(out) == 0 {
		return []DateRange{{from, to}}
	}
	return out
}

func numAt(arr []dhan.Value, i int) float64 {
	if i < len(arr) {
		if n, ok := arr[i].Num(); ok && jsx.Finite(n) {
			return n
		}
	}
	return 0
}

// DhanCandlesToRows is history.ts dhanCandlesToRows: Dhan's column-wise candles (epoch
// seconds) as rows with the IST "YYYY-MM-DD HH:MM:SS" date, oldest first. Timestamps that
// are not finite numbers are dropped; missing values are 0.
func DhanCandlesToRows(c dhan.Candles) []kite.HistoricalCandle {
	out := []kite.HistoricalCandle{}
	for i, ts := range c.Timestamp {
		sec, ok := ts.Num()
		if !ok || !jsx.Finite(sec) {
			continue
		}
		out = append(out, kite.HistoricalCandle{
			Date:   istStamp(sec * 1000),
			Open:   numAt(c.Open, i),
			High:   numAt(c.High, i),
			Low:    numAt(c.Low, i),
			Close:  numAt(c.Close, i),
			Volume: numAt(c.Volume, i),
			OI:     numAt(c.OpenInterest, i),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return jsx.LocaleCompare(out[i].Date, out[j].Date) < 0 })
	return out
}
