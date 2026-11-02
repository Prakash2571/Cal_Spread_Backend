Pipeline completed: 5 stages finished.

## registry

FINAL REPORT: stage "registry" (Node → Go, Box removed)

The port is complete and builds. It matches goldens recorded from the original TypeScript. The final run happened after all mutation checks were reverted: gofmt prints nothing, vet is clean, and the full -race suite passes with REQUIRE_DB_TESTS=1.

(a) FILES WRITTEN OR CHANGED

New package internal/brokers/registry/:
- Source: serial.go, jsutil.go, store.go, registry.go, dhansession.go, instruments.go, quotes.go, margins.go, history.go, diagnostics.go, switch.go, routes.go.
- Tests: helpers_golden_test.go, fakes_test.go, routes_golden_test.go, registry_test.go.
- testdata: gen_registry.mjs, hooks.mjs, stub_db.mjs, stub_box.mjs, helpers.golden.json (143 cases), routes.golden.json (9 scenarios, 249 steps).
- Regenerate: scratch/go-migration/check.sh node internal/brokers/registry/testdata/gen_registry.mjs
- hooks.mjs stubs src/db.ts, zerodha/liveAdapter.ts and box/dhanBrokerAdapter.ts by URL. src/ was not touched and no patched TS copy was needed.

internal/brokers/dhan/:
- NEW zz_registry.go: (*Client).CalculateMarginRaw(ctx, MarginLeg) (Value, error), and DateParse(s string) float64 (V8 Date.parse in time.Local).
- FIX in feed.go, proven by a golden. run() now dials through a new function, abandonableDial(ctx, d, u), instead of Dialer.DialContext; the "net" import was added.
  - Bug: Stop or Dispose during a pending WebSocket handshake left the handshake running for up to 45 s. gorilla watches ctx only during the TCP connect. Node drops a CONNECTING socket at once.
  - Proof: feed_life.json step 21 (dispose) expects closed ["0","1"]. With the fix reverted, Go gives ["0"].
- testdata/generate.mjs: the sections list now includes gen_margin.mjs and gen_feed.mjs.
- NEW testdata/gen_margin.mjs → margin.json (55 cases). NEW testdata/gen_feed.mjs → feed_life.json (4 scenarios, 85 steps).
  - Regenerate: scratch/go-migration/check.sh node internal/brokers/dhan/testdata/generate.mjs margin feed
- NEW tests: margin_golden_test.go (TestMarginPayloadHelpersGolden) and feed_life_test.go (TestFeedLifecycleGolden, using a loopback WS server).

Not touched: no migration was needed (0001_core already has dhan_session and active_broker). src/, tests/ and tasks/ are unchanged; `git status --porcelain -- src tests` is empty. No commit was made.

Leftovers: scratch/go-migration/tmp/{feed.go.bak, serial.go.bak, switch.go.bak} are byte-identical to the current files (checked with cmp) and can be deleted.

(b) EXPORTED API THAT cmd/server MUST WIRE

Construct: reg := registry.New(registry.Deps{...})
- Kite KiteAPI: the *kite.Client. Required. Its in-memory token is the Zerodha session.
- Hub Hub: the *hub.Hub. nil means a hub that does nothing.
- Store Store: &registry.PGStore{Pool: pool}. PGStore also has Now (nil means time.Now). A nil or disabled pool makes it a no-op. A nil Store means memory only.
- Lookup func(string) (string, bool): nil means os.LookupEnv. It is read on every call, including TOKEN_ROUTE_SECRET per request.
- Now func() time.Time: nil means time.Now.
- Dhan DhanConfig{APIRoot, AuthRoot, FeedURL, ScripMasterURLs, HTTPClient, Sleep, ReconnectDelay, Dialer}: the zero value means production endpoints and real timers. Set it only in tests.
- NewDhanFeed: nil means dhan.NewFeed.
- NewLaneFeed: nil means kite.NewZerodhaFeed.
- KiteConnect, KiteTickerURL: zero values mean the kite defaults.

Hooks: call reg.Attach(registry.Hooks{...}) once the consumers exist. Every field is optional.
- StopScanner = synthetic.Stop
- DropMarketDataSessions func() int = marketdata SessionStore.DropAll
- InvalidateBooks = synthetic.InvalidateNamespace, then fairvalue.InvalidateNamespace
- ReloadUniverse func(ctx) error = synthetic.ReloadUniverse. The registry logs a returned error.
- Publish = nil (it was the Box SSE)
- OnBrokerChanged(brokers.ID) = nil (it was Box publishNow)
- OnBoxLaneTicks([]market.Tick) = synthetic.OnTicks. The registry already calls NoteTick.
- OnBoxLaneConnection(bool) = synthetic.InvalidateBooks
- OnSessionLost(broker, reason) = synthetic.Stop

Routes: registry.Mount(r, registry.RouteDeps{Registry: reg, Sessions: sessions, IndexSpotMap: registry.IndexSpotMap}). RouteDeps.Now is the limiters' clock (nil means time.Now). Mount it under the global /api limiter. It registers 12 routes:
- GET /api/broker/status, GET /api/broker/switch-blockers, POST /api/broker/select
- POST /api/dhan/login, POST /api/dhan/session, GET /api/dhan/status, POST /api/dhan/verify-ip
- GET /api/dhan/instruments/diagnostics, POST /api/dhan/logout, POST /api/dhan/postback
- GET /api/dhan/access-token, GET /api/dhan/token

Limiters:
- Dhan login and session share one limiter: 5 min / 20.
- Switch: 60 s / 10.
- Token: 60 s / 30.

