import { RULES } from './constants';
import { parseToken } from './token';

/**
 * Bought power-ups ("boosts"): charges a signed-in wallet buys with the game token and spends in
 * any room. They are separate from the map power-ups (`PowerUpType`, picked up off the floor);
 * Magnet and Speed reuse the map power-up effects (and their `CellFlag.Magnet` / `CellFlag.Pump`
 * visuals). Leap is an instant jump toward the aim (`CellFlag.Leap`), Invisibility hides the
 * player's coins from every other player and from the bots (`CellFlag.Invisible`, only ever sent to
 * the player itself: the server does not send hidden coins to anyone else).
 *
 * The Shockwave (`shock`, sold until 2026-11) is gone: saved charges and settings are converted to
 * Leap on load (`LEGACY_BOOST_KINDS`: same price, same key F, also an instant "get me out" tool).
 */
export const BOOST_KINDS = ['magnet', 'leap', 'speed', 'invis'] as const;
export type BoostKind = (typeof BOOST_KINDS)[number];

export function isBoostKind(x: unknown): x is BoostKind {
  return typeof x === 'string' && (BOOST_KINDS as readonly string[]).includes(x);
}

/** Retired kinds and the kind their saved charges, prices and switches now count as. */
export const LEGACY_BOOST_KINDS: Readonly<Record<string, BoostKind>> = { shock: 'leap' };

/** A current kind, or the kind a retired one became (`shock` -> `leap`); null for anything else. */
export function normalizeBoostKind(x: unknown): BoostKind | null {
  if (isBoostKind(x)) return x;
  return typeof x === 'string' && Object.hasOwn(LEGACY_BOOST_KINDS, x) ? LEGACY_BOOST_KINDS[x] : null;
}

/**
 * Desktop keys (`KeyboardEvent.code`): clear of Space / left click split, E tip, WASD / arrows,
 * Q spectate, Enter chat and 1-8 emotes. F stays the instant one (it was the Shockwave's).
 */
export const BOOST_KEYS: Readonly<Record<BoostKind, string>> = { magnet: 'KeyR', leap: 'KeyF', speed: 'KeyG', invis: 'KeyV' };
/** The key caps printed on the HUD buttons. */
export const BOOST_KEY_LABELS: Readonly<Record<BoostKind, string>> = { magnet: 'R', leap: 'F', speed: 'G', invis: 'V' };

/**
 * Effect tuning (server-authoritative; the client reads it for the HUD rings and the leap trail).
 * They help but do not decide a fight: Magnet only pulls food, Speed is short, Leap is one hop that
 * cannot cross the border, and an invisible coin still eats and is eaten like any other.
 */
export const BOOST_RULES = {
  magnet: {
    /** Pulls food (never loot, never coins) toward every cell of the user, like the map magnet. */
    durationMs: 8_000,
    cooldownMs: 20_000,
  },
  speed: {
    /** A short burst at the map pump's multiplier (`RULES.pumpSpeedMul`). */
    durationMs: 3_000,
    cooldownMs: 18_000,
  },
  leap: {
    cooldownMs: 12_000,
    /**
     * Jump length (world units) for a player whose biggest cell has radius `r`:
     * `base + r * perRadius`, at most `max`. A starting coin (r 45, about "1 m" across) hops about
     * five of its widths ("5 m"), a big one about ten ("10 m"). Every cell of the player moves by
     * the same step (the formation keeps); the border stops it.
     */
    base: 420,
    perRadius: 0.9,
    max: 900,
    /** How long the trail shows (`CellFlag.Leap` on the user's cells). */
    fxMs: 400,
  },
  invis: {
    /**
     * Ten seconds unseen: other players get no snapshot of the coins (so no name tag, no minimap
     * leader dot, no spectator camera on them), bots do not see them. Eating works as usual.
     */
    durationMs: 10_000,
    cooldownMs: 30_000,
  },
} as const;

/** Duration (ms) a boost's effect lasts (0: instant). */
export function boostDurationMs(kind: BoostKind): number {
  return kind === 'magnet' ? BOOST_RULES.magnet.durationMs : kind === 'speed' ? BOOST_RULES.speed.durationMs : kind === 'invis' ? BOOST_RULES.invis.durationMs : 0;
}

export function boostCooldownMs(kind: BoostKind): number {
  return BOOST_RULES[kind].cooldownMs;
}

/** How far (world units) a Leap carries a player whose biggest cell has radius `r`. */
export function leapDistance(r: number): number {
  const L = BOOST_RULES.leap;
  return Math.min(L.max, L.base + Math.max(0, r) * L.perRadius);
}

