# Stage reports, 2026-10-29 (synthetic resume, captures resume, server)

Condensed from the three final reports. Wiring now lives in code (`internal/app`), so this file keeps the
deviations, checks and open items in full and the wiring only in outline. The lead re-ran the module checks
afterwards (STATUS.md "Checks").

## synthetic (resume of the stage cut off on 2026-10-28)

Files (all in `internal/synthetic/`): `engine.go` rewritten on `runtime.go` (one mutex, never held across I/O, awaits,
sleeps or yields; the part of each async TS function before its first await runs inside the caller's critical section;
SetTokens calls and background work are queued under the lock and run in order after it is released; settings queue,
Promise.all that returns at the first failure, single-flight refresh, `WaitIdle`). `runtime.go` finished (spawn, await/fire,
yield, sleep, every; `spawnNext` removed). `views.go` (publish timer through `rt.every`, SSE frames encoded with jsjson),
`routes.go` (path params decoded before limiter and auth, only the 5 async handlers turn panics into JSON 500, `fail()`
text as Node, the stream writes queued frames before ending), `jsfmt.go` (jsjson encoding, `jsx.LocaleCompare`, en-IN
formatting of NaN/±Inf). New tests: `sim_test.go` (deterministic event-loop scheduler), `engine_golden_test.go`,
`routes_test.go`, `concurrency_test.go`. `gen_engine.mjs` gained 10 scenarios; `engine_golden.json` 14 scenarios /
430 steps (the 4 original scenarios are byte-identical to the 2026-10-28 file). math.go, config.go, trade.go,
repository.go and store.go unchanged.

Go bugs found by the review and fixed (each now matches Node): Promise.all waited for both answers after a failure; SSE
frames used encoding/json, so a NaN dropped the frame; the stream could lose its last snapshot on Dispose; `%FF` in a
path was not rejected and params were decoded after the limiter and auth; synchronous handlers' panics became JSON 500
instead of Express's HTML 500; `fail()` replaced an empty error message.

Deviations from Node:
1. SetTokens and background work run right after the critical section, outside the lock, instead of inside it. A
   SetTokens can deliver queued lane ticks on the same goroutine, which deadlocked under the lock (test below). The
   golden shows the dependency-call order is Node's.
2. SSE: a stream more than 128 frames behind is dropped (Node buffered without bound); a failed write ends the stream.
3. chi routing: no implicit HEAD, case-sensitive paths.
4. Each store call has a 30 s deadline; REST and margin calls rely on the providers' own timeouts.
5. Log lines print the error message where Node printed the Error object (logs are not compared).
6. `ReloadUniverse(ctx)` ignores ctx; the reload runs to completion as in Node.

Checks: `node internal/synthetic/testdata/gen_engine.mjs` → 14 scenarios, 430 steps, rerun byte-identical.
`TestEngineGolden`: all 430 steps (524 dependency calls, 257 settled results incl. 142 HTTP responses compared as bytes,
29 SSE frames, status/open positions/opportunity digest per step). Covered: entries after confirmations, re-entry
cooldown, exits PROFIT_CAPTURE / EDGE_CONVERGED / EXPIRY_SAFETY / EXPIRED / MANUAL, every manual-close refusal and delete
path (en-IN amounts ₹12,34,568, ₹-98,765, ₹-0), settings validation/save failure/rollback, strike-level change with open
positions, SYNTH_SHARE_BOX_BUDGET on and off, margin retries/backfill/per-leg fallback/NaN total, restart re-link on
Dhan, switch staleness, superseded refresh, unlinked position, epoch change mid-insert, single-flight start, closing bell,
midnight roll, store failures, the 429 limiter. Route tests from reading routes.ts (no golden): roles, bad path parameter
before auth, async 500s, stream headers/frames/ping/dispose, stream token rules, stalled stream dropped.
`TestSetTokensMayCallBackIntoTheEngine` and `TestConcurrentUseWithReentrantDependencies` (production runtime, 0 races).
Mutations caught: SetTokens under the lock (deadlock), SYNTH_SHARE_BOX_BUDGET ignored, expiry safety waiting for
confirmations, delete limiter after auth, Promise.all waiting for both answers.
Open: the golden runs on the test scheduler; the production runtime is covered by the route, callback and stress tests.

## captures (resume)

