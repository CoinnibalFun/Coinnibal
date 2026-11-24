/**
 * Economy simulation: many arena rooms at once (every tier, several instances, the testnet's test arenas with practice
 * bots), 1 to 50 tickets per room and round, emblem holders and everyone else, five play styles (hunters, loot farmers,
 * idlers, players who go AFK at once and come back, random walkers), deaths and re-buys while joins are open, tickets
 * that are never seated (cancelled in full), rooms drained and closed by the scaler between two bells.
 *
 * Everything in a room is the real server code: `Room` (the world physics, the ledger, loot spills and pickups, the
 * bell), the real `Journal` (in memory) and the shared fee module. The chain is `ArenaModel` below: a line-by-line port
 * of `CoinnibalArena`'s money paths (`join`, `_settleOne` / `computeFees`, `_cancelOne`, `sweepLoot`, `_ratesFor`) in
 * exact bigint base units of an 18-decimal token, independent of the shared fee module it checks.
 *
 * Checked, exactly (ledger units in the rooms, base units on the chain):
 *  - every check pass, per ROOM (value never crosses rooms): Σ entry fees seated in it + loot adopted =
 *    Σ live ticket values + Σ floor loot + Σ payouts and loot sweeps it handed to the journal;
 *  - every check pass, per ARENA, the journal's own snapshot (what a crash would recover): Σ live + Σ loot it holds +
 *    Σ items ever enqueued = Σ entry fees seated;
 *  - after every bell, per arena, on the chain model: deposited = vault + paid out + burned + fees; the vault holds
 *    exactly the entry fees of the tickets still open (plus the sub-ledger-unit dust of tickets whose entry fee is not
 *    a whole number of ledger units); the token supply (wallets + arena + fee wallet + burned = minted);
 *  - every settlement: the fee is taken only from a profit, at the ticket's own rates (the holder pair for a ticket
 *    bought as a holder), each share rounded down, never above 25 % of the profit; the shared `computeProfitFee`, the
 *    SDK's `settlementSplit` and the contract port agree to the base unit; the server's preview of what reaches the
 *    player (`DeathStats.payout`, ledger units) is within one ledger unit of the contract's net; nothing is skipped;
 *  - bots never hold a ticket and never pick up loot; a room the scaler closes is refused while anything of value is in it.
 *
 * And it reports the economy: return per play style and per holder status, fee / burn totals, what the bots took in
 * the test arenas and where it went (picked up by people or burned), and the token supply against the testnet faucet.
 */
import { computeProfitFee, DEFAULT_ARENAS, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, PlayerFlag, ROBINHOOD_TESTNET_CHAIN_ID, roundAt, RULES, TEST_ARENA_ARRIVE_MS, TEST_ARENA_BOTS, testArenaRoomId, TICK_MS, type FeeRates, type ServerMessage } from '@coinnibal/shared';
import { fromLedger, settlementSplit, toLedger } from '@coinnibal/sdk';
import { mulberry32 } from '../src/game/rng';
import { Leaderboards } from '../src/leaderboards';
import { Conn } from '../src/net/conn';
import { Room } from '../src/rooms/room';
import { Journal, itemAmount } from '../src/stake/journal';

/* ------------------------------------------------------------------------------------------------------------ */
/* The contract model: CoinnibalArena's money paths, ported line by line (bigint base units)                      */
/* ------------------------------------------------------------------------------------------------------------ */

const BPS = 10_000n;
const MAX_TOTAL_FEE_BPS = 2_500n;
const MAX_UINT128 = (1n << 128n) - 1n;

/** `CoinnibalArena.computeFees`, ported from the Solidity (not from `fees.ts`, which it checks). */
export function contractComputeFees(entryFee: bigint, payout: bigint, burnBps: number, vaultBps: number): { net: bigint; burned: bigint; toVault: bigint } {
  if (entryFee < 0n || entryFee > MAX_UINT128 || payout < 0n || payout > MAX_UINT128) throw new RangeError('uint128');
  const profit = payout > entryFee ? payout - entryFee : 0n;
  const burned = (profit * BigInt(burnBps)) / BPS;
  const toVault = (profit * BigInt(vaultBps)) / BPS;
  return { net: payout - burned - toVault, burned, toVault };
}

interface ModelArena {
  entryFee: bigint;
  holdersOnly: boolean;
  vault: bigint;
  openSessions: number;
  totalDeposited: bigint;
  totalPaidOut: bigint;
  totalBurned: bigint;
  totalFees: bigint;
  lastSweepId: bigint;
}

interface ModelSession {
  id: bigint;
  entryFee: bigint;
  burnBps: number;
  vaultBps: number;
  holder: boolean;
}

export class ArenaModel {
  readonly arenas = new Map<number, ModelArena>();
  readonly sessions = new Map<string, ModelSession>();
  readonly balances = new Map<string, bigint>();
  lastSessionId = 0n;
  feeWallet = 0n;
  burned = 0n;
  minted = 0n;
  skips: string[] = [];

  constructor(
    readonly normal: FeeRates,
    readonly holder: FeeRates,
  ) {}

