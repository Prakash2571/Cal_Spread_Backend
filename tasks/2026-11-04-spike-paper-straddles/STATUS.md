# Status: Spike — NIFTY/SENSEX minimum-straddle paper spreads

State: Doing
Updated: 2026-11-04
Next action: Commit/push the reviewed backend feature, verify its matching CI, then publish the frontend and verify its matching CI; record receipts and stop owned PostgreSQL.
Blockers: none
WIP override: none

Task: `2026-11-04-spike-paper-straddles` · Projects: Cal_Spread_Backend + Cal_Spread · Plan: [PLAN.md](PLAN.md)

## Current state

Clean starting baselines were backend 1586c24 and frontend 4749fd0. Implementation,
Jev-assisted corrections, final local verification and delivery reports are complete;
source publication and matching CI remain.
The user requested the Spike feature, primary fourth-OTM paper spreads only,
separate premium/VWAP charts and no unnecessary environment variables. The 5%
reference is any earlier straddle price within a rolling 30-minute lookback.

## Completed

- Read workspace/backend/frontend workflows, READMEs and prior task notes.
- Confirmed user's extra-spread choice: primary fourth-OTM only.
- Confirmed separate premium and VWAP chart presentation and no new env variables.
- User selected At crossover only: 5% against a prior price in the rolling 30-minute
  window must already qualify on the exact matching VWAP crossover update.
- Began preserving Dhan average traded price/price-update metadata internally and
  a fixed third Dhan socket for Spike, isolating full chains from existing lanes.
- Implemented the dedicated lane, continuous tracker, rolling extrema, bar/trade/
  control persistence, primary spread entry and manual executable exit/P&L.
- Added Spike page/navigation, separate premium/VWAP plots and simple controls;
  existing frontend dependency installation was reused.
- Added docs/SPIKE.md covering formulas, exact trigger timing, fills, data gaps,
  restart behavior, permissions and controls without new environment settings.
- Real Dhan binary-feed HTTP integration passed for both index entries, timeframes,
  one-lot sizes, manual exit/P&L and persisted paper control.
- Required complete backend suite/build passed for all 33 tested packages.
- Browser verification uses separate fresh fixtures to keep the real 150/minute
  API limit intact. A parallel attempt exposed Firefox's shared BiDi 9222 port;
  browser runs are sequential. Spike's navigation-close EventSource log
  is recognized only after its actual open/snapshot has been verified.
- Inspected Dhan decoder: QUOTE/FULL packets already contain average traded price
  and cumulative volume; average-price/update metadata now reaches internal Tick
  consumers while the legacy browser JSON remains unchanged.
- Inspected headless Hub listeners, existing paper-trade authorization/persistence,
  React routing and reusable LineChart.
- Frontend node_modules already exists, Node 22.22.1/npm 9.2.0 are available;
  existing Go/PostgreSQL tooling and locked caches can be reused.
- Jev's first seven-question review returned HTTP 200 on jev-1.14.0. It identified
  desktop-axis clipping (0.80 true) and missing explicit downward-rule lookback
  (0.13 that stated); mobile clipping was unsettled (0.51) and needs measured bounds.
  Separate charts (1.00), mobile paper-only label (0.98), crossover timing (0.94)
  and delayed-confirmation negative case (0.09) matched their intended propositions.
- Measured browser bounds reproduced Jev's desktop finding on all four rightmost
  time labels. Fitted chart endpoint labels now anchor inside the canvas, and the
  downward rule explicitly states both price-driven timing and its 30-minute window.
- Code review hardened entry/marks/manual close against crossed, missing/nonfinite
  books and sizes, discards invalid newly supplied averages rather than reusing an
  old VWAP, and rejects disconnected/stale-namespace candidates/closing marks.
  Meaningful invalid-data regressions passed in the complete PostgreSQL/race suite.
- Final review found an exact-minute boundary could overwrite the previous bar;
  live ticks now go into the next forming bucket at the boundary, with a focused
  observed-history regression. Full checks and HTTP/Spike-browser reruns passed.
- Jev's revised seven-question review returned jev-1.14.0: desktop clipping 0.08,
  mobile clipping 0.11, paper-only label 0.99, separate charts 1.00, exact upward
  timing 0.95, explicit downward lookback 0.99, delayed-confirmation negative 0.08.
  Every expected proposition was settled with the original wording/thresholds.
- Fixture time previously used today's weekday, so weekend CI could not exercise
  signals. It now uses the most recent weekday at 14:05:10 IST; Saturday/Sunday/
  Monday regression cases cover this verification-only clock. Final complete suite
  and real-Go HTTP workflow passed after this correction.
- Saved final implementation/verification report and actual Jev response/usage
  receipt in the two repositories' outputs, with exact-payload hashes/paths.

## Checks

