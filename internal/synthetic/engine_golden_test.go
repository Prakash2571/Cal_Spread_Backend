package synthetic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/auth"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/server"
)

// TestEngineGolden replays testdata/engine_golden.json, recorded by gen_engine.mjs from
// the ORIGINAL src/synthetic/engine.ts and routes.ts, against the Go engine and its
// routes (server.New + Register). Each step runs one operation under the same
// determinism model (sim_test.go) and compares, as exact text: every dependency call in
// order, the SSE frames of every client, the results of the operations that finished
// (route status and body bytes included), getStatus(), getOpenPositions(), the digest of
// the full opportunity list, the published and full lists where recorded, and the parked
// calls. 14 scenarios (lifecycle, manual close, deletes, settings, SSE and every exit
// kind, the closing bell, the token budget with and without SYNTH_SHARE_BOX_BUDGET,
// restart/re-link/broker switch staleness, storage failures, route edge cases, the
// option flags, entry races and midnight); regenerate with
// `scratch/go-migration/check.sh node internal/synthetic/testdata/gen_engine.mjs`.

type engineGolden struct {
	Today     string                         `json:"today"`
	Universes map[string][]market.Instrument `json:"universes"`
	Board     []BoardItem                    `json:"board"`
	Scenarios []goldenScenario               `json:"scenarios"`
}

type goldenScenario struct {
	Name  string            `json:"name"`
	Env   map[string]string `json:"env"`
	Start int64             `json:"start"`
	World struct {
		Auth          bool            `json:"auth"`
		MarketOpen    *bool           `json:"marketOpen"`
		Broker        string          `json:"broker"`
		Rf            *float64        `json:"rf"`
		BoxLane       *laneJSON       `json:"boxLane"`
		Margins       bool            `json:"margins"`
		MarginDefault json.RawMessage `json:"marginDefault"`
		StoreEnabled  bool            `json:"storeEnabled"`
	} `json:"world"`
	Steps []goldenStep `json:"steps"`
}

type laneJSON struct {
	Running    bool    `json:"running"`
	HeldTokens float64 `json:"heldTokens"`
	Budget     float64 `json:"budget"`
}

type goldenStep struct {
	Op     string          `json:"op"`
	OpID   int             `json:"opId"`
	Name   string          `json:"name"`
	Args   json.RawMessage `json:"args"`
	Ticks  []market.Tick   `json:"ticks"`
	Ms     int64           `json:"ms"`
	Set    json.RawMessage `json:"set"`
	Kind   string          `json:"kind"`
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Token  *string         `json:"token"`
	Xff    *string         `json:"xff"`
	Body   *string         `json:"body"`
	Out    goldenOut       `json:"out"`
}

type goldenOut struct {
	Calls     []string                `json:"calls"`
	Frames    map[string]goldenFrames `json:"frames"`
	Settled   []goldenSettled         `json:"settled"`
	Status    *string                 `json:"status"`
	Open      *string                 `json:"open"`
	Opps      *string                 `json:"opps"`
	Published *string                 `json:"published"`
	Full      *string                 `json:"full"`
	Pending   []string                `json:"pending"`
}

type goldenFrames struct {
	Frames []string `json:"frames"`
	Ended  bool     `json:"ended"`
}

type goldenSettled struct {
	Op    int     `json:"op"`
	Kind  string  `json:"kind"`
	Ok    *string `json:"ok"`
	Throw *string `json:"throw"`
}

func loadEngineGolden(t *testing.T) *engineGolden {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "engine_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g engineGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return &g
}

func TestEngineGolden(t *testing.T) {
	g := loadEngineGolden(t)
	if len(g.Scenarios) == 0 {
		t.Fatal("golden has no scenarios")
	}
	saved := sseMaxBacklog
	sseMaxBacklog = 1 << 20 // the replay drains after every step; never drop a recorder
	defer func() { sseMaxBacklog = saved }()
	for i := range g.Scenarios {
		sc := &g.Scenarios[i]
		t.Run(sc.Name, func(t *testing.T) { newReplay(t, g, sc).run() })
	}
}

/* ---------------------------------- world ---------------------------------- */

type restQuote struct {
	LastPrice     float64 `json:"last_price"`
	LastTradeTime string  `json:"last_trade_time"`
}

// fault is one scripted outcome of an I/O call (gen_engine.mjs io.faults).
type fault struct {
	Error *string         `json:"error"`
	Apply bool            `json:"apply"`
	Value json.RawMessage `json:"value"`
}

func (f *fault) failIf() error {
	if f != nil && f.Error != nil && !f.Apply {
		return errors.New(*f.Error)
	}
	return nil
}

func (f *fault) failAfter() error {
	if f != nil && f.Error != nil && f.Apply {
		return errors.New(*f.Error)
	}
	return nil
}

