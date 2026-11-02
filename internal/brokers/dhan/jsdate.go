package dhan

import (
	"fmt"
	"math"
	"time"
)

// jsDateParse is V8's Date.parse: the ES5 ISO format first, then V8's legacy
// (Safari-compatible) parser for anything else, with zone-less date-times read in loc
// (Node's process time zone; time.Local in production). It returns NaN when V8 would.
//
// Ported from V8 src/date/dateparser{.h,.cc,-inl.h}: same tokenizer, same keyword
// table (month names by 3-letter prefix, am/pm, ut/utc/z/gmt and the US zones, "t"),
// same day/time/zone composers, two-digit year mapping and 24:00 rule.
func jsDateParse(s string, loc *time.Location) float64 {
	p := &dateParser{sc: newDateScanner(s)}
	ok, fields := p.parse()
	if !ok {
		return math.NaN()
	}
	return composeDate(fields, loc)
}

const dpNone = math.MinInt32

type dtTag uint8

const (
	dtInvalid dtTag = iota
	dtUnknown
	dtNumber
	dtSymbol
	dtWhiteSpace
	dtKeyword
	dtEnd
)

type kwType uint8

const (
	kwInvalid kwType = iota
	kwMonth
	kwTimeZone
	kwTimeSep
	kwAmPm
)

type dateToken struct {
	tag    dtTag
	length int
	value  int  // number value, keyword value
	sym    rune // symbol
	kw     kwType
}

func (t dateToken) isNumber() bool                 { return t.tag == dtNumber }
func (t dateToken) isFixedLengthNumber(n int) bool { return t.tag == dtNumber && t.length == n }
func (t dateToken) isSymbol(c rune) bool           { return t.tag == dtSymbol && t.sym == c }
func (t dateToken) isAsciiSign() bool              { return t.tag == dtSymbol && (t.sym == '+' || t.sym == '-') }
func (t dateToken) asciiSign() int {
	if t.sym == '-' {
		return -1
	}
	return 1
}
func (t dateToken) isWhiteSpace() bool          { return t.tag == dtWhiteSpace }
func (t dateToken) isKeyword() bool             { return t.tag == dtKeyword }
func (t dateToken) isKeywordType(k kwType) bool { return t.tag == dtKeyword && t.kw == k }
func (t dateToken) isKeywordZ() bool {
	return t.tag == dtKeyword && t.kw == kwTimeZone && t.length == 1 && t.value == 0
}
func (t dateToken) isEnd() bool { return t.tag == dtEnd }

var dateKeywords = []struct {
	prefix string
	kw     kwType
	value  int
}{
	{"jan", kwMonth, 1}, {"feb", kwMonth, 2}, {"mar", kwMonth, 3}, {"apr", kwMonth, 4},
	{"may", kwMonth, 5}, {"jun", kwMonth, 6}, {"jul", kwMonth, 7}, {"aug", kwMonth, 8},
	{"sep", kwMonth, 9}, {"oct", kwMonth, 10}, {"nov", kwMonth, 11}, {"dec", kwMonth, 12},
	{"am", kwAmPm, 0}, {"pm", kwAmPm, 12},
	{"ut", kwTimeZone, 0}, {"utc", kwTimeZone, 0}, {"z", kwTimeZone, 0}, {"gmt", kwTimeZone, 0},
	{"cdt", kwTimeZone, -5}, {"cst", kwTimeZone, -6}, {"edt", kwTimeZone, -4}, {"est", kwTimeZone, -5},
	{"mdt", kwTimeZone, -6}, {"mst", kwTimeZone, -7}, {"pdt", kwTimeZone, -7}, {"pst", kwTimeZone, -8},
	{"t", kwTimeSep, 0},
}

type dateScanner struct {
	in   []rune
	pos  int
	next dateToken
}

func newDateScanner(s string) *dateScanner {
	sc := &dateScanner{in: []rune(s)}
	sc.next = sc.scan()
	return sc
}

func (sc *dateScanner) ch() rune {
	if sc.pos < len(sc.in) {
		return sc.in[sc.pos]
	}
	return 0
}

func (sc *dateScanner) atEnd() bool { return sc.pos >= len(sc.in) }

