# Go backend configuration

The service loads `.env`, preserving existing environment values unless dotenv override
is explicitly requested. Server/broker secrets remain server-side. Defaults match the
retained contracts; storage is configured by **DATABASE_URL only**.

## Server, database and authentication

| Setting | Default | Meaning |
|---|---|---|
| `HOST` | empty (all interfaces) | Listen address; the local example explicitly uses 127.0.0.1 |
| `PORT` | 3001 | HTTP port |
| `TZ` | process timezone | Local-date compatibility; local setup uses Asia/Kolkata |
| `FRONTEND_URL` | http://localhost:5173 | CORS origin and login redirects; local example uses 127.0.0.1 |
| `DATABASE_URL` | empty | PostgreSQL pool; unavailable/unset enables the retained memory-only fallbacks |
| `ADMIN_SECRET` | empty | Full-admin login secret; blank disables verification |
| `ACCESS_SECRET` | empty | Trade-access login secret |
| `TOKEN_ROUTE_SECRET` | empty | Shared passcode for Kite/Dhan token routes and protected rf read |
| `INTERNAL_TOKEN_SECRET` | empty | Recorder credential for `/api/internal/kite-token` |
| `SHUTDOWN_TIMEOUT_MS` | 12000 | Graceful-shutdown ceiling; invalid/nonpositive uses default |

The repository-local PostgreSQL launcher uses `LOCAL_PG_PORT` (55472), creates
`calspread` and `calspread_test`, and retains data under `scratch/local-postgres/`.
`TEST_DATABASE_URL` selects the separate test database. `REQUIRE_DB_TESTS=1` turns a
missing/unreachable test database into failure rather than a skip.

## Broker data/session settings

| Setting | Default | Meaning |
|---|---|---|
| `DEFAULT_BROKER` | dhan | Fresh-start broker (`dhan` or `zerodha`); a saved PostgreSQL selection takes precedence |
| `KITE_API_KEY`, `KITE_API_SECRET` | required | Kite app credentials, required by startup contract |
| `DHAN_CLIENT_ID` | empty | Dhan account identity for automatic token fetching and validated pasting |
| `BROKER_LOGIN_URL` | empty | Shared env_home HTTPS origin, with no path/query; empty disables automatic fetching |
| `BROKER_LOGIN_CF_CLIENT_ID`, `BROKER_LOGIN_CF_CLIENT_SECRET` | empty | This engine's Cloudflare Access service-token credentials |
| `DHAN_TOKEN_API_SEED` | empty | Account's base32 token-API seed from env_home, not its Dhan login TOTP seed |
| `AUTO_LOGIN_TIME` | 08:30 | IST daily gate for all automatic startup, missing-token, refresh and recovery requests |
| `DHAN_DATA_ENABLED` | true | Dhan market-data access gate |
| `DHAN_HTTP_TIMEOUT_MS` | 8000 | REST request deadline |
| `DHAN_MIN_INTERVAL_MS` | 120 | Minimum REST request spacing |
| `DHAN_MAX_READ_ATTEMPTS` | 3 | Bounded attempts for retryable reads |
| `DHAN_STATIC_PUBLIC_IP` | empty | Expected IP checked against Dhan's whitelist |
| `DHAN_STATIC_IP_EXPECTED` | false | Retained manual declaration/override in capability diagnostics |
| `DHAN_LIVE_TRADING_ENABLED` | false | Retained broker capability diagnostic; no order transport exists in this service |

The Dhan binary feed uses its supported five-level FULL packets. Removed Dhan order
and charge-calculator settings are not runtime options. Broker capability diagnostics
remain distinct from Synthetic's paper-trading/data readiness.

### Dhan automatic token flow

Configure `DHAN_CLIENT_ID` plus the four broker-login values above in the backend's
private `.env`. No service credential belongs in a `VITE_*` variable. The backend
validates the service configuration at startup; invalid settings appear in the
Broker panel and leave the paste-token fallback available.

