import { randomInt } from 'node:crypto';
import { availableParallelism } from 'node:os';
import {
  TEST_ARENA_ARRIVE_MS,
  TEST_ARENA_BOTS,
  TEST_ARENA_DEFAULT,
  TICK_MS,
  arenaMeta,
  ownRoundAt,
  testArenaName,
  testArenaRoomId,
  testArenasAllowedOn,
  type BlockedArena,
  type DeathStats,
  type RoundStanding,
  type League,
  type MapScaleSettings,
  type RoomInfo,
  type RoundWindow,
  type TestArenaView,
} from '@coinnibal/shared';
import type { ChainGateway } from '../chain/types';
import type { ServerConfig } from '../config';
import type { IntegrityService } from '../integrity/service';
import type { Leaderboards } from '../leaderboards';
import type { Conn } from '../net/conn';
import type { ShopService } from '../shop/service';
import type { Journal } from '../stake/journal';
import type { PracticeBotsOptions } from '../bots/practice';
import { ArenaScaler, ArenaScalingStore } from './arena-scaler';
import { MapSettingsStore, mapKindOf, type MapRoomKind } from './map-settings';
import { lookOf, type PlayerLook, type RoomHandle, type StakeSeat } from './handle';
import { Room, type BellSettled, type RoomDeps, type RoomOptions } from './room';
import { RoundClock } from './round-clock';
import { ThreadMeter, TickStats, roomTickStats, startTickLoop, wsOut, type RoomLoad, type ServerLoad, type ThreadLoad } from './load';
import { RemoteRoom, WorkerPool } from './remote/pool';
import { TestArenaStore } from './test-arenas';

/** What the room manager asks of the custom-room service (`CustomRoomService`). */
export interface CustomRoomHooks {
  /** Closes rooms whose time ran out (called about once a second from the tick loop). */
  sweep(): void;
  /** A human's game ended in a custom room (its own leaderboard). */
  onGame(room: RoomHandle, e: { name: string; score: number; kills: number }): void;
  /** Rooms were lost with a crashed room worker: reopen the custom rooms that still have time. */
  restore?(): number;
  /**
   * A paid custom room `code` takes new seats now (it exists, has time left and is not closing).
   * Absent: every paid room is seatable (tests without the service).
   */
  seatable?(code: string): boolean;
}

/** A room in a worker that was asked to close (an idle cleanup) or is gone: it takes no new join. */
const closingRemote = (r: RoomHandle): boolean => r instanceof RemoteRoom && (r.closing || r.closed);

/** A paid custom room: an invite-only arena instance (`priv-<CODE>`, mode `arena`), never matched by quick play. */
export function isPaidCustom(opts: Pick<RoomOptions, 'mode' | 'code'>): boolean {
  return opts.mode === 'arena' && !!opts.code;
}

/** A human's game ended (death, leave, bell, operator exit), in a room on this thread or in a room worker. */
export interface GameOverEvent {
  room: RoomHandle;
  conn: Conn | null;
  player: PlayerLook;
  stats: DeathStats;
  /** The game ended in a death. */
  dead?: boolean;
  /** A room's end: the top of its final board with the player's own row (the result card's standings picture). */
  standings?: RoundStanding[];
}

/** A person ate a person (in a testnet test arena a practice bot too), in a room on this thread or in a room worker. */
export interface NotableKillEvent {
  room: RoomHandle;
  /** The killer's connection. */
  conn: Conn;
  player: PlayerLook;
  /** The killer's mass and kills now. */
  mass: number;
  kills: number;
  victim: string;
  victimMass: number;
  /** A practice bot (testnet test arenas only). */
  victimIsBot?: boolean;
  /** The X handle the eaten coin's wallet linked when it joined (the main thread checks it is still linked). */
  victimX?: string | null;
}

/** The services the rooms use: the main thread's own (journal, chain, stores), whichever thread runs the rooms. */
export interface ManagerDeps extends Omit<RoomDeps, 'chain' | 'journal' | 'leaderboards' | 'integrity' | 'shop' | 'onGameOver' | 'onNotableKill'> {
  chain: ChainGateway;
  journal: Journal;
  leaderboards: Leaderboards;
  integrity?: IntegrityService;
  shop?: ShopService;
  onGameOver?: (e: GameOverEvent) => void;
  onNotableKill?: (e: NotableKillEvent) => void;
}

/** A custom room that closed is remembered this long (a late joiner hears `room_closed`, not "no such room"). */
export const CLOSED_MEMO_MS = 3600_000;

/** How long the gateway remembers an AFK ticket settled at a bell (for `round_ended`). */
export const BELL_MEMO_MS = 30 * 60_000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** On-chain arena list is re-read at most this often. */
export const ARENA_CACHE_MS = 60_000;
/** After a failed arena-list read the last good list is used this long before the next try. */
export const ARENA_RETRY_MS = 10_000;
/** Practice players with this profile level or more always play in the pro league. */
export const PRO_LEVEL = 5;
/** A rookie game with max mass above this promotes the player's IP to pro… */
export const PROMOTE_MAX_MASS = 3000;
/** …and so does one with at least this many player kills. */
export const PROMOTE_KILLS = 8;
/** How long a promotion lasts. */
export const PROMOTION_MS = 24 * 3600_000;

interface ArenaData {
  buyIn: number;
  maxPlayers: number;
  enabled: boolean;
  /** Vault balance (raw units); null = not tracked (dev-fake). */
  pot: number | null;
  /** Emblem holders only (on chain). */
  holdersOnly?: boolean;
}

/** An arena a paid custom room can be opened on (`RoomManager.paidArenas`). */
export interface PaidArena {
  arenaId: number;
  /** Ticket price, ledger units. */
  buyIn: number;
  holdersOnly: boolean;
}

/**
 * The room directory: every room (practice leagues, private and custom rooms, arena instances),
 * matchmaking, arena discovery and the vault guard, the bell memo. With `GAME_WORKERS` = 0 the rooms
 * run here (`rooms`); otherwise they run in room workers (`WorkerPool`) and this keeps their proxies
 * (`RemoteRoom`), placing each new room on the least-loaded worker.
 */
export class RoomManager {
  /** Rooms running on this thread (single-thread mode; empty with room workers). */
  readonly rooms = new Map<string, Room>();
  /** Rooms running in room workers. */
  private readonly remote = new Map<string, RemoteRoom>();
  /** The room workers (null: single-thread mode). */
  readonly pool: WorkerPool | null;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  readonly conns = new Set<Conn>();
  private stopLoop: (() => void) | null = null;
  /** The whole tick of this thread (single-thread mode) and its event-loop meter. */
  private readonly tickStats = new TickStats();
  private readonly meter = new ThreadMeter();
  private lastLoadAt = performance.now();
  private lastOut = { bytes: 0, msgs: 0 };
  private lastCleanup = Date.now();
  private arenaCache: { at: number; ids: Map<number, ArenaData> } | null = null;
  /** IP → time of the promotion to the pro league. */
  private readonly promotions = new Map<string, number>();
  private readonly deps: ManagerDeps;
  /** What a room on this thread is given. */
  private readonly roomDeps: RoomDeps;
  /** Arenas kept disabled because their vault cannot cover the journal (id → message). */
  private readonly underfunded = new Map<number, string>();
  /** `enabled` of each arena at the last chain read (detects a disabled → enabled flip). */
  private readonly lastEnabled = new Map<number, boolean>();
  /** `arenaId:wallet` → the AFK ticket the last bell settled while its player was away. */
  private readonly bellMemo = new Map<string, BellSettled & { at: number }>();
  /** The admin's map settings (`/api/admin/maps`), applied live to every room. */
  readonly mapSettings: MapSettingsStore;
  private custom: CustomRoomHooks | null = null;
  private lastCustomSweep = 0;
  /**
   * Codes of custom rooms that closed lately → when, and the arena a paid one was an instance of (null: a free room,
   * a "Practice with bots" room included). Only a paid room's code refunds a ticket, and only one of its own arena.
   */
  private readonly closedCodes = new Map<string, { at: number; arenaId: number | null }>();
  /** How many public instances of each arena take seats, and which one a seat goes to (`arena-scaler.ts`). */
  readonly scaler: ArenaScaler;
  /** The admin switch "Test arenas with bots" and their bot settings (testnet only, `test-arenas.ts`). */
  readonly testArenas: TestArenaStore;
  /** Test arenas on this thread that take no new seat and close once settled (the switch was turned off). */
  private readonly closingTests = new Set<string>();

