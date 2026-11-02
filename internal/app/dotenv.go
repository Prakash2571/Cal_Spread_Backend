package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The first line of src/index.ts is `import "dotenv/config"` (dotenv 17.4.2): before
// anything reads process.env, the variables of a .env file are added to it without
// replacing variables that are already set. The deployment keeps its configuration in
// that file, so cmd/server calls LoadDotenv first. This is a port of config.js,
// lib/env-options.js, lib/cli-options.js and the parse/populate/configDotenv functions
// of lib/main.js; internal/app/testdata/gen_dotenv.mjs records the real module's results
// for the golden test.

// DotenvEnv is the process state dotenv/config reads and writes.
type DotenvEnv struct {
	// Lookup reads a variable (os.LookupEnv): set-but-empty differs from unset.
	Lookup func(key string) (string, bool)
	// Set writes a variable (os.Setenv).
	Set func(key, value string) error
	// Cwd is process.cwd(), Home is os.homedir() (for a DOTENV_CONFIG_PATH of "~/...").
	Cwd, Home string
	// Logf receives dotenv's own messages (only when DOTENV_CONFIG_QUIET is false or
	// debug is on, and the DOTENV_KEY warning); nil means none.
	Logf func(format string, args ...any)
}

// ErrDotenvVault is returned when DOTENV_KEY is set and the encrypted .env.vault it
// names exists: dotenv would decrypt the vault instead of reading .env, which this port
// does not implement.
var ErrDotenvVault = errors.New("dotenv: DOTENV_KEY is set and a .env.vault exists; encrypted vaults are not supported (decrypt it into .env)")

// LoadDotenv is `import "dotenv/config"` for this process: os.Args, the real environment
// and the working directory.
func LoadDotenv() (int, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return 0, err
	}
	home, _ := os.UserHomeDir()
	return Dotenv(os.Args, DotenvEnv{Lookup: os.LookupEnv, Set: os.Setenv, Cwd: cwd, Home: home, Logf: logStdout})
}

func logStdout(format string, args ...any) { fmt.Printf(format+"\n", args...) }

// dotenvArg is cli-options.js: dotenv_config_<option>=<value> on the command line.
var dotenvArg = regexp.MustCompile(`^dotenv_config_(encoding|path|quiet|debug|override|DOTENV_KEY)=([^\n\r\x{2028}\x{2029}]+)$`)

// Dotenv is config.js: the options come from DOTENV_CONFIG_* variables, overridden by
// dotenv_config_*=value arguments, then the file is read (path option, else <cwd>/.env)
// and its variables are added to the environment. A missing or unreadable file is
// silently ignored, as dotenv/config ignores the error it returns. It reports how many
// variables it set.
func Dotenv(args []string, env DotenvEnv) (int, error) {
	opts := map[string]string{}
	for _, o := range []struct{ name, variable string }{
		{"encoding", "DOTENV_CONFIG_ENCODING"}, {"path", "DOTENV_CONFIG_PATH"},
		{"quiet", "DOTENV_CONFIG_QUIET"}, {"debug", "DOTENV_CONFIG_DEBUG"},
		{"override", "DOTENV_CONFIG_OVERRIDE"}, {"DOTENV_KEY", "DOTENV_CONFIG_DOTENV_KEY"},
	} {
		if v, ok := env.Lookup(o.variable); ok {
			opts[o.name] = v
		}
	}
	cli := map[string]string{}
	for _, arg := range args {
		if m := dotenvArg.FindStringSubmatch(arg); m != nil {
			cli[m[1]] = m[2]
		}
	}
	if _, ok := cli["quiet"]; !ok {
		cli["quiet"] = "true"
	}
	for k, v := range cli {
		opts[k] = v
	}

	// config(): the encrypted-vault path only when a DOTENV_KEY is given.
	key := opts["DOTENV_KEY"]
	if key == "" {
		key, _ = env.Lookup("DOTENV_KEY")
	}
	if key != "" {
		vault := filepath.Join(env.Cwd, ".env.vault")
		if p := opts["path"]; p != "" {
			vault = p
			if !strings.HasSuffix(p, ".vault") {
				vault = p + ".vault"
			}
			if !filepath.IsAbs(vault) {
				vault = filepath.Join(env.Cwd, vault)
			}
		}
		if _, err := os.Stat(vault); err == nil {
			return 0, ErrDotenvVault
		}
		if env.Logf != nil {
			env.Logf("⚠ you set DOTENV_KEY but you are missing a .env.vault file at null")
		}
	}
	return configDotenv(opts, env)
}

// configDotenv is lib/main.js configDotenv for one path.
func configDotenv(opts map[string]string, env DotenvEnv) (int, error) {
	path := filepath.Join(env.Cwd, ".env")
	if p := opts["path"]; p != "" {
		path = resolveHome(p, env.Home)
		if !filepath.IsAbs(path) {
			path = filepath.Join(env.Cwd, path)
		}
	}
	var parsed []dotenvPair
	src, err := readDotenvFile(path, opts["encoding"])
	if err == nil {
		parsed = parseDotenv(src)
	}
	// populate(): Boolean(options.override), so any non-empty value (even "false")
	// overrides variables that are already set.
	override := opts["override"] != ""
	n := 0
	for _, kv := range parsed {
		if _, exists := env.Lookup(kv.key); exists && !override {
			continue
		}
		if setErr := env.Set(kv.key, kv.value); setErr == nil {
			n++
		}
	}
	quiet := dotenvBool(firstSet(env, "DOTENV_CONFIG_QUIET", opts["quiet"]))
	debug := dotenvBool(firstSet(env, "DOTENV_CONFIG_DEBUG", opts["debug"]))
	if (debug || !quiet) && env.Logf != nil {
		rel, relErr := filepath.Rel(env.Cwd, path)
		if relErr != nil {
			rel = path
		}
		env.Logf("◇ injected env (%d) from %s", n, rel)
	}
	return n, nil
}

