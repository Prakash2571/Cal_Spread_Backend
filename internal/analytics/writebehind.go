package analytics

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// The write-behind buffer of index.ts :493-760 with the redis.ts transport rules,
// writing to the PostgreSQL cache instead of Upstash:
//
//   - writes are buffered per key and field (a re-written bucket collapses, a re-add
//     cancels a pending delete) and serialised when the flush starts, as Node did;
//   - one flush at a time; a flush asked for while one is in flight runs right after it;
//   - EXPIRE is sent at most every 15 minutes per key and stamped only after success;
//   - a failed flush is re-queued with newer writes taking precedence, and the backlog is
//     capped per key by dropping the oldest buckets;
//   - three consecutive failures mute the cache for 60 s; every call is bounded by 8 s.

const (
	redisTTLSlackMs           int64 = 24 * 60 * 60 * 1000 // REDIS_TTL_SLACK_MS
	maxBufferedFrameFields          = 3000                // MAX_BUFFERED_FRAME_FIELDS
	maxBufferedSnapshotFields       = 60                  // MAX_BUFFERED_SNAPSHOT_FIELDS
	ttlRefreshEveryMs         int64 = 15 * 60 * 1000      // TTL_REFRESH_EVERY_MS

	cacheTimeout       = 8 * time.Second // redis.ts TIMEOUT_MS
	cacheFailThreshold = 3               // FAIL_THRESHOLD
	cacheCooldownMs    = int64(60 * 1000)
	flushRetryInterval = 60 * time.Second
)

type pendingHash struct {
	entries   *omap[string, any]
	stale     *omap[string, struct{}]
	ttlSec    int64
	maxFields int
}

type plainWrite struct {
	value  any
	ttlSec int64
}

// cacheOp is one command of a flush, in the order Node put it in the pipeline.
type cacheOp struct {
	Kind   string   // HSET, HDEL, EXPIRE, SET
	Key    string   // without the calspread: prefix
	Fields []string // HSET: field, value, field, value…; HDEL: fields
	Value  string   // SET
	TTL    int64    // EXPIRE / SET … EX, seconds
}

type flushBatch struct {
	hashes  *omap[string, *pendingHash]
	plains  *omap[string, plainWrite]
	ops     []cacheOp
	ttlSent []string
	now     int64
	done    chan struct{}
}

func (s *Service) cacheEnabled() bool { return s.d.Cache != nil && s.d.Cache.Enabled() }

func (s *Service) pendingForLocked(key string, ttlSec int64, maxFields int) *pendingHash {
	p, ok := s.pendingHash.Get(key)
	if !ok {
		p = &pendingHash{entries: newOmap[string, any](), stale: newOmap[string, struct{}](), ttlSec: ttlSec, maxFields: maxFields}
		s.pendingHash.Set(key, p)
	}
	p.ttlSec = ttlSec
	p.maxFields = maxFields
	return p
}

// queueHashFieldLocked is queueHashField(key, field, value, ttl, maxFields). value is
// kept by reference and serialised when the flush starts.
func (s *Service) queueHashFieldLocked(key string, field int64, value any, ttlSec int64, maxFields int) {
	if !s.cacheEnabled() {
		return
	}
	p := s.pendingForLocked(key, ttlSec, maxFields)
	f := strconv.FormatInt(field, 10)
	p.stale.Delete(f)
	p.entries.Set(f, value)
}

// queueHashDropLocked is queueHashDrop: retention-pruned fields are deleted.
func (s *Service) queueHashDropLocked(key string, fields []int64, ttlSec int64) {
	if !s.cacheEnabled() || len(fields) == 0 {
		return
	}
	p := s.pendingForLocked(key, ttlSec, maxBufferedFrameFields)
	for _, field := range fields {
		f := strconv.FormatInt(field, 10)
		p.entries.Delete(f)
		p.stale.Set(f, struct{}{})
	}
}

// queuePlainWriteLocked is queuePlainWrite: a whole-key JSON value.
func (s *Service) queuePlainWriteLocked(key string, value any, ttlSec int64) {
	if !s.cacheEnabled() {
		return
	}
	s.pendingPlain.Set(key, plainWrite{value: value, ttlSec: ttlSec})
}

func (s *Service) hasPendingLocked() bool { return s.pendingHash.Len() > 0 || s.pendingPlain.Len() > 0 }

// canSendLocked is redis.ts canSend(): enabled and not cooling down.
func (s *Service) canSendLocked() bool { return s.cacheEnabled() && s.nowMs() >= s.mutedUntil }

