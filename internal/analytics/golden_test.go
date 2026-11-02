package analytics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/brokers"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/config"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// The golden comes from testdata/gen_analytics.mjs, which runs the ORIGINAL analytics
// segments of src/index.ts (copied verbatim by testdata/harness.mjs) through scripted
// scenarios. Every operation is replayed here against the Go service: broker calls are
// served from the recorded tape (and must be asked for with the same arguments), and the
// pacing delays, analytics log lines, cache commands, route responses and state snapshots
// must match the recorded JSON byte for byte.

type analyticsGolden struct {
	ExtraSessionDays string                         `json:"extraSessionDays"`
	Universes        map[string][]market.Instrument `json:"universes"`
	Pure             []pureCase                     `json:"pure"`
	Scenarios        []goldenScenario               `json:"scenarios"`
}

type pureCase struct {
	Fn     string            `json:"fn"`
	Args   []json.RawMessage `json:"args"`
	Result json.RawMessage   `json:"result"`
}

type goldenScenario struct {
	Name       string            `json:"name"`
	StartClock int64             `json:"startClock"`
	Ops        []json.RawMessage `json:"ops"`
	Steps      []goldenStep      `json:"steps"`
}

type goldenStep struct {
	Calls  []tapeEntry       `json:"calls"`
	Delays []int64           `json:"delays"`
	Logs   []string          `json:"logs"`
	Redis  []json.RawMessage `json:"redis"`
	Result json.RawMessage   `json:"result"`
}

type tapeEntry struct {
	Fn     string          `json:"fn"`
	Args   json.RawMessage `json:"args"`
	Result json.RawMessage `json:"result"`
	Error  *string         `json:"error"`
	Status *int            `json:"status"`
}

var (
	goldenOnce sync.Once
	goldenData *analyticsGolden
	goldenErr  error
)

func loadAnalyticsGolden(t *testing.T) *analyticsGolden {
	t.Helper()
	goldenOnce.Do(func() {
		raw, err := os.ReadFile(filepath.Join("testdata", "analytics.golden.json"))
		if err != nil {
			goldenErr = fmt.Errorf("%v (regenerate: TZ=UTC scratch/go-migration/check.sh node --experimental-strip-types internal/analytics/testdata/gen_analytics.mjs)", err)
			return
		}
		var g analyticsGolden
		if err := json.Unmarshal(raw, &g); err != nil {
			goldenErr = err
			return
		}
		goldenData = &g
	})
	if goldenErr != nil {
		t.Fatal(goldenErr)
	}
	return goldenData
}

// gnum decodes a golden number, including {"$num": "NaN"}.
func gnum(raw json.RawMessage) float64 {
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f
	}
	var o struct {
		Num string `json:"$num"`
	}
	if err := json.Unmarshal(raw, &o); err == nil {
		switch o.Num {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		}
	}
	panic("bad golden number " + string(raw))
}

func js(v any) string { return string(jsjson.Marshal(v)) }

// sameJSON compares Go's JSON text with the golden's, reporting the first difference.
func sameJSON(t *testing.T, what string, got []byte, want json.RawMessage) bool {
	t.Helper()
	if bytes.Equal(got, want) {
		return true
	}
	g, w := string(got), string(want)
	i := 0
	for i < len(g) && i < len(w) && g[i] == w[i] {
		i++
	}
	lo := max(0, i-160)
	t.Errorf("%s differs at byte %d:\n got: …%s\nwant: …%s", what, i, clip(g[lo:], 400), clip(w[lo:], 400))
	return false
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func decodePoints(t *testing.T, raw json.RawMessage) []*OiAggPoint {
	t.Helper()
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		t.Fatal(err)
	}
	out := make([]*OiAggPoint, 0, len(arr))
	for _, r := range arr {
		p, ok := decodeOiPoint(string(r))
		if !ok {
			t.Fatalf("bad point %s", r)
		}
		out = append(out, p)
	}
	return out
}

func decodeFutPoints(t *testing.T, raw json.RawMessage) []*FutOiPoint {
	t.Helper()
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		t.Fatal(err)
	}
	out := make([]*FutOiPoint, 0, len(arr))
	for _, r := range arr {
		p, ok := decodeFutPoint(string(r))
		if !ok {
			t.Fatalf("bad futures point %s", r)
		}
		out = append(out, p)
	}
	return out
}

