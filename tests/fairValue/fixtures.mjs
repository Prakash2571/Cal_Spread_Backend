import { blackFromIv } from '../../dist/fairValue/black.js';
import { yearFraction } from '../../dist/fairValue/black.js';
import { defaultConfig, configVersion } from '../../dist/fairValue/config.js';
import { historySummary } from '../../dist/fairValue/history.js';

export const NOW = Date.parse('2026-10-01T06:00:00Z');
export const EXPIRY = '2026-11-17T10:00:00Z';
export const curve = {
  source: 'test deterministic curve', as_of: '2026-10-01T06:00:00Z', version: 'fixture-v1',
  convention: 'continuous_zero_act365f', nodes: [], flat_rate: 0.05, allow_flat_fallback: true,
};
export const expiryPolicy = {
  exchange: 'NFO', timezone: 'Asia/Kolkata', local_time: '15:30:00',
  source: 'verified test fixture, not production configuration', as_of: '2026-10-01T00:00:00Z',
  version: 'fixture-v1', convention: 'last trading time on metadata expiry date', overrides: {},
};
export function metadata(strike, side = 'CE', token = strike * 2 + (side === 'PE' ? 1 : 0), expiry = EXPIRY) {
  return {
    token, tradingsymbol: `TEST-${strike}-${side}`, underlying: 'TEST', exchange: 'NFO', side,
    strike, expiry: expiry.slice(0, 10), expiry_timestamp: expiry,
    expiry_source: 'exact fixture metadata', timezone: 'Asia/Kolkata', style: 'european',
    settlement_underlying: 'official_stock_settlement', lot_size: 50, tick_size: 0.01,
    metadata_version: 'fixture-v1',
  };
}
export function quote(token, mid, overrides = {}) {
  return {
    token, bid: mid - 0.05, ask: mid + 0.05, bid_depth: 1000, ask_depth: 1000,
    exchange_timestamp: new Date(NOW - 100).toISOString(), receive_timestamp: new Date(NOW - 50).toISOString(),
    source: 'websocket', version: 1, ...overrides,
  };
}
export function clean(token, mid, overrides = {}) {
  return {
    ...quote(token, mid), mid, spread: 0.1, relative_spread: 0.1 / Math.max(mid, 1),
    age_ms: 100, freshness_basis: 'exchange', quote_timestamp: new Date(NOW - 100).toISOString(),
    available_depth: 1000, weight: 1, h: 0.05, calibration_eligible: true, reasons: [], ...overrides,
  };
}
export function chain(strikes, f = 100, t = 0.5, d = 0.98, iv = 0.2) {
  const instruments = [];
  const quotes = [];
  for (const k of strikes) for (const side of ['CE', 'PE']) {
    const inst = metadata(k, side);
    instruments.push(inst);
    quotes.push(clean(inst.token, blackFromIv(f, k, t, d, iv, side)));
  }
  return { metadata: instruments, quotes, d };
}

export function inputSnapshot({ strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120], expiries = [EXPIRY], iv = .3, configPatch = {} } = {}) {
  const config = { ...defaultConfig({}), enabled: true, curve: { ...curve }, expiry_policy: { ...expiryPolicy }, ...configPatch };
  config.quote = { ...config.quote, tick_floor: .001, premium_floor: 1, max_relative_spread: 1 };
  const instruments = [];
  const quotes = [];
  let token = 10;
  for (const expiry of expiries) {
    const t = yearFraction(expiry, NOW);
    const f = 100 * Math.exp(.05 * t);
    const d = Math.exp(-.05 * t);
    for (const strike of strikes) for (const side of ['CE', 'PE']) {
      const inst = { instrument_token: token++, exchange_token: token, tradingsymbol: `TEST-${expiry}-${strike}-${side}`,
        name: 'TEST', last_price: 0, expiry: expiry.slice(0, 10), expiry_timestamp: expiry,
        strike, tick_size: .001, lot_size: 50, instrument_type: side, segment: 'NFO-OPT', exchange: 'NFO' };
      instruments.push(inst);
      const mid = blackFromIv(f, strike, t, d, typeof iv === 'function' ? iv(strike, t) : iv, side);
      quotes.push(quote(inst.instrument_token, mid, { bid: Math.max(.000001, mid - .001), ask: mid + .001 }));
    }
  }
  return { id: 'input-fixture-v1', underlying: 'TEST', name: 'Test underlying', broker: 'zerodha', broker_generation: 1,
    feed_generation: 1, valuation_time: new Date(NOW).toISOString(), metadata_version: 'test-v1', instruments, quotes,
    spot: { value: 100, timestamp: new Date(NOW).toISOString() }, futures: [], config,
    config_version: configVersion(config), universe: { listed_contracts: instruments.length, captured_contracts: instruments.length, omitted_expiries: [], bounded: false } };
}

export function memoryStore() {
  const history = [];
  let config = null;
  return { enabled: () => true, loadConfig: async () => config, saveConfig: async (c) => { config = c; },
    append: async (snapshot, _input, limit) => { history.unshift(snapshot); history.splice(limit); },
    history: async (symbol, limit) => history.filter((s) => s.underlying === symbol).slice(0, limit).map(historySummary),
    snapshot: async (symbol, id) => history.find((s) => s.underlying === symbol && s.id === id) ?? null };
}