Files: `hourly.go`, `eod.go` (each drain clears its "draining" flag in the same locked step that sees the queue empty;
before, a row queued in that gap waited for the next capture; the hourly backfill reads `HasSession` before taking its
lock; nothing is logged when Stop cancels a run), `captures.go` (Stop waits for scheduler loops and background runs
separately; PostLogin is a no-op after Stop), new `service_test.go` (10 tests), `gen_parity.mjs` (+3 scenarios:
scheduler slot still marked after a Kite or write failure, weekend EXTRA_SESSION_DAYS ignored, spread_daily write
failure; 51 scenarios, the earlier 48 unchanged). `0005_captures.sql` reviewed, unchanged.

Deviations from Node:
1. One database: archive and current stock_futures share one table with a `source` column, so the "Archive DB is not
   connected" warning cannot occur; DATABASE_URL enables hourly and EOD work together.
2. Without a database, calls fail at once with ErrNoDatabase (Mongoose waited 10 s first); same log lines; hourly rows
   stay queued as in Node.
3. Scheduler ticks never overlap; one late tick runs right after a long run. Identical results when runs finish within
   60 s. Otherwise a 15:45 capture still running after 16:02 means no 16:00 summary that day.
4. spread_daily drains run one at a time (Node could write a row twice and drop the next).
5. The summary rewrite and the delete of inactive symbols run in one transaction (Node's bulkWrite could half-apply).
6. Stop cancels and waits; queued rows are dropped as on Node exit; the cancellation is not logged.
7. Logs: same text up to the error; errors print as `err.Error()`; all lines go to stderr; startup lines may reorder.
8. spread-stats: `_id` plus the stored fields in schema order, no `__v` (PLAN decision).
9. Yahoo: the result is a map (core lists board order); no keep-alive; honours HTTPS_PROXY.
10. Kept from Node: NaN numbers and invalid dates fail the write like a Mongoose CastError;
    HOURLY_BACKFILL_LOOKBACK_DAYS=Infinity blocks the backfill as "already running"; with Dhan active the captures call
    Kite with Dhan's board; no holiday calendar.

Checks: `node internal/captures/testdata/gen_parity.mjs` → 51 scenarios, 529 candle stamps, 52 Yahoo cases; helpers,
jsutil, summary and yahoo.json byte-identical to the saved copies; second rerun byte-identical. `REQUIRE_DB_TESTS=1 go test
-race -count=1 -timeout 300s ./internal/captures/...` → 33 tests ok; service tests ok with `-count=5`. New tests:
StartHourly/StartEOD act once, ticks never overlap, PostLogin's hourly and EOD halves through the real kite.Client against
a loopback fake Kite (request lines, auth headers, PostgreSQL rows, the exact spread-stats body), Stop during a backfill
and during a drain (no goroutines left, no writes after), Stop waits for a run in flight, an interactive history request
jumps queued capture requests, the drain-flag fix (deterministic hook test). Mutations caught: old drain-flag reset,
PostLogin without its EOD half, Stop not waiting, interactive priority in the hourly backfill (13 golden scenarios fail).
Open: the import tool must map the two Mongo stock_futures databases to `source` archive/current, insert rows in Mongo's
natural order and map `spread_summary._id` to `id`. The shared historical gate has no unit test in `internal/kite`
(the captures gate test covers its priority path only).

## server (`cmd/server`, `internal/app`)

Files: `cmd/server/main.go`; `internal/app/{app.go, adapters.go, lifecycle.go, dotenv.go}`; tests `harness_test.go,
routes_test.go, boot_test.go, smoke_test.go, switch_test.go, tokenrejected_test.go, adapters_test.go, dotenv_test.go`;
`testdata/gen_dotenv.mjs` + `dotenv.golden.json` (26 parse and 17 config cases from the real dotenv 17.4.2, extracted
read-only from the npm cache to `scratch/go-migration/tmp/server/dotenv-17.4.2/`, which the generator needs). No other
package changed. Scratch: `scratch/go-migration/tmp/server/e2e.sh` (real binary, clean env, `.env` only, dead proxies).

Wiring (in `app.New`): Kite client, pool + migrations (memory-only when DATABASE_URL is unset or cannot be opened or
migrated), kv cache, store, auth sessions, hub, registry, market-data session store, core, analytics, calendar, captures,
Synthetic (IdleBoxLane), Fair Value. Hub "token rejected" → `core.ClearKiteSession` then `synth.Stop`. Fair Value:
`SetAnalyticsYield`, hub tick and connection listeners (the NoteTick comment sits there). `reg.Attach`: StopScanner =
synth.Stop; DropMarketDataSessions = DropAll; InvalidateBooks = Synthetic then Fair Value InvalidateNamespace;
ReloadUniverse = synth.ReloadUniverse (logs "[Synthetic] universe reload after broker switch failed" and returns nil);
OnBoxLaneTicks = synth.OnTicks; OnBoxLaneConnection = synth.InvalidateBooks; OnSessionLost = synth.Stop.
`core.OnKiteLogin` = captures.PostLogin then analytics.OnKiteLogin. http.Server: no WriteTimeout, ReadHeaderTimeout 60 s,
IdleTimeout 5 s, MaxHeaderBytes 16 KiB (Node 22 defaults). Listens on `:PORT` (default 3001).

Boot (`Start`): sweeper → StartEOD → purge job (kv.Purge and expired admin_sessions at boot, then every 10 minutes) →
RestoreKiteSession → reg.Restore → reg.StartActiveRuntime → admin-session restore → RestoreRfRate → StartHourly →
analytics.Boot (warm load, flush retry, option-OI capture) → `go synth.Boot`, `go fv.Boot`.
Shutdown (under SHUTDOWN_TIMEOUT_MS, default 12 s, after cancelling the boot chain and waiting up to 5 s): Synthetic
scanner → Fair Value workers → HTTP (3 s grace, then Close) → capture/flush schedulers (captures, analytics, sweeper,
purge) → broker feeds → analytics cache flush (new) → background database writes (new: Synthetic WaitIdle,
core.Dispose, calendar.Stop) → close PostgreSQL. SIGINT/SIGTERM → exit 0, or 1 on timeout.

Deviations from Node:
1. StartEOD runs before the session restore. In Node the EOD block ran when the nse_fno connections were up, in
   parallel with the session-restore chain, so the startup stock-futures backfill skipped whenever it beat the restore.
   (The lead checked: the nse_fno connections start connecting at module load, `src/db.ts:20-31`, while the restore needs
   the main connection, opened in the listen callback, plus one query, so skipping was the likely outcome.)
2. The database is opened before listening (up to 30 s open + 10 s ping when unreachable; Node listened at once).
3. Shutdown: the two Box steps are gone; steps "flush analytics cache" and "finish background database writes" are new;
   "close MongoDB connections" is "close PostgreSQL connections"; Go-only waits for the boot chain (5 s) and up to 2 s
   for handlers whose connections the HTTP step closed.
4. The purge also deletes expired admin_sessions rows (the auth package and `0001_core.sql` expect this janitor).
5. The sweeper, analytics and captures are stopped in step 4 (Node only cleared its tracked intervals).
6. SHUTDOWN_TIMEOUT_MS blank, invalid or ≤ 0 means 12 s (Node timed out at once for "0" or "").
7. No 300 s whole-request timeout (a Go ReadTimeout would cancel SSE streams).
8. dotenv port: file path, override ("false" still overrides, as in dotenv), encoding, quiet/debug, `dotenv_config_*`
   arguments. Not ported: encrypted `.env.vault` (startup is refused if DOTENV_KEY is set and a vault exists), encodings
   other than utf8/latin1; a run of invalid UTF-8 bytes becomes one U+FFFD (Node: one per byte).
9. An unrecovered panic exits with code 2 (Node's uncaughtException: 1).

Checks: `node internal/app/testdata/gen_dotenv.mjs` → 26 + 17 cases. `REQUIRE_DB_TESTS=1 go test -race -count=1
-timeout 300s ./internal/app/` → 16 tests ok; `-count=3` ok. Covered: route inventory parsed from api.md (83/83 non-Box
served, 26 Box rows absent, no extra routes, `/api/box/*` gives the HTML 404); shutdown step names against index.ts; boot
and shutdown with and without a database, before Start and during boot (trace, restored admin session, rf and
generation, stale kite_session deleted, purge, Start and Shutdown within 5 s, goroutines back to baseline +3); smoke
requests with exact bodies (GET /, /api/status key order, 404 page, PATCH preflight, POST /api/trades 401, broker status
equal to the registry's Node golden, market-data status, stream session + SSE headers and first frame, Synthetic status
with token budget 2950, Fair Value status as full admin, option-chain 401); broker switch (hook order, active_broker
generation 5 → 6, Synthetic stopped, old session 404, Fair Value feed generation +2, hub socket closed); Kite token
rejected (kite_error frame, session cleared in memory and table, Synthetic stopped); an open SSE stream is closed after
the 3 s grace. Mutations caught: Fair Value invalidation dropped from the switch hook, HTTP step before Synthetic, EOD
after the hourly scheduler, dotenv override parsed as boolean, token-rejected path without synth.Stop, purge skipping kv.
Open: NoteTick decision; `go.mod` still requires the unused `github.com/joho/godotenv` (drop with `go mod tidy` when
online); the Dhan OnSessionLost and box-lane hooks are one-line wirings tested by the registry goldens, not end to end.
