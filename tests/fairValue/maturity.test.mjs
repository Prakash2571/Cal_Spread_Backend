import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSurface } from '../../dist/fairValue/pipeline.js';
import { calculate, validateCalculatorRequest } from '../../dist/fairValue/calculator.js';
import { totalVarianceBetween, buildCalendarRegions } from '../../dist/fairValue/maturity.js';
import { varianceAt } from '../../dist/fairValue/smile.js';
import { inputSnapshot, NOW } from './fixtures.mjs';

const expiries = ['2026-10-20T10:00:00Z', '2026-11-17T10:00:00Z', '2026-12-15T10:00:00Z'];
const supportedInput = (extra = {}) => inputSnapshot({ expiries, configPatch: {
  proportional_calendar_assumption: true, forward_interpolation: 'log_carry_assumption', ...extra } });
const request = (expiry = '2026-11-01T10:00:00Z', strike = 100, research_mode = false) => ({ underlying: 'TEST', strike, expiry_timestamp: expiry, side: 'CE', research_mode });

test('maturity interpolation evaluates both slices at identical k and interpolates total variance', () => {
  const input = supportedInput();
  const surface = buildSurface(input);
  assert.ok(surface.calendar_regions.every((r) => r.valid), JSON.stringify(surface.calendar_regions));
  const [a, b] = surface.slices;
  const t = (a.t + b.t) / 2, k = .03;
  const actual = totalVarianceBetween(a, b, t, k, input.config);
  const expected = (varianceAt(a.smile, k, input.config.smile) + varianceAt(b.smile, k, input.config.smile)) / 2;
  assert.equal(actual, expected);
  const result = calculate(input, surface, request());
  assert.equal(result.available, true, JSON.stringify(result));
  assert.equal(result.contract, 'hypothetical');
  assert.equal(result.instrument_token, null);
  assert.equal(result.fair_value_per_lot, null);
  assert.equal(result.maturity_method, 'maturity_interpolation');
  assert.ok(result.assumptions.some((a) => /log carry/.test(a)));
  assert.ok(Math.abs(result.surface_iv - .3) < 1e-7);
});

test('listed contracts retain actual IDs/lots; hypothetical strike interpolation and invalid input boundaries', () => {
  const input = supportedInput(), surface = buildSurface(input);
  const listed = calculate(input, surface, request(expiries[1]));
  assert.equal(listed.contract, 'listed');
  assert.equal(listed.fair_value_per_lot, listed.fair_value * 50);
  const hypothetical = calculate(input, surface, request(expiries[1], 102));
  assert.equal(hypothetical.contract, 'hypothetical');
  assert.equal(hypothetical.strike_method, 'strike_interpolation');
  assert.throws(() => validateCalculatorRequest({ ...request(), strike: '100' }));
  assert.throws(() => validateCalculatorRequest({ ...request(), strike: 0 }));
  assert.throws(() => validateCalculatorRequest({ ...request(), side: 'American' }));
  assert.equal(calculate(input, surface, request(new Date(NOW).toISOString())).available, false);
});

test('crossing maturity variance curves invalidates the relevant interpolation region without silent repair', () => {
  const input = supportedInput();
  const surface = buildSurface(input);
  surface.slices[1].smile.nodes.forEach((n) => { n.w *= .1; });
  if (surface.slices[1].smile.parameters) {
    surface.slices[1].smile.parameters.a *= .1;
    surface.slices[1].smile.parameters.b *= .1;
  }
  surface.calendar_regions = buildCalendarRegions(surface.slices, input);
  assert.equal(surface.calendar_regions[0].valid, false);
  assert.ok(surface.calendar_regions[0].diagnostics.some((d) => d.code === 'calendar_variance_crossing'));
  assert.equal(calculate(input, surface, request()).available, false);
});

test('research opt-in is necessary and distance/negative-forward-variance limits are enforced', () => {
  const input = supportedInput({ research_enabled: true, maturity_extrapolation: 'constant_short_end_and_forward_variance', max_maturity_extrapolation_days: 40 });
  const surface = buildSurface(input);
  assert.equal(calculate(input, surface, request('2026-12-30T10:00:00Z')).available, false);
  const long = calculate(input, surface, request('2026-12-30T10:00:00Z', 100, true));
  assert.equal(long.available, true, JSON.stringify(long));
  assert.equal(long.quality, 'research');
  assert.equal(calculate(input, surface, request('2027-06-30T10:00:00Z', 100, true)).available, false);
  const short = calculate(input, surface, request('2026-10-10T10:00:00Z', 100, true));
  assert.equal(short.available, true, JSON.stringify(short));
  assert.ok(short.assumptions.some((a) => /especially unreliable/.test(a)));
  assert.equal(calculate(input, surface, request(expiries[1], 200, true)).available, false);
  const last = surface.slices[2];
  last.smile.nodes.forEach((n) => { n.w *= .1; });
  if (last.smile.parameters) { last.smile.parameters.a *= .1; last.smile.parameters.b *= .1; }
  assert.equal(calculate(input, surface, request('2026-12-30T10:00:00Z', 100, true)).available, false);
});

test('unsupported carry, dividends and corporate actions cannot silently use event-insensitive maturity interpolation', () => {
  const input = supportedInput({ proportional_calendar_assumption: false });
  assert.equal(calculate(input, buildSurface(input), request()).available, false);
  input.config.proportional_calendar_assumption = true;
  input.config.carry.TEST = { source: 'test', version: 'v1', as_of: new Date(NOW).toISOString(), convention: 'known cash dividends',
    verified: true, proportional: false, dividend_yield: null, dividends: [{ timestamp: '2026-10-25T00:00:00Z', amount: 1 }], corporate_actions: [] };
  assert.equal(calculate(input, buildSurface(input), request()).available, false);
});