type world struct {
	auth          bool
	marketOpen    *bool
	switching     bool
	generation    int64
	broker        string
	rf            *float64
	boxLane       BoxLaneUsage
	universe      string
	rest          map[int64]restQuote
	marginDefault json.RawMessage
	sessions      map[string]auth.Role
}

type replayClient struct {
	c             *sseClient
	remove        func()
	ended         bool // marked by a restart
	reportedEnded bool
}

type replayOp struct {
	id     int
	kind   string
	done   bool
	ok     *string
	thrown *string
}

type replay struct {
	t  *testing.T
	g  *engineGolden
	sc *goldenScenario

	sim *sim
	// mu guards the call log, the faults, the world, the store and the ops: tasks and the
	// driver touch them (never at the same time, but the race detector wants a lock).
	mu         sync.Mutex
	log        []string
	faults     map[string][]*fault
	held       map[string]bool
	w          world
	store      *memStore
	cfg        Config
	hasMargins bool
	hasBoxLane bool

	eng         *Engine
	handler     http.Handler
	clients     map[string]*replayClient
	clientOrder []string
	ops         []*replayOp
	opSeq       int
	last        struct{ status, open, opps string }
	// counts of what was compared, reported at the end of the scenario
	nCalls, nSettled, nHTTP, nFrames, nStatus int
}

func newReplay(t *testing.T, g *engineGolden, sc *goldenScenario) *replay {
	env := sc.Env
	get := config.Getter(func(k string) string { return env[k] })
	r := &replay{
		t: t, g: g, sc: sc,
		sim:        newSim(sc.Start),
		faults:     map[string][]*fault{},
		held:       map[string]bool{},
		cfg:        LoadConfig(get),
		hasMargins: sc.World.Margins,
		hasBoxLane: sc.World.BoxLane != nil,
		clients:    map[string]*replayClient{},
	}
	r.w = world{
		auth: sc.World.Auth, marketOpen: sc.World.MarketOpen, generation: 1, broker: sc.World.Broker,
		rf: sc.World.Rf, universe: "kite", rest: map[int64]restQuote{}, marginDefault: sc.World.MarginDefault,
		sessions: map[string]auth.Role{"tok-full": auth.RoleFull, "tok-trade": auth.RoleTrade},
	}
	if sc.World.BoxLane != nil {
		r.w.boxLane = BoxLaneUsage{Running: sc.World.BoxLane.Running, HeldTokens: sc.World.BoxLane.HeldTokens, Budget: sc.World.BoxLane.Budget}
	}
	r.store = &memStore{r: r, rows: map[string]*memRow{}, settings: map[string]any{}, enabled: sc.World.StoreEnabled}
	r.newEngine()
	return r
}

func (r *replay) newEngine() {
	deps := Deps{
		GetAllInstruments: r.getAllInstruments,
		GetBoard:          r.getBoard,
		MarketData:        replayMarketData{r},
		IsMarketOpen: func() bool {
			r.mu.Lock()
			mo := r.w.marketOpen
			r.mu.Unlock()
			if mo != nil {
				return *mo
			}
			return isMarketOpenAt(r.sim.nowMs())
		},
		IstDayKey: func(at int64) string { return time.UnixMilli(at + 19_800_000).UTC().Format("2006-01-02") },
		GetRfPct: func() *float64 {
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.w.rf
		},
		ActiveBroker: func() brokers.ID {
			r.mu.Lock()
			defer r.mu.Unlock()
			return brokers.ID(r.w.broker)
		},
		SetTokens: func(tokens []int64) {
			r.mu.Lock()
			r.log = append(r.log, `{"kind":"setTokens","args":[`+string(jsjson.Marshal(tokens))+`]}`)
			r.mu.Unlock()
		},
		Store: r.store,
		Switching: func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.w.switching
		},
		BrokerGeneration: func() int64 {
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.w.generation
		},
		Now: r.sim.nowTime,
	}
	if r.hasMargins {
		deps.Margins = replayMargins{r}
	}
	if r.hasBoxLane {
		deps.BoxLane = func() BoxLaneUsage {
			r.mu.Lock()
			defer r.mu.Unlock()
			return r.w.boxLane
		}
	}
	cfg := r.cfg
	deps.Config = &cfg
	r.eng = newEngine(deps, r.sim)
	r.handler = nil
}

// isMarketOpenAt is the generator's (and index.ts's) isMarketOpen: Mon–Fri 09:15–15:40 IST.
func isMarketOpenAt(ms int64) bool {
	ist := time.UnixMilli(ms + 19_800_000).UTC()
	if wd := ist.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return false
	}
	mins := ist.Hour()*60 + ist.Minute()
	return mins >= 9*60+15 && mins <= 15*60+40
}

/* ------------------------------- fake I/O ---------------------------------- */

