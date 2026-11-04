// Command verifyfixture runs the actual App/Chi/PostgreSQL service with generated
// loopback market data for frontend verification. It is never imported by cmd/server.
package main

import (
	"context"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/app"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokerlogin"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers/registry"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/db"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/fvtest"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/model"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/ticker"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const calendarID = "0123456789abcdef01234567"
const syntheticID = "0123456789abcdef01234568"

type fixture struct {
	rows           []market.Instrument
	expiries       []time.Time
	byToken        map[int64]market.Instrument
	bySymbol       map[string]int64
	mu             sync.Mutex
	requests       map[string]int
	blocked        atomic.Int64
	tokenAvailable atomic.Bool
	tokenRequests  atomic.Int64
	spikeStage     atomic.Int64
	spikeAt        atomic.Int64
}

func newFixture() *fixture {
	f := &fixture{byToken: map[int64]market.Instrument{}, bySymbol: map[string]int64{}, requests: map[string]int{}}
	f.initSpike()
	now := time.Now().UTC()
	first := time.Date(now.Year(), now.Month(), 20, 10, 0, 0, 0, time.UTC)
	if !first.After(now.Add(24 * time.Hour)) {
		first = first.AddDate(0, 1, 0)
	}
	f.rows = append(f.rows, market.Instrument{InstrumentToken: 1, ExchangeToken: 1, Tradingsymbol: "TEST",
		Name: "Test underlying", TickSize: .001, LotSize: 1, InstrumentType: "EQ", Segment: "NSE", Exchange: "NSE"})
	token := int64(10)
	for n := 0; n < 3; n++ {
		expiry := first.AddDate(0, n, 0)
		f.expiries = append(f.expiries, expiry)
		f.rows = append(f.rows, market.Instrument{InstrumentToken: int64(1000 + n), ExchangeToken: int64(1000 + n),
			Tradingsymbol: "TEST" + strings.ToUpper(expiry.Format("06Jan")) + "FUT", Name: "TEST", Expiry: expiry.Format("2006-01-02"),
			TickSize: .001, LotSize: 50, InstrumentType: "FUT", Segment: "NFO-FUT", Exchange: "NFO"})
		for _, strike := range fvtest.DefaultStrikes {
			for _, side := range []string{model.CE, model.PE} {
				f.rows = append(f.rows, market.Instrument{InstrumentToken: token, ExchangeToken: token,
					Tradingsymbol: fmt.Sprintf("TEST%s%.0f%s", expiry.Format("060102"), strike, side), Name: "TEST",
					Expiry: expiry.Format("2006-01-02"), Strike: strike, TickSize: .001, LotSize: 50,
					InstrumentType: side, Segment: "NFO-OPT", Exchange: "NFO"})
				token++
			}
		}
	}
	for _, row := range f.rows {
		f.byToken[row.InstrumentToken] = row
		f.bySymbol[row.Exchange+":"+row.Tradingsymbol] = row.InstrumentToken
	}
	return f
}

func (f *fixture) tick(token int64) market.Tick {
	row := f.byToken[token]
	price := 100.0
	if row.Expiry != "" {
		expiry, _ := time.Parse("2006-01-02", row.Expiry)
		expiry = expiry.Add(10 * time.Hour)
		t := expiry.Sub(time.Now()).Hours() / (24 * 365)
		forward, discount := 100*math.Exp(.05*t), math.Exp(-.05*t)
		price = forward
		if row.InstrumentType == model.CE || row.InstrumentType == model.PE {
			price = model.BlackFromIv(forward, row.Strike, t, discount, .3, row.InstrumentType)
		}
	}
	bid, ask := math.Max(.000001, price-.001), price+.001
	depth, exchange := true, time.Now().Add(-100*time.Millisecond).UnixMilli()
	return market.Tick{Token: token, LastPrice: price, ClosePrice: price, OI: 10000,
		Bid: bid, Ask: ask, Bids: []market.DepthLevel{{Price: bid, Qty: 1000, Orders: 1}},
		Asks: []market.DepthLevel{{Price: ask, Qty: 1000, Orders: 1}}, DepthUpdated: &depth, ExchangeTS: &exchange}
}

func success(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": data})
}

func (f *fixture) upstream(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/spike-feed":
		f.spikeFeed(w, r)
	case r.URL.Path == "/marketfeed/quote":
		f.spikeMarketQuote(w, r)
	case r.URL.Path == "/charts/intraday" || r.URL.Path == "/charts/historical":
		_ = json.NewEncoder(w).Encode(map[string]any{"timestamp": []int{}, "close": []float64{}, "open_interest": []int{}})
	case r.URL.Path == "/instruments":
		w.Header().Set("Content-Type", "text/csv")
		out := csv.NewWriter(w)
		_ = out.Write([]string{"instrument_token", "exchange_token", "tradingsymbol", "name", "last_price", "expiry", "strike", "tick_size", "lot_size", "instrument_type", "segment", "exchange"})
		for _, i := range f.rows {
			_ = out.Write([]string{strconv.FormatInt(i.InstrumentToken, 10), strconv.FormatInt(i.ExchangeToken, 10), i.Tradingsymbol, i.Name,
				"0", i.Expiry, fmt.Sprint(i.Strike), fmt.Sprint(i.TickSize), fmt.Sprint(i.LotSize), i.InstrumentType, i.Segment, i.Exchange})
		}
		out.Flush()
	case r.URL.Path == "/session/token":
		success(w, map[string]any{"access_token": "loopback-fixture-session", "user_id": "FIXTURE", "user_name": "Local generated market"})
	case r.URL.Path == "/user/profile":
		success(w, map[string]any{"user_id": "FIXTURE", "user_name": "Local generated market"})
	case r.URL.Path == "/profile":
		token := r.Header.Get("access-token")
		if token != "loopback-pasted-dhan-token" && token != "loopback-service-dhan-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"errorMessage": "Invalid generated fixture token"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"dhanClientId": "1100001", "tokenValidity": time.Now().Add(24 * time.Hour).UnixMilli()})
	case r.URL.Path == "/scrip-master.csv":
		w.Header().Set("Content-Type", "text/csv")
		_, _ = fmt.Fprint(w, f.spikeMaster())
	case strings.HasPrefix(r.URL.Path, "/quote"):
		quotes := map[string]any{}
		for _, key := range r.URL.Query()["i"] {
			token, ok := f.bySymbol[key]
			if !ok {
				continue
			}
			t := f.tick(token)
			quotes[key] = map[string]any{"instrument_token": token, "last_price": t.LastPrice, "oi": t.OI,
				"last_trade_time": time.Now().UTC().Add(330 * time.Minute).Format("2006-01-02 15:04:05"),
				"ohlc":            map[string]any{"open": t.LastPrice, "high": t.LastPrice, "low": t.LastPrice, "close": t.ClosePrice},
				"depth": map[string]any{"buy": []any{map[string]any{"price": t.Bid, "quantity": 1000, "orders": 1}},
					"sell": []any{map[string]any{"price": t.Ask, "quantity": 1000, "orders": 1}}}}
		}
		success(w, quotes)
	case r.URL.Path == "/margins/basket":
		success(w, map[string]any{"initial": map[string]any{"total": 18000}, "final": map[string]any{"total": 12000}})
	case r.URL.Path == "/charges/orders":
		var orders []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&orders); err != nil {
			http.Error(w, "invalid fixture charge request", 400)
			return
		}
		for _, order := range orders {
			order["charges"] = map[string]any{"brokerage": 10, "transaction_tax": 1, "transaction_tax_type": "stt",
				"exchange_turnover_charge": 1, "sebi_turnover_charge": .1, "stamp_duty": .9,
				"gst": map[string]any{"igst": 2, "cgst": 0, "sgst": 0, "total": 2}, "total": 15}
		}
		success(w, orders)
	case strings.HasPrefix(r.URL.Path, "/instruments/historical/"):
		success(w, map[string]any{"candles": []any{}})
	default:
		http.Error(w, "unavailable in loopback fixture", 503)
	}
}