// hashWriteOps is redis.ts hashWriteCommands: HSET of every entry, HDEL of the stale
// fields, then EXPIRE when a TTL is given and the key was touched.
func hashWriteOps(key string, entries *omap[string, any], stale []string, ttlSec int64) []cacheOp {
	var ops []cacheOp
	if entries.Len() > 0 {
		pairs := make([]string, 0, 2*entries.Len())
		for _, f := range entries.Keys() {
			v, _ := entries.Get(f)
			pairs = append(pairs, f, string(jsjson.Marshal(v)))
		}
		ops = append(ops, cacheOp{Kind: "HSET", Key: key, Fields: pairs})
	}
	if len(stale) > 0 {
		ops = append(ops, cacheOp{Kind: "HDEL", Key: key, Fields: append([]string(nil), stale...)})
	}
	if len(ops) > 0 && ttlSec > 0 {
		ops = append(ops, cacheOp{Kind: "EXPIRE", Key: key, TTL: ttlSec})
	}
	return ops
}

// beginFlushLocked is the synchronous part of flushRedisWrites: it detaches the buffer and
// builds the commands, or records a re-run when a flush is already in flight. force skips
// the cooldown (the final flush at shutdown). It returns nil when there is nothing to send.
func (s *Service) beginFlushLocked(force bool) *flushBatch {
	if !s.cacheEnabled() {
		return nil
	}
	if s.flushInFlight {
		s.flushAgain = true
		return nil
	}
	if !s.hasPendingLocked() {
		return nil
	}
	if !force && !s.canSendLocked() {
		return nil
	}
	s.flushInFlight = true
	s.flushAgain = false
	b := &flushBatch{hashes: s.pendingHash, plains: s.pendingPlain, now: s.nowMs(), done: make(chan struct{})}
	s.flushDone = b.done
	s.pendingHash = newOmap[string, *pendingHash]()
	s.pendingPlain = newOmap[string, plainWrite]()
	for _, key := range b.hashes.Keys() {
		p, _ := b.hashes.Get(key)
		last := s.ttlRefreshedAt[key]
		withTTL := b.now-last > ttlRefreshEveryMs
		ttl := int64(0)
		if withTTL {
			ttl = p.ttlSec
			b.ttlSent = append(b.ttlSent, key)
		}
		b.ops = append(b.ops, hashWriteOps(key, p.entries, p.stale.Keys(), ttl)...)
	}
	for _, key := range b.plains.Keys() {
		p, _ := b.plains.Get(key)
		op := cacheOp{Kind: "SET", Key: key, Value: string(jsjson.Marshal(p.value))}
		if p.ttlSec > 0 {
			op.TTL = p.ttlSec
		}
		b.ops = append(b.ops, op)
	}
	return b
}

// runFlush sends a batch and settles it. It reports whether a flush was asked for while
// this one was in flight (the caller runs it next).
func (s *Service) runFlush(b *flushBatch) (again bool) {
	ok := false
	if len(b.ops) > 0 {
		if s.onFlushOps != nil {
			s.onFlushOps(b.ops)
		}
		ok = s.execOps(b.ops)
	}
	s.mu.Lock()
	if ok {
		for _, key := range b.ttlSent {
			s.ttlRefreshedAt[key] = b.now
		}
	} else {
		s.requeueFailedWritesLocked(b.hashes, b.plains)
	}
	s.flushInFlight = false
	again = s.flushAgain
	s.flushAgain = false
	close(b.done)
	if s.flushDone == b.done {
		s.flushDone = nil
	}
	s.mu.Unlock()
	return again
}

// flush is `await flushRedisWrites()`.
func (s *Service) flush() {
	s.mu.Lock()
	b := s.beginFlushLocked(false)
	s.mu.Unlock()
	if b == nil {
		return
	}
	if s.runFlush(b) {
		s.voidFlush()
	}
}

// voidFlush is `void flushRedisWrites()`.
func (s *Service) voidFlush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.voidFlushLocked()
}

// voidFlushLocked is `void flushRedisWrites()` with s.mu held: the synchronous part runs
// now, the writes on a goroutine. After Stop the buffer stays pending for FlushNow.
func (s *Service) voidFlushLocked() {
	if s.stopped {
		return
	}
	b := s.beginFlushLocked(false)
	if b == nil {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if s.runFlush(b) {
			s.voidFlush()
		}
	}()
}

