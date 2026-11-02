package analytics

import "sort"

// The multi-timeframe OI frames (index.ts :353-491 and :4128-4465): cadence, retention,
// the live append, the merge of backfilled candles, the coarsening of a coarse frame from
// a finer one, and their mirroring to the cache.

const frameCount = 4

// frameCfg is OI_FRAMES[key].
type frameCfg struct {
	Key          string
	IntervalMin  int64
	RetentionMs  int64
	KiteInterval string
}

// frames is OI_FRAMES in OI_FRAME_KEYS order. The futures frames use the same table.
var frames = [frameCount]frameCfg{
	{Key: "1m", IntervalMin: 1, RetentionMs: 1 * dayMs, KiteInterval: "minute"},
	{Key: "5m", IntervalMin: 5, RetentionMs: 3 * dayMs, KiteInterval: "5minute"},
	{Key: "15m", IntervalMin: 15, RetentionMs: 7 * dayMs, KiteInterval: "15minute"},
	{Key: "1h", IntervalMin: 60, RetentionMs: 7 * dayMs, KiteInterval: "60minute"},
}

// coarsenSource[i] is coarsenSourceFor(frames[i]) as a frame index, -1 for none.
var coarsenSource = func() [frameCount]int {
	var out [frameCount]int
	for i := range frames {
		out[i] = coarsenSourceFor(i)
	}
	return out
}()

// coarsenSourceFor: the coarsest finer frame whose buckets tile ours and whose retention
// reaches as far back. Computed, as in Node: today only 1h has one (15m).
func coarsenSourceFor(i int) int {
	cfg := frames[i]
	best := -1
	for k, c := range frames {
		if k == i {
			continue
		}
		if c.IntervalMin >= cfg.IntervalMin {
			continue
		}
		if cfg.IntervalMin%c.IntervalMin != 0 {
			continue
		}
		if c.RetentionMs < cfg.RetentionMs {
			continue
		}
		if best < 0 || c.IntervalMin > frames[best].IntervalMin {
			best = k
		}
	}
	return best
}

// parseFrameKey is String(raw ?? "5m") narrowed to a frame, else 5m.
func parseFrameKey(raw string) int {
	for i, f := range frames {
		if f.Key == raw {
			return i
		}
	}
	return 1
}

func bucketSize(cfg frameCfg) int64 { return cfg.IntervalMin * minuteMs }

// frameTtlSec is a frame key's TTL: retention plus a day of slack.
func frameTtlSec(cfg frameCfg) int64 { return (cfg.RetentionMs + redisTTLSlackMs) / 1000 }

// maxFrameRetentionMs is the longest retention any frame keeps.
func maxFrameRetentionMs() int64 {
	var m int64
	for _, f := range frames {
		if f.RetentionMs > m {
			m = f.RetentionMs
		}
	}
	return m
}

func oiFrameKey(cfg frameCfg) string  { return "oiframe:v2:" + cfg.Key }
func futFrameKey(cfg frameCfg) string { return "futoiframe:" + cfg.Key }

// completedCount is completedBuckets: how many leading points are closed at now (the
// still-forming bucket, stamped with a future end, is never served).
func completedCount[T any](points []T, stamp func(T) int64, now int64) int {
	end := len(points)
	for end > 0 && stamp(points[end-1]) > now {
		end--
	}
	return end
}

func lastTwo[T any](s []T) []T {
	if len(s) > 2 {
		return s[len(s)-2:]
	}
	return s
}

