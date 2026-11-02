package dhan

import (
	"encoding/binary"
	"fmt"
	"math"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Feed response codes (DHAN_FEED_CODE).
const (
	FeedCodeIndex        = 1
	FeedCodeTicker       = 2
	FeedCodeQuote        = 4
	FeedCodeOI           = 5
	FeedCodePrevClose    = 6
	FeedCodeMarketStatus = 7
	FeedCodeFull         = 8
	FeedCodeDisconnect   = 50
)

// HeaderBytes is the fixed packet header size (DHAN_HEADER_BYTES).
const HeaderBytes = 8

const (
	tickerBytes     = 16
	quoteBytes      = 50
	oiBytes         = 12
	prevCloseBytes  = 16
	fullBytes       = 162
	depthLevelBytes = 20
	depthLevels     = 5
	maxPackets      = 10000
)

// Packet is one decoded feed packet (DhanFeedPacket), normalised but not merged. A nil
// field was not on the wire; the decoder never invents one. Prices are the exact
// float32 values widened to float64 (no rounding), as DataView.getFloat32 yields.
type Packet struct {
	Code        int
	Segment     Segment // "" when the code is unknown (TS null)
	SegmentCode int
	SecurityID  int64

	LastPrice         *float64
	LastQuantity      *int64
	LastTradeTime     *int64 // epoch ms; Dhan's last TRADE time, never a book timestamp
	AveragePrice      *float64
	Volume            *int64
	TotalBuyQuantity  *int64
	TotalSellQuantity *int64
	OI                *int64
	OIDayHigh         *int64
	OIDayLow          *int64
	Open              *float64
	Close             *float64
	High              *float64
	Low               *float64
	PrevClose         *float64
	PrevOI            *int64
	// Bids/Asks are nil unless the packet carried depth (FULL); an empty non-nil
	// slice is a real "no liquidity" observation.
	Bids []market.DepthLevel
	Asks []market.DepthLevel
	// DisconnectCode is set on a server DISCONNECT packet.
	DisconnectCode *int64
}

// DecodeResult is DhanDecodeResult: the valid prefix of a frame plus why the rest
// could not be decoded.
type DecodeResult struct {
	Packets []Packet
	Errors  []string
}

// DecodeFeed is decodeDhanFeed: decode one LITTLE-ENDIAN binary frame into zero or
// more packets, walking by each packet's declared length. It never panics; a malformed
// frame yields its valid prefix plus error strings.
func DecodeFeed(buf []byte) DecodeResult {
	res := DecodeResult{Packets: []Packet{}, Errors: []string{}}
	total := len(buf)
	if total == 0 {
		return res // heartbeat
	}
	if total < HeaderBytes {
		res.Errors = append(res.Errors, fmt.Sprintf("frame shorter than the 8-byte header (%d bytes)", total))
		return res
	}
	le := binary.LittleEndian
	f32 := func(at int) *float64 { v := float64(math.Float32frombits(le.Uint32(buf[at:]))); return &v }
	i32 := func(at int) *int64 { v := int64(int32(le.Uint32(buf[at:]))); return &v }
	i16 := func(at int) *int64 { v := int64(int16(le.Uint16(buf[at:]))); return &v }
	epochSeconds := func(at int) *int64 {
		s := int64(int32(le.Uint32(buf[at:])))
		if s > 0 {
			ms := s * 1000
			return &ms
		}
		return nil
	}
	quoteCore := func(off int, p *Packet) {
		p.LastPrice = f32(off + 8)
		p.LastQuantity = i16(off + 12)
		p.LastTradeTime = epochSeconds(off + 14)
		p.AveragePrice = f32(off + 18)
		p.Volume = i32(off + 22)
		p.TotalSellQuantity = i32(off + 26)
		p.TotalBuyQuantity = i32(off + 30)
	}

	offset := 0
	guard := 0
	for offset+HeaderBytes <= total {
		guard++
		if guard > maxPackets {
			res.Errors = append(res.Errors, "aborted decoding: implausible packet count in one frame")
			break
		}
		code := int(buf[offset])
		declared := int(int16(le.Uint16(buf[offset+1:])))
		segCode := int(buf[offset+3])
		securityID := int64(int32(le.Uint32(buf[offset+4:])))

		if declared <= 0 {
			res.Errors = append(res.Errors, fmt.Sprintf("packet at offset %d declared a non-positive length (%d)", offset, declared))
			break
		}
		if offset+declared > total {
			res.Errors = append(res.Errors, fmt.Sprintf("truncated packet at offset %d: declared %d bytes, %d available", offset, declared, total-offset))
			break
		}

		seg, _ := SegmentFromCode(segCode)
		p := Packet{Code: code, Segment: seg, SegmentCode: segCode, SecurityID: securityID}
		switch code {
		case FeedCodeTicker, FeedCodeIndex:
			if declared < tickerBytes {
				res.Errors = append(res.Errors, fmt.Sprintf("ticker packet too short (%d < %d)", declared, tickerBytes))
				break
			}
			p.LastPrice = f32(offset + 8)
			p.LastTradeTime = epochSeconds(offset + 12)
			res.Packets = append(res.Packets, p)
		case FeedCodeQuote:
			if declared < quoteBytes {
				res.Errors = append(res.Errors, fmt.Sprintf("quote packet too short (%d < %d)", declared, quoteBytes))
				break
			}
			quoteCore(offset, &p)
			p.Open = f32(offset + 34)
			p.Close = f32(offset + 38)
			p.High = f32(offset + 42)
			p.Low = f32(offset + 46)
			res.Packets = append(res.Packets, p)
		case FeedCodeOI:
			if declared < oiBytes {
				res.Errors = append(res.Errors, fmt.Sprintf("OI packet too short (%d < %d)", declared, oiBytes))
				break
			}
			p.OI = i32(offset + 8)
			res.Packets = append(res.Packets, p)
		case FeedCodePrevClose:
			if declared < prevCloseBytes {
				res.Errors = append(res.Errors, fmt.Sprintf("prev-close packet too short (%d < %d)", declared, prevCloseBytes))
				break
			}
			p.PrevClose = f32(offset + 8)
			p.PrevOI = i32(offset + 12)
			res.Packets = append(res.Packets, p)
		case FeedCodeFull:
			if declared < fullBytes {
				res.Errors = append(res.Errors, fmt.Sprintf("full packet too short (%d < %d)", declared, fullBytes))
				break
			}
			quoteCore(offset, &p)
			p.OI = i32(offset + 34)
			p.OIDayHigh = i32(offset + 38)
			p.OIDayLow = i32(offset + 42)
			p.Open = f32(offset + 46)
			p.Close = f32(offset + 50)
			p.High = f32(offset + 54)
			p.Low = f32(offset + 58)
			p.Bids, p.Asks = readDepth(buf, offset+62)
			res.Packets = append(res.Packets, p)
		case FeedCodeMarketStatus:
			res.Packets = append(res.Packets, p)
		case FeedCodeDisconnect:
			var dc int64
			if declared >= 10 {
				dc = *i16(offset + 8)
			}
			p.DisconnectCode = &dc
			res.Packets = append(res.Packets, p)
		default:
			res.Errors = append(res.Errors, fmt.Sprintf("unknown Dhan feed response code %d (%d bytes)", code, declared))
		}
		offset += declared
	}
	return res
}

// readDepth reads five interleaved 20-byte levels (int32 bidQty, int32 askQty, int16
// bidOrders, int16 askOrders, float32 bidPrice, float32 askPrice). Zero-priced sides
// are dropped; quantities and order counts are clamped at 0.
func readDepth(buf []byte, start int) (bids, asks []market.DepthLevel) {
	le := binary.LittleEndian
	bids = []market.DepthLevel{}
	asks = []market.DepthLevel{}
	for i := 0; i < depthLevels; i++ {
		at := start + i*depthLevelBytes
		if at+depthLevelBytes > len(buf) {
			break
		}
		bidQty := float64(int32(le.Uint32(buf[at:])))
		askQty := float64(int32(le.Uint32(buf[at+4:])))
		bidOrders := float64(int16(le.Uint16(buf[at+8:])))
		askOrders := float64(int16(le.Uint16(buf[at+10:])))
		bidPrice := float64(math.Float32frombits(le.Uint32(buf[at+12:])))
		askPrice := float64(math.Float32frombits(le.Uint32(buf[at+16:])))
		if bidPrice > 0 {
			bids = append(bids, market.DepthLevel{Price: bidPrice, Qty: math.Max(0, bidQty), Orders: math.Max(0, bidOrders)})
		}
		if askPrice > 0 {
			asks = append(asks, market.DepthLevel{Price: askPrice, Qty: math.Max(0, askQty), Orders: math.Max(0, askOrders)})
		}
	}
	return bids, asks
}
