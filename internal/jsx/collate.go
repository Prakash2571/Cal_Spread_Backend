package jsx

import "unicode/utf8"

// collationOrder is the CLDR root primary order of the printable ASCII characters (and
// the whitespace controls) as Node's ICU sorts them. Letters follow, case-insensitive at
// this level. Other ASCII controls are completely ignorable.
const collationOrder = "\t\n\v\f\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789"

var asciiPrimary [128]int

func init() {
	for i := 0; i < len(collationOrder); i++ {
		asciiPrimary[collationOrder[i]] = i + 1
	}
	base := len(collationOrder) + 1
	for c := 'a'; c <= 'z'; c++ {
		asciiPrimary[c] = base + int(c-'a')
		asciiPrimary[c-'a'+'A'] = base + int(c-'a')
	}
}

// collationKey returns the primary and tertiary weight of r; primary 0 means ignorable.
// Characters outside ASCII sort after every ASCII letter in code-point order: symbols,
// keys and dates never contain them.
func collationKey(r rune) (primary int, tertiary int) {
	if r < 128 {
		p := asciiPrimary[r]
		if r >= 'A' && r <= 'Z' {
			return p, 1 // tertiary: lowercase before uppercase
		}
		return p, 0
	}
	return 1000 + int(r), 0
}

// LocaleCompare is a.localeCompare(b) with Node's default (ICU root) collation for
// ASCII text: primary weights first, then case; -1, 0 or 1. Strings that differ only in
// ignorable characters compare equal, as in ICU. Checked against Node 22 on 40,000+
// pairs (testdata/collate.json).
func LocaleCompare(a, b string) int {
	type w struct{ p, t int }
	weights := func(s string) []w {
		out := make([]w, 0, len(s))
		for len(s) > 0 {
			r, size := utf8.DecodeRuneInString(s)
			s = s[size:]
			p, t := collationKey(r)
			if p != 0 {
				out = append(out, w{p, t})
			}
		}
		return out
	}
	wa, wb := weights(a), weights(b)
	for i := 0; i < len(wa) && i < len(wb); i++ {
		if wa[i].p != wb[i].p {
			if wa[i].p < wb[i].p {
				return -1
			}
			return 1
		}
	}
	if len(wa) != len(wb) {
		if len(wa) < len(wb) {
			return -1
		}
		return 1
	}
	for i := range wa {
		if wa[i].t != wb[i].t {
			if wa[i].t < wb[i].t {
				return -1
			}
			return 1
		}
	}
	return 0
}
