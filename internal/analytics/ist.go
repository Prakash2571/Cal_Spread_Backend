package analytics

import (
	"regexp"
	"strconv"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/jsx"
)

// IST session and bucket arithmetic (index.ts :3417-3560). Everything is fixed-offset
// epoch-millisecond arithmetic, as in Node: no time zone database, no DST.

const (
	minuteMs    int64 = 60 * 1000
	hourMs      int64 = 60 * minuteMs
	dayMs       int64 = 24 * hourMs
	istOffsetMs int64 = 5*hourMs + 30*minuteMs // IST_OFFSET_MS

	// OPTION_OI_INTERVAL_MS and CAPTURE_LEAD_MS.
	captureIntervalMs int64 = 60 * 1000
	captureLeadMs     int64 = 3 * 1000

	sessionOpenMinute  = 9*60 + 15  // 09:15
	sessionCloseMinute = 15*60 + 40 // 15:40
)

// istDayKey is index.ts istDayKey(at): the UTC date of at + 5h30m.
func istDayKey(ms int64) string { return jsx.IstDayKey(time.UnixMilli(ms)) }

// istDateTime is index.ts istDateTime: "YYYY-MM-DD HH:MM:SS" IST wall time.
func istDateTime(ms int64) string { return jsx.IstDateTime(time.UnixMilli(ms)) }

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func ceilDiv(a, b int64) int64 { return -floorDiv(-a, b) }

// istTimeOnDayMs is the epoch ms of an IST wall-clock minute-of-day on the IST day
// containing t.
func istTimeOnDayMs(t int64, minutesOfDay int64) int64 {
	istMidnight := floorDiv(t+istOffsetMs, dayMs) * dayMs
	return istMidnight + minutesOfDay*minuteMs - istOffsetMs
}

// sessionOpenMs is 09:15 IST on the day containing t.
func sessionOpenMs(t int64) int64 { return istTimeOnDayMs(t, sessionOpenMinute) }

// sessionCloseMs is 15:40 IST on the day containing t (not date-gated, as in Node).
func sessionCloseMs(t int64) int64 { return istTimeOnDayMs(t, sessionCloseMinute) }

// isPreOpenBucket: a bucket ending at or before 09:15 covers only pre-open time.
func isPreOpenBucket(bEnd int64) bool { return bEnd <= sessionOpenMs(bEnd) }

// bucketEndMs is the bucket-END boundary a sample at t belongs to, IST-calendar aligned,
// with everything at or after 15:40 clamped into the closing bucket. A sample exactly on
// a boundary closes that bucket.
func bucketEndMs(t, bsize int64) int64 {
	cl := sessionCloseMs(t)
	if t >= cl {
		return cl
	}
	aligned := ceilDiv(t+istOffsetMs, bsize)*bsize - istOffsetMs
	if aligned < cl {
		return aligned
	}
	return cl
}

// candleEndMs is the bucket of a Kite candle, which is stamped with its START.
func candleEndMs(candleStart, bsize int64) int64 { return bucketEndMs(candleStart+minuteMs, bsize) }

// isIstMarketHours: Monday to Friday (or a configured EXTRA_SESSION_DAYS date), 09:10 to
// 15:45 IST inclusive by minute. No holiday calendar: holidays are detected from the quote
// stamps (isQuoteFromToday).
func (s *Service) isIstMarketHours(now int64) bool {
	ist := time.UnixMilli(now + istOffsetMs).UTC()
	dow := ist.Weekday()
	if (dow == time.Sunday || dow == time.Saturday) && !s.extra[istDayKey(now)] {
		return false
	}
	mins := ist.Hour()*60 + ist.Minute()
	return mins >= 9*60+10 && mins <= 15*60+45
}

var dayRe = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// quoteDay is isQuoteFromToday(stamp): 1 traded today, 0 demonstrably not (a well-formed
// stamp from another day), -1 no evidence (empty or malformed stamp). Callers fail open on -1.
func quoteDay(stamp string, now int64) int {
	if stamp == "" {
		return -1
	}
	day := sliceUTF16(stamp, 10)
	if !dayRe.MatchString(day) {
		return -1
	}
	if day == istDayKey(now) {
		return 1
	}
	return 0
}

