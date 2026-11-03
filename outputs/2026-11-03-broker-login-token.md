# CalSpread automatic Dhan tokens

Implemented locally in `Cal_Spread_Backend` and the paired `Cal_Spread` frontend.

## Behavior

- env_home performs the Dhan login. CalSpread fetches the token with the same
  service-token/TOTP protocol used by Live Index Algo, and saves/restores it in PostgreSQL.
- Automatic fetching starts after `AUTO_LOGIN_TIME` (08:30 IST by default) for missing,
  expiring or rejected tokens. Retry-After, used codes, permanent refusals and token-API
  lockouts are handled explicitly. Prolonged no-token failures surface operator recovery.
- The frontend Dhan browser-consent/redirect flow is removed. Broker → Dhan provides
  automatic status, **Fetch token now**, **Paste access token → Use token**, and **Clear token**.
- Pasting verifies the profile/account/expiry before replacing a session, clears the masked
  input on submission, and never stores the access token in browser storage. A valid manual
  fallback survives restarts and is retained until it nears expiry.
- Both Dhan feed lanes are recycled when a token changes, each with its own subscriptions.
  Late callbacks from a replaced socket cannot clear the new session. Shutdown cancels the
  automatic worker before disposing the runtime or closing PostgreSQL.

## Server setup

Backend `.env` needs `DHAN_CLIENT_ID`, `BROKER_LOGIN_URL`,
`BROKER_LOGIN_CF_CLIENT_ID`, `BROKER_LOGIN_CF_CLIENT_SECRET`, and `DHAN_TOKEN_API_SEED`.
Set `AUTO_LOGIN_TIME` if the default is unsuitable. Use this engine's service credentials
and this account's token API seed. See `.env.example` and `docs/CONFIGURATION.md`.
Migration 0006 adds the stored token source and is applied on startup.

Actual service fetching was not run: private values belong on the operator's server.
The user authorized publication of these changes to both GitHub main branches.
Publication receipts are recorded in `tasks/2026-11-03-broker-login-token/STATUS.md`.

## Verification — 2026-11-03

- Backend `make check` through `scratch/go-migration/check.sh`, with the local test database,
  read-only modules and Asia/Kolkata: **passed**; build/vet/format/module gate and all 32
  tested packages with the race detector and required PostgreSQL.
- Backend `make build`: **passed**, standalone `outputs/calspread` built.
- Frontend `npm run build && npm test`: **passed**, 37 tests, zero skipped.
- Frontend `npm run test:go`: **passed**, seven real-Go/PostgreSQL HTTP workflow groups,
  including service failure, validated/persisted paste, authorization and service recovery.
- Frontend `npm run test:browser`: **passed**, Firefox 157.0, 14 actual React/Go/PostgreSQL
  groups. Token failure/rejection/recovery, input clearing, browser-storage exclusion,
  clear-token pause/resume and mobile containment were verified. Page exceptions and
  blocked remote upstream calls: zero.
- Browser evidence: paired frontend `scratch/go-integration/browser-cGsqYO/report.json`
  and `dhan-token-mobile.png`. Test profiles are isolated from the operator's browser.
- Both repositories: `git diff --check` passed. Locked module files and original golden
  JSON fixtures are unchanged. Private service host was not copied into tracked source.

Jev skill/current docs were followed; `TYPESAFE_API_KEY` was unavailable, so no Jev call
was sent. Session spend: US$0.00. Scheduling/authentication/token decisions are explicit code.

Suggested Git checkpoint after review: `Add automatic Dhan token fetching and paste fallback`.