Auth: auth.Routes{Brokers: reg}. reg implements auth.BrokerControl through SwitchBroker(ctx, to, role). The actor is the role, or "admin" when the role is empty.

Lifecycle:
- Boot: Kite session restore, then reg.Restore(ctx), then reg.StartActiveRuntime(ctx).
- Shutdown: reg.StopFeeds(). It stops every lane and feed. There is no separate Dispose.

Synthetic Deps:
- MarketData = reg.MarketData()
- Margins = reg.Margins()
- SetTokens = reg.SetSyntheticTokens
- Switching = reg.Switching
- BrokerGeneration = reg.Generation (func() int64)
- ActiveBroker = reg.ActiveBroker
- BoxLane is not a registry method. Use synthetic.IdleBoxLane(getter).

Fair Value Deps (index.ts lines 5339–5364). Several need small adapters:
- ActiveBroker = func() string { return string(reg.ActiveBroker()) }
- BrokerGeneration = func() float64 { return float64(reg.Generation()) }
- MetadataVersion = "<broker>:<reg.InstrumentProvider().LoadedAt() or "unloaded">"
- DataReady = func() bool { return reg.ActiveHealth().DataReady }
- Switching = reg.Switching
- SetTokens = reg.SetAnalyticsTokens
- TokenBudget = reg.AnalyticsTokenBudget, which is max(0, 2800 − tokens held by any non-analytics owner)
- FeedStatus = func() any { return reg.LaneStats(brokers.LaneFutures) }
- RetainFeed is the hub's retain-fanout, not the registry.
- Then call reg.Subscriptions().SetAnalyticsYield(fv.YieldToPriority).

Market data and analytics can use:
- reg.ActiveHealth, reg.ActiveSession, reg.HealthFor, reg.SessionFor
- reg.AssertActiveBrokerToken(token, context)
- reg.QuoteProvider().QuotesByToken
- reg.AcquireBrowserTokens(tokens), which returns a release func
- reg.FeedHealth, reg.FeedConnected, reg.SubscribedCount
- reg.Subscriptions() and reg.BoxSubscriptions() (both *brokers.Coordinator)
- reg.UpstreamFeedStats, reg.LaneStats, reg.Snapshot
- reg.DhanStaticIPState, reg.DhanProblems
- reg.HistoryProvider(): GetHistoricalFull, GetHistorical, GetHistoricalOi, GetHistoricalOiSeries
- reg.InstrumentProvider(): Load(ctx, force), LoadWire(ctx, force) (wire rows keep their dhan_* fields), Size, LoadedAt, Invalidate, OwnsToken
- reg.DhanClient(), reg.DhanInstrumentStore()

Standalone helpers: ChunkDateRange, DhanCandlesToRows, DiagnoseBoard, CheckKnownSymbols, IndexSpotCandidates, ResolveIndexSpotSymbol.

(c) DEVIATIONS FROM NODE

1. Box removal:
   - SwitchBlockers returns only broker_not_configured.
   - The 409 body text "Cannot change broker while Box exposure or in-flight work exists." is kept, because the response bodies must not change.
   - Not ported: createLiveAdapter, dhanChargeCalculator, setBoxTokens, setStrategyTokens, the subscribeTokens/unsubscribeTokens strategy owner (only Box fed it), the clearInstrumentReservations hook, and the box_order_intents read.
   - The box-lane coordinator stays, because Synthetic is its scanner owner.
2. Every Dhan feed wire operation goes through one FIFO queue per feed. Subscribe and unsubscribe frames are sent asynchronously but in coordinator order. EnsureSocket, Stop and flush wait for the queue.
   - Reason: dhan.Feed blocks Unsubscribe and Stop while it is delivering a tick, and Synthetic holds its own lock while declaring tokens. Calling the feed directly deadlocks; mutation 1 below proved it.
3. Switch, Dhan login and Dhan logout run one at a time under one mutex. Node interleaved them at every await.
4. Handlers use context.WithoutCancel, so a client disconnect cannot abort a half-done switch or login. Store calls use their own 10 s timeouts.
5. Zerodha MarketData().GetQuoteFull returns market.RestQuote (3 fields). Node returned the raw Kite quote, including close and oi. The golden compares the 3 fields only. No route serialises this value.
6. The Dhan per-leg BasketMargin fallback omits the null hedge_benefit and exposure fields, because the shared market.BasketMargin type uses omitempty.
7. Rate limiters are created per Mount call. With one Mount this behaves the same as Node.
8. The Dhan feed handshake fix in (a). Go now matches Node.
9. NoteTick is called only by the Dhan futures feed and both box-lane feeds. Node noted Zerodha hub ticks only while Box was running, so this matches Node with Box idle. See (e) item 1.

(d) CHECKS RUN (all from the repo root through scratch/go-migration/check.sh)

Final run, after all mutations were reverted:

| Check | Result |
|---|---|
| gofmt -l internal/brokers/registry internal/brokers/dhan | no output, exit 0 |
| go vet ./internal/brokers/registry/... ./internal/brokers/dhan/... | exit 0, no output |
| REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 600s ./internal/brokers/registry/... ./internal/brokers/dhan/... | ok registry 2.752s; ok dhan 5.724s |
| same, with -v | 45 PASS (tests and subtests), 0 FAIL, 0 SKIP; 15 top-level registry tests |
| go build ./... | exit 0 |
| grep -rn MUTATION internal/brokers/ | no matches |
| cmp of the three .bak files against the current files | identical |

Earlier runs:

