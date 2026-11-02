package dhan

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"testing"
	"time"
	_ "time/tzdata" // the goldens are recorded under UTC and Asia/Kolkata
)

// The goldens come from gen_helpers.mjs and gen_instruments.mjs (run through
// generate.mjs), which call the original src/brokers/dhan/*.ts.

func zone(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// goldenValue turns a canonical golden argument into a JS value ({"$num": …} markers
// become the numbers they stand for).
func goldenValue(t *testing.T, raw json.RawMessage) Value {
	t.Helper()
	var marker struct {
		Num *string `json:"$num"`
	}
	if len(raw) > 0 && raw[0] == '{' && json.Unmarshal(raw, &marker) == nil && marker.Num != nil {
		return NumberValue(goldenNumber(t, raw))
	}
	v, err := ParseJSON(raw)
	if err != nil {
		t.Fatalf("argument %s: %v", raw, err)
	}
	return v
}

// sameJSON compares two JSON texts as values (key order ignored).
func sameJSON(t *testing.T, got, want []byte) bool {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("got is not JSON: %s", got)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("want is not JSON: %s", want)
	}
	return reflect.DeepEqual(g, w)
}

type errorView struct {
	Name          string   `json:"name"`
	Message       string   `json:"message"`
	Status        int      `json:"status"`
	Code          *string  `json:"code"`
	RetryAfterSec *float64 `json:"retryAfterSec"`
	IsDefinitive  bool     `json:"isDefinitive"`
	RetryableRead bool     `json:"retryableRead"`
}

func viewOf(e *Error) errorView {
	v := errorView{Name: e.Name(), Message: e.Message, Status: e.Status, RetryAfterSec: e.RetryAfterSec,
		IsDefinitive: e.IsDefinitive(), RetryableRead: IsRetryableRead(e)}
	if e.Code != "" {
		c := e.Code
		v.Code = &c
	}
	return v
}

