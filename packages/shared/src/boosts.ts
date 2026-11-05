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

/** The speed burst multiplier (the map pump's). */
export const BOOST_SPEED_MUL = RULES.pumpSpeedMul;

/** The burn address the default sink sends to. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

export type ShopSink = 'burn' | 'treasury';

/** The admin's shop settings (`/api/admin/shop`, stored in `DATA_DIR/site/shop.json`). */
export interface ShopSettings {
  /** Buying and using bought power-ups is on. */
  enabled: boolean;
  /** Where payments go: the burn address (default) or the treasury wallet. */
  sink: ShopSink;
  /** The treasury wallet (EIP-55); null: the first `ADMIN_WALLETS` entry (the owner). */
  treasury: string | null;
  /** Charges in one pack. */
  packSize: number;
  /** Price of one pack, whole game tokens as a decimal string ("300", "12.5"). */
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
 * Default prices, tied to the cheapest arena ticket (1,000 `$ELYMUM`, `DEFAULT_ARENAS`): one charge
 * costs 20-40 % of that ticket (a pack of 3: Magnet and Speed 600, Leap 900, Invisibility 1,200).
 * A charge is cheap next to what a round can win, so buying one is an easy call, while the per-round
 * cap in paid arenas (`arenaUsesPerRound`) keeps them from deciding a fight. Payments are burned.
 */
export const SHOP_DEFAULTS: ShopSettings = {
  enabled: true,
  sink: 'burn',
  treasury: null,
  packSize: 3,
  prices: { magnet: '600', leap: '900', speed: '600', invis: '1200' },
  kinds: { magnet: true, leap: true, speed: true, invis: true },
  holderDiscountPct: 30,
  arenaUsesPerRound: 2,
  holderExtraArenaUses: 1,
};

/** The default prices before the 2026-11 economy update (a saved file still holding all of them takes the new ones). */
export const OLD_SHOP_PRICES: Readonly<Record<BoostKind, string>> = { magnet: '1500', leap: '2500', speed: '1500', invis: '3000' };

/** Bounds of the admin values. */
export const SHOP_LIMITS = { packSize: 20, holderDiscountPct: 90, arenaUsesPerRound: 20, holderExtraArenaUses: 10, priceTokens: 1_000_000_000 } as const;

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
  /** Sold right now. */
  enabled: boolean;
}

/** `GET /api/shop`: the packs for the signed-in wallet (or the public prices) and its charges. */
export interface ShopView {
  /** The shop is on and a game token is set (buying is possible). */
  open: boolean;
  /** Why buying is not possible right now, when `open` is false. */
  closedReason?: 'disabled' | 'no_token' | 'no_chain' | 'no_sink';
  /** The game token (null until it is set). */
  token: { address: string; symbol: string; decimals: number } | null;
  /** Where the transfer goes (EIP-55). */
  sink: string | null;
  sinkKind: ShopSink;
  packs: ShopPack[];
  /** The wallet holds an Elymum emblem (its prices carry the discount). */
  holder: boolean;
  holderDiscountPct: number;
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

/** Why a purchase was refused (`error` of the 4xx body). */
export type ShopBuyError =
  | 'shop_closed'
  | 'kind_disabled'
  | 'bad_request'
  | 'tx_used'
  | 'tx_pending'
  | 'tx_failed'
  | 'no_transfer'
  | 'wrong_token'
  | 'wrong_sender'
  | 'wrong_recipient'
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