// io records one asynchronous dependency call, takes its next scripted fault, computes
// its outcome now and parks the caller until the driver releases the answer.
func (r *replay) io(kind, args string, exec func(f *fault) (any, error)) (any, error) {
	r.mu.Lock()
	r.log = append(r.log, `{"kind":`+string(jsjson.Marshal(kind))+`,"args":`+args+`}`)
	var f *fault
	if q := r.faults[kind]; len(q) > 0 {
		f = q[0]
		r.faults[kind] = q[1:]
	}
	v, err := exec(f)
	r.mu.Unlock()
	r.sim.park(kind)
	return v, err
}

func args(vals ...any) string { return string(jsjson.Marshal(vals)) }

func (r *replay) getAllInstruments(context.Context) ([]market.Instrument, error) {
	v, err := r.io("getAllInstruments", "[]", func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		return append([]market.Instrument(nil), r.g.Universes[r.w.universe]...), nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]market.Instrument), nil
}

func (r *replay) getBoard(context.Context) ([]BoardItem, error) {
	v, err := r.io("getBoard", "[]", func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		return append([]BoardItem(nil), r.g.Board...), nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]BoardItem), nil
}

type replayMarketData struct{ r *replay }

func (m replayMarketData) IsAuthenticated() bool {
	m.r.mu.Lock()
	defer m.r.mu.Unlock()
	return m.r.w.auth
}

func (m replayMarketData) GetQuoteFull(_ context.Context, ids []string) ([]market.RestQuote, error) {
	r := m.r
	v, err := r.io("getQuoteFull", args(ids), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		byID := map[string]int64{}
		for _, i := range r.g.Universes[r.w.universe] {
			byID[i.Exchange+":"+i.Tradingsymbol] = i.InstrumentToken
		}
		out := []market.RestQuote{}
		for _, id := range ids {
			tok, ok := byID[id]
			if !ok {
				continue
			}
			if q, ok := r.w.rest[tok]; ok {
				out = append(out, market.RestQuote{InstrumentToken: tok, LastPrice: q.LastPrice, LastTradeTime: q.LastTradeTime})
			}
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]market.RestQuote), nil
}

type replayMargins struct{ r *replay }

func (m replayMargins) Broker() brokers.ID {
	m.r.mu.Lock()
	defer m.r.mu.Unlock()
	return brokers.ID(m.r.w.broker)
}

func (m replayMargins) BasketMargin(_ context.Context, orders []market.MarginOrder, considerPositions bool) (market.BasketMargin, error) {
	r := m.r
	opts := jsjson.RawObject(func(dst []byte) []byte {
		return jsjson.NewObject(dst).Field("considerPositions", considerPositions).End()
	})
	v, err := r.io("basketMargin", args(orders, opts), func(f *fault) (any, error) {
		raw := r.w.marginDefault
		if f != nil {
			raw, _ = json.Marshal(f)
		}
		var spec struct {
			Error *string          `json:"error"`
			Value *json.RawMessage `json:"value"`
		}
		_ = json.Unmarshal(raw, &spec)
		if spec.Error != nil {
			return nil, errors.New(*spec.Error)
		}
		var val struct {
			Initial      float64         `json:"initial"`
			Final        float64         `json:"final"`
			Total        json.RawMessage `json:"total"`
			Source       string          `json:"source"`
			HedgeBenefit *float64        `json:"hedge_benefit"`
		}
		if spec.Value != nil {
			_ = json.Unmarshal(*spec.Value, &val)
		}
		out := market.BasketMargin{Initial: val.Initial, Final: val.Final, Source: market.MarginSource(val.Source), HedgeBenefit: val.HedgeBenefit}
		if string(val.Total) == `"NaN"` {
			out.Total = nan()
		} else {
			_ = json.Unmarshal(val.Total, &out.Total)
		}
		return out, nil
	})
	if err != nil {
		return market.BasketMargin{}, err
	}
	return v.(market.BasketMargin), nil
}

/* --------------------------------- store ----------------------------------- */

type memRow struct {
	status      string // open | closed | deleted
	doc         string
	deletedFrom string
}

// memStore is gen_engine.mjs MemStore: a database that executes a request when it
// arrives and keeps legs with every schema field.
type memStore struct {
	r        *replay
	ids      []string
	rows     map[string]*memRow
	settings map[string]any
	enabled  bool
	idSeq    int
}

var _ Store = (*memStore)(nil)

var hexID = regexp.MustCompile(`^[0-9a-fA-F]{24}$`)

func (m *memStore) put(id string, row *memRow) {
	if _, ok := m.rows[id]; !ok {
		m.ids = append(m.ids, id)
	}
	m.rows[id] = row
}

func decodeTrade(doc string) *Trade {
	var t Trade
	if err := json.Unmarshal([]byte(doc), &t); err != nil {
		panic(fmt.Sprintf("memStore: bad doc %v: %s", err, doc))
	}
	return &t
}

