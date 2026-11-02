# Kept Node suites → Go coverage audit, resumed 2026-11-02

Source: Node HEAD `1ea1d95`, the unchanged `tests/` files, and [inventory/tests.md](../inventory/tests.md).
This resumes Kiro's 2026-10-30 work, including its 25 later `node_*test.go` files. The previous status did not record those ports.

All **332 kept/conditional cases** are listed by their original titles: **42 Fair Value + 290 shared cases**.
`COVERED` means the applicable assertions already had Go evidence, including Kiro's later ports.
`PORTED` means a missing assertion/vector was added or a weakened comparison was corrected in this session.
`N/A` means the complete case tests a JavaScript-only mechanism or a conditional Box-only wrapper with no retained caller.
Parts of otherwise applicable cases that do not translate are explained in Notes. Dropped Box-only cases are excluded.

The report's references and case accounting are checked by `check-suite-coverage.mjs`. That check verifies completeness
and that the named Go tests exist; manual assertion review and the actual Go test run provide behavioral evidence.
Final full-module verification is recorded in [STATUS.md](../STATUS.md).

## Evidence file references

| Ref | Go test file |
|---|---|
| FM | `internal/fairvalue/model/suites_test.go` |
| FA | `internal/fairvalue/auth_test.go` |
| FE | `internal/fairvalue/engine_test.go` |
| FS | `internal/fairvalue/service_test.go` |
| FNS | `internal/fairvalue/node_service_test.go` |
| FST | `internal/fairvalue/store_test.go` |
| AT | `internal/auth/auth_test.go` |
| ANT | `internal/auth/node_admintoken_test.go` |
| APN | `internal/auth/node_tokenrouteauth_test.go` |
| BC | `internal/boundedcache/boundedcache_test.go` |
| BNC | `internal/boundedcache/node_boundedcache_test.go` |
| BNEW | `internal/boundedcache/node_completion_test.go` |
| BI | `internal/brokers/types_test.go` |
| BNI | `internal/brokers/node_brokeridentity_test.go` |
| RD | `internal/brokers/registry/node_dhanactive_completion_test.go` |
| RDN | `internal/brokers/registry/node_dhanactivenokite_test.go` |
| RBT | `internal/brokers/registry/node_dhanboardjoin_test.go` |
| RH | `internal/brokers/registry/helpers_golden_test.go` |
| DG | `internal/brokers/dhan/helpers_golden_test.go` |
| DNB | `internal/brokers/dhan/node_dhanboardjoin_test.go` |
| DC | `internal/brokers/dhan/feed_golden_test.go` |
| DF | `internal/brokers/dhan/node_dhanfeeddecoder_test.go` |
| DD | `internal/brokers/dhan/node_depthreadiness_test.go` |
| DN | `internal/brokers/dhan/node_completion_test.go` |
| DMG | `internal/brokers/dhan/margin_golden_test.go` |
| DMN | `internal/brokers/dhan/node_dhanmarginandip_test.go` |
| RM | `internal/brokers/registry/node_margin_completion_test.go` |
| RMN | `internal/brokers/registry/node_dhanmarginandip_test.go` |
| RIP | `internal/brokers/registry/node_ip_completion_test.go` |
| RHT | `internal/brokers/registry/node_history_completion_test.go` |
| RHN | `internal/brokers/registry/node_dhansupport_test.go` |
| RI | `internal/brokers/registry/node_indexspot_test.go` |
| RB | `internal/brokers/registry/node_board_completion_test.go` |
| RC | `internal/brokers/registry/registry_test.go` |
| RG | `internal/brokers/registry/routes_golden_test.go` |
| RSN | `internal/brokers/registry/node_singlebroker_test.go` |
| L | `internal/ratecard/ratecard_test.go` |
| LN | `internal/ratecard/node_localcharges_test.go` |
| BS | `internal/brokers/subscriptions_test.go` |
| BSS | `internal/brokers/node_subscriptioncoordinator_test.go` |
| BLN | `internal/brokers/node_marketdatalanes_test.go` |
| BTN | `internal/brokers/node_marketdatatransport_test.go` |
| MS | `internal/marketdata/session_test.go` |
| MSN | `internal/marketdata/node_marketdatatransport_test.go` |
| MC | `internal/marketdata/node_completion_test.go` |
| SD | `internal/lifecycle/shutdown_test.go` |
| SDN | `internal/lifecycle/node_shutdown_test.go` |
| SDC | `internal/lifecycle/node_completion_test.go` |
| H | `internal/hub/hub_test.go` |
| CS | `internal/captures/service_test.go` |
| CSN | `internal/captures/node_trackedtimers_test.go` |
| Q | `internal/quotes/quotes_test.go` |
| QN | `internal/quotes/node_depthreadiness_test.go` |
| QS | `internal/quotes/node_serialize_test.go` |
| QM | `internal/quotes/node_math_test.go` |
| K | `internal/kite/ticker/parse_test.go` |

## `tests/fairValue/auth.test.mjs` — 1 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "router-wide full-admin authorization covers valuation/settings/history/export and SSE" | COVERED | `FA::TestRouterWideFullAdminAuthorization` | All 13 routes × 3 rejected roles, no-store, zero private calls, full token, SSE first frame, revocation and export rejection. |

## `tests/fairValue/hardening.test.mjs` — 8 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "strict configuration rejects unknown/prototype/nonfinite settings and normalizes source timestamps" | COVERED | `FM::TestHardeningStrictConfiguration` | All seven invalid patches and the exact normalized timestamp. |
| "tiny ATM variance is stable and zero-vol ATM vega is its one-sided limit" | PORTED | `FM::TestHardeningTinyAtmVarianceAndZeroVolVega` | Restored strict `< 1e-28` and `vega > 0` semantics; inverse comparisons previously let NaN pass. |
| "incoherent pairs and duplicate instruments never enter smile calibration" | COVERED | `FM::TestHardeningIncoherentPairsAndDuplicatesNeverCalibrate` | +20 outlier, strike exclusion and duplicate token 99999. |
| "analytics yields before a protective subscription and cannot evict shared execution tokens" | COVERED | `FE::TestAnalyticsYieldsBeforeProtectiveSubscription` | Original 4-token upstream cap, shared token 1, drop-before-add order. |
| "broker-neutral fanout retention never consults Kite credentials or opens an inactive socket" | COVERED | `FE::TestFanoutRetentionNeverOpensKite` | Poison credentials callback, idempotent release. |
| "HTTP role revoked during asynchronous analytics returns 403 without result data" | COVERED | `FE::TestRoleRevokedDuringAsyncAnalyticsReturns403` | Channel-controlled pending history and exact 403 JSON. |
| "recent snapshot remains explicitly addressable across publication; changed namespace drops all private current state" | COVERED | `FE::TestRecentSnapshotAddressableAcrossPublication` | Dhan input stamps, retained input id, generation reset and empty token set. |
| "history obeys explicit byte/count/age ceilings" | COVERED | `FE::TestHistoryByteCountAndAgeCeilings` | 20 appends, 2-snapshot/byte ceiling and +2-day expiry. |

## `tests/fairValue/independent.test.mjs` — 3 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "leave-one-strike-out removes both quotes before forwards and fitting, reprices the target" | COVERED | `FM::TestIndependentLeaveOneStrikeOut` | ×10 target quotes; identical independent values/pairs, no target residuals, changed full-surface IV. |
| "leave-one-strike-out returns insufficient data for sparse slices and supported-range endpoints" | COVERED | `FM::TestIndependentInsufficientData` | [95,100,105] and strike 80 endpoint. |
| "sensitivity reports the exact scenario range with documented nonstatistical assumptions" | COVERED | `FM::TestIndependentSensitivityRange` | Seven scenarios, exact min/max and documented assumptions. |

## `tests/fairValue/market.test.mjs` — 6 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "log discount interpolation, D>1, flat assumption and unavailable curve coverage" | PORTED | `FM::TestMarketLogDiscountInterpolationAndCoverage` | Strict error/D>1 checks now reject NaN; original .75 curve and 1e-14 tolerance retained. |
| "quote cleaning rejects stale, crossed, wide, invalid depth and incoherent cross-sections" | COVERED | `FM::TestMarketQuoteCleaning` | All seven invalid quote patches, receive fallback, zero bid and dispersion. |
| "robust multi-pair forward rejects an outlier and exposes interval diagnostics" | PORTED | `FM::TestMarketRobustForwardRejectsOutlier` | NaN can no longer satisfy inverse tolerance/dispersion comparisons; 6 pairs and +100 outlier unchanged. |
| "both target-strike quotes are excluded from forward and insufficient data is explicit" | COVERED | `FM::TestMarketTargetStrikeExcludedAndIncoherentPairs` | Exclude 100, 2 remaining pairs and -5-second incoherence. |
| "matching-expiry futures only; verified continuous/discrete carry and events before expiry" | PORTED | `FM::TestMarketFuturesAndVerifiedCarry` | Restored Node's strict `< 1e-10` for both carry estimates; other-expiry/event refusals covered. |
| "exact timestamp metadata and verified policy, no weekday or silently hardcoded time" | COVERED | `FM::TestMarketExactMetadataAndVerifiedPolicy` | Exact/policy timestamps, American/date-only/invalid calendar/offsetless rejection. |

