package registry

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/dhan"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// The retained dhanActiveNoKite suite is a poison-dependency guard. The route
// goldens used recording Kite fakes and a different universe; replay the suite's
// own three ASTRAL instruments with every Kite REST operation forbidden.
type forbiddenKiteAPI struct{ *fakeKite }

func (k *forbiddenKiteAPI) forbidden(method string) error {
	k.rec.add("kite:forbidden %s", method)
	return errors.New("KITE MUST NOT BE USED")
}

func (k *forbiddenKiteAPI) GetInstruments(context.Context, string) ([]market.Instrument, error) {
	return nil, k.forbidden("getInstruments")
}
func (k *forbiddenKiteAPI) GetQuoteFull(context.Context, []string) ([]kite.FullQuote, error) {
	return nil, k.forbidden("getQuoteFull")
}
func (k *forbiddenKiteAPI) GetBasketMargin(context.Context, []kite.BasketOrder, bool) (kite.BasketMarginResult, error) {
	return kite.BasketMarginResult{}, k.forbidden("getBasketMargin")
}
func (k *forbiddenKiteAPI) GetHistoricalFull(context.Context, int64, string, string, string, kite.HistoricalPriority) ([]kite.HistoricalCandle, error) {
	return nil, k.forbidden("getHistoricalFull")
}
func (k *forbiddenKiteAPI) GetHistorical(context.Context, int64, string, string, string, kite.HistoricalPriority) ([]kite.ClosePoint, error) {
	return nil, k.forbidden("getHistorical")
}
func (k *forbiddenKiteAPI) GetHistoricalOi(context.Context, int64, string, string, kite.HistoricalPriority) ([]kite.DayOI, error) {
	return nil, k.forbidden("getHistoricalOi")
}
func (k *forbiddenKiteAPI) GetHistoricalOiSeries(context.Context, int64, string, string, string, kite.HistoricalPriority) ([]kite.OISeriesPoint, error) {
	return nil, k.forbidden("getHistoricalOiSeries")
}

func newNodeDhanProviderRig(t *testing.T) *unitRig {
	t.Helper()
	master := strings.Join([]string{
		"EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,TICK_SIZE",
		"NSE,D,45000,FUTSTK,ASTRAL20260929FUT,ASTRAL,1512,275,2026-09-29,0,0.05",
		"NSE,D,45001,FUTSTK,ASTRAL20261027FUT,ASTRAL,1512,275,2026-10-27,0,0.05",
		"NSE,E,1512,EQUITY,ASTRAL,ASTRAL,1512,1,,0,0.05",
	}, "\n")
	entry := func(id int) map[string]any {
		return map[string]any{
			"last_price": 1000 + id, "ohlc": map[string]any{"open": 1, "close": 999 + id, "high": 2, "low": 0}, "oi": 5000,
			"depth": map[string]any{
				"buy":  []any{map[string]any{"price": 999 + id, "quantity": 275, "orders": 2}},
				"sell": []any{map[string]any{"price": 1001 + id, "quantity": 275, "orders": 3}},
			},
		}
	}
	quotes := map[string]any{"data": map[string]any{
		"NSE_FNO": map[string]any{"45000": entry(45000), "45001": entry(45001)},
		"NSE_EQ":  map[string]any{"1512": entry(1512)},
	}}
	u := newUnitRig(t, nil, map[string][]httpSpec{
		"master GET detailed":        {{Status: 200, Body: json.RawMessage(mustJSON(master))}},
		"api POST /marketfeed/quote": {{Status: 200, Body: json.RawMessage(mustJSON(quotes))}},
	})
	u.kite.setToken(nil)
	u.reg.deps.Kite = &forbiddenKiteAPI{u.kite} // before any provider starts work
	u.activateDhan("tok")
	t.Cleanup(func() { noKite(t, u.rec.take()) })
	return u
}

func loadNodeDhanUniverse(t *testing.T, u *unitRig) []WireInstrument {
	t.Helper()
	rows, err := u.reg.InstrumentProvider().LoadWire(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("Dhan's universe must contain three rows: %d", len(rows))
	}
	return rows
}

