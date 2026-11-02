// Goldens for the margin and static-IP payload helpers of src/brokers/dhan/client.ts:
// normalizeDhanMultiMargin, describeDhanMarginPayload and extractIpv4Addresses ->
// margin.json. Pure functions; every input is JSON except the explicit `undefined` case.
import { loadDhan, writeFixture } from "./gen_common.mjs";

export async function run() {
  const client = await loadDhan("client");
  const inputs = [
    {}, null, "abc", "", 0, -5, 42, true, false, [], [1, 2],
    { totalMargin: 41250 }, { totalMarginRequired: 1 }, { total_margin: 2 }, { totalMargin: "41250.5" },
    { totalMargin: "" }, { totalMargin: null, totalMarginRequired: 5 }, { totalMargin: "abc" }, { totalMargin: 0 },
    { totalMargin: -1 }, { totalMargin: [7] }, { totalMargin: [1, 2] }, { totalMargin: true }, { totalMargin: {} },
    { totalMargin: " 12 " }, { totalMargin: "0x10" }, { totalMargin: "1e3" }, { totalMargin: "Infinity" }, { totalMargin: 1e308 * 10 === Infinity ? "1e400" : 0 },
    { data: { totalMargin: 1234 } }, { data: null, totalMargin: 5 }, { data: 0, totalMargin: 5 }, { data: "x", totalMargin: 5 },
    { data: [], totalMargin: 5 }, { data: [{ totalMargin: 1 }] }, { data: false, totalMargin: 3 },
    { totalMargin: 41250, spanMargin: 30000, exposureMargin: 11250, foMargin: 41250, marginBenefit: 158750, availableBalance: "1e6", insufficientBalance: null },
    { total_margin: 10, span_margin: "3", exposure_margin: null, fo_margin: "", margin_benefit: 2, hedge_benefit: 3, available_balance: 4, insufficient_balance: 5 },
    { totalMargin: 10, hedgeBenefit: 7 }, { totalMargin: 10, hedge_benefit: "8" }, { totalMargin: 10, spanMargin: "x", span_margin: 4 },
    { errorType: "Input_Exception", errorMessage: "bad" }, { data: { a: 1, b: 2 } }, { data: {} }, { 1: 2, b: 3, 0: 4 },
    { primaryIP: "1.2.3.4", secondaryIP: "NA" }, { ipAddress1: " 10.0.0.1 ", ipAddress2: "na" }, { data: { primaryIP: "1.2.3.4" } },
    ["1.2.3.4", "1.2.3.4", "5.6.7.8"],
    { a: "2.0.1", b: "275", c: "999.1.1.1", d: "01.2.3.4", e: "1.2.3.4 ", f: "256.1.1.1", g: "0.0.0.0", h: "255.255.255.255", i: 12345 },
    { l1: { l2: { l3: { l4: { l5: { l6: "6.6.6.6", l7: { x: "7.7.7.7" } } } } } } },
    [[[[[["6.6.6.6"]]]]], [[[[[["7.7.7.7"]]]]]]],
    { 10: "9.9.9.9", 2: "8.8.8.8", x: "7.7.7.7", "-1": "5.5.5.5" },
    { status: "success", data: { primaryIP: "203.0.113.7", secondaryIP: "", modifyDatePrimary: "2026-01-01", ipFlag: null } },
  ];
  const cases = inputs.map((input) => ({
    input,
    normalized: client.normalizeDhanMultiMargin(input),
    describe: client.describeDhanMarginPayload(input),
    ips: client.extractIpv4Addresses(input),
  }));
  cases.push({
    undefined: true,
    normalized: client.normalizeDhanMultiMargin(undefined),
    describe: client.describeDhanMarginPayload(undefined),
    ips: client.extractIpv4Addresses(undefined),
  });
  const written = [writeFixture("margin.json", { generator: "gen_margin.mjs" }, cases)];
  return { counts: { cases: cases.length }, written };
}