Dhan is the default when no broker selection has been saved. A previously selected
broker restores from PostgreSQL, even if it differs from `DEFAULT_BROKER`. Fetching
or pasting a Dhan token preserves that selection; choose Dhan in the Broker panel
to switch an existing saved Zerodha installation.

After `AUTO_LOGIN_TIME` every day, including weekends, the backend fetches a missing
token, a token expiring today, or one with under five minutes left. A fresh saved
token is restored/reused after a restart. It validates active tokens with Dhan every
five minutes and recovers rejected ones within the same daily gate. Each token API
request sends only `{client_id, totp}` with the Cloudflare service-token headers,
uses a named user agent and a 20-second timeout, rejects redirects and limits the
reply to 64 KiB. A used TOTP code is retried once after the next 30-second step.

Transient failures honour `Retry-After` with at least a one-minute gap. A prolonged `no_token_yet` failure surfaces
an operator-recovery message after 30 minutes while scheduled retries continue. Wrong
credentials, Cloudflare refusals and `not_configured` stop automatic fetching until
the operator corrects the configuration and requests **Fetch token now** (restart
after editing `.env`). A token API lockout also blocks explicit fetching until its
retry window ends. **Fetch token now** otherwise overrides the daily schedule.

Full-admin frontend controls use `POST /api/dhan/login/broker` to fetch and
`POST /api/dhan/token` with `{accessToken}` to paste. A pasted token is validated
with Dhan's profile endpoint and matched to `DHAN_CLIENT_ID` before installation.
Its stated/JWT expiry is retained; a healthy manual fallback is kept until it nears
expiry rather than immediately overwritten by an automatic fetch. Both token paths
save the session/source to PostgreSQL and recycle both Dhan feed lanes on a changed
token. Without PostgreSQL the session is explicitly reported as memory-only.

**Clear token** removes the saved token and pauses automatic fetching for the rest
of the IST day; an explicit fetch or successful paste resumes the session. Status
contains only account, expiry, source and safe fetch/error metadata, never service
credentials or the access token. The frontend Dhan consent/redirect flow is removed;
the older backend consent endpoints remain compatible for existing callers.

## Capture and analytics

| Setting | Default | Meaning |
|---|---|---|
| `EXTRA_SESSION_DAYS` | empty | Comma-separated IST YYYY-MM-DD trading sessions on weekends |
| `HOURLY_BACKFILL_LOOKBACK_DAYS` | 7 | Hourly capture lookback |
| `DAY_REVIEW_TIME` | 16:30 | IST end-of-day completeness review |
| `FAIR_VALUE_ENABLED` | false | Initial option-valuation enable setting |
| `FAIR_VALUE_DISABLED` | false | Hard disable that saved settings cannot override |
| `FAIR_VALUE_CONFIG_JSON` | empty | Validated initial Fair Value patch; see FAIR_VALUE.md |

Fair Value's full-admin config API controls bounded workers/queues/time budgets, quote
policies, curve/expiry metadata, smile fitting, research limits and history retention.
No expiry-time policy is guessed by default.

## Synthetic controls

