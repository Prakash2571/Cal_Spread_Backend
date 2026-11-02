package jsmath

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"testing"
)

// The reference file is produced by ../testdata/gen_jsmath.mjs from Node 22 (V8).
type refFunction struct {
	Seed   uint32     `json:"seed"`
	SHA256 string     `json:"sha256"`
	First  [][]string `json:"first"`
}

type refFile struct {
	Count     int                    `json:"count"`
	Functions map[string]refFunction `json:"functions"`
	Edges     map[string][][]string  `json:"edges"`
}

type gen struct{ s uint32 }

func (g *gen) u32() uint32 {
	g.s ^= g.s << 13
	g.s ^= g.s >> 17
	g.s ^= g.s << 5
	return g.s
}

func (g *gen) unit() float64 {
	a := g.u32()
	b := g.u32()
	return (float64(float64(a)*4294967296) + float64(b)) / 18446744073709551616
}

func (g *gen) positiveBits() float64 {
	for {
		h := g.u32() & 0x7fffffff
		l := g.u32()
		if h>>20 != 0x7ff {
			return math.Float64frombits(uint64(h)<<32 | uint64(l))
		}
	}
}

type spec struct {
	args func(g *gen, i int) []float64
	f    func(a []float64) float64
}

var specs = map[string]spec{
	"exp": {func(g *gen, i int) []float64 {
		switch i % 4 {
		case 0:
			return []float64{g.unit()*1455 - 745}
		case 1:
			return []float64{g.unit()*4 - 2}
		case 2:
			return []float64{g.unit()*100 - 50}
		}
		return []float64{(g.unit() - 0.5) * 1e-6}
	}, func(a []float64) float64 { return Exp(a[0]) }},
	"log": {func(g *gen, i int) []float64 {
		switch i % 3 {
		case 0:
			return []float64{g.positiveBits()}
		case 1:
			return []float64{1 + (g.unit()-0.5)*0.01}
		}
		return []float64{g.unit() * 1000}
	}, func(a []float64) float64 { return Log(a[0]) }},
	"cube": {func(g *gen, i int) []float64 {
		if i%2 == 0 {
			return []float64{g.unit() * 10}
		}
		return []float64{g.positiveBits()}
	}, func(a []float64) float64 { return Pow(a[0], 3) }},
	"pow": {func(g *gen, i int) []float64 {
		x := g.unit() * 100
		return []float64{x, g.unit()*10 - 5}
	}, func(a []float64) float64 { return Pow(a[0], a[1]) }},
	"hypot": {func(g *gen, i int) []float64 {
		if i%2 == 0 {
			a := g.unit()*4 - 2
			return []float64{a, g.unit() * 0.5}
		}
		a := g.positiveBits()
		return []float64{a, g.positiveBits()}
	}, func(a []float64) float64 { return Hypot2(a[0], a[1]) }},
}

func loadRef(t *testing.T) refFile {
	t.Helper()
	raw, err := os.ReadFile("../testdata/jsmath.json")
	if err != nil {
		t.Fatalf("read reference: %v", err)
	}
	var ref refFile
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatalf("decode reference: %v", err)
	}
	return ref
}

func fromHex(t *testing.T, s string) float64 {
	t.Helper()
	u, err := strconv.ParseUint(s, 16, 64)
	if err != nil {
		t.Fatalf("bad hex %q", s)
	}
	return math.Float64frombits(u)
}

func hexOf(x float64) string { return strconv.FormatUint(math.Float64bits(x), 16) }

// TestBitIdenticalToV8 replays 200,000 generated inputs per function and compares the
// SHA-256 of all output bits with Node's, plus the first 1,500 outputs one by one, for
// exp, log, x**3, general x**y and hypot.
func TestBitIdenticalToV8(t *testing.T) {
	ref := loadRef(t)
	for name, sp := range specs {
		want, ok := ref.Functions[name]
		if !ok {
			t.Fatalf("reference has no %s", name)
		}
		g := &gen{s: want.Seed}
		h := sha256.New()
		var buf [8]byte
		mismatches := 0
		for i := 0; i < ref.Count; i++ {
			args := sp.args(g, i)
			y := sp.f(args)
			binary.BigEndian.PutUint64(buf[:], math.Float64bits(y))
			h.Write(buf[:])
			if i < len(want.First) {
				row := want.First[i]
				for j, a := range args {
					if fromHex(t, row[j]) != a && !(math.IsNaN(a)) {
						t.Fatalf("%s: generator diverged at %d (arg %d)", name, i, j)
					}
				}
				exp := fromHex(t, row[len(row)-1])
				if math.Float64bits(exp) != math.Float64bits(y) {
					mismatches++
					if mismatches <= 5 {
						t.Errorf("%s(%v) = %s, V8 %s", name, args, hexOf(y), row[len(row)-1])
					}
				}
			}
		}
		if got := hex.EncodeToString(h.Sum(nil)); got != want.SHA256 {
			t.Errorf("%s: output hash %s, V8 %s (%d mismatches in the first %d)", name, got[:12], want.SHA256[:12], mismatches, len(want.First))
		}
	}
}

func TestEdges(t *testing.T) {
	ref := loadRef(t)
	one := map[string]func(float64) float64{"exp": Exp, "log": Log}
	for name, f := range one {
		for _, row := range ref.Edges[name] {
			x, want := fromHex(t, row[0]), fromHex(t, row[1])
			if got := f(x); math.Float64bits(got) != math.Float64bits(want) && !(math.IsNaN(got) && math.IsNaN(want)) {
				t.Errorf("%s(%v) = %v (%s), V8 %v (%s)", name, x, got, hexOf(got), want, row[1])
			}
		}
	}
	two := map[string]func(a, b float64) float64{"hypot": Hypot2, "pow": Pow}
	for name, f := range two {
		for _, row := range ref.Edges[name] {
			a, b, want := fromHex(t, row[0]), fromHex(t, row[1]), fromHex(t, row[2])
			if got := f(a, b); math.Float64bits(got) != math.Float64bits(want) && !(math.IsNaN(got) && math.IsNaN(want)) {
				t.Errorf("%s(%v, %v) = %v, V8 %v", name, a, b, got, want)
			}
		}
	}
	x := 1.1
	if Square(x) != x*x {
		t.Fatal("square")
	}
}