// appendOiFrameLiveLocked is appendOiFrameLive: the live aggregate goes into the bucket
// that t closes in each frame (pre-open buckets skipped), the tail is updated in place
// when it is the same bucket, retention is pruned against t, and only CLOSED buckets
// (end <= t) are mirrored. Live points never carry wLo/wHi.
func (s *Service) appendOiFrameLiveLocked(t int64, agg OiAggPoint) {
	for i, cfg := range frames {
		bEnd := bucketEndMs(t, bucketSize(cfg))
		if isPreOpenBucket(bEnd) {
			continue
		}
		pts := s.oiFrames[i]
		if n := len(pts); n > 0 && pts[n-1].T == bEnd {
			last := pts[n-1]
			last.TotalCe = agg.TotalCe
			last.TotalPe = agg.TotalPe
			last.Straddle = agg.Straddle
			last.Spot = agg.Spot
			last.Partial = agg.Partial
		} else {
			pts = append(pts, &OiAggPoint{T: bEnd, TotalCe: agg.TotalCe, TotalPe: agg.TotalPe, Straddle: agg.Straddle, Spot: agg.Spot, Partial: agg.Partial})
		}
		cutoff := t - cfg.RetentionMs
		var dropped []int64
		for len(pts) > 0 && pts[0].T < cutoff {
			dropped = append(dropped, pts[0].T)
			pts = pts[1:]
		}
		s.oiFrames[i] = pts
		ttl := frameTtlSec(cfg)
		rk := oiFrameKey(cfg)
		for _, p := range lastTwo(pts) {
			if p.T <= t {
				s.queueHashFieldLocked(rk, p.T, p, ttl, maxBufferedFrameFields)
			}
		}
		s.queueHashDropLocked(rk, dropped, ttl)
	}
}

// appendFutOiFrameLiveLocked is appendFutOiFrameLive (each frame owns its copy of legs).
func (s *Service) appendFutOiFrameLiveLocked(t int64, legs []FutOiLeg) {
	for i, cfg := range frames {
		bEnd := bucketEndMs(t, bucketSize(cfg))
		if isPreOpenBucket(bEnd) {
			continue
		}
		pts := s.futFrames[i]
		if n := len(pts); n > 0 && pts[n-1].T == bEnd {
			pts[n-1].Legs = append([]FutOiLeg{}, legs...)
		} else {
			pts = append(pts, &FutOiPoint{T: bEnd, Legs: append([]FutOiLeg{}, legs...)})
		}
		cutoff := t - cfg.RetentionMs
		var dropped []int64
		for len(pts) > 0 && pts[0].T < cutoff {
			dropped = append(dropped, pts[0].T)
			pts = pts[1:]
		}
		s.futFrames[i] = pts
		ttl := frameTtlSec(cfg)
		rk := futFrameKey(cfg)
		for _, p := range lastTwo(pts) {
			if p.T <= t {
				s.queueHashFieldLocked(rk, p.T, p, ttl, maxBufferedFrameFields)
			}
		}
		s.queueHashDropLocked(rk, dropped, ttl)
	}
}

