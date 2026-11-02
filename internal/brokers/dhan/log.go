package dhan

import (
	"log"
	"sync/atomic"
)

// Logger receives the package's diagnostic lines (the Node code's console.* calls).
type Logger func(format string, args ...any)

var logger atomic.Pointer[Logger]

// SetLogger replaces the logger (nil restores log.Printf). Safe for concurrent use.
func SetLogger(l Logger) {
	if l == nil {
		logger.Store(nil)
		return
	}
	logger.Store(&l)
}

func logf(format string, args ...any) {
	if l := logger.Load(); l != nil {
		(*l)(format, args...)
		return
	}
	log.Printf(format, args...)
}