type dotenvPair struct{ key, value string }

// resolveHome is _resolveHome: a leading "~" is the home directory.
func resolveHome(p, home string) string {
	if strings.HasPrefix(p, "~") {
		return filepath.Join(home, p[1:])
	}
	return p
}

// readDotenvFile is fs.readFileSync(path, {encoding}): UTF-8 by default (invalid bytes
// become U+FFFD), latin1/binary on request. Other encodings are not supported and fail
// the read, like an encoding Node does not know.
func readDotenvFile(path, encoding string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	switch strings.ToLower(encoding) {
	case "", "utf8", "utf-8":
		return strings.ToValidUTF8(string(b), "\uFFFD"), nil
	case "latin1", "binary":
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c)
		}
		return string(r), nil
	}
	return "", fmt.Errorf("dotenv: unsupported encoding %q", encoding)
}

// firstSet is `processEnv.NAME || fallback` (an empty variable falls through).
func firstSet(env DotenvEnv, name, fallback string) string {
	if v, _ := env.Lookup(name); v != "" {
		return v
	}
	return fallback
}

// dotenvBool is parseBoolean for strings: everything but false/0/no/off/"" is true.
func dotenvBool(v string) bool {
	switch strings.ToLower(v) {
	case "false", "0", "no", "off", "":
		return false
	}
	return true
}

// jsSpace is JavaScript's \s (and the set String.prototype.trim removes).
const jsSpace = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// dotenvLine is lib/main.js LINE, /…/mg, in RE2 syntax. Go's matcher is leftmost-first,
// so it picks the same matches and groups as V8's backtracking one; \s and . are spelled
// out because RE2's are ASCII-only.
var dotenvLine = regexp.MustCompile(`(?m)(?:^|^)[` + jsSpace + `]*(?:export[` + jsSpace + `]+)?([\w.-]+)(?:[` + jsSpace + `]*=[` + jsSpace + `]*?|:[` + jsSpace + `]+?)(` +
	`[` + jsSpace + `]*'(?:\\'|[^'])*'|` +
	`[` + jsSpace + `]*"(?:\\"|[^"])*"|` +
	`[` + jsSpace + "]*`(?:\\\\`|[^`])*`|" +
	`[^#\r\n]+)?[` + jsSpace + `]*(?:#[^\n\r\x{2028}\x{2029}]*)?(?:$|$)`)

// parseDotenv is dotenv.parse: KEY=VALUE pairs in file order (a repeated key keeps its
// first position and takes the last value, as object assignment does).
func parseDotenv(src string) []dotenvPair {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	src = strings.ReplaceAll(src, "\r", "\n")
	var out []dotenvPair
	index := map[string]int{}
	for _, m := range dotenvLine.FindAllStringSubmatchIndex(src, -1) {
		key := src[m[2]:m[3]]
		value := ""
		if m[4] >= 0 {
			value = src[m[4]:m[5]]
		}
		value = strings.Trim(value, "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
		doubleQuoted := strings.HasPrefix(value, `"`)
		value = stripDotenvQuotes(value)
		if doubleQuoted {
			value = strings.ReplaceAll(value, `\n`, "\n")
			value = strings.ReplaceAll(value, `\r`, "\r")
		}
		if i, seen := index[key]; seen {
			out[i].value = value
			continue
		}
		if key == "__proto__" {
			// obj["__proto__"] = "<string>" sets no property on a plain object.
			continue
		}
		index[key] = len(out)
		out = append(out, dotenvPair{key, value})
	}
	return out
}

// stripDotenvQuotes is value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2'): at a line start, a
// quote, then everything up to the LAST same quote that ends a line (greedy), replaced
// by what lies between. RE2 has no backreference, hence the hand-written scan.
func stripDotenvQuotes(v string) string {
	var b strings.Builder
	last, pos, changed := 0, 0, false
	for pos < len(v) {
		i := pos
		for i < len(v) && !lineStart(v, i) {
			i++
		}
		if i >= len(v) {
			break
		}
		if q := v[i]; q == '\'' || q == '"' || q == '`' {
			j := -1
			for k := len(v) - 1; k > i; k-- {
				if v[k] == q && lineEnd(v, k+1) {
					j = k
					break
				}
			}
			if j > i {
				b.WriteString(v[last:i])
				b.WriteString(v[i+1 : j])
				last, pos, changed = j+1, j+1, true
				continue
			}
		}
		pos = i + 1
	}
	if !changed {
		return v
	}
	b.WriteString(v[last:])
	return b.String()
}

// lineStart is ^ under the m flag: the start, or just after a line terminator.
func lineStart(v string, p int) bool {
	if p == 0 {
		return true
	}
	if c := v[p-1]; c == '\n' || c == '\r' {
		return true
	}
	return strings.HasSuffix(v[:p], "\u2028") || strings.HasSuffix(v[:p], "\u2029")
}

// lineEnd is $ under the m flag: the end, or just before a line terminator.
func lineEnd(v string, p int) bool {
	if p >= len(v) {
		return true
	}
	if c := v[p]; c == '\n' || c == '\r' {
		return true
	}
	return strings.HasPrefix(v[p:], "\u2028") || strings.HasPrefix(v[p:], "\u2029")
}
