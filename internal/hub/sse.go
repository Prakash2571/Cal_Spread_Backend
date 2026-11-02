package hub

import (
	"errors"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/kite/jsjson"
	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

// Client is one attached SSE consumer. The hub writes complete frames to it from one
// goroutine per client, in order; WriteFrame errors are ignored (as Node ignored write
// errors: the route's own close handling detaches the client). Close is called when the
// client fell too far behind and was dropped (see Deps.ClientQueue) and again when it is
// detached, so it must be idempotent and must not block.
type Client interface {
	WriteFrame(frame []byte) error
	Close()
}

// PingFrame is the keep-alive comment the tick stream writes every 20 s
// (marketDataRoutes.ts).
var PingFrame = []byte(": ping\n\n")

// PingInterval is the keep-alive period of the tick stream.
const PingInterval = 20 * time.Second

// DataFrame is an unnamed SSE message: "data: <payload>\n\n".
func DataFrame(payload []byte) []byte {
	b := make([]byte, 0, len(payload)+8)
	b = append(b, "data: "...)
	b = append(b, payload...)
	return append(b, '\n', '\n')
}

// EventFrame is a named SSE message: "event: <name>\ndata: <payload>\n\n".
func EventFrame(event string, payload []byte) []byte {
	b := make([]byte, 0, len(payload)+len(event)+16)
	b = append(b, "event: "...)
	b = append(b, event...)
	b = append(b, "\ndata: "...)
	b = append(b, payload...)
	return append(b, '\n', '\n')
}

// KiteErrorFrame is the frame written to every client when the hub's own Kite socket
// fails: event: kite_error, data: {"message": …}.
func KiteErrorFrame(message string) []byte {
	payload := jsjson.AppendString([]byte(`{"message":`), message)
	return EventFrame("kite_error", append(payload, '}'))
}

// TicksJSON is JSON.stringify(ticks) for hub ticks: keys token, last_price, close_price,
// oi, bid, ask, then bids/asks when supplied (non-nil), depth_updated when known and
// exchange_ts when present; levels are {price, qty, orders}. Numbers follow JavaScript
// (NaN and the infinities as null).
func TicksJSON(ticks []market.Tick) []byte {
	b := make([]byte, 0, 96*len(ticks)+2)
	b = append(b, '[')
	for i := range ticks {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendTick(b, &ticks[i])
	}
	return append(b, ']')
}

func appendTick(b []byte, t *market.Tick) []byte {
	b = append(b, `{"token":`...)
	b = strconv.AppendInt(b, t.Token, 10)
	b = append(b, `,"last_price":`...)
	b = jsjson.AppendNumber(b, t.LastPrice)
	b = append(b, `,"close_price":`...)
	b = jsjson.AppendNumber(b, t.ClosePrice)
	b = append(b, `,"oi":`...)
	b = jsjson.AppendNumber(b, t.OI)
	b = append(b, `,"bid":`...)
	b = jsjson.AppendNumber(b, t.Bid)
	b = append(b, `,"ask":`...)
	b = jsjson.AppendNumber(b, t.Ask)
	if t.Bids != nil {
		b = append(b, `,"bids":`...)
		b = appendLevels(b, t.Bids)
	}
	if t.Asks != nil {
		b = append(b, `,"asks":`...)
		b = appendLevels(b, t.Asks)
	}
	if t.DepthUpdated != nil {
		b = append(b, `,"depth_updated":`...)
		b = strconv.AppendBool(b, *t.DepthUpdated)
	}
	if t.ExchangeTS != nil {
		b = append(b, `,"exchange_ts":`...)
		b = strconv.AppendInt(b, *t.ExchangeTS, 10)
	}
	return append(b, '}')
}

func appendLevels(b []byte, levels []market.DepthLevel) []byte {
	b = append(b, '[')
	for i, l := range levels {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"price":`...)
		b = jsjson.AppendNumber(b, l.Price)
		b = append(b, `,"qty":`...)
		b = jsjson.AppendNumber(b, l.Qty)
		b = append(b, `,"orders":`...)
		b = jsjson.AppendNumber(b, l.Orders)
		b = append(b, '}')
	}
	return append(b, ']')
}

// ErrSSEClosed is returned by SSEWriter.WriteFrame after Close.
var ErrSSEClosed = errors.New("hub: SSE stream closed")

// SSEWriter is the Client for an http.ResponseWriter. Every write (hub frames and the
// route's pings) is serialised by one mutex and flushed at once.
type SSEWriter struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	rc      *http.ResponseController
	closed  atomic.Bool
	writing atomic.Bool
	done    chan struct{}
	once    sync.Once
	// WriteTimeout bounds one frame write (0 = none). Set before the first write.
	WriteTimeout time.Duration
}

// StartSSE writes the tick stream's headers exactly as marketDataRoutes.ts did
// (Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive,
// X-Accel-Buffering: no), flushes them and returns the writer.
func StartSSE(w http.ResponseWriter) *SSEWriter {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	s := NewSSEWriter(w)
	_ = s.rc.Flush()
	return s
}

// NewSSEWriter wraps w without touching headers.
func NewSSEWriter(w http.ResponseWriter) *SSEWriter {
	return &SSEWriter{w: w, rc: http.NewResponseController(w), done: make(chan struct{})}
}

// WriteFrame writes one frame and flushes it.
func (s *SSEWriter) WriteFrame(frame []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// writing is set before closed is checked, and Close sets closed before reading
	// writing, so either this write sees the close or Close sees this write.
	s.writing.Store(true)
	defer s.writing.Store(false)
	if s.closed.Load() {
		return ErrSSEClosed
	}
	if s.WriteTimeout > 0 {
		_ = s.rc.SetWriteDeadline(time.Now().Add(s.WriteTimeout))
		// A Close that raced the line above may have set its deadline first; Close sets
		// closed before its deadline, so this re-check sees it.
		if s.closed.Load() {
			return ErrSSEClosed
		}
	}
	if _, err := s.w.Write(frame); err != nil {
		return err
	}
	return s.rc.Flush()
}

// Ping writes the keep-alive comment.
func (s *SSEWriter) Ping() error { return s.WriteFrame(PingFrame) }

// Close stops all further writes and closes Done. It never blocks on the network: a write
// in progress (possibly stuck on a peer that stopped reading) is aborted by moving the
// write deadline to now. Without a write in progress the connection is left alone, so the
// route can still end the response cleanly.
func (s *SSEWriter) Close() {
	s.once.Do(func() {
		s.closed.Store(true)
		if s.writing.Load() {
			_ = s.rc.SetWriteDeadline(time.Now())
		}
		close(s.done)
	})
}

// Done is closed by Close; a route waits on it to end a stream the hub dropped.
func (s *SSEWriter) Done() <-chan struct{} { return s.done }
