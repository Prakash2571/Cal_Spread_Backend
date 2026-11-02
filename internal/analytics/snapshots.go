package analytics

import "math"

// Per-token chain snapshots (index.ts :762-905): the source of the chain's OI change
// columns. Minute snapshots are kept for a day, hour snapshots (overwritten by every
// minute inside the hour, so they hold its closing reading) for four days.

const (
	chainMinuteRetentionMs = 1 * dayMs
	chainHourRetentionMs   = 4 * dayMs
)

func chainMinuteKey(day string) string { return "chainsnap:min:" + day }
func chainHourKey(day string) string   { return "chainsnap:hour:" + day }

// upsertSnapshot inserts or replaces snap in a list ascending by t, scanning from the tail.
func upsertSnapshot(list []*ChainSnapshot, snap *ChainSnapshot) []*ChainSnapshot {
	for i := len(list) - 1; i >= 0; i-- {
		cur := list[i]
		if cur.T == snap.T {
			list[i] = snap
			return list
		}
		if cur.T < snap.T {
			list = append(list, nil)
			copy(list[i+2:], list[i+1:])
			list[i+1] = snap
			return list
		}
	}
	return append([]*ChainSnapshot{snap}, list...)
}

// recordChainSnapshotLocked records this capture's readings (every token whose newest
// sample has oi > 0) into both cadences and queues them for the cache.
func (s *Service) recordChainSnapshotLocked(d *oiDay, t int64) {
	var toks []int64
	vals := map[int64]snapTok{}
	for _, tok := range d.meta.keys {
		arr, ok := d.series[tok]
		if !ok || len(arr) == 0 {
			continue
		}
		last := arr[len(arr)-1]
		if last.oi <= 0 {
			continue
		}
		if _, dup := vals[tok]; !dup {
			toks = append(toks, tok)
		}
		vals[tok] = snapTok{Token: tok, OI: last.oi, LTP: last.ltp}
	}
	if len(toks) == 0 {
		return
	}
	order := jsTokenOrder(toks)
	tokens := make([]snapTok, len(order))
	for i, tok := range order {
		tokens[i] = vals[tok]
	}
	minuteT := bucketEndMs(t, minuteMs)
	hourT := bucketEndMs(t, hourMs)
	minuteSnap := &ChainSnapshot{T: minuteT, Expiry: d.expiry, Tokens: tokens}
	hourSnap := &ChainSnapshot{T: hourT, Expiry: d.expiry, Tokens: tokens}
	s.chainMin = upsertSnapshot(s.chainMin, minuteSnap)
	s.chainHour = upsertSnapshot(s.chainHour, hourSnap)

	minuteTTL := (chainMinuteRetentionMs + redisTTLSlackMs) / 1000
	hourTTL := (chainHourRetentionMs + redisTTLSlackMs) / 1000
	s.queueHashFieldLocked(chainMinuteKey(d.day), minuteT, minuteSnap, minuteTTL, maxBufferedSnapshotFields)
	s.queueHashFieldLocked(chainHourKey(d.day), hourT, hourSnap, hourTTL, maxBufferedSnapshotFields)

	minCutoff := t - chainMinuteRetentionMs
	for len(s.chainMin) > 0 && s.chainMin[0].T < minCutoff {
		s.chainMin = s.chainMin[1:]
	}
	hourCutoff := t - chainHourRetentionMs
	for len(s.chainHour) > 0 && s.chainHour[0].T < hourCutoff {
		s.chainHour = s.chainHour[1:]
	}
}

// chainBaselineAtLocked is the snapshot to compare against for a cutoff: the last one
// of TODAY at or before cutoff, minute cadence preferred, hourly as the fallback.
func (s *Service) chainBaselineAtLocked(cutoff, now int64) *ChainSnapshot {
	dayStart := istTimeOnDayMs(now, 0)
	pick := func(list []*ChainSnapshot) *ChainSnapshot {
		var best *ChainSnapshot
		for _, sn := range list {
			if sn.T > cutoff {
				break
			}
			if sn.T >= dayStart {
				best = sn
			}
		}
		return best
	}
	if b := pick(s.chainMin); b != nil {
		return b
	}
	return pick(s.chainHour)
}

// chainSnapshotSpanLocked is the oldest/newest snapshot of today over both cadences.
func (s *Service) chainSnapshotSpanLocked(now int64) (oldest, newest *int64) {
	dayStart := istTimeOnDayMs(now, 0)
	for _, list := range [][]*ChainSnapshot{s.chainMin, s.chainHour} {
		for _, sn := range list {
			if sn.T < dayStart {
				continue
			}
			t := sn.T
			if oldest == nil || t < *oldest {
				v := t
				oldest = &v
			}
			if newest == nil || t > *newest {
				v := t
				newest = &v
			}
		}
	}
	return oldest, newest
}

// mergeWarmLoadedSnaps folds loaded snapshots in; a snapshot already present wins.
func mergeWarmLoadedSnaps(list []*ChainSnapshot, loaded []*ChainSnapshot) ([]*ChainSnapshot, int) {
	have := map[int64]bool{}
	for _, sn := range list {
		have[sn.T] = true
	}
	added := 0
	for _, sn := range loaded {
		if have[sn.T] {
			continue
		}
		list = upsertSnapshot(list, sn)
		have[sn.T] = true
		added++
	}
	return list, added
}

// snapshotPrevCloseLocked keeps the outgoing day's last reading per token as forDay's
// baseline, unless the index never moved that day (a holiday-like session).
func (s *Service) snapshotPrevCloseLocked(prev *oiDay, forDay string) {
	spotLo := math.Inf(1)
	spotHi := math.Inf(-1)
	for _, sp := range prev.spot {
		if sp.ltp <= 0 {
			continue
		}
		spotLo = math.Min(spotLo, sp.ltp)
		spotHi = math.Max(spotHi, sp.ltp)
	}
	if !(spotHi > spotLo) {
		s.logf("[OptionOI] %s had no index movement — not using it as %s's baseline.", prev.day, forDay)
		return
	}
	pc := &PrevClose{ForDay: forDay, ClosedOn: prev.day, Expiry: prev.expiry, Complete: true, Tokens: map[int64]OiLtp{}}
	var toks []int64
	for _, tok := range prev.meta.keys {
		arr, ok := prev.series[tok]
		if !ok || len(arr) == 0 {
			continue
		}
		last := arr[len(arr)-1]
		if last.oi > 0 {
			if _, dup := pc.Tokens[tok]; !dup {
				toks = append(toks, tok)
			}
			pc.Tokens[tok] = OiLtp{OI: last.oi, LTP: last.ltp}
		}
	}
	if len(toks) == 0 {
		return
	}
	pc.Order = jsTokenOrder(toks)
	s.prevClose = pc
	s.persistPrevCloseLocked()
	s.logf("[OptionOI] Captured %s close for %d tokens (baseline for %s).", prev.day, len(toks), forDay)
}

// persistPrevCloseLocked queues the baseline (TTL two days) and starts a flush at once
// (void flushRedisWrites()): it is the one cache that costs ~240 Kite calls to rebuild.
func (s *Service) persistPrevCloseLocked() {
	if s.prevClose == nil || !s.cacheEnabled() {
		return
	}
	s.queuePlainWriteLocked("prevclose", s.prevClose, 2*24*60*60)
	s.voidFlushLocked()
}