func pointValues(ps []*OiAggPoint) []OiAggPoint {
	out := make([]OiAggPoint, len(ps))
	for i, p := range ps {
		out[i] = *p
	}
	return out
}

// ---------------------------------------------------------------------------
// Pure helpers.

func TestAnalyticsPureGolden(t *testing.T) {
	g := loadAnalyticsGolden(t)
	s := New(Deps{ExtraSessionDays: config.Load(config.MapGetter(map[string]string{"EXTRA_SESSION_DAYS": g.ExtraSessionDays})).ExtraSessionDays})
	counts := map[string]int{}
	for i, c := range g.Pure {
		counts[c.Fn]++
		arg := func(k int) json.RawMessage { return c.Args[k] }
		i64 := func(k int) int64 { return int64(gnum(arg(k))) }
		var got []byte
		switch c.Fn {
		case "istDayKey":
			got = jsjson.Marshal(istDayKey(i64(0)))
		case "istDateTime":
			got = jsjson.Marshal(istDateTime(i64(0)))
		case "istTimeOnDayMs":
			got = jsjson.Marshal(istTimeOnDayMs(i64(0), i64(1)))
		case "sessionOpenMs":
			got = jsjson.Marshal(sessionOpenMs(i64(0)))
		case "sessionCloseMs":
			got = jsjson.Marshal(sessionCloseMs(i64(0)))
		case "isPreOpenBucket":
			got = jsjson.Marshal(isPreOpenBucket(i64(0)))
		case "bucketEndMs":
			got = jsjson.Marshal(bucketEndMs(i64(0), i64(1)))
		case "candleEndMs":
			got = jsjson.Marshal(candleEndMs(i64(0), i64(1)))
		case "isIstMarketHours":
			got = jsjson.Marshal(s.isIstMarketHours(i64(0)))
		case "isQuoteFromToday":
			var stamp *string
			_ = json.Unmarshal(arg(0), &stamp)
			st := ""
			if stamp != nil {
				st = *stamp
			}
			switch quoteDay(st, i64(1)) {
			case 1:
				got = []byte("true")
			case 0:
				got = []byte("false")
			default:
				got = []byte("null")
			}
		case "nearestStrikeIndex", "pinStrikeWindow":
			var lad []float64
			_ = json.Unmarshal(arg(0), &lad)
			spot := gnum(arg(1))
			if c.Fn == "nearestStrikeIndex" {
				got = jsjson.Marshal(nearestStrikeIndex(lad, spot))
			} else if w := pinStrikeWindow(lad, spot); w != nil {
				got = jsjson.NewObject(nil).Field("lo", w.lo).Field("hi", w.hi).End()
			} else {
				got = []byte("null")
			}
		case "parseFrameKey":
			raw := "5m"
			var v any
			_ = json.Unmarshal(arg(0), &v)
			switch x := v.(type) {
			case string:
				raw = x
			case []any:
				parts := make([]string, len(x))
				for k, e := range x {
					parts[k] = e.(string)
				}
				raw = strings.Join(parts, ",")
			}
			got = jsjson.Marshal(frames[parseFrameKey(raw)].Key)
		case "coarsenSourceFor":
			var key string
			_ = json.Unmarshal(arg(0), &key)
			if src := coarsenSource[parseFrameKey(key)]; src >= 0 {
				got = jsjson.Marshal(frames[src].Key)
			} else {
				got = []byte("null")
			}
		case "frameTtlSec":
			var key string
			_ = json.Unmarshal(arg(0), &key)
			got = jsjson.Marshal(frameTtlSec(frames[parseFrameKey(key)]))
		case "maxFrameRetentionMs":
			got = jsjson.Marshal(maxFrameRetentionMs())
		case "candleTime":
			var stamp string
			_ = json.Unmarshal(arg(0), &stamp)
			if ms, ok := parseCandleTime(stamp, time.UTC); ok {
				got = jsjson.Marshal(ms)
			} else {
				got = []byte(`{"$num":"NaN"}`)
			}
		case "niftyNearestExpiryOptions":
			var name string
			_ = json.Unmarshal(arg(0), &name)
			uni := g.Universes[name]
			if name == "noSpot" {
				for _, in := range g.Universes["wide"] {
					if in.Segment != "INDICES" {
						uni = append(uni, in)
					}
				}
			}
			sel := niftyNearestExpiryOptions(uni, istDayKey(i64(1)))
			if sel == nil {
				got = []byte("null")
				break
			}
			meta := make([]any, len(sel.meta.keys))
			for k, tok := range sel.meta.keys {
				m := sel.meta.m[tok]
				meta[k] = []any{tok, m.strike, m.typ}
			}
			got = jsjson.NewObject(nil).Field("expiry", sel.expiry).Field("spotToken", sel.spotToken).Field("meta", meta).
				Field("ids", sel.ids).Field("spotId", sel.spotID).End()
		case "completedBuckets":
			pts := decodePoints(t, arg(0))
			n := completedCount(pts, oiStamp, i64(1))
			got = jsjson.Marshal(pointValues(pts[:n]))
		case "collapseToBuckets":
			pts := decodePoints(t, arg(0))
			m := collapseToBuckets(pts, oiStamp, i64(1), i64(2))
			entries := []any{}
			for _, k := range m.Keys() {
				p, _ := m.Get(k)
				entries = append(entries, []any{k, *p})
			}
			got = jsjson.Marshal(entries)
		case "downsampleAgg":
			pts := pointValues(decodePoints(t, arg(0)))
			got = jsjson.Marshal(pointValues(downsampleAgg(pts, i64(1))))
		case "upsertSnapshot":
			var ts []int64
			_ = json.Unmarshal(arg(0), &ts)
			list := []*ChainSnapshot{}
			for _, x := range ts {
				list = append(list, &ChainSnapshot{T: x, Expiry: "old"})
			}
			list = upsertSnapshot(list, &ChainSnapshot{T: i64(1), Expiry: "new"})
			pairs := make([]any, len(list))
			for k, sn := range list {
				pairs[k] = []any{sn.T, sn.Expiry}
			}
			got = jsjson.Marshal(pairs)
		default:
			t.Fatalf("pure case %d: unknown fn %s", i, c.Fn)
		}
		if !bytes.Equal(got, c.Result) {
			t.Errorf("pure %d %s(%s) = %s, want %s", i, c.Fn, joinRaw(c.Args), got, c.Result)
		}
	}
	t.Logf("pure cases: %v", counts)
}

