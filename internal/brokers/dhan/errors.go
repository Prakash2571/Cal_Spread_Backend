package dhan

import (
	"encoding/json"
	"errors"
)

// ErrorClass is the TypeScript error subclass a Dhan failure belongs to.
type ErrorClass uint8

// Error classes (errors.ts).
const (
	ClassError          ErrorClass = iota // DhanError
	ClassAuth                             // DhanAuthError: session missing, expired or rejected
	ClassRateLimit                        // DhanRateLimitError: 429
	ClassNetwork                          // DhanNetworkError: no usable response at all
	ClassTradingBlocked                   // DhanTradingBlockedError: a configuration precondition
)

// Error is every Dhan transport/API failure (DhanError and its subclasses, told apart
// by Class).
type Error struct {
	Class   ErrorClass
	Message string
	// Status is the HTTP status, or 0 when the request never produced a response.
	Status int
	// Code is Dhan's own error code when the body carried one ("" for none).
	Code string
	// Body is the raw response body retained for logs (nil when none). Never holds
	// credentials.
	Body json.RawMessage
	// RetryAfterSec is the Retry-After Dhan sent with a 429, when it sent one.
	RetryAfterSec *float64
}

func (e *Error) Error() string { return e.Message }

// Name is the TypeScript class name ("DhanError", "DhanAuthError", ...).
func (e *Error) Name() string {
	switch e.Class {
	case ClassAuth:
		return "DhanAuthError"
	case ClassRateLimit:
		return "DhanRateLimitError"
	case ClassNetwork:
		return "DhanNetworkError"
	case ClassTradingBlocked:
		return "DhanTradingBlockedError"
	}
	return "DhanError"
}

// IsDefinitive reports whether Dhan definitively processed and refused the request:
// a 4xx other than 429.
func (e *Error) IsDefinitive() bool {
	return e.Status >= 400 && e.Status < 500 && e.Status != 429
}

// NewError is `new DhanError(message, status, code, body)`.
func NewError(message string, status int, code string, body json.RawMessage) *Error {
	return &Error{Class: ClassError, Message: message, Status: status, Code: code, Body: body}
}

// NewAuthError is `new DhanAuthError(...)`; status 0 means the TypeScript default 401.
func NewAuthError(message string, status int, code string, body json.RawMessage) *Error {
	if status == 0 {
		status = 401
	}
	return &Error{Class: ClassAuth, Message: message, Status: status, Code: code, Body: body}
}

// NewRateLimitError is `new DhanRateLimitError(message, retryAfterSec, body)`.
func NewRateLimitError(message string, retryAfterSec *float64, body json.RawMessage) *Error {
	return &Error{Class: ClassRateLimit, Message: message, Status: 429, Code: "RATE_LIMIT", Body: body, RetryAfterSec: retryAfterSec}
}

// NewNetworkError is `new DhanNetworkError(message, body)`.
func NewNetworkError(message string, body json.RawMessage) *Error {
	return &Error{Class: ClassNetwork, Message: message, Status: 0, Code: "NETWORK", Body: body}
}

// NewTradingBlockedError is `new DhanTradingBlockedError(message)`.
func NewTradingBlockedError(message string) *Error {
	return &Error{Class: ClassTradingBlocked, Message: message, Status: 0, Code: "TRADING_BLOCKED"}
}

// AsError unwraps a *Error from err.
func AsError(err error) (*Error, bool) {
	var de *Error
	if errors.As(err, &de) && de != nil {
		return de, true
	}
	return nil, false
}

// IsAuthError reports a DhanAuthError.
func IsAuthError(err error) bool { return classOf(err) == ClassAuth }

// IsRateLimitError reports a DhanRateLimitError.
func IsRateLimitError(err error) bool { return classOf(err) == ClassRateLimit }

// IsNetworkError reports a DhanNetworkError.
func IsNetworkError(err error) bool { return classOf(err) == ClassNetwork }

func classOf(err error) ErrorClass {
	if de, ok := AsError(err); ok {
		return de.Class
	}
	return 255
}

// NormalizeError is normalizeDhanError: it probes the envelopes Dhan is known to use
// (errorCode/error_code/errorType for the code, errorMessage/error_message/message for
// the text) and classifies by status: 401/403 auth, 429 rate limit, else DhanError.
func NormalizeError(status int, body json.RawMessage, fallback string) *Error {
	record := Null()
	if len(body) > 0 {
		if v, err := ParseJSON(body); err == nil {
			record = v
		}
	}
	code := ""
	for _, k := range []string{"errorCode", "error_code", "errorType"} {
		if s, ok := record.Get(k).Str(); ok {
			code = s
			break
		}
	}
	message := fallback
	for _, k := range []string{"errorMessage", "error_message", "message"} {
		if s, ok := record.Get(k).Str(); ok && s != "" {
			message = s
			break
		}
	}
	switch status {
	case 401, 403:
		return NewAuthError(message, status, code, body)
	case 429:
		return NewRateLimitError(message, nil, body)
	}
	return NewError(message, status, code, body)
}

// IsRetryableRead is isRetryableRead: auth never, rate limit and network always, any
// other Dhan error only for 5xx, non-Dhan errors never.
func IsRetryableRead(err error) bool {
	de, ok := AsError(err)
	if !ok {
		return false
	}
	switch de.Class {
	case ClassAuth:
		return false
	case ClassRateLimit, ClassNetwork:
		return true
	}
	return de.Status >= 500
}
