/**
 * Custom rooms: a signed-in wallet pays a small fee in the chain's gas token (to the treasury) and gets a
 * private room with its own rules (map size, practice bots in free rooms, duration, capacity, ...). The fee grows with the
 * capacity (`customRoomFee`). Two kinds:
 *
 *  - `free`: no stakes, pure fun (like practice). A `private` room (`RoomInfo.mode`), joined with
 *    `private:<CODE>`; anyone with the invite code joins (guests too).
 *  - `paid`: a private, invite-only instance of an existing on-chain arena (`arenaId`, its entry
 *    tier). Players buy the normal ticket of that arena and are seated in the private instance with
 *    `arena:<id>:<CODE>`; the ticket is settled by the server at the arena's bell like any other.
 *    No custody: the room never holds tokens, the arena vault does. Its `RoomInfo.mode` is `arena`
 *    and it is never listed, quick-played or picked by matchmaking.
 *
 * `RoomInfo.custom` carries the rules and the end time either way.
 */

/** Quick picks of the creator sheet; any whole multiple of `step` in `min..max` minutes is valid. */
export const CUSTOM_DURATIONS_MIN = [15, 30, 60] as const;
/** The creator sets the room's length: 5 to 180 minutes, in steps of 5. */
export const CUSTOM_DURATION_LIMITS = { min: 5, max: 180, step: 5 } as const;
/** Minutes a room stays open (a multiple of 5 from 5 to 180). */
export type CustomDuration = number;

/** Whether `n` is a room length the creator may pick. */
export function isCustomDuration(n: unknown): n is CustomDuration {
  const L = CUSTOM_DURATION_LIMITS;
  return typeof n === 'number' && Number.isInteger(n) && n >= L.min && n <= L.max && n % L.step === 0;
}

/** Map sizes, smallest first (S / M / L keep the sizes rooms were made with before XS and XL). */
export const CUSTOM_MAP_SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type CustomMapSize = (typeof CUSTOM_MAP_SIZES)[number];

/**
 * What the creator picks: `auto` (the default) sizes the map for the players in the room (the bots
 * plus the people in it) and grows it as people join (`map-scale.ts`); a fixed size is kept as is.
 */
export const CUSTOM_MAP_CHOICES = ['auto', ...CUSTOM_MAP_SIZES] as const;
export type CustomMapChoice = (typeof CUSTOM_MAP_CHOICES)[number];

export const CUSTOM_DIFFICULTIES = ['easy', 'mixed', 'hard'] as const;
export type CustomDifficulty = (typeof CUSTOM_DIFFICULTIES)[number];

export const CUSTOM_FOOD = ['low', 'normal', 'high'] as const;
export type CustomFood = (typeof CUSTOM_FOOD)[number];

/** The map's danger: how many rug cacti (thorn bushes) grow on it. */
export const CUSTOM_TRAPS = ['none', 'few', 'normal', 'many'] as const;
export type CustomTraps = (typeof CUSTOM_TRAPS)[number];

/** Cacti per area against a practice pond's (`none` grows none). */
export const CUSTOM_TRAP_MUL: Record<CustomTraps, number> = { none: 0, few: 0.5, normal: 1, many: 2 };

/** How NFT holders are rewarded: a discount on the price, one free room a day (UTC), or nothing. */
export const CUSTOM_HOLDER_PERKS = ['discount', 'free_daily', 'none'] as const;
export type CustomHolderPerk = (typeof CUSTOM_HOLDER_PERKS)[number];

/** Free room (no stakes) or paid room (an invite-only instance of an on-chain arena). */
export const CUSTOM_KINDS = ['free', 'paid'] as const;
export type CustomRoomKind = (typeof CUSTOM_KINDS)[number];

/** Bounds of the creator's choices (the admin's `maxPlayers` caps the capacity further). */
export const CUSTOM_LIMITS = {
  nameMin: 2,
  nameMax: 24,
  botsMax: 12,
  playersMin: 2,
  /** The biggest room the server could ever host (the admin setting `maxPlayers` is at most this). */
  playersMax: 100,
} as const;