func joinRaw(args []json.RawMessage) string {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = clip(string(a), 80)
	}
	return strings.Join(parts, ", ")
}

// ---------------------------------------------------------------------------
// Scenarios.

type replay struct {
	t      *testing.T
	g      *analyticsGolden
	s      *Service
	clock  atomic.Int64
	cache  *fakeCache
	timers *fakeTimers
	router chi.Router

	mu           sync.Mutex
	broker       brokers.ID
	token        *string
	ready        bool
	problems     []string
	universe     string
	universeFail *string
	tape         []tapeEntry
	used         []bool
	tapeErrs     []string
	delays       []int64
	logs         []string
	bodies       [][]any
}

var analyticsLog = regexp.MustCompile(`^\[(OptionOI|FuturesOI|Capture)\]`)

func newReplay(t *testing.T, g *analyticsGolden, start int64) *replay {
	r := &replay{t: t, g: g, broker: brokers.Zerodha, ready: true, problems: []string{}, universe: "wide", timers: &fakeTimers{}}
	tok := "access-token"
	r.token = &tok
	r.clock.Store(start)
	r.cache = newFakeCache(func() int64 { return r.clock.Load() }, func(cmd []any) {
		r.mu.Lock()
		r.bodies = append(r.bodies, []any{cmd})
		r.mu.Unlock()
	})
	logf := func(format string, args ...any) {
		line := fmt.Sprintf(format, args...)
		if analyticsLog.MatchString(line) {
			r.mu.Lock()
			r.logs = append(r.logs, line)
			r.mu.Unlock()
		}
	}
	r.s = New(Deps{
		Instruments: func(ctx context.Context) ([]market.Instrument, error) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if r.universeFail != nil {
				return nil, errors.New(*r.universeFail)
			}
			return g.Universes[r.universe], nil
		},
		QuoteFull: func(ctx context.Context, ids []string) ([]kite.FullQuote, error) {
			var out []kite.FullQuote
			err := r.call("quoteFull", jsjson.NewObject(nil).Field("ids", ids).End(), &out)
			return out, err
		},
		Historical: func(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.ClosePoint, error) {
			var out []kite.ClosePoint
			err := r.call("historical", histArgs(token, from, to, interval, prio), &out)
			return out, err
		},
		HistoricalOiSeries: func(ctx context.Context, token int64, from, to, interval string, prio kite.HistoricalPriority) ([]kite.OISeriesPoint, error) {
			var out []kite.OISeriesPoint
			err := r.call("historicalOiSeries", histArgs(token, from, to, interval, prio), &out)
			return out, err
		},
		QuotesByToken: func(ctx context.Context, tokens []int64) ([]market.Tick, error) {
			var out []market.Tick
			err := r.call("quotesByToken", jsjson.NewObject(nil).Field("tokens", tokens).End(), &out)
			return out, err
		},
		CaptureAllowed: ZerodhaCaptureGate(
			func() brokers.ID { r.mu.Lock(); defer r.mu.Unlock(); return r.broker },
			func() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.token != nil },
			logf),
		MarketData: func() Readiness {
			r.mu.Lock()
			defer r.mu.Unlock()
			return Readiness{Ready: r.ready, Broker: r.broker, Problems: r.problems}
		},
		Cache:            r.cache,
		ExtraSessionDays: config.Load(config.MapGetter(map[string]string{"EXTRA_SESSION_DAYS": g.ExtraSessionDays})).ExtraSessionDays,
		Now:              func() time.Time { return time.UnixMilli(r.clock.Load()) },
		AfterFunc:        r.timers.afterFunc,
		Sleep: func(ctx context.Context, d time.Duration) error {
			r.mu.Lock()
			r.delays = append(r.delays, d.Milliseconds())
			r.mu.Unlock()
			return ctx.Err()
		},
		Logf: logf,
	})
	r.s.onFlushOps = func(ops []cacheOp) {
		body := make([]any, len(ops))
		for i, op := range ops {
			body[i] = redisCommand(op)
		}
		r.mu.Lock()
		r.bodies = append(r.bodies, body)
		r.mu.Unlock()
	}
	r.router = chi.NewRouter()
	r.s.Mount(r.router)
	return r
}

