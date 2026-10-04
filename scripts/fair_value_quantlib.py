"""Independent Black/IV reference verification. Run after npm run build.

Requires QuantLib (verification only; no production dependency). Set PYTHONPATH to
scratch/quantlib for a project-local wheel installation. No market data is used.
"""
import json
import math
import pathlib
import subprocess
import QuantLib as ql

root = pathlib.Path(__file__).resolve().parents[1]
cases = []
for f in [0.5, 100.0, 25000.0]:
    for ratio in [.05, .5, .9, 1.0, 1.1, 2.0, 20.0]:
        for t in [1 / 365, .25, 1.0, 5.0]:
            for iv in [.01, .2, .8, 2.0]:
                for d in [.7, 1.03]:
                    for side, sign in [('CE', ql.Option.Call), ('PE', ql.Option.Put)]:
                        k = f * ratio
                        reference = ql.blackFormula(sign, k, f, iv * math.sqrt(t), d)
                        cases.append(dict(f=f, k=k, t=t, d=d, iv=iv, side=side, reference=reference))
node = """
import { blackFromIv } from './dist/fairValue/black.js';
import { invertIv, DEFAULT_IV_CONFIG } from './dist/fairValue/iv.js';
let body = ''; for await (const chunk of process.stdin) body += chunk;
const result = JSON.parse(body).map(c => {
  const price = blackFromIv(c.f,c.k,c.t,c.d,c.iv,c.side);
  const inverted = invertIv({...c, price: c.reference, tick: 1e-10,
    config: {...DEFAULT_IV_CONFIG, price_tolerance:1e-12, volatility_tolerance:1e-10}});
  return {price, inverted};
});
process.stdout.write(JSON.stringify(result));
"""
run = subprocess.run(['node', '--input-type=module', '-e', node], cwd=root,
                     input=json.dumps(cases), text=True, capture_output=True, check=True)
actual = json.loads(run.stdout)
max_error = 0
iv_checks = 0
for case, result in zip(cases, actual):
    error = abs(case['reference'] - result['price'])
    max_error = max(max_error, error)
    assert error <= max(1e-10, case['f'] * 2e-12), (case, result)
    iv = result['inverted']['iv']
    # IV accuracy is meaningful only where the independent price carries enough
    # vega; deep intrinsic plateaus are still checked for pricing/bounds above.
    if result['inverted']['status'] == 'valid' and result['inverted']['vega'] > case['f'] * 1e-5:
        reference_iv = ql.blackFormulaImpliedStdDev(
            ql.Option.Call if case['side'] == 'CE' else ql.Option.Put,
            case['k'], case['f'], case['reference'], case['d'], 0.0,
            case['iv'] * math.sqrt(case['t']), 1e-10, 200) / math.sqrt(case['t'])
        assert abs(iv - reference_iv) < 1e-5, (case, result, reference_iv)
        iv_checks += 1
print(json.dumps({'QuantLib': ql.__version__, 'pricing_cases': len(cases),
                  'iv_reference_checks': iv_checks, 'max_absolute_price_error': max_error}))
