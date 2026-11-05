import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CUSTOM_HOLDER_PERKS,
  CUSTOM_LIMITS,
  CUSTOM_MAP_SIZES,
  CUSTOM_MAP_WIDTH,
  CUSTOM_SETTINGS_DEFAULT,
  CUSTOM_SETTINGS_LIMITS,
  CUSTOM_TRAP_MUL,
  CUSTOM_WORLD_CAPS,
  WORLD_PRESETS,
  customRoomFee,
  customRoomPrice,
  customUsesFreeRoom,
  validateCustomConfig,
  type CustomArenaTier,
  type CustomBest,
  type CustomMapSize,
  type CustomRoomConfig,
  type CustomRoomError,
  type CustomRoomQuote,
  type CustomRoomSettings,
  type CustomRoomSummary,
  type CustomRoomView,
} from '@elymum/shared';
import { getAddress, parseEther } from 'viem';
import type { BotManagerOptions } from '../bots/manager';
import type { BotMixWeights } from '../bots/personality';
import { PaymentChainBusy, TX_HASH_RE, checkPayment, type PaymentReader, type UsedPayments } from '../chain/payment';
import { ChainBusyError } from '../chain/types';
import type { CustomRoomHooks, PaidArena, RoomManager } from './manager';
import type { RoomHandle } from './handle';
import type { WorldShape } from './room';

/** A refusal of the custom room API: HTTP status, code and a friendly message. */
export class CustomRoomFail extends Error {
  constructor(
    readonly status: number,
    readonly code: CustomRoomError,
    message: string,
    readonly field?: string,
    /** `slots_busy` after a verified payment: the payment stays unused, the creator can retry with it. */
    readonly paid?: boolean,
  ) {
    super(message);
  }
}

/** A custom room as stored (`DATA_DIR/site/custom-rooms.json`). */
export interface CustomRecord {
  code: string;
  config: CustomRoomConfig;
  creator: string;
  createdAt: number;
  endsAt: number;
  paidWith: 'paid' | 'free';
  txHash: string | null;
  /** Wei paid (decimal string). */
  paidWei: string;
  best: CustomBest[];
  /** The "1 minute left" line was said. */
  warned?: boolean;
  /** Paid rooms: the arena's ticket price when the room was made (ledger units; the instance's `stake.buyIn`). */
  buyIn?: number;
  /**
   * Paid rooms: time is up or it was closed early. No new seat; the room closes once its bell
   * settled every ticket in it (`RoomManager.closePaidRoom`), then this record goes.
   */
  closing?: boolean;
}

interface RoomsFile {
  v: 1;
  rooms: CustomRecord[];
  /** Holder wallet (lower case) → UTC day (YYYY-MM-DD) of its last free room. */
  freeUsed: Record<string, string>;
}

/** Bot difficulty weights per choice. */
export const CUSTOM_BOT_MIX: Record<CustomRoomConfig['difficulty'], BotMixWeights> = {
  easy: { easy: 100, medium: 0, hard: 0 },
  mixed: { easy: 45, medium: 40, hard: 15 },
  hard: { easy: 0, medium: 35, hard: 65 },
};

const FOOD_MUL: Record<CustomRoomConfig['food'], number> = { low: 0.6, normal: 1, high: 1.6 };
const POWERUPS: Record<CustomMapSize, number> = { XS: 2, S: 2, M: 3, L: 4, XL: 5 };

/**
 * The world of a config: food and rug cacti scale with the area like a practice pond's, food by the
 * food choice and cacti by the traps choice, both capped (`CUSTOM_WORLD_CAPS`) so an XL map with
 * plenty of everything stays cheap to simulate. An `auto` room passes its current `side`
 * (without one it opens at M).
 */
