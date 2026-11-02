package analytics

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsjson"
)

// OiAggPoint is one frame bucket (index.ts OiAggPoint): total Call/Put OI over the
// session's pinned strike window, the auto-ATM straddle and the spot, stamped with the
// bucket END. WLo/WHi are present only on backfilled (and coarsened/warm-loaded) points;
// Partial marks a reading known to understate the window.
type OiAggPoint struct {
	T        int64
	TotalCe  float64
	TotalPe  float64
	Straddle float64
	Spot     float64
	HasWLo   bool
	WLo      float64
	HasWHi   bool
	WHi      float64
	Partial  bool
}

// AppendJS writes the point with Node's key order: t, totalCe, totalPe, straddle, spot,
// then wLo/wHi when present and partial: 1 when set (both always come last in Node too:
// the bounds are created with the point and `partial` is appended or deleted).
func (p OiAggPoint) AppendJS(dst []byte) []byte {
	o := jsjson.NewObject(dst).
		Field("t", p.T).
		Field("totalCe", p.TotalCe).
		Field("totalPe", p.TotalPe).
		Field("straddle", p.Straddle).
		Field("spot", p.Spot)
	if p.HasWLo {
		o.Field("wLo", p.WLo)
	}
	if p.HasWHi {
		o.Field("wHi", p.WHi)
	}
	if p.Partial {
		o.Field("partial", 1)
	}
	return o.End()
}

// FutOiLeg is one futures contract's OI and price in a point.
type FutOiLeg struct {
	Expiry string  `json:"expiry"`
	OI     float64 `json:"oi"`
	LTP    float64 `json:"ltp"`
}

// FutOiPoint is one futures frame bucket: a leg per tracked contract, nearest first.
type FutOiPoint struct {
	T    int64      `json:"t"`
	Legs []FutOiLeg `json:"legs"`
}

func cloneFut(p *FutOiPoint) *FutOiPoint {
	return &FutOiPoint{T: p.T, Legs: append([]FutOiLeg{}, p.Legs...)}
}

// FutContract is a tracked NIFTY futures contract.
type FutContract struct {
	Token         int64   `json:"token"`
	Tradingsymbol string  `json:"tradingsymbol"`
	Expiry        string  `json:"expiry"`
	LotSize       float64 `json:"lot_size"`
}

// snapTok is one token of a chain snapshot: [oi, ltp].
type snapTok struct {
	Token int64
	OI    float64
	LTP   float64
}

// ChainSnapshot is the per-token OI and LTP of one capture, keyed by bucket end
// (index.ts ChainSnapshot, tokens = {"<token>": [oi, ltp]}). Tokens are kept in
// JavaScript key order.
type ChainSnapshot struct {
	T      int64
	Expiry string
	Tokens []snapTok
}

// AppendJS writes {t, expiry, tokens: {"<token>": [oi, ltp], …}}.
func (c *ChainSnapshot) AppendJS(dst []byte) []byte {
	dst = append(dst, `{"t":`...)
	dst = strconv.AppendInt(dst, c.T, 10)
	dst = append(dst, `,"expiry":`...)
	dst = jsjson.AppendString(dst, c.Expiry)
	dst = append(dst, `,"tokens":{`...)
	for i, t := range c.Tokens {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = jsjson.AppendString(dst, strconv.FormatInt(t.Token, 10))
		dst = append(dst, ":["...)
		dst = jsjson.AppendFloat(dst, t.OI)
		dst = append(dst, ',')
		dst = jsjson.AppendFloat(dst, t.LTP)
		dst = append(dst, ']')
	}
	return append(dst, "}}"...)
}

// OiLtp is one token of the previous-close baseline.
type OiLtp struct {
	OI  float64 `json:"oi"`
	LTP float64 `json:"ltp"`
}

// PrevClose is index.ts OptionPrevClose: the previous session's closing OI and LTP per
// option token, the baseline of the chain's "Day" column.
type PrevClose struct {
	ForDay   string
	ClosedOn string
	Expiry   string
	Complete bool
	// Tokens in JavaScript key order.
	Order  []int64
	Tokens map[int64]OiLtp
}

// AppendJS writes {forDay, closedOn, expiry, complete, tokens}.
func (p *PrevClose) AppendJS(dst []byte) []byte {
	dst = append(dst, `{"forDay":`...)
	dst = jsjson.AppendString(dst, p.ForDay)
	dst = append(dst, `,"closedOn":`...)
	dst = jsjson.AppendString(dst, p.ClosedOn)
	dst = append(dst, `,"expiry":`...)
	dst = jsjson.AppendString(dst, p.Expiry)
	dst = append(dst, `,"complete":`...)
	dst = strconv.AppendBool(dst, p.Complete)
	dst = append(dst, `,"tokens":`...)
	dst = appendTokenObject(dst, p.Order, func(dst []byte, tok int64) []byte {
		v := p.Tokens[tok]
		dst = append(dst, `{"oi":`...)
		dst = jsjson.AppendFloat(dst, v.OI)
		dst = append(dst, `,"ltp":`...)
		dst = jsjson.AppendFloat(dst, v.LTP)
		return append(dst, '}')
	})
	return append(dst, '}')
}

// appendTokenObject writes {"<token>": value, …} for tokens already in JavaScript order.
func appendTokenObject(dst []byte, order []int64, value func([]byte, int64) []byte) []byte {
	dst = append(dst, '{')
	for i, tok := range order {
		if i > 0 {
			dst = append(dst, ',')
		}
		dst = jsjson.AppendString(dst, strconv.FormatInt(tok, 10))
		dst = append(dst, ':')
		dst = value(dst, tok)
	}
	return append(dst, '}')
}

