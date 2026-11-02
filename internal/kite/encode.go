package kite

import "strings"

const upperHex = "0123456789ABCDEF"

// EncodeURIComponent is JavaScript's encodeURIComponent: every UTF-8 byte except
// A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-encoded with upper-case hex.
func EncodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isAlnum(c) || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upperHex[c>>4])
		b.WriteByte(upperHex[c&0xF])
	}
	return b.String()
}

// formEncode is the application/x-www-form-urlencoded byte serializer URLSearchParams
// uses: A-Z a-z 0-9 * - . _ kept, space as '+', everything else %XX.
func formEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case isAlnum(c) || c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteByte('%')
			b.WriteByte(upperHex[c>>4])
			b.WriteByte(upperHex[c&0xF])
		}
	}
	return b.String()
}

// searchParams is `new URLSearchParams({...}).toString()` for ordered pairs.
func searchParams(pairs ...[2]string) string {
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = formEncode(p[0]) + "=" + formEncode(p[1])
	}
	return strings.Join(parts, "&")
}

func isAlnum(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
}