| Check | Result |
|---|---|
| go test -race -count=1 -timeout 180s -v -run Golden ./internal/brokers/registry/ | 4 PASS |
| REQUIRE_DB_TESTS=1 go test -race -count=8 -timeout 600s -run TestRoutesGolden ./internal/brokers/registry/ | ok, 9.5 s |
| REQUIRE_DB_TESTS=1 go test -race -count=3 -timeout 400s ./internal/brokers/registry/ | ok |
| TestMarginPayloadHelpersGolden (dhan) | ok |
| TestFeedLifecycleGolden (dhan) | 4 PASS |

Mutation checks. Each one failed the named test as intended and was then reverted:

| Mutation | Failing test and symptom |
|---|---|
| serial.go: synchronous unsubscribe | TestBoxLaneConsumerLockDoesNotDeadlockTheDhanFeed (10 s deadlock) |
| switch.go: InvalidateBooks moved before stopAllLanes | TestRoutesGolden, step 6 (hook order) |
| switch.go: persisted generation ignored | TestSwitchAdoptsTheHigherDurableGeneration ("generation 2") |
| dhan feed.go: fix reverted | TestFeedLifecycleGolden, step 21 |

(e) LEFT UNDONE OR NEEDING A DECISION

1. Decision needed. On Zerodha, futures-lane hub ticks do not call reg.NoteTick. So with Synthetic idle, Zerodha feed health stays CONNECTING, as Node did with Box idle. If you want hub ticks to count, wire hub.AddTickListener(func(...){ reg.NoteTick() }). That is a small behaviour change from Node with Box idle.
2. cmd/server needs these adapters:
   - The Fair Value ones listed in (b).
   - registry.UpstreamFeedStats converted to marketdata's UpstreamStats type.
   - Generation is int64; marketdata SessionStore and brokers.LaneFeedStats use int.
3. Dhan REST read retries and pacing are not covered by goldens. The goldens ran with DHAN_MAX_READ_ATTEMPTS=1 and DHAN_MIN_INTERVAL_MS=0. That code belongs to the earlier dhan stage.
4. Node logged the ReloadUniverse failure text inside the hook. To keep that exact text, cmd/server can log it itself and return nil.
5. abandonableDial wraps NetDialContext, NetDial and default dialing, but not NetDialTLSContext. No Dhan code sets NetDialTLSContext; kite/ticker's equivalent wrapper does handle it.
6. The .bak files in scratch/go-migration/tmp/ can be deleted. A Git checkpoint is a good idea after your review.

---

## mdroutes

STAGE mdroutes: done. `src/marketDataRoutes.ts` is fully ported. The Node golden replay (12 scenarios, 470 steps) and 14 focused tests pass with -race. Nothing outside my files was changed: no shared package, no zz_ files, no migration. session.go and session_test.go are untouched.

(a) Files
New, in internal/marketdata/:
- routes.go: RouteDeps, Mount, all 7 routes, sendError, the status/diagnostics types.
- routes_query.go: the lenient `?tokens=` parse, following node:querystring.
- routes_sweep.go: StartSessionSweeper.
- routes_test.go: the focused httptest suite.
- routes_golden_test.go: the golden replay.
- testdata/gen_routes.mjs, testdata/ts_hooks.mjs, testdata/routes.golden.json (generated, 475 KB).

Scratch:
- scratch/go-migration/tmp/mdroutes/index_fns.ts: the generator writes it on every run. It holds getAdminRole, requireFullAdmin and sendError copied verbatim from index.ts, with stubs.
- peek.mjs: prints a summary of the golden.
- hang.log: a debug log. Safe to delete.

Note: the todo_list tool's state turned out to be shared with the calendar agent. One of my `complete` calls marked tasks 1 and 2 of their list as completed. Please check that list.

(b) API for cmd/server
- `store := marketdata.NewSessionStore(marketdata.SessionStoreOptions{})`. This is the same store the broker switch empties with DropAll.
- `stop := marketdata.StartSessionSweeper(store, 0)`: sweeps every 60 s, as index.ts:1614 did. Call stop at shutdown; it is idempotent.
- `marketdata.Mount(r, marketdata.RouteDeps{...})`. It panics if a required field is nil. Fields:
  - Sessions (required): store.
  - Hub (required): the *hub.Hub.
  - ActiveBroker (required): registry.activeBroker.
  - Generation (required): registry.generation.
  - DataHealth (required): `func() (bool, []string)` returning activeHealth().data_ready and .problems.
  - AssertActiveBrokerToken: `func(token int64, context string) bool`, registry.assertActiveBrokerToken (it does the logging). If nil, every token is accepted.
  - QuotesByToken (required): `func(ctx, []int64) ([]market.Tick, error)`, quoteProvider.quotesByToken. A *kite.KiteError answers with its own status; anything else answers 500 with its message. The ctx is never cancelled (Node kept going), so the providers must apply their own timeouts.
  - ClearKiteSession: kite ClearSession plus clearing the persisted kite_session. Called on a Kite 401/403.
  - AcquireBrowserTokens (required): coordinator Acquire(browser, tokens).Release.
  - FeedHealth (required): registry.feedHealth() as brokers.FeedHealth.
  - Subscriptions and BoxSubscriptions (required): the stats of the two coordinators.
  - LaneStats (required): `func(brokers.Lane) brokers.LaneFeedStats`.
  - UpstreamFeedStats (required): adapt registry.upstreamFeedStats() to marketdata.UpstreamStats `{Broker, Wanted *int, Subscribed *int, SocketConnected, LastTickAt *int64}`.
  - BoardSize: `func(ctx) (int, error)` = len(deriveFnoBoard(instruments)). An error, a panic or nil gives null.
  - IsFullAdmin: `func(r) bool { return sessions.RoleOf(r) == auth.RoleFull }`. If nil, access is denied.
  - PingInterval, NewTicker, Now: leave zero. The defaults are 20 s, time.NewTicker and time.Now.
