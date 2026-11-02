package jsjson

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// SyntaxError is a JSON.parse failure. Message is V8's (Node 22) text for the error.
type SyntaxError struct {
	Message string
}

func (e *SyntaxError) Error() string { return e.Message }

// Parse is JSON.parse(text).
func Parse(text string) (*Value, error) {
	p := &parser{s: text}
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i < len(p.s) {
		// V8 words this one without "in JSON": "Unexpected non-whitespace character after
		// JSON at position 3 (line 1 column 4)".
		err := p.positioned("Unexpected non-whitespace character after JSON", p.i).(*SyntaxError)
		err.Message = strings.Replace(err.Message, " in JSON at position", " at position", 1)
		return nil, err
	}
	return v, nil
}

type parser struct {
	s string
	i int
}

const eosMessage = "Unexpected end of JSON input"

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) eos() error { return &SyntaxError{Message: eosMessage} }

// position converts a byte offset to V8's UTF-16 position.
func (p *parser) position(byteAt int) int { return UTF16Len(p.s[:byteAt]) }

func (p *parser) positioned(msg string, byteAt int) error {
	pos := p.position(byteAt)
	line := 1 + strings.Count(p.s[:byteAt], "\n")
	col := pos + 1
	if nl := strings.LastIndexByte(p.s[:byteAt], '\n'); nl >= 0 {
		col = pos - p.position(nl)
	}
	return &SyntaxError{Message: fmt.Sprintf("%s in JSON at position %d (line %d column %d)", msg, pos, line, col)}
}

// unexpectedToken is V8's "Unexpected token 'c', <context> is not valid JSON".
func (p *parser) unexpectedToken(byteAt int) error {
	units := utf16.Encode([]rune(p.s))
	pos := p.position(byteAt)
	tok := ""
	if pos < len(units) {
		tok = string(utf16.Decode(units[pos : pos+1]))
		if r, _ := utf8.DecodeRuneInString(p.s[byteAt:]); r >= 0x10000 {
			tok = string(r) // Go cannot hold the lone high surrogate V8 would print
		}
	}
	const maxContext = 10
	n := len(units)
	var ctx string
	if n < 2*maxContext+1 {
		ctx = `"` + p.s + `"`
	} else {
		start, end := 0, pos+maxContext
		if pos >= maxContext {
			start = pos - maxContext
		}
		if end > n {
			end = n
		}
		ctx = `"` + string(utf16.Decode(units[start:end])) + `"`
		if start > 0 {
			ctx = "..." + ctx
		}
		if end < n {
			ctx += "..."
		}
	}
	return &SyntaxError{Message: fmt.Sprintf("Unexpected token '%s', %s is not valid JSON", tok, ctx)}
}

func (p *parser) value() (*Value, error) {
	if p.i >= len(p.s) {
		return nil, p.eos()
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		s, err := p.str()
		if err != nil {
			return nil, err
		}
		return &Value{kind: String, s: s}, nil
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case c == 't':
		return p.literal("true", &Value{kind: Bool, b: true})
	case c == 'f':
		return p.literal("false", &Value{kind: Bool})
	case c == 'n':
		return p.literal("null", &Value{kind: Null})
	}
	return nil, p.unexpectedToken(p.i)
}

func (p *parser) literal(word string, v *Value) (*Value, error) {
	for k := 0; k < len(word); k++ {
		if p.i >= len(p.s) {
			return nil, p.eos()
		}
		if p.s[p.i] != word[k] {
			return nil, p.unexpectedToken(p.i)
		}
		p.i++
	}
	return v, nil
}

func (p *parser) object() (*Value, error) {
	p.i++ // {
	obj := &Value{kind: Object, props: map[string]*Value{}}
	var order []string
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		obj.keys = []string{}
		return obj, nil
	}
	if p.i >= len(p.s) || p.s[p.i] != '"' {
		return nil, p.positioned("Expected property name or '}'", p.i)
	}
	for {
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, p.positioned("Expected ':' after property name", p.i)
		}
		p.i++
		p.ws()
		val, err := p.value()
		if err != nil {
			return nil, err
		}
		if _, dup := obj.props[key]; !dup {
			order = append(order, key)
		}
		obj.props[key] = val
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ',' {
			p.i++
			p.ws()
			if p.i >= len(p.s) || p.s[p.i] != '"' {
				return nil, p.positioned("Expected double-quoted property name", p.i)
			}
			continue
		}
		if p.i < len(p.s) && p.s[p.i] == '}' {
			p.i++
			obj.keys = orderKeys(order)
			return obj, nil
		}
		return nil, p.positioned("Expected ',' or '}' after property value", p.i)
	}
}