export function customWorld(c: CustomRoomConfig, side?: number): WorldShape {
  const ref = WORLD_PRESETS.practice;
  const fixed = c.mapSize !== 'auto' ? CUSTOM_MAP_WIDTH[c.mapSize] : undefined;
  const w = side ?? fixed ?? CUSTOM_MAP_WIDTH.M;
  const ratio = (w * w) / (ref.width * ref.height);
  // rooms saved before traps existed read as `normal`
  const traps = CUSTOM_TRAP_MUL[c.traps ?? 'normal'];
  // power-ups by the nearest fixed size at or above this side
  const tier = CUSTOM_MAP_SIZES.find((m) => CUSTOM_MAP_WIDTH[m] >= w) ?? 'XL';
  return {
    width: w,
    height: w,
    foodTarget: Math.min(CUSTOM_WORLD_CAPS.food, Math.round(ref.foodTarget * ratio * FOOD_MUL[c.food])),
    virusTarget: traps === 0 ? 0 : Math.min(CUSTOM_WORLD_CAPS.viruses, Math.max(2, Math.round(ref.virusTarget * ratio * traps))),
    maxPowerUps: c.powerUps ? POWERUPS[c.mapSize !== 'auto' ? c.mapSize : tier] : 0,
  };
}

/** Bots of a config: exactly `bots` of them, whatever the humans do. */
export function customBots(c: CustomRoomConfig): BotManagerOptions | null {
  if (c.bots <= 0) return null;
  // never a pack on one person: one chaser at a time (two on hard)
  return { enabled: true, target: c.bots, min: c.bots, max: c.bots, mix: { ...CUSTOM_BOT_MIX[c.difficulty] }, maxChasers: c.difficulty === 'hard' ? 2 : 1 };
}

const BEST_KEPT = 10;
const BEST_FLUSH_MS = 10_000;
/** The room says "1 minute left" this long before it closes. */
export const CUSTOM_WARN_MS = 60_000;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Validates an admin update of the settings; returns the merged settings. */
export function applyCustomSettings(cur: CustomRoomSettings, body: Record<string, unknown>, strict = true): CustomRoomSettings {
  const next = { ...cur };
  const bad = (field: string, message: string) => new CustomRoomFail(400, 'bad_request', message, field);
  const keys: (keyof CustomRoomSettings)[] = ['enabled', 'priceHype', 'treasury', 'holderPerk', 'holderDiscountPct', 'maxLive', 'maxPerWallet', 'capacityStepPct', 'maxPlayers', 'maxSeats', 'paidRooms'];
  for (const k of Object.keys(body)) if (!keys.includes(k as keyof CustomRoomSettings) && strict) throw bad(k, `unknown field ${k}`);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw bad('enabled', 'enabled must be true or false');
    next.enabled = body.enabled;
  }
  if (body.paidRooms !== undefined) {
    if (typeof body.paidRooms !== 'boolean') throw bad('paidRooms', 'paidRooms must be true or false');
    next.paidRooms = body.paidRooms;
  }
  if (body.priceHype !== undefined) {
    const p = body.priceHype;
    if (typeof p !== 'string' || !/^\d{1,6}(\.\d{1,18})?$/.test(p)) throw bad('priceHype', 'priceHype must be a HYPE amount like "0.05"');
    if (parseEther(p) > parseEther('1000')) throw bad('priceHype', 'priceHype must be at most 1000 HYPE');
    next.priceHype = p;
  }
  if (body.treasury !== undefined) {
    if (body.treasury === null || body.treasury === '') next.treasury = null;
    else {
      try {
        if (typeof body.treasury !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.treasury)) throw new Error();
        next.treasury = getAddress(body.treasury.toLowerCase());
      } catch {
        throw bad('treasury', 'treasury must be a wallet address (0x...) or empty for the owner wallet');
      }
    }
  }
  if (body.holderPerk !== undefined) {
    if (!(CUSTOM_HOLDER_PERKS as readonly unknown[]).includes(body.holderPerk)) throw bad('holderPerk', `holderPerk must be one of ${CUSTOM_HOLDER_PERKS.join(', ')}`);
    next.holderPerk = body.holderPerk as CustomRoomSettings['holderPerk'];
  }
  const int = (v: unknown, field: string, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(field, `${field} must be a whole number from ${min} to ${max}`);
    return v;
  };
  if (body.holderDiscountPct !== undefined) next.holderDiscountPct = int(body.holderDiscountPct, 'holderDiscountPct', 0, 100);
  if (body.maxLive !== undefined) next.maxLive = int(body.maxLive, 'maxLive', 0, CUSTOM_SETTINGS_LIMITS.maxLive);
  if (body.maxPerWallet !== undefined) next.maxPerWallet = int(body.maxPerWallet, 'maxPerWallet', 1, CUSTOM_SETTINGS_LIMITS.maxPerWallet);
  if (body.capacityStepPct !== undefined) next.capacityStepPct = int(body.capacityStepPct, 'capacityStepPct', 0, CUSTOM_SETTINGS_LIMITS.capacityStepPct);
  if (body.maxPlayers !== undefined) next.maxPlayers = int(body.maxPlayers, 'maxPlayers', CUSTOM_LIMITS.playersMin, CUSTOM_SETTINGS_LIMITS.maxPlayers);
  if (body.maxSeats !== undefined) next.maxSeats = int(body.maxSeats, 'maxSeats', CUSTOM_SETTINGS_LIMITS.maxSeatsMin, CUSTOM_SETTINGS_LIMITS.maxSeats);
  if (next.maxSeats < next.maxPlayers) throw bad('maxSeats', `maxSeats (${next.maxSeats}) must be at least the biggest room (maxPlayers ${next.maxPlayers})`);
  return next;
}

