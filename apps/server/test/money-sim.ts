/**
 * Money simulation: real arena rooms (`Room`, the real world physics and ledger), the real journal on disk and
 * the real settlement worker (`EvmChain`) against a chain (the TypeScript model `FakeEvm`, or a real `hardhat node`
 * with the real ElymumArena v3: `hardhatSimChain` in `money-sim-hardhat.ts`). Random joins, eats, disconnects,
 * reconnects, unplayed tickets, loot spills, integrity holds (released or settled at 0), players whose transfers
 * fail (two-phase payouts), RPC errors, ambiguous sends, lost receipts, RPC outages, room-worker crashes and server
 * restarts (graceful and hard).
 *
 * The conservation checker (`checkBooks`) runs after every chain pass and asserts, per arena, in exact ledger units:
 *
 *   vault = Σ live values + Σ floor loot (rooms in memory)
 *         + Σ pending payouts whose ticket is still open on chain + Σ loot burns not yet applied
 *         + Σ forfeits (settled at 0, kept in the vault)
 *         + Σ entry fees of open tickets that are in no room and no pending item (bought, not seated yet)
 *
 * plus the contract's own books (deposited = vault + paid out + burned + fees) and the token supply (every token is
 * in a wallet, the arena, the fee wallet or burned). A share of the wallets hold the emblem (the arena's holder NFT):
 * their tickets must carry the holder pair (`DEFAULT_HOLDER_FEE_RATES`, 8 % + 2 % of the profit), everyone else's the
 * normal pair (15 % + 5 %), and every settlement's split must be the shared fee module's at the ticket's own rates. At the end everything is drained and the run asserts: no ticket
 * left open, no journal item left, every ticket closed exactly once (no double settlement, no lost ticket), every
 * vault holds exactly its forfeits.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProfitFee, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, PlayerFlag, ROBINHOOD_TESTNET_CHAIN_ID, roundAt, TEST_ARENA_ARRIVE_MS, TEST_ARENA_BOTS, testArenaRoomId, TICK_MS, type CustomDifficulty, type ServerMessage } from '@elymum/shared';
import type { ArenaInfo, SessionInfo } from '@elymum/sdk';
import { getAddress, type Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { EvmChain } from '../src/chain/evm';
import type { EvmClient } from '../src/chain/evm-client';
import { ChainBusyError, sessionKey } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { mulberry32 } from '../src/game/rng';
import { Leaderboards } from '../src/leaderboards';
import { Conn } from '../src/net/conn';
import { MAX_STAKE_SESSION_AGE_S, Room } from '../src/rooms/room';
import { Journal } from '../src/stake/journal';
import { ARENA, E18, FakeEvm, NFT } from './fake-evm';

/** One ticket closure on chain (the double-settlement and lost-ticket checks read these). */
export interface Closure {
  name: 'Settled' | 'Cancelled' | 'Refunded' | 'Collected';
  arenaId: number;
  player: string;
  sessionId: bigint;
  amount: bigint;
}

/** What the simulation needs from a chain: the server's client plus the players' side and the books. */
export interface SimChain {
  readonly name: string;
  /** The ElymumArena contract. */
  readonly arenaAddress: Address;
  /** What the game server talks to (the simulation wraps it with faults). */
  readonly client: EvmClient;
  readonly decimals: number;
  readonly wallets: Address[];
  /** The wallets holding the arena's holder NFT (lower case): their tickets get the holder pair. */
  readonly holders: ReadonlySet<string>;
  arenaIds(): number[];
  /** Entry fee (base units). */
  entryFee(arenaId: number): bigint;
  /** `approve` + `join` from the player's wallet; false when the contract refused. */
  buy(wallet: Address, arenaId: number): Promise<boolean>;
  /** `refund` from the player's wallet (collect what is owed, or the 24 h refund); false when refused. */
  refund(wallet: Address, arenaId: number): Promise<boolean>;
  /** Transfers to `wallet` fail (the contract finalizes its payouts as owed); undefined: not supported. */
  setRefusing?(wallet: Address, on: boolean): void;
  /** Moves the chain's clock forward. */
  advance(seconds: number): Promise<void>;
  nowS(): Promise<number>;
  arena(arenaId: number): Promise<ArenaInfo>;
  session(arenaId: number, wallet: Address): Promise<SessionInfo>;
  /** Token supply split: every player wallet, the arena contract, the fee wallet, burned; and what was ever minted. */
  tokens(): Promise<{ wallets: bigint; arena: bigint; feeWallet: bigint; burned: bigint; minted: bigint }>;
  closures(): Promise<Closure[]>;
  /**
   * The owner's `updateArena(id, entryFee, maxSessions, enabled)`: false when the contract refuses it (`ArenaBusy`: a
   * new entry fee while a ticket of the arena is open). Undefined: the chain does not model it.
   */
  updateArena?(arenaId: number, entryFee: bigint, enabled: boolean): Promise<boolean>;
  /**
   * `Joined` events whose rates are not the wallet's (the holder pair for a holder, else the normal pair) and `Settled`
   * events whose fee split is not the shared fee module's (`computeProfitFee`) for the ticket's own rates.
   */
  feeViolations(): Promise<string[]>;
  stop(): Promise<void>;
}