| When | Command / check | Result |
|------|-----------------|--------|
| 2026-11-04 | Backend git status --short --branch && git log -5 --oneline | Exit 0; clean main at 1586c24. |
| 2026-11-04 | Frontend git status --short --branch && git log -5 --oneline | Exit 0; clean main at 4749fd0. |
| 2026-11-04 | Workspace bin/work status | Exit 0; one pre-existing Doing task. Existing nested-CAl/env_home helper warnings remain. |
| 2026-11-04 | Frontend node --version && npm --version | Exit 0; Node v22.22.1, npm 9.2.0. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off go build ./...` | Exit 0; new Spike backend compiles. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh make db-start && bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 120s ./internal/spike` | Exit 0; rule, rolling-window, both-index minimum/spread, manual exit/P&L and restart tests passed (1.198s). |
| 2026-11-04 | Frontend `npm run build` | Exit 0; TypeScript/Vite build passed, bundle 370.62 kB with Spike included. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s ./internal/spike ./internal/brokers/dhan ./internal/brokers/registry ./internal/app && bash scratch/dhan-default-check/check.sh gofmt -l internal cmd` | Exit 0; strategy/metadata/lane/API/lifecycle cases passed; no formatter output. |
| 2026-11-04 | Frontend `npm test && git diff --check && git diff --exit-code -- .env.example package.json package-lock.json` | Exit 0 at that milestone; 37 tests passed and locked dependencies/env unchanged. A later npm script adds the separate Spike browser runner without dependency changes. |
| 2026-11-04 | Frontend `bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh npm run test:go` | Exit 0; eight actual Go/PostgreSQL HTTP groups, including real Dhan binary WebSocket primary entries and manual exit P&L. Initial direct wrapper invocation failed with permission denied; using bash resolved it. |
| 2026-11-04 | Combined browser run with Spike added | Failed later at Fair Value HTTP polling with 429 after the Spike chart/control/entry/exit/mobile checks; separated Spike into its own fresh-fixture runner. |
| 2026-11-04 | Parallel fresh Spike/classic browser attempts | Spike reached final checks but reported the verified navigation-cancelled EventSource null-status log; classic failed browser startup due shared BiDi port 9222. Updated Spike's verified cancellation handling and run browsers sequentially. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh env GOPROXY=off make build` | Exit 0; build/vet/format/module and mandatory PostgreSQL/race suite passed for all 33 tested packages, standalone binary built. |
| 2026-11-04 | `node -e 'console.log(JSON.stringify({typesafe_key_available: Boolean(process.env.TYPESAFE_API_KEY)}))'` | Exit 0; key available in the current OpenCode shell. No credentials printed. |
| 2026-11-04 | Read live TypeSafe index, JavaScript SDK, HTTP schema, models/pricing, Noul, images and jaggedness docs; SDK-resolution and Pillow probes | Current syntax/limits confirmed; SDK unavailable, existing Pillow 12.1.1 available. No installation or live inference yet. |
| 2026-11-04 | Inspect retained `../Cal_Spread/scratch/go-integration/spike-browser-HzfFZg/report.json` and screenshots | Report records six passing Firefox 157.0 checks and 390px/378px containment; screenshots are generated fixture data. This inspection is not a new browser run. |
| 2026-11-04 | Frontend `python3 scratch/jev-spike-review/prepare.py scratch/go-integration/spike-browser-HzfFZg baseline` | Exit 0; desktop 1428×1554 and top mobile crop 378×1568 fit live image limits; exact PNG hashes/transform manifest saved. |
| 2026-11-04 | Initial scratch TypeScript compile with `--types node` | Failed TS2688 before any model request: frontend has no @types/node. Scratch-only minimal built-in declarations resolved it without installation. |
| 2026-11-04 | Frontend `./node_modules/.bin/tsc --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM --strict --skipLibCheck --outDir scratch/jev-spike-review/compiled scratch/jev-spike-review/node-types.d.ts scratch/jev-spike-review/review.ts && node scratch/jev-spike-review/compiled/review.js scratch/jev-spike-review/baseline` | Exit 0; real HTTP 200, seven typed Noul answers, jev-1.14.0. 8,142 input / 153 free output tokens, estimated US$0.000341964, zero retries; findings require review rather than an all-clear. |
| 2026-11-04 | Frontend `bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh env FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:spike:browser` with new bounds checks before fixing labels | Failed as expected: all four desktop rightmost `14:04:00` labels extended outside their SVG canvas. Confirmed Jev's finding, then applied endpoint anchoring. |
| 2026-11-04 | Frontend `npm run build && npm test` after chart/rule corrections | Exit 0; TypeScript/Vite build and all 37 tests passed; JS bundle 370.74 kB. |
| 2026-11-04 | Backend `bash scratch/dhan-default-check/check.sh env GOPROXY=off go mod tidy -diff && git diff --exit-code -- go.mod go.sum .env.example internal/parity/testdata` | Exit 0; locked module sync passed; dependency/env/frozen fixture files unchanged. |
| 2026-11-04 | Backend `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh env GOPROXY=off make build` after invalid-data hardening | Exit 0; all 33 tested packages passed, including new malformed-depth/updated-VWAP regressions; full build/vet/format/module/PostgreSQL/race checks and standalone build passed. |
| 2026-11-04 | Frontend `bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh npm run test:go && bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh env FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:spike:browser && sleep 2 && bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh env FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:browser` | Exit 0; eight real-Go HTTP groups, six Spike browser checks and 14 classic browser checks. All 20 desktop/12 mobile axis labels within SVG bounds; mobile 390px/378px. Evidence: spike-browser-zdblqm and browser-r0uIlH. |
| 2026-11-04 | Backend full `make check`/`make build` with the existing wrapper/test database after exact-minute fix | Exit 0; all 33 tested packages, required PostgreSQL/race tests, build/vet/format/module checks and standalone build passed. |
| 2026-11-04 | Frontend `bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh npm run test:go && bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh env FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:spike:browser` | Exit 0; eight HTTP groups and six Spike browser checks; all desktop/mobile axis bounds passed. Evidence: spike-browser-L4L9a0. |
| 2026-11-04 | Both repositories `git fetch origin main && git rev-parse HEAD origin/main && git status --short --branch && git log --oneline -10` | Exit 0; remote mains still equal backend baseline 1586c24 and frontend baseline 4749fd0; only intended Spike work present. |
| 2026-11-04 | Frontend `python3 scratch/jev-spike-review/prepare.py scratch/go-integration/spike-browser-L4L9a0 revised && node scratch/jev-spike-review/compiled/review.js scratch/jev-spike-review/revised` | Exit 0; HTTP 200, jev-1.14.0, all seven expected propositions settled. 8,153 input / 153 free output tokens; estimated US$0.000342426, zero retries. |
| 2026-11-04 | Final backend `bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh env GOPROXY=off make build` | Exit 0; all 34 tested packages, including weekend-fixture regression, passed. Build/vet/format/module and mandatory PostgreSQL/race suite plus standalone build succeeded. |
| 2026-11-04 | Final frontend `bash ../Cal_Spread_Backend/scratch/dhan-default-check/check.sh npm run test:go` | Exit 0; all eight real-Go/PostgreSQL HTTP groups passed with the weekend-safe fixture. |
| 2026-11-04 | Backend `bash scratch/dhan-default-check/check.sh psql -h 127.0.0.1 -p 55472 -U calspread -d calspread_test -At -c "select nspname from pg_namespace where nspname not in ('public', 'information_schema') and nspname not like 'pg_%' order by nspname"` | Exit 0; no rows, zero non-system test schemas left. |
| 2026-11-04 | Both repository status/log/diff checks; env/locked/frozen-file guards; `gh workflow list` | Exit 0; only intended Spike files; workflow authentication available. No source commits yet. |
| 2026-11-04 | Frontend `node --input-type=module -e` artifact-integrity assertions against both retained exact requests/results and the output receipt | Exit 0; request SHA-256s, complete returned responses, unchanged question wording, 16,295 input/306 free output tokens, price and remaining budget reconciled. No API call. |