func (sc *dateScanner) scan() dateToken {
	pre := sc.pos
	if sc.atEnd() {
		return dateToken{tag: dtEnd}
	}
	c := sc.ch()
	if c >= '0' && c <= '9' {
		n := 0
		digits := 0
		for sc.ch() == '0' { // leading zeros are skipped, but counted in the length
			sc.pos++
		}
		for c := sc.ch(); c >= '0' && c <= '9'; c = sc.ch() {
			if digits < 9 {
				n = n*10 + int(c-'0')
			}
			digits++
			sc.pos++
		}
		return dateToken{tag: dtNumber, value: n, length: sc.pos - pre}
	}
	switch c {
	case ':', '-', '+', '.', ')':
		sc.pos++
		return dateToken{tag: dtSymbol, sym: c}
	}
	if c >= 'A' && !jsIsSpace(c) {
		var prefix [3]rune
		length := 0
		for c := sc.ch(); !sc.atEnd() && c >= 'A' && !jsIsSpace(c); c = sc.ch() {
			if length < 3 {
				prefix[length] = c | 0x20
			}
			length++
			sc.pos++
		}
		kw, value := kwInvalid, 0
		for _, k := range dateKeywords {
			var want [3]rune
			for i, r := range k.prefix {
				want[i] = r
			}
			if want == prefix && (length <= 3 || k.kw == kwMonth) {
				kw, value = k.kw, k.value
				break
			}
		}
		return dateToken{tag: dtKeyword, kw: kw, value: value, length: length}
	}
	if jsIsSpace(c) {
		sc.pos++
		return dateToken{tag: dtWhiteSpace, length: 1}
	}
	if c == '(' {
		balance := 0
		for {
			switch sc.ch() {
			case ')':
				balance--
			case '(':
				balance++
			}
			sc.pos++
			if balance <= 0 || sc.atEnd() {
				break
			}
		}
		return dateToken{tag: dtUnknown}
	}
	sc.pos++
	return dateToken{tag: dtUnknown}
}

func (sc *dateScanner) Next() dateToken {
	t := sc.next
	sc.next = sc.scan()
	return t
}

func (sc *dateScanner) Peek() dateToken { return sc.next }

func (sc *dateScanner) SkipSymbol(c rune) bool {
	if sc.next.isSymbol(c) {
		sc.Next()
		return true
	}
	return false
}

func between(x, lo, hi int) bool { return x >= lo && x <= hi }
func isMonth(x int) bool         { return between(x, 1, 12) }
func isDay(x int) bool           { return between(x, 1, 31) }
func isHour(x int) bool          { return between(x, 0, 23) }
func isMinute(x int) bool        { return between(x, 0, 59) }
func isSecond(x int) bool        { return between(x, 0, 59) }
func isHour12(x int) bool        { return between(x, 0, 12) }
func isMillisecond(x int) bool   { return between(x, 0, 999) }

type dayComposer struct {
	comp       [3]int
	index      int
	namedMonth int
	isISO      bool
}

func (d *dayComposer) empty() bool { return d.index == 0 }
func (d *dayComposer) add(n int) bool {
	if d.index < 3 {
		d.comp[d.index] = n
		d.index++
		return true
	}
	return false
}

func (d *dayComposer) write(out *dateFields) bool {
	if d.index < 1 {
		return false
	}
	for d.index < 3 {
		d.comp[d.index] = 1
		d.index++
	}
	year, month, day := 0, dpNone, dpNone
	if d.namedMonth == dpNone {
		if d.isISO || (d.index == 3 && !isDay(d.comp[0])) {
			year, month, day = d.comp[0], d.comp[1], d.comp[2]
		} else {
			month, day = d.comp[0], d.comp[1]
			if d.index == 3 {
				year = d.comp[2]
			}
		}
	} else {
		month = d.namedMonth
		if d.index == 1 {
			day = d.comp[0]
		} else if !isDay(d.comp[0]) {
			year, day = d.comp[0], d.comp[1]
		} else {
			day, year = d.comp[0], d.comp[1]
		}
	}
	if !d.isISO {
		if between(year, 0, 49) {
			year += 2000
		} else if between(year, 50, 99) {
			year += 1900
		}
	}
	if !between(year, -(1<<30), (1<<30)-1) || !isMonth(month) || !isDay(day) {
		return false
	}
	out.year, out.month, out.day = year, month-1, day
	return true
}