func (m *memStore) read(id string) *StoredTrade {
	if !hexID.MatchString(id) {
		return nil
	}
	row := m.rows[strings.ToLower(id)]
	if row == nil {
		return nil
	}
	t := decodeTrade(row.doc)
	if row.status != "deleted" {
		t.Status = "closed"
		if row.status == "open" {
			t.Status = "open"
		}
		return &StoredTrade{Trade: t}
	}
	t.Status = "closed"
	from := "closed"
	if row.deletedFrom == "open" {
		from = "open"
	}
	return &StoredTrade{Trade: t, Deleted: true, DeletedFrom: from}
}

func (m *memStore) Enabled() bool {
	m.r.mu.Lock()
	defer m.r.mu.Unlock()
	return m.enabled
}

func (m *memStore) NewID() string {
	m.r.mu.Lock()
	defer m.r.mu.Unlock()
	m.idSeq++
	return fmt.Sprintf("5f%022x", m.idSeq)
}

func (m *memStore) EnsureReady(context.Context) error {
	_, err := m.r.io("store.ensureReady", "[]", func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		return nil, f.failAfter()
	})
	return err
}

func (m *memStore) Get(_ context.Context, id string) (*StoredTrade, error) {
	v, err := m.r.io("store.get", args(id), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		return m.read(id), nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*StoredTrade), nil
}

func (m *memStore) InsertOpen(_ context.Context, t *Trade) (bool, error) {
	v, err := m.r.io("store.insertOpen", args(t), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return false, err
		}
		_, dup := m.rows[t.ID]
		for _, row := range m.rows {
			if row.status == "open" && decodeTrade(row.doc).Underlying == t.Underlying {
				dup = true
			}
		}
		if !dup {
			m.put(t.ID, &memRow{status: "open", doc: stored(t)})
		}
		return dup, f.failAfter()
	})
	return v.(bool), err
}

func (m *memStore) Close(_ context.Context, t *Trade) (bool, error) {
	v, err := m.r.io("store.close", args(t), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return false, err
		}
		won := false
		if row := m.rows[t.ID]; row != nil && row.status == "open" {
			before := decodeTrade(row.doc)
			next := t.Clone()
			next.applyMargin(marginOf(before))
			row.status = "closed"
			row.doc = stored(next)
			won = true
		}
		return won, f.failAfter()
	})
	return v.(bool), err
}

func (m *memStore) SetMargin(_ context.Context, id string, p MarginPatch) error {
	patch := jsjson.RawObject(func(dst []byte) []byte {
		return jsjson.NewObject(dst).Field("margin", p.Margin).Field("margin_source", p.MarginSource).
			Field("margin_hedge_benefit", p.MarginHedgeBenefit).Field("margin_at", p.MarginAt).
			Field("margin_error", p.MarginError).End()
	})
	_, err := m.r.io("store.setMargin", args(id, patch), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		if hexID.MatchString(id) {
			if row := m.rows[strings.ToLower(id)]; row != nil && row.status != "deleted" {
				t := decodeTrade(row.doc)
				t.applyMargin(p)
				row.doc = stored(t)
			}
		}
		return nil, f.failAfter()
	})
	return err
}

func (m *memStore) MarkDeleted(_ context.Context, id, from string, audit DeleteAudit) (bool, error) {
	a := jsjson.RawObject(func(dst []byte) []byte {
		return jsjson.NewObject(dst).Field("reason", audit.Reason).Field("actor", audit.Actor).Field("at", audit.At).End()
	})
	v, err := m.r.io("store.markDeleted", args(id, from, a), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return false, err
		}
		if f != nil && len(f.Value) > 0 {
			var ok bool
			_ = json.Unmarshal(f.Value, &ok)
			return ok, nil
		}
		ok := false
		if hexID.MatchString(id) {
			if row := m.rows[strings.ToLower(id)]; row != nil && row.status == from {
				row.status = "deleted"
				row.deletedFrom = from
				ok = true
			}
		}
		return ok, f.failAfter()
	})
	return v.(bool), err
}

func (m *memStore) LoadOpen(context.Context) ([]*Trade, error) {
	v, err := m.r.io("store.loadOpen", "[]", func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		out := []*Trade{}
		for _, id := range m.ids {
			if m.rows[id].status == "open" {
				out = append(out, m.read(id).Trade)
			}
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].OpenedAt != out[j].OpenedAt {
				return out[i].OpenedAt < out[j].OpenedAt
			}
			return out[i].ID < out[j].ID
		})
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]*Trade), nil
}

