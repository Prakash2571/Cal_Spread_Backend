// Package fairvalue is the Fair Value service around the pure model in ./model: the
// bounded in-memory history, the PostgreSQL store, the analytics worker pool, the engine
// (universe, ticks, scheduling, publication, caches) and the /api/fair-value routes.
// It is a port of src/fairValue/{history,store,workers,worker,engine,routes,index}.ts.
package fairvalue

import (
	"sync"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
)

type historyEntry struct {
	id       string
	snapshot *model.SurfaceSnapshot
	bytes    int
}

// SnapshotHistory is history.ts SnapshotHistory: memory history with count, time,
// underlying-count AND byte ceilings. Entries are kept in insertion order (oldest
// first). It is safe for concurrent use.
type SnapshotHistory struct {
	mu             sync.Mutex
	entries        []historyEntry
	bytes          int
	maxBytes       int
	maxUnderlyings int
	now            func() float64
}

// NewSnapshotHistory returns an empty history.
func NewSnapshotHistory(maxBytes, maxUnderlyings int, now func() float64) *SnapshotHistory {
	return &SnapshotHistory{maxBytes: maxBytes, maxUnderlyings: maxUnderlyings, now: now}
}

func (h *SnapshotHistory) index(id string) int {
	for i, e := range h.entries {
		if e.id == id {
			return i
		}
	}
	return -1
}

func (h *SnapshotHistory) remove(id string) {
	if i := h.index(id); i >= 0 {
		h.bytes -= h.entries[i].bytes
		h.entries = append(h.entries[:i:i], h.entries[i+1:]...)
	}
}

// Add records a published snapshot (history.ts add). A snapshot larger than the byte
// ceiling is ignored; re-adding an id moves it to the newest position.
func (h *SnapshotHistory) Add(snapshot *model.SurfaceSnapshot, perUnderlyingLimit, retentionDays float64) {
	bytes := len(jsjson.Marshal(snapshot)) // Buffer.byteLength(JSON.stringify(snapshot))
	h.mu.Lock()
	defer h.mu.Unlock()
	if bytes > h.maxBytes {
		return
	}
	h.remove(snapshot.ID)
	h.entries = append(h.entries, historyEntry{id: snapshot.ID, snapshot: snapshot, bytes: bytes})
	h.bytes += bytes
	cutoff := h.now() - retentionDays*86400000
	type group struct {
		underlying string
		ids        []string
	}
	groups := []*group{}
	byUnderlying := map[string]*group{}
	newestFirst := append([]historyEntry(nil), h.entries...)
	for i, j := 0, len(newestFirst)-1; i < j; i, j = i+1, j-1 {
		newestFirst[i], newestFirst[j] = newestFirst[j], newestFirst[i]
	}
	for _, e := range newestFirst {
		if model.DateParse(e.snapshot.PublishedAt) < cutoff {
			h.remove(e.id)
			continue
		}
		g := byUnderlying[e.snapshot.Underlying]
		if g == nil {
			g = &group{underlying: e.snapshot.Underlying}
		}
		if float64(len(g.ids)) >= perUnderlyingLimit {
			h.remove(e.id)
			continue
		}
		g.ids = append(g.ids, e.id)
		if byUnderlying[e.snapshot.Underlying] == nil {
			byUnderlying[e.snapshot.Underlying] = g
			groups = append(groups, g)
		}
	}
	if len(groups) > h.maxUnderlyings {
		for _, g := range groups[h.maxUnderlyings:] {
			for _, id := range g.ids {
				h.remove(id)
			}
		}
	}
	for h.bytes > h.maxBytes && len(h.entries) > 0 {
		h.remove(h.entries[0].id)
	}
}

// List returns the retained snapshots of underlying, newest first.
func (h *SnapshotHistory) List(underlying string, retentionDays float64) []*model.SurfaceSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	cutoff := h.now() - retentionDays*86400000
	out := []*model.SurfaceSnapshot{}
	for i := len(h.entries) - 1; i >= 0; i-- {
		s := h.entries[i].snapshot
		if s.Underlying == underlying && model.DateParse(s.PublishedAt) >= cutoff {
			out = append(out, s)
		}
	}
	return out
}

// Get returns one retained snapshot, or nil.
func (h *SnapshotHistory) Get(underlying, id string, retentionDays float64) *model.SurfaceSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	i := h.index(id)
	if i < 0 {
		return nil
	}
	s := h.entries[i].snapshot
	if s.Underlying == underlying && model.DateParse(s.PublishedAt) >= h.now()-retentionDays*86400000 {
		return s
	}
	return nil
}

// HistoryStats is history.ts stats().
type HistoryStats struct {
	Snapshots float64 `json:"snapshots"`
	Bytes     float64 `json:"bytes"`
}

// Stats reports the entry count and byte total.
func (h *SnapshotHistory) Stats() HistoryStats {
	h.mu.Lock()
	defer h.mu.Unlock()
	return HistoryStats{Snapshots: float64(len(h.entries)), Bytes: float64(h.bytes)}
}
