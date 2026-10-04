import test from 'node:test';
import assert from 'node:assert/strict';
import { discountAt } from '../../dist/fairValue/curve.js';
import { cleanQuote, coherentSnapshot, DEFAULT_QUOTE_POLICY } from '../../dist/fairValue/quotes.js';
import { estimateOptionsForward, resolveForward } from '../../dist/fairValue/forward.js';
import { resolveOptionMetadata, utcTimestamp } from '../../dist/fairValue/metadata.js';
import { yearFraction } from '../../dist/fairValue/black.js';
import { NOW, EXPIRY, curve, expiryPolicy, metadata, quote, clean, chain } from './fixtures.mjs';

test('log discount interpolation, D>1, flat assumption and unavailable curve coverage', () => {
  const spec = { ...curve, nodes: [{ t: .5, zero_rate: -.02 }, { t: 1, zero_rate: -.03 }], allow_flat_fallback: false };
  assert.ok(Math.abs(discountAt(spec, .75).d - Math.exp(.02)) < 1e-14);
  assert.ok(discountAt(spec, .75).d > 1);
  assert.equal(discountAt(curve, 1).method, 'flat_rate_assumption');
  assert.equal(discountAt(spec, 2).available, false);
  assert.throws(() => discountAt({ ...curve, nodes: [{ t: 1, zero_rate: .03 }, { t: 1, zero_rate: .05 }] }, .5));
});

test('quote cleaning rejects stale, crossed, wide, invalid depth and incoherent cross-sections', () => {
  const inst = metadata(100);
  const base = quote(inst.token, 5);
  assert.equal(cleanQuote(inst, base, NOW, DEFAULT_QUOTE_POLICY).ok, true);
  for (const patch of [{ bid: null }, { ask: NaN }, { bid: 7 }, { ask: 20 }, { bid_depth: 0 },
    { exchange_timestamp: new Date(NOW - 31_000).toISOString() },
    { receive_timestamp: new Date(NOW + 30_000).toISOString() }]) {
    assert.equal(cleanQuote(inst, { ...base, ...patch }, NOW, DEFAULT_QUOTE_POLICY).ok, false, JSON.stringify(patch));
  }
  const noExchange = cleanQuote(inst, { ...base, exchange_timestamp: null }, NOW, DEFAULT_QUOTE_POLICY);
  assert.equal(noExchange.quote.freshness_basis, 'receive');
  assert.equal(noExchange.quote.mid, 5);
  const zero = cleanQuote(inst, { ...base, bid: 0, bid_depth: 0 }, NOW, DEFAULT_QUOTE_POLICY);
  assert.equal(zero.ok, true);
  assert.equal(zero.quote.calibration_eligible, false);
  const synchronized = coherentSnapshot([clean(1, 5), clean(2, 5, { quote_timestamp: new Date(NOW - 20_000).toISOString() })], DEFAULT_QUOTE_POLICY);
  assert.equal(synchronized.eligible.length, 1);
  assert.equal(synchronized.excluded[0].reasons[0], 'snapshot_time_dispersion');
});

test('robust multi-pair forward rejects an outlier and exposes interval diagnostics', () => {
  const input = chain([70, 85, 95, 100, 105, 120, 150]);
  const outlier = input.quotes.find((q) => q.token === metadata(150).token);
  outlier.mid += 100;
  outlier.bid += 100;
  outlier.ask += 100;
  const result = estimateOptionsForward(input);
  assert.ok(Math.abs(result.value - 100) < 1e-9);
  assert.equal(result.pair_count, 6);
  assert.ok(result.excluded_pairs.some((p) => p.strike === 150 && p.reasons.includes('robust_forward_outlier')));
  assert.ok(result.dispersion < 1e-10);
});

test('both target-strike quotes are excluded from forward and insufficient data is explicit', () => {
  const input = chain([90, 100, 110]);
  const result = estimateOptionsForward({ ...input, excludeStrike: 100 });
  assert.equal(result.available, false);
  assert.equal(result.pair_count, 2);
  assert.ok(result.pairs.every((p) => p.strike !== 100));
  const incoherent = chain([80, 90, 100, 110]);
  incoherent.quotes[0].quote_timestamp = new Date(NOW - 5_000).toISOString();
  assert.ok(estimateOptionsForward(incoherent).excluded_pairs.some((p) => p.reasons.includes('incoherent_pair_timestamps')));
});

test('matching-expiry futures only; verified continuous/discrete carry and events before expiry', () => {
  const unavailable = estimateOptionsForward(chain([100]));
  const args = { options: unavailable, expiry: EXPIRY, now: NOW, curve,
    futures: [{ expiry_timestamp: '2026-12-17T10:00:00Z', quote: clean(1, 104) }],
    spot: { value: 100, timestamp: new Date(NOW - 100).toISOString() }, carry: null, maxAgeMs: 30_000 };
  assert.equal(resolveForward(args).available, false);
  assert.equal(resolveForward({ ...args, futures: [{ expiry_timestamp: EXPIRY, quote: clean(1, 101) }] }).source, 'matching_expiry_futures');
  const carry = { source: 'verified carry test', as_of: curve.as_of, version: 'v1', convention: 'deterministic carry',
    verified: true, proportional: true, dividend_yield: .02, dividends: [], corporate_actions: [] };
  const t = yearFraction(EXPIRY, NOW);
  assert.ok(Math.abs(resolveForward({ ...args, carry }).value - 100 * Math.exp(.03 * t)) < 1e-10);
  const dividendTime = '2026-10-15T03:45:00Z';
  const dividends = [{ timestamp: dividendTime, amount: 2 }, { timestamp: '2027-01-01T00:00:00Z', amount: 1000 }];
  const discrete = resolveForward({ ...args, carry: { ...carry, proportional: false, dividend_yield: null, dividends } });
  const expected = (100 - 2 * Math.exp(-.05 * yearFraction(dividendTime, NOW))) / Math.exp(-.05 * t);
  assert.ok(Math.abs(discrete.value - expected) < 1e-10);
  assert.equal(resolveForward({ ...args, carry: { ...carry, corporate_actions: ['2026-10-10T00:00:00Z'] } }).available, false);
});

test('exact timestamp metadata and verified policy, no weekday or silently hardcoded time', () => {
  const inst = { instrument_token: 123, name: 'NIFTY', tradingsymbol: 'NIFTY-HOLIDAY-CE', exchange: 'NFO',
    instrument_type: 'CE', expiry: '2026-11-16', lot_size: 75, tick_size: .05, strike: 25000 };
  assert.equal(resolveOptionMetadata(inst, null, 'v1').ok, false);
  const result = resolveOptionMetadata(inst, expiryPolicy, 'v1');
  assert.equal(result.metadata.expiry_timestamp, '2026-11-16T10:00:00.000Z');
  assert.equal(resolveOptionMetadata({ ...inst, expiry_timestamp: '2026-11-16T10:10:00Z' }, null, 'v1').metadata.expiry_timestamp, '2026-11-16T10:10:00.000Z');
  assert.equal(resolveOptionMetadata({ ...inst, exercise_style: 'american' }, expiryPolicy, 'v1').ok, false);
  assert.equal(utcTimestamp('2026-02-30T10:00:00Z'), null);
  assert.equal(utcTimestamp('2026-10-01T10:00:00'), null);
});
