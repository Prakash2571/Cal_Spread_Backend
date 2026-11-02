package parity

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const referenceCommit = "1ea1d958ebf5c4a0fc673d786f5ee9638bdffa8d"

type suiteManifest struct {
	ReferenceCommit string         `json:"reference_commit"`
	FairValueCases  int            `json:"fair_value_cases"`
	SharedCases     int            `json:"shared_cases"`
	Totals          map[string]int `json:"totals"`
	Suites          []struct {
		File   string   `json:"file"`
		SHA256 string   `json:"sha256"`
		Titles []string `json:"titles"`
	} `json:"suites"`
}

// No Node runtime or retired TypeScript files are needed to check the original
// suite accounting. Behavioral assertions run in the referenced Go packages.
func TestEveryRetainedReferenceCaseHasAnAuditedGoTest(t *testing.T) {
	read := func(path string, out any) {
		t.Helper()
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, out); err != nil {
			t.Fatal(err)
		}
	}
	var spec suiteManifest
	read("testdata/kept-suites.json", &spec)
	if spec.ReferenceCommit != referenceCommit || len(spec.Suites) != 32 || spec.FairValueCases != 42 || spec.SharedCases != 290 {
		t.Fatalf("retained reference inventory drifted: %+v", spec)
	}
	root := filepath.Join("..", "..")
	file, err := os.Open(filepath.Join(root, "tasks/2026-10-27-go-postgres-migration/reports/2026-11-02-kept-suite-audit.md"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	aliasPattern := regexp.MustCompile("^\\| ([A-Z0-9]+) \\| `(internal/[\\w/.-]+_test\\.go)` \\|$")
	suitePattern := regexp.MustCompile("^## `(tests/.*\\.test\\.mjs)`")
	refPattern := regexp.MustCompile(`(internal/[\w/.-]+_test\.go|[A-Z0-9]+)::(Test\w+)`)
	aliases := map[string]string{}
	rows := map[string]map[string]string{}
	functions := map[string]map[string]bool{}
	current := ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if match := aliasPattern.FindStringSubmatch(line); match != nil {
			aliases[match[1]] = match[2]
		}
		if match := suitePattern.FindStringSubmatch(line); match != nil {
			current = match[1]
			if rows[current] != nil {
				t.Fatalf("duplicate suite %s", current)
			}
			rows[current] = map[string]string{}
			continue
		}
		if current == "" || !strings.HasPrefix(line, `| "`) {
			continue
		}
		cells := strings.Split(line, "|")
		if len(cells) < 6 {
			t.Fatalf("invalid audit row: %s", line)
		}
		title := strings.TrimSpace(cells[1])
		if !strings.HasPrefix(title, `"`) || !strings.HasSuffix(title, `"`) {
			t.Fatalf("invalid title: %s", title)
		}
		title = title[1 : len(title)-1]
		status, evidence, reason := strings.TrimSpace(cells[2]), cells[3], strings.TrimSpace(cells[4])
		if rows[current][title] != "" {
			t.Fatalf("duplicate case %s: %s", current, title)
		}
		if status != "COVERED" && status != "PORTED" && status != "N/A" {
			t.Fatalf("unfinished case %s: %s", current, title)
		}
		refs := refPattern.FindAllStringSubmatch(evidence, -1)
		if status != "N/A" && len(refs) == 0 || status == "N/A" && len(reason) < 30 {
			t.Fatalf("case lacks evidence or an N/A rationale: %s", title)
		}
		for _, ref := range refs {
			path := ref[1]
			if alias := aliases[path]; alias != "" {
				path = alias
			}
			if !strings.HasPrefix(path, "internal/") || strings.Contains(path, "..") {
				t.Fatalf("invalid Go reference: %s", path)
			}
			if functions[path] == nil {
				tree, err := parser.ParseFile(token.NewFileSet(), filepath.Join(root, path), nil, 0)
				if err != nil {
					t.Fatal(err)
				}
				functions[path] = map[string]bool{}
				for _, decl := range tree.Decls {
					if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil {
						functions[path][fn.Name.Name] = true
					}
				}
			}
			if !functions[path][ref[2]] {
				t.Fatalf("Go test reference disappeared: %s::%s", path, ref[2])
			}
		}
		rows[current][title] = status
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(rows) != len(spec.Suites) {
		t.Fatalf("audit contains %d suites, reference has %d", len(rows), len(spec.Suites))
	}
	totals := map[string]int{}
	fv, shared := 0, 0
	for _, suite := range spec.Suites {
		if bytes, err := hex.DecodeString(suite.SHA256); err != nil || len(bytes) != 32 {
			t.Fatalf("invalid original source checksum: %s", suite.File)
		}
		if len(rows[suite.File]) != len(suite.Titles) {
			t.Fatalf("case count changed: %s", suite.File)
		}
		seen := map[string]bool{}
		for _, title := range suite.Titles {
			status := rows[suite.File][title]
			if seen[title] || status == "" {
				t.Fatalf("original case missing or duplicated: %s: %s", suite.File, title)
			}
			seen[title] = true
			totals[status]++
		}
		if strings.HasPrefix(suite.File, "tests/fairValue/") {
			fv += len(suite.Titles)
		} else {
			shared += len(suite.Titles)
		}
	}
	if fv != 42 || shared != 290 || totals["COVERED"] != 250 || totals["PORTED"] != 78 || totals["N/A"] != 4 {
		t.Fatalf("case accounting changed: FV=%d shared=%d classifications=%v", fv, shared, totals)
	}
}
