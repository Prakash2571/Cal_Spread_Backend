# Status: Restore analytics history with Dhan active

State: Doing
Updated: 2026-11-04
Next action: Stage only the reviewed backend files, commit and push main, then watch the matching GitHub CI and publish the rollout receipt.
Blockers: none
WIP override: none

Task: `2026-11-04-dhan-analytics-history` · Project: Cal_Spread_Backend · Plan: [PLAN.md](PLAN.md)

## Current state

The screenshot's live chain works while all five history panels are empty. Source
and public live API checks confirm the cause: App installs ZerodhaCaptureGate and
direct Kite quote calls for analytics captures, so Dhan never records or backfills
those stores. All analytics paths now follow Dhan's providers when active; native
record/backfill/baseline, cache restoration and namespace fencing are implemented.
The required local suite/build/module checks passed; publication is next.

## Completed

- Read workspace/backend/frontend workflows, READMEs and the previous task notes.
- Confirmed starting backend main 364cf7f and frontend main 4749fd0 are clean.
- Traced Analytics.tsx frame/baseline polling and backend capture/scheduler/backfill.
- Confirmed live public API status: Dhan authenticated, data ready, feed LIVE and
  no Zerodha session; option/futures 1m history and 5m baseline are empty.
- Identified secondary Dhan history issue to investigate: normalized NIFTY F&O
  instruments are classified by their own segment as stock derivatives in the
  inherited historical helper.
- User clarified that every analytics path on the page should default to Dhan.
- Read current Dhan quote/historical docs: native derivative instrument classes,
  explicit intraday datetime bounds and requested OI are needed for reconstruction.
- Added a Dhan-only real-App/PostgreSQL HTTP reproduction covering all frames,
  minute/day baselines and absence of Kite data requests.
- The reproduction failed on the original wiring with the explicit Zerodha-only
  pause log and empty history, confirming the screenshot's root cause.
- Routed captures to active-broker full OI quotes/readiness; native Dhan historical
  reads retain index derivative class, exact datetime bounds, explicit offsets and
  upstream/missing-column errors. Backfilled minute candles now seed chain baselines.
- Added broker-keyed history storage and operation/generation fencing; active-token
  installation and selection trigger bounded/coalesced analytics recovery.
