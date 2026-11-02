# Inventory: HTTP + SSE API surface (Node reference → Go port)

Task `2026-10-27-go-postgres-migration`, phase 0. Read-only inventory of `src/` at backend HEAD `1ea1d95`
(frontend `../Cal_Spread` HEAD `4600d90`). Every `file:line` is 1-based and points at the handler registration
unless stated otherwise. Where a deep shape is only summarised, the cited TypeScript type is the source of truth.

Sources read: `src/index.ts` (all route/middleware/startup/shutdown regions; the capture/backfill region
3427–5185 contains no request handling, checked by grep), `src/marketDataRoutes.ts`, `src/marketDataSession.ts`,
`src/hub.ts`, `src/brokers/routes.ts` (+ registry/types/feedHealth/subscriptions/quoteProvider/auth helpers),
`src/box/routes.ts` (+ engine/serialize/repository/positionMonitor/liveModeTransition via a sub-agent, spot-checked),
`src/synthetic/routes.ts` + `engine.ts`/`math.ts`/`config.ts`/`repository.ts`, `src/fairValue/routes.ts`
(+ engine/config/types/store via a sub-agent), `src/ratelimit.ts`, `src/tokenRouteAuth.ts`, `src/adminToken.ts`,
`docs/MIGRATION_CONTRACT.md`, `docs/CONFIGURATION.md`. Frontend: `src/api.ts`, `src/tickStream.ts`, `src/App.tsx`,
`src/Box.tsx`, `src/Synthetic.tsx`, `src/fairValue/api.ts`, `src/FairValue.tsx`, `src/BrokerPanel.tsx` (sub-agent).

Runtime: Express **5.2.1**, body-parser **2.3.0** (from `package-lock.json`; `node_modules` is not installed, so
library defaults below are from the library versions, not observed locally). ESM, Node 22.

## Route count

| Area | Routes | Registered in |
|---|---:|---|
| Health / runtime status | 2 | index.ts |
| Admin auth / session | 3 | index.ts |
| Kite login, session and token | 8 (9 paths: `/login` + `/api/login`) | index.ts |
| Risk-free rate | 3 | index.ts |
| Market data: quotes + tick stream + feed status | 7 | marketDataRoutes.ts |
| Instruments / board | 6 | index.ts |
| Analytics / charts / history | 12 | index.ts |
| Calendar trades | 4 | index.ts |
| Broker selection + Dhan | 12 | brokers/routes.ts |
| Box | 28 (3 from a loop) | box/routes.ts |
| Synthetic | 12 | synthetic/routes.ts |
| Fair Value | 13 (+ router-wide guard) | fairValue/routes.ts |
| **Total** | **110 registrations / 111 method+path pairs** | |

SSE endpoints: 5 (`/api/stream/session/:id`, `/api/stream`, `/api/box/stream`, `/api/synthetic/stream`,
`/api/fair-value/stream`). No WebSocket server.

---

## 0. Cross-cutting contract

### 0.1 Credentials and auth checks

| Mechanism | How it works | Failure |
|---|---|---|
| **Admin session token** | Opaque bearer string, `randomBytes(32).toString("base64url")` (adminToken.ts:145). Minted by `POST /api/admin/verify` (role `full`) or `POST /api/access/verify` (role `trade`). Stored in an in-memory `Map<token,{expiry,role}>` (index.ts:248) and upserted to Mongo `admin_sessions` `{_id: token, role, expiry: epoch-ms}` (db.ts:784). TTL 24 h (`ADMIN_SESSION_TTL_MS=86400000`, index.ts:249), fixed from mint (no sliding refresh). Restored from Mongo at boot (`expiry > now`, index.ts startup chain). | — |
| `getAdminRole(token)` (index.ts:256) | Exact map lookup. Missing token → `null`. Unknown or `Date.now() > expiry` → deletes from map **and** fire-and-forget `admin_sessions.deleteOne` → `null`. Otherwise the role. Header read as `req.headers["x-admin-token"]`; a repeated header would be a joined string and fail lookup. | — |
| `requireAdmin` (index.ts:279) | Header `x-admin-token` only; any non-null role. | **403** `{"error":"Admin authentication required"}` |
| `requireFullAdmin` (index.ts:289) | Header `x-admin-token` only; role must be `full`. | **403** `{"error":"Full admin access required."}` |
| Box/Synthetic `requireFull` (box/routes.ts:57, synthetic/routes.ts:38) | Runs *after* `requireAdmin` inside specific handlers; `req.header("x-admin-token")` role must be `full`. | **403** `{"error":"Full administrator access required."}` (note different text) |
| Query-token routes | `?x-admin-token=<token>` accepted (EventSource/navigation cannot send headers) on: `/login`+`/api/login` (query preferred, `query || header`), `/api/box/stream`, `/api/synthetic/stream` (header preferred, `header ?? query`), `/api/fair-value/stream` (header preferred). Nowhere else. | per route |
| **Passcode** (`checkTokenPasscode`, tokenRouteAuth.ts:76) | Secret from env, `.trim()`; empty → `not_configured` (fail closed). Provided value: header first, else query; repeated header → first element (tokenRouteAuth.ts:94). Missing/empty → `forbidden`. Compare `sha256(secret)` vs `sha256(provided)` with `timingSafeEqual`. Used by: `TOKEN_ROUTE_SECRET` (header `x-token-passcode` / `?passcode=`) for `/api/kite/token`, `/api/dhan/token`, `GET /api/rf`; `INTERNAL_TOKEN_SECRET` (header `x-internal-secret` / `?secret=`) for `/api/internal/kite-token`; `ADMIN_SECRET` / `ACCESS_SECRET` (body `secret`, string only) for the two verify routes. Note: `/api/dhan/token` reads `process.env.TOKEN_ROUTE_SECRET` per request; the others capture env at module load. | per route |
| Market-data session id | 128-bit hex id from `POST /api/stream/session`; the id is the only credential for `GET /api/stream/session/:id`. | 404/409 |
| Cookies | **None.** No cookie is read or set anywhere; CORS sends `Allow-Credentials: true` but the frontend never sends credentials. | — |

Status-code convention: missing/insufficient **admin** auth → **403** (never 401). **401** means "the active
broker has no usable market-data session" (`requireMarketData`, quotes, stream). Passcode wrong → 403; passcode
env unset → 503 (verify routes: 500).

### 0.2 Broker readiness guard

`requireMarketData(res, what)` (index.ts:173): if `brokerManager.activeHealth().data_ready` is false →
**401** `{"error":"<what> requires a <Zerodha|Dhan> session. Connect <Zerodha|Dhan>.", "broker": "zerodha"|"dhan", "problems": string[]}`.
`data_ready` = Zerodha: Kite access token present (registry.ts:1036-1052); Dhan: token present and unexpired AND
`DHAN_DATA_ENABLED` not false (registry.ts:1054-1068). `problems` examples: `"Zerodha is not connected"`,
`"Dhan is not connected"`, `"Dhan session expired — reconnect Dhan"`, `"Dhan data API is disabled (DHAN_DATA_ENABLED=false)"`.

Token namespace guard: `brokerManager.assertActiveBrokerToken(t)` (registry.ts:360) returns true when the
active instrument universe is not loaded yet (`ownsToken` null) — it only rejects once a universe is loaded.

### 0.3 Error mappers

