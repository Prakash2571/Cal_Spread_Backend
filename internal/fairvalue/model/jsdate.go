package model

import (
	"math"
	"strconv"
	"time"
)

// maxTimeMs is the ECMAScript time value range (+-8.64e15 ms).
const maxTimeMs = 8.64e15

// DateParse is Date.parse for the ECMAScript date-time string format that V8 accepts:
// YYYY, YYYY-MM, YYYY-MM-DD (UTC), optionally followed by THH:mm[:ss[.fraction]] and
// Z or +-HH:mm / +-HHmm; a date-time without an offset is local time. Days 1-31 roll
// over in every month (V8 accepts 2026-02-30 as March 2) and 24:00:00 is the next
// midnight. Anything else is NaN; V8's legacy fallback formats never occur in Fair
// Value inputs (they are produced by toISOString or validated by utcTimestamp).
func DateParse(s string) float64 {
	p := dateParser{s: s}
	if ms, ok := p.parse(); ok {
		return ms
	}
	return math.NaN()
}

type dateParser struct {
	s   string
	pos int
}

func (p *dateParser) digits(n int) (int, bool) {
	if p.pos+n > len(p.s) {
		return 0, false
	}
	v := 0
	for i := 0; i < n; i++ {
		c := p.s[p.pos+i]
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + int(c-'0')
	}
	p.pos += n
	return v, true
}

func (p *dateParser) peek() byte {
	if p.pos < len(p.s) {
		return p.s[p.pos]
	}
	return 0
}

func (p *dateParser) parse() (float64, bool) {
	sign := 1
	var year int
	var ok bool
	if c := p.peek(); c == '+' || c == '-' {
		if c == '-' {
			sign = -1
		}
		p.pos++
		if year, ok = p.digits(6); !ok {
			return 0, false
		}
		if sign < 0 && year == 0 {
			return 0, false // -000000 is invalid
		}
		year *= sign
	} else if year, ok = p.digits(4); !ok {
		return 0, false
	}
	month, day := 1, 1
	if p.peek() == '-' {
		p.pos++
		if month, ok = p.digits(2); !ok {
			return 0, false
		}
		if p.peek() == '-' {
			p.pos++
			if day, ok = p.digits(2); !ok {
				return 0, false
			}
		}
	}
	if month < 1 || month > 12 || day < 1 || day > 31 {
		return 0, false
	}
	hour, minute, second, millis := 0, 0, 0, 0
	hasTime := false
	offsetMs := 0
	hasOffset := false
	if c := p.peek(); c == 'T' || c == 't' || c == ' ' {
		p.pos++
		hasTime = true
		if hour, ok = p.digits(2); !ok {
			return 0, false
		}
		if p.peek() != ':' {
			return 0, false
		}
		p.pos++
		if minute, ok = p.digits(2); !ok {
			return 0, false
		}
		if p.peek() == ':' {
			p.pos++
			if second, ok = p.digits(2); !ok {
				return 0, false
			}
			if p.peek() == '.' {
				p.pos++
				start := p.pos
				for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
					p.pos++
				}
				frac := p.s[start:p.pos]
				if frac == "" {
					return 0, false
				}
				for len(frac) < 3 {
					frac += "0"
				}
				millis, _ = strconv.Atoi(frac[:3])
			}
		}
		if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute != 0 || second != 0 || millis != 0)) {
			return 0, false
		}
		switch c := p.peek(); c {
		case 'Z', 'z':
			p.pos++
			hasOffset = true
		case '+', '-':
			p.pos++
			oh, ok := p.digits(2)
			if !ok {
				return 0, false
			}
			if p.peek() == ':' {
				p.pos++
			}
			om, ok := p.digits(2)
			if !ok || oh > 23 || om > 59 {
				return 0, false
			}
			offsetMs = (oh*60 + om) * 60000
			if c == '-' {
				offsetMs = -offsetMs
			}
			hasOffset = true
		}
	}
	if p.pos != len(p.s) {
		return 0, false
	}
	days := daysFromCivil(year, month, 1) + int64(day-1)
	ms := float64(days)*86400000 + float64(((hour*60+minute)*60+second)*1000+millis)
	if hasTime && !hasOffset {
		// Local time, like V8 on the host.
		_, off := time.UnixMilli(int64(ms)).In(time.Local).Zone()
		ms -= float64(off) * 1000
	} else {
		ms -= float64(offsetMs)
	}
	if math.Abs(ms) > maxTimeMs {
		return 0, false
	}
	return ms, true
}

// daysFromCivil returns the days since 1970-01-01 of a proleptic Gregorian date.
func daysFromCivil(y, m, d int) int64 {
	if m <= 2 {
		y--
	}
	era := y
	if era < 0 {
		era -= 399
	}
	era /= 400
	yoe := y - era*400
	mp := (m + 9) % 12
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return int64(era)*146097 + int64(doe) - 719468
}

// ISOString is new Date(ms).toISOString(): the time value is truncated toward zero
// (TimeClip) and an invalid or out-of-range time throws RangeError.
func ISOString(ms float64) string {
	if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > maxTimeMs {
		rangeError()
	}
	t := time.UnixMilli(int64(math.Trunc(ms))).UTC()
	y := t.Year()
	var ys string
	switch {
	case y >= 0 && y <= 9999:
		ys = pad(y, 4)
	case y < 0:
		ys = "-" + pad(-y, 6)
	default:
		ys = "+" + pad(y, 6)
	}
	return ys + "-" + pad(int(t.Month()), 2) + "-" + pad(t.Day(), 2) + "T" + pad(t.Hour(), 2) + ":" +
		pad(t.Minute(), 2) + ":" + pad(t.Second(), 2) + "." + pad(t.Nanosecond()/1e6, 3) + "Z"
}

func pad(v, n int) string {
	s := strconv.Itoa(v)
	for len(s) < n {
		s = "0" + s
	}
	return s
}

func isFinite(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) }

// isSafeInteger is Number.isSafeInteger.
func isSafeInteger(x float64) bool {
	return isFinite(x) && math.Trunc(x) == x && math.Abs(x) <= 9007199254740991
}