export interface SimFaults {
  /** Per server RPC call: a transient error (fetch failed / 429). */
  rpcError: number;
  /** Per server transaction: it is mined but the server hears an error (a timeout after the broadcast). */
  ambiguousSend: number;
  /** Per receipt read: none yet (the transaction is mined). */
  lostReceipt: number;
  /** Per round: the RPC is down for the next round. */
  outage: number;
  /** Per round: one arena instance's worker dies (its rooms are recovered from the journal). */
  workerCrash: number;
  /** Per round: the server restarts (half graceful: an operator exit; half a hard kill). */
  restart: number;
  /** Per profitable settlement: the integrity auto-hold keeps it; later released or settled at 0. */
  hold: number;
  /** Per ticket bought: the player never takes the seat (the stale sweeper cancels it). */
  unplayed: number;
  /** Per player and round: their token transfers fail for a while (the contract finalizes their payouts as owed). */
  refusing: number;
  /** Per round: a day passes (players refund held and unplayed tickets after 24 h themselves). */
  dayPasses: number;
  /** Per tick: a staker's value spills as floor loot (the path of something without a ticket eating a staker). */
  spill: number;
}

export const NO_FAULTS: SimFaults = { rpcError: 0, ambiguousSend: 0, lostReceipt: 0, outage: 0, workerCrash: 0, restart: 0, hold: 0, unplayed: 0, refusing: 0, dayPasses: 0, spill: 0 };
export const DEFAULT_FAULTS: SimFaults = {
  rpcError: 0.03,
  ambiguousSend: 0.04,
  lostReceipt: 0.05,
  outage: 0.03,
  workerCrash: 0.04,
  restart: 0.03,
  hold: 0.15,
  unplayed: 0.08,
  refusing: 0.02,
  dayPasses: 0.02,
  spill: 0.0005,
};

export interface SimOptions {
  seed: number;
  rounds: number;
  /** Arena instances per arena. */
  instances?: number;
  roundMs?: number;
  closeMs?: number;
  /** Ticks between two chain passes (and conservation checks). */
  passEvery?: number;
  faults?: Partial<SimFaults>;
  /** Unplayed tickets are cancelled after this (the chain clock moves on by `advance` between rounds). */
  staleAfterS?: number;
  /**
   * The testnet's test arenas: every arena also gets its test arena `test-<id>` (the same tickets and vault, practice
   * bots that carry no value), seated like any instance. The books must balance exactly as without them.
   */
  testArenas?: { bots: number; difficulty: CustomDifficulty };
  log?: (m: string) => void;
  /**
   * Mainnet re-pricing (the USD sync): every `everyRounds` rounds one arena is closed on chain (`updateArena(...,
   * enabled=false)`, as OPERATIONS.md tells the owner), and at each later bell the owner tries the new entry fee
   * (`newEntry` of the old one) with the arena re-opened; the contract refuses it while a ticket is open (`ArenaBusy`).
   * Tickets bought before keep their own entry fee; the books must balance across the change.
   */
  reprice?: { everyRounds: number; newEntry: (old: bigint, rng: () => number) => bigint };
}

/** What the re-pricing scenario did (`SimOptions.reprice`). */
export interface RepriceStats {
  /** Arenas closed for a sync, syncs done, and attempts the contract refused with `ArenaBusy`. */
  closed: number;
  synced: number;
  busy: number;
  /** Rounds an arena stayed closed until its sync went through (each sync), and the entry fees it went through. */
  pauseRounds: number[];
  entries: Record<number, string[]>;
}

export interface SimReport {
  chain: string;
  seed: number;
  rounds: number;
  ticks: number;
  checks: number;
  tickets: number;
  seated: number;
  unplayed: number;
  closures: Record<Closure['name'], number>;
  /** Per arena (base units): deposited, paid to players, burned (fees + loot), fees to the fee wallet, forfeited. */
  books: Record<number, { deposited: string; paidOut: string; burned: string; fees: string; vaultLeft: string; forfeited: number }>;
  faults: { rpcErrors: number; ambiguousSends: number; lostReceipts: number; outages: number; workerCrashes: number; restarts: number; hardKills: number; holds: number; released: number; zeroed: number; refusingPlayers: number; spills: number; daysPassed: number; dayRefunds: number };
  /** The test-arena scenario: bots eaten by players (mass, no value) and stake cells eaten by bots (value spilled as loot). */
  testArenas: { rooms: number; botsEaten: number; botSpills: number; botSpillValue: number } | null;
  /** Emblem holders: wallets, tickets bought, tickets settled and settled with a profit (paying the holder pair). */
  holders: { wallets: number; tickets: number; settled: number; winners: number };
  /** Settled tickets paid more than their entry fee / less than it (eaten or shrunk). */
  winners: number;
  losers: number;
  violations: string[];
  /** The re-pricing scenario (null without `SimOptions.reprice`). */
  reprice: RepriceStats | null;
  ms: number;
}

class Faulty {
  rpcErrors = 0;
  ambiguousSends = 0;
  lostReceipts = 0;
  down = false;
  constructor(
    private readonly rng: () => number,
    private readonly f: SimFaults,
  ) {}
  on = true;

