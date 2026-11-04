# Plan: Check Dhan default and token restart persistence

Task: `2026-11-04-dhan-default-persistence-check` · Project: Cal_Spread_Backend · Created: 2026-11-04 · Status: [STATUS.md](STATUS.md)

## Goal

Make Dhan the fresh-start default and verify that access tokens fetched from the
shared login service are durably retained and restored across backend restarts.
Preserve explicit saved broker selections. Publish the verified backend changes
to GitHub main, as authorized by the user on 2026-11-04.

## Steps

1. Read project guidance, current task notes and the actual Git state.
2. Trace initial broker selection, saved selection restoration, token fetching,
   PostgreSQL writes, startup restoration, expiry and shutdown handling.
3. Make Dhan the registry's fresh-start default and add fresh-instance PostgreSQL
   token restoration coverage, including saved selection and expiry behavior.
4. Download workspace-local verification tools and locked Go dependencies under
   `scratch/`, as explicitly permitted by the user on 2026-11-04.
5. Run focused persistence/recovery checks and the required complete backend checks.
6. Review and commit only intended backend changes, push main and verify its CI.
7. Record results, publication receipt and exact next action; update the index.

## Completion criteria

- The actual fresh-start default and saved-selection behavior are identified with
  source references.
- The token storage/restore path and conditions that prevent persistence or reuse
  are documented with source references.
- Dhan is the fresh-start default while a saved Dhan/Zerodha choice still restores.
- Fresh-instance PostgreSQL token restoration, no-database fallback and expired
  token handling are verified by meaningful behavioral checks.
- The required backend build/vet/format/module/PostgreSQL/race checks pass.
- Intended changes are published to GitHub main and the matching CI succeeds.
- A concise review is saved under `outputs/`, and this task's status is updated.

## Checks

- Inspect `git status --short --branch` and `git log -5 --oneline`.
- Run race-enabled registry persistence/recovery tests with the separate local
  test database and mandatory database tests.
- Check local database availability with `make db-status`.
- Run `make check` and `make build` with workspace-local Go/PostgreSQL tools.
- Run `git diff --check` on the resulting review records.
- Inspect status/diff/recent commits before committing; stage only intended files.
- Push backend main and verify the matching GitHub CI run with `gh`.
