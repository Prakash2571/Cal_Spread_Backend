package app

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// dotenv.golden.json is recorded from the real dotenv 17.4.2 by testdata/gen_dotenv.mjs.
type dotenvGolden struct {
	Generator string   `json:"generator"`
	Reported  []string `json:"reported"`
	Parse     []struct {
		Name    string      `json:"name"`
		Src     string      `json:"src"`
		Entries [][2]string `json:"entries"`
	} `json:"parse"`
	Config []struct {
		Name   string             `json:"name"`
		Files  map[string]string  `json:"files"` // base64
		Env    map[string]string  `json:"env"`
		Argv   []string           `json:"argv"`
		Result map[string]*string `json:"result"`
	} `json:"config"`
}

func loadDotenvGolden(t *testing.T) dotenvGolden {
	t.Helper()
	b, err := os.ReadFile("testdata/dotenv.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g dotenvGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestDotenvParseGolden(t *testing.T) {
	g := loadDotenvGolden(t)
	for _, c := range g.Parse {
		got := [][2]string{}
		for _, kv := range parseDotenv(c.Src) {
			got = append(got, [2]string{kv.key, kv.value})
		}
		want := c.Entries
		if want == nil {
			want = [][2]string{}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %q\nwant %q", c.Name, got, want)
		}
	}
	t.Logf("%d parse cases from %s", len(g.Parse), g.Generator)
}

func TestDotenvConfigGolden(t *testing.T) {
	g := loadDotenvGolden(t)
	for _, c := range g.Config {
		t.Run(c.Name, func(t *testing.T) {
			dir := t.TempDir()
			home := filepath.Join(dir, "home")
			if err := os.MkdirAll(home, 0o755); err != nil {
				t.Fatal(err)
			}
			for rel, b64 := range c.Files {
				content, err := base64.StdEncoding.DecodeString(b64)
				if err != nil {
					t.Fatal(err)
				}
				p := filepath.Join(dir, rel)
				if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, content, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			env := map[string]string{}
			for k, v := range c.Env {
				env[k] = v
			}
			_, err := Dotenv(append([]string{"/usr/local/bin/server"}, c.Argv...), DotenvEnv{
				Lookup: func(k string) (string, bool) { v, ok := env[k]; return v, ok },
				Set:    func(k, v string) error { env[k] = v; return nil },
				Cwd:    dir, Home: home,
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, k := range g.Reported {
				want := c.Result[k]
				got, ok := env[k]
				switch {
				case want == nil && ok:
					t.Errorf("%s = %q, want unset", k, got)
				case want != nil && (!ok || got != *want):
					t.Errorf("%s = %q (set %v), want %q", k, got, ok, *want)
				}
			}
		})
	}
}

// An encrypted vault is the one dotenv mode not ported: refuse rather than read .env.
func TestDotenvVaultIsRefused(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env.vault"), []byte("DOTENV_VAULT_PRODUCTION=abc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("A=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"DOTENV_KEY": "dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=production"}
	_, err := Dotenv(nil, DotenvEnv{
		Lookup: func(k string) (string, bool) { v, ok := env[k]; return v, ok },
		Set:    func(k, v string) error { env[k] = v; return nil },
		Cwd:    dir, Home: dir,
	})
	if err != ErrDotenvVault {
		t.Fatalf("err = %v, want ErrDotenvVault", err)
	}
	if _, set := env["A"]; set {
		t.Error(".env was read although the vault would have been used")
	}
}
