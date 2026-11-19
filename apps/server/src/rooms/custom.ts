import type { EmblemClaims } from '../site/emblem-claims';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CUSTOM_CAPACITY_TIER,
  CUSTOM_HOLDER_PERKS,
  CUSTOM_LIMITS,
  CUSTOM_MAP_SIZES,
  CUSTOM_MAP_WIDTH,
  CUSTOM_PAYMENT_MAX_AGE_MS,
  CUSTOM_REQUEST_RE,
  CUSTOM_SETTINGS_DEFAULT,
  CUSTOM_SETTINGS_LIMITS,
  CUSTOM_TRAP_MUL,
  CUSTOM_WORLD_CAPS,
  PRACTICE_ROOM,
  ROOM_CLOSE_COUNTDOWN_MS,
  WORLD_PRESETS,
  customRoomBaseRaw,
  customRoomCost,
  customRoomFee,
  customRoomPaymentRef,
  customUsesFreeRoom,
  parseToken,
  practiceRoomConfig,
  validateCustomConfig,
  type CustomArenaTier,
  type CustomBest,
  type CustomMapSize,
  type CustomPayClosed,
  type CustomRoomAdminView,
  type CustomRoomConfig,
  type CustomRoomError,
  type CustomRoomQuote,
  type CustomRoomSettings,
  type CustomRoomSummary,
  type CustomRoomView,
} from '@coinnibal/shared';
import { getAddress } from 'viem';
import type { PracticeBotsOptions } from '../bots/practice';
import { TX_HASH_RE, type UsedPayments } from '../chain/payment';
import { ChainBusyError, type ChainGateway, type TokenReceipt } from '../chain/types';
import { ClientBudgetError } from '../net/client-scope';
import { verifyPurchase, type PurchaseCheck } from '../shop/verify';
import type { CustomRoomHooks, PaidArena, RoomManager } from './manager';
import type { RoomHandle } from './handle';
import type { WorldShape } from './room';

/** A refusal of the custom room API: HTTP status, code and a friendly message. */
/**
 * A holder check of a room's creation that failed reads as "not a holder" (a free room or a discount is not given),
 * except a busy one (`ClientBudgetError`: past this client's holder reads, the holder index cannot tell right now): that
 * is passed on, so the creator hears "try again in a moment" instead of a price a holder would not pay. (A quote is
 * only shown: never busy.)
 */
const holderUnknown = (err: unknown): false => {
  if (err instanceof ClientBudgetError) throw err;
  return false;
};

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
  /** Raw base units of the game token paid (decimal string; "0" for a free room). */
  paidRaw?: string;
  /** Rooms opened before 2026-11-18 (paid in ETH): wei paid (decimal string). Such a room has no `paidRaw`. */
  paidWei?: string;
  best: CustomBest[];
  /** The "1 minute left" line was said. */
  warned?: boolean;
  /** Paid rooms: the arena's ticket price when the room was made (ledger units; the instance's `stake.buyIn`). */
  buyIn?: number;
  /**
   * Paid rooms: time is up or it was closed early. No new seat; the room closes once its own bell (at `endsAt`, the
   * room's end) settled every ticket in it (`RoomManager.closePaidRoom`), then this record goes.
   */
  closing?: boolean;
  /** Closed early by its creator or an admin: the reason everyone sees in the countdown and on the final board. */
  closeMessage?: string;
  /** A "Practice with bots" room: who opened it (`w:<wallet>` or `ip:<address>`; one live room each). */
  practice?: { owner: string };
}

/** What everyone in a room reads when its time is up (the countdown, then the final board). */
const TIME_UP = 'Time is up: this room has closed. Thanks for playing!';
const TIME_UP_PAID = 'Time is up: every ticket in this room is settled now, at its end. Thanks for playing!';

interface RoomsFile {
  v: 1;
  rooms: CustomRecord[];
  /** Holder wallet (lower case) → UTC day (YYYY-MM-DD) of its last free room. */
  freeUsed: Record<string, string>;
}

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

/**
 * Practice bots of a config: exactly `bots` of them, at the chosen difficulty, in a FREE room only. A paid room
 * (stakes) never has bots, whatever an old saved record says.
 */
export function customBots(c: CustomRoomConfig): PracticeBotsOptions | null {
  if (c.kind === 'paid' || c.bots <= 0) return null;
  return { count: c.bots, difficulty: c.difficulty };
}

const BEST_KEPT = 10;
const BEST_FLUSH_MS = 10_000;
/** The room says "1 minute left" this long before it closes. */
export const CUSTOM_WARN_MS = 60_000;
/** A quoted room price is accepted this long (the wallet prompts, a slow block, a token price change), like the shop's. */
export const CUSTOM_QUOTE_VALID_MS = 15 * 60_000;

/** What a room creator reads when a fee would be due but the game token is not set on the arena yet. */
const TOKEN_NOT_SET = 'Private rooms are paid in tokens, and the game token is not live yet. Practice with bots is free.';

