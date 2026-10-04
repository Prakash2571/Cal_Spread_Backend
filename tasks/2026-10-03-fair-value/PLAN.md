# Fair Value — implementation plan

## Goal

An end-to-end, full-admin-only market-consistent European-option valuation module,
paired with the React page in `../Cal_Spread`. Implement the user's mathematical
specification, transparent unavailable states, bounded isolated analytics and
reproducible verification. This estimates current market-consistent model values,
not true prices or future realized volatility.

## Repository inspection and decisions

- Backend: Express 5, strict TypeScript, native Node test runner, worker threads
  available, broker-neutral InstrumentProvider/QuoteProvider, refcounted feeds.
- Frontend: React 18/Vite, manual pathname routing, token-based full/trade roles,
  SVG chart conventions, CSS design tokens. Fair Value requires `full`.
- Existing Mongo and optional Upstash Redis are reusable; model history is separate.
- Both CalSpread repositories were clean at inspection. Workspace INDEX.md already
  had unrelated edits, which must be preserved. No local project instructions or
  active tasks existed; frontend had ADMIN_SETUP.md instead of README.md.
- 2026-10-03 user approved locked npm installs and project-local QuantLib tooling.
- Exact expiry dates come from instrument metadata. User selected **require verified
  configuration** for date-only expiry times because the current NSE 15:40 market
  close conflicts with existing modules' 15:30 assumption. No weekday inference.
- Analytics is disabled by default; admin enablement affects analytics only.
- No broker order API, execution freshness/risk-limit modification or deployment.

## Stages and verification

1. Pricing/IV/quotes/forwards: stable normal tails, total-variance Black, bounds,
   safeguarded inversion statuses, ACT/365F, log-discount curve, robust parity
   estimation and documented forward fallbacks. Test with QuantLib references.
2. Listed slices and page: validated interpolation fallback, immutable versioned
   inputs/results, bounded workers, feed adapter, full-admin endpoints/subscriptions,
   responsive chain/smile/variance/maturity charts, assumptions and detail drawer.
3. Bounded deterministic multi-start raw SVI price-space calibration: nonnegative
   parameters, wing/tail restrictions, adaptive g diagnostics, actual-spacing
   price convexity/parity validation; unavailable/fallback on unsupported fits.
4. Same-k total-variance maturity interpolation, calendar-crossing suppression,
   event-aware forward policy, custom hypothetical valuations; research opt-in and
   bounded strike/maturity extrapolation with revalidation.
5. Leave-one-strike-out refits excluding both sides from forward and calibration,
   snapshot/config keyed bounded cache, documented scenario sensitivity ranges,
   model comparison units and bounded durable history.

Complete each stage with its focused tests/build and update STATUS.md. Final checks:
backend suite, frontend suite/build, HTTP/admin/security/worker-failure tests and
browser workflow when tooling is available. Document actual commands/results,
all configuration/formulas/labels/assumptions and any unverified production limits.

## Completion criteria

- Admin navigation text exactly `Fair Value` and dedicated protected page/APIs.
- All five stages implemented, with structured unavailable/error states.
- Analytics CPU work isolated; publication consistent across broker/config generations.
- Mathematical tests include independent established-library values and failures.
- Formula/configuration/limitations guide and paired-repo handoff updated.
- No deployment, orders, commits or pushes performed.

## User-authorized publication continuation (2026-10-04)

The user subsequently requested: **"push it to github main safely if not done"**.
After final verification, inspect both repos' status/diff/recent commits, fetch
origin/main, inspect GitHub CI/deployment behavior and stage only this task's
source/tests/docs. Commit and push both repositories to main without force or
amending; verify remote SHAs and GitHub checks. Record publication receipts in
STATUS.md and the implementation report. Deployment/live trading remains outside
this request. The earlier no-commit/push criterion is superseded only by this
explicit publication request.