  create(id: number, entryFee: bigint, holdersOnly: boolean): void {
    if (entryFee <= 0n || entryFee > MAX_UINT128) throw new Error('bad entry fee');
    this.arenas.set(id, { entryFee, holdersOnly, vault: 0n, openSessions: 0, totalDeposited: 0n, totalPaidOut: 0n, totalBurned: 0n, totalFees: 0n, lastSweepId: 0n });
  }

  mint(wallet: string, amount: bigint): void {
    this.balances.set(wallet, (this.balances.get(wallet) ?? 0n) + amount);
    this.minted += amount;
  }

  balance(wallet: string): bigint {
    return this.balances.get(wallet) ?? 0n;
  }

  /** `_ratesFor`. */
  ratesFor(holder: boolean): FeeRates {
    const n = this.normal;
    const h = this.holder;
    if (holder && h.burnBps + h.vaultBps < n.burnBps + n.vaultBps) return { ...h };
    return { ...n };
  }

  session(arenaId: number, wallet: string): ModelSession | undefined {
    return this.sessions.get(`${arenaId}:${wallet}`);
  }

  /** `join` (the permit is the server's business): null where the contract reverts. */
  join(arenaId: number, wallet: string, holder: boolean): ModelSession | null {
    const a = this.arenas.get(arenaId);
    if (!a) return null;
    if (this.sessions.has(`${arenaId}:${wallet}`)) return null;
    if (a.holdersOnly && !holder) return null;
    if (this.balance(wallet) < a.entryFee) return null;
    const r = this.ratesFor(holder);
    this.balances.set(wallet, this.balance(wallet) - a.entryFee);
    const s: ModelSession = { id: ++this.lastSessionId, entryFee: a.entryFee, burnBps: r.burnBps, vaultBps: r.vaultBps, holder };
    this.sessions.set(`${arenaId}:${wallet}`, s);
    a.vault += a.entryFee;
    a.openSessions += 1;
    a.totalDeposited += a.entryFee;
    return s;
  }

  /** `_settleOne` (the player's transfer always succeeds here): the split, or null when skipped. */
  settle(arenaId: number, wallet: string, sessionId: bigint, payout: bigint): { net: bigint; burned: bigint; toVault: bigint; session: ModelSession } | null {
    const a = this.arenas.get(arenaId);
    const s = this.sessions.get(`${arenaId}:${wallet}`);
    if (!a || !s || s.id !== sessionId) return this.skip(`settle ${arenaId}:${wallet}:${sessionId}: session mismatch`);
    if (payout > a.vault) return this.skip(`settle ${arenaId}:${wallet}:${sessionId}: payout ${payout} > vault ${a.vault}`);
    const f = contractComputeFees(s.entryFee, payout, s.burnBps, s.vaultBps);
    a.vault -= payout;
    a.openSessions -= 1;
    a.totalPaidOut += f.net;
    a.totalBurned += f.burned;
    a.totalFees += f.toVault;
    this.sessions.delete(`${arenaId}:${wallet}`);
    this.balances.set(wallet, this.balance(wallet) + f.net);
    this.burned += f.burned;
    this.feeWallet += f.toVault;
    return { ...f, session: s };
  }

  /** `_cancelOne`: the full entry fee back. */
  cancel(arenaId: number, wallet: string, sessionId: bigint): bigint | null {
    const a = this.arenas.get(arenaId);
    const s = this.sessions.get(`${arenaId}:${wallet}`);
    if (!a || !s || s.id !== sessionId) return this.skip(`cancel ${arenaId}:${wallet}:${sessionId}: session mismatch`);
    if (s.entryFee > a.vault) return this.skip(`cancel ${arenaId}:${wallet}:${sessionId}: insufficient vault`);
    a.vault -= s.entryFee;
    a.openSessions -= 1;
    a.totalPaidOut += s.entryFee;
    this.sessions.delete(`${arenaId}:${wallet}`);
    this.balances.set(wallet, this.balance(wallet) + s.entryFee);
    return s.entryFee;
  }

  /** `sweepLoot`. */
  sweepLoot(arenaId: number, sweepId: bigint, amount: bigint): boolean {
    const a = this.arenas.get(arenaId);
    if (!a) return !!this.skip(`sweep ${arenaId}: unknown arena`);
    if (sweepId <= a.lastSweepId) return !!this.skip(`sweep ${arenaId}: id ${sweepId} not increasing`);
    if (amount > a.vault) return !!this.skip(`sweep ${arenaId}: ${amount} > vault ${a.vault}`);
    a.lastSweepId = sweepId;
    a.vault -= amount;
    a.totalBurned += amount;
    this.burned += amount;
    return true;
  }

  private skip(why: string): null {
    this.skips.push(why);
    return null;
  }

