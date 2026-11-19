import { DEFAULT_ARENAS } from './arenas';

/**
 * Arena tickets priced in US dollars (owner decision 2026-11: $1, $3, $5, $10; the $10 arena for emblem holders only).
 *
 * The chain keeps entry fees in token units (`CoinnibalArena` `createArena` / `updateArena`), and each ticket records the
 * entry fee it was bought with (`Session.entryFee`: settlements, cancels and refunds use that, never the arena's
 * current price). So a dollar price is turned into a token amount at a USD price of the token, by the admin:
 *
 *  1. the price source gives the token's USD price (`ArenaPricingSettings.source`: `manual`, a price the admin types,
 *     the testnet default; `dex_twap` is reserved for a future on-chain Pons / DEX TWAP and is not wired);
 *  2. `arenaPriceDiff` computes every tier's token entry (`usdToTokenRaw`, rounded to `sigFigs` significant figures)
 *     and compares it with the chain;
 *  3. the owner's wallet signs the `updateArena` (and `setArenaHoldersOnly`) calls (`/admin` → Game → Arena prices).
 *     The server never holds the owner key.
 *
 * Money is exact integer arithmetic throughout (bigint); floating point is only used for the USD figures shown.
 */

/** A USD price is carried as an integer of `10^-USD_PRICE_DECIMALS` dollars per whole token. */
export const USD_PRICE_DECIMALS = 18;
const PRICE_SCALE = 10n ** BigInt(USD_PRICE_DECIMALS);

/** Where the token's USD price comes from. */
export const PRICE_SOURCES = ['manual', 'dex_twap'] as const;
export type PriceSourceKind = (typeof PRICE_SOURCES)[number];

/** One ticket tier: the arena id on chain, its price in US cents and whether only emblem holders may join it. */
export interface ArenaUsdTier {
  arenaId: number;
  usdCents: number;
  holdersOnly: boolean;
}

/** The admin's arena pricing (`/api/admin/arena-prices`, `DATA_DIR/chains/<id>/arena-prices.json`). */
export interface ArenaPricingSettings {
  /** `manual` (the admin types the price). `dex_twap` is a future on-chain source and is refused until wired. */
  source: PriceSourceKind;
  /** Manual price: USD per whole token, a decimal string ("0.00081"); null until the admin sets one. */
  manualUsdPerToken: string | null;
  /** Unix ms the manual price was last set (shown next to it; null while unset). */
  manualSetAt: number | null;
  /** The tiers, by arena id. */
  tiers: ArenaUsdTier[];
  /** Token entries are rounded to this many significant figures (1..6): "1,200" rather than "1,234.5679". */
  sigFigs: number;
}

export const ARENA_PRICING_LIMITS = { sigFigsMin: 1, sigFigsMax: 6, usdCentsMax: 1_000_000, tiersMax: 16, priceDecimals: USD_PRICE_DECIMALS } as const;

export const ARENA_PRICING_DEFAULT: ArenaPricingSettings = {
  source: 'manual',
  manualUsdPerToken: null,
  manualSetAt: null,
  tiers: DEFAULT_ARENAS.map((a) => ({ arenaId: a.id, usdCents: a.usdCents, holdersOnly: a.holdersOnly })),
  sigFigs: 2,
};

/** The largest entry fee `CoinnibalArena` can store (`uint128`). */
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * A USD price as an exact integer (`10^-18` dollars per whole token): `"0.00081"` → `810000000000000n`. Throws
 * `RangeError` unless it is a plain positive decimal with at most 18 decimals.
 */
export function parseUsdPrice(text: string): bigint {
  const t = typeof text === 'string' ? text.trim() : '';
  const m = /^(\d{1,12})(?:\.(\d{1,18}))?$/.exec(t);
  if (!m) throw new RangeError(`"${text}" is not a USD price like "0.00081" (at most 18 decimals)`);
  const v = BigInt(m[1]) * PRICE_SCALE + BigInt((m[2] ?? '').padEnd(USD_PRICE_DECIMALS, '0') || '0');
  if (v <= 0n) throw new RangeError('the USD price must be above 0');
  return v;
}

