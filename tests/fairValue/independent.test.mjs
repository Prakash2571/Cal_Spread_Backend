import test from 'node:test';
import assert from 'node:assert/strict';
import { independentEstimate } from '../../dist/fairValue/independent.js';
import { buildSurface } from '../../dist/fairValue/pipeline.js';
import { modelSensitivity } from '../../dist/fairValue/sensitivity.js';
import { inputSnapshot } from './fixtures.mjs';

test('leave-one-strike-out removes both quotes before forwards and fitting, reprices the target', () => {
  const input = inputSnapshot();
  const expiry = input.instruments[0].expiry;
  const original = independentEstimate(input, expiry, 100);
  assert.equal(original.status, 'available', JSON.stringify(original));
  const changed = structuredClone(input);
  const tokens = changed.instruments.filter((i) => i.strike === 100).map((i) => i.instrument_token);
  changed.quotes.filter((q) => tokens.includes(q.token)).forEach((q) => { q.bid *= 10; q.ask *= 10; });
  const excluded = independentEstimate(changed, expiry, 100);
  assert.deepEqual(excluded.values, original.values);
  assert.deepEqual(excluded.forward.pairs, original.forward.pairs);
  assert.ok(excluded.forward.pairs.every((p) => p.strike !== 100));
  assert.ok(excluded.smile.calibration.residuals.every((r) => !tokens.includes(r.token)));
  assert.equal(excluded.excluded_tokens.length, 2);
  const fullA = buildSurface(input).slices[0].rows.find((r) => r.strike === 100 && r.side === 'CE');
  const fullB = buildSurface(changed).slices[0].rows.find((r) => r.strike === 100 && r.side === 'CE');
  assert.notEqual(fullA.observed_iv?.iv, fullB.observed_iv?.iv);
});

test('leave-one-strike-out returns insufficient data for sparse slices and supported-range endpoints', () => {
  const input = inputSnapshot({ strikes: [95, 100, 105] });
  assert.equal(independentEstimate(input, input.instruments[0].expiry, 100).status, 'insufficient_data');
  const supported = inputSnapshot();
  assert.equal(independentEstimate(supported, supported.instruments[0].expiry, 80).status, 'insufficient_data');
});

test('sensitivity reports the exact scenario range with documented nonstatistical assumptions', () => {
  const range = modelSensitivity({ f: 100, strike: 100, t: .5, d: .98, iv: .2, side: 'CE',
    forwardDispersion: 1, rateBump: .0025, quoteIvBid: .19, quoteIvAsk: .21 });
  assert.equal(range.label, 'Model sensitivity range');
  assert.equal(range.low, Math.min(...range.scenarios.map((s) => s.price)));
  assert.equal(range.high, Math.max(...range.scenarios.map((s) => s.price)));
  assert.equal(range.scenarios.length, 7);
  assert.ok(range.scenarios.every((s) => s.assumption.length > 10));
  assert.ok(range.low < range.high);
});