func TestNodeDhanProvidersNeverUseKite(t *testing.T) {
	t.Run("active broker is dhan with an authenticated session and NO Kite session", func(t *testing.T) {
		u := newNodeDhanProviderRig(t)
		if u.reg.ActiveBroker() != brokers.Dhan || u.kite.HasSession() || !u.reg.SessionFor(brokers.Dhan).Authenticated {
			t.Fatal("Dhan must be authenticated independently of Kite")
		}
	})
	t.Run("the instrument universe loads from DHAN, never touching kite.getInstruments", func(t *testing.T) {
		rows := loadNodeDhanUniverse(t, newNodeDhanProviderRig(t))
		for _, row := range rows {
			if row.Dhan == nil || row.Dhan.DhanSecurityID <= 0 {
				t.Errorf("Dhan identity must survive the wire projection: %+v", row)
			}
		}
	})
	t.Run("board-shaped tokens belong to the DHAN namespace", func(t *testing.T) {
		for _, row := range loadNodeDhanUniverse(t, newNodeDhanProviderRig(t)) {
			if row.Dhan == nil {
				t.Fatal("Dhan identity missing")
			}
			want := dhan.InternalToken(row.Dhan.DhanSegment, row.Dhan.DhanSecurityID)
			if row.InstrumentToken != want || row.InstrumentToken <= 1_000_000_000 {
				t.Errorf("board token %d, want Dhan token %d", row.InstrumentToken, want)
			}
		}
	})
	t.Run("REST quotes come from DHAN and are keyed by the INTERNAL token", func(t *testing.T) {
		u := newNodeDhanProviderRig(t)
		loadNodeDhanUniverse(t, u)
		ticks, err := u.reg.QuoteProvider().QuotesByToken(context.Background(), dhanUniverseTokens)
		if err != nil || len(ticks) != 3 {
			t.Fatalf("every instrument must be quoted: %+v, %v", ticks, err)
		}
		for _, tick := range ticks {
			if !slices.Contains(dhanUniverseTokens, tick.Token) || !(tick.LastPrice > 0) {
				t.Errorf("quote must use a board token and carry LTP: %+v", tick)
			}
		}
	})
	t.Run("Dhan REST quotes carry executable bid/ask depth", func(t *testing.T) {
		u := newNodeDhanProviderRig(t)
		loadNodeDhanUniverse(t, u)
		ticks, err := u.reg.QuoteProvider().QuotesByToken(context.Background(), dhanUniverseTokens[:1])
		if err != nil || len(ticks) != 1 || !(ticks[0].Bid > 0) || !(ticks[0].Ask > ticks[0].Bid) {
			t.Fatalf("bid/ask depth = %+v, %v", ticks, err)
		}
	})
	for _, tc := range []struct {
		title string
		token int64
		want  bool
	}{
		{"a KITE token is REJECTED while Dhan is active", 408065, false},
		{"a DHAN token is accepted while Dhan is active", dhanUniverseTokens[0], true},
	} {
		t.Run(tc.title, func(t *testing.T) {
			u := newNodeDhanProviderRig(t)
			loadNodeDhanUniverse(t, u)
			if got := u.reg.AssertActiveBrokerToken(tc.token, "test"); got != tc.want {
				t.Errorf("token %d accepted=%v, want %v", tc.token, got, tc.want)
			}
		})
	}
	t.Run("market data reports ready without any Zerodha session", func(t *testing.T) {
		u := newNodeDhanProviderRig(t)
		if !u.reg.MarketData().IsAuthenticated() {
			t.Fatal("Dhan session is what matters")
		}
	})
	t.Run("a connected socket with NOTHING subscribed is not reported as LIVE", func(t *testing.T) {
		universe := 18_492
		h := brokers.ComputeFeedHealth(brokers.FeedHealthInput{Connected: true, Authenticated: true, Universe: &universe})
		if h.State != brokers.FeedConnectedNoSubscription || !strings.Contains(h.Detail, "nothing is subscribed") {
			t.Fatalf("idle feed health = %+v", h)
		}
	})
}