/** `n / d` rounded half up (both positive). */
const divRound = (n: bigint, d: bigint): bigint => (n + d / 2n) / d;

/** `v` rounded half up to `sig` significant figures (`v > 0`). */
export function roundSigFigs(v: bigint, sig: number): bigint {
  if (v <= 0n) return 0n;
  const digits = v.toString().length;
  if (digits <= sig) return v;
  const step = 10n ** BigInt(digits - sig);
  return divRound(v, step) * step;
}

/**
 * The token entry (base units of a token with `decimals`) of a ticket of `usdCents` at `price` (`parseUsdPrice`),
 * rounded half up to `sigFigs` significant figures. The rounding works on the exact quotient, so it is done once.
 * Throws `RangeError` when the result is 0 or does not fit the contract's `uint128`.
 */
export function usdToTokenRaw(usdCents: number, price: bigint, decimals: number, sigFigs: number): bigint {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0) throw new RangeError(`usdCents must be a positive whole number, got ${usdCents}`);
  if (price <= 0n) throw new RangeError('the USD price must be above 0');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`bad token decimals ${decimals}`);
  if (!Number.isInteger(sigFigs) || sigFigs < ARENA_PRICING_LIMITS.sigFigsMin || sigFigs > ARENA_PRICING_LIMITS.sigFigsMax) throw new RangeError(`sigFigs must be 1..6, got ${sigFigs}`);
  // base units = usd * 10^decimals / price = cents * 10^decimals * 10^18 / (100 * price18)
  const num = BigInt(usdCents) * 10n ** BigInt(decimals) * PRICE_SCALE;
  const den = 100n * price;
  const whole = num / den;
  const digits = whole === 0n ? 0 : whole.toString().length;
  const raw = digits <= sigFigs ? divRound(num, den) : divRound(num, den * 10n ** BigInt(digits - sigFigs)) * 10n ** BigInt(digits - sigFigs);
  if (raw <= 0n) throw new RangeError(`$${(usdCents / 100).toFixed(2)} is less than one base unit of the token at this price`);
  if (raw > MAX_UINT128) throw new RangeError('the entry fee does not fit the contract (uint128): the price is too low');
  return raw;
}

/** The USD value of `raw` base units at `price` (display only: a float of dollars). */
export function tokenRawToUsd(raw: bigint, price: bigint, decimals: number): number {
  // micro-dollars, exact, then one float division
  const micros = (raw * price * 1_000_000n) / (10n ** BigInt(decimals) * PRICE_SCALE);
  return Number(micros) / 1_000_000;
}

