# Status: Check Dhan default and token restart persistence

State: Done
Updated: 2026-11-04
Next action: None for implementation and GitHub publication; runtime 890edf1 and its matching CI are verified.
Blockers: none
WIP override: none

Task: `2026-11-04-dhan-default-persistence-check` · Project: Cal_Spread_Backend · Plan: [PLAN.md](PLAN.md)

## Current state

Backend main started clean at `d3e1be6`. The registry now defaults to Dhan, with
`DEFAULT_BROKER` as the fresh-start fallback and persisted selection taking
precedence. Fetched tokens are written synchronously to PostgreSQL before becoming
active in memory. New verification covers fresh registry/pool recovery and a
standalone backend process restart; focused and complete backend verification
passed. A nested scratch-only module isolates the downloaded toolchain from
application package discovery. Runtime `890edf1` is published on GitHub main;
matching GitHub CI `41799017588` completed successfully. This receipt records the
verified runtime; its publication changes documentation only.

## Completed

- Read workspace/project workflow, README and automatic-token task notes.
- Traced `Registry.New`, `Restore`, `StartActiveRuntime`, `StartDhanTokenService`,
  `fetchBrokerToken`, `installDhanAccessToken` and `PGStore` session writes/reads.
- Inspected existing PostgreSQL-backed token restore/manual fallback tests and
  database-write failure handling.
- 2026-11-04: user requested pushing the completed changes to GitHub main.
- 2026-11-04: user explicitly permitted Go/PostgreSQL verification tools and locked
  Go dependencies to be downloaded inside this project's `scratch/` directory.
- Implemented the Dhan default, retained saved-selection priority and documented
  `DEFAULT_BROKER`. Historical Kite/Node fixtures now explicitly start on Zerodha.
- Added checks for new registry/new database connections, saved selections,
  expiry recovery, memory-only status, fresh App startup and actual standalone
  process restoration of the saved Dhan token/source/expiry.
- Downloaded checksum-verified Go 1.25.14 and extracted PostgreSQL 18.6 packages
  inside `scratch/dhan-default-check/`; no global installation/configuration.
- Started the repository-owned local PostgreSQL cluster on 127.0.0.1:55472,
  with separate calspread and calspread_test databases.
- Required full check/build passed: build, vet, formatting, module verification,
  all 32 tested packages with race detection and mandatory PostgreSQL, and the
  standalone server binary.
- Saved the delivery report at `outputs/2026-11-04-dhan-default-persistence-check.md`.
- CI-equivalent `go mod tidy` completed with unchanged go.mod/go.sum.
- A publication-time fetch found remote main advanced to `f01ccf2`; reviewed its
  deployment-script/docs changes before incorporating them into publication.
- Committed the intended files, rebased only that unpublished commit onto
  `f01ccf2`, and pushed runtime `890edf1b9a89aad9908b10d1f1eb259e2b2b114b` to main.
- Verified matching GitHub CI 41799017588: build/vet/format/required PostgreSQL
  and race tests, module-file sync, standalone build and artifact upload succeeded.
- Confirmed zero leftover test schemas, then stopped the owned local PostgreSQL
  process. Cluster data and authorized tools/caches remain in scratch.

## Checks

