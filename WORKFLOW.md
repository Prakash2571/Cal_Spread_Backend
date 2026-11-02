# CalSpread backend workflow

Follow `/home/prakash/Work/WORKFLOW.md`. The Go source lives in `cmd/` and `internal/`;
the paired React frontend is `../Cal_Spread/`. Build with `make build`; verify with
`TEST_DATABASE_URL=<local test database> make check` (required PostgreSQL and race tests).
Use the active broker's providers, subscription coordinator and existing admin role
validation. Local PostgreSQL setup is `make db-start`. No broker order-placement
transport exists; do not add deployment operations to local migration work.

Current cross-repository task: `tasks/2026-10-27-go-postgres-migration/`.
