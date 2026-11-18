import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOST_KINDS, LEGACY_BOOST_KINDS, OLD_SHOP_PRICES, SHOP_DEFAULTS, SHOP_LIMITS, parseToken, type ShopSettings } from '@elymum/shared';

/** A bad admin value: `field` names it (`prices.magnet`, `arenaUsesPerRound`, …). */
export class ShopSettingsError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function int(x: unknown, field: string, min: number, max: number): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) throw new ShopSettingsError(`${field} must be a whole number from ${min} to ${max}`, field);
  return x;
}

function bool(x: unknown, field: string): boolean {
  if (typeof x !== 'boolean') throw new ShopSettingsError(`${field} must be true or false`, field);
  return x;
}

/** A pack price: whole tokens as a decimal string, above 0 and at most `SHOP_LIMITS.priceTokens`, at most 6 decimals. */
function price(x: unknown, field: string): string {
  if (typeof x !== 'string' || !/^\d{1,10}(\.\d{1,6})?$/.test(x)) throw new ShopSettingsError(`${field} must be a token amount like "300" or "12.5"`, field);
  const raw = parseToken(x, 6);
  if (raw <= 0n || raw > BigInt(SHOP_LIMITS.priceTokens) * 10n ** 6n) throw new ShopSettingsError(`${field} must be above 0 and at most ${SHOP_LIMITS.priceTokens}`, field);
  return x;
}

const KEYS = ['enabled', 'packSize', 'priceIn', 'usdCents', 'prices', 'kinds', 'holderDiscountPct', 'arenaUsesPerRound', 'holderExtraArenaUses'] as const;
/** Fields of older files that are read and ignored (the payment split is on chain now: `CoinnibalArena.pay`). */
const RETIRED_KEYS = ['sink', 'treasury'] as const;

/**
 * Applies a partial update (`PUT /api/admin/shop`) to `cur`. Every given field is checked; unknown
 * fields are refused unless `strict` is false (loading a file written by a newer server).
 */
export function applyShopSettings(cur: ShopSettings, body: Record<string, unknown>, opts: { strict?: boolean } = {}): ShopSettings {
  const strict = opts.strict !== false;
  if (strict) for (const k of Object.keys(body)) if (!(KEYS as readonly string[]).includes(k)) throw new ShopSettingsError(`unknown field ${k}`, k);
  const next: ShopSettings = structuredClone(cur);
  for (const k of RETIRED_KEYS) delete (next as unknown as Record<string, unknown>)[k];
  if (body.enabled !== undefined) next.enabled = bool(body.enabled, 'enabled');
  if (body.packSize !== undefined) next.packSize = int(body.packSize, 'packSize', 1, SHOP_LIMITS.packSize);
  if (body.holderDiscountPct !== undefined) next.holderDiscountPct = int(body.holderDiscountPct, 'holderDiscountPct', 0, SHOP_LIMITS.holderDiscountPct);
  if (body.arenaUsesPerRound !== undefined) next.arenaUsesPerRound = int(body.arenaUsesPerRound, 'arenaUsesPerRound', 0, SHOP_LIMITS.arenaUsesPerRound);
  if (body.holderExtraArenaUses !== undefined) next.holderExtraArenaUses = int(body.holderExtraArenaUses, 'holderExtraArenaUses', 0, SHOP_LIMITS.holderExtraArenaUses);
  if (body.priceIn !== undefined) {
    if (body.priceIn !== 'usd' && body.priceIn !== 'token') throw new ShopSettingsError('priceIn must be "usd" or "token"', 'priceIn');
    next.priceIn = body.priceIn;
  }
  for (const group of ['prices', 'kinds', 'usdCents'] as const) {
    const patch = body[group];
    if (patch === undefined) continue;
    if (!isObj(patch)) throw new ShopSettingsError(`${group} must be an object`, group);
    if (strict) for (const k of Object.keys(patch)) if (!(BOOST_KINDS as readonly string[]).includes(k)) throw new ShopSettingsError(`unknown field ${group}.${k}`, `${group}.${k}`);
    for (const kind of BOOST_KINDS) {
      if (patch[kind] === undefined) continue;
      if (group === 'prices') next.prices[kind] = price(patch[kind], `prices.${kind}`);
      else if (group === 'usdCents') next.usdCents[kind] = int(patch[kind], `usdCents.${kind}`, 1, SHOP_LIMITS.usdCents);
      else next.kinds[kind] = bool(patch[kind], `kinds.${kind}`);
    }
  }
  return next;
}

/**
 * A file written while a retired power-up was sold (`shock`): its price and on/off switch carry over
 * to the kind that replaced it (`LEGACY_BOOST_KINDS`, Shockwave -> Leap) unless the file already
 * sets that kind, and the retired key is dropped. Mutates `raw`.
 */
export function upgradeLegacyKinds(raw: Record<string, unknown>): void {
  for (const group of ['prices', 'kinds'] as const) {
    const g = raw[group];
    if (!isObj(g)) continue;
    for (const [old, kind] of Object.entries(LEGACY_BOOST_KINDS)) {
      if (!(old in g)) continue;
      if (g[kind] === undefined) g[kind] = g[old];
      delete g[old];
    }
  }
}

/** Where the settings live under `DATA_DIR`. */
export const SHOP_SETTINGS_FILE = join('site', 'shop.json');

/** The admin's shop settings, persisted in `DATA_DIR/site/shop.json` (atomic write), applied at once. */
export class ShopSettingsStore {
  private cur: ShopSettings;

  constructor(
    private readonly dataDir: string | null,
    readonly defaults: ShopSettings = SHOP_DEFAULTS,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.cur = structuredClone(defaults);
    this.load();
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, SHOP_SETTINGS_FILE) : null;
  }

  private load(): void {
    const p = this.path();
    if (!p || !existsSync(p)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (!isObj(raw)) throw new Error('not an object');
      // the launch prices (300 / 450 / 300) were raised: a file still holding them untouched takes the new defaults
      const pr = (raw as { prices?: Record<string, unknown> }).prices;
      if (pr && String(pr.magnet) === '300' && String(pr.shock) === '450' && String(pr.speed) === '300') delete (raw as { prices?: unknown }).prices;
      upgradeLegacyKinds(raw);
      // the pre-2026-11 defaults, untouched: the new economy's prices
      const pr2 = (raw as { prices?: Record<string, unknown> }).prices;
      if (pr2 && BOOST_KINDS.every((k) => String(pr2[k]) === OLD_SHOP_PRICES[k])) {
        delete (raw as { prices?: unknown }).prices;
        this.log('shop: the old default prices were upgraded to the new defaults');
      }
      this.cur = applyShopSettings(this.defaults, raw, { strict: false });
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`shop: ${SHOP_SETTINGS_FILE} is unreadable (${(err as Error).message}); moved to ${backup}, using the defaults`);
    }
  }

  get settings(): ShopSettings {
    return structuredClone(this.cur);
  }

  /** Validates, stores and applies an admin update; throws `ShopSettingsError` on a bad field. */
  update(body: Record<string, unknown>): ShopSettings {
    this.cur = applyShopSettings(this.cur, body);
    const p = this.path();
    if (p) {
      mkdirSync(join(this.dataDir!, 'site'), { recursive: true });
      writeFileSync(`${p}.tmp`, JSON.stringify(this.cur, null, 2));
      renameSync(`${p}.tmp`, p);
    }
    return this.settings;
  }
}