## `tests/fairValue/maturity.test.mjs` — 5 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "maturity interpolation evaluates both slices at identical k and interpolates total variance" | PORTED | `FM::TestMaturityInterpolationAtSameK` | Exact midpoint variance and hypothetical fields; strict IV comparison now rejects NaN. |
| "listed contracts retain actual IDs/lots; hypothetical strike interpolation and invalid input boundaries" | COVERED | `FM::TestMaturityListedAndHypotheticalContracts` | Listed ×50 units, strike 102, string/zero/style and expired request rejection. |
| "crossing maturity variance curves invalidates the relevant interpolation region without silent repair" | COVERED | `FM::TestMaturityCrossingInvalidatesRegion` | Slice variance ×.1; exact crossing diagnostic and unavailable result. |
| "research opt-in is necessary and distance/negative-forward-variance limits are enforced" | COVERED | `FM::TestMaturityResearchOptInAndLimits` | Original short/long/far dates, strike 200 and negative forward variance. |
| "unsupported carry, dividends and corporate actions cannot silently use event-insensitive maturity interpolation" | COVERED | `FM::TestMaturityUnsupportedCarryAndEvents` | Non-proportional carry and original dividend input; title mentions corporate actions but has no separate assertion for them. |

## `tests/fairValue/pipeline.test.mjs` — 5 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "listed-expiry pipeline preserves snapshot identity and per-unit/lot/IV units" | PORTED | `FM::TestPipelineListedExpiryIdentityAndUnits` | Strict IV/deviation and `dependence <= 1` comparisons now fail on NaN. |
| "unverified date-only expiry returns unavailable reasons, never a guessed weekday/time" | COVERED | `FM::TestPipelineUnverifiedDateOnlyExpiry` | No guessed timestamp; every row unavailable with the original reason. |
| "worker publication is immutable, atomic and cannot cross feed generations" | COVERED | `FE::TestWorkerPublicationImmutableAtomicAndGenerationBound` | JSON unchanged after later ticks, exact receive timestamps, ≤600 tokens and invalidation. `Object.isFrozen`/assignment TypeError are JS-only N/A assertions, as already documented in STATUS. |
| "a stale worker result is discarded and exceptions leave analytics outside execution" | COVERED | `FE::TestStaleWorkerResultDiscardedAndFailuresIsolated` | Explicit channels replace Node's 5ms ordering sleep; old generation discarded, isolated error and caller scheduling retained. |
| "actual worker timeout/crash only rejects bounded analytics jobs" | COVERED | `FE::TestWorkerPoolTimeoutRejectsOnlyTheJob` | Go blocking job replaces an unkillable JS worker loop; same time-budget rejection/failure count and independent work, plus slot recovery. |

## `tests/fairValue/pricing.test.mjs` — 7 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "independent known Black-Scholes price (Hull example) and precise normal tails" | COVERED | `FM::TestPricingKnownBlackScholesAndNormalTails` | Both Hull prices and CDF(-8) at 1e-29. |
| "nonuniform strike grid parity, price bounds, negative rates, deep ITM/OTM" | COVERED | `FM::TestPricingParityBoundsNegativeRatesDeepMoneyness` | Original 3×7×6 grid and tolerances. |
| "zero variance and exact ACT/365F expiry time; settlement is distinguished" | COVERED | `FM::TestPricingZeroVarianceExactYearFractionSettlement` | 1000ms fraction, intrinsic 19, indicative/final/unknown settlement. |
| "IV round trips across puts/calls and maturity, decimal percent units" | COVERED | `FM::TestPricingIvRoundTrips` | Both sides, original strikes/maturities/IVs and 2e-6 tolerance. |
| "IV explicit failures, lower/upper bounds, low vega and bounded expansion" | COVERED | `FM::TestPricingIvExplicitFailures` | All eight original statuses and bounded configs. |
| "frozen Greeks agree with independent central price bumps and explicitly scaled units" | COVERED | `FM::TestPricingFrozenGreeksMatchCentralBumps` | Independent delta/gamma/vega/theta bumps and scaled rho/spot units. |
| "invalid strike/forward/discount/variance/style never produce a price" | COVERED | `FM::TestPricingInvalidInputsNeverPrice` | All six invalid patches and t=0. |

## `tests/fairValue/service.test.mjs` — 1 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "admin HTTP workflow: publish, calculate, independent cache, history, pause, disable and failure isolation" | COVERED | `FS::TestServiceAdminHTTPWorkflow`; `FNS::TestNodeServiceWorkflowStrictPresence` | Kiro's later strict-presence port closes the missing-vs-null/truthy-identity gaps. Original workflow, pointer cache sharing, history limit 2, stale/pause/disable checks retained. |

## `tests/fairValue/storage.test.mjs` — 1 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "unconfigured Mongo is explicitly unavailable; no fabricated persistence success" | COVERED | `FST::TestUnconfiguredStoreIsExplicitlyUnavailable` | PG store without a pool: disabled, null config/snapshot, empty history and memory-only save rejection. |

## `tests/fairValue/svi.test.mjs` — 5 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "analytic SVI derivatives and g match independent finite-difference evaluation" | PORTED | `FM::TestSviDerivativesMatchFiniteDifferences` | Original five k values and tolerances; strict comparisons now reject NaN. |
| "Gatheral-Jacquier / Vogt counterexample satisfies basic constraints but fails butterfly diagnostics" | PORTED | `FM::TestSviVogtCounterexampleFailsButterfly` | `min_g < 0` and checked-point conditions preserve Node's positive assertions. |
| "bounded multi-start SVI fits known smile prices reproducibly with validated support" | PORTED | `FM::TestSviFitsKnownSmileReproducibly` | Strict RMSE, nonnegative butterfly bound and positive extrapolated variance now reject NaN; deterministic parameters retained. |
| "sparse or poorly spread SVI data returns labelled validated interpolation or unavailable" | COVERED | `FM::TestSviSparseDataIsInterpolationOrUnavailable` | Original 5-observation and 2-observation inputs. |
| "price validation detects actual-spacing nonuniform-strike convexity violation" | COVERED | `FM::TestSviPriceValidationUsesActualSpacing` | [80,100,103] / [25,12,9.6]; convexity present and slope violation absent. |

## `tests/box/adminToken.test.mjs` — 7 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a token is a non-empty string" | COVERED | `AT::TestGenerateTokenShape` | Go return type string; 43-character nonempty regex. |
| "a token carries at least 128 bits of entropy" | COVERED | `AT::TestGenerateTokenShape` | Shape exceeds the original ≥22-character floor. |
| "successive tokens differ" | COVERED | `AT::TestGenerateTokenShape` | 500-token uniqueness check includes successive calls. |
| "1000 tokens are all distinct" | COVERED | `ANT::TestNodeAdminTokenThousandTokensAreDistinct` | Kiro's original 1000-token port. |
| "tokens are URL and header safe with no escaping" | COVERED | `AT::TestGenerateTokenShape` | Only ASCII base64url characters; excludes every original unsafe character/escaping case. |
| "a token embeds NO timestamp" | COVERED | `ANT::TestNodeAdminTokenEmbedsNoTimestamp` | Shared suffix <5. |
| "output is not obviously biased" | COVERED | `ANT::TestNodeAdminTokenOutputIsNotObviouslyBiased` | >40 observed characters over 500 tokens. |

