package kite

import (
	"errors"
	"net/http"
)

// KiteError is kite.ts KiteError: a failure Kite reported (or a precondition the client
// checks), with the HTTP status the API routes answer with.
//
// Status is the Kite HTTP status of the failed response, so it can be 200 when Kite
// answered HTTP 200 with a body whose status is not "success"; the Node routes then
// answer 200 with an error body, and so do the Go routes (inventory api.md, sendError).
type KiteError struct {
	Status  int
	Message string
}

func (e *KiteError) Error() string { return e.Message }

// newKiteError builds a KiteError; status 0 becomes 500 (`res.status || 500`).
func newKiteError(message string, status int) *KiteError {
	if status == 0 {
		status = http.StatusInternalServerError
	}
	return &KiteError{Status: status, Message: message}
}

// AsKiteError unwraps err to a *KiteError.
func AsKiteError(err error) (*KiteError, bool) {
	var ke *KiteError
	if errors.As(err, &ke) {
		return ke, true
	}
	return nil, false
}

// ErrorStatus is the status index.ts sendError answers with: a KiteError's own status,
// 500 for everything else.
func ErrorStatus(err error) int {
	if ke, ok := AsKiteError(err); ok {
		return ke.Status
	}
	return http.StatusInternalServerError
}

// IsAuthFailure reports a KiteError with status 401 or 403, the case in which sendError
// also clears the Kite session (memory and the persisted copy).
func IsAuthFailure(err error) bool {
	ke, ok := AsKiteError(err)
	return ok && (ke.Status == http.StatusUnauthorized || ke.Status == http.StatusForbidden)
}

// FetchError is a transport failure (DNS, connect, TLS, reset, body read). Its message is
// "fetch failed", the TypeError text Node's fetch throws, so a route that reports
// err.Error() answers exactly as Node did; the cause is kept for logs.
type FetchError struct {
	Err error
}

func (e *FetchError) Error() string { return "fetch failed" }

// Unwrap returns the transport error.
func (e *FetchError) Unwrap() error { return e.Err }

// ResponseError is an error Node raised while reading a response that is not a Kite
// error: a body that is not JSON (a SyntaxError carrying V8's message) or a JSON body that
// is null (a TypeError reading `status`). Node's sendError answered these with 500 and the
// message, and so do the Go routes (ErrorStatus is 500 for it).
type ResponseError struct {
	Message string
	// HTTPStatus is the status of the response that could not be read (diagnostics only).
	HTTPStatus int
}

func (e *ResponseError) Error() string { return e.Message }
