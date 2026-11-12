import {
  BinaryWriter,
  ClientOp,
  EMOTES,
  FINAL_BOARD_ROWS,
  SHARE_BOARD_ROWS,
  FINAL_STANDINGS_ROWS,
  MAP_GROW,
  MAP_SPACE,
  PlayerFlag,
  RULES,
  STANDINGS_MAX_ROWS,
  clamp,
  profitFee,
  VIEW,
  WORLD_PRESETS,
  boostDurationMs,
  isBoostKind,
  mapSideFor,
  ownRoundAt,
  sanitizeChat,
  testArenasAllowedOn,
  viewSize,
  worldForSide,
  writeSnapshot,
  xpForGame,
  type ClientInput,
  type MapScaleSettings,
  type OwnRound,
  type RoundWindow,
  type WorldShape,
  type CustomRoomConfig,
  type CustomRoomSummary,
  type DeathStats,
  type FeeRates,
  type LbEntry,
  type League,
  type RoomInfo,
  type RoomMode,
  type RoundInfo,
  type RoundStanding,
  type ServerMessage,
  type StandingRow,
} from '@elymum/shared';
import { PracticeBots, type PracticeBotsOptions } from '../bots/practice';
import type { ChainGateway } from '../chain/types';
import { looksLikeScam, maskProfanity } from '../chat-filter';
import type { Player } from '../game/entities';
import { mulberry32 } from '../game/rng';
import { World, type CellEatenEvent } from '../game/world';
import type { IntegrityService } from '../integrity/service';
import type { ShopService, UseContext } from '../shop/service';
import type { Leaderboards } from '../leaderboards';
import type { RoomConn as Conn, RoomHandle } from './handle';
import { sweepKey, type Journal, type JournalItem, type LiveStake, type SettleReason, type SettlementItem } from '../stake/journal';
import { EatenTracker } from './eaten';
import { ArenaLedger, type ArenaEntry } from '../stake/ledger';
import { RoundClock } from './round-clock';

/** Stake players are force-cashed-out long before the on-chain 24 h refund window opens. */
export const MAX_STAKE_SESSION_AGE_S = 6 * 3600;
/** Arena rooms sample threats for the integrity telemetry every this many ticks. */
const INTEGRITY_SAMPLE_TICKS = 2;
/** While live values or loot changed, the journal is rewritten at most this often. */
const JOURNAL_SNAPSHOT_MS = 1000;
const SLEEP_AFTER_MS = 60_000;
const CHAT_HISTORY = 20;

/** What a room writes to the journal (the main thread's `Journal`; a room worker forwards it there). */
export type RoomJournal = Pick<Journal, 'commit' | 'adoptLoot' | 'pending'>;
/** The integrity hooks a room calls (`IntegrityService`; a room worker runs the monitor itself). */
export type RoomIntegrity = Pick<IntegrityService, 'monitor' | 'join' | 'settle'>;

export interface RoomDeps {
  chain: Pick<ChainGateway, 'kick'>;
  journal: RoomJournal;
  leaderboards: Pick<Leaderboards, 'submit' | 'countryGame'> & Partial<Pick<Leaderboards, 'roundOver'>>;
  log: (msg: string) => void;
  /** Wall clock (Unix ms) the arena rounds run on; defaults to `Date.now`. Tests inject their own. */
  now?: () => number;
  /**
   * The chain's clock (Unix ms; the chain gateway's `chainNow`): ticket ages (the `MAX_STAKE_SESSION_AGE_S` cap) are
   * measured with it, since a ticket's `openedAt` is a block timestamp. Defaults to `Date.now`.
   */
  chainNow?: () => number;
  /**
   * Arena round clock: the play, the join close before the bell and the break added after it (defaults
   * `RULES.roundMs` / `RULES.roundJoinCloseMs` / `RULES.roundBreakMs`).
   */
  round?: { roundMs: number; closeMs: number; breakMs?: number };
  /**
   * The shared round clock (the room manager passes its own, so the gateway and every room
   * agree on the round). Without it the room builds one from `now` and `round`.
   */
  clock?: RoundClock;
  /**
   * A human's game ended (death, leave, round end or operator exit). `dead`: it ended in a death. `standings`: a room's
   * end, the top of its final board (`SHARE_BOARD_ROWS`) with the player's own row (the result card's standings picture).
   */
  onGameOver?: (e: { room: Room; conn: Conn | null; player: Player; stats: DeathStats; dead?: boolean; standings?: RoundStanding[] }) => void;
  /**
   * The bell settled the ticket of a staker who was away (AFK, not connected). When they come
   * back the gateway tells them the round ended (`round_ended`) instead of "already playing".
   */
  onBellSettled?: (e: BellSettled) => void;
  /** Cheat and collusion telemetry of the arena tickets (and the optional auto-hold of payouts). */
  integrity?: RoomIntegrity;
  /** Bought power-ups (charges, cooldowns, the arena cap); absent: the `boost` message is ignored. */
  shop?: Pick<ShopService, 'state' | 'use'>;
  /**
   * A person ate a person (the killer may share it: every person eaten offers "Share on X"); in a testnet test arena
   * a practice bot counts too (`victimIsBot`).
   */
  onNotableKill?: (e: { room: Room; conn: Conn; killer: Player; victim: string; victimMass: number; victimIsBot?: boolean; victimX?: string | null }) => void;
}

/** An AFK staker's ticket settled at a round's bell (see `RoomDeps.onBellSettled`). */
export interface BellSettled {
  arenaId: number;
  wallet: string;
  /** Session key `<arenaId>:<player lowercase>:<sessionId>` (the settlement's journal key). */
  session: string;
  /** On-chain session id (global, never reused). */
  sessionId: number;
  round: number;
}

/** What a joining player brings besides name and skin. */
export interface JoinOptions {
  name: string;
  skin: number;
  flags: number;
  /** The wallet's profile picture (`isAvatarId`), worn on the coin; null / absent: none. */
  avatar?: string | null;
  /** The country the player plays for (`isCountryCode`, the gateway checked it); null / absent: no flag. */
  country?: string | null;
  /** The X handle the wallet linked (`isXHandle`, the gateway read it from the server's store); null / absent: none. */
  xHandle?: string | null;
  /** Arena ticket. */
  stake?: Omit<ArenaEntry, 'pid'>;
}

export interface RoomOptions {
  id: string;
  mode: RoomMode;
  name: string;
  maxPlayers: number;
  code?: string;
  /** Practice rooms: the league this room serves. */
  league?: League;
  /** Arena rooms: instance (shard) number within the arena, from 1. */
  instance?: number;
  /**
   * Practice bots: only a FREE custom room (`mode: 'private'` with `custom`, no `stake`) and a test arena (`test`,
   * on a testnet chain) may have them; the constructor refuses them anywhere else. Null / absent / a count of 0: no
   * bots.
   */
  bots?: PracticeBotsOptions | null;
  /**
   * A test arena (testnet only, `test-arenas.ts` in shared): an arena instance on the official arena's tickets and
   * vault, with practice bots. `chainId` is the server's chain: the constructor refuses a test arena on any chain
   * but a testnet (`testArenasAllowedOn`). Its games stay off every official board.
   */
  test?: { chainId: number };
  /** Paid rooms: the arena whose tickets play here and its entry fee (ledger units). */
  stake?: { arenaId: number; buyIn: number };
  /**
   * A paid custom room's own clock (`OwnRound`): ONE game from the room's opening to its end, its only bell, where
   * every ticket in it is settled. No tie to the official arenas' 5-minute rounds (no bell every 5 minutes, no
   * break, no re-pay). Absent: the arenas' shared round clock. An early close moves `endsAt` forward (`closingSoon`).
   */
  ownRound?: OwnRound;
  seed?: number;
  /** The world size and population (default `WORLD_PRESETS[mode]`; custom rooms bring their own). */
  world?: WorldShape;
  /**
   * Dynamic map size (`map-scale.ts`): with it the world is resizable (it sits centred in
   * `MAP_SPACE`) and, while `auto` is on, sized for the expected player count; with `auto` off it
   * keeps `world` (the preset). Absent: a fixed world (custom rooms with a chosen size).
   */
  map?: RoomMapOptions;
  /** Power-up airdrops (default on). */
  powerUps?: boolean;
  /**
   * Custom rooms (a paid private room with its own rules): shown to clients as `RoomInfo.custom`.
   * Their games stay off the global leaderboards (the rules differ); the room keeps its own.
   */
  custom?: CustomRoomSummary;
}

