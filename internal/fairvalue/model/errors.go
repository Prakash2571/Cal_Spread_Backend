// Package model is the pure Fair Value mathematics ported operation for operation from
// src/fairValue/*.ts: Cephes normal functions, Black-76, implied volatility, raw SVI,
// the bounded Nelder-Mead optimizer, smiles, forwards, discount curves, price-space
// validation, quote cleaning, metadata, maturity interpolation, sensitivity, the
// calculator, the independent estimate and the surface pipeline. It has no clock, no
// I/O and no goroutines; the engine package owns those.
//
// Errors: the TypeScript functions throw Error objects deep inside call chains (for
// example blackPrice inside an SVI residual), and the worker turns any throw into a
// rejected job with that message. To keep those semantics exactly, the functions here
// panic with *Error where the TypeScript throws, and every entry point that the engine,
// the routes or the worker pool call (BuildSurface, Calculate, IndependentEstimate,
// MergeConfig, ...) has a Try-style wrapper or uses Catch. Callers outside this package
// should use Catch around the panicking helpers.
package model

import (
	"fmt"
	"runtime"
)

// Error is a TypeScript Error thrown by the model. Message is the exact Node text.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

// throw is `throw new Error(message)`.
func throw(message string) { panic(&Error{Message: message}) }

// rangeError is V8's RangeError for an invalid Date (toISOString of NaN).
func rangeError() { panic(&Error{Message: "Invalid time value"}) }

// Catch runs f and converts a thrown model error (or any other panic, as the worker
// converted any JavaScript exception) into an error.
func Catch(f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = AsError(r)
		}
	}()
	f()
	return nil
}

// AsError converts a recovered panic value to an error.
func AsError(r any) error {
	switch x := r.(type) {
	case *Error:
		return x
	case runtime.Error:
		return &Error{Message: x.Error()}
	case error:
		return x
	case string:
		return &Error{Message: x}
	}
	return &Error{Message: fmt.Sprint(r)}
}