func TestHelpersGolden(t *testing.T) {
	var g struct {
		Meta struct {
			Now int64 `json:"now"`
		} `json:"meta"`
		Cases []struct {
			Fn           string            `json:"fn"`
			Args         []json.RawMessage `json:"args"`
			TZ           string            `json:"tz"`
			Now          int64             `json:"now"`
			UndefinedArg bool              `json:"undefinedArg"`
			Value        json.RawMessage   `json:"value"`
			Error        *string           `json:"error"`
		} `json:"cases"`
	}
	readGolden(t, "helpers.json", &g)
	if len(g.Cases) < 600 {
		t.Fatalf("golden has only %d cases", len(g.Cases))
	}
	str := func(raw json.RawMessage) string {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("string argument %s: %v", raw, err)
		}
		return s
	}
	integer := func(raw json.RawMessage) int64 {
		f := goldenNumber(t, raw)
		if f != math.Trunc(f) {
			t.Fatalf("integer argument %s", raw)
		}
		return int64(f)
	}
	nullable := func(s Segment, ok bool) any {
		if !ok {
			return nil
		}
		return string(s)
	}
	checked := map[string]int{}
	for i, c := range g.Cases {
		where := fmt.Sprintf("case %d %s%s %s", i, c.Fn, c.Args, c.TZ)
		if c.Error != nil {
			t.Fatalf("%s: Node threw %s (no Go equivalent expected)", where, *c.Error)
		}
		var got any
		switch c.Fn {
		case "dhanSegmentFor":
			var isIndex bool
			_ = json.Unmarshal(c.Args[1], &isIndex)
			got = nullable(SegmentFor(str(c.Args[0]), isIndex))
		case "dhanSegmentFromCode":
			got = nullable(SegmentFromCode(int(integer(c.Args[0]))))
		case "internalExchangeFor":
			got = InternalExchangeFor(Segment(str(c.Args[0])))
		case "DHAN_CODE_BY_SEGMENT":
			got = CodeBySegment
		case "dhanInternalToken":
			got = InternalToken(Segment(str(c.Args[0])), integer(c.Args[1]))
		case "dhanIdentityFromToken":
			if id, ok := IdentityFromToken(integer(c.Args[0])); ok {
				got = id
			}
		case "splitCsvLine":
			got = SplitCSVLine(str(c.Args[0]))
		case "normalizeDhanExpiry":
			got = normalizeExpiryIn(str(c.Args[0]), zone(t, c.TZ))
		case "normalizeDhanInstrumentType":
			got = NormalizeInstrumentType(str(c.Args[0]), str(c.Args[1]))
		case "stripContractSuffix":
			got = StripContractSuffix(str(c.Args[0]))
		case "normalizeUnderlyingKey":
			got = NormalizeUnderlyingKey(str(c.Args[0]))
		case "parseExpiry":
			v := Value{} // undefined
			if !c.UndefinedArg {
				v = goldenValue(t, c.Args[0])
			}
			got = parseExpiryIn(v, zone(t, c.TZ))
		case "isDhanTokenExpired":
			var expiry *int64
			if string(c.Args[0]) != "null" {
				e := integer(c.Args[0])
				expiry = &e
			}
			got = IsTokenExpired(expiry, integer(c.Args[1]))
		case "redactedSession":
			var s struct {
				ID, Name, Ucc string
				POA           bool
				Expiry        *int64
				LoginDate     string
				LoginAt       *string
			}
			var raw map[string]json.RawMessage
			_ = json.Unmarshal(c.Args[0], &raw)
			_ = json.Unmarshal(raw["dhan_client_id"], &s.ID)
			_ = json.Unmarshal(raw["dhan_client_name"], &s.Name)
			_ = json.Unmarshal(raw["dhan_client_ucc"], &s.Ucc)
			_ = json.Unmarshal(raw["given_power_of_attorney"], &s.POA)
			_ = json.Unmarshal(raw["expiry_time"], &s.Expiry)
			_ = json.Unmarshal(raw["login_date"], &s.LoginDate)
			_ = json.Unmarshal(raw["login_at"], &s.LoginAt)
			rec := SessionRecord{DhanClientID: s.ID, DhanClientName: s.Name, DhanClientUcc: s.Ucc, GivenPowerOfAttorney: s.POA,
				ExpiryTime: s.Expiry, LoginDate: s.LoginDate}
			if s.LoginAt != nil {
				at, err := time.Parse(time.RFC3339Nano, *s.LoginAt)
				if err != nil {
					t.Fatal(err)
				}
				rec.LoginAt = &at
			}
			r := RedactedSession(rec, time.UnixMilli(c.Now))
			b, _ := encodeJSON(r)
			if string(b) != string(c.Value) { // key order matters: this object is sent to browsers
				t.Errorf("%s:\n got %s\nwant %s", where, b, c.Value)
			}
			checked[c.Fn]++
			continue
		case "normalizeDhanError":
			var status int
			_ = json.Unmarshal(c.Args[0], &status)
			got = viewOf(NormalizeError(status, c.Args[1], str(c.Args[2])))
		case "new DhanError":
			got = viewOf(NewError(str(c.Args[0]), int(integer(c.Args[1])), "", nil))
		case "new DhanNetworkError":
			got = viewOf(NewNetworkError(str(c.Args[0]), nil))
		case "new DhanAuthError":
			got = viewOf(NewAuthError(str(c.Args[0]), int(integer(c.Args[1])), "", nil))
		case "new DhanRateLimitError":
			var after *float64
			if len(c.Args) > 1 {
				f := goldenNumber(t, c.Args[1])
				after = &f
			}
			got = viewOf(NewRateLimitError(str(c.Args[0]), after, nil))
		case "new DhanTradingBlockedError":
			got = viewOf(NewTradingBlockedError(str(c.Args[0])))
		case "isRetryableRead":
			var err error
			switch str(c.Args[0]) {
			case "Error":
				err = errors.New("plain")
			case "TypeError fetch failed":
				err = errors.New("fetch failed")
			}
			got = IsRetryableRead(err)
		default:
			t.Fatalf("%s: no Go mapping", where)
		}
		b, err := encodeJSON(got)
		if err != nil {
			t.Fatalf("%s: %v", where, err)
		}
		if !sameJSON(t, b, c.Value) {
			t.Errorf("%s:\n got %s\nwant %s", where, b, c.Value)
		}
		checked[c.Fn]++
	}
	t.Logf("checked %v", checked)
}

