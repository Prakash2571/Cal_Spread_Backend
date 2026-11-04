# CalSpread backend — Go / Chi / PostgreSQL

The backend for the paired [CalSpread frontend](../Cal_Spread/) is a standalone
Go service using Chi and PostgreSQL. PostgreSQL stores trades, ledgers, settings,
broker/admin sessions, captured history and expiring analytics caches. The Box
feature and its order-placement transports have been removed.

## Local setup: start fresh

Requirements: **Go 1.25.x**, **PostgreSQL 18** client/server tools on `PATH`, a C
compiler for race-enabled verification, and
the frontend's Node/npm toolchain. PostgreSQL is local; no data import is required.

From this repository:

```bash
make db-start
cp .env.example .env
# Fill KITE_API_KEY, KITE_API_SECRET, ADMIN_SECRET and ACCESS_SECRET in .env.
make build
./outputs/calspread
```

`make db-start` creates a repository-owned cluster under
`scratch/local-postgres/`, bound to **127.0.0.1:55472**, and creates two empty
databases: `calspread` for the application and `calspread_test` for verification.
The local role is `calspread`; loopback connections use local trust authentication.
Repeated starts reuse this cluster and preserve its data. `make db-stop` stops it;
there is no automatic reset or import operation.

The server applies its embedded SQL migrations on startup. The example binds HTTP
to **127.0.0.1:3001**. Browse the frontend at **http://127.0.0.1:5173** and set its
`VITE_API_BASE_URL=http://127.0.0.1:3001` (origin only, no `/api` suffix).
Configure the Kite app redirect as
`http://127.0.0.1:5173/zerodha/verify`. Dhan uses the shared token service and
does not require a browser login/redirect.

An existing local PostgreSQL can also be used by setting `DATABASE_URL` in `.env`.
Without a usable database the server retains its memory-only fallbacks and reports
persistence-dependent features as unavailable. No broker session is invented at boot.
Kite app credentials remain required by the preserved startup contract; a broker
session is established through the full-admin login workflow.

### Automatic Dhan access tokens

As in Live Index Algo, env_home logs the Dhan account in and this backend fetches
and saves its token. **Dhan is the fresh-start default** (`DEFAULT_BROKER=dhan`);
a broker selection already saved in PostgreSQL takes precedence after a restart.
Set `DHAN_CLIENT_ID`, `BROKER_LOGIN_URL`,
`BROKER_LOGIN_CF_CLIENT_ID`, `BROKER_LOGIN_CF_CLIENT_SECRET` and
`DHAN_TOKEN_API_SEED` in the backend `.env`; `AUTO_LOGIN_TIME` defaults to **08:30 IST**.
Tokens restore from PostgreSQL after restart and refresh automatically within the
daily window. Fetch status and failures are visible in **Broker → Dhan**.

**Options Analytics also follows Dhan:** option/futures OI captures, ATM-straddle
history, minute/day comparison baselines and historical backfills use its data
providers. Successful token fetching/pasting triggers history recovery after boot.
Analytics history is persisted in separate broker namespaces and restored on restart.

