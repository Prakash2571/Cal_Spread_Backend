// Package ticker is the Kite Connect v3 WebSocket ticker (src/ticker.ts): ConnectTicker
// opens one socket, subscribes tokens in "full" mode and decodes the binary packets with
// ParseBinary.
package ticker

import (
	"encoding/binary"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Packet length thresholds (ticker.ts): a packet of at least QuotePacketLen bytes carries
// the close at +40; one of at least FullPacketLen bytes carries OI, the exchange
// timestamp and 5-level depth.
const (
	QuotePacketLen = 44
	FullPacketLen  = 184
)

// frame is a bounds-checked big-endian reader over one message. bad records a read
// outside the message, where Node's DataView threw a RangeError out of the message
// handler and the whole message's ticks were lost.
type frame struct {
	b   []byte
	bad bool
}

func (f *frame) u32(off int) uint32 {
	if off < 0 || off+4 > len(f.b) {
		f.bad = true
		return 0
	}
	return binary.BigEndian.Uint32(f.b[off:])
}

func (f *frame) u16(off int) uint16 {
	if off < 0 || off+2 > len(f.b) {
		f.bad = true
		return 0
	}
	return binary.BigEndian.Uint16(f.b[off:])
}

func (f *frame) i16(off int) int {
	return int(int16(f.u16(off)))
}

// ParseBinary decodes one binary Kite message (ticker.ts parseBinary). All fields are
// big-endian:
//
//	[int16 packets] then per packet [int16 length][length bytes]
//	+0 uint32 instrument_token (unsigned: NFO tokens exceed 2^31)
//	+4 uint32 last_price / divisor          (every packet, incl. 8-byte LTP packets)
//	+40 uint32 close / divisor              (length >= 44)
//	+48 uint32 oi, +60 uint32 exchange seconds, depth at +64 (bids) and +124 (asks),
//	    12 bytes per level: qty uint32, price uint32 / divisor, orders uint16, 2 pad
//	                                        (length >= 184)
//
// The divisor comes from the token's low byte: 3 (CDS) 1e7, 7 (BCD) 1e4, otherwise 100.
// Index packets (28/32 bytes) therefore report close 0, as in Node.
//
// A message shorter than 2 bytes is a heartbeat and yields nothing. Decoding stops at a
// packet whose header or body would overrun the message; Bids/Asks are always non-nil
// (supplied, possibly empty); DepthUpdated is true exactly for full packets; ExchangeTS is
// seconds*1000, nil when the packet carried none (Node's 0).
//
// Lengths are signed and only bounded by the message, exactly as Node read them. Where
// Node's DataView would have thrown a RangeError (a malformed packet pointing outside the
// message), the whole message is dropped: Node lost the frame's ticks the same way.
func ParseBinary(b []byte) []market.Tick {
	if len(b) < 2 {
		return nil
	}
	f := &frame{b: b}
	numPackets := f.i16(0)
	offset := 2
	var ticks []market.Tick
	for p := 0; p < numPackets; p++ {
		if offset+2 > len(b) {
			break
		}
		plen := f.i16(offset)
		offset += 2
		if offset+plen > len(b) {
			break
		}
		token := f.u32(offset)
		divisor := priceDivisor(token)
		lastPrice := float64(f.u32(offset+4)) / divisor

		closePrice := 0.0
		if plen >= QuotePacketLen {
			closePrice = float64(f.u32(offset+40)) / divisor
		}

		var oi, bid, ask float64
		var exchangeTS *int64
		bids := []market.DepthLevel{}
		asks := []market.DepthLevel{}
		full := plen >= FullPacketLen
		if full {
			oi = float64(f.u32(offset + 48))
			if exSec := f.u32(offset + 60); exSec > 0 {
				ms := int64(exSec) * 1000
				exchangeTS = &ms
			}
			for i := 0; i < 5; i++ {
				bOff := offset + 64 + i*12
				if bPrice := float64(f.u32(bOff+4)) / divisor; bPrice > 0 {
					bids = append(bids, market.DepthLevel{Price: bPrice, Qty: float64(f.u32(bOff)), Orders: float64(f.u16(bOff + 8))})
				}
				aOff := offset + 124 + i*12
				if aPrice := float64(f.u32(aOff+4)) / divisor; aPrice > 0 {
					asks = append(asks, market.DepthLevel{Price: aPrice, Qty: float64(f.u32(aOff)), Orders: float64(f.u16(aOff + 8))})
				}
			}
			if len(bids) > 0 {
				bid = bids[0].Price
			}
			if len(asks) > 0 {
				ask = asks[0].Price
			}
		}
		if f.bad {
			return nil
		}
		depthUpdated := full
		ticks = append(ticks, market.Tick{
			Token:        int64(token),
			LastPrice:    lastPrice,
			ClosePrice:   closePrice,
			OI:           oi,
			Bid:          bid,
			Ask:          ask,
			Bids:         bids,
			Asks:         asks,
			DepthUpdated: &depthUpdated,
			ExchangeTS:   exchangeTS,
		})
		offset += plen
	}
	return ticks
}

// priceDivisor is the price scale by segment (token & 0xff).
func priceDivisor(token uint32) float64 {
	switch token & 0xff {
	case 3: // CDS (currency)
		return 10000000
	case 7: // BCD
		return 10000
	}
	return 100
}