export interface CustomRoomDeps {
  rooms: RoomManager;
  /** `DATA_DIR` (settings and rooms under `site/`); null: memory only. */
  dataDir: string | null;
  /** File-name suffix (`.dev-fake` on the fake chain, so dev rooms never mix with real ones). */
  suffix?: string;
  /** Used payment hashes of the server's chain (persisted per chain). */
  used: UsedPayments;
  /** Reads payments on the server's chain; null while the chain is off (paid rooms closed). */
  reader: () => PaymentReader | null;
  /** The server's chain id (shown in the quote: the payment goes there). */
  chainId: () => number | null;
  /** Whether a wallet holds an Elymum NFT (cached by the mint service). */
  isHolder: (wallet: string) => Promise<boolean>;
  /** The treasury when the admin set none: the owner (first `ADMIN_WALLETS` wallet); null: none. */
  ownerWallet: string | null;
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * Custom rooms: settings (`site/custom-rooms-settings.json`), the live rooms (`site/custom-rooms.json`,
 * restored after a restart for their remaining time), payment checks, caps, expiry and the rooms'
 * own leaderboards.
 */
export class CustomRoomService implements CustomRoomHooks {
  private cur: CustomRoomSettings;
  private readonly records = new Map<string, CustomRecord>();
  private freeUsed: Record<string, string> = {};
  /** Wallets with a create under way (one at a time per wallet). */
  private readonly creating = new Set<string>();
  private bestDirty = false;
  private lastBestFlush = 0;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: CustomRoomDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => {});
    this.cur = { ...CUSTOM_SETTINGS_DEFAULT };
    this.loadSettings();
    this.loadRooms();
    d.rooms.setCustomRooms(this);
  }

  /* ------------------------------ files ------------------------------ */

  private file(name: string): string | null {
    return this.d.dataDir ? join(this.d.dataDir, 'site', `${name}${this.d.suffix ?? ''}.json`) : null;
  }

  private write(path: string | null, body: unknown): void {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 1));
    renameSync(tmp, path);
  }

  private loadSettings(): void {
    const p = this.file('custom-rooms-settings');
    if (!p || !existsSync(p)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (!isObj(raw)) throw new Error('not an object');
      // a file still holding the old caps (50 players, 200 seats) gets the bigger rooms; an admin's own caps stay
      if (raw.maxPlayers === 50 && (raw.maxSeats === undefined || raw.maxSeats === 200)) {
        raw.maxPlayers = CUSTOM_SETTINGS_DEFAULT.maxPlayers;
        raw.maxSeats = CUSTOM_SETTINGS_DEFAULT.maxSeats;
      }
      this.cur = applyCustomSettings(this.cur, raw, false);
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`custom rooms: settings unreadable (${(err as Error).message}); moved to ${backup}, using the defaults`);
    }
  }

  private loadRooms(): void {
    const p = this.file('custom-rooms');
    if (!p || !existsSync(p)) return;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as RoomsFile;
      this.freeUsed = isObj(raw.freeUsed) ? (raw.freeUsed as Record<string, string>) : {};
      for (const r of Array.isArray(raw.rooms) ? raw.rooms : []) {
        const v = validateCustomConfig(r?.config);
        if (!v.ok || typeof r.code !== 'string' || !Number.isFinite(r.endsAt)) continue;
        // a paid room is an arena instance: it cannot open again without its ticket price
        if (v.config.kind === 'paid' && !(typeof r.buyIn === 'number' && Number.isSafeInteger(r.buyIn) && r.buyIn > 0)) continue;
        this.records.set(r.code, { ...r, config: v.config, best: Array.isArray(r.best) ? r.best.slice(0, BEST_KEPT) : [] });
      }
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`custom rooms: ${p} unreadable (${(err as Error).message}); moved to ${backup}`);
    }
  }

  private saveRooms(): void {
    this.bestDirty = false;
    this.lastBestFlush = this.now();
    this.write(this.file('custom-rooms'), { v: 1, rooms: [...this.records.values()], freeUsed: this.freeUsed } satisfies RoomsFile);
  }

  /** Writes the rooms' leaderboards if they changed (shutdown). */
  flush(): void {
    if (this.bestDirty) this.saveRooms();
  }

  /**
   * Re-opens the stored rooms that still have time left (after a restart) and forgets the
   * expired ones. Returns how many were re-opened.
   */
  restore(): number {
    const now = this.now();
    let n = 0;
    let dropped = 0;
    for (const [code, r] of [...this.records]) {
      if (this.d.rooms.get(`priv-${code}`)) continue;
      // gone with the restart (or the room worker): a paid room's tickets were settled from the
      // journal (shutdown or crash recovery), by session, whatever room they were in
      if (r.endsAt <= now || r.closing) {
        this.records.delete(code);
        dropped++;
        continue;
      }
      this.open(r);
      n++;
    }
    if (n > 0 || dropped > 0) {
      this.log(`custom rooms: ${n} re-opened for their remaining time, ${dropped} expired while the server was down`);
      this.saveRooms();
    }
    return n;
  }

  private open(r: CustomRecord): RoomHandle {
    const opts = {
      name: r.config.name,
      maxPlayers: r.config.maxPlayers,
      bots: customBots(r.config),
      world: customWorld(r.config),
      // "Auto": the private rooms' curve, sized for the bots plus the people in the room
      ...(r.config.mapSize === 'auto' ? { map: { scale: this.d.rooms.customMapScale(), shape: (side: number) => customWorld(r.config, side), config: r.config } } : {}),
      powerUps: r.config.powerUps,
      custom: this.summary(r),
    };
    if (r.config.kind === 'paid' && r.config.arenaId !== null) {
      // an invite-only instance of the arena: its tickets, its vault, its bell
      return this.d.rooms.createPaidRoom(r.code, { ...opts, stake: { arenaId: r.config.arenaId, buyIn: r.buyIn ?? 0 } });
    }
    return this.d.rooms.createCustomRoom(r.code, opts);
  }

  /* ------------------------------ settings ------------------------------ */

  get settings(): CustomRoomSettings {
    return { ...this.cur };
  }

  updateSettings(body: Record<string, unknown>): CustomRoomSettings {
    this.cur = applyCustomSettings(this.cur, body);
    this.write(this.file('custom-rooms-settings'), this.cur);
    return this.settings;
  }

  /** Where fees go: the admin's treasury, else the owner wallet. */
  treasury(): string | null {
    return this.cur.treasury ?? this.d.ownerWallet;
  }

  /** Base price (rooms of up to 10 players), wei. */
  priceWei(): bigint {
    return parseEther(this.cur.priceHype);
  }

  /** The fee of a room of `capacity` before any holder perk (`customRoomFee`), wei. */
  feeWei(capacity: number): bigint {
    return customRoomFee(this.priceWei(), capacity, this.cur.capacityStepPct);
  }

  /** Seats taken by the live custom rooms (Σ capacity). */
  seatsUsed(): number {
    let n = 0;
    for (const r of this.records.values()) n += r.config.maxPlayers;
    return n;
  }

  /** The arenas a paid room can be made of now ([] when the chain cannot be read and never was). */
  private async tiers(): Promise<PaidArena[]> {
    if (!this.cur.paidRooms) return [];
    try {
      return await this.d.rooms.paidArenas();
    } catch {
      return [];
    }
  }

  /* ------------------------------ views ------------------------------ */

  private summary(r: CustomRecord): CustomRoomSummary {
    const c = r.config;
    return {
      durationMin: c.durationMin,
      mapSize: c.mapSize,
      bots: c.bots,
      difficulty: c.difficulty,
      food: c.food,
      traps: c.traps ?? 'normal',
      powerUps: c.powerUps,
      ...(c.kind === 'paid' && c.arenaId !== null ? { kind: 'paid' as const, arenaId: c.arenaId } : { kind: 'free' as const }),
      creator: r.creator,
      createdAt: r.createdAt,
      endsAt: r.endsAt,
    };
  }

  view(r: CustomRecord): CustomRoomView {
    const room = this.d.rooms.get(`priv-${r.code}`);
    return {
      ...this.summary(r),
      code: r.code,
      name: r.config.name,
      maxPlayers: r.config.maxPlayers,
      players: room?.humanCount ?? 0,
      best: r.best.slice(0, BEST_KEPT),
      paidWith: r.paidWith,
      txHash: r.txHash,
      feeWei: r.paidWei,
      ...(r.closing ? { closing: true } : {}),
    };
  }

  get(code: string): CustomRoomView | null {
    const r = this.records.get(code);
    return r ? this.view(r) : null;
  }

  list(): CustomRoomView[] {
    return [...this.records.values()].sort((a, b) => a.endsAt - b.endsAt).map((r) => this.view(r));
  }

  mine(wallet: string): CustomRoomView[] {
    const w = wallet.toLowerCase();
    return this.list().filter((r) => r.creator.toLowerCase() === w);
  }

  get live(): number {
    return this.records.size;
  }

  private freeAvailable(wallet: string): boolean {
    return this.cur.holderPerk === 'free_daily' && this.freeUsed[wallet.toLowerCase()] !== utcDay(this.now());
  }

  async quote(wallet: string | null): Promise<CustomRoomQuote> {
    const holder = wallet ? await this.d.isHolder(wallet).catch(() => false) : false;
    const free = !!wallet && holder && this.freeAvailable(wallet);
    const price = this.priceWei();
    const treasury = this.treasury();
    const tiers: CustomArenaTier[] = (await this.tiers()).map((a) => ({ arenaId: a.arenaId, entryFee: a.buyIn, holdersOnly: a.holdersOnly }));
    return {
      enabled: this.cur.enabled && !!treasury,
      priceWei: price.toString(),
      youPayWei: customRoomPrice(price, this.cur, holder, free).toString(),
      capacityStepPct: this.cur.capacityStepPct,
      maxPlayers: this.cur.maxPlayers,
      seatsLeft: Math.max(0, this.cur.maxSeats - this.seatsUsed()),
      paidRooms: this.cur.paidRooms && tiers.length > 0,
      tiers,
      treasury,
      holderPerk: this.cur.holderPerk,
      holderDiscountPct: this.cur.holderDiscountPct,
      holder,
      freeAvailable: free,
      live: this.live,
      maxLive: this.cur.maxLive,
      mine: wallet ? this.mine(wallet).length : 0,
      maxPerWallet: this.cur.maxPerWallet,
      chainId: this.d.chainId(),
    };
  }

  /* ------------------------------ create ------------------------------ */

  private checkCaps(wallet: string, extra: number, capacity: number): void {
    if (this.live + extra > this.cur.maxLive) {
      throw new CustomRoomFail(503, 'slots_busy', 'All room slots are busy right now. Try again in a few minutes, when a room closes.');
    }
    if (this.mine(wallet).length >= this.cur.maxPerWallet) {
      throw new CustomRoomFail(409, 'wallet_limit', `You already have ${this.cur.maxPerWallet} rooms open. Close one or wait for it to end.`);
    }
    const left = this.cur.maxSeats - this.seatsUsed();
    if (capacity > left) {
      throw new CustomRoomFail(
        503,
        'seats_busy',
        left >= CUSTOM_LIMITS.playersMin
          ? `The server has room for ${left} more players in custom rooms right now. Pick a smaller room or try again later.`
          : 'The custom rooms are full right now. Try again in a few minutes, when a room closes.',
        'maxPlayers',
      );
    }
  }

  /**
   * A paid room's arena: open on chain, allowed here, not kept closed by the vault guard; a
   * holders-only arena for an emblem holder only. Throws `CustomRoomFail`.
   */
  private async paidArena(arenaId: number, holder: boolean): Promise<PaidArena> {
    if (!this.cur.paidRooms) throw new CustomRoomFail(503, 'paid_closed', 'Paid rooms are closed right now. Free rooms are open.', 'kind');
    let list: PaidArena[];
    try {
      list = await this.d.rooms.paidArenas();
    } catch (err) {
      if (err instanceof ChainBusyError) throw new CustomRoomFail(503, 'chain_busy', 'The network is busy. Try again in a moment.');
      throw err;
    }
    const a = list.find((x) => x.arenaId === arenaId);
    if (!a) throw new CustomRoomFail(400, 'bad_request', 'That arena tier is not open right now. Pick another one.', 'arenaId');
    if (a.holdersOnly && !holder) throw new CustomRoomFail(403, 'holders_only', 'That arena tier is for Elymum emblem holders.', 'arenaId');
    return a;
  }

  /**
   * When a room made at `now` closes. A paid room ends on an arena bell (at or after its duration):
   * its tickets are settled there, so it never closes in the middle of a round.
   */
  private endsAt(c: CustomRoomConfig, now: number): number {
    const end = now + c.durationMin * 60_000;
    return c.kind === 'paid' ? this.d.rooms.roundWindow(end - 1).endsAt : end;
  }

  /** A paid room `code` takes new seats now (it exists, has time left and is not closing). */
  seatable(code: string): boolean {
    const r = this.records.get(code);
    return !!r && r.config.kind === 'paid' && !r.closing && r.endsAt > this.now();
  }

  /**
   * Creates a room for a signed-in `wallet` (`POST /api/rooms/custom {config, txHash}`). The price
   * (after the holder perk) must be paid with a native transfer to the treasury, checked on chain;
   * a free room needs no transaction. Throws `CustomRoomFail`.
   */
  async create(wallet: string, body: Record<string, unknown>): Promise<CustomRoomView> {
    if (!this.cur.enabled) throw new CustomRoomFail(503, 'rooms_closed', 'Creating rooms is closed right now.');
    const treasury = this.treasury();
    if (!treasury) throw new CustomRoomFail(503, 'rooms_closed', 'Creating rooms is not set up on this server yet.');
    const v = validateCustomConfig(body.config);
    if (!v.ok) throw new CustomRoomFail(400, 'bad_request', v.message, v.field);
    const config = v.config;
    const capacity = config.maxPlayers;
    if (capacity > this.cur.maxPlayers) {
      throw new CustomRoomFail(400, 'bad_request', `Rooms on this server hold at most ${this.cur.maxPlayers} players.`, 'maxPlayers');
    }
    if (config.kind === 'paid' && !this.cur.paidRooms) throw new CustomRoomFail(503, 'paid_closed', 'Paid rooms are closed right now. Free rooms are open.', 'kind');
    const w = wallet.toLowerCase();
    if (this.creating.has(w)) throw new CustomRoomFail(409, 'bad_request', 'Your room is being created. Wait a moment.');
    this.checkCaps(wallet, 1, capacity);
    this.creating.add(w);
    let claimed: string | null = null;
    try {
      const holder = await this.d.isHolder(wallet).catch(() => false);
      // a paid room's arena is checked before any payment is looked at (a refused tier never claims a hash)
      const arena = config.kind === 'paid' && config.arenaId !== null ? await this.paidArena(config.arenaId, holder) : null;
      const free = holder && this.freeAvailable(wallet);
      // the fee grows with the capacity; the server computes it, whatever the client showed
      const price = customRoomPrice(this.feeWei(capacity), this.cur, holder, free, capacity);
      let txHash: string | null = null;
      if (price > 0n) {
        const hash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
        if (!hash) throw new CustomRoomFail(402, 'payment_required', 'Pay the room fee first.', 'txHash');
        if (!TX_HASH_RE.test(hash)) throw new CustomRoomFail(400, 'payment_invalid', 'That is not a transaction hash.', 'txHash');
        if (this.d.used.has(hash)) throw new CustomRoomFail(409, 'payment_used', 'This payment already opened a room.', 'txHash');
        if (!this.d.used.claim(hash)) throw new CustomRoomFail(409, 'payment_pending', 'This payment is being checked. Wait a moment.', 'txHash');
        claimed = hash;
        const reader = this.d.reader();
        if (!reader) throw new CustomRoomFail(503, 'rooms_closed', 'Paid rooms need the chain, which is off on this server.');
        let res;
        try {
          res = await checkPayment(reader, this.d.used, { hash, from: wallet, to: treasury, minWei: price, now: this.now() });
        } catch (err) {
          if (err instanceof PaymentChainBusy) throw new CustomRoomFail(503, 'chain_busy', 'The network is busy. Your payment is safe: try again in a moment.', 'txHash');
          throw err;
        }
        if (!res.ok) throw new CustomRoomFail(res.code === 'payment_pending' ? 409 : 400, res.code, res.message, 'txHash');
        txHash = hash;
      }
      // the awaits above let other rooms open meanwhile: a paid hash stays unused when the slots filled up
      try {
        this.checkCaps(wallet, 1, capacity);
      } catch (err) {
        if (err instanceof CustomRoomFail && txHash) throw new CustomRoomFail(err.status, err.code, `${err.message} Your payment is kept: open the room with it later.`, undefined, true);
        throw err;
      }
      const now = this.now();
      const code = this.d.rooms.newPrivateCode();
      const rec: CustomRecord = {
        code,
        config,
        creator: getAddress(w),
        createdAt: now,
        endsAt: this.endsAt(config, now),
        paidWith: txHash ? 'paid' : 'free',
        txHash,
        paidWei: price.toString(),
        best: [],
        ...(arena ? { buyIn: arena.buyIn } : {}),
      };
      // the hash is used for good before the room opens (a crash between the two loses the room, never doubles it)
      if (txHash) this.d.used.markUsed(txHash, { at: now, wallet: rec.creator, code });
      claimed = null;
      if (!txHash && customUsesFreeRoom(this.cur, holder, free, capacity)) this.freeUsed[w] = utcDay(now);
      this.records.set(code, rec);
      this.open(rec);
      this.saveRooms();
      this.log(
        `custom rooms: ${code} "${rec.config.name}" opened by ${rec.creator} (${rec.paidWith}${txHash ? ` ${txHash}` : ''}, ${rec.config.durationMin} min, ` +
          `${capacity} players, ${arena ? `paid on arena #${arena.arenaId}` : 'free'})`,
      );
      return this.view(rec);
    } finally {
      if (claimed) this.d.used.release(claimed);
      this.creating.delete(w);
    }
  }

  /* ------------------------------ close / expire ------------------------------ */

  /** Closes a room early: its creator (`by` = creator wallet) or an admin. */
  close(code: string, by: { wallet: string; admin: boolean }): CustomRoomView {
    const r = this.records.get(code);
    if (!r) throw new CustomRoomFail(404, 'not_found', 'No open room with that code.');
    const creator = r.creator.toLowerCase() === by.wallet.toLowerCase();
    if (!creator && !by.admin) throw new CustomRoomFail(403, 'forbidden', 'Only the room creator can close it.');
    const message = creator ? 'The room creator closed this room.' : 'An admin closed this room.';
    if (r.config.kind === 'paid') {
      // tickets are never evicted: no new seat now, the room closes once its bell settled them
      if (!r.closing) {
        r.closing = true;
        this.saveRooms();
        this.d.rooms.get(`priv-${r.code}`)?.announce(`${message} It closes at the bell: every ticket is settled there.`);
      }
      this.finishPaid(r, message);
      this.log(`custom rooms: ${code} closing early (at its bell) by ${by.wallet}${creator ? ' (creator)' : ' (admin)'}`);
      return this.view(r);
    }
    const view = this.view(r);
    this.shut(r, message);
    this.log(`custom rooms: ${code} closed early by ${by.wallet}${creator ? ' (creator)' : ' (admin)'}`);
    return view;
  }

  private shut(r: CustomRecord, message: string): void {
    this.records.delete(r.code);
    this.d.rooms.closeCustomRoom(r.code, message);
    this.saveRooms();
  }

  /** A closing paid room: gone once nothing of value is left in it (its bell settled every ticket). */
  private finishPaid(r: CustomRecord, message: string): void {
    if (this.d.rooms.closePaidRoom(r.code, message) !== 'closed') return;
    this.records.delete(r.code);
    this.saveRooms();
    this.log(`custom rooms: ${r.code} closed (every ticket settled)`);
  }

  /** Closes rooms whose time ran out; says "1 minute left" before. Called from the tick loop. */
  sweep(now = this.now()): void {
    for (const r of [...this.records.values()]) {
      if (r.config.kind === 'paid' && (r.closing || r.endsAt <= now)) {
        if (!r.closing) {
          r.closing = true;
          this.saveRooms();
          this.log(`custom rooms: ${r.code} expired (closes once its bell settled every ticket)`);
        }
        this.finishPaid(r, 'Time is up: this room has closed. Thanks for playing!');
        continue;
      }
      if (r.endsAt <= now) {
        this.shut(r, 'Time is up: this room has closed. Thanks for playing!');
        this.log(`custom rooms: ${r.code} expired`);
        continue;
      }
      if (!r.warned && r.endsAt - now <= CUSTOM_WARN_MS) {
        r.warned = true;
        this.d.rooms.get(`priv-${r.code}`)?.announce(r.config.kind === 'paid' ? '1 minute left: this room closes at the bell.' : '1 minute left in this room!');
        this.bestDirty = true;
      }
    }
    if (this.bestDirty && now - this.lastBestFlush >= BEST_FLUSH_MS) this.saveRooms();
  }

  /** A game ended in a custom room: its own leaderboard keeps the best 10 games. */
  onGame(room: RoomHandle, e: { name: string; score: number; kills: number }): void {
    const code = room.opts.code;
    const r = code ? this.records.get(code) : undefined;
    if (!r || e.score <= 0) return;
    r.best.push({ name: e.name, score: e.score, kills: e.kills, at: this.now() });
    r.best.sort((a, b) => b.score - a.score || a.at - b.at);
    r.best.length = Math.min(r.best.length, BEST_KEPT);
    this.bestDirty = true;
  }
}
