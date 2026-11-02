// Package jsmath reproduces the V8 (Node 22) implementations of the Math functions the
// Fair Value model uses, so Go results are bit-identical to the Node backend.
//
// V8 evaluates Math.exp, Math.log and the ** operator with its bundled port of FreeBSD
// msun / fdlibm (src/base/ieee754.cc). Go's math.Exp and math.Log use different
// algorithms (and amd64 assembly), and math.Hypot and math.Pow differ too, so the
// routines are ported here operation for operation. Math.sqrt is correctly rounded on
// every platform, so math.Sqrt is used as is.
//
// fdlibm: Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to use, copy,
// modify, and distribute this software is freely granted, provided that this notice
// is preserved.
//
// Floating-point note: the expressions below must not be fused into FMA instructions.
// Go does not fuse on amd64 with the default GOAMD64=v1; explicit float64 conversions
// guard the polynomial evaluations on other architectures.
package jsmath

import "math"

func hi(x float64) uint32 { return uint32(math.Float64bits(x) >> 32) }
func lo(x float64) uint32 { return uint32(math.Float64bits(x)) }

func fromWords(h, l uint32) float64 { return math.Float64frombits(uint64(h)<<32 | uint64(l)) }

func setLow(x float64, l uint32) float64 { return fromWords(hi(x), l) }

func setHigh(x float64, h uint32) float64 { return fromWords(h, lo(x)) }

const (
	expHuge     = 1.0e+300
	twom1000    = 9.33263618503218878990e-302 // 2**-1000
	oThreshold  = 7.09782712893383973096e+02
	uThreshold  = -7.45133219101941108420e+02
	invln2      = 1.44269504088896338700e+00
	expP1       = 1.66666666666666019037e-01
	expP2       = -2.77777777770155933842e-03
	expP3       = 6.61375632143793436117e-05
	expP4       = -1.65339022054652515390e-06
	expP5       = 4.13813679705723846039e-08
	ln2HIpos    = 6.93147180369123816490e-01
	ln2LOpos    = 1.90821492927058770002e-10
	expE        = 2.718281828459045
	two1023     = 8.988465674311579539e307 // 0x1p1023
	logTwo54    = 1.80143985094819840000e+16
	lg1         = 6.666666666666735130e-01
	lg2c        = 3.999999999940941908e-01
	lg3         = 2.857142874366239149e-01
	lg4         = 2.222219843214978396e-01
	lg5         = 1.818357216161805012e-01
	lg6         = 1.531383769920937332e-01
	lg7         = 1.479819860511658591e-01
	ln2Hi       = 6.93147180369123816490e-01
	ln2Lo       = 1.90821492927058770002e-10
	oneThirdLog = 0.33333333333333333
)

// Exp is V8's ieee754::exp (FreeBSD e_exp.c with V8's exact exp(1) special case).
func Exp(x float64) float64 {
	halF := [2]float64{0.5, -0.5}
	ln2HI := [2]float64{ln2HIpos, -ln2HIpos}
	ln2LO := [2]float64{ln2LOpos, -ln2LOpos}
	var y, hiPart, loPart, c, t, twopk float64
	k := int32(0)
	hx := hi(x)
	xsb := int((hx >> 31) & 1)
	hx &= 0x7fffffff
	// filter out non-finite argument
	if hx >= 0x40862E42 { // |x| >= 709.78...
		if hx >= 0x7ff00000 {
			if ((hx & 0xfffff) | lo(x)) != 0 {
				return x + x // NaN
			}
			if xsb == 0 {
				return x
			}
			return 0.0
		}
		if x > oThreshold {
			return math.Inf(1) // huge*huge
		}
		if x < uThreshold {
			return 0 // twom1000*twom1000
		}
	}
	// argument reduction
	if hx > 0x3fd62e42 { // |x| > 0.5 ln2
		if hx < 0x3FF0A2B2 { // and |x| < 1.5 ln2
			if x == 1.0 {
				return expE
			}
			hiPart = x - ln2HI[xsb]
			loPart = ln2LO[xsb]
			k = int32(1 - xsb - xsb)
		} else {
			k = int32(float64(invln2*x) + halF[xsb])
			t = float64(k)
			hiPart = x - float64(t*ln2HIpos) // t*ln2HI is exact here
			loPart = t * ln2LOpos
		}
		x = hiPart - loPart
	} else if hx < 0x3e300000 { // |x| < 2**-28
		if expHuge+x > 1 {
			return 1 + x // trigger inexact
		}
	} else {
		k = 0
	}
	// x is now in primary range
	t = x * x
	if k >= -1021 {
		twopk = fromWords(uint32(0x3ff00000+(k<<20)), 0)
	} else {
		twopk = fromWords(uint32(0x3ff00000+((k+1000)<<20)), 0)
	}
	c = x - float64(t*float64(expP1+float64(t*float64(expP2+float64(t*float64(expP3+float64(t*float64(expP4+float64(t*expP5)))))))))
	if k == 0 {
		return 1 - (float64(x*c)/(c-2.0) - x)
	}
	y = 1 - ((loPart - float64(x*c)/(2.0-c)) - hiPart)
	if k >= -1021 {
		if k == 1024 {
			return y * 2.0 * two1023
		}
		return y * twopk
	}
	return y * twopk * twom1000
}