export type { WorldShape };

/** How a resizable room sizes its world. */
export interface RoomMapOptions {
  scale: MapScaleSettings;
  /** The population of a world of `side` (default `worldForSide(side)`; custom rooms apply their food and traps choices). */
  shape?: (side: number) => WorldShape;
  /**
   * A custom room's config: `shape` is `customWorld(config, side)`. A function does not cross to a
   * room worker, so a worker rebuilds `shape` from this.
   */
  config?: CustomRoomConfig;
}

/**
 * Rooms without rounds shrink only over empty floor: no human cell within this of the band that
 * goes, and only once the target is this far below the current side (a person or two coming and
 * going does not move the wall back and forth).
 */
const SHRINK_CLEARANCE = 300;
const SHRINK_HYSTERESIS = 200;

interface ChatLine {
  pid: number;
  from: string;
  skin: number;
  text: string;
  system?: boolean;
}

type FinishCause = 'death' | 'left' | 'round' | 'maxage' | 'kicked';

export class Room implements RoomHandle {
  readonly world: World;
  readonly bots: PracticeBots | null;
  readonly ledger: ArenaLedger | null;
  readonly conns = new Set<Conn>();
  /** Living human players → their connection (null while AFK in a stake room). */
  readonly humans = new Map<number, Conn | null>();
  private readonly afkSince = new Map<number, number>();
  /** Arena rooms: value each staker lost this game (`valueLost` / `lootSpilled` in the death stats). */
  private readonly losses = new Map<number, { lost: number; spilled: number }>();
  private readonly walletOf = new Map<number, string>();
  /** Human players wearing a profile picture → its id (bots never have one). */
  readonly avatarOf = new Map<number, string>();
  private readonly chatLog: ChatLine[] = [];
  private readonly writer = new BinaryWriter(32 * 1024);
  private lastLbAt = 0;
  private lastJournalAt = 0;
  /** Arena rooms: live values or loot changed since the last journal write. */
  private journalDirty = false;
  private lastAgeCheckAt = 0;
  /** Arena rooms: the round this room is playing (its end triggers `endRound`). */
  private roundN = 0;
  private roundEndsAt = Infinity;
  private readonly clock: RoundClock;
  /** Arena rooms only: the integrity telemetry (null elsewhere and when not configured). */
  private readonly integrity: RoomIntegrity | null;
  private tickN = 0;
  lastActivity = Date.now();
  /** Dynamic map (null: a fixed world). */
  private map: RoomMapOptions | null;
  private readonly preset: WorldShape;
  /** World clock (ms) of the next growth check and of the last resize. */
  private nextMapCheckAt = 0;
  private lastResizeAt = -Infinity;
  /** The coins each person ate this game (`DeathStats.eaten`); bots count in test arenas only. */
  private readonly eaten: EatenTracker;
  /** Test arenas: stake cells eaten by a bot (their value spilled as floor loot, never to the bot). */
  readonly botSpills = { n: 0, value: 0 };
  /** A custom room's coming end (`closingSoon`): told to everyone who joins or watches meanwhile. */
  private closing: { endsAt: number; message: string } | null = null;
  /** A room on its own clock (`RoomOptions.ownRound`) rang its one bell. */
  private ownBellRung = false;

  constructor(
    readonly opts: RoomOptions,
    private readonly deps: RoomDeps,
  ) {
    const preset = opts.world ?? WORLD_PRESETS[opts.mode];
    this.preset = { ...preset };
    this.map = opts.map ? { ...opts.map, scale: { ...opts.map.scale } } : null;
    const seed = opts.seed ?? (Math.random() * 2 ** 32) >>> 0;
    const botCount = opts.bots?.count ?? 0;
    // a test arena is an arena instance of the official tickets, on a testnet only (never the mainnet)
    if (opts.test && (opts.mode !== 'arena' || !opts.stake || opts.custom || opts.code || !testArenasAllowedOn(opts.test.chainId))) {
      throw new Error(`room ${opts.id}: test arenas are only allowed as arena instances on a testnet (chain ${opts.test.chainId})`);
    }
    // bots are for free practice and the testnet's test arenas only: never in any other room with stakes, never in a public room
    const freeCustom = opts.mode === 'private' && !opts.stake && !!opts.custom;
    if (botCount > 0 && !freeCustom && !opts.test) throw new Error(`room ${opts.id}: bots are only allowed in free custom rooms and testnet test arenas`);
    // a resizable room opens at the size its bots alone call for (the first joins grow it)
    const first = this.map ? this.shapeFor(this.wantedSide(0, botCount)) : preset;
    this.world = new World({ ...first, powerUps: opts.powerUps ?? true, coinRain: opts.mode !== 'arena', seed, ...(this.map ? { space: MAP_SPACE } : {}) });
    this.bots = botCount > 0 && opts.bots ? new PracticeBots(this.world, opts.bots, mulberry32(seed ^ 0xb07)) : null;
    this.ledger = opts.mode === 'arena' ? new ArenaLedger() : null;
    this.eaten = new EatenTracker(!!opts.test);
    this.clock = deps.clock ?? new RoundClock(deps.now, deps.round);
    this.integrity = this.ledger ? (deps.integrity ?? null) : null;
    // loot left on any of this arena's instances when the server last stopped: the first instance adopts it all
    if (this.ledger && opts.stake && (opts.instance ?? 1) === 1) {
      const loot = deps.journal.adoptLoot(opts.stake.arenaId, this.id);
      this.world.restoreLoot(loot);
      // restored loot is value a ticket of this round may pick up: it counts in the round's pool
      this.roundPool = loot.reduce((s, l) => s + l.value, 0);
    }
    if (opts.ownRound && (!this.ledger || !opts.code || !opts.custom)) throw new Error(`room ${opts.id}: an own round clock is for paid custom rooms only`);
    if (this.ledger) {
      const r = this.window();
      this.roundN = r.n;
      this.roundEndsAt = r.endsAt;
    }
  }

  /**
   * The round window this room plays: its own game (a paid custom room, `ownRound`) or the arenas' shared round at
   * `now`.
   */
  private window(now = this.now()): RoundWindow {
    const own = this.opts.ownRound;
    return own ? ownRoundAt(own, this.clock.cfg.closeMs) : this.clock.window(now);
  }

  /** The wall clock rounds run on (Unix ms). */
  now(): number {
    return this.clock.now();
  }

  /** Arena rooms: the round in play now (undefined elsewhere). */
  round(now = this.now()): RoundInfo | undefined {
    if (!this.ledger) return undefined;
    const r = this.window(now);
    if (this.opts.ownRound) return { n: r.n, endsAt: r.endsAt, joinsCloseAt: r.joinsCloseAt, startsAt: r.startsAt };
    return { n: r.n, endsAt: r.endsAt, joinsCloseAt: r.joinsCloseAt, ...(r.opensAt > r.startsAt ? { opensAt: r.opensAt } : {}) };
  }

  /** Arena rooms: the break after a bell (joins not open yet). A room on its own clock has none. */
  inBreak(now = this.now()): boolean {
    return !!this.ledger && now < this.window(now).opensAt;
  }