/** `100` → `"$1"`, `250` → `"$2.50"`. */
export function formatUsdCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `$${whole.toLocaleString('en-US')}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** A float of dollars for copy: `0.9721` → `"$0.97"`, `1234.5` → `"$1,235"`; below a cent `"<$0.01"`. */
export function formatUsd(dollars: number): string {
  if (!Number.isFinite(dollars) || dollars <= 0) return '$0';
  if (dollars < 0.01) return '<$0.01';
  if (dollars >= 100) return `$${Math.round(dollars).toLocaleString('en-US')}`;
  return `$${dollars.toFixed(2).replace(/\.00$/, '')}`;
}

/** What the lobby and the site read (`GET /api/site/arena-prices`). */
export interface ArenaPricesView {
  source: PriceSourceKind;
  /** The token's USD price now (USD per whole token, decimal string); null when the source has none. */
  usdPerToken: string | null;
  /** Unix ms of the price (the manual price's last change); null when unknown. */
  at: number | null;
  tiers: ArenaUsdTier[];
  sigFigs: number;
}

/** How the lobby labels a ticket: `$1` when the chain's entry is the tier price at the current price, else `≈ $0.97`. */
export function arenaUsdLabel(view: Pick<ArenaPricesView, 'usdPerToken' | 'tiers' | 'sigFigs'> | null, arenaId: number, entryRaw: bigint, decimals: number): { text: string; exact: boolean } | null {
  if (!view?.usdPerToken || entryRaw <= 0n) return null;
  let price: bigint;
  try {
    price = parseUsdPrice(view.usdPerToken);
  } catch {
    return null;
  }
  const tier = view.tiers.find((t) => t.arenaId === arenaId);
  if (tier) {
    try {
      if (usdToTokenRaw(tier.usdCents, price, decimals, view.sigFigs) === entryRaw) return { text: formatUsdCents(tier.usdCents), exact: true };
    } catch {
      // the tier cannot be priced at this price: show the value of what the chain asks
    }
  }
  return { text: `≈ ${formatUsd(tokenRawToUsd(entryRaw, price, decimals))}`, exact: false };
}

/**
 * A partial admin update applied to `cur`: the new settings, or the first invalid field. A changed manual price is
 * stamped with `now` (`manualSetAt` is never set by hand).
 */
export function applyArenaPricing(
  cur: ArenaPricingSettings,
  patch: Record<string, unknown>,
  now: number,
): { ok: true; settings: ArenaPricingSettings } | { ok: false; field: string; message: string } {
  const next: ArenaPricingSettings = { ...cur, tiers: cur.tiers.map((t) => ({ ...t })) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'source') {
      if (v === 'dex_twap') return { ok: false, field: k, message: 'The Pons / DEX TWAP price source is not wired yet: use the manual price.' };
      if (v !== 'manual') return { ok: false, field: k, message: `source must be one of ${PRICE_SOURCES.join(', ')}` };
      next.source = v;
    } else if (k === 'manualUsdPerToken') {
      if (v === null || v === '') {
        next.manualUsdPerToken = null;
        next.manualSetAt = null;
        continue;
      }
      if (typeof v !== 'string') return { ok: false, field: k, message: 'manualUsdPerToken must be a decimal string like "0.00081"' };
      try {
        parseUsdPrice(v);
      } catch (err) {
        return { ok: false, field: k, message: (err as Error).message };
      }
      if (v.trim() !== cur.manualUsdPerToken) next.manualSetAt = now;
      next.manualUsdPerToken = v.trim();
    } else if (k === 'sigFigs') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < ARENA_PRICING_LIMITS.sigFigsMin || v > ARENA_PRICING_LIMITS.sigFigsMax) {
        return { ok: false, field: k, message: `sigFigs must be a whole number from ${ARENA_PRICING_LIMITS.sigFigsMin} to ${ARENA_PRICING_LIMITS.sigFigsMax}` };
      }
      next.sigFigs = v;
    } else if (k === 'tiers') {
      if (!Array.isArray(v) || v.length === 0 || v.length > ARENA_PRICING_LIMITS.tiersMax) return { ok: false, field: k, message: `tiers must be a list of 1 to ${ARENA_PRICING_LIMITS.tiersMax} tiers` };
      const seen = new Set<number>();
      const tiers: ArenaUsdTier[] = [];
      for (const [i, t] of v.entries()) {
        const o = t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>) : null;
        const id = o?.arenaId;
        const cents = o?.usdCents;
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 65_535 || seen.has(id)) return { ok: false, field: `tiers.${i}.arenaId`, message: 'every tier needs its own arena id (1..65535)' };
        if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 1 || cents > ARENA_PRICING_LIMITS.usdCentsMax) {
          return { ok: false, field: `tiers.${i}.usdCents`, message: `a tier price is a whole number of US cents from 1 to ${ARENA_PRICING_LIMITS.usdCentsMax}` };
        }
        if (o?.holdersOnly !== undefined && typeof o.holdersOnly !== 'boolean') return { ok: false, field: `tiers.${i}.holdersOnly`, message: 'holdersOnly must be true or false' };
        seen.add(id);
        tiers.push({ arenaId: id, usdCents: cents, holdersOnly: o?.holdersOnly === true });
      }
      next.tiers = tiers.sort((a, b) => a.arenaId - b.arenaId);
    } else return { ok: false, field: k, message: `unknown setting ${k}` };
  }
  return { ok: true, settings: next };
}

/** What the sync compares a tier with: the arena on chain (an SDK `ArenaInfo` fits). */
export interface ChainArenaState {
  id: number;
  exists: boolean;
  entryFee: bigint;
  maxSessions: number;
  enabled: boolean;
  openSessions: number;
  holdersOnly: boolean;
}

/** One line of "Sync arena prices to USD". */
export interface ArenaPriceRow {
  arenaId: number;
  usdCents: number;
  /** The arena on chain (null: it does not exist; create it in Setup first). */
  chain: ChainArenaState | null;
  /** The entry fee now (base units; null when the arena does not exist). */
  oldEntry: bigint | null;
  /** The entry fee at the tier's USD price (null when it cannot be priced: `error`). */
  newEntry: bigint | null;
  /** What the entry fees are worth at the price (display). */
  oldUsd: number | null;
  newUsd: number | null;
  /** `updateArena` with the new entry fee is needed. */
  entryChange: boolean;
  /** `setArenaHoldersOnly(id, want)` is needed (null: no change). */
  holdersOnlyChange: boolean | null;
  /**
   * Why the change cannot be signed now (null: it can). The contract refuses a new entry fee while a ticket of the
   * arena is open (`ArenaBusy`): pause joins, let the bell settle them, then sync.
   */
  blocked: string | null;
  /** The tier cannot be priced (a price too high or too low for the token). */
  error: string | null;
}

/**
 * The sync's diff: every tier against the chain at `price` (null: no price, nothing to sync). Arenas the tiers do not
 * name are left alone. Pure, so the admin panel, the server and the tests compute the same thing.
 */
export function arenaPriceDiff(p: {
  tiers: readonly ArenaUsdTier[];
  price: bigint | null;
  decimals: number;
  sigFigs: number;
  arenas: readonly ChainArenaState[];
  /** The arena has a holder NFT (`setArenaHoldersOnly(true)` admits nobody without one). */
  holderNft: boolean;
}): ArenaPriceRow[] {
  const byId = new Map(p.arenas.filter((a) => a.exists).map((a) => [a.id, a]));
  return [...p.tiers]
    .sort((a, b) => a.arenaId - b.arenaId)
    .map((t): ArenaPriceRow => {
      const chain = byId.get(t.arenaId) ?? null;
      let newEntry: bigint | null = null;
      let error: string | null = null;
      if (p.price === null) error = 'no USD price: set the token price first';
      else {
        try {
          newEntry = usdToTokenRaw(t.usdCents, p.price, p.decimals, p.sigFigs);
        } catch (err) {
          error = (err as Error).message;
        }
      }
      const usd = (raw: bigint | null) => (raw === null || p.price === null ? null : tokenRawToUsd(raw, p.price, p.decimals));
      const entryChange = !!chain && newEntry !== null && newEntry !== chain.entryFee;
      const holdersOnlyChange = chain && chain.holdersOnly !== t.holdersOnly ? t.holdersOnly : null;
      let blocked: string | null = null;
      if (!chain) blocked = `arena #${t.arenaId} does not exist on chain: create it first (Setup → Finish setup, or Advanced → Create)`;
      else if (entryChange && chain.openSessions > 0) {
        blocked = `${chain.openSessions} open ticket${chain.openSessions === 1 ? '' : 's'}: the contract changes an entry fee only when none is open. Use "Re-price at next bell" below (it closes the arena at the bell and refunds unseated tickets), then sync again`;
      } else if (holdersOnlyChange === true && !p.holderNft) blocked = 'set the holder NFT first (Setup → Holder perks): a holders-only arena without it admits nobody';
      return { arenaId: t.arenaId, usdCents: t.usdCents, chain, oldEntry: chain?.entryFee ?? null, newEntry, oldUsd: usd(chain?.entryFee ?? null), newUsd: usd(newEntry), entryChange, holdersOnlyChange, blocked, error };
    });
}