// Log is V8's ieee754::log (FreeBSD e_log.c).
func Log(x float64) float64 {
	bits := math.Float64bits(x)
	hx := int32(bits >> 32)
	lx := uint32(bits)
	k := int32(0)
	if hx < 0x00100000 { // x < 2**-1022
		if ((hx & 0x7fffffff) | int32(lx)) == 0 {
			return math.Inf(-1) // log(+-0) = -inf
		}
		if hx < 0 {
			return math.NaN() // log(-#) = NaN
		}
		k -= 54
		x *= logTwo54 // subnormal number, scale up x
		hx = int32(hi(x))
	}
	if hx >= 0x7ff00000 {
		return x + x
	}
	k += (hx >> 20) - 1023
	hx &= 0x000fffff
	i := (hx + 0x95f64) & 0x100000
	x = setHigh(x, uint32(hx|(i^0x3ff00000))) // normalize x or x/2
	k += i >> 20
	f := x - 1.0
	if (0x000fffff & (2 + hx)) < 3 { // -2**-20 <= f < 2**-20
		if f == 0 {
			if k == 0 {
				return 0
			}
			dk := float64(k)
			return float64(dk*ln2Hi) + float64(dk*ln2Lo)
		}
		R := float64(f*f) * (0.5 - float64(oneThirdLog*f))
		if k == 0 {
			return f - R
		}
		dk := float64(k)
		return float64(dk*ln2Hi) - ((R - float64(dk*ln2Lo)) - f)
	}
	s := f / (2.0 + f)
	dk := float64(k)
	z := s * s
	i = hx - 0x6147a
	w := z * z
	j := 0x6b851 - hx
	t1 := w * float64(lg2c+float64(w*float64(lg4+float64(w*lg6))))
	t2 := z * float64(lg1+float64(w*float64(lg3+float64(w*float64(lg5+float64(w*lg7))))))
	i |= j
	R := t2 + t1
	if i > 0 {
		hfsq := float64(0.5*f) * f
		if k == 0 {
			return f - (hfsq - float64(s*(hfsq+R)))
		}
		return float64(dk*ln2Hi) - ((hfsq - (float64(s*(hfsq+R)) + float64(dk*ln2Lo))) - f)
	}
	if k == 0 {
		return f - float64(s*(f-R))
	}
	return float64(dk*ln2Hi) - ((float64(s*(f-R)) - float64(dk*ln2Lo)) - f)
}