  wrap(inner: EvmClient): EvmClient {
    const reads = new Set(['session', 'arena', 'arenas', 'arenaConfig', 'blockNumber', 'joinedLogs', 'getChainId', 'balance']);
    return new Proxy(inner, {
      get: (target, prop, recv) => {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        const name = String(prop);
        if (name === 'send') {
          return async (...args: unknown[]) => {
            this.fail();
            const hash = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (this.on && this.rng() < this.f.ambiguousSend) {
              this.ambiguousSends++;
              throw new Error('The request took too long to respond. (timeout after broadcast)');
            }
            return hash;
          };
        }
        if (name === 'receipt') {
          return async (...args: unknown[]) => {
            if (this.on && this.rng() < this.f.lostReceipt) {
              this.lostReceipts++;
              return null;
            }
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        if (reads.has(name)) {
          return async (...args: unknown[]) => {
            this.fail();
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return v.bind(target);
      },
    });
  }

  private fail(): void {
    if (!this.on) return;
    if (this.down || this.rng() < this.f.rpcError) {
      this.rpcErrors++;
      throw this.rng() < 0.5 ? new TypeError('fetch failed') : Object.assign(new Error('HTTP request failed.\n\nStatus: 429'), { status: 429 });
    }
  }
}

function fakeConn(wallet: string): Conn {
  // a socket that always looks backed up: the rooms skip its snapshots (the simulation needs no frames)
  const ws = { readyState: 1, bufferedAmount: 1 << 30, send(_d: unknown) {} };
  const conn = new Conn(ws as never, '127.0.0.1');
  conn.wallet = wallet;
  // messages are not needed: drop them (the rooms send a lot)
  conn.send = (_m: ServerMessage) => {};
  return conn;
}

interface Player {
  wallet: Address;
  conn: Conn | null;
  /** The arena / room / pid of the coin it plays (AFK or not). */
  seat: { arenaId: number; roomId: string; pid: number } | null;
  /** A ticket bought and not seated yet. */
  bought: number | null;
  /** This ticket is never taken (an unplayed ticket for the stale sweeper). */
  skip: boolean;
  refusingUntil: number;
}

/** Runs one simulation; never throws for a broken invariant (they are collected in `violations`). */
export async function runMoneySim(sim: SimChain, opts: SimOptions): Promise<SimReport> {
  const t0 = Date.now();
  const f: SimFaults = { ...NO_FAULTS, ...opts.faults };
  const rng = mulberry32(opts.seed);
  const faulty = new Faulty(mulberry32(opts.seed ^ 0x5eed), f);
  const roundCfg = { roundMs: opts.roundMs ?? 8_000, closeMs: opts.closeMs ?? 1_000 };
  const passEvery = opts.passEvery ?? 6;
  const staleAfterS = opts.staleAfterS ?? 120;
  const log = opts.log ?? (() => {});
  const dir = mkdtempSync(join(tmpdir(), 'elymum-money-sim-'));
  const journalPath = join(dir, 'journal.json');
  const violations: string[] = [];
  const recent: string[] = [];
  const note = (m: string) => {
    recent.push(m);
    if (recent.length > 12) recent.shift();
  };
  const violate = (m: string) => {
    if (violations.length === 0) m += ` [recent: ${recent.join("; ")}]`;
    if (violations.length < 50) violations.push(m);
  };
  const unit = 10n ** BigInt(Math.max(0, sim.decimals - 6));
  const ledger = (base: bigint): number => Number(base / unit);

  // the game's wall clock: starts at the chain's time, runs with the ticks; the chain's clock is moved with it
  let clock = (await sim.nowS()) * 1000;
  const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), STALE_SESSION_AFTER_S: String(staleAfterS) } as unknown as NodeJS.ProcessEnv);
  const client = faulty.wrap(sim.client);

  let journal = new Journal(journalPath, log);
  let chain = await makeChain();
  async function makeChain(): Promise<EvmChain> {
    const c = new EvmChain(cfg, journal, log, { client, contracts: () => ({ arena: sim.arenaAddress, nft: null }), loops: false, now: () => clock, receiptTimeoutMs: 5_000, cacheDir: dir });
    c.setLiveSessionProvider(() => liveSessions());
    // the simulation runs every worker pass itself, between its checks: a pass the chain would start on its own
    // (`kick` after the stale sweep) could land in the middle of a conservation check on a real node
    (c as unknown as { kick: () => void }).kick = () => {};
    faulty.on = false;
    await c.start();
    faulty.on = true;
    return c;
  }

  const arenaIds = sim.arenaIds();
  const instances = opts.instances ?? 2;
  const rooms = new Map<string, Room>();
  const leaderboards = new Leaderboards(null);
  const testBots = { botsEaten: 0, botSpills: 0, botSpillValue: 0 };
  /** Counts a test arena's bot figures before the room goes (crash, restart) or at the end. */
  const tallyBots = (r: Room) => {
    if (!r.opts.test) return;
    testBots.botsEaten += r.bots?.eaten ?? 0;
    testBots.botSpills += r.botSpills.n;
    testBots.botSpillValue += r.botSpills.value;
  };
  /** Instance `n` of an arena; `n` 0 with `opts.testArenas`: its test arena (`test-<id>`, practice bots). */
  function openRoom(arenaId: number, n: number): Room {
    const test = n === 0 && !!opts.testArenas;
    const id = test ? testArenaRoomId(arenaId) : `arena-${arenaId}-${n}`;
    const r = new Room(
      {
        id,
        mode: 'arena',
        name: id,
        maxPlayers: 50,
        instance: n,
        stake: { arenaId, buyIn: ledger(sim.entryFee(arenaId)) },
        seed: Math.floor(rng() * 1e9),
        ...(test ? { test: { chainId: ROBINHOOD_TESTNET_CHAIN_ID }, bots: { count: opts.testArenas!.bots, difficulty: opts.testArenas!.difficulty, max: TEST_ARENA_BOTS.max, arriveMs: TEST_ARENA_ARRIVE_MS / 8 } } : {}),
      },
      { chain: { kick: () => {} }, journal, leaderboards, log: () => {}, now: () => clock, round: roundCfg },
    );
    rooms.set(id, r);
    return r;
  }
  const openAll = () => {
    for (const a of arenaIds) for (let n = opts.testArenas ? 0 : 1; n <= instances; n++) openRoom(a, n);
  };
  openAll();

  function liveSessions(): Set<string> {
    const s = new Set<string>();
    for (const r of rooms.values()) for (const k of r.liveSessions()) s.add(k);
    return s;
  }

  const players: Player[] = sim.wallets.map((w) => ({ wallet: w, conn: null, seat: null, bought: null, skip: false, refusingUntil: 0 }));
  const stats = { holderTickets: 0, tickets: 0, seated: 0, unplayed: 0, holds: 0, released: 0, zeroed: 0, workerCrashes: 0, restarts: 0, hardKills: 0, outages: 0, refusingPlayers: 0, spills: 0, checks: 0, daysPassed: 0, dayRefunds: 0 };
  let ticks = 0;

  /** Drops what the simulation knows about seats of rooms that are gone (worker crash, restart). */
  function forgetSeats(roomIds: Set<string>): void {
    for (const p of players) {
      if (p.seat && roomIds.has(p.seat.roomId)) {
        p.seat = null;
        p.conn = null;
      }
    }
  }

  async function seat(p: Player, arenaId: number): Promise<void> {
    let s;
    try {
      s = await chain.getSession(arenaId, p.wallet);
    } catch (err) {
      if (err instanceof ChainBusyError) return;
      throw err;
    }
    if (!s || s.finalized) return;
    if (journal.pending.some((i) => i.key === s.key)) return;
    if (liveSessions().has(s.key)) return;
    const r = roundAt(clock, roundCfg.roundMs, roundCfg.closeMs);
    if (clock >= r.joinsCloseAt) return;
    if (clock / 1000 - s.openedAt > MAX_STAKE_SESSION_AGE_S - 600) return;
    const choices = [...rooms.values()].filter((x) => x.opts.stake?.arenaId === arenaId && !x.isFull);
    if (choices.length === 0) return;
    const room = choices[Math.floor(rng() * choices.length)];
    const conn = fakeConn(p.wallet);
    const player = room.join(conn, {
      name: `p${p.wallet.slice(2, 6)}`,
      skin: 1,
      flags: PlayerFlag.Staker,
      stake: { player: s.player, session: s.key, sessionId: s.id, arenaId, entryFee: s.entryFee, value: s.value, openedAt: s.openedAt, rates: s.rates },
    });
    player.cells[0].setMass(20 + rng() * 400);
    // seated near the middle: people meet (and eat each other) within a short round
    const mid = room.world.center();
    player.cells[0].x = mid.x + (rng() - 0.5) * 700;
    player.cells[0].y = mid.y + (rng() - 0.5) * 700;
    player.shieldUntil = 0;
    p.conn = conn;
    p.seat = { arenaId, roomId: room.id, pid: player.id };
    p.bought = null;
    stats.seated++;
  }

  /**
   * Test arenas: now and then a bot meets a staker (put side by side, one clearly bigger), so both value paths run
   * often in a short round: a staker eating a bot (mass, no value) and a bot eating a staker (the value spills as loot).
   */
  function botEncounters(): void {
    for (const room of rooms.values()) {
      if (!room.opts.test || !room.bots || rng() > 0.05) continue;
      const bots = [...room.bots.bots.values()].map((b) => b.player).filter((b) => b.alive && b.cells.length > 0);
      const stakers = room.ledger!.all().map((e) => room.world.players.get(e.pid)).filter((p) => !!p && p.alive && p.cells.length > 0);
      if (bots.length === 0 || stakers.length === 0) continue;
      const bot = bots[Math.floor(rng() * bots.length)];
      const staker = stakers[Math.floor(rng() * stakers.length)]!;
      const big = staker.biggestCell()!;
      const mass = rng() < 0.5 ? big.mass * 3 : big.mass * 0.3;
      bot.cells[0].setMass(Math.max(20, mass));
      bot.cells[0].x = big.x + 4;
      bot.cells[0].y = big.y;
      bot.shieldUntil = 0;
      staker.shieldUntil = 0;
    }
  }

  /** Steering, disconnects, reconnects and spills for one tick. */
  function play(): void {
    if (opts.testArenas) botEncounters();
    for (const p of players) {
      if (!p.seat) continue;
      const room = rooms.get(p.seat.roomId);
      const pl = room?.world.players.get(p.seat.pid);
      if (!room || !pl || !pl.alive || !room.ledger?.has(p.seat.pid)) {
        // eaten, or settled at the bell (or by an operator exit)
        p.seat = null;
        p.conn = null;
        continue;
      }
      if (p.conn && rng() < 0.08) {
        const c = pl.center();
        let best: { x: number; y: number } | null = null;
        let bd = Infinity;
        for (const o of room.world.players.values()) {
          if (o === pl || !o.alive) continue;
          const oc = o.center();
          const d = Math.hypot(oc.x - c.x, oc.y - c.y);
          if (d < bd) {
            bd = d;
            best = oc;
          }
        }
        const loot = room.world.loot()[0];
        if (loot && rng() < 0.3) room.world.setTarget(pl.id, loot.x, loot.y);
        else if (best && rng() < 0.8) room.world.setTarget(pl.id, best.x, best.y);
        else room.world.setTarget(pl.id, c.x + (rng() - 0.5) * 1200, c.y + (rng() - 0.5) * 1200);
      }
      if (p.conn && rng() < 0.002) {
        room.leave(p.conn, 'disconnect');
        p.conn = null;
      } else if (!p.conn && rng() < 0.01) {
        const conn = fakeConn(p.wallet);
        if (room.reattach(conn, p.seat.pid)) p.conn = conn;
      }
      if (rng() < f.spill && room.ledger) {
        // something without a ticket ate part of this staker (Room.onCellEaten's spill path)
        const e = room.ledger.get(pl.id);
        if (e && e.value > 10) {
          const t = room.ledger.spill(pl.id, 1, 4, false);
          if (t > 0) {
            const c = pl.center();
            room.world.spawnLoot(c.x, c.y, t, 3);
            stats.spills++;
          }
        }
      }
    }
  }

  /** Arena books from the rooms' memory, the journal and the chain (see the file comment). */
  async function checkBooks(where: string): Promise<void> {
    stats.checks++;
    const was = faulty.on;
    faulty.on = false;
    try {
      const live = liveSessions();
      for (const a of arenaIds) {
        const info = await sim.arena(a);
        // the contract's own books
        if (info.totalDeposited !== info.vault + info.totalPaidOut + info.totalBurned + info.totalFees) {
          violate(`${where}: arena #${a} contract books: deposited ${info.totalDeposited} != vault ${info.vault} + paid ${info.totalPaidOut} + burned ${info.totalBurned} + fees ${info.totalFees}`);
        }
        let expect = 0;
        for (const r of rooms.values()) {
          if (r.opts.stake?.arenaId !== a) continue;
          expect += r.ledger!.total();
          for (const l of r.world.loot()) expect += l.value;
        }
        const counted = new Set<string>();
        for (const item of journal.pending) {
          if (item.arenaId !== a) continue;
          if (item.kind === 'sweep') {
            if (item.sweepId === undefined || BigInt(item.sweepId) > info.lastSweepId) expect += item.amount;
            continue;
          }
          const s = await sim.session(a, getAddress(item.player));
          if (s.id === BigInt(item.sessionId ?? 0) && !s.finalized) {
            expect += item.payout ?? 0;
            counted.add(item.key);
          } else if (item.sentAt === undefined && item.entryFee !== undefined) {
            // never sent, yet closed: refunded by its player after 24 h (the worker journals the difference at its next pass)
            expect += (item.payout ?? 0) - item.entryFee;
          }
        }
        expect += journal.forfeitedByArena(a);
        for (const p of players) {
          const s = await sim.session(a, p.wallet);
          if (s.id === 0n || s.finalized) continue;
          const key = sessionKey(a, p.wallet, s.id);
          if (live.has(key) || counted.has(key)) continue;
          expect += ledger(s.entryFee);
        }
        const vault = ledger(info.vault);
        if (info.vault % unit !== 0n || vault !== expect) {
          const detail = violations.length > 1 ? "" : ` {pending: ${journal.pending.filter((i) => i.arenaId === a).map((i) => `${i.key}=${i.kind === "sweep" ? i.amount : i.payout}${i.kind === "settle" && i.held ? "(held)" : ""}${counted.has(i.key) ? "+" : "-"}`).join(",")}; forfeits ${journal.forfeits().filter((x) => x.arenaId === a).map((x) => `${x.key}=${x.amount}`).join(",")}; live ${[...live].join(",")}}`;
          violate(`${where}: arena #${a} vault ${vault} != server books ${expect} (rooms + journal + forfeits + unseated tickets), diff ${vault - expect}${detail}`);
        }
      }
      const t = await sim.tokens();
      if (t.wallets + t.arena + t.feeWallet + t.burned !== t.minted) {
        violate(`${where}: tokens: wallets ${t.wallets} + arena ${t.arena} + fee wallet ${t.feeWallet} + burned ${t.burned} != minted ${t.minted}`);
      }
    } finally {
      faulty.on = was;
    }
  }

  async function pass(): Promise<void> {
    await chain.processPending();
  }

  /** The integrity auto-hold and the admin's decisions on held items. */
  function holds(): void {
    for (const item of journal.settlements()) {
      if (item.held || item.reason === 'stale' || (item as { simSeen?: boolean }).simSeen) continue;
      (item as { simSeen?: boolean }).simSeen = true;
      const entry = ledger(sim.entryFee(item.arenaId!));
      if ((item.payout ?? 0) > entry && rng() < f.hold) {
        journal.hold(item.key, { at: clock, score: 95, why: 'simulated auto-hold', flags: ['pair_transfer'] });
        stats.holds++;
      }
    }
    for (const item of journal.held()) {
      if (rng() > 0.1) continue;
      if (rng() < 0.5) {
        journal.release(item.key, clock);
        stats.released++;
      } else {
        journal.settleZero(item.key, 'simulated review: collusion', 'admin', clock);
        stats.zeroed++;
      }
    }
  }

  async function restart(hard: boolean): Promise<void> {
    if (!hard) for (const r of rooms.values()) r.shutdown();
    await chain.stop();
    // a hard kill: what the rooms did after their last journal write is lost, as in a real crash
    journal = new Journal(journalPath, log);
    journal.recoverLive(clock);
    forgetSeats(new Set(rooms.keys()));
    for (const r of rooms.values()) tallyBots(r);
    rooms.clear();
    chain = await makeChain();
    openAll();
  }

  // the re-pricing scenario: one arena at a time is closed, then re-priced at the first bell the contract allows it
  const rp: RepriceStats | null = opts.reprice ? { closed: 0, synced: 0, busy: 0, pauseRounds: [], entries: {} } : null;
  if (rp) for (const a of arenaIds) rp.entries[a] = [sim.entryFee(a).toString()];
  let closing: { arenaId: number; since: number } | null = null;
  const closedArenas = new Set<number>();
  async function repriceAtBell(): Promise<void> {
    if (!rp || !opts.reprice || !sim.updateArena) return;
    const was = faulty.on;
    faulty.on = false;
    try {
      if (closing) {
        const want = opts.reprice.newEntry(sim.entryFee(closing.arenaId), rng);
        if (await sim.updateArena(closing.arenaId, want, true)) {
          rp.synced++;
          rp.pauseRounds.push(roundsDone - closing.since);
          rp.entries[closing.arenaId].push(want.toString());
          closedArenas.delete(closing.arenaId);
          note(`re-priced arena #${closing.arenaId} to ${want}`);
          closing = null;
        } else rp.busy++;
      } else if (roundsDone > 0 && roundsDone % opts.reprice.everyRounds === 0) {
        const a = arenaIds[Math.floor(rng() * arenaIds.length)];
        if (await sim.updateArena(a, sim.entryFee(a), false)) {
          closing = { arenaId: a, since: roundsDone };
          closedArenas.add(a);
          rp.closed++;
          note(`closed arena #${a} for a sync`);
        }
      }
    } finally {
      faulty.on = was;
    }
  }

  const roundOf = (t: number) => roundAt(t, roundCfg.roundMs, roundCfg.closeMs).n;
  let lastRound = roundOf(clock);
  let roundsDone = 0;
  let outageRounds = 0;
  const tickets = new Set<string>();

  while (roundsDone < opts.rounds) {
    ticks++;
    // buyers: a free wallet buys a ticket and (usually) takes its seat while joins are open
    for (const p of players) {
      if (p.seat) continue;
      if (p.bought !== null) {
        if (!p.skip && rng() < 0.2) await seat(p, p.bought);
        else if (p.skip && ticks % 10 === 0 && (await sim.session(p.bought, p.wallet)).id === 0n) p.bought = null; // cancelled (or refunded)
        continue;
      }
      if (rng() > 0.02) continue;
      const a = arenaIds[Math.floor(rng() * arenaIds.length)];
      if (closedArenas.has(a)) continue; // closed for a sync: the lobby offers no ticket (a join would revert)
      const s = await sim.session(a, p.wallet);
      if (s.id !== 0n) continue; // still settling (or owed: collected below)
      if (await sim.buy(p.wallet, a)) {
        const s2 = await sim.session(a, p.wallet);
        tickets.add(`${a}:${s2.id}`);
        stats.tickets++;
        if (sim.holders.has(p.wallet.toLowerCase())) stats.holderTickets++;
        p.bought = a;
        p.skip = rng() < f.unplayed;
        if (p.skip) stats.unplayed++;
      }
    }
    play();
    for (const r of rooms.values()) r.tick(TICK_MS);
    clock += TICK_MS;

    if (ticks % passEvery === 0) {
      holds();
      await pass();
      await checkBooks(`tick ${ticks}`);
    }

    const n = roundOf(clock);
    if (n !== lastRound) {
      lastRound = n;
      roundsDone++;
      note(`round ${roundsDone}`);
      // every room rang its bell on this tick: the next tick of each settles it (`Room.tick` syncs the round)
      for (const r of rooms.values()) r.syncRound(clock);
      holds();
      await pass();
      await checkBooks(`bell ${n}`);
      await repriceAtBell();
      // the chain's clock follows the game's (unplayed tickets go stale, 24 h refunds become possible)
      const want = Math.floor(clock / 1000);
      const nowS = await sim.nowS();
      if (want > nowS) await sim.advance(want - nowS);
      if (rng() < 0.5) {
        faulty.on = false;
        await chain.sweepStale().catch(() => 0);
        faulty.on = true;
      }
      // players collect what is owed to them (a payout whose transfer failed)
      for (const p of players) {
        if (p.refusingUntil > 0 && n >= p.refusingUntil) {
          sim.setRefusing?.(p.wallet, false);
          p.refusingUntil = 0;
        }
        for (const a of arenaIds) {
          const s = await sim.session(a, p.wallet);
          if (s.finalized && p.refusingUntil === 0) await sim.refund(p.wallet, a);
        }
        if (sim.setRefusing && p.refusingUntil === 0 && rng() < f.refusing) {
          sim.setRefusing(p.wallet, true);
          p.refusingUntil = n + 2;
          stats.refusingPlayers++;
        }
      }
      // faults between rounds
      if (outageRounds > 0 && --outageRounds === 0) faulty.down = false;
      if (rng() < f.outage) {
        faulty.down = true;
        outageRounds = 1;
        stats.outages++;
        note("outage");
      }
      if (rng() < f.dayPasses) {
        // a day goes by (e.g. the server was down): players refund what the server did not settle in 24 h
        clock += 25 * 3600_000;
        await sim.advance(Math.floor(clock / 1000) - (await sim.nowS()));
        for (const item of journal.held()) if (await sim.refund(getAddress(item.player), item.arenaId!)) stats.dayRefunds++;
        for (const p of players) if (p.bought !== null && rng() < 0.5 && (await sim.refund(p.wallet, p.bought))) {
          p.bought = null;
          stats.dayRefunds++;
        }
        stats.daysPassed++;
        note("a day passed");
      }
      if (rng() < f.workerCrash) {
        const list = [...rooms.values()];
        const victim = list[Math.floor(rng() * list.length)];
        journal.recoverRooms([victim.id], n, clock);
        tallyBots(victim);
        rooms.delete(victim.id);
        forgetSeats(new Set([victim.id]));
        openRoom(victim.opts.stake!.arenaId, victim.opts.instance ?? 1);
        stats.workerCrashes++;
        note(`worker crash ${victim.id}`);
      }
      if (rng() < f.restart) {
        const hard = rng() < 0.5;
        await restart(hard);
        stats.restarts++;
        if (hard) stats.hardKills++;
        note(`restart ${hard ? "hard" : "graceful"}`);
      }
      await checkBooks(`after round ${n}`);
    }
  }

  // ---- drain: no new tickets, no faults; ring the bell, settle everything, cancel what was never played
  faulty.on = false;
  faulty.down = false;
  for (const p of players) {
    sim.setRefusing?.(p.wallet, false);
    p.refusingUntil = 0;
  }
  const bell = roundAt(clock, roundCfg.roundMs, roundCfg.closeMs).endsAt;
  while (clock <= bell) {
    for (const r of rooms.values()) r.tick(TICK_MS);
    clock += TICK_MS;
  }
  for (const r of rooms.values()) r.tick(TICK_MS);
  for (const item of journal.held()) journal.release(item.key, clock);
  clock += staleAfterS * 1000 + 60_000;
  {
    // ticket ages are measured on the chain's clock: it moves on at least as far as the game's (a chain that ran
    // ahead, one second per block on an automining node, still has to see every unplayed ticket age past the limit)
    const want = Math.floor(clock / 1000);
    const nowS = await sim.nowS();
    await sim.advance(Math.max(want - nowS, staleAfterS + 60));
  }
  for (let i = 0; i < 40 && (journal.pending.length > 0 || i < 3); i++) {
    clock += 400_000; // past every backoff
    await sim.advance(400);
    await chain.sweepStale();
    await pass();
  }
  for (const p of players) for (const a of arenaIds) if ((await sim.session(a, p.wallet)).finalized) await sim.refund(p.wallet, a);
  await checkBooks('drained');
  if (journal.pending.length > 0) violate(`drain: ${journal.pending.length} journal item(s) left: ${journal.pending.map((p) => `${p.key} (${p.lastError ?? '-'})`).join(', ')}`);
  if (journal.live().length > 0) violate(`drain: ${journal.live().length} live stake(s) left in the journal`);
  for (const p of players) {
    for (const a of arenaIds) {
      const s = await sim.session(a, p.wallet);
      if (s.id !== 0n) violate(`drain: ticket #${s.id} of ${p.wallet} in arena #${a} is still open (finalized ${s.finalized})`);
    }
  }
  const closures = await sim.closures();
  const per = new Map<string, string[]>();
  for (const c of closures) {
    const k = `${c.arenaId}:${c.sessionId}`;
    per.set(k, [...(per.get(k) ?? []), c.name]);
  }
  for (const [k, names] of per) {
    const ends = names.filter((x) => x !== 'Collected');
    if (ends.length !== 1) violate(`ticket ${k} closed ${ends.length} times (${names.join(', ')})`);
  }
  for (const k of tickets) if (!per.has(k)) violate(`ticket ${k} was never closed (lost)`);
  violations.push(...(await sim.feeViolations()).slice(0, 10));
  const counts = { Settled: 0, Cancelled: 0, Refunded: 0, Collected: 0 };
  for (const c of closures) counts[c.name]++;
  const books: SimReport['books'] = {};
  for (const a of arenaIds) {
    const info = await sim.arena(a);
    const forfeited = journal.forfeitedByArena(a);
    books[a] = { deposited: info.totalDeposited.toString(), paidOut: info.totalPaidOut.toString(), burned: info.totalBurned.toString(), fees: info.totalFees.toString(), vaultLeft: info.vault.toString(), forfeited };
    if (ledger(info.vault) !== forfeited) violate(`drain: arena #${a} vault ${ledger(info.vault)} != forfeited ${forfeited}`);
  }
  await chain.stop();
  for (const r of rooms.values()) tallyBots(r);
  return {
    chain: sim.name,
    seed: opts.seed,
    rounds: roundsDone,
    ticks,
    checks: stats.checks,
    tickets: stats.tickets,
    seated: stats.seated,
    unplayed: stats.unplayed,
    closures: counts,
    books,
    faults: {
      rpcErrors: faulty.rpcErrors,
      ambiguousSends: faulty.ambiguousSends,
      lostReceipts: faulty.lostReceipts,
      outages: stats.outages,
      workerCrashes: stats.workerCrashes,
      restarts: stats.restarts,
      hardKills: stats.hardKills,
      holds: stats.holds,
      released: stats.released,
      zeroed: stats.zeroed,
      refusingPlayers: stats.refusingPlayers,
      spills: stats.spills,
      daysPassed: stats.daysPassed,
      dayRefunds: stats.dayRefunds,
    },
    testArenas: opts.testArenas ? { rooms: arenaIds.length, ...testBots } : null,
    holders: {
      wallets: sim.holders.size,
      tickets: stats.holderTickets,
      settled: closures.filter((c) => c.name === 'Settled' && sim.holders.has(c.player.toLowerCase())).length,
      winners: closures.filter((c) => c.name === 'Settled' && sim.holders.has(c.player.toLowerCase()) && c.amount > sim.entryFee(c.arenaId)).length,
    },
    winners: closures.filter((c) => c.name === 'Settled' && c.amount > sim.entryFee(c.arenaId)).length,
    losers: closures.filter((c) => c.name === 'Settled' && c.amount < sim.entryFee(c.arenaId)).length,
    violations,
    reprice: rp,
    ms: Date.now() - t0,
  };
}

/** `computeProfitFee` of the shared fee module, for the adapters' fee checks. */
export const feeOf = computeProfitFee;

/**
 * The simulation on `FakeEvm` (the TypeScript model of ElymumArena v3: sessions, vaults, the skip rules, two-phase
 * payouts, sweep ids, the 24 h refund). Fast enough for thousands of rounds.
 */
/** The fee pair a ticket of `wallet` must carry (`holders`: lower-case holder wallets). */
export function expectedRates(holders: ReadonlySet<string>, wallet: string) {
  return holders.has(wallet.toLowerCase()) ? DEFAULT_HOLDER_FEE_RATES : DEFAULT_FEE_RATES;
}

export function fakeSimChain(opts: { players: number; seed: number; arenas?: { id: number; tokens: bigint; holdersOnly?: boolean }[]; holderShare?: number; decimals?: number }): SimChain {
  const evm = new FakeEvm();
  // the arena's holder perks at the owner's pair: emblem holders pay 8 % + 2 % of their profit
  evm.config.holderNft = NFT;
  evm.config.holderBurnBps = DEFAULT_HOLDER_FEE_RATES.burnBps;
  evm.config.holderVaultBps = DEFAULT_HOLDER_FEE_RATES.vaultBps;
  const holders = new Set<string>();
  let skewS = 0;
  const startS = Math.floor(Date.now() / 1000);
  evm.nowS = () => startS + skewS;
  const arenas = opts.arenas ?? [
    { id: 1, tokens: 1_000n },
    { id: 2, tokens: 10_000n },
  ];
  for (const a of arenas) evm.addArena(a.id, a.tokens, { holdersOnly: a.holdersOnly === true });
  const rng = mulberry32(opts.seed ^ 0xfa4e);
  const wallets: Address[] = [];
  const grant = 100_000_000n * E18;
  for (let i = 0; i < opts.players; i++) {
    const w = getAddress(`0x${Math.floor(rng() * 2 ** 32).toString(16).padStart(8, '0')}${i.toString(16).padStart(32, '0')}`);
    wallets.push(w);
    evm.gas.set(w.toLowerCase(), 10n ** 30n);
    evm.tokens.set(w.toLowerCase(), grant);
    evm.allowances.set(`${w.toLowerCase()}:${ARENA.toLowerCase()}`, (1n << 256n) - 1n);
    // a share of the players hold the emblem (at least one)
    if (i === 0 || rng() < (opts.holderShare ?? 0.35)) {
      holders.add(w.toLowerCase());
      evm.arenaHolders.add(w.toLowerCase());
    }
  }
  const minted = grant * BigInt(opts.players);
  const join = (w: Address, arenaId: number) => ({ address: ARENA, abi: [], functionName: 'join', args: [arenaId] }) as never;
  const refund = (arenaId: number) => ({ address: ARENA, abi: [], functionName: 'refund', args: [arenaId] }) as never;
  return {
    name: 'FakeEvm (model of ElymumArena v3)',
    arenaAddress: ARENA,
    client: evm,
    decimals: 18,
    wallets,
    holders,
    arenaIds: () => arenas.map((a) => a.id),
    entryFee: (id) => evm.arenaMap.get(id)!.entryFee,
    async buy(w, arenaId) {
      try {
        await evm.sendFrom(w, join(w, arenaId));
        return true;
      } catch {
        return false;
      }
    },
    async refund(w, arenaId) {
      try {
        await evm.sendFrom(w, refund(arenaId));
        return true;
      } catch {
        return false;
      }
    },
    async updateArena(arenaId, entryFee, enabled) {
      // ElymumArena.updateArena: a new entry fee only while no ticket of the arena is open (ArenaBusy)
      const a = evm.arenaMap.get(arenaId);
      if (!a || !a.exists || entryFee <= 0n) return false;
      if (entryFee !== a.entryFee && a.openSessions !== 0) return false;
      a.entryFee = entryFee;
      a.enabled = enabled;
      return true;
    },
    setRefusing(w, on) {
      if (on) evm.refusing.add(w.toLowerCase());
      else evm.refusing.delete(w.toLowerCase());
    },
    async advance(s) {
      skewS += s;
    },
    async nowS() {
      return evm.nowS();
    },
    async arena(id) {
      return { ...evm.arenaMap.get(id)! };
    },
    async session(id, w) {
      const rpc = evm.rpcDown;
      evm.rpcDown = false;
      try {
        return await evm.session(ARENA, id, w);
      } finally {
        evm.rpcDown = rpc;
      }
    },
    async tokens() {
      let inWallets = 0n;
      for (const w of wallets) inWallets += evm.tokenOf(w);
      let arena = 0n;
      for (const a of evm.arenaMap.values()) arena += a.vault + a.owed;
      return { wallets: inWallets, arena, feeWallet: evm.toFeeWallet, burned: evm.burned, minted };
    },
    async closures() {
      return evm.closures.map((c) => ({ ...c }));
    },
    async feeViolations() {
      const bad: string[] = [];
      for (const j of evm.joined) {
        const r = evm.joinedRates.get(j.sessionId)!;
        const want = expectedRates(holders, j.player);
        if (r.burnBps !== want.burnBps || r.vaultBps !== want.vaultBps) bad.push(`Joined #${j.sessionId} of ${j.player}: rates ${r.burnBps}/${r.vaultBps}, want ${want.burnBps}/${want.vaultBps}`);
      }
      for (const s of evm.settledSplits) {
        const j = evm.joinedRates.get(s.sessionId);
        if (!j) {
          bad.push(`Settled #${s.sessionId} has no Joined event`);
          continue;
        }
        const f = computeProfitFee(j.entryFee, s.payout, j);
        if (f.burned !== s.burned || f.toVault !== s.toVault || f.net !== s.net) bad.push(`Settled #${s.sessionId}: fee split ${s.burned}/${s.toVault}/${s.net} != shared fee module ${f.burned}/${f.toVault}/${f.net}`);
      }
      return bad;
    },
    async stop() {},
  };
}
