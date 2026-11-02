package dhan

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Instrument is a Dhan instrument in the internal (Kite-shaped) form, keeping its
// broker-native identity (DhanInstrument).
type Instrument struct {
	market.Instrument
	// DhanSecurityID is Dhan's own identifier, the only thing its APIs accept.
	DhanSecurityID int64   `json:"dhan_security_id"`
	DhanSegment    Segment `json:"dhan_segment"`
	// DhanUnderlyingSecurityID is the underlying's security id (option-chain calls).
	DhanUnderlyingSecurityID *int64 `json:"dhan_underlying_security_id"`
}

const tokenSegmentBase = 1_000_000_000

// MaxFutureExpiryDays is the derivative expiry horizon; anything further out is a
// test or long-dated artefact.
const MaxFutureExpiryDays = 400

// maxSafeInteger is Number.MAX_SAFE_INTEGER.
const maxSafeInteger = 9007199254740991

// InternalToken is dhanInternalToken: segCode × 1e9 + securityId, so the same security
// id in two segments never collides. An unknown segment yields 0.
func InternalToken(segment Segment, securityID int64) int64 {
	code, ok := CodeBySegment[segment]
	if !ok {
		return 0
	}
	return int64(code)*tokenSegmentBase + securityID
}

// IdentityFromToken is dhanIdentityFromToken. Any token below 1e9 decodes as IDX_I.
func IdentityFromToken(token int64) (FeedInstrument, bool) {
	if token < 0 {
		return FeedInstrument{}, false
	}
	seg, ok := SegmentFromCode(int(token / tokenSegmentBase))
	sec := token % tokenSegmentBase
	if !ok || sec <= 0 {
		return FeedInstrument{}, false
	}
	return FeedInstrument{Segment: seg, SecurityID: sec}, true
}

// SplitCSVLine is splitCsvLine: quote-aware, "" inside quotes is a literal quote,
// fields are NOT trimmed.
func SplitCSVLine(line string) []string {
	out := []string{}
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
	return append(out, cur.String())
}

// normalizeHeader is trim + toUpperCase + /[\s_-]+/g → "_".
func normalizeHeader(h string) string {
	s := jsUpper(jsTrim(h))
	var b strings.Builder
	run := false
	for _, r := range s {
		if r == '_' || r == '-' || jsIsSpace(r) {
			if !run {
				b.WriteByte('_')
			}
			run = true
			continue
		}
		run = false
		b.WriteRune(r)
	}
	return b.String()
}

func columnIndex(normalized []string, names ...string) int {
	for _, name := range names {
		for i, h := range normalized {
			if h == name {
				return i
			}
		}
	}
	return -1
}