func (m *memStore) LoadClosed(_ context.Context, limit int, sinceDay *string) ([]*Trade, error) {
	opts := jsjson.RawObject(func(dst []byte) []byte {
		o := jsjson.NewObject(dst).Field("limit", limit)
		if sinceDay != nil {
			o.Field("sinceDay", *sinceDay)
		}
		return o.End()
	})
	v, err := m.r.io("store.loadClosed", args(opts), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		out := []*Trade{}
		for _, id := range m.ids {
			if m.rows[id].status != "closed" {
				continue
			}
			t := m.read(id).Trade
			if sinceDay != nil && (t.ClosedDay == nil || *t.ClosedDay < *sinceDay) {
				continue
			}
			out = append(out, t)
		}
		at := func(t *Trade) float64 {
			if t.ClosedAt == nil {
				return negInf()
			}
			return float64(*t.ClosedAt)
		}
		sort.SliceStable(out, func(i, j int) bool {
			a, b := at(out[i]), at(out[j])
			if a != b && !(a == negInf() && b == negInf()) {
				return a > b
			}
			return out[i].ID > out[j].ID
		})
		if limit > 0 && len(out) > limit {
			out = out[:limit]
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]*Trade), nil
}

func (m *memStore) LoadSettings(context.Context) (map[string]float64, error) {
	v, err := m.r.io("store.loadSettings", "[]", func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		out := map[string]float64{}
		for _, key := range SettingKeys {
			if n, ok := m.settings[key].(float64); ok && jsFinite(n) {
				out[key] = n
			}
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(map[string]float64), nil
}

func (m *memStore) SaveSettings(_ context.Context, s Settings) error {
	vals := jsjson.RawObject(func(dst []byte) []byte {
		return jsjson.NewObject(dst).Field(SettingMinExpectedNetProfit, s.MinExpectedNetProfit).
			Field(SettingSafetyBuffer, s.SafetyBuffer).Field(SettingMaxOpenPositions, s.MaxOpenPositions).End()
	})
	_, err := m.r.io("store.saveSettings", args(vals), func(f *fault) (any, error) {
		if err := f.failIf(); err != nil {
			return nil, err
		}
		for _, key := range SettingKeys {
			m.settings[key] = s.get(key)
		}
		return nil, f.failAfter()
	})
	return err
}

/* ------------------------------- operations -------------------------------- */

func (r *replay) run() {
	for i := range r.sc.Steps {
		st := &r.sc.Steps[i]
		if !r.step(i, st) {
			r.t.Fatalf("step %d (%s) diverged; later steps are not compared", i, describeStep(st))
		}
	}
	r.t.Logf("%d steps: %d calls, %d settled results (%d HTTP), %d SSE frames, %d status changes compared",
		len(r.sc.Steps), r.nCalls, r.nSettled, r.nHTTP, r.nFrames, r.nStatus)
}

func describeStep(st *goldenStep) string {
	switch st.Op {
	case "call":
		return "call " + st.Name + string(st.Args)
	case "http":
		s := st.Method + " " + st.Path
		if st.Token != nil {
			s += " token=" + *st.Token
		}
		if st.Body != nil {
			s += " body=" + *st.Body
		}
		return "http " + s
	case "advance":
		return fmt.Sprintf("advance %d", st.Ms)
	case "set":
		return "set " + string(st.Set)
	case "release":
		return "release " + st.Kind
	}
	return st.Op
}

// startOp runs fn as a new task; its result is reported once it has finished.
func (r *replay) startOp(kind string, fn func() (string, error)) int {
	r.opSeq++
	op := &replayOp{id: r.opSeq, kind: kind}
	r.mu.Lock()
	r.ops = append(r.ops, op)
	r.mu.Unlock()
	r.sim.start(func() {
		v, err := fn()
		r.mu.Lock()
		defer r.mu.Unlock()
		op.done = true
		if err != nil {
			msg := err.Error()
			op.thrown = &msg
		} else {
			op.ok = &v
		}
	})
	return op.id
}

func (r *replay) step(i int, st *goldenStep) bool {
	opID := 0
	switch st.Op {
	case "boot":
		opID = r.startOp("boot", func() (string, error) { r.eng.Boot(); return "null", nil })
	case "call":
		name, rawArgs := st.Name, st.Args
		opID = r.startOp(name, func() (string, error) { return r.callEngine(name, rawArgs) })
	case "ticks":
		ticks := st.Ticks
		opID = r.startOp("onTicks", func() (string, error) { r.eng.OnTicks(ticks); return "null", nil })
	case "advance":
		r.sim.advance(st.Ms, r.heldKinds())
	case "set":
		r.applySet(st.Set)
	case "release":
		if !r.sim.release(st.Kind) {
			r.t.Errorf("step %d: release %s: nothing pending", i, st.Kind)
			return false
		}
	case "sseAdd":
		name := st.Name
		r.sim.start(func() {
			c, remove := r.eng.addSSEClient()
			r.mu.Lock()
			r.clients[name] = &replayClient{c: c, remove: remove}
			r.clientOrder = append(r.clientOrder, name)
			r.mu.Unlock()
		})
	case "sseRemove":
		r.mu.Lock()
		c := r.clients[st.Name]
		r.mu.Unlock()
		r.sim.start(c.remove)
	case "restart":
		r.sim.dropTimers()
		r.mu.Lock()
		r.clients = map[string]*replayClient{}
		r.clientOrder = nil
		r.mu.Unlock()
		r.newEngine()
	case "http":
		st := st
		opID = r.startOp("http", func() (string, error) { return r.doHTTP(st), nil })
	default:
		r.t.Errorf("step %d: unknown op %q", i, st.Op)
		return false
	}
	if opID != 0 && st.OpID != opID {
		r.t.Errorf("step %d: op id %d, golden %d", i, opID, st.OpID)
		return false
	}
	return r.record(i, st)
}

func (r *replay) heldKinds() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := map[string]bool{}
	for k, v := range r.held {
		h[k] = v
	}
	return h
}

func nan() float64    { var z float64; return z / z }
func negInf() float64 { var z float64; return -1 / z }

// callEngine runs one engine method and returns `JSON.stringify(result ?? null)`.
func (r *replay) callEngine(name string, rawArgs json.RawMessage) (string, error) {
	var a []json.RawMessage
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &a); err != nil {
			return "", err
		}
	}
	str := func(i int) string {
		var s string
		if i < len(a) {
			_ = json.Unmarshal(a[i], &s)
		}
		return s
	}
	num := func(i int) *float64 {
		if i >= len(a) {
			return nil
		}
		var f float64
		if json.Unmarshal(a[i], &f) != nil {
			return nil
		}
		return &f
	}
	e := r.eng
	okErr := func(msg string) string {
		if msg == "" {
			return `{"ok":true}`
		}
		return `{"ok":false,"error":` + string(jsjson.Marshal(msg)) + `}`
	}
	switch name {
	case "getStatus":
		return string(jsjson.Marshal(e.GetStatus())), nil
	case "start":
		_, msg := e.Start()
		return okErr(msg), nil
	case "stop":
		e.Stop()
		return "null", nil
	case "dispose":
		e.Dispose()
		return "null", nil
	case "getChain":
		return string(jsjson.Marshal(e.GetChain(str(0)))), nil
	case "getOpportunities":
		return string(jsjson.Marshal(e.GetOpportunities(num(0)))), nil
	case "getOpenPositions":
		return string(jsjson.Marshal(e.GetOpenPositions())), nil
	case "getHistory":
		limit := 0
		if n := num(1); n != nil {
			limit = int(*n)
		}
		v, err := e.GetHistory(str(0), limit)
		if err != nil {
			return "", err
		}
		return string(jsjson.Marshal(v)), nil
	case "invalidateNamespace":
		e.InvalidateNamespace()
		return "null", nil
	case "invalidateBooks":
		e.InvalidateBooks()
		return "null", nil
	case "reloadUniverse":
		if err := e.ReloadUniverse(context.Background()); err != nil {
			return "", err
		}
		return "null", nil
	case "yieldToBox":
		n := 0.0
		if p := num(0); p != nil {
			n = *p
		}
		e.YieldToBox(n)
		return "null", nil
	case "tokenBudget":
		return string(jsjson.Marshal(e.TokenBudget())), nil
	case "setStrikeLevel":
		var v any
		if len(a) > 0 {
			_ = json.Unmarshal(a[0], &v)
		}
		return okErr(e.SetStrikeLevel(v)), nil
	}
	return "", fmt.Errorf("callEngine: unknown method %s", name)
}

