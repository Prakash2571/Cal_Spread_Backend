package kite

import (
	"math"
	"strings"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// ParseInstrumentsCSV parses the Kite instruments dump (kite.ts parseInstrumentsCsv).
//
// Exactly as Node: the text is trimmed and split on "\n"; columns are found by header
// name (a missing column reads as absent and takes the default); empty lines are skipped;
// numbers go through Number() ("" is 0, junk is NaN) and strings default to "".
//
// The integer token columns cannot hold NaN in Go: a token Number() would make NaN or
// ±Infinity reads as 0, and a fractional one is truncated.
func ParseInstrumentsCSV(csv string) []market.Instrument {
	lines := strings.Split(jsjson.TrimJS(csv), "\n")
	if len(lines) <= 1 {
		return []market.Instrument{}
	}
	header := splitCSVLine(lines[0])
	idx := func(key string) int {
		for i, h := range header {
			if h == key {
				return i
			}
		}
		return -1
	}
	iToken := idx("instrument_token")
	eToken := idx("exchange_token")
	tSymbol := idx("tradingsymbol")
	name := idx("name")
	lastPrice := idx("last_price")
	expiry := idx("expiry")
	strike := idx("strike")
	tickSize := idx("tick_size")
	lotSize := idx("lot_size")
	iType := idx("instrument_type")
	segment := idx("segment")
	exchange := idx("exchange")

	rows := make([]market.Instrument, 0, len(lines)-1)
	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		c := splitCSVLine(line)
		field := func(i int) (string, bool) {
			if i < 0 || i >= len(c) {
				return "", false
			}
			return c[i], true
		}
		num := func(i int) float64 {
			s, ok := field(i)
			if !ok {
				return 0 // Number(undefined ?? 0)
			}
			return jsjson.StringToNumber(s)
		}
		str := func(i int) string {
			s, _ := field(i)
			return s
		}
		rows = append(rows, market.Instrument{
			InstrumentToken: toInt64(num(iToken)),
			ExchangeToken:   toInt64(num(eToken)),
			Tradingsymbol:   str(tSymbol),
			Name:            str(name),
			LastPrice:       num(lastPrice),
			Expiry:          str(expiry),
			Strike:          num(strike),
			TickSize:        num(tickSize),
			LotSize:         num(lotSize),
			InstrumentType:  str(iType),
			Segment:         str(segment),
			Exchange:        str(exchange),
		})
	}
	return rows
}

// splitCSVLine splits one CSV line with simple double-quote quoting: `"` toggles quoting,
// `""` inside quotes is a literal quote, `,` outside quotes separates, and every field is
// trimmed (so a CRLF line's "\r" goes). Iterating bytes is equivalent to Node's UTF-16
// iteration because both special characters are ASCII.
func splitCSVLine(line string) []string {
	var out []string
	var cur strings.Builder
	inQuotes := false
	for i := 0; i < len(line); i++ {
		ch := line[i]
		switch {
		case ch == '"':
			if inQuotes && i+1 < len(line) && line[i+1] == '"' {
				cur.WriteByte('"')
				i++
			} else {
				inQuotes = !inQuotes
			}
		case ch == ',' && !inQuotes:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(ch)
		}
	}
	out = append(out, cur.String())
	for i, s := range out {
		out[i] = jsjson.TrimJS(s)
	}
	return out
}

// toInt64 converts a JavaScript number to an integer field: non-finite values are 0.
func toInt64(f float64) int64 {
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > 9.2e18 {
		return 0
	}
	return int64(f)
}