## `tests/box/boundedCache.test.mjs` — 9 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a fresh value is returned" | PORTED | `BNEW::TestNodeFreshQuoteArrayIsReturned` | Original quote-array shape, rather than integer-only cache tests. |
| "an expired entry is DELETED, not merely skipped" | COVERED | `BNC::TestNodeExpiredEntryIsDeletedNotSkipped` | +4001ms, no served entry, zero size. |
| "the entry count NEVER exceeds the cap, however many unique keys arrive" | COVERED | `BC::TestCapAndOldestFirstEviction` | 5000 keys and cap 3. |
| "eviction is oldest-first" | COVERED | `BNC::TestNodeEvictionIsOldestFirst` | Original a/b/c/d and b=2/d=4 assertions. |
| "re-setting a key refreshes its eviction position" | COVERED | `BC::TestCapAndOldestFirstEviction` | a=99 survives, b evicted. |
| "expired entries are swept before anything live is evicted" | COVERED | `BNC::TestNodeExpiredSweptBeforeLiveEvictedServesTheFreshValue` | Original old1/old2/fresh values and size 1. |
| "a missing key is undefined and does not create an entry" | COVERED | `BC::TestMissClearAndMinimumCap` | Go's `(value,false)` replaces undefined. |
| "clear() empties the cache" | COVERED | `BC::TestMissClearAndMinimumCap` | Zero size after clearing. |
| "a cap below one is coerced to one rather than disabling the cache" | COVERED | `BC::TestMissClearAndMinimumCap` | cap 0 →1 and b=2 served. |

## `tests/box/brokerIdentity.test.mjs` — 7 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "the broker id set is exactly zerodha and dhan" | COVERED | `BI::TestIdentity` | Exact order and count. |
| "the legacy broker is zerodha" | COVERED | `BI::TestIdentity` | Historical default. |
| "brokerOf resolves an absent, null or unknown broker to zerodha" | COVERED | `BI::TestOfDefaultsToLegacy` | Missing/null map to nil pointer; unknown upstox covered. |
| "brokerOf preserves an explicitly recorded broker" | COVERED | `BNI::TestNodeBrokerOfPreservesAnExplicitlyRecordedBroker` | Both explicit ids. |
| "isBrokerId accepts only the two known ids" | COVERED | `BI::TestIdentity` | Case-sensitive string API; null/number are excluded by Go typing. |
| "parseBrokerId returns null for unknown input rather than defaulting" | COVERED | `BI::TestParseAndLabel` | Trim/lowercase and dynamic invalid input checks. |
| "brokerLabel gives the compact badge text the UI shows" | COVERED | `BI::TestParseAndLabel` | DHAN/ZERODHA. |

## `tests/box/dhanActiveNoKite.test.mjs` — 15 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "active broker is dhan with an authenticated session and NO Kite session" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Original independent-session premise; poison Kite REST dependency. |
| "the instrument universe loads from DHAN, never touching kite.getInstruments" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Original 3-row ASTRAL universe with retained Dhan wire identities. |
| "board-shaped tokens belong to the DHAN namespace" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | 45000/45001/1512 token chain and >1e9. |
| "REST quotes come from DHAN and are keyed by the INTERNAL token" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Every one of the original 3 instruments quoted with positive LTP. |
| "Dhan REST quotes carry executable bid/ask depth" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Original fake quote arithmetic, bid>0 and ask>bid. |
| "SSE subscriptions reach DHAN and create ZERO Kite subscriptions" | COVERED | `RDN::TestNodeSSESubscriptionsReachDhanOnly` | Three tokens, one Dhan subscribe, no Kite events. |
| "the strategy's tokens also route to Dhan only" | COVERED | `RDN::TestNodeNonBrowserFuturesTokensRouteToDhanOnly` | Adapted to the retained analytics owner on the same futures lane. |
| "browser and strategy SHARE a token without duplicating the upstream subscription" | COVERED | `RDN::TestNodeBrowserAndNonBrowserOwnerShareATokenWithoutASecondSubscribe` | Analytics owner replaces Box strategy producer; no duplicate subscribe/unsubscribe. |
| "a KITE token is REJECTED while Dhan is active" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Loaded universe rejects 408065. |
| "a DHAN token is accepted while Dhan is active" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Original ASTRAL first future token accepted. |
| "token assertion is permissive only while the universe is UNLOADED" | COVERED | `RDN::TestNodeTokenAssertionIsPermissiveWhileTheUniverseIsUnloaded` | 408065 accepted before load. |
| "market data reports ready without any Zerodha session" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Dhan's token alone authenticates the market-data provider. |
| "feed health is LIVE only when connected AND subscribed AND ticking" | COVERED | `RDN::TestNodeRegistryFeedHealthIsLiveWhenConnectedSubscribedAndTicking` | All three prerequisites checked. |
| "a connected socket with NOTHING subscribed is not reported as LIVE" | PORTED | `RD::TestNodeDhanProvidersNeverUseKite` | Original universe 18492, null last tick, exact state and detail substring. |
| "with ZERODHA active, a live Dhan session does NOT drive subscriptions" | COVERED | `RDN::TestNodeZerodhaActiveDhanSessionDoesNotDriveSubscriptions` | 408065/408321 go only to Kite; inactive Dhan holds zero tokens. |

## `tests/box/dhanBoardJoin.test.mjs` — 18 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "contract suffixes strip back to the bare underlying" | COVERED | `DG::TestHelpersGolden` | All original suffix vectors in helpers.json. |
| "real NSE symbols are never corrupted by suffix stripping" | COVERED | `DNB::TestNodeRealNSESymbolsSurviveSuffixStripping` | Full original list, including bare BHEL. |
| "hyphenated underlyings survive contract stripping" | COVERED | `DG::TestHelpersGolden` | Both BAJAJ-AUTO examples. |
| "option contract suffixes strip the strike as well" | COVERED | `DG::TestHelpersGolden` | All four original option symbols, including fractional strike. |
| "underlying keys normalize whitespace and case" | COVERED | `DG::TestHelpersGolden` | bhel and nifty-bank whitespace vectors. |
| "futures resolve their underlying from UNDERLYING_SECURITY_ID" | COVERED | `DG::TestParseScripMasterGolden` | Original five-underlying master, every row and exact 15/5 parse counters. |
| "BHEL's stock future normalizes to the expected internal shape" | COVERED | `DG::TestParseScripMasterGolden` | Complete BHEL row from the original master. |
| "BHEL's equity row normalizes to the expected internal shape" | COVERED | `DG::TestParseScripMasterGolden` | Same original master and exact equity row. |
| "FIVE real underlyings produce FIVE board cards, not one" | COVERED | `RBT::TestNodeFiveUnderlyingsProduceFiveBoardCards` | Kiro's parse-to-board port, not separate parse/board fixtures. |
| "every known symbol passes every stage" | COVERED | `RBT::TestNodeEveryKnownSymbolPassesEveryStage` | Five symbols ×3 futures, expiries/lots/onBoard/failsAt. |
| "an unmatched underlying is REPORTED, not silently dropped" | COVERED | `RBT::TestNodeUnmatchedUnderlyingIsReported` | Original ORPHAN master and diagnostic. |
| "checkKnownSymbols names the FIRST failing stage" | PORTED | `RB::TestNodeKnownSymbolNamesTheFirstFailingStage` | Original BHEL-only future with no equity; first failure explicitly names missing NSE equity. |
| "index futures group even without an NSE equity row" | COVERED | `RBT::TestNodeIndexFuturesGroupWithoutAnEquityRow` | Original NIFTY rows through parser and spot map. |
| "an index future keeps the UNDERLYING symbol, not the index's trading symbol" | COVERED | `RBT::TestNodeIndexFutureKeepsTheUnderlyingSymbol` | NIFTY/BANKNIFTY/BHEL and 2 indices +1 equity board. |
| "futures and options get distinct Kite-shaped segments" | COVERED | `DG::TestParseScripMasterGolden` | Full FUT/CE/PE/equity segment projections, including NFO-FUT/NFO-OPT/NSE. |
| "long-dated contracts are excluded and cannot reach the board" | COVERED | `RBT::TestNodeLongDatedContractsCannotReachTheBoard` | Original +3700-day future excluded before board join. |
| "TEST scrips never reach the board even when otherwise well-formed" | COVERED | `RBT::TestNodeTestScripsNeverReachTheBoard` | Original INSETEST master; BHEL only. |
| "internal token round-trips through the whole identity chain" | COVERED | `DG::TestParseScripMasterGolden`; `DG::TestHelpersGolden` | Original BHEL row's namespaced token plus segment/id round trips. |

