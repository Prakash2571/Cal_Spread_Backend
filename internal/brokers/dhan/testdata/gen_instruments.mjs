// Goldens for parseDhanScripMaster and its parse report (src/brokers/dhan/instruments.ts):
// instruments.json. Every master used by the kept cases of tests/box/dhanSupport.test.mjs
// and dhanBoardJoin.test.mjs is here, with expiries derived from the fixed clock below
// (as the suites derive them from Date.now), plus header aliases, quoting, line endings
// and underlying-resolution edge cases. Each master is parsed under TZ=UTC and
// TZ=Asia/Kolkata.
import { loadDhan, rng, writeFixture, withFakes } from "./gen_common.mjs";

const NOW = Date.parse("2026-10-28T06:00:00.000Z");
const ZONES = ["UTC", "Asia/Kolkata"];
const day = (days) => new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);

export async function run() {
  const inst = await loadDhan("instruments");
  const masters = [];
  const add = (name, csv) => masters.push({ name, csv });

  // dhanSupport.test.mjs
  add("internal shape", ["EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,INSTRUMENT_TYPE,SYMBOL_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE",
    "NSE,D,45678,OPTSTK,OPTSTK,ASTRAL25SEP2500CE,ASTRAL,1512,275,2026-09-29,2500,CE,0.05",
    "NSE,E,1333,EQUITY,ES,HDFCBANK,HDFCBANK,1333,1,,0,,0.05"].join("\n"));
  add("added column", ["NEW_COL,EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,LOT_SIZE,TICK_SIZE", "ignored,NSE,D,999,FUTSTK,ASTRAL25SEPFUT,275,0.05"].join("\n"));
  add("no SECURITY_ID", "A,B\n1,2");
  add("malformed rows", ["EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,LOT_SIZE,TICK_SIZE", "NSE,D,,OPTSTK,BAD,275,0.05", "NSE,D,4242,OPTSTK,GOOD25SEP100CE,275,0.05"].join("\n"));
  const H = "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,UNDERLYING_SYMBOL,LOT_SIZE,SM_EXPIRY_DATE,TICK_SIZE";
  add("TEST scrips", [H, "NSE,D,101,FUTSTK,01INSETEST-Nov2036-FUT,01INSETEST,1,2036-11-27,0.05", "NSE,D,102,FUTSTK,TESTSCRIP26SEPFUT,TESTSCRIP,1,2026-09-29,0.05",
    "NSE,D,103,FUTSTK,RELIANCE26SEPFUT,RELIANCE,250,2026-09-29,0.05"].join("\n"));
  add("long-dated", [H, `NSE,D,201,FUTSTK,LONGDATEDFUT,LONGDATED,250,${day(3736)},0.05`, `NSE,D,202,FUTSTK,ASTRALFUT,ASTRAL,275,${day(26)},0.05`].join("\n"));
  add("equity and index", [H, "NSE,E,1512,EQUITY,ASTRAL,ASTRAL,1,,0.05", "NSE,I,13,INDEX,NIFTY 50,NIFTY,0,,0.05"].join("\n"));
  add("parse report", [H, "NSE,D,101,FUTSTK,01INSETEST-FUT,01INSETEST,1,2036-11-27,0.05", "NSE,D,103,FUTSTK,RELIANCE26SEPFUT,RELIANCE,250,2026-09-29,0.05",
    "NSE,D,,FUTSTK,BROKEN,BROKEN,250,2026-09-29,0.05"].join("\n"));
  add("missing columns", ["EXCH_ID,SECURITY_ID,SYMBOL_NAME", "NSE,999,SOMETHING"].join("\n"));
  add("samples", [H, ...Array.from({ length: 12 }, (_, i) => `NSE,D,${900 + i},FUTSTK,SYM${i}FUT,SYM${i},250,${day(26)},0.05`)].join("\n"));

  // dhanBoardJoin.test.mjs: display-style symbols, empty UNDERLYING_SYMBOL, joined by
  // UNDERLYING_SECURITY_ID.
  const FNO = [{ sym: "BHEL", eqId: 438, futBase: 50000 }, { sym: "RELIANCE", eqId: 2885, futBase: 51000 },
    { sym: "HDFCBANK", eqId: 1333, futBase: 52000 }, { sym: "SBIN", eqId: 3045, futBase: 53000 }, { sym: "TCS", eqId: 11536, futBase: 54000 }];
  const EXPIRIES = [day(20), day(48), day(76)];
  const J = "EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,DISPLAY_NAME,UNDERLYING_SYMBOL,UNDERLYING_SECURITY_ID,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE";
  {
    const rows = [J];
    for (const { sym, eqId } of FNO) rows.push(`NSE,E,${eqId},EQUITY,${sym},${sym} LTD,${sym},${eqId},1,,0,,0.05`);
    for (const { sym, eqId, futBase } of FNO) EXPIRIES.forEach((expiry, i) => {
      const label = expiry.slice(0, 7);
      rows.push(`NSE,D,${futBase + i},FUTSTK,${sym} ${label} FUT,${sym} ${label} FUT,,${eqId},250,${expiry},0,,0.05`);
    });
    add("board join by foreign key", rows.join("\n"));
  }
  add("underlying by symbol column, then by strip", [J,
    `NSE,D,60001,FUTSTK,BHEL-Nov2026-FUT,BHEL NOV FUT,BHEL,,250,${day(20)},0,,0.05`,
    `NSE,D,60002,FUTSTK,BAJAJ-AUTO-Nov2026-FUT,BAJAJ-AUTO NOV FUT,,,75,${day(20)},0,,0.05`,
    `NSE,D,60003,OPTSTK,RELIANCE-Nov2026-2500-PE,RELIANCE NOV 2500 PE,,999999,250,${day(20)},2500,PE,0.05`,
    `NSE,D,60004,OPTSTK,HDFCBANK26NOV1650CE,HDFCBANK NOV 1650 CE,,,550,${day(20)},1650,CE,0.05`,
    "NSE,E,2885,EQUITY,RELIANCE,RELIANCE LTD,RELIANCE,2885,1,,0,,0.05"].join("\n"));
  add("index futures and options", [J, "NSE,I,13,INDEX,NIFTY,NIFTY 50,NIFTY,13,0,,0,,0.05", "NSE,I,25,INDEX,BANKNIFTY,NIFTY BANK,BANKNIFTY,25,0,,0,,0.05",
    `NSE,D,35001,FUTIDX,NIFTY-Nov2026-FUT,NIFTY NOV FUT,NIFTY,13,75,${day(29)},0,,0.1`,
    `NSE,D,35002,OPTIDX,NIFTY-Nov2026-25000-CE,NIFTY 25000 CE,NIFTY,13,75,${day(29)},25000,CE,0.05`,
    `NSE,D,35003,OPTIDX,BANKNIFTY-Nov2026-48000-PE,BANKNIFTY 48000 PE,BANKNIFTY,25,30,${day(29)},48000,PE,0.05`].join("\n"));
  add("BSE, MCX, currency and unknown exchanges", [J, `BSE,D,1100001,FUTIDX,SENSEX-Nov2026-FUT,SENSEX NOV FUT,SENSEX,51,20,${day(30)},0,,0.05`,
    "BSE,E,500325,EQUITY,RELIANCE,RELIANCE LTD,RELIANCE,500325,1,,0,,0.05", `MCX,M,429116,FUTCOM,GOLD-Dec2026-FUT,GOLD DEC FUT,GOLD,,1,${day(40)},0,,1`,
    `NSE,C,10101,FUTCUR,USDINR-Nov2026-FUT,USDINR NOV FUT,USDINR,,1000,${day(28)},0,,0.0025`, "NSE,C,10102,EQUITY,USDINR,USDINR,USDINR,,1,,0,,0.0025",
    `XYZ,D,1,FUTSTK,ALIEN-FUT,ALIEN,ALIEN,,1,${day(10)},0,,0.05`, "BSE,C,77,EQUITY,BSECUR,BSECUR,BSECUR,,1,,0,,0.05"].join("\n"));
  add("detailed master aliases", ["SEM_EXM_EXCH_ID,SEGMENT_NAME,SECURITYID,INSTRUMENT_NAME,INSTRUMENTTYPE,SEM_TRADING_SYMBOL,SEM_CUSTOM_SYMBOL,SEM_UNDERLYING,SEM_UNDERLYING_SECURITY_ID,SEM_LOT_UNITS,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE",
    `NSE,D,70001,FUTSTK,FUTSTK,SBIN-Nov2026-FUT,SBIN NOV FUT,SBIN,3045,750,${day(20)} 14:30:00,0,XX,0.05`,
    "NSE,E,3045,EQUITY,ES,SBIN,SBIN,SBIN,3045,1,,0,,0.05"].join("\n"));
  add("header case, spaces and hyphens", [" exch id ,Segment,security-id,Instrument,symbol name,LOT SIZE,tick_size,SM EXPIRY DATE",
    `NSE,D,80001,FUTSTK,TCS-Nov2026-FUT,175,0.05,${day(20)}`].join("\n"));
  add("quoting, CRLF, blank lines", [J, `"NSE","D","90001","FUTSTK","M&M-Nov2026-FUT","M&M, NOV ""FUT""","M&M","2031","350","${day(20)}","0","","0.05"`, "",
    `NSE,D,90002,OPTSTK,"L&TFH 26 NOV 150 CE","L&TFH, 150 CE",L&TFH,24948,8924,${day(20)},150,CE,0.05`, "   ",
    "NSE,E,2031,EQUITY,M&M,\"MAHINDRA & MAHINDRA, LTD\",M&M,2031,1,,0,,0.05"].join("\r\n") + "\r\n");
  add("expiry formats", [J, "NSE,D,91001,FUTSTK,A-FUT,A,A,,1,29/11/2026,0,,0.05", "NSE,D,91002,FUTSTK,B-FUT,B,B,,1,2026-11-29 14:30:00,0,,0.05",
    "NSE,D,91003,FUTSTK,C-FUT,C,C,,1,NA,0,,0.05", "NSE,D,91004,FUTSTK,D-FUT,D,D,,1,,0,,0.05", "NSE,D,91005,FUTSTK,E-FUT,E,E,,1,Nov 29 2026,0,,0.05",
    "NSE,D,91006,FUTSTK,F-FUT,F,F,,1,2025-01-01,0,,0.05", `NSE,D,91007,FUTSTK,G-FUT,G,G,,1,${day(400)},0,,0.05`, `NSE,D,91008,FUTSTK,H-FUT,H,H,,1,${day(401)},0,,0.05`,
    "NSE,D,91009,FUTSTK,I-FUT,I,I,,1,garbage,0,,0.05"].join("\n"));
  add("numbers and ids", [J, "NSE,D,0,FUTSTK,ZERO,ZERO,ZERO,,1,,0,,0.05", "NSE,D,-5,FUTSTK,NEG,NEG,NEG,,1,,0,,0.05", "NSE,D,1e3,FUTSTK,EXP,EXP,EXP,,1,,0,,0.05",
    "NSE,D,0x10,FUTSTK,HEX,HEX,HEX,,1,,0,,0.05", "NSE,D, 77 ,FUTSTK,SPACE,SPACE,SPACE,,1,,0,,0.05",
    "NSE,D,abc,FUTSTK,ALPHA,ALPHA,ALPHA,,1,,0,,0.05", "NSE,D,999999999,FUTSTK,MAXID,MAXID,MAXID,,abc,,x,,y",
    "NSE,D,1000000001,FUTSTK,OVER,OVER,OVER,,1,,0,,0.05", "NSE,D,55,FUTSTK,,,,,1,,0,,0.05", "NSE,D,56,FUTSTK,,DISPLAYONLY,,,1,,0,,0.05",
    "NSE,D,57,OPTSTK,NOTYPE,NOTYPE,NOTYPE,,1,,100,,0.05"].join("\n"));
  add("header only", J);
  add("empty", "");
  add("BOM header", "\ufeff" + ["EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,SYMBOL_NAME,LOT_SIZE,TICK_SIZE", "NSE,E,11536,EQUITY,TCS,1,0.05"].join("\n"));

  // A generated master with many underlyings, for the counters and the samples cap.
  {
    const r = rng(4242);
    const rows = [J];
    for (let u = 0; u < 30; u++) {
      const sym = `U${u}${r.pick(["", "-X", " &CO"])}`;
      const eqId = 100 + u;
      rows.push(`NSE,E,${eqId},EQUITY,${sym},${sym} LTD,${sym},${eqId},1,,0,,0.05`);
      for (let k = 0; k < 3; k++) {
        const expiry = day(r.pick([5, 33, 61, 3000]));
        rows.push(`NSE,D,${100000 + u * 10 + k},${r.pick(["FUTSTK", "OPTSTK"])},${sym}-F${k},${sym} F${k},${r.pick(["", sym])},${r.pick(["", eqId])},${r.pick([250, 500])},${expiry},${r.pick([0, 100, 200.5])},${r.pick(["", "CE", "PE"])},0.05`);
      }
    }
    add("generated", rows.join("\n"));
  }
  // Last on purpose: Node keeps a FRACTIONAL security id (token 2000000012.5); Go's
  // integer identity skips that row, so the Go test expects exactly this row missing and
  // does not compare this report. Being last, its report is not carried into a
  // following empty master.
  add("fractional security id", [J, "NSE,D,12.5,FUTSTK,FRACT,FRACT,FRACT,,1,,0,,0.05", "NSE,D,13,FUTSTK,WHOLE,WHOLE,WHOLE,,1,,0,,0.05"].join("\n"));

  const cases = [];
  for (const tz of ZONES) {
    for (const m of masters) {
      const { value } = await withFakes({ now: NOW, tz }, () => {
        try {
          const rows = inst.parseDhanScripMaster(m.csv);
          return { rows, report: inst.getDhanParseReport() };
        } catch (e) {
          return { error: e.message };
        }
      });
      cases.push({ name: m.name, tz, csv: m.csv, ...value });
    }
  }
  const written = [writeFixture("instruments.json", { generator: "gen_instruments.mjs", now: NOW, zones: ZONES,
    source: "src/brokers/dhan/instruments.ts parseDhanScripMaster" }, cases)];
  return { written, counts: { masters: cases.length } };
}
