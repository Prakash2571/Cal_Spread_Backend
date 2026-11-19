package spike

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
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

// Keep chart fixtures unchanged; entry fixtures qualify/pin on an upward cross
// before entry, with rising NIFTY spot and falling SENSEX spot independently.
func entryTestInstruments() []market.Instrument {
	return append(testInstruments(),
		market.Instrument{InstrumentToken: 13, Name: "NIFTY", Tradingsymbol: "NIFTY", InstrumentType: "INDEX", Exchange: "INDICES", Segment: "INDICES"},
		market.Instrument{InstrumentToken: 51, Name: "SENSEX", Tradingsymbol: "SENSEX", InstrumentType: "INDEX", Exchange: "INDICES", Segment: "INDICES"})
}

func entryTestTicks(rows []market.Instrument, namespace brokers.Namespace, stage int) []market.Tick {
	ticks := testTicks(rows, namespace, 0)
	for i, row := range rows {
		price := ticks[i].LastPrice
		if row.InstrumentType == "INDEX" {
			price = []float64{23850, 23860, 23860, 23850, 23860}[stage]
			if row.Name == "SENSEX" {
				price = []float64{80000, 79990, 79990, 80000, 79990}[stage]
			}
		} else if row.Name == "NIFTY" && row.Strike == 23850 {
			price = 60
			if row.InstrumentType == "PE" {
				price = []float64{40, 46, 44, 46, 44}[stage]
			}
		} else if row.Name == "SENSEX" && row.Strike == 80000 {
			price = 40
			if row.InstrumentType == "CE" {
				price = []float64{60, 66, 64, 66, 64}[stage]
			}
		}
		average := 52.5
		ticks[i].LastPrice, ticks[i].AveragePrice = price, &average
		ticks[i].Bid, ticks[i].Ask = price-.5, price+.5
		ticks[i].Bids[0].Price, ticks[i].Asks[0].Price = price-.5, price+.5
	}
	return ticks
}

// Entry tests start with a completed chart bar and established volume history.
// Chart-construction tests use their own unseeded engine.
func seedEntryChartBars(engine *Engine) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	at := bucketEnd(engine.now(), 1) - 60_000
	for _, symbol := range Symbols {
		engine.bars[symbol][at] = Bar{Symbol: symbol, Day: engine.day, Sample: Sample{T: at, Premium: 105, VWAP: 105}}
		engine.chartVWAP[symbol] = &chartVWAPAccumulator{weighted: 1050, total: 10, marks: map[int64]float64{}}
	}
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
	rows := entryTestInstruments()
	deps := Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now}
	engine := New(deps)
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	seedEntryChartBars(engine)
	engine.OnConnection(true)
	for stage := 0; stage <= 2; stage++ {
		if stage > 0 {
			clock.ms.Add(60_000)
		}
		engine.OnTicks(entryTestTicks(rows, namespace, stage))
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
	if nifty.Quantity != 75 || nifty.LotSize != 75 || nifty.Direction != CallCredit || nifty.Hedge.Strike-nifty.Short.Strike != 200 ||
		!strings.HasSuffix(nifty.Short.Symbol, "CE") || !strings.HasSuffix(nifty.Hedge.Symbol, "CE") ||
		sensex.Quantity != 20 || sensex.Direction != PutCredit || sensex.Short.Strike-sensex.Hedge.Strike != 400 ||
		!strings.HasSuffix(sensex.Short.Symbol, "PE") || !strings.HasSuffix(sensex.Hedge.Symbol, "PE") {
		t.Fatalf("one-lot fourth-strike spreads were wrong: %+v %+v", nifty, sensex)
	}
	for stage := 3; stage <= 4; stage++ {
		clock.ms.Add(1000)
		engine.OnTicks(entryTestTicks(rows, namespace, stage))
	}
	if len(engine.Snapshot().Open) != 2 {
		t.Fatal("an already-open primary spread duplicated on another signal")
	}
	clock.ms.Add(1000)
	depth, updated := true, true
	engine.OnTicks([]market.Tick{
		{Token: nifty.Short.Token, LastPrice: 57.5, PriceUpdated: &updated, Namespace: &namespace, DepthUpdated: &depth,
			Bid: 57, Ask: 58, Bids: []market.DepthLevel{{Price: 57, Qty: 1000}}, Asks: []market.DepthLevel{{Price: 58, Qty: 1000}}},
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
	rows := entryTestInstruments()
	engine := New(Deps{Namespace: func() brokers.Namespace { return *current.Load() }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now})
	_ = engine.Start(context.Background())
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	seedEntryChartBars(engine)
	engine.OnConnection(true)
	engine.OnTicks(entryTestTicks(rows, namespace, 0))
	clock.ms.Add(WindowMs + 1)
	engine.OnTicks(entryTestTicks(rows, namespace, 2))
	if len(engine.Snapshot().Open) != 0 {
		t.Fatal("a 30m gap created a crossover trade")
	}
	engine.Invalidate()
	next := brokers.Namespace{Broker: brokers.Dhan, Generation: 2}
	current.Store(&next)
	engine.OnTicks(entryTestTicks(rows, brokers.Namespace{Broker: brokers.Dhan, Generation: 1}, 2))
	if len(engine.Snapshot().Open) != 0 {
		t.Fatal("old-generation data opened a position")
	}
}

func TestInvalidUpdatedSignalAverageDoesNotBlockChartVWAPTrigger(t *testing.T) {
	for _, invalid := range []float64{0, math.NaN()} {
		clock := &fakeClock{}
		clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
		namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
		rows := entryTestInstruments()
		engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
			Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Now: clock.Now})
		t.Cleanup(func() { _ = engine.Stop(context.Background()) })
		if err := engine.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		seedEntryChartBars(engine)
		engine.OnConnection(true)
		for stage := 0; stage <= 2; stage++ {
			clock.ms.Add(1000)
			ticks := entryTestTicks(rows, namespace, stage)
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
		if view.Current == nil || view.Current.VWAP != 0 || view.Signal == nil || view.Signal.VWAP != 105 {
			t.Fatalf("invalid signal average was reused or blocked the chart cross: %+v", view)
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
	for _, row := range entryTestInstruments() {
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
	seedEntryChartBars(engine)
	engine.OnConnection(true)
	for stage := 0; stage <= 2; stage++ {
		clock.ms.Add(1000)
		ticks := entryTestTicks(rows, namespace, stage)
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
	engine.OnTicks(entryTestTicks(rows, namespace, 2))
	engine.mu.Lock()
	queued = len(engine.pending)
	engine.mu.Unlock()
	if queued != 0 || len(engine.Snapshot().Open) != 0 {
		t.Fatal("restored depth created a delayed post-cross entry")
	}
	for _, stage := range []int{1, 2} {
		clock.ms.Add(1000)
		engine.OnTicks(entryTestTicks(rows, namespace, stage))
	}
	waitOpen(t, engine, 1)
}

func TestMalformedClosingDepthLeavesThePaperPositionOpen(t *testing.T) {
	pool := dbtest.New(t)
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	rows := entryTestInstruments()
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: &Store{Pool: pool}, Now: clock.Now})
	if err := engine.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Stop(context.Background()) })
	seedEntryChartBars(engine)
	engine.OnConnection(true)
	for stage := 0; stage <= 2; stage++ {
		clock.ms.Add(1000)
		engine.OnTicks(entryTestTicks(rows, namespace, stage))
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
			ticks := entryTestTicks(rows, namespace, 2)
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
	engine.OnTicks(entryTestTicks(rows, namespace, 2))
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

func TestMarksTrackPeakGrossPNLAndValuationTime(t *testing.T) {
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true }})
	t.Cleanup(engine.cancel)
	engine.active, engine.connected, engine.namespace = true, true, namespace
	engine.open["NIFTY"] = Trade{ID: "marked", Symbol: "NIFTY", Status: "open", Quantity: 75,
		Short: Leg{Token: 1, Entry: 100}, Hedge: Leg{Token: 2, Entry: 20}}
	start := time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli()
	for i, tc := range []struct {
		name       string
		shortAsk   float64
		pnl        float64
		peak       float64
		peakOffset int64
	}{
		{"first negative mark", 101, -150, -150, 0},
		{"zero becomes peak", 99, 0, 0, 1000},
		{"higher mark", 97, 150, 150, 2000},
		{"lower mark", 98, 75, 150, 2000},
		{"equal mark keeps first time", 97, 150, 150, 2000},
		{"new higher mark", 96, 225, 225, 5000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			at := start + int64(i)*1000
			engine.quotes[1] = quote{Bid: tc.shortAsk - 1, Ask: tc.shortAsk, BidQty: 1000, AskQty: 1000, BookAt: at}
			engine.quotes[2] = quote{Bid: 19, Ask: 20, BidQty: 1000, AskQty: 1000, BookAt: at}
			engine.updateMarksLocked(at)
			trade := engine.Snapshot().Open[0]
			if trade.MarkStale || trade.PNL == nil || *trade.PNL != tc.pnl || trade.MarkAt == nil || *trade.MarkAt != at {
				t.Fatalf("incorrect current valuation: %+v", trade)
			}
			if trade.PeakPNL == nil || *trade.PeakPNL != tc.peak || trade.PeakAt == nil || *trade.PeakAt != start+tc.peakOffset {
				t.Fatalf("incorrect peak for %s: %+v", tc.name, trade)
			}
		})
	}
}

