package app

import (
	"context"
	"strconv"
	"sync"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/analytics"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/registry"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/calendar"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/captures"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/core"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue"
	fvjson "github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/marketdata"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/synthetic"
)

// The small type adapters between packages that index.ts got for free from sharing
// plain objects.

// coreHealth is brokerManager.activeHealth() as the root routes read it.
func (a *App) coreHealth() core.Health {
	h := a.reg.ActiveHealth()
	return core.Health{Authenticated: h.Authenticated, DataReady: h.DataReady, TradingReady: h.TradingReady, Problems: h.Problems}
}

// dataHealth is activeHealth().data_ready and .problems for the market-data routes.
func (a *App) dataHealth() (bool, []string) {
	h := a.reg.ActiveHealth()
	return h.DataReady, h.Problems
}

// analyticsReadiness feeds the option-chain 401 (requireMarketData). Broker comes from
// the same health read, as index.ts's synchronous function saw one state.
func (a *App) analyticsReadiness() analytics.Readiness {
	h := a.reg.ActiveHealth()
	return analytics.Readiness{Ready: h.DataReady, Broker: h.Broker, Problems: h.Problems}
}

// calendarMarketData is requireMarketData(res, what) for the calendar trade routes.
func (a *App) calendarMarketData(what string) (bool, calendar.MarketDataRefusal) {
	h := a.reg.ActiveHealth()
	if h.DataReady {
		return true, calendar.MarketDataRefusal{}
	}
	return false, calendar.NewMarketDataRefusal(what, string(h.Broker), h.Problems)
}

// upstreamStats converts the registry's upstreamFeedStats() (same fields, same order).
func (a *App) upstreamStats() marketdata.UpstreamStats {
	return marketdata.UpstreamStats(a.reg.UpstreamFeedStats())
}

// boardSize is the diagnostics' deriveFnoBoard(await getAllInstrumentsCached()).length.
func (a *App) boardSize(ctx context.Context) (int, error) {
	board, err := a.core.Board(ctx)
	if err != nil {
		return 0, err
	}
	return len(board), nil
}

// loadInstruments is getAllInstrumentsCached: the active broker's cached universe.
func (a *App) loadInstruments(ctx context.Context) ([]market.Instrument, error) {
	return a.reg.InstrumentProvider().Load(ctx, false)
}

// dividendYields and spreadSummary are yahoo.ts getDividendYields and the
// spread_summary lookup, which live with the captures.
func (a *App) dividendYields(ctx context.Context, symbols []string) map[string]float64 {
	return a.captures.DividendYields(ctx, symbols)
}

func (a *App) spreadSummary(ctx context.Context, symbol string) (*captures.SpreadSummary, error) {
	return a.captures.SpreadSummary(ctx, symbol)
}

// wireRows is the active universe as rows that serialise like Node's (Dhan rows keep
// their dhan_* fields) for /api/instruments and /api/fno-stocks.
func (a *App) wireRows(ctx context.Context) ([]core.WireRow, error) {
	rows, err := a.reg.InstrumentProvider().LoadWire(ctx, false)
	if err != nil {
		return nil, err
	}
	out := make([]core.WireRow, len(rows))
	for i, w := range rows {
		out[i] = core.WireRow{Instrument: w.Instrument, JSON: w}
	}
	return out, nil
}

// historicalOi and historical are the chart routes' history calls on the active
// broker, at the default "interactive" priority.
func (a *App) historicalOi(ctx context.Context, token int64, from, to string) ([]kite.DayOI, error) {
	return a.reg.HistoryProvider().GetHistoricalOi(ctx, token, from, to, kite.Interactive)
}

func (a *App) historical(ctx context.Context, token int64, from, to, interval string) ([]kite.ClosePoint, error) {
	return a.reg.HistoryProvider().GetHistorical(ctx, token, from, to, interval, kite.Interactive)
}

// synthBoard is Synthetic's getBoard: the F&O board as {symbol, name, is_index}.
func (a *App) synthBoard(ctx context.Context) ([]synthetic.BoardItem, error) {
	board, err := a.core.Board(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]synthetic.BoardItem, len(board))
	for i, b := range board {
		out[i] = synthetic.BoardItem{Symbol: b.Symbol, Name: b.Name, IsIndex: b.IsIndex}
	}
	return out, nil
}

// fairValueBoard is Fair Value's getBoard: {symbol, name, spot_token, is_index}.
func (a *App) fairValueBoard(ctx context.Context) ([]fairvalue.BoardItem, error) {
	board, err := a.core.Board(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]fairvalue.BoardItem, len(board))
	for i, b := range board {
		out[i] = fairvalue.BoardItem{Symbol: b.Symbol, Name: b.Name, SpotToken: float64(b.SpotToken), IsIndex: b.IsIndex}
	}
	return out, nil
}

// metadataVersion is `${activeBroker}:${instrumentProvider.loadedAt() ?? "unloaded"}`.
func (a *App) metadataVersion() string {
	loaded := "unloaded"
	if at := a.reg.InstrumentProvider().LoadedAt(); at != nil {
		loaded = strconv.FormatInt(*at, 10)
	}
	return string(a.reg.ActiveBroker()) + ":" + loaded
}

// fvInstruments is Fair Value's getAllInstruments: the active broker's universe as
// model.Instrument rows. Node handed Fair Value the provider's own row objects, so a
// Dhan row carried its dhan_* fields into the input snapshot (and its hash); Raw keeps
// that JSON. The conversion is cached per loaded universe: the provider returns the
// same slice until it reloads.
type fvInstruments struct {
	provider *registry.InstrumentProvider

	mu   sync.Mutex
	key  *market.Instrument // first row of the converted universe (its identity)
	n    int
	rows []model.Instrument
}

func (f *fvInstruments) load(ctx context.Context) ([]model.Instrument, error) {
	data, err := f.provider.Load(ctx, false)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return []model.Instrument{}, nil
	}
	key := &data[0]
	f.mu.Lock()
	if f.key == key && f.n == len(data) {
		rows := f.rows
		f.mu.Unlock()
		return rows, nil
	}
	f.mu.Unlock()

	wire, err := f.provider.LoadWire(ctx, false)
	if err != nil {
		return nil, err
	}
	rows := make([]model.Instrument, len(wire))
	for i, w := range wire {
		rows[i] = fairValueInstrument(w)
	}
	f.mu.Lock()
	f.key, f.n, f.rows = key, len(data), rows
	f.mu.Unlock()
	return rows, nil
}

// fairValueInstrument converts one provider row. A Kite row needs no Raw: the model
// writes the twelve CSV fields in Kite's order, as Node's row object had them.
func fairValueInstrument(w registry.WireInstrument) model.Instrument {
	i := w.Instrument
	row := model.Instrument{
		InstrumentToken: float64(i.InstrumentToken), ExchangeToken: float64(i.ExchangeToken),
		Tradingsymbol: i.Tradingsymbol, Name: i.Name, LastPrice: i.LastPrice, Expiry: i.Expiry,
		Strike: i.Strike, TickSize: i.TickSize, LotSize: i.LotSize, InstrumentType: i.InstrumentType,
		Segment: i.Segment, Exchange: i.Exchange,
	}
	if w.Dhan != nil {
		if v, err := fvjson.Parse(fvjson.Marshal(w)); err == nil {
			if o, ok := v.(*fvjson.Object); ok {
				row.Raw = o
			}
		}
	}
	return row
}