- Shutdown: SSE handlers end when their connection closes. Use http.Server.Shutdown with about a 3 s grace, then Close(), as Node's closeAllConnections did. The usual cleanup still runs: stop the keep-alive, release the lease, detach from the hub, close the session connection.
- Also exported: Snapshot, Diagnostics, FeedView, LanesView, BoxLaneView, Diagnose, the five Diagnosis* constants, MaxQuoteTokens, QuotesTTL, QuotesCacheEntries, and the Hub, Sessions and Sweeper interfaces.

(c) Deviations from Node
- GET `?tokens=`: integers of 2^63 or more are dropped, because int64 cannot hold them; Node kept them as doubles. Up to that, Go matches Node, e.g. 9007199254740993 becomes 9007199254740992.
- Finding in session.go (verified, left unchanged): ParseTokenList rejects integers above 2^53−1. Node accepts them, so POST answers 400 "`tokens` must contain positive integers only." where Node answered 200. Real tokens are below 2^34.
- Finding in httpx: a JSON body number outside the float64 range (e.g. 1e400) gives a 400 HTML page from ParseBody. Node gave 400 JSON from parseTokenList.
- HEAD requests and case-insensitive paths are not routed (chi). This is the same deviation already noted for Fair Value.
- A ping is written by the handler, while tick frames go through the hub's per-client queue. A ping can therefore overtake a queued frame. This is harmless because pings are comments.
- When the hub drops a client that is 1024 frames behind (a hub behaviour), the route ends the stream with the normal cleanup. Node never dropped clients.
- A *kite.KiteError wrapped in another error is still treated as a KiteError. A panic in BoardSize gives null.

(d) Checks (all through scratch/go-migration/check.sh)
- `node internal/marketdata/testdata/gen_routes.mjs`: "routes: 12 scenarios, 470 steps", exit 0. It runs the original marketDataRoutes.ts with the real MarketDataSessionStore, BoundedTtlCache and TickerHub, real KiteError, and the index.ts functions copied verbatim.
- The golden covers:
  - every parseTokenList message (4001-token limit, length checked before type);
  - lenient GET parsing: repeated keys, malformed % escapes, +, NBSP, 0x/0b/0o, the 1000-pair limit, and both 400 texts;
  - the 401 and 409 bodies with exact key order (first 10 foreign tokens);
  - Kite statuses 403, 401 (both clear the session), 429, 200 and 500, plus "fetch failed";
  - cache hits, misses and keys (order, dedupe, generation, broker); the TTL with a fake clock (3999 ms hit, 4000 ms miss); 256-entry FIFO eviction and the sweep of expired entries;
  - session create, 404, and 409 (which deletes the session, so the next request is 404);
  - SSE headers, the snapshot filtered to the session's tokens, unfiltered broadcasts, pings, reconnect on the same session, the cleanup order (clearInterval, release, detach, close, end), and the TTL reap at 300001 ms;
  - the legacy stream with no token cap, and kite_error reaching every stream while the stream stays open;
  - status snapshots, diagnostics 403 for no, trade, expired and unknown tokens, all five diagnoses, and board size as number, null or rejected (null).
- Go replays every step over real HTTP (server.New + Mount + Go hub). It compares status, exact body, SSE headers, every frame, every dependency call in order, session stats, onDead and Kite-session clears.
- `gofmt -l internal/marketdata`: no output.
- `go build ./internal/marketdata/...` and `go vet ./internal/marketdata/...`: ok.
- `REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s ./internal/marketdata/...`: ok (3.8 s).
- `go test -race -count=6 -timeout 300s ./internal/marketdata/`: ok (17.9 s), no flakes.
- Mutation 1, detach before releasing the lease: TestRoutesGolden fails in 5 scenarios, and TestCleanupOrderOnDisconnect, TestHubDroppedClientEndsTheStream and TestManyConcurrentStreams fail. Reverted; green again.
- Mutation 2, QuotesByToken given r.Context(): TestQuoteFetchOutlivesTheBrowser fails with "context canceled". Reverted; green again. An earlier run of this mutation hung until the 180 s timeout, because the test left its fake provider blocked after failing. The test now unblocks it in t.Cleanup.

(e) Open items
- None blocking. The registry agent's types need small adapters in cmd/server: UpstreamStats, and DataHealth returning (ready, problems).
- Should session.go's 2^53 limit be relaxed to match Node? I recommend leaving it.

---

## analytics

STAGE analytics: done. `internal/analytics` is the Go port of the NIFTY option/futures OI analytics (index.ts + redis.ts) on the PostgreSQL kv cache. It replays a Node golden recorded from the original TypeScript, and the full -race suite passes with REQUIRE_DB_TESTS=1.

(a) Files (all new; no shared package touched, no migration added: it uses the existing kv_keys/kv_fields from 0001)
- internal/analytics/
  - analytics.go: Deps, Service, New
  - js.go: JS Map order, UTF-16 compare/slice, trim/toUpperCase, Number(), the node:querystring parser, Express-style param decoding
  - ist.go: IST bucket math and the V8-compatible candle-time parser
  - types.go: point/snapshot/prev-close types with Node key order, plus warm-load decoders
  - window.go, frames.go, snapshots.go, writebehind.go, warmload.go, capture.go, backfill.go, scheduler.go
  - gate.go: ZerodhaCaptureGate, DefaultSendError
  - indexspot.go: private copy of indexSpot.ts
  - routes.go: the 6 routes
