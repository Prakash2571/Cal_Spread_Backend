// Package dhan is the DhanHQ v2 integration (src/brokers/dhan/*.ts): the paced HTTP
// transport, typed errors, the API-key consent login, the read-only REST client, the
// little-endian WebSocket market feed and the instrument master.
//
// Live order placement is not part of the Go service: the order endpoints, the order
// correlation ids and the Box charge calculator were not ported.
package dhan

// Segment is a Dhan REST exchange-segment name.
type Segment string

// Dhan exchange segments.
const (
	SegmentIdxI        Segment = "IDX_I"
	SegmentNSEEQ       Segment = "NSE_EQ"
	SegmentNSEFNO      Segment = "NSE_FNO"
	SegmentNSECurrency Segment = "NSE_CURRENCY"
	SegmentBSEEQ       Segment = "BSE_EQ"
	SegmentBSEFNO      Segment = "BSE_FNO"
	SegmentBSECurrency Segment = "BSE_CURRENCY"
	SegmentMCXComm     Segment = "MCX_COMM"
)

// SegmentByCode is the binary feed header's segment code → name (DHAN_SEGMENT_BY_CODE).
// Code 6 is unused by Dhan.
var SegmentByCode = map[int]Segment{
	0: SegmentIdxI,
	1: SegmentNSEEQ,
	2: SegmentNSEFNO,
	3: SegmentNSECurrency,
	4: SegmentBSEEQ,
	5: SegmentMCXComm,
	7: SegmentBSECurrency,
	8: SegmentBSEFNO,
}

// CodeBySegment is the inverse of SegmentByCode (DHAN_CODE_BY_SEGMENT).
var CodeBySegment = map[Segment]int{
	SegmentIdxI:        0,
	SegmentNSEEQ:       1,
	SegmentNSEFNO:      2,
	SegmentNSECurrency: 3,
	SegmentBSEEQ:       4,
	SegmentMCXComm:     5,
	SegmentBSECurrency: 7,
	SegmentBSEFNO:      8,
}

// Segments lists the segments in DHAN_CODE_BY_SEGMENT declaration order.
var Segments = []Segment{
	SegmentIdxI, SegmentNSEEQ, SegmentNSEFNO, SegmentNSECurrency,
	SegmentBSEEQ, SegmentMCXComm, SegmentBSECurrency, SegmentBSEFNO,
}

// SegmentFromCode is dhanSegmentFromCode; ok is false for an unknown code.
func SegmentFromCode(code int) (Segment, bool) {
	s, ok := SegmentByCode[code]
	return s, ok
}

// SegmentCode returns the binary code of a segment.
func SegmentCode(s Segment) (int, bool) {
	c, ok := CodeBySegment[s]
	return c, ok
}

// SegmentFor is dhanSegmentFor: internal exchange → Dhan segment. An index (or the
// INDICES/IDX_I/IDX labels) is always IDX_I; ok is false for anything unrecognised
// rather than guessing a segment.
func SegmentFor(exchange string, isIndex bool) (Segment, bool) {
	ex := jsUpper(jsTrim(exchange))
	if isIndex || ex == "INDICES" || ex == "IDX_I" || ex == "IDX" {
		return SegmentIdxI, true
	}
	switch ex {
	case "NSE", "NSE_EQ":
		return SegmentNSEEQ, true
	case "NFO", "NSE_FNO":
		return SegmentNSEFNO, true
	case "CDS", "NSE_CURRENCY":
		return SegmentNSECurrency, true
	case "BSE", "BSE_EQ":
		return SegmentBSEEQ, true
	case "BFO", "BSE_FNO":
		return SegmentBSEFNO, true
	case "BCD", "BSE_CURRENCY":
		return SegmentBSECurrency, true
	case "MCX", "MCX_COMM":
		return SegmentMCXComm, true
	}
	return "", false
}

// InternalExchangeFor is internalExchangeFor: Dhan segment → the Zerodha-style
// exchange label stored on instruments. An unknown segment yields "" (the TS switch
// has no default and returns undefined).
func InternalExchangeFor(s Segment) string {
	switch s {
	case SegmentNSEEQ:
		return "NSE"
	case SegmentNSEFNO:
		return "NFO"
	case SegmentNSECurrency:
		return "CDS"
	case SegmentBSEEQ:
		return "BSE"
	case SegmentBSEFNO:
		return "BFO"
	case SegmentBSECurrency:
		return "BCD"
	case SegmentMCXComm:
		return "MCX"
	case SegmentIdxI:
		return "INDICES"
	}
	return ""
}

// valid reports whether s is one of the eight known segments.
func (s Segment) valid() bool {
	_, ok := CodeBySegment[s]
	return ok
}

// String implements fmt.Stringer.
func (s Segment) String() string { return string(s) }
