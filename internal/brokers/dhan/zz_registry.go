package dhan

import (
	"context"
	"net/http"
	"time"
)

// Additions for internal/brokers/registry (stage "registry").

// CalculateMarginRaw is CalculateMargin returning the raw response, for callers that
// need JavaScript's property-read semantics (a null body throws in Node, where
// CalculateMargin's decoded struct would read as zeros).
func (c *Client) CalculateMarginRaw(ctx context.Context, leg MarginLeg) (Value, error) {
	body := singleMarginBody{MarginLeg: leg, DhanClientID: c.clientID()}
	return c.readValue(ctx, RequestOptions{Method: http.MethodPost, Path: "/margincalculator", Body: body})
}

// DateParse is V8's Date.parse with zone-less date-times read in the process time zone
// (time.Local), as `new Date(string)` does in Node.
func DateParse(s string) float64 { return jsDateParse(s, time.Local) }
