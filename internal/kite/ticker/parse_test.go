package ticker

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

type goldenTick struct {
	Token        int64   `json:"token"`
	LastPrice    float64 `json:"last_price"`
	ClosePrice   float64 `json:"close_price"`
	OI           float64 `json:"oi"`
	Bid          float64 `json:"bid"`
	Ask          float64 `json:"ask"`
	Bids         []level `json:"bids"`
	Asks         []level `json:"asks"`
	DepthUpdated bool    `json:"depth_updated"`
	ExchangeTS   int64   `json:"exchange_ts"`
}

type level struct {
	Price  float64 `json:"price"`
	Qty    float64 `json:"qty"`
	Orders float64 `json:"orders"`
}

type goldenCase struct {
	Name  string       `json:"name"`
	Hex   string       `json:"hex"`
	Ticks []goldenTick `json:"ticks"`
	Error *string      `json:"error"`
}

func loadGolden(t *testing.T) []goldenCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "parsebinary.golden.json"))
	if err != nil {
		t.Fatalf("golden: %v (regenerate with scratch/go-migration/check.sh node internal/kite/testdata/gen_parsebinary.mjs)", err)
	}
	var g struct {
		Cases []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g.Cases
}

func levelsEqual(got []market.DepthLevel, want []level) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i].Price != want[i].Price || got[i].Qty != want[i].Qty || got[i].Orders != want[i].Orders {
			return false
		}
	}
	return true
}

// TestParseBinaryGolden compares ParseBinary with src/ticker.ts parseBinary run by Node on
// the same bytes: every layout, multi-packet frames, heartbeats and malformed frames.
func TestParseBinaryGolden(t *testing.T) {
	cases := loadGolden(t)
	if len(cases) < 300 {
		t.Fatalf("golden has only %d cases", len(cases))
	}
	thrown, withTicks := 0, 0
	for _, c := range cases {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		got := ParseBinary(raw)
		if c.Error != nil {
			// Node threw a RangeError out of the message handler: the whole frame is lost.
			thrown++
			if len(got) != 0 {
				t.Errorf("%s: Node threw %s, Go returned %d ticks", c.Name, *c.Error, len(got))
			}
			continue
		}
		if len(got) != len(c.Ticks) {
			t.Errorf("%s: %d ticks, want %d", c.Name, len(got), len(c.Ticks))
			continue
		}
		if len(got) > 0 {
			withTicks++
		}
		for i, w := range c.Ticks {
			g := got[i]
			if g.Token != w.Token || g.LastPrice != w.LastPrice || g.ClosePrice != w.ClosePrice ||
				g.OI != w.OI || g.Bid != w.Bid || g.Ask != w.Ask {
				t.Errorf("%s[%d]: scalars %+v, want %+v", c.Name, i, g, w)
			}
			if g.Bids == nil || g.Asks == nil {
				t.Errorf("%s[%d]: Bids/Asks must be supplied (non-nil), even when empty", c.Name, i)
			}
			if !levelsEqual(g.Bids, w.Bids) || !levelsEqual(g.Asks, w.Asks) {
				t.Errorf("%s[%d]: depth %+v / %+v, want %+v / %+v", c.Name, i, g.Bids, g.Asks, w.Bids, w.Asks)
			}
			if g.DepthUpdated == nil || *g.DepthUpdated != w.DepthUpdated {
				t.Errorf("%s[%d]: depth_updated %v, want %v", c.Name, i, g.DepthUpdated, w.DepthUpdated)
			}
			switch {
			case w.ExchangeTS == 0 && g.ExchangeTS != nil:
				t.Errorf("%s[%d]: exchange_ts %d, want absent (Node 0)", c.Name, i, *g.ExchangeTS)
			case w.ExchangeTS != 0 && (g.ExchangeTS == nil || *g.ExchangeTS != w.ExchangeTS):
				t.Errorf("%s[%d]: exchange_ts %v, want %d", c.Name, i, g.ExchangeTS, w.ExchangeTS)
			}
		}
	}
	if thrown < 20 || withTicks < 200 {
		t.Errorf("golden coverage too thin: %d RangeError cases, %d with ticks", thrown, withTicks)
	}
	t.Logf("%d golden frames (%d with ticks, %d RangeError drops)", len(cases), withTicks, thrown)
}