| Mapper | Used by | Behaviour |
|---|---|---|
| `sendError` (index.ts:3347) | index.ts routes, market-data quotes | `KiteError` → `res.status(err.status)` `{error: message}`; if status 401/403 also **clears the Kite session** (memory + `kite_session`). Other Error → **500** `{error: message}`; non-Error → 500 `{"error":"Unknown error"}`. Note `KiteError.status` can be **200** when Kite answers HTTP 200 with `status != "success"`, producing a 200 with an `error` body (kite.ts:426-431, 489-497). |
| broker `fail` (brokers/routes.ts:77) | /api/broker/*, /api/dhan/* | `DhanError` → `status >= 400 ? status : 502` `{error}`; other → 500 `{error: message|"Unexpected server error."}` |
| box `fail` (box/routes.ts:32) | /api/box/* | `KiteError` → `status || 502`; other → 500 `{error: message|"Unexpected server error."}` |
| synthetic `fail` (synthetic/routes.ts:20) | /api/synthetic/* | always 500 `{error: message|"Unexpected server error."}` |
| fair-value `fail` (fairValue/routes.ts:35) | /api/fair-value/* | `res.status(status default 400)` `{error: message|"Fair Value analytics unavailable."}` |
| Express default handler | anything thrown outside a try, body-parser errors, unknown routes | **HTML**, not JSON (no custom error handler is registered). Unknown route → 404 `Cannot <METHOD> <path>` HTML. Malformed JSON → 400; body > 100 kB → 413. Async rejections are forwarded by Express 5. |

### 0.4 Rate limiting (`rateLimit`, ratelimit.ts:13)

In-memory **fixed window** per limiter instance, keyed by client IP = first comma-separated entry of
`X-Forwarded-For` (trimmed) else `req.socket.remoteAddress` else `"unknown"`. Bucket `{count, resetAt}` created on
first hit (`resetAt = now + windowMs`); `count++` then if `count > max` → **429**, header
`Retry-After: ceil((resetAt-now)/1000)`, body `{"error": message ?? "Too many requests. Please slow down."}`.
Stale buckets swept every `windowMs` (unref'd interval). Rejected requests still increment the count.
`trust proxy` is not set and XFF is trusted unconditionally (spoofable when not behind nginx).

| Limiter | Window / max | Message | Applies to |
|---|---|---|---|
| global | 60 s / 150 | default | `app.use("/api", …)` (index.ts:1083): every `/api` and `/api/*` request incl. SSE connects and unknown `/api` paths. Not `/`, `/login`, `/callback`. OPTIONS is answered by CORS before it (not counted). |
| token routes | 60 s / 30 | default | `/api/internal/kite-token`, `/api/kite/token`, `GET /api/rf` (index.ts — three separate instances) |
| token route (Dhan) | 60 s / 30 | `Too many token requests. Slow down.` | `/api/dhan/token` |
| verify | 5 min / 10 | `Too many attempts. Try again in a few minutes.` | `/api/admin/verify`, `/api/access/verify` (separate instances) |
| Dhan auth | 5 min / 20 | `Too many Dhan authentication attempts. Please wait a few minutes.` | `/api/dhan/login`, `/api/dhan/session` (one shared instance) |
| broker switch | 60 s / 10 | `Too many broker switch attempts. Slow down.` | `POST /api/broker/select` |
| Box delete | 60 s / 20 | `Too many delete requests. Slow down.` | `DELETE /api/box/trades/:id` |
| Synthetic delete | 60 s / 20 | same text | `DELETE /api/synthetic/trades/:id` (own instance) |
| Fair Value work | 60 s / 30 | `Fair Value analytics request budget exceeded.` | PATCH /config, POST /refresh, /calculate, /independent (one shared instance, fairValue/routes.ts:34) |

Order on a route = global limiter → per-route limiter → auth (e.g. `/api/broker/select`: switch limiter runs
before `requireFullAdmin`, so unauthenticated attempts consume the bucket).

### 0.5 Serialisation and parsing details the port must copy

- `res.json` uses `JSON.stringify`: `Date` → ISO-8601 `…Z`, Mongo `ObjectId` → 24-hex string, `undefined` fields
  omitted, `NaN/Infinity` → `null`. Raw lean Mongo docs (e.g. `/api/spread-stats`, Box events/attempts) therefore
  carry `_id` (hex) and `__v`.
- Query parser: Express 5 "simple" (node `querystring`): repeated keys become arrays; handlers that do
  `String(req.query.x)` turn arrays into comma-joined strings (e.g. `?tokens=1&tokens=2` works as `1,2`).
- `req.body` is `undefined` when no JSON body was parsed (Express 5). Most handlers use `req.body ?? {}` or
  `req.body?.x`; exceptions noted per route.
- `express.json()` defaults: `limit 100kb`, `strict` (top-level object/array only), `type application/json`.
- ETag disabled (`app.set("etag", false)`, index.ts:1055) so no 304s. `X-Powered-By: Express` is left on.
- IST helpers: `istDayKey(t)` = UTC ISO date of `t + 5h30m` (index.ts:1699). `isMarketOpen()` = Mon–Fri
  09:15–15:40 IST inclusive, no holiday calendar (index.ts:1711).

---

## 1. Middleware order and server configuration

| # | Item | Source | Detail |
|---|---|---|---|
| 1 | `app.set("etag", false)` | index.ts:1055 | |
| 2 | CORS + no-store | index.ts:1058 | On **every** response: `Access-Control-Allow-Origin: $FRONTEND_URL` (default `http://localhost:5173`, single origin, not reflected), `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS` (**no PATCH/PUT**), `Access-Control-Allow-Headers: Content-Type, x-admin-token`, `Access-Control-Allow-Credentials: true`, `Cache-Control: no-store`. `OPTIONS` (any path) → `204` immediately. No `Vary`, no `Max-Age`, no exposed headers. |
| 3 | `express.json()` | index.ts:1077 | defaults above |
| 4 | global `/api` rate limit | index.ts:1083 | 150/min/IP |
| 5 | index.ts routes | 1086–3189 | registration order as in §2 |
| 6 | Box module routes | index.ts:5237 → box/index.ts:166 → box/routes.ts | |
| 7 | Synthetic module routes | index.ts:5307 → synthetic/index.ts:31 | |
| 8 | Fair Value router at `/api/fair-value` | index.ts:5340 → fairValue/index.ts:18 → fairValue/routes.ts:123 | router-level guard first (see §2.12) |
| 9 | Market-data routes | index.ts:5415 | |
| 10 | Broker routes | index.ts:5431 | |
| — | compression | — | **none** |
| — | static files | — | **none** (frontend is a separate deploy) |
| — | error handler / 404 | — | **none** (Express default HTML) |
| — | trust proxy | — | **not set** |

Route paths do not overlap between modules, so registration order only matters for the middleware above.

Listen: `app.listen(PORT)` (index.ts:5441), `PORT = Number(process.env.PORT ?? 3001)`, all interfaces, plain HTTP,
Node default server timeouts. The server accepts requests **before** the async init chain finishes (Mongo connect,
Kite session restore, broker restore, admin-session restore, rf restore, schedulers, Redis warm load, Box /
Synthetic / Fair Value boot) — early requests can see 403 (admin sessions not yet restored), `rf: null`, or
broker not ready. See §5.

---

## 2. Routes by feature area

Column legend: **Auth** (`—` none, `admin` = requireAdmin, `full` = requireFullAdmin, `full*` = requireAdmin then
in-handler requireFull, `pass` = passcode), **RL** = per-route limiter beyond the global one.

### 2.1 Health / runtime status

| Method & path | Auth | Response 200 | Errors | Side effects | Source |
|---|---|---|---|---|---|
| `GET /` | — | `{"status":"ok","authenticated": kite.hasSession(), "hint":"Visit /api/login to authenticate with Zerodha."}` | — | none; not rate-limited | index.ts:1086 |
| `GET /api/status` | — | `{status:"ok", authenticated: health.authenticated && health.data_ready, broker:"zerodha"\|"dhan", broker_authenticated: bool, market_data_ready: bool, feed_connected: bool, feed_state: "DOWN"\|"CONNECTING"\|"CONNECTED_NO_SUBSCRIPTIONS"\|"LIVE"\|"STALE", trading_ready: bool, problems: string[], generation: int, zerodha_session: bool}` (key order as listed) | — | reads broker manager only | index.ts:1107 |

`feed_state`/`feed_connected` come from `brokerManager.feedHealth()` (registry.ts:1487, brokers/feedHealth.ts:38).

### 2.2 Admin auth / session

| Method & path | Auth / RL | Input | Response 200 | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `POST /api/admin/verify` | — / 10 per 5 min | body `{secret: string, broker?: "zerodha"\|"dhan"}`; `broker` parsed with trim+lowercase; `undefined`/`null`/`""` = not requested; non-string `secret` treated as missing. `req.body ?? {}` (missing body OK) | `{success:true, token, role:"full", broker, [broker_switch_refused:true, broker_switch_blockers:[{reason,detail}]], expiresIn: 86400000}` — the two `broker_switch_*` keys only when a requested switch was refused | 500 `{"error":"Admin secret not configured on server"}` (ADMIN_SECRET blank); 401 `{"error":"Invalid admin secret"}`; 400 `{"error":"broker must be \"zerodha\" or \"dhan\"."}` (checked after the secret) | mints token, memory map + `admin_sessions` upsert (fire-and-forget); if `broker` given and different: **performs a full broker switch** (`switchBroker(parsed,"full")`, tears down feeds, drops market-data sessions, etc.) before minting; a refused switch does not deny login | index.ts:1267 |
| `POST /api/access/verify` | — / 10 per 5 min | body `{secret: string}` — destructured from `req.body` **without** a fallback: a request without a JSON body throws TypeError → Express default **500 HTML** | `{success:true, token, role:"trade", broker: <active>, expiresIn: 86400000}` | 500 `{"error":"Access secret not configured on server"}`; 401 `{"error":"Invalid access code"}` | mints `trade` token (memory + `admin_sessions`) | index.ts:1342 |
| `GET /api/admin/status` | — (reads header `x-admin-token` if present) | — | `{authenticated: role!==null, role: "full"\|"trade"\|null, broker}` | — | expired token is purged as a side effect of the lookup | index.ts:1386 |

There is **no server-side admin logout**; the frontend only drops its localStorage token.

### 2.3 Kite (Zerodha) login, session and token

| Method & path | Auth / RL | Input | Response | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `GET /login`, `GET /api/login` | full via `?x-admin-token=` (preferred) or header | — | **302** `Location: https://kite.zerodha.com/connect/login?api_key=<KITE_API_KEY>&v=3` (kite.ts:391) | 403 `{"error":"Full admin access required."}` (JSON) | `/login` not rate-limited; `/api/login` is | index.ts:1399 |
| `POST /api/session` | full | body `{request_token: string}` (`String(req.body?.request_token ?? "")`) | `{authenticated:true, user_id, user_name}` | 400 `{"error":"Missing request_token."}`; Kite failure → `KiteError.status` (Kite HTTP status, or 500) `{error: Kite message \| "Failed to generate session (HTTP n)."}`; non-Kite error → 500 `{error}`. Deliberately does **not** use sendError (a duplicate request_token must not clear a valid session) | Kite `POST https://api.kite.trade/session/token` (form: api_key, request_token, checksum=sha256(api_key+request_token+api_secret)); sets Kite token in memory; upserts `kite_session` `{access_token,user_id,user_name,login_date: istDayKey()}`; triggers post-login backfills (hourly, EOD, option/futures OI capture + backfill, prev-close, Redis flush) | index.ts:1413 |
| `GET /callback` | — | query `request_token`, `status` | **302** to `${FRONTEND_URL}/?auth=success` on success, `${FRONTEND_URL}/?auth=failed` if `status!=="success"`, token missing, or exchange fails | — | same as `/api/session` on success; not rate-limited | index.ts:1440 |
| `POST /api/logout` | full | — | `{authenticated:false}` | — | clears Kite token in memory; `kite_session` cleared (fire-and-forget). Does not touch admin sessions or Dhan | index.ts:1463 |
| `GET /api/kite/access-token` | full | — | `{api_key, access_token, login_date: istDayKey() /* today, not actual login day */}` | 409 `{"error":"No active Zerodha session. Connect to Zerodha first."}` | — | index.ts:1475 |
| `GET /api/kite/token` | pass `TOKEN_ROUTE_SECRET` (`x-token-passcode` or `?passcode=`) / 30 per min | — | `{authenticated:true, api_key, access_token, login_date: istDayKey()}` | 503 `{"error":"Token route is not configured. Set TOKEN_ROUTE_SECRET on the server."}`; 403 `{"error":"Invalid or missing passcode."}`; 409 `{"authenticated":false,"error":"No active Zerodha session. The admin must connect to Zerodha first."}` | — | index.ts:1168 |
| `GET /api/internal/kite-token` | pass `INTERNAL_TOKEN_SECRET` (`x-internal-secret` or `?secret=`) / 30 per min | — | `{api_key, access_token: string\|null, authenticated: bool}` — **200 even with no session** | 503 `{"error":"Internal token sharing is not configured."}`; 403 `{"error":"Forbidden."}` | — | index.ts:1131 |
| `GET /api/profile` | — | — | Kite `GET /user/profile` `data` object passed through verbatim | sendError (Kite status; 401/403 also clears the Kite session) | always calls **Kite**, even when Dhan is active | index.ts:1491 |

### 2.4 Risk-free rate

| Method & path | Auth / RL | Input | Response | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `POST /api/rf` | full | body `{rf}` coerced with `Number(req.body?.rf)` — numeric strings accepted, `null`→0 accepted, `true`→1 | `{rf: number}` | 400 `{"error":"Provide a numeric rf (percent)."}` (non-finite) | memory `adminRfRate`; `app_settings` upsert `{_id:"rf_rate", value, updated_at}` fire-and-forget; Synthetic engine reads it live (`rf_source:"admin"`) | index.ts:1208 |
| `GET /api/rf/current` | — | — | `{rf: number\|null}` | — | — | index.ts:1224 |
| `GET /api/rf` | pass `TOKEN_ROUTE_SECRET` / 30 per min | — | `{rf: number}` | 503 / 403 same texts as `/api/kite/token`; 409 `{"error":"No risk-free rate set yet. The admin must enter it in the panel first."}` | — | index.ts:1235 |

### 2.5 Market data: quotes, tick stream, feed status (marketDataRoutes.ts)

Validation helper `parseTokenList(input, limit)` (marketDataSession.ts): input must be an array (else
`Provide a JSON body of the form { "tokens": [123, 456] }.`), non-empty (`` `tokens` must contain at least one instrument token. ``),
length ≤ limit (`Too many tokens: <n> requested, limit is <limit>.`), every element a JSON **number**, finite,
integer, > 0 (`` `tokens` must contain positive integers only. `` — numeric strings rejected). Deduplicated, order kept.
Limits: quotes 4000, sessions 4000 (`MAX_SESSION_TOKENS`).

Shared refusal bodies:
- not data-ready (quotes): **401** `{"error":"Quotes require a <zerodha|dhan> session.", broker, problems}` (lower-case broker id).
- not data-ready (stream/session): **401** `{"error":"Live prices require a <Zerodha|Dhan> session. Connect <Zerodha|Dhan>.", broker, problems}`.
- foreign tokens: **409** `{"error":"<n> requested token(s) do not belong to the active broker (<broker>). Refetch the board.", broker, generation, stale_tokens: number[] /* first 10 */}`.

| Method & path | Auth | Input | Response 200 | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `POST /api/quotes` | — | body `{tokens: int[]}` (≤4000) | `{ticks: Tick[], broker, cached: bool}` | 400 `{error}` (parseTokenList); 401; 409; sendError on broker failure | cache: `BoundedTtlCache` TTL 4000 ms, max 256 entries, key `<broker>:<generation>:<sorted tokens csv>`; miss → active-broker REST quote (Kite `getQuoteFull` via `EXCHANGE:SYMBOL`, or Dhan `marketFeedQuote` in 1000-id chunks per segment); seeds the hub cache (`tickerHub.seed`) | marketDataRoutes.ts:140 |
| `GET /api/quotes?tokens=a,b,…` | — | `tokens` CSV; each `Number(trim)`; non-finite/non-integer/≤0 entries **silently dropped**; deduped | same as POST | 400 `{"error":"Provide ?tokens=token1,token2,... or POST { tokens: [...] } for large sets."}` (none valid); 400 `{"error":"Too many tokens; POST /api/quotes instead."}` (>4000); then as POST | same | marketDataRoutes.ts:155 |
| `POST /api/stream/session` | — | body `{tokens: int[]}` (≤4000) | `{id: 32-hex, tokens: <unique count>, broker, generation}` | 400 (parse) → 401 → 409, in that order | creates a session in the in-memory store (§3.1) | marketDataRoutes.ts:289 |
| `GET /api/stream/session/:id` | — (id is the capability) | path `id` | **SSE** (§3.1) | 404 `{"error":"Unknown or expired market-data session. Create a new one.", broker, generation}`; 409 `{"error":"This market-data session belongs to a previous broker selection. Refetch the board.", broker, generation}` (session deleted); then the 401/409 of `openTickStream` (JSON, before SSE headers) | browser lease on the subscription coordinator; hub fan-out attach | marketDataRoutes.ts:347 |
| `GET /api/stream?tokens=a,b,…` | — (frontend also sends `x-admin-token` in the query; ignored) | CSV tokens, same lenient parse | **SSE** (§3.1) | 400 `{"error":"Provide ?tokens=token1,token2,... — or POST /api/stream/session for a full board."}`; 401; 409 | same as session stream (no session bookkeeping) | marketDataRoutes.ts:384 |
| `GET /api/market-data/status` | — | — | snapshot (below) | — | — | marketDataRoutes.ts:444 |
| `GET /api/market-data/diagnostics` | full | — | snapshot + `board_size: int\|null` + `diagnosis: string` (one of five "CASE A–D"/"HEALTHY" sentences, marketDataRoutes.ts:470-485) | — | loads the instrument universe (board size) | marketDataRoutes.ts:458 |

`Tick` (ticker.ts:19): `{token, last_price, close_price, oi, bid, ask, bids?: DepthLevel[], asks?: DepthLevel[], depth_updated?: bool, exchange_ts?: epoch-ms}`;
`DepthLevel = {price, qty, orders}`. REST quotes: **Zerodha returns `bid:0, ask:0` and no depth** (quoteProvider.ts kiteQuotes);
Dhan returns top bid/ask and `bids`/`asks` ladders (levels with price > 0).

Market-data snapshot (marketDataRoutes.ts:405-437):
```
{ broker, generation,
  subscriptions: {browser, scanner, strategy, analytics, tokens, leases, lane},   // counts (subscriptions.ts:278)
  sessions: {sessions, connections, tokens},
  feed: {state, connected, subscribed, universe: int|null, feed_age_ms, last_tick_at, detail},
  upstream: {broker, wanted: int|null, subscribed: int|null, socket_connected, last_tick_at},
  lanes: { futures: LaneFeedStats,
           box: LaneFeedStats & {subscriptions: <same shape as subscriptions>} } }
