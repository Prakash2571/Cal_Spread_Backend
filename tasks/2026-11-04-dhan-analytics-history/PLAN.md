# Plan: Restore analytics history with Dhan active

Task: `2026-11-04-dhan-analytics-history` · Project: Cal_Spread_Backend · Created: 2026-11-04 · Status: [STATUS.md](STATUS.md)

## Goal

Fix the empty ATM-straddle, option/futures OI and OI-change charts and missing
chain baselines shown in the user's CalSpread screenshot while Dhan is active.
Verify recording, historical reconstruction, persistence and broker isolation.
The user explicitly requested making Dhan the default for every analytics path
on this page instead of relying on Zerodha.

## Steps

1. Trace frontend frame/baseline requests and actual backend capture/backfill wiring;
   check the public live status/history endpoints without credentials.
2. Reproduce Dhan-active analytics failure with loopback broker fixtures.
3. Route analytics quotes and capture readiness through the active broker, correct
   any Dhan historical request metadata needed for NIFTY, and isolate token-keyed
   state/cache writes across broker changes.
4. Trigger recovery after broker selection/session restoration or token fetching;
   preserve missing-history/error semantics instead of manufacturing values.
5. Run focused Dhan analytics/restart/switch checks and the required full backend
   build/vet/format/module/PostgreSQL/race suite with the existing local tools.
6. Publish the verified backend changes to GitHub main under the user's earlier
   instruction to push completed CalSpread work; verify the matching CI run.
7. Record the root cause, verified behavior, publication and exact rollout action.

## Completion criteria

- A Dhan-only session can record option/futures OI, ATM straddle and chain baselines
  without Kite credentials being used for data requests.
- Dhan backfill uses correct instrument classes and returns usable price/OI history
  through the current public API contracts.
- Broker/token namespaces do not mix through a switch, a delayed callback or restart.
- Real failure/partial-history handling remains explicit and bounded.
- Focused and required full local checks pass; the delivery report and task status
  record actual commands/results.
- Verified backend changes are published on main and matching GitHub CI succeeds.

## Verification environment

Reuse `scratch/dhan-default-check/check.sh`, Go 1.25.14, the locked module cache
and the repository-owned PostgreSQL 18.6 cluster on 127.0.0.1:55472. Verification
uses the separate `calspread_test` database and generated loopback broker data.
The previous task's successful commands are historical; this change needs its own
verification. Additional dependency installation or deployment needs permission.
