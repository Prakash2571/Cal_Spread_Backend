// Goldens for the small Dhan helpers: segments.ts, the identity/CSV/expiry/type helpers
// and stripContractSuffix/normalizeUnderlyingKey of instruments.ts, auth.ts
// (parseExpiry, isDhanTokenExpired, redactedSession) and errors.ts. Writes helpers.json.
// Inputs include every value the kept cases of tests/box/dhanSupport.test.mjs and
// dhanBoardJoin.test.mjs use, plus edge cases. Date-dependent helpers are recorded
// under TZ=UTC and TZ=Asia/Kolkata with a fixed Date.now.
import { loadDhan, rng, writeFixture, withFakes } from "./gen_common.mjs";

const NOW = Date.parse("2026-10-28T06:00:00.000Z");
const ZONES = ["UTC", "Asia/Kolkata"];

export async function run() {
  const segments = await loadDhan("segments");
  const inst = await loadDhan("instruments");
  const auth = await loadDhan("auth");
  const errors = await loadDhan("errors");
  const cases = [];
  const add = (fn, args, compute, extra = {}) => {
    let out;
    try { out = { value: compute() }; } catch (e) { out = { error: e.message }; }
    if (out.value === undefined) out.value = null;
    cases.push({ fn, args, ...extra, ...out });
  };

  // ---- segments --------------------------------------------------------------------
  const exchanges = ["NSE", "NFO", "BSE", "BFO", "MCX", "CDS", "BCD", "INDICES", "IDX_I", "IDX", "NSE_EQ", "NSE_FNO", "NSE_CURRENCY",
    "BSE_EQ", "BSE_FNO", "BSE_CURRENCY", "MCX_COMM", "nfo", " nse ", "\tBFO\n", "", " ", "NCDEX", "N SE", "idx", "ﬁ", "ß"];
  for (const ex of exchanges) for (const isIndex of [false, true]) add("dhanSegmentFor", [ex, isIndex], () => segments.dhanSegmentFor(ex, isIndex));
  for (let code = -1; code <= 12; code++) add("dhanSegmentFromCode", [code], () => segments.dhanSegmentFromCode(code));
  for (const code of [99, 255, 256]) add("dhanSegmentFromCode", [code], () => segments.dhanSegmentFromCode(code));
  for (const s of Object.keys(segments.DHAN_CODE_BY_SEGMENT)) add("internalExchangeFor", [s], () => segments.internalExchangeFor(s));
  add("DHAN_CODE_BY_SEGMENT", [], () => segments.DHAN_CODE_BY_SEGMENT);

  // ---- identity --------------------------------------------------------------------
  for (const s of Object.keys(segments.DHAN_CODE_BY_SEGMENT)) {
    for (const id of [1, 13, 438, 45678, 999999999]) add("dhanInternalToken", [s, id], () => inst.dhanInternalToken(s, id));
  }
  const tokens = [0, 1, 13, 999999999, 1000000000, 1000000438, 2000045678, 2000000000, 3000000001, 4000000001, 5000000001,
    7000000001, 8000000001, 8999999999, 9000000001, 10000000001, -1, -1000000001, 9007199254740991];
  for (const t of tokens) add("dhanIdentityFromToken", [t], () => inst.dhanIdentityFromToken(t));

  // ---- CSV, expiry, instrument type ---------------------------------------------------
  for (const line of ['a,"b,c",d', 'a,"say ""hi""",c', "", ",", "a,,b", ' a , b ', '"unterminated,x', '"a"b"c"', 'x,"",y', '"",""',
    'é,"😀,😀",\u2028', "a\tb,c", '"""quoted"""', 'trailing,']) {
    add("splitCsvLine", [line], () => inst.splitCsvLine(line));
  }
  const expiries = ["2026-09-29", "29/09/2026", "2026-09-29 14:30:00", "NA", "na", "", "  ", " 2026-09-29 ", "29-09-2026", "2026-9-29",
    "2026-09-29T00:00:00+05:30", "Sep 29 2026", "29 Sep 2026", "September 29, 2026", "2026/09/29", "09/29/2026", "1/2/2026",
    "2026-02-30", "31/02/2026", "Tue Sep 29 2026 23:30:00 GMT+0530", "2026-09-29T23:30:00Z", "2026-09-30T00:30:00+05:30", "1790000000000",
    "garbage", "Mon, 28 Oct 2026 20:00:00 GMT", "2026", "2026-09", "Oct 28 2026 23:59", "28 October 2026 18:30 UTC", "12/31/2026 23:59:59"];
  for (const tz of ZONES) {
    for (const raw of expiries) {
      let v;
      const { value } = await withFakes({ now: NOW, tz }, () => { try { return { v: inst.normalizeDhanExpiry(raw) }; } catch (e) { return { e: e.message }; } });
      v = value;
      cases.push({ fn: "normalizeDhanExpiry", args: [raw], tz, ...(v.e !== undefined ? { error: v.e } : { value: v.v }) });
    }
  }
  const types = [["OPTSTK", "CE"], ["OPTIDX", "PE"], ["FUTSTK", ""], ["INDEX", ""], ["EQUITY", ""], ["ES", ""], ["OPTFUT", "CALL"],
    ["optstk", " put "], ["OPTCUR", ""], ["FUTIDX", "XX"], ["INDICES", ""], ["", ""], ["", "CE"], ["CURRENCY", ""], [" futcom ", ""],
    ["OPTSTK", "XX"], ["MISC", "pe"], ["ETF", ""]];
  for (const [a, b] of types) add("normalizeDhanInstrumentType", [a, b], () => inst.normalizeDhanInstrumentType(a, b));

  // ---- suffix stripping and keys (dhanBoardJoin.test.mjs) ------------------------------
  const symbols = ["BHEL-Sep2026-FUT", "BHEL-SEP26-FUT", "BHEL26SEPFUT", "RELIANCE 2026-09-29 FUT", "NIFTY 25 SEP FUT", "SBIN", "RELIANCE",
    "BAJAJ-AUTO", "M&M", "L&TFH", "TATASTEEL", "IDEA", "HDFCBANK", "BAJAJ-AUTO-Sep2026-FUT", "BAJAJ-AUTO 2500 CE", "BHEL 300 CE",
    "RELIANCE-Sep2026-2500-PE", "HDFCBANK26SEP1650CE", "BHEL300.5CE", "  bhel 25 sep fut ", "NIFTY BANK 26 OCT FUT", "FUT", "CE",
    "26SEP", "NIFTY2661223500CE", "BANKNIFTY26OCT48000PE", "ABC_DEF_26OCT_FUT", "X-1-2-3", "NIFTY-OCT2026-25000-CE", "M&M 26 NOV FUT",
    "", "   ", "ÉTOILE 26 SEP FUT", "SEP", "OCTFUT", "A1B2C3", "PE-FUT", "123", "NIFTY 50"];
  for (const s of symbols) add("stripContractSuffix", [s], () => inst.stripContractSuffix(s));
  for (const s of ["  bhel ", "nifty  bank", "\tNifty\u00a0 Bank\n", "", "ß", "a b  c", "Ｎｉｆｔｙ"]) add("normalizeUnderlyingKey", [s], () => inst.normalizeUnderlyingKey(s));

  // ---- auth ----------------------------------------------------------------------------
  const expiryValues = [1_800_000_000_000, 1_800_000_000, 1_800_000_000.4, 1_800_000_000.5, 99_999_999_999, 100_000_000_000, 0, -5, 1.5,
    "2026-09-04T00:00:00.000Z", "not a date", null, "", "  ", "1800000000", " 1800000000000 ", "1.8e9", "0x10", "2026-09-04",
    "2026-09-04 10:00:00", "Sep 4 2026", true, false, NaN, Infinity, "Infinity", "-1", "1e11", "99999999999.9"];
  for (const tz of ZONES) {
    for (const v of expiryValues) {
      const { value } = await withFakes({ now: NOW, tz }, () => auth.parseExpiry(v));
      cases.push({ fn: "parseExpiry", args: [v], tz, value });
    }
    const { value } = await withFakes({ now: NOW, tz }, () => auth.parseExpiry(undefined));
    cases.push({ fn: "parseExpiry", args: [], tz, value, undefinedArg: true });
  }
  for (const [e, n] of [[null, NOW], [NOW - 1, NOW], [NOW + 60_000, NOW], [NOW, NOW], [0, NOW], [-1, 0]]) {
    add("isDhanTokenExpired", [e, n], () => auth.isDhanTokenExpired(e, n));
  }
  const sessions = [
    { dhan_client_id: "C1", dhan_client_name: "Trader", dhan_client_ucc: "UCC1", given_power_of_attorney: true, expiry_time: 1_800_000_000_000,
      login_date: "2026-09-03", login_at: "2026-09-03T04:00:00.000Z" },
    { dhan_client_id: "C2", dhan_client_name: "", dhan_client_ucc: "", given_power_of_attorney: false, expiry_time: NOW - 1, login_date: "", login_at: null },
    { dhan_client_id: "C3", dhan_client_name: "Ünïcode", dhan_client_ucc: "U", given_power_of_attorney: false, expiry_time: null,
      login_date: "2026-10-28", login_at: "2026-10-28T05:59:59.123Z" },
    { dhan_client_id: "C4", dhan_client_name: "X", dhan_client_ucc: "Y", given_power_of_attorney: true, expiry_time: NOW, login_date: "2026-10-28" },
  ];
  for (const s of sessions) {
    const input = { ...s, ...(s.login_at === undefined ? {} : { login_at: s.login_at === null ? null : new Date(s.login_at) }) };
    const { value } = await withFakes({ now: NOW }, () => auth.redactedSession(input));
    cases.push({ fn: "redactedSession", args: [s], now: NOW, value });
  }

  // ---- errors ----------------------------------------------------------------------
  const bodies = [{ errorMessage: "Invalid token" }, {}, null, "plain text body", { errorCode: "DH-901", errorMessage: "Access token expired" },
    { message: "Too many" }, { errorType: "Order_Error", errorCode: "DH-906", errorMessage: "Order rejected" },
    { data: { errorMessage: "nested" } }, { errorMessage: "" }, { errorMessage: 42 }, { errorCode: 905 }, [1, 2], 0, { status: "failure", remarks: "x" },
    { internalErrorMessage: "boom", errorMessage: null }];
  for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503, 0, 200, 302, 499]) {
    for (const b of bodies) {
      add("normalizeDhanError", [status, b, "fallback text"], () => {
        const e = errors.normalizeDhanError(status, b, "fallback text");
        return { name: e.name, message: e.message, status: e.status, code: e.code ?? null, retryAfterSec: e.retryAfterSec ?? null,
          isDefinitive: e.isDefinitive, retryableRead: errors.isRetryableRead(e) };
      });
    }
  }
  const direct = [["DhanError", ["x", 400]], ["DhanError", ["x", 404]], ["DhanError", ["x", 429]], ["DhanError", ["x", 500]],
    ["DhanError", ["boom", 502]], ["DhanError", ["x", 0]], ["DhanNetworkError", ["timeout"]], ["DhanAuthError", ["denied", 401]],
    ["DhanRateLimitError", ["slow down", 7]], ["DhanRateLimitError", ["slow down"]], ["DhanTradingBlockedError", ["blocked"]]];
  for (const [cls, args] of direct) {
    add(`new ${cls}`, args, () => {
      const e = new errors[cls](...args);
      return { name: e.name, message: e.message, status: e.status, code: e.code ?? null, retryAfterSec: e.retryAfterSec ?? null,
        isDefinitive: e.isDefinitive, retryableRead: errors.isRetryableRead(e) };
    });
  }
  for (const [label, v] of [["Error", new Error("plain")], ["string", "x"], ["null", null], ["TypeError fetch failed", new TypeError("fetch failed")]]) {
    add("isRetryableRead", [label], () => errors.isRetryableRead(v));
  }

  // Random identity round trips.
  const r = rng(20261028);
  const codes = Object.entries(segments.DHAN_CODE_BY_SEGMENT);
  for (let i = 0; i < 60; i++) {
    const [s] = r.pick(codes);
    const id = 1 + r.int(999_999_998);
    const t = inst.dhanInternalToken(s, id);
    add("dhanIdentityFromToken", [t], () => inst.dhanIdentityFromToken(t));
  }

  const written = [writeFixture("helpers.json", { generator: "gen_helpers.mjs", now: NOW, zones: ZONES,
    source: "src/brokers/dhan/{segments,instruments,auth,errors}.ts" }, cases)];
  return { written, counts: { helpers: cases.length } };
}
