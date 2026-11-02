// Records what dotenv 17.4.2 (`import "dotenv/config"`, the first line of src/index.ts)
// does, for internal/app/dotenv_test.go:
//   parse:  dotenv.parse(src) for crafted inputs and the repository's .env.example;
//   config: a child Node process that requires dotenv/config.js with a given working
//           directory, environment and argv, then reports the variables that matter.
//
// Run from the repository root:
//   scratch/go-migration/check.sh node internal/app/testdata/gen_dotenv.mjs
// DOTENV_PACKAGE points at the dotenv package directory (default: the copy extracted
// read-only from the npm cache, scratch/go-migration/tmp/server/dotenv-17.4.2/package).
// Its version must match package-lock.json.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const pkgDir = path.resolve(process.env.DOTENV_PACKAGE ?? "scratch/go-migration/tmp/server/dotenv-17.4.2/package");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const want = lock.packages["node_modules/dotenv"].version;
const have = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
if (want !== have) throw new Error(`dotenv ${have} at ${pkgDir}, package-lock.json pins ${want}`);
const dotenv = createRequire(path.join(pkgDir, "package.json"))("./lib/main.js");

const parseCases = [
  ["basic", "A=1\nB=2"],
  ["surrounding spaces", "  A = 1  \n B=  2\t"],
  ["export prefix", "export A=1\nexport   B=2\nexportC=3"],
  ["colon separator", "A: 1\nB:2\nC:  three"],
  ["quotes", "S='single'\nD=\"double\"\nT=`back`\nI='it''s'"],
  ["double-quoted escapes", 'N="a\\nb\\rc"\nS=\'a\\nb\'\nT=`a\\nb`'],
  ["literal backslashes", 'A="a\\\\nb"\nB=a\\nb'],
  ["multiline double quoted", 'M="line1\nline2\n  line3"\nNEXT=1'],
  ["multiline single quoted", "M='one\ntwo'\nNEXT=2"],
  ["comments", "# comment\nA=1 # trailing\nB=2#nospace\nC='x # y' # z\n  # indented\nD=\"h#sh\""],
  ["empty values", "A=\nB=''\nC=\"\"\nD=``\nE= \nF"],
  ["unterminated quotes", "A='abc\nB=\"def\nC=`ghi\nD=ok"],
  ["mismatched trailing quote", "A='a' b'\nB=\"a\" b\"\nC='a'b\nD=\"a\"'"],
  ["equals in value", "A=b=c\nB==x\nURL=postgres://u:p@h:5432/db?sslmode=disable"],
  ["key characters", "a.b-c=1\nA_1=2\n1X=3\nA B=4\n=5\n-x=6\n.y=7"],
  ["duplicates", "A=1\nB=x\nA=2"],
  ["proto key", "__proto__=x\nconstructor=y\nB=1"],
  ["unicode whitespace", "\uFEFFA=1\nB=\u00a0x\u00a0\nC=\u3000y\nD=a\u2028b"],
  ["line endings", "A=1\r\nB=2\r\nC=3\rD=4"],
  ["escaped quotes", 'A="a\\"b"\nB=\'a\\\'b\'\nC="a\\"\nD=`a\\`b`'],
  ["inner other quotes", "A=`a\"b'c`\nB=\"x'y\"\nC='p\"q'"],
  ["tabs and spaces", "A=\tx\t\nB=  'quoted'  \nC=\" spaced \""],
  ["values that look like options", "PORT=3001\nEXTRA_SESSION_DAYS=2026-11-08,2027-10-29\nFAIR_VALUE_CONFIG_JSON={\"enabled\":true}\nEMPTY="],
  ["blank lines", "\n\n  \nA=1\n\n\nB=2\n"],
  ["no trailing newline", "A=last"],
];

const parse = parseCases.map(([name, src]) => ({ name, src, entries: Object.entries(dotenv.parse(src)) }));
const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
parse.push({ name: ".env.example", src: example, entries: Object.entries(dotenv.parse(example)) });