var (
	isoLikeRe = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})`)
	dmyRe     = regexp.MustCompile(`^([0-9]{2})[/-]([0-9]{2})[/-]([0-9]{4})`)
)

// NormalizeExpiry is normalizeDhanExpiry: "" / NA → ""; a leading YYYY-MM-DD as is;
// a leading DD/MM/YYYY (or with -) as YYYY-MM-DD; else Date.parse → UTC date; else "".
func NormalizeExpiry(raw string) string { return normalizeExpiryIn(raw, time.Local) }

func normalizeExpiryIn(raw string, loc *time.Location) string {
	value := jsTrim(raw)
	if value == "" || jsUpper(value) == "NA" {
		return ""
	}
	if m := isoLikeRe.FindStringSubmatch(value); m != nil {
		return m[1] + "-" + m[2] + "-" + m[3]
	}
	if m := dmyRe.FindStringSubmatch(value); m != nil {
		return m[3] + "-" + m[2] + "-" + m[1]
	}
	if ms := jsDateParse(value, loc); !math.IsNaN(ms) {
		return jsISOString(ms)[:10]
	}
	return ""
}

// NormalizeInstrumentType is normalizeDhanInstrumentType: Dhan classes → Kite's
// CE/PE/FUT/INDEX/EQ vocabulary (anything else upper-cased verbatim).
func NormalizeInstrumentType(instrument, optionType string) string {
	opt := jsUpper(jsTrim(optionType))
	if opt == "CE" || opt == "CALL" {
		return "CE"
	}
	if opt == "PE" || opt == "PUT" {
		return "PE"
	}
	inst := jsUpper(jsTrim(instrument))
	if strings.Contains(inst, "OPT") {
		return opt
	}
	if strings.Contains(inst, "FUT") {
		return "FUT"
	}
	if inst == "INDEX" || inst == "INDICES" {
		return "INDEX"
	}
	if inst == "EQUITY" || inst == "ES" {
		return "EQ"
	}
	return inst
}

func internalSegment(exchange, instrumentType string) string {
	if exchange == "INDICES" {
		return "INDICES"
	}
	if instrumentType == "FUT" {
		return exchange + "-FUT"
	}
	if exchange == "NFO" || exchange == "BFO" {
		return exchange + "-OPT"
	}
	return exchange
}

// isTestSymbol is /(?:INSETEST|TESTSCRIP|DUMMY|^TEST)/i.
func isTestSymbol(s string) bool {
	u := asciiUpper(s)
	return strings.Contains(u, "INSETEST") || strings.Contains(u, "TESTSCRIP") ||
		strings.Contains(u, "DUMMY") || strings.HasPrefix(u, "TEST")
}

// Counts is a string → count map that serialises in JavaScript key order.
type Counts struct {
	keys []string
	m    map[string]int
}

func (c *Counts) inc(k string) {
	if c.m == nil {
		c.m = map[string]int{}
	}
	if _, ok := c.m[k]; !ok {
		c.keys = append(c.keys, k)
	}
	c.m[k]++
}

// Get returns the count for k.
func (c Counts) Get(k string) int { return c.m[k] }

// Keys returns the keys in JavaScript property order.
func (c Counts) Keys() []string { return jsKeyOrder(append([]string(nil), c.keys...)) }

// MarshalJSON writes the counts as an object in JavaScript key order.
func (c Counts) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range c.Keys() {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(marshalNoEscape(k))
		fmt.Fprintf(&buf, ":%d", c.m[k])
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// ParseColumns are the located column indices (-1 when missing), in report order.
type ParseColumns struct {
	ExchID               int `json:"EXCH_ID"`
	Segment              int `json:"SEGMENT"`
	SecurityID           int `json:"SECURITY_ID"`
	Instrument           int `json:"INSTRUMENT"`
	InstrumentType       int `json:"INSTRUMENT_TYPE"`
	SymbolName           int `json:"SYMBOL_NAME"`
	DisplayName          int `json:"DISPLAY_NAME"`
	UnderlyingSymbol     int `json:"UNDERLYING_SYMBOL"`
	UnderlyingSecurityID int `json:"UNDERLYING_SECURITY_ID"`
	LotSize              int `json:"LOT_SIZE"`
	ExpiryDate           int `json:"EXPIRY_DATE"`
	StrikePrice          int `json:"STRIKE_PRICE"`
	OptionType           int `json:"OPTION_TYPE"`
	TickSize             int `json:"TICK_SIZE"`
}

func (c ParseColumns) ordered() []struct {
	name string
	at   int
} {
	return []struct {
		name string
		at   int
	}{
		{"EXCH_ID", c.ExchID}, {"SEGMENT", c.Segment}, {"SECURITY_ID", c.SecurityID},
		{"INSTRUMENT", c.Instrument}, {"INSTRUMENT_TYPE", c.InstrumentType}, {"SYMBOL_NAME", c.SymbolName},
		{"DISPLAY_NAME", c.DisplayName}, {"UNDERLYING_SYMBOL", c.UnderlyingSymbol},
		{"UNDERLYING_SECURITY_ID", c.UnderlyingSecurityID}, {"LOT_SIZE", c.LotSize},
		{"EXPIRY_DATE", c.ExpiryDate}, {"STRIKE_PRICE", c.StrikePrice}, {"OPTION_TYPE", c.OptionType},
		{"TICK_SIZE", c.TickSize},
	}
}

// UnderlyingResolution counts how derivatives got their underlying name.
type UnderlyingResolution struct {
	ByForeignKey   int `json:"byForeignKey"`
	BySymbolColumn int `json:"bySymbolColumn"`
	ByStrip        int `json:"byStrip"`
	Unresolved     int `json:"unresolved"`
}

// ParseSample is one sampled NFO future.
type ParseSample struct {
	Tradingsymbol  string `json:"tradingsymbol"`
	Name           string `json:"name"`
	Exchange       string `json:"exchange"`
	InstrumentType string `json:"instrument_type"`
	Expiry         string `json:"expiry"`
	Token          int64  `json:"token"`
	SecurityID     int64  `json:"securityId"`
}

// ParseReport is DhanParseReport: what the last parse actually saw.
type ParseReport struct {
	Header                    []string             `json:"header"`
	Columns                   ParseColumns         `json:"columns"`
	MissingColumns            []string             `json:"missingColumns"`
	TotalRows                 int                  `json:"totalRows"`
	Parsed                    int                  `json:"parsed"`
	SkippedTest               int                  `json:"skippedTest"`
	SkippedNoSecurityID       int                  `json:"skippedNoSecurityId"`
	SkippedNoSymbol           int                  `json:"skippedNoSymbol"`
	SkippedSegment            int                  `json:"skippedSegment"`
	SkippedImplausibleExpiry  int                  `json:"skippedImplausibleExpiry"`
	ByExchange                Counts               `json:"byExchange"`
	ByInstrumentType          Counts               `json:"byInstrumentType"`
	FnoFutures                int                  `json:"fnoFutures"`
	NfoCalls                  int                  `json:"nfoCalls"`
	NfoPuts                   int                  `json:"nfoPuts"`
	NseEquities               int                  `json:"nseEquities"`
	Indices                   int                  `json:"indices"`
	DistinctFutureUnderlyings int                  `json:"distinctFutureUnderlyings"`
	UnderlyingResolution      UnderlyingResolution `json:"underlyingResolution"`
	Samples                   []ParseSample        `json:"samples"`
}

var lastParseReport atomic.Pointer[ParseReport]

// GetParseReport is getDhanParseReport: the most recent successful parse's report.
func GetParseReport() *ParseReport { return lastParseReport.Load() }

// ParseScripMaster is parseDhanScripMaster with an explicit clock: header-driven CSV
// parsing, TEST-scrip and 400-day expiry filters, and the second-pass underlying
// resolution (UNDERLYING_SECURITY_ID first). Zone-less fallback dates use time.Local.
// The report is returned and also kept for GetParseReport. A master without a
// SECURITY_ID column is an error; fewer than two non-blank lines give no rows (and
// leave the last report unchanged).
func ParseScripMaster(csv string, now time.Time) ([]Instrument, *ParseReport, error) {
	return parseScripMaster(csv, now, time.Local)
}

func parseScripMaster(csv string, now time.Time, loc *time.Location) ([]Instrument, *ParseReport, error) {
	var lines []string
	for _, l := range strings.Split(csv, "\n") {
		l = strings.TrimSuffix(l, "\r")
		if jsTrim(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) < 2 {
		return []Instrument{}, nil, nil
	}
	header := SplitCSVLine(lines[0])
	norm := make([]string, len(header))
	for i, h := range header {
		norm[i] = normalizeHeader(h)
	}
	cols := ParseColumns{
		ExchID:               columnIndex(norm, "EXCH_ID", "EXCHANGE", "EXCH"),
		Segment:              columnIndex(norm, "SEGMENT", "SEGMENT_NAME"),
		SecurityID:           columnIndex(norm, "SECURITY_ID", "SECURITYID"),
		Instrument:           columnIndex(norm, "INSTRUMENT", "INSTRUMENT_NAME"),
		InstrumentType:       columnIndex(norm, "INSTRUMENT_TYPE", "INSTRUMENTTYPE"),
		SymbolName:           columnIndex(norm, "SYMBOL_NAME", "TRADING_SYMBOL", "SEM_TRADING_SYMBOL"),
		DisplayName:          columnIndex(norm, "DISPLAY_NAME", "SEM_CUSTOM_SYMBOL"),
		UnderlyingSymbol:     columnIndex(norm, "UNDERLYING_SYMBOL", "SEM_UNDERLYING", "UNDERLYING"),
		UnderlyingSecurityID: columnIndex(norm, "UNDERLYING_SECURITY_ID", "SEM_UNDERLYING_SECURITY_ID"),
		LotSize:              columnIndex(norm, "LOT_SIZE", "SEM_LOT_UNITS"),
		ExpiryDate:           columnIndex(norm, "SM_EXPIRY_DATE", "EXPIRY_DATE", "SEM_EXPIRY_DATE"),
		StrikePrice:          columnIndex(norm, "STRIKE_PRICE", "SEM_STRIKE_PRICE"),
		OptionType:           columnIndex(norm, "OPTION_TYPE", "SEM_OPTION_TYPE"),
		TickSize:             columnIndex(norm, "TICK_SIZE", "SEM_TICK_SIZE"),
	}
	if cols.SecurityID < 0 {
		head := header
		if len(head) > 12 {
			head = head[:12]
		}
		return nil, nil, fmt.Errorf("[Dhan] instrument master has no SECURITY_ID column (header: %s…).", strings.Join(head, ","))
	}
	pick := func(cells []string, at int) string {
		if at < 0 || at >= len(cells) {
			return ""
		}
		return jsTrim(cells[at])
	}
	report := &ParseReport{
		Header:         header,
		Columns:        cols,
		MissingColumns: []string{},
		TotalRows:      len(lines) - 1,
		Samples:        []ParseSample{},
	}
	for _, c := range cols.ordered() {
		if c.at < 0 {
			report.MissingColumns = append(report.MissingColumns, c.name)
		}
	}
	nowMs := float64(now.UnixMilli())
	out := []Instrument{}

	for _, line := range lines[1:] {
		cells := SplitCSVLine(line)
		secNum := jsStringToNumber(pick(cells, cols.SecurityID))
		if math.IsNaN(secNum) || math.IsInf(secNum, 0) || secNum <= 0 ||
			secNum != math.Trunc(secNum) || secNum > maxSafeInteger {
			report.SkippedNoSecurityID++
			continue
		}
		securityID := int64(secNum)

		rawSegment := pick(cells, cols.Segment)
		rawExch := pick(cells, cols.ExchID)
		instrumentRaw := pick(cells, cols.Instrument)
		optionType := pick(cells, cols.OptionType)
		instrumentType := NormalizeInstrumentType(instrumentRaw, optionType)
		isIndex := instrumentType == "INDEX" || jsUpper(rawSegment) == "I"

		segment, ok := resolveSegment(rawExch, rawSegment, instrumentRaw, isIndex)
		if !ok {
			report.SkippedSegment++
			continue
		}
		exchange := InternalExchangeFor(segment)
		tradingsymbol := pick(cells, cols.SymbolName)
		if tradingsymbol == "" {
			tradingsymbol = pick(cells, cols.DisplayName)
		}
		if tradingsymbol == "" {
			report.SkippedNoSymbol++
			continue
		}
		underlyingName := pick(cells, cols.UnderlyingSymbol)
		if isTestSymbol(tradingsymbol) || isTestSymbol(underlyingName) {
			report.SkippedTest++
			continue
		}
		expiry := normalizeExpiryIn(pick(cells, cols.ExpiryDate), loc)
		if expiry != "" && instrumentType != "EQ" && instrumentType != "INDEX" {
			expiryMs := jsDateParse(expiry+"T00:00:00+05:30", loc)
			if !math.IsNaN(expiryMs) && expiryMs-nowMs > MaxFutureExpiryDays*86_400_000 {
				report.SkippedImplausibleExpiry++
				continue
			}
		}
		lotSize := jsStringToNumber(pick(cells, cols.LotSize))
		tickSize := jsStringToNumber(pick(cells, cols.TickSize))
		strike := jsStringToNumber(pick(cells, cols.StrikePrice))
		underlyingID := jsStringToNumber(pick(cells, cols.UnderlyingSecurityID))
		positive := func(v, def float64) float64 {
			if !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 {
				return v
			}
			return def
		}
		var underlying *int64
		if !math.IsNaN(underlyingID) && !math.IsInf(underlyingID, 0) && underlyingID > 0 &&
			underlyingID == math.Trunc(underlyingID) && underlyingID <= maxSafeInteger {
			u := int64(underlyingID)
			underlying = &u
		}
		name := underlyingName
		if name == "" {
			name = pick(cells, cols.DisplayName)
		}
		if name == "" {
			name = tradingsymbol
		}
		inst := Instrument{
			Instrument: market.Instrument{
				InstrumentToken: InternalToken(segment, securityID),
				ExchangeToken:   securityID,
				Tradingsymbol:   tradingsymbol,
				Name:            name,
				LastPrice:       0,
				Expiry:          expiry,
				Strike:          positive(strike, 0),
				TickSize:        positive(tickSize, 0.05),
				LotSize:         positive(lotSize, 0),
				InstrumentType:  instrumentType,
				Segment:         internalSegment(exchange, instrumentType),
				Exchange:        exchange,
			},
			DhanSecurityID:           securityID,
			DhanSegment:              segment,
			DhanUnderlyingSecurityID: underlying,
		}
		out = append(out, inst)

		report.Parsed++
		report.ByExchange.inc(exchange)
		report.ByInstrumentType.inc(instrumentType)
		if exchange == "NFO" && instrumentType == "CE" {
			report.NfoCalls++
		}
		if exchange == "NFO" && instrumentType == "PE" {
			report.NfoPuts++
		}
		if exchange == "NSE" && instrumentType == "EQ" {
			report.NseEquities++
		}
		if instrumentType == "INDEX" {
			report.Indices++
		}
		if exchange == "NFO" && instrumentType == "FUT" {
			report.FnoFutures++
			if len(report.Samples) < 8 {
				report.Samples = append(report.Samples, ParseSample{
					Tradingsymbol: inst.Tradingsymbol, Name: inst.Name, Exchange: inst.Exchange,
					InstrumentType: inst.InstrumentType, Expiry: inst.Expiry,
					Token: inst.InstrumentToken, SecurityID: inst.DhanSecurityID,
				})
			}
		}
	}

	// Second pass: canonical underlying resolution (equity → the equity's trading
	// symbol; index → the declared/stripped underlying symbol, never "NIFTY 50").
	type spot struct {
		symbol  string
		isIndex bool
	}
	spotBySecurityID := map[int64]spot{}
	equitySpotSymbols := map[string]bool{}
	for i := range out {
		inst := &out[i]
		isIndexSpot := inst.InstrumentType == "INDEX"
		if inst.InstrumentType == "EQ" || isIndexSpot {
			spotBySecurityID[inst.DhanSecurityID] = spot{symbol: NormalizeUnderlyingKey(inst.Tradingsymbol), isIndex: isIndexSpot}
			if !isIndexSpot {
				equitySpotSymbols[NormalizeUnderlyingKey(inst.Tradingsymbol)] = true
			}
		}
	}
	var res UnderlyingResolution
	for i := range out {
		inst := &out[i]
		t := inst.InstrumentType
		if t != "FUT" && t != "CE" && t != "PE" {
			continue
		}
		declared := NormalizeUnderlyingKey(inst.Name)
		stripped := StripContractSuffix(inst.Tradingsymbol)
		var sp spot
		found := false
		if inst.DhanUnderlyingSecurityID != nil {
			sp, found = spotBySecurityID[*inst.DhanUnderlyingSecurityID]
		}
		if found && !sp.isIndex {
			inst.Name = sp.symbol
			res.ByForeignKey++
			continue
		}
		if found && sp.isIndex {
			idx := declared
			if idx == "" {
				idx = stripped
			}
			if idx != "" {
				inst.Name = idx
				res.ByForeignKey++
				continue
			}
		}
		if declared != "" && equitySpotSymbols[declared] {
			inst.Name = declared
			res.BySymbolColumn++
			continue
		}
		if stripped != "" && equitySpotSymbols[stripped] {
			inst.Name = stripped
			res.ByStrip++
			continue
		}
		if declared != "" {
			inst.Name = declared
		} else {
			inst.Name = stripped
		}
		if inst.Name == "" {
			res.Unresolved++
		}
	}
	report.UnderlyingResolution = res
	distinct := map[string]bool{}
	for i := range out {
		if out[i].InstrumentType == "FUT" && out[i].Name != "" {
			distinct[out[i].Name] = true
		}
	}
	report.DistinctFutureUnderlyings = len(distinct)

	lastParseReport.Store(report)
	logf("[Dhan] instrument master parsed: %d/%d rows, %d NFO futures, skipped %d test / %d long-dated / %d unknown-segment / %d no-symbol.",
		report.Parsed, report.TotalRows, report.FnoFutures, report.SkippedTest, report.SkippedImplausibleExpiry,
		report.SkippedSegment, report.SkippedNoSymbol)
	if len(report.MissingColumns) > 0 {
		head := header
		if len(head) > 20 {
			head = head[:20]
		}
		logf("[Dhan] instrument master is MISSING expected columns: %s. Header was: %s",
			strings.Join(report.MissingColumns, ", "), strings.Join(head, ","))
	}
	logf("[Dhan] underlying resolution: %d by foreign key, %d by symbol column, %d by suffix strip, %d unresolved; %d distinct futures underlyings.",
		res.ByForeignKey, res.BySymbolColumn, res.ByStrip, res.Unresolved, report.DistinctFutureUnderlyings)
	if report.DistinctFutureUnderlyings < 50 {
		logf("[Dhan] ONLY %d distinct futures underlyings resolved (expected 180+). The board will be almost empty. This is an underlying-JOIN failure, not a market condition — inspect GET /api/dhan/instruments/diagnostics.",
			report.DistinctFutureUnderlyings)
	}
	if report.FnoFutures < 100 {
		logf("[Dhan] ONLY %d NFO futures were classified (expected 500+) — the master layout has probably changed. Board and scanner will be incomplete. Inspect GET /api/dhan/instruments/diagnostics.",
			report.FnoFutures)
	}
	return out, report, nil
}

const monthAlt = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC"

var (
	contractTokenRe = regexp.MustCompile(`^(?:FUT|CE|PE|[0-9]+(?:\.[0-9]+)?|(?:` + monthAlt + `)[0-9]{0,4}|[0-9]{2,4}(?:` + monthAlt + `))$`)
	strikeTailRe    = regexp.MustCompile(`^[0-9]{2,8}(?:\.[0-9]+)?$`)
	months          = strings.Split(monthAlt, "|")
)

func endsWithMonth(s string) bool {
	if len(s) < 3 {
		return false
	}
	tail := s[len(s)-3:]
	for _, m := range months {
		if tail == m {
			return true
		}
	}
	return false
}

func isASCIIDigit(c byte) bool { return c >= '0' && c <= '9' }
func isASCIIUpper(c byte) bool { return c >= 'A' && c <= 'Z' }

// StripContractSuffix is stripContractSuffix: drop trailing contract components
// (FUT/CE/PE, strikes, expiries, month tokens) back to the bare underlying, first as
// whole tokens, then, where a digit or month marks the boundary, inside one token.
// The TypeScript uses regex look-behind (absent from RE2), so stage 2 is hand-coded.
func StripContractSuffix(tradingsymbol string) string {
	upper := jsUpper(jsTrim(tradingsymbol))
	// Stage 1: whole tokens, split on /[\s_\-]+/.
	var tokens []string
	var cur strings.Builder
	for _, r := range upper {
		if r == '_' || r == '-' || jsIsSpace(r) {
			if cur.Len() > 0 {
				tokens = append(tokens, cur.String())
				cur.Reset()
			}
			continue
		}
		cur.WriteRune(r)
	}
	if cur.Len() > 0 {
		tokens = append(tokens, cur.String())
	}
	end := len(tokens)
	for end > 1 && contractTokenRe.MatchString(tokens[end-1]) {
		end--
	}
	value := strings.Join(tokens[:end], "-")

	// Stage 2: concatenated components ("BHEL26SEPFUT"), at most 8 passes.
	for pass := 0; pass < 8; pass++ {
		before := value
		value = stripInstrumentSuffix(value)
		value = stripMonthSuffix(value)
		value = stripNumericSuffix(value)
		if value == before {
			break
		}
	}
	return strings.TrimRightFunc(value, func(r rune) bool { return r == '-' || jsIsSpace(r) })
}

// stripInstrumentSuffix is value.replace(/(?<=\d|MONTH)(?:FUT|CE|PE)$/, "").
func stripInstrumentSuffix(v string) string {
	for _, suf := range []string{"FUT", "CE", "PE"} {
		if !strings.HasSuffix(v, suf) {
			continue
		}
		p := len(v) - len(suf)
		if (p >= 1 && isASCIIDigit(v[p-1])) || endsWithMonth(v[:p]) {
			return v[:p]
		}
	}
	return v
}

// stripMonthSuffix is value.replace(/(?<=[A-Z0-9])(?:MONTH)$/, "").
func stripMonthSuffix(v string) string {
	if !endsWithMonth(v) {
		return v
	}
	p := len(v) - 3
	if p >= 1 && (isASCIIUpper(v[p-1]) || isASCIIDigit(v[p-1])) {
		return v[:p]
	}
	return v
}

// stripNumericSuffix is value.replace(/(?<=[A-Z])\d{2,8}(?:\.\d+)?$/, ""): the
// leftmost position preceded by a letter whose remainder is the whole numeric tail.
func stripNumericSuffix(v string) string {
	for p := 1; p < len(v); p++ {
		if isASCIIUpper(v[p-1]) && isASCIIDigit(v[p]) && strikeTailRe.MatchString(v[p:]) {
			return v[:p]
		}
	}
	return v
}

// NormalizeUnderlyingKey is normalizeUnderlyingKey: trim, upper-case, collapse spaces.
func NormalizeUnderlyingKey(value string) string {
	return collapseJSSpace(jsUpper(jsTrim(value)))
}

// resolveSegment combines EXCH_ID, the SEGMENT code and the instrument class.
func resolveSegment(exch, segmentCode, instrument string, isIndex bool) (Segment, bool) {
	if isIndex {
		return SegmentIdxI, true
	}
	ex := jsUpper(jsTrim(exch))
	seg := jsUpper(jsTrim(segmentCode))
	inst := jsUpper(jsTrim(instrument))
	derivative := seg == "D" || strings.Contains(inst, "FUT") || strings.Contains(inst, "OPT")
	switch ex {
	case "NSE":
		if derivative {
			return SegmentNSEFNO, true
		}
		if seg == "C" {
			return SegmentNSECurrency, true
		}
		return SegmentNSEEQ, true
	case "BSE":
		if derivative {
			return SegmentBSEFNO, true
		}
		if seg == "C" {
			return SegmentBSECurrency, true
		}
		return SegmentBSEEQ, true
	case "MCX":
		return SegmentMCXComm, true
	}
	return SegmentFor(ex, isIndex)
}

/* ---------------------------- instrument store ----------------------------- */

// InstrumentStoreOptions configure an InstrumentStore.
type InstrumentStoreOptions struct {
	TTL          time.Duration // default 1 h
	URLs         []string      // default detailed master, then the plain one
	Client       *http.Client  // default a plain client
	FetchTimeout time.Duration // per URL, default 60 s
	Now          func() time.Time
}

// InstrumentStore is DhanInstrumentStore: the cached master with a reverse index and
// a single-flight load shared by concurrent callers (also when forced).
type InstrumentStore struct {
	opts InstrumentStoreOptions

	mu       sync.RWMutex
	all      []Instrument
	byToken  map[int64]int
	loadedAt int64
	inFlight *loadCall
}

type loadCall struct {
	done chan struct{}
	rows []Instrument
	err  error
}

// NewInstrumentStore builds an empty store.
func NewInstrumentStore(opts InstrumentStoreOptions) *InstrumentStore {
	if opts.TTL <= 0 {
		opts.TTL = time.Hour
	}
	if len(opts.URLs) == 0 {
		opts.URLs = []string{ScripMasterURL, ScripMasterFallbackURL}
	}
	if opts.Client == nil {
		opts.Client = &http.Client{}
	}
	if opts.FetchTimeout <= 0 {
		opts.FetchTimeout = 60 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &InstrumentStore{opts: opts, all: []Instrument{}, byToken: map[int64]int{}}
}

// Load returns the cached instruments while fresh and non-empty (unless force), else
// fetches the master; concurrent callers share one in-flight fetch.
func (s *InstrumentStore) Load(ctx context.Context, force bool) ([]Instrument, error) {
	s.mu.Lock()
	fresh := s.opts.Now().UnixMilli()-s.loadedAt < s.opts.TTL.Milliseconds() && len(s.all) > 0
	if fresh && !force {
		rows := s.all
		s.mu.Unlock()
		return rows, nil
	}
	call := s.inFlight
	if call == nil {
		call = &loadCall{done: make(chan struct{})}
		s.inFlight = call
		go s.runLoad(call)
	}
	s.mu.Unlock()
	select {
	case <-call.done:
		return call.rows, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *InstrumentStore) runLoad(call *loadCall) {
	rows, err := s.fetchMaster()
	s.mu.Lock()
	if err == nil {
		s.setLocked(rows)
	}
	s.inFlight = nil
	call.rows, call.err = rows, err
	s.mu.Unlock()
	close(call.done)
}

func (s *InstrumentStore) fetchMaster() ([]Instrument, error) {
	var lastErr error
	for _, u := range s.opts.URLs {
		rows, err := s.fetchOne(u)
		if err == nil {
			return rows, nil
		}
		lastErr = err
		logf("[Dhan] instrument master %s failed: %v", u, err)
	}
	msg := "<nil>"
	if lastErr != nil {
		msg = lastErr.Error()
	}
	return nil, fmt.Errorf("[Dhan] could not load the instrument master: %s", msg)
}

func (s *InstrumentStore) fetchOne(u string) ([]Instrument, error) {
	ctx, cancel := context.WithTimeout(context.Background(), s.opts.FetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	res, err := s.opts.Client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("This operation was aborted")
		}
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	rows, _, err := ParseScripMaster(strings.TrimPrefix(string(b), "\ufeff"), s.opts.Now())
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("parsed zero instruments")
	}
	return rows, nil
}

func (s *InstrumentStore) setLocked(rows []Instrument) {
	s.all = rows
	s.byToken = make(map[int64]int, len(rows))
	for i := range rows {
		s.byToken[rows[i].InstrumentToken] = i // later duplicates win, as with new Map(...)
	}
	s.loadedAt = s.opts.Now().UnixMilli()
}

// SetInstruments replaces the universe as a completed load would (seeding for tests
// and callers that already hold a parsed master).
func (s *InstrumentStore) SetInstruments(rows []Instrument) {
	s.mu.Lock()
	s.setLocked(rows)
	s.mu.Unlock()
}

// Instruments returns the loaded universe (shared; treat as read-only).
func (s *InstrumentStore) Instruments() []Instrument {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.all
}

// Size is the number of loaded instruments.
func (s *InstrumentStore) Size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.all)
}

// LastLoadedAt is the epoch ms of the last successful load, nil when never loaded.
func (s *InstrumentStore) LastLoadedAt() *int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.loadedAt == 0 {
		return nil
	}
	v := s.loadedAt
	return &v
}

// Get is internal token → instrument.
func (s *InstrumentStore) Get(token int64) (Instrument, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	i, ok := s.byToken[token]
	if !ok {
		return Instrument{}, false
	}
	return s.all[i], true
}

// Identify is internal token → (segment, securityId): the master first, else the
// arithmetic decode so a subscription survives a late master.
func (s *InstrumentStore) Identify(token int64) (FeedInstrument, bool) {
	if inst, ok := s.Get(token); ok {
		return FeedInstrument{Segment: inst.DhanSegment, SecurityID: inst.DhanSecurityID}, true
	}
	return IdentityFromToken(token)
}

// Clear forgets the universe.
func (s *InstrumentStore) Clear() {
	s.mu.Lock()
	s.all = []Instrument{}
	s.byToken = map[int64]int{}
	s.loadedAt = 0
	s.mu.Unlock()
}