- Tests: golden_test.go, fakes_test.go, service_test.go.
- testdata/harness.mjs: copies the analytics segments of src/index.ts verbatim, located by marker lines (the load fails if a marker moves). It loads the real redis.ts, indexSpot.ts and trackedTimers.ts against a fake Upstash fetch, a fake clock and fake timers.
- testdata/gen_analytics.mjs writes testdata/analytics.golden.json (4.1 MB): 3281 pure cases and 19 scenarios with 680 steps. Each step records:
  - every broker call with its args and answer (Go replays this tape);
  - pacing delays and analytics log lines;
  - Upstash pipeline bodies;
  - route status and body;
  - state dumps.
- Helper scripts in scratch/go-migration/tmp/analytics/: mutate.sh, summarize.mjs, show.mjs, probe.mjs.

(b) API for cmd/server
- `svc := analytics.New(analytics.Deps{...})`. Deps fields:
  - Instruments: the active broker's instrument provider load().
  - QuoteFull: kiteClient.GetQuoteFull. Node called Kite directly here, gated by CaptureAllowed.
  - Historical / HistoricalOiSeries: the broker-neutral history provider (getHistorical / getHistoricalOiSeries). The package always passes kite.Background.
  - QuotesByToken: the active broker's quote provider quotesByToken. Used only for the option-chain spot; nil means spot 0.
  - CaptureAllowed: `analytics.ZerodhaCaptureGate(registry.ActiveBroker, kiteClient.HasSession, log.Printf)`. This is zerodhaCaptureAllowed, with its one-time warning.
  - MarketData: `func() analytics.Readiness{Ready: health.data_ready, Broker: activeBroker, Problems: health.problems}`. It feeds the option-chain 401.
  - SendError: the server's sendError, or nil for DefaultSendError. The default calls KiteAuthFailed on a KiteError 401/403.
  - KiteAuthFailed: kite ClearSession plus clearing the kite_session row (only used by the default SendError).
  - Cache: `kv.New(pool, nil)`. Nil or disabled means memory only, like Node without Redis.
  - ExtraSessionDays: cfg.ExtraSessionDays.
  - Now / AfterFunc / Sleep / Logf: leave nil. Logf must not call back into the service.
- `svc.Mount(r)` registers GET /api/option-chain/{u}, /api/option-oi-baseline/{u}, /api/option-prev-close/{u}, /api/option-oi-series/{u}, /api/option-oi-frame/{u} and /api/futures-oi-frame/{u}. All are public, with no per-route limiter.
- Boot: call `svc.Boot(ctx)` (WarmLoad, then Start) after the DB, the Kite session restore and the broker runtime, as in the Node boot chain. WarmLoad must run before Start.
- `svc.OnKiteLogin()`: call after a successful POST /api/session and GET /callback. It is the analytics half of triggerPostLoginBackfill; the hourly/EOD backfills stay with captures.
- Shutdown: `svc.Stop(ctx)` in the "stop capture/flush schedulers" step, then `svc.FlushNow(ctx)` before the pool closes.

(c) Deviations from Node
1. Cache transport is PostgreSQL kv instead of the Upstash pipeline. Commands run one at a time, and the first failure fails and requeues the whole flush; this is safe because the writes are idempotent, and Node's pipeline also failed as a whole. There is no 800 kB chunking. The 8 s per-call timeout and the 3-failures/60 s cooldown are kept. "[Redis]" log lines became "[Cache]" with adapted text; the [OptionOI]/[FuturesOI]/[Capture] lines are byte-identical (checked by the golden).
2. FlushNow adds the final flush at shutdown (a PLAN decision). It waits for a flush in flight and ignores the cooldown.
3. Stop cancels in-flight captures, backfills and pacing delays and stops the capture timer chain; Node kept them running until exit. A flush already in flight is allowed to finish.
4. Concurrency: one mutex, never held while a dependency is called. Captures have no single-flight, as in Node. Values are serialised when a flush starts, as Node did.
5. Routing:
   - Express's case-insensitive paths and HEAD on GET routes are not replicated (same as the Fair Value stage).
   - A malformed %-escape gets net/http's plain 400 before routing.
   - Escapes that do not decode to UTF-8 get Express's 400 HTML page ("URIError: Failed to decode param …").
6. Minor JavaScript emulation limits:
   - toUpperCase special-casing covers only ß and the Latin ligatures.
   - A candle stamp without a UTC offset is parsed in time.Local, as Node used server-local time; Kite stamps always carry an offset.
7. Warm-loaded values are decoded into typed structs, so foreign or corrupt shapes are dropped rather than passed through. Only this service writes these keys, and no Redis data is imported.
8. All six routes read the clock once per request; Node called Date.now() several times.

(d) Checks run
- `TZ=UTC scratch/go-migration/check.sh node --experimental-strip-types internal/analytics/testdata/gen_analytics.mjs`: wrote 3281 pure cases, 19 scenarios, 680 steps. A rerun was byte-identical (cmp exit 0). Under TZ=Asia/Kolkata only the offset-less candle-time case differs, as expected.
- `scratch/go-migration/check.sh gofmt -l internal/analytics`: no output.
- `go build ./internal/analytics/...`: ok. `go vet ./internal/analytics/...`: ok (both via check.sh).
- `REQUIRE_DB_TESTS=1 scratch/go-migration/check.sh go test -race -count=1 -timeout 180s -v ./internal/analytics/...`: all 13 tests passed (ok 1.934s), no race reports. The tests cover:
  - pure golden and the 19 replayed golden scenarios;
  - PostgreSQL round trip: write-behind then warm load gives the same state, and every key has its Node TTL (EXPIRE re-sent only after 15 minutes);
  - outage: requeue, cooldown, HDEL of pruned buckets, FlushNow after Stop;
  - a flush requested during another runs after it, and FlushNow waits for one in flight;
  - captures and backfills through the real kite.Client against a loopback fake (request shapes, auth header; a 403 clears the session and closes the gate);
  - route decoding and sendError mapping, the querystring parser, tick arithmetic, Stop/lifecycle, memory-only mode, and concurrent captures plus routes.