  constructor(
    private readonly cfg: ServerConfig,
    deps: ManagerDeps,
    private readonly chain: ChainGateway,
    mapSettings?: MapSettingsStore,
    scaling?: ArenaScalingStore,
    /** Absent: test arenas stay off (bare unit tests); the app passes the admin's store. */
    testArenas?: TestArenaStore,
  ) {
    this.mapSettings = mapSettings ?? new MapSettingsStore(null);
    this.testArenas = testArenas ?? new TestArenaStore(cfg.chain.chainId, null, undefined, { enabled: false });
    this.testArenas.onChange(() => this.applyTestArenaSettings());
    this.scaler = new ArenaScaler(
      {
        instances: (arenaId) => this.arenaInstances(arenaId),
        arenaIds: () => [...new Set(this.publicInstances().map((r) => r.opts.stake!.arenaId))].sort((a, b) => a - b),
        capacity: () => this.cfg.arenaInstanceCap,
        openInstance: (arenaId) => this.openScaledInstance(arenaId),
        closeDrained: (room) => this.closeDrained(room),
        threadOf: (room) => (room instanceof RemoteRoom ? `w${room.slot.index}` : undefined),
        now: () => this.now(),
        log: (m) => this.deps.log(m),
      },
      scaling ?? new ArenaScalingStore(null),
    );
    this.mapSettings.onChange(() => this.applyMapSettings());
    const round = deps.round ?? cfg.round;
    // one clock for the gateway and every room
    const clock = deps.clock ?? new RoundClock(deps.now, round);
    const gameOver = (e: GameOverEvent) => {
      this.onGameOver(e);
      if (e.room.opts.custom) this.custom?.onGame(e.room, { name: e.player.name, score: Math.floor(e.stats.maxMass), kills: e.stats.playersEaten });
      deps.onGameOver?.(e);
    };
    const bellSettled = (e: BellSettled) => {
      this.bellMemo.set(`${e.arenaId}:${e.wallet}`, { ...e, at: Date.now() });
      deps.onBellSettled?.(e);
    };
    this.deps = { ...deps, round, clock, onGameOver: gameOver, onBellSettled: bellSettled, chainNow: deps.chainNow ?? (() => chain.chainNow?.() ?? Date.now()) };
    // a room on this thread hands its own connection (a `Conn`) to the hooks
    const notable = (e: NotableKillEvent) => deps.onNotableKill?.(e);
    this.roomDeps = {
      ...this.deps,
      onGameOver: (e) => gameOver({ room: e.room, conn: e.conn as Conn | null, player: lookOf(e.player), stats: e.stats, ...(e.dead ? { dead: true } : {}), ...(e.standings ? { standings: e.standings } : {}) }),
      onNotableKill: (e) =>
        notable({ room: e.room, conn: e.conn as Conn, player: lookOf(e.killer), mass: Math.floor(e.killer.totalMass()), kills: e.killer.stats.playersEaten, victim: e.victim, victimMass: e.victimMass, ...(e.victimIsBot ? { victimIsBot: true } : {}), ...(e.victimX ? { victimX: e.victimX } : {}) }),
    };
    const workers = cfg.gameWorkers ?? 0;
    this.pool =
      workers > 0
        ? new WorkerPool(workers, {
            journal: deps.journal,
            chain: deps.chain,
            leaderboards: deps.leaderboards,
            log: deps.log,
            clock,
            round,
            clockOffset: () => clock.now() - Date.now(),
            chainOffset: () => (chain.chainNow?.() ?? Date.now()) - Date.now(),
            integrity: deps.integrity,
            shop: deps.shop,
            onGameOver: gameOver,
            onNotableKill: notable,
            onBellSettled: bellSettled,
            onLost: (rooms) => this.onRoomsLost(rooms),
            onClosed: (room, ok) => {
              if (!ok || this.remote.get(room.id) !== room) return;
              this.remote.delete(room.id);
              // a paid custom room closes in its worker once settled (`closePaidRoom`)
              if (room.opts.custom && room.opts.code) this.rememberClosed(room);
            },
            hangMs: cfg.gameWorkerHangMs,
          })
        : null;
    if (this.pool && deps.integrity) {
      const pool = this.pool;
      deps.integrity.setRemoteLive(() => pool.liveSessions());
    }
    this.createPractice('rookie');
    this.createPractice('pro');
  }

  /** Every room, wherever it runs. */
  private handles(): IterableIterator<RoomHandle> {
    return this.pool ? this.remote.values() : this.rooms.values();
  }

  /** The room with this id, wherever it runs. */
  get(id: string): RoomHandle | undefined {
    return this.pool ? this.remote.get(id) : this.rooms.get(id);
  }

  private has(id: string): boolean {
    return this.pool ? this.remote.has(id) : this.rooms.has(id);
  }

  /** Rooms in the directory. */
  get roomCount(): number {
    return this.pool ? this.remote.size : this.rooms.size;
  }

  private drop(room: RoomHandle): void {
    if (room instanceof RemoteRoom) {
      if (this.remote.get(room.id) === room) this.remote.delete(room.id);
    } else this.rooms.delete(room.id);
  }

  /** Opens a room: here, or on the least-loaded room worker (an arena's first instance adopts the journaled loot). */
  private open(opts: RoomOptions): RoomHandle {
    if (this.pool) {
      const loot = opts.mode === 'arena' && opts.stake && (opts.instance ?? 1) === 1 ? this.deps.journal.adoptLoot(opts.stake.arenaId, opts.id) : [];
      const room = this.pool.createRoom(opts, loot);
      this.remote.set(room.id, room);
      return room;
    }
    const room = new Room(opts, this.roomDeps);
    this.rooms.set(room.id, room);
    return room;
  }

  /** A connection opened (the gateway); `removeConn` when it closes. */
  addConn(conn: Conn): void {
    this.conns.add(conn);
  }

  removeConn(conn: Conn): void {
    this.conns.delete(conn);
    this.pool?.forget(conn);
  }