  /**
   * Arena rooms: rings the bell of the round in play when the clock has passed its end. Runs at
   * the start of every tick and before a player is added (`join`, `reattach`), so a player
   * joining right as a round opens never lands in the round that is ending.
   */
  syncRound(now = this.now()): void {
    if (!this.ledger) return;
    const own = this.opts.ownRound;
    if (own) {
      // its own game: one bell at the room's end. Anything of value still here after it (a join that raced the bell)
      // is settled at the next tick the same way: nothing waits for a next round, there is none
      if (now < own.endsAt) return;
      if (this.ownBellRung && this.ledger.size === 0 && this.world.loot().length === 0) return;
      this.ownBellRung = true;
      this.roundEndsAt = own.endsAt;
      this.endRound(this.roundN);
      this.roundPool = 0;
      return;
    }
    if (now < this.roundEndsAt) return;
    const ended = this.roundN;
    const r = this.clock.window(now);
    this.roundN = r.n;
    this.roundEndsAt = r.endsAt;
    this.endRound(ended);
    // every ticket of that round was settled at its bell: the next round's pool starts from nothing
    this.roundPool = this.ledger.all().reduce((s, e) => s + e.entryFee, 0);
  }

  /**
   * Σ entry fees of the tickets seated in this instance during the round in play, plus loot restored into it (ledger
   * units): no ticket can be worth more than that (value only moves between this round's tickets here). Each
   * settlement carries it; the chain worker's payout guard holds a payout above it.
   */
  private roundPool = 0;

  get id(): string {
    return this.opts.id;
  }

  info(): RoomInfo {
    return {
      id: this.opts.id,
      mode: this.opts.mode,
      name: this.opts.name,
      width: this.world.cfg.width,
      height: this.world.cfg.height,
      ...(this.world.x0 !== 0 || this.world.y0 !== 0 ? { x0: this.world.x0, y0: this.world.y0 } : {}),
      players: this.humans.size,
      bots: this.bots?.size ?? 0,
      maxPlayers: this.opts.maxPlayers,
      league: this.opts.league,
      arenaId: this.opts.stake?.arenaId,
      entryFee: this.opts.stake?.buyIn,
      instance: this.opts.stake ? (this.opts.instance ?? 1) : undefined,
      loot: this.ledger ? this.lootValue() : undefined,
      code: this.opts.code,
      round: this.round(),
      ...(this.opts.custom ? { custom: this.opts.custom } : {}),
      ...(this.opts.test ? { test: true as const } : {}),
    };
  }

  /** Games here stay off the global boards: custom rooms (their own rules and board) and test arenas (bots). */
  private get offBoard(): boolean {
    return !!this.opts.custom || !!this.opts.test;
  }

  /** A test arena's new bot settings (the admin's, applied live). Ignored in any other room. */
  setBots(count: number, difficulty: PracticeBotsOptions['difficulty']): void {
    if (!this.opts.test || !this.bots) return;
    for (const pid of this.bots.reconfigure(count, difficulty)) for (const c of this.conns) c.view.forgetPlayer(pid);
  }

  setBuyIn(buyIn: number): void {
    if (this.opts.stake && Number.isSafeInteger(buyIn) && buyIn > 0) this.opts.stake.buyIn = buyIn;
  }

  /** Σ value of the loot lying on this room's floor. */
  lootValue(): number {
    let sum = 0;
    for (const l of this.world.loot()) sum += l.value;
    return sum;
  }

  get isFull(): boolean {
    return this.humans.size >= this.opts.maxPlayers;
  }

  get humanCount(): number {
    return this.humans.size;
  }

  get connCount(): number {
    return this.conns.size;
  }

  lootCount(): number {
    return this.world.loot().length;
  }

  mapSide(): number {
    return this.world.cfg.width;
  }

  /** Stake sessions currently represented in this room. */
  liveSessions(): string[] {
    return this.ledger ? this.ledger.all().map((e) => e.session) : [];
  }

  findStakeByWallet(wallet: string): ArenaEntry | undefined {
    return this.ledger?.all().find((e) => e.player === wallet);
  }