- Mutation checks, each restored and green afterwards:
  - `p.T <= t` changed to `<`: live-day and scheduler scenarios FAIL.
  - partial-merge rule loosened: frame-backfill and merge-rules FAIL.
  - a quote without a stamp treated as a holiday: live-day FAIL.
  - requeue precedence: this first survived, so I added a scenario where a flush fails while newer writes arrive. That mutation and the stale-precedence mutation now make write-behind FAIL.

(e) Left undone or needing a decision
- cmd/server wiring (above) and the STATUS.md update are yours.
- The purge of expired kv rows is not in this package (kv.Purge exists).
- Captures were ported without a skip-if-running guard, matching Node; decide whether to add one.
- indexspot.go duplicates indexSpot.ts; internal/core reportedly has its own copy, so these could be unified.

---

## calendar

STAGE calendar — final report

The calendar port is finished and every check passed. The Go routes match the original TypeScript on all 78 recorded Node steps. One PLAN decision rests on a wrong premise and needs your call (e1).

(a) Files (all new; src/, tests/, tasks/ and the shared packages are untouched; no zz_ files)
- internal/db/migrations/0002_calendar_trades.sql
  - `trades`: buy/sell as 6 columns; entry/exit/est_exit charges as `json`; status check; indexes on symbol, status and (opened_at desc, id desc).
  - `trade_log`: legs and charges as `json`; event/source checks; indexes on trade_id, symbol, at; no FK, so ledger rows outlive a deleted trade.
- internal/calendar:
  - calendar.go: types in Node key order, Deps, New, Mount, Stop.
  - charges.go: bestPrice, resolveLadder, toLegCharges, aggregateCharges, chargeTotals, unpricedLogLegs, reverseLegs, priceChargeGroups, serializeTrade.
  - store.go: the PostgreSQL store and the stored-charges decoder.
  - routes.go: the four handlers, sendError, requireAdmin, decoding of :id.
- Tests: golden_util_test.go, helpers_golden_test.go, routes_golden_test.go, routes_test.go, store_test.go.
- testdata: gen_calendar.mjs, helpers.golden.json, routes.golden.json.
  - The generator copies the original index.ts code verbatim by marker text into a temporary module (deleted after import).
  - Kite is a loopback fake driving a kite.ts copy.
  - Faked: the Express app, the Mongoose model, the hub, the broker manager and the clock.
- Scratch only (scratch/go-migration/tmp/calendar/): mongoose key-order probe files and the mongoose 8.24.4 sources extracted read-only from the npm cache.

(b) Wiring for cmd/server
`svc := calendar.New(calendar.Deps{...})`, mount with `server.New(opts, ..., svc.Mount)`. Call `svc.Stop()` after the HTTP server stops; it waits for ledger writes still running (30 s timeout each). There are no other goroutines or timers.
- Pool: the *db.Pool (nil means no DATABASE_URL).
- Sessions: the *auth.Sessions.
- RequireMarketData func(what) (bool, MarketDataRefusal): from the registry's active health. If data_ready, return true; otherwise return `calendar.NewMarketDataRefusal(what, activeBroker, problems)`, which builds Node's exact 401 text.
- Instruments func(ctx): the active broker's instrument provider load (getAllInstrumentsCached).
- Board func(all): deriveFnoBoard. calendar.BoardItem is an alias of captures.BoardItem, so core.DeriveFnoBoard can be passed directly.
- Hub: the *hub.Hub (called with a 5000 ms bound).
- Kite: the *kite.Client. Kite is used even when Dhan is active, as in Node.
- ClearKiteSession: kite.ClearSession() plus delete of the kite_session row (fire-and-forget).
- Now, NewID, Logf: leave nil in production.
- *auth.Sessions, *hub.Hub and *kite.Client are checked against the interfaces at compile time.

(c) Deviations from Node
1. The 503 text says "(set DATABASE_URL)." (PLAN decision).
2. A 12-character id answers 404 via db.CheckID (PLAN decision). Node actually answers 400; see e1.
3. GET /api/trades breaks opened_at ties by id, newest first. Mongo left ties unordered.
4. Legacy data only (none is created by this code):
   - Node's lean GET omitted fields a legacy document lacked; PostgreSQL has every column, so they read as null or the defaults.
   - A stored charges document read back gets Mongoose's hydration defaults for missing fields (0, "", source "kite", legs []). A null number reads as NaN and is written back as null.
5. Database error messages come from pgx, not Mongo. The close-versus-delete race keeps Mongoose's text: 500 `No document found for query "{ _id: new ObjectId('…') }" on model "Trade"`.
6. Routing (chi, not Express):
   - Case-insensitive paths and HEAD on GET routes are not reproduced.
   - A malformed escape such as "%A/" is rejected by net/http with its own 400.
   - An escape that is not UTF-8 (%FF) gets the Express-style 400 HTML before auth, with the same text the synthetic port uses.
7. No broker column. Neither ITrade nor ITradeLog has a broker field, so "broker nullable, read as zerodha" does not apply.
8. Kept from Node on purpose:
   - The trade role may take, close and delete trades.
   - The open check and the close are not atomic (races ported as-is).
   - Handlers keep running if the client disconnects mid-request, as Node did.
   - Ledger writes are best effort after the response; a failure is logged and the trade stands.
