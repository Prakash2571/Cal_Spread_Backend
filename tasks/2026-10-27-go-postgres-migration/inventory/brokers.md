# Inventory: broker integrations and market-data plumbing

Source of truth: Node backend at HEAD `1ea1d95` (`src/`). All `file:line` refs are into `src/`.
Read-only inventory written for the Go port (phase 4). Nothing here was executed against a broker.
Conventions: "ms" = milliseconds; IST = UTC+05:30; `?? x` means "default x when absent/undefined".

---

## 1. Zerodha (Kite Connect v3)

### 1.1 REST client — `kite.ts` (class `KiteClient`, `kite.ts:374`)

Roots: `KITE_API_ROOT = "https://api.kite.trade"` (`kite.ts:10`), `KITE_LOGIN_ROOT = "https://kite.zerodha.com/connect/login"` (`kite.ts:11`).
Constructor throws `KiteError(…, 500)` if apiKey or apiSecret empty (`kite.ts:378`). Env: `KITE_API_KEY`, `KITE_API_SECRET`.

Auth header (`kite.ts:466-477`, `authHeader()`): `X-Kite-Version: 3` and `Authorization: token <api_key>:<access_token>`.
No token → throws `KiteError("Not authenticated. Complete the Zerodha login flow first (/login).", 401)`.

Uniform response handling for every JSON call: parse `{status, data, message}`; failure iff `!res.ok || status !== "success" || !data`
(charges: `!Array.isArray(data)`; historical: `!data.candles`). On failure: if HTTP 401 or 403 → `clearSession()` (drop in-memory token),
then throw `KiteError(json.message ?? "<Failed to …> (HTTP <status>).", res.status || 500)`. NOTE `res.json()` is called before the
ok-check, so a non-JSON error body throws a raw SyntaxError (not KiteError) — preserve or map to 500.
No fetch timeout and no retry anywhere in `KiteClient` (only the historical gate watchdog, below). No pacing on /quote calls.

| Method | Verb + URL | Request | Response fields consumed |
|---|---|---|---|
| `getLoginUrl` `:391` | (browser) `GET https://kite.zerodha.com/connect/login?api_key=<k>&v=3` | URLSearchParams order: `api_key`, `v` | — |
| `generateSession(requestToken)` `:400` | `POST /session/token` | headers `X-Kite-Version: 3`, `Content-Type: application/x-www-form-urlencoded`; form body `api_key, request_token, checksum`; `checksum = hex(sha256(api_key + request_token + api_secret))`. Empty token → `KiteError("Missing request_token.",400)` | `data.access_token, user_id, user_name, email` (+ rest kept). Sets in-memory token. Does NOT clearSession on failure. |
| `getProfile` `:480` | `GET /user/profile` | auth header | `data` object returned verbatim |
| `getQuoteOhlc(ids)` `:506` | `GET /quote/ohlc?i=<id>&i=<id>…` | ids `"EXCH:TRADINGSYMBOL"`, each `encodeURIComponent`; chunks of **500** (`:508`) sequential | values of `data` map with numeric `instrument_token`: `{instrument_token,last_price,ohlc{open,high,low,close}}` |
| `getQuoteFull(ids)` `:537` | `GET /quote?i=…` (500/chunk) | | `instrument_token, last_price??0, ohlc.close??0, oi??0, last_trade_time ?? exchange_timestamp ?? ""` |
| `getQuoteFullOhlc(ids)` `:579` | `GET /quote?i=…` (500/chunk) | | `last_price, ohlc.open/high/low/close, oi` (each ??0) |
| `getQuoteDepth(ids)` `:620` | `GET /quote?i=…` | | `Map<token,{last=last_price??0, bid=depth.buy[0].price??last, ask=depth.sell[0].price??last}>` |
| `getQuoteLadder(ids)` `:657` | `GET /quote?i=…` | | `Map<token,{last, bids, asks}>`; levels `{price=price??0, qty=quantity??0}` filtered `price>0`, best first |
| `getBasketMargin(orders,{considerPositions})` `:702` | `POST /margins/basket?consider_positions=true|false` (default true) | `Content-Type: application/json`; body = JSON array of `{exchange,tradingsymbol,transaction_type,variety,product,order_type,quantity,price}` | `data.initial.total??0`, `data.final.total??0` → `{initial, final, total: final || initial}` |
| `getOrderCharges(orders)` `:744` | `POST /charges/orders` | JSON array `{order_id,exchange,tradingsymbol,transaction_type,variety,product,order_type,quantity,average_price}`; empty input → `[]` without a call | `data[]` row i: `order_id` (string non-empty else req.order_id else String(i)), `tradingsymbol`, `transaction_type` (BUY/SELL else req), `quantity` (num()||req), `price` (num()||req.average_price), `charges` → `parseCharges`, `raw = charges ?? null` |
| `getHistoricalOi(token,from,to,prio="interactive")` `:826` | `GET /instruments/historical/<token>/day?from=<f>&to=<t>&oi=1` | dates `yyyy-mm-dd` (callers may pass `yyyy-mm-dd HH:MM:SS`, URL-encoded) | candle `[ts,o,h,l,c,v,oi]` → `{date=String(c0).slice(0,10), close=Number(c4), oi=Number(c6)}` |
| `getHistoricalFull(token,from,to,interval="day",prio)` `:848` | `…/<token>/<interval>?from&to&oi=1` | | `{date(slice 10),open,high,low,close,volume,oi}` |
| `getHistorical(token,from,to,interval,prio)` `:874` | `…/<token>/<interval>?from&to` (NO oi) | | `{t=String(c0) full, close=c4}` |
| `getHistoricalOiSeries(token,from,to,interval,prio)` `:898` | `…/<token>/<interval>?from&to&oi=1` | | `{t full, close=c4, oi=c6}` |
| `getInstruments(exchange?)` `:923` | `GET /instruments` or `/instruments/<EXCH>` | attempt 1 header only `X-Kite-Version: 3` (no auth); if `!ok && accessToken` → retry with auth header | CSV text → `parseInstrumentsCsv`. Failure 401/403 → clearSession + `KiteError("Zerodha would not serve the instruments list without a session. A one-time login is required (click “Connect to Zerodha”).", status)`; other → `KiteError("Failed to fetch instruments (HTTP s): <first 200 chars of body>")` |

`parseCharges` (`kite.ts:328`, `num` `:316`): `num(v)` = finite number else 0. `gst.total = num(gst.total) || igst+cgst+sgst`;
`total = num(c.total) || tt + exch_turnover + sebi_turnover + brokerage + stamp_duty + gst.total`; `transaction_tax_type` string else "".
Output shape `{transaction_tax, transaction_tax_type, exchange_turnover_charge, sebi_turnover_charge, brokerage, stamp_duty, gst{igst,cgst,sgst,total}, total}`.
Zerodha charges are NEVER computed locally (always `/charges/orders`); Dhan has a local rate card (§2.9).

**Historical gate** (`kite.ts:136-203`, singleton `historicalGate` `:203`): process-wide mutex + pacing for ALL historical calls.
- `HISTORICAL_MIN_GAP_MS = 350` (`:99`) between request STARTS (`lastStartedAt` stamped right before `call()`).
- `HISTORICAL_SLOT_TIMEOUT_MS = 20_000` (`:109`): watchdog releases the slot after 20 s even if the call is still running (call keeps running; up to 2 in flight).
- Priority queue: `background` appended at tail; `interactive` inserted before the first queued background entry (FIFO within class). Release hands the slot directly to the next waiter (no re-check), else `busy=false`. Release-once guard between watchdog and finally.
- `historicalQueueDepth()` (`:206`) = queued count (excludes in-flight).
- Go: a mutex + ordered waiter list (two slices) + `time.AfterFunc` watchdog; must remain a single global instance per process.

**Instrument CSV** (`parseInstrumentsCsv`, `kite.ts:958`): `csv.trim().split("\n")`; header by name lookup (missing col → index -1 → `c[-1]` undefined → default).
Columns used: `instrument_token, exchange_token, tradingsymbol, name, last_price, expiry, strike, tick_size, lot_size, instrument_type, segment, exchange`
(numbers via `Number(x ?? 0)` — note `Number("")` = 0, `Number("abc")` = NaN; strings `?? ""`). Empty lines skipped. `splitCsvLine` (`:1002`): `"` toggles quoting,
`""` inside quotes → literal `"`, `,` outside quotes splits; every field `.trim()` (so `\r` from CRLF is stripped). Kite `expiry` format is `YYYY-MM-DD` (or "").
Instruments cache/TTL is not in `kite.ts`; it is in `brokers/instrumentProvider.ts` (§4.4).

### 1.2 Login / token persistence (`index.ts`, outside the listed files but needed)
- `GET /login` and `/api/login` (`index.ts:1399`): requires FULL admin (`x-admin-token` header or `?x-admin-token=` query) else 403 `{error:"Full admin access required."}`; then `302 → kite.getLoginUrl()`.
- Zerodha redirects the browser to the app's registered redirect URL (frontend e.g. `/zerodha/verify`) with `?request_token=…&status=success`.
- `POST /api/session` (`index.ts:1413`, full admin): body `{request_token}`; `generateSession` → `persistKiteSession` → `triggerPostLoginBackfill`; responds `{authenticated:true,user_id,user_name}`. Error → `status = KiteError.status || 500`, `{error}`; deliberately does NOT clear an existing session.
- `GET /callback` (`index.ts:1440`): legacy; `status!=="success"||!request_token` → `302 ${FRONTEND_URL}/?auth=failed`; success → `/?auth=success`.
- `POST /api/logout` (`index.ts:1463`): clearSession + delete persisted doc.
- `GET /api/kite/access-token` (`index.ts:1475`, full admin): 409 if none; else `{api_key, access_token, login_date: istDayKey()}`.
- Persistence (`db.ts:554-578`): single doc `_id:"current"` in collection `kite_session`: `{access_token, user_id, user_name, login_date (IST YYYY-MM-DD), updated_at}` upsert; no-op when DB disabled.
- Restore on startup (`index.ts:5208`): load; if `login_date !== istDayKey()` → delete and require login; else `kite.setAccessToken`. `istDayKey(at)` = `new Date(at + 5.5h).toISOString().slice(0,10)` (`index.ts:1699`).
- `sendError` (`index.ts:3347`): KiteError 401/403 → clearSession + delete persisted; responds `err.status` `{error}`; other errors 500.
- Feed death (`index.ts:103`): TickerHub `onDead` → `kite.clearSession()` + delete persisted + `onFeedSessionLost()` (Box drops books).

### 1.3 Kite WebSocket ticker — `ticker.ts`
- URL: `wss://ws.kite.trade?api_key=<enc(apiKey)>&access_token=<enc(token)>` (`ticker.ts:11,74`). `binaryType=arraybuffer`. No extra headers. No client-side ping (Kite sends 1-byte heartbeats; ignored by the `<2 bytes` check).
- On open: `sendSubscribe(pendingTokens)` (`:84`) = two text frames, in order:
  `{"a":"subscribe","v":[t1,t2,…]}` then `{"a":"mode","v":["full",[t1,t2,…]]}` (mode is ALWAYS `full`). Empty list → nothing sent.
- `subscribe(tokens)`: open → sendSubscribe; not open → appended to `pendingTokens`.
- `unsubscribe(tokens)`: open → `{"a":"unsubscribe","v":[…]}` (send errors swallowed); not open → removed from pending.
- Text frames (postbacks/errors) ignored (`:101`). `onerror` → `onError("Kite WebSocket error.")`; `onclose` → `onClose()`. The client cannot distinguish auth failure from network error — any `error` event is treated as terminal "dead token" by both consumers (see risks).
- Binary frame (`parseBinary`, `ticker.ts:149`), ALL BIG-ENDIAN:
  - `byteLength < 2` → no ticks (heartbeat). `[0..2) int16 numberOfPackets` (signed read).
  - Per packet: `int16 len` (signed) then `len` bytes; stop if header or body would overrun buffer. Next packet at `offset += len`.
  - Packet: `+0 uint32 instrument_token` (UNSIGNED — must not be int32); divisor from `token & 0xff`: 3 (CDS) → 1e7, 7 (BCD) → 1e4, else 100 (`:229-235`).
    `+4 uint32 last_price / divisor` (all lengths, incl. 8-byte LTP packets).
    `len >= 44` → `+40 uint32 close / divisor`. (Index packets are 28/32 bytes → close stays 0 in this parser; the true Kite index layout puts close at +20 but it is NOT read.)
    `len >= 184` ("full"): `+48 uint32 oi` (count, not scaled); `+60 uint32 exchange_timestamp` seconds → `exchange_ts = sec*1000` (0 → absent);
    depth: bids i=0..4 at `+64 + 12i`, asks at `+124 + 12i`; each level `qty uint32 @+0, price uint32 @+4 (/divisor), orders uint16 @+8, 2 pad`. Level kept only if price > 0.
    `bid = bids[0].price ?? 0`, `ask = asks[0].price ?? 0`.
  - Not read: volume, avg price, buy/sell qty, OHLC, last-trade-time, OI high/low.
  - Emitted `Tick` (`ticker.ts:20`): `{token, last_price, close_price, oi, bid, ask, bids[], asks[], depth_updated: len>=184, exchange_ts}` (bids/asks always present, possibly empty).