  /**
   * A room worker died: its rooms are gone (the pool recovered their tickets and loot from the
   * journal). The standing rooms open again: the first pond of each league, every arena's first
   * instance, the custom rooms with time left.
   */
  private onRoomsLost(rooms: RemoteRoom[]): void {
    for (const r of rooms) this.drop(r);
    for (const league of ['rookie', 'pro'] as const) if (!this.has(`practice-${league}-1`)) this.createPractice(league);
    try {
      this.custom?.restore?.();
    } catch (err) {
      this.deps.log(`custom rooms: restore after a room worker crash failed: ${(err as Error).message}`);
    }
    void this.ensureArenaRooms();
  }

  /** The wall clock arena rounds run on (Unix ms; injectable through `RoomDeps.now`). */
  now(): number {
    return this.deps.clock!.now();
  }

  /** The arena round running at `now` (shared by every arena and instance). */
  roundWindow(now = this.now()): RoundWindow {
    return this.deps.clock!.window(now);
  }

  /**
   * The round window `room` plays at `now`: a paid custom room's own game (one round from its opening to its end,
   * joins closed in its last `closeMs`), else the arenas' shared round.
   */
  roomWindow(room: Pick<RoomHandle, 'opts'> | null, now = this.now()): RoundWindow {
    const own = room?.opts.ownRound;
    return own ? ownRoundAt(own, this.deps.clock!.cfg.closeMs) : this.roundWindow(now);
  }

  /** The ticket a bell settled while this wallet was away from the arena (kept `BELL_MEMO_MS`). */
  bellSettled(arenaId: number, wallet: string): BellSettled | null {
    const key = `${arenaId}:${wallet}`;
    const m = this.bellMemo.get(key);
    if (!m) return null;
    if (Date.now() - m.at > BELL_MEMO_MS) {
      this.bellMemo.delete(key);
      return null;
    }
    return m;
  }

  forgetBellSettled(arenaId: number, wallet: string): void {
    this.bellMemo.delete(`${arenaId}:${wallet}`);
  }

  /* ---------------------------------------------------------------- */
  /* Practice leagues                                                 */
  /* ---------------------------------------------------------------- */

  private createPractice(league: League): RoomHandle {
    let n = 1;
    while (this.has(`practice-${league}-${n}`)) n++;
    return this.open({
        id: `practice-${league}-${n}`,
        mode: 'practice',
        league,
        name: `${league === 'rookie' ? 'Rookie' : 'Pro'} Pond #${n}`,
        maxPlayers: this.cfg.practiceCapacity,
        map: { scale: this.mapSettings.mapScale(league === 'rookie' ? 'practiceRookie' : 'practicePro') },
    });
  }

  /**
   * Busiest non-full practice room of a league (so players meet each other),
   * else a new one. `prefer` (the room the connection is already in) wins when
   * it serves that league and has space.
   */
  practiceRoom(league: League, prefer?: RoomHandle | null): RoomHandle {
    if (prefer && prefer.opts.mode === 'practice' && prefer.opts.league === league && !prefer.isFull && !closingRemote(prefer)) return prefer;
    let best: RoomHandle | null = null;
    for (const r of this.handles()) {
      // an idle pond its worker was just asked to drop takes no join (it would answer `room_closed`)
      if (r.opts.mode !== 'practice' || r.opts.league !== league || r.isFull || closingRemote(r)) continue;
      if (!best || r.humanCount > best.humanCount) best = r;
    }
    return best ?? this.createPractice(league);
  }

  /** `pro` for level ≥ 5 profiles and for IPs promoted in the last 24 h, else `rookie`. */
  leagueFor(conn: Conn, now = Date.now()): League {
    if ((conn.profile?.level ?? 0) >= PRO_LEVEL) return 'pro';
    const at = this.promotions.get(conn.ip);
    return at !== undefined && now - at < PROMOTION_MS ? 'pro' : 'rookie';
  }

  private onGameOver(e: GameOverEvent): void {
    if (e.room.opts.mode !== 'practice' || e.room.opts.league !== 'rookie' || !e.conn) return;
    if (e.stats.maxMass > PROMOTE_MAX_MASS || e.stats.playersEaten >= PROMOTE_KILLS) {
      const first = !this.promotions.has(e.conn.ip);
      this.promotions.set(e.conn.ip, Date.now());
      if (first) this.deps.log(`league: ${e.conn.ip} promoted to pro`);
    }
  }

  /** Default room for lobby spectators. */
  lobbyRoom(): RoomHandle {
    let best: RoomHandle | null = null;
    for (const r of this.handles()) if (r.opts.mode === 'practice' && (!best || r.humanCount > best.humanCount)) best = r;
    return best ?? this.createPractice('rookie');
  }

  /**
   * A fresh private-room code (8 characters of `CODE_ALPHABET`, drawn with `crypto.randomInt`: 32^8, about 10^12
   * codes, so an invite cannot be guessed; codes of 5 from before stay valid), not used by a live or lately closed room.
   */
  newPrivateCode(): string {
    let c = '';
    do {
      c = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.has(`priv-${c}`) || this.closedCodes.has(c));
    return c;
  }