| When | Command / check | Result |
|------|-----------------|--------|
| 2026-11-04 | Backend `git status --short --branch && git log -5 --oneline` | Exit 0; clean main tracking origin/main at d3e1be6. |
| 2026-11-04 | Workspace `bin/work status` | Exit 0; one existing Doing task. Helper reports existing CAl/env_home index warnings and does not enumerate nested CalSpread repositories. |
| 2026-11-04 | `go version && command -v psql && command -v pg_ctl` | Exit 127 at `go version`: go not found; chained PostgreSQL probes did not run. |
| 2026-11-04 | `command -v go psql pg_ctl initdb gcc cc docker node python3` | Exit 0 because the final python3 lookup succeeded; only gcc, cc, node and python3 were found. Go/PostgreSQL/docker lookups returned no executable. |
| 2026-11-04 | `env GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOFLAGS=-mod=readonly TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 180s -run 'TestAutomaticTokenWindowSaveAndRestore\|TestPastedFallbackValidationPersistenceAndExpiry\|TestTokenSaveFailureDoesNotInstallAndRejectedServiceTokenDoesNotReconnect\|TestPGStoreGenerationCounter\|TestSwitchAdoptsTheHigherDurableGeneration\|TestTokenWorkerShutdownCancelsPendingFetch' ./internal/brokers/registry` | Exit 127; go executable unavailable, tests did not run. |
| 2026-11-04 | `make db-status` | Exit 2; launcher requires pg_ctl on PATH, database availability check did not run. |
| 2026-11-04 | `gh auth status && git fetch origin main && git status --short --branch && git log --oneline HEAD..origin/main` | Exit 0; authenticated GitHub access, fetched main still matches d3e1be6; only this task's notes untracked. |
| 2026-11-04 | `curl --fail --silent --show-error --location --max-time 180 'https://go.dev/dl/go1.25.14.linux-amd64.tar.gz' --output "tools/go-download/go1.25.14.linux-amd64.tar.gz" && sha256sum --check "tools/go-download/go1.25.14.sha256" && tar -xzf "tools/go-download/go1.25.14.linux-amd64.tar.gz" -C "tools" && "tools/go/bin/go" version` from scratch/dhan-default-check | Exit 0; checksum matches the official release manifest; go1.25.14 linux/amd64. |
| 2026-11-04 | `apt download postgresql-18=18.6-0ubuntu0.26.04.1 postgresql-client-18=18.6-0ubuntu0.26.04.1 libpq5=18.6-0ubuntu0.26.04.1` in scratch tooling, followed by `dpkg-deb -x` there and `psql --version` with its private library path | Exit 0; PostgreSQL 18.6 extracted locally; installed system libraries satisfy its runtime dependencies. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh go mod download` | Exit 0; locked Go dependencies downloaded into the project-owned cache. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh make db-start && bash scratch/dhan-default-check/check.sh make db-status` | Exit 0; new repository-owned cluster initialized and is accepting loopback connections on 55472. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh gofmt -d internal/brokers/registry/registry.go internal/brokers/registry/registry_test.go internal/brokers/registry/routes_golden_test.go internal/brokers/registry/brokerlogin_test.go internal/app/harness_test.go internal/app/boot_test.go cmd/server/main_test.go && git diff --check && git diff --stat` | Exit 0; gofmt showed one alignment correction in the standalone test (applied); whitespace diff check succeeded. This was not yet the formatting gate or a test run. |
| 2026-11-04 | Focused race/PostgreSQL/default/restart command below | Exit 0; registry 1.509s, app 1.120s, standalone server 17.327s. Fresh registry/pool, expiry recovery, memory-only reporting, both broker-selection cases and actual SIGTERM restart passed. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh make build` (first full attempt) | Failed at go build ./... package discovery because the downloaded Go compiler's own test files were inside scratch. Later gates/tests and make build did not run in this attempt. Added a scratch-only nested go.mod to exclude tooling from application discovery. |
| 2026-11-04 | `git diff -- internal/brokers/registry/brokerlogin_test.go internal/app/boot_test.go cmd/server/main_test.go && git diff --exit-code -- go.mod go.sum 'internal/**/testdata/*.json'` | Exit 0; behavioral test diffs reviewed; locked modules and frozen JSON fixtures remain unchanged. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh make build` (after scratch-tool isolation) | Exit 0; build/vet/format/module gate and all 32 tested packages passed with required PostgreSQL and race detector; standalone binary built. |
| 2026-11-04 | `git status --short --branch && git diff --check && git log --oneline -10` | Exit 0; intended source/docs/test changes plus this task's notes, clean whitespace, main at starting runtime d3e1be6 before publication. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh go mod tidy && git diff --exit-code -- go.mod go.sum && git diff --check` | Exit 0; CI-equivalent tidy fetched the pinned dependency test helpers into scratch; module files remain unchanged and whitespace check passed. |
| 2026-11-04 | `git fetch origin main && git status --short --branch && git log --oneline HEAD..origin/main && git diff HEAD..origin/main` | Exit 0; origin/main advanced one commit to f01ccf2 (deployment-script/docs update). Reviewed its full diff; local Dhan changes remain intact and will be placed on this updated base before push. |
| 2026-11-04 | Workspace `git diff --check && bin/work status` | Exit 0; preserved pre-existing INDEX edits; helper still reports its existing nested-CAl/env_home enumeration warnings. |
| 2026-11-04 | `git status --short --branch && git diff && git log --oneline -10` | Exit 0; full source diffs and recent history reviewed before staging. New report/plan/status files read separately. |
| 2026-11-04 | Explicit `git add` of the 13 intended files, then `git diff --cached --check && git diff --cached --stat && git diff --cached --name-only && git status --short --branch` | Exit 0; only requested source/tests/setup docs and this task's report/records staged; scratch, application .env and compiled output excluded. |
| 2026-11-04 | `git commit -m "Default to Dhan and verify token restart persistence" && git rebase origin/main && git status --short --branch && git log --oneline -4 && git diff origin/main..HEAD --stat && git diff --check` | Exit 0; unpublished b2b3e64 rebased cleanly onto f01ccf2 as 890edf1; intended 13-file diff retained and clean worktree. |
| 2026-11-04 | `git diff b2b3e64..HEAD -- internal cmd go.mod go.sum .github Makefile scripts/check.sh .env.example docs/CONFIGURATION.md && bash -n scripts/deploy.sh && git push origin main && git status --short --branch && git rev-parse HEAD origin/main && gh run list --branch main --commit "$(git rev-parse HEAD)" --workflow ci.yml --event push --json databaseId,headSha,status,conclusion,url` | Exit 0; verified Go/config/module/check files unchanged by rebase, current deployment script syntax valid, push succeeded and HEAD/origin/main match 890edf1. CI listing was initially empty immediately after push. |
| 2026-11-04 | `gh run list --branch main --commit 890edf1b9a89aad9908b10d1f1eb259e2b2b114b --workflow ci.yml --event push --json databaseId,headSha,status,conclusion,url` | Exit 0; found matching CI 41799017588 in progress. |
| 2026-11-04 | `gh run watch 41799017588 --interval 10 --exit-status && gh run view 41799017588 --json headSha,status,conclusion,url,jobs` | Exit 0; completed success on runtime 890edf1, with every required check/module/build/artifact step successful. |
| 2026-11-04 | `bash scratch/dhan-default-check/check.sh psql --no-psqlrc 'postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' --set=ON_ERROR_STOP=1 --command "select count(*) as remaining_test_schemas from pg_namespace where nspname ~ '^t_[0-9a-f]{12}$'" && bash scratch/dhan-default-check/check.sh make db-stop && git diff --check && git diff --stat` | Exit 0; zero leftover disposable test schemas, owned PostgreSQL stopped with data retained, clean receipt whitespace; only the report/status receipt differs from published runtime. |