- Max tokens per connection: not enforced in code (Kite's documented limit 3000/connection, 3 connections/api_key — comments `hub.ts:11`, `marketDataLane.ts`). Only the Box budget `BOX_MAX_SUBSCRIBED_TOKENS` (2200) bounds the box lane (§5.3).

### 1.4 `ZerodhaFeed` — one lane-scoped Kite socket (`brokers/zerodha/feed.ts`)
- `RECONNECT_BASE_MS = 500` (`:32`), `RECONNECT_MAX_MS = 15_000` (`:33`); delay = `min(15000, 500 * 2^attempts)`; attempts reset on open; `reconnects` counter monotonically increases; timer `unref`.
- State: `wanted` (asked), `subscribed` (believed live), `connected`, `disposed`, `lastTickAt`, `rate: TickRateCounter`, `socketGeneration` (captured at each `ensureSocket`).
- `ensureSocket()`: no-op if disposed or handle exists or no access token (credentials read fresh each connect). Every callback is guarded `this.handle === handle && !disposed`.
  - onTick: drop if `socketGeneration !== generation()` (generation guard); else stamp `lastTickAt`, `rate.mark(n)`, `onTicks(ticks)`.
  - onOpen: attempts=0; `subscribed = copy(wanted)`; setConnected(true). (ticker already sent the constructor list = wanted at connect time; tokens added later via `subscribe` before open are pending in ticker.)
  - onError: `onDead(message)` + `teardown()` (NO reconnect — terminal).
  - onClose: handle=null, subscribed.clear, setConnected(false), `scheduleReconnect()` (only if not disposed, no timer pending and `wanted.size>0`).
- `setTokens(tokens)`: filter finite >0 → diff vs `wanted`; replaces wanted. No handle → `ensureSocket()` if non-empty. Else unsubscribe drops FIRST, then subscribe adds (stay under per-connection cap).
- `subscribeTokens` (additive), `unsubscribeTokens` (only those in wanted). `stats()` → `LaneFeedStats` (§4.6).
- `stop()`: disposed=true, teardown, wanted.clear, rate.reset, lastTickAt=null. Disposed instance is never reused (registry builds a new one).
- `liveAdapter.ts`: `createZerodhaLiveAdapter(kite,cfg,timing)` requires env `KITE_API_KEY` (trimmed) else throws `"[Box] live execution blocked: KITE_API_KEY is missing."`; transport `KiteHttpTransport({apiKey, accessToken: () => kite.getAccessToken() or throw "[Box] live execution blocked: Kite access-token session is missing.", timeoutMs: cfg.liveHttpTimeoutMs})`; adapter config `kiteAdapterConfigFromBoxConfig(cfg)` (+timing). `zerodhaOnlyLiveAdapterFactory` throws for any broker ≠ `"zerodha"`: `[Box] live execution blocked: no live execution adapter is wired for broker "<b>". Refusing to fall back to Zerodha.`

### 1.5 `TickerHub` — shared cache + SSE fan-out (`hub.ts`)
Holds: `clients: Set<{res, tokens:Set}>`, `subscribed`, `retainers: Set<object>`, `tickListeners`, `connectionListeners`, `connected`,
`latest: Map<token,Tick>`, `latestAt`, `latestLadder: Map<token,{last,bids,asks}>`, `latestLadderAt`. Ctor `(getCreds, onDead)`.
- `attachClient(res, tokens)` (`:74`): register for fan-out only; immediately writes snapshot `data: <JSON array of latest ticks for its tokens>\n\n` if any. Returns detach (does NOT stop upstream).
- `addClient(res,tokens)` (`:99`, deprecated legacy Zerodha path): register + `ensureSocket(tokens)` + snapshot; detach stops the socket when `clients.size===0 && retainers.size===0`.
- `seed(ticks)`: put into `latest` only (no `latestAt`).
- `retain(tokens=[])`: adds retainer + ensureSocket; release stops if no clients/retainers. `retainFanout()`: retainer without socket; release never stops.
- `subscribeTokens` → ensureSocket. `unsubscribeTokens(tokens)`: keeps any token still in some SSE client's set; drops the rest from `subscribed`, `latest*`, then `handle.unsubscribe`.
- `ensureSocket(tokens)` (`:216`): no token → no-op; adds fresh to `subscribed`; opens one `connectTicker` with all subscribed (guarded by handle identity) or `handle.subscribe(fresh)`. onOpen → notifyConnection(true); onError → `fail()`; onClose → handle=null, notifyConnection(false). NO reconnect in the hub (legacy path).
- `broadcast(ticks)` (`:288`): for each tick build slim copy `{token,last_price,close_price,oi,bid,ask, bids?, asks?, depth_updated?, exchange_ts? (only if truthy)}`; set `latest`, `latestAt=now`.
  Ladder update rule: authoritative iff `depth_updated===true` OR (`depth_updated===undefined` and tick has own property `bids` or `asks`). Authoritative non-empty → `latestLadder = {last,bids,asks}`, `latestLadderAt=now`; authoritative empty → delete ladder. Non-authoritative → ladder untouched.
  Then tick listeners (sync, each in try/catch), then ONE payload `data: <JSON array>\n\n` written to EVERY client (not filtered by the client's tokens!), write errors swallowed.
  There is NO buffering, throttling, coalescing or backpressure handling in the hub: every upstream batch → one SSE write per client; `res.write` return value ignored (Node buffers unboundedly in the socket). Go must decide: write synchronously per client with a bounded per-client channel (drop/close on full) — document as a deliberate deviation or keep unbounded.
- `getFreshLadder(token, maxAgeMs=5000)` (`:259`); `getLatestTick`; `getLadderSnapshot` returns `{...ladder, at}` (caller applies freshness).
- `ingestExternalTicks(ticks)` = broadcast (Dhan path, and Zerodha lane ticks under the registry). `setExternalConnected(c)` = notifyConnection.
- `fail(msg)` (`:376`): `onDead()`, write `event: kite_error\ndata: {"message":…}\n\n` to all clients, then `stop()`.
- `notifyConnection` dedups (only on change). `addConnectionListener(fn)` calls `fn(connected)` immediately.
- `stop()` (`:408`): close socket, notify false, clear `subscribed, latest, latestLadder, latestLadderAt, latestAt` (clients kept).

---

## 2. Dhan (DhanHQ v2)

### 2.1 Hosts and env (`brokers/dhan/http.ts`)
- `DHAN_API_ROOT = "https://api.dhan.co/v2"` (`http.ts:27`), `DHAN_AUTH_ROOT = "https://auth.dhan.co"` (`:28`).
- Scrip master: `https://images.dhan.co/api-data/api-scrip-master-detailed.csv` (`:31`), fallback `https://images.dhan.co/api-data/api-scrip-master.csv` (`:33`) — public, no auth.
- Feed: `wss://api-feed.dhan.co` (`feed.ts:25`).
- Env (`dhanHttpConfigFromEnv`, `http.ts:48`; parse: unset/blank → default, non-finite → default, else `clamp(round(v), min, max)`):
  `DHAN_HTTP_TIMEOUT_MS` 8000 [500..60000] (`:59`), `DHAN_MIN_INTERVAL_MS` 120 [0..5000] (`:60`), `DHAN_MAX_READ_ATTEMPTS` 3 [1..6] (`:61`), `DHAN_CLIENT_ID` (trimmed) for `client-id`.
  Credentials (`auth.ts:58 readDhanCredentials`): `DHAN_CLIENT_ID`, `DHAN_API_KEY`, `DHAN_API_SECRET` required (else `{ok:false, reason:"Dhan is not configured: <list> missing."}` — list order CLIENT_ID, API_KEY, API_SECRET joined ", "), `DHAN_REDIRECT_URL`, `DHAN_POSTBACK_URL` optional (all trimmed).

### 2.2 Login flow (`brokers/dhan/auth.ts`) — API-key consent flow
`authFetch(url, creds, method, timeoutMs)` (`auth.ts:91`): headers exactly `Accept: application/json`, `app_id: <DHAN_API_KEY>`, `app_secret: <DHAN_API_SECRET>` (no access-token, NOT paced by DhanHttp).
AbortController timeout (default `10_000` ms, `auth.ts:154,184`). Network/abort → `DhanError("Dhan authentication request timed out after <ms>ms." | "Dhan authentication request failed: <msg>", 0, "NETWORK")`.
Body: text → JSON.parse; non-JSON → `{message: text.slice(0,500)}`. `!ok`: message = `errorMessage` || `message` || `"Dhan authentication failed (HTTP <s>)."`; 401/403 → `DhanAuthError(msg,status,null,body)`; else `DhanError(msg,status,null,body)`.
1. `generateDhanConsent(creds)` (`:152`): `POST https://auth.dhan.co/app/generate-consent?client_id=<enc(DHAN_CLIENT_ID)>` (no body). Needs `consentAppId` string else `DhanError("Dhan did not return a consentAppId. Check DHAN_API_KEY / DHAN_API_SECRET and that the app is active.", 502, "NO_CONSENT", body)`. Returns `{consentAppId, loginUrl}`.
2. Browser: `https://auth.dhan.co/login/consentApp-login?consentAppId=<enc>` (`dhanLoginUrl`, `:78`). Dhan redirects to `DHAN_REDIRECT_URL?tokenId=…`.
3. `consumeDhanConsent(creds, tokenId)` (`:181`): `GET https://auth.dhan.co/app/consumeApp-consent?tokenId=<enc>`. Requires `accessToken` string else `DhanError("Dhan did not return an access token for this tokenId. It may already have been used or expired.", 502, "NO_ACCESS_TOKEN", null)`.
   Returns `{accessToken, dhanClientId: str(body.dhanClientId) || creds.clientId, dhanClientName, dhanClientUcc, givenPowerOfAttorney: (===true || ==="true"), expiryTime: parseExpiry(body.expiryTime)}`. tokenId is single-use.
- `parseExpiry` (`:217`): finite number → `<1e11 ? round(v*1000) : round(v)`; non-blank string → numeric same rule, else `Date.parse` (ISO; Go must accept what JS Date.parse accepts — at least RFC3339 and `YYYY-MM-DD HH:mm:ss` local-time? JS parses the latter as LOCAL time; flag), else null.
- `isDhanTokenExpired(exp, now)` (`:232`): null → false; else `exp <= now`.
- `redactedSession` (`:247`) → `{client_id, client_name, client_ucc, power_of_attorney, token_expires_at, token_expired, login_date, login_at (ISO or null)}` — only shape sent to browsers.
- Persistence (`db.ts:595-668`): collection `dhan_session`, single doc `_id:"current"`: `{access_token, dhan_client_id, dhan_client_name, dhan_client_ucc, given_power_of_attorney, expiry_time (epoch ms|null), login_at, login_date (IST day), updated_at}`; save sets `login_at=updated_at=now`. Restore semantics live in registry (§4.1): expiry honoured; null expiry = unknown (validated by use), NOT day-based like Kite.

### 2.3 HTTP transport (`DhanHttp`, `http.ts:83`)
- Headers (`headersFor`, `:102`): `Accept: application/json`, `Content-Type: application/json`, (+opts.headers), unless anonymous: `access-token: <token>` (bare, NOT Bearer; missing → `DhanAuthError("No Dhan session: connect Dhan before calling its API.")` status 401 thrown synchronously BEFORE pacing). `withClientId` → `client-id: <DHAN_CLIENT_ID>` (missing → `DhanError("DHAN_CLIENT_ID is not configured.",0,"CONFIG")`).
- URL `absoluteUrl ?? DHAN_API_ROOT + path`. Body `JSON.stringify(body)` only when defined.
- Pacing: a single promise chain `tail` per DhanHttp instance (strict serialization: next request starts only after the previous one settles) plus `gap = minIntervalMs - (now - lastAt)` sleep; `lastAt` stamped at start. => max ~1 request per 120 ms AND no concurrency. Go: one mutex held for the whole request (incl. response read) + last-start timestamp.
- Timeout per attempt: `timeoutMs` (8 s) via AbortController. Fetch throw → `DhanNetworkError` (`status 0, code "NETWORK"`) message `Dhan request timed out after <ms>ms (<METHOD> <path>)` or `Dhan request failed (<METHOD> <path>): <msg>`.
- Body parse: text; JSON or `{message: text.slice(0,500)}`; empty → null.
- `!ok`: 429 → `DhanRateLimitError("Dhan rate limit hit (<M> <path>).", retryAfter = Number(header Retry-After) if finite>0 else null, body)`; else `normalizeDhanError(status, body, "Dhan API error <s> (<M> <path>).")`.
- 200 with `status` string equal (case-insens.) `"failed"` → `normalizeDhanError(400, body, "Dhan API reported failure (<path>).")`.
- `read()` (`:210`): method default GET; attempts `maxReadAttempts` (3); retry iff `isRetryableRead(err)` and not last attempt; wait = RateLimit with retryAfterSec → `min(10_000, sec*1000)`; else `attempt*300` ms (300, 600, …) (`:220-222`). Note: a 429 thrown by normalizeDhanError (not via the 429 branch) has retryAfterSec null → linear.
- `write()` (`:237`): exactly one attempt (POST/PUT/DELETE).
- `setAccessTokenReader(reader)` swaps the token source.

### 2.4 Errors (`brokers/dhan/errors.ts`)
| Class | status | code | notes |
|---|---|---|---|
| `DhanError(message,status,code=null,body=null)` | HTTP or 0 | | `isDefinitive = 400<=status<500 && status!==429` |
| `DhanAuthError` | default 401 | | 401/403 |
| `DhanRateLimitError(message, retryAfterSec=null, body)` | 429 | `"RATE_LIMIT"` | |
| `DhanNetworkError(message, body)` | 0 | `"NETWORK"` | ambiguous for writes |
| `DhanTradingBlockedError(message)` | 0 | `"TRADING_BLOCKED"` | static-IP / config precondition |
`normalizeDhanError(status, body, fallback)` (`:100`): code = `errorCode` | `error_code` | `errorType` (first string) | null; message = `errorMessage` || `error_message` || `message` || fallback; 401/403 → Auth; 429 → RateLimit(null); else DhanError.
`isRetryableRead` (`:131`): Auth → false; RateLimit → true; Network → true; other DhanError → `status >= 500`; non-Dhan → false. (Order matters: the subclass checks come before the base-class check.)

### 2.5 REST endpoints (`brokers/dhan/client.ts`, class `DhanClient(http, clientId)`)
All relative to `https://api.dhan.co/v2`. R = `http.read` (retrying), W = `http.write` (single shot). Lists accept bare array or `{data:[…]}` (`unwrapArray`; anything else → `[]`). `unwrapFirst`: array[0] | data[0] | object containing `orderId` | null.
| Method | Verb path | Body / headers | Notes |
|---|---|---|---|
| `getProfile` `:440` | R GET `/profile` | | `{dhanClientId, tokenValidity, activeSegment, ddpi, mtf, dataPlan, dataValidity}`; session health probe |
| `getFundLimit` `:444` | R GET `/fundlimit` | | `{availabelBalance (sic), sodLimit, collateralAmount, receiveableAmount, utilizedAmount, blockedPayoutAmount, withdrawableBalance}` |
| `placeOrder` `:458` | W POST `/orders` | `{dhanClientId, correlationId, transactionType BUY/SELL, exchangeSegment, productType (CNC/INTRADAY/MARGIN/MTF/CO/BO), orderType (LIMIT/MARKET/STOP_LOSS/STOP_LOSS_MARKET), validity DAY/IOC, securityId (string), quantity, disclosedQuantity?, price, triggerPrice?, afterMarketOrder?}` | → `{orderId, orderStatus}` |
| `modifyOrder` `:462` | W PUT `/orders/{orderId}` | `{dhanClientId, orderId, orderType, legName?, quantity?, price?, disclosedQuantity?, triggerPrice?, validity?}` | |
| `cancelOrder` `:470` | W DELETE `/orders/{orderId}` | no body | |
| `listOrders` `:477` | R GET `/orders` | | `DhanOrder[]` (fields: `dhanClientId, orderId, correlationId, orderStatus (TRANSIT/PENDING/TRADED/PART_TRADED/CANCELLED/CLOSED/REJECTED/EXPIRED), transactionType, exchangeSegment, productType, orderType, validity, tradingSymbol, securityId, quantity, disclosedQuantity, price, triggerPrice, remainingQuantity, averageTradedPrice, filledQty, omsErrorCode, omsErrorDescription, createTime, updateTime, exchangeTime, exchangeOrderId, legName`) |
| `getOrder` `:482` | R GET `/orders/{orderId}` | | unwrapFirst |
| `getOrderByCorrelationId` `:499` | R GET `/orders/external/{correlationId}` | | HTTP 404 → `null` (real "never landed"); other errors rethrown |
| `listTrades` `:514` | R GET `/trades` | | `DhanTrade[]` `{dhanClientId, orderId, exchangeOrderId, exchangeTradeId, transactionType, exchangeSegment, productType, tradingSymbol, securityId, tradedQuantity, tradedPrice, createTime, updateTime, exchangeTime}` |
| `getTradesForOrder` `:520` | R GET `/trades/{orderId}` | | per-order fills |
| `listPositions` `:529` | R GET `/positions` | | `{dhanClientId, tradingSymbol, securityId, positionType LONG/SHORT/CLOSED, exchangeSegment, productType, buyAvg, buyQty, sellAvg, sellQty, netQty, realizedProfit, unrealizedProfit, costPrice, multiplier, drvExpiryDate, drvOptionType, drvStrikePrice}` |
| `calculateMargin(leg)` `:539` | R POST `/margincalculator` | `{...leg, dhanClientId}`; leg `{exchangeSegment, transactionType, quantity, productType, securityId, price, triggerPrice?}` | `{totalMargin, spanMargin, exposureMargin, availableBalance, variableMargin, insufficientBalance, brokerage, leverage}` (fallback only) |
| `calculateMultiMargin(legs,{includePosition=false,includeOrder=false})` `:565` | R POST `/margincalculator/multi` | `{dhanClientId, includePosition, includeOrder, scripList:[legs without dhanClientId]}` — field MUST be `scripList` | normalized by `normalizeDhanMultiMargin` |
| `getStaticIp` `:593` | R GET `/ip/getIP` | | scanned by `extractIpv4Addresses` |
| `marketFeedQuote(req)` `:600` | R POST `/marketfeed/quote` | `client-id` header; body `{"NSE_FNO":[12345,…], "IDX_I":[13]}` (numeric ids) | `{status, data:{<SEG>:{"<secId>":{last_price, last_quantity, last_trade_time, average_price, volume, buy_quantity, sell_quantity, oi, net_change, ohlc{open,close,high,low}, depth{buy[{quantity,orders,price}], sell[…]}}}}}` |
| `marketFeedLtp(req)` `:609` | R POST `/marketfeed/ltp` | same + `client-id` | same envelope, `last_price` |
| `historicalCandles(req)` `:621` | R POST `/charts/historical` | `{securityId (string), exchangeSegment, instrument, expiryCode?, oi?, fromDate, toDate}` (YYYY-MM-DD) | COLUMNAR `{open[],high[],low[],close[],volume[],timestamp[] (epoch SECONDS), open_interest[]?}` |
| `intradayCandles(req)` `:630` | R POST `/charts/intraday` | above + `interval` ("1","5","15","25","60") | columnar |
| `optionChain(req)` `:640` | R POST `/optionchain` | `{UnderlyingScrip:number, UnderlyingSeg, Expiry}` | `{data:{last_price, oc:{"<strike>":{ce:{last_price,oi,previous_oi,volume,implied_volatility,top_bid_price,top_bid_quantity,top_ask_price,top_ask_quantity,greeks{delta,theta,gamma,vega},previous_close_price,previous_volume}, pe:{…}}}}}` |
| `expiryList(scrip, seg)` `:648` | R POST `/optionchain/expirylist` | `{UnderlyingScrip, UnderlyingSeg}` | `string[]` (bare or data) |
NOTE reads that are POSTs (margin, quote, charts) ARE retried by `read()`.
- `normalizeDhanMultiMargin(res)` (`:271`): null/non-object → null; `body = res.data ?? res`; `pickNumber` = first key whose value is a number or `Number(raw)` finite (NB `Number(null)=0`, `Number("")=0` are finite! `Number(undefined)=NaN`). total = `totalMargin|totalMarginRequired|total_margin`; null or `!(total>0)` → null. Else `{total, span: spanMargin|span_margin, exposure: exposureMargin|exposure_margin, foMargin: foMargin|fo_margin, hedgeBenefit: marginBenefit|margin_benefit|hedgeBenefit|hedge_benefit, availableBalance: availableBalance|available_balance, insufficientBalance: insufficientBalance|insufficient_balance}`.
- `describeDhanMarginPayload` (`:302`): top-level key names of `data ?? res` joined ", " (`"<no fields>"`, `"<non-object data>"`, `"<type>"`, `"null"`/`"undefined"`). Values never logged.
- `extractIpv4Addresses` (`:681`): DFS over payload (depth > 6 stops; arrays/objects recurse depth+1), strings trimmed, skip "" and "NA" (case-insens.), strict IPv4 regex `^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$`, dedup, insertion order (JS object key order: integer-like keys first ascending, then insertion order — Go map iteration is random; use an ordered JSON decode if order matters).

### 2.6 Segments (`brokers/dhan/segments.ts`)
Binary code ↔ REST name (`:33`): `0 IDX_I, 1 NSE_EQ, 2 NSE_FNO, 3 NSE_CURRENCY, 4 BSE_EQ, 5 MCX_COMM, 7 BSE_CURRENCY, 8 BSE_FNO` (6 unused).
`dhanSegmentFor(exchange, isIndex=false)` (`:70`): trim+upper; `isIndex || INDICES || IDX_I || IDX` → IDX_I; `NSE|NSE_EQ→NSE_EQ`, `NFO|NSE_FNO→NSE_FNO`, `CDS|NSE_CURRENCY→NSE_CURRENCY`, `BSE|BSE_EQ→BSE_EQ`, `BFO|BSE_FNO→BSE_FNO`, `BCD|BSE_CURRENCY→BSE_CURRENCY`, `MCX|MCX_COMM→MCX_COMM`, else null.
`internalExchangeFor(seg)` (`:109`): NSE_EQ→NSE, NSE_FNO→NFO, NSE_CURRENCY→CDS, BSE_EQ→BSE, BSE_FNO→BFO, BSE_CURRENCY→BCD, MCX_COMM→MCX, IDX_I→INDICES.

### 2.7 Correlation ids (`brokers/dhan/correlation.ts`)
`DHAN_CORRELATION_MAX_LENGTH = 30` (`:47`), role code length 4.
`fnvDigest96(s)` (`:70`), all uint32 arithmetic (Go: `uint32` mul wraps = `Math.imul … >>>0`), iterate UTF-16 code units (`charCodeAt`; Go: `utf16.Encode([]rune(s))`), `len` = UTF-16 length:
```
h1=0x811c9dc5; h2=0x01000193; h3=0xcbf29ce4
for i,ch: h1^=ch; h1*=0x01000193
          h2^=ch+i; h2*=0x85ebca6b
          h3^=ch+(i<<3); h3*=0xc2b2ae35; h3=rotl32(h3,13)
h1^=len;  h3=(h3^len)*0x27d4eb2f
digest = base36(h1)+base36(h2)+base36(h3)   // lowercase, no padding (strconv.FormatUint(x,36))
```
`dhanCorrelationId(clientOrderId)` (`:111`): `digest = digest.replace(/[^A-Za-z0-9]/g,"")`; role = regex `:(k1_ce|k2_ce|k2_pe|k1_pe):` first match → remove FIRST "_" → upper (e.g. `K1CE`) else ""; `budget = 30 - (role?4:0)`; `id = ("B"+digest)[:budget] + role`, then `[:30]`.
`isValidDhanCorrelationId`: 1..30 chars, `^[A-Za-z0-9]+$`. Golden-test this against Node output.

### 2.8 Dhan WebSocket market feed (`brokers/dhan/feed.ts` + `feedDecoder.ts`)
**Connect** (`ensureSocket`, `feed.ts:178`): `wss://api-feed.dhan.co?version=2&token=<enc(accessToken)>&clientId=<enc(clientId)>&authType=2`. Requires token AND clientId else no-op. `binaryType=arraybuffer`. No client-sent ping (server pings; WS library auto-pongs — Go `gorilla/websocket` default ping handler does this; `nhooyr`/`coder` also). Text frames ignored.
**Upstream JSON** (all subscribe = FULL, code 21 regardless of `depthLevel`; `feed.ts:30-37`):
`{"RequestCode":21,"InstrumentCount":n,"InstrumentList":[{"ExchangeSegment":"NSE_FNO","SecurityId":"12345"},…]}` (SecurityId is a STRING), batches of `SUBSCRIBE_BATCH = 100` (`:46`) sent back-to-back without delay.
Unsubscribe: same with `RequestCode: 22`. On stop: `{"RequestCode":12}` (disconnect) then `close()`. Defined but unused: 15 (ticker), 17 (quote).
Tokens that `resolve()` cannot map are skipped with a warn. Send exception → warn and abort remaining batches.
**Downstream binary, LITTLE-ENDIAN** (`feedDecoder.ts`). Frame may hold several packets; walk by declared length. Empty frame → nothing; `<8` bytes → error `frame shorter than the 8-byte header (<n> bytes)`.
Header (8 bytes): `+0 uint8 responseCode`, `+1 int16 messageLength (whole packet incl. header)`, `+3 uint8 exchangeSegment code`, `+4 int32 securityId`.
Loop guard `> 10_000` packets per frame → abort. `len <= 0` → error + stop frame. `offset+len > total` → truncated error + stop. Unknown code → error string, skip by len. Per-type min length checks push an error and SKIP the packet (but still advance).
| Code | Name | Min bytes | Fields (offset from packet start; f32 = IEEE float32 RUPEES, no divisor) |
|---|---|---|---|
| 1 | INDEX | 16 | same as TICKER |
| 2 | TICKER | 16 | `+8 f32 LTP`, `+12 int32 LTT epoch s` (→ms, 0 = absent) |
| 4 | QUOTE | 50 | core (below) + `+34 f32 open, +38 f32 close, +42 f32 high, +46 f32 low` |
| 5 | OI | 12 | `+8 int32 oi` |
| 6 | PREV_CLOSE | 16 | `+8 f32 prev_close`, `+12 int32 prev_oi` |
| 7 | MARKET_STATUS | — | header only, emitted then ignored by feed |
| 8 | FULL | 162 | core + `+34 int32 oi, +38 int32 oi_day_high, +42 int32 oi_day_low, +46 f32 open, +50 f32 close, +54 f32 high, +58 f32 low`, depth at `+62`: 5 × 20 bytes |
| 50 | DISCONNECT | — | `disconnect_code = len>=10 ? int16 @+8 : 0`; feed logs and skips |
Core (QUOTE/FULL): `+8 f32 LTP, +12 int16 LTQ, +14 int32 LTT s→ms (0→absent), +18 f32 ATP, +22 int32 volume, +26 int32 total_sell_qty, +30 int32 total_buy_qty`.
Depth level i at `+62+20i` (stop if beyond buffer): `int32 bidQty @0, int32 askQty @4, int16 bidOrders @8, int16 askOrders @10, f32 bidPrice @12, f32 askPrice @16`; keep a side only if price > 0; qty/orders clamped `max(0,·)`.
float32 → JS number is the exact float32 value widened to float64 (e.g. 101.05 → 101.05000305175781). Go `float64(math.Float32frombits(…))` is bit-identical. Do NOT round.
**Merge into per-token state** (`merge`, `feed.ts:312`): state `{token,last_price,close_price,oi,volume,bids,asks,receivedAt}` init zeros/[]; apply if present: `last_price`; `close → close_price`; `prev_close` only if `close_price===0`; `oi`; `prev_oi` only if `oi===0`; `volume`; `bids`/`asks` overwrite (empty ladder overwrites). Then `toTick(state, depthUpdated = packet.bids!==undefined || packet.asks!==undefined)` (`:468`) = `{token,last_price,close_price,oi,bid=bids[0].price??0,ask=asks[0].price??0,bids,asks,depth_updated}` — `exchange_ts` NEVER set (LTT is trade time, not book time).
**Token attribution** (`tokenFor`, `feed.ts:298`): packet.segment null → drop; linear scan of `wanted` (insertion order) for `resolve(token)` with same securityId and segment code; first match wins; unmatched → dropped. Also `subscribed.add(token)` on first packet (i.e. "subscribed" = has ticked since connect). Go: keep a reverse map `(segCode,secId)→token`, but recompute on wanted changes; behaviour must stay "only wanted tokens".
**Lifecycle**: onopen → connected, attempts=0, `generation++`, clear state/lastTickAt/subscribed, resubscribe all wanted, `onConnection(true)`. onerror → nothing (close follows). onclose(code) → ws=null, clear, `onConnection(false)`; auth close codes `1008, 4001, 4401, 4403` (`:490`) → `onSessionLost("Dhan feed rejected the session (close code <c>) — the access token is invalid or expired.")` and NO reconnect; else `scheduleReconnect`.
Reconnect (`:405`): `attempts++`; `delay = min(30_000, 500 * 2^min(6, attempts-1))` → 500, 1000, 2000, 4000, 8000, 16000, 30000…; timer unref; constructor failure also schedules.
`subscribeTokens(tokens)`: add fresh to wanted; `ensureSocket()`; if connected send subscribe for fresh only. `unsubscribeTokens`: remove from wanted/subscribed/state; send 22 if connected.
`stop()`: clear timer, send 12, close, clear wanted/subscribed/state, `onConnection(false)` (always). `dispose()`: disposed=true + stop. Stopped-but-not-disposed instance can be restarted by `ensureSocket` (the registry keeps the stopped futures `dhanFeed` object and restarts it via `startActiveFeed`; box-lane feeds are discarded on stop, §4.1).
Max instruments/connection: not enforced anywhere in the feed or registry; Dhan's documented limit is 5000/connection, 5 connections/user (`marketDataLane.ts` comment). The only cap is the Box budget `BOX_MAX_SUBSCRIBED_TOKENS` (§5.3). Diagnostics: `wantedCount, subscribedCount, lastTickAtMs, feedAgeMs, feedGeneration`.

### 2.9 Dhan instrument master (`brokers/dhan/instruments.ts`)
**Internal token** (`dhanInternalToken`, `:54`): `segCode * 1_000_000_000 + securityId` (NSE_FNO 54321 → 2_000_054_321; IDX_I 13 → 13). Fits in int64 (and float64 exactly); Go use `int64` everywhere tokens flow (Kite tokens also exceed int32).
`dhanIdentityFromToken(t)` (`:60`): `seg = floor(t/1e9)`, `sec = t % 1e9`; unknown seg or sec<=0 → null. NB any token < 1e9 decodes to IDX_I (so a Kite token resolves as an IDX_I id — used as fallback when the master isn't loaded).
**CSV** (`parseDhanScripMaster`, `:231`): `split(/\r?\n/)`, drop blank lines; <2 lines → `[]`. `splitCsvLine` (`:78`) like Kite's but does NOT trim fields (`pick` trims). Header alias lookup `columnIndex` (`:110`): normalize header and alias with `trim().toUpperCase().replace(/[\s_-]+/g,"_")`, first alias found wins:
`EXCH_ID|EXCHANGE|EXCH`, `SEGMENT|SEGMENT_NAME`, `SECURITY_ID|SECURITYID` (missing → throw `[Dhan] instrument master has no SECURITY_ID column (header: <first 12 joined ",">…).`), `INSTRUMENT|INSTRUMENT_NAME`, `INSTRUMENT_TYPE|INSTRUMENTTYPE` (looked up but unused), `SYMBOL_NAME|TRADING_SYMBOL|SEM_TRADING_SYMBOL`, `DISPLAY_NAME|SEM_CUSTOM_SYMBOL`, `UNDERLYING_SYMBOL|SEM_UNDERLYING|UNDERLYING`, `UNDERLYING_SECURITY_ID|SEM_UNDERLYING_SECURITY_ID`, `LOT_SIZE|SEM_LOT_UNITS`, `SM_EXPIRY_DATE|EXPIRY_DATE|SEM_EXPIRY_DATE`, `STRIKE_PRICE|SEM_STRIKE_PRICE`, `OPTION_TYPE|SEM_OPTION_TYPE`, `TICK_SIZE|SEM_TICK_SIZE`.
Per row (first pass), in order:
1. `securityId = Number(cell)`; non-finite or <=0 → skip (skippedNoSecurityId).
2. `instrument_type = normalizeDhanInstrumentType(INSTRUMENT, OPTION_TYPE)` (`:146`): opt CE/CALL→CE, PE/PUT→PE; inst contains OPT → opt (or ""); contains FUT → FUT; INDEX|INDICES → INDEX; EQUITY|ES → EQ; else the upper-cased inst verbatim.
3. `isIndex = type==="INDEX" || SEGMENT.upper==="I"`; `resolveSegment(exch, segCode, inst, isIndex)` (`:591`): index → IDX_I; derivative = `seg==="D" || inst⊃FUT || inst⊃OPT`; NSE → derivative?NSE_FNO : seg==="C"?NSE_CURRENCY:NSE_EQ; BSE same with BSE_*; MCX → MCX_COMM; else `dhanSegmentFor(ex)`; null → skip (skippedSegment).
4. `exchange = internalExchangeFor(segment)`; `tradingsymbol = SYMBOL_NAME || DISPLAY_NAME`; empty → skip.
5. `TEST_SYMBOL = /(?:INSETEST|TESTSCRIP|DUMMY|^TEST)/i` (`:184`) on tradingsymbol or UNDERLYING_SYMBOL → skip.
6. `expiry = normalizeDhanExpiry` (`:127`): ""/NA → ""; `^(\d{4})-(\d{2})-(\d{2})` → that; `^(\d{2})[/-](\d{2})[/-](\d{4})` → `YYYY-MM-DD` (input DD/MM/YYYY); else `Date.parse` → UTC ISO date; else "". If expiry ≠ "" and type ∉ {EQ, INDEX} and `Date.parse(expiry+"T00:00:00+05:30") - now > MAX_FUTURE_EXPIRY_DAYS(400, :187) * 86_400_000` → skip.
7. Emit `{instrument_token, exchange_token: securityId, tradingsymbol, name: UNDERLYING_SYMBOL || DISPLAY_NAME || tradingsymbol, last_price: 0, expiry, strike: finite>0 ? v : 0, tick_size: finite>0 ? v : 0.05, lot_size: finite>0 ? v : 0, instrument_type, segment: internalSegment(...), exchange, dhan_security_id, dhan_segment, dhan_underlying_security_id: finite>0 ? v : null}`.
   `internalSegment` (`:159`): INDICES→"INDICES"; FUT→`<EXCH>-FUT`; NFO/BFO→`<EXCH>-OPT`; else exchange. (NB `Number("")` = 0 so blank strike → 0.)
Second pass (underlying `name` resolution for FUT/CE/PE): spot map `securityId → {symbol: normalizeUnderlyingKey(tradingsymbol), isIndex}` for EQ and INDEX rows; `equitySpotSymbols` = EQ symbols. For each derivative: `declared = normalizeUnderlyingKey(name)` (`trim().upper().collapse \s+ to " "`), `stripped = stripContractSuffix(tradingsymbol)`; then
(1) underlying id → EQ spot → `name = spot.symbol`; (1b) → INDEX spot → `declared || stripped` (if non-empty); (2) declared ∈ equitySpotSymbols; (3) stripped ∈ equitySpotSymbols; else `declared || stripped`.
`stripContractSuffix` (`:544`) — **uses JS regex LOOKBEHIND, unsupported by Go RE2; must be hand-coded**:
 stage 1: upper+trim, split `/[\s_\-]+/`, drop empty; pop trailing tokens (keep ≥1) matching `^(?:FUT|CE|PE|\d+(?:\.\d+)?|(?:MONTH)\d{0,4}|\d{2,4}(?:MONTH))$`, rejoin with "-".
 stage 2 (≤8 passes until no change), apply in order each pass: remove `(?<=\d|MONTH)(?:FUT|CE|PE)$`; remove `(?<=[A-Z0-9])(?:MONTH)$`; remove `(?<=[A-Z])\d{2,8}(?:\.\d+)?$`. Finally strip trailing `[-\s]+`. MONTH = `JAN|…|DEC`. Golden-test with Node outputs (`BHEL-Sep2026-FUT`, `BHEL26SEPFUT`, `RELIANCE`, `BAJAJ-AUTO`, `RELIANCE-Sep2026-2500-PE`).
Parse report (`DhanParseReport`, `getDhanParseReport()` `:227`, module-global `lastParseReport`): header, column indices, missingColumns, counts (parsed, skipped*, byExchange, byInstrumentType, fnoFutures, nfoCalls, nfoPuts, nseEquities, indices, distinctFutureUnderlyings, underlyingResolution{byForeignKey,bySymbolColumn,byStrip,unresolved}), up to 8 NFO FUT samples (`:369`). Logs error if distinct FUT underlyings < 50 (`:501`) or NFO futures < 100 (`:508`). Served at `GET /api/dhan/instruments/diagnostics`.
**`DhanInstrumentStore`** (`:616`): TTL `60*60*1000` = 1 h (`:622`); `load(force)` returns cache if fresh && non-empty && !force; single-flight `inFlight` promise shared by concurrent callers (also when force). `fetchMaster`: tries detailed URL then fallback, each plain `GET` (no headers) with 60 s abort (`:650`); `!ok` → `HTTP <s>`; zero rows → error; all failed → `[Dhan] could not load the instrument master: <last msg>`. On success replace `all`, `byToken`, `loadedAt`. `identify(token)` → by master else arithmetic decode. `clear()`.

### 2.10 Dhan charges — local rate card (`brokers/dhan/charges.ts`)
Env (`loadDhanChargeRates`, `:85`; `num`: blank/unset/non-finite → default, NO clamp; `bool`: 1/true/yes, 0/false/no, else default):
`DHAN_BROKERAGE_PER_ORDER` 20, `DHAN_BROKERAGE_MAX_PCT` 0 (0 = uncapped), `DHAN_STT_SELL_PCT` 0.1, `DHAN_STT_ROUND_NEAREST_RUPEE` true, `DHAN_EXCHANGE_TXN_PCT` 0.03503, `DHAN_IPFT_PER_CRORE` 50, `DHAN_SEBI_PCT` 0.0001, `DHAN_STAMP_DUTY_BUY_PCT` 0.003, `DHAN_GST_PCT` 18, `sttType "stt"`, `DHAN_CHARGE_RATE_VERSION` (trim, `||` default `"dhan-nse-options-2026-04-01"`) (`:88-98`).
Per leg (`calculateDhanLegCharges`, `:115`), `value = qty*price`, `round2(v) = Math.round(v*100)/100` (`:102`):
```
brokerage   = round2(maxPct>0 ? min(perOrder, value*maxPct/100) : perOrder)
stt         = SELL ? (roundNearest ? Math.round(value*sttSellPct/100) : round2(…)) : 0
exchange_txn= round2(value*exchangeTxnPct/100 + value*ipftPerCrore/10_000_000)
sebi        = round2(value*sebiPct/100)
stamp_duty  = BUY ? round2(value*stampDutyBuyPct/100) : 0
gst         = round2((brokerage+exchange_txn+sebi)*gstPct/100)
total       = round2(brokerage+stt+exchange_txn+sebi+stamp_duty+gst)
leg = {side, tradingsymbol, quantity, price: round2(price), value: round2(value), brokerage, stt, stt_type, exchange_txn, sebi, stamp_duty, gst, total}
```
Aggregate (`calculateDhanCharges`, `:158`): each head = `round2(Σ leg head)`; plus `legs, source:"kite_estimate", computed_by:"dhan_estimate", broker:"dhan", at`. `reverseDhanOrders` (`:186`) flips side; `dhanRoundTrip` (`:197`) = entry + exit projected at entry prices → `{entry, estimated_exit, entry_total, estimated_exit_total}`. `DhanChargeCalculator` (`:223`): `legs(orders, _source)` (source ignored), `roundTrip(orders, at?)`, `totals(orders) → {entry, exit}`.
JS `Math.round` = round-half-UP (toward +∞), not Go `math.Round` (half away from zero) — identical for positives, but implement `jsRound(x){f:=math.Floor(x); if x-f>=0.5 {return f+1}; return f}` to be exact everywhere.
Zerodha charges are not computed in the listed files: they come from Kite `/charges/orders` (§1.1) or `LocalChargeCalculator` (`box/localCharges.ts`, inventoried with Box).

---

## 3. Broker identity and shared types (`brokers/types.ts`, `brokers/marketDataLane.ts`)
- `BrokerId = "zerodha" | "dhan"`; `BROKER_IDS = ["zerodha","dhan"]`; `LEGACY_BROKER = "zerodha"`; `brokerOf(rec)` → rec.broker if valid else "zerodha"; `brokerLabel` → "DHAN"/"ZERODHA"; `parseBrokerId(v)` → trim+lower, valid else null (caller answers 400).
- `BrokerSessionState {broker, authenticated, client_id, client_name, token_expires_at, token_expired, login_day, login_at}`.
- `BrokerHealthState {broker, authenticated, token_expires_at, token_expired, data_ready, trading_ready, static_ip_configured (null for Zerodha), feed_connected, feed_age_ms, problems[]}`.
- `HistoryInterval = minute|3minute|5minute|15minute|30minute|60minute|day`. `BrokerRuntime {id, session(), health(), shutdown()}` (interface only; the registry does not build such objects).
- `MarketDataLane = "futures" | "box"`; `laneLabel` → "futures/calendar-spread" | "box-arbitrage options". Connection budget comment: Zerodha 3 WS per api_key (2 used), Dhan 5 sockets/user × 5000 instruments.
- `LaneFeedStats {lane, connected, subscribedTokens, wantedTokens, ticksPerSecond, lastTickAgeMs, reconnects, generation}`.
- `TickRateCounter(seconds=10)` (`marketDataLane.ts:82-87`): ring of 10 one-second buckets. `mark(n, now)`: `sec=floor(now/1000)`; same as cursor bucket → add; else advance cursor, overwrite. `perSecond(now)`: average over buckets with `at≠0 && at<newest && newest-at<=10`; `round(avg*10)/10` (`:115`); none → 0.

## 4. Abstractions

### 4.1 `ActiveBrokerManager` (`brokers/registry.ts`) — single-active-broker registry
State: `active: BrokerId = "zerodha"`, `gen = 1` (`:260`), `transitioning`, `lastTickAt`, `probe`, `hooks`; Dhan: `dhanHttp` (env config, token reader `usableDhanToken`, clientId `session.clientId ?? env DHAN_CLIENT_ID`), `dhanClient`, `dhanInstruments` (1 h TTL store), `dhanCharges`, `dhanFeed` (futures lane, lazy), `boxDhanFeed`/`boxZerodhaFeed` (box lane, lazy), `dhanAccessToken`, `dhanTokenExpiry`, `dhanSessionMeta {clientId, clientName, clientUcc, powerOfAttorney, loginDay, loginAt}`, `dhanProblems`, `lastMarginSource`, static-IP verdict fields (`dhanIpVerified: true|false|null`, primary, secondary, checkedAt, error).
Two `SubscriptionCoordinator`s: `subscriptions` (lane futures) and `boxSubscriptions` (lane box), each wired to `subscribeUpstream/unsubscribeUpstream(lane, tokens)` (`:382/:396`):
| lane \ active | zerodha | dhan |
|---|---|---|
| futures | `tickerHub.subscribeTokens / unsubscribeTokens` (hub's own Kite socket, NO auto-reconnect) | `ensureDhanFeed().subscribeTokens` / `dhanFeed?.unsubscribeTokens` |
| box | `ensureBoxZerodhaFeed()` (`ZerodhaFeed`, reconnecting) | `ensureBoxDhanFeed()` (`DhanFeed`) |
Tick routing (wired in `index.ts:124-164`): Kite futures ticks → hub.broadcast (SSE + listeners); Dhan futures ticks → `onDhanTicks` → `noteTick()` + `tickerHub.ingestExternalTicks`; Dhan futures connection → `tickerHub.setExternalConnected`; BOX lane ticks (either broker) → `onBoxLaneTicks` → `noteTick()`, Box engine gets only tokens where `boxSubscriptions.owns("strategy", token)`, synthetic engine gets all; box lane connection → Box engine `onBoxLaneConnection` + synthetic `invalidateBooks`. Box-lane ticks never hit the hub/SSE. Hub tick listeners (Box `feed.addTickListener`, `index.ts:5259`) also call `noteTick()`.
`ensureDhanFeed` (`:1385`) onConnection → recompute problems, `onDhanConnection`, `hooks.publish()`; onSessionLost → `onDhanSessionLost`. `resolve = dhanInstruments.identify`. Box Zerodha feed `onDead` only logs (`[Broker] box lane (zerodha) feed died: …`) — it does NOT clear the Kite session (the hub's onDead does).

Methods (all read `this.active` at call time):
- `generation` getter; `switching` getter (= transitioning); `noteTick(at=now)`.
- `assertActiveBrokerToken(token, ctx)` (`:360`): `instrumentProvider.ownsToken` null → true (universe not loaded); false → console.error "REJECTED token…" and false.
- `setBoxTokens(t)` (`:454`) = `boxSubscriptions.setOwnerTokens("strategy", t)`; `setSyntheticTokens(t)` (`:464`) = `boxSubscriptions.setOwnerTokens("scanner", t)`. (Index wiring calls `synthetic.yieldToBox(uniqueCount)` before `setBoxTokens`.)
- `subscribeTokens(t)` (`:1410`) = `subscriptions.acquire("strategy", t)` (release handle discarded — superseded by the next `setOwnerTokens("strategy")`). `unsubscribeTokens(t)` (`:1415`) bypasses refcounts: upstream-unsubscribes tokens with `countsFor(t)` null or total 0 (coordinator table unchanged). `setStrategyTokens(t)` (`:1430`) = `subscriptions.setOwnerTokens("strategy", t)`. `acquireBrowserTokens(t)` (`:1435`) → `subscriptions.acquire("browser", t).release`.
- `laneStats(lane)` (`:469`): box+zerodha → `ZerodhaFeed.stats()` or empty; box+dhan / futures+dhan → `{connected, subscribedTokens, wantedTokens, ticksPerSecond:0, lastTickAgeMs: feedAgeMs(), reconnects:0, generation: gen}`; futures+zerodha → hub connected/subscribedCount, `wantedTokens = subscriptions.size`, age from `lastTickAt`.
- `stopAllLanes()` (`:519`): try/catch each: `tickerHub.stop()`, `dhanFeed?.stop()`, `boxZerodhaFeed?.stop()`, `boxDhanFeed?.stop()`; then null both box feeds (the futures `dhanFeed` object is KEPT — stopped but restartable via `ensureSocket`).
- `attach(probe, hooks)` (`:538`) once after the engine exists (`index.ts:5373`).
- `restore()` (`:556`, boot): `loadActiveBroker()` (errors → null); valid broker → `active`; `gen = saved.generation` only if greater; `loadDhanSession()`: expired (`isDhanTokenExpired`) → delete + problems `["Dhan session expired — reconnect Dhan"]`; else hydrate token/expiry/meta (`loginAt = login_at ms or now`). If active dhan → recompute problems.
- `startActiveRuntime()` (`:600`): no session for active → log idle and return; dhan → `verifyDhanStaticIp()`; `instrumentProvider.load(true)` (errors logged); `startActiveFeed()` (dhan only: `ensureDhanFeed().ensureSocket()`; Zerodha hub connects lazily); recompute problems. Boot order in `index.ts:5452-5464`: `restoreSessionOnStartup()` (Kite) → `brokerManager.restore()` → `startActiveRuntime()`.
- `usableDhanToken()` (`:620`): token and not expired else null — evaluated on EVERY Dhan request/connection.
- `beginDhanLogin()` (`:631`): creds invalid → `DhanError(reason, 400, "CONFIG")`; → `generateDhanConsent`.
- `completeDhanLogin(tokenId)` (`:638`): consume → set token/expiry/meta (`loginDay = istDayKey()`, `loginAt = now`) → `saveDhanSession` (failure only logged) → problems → fire-and-forget `dhanInstruments.load()` → if `dhanFeed` exists: `stop()`, `dhanFeed=null`, `lastTickAt=null` (recycle onto new token) → `await verifyDhanStaticIp()` → if active is dhan: `instrumentProvider.load(true)`, `startActiveFeed()`, replay `subscriptions.activeTokens()` to futures lane and `boxSubscriptions.activeTokens()` to box lane via `subscribeUpstream`, `hooks.publish()` → problems → return `sessionFor("dhan")`. (NB the box-lane Dhan feed is NOT recycled here; its `accessToken()` closure picks up the new token only on its next reconnect.)
- `logoutDhan()` (`:722`): null token/expiry/meta, `dhanFeed?.stop()`, `dhanInstruments.clear()`, problems `["Dhan is not connected"]`, delete persisted; if active dhan → `hooks.invalidateBooks()`, `hooks.publish()`. (Box-lane Dhan feed not stopped.)
- `onDhanSessionLost(reason)` (`:742`): null token/expiry (meta kept), `dhanFeed?.stop()`, problems `["Dhan session expired — reconnect Dhan"]`, delete persisted; if active dhan → invalidateBooks, `deps.onSessionLost("dhan", reason)` (→ Box `onSessionLost`, synthetic stop), publish.
- Static IP: env `DHAN_STATIC_IP_EXPECTED` (1/true/yes = declared), `DHAN_STATIC_PUBLIC_IP` (trim). `dhanStaticIpReady()` (`:788`): no configured IP → `declared`; env EXPECTED defined and not declared → false; else `dhanIpVerified === true`.
  `verifyDhanStaticIp()` (`:808`): no IP → verdict null, returns `{verified:false, configured_ip:"", primary_ip:null, secondary_ip:null, checked_at, error:null}`; no usable token → verdict false, error `"Cannot verify the static IP without a Dhan session."`; else `GET /ip/getIP` → `extractIpv4Addresses` → primary=[0], secondary=[1], `verified = addresses.includes(ip)`; error texts: none found → `Dhan returned no IP address in its whitelist response, so DHAN_STATIC_PUBLIC_IP (<ip>) could not be verified. Response fields: [<top-level keys | "none">]. Add a Static IP under My Profile → Access DhanHQ APIs → Static IP Setting.`; mismatch → `DHAN_STATIC_PUBLIC_IP (<ip>) does not match Dhan's whitelist (<a, b>).`; exception → verdict false, `Static-IP verification failed: <msg>`. Returns `{verified, configured_ip, primary_ip, secondary_ip, checked_at, error}`.
  `ensureDhanStaticIpVerified()` (`:913`): only if IP configured, verdict null and usable token. `dhanStaticIpState()` → `{ready, declared, configured_ip|null, api_verified, primary_ip, secondary_ip, checked_at, error}`.
- Env gates: `DHAN_DATA_ENABLED` (`:944`; unset/""/1/true/yes → enabled), `DHAN_LIVE_TRADING_ENABLED` (`:949`; only 1/true/yes).
- `computeDhanProblems()` (`:954`) — ordered list: creds reason; "Dhan is not connected" | "Dhan session expired — reconnect Dhan"; "Dhan data API is disabled (DHAN_DATA_ENABLED=false)"; if !ipReady: ipError | (no IP) "Static IP not configured — set DHAN_STATIC_PUBLIC_IP (preferred, API-verified) or DHAN_STATIC_IP_EXPECTED=true. Dhan live order placement is blocked." | "Static IP not yet verified against Dhan — live order placement is blocked."; else if !liveTrading: "Dhan live trading is disabled (DHAN_LIVE_TRADING_ENABLED=false)"; else if no IP: "Static IP is accepted on the manual DHAN_STATIC_IP_EXPECTED flag only — set DHAN_STATIC_PUBLIC_IP to have it verified against Dhan."; then "Feed reconnecting" if dhanFeed exists, disconnected and token set; parse report: "Dhan instrument master is missing columns (<cols>) — see /api/dhan/instruments/diagnostics", and `fnoFutures < 50` → "Only <n> Dhan F&O futures were recognised (expected ~600). The board and scanner will be incomplete — see /api/dhan/instruments/diagnostics". (`healthFor` recomputes live; the cached `dhanProblems` field is assigned but never read in the registry.)
- `sessionFor(broker)` (`:1007`): zerodha → `{authenticated: kite token !== null, client_id/name null, token_expires_at null, token_expired false, login_day null, login_at null}`; dhan → `{authenticated: token && !expired, client_id, client_name, token_expires_at, token_expired, login_day, login_at}`.
- `healthFor(broker)` (`:1036`): zerodha → `data_ready = trading_ready = authenticated`, `static_ip_configured:null`, `feed_connected = hub.isConnected()`, `feed_age_ms:null`, problems `[]` or `["Zerodha is not connected"]`. dhan → `data_ready = authenticated && dataEnabled`, `trading_ready = data_ready && ipReady && liveTradingEnabled`, `static_ip_configured = ipReady`, `feed_connected/feed_age_ms` from futures `dhanFeed`.
- `marketData()` (`:1088`) → `BoxMarketDataProvider {isAuthenticated(), getQuoteFull(ids)}`: zerodha → kite; dhan → `isAuthenticated = usableToken && dataEnabled`, `dhanQuoteFull` (`:1108`): load store, map `"<exchange>:<tradingsymbol>"` → inst, bucket by segment, chunk **1000** per segment (`:1130`), `marketFeedQuote({[seg]: chunk})`, per entry `{instrument_token, last_price: Number()||0, last_trade_time: string or ""}`; per-chunk errors logged and skipped.
- `margins()` (`:1156`) → `BoxMarginProvider {broker (value captured when margins() is called — once at boot in index.ts), basketMargin(orders, opts)}`: zerodha → `kite.getBasketMargin(mapped fields only, opts ?? {})` + `source:"kite_basket"`; dhan → `dhanBasketMargin` (`:1204`): resolve each leg by `exchange:tradingsymbol` (segment `inst.dhan_segment ?? dhanSegmentFor(exchange)`); leg `{exchangeSegment, transactionType, quantity, productType:"MARGIN", securityId:String, price: pickLegPrice}` (`pickLegPrice` `:207`: first finite >0 of `reference_price`, `price`, else **0.05**). None → `{initial:0, final:0, total:0, source:"unavailable"}`. All resolved → `calculateMultiMargin(legs, {includePosition:false, includeOrder:false})` → normalized → `{initial: round(span??0), final: round(total), total: round(total), source:"dhan_multi", hedge_benefit, span, exposure}`; unreadable/throws → per-leg fallback (sequential `calculateMargin`, `total += Number(totalMargin)||0`, `span += Number(spanMargin)||0`, failures skipped); none priced → unavailable; else `{initial: round(span), final: round(total), total: round(total), source:"dhan_per_leg_fallback", hedge_benefit:null, span (unrounded), exposure:null}`. Sets `lastMarginSource`. (`Math.round` = JS half-up.)
- `createLiveAdapter({broker,cfg,timing})` (`:1337`): broker ≠ active → throw `[Box] refusing to build a <b> execution adapter while <active> is the active broker.`; zerodha → `createZerodhaLiveAdapter`; dhan requires `DHAN_LIVE_TRADING_ENABLED` else throw `[Box] Dhan live execution blocked: set DHAN_LIVE_TRADING_ENABLED=true to permit real Dhan orders.`; → `new DhanBrokerAdapter(dhanClient, dhanAdapterConfigFromBoxConfig(cfg, {staticIpReady, dhanClientId, identify, timing}))`.
- `instruments()` → `[]` for zerodha, Dhan store rows otherwise. Getters `dhanInstrumentStore`, `dhan`, `dhanChargeCalculator()` (`:1363`).
- `feedConnected()`, `subscribedCount()` (= futures coordinator size), `upstreamFeedStats()` (`:1459`; dhan → `{wanted|null, subscribed|null, socket_connected, last_tick_at}` from the feed object; zerodha → hub subscribedCount for both, `last_tick_at = lastTickAt`).
- `feedHealth()` (`:1487`) = `computeFeedHealth({connected: feedConnected(), connecting: transitioning, authenticated: session.authenticated && (zerodha || dataEnabled), subscribed: subscriptions.size, universe: size>0?size:null, lastTickAt})`.
- `startActiveFeed()` (`:1502`); `stopFeeds()` (`:1519`) = `stopAllLanes()` (shutdown; coordinator tables untouched).
- `switchBlockers(target)` (`:1534`) — reports ALL: target dhan with bad creds → `broker_not_configured`; no probe → return. Then in order: `scanner_running` ("The Box scanner is running. Press STOP before changing broker."), `open_box_positions` ("<n> open Box position(s) (<brokers joined ", ">). Close, flatten or delete them first."), `working_orders` ("<n> broker order(s) still working. Cancel them before changing broker."), `execution_in_flight` ("An entry or exit is in flight. Wait for it to finish."), `unresolved_reconciliation` ("Broker reconciliation is incomplete. Run reconcile and resolve it first."), `residual_exposure` ("<n> residual leg(s) of exposure outstanding. Flatten them first."), `unknown_order_state` ("<n> order(s) are in an unknown state. Reconcile before changing broker."), `foreign_unresolved_intents` for the LEAVING broker (`unresolvedIntentsFor(leaving)`, errors → 0) ("<n> unresolved <leaving> order intent(s) remain. They can only be reconciled through <leaving>, so resolve them before switching to <target>.").
- **`switchBroker(target, actor)`** (`:1616`) — ORDER IS THE SAFETY PROPERTY:
  0. target === active → `{ok:true, broker}` (no-op). Blockers → `{ok:false, blockers}` (route answers 409).
  1. `transitioning = true`; `hooks.stopScanner()`.
  2. `stopAllLanes()` (all four sockets).
  3. `subscriptions.resetForBrokerSwitch()` + `boxSubscriptions.resetForBrokerSwitch()` (no upstream unsubscribes); `hooks.dropMarketDataSessions()`.
  4. previous dhan → `dhanInstruments.clear()`; `instrumentProvider.invalidate()`; `lastTickAt = null`; `hooks.invalidateBooks()`; `await hooks.clearInstrumentReservations()` (errors logged; TTL fallback).
  5. `persisted = await saveActiveBroker(target, actor)` (`$inc generation`, errors → null); `nextGen = persisted ? max(gen+1, persisted.generation) : gen+1` (`:1697`); THEN assign `active = target; gen = nextGen` together.
  6. target dhan → `dhanInstruments.load(true)` + `verifyDhanStaticIp()`; `instrumentProvider.load(true)` (errors logged).
  7. `await hooks.reloadUniverse()` (errors logged). 8. `startActiveFeed()`. `finally transitioning = false`.
  9. recompute problems; `hooks.publish()`; return `{ok:true, broker: target}`.
  Concurrency: nothing prevents two concurrent `switchBroker` calls (Node interleaves at each await). Go must serialize switches with a mutex and make `(active, gen)` one atomic pair (RWMutex or `atomic.Pointer` to an immutable struct).
- `snapshot()` (`:1738`): `{broker, session, health, dhan_configured, dhan_instruments, dhan_instruments_loaded_at, dhan_static_ip, last_margin_source, generation, feed, subscriptions: subscriptions.stats(), instruments, instruments_loaded_at}`.
- Durable generation (`db.ts:678-754`, save `:728`, load `:748`): collection `active_broker` `_id:"current"` `{broker, selected_at, selected_by (default "admin"), generation}`; save = upsert `$set {broker, selected_by, selected_at}` + `$inc {generation: 1}` returning the new doc (PG: `INSERT … ON CONFLICT DO UPDATE SET generation = active_broker.generation + 1 RETURNING generation`, first insert → 1); load → missing/non-finite generation treated as 1; no DB → save returns null.

### 4.2 `SubscriptionCoordinator` (`brokers/subscriptions.ts`) — refcount semantics
Owners: `browser | scanner | strategy | analytics`. Table `counts: Map<token,{browser,scanner,strategy,analytics,total}>`; `leases: Map<leaseId,{owner, tokens:Set}>`; `leaseSeq` counter.
- `acquire(owner, tokens)` (`:98`): dedupe + keep finite >0; `yieldAnalytics(owner, unique, false)`; leaseId `"<owner>:<++seq>"`; per token `counts[owner]++`, `total++`; collect 0→1 transitions; log; `transport.subscribeTokens(new)` (only if any). Returns `{leaseId, release}`; release is idempotent (guard flag).
- `releaseLease` (`:135`): per token `owner = max(0, owner-1)`, `total = max(0,total-1)`; total 0 → delete + collect; `transport.unsubscribeTokens(dropped)`.
- `setOwnerTokens(owner, tokens)` (`:170`) atomic diff: `yieldAnalytics(owner, want, true)`; delete ALL leases of that owner (acquire-leases included), `previouslyHeld = union of their tokens`; for held∖want decrement once (→ maybe unsubscribe); for want∖held increment (→ maybe subscribe); if want non-empty set lease `"<owner>:set"`; transport UNSUBSCRIBE first, then SUBSCRIBE. (Edge: a token held by the same owner via two leases has owner-count 2 but is decremented once — inherited quirk; keep for parity.)
- `resetForBrokerSwitch()` (`:229`) clears both maps, returns `{droppedTokens, droppedLeases}`, NO transport calls. Lease release closures created before the reset become no-ops (lease id missing) — BUT a new lease could reuse nothing (seq keeps increasing), so this is safe.
- `owns(owner, token)` (`:243`), `activeTokens()` (`:249`, Map insertion order of first acquisition), `size`, `countsFor(token)` (`:272`) copy or null, `stats()` (`:278`) → per-owner count of tokens with that owner >0 + `{tokens, leases, lane}`.
- `setAnalyticsYield(fn)`; `yieldAnalytics` (`:261`): skipped for owner analytics or no handler; `priority = tokens ∪ {t : total - analytics - (replacing ? counts[owner] : 0) > 0}`; handler(priority) in try/catch. Called BEFORE mutating counts.
- Transport callbacks are synchronous and run inside the coordinator call (Go: hold the coordinator mutex across the diff; either call the transport under the lock (transport must not re-enter) or collect and call after unlock with a per-lane wire mutex — preserve unsubscribe-before-subscribe and never interleave two diffs on the wire).

### 4.3 `QuoteProvider` (`brokers/quoteProvider.ts`)
`quotesByToken(tokens)` (`:36`) → `Tick[]` for the ACTIVE broker; empty → `[]`.
- Kite (`:44`): universe from `instruments()` → identifiers `"<exchange>:<tradingsymbol>"` → `kite.getQuoteFull` → `{token, last_price, close_price: close, oi, bid:0, ask:0}` (no depth on purpose).
- Dhan (`:78`): `dhanInstruments.load()` (errors ignored); `get(token)` (master only — no arithmetic fallback); bucket by segment; chunks of 1000 (`:95`); entry → `{token: internal, last_price: Number()||0, close_price: Number(ohlc.close)||0, oi: Number()||0, bid: Number(buy[0].price)||0, ask: Number(sell[0].price)||0, bids?/asks? (only when the depth array is non-empty; levels price>0 → {price, qty: Number(quantity)||0, orders: Number(orders)||0})}`. Chunk errors logged and skipped. `depth_updated` NOT set.

### 4.4 `InstrumentProvider` (`brokers/instrumentProvider.ts`)
`CACHE_TTL_MS = 60*60*1000` (`:28`). One cache per broker `{at, data, broker}` + `generationAt[broker]` + `inFlight[broker]`.
- `load(force=false)` (`:60`): fresh iff cached && same broker && cachedGeneration === current gen && age < 1 h && non-empty; fresh && !force → cached. Existing inFlight && !force → share. Else start `fetchFor(broker)` (dhan → `dhanInstruments.load()` (its own 1 h TTL, so `force` here does NOT force a Dhan re-download); zerodha → `kite.getInstruments()` (all exchanges)) and store on success with the generation captured at START. With `force`, concurrent loads are NOT deduped (each starts a fetch; the map holds the newest).
- `size()`, `loadedAt()` for active broker; `invalidate(broker?)` (`:123`) clears one/all caches (not inFlight, not token indexes).
- `ownsToken(token)` (`:141`): no cache or empty → null; else memoized `Set` of tokens per `(broker, at)`.

### 4.5 Feed health (`brokers/feedHealth.ts`)
`computeFeedHealth(input)` (`:72`), `staleAfterMs` default **30_000** (`:74`), `feed_age_ms = max(0, now-lastTickAt)` or null. Decision order:
1. `!authenticated` → `DOWN` "No broker session — connect the broker."
2. `!connected` → `connecting ? CONNECTING "Connecting to the broker feed…" : DOWN "The broker feed is not connected."`
3. `subscribed === 0` → `CONNECTED_NO_SUBSCRIPTIONS` "Feed connected but nothing is subscribed — open the board or start the scanner. No prices will arrive until something asks for instruments."
4. `lastTickAt === null` → `CONNECTING` "Subscribed to <n> instrument(s), waiting for the first tick."
5. age > staleAfter → `STALE` "No tick for <round(age/1000)>s across <n> subscribed instrument(s)."
6. else `LIVE` "<n> instrument(s) subscribed, last tick <age>ms ago."
Output `{state, connected, subscribed, universe, feed_age_ms, last_tick_at, detail}`. `isFeedUsable(h)` (`:132`) = state === LIVE. NB the registry's `lastTickAt` is fed by BOTH lanes (`noteTick` in box-lane handlers), so box-lane traffic can keep the futures-lane health LIVE.

### 4.6 `HistoryProvider` (`brokers/history.ts`, built at `index.ts:223`)
Same signatures/shapes as the Kite historical methods; routes on `activeBroker()` per call:
`getHistoricalFull(token, from, to, interval="day", prio)`, `getHistorical(token, from, to, interval, prio)` → `{t, close}`, `getHistoricalOi(token, from, to, prio)` → `{date, close, oi}`, `getHistoricalOiSeries(token, from, to, interval, prio)` → `{t, close, oi}`. Zerodha → `kite.*` (through the historical gate). Dhan → `dhanCandles` (`:253`), `prio` ignored (no gate — Dhan pacing is DhanHttp's 120 ms serial chain).
- `dhanTarget(token)` (`:166`): master hit → `{securityId: String(id), segment, instrument: dhanInstrumentClass(inst)}`; else arithmetic identity → `instrument = NSE_FNO ? "FUTIDX" : "EQUITY"`; none → `[]`.
  `dhanInstrumentClass` (`:316`): index-underlying iff `segment==="INDICES" || dhan_segment==="IDX_I"` (NB a NIFTY option's own segment is NSE_FNO, so index options/futures classify as OPTSTK/FUTSTK — inherited quirk); CE/PE → OPTIDX|OPTSTK; FUT → FUTIDX|FUTSTK; INDEX → INDEX; else EQUITY.
- Interval map `dhanInterval` (`:63`): minute→"1", 3minute→"5" (no 3-min at Dhan), 5minute→"5", 15minute→"15", 30minute→"25", 60minute|hour→"60", else (day) → null (daily path).
- `fromDate = new Date(from.slice(0,10))` (UTC midnight), same for to; `ISO_DAY(d) = d.toISOString().slice(0,10)`.
- Daily: one `POST /charts/historical {securityId, exchangeSegment, instrument, oi:true, fromDate, toDate}`; errors → log + `[]`.
- Intraday: `DHAN_INTRADAY_MAX_DAYS` (`:54`) `{"1":5, "5":30, "15":60, "25":60, "60":90}` (fallback 5, `:285`); `chunkDateRange(from, to, maxDays)` (`:134`): `[from,to]` if `maxDays<=0 || to<=from`; else consecutive `[cursor, min(end, cursor+maxDays*86_400_000)]` (chunk boundaries SHARE a day — dedupe below). Sequential `POST /charts/intraday {…, interval, oi:true, fromDate, toDate}` per chunk; chunk errors logged and skipped; merge, dedupe by `date` string (first wins), sort ascending.
- `dhanCandlesToRows` (`:100`): for i over `timestamp` (finite only): `date = istStamp(sec*1000)` (`:90`, `"YYYY-MM-DD HH:MM:SS"` IST, zero-padded), `open/high/low/close/volume/oi = numAt(arr,i)` (finite else 0; oi from `open_interest`); sort by date string. NB Dhan `date` is the full IST timestamp even for daily candles (Kite's `getHistoricalOi/Full` slice to 10 chars) — callers get a 19-char string for Dhan daily rows; inherited behaviour.

### 4.7 Board diagnostics + index spot resolution (`brokers/boardDiagnostics.ts`, `indexSpot.ts`)
`INDEX_SPOT_MAP` (`indexSpot.ts:40`): `NIFTY→"NIFTY 50"`, `BANKNIFTY→"NIFTY BANK"`, `FINNIFTY→"NIFTY FIN SERVICE"`, `MIDCPNIFTY→"NIFTY MID SELECT"`, `NIFTYNXT50→"NIFTY NEXT 50"` (Zerodha names; also the allow-list of index underlyings).
`indexSpotCandidates(u, map)` (`:53`): not in map → `[]`; else dedup `[map[u], u]` (Kite name first, then Dhan's convention = the underlying itself). `resolveIndexSpotSymbol(u, hasSpot, map)` (`:69`): first candidate with `hasSpot(c)` else null.
"Index spot sources": there is NO Yahoo fallback for index spot. Spot comes only from the active broker's instrument universe (`segment === "INDICES"` rows) + its feed/REST quotes. Used at `index.ts:1657, 2125, 3282, 3594` and `fairValue/metadata.ts:67`.
`diagnoseBoard(all, indexSpotMap)` (`boardDiagnostics.ts:63`) mirrors `deriveFnoBoard`: futures = `exchange NFO && type FUT && name` grouped by name; `segment==="INDICES"` → index map by tradingsymbol; else `NSE && EQ` → equities. Per underlying: equity match → matchedEquities; else `resolveIndexSpotSymbol` → matchedIndices; else unmatched `{underlying, futureSymbol, futureName, expiry, reason: map[u] ? "no_index_mapping" : "no_spot_equity"}`; plus up to 10 empty-name futures (`empty_underlying`). Returns `{parsedInstruments, futures, uniqueFutureUnderlyings, matchedEquities, matchedIndices, boardSize, unmatchedUnderlyings, unmatchedSamples (≤30), availableEquities, availableIndices}`.
`checkKnownSymbols(all, symbols=[BHEL, RELIANCE, HDFCBANK, SBIN, TCS, INFY, ICICIBANK, AXISBANK, BHARTIARTL])` → per symbol `{symbol, equityFound, futuresFound, validExpiries (/^\d{4}-\d{2}-\d{2}$/), validLotSizes (>0), canonicalUnderlyingMatches, onBoard, failsAt}` with failsAt texts: "no NSE equity row with this trading symbol" | "no NFO future whose canonical underlying is this symbol" | "futures exist but none has a valid YYYY-MM-DD expiry" | "futures exist but none has a positive lot size" | null.

### 4.8 Market-data sessions + SSE stream (`marketDataSession.ts`, `marketDataRoutes.ts`)
`MarketDataSessionStore` (`index.ts:1611`, swept every 60 s by an unref'd interval `index.ts:1614`):
- `DEFAULT_TTL_MS = 5*60_000` (`:36`), `MAX_SESSIONS = 500` (`:45`), `MAX_SESSION_TOKENS = 4000` (`:48`).
- Session `{id, tokens (deduped, order kept), broker, generation, createdAt, lastUsedAt, connections}`; id = 16 random bytes hex (CSPRNG).
- `create` (`:92`): sweep → evictIfFull (if size ≥ 500 evict the LRU session with `connections===0`; if all live, store grows anyway) → insert.
- `resolve(id, broker, gen)` (`:121`): sweep; missing → `not_found`; broker or generation mismatch → DELETE and `stale_generation`; else touch `lastUsedAt`. Sessions are looked up, never consumed (EventSource reconnects reuse them).
- `open`/`close` (`:135/:148`) ± `connections` (floor 0) and touch. `sweep` (`:156`): delete `connections===0 && lastUsedAt < now-ttl`. `dropAll` (`:174`) on broker switch (hook `index.ts:5411`). `stats()` → `{sessions, connections, tokens}`.
- `parseTokenList(input, limit=4000)` (`:213`): not array → `Provide a JSON body of the form { "tokens": [123, 456] }.`; empty → "`tokens` must contain at least one instrument token."; > limit → `Too many tokens: <n> requested, limit is <limit>.`; any element not a finite positive integer NUMBER (numeric strings rejected) → "`tokens` must contain positive integers only."; returns deduped.
SSE (`marketDataRoutes.ts`): constants `MAX_QUOTE_TOKENS = 4000` (`:42`), `QUOTES_TTL_MS = 4000` (`:44`), quotes cache `BoundedTtlCache` max 256 entries (`:75`), key `"<broker>:<gen>:<sorted tokens joined ,>"`.
- `openTickStream` (`:186`): checks BEFORE headers: `!activeHealth().data_ready` → 401 `{error:"Live prices require a <Zerodha|Dhan> session. Connect <X>.", broker, problems}`; foreign tokens (`assertActiveBrokerToken`) → 409 `{error:"<n> requested token(s) do not belong to the active broker (<b>). Refetch the board.", broker, generation, stale_tokens (≤10)}`. Then headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, flush; `tickerHub.attachClient(res, tokens)` (snapshot frame), `acquireBrowserTokens(tokens)`; keep-alive comment `: ping\n\n` every **20_000 ms** (`:246-252`). Cleanup idempotent on `req close`, `res close`, `res error`: clear interval → release lease FIRST → detach → session close → `res.end()`.
- Frames: data `data: <JSON array of Tick>\n\n` (no `event:` name, no `id:`, no `retry:`); error `event: kite_error\ndata: {"message":…}\n\n` (Kite hub socket error only). JSON field order of a tick: `token, last_price, close_price, oi, bid, ask, [bids], [asks], [depth_updated], [exchange_ts]` (DepthLevel `{price, qty, orders}` from the feed; REST seeds may lack `orders` for Kite). Go must emit omitted-vs-present exactly (use pointer/omitempty carefully: `exchange_ts` omitted when 0; `bids`/`asks` present (possibly `[]`) for every feed tick, absent for Kite REST seeds; `depth_updated` absent for REST seeds).
- No server-side throttling/coalescing/backpressure: each upstream WS message → one write to every client (all clients get all ticks, not just their tokens). A slow client buffers in the kernel/Node stream without limit.
- Endpoints (inventoried in the routes inventory): `POST /api/quotes`, `GET /api/quotes?tokens=`, `POST /api/stream/session` → `{id, tokens (count), broker, generation}`, `GET /api/stream/session/:id` (404 not_found / 409 stale), `GET /api/stream?tokens=`, `GET /api/market-data/status` (public), `GET /api/market-data/diagnostics` (full admin; CASE A–D text).
- `serveQuotes` (`:79`): 401 `Quotes require a <broker> session.` / 409 foreign / cache hit `{ticks, broker, cached:true}` / `quoteProvider.quotesByToken` → cache set, `tickerHub.seed(ticks)`, `{ticks, broker, cached:false}`; errors → `sendError`.

### 4.9 Yahoo (`yahoo.ts`) — dividend yields only
Not a market-data or index-spot fallback. `GET https://query1.finance.yahoo.com/v8/finance/chart/<enc(symbol)>.NS?range=1y&interval=1mo&events=div` (`:12,32`) with headers `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36`, `Accept: application/json`; timeout 6000 ms (`:37`). Any failure → 0. `price = meta.regularMarketPrice ?? meta.chartPreviousClose` (≤0/missing → 0); sum `events.dividends[*].amount` where `(d.date ?? Number(key)) >= now/1000 - 365*86400` (`:58`); yield% = `sum/price*100`.
`getDividendYields(symbols, concurrency=6)` (`:77`): 6 workers pulling from a shared cursor (safe only on Node's single thread — Go: channel/atomic index). Used by `GET /api/dividends` (`index.ts:1627`, F&O non-index board symbols, process cache `DIVIDEND_TTL_MS = 24 h` `index.ts:1047`, response `{yields, cachedAt}`).

---

## 5. Box broker plumbing (`src/box/*` broker-facing files)

### 5.1 `BrokerAdapter` contract (`box/brokerAdapter.ts:178`)
```
interface BrokerAdapter {
  mode: "paper" | "live"
  prepareOrder?(req) -> req                         // pure (Kite: stable tag; Dhan: correlation id into `tag`)
  submitOrder(req, beforePost?: () => void) -> BrokerOrder   // beforePost runs AFTER pacing, immediately before the POST; throwing = proven no-POST
  cancelOrder(clientOrderId) -> BrokerOrder | undefined
  modifyOrder?(clientOrderId, {limit_price, quantity?}) -> BrokerOrder
  getOrder(clientOrderId) -> BrokerOrder | undefined
  listOrders() -> BrokerOrder[];  listPositions() -> BrokerPosition[]
  adoptOrder?(intent: IBoxOrderIntent, snapshot: BrokerOrder) -> BrokerOrder
  margins?() -> {available, utilised} | null;  health?() -> {ok, transport: up|down|disabled|unknown, authenticated, message, checked_at}
}
```
- States (`BROKER_ORDER_STATES`): CREATED, SUBMITTING, ACKNOWLEDGED, OPEN, PARTIALLY_FILLED, COMPLETE, CANCEL_REQUESTED, CANCELLED, REJECTED, UNKNOWN, RECONCILIATION_REQUIRED. Terminal (`:233`) = COMPLETE | CANCELLED | REJECTED.
- Reject families: margin, price_band, instrument_unavailable, market_closed, rate_limit, rms, quantity_freeze, auth, generic.
- `BrokerOrderRequest {client_order_id, role, trade_id, attempt_id, purpose, phase, exchange, tradingsymbol, token, side, quantity, pricing: {order_type:"LIMIT", reference_price, tick_size, max_chase_ticks, limit_price}, tag?, paper?}`; `BrokerOrder` = request identity + `{broker_order_id, tag, limit_price, state, filled_quantity, pending_quantity, average_price, fills[{fill_id, quantity, price, at}], reject_family, reject_reason, created_at, updated_at}`; `BrokerPosition {token, exchange, tradingsymbol, net_quantity (signed), average_price}`.
- Errors: `BrokerPreSubmitRefusedError(clientOrderId, stage: dequeue|post_persist|pre_post, durableIdentitySpent, reason)` message `Local pre-submit refusal at <stage>: <reason>`; `BrokerAmbiguousSubmitError(clientOrderId, message, cause?, order?)`; `BrokerOrderRejectedError(order, cause?)` message `order.reject_reason ?? "Broker rejected order."`; `BrokerDisabledError(msg="Live broker adapter is disabled.")`.
- `assertBoundedLimit(req, maxChase?)` (`:237`): integer qty > 0 else `Invalid order quantity <q>.`; pricing must be LIMIT, finite `reference_price>0`, `tick_size>0`, integer `max_chase_ticks>=0` (≤ configured), `0 < limit_price <= 10_000_000` else `Invalid bounded LIMIT pricing envelope.`; tick alignment `|lp/tick - round(lp/tick)| <= 1e-7` else `LIMIT <lp> is not aligned to tick size <t>.`; band = tick*maxChase, tol = `max(1e-8, tick/10_000)`; BUY needs `ref - tol <= lp <= ref + band + tol`, SELL `ref - band - tol <= lp <= ref + tol` else `LIMIT <lp> exceeds the configured chase band.`
- `boxClientOrderId({tradeId, purpose, role, attempt})` (`:269`) = `BOX:<tradeId>:<purpose>:<role>:<attempt-N | attempt string>`.
- `PaperBrokerAdapter` (`:306`) is Box-execution scope (LegExecutor); see the Box inventory.

### 5.2 Broker-neutral seams used by the Box engine (`box/brokerContext.ts`)
- `BoxRestQuote {instrument_token, last_price, last_trade_time ("YYYY-MM-DD HH:MM:SS" IST or "")}`; `BoxMarketDataProvider {isAuthenticated(), getQuoteFull(ids)}`.
- `BoxMarginOrder {exchange, tradingsymbol, transaction_type, variety, product, order_type, quantity, price, reference_price?}`; `BoxMarginSource = kite_basket | dhan_multi | dhan_per_leg_fallback | unavailable`; `BoxBasketMargin {initial, final, total, source, hedge_benefit?, span?, exposure?}`; `BoxMarginProvider {broker, basketMargin(orders, {considerPositions?})}`.
- `BoxLiveAdapterFactory({broker, cfg, timing?}) -> BrokerAdapter` (throw = fail closed).
- `BoxFeedProvider {addTickListener(fn)->remove, addConnectionListener(fn)->remove (must call fn(current) immediately), retain()->release, subscribeTokens, unsubscribeTokens, setStrategyTokens?, setBoxTokens?, subscribedCount(), isConnected()}` — wired at `index.ts:5257-5285` (listener → `noteTick()`; `setBoxTokens` → `synthetic.yieldToBox(unique)` then `brokerManager.setBoxTokens`).
- `BoxChargeCalculatorLike {legs(orders, source?), roundTrip(orders, at?), totals(orders) -> {entry, exit}, rates.rateVersion}`; `BoxChargeCalcOrder {side, tradingsymbol, quantity, price}`.

### 5.3 Pacing (`box/brokerPacing.ts`)
Profiles (`:78`): zerodha `defaultOrderMutationMs 110, floorMs 100` (Kite 10 orders/s; also 400/min, 5000/day); dhan `120 / 120` (matches `DHAN_MIN_INTERVAL_MS`). Unknown broker → strictest (max floor 120, max default 120, label zerodha).
`resolveBrokerPacing(broker, general, orderOverride)` (`:134`): `general = finite ? max(0, floor(g)) : 250`; override `floor(o) > 0` → `< floor ? floor ("clamped_to_floor") : o ("operator_override")`; else profile default (`"broker_default"`); final clamp to floor. Returns `{broker, orderMutationMinIntervalMs, generalMinIntervalMs, source, floorMs, rationale}`.
`pacingWaitMs({pacing, klass, lastCallAt, now})` (`:223`): required = class interval; `lastCallAt` non-finite (−∞ initial) → 0; elapsed negative/non-finite → full interval; else `max(0, required - elapsed)`. `burstPacingBudgetMs(p, n)` = `(n-1) * orderMutation` (n ≤ 1 → 0).
`TransportPacer` (`:291`): strictly serial FIFO chain (next call starts after the previous operation SETTLES). Per call: `wait = max(classWait(lastOrderMutationAt|lastGeneralAt), absoluteWait(lastAnyCallAt, using the ORDER interval))`; counts `absoluteFloorBinds` when the absolute wait is larger; sleeps; stamps `lastAnyCallAt` and the class watermark at the post-wait instant; stats `{orderMutations, generalCalls, totalWaitMs, orderMutationWaitMs, generalWaitMs, absoluteFloorBinds, maxObservedWaitMs}`. `repoint(pacing)` keeps watermarks. Classes: `order_mutation` = place/modify/cancel; `general` (default) = everything else.
Box env (`box/config.ts:1028-1038`, `clampInt(name, default, min, max)`): `BOX_LIVE_HTTP_TIMEOUT_MS 5000 [250..30000]`, `BOX_LIVE_ACK_TIMEOUT_MS 3000 [250..30000]`, `BOX_LIVE_WORKING_TIMEOUT_MS 30000 [1000..600000]`, `BOX_LIVE_PARTIAL_TIMEOUT_MS 10000 [500..300000]`, `BOX_LIVE_CANCEL_TIMEOUT_MS 5000 [250..60000]`, `BOX_LIVE_MAX_MODIFICATIONS 2 [0..10]`, `BOX_LIVE_MAX_CHASE_TICKS 2 [0..20]`, `BOX_LIVE_BROKER_MIN_INTERVAL_MS 250 [50..5000]` (general + poll cadence), `BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS 0 [0..5000]` (0 = profile default). Gates: `BOX_EXECUTION_MODE` (default `paper_latency`; live requires `BOX_LIVE_TRADING_ENABLED=true`, `config.ts:880-884`). Lane: `BOX_DEDICATED_MARKET_FEED` default true (`:923`), `BOX_MAX_SUBSCRIBED_TOKENS` 2200 (`:1127`) — the only per-socket token cap in the code; nothing enforces Kite's 3000/conn or Dhan's 5000/conn directly.

### 5.4 Kite live order transport + adapter (`box/kiteBrokerAdapter.ts`)
**`KiteHttpTransport`** (`:95`) — separate from `KiteClient`: base `https://api.kite.trade`, headers `X-Kite-Version: 3`, `Authorization: token <apiKey>:<accessToken()>`, `Content-Type: application/x-www-form-urlencoded` only when a body exists; body = form-encoded (all values `String()`); AbortController timeout `max(250, timeoutMs)` (`:202`, = `BOX_LIVE_HTTP_TIMEOUT_MS`). Response `json()` → `!ok` → `KiteHttpError(status, message ?? error_type ?? "Kite HTTP <s>", payload)`; ok → `payload.data`. No retries.
| Op | Request | Notes |
|---|---|---|
| `placeOrder` `:107` | `POST /orders/regular` form `exchange, tradingsymbol, transaction_type, quantity, order_type=LIMIT, product=NRML, validity=DAY, price, tag` | missing `order_id` → `BrokerAmbiguousSubmitError("transport-pending", "Kite place-order response omitted order_id; placement is ambiguous and requires reconciliation.")`; any fetch/HTTP/JSON error that is NOT a definitive 4xx (400..499 except 429) → `BrokerAmbiguousSubmitError("transport-pending", "Kite placement did not produce a definitive typed 4xx rejection; reconciliation is required.")` (thrown inside `request`, passed through unchanged); errors raised before the fetch try-block (e.g. `accessToken()` throwing "session is missing") are wrapped by `placeOrder` as ambiguous "Kite placement outcome is unknown; reconciliation is required before retry." (so a missing token at submit is treated as AMBIGUOUS, not rejected) |
| `cancelOrder` `:137` | `DELETE /orders/regular/{id}` | |
| `modifyOrder` `:141` | `PUT /orders/regular/{id}` form `order_type=LIMIT, price, [quantity]` | |
| `getOrder` `:149` | `GET /orders/{id}` → order HISTORY array; last element or null | |
| `listOrders` `:157` | `GET /orders` | rows `{order_id, status, exchange, tradingsymbol, transaction_type, quantity, filled_quantity, pending_quantity, average_price, price, tag, status_message, order_timestamp, exchange_update_timestamp}` |
| `listPositions` `:161` | `GET /portfolio/positions` → `data.net ?? []` | `{instrument_token?, exchange, tradingsymbol, quantity, average_price}` |
| `margins` `:166` | `GET /user/margins/equity` | `available = data.available.live_balance`, `utilised = data.utilised.debits` (finite number else null) |
| `health` `:173` | `GET /user/profile` | ok → up/auth true; error → `{ok:false, transport:"down", authenticated: !(KiteHttpError 401/403)}` |
**`KiteBrokerAdapter`** (`:295`), config from `kiteAdapterConfigFromBoxConfig` (`:275`; pacing `resolveBrokerPacing("zerodha", general, orderOverride)`). Session-local maps: `orders` (clientId→order), `clientByBroker`, `modifications`. EVERY method calls `ensureEnabled()` (`executionMode==="live" && enabled`) → `BrokerDisabledError` — zero calls when disabled (health returns `{ok:false, transport:"disabled", authenticated:false, message:"Kite live adapter is disabled by execution mode or kill switch."}`).
- `prepareOrder`: `tag = stableKiteTag(clientOrderId, req.tag)` (`:823`): requested tag stripped to `[A-Za-z0-9]`, first 20 → use if non-empty; else FNV-1a 32-bit over `for…of` code points using `charCodeAt(0)` (`h=0x811c9dc5; h^=c; h=imul(h,0x01000193)`), `"BOX" + base36(h>>>0).toUpperCase()`, first 20.
- `submitOrder` (`:338`): enabled → prepare → `assertBoundedLimit(maxChaseTicks)` → existing clientId → return clone (in-session idempotency) → order `SUBMITTING` → `call(order_mutation){ beforePost(); placeOrder(LIMIT/NRML/DAY, price=limit_price, tag) }`.
  Errors: `BrokerPreSubmitRefusedError` → delete projection, rethrow. Ambiguous (or non-definitive) → `reconcileByTag` (`:636`: `GET /orders` paced general; exactly one row with that tag AND same exchange/tradingsymbol/transaction_type/quantity AND not owned by another client id → adopt; else null) → adopted: `waitForResolution` (non-terminal) else quarantine `RECONCILIATION_REQUIRED` + `BrokerAmbiguousSubmitError("<msg> (<describeAmbiguity>; tag lookup did not uniquely identify an order, so reconciliation is required and NO retry was attempted)")`. Definitive 4xx → `REJECTED`, `reject_family = classifyKiteReject`, throw `BrokerOrderRejectedError`.
  Success → `broker_order_id`, `ACKNOWLEDGED`, then `waitForResolution`; any throw there → `RECONCILIATION_REQUIRED` + ambiguous error.
- `waitForResolution` (`:705`): loop until terminal; deadline = `ackTimeoutMs` while ACKNOWLEDGED else `workingTimeoutMs` (measured from loop start, `>=`), or partial for `>= partialTimeoutMs` since first PARTIALLY_FILLED → `protectiveCancelAndConfirm`; sleep `max(1, brokerMinIntervalMs)`; `refresh` (GET order history; null → state UNKNOWN).
- `protectiveCancelAndConfirm` (`:723`) / `cancelOrder` (`:440`): `CANCEL_REQUESTED`, DELETE paced order_mutation raced against `cancelTimeoutMs` (`withDeadline`), then `confirmTerminalAfterCancel` (`:748`): refresh until terminal within `cancelTimeoutMs`, sleeping `brokerMinIntervalMs`; else `RECONCILIATION_REQUIRED` + throw ambiguous ("Cancellation was acknowledged locally but broker terminal quantity remains uncertain."). `cancelOrder` without broker id → `RECONCILIATION_REQUIRED` returned.
- `modifyOrder` (`:469`): requires broker id; qty integer `0 < q <= original` else error; re-`assertBoundedLimit` with new limit; `count >= maxModifications` → `Live order modification limit reached.`; PUT; count++ AFTER success; updates limit/pricing/quantity/pending; refresh.
- `listOrders` (`:514`): map each to known clientId or `KITE_ORPHAN:<order_id>`; refreshes known projections. `listPositions` (`:577`) → `{token: instrument_token ?? 0, exchange, tradingsymbol, net_quantity: quantity, average_price}`.
- `adoptOrder` (`:526`): requires snapshot broker id equal to intent's (if intent has one), same exchange/tradingsymbol/side/quantity/limit_price and compatible tag; not owned by another client id.
- `normalizeKiteOrder` (`:847`) + `kiteState` (`:904`): status upper: `COMPLETE`→COMPLETE; contains CANCEL→CANCELLED; contains REJECT→REJECTED; `0<filled<qty`→PARTIALLY_FILLED; `OPEN` or contains `TRIGGER PENDING`→OPEN; contains `VALIDATION` or `PUT ORDER`→ACKNOWLEDGED; else UNKNOWN. One aggregate fill `fill_id = kite:<order_id>:<filled>:<avg>` when filled>0, `at = Date.parse(exchange_update_timestamp)` (server-local-TZ parse of "YYYY-MM-DD HH:MM:SS"!). Orphan template: role k1_ce, purpose PROTECTIVE_CANCEL, phase unwind, tick 0.05, ref/limit `price>0 ? price : 0.05`.
- `classifyKiteReject` (`:834`) regexes, first match wins, on lower-cased message: `/margin|funds|cash/`→margin; `/price.*band|circuit|range/`→price_band; `/instrument|contract|token|scrip.*not/`→instrument_unavailable; `/market.*clos|exchange.*clos|outside.*hour/`→market_closed; `/rate.*limit|too many|429/`→rate_limit; `/\brms\b|risk management/`→rms; `/quantity|freeze|lot size/`→quantity_freeze; `/auth|token|permission|401|403/`→auth; else generic. (These are RE2-compatible.)

### 5.5 Dhan live order adapter (`box/dhanBrokerAdapter.ts`)
Config `dhanAdapterConfigFromBoxConfig(cfg, {staticIpReady, dhanClientId, identify})` (`:122`) — same Box timeouts; pacing `resolveBrokerPacing("dhan", …)`. Calls go TransportPacer → DhanHttp (second serial chain + 120 ms). Maps: `orders`, `clientByBroker`, `clientByCorrelation`, `modifications`.
- Gates: reads/`listOrders`/`listPositions`/`getOrder`/`adoptOrder`/`margins` → `ensureEnabled()` (`BrokerDisabledError("Dhan live broker adapter is disabled.")`); MUTATIONS (`submitOrder`, `cancelOrder`, `modifyOrder`) → `ensureTradingReady()` (`:279`) = enabled + `staticIpReady()` else `DhanTradingBlockedError("Dhan live execution blocked: the server's static public IP is not whitelisted for order placement. Whitelist it in the Dhan API dashboard, or set DHAN_STATIC_IP_EXPECTED to confirm it is configured.")`. NB protective cancels are therefore also blocked when the IP check fails.
- `prepareOrder` (`:302`): `tag = dhanCorrelationId(client_order_id)`; invalid → throw.
- `submitOrder` (`:312`): trading-ready → `assertBoundedLimit` → existing → clone → `identify(token)` (none → `No Dhan security id for token <t> (<sym>).`) → order SUBMITTING, `clientByCorrelation` set → `call(order_mutation){ beforePost(); placeOrder({dhanClientId, correlationId, transactionType: side, exchangeSegment, productType:"MARGIN", orderType:"LIMIT", validity:"DAY", securityId: String, quantity, price: limit_price}) }`.
  Errors: PreSubmitRefused → delete maps, rethrow. `DhanError.isDefinitive` (4xx non-429) → REJECTED, family `auth` for DhanAuthError else `classifyDhanReject(code, message)`, throw rejected. Otherwise AMBIGUOUS → `reconcileByCorrelation` (`:440`: `GET /orders/external/{corr}` (404 → null) + `GET /trades/{orderId}` → `project`) → found → `waitForResolution`; else `RECONCILIATION_REQUIRED` + `BrokerAmbiguousSubmitError("Dhan order submission outcome is unknown and correlation lookup did not resolve it: <msg>")`. 200 without `orderId` → same reconcile path, else "Dhan accepted the request but returned no orderId.".
  Success → `state = dhanOrderState(orderStatus, 0, qty)`; REJECTED → family generic, `Dhan rejected the order at submission (status <s>).`; else `waitForResolution`.
- `waitForResolution` (`:451`): `maxPolls = max(10, ceil((working+partial)/max(1,minInterval)) + 10)` (`:459`); per iteration: polls cap → protective cancel; `ACKNOWLEDGED && elapsed > ack` / `elapsed > working` / `now - firstPartialAt > partial` (strict `>`; firstPartial = first time filled > 0) → `protectiveCancelAndConfirm`; sleep `brokerMinIntervalMs`; `refresh` (undefined → break and return the NON-terminal current).
- `protectiveCancelAndConfirm` (`:495`): if broker id: CANCEL_REQUESTED, `DELETE /orders/{id}` (failure logged, NOT thrown); confirm loop `while now < now0+cancelTimeout && polls < max(5, ceil(cancel/minInterval)+5)` (`:519`): sleep then refresh; terminal → return; else `RECONCILIATION_REQUIRED` with reason "Dhan did not confirm a terminal state after a protective cancel within the deadline." RETURNED (Kite throws instead).
- `refresh` (`:561`): `GET /orders/{brokerId}` or by correlation; + fills; `project`; DhanAuthError rethrown; other errors → keep known state.
- `project` (`:600`): `filled = Number(filledQty)||0`; remaining = `remainingQuantity` if present else `max(0, qty - filled)`; state `dhanOrderState(orderStatus, filled, template.quantity)`; tradingsymbol = remote || template; `average_price = finite(averageTradedPrice) or null`; fills from trades: `fill_id = exchangeTradeId ? "dhan:<exchangeTradeId>" : "dhan:<orderId>:<i>:<qty>:<price>"`, `at = parseDhanTime(exchangeTime ?? updateTime ?? createTime)`; no trades & filled>0 → one aggregate `dhan:<orderId>:<filled>:<avg>`; REJECTED → `classifyDhanReject(omsErrorCode, omsErrorDescription)`, reason `omsErrorDescription ?? omsErrorCode ?? "Dhan rejected the order."`.
- `dhanOrderState(status, filled, qty)` (`:156`): TRANSIT→ACKNOWLEDGED; PENDING→(0<filled<qty ? PARTIALLY_FILLED : OPEN); PART_TRADED→(filled>=qty && qty>0 ? COMPLETE : PARTIALLY_FILLED); TRADED→(qty>0 && 0<filled<qty ? PARTIALLY_FILLED : COMPLETE); CANCELLED|CLOSED→CANCELLED; REJECTED→REJECTED; EXPIRED→(0<filled<qty ? PARTIALLY_FILLED : CANCELLED); else UNKNOWN.
- `classifyDhanReject(code, desc)` (`:197`) on lower-cased `"<code> <desc>"`: `/margin|insufficient|fund|balance/`→margin; `/price band|circuit|dpr|price range|freeze price/`→price_band; `/quantity freeze|freeze quantity|max.*quantity|qty freeze/`→quantity_freeze; `/not permitted|not allowed|rms|risk/`→rms; `/market clos|outside market|trading session|not open/`→market_closed; `/instrument|security|symbol|contract.*not|invalid securityid/`→instrument_unavailable; `/rate limit|too many/`→rate_limit; `/token|unauthor|forbidden|session|invalid.*access/`→auth; else generic.
- `parseDhanTime(v, fallback)` (`:211`): `Date.parse(v)` FIRST (V8 parses `"YYYY-MM-DD HH:MM:SS"` as SERVER-LOCAL time, so the `+05:30` branch only runs for unparseable strings) → else `Date.parse(v.replace(" ","T")+"+05:30")` → else fallback.
- `modifyOrder` (`:676`): needs known + broker id; `used >= maxModifications` → `Dhan order <id> has reached its modification cap (<n>).`; re-assert envelope; count++ BEFORE the call; `PUT /orders/{id}` `{dhanClientId, orderId, orderType:"LIMIT", price, [quantity], validity:"DAY"}`; updates pricing/limit only (quantity unchanged); refresh.
- `cancelOrder` (`:668`): unknown → undefined; terminal → clone; else protectiveCancelAndConfirm.
- `listOrders` (`:726`): clientId = `(correlationId && byCorrelation.get(correlationId)) ?? byBroker.get(orderId)` (NB `""` correlationId short-circuits to `""`, no fallback); known → project (no fills); else `orphanOrder` (`:904`: `DHAN_ORPHAN:<orderId>`, role k1_ce, PROTECTIVE_CANCEL, phase entry, `token = Number(securityId)` (RAW security id), exchange `NSE_FNO→"NFO"` else segment string, tick 0.05).
- `listPositions` (`:749`) → `normalizePosition` (`:854`): `token = Number(securityId)` (RAW id, NOT the internal token — comment says otherwise), exchange `NSE_FNO→"NFO"` else segment, `net = netQty`, avg = `net>0 ? buyAvg : net<0 ? sellAvg : 0`; drops net 0 / non-finite ids.
- `adoptOrder` (`:764`): broker-id mismatch / exchange/symbol/side/qty mismatch / owned by another → throw; tag = `intent.broker_correlation_id ?? dhanCorrelationId(client_order_id)`.
- `margins` (`:809`): `GET /fundlimit` → `{available: availabelBalance, utilised: utilizedAmount}`; error → null. `health` (`:822`): `GET /profile` → `{ok: staticIpReady, transport:"up", authenticated:true, message: null | "Dhan session is live but the static public IP is not whitelisted, so order placement is blocked."}`; error → `transport: DhanNetworkError ? "down" : "unknown"`, `authenticated: !DhanAuthError`.

### 5.6 Box universe and quote store (`box/instruments.ts`, `box/quotes.ts`)
- `indexOptionChains(all, today)` (`instruments.ts:59`): NFO CE/PE with name, expiry, strike>0, `expiry >= today` (string compare, IST day); nearest expiry per underlying (lexicographic); strikes with BOTH CE and PE ascending; lot = first positive; skip if none. `toBoxInstrument` carries `tick_size` only if > 0. `buildUnderlyingState` / `windowNeedsRebuild` / `windowTokens` / `prioritiseUniverse` (indices first, then stocks, each `localeCompare` by symbol — Go: use a collation-free compare only if symbols are ASCII uppercase; localeCompare differs from byte order for mixed case/punctuation like `-`, `&`) / `isExpiryToday`. Math (`selectStrikeWindow`, `strikeStepOf`, `shouldRecentreWindow`) lives in `box/math.ts` (Box inventory).
- `BoxQuoteStore` (`quotes.ts:45`): `applyTicks(ticks, at=now)`: authoritative iff `depth_updated===true` or (undefined and own-property bids/asks); else `depthlessIgnored++`. Authoritative: sanitize levels (drop non-finite/≤0 price or non-safe-integer/≤0 qty → `malformedLevelsDropped++`; orders `floor` or 0), sort (BUY desc, SELL asc), keep 5 (`:220`); both empty → delete book, `emptyInvalidations++`, consume a version; else store `{token, bid, bid_qty (sum of qty at best price), ask, ask_qty, last (finite or 0), bids, asks, version: nextVersion++, at, exchange_at: exchange_ts>0 ? it : null, source:"ws"}`. Listeners `(changed, at)` called synchronously after the batch (try/catch). `isFresh(token, maxAge)`, `forget`, `clear` (also resets lastUpdate), `invalidateGeneration` (counter + clear), `replay`. `SpotStore` (`:252`): `set` ignores ≤0; `isFresh`.

---

## 6. Node single-thread assumptions → Go synchronization
Everything below is safe in Node only because callbacks never run in parallel; each needs explicit locking (or single-goroutine ownership) in Go. Run the ported suites with `-race`.
| # | State | Where | Go requirement |
|---|---|---|---|
| 1 | `HistoricalGate` busy/waiting/lastStartedAt (process-global) | `kite.ts:136` | mutex + two-class FIFO waiter list; watchdog via `time.AfterFunc`; release-once flag |
| 2 | `DhanHttp.tail` promise chain + `lastAt` | `dhan/http.ts:83` | per-instance mutex held for the WHOLE request (strict serial), sleep gap inside |
| 3 | `TransportPacer.tail` + 3 watermarks | `box/brokerPacing.ts:291` | FIFO-fair lock held across the operation (Go `sync.Mutex` is not FIFO — use a ticket channel/queue) |
| 4 | `DhanInstrumentStore.inFlight`, `InstrumentProvider.inFlight` single-flight | `instruments.ts:616`, `instrumentProvider.ts:60` | `singleflight` keyed per broker; note force semantics differ (Dhan store shares in-flight even on force; provider does not) |
| 5 | Registry `active`, `gen`, `transitioning`, Dhan token/expiry/meta, IP verdict, `lastTickAt` | `registry.ts` | RWMutex (or atomic pointer to immutable snapshot); `(active, gen)` must change atomically; `switchBroker` + `completeDhanLogin`/`logoutDhan` serialized by a switch mutex (they span many awaits in Node and can interleave today) |
| 6 | `SubscriptionCoordinator` counts/leases/leaseSeq | `subscriptions.ts` | mutex per coordinator; transport called synchronously in order unsubscribe→subscribe |
| 7 | Feed objects: handle identity guards, `wanted/subscribed/state`, reconnect timers, `disposed` | `zerodha/feed.ts`, `dhan/feed.ts`, `hub.ts` | per-feed mutex; each socket gets an epoch id and every callback/read-loop event checks `epoch == current` under the lock (replaces `this.handle !== handle`); timers re-check `disposed` |
| 8 | `TickerHub` `latest*` maps, `clients`, listeners | `hub.ts` | RWMutex for caches (read from HTTP handlers + Box); one dispatch goroutine per lane so tick listeners see batches in order and never concurrently; per-SSE-client write mutex (snapshot write, broadcast, 20 s ping, `kite_error` all write the same `ResponseWriter`) + `Flush()` |
| 9 | `BoxQuoteStore` map + `nextVersion` + listeners | `box/quotes.ts` | single owner goroutine or mutex; listeners invoked synchronously after a batch |
| 10 | Live adapters' session maps (`orders`, `clientByBroker`, `clientByCorrelation`, `modifications`) mutated across awaits | `kiteBrokerAdapter.ts`, `dhanBrokerAdapter.ts` | mutex around map access (not across network calls); in-session idempotency check + insert must be atomic (check-then-set on `client_order_id`) |
| 11 | `KiteClient.accessToken` (set by login, cleared by any 401/403 or WS error) | `kite.ts` | atomic/mutex; `clearSession` from many goroutines |
| 12 | `MarketDataSessionStore` map | `marketDataSession.ts` | mutex; 60 s sweep goroutine |
| 13 | Module globals: `lastParseReport`, `historicalGate`, quotes cache | `dhan/instruments.ts`, `kite.ts`, `marketDataRoutes.ts` | atomic.Pointer / mutex |
| 14 | `getDividendYields` shared `cursor++` across 6 workers | `yahoo.ts:77` | atomic index or job channel |
| 15 | Registry `noteTick()` from both lanes + hub listener | `registry.ts` | atomic int64 |

## 7. Numeric constants (quick index)
| Constant | Value | file:line |
|---|---|---|
| Kite quote chunk | 500 ids/request | `kite.ts:508` (and each /quote method) |
| Kite historical min gap / slot watchdog | 350 ms / 20 000 ms | `kite.ts:99`, `:109` |
| Kite WS reconnect (ZerodhaFeed) | 500 ms × 2^n, max 15 000 ms | `zerodha/feed.ts:32-33,234` |
| Kite price divisor | 100; CDS(seg 3) 1e7; BCD(seg 7) 1e4 | `ticker.ts:229-235` |
| Kite packet thresholds | ≥44 quote (close @40), ≥184 full | `ticker.ts:171,185` |
| Hub `getFreshLadder` default max age | 5000 ms | `hub.ts:261` |
| Dhan HTTP timeout / min interval / read attempts | 8000 [500..60000] / 120 [0..5000] / 3 [1..6] | `dhan/http.ts:59-61` |
| Dhan read backoff | `attempt*300` ms; Retry-After → min(10 000, s*1000) | `dhan/http.ts:220-222` |
| Dhan auth timeout | 10 000 ms | `dhan/auth.ts:154,184` |
| Dhan expiry seconds/ms disambiguation | < 1e11 ⇒ seconds | `dhan/auth.ts:220` |
| Dhan feed subscribe batch | 100 instruments/message | `dhan/feed.ts:46` |
| Dhan feed reconnect | min(30 000, 500 × 2^min(6, n-1)) | `dhan/feed.ts:405` |
| Dhan auth close codes | 1008, 4001, 4401, 4403 | `dhan/feed.ts:490` |
| Dhan packet sizes | header 8, ticker 16, quote 50, OI 12, prev-close 16, full 162, depth level 20 × 5 | `feedDecoder.ts:40-48` |
| Dhan frame loop guard | 10 000 packets | `feedDecoder.ts:135` |
| Dhan internal token | segCode × 1 000 000 000 + securityId | `dhan/instruments.ts:54` |
| Dhan master TTL / fetch timeout | 1 h / 60 000 ms | `dhan/instruments.ts:622,650` |
| Dhan master max expiry horizon | 400 days | `dhan/instruments.ts:187` |
| Dhan master sanity warnings | <50 distinct FUT underlyings, <100 NFO futures | `dhan/instruments.ts:501,508` |
| Dhan REST quote chunk | 1000 ids/segment | `quoteProvider.ts:95`, `registry.ts:1130` |
| Dhan correlation id max | 30 chars | `dhan/correlation.ts:47` |
| Dhan intraday max days | 1→5, 5→30, 15→60, 25→60, 60→90 (default 5) | `history.ts:54-60,285` |
| Instrument provider TTL | 1 h | `instrumentProvider.ts:28` |
| Feed stale threshold | 30 000 ms | `feedHealth.ts:74` |
| Tick-rate window | 10 × 1 s buckets | `marketDataLane.ts:87` |
| SSE keep-alive | `: ping` every 20 000 ms | `marketDataRoutes.ts:246-252` |
| Market-data session TTL / max sessions / max tokens | 5 min / 500 / 4000 | `marketDataSession.ts:36,45,48` |
| Session sweep | 60 000 ms | `index.ts:1614` |
| REST quotes cache TTL / entries / max tokens | 4000 ms / 256 / 4000 | `marketDataRoutes.ts:44,75,42` |
| Dhan margin leg price fallback | 0.05 | `registry.ts:207-213` |
| Pacing profiles | zerodha 110 (floor 100); dhan 120 (floor 120); general default 250 | `brokerPacing.ts:78-95,140` |
| Box live timeouts | HTTP 5000, ACK 3000, working 30 000, partial 10 000, cancel 5000; max mods 2; max chase 2; min interval 250 | `box/config.ts:1028-1038` |
| Box token budget | 2200 | `box/config.ts:1127` |
| `assertBoundedLimit` | limit ≤ 10 000 000; tick align 1e-7; tol max(1e-8, tick/1e4) | `brokerAdapter.ts:248-257` |
| Box ladder depth kept | 5 levels | `box/quotes.ts:220` |
| Yahoo timeout / concurrency / window | 6000 ms / 6 / 365 days; cache 24 h | `yahoo.ts:37,77,58`, `index.ts:1047` |

## 8. Riskiest parts to port
1. **Binary feed decoders.** Kite: big-endian, token MUST be `uint32`, packet count/len are signed int16, thresholds `>=44`/`>=184`, divisor by `token & 0xff`. Dhan: little-endian, float32 rupees widened exactly (no rounding), per-type minimum lengths that skip-but-advance, stop-frame on `len<=0`/truncation, OI vs QUOTE offset shift (OHLC at +34 vs +46), interleaved depth layout. Build byte-level golden fixtures from the TS decoders before porting.
2. **Order-submission ambiguity.** Writes are single-shot; ambiguous outcomes must reconcile (Kite: unique tag in `GET /orders`; Dhan: `GET /orders/external/{corr}`), never re-POST. DhanHttp `read()` retries POSTs that are reads (margin/quote/charts) — must not leak into `write()`. Kite treats a missing token at submit as ambiguous.
3. **Pacing semantics.** Three serial chains with different fairness (Kite historical priority gate, DhanHttp FIFO, TransportPacer FIFO + absolute floor) stacked on the Dhan order path. Go's unfair mutex will change timing and ordering.
4. **Broker switch ordering + durable generation.** Tear-down before `active` moves; `(active, gen)` adopted together after the DB `$inc`; sessions/reservations/books dropped. Concurrent switches/logins are unguarded in Node.
5. **Bit-exact derived ids**: `dhanCorrelationId` (96-bit FNV variant, base36) and `stableKiteTag` (FNV-1a, base36 upper) are persisted in intents and used for reconciliation — any drift orphans live orders. Golden-test thousands of ids against Node.
6. **JS-specific parsing**: `Date.parse` on zone-less `"YYYY-MM-DD HH:MM:SS"` = server-local time (Dhan order/trade times, Kite order timestamps, `normalizeDhanExpiry` fallback, `parseExpiry`); `Number("")===0`; `Math.round` half-up; regex lookbehind in `stripContractSuffix` (RE2 has none); `localeCompare` sorting; `Object.entries` ordering (integer-like keys ascending, e.g. Dhan `data.NSE_FNO["<secId>"]`; other keys in response order — Go maps randomize, so sort/ordered-decode where output order is observable).
7. **Tick JSON shape on SSE/REST**: optional fields present/absent exactly (`bids`/`asks`/`depth_updated`/`exchange_ts`), field order, float formatting (`encoding/json` matches JS for normal magnitudes; differs for ≥1e21 exponent form).
8. **Hub fan-out**: unfiltered broadcast to all SSE clients, synchronous listener-before-SSE ordering, no backpressure — a direct Go port with blocking writes lets one slow client stall the tick path; a bounded per-client queue is safer but is a behaviour change to document.
9. **Instrument master parsing** (Dhan header aliases, two-pass underlying resolution, test-scrip and 400-day filters) — the board's content depends on it; diff Go vs Node on a recorded master CSV.

## 9. Ambiguities and inherited quirks (decide: port as-is or fix, and record the decision)
1. **No Yahoo index-spot fallback exists.** `yahoo.ts` only computes dividend yields (`GET /api/dividends`). Index spot comes solely from the active broker's `INDICES` instruments via `resolveIndexSpotSymbol`.
2. **Zerodha futures lane never auto-reconnects**: it uses `TickerHub`'s own socket (no backoff), despite the `ZerodhaFeed` header claiming both lanes reconnect. It reopens only when something subscribes/retains again.
3. **Any Kite WS `error` event logs the operator out** (hub `fail` → `kite.clearSession()` + delete persisted session + Box books dropped), including plain network failures — the WebSocket API cannot distinguish a 403 handshake from a network error.
4. **Box charge calculator chosen once at module registration** (`index.ts:5289`), before `brokerManager.restore()` runs (`index.ts:5457`), so a process restarted with Dhan active likely prices Box trades with `LocalChargeCalculator` (Zerodha card). Same for `margins: brokerManager.margins()` whose `broker` provenance field is frozen at registration (`index.ts:5255,5319`) while `basketMargin` routes live.
5. **Dhan REST 401s never mark the session lost** — only feed close codes 1008/4001/4401/4403 do; REST auth errors just propagate.
6. **Box-lane Dhan feed is not recycled/stopped** by `completeDhanLogin`, `logoutDhan` or `onDhanSessionLost` (only the futures `dhanFeed` is).
7. **Dhan positions/orphans use the RAW `securityId` as `token`** (`normalizePosition`, `orphanOrder`), not the internal segment-folded token, so they will not match instrument tokens for non-IDX segments (comment claims otherwise).
8. **`dhanInstrumentClass` classifies index options/futures as OPTSTK/FUTSTK** (checks the derivative's own segment, which is never INDICES/IDX_I).
9. **Dhan daily candles carry a full IST timestamp in `date`** (`"YYYY-MM-DD HH:MM:SS"` from `istStamp`), unlike Kite's 10-char dates from `getHistoricalOi/Full`.
10. **Dhan subscribe always uses RequestCode 21** (5-level FULL) regardless of `depthLevel`; codes 15/17 unused.
11. **Kite index packets (28/32 bytes) yield `close_price = 0`** from the feed (close at +20 is not read).
12. **Registry `unsubscribeTokens` bypasses refcounts**; `subscribeTokens` leases are never released (folded into the next `setOwnerTokens("strategy")`).
13. **`setOwnerTokens` decrements once per token even if the owner held it through two leases** (refcount can strand).
14. **Dhan `listOrders` correlation lookup**: an empty-string `correlationId` short-circuits the `??` fallback to `clientByBroker`.
15. **Dhan modify** counts the modification before the PUT and never updates `quantity`; Kite counts after success and does.
16. **Dhan protective cancel returns RECONCILIATION_REQUIRED; Kite throws `BrokerAmbiguousSubmitError`** for the same condition; Dhan `waitForResolution` can return a non-terminal order when `refresh` yields undefined.
17. **Static-IP gate also blocks Dhan cancels** (`ensureTradingReady` on `cancelOrder`), i.e. a protective cancel is refused if the IP verdict flips.
18. Server time zone for production is not configured anywhere in the repo (`deploy.sh`, `docs/CONFIGURATION.md` — not found); all "server-local" parses above depend on it.
19. `src/brokers/routes.ts` (broker HTTP routes: login/switch/status) was not in this file list; its contracts belong in the routes inventory.