/** The capacities the creator steps through (any whole number in range is valid on the server). */
export const CUSTOM_CAPACITY_STEPS = [2, 4, 6, 8, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100] as const;

/** Players per fee tier: the fee grows by `capacityStepPct` of the base for every started tier above the first. */
export const CUSTOM_CAPACITY_TIER = 10;

/** Fee tiers of a capacity: 1 for up to 10 players, 2 for 11..20, 3 for 21..30, ... */
export function customCapacityTiers(capacity: number): number {
  return Math.max(1, Math.ceil(Math.max(1, Math.floor(capacity)) / CUSTOM_CAPACITY_TIER));
}

/**
 * The creation fee of a room of `capacity` (wei, before any holder perk): the base for up to 10
 * players, plus `stepPct` % of the base for every started 10 players above the first 10.
 * With the default 50 %: 11..20 → x1.5, 21..30 → x2, ..., 91..100 → x5.5. Rounded down to the wei.
 */
export function customRoomFee(baseWei: bigint, capacity: number, stepPct: number): bigint {
  const steps = BigInt(customCapacityTiers(capacity) - 1);
  const pct = BigInt(Math.max(0, Math.floor(stepPct)));
  return baseWei + (baseWei * pct * steps) / 100n;
}

/** The capacity steps a creator may pick under the admin's cap (`maxPlayers`). */
export function customCapacityChoices(maxPlayers: number): number[] {
  const list: number[] = CUSTOM_CAPACITY_STEPS.filter((n) => n <= maxPlayers);
  if (maxPlayers >= CUSTOM_LIMITS.playersMin && !list.includes(maxPlayers)) list.push(maxPlayers);
  return list;
}

/**
 * World sizes (square) per map size: XS is a quick brawl, S smaller than a private room, L about a
 * practice pond, XL bigger than an arena. Food and cacti scale with the area (capped for the CPU:
 * `CUSTOM_WORLD_CAPS`).
 */
export const CUSTOM_MAP_WIDTH: Record<CustomMapSize, number> = { XS: 3000, S: 3600, M: 5200, L: 7000, XL: 9000 };

/** Upper bounds of a custom world's food and cacti whatever the choices (the server is small). */
export const CUSTOM_WORLD_CAPS = { food: 3000, viruses: 36 } as const;

/** What the creator picks in the room creator sheet. */
export interface CustomRoomConfig {
  /** Room name (2..24 printable characters). */
  name: string;
  durationMin: CustomDuration;
  /** `auto` or a fixed size (rooms made before `auto` existed always carry a size). */
  mapSize: CustomMapChoice;
  /**
   * Practice bots in the room, 0..12 (0: off). FREE rooms only: a paid room (stakes) always has 0. They are
   * labelled BOT, hold no value and see only what a person would.
   */
  bots: number;
  /** How well the bots play (`mixed`: a third each of easy, normal and hard). */
  difficulty: CustomDifficulty;
  /** Most humans at once (the room's capacity), 2..100 (and at most the admin's `maxPlayers`). */
  maxPlayers: number;
  food: CustomFood;
  /** Rug cacti on the map (absent in rooms made before it existed: `normal`). */
  traps: CustomTraps;
  powerUps: boolean;
  /** `free` (no stakes) or `paid` (an invite-only instance of arena `arenaId`). Rooms made before it: `free`. */
  kind: CustomRoomKind;
  /** Paid rooms: the arena whose tickets seat players here (its entry fee is the stake); null for free rooms. */
  arenaId: number | null;
}

export const CUSTOM_DEFAULTS: CustomRoomConfig = {
  name: '',
  durationMin: 30,
  mapSize: 'auto',
  bots: 0,
  difficulty: 'mixed',
  maxPlayers: 10,
  food: 'normal',
  traps: 'normal',
  powerUps: true,
  kind: 'free',
  arenaId: null,
};