// redisCommand is the Upstash command Node would have sent for op.
func redisCommand(op cacheOp) []any {
	key := "calspread:" + op.Key
	switch op.Kind {
	case "HSET", "HDEL":
		cmd := []any{op.Kind, key}
		for _, f := range op.Fields {
			cmd = append(cmd, f)
		}
		return cmd
	case "EXPIRE":
		return []any{"EXPIRE", key, op.TTL}
	case "SET":
		if op.TTL > 0 {
			return []any{"SET", key, op.Value, "EX", op.TTL}
		}
		return []any{"SET", key, op.Value}
	}
	return []any{op.Kind, key}
}

func histArgs(token int64, from, to, interval string, prio kite.HistoricalPriority) []byte {
	return jsjson.NewObject(nil).Field("token", token).Field("from", from).Field("to", to).Field("interval", interval).Field("prio", string(prio)).End()
}

// call serves a broker call from the op's tape: the first unused entry with the same
// function and arguments.
func (r *replay) call(fn string, args []byte, out any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, e := range r.tape {
		if r.used[i] || e.Fn != fn || !bytes.Equal(e.Args, args) {
			continue
		}
		r.used[i] = true
		if e.Error != nil {
			if e.Status != nil {
				return &kite.KiteError{Status: *e.Status, Message: *e.Error}
			}
			return errors.New(*e.Error)
		}
		if err := json.Unmarshal(e.Result, out); err != nil {
			r.tapeErrs = append(r.tapeErrs, fmt.Sprintf("decode %s result: %v", fn, err))
		}
		return nil
	}
	r.tapeErrs = append(r.tapeErrs, fmt.Sprintf("unexpected call %s(%s)", fn, clip(string(args), 200)))
	return errors.New("replay: unexpected call")
}

type goldenOp struct {
	Op       string                     `json:"op"`
	T        int64                      `json:"t"`
	Ms       int64                      `json:"ms"`
	N        int                        `json:"n"`
	Set      map[string]json.RawMessage `json:"set"`
	Key      string                     `json:"key"`
	Family   string                     `json:"family"`
	Points   json.RawMessage            `json:"points"`
	Fields   [][2]string                `json:"fields"`
	Value    json.RawMessage            `json:"value"`
	TTLSec   int64                      `json:"ttlSec"`
	Minute   json.RawMessage            `json:"minute"`
	Hour     json.RawMessage            `json:"hour"`
	Agg      json.RawMessage            `json:"agg"`
	Point    json.RawMessage            `json:"point"`
	Unseeded []int64                    `json:"unseeded"`
	Cutoff   int64                      `json:"cutoff"`
	Now      int64                      `json:"now"`
	From     *int64                     `json:"from"`
	Universe string                     `json:"universe"`
	Which    string                     `json:"which"`
	What     string                     `json:"what"`
	Path     string                     `json:"path"`
	Query    *string                    `json:"query"`
	Parts    []string                   `json:"parts"`
	During   []json.RawMessage          `json:"during"`
}

