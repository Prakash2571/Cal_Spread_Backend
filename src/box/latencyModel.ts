/**
 * STRUCTURED LATENCY MODEL — the vocabulary of measurable execution delay, plus a
 * deterministic source that turns REAL measured samples into paper scheduling inputs.
 *
 * WHY NOT "latency = 250 ms"
 *
 * A single constant either hides the tail (optimistic) or overweights it (pessimistic),
 * and — worse — it collapses stages that behave very differently. A live four-leg Box
 * entry's time-to-fill is really the sum of distinct, separately-measurable stages:
 *
 *   detection → internal processing → OrderManager queue wait → transport pacing wait →
 *   HTTP/network → broker/RMS ACK → waiting for executable liquidity → first fill → …
 *
 * This module names those stages ({@link LATENCY_COMPONENTS}) so live observability can
 * measure each one independently and paper can be calibrated from the ones we can
 * actually observe — never from a random generator.
 *
 * WHAT PAPER NEEDS FROM CALIBRATION
 *
 * The paper scheduler ({@link ../paperScheduler}) computes `queue_wait_ms` and
 * `transport_wait_ms` itself from the shared policy — those are a function of the queue
 * and the min-interval, not of the broker. What it CANNOT compute, and must be fed from
 * measured live data, are the broker-side spans:
 *
 *   - `post_to_ack_ms`   — POST leaves the wire → broker acknowledges (order live).
 *   - `ack_to_terminal_ms` — ACK → the order resolves (the slot is held this long).
 *
 * {@link StructuredLatencySource} supplies exactly those two, drawn deterministically
 * (never `Math.random()`), per broker, so paper's slot occupancy and exchange-arrival
 * timing match what the account actually experienced.
 *
 * DETERMINISM & CALIBRATION HONESTY
 *
 * Draws are reproducible. And the source ALWAYS reports whether it is running on measured
 * samples or a conservative constant fallback ({@link CalibrationStatus}), so nothing ever
 * pretends a constant is measured live latency.
 */

import { createLatencySource, type LatencyMode, type LatencySource } from "./latencySource.js";

/** The brokers whose latency is measured and calibrated independently — never mixed. */
export type BrokerId = "zerodha" | "dhan";
export const BROKER_IDS: readonly BrokerId[] = ["zerodha", "dhan"] as const;

/**
 * The operation classes latency is bucketed by (where sample count allows). Distinct from
 * `BoxOrderPurpose`: UNWIND is the emergency-residual flatten, CANCEL/MODIFY are transport
 * operations. Kept separate so, e.g., entry ACK latency never contaminates cancel latency.
 */
export type LatencyOperationKind = "ENTRY" | "EXIT" | "UNWIND" | "CANCEL" | "MODIFY";
export const LATENCY_OPERATION_KINDS: readonly LatencyOperationKind[] = [
  "ENTRY",
  "EXIT",
  "UNWIND",
  "CANCEL",
  "MODIFY",
] as const;

/**
 * The measurable stages of one broker operation's latency. Not every value exists for
 * every order (a rejected order has no first-fill); absent stages are recorded as null,
 * never fabricated.
 */
export const LATENCY_COMPONENTS = [
  "queue_wait_ms",
  "transport_wait_ms",
  "post_to_http_response_ms",
  "post_to_ack_ms",
  "ack_to_first_fill_ms",
  "first_fill_to_terminal_ms",
  "submit_to_first_fill_ms",
  "submit_to_terminal_ms",
] as const;
export type LatencyComponent = (typeof LATENCY_COMPONENTS)[number];

/* --------------------------- calibration status --------------------------- */

/**
 * Whether paper is running on measured live latency, and how much to trust it.
 *
 *   UNCALIBRATED         — no live samples; paper falls back to a conservative constant.
 *   PARTIALLY_CALIBRATED — some samples, but below the confidence threshold.
 *   CALIBRATED           — enough recent samples to trust the distribution.
 *   STALE                — was calibrated, but the newest sample is older than the freshness
 *                          window (market/network conditions may have shifted since).
 */
export type CalibrationStatus =
  | "UNCALIBRATED"
  | "PARTIALLY_CALIBRATED"
  | "CALIBRATED"
  | "STALE";