## GitHub publication

- Runtime: [890edf1](https://github.com/Prakash2571/Cal_Spread_Backend/commit/890edf1b9a89aad9908b10d1f1eb259e2b2b114b).
- Base: `f01ccf2`, preserving the concurrent deployment-script/docs update.
- Push to backend GitHub main succeeded.
- [CI 41799017588](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41799017588)
  completed **success**, with head SHA matching the published runtime.
- The follow-up publication receipt changes only this STATUS and the report;
  executable source remains the verified runtime `890edf1`.

### Focused verification command

```bash
bash scratch/dhan-default-check/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' REQUIRE_DB_TESTS=1 go test -race -count=1 -timeout 240s -run '^(TestFetchedTokenRestoresAcrossFreshRegistryAndPool|TestFetchedTokenWithoutPostgresIsReportedMemoryOnlyAndDoesNotRestore|TestAutomaticTokenWindowSaveAndRestore|TestPastedFallbackValidationPersistenceAndExpiry|TestTokenSaveFailureDoesNotInstallAndRejectedServiceTokenDoesNotReconnect|TestTokenWorkerShutdownCancelsPendingFetch|TestBootDefaultsToDhanWithoutSavedSelection|TestStandaloneServerLifecycleAndPostgresRestart)$' ./internal/brokers/registry ./internal/app ./cmd/server
```

## Relevant files

- `internal/brokers/registry/{registry.go,switch.go,brokerlogin.go,dhansession.go,store.go,routes.go,brokerlogin_test.go}`
- `internal/app/{app.go,lifecycle.go}`
- `internal/brokerlogin/{client.go,config.go}`
- `deploy/{README.md,calspread.service}`
- `docs/CONFIGURATION.md`
- `outputs/2026-11-04-dhan-default-persistence-check.md`

## Reconciliation notes

- The pre-existing backend INDEX row linked to the absent
  `tasks/2026-11-03-llm-live-stream/`; neither that folder nor its STATUS/PLAN exists
  in this checkout. The backend row now points to this requested review; unrelated
  existing INDEX edits are preserved.
- The previous task notes describe a workspace-local Go/PostgreSQL wrapper under
  `scratch/go-migration/`. This checkout had no `scratch/` directory at the start,
  and those historical successful runs are not current-session verification.
- There is no project-local `AGENTS.md`; the workspace rules and backend WORKFLOW
  supply the applicable guidance.
- Remote main advanced during local verification from `d3e1be6` to `f01ccf2`.
  Its README change is in the deployment section, separate from the Dhan setup
  paragraph modified by this task; the deployment update is preserved.