  /** Every token is in a wallet, the arena, the fee wallet or burned. */
  supplyOk(): boolean {
    let sum = this.feeWallet + this.burned;
    for (const b of this.balances.values()) sum += b;
    for (const a of this.arenas.values()) sum += a.vault;
    return sum === this.minted;
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The simulation                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

export const STYLES = ['hunter', 'farmer', 'idle', 'afk', 'random'] as const;
export type Style = (typeof STYLES)[number];

export interface EconOptions {
  seed: number;
  /** Rounds (every room rings its bell once per round). */
  rounds: number;
  /** Official instances per arena (`arena-<id>-<n>`). */
  instances?: number;
  /** A test arena per arena (`test-<id>`, practice bots that carry no value). */
  testArenas?: boolean;
  bots?: number;
  /** Wallets in the pool. */
  wallets?: number;
  /** Share of the wallets holding the emblem. */
  holderShare?: number;
  /** Most tickets per room and round (the room cap is 50). */
  maxPerRoom?: number;
  /** Token decimals (18 like the game token). */
  decimals?: number;
  /** Base units added to every arena's entry fee (non-zero: not a whole number of ledger units). */
  entryDust?: bigint;
  roundMs?: number;
  closeMs?: number;
  /** Ticks between two check passes. */
  checkEvery?: number;
  /** Per ticket: never seated (the stale sweeper cancels it in full). */
  unseated?: number;
  /** Per round and room: the scaler drains and closes an instance after the bell (a new one opens). */
  drain?: number;
  /** Testnet faucet: per claim (whole tokens; holders twice that), one claim per wallet per this many rounds. */
  faucet?: { tokens: number; everyRounds: number };
  rates?: { normal: FeeRates; holder: FeeRates };
}

interface Wallet {
  addr: string;
  holder: boolean;
  style: Style;
  /** Rounds index of the last faucet claim. */
  lastClaim: number;
  /** Ticket bought and not seated yet, per arena. */
  unseated: Map<number, bigint>;
}

interface Seat {
  wallet: Wallet;
  arenaId: number;
  roomId: string;
  pid: number;
  conn: Conn | null;
  entryBase: bigint;
  entryLedger: number;
  sessionId: bigint;
  /** The server's preview of what reaches the player (ledger units), from the game-over hook. */
  preview?: number;
}

export interface StyleStats {
  tickets: number;
  /** Base units. */
  paidIn: bigint;
  netOut: bigint;
  fees: bigint;
  deaths: number;
  winners: number;
}

export interface EconReport {
  seed: number;
  rounds: number;
  roomRounds: number;
  ticks: number;
  checks: number;
  tickets: number;
  settled: number;
  cancelled: number;
  deaths: number;
  /** Most tickets seated in one room during one round. */
  maxSeatedInRoom: number;
  /** Base units, whole run. */
  deposited: bigint;
  paidOut: bigint;
  feeBurned: bigint;
  feeToWallet: bigint;
  lootBurned: bigint;
  /** Sub-ledger-unit dust left in the vaults (non-zero only with `entryDust`). */
  vaultDust: bigint;
  /** Largest |server preview − contract net| in base units, and how many settlements differed at all. */
  previewMaxDiff: bigint;
  previewDiffs: number;
  byStyle: Record<Style, StyleStats>;
  byHolder: { holder: StyleStats; normal: StyleStats };
  /** Official rooms vs test rooms (people's return). */
  byRoomKind: { official: StyleStats; test: StyleStats };
  testArenas: { botSpills: number; botSpillValue: number; lootPickedInTest: number; lootBurnedInTest: number } | null;
  supply: { minted: bigint; burned: bigint; feeWallet: bigint; faucetClaims: number };
  closedRooms: number;
  violations: string[];
  ms: number;
}

const newStats = (): StyleStats => ({ tickets: 0, paidIn: 0n, netOut: 0n, fees: 0n, deaths: 0, winners: 0 });

function fakeConn(wallet: string): Conn {
  const ws = { readyState: 1, bufferedAmount: 1 << 30, send(_d: unknown) {}, terminate() {} };
  const conn = new Conn(ws as never, '127.0.0.1');
  conn.wallet = wallet;
  conn.send = (_m: ServerMessage) => {};
  return conn;
}

export function runEconomySim(opts: EconOptions): EconReport {
  const t0 = Date.now();
  const rng = mulberry32(opts.seed);
  const decimals = opts.decimals ?? 18;
  const unit = 10n ** BigInt(Math.max(0, decimals - 6));
  const instances = opts.instances ?? 2;
  const maxPerRoom = Math.min(50, opts.maxPerRoom ?? 50);
  const roundCfg = { roundMs: opts.roundMs ?? 6_000, closeMs: opts.closeMs ?? 1_500 };
  const checkEvery = opts.checkEvery ?? 15;
  const unseatedP = opts.unseated ?? 0.03;
  const drainP = opts.drain ?? 0.02;
  const faucet = opts.faucet ?? { tokens: 1_000_000, everyRounds: 11 };
  const rates = opts.rates ?? { normal: { ...DEFAULT_FEE_RATES }, holder: { ...DEFAULT_HOLDER_FEE_RATES } };
  const violations: string[] = [];
  const violate = (m: string) => {
    if (violations.length < 50) violations.push(m);
  };

  const model = new ArenaModel(rates.normal, rates.holder);
  const tokenUnit = 10n ** BigInt(decimals);
  for (const a of DEFAULT_ARENAS) model.create(a.id, BigInt(a.entryTokens) * tokenUnit + (opts.entryDust ?? 0n), a.holdersOnly);
  const arenaIds = [...model.arenas.keys()];

  const journal = new Journal(null);
  const leaderboards = new Leaderboards(null);
  let clock = 1_800_000_000_000;
  // the round clock starts at the next round's open
  clock = roundAt(clock, roundCfg.roundMs, roundCfg.closeMs).endsAt;

  const wallets: Wallet[] = [];
  const nWallets = opts.wallets ?? 600;
  for (let i = 0; i < nWallets; i++) {
    wallets.push({ addr: `0x${(i + 1).toString(16).padStart(40, '0')}`, holder: rng() < (opts.holderShare ?? 0.3), style: STYLES[Math.floor(rng() * STYLES.length)], lastClaim: -1e9, unseated: new Map() });
  }
  let faucetClaims = 0;

  const rooms = new Map<string, Room>();
  /** Per room: Σ entry fees seated, loot adopted, Σ handed to the journal (ledger units). */
  const roomIn = new Map<string, number>();
  const roomOut = new Map<string, number>();
  /** Per arena: Σ entry fees seated (ledger), Σ items ever enqueued (ledger). */
  const arenaSeated = new Map<number, number>(arenaIds.map((a) => [a, 0]));
  const arenaEnqueued = new Map<number, number>(arenaIds.map((a) => [a, 0]));
  const seenItems = new Set<string>();
  const seatByPid = new Map<string, Seat>();
  const seatBySession = new Map<string, Seat>();
  let nextInstance = instances + 1;
  let closedRooms = 0;

  const report: EconReport = {
    seed: opts.seed,
    rounds: opts.rounds,
    roomRounds: 0,
    ticks: 0,
    checks: 0,
    tickets: 0,
    settled: 0,
    cancelled: 0,
    deaths: 0,
    maxSeatedInRoom: 0,
    deposited: 0n,
    paidOut: 0n,
    feeBurned: 0n,
    feeToWallet: 0n,
    lootBurned: 0n,
    vaultDust: 0n,
    previewMaxDiff: 0n,
    previewDiffs: 0,
    byStyle: Object.fromEntries(STYLES.map((s) => [s, newStats()])) as Record<Style, StyleStats>,
    byHolder: { holder: newStats(), normal: newStats() },
    byRoomKind: { official: newStats(), test: newStats() },
    testArenas: opts.testArenas ? { botSpills: 0, botSpillValue: 0, lootPickedInTest: 0, lootBurnedInTest: 0 } : null,
    supply: { minted: 0n, burned: 0n, feeWallet: 0n, faucetClaims: 0 },
    closedRooms: 0,
    violations,
    ms: 0,
  };

  function openRoom(arenaId: number, n: number, test: boolean): Room {
    const id = test ? testArenaRoomId(arenaId) : `arena-${arenaId}-${n}`;
    const entryLedger = toLedger(model.arenas.get(arenaId)!.entryFee, decimals, 'floor');
    const room = new Room(
      {
        id,
        mode: 'arena',
        name: id,
        maxPlayers: 50,
        instance: test ? 0 : n,
        stake: { arenaId, buyIn: entryLedger },
        seed: Math.floor(rng() * 1e9),
        ...(test ? { test: { chainId: ROBINHOOD_TESTNET_CHAIN_ID }, bots: { count: opts.bots ?? 10, difficulty: 'mixed' as const, max: TEST_ARENA_BOTS.max, arriveMs: TEST_ARENA_ARRIVE_MS / 8 } } : {}),
      },
      {
        chain: { kick: () => {} },
        journal,
        leaderboards,
        log: () => {},
        now: () => clock,
        chainNow: () => clock,
        round: roundCfg,
        onGameOver: (e) => {
          const s = seatByPid.get(`${id}:${e.player.id}`);
          if (s) s.preview = e.stats.payout;
        },
      },
    );
    rooms.set(id, room);
    roomIn.set(id, room.lootValue());
    roomOut.set(id, 0);
    return room;
  }
  for (const a of arenaIds) {
    for (let n = 1; n <= instances; n++) openRoom(a, n, false);
    if (opts.testArenas) openRoom(a, 0, true);
  }

  const styleOf = (w: Wallet) => report.byStyle[w.style];
  const kindOf = (roomId: string) => (roomId.startsWith('test-') ? report.byRoomKind.test : report.byRoomKind.official);
  const holderOf = (w: Wallet) => (w.holder ? report.byHolder.holder : report.byHolder.normal);
  const allStats = (s: Seat) => [styleOf(s.wallet), holderOf(s.wallet), kindOf(s.roomId)];

  /** A faucet claim when the wallet cannot pay (once per `everyRounds` rounds). */
  function fund(w: Wallet, need: bigint, round: number): boolean {
    if (model.balance(w.addr) >= need) return true;
    if (round - w.lastClaim < faucet.everyRounds) return false;
    w.lastClaim = round;
    faucetClaims++;
    model.mint(w.addr, BigInt(faucet.tokens * (w.holder ? 2 : 1)) * tokenUnit);
    return model.balance(w.addr) >= need;
  }

  const busy = new Set<string>(); // `${arenaId}:${addr}` seated or holding a ticket
  function buy(w: Wallet, arenaId: number, round: number): bigint | null {
    const a = model.arenas.get(arenaId)!;
    if (busy.has(`${arenaId}:${w.addr}`) || w.unseated.has(arenaId)) return null;
    if (a.holdersOnly && !w.holder) return null;
    if (!fund(w, a.entryFee, round)) return null;
    const s = model.join(arenaId, w.addr, w.holder);
    if (!s) return null;
    report.tickets++;
    report.deposited += s.entryFee;
    const want = model.ratesFor(w.holder);
    if (s.burnBps !== want.burnBps || s.vaultBps !== want.vaultBps) violate(`ticket ${s.id}: rates ${s.burnBps}/${s.vaultBps}, the wallet's pair is ${want.burnBps}/${want.vaultBps}`);
    if (w.holder !== (s.burnBps === rates.holder.burnBps && s.vaultBps === rates.holder.vaultBps) && totalBps(rates.holder) < totalBps(rates.normal)) violate(`ticket ${s.id}: holder ${w.holder} got ${s.burnBps}/${s.vaultBps}`);
    return s.id;
  }

  function seat(w: Wallet, room: Room, sessionId: bigint): Seat | null {
    const arenaId = room.opts.stake!.arenaId;
    const ms = model.session(arenaId, w.addr);
    if (!ms || ms.id !== sessionId) return null;
    if (clock >= roundAt(clock, roundCfg.roundMs, roundCfg.closeMs).joinsCloseAt || room.isFull) return null;
    const entryLedger = toLedger(ms.entryFee, decimals, 'floor');
    const conn = fakeConn(w.addr);
    const session = `${arenaId}:${w.addr}:${sessionId}`;
    const p = room.join(conn, {
      name: `p${w.addr.slice(-4)}`,
      skin: 1,
      flags: PlayerFlag.Staker,
      stake: { player: w.addr, session, sessionId: Number(sessionId), arenaId, entryFee: entryLedger, value: entryLedger, openedAt: Math.floor(clock / 1000), rates: { burnBps: ms.burnBps, vaultBps: ms.vaultBps } },
    });
    p.cells[0].setMass(20 + rng() * 400);
    const mid = room.world.center();
    p.cells[0].x = mid.x + (rng() - 0.5) * 900;
    p.cells[0].y = mid.y + (rng() - 0.5) * 900;
    p.shieldUntil = 0;
    const s: Seat = { wallet: w, arenaId, roomId: room.id, pid: p.id, conn, entryBase: ms.entryFee, entryLedger, sessionId };
    seatByPid.set(`${room.id}:${p.id}`, s);
    seatBySession.set(session, s);
    busy.add(`${arenaId}:${w.addr}`);
    roomIn.set(room.id, roomIn.get(room.id)! + entryLedger);
    arenaSeated.set(arenaId, arenaSeated.get(arenaId)! + entryLedger);
    for (const st of allStats(s)) {
      st.tickets++;
      st.paidIn += ms.entryFee;
    }
    if (w.style === 'afk') {
      room.leave(conn, 'disconnect');
      s.conn = null;
    }
    return s;
  }

  /** Fills a room with k tickets at the round's open. */
  function fill(room: Room, k: number, round: number): void {
    const arenaId = room.opts.stake!.arenaId;
    let tries = 0;
    let seated = 0;
    while (seated < k && tries < k * 4) {
      tries++;
      const w = wallets[Math.floor(rng() * wallets.length)];
      const sid = buy(w, arenaId, round);
      if (sid === null) continue;
      if (rng() < unseatedP) {
        w.unseated.set(arenaId, sid); // bought, never takes the seat
        continue;
      }
      if (seat(w, room, sid)) seated++;
      else w.unseated.set(arenaId, sid);
    }
  }

  function steer(room: Room, s: Seat): void {
    const pl = room.world.players.get(s.pid);
    if (!pl || !pl.alive || !s.conn) return;
    if (rng() > 0.1) return;
    const c = pl.center();
    const me = pl.totalMass();
    const style = s.wallet.style;
    if (style === 'idle') {
      room.world.setTarget(pl.id, c.x, c.y);
      return;
    }
    if (style === 'farmer') {
      let best: { x: number; y: number } | null = null;
      let bd = Infinity;
      for (const l of room.world.loot()) {
        const d = Math.hypot(l.x - c.x, l.y - c.y);
        if (d < bd) {
          bd = d;
          best = l;
        }
      }
      if (best) {
        room.world.setTarget(pl.id, best.x, best.y);
        return;
      }
    }
    if (style === 'hunter' || style === 'farmer') {
      let prey: { x: number; y: number } | null = null;
      let threat: { x: number; y: number } | null = null;
      let pd = Infinity;
      let td = Infinity;
      for (const o of room.world.players.values()) {
        if (o === pl || !o.alive || o.cells.length === 0) continue;
        const oc = o.center();
        const d = Math.hypot(oc.x - c.x, oc.y - c.y);
        const om = o.totalMass();
        if (me >= om * RULES.eatRatio && d < pd) {
          pd = d;
          prey = oc;
        } else if (om >= me * RULES.eatRatio && d < td) {
          td = d;
          threat = oc;
        }
      }
      if (threat && td < 400) room.world.setTarget(pl.id, c.x + (c.x - threat.x), c.y + (c.y - threat.y));
      else if (prey && style === 'hunter') room.world.setTarget(pl.id, prey.x, prey.y);
      else room.world.setTarget(pl.id, c.x + (rng() - 0.5) * 1200, c.y + (rng() - 0.5) * 1200);
      return;
    }
    room.world.setTarget(pl.id, c.x + (rng() - 0.5) * 1200, c.y + (rng() - 0.5) * 1200);
  }

  /**
   * Test arenas: now and then a playing bot meets a staker (side by side, one clearly bigger), so both value paths run
   * within a short round: a staker eating a bot (mass, no value) and a bot eating a staker (its value spills as loot).
   */
  function botEncounters(): void {
    for (const room of rooms.values()) {
      if (!room.opts.test || !room.bots || rng() > 0.03) continue;
      const bots = [...room.bots.bots.values()].filter((b) => !b.leaving).map((b) => b.player).filter((b) => b.alive && b.cells.length > 0);
      const stakers = room.ledger!.all().map((e) => room.world.players.get(e.pid)).filter((p) => !!p && p.alive && p.cells.length > 0);
      if (bots.length === 0 || stakers.length === 0) continue;
      const bot = bots[Math.floor(rng() * bots.length)];
      const big = stakers[Math.floor(rng() * stakers.length)]!.biggestCell()!;
      bot.cells[0].setMass(Math.max(20, rng() < 0.5 ? big.mass * 3 : big.mass * 0.3));
      bot.cells[0].x = big.x + 4;
      bot.cells[0].y = big.y;
      bot.shieldUntil = 0;
      big.player.shieldUntil = 0;
    }
  }

  /** Disconnects, reconnects, and the bookkeeping of players eaten this tick. */
  function play(round: number): void {
    for (const [key, s] of [...seatByPid]) {
      const room = rooms.get(s.roomId);
      const pl = room?.world.players.get(s.pid);
      if (!room || !pl || !room.ledger?.has(s.pid)) continue; // settled: handled when its item is processed
      steer(room, s);
      if (s.conn && s.wallet.style !== 'idle' && rng() < 0.002) {
        room.leave(s.conn, 'disconnect');
        s.conn = null;
      } else if (!s.conn && rng() < 0.01) {
        const conn = fakeConn(s.wallet.addr);
        if (room.reattach(conn, s.pid)) s.conn = conn;
      }
      void key;
    }
    void round;
  }

  /** Room and arena conservation (see the file comment). */
  function check(where: string): void {
    report.checks++;
    // newly enqueued journal items count where they came from
    for (const item of journal.pending) {
      if (seenItems.has(item.key)) continue;
      seenItems.add(item.key);
      const amount = itemAmount(item);
      const roomId = item.kind === 'sweep' ? item.roomId : seatBySession.get(item.key)?.roomId;
      if (roomId === undefined || !roomOut.has(roomId)) {
        violate(`${where}: journal item ${item.key} from no known room`);
        continue;
      }
      roomOut.set(roomId, roomOut.get(roomId)! + amount);
      arenaEnqueued.set(item.arenaId!, arenaEnqueued.get(item.arenaId!)! + amount);
    }
    for (const [id, room] of rooms) {
      const have = room.ledger!.total() + room.lootValue() + roomOut.get(id)!;
      if (have !== roomIn.get(id)) violate(`${where}: room ${id}: live ${room.ledger!.total()} + loot ${room.lootValue()} + handed out ${roomOut.get(id)} != seated + adopted ${roomIn.get(id)}`);
      if (room.bots) for (const pid of room.bots.bots.keys()) if (room.ledger!.has(pid)) violate(`${where}: bot ${pid} holds a ticket in ${id}`);
      for (const e of room.ledger!.all()) if (!Number.isSafeInteger(e.value) || e.value < 0) violate(`${where}: ${e.session} value ${e.value}`);
    }
    for (const a of arenaIds) {
      const snap = journal.liveAndLootByArena(a);
      if (snap + arenaEnqueued.get(a)! !== arenaSeated.get(a)!) violate(`${where}: arena #${a} journal snapshot: live + loot ${snap} + enqueued ${arenaEnqueued.get(a)} != seated ${arenaSeated.get(a)}`);
    }
  }

  let sweepSeq = 0n;
  /** The chain worker's job, done at once: every pending item on the model, then cancels of unseated tickets. */
  function chainPass(where: string, cancelUnseated: boolean): void {
    for (const item of [...journal.pending]) {
      if (item.kind === 'sweep') {
        const amount = fromLedger(item.amount, decimals);
        if (model.sweepLoot(item.arenaId, ++sweepSeq, amount)) {
          report.lootBurned += amount;
          if (report.testArenas && item.roomId.startsWith('test-')) report.testArenas.lootBurnedInTest += item.amount;
        }
        journal.remove(item.key);
        continue;
      }
      const s = seatBySession.get(item.key);
      if (!s) {
        violate(`${where}: settlement ${item.key} of no seat`);
        journal.remove(item.key);
        continue;
      }
      // the chain worker's payout guard holds a payout above its round's pool: an honest game never gets there
      if (item.roundPool === undefined && (item.payout ?? 0) > 0) violate(`${where}: settlement ${item.key} carries no round pool`);
      if (item.roundPool !== undefined && (item.payout ?? 0) > item.roundPool) violate(`${where}: settlement ${item.key} pays ${item.payout}, above its round pool ${item.roundPool} (the payout guard would hold it)`);
      const payout = fromLedger(item.payout ?? 0, decimals);
      const r = model.settle(s.arenaId, s.wallet.addr, s.sessionId, payout);
      journal.remove(item.key);
      seatBySession.delete(item.key);
      seatByPid.delete(`${s.roomId}:${s.pid}`);
      busy.delete(`${s.arenaId}:${s.wallet.addr}`);
      if (!r) {
        violate(`${where}: settlement ${item.key} skipped on chain (${model.skips.at(-1)})`);
        continue;
      }
      report.settled++;
      report.paidOut += r.net;
      report.feeBurned += r.burned;
      report.feeToWallet += r.toVault;
      if (item.reason === 'death') report.deaths++;
      checkFee(where, item.key, s, payout, r);
      for (const st of allStats(s)) {
        st.netOut += r.net;
        st.fees += r.burned + r.toVault;
        if (item.reason === 'death') st.deaths++;
        if (payout > r.session.entryFee) st.winners++;
      }
    }
    if (!cancelUnseated) return;
    for (const w of wallets) {
      for (const [arenaId, sid] of [...w.unseated]) {
        const back = model.cancel(arenaId, w.addr, sid);
        w.unseated.delete(arenaId);
        if (back === null) violate(`${where}: cancel of ${arenaId}:${w.addr}:${sid} skipped (${model.skips.at(-1)})`);
        else {
          report.cancelled++;
          report.paidOut += back;
        }
      }
    }
  }

  function checkFee(where: string, key: string, s: Seat, payout: bigint, r: { net: bigint; burned: bigint; toVault: bigint; session: ModelSession }): void {
    const ms = r.session;
    const profit = payout > ms.entryFee ? payout - ms.entryFee : 0n;
    if (profit === 0n && r.burned + r.toVault !== 0n) violate(`${where}: ${key}: a fee without a profit`);
    if ((r.burned + r.toVault) * BPS > profit * MAX_TOTAL_FEE_BPS) violate(`${where}: ${key}: fee above 25 % of the profit`);
    const wantRates = model.ratesFor(s.wallet.holder);
    if (ms.burnBps !== wantRates.burnBps || ms.vaultBps !== wantRates.vaultBps) violate(`${where}: ${key}: settled at ${ms.burnBps}/${ms.vaultBps}, not the ticket's pair`);
    const shared = computeProfitFee(ms.entryFee, payout, { burnBps: ms.burnBps, vaultBps: ms.vaultBps });
    if (shared.burned !== r.burned || shared.toVault !== r.toVault || shared.net !== r.net) violate(`${where}: ${key}: fees.ts ${shared.burned}/${shared.toVault}/${shared.net} != contract ${r.burned}/${r.toVault}/${r.net}`);
    const sdk = settlementSplit(ms.entryFee, payout, { burnBps: ms.burnBps, vaultBps: ms.vaultBps });
    if (sdk.burned !== r.burned || sdk.toVault !== r.toVault || sdk.net !== r.net) violate(`${where}: ${key}: sdk split != contract`);
    if (s.preview === undefined) violate(`${where}: ${key}: no game-over preview`);
    else {
      const prev = fromLedger(s.preview, decimals);
      const diff = prev > r.net ? prev - r.net : r.net - prev;
      if (diff > 0n) report.previewDiffs++;
      if (diff > report.previewMaxDiff) report.previewMaxDiff = diff;
      // the preview rounds each fee share down in ledger units, the contract in base units: under two ledger units apart
      // (plus the entry fee's own sub-unit dust)
      if (diff >= 2n * unit + (opts.entryDust ?? 0n)) violate(`${where}: ${key}: the server showed ${prev}, the contract paid ${r.net}`);
    }
  }

  function checkChain(where: string): void {
    let dust = 0n;
    for (const [id, a] of model.arenas) {
      if (a.totalDeposited !== a.vault + a.totalPaidOut + a.totalBurned + a.totalFees) violate(`${where}: arena #${id} books: deposited ${a.totalDeposited} != vault ${a.vault} + paid ${a.totalPaidOut} + burned ${a.totalBurned} + fees ${a.totalFees}`);
      let open = 0n;
      let openDust = 0n;
      for (const [k, s] of model.sessions) {
        if (!k.startsWith(`${id}:`)) continue;
        open += s.entryFee;
        openDust += s.entryFee % unit;
      }
      // after the pass every open ticket is an unseated one (cancelled) or none: the vault holds the open tickets'
      // entry fees plus the dust of tickets whose entry fee is not a whole number of ledger units
      const settledDust = a.vault - open;
      if (settledDust < 0n) violate(`${where}: arena #${id}: vault ${a.vault} below the open tickets' ${open}`);
      dust += settledDust;
      void openDust;
    }
    report.vaultDust = dust;
    if (!opts.entryDust && dust !== 0n) violate(`${where}: ${dust} base units left in the vaults with no ticket open`);
    if (!model.supplyOk()) violate(`${where}: token supply does not add up`);
  }

  // ---------------------------------------------------------------- main loop
  const roundOf = (t: number) => roundAt(t, roundCfg.roundMs, roundCfg.closeMs).n;
  let roundsDone = 0;
  let lastRound = roundOf(clock);
  const seatedThisRound = new Map<string, number>();
  const startRound = () => {
    seatedThisRound.clear();
    for (const room of rooms.values()) {
      // test arenas: a person takes a bot's place, so a few people keep bots in play there
      const k = 1 + Math.floor(rng() ** 1.5 * (room.opts.test ? Math.min(maxPerRoom, (opts.bots ?? 10) - 2) : maxPerRoom));
      fill(room, k, roundsDone);
      seatedThisRound.set(room.id, room.ledger!.size);
    }
  };
  startRound();

  while (roundsDone < opts.rounds) {
    report.ticks++;
    if (opts.testArenas) botEncounters();
    play(roundsDone);
    // eaten players buy another ticket while joins are open (into the same room)
    if (rng() < 0.05) {
      for (const room of rooms.values()) {
        if (room.isFull || rng() > 0.3) continue;
        const w = wallets[Math.floor(rng() * wallets.length)];
        const sid = buy(w, room.opts.stake!.arenaId, roundsDone);
        if (sid !== null && !seat(w, room, sid)) w.unseated.set(room.opts.stake!.arenaId, sid);
        else if (sid !== null) seatedThisRound.set(room.id, (seatedThisRound.get(room.id) ?? 0) + 1);
      }
    }
    for (const room of rooms.values()) room.tick(TICK_MS);
    clock += TICK_MS;
    if (report.ticks % checkEvery === 0) {
      check(`tick ${report.ticks}`);
      // a death settles at once: the worker would send it within seconds
      chainPass(`tick ${report.ticks}`, false);
    }

    const n = roundOf(clock);
    if (n === lastRound) continue;
    lastRound = n;
    roundsDone++;
    for (const [id, k] of seatedThisRound) report.maxSeatedInRoom = Math.max(report.maxSeatedInRoom, k, rooms.get(id)?.ledger?.size ?? 0);
    // a room the scaler drains is refused while anything of value is in it (it waits for its bell)
    const draining = [...rooms.values()].filter((r) => !r.opts.test && (r.ledger!.size > 0 || r.lootCount() > 0) && rng() < drainP);
    for (const r of draining) if (r.closeSettled('drained')) violate(`bell ${n}: ${r.id} closed with ${r.ledger!.size} tickets and ${r.lootValue()} loot inside`);
    for (const room of rooms.values()) room.syncRound(clock);
    report.roomRounds += rooms.size;
    check(`bell ${n}`);
    chainPass(`bell ${n}`, true);
    checkChain(`bell ${n}`);
    for (const room of rooms.values()) {
      if (room.ledger!.size !== 0) violate(`bell ${n}: ${room.id} kept ${room.ledger!.size} tickets past its bell`);
      if (room.lootCount() !== 0) violate(`bell ${n}: ${room.id} kept loot past its bell`);
    }
    // the drained rooms close now (nothing of value is left) and the scaler opens a fresh instance
    for (const r of draining) {
      if (!r.closeSettled('drained')) {
        violate(`bell ${n}: ${r.id} could not close after its bell`);
        continue;
      }
      closedRooms++;
      if (report.testArenas && r.opts.test) continue;
      rooms.delete(r.id);
      openRoom(r.opts.stake!.arenaId, nextInstance++, false);
    }
    if (roundsDone < opts.rounds) startRound();
  }

  // drain: nothing open, nothing pending
  chainPass('end', true);
  checkChain('end');
  if (journal.pending.length > 0) violate(`end: ${journal.pending.length} journal items left`);
  for (const a of model.arenas.values()) if (a.openSessions !== 0) violate(`end: ${a.openSessions} tickets left open`);
  if (model.skips.length > 0) violate(`chain skipped ${model.skips.length} items: ${model.skips.slice(0, 3).join('; ')}`);
  if (report.testArenas) {
    for (const room of rooms.values()) {
      if (!room.opts.test) continue;
      report.testArenas.botSpills += room.botSpills.n;
      report.testArenas.botSpillValue += room.botSpills.value;
    }
    // test arenas' loot comes only from stake cells bots ate: what was not burned at a bell was picked up by people
    report.testArenas.lootPickedInTest = report.testArenas.botSpillValue - report.testArenas.lootBurnedInTest;
  }
  report.supply = { minted: model.minted, burned: model.burned, feeWallet: model.feeWallet, faucetClaims };
  report.closedRooms = closedRooms;
  report.ms = Date.now() - t0;
  return report;
}

const totalBps = (r: FeeRates) => r.burnBps + r.vaultBps;

/** A float of `a / b` for the report. */
export const ratio = (a: bigint, b: bigint): number => (b === 0n ? 0 : Number((a * 1_000_000n) / b) / 1_000_000);