const (
	powZero  = 0.0
	powHalf  = 0.5
	powQrtr  = 0.25
	powThrd  = 3.3333333333333331e-01
	powTwo   = 2.0
	powTwo53 = 9007199254740992.0
	powHuge  = 1.0e300
	powTiny  = 1.0e-300
	powL1    = 5.99999999999994648725e-01
	powL2    = 4.28571428578550184252e-01
	powL3    = 3.33333329818377432918e-01
	powL4    = 2.72728123808534006489e-01
	powL5    = 2.30660745775561754067e-01
	powL6    = 2.06975017800338417784e-01
	powP1    = 1.66666666666666019037e-01
	powP2    = -2.77777777770155933842e-03
	powP3    = 6.61375632143793436117e-05
	powP4    = -1.65339022054652515390e-06
	powP5    = 4.13813679705723846039e-08
	powLg2   = 6.93147180559945286227e-01
	powLg2H  = 6.93147182464599609375e-01
	powLg2L  = -1.90465429995776804525e-09
	powOvt   = 8.0085662595372944372e-17
	powCp    = 9.61796693925975554329e-01
	powCpH   = 9.61796700954437255859e-01
	powCpL   = -7.02846165095275826516e-09
	powIvln2 = 1.44269504088896338700e+00
	ivln2H   = 1.44269502162933349609e+00
	ivln2L   = 1.92596299112661746887e-08
)

// Pow is V8's ieee754::pow, which is what the ** operator and Math.pow evaluate. It is
// fdlibm e_pow.c with V8's one changed expression (see the r computation below).
// ECMAScript requires NaN for (+-1) ** (+-Infinity) and NaN exponents.
func Pow(x, y float64) float64 {
	if math.IsNaN(y) {
		return math.NaN()
	}
	if math.IsInf(y, 0) && (x == 1 || x == -1) {
		return math.NaN()
	}
	return fdlibmPow(x, y)
}