func TestAnalyticsScenarioGolden(t *testing.T) {
	g := loadAnalyticsGolden(t)
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			r := newReplay(t, g, sc.StartClock)
			defer func() { _ = r.s.Stop(context.Background()) }()
			for i, raw := range sc.Ops {
				var op goldenOp
				if err := json.Unmarshal(raw, &op); err != nil {
					t.Fatal(err)
				}
				if !r.step(i, op, raw, sc.Steps[i]) {
					t.Fatalf("stopping at op %d %s", i, clip(string(raw), 200))
				}
			}
		})
	}
}

func (r *replay) step(i int, op goldenOp, raw json.RawMessage, want goldenStep) bool {
	t := r.t
	t.Helper()
	r.mu.Lock()
	r.tape = want.Calls
	r.used = make([]bool, len(want.Calls))
	r.tapeErrs = nil
	r.delays = nil
	r.logs = nil
	r.bodies = nil
	r.mu.Unlock()

	result := r.run(op)
	r.s.wg.Wait()

	ok := true
	label := fmt.Sprintf("op %d %s", i, clip(string(raw), 160))
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.tapeErrs {
		t.Errorf("%s: %s", label, e)
		ok = false
	}
	for k, u := range r.used {
		if !u {
			t.Errorf("%s: recorded call not made: %s(%s)", label, want.Calls[k].Fn, clip(string(want.Calls[k].Args), 200))
			ok = false
		}
	}
	if js(r.delays) != js(orEmpty(want.Delays)) {
		t.Errorf("%s: delays %v, want %v", label, r.delays, want.Delays)
		ok = false
	}
	if js(r.logs) != js(orEmptyS(want.Logs)) {
		t.Errorf("%s: logs\n got %q\nwant %q", label, r.logs, want.Logs)
		ok = false
	}
	wantBodies := []byte("[" + string(bytes.Join(rawList(want.Redis), []byte(","))) + "]")
	if !sameJSON(t, label+": cache commands", jsjson.Marshal(r.bodies), wantBodies) {
		ok = false
	}
	if want.Result != nil || result != nil {
		w := want.Result
		if w == nil {
			w = json.RawMessage("null")
		}
		if !sameJSON(t, label+": result", result, w) {
			ok = false
		}
	}
	return ok
}

func rawList(rs []json.RawMessage) [][]byte {
	out := make([][]byte, len(rs))
	for i, r := range rs {
		out[i] = r
	}
	return out
}

func orEmpty(v []int64) []int64 {
	if v == nil {
		return []int64{}
	}
	return v
}