func (r *replay) role(token string) auth.Role {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.w.sessions[token]
}

func (r *replay) routes() http.Handler {
	if r.handler == nil {
		eng := r.eng
		r.handler = server.New(server.Options{FrontendOrigin: "http://localhost:5173", Now: r.sim.nowTime},
			func(rt chi.Router) { Register(rt, eng, RouteDeps{Role: r.role, Now: r.sim.nowTime}) })
	}
	return r.handler
}

// doHTTP serves one request through the real router and returns the generator's
// `JSON.stringify({status, body, retry_after?})`.
func (r *replay) doHTTP(st *goldenStep) string {
	var body *strings.Reader
	if st.Body != nil {
		body = strings.NewReader(*st.Body)
	} else {
		body = strings.NewReader("")
	}
	req := httptest.NewRequest(st.Method, st.Path, body)
	req.RemoteAddr = "127.0.0.1:50000"
	if st.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if st.Token != nil {
		req.Header.Set("X-Admin-Token", *st.Token)
	}
	if st.Xff != nil {
		req.Header.Set("X-Forwarded-For", *st.Xff)
	}
	rec := httptest.NewRecorder()
	r.routes().ServeHTTP(rec, req)
	o := jsjson.NewObject(nil).Field("status", rec.Code).Field("body", rec.Body.String())
	if v := rec.Header().Get("Retry-After"); v != "" {
		o.Field("retry_after", v)
	}
	return string(o.End())
}