## `tests/box/dhanFeedDecoder.test.mjs` — 19 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "decodes a TICKER packet" | COVERED | `DC::TestDecodeFeedGolden` | ticker typical uses identical bytes, fields and seconds→ms. |
| "a zero last-trade-time stays ABSENT rather than becoming epoch 0" | COVERED | `DC::TestDecodeFeedGolden` | ticker zero ltt; optional field omitted in packet comparison. |
| "decodes a QUOTE packet including its OHLC block" | COVERED | `DC::TestDecodeFeedGolden` | quote typical uses every original offset/value. |
| "decodes an OI packet" | COVERED | `DC::TestDecodeFeedGolden` | oi typical; price absent. |
| "decodes a PREV_CLOSE packet" | COVERED | `DC::TestDecodeFeedGolden` | prev_close typical, 88.25 and 55555. |
| "decodes a FULL packet: price, OI, volume, OHLC and the depth ladder" | COVERED | `DC::TestDecodeFeedGolden` | full typical uses original two-level ladders and OHLC offsets. |
| "zero-priced depth levels are DROPPED, not reported as ₹0 liquidity" | COVERED | `DC::TestDecodeFeedGolden` | full bid-only/empty-depth vectors. |
| "decodes SEVERAL packets from one frame" | COVERED | `DC::TestDecodeFeedGolden` | Original three packets, ids 111/222/45678. |
| "an UNKNOWN response code is skipped by its declared length, sparing its neighbours" | COVERED | `DC::TestDecodeFeedGolden` | Original unknown 99 then FULL 55.5. |
| "a TRUNCATED packet is reported and does not throw" | COVERED | `DC::TestDecodeFeedGolden` | Original FULL truncated at byte 100. |
| "a packet whose declared length is too short for its type is reported" | COVERED | `DC::TestDecodeFeedGolden` | FULL declared 40. |
| "a non-positive declared length stops the walk instead of looping forever" | COVERED | `DC::TestDecodeFeedGolden` | TICKER length 0 and exact error. |
| "an empty frame is a heartbeat, not an error" | COVERED | `DC::TestDecodeFeedGolden` | Empty packets and errors. |
| "a frame shorter than the header is reported" | COVERED | `DC::TestDecodeFeedGolden` | All lengths 1–7, including the original 7. |
| "a server DISCONNECT packet is surfaced with its code" | COVERED | `DC::TestDecodeFeedGolden` | Original disconnect code 805. |
| "an unknown segment code yields a null segment rather than a wrong one" | COVERED | `DC::TestDecodeFeedGolden` | Original OI segment 99. |
| "toTick uses executable bid/ask and NEVER invents an exchange timestamp" | PORTED | `DN::TestNodeToTickUsesTheExecutableBookWithoutAnExchangeTimestamp` | Original token/book/OI/close and explicit absent exchange timestamp. |
| "toTick reports a missing side as 0 rather than guessing a price" | PORTED | `DN::TestNodeToTickMissingBidIsZero` | Original token 1, 5/4 LTP/close and ask 6. |
| "production Dhan frame handling marks FULL authoritative and retained partial depth non-authoritative" | COVERED | `DF::TestNodeFeedFrameHandlingMarksFullAuthoritativeAndPartialNot` | Original frame builders into real feed and real quote store, unchanged version/at. |

