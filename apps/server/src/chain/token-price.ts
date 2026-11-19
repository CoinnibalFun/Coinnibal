import { parseUsdPrice, type PriceSourceKind } from '@coinnibal/shared';

/**
 * The game token's USD price, for pricing the arena tiers in dollars (`@coinnibal/shared` `arena-pricing.ts`). A source
 * only reads a price: nothing here signs or sends anything, and the arenas are re-priced by the owner's own wallet.
 */
export type TokenPriceReading =
  | { ok: true; source: PriceSourceKind; usdPerToken: string; price: bigint; at: number | null }
  | { ok: false; source: PriceSourceKind; reason: 'not_set' | 'not_wired'; message: string };

export interface TokenPriceSource {
  readonly kind: PriceSourceKind;
  read(): Promise<TokenPriceReading>;
}

/** The price the admin typed in `/admin` (the testnet default: the TestToken has no market). */
export class ManualPriceSource implements TokenPriceSource {
  readonly kind = 'manual' as const;
  constructor(private readonly get: () => { usdPerToken: string | null; at: number | null }) {}

  async read(): Promise<TokenPriceReading> {
    const { usdPerToken, at } = this.get();
    if (!usdPerToken) return { ok: false, source: this.kind, reason: 'not_set', message: 'No token price yet: set the USD price per token in /admin → Game → Arena prices.' };
    return { ok: true, source: this.kind, usdPerToken, price: parseUsdPrice(usdPerToken), at };
  }
}

/**
 * NOT WIRED: a placeholder for a future on-chain price of the game token from its Pons / DEX pool, read as a
 * time-weighted average (TWAP) so one trade cannot move the ticket prices. Which pool, which interface it exposes and
 * which window to average over are not known yet (the token is not launched; docs/RESEARCH.md), so this source reads
 * nothing and the settings refuse to select it (`applyArenaPricing`). Wiring it means: name the pool contract, read
 * its cumulative price (or observations) at two blocks through the server's RPC budget, convert to USD per token, and
 * test it against a fork before `applyArenaPricing` accepts `dex_twap`.
 */
export class DexTwapPriceSource implements TokenPriceSource {
  readonly kind = 'dex_twap' as const;

  async read(): Promise<TokenPriceReading> {
    return { ok: false, source: this.kind, reason: 'not_wired', message: 'The Pons / DEX TWAP price source is not wired yet.' };
  }
}

/** The source the settings name. */
export function priceSource(kind: PriceSourceKind, manual: () => { usdPerToken: string | null; at: number | null }): TokenPriceSource {
  return kind === 'dex_twap' ? new DexTwapPriceSource() : new ManualPriceSource(manual);
}