func TestCloseCountsExitValuationAndFreezesStoredPeak(t *testing.T) {
	for _, tc := range []struct {
		name      string
		hadPeak   bool
		priorPeak float64
		shortAsk  float64
		pnl       float64
		peak      float64
		moves     bool
	}{
		{"first valuation at exit", false, 0, 101, -150, -150, true},
		{"exit raises peak", true, 75, 97, 150, 150, true},
		{"lower exit preserves peak", true, 225, 97, 150, 225, false},
		{"equal exit preserves time", true, 150, 97, 150, 150, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &Store{Pool: dbtest.New(t)}
			ctx := context.Background()
			clock := &fakeClock{}
			at := time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli()
			clock.ms.Store(at)
			priorAt := at - 1000
			trade := Trade{ID: "000000000000000000000001", Symbol: "NIFTY", Status: "open", LotSize: 75, Quantity: 75,
				OpenedAt: at - 2000, Short: Leg{Token: 1, Entry: 100}, Hedge: Leg{Token: 2, Entry: 20}}
			if tc.hadPeak {
				trade.PeakPNL, trade.PeakAt = &tc.priorPeak, &priorAt
			}
			if err := store.Insert(ctx, trade); err != nil {
				t.Fatal(err)
			}
			_, open, _, _, err := store.Load(ctx, dayKey(at))
			if err != nil || len(open) != 1 {
				t.Fatalf("load open trade: %+v, %v", open, err)
			}
			namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
			engine := New(Deps{Store: store, Now: clock.Now, Namespace: func() brokers.Namespace { return namespace },
				Ready: func() bool { return true }})
			t.Cleanup(engine.cancel)
			engine.active, engine.connected, engine.namespace = true, true, namespace
			engine.open[trade.Symbol] = open[0]
			// Supply exit depth without marking it first, so Close must count this valuation.
			engine.quotes[1] = quote{Bid: tc.shortAsk - 1, Ask: tc.shortAsk, BidQty: 1000, AskQty: 1000, BookAt: at}
			engine.quotes[2] = quote{Bid: 19, Ask: 20, BidQty: 1000, AskQty: 1000, BookAt: at}
			wantAt := priorAt
			if tc.moves {
				wantAt = at
			}
			assertClosed := func(closed Trade) {
				t.Helper()
				if closed.Status != "closed" || closed.PNL == nil || *closed.PNL != tc.pnl || closed.MarkAt == nil || *closed.MarkAt != at {
					t.Fatalf("incorrect closing valuation: %+v", closed)
				}
				if closed.PeakPNL == nil || *closed.PeakPNL != tc.peak || closed.PeakAt == nil || *closed.PeakAt != wantAt {
					t.Fatalf("incorrect frozen peak: %+v", closed)
				}
			}
			closed, err := engine.Close(ctx, trade.ID)
			if err != nil {
				t.Fatal(err)
			}
			assertClosed(closed)
			clock.ms.Add(1000)
			engine.quotes[1] = quote{Bid: 89, Ask: 90, BidQty: 1000, AskQty: 1000, BookAt: clock.ms.Load()}
			engine.quotes[2] = quote{Bid: 19, Ask: 20, BidQty: 1000, AskQty: 1000, BookAt: clock.ms.Load()}
			engine.updateMarksLocked(clock.ms.Load()) // This would value an open trade at a new high of 675.
			closed, err = engine.Close(ctx, trade.ID)
			if err != nil {
				t.Fatal(err)
			}
			assertClosed(closed)
			snapshot := engine.Snapshot()
			if len(snapshot.Open) != 0 || len(snapshot.Closed) != 1 {
				t.Fatalf("closed trade remained open: %+v", snapshot)
			}
			assertClosed(snapshot.Closed[0])
			_, open, stored, _, err := store.Load(ctx, dayKey(at))
			if err != nil || len(open) != 0 || len(stored) != 1 {
				t.Fatalf("reload closed trade: open=%+v closed=%+v, %v", open, stored, err)
			}
			assertClosed(stored[0])
		})
	}
}

func TestDeletePaperTradeRemovesMemoryAndPersistedRow(t *testing.T) {
	for _, status := range []string{"open", "closed"} {
		t.Run(status, func(t *testing.T) {
			store := &Store{Pool: dbtest.New(t)}
			ctx := context.Background()
			clock := &fakeClock{}
			at := time.Date(2026, 11, 4, 18, 0, 0, 0, ist).UnixMilli()
			clock.ms.Store(at)
			trades := []Trade{
				{ID: "000000000000000000000001", Symbol: "NIFTY", Status: "open", LotSize: 75, Quantity: 75, OpenedAt: at - 3000},
				{ID: "000000000000000000000002", Symbol: "NIFTY", Status: "open", LotSize: 75, Quantity: 75, OpenedAt: at - 2000,
					Short: Leg{Token: 1, Entry: 100}, Hedge: Leg{Token: 2, Entry: 20}, MarkStale: true},
				{ID: "000000000000000000000003", Symbol: "SENSEX", Status: "open", LotSize: 20, Quantity: 20, OpenedAt: at - 1000},
			}
			for i := range trades {
				if err := store.Insert(ctx, trades[i]); err != nil {
					t.Fatal(err)
				}
				if i != 1 || status == "closed" {
					trades[i].Status, trades[i].ClosedAt = "closed", &at
					if err := store.Close(ctx, trades[i]); err != nil {
						t.Fatal(err)
					}
				}
			}
			_, open, closed, _, err := store.Load(ctx, dayKey(at))
			if err != nil {
				t.Fatal(err)
			}
			engine := New(Deps{Store: store, Now: clock.Now})
			t.Cleanup(engine.cancel)
			for _, trade := range open {
				engine.open[trade.Symbol] = trade
			}
			engine.closed = closed
			engine.paper = false
			// Delete must work outside market hours, while disconnected and with stale, undersized depth.
			engine.quotes[1] = quote{Bid: 99, Ask: 100, BidQty: 1, AskQty: 1, BookAt: at - bookAgeMs - 1}
			engine.quotes[2] = quote{Bid: 19, Ask: 20, BidQty: 1, AskQty: 1, BookAt: at - bookAgeMs - 1}
			updates, release := engine.Subscribe()
			defer release()
			<-updates
			deleted, err := engine.Delete(ctx, trades[1].ID)
			if err != nil || !reflect.DeepEqual(deleted, trades[1]) {
				t.Fatalf("delete returned the wrong trade: %+v, %v", deleted, err)
			}
			snapshot := engine.Snapshot()
			if len(snapshot.Open) != 0 || len(snapshot.Closed) != 2 {
				t.Fatalf("deleted trade remained in memory or removed other trades: %+v", snapshot)
			}
			if _, held := engine.open[trades[1].Symbol]; held {
				t.Fatal("deleted trade still occupies its primary spread symbol")
			}
			if snapshot.Closed[0].ID != trades[2].ID || snapshot.Closed[1].ID != trades[0].ID {
				t.Fatalf("delete changed surviving closed trades or their order: %+v", snapshot.Closed)
			}
			select {
			case update := <-updates:
				if !reflect.DeepEqual(update, snapshot) {
					t.Fatalf("delete published the wrong snapshot: %+v", update)
				}
			default:
				t.Fatal("delete did not publish a snapshot")
			}
			_, open, closed, _, err = store.Load(ctx, dayKey(at))
			if err != nil || !reflect.DeepEqual(open, snapshot.Open) || !reflect.DeepEqual(closed, snapshot.Closed) {
				t.Fatalf("deleted trade returned on reload: open=%+v closed=%+v, %v", open, closed, err)
			}
			var count int
			if err := store.Pool.QueryRow(ctx, `select count(*) from spike_trades where id=$1`, deleted.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("deleted database row still exists: count=%d, %v", count, err)
			}
			if err := store.Delete(ctx, deleted.ID); err != nil {
				t.Fatalf("store delete was not idempotent: %v", err)
			}
		})
	}
}