func orEmptyS(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func (r *replay) frameIndex(key string) int {
	for i, f := range frames {
		if f.Key == key {
			return i
		}
	}
	r.t.Fatalf("unknown frame %q", key)
	return -1
}

// run executes one op and returns its JSON result (nil when it has none).
func (r *replay) run(op goldenOp) []byte {
	t := r.t
	s := r.s
	ctx := s.ctx
	switch op.Op {
	case "clock":
		r.clock.Store(op.T)
	case "advance":
		r.clock.Add(op.Ms)
	case "env":
		r.mu.Lock()
		for k, v := range op.Set {
			switch k {
			case "broker":
				var b string
				_ = json.Unmarshal(v, &b)
				r.broker = brokers.ID(b)
			case "token":
				var tok *string
				_ = json.Unmarshal(v, &tok)
				r.token = tok
			case "ready":
				_ = json.Unmarshal(v, &r.ready)
			case "problems":
				_ = json.Unmarshal(v, &r.problems)
			case "universe":
				_ = json.Unmarshal(v, &r.universe)
			case "universeFail":
				var f *string
				_ = json.Unmarshal(v, &f)
				r.universeFail = f
			case "quotes", "hist", "spotQuote":
				// The fakes' answers come from the tape.
			default:
				t.Fatalf("env: unknown field %s", k)
			}
		}
		r.mu.Unlock()
	case "redisFail":
		r.cache.mu.Lock()
		r.cache.failNext = op.N
		r.cache.mu.Unlock()
	case "redisSeed":
		var value *string
		if op.Value != nil {
			var v string
			_ = json.Unmarshal(op.Value, &v)
			value = &v
		}
		r.cache.seed(op.Key, op.Fields, value, op.TTLSec)
	case "setFrame":
		s.mu.Lock()
		if op.Family == "opt" {
			s.oiFrames[r.frameIndex(op.Key)] = decodePoints(t, op.Points)
		} else {
			s.futFrames[r.frameIndex(op.Key)] = decodeFutPoints(t, op.Points)
		}
		s.mu.Unlock()
	case "setPrevClose":
		pc, ok := decodePrevClose(string(op.Value))
		if !ok {
			t.Fatalf("setPrevClose: bad value %s", op.Value)
		}
		s.mu.Lock()
		s.prevClose = pc
		s.mu.Unlock()
	case "setSnaps":
		s.mu.Lock()
		s.chainMin = r.decodeSnaps(op.Minute)
		s.chainHour = r.decodeSnaps(op.Hour)
		s.mu.Unlock()
	case "setDay":
		s.mu.Lock()
		s.day = r.decodeDay(op.Value)
		s.mu.Unlock()
	case "appendOiFrameLive":
		agg, ok := decodeOiPoint(string(op.Agg))
		if !ok {
			t.Fatalf("bad agg %s", op.Agg)
		}
		s.mu.Lock()
		s.appendOiFrameLiveLocked(op.T, *agg)
		s.mu.Unlock()
	case "appendFutOiFrameLive":
		p, ok := decodeFutPoint(string(op.Point))
		if !ok {
			t.Fatalf("bad point %s", op.Point)
		}
		s.mu.Lock()
		s.appendFutOiFrameLiveLocked(op.T, p.Legs)
		s.mu.Unlock()
	case "mergeOiFrame":
		pts := pointValues(decodePoints(t, op.Points))
		s.mu.Lock()
		s.mergeOiFrameLocked(r.frameIndex(op.Key), pts)
		s.mu.Unlock()
	case "mergeFutOiFrame":
		ps := decodeFutPoints(t, op.Points)
		vals := make([]FutOiPoint, len(ps))
		for i, p := range ps {
			vals[i] = *p
		}
		s.mu.Lock()
		s.mergeFutOiFrameLocked(r.frameIndex(op.Key), vals)
		s.mu.Unlock()
	case "coarsenFrames":
		s.coarsenFrames()
	case "currentWindowAgg":
		var unseeded map[int64]bool
		if op.Unseeded != nil {
			unseeded = map[int64]bool{}
			for _, tok := range op.Unseeded {
				unseeded[tok] = true
			}
		}
		s.mu.Lock()
		agg, ok := s.currentWindowAggLocked(s.day, unseeded)
		s.mu.Unlock()
		if !ok {
			return []byte("null")
		}
		return agg.AppendJS(nil)
	case "recordChainSnapshot":
		s.mu.Lock()
		s.recordChainSnapshotLocked(s.day, op.T)
		s.mu.Unlock()
	case "chainBaselineAt":
		s.mu.Lock()
		snap := s.chainBaselineAtLocked(op.Cutoff, s.nowMs())
		s.mu.Unlock()
		if snap == nil {
			return []byte("null")
		}
		return snap.AppendJS(nil)
	case "chainSnapshotSpan":
		s.mu.Lock()
		oldest, newest := s.chainSnapshotSpanLocked(s.nowMs())
		s.mu.Unlock()
		return jsjson.NewObject(nil).Field("oldest", oldest).Field("newest", newest).End()
	case "oiBackfillFromMs":
		return jsjson.Marshal(s.oiBackfillFromMs(op.Now))
	case "futOiBackfillFromMs":
		return jsjson.Marshal(s.futOiBackfillFromMs(op.Now))
	case "niftyMonthlyFutures":
		s.mu.Lock()
		sel := s.niftyMonthlyFuturesLocked(r.g.Universes[op.Universe], istDayKey(s.nowMs()))
		s.mu.Unlock()
		if sel == nil {
			return []byte("null")
		}
		return jsjson.NewObject(nil).Field("contracts", sel.contracts).Field("ids", sel.ids).End()
	case "captureOptionOi":
		s.captureOptionOi(ctx)
	case "captureFuturesOi":
		s.captureFuturesOi(ctx)
	case "backfillOiFrames":
		s.backfillOiFrames(ctx, op.From)
	case "backfillFutOiFrames":
		s.backfillFutOiFrames(ctx, op.From)
	case "backfillPrevClose":
		s.backfillPrevClose(ctx)
	case "flush":
		s.flush()
	case "warmLoad":
		s.WarmLoad(ctx)
	case "postLogin":
		s.OnKiteLogin()
	case "start":
		s.Start()
	case "fireTimer":
		s.mu.Lock()
		var tm Timer
		switch op.Which {
		case "tick":
			tm = s.tickTimer
		case "flush":
			tm = s.flushTimer
		case "gap":
			tm = s.gapTimer
		}
		s.mu.Unlock()
		ft, _ := tm.(*fakeTimer)
		if ft == nil || ft.fired || ft.stopped {
			t.Fatalf("no pending %s timer", op.Which)
		}
		ft.fired = true
		ft.f()
	case "gate":
		return jsjson.Marshal(s.d.CaptureAllowed(op.What))
	case "route":
		target := op.Path
		if op.Query != nil {
			target += "?" + *op.Query
		}
		rec := httptest.NewRecorder()
		r.router.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
		return jsjson.NewObject(nil).Field("status", rec.Code).Field("body", rec.Body.String()).End()
	case "observe":
		return r.observe(op.Parts)
	case "flushRacing":
		// The flush's synchronous part runs, then the inner ops, then its I/O settles.
		s.mu.Lock()
		b := s.beginFlushLocked(false)
		s.mu.Unlock()
		for _, inner := range op.During {
			var iop goldenOp
			if err := json.Unmarshal(inner, &iop); err != nil {
				t.Fatal(err)
			}
			if iop.Op != "mergeOiFrame" && iop.Op != "appendOiFrameLive" {
				t.Fatalf("flushRacing: unsupported %s", iop.Op)
			}
			r.run(iop)
		}
		if b != nil && s.runFlush(b) {
			s.voidFlush()
		}
	default:
		t.Fatalf("unknown op %s", op.Op)
	}
	return nil
}

func (r *replay) decodeSnaps(raw json.RawMessage) []*ChainSnapshot {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		r.t.Fatal(err)
	}
	out := []*ChainSnapshot{}
	for _, a := range arr {
		sn, ok := decodeSnapshot(string(a))
		if !ok {
			r.t.Fatalf("bad snapshot %s", a)
		}
		out = append(out, sn)
	}
	return out
}