// Generated env_home token API, served only on a local TLS listener. The browser
// can exercise service failure -> manual fallback -> service recovery against App.
func (f *fixture) tokenService(w http.ResponseWriter, r *http.Request) {
	f.tokenRequests.Add(1)
	var request map[string]string
	if r.Method != "POST" || r.URL.Path != "/api/v1/token" || json.NewDecoder(r.Body).Decode(&request) != nil || len(request) != 2 || request["client_id"] != "1100001" ||
		r.Header.Get("CF-Access-Client-Id") != "loopback-fixture-cf-id" || r.Header.Get("CF-Access-Client-Secret") != "loopback-fixture-cf-secret" {
		http.Error(w, "invalid generated token request", http.StatusBadRequest)
		return
	}
	code, _ := brokerlogin.CodeAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", time.Now())
	if request["totp"] != code {
		http.Error(w, "invalid generated token code", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if !f.tokenAvailable.Load() {
		w.Header().Set("Retry-After", "300")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "no_token_yet"})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"client_id": "1100001", "access_token": "loopback-service-dhan-token", "expires_in": 86400})
}

type feed struct {
	mu     sync.Mutex
	tokens map[int64]bool
	done   chan struct{}
	once   sync.Once
}

func (h *feed) Close() { h.once.Do(func() { close(h.done) }) }
func (h *feed) Subscribe(tokens []int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, token := range tokens {
		h.tokens[token] = true
	}
}
func (h *feed) Unsubscribe(tokens []int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, token := range tokens {
		delete(h.tokens, token)
	}
}