func TestDeleteUnknownPaperTradeChangesNothing(t *testing.T) {
	engine := New(Deps{})
	t.Cleanup(engine.cancel)
	engine.open["NIFTY"] = Trade{ID: "open", Symbol: "NIFTY", Status: "open"}
	engine.closed = []Trade{{ID: "closed", Symbol: "SENSEX", Status: "closed"}}
	before := engine.Snapshot()
	deleted, err := engine.Delete(context.Background(), "unknown")
	if err == nil || err.Error() != "Paper trade is not found" || deleted.ID != "" {
		t.Fatalf("unknown trade delete: %+v, %v", deleted, err)
	}
	if after := engine.Snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("unknown trade delete changed state: before=%+v after=%+v", before, after)
	}
}

func TestDeletePaperTradeWithDisabledStore(t *testing.T) {
	for _, status := range []string{"open", "closed"} {
		for _, tc := range []struct {
			name  string
			store *Store
		}{
			{"nil store", nil},
			{"disabled store", &Store{}},
		} {
			t.Run(status+"/"+tc.name, func(t *testing.T) {
				engine := New(Deps{Store: tc.store})
				t.Cleanup(engine.cancel)
				trade := Trade{ID: "memory-only", Symbol: "NIFTY", Status: status}
				if status == "open" {
					engine.open[trade.Symbol] = trade
				} else {
					engine.closed = []Trade{trade}
				}
				deleted, err := engine.Delete(context.Background(), trade.ID)
				if err != nil || !reflect.DeepEqual(deleted, trade) {
					t.Fatalf("memory-only delete failed: %+v, %v", deleted, err)
				}
				if snapshot := engine.Snapshot(); len(engine.open) != 0 || len(snapshot.Open) != 0 || len(snapshot.Closed) != 0 {
					t.Fatalf("memory-only trade remained after delete: %+v", snapshot)
				}
			})
		}
	}
}

func TestDeleteStoreErrorLeavesPaperTradeForRetry(t *testing.T) {
	for _, status := range []string{"open", "closed"} {
		t.Run(status, func(t *testing.T) {
			store := &Store{Pool: dbtest.New(t)}
			ctx := context.Background()
			clock := &fakeClock{}
			at := time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli()
			clock.ms.Store(at)
			trade := Trade{ID: "000000000000000000000001", Symbol: "NIFTY", Status: "open", LotSize: 75, Quantity: 75, OpenedAt: at}
			if err := store.Insert(ctx, trade); err != nil {
				t.Fatal(err)
			}
			engine := New(Deps{Store: store, Now: clock.Now})
			t.Cleanup(engine.cancel)
			if status == "closed" {
				trade.Status, trade.ClosedAt = status, &at
				if err := store.Close(ctx, trade); err != nil {
					t.Fatal(err)
				}
				engine.closed = []Trade{trade}
			} else {
				engine.open[trade.Symbol] = trade
			}
			before := engine.Snapshot()
			// The isolated test schema lets us make deletion fail without losing the row.
			if _, err := store.Pool.Exec(ctx, `alter table spike_trades rename to spike_trades_unavailable`); err != nil {
				t.Fatal(err)
			}
			if _, err := engine.Delete(ctx, trade.ID); err == nil {
				t.Fatal("database error was not returned")
			}
			if after := engine.Snapshot(); !reflect.DeepEqual(after, before) {
				t.Fatalf("database failure changed memory: before=%+v after=%+v", before, after)
			}
			if _, err := store.Pool.Exec(ctx, `alter table spike_trades_unavailable rename to spike_trades`); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := store.Pool.QueryRow(ctx, `select count(*) from spike_trades where id=$1`, trade.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("failed delete lost the database row: count=%d, %v", count, err)
			}
			if _, err := engine.Delete(ctx, trade.ID); err != nil {
				t.Fatalf("retry failed: %v", err)
			}
			if snapshot := engine.Snapshot(); len(snapshot.Open) != 0 || len(snapshot.Closed) != 0 {
				t.Fatalf("retry left the trade in memory: %+v", snapshot)
			}
		})
	}
}

func TestDeleteStoppedEngineLeavesPaperTrade(t *testing.T) {
	engine := New(Deps{})
	t.Cleanup(engine.cancel)
	engine.open["NIFTY"] = Trade{ID: "open", Symbol: "NIFTY", Status: "open"}
	engine.stopped = true
	before := engine.Snapshot()
	if _, err := engine.Delete(context.Background(), "open"); err == nil || err.Error() != "Spike is stopping" {
		t.Fatalf("stopped engine delete: %v", err)
	}
	if after := engine.Snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("stopped engine delete changed state: before=%+v after=%+v", before, after)
	}
}

func TestTradePeakJSONContract(t *testing.T) {
	var trade Trade
	if err := json.Unmarshal([]byte(`{"id":"legacy","pnl":75,"mark_at":1793766600000}`), &trade); err != nil {
		t.Fatal(err)
	}
	if trade.PeakPNL != nil || trade.PeakAt != nil {
		t.Fatalf("legacy trade acquired a peak without a valuation: %+v", trade)
	}
	for _, withPeak := range []bool{false, true} {
		if withPeak {
			pnl, at := 0.0, int64(1793766601000)
			trade.PeakPNL, trade.PeakAt = &pnl, &at
		}
		raw, err := json.Marshal(trade)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if withPeak {
			if string(fields["peak_pnl"]) != "0" || string(fields["peak_at"]) != "1793766601000" {
				t.Fatalf("peak JSON names or number types were wrong: %s", raw)
			}
		} else if _, ok := fields["peak_pnl"]; ok {
			t.Fatalf("nil peak_pnl was not omitted: %s", raw)
		} else if _, ok := fields["peak_at"]; ok {
			t.Fatalf("nil peak_at was not omitted: %s", raw)
		}
	}
}

func newChartTestEngine(t *testing.T) (*Engine, *fakeClock) {
	t.Helper()
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 10, 0, ist).UnixMilli())
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return testInstruments(), nil }, Now: clock.Now})
	t.Cleanup(engine.cancel)
	// Reconcile synchronously without starting the background timers.
	if err := engine.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	engine.OnConnection(true)
	return engine, clock
}

