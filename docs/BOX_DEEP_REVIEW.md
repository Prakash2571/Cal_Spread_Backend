# Box model — deep review findings and follow-up closure

This is the durable record of the Box defect-hunting review across accounting, execution, order state, monitoring, feed authority, and reporting caches. The original findings were point-in-time findings; later safety follow-ups are recorded here so an already-fixed defect is not mistaken for an open risk.

## Fixed in the original review pass

| # | Defect | Consequence | Fix |
|---|---|---|---|
| D1 | `evaluateCandidateIndicative` tested `0 < value < width` | Profitable SHORT boxes were rejected as implausible | Test the direction-signed edge while preserving LONG behavior |
| D2 | Partial-exit persistence rejection escaped its branch | A confirmed close could be lost from the projection and retried into reverse exposure | Route the rejection into `RECOVERY` and the persistence retry path |
| D3 | A confirmed fill without a price defaulted to zero | Fabricated realised P&L and zero-turnover charges | Refuse the quantity and raise an invariant |
| D4 | Live-risk restore omitted `flatten_charges` | Restart could understate daily loss | Include residual-flatten charges in the seed |
| D5 | One cancel failure aborted `cancelWorkingBoxOrders` | Later live legs were never enqueued for cancellation | Attempt every intent, collect failures, then report them |
| D6 | Full-fill checks used `filled_quantity === quantity` | Broker overfill could be misread as underfill and trigger an unwind | Use `>=`; preserve and quarantine overfill as broker truth |
| D7 | Shortfall used a gate threshold as detected edge and net as gross | Attribution described no real economic quantity | Thread detected gross edge explicitly or skip the calculation |

The original regressions are in `tests/box/deepReviewFixes.test.mjs`.

## Follow-up closure of the original deferred findings

| Original finding | Status | Durable correction and evidence |
|---|---|---|
| Partial-exit running P&L re-marked closed legs | **Resolved** (`1b59816`) | Realised gross on closed quantities is frozen per exit attempt; only remaining role quantities are marked. `tests/box/partialExitPnl.test.mjs` proves that movement in a closed leg cannot change running P&L. |
| Residual flattening reused one identity forever | **Resolved** (`a26ea08`, strengthened by `11243df`) | `ResidualLegExposure.flatten_attempt` is durable. Ambiguous or working outcomes retain identity for adoption; a terminal result or applied local no-POST rejection spends exactly one generation. A new attempt for an outstanding remainder gets a new identity. `tests/box/residualFlattenIdentity.test.mjs` covers restart, ambiguity, partials, and pre-POST refusal. |
| `persistOrder` attributed against a stale caller snapshot | **Resolved** (`833873b`) | Persistence stamps the durable pre-write cumulative quantity and returns authoritative pre/post values. Exposure attribution uses that delta, including accepted equal-quantity guarded writes. `tests/box/fillAttribution.test.mjs` covers stale and concurrent snapshots. |
| Paper cancellation could fill an order that never arrived | **Resolved** (`6306b24`) | Only orders that reached the exchange/resting lifecycle can participate in cancel-vs-fill. Pre-submission and in-transport legs cannot fill; arrived orders still model the legitimate race. `tests/box/preArrivalFills.test.mjs` enforces `filled_quantity > 0 => first_fill_at >= arrival_at`. |
| Trade deletion evicted only today's cached row | **Resolved** (`3177fb6`) | Permanent deletion fences, all-day Redis membership eviction, source/fence checks, two-sided invalidation, exact-day proofs, and startup/periodic reconciliation prevent D1/D2/D3 resurrection. `tests/box/pnlArchive.test.mjs` covers late writers, restarts, legacy manifests, and poison-work isolation. |
| Depth-less ticks could establish executable readiness | **Resolved** (`426c906`) | Raw tick liveness and executable-book readiness are separate. Packet-level depth provenance is required; reconnect generation changes invalidate old books, and admission, dequeue, and immediately-pre-POST checks bind submissions to current depth authority. `tests/box/depthReadiness.test.mjs` and adapter/decoder suites cover this. |
| One-lot safety was only implicit | **Resolved** (`d2d4263`) | Candidate lot metadata must be a positive safe integer and match all four instruments; normal entry is exactly one lot. Partial integer remainders remain valid. Malformed restores and broker overfills preserve truth and enter `RECOVERY`. `tests/box/singleLotInvariant.test.mjs` covers entry, restore, reconciliation, and exit quantities. |

