/**
 * Minimal, unofficial Yahoo Finance client for dividend yields.
 *
 * Uses the public `v8/finance/chart` endpoint (no crumb/cookie needed) with
 * `events=div`, sums the trailing-12-month dividends, and divides by the latest
 * price to get an annual dividend yield. NSE symbols use the ".NS" suffix.
 *
 * This is an UNOFFICIAL endpoint: it can rate-limit (HTTP 429) or change without
 * notice. Every failure degrades gracefully to a 0% yield (no dividend applied).
 */

const CHART_ROOT = "https://query1.finance.yahoo.com/v8/finance/chart";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface ChartDividend {
  amount?: number;
  date?: number;
}

interface ChartResult {
  meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
  events?: { dividends?: Record<string, ChartDividend> };
}

/** Annual trailing dividend yield (in %) for a single NSE trading symbol. */
async function fetchYieldPct(nseSymbol: string): Promise<number> {
  const url =
    `${CHART_ROOT}/${encodeURIComponent(nseSymbol)}.NS` +
    `?range=1y&interval=1mo&events=div`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return 0; // timeout / network error
  }
  if (!res.ok) return 0;

  let json: { chart?: { result?: ChartResult[] } };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return 0;
  }

  const result = json.chart?.result?.[0];
  if (!result) return 0;

  const price = result.meta?.regularMarketPrice ?? result.meta?.chartPreviousClose;
  if (!price || price <= 0) return 0;

  const dividends = result.events?.dividends ?? {};
  const cutoff = Date.now() / 1000 - 365 * 86400;
  let sum = 0;
  for (const key of Object.keys(dividends)) {
    const d = dividends[key];
    const when = d?.date ?? Number(key);
    if (d && typeof d.amount === "number" && when >= cutoff) {
      sum += d.amount;
    }
  }

  return (sum / price) * 100;
}

/**
 * Fetch dividend yields (%) for many NSE symbols with bounded concurrency.
 * Returns a map of symbol -> annual yield %. Failures map to 0.
 */
export async function getDividendYields(
  symbols: string[],
  concurrency = 6,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor++];
      if (!symbol) continue;
      out[symbol] = await fetchYieldPct(symbol).catch(() => 0);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, symbols.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}