func finishChartTestMinute(t *testing.T, engine *Engine, clock *fakeClock, stage int, ceVolume, peVolume *float64) Bar {
	t.Helper()
	rows := testInstruments()
	ticks := testTicks(rows, engine.namespace, stage)
	updated := true
	for i, row := range rows {
		ticks[i].VolumeUpdated = &updated
		ticks[i].Volume = ceVolume
		if row.InstrumentType == "PE" {
			ticks[i].Volume = peVolume
		}
	}
	engine.OnTicks(ticks)
	clock.ms.Store(bucketEnd(clock.ms.Load()+1, 1))
	engine.mu.Lock()
	engine.completeBarsLocked(clock.ms.Load(), false)
	engine.mu.Unlock()
	points := engine.Series("NIFTY", 1)
	if len(points) == 0 {
		t.Fatal("minute completion did not produce a chart bar")
	}
	bar := points[len(points)-1]
	if pending := engine.pendingBars[fmt.Sprintf("NIFTY:%s:%d", bar.Day, bar.T)]; !reflect.DeepEqual(pending, bar) {
		t.Fatalf("persisted chart copy differs from the series: %+v, %+v", pending, bar)
	}
	return bar
}

func TestChartVWAPUsesMinutePairVolumeAndSeriesKeepsLastStampedValue(t *testing.T) {
	engine, clock := newChartTestEngine(t)
	weighted := (104.0*10 + 106.0*20) / 30
	for i, tc := range []struct {
		name     string
		stage    int
		ce, pe   float64
		wantVWAP float64
	}{
		{"first readings only establish marks", 0, 100, 200, 0},
		{"first weighted minute", 1, 110, 230, 104},
		{"second weighted minute", 2, 140, 250, weighted},
		{"one leg has zero volume", 3, 160, 250, weighted},
		{"decreasing volume contributes zero", 4, 150, 260, weighted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bar := finishChartTestMinute(t, engine, clock, tc.stage, &tc.ce, &tc.pe)
			if math.Abs(bar.VWAP-tc.wantVWAP) > 1e-9 {
				t.Fatalf("minute %d: chart VWAP=%v, want %v", i, bar.VWAP, tc.wantVWAP)
			}
			// Chart stamping must leave header and signal inputs on Dhan's averages.
			current := engine.views["NIFTY"].Current
			if current == nil || current.VWAP != 105 || engine.previous["NIFTY"].VWAP != 105 {
				t.Fatalf("chart VWAP leaked into live signal samples: %+v", current)
			}
		})
	}
	points := engine.Series("NIFTY", 5)
	last := engine.Series("NIFTY", 1)[4]
	if len(points) != 1 || !reflect.DeepEqual(points[0], last) || math.Abs(points[0].VWAP-weighted) > 1e-9 {
		t.Fatalf("five-minute bucket lost the last stamped cumulative VWAP: %+v", points)
	}
	sensex := engine.Series("SENSEX", 1)
	if len(sensex) != 5 || math.Abs(sensex[4].VWAP-(112.0*10+109.0*20)/30) > 1e-9 {
		t.Fatalf("indexes did not accumulate independently: %+v", sensex)
	}
	// A decreased reading becomes the next mark, so only the recovery's new
	// volume (5), rather than the old higher reading, weights the next minute.
	ce, pe := 155.0, 267.0
	bar := finishChartTestMinute(t, engine, clock, 4, &ce, &pe)
	if want := (104.0*10 + 106.0*20 + 108.0*5) / 35; math.Abs(bar.VWAP-want) > 1e-9 {
		t.Fatalf("decreasing volume did not reset the minute mark: %v, want %v", bar.VWAP, want)
	}
}

func TestChartVWAPWaitsForBothVolumeBaselines(t *testing.T) {
	engine, clock := newChartTestEngine(t)
	ce, pe := 100.0, 200.0
	if bar := finishChartTestMinute(t, engine, clock, 0, &ce, nil); bar.VWAP != 0 {
		t.Fatalf("missing put volume contributed weight: %+v", bar)
	}
	ce = 110
	if bar := finishChartTestMinute(t, engine, clock, 1, &ce, &pe); bar.VWAP != 0 {
		t.Fatalf("first put reading was treated as minute volume: %+v", bar)
	}
	ce, pe = 120, 230
	if bar := finishChartTestMinute(t, engine, clock, 2, &ce, &pe); bar.VWAP != 106 {
		t.Fatalf("paired volume after both baselines did not contribute: %+v", bar)
	}
}

func TestChartVWAPPairSwitchUsesOnlySelectedPairMinuteVolume(t *testing.T) {
	engine, clock := newChartTestEngine(t)
	ce, pe := 100.0, 200.0
	finishChartTestMinute(t, engine, clock, 0, &ce, &pe)
	ce, pe = 110, 230
	finishChartTestMinute(t, engine, clock, 1, &ce, &pe)
	rows := testInstruments()
	ticks := testTicks(rows, engine.namespace, 0)
	updated := true
	for i, row := range rows {
		volume := 1000.0 // Large unrelated volumes must not enter the weight.
		if row.InstrumentType == "PE" {
			volume = 2000
		}
		if row.Name == "NIFTY" && row.Strike == 23900 {
			ticks[i].LastPrice = 45.012
			volume = 115 // CE delta = 5 since the previous completion.
			if row.InstrumentType == "PE" {
				volume = 237 // PE delta = 7; the pair's weight is 5.
			}
		}
		ticks[i].Volume, ticks[i].VolumeUpdated = &volume, &updated
	}
	engine.OnTicks(ticks)
	end := bucketEnd(clock.ms.Load()+1, 1)
	clock.ms.Store(end)
	engine.completeBarsLocked(end, false)
	bar := engine.Series("NIFTY", 1)[2]
	want := (104.0*10 + 90.02*5) / 15
	if bar.Strike != 23900 || bar.Premium != 90.02 || math.Abs(bar.VWAP-want) > 1e-9 {
		t.Fatalf("pair switch used old/multiminute/chain volume or unrounded premium: %+v, want VWAP %v", bar, want)
	}
}

func TestChartVWAPResetsWithTradingDay(t *testing.T) {
	engine, clock := newChartTestEngine(t)
	ce, pe := 100.0, 200.0
	finishChartTestMinute(t, engine, clock, 0, &ce, &pe)
	ce, pe = 110, 230
	if bar := finishChartTestMinute(t, engine, clock, 1, &ce, &pe); bar.VWAP != 104 {
		t.Fatalf("previous day did not accumulate: %+v", bar)
	}
	clock.ms.Store(time.Date(2026, 11, 5, 10, 0, 10, 0, ist).UnixMilli())
	if err := engine.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(engine.chartVWAP) != 0 || len(engine.quotes) != 0 {
		t.Fatal("day reset retained chart accumulators or volume readings")
	}
	ce, pe = 1000, 2000
	if bar := finishChartTestMinute(t, engine, clock, 2, &ce, &pe); bar.VWAP != 0 {
		t.Fatalf("first new-day reading reused yesterday's marks/weight: %+v", bar)
	}
	ce, pe = 1010, 2030
	if bar := finishChartTestMinute(t, engine, clock, 4, &ce, &pe); bar.VWAP != 108 {
		t.Fatalf("new-day VWAP included yesterday's weighted sum: %+v", bar)
	}
}