## Jev budget and evidence

- Session allowance US$0.01; two calls used 16,295 input and 306 free output tokens.
  Actual estimated spend US$0.000684390; remaining US$0.009315610 at live-documented
  US$0.042/Mtok input. No unknown usage/retries.
- Exact baseline/revised requests, prepared PNG assets/manifests and complete
  results are in `../Cal_Spread/scratch/jev-spike-review/{baseline,revised}/`;
  running accounting is in
  `../Cal_Spread/scratch/jev-spike-review/budget.json`.
- Wording, criteria, expected propositions and unsettled handling are kept together
  in `../Cal_Spread/scratch/jev-spike-review/review.ts`. Keys were never recorded.

## Relevant files

- internal/brokers/dhan/feeddecoder.go, feed.go
- internal/brokers/registry/registry.go and subscription providers
- internal/hub/hub.go, internal/market/market.go
- internal/app/app.go, lifecycle.go
- internal/db/migrations/
- ../Cal_Spread/src/App.tsx, LineChart.tsx, api.ts, styles.css

## Reconciliation notes

- Earlier Dhan analytics work is complete and published; Spike is a separate
  cross-repository feature with one Doing task record for workspace WIP.
- The user clarified 5% versus prior straddle values, rather than a 5% distance
  from VWAP; the implementation must follow that clarification.
- The user described chart separation when asked about VWAP. The explicit baseline
  proposed is the sum of Dhan's two leg average traded prices and will be documented.
- The final sequential Spike/classic browser command succeeded before resuming;
  the notes still listed it as pending. Spike's retained report corroborates its
  six checks; final reruns are needed if review changes UI behavior.
- User requested Jev-assisted building. Current key loading works; review uses
  focused generated images/rule wording and the standing US$0.01 budget. Exact
  requests/assets/results are retained in frontend scratch/jev-spike-review/.
- Both project WORKFLOW task pointers still named the completed token-login task;
  updated them to the active Spike cross-repository record. README now identifies
  the additional dedicated lane accurately.