func (r *replay) decodeDay(raw json.RawMessage) *oiDay {
	if string(raw) == "null" {
		return nil
	}
	var d struct {
		Day       string                    `json:"day"`
		Expiry    string                    `json:"expiry"`
		SpotToken int64                     `json:"spotToken"`
		Meta      [][3]json.RawMessage      `json:"meta"`
		Series    [][2]json.RawMessage      `json:"series"`
		Spot      [][2]float64              `json:"spot"`
		Window    *struct{ Lo, Hi float64 } `json:"window"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		r.t.Fatal(err)
	}
	day := &oiDay{day: d.Day, expiry: d.Expiry, spotToken: d.SpotToken, meta: &tokenMeta{}, series: map[int64][]oiSample{}}
	for _, m := range d.Meta {
		var tok int64
		var strike float64
		var typ string
		_ = json.Unmarshal(m[0], &tok)
		_ = json.Unmarshal(m[1], &strike)
		_ = json.Unmarshal(m[2], &typ)
		day.meta.set(tok, optMeta{strike: strike, typ: typ})
	}
	for _, sr := range d.Series {
		var tok int64
		var samples [][3]float64
		_ = json.Unmarshal(sr[0], &tok)
		_ = json.Unmarshal(sr[1], &samples)
		arr := make([]oiSample, len(samples))
		for i, x := range samples {
			arr[i] = oiSample{t: int64(x[0]), oi: x[1], ltp: x[2]}
		}
		day.series[tok] = arr
	}
	for _, sp := range d.Spot {
		day.spot = append(day.spot, spotSample{t: int64(sp[0]), ltp: sp[1]})
	}
	if d.Window != nil {
		day.window = &strikeWindow{lo: d.Window.Lo, hi: d.Window.Hi}
	}
	return day
}

// observe writes the state parts in the generator's layout.
func (r *replay) observe(parts []string) []byte {
	s := r.s
	s.mu.Lock()
	defer s.mu.Unlock()
	o := jsjson.NewObject(nil)
	for _, part := range parts {
		switch part {
		case "frames":
			opt := jsjson.NewObject(nil)
			fut := jsjson.NewObject(nil)
			for i, f := range frames {
				opt.Field(f.Key, pointValues(s.oiFrames[i]))
				fp := make([]FutOiPoint, len(s.futFrames[i]))
				for k, p := range s.futFrames[i] {
					fp[k] = *p
				}
				fut.Field(f.Key, fp)
			}
			o.Field("frames", jsjson.RawObject(func(dst []byte) []byte {
				dst = append(dst, `{"opt":`...)
				dst = append(dst, opt.End()...)
				dst = append(dst, `,"fut":`...)
				dst = append(dst, fut.End()...)
				return append(dst, '}')
			}))
		case "day":
			d := s.day
			if d == nil {
				o.Field("day", nil)
				break
			}
			var win any
			if d.window != nil {
				win = orderedJSON{"lo", d.window.lo, "hi", d.window.hi}
			}
			meta := make([]any, len(d.meta.keys))
			series := []any{}
			for k, tok := range d.meta.keys {
				m := d.meta.m[tok]
				meta[k] = []any{tok, m.strike, m.typ}
				if arr, ok := d.series[tok]; ok {
					smp := make([]any, len(arr))
					for j, x := range arr {
						smp[j] = []any{x.t, x.oi, x.ltp}
					}
					series = append(series, []any{tok, smp})
				}
			}
			spot := make([]any, len(d.spot))
			for k, x := range d.spot {
				spot[k] = []any{x.t, x.ltp}
			}
			o.Field("day", orderedJSON{"day", d.day, "expiry", d.expiry, "spotToken", d.spotToken, "window", win, "meta", meta, "series", series, "spot", spot})
		case "prevClose":
			if s.prevClose == nil {
				o.Field("prevClose", nil)
			} else {
				o.Field("prevClose", s.prevClose)
			}
		case "snaps":
			o.Field("snaps", orderedJSON{"minute", s.chainMin, "hour", s.chainHour})
		case "fut":
			o.Field("fut", orderedJSON{"contracts", orEmptyC(s.futContracts), "known", s.futKnown.Values()})
		case "pending":
			hash := []any{}
			for _, key := range s.pendingHash.Keys() {
				p, _ := s.pendingHash.Get(key)
				entries := []any{}
				for _, f := range p.entries.Keys() {
					v, _ := p.entries.Get(f)
					entries = append(entries, []any{f, string(jsjson.Marshal(v))})
				}
				hash = append(hash, []any{key, orderedJSON{"entries", entries, "stale", orEmptyS(p.stale.Keys()), "ttlSec", p.ttlSec, "maxFields", p.maxFields}})
			}
			plain := []any{}
			for _, key := range s.pendingPlain.Keys() {
				p, _ := s.pendingPlain.Get(key)
				plain = append(plain, []any{key, orderedJSON{"value", string(jsjson.Marshal(p.value)), "ttlSec", p.ttlSec}})
			}
			o.Field("pending", orderedJSON{"hash", hash, "plain", plain})
		case "repairs":
			list := func(m map[string]repairMark) []any {
				keys := make([]string, 0, len(m))
				for k := range m {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				out := []any{}
				for _, k := range keys {
					out = append(out, []any{k, m[k].n, m[k].at})
				}
				return out
			}
			o.Field("repairs", orderedJSON{"partial", list(s.partialRepairs), "head", list(s.headRepairs),
				"prevCloseAttempts", orderedJSON{"day", s.prevCloseAttempts.day, "n", s.prevCloseAttempts.n},
				"closedDayLogged", s.closedDayLogged})
		case "flushState":
			keys := make([]string, 0, len(s.ttlRefreshedAt))
			for k := range s.ttlRefreshedAt {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			ttl := []any{}
			for _, k := range keys {
				ttl = append(ttl, []any{k, s.ttlRefreshedAt[k]})
			}
			o.Field("flushState", orderedJSON{"inFlight", s.flushInFlight, "again", s.flushAgain, "ttl", ttl})
		case "redis":
			o.Field("redis", r.cache.dump())
		case "timers":
			o.Field("timers", r.timers.pending())
		default:
			r.t.Fatalf("observe: unknown part %s", part)
		}
	}
	return o.End()
}

func orEmptyC(v []FutContract) []FutContract {
	if v == nil {
		return []FutContract{}
	}
	return v
}