/** Where burned tokens go when the arena's burn mode is `0` (and the fallback of mode `1`). */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

/** The prefix of the power-up refs. */
const REF_PREFIX = 'coinnibal';
/**
 * The prefix of the power-up refs before the rename (the project was called Elymum until November 2026). Read only:
 * a payment sent just before the switch still credits (`shopPaymentRefs`, `shopCartRefs`); new payments never use it.
 */
const OLD_REF_PREFIX = 'elymum';

/** ASCII, right-padded with zero bytes to a 32-byte `ref`. */
function asciiRef(ascii: string): `0x${string}` {
  let hex = '';
  for (let i = 0; i < ascii.length; i++) hex += ascii.charCodeAt(i).toString(16).padStart(2, '0');
  return `0x${hex.padEnd(64, '0')}`;
}

/**
 * The `ref` of a power-up payment (`CoinnibalArena.pay(amount, ref)`): `coinnibal.shop.<kind>` in ASCII, right-padded to
 * 32 bytes. The server credits a payment only when its ref names the pack bought.
 */
export function shopPaymentRef(kind: BoostKind): `0x${string}` {
  return asciiRef(`${REF_PREFIX}.shop.${kind}`);
}

/**
 * The refs a pack's payment is accepted with: `shopPaymentRef(kind)`, and the same pack under the prefix of before
 * the rename (`elymum.shop.<kind>`). Only the prefix differs: the pack, and every other check of the payment, do not.
 */
export function shopPaymentRefs(kind: BoostKind): readonly `0x${string}`[] {
  return [shopPaymentRef(kind), asciiRef(`${OLD_REF_PREFIX}.shop.${kind}`)];
}

/**
 * The admin's shop settings (`/api/admin/shop`, stored in `DATA_DIR/site/shop.json`). Where the money goes is not a
 * setting here: every pack is paid with `CoinnibalArena.pay`, which burns `paymentBurnBps` of it (default 50 %) and
 * sends the rest to the arena's fee wallet on chain (`fees.ts`). Older files' `sink` / `treasury` are ignored.
 */
export interface ShopSettings {
  /** Buying and using bought power-ups is on. */
  enabled: boolean;
  /** Charges in one pack. */
  packSize: number;
  /**
   * `usd` (default): a pack costs `usdCents`, converted to tokens with the arenas' price source and rounding (Game →
   * Arena prices: the token's USD price and its significant figures). `token`: `prices` in whole tokens. With `usd`
   * and no token price set yet, `prices` is used.
   */
  priceIn: 'usd' | 'token';
  /** Price of one pack in US cents (`priceIn: 'usd'`). */
  usdCents: Record<BoostKind, number>;
  /** Price of one pack, whole game tokens as a decimal string ("300", "12.5"): `priceIn: 'token'`, or no USD price yet. */
  prices: Record<BoostKind, string>;
  /** Per power-up on/off (off: not sold and not usable). */
  kinds: Record<BoostKind, boolean>;
  /** Emblem holders pay this many percent less (0..90). */
  holderDiscountPct: number;
  /** Paid arenas: uses per round per player, all power-ups together. */
  arenaUsesPerRound: number;
  /** Paid arenas: extra uses per round for emblem holders. */
  holderExtraArenaUses: number;
}

/**
 * Default prices, tied to the cheapest arena ticket ($1, `DEFAULT_ARENAS`; docs/ECONOMY.md) and priced in US dollars
 * like it, so the tie holds whatever the token's price: one charge costs 20-40 % of that ticket (a pack of 3: Magnet
 * and Speed $0.60, Leap $0.90, Invisibility $1.20; in tokens at the reference price of $0.001: 600 / 900 / 1,200, the
 * `prices` used until a token price is set). A charge is cheap next to what a round can win, so buying one is an
 * easy call, while the per-round cap in paid arenas (`arenaUsesPerRound`) keeps them from deciding a fight. Half of
 * every payment is burned, half goes to the fee wallet (`DEFAULT_PAYMENT_BURN_BPS`). Emblem holders pay 20 % less
 * (`holderDiscountPct`, owner decision 2026-11).
 */
export const SHOP_DEFAULTS: ShopSettings = {
  enabled: true,
  packSize: 3,
  priceIn: 'usd',
  usdCents: { magnet: 60, leap: 90, speed: 60, invis: 120 },
  prices: { magnet: '600', leap: '900', speed: '600', invis: '1200' },
  kinds: { magnet: true, leap: true, speed: true, invis: true },
  holderDiscountPct: 20,
  arenaUsesPerRound: 2,
  holderExtraArenaUses: 1,
};