// downsampleAgg collapses per-minute CANDLE points (stamped with their start) to one per
// bucket, the last candle of a bucket winning, re-stamped with the bucket end.
func downsampleAgg(points []OiAggPoint, intervalMin int64) []*OiAggPoint {
	bsize := intervalMin * minuteMs
	by := newOmap[int64, *OiAggPoint]()
	for _, p := range points {
		bEnd := candleEndMs(p.T, bsize)
		if isPreOpenBucket(bEnd) {
			continue
		}
		c := p
		c.T = bEnd
		by.Set(bEnd, &c)
	}
	out := by.Values()
	sort.SliceStable(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

// sortedFrame returns the values with t >= cutoff, ascending by t.
func sortedFrame[T any](by *omap[int64, T], stamp func(T) int64, cutoff int64) []T {
	vals := by.Values()
	out := vals[:0:0]
	for _, v := range vals {
		if stamp(v) >= cutoff {
			out = append(out, v)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return stamp(out[i]) < stamp(out[j]) })
	return out
}

func oiStamp(p *OiAggPoint) int64  { return p.T }
func futStamp(p *FutOiPoint) int64 { return p.T }

func stampSet[T any](pts []T, stamp func(T) int64) []int64 {
	out := make([]int64, len(pts))
	for i, p := range pts {
		out[i] = stamp(p)
	}
	return out
}

// mergeOiFrameLocked is mergeOiFrame: backfilled points never overwrite a bucket that
// exists, except one flagged partial, which yields to a complete reading. The merged
// frame is pruned to retention and persisted whole.
func (s *Service) mergeOiFrameLocked(i int, backfilled []OiAggPoint) {
	cfg := frames[i]
	by := newOmap[int64, *OiAggPoint]()
	for _, p := range s.oiFrames[i] {
		by.Set(p.T, p)
	}
	for _, p := range downsampleAgg(backfilled, cfg.IntervalMin) {
		cur, ok := by.Get(p.T)
		if !ok || (cur.Partial && !p.Partial) {
			by.Set(p.T, p)
		}
	}
	now := s.nowMs()
	cutoff := now - cfg.RetentionMs
	before := stampSet(s.oiFrames[i], oiStamp)
	s.oiFrames[i] = sortedFrame(by, oiStamp, cutoff)
	s.persistWholeFrameLocked(oiFrameKey(cfg), toAny(s.oiFrames[i]), stampSet(s.oiFrames[i], oiStamp), before, frameTtlSec(cfg), now)
}

// mergeFutOiFrameLocked is mergeFutOiFrame: existing buckets always win.
func (s *Service) mergeFutOiFrameLocked(i int, backfilled []FutOiPoint) {
	cfg := frames[i]
	bsize := bucketSize(cfg)
	by := newOmap[int64, *FutOiPoint]()
	for _, p := range s.futFrames[i] {
		by.Set(p.T, p)
	}
	collapsed := newOmap[int64, FutOiPoint]()
	for _, p := range backfilled {
		bEnd := candleEndMs(p.T, bsize)
		if isPreOpenBucket(bEnd) {
			continue
		}
		collapsed.Set(bEnd, FutOiPoint{T: bEnd, Legs: p.Legs})
	}
	for _, bEnd := range collapsed.Keys() {
		p, _ := collapsed.Get(bEnd)
		if !by.Has(bEnd) {
			by.Set(bEnd, cloneFut(&p))
		}
	}
	now := s.nowMs()
	cutoff := now - cfg.RetentionMs
	before := stampSet(s.futFrames[i], futStamp)
	s.futFrames[i] = sortedFrame(by, futStamp, cutoff)
	s.persistWholeFrameLocked(futFrameKey(cfg), toAny(s.futFrames[i]), stampSet(s.futFrames[i], futStamp), before, frameTtlSec(cfg), now)
}

func toAny[T any](pts []T) []any {
	out := make([]any, len(pts))
	for i, p := range pts {
		out[i] = p
	}
	return out
}

// persistWholeFrameLocked mirrors a whole frame: every CLOSED bucket (t <= now) is
// written, buckets that left are dropped; a forming bucket counts as kept.
func (s *Service) persistWholeFrameLocked(rk string, values []any, stamps []int64, before []int64, ttl, now int64) {
	kept := make(map[int64]bool, len(stamps))
	for i, t := range stamps {
		kept[t] = true
		if t <= now {
			s.queueHashFieldLocked(rk, t, values[i], ttl, maxBufferedFrameFields)
		}
	}
	var gone []int64
	seen := map[int64]bool{}
	for _, t := range before {
		if seen[t] {
			continue
		}
		seen[t] = true
		if !kept[t] {
			gone = append(gone, t)
		}
	}
	s.queueHashDropLocked(rk, gone, ttl)
}

// collapseToBuckets groups a finer frame's points into bsize buckets keeping only the
// point that CLOSES each bucket (t == bucket end), skipping pre-open and unfinished ones.
func collapseToBuckets[T any](points []T, stamp func(T) int64, bsize, now int64) *omap[int64, T] {
	out := newOmap[int64, T]()
	for _, p := range points {
		t := stamp(p)
		bEnd := bucketEndMs(t, bsize)
		if isPreOpenBucket(bEnd) {
			continue
		}
		if bEnd > now {
			continue
		}
		if t != bEnd {
			continue
		}
		out.Set(bEnd, p)
	}
	return out
}

// coarsenOiFrameLocked is coarsenOiFrame: fill the coarse frame's missing (or partial)
// buckets from the finer source. Returns the number of buckets created.
func (s *Service) coarsenOiFrameLocked(i, src int, now int64) int {
	cfg := frames[i]
	collapsed := collapseToBuckets(s.oiFrames[src], oiStamp, bucketSize(cfg), now)
	if collapsed.Len() == 0 {
		return 0
	}
	cutoff := now - cfg.RetentionMs
	by := newOmap[int64, *OiAggPoint]()
	for _, p := range s.oiFrames[i] {
		by.Set(p.T, p)
	}
	filled := 0
	for _, bEnd := range collapsed.Keys() {
		p, _ := collapsed.Get(bEnd)
		if p.Partial {
			continue
		}
		if bEnd < cutoff {
			continue
		}
		if cur, ok := by.Get(bEnd); ok && !cur.Partial {
			continue
		}
		c := *p
		c.T = bEnd
		by.Set(bEnd, &c)
		filled++
	}
	if filled == 0 {
		return 0
	}
	before := stampSet(s.oiFrames[i], oiStamp)
	s.oiFrames[i] = sortedFrame(by, oiStamp, cutoff)
	s.persistWholeFrameLocked(oiFrameKey(cfg), toAny(s.oiFrames[i]), stampSet(s.oiFrames[i], oiStamp), before, frameTtlSec(cfg), now)
	return filled
}

// coarsenFutOiFrameLocked is coarsenFutOiFrame (no partial concept; existing wins).
func (s *Service) coarsenFutOiFrameLocked(i, src int, now int64) int {
	cfg := frames[i]
	collapsed := collapseToBuckets(s.futFrames[src], futStamp, bucketSize(cfg), now)
	if collapsed.Len() == 0 {
		return 0
	}
	cutoff := now - cfg.RetentionMs
	by := newOmap[int64, *FutOiPoint]()
	for _, p := range s.futFrames[i] {
		by.Set(p.T, p)
	}
	filled := 0
	for _, bEnd := range collapsed.Keys() {
		p, _ := collapsed.Get(bEnd)
		if bEnd < cutoff {
			continue
		}
		if by.Has(bEnd) {
			continue
		}
		by.Set(bEnd, cloneFut(&FutOiPoint{T: bEnd, Legs: p.Legs}))
		filled++
	}
	if filled == 0 {
		return 0
	}
	before := stampSet(s.futFrames[i], futStamp)
	s.futFrames[i] = sortedFrame(by, futStamp, cutoff)
	s.persistWholeFrameLocked(futFrameKey(cfg), toAny(s.futFrames[i]), stampSet(s.futFrames[i], futStamp), before, frameTtlSec(cfg), now)
	return filled
}

// coarsenFrames rebuilds every coarse frame's older buckets from the finer frames, both
// families, with ONE now. Pure memory work plus buffered writes.
func (s *Service) coarsenFrames() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.coarsenFramesLocked()
}

func (s *Service) coarsenFramesLocked() {
	now := s.nowMs()
	for i, cfg := range frames {
		src := coarsenSource[i]
		if src < 0 {
			continue
		}
		opt := s.coarsenOiFrameLocked(i, src, now)
		fut := s.coarsenFutOiFrameLocked(i, src, now)
		if opt > 0 || fut > 0 {
			s.logf("[OptionOI] Derived %d option and %d futures %s bucket(s) from the %s frame (no Kite calls).",
				opt, fut, cfg.Key, frames[src].Key)
		}
	}
}

// mergeWarmLoaded folds loaded points into a frame; points already there win. Returns
// how many buckets were added.
func mergeWarmLoaded[T any](store *[]T, loaded []T, stamp func(T) int64) int {
	if len(loaded) == 0 {
		return 0
	}
	existing := map[int64]bool{}
	for _, p := range *store {
		existing[stamp(p)] = true
	}
	by := newOmap[int64, T]()
	for _, p := range loaded {
		by.Set(stamp(p), p)
	}
	for _, p := range *store {
		by.Set(stamp(p), p)
	}
	vals := by.Values()
	sort.SliceStable(vals, func(i, j int) bool { return stamp(vals[i]) < stamp(vals[j]) })
	*store = vals
	added := 0
	for _, t := range by.Keys() {
		if !existing[t] {
			added++
		}
	}
	return added
}
