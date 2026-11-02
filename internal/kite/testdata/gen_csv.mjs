// Golden generator: src/kite.ts parseInstrumentsCsv over deterministic CSV samples.
import { loadKite, rng, writeGolden } from "./loader.mjs";

const { parseInstrumentsCsv } = await loadKite("http://127.0.0.1:9");

const HEADER = "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange";
const cases = [];

function add(name, csv) {
  let rows = null;
  let error = null;
  try {
    rows = parseInstrumentsCsv(csv);
  } catch (e) {
    error = `${e.name}: ${e.message}`;
  }
  cases.push({ name, csv, rows, error });
}

// --- realistic Kite rows -------------------------------------------------------------------
const real = [
  HEADER,
  `408065,1594,INFY,INFOSYS,0,,0,0.05,1,EQ,NSE,NSE`,
  `738561,2885,RELIANCE,RELIANCE INDUSTRIES,0,,0,0.05,1,EQ,NSE,NSE`,
  `256265,1001,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE`,
  `12335874,48187,NIFTY26NOVFUT,NIFTY,0,2026-11-24,0,0.05,75,FUT,NFO-FUT,NFO`,
  `12336130,48188,NIFTY26DECFUT,NIFTY,0,2026-12-29,0,0.05,75,FUT,NFO-FUT,NFO`,
  `13568002,52999,NIFTY2661223500CE,NIFTY,0,2026-06-12,23500,0.05,75,CE,NFO-OPT,NFO`,
  `13568258,53000,NIFTY2661223500PE,NIFTY,0,2026-06-12,23500,0.05,75,PE,NFO-OPT,NFO`,
  `4294967295,16777215,BIGTOKEN,BIG,0,2027-01-28,0,0.01,1,FUT,NFO-FUT,NFO`,
  `9007199254740993,1,PAST53,PAST 2^53,0,,0,0.05,1,EQ,NSE,NSE`,
  `1.5,2.5,FRACTION,FRAC,1e2,,0.5,.05,25.5,EQ,NSE,NSE`,
  ``,
];
add("realistic LF", real.join("\n"));
add("realistic with trailing newline", real.join("\n") + "\n");
add("realistic CRLF", real.join("\r\n"));
add("realistic CRLF trailing", real.join("\r\n") + "\r\n");
add("realistic surrounding whitespace", "\n\n  " + real.join("\n") + "\n \n\t\n");
add("realistic BOM", "\uFEFF" + real.join("\n"));
add("blank lines between rows", [HEADER, "", "1,2,A,B,3,,4,5,6,EQ,NSE,NSE", "", "", "7,8,C,D,9,,10,11,12,EQ,NSE,NSE"].join("\n"));
add("whitespace-only line is a row", [HEADER, "   ", "1,2,A,B,3,,4,5,6,EQ,NSE,NSE"].join("\n"));
add("CR-only line is a row", [HEADER, "\r", "1,2,A,B,3,,4,5,6,EQ,NSE,NSE"].join("\n"));

// --- degenerate input ---------------------------------------------------------------------
add("empty string", "");
add("only whitespace", " \n\t\r\n ");
add("header only", HEADER);
add("header only with newline", HEADER + "\n");
add("header plus blank", HEADER + "\n\n");
add("single column", "instrument_token\n5\n6");
add("no header names match", "a,b,c\n1,2,3\n4,5,6");

