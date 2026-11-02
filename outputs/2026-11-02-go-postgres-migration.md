# CalSpread Go / PostgreSQL migration — verified local handoff

Date: 2026-11-02. Repositories: `Prakash2571/Cal_Spread_Backend` and `Prakash2571/Cal_Spread`.

## Delivered

- Standalone Go/Chi backend serving all **83 retained non-Box route registrations**.
- PostgreSQL is the sole durable/history/session/cache backend, with five embedded
  migrations and expiring cache rows. Fresh local cluster/databases are reproducible.
- Box backend/frontend, MongoDB/Redis clients, old Node runtime/package/deploy scripts,
  source-dependent verification tools and real broker order transports retired.
- Calendar, captures/history, NIFTY analytics, broker switching/data namespaces,
  session-backed tick SSE, Synthetic paper trading and full-admin Fair Value retained.
- Frontend shared broker badges and Synthetic presentation preserved; no hidden Box calls.
- Go/PostgreSQL backend CI and paired frontend real-Go HTTP CI prepared.

Approved scope: fresh local data, no import, local setup/CI, both mains published after
verification. EC2 deployment is handled by the owner.

## Reference and review

Original contract: `1ea1d958ebf5c4a0fc673d786f5ee9638bdffa8d`.
Verified source/generator checkpoint: `8de7ca5`.

The retained audit accounts for **332 original cases**: 250 already covered,
78 completed/strengthened and four explicit N/A cases. Original titles/source hashes,
routes and shutdown steps are frozen independently of retired TypeScript.
All **39 JSON goldens** are unchanged and SHA-256-pinned; Go checks fail for missing
or modified specifications. See `docs/REFERENCE_PROVENANCE.md` and the task audit.

The review combined the retained assertion audit with focused runtime, broker/transport,
resource/lifecycle and real-app persistence/frontend verification. It fixed:

1. A retired Fair Value deadline rejecting a newer job on a reused worker slot.
2. Zerodha futures feed liveness missing after the Box listener was removed.
3. PostgreSQL closing before pending admin-session writes, losing restart persistence.

Each defect was reproduced by a failing regression before its fix. Additional
operational checks cover historical priority/FIFO/pacing/watchdog/cancellation and
Dhan retry/deadline/backoff/pacing. No pricing goldens were changed to fit the port.

## Verification receipts

From backend root (workspace-local retained tool wrapper):

```bash
scratch/go-migration/check.sh make db-start
scratch/go-migration/check.sh make db-status
scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' GOFLAGS=-mod=readonly TZ=Asia/Kolkata make check
scratch/go-migration/check.sh env GOFLAGS=-mod=readonly make build
```

All exited 0. Build, vet, formatting and module verification passed; **31 tested
packages** passed with race detector and mandatory PostgreSQL. The real server
binary passed clean-environment dotenv startup, full/trade permissions, SIGINT/SIGTERM,
18-table/five-migration storage and admin/risk-free-rate restoration after restart.
Module files and all 39 JSON fixtures remained unchanged. The repeated local database
start retained its data. No application data was imported or used as test fixtures.

From frontend root:

```bash
../Cal_Spread_Backend/scratch/go-migration/check.sh npm run build
../Cal_Spread_Backend/scratch/go-migration/check.sh npm test
../Cal_Spread_Backend/scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' npm run test:go
../Cal_Spread_Backend/scratch/go-migration/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' FIREFOX_BIN=/snap/firefox/current/usr/lib/firefox/firefox GECKODRIVER_BIN=/snap/firefox/current/usr/lib/firefox/geckodriver npm run test:browser
```

All exited 0: **37 unit tests, zero skipped**, six real-Go HTTP workflow groups and
**12 Firefox 157.0 workflow groups**. UI JS bundle: 356.20 kB (previously 496.16 kB).

Browser workflows include real admin form/board/Broker/Calendar/Synthetic, saved
settings and original record venue, independent refit, hypothetical maturity
calculation, actual JSON download, history, pause/resume and authorization revocation.
Public/trade browsers made zero valuation requests; no Box calls or uncaught
JavaScript errors. Mobile viewport 390px / document scrollWidth 378px.
One Firefox null-status CORS message followed cancellation of a Synthetic stream;
successful stream open and actual snapshot receipt were separately verified.

Reports/screenshots/downloads are retained in the frontend's ignored
`scratch/go-integration/browser-YQPNFa/`. Verification uses generated loopback data,
actual Go app/authorization/workers and disposable PostgreSQL schemas.
Local `actionlint` was unavailable; workflow structure was reviewed and remote CI
verification will be recorded with publication.

## Local use

Follow the backend and frontend READMEs. PostgreSQL: **127.0.0.1:55472**; example
Go HTTP: **127.0.0.1:3001**; React dev UI: **127.0.0.1:5173**.
Fill `.env` from `.env.example` with the owner's actual app/login credentials.
Run `make build` then `./outputs/calspread`; frontend uses `npm run dev -- --host 127.0.0.1`.

Retained compatibility names include shared option `BOX_*` rate-card/feed-budget
settings and a few historical diagnostic JSON/CSS names. They do not enable Box.
Go workers have bounded inputs/queues/deadlines but cannot kill a timed-out goroutine
or apply Node's per-worker heap cap; late results are discarded. Other intentional
HTTP/storage/lifecycle differences are documented in the task STATUS and stage reports.

## Publication

Reference checkpoint `8de7ca5` is committed locally. Final migration commits/main
pushes and their GitHub CI receipts are the remaining publication step.