## Additional safety closure

- **Exclusive submission ownership (`426c906`).** Only the winner of an applied `CREATED -> SUBMITTING` compare-and-set may POST. Losing managers adopt or reconcile; there is no process-global execution mutex and unrelated work remains concurrent.
- **Pre-POST authority loss (`426c906`).** Feed generation and executable-book stamps are checked after durable intent classification, at dequeue, and after adapter pacing immediately before external mutation. A proven local no-POST refusal is durably `REJECTED`; a CAS loser cannot claim that provenance.
- **Technical fault labels (`4d68cf6`).** Metrics use the fixed bounded taxonomy `reservation_error`, `reservation_authority_unavailable`, `execution_gateway_error`, `execution_simulator_error`, `execution_invariant_error`, `trade_persistence_error`, `position_book_error`, `charge_calculation_error`, `broker_state_error`, and `unknown_internal_error`. Exception text remains bounded diagnostic detail, never a label.
- **Reservation-authority behavior.** Live entry fails closed when required durable authority is unavailable. Paper may continue only as labelled `local_only`. Exposure-reducing exits use the local tier, and residual flattening is never gated behind speculative-entry reservations.
- **Paper/live isolation.** Paper constructs no live manager or mutation-capable adapter; poison-adapter tests pin this. Live remains behind the deployment double gate and disarmed runtime controls.

## STT rounding audit — evidence gap, no arithmetic change

SELL-only STT treatment and entry/exit side reversal are correct. The current implementation rounds the STT head per executed sell order/leg. The original review suggested contract-note-level aggregation, but this repository contains no independent real Zerodha or Dhan contract-note fixture that proves the broker aggregation boundary. Internal prose is not sufficient evidence for a live-money arithmetic change.

Therefore the rounding implementation and golden figures are intentionally unchanged. The open item is to obtain anonymised broker contract-note evidence that identifies whether STT is rounded per order, per segment/note, or on another broker-specific boundary; only then should a separately reviewed migration alter stored charge figures. Dhan rate provenance, reconciliation, and runtime broker-switch consistency also remain evidence/operational risks and must not be hidden by changing STT fixtures without broker evidence.

## Remaining lower-severity risks and parity gaps

- Retry queues still consult the in-memory position book; a future lifecycle that removes positions must preserve confirmed-fill persistence independently.
- Post-hoc final-exit accounting uses synthetic freshness fields. No decision currently consumes them, but readers must not treat the closed-trade liquidity flag as a live quote assertion.
- Dhan's nonterminal resolution branch remains less protective than Kite's in one currently unreachable map-ownership case.
- Real Mongo fill-attribution integration runs only when `BOX_TEST_MONGODB_URI` is supplied. There is not yet a full service-backed Redis+Mongo D1/D2/D3 deletion test, a real engine-to-manager reconnect queue test, or real-broker outage-exit test.
- Paper remains a deterministic approximation of observable retail-feed/broker behavior, not proof of exchange queue position, hidden liquidity, matching order, or market impact.

## Verified invariants — avoid re-auditing without new evidence

- Direction algebra in `math.ts`: `capturedEdge` and gross P&L agree for LONG and SHORT; sides come from direction maps.
- Charge heads: STT sell-only, stamp duty buy-only, GST excludes STT/stamp, and group totals equal rounded leg heads. Rounding granularity remains the evidence gap above.
- Entry slippage and exit charges are not double-counted.
- Missing/NaN margin is excluded; concurrent-margin intervals are half-open.
- Exit thresholds and expiry safety use the intended inclusive boundaries and IST clock.
- Missing or future-dated quotes are never fresh; reducing orders may use the relevant valid one-sided book.
- Monitor failures are isolated per position and `closingIds` prevents duplicate closes.
- `BoundedTtlCache` is bounded; cumulative fills are monotonic and durable guarded writes cannot rewind quantity.
- Terminal overwrite guards retain the legitimate `CANCEL_REQUESTED -> COMPLETE` cancel race.
- LIMIT-only policy, durable reservations, unrelated execution concurrency, and exact partial remainders are preserved.