9. Key order: mongoose 8.24.4 reorders new documents to schema order. That is the TypeScript construction order for everything the API returns. trade_log legs are stored in schema order (side, token, tradingsymbol, exchange, expiry, …, raw).
   - Probe disclosure: besides reading the 8.24.4 source from the npm cache, I ran a probe that loaded mongoose 9.6.2 read-only from ~/Documents/Codex/.../Note-Sphere/node_modules. That is outside ~/Work; nothing there was changed.

(d) Checks run (all through scratch/go-migration/check.sh)
- `node --experimental-strip-types --no-warnings internal/calendar/testdata/gen_calendar.mjs`: 5 scenarios, 78 steps. A second run produced byte-identical goldens (checked with cmp).
- `gofmt -l internal/calendar`: no output.
- `go build ./internal/calendar/...` and `go vet ./internal/calendar/...`: ok.
- `REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 300s ./internal/calendar/...`: ok, 26 tests; `-count=3`: ok.
  - Helper goldens: 473 round2 values, 300 bestPrice, 250 toLegCharges, 120 aggregateCharges, plus chargeTotals, leg lists, serializeTrade, 42 priceChargeGroups and 8 resolveLadder cases.
  - Route replay, 78 steps on PostgreSQL with the real kite.Client. Each step compares the response bytes, every Kite request, the session afterwards, session clears, instrument loads, hub lookups, trade_log rows and warnings.
  - Store tests: round trip, json text kept, newest-first limit of 200, close and remove, ledger survives delete.
  - Route tests: decode error before auth, 12-character id, nil deps, a full open→close→delete cycle with the arithmetic written out, client disconnect, ledger failure.
- `REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s ./internal/db/`: ok.
- Mutation checks, each reverted and the package green again afterwards:
  - Leg total taken from Kite's own total: four tests failed (two helper goldens, the route replay, the cycle test).
  - Close ignoring the REST last-price fallback: the close_trades replay failed on the response, a Kite request and a ledger row.
  - entry_charges column as jsonb: TestStoreChargesAreStoredAsWrittenText failed.

(e) Needs a decision
1. The 12-character id. The pinned mongoose 8.24.4 delegates isValidObjectId to bson 6.10.4 ObjectId.isValid, which for strings only accepts exactly 24 hex characters (both read from the npm-cache tarballs). So Node answers 400 "Invalid trade id.", not 404. The 404 decision rests on a stale Mongoose doc comment.
   - I followed the decision through db.CheckID. Dropping the 12-character case there (a shared file I did not touch) would make calendar match Node, and synthetic too as far as it uses CheckID; my 12-character golden steps would follow automatically.
   - TestTwelveCharacterIDIsNotFound asserts the current 404 and would need flipping.
2. RequireMarketData and Instruments need the registry once it lands (small adapters in cmd/server).
3. The Mongo import tool must map:
   - trades: buy/sell subdocuments to the 6 columns, charges to json with `at` as ISO with milliseconds, `_id` hex to `id`.
   - trade_log: legs and charges to json.
4. STATUS.md: migration 0002 now exists.

---

## core

STAGE core: done. The new package internal/core builds, vets and is gofmt-clean, and every test passes with -race on the local PostgreSQL. Nothing outside internal/core was changed: no zz_ files, no migration, nothing under src/, tests/ or tasks/.

