/**
 * Cephes erf/erfc rational approximations (Stephen L. Moshier, 1984–1992),
 * as maintained by SciPy special/cephes/ndtr.h (BSD-3-Clause). See THIRD_PARTY.md.
 * Use erfc for tails: 1+erf(x) loses small negative-tail probabilities.
 */
const P = [2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687,
  48.6371970985681366614, 196.520832956077098242, 526.445194995477358631,
  934.52852717195760754, 1027.55188689515710272, 557.535335369399327526];
const Q = [13.2281951154744992508, 86.7072140885989742329, 354.937778887819891062,
  975.708501743205489753, 1823.90916687909736289, 2246.33760818710981792,
  1656.66309194161350182, 557.535340817727675546];
const R = [0.564189583547755073984, 1.27536670759978104416, 5.01905042251180477414,
  6.16021097993053585195, 7.4097426995044893916, 2.9788666537210024067];
const UPPER = [2.2605286322011727659, 9.39603524938001434673, 12.0489539808096656605,
  17.0814450747565897222, 9.60896809063285878198, 3.3690764510008151605];
const A = [9.60497373987051638749, 90.0260197203842689217, 2232.00534594684319226,
  7003.32514112805075473, 55592.3013010394962768];
const B = [33.5617141647503099647, 521.357949780152679795, 4594.32382970980127987,
  22629.0000613890934246, 49267.3942608635921086];

function poly(x: number, coefficients: readonly number[]): number {
  let result = coefficients[0]!;
  for (let i = 1; i < coefficients.length; i++) result = result * x + coefficients[i]!;
  return result;
}

function polyMonic(x: number, coefficients: readonly number[]): number {
  let result = x + coefficients[0]!;
  for (let i = 1; i < coefficients.length; i++) result = result * x + coefficients[i]!;
  return result;
}

export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return -erf(-x);
  if (x > 1) return 1 - erfc(x);
  const z = x * x;
  return x * poly(z, A) / polyMonic(z, B);
}

export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const a = Math.abs(x);
  if (a < 1) return 1 - erf(x);
  if (a === Infinity) return x < 0 ? 2 : 0;
  const ratio = a < 8 ? poly(a, P) / polyMonic(a, Q) : poly(a, R) / polyMonic(a, UPPER);
  const value = Math.exp(-a * a) * ratio;
  return x < 0 ? 2 - value : value;
}

export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (Math.abs(x) < 1) return 0.5 + 0.5 * erf(x * Math.SQRT1_2);
  const tail = 0.5 * erfc(Math.abs(x) * Math.SQRT1_2);
  return x > 0 ? 1 - tail : tail;
}

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
