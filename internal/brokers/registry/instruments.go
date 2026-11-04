package registry

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// InstrumentTTL is how long a broker's instrument dump is reused (instrumentProvider.ts
// CACHE_TTL_MS).
const InstrumentTTL = time.Hour

type instrumentCache struct {
	at     int64
	data   []market.Instrument
	broker brokers.ID
	// dhanRows are the same rows with their Dhan identity (Dhan caches only), for the
	// routes that serialise raw instrument rows.
	dhanRows []dhan.Instrument
	// tokens is the memoised ownsToken index, built on first use.
	tokens map[int64]struct{}
}

type instrumentLoad struct {
	done chan struct{}
	data []market.Instrument
	err  error
}

// InstrumentProvider is the ACTIVE broker's instrument universe (instrumentProvider.ts):
// one cache per broker, scoped to the broker generation it was loaded under, so a switch
// can never serve the other broker's dump.
type InstrumentProvider struct {
	r *Registry

	mu           sync.Mutex
	caches       map[brokers.ID]*instrumentCache
	generationAt map[brokers.ID]int64
	inFlight     map[brokers.ID]*instrumentLoad
}

// Load returns the active broker's universe. A fresh cache (same broker and generation,
// younger than an hour, non-empty) is returned unless force; concurrent unforced callers
// share one fetch, a forced call always starts its own. The Dhan path goes through the
// Dhan master's own one-hour cache, so force does not force a Dhan re-download.
func (p *InstrumentProvider) Load(ctx context.Context, force bool) ([]market.Instrument, error) {
	namespace, err := p.r.namespaceFor(ctx)
	if err != nil {
		return nil, err
	}
	broker, generation := namespace.Broker, namespace.Generation
	now := p.r.nowMs()

	p.mu.Lock()
	cached := p.caches[broker]
	cachedGen, hasGen := p.generationAt[broker]
	fresh := cached != nil && cached.broker == broker && hasGen && cachedGen == generation &&
		now-cached.at < InstrumentTTL.Milliseconds() && len(cached.data) > 0
	if fresh && !force {
		data := cached.data
		p.mu.Unlock()
		return data, nil
	}
	if existing := p.inFlight[broker]; existing != nil && !force {
		p.mu.Unlock()
		return existing.wait(ctx)
	}
	task := &instrumentLoad{done: make(chan struct{})}
	p.inFlight[broker] = task
	p.mu.Unlock()

	go func() {
		data, dhanRows, err := p.fetchFor(broker)
		p.mu.Lock()
		if err == nil {
			p.caches[broker] = &instrumentCache{at: p.r.nowMs(), data: data, broker: broker, dhanRows: dhanRows}
			p.generationAt[broker] = generation
		}
		// Like the TypeScript .finally: whatever load is in flight for this broker is
		// forgotten, even a newer forced one.
		delete(p.inFlight, broker)
		task.data, task.err = data, err
		p.mu.Unlock()
		close(task.done)
	}()
	return task.wait(ctx)
}

func (l *instrumentLoad) wait(ctx context.Context) ([]market.Instrument, error) {
	select {
	case <-l.done:
		return l.data, l.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *InstrumentProvider) fetchFor(broker brokers.ID) ([]market.Instrument, []dhan.Instrument, error) {
	if broker == brokers.Dhan {
		rows, err := p.r.dhanInstruments.Load(context.Background(), false)
		if err != nil {
			return nil, nil, err
		}
		data := make([]market.Instrument, len(rows))
		for i := range rows {
			data[i] = rows[i].Instrument
		}
		log.Printf("[Broker] Dhan universe loaded: %s instruments", localeInt(len(rows)))
		return data, rows, nil
	}
	rows, err := p.r.deps.Kite.GetInstruments(context.Background(), "")
	if err != nil {
		return nil, nil, err
	}
	log.Printf("[Broker] Zerodha universe loaded: %s instruments", localeInt(len(rows)))
	return rows, nil, nil
}

// Size is how many instruments the active broker's cached universe holds.
func (p *InstrumentProvider) Size() int { return p.sizeFor(p.r.ActiveBroker()) }

func (p *InstrumentProvider) sizeFor(broker brokers.ID) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.caches[broker]; c != nil {
		return len(c.data)
	}
	return 0
}

// LoadedAt is the epoch ms the active broker's universe was cached, nil when none.
func (p *InstrumentProvider) LoadedAt() *int64 { return p.loadedAtFor(p.r.ActiveBroker()) }

func (p *InstrumentProvider) loadedAtFor(broker brokers.ID) *int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.caches[broker]; c != nil {
		at := c.at
		return &at
	}
	return nil
}

// Invalidate drops one broker's cached universe, or every broker's when broker is "".
// Loads in flight and their results are not cancelled.
func (p *InstrumentProvider) Invalidate(broker brokers.ID) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if broker != "" {
		delete(p.caches, broker)
		delete(p.generationAt, broker)
		return
	}
	p.caches = map[brokers.ID]*instrumentCache{}
	p.generationAt = map[brokers.ID]int64{}
}

// OwnsToken reports whether token belongs to the active broker's cached universe; known
// is false when no universe is cached, so "cannot tell" stays distinct from "wrong
// broker".
func (p *InstrumentProvider) OwnsToken(token int64) (owned, known bool) {
	broker := p.r.ActiveBroker()
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.caches[broker]
	if c == nil || len(c.data) == 0 {
		return false, false
	}
	if c.tokens == nil {
		c.tokens = make(map[int64]struct{}, len(c.data))
		for i := range c.data {
			c.tokens[c.data[i].InstrumentToken] = struct{}{}
		}
	}
	_, ok := c.tokens[token]
	return ok, true
}

// WireInstrument is an instrument row as Node serialised it: a Dhan row carries its
// dhan_security_id, dhan_segment and dhan_underlying_security_id after the shared fields.
type WireInstrument struct {
	market.Instrument
	Dhan *dhan.Instrument
}

// AppendJS implements jsjson.Marshaler.
func (w WireInstrument) AppendJS(dst []byte) []byte {
	if w.Dhan != nil {
		return jsjson.Append(dst, *w.Dhan)
	}
	return jsjson.Append(dst, w.Instrument)
}

// LoadWire is Load returning rows that serialise exactly like the Node rows (Dhan rows
// keep their Dhan identity fields). For routes that send raw instrument rows.
func (p *InstrumentProvider) LoadWire(ctx context.Context, force bool) ([]WireInstrument, error) {
	data, err := p.Load(ctx, force)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	var dhanRows []dhan.Instrument
	for _, c := range p.caches {
		if len(c.data) > 0 && len(data) > 0 && &c.data[0] == &data[0] {
			dhanRows = c.dhanRows
			break
		}
	}
	p.mu.Unlock()
	out := make([]WireInstrument, len(data))
	for i := range data {
		out[i].Instrument = data[i]
		if len(dhanRows) == len(data) {
			row := dhanRows[i]
			out[i].Dhan = &row
		}
	}
	return out, nil
}
