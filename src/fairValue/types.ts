/** Fair Value units: premiums are INR per underlying unit; IV is a decimal; w is IV²×ACT/365F years. */
export type OptionSide = "CE" | "PE";
export type ContractStyle = "european";
export type QualityLabel = "supported" | "limited" | "research" | "invalid" | "unavailable";

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  strike?: number;
  k?: number;
  value?: number;
}

export interface SourceStamp {
  source: string;
  as_of: string;
  version: string;
  convention: string;
}

export interface ExpiryPolicy extends SourceStamp {
  exchange: "NFO";
  timezone: "Asia/Kolkata";
  local_time: string;
  /** instrument trading symbol -> exact, offset-bearing expiry timestamp */
  overrides: Record<string, string>;
}

export interface OptionMetadata {
  token: number;
  tradingsymbol: string;
  underlying: string;
  exchange: string;
  side: OptionSide;
  strike: number;
  expiry: string;
  expiry_timestamp: string;
  expiry_source: string;
  timezone: string;
  style: ContractStyle;
  settlement_underlying: "official_index_close" | "official_stock_settlement";
  lot_size: number;
  tick_size: number;
  metadata_version: string;
}

export interface MarketQuote {
  token: number;
  bid: number | null;
  ask: number | null;
  bid_depth: number;
  ask_depth: number;
  exchange_timestamp: string | null;
  receive_timestamp: string;
  source: "websocket" | "rest";
  version: number;
}

export interface CleanQuote extends MarketQuote {
  mid: number;
  spread: number;
  relative_spread: number;
  age_ms: number;
  freshness_basis: "exchange" | "receive";
  quote_timestamp: string;
  available_depth: number;
  weight: number;
  h: number;
  calibration_eligible: boolean;
  reasons: string[];
}

export interface QuotePolicy {
  max_age_ms: number;
  max_relative_spread: number;
  max_absolute_spread: number;
  min_depth: number;
  premium_floor: number;
  tick_floor: number;
  depth_target: number;
  freshness_tau_ms: number;
  max_pair_dispersion_ms: number;
  max_snapshot_dispersion_ms: number;
  future_timestamp_tolerance_ms: number;
  zero_bid_policy: "exclude" | "diagnostic_only";
}

export interface QuoteRejection {
  token: number;
  strike: number | null;
  side: OptionSide | null;
  reasons: string[];
}

export interface CurveNode {
  t: number;
  zero_rate: number;
}

export interface DiscountCurveSpec extends SourceStamp {
  convention: "continuous_zero_act365f";
  nodes: CurveNode[];
  flat_rate: number | null;
  allow_flat_fallback: boolean;
}

export interface DiscountResult {
  available: boolean;
  d: number | null;
  zero_rate: number | null;
  method: "curve_node" | "log_discount_interpolation" | "flat_rate_assumption" | "unavailable";
  assumption: string | null;
  reason: string | null;
  provenance: SourceStamp;
}

export interface CarrySpec extends SourceStamp {
  verified: boolean;
  proportional: boolean;
  /** null means continuous dividends are NOT supported */
  dividend_yield: number | null;
  dividends: { timestamp: string; amount: number }[];
  corporate_actions: string[];
}

export interface ForwardPair {
  strike: number;
  forward: number;
  lower: number;
  upper: number;
  weight: number;
  scale: number;
  call_token: number;
  put_token: number;
  residual: number;
}

export interface ForwardResult {
  available: boolean;
  value: number | null;
  source: "robust_options_implied" | "matching_expiry_futures" | "verified_spot_carry" | "unavailable";
  pair_count: number;
  dispersion: number | null;
  interval: { lower: number; upper: number; compatible: boolean } | null;
  pairs: ForwardPair[];
  excluded_pairs: { strike: number; reasons: string[] }[];
  assumptions: string[];
  diagnostics: Diagnostic[];
}

export interface IvConfig {
  initial_high: number;
  max_volatility: number;
  max_expansions: number;
  max_iterations: number;
  price_tolerance: number;
  tick_tolerance_fraction: number;
  volatility_tolerance: number;
  low_vega_threshold: number;
  max_iv_uncertainty: number;
}

export type IvStatus = "valid" | "zero_volatility" | "outside_bounds" | "low_vega"
  | "no_finite_solution" | "bracket_failure" | "iteration_failure" | "expired" | "invalid_input";

export interface IvResult {
  status: IvStatus;
  iv: number | null;
  iterations: number;
  residual: number | null;
  vega: number | null;
  reason: string;
}