// applySet changes the world, the store or the I/O script, key by key in order.
func (r *replay) applySet(raw json.RawMessage) {
	v, err := jsjson.Parse(raw)
	if err != nil {
		r.t.Fatalf("set: %v", err)
	}
	obj := v.(*jsjson.Object)
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, k := range obj.Keys() {
		val, _ := obj.Get(k)
		sub := jsjson.Marshal(val)
		switch k {
		case "auth":
			r.w.auth = val.(bool)
		case "marketOpen":
			if val == nil {
				r.w.marketOpen = nil
			} else {
				b := val.(bool)
				r.w.marketOpen = &b
			}
		case "switching":
			r.w.switching = val.(bool)
		case "generation":
			r.w.generation = int64(val.(float64))
		case "broker":
			r.w.broker = val.(string)
		case "rf":
			if val == nil {
				r.w.rf = nil
			} else {
				f := val.(float64)
				r.w.rf = &f
			}
		case "universe":
			r.w.universe = val.(string)
		case "marginDefault":
			r.w.marginDefault = sub
		case "boxLane":
			var l laneJSON
			_ = json.Unmarshal(sub, &l)
			r.w.boxLane = BoxLaneUsage{Running: l.Running, HeldTokens: l.HeldTokens, Budget: l.Budget}
		case "storeEnabled":
			r.store.enabled = val.(bool)
		case "rest":
			var m map[string]*restQuote
			_ = json.Unmarshal(sub, &m)
			for tok, q := range m {
				var t int64
				fmt.Sscan(tok, &t)
				if q == nil {
					delete(r.w.rest, t)
				} else {
					r.w.rest[t] = *q
				}
			}
		case "faults":
			var m map[string][]*fault
			_ = json.Unmarshal(sub, &m)
			// Object.entries order: keep the generator's key order.
			fo := val.(*jsjson.Object)
			for _, kind := range fo.Keys() {
				r.faults[kind] = append(r.faults[kind], m[kind]...)
			}
		case "hold":
			var kinds []string
			_ = json.Unmarshal(sub, &kinds)
			for _, kind := range kinds {
				r.held[kind] = true
			}
		case "unhold":
			var kinds []string
			_ = json.Unmarshal(sub, &kinds)
			for _, kind := range kinds {
				delete(r.held, kind)
			}
		case "settings":
			var m map[string]any
			_ = json.Unmarshal(sub, &m)
			for key, v := range m {
				r.store.settings[key] = v
			}
		case "seedRows":
			var rows []struct {
				Doc         string  `json:"doc"`
				Status      string  `json:"status"`
				DeletedFrom *string `json:"deleted_from"`
			}
			_ = json.Unmarshal(sub, &rows)
			for _, row := range rows {
				t := decodeTrade(row.Doc)
				from := ""
				if row.DeletedFrom != nil {
					from = *row.DeletedFrom
				}
				r.store.put(t.ID, &memRow{status: row.Status, doc: stored(t), deletedFrom: from})
			}
		case "externalClose":
			fo := val.([]any)
			for _, item := range fo {
				ev := item.(*jsjson.Object)
				idv, _ := ev.Get("id")
				fields, _ := ev.Get("fields")
				id := idv.(string)
				row := r.store.rows[id]
				docv, err := jsjson.Parse([]byte(row.doc))
				if err != nil {
					r.t.Fatalf("externalClose: %v", err)
				}
				doc := docv.(*jsjson.Object)
				fobj := fields.(*jsjson.Object)
				for _, fk := range fobj.Keys() {
					fv, _ := fobj.Get(fk)
					doc.Set(fk, fv)
				}
				row.status = "closed"
				row.doc = stored(decodeTrade(string(jsjson.Marshal(doc))))
			}
		case "externalDelete":
			var ids []string
			_ = json.Unmarshal(sub, &ids)
			for _, id := range ids {
				row := r.store.rows[id]
				row.deletedFrom = row.status
				row.status = "deleted"
			}
		default:
			r.t.Fatalf("set: unknown key %s", k)
		}
	}
}

/* --------------------------------- record ---------------------------------- */