For recovery, use **Fetch token now** or **Paste access token → Use token** in that
panel. Pasting also works without the service configured and verifies the token's
account before saving. A working pasted fallback is kept until expiry; clearing a
token pauses automatic fetching for that IST day. Service credentials stay on the
server. See [the token configuration and retry contract](docs/CONFIGURATION.md#dhan-automatic-token-flow).

## Verification

```bash
make check
```

This runs `go build ./...`, `go vet ./...`, a formatting gate, `go mod verify`, and
the full **race-enabled** test suite with PostgreSQL tests required. For the
repository-owned local cluster, supply its separate test database:

```bash
TEST_DATABASE_URL='postgres://calspread@127.0.0.1:55472/calspread_test?sslmode=disable' make check
```

`make test` defaults to that URL. Each database test creates and removes its own
schema; application data is not used as fixture data. The backend tests and checked
JSON goldens run entirely in Go and do not require the retired Node backend.
GitHub CI uses Go 1.25.x and a PostgreSQL 18.0 service with the same mandatory
database/race checks.

The paired frontend runs `npm run build` and `npm test`. Its real-Go HTTP/browser
verification workflow is documented in the frontend README.
The verification-only `cmd/verifyfixture` serves the actual app with generated loopback
broker data and an isolated PostgreSQL test schema; it is not part of the server entry point.

## Retained functionality

### Broker sessions and live market data

- Exactly one active broker, Zerodha or Dhan, with persisted session restoration,
  broker switching and token-namespace invalidation.
- Cached instrument masters, F&O board/stock lookups, REST quote seeds, Dhan
  binary feeds, refcounted subscriptions and two isolated market-data lanes.
- Session-backed SSE avoids large token-list URLs; reconnects keep the session,
  broker/generation changes invalidate it, and slow clients are bounded.
- Futures-lane liveness is tracked independently of analytics scanners.
- Full-admin and trade-access sessions retain their separate privileges. Optional
  passcode/internal-token routes remain disabled when their secrets are blank.

### Calendar spreads and capture/history

- Calendar-spread trade creation, listing, close and delete, touch-priced fills,
  Kite basket margins, virtual contract-note charges and immutable ledger events.
- Risk-free-rate settings, dividends and historical spread/price/OI endpoints.
- Hourly/EOD futures captures, gap-aware backfills, day review, stock-futures
  history and spread summaries.
- NIFTY option chains, OI/buildup baselines, previous-session close, option/futures
  OI frames and retained straddle/spot history. PostgreSQL backs cache write-behind,
  TTL expiry and shutdown flushing; bounded in-process read caches remain in memory.

### Synthetic and Fair Value

- **Synthetic** retains ATM ±1/2/3 same-expiry conversion/reversal pricing,
  one-lot paper entries/exits, saved controls, fill evidence, margins, day P&L,
  history, deletion and SSE. See [the Synthetic guide](docs/SYNTHETIC_FUTURES_ARBITRAGE.md).
- **Fair Value** retains full-admin European option valuation, bid/mid/ask IV,
  SVI/interpolation diagnostics, maturity interpolation, hypothetical calculations,
  independent refits, sensitivity scenarios, exports, history and bounded workers.
  See [the mathematical/configuration guide](docs/FAIR_VALUE.md).

The API consists of **83 retained non-Box routes plus two full-admin Dhan
token-service/paste routes**. Unknown routes,
including `/api/box/*`, return 404. Shared historical `BOX_*` charge/feed-budget
environment names and a few legacy diagnostic JSON names remain for contract
compatibility; they do not enable a Box scanner or live broker order placement.

## Configuration and source layout

- [`.env.example`](.env.example): fresh local configuration.
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md): active server/broker/analytics settings.
- `cmd/server/`: environment, listener and signal handling.
- `internal/app/`: wiring, boot, hooks and ordered shutdown.
- `internal/db/migrations/`: embedded schema migrations; `internal/kv/`: expiring cache.
- `internal/{core,calendar,analytics,captures,synthetic,fairvalue}/`: retained services.
- `internal/{kite,hub,brokers,marketdata}/`: providers, transports, lanes and SSE.
- `internal/parity/testdata/`: pinned original route, shutdown, retained-suite and golden SHA-256 specifications.
- [`docs/REFERENCE_PROVENANCE.md`](docs/REFERENCE_PROVENANCE.md): verified checkpoint and original-source/generator provenance.
- [`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md): numerical implementation attribution.

Migration evidence and intended contract differences are recorded in
[`tasks/2026-10-27-go-postgres-migration/STATUS.md`](tasks/2026-10-27-go-postgres-migration/STATUS.md)
and its reports. Historical task reports describe the pre-migration Node/MongoDB/Redis
implementation; current runtime/setup instructions are this README and the Go guides.

## Process lifecycle

SIGINT/SIGTERM stop discovery/workers, close HTTP connections, stop schedulers/feeds,
flush analytics, finish bounded background writes (including admin-session saves/deletes) and close PostgreSQL last. Shutdown
defaults to 12 seconds; a timeout exits nonzero. Persisted paper positions remain
available for adoption on the next boot. The source retains the previous capture boot
ordering; the next broker login triggers post-login capture/backfill reconciliation.

For the VM deployment at `https://calspread.online`, see
[`deploy/README.md`](deploy/README.md) for the Nginx, Certbot, systemd and PostgreSQL
configuration, service commands and update procedure. The old Node/PM2 deployment
script is retired.

To rebuild and deploy both checkouts on the configured VM, run
`./scripts/deploy.sh` as `calspread`, with both checkouts clean and on `main`.
It pulls backend `main` and builds Go, checks the production database, pulls
frontend `main` and builds the UI, restarts the Go service, reloads Nginx and
verifies HTTPS.
