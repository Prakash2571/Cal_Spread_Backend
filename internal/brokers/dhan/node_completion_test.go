package dhan

import (
	"reflect"
	"testing"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// tests/box/dhanFeedDecoder.test.mjs: these toTick assertions used exact ladders
// that were absent from totick.json. Also require exchange_ts to stay absent.
func TestNodeToTickUsesTheExecutableBookWithoutAnExchangeTimestamp(t *testing.T) {
	state := FeedState{Token: 2_000_045_678, LastPrice: 123.45, ClosePrice: 119, OI: 4321,
		Bids: []market.DepthLevel{{Price: 100.5, Qty: 75, Orders: 3}},
		Asks: []market.DepthLevel{{Price: 101, Qty: 50, Orders: 2}}}
	tick := ToTick(state, true)
	if tick.Token != 2_000_045_678 || tick.Bid != 100.5 || tick.Ask != 101 || tick.OI != 4321 || tick.ClosePrice != 119 {
		t.Fatalf("toTick must use the ladder, rather than LTP: %+v", tick)
	}
	if tick.ExchangeTS != nil {
		t.Fatalf("Dhan has no exchange book timestamp: %v", *tick.ExchangeTS)
	}
}

// "toTick reports a missing side as 0 rather than guessing a price"
func TestNodeToTickMissingBidIsZero(t *testing.T) {
	tick := ToTick(FeedState{Token: 1, LastPrice: 5, ClosePrice: 4,
		Bids: []market.DepthLevel{}, Asks: []market.DepthLevel{{Price: 6, Qty: 10, Orders: 1}}}, true)
	if tick.Bid != 0 || tick.Ask != 6 {
		t.Fatalf("missing-side touch = %v/%v; want 0/6", tick.Bid, tick.Ask)
	}
}

// tests/box/dhanMarginAndIp.test.mjs: the golden used different alias values,
// and did not contain all of the dashboard's literal IP payloads.
func TestNodeMarginAliasesAndDashboardIPPayloads(t *testing.T) {
	parse := func(text string) Value {
		t.Helper()
		v, err := ParseJSON([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, key := range []string{"totalMargin", "totalMarginRequired", "total_margin"} {
		n := NormalizeMultiMargin(parse(`{"` + key + `":41250}`))
		if n == nil || n.Total != 41250 {
			t.Errorf("%s must preserve the hedge-adjusted total: %+v", key, n)
		}
	}
	for _, text := range []string{`{"totalMargin":0}`, `{"totalMargin":-5}`} {
		if n := NormalizeMultiMargin(parse(text)); n != nil {
			t.Errorf("%s must not describe credible margin: %+v", text, n)
		}
	}
	if got := DescribeMarginPayload(parse(`{"data":{"errorType":"x","errorMessage":"y"}}`)); got != "errorType, errorMessage" {
		t.Errorf("describe must report field names only: %q", got)
	}
	for _, tc := range []struct {
		input string
		want  []string
	}{
		{`{"dhanClientId":"1000000001","ipAddress1":"100.31.218.89","ipAddress2":"NA"}`, []string{"100.31.218.89"}},
		{`{"primaryIP":"203.0.113.7","secondaryIP":"198.51.100.2"}`, []string{"203.0.113.7", "198.51.100.2"}},
		{`{"status":"success","data":{"ipAddress1":"203.0.113.7"}}`, []string{"203.0.113.7"}},
		{`{"staticIp":["203.0.113.7","198.51.100.2"]}`, []string{"203.0.113.7", "198.51.100.2"}},
		{`{"a":"NA","b":"na","c":"","d":null}`, []string{}},
		{`{"version":"2.0.1","qty":"275","ratio":"1.5","ip":"999.1.1.1"}`, []string{}},
		{`{"a":"203.0.113.7","b":"203.0.113.7"}`, []string{"203.0.113.7"}},
	} {
		if got := ExtractIPv4Addresses(parse(tc.input)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("extractIpv4Addresses(%s) = %q, want %q", tc.input, got, tc.want)
		}
	}
}
