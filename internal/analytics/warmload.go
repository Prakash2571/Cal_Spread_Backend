package analytics

import (
	"context"
	"sort"
)

// The boot warm load (index.ts warmLoadFromRedis :953-1042). It must complete before
// Start, which snapshots the backfill windows from whatever the stores hold.

func (s *Service) logCacheStatus() {
	if s.cacheEnabled() {
		s.logf("[Cache] Enabled (PostgreSQL). Analytics caches will persist.")
		return
	}
	s.mu.Lock()
	warned := s.warnedDisabled
	s.warnedDisabled = true
	s.mu.Unlock()
	if !warned {
		s.logf("[Cache] DATABASE_URL not set — analytics caches are in-memory only and will be rebuilt from Kite after every restart.")
	}
}

// cacheReadable is canSend() for a read: enabled and not cooling down.
func (s *Service) cacheReadable() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.canSendLocked()
}

// hgetAll is hGetAllJson's transport half: the hash's raw values, empty when the cache
// cannot be read. Fields are returned in ascending numeric order (Redis gave no order;
// only duplicate stamps could make it matter).
func (s *Service) hgetAll(ctx context.Context, key string) []string {
	if !s.cacheReadable() {
		return nil
	}
	var m map[string]string
	err := s.cacheCall(ctx, func(c context.Context) error {
		var err error
		m, err = s.d.Cache.HGetAll(c, key)
		return err
	}, true)
	if err != nil {
		return nil
	}
	fields := make([]string, 0, len(m))
	for f := range m {
		fields = append(fields, f)
	}
	sort.SliceStable(fields, func(i, j int) bool {
		a, b := jsNumberString(fields[i]), jsNumberString(fields[j])
		if a != b {
			return a < b
		}
		return fields[i] < fields[j]
	})
	out := make([]string, len(fields))
	for i, f := range fields {
		out[i] = m[f]
	}
	return out
}

// getRaw is redis getJson's transport half.
func (s *Service) getRaw(ctx context.Context, key string) (string, bool) {
	if !s.cacheReadable() {
		return "", false
	}
	var v string
	var ok bool
	err := s.cacheCall(ctx, func(c context.Context) error {
		var err error
		v, ok, err = s.d.Cache.Get(c, key)
		return err
	}, true)
	return v, err == nil && ok
}

func (s *Service) ping(ctx context.Context) bool {
	if !s.cacheReadable() {
		return false
	}
	return s.cacheCall(ctx, func(c context.Context) error { return s.d.Cache.Ping(c) }, true) == nil
}

// WarmLoad restores every persisted cache, keeping anything already in memory (a login
// during the load may have captured newer readings), then derives the coarse frames.
func (s *Service) WarmLoad(ctx context.Context) {
	s.logCacheStatus()
	if !s.cacheEnabled() {
		return
	}
	if !s.ping(ctx) {
		s.logf("[Cache] PING failed — starting with empty in-memory caches.")
		return
	}
	now := s.nowMs()
	loaded := 0
	for i, cfg := range frames {
		cutoff := now - cfg.RetentionMs
		var opt []*OiAggPoint
		for _, raw := range s.hgetAll(ctx, oiFrameKey(cfg)) {
			if p, ok := decodeOiPoint(raw); ok && p.T >= cutoff {
				opt = append(opt, p)
			}
		}
		s.mu.Lock()
		loaded += mergeWarmLoaded(&s.oiFrames[i], opt, oiStamp)
		s.mu.Unlock()

		var fut []*FutOiPoint
		for _, raw := range s.hgetAll(ctx, futFrameKey(cfg)) {
			if p, ok := decodeFutPoint(raw); ok && p.T >= cutoff {
				fut = append(fut, p)
			}
		}
		s.mu.Lock()
		loaded += mergeWarmLoaded(&s.futFrames[i], fut, futStamp)
		s.mu.Unlock()
	}

	if raw, ok := s.getRaw(ctx, "futcontracts"); ok {
		if cs, ok := decodeContracts(raw); ok {
			s.mu.Lock()
			for _, c := range cs {
				s.futKnown.Set(c.Expiry, c)
			}
			s.mu.Unlock()
		}
	}

	if raw, ok := s.getRaw(ctx, "prevclose"); ok {
		if prev, ok := decodePrevClose(raw); ok && prev.ForDay == istDayKey(s.nowMs()) {
			s.mu.Lock()
			s.prevClose = prev
			s.mu.Unlock()
			s.logf("[Cache] Restored previous-close baseline (%d tokens from %s) — no Kite backfill needed.", len(prev.Order), prev.ClosedOn)
		}
	}

	var minute []*ChainSnapshot
	for _, raw := range s.hgetAll(ctx, chainMinuteKey(istDayKey(s.nowMs()))) {
		if sn, ok := decodeSnapshot(raw); ok && sn.T >= now-chainMinuteRetentionMs {
			minute = append(minute, sn)
		}
	}
	s.mu.Lock()
	s.chainMin, _ = mergeWarmLoadedSnaps(s.chainMin, minute)
	s.mu.Unlock()
	for d := int64(0); d <= 4; d++ {
		day := istDayKey(now - d*dayMs)
		var hour []*ChainSnapshot
		for _, raw := range s.hgetAll(ctx, chainHourKey(day)) {
			if sn, ok := decodeSnapshot(raw); ok && sn.T >= now-chainHourRetentionMs {
				hour = append(hour, sn)
			}
		}
		s.mu.Lock()
		s.chainHour, _ = mergeWarmLoadedSnaps(s.chainHour, hour)
		s.mu.Unlock()
	}

	s.mu.Lock()
	nMin, nHour := len(s.chainMin), len(s.chainHour)
	s.mu.Unlock()
	s.logf("[Cache] Warm-loaded %d frame points, %d minute and %d hourly chain snapshots.", loaded, nMin, nHour)

	s.coarsenFrames()
}