/** The rules of a live custom room as clients see them (`RoomInfo.custom`). */
export interface CustomRoomSummary {
  durationMin: CustomDuration;
  mapSize: CustomMapChoice;
  bots: number;
  difficulty: CustomDifficulty;
  food: CustomFood;
  /** Rug cacti on the map. Old servers leave it out (read it as `normal`). */
  traps?: CustomTraps;
  powerUps: boolean;
  /** `paid`: an arena instance (tickets of `arenaId`). Old servers leave it out (read it as `free`). */
  kind?: CustomRoomKind;
  /** Paid rooms: the arena whose tickets seat players here. */
  arenaId?: number;
  /**
   * Paid rooms closing (time is up, or closed early): no new seats; the room closes at its next
   * bell, once every ticket in it is settled.
   */
  closing?: boolean;
  /** Creator wallet (EIP-55). */
  creator: string;
  /** Unix ms: the room opened. */
  createdAt: number;
  /** Unix ms: the room closes (everyone goes back to the lobby). */
  endsAt: number;
}

/** A row of a custom room's own leaderboard (best finished games in this room). */
export interface CustomBest {
  name: string;
  /** Best mass of the game. */
  score: number;
  kills: number;
  at: number;
}

/** `GET /api/rooms/custom/<CODE>` and the create / list answers. */
export interface CustomRoomView extends CustomRoomSummary {
  code: string;
  name: string;
  maxPlayers: number;
  /** Humans in the room now. */
  players: number;
  /** The room's own leaderboard, best first (up to 10). */
  best: CustomBest[];
  /** How it was paid: `paid` (a gas-token transfer) or `free` (the holder perk: a free room of the day, or a 100 % discount). */
  paidWith: 'paid' | 'free';
  /** The payment transaction (0x hash), when paid. */
  txHash: string | null;
  /** The creation fee paid, wei (decimal string; "0" for a free room). */
  feeWei?: string;
}

/** The admin settings (`/api/admin/custom-rooms`). */
export interface CustomRoomSettings {
  /** Creating rooms is open. */
  enabled: boolean;
  /** Price in the chain's gas token, decimal string (e.g. "0.05"). */
  priceGas: string;
  /** Where the fee goes (EIP-55); null: the first `ADMIN_WALLETS` wallet (the owner). */
  treasury: string | null;
  holderPerk: CustomHolderPerk;
  /** `discount` perk: percent off for NFT holders (0..100). */
  holderDiscountPct: number;
  /** Most custom rooms live at once on this server (it is small). */
  maxLive: number;
  /** Most live custom rooms per creator wallet. */
  maxPerWallet: number;
  /** The fee grows by this percent of the base price for every started 10 players above the first 10 (0..500). */
  capacityStepPct: number;
  /** The biggest room a creator may open (2..100). */
  maxPlayers: number;
  /**
   * Seats of all live custom rooms together (Σ capacity, 10..500): keeps them inside what the
   * server is sized for (about 500 players at once) next to the public rooms.
   */
  maxSeats: number;
  /** Paid rooms (invite-only arena instances) may be created. */
  paidRooms: boolean;
}

export const CUSTOM_SETTINGS_DEFAULT: CustomRoomSettings = {
  enabled: true,
  priceGas: '0.05',
  treasury: null,
  holderPerk: 'discount',
  holderDiscountPct: 50,
  maxLive: 6,
  maxPerWallet: 2,
  capacityStepPct: 50,
  maxPlayers: 100,
  maxSeats: 300,
  paidRooms: true,
};

/** Bounds of the admin caps. */
export const CUSTOM_SETTINGS_LIMITS = { maxLive: 24, maxPerWallet: 10, capacityStepPct: 500, maxPlayers: CUSTOM_LIMITS.playersMax, maxSeats: 500, maxSeatsMin: 10 } as const;

/** An arena tier a paid room can be made of (`CustomRoomQuote.tiers`). */
export interface CustomArenaTier {
  arenaId: number;
  /** Ticket price, ledger units (the server's `RoomInfo.entryFee` units). */
  entryFee: number;
  /** Emblem holders only (on chain): offered to holders only. */
  holdersOnly: boolean;
}

/** A payment older than this is refused (`payment_stale`). */
export const CUSTOM_PAYMENT_MAX_AGE_MS = 2 * 3600_000;