type timeComposer struct {
	comp       [4]int
	index      int
	hourOffset int
}

func (t *timeComposer) empty() bool { return t.index == 0 }
func (t *timeComposer) expecting(n int) bool {
	return (t.index == 1 && isMinute(n)) || (t.index == 2 && isSecond(n)) || (t.index == 3 && isMillisecond(n))
}
func (t *timeComposer) add(n int) bool {
	if t.index < 4 {
		t.comp[t.index] = n
		t.index++
		return true
	}
	return false
}
func (t *timeComposer) addFinal(n int) bool {
	if !t.add(n) {
		return false
	}
	for t.index < 4 {
		t.comp[t.index] = 0
		t.index++
	}
	return true
}

func (t *timeComposer) write(out *dateFields) bool {
	for t.index < 4 {
		t.comp[t.index] = 0
		t.index++
	}
	hour, minute, second, ms := t.comp[0], t.comp[1], t.comp[2], t.comp[3]
	if t.hourOffset != dpNone {
		if !isHour12(hour) {
			return false
		}
		hour %= 12
		hour += t.hourOffset
	}
	if !isHour(hour) || !isMinute(minute) || !isSecond(second) || !isMillisecond(ms) {
		if hour != 24 || minute != 0 || second != 0 || ms != 0 {
			return false
		}
	}
	out.hour, out.minute, out.second, out.ms = hour, minute, second, ms
	return true
}

type tzComposer struct {
	sign, hour, minute int
}

func (z *tzComposer) set(offsetHours int) {
	if offsetHours < 0 {
		z.sign = -1
	} else {
		z.sign = 1
	}
	z.hour = offsetHours * z.sign
	z.minute = 0
}
func (z *tzComposer) setSign(s int) {
	if s < 0 {
		z.sign = -1
	} else {
		z.sign = 1
	}
}
func (z *tzComposer) expecting(n int) bool {
	return z.hour != dpNone && z.minute == dpNone && isMinute(n)
}
func (z *tzComposer) isUTC() bool { return z.hour == 0 && z.minute == 0 }
func (z *tzComposer) empty() bool { return z.hour == dpNone }
func (z *tzComposer) write(out *dateFields) bool {
	if z.sign != dpNone {
		if z.hour == dpNone {
			z.hour = 0
		}
		if z.minute == dpNone {
			z.minute = 0
		}
		total := uint64(uint32(z.hour))*3600 + uint64(uint32(z.minute))*60
		if total > (1<<30)-1 {
			return false
		}
		secs := int(total)
		if z.sign < 0 {
			secs = -secs
		}
		out.utcOffset = secs
		out.hasOffset = true
	} else {
		out.hasOffset = false
	}
	return true
}

type dateFields struct {
	year, month, day, hour, minute, second, ms int
	utcOffset                                  int
	hasOffset                                  bool
}

type dateParser struct {
	sc   *dateScanner
	day  dayComposer
	time timeComposer
	tz   tzComposer
}

func readMilliseconds(t dateToken) int {
	n, length := t.value, t.length
	if length < 3 {
		if length == 1 {
			n *= 100
		} else if length == 2 {
			n *= 10
		}
	} else if length > 3 {
		if length > 9 {
			length = 9
		}
		factor := 1
		for {
			factor *= 10
			length--
			if length <= 3 {
				break
			}
		}
		n /= factor
	}
	return n
}

