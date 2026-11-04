package spike

import (
	"context"
	"fmt"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

type fakeClock struct{ ms atomic.Int64 }

func (c *fakeClock) Now() time.Time { return time.UnixMilli(c.ms.Load()) }

func testInstruments() []market.Instrument {
	rows := []market.Instrument{}
	for n, symbol := range Symbols {
		center, spacing, lot, exchange := 23850.0, 50.0, 75.0, "NFO"
		if symbol == "SENSEX" {
			center, spacing, lot, exchange = 80000, 100, 20, "BFO"
		}
		for step := -5; step <= 5; step++ {
			for side, kind := range []string{"CE", "PE"} {
				token := int64(2_000_010_000 + n*1000 + (step+5)*2 + side)
				rows = append(rows, market.Instrument{InstrumentToken: token, Name: symbol,
					Tradingsymbol: fmt.Sprintf("%s%d%s", symbol, step+5, kind), Exchange: exchange,
					InstrumentType: kind, Expiry: "2026-11-09", Strike: center + float64(step)*spacing, LotSize: lot})
			}
		}
	}
	return rows
}

func testTicks(rows []market.Instrument, namespace brokers.Namespace, stage int) []market.Tick {
	ticks := []market.Tick{}
	for _, row := range rows {
		center := 23850.0
		if row.Name == "SENSEX" {
			center = 80000
		}
		value, average := 100.0, 100.0
		if row.Strike == center {
			if row.Name == "NIFTY" {
				value, average = 40, 50
				if row.InstrumentType == "CE" {
					value = []float64{60, 64, 66, 64, 68}[stage]
					average = 55
				}
			} else {
				value, average = 60, 55
				if row.InstrumentType == "PE" {
					value = []float64{60, 52, 49, 52, 49}[stage]
				}
			}
		}
		if row.Name == "NIFTY" && row.InstrumentType == "CE" && row.Strike == center+200 {
			value = 20
		}
		if row.Name == "SENSEX" && row.InstrumentType == "PE" && row.Strike == center-400 {
			value = 15
		}
		depth, updated := true, true
		ticks = append(ticks, market.Tick{Token: row.InstrumentToken, LastPrice: value, AveragePrice: &average,
			PriceUpdated: &updated, AverageUpdated: &updated, Namespace: &namespace, DepthUpdated: &depth,
			Bid: value - .5, Ask: value + .5, Bids: []market.DepthLevel{{Price: value - .5, Qty: 1000}},
			Asks: []market.DepthLevel{{Price: value + .5, Qty: 1000}}})
	}
	return ticks
}

func waitOpen(t *testing.T, engine *Engine, count int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for len(engine.Snapshot().Open) != count {
		if time.Now().After(deadline) {
			t.Fatalf("paper entries did not settle: %+v", engine.Snapshot())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestBothIndexesSelectMinimumAndPaperTradeOneLotUntilManualClose(t *testing.T) {
	pool := dbtest.New(t)
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 10, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	rows := testInstruments()
	deps := Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now}
	engine := New(deps)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	engine.OnConnection(true)
	for stage := 0; stage <= 2; stage++ {
		if stage > 0 {
			clock.ms.Add(60_000)
		}
		engine.OnTicks(testTicks(rows, namespace, stage))
	}
	waitOpen(t, engine, 2)
	var nifty, sensex Trade
	for _, trade := range engine.Snapshot().Open {
		if trade.Symbol == "NIFTY" {
			nifty = trade
		} else {
			sensex = trade
		}
	}
	if nifty.Quantity != 75 || nifty.LotSize != 75 || nifty.Direction != "CALL_CREDIT" || nifty.Hedge.Strike-nifty.Short.Strike != 200 ||
		sensex.Quantity != 20 || sensex.Direction != "PUT_CREDIT" || sensex.Short.Strike-sensex.Hedge.Strike != 400 {
		t.Fatalf("one-lot fourth-strike spreads were wrong: %+v %+v", nifty, sensex)
	}
	for stage := 3; stage <= 4; stage++ {
		clock.ms.Add(1000)
		engine.OnTicks(testTicks(rows, namespace, stage))
	}
	if len(engine.Snapshot().Open) != 2 {
		t.Fatal("an already-open primary spread duplicated on another signal")
	}
	clock.ms.Add(1000)
	depth, updated := true, true
	engine.OnTicks([]market.Tick{
		{Token: nifty.Short.Token, LastPrice: 63.5, PriceUpdated: &updated, Namespace: &namespace, DepthUpdated: &depth,
			Bid: 63, Ask: 64, Bids: []market.DepthLevel{{Price: 63, Qty: 1000}}, Asks: []market.DepthLevel{{Price: 64, Qty: 1000}}},
		{Token: nifty.Hedge.Token, LastPrice: 18.5, PriceUpdated: &updated, Namespace: &namespace, DepthUpdated: &depth,
			Bid: 18, Ask: 19, Bids: []market.DepthLevel{{Price: 18, Qty: 1000}}, Asks: []market.DepthLevel{{Price: 19, Qty: 1000}}},
	})
	closed, err := engine.Close(context.Background(), nifty.ID)
	if err != nil || closed.PNL == nil || *closed.PNL != -75 || closed.Status != "closed" {
		t.Fatalf("manual executable exit/P&L: %+v, %v", closed, err)
	}
	if err = engine.SetPaper(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if err = engine.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	clock.ms.Store(time.Date(2026, 11, 4, 11, 0, 0, 0, ist).UnixMilli())
	restarted := New(deps)
	if err = restarted.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restarted.Stop(context.Background()) })
	snapshot := restarted.Snapshot()
	if snapshot.PaperEnabled || len(snapshot.Open) != 1 || snapshot.Open[0].ID != sensex.ID || len(snapshot.Closed) != 1 || len(restarted.Series("NIFTY", 1)) == 0 {
		t.Fatalf("paper control/trades/history did not restore: %+v", snapshot)
	}
}

func TestDataGapsAndWrongNamespaceCannotOpenPaperTrades(t *testing.T) {
	pool := dbtest.New(t)
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	var current atomic.Pointer[brokers.Namespace]
	current.Store(&namespace)
	rows := testInstruments()
	engine := New(Deps{Namespace: func() brokers.Namespace { return *current.Load() }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now})
	_ = engine.Start(context.Background())
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	engine.OnConnection(true)
	engine.OnTicks(testTicks(rows, namespace, 0))
	clock.ms.Add(WindowMs + 1)
	engine.OnTicks(testTicks(rows, namespace, 2))
	if len(engine.Snapshot().Open) != 0 {
		t.Fatal("a 30m gap created a crossover trade")
	}
	engine.Invalidate()
	next := brokers.Namespace{Broker: brokers.Dhan, Generation: 2}
	current.Store(&next)
	engine.OnTicks(testTicks(rows, brokers.Namespace{Broker: brokers.Dhan, Generation: 1}, 2))
	if len(engine.Snapshot().Open) != 0 {
		t.Fatal("old-generation data opened a position")
	}
}

func TestInvalidUpdatedAverageCannotQualifyUsingAnOlderVWAP(t *testing.T) {
	for _, invalid := range []float64{0, math.NaN()} {
		clock := &fakeClock{}
		clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
		namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
		rows := testInstruments()
		engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
			Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Now: clock.Now})
		t.Cleanup(func() { _ = engine.Stop(context.Background()) })
		if err := engine.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		engine.OnConnection(true)
		for stage := 0; stage <= 2; stage++ {
			clock.ms.Add(1000)
			ticks := testTicks(rows, namespace, stage)
			if stage == 2 {
				for i, row := range rows {
					if row.Name == "NIFTY" && row.Strike == 23850 && row.InstrumentType == "CE" {
						ticks[i].AveragePrice = &invalid
					}
				}
			}
			engine.OnTicks(ticks)
		}
		view := engine.Snapshot().Indexes[0]
		if view.Current == nil || view.Current.VWAP != 0 || view.Signal != nil {
			t.Fatalf("invalid new average reused an old VWAP: %+v", view)
		}
		if err := engine.Stop(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUnreadableEntrySizeIsSkippedRatherThanFilledAfterTheCross(t *testing.T) {
	pool := dbtest.New(t)
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	rows := []market.Instrument{}
	for _, row := range testInstruments() {
		if row.Name == "NIFTY" {
			rows = append(rows, row)
		}
	}
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	engine.OnConnection(true)
	for stage := 0; stage <= 2; stage++ {
		clock.ms.Add(1000)
		ticks := testTicks(rows, namespace, stage)
		if stage == 2 {
			for i, row := range rows {
				if row.Strike == 23850 && row.InstrumentType == "CE" {
					ticks[i].Bids[0].Qty = math.NaN()
				}
			}
		}
		engine.OnTicks(ticks)
	}
	engine.mu.Lock()
	queued := len(engine.pending)
	engine.mu.Unlock()
	if queued != 0 || len(engine.Snapshot().Open) != 0 || engine.Snapshot().Indexes[0].Signal == nil {
		t.Fatal("qualified crossover queued a fill without readable one-lot size")
	}
	clock.ms.Add(1000)
	engine.OnTicks(testTicks(rows, namespace, 2))
	engine.mu.Lock()
	queued = len(engine.pending)
	engine.mu.Unlock()
	if queued != 0 || len(engine.Snapshot().Open) != 0 {
		t.Fatal("restored depth created a delayed post-cross entry")
	}
	for _, stage := range []int{1, 2} {
		clock.ms.Add(1000)
		engine.OnTicks(testTicks(rows, namespace, stage))
	}
	waitOpen(t, engine, 1)
}

func TestMalformedClosingDepthLeavesThePaperPositionOpen(t *testing.T) {
	pool := dbtest.New(t)
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	rows := testInstruments()
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	engine.OnConnection(true)
	for stage := 0; stage <= 2; stage++ {
		clock.ms.Add(1000)
		engine.OnTicks(testTicks(rows, namespace, stage))
	}
	waitOpen(t, engine, 2)
	nifty := engine.Snapshot().Open[0]
	for _, tc := range []struct {
		name   string
		mutate func(*market.Tick)
	}{
		{"crossed book", func(tick *market.Tick) { tick.Bid = tick.Ask + 1 }},
		{"missing opposing bid", func(tick *market.Tick) { tick.Bid = 0 }},
		{"nonfinite price", func(tick *market.Tick) { tick.Ask = math.NaN() }},
		{"nonfinite closing size", func(tick *market.Tick) { tick.Asks[0].Qty = math.NaN() }},
		{"insufficient closing size", func(tick *market.Tick) { tick.Asks[0].Qty = 1 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clock.ms.Add(1000)
			ticks := testTicks(rows, namespace, 2)
			for i := range ticks {
				if ticks[i].Token == nifty.Short.Token {
					tc.mutate(&ticks[i])
				}
			}
			engine.OnTicks(ticks)
			if _, err := engine.Close(context.Background(), nifty.ID); err == nil {
				t.Fatal("malformed depth closed the paper spread")
			}
			open := engine.Snapshot().Open
			if len(open) != 2 || !open[0].MarkStale || (open[0].PNL != nil && !finite(*open[0].PNL)) {
				t.Fatalf("bad depth lost the open spread/finite last mark: %+v", open)
			}
		})
	}
	clock.ms.Add(1000)
	engine.OnTicks(testTicks(rows, namespace, 2))
	if _, err := engine.Close(context.Background(), nifty.ID); err != nil {
		t.Fatalf("fresh restored book could not manually close: %v", err)
	}
}

func TestMinuteBoundaryTicksCannotOverwriteTheCompletedPreviousMinute(t *testing.T) {
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 9, 59, 59, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	rows := testInstruments()
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Now: clock.Now})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	engine.OnConnection(true)
	engine.OnTicks(testTicks(rows, namespace, 0))
	clock.ms.Add(1000) // Exactly 10:00:00, the beginning of the next minute.
	engine.OnTicks(testTicks(rows, namespace, 1))
	clock.ms.Add(1000)
	engine.OnTicks(testTicks(rows, namespace, 1))
	points := engine.Series("NIFTY", 1)
	if len(points) != 1 || points[0].Premium != 100 || points[0].T != time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli() {
		t.Fatalf("new-minute tick overwrote the previous close: %+v", points)
	}
	clock.ms.Add(60_000)
	engine.OnTicks(testTicks(rows, namespace, 1))
	points = engine.Series("NIFTY", 1)
	if len(points) != 2 || points[1].Premium != 104 {
		t.Fatalf("next minute did not preserve its own observed close: %+v", points)
	}
}
