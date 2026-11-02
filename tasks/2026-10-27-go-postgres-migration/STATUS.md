# Status: Cal_Spread backend Node → Go, MongoDB/Redis → PostgreSQL (Box removed)
State: Done
Updated: 2026-11-02
Next action: None. Migration, deep review, local verification and both main publications are complete; local startup instructions are in README.md.
Blockers: none
WIP override: none
Task: `2026-10-27-go-postgres-migration` · Project: Cal_Spread_Backend · Plan: [PLAN.md](PLAN.md)

## Current milestone
The Go service is implemented: `cmd/server` plus 30 tested internal packages, including frozen-reference validation.
The real-process `cmd/server` tests are now a 31st tested package; `cmd/verifyfixture` is verification-only.
All 83 non-Box routes are served; `/api/box/*` is gone. The retained-suite audit is complete.
The full required PostgreSQL/race suite and standalone build passed before Node retirement.
Frontend Box removal and build/37 unit tests also passed. Fresh local PostgreSQL setup and Go CI are implemented.
Node/tooling retirement, standalone-process verification and real-Go browser workflows are complete.
Final deep review, local checks and both approved main publications are complete; both feature CI runs succeeded.
No data import or EC2 deployment is required.

## Publication receipt — 2026-11-02

- Backend runtime: [`0217698`](https://github.com/Prakash2571/Cal_Spread_Backend/commit/0217698f48db179d686a28dff052d666d830968c),
  with source/fixture checkpoint `8de7ca5` preserved in its history; pushed to `origin/main`.
- Frontend: [`08f4707`](https://github.com/Prakash2571/Cal_Spread/commit/08f47070d0c7f93ecf72d406a4046bb9356f3823),
  pushed to `origin/main` after the backend.
- Backend [CI 41418473148](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41418473148): **success**;
  required PostgreSQL/race build/vet/format checks, module tidy consistency and binary artifact passed.
- Frontend [CI 41418509911](https://github.com/Prakash2571/Cal_Spread/actions/runs/41418509911): **success**;
  locked frontend build/unit tests and real-Go HTTP/PostgreSQL integration passed against the published backend main.
- `git push origin main` exited 0 in both repositories; both then matched origin/main with clean worktrees.
  Final handoff/receipt commits change documentation only; runtime fingerprints remain the verified commits above.

## Resumed and completed on 2026-11-02
- Final post-retirement check passed with read-only module files: build/vet/format/module verification, all 31
  tested packages with race detector/required PostgreSQL and standalone binary build. Public `make db-start`
  repeated without resetting data and `make db-status` verified the repository-owned loopback cluster.
  Deliverable summary: `outputs/2026-11-02-go-postgres-migration.md`; publication/CI receipts are recorded above.
- Final transport review added standalone behavioral checks for historical priority/FIFO/pacing, watchdog ownership
  and queued cancellation; Dhan transient/read retry caps, Retry-After ceiling, per-attempt deadline, cancelled
  backoff and request-start pacing. Ten repeated race-enabled runs passed without changing those implementations.
- Paired frontend integration is verified: 37 unit tests/build, six real-Go HTTP groups and 12 Firefox 157.0
  workflow groups. Actual admin form, board/Calendar/Broker/Synthetic and Fair Value workflows pass against Go/PG;
  390px mobile containment, JSON download, private-data revocation and zero public/trade valuation requests verified.
  Frontend local/auth docs and paired Go/PostgreSQL CI updated; returned to this backend's final-review stage.
- Standalone Go process checks now verify clean-environment dotenv startup, memory-only/full/trade auth behavior,
  SIGINT/SIGTERM exit, all 18 PostgreSQL tables/five migrations and admin/risk-free-rate restoration across restart.
  Deeper review reproduced a pending admin-session write lost at shutdown (closed pool). Session persistence is now
  owned/drained after HTTP handlers and before PostgreSQL close; the deterministic regression passes.
  `cmd/verifyfixture` builds/vets with race support: actual App/Chi/PostgreSQL, loopback-only generated broker prices,
  real authorization and isolated disposable test schema. Frontend-stage runtime verification follows.
- Reference checkpoint committed/published on main as `8de7ca5`. The Node backend, package/lock/tsconfig,
  Node/PM2 deploy script, original Node tests, source-dependent generators/checker and Box-only docs are now retired.
  All 39 retained JSON fixtures are byte-identical to that checkpoint and SHA-256-pinned; Go checks cover fixture
  integrity and Fair Value documentation as well as all original retained cases. Post-retirement full checks passed.
- 2026-11-02 final-continuation milestone: fresh repository-owned PostgreSQL started on 55472 with empty `calspread`
  and separate `calspread_test`. `scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && scratch/go-migration/check.sh make build` passed: build/vet/format/module verification and all 30 tested packages with race/required PostgreSQL checks; standalone `outputs/calspread` built and ignored by Git.
- `go mod tidy` and `go mod verify` succeeded after the approved workspace-local pinned dependency fetch; unused
  godotenv and copied MongoDB/other unrelated checksums were removed. Frozen original suite/route/shutdown contracts
  are in `internal/parity/testdata`; Go checks now require those fixtures rather than skipping retired source reads.
- The futures-only feed-health regression failed before the app liveness listener was restored, then passed with
  the complete app/worker/parity/rate-card suites. Current code reports valid Zerodha futures ticks as LIVE even when
  no analytics scanner runs.
- Verified reference checkpoint `8de7ca5` preserves Kiro's Go golden-generation tooling in Git before retirement.
  Both final migration commits are now published with successful CI, as recorded above.
- Final-continuation approval: user permitted fetching missing pinned Go dependencies into workspace-local caches to
  complete `go mod tidy`; no global installation/system changes. The initial offline tidy attempt failed because
  pgx's testify test dependency was not cached; this was a tooling/dependency check failure, not an application test failure.
- Deep review found a real stale worker-timeout race. The new deterministic regression failed on the inherited code
  (a first job's delayed timeout retired a reused slot's fresh job), then passed with captured job identity guarding
  the deadline. Twenty repeated race-enabled worker tests passed after the fix.
- Continued the existing migration at the user's request, including Kiro's 25 later test-port files that were missing
  from the previous handoff. [Full case-by-case audit](reports/2026-11-02-kept-suite-audit.md): 32 suites / 332 cases
  (42 Fair Value + 290 shared), 250 already covered, 78 completed/strengthened here, 4 explicitly N/A. No applicable
  MISSING or PARTIAL case remains. `reports/check-suite-coverage.mjs` validates original titles/counts and Go references.
- Added nine test files for the remaining structured quote-cache value, 2000-token/session lifecycle, Dhan provider
  isolation, exact toTick books, four-leg margin requests, static-IP verification, history ranges/columns, board joins
  and shutdown failure modes. Tightened inherited Fair Value/rate-card assertions to keep Node's strict comparisons
  and reject NaN where Node did.
- Fixed a test-only synchronization bug in `internal/marketdata/routes_golden_test.go`: its `interval` event was visible
  before the pinger channel was registered, allowing the replay to select nil or a previous stream's ticker. Registering
  first preserves the original golden expectations. The affected replay passed 100 consecutive `-race` runs.
- Final build, vet, formatting, full-module race/DB tests and audit-reference checks passed. Node source/tests remain
  the unchanged reference. The application runtime was not rewritten during this continuation.
- The retained test PostgreSQL cluster is running at `127.0.0.1:55471`; data/log/socket remain in
  `scratch/go-migration/`. No new dependencies were installed. Suggested checkpoint: `go-migration: complete kept-suite parity audit`.

## Stages (full reports: [2026-10-28](reports/2026-10-28-stage-reports.md), [2026-10-29](reports/2026-10-29-stage-reports.md))
| Stage | Package | Evidence (all green with -race on PostgreSQL) |
|---|---|---|
| registry | `internal/brokers/registry` (+ `dhan/zz_registry.go`, fix in `dhan/feed.go`) | helpers golden 143 cases, routes golden 9 scenarios / 249 steps, Dhan margin golden 55, Dhan feed lifecycle golden 85 steps, deadlock regression test, 4 mutations caught |
| mdroutes | `internal/marketdata` routes + SSE | golden 12 scenarios / 470 steps from the original `marketDataRoutes.ts`, 14 focused tests, 2 mutations caught |
| analytics | `internal/analytics` (OI chain, frames, kv write-behind) | golden 3,281 pure cases + 19 scenarios / 680 steps, PostgreSQL round trip with TTLs, 5 mutations caught |
| calendar | `internal/calendar` + `0002_calendar_trades.sql` | helper goldens (≈1,200 cases), routes golden 5 scenarios / 78 steps with the real kite.Client, 3 mutations caught |
| core | `internal/core` (root routes of index.ts, Kite session, rf, board, history) | golden 19 scenarios / 360 steps on real Express 5.2.1, Express helper goldens, 4 PostgreSQL tests, 1 mutation caught |
| synthetic (resumed 2026-10-29) | `internal/synthetic` engine + routes | engine golden 14 scenarios / 430 steps (524 dependency calls, 142 HTTP responses as bytes, 29 SSE frames), route tests, re-entrant dependency and stress tests, 5 mutations caught; 6 Go bugs fixed |
| captures (resumed 2026-10-29) | `internal/captures` | golden 51 scenarios, 529 candle stamps, 52 Yahoo cases; 33 tests incl. PostLogin through a loopback fake Kite and Stop mid-run; 4 mutations caught; 3 Go bugs fixed |
| server (2026-10-29) | `cmd/server`, `internal/app` | 16 tests: route inventory 83/83 (Box absent), boot/shutdown order with and without a database, smoke requests with exact bodies, broker switch hooks, Kite token rejected, dotenv golden (43 cases); 6 mutations caught; e2e of the real binary |
The 2026-10-28 run cut off synthetic and captures (the Kiro session received SIGTERM at 19:49:24); both were resumed
from their on-disk state on 2026-10-29.

## How to run the Go service locally
Use the current README: `make db-start`, copy `.env.example` to `.env` and fill the server credentials, then
`make build` and `./outputs/calspread`. Local PostgreSQL is 127.0.0.1:55472; HTTP example is 127.0.0.1:3001.
Kite app key/secret remain required by the startup contract. Use Asia/Kolkata for local-date compatibility.
`make check` requires the separate test database; `cmd/server/main_test.go` replaces the historical scratch
process smoke script. Real-Go HTTP/browser commands are in the paired frontend README.

## Decisions taken (Node's real behaviour, checked)
- 2026-10-29 Ids: a 12-character id is **400** ("Invalid trade id."), not 404. The pinned mongoose 8.24.4 calls bson
  6.10.4 `ObjectId.isValid`, which accepts exactly 24 hex characters (ran from the npm-cache tarball: `"aaaaaaaaaaaa"` →
  false). `db.CheckID` lost `IDNeverExists`; calendar matches its Node golden without an override.
- 2026-10-29 Token-route passcodes: a repeated `x-token-passcode` header is joined with ", " (Node 22's HTTP parser;
  probe `scratch/go-migration/tmp/dup_header_probe.mjs`), so it fails as in Node. `auth.ReadPasscode` joins.
- 2026-10-30 EOD start at boot: `StartEOD` runs before the session restore. In Node the EOD block ran once the nse_fno
  connections were up (they start connecting at module load, `src/db.ts:20-31`), in parallel with the restore chain
  (which first opens the main connection in the listen callback, then queries `kite_session`), and
  `backfillStockFutures` checks `kite.hasSession()` first (`src/eodCapture.ts:270`). So the startup stock-futures
  backfill most likely skipped in Node too; the next Zerodha login runs it (PostLogin).

## Resolved scope and historical questions
Resolved 2026-11-02: remove frontend Box; no data import (fresh local PostgreSQL); local setup only, user handles EC2;
finish/deep-review the migration and push both repositories to main. No user decision is outstanding.
Futures liveness is fixed and regression-tested. EOD boot ordering stays compatible with the original service.
The numbered questions below record the earlier handoff, not current blockers.

1. Zerodha feed health: in Node only Box's hub listener noted futures-lane ticks, so with Box idle the Zerodha feed shows
   CONNECTING ("waiting for the first tick") unless Synthetic's lane ticks. Go copies that; one line in `internal/app`
   (marked by a comment) would show LIVE instead.
2. Frontend Box page and tab (`../Cal_Spread`): keep (they get 404s) or remove. Needed before the frontend build/tests
   against Go. The frontend calls 20 Box paths (`api.ts:1817-2614`, `Box.tsx`).
3. Existing MongoDB data: import into PostgreSQL? If yes: which collections, and as `mongoexport` JSON or `mongodump`?
   The stage reports list the mappings (trades buy/sell → 6 columns, charges as json with ISO `at`; stock_futures archive
   and current databases → `source`; `spread_summary._id` → `id`; natural order). Caches are not imported (PLAN).
4. Deployment: `deploy.sh` builds and restarts Node under PM2 on EC2. How should the Go binary and PostgreSQL run there
   (PostgreSQL on the same host? systemd or PM2?), and should CI get a Go job with a PostgreSQL service?
5. Removing the Node backend after 2-4 (approved earlier). The golden generators import `src/`, so goldens can only be
   regenerated while `src/` exists (Git history keeps it).
6. Optional: move `StartEOD` after the session restore so a same-day restart backfills stock futures at boot (a small
   change from Node's likely behaviour; one line in `internal/app/lifecycle.go`).

## Deviations from Node (intended or unavoidable; details per stage in the reports)
- Storage: PostgreSQL only (`DATABASE_URL` replaces the 8 Mongo/Upstash variables); gate and 503 texts name
  `DATABASE_URL`; kv cache rows expire through a purge job (boot + every 10 minutes) instead of Redis TTLs; the analytics
  cache gets a final flush at shutdown; one `stock_futures` table with `source` archive|current.
- HTTP: chi routing is case-sensitive and has no implicit HEAD; a malformed `%` escape gets net/http's 400; a body number
  beyond float64 (1e400) gets the HTML 400 page; `POST /api/quotes` rejects integer tokens above 2^53−1 (real tokens <
  2^34); GET `?tokens=` drops integers ≥ 2^63; `/api/dividends` lists yields in board order.
- Concurrency: one mutex per component, never held across I/O; switch, Dhan login and logout run one at a time; Dhan feed
  wire operations are queued per feed; Synthetic runs SetTokens right after its critical section; EOD/hourly ticks never
  overlap; spread_daily drains are serialised; the summary rewrite is one transaction.
- SSE: a slow client is dropped (hub queue 1024 frames, Synthetic 128 frames, Fair Value 10 s write) where Node buffered
  without bound; a ping can overtake a queued tick frame.
- Lifecycle: the database opens before listening (up to 30 s + 10 s ping when unreachable); Box shutdown steps removed,
  two steps added (analytics flush, background writes); `SHUTDOWN_TIMEOUT_MS` invalid/≤0 → 12 s; no 300 s request
  timeout (it would cut SSE); an unrecovered panic exits 2 (Node 1); `.env.vault` is not supported.
- Box removed: switch blockers report only `broker_not_configured` (409 text kept); no order placement code anywhere.

## Verified (build + vet + `-race` tests green, DB tests on a real local PostgreSQL)
Every package: `config`, `jsx`, `db` (+ migrations 0001-0005), `dbtest`, `kv`, `store`, `httpx`, `auth`, `brokers`,
`brokers/registry`, `brokers/dhan`, `lifecycle`, `server`, `ratecard`, `boundedcache`, `quotes`, `market`, `marketdata`,
`kite`, `kite/ticker`, `hub`, `analytics`, `calendar`, `captures`, `core`, `synthetic`, all of `fairvalue`, `app`, and
`cmd/server` (e2e). Details of the earlier packages:
- `jsx` `LocaleCompare`: ICU-root collation checked against Node on 41,600 pairs. `brokers`: 60 + 1440 Node cases.
  `ratecard`: 707 Node cases + `charges.json`.
- `fairvalue/jsmath`: exp, log, pow (incl. `x**3`) and hypot bit-identical to V8 over 200,000 inputs each.
- `fairvalue/jsjson`: JSON.stringify/JSON.parse semantics (`Parse` = the `kite/jsjson` parser with V8 error texts).
- `fairvalue/model`: every pure module of `src/fairValue/`. `testdata/gen_model.mjs` runs the ORIGINAL TypeScript and writes
  `model_golden.json` (5.7 MB); `golden_test.go` (14 tests) compares numbers bit for bit and results as exact JSON bytes.
  `suites_test.go` ports the pure cases of pricing, svi, market, maturity, independent, pipeline and hardening (32 tests incl.
  goldens); `fvtest/fixtures.go` is checked byte-identical to `tests/fairValue/fixtures.mjs` output.
- `fairvalue` service: `history.go`, `store.go` + `0003_fair_value.sql` (`json` columns), `workers.go`, `engine.go`,
  `routes.go` (`/api/fair-value/*`, SSE), `module.go`. Tests port auth.test.mjs, service.test.mjs, the engine/worker cases of
  pipeline.test.mjs and hardening.test.mjs, storage.test.mjs, plus PostgreSQL cases Node never had.
- Kite, hub and Dhan market data against goldens from the original TypeScript: `kite` client (94 cases), instruments CSV
  (97), ticker messages (13) and socket events, lane feed (10 scenarios, 130 steps); `hub` (10 scenarios, 149 steps) plus SSE
  wire format and slow-peer tests; `brokers/dhan` decoder (786 frames, 21,452 packets), `toTick` (51), frame merge (10
  streams), helpers (617), scrip master (48 masters), feed lifecycle (85 steps), margin (55).

## Verification scope notes
- The shared Kite historical gate now has dedicated priority/FIFO/pacing, watchdog-ownership and cancellation tests.
- Dhan REST retry/deadline/pacing now has dedicated loopback behavioral tests. Original goldens keep their unchanged
  `DHAN_MAX_READ_ATTEMPTS=1`, `DHAN_MIN_INTERVAL_MS=0` setup; the additional operational tests cover production policy.
- The Synthetic golden runs on a deterministic test scheduler; the production runtime is covered by route, callback and
  stress tests.
- The Dhan `OnSessionLost` and box-lane hooks in `internal/app` are tested by the registry goldens, not end to end.
- The kept Node-suite audit is now complete; the remaining entries above are Go/source-level gaps outside those suites.

## Fair Value deviations from Node (intended or unavoidable; keep in the final report)
- Store: PostgreSQL instead of Mongo. Expired rows are deleted on each append (Mongo's TTL monitor did it in the background);
  reads filter `expires_at` by the application clock as Node did. Memory-only error text names PostgreSQL.
- A fractional history `limit` is floored for the database read (Node passed it to Mongo's `limit`).
- Express case-insensitive and HEAD routing under `/api/fair-value` is not replicated (chi is case-sensitive).
- SSE: a write that cannot finish within 10 s (`StreamWriteTimeout`) closes the stream, instead of Node's 256,000-byte
  unsent-buffer check.
- Workers are goroutines, not worker threads: no 96 MB heap cap; a timed-out job's goroutine runs to completion in the
  background (every model loop is bounded) and its result is dropped.
- Published snapshots are not frozen (Go has no `Object.freeze`); the tests check that later ticks never change them.

## Kite deviations from Node (found by the 2026-10-28 goldens)
- Typed results: `GetQuoteOhlc` returns typed rows with `?? 0` defaults; Node passed Kite's raw entries through. The only
  caller (`hourlyCapture`, `q.last_price > 0`) behaves the same. REST ladder levels carry `orders: 0` (internal only, never sent).
- Integer token columns: a CSV token that `Number()` makes NaN/±Infinity/beyond int64 reads as 0, a fraction is truncated.
- `ticker.Connect`: a failed handshake or Close before open fires error then close; Node 22 fires error only (twice for an
  early close). Both consumers drop the handle on the first error, so nothing observes the extra close.
- Fixed: `jsjson.SliceUTF16` dropped a surrogate pair cut by the limit; it now ends with U+FFFD (Node sent a lone surrogate,
  which clients decode as U+FFFD). `ticker.Connect` now fails a non-UTF-8 text frame as undici does, and Close before open
  abandons the handshake at once (gorilla only watched the context while connecting TCP; it waited up to 45 s).

## Hub fixes (2026-10-28, found by the slow-peer tests; Node had no equivalent because res.write never blocked)
- A client dropped for falling `ClientQueue` frames behind is now Closed at once, so a writer stuck on a peer that stopped
  reading is aborted and the route ends the stream (before, the stream stayed open until the browser went away).
- `SSEWriter.Close` aborts a write in progress (write deadline = now) and leaves an idle connection alone.
- Every call of a client's detach waits for its writer to stop, not only the first, so a route that returns right after
  detach cannot race net/http recycling the response (the race detector caught this).
- Route contract: an SSE route must call detach before returning, also when the hub dropped the client.
- Lane feed: the reconnect scheduler is injectable (`ZerodhaFeedOptions.AfterFunc`) for the golden replay.

## Dhan notes (2026-10-28)
- Deviation: a fractional security id in the scrip master (`12.5`) is skipped in Go (integer identity); Node kept it with a
  fractional token. Real masters carry integer ids.
- Same behaviour as Node, worth knowing: the zone-less expiry fallback (`Date.parse` then `toISOString`) gives the previous
  day under Asia/Kolkata for inputs like `Sep 29 2026`; Go reproduces it with `time.Local`, so production must run with the
  same `TZ` as the Node service did.
- Fixed: the first-tick log line printed `ltp` with Go's `%v` (`+Inf`, `1e-07`); it now uses JavaScript's `String(n)`.
- Fixed (registry stage): Stop or Dispose during a pending feed handshake left it running up to 45 s; `abandonableDial`
  drops it at once as Node does (proved by `feed_life.json` step 21).
- Removed: `dhan.HTTP.Write`, the single-attempt POST/PUT/DELETE path that only the Node order endpoints used. No caller in Go.

## Completion
All approved completion criteria are met: Go-only non-Box runtime, PostgreSQL data/cache setup, pinned independent
goldens, standalone lifecycle/restart, retained frontend HTTP/browser workflows, final review, both main pushes and
successful CI. Original JSON goldens stay unchanged. Import/deployment tools are out of scope.

## Checks
| When | Command / check | Result |
|------|-----------------|--------|
| 2026-11-02 publication | `git push origin main` in backend then frontend; `git status --short --branch` | exit 0 for both pushes; backend 0217698 and frontend 08f4707 published, both clean and matched origin/main |
| 2026-11-02 publication | `gh run watch 41418473148 --interval 10 --exit-status`; `gh run view 41418473148 --json headSha,status,conclusion,url,jobs` | exit 0; backend runtime 0217698, completed/success, every required verification/artifact step succeeded |
| 2026-11-02 publication | `gh run watch 41418509911 --interval 10 --exit-status`; `gh run view 41418509911 --json headSha,status,conclusion,url,jobs` in frontend | exit 0; frontend 08f4707, completed/success, build/unit/paired-Go PostgreSQL integration steps succeeded |
| 2026-11-02 final post-retirement | `scratch/go-migration/check.sh make db-start && scratch/go-migration/check.sh make db-status` | exit 0; repeated start preserves existing fresh cluster/databases, owned PostgreSQL accepting loopback connections on 55472 |
| 2026-11-02 final post-retirement | `scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' GOFLAGS=-mod=readonly TZ=Asia/Kolkata make check && scratch/go-migration/check.sh env GOFLAGS=-mod=readonly make build` | exit 0; build/vet/format/module gate, all 31 tested packages with race/required PostgreSQL, standalone binary built |
| 2026-11-02 final post-retirement | `git diff --exit-code -- go.mod go.sum && git diff --exit-code 8de7ca5 -- 'internal/**/testdata/*.json' && git diff --check` | exit 0; locked modules and all 39 reference JSON fixtures unchanged; clean whitespace |
| 2026-11-02 final transport review | `scratch/go-migration/check.sh go test -race -count=10 -timeout 180s -run 'TestHistorical\|TestReadRetryBudget\|TestHTTPDeadline\|TestHTTPPaces' ./internal/kite ./internal/brokers/dhan` | exit 0; ten repeated runs of priority/FIFO/pacing/watchdog/cancellation and Dhan retry/deadline/backoff tests |
| 2026-11-02 process/drain review | `scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s ./internal/app ./internal/auth ./cmd/server` | exit 0 after the owned session-write drain and test log-buffer correction; app/auth and real standalone process/restart checks pass |
| 2026-11-02 process/drain review | `go test -race -count=1 -run TestShutdownDrainsPendingAdminSessionBeforeClosingPostgres ./internal/app` through the wrapper with required local PostgreSQL | failed on inherited code: database closed while session save was held, then save failed with closed pool; fixed and covered by passing checks above |
| 2026-11-02 fixture build | `scratch/go-migration/check.sh go build -race -trimpath -o scratch/go-migration/tmp/verifyfixture ./cmd/verifyfixture && scratch/go-migration/check.sh go vet ./cmd/verifyfixture ./cmd/server ./internal/app ./internal/auth` | exit 0; new verification-only fixture builds/vets without Node or new dependencies |
| 2026-11-02 Node retirement | `scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' TZ=Asia/Kolkata make check && git diff --exit-code 8de7ca5 -- 'internal/**/testdata/*.json' && git diff --check` | exit 0; all 30 tested packages pass with race/required PostgreSQL after source removal; all 39 retained JSON fixtures unchanged, clean whitespace |
| 2026-11-02 Node retirement | source/tests/backend `*.mjs` file inventory | no remaining TypeScript runtime, original Node tests or Node scripts; scratch remains intact/ignored |
| 2026-11-02 reference checkpoint | `scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' TZ=Asia/Kolkata make check && scratch/go-migration/check.sh make build` | exit 0; build/vet/format/module verification, all 30 tested packages with required PostgreSQL and race detector, standalone binary built |
| 2026-11-02 reference checkpoint | `git diff --cached --stat`, `git diff --cached --numstat --summary`, staged setup/config/CI review and private-key/token signature scan of `internal/` | intended Go/fixture/task/setup files only; charge fixture is a 100% rename, no scratch/binary/input files staged; no private-key/token signatures found |
| 2026-11-02 12:07 | `bin/work status` from `/home/prakash/Work` | exit 0; WIP 1 of 2 Doing. The helper sees only the CAl parent, not its nested repositories; CAL task states were updated and checked directly. Existing CAl/env_home index warnings remain. |
| 2026-11-02 12:06 | `bin/work status Cal_Spread_Backend` from `/home/prakash/Work` | could not list the project: helper rejects the legacy uppercase/underscore name; the chained Cal_Spread command did not run. No helper configuration or project names were changed. |
| 2026-11-02 final | `REQUIRE_DB_TESTS=1 scratch/go-migration/check.sh go test -race -count=1 -timeout 900s ./...` | exit 0; all 29 tested packages passed, required PostgreSQL tests ran, no failed tests or race reports |
| 2026-11-02 final | `scratch/go-migration/check.sh go build ./... && scratch/go-migration/check.sh go vet ./... && scratch/go-migration/check.sh gofmt -l internal cmd` | exit 0; build/vet successful and formatter listed no files |
| 2026-11-02 final | `scratch/go-migration/check.sh node tasks/2026-10-27-go-postgres-migration/reports/check-suite-coverage.mjs` | exit 0; 32 suites / 332 original cases, 250 COVERED / 78 PORTED / 4 N/A; every referenced Go test exists |
| 2026-11-02 final | `git diff --exit-code -- src tests && git diff --check` | exit 0; unchanged tracked Node source/tests and no tracked whitespace errors |
| 2026-11-02 12:03 | `scratch/go-migration/check.sh pg_isready -h 127.0.0.1 -p 55471` | exit 0; retained local test PostgreSQL accepting connections |
| 2026-11-02 targeted | `REQUIRE_DB_TESTS=1 scratch/go-migration/check.sh go test -race -count=1 -timeout 180s ./internal/boundedcache ./internal/marketdata ./internal/brokers/dhan ./internal/brokers/registry ./internal/lifecycle ./internal/ratecard ./internal/fairvalue/model` | exit 0; all seven changed test packages passed |
| 2026-11-02 targeted | `REQUIRE_DB_TESTS=1 scratch/go-migration/check.sh go test -race -count=1 -timeout 180s ./internal/brokers/registry` | exit 0 after adding the final literal static-IP verification cases |
| 2026-11-02 10:42 | `scratch/go-migration/check.sh go test -race -count=100 -timeout 180s -run 'TestRoutesGolden/session_stream' ./internal/marketdata` | exit 0 after fixing test-only ticker registration ordering; all 100 repeated session-stream golden replays passed |
| 2026-11-02 10:40 | `REQUIRE_DB_TESTS=1 scratch/go-migration/check.sh go test -race -count=1 -timeout 900s ./...` | exit 1: 28 tested packages passed; `internal/marketdata` failed at the scripted SSE ping. A targeted 20-repeat run reproduced a missing pinger. The replay recorded `interval` before publishing its channel, so the waiter could select nil or the previous stream's ticker. Fixed in `routes_golden_test.go`; resolved by the final full-module check above. |
| 2026-11-02 10:40 | `scratch/go-migration/check.sh go build ./... && scratch/go-migration/check.sh go vet ./...` | exit 0; the inherited Go service and newer Node-suite ports build and vet successfully |
| 2026-11-02 10:40 | `scratch/go-migration/check.sh gofmt -l internal cmd` | exit 0; one inherited formatting issue: `internal/auth/node_tokenrouteauth_test.go` |
| 2026-11-02 10:40 | `scratch/go-migration/check.sh pg_ctl -D scratch/go-migration/pgdata -l scratch/go-migration/postgres.log -o "-h 127.0.0.1 -p 55471 -k $PWD/scratch/go-migration/sock -F" -w start` | exit 0; restarted the retained local test cluster after `pg_isready` reported no response |
| 2026-10-30 10:39 | `node scratch/go-migration/tmp/node_routes_vs_inventory.mjs` (every `app/router.get/post/patch/put/delete` with a literal path in `src/` outside `src/box`) | 83 Node registrations, all listed in `inventory/api.md`; the 2 other api.md matches are not routes (a Kite endpoint in a description, the router-relative Fair Value `GET /stream`) |
| 2026-10-30 10:38 | `TZ=UTC REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 900s ./...` | exit 0, 29 packages ok, no FAIL, no race reports (the IST run passed too) |
| 2026-10-30 10:34 | `node scratch/go-migration/tmp/frontend_routes.mjs` (static, read-only scan of `../Cal_Spread/src`) | 50 frontend API paths all match served routes; 20 are Box paths (404 on Go); the 8 left are comments, the `./api` import and query-string-built URLs whose bases (`/api/fno-board`, `/api/fno-stocks`, `/api/instruments`, `/api/fair-value/*`) are served |
| 2026-10-30 10:33 | `scratch/go-migration/check.sh bash scratch/go-migration/tmp/server/e2e.sh` (real binary, `env -i`, dead proxies, loopback) | memory-only and PostgreSQL (18 tables in a throw-away schema) pass all 8 checks each, SIGTERM exits 0; without Kite credentials exit 1 with Node's message (the first attempt failed because the test PostgreSQL was down; restarted) |
| 2026-10-30 10:3x | grep: Mongo/Redis drivers or order endpoints in Go | none: go.mod has no Mongo/Redis module; the words appear only in comments; no place/modify/cancel order code |
| 2026-10-29 19:27 | `go build ./...`; `go vet ./...`; `gofmt -l internal cmd`; `REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 900s ./...` (log `scratch/go-migration/tmp/full-test-2026-10-29-final.log`) | ok; ok; no files; exit 0, 29 packages ok, 0 FAIL, 0 races; `git status -- src tests` empty |
| 2026-10-29 ≈17:00-19:20 | stage checks of synthetic, captures and server | see the 2026-10-29 reports (all green, mutations caught) |
| 2026-10-29 ≈16:52 | `node internal/captures/testdata/gen_parity.mjs`, then `cmp` against the saved goldens | 48 scenarios, 529 stamps, 52 Yahoo cases; all 5 files byte-identical |
| 2026-10-29 ≈16:45 | `REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 600s ./internal/db/ ./internal/auth/ ./internal/calendar/ ./internal/brokers/registry/ ./internal/core/` + synthetic `-run Repository` (overlay) after the id and passcode fixes; `go vet` of the same; `gofmt -l` | all ok; vet ok; no files |
| 2026-10-29 ≈16:44 | bson 6.10.4 `ObjectId.isValid` (npm-cache tarball, scratch copy) and the calendar golden's `12-char-id` steps | `"aaaaaaaaaaaa"` false; golden records 400 "Invalid trade id." for both 12-character ids |
| 2026-10-29 ≈16:40 | `node scratch/go-migration/tmp/dup_header_probe.mjs` (loopback) | Node 22 delivers a repeated custom header as `"first, second"` (a string) |
| 2026-10-29 ≈16:35 | `node internal/synthetic/testdata/gen_engine.mjs`, `cmp` with the saved copy | 4 scenarios, 179 steps; byte-identical |
| 2026-10-29 ≈16:33 | synthetic with the pre-refactor engine via `go -overlay` | vet ok; tests ok (3.4 s) |
| 2026-10-29 ≈16:15 | `go build ./...` | FAILED only in `internal/synthetic` (engine.go mid-refactor); fixed by the resumed stage |
| 2026-10-29 ≈16:15 | every other package: `go build`, `go vet`, `gofmt -l internal`, `REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 900s` | ok; ok; no files; 27 packages ok, 0 failed |
| 2026-10-28 19:2x–19:4x | stage checks of registry, mdroutes, analytics, calendar, core | see the 2026-10-28 reports (all green, mutations caught) |
| 2026-10-28 18:05 | `gofmt -l internal`; `go build ./...` && `go vet ./...`; `REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 600s ./...` | no files; ok; 24 packages ok, 0 failed, 0 race reports |
| 2026-10-28 18:04 | `REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 180s -v -run Repository ./internal/synthetic/` | 3 repository tests pass (first run hit a nil trade in the test itself; fixed) |
| 2026-10-28 18:00 | `go test -race -count=1 -timeout 180s -v -run Golden ./internal/synthetic/` | 6 golden tests pass (incl. `TestConfigGolden`) |
| 2026-10-28 17:58 | mutation: profit capture uses `>` instead of `>=` | passed before the boundary cases were added; with them `TestMathGoldenTrades` FAILS; reverted |
| 2026-10-28 17:54 | mutation: Synthetic treats bid == ask as not crossed | `TestMathGoldenEvaluateAndSort` FAILS (72 opportunities); reverted |
| 2026-10-28 17:51 | `scratch/go-migration/check.sh node internal/synthetic/testdata/gen_math.mjs` | wrote math_golden.json |
| 2026-10-28 17:42 | `gofmt -l internal`; `go build ./...` && `go vet ./...`; `REQUIRE_DB_TESTS=1 … go test -race -count=1 -timeout 600s ./...` | no files; ok; 23 packages ok, 0 failed, no race reports |
| 2026-10-28 17:38 | `node internal/brokers/dhan/testdata/generate.mjs helpers instruments` | helpers.json 617 cases, instruments.json 48 masters |
| 2026-10-28 17:31 | mutation: lane feed keeps its backoff after open | `TestZerodhaFeedGolden` FAILS (2 scenarios); reverted |
| 2026-10-28 17:24 | mutation: hub does not Close a client it drops | `TestSlowPeerCannotWedgeTheHub` FAILS; reverted |
| 2026-10-28 17:03 | mutation: instruments retry on `HasSession()` instead of a non-empty token | `TestClientGolden` FAILS; reverted |
| 2026-10-28 16:53 | `scratch/go-migration/check.sh node internal/kite/testdata/gen_client.mjs` (loopback fake Kite) | wrote client.golden.json, 94 cases |
| 2026-10-28 14:18 | mutation: `config jsonb` in 0003 → `TestPGStoreConfigRoundTripKeepsKeyOrder` | FAIL as expected; reverted to `json` |
| 2026-10-27 19:18 | `scratch/go-migration/check.sh node internal/fairvalue/testdata/gen_model.mjs` | wrote model_golden.json |
| not run | Node build / `npm test` (no backend `node_modules`, no `dist/`) | reference values come from Node 22 type-stripping imports of `src/*.ts` |
| pending | frontend real-Go HTTP/browser workflows | Box removal and frontend build/37 unit tests passed; replace the source-dependent Node browser fixture |

## Historical verification-tooling notes (reference checkpoint only)
Current setup/checks are in README/Makefile and the paired frontend README. The commands below record the original
pre-retirement verification environment; Node source/generators and their dependencies must be recovered from Git
history in a separate scratch checkout for deliberate reference regeneration.
- All tools run through `scratch/go-migration/check.sh <cmd>` from the repo root (offline Go 1.25 + Node 22 + PostgreSQL 18).
- Own PostgreSQL: data dir `scratch/go-migration/pgdata`, port 55471, `TEST_DATABASE_URL` is set by the wrapper. It stops
  when the Kiro session that started it ends (smart shutdowns on 10-27 19:32, 10-28 19:50, 10-29 19:29). Start it if down:
  `mkdir -p scratch/go-migration/sock && scratch/go-migration/check.sh pg_ctl -D scratch/go-migration/pgdata -l scratch/go-migration/postgres.log -o "-h 127.0.0.1 -p 55471 -k $PWD/scratch/go-migration/sock -F" -w start`
- Golden fixtures: generators in `internal/*/testdata/gen_*.mjs` import the original `src/*.ts` with Node 22 type stripping
  (patched copies under `scratch/go-migration/tmp/`; never edit `src/`). `internal/core`'s generator also needs Express
  5.2.1 from `EXPRESS_NODE_MODULES` (default `/home/prakash/GAR/GAR_B/node_modules`, read only); `internal/app`'s needs
  `scratch/go-migration/tmp/server/dotenv-17.4.2/`.
- Write files and run `go test` in separate steps. Go modules are pinned by hand in `go.mod` (offline); do not run `go get`.

## Reconciliation notes
- 2026-11-02 final: Node source/test/generator retirement and module tidy are complete. Earlier reconciliation notes
  below describe their then-untracked state and the old unused godotenv/copy-of-go.sum blocker; those are resolved.
  Intended migration files are published on both mains with successful CI; reference checkpoint `8de7ca5` remains
  available in Git. Final receipt updates are documentation-only and preserve the verified runtime fingerprints.
- 2026-11-02 continuation: all Go source/fixtures and local setup/docs/CI are now staged, not untracked. Two inherited
  inventory whitespace issues found by `git diff --cached --check` were trimmed/restaged. Top-level scope/progress
  notes were reconciled with the approved no-import/no-deployment scope and completed worker/liveness fixes.
  The public `make check` now passes its configured test database and Go executable to the check script.
- 2026-11-02 workspace helper limitation: the CAL repositories are nested under `projects/CAl/`, whereas `bin/work`
  enumerates direct project children and accepts lowercase/hyphen names for project-specific status. Use the explicit
  backend/companion STATUS paths and INDEX links for this handoff; default `bin/work status` still verifies workspace WIP.
- 2026-11-02 audit scope: inventory's two conditional `calculateBoxCharges`/`calculateRoundTrip` cases are N/A as complete
  Box-wrapper cases because no retained runtime caller uses those APIs (PLAN keeps the leg rate card). Retained
  `charges.json` arithmetic is still checked exactly, while removed Box-note `source`/`computed_by` wrapper labels are
  not claimed as Go API coverage. JS repeated-header-array and timer-handle identity cases are also explicitly N/A;
  real HTTP header behavior and actual owned scheduler shutdown remain covered. See each original title in the audit.
- 2026-11-02: resumed the existing task at the user's request. Git still has the complete Go migration and task folder untracked; Node `src/` and `tests/` have no tracked changes. The status stopped at 2026-10-30 10:50, but 25 `node_*test.go` files were written later that day (through 12:17). They are preserved and included in the resumed audit; no audit reports were saved in `reports/`. The main implementation already builds and vets in this session. The retained test PostgreSQL was stopped and has been restarted locally.
- 2026-10-30 10:33: the test PostgreSQL was down again (stopped 10-29 19:29 with the session); restarted.
- 2026-10-29: the todo_list tool's state is shared between parallel agents (one stage cleared another's list); stage
  prompts now forbid it.
- 2026-10-29 16:12: the pipeline of 2026-10-28 finished registry, mdroutes, analytics, calendar and core; synthetic and
  captures were cut off by the session's SIGTERM and resumed from the files on disk.
- Leftovers that can be deleted on request (all under `scratch/go-migration/tmp/`): `feed.go.bak`, `serial.go.bak`,
  `switch.go.bak` (identical to the current files); `synthetic/engine.go.{pre-runtime,partial-runtime}`,
  `synthetic/engine-partial-refactor.diff`, `synthetic/overlay-pre-runtime.json`, `synthetic/stage/`; `captures/bak-before-review/`,
  `captures/review-progress.diff`; `server/bin/`, `server/e2e-*/`, `server/mut/`, the `*.log` files; read-only extracts
  `bson-6.10.4/`, `mongoose-8.24.4/` (keep `server/dotenv-17.4.2/`).
- `go.mod` still requires the unused `github.com/joho/godotenv` (copied go.mod); `go mod tidy` when online.
- 2026-10-28 14:08: files matched the summary: the four new fairvalue test files had never compiled; fixed.
- The repos live in `projects/CAl/`; INDEX.md was corrected earlier.
- Another app (Codex) ran a PostgreSQL from `scratch/tools/postgres` (pid 36476, not ours); this task uses its own cluster.
- An accidental `go version` with GOTOOLCHAIN=auto downloaded go1.26.0 into `~/go/pkg/mod/golang.org/` (outside ~/Work); deletable on request.
- `go.sum` was copied from `Live_Index_Algo_B`; trim with `go mod tidy` when the dependency set is final (not possible offline).
- IDE sub-agents reported "cancelled" but kept writing files; always re-check mtimes before assuming a package is quiet.
- `scratch/go.mod` (module `calspread-local-tools`) belongs to an earlier session; Go probes in `scratch/` need their own
  `go.mod` or they pick it up. Left as is.
- Nothing is committed or pushed. `internal/`, `cmd/`, `go.mod`, `go.sum` and this task folder are untracked (testdata
  goldens ≈ 30 MB, largest file 5.4 MB). Suggested checkpoint when the user agrees:
  `git add go.mod go.sum cmd internal tasks/2026-10-27-go-postgres-migration && git commit -m "go-migration: complete Go service (Box removed), golden-verified against the Node source"`.

## Relevant files
`src/` (Node reference), `tests/` (suites + `migration-fixtures/`), `docs/MIGRATION_CONTRACT.md`, `docs/GO_MIGRATION_BOUNDARIES.md`,
`docs/CONFIGURATION.md`, `../Cal_Spread/src/api.ts`, `inventory/*.md` (api, storage, brokers, analytics, tests),
`reports/*.md` (stage reports), `cmd/server/main.go`, `internal/app/` (wiring, boot and shutdown order),
`scratch/go-migration/check.sh`, `scratch/go-migration/tmp/server/e2e.sh`, `scratch/go-migration/tmp/frontend_routes.mjs`,
`scratch/go-migration/tmp/node_routes_vs_inventory.mjs`, `reports/2026-11-02-kept-suite-audit.md`,
`reports/check-suite-coverage.mjs`, `internal/**/node_*test.go`.
