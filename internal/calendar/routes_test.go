package calendar

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/dbtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/hub"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// Route behaviour the Node golden cannot show (Express routing, Go-only concerns) and a
// readable open -> close -> delete cycle with its arithmetic spelled out.

type roleMap map[string]auth.Role

func (m roleMap) RoleOf(r *http.Request) auth.Role { return m[r.Header.Get("X-Admin-Token")] }

var testRoles = roleMap{"full": auth.RoleFull, "trade": auth.RoleTrade}

func do(t *testing.T, h http.Handler, method, path, token, body string) (int, string) {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("X-Admin-Token", token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestUndecodableIDFailsBeforeAuth(t *testing.T) {
	svc := New(Deps{})
	h := server.New(server.Options{FrontendOrigin: "x"}, svc.Mount)
	// %FF is a valid escape but not UTF-8: decodeURIComponent throws, so Express answered
	// 400 while matching the route, before requireAdmin.
	for _, path := range []string{"/api/trades/%FF/close", "/api/trades/ab%FFcd", "/api/trades/%41%FF"} {
		method := http.MethodDelete
		if strings.HasSuffix(path, "/close") {
			method = http.MethodPost
		}
		code, body := do(t, h, method, path, "", "")
		param := strings.TrimSuffix(strings.TrimPrefix(path, "/api/trades/"), "/close")
		if code != http.StatusBadRequest || !strings.Contains(body, "URIError: Failed to decode param &#39;"+param+"&#39;") {
			t.Fatalf("%s %s = %d %s", method, path, code, body)
		}
	}
	// An escaped id that decodes to 24 hex digits is the id itself (Express decodes params).
	pool := dbtest.New(t)
	svc = New(Deps{Pool: pool, Sessions: testRoles})
	h = server.New(server.Options{FrontendOrigin: "x"}, svc.Mount)
	code, body := do(t, h, http.MethodDelete, "/api/trades/%365a10000000000000000abcd", "full", "")
	if code != http.StatusNotFound || body != `{"error":"Trade not found."}` {
		t.Fatalf("escaped id: %d %s", code, body)
	}
}

func TestTwelveCharacterIDIsInvalid(t *testing.T) {
	// Node's isValidId is mongoose.isValidObjectId, which with the locked bson 6.10.4
	// accepts exactly 24 hex characters, so a 12-character id is 400 like any other
	// malformed one (checked by running bson 6.10.4 ObjectId.isValid).
	pool := dbtest.New(t)
	svc := New(Deps{Pool: pool, Sessions: testRoles, RequireMarketData: func(string) (bool, MarketDataRefusal) { return true, MarketDataRefusal{} }})
	h := server.New(server.Options{FrontendOrigin: "x"}, svc.Mount)
	for _, req := range [][2]string{
		{http.MethodPost, "/api/trades/abcdefghijkl/close"}, {http.MethodDelete, "/api/trades/abcdefghijkl"},
		{http.MethodDelete, "/api/trades/abcdefghijk"},
	} {
		if code, body := do(t, h, req[0], req[1], "trade", ""); code != 400 || body != `{"error":"Invalid trade id."}` {
			t.Fatalf("%v = %d %s", req, code, body)
		}
	}
}

func TestNilDepsAreSafe(t *testing.T) {
	h := server.New(server.Options{FrontendOrigin: "x"}, New(Deps{}).Mount)
	if code, body := do(t, h, http.MethodGet, "/api/trades", "full", ""); code != 403 || body != `{"error":"Admin authentication required"}` {
		t.Fatalf("no sessions: %d %s", code, body)
	}
	h = server.New(server.Options{FrontendOrigin: "x"}, New(Deps{Sessions: testRoles}).Mount)
	if code, body := do(t, h, http.MethodGet, "/api/trades", "full", ""); code != 200 || body != `{"dbEnabled":false,"trades":[]}` {
		t.Fatalf("no pool: %d %s", code, body)
	}
	if code, body := do(t, h, http.MethodPost, "/api/trades", "full", `{"symbol":"ABC"}`); code != 503 ||
		body != `{"error":"Trade persistence is not configured (set DATABASE_URL)."}` {
		t.Fatalf("no pool: %d %s", code, body)
	}
	pool := dbtest.New(t)
	h = server.New(server.Options{FrontendOrigin: "x"}, New(Deps{Pool: pool, Sessions: testRoles}).Mount)
	code, body := do(t, h, http.MethodPost, "/api/trades", "full", `{"symbol":"ABC"}`)
	if code != 401 || body != `{"error":"Taking a trade requires a Zerodha session. Connect Zerodha.","broker":"zerodha","problems":[]}` {
		t.Fatalf("no market-data check: %d %s", code, body)
	}
}

// cycleKite is a scripted Kite for the cycle test.
type cycleKite struct {
	mu        sync.Mutex
	ladders   map[int64]kite.QuoteLadder
	charges   [][]kite.ChargeOrder
	onLadder  func()
	marginOut float64
}

func (k *cycleKite) GetQuoteLadder(_ context.Context, ids []string) (map[int64]kite.QuoteLadder, error) {
	if k.onLadder != nil {
		k.onLadder()
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.ladders, nil
}

func (k *cycleKite) GetBasketMargin(context.Context, []kite.BasketOrder, bool) (kite.BasketMarginResult, error) {
	return kite.BasketMarginResult{Total: k.marginOut}, nil
}

// GetOrderCharges bills a flat ₹20 brokerage and 0.02% STT on sells, nothing else.
func (k *cycleKite) GetOrderCharges(_ context.Context, orders []kite.ChargeOrder) ([]kite.OrderCharges, error) {
	k.mu.Lock()
	k.charges = append(k.charges, orders)
	k.mu.Unlock()
	out := make([]kite.OrderCharges, len(orders))
	for i, o := range orders {
		stt := 0.0
		if o.TransactionType == "SELL" {
			stt = o.Quantity * o.AveragePrice * 0.0002
		}
		out[i] = kite.OrderCharges{OrderID: o.OrderID, Tradingsymbol: o.Tradingsymbol, TransactionType: o.TransactionType,
			Quantity: o.Quantity, Price: o.AveragePrice, Raw: json.RawMessage(`{"brokerage":20}`),
			Charges: kite.OrderChargeBreakdown{Brokerage: 20, TransactionTax: stt, TransactionTaxType: "stt"}}
	}
	return out, nil
}

type mapHub map[int64]hub.Ladder

func (m mapHub) GetFreshLadder(token int64, _ int64) (hub.Ladder, bool) {
	l, ok := m[token]
	return l, ok
}

func cycleUniverse() []market.Instrument {
	return []market.Instrument{
		{InstrumentToken: 1, Tradingsymbol: "ABC", Exchange: "NSE", InstrumentType: "EQ", Segment: "NSE"},
		{InstrumentToken: 11, Tradingsymbol: "ABC26OCTFUT", Exchange: "NFO", InstrumentType: "FUT", Name: "ABC", LotSize: 100},
		{InstrumentToken: 12, Tradingsymbol: "ABC26NOVFUT", Exchange: "NFO", InstrumentType: "FUT", Name: "ABC", LotSize: 100},
	}
}

func cycleBoard([]market.Instrument) []BoardItem {
	return []BoardItem{{Symbol: "ABC", Name: "ABC LTD", SpotToken: 1, Futures: []BoardFuture{
		{Token: 11, Expiry: "2026-10-29", LotSize: 100}, {Token: 12, Expiry: "2026-11-26", LotSize: 100}}}}
}

func lvl(prices ...float64) []market.DepthLevel {
	out := []market.DepthLevel{}
	for _, p := range prices {
		out = append(out, market.DepthLevel{Price: p, Qty: 100})
	}
	return out
}

func TestOpenCloseDeleteCycle(t *testing.T) {
	pool := dbtest.New(t)
	now := time.Date(2026, 10, 28, 5, 0, 0, 0, time.UTC) // 10:30 IST, Wednesday
	k := &cycleKite{ladders: map[int64]kite.QuoteLadder{1: {Last: 1000}}, marginOut: 12345.5}
	books := mapHub{
		11: {Last: 1010, Bids: lvl(1009.5), Asks: lvl(1010.6, 1010.2)}, // premium 10: buy at the best ask 1010.2
		12: {Last: 1020, Bids: lvl(1019.8, 1019.5), Asks: lvl(1020.5)}, // premium 20: sell at the best bid 1019.8
	}
	logs := &logSink{}
	svc := New(Deps{
		Pool: pool, Sessions: testRoles, Hub: books, Kite: k, Logf: logs.logf,
		RequireMarketData: func(string) (bool, MarketDataRefusal) { return true, MarketDataRefusal{} },
		Instruments:       func(context.Context) ([]market.Instrument, error) { return cycleUniverse(), nil },
		Board:             cycleBoard,
		Now:               func() time.Time { return now },
	})
	h := server.New(server.Options{FrontendOrigin: "x", Now: func() time.Time { return now }}, svc.Mount)

	code, body := do(t, h, http.MethodPost, "/api/trades", "trade", `{"symbol":" abc "}`)
	if code != 200 {
		t.Fatalf("take: %d %s", code, body)
	}
	var resp struct{ Trade map[string]any }
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	tr := resp.Trade
	id := tr["id"].(string)
	// Entry: lot 100 × (1010.2 + 1019.8) = 203000; margin Math.round(12345.5) = 12346.
	if tr["entry_value"] != 203000.0 || tr["margin"] != 12346.0 || tr["status"] != "open" {
		t.Fatalf("entry: %s", body)
	}
	// Entry charges: BUY ₹20; SELL ₹20 + 0.02% × 101980 = 20.396 -> 20.4 (round2) => 60.4.
	if ec := tr["entry_charges"].(map[string]any); ec["total"] != 60.4 || ec["source"] != "kite" {
		t.Fatalf("entry charges: %v", ec)
	}
	// Projected exit at the entry fills: SELL ₹20 + 0.02% × 101020 = 20.204 -> 20.2; BUY ₹20.
	if est := tr["est_exit_charges"].(map[string]any); est["total"] != 60.2 || est["source"] != "kite_estimate" {
		t.Fatalf("estimated exit charges: %v", est)
	}
	if len(k.charges) != 1 || len(k.charges[0]) != 4 {
		t.Fatalf("entry priced in one /charges/orders call of 4 lines: %v", k.charges)
	}

	// Exit: the long leg (OCT) sells into the best bid 1012, the short leg (NOV) buys back
	// at the best ask 1018.6.
	books[11] = hub.Ladder{Last: 1012, Bids: lvl(1011.5, 1012), Asks: lvl(1012.5)}
	books[12] = hub.Ladder{Last: 1018, Bids: lvl(1018), Asks: lvl(1019, 1018.6)}
	now = now.Add(time.Hour)
	code, body = do(t, h, http.MethodPost, "/api/trades/"+id+"/close", "trade", "")
	if code != 200 {
		t.Fatalf("close: %d %s", code, body)
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	tr = resp.Trade
	// Gross = round2(100 × ((1012 - 1010.2) + (1019.8 - 1018.6))) = 300.
	// Exit charges: SELL 101200 -> 20 + 20.24 = 40.24; BUY 20 => 60.24.
	// Total = 60.4 + 60.24 = 120.64; net = 300 - 120.64 = 179.36.
	checks := map[string]any{"status": "closed", "close_pnl": 300.0, "buy_close": 1012.0, "sell_close": 1018.6,
		"exit_value": 203060.0, "total_charges": 120.64, "net_pnl": 179.36, "closed_at": "2026-10-28T06:00:00.000Z"}
	for key, want := range checks {
		if tr[key] != want {
			t.Fatalf("close %s = %v, want %v (%s)", key, tr[key], want, body)
		}
	}
	if xc := tr["exit_charges"].(map[string]any); xc["total"] != 60.24 || xc["source"] != "kite" {
		t.Fatalf("exit charges: %v", xc)
	}

	code, body = do(t, h, http.MethodDelete, "/api/trades/"+strings.ToUpper(id), "trade", "")
	if code != 200 || body != `{"success":true,"id":"`+strings.ToUpper(id)+`"}` {
		t.Fatalf("delete: %d %s", code, body)
	}
	if code, body = do(t, h, http.MethodGet, "/api/trades", "full", ""); code != 200 || body != `{"dbEnabled":true,"trades":[]}` {
		t.Fatalf("list: %d %s", code, body)
	}
	svc.Stop()
	rows := readLedger(t, pool)
	if len(rows) != 2 || !strings.Contains(rows[0], `"event":"entry"`) || !strings.Contains(rows[1], `"event":"exit"`) ||
		!strings.Contains(rows[1], `"gross_pnl":300,"total_charges":120.64,"net_pnl":179.36`) {
		t.Fatalf("ledger after delete: %q", rows)
	}
	if msgs := logs.take(); len(msgs) != 0 {
		t.Fatalf("unexpected warnings %q", msgs)
	}
}

func TestTakeFinishesWhenTheClientGoesAway(t *testing.T) {
	pool := dbtest.New(t)
	now := time.Date(2026, 10, 28, 5, 0, 0, 0, time.UTC)
	ctx, cancel := context.WithCancel(context.Background())
	k := &cycleKite{ladders: map[int64]kite.QuoteLadder{1: {Last: 1000}}, onLadder: cancel}
	svc := New(Deps{
		Pool: pool, Sessions: testRoles, Kite: k,
		Hub: mapHub{
			11: {Last: 1010, Bids: lvl(1009.5), Asks: lvl(1010.5)},
			12: {Last: 1020, Bids: lvl(1019.5), Asks: lvl(1020.5)},
		},
		RequireMarketData: func(string) (bool, MarketDataRefusal) { return true, MarketDataRefusal{} },
		Instruments:       func(context.Context) ([]market.Instrument, error) { return cycleUniverse(), nil },
		Board:             cycleBoard,
		Now:               func() time.Time { return now },
	})
	h := server.New(server.Options{FrontendOrigin: "x"}, svc.Mount)
	req := httptest.NewRequest(http.MethodPost, "/api/trades", strings.NewReader(`{"symbol":"ABC"}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Admin-Token", "full")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	svc.Stop()
	if rec.Code != 200 {
		t.Fatalf("take after the client went away: %d %s", rec.Code, rec.Body.String())
	}
	st := &store{pool: pool}
	if list, err := st.list(context.Background(), 200); err != nil || len(list) != 1 {
		t.Fatalf("trade not stored: %v %v", list, err)
	}
	if rows := readLedger(t, pool); len(rows) != 1 {
		t.Fatalf("ledger rows %d", len(rows))
	}
}

func TestLedgerFailureIsLoggedAndSwallowed(t *testing.T) {
	pool := dbtest.New(t)
	if _, err := pool.Exec(context.Background(), `drop table trade_log`); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 28, 5, 0, 0, 0, time.UTC)
	logs := &logSink{}
	svc := New(Deps{
		Pool: pool, Sessions: testRoles, Kite: &cycleKite{ladders: map[int64]kite.QuoteLadder{1: {Last: 1000}}}, Logf: logs.logf,
		Hub: mapHub{
			11: {Last: 1010, Bids: lvl(1009.5), Asks: lvl(1010.5)},
			12: {Last: 1020, Bids: lvl(1019.5), Asks: lvl(1020.5)},
		},
		RequireMarketData: func(string) (bool, MarketDataRefusal) { return true, MarketDataRefusal{} },
		Instruments:       func(context.Context) ([]market.Instrument, error) { return cycleUniverse(), nil },
		Board:             cycleBoard,
		Now:               func() time.Time { return now },
	})
	h := server.New(server.Options{FrontendOrigin: "x"}, svc.Mount)
	if code, body := do(t, h, http.MethodPost, "/api/trades", "full", `{"symbol":"ABC"}`); code != 200 {
		t.Fatalf("take: %d %s", code, body)
	}
	svc.Stop()
	msgs := logs.take()
	if len(msgs) != 1 || !strings.HasPrefix(msgs[0], "[TradeLog] failed to append entry event: ") {
		t.Fatalf("warnings %q", msgs)
	}
}
