import test from 'node:test';
import assert from 'node:assert/strict';
import { blackPrice, blackFromIv, priceBounds, frozenBlackGreeks, settlementPayoff, yearFraction, YEAR_MS } from '../../dist/fairValue/black.js';
import { normalCdf, normalPdf } from '../../dist/fairValue/normal.js';
import { invertIv, DEFAULT_IV_CONFIG } from '../../dist/fairValue/iv.js';

const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('independent known Black-Scholes price (Hull example) and precise normal tails', () => {
  // S=100, r=.05, q=0, K=100, T=1, IV=.2; reference from independent BS evaluation.
  near(blackFromIv(100 * Math.exp(.05), 100, 1, Math.exp(-.05), .2, 'CE'), 10.450583572185565);
  near(blackFromIv(100 * Math.exp(.05), 100, 1, Math.exp(-.05), .2, 'PE'), 5.573526022256971);
  near(normalCdf(-8), 6.220960574271784e-16, 1e-29);
  near(normalCdf(0), .5);
  near(normalPdf(0), 1 / Math.sqrt(2 * Math.PI));
});

test('nonuniform strike grid parity, price bounds, negative rates, deep ITM/OTM', () => {
  for (const f of [0.5, 100, 25000]) for (const factor of [.0001, .3, .95, 1, 1.2, 10, 10000]) {
    const k = f * factor;
    for (const w of [0, 1e-10, .001, .04, 1, 25]) {
      const d = 1.03;
      const c = blackPrice({ f, k, d, w, side: 'CE' });
      const p = blackPrice({ f, k, d, w, side: 'PE' });
      near(c - p, d * (f - k), 1e-7 * Math.max(1, f, k));
      for (const [side, price] of [['CE', c], ['PE', p]]) {
        const bounds = priceBounds(f, k, d, side);
        assert.ok(price >= bounds.lower - 1e-8 && price <= bounds.upper + 1e-8);
      }
    }
  }
});

test('zero variance and exact ACT/365F expiry time; settlement is distinguished', () => {
  near(yearFraction('2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), 1);
  near(yearFraction(Date.parse('2026-10-01T10:00:00Z') + 1000, '2026-10-01T10:00:00Z'), 1000 / YEAR_MS);
  near(blackPrice({ f: 120, k: 100, d: .95, w: 0, side: 'CE' }), 19);
  const args = { strike: 100, side: 'CE', lot: 75, settlement: null, indicative: 120, settlementUnderlying: 'official_index_close' };
  assert.equal(settlementPayoff(args).status, 'indicative_payoff');
  assert.equal(settlementPayoff(args).value_per_lot, 1500);
  assert.equal(settlementPayoff({ ...args, settlement: 118 }).value, 18);
  assert.equal(settlementPayoff({ ...args, settlement: 118 }).status, 'final_settlement');
  assert.equal(settlementPayoff({ ...args, indicative: null }).value, null);
});

test('IV round trips across puts/calls and maturity, decimal percent units', () => {
  for (const side of ['CE', 'PE']) for (const k of [80, 100, 120]) for (const t of [.05, .5, 2]) for (const iv of [.2, .5, 1]) {
    const price = blackFromIv(100, k, t, 1.01, iv, side);
    const result = invertIv({ f: 100, k, t, d: 1.01, price, side, tick: 1e-8 });
    assert.ok(['valid', 'low_vega'].includes(result.status), JSON.stringify(result));
    near(result.iv, iv, 2e-6);
  }
});

test('IV explicit failures, lower/upper bounds, low vega and bounded expansion', () => {
  const args = { f: 100, k: 100, t: .5, d: .98, price: 8, side: 'CE', tick: .01 };
  assert.equal(invertIv({ ...args, price: 100 }).status, 'outside_bounds');
  assert.equal(invertIv({ ...args, price: 98 }).status, 'no_finite_solution');
  assert.equal(invertIv({ ...args, price: 0 }).status, 'zero_volatility');
  assert.equal(invertIv({ ...args, t: 0 }).status, 'expired');
  assert.equal(invertIv({ ...args, f: Infinity }).status, 'invalid_input');
  assert.equal(invertIv({ ...args, config: { ...DEFAULT_IV_CONFIG, max_volatility: .01 } }).status, 'bracket_failure');
  assert.equal(invertIv({ ...args, config: { ...DEFAULT_IV_CONFIG, max_iterations: 1 } }).status, 'iteration_failure');
  const price = blackFromIv(100, 150, .01, .99, 1, 'CE');
  assert.equal(invertIv({ ...args, k: 150, t: .01, d: .99, price, tick: 1e-12, uncertainty: 1 }).status, 'low_vega');
});

test('frozen Greeks agree with independent central price bumps and explicitly scaled units', () => {
  const args = { f: 105, k: 100, t: .6, d: Math.exp(-.03 * .6), w: .25 ** 2 * .6, side: 'CE', spot: 100, proportionalCarry: true };
  const g = frozenBlackGreeks(args);
  const p = blackPrice(args);
  const h = .001;
  near(g.forward_delta, (blackPrice({ ...args, f: 105 + h }) - blackPrice({ ...args, f: 105 - h })) / (2 * h), 1e-8);
  near(g.forward_gamma, (blackPrice({ ...args, f: 105 + h }) - 2 * p + blackPrice({ ...args, f: 105 - h })) / h ** 2, 1e-7);
  near(g.vega_1pct, (blackFromIv(105, 100, .6, args.d, .25 + h, 'CE') - blackFromIv(105, 100, .6, args.d, .25 - h, 'CE')) / (2 * h) / 100, 1e-5);
  near(g.rho_1pct, -.6 * p / 100);
  near(g.spot_delta, g.forward_delta * 1.05);
  near(g.spot_gamma, g.forward_gamma * 1.05 ** 2);
  const dt = 1e-5;
  const before = blackFromIv(105, 100, .6 - dt, Math.exp(-.03 * (.6 - dt)), .25, 'CE');
  const after = blackFromIv(105, 100, .6 + dt, Math.exp(-.03 * (.6 + dt)), .25, 'CE');
  near(g.theta_calendar_day, (before - after) / (2 * dt) / 365, 1e-8);
});

test('invalid strike/forward/discount/variance/style never produce a price', () => {
  const args = { f: 100, k: 100, d: 1, w: .04, side: 'CE' };
  for (const patch of [{ k: 0 }, { f: -1 }, { d: 0 }, { d: NaN }, { w: -1 }, { side: 'american' }]) {
    assert.throws(() => blackPrice({ ...args, ...patch }));
  }
  assert.throws(() => blackFromIv(100, 100, 0, 1, .2, 'CE'));
});