export interface CalibrationThresholds {
  /** At/above this many recent samples the distribution is trusted. Default 200. */
  calibratedMinSamples: number;
  /** A sample older than this (ms) makes an otherwise-calibrated set STALE. Default 1 trading day. */
  staleAfterMs: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  calibratedMinSamples: 200,
  // ~6.5h trading day + margin. Latency shifts by session, so a set from a previous day
  // should not silently calibrate today without an explicit refresh.
  staleAfterMs: 8 * 60 * 60 * 1000,
};

/**
 * Classify a calibration set. Pure: given sample count and the age of the newest sample,
 * return the status. `lastSampleAgeMs === null` means "no samples".
 */
export function classifyCalibration(
  sampleCount: number,
  lastSampleAgeMs: number | null,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
): CalibrationStatus {
  if (sampleCount <= 0 || lastSampleAgeMs === null) return "UNCALIBRATED";
  const stale = lastSampleAgeMs > thresholds.staleAfterMs;
  if (sampleCount >= thresholds.calibratedMinSamples) return stale ? "STALE" : "CALIBRATED";
  return "PARTIALLY_CALIBRATED";
}

/* ----------------------- structured latency source ------------------------ */

/** The broker-side spans the paper scheduler consumes per operation. */
export interface BrokerLatencyDraw {
  /** POST → broker ACK (ms). */
  postToAckMs: number;
  /** ACK → terminal resolution (ms) — how long the slot is held. */
  ackToTerminalMs: number;
}

export interface StructuredLatencyConfig {
  mode: LatencyMode;
  /** Conservative fallback when a component has no samples (typically BOX_SIMULATED_LATENCY_MS). */
  constantMs: number;
  /** Measured POST→ACK samples (ms). Empty ⇒ fall back to constant for this component. */
  postToAckSamples?: number[];
  /** Measured ACK→terminal samples (ms). Empty ⇒ fall back to a fraction of the constant. */
  ackToTerminalSamples?: number[];
  /** Deterministic starting offset; never introduces randomness. */
  seed?: number;
}

/**
 * A deterministic per-broker latency source for paper `live_parity`. Composes two
 * independent {@link LatencySource}s (POST→ACK and ACK→terminal) so each broker-side stage
 * is drawn from its own measured distribution, in a fixed order, reproducibly.
 */
export interface StructuredLatencySource {
  readonly mode: LatencyMode;
  /** True when at least one component is backed by measured samples. */
  readonly calibrated: boolean;
  /** Draw the components for the next operation and advance the cursors. */
  next(): BrokerLatencyDraw;
  /** Restart every component sequence — a fresh run reproduces the same draws. */
  reset(): void;
}

/**
 * When no ACK→terminal samples exist we approximate the post-ack working span as a
 * fraction of the single constant, so an uncalibrated run still separates "time to reach
 * the exchange" from "time working at the exchange" instead of collapsing both into one.
 */
const UNCALIBRATED_ACK_TO_TERMINAL_FRACTION = 0.4;

export function createStructuredLatencySource(
  config: StructuredLatencyConfig,
): StructuredLatencySource {
  const postToAck = createLatencySource({
    mode: config.mode,
    constantMs: config.constantMs,
    samples: config.postToAckSamples ?? [],
    seed: config.seed ?? 0,
  });
  const ackToTerminal = createLatencySource({
    mode: config.mode,
    constantMs: Math.round(config.constantMs * UNCALIBRATED_ACK_TO_TERMINAL_FRACTION),
    samples: config.ackToTerminalSamples ?? [],
    seed: config.seed ?? 0,
  });
  const calibrated =
    (config.postToAckSamples?.length ?? 0) > 0 || (config.ackToTerminalSamples?.length ?? 0) > 0;

  return new ComposedStructuredLatencySource(config.mode, postToAck, ackToTerminal, calibrated);
}

class ComposedStructuredLatencySource implements StructuredLatencySource {
  constructor(
    readonly mode: LatencyMode,
    private readonly postToAck: LatencySource,
    private readonly ackToTerminal: LatencySource,
    readonly calibrated: boolean,
  ) {}
  next(): BrokerLatencyDraw {
    return {
      postToAckMs: Math.max(0, this.postToAck.next()),
      ackToTerminalMs: Math.max(0, this.ackToTerminal.next()),
    };
  }
  reset(): void {
    this.postToAck.reset();
    this.ackToTerminal.reset();
  }
}
