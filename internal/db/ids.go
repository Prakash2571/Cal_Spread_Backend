package db

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"sync/atomic"
	"time"
)

var (
	idProcess [5]byte
	idCounter atomic.Uint32
)

func init() {
	if _, err := rand.Read(idProcess[:]); err != nil {
		panic("db: cannot seed id generator: " + err.Error())
	}
	var c [4]byte
	if _, err := rand.Read(c[:]); err != nil {
		panic("db: cannot seed id generator: " + err.Error())
	}
	idCounter.Store(binary.BigEndian.Uint32(c[:]))
}

// NewID returns a MongoDB ObjectId-style identifier: 24 lowercase hex characters made of a
// 4-byte timestamp, a 5-byte per-process random value and a 3-byte counter. API ids
// therefore keep the same shape and stay roughly time-ordered.
func NewID() string { return NewIDAt(time.Now()) }

// NewIDAt is NewID for a given instant (tests).
func NewIDAt(t time.Time) string {
	var b [12]byte
	binary.BigEndian.PutUint32(b[0:4], uint32(t.Unix()))
	copy(b[4:9], idProcess[:])
	n := idCounter.Add(1)
	b[9], b[10], b[11] = byte(n>>16), byte(n>>8), byte(n)
	return hex.EncodeToString(b[:])
}

// IDKind says how a path-supplied id should be treated.
type IDKind int

const (
	// IDInvalid ids are rejected (HTTP 400).
	IDInvalid IDKind = iota
	// IDValid ids are 24 hex characters and may exist.
	IDValid
)

// CheckID is mongoose.isValidObjectId for a string as the Node service ran it: mongoose
// 8.24.4 delegates to bson 6.10.4 ObjectId.isValid, which accepts exactly 24 hex
// characters in either case (a 12-character string is NOT valid in bson 6). It returns
// the canonical lowercase form for IDValid ids.
func CheckID(s string) (IDKind, string) {
	if len(s) == 24 {
		if _, err := hex.DecodeString(s); err == nil {
			return IDValid, strings.ToLower(s)
		}
	}
	return IDInvalid, ""
}
