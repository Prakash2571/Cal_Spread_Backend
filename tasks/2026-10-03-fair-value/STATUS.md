# Fair Value — status

State: Done
Updated: 2026-10-04
Blockers: None. Production expiry-time policy is deliberately unconfigured per user decision.
Next action: None for implementation/publication. Before any separately authorized deployment/use, configure verified expiry-time and discount inputs; analytics remains disabled by default.

## Completed

- Inspected both repositories, authentication, broker-neutral adapters, metadata,
  refcounted feed lanes, Mongo/Redis storage, UI routing/charts/styles and test setup.
- Recorded plan and user decisions; installed package-lock dependencies in both repos.
- Stage 1: total-variance Black with reliable Cephes normal tails, frozen Greeks,
  ACT/365F and explicit final/indicative settlement; bracketed IV statuses; log-D
  curve; exact metadata expiry policy; bid/ask cleaning and robust forward hierarchy.
- Added independent QuantLib reference script and formula/assumption documentation.
- Stage 2: validated total-variance interpolation fallback, isolated worker pool,
  immutable input/publication identities, broker/config/feed-generation fences,
  bounded subscriptions/history, full-admin routes including revocation-aware SSE.
- Frontend Fair Value navigation/page, selectors/chain, numeric-axis IV/variance/
  maturity/residual charts, assumptions/configuration, history and detail drawer.
  Custom calculator, independent estimates and scenario sensitivities are integrated.
- Fixed local frontend test execution using its existing TypeScript dependency.
- Stage 3: deterministic bounded multi-start raw SVI price-Huber calibration,
  nonnegative parameterization, wing/tail restrictions, adaptive g diagnostics and
  actual-spacing CE/PE price validation. Invalid fits preserve attempt diagnostics
  and use only a validated, labelled interpolation fallback.
- Stage 4: same-k total-variance maturity interpolation; conservative calendar
  crossing/price validation; explicit log-carry or verified carry forward policy;
  hypothetical strike/expiry calculator with actual listed IDs/lots only, research
  opt-in/extrapolation distance limits and negative-forward-variance rejection.
- Stage 5: both target sides excluded before forward and calibration, on-demand
  worker refit, bounded snapshot/expiry/strike/config cache, documented scenario
  sensitivity ranges, count/age/byte-bounded memory history and durable Mongo records.
- Verification-driven hardening: private role checked again after async work and
  on every SSE emission; broker-neutral fanout retention; synchronous analytics
  subscription yielding; small recent immutable input cache for refresh races;
  exact listing metadata distinct from bounded quoted support; invalid pair/duplicate
  exclusion; tiny ATM cancellation handling; no LTP depth freshness resurrection.

## Checks (2026-10-03)

- Frontend `npm ci --no-audit --no-fund`: exit 0, 71 packages.
- Backend `npm ci --no-audit --no-fund`: exit 0, 98 packages.
- Frontend `npm run build`: exit 0 (baseline).
- Backend `npm run build`: exit 0 (baseline).
- Backend `npm run test:unit`: exit 0, 1488 passed, 17 skipped (1505 total).
- Frontend `npm test`: exit 1; this Node binary lacks built-in TS stripping
  (`ERR_NO_TYPESCRIPT`). Use installed TypeScript via a test-only loader.
- `python3` import probe: QuantLib/scipy/mpmath absent before approved installation.
- `python3 -m venv scratch/quantlib-env`: failed (ensurepip unavailable); no system
  package installed. Approved QuantLib 1.40 wheel installed under scratch/quantlib
  with SHA-256 verified against PyPI metadata; import succeeded.
- Stage 1 `npm run build && npm run test:fair-value && PYTHONPATH="/home/prakash/Work/projects/Cal_Spread_Backend/scratch/quantlib" python3 scripts/fair_value_quantlib.py`:
  exit 0; 13 tests; 1344 QuantLib prices and 786 well-conditioned IV references;
  largest absolute price error 5.820766091346741e-11.
- Initial focused checks reproduced price-only IV stopping on a low-vega plateau;
  fixed by requiring the volatility bracket to converge as well, then reran above.
- Stage 2 backend `npm run build && npm run test:fair-value`: exit 0, 19 tests,
  including actual worker timeout isolation, immutable publication and HTTP/SSE full
  admin guards (trade/expired/non-admin denied, revoked stream closed).
- Stage 2 frontend `npm run build && npm test`: exit 0, production build and all
  52 tests passed. First stage-2 build found ES2020 replaceAll usage; replaced with
  compatible regex replacements and reran successfully.
- Stage 3 backend `npm run build && npm run test:fair-value`: exit 0, 24 tests.
  Includes finite-difference SVI derivatives/g, the published Vogt negative-density
  counterexample, reproducible price-space fits and nonuniform convexity failure.
- Stage 4 backend `npm run build && npm run test:fair-value`: exit 0, 29 tests,
  including same-k interpolation, hypothetical/listed units, calendar crossing,
  research restrictions and discrete-event carry suppression.
- Stage 5 backend HTTP workflow passed (initial total 34 feature tests), including
  calculator/independent cache/history/export/pause/disable/stale handling.
- `node scripts/fair_value_mongo_test.mjs`: exit 0; actual ephemeral MongoDB 8.0.16
  config round trip, input/model history, count retention and connection-restart read.
- `PLAYWRIGHT_BROWSERS_PATH="/home/prakash/Work/projects/Cal_Spread/scratch/browsers" node scripts/fair_value_browser_test.mjs`
  (frontend): exit 0; Chromium navigation, search, independent refit, hypothetical
  calculator, export, history, pause/resume, mobile overflow, non-admin zero requests,
  zero page errors. Browser fixture time/data is deterministic; production not exercised.
