package spike

import (
	"context"
	"fmt"
	"sort"
	"time"
)

func (e *Engine) SetPaper(ctx context.Context, enabled bool) error {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	e.mu.Lock()
	stopped := e.stopped
	e.mu.Unlock()
	if stopped {
		return fmt.Errorf("Spike is stopping")
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := e.d.Store.SetPaper(ctx, enabled); err != nil {
		return err
	}
	e.mu.Lock()
	e.paper = enabled
	e.publishLocked()
	e.mu.Unlock()
	return nil
}

func (e *Engine) Close(ctx context.Context, id string) (Trade, error) {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	e.mu.Lock()
	if e.stopped {
		e.mu.Unlock()
		return Trade{}, fmt.Errorf("Spike is stopping")
	}
	var trade Trade
	for _, open := range e.open {
		if open.ID == id {
			trade = open
			break
		}
	}
	if trade.ID == "" {
		for _, closed := range e.closed {
			if closed.ID == id {
				e.mu.Unlock()
				return closed, nil
			}
		}
		e.mu.Unlock()
		return Trade{}, fmt.Errorf("Paper trade is not open")
	}
	now := e.now()
	a, b := e.quotes[trade.Short.Token], e.quotes[trade.Hedge.Token]
	if !e.active || !e.connected || !e.dataReady() || e.namespace != e.namespaceNow() || !a.freshBook(now) || !b.freshBook(now) ||
		a.AskQty < float64(trade.Quantity) || b.BidQty < float64(trade.Quantity) {
		e.mu.Unlock()
		return Trade{}, fmt.Errorf("Fresh one-lot closing depth is unavailable; paper trade remains open")
	}
	short, hedge, pnl := a.Ask, b.Bid, grossPNL(trade, a.Ask, b.Bid)
	trade.Status, trade.ClosedAt, trade.Short.Exit, trade.Hedge.Exit = "closed", &now, &short, &hedge
	trade.MarkShort, trade.MarkHedge, trade.MarkAt, trade.PNL, trade.MarkStale = &short, &hedge, &now, &pnl, false
	e.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := e.d.Store.Close(ctx, trade); err != nil {
		return Trade{}, err
	}
	e.mu.Lock()
	delete(e.open, trade.Symbol)
	e.closed = append([]Trade{trade}, e.closed...)
	e.publishLocked()
	e.mu.Unlock()
	return trade, nil
}

func (e *Engine) snapshotLocked() Snapshot {
	result := Snapshot{Mode: "PAPER_ONLY", Day: e.day, Active: e.active, Connected: e.connected, Database: e.dbEnabled(), PaperEnabled: e.paper,
		WantedTokens: len(e.wanted), WindowMinutes: 30, MovePct: MinimumMovePct, HedgeSteps: HedgeSteps, VWAPMethod: "Dhan CE average traded price + PE average traded price",
		Indexes: []IndexView{}, Open: []Trade{}, Closed: append([]Trade{}, e.closed...), Error: e.lastError}
	for _, symbol := range Symbols {
		view := e.views[symbol]
		if view.Current != nil && e.now()-view.Current.T > quoteAgeMs {
			view.Note = "Paired price stream is stale"
		}
		result.Indexes = append(result.Indexes, view)
		if trade, ok := e.open[symbol]; ok {
			result.Open = append(result.Open, trade)
		}
	}
	return result
}

func (e *Engine) Snapshot() Snapshot { e.mu.Lock(); defer e.mu.Unlock(); return e.snapshotLocked() }
func (e *Engine) publishLocked() {
	if len(e.watchers) == 0 {
		return
	}
	value := e.snapshotLocked()
	for _, ch := range e.watchers {
		select {
		case ch <- value:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- value:
			default:
			}
		}
	}
}

func (e *Engine) Subscribe() (<-chan Snapshot, func()) {
	e.mu.Lock()
	e.watchSeq++
	id := e.watchSeq
	ch := make(chan Snapshot, 1)
	if e.stopped {
		close(ch)
	} else {
		e.watchers[id] = ch
		ch <- e.snapshotLocked()
	}
	e.mu.Unlock()
	return ch, func() {
		e.mu.Lock()
		if existing, ok := e.watchers[id]; ok {
			delete(e.watchers, id)
			close(existing)
		}
		e.mu.Unlock()
	}
}

func (e *Engine) Series(symbol string, minutes int64) []Bar {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	by := map[int64]Bar{}
	points := make([]Bar, 0, len(e.bars[symbol]))
	for _, point := range e.bars[symbol] {
		points = append(points, point)
	}
	sort.Slice(points, func(i, j int) bool { return points[i].T < points[j].T })
	for _, point := range points {
		end := bucketEnd(point.T, minutes)
		if end > now || point.Day != e.day {
			continue
		}
		point.T = end
		by[end] = point
	}
	out := make([]Bar, 0, len(by))
	for _, point := range by {
		out = append(out, point)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}
