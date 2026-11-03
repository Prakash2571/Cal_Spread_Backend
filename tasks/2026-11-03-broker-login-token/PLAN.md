# CalSpread automatic Dhan access tokens

## Goal

Use the shared env_home broker login service in CalSpread as in Live Index Algo:
fetch and save Dhan access tokens automatically, replace the frontend browser-login
flow with token-service controls, and let a full administrator paste a token when
automatic fetching fails.

## Scope and steps

1. Compare Live Index Algo's broker-login client, scheduled fetching, persistence,
   error handling and frontend fallback with CalSpread's Go registry and React UI.
2. Reuse the token API contract: HTTPS, Cloudflare service-token headers, a token-API
   TOTP code, account validation, bounded requests, Retry-After and permanent-refusal
   handling. Configure everything server-side without embedding private values.
3. Integrate startup/daily/expiry/rejection recovery with the existing Dhan session
   store and both market-data lanes; stop automatic work during shutdown.
4. Add full-admin fetch/paste endpoints. Show safe fetch status, retry and a masked
   paste-token form. Remove the frontend Dhan consent/redirect workflow.
5. Verify meaningful failure/recovery, account, session-persistence and authorization
   cases, then run required backend/frontend and local HTTP/browser checks.
6. Update setup docs and this status record with commands, results and next action.

## Completion criteria

- The frontend no longer starts or consumes a Dhan browser-consent login.
- Configured automatic fetching establishes and persists the correct account's token;
  refreshes obey the daily clock and service retry rules.
- A pasted token is validated before installation, uses the same session/runtime
  path, and is available even when the token service is unavailable or unconfigured.
- Fetch failures are visible without exposing tokens, API seeds, service credentials
  or the private host. No real broker or remote database is used in verification.
- Required local checks pass and both repository changes are reviewable.

## GitHub publication

2026-11-03: the user explicitly requested pushing the changes to GitHub `main`.
Commit the intended changes in both repositories, push the backend first (the
frontend CI checks out backend main), verify both GitHub CI runs, then record the
publication receipt and return this task to Done.

## References

- `../../../../Live_Index_Algo_B/internal/brokerlogin/` and `internal/session/broker.go`.
- Paired frontend: `../../../Cal_Spread/`.
- Private handover: `/home/prakash/engine-token-fetch.md` (never copy private values).
- Jev skill/live docs read; `TYPESAFE_API_KEY` is unavailable in this session.