- Dhan-only local frame/baseline test passed after fixing its overly fast HTTP poll
  loop (which initially hit the real app's rate limiter).
- The test now boots App without a broker session, then pastes a Dhan token and
  verifies actual session-ready recovery fills every frame and both baselines.
- Added verified checks for independent broker persistence, pending-write ownership,
  fresh-service restoration, delayed-response fencing and native history/quote fields.
- Enforced Dhan analytics quote pacing with cancellable queue waits; kept permanently
  unseeded option quotes partial and absent futures legs missing instead of zeroed.
- Required full backend check/build/tidy completed successfully: all 32 tested
  packages with mandatory PostgreSQL/race detection, build/vet/format/module checks,
  standalone binary and unchanged locked modules/pinned JSON fixtures.
- Saved the report at `outputs/2026-11-04-dhan-analytics-history.md`.
- Publication follows the user's earlier instruction to push completed CalSpread
  changes to GitHub main. VM deployment is an operator rollout action.
- Reviewed tracked diffs, new native providers/namespace helpers and behavioral
  fixtures. Publication-time fetch confirms origin/main still matches 364cf7f.

## Checks

| When | Command / check | Result |
|------|-----------------|--------|
| 2026-11-04 | Backend `git status --short --branch && git log -5 --oneline` | Exit 0; clean main at 364cf7f. |
| 2026-11-04 | Frontend `git status --short --branch && git log -5 --oneline` | Exit 0; clean main at 4749fd0. |
| 2026-11-04 | Workspace `bin/work status` | Exit 0; one pre-existing Doing task. Existing nested-CAl/env_home enumeration warnings remain. |
| 2026-11-04 | Read-only GET https://calspread.online/api/status | HTTP success; active Dhan, authenticated/data ready, connected LIVE feed, zerodha_session false. |
| 2026-11-04 | Read-only GET https://calspread.online/api/option-oi-frame/NIFTY?frame=1m | HTTP success; points empty. |
| 2026-11-04 | Read-only GET https://calspread.online/api/futures-oi-frame/NIFTY?frame=1m | HTTP success; contracts and points empty. |
| 2026-11-04 | Read-only GET https://calspread.online/api/option-oi-baseline/NIFTY?minutes=5 | HTTP success; no oldest/newest/baseT and no baseline tokens. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh make db-start && bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 60s -run '^TestDhanOnlyAnalyticsPopulatesAllFramesAndBaselines$' ./internal/app` (original wiring) | Failed as expected: Dhan session/live chain worked but captures logged their Zerodha-only pause and history stayed empty. Owned local test PostgreSQL restarted successfully. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off go build ./... && bash scratch/dhan-default-check/check.sh gofmt -d internal/analytics internal/brokers/namespace.go internal/brokers/registry internal/brokers/dhan/instruments.go internal/app/app.go internal/app/harness_test.go internal/app/dhananalytics_test.go` | Exit 0; source builds; gofmt reported three alignments that were applied. |
| 2026-11-04 | Focused Dhan-only test after initial implementation | Two intermediate failures were fixture polling failures: rapid GET loops hit the real API limiter while server logs confirmed 240 option/futures minutes reconstructed and six previous-close tokens. Reduced test polling rate; no endpoint bypass was added. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 60s -run '^TestDhanOnlyAnalyticsPopulatesAllFramesAndBaselines$' ./internal/app` | Exit 0, 3.423s: all four option/futures frames, minute/day baselines and zero Kite data calls. The next revision drives this through actual App boot/session-ready recovery. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s ./internal/analytics ./internal/brokers/registry ./internal/app` | Exit 0: analytics 2.021s, registry 3.191s, app 7.094s; retained cases plus actual boot/session-ready Dhan integration passed. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 120s -run 'TestDhanOnlyAnalytics\|TestDhanHistoryPersists\|TestDelayedDhanQuote\|TestDhanAnalytics\|TestFetchedDhanTokenAndSelection' ./internal/analytics ./internal/brokers/registry ./internal/app` | Exit 0: analytics 1.380s, registry 1.039s, app 3.452s; namespace switch/restart/pending write, delayed quote, native metadata and fetched-token ready-hook checks passed. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh env GOPROXY=off make build && bash scratch/dhan-default-check/check.sh env GOPROXY=off go mod tidy && git diff --exit-code -- go.mod go.sum 'internal/**/testdata/*.json'` | Exit 0; required complete build/vet/format/module/PostgreSQL/race suite passed for all 32 tested packages, including latest pacing/partial checks; standalone binary and module sync passed. |
| 2026-11-04 | `git fetch origin main && git status --short --branch && git log --oneline -10 && git log --oneline HEAD..origin/main && git diff HEAD..origin/main && git diff --check && git diff` | Exit 0; remote main unchanged at 364cf7f, intended changes reviewed, no whitespace issues; new files read separately. |
| 2026-11-04 | Workspace `git diff --check && bin/work status` | Exit 0; preserved existing workspace edits; existing nested-CAl/env_home helper warnings remain. |

## Relevant files

- `internal/app/{app.go,adapters.go,lifecycle.go}`
- `internal/analytics/{analytics.go,gate.go,capture.go,scheduler.go,backfill.go,warmload.go,writebehind.go,routes.go}`
- `internal/brokers/registry/{quotes.go,history.go,dhansession.go,switch.go}`
- `../Cal_Spread/src/Analytics.tsx`
- `internal/analytics/{namespace.go,namespace_test.go,partial_test.go}`
- `internal/brokers/registry/{namespace.go,analyticsquotes.go,analyticshistory.go,analyticsdata_test.go}`
- `internal/app/dhananalytics_test.go`
- `outputs/2026-11-04-dhan-analytics-history.md`

## Reconciliation notes

- The previous default/persistence task verified Dhan session durability, not Dhan
  analytics capture support. Retained Go/Node parity intentionally kept analytics
  recording Zerodha-only, which is now exposed by using Dhan as the active broker.
- Neither CalSpread repository has a local AGENTS.md; workspace guidance and the
  project WORKFLOW files apply.
- No production token, admin credential or private server configuration was used
  for the public live checks.