## `tests/box/dhanMarginAndIp.test.mjs` — 44 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a hedge-adjusted total is read from any of Dhan's spellings" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | All three original aliases with total 41250. |
| "span, exposure, F&O and hedge benefit are preserved when present" | COVERED | `DMG::TestMarginPayloadHelpersGolden` | All original heads and values in margin.json. |
| "a payload wrapped in `data` is unwrapped" | COVERED | `DMG::TestMarginPayloadHelpersGolden` | Original data-wrapped total 1234. |
| "an UNREADABLE total returns null, so the caller falls back rather than recording zero" | COVERED | `DMG::TestMarginPayloadHelpersGolden` | {}, null, undefined and abc. |
| "a zero or negative total is NOT a credible four-leg requirement" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original object totals 0 and -5. |
| "the multi-margin request sends its legs under `scripList`" | PORTED | `RM::TestNodeMultiMarginExactWireContract` | Exact ONE_LEG body, one POST, no orders key. |
| "dhanClientId is sent ONCE at the top level, never repeated per leg" | PORTED | `RM::TestNodeMultiMarginExactWireContract` | Original CLIENT7 body, no per-leg id. |
| "the netting flags are always explicit, and default to false" | COVERED | `RMN::TestNodeMultiMarginNettingFlagsAreExplicit` | False defaults and includePosition=true/includeOrder=false. |
| "the body carries exactly Dhan's four fields and nothing more" | PORTED | `RM::TestNodeMultiMarginExactWireContract` | Whole JSON object compared structurally, including nested leg fields. |
| "an unreadable payload is described by FIELD NAME, never by value" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads`; `DMG::TestMarginPayloadHelpersGolden` | Original wrapped errorType/errorMessage plus empty/null descriptions. |
| "the MULTI-ORDER endpoint is preferred over per-leg margins" | PORTED | `RM::TestNodeFourLegBasketMarginContract` | One multi, zero per-leg calls for original four-leg basket. |
| "all FOUR box legs are sent in one request" | PORTED | `RM::TestNodeFourLegBasketMarginContract` | Four ASTRAL legs retained together. |
| "BUY/SELL direction is preserved per leg" | PORTED | `RM::TestNodeFourLegBasketMarginContract` | BUY/SELL/BUY/SELL. |
| "the MARGIN (carry-forward) product is used, never INTRADAY" | PORTED | `RM::TestNodeFourLegBasketMarginContract` | All four MARGIN/NSE_FNO/275/positive-price assertions. |
| "the REAL per-leg price is preferred over the order price" | PORTED | `RM::TestNodeBasketMarginReferencePricesAndZeroPriceFallback` | Original zero order prices with reference 12.5. |
| "a zero-priced leg is never sent, because Dhan rejects one" | PORTED | `RM::TestNodeBasketMarginReferencePricesAndZeroPriceFallback` | Original zero price/null reference; every sent price positive. |
| "the hedge-adjusted total is returned, with span/exposure/benefit preserved" | PORTED | `RM::TestNodeFourLegBasketMarginContract` | 41250/30000/11250/158750 on the original basket. |
| "the multi total is used even though it is FAR below the per-leg sum" | PORTED | `RM::TestNodeFourLegBasketMarginContract` | dhan_multi and total <200000. |
| "a FAILED multi call falls back to the per-leg sum, clearly labelled" | COVERED | `RMN::TestNodeFailedMultiFallsBackToThePerLegSum` | Four per-leg requests, fallback source and nil hedge benefit. |
| "the fallback is CONSERVATIVE — it can never understate the requirement" | COVERED | `RMN::TestNodeFallbackIsConservative` | Original 200000 ≥41250. |
| "an unreadable multi response falls back rather than recording zero" | PORTED | `RM::TestNodeBasketMarginUnreadableAndUnpricedResponses` | {} produces four per-leg calls, fallback label and positive total. |
| "when NOTHING can be priced the result is `unavailable`, not zero margin" | PORTED | `RM::TestNodeBasketMarginUnreadableAndUnpricedResponses` | Both transports fail; unavailable source and total 0. |
| "Zerodha still uses its own basket API, labelled kite_basket" | PORTED | `RM::TestNodeBasketMarginUnreadableAndUnpricedResponses` | Original four-leg basket; no Dhan multi request. |
| "with NO configured IP, readiness falls back to the manual declaration" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Explicit manual-only state and null configured_ip. |
| "with nothing configured at all, it FAILS CLOSED" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Unready IP and trading readiness false. |
| "a configured IP that MATCHES Dhan's primary verifies and becomes ready" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original primaryIP .7 response, verifier/readiness/API evidence true. |
| "a configured IP matching the SECONDARY also verifies" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original .9 secondary response. |
| "a MISMATCHED IP blocks trading and names both sides" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Configured .7 vs original two 198.51.100 addresses; error names both sides. |
| "a configured IP that has NOT been verified yet is NOT ready" | COVERED | `RMN::TestNodeConfiguredButUnverifiedIPIsNotReady` | Original configured .7/manual=true with api_verified=null. |
| "an UNREACHABLE verification call fails closed" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Loopback transport failure replaces stub throw; same verification-failed refusal. |
| "verification without a Dhan session fails closed" | COVERED | `RMN::TestNodeVerificationWithoutASessionFailsClosed` | Original no-session error and zero getIP calls. |
| "the manual flag remains an override that can still BLOCK a verified IP" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original verified .7 plus explicit false. |
| "readiness on the manual flag alone is reported as weaker evidence" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original manual/live flags; problem recommends DHAN_STATIC_PUBLIC_IP. |
| "IPv4 addresses are found under Dhan's dashboard-style ipAddress1/2 keys" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original dashboard payload and NA second slot. |
| "IPv4 addresses are found under primaryIP/secondaryIP keys" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Both original addresses and order. |
| "a `data`-wrapped payload is scanned" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original wrapper and ipAddress1. |
| "an array of addresses is scanned" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original staticIp array. |
| "NA, empty and null slots are skipped, never treated as addresses" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original a/b/c/d payload returns []. |
| "non-IP strings are not mistaken for addresses" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original version/quantity/ratio/invalid IP all rejected. |
| "duplicates are collapsed" | PORTED | `DN::TestNodeMarginAliasesAndDashboardIPPayloads` | Original duplicate .7 values return one address. |
| "the scan is bounded and safe on odd payloads" | COVERED | `DMN::TestNodeIPv4ScanIsSafeOnOddPayloads` | null/undefined/bare IP/42. |
| "verification MATCHES against Dhan's dashboard-style key names" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original dashboard payload reaches real verifier, readiness and primary_ip. |
| "an EMPTY whitelist is reported differently from a mismatch" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original NA slots; error says no IP address and names response fields. |
| "a genuine mismatch lists what Dhan actually has" | PORTED | `RIP::TestNodeStaticIPReadinessAndVerification` | Original two-address mismatch list, unready state. |

## `tests/box/dhanSupport.test.mjs` — 37 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "internal exchanges translate to Dhan segments" | COVERED | `DG::TestHelpersGolden` | NSE/NFO/BSE/MCX translations. |
| "an index resolves to IDX_I regardless of exchange" | COVERED | `DG::TestHelpersGolden` | Explicit index flag and INDICES label. |
| "an unknown exchange returns null rather than guessing a segment" | COVERED | `DG::TestHelpersGolden` | Unknown/empty exchange branch and null result. |
| "segment names and binary codes round-trip" | COVERED | `DG::TestHelpersGolden` | Every code-map entry and unknown 99. |
| "Dhan segments map back to Zerodha-style internal exchange labels" | COVERED | `DG::TestHelpersGolden` | Original NSE_FNO/NSE_EQ/IDX_I labels. |
| "an internal token folds in the SEGMENT so security ids cannot collide" | COVERED | `DG::TestHelpersGolden` | Same ids across every segment produce independently pinned tokens. |
| "an internal token round-trips back to (segment, securityId)" | COVERED | `DG::TestHelpersGolden` | Original 45678 identity plus randomized round trips. |
| "token derivation is STABLE, so positions adopted at boot still match" | COVERED | `DG::TestHelpersGolden` | Deterministic token values for original segment/id. |
| "an unrecognisable token yields null rather than a wrong instrument" | COVERED | `DG::TestHelpersGolden` | Original token 0. |
| "CSV splitting respects quoted commas" | COVERED | `DG::TestHelpersGolden` | Both original quoted comma/escaped quote examples. |
| "expiry formats normalize to ISO, and garbage yields empty rather than a wrong date" | COVERED | `DG::TestHelpersGolden` | All original formats under UTC and IST. |
| "Dhan instrument classes map to Kite's CE/PE/FUT vocabulary" | COVERED | `DG::TestHelpersGolden` | Original four type/option pairs. |
| "the instrument master parses into the internal Instrument shape" | COVERED | `DG::TestParseScripMasterGolden` | Original two-row ASTRAL/HDFCBANK master, full field comparison. |
| "the master parser maps by column NAME, so an added column is harmless" | COVERED | `DG::TestParseScripMasterGolden` | Original NEW_COL master. |
| "a master with no SECURITY_ID column throws instead of returning an empty universe" | COVERED | `DG::TestParseScripMasterGolden` | Original A,B header and exact error. |
| "malformed rows are skipped, not fatal" | COVERED | `DG::TestParseScripMasterGolden` | Original BAD/GOOD25SEP100CE rows. |
| "expiry parses from ms, seconds and ISO strings" | COVERED | `DG::TestHelpersGolden` | Original 1.8e12/1.8e9/ISO inputs. |
| "an unparseable expiry is null, meaning UNKNOWN" | COVERED | `DG::TestHelpersGolden` | Original not-a-date/undefined/null. |
| "an UNKNOWN expiry is NOT treated as expired" | COVERED | `DG::TestHelpersGolden` | nil expiry. |
| "a stated past expiry IS expired, and a future one is not" | COVERED | `DG::TestHelpersGolden` | Past/future/inclusive-now boundaries. |
| "a redacted session NEVER contains the access token" | COVERED | `DG::TestHelpersGolden` | Original C1 session's exact wire projection excludes credentials. |
| "401/403 normalize to an auth error that is NOT retried" | COVERED | `DG::TestHelpersGolden` | Original 401 Invalid token; Go kind/name replaces instanceof. |
| "429 normalizes to a rate-limit error that IS retryable for reads" | COVERED | `DG::TestHelpersGolden` | Rate-limit kind/name and retryable flag. |
| "a 4xx is DEFINITIVE but a 429 is not — the write-safety distinction" | COVERED | `DG::TestHelpersGolden` | 400/404/429/500/network distinctions retained for shared errors. |
| "5xx and network failures are retryable for reads" | COVERED | `DG::TestHelpersGolden` | Original boom 502 and timeout network errors. |
| "Dhan's COLUMN-wise candles transpose into rows" | PORTED | `RHT::TestNodeDhanHistoryColumnsAndOrdering` | Original 100/104/1000/50 columns; exact IST timestamp added. |
| "candles come back oldest-first, matching Kite's ordering" | PORTED | `RHT::TestNodeDhanHistoryColumnsAndOrdering` | Original reversed two-candle input. |
| "a candle with a bad timestamp is dropped rather than dated to 1970" | COVERED | `RHN::TestNodeCandleWithABadTimestampIsDropped` | Kiro's NaN port plus exact surviving candle. |
| "missing columns become 0 rather than undefined" | PORTED | `RHT::TestNodeDhanHistoryColumnsAndOrdering` | Original timestamp-only candle. |
| "long ranges chunk, because Dhan bounds intraday request spans" | PORTED | `RHT::TestNodeDhanHistoryRangeCoverage` | Original January 1–31 range, ≥6 chunks, full/contiguous coverage. |
| "a range within the limit is a single chunk" | PORTED | `RHT::TestNodeDhanHistoryRangeCoverage` | Original January 1–3 range. |
| "exchange TEST scrips are excluded from the universe" | COVERED | `DG::TestParseScripMasterGolden` | Original TEST/RELIANCE master. |
| "implausibly long-dated derivatives are excluded" | COVERED | `DG::TestParseScripMasterGolden` | Original +3736/+26-day master on an injected clock. |
| "EQUITY and INDEX rows are NOT expiry-filtered" | COVERED | `DG::TestParseScripMasterGolden` | Original two spot rows with no expiry. |
| "the parse report records what was found and why rows were skipped" | COVERED | `DG::TestParseScripMasterGolden` | Exact original counters, columns and missing-column array. |
| "the report NAMES missing columns rather than silently reading them empty" | COVERED | `DG::TestParseScripMasterGolden` | Original missing LOT_SIZE/TICK_SIZE master. |
| "the report samples REAL F&O futures, which is what the board needs" | COVERED | `DG::TestParseScripMasterGolden` | Original 12 futures, 8 samples and namespaced tokens. |

## `tests/box/indexSpot.test.mjs` — 10 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "DHAN's index spot resolves from the underlying symbol" | COVERED | `RH::TestIndexSpotGolden` | NIFTY/BANKNIFTY/FINNIFTY under Dhan naming. |
| "ZERODHA's index spot still resolves to the curated name" | COVERED | `RI::TestNodeZerodhaIndexSpotResolvesToTheCuratedName` | Original Kite spot set and all four requested mappings. |
| "the CURATED name wins when both are present" | COVERED | `RH::TestIndexSpotGolden` | Both NIFTY/NIFTY 50 in golden spot set. |
| "every mapped index underlying resolves under BOTH naming conventions" | COVERED | `RI::TestNodeEveryMappedIndexResolvesUnderBothConventions` | Every mapped entry with both singleton spot sets. |
| "an index underlying with NO spot row at all resolves to null" | COVERED | `RH::TestIndexSpotGolden` | Missing-spot set gives null. |
| "a non-index underlying is NEVER matched against an index instrument" | COVERED | `RH::TestIndexSpotGolden` | RELIANCE/VIX/NIFTYIT excluded despite spot presence. |
| "candidates are the curated name then the underlying, deduplicated" | COVERED | `RH::TestIndexSpotGolden` | Exact NIFTY ordering and equal-name custom mapping deduplication. |
| "the index reaches the board under DHAN's naming" | PORTED | `RB::TestNodeIndexBoardNamingAndMissingSpot` | Original two-row NIFTY fixture. |
| "the index reaches the board under ZERODHA's naming" | PORTED | `RB::TestNodeIndexBoardNamingAndMissingSpot` | Original two-row NIFTY 50 fixture. |
| "a missing index spot is reported as a MAPPING problem, not a missing equity" | PORTED | `RB::TestNodeIndexBoardNamingAndMissingSpot` | Original TOTALLY OTHER INDEX fixture and no_index_mapping diagnostic. |

## `tests/box/localCharges.test.mjs` — 11 kept/conditional
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a SELL option leg is charged STT on the premium (rounded to the rupee); a BUY leg is not" | COVERED | `L::TestShippedDefaultsAndInvariants` | Original 75@300, side-only STT/stamp and rounding distinction. |
| "STT rounding is centralised in roundStt and honours the mode flag" | COVERED | `LN::TestNodeSttRoundingHonoursTheModeFlag` | Original 22.5/22.49/mode examples. |
| "brokerage is a flat ₹20 per order and GST is 18% of (brokerage+exchange+SEBI)" | COVERED | `LN::TestNodeBrokerageFlatAndGstOnBrokerageExchangeSebi` | Original arithmetic and independently recorded Node values. |
| "IPFT is modelled as ₹ per crore of premium and folded into the exchange head" | COVERED | `LN::TestNodeIpftPerCroreFoldsIntoTheExchangeHead` | Original ₹1 crore and ₹50. |
| "a leg total equals the sum of its rounded heads" | COVERED | `L::TestShippedDefaultsAndInvariants` | Original 2 sides ×4 prices. |
| "a group total equals the sum of its legs, and each head aggregates" | N/A | — | Conditional Box-only calculateBoxCharges wrapper has no retained caller; Go keeps LegCharges, and Synthetic's own numeric aggregation has separate goldens. computed_by on a removed Box note is not a Go API. |
| "the round trip reverses every side and projects the exit at the entry fills" | N/A | — | Conditional Box-only calculateRoundTrip/reverseOrders wrappers have no retained caller. Shared leg arithmetic/reversed fixture charges and Synthetic's actual Charges implementation are tested independently. |
| "environment overrides feed straight through to the rate card" | COVERED | `L::TestShippedDefaultsAndInvariants` | Rewrite uses LegCharges/Load directly: BOX_STT_SELL_PCT=.05 →11. |
| "the shipped rate card matches the rates in force (post 1 April 2026)" | COVERED | `L::TestShippedDefaultsAndInvariants` | All original rates and rupee rounding. |
| "the rate card is versioned so old results stay interpretable" | COVERED | `L::TestShippedDefaultsAndInvariants` | Exact nonempty dated rate-version string. |
| "no charge head is ever negative, and IPFT is now actually billed" | PORTED | `LN::TestNodeNoChargeHeadIsNegative` | Restored `>= 0` semantics so NaN no longer passes an inverse `< 0` test. |

## `tests/box/marketDataLanes.test.mjs` — 11 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "T1: the futures and box subscription domains stay isolated" | COVERED | `BLN::TestNodeT1LaneDomainsStayIsolated` | Original independent transports, counts and lane names. |
| "T2: a futures token never becomes box-owned" | COVERED | `BLN::TestNodeT2FuturesTokenNeverBecomesBoxOwned` | Original moving futures window; zero second-lane calls. |
| "T3: a box token never pollutes the futures coordinator" | COVERED | `BLN::TestNodeT3BoxTokenNeverPollutesFutures` | Original moving second-lane window leaves board token 111 untouched. |
| "the SAME token in both lanes is refcounted independently" | COVERED | `BLN::TestNodeSameTokenInBothLanesLiveSets` | Original token 555, independent release. |
| "within one lane, refcounting still prevents a duplicate upstream subscription" | COVERED | `BLN::TestNodeWithinOneLaneRefcountingPreventsADuplicateSubscribe` | Original token 900 and last-holder unsubscribe. |
| "T4: a broker switch resets BOTH lanes" | COVERED | `BS::TestLanesAreIsolated` | Original 2/3 dropped-token counts and empty lanes. |
| "T6: each lane replays only its OWN tokens after a reconnect" | COVERED | `BLN::TestNodeT6EachLaneReplaysOnlyItsOwnTokens` | Original separate replay sets. |
| "there are exactly two lanes, and they are named not boolean" | COVERED | `BLN::TestNodeExactlyTwoNamedLanes` | Exact futures/box names; second lane is retained for Synthetic. |
| "lane stats appear per-lane in the coordinator's own summary" | COVERED | `BLN::TestNodeLaneStatsPerLane` | Original lane and token counts. |
| "T27: the tick-rate counter stays bounded under a high tick rate" | COVERED | `BS::TestTickRateCounterStaysBounded` | Original marks/rate plus fixed ring lengths; JS serialized-instance byte count adapted to actual Go storage bounds. |
| "T26: thousands of box subscriptions remain bounded and correct" | COVERED | `BS::TestThreeThousandBoxTokensDiffOnMove` | Original 3000-token sets and exactly 500 new subscriptions. |

## `tests/box/marketDataTransport.test.mjs` — 26 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a full board's token list is accepted in a body" | COVERED | `MS::TestParseTokenList` | Original 816-token board. |
| "token lists are deduplicated" | COVERED | `MSN::TestNodeTokenListsAreDeduplicated` | Original [7,7,8,9,9,9] →[7,8,9]. |
| "only positive integers are accepted" | COVERED | `MSN::TestNodeOnlyPositiveIntegerTokensAreAccepted` | All eight original invalid lists, including NaN/Infinity. |
| "a numeric STRING is rejected rather than coerced" | PORTED | `MC::TestNodeNumericTokenStringIsNotCoerced` | Original ["2000000001"]. |
| "a non-array, empty, or oversized body is rejected" | COVERED | `MS::TestParseTokenList` | nil/object/empty/MAX+1 and Too many tokens. |
| "the token limit comfortably exceeds today's board" | PORTED | `MC::TestNodeTokenLimitAcceptsTwoThousandTokens` | Original 2000-element 1..2000 list is actually parsed successfully. |
| "a session round-trips the whole board" | COVERED | `MS::TestSessionRoundTripAndIDs`; `MSN::TestNodeSSEPathIsTinyForAFullBoard` | Original created/resolved 816-token count. |
| "session ids are opaque, unguessable and unique" | COVERED | `MS::TestSessionRoundTripAndIDs` | Original 50 distinct 32-hex ids. |
| "the SSE path for a session is tiny regardless of token count" | COVERED | `MSN::TestNodeSSEPathIsTinyForAFullBoard` | <100 bytes and no comma for full board. |
| "an unknown session is not_found, so the client mints a new one" | COVERED | `MS::TestSessionRoundTripAndIDs` | Original deadbeef. |
| "a session SURVIVES repeated resolves, so EventSource can reconnect" | COVERED | `MS::TestSessionRoundTripAndIDs` | Five successful resolves. |
| "a session with a LIVE connection is never reaped" | PORTED | `MC::TestNodeLiveSessionResolvesAfterAnHour` | Original one-hour advance, zero sweep and successful subsequent resolve. |
| "an idle session is reaped after its TTL" | COVERED | `MS::TestLiveConnectionsAreNeverReapedAndIdleOnesAre` | 30s/61s TTL boundaries and not_found. |
| "closing one of two connections keeps the session alive" | COVERED | `MS::TestLiveConnectionsAreNeverReapedAndIdleOnesAre` | Two opens, one close, +120s and no reap. |
| "a session from a previous GENERATION is refused" | COVERED | `MS::TestStaleBrokerOrGenerationIsRefusedAndDropped` | Generation 3→4. |
| "a session from a different BROKER is refused" | COVERED | `MS::TestStaleBrokerOrGenerationIsRefusedAndDropped` | Zerodha→Dhan stale_generation. |
| "a refused session is dropped, not left to be retried forever" | COVERED | `MS::TestStaleBrokerOrGenerationIsRefusedAndDropped` | Deleted session and subsequent not_found. |
| "a broker switch drops every session" | PORTED | `MC::TestNodeBrokerSwitchDropsThreeSessions` | Original three sessions and exact dropped=3. |
| "the store is BOUNDED, since unauthenticated callers can create sessions" | COVERED | `MS::TestStoreIsBoundedAndSparesLiveSessions` | Original 40 creates, cap 10. |
| "eviction never kills a session with a live connection" | COVERED | `MS::TestStoreIsBoundedAndSparesLiveSessions` | Original cap 3, 20 new sessions and successful live resolve. |
| "stats report sessions, connections and tokens" | COVERED | `MS::TestStats` | Original 2/1/5 counts. |
| "two browser leases with OVERLAPPING tokens subscribe upstream ONCE" | COVERED | `BTN::TestNodeOverlappingBrowserLeasesSubscribeOnce` | Original exact subscribe call arrays and size 4. |
| "releasing one lease keeps tokens another lease still wants" | COVERED | `BTN::TestNodeReleasingOneLeaseKeepsSharedTokens` | Original unsubscribe calls and sizes 3→0. |
| "a DOUBLE release cannot unsubscribe another client's tokens" | COVERED | `BTN::TestNodeTripleReleaseCannotUnsubscribeAnotherClient` | Original triple release, zero unwanted unsubscribe and final size 0. |
| "a browser lease does not disturb the scanner's tokens" | COVERED | `BTN::TestNodeBrowserLeaseLeavesScannerTokens` | Original 10/11/12 sets and scanner count 1. |
| "a full board lease reports a browser subscription count > 0" | COVERED | `BTN::TestNodeFullBoardLeaseStats` | Original 816/816/1 stats and zero tokens after release. |

## `tests/box/shutdown.test.mjs` — 15 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a second signal does NOT run cleanup twice" | PORTED | `SDC::TestNodeSecondSignalRunsEachStepOnce` | Three callers and original a/b sequence; Go value results compared deeply rather than JS reference identity. |
| "repeated calls after completion still do not re-run steps" | COVERED | `SDN::TestNodeRepeatedCallsAfterCompletionDoNotRerun` | Same first result and one a step. |
| "inProgress flips as soon as shutdown begins" | COVERED | `SDN::TestNodeInProgressFlipsAsSoonAsShutdownBegins` | Before/during/after states. |
| "steps run strictly in the declared order" | PORTED | `SDC::TestNodeShutdownDeclaredOrderAndCompleteReporting` | Original seven arbitrary labels and complete success list. |
| "an async step is awaited before the next begins" | PORTED | `SDC::TestNodeShutdownAwaitsAnAsyncStep` | Original 25ms slow step and explicit finished-before-after check. |
| "a failing step does NOT prevent later steps" | PORTED | `SDC::TestNodeShutdownFailureDoesNotSkipDatabaseClose` | Original failed scanner, later feed/database steps, one failure and original error substring. |
| "every step failing still reaches the end and reports each one" | COVERED | `SDN::TestNodeEveryStepFailingStillReachesTheEnd` | Original a/b/c failures, no completion, no timeout. |
| "a rejected promise is handled like a thrown error" | PORTED | `SDC::TestNodeShutdownRejectedPromiseIsRecorded` | Returned Go error replaces rejected promise; original after/async-fail assertions. |
| "a non-Error throw is still recorded" | COVERED | `SDN::TestNodeNonErrorThrowIsRecorded` | Original bare "a string" preserved from panic. |
| "a hung step does not hang shutdown forever" | PORTED | `SDC::TestNodeHungOnlyStepTimesOut` | Original hung-only/40ms, zero completion and exit 1. |
| "the timeout reports which steps did not finish" | COVERED | `SDN::TestNodeTimeoutReportsWhichStepsDidNotFinish` | Original fast/hung/never-reached and exact timeout log line. |
| "finishing inside the deadline is not a timeout" | PORTED | `SDC::TestNodeQuickStepFinishesInsideItsDeadline` | Original 5ms step/500ms deadline and exit 0. |
| "a step that throws is NOT by itself a failed shutdown" | PORTED | `SDC::TestNodeFailedStepAloneIsNotAFailedShutdown` | Original one noisy failed hook, no timeout and exit 0. |
| "the signal name and duration are reported" | COVERED | `SDN::TestNodeSignalNameAndDurationAreReported` | Original +5ms clock, SIGINT and exact 5ms duration. |
| "an empty step list is a clean no-op" | COVERED | `SDN::TestNodeEmptyStepListIsACleanNoOp` | Empty completion/failure lists, no timeout and exit 0. |

## `tests/box/singleBroker.test.mjs` — 13 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "the default active broker is zerodha" | COVERED | `RG::TestRoutesGolden` | Default broker status/snapshot. |
| "Dhan is reported as not configured when its env vars are absent" | COVERED | `RG::TestRoutesGolden` | Missing credentials and DHAN_API_KEY reason. |
| "switching to an UNCONFIGURED broker is refused" | COVERED | `RC::TestBrokerControlActor`; `RG::TestRoutesGolden` | Original missing API secret; only broker_not_configured blocker. |
| "a switch with NO exposure succeeds and moves the active broker" | COVERED | `RG::TestRoutesGolden` | Idle-Box switch succeeds with exact response/generation changes. |
| "a safe switch TEARS DOWN the old broker before bringing up the new one" | COVERED | `RG::TestRoutesGolden` | Stop/invalidate/reload order; retained StopScanner hook now stops Synthetic. |
| "re-selecting the CURRENT broker is an idempotent no-op success" | COVERED | `RG::TestRoutesGolden` | No teardown/invalidation for re-selection. |
| "while ZERODHA is active, subscriptions go to the Kite hub only" | COVERED | `RG::TestRoutesGolden`; `RDN::TestNodeZerodhaActiveDhanSessionDoesNotDriveSubscriptions` | Adapt raw subscribeTokens to retained coordinator routing. |
| "while DHAN is active, subscriptions do NOT touch the Kite hub" | COVERED | `RG::TestRoutesGolden`; `RDN::TestNodeNonBrowserFuturesTokensRouteToDhanOnly` | Dhan-only upstream route. |
| "Zerodha health has no static-IP concept, reported as null not false" | COVERED | `RG::TestRoutesGolden` | Exact authenticated/trading_ready/null static-IP fields. |
| "Dhan is not trading_ready without a session, even with a static IP" | COVERED | `RSN::TestNodeDhanNotTradingReadyWithoutASessionEvenWithAStaticIP` | Original manual=true with no Dhan session. |
| "a missing static IP is surfaced as an explicit operator problem" | COVERED | `RG::TestRoutesGolden` | False readiness/configured field and explicit problem. |
| "session state is never derived from admin authentication" | COVERED | `RG::TestRoutesGolden` | Full/trade admin roles never authenticate an absent broker session. |
| "the snapshot reports the active broker plus its session and health" | COVERED | `RG::TestRoutesGolden` | Complete snapshot compared, including boolean dhan_configured. |

## `tests/box/subscriptionCoordinator.test.mjs` — 14 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "a first acquire subscribes upstream exactly once" | COVERED | `BS::TestFirstAcquireSubscribesOnce` | Original [1,2,3] and no unsubscribe. |
| "TWO SSE clients with overlapping tokens subscribe each token once" | COVERED | `BS::TestOverlappingClientsSubscribeEachTokenOnce` | Original flattened set and second call [4]. |
| "disconnecting ONE client keeps tokens the other still wants" | COVERED | `BS::TestReleaseKeepsTokensOthersWantAndDropsTheRestAtTheEnd` | Original [1] dropped and [2,3,4] active. |
| "disconnecting the LAST client releases the remaining tokens" | COVERED | `BS::TestReleaseKeepsTokensOthersWantAndDropsTheRestAtTheEnd` | Original last-release set and no active tokens. |
| "a Box scanner token SURVIVES an SSE disconnect" | COVERED | `BS::TestStrategyTokenSurvivesBrowserDisconnect` | Generic retained owner API, original token 100 survives. |
| "refcounts are tracked per owner class" | COVERED | `BS::TestPerOwnerCountsAndDuplicateTokensInOneLease` | Original 2 browser/1 strategy/3 total. |
| "a repeated token within ONE lease counts once" | COVERED | `BS::TestPerOwnerCountsAndDuplicateTokensInOneLease` | Original [5,5,5], one unsubscribe and nil count after release. |
| "a double release is harmless" | COVERED | `BS::TestDoubleReleaseIsHarmless` | Original token 9 still strategy-owned. |
| "setOwnerTokens diffs a moving window without flapping shared tokens" | COVERED | `BS::TestSetOwnerTokensDiffsAWindow` | Original [1] abandoned/[4] added. |
| "setOwnerTokens does not disturb another owner's holdings" | COVERED | `BS::TestSetOwnerTokensLeavesOtherOwnersAlone` | Original shared 2 retained, only 3 dropped. |
| "resetForBrokerSwitch drops everything and issues NO upstream unsubscribe" | COVERED | `BSS::TestNodeResetForBrokerSwitchDropsEverything` | All original dropped/empty/no-unsubscribe assertions. |
| "after a reset, re-registering subscribes cleanly in the new namespace" | COVERED | `BS::TestResetForBrokerSwitchIssuesNoUnsubscribe` | Original new token 2000045678. |
| "stats report per-owner token counts" | COVERED | `BS::TestStatsAndInvalidTokens` | Original browser/scanner/tokens counts. |
| "invalid tokens are ignored rather than subscribed" | COVERED | `BS::TestStatsAndInvalidTokens`; `MSN::TestNodeOnlyPositiveIntegerTokensAreAccepted` | 0/-1 ignored by typed coordinator; NaN cannot enter its int64 API and is rejected by the dynamic transport parser. |

## `tests/box/tickerHubLifecycle.test.mjs` — 1 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "TickerHub emits every socket generation and ignores old warmth" | COVERED | `H::TestHubGolden` | tickerHubLifecycle golden replays the original suite step-for-step: socket states, old ticks/error/close, listener removal. |

## `tests/box/tokenRouteAuth.test.mjs` — 12 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "an UNSET secret disables the route, it never grants access" | COVERED | `APN::TestNodeTokenRouteUnsetSecretDisablesTheRoute` | All original unset/blank/whitespace inputs. |
| "an unset secret is not_configured even when the caller sends nothing" | COVERED | `APN::TestNodeTokenRouteUnsetSecretWithNothingSent` | Empty and absent provided values. |
| "a missing or empty passcode is forbidden" | COVERED | `AT::TestCheckPasscode` | Empty/missing signal; non-string provided values cannot enter Go's typed string API. |
| "the exact passcode is accepted" | COVERED | `AT::TestCheckPasscode`; `APN::TestNodeTokenRouteEndToEnd` | Exact matching, including original secret. |
| "the configured secret is trimmed, the supplied one is NOT" | COVERED | `AT::TestCheckPasscode` | Trimmed configured secret and untrimmed provided mismatch. |
| "near-miss passcodes are refused" | COVERED | `APN::TestNodeTokenRouteNearMissesAreRefused` | All original five variants. |
| "comparison tolerates length differences without throwing" | COVERED | `APN::TestNodeTokenRouteLengthDifferencesDoNotPanic` | Original short/5000-character cases in both directions. |
| "the header wins over the query string" | COVERED | `AT::TestReadPasscode` | Real request, including empty-header precedence. |
| "the query string is used when no header is present" | COVERED | `AT::TestReadPasscode` | Absent header falls back to query. |
| "a repeated header takes the first value, never a joined string" | N/A | `AT::TestReadPasscode` | This directly passes a JS array to a helper. Real Node 22 custom HTTP headers arrive joined with comma-space, already verified/approved on 2026-10-29; Go's HTTP-level test correctly preserves that behavior. |
| "a non-string query value is ignored rather than coerced" | COVERED | `AT::TestReadPasscode` | Repeated query values and absent query are unsupplied; JS object query cannot occur under the retained simple HTTP parser. |
| "end to end: only the real passcode from either source is accepted" | COVERED | `APN::TestNodeTokenRouteEndToEnd` | Original secret from header/query, absent source and wrong-header precedence. |

## `tests/box/trackedTimers.test.mjs` — 4 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "trackInterval returns the handle unchanged" | N/A | — | JavaScript transparent-wrapper identity has no Go API: schedulers are owned by components, rather than a global trackInterval registry. Retained timing and shutdown are tested through actual component schedulers. |
| "clearing stops the timers and empties the registry" | COVERED | `CS::TestStartHourlyAndStartEODActOnlyOnce`; `CS::TestStopDuringABackfillLeavesNothingRunning` | Adapt to owned schedulers: registration-order names, stopped tickers, empty intervals and no work after Stop. |
| "clearing twice is safe and reports nothing the second time" | COVERED | `CS::TestStartHourlyAndStartEODActOnlyOnce` | First stop returns names; second stop returns empty and cannot restart work. |
| "clearing an empty registry is a no-op" | COVERED | `CSN::TestNodeClearingAnEmptyRegistryIsANoOp` | Kiro's empty-service port checks nonnil empty stop results and zero created tickers. |

## `tests/box/math.test.mjs` — 4 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "1. the monitored window is the ATM strike plus three either side" | COVERED | `Q::TestStrikeWindow` | Original 19700/100/11 chain, spot 20120 and exact seven strikes. |
| "2. never more than seven strikes, however long the chain" | COVERED | `QM::TestNodeNeverMoreThanSevenStrikes` | Original 7/11/41/200 lengths and truncated five-strike edge. |
| "ATM is the strike closest to spot, and the strike step is the median gap" | COVERED | `Q::TestAtmStepAndRecentre` | Original closest-strike/empty/median-gap cases. |
| "the ATM window only re-centres once the spot clears the hysteresis band" | COVERED | `Q::TestAtmStepAndRecentre` | Original 20060/20070/19930/zero-step inputs. |

## `tests/box/migrationFixtures.test.mjs` — 1 kept generated replay
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "charges.json: 2 case(s) match the current implementation" | COVERED | `L::TestGoldenFixtureCharges`; `L::TestLegChargesMatchNodeExactly` | Both retained fixture cases' leg/head/total arithmetic and reversed-side charges are exact. Removed Box group source/computed_by labels are N/A; the aggregation helper is test-only. Original Box-wide fixture-directory meta checks adapt to existence and exactly two retained charge cases. |

## `tests/box/depthReadiness.test.mjs` — 8 kept/adapted
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "first LTP-only option tick does not create or notify an executable book" | COVERED | `QN::TestNodeFirstLtpOnlyTickCreatesNoBook` | Original changed/get/count/listener/diagnostic assertions. |
| "LTP-only packet after a book cannot refresh its time, version, or listeners" | COVERED | `QN::TestNodeLtpOnlyPacketAfterABookChangesNothing` | Original same-object/at/no-notification check. |
| "Dhan retained ladders on a partial packet do not refresh executable storage" | COVERED | `DD::TestNodeRetainedLaddersOnAPartialPacketDoNotRefreshTheStore` | Original ToTick provenance into real quote store. |
| "authoritative empty depth invalidates the old book and notifies dependents" | COVERED | `QN::TestNodeEmptyAuthoritativeDepthNotifiesTheToken` | Original [101], absent book, exact token/time notification and counter. |
| "legacy explicit ladders remain authoritative and malformed levels are dropped" | COVERED | `Q::TestLegacyLaddersAndMalformedLevels` | Original malformed ladders, exact surviving levels and dropped=6. |
| "one-sided books support only the relevant reducing side" | COVERED | `QN::TestNodeOneSidedBookIsStored` | Kept bid-only store half; removed Box touchPrice/walkDepth order-execution assertions are N/A. |
| "generation invalidation clears readiness and an LTP packet cannot warm it" | COVERED | `Q::TestGenerationInvalidation` | Original exact diagnostic counters, empty size and null last-update instant. |
| "Zerodha provenance is true only for full packets" | COVERED | `K::TestZerodhaProvenanceTrueOnlyForFullPackets` | Original 8/44/184-byte frames and nonnil empty full ladders. |

## `tests/box/serialize.test.mjs` — 4 kept
| Node case | Result | Go evidence | Notes |
|---|---|---|---|
| "the quote store stamps books with their receive time and ages them out" | COVERED | `Q::TestReceiveTimeAndFreshness` | Original token 42/time 5000/touch/source and freshness boundaries. |
| "a depthless tick must not refresh a good book's timestamp" | COVERED | `QS::TestNodeDepthlessTickDoesNotRefreshTheTimestamp` | Original token 7/time 1000→9000 and continued ageing. |
| "executable books can only enter the store through WebSocket ticks" | COVERED | `QS::TestNodeBooksEnterOnlyThroughWebSocketTicks` | Original token 11, source/version/freshness/forget and no ApplyLadder method. |
| "the spot store tracks the underlying value used to place the ATM window" | COVERED | `Q::TestSpotStore` | Original 20050/time 1000, freshness and ignored zero print. |

## Summary and verification

| Group | Kept/conditional | Already covered | Completed/strengthened here | N/A |
|---|---:|---:|---:|---:|
| Fair Value | 42 | 33 | 9 | 0 |
| Shared suites under tests/box | 290 | 217 | 69 | 4 |
| Total | 332 | 250 | 78 | 4 |

- All applicable retained assertions have Go coverage; no MISSING or PARTIAL case remains in this audit.
- Nine new test files finish original vectors/workflows; inherited numerical assertions were tightened in the Fair Value
  and rate-card tests. Kiro's 25 later test-port files remain part of the evidence.
- Four complete cases are explicitly N/A: two conditional Box charge-note wrappers, JS repeated-header-array helper
  semantics, and JS timer-handle identity. JS freezing/reference identity and removed one-sided Box order-pricing
  assertions are additionally noted at the applicable cases.
- The inherited SSE golden test published its interval event before the ticker channel. That allowed a stream to use
  nil or the previous stream's pinger. `internal/marketdata/routes_golden_test.go` now publishes the channel first.
  Its session-stream replay passed 100 repeated `-race` runs; the subsequent full-module race suite also passed.
- Commands/results, PostgreSQL fixture state and the next user decision are recorded in STATUS.md. The original Node
  build/npm test were not run in this session; no backend node_modules/dist installation was needed for the audit.
