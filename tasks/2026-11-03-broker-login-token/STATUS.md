# CalSpread automatic Dhan access tokens — status

State: Done
Updated: 2026-11-03
Blockers: none for the verified local implementation
Next action: None for GitHub publication. Configure the documented private server values and verify the real token-service fetch during the operator's separately managed rollout.
WIP override: none

## Discovery

- Backend baseline `3a41c87`, frontend baseline `2ae2b80`; both worktrees were clean.
- Live Index Algo fetches tokens from env_home, stores them, schedules recovery after
  `AUTO_LOGIN_TIME` and provides an operator paste fallback.
- At the starting baseline, CalSpread exposed Dhan consent generation/consumption in its frontend and
  required Dhan app credentials in broker readiness. Its registry already persisted
  sessions in PostgreSQL and owns two market-data lanes.
- New task spans both CalSpread repositories; one Doing record keeps workspace WIP
  at two tasks including the existing GAR task. The workspace helper cannot enumerate
  the legacy nested CAl repositories, so the explicit INDEX links are authoritative.
- Jev skill and current SDK/model docs were read. API key presence check returned
  false; no Jev requests were sent and session spend is US$0.00.

## Checks

- `git status --short && git log -5 --oneline` in both CalSpread repositories: exit 0,
  clean starting worktrees and baselines above.
- `bin/work status` from `/home/prakash/Work`: exit 0; one existing Doing task before
  this task. Existing CAl/env_home index warnings noted.

## Implementation milestone

- Added the shared service client/config/RFC 6238 code, bounded requests, safe errors,
  daily gate, permanent refusal/lockout/Retry-After handling, and owned startup/shutdown
  worker. No app credentials are needed for token-based broker readiness.
- Added full-admin fetch/paste endpoints, profile/account/expiry validation, PostgreSQL
  source persistence (migration 0006), working-manual-token preservation and both-lane
  recycling. Superseded socket callbacks cannot clear a replacement token.
- Removed frontend Dhan consent APIs/redirect handling and browser-login buttons.
  Added automatic status, fetch/recovery, masked paste input and board recovery after
  automatic login. The backend's older consent endpoints retain their compatibility.
- Updated backend/frontend setup docs and added real Go/PostgreSQL/Firefox fixture
  workflows for service failure, invalid/valid paste and service recovery.
- Initial `npm run build && npm test` in the frontend: exit 0; 37 tests passed before the final
  board-recovery/fixture adjustments. Final verification passed below.
- `scratch/go-migration/check.sh env GOFLAGS=-mod=readonly go build ./...`: exit 0.
- `scratch/go-migration/check.sh gofmt -l internal cmd`: exit 0, no files listed.
- `scratch/go-migration/check.sh make db-start`: exit 0; retained repository-owned
  PostgreSQL on 127.0.0.1:55472 resumed without resetting data.
- `scratch/go-migration/check.sh env GOFLAGS=-mod=readonly TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 60s ./internal/brokers/registry`: exit 0 after the new recovery tests and exact readiness-text adaptation; prolonged-no-token/JWT cases passed in the full check below.
- `scratch/go-migration/check.sh env GOFLAGS=-mod=readonly TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s ./internal/brokerlogin ./internal/brokers/registry`: brokerlogin passed; registry initially had an unused test import (corrected).
- An intermediate registry run timed out in the shutdown test's TLS-server cleanup,
  because the fixture handler left the POST body unread. Draining the body and bounding
  fixture cleanup resolved it; worker shutdown/cancellation now passes.
- Original frozen goldens remain unchanged. Their expected readiness explanation is
  adapted only for the intended client-ID-only contract; consent checks stay exact.

## Final verification and delivery

