# Dhan Options Analytics history

Date: 2026-11-04 · Starting backend main: `364cf7f`

## Root cause

The live option chain already used the active broker, but analytics captures and
backfills were wired to `ZerodhaCaptureGate` and direct Kite quote calls. With
Dhan active and no Zerodha session, those recorders deliberately returned before
producing history. The chart endpoints returned successful empty responses, so
the frontend displayed its no-history message while the tick stream stayed Live.

Read-only public checks confirmed Dhan authenticated/data ready/LIVE, an empty
option 1m frame, empty futures contracts/1m frame, and an empty 5m OI baseline.
A local real-App/PostgreSQL reproduction failed on the original wiring with the
explicit Zerodha-only pause log.

## Implemented behavior

- Every Options Analytics data path follows the active broker, which defaults to
  Dhan on fresh starts: full price/OI quotes, option/futures recording, ATM-straddle
  history, all four frame sizes, minute/day baselines and historical reconstruction.
- Dhan full quotes retain OI, price, close and reliable trade-time metadata. Mixed
  index/F&O quote batches are deduplicated and paced with cancellable queue waits.
- Dhan chart reads keep native INDEX/OPTIDX/FUTIDX classes, precise IST intraday
  bounds and explicit timestamp offsets. Upstream errors and missing OI columns
  propagate instead of appearing as known zero history.
- Historical minute OI/close data reconstructs chain snapshots as well as chart
  frames, allowing comparison columns to recover after restart.
- Dhan persistence uses `analytics:dhan:` cache keys. Retained Zerodha keys stay
  separate; pending writes keep their original broker identity through a switch.
- Broker/generation and operation-epoch fencing cancel superseded readers and
  prevent delayed responses from populating a new namespace.
- Active token installation and broker selection trigger coalesced analytics
  recovery after startup. No Zerodha data session is needed for Dhan analytics.
- Unseen option quotes remain partial across captures; missing futures legs remain
  absent rather than being manufactured as zero values.

## Verification

The existing workspace-local Go 1.25.14/PostgreSQL 18.6 tooling and the separate
local `calspread_test` database were reused. Broker/token/history data was generated
on loopback fixtures; no production access token or admin credential was needed.

Verified cases include:

- actual App boot without a broker session followed by Dhan token installation;
- formation of 1m/5m/15m/1h option/futures history and minute/day chain baselines;
- zero Kite data requests in the Dhan-only workflow;
- native request classes, datetime ranges, OI preservation and missing-column errors;
- independent broker caches, pending-write ownership and fresh-service restoration;
- delayed-response rejection, unseeded partials and cancellable quote queue waits;
- fetched-token and broker-selection notifications for common analytics recovery.

Required full command:

```bash
bash scratch/dhan-default-check/check.sh env GOPROXY=off TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh env GOPROXY=off make build && bash scratch/dhan-default-check/check.sh env GOPROXY=off go mod tidy && git diff --exit-code -- go.mod go.sum 'internal/**/testdata/*.json'
```

**Exit 0:** build, vet, formatting, module verification, all 32 tested packages
with required PostgreSQL and race detection, standalone build and module-file sync.
Locked modules and pinned JSON fixtures remain unchanged. Exact focused commands
and intermediate reproduction/polling failures are recorded in
[STATUS.md](../tasks/2026-11-04-dhan-analytics-history/STATUS.md).

## Applying to the live page

Run the existing VM deployment script as the configured `calspread` user after
publication. It pulls backend/frontend main, builds and restarts the Go service.
Startup restores/reconstructs Dhan history; the existing page polls its frame and
baseline APIs. If broker history is unavailable, charts need completed live
buckets, and delta charts need adjacent valid buckets.

## GitHub publication

Runtime [13a0ab8](https://github.com/Prakash2571/Cal_Spread_Backend/commit/13a0ab8aa1d7c23e00cab2d585aea90504032f04)
is published on backend main. The normal push succeeded with a clean worktree;
[matching GitHub CI 41808216441](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41808216441)
completed **success** on that exact runtime. Required PostgreSQL/race, build/vet/format,
module-file sync and standalone binary/artifact checks all passed.

The owned local PostgreSQL process was stopped after verification with its data
retained. This receipt changes documentation only. To activate the fix on the
live page, run `/home/calspread/Cal_Spread_Backend/scripts/deploy.sh` on the VM as
`calspread`, then inspect the chart frame/baseline responses after recovery.

The receipt commit's CI subsequently caught an inherited test-only race in
`TestMemoryOnlyWithoutCache`'s shared log collector. Its writes/read snapshot are
now synchronized: 50 race-enabled repetitions and the full required 32-package
suite/build passed again. Correction `5f7ef23` is published on main, and its
[CI 41810069980](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/41810069980)
completed **success**. The Dhan executable implementation remains `13a0ab8`;
the VM deployment command above is the remaining operator action.