func TestChartBarUsesLastRoundedMinimumPairAndKeepsIntraminuteExtremes(t *testing.T) {
	engine, clock := newChartTestEngine(t)
	engine.OnTicks(testTicks(testInstruments(), engine.namespace, 0)) // Minimum premium 100.
	clock.ms.Add(1000)
	rows := testInstruments()
	ticks := testTicks(rows, engine.namespace, 0)
	var wantCE, wantPE int64
	for i, row := range rows {
		if row.Name == "NIFTY" {
			ticks[i].LastPrice = 100
			if row.Strike == 23850 || row.Strike == 23900 {
				// Equal minimum pairs: the lower strike must still win.
				ticks[i].LastPrice = 53.004
			}
			if row.Strike == 23850 {
				if row.InstrumentType == "CE" {
					wantCE = row.InstrumentToken
				} else {
					wantPE = row.InstrumentToken
				}
			}
		}
	}
	engine.OnTicks(ticks)
	current := *engine.views["NIFTY"].Current
	if current.Premium != 53.004+53.004 || current.VWAP != 105 {
		t.Fatalf("live sample changed before chart stamping: %+v", current)
	}
	end := bucketEnd(clock.ms.Load()+1, 1)
	clock.ms.Store(end - 1)
	engine.completeBarsLocked(clock.ms.Load(), false)
	if len(engine.bars["NIFTY"]) != 0 || engine.forming["NIFTY"].Premium != current.Premium {
		t.Fatal("forming bar was stamped before minute completion")
	}
	clock.ms.Store(end)
	engine.completeBarsLocked(end, false)
	bar := engine.Series("NIFTY", 1)[0]
	if bar.Premium != 106.01 || bar.Low != 100 || bar.High != current.Premium ||
		bar.LowAt != end-50_000 || bar.HighAt != end-49_000 || bar.Strike != 23850 || bar.CEToken != wantCE || bar.PEToken != wantPE {
		t.Fatalf("bar did not keep its last rounded minimum and raw extremes: %+v", bar)
	}
	if !reflect.DeepEqual(*engine.views["NIFTY"].Current, current) || !reflect.DeepEqual(engine.previous["NIFTY"], current) || bar.VWAP != 0 {
		t.Fatal("chart stamping changed the live sample or reused Dhan's VWAP")
	}
}

func TestVolumeUpdatesRequirePacketProvenanceAndNonnegativeFiniteReading(t *testing.T) {
	engine, _ := newChartTestEngine(t)
	token := testInstruments()[0].InstrumentToken
	yes, no := true, false
	hundred, zero := 100.0, 0.0
	for _, tc := range []struct {
		name    string
		volume  float64
		updated *bool
		want    *float64
	}{
		{"unknown provenance before any reading", 100, nil, nil},
		{"packet without volume before any reading", 100, &no, nil},
		{"negative before any reading", -1, &yes, nil},
		{"explicit volume reading", 100, &yes, &hundred},
		{"packet without volume keeps reading", 200, &no, &hundred},
		{"unknown provenance keeps reading", 200, nil, &hundred},
		{"negative keeps reading", -1, &yes, &hundred},
		{"NaN keeps reading", math.NaN(), &yes, &hundred},
		{"infinite keeps reading", math.Inf(1), &yes, &hundred},
		{"zero is a valid reading", 0, &yes, &zero},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine.OnTicks([]market.Tick{{Token: token, Volume: &tc.volume, VolumeUpdated: tc.updated}})
			if got := engine.quotes[token].Volume; !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("volume=%v, want %v", got, tc.want)
			}
		})
	}
}

// No worker or database: exercise the real tick -> arm -> attribute path while
// keeping entry candidates available for inspection and avoiding timing races.
func newRuleTestEngine(t *testing.T) (*Engine, *fakeClock, []market.Instrument) {
	t.Helper()
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
	rows := entryTestInstruments()
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	var subscribed []int64
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Now: clock.Now,
		SetTokens: func(tokens []int64) { subscribed = append([]int64{}, tokens...) }})
	t.Cleanup(engine.cancel)
	if err := engine.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(subscribed) != len(rows) || !engine.wanted[13] || !engine.wanted[51] || engine.spotTokens[13] != "NIFTY" || engine.spotTokens[51] != "SENSEX" {
		t.Fatalf("spot tokens did not join wanted/SetTokens: %v, %+v", subscribed, engine.spotTokens)
	}
	seedEntryChartBars(engine)
	engine.OnConnection(true)
	return engine, clock, rows
}

func TestSpotTicksAreSeparateAndNonWantedOrWrongNamespaceTicksAreDropped(t *testing.T) {
	engine, clock, rows := newRuleTestEngine(t)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 0))
	before := engine.previous["NIFTY"]
	clock.ms.Add(1000)
	no := false
	wrong := brokers.Namespace{Broker: brokers.Dhan, Generation: 2}
	engine.OnTicks([]market.Tick{
		{Token: 13, LastPrice: 24000, Namespace: &engine.namespace},
		{Token: 13, LastPrice: 25000, PriceUpdated: &no},
		{Token: 51, LastPrice: 1, Namespace: &wrong},
		{Token: 999, LastPrice: 1},
	})
	if !reflect.DeepEqual(before, engine.previous["NIFTY"]) || engine.spots["NIFTY"].atOrBefore(clock.ms.Load()).Price != 24000 || engine.spots["SENSEX"].atOrBefore(clock.ms.Load()).Price != 80000 {
		t.Fatal("spot-only/foreign ticks changed pair evaluation or refreshed spot without provenance")
	}
	for _, token := range []int64{13, 51, 999} {
		if _, exists := engine.quotes[token]; exists {
			t.Fatalf("non-option token %d entered option quotes", token)
		}
	}
}

func TestPinConsumesQualificationForFlatAndUnavailableSpot(t *testing.T) {
	for _, tc := range []struct {
		name, direction, note string
		spot                  float64
		omit                  bool
	}{
		{"up", CallCredit, "PostgreSQL", 23860, false},
		{"down", PutCredit, "PostgreSQL", 23840, false},
		{"flat", "", "underlying was flat", 23850, false},
		{"missing", "", "spot was unavailable", 0, true},
		{"invalid", "", "spot was unavailable", math.NaN(), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine, clock, rows := newRuleTestEngine(t)
			for stage := 0; stage <= 2; stage++ {
				clock.ms.Add(1000)
				ticks := entryTestTicks(rows, engine.namespace, stage)
				filtered := []market.Tick{}
				for _, tick := range ticks {
					if tick.Token == 13 {
						if tc.omit {
							continue
						}
						if stage >= 1 {
							tick.LastPrice = tc.spot
						}
					}
					filtered = append(filtered, tick)
				}
				engine.OnTicks(filtered)
				if stage == 1 && tc.direction != "" && engine.armed["NIFTY"] == nil {
					t.Fatal("+5% did not arm before cross")
				}
				if stage == 1 && tc.direction == "" {
					break
				}
			}
			view := engine.views["NIFTY"]
			if engine.armed["NIFTY"] != nil || !strings.Contains(view.Note, tc.note) {
				t.Fatalf("arm not consumed or wrong note: %+v, %+v", engine.armed, view)
			}
			if tc.direction == "" {
				if view.Signal != nil {
					t.Fatal("flat/unavailable spot produced a direction")
				}
			} else if view.Signal == nil || view.Signal.Direction != tc.direction || view.Signal.VWAP != 105 {
				t.Fatalf("wrong attribution or signal VWAP: %+v", view)
			}
		})
	}
}

// Direction measures spot from the straddle low to the first pin. A later
// reversal before the downward entry cross cannot change that direction.
func TestDirectionUsesSpotAtStraddleLowAndFirstPin(t *testing.T) {
	for _, tc := range []struct {
		name      string
		spots     [3]float64 // straddle low, upward pin, downward entry
		direction string
	}{
		{"rally eases back before cross", [3]float64{23850, 23900, 23880}, CallCredit},
		{"sell-off bounces before cross", [3]float64{23850, 23800, 23820}, PutCredit},
		{"first pin wins when spot returns to low", [3]float64{23850, 23900, 23850}, CallCredit},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine, clock, rows := newRuleTestEngine(t)
			for stage := 0; stage <= 2; stage++ {
				clock.ms.Add(1000)
				ticks := entryTestTicks(rows, engine.namespace, stage)
				for i := range ticks {
					if ticks[i].Token == 13 {
						ticks[i].LastPrice = tc.spots[stage]
					}
				}
				engine.OnTicks(ticks)
				if stage == 1 {
					state := engine.armed["NIFTY"]
					if state == nil || state.Baseline.Price != tc.spots[0] || state.Baseline.T > state.Reference.T {
						t.Fatalf("baseline not pinned at the straddle low: %+v", state)
					}
				}
			}
			view := engine.views["NIFTY"]
			if view.Signal == nil || view.Signal.Direction != tc.direction {
				t.Fatalf("direction=%+v, want %s", view.Signal, tc.direction)
			}
		})
	}
}