  private broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const c of this.conns) c.sendText(json);
  }

  private attach(conn: Conn): void {
    if (conn.room !== this) {
      conn.room?.detach(conn);
      conn.view.reset();
      conn.room = this;
      this.conns.add(conn);
    }
    this.lastActivity = Date.now();
  }

  /**
   * The client clears its world mirror on every `joined` / `spectating` (and on a new socket), so
   * the server forgets what it sent: the next snapshot carries everything in view again. Without
   * this the two sides drift apart whenever only one of them starts over (lobby → another room,
   * a reconnect into the same room): entities the client still holds were never removed and stood
   * there as frozen, uneatable ghosts.
   */
  private freshView(conn: Conn): void {
    conn.view.reset();
  }

  /** Removes a connection from this room without touching its player. */
  detach(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.room === this) conn.room = null;
    conn.view.reset();
  }

  /* ---------------------------------------------------------------- */
  /* Joining / leaving                                                */
  /* ---------------------------------------------------------------- */

  join(conn: Conn, opts: JoinOptions): Player {
    this.syncRound();
    this.attach(conn);
    // `joined` starts the client's world mirror afresh: the view starts afresh with it (see `freshView`)
    this.freshView(conn);
    const player = this.world.addPlayer({ name: opts.name, skin: opts.skin, flags: opts.flags, country: opts.country ?? null, xHandle: opts.xHandle ?? null, mass: RULES.startMass });
    this.humans.set(player.id, conn);
    conn.player = player;
    conn.spectating = false;
    conn.spectatePid = null;
    conn.lastName = opts.name;
    conn.lastSkin = opts.skin;
    if (conn.wallet) this.walletOf.set(player.id, conn.wallet);
    if (opts.avatar) this.avatarOf.set(player.id, opts.avatar);
    else this.avatarOf.delete(player.id);
    if (this.ledger && opts.stake) {
      this.ledger.join({ ...opts.stake, pid: player.id });
      this.roundPool += opts.stake.entryFee;
      this.integrity?.join(this, player.id, conn, opts.stake);
      this.commitJournal();
    }
    conn.send({
      t: 'joined',
      room: this.info(),
      playerId: player.id,
      name: player.name,
      skin: player.skin,
      value: this.ledger?.value(player.id),
      // the ticket's own price (the arena's may have changed since it was bought)
      entryFee: this.ledger ? (this.ledger.get(player.id)?.entryFee ?? this.entryFee) : undefined,
      session: this.ledger?.get(player.id)?.session,
      round: this.round(),
    });
    conn.send({ t: 'history', chat: this.chatLog });
    if (this.closing) conn.send({ t: 'closing', ...this.closing });
    this.sendBoosts(conn);
    return player;
  }

  /**
   * The wallet's picture was removed (or replaced): its coins here go back to the basic skin. The
   * player info changes, so every viewer gets it again on the next snapshot.
   */
  clearAvatar(wallet: string): number {
    let n = 0;
    const w = wallet.toLowerCase();
    for (const pid of [...this.avatarOf.keys()]) {
      if (this.walletOf.get(pid)?.toLowerCase() !== w) continue;
      this.avatarOf.delete(pid);
      n++;
    }
    return n;
  }

  /** A stake player reconnected: give them their AFK cells back. */
  reattach(conn: Conn, pid: number): boolean {
    this.syncRound();
    const p = this.world.players.get(pid);
    if (!p || !p.alive || !this.humans.has(pid) || this.humans.get(pid)) return false;
    this.attach(conn);
    this.freshView(conn);
    this.humans.set(pid, conn);
    this.afkSince.delete(pid);
    p.afk = false;
    this.integrity?.monitor.onAfk(this.id, pid, false, this.now());
    conn.player = p;
    conn.spectating = false;
    conn.lastName = p.name;
    conn.lastSkin = p.skin;
    conn.send({
      t: 'joined',
      room: this.info(),
      playerId: p.id,
      name: p.name,
      skin: p.skin,
      value: this.ledger?.value(pid),
      entryFee: this.ledger ? (this.ledger.get(pid)?.entryFee ?? this.entryFee) : undefined,
      session: this.ledger?.get(pid)?.session,
      round: this.round(),
    });
    conn.send({ t: 'history', chat: this.chatLog });
    this.sendBoosts(conn);
    return true;
  }

  spectate(conn: Conn, next = false): void {
    this.attach(conn);
    if (conn.player?.alive) return;
    conn.spectating = true;
    // nobody gets to watch an invisible coin
    const ranking = this.world.ranking().filter((q) => !this.world.isInvisible(q));
    if (ranking.length === 0) conn.spectatePid = null;
    else if (next && conn.spectatePid !== null) {
      const i = ranking.findIndex((p) => p.id === conn.spectatePid);
      conn.spectatePid = ranking[(i + 1) % ranking.length].id;
    } else conn.spectatePid = ranking[0].id;
    this.freshView(conn);
    conn.send({ t: 'spectating', room: this.info(), targetPid: conn.spectatePid });
    if (this.closing) conn.send({ t: 'closing', ...this.closing });
  }

  /** A custom room closes at `endsAt` (server clock): everyone in it (and who comes meanwhile) gets the countdown. */
  closingSoon(endsAt: number, message: string): void {
    // a room on its own clock closed early: its one bell (every ticket settled) moves to the new end
    const own = this.opts.ownRound;
    if (own && !this.ownBellRung && endsAt < own.endsAt) own.endsAt = Math.max(own.startsAt, endsAt);
    this.closing = { endsAt, message };
    this.broadcast({ t: 'closing', endsAt, message });
  }

  /**
   * The connection leaves the game. Free rooms remove the player at once;
   * stake rooms leave the cells in the arena (AFK) until they are eaten or the round ends.
   */
  leave(conn: Conn, reason: 'left' | 'disconnect' | 'switch'): void {
    const p = conn.player;
    if (p && p.alive && this.humans.get(p.id) === conn) {
      if (this.ledger) this.goAfk(p);
      else this.finishHuman(p, null, 'left');
    }
    conn.player = null;
    if (reason !== 'left') this.detach(conn);
    else conn.spectating = false;
  }

  private goAfk(p: Player): void {
    this.humans.set(p.id, null);
    p.afk = true;
    this.afkSince.set(p.id, this.world.now);
    this.integrity?.monitor.onAfk(this.id, p.id, true, this.now());
    const c = p.center();
    this.world.setTarget(p.id, c.x, c.y);
  }

  /* ---------------------------------------------------------------- */
  /* Player actions                                                   */
  /* ---------------------------------------------------------------- */

  input(conn: Conn, input: ClientInput): void {
    const p = conn.player;
    if (!p || !p.alive || p.afk) return;
    this.integrity?.monitor.onInput(this.id, p, input);
    switch (input.op) {
      case ClientOp.Target:
        this.world.setTarget(p.id, input.x, input.y);
        break;
      case ClientOp.Split:
        this.world.queueSplit(p.id);
        break;
      case ClientOp.Eject:
        this.world.queueEject(p.id);
        break;
    }
  }

  chat(conn: Conn, raw: unknown): void {
    const now = Date.now();
    const from = conn.player?.name ?? conn.lastName;
    if (!from) return;
    if (now - conn.lastChatAt < 1200) {
      conn.send({ t: 'error', code: 'rate_limited', message: 'Slow down.' });
      return;
    }
    let text = sanitizeChat(raw);
    if (!text) return;
    if (looksLikeScam(text)) {
      conn.send({ t: 'error', code: 'bad_request', message: 'Links and wallet talk are not allowed in chat.' });
      return;
    }
    text = maskProfanity(text);
    conn.lastChatAt = now;
    const line: ChatLine = { pid: conn.player?.id ?? 0, from, skin: conn.player?.skin ?? conn.lastSkin, text };
    this.pushChat(line);
  }

  /** A system line in the room's chat (e.g. "1 minute left"). */
  announce(text: string): void {
    this.pushChat({ pid: 0, from: 'Elymum', skin: 1, text, system: true });
  }

  private pushChat(line: ChatLine): void {
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.broadcast({ t: 'chat', ...line });
  }

  /** The boost context of a living human (null for bots, spectators and the dead). */
  private boostContext(conn: Conn): UseContext | null {
    const p = conn.player;
    if (!p || conn.room !== this || !this.humans.has(p.id)) return null;
    return {
      wallet: this.walletOf.get(p.id) ?? null,
      isBot: p.isBot,
      arena: this.opts.mode === 'arena',
      round: this.ledger ? this.roundN : null,
      holder: (p.flags & PlayerFlag.Holder) !== 0,
    };
  }

  /** Sends the player their power-up charges, cooldowns and arena allowance. */
  sendBoosts(conn: Conn): void {
    const shop = this.deps.shop;
    const ctx = shop ? this.boostContext(conn) : null;
    if (shop && ctx) conn.send({ t: 'boosts', state: shop.state(ctx) });
  }

  /** A bought power-up key: the shop checks the rules, the world applies the effect (bots never get here). */
  boost(conn: Conn, kind: unknown): void {
    const shop = this.deps.shop;
    const p = conn.player;
    if (!shop || !isBoostKind(kind) || !p || p.afk) return;
    const ctx = this.boostContext(conn);
    if (!ctx) return;
    const res = shop.use(ctx, kind, () => this.world.useBoost(p.id, kind));
    if (res.ok) conn.send({ t: 'boost', kind, ok: true, ms: boostDurationMs(kind) });
    else conn.send({ t: 'boost', kind, ok: false, reason: res.reason });
    conn.send({ t: 'boosts', state: shop.state(ctx) });
  }

  emote(conn: Conn, id: unknown): void {
    const p = conn.player;
    const now = Date.now();
    if (!p || !p.alive || typeof id !== 'number' || !EMOTES[id] || now - conn.lastEmoteAt < 900) return;
    conn.lastEmoteAt = now;
    this.broadcast({ t: 'emote', pid: p.id, id });
  }

  /** Paid arenas have no cash-out: everyone alive is paid at the round end. Other rooms have nothing to cash out. */
  cashout(conn: Conn): void {
    if (!this.ledger) return;
    conn.send({ t: 'error', code: 'no_cashout', message: 'No cash-out in paid arenas: stay alive and you are paid your value when the round ends.' });
  }

  /* ---------------------------------------------------------------- */
  /* Game over for a human                                            */
  /* ---------------------------------------------------------------- */

  private statsFor(p: Player, alive: boolean): DeathStats {
    const aliveMs = this.world.now - p.stats.joinedAt;
    return {
      aliveMs,
      finalMass: alive ? Math.floor(p.totalMass()) : 0,
      maxMass: Math.floor(p.stats.maxMass),
      foodEaten: p.stats.foodEaten,
      cellsEaten: p.stats.cellsEaten,
      playersEaten: p.stats.playersEaten,
      bestRank: Number.isFinite(p.stats.bestRank) ? p.stats.bestRank : 0,
      xp: xpForGame(p.stats.maxMass, p.stats.playersEaten, aliveMs),
      ...(this.eaten.take(p.id) ?? {}),
    };
  }

  liveStakes(): LiveStake[] {
    if (!this.ledger) return [];
    return this.ledger.all().map((e) => {
      const p = this.world.players.get(e.pid);
      return {
        roomId: this.id,
        session: e.session,
        sessionId: e.sessionId,
        player: e.player,
        arenaId: e.arenaId,
        value: e.value,
        entryFee: e.entryFee,
        score: Math.floor(p?.stats.maxMass ?? 0),
        kills: p?.stats.playersEaten ?? 0,
      };
    });
  }

  /** Arena entry fee in ledger units (0 outside arenas). */
  get entryFee(): number {
    return this.opts.stake?.buyIn ?? 0;
  }

  /**
   * Arena rooms: writes live values and loot (plus any settlements) in one
   * atomic journal write, so Σ live + Σ loot + Σ pending never changes on disk
   * except by settlements being confirmed.
   */
  private commitJournal(enqueue?: JournalItem[]): void {
    if (!this.ledger) {
      if (enqueue && enqueue.length > 0) this.deps.journal.commit({ enqueue });
      return;
    }
    const loot = this.opts.stake
      ? { roomId: this.id, arenaId: this.opts.stake.arenaId, items: this.world.loot().map((l) => ({ x: l.x, y: l.y, value: l.value })) }
      : undefined;
    this.deps.journal.commit({ enqueue, roomId: this.id, live: this.liveStakes(), loot });
    this.journalDirty = false;
    this.lastJournalAt = Date.now();
  }

  private sendValue(pid: number, delta: number, reason: 'eat' | 'loot' | 'eaten' | 'spill'): void {
    if (delta === 0 || !this.ledger) return;
    this.humans.get(pid)?.send({ t: 'value', value: this.ledger.value(pid), delta, reason });
  }

  /**
   * Arena value rules for one eaten cell: a staker eaten by a staker hands over the eaten share of its
   * value (`ArenaLedger.transfer`). Anything without a ticket that eats a staker (nothing in a room of
   * people only; kept for safety) makes the share spill as floor loot, burned at the bell if nobody takes it.
   * A victim without a ticket carries no value.
   */
  private onCellEaten(ce: CellEatenEvent): void {
    const ledger = this.ledger;
    if (!ledger || !ledger.has(ce.victim.id)) return;
    this.journalDirty = true;
    if (ledger.has(ce.eater.id)) {
      const t = ledger.transfer(ce.victim.id, ce.eater.id, ce.mass, ce.victimTotalBefore, ce.last);
      this.integrity?.monitor.onTransfer(this, ce.victim.id, ce.eater.id, t, ledger.size - 1, ce.eater.afk);
      this.noteLoss(ce.victim.id, t, 0);
      this.sendValue(ce.eater.id, t, 'eat');
      this.sendValue(ce.victim.id, -t, 'eaten');
      return;
    }
    const t = ledger.spill(ce.victim.id, ce.mass, ce.victimTotalBefore, ce.last);
    if (t <= 0) return;
    if (ce.eater.isBot) {
      this.botSpills.n++;
      this.botSpills.value += t;
    }
    this.noteLoss(ce.victim.id, t, t);
    const pieces = clamp(Math.ceil(t / (this.entryFee * RULES.lootPieceEntryFraction)), RULES.lootPiecesMin, RULES.lootPiecesMax);
    this.world.spawnLoot(ce.x, ce.y, t, pieces);
    this.sendValue(ce.victim.id, -t, 'spill');
  }

  /** Value a staker lost this game (to eaters, and the part spilled as loot): reported on the death sheet. */
  private noteLoss(pid: number, lost: number, spilled: number): void {
    if (lost <= 0) return;
    const l = this.losses.get(pid) ?? { lost: 0, spilled: 0 };
    l.lost += lost;
    l.spilled += spilled;
    this.losses.set(pid, l);
  }

  /** Arena rooms: credits picked-up loot (put back on the floor if nobody can hold it). */
  private onLootPicked(pid: number, value: number): void {
    if (!this.ledger) return;
    this.journalDirty = true;
    if (this.ledger.credit(pid, value)) {
      this.sendValue(pid, value, 'loot');
      return;
    }
    const p = this.world.players.get(pid);
    const c = p?.center() ?? this.world.center();
    this.world.restoreLoot([{ x: c.x, y: c.y, value }]);
  }

  /**
   * Ends a human's game. With `batch`, the settlement is appended to it and nothing is written
   * (the caller commits the whole batch in one journal write) and no message is sent.
   */
  /**
   * `end`: a room's end (bell, custom room end): the player's place on the final board, in the stats the hooks get,
   * and the top of that board (`standings`, for the result card's standings picture).
   */
  private finishHuman(p: Player, conn: Conn | null, cause: FinishCause, killer: Player | null = null, batch?: JournalItem[], end?: { rank: number; of: number; standings?: RoundStanding[] }): DeathStats {
    const stillAlive = cause !== 'death';
    const stats = this.statsFor(p, stillAlive);
    if (end) {
      stats.finalRank = end.rank;
      stats.finalOf = end.of;
    }
    const wallet = this.walletOf.get(p.id) ?? null;
    const now = Date.now();
    const score = stats.maxMass;

    // custom rooms play by their own rules: they keep their own board (see `RoomManager`), not the global one;
    // test arenas play with bots: their games count on no board
    if (!this.offBoard) this.deps.leaderboards.submit({ name: p.name, score, skin: p.skin, wallet, kills: stats.playersEaten, at: now, ...(p.country ? { country: p.country } : {}) });

    const enqueue: JournalItem[] = [];
    const loss = this.losses.get(p.id);
    this.losses.delete(p.id);
    if (this.ledger?.has(p.id)) {
      const entry = this.ledger.leave(p.id)!;
      // the settlement carries the gross value; the arena contract takes the fee on the profit (`fees.ts`)
      const fee = profitFee(entry.entryFee, entry.value, entry.rates);
      stats.payout = fee.net;
      if (fee.fee > 0) {
        stats.gross = fee.payout;
        stats.cut = fee.fee;
      }
      if (cause === 'death') {
        // the death sheet's "value lost" / "spilled as loot" lines (DeathStats)
        stats.valueLost = loss?.lost ?? 0;
        stats.lootSpilled = loss?.spilled ?? 0;
      }
      // arena humans never `leave` (they go AFK); an operator exit settles at value like a kick
      const reason: SettleReason = cause === 'left' ? 'kicked' : cause;
      const item = settlementOf(entry, { score, kills: stats.playersEaten, xp: stats.xp ?? 0, reason, now, roundPool: this.roundPool });
      // integrity: finish the ticket's telemetry; with auto-hold on, a high-risk payout is held (same journal write)
      this.integrity?.settle(this, p.id, item, { reason, payout: fee.net, killer });
      enqueue.unshift(item);
    }
    // the countries board: this game's mass (and an alive arena game's payout) for the player's flag
    if (!this.offBoard && p.country) {
      this.deps.leaderboards.countryGame({ country: p.country, mass: score, paid: cause === 'death' ? 0 : (stats.payout ?? 0), at: now });
    }

    if (batch) {
      batch.push(...enqueue);
    } else if (enqueue.length > 0 || this.ledger) {
      this.commitJournal(enqueue);
      if (enqueue.length > 0) this.deps.chain.kick();
    }

    const c = conn ?? this.humans.get(p.id) ?? null;
    try {
      this.deps.onGameOver?.({ room: this, conn: c, player: p, stats, ...(cause === 'death' ? { dead: true } : {}), ...(end?.standings ? { standings: end.standings } : {}) });
    } catch (err) {
      this.deps.log(`room ${this.id}: game-over hook failed: ${(err as Error).message}`);
    }
    // a person ate a person: the killer may share it ("Share on X"; the share service rate-limits the cards)
    const killerConn = killer && !killer.isBot && !p.isBot ? this.humans.get(killer.id) : null;
    if (cause === 'death' && killerConn) {
      try {
        this.deps.onNotableKill?.({ room: this, conn: killerConn, killer: killer!, victim: p.name, victimMass: Math.floor(stats.maxMass), victimX: p.xHandle });
      } catch (err) {
        this.deps.log(`room ${this.id}: notable-kill hook failed: ${(err as Error).message}`);
      }
    }
    this.world.removePlayer(p.id);
    this.humans.delete(p.id);
    this.afkSince.delete(p.id);
    this.walletOf.delete(p.id);
    this.avatarOf.delete(p.id);
    for (const other of this.conns) other.view.forgetPlayer(p.id);

    if (c) {
      if (c.player === p) c.player = null;
      c.lastCenter = p.center();
      if (batch) return stats;
      if (cause === 'death') {
        c.send({ t: 'death', stats, killer: killer?.name ?? null, killerSkin: killer?.skin ?? null, ...(killer?.isBot ? { killerIsBot: true } : {}) });
      }
      else if (cause === 'maxage' || cause === 'kicked') c.send({ t: 'cashout', state: 'done', value: stats.payout, stats });
    }
    return stats;
  }

  /** A test arena: a person ate a practice bot (a TEST card; never in other rooms). */
  private notableBotKill(killer: Player | null, bot: Player): void {
    const conn = killer && !killer.isBot ? this.humans.get(killer.id) : null;
    if (!conn) return;
    try {
      this.deps.onNotableKill?.({ room: this, conn, killer: killer!, victim: bot.name, victimMass: Math.floor(bot.stats.maxMass), victimIsBot: true });
    } catch (err) {
      this.deps.log(`room ${this.id}: notable-kill hook failed: ${(err as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Round end (arena rooms)                                          */
  /* ---------------------------------------------------------------- */

  /**
   * The bell, in one tick: every live staker (connected or AFK) is settled at their value
   * (reason `round`); the floor loot is collected and one `sweep` item for its value is queued
   * in the SAME journal write (Σ live + Σ loot + Σ pending is preserved); every settled human
   * gets `roundOver`; the world is reset for the next round while bots keep playing.
   */
  private endRound(round: number): void {
    const ledger = this.ledger!;
    // standings at the bell: every ticket by value, ties: bigger mass first
    const holders: { pid: number; value: number }[] = ledger.all().map((e) => ({ pid: e.pid, value: e.value }));
    const ranked = holders
      .map((e) => ({ e, p: this.world.players.get(e.pid) }))
      .sort((a, b) => b.e.value - a.e.value || (b.p?.totalMass() ?? 0) - (a.p?.totalMass() ?? 0));
    const top = ranked.slice(0, FINAL_STANDINGS_ROWS);
    // the final board (the same rows as a custom room's end), read before the coins go home
    const board: BoardEntry[] = ranked.map(({ e, p }) => ({ pid: e.pid, name: p?.name ?? '???', mass: Math.floor(p?.totalMass() ?? 0), kills: p?.stats.playersEaten ?? 0, value: e.value }));
    // the bell's standings go on the public "Last rounds" board (private paid rooms keep theirs to themselves)
    if (!this.offBoard && this.opts.stake && top.length > 0) {
      this.deps.leaderboards.roundOver?.({
        n: round,
        endedAt: Date.now(),
        arenaId: this.opts.stake.arenaId,
        entryFee: this.opts.stake.buyIn,
        players: holders.length,
        top: top.map(({ e, p }) => ({
          name: p?.name ?? '???',
          value: e.value,
          skin: p?.skin ?? 0,
          ...(p?.country ? { country: p.country } : {}),
        })),
      });
    }

    const batch: JournalItem[] = [];
    const results: { conn: Conn; pid: number; payout: number; stats: DeathStats }[] = [];
    const away: BellSettled[] = [];
    // the next round's map is sized for the people at this bell (they are likely to play on)
    const humansAtBell = this.humans.size;
    for (const [pid, conn] of [...this.humans]) {
      const p = this.world.players.get(pid);
      if (!p?.alive) continue;
      const c = conn ?? null;
      const entry = ledger.get(pid);
      const stats = this.finishHuman(p, c, 'round', null, batch, { rank: board.findIndex((b) => b.pid === pid) + 1, of: board.length, standings: boardRows(board, pid, SHARE_BOARD_ROWS) });
      const payout = stats.payout ?? 0;
      if (c) results.push({ conn: c, pid, payout, stats });
      else if (entry) away.push({ arenaId: entry.arenaId, wallet: entry.player, session: entry.session, sessionId: entry.sessionId, round });
    }

    const amount = this.world.takeLoot();
    const now = Date.now();
    if (amount > 0 && this.opts.stake) {
      // a key can repeat only if the wall clock stepped back across a round boundary while the
      // earlier sweep is still pending: never drop the loot, queue it under a distinct key
      let key = sweepKey(this.id, round);
      for (let k = 2; this.deps.journal.pending.some((p) => p.key === key); k++) key = `${sweepKey(this.id, round)}:${k}`;
      if (key !== sweepKey(this.id, round)) {
        this.deps.log(`!!! room ${this.id}: loot sweep for round ${round} is already pending (wall clock stepped back?); queuing ${amount} as ${key}`);
      }
      batch.push({
        kind: 'sweep',
        key,
        arenaId: this.opts.stake.arenaId,
        roomId: this.id,
        round,
        amount,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      });
    }
    this.commitJournal(batch);
    if (batch.length > 0) this.deps.chain.kick();
    for (const a of away) this.deps.onBellSettled?.(a);
    const settled = batch.filter((i) => i.kind === 'settle').length;
    if (settled > 0 || amount > 0) this.deps.log(`room ${this.id}: round ${round} over · ${settled} settled · ${amount} floor loot queued to burn`);

    for (const r of results) r.conn.send({ t: 'roundOver', round, payout: r.payout, stats: r.stats, standings: boardRows(board, r.pid) });

    // the next round starts on a fresh floor
    this.world.clearEjects();
    // round start: the one moment the map may shrink (every coin was just settled or sent home)
    if (this.map) this.applySide(this.wantedSide(humansAtBell));
  }

  /* ---------------------------------------------------------------- */
  /* Dynamic map size                                                 */
  /* ---------------------------------------------------------------- */

  /** Players this room expects with `humans` people in it: them plus its practice bots. */
  expectedPlayers(humans = this.humans.size): number {
    return humans + (this.bots?.count ?? 0);
  }

  /** The side the room wants now: auto from the expected count, else its preset. */
  private wantedSide(humans: number, bots?: number): number {
    const m = this.map!;
    if (!m.scale.auto) return Math.min(MAP_SPACE, this.preset.width);
    const n = bots !== undefined ? humans + bots : this.expectedPlayers(humans);
    return mapSideFor(n, m.scale);
  }

  private shapeFor(side: number): WorldShape {
    // auto off: the preset as it is (its own food and cacti)
    if (this.map && !this.map.scale.auto && side === this.preset.width) return { ...this.preset };
    return this.map?.shape ? this.map.shape(side) : worldForSide(side);
  }

  private applySide(side: number): boolean {
    const shape = this.shapeFor(side);
    const changed = this.world.resize(shape.width, shape.height, shape);
    if (changed) {
      this.lastResizeAt = this.world.now;
      this.deps.log(`room ${this.id}: map ${shape.width} x ${shape.height} (${this.expectedPlayers()} players expected; ${shape.foodTarget} food, ${shape.virusTarget} cacti)`);
    }
    return changed;
  }

  /** New map settings from the admin: the room follows from its next check (and shrinks only when it may). */
  setMapScale(scale: MapScaleSettings): void {
    if (!this.map) return;
    this.map = { ...this.map, scale: { ...scale } };
    this.nextMapCheckAt = 0;
  }

  /** The map settings this room runs with (null: a fixed world). */
  mapScale(): MapScaleSettings | null {
    return this.map ? { ...this.map.scale } : null;
  }

  /**
   * Runs every tick, checks every `MAP_GROW.checkMs`. In play the map only grows, by at most
   * `MAP_GROW.maxStep` every `MAP_GROW.stepMs`. Arena rooms shrink at the round start only
   * (`endRound`); free rooms (no rounds) shrink step by step, and only when no human coin is near
   * the floor that would go.
   */
  private updateMapSize(): void {
    if (!this.map) return;
    const now = this.world.now;
    if (now < this.nextMapCheckAt) return;
    this.nextMapCheckAt = now + MAP_GROW.checkMs;
    if (now - this.lastResizeAt < MAP_GROW.stepMs) return;
    const want = this.wantedSide(this.humans.size);
    const cur = this.world.cfg.width;
    if (want > cur) this.applySide(Math.min(want, cur + MAP_GROW.maxStep));
    else if (!this.ledger && want <= cur - SHRINK_HYSTERESIS) {
      const next = Math.max(want, cur - MAP_GROW.maxStep);
      if (this.humansClearOf(next)) this.applySide(next);
    }
  }

  /** No human cell reaches within `SHRINK_CLEARANCE` of the border of a world of `side`. */
  private humansClearOf(side: number): boolean {
    const lo = (this.world.spaceW - side) / 2 + SHRINK_CLEARANCE;
    const hi = lo + side - 2 * SHRINK_CLEARANCE;
    const loY = (this.world.spaceH - side) / 2 + SHRINK_CLEARANCE;
    const hiY = loY + side - 2 * SHRINK_CLEARANCE;
    for (const pid of this.humans.keys()) {
      const p = this.world.players.get(pid);
      if (!p) continue;
      for (const c of p.cells) if (c.x - c.r < lo || c.x + c.r > hi || c.y - c.r < loY || c.y + c.r > hiY) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * An idle room stops simulating (no conns, no humans for a minute). A sleeping room still rings its
   * bell (`syncRound`).
   */
  get sleeping(): boolean {
    return this.conns.size === 0 && this.humans.size === 0 && Date.now() - this.lastActivity > SLEEP_AFTER_MS;
  }

  tick(dtMs: number): void {
    if (this.conns.size > 0 || this.humans.size > 0) this.lastActivity = Date.now();
    // rounds end on the wall clock, even in a sleeping room (its floor loot is burned)
    this.syncRound();
    if (this.sleeping) return;
    const world = this.world;
    const ev = world.tick(dtMs);

    // loot is picked before any cell is eaten in a tick (the world eats static entities first)
    for (const lp of ev.lootPicked) this.onLootPicked(lp.pid, lp.value);
    // value moves with every eaten stake cell
    for (const ce of ev.cellsEaten) this.onCellEaten(ce);
    const integ = this.integrity;
    if (integ) {
      for (const e of ev.ejectsEaten) integ.monitor.onEjectEaten(this.id, e.ownerId, e.eaterId);
      if (++this.tickN % INTEGRITY_SAMPLE_TICKS === 0 && this.ledger!.size > 0) integ.monitor.sample(this.id, world.players.values(), this.now());
    }

    for (const k of ev.kills) {
      this.broadcast({
        t: 'kf',
        killer: k.killer?.name ?? '???',
        killerSkin: k.killer?.skin ?? 0,
        victim: k.victim.name,
        victimSkin: k.victim.skin,
        cause: k.cause === 'virus' ? 'virus' : 'eat',
        ...(k.killer?.isBot ? { killerIsBot: true } : {}),
        ...(k.victim.isBot ? { victimIsBot: true } : {}),
      });
      // the eaten list of a person's result (a bot victim counts in a test arena only)
      if (k.killer && this.humans.has(k.killer.id)) {
        this.eaten.note(k.killer.id, { pid: k.victim.id, name: k.victim.name, bot: k.victim.isBot, wallet: this.walletOf.get(k.victim.id) ?? null, xHandle: k.victim.xHandle });
      }
      if (this.bots?.isBot(k.victim.id)) {
        if (this.opts.test) this.notableBotKill(k.killer, k.victim);
        this.bots.onDeath(k.victim.id, world.now);
        world.removePlayer(k.victim.id);
        for (const c of this.conns) c.view.forgetPlayer(k.victim.id);
      } else if (this.humans.has(k.victim.id)) {
        this.finishHuman(k.victim, null, 'death', k.killer);
      } else {
        world.removePlayer(k.victim.id);
        this.avatarOf.delete(k.victim.id);
      }
    }

    for (const pk of ev.pickups) {
      const c = this.humans.get(pk.player.id);
      if (c) c.send({ t: 'powerup', type: pk.type, ms: Math.max(0, pk.until - world.now) });
    }
    for (const a of ev.airdrops) this.broadcast({ t: 'event', kind: 'airdrop', state: 'start', x: a.x, y: a.y, powerUp: a.type });
    if (ev.coinRain) {
      this.broadcast({ t: 'event', kind: 'coinrain', state: ev.coinRain, ms: ev.coinRain === 'start' ? world.coinRainUntil - world.now : 0 });
      if (ev.coinRain === 'start') this.pushChat({ pid: 0, from: 'Elymum', skin: 1, text: 'COIN RAIN!', system: true });
    }

    this.bots?.update(world.now);

    if (this.ledger) this.stakeHousekeeping();

    this.updateMapSize();

    this.sendSnapshots();

    const now = Date.now();
    if (now - this.lastLbAt >= 1000) {
      this.lastLbAt = now;
      this.sendLeaderboard();
    }
  }

  private stakeHousekeeping(): void {
    const world = this.world;
    // AFK stakers are not cashed out any more: their cells stay until eaten or the round ends
    const now = Date.now();
    if (now - this.lastAgeCheckAt >= 5000) {
      this.lastAgeCheckAt = now;
      // `openedAt` is a block timestamp: compare it with the chain's clock, not this server's
      const chainNowS = (this.deps.chainNow?.() ?? now) / 1000;
      for (const e of this.ledger!.all()) {
        if (chainNowS - e.openedAt < MAX_STAKE_SESSION_AGE_S) continue;
        const p = world.players.get(e.pid);
        if (p?.alive) this.finishHuman(p, this.humans.get(e.pid) ?? null, 'maxage');
      }
    }
    if (this.journalDirty && now - this.lastJournalAt >= JOURNAL_SNAPSHOT_MS) this.commitJournal();
  }

  private viewFor(conn: Conn): { rect: { x0: number; y0: number; x1: number; y1: number }; view: { x: number; y: number; h: number } } {
    const p = conn.player;
    let cx: number;
    let cy: number;
    let size: { w: number; h: number };
    if (p && p.alive && p.cells.length > 0) {
      const c = p.center();
      cx = c.x;
      cy = c.y;
      size = viewSize(p.totalMass(), conn.aspect);
      // make sure every own cell fits (after a split pieces can fly far)
      let maxDx = 0;
      let maxDy = 0;
      for (const cell of p.cells) {
        maxDx = Math.max(maxDx, Math.abs(cell.x - cx) + cell.r);
        maxDy = Math.max(maxDy, Math.abs(cell.y - cy) + cell.r);
      }
      size = { w: Math.max(size.w, maxDx * 2.2), h: Math.max(size.h, maxDy * 2.2) };
      conn.lastCenter = { x: cx, y: cy };
    } else {
      const target = conn.spectatePid !== null ? this.world.players.get(conn.spectatePid) : undefined;
      if (conn.spectating && (!target || !target.alive)) {
        const top = this.world.ranking().find((q) => !this.world.isInvisible(q));
        conn.spectatePid = top?.id ?? null;
      }
      const t = conn.spectatePid !== null ? this.world.players.get(conn.spectatePid) : undefined;
      // an invisible target: the camera waits where it last saw it (following it would give it away)
      if (conn.spectating && t && t.alive && !this.world.isInvisible(t)) {
        const c = t.center();
        cx = c.x;
        cy = c.y;
        conn.lastCenter = c;
      } else if (conn.spectating && conn.lastCenter.x === 0 && conn.lastCenter.y === 0) {
        ({ x: cx, y: cy } = this.world.center());
      } else {
        cx = conn.lastCenter.x;
        cy = conn.lastCenter.y;
      }
      size = viewSize(0, conn.aspect, true);
    }
    const hw = (size.w / 2) * VIEW.serverMargin;
    const hh = (size.h / 2) * VIEW.serverMargin;
    return { rect: { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }, view: { x: cx, y: cy, h: size.h } };
  }

  private sendSnapshots(): void {
    for (const conn of this.conns) {
      if (!conn.open) continue;
      if (conn.buffered > 768 * 1024) continue; // slow client: skip a frame
      const { rect, view } = this.viewFor(conn);
      const snap = conn.view.build(this.world, rect, view, this.entryFee, this.avatarOf, conn.player?.alive ? conn.player.id : null);
      if (!snap) continue;
      this.writer.reset();
      writeSnapshot(this.writer, snap);
      // a room worker copies the bytes into its batch at once; a socket keeps the buffer it is given
      if (conn.sendBytes) conn.sendBytes(this.writer.written());
      else conn.sendBinary(this.writer.finish());
    }
  }

  private sendLeaderboard(): void {
    const ranking = this.rankedPlayers();
    const top: LbEntry[] = ranking.slice(0, 10).map((p) => ({
      pid: p.id,
      name: p.name,
      skin: p.skin,
      score: Math.floor(p.totalMass()),
      value: this.ledger ? this.ledger.value(p.id) : undefined,
      bot: p.isBot || undefined,
      isBot: p.isBot || undefined,
      verified: (p.flags & PlayerFlag.Verified) !== 0 || undefined,
      country: p.country ?? undefined,
    }));
    // the minimap's leader dots: an invisible leader has none (the others keep theirs)
    const leaders = ranking.slice(0, 3).filter((p) => !this.world.isInvisible(p)).map((p) => {
      const c = p.center();
      return { x: Math.round(c.x), y: Math.round(c.y) };
    });
    const rankOf = new Map<number, number>();
    ranking.forEach((p, i) => {
      rankOf.set(p.id, i + 1);
      if (i + 1 < p.stats.bestRank) p.stats.bestRank = i + 1;
    });
    for (const conn of this.conns) {
      const p = conn.player;
      const me =
        p && p.alive
          ? { rank: rankOf.get(p.id) ?? ranking.length, score: Math.floor(p.totalMass()), value: this.ledger ? this.ledger.value(p.id) : undefined }
          : null;
      conn.send({ t: 'lb', top, me, leaders, players: ranking.length });
    }
    // the full standings ride the same second, built once for every open sheet
    let full: ServerMessage | null = null;
    for (const conn of this.conns) {
      if (!conn.standings || !conn.open) continue;
      full ??= this.standingsMessage(ranking);
      conn.send(full);
    }
  }

  /** The full standings to one connection right now (its sheet just opened). */
  sendStandings(conn: Conn): void {
    if (conn.room !== this || !conn.open) return;
    conn.send(this.standingsMessage(this.rankedPlayers()));
  }

  private rankedPlayers(): Player[] {
    const ranking = this.world.ranking();
    const ledger = this.ledger;
    return ledger ? ranking.sort((a, b) => ledger.value(b.id) - ledger.value(a.id) || b.totalMass() - a.totalMass()) : ranking;
  }

  /** Every coin in play, ranked like the leaderboard (`standings`). */
  private standingsMessage(ranking: Player[]): ServerMessage {
    const rows: StandingRow[] = ranking.slice(0, STANDINGS_MAX_ROWS).map((p) => {
      const row: StandingRow = { pid: p.id, name: p.name, skin: p.skin, score: Math.floor(p.totalMass()) };
      if (this.ledger) row.value = this.ledger.value(p.id);
      if (p.isBot) row.isBot = true;
      if ((p.flags & PlayerFlag.Verified) !== 0) row.verified = true;
      if ((p.flags & PlayerFlag.Holder) !== 0) row.holder = true;
      const avatar = p.isBot ? undefined : this.avatarOf.get(p.id);
      if (avatar) row.avatar = avatar;
      if (p.country) row.country = p.country;
      if (!p.isBot && this.humans.has(p.id) && this.humans.get(p.id) === null) row.away = true;
      return row;
    });
    let watching = 0;
    for (const c of this.conns) if (!c.player?.alive) watching++;
    return { t: 'standings', rows, players: ranking.length, watching };
  }

  /**
   * Closes a free room for good (a custom room's time ran out, or it was closed early): every game
   * ends (counted like leaving), and every connection, players and spectators alike, hears
   * `room_closed` and is detached. The caller drops the room from the manager. Never for arenas.
   */
  evict(message: string): number {
    // an arena room holding a ticket or loot is never evicted (`closeSettled` waits for its bell)
    if (this.ledger && !this.settledOut()) throw new Error('arena rooms are never evicted');
    // a free custom room ends on its final board: everyone by mass (practice bots too), read before anyone leaves
    // (an arena showed its board at the bell, `roundOver`)
    const final = !this.ledger && !!this.opts.custom;
    const board: BoardEntry[] = final
      ? this.world.ranking().map((p) => ({ pid: p.id, name: p.name, mass: Math.floor(p.totalMass()), kills: p.stats.playersEaten, ...(p.isBot ? { isBot: true } : {}) }))
      : [];
    const played = new Map<Conn, { pid: number; stats: DeathStats }>();
    let n = 0;
    for (const [pid, c] of [...this.humans]) {
      const p = this.world.players.get(pid);
      if (p?.alive) {
        const rank = board.findIndex((b) => b.pid === pid) + 1;
        const stats = this.finishHuman(p, c, 'left', null, undefined, final && rank > 0 ? { rank, of: board.length, standings: boardRows(board, pid, SHARE_BOARD_ROWS) } : undefined);
        if (c) played.set(c, { pid, stats });
        n++;
      }
    }
    for (const pid of this.bots?.removeAll() ?? []) for (const c of this.conns) c.view.forgetPlayer(pid);
    for (const c of [...this.conns]) {
      if (final) {
        const mine = played.get(c);
        c.send({ t: 'roomOver', message, players: board.filter((b) => !b.isBot).length, standings: boardRows(board, mine?.pid ?? -1), stats: mine?.stats ?? null });
      }
      c.player = null;
      c.spectating = false;
      c.send({ t: 'error', code: 'room_closed', message });
      this.detach(c);
    }
    return n;
  }

  /** Nothing of value is left: no player (connected or AFK), no ticket, no loot on the floor. */
  private settledOut(): boolean {
    return this.humans.size === 0 && (this.ledger?.all().length ?? 0) === 0 && this.world.loot().length === 0;
  }

  /**
   * A paid custom room's end: closes it (its spectators hear `room_closed` with `message`) only once
   * nothing of value is left in it (see `settledOut`): its bell settles every ticket and burns the
   * floor loot first. False while a ticket or loot remains (the caller asks again later).
   */
  closeSettled(message: string): boolean {
    if (!this.settledOut()) return false;
    this.evict(message);
    return true;
  }

  /** Server shutdown: settle every stake player at their current value (an operator exit). */
  shutdown(): void {
    for (const [pid, c] of [...this.humans]) {
      const p = this.world.players.get(pid);
      if (p?.alive) this.finishHuman(p, c, this.ledger ? 'kicked' : 'left');
    }
  }

  /** People and practice bots in the room (the load view). */
  botCounts(): { humans: number; bots: number } {
    return { humans: this.humans.size, bots: this.bots?.size ?? 0 };
  }
}

/** One coin on a final board (`boardRows`), ranked already. */
interface BoardEntry {
  pid: number;
  name: string;
  mass: number;
  kills: number;
  value?: number;
  isBot?: boolean;
}

/**
 * The final standings one player gets (`RoundStanding`, the same at an arena's bell and at a custom room's end): the
 * whole board (the top `rows` of `ranked`, `FINAL_BOARD_ROWS` by default), plus their own row when it is below them.
 */
export function boardRows(ranked: readonly BoardEntry[], pid: number, rows = FINAL_BOARD_ROWS): RoundStanding[] {
  const row = (b: BoardEntry, i: number): RoundStanding => ({
    rank: i + 1,
    name: b.name,
    mass: b.mass,
    kills: b.kills,
    ...(b.value !== undefined ? { value: b.value } : {}),
    ...(b.isBot ? { isBot: true } : {}),
    ...(b.pid === pid ? { you: true } : {}),
  });
  const out = ranked.slice(0, rows).map(row);
  const mine = ranked.findIndex((b) => b.pid === pid);
  if (mine >= rows) out.push(row(ranked[mine], mine));
  return out;
}

/** The journal item that settles an arena ticket at its gross value (the contract takes the fee on profit). */
function settlementOf(
  entry: ArenaEntry,
  o: { score: number; kills: number; xp: number; reason: SettleReason; now: number; roundPool?: number },
): SettlementItem {
  return {
    kind: 'settle',
    key: entry.session,
    player: entry.player,
    arenaId: entry.arenaId,
    session: entry.session,
    sessionId: entry.sessionId,
    payout: entry.value,
    entryFee: entry.entryFee,
    ...(o.roundPool !== undefined && o.roundPool > 0 ? { roundPool: o.roundPool } : {}),
    score: o.score,
    kills: o.kills,
    xp: o.xp,
    reason: o.reason,
    attempts: 0,
    nextAttemptAt: o.now,
    createdAt: o.now,
  };
}