/** A refused payment (the shop's receipt check) in the room API's codes and words. */
const PAY_REFUSAL: Record<Exclude<PurchaseCheck, { ok: true }>['code'], { code: CustomRoomError; message: string }> = {
  tx_pending: { code: 'payment_pending', message: 'The payment is not confirmed yet. Try again in a few seconds.' },
  tx_failed: { code: 'payment_invalid', message: 'The payment transaction failed on chain.' },
  no_payment: { code: 'payment_invalid', message: 'That transaction is not a payment to the Coinnibal arena.' },
  wrong_recipient: { code: 'payment_invalid', message: 'The payment did not go to the Coinnibal arena contract.' },
  wrong_sender: { code: 'payment_invalid', message: 'The payment was sent from another wallet. Pay from the wallet you signed in with.' },
  wrong_pack: { code: 'payment_invalid', message: 'That payment was made for something else, not for this room.' },
  wrong_amount: { code: 'payment_low', message: 'The payment is less than the room price.' },
  wrong_token: { code: 'payment_invalid', message: 'That transaction did not move the game token.' },
  tx_stale: { code: 'payment_stale', message: 'This payment is too old to open a room.' },
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
/** The creator of a guest's "Practice with bots" room. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Fields of the settings files written while rooms were paid in ETH (before 2026-11-18): read and ignored (the fee is
 * paid in the game token to the arena contract now, whose fee wallet takes the half that is not burned). An admin
 * update that still sends one is refused with the reason.
 */
const RETIRED_KEYS: Record<string, string> = {
  priceGas: 'priceGas is retired: private rooms are paid in the game token now (set usdCents or priceTokens)',
  treasury: 'treasury is retired: room fees are paid to the arena contract (half burned, half to its fee wallet)',
};

/** A base price in whole tokens: a decimal string above 0 and at most `CUSTOM_SETTINGS_LIMITS.priceTokens`, at most 6 decimals. */
function tokenPrice(x: unknown, field: string, bad: (field: string, message: string) => CustomRoomFail): string {
  if (typeof x !== 'string' || !/^\d{1,10}(\.\d{1,6})?$/.test(x)) throw bad(field, `${field} must be a token amount like "1500" or "12.5"`);
  const raw = parseToken(x, 6);
  if (raw <= 0n || raw > BigInt(CUSTOM_SETTINGS_LIMITS.priceTokens) * 10n ** 6n) throw bad(field, `${field} must be above 0 and at most ${CUSTOM_SETTINGS_LIMITS.priceTokens}`);
  return x;
}

/** Validates an admin update of the settings; returns the merged settings. */
export function applyCustomSettings(cur: CustomRoomSettings, body: Record<string, unknown>, strict = true): CustomRoomSettings {
  const next = { ...cur };
  for (const k of Object.keys(RETIRED_KEYS)) delete (next as Record<string, unknown>)[k];
  const bad = (field: string, message: string) => new CustomRoomFail(400, 'bad_request', message, field);
  const keys: (keyof CustomRoomSettings)[] = ['enabled', 'priceIn', 'usdCents', 'priceTokens', 'holderPerk', 'holderDiscountPct', 'maxLive', 'maxPerWallet', 'capacityStepPct', 'maxPlayers', 'maxSeats', 'paidRooms', 'practiceRooms', 'practiceMaxLive'];
  if (strict) {
    for (const k of Object.keys(body)) {
      if (k in RETIRED_KEYS) throw bad(k, RETIRED_KEYS[k]);
      if (!keys.includes(k as keyof CustomRoomSettings)) throw bad(k, `unknown field ${k}`);
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw bad('enabled', 'enabled must be true or false');
    next.enabled = body.enabled;
  }
  if (body.paidRooms !== undefined) {
    if (typeof body.paidRooms !== 'boolean') throw bad('paidRooms', 'paidRooms must be true or false');
    next.paidRooms = body.paidRooms;
  }
  if (body.practiceRooms !== undefined) {
    if (typeof body.practiceRooms !== 'boolean') throw bad('practiceRooms', 'practiceRooms must be true or false');
    next.practiceRooms = body.practiceRooms;
  }
  if (body.priceIn !== undefined) {
    if (body.priceIn !== 'usd' && body.priceIn !== 'token') throw bad('priceIn', 'priceIn must be "usd" or "token"');
    next.priceIn = body.priceIn;
  }
  if (body.priceTokens !== undefined) next.priceTokens = tokenPrice(body.priceTokens, 'priceTokens', bad);
  if (body.holderPerk !== undefined) {
    if (!(CUSTOM_HOLDER_PERKS as readonly unknown[]).includes(body.holderPerk)) throw bad('holderPerk', `holderPerk must be one of ${CUSTOM_HOLDER_PERKS.join(', ')}`);
    next.holderPerk = body.holderPerk as CustomRoomSettings['holderPerk'];
  }
  const int = (v: unknown, field: string, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(field, `${field} must be a whole number from ${min} to ${max}`);
    return v;
  };
  if (body.usdCents !== undefined) next.usdCents = int(body.usdCents, 'usdCents', 1, CUSTOM_SETTINGS_LIMITS.usdCents);
  if (body.holderDiscountPct !== undefined) next.holderDiscountPct = int(body.holderDiscountPct, 'holderDiscountPct', 0, 100);
  if (body.maxLive !== undefined) next.maxLive = int(body.maxLive, 'maxLive', 0, CUSTOM_SETTINGS_LIMITS.maxLive);
  if (body.maxPerWallet !== undefined) next.maxPerWallet = int(body.maxPerWallet, 'maxPerWallet', 1, CUSTOM_SETTINGS_LIMITS.maxPerWallet);
  if (body.capacityStepPct !== undefined) next.capacityStepPct = int(body.capacityStepPct, 'capacityStepPct', 0, CUSTOM_SETTINGS_LIMITS.capacityStepPct);
  if (body.maxPlayers !== undefined) next.maxPlayers = int(body.maxPlayers, 'maxPlayers', CUSTOM_LIMITS.playersMin, CUSTOM_SETTINGS_LIMITS.maxPlayers);
  if (body.maxSeats !== undefined) next.maxSeats = int(body.maxSeats, 'maxSeats', CUSTOM_SETTINGS_LIMITS.maxSeatsMin, CUSTOM_SETTINGS_LIMITS.maxSeats);
  if (body.practiceMaxLive !== undefined) next.practiceMaxLive = int(body.practiceMaxLive, 'practiceMaxLive', 0, CUSTOM_SETTINGS_LIMITS.practiceMaxLive);
  if (next.maxSeats < next.maxPlayers) throw bad('maxSeats', `maxSeats (${next.maxSeats}) must be at least the biggest room (maxPlayers ${next.maxPlayers})`);
  return next;
}

export interface CustomRoomDeps {
  rooms: RoomManager;
  /** `DATA_DIR` (settings and rooms under `site/`); null: memory only. */
  dataDir: string | null;
  /** File-name suffix (`.dev-fake` on the fake chain, so dev rooms never mix with real ones). */
  suffix?: string;
  /** Used payments of the server's chain (hashes and wallet requests; persisted per chain). */
  used: UsedPayments;
  /**
   * The server's chain: its status names the game token and the arena contract fees are paid to (`CoinnibalArena.pay`),
   * and `tokenReceipt` reads a payment's `Paid` event. The same reads as the power-up shop.
   */
  chain: Pick<ChainGateway, 'enabled' | 'status' | 'tokenReceipt'>;
  /**
   * The token's USD price and the significant figures of the arenas' sync (`ArenaPriceStore`: Game → Arena prices): a
   * fee priced in dollars (`priceIn: 'usd'`) is converted with them. Null / absent: the token price applies.
   */
  usdPrice?: () => Promise<{ price: bigint; usdPerToken: string; sigFigs: number } | null>;
  /** Waits before re-reading a receipt that is not visible yet (default 0, 1.5 s, 3 s). */
  receiptRetryMs?: readonly number[];
  /**
   * Whether a wallet holds a Coinnibal NFT (cached by the mint service), for a room's creation: past the client's
   * holder reads the holder index answers, `ClientBudgetError` only while it cannot tell.
   */
  isHolder: (wallet: string) => Promise<boolean>;
  /** The same for a quote, only shown: the answer on record, never a chain read of its own (default: `isHolder`, false on error). */
  shownHolder?: (wallet: string) => Promise<boolean>;
  /** The emblem token ids a wallet owns (null: unknown); with `claims` the free daily room is one per token id a day. */
  emblemTokens?: (wallet: string, fresh?: boolean) => Promise<string[] | null>;
  claims?: EmblemClaims;
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
  /** Rooms whose end countdown was shown (`closing`). */
  private readonly counting = new Set<string>();
  /** "Practice with bots" rooms standing empty since (service clock). */
  private readonly emptySince = new Map<string, number>();
  private bestDirty = false;
  private lastBestFlush = 0;
  /** Base prices quoted lately and until when each is accepted (a token price that moved between the quote and the payment). */
  private readonly quoted: { raw: bigint; until: number }[] = [];
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: CustomRoomDeps) {
    // the rooms' own clock by default: a paid room's own game (`ownRound`) is timed on the clock its room plays by
    this.now = d.now ?? (() => d.rooms.now());
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
      // a file from the rooms paid in ETH: its ETH price and treasury are dropped, the room fee is the token default
      // (the dollar value the old ETH default stood for) until the admin sets one; the next save leaves them out
      if (raw.priceGas !== undefined || raw.treasury !== undefined) {
        this.log(`custom rooms: the ETH price${raw.priceGas !== undefined ? ` (${String(raw.priceGas)})` : ''} and the treasury are retired: rooms are paid in the game token now (50 % burned, 50 % to the fee wallet)`);
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
    // only today's free rooms matter (a UTC day): older days are dropped so the file does not grow forever
    const today = utcDay(this.now());
    for (const [w, day] of Object.entries(this.freeUsed)) if (day !== today) delete this.freeUsed[w];
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
      world: customWorld(r.config),
      // "Auto": the private rooms' curve, sized for the bots plus the people in the room
      ...(r.config.mapSize === 'auto' ? { map: { scale: this.d.rooms.customMapScale(), shape: (side: number) => customWorld(r.config, side), config: r.config } } : {}),
      powerUps: r.config.powerUps,
      custom: this.summary(r),
    };
    if (r.config.kind === 'paid' && r.config.arenaId !== null) {
      // an invite-only instance of the arena (its tickets, its vault) on its OWN clock: one game from the room's
      // opening to its end, where every ticket is settled; never the arenas' 5-minute bell
      return this.d.rooms.createPaidRoom(r.code, { ...opts, stake: { arenaId: r.config.arenaId, buyIn: r.buyIn ?? 0 }, ownRound: { startsAt: r.createdAt, endsAt: r.endsAt } });
    }
    return this.d.rooms.createCustomRoom(r.code, { ...opts, bots: customBots(r.config) });
  }

  /* ------------------------------ settings ------------------------------ */

  get settings(): CustomRoomSettings {
    return { ...this.cur };
  }

  /** `GET /api/admin/custom-rooms`: the settings, where fees are paid, the base price now and the live rooms. */
  async adminView(): Promise<CustomRoomAdminView> {
    const target = this.payTarget();
    const base = await this.basePrice();
    return {
      settings: this.settings,
      pay: target.ok ? { token: target.token, payTo: target.arena, burnBps: target.burnBps } : null,
      ...(target.ok ? {} : { payClosed: target.reason }),
      base: {
        raw: base.raw.toString(),
        decimals: this.decimals(),
        ...(base.usdCents !== null ? { usdCents: base.usdCents } : {}),
        ...(base.usdPerToken ? { usdPerToken: base.usdPerToken } : {}),
        ...(base.sigFigs !== null ? { sigFigs: base.sigFigs } : {}),
      },
      rooms: this.list(),
    };
  }

  updateSettings(body: Record<string, unknown>): CustomRoomSettings {
    this.cur = applyCustomSettings(this.cur, body);
    this.write(this.file('custom-rooms-settings'), this.cur);
    return this.settings;
  }

  /**
   * Where a room fee is paid: the game token and the arena contract (`CoinnibalArena.pay`: `paymentBurnBps` burned, the
   * rest to its fee wallet), or why it cannot be paid now (no chain, no token set on the arena yet, no arena).
   */
  payTarget(): { ok: true; token: { address: string; symbol: string; decimals: number }; arena: string; burnBps: number | null } | { ok: false; reason: CustomPayClosed } {
    if (!this.d.chain.enabled || !this.d.chain.tokenReceipt) return { ok: false, reason: 'no_chain' };
    const st = this.d.chain.status();
    if (!st.tokenReady || !st.token) return { ok: false, reason: 'no_token' };
    if (!st.arenaAddress) return { ok: false, reason: 'no_arena' };
    return { ok: true, token: st.token, arena: st.arenaAddress, burnBps: st.fees?.paymentBurnBps ?? null };
  }

  /** The token's decimals (18 until the token is set, like the shop). */
  private decimals(): number {
    const t = this.payTarget();
    return t.ok ? t.token.decimals : (this.d.chain.status().token?.decimals ?? 18);
  }

  /**
   * The base price now (rooms of up to 10 players), raw base units: dollars converted at the arenas' token price and
   * rounding, else the token price (`customRoomBaseRaw`).
   */
  async basePrice(): Promise<{ raw: bigint; usdCents: number | null; usdPerToken: string | null; sigFigs: number | null }> {
    const usd = (await this.d.usdPrice?.().catch(() => null)) ?? null;
    const b = customRoomBaseRaw(this.cur, this.decimals(), usd);
    return { ...b, usdPerToken: usd?.usdPerToken ?? null, sigFigs: usd?.sigFigs ?? null };
  }

  /** The fee of a room of `capacity` before any holder perk (`customRoomFee`), raw base units, at the base price now. */
  async feeRaw(capacity: number): Promise<bigint> {
    return customRoomFee((await this.basePrice()).raw, capacity, this.cur.capacityStepPct);
  }

  private remember(raw: bigint): void {
    const now = this.now();
    for (let i = this.quoted.length - 1; i >= 0; i--) if (this.quoted[i].until <= now) this.quoted.splice(i, 1);
    const q = this.quoted.find((x) => x.raw === raw);
    if (q) q.until = now + CUSTOM_QUOTE_VALID_MS;
    else this.quoted.push({ raw, until: now + CUSTOM_QUOTE_VALID_MS });
    if (this.quoted.length > 12) this.quoted.splice(0, this.quoted.length - 12);
  }

  /** The lowest base price the server stands by now: the current one, or one it quoted in the last `CUSTOM_QUOTE_VALID_MS`. */
  private async acceptedBase(): Promise<bigint> {
    const now = (await this.basePrice()).raw;
    let low = now;
    for (const q of this.quoted) if (q.until > this.now() && q.raw < low) low = q.raw;
    return low;
  }

  /** Seats taken by the live custom rooms (Σ capacity; "Practice with bots" rooms have their own cap). */
  seatsUsed(): number {
    let n = 0;
    for (const r of this.records.values()) if (!r.practice) n += r.config.maxPlayers;
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
      bots: customBots(c)?.count ?? 0,
      difficulty: c.difficulty,
      food: c.food,
      traps: c.traps ?? 'normal',
      powerUps: c.powerUps,
      ...(c.kind === 'paid' && c.arenaId !== null ? { kind: 'paid' as const, arenaId: c.arenaId } : { kind: 'free' as const }),
      ...(r.practice ? { practice: true } : {}),
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
      // a room opened before rooms were paid in tokens shows its ETH fee as such
      ...(r.paidRaw === undefined && r.paidWei !== undefined ? { feeRaw: r.paidWei, feeIn: 'gas' as const } : { feeRaw: r.paidRaw ?? '0', feeIn: 'token' as const }),
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

  /** A wallet's live rooms (its "Practice with bots" room is not among them: it has its own limit). */
  mine(wallet: string): CustomRoomView[] {
    const w = wallet.toLowerCase();
    return this.list().filter((r) => !r.practice && r.creator.toLowerCase() === w);
  }

  /** Live custom rooms (the paid and free ones creators opened; "Practice with bots" rooms apart). */
  get live(): number {
    let n = 0;
    for (const r of this.records.values()) if (!r.practice) n++;
    return n;
  }

  /** Live "Practice with bots" rooms. */
  get practiceLive(): number {
    return this.records.size - this.live;
  }

  /**
   * "Practice with bots" (`POST /api/rooms/custom/practice`): a free room with practice bots for this player (a
   * guest too), opened in one click. One live practice room per player (`wallet`, else `ip`): asking again returns
   * it while it has a few minutes left. The route rate-limits creations per IP; the admin caps how many live at
   * once (`practiceMaxLive`). Throws `CustomRoomFail`.
   */
  practice(owner: { wallet: string | null; ip: string }): CustomRoomView {
    if (!this.cur.practiceRooms) throw new CustomRoomFail(503, 'rooms_closed', 'Practice rooms are closed right now. The ponds are open.');
    const key = owner.wallet ? `w:${owner.wallet.toLowerCase()}` : `ip:${owner.ip}`;
    const now = this.now();
    for (const r of this.records.values()) {
      if (r.practice?.owner === key && !r.closeMessage && r.endsAt - now > 3 * 60_000 && this.d.rooms.get(`priv-${r.code}`)) return this.view(r);
    }
    if (this.practiceLive >= this.cur.practiceMaxLive) {
      throw new CustomRoomFail(503, 'slots_busy', 'All practice rooms are busy right now. Try again in a few minutes, or play in a pond.');
    }
    const config = practiceRoomConfig();
    const rec: CustomRecord = {
      code: this.d.rooms.newPrivateCode(),
      config,
      // a guest's room has no creator wallet
      creator: owner.wallet ? getAddress(owner.wallet.toLowerCase()) : ZERO_ADDRESS,
      createdAt: now,
      endsAt: now + config.durationMin * 60_000,
      paidWith: 'free',
      txHash: null,
      paidRaw: '0',
      best: [],
      practice: { owner: key },
    };
    this.records.set(rec.code, rec);
    this.open(rec);
    this.saveRooms();
    this.log(`custom rooms: ${rec.code} practice with bots opened for ${owner.wallet ?? 'a guest'} (${config.bots} bots, ${config.durationMin} min)`);
    return this.view(rec);
  }

  /**
   * The holder's free room of the day (`free_daily`): one room of the base size per UTC day per wallet, recorded in
   * `custom-rooms.json` (`freeUsed`) in the same write that stores the room, so a restart never hands out a second
   * one. A new UTC day (00:00 UTC) makes it available again.
   */
  private freeAvailable(wallet: string, tokens: string[] | null = null): boolean {
    if (this.cur.holderPerk !== 'free_daily' || this.freeUsed[wallet.toLowerCase()] === utcDay(this.now())) return false;
    // one free room a day per emblem token id: a passed-on emblem does not open a free room for every wallet
    return !this.d.claims || !tokens || tokens.length === 0 || this.d.claims.daily('room', wallet, tokens) !== null;
  }

  /** The wallet's emblem token ids (null: unknown or no index). */
  private async tokensOf(wallet: string, fresh: boolean): Promise<string[] | null> {
    return this.d.claims && this.d.emblemTokens ? this.d.emblemTokens(wallet, fresh).catch(() => null) : null;
  }

  async quote(wallet: string | null): Promise<CustomRoomQuote> {
    // a quote is only shown: never busy, and it spends none of the holder reads a room's creation may need (a holder
    // not on record yet is quoted the full price, not kept); the creation checks again
    const holder = wallet ? await (this.d.shownHolder ?? ((w: string) => this.d.isHolder(w)))(wallet).catch(() => false) : false;
    const free = !!wallet && holder && this.freeAvailable(wallet, await this.tokensOf(wallet, false));
    const base = await this.basePrice();
    const target = this.payTarget();
    // the price shown is the price accepted (for `CUSTOM_QUOTE_VALID_MS`), whatever the token price does meanwhile
    if (target.ok) this.remember(base.raw);
    const tiers: CustomArenaTier[] = (await this.tiers()).map((a) => ({ arenaId: a.arenaId, entryFee: a.buyIn, holdersOnly: a.holdersOnly }));
    return {
      enabled: this.cur.enabled,
      pay: target.ok ? { token: target.token, payTo: target.arena, burnBps: target.burnBps } : null,
      ...(target.ok ? {} : { payClosed: target.reason }),
      priceRaw: base.raw.toString(),
      youPayRaw: customRoomCost(base.raw, this.cur, holder, free, CUSTOM_CAPACITY_TIER).toString(),
      ...(base.usdCents !== null ? { usdCents: base.usdCents } : {}),
      ...(base.usdPerToken ? { usdPerToken: base.usdPerToken } : {}),
      capacityStepPct: this.cur.capacityStepPct,
      maxPlayers: this.cur.maxPlayers,
      seatsLeft: Math.max(0, this.cur.maxSeats - this.seatsUsed()),
      paidRooms: this.cur.paidRooms && tiers.length > 0,
      tiers,
      holderPerk: this.cur.holderPerk,
      holderDiscountPct: this.cur.holderDiscountPct,
      holder,
      freeAvailable: free,
      live: this.live,
      maxLive: this.cur.maxLive,
      mine: wallet ? this.mine(wallet).length : 0,
      maxPerWallet: this.cur.maxPerWallet,
      chainId: this.d.chain.status().chainId,
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
    if (!this.cur.paidRooms) throw new CustomRoomFail(503, 'paid_closed', 'Ticket rooms are closed right now. Free rooms are open.', 'kind');
    let list: PaidArena[];
    try {
      list = await this.d.rooms.paidArenas();
    } catch (err) {
      if (err instanceof ChainBusyError) throw new CustomRoomFail(503, 'chain_busy', 'The network is busy. Try again in a moment.');
      throw err;
    }
    const a = list.find((x) => x.arenaId === arenaId);
    if (!a) throw new CustomRoomFail(400, 'bad_request', 'That arena tier is not open right now. Pick another one.', 'arenaId');
    if (a.holdersOnly && !holder) throw new CustomRoomFail(403, 'holders_only', 'That arena tier is for Coinnibal NFT holders.', 'arenaId');
    return a;
  }

  /**
   * When a room made at `now` closes: exactly its duration later, free or paid. A paid room runs on its own clock (one
   * game, `RoomOptions.ownRound`): its one bell is this end, where every ticket in it is settled. Nothing ties it to
   * the arenas' rounds.
   */
  private endsAt(c: CustomRoomConfig, now: number): number {
    return now + c.durationMin * 60_000;
  }

  /** A paid room `code` takes new seats now (it exists, has time left and is not closing). */
  seatable(code: string): boolean {
    const r = this.records.get(code);
    return !!r && r.config.kind === 'paid' && !r.closing && r.endsAt > this.now();
  }

  /**
   * Reads a payment's receipt (its token transfers and the arena's `Paid` events), looking again a few times while the
   * RPC does not see it yet. Throws `CustomRoomFail` (`chain_busy`) when the chain cannot be read: the payment is safe.
   */
  private async receipt(hash: string): Promise<TokenReceipt | null> {
    let receipt: TokenReceipt | null = null;
    for (const wait of this.d.receiptRetryMs ?? [0, 1_500, 3_000]) {
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait).unref?.());
      try {
        receipt = (await this.d.chain.tokenReceipt?.(hash)) ?? null;
      } catch (err) {
        if (err instanceof ChainBusyError) throw new CustomRoomFail(503, 'chain_busy', 'The network is busy. Your payment is safe: try again in a moment.', 'txHash');
        throw err;
      }
      if (receipt) break;
    }
    return receipt;
  }

  /**
   * Creates a room for a signed-in `wallet` (`POST /api/rooms/custom {config, txHash?, request?}`). The price (the fee
   * by capacity after the holder perk, `customRoomCost`, the function the quote uses) must be paid in the game token
   * with `CoinnibalArena.pay(amount, customRoomPaymentRef(request))` from this wallet: the shop's check of the receipt
   * (mined and succeeded, the arena's `Paid` event for this wallet with this ref, the token moved, at most
   * `CUSTOM_PAYMENT_MAX_AGE_MS` old) with an amount of at least the price quoted, and a hash and a wallet's request open
   * one room each (`UsedPayments`, on disk before the room opens). A free room (the holders' room of the day, a 100 %
   * discount) needs no transaction. A room that costs something cannot open before the game token is set on the arena
   * (`token_not_set`). The same payment sent again by its wallet (an answer that got lost) gets its room back. Throws
   * `CustomRoomFail`.
   */
  async create(wallet: string, body: Record<string, unknown>): Promise<CustomRoomView> {
    const hashIn = typeof body.txHash === 'string' ? body.txHash.trim() : '';
    if (hashIn && TX_HASH_RE.test(hashIn)) {
      const done = this.d.used.get(hashIn);
      const r = done && done.wallet.toLowerCase() === wallet.toLowerCase() ? this.records.get(done.code) : undefined;
      if (r && !r.closing && !r.closeMessage) return this.view(r);
    }
    if (!this.cur.enabled) throw new CustomRoomFail(503, 'rooms_closed', 'Creating rooms is closed right now.');
    const v = validateCustomConfig(body.config);
    if (!v.ok) throw new CustomRoomFail(400, 'bad_request', v.message, v.field);
    const config = v.config;
    const capacity = config.maxPlayers;
    if (capacity > this.cur.maxPlayers) {
      throw new CustomRoomFail(400, 'bad_request', `Rooms on this server hold at most ${this.cur.maxPlayers} players.`, 'maxPlayers');
    }
    if (config.kind === 'paid' && !this.cur.paidRooms) throw new CustomRoomFail(503, 'paid_closed', 'Ticket rooms are closed right now. Free rooms are open.', 'kind');
    const w = wallet.toLowerCase();
    if (this.creating.has(w)) throw new CustomRoomFail(409, 'bad_request', 'Your room is being created. Wait a moment.');
    this.checkCaps(wallet, 1, capacity);
    this.creating.add(w);
    let claimed: string | null = null;
    try {
      const holder = await this.d.isHolder(wallet).catch(holderUnknown);
      // a paid room's arena is checked before any payment is looked at (a refused tier never claims a hash)
      const arena = config.kind === 'paid' && config.arenaId !== null ? await this.paidArena(config.arenaId, holder) : null;
      const tokens = holder ? await this.tokensOf(wallet, true) : null;
      const free = holder && this.freeAvailable(wallet, tokens);
      // the fee grows with the capacity; the server computes it (at the lowest price it quoted lately), whatever the
      // client showed
      const price = customRoomCost(await this.acceptedBase(), this.cur, holder, free, capacity);
      let txHash: string | null = null;
      let request: string | null = null;
      let paid = 0n;
      if (price > 0n) {
        const target = this.payTarget();
        if (!target.ok) {
          if (target.reason === 'no_token') throw new CustomRoomFail(503, 'token_not_set', TOKEN_NOT_SET);
          throw new CustomRoomFail(503, 'rooms_closed', 'Private rooms with a fee need the chain and the arena, which are not set up on this server.');
        }
        const hash = hashIn;
        if (!hash) throw new CustomRoomFail(402, 'payment_required', 'Pay the room fee first.', 'txHash');
        if (!TX_HASH_RE.test(hash)) throw new CustomRoomFail(400, 'payment_invalid', 'That is not a transaction hash.', 'txHash');
        const req = typeof body.request === 'string' ? body.request : '';
        if (!CUSTOM_REQUEST_RE.test(req)) throw new CustomRoomFail(400, 'payment_invalid', 'The payment names no room request. Open the room from the room sheet.', 'request');
        if (this.d.used.has(hash)) throw new CustomRoomFail(409, 'payment_used', 'This payment already opened a room.', 'txHash');
        if (this.d.used.hasRequest(wallet, req)) throw new CustomRoomFail(409, 'payment_used', 'This room request was paid and opened a room already.', 'request');
        if (!this.d.used.claim(hash)) throw new CustomRoomFail(409, 'payment_pending', 'This payment is being checked. Wait a moment.', 'txHash');
        claimed = hash;
        const check = verifyPurchase(await this.receipt(hash), {
          token: target.token.address,
          from: wallet,
          arena: target.arena,
          ref: customRoomPaymentRef(req),
          amounts: { minAmount: price },
          now: this.now(),
          maxAgeMs: CUSTOM_PAYMENT_MAX_AGE_MS,
        });
        if (!check.ok) {
          const r = PAY_REFUSAL[check.code];
          throw new CustomRoomFail(r.code === 'payment_pending' ? 409 : 400, r.code, r.message, 'txHash');
        }
        txHash = hash;
        request = req;
        paid = check.paid;
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
        paidRaw: paid.toString(),
        best: [],
        ...(arena ? { buyIn: arena.buyIn } : {}),
      };
      // the hash and the request are used for good before the room opens (a crash between the two loses the room,
      // never doubles it)
      if (txHash && request) this.d.used.markUsed(txHash, { at: now, wallet: rec.creator, code, request, paid: paid.toString() });
      claimed = null;
      if (!txHash && customUsesFreeRoom(this.cur, holder, free, capacity)) {
        this.freeUsed[w] = utcDay(now);
        if (tokens && tokens.length > 0) this.d.claims?.daily('room', wallet, tokens, true);
      }
      this.records.set(code, rec);
      this.open(rec);
      this.saveRooms();
      this.log(
        `custom rooms: ${code} "${rec.config.name}" opened by ${rec.creator} (${rec.paidWith}${txHash ? ` ${paid} raw tokens, ${txHash}` : ''}, ${rec.config.durationMin} min, ` +
          `${capacity} players, ${arena ? `paid on arena #${arena.arenaId}` : 'free'})`,
      );
      return this.view(rec);
    } finally {
      if (claimed) this.d.used.release(claimed);
      this.creating.delete(w);
    }
  }

  /* ------------------------------ close / expire ------------------------------ */

  /**
   * Closes a room early: its creator (`by` = creator wallet) or an admin. Never abruptly: the room ends
   * `ROOM_CLOSE_COUNTDOWN_MS` from now (the countdown, then the final board). A paid room takes no new seat from now
   * and its own bell moves to that end: every ticket in it is settled there (`Room.closingSoon`).
   */
  close(code: string, by: { wallet: string; admin: boolean }): CustomRoomView {
    const r = this.records.get(code);
    if (!r) throw new CustomRoomFail(404, 'not_found', 'No open room with that code.');
    const creator = r.creator.toLowerCase() === by.wallet.toLowerCase();
    if (!creator && !by.admin) throw new CustomRoomFail(403, 'forbidden', 'Only the room creator can close it.');
    const message = creator ? 'The room creator closed this room.' : 'An admin closed this room.';
    const now = this.now();
    if (r.config.kind === 'paid') {
      // tickets are never evicted: no new seat now, its own bell moves to the countdown's end and settles them all
      if (!r.closing) {
        r.closing = true;
        r.closeMessage = `${message} Every ticket is settled at its end.`;
        r.endsAt = Math.max(now, Math.min(r.endsAt, now + ROOM_CLOSE_COUNTDOWN_MS));
        this.saveRooms();
        this.d.rooms.get(`priv-${r.code}`)?.announce(r.closeMessage);
        this.sweep(now);
      } else this.finishPaid(r, message);
      this.log(`custom rooms: ${code} closing early (in ${Math.round((r.endsAt - now) / 1000)} s) by ${by.wallet}${creator ? ' (creator)' : ' (admin)'}`);
      return this.records.has(code) ? this.view(r) : { ...this.view(r), closing: true };
    }
    if (!r.closeMessage) {
      r.closeMessage = message;
      r.endsAt = Math.min(r.endsAt, now + ROOM_CLOSE_COUNTDOWN_MS);
      this.saveRooms();
      this.sweep(now);
    }
    this.log(`custom rooms: ${code} closing early (in ${Math.round((r.endsAt - now) / 1000)} s) by ${by.wallet}${creator ? ' (creator)' : ' (admin)'}`);
    return this.view(r);
  }

  private shut(r: CustomRecord, message: string): void {
    this.records.delete(r.code);
    this.counting.delete(r.code);
    this.emptySince.delete(r.code);
    this.d.rooms.closeCustomRoom(r.code, message);
    this.saveRooms();
  }

  /** A closing paid room: gone once nothing of value is left in it (its bell settled every ticket). */
  private finishPaid(r: CustomRecord, message: string): void {
    if (this.d.rooms.closePaidRoom(r.code, message) !== 'closed') return;
    this.records.delete(r.code);
    this.counting.delete(r.code);
    this.saveRooms();
    this.log(`custom rooms: ${r.code} closed (every ticket settled)`);
  }

  /**
   * Closes rooms whose time ran out; says "1 minute left" before, and shows everyone the countdown
   * `ROOM_CLOSE_COUNTDOWN_MS` before the end (`closing`). Called from the tick loop.
   */
  sweep(now = this.now()): void {
    for (const r of [...this.records.values()]) {
      const paid = r.config.kind === 'paid';
      // a practice room nobody is in closes (quietly: nobody to tell) once it stood empty a while
      if (r.practice) {
        const room = this.d.rooms.get(`priv-${r.code}`);
        if (room && (room.humanCount > 0 || room.connCount > 0)) this.emptySince.delete(r.code);
        else if (!this.emptySince.has(r.code)) this.emptySince.set(r.code, now);
        else if (now - this.emptySince.get(r.code)! >= PRACTICE_ROOM.idleMs) {
          this.shut(r, TIME_UP);
          this.log(`custom rooms: ${r.code} practice room closed (empty)`);
          continue;
        }
      }
      if (r.endsAt > now && r.endsAt - now <= ROOM_CLOSE_COUNTDOWN_MS && !this.counting.has(r.code)) {
        this.counting.add(r.code);
        this.d.rooms.get(`priv-${r.code}`)?.closingSoon(r.endsAt, r.closeMessage ?? (paid ? TIME_UP_PAID : TIME_UP));
      }
      if (paid && (r.closing || r.endsAt <= now)) {
        if (!r.closing) {
          r.closing = true;
          this.saveRooms();
          this.log(`custom rooms: ${r.code} expired (its own bell settles every ticket, then it closes)`);
        }
        this.finishPaid(r, r.closeMessage ?? TIME_UP);
        continue;
      }
      if (r.endsAt <= now) {
        this.shut(r, r.closeMessage ?? TIME_UP);
        this.log(`custom rooms: ${r.code} ${r.closeMessage ? 'closed early' : 'expired'}`);
        continue;
      }
      if (!r.warned && r.endsAt - now <= CUSTOM_WARN_MS) {
        r.warned = true;
        this.d.rooms.get(`priv-${r.code}`)?.announce(r.config.kind === 'paid' ? '1 minute left: joins are closed, every ticket is settled when the room ends.' : '1 minute left in this room!');
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