func fdlibmPow(x, y float64) float64 {
	bp := [2]float64{1.0, 1.5}
	dpH := [2]float64{0.0, 5.84962487220764160156e-01}
	dpL := [2]float64{0.0, 1.35003920212974897128e-08}
	xb, yb := math.Float64bits(x), math.Float64bits(y)
	hx, lx := int32(xb>>32), uint32(xb)
	hy, ly := int32(yb>>32), uint32(yb)
	ix := hx & 0x7fffffff
	iy := hy & 0x7fffffff

	// y==zero: x**0 = 1
	if (uint32(iy) | ly) == 0 {
		return 1
	}
	// x==1: 1**y = 1, even if y is NaN
	if hx == 0x3ff00000 && lx == 0 {
		return 1
	}
	// y!=zero: result is NaN if either arg is NaN
	if ix > 0x7ff00000 || (ix == 0x7ff00000 && lx != 0) || iy > 0x7ff00000 || (iy == 0x7ff00000 && ly != 0) {
		return x + y
	}
	// determine if y is an odd int when x < 0
	yisint := int32(0)
	if hx < 0 {
		if iy >= 0x43400000 {
			yisint = 2 // even integer y
		} else if iy >= 0x3ff00000 {
			k := (iy >> 20) - 0x3ff // exponent
			if k > 20 {
				j := ly >> uint(52-k)
				if (j << uint(52-k)) == ly {
					yisint = 2 - int32(j&1)
				}
			} else if ly == 0 {
				j := iy >> uint(20-k)
				if (j << uint(20-k)) == iy {
					yisint = 2 - (j & 1)
				}
			}
		}
	}
	// special value of y
	if ly == 0 {
		if iy == 0x7ff00000 { // y is +-inf
			if ((ix - 0x3ff00000) | int32(lx)) == 0 {
				return 1 // (-1)**+-inf is 1 (V8 maps this to NaN in Pow)
			} else if ix >= 0x3ff00000 { // (|x|>1)**+-inf = inf,0
				if hy >= 0 {
					return y
				}
				return powZero
			}
			if hy < 0 { // (|x|<1)**-,+inf = inf,0
				return -y
			}
			return powZero
		}
		if iy == 0x3ff00000 { // y is +-1
			if hy < 0 {
				return 1 / x
			}
			return x
		}
		if hy == 0x40000000 {
			return x * x // y is 2
		}
		if hy == 0x3fe00000 { // y is 0.5
			if hx >= 0 { // x >= +0
				return math.Sqrt(x)
			}
		}
	}

	ax := math.Abs(x)
	// special value of x
	if lx == 0 {
		if ix == 0x7ff00000 || ix == 0 || ix == 0x3ff00000 {
			z := ax // x is +-0,+-inf,+-1
			if hy < 0 {
				z = 1 / z // z = (1/|x|)
			}
			if hx < 0 {
				if ((ix - 0x3ff00000) | yisint) == 0 {
					z = (z - z) / (z - z) // (-1)**non-int is NaN
				} else if yisint == 1 {
					z = -z // (x<0)**odd = -(|x|**odd)
				}
			}
			return z
		}
	}

	n := int32((uint32(hx) >> 31) - 1)

	// (x<0)**(non-int) is NaN
	if (n | yisint) == 0 {
		return (x - x) / (x - x)
	}

	s := 1.0 // s (sign of result -ve**odd) = -1 else = 1
	if (n | (yisint - 1)) == 0 {
		s = -1 // (-ve)**(odd int)
	}

	var t1, t2 float64
	// |y| is huge
	if iy > 0x41e00000 { // if |y| > 2**31
		if iy > 0x43f00000 { // if |y| > 2**64, must o/uflow
			if ix <= 0x3fefffff {
				if hy < 0 {
					return math.Inf(1) // huge*huge
				}
				return powTiny * powTiny
			}
			if ix >= 0x3ff00000 {
				if hy > 0 {
					return math.Inf(1) // huge*huge
				}
				return powTiny * powTiny
			}
		}
		// over/underflow if x is not close to one
		if ix < 0x3fefffff {
			if hy < 0 {
				return s * powHuge * powHuge
			}
			return s * powTiny * powTiny
		}
		if ix > 0x3ff00000 {
			if hy > 0 {
				return s * powHuge * powHuge
			}
			return s * powTiny * powTiny
		}
		// now |1-x| is tiny <= 2**-20
		t := ax - 1
		w := float64(t*t) * (powHalf - float64(t*(powThrd-float64(t*powQrtr))))
		u := ivln2H * t
		v := float64(t*ivln2L) - float64(w*powIvln2)
		t1 = u + v
		t1 = setLow(t1, 0)
		t2 = v - (t1 - u)
	} else {
		n = 0
		// take care subnormal number
		if ix < 0x00100000 {
			ax *= powTwo53
			n -= 53
			ix = int32(hi(ax))
		}
		n += (ix >> 20) - 0x3ff
		j := ix & 0x000fffff
		// determine interval
		ix = j | 0x3ff00000 // normalize ix
		var k int32
		if j <= 0x3988E {
			k = 0 // |x|<sqrt(3/2)
		} else if j < 0xBB67A {
			k = 1 // |x|<sqrt(3)
		} else {
			k = 0
			n++
			ix -= 0x00100000
		}
		ax = setHigh(ax, uint32(ix))

		// compute ss = s_h+s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
		u := ax - bp[k]
		v := 1 / (ax + bp[k])
		ss := u * v
		sH := setLow(ss, 0)
		// t_h=ax+bp[k] High
		tH := fromWords(uint32(((ix>>1)|0x20000000)+0x00080000+(k<<18)), 0)
		tL := ax - (tH - bp[k])
		sL := v * ((u - float64(sH*tH)) - float64(sH*tL))
		// compute log(ax)
		s2 := ss * ss
		r := float64(s2*s2) * float64(powL1+float64(s2*float64(powL2+float64(s2*float64(powL3+float64(s2*float64(powL4+float64(s2*float64(powL5+float64(s2*powL6))))))))))
		r += sL * (sH + ss)
		s2 = sH * sH
		tH = 3.0 + s2 + r
		tH = setLow(tH, 0)
		tL = r - ((tH - 3.0) - s2)
		// u+v = ss*(1+...)
		u = sH * tH
		v = float64(sL*tH) + float64(tL*ss)
		// 2/(3log2)*(ss+...)
		pH := u + v
		pH = setLow(pH, 0)
		pL := v - (pH - u)
		zH := powCpH * pH // cp_h+cp_l = 2/(3*log2)
		zL := float64(powCpL*pH) + float64(pL*powCp) + dpL[k]
		// log2(ax) = (ss+..)*2/(3*log2) = n + dp_h + z_h + z_l
		t := float64(n)
		t1 = ((zH + zL) + dpH[k]) + t
		t1 = setLow(t1, 0)
		t2 = zL - (((t1 - t) - dpH[k]) - zH)
	}

	// split up y into y1+y2 and compute (y1+y2)*(t1+t2)
	y1 := setLow(y, 0)
	pL := float64((y-y1)*t1) + float64(y*t2)
	pH := y1 * t1
	z := pL + pH
	zb := math.Float64bits(z)
	j, i := int32(zb>>32), int32(uint32(zb))
	if j >= 0x40900000 { // z >= 1024
		if ((j - 0x40900000) | i) != 0 { // if z > 1024
			return s * powHuge * powHuge // overflow
		}
		if pL+powOvt > z-pH {
			return s * powHuge * powHuge // overflow
		}
	} else if (j & 0x7fffffff) >= 0x4090cc00 { // z <= -1075
		if ((j - int32(-1064252416)) | i) != 0 { // z < -1075 (0xc090cc00)
			return s * powTiny * powTiny // underflow
		}
		if pL <= z-pH {
			return s * powTiny * powTiny // underflow
		}
	}
	// compute 2**(p_h+p_l)
	i = j & 0x7fffffff
	k := (i >> 20) - 0x3ff
	n = 0
	if i > 0x3fe00000 { // if |z| > 0.5, set n = [z+0.5]
		n = j + (0x00100000 >> uint(k+1))
		k = ((n & 0x7fffffff) >> 20) - 0x3ff // new k for n
		t := fromWords(uint32(n&^(0x000fffff>>uint(k))), 0)
		n = ((n & 0x000fffff) | 0x00100000) >> uint(20-k)
		if j < 0 {
			n = -n
		}
		pH -= t
	}
	t := pL + pH
	t = setLow(t, 0)
	u := t * powLg2H
	v := float64((pL-(t-pH))*powLg2) + float64(t*powLg2L)
	z = u + v
	w := v - (z - u)
	t = z * z
	t1 = z - float64(t*float64(powP1+float64(t*float64(powP2+float64(t*float64(powP3+float64(t*float64(powP4+float64(t*powP5)))))))))
	// V8 differs from fdlibm here: fdlibm computes (z*t1)/(t1-two)-(w+z*w), V8's
	// ieee754.cc computes base::Divide(z * t1, (t1 - two) - (w + z * w)). This
	// line is why plain fdlibm disagreed with Node in about 3% of results.
	r := float64(z*t1) / ((t1 - powTwo) - (w + float64(z*w)))
	z = 1 - (r - z)
	jz := int32(hi(z))
	jz += n << 20
	if (jz >> 20) <= 0 {
		z = math.Ldexp(z, int(n)) // subnormal output (scalbn)
	} else {
		z = setHigh(z, uint32(jz))
	}
	return s * z
}

// Hypot2 is V8's Math.hypot for two arguments: an infinite argument wins over NaN, then
// the values are normalised by the larger magnitude and summed with Kahan compensation.
func Hypot2(a, b float64) float64 {
	if math.IsInf(a, 0) || math.IsInf(b, 0) {
		return math.Inf(1)
	}
	if math.IsNaN(a) || math.IsNaN(b) {
		return math.NaN()
	}
	aa, ab := math.Abs(a), math.Abs(b)
	maxv := 0.0
	if aa > maxv {
		maxv = aa
	}
	if ab > maxv {
		maxv = ab
	}
	if maxv == 0 {
		return 0
	}
	sum, compensation := 0.0, 0.0
	for _, v := range [2]float64{aa, ab} {
		n := v / maxv
		summand := float64(n*n) - compensation
		preliminary := sum + summand
		compensation = (preliminary - sum) - summand
		sum = preliminary
	}
	return math.Sqrt(sum) * maxv
}

// Square is x ** 2, which V8's pow evaluates as x*x.
func Square(x float64) float64 { return x * x }
