import { formatUsd, parseUsdPrice, tokenRawToUsd, type ArenaPricesView } from '@elymum/shared';

/**
 * US dollars where money is spent (the ticket sheet, the round receipt): "≈ $1.00 · price set 14:20", from the token
 * price the server publishes (`GET /api/site/arena-prices`). It is the owner's manual price, not a market feed, so the
 * age is always shown and an old one is called out. No price, nothing shown: never a made-up dollar figure.
 * Pure: unit-tested.
 */

/** A price older than this many hours is called out (`VITE_PRICE_STALE_HOURS`, default 6). */
export const PRICE_STALE_HOURS = staleHours(import.meta.env.VITE_PRICE_STALE_HOURS as string | undefined);

export function staleHours(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : 6;
}

export interface UsdQuote {
  /** `≈ $1.00` */
  text: string;
  /** When the price was set, as the player's clock shows it (`14:20`, or `5 Nov 14:20` on another day); null: unknown. */
  setAt: string | null;
  /** Older than the stale limit (or of unknown age). */
  stale: boolean;
}

function clockLabel(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** The dollar value of `raw` base units of the game token, or null when the server has no usable price. */
export function usdQuote(view: Pick<ArenaPricesView, 'usdPerToken' | 'at'> | null | undefined, raw: bigint, decimals: number, now: number, staleAfterHours = PRICE_STALE_HOURS): UsdQuote | null {
  if (!view?.usdPerToken || raw < 0n) return null;
  let price: bigint;
  try {
    price = parseUsdPrice(view.usdPerToken);
  } catch {
    return null;
  }
  if (price <= 0n) return null;
  const at = typeof view.at === 'number' && Number.isFinite(view.at) && view.at > 0 ? view.at : null;
  return {
    text: `≈ ${formatUsd(tokenRawToUsd(raw, price, decimals))}`,
    setAt: at === null ? null : clockLabel(at, now),
    stale: at === null || now - at > staleAfterHours * 3600_000,
  };
}