// ---------------------------------------------------------------------------
// Decoding of persisted values (warm load). JSON.parse then the Node filters; a value
// that is not the expected shape is dropped, as a corrupt Redis value was.

// jsTruthyNum is a number's truthiness.
func jsTruthyNum(f float64) bool { return f != 0 && !math.IsNaN(f) }

type oiAggJSON struct {
	T        *float64 `json:"t"`
	TotalCe  float64  `json:"totalCe"`
	TotalPe  float64  `json:"totalPe"`
	Straddle float64  `json:"straddle"`
	Spot     float64  `json:"spot"`
	WLo      *float64 `json:"wLo"`
	WHi      *float64 `json:"wHi"`
	Partial  *float64 `json:"partial"`
}

// decodeOiPoint parses a stored point; ok is false unless it is an object with a numeric t.
func decodeOiPoint(raw string) (*OiAggPoint, bool) {
	var j oiAggJSON
	if err := json.Unmarshal([]byte(raw), &j); err != nil || j.T == nil {
		return nil, false
	}
	p := &OiAggPoint{T: int64(*j.T), TotalCe: j.TotalCe, TotalPe: j.TotalPe, Straddle: j.Straddle, Spot: j.Spot}
	if j.WLo != nil {
		p.HasWLo, p.WLo = true, *j.WLo
	}
	if j.WHi != nil {
		p.HasWHi, p.WHi = true, *j.WHi
	}
	p.Partial = j.Partial != nil && jsTruthyNum(*j.Partial)
	return p, true
}

type futPointJSON struct {
	T    *float64        `json:"t"`
	Legs json.RawMessage `json:"legs"`
}

// decodeFutPoint parses a stored futures point; it needs a numeric t and an array of legs.
func decodeFutPoint(raw string) (*FutOiPoint, bool) {
	var j futPointJSON
	if err := json.Unmarshal([]byte(raw), &j); err != nil || j.T == nil {
		return nil, false
	}
	if len(j.Legs) == 0 || j.Legs[0] != '[' {
		return nil, false
	}
	var legs []FutOiLeg
	if err := json.Unmarshal(j.Legs, &legs); err != nil {
		return nil, false
	}
	if legs == nil {
		legs = []FutOiLeg{}
	}
	return &FutOiPoint{T: int64(*j.T), Legs: legs}, true
}

type snapJSON struct {
	T      *float64              `json:"t"`
	Expiry string                `json:"expiry"`
	Tokens map[string][2]float64 `json:"tokens"`
}

// decodeSnapshot parses a stored chain snapshot; it needs a numeric t.
func decodeSnapshot(raw string) (*ChainSnapshot, bool) {
	var j snapJSON
	if err := json.Unmarshal([]byte(raw), &j); err != nil || j.T == nil {
		return nil, false
	}
	snap := &ChainSnapshot{T: int64(*j.T), Expiry: j.Expiry}
	toks := make([]int64, 0, len(j.Tokens))
	for k := range j.Tokens {
		if n, err := strconv.ParseInt(k, 10, 64); err == nil && strconv.FormatInt(n, 10) == k {
			toks = append(toks, n)
		}
	}
	sort.Slice(toks, func(a, b int) bool { return toks[a] < toks[b] })
	for _, tok := range jsTokenOrder(toks) {
		v := j.Tokens[strconv.FormatInt(tok, 10)]
		snap.Tokens = append(snap.Tokens, snapTok{Token: tok, OI: v[0], LTP: v[1]})
	}
	return snap, true
}

type prevCloseJSON struct {
	ForDay   *string                     `json:"forDay"`
	ClosedOn string                      `json:"closedOn"`
	Expiry   string                      `json:"expiry"`
	Complete bool                        `json:"complete"`
	Tokens   *map[string]json.RawMessage `json:"tokens"`
}

// decodePrevClose parses the stored baseline; ok needs a string forDay and a tokens object.
func decodePrevClose(raw string) (*PrevClose, bool) {
	var j prevCloseJSON
	if err := json.Unmarshal([]byte(raw), &j); err != nil || j.ForDay == nil || j.Tokens == nil {
		return nil, false
	}
	p := &PrevClose{ForDay: *j.ForDay, ClosedOn: j.ClosedOn, Expiry: j.Expiry, Complete: j.Complete, Tokens: map[int64]OiLtp{}}
	var toks []int64
	for k, v := range *j.Tokens {
		n, err := strconv.ParseInt(k, 10, 64)
		if err != nil || strconv.FormatInt(n, 10) != k {
			continue
		}
		var ol OiLtp
		if err := json.Unmarshal(v, &ol); err != nil {
			continue
		}
		p.Tokens[n] = ol
		toks = append(toks, n)
	}
	sort.Slice(toks, func(a, b int) bool { return toks[a] < toks[b] })
	p.Order = jsTokenOrder(toks)
	return p, true
}

type contractJSON struct {
	Token         float64 `json:"token"`
	Tradingsymbol string  `json:"tradingsymbol"`
	Expiry        *string `json:"expiry"`
	LotSize       float64 `json:"lot_size"`
}

// decodeContracts parses futcontracts; entries without a string expiry are skipped.
func decodeContracts(raw string) ([]FutContract, bool) {
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &arr); err != nil || arr == nil {
		return nil, false
	}
	var out []FutContract
	for _, e := range arr {
		var c contractJSON
		if err := json.Unmarshal(e, &c); err != nil || c.Expiry == nil {
			continue
		}
		out = append(out, FutContract{Token: int64(c.Token), Tradingsymbol: c.Tradingsymbol, Expiry: *c.Expiry, LotSize: c.LotSize})
	}
	return out, true
}
