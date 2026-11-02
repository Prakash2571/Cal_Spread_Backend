package ticker

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/market"
)

const (
	// DefaultURL is ticker.ts WS_ROOT.
	DefaultURL = "wss://ws.kite.trade"
	// ErrorMessage is what OnError receives: like the browser WebSocket API, the ticker
	// cannot tell a rejected token from any other connection failure.
	ErrorMessage = "Kite WebSocket error."

	writeTimeout = 10 * time.Second
	closeWait    = 2 * time.Second
)

// errInvalidUTF8 ends the read loop on a text frame that is not UTF-8 (a protocol error).
var errInvalidUTF8 = errors.New("websocket: invalid UTF-8 in text frame")

// Options configures one socket (ticker.ts ConnectOptions plus the injectable URL and
// dialer).
type Options struct {
	// URL replaces wss://ws.kite.trade; api_key and access_token are appended as the
	// query string.
	URL         string
	APIKey      string
	AccessToken string
	// Tokens are subscribed (in "full" mode) as soon as the socket opens.
	Tokens  []int64
	OnTick  func(ticks []market.Tick)
	OnOpen  func()
	OnError func(message string)
	OnClose func()
	// Dialer defaults to websocket.DefaultDialer.
	Dialer *websocket.Dialer
}

// Handle controls one socket (ticker.ts TickerHandle). Its methods never block on the
// network and never invoke the callbacks synchronously, so a consumer may call them while
// holding its own lock.
type Handle interface {
	Close()
	// Subscribe adds tokens on this socket (queued until it opens).
	Subscribe(tokens []int64)
	// Unsubscribe stops streaming tokens (drops them from the queue before open).
	Unsubscribe(tokens []int64)
}

// ConnectFunc opens a socket; Connect is the real one, tests inject fakes.
type ConnectFunc func(Options) Handle

// Connect opens a Kite ticker socket in the background and returns its handle at once.
//
// Event semantics follow Node 22's WebSocket (undici), checked with a loopback probe: a
// close frame or a dropped connection fires OnClose only; a protocol violation
// (reserved bits, a masked server frame, a text frame that is not UTF-8) fires OnError
// then OnClose. A failed handshake, or Close before the socket opened, fires OnError then
// OnClose here; undici fires error only (twice for an early close) and never close, but
// both consumers (hub, lane feed) drop the handle on the first error, so the extra
// OnClose is never observed. Text frames (postbacks) are ignored and so are binary
// messages without ticks (1-byte heartbeats). All callbacks of one socket run
// sequentially on its own goroutine.
func Connect(opts Options) Handle {
	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{
		opts:    opts,
		ctx:     ctx,
		cancel:  cancel,
		pending: append([]int64(nil), opts.Tokens...),
		signal:  make(chan struct{}, 1),
	}
	go c.run()
	return c
}

type conn struct {
	opts   Options
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	ws      *websocket.Conn
	isOpen  bool // set once the socket opened; never reset (as in Node)
	closing bool
	pending []int64
	out     [][]byte // text messages waiting for the writer
	signal  chan struct{}
}

func (c *conn) url() string { return SocketURL(c.opts.URL, c.opts.APIKey, c.opts.AccessToken) }

// SocketURL is the ticker URL: <root>?api_key=<enc>&access_token=<enc> (root "" means
// wss://ws.kite.trade).
func SocketURL(root, apiKey, accessToken string) string {
	if root == "" {
		root = DefaultURL
	}
	return root + "?api_key=" + encodeURIComponent(apiKey) + "&access_token=" + encodeURIComponent(accessToken)
}

// SubscribeMessages are the text frames sent to subscribe tokens (subscribe, then mode
// "full"); none for an empty list.
func SubscribeMessages(tokens []int64) []string {
	var out []string
	for _, m := range subscribeMessages(tokens) {
		out = append(out, string(m))
	}
	return out
}

// UnsubscribeMessage is the text frame sent to unsubscribe tokens.
func UnsubscribeMessage(tokens []int64) string { return string(actionMessage("unsubscribe", tokens)) }

func (c *conn) run() {
	defer c.cancel()
	dialer := c.opts.Dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	ws, resp, err := abandonable(c.ctx, dialer).DialContext(c.ctx, c.url(), nil)
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	if err != nil {
		c.fireError()
		c.fireClose()
		return
	}
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		_ = ws.Close()
		c.fireError()
		c.fireClose()
		return
	}
	c.ws = ws
	c.isOpen = true
	if len(c.pending) > 0 {
		c.out = append(subscribeMessages(c.pending), c.out...)
	}
	c.pending = nil
	c.mu.Unlock()

	writerDone := make(chan struct{})
	go c.writer(ws, writerDone)
	c.kick()
	if c.opts.OnOpen != nil {
		c.safe(c.opts.OnOpen)
	}

	var readErr error
	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			readErr = err
			break
		}
		if mt != websocket.BinaryMessage {
			if !utf8.Valid(data) {
				readErr = errInvalidUTF8 // undici fails the connection
				break
			}
			continue // postbacks / error messages
		}
		if ticks := ParseBinary(data); len(ticks) > 0 && c.opts.OnTick != nil {
			c.safe(func() { c.opts.OnTick(ticks) })
		}
	}
	c.cancel()
	<-writerDone
	_ = ws.Close()

	c.mu.Lock()
	closing := c.closing
	c.mu.Unlock()
	if !closing && isProtocolError(readErr) {
		c.fireError()
	}
	c.fireClose()
}

