import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARENA_PRICING_DEFAULT, applyArenaPricing, type ArenaPricesView, type ArenaPricingSettings } from '@coinnibal/shared';
import { priceSource, type TokenPriceReading } from '../chain/token-price';

/**
 * The admin's arena pricing in US dollars (`@coinnibal/shared` `arena-pricing.ts`): the tiers ($1 / $3 / $5 / $10, the
 * $10 one holders-only), the price source and the manual token price, the rounding. Kept per chain (the price belongs
 * to that chain's token): `DATA_DIR/chains/<id>/arena-prices.json`, atomic writes.
 *
 * Nothing here touches the chain: the entry fees on chain change only when the owner's wallet signs the sync's
 * `updateArena` calls in `/admin`. The lobby reads `view()` to show "$1" next to the token amount.
 */
export const ARENA_PRICES_FILE = 'arena-prices.json';

/** A bad admin value (`field` names it). */
export class ArenaPricingFail extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** A reading without its bigint (JSON). */
export type PriceReadingView = Omit<Extract<TokenPriceReading, { ok: true }>, 'price'> | Extract<TokenPriceReading, { ok: false }>;

export class ArenaPriceStore {
  private cur: ArenaPricingSettings = structuredClone(ARENA_PRICING_DEFAULT);
  private readonly now: () => number;

  constructor(
    /** The chain's state directory (`DATA_DIR/chains/<id>`); null: memory only. */
    private readonly dir: string | null,
    private readonly log: (m: string) => void = () => {},
    now?: () => number,
  ) {
    this.now = now ?? Date.now;
    const p = this.path();
    if (!p || !existsSync(p)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (!isObj(raw)) throw new Error('not an object');
      const { manualSetAt, ...rest } = raw;
      const r = applyArenaPricing(this.cur, rest, this.now());
      if (!r.ok) throw new Error(`${r.field}: ${r.message}`);
      this.cur = { ...r.settings, manualSetAt: r.settings.manualUsdPerToken && typeof manualSetAt === 'number' && Number.isFinite(manualSetAt) ? manualSetAt : r.settings.manualSetAt };
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`!!! arena prices: ${p} is unreadable (${(err as Error).message}); moved to ${backup}, using the defaults (no token price)`);
    }
  }

  private path(): string | null {
    return this.dir ? join(this.dir, ARENA_PRICES_FILE) : null;
  }

  get settings(): ArenaPricingSettings {
    return structuredClone(this.cur);
  }

  /** Validates, stores and applies an admin patch; throws `ArenaPricingFail` on a bad field. */
  update(body: Record<string, unknown>): ArenaPricingSettings {
    const r = applyArenaPricing(this.cur, body, this.now());
    if (!r.ok) throw new ArenaPricingFail(r.message, r.field);
    this.cur = r.settings;
    const p = this.path();
    if (p) {
      mkdirSync(this.dir!, { recursive: true });
      writeFileSync(`${p}.tmp`, JSON.stringify(this.cur, null, 2));
      renameSync(`${p}.tmp`, p);
    }
    return this.settings;
  }

  /** The token's USD price from the selected source. */
  async price(): Promise<TokenPriceReading> {
    const s = this.cur;
    return priceSource(s.source, () => ({ usdPerToken: s.manualUsdPerToken, at: s.manualSetAt })).read();
  }

  /** The reading as JSON. */
  async priceView(): Promise<PriceReadingView> {
    const r = await this.price();
    if (!r.ok) return r;
    const { price: _price, ...rest } = r;
    return rest;
  }

  /** `GET /api/site/arena-prices`: what the lobby needs to label the tickets in dollars. */
  async view(): Promise<ArenaPricesView> {
    const s = this.cur;
    const r = await this.price();
    return { source: s.source, usdPerToken: r.ok ? r.usdPerToken : null, at: r.ok ? r.at : null, tiers: s.tiers.map((t) => ({ ...t })), sigFigs: s.sigFigs };
  }
}