func TestSpotHistoryBaselineIsAtOrBeforeReferenceAndPinnedBaselineSurvivesPruning(t *testing.T) {
	const now = int64(10_000_000)
	h := spotHistory{}
	h.add(spotSample{T: now - spotHistoryMs - 1, Price: 90})
	h.add(spotSample{T: now - 1000, Price: 100})
	h.add(spotSample{T: now + 1, Price: 101})
	if len(h) != 2 || h.atOrBefore(now).Price != 100 || h.atOrBefore(now-2000).T != 0 {
		t.Fatalf("wrong baseline or unpruned old sample: %+v", h)
	}
	h.add(spotSample{T: now + 1, Price: 102})
	if len(h) != 2 || h.atOrBefore(now+1).Price != 102 {
		t.Fatal("same-millisecond latest spot did not win")
	}
	engine, clock, rows := newRuleTestEngine(t)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 0))
	clock.ms.Add(1000)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 1))
	state := engine.armed["NIFTY"]
	if state == nil || state.Baseline.Price != 23850 || state.Baseline.T > state.Reference.T {
		t.Fatalf("baseline was not captured from the low at the pin: %+v", state)
	}
	history := engine.spots["NIFTY"]
	history.add(spotSample{T: state.ArmedAt + spotHistoryMs + 1, Price: 24000})
	if history.atOrBefore(state.ArmedAt).T != 0 || state.Baseline.Price != 23850 {
		t.Fatal("pruning history lost a live arm's baseline")
	}
}

func TestContinuityResetsPreserveDayLatchButClearSpotAndPrevious(t *testing.T) {
	for _, reset := range []string{"disconnect", "invalidate", "runtime ready", "day"} {
		for _, pinned := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/pinned_%v", reset, pinned), func(t *testing.T) {
				engine, clock, rows := newRuleTestEngine(t)
				engine.OnTicks(entryTestTicks(rows, engine.namespace, 0))
				clock.ms.Add(1000)
				engine.OnTicks(entryTestTicks(rows, engine.namespace, 1))
				if len(engine.armed) != 2 {
					t.Fatal("both independent symbols should be qualified")
				}
				if !pinned {
					for _, state := range engine.armed {
						state.PinnedAt, state.Direction, state.Baseline = 0, "", spotSample{}
					}
				}
				original := *engine.armed["NIFTY"]
				switch reset {
				case "disconnect":
					engine.OnConnection(false)
				case "invalidate":
					engine.Invalidate()
				case "runtime ready":
					engine.OnRuntimeReady()
				case "day":
					clock.ms.Add(24 * 60 * 60_000)
					if err := engine.reconcile(context.Background()); err != nil {
						t.Fatal(err)
					}
				}
				if len(engine.spots) != 0 || len(engine.previous) != 0 {
					t.Fatal("continuity reset retained spot history or crossover samples")
				}
				if reset == "day" {
					if len(engine.armed) != 0 {
						t.Fatal("day reset retained qualification/pin")
					}
				} else if state := engine.armed["NIFTY"]; state == nil || *state != original {
					t.Fatal("same-day continuity reset expired qualification/pin")
				}
			})
		}
	}
}

func TestOpenOrPendingSpreadPreventsArmingAnotherForThatSymbol(t *testing.T) {
	for _, pending := range []bool{false, true} {
		engine, clock, rows := newRuleTestEngine(t)
		engine.OnTicks(entryTestTicks(rows, engine.namespace, 0))
		if pending {
			engine.pending["NIFTY"] = "pending"
		} else {
			engine.open["NIFTY"] = Trade{ID: "existing", Symbol: "NIFTY"}
		}
		clock.ms.Add(1000)
		engine.OnTicks(entryTestTicks(rows, engine.namespace, 1))
		if engine.armed["NIFTY"] != nil || engine.armed["SENSEX"] == nil {
			t.Fatal("one-open gate leaked across symbols or allowed another arm")
		}
		clock.ms.Add(1000)
		engine.OnTicks(entryTestTicks(rows, engine.namespace, 2))
		if engine.views["NIFTY"].Signal != nil || len(engine.candidates) != 0 {
			t.Fatal("open/pending symbol evaluated another entry")
		}
	}
}

func TestCreditSpreadEntryStillRequiresNetCreditAndExecutableDepth(t *testing.T) {
	engine := New(Deps{})
	t.Cleanup(engine.cancel)
	u := buildUniverses(testInstruments(), "2026-11-04")["NIFTY"]
	const now = int64(10_000_000)
	for _, direction := range []string{CallCredit, PutCredit} {
		short, hedge, ok := creditSpreadLegs(u, u.Pairs[5], direction)
		if !ok {
			t.Fatal("missing fixture hedge")
		}
		for _, tc := range []struct {
			name          string
			bid, hedgeAsk float64
			quantity      float64
			bookAt        int64
			want          bool
		}{
			{"credit", 50, 20, 75, now, true},
			{"zero credit retains existing gate", 20, 20, 75, now, true},
			{"debit rejected", 19, 20, 75, now, false},
			{"insufficient depth", 50, 20, 74, now, false},
			{"stale depth", 50, 20, 75, now - bookAgeMs - 1, false},
		} {
			t.Run(direction+"/"+tc.name, func(t *testing.T) {
				engine.quotes[short.InstrumentToken] = quote{Bid: tc.bid, Ask: tc.bid + 1, BidQty: tc.quantity, AskQty: 75, BookAt: tc.bookAt}
				engine.quotes[hedge.InstrumentToken] = quote{Bid: tc.hedgeAsk - 1, Ask: tc.hedgeAsk, BidQty: 75, AskQty: tc.quantity, BookAt: tc.bookAt}
				trade, err := engine.tradeAtCrossLocked("NIFTY", short, hedge, Signal{Direction: direction}, now)
				if (err == nil) != tc.want {
					t.Fatalf("trade=%+v err=%v, want success=%v", trade, err, tc.want)
				}
				if tc.want && (trade.Short.Entry != tc.bid || trade.Hedge.Entry != tc.hedgeAsk || trade.EntryCredit != 75*(tc.bid-tc.hedgeAsk) || trade.Direction != direction) {
					t.Fatalf("entry touch pricing changed: %+v", trade)
				}
			})
		}
	}
}

func TestUnchangedFiveMinuteReconcilePreservesPinSpotAndNote(t *testing.T) {
	engine, clock, rows := newRuleTestEngine(t)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 0))
	clock.ms.Add(1000)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 1))
	state := engine.armed["NIFTY"]
	if state == nil || !strings.HasPrefix(engine.views["NIFTY"].Note, "Direction pinned SHORT") {
		t.Fatal("fixture did not arm")
	}
	original := *state
	clock.ms.Add(5 * 60_000)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 1))
	history := append(spotHistory{}, engine.spots["NIFTY"]...)
	previous, note := engine.previous["NIFTY"], engine.views["NIFTY"].Note
	if err := engine.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if engine.armed["NIFTY"] != state || *state != original || !reflect.DeepEqual(engine.spots["NIFTY"], history) || engine.previous["NIFTY"] != previous {
		t.Fatal("unchanged refresh reset arm, baseline, spot history or crossover continuity")
	}
	if engine.views["NIFTY"].Note != note || engine.Snapshot().Indexes[0].Note != note {
		t.Fatalf("refresh published a false disarm: %q", engine.views["NIFTY"].Note)
	}
	// A fresh update after the refresh preserves the pin; the next entry cross
	// uses its stored direction and reference, independent of instrument refresh.
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 1))
	if engine.armed["NIFTY"] != state || *state != original || engine.Snapshot().Indexes[0].Note != note {
		t.Fatal("first post-refresh tick changed the latch or its note")
	}
	clock.ms.Add(1000)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 2))
	if engine.armed["NIFTY"] != nil || engine.views["NIFTY"].Signal == nil || engine.views["NIFTY"].Signal.Direction != CallCredit {
		t.Fatal("refresh prevented the subsequent cross from consuming the original arm")
	}
}