// config(): files written into a scratch directory, a child process per case.
const configCases = [
  { name: "default .env, existing variables win", files: { ".env": "A=from-file\nB=\"two words\"\nC=3" }, env: { A: "preset" } },
  { name: "existing empty variable is kept", files: { ".env": "A=from-file\nB=2" }, env: { A: "" } },
  { name: "no .env file", files: {}, env: {} },
  { name: "DOTENV_CONFIG_PATH relative", files: { ".env": "A=default", "custom.env": "A=custom\nB=b" }, env: { DOTENV_CONFIG_PATH: "custom.env" } },
  { name: "DOTENV_CONFIG_PATH empty means .env", files: { ".env": "A=default" }, env: { DOTENV_CONFIG_PATH: "" } },
  { name: "DOTENV_CONFIG_PATH missing file", files: { ".env": "A=default" }, env: { DOTENV_CONFIG_PATH: "nope.env" } },
  { name: "DOTENV_CONFIG_PATH under home", files: { "home/h.env": "A=home" }, env: { DOTENV_CONFIG_PATH: "~/h.env" } },
  { name: "DOTENV_CONFIG_OVERRIDE=false still overrides", files: { ".env": "A=from-file" }, env: { A: "preset", DOTENV_CONFIG_OVERRIDE: "false" } },
  { name: "DOTENV_CONFIG_OVERRIDE empty does not", files: { ".env": "A=from-file" }, env: { A: "preset", DOTENV_CONFIG_OVERRIDE: "" } },
  { name: "argv path wins over DOTENV_CONFIG_PATH", files: { "custom.env": "A=custom", "other.env": "A=other" }, env: { DOTENV_CONFIG_PATH: "custom.env" }, argv: ["dotenv_config_path=other.env"] },
  { name: "argv override", files: { ".env": "A=from-file" }, env: { A: "preset" }, argv: ["dotenv_config_override=1"] },
  { name: "argv option needs a value", files: { ".env": "A=default", "x.env": "A=x" }, env: {}, argv: ["dotenv_config_path="] },
  { name: "DOTENV_KEY without a vault reads .env", files: { ".env": "A=plain" }, env: { DOTENV_KEY: "dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=production" } },
  { name: "CRLF file", files: { ".env": "A=1\r\nB=\"x\"\r\n" }, env: {} },
  { name: "latin1 encoding", files: { ".env": Buffer.from([0x41, 0x3d, 0xe9, 0x0a]) }, env: { DOTENV_CONFIG_ENCODING: "latin1" } },
  { name: "invalid UTF-8 byte", files: { ".env": Buffer.from([0x41, 0x3d, 0x61, 0xff, 0x62, 0x0a]) }, env: {} },
  { name: "a directory instead of a file", files: { "dir/.keep": "" }, env: { DOTENV_CONFIG_PATH: "dir" } },
];
const reported = ["A", "B", "C", "DOTENV_CONFIG_PATH", "DOTENV_CONFIG_OVERRIDE", "DOTENV_KEY"];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gen-dotenv-"));
const config = [];
try {
  for (const [i, c] of configCases.entries()) {
    const dir = path.join(scratch, String(i));
    fs.mkdirSync(path.join(dir, "home"), { recursive: true });
    const files = {};
    for (const [rel, content] of Object.entries(c.files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      fs.writeFileSync(p, buf);
      files[rel] = buf.toString("base64");
    }
    const script = `require(${JSON.stringify(path.join(pkgDir, "config.js"))});` +
      `const out = {}; for (const k of ${JSON.stringify(reported)}) out[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : null;` +
      `process.stdout.write("\\n@@" + JSON.stringify(out));`;
    const env = { HOME: path.join(dir, "home"), ...c.env };
    const r = spawnSync(process.execPath, ["-e", script, ...(c.argv ?? [])], { cwd: dir, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${c.name}: ${r.stderr}`);
    const result = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("@@") + 2));
    config.push({ name: c.name, files, env: c.env, argv: c.argv ?? [], result });
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const out = { generator: `dotenv ${have} (${path.relative(root, pkgDir) || pkgDir}), node ${process.version}`, reported, parse, config };
fs.writeFileSync(path.join(root, "internal/app/testdata/dotenv.golden.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`dotenv.golden.json: ${parse.length} parse cases, ${config.length} config cases`);