  privateRoom(code: string | null): RoomHandle | null {
    if (code) return this.get(`priv-${code}`) ?? null;
    const c = this.newPrivateCode();
    return this.open({
        id: `priv-${c}`,
        mode: 'private',
        name: `Private · ${c}`,
        code: c,
        maxPlayers: this.cfg.privateRoomCapacity,
        map: { scale: this.mapSettings.mapScale('private') },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Custom rooms (paid private rooms with their own rules)           */
  /* ---------------------------------------------------------------- */

  /** Plugs in the custom-room service (expiry sweeps, the rooms' own leaderboards). */
  setCustomRooms(hooks: CustomRoomHooks | null): void {
    this.custom = hooks;
  }

  /**
   * Opens a free custom room `priv-<code>` (with the practice bots its creator asked for, if any).
   * Throws when the code is taken.
   */
  createCustomRoom(code: string, opts: Omit<RoomOptions, 'id' | 'mode' | 'code' | 'bots'> & { bots: PracticeBotsOptions | null }): RoomHandle {
    const id = `priv-${code}`;
    if (this.has(id)) throw new Error(`room ${id} exists`);
    this.closedCodes.delete(code);
    return this.open({ ...opts, id, mode: 'private', code });
  }

  /** Closes a custom room: everyone in it goes back to the lobby with `message`. False when it is not open. */
  closeCustomRoom(code: string, message: string): boolean {
    const room = this.get(`priv-${code}`);
    if (!room?.opts.custom) return false;
    // a paid room's tickets are never evicted: it closes once its bell settled them all
    if (isPaidCustom(room.opts)) return this.closePaidRoom(code, message) === 'closed';
    try {
      if (room instanceof RemoteRoom) this.pool!.closeRoom(room, message);
      else (room as Room).evict(message);
    } finally {
      this.drop(room);
      this.rememberClosed(room);
    }
    return true;
  }

  /** Remembers that the custom room `room` closed (an hour): a free one by its code, a paid one with its arena. */
  private rememberClosed(room: Pick<RoomHandle, 'opts'>): void {
    const code = room.opts.code;
    if (!code) return;
    this.closedCodes.set(code, { at: Date.now(), arenaId: isPaidCustom(room.opts) ? (room.opts.stake?.arenaId ?? null) : null });
  }

  /** The custom room `code` closed within the last hour. */
  customClosedLately(code: string, now = Date.now()): boolean {
    const m = this.closedCodes.get(code);
    return m !== undefined && now - m.at < CLOSED_MEMO_MS;
  }

  /**
   * The paid custom room `code`, an instance of `arenaId`, closed within the last hour. A free room's code (a practice
   * room's too) or another arena's never answers yes: only a ticket of the room's own arena may go back through it.
   */
  paidClosedLately(arenaId: number, code: string, now = Date.now()): boolean {
    const m = this.closedCodes.get(code);
    return m !== undefined && m.arenaId === arenaId && now - m.at < CLOSED_MEMO_MS;
  }

  /**
   * Closes a paid custom room only when nothing of value is left in it: no ticket (live or AFK), no
   * loot on its floor, no player. Then its spectators go back to the lobby with `message`. The room's
   * bell settles every ticket and burns the floor loot, so a closing room (no new seats) drains at its
   * next bell. `closed`: gone now (or was gone); `pending`: still holds a ticket or loot, or a room
   * worker was asked (it answers through `onClosed`). Never settles or evicts a ticket.
   */
  closePaidRoom(code: string, message: string): 'closed' | 'pending' {
    const room = this.get(`priv-${code}`);
    if (!room) return 'closed';
    if (!isPaidCustom(room.opts)) return 'pending';
    if (room instanceof RemoteRoom) {
      if (!room.closing && !room.closed) this.pool!.closeSettled(room, message);
      return 'pending';
    }
    if (!(room as Room).closeSettled(message)) return 'pending';
    this.drop(room);
    this.rememberClosed(room);
    return 'closed';
  }

  /** Live custom rooms. */
  customRooms(): RoomHandle[] {
    return [...this.handles()].filter((r) => !!r.opts.custom);
  }

  /**
   * The arenas a paid custom room can be opened on now: allowed, enabled on chain, not kept closed by
   * the vault guard. Throws `ChainBusyError` only when no arena list was ever read.
   */
  async paidArenas(): Promise<PaidArena[]> {
    if (!this.chain.stakeEnabled) return [];
    const out: PaidArena[] = [];
    for (const [id, a] of await this.arenas()) {
      if (!a.enabled || !this.arenaAllowed(id) || this.underfunded.has(id)) continue;
      out.push({ arenaId: id, buyIn: a.buyIn, holdersOnly: a.holdersOnly === true });
    }
    return out.sort((a, b) => a.buyIn - b.buyIn || a.arenaId - b.arenaId);
  }

  /**
   * Opens a paid custom room `priv-<code>`: a private instance (number 0) of arena `stake.arenaId`
   * with the creator's rules, on its own clock (`ownRound`: one game to the room's end, never the arenas' bell). Joined only with `arena:<id>:<code>` and a ticket of that arena; never
   * listed, never picked by `arenaRoom` (quick play), never closed by the idle cleanup. Throws when
   * the code is taken.
   */
  createPaidRoom(code: string, opts: Omit<RoomOptions, 'id' | 'mode' | 'code' | 'bots' | 'instance' | 'stake'> & { stake: { arenaId: number; buyIn: number } }): RoomHandle {
    const id = `priv-${code}`;
    if (this.has(id)) throw new Error(`room ${id} exists`);
    this.closedCodes.delete(code);
    return this.open({ ...opts, id, mode: 'arena', code, instance: 0 });
  }

  /**
   * The paid custom room `code` for a new seat with a ticket of `arenaId`: the arena must be
   * allowed, enabled on chain and not kept closed by the vault guard (as for `arenaRoom`), the room
   * must be an instance of that arena and take seats (not closing, time left). Otherwise why not:
   * `missing` (no paid room of this arena with that code: a free or practice room's code, or another arena's, closed
   * or not), `closed` (this arena's paid room closed lately or is closing), `arena` (the arena itself is not available).
   */
  async paidRoom(arenaId: number, code: string): Promise<RoomHandle | 'missing' | 'closed' | 'arena'> {
    const room = this.get(`priv-${code}`);
    if (!room) return this.paidClosedLately(arenaId, code) ? 'closed' : 'missing';
    if (!isPaidCustom(room.opts) || room.opts.stake?.arenaId !== arenaId) return 'missing';
    if (!this.paidSeatable(room)) return 'closed';
    if (!this.arenaAllowed(arenaId) || this.underfunded.has(arenaId)) return 'arena';
    let arena: ArenaData | undefined;
    try {
      arena = (await this.arenas()).get(arenaId);
    } catch (err) {
      // no list was ever read: a paid room only seats while its arena runs here
      arena = this.arenaFromRooms(arenaId) ?? undefined;
      if (!arena) throw err;
    }
    if (!arena || !arena.enabled || this.underfunded.has(arenaId)) return 'arena';
    if (this.get(room.id) !== room || !this.paidSeatable(room)) return 'closed';
    room.lastActivity = Date.now();
    return room;
  }

  /** Re-validates a paid room after a join's awaits: still open here, not full, still taking seats. */
  confirmPaidRoom(room: RoomHandle): RoomHandle | null {
    if (this.get(room.id) !== room || room.isFull || !this.paidSeatable(room)) return null;
    if (room.opts.stake && this.underfunded.has(room.opts.stake.arenaId)) return null;
    room.lastActivity = Date.now();
    return room;
  }

  /**
   * The seats of the paid custom room `code` when it is an instance of `arenaId` that takes new seats now (open here,
   * not closing, its joins open: not in its last minute, its arena allowed and not kept closed); else null.
   * Synchronous: a join permit is bound to the room with it (`JoinPermits`, audit R4-M1).
   */
  paidRoomSeats(arenaId: number, code: string, now = this.now()): number | null {
    const room = this.get(`priv-${code}`);
    if (!room || !isPaidCustom(room.opts) || room.opts.stake?.arenaId !== arenaId || !this.paidSeatable(room)) return null;
    if (!this.arenaAllowed(arenaId) || this.underfunded.has(arenaId) || this.arenaCache?.ids.get(arenaId)?.enabled === false) return null;
    const w = this.roomWindow(room, now);
    if (now < w.opensAt || now >= w.joinsCloseAt) return null;
    return Math.max(1, room.opts.maxPlayers);
  }

  /**
   * The arena takes seats as far as the server knows (synchronously): not kept closed (the books guard, a re-price),
   * not disabled at the last read of the arena list. An unseated ticket refunded while it does is a no-show unless the
   * server owes the excuse (the gateway's `refundUnseated`, as the stale sweeper decides).
   */
  arenaTakesSeats(arenaId: number): boolean {
    if (this.blockedArenas().some((b) => b.arenaId === arenaId)) return false;
    return this.arenaCache?.ids.get(arenaId)?.enabled !== false;
  }

  private paidSeatable(room: RoomHandle): boolean {
    if (room instanceof RemoteRoom && (room.closed || room.closing)) return false;
    const code = room.opts.code;
    return !!code && (this.custom?.seatable ? this.custom.seatable(code) : true);
  }

  /* ---------------------------------------------------------------- */
  /* Arenas (sharded into instances)                                  */
  /* ---------------------------------------------------------------- */

  /**
   * The on-chain arenas, cached 60 s. When the chain cannot be read the last good list is used (and
   * read again 10 s later): a rate-limited RPC must never make a running arena "not available". Throws
   * (`ChainBusyError`) only when no list was ever read.
   */
  private async arenas(): Promise<Map<number, ArenaData>> {
    if (this.arenaCache && Date.now() - this.arenaCache.at < ARENA_CACHE_MS) return this.arenaCache.ids;
    let list;
    try {
      list = await this.chain.listArenas();
    } catch (err) {
      if (!this.arenaCache) throw err;
      this.arenaCache.at = Date.now() - ARENA_CACHE_MS + ARENA_RETRY_MS;
      return this.arenaCache.ids;
    }
    const ids = new Map<number, ArenaData>(
      list.map((a) => [a.id, { buyIn: a.entryFee, maxPlayers: a.maxSessions, enabled: a.enabled, pot: a.pot, holdersOnly: a.holdersOnly === true }]),
    );
    this.arenaCache = { at: Date.now(), ids };
    this.followPrices(ids);
    await this.recheckVaults(ids);
    return ids;
  }

  /**
   * The owner re-priced an arena on chain (`updateArena`, only possible while none of its tickets is open): the rooms
   * of that arena take the new price for their own figures (`RoomHandle.setBuyIn`). Tickets are not touched: each
   * one keeps the entry fee its session recorded.
   */
  private followPrices(ids: Map<number, ArenaData>): void {
    for (const [id, a] of ids) {
      for (const room of this.ticketRooms(id)) {
        if (!room.opts.stake || room.opts.stake.buyIn === a.buyIn) continue;
        this.deps.log(`arena #${id}: ticket price ${room.opts.stake.buyIn} -> ${a.buyIn} (ledger units) on chain; ${room.id} follows`);
        room.setBuyIn(a.buyIn);
      }
    }
  }

  /**
   * Vault guard while the server runs: on every arena refresh, every arena's vault is
   * compared with what the journal owes it, so a disable → sweep → re-enable sequence is
   * caught even when it happens between two refreshes. A healthy vault clears a stale entry.
   *
   * The arena list is cached, so the pot of a running arena can trail joins that the journal
   * already counts (live tickets). A shortfall of an arena that was enabled at the last read
   * too is therefore confirmed with a fresh chain read before the arena is blocked; a
   * disabled or just re-enabled arena is blocked at once (no joins can explain its shortfall).
   * Live instances do not exempt an arena: a blocked arena sells no ticket.
   */
  private async recheckVaults(ids: Map<number, ArenaData>): Promise<void> {
    let fresh: Map<number, number | null> | null = null;
    for (const [id, a] of ids) {
      const before = this.lastEnabled.get(id);
      this.lastEnabled.set(id, a.enabled);
      if (a.pot === null) continue;
      const owed = this.deps.journal.owedByArena(id);
      if (a.pot >= owed || this.underfunded.has(id) || !a.enabled || before !== true) {
        this.vaultCovers(id, a);
        continue;
      }
      try {
        fresh ??= new Map((await this.chain.listArenas(true)).map((x) => [x.id, x.pot]));
      } catch {
        continue;
      }
      const pot = fresh.get(id);
      if (pot === undefined || pot === null) continue;
      this.vaultCovers(id, { ...a, pot });
    }
  }

  /**
   * Every open public instance of an arena, by instance number: what quick play, matchmaking and
   * spectating pick from. Paid custom rooms (private instances) are never among them.
   */
  arenaInstances(arenaId: number): RoomHandle[] {
    return this.publicInstances()
      .filter((r) => r.opts.stake?.arenaId === arenaId)
      .sort((a, b) => (a.opts.instance ?? 1) - (b.opts.instance ?? 1));
  }

  /** Every public arena instance (of every arena): never a paid custom room, never a test arena. */
  private publicInstances(): RoomHandle[] {
    return [...this.handles()].filter((r) => r.opts.mode === 'arena' && !!r.opts.stake && !isPaidCustom(r.opts) && !r.opts.test);
  }

  /**
   * The scaler opens one more instance of an arena (ahead of demand, an overflow seat or the minimum): only while
   * the arena is allowed, enabled at the last chain read and not kept closed by the vault guard.
   */
  private openScaledInstance(arenaId: number): RoomHandle | null {
    if (!this.arenaAllowed(arenaId) || this.underfunded.has(arenaId)) return null;
    const arena = this.arenaCache?.ids.get(arenaId) ?? this.arenaFromRooms(arenaId);
    if (!arena || !arena.enabled) return null;
    if (this.arenaInstances(arenaId).length === 0 && !this.vaultCovers(arenaId, arena)) return null;
    return this.createArenaInstance(arenaId, arena);
  }

  /**
   * A drained instance closes once nothing of value is left in it (no player, no ticket, no loot: its bell settled
   * them); its spectators go back to the lobby. Never evicts a ticket.
   */
  private closeDrained(room: RoomHandle): 'closed' | 'pending' {
    const message = 'Fewer players now: this arena instance closed. Pick the arena again to play.';
    if (room instanceof RemoteRoom) {
      if (!room.closing && !room.closed) this.pool!.closeSettled(room, message);
      return 'pending';
    }
    if (!(room as Room).closeSettled(message)) return 'pending';
    this.drop(room);
    return 'closed';
  }

  /** Every room that seats tickets of an arena: its public instances, its paid custom rooms and its test arena. */
  private ticketRooms(arenaId: number): RoomHandle[] {
    return [...this.handles()].filter((r) => r.opts.mode === 'arena' && r.opts.stake?.arenaId === arenaId);
  }

  private createArenaInstance(arenaId: number, arena: ArenaData): RoomHandle {
    const taken = new Set(this.arenaInstances(arenaId).map((r) => r.opts.instance ?? 1));
    let n = 1;
    while (taken.has(n)) n++;
    const meta = arenaMeta(arenaId);
    return this.open({
        id: `arena-${arenaId}-${n}`,
        mode: 'arena',
        name: n === 1 ? meta.name : `${meta.name} #${n}`,
        instance: n,
        maxPlayers: this.cfg.arenaInstanceCap,
        map: { scale: this.mapSettings.mapScale('arena') },
        stake: { arenaId, buyIn: arena.buyIn },
    });
  }

  /**
   * Vault guard, checked when an arena is attached (no instance yet in this
   * process): its on-chain vault must hold at least what the journal says it owes (loot +
   * pending payouts + loot sweeps + live tickets). A vault swept or drained while loot was journaled
   * would otherwise pay old loot with other players' entry fees, or fail `InsufficientPot`.
   * An underfunded arena stays disabled (re-checked on every attach attempt) and is logged
   * loudly once.
   */
  private vaultCovers(arenaId: number, arena: ArenaData): boolean {
    if (arena.pot === null) return true;
    const owed = this.deps.journal.owedByArena(arenaId);
    if (arena.pot >= owed) {
      if (this.underfunded.delete(arenaId)) this.deps.log(`arena #${arenaId}: vault ${arena.pot} now covers the journal (${owed}) — enabled again`);
      return true;
    }
    if (!this.underfunded.has(arenaId)) {
      const msg =
        `!!! arena #${arenaId} KEPT DISABLED: its vault holds ${arena.pot} raw units but the journal owes ${owed} ` +
        `(loot + pending payouts + loot sweeps + live tickets). Was the arena swept? Do not re-enable a swept arena; ` +
        `top up the vault or settle the journal by hand before attaching it.`;
      this.underfunded.set(arenaId, msg);
      this.deps.log(msg);
    }
    return false;
  }

  /** Arenas the vault guard keeps disabled (id → reason). */
  underfundedArenas(): ReadonlyMap<number, string> {
    return this.underfunded;
  }

  /** The public form of `underfundedArenas` (rooms message, `/api/rooms`): the lobby must not sell these. */
  blockedArenas(): BlockedArena[] {
    const out: BlockedArena[] = [...this.underfunded.keys()].map((arenaId) => ({ arenaId, reason: 'vault_short' }));
    for (const arenaId of this.repricingArenas?.() ?? []) if (!this.underfunded.has(arenaId)) out.push({ arenaId, reason: 'repricing' });
    return out.sort((a, b) => a.arenaId - b.arenaId);
  }

  /** Arenas closed for a re-price (shown to the lobby as blocked); set by the app. */
  repricingArenas: (() => Iterable<number>) | null = null;

  /** Live coins (seated tickets) of an arena over every room. */
  liveStakesOf(arenaId: number): number {
    let n = 0;
    for (const r of this.ticketRooms(arenaId)) n += r.liveSessions().length;
    return n;
  }

  private arenaAllowed(arenaId: number): boolean {
    return this.chain.stakeEnabled && (this.cfg.chain.arenaIds.length === 0 || this.cfg.chain.arenaIds.includes(arenaId));
  }

  /**
   * Room for a new arena player: the fullest instance `arena-<id>-<n>` that takes seats and is not full, else a
   * draining one taken back, else a new instance (`ArenaScaler.seatFor`). Null when the arena does not exist or
   * is disabled.
   */
  async arenaRoom(arenaId: number): Promise<RoomHandle | null> {
    if (!this.arenaAllowed(arenaId)) return null;
    let arena: ArenaData | undefined;
    try {
      arena = (await this.arenas()).get(arenaId);
    } catch (err) {
      // the chain cannot be read and no list is known: an arena already running here keeps seating its players
      arena = this.arenaFromRooms(arenaId) ?? undefined;
      if (!arena) throw err;
    }
    if (!arena || !arena.enabled) return null;
    if (this.underfunded.has(arenaId)) return null;
    if (this.arenaInstances(arenaId).length === 0 && !this.vaultCovers(arenaId, arena)) return null;
    const room = this.scaler.seatFor(arenaId);
    if (!room) return null;
    // a join is under way: keep cleanup from closing this (possibly idle) instance meanwhile
    room.lastActivity = Date.now();
    return room;
  }

  /**
   * Re-validates a room picked by `arenaRoom` after the join's awaits: it must
   * still be in the map (cleanup may have closed it) and have space. Otherwise
   * picks again, with the same checks. Null when no live room is available.
   */
  async confirmArenaRoom(arenaId: number, room: RoomHandle): Promise<RoomHandle | null> {
    const live = (r: RoomHandle | null): r is RoomHandle => r !== null && this.get(r.id) === r && this.scaler.seatable(r);
    if (live(room)) {
      room.lastActivity = Date.now();
      return room;
    }
    const again = await this.arenaRoom(arenaId);
    return live(again) ? again : null;
  }

  /**
   * The seat itself, synchronous: called right before `join`, with nothing awaited in between. Joins whose last awaits
   * resolve in the same tick (a join storm whose ticket reads were merged into one multicall) all confirmed the same
   * instance before any of them sat down; checked again here, each takes the seat that is really free (the instance,
   * or the next one `ArenaScaler.seatFor` gives, a new instance included). Null when the arena has no seat now.
   */
  seatArenaNow(arenaId: number, room: RoomHandle): RoomHandle | null {
    const live = (r: RoomHandle | null): r is RoomHandle => r !== null && this.get(r.id) === r && this.scaler.seatable(r);
    if (live(room)) return room;
    if (!this.arenaAllowed(arenaId) || this.underfunded.has(arenaId)) return null;
    const again = this.scaler.seatFor(arenaId);
    if (!live(again)) return null;
    again.lastActivity = Date.now();
    return again;
  }

  /** What a running instance knows of its arena (its ticket price), for when the chain cannot be read. */
  private arenaFromRooms(arenaId: number): ArenaData | null {
    const first = this.arenaInstances(arenaId)[0];
    if (!first?.opts.stake) return null;
    return { buyIn: first.opts.stake.buyIn, maxPlayers: this.cfg.arenaInstanceCap, enabled: true, pot: null };
  }

  /**
   * The room to spectate for `id`. An arena instance that does not exist (yet, or any more) resolves
   * to the arena's first instance, created on demand from the arena list (cached; the chain serves its
   * last good list when the RPC refuses us): a restart while the RPC is rate-limited must not answer
   * "Room not found" for a running arena. Null when there is no such room or arena.
   */
  async spectateRoom(id: string): Promise<RoomHandle | null> {
    const room = this.get(id);
    if (room) return room;
    const m = /^arena-(\d{1,5})-\d{1,4}$/.exec(id);
    if (!m) return null;
    const arenaId = Number(m[1]);
    const first = this.arenaInstances(arenaId)[0];
    if (first) return first;
    if (!this.arenaAllowed(arenaId)) return null;
    let a: ArenaData | undefined;
    try {
      a = (await this.arenas()).get(arenaId);
    } catch {
      return null;
    }
    if (!a || !a.enabled || this.underfunded.has(arenaId)) return null;
    // the awaits above may have created it meanwhile
    const again = this.arenaInstances(arenaId)[0];
    if (again) return again;
    if (!this.vaultCovers(arenaId, a)) return null;
    return this.createArenaInstance(arenaId, a);
  }

  /** Whether `wallet` holds a live arena coin in any room (its reconnect is admitted before anyone else). */
  holdsLiveStake(wallet: string): boolean {
    return this.liveStake(wallet) !== null;
  }

  /** The live arena coin `wallet` holds in any room (an arena instance, a paid custom room, a test arena), if any. */
  liveStake(wallet: string): { room: RoomHandle; entry: StakeSeat; arenaId: number } | null {
    for (const room of this.handles()) {
      if (room.opts.mode !== 'arena' || !room.opts.stake) continue;
      const entry = room.findStakeByWallet(wallet);
      if (entry) return { room, entry, arenaId: room.opts.stake.arenaId };
    }
    return null;
  }

  /** The room of `arenaId` (a public instance or a paid custom room) in which `wallet` holds a live ticket, if any. */
  findArenaStake(arenaId: number, wallet: string): { room: RoomHandle; entry: StakeSeat } | null {
    for (const room of this.ticketRooms(arenaId)) {
      const entry = room.findStakeByWallet(wallet);
      if (entry) return { room, entry };
    }
    return null;
  }

  /** Forgets the cached arena list and attaches every enabled arena now (the token was just set). */
  async refreshArenas(): Promise<void> {
    this.arenaCache = null;
    await this.ensureArenaRooms();
  }

  /**
   * Makes sure every enabled arena has its first instance (shown in the lobby;
   * it also adopts loot journaled by any instance before a restart).
   */
  async ensureArenaRooms(): Promise<void> {
    if (!this.chain.stakeEnabled) return;
    try {
      for (const [id, a] of await this.arenas()) {
        if (!a.enabled || !this.arenaAllowed(id)) continue;
        if (this.underfunded.has(id)) continue;
        if (this.arenaInstances(id).length === 0 && !this.vaultCovers(id, a)) continue;
        if (!this.has(`arena-${id}-1`)) this.createArenaInstance(id, a);
        if (this.testActive() && !this.has(testArenaRoomId(id))) this.createTestArena(id, a);
      }
    } catch (err) {
      this.deps.log(`arena discovery failed: ${(err as Error).message}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Test arenas (testnet only)                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Test arenas are open now: the admin switch is on and the chain is a testnet, both the configured `CHAIN_ID`
   * (the store) and the chain the RPC serves once it was read. Never on the mainnet.
   */
  testActive(): boolean {
    if (!this.testArenas.active) return false;
    const served = this.chain.status().chainId;
    return testArenasAllowedOn(this.cfg.chain.chainId) && (served === null || served === undefined || testArenasAllowedOn(served));
  }

  /** Every test arena in the directory (closing ones too). */
  testRooms(): RoomHandle[] {
    return [...this.handles()].filter((r) => !!r.opts.test);
  }

  /**
   * Opens the test arena of an arena: `test-<id>`, an arena instance (number 0) on the official arena's tickets and
   * vault, with the admin's practice bots (arriving one by one; every person in it takes one bot's place, see
   * `PracticeBots`). Never on a chain that is not a testnet.
   */
  private createTestArena(arenaId: number, arena: ArenaData): RoomHandle | null {
    if (!this.testActive()) return null;
    const s = this.testArenas.settings;
    this.closingTests.delete(testArenaRoomId(arenaId));
    this.deps.log(`test arenas: opening ${testArenaRoomId(arenaId)} (${s.bots} ${s.difficulty} bots when empty, chain ${this.cfg.chain.chainId})`);
    return this.open({
      id: testArenaRoomId(arenaId),
      mode: 'arena',
      name: testArenaName(arenaMeta(arenaId).name),
      instance: 0,
      maxPlayers: this.cfg.arenaInstanceCap,
      map: { scale: this.mapSettings.mapScale('arena') },
      stake: { arenaId, buyIn: arena.buyIn },
      test: { chainId: this.cfg.chain.chainId },
      bots: { count: s.bots, difficulty: s.difficulty, max: TEST_ARENA_BOTS.max, arriveMs: TEST_ARENA_ARRIVE_MS },
    });
  }

  /** The test arena takes new seats: still here, not closing, test arenas on. */
  private testSeatable(room: RoomHandle): boolean {
    if (!room.opts.test || this.get(room.id) !== room || this.closingTests.has(room.id)) return false;
    if (room instanceof RemoteRoom && room.closed) return false;
    return this.testActive();
  }

  /**
   * The test arena of `arenaId` for a new seat (opened on demand): the arena must be allowed, enabled on chain and
   * not kept closed by the vault guard, exactly as for its public instances. `missing`: test arenas are off (or this
   * is not a testnet); `closed`: it is closing; `arena`: the arena itself is not available.
   */
  async testRoom(arenaId: number): Promise<RoomHandle | 'missing' | 'closed' | 'arena'> {
    if (!this.testActive()) return 'missing';
    if (!this.arenaAllowed(arenaId) || this.underfunded.has(arenaId)) return 'arena';
    let arena: ArenaData | undefined;
    try {
      arena = (await this.arenas()).get(arenaId);
    } catch (err) {
      arena = this.arenaFromRooms(arenaId) ?? undefined;
      if (!arena) throw err;
    }
    if (!arena || !arena.enabled || this.underfunded.has(arenaId)) return 'arena';
    if (!this.testActive()) return 'missing';
    let room = this.get(testArenaRoomId(arenaId)) ?? null;
    if (!room) {
      if (this.arenaInstances(arenaId).length === 0 && !this.vaultCovers(arenaId, arena)) return 'arena';
      room = this.createTestArena(arenaId, arena);
      if (!room) return 'missing';
    }
    if (!this.testSeatable(room)) return 'closed';
    room.lastActivity = Date.now();
    return room;
  }

  /** Re-validates a test arena after a join's awaits: still open here, not full, still taking seats. */
  confirmTestRoom(room: RoomHandle): RoomHandle | null {
    if (room.isFull || !this.testSeatable(room)) return null;
    if (room.opts.stake && this.underfunded.has(room.opts.stake.arenaId)) return null;
    room.lastActivity = Date.now();
    return room;
  }

  /**
   * The admin changed the settings: with test arenas on, every test arena takes the new bots and missing ones open;
   * turned off, every test arena stops taking seats and closes once its bell settled every ticket in it (nobody is
   * evicted, no ticket is touched).
   */
  private applyTestArenaSettings(): void {
    if (!this.testActive()) {
      this.closeTestArenas();
      return;
    }
    const s = this.testArenas.settings;
    // turned on again before a closing test arena was gone: it takes seats again
    this.closingTests.clear();
    for (const room of this.testRooms()) room.setBots(s.bots, s.difficulty);
    void this.ensureArenaRooms();
  }

  /** Closes every test arena once nothing of value is left in it (see `applyTestArenaSettings`). */
  private closeTestArenas(): void {
    const message = 'Test arenas are off now: this test arena closed.';
    for (const room of this.testRooms()) {
      this.closingTests.add(room.id);
      // a room worker answers through `onClosed` (not yet: asked again at the next cleanup)
      if (room instanceof RemoteRoom) {
        if (!room.closing && !room.closed) this.pool!.closeSettled(room, message);
      } else if ((room as Room).closeSettled(message)) this.drop(room);
    }
    for (const id of [...this.closingTests]) if (!this.has(id)) this.closingTests.delete(id);
  }

  /** `GET /api/admin/test-arenas`: the switch, the bot settings, every test arena now. */
  testArenaView(): TestArenaView {
    return {
      available: this.testArenas.available && testArenasAllowedOn(this.chain.status().chainId ?? this.cfg.chain.chainId),
      chainId: this.cfg.chain.chainId,
      active: this.testActive(),
      settings: this.testArenas.settings,
      defaults: { ...TEST_ARENA_DEFAULT },
      limits: { botsMin: TEST_ARENA_BOTS.min, botsMax: TEST_ARENA_BOTS.max },
      rooms: this.testRooms()
        .sort((a, b) => (a.opts.stake?.arenaId ?? 0) - (b.opts.stake?.arenaId ?? 0))
        .map((r) => {
          const thread = r instanceof RemoteRoom ? `w${r.slot.index}` : undefined;
          return {
            arenaId: r.opts.stake?.arenaId ?? 0,
            id: r.id,
            name: r.opts.name,
            people: r.humanCount,
            bots: r.botCounts().bots,
            capacity: r.opts.maxPlayers,
            closing: this.closingTests.has(r.id),
            ...(thread ? { thread } : {}),
          };
        }),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Map settings                                                     */
  /* ---------------------------------------------------------------- */

  /** Re-applies the map settings to every room (an admin change, no restart); custom rooms keep their creator's map. */
  applyMapSettings(): void {
    for (const room of this.handles()) {
      if (room.opts.custom) continue;
      room.setMapScale(this.mapSettings.mapScale(mapKindOf(room.opts.mode, room.opts.league)));
    }
  }

  /** The curve a custom room whose creator picked "Auto" sizes its map by (the private rooms' curve, always on). */
  customMapScale(): MapScaleSettings {
    return { ...this.mapSettings.mapScale('private'), auto: true };
  }

  /** Every room's people, bots and map now (`GET /api/admin/maps`). */
  roomCounts(): { id: string; kind: MapRoomKind; name: string; arenaId?: number; humans: number; bots: number; mapSide: number; mapAuto: boolean }[] {
    return [...this.handles()].map((r) => ({
      id: r.id,
      kind: mapKindOf(r.opts.mode, r.opts.league),
      name: r.opts.name,
      ...(r.opts.stake ? { arenaId: r.opts.stake.arenaId } : {}),
      ...r.botCounts(),
      mapSide: r.mapSide(),
      mapAuto: r.mapScale()?.auto ?? false,
    }));
  }

  /** The public room directory (lobby, `/api/rooms`): private rooms and paid custom rooms are never in it. */
  list(): RoomInfo[] {
    return [...this.handles()].filter((r) => r.opts.mode !== 'private' && !isPaidCustom(r.opts)).map((r) => r.info());
  }

  online(): number {
    return this.conns.size;
  }

  liveSessions(): Set<string> {
    const s = new Set<string>();
    for (const r of this.handles()) for (const k of r.liveSessions()) s.add(k);
    return s;
  }

  /** Takes a wallet's profile picture off its live coins in every room (moderation, a new upload). */
  clearAvatar(wallet: string): number {
    this.pool?.clearAvatar(wallet);
    let n = 0;
    for (const r of this.rooms.values()) n += r.clearAvatar(wallet);
    return n;
  }

  connsByWallet(wallet: string): Conn[] {
    return [...this.conns].filter((c) => c.wallet === wallet);
  }

  /** The wallet's power-up charges changed (a purchase): its players in rooms get the new state. */
  pushBoosts(wallet: string): void {
    const w = wallet.toLowerCase();
    for (const c of this.conns) if (c.wallet?.toLowerCase() === w && c.room && c.player?.alive) c.room.sendBoosts(c);
  }

  /* ---------------------------------------------------------------- */
  /* Loop                                                             */
  /* ---------------------------------------------------------------- */

  start(): void {
    if (this.pool) {
      // the rooms tick in their workers; this thread keeps the directory's own chores
      this.housekeepingTimer = setInterval(() => this.housekeeping(Date.now()), 1000);
      return;
    }
    this.stopLoop = startTickLoop(() => this.tickAll(TICK_MS), TICK_MS);
  }

  stop(): void {
    this.stopLoop?.();
    this.stopLoop = null;
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = null;
  }

  tickAll(dt: number): void {
    const t0 = performance.now();
    for (const room of this.rooms.values()) {
      const r0 = performance.now();
      try {
        room.tick(dt);
      } catch (err) {
        this.deps.log(`room ${room.id} tick failed: ${(err as Error).stack ?? err}`);
      }
      roomTickStats(room).record(performance.now() - r0);
    }
    this.tickStats.record(performance.now() - t0);
    this.housekeeping(Date.now());
  }

  /** Expired custom rooms (every second), the arena scaler (every 5 s) and idle rooms (every 15 s). */
  private housekeeping(now: number): void {
    try {
      this.scaler.tick();
    } catch (err) {
      this.deps.log(`arena scaling failed: ${(err as Error).stack ?? err}`);
    }
    if (this.custom && now - this.lastCustomSweep >= 1000) {
      this.lastCustomSweep = now;
      try {
        this.custom.sweep();
      } catch (err) {
        this.deps.log(`custom rooms: sweep failed: ${(err as Error).stack ?? err}`);
      }
    }
    if (now - this.lastCleanup > 15_000) {
      this.lastCleanup = now;
      this.cleanup(now);
    }
  }

  private cleanup(now: number): void {
    for (const [key, m] of this.bellMemo) if (now - m.at > BELL_MEMO_MS) this.bellMemo.delete(key);
    // closing test arenas (the switch went off): gone once their bell settled them
    if (this.closingTests.size > 0 && !this.testActive()) this.closeTestArenas();
    for (const room of [...this.handles()]) {
      const idle = room.connCount === 0 && room.humanCount === 0;
      if (!idle) continue;
      const close =
        // custom rooms live until their time runs out (the custom-room service closes them)
        (room.opts.mode === 'private' && !room.opts.custom && now - room.lastActivity > 120_000) ||
        // every league keeps its first room
        // (arena instances are consolidated by the scaler; paid custom rooms by the custom-room service, at their end)
        (room.opts.mode === 'practice' && !room.id.endsWith('-1') && now - room.lastActivity > 300_000);
      if (!close) continue;
      // a room worker drops it only if it is still idle there (a join may be on its way)
      if (room instanceof RemoteRoom) {
        if (!room.closing) this.pool!.closeIdle(room);
      } else this.drop(room);
    }
    for (const [ip, at] of this.promotions) if (now - at >= PROMOTION_MS) this.promotions.delete(ip);
    for (const [code, m] of this.closedCodes) if (now - m.at >= CLOSED_MEMO_MS) this.closedCodes.delete(code);
  }

  /**
   * The tick p95 (ms) of the game thread with the most headroom: the worker a new room would go to, or the main
   * thread in single-thread mode. Null while nothing was measured. Read by the load shedder (`net/shedder.ts`).
   */
  bestTickP95Ms(): number | null {
    if (!this.pool) {
      const s = this.tickStats.summary();
      return s.n > 0 ? s.p95Ms : null;
    }
    let best: number | null = null;
    for (const t of this.pool.threads()) if (t.up !== false && t.tick.n > 0) best = best === null ? t.tick.p95Ms : Math.min(best, t.tick.p95Ms);
    return best;
  }

  /** Per-thread load (`GET /api/admin/load`, the load test). `rooms`: with every room's own figures. */
  loadStats(opts: { rooms?: boolean } = {}): ServerLoad {
    const now = performance.now();
    const secs = Math.max(0.001, (now - this.lastLoadAt) / 1000);
    this.lastLoadAt = now;
    const out = { bytes: wsOut.bytes - this.lastOut.bytes, msgs: wsOut.msgs - this.lastOut.msgs };
    this.lastOut = { bytes: wsOut.bytes, msgs: wsOut.msgs };
    let humans = 0;
    let bots = 0;
    let conns = 0;
    const roomLoads: RoomLoad[] = [];
    for (const r of this.rooms.values()) {
      const c = r.botCounts();
      humans += c.humans;
      bots += c.bots;
      conns += r.conns.size;
      if (opts.rooms) roomLoads.push({ id: r.id, humans: c.humans, conns: r.conns.size, bots: c.bots, tick: roomTickStats(r).summary() });
    }
    const threads = this.pool ? this.pool.threads().map((t) => (opts.rooms ? t : { ...t, roomLoads: undefined })) : [];
    if (this.pool) {
      for (const t of threads) {
        humans += t.humans;
        bots += t.bots;
        conns += t.conns;
      }
    }
    const tick = this.pool ? this.pool.relayStats.summary() : this.tickStats.summary();
    const main: ThreadLoad = { id: 'main', rooms: this.rooms.size, humans, conns, bots, tick, ...this.meter.sample(), ...(opts.rooms ? { roomLoads } : {}) };
    return {
      mode: this.pool ? 'workers' : 'single',
      workers: this.pool?.size ?? 0,
      cpus: availableParallelism(),
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
      main,
      threads,
      sentBytesPerSec: Math.round(out.bytes / secs),
      sentMsgsPerSec: Math.round(out.msgs / secs),
      conns: this.conns.size,
      at: Date.now(),
    };
  }

  /** Settles every staker (an operator exit). With room workers it waits for them (`await` it). */
  shutdown(): void | Promise<void> {
    this.stop();
    this.meter.stop();
    for (const room of this.rooms.values()) room.shutdown();
    return this.pool?.shutdown();
  }
}