LaneFeedStats = {lane:"futures"|"box", connected, subscribedTokens, wantedTokens, ticksPerSecond (always 0), lastTickAgeMs, reconnects (always 0), generation}
```

### 2.6 Instruments / board

All read the **active broker's** instrument universe via `brokerManager.instrumentProvider.load()` (one cache per
broker, generation-scoped, concurrent loads coalesced; instrumentProvider.ts:59). With Dhan active, rows are
`DhanInstrument` objects and may additionally carry `dhan_security_id`, `dhan_segment`,
`dhan_underlying_security_id` (dhan/instruments.ts:34-40; not stripped by these handlers as far as read).
`Instrument` = `{instrument_token, exchange_token, tradingsymbol, name, last_price, expiry, strike, tick_size, lot_size, instrument_type, segment, exchange}` (kite.ts:27).
Errors: sendError.

| Method & path | Auth | Input | Response 200 | Errors | Source |
|---|---|---|---|---|---|
| `GET /api/instruments` | — | `exchange` (default `"NSE"`; present-but-empty = no filter), `type` (instrument_type, default `"EQ"`; empty = no filter), `q` (trim, lower-case substring of tradingsymbol or name) | `{count, instruments: Instrument[]}` | sendError | index.ts:1505 |
| `GET /api/fno-stocks` | — | `q` | `{count, instruments: (Instrument & {fno_lot_size})[]}` — NSE EQ rows whose symbol is an NFO FUT `name`; lot = first-seen future's lot; sorted by tradingsymbol | sendError | index.ts:1537 |
| `GET /api/fno-stocks/:symbol` | — | `symbol` upper-cased | `{symbol, spot:{instrument_token, tradingsymbol, name}, futures:[{instrument_token, tradingsymbol, expiry, lot_size}] /* ≤3 nearest by expiry string */}` | 404 `{"error":"No NSE equity found for \"<SYM>\"."}` | index.ts:1559 |
| `GET /api/fno-board` | — | `q` (symbol or name substring) | `{count, board: BoardItem[]}`; `BoardItem = {symbol, name, spot_token, futures:[{token, expiry, lot_size}] /* ≤3 nearest */, is_index?: true}`; indices first, then stocks, each alphabetical (deriveFnoBoard, index.ts:3237) | sendError | index.ts:2055 |
| `GET /api/dividends` | — | — | `{yields: {[symbol]: percent}, cachedAt: epoch-ms}` | sendError | Yahoo `v8/finance/chart` per non-index board symbol (yahoo.ts), 24 h in-memory cache, failures → 0 % | index.ts:1627 |
| `GET /api/debug/indices` | — | — | `{totalIndexInstruments, sampleIndexTradingSymbols: string[≤25], resolved:[{underlying, hasFutures, candidates: string[], zerodhaSpotSymbol, resolvedSpotSymbol: string\|null, spotFound}], indexRowsInBoard:[{symbol, name, futures: count}], totalBoardRows}` | sendError | index.ts:1646 |

### 2.7 Analytics / charts / history

| Method & path | Auth | Input | Response 200 | Errors | Cache / side effects | Source |
|---|---|---|---|---|---|---|
| `GET /api/history/:symbol` | — (needs data-ready) | symbol upper | `{symbol, name, is_index: bool, futures:[{token, expiry, points:[{date:"YYYY-MM-DD", oi, close}]}]}` — 3 months of daily candles per board future | 401 (requireMarketData, checked **before** cache); 404 `{"error":"No F&O instrument found for \"<SYM>\"."}`; sendError | per-symbol cache for the IST day (**not keyed by broker**); history provider = active broker (brokers/history.ts) | index.ts:1733 |
| `GET /api/spread-history/:symbol` | — (data-ready) | symbol | `{symbol, name, is_index, dataRange:{from, to}, points:[{date, spread /*round2(next-current close)*/}], stats:{mean, max, min, count}}` — 2 years daily, 200 ms between calls | 401; 404 (same text); sendError | per-symbol IST-day cache | index.ts:1791 |
| `GET /api/intraday/:symbol` | — (data-ready) | symbol | `{symbol, name, is_index, futures:[{token, expiry, points:[{t: <broker timestamp string>, close}]}]}` — 7 days, `60minute` | 401; 404; sendError | IST-day cache | index.ts:1889 |
| `GET /api/minute/:symbol` | — (data-ready) | symbol | same shape — last 2 h, `minute`, from/to as IST `YYYY-MM-DD HH:MM:SS` | 401; 404; sendError | 60 s cache | index.ts:1950 |
| `GET /api/fivemin/:symbol` | — (data-ready) | symbol | same shape — today, `5minute` | 401; 404; sendError | 5 min cache | index.ts:2007 |
| `GET /api/option-chain/:underlying` | — (data-ready, checked after param parse) | `underlying` upper; `expiry` (must be one of the live expiries, else nearest); `band` = `min(80, max(5, Number(band ?? 40)))` — **non-numeric band yields NaN and an empty `strikes` list** | `{underlying, name: spot tradingsymbol, spot_token, spot: number /*0 if quote failed*/, atm_strike, expiry, expiries: string[], lot_size, strikes:[{strike, ce_token, pe_token, ce_symbol, pe_symbol}]}` (rows lacking either leg skipped) | 401; 404 `No options found for "<U>".` / `No live expiries for "<U>".` / `No spot instrument for "<U>".` / `No strikes for expiry <E>.`; sendError | one active-broker REST quote for the spot | index.ts:2088 |
| `GET /api/option-oi-baseline/:underlying` | — | `minutes` (default 5; non-finite → 5; rounded, clamp 1..240). `:underlying` is **ignored** (NIFTY only) | `{day, expiry: string\|null, minutes, oldest: ms\|null, newest: ms\|null, baseT: ms\|null, tokens: {[token]: {oi, ltp, t}}}` — empty `tokens`, `expiry:null`, `baseT:null` when no snapshot ≤ cutoff today | — | reads in-memory chain snapshots (minute, then hourly; today only) | index.ts:2218 |
| `GET /api/option-prev-close/:underlying` | — | ignored param | stored `OptionPrevClose` `{forDay, closedOn, expiry, complete, tokens:{[token]:{oi, ltp}}}`, or `{forDay: today, closedOn:null, expiry:null, complete:false, tokens:{}}` when stale/absent | — | memory | index.ts:2252 |
| `GET /api/option-oi-series/:underlying` | — | ignored param | `{day, expiry: string\|null, points:[{t, totalCe, totalPe, straddle}]}` (today's per-minute NIFTY aggregates over the pinned strike window) | — | memory | index.ts:2272 |
| `GET /api/option-oi-frame/:underlying` | — | `frame` ∈ `1m\|5m\|15m\|1h`, anything else → `5m`; param ignored | `{frame, intervalMin, retentionMs, points: OiAggPoint[]}` with `OiAggPoint = {t, totalCe, totalPe, straddle, spot, wLo?, wHi?, partial?: 1}`; only **completed** buckets (`t <= now`) | — | memory (Redis-mirrored) | index.ts:2334 |
| `GET /api/futures-oi-frame/:underlying` | — | `frame` as above | `{frame, intervalMin, retentionMs, contracts:[{token, tradingsymbol, expiry, lot_size}] /* sorted by expiry; unknown → token 0, "" */, points:[{t, legs:[{expiry, oi, ltp}]}]}` | — | memory | index.ts:2348 |
| `GET /api/spread-stats/:symbol` | — | symbol upper | raw lean `spread_summary` doc: `{_id, symbol, observations, first_date: ISO, last_date: ISO, mean_spread, max_spread, min_spread, mean_deviation, max_abs_spread, std_dev_spread, percentile_95, mean_reversion_probability, __v?}` | 404 `{"error":"No spread summary found for \"<SYM>\"."}`; sendError | Mongo `spread_summary` (NSE_FNO_SPREAD_URI connection) | index.ts:2384 |

Frame cadence/retention (index.ts:363-376): `1m` 1 day, `5m` 3 days, `15m` 7 days, `1h` 7 days.

### 2.8 Calendar trades (Mongo `trades`, ledger `trade_log`)

`serializeTrade` (index.ts:2689) → `Trade` JSON:
`{id, symbol, name, is_index, lot_size, buy:{token, expiry, entry}, sell:{token, expiry, entry}, status:"open"|"closed", opened_at: ISO, closed_at: ISO|null, close_pnl, buy_close, sell_close, margin, entry_charges, exit_charges, est_exit_charges, entry_value, exit_value, total_charges, net_pnl}` (missing optional fields → `null`).
`ITradeCharges = {legs: ILegCharges[], value, brokerage, stt, exchange_txn, sebi, stamp_duty, gst, total, source:"kite"|"kite_estimate", at: ISO}`;
`ILegCharges = {side, tradingsymbol, quantity, price, value, brokerage, stt, stt_type, exchange_txn, sebi, stamp_duty, gst, total}` (db.ts:46-83).

| Method & path | Auth | Input | Response 200 | Errors (in check order) | Side effects | Source |
|---|---|---|---|---|---|---|
| `POST /api/trades` | admin (either role) | body `{symbol}` trimmed, upper | `{trade: Trade}` | 503 `{"error":"Trade persistence is not configured (set MONGODB_URI)."}`; 401 requireMarketData("Taking a trade"); 400 `Trades can only be taken during market hours (Mon–Fri, 9:15–15:40 IST).`; 400 `Provide a symbol.`; 404 `No F&O instrument found for "<SYM>".`; 400 `Need both current and next month futures to place a calendar spread.`; 409 `A trade for <SYM> is already open.`; 502 `Could not fetch live prices for all legs right now. Try again shortly.`; 502 `No live bid/ask on one of the legs right now (illiquid or pre-open). Try again once both legs are quoted.`; sendError | ladders: hub fresh ladder (≤5 s) else **Kite** REST `getQuoteLadder`; buys the lower-premium leg at best ask, sells the other at best bid, qty = current lot; **Kite** basket margin (non-fatal, `Math.round`); **Kite** `/charges/orders` for entry + projected exit (non-fatal); `trades.create`; `trade_log` append (event `entry`) | index.ts:2716 |
| `GET /api/trades` | admin | — | `{dbEnabled: true, trades: Trade[]}` newest `opened_at` first, limit 200; DB disabled → `{dbEnabled:false, trades:[]}` | sendError | — | index.ts:2952 |
| `POST /api/trades/:id/close` | admin | path id (Mongo ObjectId) | `{trade: Trade}` (already-closed trade returned unchanged, 200) | 503 (same text); 400 `Invalid trade id.`; 404 `Trade not found.`; 401 requireMarketData("Closing a trade") (only for open trades); sendError | exit at best bid (long) / best ask (short), falling back to last, then entry; gross P&L = lot × ((curBuy−buy.entry)+(sell.entry−curSell)) rounded 2 dp; Kite charges for exit (fallback to entry-time estimate), legacy entry-charge backfill; `trades.save`; `trade_log` append (event `exit`) | index.ts:2969 |
| `DELETE /api/trades/:id` | admin (either role) | path id | `{success:true, id}` | 503; 400 `Invalid trade id.`; 404 `Trade not found.`; 400 `Only closed trades can be deleted.`; sendError | `trades.deleteOne` (hard delete; ledger rows kept) | index.ts:3189 |

### 2.9 Broker selection + Dhan (brokers/routes.ts)

`manager.snapshot()` (registry.ts:1738) — body of `/api/broker/status`, and merged into select/logout replies:
```
{ broker, session: BrokerSessionState, health: BrokerHealthState,
  dhan_configured: bool, dhan_instruments: int, dhan_instruments_loaded_at: ms|null,
  dhan_static_ip: StaticIpState, last_margin_source: string|null, generation: int,
  feed: FeedHealth, subscriptions: {browser,scanner,strategy,analytics,tokens,leases,lane},
  instruments: int, instruments_loaded_at: ms|null }
