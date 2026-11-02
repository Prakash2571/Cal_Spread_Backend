package dhan

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// The goldens come from testdata/gen_decoder.mjs (run through generate.mjs), which
// imports the original src/brokers/dhan/{feedDecoder,feed}.ts. They are canonical JSON:
// NaN, ±Infinity and -0 are spelled {"$num": …}, so the comparison here is exact text,
// bit for bit and key order included.

func readGolden(t *testing.T, name string, out any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/brokers/dhan/testdata/generate.mjs decoder)", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
}

// canonNum appends f as gen_common.mjs canonicalJSON writes it.
func canonNum(b []byte, f float64) []byte {
	switch {
	case math.IsNaN(f):
		return append(b, `{"$num":"NaN"}`...)
	case math.IsInf(f, 1):
		return append(b, `{"$num":"Infinity"}`...)
	case math.IsInf(f, -1):
		return append(b, `{"$num":"-Infinity"}`...)
	case f == 0 && math.Signbit(f):
		return append(b, `{"$num":"-0"}`...)
	}
	return append(b, jsonNumber(f)...)
}

// goldenNumber reads a canonical golden number.
func goldenNumber(t *testing.T, raw json.RawMessage) float64 {
	t.Helper()
	if len(raw) > 0 && raw[0] == '{' {
		var o struct {
			Num string `json:"$num"`
		}
		if err := json.Unmarshal(raw, &o); err != nil {
			t.Fatal(err)
		}
		switch o.Num {
		case "NaN":
			return math.NaN()
		case "Infinity":
			return math.Inf(1)
		case "-Infinity":
			return math.Inf(-1)
		case "-0":
			return math.Copysign(0, -1)
		}
		t.Fatalf("bad $num %q", o.Num)
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil {
		t.Fatalf("number %s: %v", raw, err)
	}
	return f
}

func appendLevels(b []byte, levels []market.DepthLevel) []byte {
	b = append(b, '[')
	for i, l := range levels {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"price":`...)
		b = canonNum(b, l.Price)
		b = append(b, `,"qty":`...)
		b = canonNum(b, l.Qty)
		b = append(b, `,"orders":`...)
		b = canonNum(b, l.Orders)
		b = append(b, '}')
	}
	return append(b, ']')
}

// packetJSON is the DhanFeedPacket object decodeDhanFeed built: the header fields, then
// every field the packet carried in the order feedDecoder.ts assigned them (one global
// order fits every packet code).
func packetJSON(p *Packet) []byte {
	b := append([]byte(`{"code":`), strconv.Itoa(p.Code)...)
	b = append(b, `,"segment":`...)
	if p.Segment == "" {
		b = append(b, "null"...)
	} else {
		b = strconv.AppendQuote(b, string(p.Segment))
	}
	b = append(b, `,"segmentCode":`...)
	b = strconv.AppendInt(b, int64(p.SegmentCode), 10)
	b = append(b, `,"securityId":`...)
	b = strconv.AppendInt(b, p.SecurityID, 10)
	f := func(key string, v *float64) {
		if v != nil {
			b = append(b, `,"`+key+`":`...)
			b = canonNum(b, *v)
		}
	}
	i := func(key string, v *int64) {
		if v != nil {
			b = append(b, `,"`+key+`":`...)
			b = strconv.AppendInt(b, *v, 10)
		}
	}
	f("last_price", p.LastPrice)
	i("last_quantity", p.LastQuantity)
	i("last_trade_time", p.LastTradeTime)
	f("average_price", p.AveragePrice)
	i("volume", p.Volume)
	i("total_sell_quantity", p.TotalSellQuantity)
	i("total_buy_quantity", p.TotalBuyQuantity)
	i("oi", p.OI)
	i("oi_day_high", p.OIDayHigh)
	i("oi_day_low", p.OIDayLow)
	f("open", p.Open)
	f("close", p.Close)
	f("high", p.High)
	f("low", p.Low)
	f("prev_close", p.PrevClose)
	i("prev_oi", p.PrevOI)
	if p.Bids != nil {
		b = append(b, `,"bids":`...)
		b = appendLevels(b, p.Bids)
	}
	if p.Asks != nil {
		b = append(b, `,"asks":`...)
		b = appendLevels(b, p.Asks)
	}
	i("disconnect_code", p.DisconnectCode)
	return append(b, '}')
}

// tickJSON is the Tick object toTick built.
func tickJSON(b []byte, t market.Tick) []byte {
	b = append(b, `{"token":`...)
	b = strconv.AppendInt(b, t.Token, 10)
	for _, f := range []struct {
		k string
		v float64
	}{{"last_price", t.LastPrice}, {"close_price", t.ClosePrice}, {"oi", t.OI}, {"bid", t.Bid}, {"ask", t.Ask}} {
		b = append(b, `,"`+f.k+`":`...)
		b = canonNum(b, f.v)
	}
	b = append(b, `,"bids":`...)
	b = appendLevels(b, t.Bids)
	b = append(b, `,"asks":`...)
	b = appendLevels(b, t.Asks)
	if t.ExchangeTS != nil {
		b = append(b, `,"exchange_ts":`...) // never: Dhan has no book timestamp
		b = strconv.AppendInt(b, *t.ExchangeTS, 10)
	}
	b = append(b, `,"depth_updated":`...)
	b = strconv.AppendBool(b, t.DepthUpdated != nil && *t.DepthUpdated)
	return append(b, '}')
}

func TestDecodeFeedGolden(t *testing.T) {
	var g struct {
		Cases []struct {
			Name    string          `json:"name"`
			Hex     string          `json:"hex"`
			Packets json.RawMessage `json:"packets"`
			Errors  []string        `json:"errors"`
			// A frame repeated Repeat times is summarised by the generator.
			Repeat      int             `json:"repeat"`
			PacketCount int             `json:"packetCount"`
			FirstPacket json.RawMessage `json:"firstPacket"`
			LastPacket  json.RawMessage `json:"lastPacket"`
		} `json:"cases"`
	}
	readGolden(t, "decoder.json", &g)
	if len(g.Cases) < 700 {
		t.Fatalf("golden has only %d cases", len(g.Cases))
	}
	packets, errs, repeats := 0, 0, 0
	for _, c := range g.Cases {
		buf, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatal(err)
		}
		if c.Repeat > 0 {
			repeats++
			buf = bytes.Repeat(buf, c.Repeat)
		}
		res := DecodeFeed(buf)
		if fmt.Sprintf("%q", res.Errors) != fmt.Sprintf("%q", c.Errors) {
			t.Errorf("%s: errors %q, want %q", c.Name, res.Errors, c.Errors)
		}
		packets += len(res.Packets)
		errs += len(res.Errors)
		if c.Repeat > 0 {
			first, last := []byte("null"), []byte("null")
			if n := len(res.Packets); n > 0 {
				first, last = packetJSON(&res.Packets[0]), packetJSON(&res.Packets[n-1])
			}
			if len(res.Packets) != c.PacketCount || string(first) != string(c.FirstPacket) || string(last) != string(c.LastPacket) {
				t.Errorf("%s: %d packets, first %s last %s; want %d, %s, %s", c.Name, len(res.Packets), first, last,
					c.PacketCount, c.FirstPacket, c.LastPacket)
			}
			continue
		}
		got := []byte{'['}
		for i := range res.Packets {
			if i > 0 {
				got = append(got, ',')
			}
			got = append(got, packetJSON(&res.Packets[i])...)
		}
		got = append(got, ']')
		if string(got) != string(c.Packets) {
			t.Errorf("%s: packets\n got %s\nwant %s", c.Name, got, c.Packets)
		}
	}
	if repeats < 3 {
		t.Fatalf("only %d repeated-frame cases", repeats)
	}
	t.Logf("%d frames, %d packets, %d decode errors", len(g.Cases), packets, errs)
}

type goldenState struct {
	Token      json.RawMessage `json:"token"`
	LastPrice  json.RawMessage `json:"last_price"`
	ClosePrice json.RawMessage `json:"close_price"`
	OI         json.RawMessage `json:"oi"`
	Bids       []map[string]json.RawMessage
	Asks       []map[string]json.RawMessage
}

func levelsFrom(t *testing.T, ls []map[string]json.RawMessage) []market.DepthLevel {
	out := make([]market.DepthLevel, 0, len(ls))
	for _, l := range ls {
		out = append(out, market.DepthLevel{Price: goldenNumber(t, l["price"]), Qty: goldenNumber(t, l["qty"]), Orders: goldenNumber(t, l["orders"])})
	}
	return out
}

func TestToTickGolden(t *testing.T) {
	var g struct {
		Cases []struct {
			Name         string          `json:"name"`
			State        goldenState     `json:"state"`
			DepthUpdated json.RawMessage `json:"depthUpdated"` // true, false or "default"
			Tick         json.RawMessage `json:"tick"`
		} `json:"cases"`
	}
	readGolden(t, "totick.json", &g)
	if len(g.Cases) < 50 {
		t.Fatalf("golden has only %d cases", len(g.Cases))
	}
	for _, c := range g.Cases {
		s := c.State
		state := FeedState{Token: int64(goldenNumber(t, s.Token)), LastPrice: goldenNumber(t, s.LastPrice),
			ClosePrice: goldenNumber(t, s.ClosePrice), OI: goldenNumber(t, s.OI), Bids: levelsFrom(t, s.Bids), Asks: levelsFrom(t, s.Asks)}
		// toTick(state) defaults depthUpdated to true; Go has no default arguments.
		depthUpdated := string(c.DepthUpdated) != "false"
		if got := tickJSON(nil, ToTick(state, depthUpdated)); string(got) != string(c.Tick) {
			t.Errorf("%s:\n got %s\nwant %s", c.Name, got, c.Tick)
		}
	}
}

// TestFeedMergeGolden replays DhanFeed.handleFrame on recorded frames: attribution of
// (segment, securityId) to the first wanted token, partial packets merged into
// per-instrument state, provenance from the packet itself, first-tick and decode-error
// logging, and the counters.
func TestFeedMergeGolden(t *testing.T) {
	var g struct {
		Cases []struct {
			Name   string `json:"name"`
			Tokens []struct {
				Token      int64    `json:"token"`
				Segment    *Segment `json:"segment"`
				SecurityID int64    `json:"securityId"`
			} `json:"tokens"`
			Frames []struct {
				Hex string `json:"hex"`
				Now int64  `json:"now"`
			} `json:"frames"`
			Out []struct {
				Ticks      json.RawMessage `json:"ticks"`
				Wanted     int             `json:"wanted"`
				Subscribed int             `json:"subscribed"`
				LastTickAt *int64          `json:"lastTickAt"`
				Logs       []string        `json:"logs"`
			} `json:"out"`
		} `json:"cases"`
	}
	readGolden(t, "feed_merge.json", &g)
	if len(g.Cases) < 10 {
		t.Fatalf("golden has only %d scenarios", len(g.Cases))
	}
	var logMu sync.Mutex
	var logs []string
	SetLogger(func(format string, args ...any) {
		logMu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		logMu.Unlock()
	})
	defer SetLogger(nil)
	for _, c := range g.Cases {
		t.Run(c.Name, func(t *testing.T) {
			resolve := map[int64]*FeedInstrument{}
			for _, tk := range c.Tokens {
				if tk.Segment == nil {
					resolve[tk.Token] = nil
				} else if _, seen := resolve[tk.Token]; !seen {
					resolve[tk.Token] = &FeedInstrument{Segment: *tk.Segment, SecurityID: tk.SecurityID}
				}
			}
			var batches [][]market.Tick
			f := NewFeed(FeedOptions{
				OnTicks: func(ts []market.Tick) { batches = append(batches, ts) },
				Resolve: func(token int64) (FeedInstrument, bool) {
					if inst := resolve[token]; inst != nil {
						return *inst, true
					}
					return FeedInstrument{}, false
				},
			})
			f.mu.Lock()
			for _, tk := range c.Tokens { // feed.wanted.add(token)
				if _, ok := f.wanted[tk.Token]; !ok {
					f.wantSeq++
					f.wanted[tk.Token] = f.wantSeq
				}
			}
			f.mu.Unlock()
			if len(c.Out) != len(c.Frames) {
				t.Fatalf("golden has %d outputs for %d frames", len(c.Out), len(c.Frames))
			}
			for i, fr := range c.Frames {
				buf, err := hex.DecodeString(fr.Hex)
				if err != nil {
					t.Fatal(err)
				}
				logMu.Lock()
				logs = nil
				logMu.Unlock()
				before := len(batches)
				f.mu.Lock()
				f.handleFrameLocked(buf, fr.Now)
				f.mu.Unlock()
				f.drain()
				want := c.Out[i]
				got := []byte("null")
				if len(batches) > before {
					got = []byte{'['}
					for j, tk := range batches[len(batches)-1] {
						if j > 0 {
							got = append(got, ',')
						}
						got = tickJSON(got, tk)
					}
					got = append(got, ']')
				}
				if string(got) != string(want.Ticks) {
					t.Fatalf("frame %d ticks\n got %s\nwant %s", i, got, want.Ticks)
				}
				last := f.LastTickAtMs()
				if f.WantedCount() != want.Wanted || f.SubscribedCount() != want.Subscribed ||
					(last == nil) != (want.LastTickAt == nil) || (last != nil && *last != *want.LastTickAt) {
					t.Fatalf("frame %d: wanted %d subscribed %d lastTickAt %v, want %d %d %v", i,
						f.WantedCount(), f.SubscribedCount(), last, want.Wanted, want.Subscribed, want.LastTickAt)
				}
				logMu.Lock()
				gotLogs := append([]string{}, logs...)
				logMu.Unlock()
				if fmt.Sprintf("%q", gotLogs) != fmt.Sprintf("%q", want.Logs) && !(len(gotLogs) == 0 && len(want.Logs) == 0) {
					t.Fatalf("frame %d logs\n got %q\nwant %q", i, gotLogs, want.Logs)
				}
			}
		})
	}
}
