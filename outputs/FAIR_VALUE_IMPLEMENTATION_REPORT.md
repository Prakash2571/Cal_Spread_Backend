# Fair Value — implementation and verification

Completed across `Cal_Spread_Backend` and `Cal_Spread`: full-admin `Fair Value`
navigation/page, market-consistent option valuation and all five requested stages.

## Capabilities

- Exact UTC ACT/365F valuation, reliable total-variance Black/IV, frozen Greeks,
  per-unit/actual-lot values, explicit indicative expiry payoff.
- Bid/ask/depth/freshness cleaning, robust parity forwards, supplied log-discount
  curves and explicitly supported forward fallbacks.
- Per-expiry price-Huber multi-start raw SVI, adaptive butterfly/wing/tail and
  price-space checks; validated interpolation or unavailable on failure.
- Same-k total-variance maturity interpolation, explicit forward policy,
  hypothetical strike/expiry calculator and research-only bounded extrapolation.
- Both-side target exclusion, snapshot-keyed bounded independent refits,
  documented scenario sensitivity, comparisons and versioned bounded history.
- Immutable asynchronous worker publication, broker/config/feed fences, priority
  subscription yielding, full-admin HTTP/history/export/stream authorization.
- Responsive chain/charts/detail drawer, configuration/freshness/quality diagnostics,
  pause/refresh controls, lightweight historical summaries and JSON snapshots.

## Verified locally

| Check | Actual result |
|---|---|
| Backend `npm test` | Passed on isolated rerun: 1488 existing unit tests + 42 feature tests; 33 optional existing tests skipped in this command. |
| Frontend `npm run build && npm test` | Build and 52 tests passed. |
| QuantLib 1.40 script | 1344 prices, 786 well-conditioned IV comparisons; max absolute price error 5.820766091346741e-11. |
| Chromium script | Navigation/search/refit/calculator/export/history/pause, mobile containment, no private non-admin requests, zero page errors. |
| MongoDB 8.0.16 script | Settings/history persisted; lightweight summaries, count reduction and restart read passed. |
| Existing Mongo integration | 16/16 passed with `--box-integration`, separate ephemeral database/mock broker. |
| Actual-app smoke | Startup/admin roles and invalid analytics config isolation passed; no broker session. |
| Documentation audit | 87 settings fields, 13 private routes, 5 quality labels documented. |

An earlier concurrent full suite hit the existing short event-loop histogram timing
test; isolated rerun passed. The timing test and execution risk limits were not changed.

## Configuration and limits

Analytics is disabled by default. Date-only broker instruments require a **verified
expiry-time policy** per the user's decision; no 15:30/15:40 assumption is supplied.
A sourced discount curve or explicit flat-rate fallback is also required.
Maturity interpolation requires supported proportional carry assumptions; discrete
events are unavailable for that surface operation. Raw SVI/grid checks are not a
global arbitrage proof. Optional 3D surface and automatic official settlement
retrieval are not implemented. Local verification does not establish production
broker behavior or future realized volatility.

Formula/settings guide: [`../docs/FAIR_VALUE.md`](../docs/FAIR_VALUE.md).
Exact commands, stage history and GitHub receipts:
[`../tasks/2026-10-03-fair-value/STATUS.md`](../tasks/2026-10-03-fair-value/STATUS.md).

## Publication

User requested safe GitHub main publication on 2026-10-04. Both upstream branches
matched their inspected baselines; repository workflows are read-only CI. Feature
commits safely pushed without force:

- Backend [168d0b9](https://github.com/Prakash2571/Cal_Spread_Backend/commit/168d0b9ddf9f9d3a20fab59dd768817bbebd8ea3),
  [CI passed](https://github.com/Prakash2571/Cal_Spread_Backend/actions/runs/37183404266).
- Frontend [7057ac7](https://github.com/Prakash2571/Cal_Spread/commit/7057ac76debf572447d7237df73cec683b1d9ee5),
  [CI passed](https://github.com/Prakash2571/Cal_Spread/actions/runs/37183402956).

Local and GitHub main SHAs matched after publication. No deployment or live-trading
enablement was performed. Analytics remains disabled by default and verified
expiry/discount configuration is still required.