func (f *fixture) connect(o ticker.Options) ticker.Handle {
	h := &feed{tokens: map[int64]bool{}, done: make(chan struct{})}
	h.Subscribe(o.Tokens)
	go func() {
		defer func() {
			if o.OnClose != nil {
				o.OnClose()
			}
		}()
		select {
		case <-h.done:
			return
		case <-time.After(10 * time.Millisecond):
		}
		if o.OnOpen != nil {
			o.OnOpen()
		}
		timer := time.NewTicker(250 * time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-h.done:
				return
			case <-timer.C:
				h.mu.Lock()
				tokens := make([]int64, 0, len(h.tokens))
				for token := range h.tokens {
					tokens = append(tokens, token)
				}
				h.mu.Unlock()
				sort.Slice(tokens, func(i, j int) bool { return tokens[i] < tokens[j] })
				ticks := make([]market.Tick, 0, len(tokens))
				for _, token := range tokens {
					ticks = append(ticks, f.tick(token))
				}
				if o.OnTick != nil && len(ticks) > 0 {
					o.OnTick(ticks)
				}
			}
		}
	}()
	return h
}

func run() error {
	address := flag.String("listen", "127.0.0.1:31301", "loopback verification listener")
	frontend := flag.String("frontend", "http://127.0.0.1:5175", "local frontend origin")
	flag.Parse()
	host, _, err := net.SplitHostPort(*address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return fmt.Errorf("verification listener must use a loopback IP")
	}
	u, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil || u.Hostname() == "" || (u.Hostname() != "localhost" && (net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback())) {
		return fmt.Errorf("TEST_DATABASE_URL must identify a local test PostgreSQL database")
	}
	l, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	defer l.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, u.String())
	if err != nil {
		return err
	}
	defer admin.Close()
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	schema := "browser_fixture_" + hex.EncodeToString(random[:])
	if _, err := admin.Exec(ctx, "create schema "+schema); err != nil {
		return err
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if _, err := admin.Exec(cleanup, "drop schema "+schema+" cascade"); err != nil {
			log.Printf("fixture schema cleanup: %v", err)
		}
	}()
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	pool, err := db.Open(ctx, u.String())
	if err != nil {
		return err
	}
	defer pool.Close()
	f := newFixture()
	upstream := httptest.NewServer(http.HandlerFunc(f.upstream))
	defer upstream.Close()
	tokenService := httptest.NewTLSServer(http.HandlerFunc(f.tokenService))
	defer tokenService.Close()
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(address)
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			f.blocked.Add(1)
			return nil, fmt.Errorf("fixture transport only accepts loopback")
		}
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	tokenClient := tokenService.Client()
	tokenTransport := tokenClient.Transport.(*http.Transport).Clone()
	tokenTransport.DialContext = transport.DialContext
	defer tokenTransport.CloseIdleConnections()
	tokenClient.Transport = tokenTransport
	curve, policy := fvtest.CurveObject(), fvtest.ExpiryPolicyObject()
	stamp := model.ISOString(float64(time.Now().UnixMilli()))
	curve.Set("as_of", stamp)
	policy.Set("as_of", stamp)
	patch := jsjson.NewObjectValue()
	patch.Set("curve", curve)
	patch.Set("expiry_policy", policy)
	patch.Set("proportional_calendar_assumption", true)
	patch.Set("forward_interpolation", "log_carry_assumption")
	patch.Set("history_interval_ms", 10000.0)
	env := map[string]string{"KITE_API_KEY": "loopback-fixture-key", "KITE_API_SECRET": "loopback-fixture-secret",
		"DEFAULT_BROKER": "zerodha", // retained board/valuation workflows explicitly begin here
		"ADMIN_SECRET":   "loopback-fixture-admin", "ACCESS_SECRET": "loopback-fixture-trade", "FRONTEND_URL": *frontend,
		"DHAN_CLIENT_ID": "1100001", "BROKER_LOGIN_URL": tokenService.URL,
		"BROKER_LOGIN_CF_CLIENT_ID": "loopback-fixture-cf-id", "BROKER_LOGIN_CF_CLIENT_SECRET": "loopback-fixture-cf-secret",
		"DHAN_TOKEN_API_SEED": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
		"FAIR_VALUE_ENABLED":  "true", "FAIR_VALUE_CONFIG_JSON": string(jsjson.Marshal(patch))}
	a, err := app.New(config.Load(config.MapGetter(env)), app.Options{Pool: pool,
		LookupEnv:   func(key string) (string, bool) { value, ok := env[key]; return value, ok },
		KiteAPIRoot: upstream.URL, KiteLoginRoot: upstream.URL, KiteHTTPClient: client, TickerConnect: f.connect,
		KiteTickerURL: "ws://127.0.0.1:1", YahooChartRoot: upstream.URL, YahooHTTPClient: client,
		BrokerLoginHTTPClient: tokenClient,
		SpikeNow:              func() time.Time { return time.UnixMilli(f.spikeAt.Load()) },
		Dhan: registry.DhanConfig{APIRoot: upstream.URL, AuthRoot: upstream.URL, FeedURL: spikeFeedURL(upstream.URL),
			ScripMasterURLs: []string{upstream.URL + "/scrip-master.csv"}, HTTPClient: client}})
	if err != nil {
		return err
	}
	if err := f.seed(pool); err != nil {
		return err
	}
	if err := f.seedSpike(pool); err != nil {
		return err
	}
	a.Start(context.Background())
	// Inspectable verification metadata; every application request still goes through
	// App's actual middleware/routes. No authentication or valuations are stubbed here.
	api := a.Handler()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/__fixture/spike" {
			var request struct {
				Stage int `json:"stage"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil || request.Stage < 0 || request.Stage > 3 {
				http.Error(w, "invalid stage", 400)
				return
			}
			f.spikeStage.Store(int64(request.Stage))
			f.spikeAt.Add(60_000)
			_ = json.NewEncoder(w).Encode(map[string]any{"stage": request.Stage, "t": f.spikeAt.Load()})
			return
		}
		if r.Method == "POST" && r.URL.Path == "/__fixture/token-service" {
			var request struct {
				Available bool `json:"available"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				http.Error(w, "invalid fixture control", 400)
				return
			}
			f.tokenAvailable.Store(request.Available)
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			return
		}
		if r.URL.Path == "/__fixture" {
			f.mu.Lock()
			defer f.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"runtime": "go-chi-postgres", "generated_market": true,
				"underlying": "TEST", "calendar_id": calendarID, "synthetic_id": syntheticID,
				"calculator_expiry": f.expiries[0].AddDate(0, 0, 10).UTC().Add(330 * time.Minute).Format("2006-01-02T15:04"),
				"requests":          f.requests, "blocked_outbound": f.blocked.Load(), "token_requests": f.tokenRequests.Load()})
			return
		}
		f.mu.Lock()
		f.requests[r.Method+" "+r.URL.Path]++
		f.mu.Unlock()
		api.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(l) }()
	log.Printf("Go verification fixture listening on http://%s", l.Addr())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	select {
	case <-signals:
	case err := <-served:
		return err
	}
	_ = srv.Close() // release verification HTTP/SSE handlers before the real App drain
	result := a.Shutdown(context.Background(), "verification-fixture")
	if result.ExitCode() != 0 || len(result.Failed) != 0 {
		return fmt.Errorf("verification fixture shutdown failed")
	}
	return nil
}