// execOps sends the commands in order; the first failure fails the whole flush (Node's
// pipeline failed as a whole, and HSET/HDEL/SET are idempotent, so re-sending is safe).
// The writes are not tied to the service context: Stop lets a flush in flight finish.
func (s *Service) execOps(ops []cacheOp) bool {
	c := s.d.Cache
	for _, op := range ops {
		err := s.cacheCall(context.Background(), func(ctx context.Context) error {
			switch op.Kind {
			case "HSET":
				fields := make(map[string]string, len(op.Fields)/2)
				for i := 0; i+1 < len(op.Fields); i += 2 {
					fields[op.Fields[i]] = op.Fields[i+1]
				}
				return c.HSet(ctx, op.Key, fields)
			case "HDEL":
				return c.HDel(ctx, op.Key, op.Fields...)
			case "EXPIRE":
				_, err := c.Expire(ctx, op.Key, time.Duration(op.TTL)*time.Second)
				return err
			case "SET":
				return c.Set(ctx, op.Key, op.Value, time.Duration(op.TTL)*time.Second)
			}
			return nil
		}, false)
		if err != nil {
			return false
		}
	}
	s.mu.Lock()
	s.consecutiveFailures = 0
	s.mu.Unlock()
	return true
}

// cacheCall runs one cache operation with the 8 s bound and the failure accounting of
// redis.ts postPipeline. countSuccess resets the failure count on success (reads do; a
// flush resets it once, after its last command).
func (s *Service) cacheCall(parent context.Context, f func(ctx context.Context) error, countSuccess bool) error {
	ctx, cancel := context.WithTimeout(parent, cacheTimeout)
	defer cancel()
	err := f(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil {
		if countSuccess {
			s.consecutiveFailures = 0
		}
		return nil
	}
	s.consecutiveFailures++
	if s.consecutiveFailures >= cacheFailThreshold {
		s.mutedUntil = s.nowMs() + cacheCooldownMs
		s.logf("[Cache] %d consecutive failures (%s) — pausing for %ds; caches stay in memory.",
			s.consecutiveFailures, errText(err), cacheCooldownMs/1000)
		s.consecutiveFailures = 0
	} else {
		s.logf("[Cache] command failed: %s", errText(err))
	}
	return err
}

// requeueFailedWritesLocked puts a failed batch back, letting anything queued since take
// precedence, then caps every key's backlog by dropping its numerically smallest
// (oldest) fields.
func (s *Service) requeueFailedWritesLocked(hashes *omap[string, *pendingHash], plains *omap[string, plainWrite]) {
	for _, key := range hashes.Keys() {
		old, _ := hashes.Get(key)
		cur, ok := s.pendingHash.Get(key)
		if !ok {
			s.pendingHash.Set(key, old)
			continue
		}
		for _, f := range old.entries.Keys() {
			if !cur.entries.Has(f) && !cur.stale.Has(f) {
				v, _ := old.entries.Get(f)
				cur.entries.Set(f, v)
			}
		}
		for _, f := range old.stale.Keys() {
			if !cur.entries.Has(f) {
				cur.stale.Set(f, struct{}{})
			}
		}
	}
	for _, key := range plains.Keys() {
		if !s.pendingPlain.Has(key) {
			p, _ := plains.Get(key)
			s.pendingPlain.Set(key, p)
		}
	}
	for _, key := range s.pendingHash.Keys() {
		p, _ := s.pendingHash.Get(key)
		over := p.entries.Len() - p.maxFields
		if over <= 0 {
			continue
		}
		fields := p.entries.Keys()
		sort.SliceStable(fields, func(i, j int) bool { return jsNumberString(fields[i]) < jsNumberString(fields[j]) })
		for _, f := range fields[:over] {
			p.entries.Delete(f)
		}
		s.logf("[Cache] %s: dropped %d buffered buckets (cache unreachable; they stay recoverable from Kite).", key, over)
	}
}

// FlushNow writes everything still buffered, waiting for a flush in flight first. It is
// the final flush during shutdown (a PLAN.md decision; Node never flushed on shutdown),
// so it ignores the failure cooldown. Call it after Stop and before the pool closes.
func (s *Service) FlushNow(ctx context.Context) error {
	for attempt := 0; attempt < 4; attempt++ {
		s.mu.Lock()
		if done := s.flushDone; s.flushInFlight && done != nil {
			s.mu.Unlock()
			select {
			case <-done:
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}
		b := s.beginFlushLocked(true)
		s.mu.Unlock()
		if b == nil {
			return nil
		}
		s.runFlush(b)
		s.mu.Lock()
		left := s.hasPendingLocked()
		s.mu.Unlock()
		if !left {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasPendingLocked() {
		return errFlushIncomplete(s.pendingHash.Keys(), s.pendingPlain.Keys())
	}
	return nil
}

type flushIncomplete string

func (e flushIncomplete) Error() string { return string(e) }

func errFlushIncomplete(hashes, plains []string) error {
	return flushIncomplete("analytics: final cache flush left writes pending for " + strings.Join(append(hashes, plains...), ", "))
}