/** `GET /api/rooms/custom/quote`: what creating a room costs this wallet right now. */
export interface CustomRoomQuote {
  enabled: boolean;
  /** Base price (rooms of up to 10 players), wei (decimal string). */
  priceWei: string;
  /** What this wallet pays for a room of the base size, wei (decimal string; "0" with a free room). */
  youPayWei: string;
  /** The fee grows by this percent of the base for every started 10 players above 10 (`customRoomFee`). */
  capacityStepPct: number;
  /** The biggest room this server lets a creator open. */
  maxPlayers: number;
  /** Seats left under the server's `maxSeats` (Σ capacity of the live rooms). */
  seatsLeft: number;
  /** Paid rooms may be created now (setting on, chain arenas open). */
  paidRooms: boolean;
  /** The arena tiers a paid room can be made of (holders-only tiers are listed; the creator must hold). */
  tiers: CustomArenaTier[];
  /** Fee receiver (EIP-55); null: none configured (creating is closed). */
  treasury: string | null;
  holderPerk: CustomHolderPerk;
  holderDiscountPct: number;
  /** The signed-in wallet holds an Elymum NFT (false for guests). */
  holder: boolean;
  /** The holder's free room of the day is still available (`free_daily`). */
  freeAvailable: boolean;
  live: number;
  maxLive: number;
  /** Live rooms of the signed-in wallet. */
  mine: number;
  maxPerWallet: number;
  /** The server's chain id (the payment must be sent on it); null while the chain is off. */
  chainId: number | null;
}

/** Error codes of the custom room API (`{ error, message }`). */
export type CustomRoomError =
  | 'bad_request'
  | 'unauthorized'
  | 'rooms_closed'
  | 'slots_busy'
  | 'wallet_limit'
  | 'payment_required'
  | 'payment_pending'
  | 'payment_invalid'
  | 'payment_used'
  | 'payment_stale'
  | 'payment_low'
  | 'chain_busy'
  | 'not_found'
  | 'forbidden'
  | 'seats_busy'
  | 'paid_closed'
  | 'holders_only';

const NAME_RE = /^[\p{L}\p{N} .,'!?&#@:()_-]+$/u;

/** Checks the creator's choices; returns the clean config or an error message naming the field. */
export function validateCustomConfig(x: unknown): { ok: true; config: CustomRoomConfig } | { ok: false; field: string; message: string } {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, field: 'config', message: 'config must be an object' };
  const o = x as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim() : '';
  if (name.length < CUSTOM_LIMITS.nameMin || name.length > CUSTOM_LIMITS.nameMax || !NAME_RE.test(name)) {
    return { ok: false, field: 'name', message: `Give the room a name of ${CUSTOM_LIMITS.nameMin} to ${CUSTOM_LIMITS.nameMax} letters or digits.` };
  }
  const pick = <T extends string | number>(v: unknown, list: readonly T[], field: string): T | { field: string } =>
    (list as readonly unknown[]).includes(v) ? (v as T) : { field };
  const durationMin = isCustomDuration(o.durationMin) ? o.durationMin : { field: 'durationMin' };
  const mapSize = pick(o.mapSize, CUSTOM_MAP_CHOICES, 'mapSize');
  const difficulty = pick(o.difficulty, CUSTOM_DIFFICULTIES, 'difficulty');
  const food = o.food === undefined ? CUSTOM_DEFAULTS.food : pick(o.food, CUSTOM_FOOD, 'food');
  const traps = o.traps === undefined ? CUSTOM_DEFAULTS.traps : pick(o.traps, CUSTOM_TRAPS, 'traps');
  for (const v of [durationMin, mapSize, difficulty, food, traps]) if (typeof v === 'object') return { ok: false, field: v.field, message: `${v.field} is not one of the choices` };
  const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);
  const bots = int(o.bots, 0, CUSTOM_LIMITS.botsMax);
  if (bots === null) return { ok: false, field: 'bots', message: `bots must be a whole number from 0 to ${CUSTOM_LIMITS.botsMax}` };
  const maxPlayers = int(o.maxPlayers, CUSTOM_LIMITS.playersMin, CUSTOM_LIMITS.playersMax);
  if (maxPlayers === null) return { ok: false, field: 'maxPlayers', message: `maxPlayers must be a whole number from ${CUSTOM_LIMITS.playersMin} to ${CUSTOM_LIMITS.playersMax}` };
  const powerUps = o.powerUps === undefined ? true : o.powerUps;
  if (typeof powerUps !== 'boolean') return { ok: false, field: 'powerUps', message: 'powerUps must be true or false' };
  // rooms made before kinds existed are free rooms
  const kind = o.kind === undefined ? 'free' : o.kind;
  if (kind !== 'free' && kind !== 'paid') return { ok: false, field: 'kind', message: 'kind must be free or paid' };
  let arenaId: number | null = null;
  if (kind === 'paid') {
    arenaId = int(o.arenaId, 1, 65535);
    if (arenaId === null) return { ok: false, field: 'arenaId', message: 'Pick the arena tier of the paid room.' };
  } else if (o.arenaId !== undefined && o.arenaId !== null) return { ok: false, field: 'arenaId', message: 'A free room has no arena tier.' };
  // bots are for free practice only: a room with stakes is people only
  if (kind === 'paid' && bots > 0) return { ok: false, field: 'bots', message: 'Bots play in free rooms only: a paid room is for people.' };
  return {
    ok: true,
    config: {
      name,
      durationMin: durationMin as CustomDuration,
      mapSize: mapSize as CustomMapChoice,
      bots,
      difficulty: difficulty as CustomDifficulty,
      maxPlayers,
      food: food as CustomFood,
      traps: traps as CustomTraps,
      powerUps,
      kind,
      arenaId,
    },
  };
}

