import test from 'node:test';
import assert from 'node:assert/strict';
import { sviVariance, sviDerivatives, basicSviConstraints, diagnoseSvi } from '../../dist/fairValue/svi.js';
import { fitSvi, fitSmile, varianceAt } from '../../dist/fairValue/smile.js';
import { DEFAULT_SMILE_CONFIG } from '../../dist/fairValue/config.js';
import { blackPrice } from '../../dist/fairValue/black.js';
import { validatePriceGrid } from '../../dist/fairValue/validation.js';
import { invertIv } from '../../dist/fairValue/iv.js';
import { clean } from './fixtures.mjs';

test('analytic SVI derivatives and g match independent finite-difference evaluation', () => {
  const p = { a: .012, b: .09, rho: -.4, m: .015, eta: .15 };
  const h = 1e-4;
  for (const k of [-1, -.25, 0, .2, 1]) {
    const d = sviDerivatives(p, k);
    const first = (sviVariance(p, k + h) - sviVariance(p, k - h)) / (2 * h);
    const second = (sviVariance(p, k + h) - 2 * d.w + sviVariance(p, k - h)) / h ** 2;
    assert.ok(Math.abs(d.first - first) < 1e-8);
    assert.ok(Math.abs(d.second - second) < 1e-7);
    const g = (1 - k * first / (2 * d.w)) ** 2 - first ** 2 / 4 * (1 / d.w + 1 / 4) + second / 2;
    assert.ok(Math.abs(d.g - g) < 1e-7);
  }
});

test('Gatheral-Jacquier / Vogt counterexample satisfies basic constraints but fails butterfly diagnostics', () => {
  const vogt = { a: -.0410, b: .1331, m: .3586, rho: .3060, eta: .4153 };
  assert.equal(basicSviConstraints(vogt), true);
  const diagnosis = diagnoseSvi(vogt, [-.5, 0, .5], DEFAULT_SMILE_CONFIG);
  assert.equal(diagnosis.valid, false);
  assert.ok(diagnosis.butterfly.min_g < 0);
  assert.equal(diagnosis.butterfly.global_proof, false);
  assert.ok(diagnosis.butterfly.checked_points > DEFAULT_SMILE_CONFIG.diagnostic_points);
});

function observations(p, count = 19) {
  return Array.from({ length: count }, (_, i) => {
    const k = -.3 + i * .6 / (count - 1);
    const strike = 100 * Math.exp(k), w = sviVariance(p, k);
    const side = k < 0 ? 'PE' : 'CE';
    const mid = blackPrice({ f: 100, k: strike, d: .98, w, side });
    const quote = clean(i + 1, mid, { h: .05, bid: mid - .05, ask: mid + .05 });
    return { strike, k, w, iv: Math.sqrt(w / .5), side, token: i + 1, quote, dependence_factor: 1 };
  });
}

test('bounded multi-start SVI fits known smile prices reproducibly with validated support', () => {
  const p = { a: .01, b: .06, rho: -.4, m: .01, eta: .15 };
  const obs = observations(p);
  const first = fitSvi(obs, 100, .98, DEFAULT_SMILE_CONFIG);
  const second = fitSvi(obs, 100, .98, DEFAULT_SMILE_CONFIG);
  assert.equal(first.valid, true, JSON.stringify(first));
  assert.equal(first.method, 'svi');
  assert.ok(first.calibration.normalized_rmse < .3);
  assert.deepEqual(first.parameters, second.parameters);
  assert.ok(first.calibration.optimizer_starts >= 2);
  assert.ok(first.butterfly.min_g >= -DEFAULT_SMILE_CONFIG.butterfly_tolerance);
  assert.equal(varianceAt(first, .35, DEFAULT_SMILE_CONFIG), null);
  assert.ok(varianceAt(first, .35, DEFAULT_SMILE_CONFIG, true) > 0);
  assert.equal(varianceAt(first, 1, DEFAULT_SMILE_CONFIG, true), null);
});

test('sparse or poorly spread SVI data returns labelled validated interpolation or unavailable', () => {
  const obs = observations({ a: .02, b: .02, rho: -.1, m: 0, eta: .2 }, 5);
  const fit = fitSmile(obs, 100, .98, DEFAULT_SMILE_CONFIG);
  assert.notEqual(fit.method, 'svi');
  assert.match(fit.calibration.optimizer_status, /insufficient_support/);
  assert.equal(fitSmile(obs.slice(0, 2), 100, .98, DEFAULT_SMILE_CONFIG).method, 'unavailable');
});

test('price validation detects actual-spacing nonuniform-strike convexity violation', () => {
  // Prices [25,12,9.6] at [80,100,103] have slopes -.65 then -.8: nonconvex.
  // A wrong uniform-spacing implementation sees differences -13,-2.4 and passes.
  // Invert independent target call prices to obtain equivalent variance inputs.
  const values = new Map([[80, 25], [100, 12], [103, 9.6]].map(([k, price]) => {
    const iv = invertIv({ f: 100, k, t: 1, d: 1, price, side: 'CE', tick: 1e-8 });
    assert.equal(iv.status, 'valid');
    return [k, iv.iv ** 2];
  }));
  const result = validatePriceGrid({ f: 100, d: 1, strikes: [80, 100, 103], tick: .001,
    variance: (k) => values.get(Math.round(100 * Math.exp(k))) ?? null, config: DEFAULT_SMILE_CONFIG });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'call_convexity_violation'));
  assert.ok(!result.diagnostics.some((d) => d.code.includes('slope_violation')));
});