func (r *replay) record(i int, st *goldenStep) bool {
	r.sim.settle(r.heldKinds())
	if f := r.sim.takeFailures(); len(f) > 0 {
		r.t.Errorf("step %d (%s): runtime failures:\n%s", i, describeStep(st), strings.Join(f, "\n"))
		return false
	}
	ok := true
	bad := func(what, got, want string) {
		ok = false
		r.t.Errorf("step %d (%s): %s differs:\n%s", i, describeStep(st), what, diffText(got, want))
	}

	r.mu.Lock()
	calls := r.log
	r.log = nil
	r.mu.Unlock()
	if g, w := strings.Join(calls, "\n"), strings.Join(st.Out.Calls, "\n"); g != w {
		bad("calls", g, w)
	}
	r.nCalls += len(st.Out.Calls)

	frames := map[string]goldenFrames{}
	r.mu.Lock()
	order := append([]string(nil), r.clientOrder...)
	r.mu.Unlock()
	for _, name := range order {
		r.mu.Lock()
		c := r.clients[name]
		r.mu.Unlock()
		if c == nil {
			continue
		}
		var fs []string
		for _, f := range c.c.take() {
			fs = append(fs, string(f))
		}
		ended := c.ended || isClosed(c.c.ended)
		if len(fs) > 0 || ended != c.reportedEnded {
			if fs == nil {
				fs = []string{}
			}
			frames[name] = goldenFrames{Frames: fs, Ended: ended}
			c.reportedEnded = ended
		}
	}
	wantFrames := st.Out.Frames
	if wantFrames == nil {
		wantFrames = map[string]goldenFrames{}
	}
	for _, name := range unionKeys(frames, wantFrames) {
		g, w := frames[name], wantFrames[name]
		if g.Frames == nil {
			g.Frames = []string{}
		}
		if w.Frames == nil {
			w.Frames = []string{}
		}
		if g.Ended != w.Ended {
			bad("stream "+name+" ended", fmt.Sprint(g.Ended), fmt.Sprint(w.Ended))
		}
		if gs, ws := strings.Join(g.Frames, "\x00"), strings.Join(w.Frames, "\x00"); gs != ws {
			bad(fmt.Sprintf("stream %s frames (%d vs %d)", name, len(g.Frames), len(w.Frames)), gs, ws)
		}
		r.nFrames += len(w.Frames)
	}

	var settled []string
	r.mu.Lock()
	var keep []*replayOp
	for _, op := range r.ops {
		if !op.done {
			keep = append(keep, op)
			continue
		}
		o := jsjson.NewObject(nil).Field("op", op.id).Field("kind", op.kind)
		if op.thrown != nil {
			o.Field("throw", *op.thrown)
		} else {
			o.Field("ok", *op.ok)
		}
		settled = append(settled, string(o.End()))
	}
	r.ops = keep
	r.mu.Unlock()
	var wantSettled []string
	for _, s := range st.Out.Settled {
		o := jsjson.NewObject(nil).Field("op", s.Op).Field("kind", s.Kind)
		if s.Throw != nil {
			o.Field("throw", *s.Throw)
		} else if s.Ok != nil {
			o.Field("ok", *s.Ok)
		}
		wantSettled = append(wantSettled, string(o.End()))
	}
	if g, w := strings.Join(settled, "\n"), strings.Join(wantSettled, "\n"); g != w {
		bad("settled results", g, w)
	}
	r.nSettled += len(wantSettled)
	for _, s := range st.Out.Settled {
		if s.Kind == "http" {
			r.nHTTP++
		}
	}
	if st.Out.Status != nil {
		r.nStatus++
	}

	compareState := func(what string, got string, golden *string, last *string) {
		want := *last
		if golden != nil {
			want = *golden
		}
		*last = want
		if got != want {
			bad(what, got, want)
		}
	}
	compareState("status", string(jsjson.Marshal(r.eng.GetStatus())), st.Out.Status, &r.last.status)
	compareState("open positions", string(jsjson.Marshal(r.eng.GetOpenPositions())), st.Out.Open, &r.last.open)
	compareState("opportunity digest", r.oppsDigest(), st.Out.Opps, &r.last.opps)
	if st.Out.Published != nil {
		if g := string(jsjson.Marshal(r.eng.GetOpportunities(nil))); g != *st.Out.Published {
			bad("published opportunities", g, *st.Out.Published)
		}
	}
	if st.Out.Full != nil {
		r.eng.lock()
		g := string(jsjson.Marshal(r.eng.opportunities))
		r.eng.unlock()
		if g != *st.Out.Full {
			bad("full opportunity list", g, *st.Out.Full)
		}
	}
	wantPending := st.Out.Pending
	if wantPending == nil {
		wantPending = []string{}
	}
	if g, w := strings.Join(r.sim.pendingKinds(), ","), strings.Join(wantPending, ","); g != w {
		bad("pending calls", g, w)
	}
	return ok
}

func (r *replay) oppsDigest() string {
	r.eng.lock()
	defer r.eng.unlock()
	rows := make([]any, len(r.eng.opportunities))
	for i, o := range r.eng.opportunities {
		rows[i] = []any{o.Key, o.Status, o.Reject, o.EntryBlocked, o.ExpectedNetProfit, o.PositionID}
	}
	return string(jsjson.Marshal(rows))
}

func isClosed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func unionKeys(a, b map[string]goldenFrames) []string {
	seen := map[string]bool{}
	var out []string
	for k := range a {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for k := range b {
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// diffText shows where two texts first differ.
func diffText(got, want string) string {
	n := 0
	for n < len(got) && n < len(want) && got[n] == want[n] {
		n++
	}
	lo := max(0, n-160)
	cut := func(s string) string {
		hi := min(len(s), n+240)
		if lo > len(s) {
			return ""
		}
		return s[lo:hi]
	}
	return fmt.Sprintf("  first difference at byte %d (got %d bytes, want %d)\n  got:  …%s…\n  want: …%s…", n, len(got), len(want), cut(got), cut(want))
}
