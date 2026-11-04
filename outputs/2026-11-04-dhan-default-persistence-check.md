# CalSpread Dhan default and restart persistence

Date: 2026-11-04 · Starting backend main: `d3e1be6`

## Result

- **Dhan is now the fresh-start default.** `DEFAULT_BROKER` defaults to `dhan`;
  an explicit value can set the fresh-start fallback. A broker selection already
  saved in PostgreSQL takes precedence after restart.
- **Fetched Dhan tokens persist across backend restarts when PostgreSQL is enabled.**
  Verification retained the exact token, account, source, expiry and login metadata
  through a new registry and new database connections. A standalone Go process
  also restored the saved Dhan token/source/expiry after SIGTERM and restart.
- A healthy saved token is reused. An expired token is discarded and the shared
  service can recover it within the configured daily fetching window.
- Without PostgreSQL, the existing fallback is memory-only and the Dhan status
  explicitly reports `persisted: false`; that token cannot survive restart.

## Implementation and storage path

The shared env_home service performs the actual Dhan login. CalSpread fetches the
token and saves it; restarting CalSpread does not require another login while the
saved token remains valid.

1. `internal/brokers/registry/registry.go`: initialize Dhan with generation 1;
   read `DEFAULT_BROKER` for an explicit fresh-start fallback.
2. `internal/brokers/registry/brokerlogin.go`: fetch and validate the service's
   account/token/expiry reply; `installDhanAccessToken` saves before installing
   the token in memory. A database write error refuses installation.
3. `internal/brokers/registry/store.go`: upsert the single `dhan_session` row with
   id `current`, including access token, account, expiry, login metadata and
   `token_source`. Broker selection is a separate `active_broker` row.
4. `internal/brokers/registry/switch.go`: restore the saved broker selection and
   generation, then restore a valid Dhan token for the configured account.
5. `internal/app/lifecycle.go`: restore before starting the active runtime and
   the automatic token worker. Feed shutdown preserves saved sessions.

Automatic requests use `AUTO_LOGIN_TIME` (08:30 IST by default). Fetching or
pasting a Dhan token preserves an existing saved broker choice; select Dhan in
the Broker panel to change an installation that previously saved Zerodha.

## Verification

Local tooling: checksum-verified Go **1.25.14** and workspace-local PostgreSQL
**18.6**, using the separate `calspread_test` database at `127.0.0.1:55472`.
Broker/service verification used generated loopback fixtures. No real access
token or private service configuration was needed.

Focused checks passed for:

- fresh Dhan default with and without PostgreSQL;
- saved Dhan and saved Zerodha choices, including selection priority over an
  opposite configured fallback;
- new registry/new database pool token restoration and no unnecessary refetch;
- expired-token cleanup and automatic recovery;
- memory-only status and inability to restore an unpersisted token;
- existing account validation, manual fallback, write failure and shutdown cases;
- standalone backend SIGTERM/restart restoration of token source/expiry and
  saved selection/generation.

Required full verification:

```bash
bash scratch/dhan-default-check/check.sh env TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check && bash scratch/dhan-default-check/check.sh make build
```

**Exit 0:** build, vet, formatting, module verification and all **32 tested
packages** passed with race detection and required PostgreSQL tests. The
standalone `outputs/calspread` binary built successfully.

The first full attempt found the downloaded compiler's test sources under
scratch. A scratch-only nested module isolated the verification tools, after
which the complete check above passed. Application module files and pinned
JSON fixtures remain unchanged. Exact focused commands and results are in
[the task status](../tasks/2026-11-04-dhan-default-persistence-check/STATUS.md).

The CI-equivalent `go mod tidy` and module-file diff check also completed with
**exit 0**; `go.mod` and `go.sum` remain unchanged.

## Publication

User authorized pushing the completed backend changes to GitHub main on
2026-11-04. Local verification is complete. Remote main advanced during the check
to `f01ccf2` (deployment-script/docs update); its reviewed changes are being
incorporated before publication and matching CI verification.