// kitePacket is tests/box/depthReadiness.test.mjs kitePacket: one packet of `length`
// bytes, token 256 (low byte 0 -> divisor 100), last price 100.00 and, when the packet
// is long enough, a close of 99.00 written at absolute offset 44 (packet offset 40).
func kitePacket(length int) []byte {
	buf := make([]byte, 4+length)
	binary.BigEndian.PutUint16(buf[0:], 1)
	binary.BigEndian.PutUint16(buf[2:], uint16(length))
	binary.BigEndian.PutUint32(buf[4:], 256)
	binary.BigEndian.PutUint32(buf[8:], 10_000)
	if length >= 44 {
		binary.BigEndian.PutUint32(buf[44:], 9_900)
	}
	return buf
}

// TestZerodhaProvenanceTrueOnlyForFullPackets ports depthReadiness "Zerodha provenance is
// true only for full packets".
func TestZerodhaProvenanceTrueOnlyForFullPackets(t *testing.T) {
	ltp := ParseBinary(kitePacket(8))[0]
	quote := ParseBinary(kitePacket(44))[0]
	full := ParseBinary(kitePacket(184))[0]
	for name, tk := range map[string]market.Tick{"ltp": ltp, "quote": quote} {
		if tk.DepthUpdated == nil || *tk.DepthUpdated {
			t.Errorf("%s depth_updated = %v, want false", name, tk.DepthUpdated)
		}
	}
	if full.DepthUpdated == nil || !*full.DepthUpdated {
		t.Errorf("full depth_updated = %v, want true", full.DepthUpdated)
	}
	if full.Bids == nil || len(full.Bids) != 0 || full.Asks == nil || len(full.Asks) != 0 {
		t.Errorf("full packet with zero levels: bids=%#v asks=%#v, want empty non-nil", full.Bids, full.Asks)
	}
	if ltp.LastPrice != 100 || ltp.ClosePrice != 0 {
		t.Errorf("ltp prices = %v/%v, want 100/0", ltp.LastPrice, ltp.ClosePrice)
	}
	if quote.ClosePrice != 99 {
		t.Errorf("quote close = %v, want 99", quote.ClosePrice)
	}
}

func TestParseBinaryHeartbeatAndTruncation(t *testing.T) {
	for _, b := range [][]byte{nil, {}, {0}, {0, 0}, {0, 1}, {0, 1, 0}, {0, 1, 0, 8}} {
		if got := ParseBinary(b); len(got) != 0 {
			t.Errorf("ParseBinary(%v) = %d ticks, want none", b, len(got))
		}
	}
}

// The packet length is a signed 16-bit value: 0xFFFE is -2, which passes the overrun check
// and still reads the token and price at the packet start, exactly as Node did (the
// golden "negative length" cases pin the same frames).
func TestParseBinaryNegativeLengthIsSigned(t *testing.T) {
	frame := []byte{0, 1, 0xff, 0xfe, 0, 0, 0, 1, 0, 0, 0, 2}
	got := ParseBinary(frame)
	if len(got) != 1 || got[0].Token != 1 || got[0].LastPrice != 0.02 {
		t.Fatalf("negative length frame = %+v, want one tick token 1 price 0.02", got)
	}
	if got := ParseBinary([]byte{0, 1, 0x80, 0x00}); len(got) != 0 {
		t.Fatalf("length -32768 with no body parsed %d ticks", len(got))
	}
}

func TestParseBinaryTokenIsUnsigned(t *testing.T) {
	frame := []byte{0, 1, 0, 8, 0xff, 0xff, 0xfe, 0x02, 0, 0, 0, 1}
	got := ParseBinary(frame)
	if len(got) != 1 || got[0].Token != 0xfffffe02 || got[0].Token < 0 {
		t.Fatalf("token = %+v, want 4294966786", got)
	}
}