// --- quoting -------------------------------------------------------------------------------
add("quoted comma in name", [HEADER, `1,2,SYM,"HELLO, WORLD",3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("doubled quote", [HEADER, `1,2,SYM,"SAY ""HI""",3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("quote inside unquoted field toggles", [HEADER, `1,2,SY"M,X",3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("unterminated quote swallows the rest", [HEADER, `1,2,SYM,"OPEN,3,,4,5,6,EQ,NSE,NSE`, `7,8,C,D,9,,10,11,12,EQ,NSE,NSE`].join("\n"));
add("quoted empty", [HEADER, `1,2,"","",3,"",4,5,6,"","",""`].join("\n"));
add("only quotes", [HEADER, `1,2,"""",""""""",3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("quoted number with spaces", [HEADER, `" 12 ", 2 ,SYM,N," 1.5 ",,4,5,6,EQ,NSE,NSE`].join("\n"));
add("quoted token with comma is NaN", [HEADER, `"1,5",2,SYM,N,3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("quote then CRLF", [HEADER, `1,2,SYM,"NAME",3,,4,5,6,EQ,NSE,"NSE"`].join("\r\n"));

// --- columns: order, missing, extra -------------------------------------------------------
add("reordered columns", ["exchange,segment,instrument_type,lot_size,tick_size,strike,expiry,last_price,name,tradingsymbol,exchange_token,instrument_token", "NFO,NFO-FUT,FUT,75,0.05,0,2026-11-24,100,NIFTY,NIFTY26NOVFUT,48187,12335874"].join("\n"));
add("missing columns default", ["instrument_token,tradingsymbol", "5,AAA", "6,BBB"].join("\n"));
add("extra unknown columns", ["foo,instrument_token,bar,tradingsymbol,baz", "x,5,y,AAA,z"].join("\n"));
add("duplicate header uses first", ["instrument_token,tradingsymbol,instrument_token", "5,AAA,99"].join("\n"));
add("short rows", [HEADER, "1,2", "3", "4,5,SYM"].join("\n"));
add("long rows ignore extra", [HEADER, "1,2,A,B,3,,4,5,6,EQ,NSE,NSE,EXTRA,MORE"].join("\n"));
add("header names are trimmed", [" instrument_token , tradingsymbol ,lot_size", "5,AAA,25"].join("\n"));
add("header case sensitive", ["Instrument_Token,TRADINGSYMBOL", "5,AAA"].join("\n"));
add("header with quoted names", [`"instrument_token","tradingsymbol","lot_size"`, "5,AAA,25"].join("\n"));

// --- Number() edge cases per numeric column ------------------------------------------------
const numbers = ["", " ", "0", "-0", "00012", "+7", "-5", "1e3", "1E3", "1e-3", ".5", "5.", "-.5", "0x1F", "0X1f", "0b101", "0o17", "0x", "0xZZ", "Infinity", "-Infinity", "+Infinity", "infinity", "NaN", "abc", "12abc", "1,5", "1 2", "1_000", "١٢٣", "1e400", "-1e400", "1e-400", "123456789012345678901234567890", "0.1", "0.30000000000000004", "9007199254740993", "4294967296", "-9223372036854775809", "1e19", "\u00a05\u00a0", "\u20285\u2029", "\u30005\u3000", "\u00855", "5\u0085", "\ufeff5", "5\ufeff", "1e", "e5", "+", "-", "--5", "0.0000001", "1e21", "1.7976931348623157e308", "5e-324"];
numbers.forEach((n, i) => {
  add(
    `numeric field ${i}: ${JSON.stringify(n)}`,
    [HEADER, `${n},${n},SYM,NAME,${n},,${n},${n},${n},EQ,NSE,NSE`].join("\n"),
  );
});

// --- unicode / whitespace in strings ---------------------------------------------------------
add("non-ascii names", [HEADER, `1,2,सिंबल,名前 é ü ß 😀,3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("nbsp and ideographic spaces trimmed", [HEADER, `1,2,\u00a0SYM\u00a0,\u3000NAME\u3000,3,\u2003,4,5,6, EQ ,\ufeffNSE,NSE\u2028`].join("\n"));
add("line separator inside a field is not a row break", [HEADER, `1,2,SYM,NA\u2028ME,3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("tabs", [HEADER, `1,2,\tSYM\t,\tNAME\t,3,,4,5,6,EQ,NSE,NSE`].join("\n"));
add("emoji in quotes", [HEADER, `1,2,"😀,😀","""😀""",3,,4,5,6,EQ,NSE,NSE`].join("\n"));

// --- generated bulk ------------------------------------------------------------------------
const r = rng(271027);
const names = ["NIFTY", "BANKNIFTY", "FINNIFTY", "RELIANCE", "INFY", "M&M", "BAJAJ-AUTO", "NIFTY 50", 'QUOTE"NAME', "A,B"];
const types = ["EQ", "FUT", "CE", "PE", ""];
const bulk = [HEADER];
for (let i = 0; i < 400; i++) {
  const name = r.pick(names);
  const q = (s) => (/[",]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  bulk.push(
    [
      r.u32(),
      r.int(100000),
      q(`${name}${r.int(1000)}`),
      q(name),
      r.int(3) === 0 ? "" : (r.next() * 100000).toFixed(r.int(5)),
      r.int(2) === 0 ? "" : `20${20 + r.int(8)}-${String(1 + r.int(12)).padStart(2, "0")}-${String(1 + r.int(28)).padStart(2, "0")}`,
      r.int(2) === 0 ? 0 : r.int(50000),
      r.pick(["0.05", "0.01", "0", "5", "0.0001"]),
      r.pick([1, 25, 50, 75, 100, 15, 40]),
      r.pick(types),
      r.pick(["NSE", "NFO-FUT", "NFO-OPT", "INDICES", "BSE"]),
      r.pick(["NSE", "NFO", "BSE", "MCX"]),
    ].join(","),
  );
}
add("bulk 400 LF", bulk.join("\n"));
add("bulk 400 CRLF", bulk.join("\r\n") + "\r\n");

const written = writeGolden("instruments_csv.golden.json", { cases });
console.log(`instruments csv: ${cases.length} cases -> ${written}`);