| Setting | Default | Meaning |
|---|---|---|
| `SYNTH_STRIKE_LEVEL` | 3 | ATM ±1/2/3 |
| `SYNTH_PAPER_TRADING` | true | Paper entries when RUN, database and feed are ready |
| `SYNTH_MAX_OPEN_POSITIONS` | 0 | Total open cap; 0 is unlimited, one per underlying remains enforced |
| `SYNTH_MIN_EXPECTED_NET_PROFIT` | 500 | Entry net threshold in rupees |
| `SYNTH_SAFETY_BUFFER` | 100 | Rupee allowance |
| `SYNTH_EXPECTED_SLIPPAGE` | 0 | Rupee allowance |
| `SYNTH_INCLUDE_CARRY` | true | Simple-interest premium carry in entry economics |
| `SYNTH_DEFAULT_RF_PCT` | 0 | Fallback risk-free percent |
| `SYNTH_QUOTE_MAX_AGE_MS` | 15000 | Book age bound |
| `SYNTH_FEED_MAX_AGE_MS` | 10000 | Feed liveness bound |
| `SYNTH_MAX_TOKENS` | 750 | Base token budget |
| `SYNTH_SHARE_BOX_BUDGET` | true | Legacy name: use extra dedicated options-feed capacity |
| `SYNTH_LANE_TOKEN_LIMIT` | 3000 | Overall lane cap |
| `SYNTH_MAX_UNDERLYINGS` | 0 | Universe cap; 0 is uncapped within token budget |
| `SYNTH_MAX_PUBLISHED_OPPORTUNITIES` | 150 | Published opportunity limit (minimum 10) |
| `SYNTH_ATM_HYSTERESIS` | .15 | Re-centre band |
| `SYNTH_WINDOW_MIN_INTERVAL_MS` | 15000 | Minimum re-centre interval |
| `SYNTH_EVAL_INTERVAL_MS` | 500 | Evaluation interval (minimum 100) |
| `SYNTH_PUBLISH_INTERVAL_MS` | 1000 | Publication interval (minimum 200) |
| `SYNTH_UNIVERSE_REFRESH_MS` | 900000 | Universe refresh (minimum 60000) |
| `SYNTH_SIGNAL_CONFIRMATIONS` | 2 | New-book confirmations (minimum 1) |
| `SYNTH_REENTRY_COOLDOWN_MS` | 60000 | Per-underlying cooldown |
| `SYNTH_ENABLE_CONVERSION`, `SYNTH_ENABLE_REVERSAL` | true | Directions enabled |
| `SYNTH_SKIP_EXPIRY_DAY` | false | Expiry-day discovery gate |
| `SYNTH_CONVERGENCE_FLOOR` | 100 | Rupee convergence floor |
| `SYNTH_CONVERGENCE_PCT` | .2 | Entry-net fraction |
| `SYNTH_MIN_EXIT_NET_PNL` | 250 | Exit-net floor |
| `SYNTH_PROFIT_CAPTURE_PCT`, `SYNTH_MIN_CAPTURED_PCT` | .75 | Profit/captured fractions |
| `SYNTH_EXPIRY_SAFETY_MINUTES` | 45 | Expiry-day reduction window |

Saved entry threshold, buffer and maximum-open controls override their env defaults.
The API reports whether each settings change was persisted.

## Shared charge/feed compatibility names

`BOX_*` names below are the retained option rate-card/feed-budget names, not Box
execution settings. The Box feature, storage, API and frontend are removed.

| Setting | Default |
|---|---|
| `BOX_BROKERAGE_PER_ORDER`, `BOX_BROKERAGE_MAX_PCT` | 20, 0 |
| `BOX_STT_SELL_PCT`, `BOX_STT_ROUND_NEAREST_RUPEE` | .15, true |
| `BOX_EXCHANGE_TXN_PCT` | .03503 |
| `BOX_IPFT_PER_CRORE`, `BOX_IPFT_PCT` | 50, 0 |
| `BOX_SEBI_PCT`, `BOX_STAMP_DUTY_BUY_PCT`, `BOX_GST_PCT` | .0001, .003, 18 |
| `BOX_STT_TYPE`, `BOX_CHARGE_RATE_VERSION` | stt, zerodha-nse-options-2026-04-01 |
| `BOX_DEDICATED_MARKET_FEED`, `BOX_MAX_SUBSCRIBED_TOKENS` | true, 2200 |
| `SYNTH_FUT_STT_SELL_PCT` | .05 |
| `SYNTH_FUT_EXCHANGE_TXN_PCT` | .00173 |
| `SYNTH_FUT_IPFT_PER_CRORE` | 10 |
| `SYNTH_FUT_STAMP_DUTY_BUY_PCT` | .002 |
| `SYNTH_FUT_CHARGE_RATE_VERSION` | nse-futures-2026-04-01 |

Percent suffixes mean percent, not decimal fractions; IPFT is rupees per crore.
The old MongoDB/Upstash URI/token variables and Box order/arming/calibration
settings are retired. All durable data and expiring caches use PostgreSQL.
