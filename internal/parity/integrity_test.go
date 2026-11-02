package parity

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Expected bytes were hashed after git verified every JSON fixture unchanged from
// the reference checkpoint. Tests cannot regenerate an oracle from the Go port.
func TestRetainedGoldenIntegrity(t *testing.T) {
	f, err := os.Open("testdata/goldens.sha256")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	seen := map[string]bool{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 || len(fields[0]) != 64 || !strings.HasPrefix(fields[1], "internal/") || strings.Contains(fields[1], "..") {
			t.Fatalf("invalid fixture digest: %q", scanner.Text())
		}
		if seen[fields[1]] {
			t.Fatalf("duplicate fixture: %s", fields[1])
		}
		seen[fields[1]] = true
		data, err := os.ReadFile(filepath.Join("..", "..", fields[1]))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(data)
		if hex.EncodeToString(digest[:]) != fields[0] {
			t.Errorf("reference fixture changed: %s", fields[1])
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 39 {
		t.Fatalf("reference fixture count = %d, want 39", len(seen))
	}
}