func (p *parser) array() (*Value, error) {
	p.i++ // [
	arr := &Value{kind: Array, arr: []*Value{}}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return arr, nil
	}
	for {
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		arr.arr = append(arr.arr, v)
		p.ws()
		if p.i < len(p.s) && p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.i < len(p.s) && p.s[p.i] == ']' {
			p.i++
			return arr, nil
		}
		return nil, p.positioned("Expected ',' or ']' after array element", p.i)
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func (p *parser) number() (*Value, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return nil, p.positioned("No number after minus sign", p.i)
		}
	}
	if p.s[p.i] == '0' {
		p.i++
		if p.i < len(p.s) && isDigit(p.s[p.i]) {
			return nil, p.positioned("Unexpected number", p.i)
		}
	} else {
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return nil, p.positioned("Unterminated fractional number", p.i)
		}
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return nil, p.positioned("Exponent part is missing a number", p.i)
		}
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil {
		// Only range errors are possible here: ParseFloat already returned ±Inf or 0,
		// which is what JSON.parse gives for out-of-range literals.
		if math.IsNaN(f) {
			f = 0
		}
	}
	return &Value{kind: Number, n: f}, nil
}

func hexVal(c byte) (uint16, bool) {
	switch {
	case c >= '0' && c <= '9':
		return uint16(c - '0'), true
	case c >= 'a' && c <= 'f':
		return uint16(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return uint16(c-'A') + 10, true
	}
	return 0, false
}

// str parses a string starting at the opening quote. Lone surrogate escapes are kept as
// WTF-8 bytes so AppendString can write them back exactly.
func (p *parser) str() (string, error) {
	p.i++ // opening quote
	var b []byte
	start := p.i
	for {
		if p.i >= len(p.s) {
			return "", p.positioned("Unterminated string", p.i)
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			out := p.s[start:p.i]
			if b != nil {
				out = string(append(b, p.s[start:p.i]...))
			}
			p.i++
			return out, nil
		case c < 0x20:
			return "", p.positioned("Bad control character in string literal", p.i)
		case c == '\\':
			b = append(b, p.s[start:p.i]...)
			p.i++
			if p.i >= len(p.s) {
				return "", p.positioned("Unterminated string", p.i)
			}
			e := p.s[p.i]
			switch e {
			case '"', '\\', '/':
				b = append(b, e)
			case 'b':
				b = append(b, '\b')
			case 'f':
				b = append(b, '\f')
			case 'n':
				b = append(b, '\n')
			case 'r':
				b = append(b, '\r')
			case 't':
				b = append(b, '\t')
			case 'u':
				u, err := p.hex4(p.i + 1)
				if err != nil {
					return "", err
				}
				p.i += 4
				if utf16.IsSurrogate(rune(u)) {
					// A high surrogate followed by an escaped low surrogate is one rune.
					if u < 0xDC00 && p.i+6 < len(p.s) && p.s[p.i+1] == '\\' && p.s[p.i+2] == 'u' {
						if lo, err := p.hex4(p.i + 3); err == nil && lo >= 0xDC00 && lo <= 0xDFFF {
							b = utf8.AppendRune(b, utf16.DecodeRune(rune(u), rune(lo)))
							p.i += 6
							break
						}
					}
					b = appendWTF8Surrogate(b, u)
				} else {
					b = utf8.AppendRune(b, rune(u))
				}
			default:
				return "", p.positioned("Bad escaped character", p.i)
			}
			p.i++
			start = p.i
		default:
			p.i++
		}
	}
}

func (p *parser) hex4(at int) (uint16, error) {
	var u uint16
	for k := 0; k < 4; k++ {
		if at+k >= len(p.s) {
			return 0, p.positioned("Bad Unicode escape", at+k)
		}
		h, ok := hexVal(p.s[at+k])
		if !ok {
			return 0, p.positioned("Bad Unicode escape", at+k)
		}
		u = u<<4 | h
	}
	return u, nil
}