// parseCandleTime is `new Date(stamp).getTime()` for the candle stamps the brokers send:
// Kite's "2026-10-27T09:15:00+0530" (V8's legacy parser takes the colon-less offset) and
// the ISO forms with "Z" or "+05:30". A stamp without an offset is local time in V8, so
// loc is used for it. ok is false where V8 gives NaN.
func parseCandleTime(stamp string, loc *time.Location) (int64, bool) {
	s := stamp
	num := func(i, n int) (int, bool) {
		if i+n > len(s) {
			return 0, false
		}
		v := 0
		for k := i; k < i+n; k++ {
			c := s[k]
			if c < '0' || c > '9' {
				return 0, false
			}
			v = v*10 + int(c-'0')
		}
		return v, true
	}
	y, ok1 := num(0, 4)
	if !ok1 || len(s) < 10 || s[4] != '-' || s[7] != '-' {
		return 0, false
	}
	mo, ok2 := num(5, 2)
	d, ok3 := num(8, 2)
	if !ok2 || !ok3 || mo < 1 || mo > 12 || d < 1 || d > 31 {
		return 0, false
	}
	i := 10
	h, mi, sec, ms := 0, 0, 0, 0
	if i < len(s) {
		if s[i] != 'T' && s[i] != ' ' {
			return 0, false
		}
		i++
		var ok bool
		if h, ok = num(i, 2); !ok || i+2 >= len(s) || s[i+2] != ':' {
			return 0, false
		}
		if mi, ok = num(i+3, 2); !ok {
			return 0, false
		}
		i += 5
		if i < len(s) && s[i] == ':' {
			if sec, ok = num(i+1, 2); !ok {
				return 0, false
			}
			i += 3
			if i < len(s) && s[i] == '.' {
				j := i + 1
				frac := 0
				digits := 0
				for j < len(s) && s[j] >= '0' && s[j] <= '9' {
					if digits < 3 {
						frac = frac*10 + int(s[j]-'0')
					}
					digits++
					j++
				}
				if digits == 0 {
					return 0, false
				}
				for k := digits; k < 3; k++ {
					frac *= 10
				}
				ms = frac
				i = j
			}
		}
		if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi != 0 || sec != 0 || ms != 0)) {
			return 0, false
		}
	} else {
		// A date-only ISO string is UTC midnight.
		return time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC).UnixMilli(), true
	}
	// V8 rolls a day past the month's end (up to 31) into the next month, as time.Date does.
	rest := s[i:]
	switch {
	case rest == "":
		if loc == nil {
			loc = time.Local
		}
		return time.Date(y, time.Month(mo), d, h, mi, sec, ms*int(time.Millisecond), loc).UnixMilli(), true
	case rest == "Z":
		return time.Date(y, time.Month(mo), d, h, mi, sec, ms*int(time.Millisecond), time.UTC).UnixMilli(), true
	case rest[0] == '+' || rest[0] == '-':
		off := rest[1:]
		var oh, om int
		var err1, err2 error
		switch {
		case len(off) == 5 && off[2] == ':':
			oh, err1 = strconv.Atoi(off[:2])
			om, err2 = strconv.Atoi(off[3:])
		case len(off) == 4:
			oh, err1 = strconv.Atoi(off[:2])
			om, err2 = strconv.Atoi(off[2:])
		default:
			return 0, false
		}
		if err1 != nil || err2 != nil || oh > 23 || om > 59 {
			return 0, false
		}
		offMs := int64(oh)*hourMs + int64(om)*minuteMs
		if rest[0] == '-' {
			offMs = -offMs
		}
		base := time.Date(y, time.Month(mo), d, h, mi, sec, ms*int(time.Millisecond), time.UTC).UnixMilli()
		return base - offMs, true
	}
	return 0, false
}