(a) Files
- internal/core/core.go: Deps, New, Mount, Dispose, SendError, RequireMarketData, AllInstruments, Board, RfPct, RestoreRfRate, and a FIFO background queue for persistence.
- board.go: DeriveFnoBoard, DeriveFnoStocks (FnoStock), IndexSpotMap, IndexSpotSymbol, IndexSpotCandidates, ResolveIndexSpotSymbol. BoardItem and BoardFuture are aliases of captures.BoardItem and captures.BoardFuture.
- kitesession.go: PGKiteSessions (kite_session table), ClearKiteSession, RestoreKiteSession (same-IST-day rule).
- routes_kite.go, routes_rf.go, routes_board.go, routes_history.go (includes SpreadSeries).
- jsreq.go: Express-exact request reading: node:querystring parsing with WHATWG UTF-8 decoding, decodeURIComponent of :symbol, String()/Number() of body fields, repeated headers joined with ", ".
- redirect.go: Express 5.2.1 res.redirect (encodeurl 2.0.0, escape-html, accepts 2.0.0 / negotiator 1.1.0 / content-type 2.1.0).
- Tests: golden_test.go, routes_test.go, kitesession_test.go.
- testdata/gen_core.mjs, core.golden.json (19 scenarios, 360 steps), express.golden.json (querystring, encodeurl, escape-html, Accept negotiation and param-decoding cases).
- The generator copies the index.ts line ranges verbatim (each range's first line is checked) into scratch/go-migration/tmp/core/core_routes.ts and runs them on real Express 5.2.1 over loopback HTTP.
- Express is not installed in this repo. The generator reads it from EXPRESS_NODE_MODULES (default /home/prakash/GAR/GAR_B/node_modules, read only) after checking that 9 package versions match package-lock.json exactly.
- scratch/go-migration/tmp/core/peek.mjs prints a summary of the golden.

(b) API for cmd/server
- c, err := core.New(core.Deps{...}). Kite and Sessions are required; everything else has a default.
  - Kite: the *kite.Client.
  - Sessions: the *auth.Sessions.
  - ActiveBroker: the registry's active broker id.
  - ActiveHealth: func() core.Health; map the registry health to {Authenticated, DataReady, TradingReady, Problems}.
  - FeedHealth: the registry's func() brokers.FeedHealth.
  - Generation: func() int64.
  - Instruments: func(ctx) ([]market.Instrument, error), i.e. the registry InstrumentProvider.Load(ctx, false).
  - InstrumentsWire (optional): func(ctx) ([]core.WireRow, error), built from LoadWire as core.WireRow{Instrument: w.Instrument, JSON: w}. It keeps the Dhan dhan_* fields in /api/instruments and /api/fno-stocks.
  - HistoricalOi / Historical: closures over the registry HistoryProvider with kite.Interactive priority.
  - DividendYields: captures.Service.DividendYields (signature matches).
  - SpreadSummary: captures.Service.SpreadSummary (signature matches).
  - Pool: the PostgreSQL pool, used for kite_session.
  - RfStore: the *store.Store.
  - OnKiteLogin: triggerPostLoginBackfill (captures PostLogin plus analytics). It must return quickly.
  - OnKiteLogout and OnKiteSessionCleared: optional hooks.
  - FrontendURL, InternalTokenSecret, TokenRouteSecret: from config.Config.
  - Now, Sleep, Logf: nil gives the defaults.
  - Location: nil means time.Local. Run with the TZ the Node service used, because the history routes do local-time Date arithmetic.
- Routes: pass c.Mount to server.New. Each token route gets its own 30-per-minute limiter, applied before the passcode check.
- Boot, after the DB is up:
  - Call c.RestoreKiteSession(ctx) before the broker restore and the schedulers.
  - Call c.RestoreRfRate(ctx) after the admin-session restore.
- Shutdown: c.Dispose() ends in-flight route work and drains queued writes.
- Hub "token rejected" callback: call c.ClearKiteSession(), then the feed-lost handling.
- Exports for other packages:
  - c.Board is captures.Deps.GetBoard as is. Synthetic needs {Symbol, Name, IsIndex} mapped; Fair Value needs {Symbol, Name, SpotToken as float64, IsIndex} mapped.
  - c.AllInstruments.
  - c.RfPct matches synthetic.Deps.GetRfPct.
  - c.SendError for the market-data quotes route.
  - c.RequireMarketData for calendar trades ("Taking a trade" / "Closing a trade").
  - core.DeriveFnoBoard, and IndexSpotMap / ResolveIndexSpotSymbol for the broker routes and the option chain.

(c) Deviations from Node
- /api/dividends lists yields in board order. Node used Yahoo completion order, which varies between runs.
- spread-stats with no database answers 500 {"error":"database is not configured (set DATABASE_URL)"} at once. Mongoose buffered for 10 s and then sent its own message. `__v` is omitted, per PLAN.
- Route work (token exchange, history fetches, Yahoo) does not stop when the client disconnects. This matches Node, and matters because a request_token can be used only once. The work does stop on Dispose, and a dividend fetch cut short there is not cached.
- Kite session and rf writes run on one FIFO queue, so they apply in request order; failures are only logged, as in Node. user_id and user_name are stored as strings ("" when Kite omitted them); they are only used in a log line.
- A Kite reply without access_token gives access_token "" in /api/internal/kite-token. Node omitted the key.
- Non-ASCII upper/lower casing follows Go rather than JavaScript's special casing (for example "ß"). This only changes 404 texts and searches on non-ASCII input.
- Prototype names such as "constructor" are not treated as index underlyings. In Node the INDEX_SPOT_MAP lookup was truthy for them.
- Repeated passcode headers are joined with ", " as Node does, so they fail. auth.ReadPasscode, which these routes do not use, takes the first value instead; the Dhan token route should probably match Node here.
- Inherited from shared packages, not changed by me:
  - No X-Powered-By header.
  - Routing is case-sensitive.
  - HEAD returns 404 instead of running the GET handler.
  - A trailing slash after an encoded "/" returns 404.
  - The 400 page for malformed JSON uses encoding/json's wording, so the golden test compares status and content type only for those steps.
  - A body number beyond the float64 range (1e400) gets the 400 HTML page; Node answered "Provide a numeric rf".

(d) Checks (all from the repo root, all passed)
- `scratch/go-migration/check.sh node --experimental-strip-types internal/core/testdata/gen_core.mjs`: "core.golden.json: 19 scenarios, 360 steps; express.golden.json written".
- `scratch/go-migration/check.sh gofmt -l internal/core`: no output.
- `scratch/go-migration/check.sh go build ./internal/core/...` and `go vet ./internal/core/...`: ok.
- `REQUIRE_DB_TESTS=1 scratch/go-migration/check.sh go test -race -count=1 -timeout 180s ./internal/core/...`: ok, 17 tests. These include the golden replay through server.New, the Express helper goldens and 4 PostgreSQL tests: kite_session round trip, login persisted then restored on the same IST day and dropped and deleted at 00:00 IST, logout and Kite 403 deleting the row, and rf persisted across a restart. The PostgreSQL tests use a real kite.Client against a loopback fake Kite. Also ok with `-count=3`.
- Mutation check: I made /api/history read its cache before the market-data check. TestRoutesGolden/history_routes step 17 failed (200 instead of 401), and so did TestHistoryRoutesCheckMarketDataBeforeTheCache. After reverting, the tests are green again.

(e) Open items
- Regenerating the goldens needs the local Express stack above (or EXPRESS_NODE_MODULES pointed at an identical install).
- cmd/server wiring is not written; it is yours.
- Decision for you: should auth.ReadPasscode join repeated headers the way Node does?
- The todo_list tool is shared between the parallel agents; it showed the calendar, registry and marketdata agents' tasks. Don't rely on it for per-stage state.

---

## synthetic (FAILED)

_No output — stage did not complete successfully._

---

## captures (FAILED)

_No output — stage did not complete successfully._