func (p *dateParser) parse() (bool, dateFields) {
	p.day.namedMonth = dpNone
	p.time.hourOffset = dpNone
	p.tz = tzComposer{sign: dpNone, hour: dpNone, minute: dpNone}
	var out dateFields
	sc := p.sc

	next := p.parseES5()
	if next.tag == dtInvalid {
		return false, out
	}
	hasReadNumber := !p.day.empty()
	for tok := next; !tok.isEnd(); tok = sc.Next() {
		switch {
		case tok.isNumber():
			hasReadNumber = true
			n := tok.value
			if sc.SkipSymbol(':') {
				if sc.SkipSymbol(':') {
					if !p.time.empty() {
						return false, out
					}
					p.time.add(n)
					p.time.add(0)
				} else {
					if !p.time.add(n) {
						return false, out
					}
					if sc.Peek().isSymbol('.') {
						sc.Next()
					}
				}
			} else if sc.SkipSymbol('.') && p.time.expecting(n) {
				p.time.add(n)
				if !sc.Peek().isNumber() {
					return false, out
				}
				ms := readMilliseconds(sc.Next())
				if ms < 0 {
					return false, out
				}
				p.time.addFinal(ms)
			} else if p.tz.expecting(n) {
				p.tz.minute = n
			} else if p.time.expecting(n) {
				p.time.addFinal(n)
				pk := sc.Peek()
				if !pk.isEnd() && !pk.isWhiteSpace() && !pk.isKeywordZ() && !pk.isAsciiSign() {
					return false, out
				}
			} else {
				if !p.day.add(n) {
					return false, out
				}
				sc.SkipSymbol('-')
			}
		case tok.isKeyword():
			if tok.kw == kwAmPm && !p.time.empty() {
				p.time.hourOffset = tok.value
			} else if tok.kw == kwMonth {
				p.day.namedMonth = tok.value
				sc.SkipSymbol('-')
			} else if tok.kw == kwTimeZone && hasReadNumber {
				p.tz.set(tok.value)
			} else {
				if hasReadNumber {
					return false, out
				}
				if sc.Peek().isNumber() {
					return false, out
				}
			}
		case tok.isAsciiSign() && (p.tz.isUTC() || !p.time.empty()):
			p.tz.setSign(tok.asciiSign())
			n, length := 0, 0
			if sc.Peek().isNumber() {
				t := sc.Next()
				length = t.length
				n = t.value
			}
			hasReadNumber = true
			if sc.Peek().isSymbol(':') {
				p.tz.hour = n
				p.tz.minute = dpNone
			} else if length == 2 || length == 1 {
				p.tz.hour = n
				p.tz.minute = 0
			} else if length == 4 || length == 3 {
				p.tz.hour = n / 100
				p.tz.minute = n % 100
			} else {
				return false, out
			}
		case (tok.isAsciiSign() || tok.isSymbol(')')) && hasReadNumber:
			return false, out
		default:
			// other characters and white space are ignored
		}
	}
	ok := p.day.write(&out) && p.time.write(&out) && p.tz.write(&out)
	return ok, out
}