- Current hardening `npm run build && npm run test:fair-value && PYTHONPATH="/home/prakash/Work/projects/Cal_Spread_Backend/scratch/quantlib" python3 scripts/fair_value_quantlib.py`:
  exit 0; 42 feature tests, 1344 QuantLib prices, 786 IV comparisons, max price error
  5.820766091346741e-11.

## Final verification (2026-10-04)

- Backend `npm test`: exit 0 on the isolated rerun; strict build, 1488 existing
  unit tests passed / 17 skipped, 42 Fair Value tests passed, 16 optional existing
  integration tests skipped in that command. An earlier concurrent run failed the
  existing 100ms event-loop histogram timing test; isolated rerun passed without
  modifying that test or execution code.
- Frontend `npm run build && npm test && PLAYWRIGHT_BROWSERS_PATH="/home/prakash/Work/projects/Cal_Spread/scratch/browsers" node scripts/fair_value_browser_test.mjs`:
  exit 0; build, 52 tests, all browser workflows, mobile containment and no page errors.
- Updated backend `npm run build && npm run test:fair-value`: exit 0, 42 feature
  tests after lightweight historical-summary projection and retention reduction.
- `node scripts/fair_value_docs_check.mjs`: exit 0; 87 configuration fields,
  13 private routes and 5 quality labels documented.
- `PYTHONPATH="/home/prakash/Work/projects/Cal_Spread_Backend/scratch/quantlib" python3 scripts/fair_value_quantlib.py`:
  exit 0; QuantLib 1.40, 1344 prices / 786 IV comparisons; max error 5.820766091346741e-11.
- `node scripts/fair_value_mongo_test.mjs --box-integration`: exit 0; actual
  MongoDB 8.0.16 configuration/input-history persistence, summary projection,
  retention reduced to one, restart read; all 16 pre-existing Mongo integration
  tests passed on a separate throwaway database with mocked broker adapters.
- `node scripts/fair_value_app_smoke.mjs`: exit 0; actual application startup,
  full/trade/public authorization and invalid analytics config isolation verified;
  dummy credentials, no broker session and paper-only execution.
- `git diff --check`: exit 0 in both repositories before publication.
- Final pre-commit backend `npm run build && npm run test:fair-value && node scripts/fair_value_docs_check.mjs && node scripts/fair_value_app_smoke.mjs && git diff --check`:
  exit 0; 42 feature tests and actual-app smoke passed after the last cache/history changes.
- Final pre-commit frontend build/tests/Chromium/diff checks reran and passed.

## GitHub publication preparation (2026-10-04)

- User explicitly authorized committing/pushing both repositories to main.
- `git fetch origin && git rev-list --left-right --count main...origin/main`:
  both returned `0 0`; no upstream changes to reconcile.
- Backend origin: `Prakash2571/Cal_Spread_Backend`, main baseline `672025e`.
- Frontend origin: `Prakash2571/Cal_Spread`, main baseline `a99914f`.
- `gh auth status`: authenticated as repository owner; no credential recorded here.
- GitHub branch protection API reported both main branches unprotected.
- Both workflow files are read-only CI, with no deployment job. Hook/deployment
  API returned no configured hooks or deployment records. Added Fair Value tests
  and documentation verification to backend CI; frontend CI uses its test loader.
- Feature commits safely pushed with `git push origin main:main`, no force:
  - Backend `168d0b9ddf9f9d3a20fab59dd768817bbebd8ea3`
    ([commit](https://github.com/Prakash2571/Cal_Spread_Backend/commit/168d0b9ddf9f9d3a20fab59dd768817bbebd8ea3)).
  - Frontend `7057ac76debf572447d7237df73cec683b1d9ee5`
    ([commit](https://github.com/Prakash2571/Cal_Spread/commit/7057ac76debf572447d7237df73cec683b1d9ee5)).
- Local HEAD/origin/main and GitHub commits/main API matched for both feature commits;
  both working trees were clean immediately after publication.
- Backend `gh run watch 37183404266 --exit-status`: exit 0, **success**;
  [CI](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/37183404266).
- Frontend `gh run list --branch main --limit 5 --json ...`: feature commit CI
  **success**; [CI](https://github.com/Prakash2571/Cal_Spread/actions/runs/37183402956).
- This receipt is a documentation-only follow-up to the published feature. All
  requested stages and publication verification are complete. No deployment or
  live-trading enablement was performed.

## Reconciliation notes

- CalSpread is `Cal_Spread` + `Cal_Spread_Backend`; `Cal/` is empty.
- Neither repo had project AGENTS.md, WORKFLOW.md or tasks. Backend README exists;
  frontend ADMIN_SETUP.md describes auth, with some stale public/private claims.
- Workspace INDEX.md had unrelated user changes before this task; retained.
- NSE market-timings page retrieved 2026-10-03 lists equity derivatives close 15:40.
  Existing trading modules use 15:30; valuation requires a verified source/time
  policy instead of inheriting either silently. Index final settlement uses the
  underlying index close; stock settlement uses the official underlying VWAP.

## Relevant paths

- `src/fairValue/` (new module), `tests/fairValue/`, `docs/FAIR_VALUE.md`
- `../Cal_Spread/src/fairValue/`, `../Cal_Spread/src/App.tsx`
- Paired frontend task: `../Cal_Spread/tasks/2026-10-03-fair-value/`