export interface BlackInput {
  f: number;
  k: number;
  d: number;
  w: number;
  side: OptionSide;
}

export interface BlackGreeks {
  forward_delta: number;
  forward_gamma: number | null;
  vega_1pct: number;
  spot_delta: number | null;
  spot_gamma: number | null;
  theta_calendar_day: number | null;
  rho_1pct: number;
  convention: string;
}

export interface ExpiryPayoff {
  value: number | null;
  value_per_lot: number | null;
  status: "final_settlement" | "indicative_payoff" | "settlement_unknown";
  reason: string;
}

export interface CalibrationObservation {
  strike: number;
  k: number;
  w: number;
  iv: number;
  side: OptionSide;
  token: number;
  quote: CleanQuote;
  /** ATM CE/PE weights sum to one economic strike's weight. */
  dependence_factor: number;
}

export interface SviParameters {
  a: number;
  b: number;
  rho: number;
  m: number;
  eta: number;
}

export interface SmileConfig {
  model: "svi" | "interpolation";
  min_svi_strikes: number;
  min_k_span: number;
  min_each_wing: number;
  atm_band: number;
  min_interpolation_strikes: number;
  max_interpolation_gap: number;
  huber_delta: number;
  regularization: number;
  max_normalized_rmse: number;
  optimizer_iterations: number;
  optimizer_starts: number;
  optimizer_tolerance: number;
  butterfly_tolerance: number;
  variance_floor: number;
  max_wing_slope: number;
  diagnostic_points: number;
  adaptive_depth: number;
  strike_extrapolation_k: number;
  calendar_tolerance: number;
  price_tolerance_ticks: number;
}

export interface FitResidual {
  token: number;
  strike: number;
  side: OptionSide;
  model_price: number;
  residual: number;
  standardized_residual: number;
  inside_spread: boolean;
}

export interface SmileModel {
  method: "svi" | "validated_interpolation" | "unavailable";
  parameters: SviParameters | null;
  nodes: { k: number; w: number }[];
  support: { min_k: number; max_k: number; strikes: number[] } | null;
  valid: boolean;
  diagnostics: Diagnostic[];
  butterfly: {
    min_g: number | null;
    checked_points: number;
    domain: [number, number] | null;
    right_wing_slope: number | null;
    left_wing_slope: number | null;
    tail_condition: boolean | null;
    global_proof: false;
  };
  calibration: {
    observation_count: number;
    distinct_strikes: number;
    normalized_rmse: number | null;
    inside_spread_percent: number | null;
    optimizer_status: string;
    optimizer_iterations: number;
    optimizer_starts: number;
    duration_ms: number;
    residuals: FitResidual[];
    rejected: { token: number; reason: string }[];
  };
}

export interface PriceComparison {
  mid_deviation: number;
  mid_deviation_percent: number;
  label: "Above model" | "Below model" | "At model";
  theoretical_buy_difference: number;
  theoretical_sell_difference: number;
  lot_mid_deviation: number;
  lot_buy_difference: number;
  lot_sell_difference: number;
  convention: string;
}

export interface ValuationRow {
  token: number;
  tradingsymbol: string;
  strike: number;
  side: OptionSide;
  metadata: OptionMetadata | null;
  lot_size: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  quote: CleanQuote | null;
  observed_iv: IvResult | null;
  bid_iv: IvResult | null;
  ask_iv: IvResult | null;
  surface_iv: number | null;
  total_variance: number | null;
  fair_value: number | null;
  fair_value_per_lot: number | null;
  independent_value: number | null;
  independent_status: string;
  comparison: PriceComparison | null;
  greeks: BlackGreeks | null;
  quality: QualityLabel;
  reasons: string[];
  estimation_method: string;
  expiry_payoff: ExpiryPayoff | null;
  sensitivity: SensitivityRange | null;
}

export interface ExpirySlice {
  expiry: string;
  expiry_timestamp: string | null;
  t: number | null;
  discount: DiscountResult | null;
  forward: ForwardResult;
  smile: SmileModel;
  rows: ValuationRow[];
  observations: CalibrationObservation[];
  snapshot_dispersion_ms: number;
  atm_iv: number | null;
  quality: QualityLabel;
  reasons: string[];
  diagnostics: Diagnostic[];
}

export interface CalendarRegion {
  first_expiry: string;
  second_expiry: string;
  min_k: number;
  max_k: number;
  valid: boolean;
  diagnostics: Diagnostic[];
}