// parseES5 is ParseES5DateTime: it consumes a leading ES5 ISO date(-time) and returns
// the first token it could not handle (end of input on full success, invalid when the
// string committed to the ISO time syntax and broke it).
func (p *dateParser) parseES5() dateToken {
	sc := p.sc
	if sc.Peek().isAsciiSign() {
		signTok := sc.Next()
		if !sc.Peek().isFixedLengthNumber(6) {
			return signTok
		}
		sign := signTok.asciiSign()
		year := sc.Next().value
		if sign < 0 && year == 0 {
			return signTok
		}
		p.day.add(sign * year)
	} else if sc.Peek().isFixedLengthNumber(4) {
		p.day.add(sc.Next().value)
	} else {
		return sc.Next()
	}
	if sc.SkipSymbol('-') {
		if !sc.Peek().isFixedLengthNumber(2) || !isMonth(sc.Peek().value) {
			return sc.Next()
		}
		p.day.add(sc.Next().value)
		if sc.SkipSymbol('-') {
			if !sc.Peek().isFixedLengthNumber(2) || !isDay(sc.Peek().value) {
				return sc.Next()
			}
			p.day.add(sc.Next().value)
		}
	}
	if !sc.Peek().isKeywordType(kwTimeSep) {
		if !sc.Peek().isEnd() {
			return sc.Next()
		}
	} else {
		sc.Next()
		if !sc.Peek().isFixedLengthNumber(2) || !between(sc.Peek().value, 0, 24) {
			return dateToken{tag: dtInvalid}
		}
		hourIs24 := sc.Peek().value == 24
		p.time.add(sc.Next().value)
		if !sc.SkipSymbol(':') {
			return dateToken{tag: dtInvalid}
		}
		if !sc.Peek().isFixedLengthNumber(2) || !isMinute(sc.Peek().value) || (hourIs24 && sc.Peek().value > 0) {
			return dateToken{tag: dtInvalid}
		}
		p.time.add(sc.Next().value)
		if sc.SkipSymbol(':') {
			if !sc.Peek().isFixedLengthNumber(2) || !isSecond(sc.Peek().value) || (hourIs24 && sc.Peek().value > 0) {
				return dateToken{tag: dtInvalid}
			}
			p.time.add(sc.Next().value)
			if sc.SkipSymbol('.') {
				if !sc.Peek().isNumber() || (hourIs24 && sc.Peek().value > 0) {
					return dateToken{tag: dtInvalid}
				}
				p.time.add(readMilliseconds(sc.Next()))
			}
		}
		if sc.Peek().isKeywordZ() {
			sc.Next()
			p.tz.set(0)
		} else if sc.Peek().isSymbol('+') || sc.Peek().isSymbol('-') {
			if sc.Next().sym == '+' {
				p.tz.setSign(1)
			} else {
				p.tz.setSign(-1)
			}
			if sc.Peek().isFixedLengthNumber(4) {
				hm := sc.Next().value
				h, m := hm/100, hm%100
				if !isHour(h) || !isMinute(m) {
					return dateToken{tag: dtInvalid}
				}
				p.tz.hour, p.tz.minute = h, m
			} else {
				if !sc.Peek().isFixedLengthNumber(2) || !isHour(sc.Peek().value) {
					return dateToken{tag: dtInvalid}
				}
				p.tz.hour = sc.Next().value
				if !sc.SkipSymbol(':') {
					return dateToken{tag: dtInvalid}
				}
				if !sc.Peek().isFixedLengthNumber(2) || !isMinute(sc.Peek().value) {
					return dateToken{tag: dtInvalid}
				}
				p.tz.minute = sc.Next().value
			}
		}
		if !sc.Peek().isEnd() {
			return dateToken{tag: dtInvalid}
		}
	}
	// Date-only forms are UTC; date-time forms without an offset are local time.
	if p.tz.empty() && p.time.empty() {
		p.tz.set(0)
	}
	p.day.isISO = true
	return dateToken{tag: dtEnd}
}

const maxTimeMs = 8.64e15

// composeDate is MakeDay/MakeTime/MakeDate plus the local-time conversion and TimeClip.
func composeDate(f dateFields, loc *time.Location) float64 {
	if f.year > 300000 || f.year < -300000 {
		return math.NaN()
	}
	if f.hasOffset {
		t := time.Date(f.year, time.Month(f.month+1), f.day, f.hour, f.minute, f.second, f.ms*1e6, time.UTC)
		ms := float64(t.UnixMilli()) - float64(f.utcOffset)*1000
		if math.Abs(ms) > maxTimeMs {
			return math.NaN()
		}
		return ms
	}
	if loc == nil {
		loc = time.Local
	}
	t := time.Date(f.year, time.Month(f.month+1), f.day, f.hour, f.minute, f.second, f.ms*1e6, loc)
	ms := float64(t.UnixMilli())
	if math.Abs(ms) > maxTimeMs {
		return math.NaN()
	}
	return ms
}

// jsISOString is Date.prototype.toISOString for a valid time value.
func jsISOString(ms float64) string {
	t := time.UnixMilli(int64(ms)).UTC()
	y := t.Year()
	var year string
	switch {
	case y >= 0 && y <= 9999:
		year = fmt.Sprintf("%04d", y)
	case y < 0:
		year = fmt.Sprintf("-%06d", -y)
	default:
		year = fmt.Sprintf("+%06d", y)
	}
	return fmt.Sprintf("%s-%02d-%02dT%02d:%02d:%02d.%03dZ", year, int(t.Month()), t.Day(),
		t.Hour(), t.Minute(), t.Second(), t.Nanosecond()/1e6)
}