BrokerSessionState = {broker, authenticated, client_id, client_name, token_expires_at, token_expired, login_day, login_at}
BrokerHealthState  = {broker, authenticated, token_expires_at, token_expired, data_ready, trading_ready,
                      static_ip_configured: bool|null, feed_connected, feed_age_ms, problems: string[]}
StaticIpState      = {ready, declared, configured_ip: string|null, api_verified: bool|null,
                      primary_ip, secondary_ip, checked_at: ms|null, error: string|null}   (registry.ts:921)
SwitchBlocker      = {reason: "scanner_running"|"open_box_positions"|"working_orders"|"execution_in_flight"|
                      "unresolved_reconciliation"|"residual_exposure"|"unknown_order_state"|
                      "foreign_unresolved_intents"|"broker_not_configured", detail: string}
```

| Method & path | Auth / RL | Input | Response 200 | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `GET /api/broker/status` | admin | — | snapshot | — | — | brokers/routes.ts:98 |
| `GET /api/broker/switch-blockers` | admin | `broker` (invalid/missing → active broker) | `{broker, blockers: SwitchBlocker[]}` | broker fail | reads `box_order_intents` counts | :103 |
| `POST /api/broker/select` | full / switch 10 per min (before auth) | body `{broker}` | `{ok:true, ...snapshot}`; re-selecting the active broker is a no-op success | 400 `{"error":"broker must be \"zerodha\" or \"dhan\"."}`; 409 `{"error":"Cannot change broker while Box exposure or in-flight work exists.", blockers, broker}`; broker fail | switch: stop Box + Synthetic scanners, stop both lanes, drop subscriptions/books, clear reservations, drop **all** market-data sessions, bump `generation`, persist `active_broker`, reload universes, start new feed; then Box SSE `publishNow()` | :118 |
| `POST /api/dhan/login` | full / Dhan auth 20 per 5 min | — | `{ok:true, consent_app_id, login_url}` | DhanError 400 (credentials missing: reason text) or Dhan status; broker fail | Dhan consent REST call (uses app secret) | :156 |
| `POST /api/dhan/session` | full / Dhan auth | body `{tokenId}` (camelCase; trimmed) | `{ok:true, authenticated, broker: <active, unchanged>, client_id, client_name, token_expires_at}` | 400 `{"error":"Missing tokenId."}`; DhanError (status ≥400 else 502) | consumes the single-use tokenId with Dhan; persists `dhan_session`; does **not** switch broker | :172 |
| `GET /api/dhan/status` | admin | — | `{broker:"dhan", active, configured, authenticated, token_expired, token_expires_at, data_ready, trading_ready, static_ip_configured, static_ip: StaticIpState, feed_connected, feed_age_ms, problems, instruments: int, session: RedactedDhanSession\|null}`; `RedactedDhanSession = {client_id, client_name, client_ucc, power_of_attorney, token_expires_at, token_expired, login_date, login_at: ISO\|null}` (dhan/auth.ts:247) | broker fail | may call Dhan to verify the static IP once (cached verdict); reads `dhan_session` | :196 |
| `POST /api/dhan/verify-ip` | full | — | `{ok: verified, verified, configured_ip, primary_ip, secondary_ip, checked_at, error, static_ip: StaticIpState}` | broker fail | Dhan IP REST call | :235 |
| `GET /api/dhan/instruments/diagnostics` | full | — | `{broker:"dhan", active_broker, generation, healthy: bool, instrument_universe_size, parser_report: {...DhanParseReport, header_line, header: string[≤40]}, board: BoardDiagnostics, known_symbols: KnownSymbolCheck[], subscriptions, feed: FeedHealth}` (boardDiagnostics.ts:25-52, dhan/instruments.ts DhanParseReport) | 503 `{"error":"The Dhan instrument master has not been parsed yet.","hint":"Connect Dhan, then retry."}`; broker fail | **forces a Dhan instrument-master download/parse** every call | :254 |
| `POST /api/dhan/logout` | full | — | `{ok:true, ...snapshot}` | broker fail | clears Dhan session (memory + store) | :299 |
| `POST /api/dhan/postback` | — (Dhan webhook) | body; reads `orderId`, `orderStatus`, `correlationId` (strings) | always **200**: `{ok:true}` or `{ok:true, ignored:"no orderId"}` | — | log only; never mutates order state | :319 |
| `GET /api/dhan/access-token` | full | — | `{authenticated:true, client_id, access_token, expires_at}` | 409 `{"error":"No live Dhan session. Connect Dhan first."}` (absent or expired) | reads `dhan_session` | :345 |
| `GET /api/dhan/token` | pass `TOKEN_ROUTE_SECRET` (read per request) / 30 per min | `x-token-passcode` or `?passcode=` | `{authenticated:true, client_id, access_token, expires_at, login_date}` | 503 / 403 (same texts as Kite token route); 409 `{"authenticated":false,"error":"No live Dhan session. The admin must connect Dhan first."}` | reads `dhan_session` | :383 |

### 2.10 Box (box/routes.ts; engine src/box/engine.ts)

All `/api/box/*` except `/stream` use `requireAdmin` (**either role**). `full*` = additionally `requireFull`
(403 `Full administrator access required.`). Errors not listed fall to box `fail` (KiteError status or 500).
Storage: Mongo connection `BOX_MONGODB_URI` else `MONGODB_URI`; `isBoxDbEnabled()` = that connection's
`readyState===1` (db.ts:360). Collections: `box_trades`, `box_trade_events`, `box_order_intents`,
`box_execution_attempts`, `box_daily_pnl`, `box_pnl_deletions`, `box_pnl_day_states`, `box_settings`,
`box_calibration_samples`, `box_trading_session` (box/model.ts). Redis: `box:trades:closed:{day}` (hash, lite rows),
`box:pnl:day:{day}`, `box:pnl:days`.

| Method & path | Auth / RL | Input | Response 200 | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `GET /api/box/status` | admin | — | `engine.getStatus()` (shape A below) | — | — | box/routes.ts:68 |
| `GET /api/box/config` | admin | — | `engine.getConfig()` (shape B) | — | — | :72 |
| `GET /api/box/execution-diagnostics` | admin | — | `engine.getExecutionDiagnostics()` (engine.ts:4407; keys: `profile, paper_calibration, calibration_by_broker, calibration_distributions, calibration_dropped_samples, live_timing, recent_latency_outliers, timing_recorder, calibration_persistence, execution_environment, event_loop_attach_failure, outcomes, rejects, entry_fault_classes, entry_faults_total, recent_entry_faults, queue_calibration, last_implementation_shortfall, parity, coordinator, executionCoordination, shadow_mode`) | fail | — | :85 |
| `POST /api/box/strike-level` | admin | body `{level}`; `Number(level)` finite and `round` ∈ {1,2,3} | `{ok:true, strike_level, status}` | 400 `{"error":"level must be 1, 2 or 3."}` | memory only (not persisted); rebuild windows; refresh; SSE publish | :101 |
| `POST /api/box/settings` | admin | body `{min_expected_net_profit? \| minExpectedNetProfit?, safety_buffer? \| safetyBuffer?}` (snake first). Each: `undefined/null/""` skipped, else `Number()` (strings and `true` accepted), finite, 0..1 000 000, `Math.round` | `{ok:true, config, status}` | 400 `<key> must be a number.` / `` <key> must be between ₹0 and ₹1000000. `` (key printed camelCase) / `Nothing to update — send minExpectedNetProfit and/or safetyBuffer.`; 503 `Could not save the settings: <msg>` (rolled back; DB down msg `Box persistence is not configured, so settings cannot be saved.`) | `box_settings` bulk upsert `{_id:"min_expected_net_profit"\|"safety_buffer", value, updated_at}`; `SCANNER_CONFIG` event; reprice; publish | :125 |
| `POST /api/box/start` | admin | — | `{ok:true, status}` (idempotent) | 400 `{error:"Connect to Zerodha before starting the box scanner." \| "Box persistence is not configured (set MONGODB_URI).", status}` | start discovery, feed, universe timer; `SCANNER_STARTED` event; publish | :151 |
| `POST /api/box/stop` | admin | — | `{ok:true, status}` | — | stop discovery (positions still monitored); `SCANNER_STOPPED` event; publish; SSE clients stay open | :170 |
| `POST /api/box/controls/box_entry_enabled`, `/box_live_order_enabled`, `/box_emergency_flatten` | full* | body `{enabled: boolean}` (strict) | `{ok:true, status}` | 400 `{"error":"enabled must be a boolean."}`; 409 `{"error":"Live controls are unavailable outside explicit live mode.", status}` | in-memory order-manager control flag (not persisted) | :180 (loop) |
| `GET /api/box/execution-control` | admin | — | `engine.getExecutionControl()` (shape C) | fail | — | :205 |
| `POST /api/box/execution-mode/preview` | admin | body `{selection}` ∈ `paper_latency\|paper_legging\|paper_legging_live_parity\|live` | `ModeTransitionVerdict`: `{outcome:"allowed", from, to}` \| `{outcome:"restart_required", from, to, detail, envChanges: string[], blockers}` \| `{outcome:"refused", from, to, blockers:[{code, detail}]}` (liveModeTransition.ts:137-272) | 400 `selection must be one of: paper_latency, paper_legging, paper_legging_live_parity, live.`; fail | read-only | :217 |
| `POST /api/box/execution-mode/paper-profile` | full* | body `{profile}` ∈ `standard\|live_parity\|stress` | `{ok:true, execution: <execution-control>}` | 400 `profile must be one of: standard, live_parity, stress.`; 409 `{error, blockers?}` (live mode text, or `The execution profile cannot be changed while executions or exposure are outstanding.` + blockers) | memory only | :237 |
| `POST /api/box/session/arm` | full* | body `{max_completed_trades?: int 0..10000}` (`null`/absent = configured default; 0 = unlimited; must be a JSON number) | `{ok:true, session, execution}` | 400 `max_completed_trades must be an integer between 0 and 10000 (0 = unlimited).`; 409 `{error: <reason>, execution}` (reasons: tradingSessionStore.ts:277-307) | `box_trading_session` `_id:"current"` | :269 |
| `POST /api/box/session/disarm` | full* | — | `{ok: bool, session, execution}` — **200 even when `ok:false`** | fail | `box_trading_session` | :299 |
| `POST /api/box/live/reconcile` | full* | — | `{ok:true, reconciliation:{matched, missingAtBroker, orphanOrders, positions, positionMismatches, affectedTradeIds, remainingByTrade}, status}` | 500 `Live order manager is unavailable.` (every paper deployment) | broker REST list orders/positions (live only) | :309 |
| `POST /api/box/live/cancel-working` | full* | — | `{ok:true, orders: BrokerOrder[], status}` | 500 as above | broker cancels for `BOX:` intents | :316 |
| `POST /api/box/live/flatten` | full* | — | `{ok:true, attempted, results: unknown[], status}` | 500 as above, or `box_emergency_flatten is disabled.` / other guard texts | real exit orders (live) | :323 |
| `GET /api/box/opportunities` | admin | `limit` (>0 → `min(300, round)`, else config `maxPublishedOpportunities`) | `{opportunities: BoxOpportunity[] (types.ts:528), status}` | — | — | :332 |
| `GET /api/box/chains` | admin | `underlying` optional | no underlying: `{chains:[{underlying, name, is_index, expiry}]}`; else `{underlying, name, is_index, expiry, lot_size, quantity, atm_strike, strike_step, spot, spot_age_ms, strikes:[{strike, is_atm, ce: Leg\|null, pe: Leg\|null}]}`, `Leg = {token, tradingsymbol, bid, bid_qty, ask, ask_qty, last, age_ms, marks: string[]}` | 404 `` No monitored box window for "<U>". Start the scanner, or pick an underlying from GET /api/box/chains. `` | — | :342 |
| `GET /api/box/trades` | admin | — | `{dbEnabled, open: OpenPosition[], trades: SerializedBoxTrade[]}` (last 300 by `opened_at`, full docs) | fail | `box_trades` | :360 |
| `GET /api/box/trades/open` | admin | — | `{dbEnabled, open}` | — | memory | :374 |
| `GET /api/box/trades/history` | admin | `scope` (`today` case-insensitive, else all); `limit` (all only: >0 → `min(1000, round)`, default 300) | today: `{dbEnabled, scope:"today", source:"memory"\|"redis"\|"mongo"\|"none", day, cacheEnabled, lite:true, trades}`; all: `{dbEnabled, scope:"all", source:"mongo", cacheEnabled, lite:true, trades}` (status closed\|error, audit blobs projected out) | fail | memory → Redis → Mongo tiers | :387 |
| `GET /api/box/execution-attempts` | admin | `limit` default 100, max 500 | `{dbEnabled, attempts: IBoxExecutionAttempt[] (raw lean, types.ts:1266)}` | fail | `box_execution_attempts` | :432 |
| `GET /api/box/events` | admin | `limit` default 200, max 1000 | `{events: IBoxTradeEvent[] (raw lean, types.ts:1694)}` | fail (repo returns [] on error) | `box_trade_events` | :443 |
| `POST /api/box/trades/:id/close` | admin (either role) | path id | `{ok:true, open}` | `result.code` `{error, metrics: BoxExitMetrics\|null}`: 404 `That box position is not open.`; 409 (recovery / already closing / exchange closed / feed unavailable / not executable / partial close …, positionMonitor.ts:1120-1330) | paper: simulated exit; live: real orders; `box_trades` update; SSE `exit` | :460 |
| `DELETE /api/box/trades/:id` | full* / delete 20 per min (before auth) | path id; optional JSON body `{reason}` (trimmed, ≤500) | `{ok:true, deleted_id, status, open, closed_today:{trades, source, day, lite:true}}` | 400 `Invalid trade id.`; 503 `The Box database is not available.`; 404 `No such Box trade.`; 409 live-trade refusals / `This trade is currently being closed…` / `The trade could not be deleted.` | **hard delete** `box_trades` (non-live only) + `box_pnl_deletions` fence + `box_daily_pnl` rows + Redis HDEL/evict; `TRADE_DELETED` event; SSE `trade_deleted` | :489 |
| `GET /api/box/stream` | any admin role via header or `?x-admin-token=` | — | **SSE** (§3.2) | 403 `{"error":"Admin authentication required"}` | — | :535 |

Shape A — `getStatus()` (engine.ts:4798): `running, state:"SCANNING"|"MARKET_CLOSED"|"STOPPED", monitoring, market_open,
indicative_*, execution_mode:"paper_touch"|"paper_latency"|"paper_legging"|"live", broker, brokers_with_open_positions,
authenticated, broker_auth_healthy|null, broker_orders_api_healthy|null, broker_positions_api_healthy|null,
market_data_healthy, database_healthy, daily_risk_seed_healthy|null, reconciliation_complete, unknown_orders,
recovery_active, circuit_state, live_manager|null, db_enabled, started_at, stopped_at, universe_built_at, strike_level,
underlyings, candidates, monitored_tokens, subscribed_option_tokens, subscribed_spot_tokens, hub_subscribed,
hub_connected, quotes, quote_updates, feed_age_ms, raw_tick_age_ms, book_observation_age_ms, executable_books,
executable_book_diagnostics, feed_healthy, exchange_lag_ms, open_positions, degraded, pending_unpersisted_fills,
owned_unpersisted, residual_exposure_count, residual_exposure_legs, residual_flatten_in_flight, risk_bookkeeping,
partially_exited_positions, day_pnl{day, open_count, open_running_net_pnl, open_running_gross_pnl, closed_count,
closed_realised_net_pnl, closed_realised_gross_pnl, total_net_pnl, total_gross_pnl, open_margin_used,
closed_margin_used, total_margin_used, cumulative_trade_margin, peak_concurrent_margin, margin_unknown_count,
cache_enabled, last_cached_at}, skipped_for_budget, skipped_symbols, skipped_indicative_cap,
skipped_indicative_symbols, indicative_max_underlyings, scanner{…}, monitor{…}, charges{…}, reconciliation{…},
metrics{…}, last_error, config: <shape B>`.

Shape B — `getConfig()` (engine.ts:4330): snake_case view: `min_expected_net_profit, min_gross_edge, min_net_edge,
execution_mode, simulated_decision_ms, simulated_latency_ms, expected_entry_slippage, expected_exit_slippage,
enable_short_box, directions, min_captured_pct, reconcile_charges, charge_reconcile_warn_pct, require_priced_charges,
safety_buffer, quote_max_age_ms, feed_max_age_ms, underlying_max_age_ms, strikes_each_side, strike_level, max_strikes,
max_candidates_per_underlying, prefilter_gross_threshold, convergence_floor, convergence_pct, min_exit_net_pnl,
profit_capture_pct, expiry_safety_minutes, max_subscribed_tokens, lots:1, universe:"NSE F&O options only — F&O stocks + supported indices",
indicative_discovery, closed_cache_enabled, tunable:{min_expected_net_profit:{min:0,max:1000000}, safety_buffer:{min:0,max:1000000}}`.

Shape C — `getExecutionControl()` (engine.ts:4556): `execution_mode, paper_execution_profile, broker,
deployment_live_capable, live_capability_detail, live_runtime_armed, entry_enabled, emergency_flatten_enabled,
mode{selection, label, runtime_selectable[], live_requires_restart:true, transition_blockers[]}, session{state,
session_id, armed, armed_at, armed_by, max_completed_trades, completed_trades, consumed_cycles, remaining_trades,
current_trade_id, in_flight_trade_ids, aborted_attempts, arm_count, block_reason, readable, enforcing, write_failed},
risk{…}, execution{…}, arm{preconditions{…camelCase}, entry, exposure_management, emergency_flatten}, block_reason, block_detail`.

`SerializedBoxTrade` (box/serialize.ts:18-98) and `OpenPosition` (engine.ts:5381-5464): see those files; open
positions carry `opened_at` ISO, `entry_legs[4]`, `exit_legs[]`, current exit arithmetic and the exit verdict.

### 2.11 Synthetic futures scanner — paper only (synthetic/routes.ts; engine src/synthetic/engine.ts)

All except `/stream` use `requireAdmin` (either role). Store: Mongo (Box connection) `synth_trades`
(statuses open/closed/deleted; partial unique index one open per underlying) and `synth_settings`
`{_id: key, value, updated_at}`. No Redis.

| Method & path | Auth / RL | Input | Response 200 | Errors | Side effects | Source |
|---|---|---|---|---|---|---|
| `GET /api/synthetic/status` | admin | — | `getStatus()` (shape S below) | — | — | synthetic/routes.ts:47 |
| `POST /api/synthetic/start` | admin | — | `{ok:true, status}` (idempotent) | 400 `{error:"No broker session: connect the active broker first." \| "A broker switch is in progress. Try again in a moment.", status}`; 500 | universe refresh (errors → `last_error`), subscriptions on the Box lane (`scanner` owner), publish | :51 |
| `POST /api/synthetic/stop` | admin | — | `{ok:true, status}` | — | release window tokens; publish; streams stay open | :64 |
| `POST /api/synthetic/strike-level` | admin | body `{level}`; `Number(level)` must be exactly 1, 2 or 3 (`"2"`, `true`→1, `[3]` accepted; 1.5 rejected) | `{ok:true, strike_level, status}` | 400 `{"error":"level must be 1, 2 or 3"}` (no trailing dot) | memory only; **no SSE publish** | :70 |
| `POST /api/synthetic/settings` | admin | body: only snake_case `min_expected_net_profit` (0..100000), `safety_buffer` (0..50000), `max_open_positions` (integer 0..10000, 0 = no limit); numeric non-blank strings accepted; `null`/bool/`""` rejected; unknown keys ignored; first invalid key aborts | `{ok:true, persisted: bool, status}` | 400 `<key> must be a number from <min> to <max>` / `max_open_positions must be a whole number from 0 to 10000 (0 = no limit)` / `max_open_positions must be a whole number (0 = no limit)` / `Nothing to change: send any of min_expected_net_profit, safety_buffer, max_open_positions.`; 503 `Could not save the settings: <msg>` (rolled back); 500 | `synth_settings` bulkWrite upsert of all three keys (when store enabled; else memory + `persisted:false`); evaluate; publish | :84 |
| `GET /api/synthetic/opportunities` | admin | `limit` (`Number`; finite >0 → `slice(0, limit)` of the full sorted list, **no cap**; else the published capped set, default 150) | `{opportunities: SynthOpportunity[] (math.ts:176), status}` | — | — | :97 |
| `GET /api/synthetic/trades/open` | admin | — | `{db_enabled, open: SynthOpenView[]}` | — | — | :108 |
| `GET /api/synthetic/trades/history` | admin | `scope` exactly `today` else `all`; `limit` finite >0 → `min(floor, 2000)`, default 500 | `{db_enabled, scope, trades: SynthTradeView[]}` (today or DB-down → memory list, limit ignored; all → Mongo `status:"closed"` sorted `closed_at` desc merged with memory) | 500 | — | :113 |
| `POST /api/synthetic/trades/:id/close` | admin (either role) | path id | `{ok:true, trade: SynthTradeView, open, status}` | 404 `No open paper position with that id.`; 409 `The market is closed. A paper position can only be closed at a live touch.` / `This position's contracts are not resolved on the active broker yet.` / `Cannot close at the touch right now: <legs>. No fill is invented; the position stays open.` / `This position is already closing.` / `This position was already closed.` / store errors; 500 | `synth_trades` update (guarded on open); SSE `exit` + snapshot | :125 |
| `DELETE /api/synthetic/trades/:id` | full* / delete 20 per min (before auth) | JSON body `{reason?: string (trim, ≤500), expected_status?: "open"\|"closed"}` | `{ok:true, deleted_id, deleted_from:"open"\|"closed", already_deleted: bool, status, open, closed_today: SynthTradeView[] /* flat array */}` | 503 `Paper-trade storage is not connected.`; 404 `No such paper trade.` (also any non-ObjectId id); 409 (open-but-expected-closed, being closed, closed mid-flight, unmanaged open, closed-while-confirming with ₹ en-IN amount, could not be deleted — engine.ts:1660-1740); 500 | **soft delete**: `status:"deleted", deleted_at, deleted_from, delete_reason, deleted_by`; SSE `trade_deleted` + snapshot | :149 |
| `GET /api/synthetic/chain/:underlying` | admin | path upper-cased | `{underlying, name, is_index, expiry, lot_size, atm_strike, strike_step, future: Side, strikes:[{strike, is_atm, ce: Side, pe: Side}]}`, `Side = {token, tradingsymbol, bid, bid_qty, ask, ask_qty, last, age_ms}` | 404 `{"error":"<U> is not being monitored."}` | — | :194 |
| `GET /api/synthetic/stream` | any role via header or `?x-admin-token=` | — | **SSE** (§3.3) | 403 `{"error":"Admin authentication required"}` | — | :204 |

Shape S — `getStatus()` (engine.ts:1973): `running, market_open, authenticated, broker, detection_only,
execution_mode:"paper_touch", paper_trading, paper_blocked_reason:"disabled"|"no_db"|"loading"|"unsafe_index"|null,
db_enabled, strike_level, paired_underlyings, monitored_underlyings, skipped_for_budget, unbuilt_windows,
subscribed_tokens, ready_books, token_budget, base_token_budget, borrowed_from_box, box_scanner_running|null,
box_lane_tokens|null, feed_age_ms, feed_healthy, universe_at, evaluated_at, close_session_day, eligible_count,
opportunity_count, open_count, max_open_positions, margin_enabled, unlinked_positions, day_pnl{day, open_count,
open_mtm_ltp, open_unmarked_count, open_running_gross_pnl, open_running_net_pnl, open_unpriced_count, closed_count,
closed_realised_gross_pnl, closed_charges, closed_realised_net_pnl, total_net_pnl, total_gross_pnl, open_margin,
open_margin_unknown, closed_margin, closed_margin_unknown}, rf_pct, rf_source:"admin"|"default", last_error,
config{strike_level, min_expected_net_profit, safety_buffer, expected_slippage, include_carry, default_rf_pct,
quote_max_age_ms, feed_max_age_ms, max_tokens, share_box_budget, lane_token_limit, max_underlyings,
max_published_opportunities, enable_conversion, enable_reversal, skip_expiry_day, paper_trading, max_open_positions,
default_max_open_positions, settings_persisted, signal_confirmations, reentry_cooldown_ms, convergence_floor,
convergence_pct, min_exit_net_pnl, profit_capture_pct, min_captured_pct, expiry_safety_minutes, option_rate_version,
futures_rate_version, tunable:{min_expected_net_profit:{min:0,max:100000}, safety_buffer:{min:0,max:50000}, max_open_positions:{min:0,max:10000}}}`.

`SynthTradeView` = `SynthTrade` (math.ts:819-884) with `opened_at`, `closed_at`, `margin_at` as ISO strings;
`SynthOpenView` adds `linked, closing, exit_legs, mtm_ltp, current_exit_charges, remaining_edge, captured_edge,
captured_pct, convergence_threshold, profit_capture_target, min_exit_net_pnl, expiry_safety, exit_eligible,
exit_rule_reason, exit_blocked_reason` and overrides `gross_pnl/total_charges/net_pnl` with "if closed now" figures
(engine.ts:201-226, 1902-1937). Older rows may lack optional leg fields entirely (lean reads, no defaults).

### 2.12 Fair Value — read-only analytics (fairValue/routes.ts; engine src/fairValue/engine.ts)

Mounted as an Express `Router` at `/api/fair-value` (fairValue/routes.ts:123). **Router-wide guard**
(fairValue/routes.ts:18-33) runs for every path under the prefix, including unknown ones:
- sets `Cache-Control: private, no-store` on every response;
- `GET /stream`: token from header `x-admin-token` else `?x-admin-token=`, role must be `full` → else 403
  `{"error":"Full admin access required."}`;
- everything else: `requireFullAdmin` (header only), **and** `res.json` is wrapped so the role is re-checked when the
  body is sent — if the token stopped being `full` mid-request, the reply becomes 403 with the same body.

Errors: `fail(res, err, status)` → `{error}`; status per route below. Storage: Mongo `fair_value_settings`
(`_id:"current"`, `{version, config, updated_at}`) and `fair_value_snapshots` (TTL `expires_at`); memory-only
when DB is down (`storage:"memory_only"`). No broker REST calls (quotes from websocket ticks via the `analytics`
subscription owner). Worker threads compute surfaces.

| Method & path | RL | Input | Response 200 | Errors | Source |
|---|---|---|---|---|---|
| `GET /api/fair-value/status` | — | — | `status()`: `{enabled, paused, model_version:"black-act365f-raw-svi-price-huber-v1", config_version: 20-hex, force_disabled_reason, surface_max_age_ms, config_persisted, expiry_policy_configured, curve_configured, broker, broker_generation, feed_generation, feed: LaneFeedStats, data_ready, subscribed_tokens, watched_underlyings: string[], workers:{running, queued, failures, workers}, last_error, storage:"mongodb"\|"memory_only", persistence_error, history_memory:{snapshots, bytes}, surfaces:[{underlying, id, sequence, age_ms, valid_expiries}]}` | — | fairValue/routes.ts:37 |
| `GET /api/fair-value/config` | — | — | `{config: FairValueConfig, version, persisted}` | — | :38 |
| `PATCH /api/fair-value/config` | work 30/min | partial config object (strict merge; every key must exist; sub-objects `quote/iv/forward/smile/curve` merged one level; `expiry_policy`, `carry`, scalars replaced) | `{version, persisted, status}` | 400 `{error}` with validation texts, e.g. `Configuration must be an object.`, `Unknown Fair Value setting: <k>.`, `<name> requires [integer ]<lo>..<hi>.` (JS number formatting), `A Fair Value configuration update is already in progress.`, or the force-disable reason when enabling | :39 |
| `GET /api/fair-value/underlyings` | — | — | `{underlyings:[{symbol, name, expiries: string[]}], status}` | 503 `{error}` (e.g. `Broker namespace changed while loading underlyings.`) | :43 |
| `GET /api/fair-value/snapshot/:underlying` | — | path (upper-cased, not validated) | `{snapshot: SurfaceSnapshot\|null, surface_age_ms, stale, status}` | — | :47 |
| `POST /api/fair-value/refresh` | work | body `{underlying: string}` | `{snapshot, pending, status}` | 400 `underlying is required.`; 503 (disabled / paused / stopped / force reason / `Current broker market data is unavailable or switching.` / `Invalid underlying symbol.` / universe errors) | :48 |
| `POST /api/fair-value/pause` | — | body `{paused: boolean}` | `{status}` | 400 `paused must be boolean.` | :53 |
| `POST /api/fair-value/calculate` | work | `{underlying, strike: number>0, expiry_timestamp: exact ISO w/ zone, side:"CE"\|"PE", research_mode: bool, input_snapshot_id?: ^[A-Za-z0-9-]{1,100}$}` | `CalculatorResult` (types.ts:464; 200 even when `available:false`) | 400 `{error}` (validation, availability, stale/retained-input, worker errors) | :58 |
| `POST /api/fair-value/independent` | work | `{underlying, expiry: YYYY-MM-DD, strike: number>0, input_snapshot_id}` | `IndependentEstimate` (types.ts:433) | 400 `{error}` | :62 |
| `GET /api/fair-value/history/:underlying` | — | `limit` → `min(500, max(1, Number(limit) \|\| 100))` | `{historical:true, snapshots: Summary[], storage}` | 503 `{error}` (practically unreachable) | :66 |
| `GET /api/fair-value/history/:underlying/:id` | — | id `{32hex}-{seq}-{8hex}` (not validated) | `{historical:true, snapshot: SurfaceSnapshot}` | 404 `Historical snapshot unavailable or outside retention.`; 503 Mongo error | :73 |
| `GET /api/fair-value/export/:underlying` | — | path | same body as snapshot + header `Content-Disposition: attachment; filename="fair-value-snapshot.json"` | 404 `No current Fair Value snapshot.` | :80 |
| `GET /api/fair-value/stream` | — | `underlying` (optional, upper-cased), token header/query | **SSE** (§3.4) | 403 (guard); 429 `{"error":"Fair Value subscription limit reached."}` (20 listeners) as JSON before SSE headers | :86 |

Env: `FAIR_VALUE_DISABLED=true` (force-disable), `FAIR_VALUE_ENABLED=true` (default `enabled`),
`FAIR_VALUE_CONFIG_JSON` (patch over defaults; invalid → disabled with reason). Full config field list, ranges and
messages: src/fairValue/config.ts:20-175 and docs/FAIR_VALUE.md.

---

## 3. SSE endpoints

No endpoint sets `id:` or `retry:`; browsers use their default reconnect delay. All SSE responses still carry the
global CORS headers. Errors are always returned as JSON **before** SSE headers are written.

### 3.1 Market-data ticks — `GET /api/stream/session/:id` and legacy `GET /api/stream`

`openTickStream` (marketDataRoutes.ts:179-276):
1. Refusals first (401 not data-ready, 409 foreign tokens) as JSON.
2. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
   `X-Accel-Buffering: no`; `flushHeaders()`.
3. `tickerHub.attachClient(res, tokens)` (hub.ts:74): if the hub cache has a latest tick for any requested token,
   writes **one unnamed frame** `data: <JSON Tick[]>\n\n` with those ticks (filtered to the session's tokens).
4. `brokerManager.acquireBrowserTokens(tokens)` → refcounted `browser` lease on the subscription coordinator
   (the only path that subscribes upstream on the active broker).
5. Keep-alive comment `: ping\n\n` every **20 000 ms**.
6. Live data: every hub broadcast writes `data: <JSON Tick[]>\n\n` (hub.ts:288-332). **The broadcast is not
   filtered by the client's token set** — each client receives every tick batch the hub publishes (Zerodha socket
   ticks and Dhan futures-lane ticks; Box-lane ticks bypass the hub). Broadcast ticks are "slim":
   `{token, last_price, close_price, oi, bid, ask, bids?, asks?, depth_updated?, exchange_ts?}`.
7. Named event `kite_error` with `data: {"message": string}` is written to every client when the legacy **Zerodha**
   hub socket fails (hub.ts:376); the hub then stops but client responses are not ended.
8. Cleanup is idempotent on `req close`, `res close`, `res error`: clear ping, release lease **before** detaching from
   the hub, `sessions.close(id)` (session path), `res.end()`.

Session lifecycle (marketDataSession.ts):
- `create(tokens, broker, generation)`: sweep, evict LRU idle session if `size >= 500`
  (if every session has a live connection nothing is evicted and the store grows past 500), id
  `randomBytes(16).hex`, tokens deduped.
- `resolve(id, broker, generation)`: sweep; unknown → 404; broker or generation mismatch → **session deleted**,
  409; else `lastUsedAt = now`. Sessions are looked up, never consumed — EventSource reconnects reuse the id.
- `open`/`close` maintain `connections`; reaped only when `connections == 0` and idle > **5 min**.
  Sweeps run on create/resolve and every 60 s (index.ts:1614).
- Broker switch → `dropAll()` (all ids become 404).
- Frontend reconnection contract (tickStream.ts): on EventSource CLOSED (e.g. 404) wait 3 s and mint a new
  session; 409 at session creation → refetch board; `kite_error` → fatal.

Legacy `GET /api/stream?tokens=` is identical minus session bookkeeping (frontend uses it only as a fallback in
chunks when session creation fails with a non-409 error).

### 3.2 Box — `GET /api/box/stream` (box/routes.ts:535; engine.ts:5467-5511)

- Auth: any admin role, header or `?x-admin-token=`; checked once at connect (an expired token keeps streaming).
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` (no
  `X-Accel-Buffering`); `flushHeaders()`.