export interface InputSnapshot {
  id: string;
  underlying: string;
  name: string;
  broker: string;
  broker_generation: number;
  feed_generation: number;
  valuation_time: string;
  metadata_version: string;
  instruments: import("../kite.js").Instrument[];
  /** Complete verified listing metadata for this underlying; quotes remain bounded. */
  listing_catalog?: OptionMetadata[];
  quotes: MarketQuote[];
  spot: { value: number; timestamp: string } | null;
  spot_provenance?: { exchange_timestamp: string | null; receive_timestamp: string; freshness_basis: "exchange" | "receive" } | null;
  futures: { expiry_timestamp: string; quote: MarketQuote; tick_size: number }[];
  config: FairValueConfig;
  config_version: string;
  universe: { listed_contracts: number; captured_contracts: number; omitted_expiries: string[]; bounded: boolean };
}

export interface SurfaceSnapshot {
  id: string;
  input_snapshot_id: string;
  model_version: string;
  config_version: string;
  sequence: number;
  underlying: string;
  name: string;
  broker: string;
  broker_generation: number;
  feed_generation: number;
  valuation_time: string;
  published_at: string;
  timezone: string;
  day_count: string;
  premium_unit: string;
  slices: ExpirySlice[];
  calendar_regions: CalendarRegion[];
  spot: InputSnapshot["spot"];
  spot_provenance?: InputSnapshot["spot_provenance"];
  curve: DiscountCurveSpec;
  carry: CarrySpec | null;
  universe: InputSnapshot["universe"];
  diagnostics: Diagnostic[];
  duration_ms: number;
}

export interface FairValueConfig {
  enabled: boolean;
  refresh_ms: number;
  surface_max_age_ms: number;
  max_underlyings: number;
  max_tokens: number;
  max_expiries: number;
  universe_refresh_ms: number;
  recenter_log_distance: number;
  workers: number;
  worker_timeout_ms: number;
  max_queue: number;
  history_limit: number;
  history_interval_ms: number;
  history_retention_days: number;
  history_memory_max_bytes: number;
  independent_cache_limit: number;
  independent_cache_ttl_ms: number;
  research_enabled: boolean;
  maturity_extrapolation: "none" | "constant_short_end_and_forward_variance";
  max_maturity_extrapolation_days: number;
  forward_interpolation: "unavailable" | "log_carry_assumption";
  proportional_calendar_assumption: boolean;
  sensitivity_rate_bump: number;
  quote: QuotePolicy;
  iv: IvConfig;
  forward: import("./forward.js").ForwardConfig;
  smile: SmileConfig;
  curve: DiscountCurveSpec;
  expiry_policy: ExpiryPolicy | null;
  carry: Record<string, CarrySpec>;
}

export interface IndependentEstimate {
  status: "available" | "insufficient_data" | "unavailable";
  input_snapshot_id: string;
  config_version: string;
  expiry: string;
  strike: number;
  values: { side: OptionSide; fair_value: number; per_lot: number | null }[];
  forward: ForwardResult;
  smile: SmileModel;
  excluded_tokens: number[];
  duration_ms: number;
  reasons: string[];
}

export interface SensitivityRange {
  label: "Model sensitivity range";
  low: number;
  high: number;
  scenarios: { name: string; forward: number; discount: number; iv: number; price: number; assumption: string }[];
  reasons: string[];
}

export interface CalculatorRequest {
  underlying: string;
  strike: number;
  expiry_timestamp: string;
  side: OptionSide;
  research_mode: boolean;
  input_snapshot_id?: string;
}

export interface CalculatorResult {
  available: boolean;
  input_snapshot_id: string;
  config_version: string;
  model_version: string;
  valuation_time: string;
  contract: "listed" | "hypothetical";
  instrument_token: number | null;
  strike_method: "listed_strike" | "strike_interpolation" | "strike_extrapolation" | "unavailable";
  maturity_method: "listed_expiry" | "maturity_interpolation" | "maturity_extrapolation" | "unavailable";
  strike: number;
  expiry_timestamp: string;
  side: OptionSide;
  t: number;
  forward: number | null;
  discount: number | null;
  k: number | null;
  total_variance: number | null;
  surface_iv: number | null;
  fair_value: number | null;
  fair_value_per_lot: number | null;
  lot_size: number | null;
  greeks: BlackGreeks | null;
  quality: QualityLabel;
  reasons: string[];
  assumptions: string[];
  diagnostics: Diagnostic[];
  sensitivity: SensitivityRange | null;
}