// instrumentJSON is a parsed DhanInstrument as the Node object (same key order; the
// numbers through canonicalJSON).
func instrumentJSON(r Instrument) string {
	b := []byte(`{"instrument_token":`)
	b = strconv.AppendInt(b, r.InstrumentToken, 10)
	b = append(b, `,"exchange_token":`...)
	b = strconv.AppendInt(b, r.ExchangeToken, 10)
	for _, f := range []struct {
		k   string
		v   any
		num bool
	}{{"tradingsymbol", r.Tradingsymbol, false}, {"name", r.Name, false}, {"last_price", r.LastPrice, true},
		{"expiry", r.Expiry, false}, {"strike", r.Strike, true}, {"tick_size", r.TickSize, true}, {"lot_size", r.LotSize, true},
		{"instrument_type", r.InstrumentType, false}, {"segment", r.Segment, false}, {"exchange", r.Exchange, false}} {
		b = append(b, `,"`+f.k+`":`...)
		if f.num {
			b = canonNum(b, f.v.(float64))
		} else {
			b = append(b, marshalNoEscape(f.v)...)
		}
	}
	b = append(b, `,"dhan_security_id":`...)
	b = strconv.AppendInt(b, r.DhanSecurityID, 10)
	b = append(b, `,"dhan_segment":`...)
	b = append(b, marshalNoEscape(string(r.DhanSegment))...)
	b = append(b, `,"dhan_underlying_security_id":`...)
	if r.DhanUnderlyingSecurityID != nil {
		b = strconv.AppendInt(b, *r.DhanUnderlyingSecurityID, 10)
	} else {
		b = append(b, "null"...)
	}
	return string(append(b, '}'))
}

func TestParseScripMasterGolden(t *testing.T) {
	var g struct {
		Meta struct {
			Now int64 `json:"now"`
		} `json:"meta"`
		Cases []struct {
			Name   string            `json:"name"`
			TZ     string            `json:"tz"`
			CSV    string            `json:"csv"`
			Rows   []json.RawMessage `json:"rows"`
			Report json.RawMessage   `json:"report"`
			Error  *string           `json:"error"`
		} `json:"cases"`
	}
	readGolden(t, "instruments.json", &g)
	if len(g.Cases) < 40 {
		t.Fatalf("golden has only %d cases", len(g.Cases))
	}
	now := time.UnixMilli(g.Meta.Now)
	rows := 0
	for _, c := range g.Cases {
		where := c.Name + " (" + c.TZ + ")"
		got, report, err := parseScripMaster(c.CSV, now, zone(t, c.TZ))
		if c.Error != nil {
			if err == nil || err.Error() != *c.Error {
				t.Errorf("%s: error %v, want %q", where, err, *c.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", where, err)
			continue
		}
		if c.Name == "fractional security id" {
			// Documented deviation: Go skips a non-integer security id; Node kept it.
			var want []json.RawMessage
			for _, r := range c.Rows {
				var id struct {
					ID float64 `json:"dhan_security_id"`
				}
				_ = json.Unmarshal(r, &id)
				if id.ID == math.Trunc(id.ID) {
					want = append(want, r)
				}
			}
			if len(want) != len(c.Rows)-1 || len(got) != len(want) || instrumentJSON(got[0]) != string(want[0]) {
				t.Errorf("%s: got %d rows, want Node's %d minus the fractional id", where, len(got), len(c.Rows))
			}
			if report.SkippedNoSecurityID != 1 {
				t.Errorf("%s: fractional id not counted as skipped", where)
			}
			continue
		}
		if len(got) != len(c.Rows) {
			t.Errorf("%s: %d rows, want %d", where, len(got), len(c.Rows))
			continue
		}
		for i, r := range got {
			if s := instrumentJSON(r); s != string(c.Rows[i]) {
				t.Errorf("%s row %d:\n got %s\nwant %s", where, i, s, c.Rows[i])
			}
		}
		rows += len(got)
		// Node's report is the module-level "last parse": an empty or header-only master
		// returns before producing one, so the previous parse's report is still current.
		last := GetParseReport()
		if report != nil && last != report {
			t.Errorf("%s: the returned report is not the stored last report", where)
		}
		b, err := encodeJSON(last)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != string(c.Report) {
			t.Errorf("%s: report\n got %s\nwant %s", where, b, c.Report)
		}
	}
	t.Logf("%d masters, %d rows", len(g.Cases), rows)
}
