# Status: Restore analytics history with Dhan active

State: Doing
Updated: 2026-11-04
Next action: Commit and push the verified existing-test log synchronization, watch current main CI, then publish the completion/rollout receipt.
Blockers: none
WIP override: none

Task: `2026-11-04-dhan-analytics-history` · Project: Cal_Spread_Backend · Plan: [PLAN.md](PLAN.md)

## Current state

The screenshot's live chain worked while all five history panels were empty.
Source and public API checks confirmed the starting App wiring installed
ZerodhaCaptureGate and direct Kite quotes, preventing Dhan capture/backfill.
All analytics paths now follow Dhan's providers when active; native
record/backfill/baseline, cache restoration and namespace fencing are implemented.
The required local suite/build/module checks passed. Runtime 13a0ab8 is published
on GitHub main; matching feature CI 41808216441 completed successfully. The
receipt commit's CI 41808832910 exposed a race in the existing memory-only test's
shared log slice. Its collector is now synchronized; current-main verification
is in progress before the operator's live VM rollout.

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
- Staged only the 32 intended backend implementation/tests/docs/task files and
  published runtime 13a0ab8aa1d7c23e00cab2d585aea90504032f04 on main.
- Verified GitHub CI 41808216441 on that exact runtime: build/vet/format,
  PostgreSQL/race tests, module sync, standalone binary and artifact upload succeeded.
- Confirmed zero leftover test schemas and stopped the owned local PostgreSQL
  process; cluster data and authorized tool/cache directories remain in scratch.
- Current-main receipt CI exposed an inherited test-only race: the memory-only
  test's Logf callback appended to one slice from capture/backfill goroutines
  without a mutex. Synchronized collection and its snapshot read; application
  runtime source is unchanged by this correction.
- The corrected memory-only test passed 50 race-enabled repetitions, and the
  complete required backend suite/build passed again for all 32 tested packages.

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
| 2026-11-04 | Explicit intended-file staging followed by `git diff --cached --check && git diff --cached --stat && git diff --cached --name-only && git status --short --branch` | Exit 0; exactly 32 intended implementation/test/docs/records staged, no scratch, .env, binary or locked-fixture changes. |
| 2026-11-04 | `git commit -m "Use Dhan for analytics capture and history" && git push origin main && git status --short --branch && git rev-parse HEAD origin/main && gh run list --branch main --commit "$(git rev-parse HEAD)" --workflow ci.yml --event push --json databaseId,headSha,status,conclusion,url` | Exit 0; runtime 13a0ab8 published, clean worktree and HEAD/origin/main match. The immediate CI listing was initially empty. |
| 2026-11-04 | `gh run list --branch main --commit 13a0ab8aa1d7c23e00cab2d585aea90504032f04 --workflow ci.yml --event push --json databaseId,headSha,status,conclusion,url` | Exit 0; matching run 41808216441 found in progress. |
| 2026-11-04 | `gh run watch 41808216441 --interval 20 --exit-status && gh run view 41808216441 --json headSha,status,conclusion,url,jobs` | Exit 0; completed success, exact runtime SHA matched, every required check/build/module/artifact step successful. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh psql --no-psqlrc 'postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' --set=ON_ERROR_STOP=1 --command "select count(*) as remaining_test_schemas from pg_namespace where nspname ~ '^t_[0-9a-f]{12}$'" && bash scratch/dhan-default-check/check.sh make db-stop && git diff --check` | Exit 0; zero leftover disposable schemas, owned PostgreSQL stopped with data retained, clean receipt whitespace. |
| 2026-11-04 | `gh run watch 41808832910 --interval 20 --exit-status && gh run view 41808832910 --json headSha,status,conclusion,url,jobs` | Failed: receipt main b1df3c1 CI completed failure, so the chained view did not run. |
| 2026-11-04 | `gh run view 41808832910 --json headSha,status,conclusion,url,jobs` and `gh run view 41808832910 --log-failed` | Exit 0; isolated race at service_test.go:910 in TestMemoryOnlyWithoutCache's unsynchronized log slice, called concurrently by capture and cold-start backfill. Other packages including the Dhan App/registry checks passed. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off go test -race -count=50 -timeout 120s -run '^TestMemoryOnlyWithoutCache$' ./internal/analytics && bash scratch/dhan-default-check/check.sh gofmt -d internal/analytics/service_test.go && git diff --check` | Exit 0; all 50 memory-only race repetitions passed, no formatting/whitespace issues. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh make db-start && bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh env GOPROXY=off make build && git diff --check` | Exit 0; owned database resumed, required full 32-package PostgreSQL/race/build/vet/format/module suite and standalone binary passed after the collector correction. |

## Publication and rollout

- Runtime: [13a0ab8](https://github.com/Prakash2571/Cal_Spread_Backend/commit/13a0ab8aa1d7c23e00cab2d585aea90504032f04), published on main.
- [CI 41808216441](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41808216441)
  completed success on the published runtime.
- This follow-up receipt changes only STATUS/report documentation; executable
  source remains the verified 13a0ab8 runtime.
- VM rollout: as `calspread`, run `/home/calspread/Cal_Spread_Backend/scripts/deploy.sh`.
  After recovery, inspect the public option/futures frame and baseline APIs used
  by the existing Analytics page. A production rollout has not been performed by
  this local implementation/verification task.

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