func (f *fixture) seed(pool *db.Pool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := time.Now().UTC()
	charges := fmt.Sprintf(`{"legs":[],"value":0,"brokerage":20,"stt":1,"exchange_txn":1,"sebi":0,"stamp_duty":0,"gst":8,"total":30,"source":"kite","at":%q}`, model.ISOString(float64(now.UnixMilli())))
	_, err := pool.Exec(ctx, `insert into trades (id,symbol,name,lot_size,buy_token,buy_expiry,buy_entry,sell_token,sell_expiry,sell_entry,status,opened_at,closed_at,close_pnl,buy_close,sell_close,total_charges,net_pnl,entry_charges)
		values ($1,'TEST','Test underlying',50,1000,$2,100,1001,$3,101,'closed',$4,$5,150,102,100,30,120,$6::json)`,
		calendarID, f.expiries[0].Format("2006-01-02"), f.expiries[1].Format("2006-01-02"), now.Add(-time.Hour), now.Add(-time.Minute), charges)
	if err != nil {
		return err
	}
	_, err = pool.Exec(ctx, `insert into synth_trades (id,status,key,broker,underlying,name,expiry,strike,direction,lot_size,quantity,opened_at,opened_day,entry_future_price,entry_synthetic_price,entry_lock_per_unit,entry_edge,entry_gross_edge,entry_charges,estimated_exit_charges,entry_net_edge,expected_net_profit,closed_at,closed_day,gross_pnl,exit_charges,total_charges,net_pnl)
		values ($1,'closed','loopback-closed','dhan','TEST','Test underlying',$2,100,'CONVERSION',50,50,$3,$4,102,100,2,100,100,30,20,50,50,$5,$4,200,20,50,150)`,
		syntheticID, f.expiries[0].Format("2006-01-02"), now.Add(-time.Hour), now.Add(330*time.Minute).Format("2006-01-02"), now.Add(-time.Minute))
	return err
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
