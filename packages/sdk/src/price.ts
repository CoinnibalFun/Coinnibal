import { GAS_PRICE_URL_DEFAULT } from './constants';

/**
 * ETH's USD price (Robinhood Chain's gas token) and the $1 mint price.
 *
 * The price comes from Hyperliquid's public info API (a price source only, any exchange API would do):
 * `POST {"type":"allMids"}` returns a map of mid prices as decimal strings, keyed by coin (`ETH`). All conversions are
 * exact bigint math on the decimal string (no floating point): `usdCentsToWei` rounds **up** to a multiple of 1e12
 * wei (0.000001 of the gas token), so the price is never below the target and stays readable.
 */

/** Plausible gas-token/USD range; anything outside is refused as a bad feed. */
export const GAS_USD_MIN = 0.01;
export const GAS_USD_MAX = 100_000;
/** Wei granularity of computed prices (1e12 wei = 0.000001 of the gas token). */
export const PRICE_GRANULARITY_WEI = 10n ** 12n;

const WEI = 10n ** 18n;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** A decimal price as `{ num, scale }` (`num / 10^scale`). Accepts `"38.25"`, `38.25`, `"3.8e1"`. */
export function parseDecimal(value: string | number): { num: bigint; scale: number } {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  const m = /^(\d+)?(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new RangeError(`not a decimal number: ${JSON.stringify(value)}`);
  const frac = m[2] ?? '';
  let num = BigInt((m[1] ?? '0') + frac);
  let scale = frac.length - Number(m[3] ?? 0);
  if (scale < 0) {
    num *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { num, scale };
}

/** Throws `RangeError` unless `gasUsd` is a finite price in the plausible range. */
export function checkGasUsd(gasUsd: string | number): number {
  const n = typeof gasUsd === 'number' ? gasUsd : Number(gasUsd);
  if (!Number.isFinite(n) || n < GAS_USD_MIN || n > GAS_USD_MAX) {
    throw new RangeError(`gas token / USD ${gasUsd} is outside the sane range ${GAS_USD_MIN}..${GAS_USD_MAX}`);
  }
  return n;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * Wei for `cents` US cents at `gasUsd` dollars per gas token, rounded up to 1e12 wei.
 * `wei = ceil(cents × 1e18 / (100 × gasUsd))`, exact on the decimal string.
 */
export function usdCentsToWei(cents: number | bigint, gasUsd: string | number): bigint {
  const c = typeof cents === 'bigint' ? cents : BigInt(cents);
  if (typeof cents === 'number' && !Number.isSafeInteger(cents)) throw new RangeError(`cents must be an integer, got ${cents}`);
  if (c <= 0n || c > 100_000_000_00n) throw new RangeError(`cents must be in 1..10,000,000,000, got ${cents}`);
  checkGasUsd(gasUsd);
  const { num, scale } = parseDecimal(gasUsd);
  // wei = c * 1e18 * 10^scale / (100 * num), rounded up to PRICE_GRANULARITY_WEI
  const numerator = c * WEI * 10n ** BigInt(scale);
  const denominator = 100n * num * PRICE_GRANULARITY_WEI;
  return ceilDiv(numerator, denominator) * PRICE_GRANULARITY_WEI;
}

/** US cents a wei amount is worth at `gasUsd` (a JS number, for display; rounded to 1/100 cent). */
export function weiToUsdCents(wei: bigint, gasUsd: string | number): number {
  checkGasUsd(gasUsd);
  const { num, scale } = parseDecimal(gasUsd);
  // cents * 100 (hundredths of a cent), rounded half up
  const hundredths = (wei * num * 10_000n + (WEI * 10n ** BigInt(scale)) / 2n) / (WEI * 10n ** BigInt(scale));
  return Number(hundredths) / 100;
}

/** |current − target| / target in basis points (rounded down). */
export function priceDeviationBps(current: bigint, target: bigint): number {
  if (target <= 0n) throw new RangeError('target price must be positive');
  const diff = current > target ? current - target : target - current;
  return Number((diff * 10_000n) / target);
}

/** True when `current` is off `target` by more than `thresholdBps` (default 200 = 2 %). */
export function needsReprice(current: bigint, target: bigint, thresholdBps = 200): boolean {
  return priceDeviationBps(current, target) > thresholdBps;
}

/** Clamps a price into the keeper bounds `[min, max]` (no-op without bounds: `max == 0`). */
export function clampPrice(wei: bigint, min: bigint, max: bigint): bigint {
  if (max === 0n) return wei;
  return wei < min ? min : wei > max ? max : wei;
}

/**
 * ETH's USD price (Robinhood Chain's gas token) from Hyperliquid's info API.
 * Returns the decimal string the API sent (exact, for `usdCentsToWei`) and its number value. Throws on HTTP errors,
 * a missing key, or an implausible value.
 */
export async function fetchGasUsd(opts: { url?: string; fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ price: string; value: number }> {
  const coin = 'ETH';
  const f: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof f !== 'function') throw new Error('no fetch available: pass opts.fetch');
  let signal = opts.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!signal && opts.timeoutMs !== 0 && typeof AbortController !== 'undefined') {
    const ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
    signal = ctl.signal;
  }
  try {
    const res = await f(opts.url ?? GAS_PRICE_URL_DEFAULT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`${coin} price request failed: HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown> | null;
    const raw = body && typeof body === 'object' ? body[coin] : undefined;
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error(`${coin} price missing from the allMids response`);
    const price = String(raw).trim();
    parseDecimal(price);
    const value = checkGasUsd(price);
    return { price, value };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