// abandonable returns a copy of d whose network connections are closed as soon as ctx
// ends. gorilla/websocket watches the context only while connecting TCP; after that the
// handshake waits for the server or HandshakeTimeout (45 s by default), so Close before
// open would otherwise leave the dial running that long. ctx ends when the socket is
// finished (run returns) or abandoned before it opened (Close).
func abandonable(ctx context.Context, d *websocket.Dialer) *websocket.Dialer {
	type dialFunc = func(ctx context.Context, network, addr string) (net.Conn, error)
	watch := func(dial dialFunc) dialFunc {
		return func(dctx context.Context, network, addr string) (net.Conn, error) {
			nc, err := dial(dctx, network, addr)
			if err != nil {
				return nil, err
			}
			context.AfterFunc(ctx, func() { _ = nc.Close() })
			return nc, nil
		}
	}
	cp := *d
	switch {
	case d.NetDialContext != nil:
		cp.NetDialContext = watch(d.NetDialContext)
	case d.NetDial != nil:
		netDial := d.NetDial
		cp.NetDialContext = watch(func(_ context.Context, network, addr string) (net.Conn, error) { return netDial(network, addr) })
	default:
		var nd net.Dialer
		cp.NetDialContext = watch(nd.DialContext)
	}
	if d.NetDialTLSContext != nil {
		cp.NetDialTLSContext = watch(d.NetDialTLSContext)
	}
	return &cp
}

// isProtocolError separates a failed connection (the browser's error-then-close) from a
// close frame or a dropped connection (close only).
func isProtocolError(err error) bool {
	if err == nil {
		return false
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		return false
	}
	var ne net.Error
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.As(err, &ne) {
		return false
	}
	return true
}

func (c *conn) writer(ws *websocket.Conn, done chan struct{}) {
	defer close(done)
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-c.signal:
		}
		c.mu.Lock()
		batch := c.out
		c.out = nil
		c.mu.Unlock()
		for _, msg := range batch {
			_ = ws.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				// A failed send kills the socket; the read loop reports the close.
				_ = ws.Close()
				return
			}
		}
	}
}

func (c *conn) kick() {
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

func (c *conn) safe(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[Ticker] callback panicked: %v", r)
		}
	}()
	fn()
}

func (c *conn) fireError() {
	if c.opts.OnError != nil {
		c.safe(func() { c.opts.OnError(ErrorMessage) })
	}
}

func (c *conn) fireClose() {
	if c.opts.OnClose != nil {
		c.safe(c.opts.OnClose)
	}
}

// Close starts the closing handshake (or abandons a pending connect). OnClose follows on
// the socket's goroutine.
func (c *conn) Close() {
	c.mu.Lock()
	if c.closing {
		c.mu.Unlock()
		return
	}
	c.closing = true
	ws := c.ws
	c.mu.Unlock()
	if ws == nil {
		c.cancel() // abandon the dial; run() reports error + close
		return
	}
	// ws.close() with no code: a close frame without a status, then wait briefly for the
	// server's reply before the read loop gives up. Done in the background so Close never
	// blocks the caller on the network.
	go func() {
		_ = ws.WriteControl(websocket.CloseMessage, []byte{}, time.Now().Add(writeTimeout))
		_ = ws.NetConn().SetReadDeadline(time.Now().Add(closeWait))
	}()
}

// Subscribe sends {"a":"subscribe","v":[…]} then {"a":"mode","v":["full",[…]]} on an
// open socket, or queues the tokens until it opens.
func (c *conn) Subscribe(tokens []int64) {
	c.mu.Lock()
	if !c.isOpen {
		c.pending = append(c.pending, tokens...)
		c.mu.Unlock()
		return
	}
	if len(tokens) > 0 {
		c.out = append(c.out, subscribeMessages(tokens)...)
	}
	c.mu.Unlock()
	c.kick()
}

// Unsubscribe sends {"a":"unsubscribe","v":[…]} on an open socket, or removes the tokens
// from the not-yet-sent queue.
func (c *conn) Unsubscribe(tokens []int64) {
	if len(tokens) == 0 {
		return
	}
	c.mu.Lock()
	if !c.isOpen {
		drop := make(map[int64]struct{}, len(tokens))
		for _, t := range tokens {
			drop[t] = struct{}{}
		}
		kept := c.pending[:0]
		for _, t := range c.pending {
			if _, gone := drop[t]; !gone {
				kept = append(kept, t)
			}
		}
		c.pending = kept
		c.mu.Unlock()
		return
	}
	c.out = append(c.out, actionMessage("unsubscribe", tokens))
	c.mu.Unlock()
	c.kick()
}

// subscribeMessages is ticker.ts sendSubscribe: subscribe, then mode "full" (which
// carries the close price, OI and depth).
func subscribeMessages(tokens []int64) [][]byte {
	if len(tokens) == 0 {
		return nil
	}
	list := tokenList(tokens)
	return [][]byte{
		[]byte(`{"a":"subscribe","v":` + list + `}`),
		[]byte(`{"a":"mode","v":["full",` + list + `]}`),
	}
}

func actionMessage(action string, tokens []int64) []byte {
	return []byte(`{"a":"` + action + `","v":` + tokenList(tokens) + `}`)
}

func tokenList(tokens []int64) string {
	b := make([]byte, 0, len(tokens)*8+2)
	b = append(b, '[')
	for i, t := range tokens {
		if i > 0 {
			b = append(b, ',')
		}
		b = strconv.AppendInt(b, t, 10)
	}
	return string(append(b, ']'))
}

const upperHex = "0123456789ABCDEF"

// encodeURIComponent is JavaScript's encodeURIComponent.
func encodeURIComponent(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'),
			ch == '-', ch == '_', ch == '.', ch == '!', ch == '~', ch == '*', ch == '\'', ch == '(', ch == ')':
			b = append(b, ch)
		default:
			b = append(b, '%', upperHex[ch>>4], upperHex[ch&0xF])
		}
	}
	return string(b)
}
