package model

import (
	"math"
	"strings"
	"unicode"

	"github.com/Prakash2571/Cal_Spread_Backend/internal/fairvalue/jsmath"
)

// Cephes erf/erfc rational approximations (Stephen L. Moshier, 1984-1992), as
// maintained by SciPy special/cephes/ndtr.h (BSD-3-Clause). See THIRD_PARTY.md.
// Use erfc for tails: 1+erf(x) loses small negative-tail probabilities.
var (
	cephesP = []float64{2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687,
		48.6371970985681366614, 196.520832956077098242, 526.445194995477358631,
		934.52852717195760754, 1027.55188689515710272, 557.535335369399327526}
	cephesQ = []float64{13.2281951154744992508, 86.7072140885989742329, 354.937778887819891062,
		975.708501743205489753, 1823.90916687909736289, 2246.33760818710981792,
		1656.66309194161350182, 557.535340817727675546}
	cephesR = []float64{0.564189583547755073984, 1.27536670759978104416, 5.01905042251180477414,
		6.16021097993053585195, 7.4097426995044893916, 2.9788666537210024067}
	cephesUpper = []float64{2.2605286322011727659, 9.39603524938001434673, 12.0489539808096656605,
		17.0814450747565897222, 9.60896809063285878198, 3.3690764510008151605}
	cephesA = []float64{9.60497373987051638749, 90.0260197203842689217, 2232.00534594684319226,
		7003.32514112805075473, 55592.3013010394962768}
	cephesB = []float64{33.5617141647503099647, 521.357949780152679795, 4594.32382970980127987,
		22629.0000613890934246, 49267.3942608635921086}
)

// JavaScript Math constants as doubles. They are variables so that expressions such as
// 2*sqrt2 are evaluated at run time in double precision, like the TypeScript.
var (
	sqrt2  float64 = 1.4142135623730951
	sqrt12 float64 = 0.7071067811865476
	pi     float64 = 3.141592653589793
	// epsilon is Number.EPSILON.
	epsilon float64 = 2.220446049250313e-16
)

func poly(x float64, c []float64) float64 {
	r := c[0]
	for i := 1; i < len(c); i++ {
		r = float64(r*x) + c[i]
	}
	return r
}

func polyMonic(x float64, c []float64) float64 {
	r := x + c[0]
	for i := 1; i < len(c); i++ {
		r = float64(r*x) + c[i]
	}
	return r
}

// Erf is normal.ts erf.
func Erf(x float64) float64 {
	if math.IsNaN(x) {
		return math.NaN()
	}
	if x < 0 {
		return -Erf(-x)
	}
	if x > 1 {
		return 1 - Erfc(x)
	}
	z := x * x
	return float64(x*poly(z, cephesA)) / polyMonic(z, cephesB)
}

// Erfc is normal.ts erfc.
func Erfc(x float64) float64 {
	if math.IsNaN(x) {
		return math.NaN()
	}
	a := math.Abs(x)
	if a < 1 {
		return 1 - Erf(x)
	}
	if math.IsInf(a, 1) {
		if x < 0 {
			return 2
		}
		return 0
	}
	var ratio float64
	if a < 8 {
		ratio = poly(a, cephesP) / polyMonic(a, cephesQ)
	} else {
		ratio = poly(a, cephesR) / polyMonic(a, cephesUpper)
	}
	value := jsmath.Exp(float64(-a*a)) * ratio
	if x < 0 {
		return 2 - value
	}
	return value
}

// NormalCdf is normal.ts normalCdf.
func NormalCdf(x float64) float64 {
	if math.IsNaN(x) {
		return math.NaN()
	}
	if math.Abs(x) < 1 {
		return 0.5 + float64(0.5*Erf(float64(x*sqrt12)))
	}
	tail := 0.5 * Erfc(float64(math.Abs(x)*sqrt12))
	if x > 0 {
		return 1 - tail
	}
	return tail
}

// NormalPdf is normal.ts normalPdf.
func NormalPdf(x float64) float64 {
	return jsmath.Exp(float64(float64(-0.5*x)*x)) / math.Sqrt(2*pi)
}

// jsTrim is String.prototype.trim: ECMAScript WhiteSpace and LineTerminator characters.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', 0xFEFF, 0x2028, 0x2029:
			return true
		}
		return unicode.Is(unicode.Zs, r)
	})
}