/** The default prices before the 2026-11 economy update (a saved file still holding all of them takes the new ones). */
export const OLD_SHOP_PRICES: Readonly<Record<BoostKind, string>> = { magnet: '1500', leap: '2500', speed: '1500', invis: '3000' };

/** Bounds of the admin values. */
export const SHOP_LIMITS = { packSize: 20, holderDiscountPct: 90, arenaUsesPerRound: 20, holderExtraArenaUses: 10, priceTokens: 1_000_000_000, usdCents: 100_000 } as const;

/**
 * Raw base units of one pack for a wallet: the price in whole tokens scaled by `decimals`, less the
 * holder discount (rounded down to a whole base unit). Throws on a malformed price.
 */
export function packPriceRaw(price: string, decimals: number, discountPct: number): bigint {
  const full = parseToken(price, decimals);
  const pct = BigInt(Math.max(0, Math.min(100, Math.floor(discountPct))));
  return (full * (100n - pct)) / 100n;
}

export type BoostCounts = Record<BoostKind, number>;

export const emptyBoostCounts = (): BoostCounts => ({ magnet: 0, leap: 0, speed: 0, invis: 0 });

/**
 * Saved charges (any shape) as counts of the current kinds: a retired kind's charges are added 1:1 to
 * the kind it became (`LEGACY_BOOST_KINDS`); negative, fractional and unknown entries are dropped.
 */
export function migrateBoostCounts(raw: unknown, cap = 1_000_000): BoostCounts {
  const out = emptyBoostCounts();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const kind = normalizeBoostKind(k);
    const n = Math.floor(Number(v));
    if (kind && Number.isFinite(n) && n > 0) out[kind] = Math.min(cap, out[kind] + n);
  }
  return out;
}

/** One pack in the shop, for one wallet. */
export interface ShopPack {
  kind: BoostKind;
  /** Charges in the pack. */
  charges: number;
  /** What this wallet pays, raw base units (decimal string): send exactly this. */
  priceRaw: string;
  /** The full price, raw base units (decimal string); equal to `priceRaw` without a holder discount. */
  fullPriceRaw: string;
  /** What this wallet pays and the full price in US cents, when the pack is priced in dollars (absent: in tokens). */
  usdCents?: number;
  fullUsdCents?: number;
  /** Sold right now. */
  enabled: boolean;
}

/** `GET /api/shop`: the packs for the signed-in wallet (or the public prices) and its charges. */
export interface ShopView {
  /** The shop is on and a game token is set (buying is possible). */
  open: boolean;
  /** Why buying is not possible right now, when `open` is false. */
  closedReason?: 'disabled' | 'no_token' | 'no_chain' | 'no_arena';
  /** The game token (null until it is set). */
  token: { address: string; symbol: string; decimals: number } | null;
  /** The arena contract the wallet approves and calls `pay(amount, shopPaymentRef(kind))` on (EIP-55). */
  payTo: string | null;
  /** Share of a payment the contract burns (bps); the rest goes to its fee wallet. Null while unknown. */
  burnBps: number | null;
  packs: ShopPack[];
  /** The wallet holds a Coinnibal emblem (its prices carry the discount). */
  holder: boolean;
  holderDiscountPct: number;
  /** The token's USD price the packs were converted at (USD per whole token); absent when priced in tokens. */
  usdPerToken?: string;
  /** Paid arenas: uses per round (the wallet's, holder bonus included). */
  arenaUsesPerRound: number;
  holderExtraArenaUses: number;
  /** The wallet's charges (absent for guests). */
  charges?: BoostCounts;
}

/** `POST /api/shop/buy {kind, txHash}` answer. */
export interface ShopBuyResult {
  ok: true;
  kind: BoostKind;
  added: number;
  charges: BoostCounts;
}

/* ── the cart: several power-ups, one payment ───────────────────────────── */

/** Limits of one cart: packs of one power-up, and packs in all. */
export const SHOP_CART_LIMITS = { perKind: 10, total: 20 } as const;

/** The letter of each power-up in a cart's payment ref (`BOOST_KINDS` order). */
const CART_LETTER: Record<BoostKind, string> = { magnet: 'm', leap: 'l', speed: 's', invis: 'i' };

/**
 * A valid cart, normalized (every kind present, whole packs within `SHOP_CART_LIMITS`, at least one pack), or null.
 * Accepts the JSON body of a purchase (`{ magnet: 2, leap: 1 }`).
 */
export function normalizeCart(raw: unknown): Record<BoostKind, number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {} as Record<BoostKind, number>;
  let total = 0;
  for (const k of BOOST_KINDS) {
    const v = (raw as Record<string, unknown>)[k] ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > SHOP_CART_LIMITS.perKind) return null;
    out[k] = v;
    total += v;
  }
  for (const key of Object.keys(raw as object)) if (!(BOOST_KINDS as readonly string[]).includes(key)) return null;
  return total >= 1 && total <= SHOP_CART_LIMITS.total ? out : null;
}