/** Invite codes are the private-room codes: 5 of these characters (no 0/O, 1/I). */
export const INVITE_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

/** The code in an invite (`?room=CODE`, any case); null when it is not one. */
export function parseInviteCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  return INVITE_CODE_RE.test(c) ? c : null;
}

/** The share link of a room: `<origin>/play?room=CODE` (e.g. https://elymum.io/play?room=AB2CD). */
export function inviteUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/play?room=${encodeURIComponent(code)}`;
}

/**
 * What a wallet pays for a room (wei) given its fee (`customRoomFee`), the settings and its holder
 * status. The holders' free room of the day covers rooms of the base size (up to 10 players,
 * `capacity`); a bigger room pays its full fee (and the free room is kept for later).
 */
export function customRoomPrice(
  priceWei: bigint,
  s: Pick<CustomRoomSettings, 'holderPerk' | 'holderDiscountPct'>,
  holder: boolean,
  freeAvailable: boolean,
  capacity: number = CUSTOM_CAPACITY_TIER,
): bigint {
  if (!holder) return priceWei;
  if (customUsesFreeRoom(s, holder, freeAvailable, capacity)) return 0n;
  if (s.holderPerk === 'discount') {
    const pct = BigInt(Math.max(0, Math.min(100, Math.floor(s.holderDiscountPct))));
    return (priceWei * (100n - pct)) / 100n;
  }
  return priceWei;
}

/** Whether a free-daily holder's room of `capacity` is their free room of the day (only rooms of the base size are). */
export function customUsesFreeRoom(s: Pick<CustomRoomSettings, 'holderPerk'>, holder: boolean, freeAvailable: boolean, capacity: number): boolean {
  return holder && freeAvailable && s.holderPerk === 'free_daily' && customCapacityTiers(capacity) === 1;
}

/** What the quoted wallet pays for a room of `capacity` (wei): the creator sheet's live price. */
export function quotePrice(q: Pick<CustomRoomQuote, 'priceWei' | 'capacityStepPct' | 'holderPerk' | 'holderDiscountPct' | 'holder' | 'freeAvailable'>, capacity: number): bigint {
  const fee = customRoomFee(BigInt(q.priceWei), capacity, q.capacityStepPct ?? 0);
  return customRoomPrice(fee, q, q.holder, q.freeAvailable, capacity);
}

/** A paid room's share link lands here too (`/play?room=CODE`): the client reads the room's kind first. */
export function paidRoomTarget(arenaId: number, code: string): string {
  return `arena:${arenaId}:${code}`;
}
