# Live market-data websocket relay

## Plan and existing data path

The relay accepts inbound `GET /api/stream/live` websocket connections only. It
registers one read-only `Hub.AddTickListener` and forwards the hub's natural unit:
one JSON array per tick batch, unfiltered. It never opens an upstream connection,
acquires tokens, loads instruments, requests quotes, or changes subscriptions.

The existing path is `dhan.Feed.handleFrameLocked` / `ToTick` → `Feed.deliver`
(`FeedOptions.OnTicks`) → `Registry.ensureDhanFeed`'s callback →
`Hub.IngestExternalTicks` → `Hub.broadcastLocked` → `AddTickListener` callbacks
and hub SSE clients. Registry routing excludes ticks wanted exclusively by Box or
Spike from the hub; the relay sees exactly what the hub delivers, not those
exclusive ticks. The sole Dhan feed and this routing remain unchanged.

`GET /api/spike/stream` remains a separate SSE endpoint: it authenticates admin
sessions, uses `Engine.Subscribe` / `publishLocked` with a one-slot latest-wins
snapshot channel, and rechecks sessions while streaming. Hub SSE routes
`/api/stream` and `/api/stream/session/{id}` check readiness/token namespace and
market-data session IDs (not admin sessions), then use `Hub.AttachClient` and a
browser token lease. The new relay uses the latest-wins idea, without those
sessions or leases. Gorilla WebSocket v1.5.3 is already a direct dependency.

## Configuration and authentication

Use `wss://calspread.online/api/stream/live` through the deployment proxy, or
`ws://127.0.0.1:3001/api/stream/live` directly on the backend host.

`CALSPREAD_STREAM_SECRET` is read once by `config.Load`, after `app.LoadDotenv`
loads `.env` (or `DOTENV_CONFIG_PATH`), and trimmed like existing config secrets.
Unset, empty, or whitespace-only disables the endpoint: every attempt gets HTTP
503. Missing or incorrect credentials get HTTP 403. Authentication is independent
of admin sessions, with no session lookup or 24-hour expiry.

Supply one of:

- `Authorization: Bearer <STREAM_SECRET>`
- `X-Stream-Secret: <STREAM_SECRET>`
- `?secret=<URL_ENCODED_STREAM_SECRET>` (browser WebSocket clients)

Precedence is Authorization, X-Stream-Secret, then query; an invalid higher-priority
credential does not fall back. Duplicate credentials in the selected form are
rejected. Comparison uses constant-time comparison of SHA-256 digests. No
credentials, request URLs, or authentication errors containing input are logged
by the relay. Its browser Origin check permits any origin because possession of
the explicit shared secret is the authority; cookies are never used.

On the deploy host, run `sudoedit /etc/calspread/calspread.env` and add:

```dotenv
CALSPREAD_STREAM_SECRET=<REPLACE_WITH_HOST_ONLY_RANDOM_SECRET>
```

Then run `sudo systemctl restart calspread`. The service already sets
`DOTENV_CONFIG_PATH=/etc/calspread/calspread.env`; shell environment variables
take precedence by default. Do not put the real value in the repository. The
checked-in Nginx config has a dedicated websocket Upgrade location for this path;
install the updated config, run `sudo nginx -t`, then reload Nginx when deploying.
Keep query strings out of proxy logs (the existing `calspread_safe` access format
does this). The dedicated location suppresses Nginx error logs because upstream
errors can include raw credential-bearing URLs. Live host configuration and proxy
behavior have not been verified.

## Wire format and v1 limits

Each text message is a JSON array containing one hub batch. No initial snapshot
or replay is sent. All numbers below are JSON numbers; timestamps use epoch
milliseconds. Every element has these fields:

| Field | Meaning |
| --- | --- |
| `token` | Existing internal instrument token, not a raw Dhan security ID |
| `last_price`, `close_price` | Hub tick LTP and close |
| `oi` | Hub open interest; existing zero convention is preserved |
| `bid`, `ask` | Best prices; existing zero convention is preserved |
| `bids`, `asks` | Arrays of `{price, qty, orders}`; empty when absent |
| `depth_updated` | Tick provenance flag, or null if unspecified |
| `exchange_ts` | Tick exchange timestamp, or null if absent |
| `received_at` | Time this batch reached the relay, not exchange/trade time |
| `volume` | Day volume if delivered by the source; null when unavailable |
| `tradingsymbol`, `name` | Null: the hub's tick unit carries neither |

Example (one tick in a batch):

```json
[{"token":2000045678,"last_price":100.5,"close_price":99,"oi":1200,"bid":100.4,"ask":100.6,"bids":[{"price":100.4,"qty":25,"orders":2}],"asks":[{"price":100.6,"qty":30,"orders":3}],"depth_updated":true,"exchange_ts":null,"received_at":1794902400000,"volume":null,"tradingsymbol":null,"name":null}]
```

`market.Tick` also contains non-JSON `AveragePrice`, `Volume`, `PriceUpdated`,
`AverageUpdated`, `VolumeUpdated`, and `Namespace`. The existing
`Hub.broadcastLocked` deliberately strips these when building its slim tick
copies. Consequently **production relay volume is currently always null** even
though Dhan's raw ticks contain volume. Dhan `ToTick` also deliberately leaves
`ExchangeTS` nil. Obtaining real volume, exchange time, or symbol metadata here
would require changing the protected hub/routing code or adding a metadata path;
this relay does neither. `received_at` is explicitly a receipt timestamp.

Consumers are read-only. Data messages are discarded (up to a 4096-byte inbound
message limit); ping/pong and close control frames are handled. There is no v1
subscribe/filter protocol and no extra subscription for relay clients. If the
existing feed is idle, only websocket control frames are sent. This endpoint
follows the hub across active-broker changes, just as the hub's other consumers do.

## Capacity, backpressure, and lifetime

At most 10 connections (including handshakes) are admitted per process; additional
authenticated attempts get HTTP 503 immediately, with no waiting queue. Failed
upgrades release their slot. Shutdown refuses new admissions and closes consumers
with websocket code 1001.

Each connection has a bounded one-batch channel and a dedicated writer goroutine.
The hub callback copies a batch once and only attempts nonblocking channel
operations. A full channel drops the older queued batch and retains the latest
batch, so delivery is lossy under load and a dropped batch may contain instruments
absent from its replacement. There is no per-instrument conflation. After 128
queued-batch replacements without writer progress, that consumer is disconnected
with code 1008 (`slow consumer`). Dequeuing a batch resets the replacement count.
No network writes, waits for writers, or client-held locks run in the callback.
Serialization also runs only in the writers.

Writes time out after 5 seconds; close control writes have a 1-second bound.
The upgrade handshake has a 5-second timeout. Server pings are sent every 25
seconds, and pongs extend a 60-second read deadline. Oversized client messages,
read/write failures, and missed pongs end the connection and release its slot.

Go compile/tests could not be run on the authoring VM (no Go toolchain). The
deploy build is the first compile check. Before activation, run
`go test -race ./internal/livestream ./internal/config ./internal/app` and
`go build ./cmd/server` on a Go-equipped host, then check direct and proxied
websocket handshakes. No live broker operation is needed by the relay tests.