func TestNoChartBarAllowsQualificationButFailsClosedForPinAndEntry(t *testing.T) {
	for _, alreadyQualified := range []bool{false, true} {
		engine, clock, rows := newRuleTestEngine(t)
		engine.bars["NIFTY"] = map[int64]Bar{}
		var state *armedState
		if alreadyQualified {
			state = &armedState{ArmedAt: clock.ms.Load(), Reference: Sample{T: clock.ms.Load() - 1000, Premium: 100}}
			engine.armed["NIFTY"] = state
		}
		for stage := 0; stage <= 2; stage++ {
			clock.ms.Add(1000)
			engine.OnTicks(entryTestTicks(rows, engine.namespace, stage))
		}
		view := engine.Snapshot().Indexes[0]
		next := engine.armed["NIFTY"]
		if next == nil || next.PinnedAt != 0 || (state != nil && next != state) || view.Signal != nil || view.ChartVWAP != nil || !strings.Contains(view.Note, "Waiting for first completed chart bar") {
			t.Fatalf("missing chart bar prevented qualification, pinned, triggered or lost a latch: %+v, %+v", next, view)
		}
		if view.Current == nil || view.Current.VWAP != 105 {
			t.Fatal("missing chart VWAP changed the displayed signal VWAP")
		}
	}
}

func TestChartVWAPAccessorUsesLatestCompletedStampAndSnapshotOmitsUnavailable(t *testing.T) {
	engine, clock := newChartTestEngine(t)
	now := clock.ms.Load()
	engine.chartVWAP["NIFTY"] = &chartVWAPAccumulator{weighted: 9990, total: 10}
	engine.bars["NIFTY"][now-60_000] = Bar{Day: engine.day, Sample: Sample{T: now - 60_000, VWAP: 100}}
	engine.bars["NIFTY"][now] = Bar{Day: engine.day, Sample: Sample{T: now, VWAP: 105}}
	engine.bars["NIFTY"][now+60_000] = Bar{Day: engine.day, Sample: Sample{T: now + 60_000, VWAP: 110}}
	engine.bars["NIFTY"][now-1] = Bar{Day: "2026-11-03", Sample: Sample{T: now - 1, VWAP: 999}}
	if engine.chartVWAPAtLocked("NIFTY", now-1) != 100 || engine.chartVWAPAtLocked("NIFTY", now) != 105 || engine.chartVWAPAtLocked("NIFTY", now-60_001) != 0 {
		t.Fatal("chart line used a future/wrong-day bar, accumulator or wrong timestamp")
	}
	view := engine.Snapshot().Indexes[0]
	if view.ChartVWAP == nil || *view.ChartVWAP != 105 {
		t.Fatalf("snapshot did not expose the stamped chart line: %+v", view)
	}
	raw, err := json.Marshal(view)
	if err != nil || !strings.Contains(string(raw), `"chart_vwap":105`) {
		t.Fatalf("wrong chart VWAP JSON: %s, %v", raw, err)
	}
	for _, invalid := range []float64{0, math.NaN(), math.Inf(1)} {
		engine.bars["NIFTY"][now] = Bar{Day: engine.day, Sample: Sample{T: now, VWAP: invalid}}
		view = engine.Snapshot().Indexes[0]
		raw, err = json.Marshal(view)
		if err != nil || view.ChartVWAP != nil || strings.Contains(string(raw), `"chart_vwap"`) || engine.chartVWAPAtLocked("NIFTY", now) != 0 {
			t.Fatalf("invalid latest stamp reused an older line or leaked into JSON: %s, %v", raw, err)
		}
	}
}

func TestTriggerUsesEachSamplesChartLineAcrossMinuteStep(t *testing.T) {
	engine, clock, rows := newRuleTestEngine(t)
	clock.ms.Add(59_000)
	now := clock.ms.Load()
	engine.bars["NIFTY"][now-59_000] = Bar{Day: engine.day, Sample: Sample{T: now - 59_000, VWAP: 106}}
	engine.chartVWAP["NIFTY"] = &chartVWAPAccumulator{weighted: 1040, total: 10, marks: map[int64]float64{}}
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 2)) // 104 is outside the old 106 touch band.
	state := &armedState{ArmedAt: now - 1000, Reference: Sample{T: now, Premium: 100}, Baseline: spotSample{T: now, Price: 23850}, PinnedAt: now - 1000, Direction: CallCredit}
	engine.armed["NIFTY"] = state
	clock.ms.Add(1000)
	ticks := entryTestTicks(rows, engine.namespace, 2)
	for i, row := range rows {
		if row.Name == "NIFTY" && row.Strike == 23850 && row.InstrumentType == "PE" {
			ticks[i].LastPrice = 43 // 103, below the new completed chart line of 104.
		}
	}
	engine.OnTicks(ticks)
	if engine.chartVWAPAtLocked("NIFTY", clock.ms.Load()) != 104 || engine.armed["NIFTY"] != state || engine.views["NIFTY"].Signal != nil {
		t.Fatal("minute step retroactively applied the new chart line to the previous sample")
	}
	clock.ms.Add(1000)
	engine.OnTicks(entryTestTicks(rows, engine.namespace, 2)) // Return to the new line (104).
	clock.ms.Add(1000)
	engine.OnTicks(ticks) // Then fall to 103.
	if engine.armed["NIFTY"] != nil || engine.views["NIFTY"].Signal == nil || engine.views["NIFTY"].Signal.VWAP != 104 || engine.views["NIFTY"].Current.VWAP != 105 {
		t.Fatal("chart cross failed or recorded the signal VWAP instead of the chart line")
	}
}

func TestReconcileReloadsStampedChartVWAPWithoutAccumulator(t *testing.T) {
	store := &Store{Pool: dbtest.New(t)}
	ctx := context.Background()
	clock := &fakeClock{}
	clock.ms.Store(time.Date(2026, 11, 4, 10, 0, 0, 0, ist).UnixMilli())
	at := clock.ms.Load() - 60_000
	bar := Bar{Symbol: "NIFTY", Day: dayKey(at), Sample: Sample{T: at, Premium: 100, VWAP: 105}, Low: 100, LowAt: at, High: 100, HighAt: at}
	if err := store.SaveBars(ctx, []Bar{bar}); err != nil {
		t.Fatal(err)
	}
	namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
	rows := entryTestInstruments()
	engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
		Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Store: store, Now: clock.Now})
	t.Cleanup(engine.cancel)
	if engine.Snapshot().Indexes[0].ChartVWAP != nil {
		t.Fatal("restart invented a chart line before reload")
	}
	if err := engine.reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	view := engine.Snapshot().Indexes[0]
	if view.ChartVWAP == nil || *view.ChartVWAP != 105 || len(engine.chartVWAP) != 0 || !reflect.DeepEqual(engine.Series("NIFTY", 1), []Bar{bar}) {
		t.Fatal("reload did not restore the persisted chart stamp independently of the accumulator")
	}
	engine.OnConnection(true)
	engine.spots["NIFTY"] = spotHistory{{T: at, Price: 23850}}
	engine.OnTicks(entryTestTicks(rows, namespace, 1))
	if state := engine.armed["NIFTY"]; state == nil || state.Reference.T != at || engine.views["NIFTY"].Signal != nil {
		t.Fatal("restored chart/reference did not allow fresh arming without replaying a trigger")
	}
}