- `scratch/go-migration/check.sh env GOFLAGS=-mod=readonly TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' TZ=Asia/Kolkata make check && scratch/go-migration/check.sh env GOFLAGS=-mod=readonly make build`: exit 0. Build/vet/format/module gate and all 32 tested packages passed with required PostgreSQL/race checks; standalone binary built.
- Frontend `npm run build && npm test`: exit 0, final bundle 359.89 kB, 37 passed, zero skipped.
- Frontend `../Cal_Spread_Backend/scratch/go-migration/check.sh env GOFLAGS=-mod=readonly TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' npm run test:go`: exit 0, seven actual Go/PostgreSQL HTTP groups including the token service and fallback.
- Frontend `../Cal_Spread_Backend/scratch/go-migration/check.sh env GOFLAGS=-mod=readonly TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:browser`: exit 0, Firefox 157.0, 14 groups, zero page errors or remote upstream calls. Invalid paste clears its input, valid paste persists without browser storage, service recovery and clear-token pause/resume work. Mobile containment verified at 390px (document scroll width 378px).
- Browser evidence: paired frontend `scratch/go-integration/browser-cGsqYO/report.json` and token/analytics screenshots. Profiles are separate from the operator's browser. One existing verified Synthetic EventSource navigation-cancellation log was retained by the runner.
- Backend `git status --short && git diff --check && git diff --exit-code -- go.mod go.sum 'internal/**/testdata/*.json'`: exit 0; intended local files only, clean whitespace and unchanged locked modules/frozen JSON goldens.
- Frontend `git status --short && git diff --check && git diff -- src/api.ts src/BrokerPanel.tsx src/App.tsx src/styles.css`: exit 0; intended local changes reviewed, clean whitespace.
- Exact frontend consent API names/redirect guard are absent. The broader `/dhan/verify` text search also matched the retained `/api/dhan/verify-ip`; it is an IP-verification endpoint, not a login redirect.
- Private service hostname content search in CAl source/docs returned no matches.
- Final local-verification report: `outputs/2026-11-03-broker-login-token.md`. No real service fetch was attempted because the required private server values are not in this checkout. Changes were uncommitted at this milestone; publication is now authorized below.
- Suggested Git checkpoint: `Add automatic Dhan token fetching and paste fallback`.
- Jev: no requests, no usage, US$0.00 session spend; missing key blocker disclosed once.
- Final `git diff --check && git status --short` in both repositories: exit 0 after
  receipt/workflow updates. Workspace `git diff --check && bin/work status`: exit 0;
  one unrelated Doing task remains, and the nested CalSpread task/INDEX entries are Done.

## Relevant files

`internal/brokers/registry/`, `internal/brokers/dhan/`, `internal/app/`,
`.env.example`, `docs/CONFIGURATION.md`, `../Cal_Spread/src/BrokerPanel.tsx`,
`../Cal_Spread/src/App.tsx`, `../Cal_Spread/src/api.ts`.

## GitHub publication receipt — 2026-11-03

- User explicitly authorized pushing both repositories to GitHub main on 2026-11-03.
- `git status --short --branch && git diff --stat && git diff --check && git log --oneline -10 && git remote -v`: exit 0 in each repository; only the intended token-service changes are pending, both branches are main and track their corresponding GitHub origin/main.
- `git fetch origin main && git status --short --branch && git log --oneline HEAD..origin/main && git diff`: exit 0 in each repository; remote mains still match the starting baselines. Full tracked diffs reviewed; no rebase or merge is needed.
- `gh auth status`: exit 0; GitHub authentication is available for publication.
- Frontend CI uses backend main for the actual-Go integration, so backend publication precedes frontend publication. Local runtime checks already passed above; subsequent edits are publication records only.
- Reviewed/staged only the intended files; `git diff --cached --check` passed in both repositories. The private-host/key signature scan returned no matches; `.env`, token caches, compiled output and scratch fixtures are not staged.
- Backend `git commit -m "Fetch Dhan tokens from shared login service"`: exit 0, runtime `cb409be2caaa84fb60c47478617b3be3d30a0626`.
- Frontend `git commit -m "Replace Dhan login with token-service controls"`: exit 0, runtime `4749fd0e5dabb4efa1d9e6c7125cf94b4aee6d90`.
- `git push origin main && git status --short --branch && git rev-parse origin/main`: exit 0 in backend then frontend; both clean and matched GitHub origin/main immediately after their pushes.
- `gh run list --branch main --commit <runtime SHA> --workflow ci.yml --event push --json databaseId,headSha,status,conclusion,url`: exit 0 in each repository. The matching runtime runs were found and verified below.
- Backend runtime: [cb409be](https://github.com/Prakash2571/Cal_Spread_Backend/commit/cb409be2caaa84fb60c47478617b3be3d30a0626), published to main.
- Frontend runtime: [4749fd0](https://github.com/Prakash2571/Cal_Spread/commit/4749fd0e5dabb4efa1d9e6c7125cf94b4aee6d90), published to main after the backend.
- Backend `gh run watch 41612009137 --interval 10 --exit-status && gh run view 41612009137 --json headSha,status,conclusion,url,jobs`: exit 0; [CI 41612009137](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41612009137) completed **success**, matched runtime cb409be, and every build/vet/format/race/PostgreSQL/module/artifact step passed.
- Frontend `gh run watch 41612028944 --interval 10 --exit-status && gh run view 41612028944 --json headSha,status,conclusion,url,jobs`: exit 0; [CI 41612028944](https://github.com/Prakash2571/Cal_Spread/actions/runs/41612028944) completed **success**, matched runtime 4749fd0, and locked build/unit/actual-Go PostgreSQL integration passed against published backend main.
- Publication is complete. The follow-up receipt commit changes this status and the report only; verified runtime source remains cb409be/4749fd0.