- On connect: one `event: snapshot` frame to this client; starts the shared publish timer if not running.
- Frames: `event: <name>\ndata: <JSON>\n\n` only (no unnamed frames), plus `: ping\n\n` every **20 000 ms** (unref'd).

| Event | Payload | When |
|---|---|---|
| `snapshot` | `{status: getStatus(), opportunities: getOpportunities(), open_trades: getOpenPositions()}` | connect; every `BOX_PUBLISH_INTERVAL_MS` (default **500 ms**, config.ts:1120) while any client is connected or the feed is held; immediately after start/stop/strike-level/settings/delete/broker switch (`publishNow`) |
| `entry` | `{trade: SerializedBoxTrade}` (full, with audit) | box opened (engine.ts:2745) |
| `exit` | `{trade: SerializedBoxTrade}` | box closed (engine.ts:3003) |
| `execution_attempt` | `{attempt}` (abort/unwind record) | legging abort (engine.ts:2443) |
| `trade_deleted` | `{id, trade: SerializedBoxTrade}` | trade deleted (engine.ts:3404) |

No coalescing or backpressure handling; write errors swallowed. `stop()`/`dispose()` do not end client streams.
On `req close`: clear ping, remove client, `res.end()`.

### 3.3 Synthetic — `GET /api/synthetic/stream` (synthetic/routes.ts:204; engine.ts:2111-2150)

Same auth/headers/ping as Box. Events `snapshot` `{status, opportunities: <published set>, open_trades}`,
`entry` `{trade: SynthTradeView}`, `exit` `{trade}`, `trade_deleted` `{id, from:"open"|"closed"}`.
Snapshot on connect, then every `SYNTH_PUBLISH_INTERVAL_MS` (default **1000**, min 200) while ≥1 client (timer cleared
at 0 clients), plus immediate publishes after start/stop/settings/entry/exit/delete/margin capture
(not strike-level). `dispose()` (shutdown) ends every client (`res.end()`); `stop()` does not.

### 3.4 Fair Value — `GET /api/fair-value/stream` (fairValue/routes.ts:86)

- Auth: `full` only (guard), **re-checked on every emission**; lost role → stream closed.
- `engine.subscribe()` first (max 20 listeners → 429 JSON). Headers: `Content-Type: text/event-stream`,
  `X-Accel-Buffering: no`, `Cache-Control: private, no-store` (from the guard); no `Connection` header.
- Emits immediately, then every **5000 ms**: if dirty → `event: snapshot\ndata: <JSON>` where data is
  `getSnapshot(underlying)` when `?underlying=` was given, else `status()`; if not dirty → `: heartbeat\n\n`.
  Listener notifications (publication, config change, pause, invalidation, failures) only set dirty.
- Closes if `res.writableLength > 256000`. Not used by the frontend (it polls).

---

## 4. WebSocket

**No WebSocket server.** The backend is only a WebSocket *client*: Kite ticker (src/ticker.ts:76) and Dhan market
feed (src/brokers/dhan/feed.ts:190), on two lanes (futures/board lane and the Box lane).

---

## 5. Startup, listen and shutdown

- Listen: `PORT` (default 3001), all interfaces, HTTP, `app.listen` callback starts the async init chain
  (index.ts:5441-5555): `initDb` → restore same-IST-day Kite session (`kite_session`, discard if `login_date` ≠ today)
  → `brokerManager.restore()` (`active_broker`) → `startActiveRuntime()` → restore `admin_sessions` (expiry > now)
  → restore `rf_rate` → hourly scheduler + backfill → day-review scheduler → Redis warm load → Redis flush retry
  → option-OI capture → Box / Synthetic / Fair Value `boot()`. Separately: trade-log connection, nse_fno connections
  + EOD scheduler. Failures are logged, the process keeps serving.
- Env with HTTP effect: `PORT`, `FRONTEND_URL` (CORS origin + `/callback` redirects; default
  `http://localhost:5173`), `ADMIN_SECRET`, `ACCESS_SECRET`, `TOKEN_ROUTE_SECRET`, `INTERNAL_TOKEN_SECRET`,
  `KITE_API_KEY`/`KITE_API_SECRET`, `MONGODB_URI`/`BOX_MONGODB_URI` (DB-enabled flags), `DHAN_*`,
  `BOX_PUBLISH_INTERVAL_MS`, `SYNTH_PUBLISH_INTERVAL_MS`, `FAIR_VALUE_*`, `SHUTDOWN_TIMEOUT_MS`.
- Shutdown on SIGTERM/SIGINT (coordinator index.ts:5571, signal hooks :5660, timeout `SHUTDOWN_TIMEOUT_MS` default 12000): stop Box discovery →
  dispose Synthetic (ends its SSE) → dispose Fair Value → `server.close()` + `closeIdleConnections()`, after **3000 ms**
  `closeAllConnections()` (drops SSE) → clear tracked timers → dispose Box engine → stop feeds → close Mongo.
  Positions are never flattened. `unhandledRejection` is logged (process survives); `uncaughtException` exits 1.

---

## 6. Frontend usage (`../Cal_Spread`)

Transport: base `VITE_API_BASE_URL` (default `http://localhost:3001`, trailing `/` and `/api` stripped;
src/api.ts:11-26); no Vite proxy, so dev is cross-origin (5173 → 3001). Admin token in localStorage
`cal_spread_admin_token` (api.ts:30-41), sent as `x-admin-token` by `getHeaders()` (api.ts:45-53, which also always
sends `Content-Type: application/json`, so every request preflights). No `credentials`, no cookies, no global 401/403
handler; errors read `body.error` (api.ts:68-81, non-JSON 200 throws). Fair Value client always sends both headers
and dispatches `calspread:fair-value-access-denied` on 403 (fairValue/api.ts:6-19).

| Endpoint | Frontend call (file:line) | Fields the frontend depends on |
|---|---|---|
| POST /api/admin/verify | api.ts:127 (Admin.tsx:64-75) | `success`, `token`, `broker`, `broker_switch_refused`, `broker_switch_blockers[{reason,detail}]` |
| POST /api/access/verify | api.ts:158 | `success`, `token` |
| GET /api/admin/status | api.ts:191 (App.tsx:426) | `role`, `broker`; non-OK → treated as logged out |
| GET /api/status | api.ts:541 (App.tsx:435, 469 poll **7 s**, 1261) | `authenticated` (gates streaming), `broker`, banner fields `feed_state`, `market_data_ready`, `problems`, … |
| GET /api/rf/current | api.ts:486 (App.tsx:448) | `rf` |
| POST /api/rf | api.ts:500 (App.tsx:~260) | ok / `error` |
| GET /api/dividends | api.ts:847 (App.tsx:443) | `yields` |
| GET /api/fno-board | api.ts:602 (App.tsx:281) | `board[].symbol/name/spot_token/futures[].token,expiry,lot_size/is_index` |
| POST /api/quotes | api.ts:711 (App.tsx:528, Analytics.tsx:476) | `ticks[]` (token, last_price, close_price, oi, bid, ask, bids, asks); 409 → refetch board |
| POST /api/stream/session | api.ts:678 (tickStream.ts:109) | `id` (required); 409 → StaleBrokerTokensError |
| GET /api/stream/session/:id (SSE) | api.ts:699, tickStream.ts:136 | unnamed `data:` Tick[]; `kite_error`; 404 → re-mint after 3 s |
| GET /api/stream?tokens= (SSE) | api.ts:658, tickStream.ts:126 | fallback only |
| GET /api/login (navigation) | api.ts:424 (App.tsx:1127, 1163; BrokerPanel.tsx:302) | must 302 to Kite |
| POST /api/session | api.ts:436 (App.tsx:372, on `/zerodha/verify`) | success only |
| POST /api/logout | api.ts:548 (App.tsx:295, 364; BrokerPanel.tsx:~156) | ignored |
| GET /api/kite/access-token | api.ts:464 (AccessTokenModal.tsx:24) | `access_token`, `api_key`, `login_date`; 409/403 |
| GET/POST /api/trades, POST /:id/close, DELETE /:id | api.ts:295, 281, 400, 413 (App.tsx:162, 201, 240, 221) | `dbEnabled`, `trades[]` Trade fields; `trade` |
| GET /api/history, /intraday, /minute, /fivemin/:symbol | api.ts:330, 361, 374, 387 (StockDetail.tsx:123-125) | `futures[].token/expiry/points` |
| GET /api/spread-stats/:symbol | api.ts:833 (StockDetail.tsx:127, TradeConfirmModal.tsx:30) | SpreadSummary fields; 404 → null |
| GET /api/option-chain/:u | api.ts:916 (Analytics.tsx:427) | `spot_token`, `strikes[]`, `spot`, `atm_strike`, `expiry`, `expiries`, `lot_size` |
| GET /api/option-oi-baseline/:u | api.ts:949 (Analytics.tsx:562, poll 30 s) | `minutes` **must echo request**, `oldest`, `tokens` |
| GET /api/option-prev-close/:u | api.ts:973 (Analytics.tsx:584, poll 30 s) | `tokens` |
| GET /api/option-oi-frame/:u | api.ts:1061 (Analytics.tsx:611, 645, 689; polls 30/60 s) | `frame` **must echo**, `points[]` incl. `wLo/wHi/partial` |
| GET /api/futures-oi-frame/:u | api.ts:1106 (Analytics.tsx:726, 762; poll 60 s) | `frame` echo, `points[].legs`, `contracts[]` |
| Box REST (status, execution-control, opportunities, trades/history, execution-attempts, chains?underlying, trades, start, stop, strike-level, settings, trades/:id/close, DELETE trades/:id, execution-mode/preview, paper-profile, session/arm, session/disarm, controls/*) | api.ts:1816-2348 (Box.tsx:236-544, BoxGates.tsx:95, BoxExecutionControl.tsx:130-495, BoxSessionControl.tsx:77-96, App.tsx:184); chains polled **1 s** while a row is open (Box.tsx:468) | `status`, `open[]`, `closed_today.trades[]`, `config.min_expected_net_profit/safety_buffer`, `execution`, `session.max_completed_trades`, `outcome`, history `trades/lite/source/dbEnabled` |
| GET /api/box/stream (SSE) | api.ts:2613, Box.tsx:384 | `snapshot` (status, opportunities, open_trades), `entry` (ignored payload), `exit` `{trade}`; `trade_deleted`/`execution_attempt` not handled |
| Broker/Dhan (broker/status, broker/select, dhan/status, dhan/login, dhan/session, dhan/verify-ip, dhan/logout) | api.ts:2455-2600 (BrokerPanel.tsx:81-155, App.tsx:294, 405 on `/dhan/verify`) | snapshot `broker`…; select error `blockers[]`; `login_url` (navigated); dhan/session `broker`; verify-ip `verified`, `error` |
| Synthetic REST (opportunities, trades/open, trades/history, start, stop, strike-level, settings, trades/:id/close, DELETE trades/:id) | api.ts:3017-3135 (Synthetic.tsx:165-376) | `status`, `opportunities`, `open`, `db_enabled`, `trades`, `persisted` (only explicit false), `trade.gross_pnl/total_charges/net_pnl`, `closed_today[]`; DELETE always sends `{expected_status, reason?}`, 404 → already gone |
| GET /api/synthetic/stream (SSE) | api.ts:3148, Synthetic.tsx:197 | `snapshot`, `entry`, `exit {trade}`, `trade_deleted {id}` |
| Fair Value (status, GET/PATCH config, underlyings, snapshot, refresh, pause, calculate, independent, history, history/:id, export) | fairValue/api.ts:25-36 (FairValue.tsx:58 poll **15 s**, 96-261; snapshot poll **5 s** at :139) | see FairValue.tsx:64-268 (snapshot slices/rows/smile/forward/discount fields); `persisted`, `status` |

Frontend redirect routes: Kite must redirect to the **frontend** `/zerodha/verify?status=…&request_token=…`
(App.tsx:352-384 → `POST /api/session`); Dhan to `/dhan/verify?tokenId=…` (App.tsx:387-421 → `POST /api/dhan/session`).
The backend `/callback` is not used by this flow.

**Endpoints the frontend never calls:** `GET /`, `/api/internal/kite-token`, `/api/kite/token`, `GET /api/rf`,
`GET /login`, `GET /callback`, `/api/profile`, `/api/instruments`, `/api/fno-stocks`, `/api/fno-stocks/:symbol`,
`/api/debug/indices`, `/api/spread-history/:symbol`, `/api/option-oi-series/:u`, `GET /api/quotes`,
`/api/market-data/status`, `/api/market-data/diagnostics`, `/api/broker/switch-blockers`,
`/api/dhan/instruments/diagnostics`, `/api/dhan/postback` (Dhan webhook), `/api/dhan/access-token`, `/api/dhan/token`,
`/api/box/config`, `/api/box/execution-diagnostics`, `/api/box/live/reconcile`, `/api/box/live/cancel-working`,
`/api/box/live/flatten`, `/api/box/trades/open`, `/api/box/chains` (without `underlying`), `/api/box/events`,
`/api/synthetic/status`, `/api/synthetic/chain/:u`, `/api/fair-value/stream`. These are still contract for scripts,
operators, recorders and webhooks (token routes, internal token, postback) and must be ported.

---

## 7. Ambiguities, surprises and doc mismatches (decide before porting)

1. **CORS omits PATCH** (`GET,POST,DELETE,OPTIONS`), but the frontend sends `PATCH /api/fair-value/config`
   cross-origin in dev; browsers will block it after preflight. Works only same-origin. Copy or fix deliberately.
2. **Tick SSE is not filtered per client** (hub.ts broadcast): every connected browser gets every hub tick batch.
   Only the initial snapshot is filtered. Filtering in Go is safe for the frontend (it maps by token) but changes
   bandwidth/behaviour.
3. `docs/MIGRATION_CONTRACT.md` is wrong in places: it lists Box status/opportunities/chains/stream as unauthenticated
   and start/stop/settings/strike-level/close as full-admin — the code uses `requireAdmin` (either role) for all of
   them, with full only for controls, paper-profile, session arm/disarm, live/*, and DELETE. It also says both SSE
   surfaces send `X-Accel-Buffering: no` (Box/Synthetic do not) and omits Synthetic and Fair Value entirely.
4. Calendar `DELETE /api/trades/:id`, `POST /api/trades` and close accept the **trade** role, despite the CORS
   comment claiming destructive routes are full-admin.
5. No custom error handler: malformed JSON → 400 HTML, >100 kB → 413 HTML, unknown route → 404 HTML;
   `POST /api/access/verify` without a JSON body → 500 HTML (unguarded destructure on Express 5's undefined body).
6. Rate limiter trusts `X-Forwarded-For` without `trust proxy` (spoofable); all buckets are per-process memory.
7. Calendar trade margin, charges and the ladder REST fallback call **Kite** even when Dhan is active;
   `/api/profile` is Kite-only and a Kite 401/403 there clears the Kite session.
8. `/api/history|spread-history|intraday|minute|fivemin` caches are keyed by symbol only (not broker/generation),
   so after a switch they can serve the previous broker's tokens until the IST day rolls / TTL expires.
9. Analytics routes ignore `:underlying` (NIFTY only). `option-chain` with non-numeric `band` returns empty `strikes`.
10. `KiteError` may carry status 200 (Kite HTTP 200 with `status != success`) → 200 response with an `error` body.
11. `/api/kite/token`, `/api/kite/access-token` report `login_date` as **today's** IST day, not the stored login day.
12. Box `start` error says "Connect to Zerodha…" regardless of the active broker. Box delete is a **hard** delete,
    Synthetic a **soft** delete. Response naming differs: Box `dbEnabled` + `closed_today.{trades,…}`, Synthetic
    `db_enabled` + flat `closed_today[]`.
13. Box/Synthetic stream auth is checked only at connect; Fair Value re-checks every emission.
14. Market-data session store can exceed its 500 cap when every session has a live connection.
15. Requests are served before boot finishes (admin sessions restored asynchronously → transient 403s).
16. `docs/CONFIGURATION.md`: `FRONTEND_URL` default is `http://localhost:5173` (doc says none); `EXTRA_SESSION_DAYS` is
    a comma-separated list of weekend IST dates treated as special trading sessions by the capture market-hours check
    (`isIstMarketHours`, index.ts:3501-3530), not a "session restore window". `POST /api/trades` uses the separate
    `isMarketOpen()` (index.ts:1711), which ignores it.
17. `POST /api/rf` accepts `null` (→ 0), booleans and numeric strings via `Number()`.
18. Fair Value guard wraps `res.json` and returns 403 for any unknown `/api/fair-value/*` path to non-full callers.