// Worked check from the supplied 19 November observations, with explicit
// intermediate samples to make consecutive-sample pin/entry timing testable.
// This is a deterministic fixture, not a replay of a complete historical feed.
func TestNineteenNovemberSensexDirectionPin(t *testing.T) {
	at := func(hour, minute, second int) int64 {
		return time.Date(2026, 11, 19, hour, minute, second, 0, ist).UnixMilli()
	}
	for _, entrySpot := range []float64{82140, 82165} {
		t.Run(fmt.Sprintf("spot_%.0f", entrySpot), func(t *testing.T) {
			clock := &fakeClock{}
			clock.ms.Store(at(9, 37, 0))
			rows := entryTestInstruments()
			for i := range rows {
				if rows[i].InstrumentType == "INDEX" {
					continue
				}
				rows[i].Expiry = "2026-11-23"
				if rows[i].Name == "SENSEX" {
					rows[i].Strike += 2100
				}
			}
			namespace := brokers.Namespace{Broker: brokers.Dhan, Generation: 1}
			engine := New(Deps{Namespace: func() brokers.Namespace { return namespace }, Ready: func() bool { return true },
				Instruments: func(context.Context) ([]market.Instrument, error) { return rows, nil }, Now: clock.Now})
			t.Cleanup(engine.cancel)
			if err := engine.reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			engine.OnConnection(true)
			// Use a persisted/completed chart stamp. The deliberately different
			// Dhan average must never become the trigger line.
			for _, symbol := range Symbols {
				line := 410.4
				if symbol == "NIFTY" {
					line = 183
				}
				engine.bars[symbol][at(9, 37, 0)] = Bar{Symbol: symbol, Day: engine.day, Sample: Sample{T: at(9, 37, 0), VWAP: line}}
				engine.chartVWAP[symbol] = &chartVWAPAccumulator{weighted: line * 10, total: 10, marks: map[int64]float64{}}
			}
			tick := func(when int64, sensexPremium, spot, niftyPremium float64) {
				clock.ms.Store(when)
				ticks := []market.Tick{}
				for _, row := range rows {
					price := 1000.0
					if row.InstrumentType == "INDEX" {
						price = 23850
						if row.Name == "SENSEX" {
							price = spot
						}
					} else if row.Name == "SENSEX" {
						if row.Strike == 82100 {
							price = sensexPremium / 2
						} else if row.InstrumentType == "CE" {
							price = 180 - (row.Strike-82100)/10
						}
					} else if row.Strike == 23850 {
						price = niftyPremium / 2
					}
					average, updated := 230.0, true
					ticks = append(ticks, market.Tick{Token: row.InstrumentToken, LastPrice: price, AveragePrice: &average,
						PriceUpdated: &updated, AverageUpdated: &updated, DepthUpdated: &updated, Namespace: &namespace,
						Bid: price - .5, Ask: price + .5, Bids: []market.DepthLevel{{Price: price - .5, Qty: 1000}},
						Asks: []market.DepthLevel{{Price: price + .5, Qty: 1000}}})
				}
				engine.OnTicks(ticks)
			}
			tick(at(9, 37, 51), 393.15, 81955, 180)
			// An unqualified upward cross cannot pin. The next tick qualifies
			// above the line without a new cross or touch.
			tick(at(9, 38, 32), 412.50, 82000, 182)
			tick(at(9, 38, 33), 422.05, 82005, 184)
			qualified := engine.armed["SENSEX"]
			if qualified == nil || qualified.ArmedAt != at(9, 38, 33) || qualified.PinnedAt != 0 || qualified.Reference.T != at(9, 37, 51) || math.Abs((422.05/393.15-1)*100-7.3508838866) > 1e-6 {
				t.Fatalf("wrong +5%% qualification at 09:38:33: %+v", qualified)
			}
			qualifiedCopy := *qualified
			tick(at(9, 52, 0), 421.55, 82165, 182)
			tick(at(9, 53, 34), 413.0, 82165, 184)
			tick(at(9, 53, 35), 410.45, 82165, 183.5)
			pinned := engine.armed["SENSEX"]
			if pinned == nil || pinned.Direction != CallCredit || pinned.PinnedAt != at(9, 53, 35) || pinned.Baseline.Price != 81955 || engine.views["SENSEX"].Signal != nil || !strings.Contains(engine.views["SENSEX"].Note, "Direction pinned SHORT") {
				t.Fatalf("09:53:35 touch failed to pin SHORT without entry: %+v", pinned)
			}
			pinnedCopy := *pinned
			tick(at(9, 53, 39), 412.50, 82165, 184)
			tick(at(9, 53, 40), 408.90, entrySpot, 181)
			view := engine.views["SENSEX"]
			if view.Signal == nil || view.Signal.T != at(9, 53, 40) || view.Signal.Direction != CallCredit || math.Abs(view.Signal.VWAP-410.4) > 1e-9 || view.Signal.ReferenceAt != at(9, 37, 51) || view.Signal.MovePct >= MinimumMovePct || engine.armed["SENSEX"] != nil {
				t.Fatalf("wrong worked-check entry time/direction/line: %+v", view)
			}
			// PostgreSQL is deliberately absent. Exercise the same ATM, hedge
			// and executable-depth path synchronously using the emitted signal.
			u := engine.universes["SENSEX"]
			atm, ok := atmPair(u, entrySpot)
			if !ok {
				t.Fatal("worked-check chain has no spot ATM")
			}
			short, hedge, ok := creditSpreadLegs(u, atm, view.Signal.Direction)
			if !ok || short.Strike != atm.CE.Strike || short.InstrumentType != "CE" || hedge.InstrumentType != "CE" || hedge.Strike-short.Strike != 400 {
				t.Fatalf("wrong ATM-sold/fourth-higher-CE leg shape: %+v, %+v", short, hedge)
			}
			trade, err := engine.tradeAtCrossLocked("SENSEX", short, hedge, *view.Signal, at(9, 53, 40))
			if err != nil || trade.OpenedAt != at(9, 53, 40) || trade.Direction != CallCredit || trade.Quantity != int(short.LotSize) || trade.Short.Token != atm.CE.InstrumentToken || trade.Hedge.Token != hedge.InstrumentToken {
				t.Fatalf("worked-check one-lot paper fill failed: %+v, %v", trade, err)
			}
			if engine.armed["NIFTY"] != nil || engine.views["NIFTY"].Signal != nil || len(engine.candidates) != 0 {
				t.Fatal("unqualified NIFTY chart crosses produced a false entry")
			}
			// Separate no-entry continuations prove BOTH a qualification and a
			// pin survive 10:07:52; the actual sequence already entered at 09:53:40.
			later := Sample{T: at(10, 7, 52), Premium: 414.20, VWAP: 460}
			newLow := Sample{T: at(9, 53, 40), Premium: 408.90}
			for _, original := range []armedState{qualifiedCopy, pinnedCopy} {
				latched := original
				next, trigger, _ := advanceArmed(&latched, Sample{}, later, []Sample{newLow}, 0, 410.4, nil)
				if next == nil || next.ArmedAt != at(9, 38, 33) || next.PinnedAt != original.PinnedAt || next.Direction != original.Direction || trigger != nil {
					t.Fatal("10:07:52 expired qualification or direction pin")
				}
				if original.PinnedAt == 0 && next.Reference != newLow {
					t.Fatal("un-pinned reference stopped sliding after old low expired")
				}
				if original.PinnedAt != 0 && *next != original {
					t.Fatal("pinned reference or baseline changed after expiry")
				}
			}
		})
	}
}