/**
 * The `CoinnibalArena.pay` ref of a cart: ASCII `coinnibal.cart.` and each power-up's letter and pack count in a fixed order
 * (`coinnibal.cart.m2l0s1i0`), zero-padded to 32 bytes. The ref names the whole cart, so one payment proves it.
 */
export function shopCartRef(cart: Record<BoostKind, number>): `0x${string}` {
  return asciiRef(cartAscii(REF_PREFIX, cart));
}

/**
 * The refs a cart's payment is accepted with: `shopCartRef(cart)`, and the same cart under the prefix of before the
 * rename (`elymum.cart.…`). Only the prefix differs: the cart, and every other check of the payment, do not.
 */
export function shopCartRefs(cart: Record<BoostKind, number>): readonly `0x${string}`[] {
  return [shopCartRef(cart), asciiRef(cartAscii(OLD_REF_PREFIX, cart))];
}

const cartAscii = (prefix: string, cart: Record<BoostKind, number>): string => `${prefix}.cart.${BOOST_KINDS.map((k) => `${CART_LETTER[k]}${cart[k] ?? 0}`).join('')}`;

/** The cart a ref names (`shopCartRef`), or null when it is not a cart ref. */
export function parseShopCartRef(ref: string): Record<BoostKind, number> | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) return null;
  let ascii = '';
  for (let i = 2; i < 66; i += 2) {
    const c = parseInt(ref.slice(i, i + 2), 16);
    if (c === 0) break;
    ascii += String.fromCharCode(c);
  }
  // the prefix of before the rename too: a cart paid just before the switch still reads as that cart
  const m = /^(?:coinnibal|elymum)\.cart\.m(\d{1,2})l(\d{1,2})s(\d{1,2})i(\d{1,2})$/.exec(ascii);
  if (!m) return null;
  return normalizeCart({ magnet: Number(m[1]), leap: Number(m[2]), speed: Number(m[3]), invis: Number(m[4]) });
}

/** A cart's price, raw base units: the sum of each power-up's pack price times its packs. */
export function cartTotal(cart: Record<BoostKind, number>, packPrice: (kind: BoostKind) => bigint): bigint {
  let total = 0n;
  for (const k of BOOST_KINDS) if (cart[k] > 0) total += packPrice(k) * BigInt(cart[k]);
  return total;
}

/**
 * `POST /api/shop/buy {cart, txHash}`: the cart was paid once and applied at once. `refundRaw` (base units, decimal
 * string) is the part of the payment that could not be applied (a power-up switched off between the quote and the
 * payment): it is recorded as owed to the wallet for the owner to send back, never kept silently.
 */
export interface ShopCartResult {
  ok: true;
  cart: Record<BoostKind, number>;
  /** Charges added per power-up. */
  added: BoostCounts;
  charges: BoostCounts;
  /** Kinds that could not be applied and the raw amount owed back for them (absent when everything applied). */
  refund?: { kinds: BoostKind[]; raw: string };
}

/** Why a purchase was refused (`error` of the 4xx body). */
export type ShopBuyError =
  | 'shop_closed'
  | 'kind_disabled'
  | 'bad_request'
  | 'tx_used'
  | 'tx_pending'
  | 'tx_failed'
  | 'no_payment'
  | 'wrong_token'
  | 'wrong_sender'
  | 'wrong_recipient'
  | 'wrong_pack'
  | 'wrong_amount'
  | 'tx_stale'
  | 'chain_busy';

/**
 * The boost state of the player in a room (`boosts` message): charges, cooldowns and the arena's
 * per-round allowance. Sent on join, after every use and after a purchase.
 */
export interface BoostState {
  /** The room lets bought power-ups be used (the shop is on and this is a signed-in human). */
  usable: boolean;
  /** Signed in (guests cannot buy; the HUD shows a sign-in hint). */
  signedIn: boolean;
  charges: BoostCounts;
  /** Milliseconds until each power-up can be used again (0: ready). */
  cooldownMs: BoostCounts;
  /** Paid arenas: uses left this round and the round's total (absent elsewhere: no per-round cap). */
  arena?: { left: number; max: number };
  /** Power-ups the admin turned off. */
  disabled?: BoostKind[];
}

/** Why a use was refused (`boost` message with `ok: false`). */
export type BoostRefusal = 'guest' | 'disabled' | 'no_charges' | 'cooldown' | 'round_limit' | 'dead' | 'bot';
