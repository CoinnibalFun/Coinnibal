/**
 * Mainnet economic simulation of Elymum (Robinhood Chain 4663, $ELYMUM from Pons, USD tiers $1 / $3 / $5 / $10 with
 * the $10 arena for emblem holders, 20 % fee on profit for everyone else and 10 % for holders, no bots).
 *
 * Four layers, each built on the real code and nothing invented where the code has the answer:
 *
 *  1. **Physics calibration** (`runArenaRounds`, `calibrate`): real arena `Room`s (the real world, ledger, round clock,
 *     dynamic map and integrity telemetry) on 5-minute rounds (`RULES.roundMs` of play, joins closed in the last
 *     minute, the 30 s break after each bell on top).
 *     Every seat is a person emulated as in `scripts/integrity-sim.ts`: the practice-bot brain stands in for the
 *     person's intent, behind a human reaction delay, mouse smoothing and network latency. Skill is the brain's level:
 *     weak = `easy`, median = `normal`, skilled = `hard`. Eaten players buy another ticket while joins are open. The
 *     output is every ticket's gross value at its settlement, as a multiple of its entry fee, per room-round.
 *  2. **Economy** (`runEconomy`): 100 or 200 concurrent players over hours of 5:30 round cycles. Each instance's round
 *     replays a calibrated room-round of its size, at the tier's entry fee in token base units (`usdToTokenRaw` at a
 *     mainnet price), with the contract's own split (`computeProfitFee` at `ratesFor` holder / normal rates),
 *     power-up purchases (`SHOP_DEFAULTS`, `paymentSplit`) and the settlement worker's batching (deaths at their
 *     time in the round, the bell, chunks of 40, the stale sweeper's cancels). It asserts the conservation invariants
 *     in exact integers (Σ entry = Σ net + Σ burned + Σ fee wallet + Σ vault left, per arena and per round) and
 *     prices the server key's gas with the Hardhat measurements (`mainnet-gas.json`).
 *  3. **Price volatility** (`repricingStudy`): a token price path with ±50 % days, the USD value of every ticket
 *     between two syncs, and how long each sync keeps joins paused (`ArenaBusy` needs zero open tickets) under the
 *     current behaviour (unseated tickets wait for the 15-minute stale sweeper) and under the proposed one.
 *  4. **Abuse** (`abuseStudy`): feeding with fixed wallets and with fresh wallets per round, teaming, all in the real
 *     room with the real integrity detectors, against an honest control on the same seeds.
 *
 * `scripts/mainnet-econ-sim.ts` prints the report (`pnpm -F @elymum/server econ-sim`); `mainnet-econ.test.ts` runs a
 * short version and the mainnet scenario of the money simulation.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClientOp,
  DEFAULT_ARENAS,
  DEFAULT_FEE_RATES,
  DEFAULT_HOLDER_FEE_RATES,
  MAP_SCALE_DEFAULT,
  PlayerFlag,
  RULES,
  SHOP_DEFAULTS,
  TICK_MS,
  computeProfitFee,
  packPriceRaw,
  parseUsdPrice,
  paymentSplit,
  ratesFor,
  roundAt,
  roundCycleMs,
  tokenRawToUsd,
  usdToTokenRaw,
  type ClientInput,
  type FeeRates,
  type IntegrityFlag,
} from '@elymum/shared';
import { BotBrain, type BotLevel } from '../src/bots/brain';
import { NullChain } from '../src/chain/types';
import type { Player } from '../src/game/entities';
import { mulberry32, type Rng } from '../src/game/rng';
import { IntegrityService } from '../src/integrity/service';
import { IntegrityStore } from '../src/integrity/store';
import { Leaderboards } from '../src/leaderboards';
import { Conn } from '../src/net/conn';
import { Room } from '../src/rooms/room';
import { Journal } from '../src/stake/journal';

/* ================================================================== */
/* 1. Physics calibration                                              */
/* ================================================================== */

export type Skill = 'weak' | 'median' | 'skilled';
export const SKILLS: readonly Skill[] = ['weak', 'median', 'skilled'];
const LEVEL: Record<Skill, BotLevel> = { weak: 'easy', median: 'normal', skilled: 'hard' };
/** Human reaction delay (ms) on top of the brain's own thinking time. */
const REACTION: Record<Skill, [number, number]> = { weak: [300, 450], median: [200, 320], skilled: [150, 220] };

/** One seat of a calibration room: a person who plays every round (and re-buys after being eaten, sometimes). */
export interface Seat {
  skill: Skill;
  /** `feeder`: walks into its group's receiver; `receiver`: the one fed; `team`: never attacks its group, hunts with it. */
  role: 'honest' | 'feeder' | 'receiver' | 'team';
  group?: number;
  /** A fresh wallet for every round (a sybil ring rotating its feeder wallets). */
  rotateWallet?: boolean;
}

/** One ticket: its gross value at settlement in ledger units (entry fee `ENTRY`), why it ended and when. */
export interface TicketRec {
  seat: number;
  skill: Skill;
  role: Seat['role'];
  group?: number;
  wallet: string;
  round: number;
  payout: number;
  reason: string;
  /** Seconds from the round's start to the settlement (deaths mid-round, the bell at the end). */
  atS: number;
}

export interface RoomRound {
  players: number;
  round: number;
  tickets: TicketRec[];
}

export interface RoomRun {
  seats: Seat[];
  rounds: RoomRound[];
  flags: IntegrityFlag[];
  ms: number;
}

/** Entry fee of every calibration ticket, in ledger units (the ratio is what the economy layer uses). */
export const ENTRY = 1_000_000;

const noise = (rng: Rng) => rng() + rng() + rng() - 1.5;

function walletOf(seat: number, round: number, rotate: boolean): string {
  const tag = rotate ? 0xf00000 + round * 64 + seat : 0xa00000 + seat;
  return `0x${tag.toString(16).padStart(8, '0')}${'0'.repeat(32)}`;
}

function fakeConn(wallet: string, ip: string, fp: string): Conn {
  const ws = { readyState: 1, bufferedAmount: 1 << 30, send() {} };
  const conn = new Conn(ws as never, ip);
  conn.wallet = wallet;
  conn.fp = fp;
  conn.send = () => {};
  return conn;
}

interface Client {
  seat: number;
  spec: Seat;
  wallet: string;
  conn: Conn;
  brain: BotBrain;
  latency: number;
  jitter: number;
  reaction: number;
  mouse: { x: number; y: number } | null;
  goal: { x: number; y: number } | null;
  decisions: { at: number; target: { x: number; y: number }; split: boolean }[];
  lastSent: number;
  lastSentAim: { x: number; y: number };
  outbox: { at: number; input: ClientInput }[];
  /** When this person buys the next ticket (ms of sim clock); null: not this round. */
  nextBuyAt: number | null;
  lastEjectAt: number;
}

/**
 * Plays `rounds` full arena rounds (after one warm-up round that sizes the map) in one real arena instance.
 * `rebuy`: chance that an eaten person buys another ticket in the same round (joins still open).
 */
export function runArenaRounds(o: { seats: Seat[]; rounds: number; seed: number; rebuy?: number; integrity?: boolean }): RoomRun {
  const t0 = Date.now();
  const rng = mulberry32(o.seed);
  const rebuy = o.rebuy ?? 0.6;
  const ROUND = { roundMs: RULES.roundMs, closeMs: RULES.roundJoinCloseMs, breakMs: RULES.roundBreakMs };
  // the sim clock starts at the wall clock (rounded to a round): the room's 6-hour ticket age check reads
  // `Date.now()`, and a sim clock in the past would cash tickets out mid-round as "maxage"
  let clock = roundAt(Date.now(), ROUND.roundMs, ROUND.closeMs, ROUND.breakMs).endsAt + ROUND.breakMs;
  let mono = 1_000_000;
  const journal = new Journal(null);
  const integrity = o.integrity === false ? null : new IntegrityService({ store: new IntegrityStore(null), journal, kick: () => {}, now: () => clock, mono: () => mono });
  const room = new Room(
    { id: 'arena-1-1', mode: 'arena', name: 'Arena', maxPlayers: 50, instance: 1, stake: { arenaId: 1, buyIn: ENTRY }, seed: o.seed * 7919 + 1, map: { scale: { ...MAP_SCALE_DEFAULT } } },
    { chain: new NullChain(), journal, leaderboards: new Leaderboards(null), log: () => {}, now: () => clock, round: ROUND, integrity: integrity ?? undefined },
  );
  const world = room.world;
  let sessionSeq = 0;
  const clients: Client[] = o.seats.map((spec, seat) => {
    const [r0, r1] = REACTION[spec.skill];
    const wallet = walletOf(seat, 0, !!spec.rotateWallet);
    // honest people play from their own device; a ring of colluders plays from different ones (they know the IP check)
    return {
      seat,
      spec,
      wallet,
      conn: fakeConn(wallet, `10.${seat >> 8}.${seat & 255}.${1 + Math.floor(rng() * 200)}`, `fp${seat.toString(16).padStart(30, '0')}`),
      brain: new BotBrain(LEVEL[spec.skill], rng, 0),
      latency: 15 + rng() * 90,
      jitter: 2 + rng() * 10,
      reaction: r0 + rng() * (r1 - r0),
      mouse: null,
      goal: null,
      decisions: [],
      lastSent: -1e9,
      lastSentAim: { x: NaN, y: NaN },
      outbox: [],
      nextBuyAt: clock + rng() * 8_000,
      lastEjectAt: 0,
    };
  });
  const groupOf = (g: number | undefined) => clients.filter((c) => c.spec.group !== undefined && c.spec.group === g);

  const out: RoomRound[] = [];
  let cur: RoomRound | null = null;
  let roundStart = roundAt(clock, ROUND.roundMs, ROUND.closeMs, ROUND.breakMs).opensAt;
  let roundNo = 0;
  const seatOfWallet = new Map<string, number>();

  const buy = (c: Client) => {
    const n = ++sessionSeq;
    if (c.spec.rotateWallet) {
      c.wallet = walletOf(c.seat, roundNo, true);
      c.conn.wallet = c.wallet;
    }
    seatOfWallet.set(c.wallet.toLowerCase(), c.seat);
    room.join(c.conn, {
      name: `p${c.seat}`,
      skin: 1,
      flags: PlayerFlag.Staker,
      stake: { player: c.wallet, session: `1:${c.wallet.toLowerCase()}:${n}`, sessionId: n, arenaId: 1, entryFee: ENTRY, value: ENTRY, openedAt: Math.floor(clock / 1000) },
    });
    c.mouse = null;
    c.goal = null;
    c.decisions = [];
    c.outbox = [];
  };
  const send = (c: Client, input: ClientInput, at: number) => {
    c.outbox.push({ at: at + Math.max(1, c.latency + noise(rng) * c.jitter), input });
  };

  /** The colluders' intent replaces the brain's where it applies. */
  const collude = (c: Client, p: Player, now: number, brainTarget: { x: number; y: number } | null): { x: number; y: number } | null => {
    if (c.spec.role === 'feeder') {
      const recv = groupOf(c.spec.group).find((x) => x.spec.role === 'receiver')?.conn.player;
      if (!recv?.alive) return null;
      const rc = recv.center();
      // feed mass first (ejected blobs), then walk into the receiver's mouth once it can eat this coin
      if (recv.totalMass() >= p.totalMass() * RULES.eatRatio * 1.05) return rc;
      if (now - c.lastEjectAt > 400 && Math.hypot(rc.x - p.center().x, rc.y - p.center().y) < 600) {
        c.lastEjectAt = now;
        send(c, { op: ClientOp.Eject }, now);
      }
      return rc;
    }
    if (c.spec.role === 'team') {
      // the brain plays as usual, except that a mate is neither prey nor threat: when the brain chases or flees a
      // mate, the coin hunts the nearest outsider it can eat instead (or keeps near its mates)
      const mates = groupOf(c.spec.group).filter((x) => x !== c && x.conn.player?.alive);
      if (!brainTarget || mates.length === 0) return null;
      const me = p.center();
      const aboutMate = mates.some((m) => {
        const mc = m.conn.player!.center();
        const toMate = Math.atan2(mc.y - me.y, mc.x - me.x);
        const toTarget = Math.atan2(brainTarget.y - me.y, brainTarget.x - me.x);
        const away = Math.atan2(me.y - mc.y, me.x - mc.x);
        const close = Math.hypot(mc.x - me.x, mc.y - me.y) < 900;
        const diff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
        return close && (diff(toMate, toTarget) < 0.35 || diff(away, toTarget) < 0.35);
      });
      if (!aboutMate) return null;
      let best: { x: number; y: number } | null = null;
      let bd = 1500;
      for (const q of world.players.values()) {
        if (q === p || !q.alive || mates.some((m) => m.conn.player === q)) continue;
        if (q.totalMass() * RULES.eatRatio > p.totalMass()) continue;
        const qc = q.center();
        const d = Math.hypot(qc.x - me.x, qc.y - me.y);
        if (d < bd) {
          bd = d;
          best = qc;
        }
      }
      return best ?? { x: me.x + (me.x - mates[0].conn.player!.center().x) * 0.2, y: me.y + (me.y - mates[0].conn.player!.center().y) * 0.2 };
    }
    return null;
  };

  const ticks = Math.round(((o.rounds + 1) * roundCycleMs(ROUND.roundMs, ROUND.breakMs)) / TICK_MS) + 2;
  for (let t = 0; t < ticks; t++) {
    const tickStart = mono;
    const r = roundAt(clock, ROUND.roundMs, ROUND.closeMs, ROUND.breakMs);
    for (const c of clients) {
      const p: Player | null = c.conn.player && c.conn.player.alive ? c.conn.player : null;
      if (!p) continue;
      const center = p.center();
      const now = world.now;
      if (c.brain.shouldThink(now)) {
        const d = c.brain.think(world, p, now);
        const override = c.spec.role === 'honest' ? null : collude(c, p, tickStart, d?.target ?? null);
        // nobody splits: the practice brain's split (hard level) is reckless and made `hard` worse than `normal`
        // (calibration: 35 % eaten against 24 %); a skilled person splits only on a sure kill, which the brain cannot tell
        if (override) c.decisions.push({ at: tickStart + c.reaction + noise(rng) * 40, target: override, split: false });
        else if (d) c.decisions.push({ at: tickStart + c.reaction + noise(rng) * 40, target: d.target, split: false });
      }
      for (let f = 0; f < 2; f++) {
        const ft = tickStart + f * (TICK_MS / 2) + noise(rng) * 1.5;
        while (c.decisions.length > 0 && c.decisions[0].at <= ft) {
          const d = c.decisions.shift()!;
          c.goal = d.target;
          if (d.split) send(c, { op: ClientOp.Split }, ft);
        }
        const goal = c.goal ?? center;
        const off = c.mouse ?? { x: goal.x - center.x, y: goal.y - center.y };
        off.x += (goal.x - center.x - off.x) * 0.25 + noise(rng) * 2.2;
        off.y += (goal.y - center.y - off.y) * 0.25 + noise(rng) * 2.2;
        c.mouse = off;
        const aim = { x: center.x + off.x + noise(rng) * 0.6, y: center.y + off.y + noise(rng) * 0.6 };
        const moved = Math.hypot(aim.x - c.lastSentAim.x, aim.y - c.lastSentAim.y) > 1.5;
        if (ft - c.lastSent < 33 || (!moved && ft - c.lastSent < 250)) continue;
        c.lastSent = ft;
        c.lastSentAim = aim;
        send(c, { op: ClientOp.Target, x: aim.x, y: aim.y }, ft);
      }
    }
    const due: { at: number; c: Client; input: ClientInput }[] = [];
    for (const c of clients) {
      if (c.outbox.length === 0) continue;
      const keep: Client['outbox'] = [];
      for (const m of c.outbox) (m.at < tickStart + TICK_MS ? due.push({ at: m.at, c, input: m.input }) : keep.push(m));
      c.outbox = keep;
    }
    due.sort((a, b) => a.at - b.at);
    for (const d of due) {
      mono = Math.max(mono, d.at);
      room.input(d.c.conn, d.input);
    }
    mono = tickStart + TICK_MS;
    clock += TICK_MS;
    room.tick(TICK_MS);

    const r2 = roundAt(clock, ROUND.roundMs, ROUND.closeMs, ROUND.breakMs);
    if (r2.n !== r.n) {
      roundNo++;
      roundStart = r2.opensAt;
      if (cur) out.push(cur);
      cur = roundNo >= 1 ? { players: clients.length, round: roundNo, tickets: [] } : null;
      // everyone plays on: a new ticket when the floor opens after the break
      for (const c of clients) c.nextBuyAt = r2.opensAt + rng() * 6_000;
    }
    // settlements written this tick: the ticket's value at its end
    for (const item of journal.pending) {
      if (item.kind !== 'settle' || (item as { simSeen?: boolean }).simSeen) continue;
      (item as { simSeen?: boolean }).simSeen = true;
      const seat = seatOfWallet.get(item.player.toLowerCase());
      if (seat === undefined) continue;
      const c = clients[seat];
      // the bell's settlements belong to the round that just ended
      const atS = item.reason === 'round' ? ROUND.roundMs / 1000 : (clock - roundStart) / 1000;
      // the bell's settlements belong to the round that just ended; deaths to the round in play
      const last = out[out.length - 1];
      const target = item.reason === 'round' ? (last && last.round === roundNo - 1 ? last : null) : cur;
      target?.tickets.push({ seat, skill: c.spec.skill, role: c.spec.role, group: c.spec.group, wallet: item.player, round: target.round, payout: item.payout ?? 0, reason: item.reason ?? '?', atS });
      if (item.reason === 'death') {
        // eaten: buy again a little later while joins are open (or wait for the next round)
        const t = clock + 4_000 + rng() * 16_000;
        c.nextBuyAt = rng() < rebuy && t < r2.joinsCloseAt ? t : null;
      }
    }
    for (const item of [...journal.pending]) journal.remove(item.key);
    for (const c of clients) {
      if (c.nextBuyAt !== null && clock >= c.nextBuyAt && clock < r2.joinsCloseAt && clock >= r2.opensAt && !(c.conn.player?.alive) && !room.findStakeByWallet(c.wallet)) {
        c.nextBuyAt = null;
        buy(c);
      }
    }
  }
  room.shutdown();
  const flags = integrity ? (integrity.scan(), integrity.listFlags()) : [];
  // the last round is complete only when its bell rang inside the run
  return { seats: o.seats, rounds: out.filter((x) => x.tickets.some((t) => t.reason === 'round')).slice(0, o.rounds), flags, ms: Date.now() - t0 };
}

/** The population's skill mix (shares of weak / median / skilled players). */
export const SKILL_MIX: Record<Skill, number> = { weak: 0.3, median: 0.5, skilled: 0.2 };

/** Seats of `n` honest people in the population's skill mix (deterministic proportions, shuffled). */
export function honestSeats(n: number, rng: Rng, mix: Record<Skill, number> = SKILL_MIX): Seat[] {
  const seats: Seat[] = [];
  const nSkilled = Math.round(n * mix.skilled);
  const nWeak = Math.round(n * mix.weak);
  for (let i = 0; i < n; i++) seats.push({ skill: i < nSkilled ? 'skilled' : i < nSkilled + nWeak ? 'weak' : 'median', role: 'honest' });
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  return seats;
}

export interface Calibration {
  /** Room-rounds by instance size. */
  bySize: Map<number, RoomRound[]>;
  ms: number;
}

/** Physics runs for each instance size: `rounds` full rounds per seed. */
export function calibrate(o: { sizes: number[]; rounds: number; seeds: number[]; log?: (m: string) => void }): Calibration {
  const t0 = Date.now();
  const bySize = new Map<number, RoomRound[]>();
  for (const size of o.sizes) {
    const list: RoomRound[] = [];
    for (const seed of o.seeds) {
      const run = runArenaRounds({ seats: honestSeats(size, mulberry32(seed ^ size)), rounds: o.rounds, seed: seed * 31 + size, integrity: false });
      list.push(...run.rounds);
      o.log?.(`calibration: ${size} players, seed ${seed}: ${run.rounds.length} rounds, ${run.rounds.reduce((s, r) => s + r.tickets.length, 0)} tickets in ${(run.ms / 1000).toFixed(1)} s`);
    }
    bySize.set(size, list);
  }
  return { bySize, ms: Date.now() - t0 };
}

/** Per-skill statistics of calibrated tickets (payout as a multiple of the entry fee). */
export function skillStats(rounds: RoomRound[]): Record<Skill, { tickets: number; seatRounds: number; ticketsPerSeatRound: number; meanPayout: number; pDeath: number; pProfit: number; p10: number; p50: number; p90: number }> {
  const out = {} as ReturnType<typeof skillStats>;
  for (const s of SKILLS) {
    const xs: number[] = [];
    let deaths = 0;
    const seatRounds = new Set<string>();
    for (const r of rounds) for (const t of r.tickets) if (t.skill === s) {
      xs.push(t.payout / ENTRY);
      if (t.reason === 'death') deaths++;
      seatRounds.add(`${r.round}:${t.seat}:${r.players}`);
    }
    xs.sort((a, b) => a - b);
    const q = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
    out[s] = {
      tickets: xs.length,
      seatRounds: seatRounds.size,
      ticketsPerSeatRound: seatRounds.size ? xs.length / seatRounds.size : 0,
      meanPayout: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
      pDeath: deaths / Math.max(1, xs.length),
      pProfit: xs.filter((x) => x > 1).length / Math.max(1, xs.length),
      p10: q(0.1),
      p50: q(0.5),
      p90: q(0.9),
    };
  }
  return out;
}

/* ================================================================== */
/* 2. Economy                                                          */
/* ================================================================== */

export interface GasFigures {
  [k: string]: { gas: number; inputBytes: number } | number | string;
}

export function loadGas(): GasFigures {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, 'mainnet-gas.json'), 'utf8')) as GasFigures;
}

const gasOf = (g: GasFigures, k: string) => (g[k] as { gas: number; inputBytes: number }).gas;
const bytesOf = (g: GasFigures, k: string) => (g[k] as { gas: number; inputBytes: number }).inputBytes;

/** Piecewise-linear interpolation of a measured shape over its batch sizes (extrapolated from the last two). */
function interp(g: GasFigures, shape: string, k: number): number {
  const pts = Object.keys(g)
    .filter((x) => x.startsWith(`${shape}_`) && /^\d+$/.test(x.slice(shape.length + 1)))
    .map((x) => [Number(x.slice(shape.length + 1)), gasOf(g, x)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) throw new Error(`gas figures: need two sizes of ${shape}`);
  let i = pts.findIndex((p) => p[0] >= k);
  if (i <= 0) i = i === 0 ? 1 : pts.length - 1;
  const [x0, y0] = pts[i - 1];
  const [x1, y1] = pts[i];
  return y0 + ((y1 - y0) * (k - x0)) / (x1 - x0);
}

/**
 * Gas and calldata bytes of one server transaction: a `settle` of `k` items of which `paid` carry a payout (a death
 * settles at 0 and moves no token; the bell pays the living, with the burn and the fee-wallet share once per batch),
 * or a `cancel` of `k` unplayed tickets.
 */
export function txGas(g: GasFigures, kind: 'settle' | 'cancel', k: number, paid: number): { gas: number; bytes: number } {
  if (kind === 'cancel') {
    const c1 = gasOf(g, 'cancel_1');
    const b = (gasOf(g, 'cancel_10') - c1) / 9;
    return { gas: Math.round(c1 + b * (k - 1)), bytes: Math.round(bytesOf(g, 'cancel_1') + ((bytesOf(g, 'cancel_10') - bytesOf(g, 'cancel_1')) / 9) * (k - 1)) };
  }
  const bytes = Math.round(bytesOf(g, 'settle_death_1') + ((bytesOf(g, 'settle_death_10') - bytesOf(g, 'settle_death_1')) / 9) * (k - 1));
  if (paid === 0) return { gas: Math.round(interp(g, 'settle_death', k)), bytes };
  // a mixed batch: the measured bell batch of k (every item paid), less the saving of each zero payout in it
  const paidSlope = (interp(g, 'settle_bell', 40) - interp(g, 'settle_bell', 10)) / 30;
  const zeroSlope = (interp(g, 'settle_death', 10) - interp(g, 'settle_death', 1)) / 9;
  const perZero = Math.max(0, paidSlope - zeroSlope);
  return { gas: Math.round(interp(g, 'settle_bell', k) - perZero * (k - paid)), bytes };
}

export interface MainnetScenario {
  name: string;
  /** Concurrent players at the tables. */
  concurrent: number;
  /** USD per whole token (`parseUsdPrice`). */
  usdPerToken: string;
  /** Share of players per arena id (the $10 arena #4 for emblem holders only). */
  tierShare: Record<number, number>;
  /** Share of players of the open arenas who hold the emblem (#4's players all do). */
  holderShare: number;
  /** Power-ups: share of players who buy packs, and the arena charges a buyer uses per round (cap 2, holders 3). */
  powerUps: { buyerShare: number; usesPerRound: number };
  /** Simulated hours. */
  hours: number;
  /** Share of tickets bought and never seated (cancelled by the stale sweeper). */
  unplayed: number;
  /** Seconds from a send to its receipt (the worker sends one transaction at a time). */
  txLatencyS: number;
  seed: number;
}

export const MAINNET_DEFAULT: Omit<MainnetScenario, 'name' | 'concurrent'> = {
  usdPerToken: '0.0001',
  tierShare: { 1: 0.4, 2: 0.25, 3: 0.2, 4: 0.15 },
  holderShare: 0.3,
  powerUps: { buyerShare: 0.25, usesPerRound: 1.5 },
  hours: 24,
  unplayed: 0.01,
  txLatencyS: 1,
  seed: 4663,
};

/** Seats per instance before the scaler opens another (80 % of `ARENA_INSTANCE_CAP` 50). */
const INSTANCE_FILL = 40;
export const TOKEN_DECIMALS = 18;
export const SUPPLY_TOKENS = 1_000_000_000n;

export interface TierBook {
  arenaId: number;
  usdCents: number;
  entry: bigint;
  players: number;
  instances: number;
  tickets: number;
  deposited: bigint;
  netPaid: bigint;
  burned: bigint;
  toFeeWallet: bigint;
  vaultLeft: bigint;
  winners: number;
  powerUpSpend: bigint;
}

export interface SkillEv {
  /** Tickets and player-rounds of this skill. */
  tickets: number;
  playerRounds: number;
  /** Mean of (net received − entry) per player-round, as a share of one entry fee. */
  evPerRound: number;
  /** Same, before the fee on profit (the zero-sum transfer only). */
  grossPerRound: number;
  /** The fee on profit and the power-ups this skill pays per player-round, in entry fees. */
  feePerRound: number;
  powerUpsPerRound: number;
  /** Per hour (12 rounds) in USD at each tier. */
  usdPerHour: Record<number, number>;
}

export interface Bankroll {
  skill: Skill;
  /** Starting bankroll in tickets of its tier. */
  startTickets: number;
  /** Share busted (bankroll below one ticket) after 1 h, 4 h, the run; median hours to bust (Infinity: under half bust). */
  busted1h: number;
  busted4h: number;
  bustedEnd: number;
  medianHoursToBust: number;
}

export interface GasReport {
  txs: number;
  txByKind: Record<string, number>;
  gasPerDay: number;
  meanItemsPerTx: number;
  /** ETH per day of the server key at each gas price (gwei), L1 data fee included (`l1WeiPerByte`). */
  ethPerDay: Record<string, number>;
  usdPerDay: Record<string, number>;
}

export interface EconomyReport {
  scenario: MainnetScenario;
  rounds: number;
  tiers: TierBook[];
  perHour: { burnedTokens: number; feeWalletTokens: number; powerUpBurnTokens: number; powerUpFeeTokens: number; burnedUsd: number; feeWalletUsd: number };
  perDay: { burnedTokens: number; feeWalletTokens: number; burnedUsd: number; feeWalletUsd: number; burnedShareOfSupply: number };
  /** House take per player-round, as a share of the entry fee: fee on profit, and fee + power-ups. */
  houseEdge: { feeOnly: number; withPowerUps: number; feePerTicket: number; byTier: Record<number, number> };
  /**
   * Σ profit / Σ entry fees: how much value changes hands per staked token (the house edge is about the fee rate
   * times this). The physics calibration's brains are careful players: if real players trade value k times as much,
   * the fee part of the edge is k times as large.
   */
  transferRate: number;
  ev: Record<Skill, SkillEv>;
  bankrolls: Bankroll[];
  gas: GasReport;
  violations: string[];
}

/** Gas prices (gwei) of the cost table: Arbitrum One's floor, the Arbitrum Orbit default minimum base fee, congestion. */
export const GAS_PRICES_GWEI = [0.01, 0.1, 0.25];
/** L1 data fee per calldata byte (wei), Arbitrum-style poster fee after blobs: 0 to a few gwei-bytes. */
export const L1_WEI_PER_BYTE = 2_000_000_000; // 2 gwei per byte: generous for blob-era posting
export const ETH_USD = 3_000;

function nearestSize(cal: Calibration, n: number): number {
  let best = -1;
  for (const s of cal.bySize.keys()) if (best < 0 || Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

/** Players of `n` split over instances of at most `INSTANCE_FILL` (the scaler's 80 % of 50). */
export function instancesFor(n: number): number[] {
  if (n <= 0) return [];
  const k = Math.ceil(n / INSTANCE_FILL);
  const base = Math.floor(n / k);
  return Array.from({ length: k }, (_, i) => base + (i < n % k ? 1 : 0));
}

/** Runs the economy of one scenario on calibrated room-rounds. */
export function runEconomy(cal: Calibration, sc: MainnetScenario, gasFig: GasFigures = loadGas()): EconomyReport {
  const rng = mulberry32(sc.seed);
  const price = parseUsdPrice(sc.usdPerToken);
  const violations: string[] = [];
  const rounds = Math.round((sc.hours * 3_600_000) / roundCycleMs());
  const usd = (raw: bigint) => tokenRawToUsd(raw, price, TOKEN_DECIMALS);
  const tokens = (raw: bigint) => Number(raw / 10n ** 12n) / 1e6;
  // the arenas: tier prices converted at the mainnet price, 2 significant figures (the admin's default)
  const tiers: TierBook[] = DEFAULT_ARENAS.map((a) => {
    const players = Math.round(sc.concurrent * (sc.tierShare[a.id] ?? 0));
    return { arenaId: a.id, usdCents: a.usdCents, entry: usdToTokenRaw(a.usdCents, price, TOKEN_DECIMALS, 2), players, instances: instancesFor(players).length, tickets: 0, deposited: 0n, netPaid: 0n, burned: 0n, toFeeWallet: 0n, vaultLeft: 0n, winners: 0, powerUpSpend: 0n };
  });
  const shop = SHOP_DEFAULTS;
  const kinds = Object.keys(shop.prices) as (keyof typeof shop.prices)[];
  const chargeRaw = (holder: boolean) => {
    const k = kinds[Math.floor(rng() * kinds.length)];
    return packPriceRaw(shop.prices[k], TOKEN_DECIMALS, holder ? shop.holderDiscountPct : 0) / BigInt(shop.packSize);
  };
  let profitAll = 0n;
  let puBurn = 0n;
  let puFee = 0n;
  const evAcc = new Map<Skill, { tickets: number; playerRounds: number; net: number; gross: number; fee: number; pu: number; usd: Record<number, number> }>();
  for (const s of SKILLS) evAcc.set(s, { tickets: 0, playerRounds: 0, net: 0, gross: 0, fee: 0, pu: 0, usd: {} });
  // per-round outcomes of every seat, in entry fees net of the fee (the bankroll walk samples these)
  const seatRoundNet = new Map<string, number[]>(); // `${tier}:${skill}` → net change per player-round in entries
  // the settlement worker: every settlement with its time (seconds of the run) and arena
  const events: { t: number; arenaId: number; kind: 'settle' | 'cancel'; paid: boolean }[] = [];
  const feeByTier = new Map<number, { fee: bigint; pu: bigint; entries: bigint; playerRounds: number }>();

  for (let r = 0; r < rounds; r++) {
    const t0 = r * (roundCycleMs() / 1000);
    for (const tier of tiers) {
      for (const size of instancesFor(tier.players)) {
        const lib = cal.bySize.get(nearestSize(cal, size))!;
        const rr = lib[Math.floor(rng() * lib.length)];
        // the seats of this instance: holders fixed per seat for the round
        const holderSeat = new Map<number, boolean>();
        const buyer = new Map<number, boolean>();
        const seatNet = new Map<number, { skill: Skill; net: bigint; gross: bigint; fee: bigint; pu: bigint }>();
        let dep = 0n;
        let paid = 0n;
        let burned = 0n;
        let fees = 0n;
        for (const t of rr.tickets) {
          if (!holderSeat.has(t.seat)) {
            holderSeat.set(t.seat, tier.arenaId === 4 || rng() < sc.holderShare);
            buyer.set(t.seat, rng() < sc.powerUps.buyerShare);
          }
          const holder = holderSeat.get(t.seat)!;
          const rates: FeeRates = ratesFor(DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, holder);
          // exact scaling: the ledger payout of a ticket of ENTRY, at this tier's entry (ENTRY divides the entry)
          const payout = (BigInt(t.payout) * tier.entry) / BigInt(ENTRY);
          if ((BigInt(t.payout) * tier.entry) % BigInt(ENTRY) !== 0n) violations.push(`arena #${tier.arenaId}: payout scaling is not exact`);
          const f = computeProfitFee(tier.entry, payout, rates);
          dep += tier.entry;
          paid += f.net;
          burned += f.burned;
          fees += f.toVault;
          if (f.profit > 0n) tier.winners++;
          profitAll += f.profit;
          tier.tickets++;
          const sn = seatNet.get(t.seat) ?? { skill: t.skill, net: 0n, gross: 0n, fee: 0n, pu: 0n };
          sn.net += f.net - tier.entry;
          sn.gross += payout - tier.entry;
          sn.fee += f.fee;
          seatNet.set(t.seat, sn);
          events.push({ t: t0 + t.atS + rng() * 0.05, arenaId: tier.arenaId, kind: 'settle', paid: payout > 0n });
          const acc = evAcc.get(t.skill)!;
          acc.tickets++;
        }
        // unplayed tickets: bought, never seated, cancelled in full by the stale sweeper (15 min + the 5-min sweep)
        const unplayed = Math.round(rr.tickets.length * sc.unplayed + (rng() - 0.5));
        for (let i = 0; i < unplayed; i++) events.push({ t: t0 + rng() * 300 + 900 + rng() * 300, arenaId: tier.arenaId, kind: 'cancel', paid: true });
        // conservation of the instance's round: every token paid in is paid out, burned or sent to the fee wallet
        // (the vault keeps nothing: no loot, no bots), as the contract's books require (deposited = vault + paid + burned + fees)
        const left = dep - paid - burned - fees;
        if (left !== 0n) violations.push(`round ${r} arena #${tier.arenaId}: deposited ${dep} != paid ${paid} + burned ${burned} + fees ${fees} (vault left ${left})`);
        tier.deposited += dep;
        tier.netPaid += paid;
        tier.burned += burned;
        tier.toFeeWallet += fees;
        tier.vaultLeft += left;
        // power-ups bought for this round's charges (packs of 3, half burned)
        for (const [seat, sn] of seatNet) {
          if (!buyer.get(seat)) continue;
          const holder = holderSeat.get(seat)!;
          const cap = shop.arenaUsesPerRound + (holder ? shop.holderExtraArenaUses : 0);
          const uses = Math.min(cap, Math.floor(sc.powerUps.usesPerRound + rng()));
          let spend = 0n;
          for (let u = 0; u < uses; u++) spend += chargeRaw(holder);
          const split = paymentSplit(spend);
          puBurn += split.burned;
          puFee += split.toVault;
          sn.pu += spend;
          tier.powerUpSpend += spend;
        }
        const fb = feeByTier.get(tier.arenaId) ?? { fee: 0n, pu: 0n, entries: 0n, playerRounds: 0 };
        for (const sn of seatNet.values()) {
          const acc = evAcc.get(sn.skill)!;
          acc.playerRounds++;
          const e = Number(tier.entry);
          acc.net += Number(sn.net - sn.pu) / e;
          acc.gross += Number(sn.gross) / e;
          acc.fee += Number(sn.fee) / e;
          acc.pu += Number(sn.pu) / e;
          const key = `${tier.arenaId}:${sn.skill}`;
          const list = seatRoundNet.get(key) ?? [];
          if (list.length < 20_000) list.push(Number(sn.net - sn.pu) / e);
          seatRoundNet.set(key, list);
          fb.fee += sn.fee;
          fb.pu += sn.pu;
          fb.entries += tier.entry;
          fb.playerRounds++;
        }
        feeByTier.set(tier.arenaId, fb);
      }
    }
  }

  // ---- flows
  const burnedFees = tiers.reduce((s, t) => s + t.burned, 0n);
  const feeWallet = tiers.reduce((s, t) => s + t.toFeeWallet, 0n);
  const totalBurn = burnedFees + puBurn;
  const totalFee = feeWallet + puFee;
  const hours = sc.hours;
  const perHour = {
    burnedTokens: tokens(totalBurn) / hours,
    feeWalletTokens: tokens(totalFee) / hours,
    powerUpBurnTokens: tokens(puBurn) / hours,
    powerUpFeeTokens: tokens(puFee) / hours,
    burnedUsd: usd(totalBurn) / hours,
    feeWalletUsd: usd(totalFee) / hours,
  };
  const perDay = {
    burnedTokens: perHour.burnedTokens * 24,
    feeWalletTokens: perHour.feeWalletTokens * 24,
    burnedUsd: perHour.burnedUsd * 24,
    feeWalletUsd: perHour.feeWalletUsd * 24,
    burnedShareOfSupply: (perHour.burnedTokens * 24) / Number(SUPPLY_TOKENS),
  };

  // ---- house edge per player-round (the stake a player-round puts at risk is one entry fee per ticket)
  let fee = 0n;
  let pu = 0n;
  let entries = 0n;
  const byTier: Record<number, number> = {};
  for (const [id, fb] of feeByTier) {
    fee += fb.fee;
    pu += fb.pu;
    entries += fb.entries;
    byTier[id] = Number(fb.fee + fb.pu) / Number(fb.entries);
  }
  const depAll = tiers.reduce((s, t) => s + t.deposited, 0n);
  const houseEdge = { feeOnly: Number(fee) / Number(entries), withPowerUps: Number(fee + pu) / Number(entries), feePerTicket: Number(fee) / Number(depAll), byTier };
  const transferRate = Number(profitAll) / Number(depAll);

  // ---- EV per skill
  const ev = {} as Record<Skill, SkillEv>;
  for (const s of SKILLS) {
    const a = evAcc.get(s)!;
    const n = Math.max(1, a.playerRounds);
    const usdPerHour: Record<number, number> = {};
    for (const t of tiers) usdPerHour[t.arenaId] = ((a.net / n) * 12 * t.usdCents) / 100;
    ev[s] = { tickets: a.tickets, playerRounds: a.playerRounds, evPerRound: a.net / n, grossPerRound: a.gross / n, feePerRound: a.fee / n, powerUpsPerRound: a.pu / n, usdPerHour };
  }

  // ---- bankrolls: a player of each skill at the $1 arena with 20 tickets, playing every round, sampled from outcomes
  const bankrolls: Bankroll[] = [];
  for (const s of SKILLS) {
    const pool = seatRoundNet.get(`1:${s}`) ?? [];
    if (pool.length === 0) continue;
    const N = 2_000;
    const start = 20;
    let b1 = 0;
    let b4 = 0;
    let bEnd = 0;
    const bustAt: number[] = [];
    for (let i = 0; i < N; i++) {
      let bank = start;
      let busted = -1;
      for (let k = 0; k < rounds; k++) {
        bank += pool[Math.floor(rng() * pool.length)];
        if (bank < 1) {
          busted = k;
          break;
        }
      }
      if (busted >= 0) {
        bustAt.push(busted / 12);
        if (busted < 12) b1++;
        if (busted < 48) b4++;
        bEnd++;
      }
    }
    bustAt.sort((x, y) => x - y);
    bankrolls.push({ skill: s, startTickets: start, busted1h: b1 / N, busted4h: b4 / N, bustedEnd: bEnd / N, medianHoursToBust: bustAt.length >= N / 2 ? bustAt[Math.floor(N / 2)] : Infinity });
  }

  // ---- the settlement worker: one transaction at a time, every pass takes everything due, per arena and mode
  events.sort((a, b) => a.t - b.t);
  const txByKind: Record<string, number> = {};
  let gasTotal = 0;
  let bytesTotal = 0;
  let txs = 0;
  let items = 0;
  let i = 0;
  let now = 0;
  while (i < events.length) {
    if (now < events[i].t) now = events[i].t;
    // everything due now forms this pass (stale cancels arrive in sweeps)
    const batch: typeof events = [];
    while (i < events.length && events[i].t <= now) batch.push(events[i++]);
    const groups = new Map<string, typeof events>();
    for (const e of batch) {
      const k = `${e.arenaId}:${e.kind}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    for (const [k, list] of groups) {
      for (let c = 0; c < list.length; c += 40) {
        const chunk = list.slice(c, c + 40);
        const kind = k.endsWith('cancel') ? 'cancel' : 'settle';
        const winners = chunk.filter((e) => e.paid).length;
        const g = txGas(gasFig, kind, chunk.length, winners);
        gasTotal += g.gas;
        bytesTotal += g.bytes;
        txs++;
        items += chunk.length;
        const label = `${kind}${kind === 'settle' && winners === 0 ? ' (deaths only)' : ''} x${chunk.length <= 1 ? '1' : chunk.length <= 5 ? '2-5' : chunk.length <= 20 ? '6-20' : '21-40'}`;
        txByKind[label] = (txByKind[label] ?? 0) + 1;
        now += sc.txLatencyS;
      }
    }
  }
  const days = hours / 24;
  const ethPerDay: Record<string, number> = {};
  const usdPerDay: Record<string, number> = {};
  for (const gwei of GAS_PRICES_GWEI) {
    const wei = (gasTotal * gwei * 1e9 + bytesTotal * L1_WEI_PER_BYTE) / days;
    ethPerDay[`${gwei} gwei`] = wei / 1e18;
    usdPerDay[`${gwei} gwei`] = (wei / 1e18) * ETH_USD;
  }
  const gas: GasReport = { txs: Math.round(txs / days), txByKind, gasPerDay: gasTotal / days, meanItemsPerTx: items / Math.max(1, txs), ethPerDay, usdPerDay };

  // the token supply cannot grow: nothing above mints
  if (totalBurn < 0n || totalFee < 0n) violations.push('negative flows');
  return { scenario: sc, rounds, tiers, perHour, perDay, houseEdge, transferRate, ev, bankrolls, gas, violations };
}

/* ================================================================== */
/* 3. Price volatility and re-pricing                                  */
/* ================================================================== */

export interface RepricePolicy {
  name: string;
  /** Sync when a tier's ticket is off its dollar price by more than this (share), checked at every bell. */
  threshold: number | null;
  /** Sync on a fixed schedule (hours between syncs), whatever the price did. */
  everyHours: number | null;
  /** Least time between two syncs (hours). */
  minGapHours: number;
  /** Price input: the spot price, or a time-weighted average of the last `twapMin` minutes. */
  twapMin: number;
}

export interface RepriceResult {
  policy: string;
  syncsPerDay: number;
  /** Ticket USD value against its tier, over all 5-minute steps: mean |deviation|, 95th percentile, share > 10 % and > 25 %. */
  meanAbsDev: number;
  p95AbsDev: number;
  shareOver10: number;
  shareOver25: number;
  /** Minutes per day each arena refuses new tickets for the syncs: now (stale sweeper) and with the proposed drain. */
  pauseMinPerDayNow: number;
  pauseMinPerDayFixed: number;
  /** One sync's pause per arena (minutes): median and 95th percentile, now and with the proposed drain. */
  pauseNowP50: number;
  pauseNowP95: number;
  pauseFixedP50: number;
  /** A magnet charge (tokens, fixed) against the $1 ticket at the step's price: min and max over the run. */
  powerUpVsTicketMin: number;
  powerUpVsTicketMax: number;
}

/**
 * A log-normal price path in 5-minute steps with daily volatility `dailyVol` (0.5: a ±50 % day is a one-sigma day),
 * plus an optional shock (`-0.5` halves the price over one hour at `shockAtH`).
 */
export function pricePath(o: { hours: number; dailyVol: number; seed: number; start: number; shock?: { atH: number; move: number } }): number[] {
  const rng = mulberry32(o.seed);
  const steps = Math.round((o.hours * 60) / 5);
  const sigma = o.dailyVol / Math.sqrt(288);
  const gauss = () => {
    const u = Math.max(1e-12, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const out: number[] = [];
  let lp = Math.log(o.start);
  for (let i = 0; i < steps; i++) {
    lp += sigma * gauss() - (sigma * sigma) / 2;
    if (o.shock && i >= o.shock.atH * 12 && i < o.shock.atH * 12 + 12) lp += Math.log(1 + o.shock.move) / 12;
    out.push(Math.exp(lp));
  }
  return out;
}

/**
 * One sync's pause of one arena (seconds), drawn from the mechanics: the owner closes the arena (on chain) at the
 * start of a round's last minute (joins are closed then anyway); the seated tickets settle at the bell (+ the worker's
 * latency); a ticket bought and never seated waits for the stale sweeper (opened ≥ 900 s, swept every 300 s), unless
 * the proposed drain cancels it when the arena closes. `ticketsPer15Min`: the arena's tickets in the last 15 minutes.
 */
export function syncPauseS(rng: Rng, o: { ticketsPer15Min: number; unplayed: number; fixed: boolean; latencyS?: number }): number {
  const bell = 60 + (o.latencyS ?? 2) * 2;
  if (o.fixed) return bell + (o.latencyS ?? 2); // the drain's cancel goes with the bell's settlements
  let worst = bell;
  const sweepPhase = rng() * 300;
  for (let k = 0; k < o.ticketsPer15Min; k++) {
    if (rng() >= o.unplayed) continue;
    // bought at a uniform time in the last 15 minutes before the close (age 0..900 s at the close)
    const age = rng() * 900;
    const due = 900 - age; // seconds after the close until it is stale
    const sweep = Math.ceil((due - sweepPhase) / 300) * 300 + sweepPhase;
    worst = Math.max(worst, sweep + (o.latencyS ?? 2));
  }
  return worst;
}

export function repricingStudy(o: { path: number[]; policies: RepricePolicy[]; ticketsPer15Min: Record<number, number>; unplayed: number; seed: number }): RepriceResult[] {
  const out: RepriceResult[] = [];
  const days = (o.path.length * 5) / 1440;
  const magnetCharge = Number(SHOP_DEFAULTS.prices.magnet) / SHOP_DEFAULTS.packSize;
  for (const pol of o.policies) {
    const rng = mulberry32(o.seed);
    let synced = o.path[0];
    let lastSync = 0;
    let syncs = 0;
    const devs: number[] = [];
    const pausesNow: number[] = [];
    const pausesFixed: number[] = [];
    let pauseNow = 0;
    let pauseFixed = 0;
    let puMin = Infinity;
    let puMax = 0;
    for (let i = 0; i < o.path.length; i++) {
      const p = o.path[i];
      const lo = Math.max(0, i - Math.round(pol.twapMin / 5) + 1);
      let twap = 0;
      for (let j = lo; j <= i; j++) twap += o.path[j];
      twap /= i - lo + 1;
      // a ticket priced at `synced` is worth p / synced of its tier now (rounding to 2 figures ignored)
      devs.push(Math.abs(p / synced - 1));
      const ticketTokens = 1 / synced; // $1 ticket in tokens at the synced price
      const ratio = magnetCharge / ticketTokens;
      puMin = Math.min(puMin, ratio);
      puMax = Math.max(puMax, ratio);
      const gapOk = (i - lastSync) * 5 >= pol.minGapHours * 60;
      const due = (pol.threshold !== null && Math.abs(twap / synced - 1) > pol.threshold) || (pol.everyHours !== null && (i - lastSync) * 5 >= pol.everyHours * 60);
      if (due && gapOk && i > 0) {
        synced = twap;
        lastSync = i;
        syncs++;
        for (const [, n] of Object.entries(o.ticketsPer15Min)) {
          const a = syncPauseS(rng, { ticketsPer15Min: n, unplayed: o.unplayed, fixed: false });
          const b = syncPauseS(rng, { ticketsPer15Min: n, unplayed: o.unplayed, fixed: true });
          pausesNow.push(a);
          pausesFixed.push(b);
          pauseNow += a;
          pauseFixed += b;
        }
      }
    }
    devs.sort((a, b) => a - b);
    pausesNow.sort((a, b) => a - b);
    pausesFixed.sort((a, b) => a - b);
    const arenas = Object.keys(o.ticketsPer15Min).length;
    const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
    out.push({
      policy: pol.name,
      syncsPerDay: syncs / days,
      meanAbsDev: devs.reduce((a, b) => a + b, 0) / devs.length,
      p95AbsDev: q(devs, 0.95),
      shareOver10: devs.filter((d) => d > 0.1).length / devs.length,
      shareOver25: devs.filter((d) => d > 0.25).length / devs.length,
      pauseMinPerDayNow: pauseNow / 60 / days / arenas,
      pauseMinPerDayFixed: pauseFixed / 60 / days / arenas,
      pauseNowP50: q(pausesNow, 0.5) / 60,
      pauseNowP95: q(pausesNow, 0.95) / 60,
      pauseFixedP50: q(pausesFixed, 0.5) / 60,
      powerUpVsTicketMin: puMin,
      powerUpVsTicketMax: puMax,
    });
  }
  return out;
}

/* ================================================================== */
/* 4. Abuse                                                            */
/* ================================================================== */

export interface AbuseCase {
  name: string;
  /** The ring's seats (receiver / feeders / team) in a room of honest people. */
  ring: Seat[];
}

export interface AbuseResult {
  name: string;
  roundsPlayed: number;
  /** The ring's net per round in entry fees, after the fee on profit (each member at the normal 20 %). */
  ringNetPerRound: number;
  /** The same seats played honestly on the same seeds (the control). */
  controlNetPerRound: number;
  /** What the ring takes from the honest players per round (entry fees), against the control. */
  extraFromHonestPerRound: number;
  /** The receiver's (or best member's) gross payout per round, in entry fees. */
  receiverPayoutPerRound: number;
  /** Flags the detectors raised on the ring's wallets (kinds), and on honest wallets (false positives). */
  ringFlags: string[];
  honestFlags: number;
}

/** Net result per round (entry fees, after the normal fee on profit) of the tickets `isRing` selects. */
function ringNet(rounds: RoomRound[], isRing: (t: TicketRec) => boolean, rates: FeeRates = DEFAULT_FEE_RATES): number {
  let n = 0;
  for (const r of rounds) for (const t of r.tickets) if (isRing(t)) n += Number(computeProfitFee(BigInt(ENTRY), BigInt(t.payout), rates).net) / ENTRY - 1;
  return n / Math.max(1, rounds.length);
}

export function abuseStudy(o: { honest: number; rounds: number; seeds: number[]; cases: AbuseCase[]; log?: (m: string) => void }): AbuseResult[] {
  const out: AbuseResult[] = [];
  for (const c of o.cases) {
    let ring = 0;
    let control = 0;
    let honestDelta = 0;
    let recv = 0;
    let roundsPlayed = 0;
    const ringFlags = new Set<string>();
    let honestFlags = 0;
    for (const seed of o.seeds) {
      const honest = honestSeats(o.honest, mulberry32(seed));
      const seats = [...honest, ...c.ring];
      const isRing = (t: TicketRec) => t.seat >= honest.length;
      const run = runArenaRounds({ seats, rounds: o.rounds, seed });
      // the control: the ring's seats play honestly at their skill, same seed
      const ctl = runArenaRounds({ seats: [...honest, ...c.ring.map((s) => ({ skill: s.skill, role: 'honest' as const }))], rounds: o.rounds, seed });
      const n = Math.min(run.rounds.length, ctl.rounds.length);
      roundsPlayed += n;
      ring += ringNet(run.rounds.slice(0, n), isRing) * n;
      control += ringNet(ctl.rounds.slice(0, n), isRing) * n;
      honestDelta += (ringNet(ctl.rounds.slice(0, n), (t) => !isRing(t)) - ringNet(run.rounds.slice(0, n), (t) => !isRing(t))) * n;
      for (const r of run.rounds.slice(0, n)) {
        const best = new Map<number, number>();
        for (const t of r.tickets) if (isRing(t) && (t.role === 'receiver' || t.role === 'team')) best.set(t.seat, (best.get(t.seat) ?? 0) + t.payout / ENTRY);
        recv += Math.max(0, ...best.values());
      }
      const ringWallets = new Set<string>();
      for (const r of run.rounds) for (const t of r.tickets) if (isRing(t)) ringWallets.add(t.wallet.toLowerCase());
      for (const f of run.flags) {
        if (f.wallets.some((w) => ringWallets.has(w.toLowerCase()))) ringFlags.add(`${f.kind}(${f.score})`);
        else honestFlags++;
      }
      o.log?.(`abuse ${c.name}, seed ${seed}: ${n} rounds, ring ${(ringNet(run.rounds.slice(0, n), isRing)).toFixed(2)} vs control ${ringNet(ctl.rounds.slice(0, n), isRing).toFixed(2)} entries/round, flags ${run.flags.map((f) => f.kind).join(',') || 'none'}`);
    }
    const n = Math.max(1, roundsPlayed);
    out.push({ name: c.name, roundsPlayed, ringNetPerRound: ring / n, controlNetPerRound: control / n, extraFromHonestPerRound: honestDelta / n, receiverPayoutPerRound: recv / n, ringFlags: [...ringFlags], honestFlags });
  }
  return out;
}

export const ABUSE_CASES: AbuseCase[] = [
  { name: 'feeding: 1 skilled receiver + 2 feeders, fixed wallets', ring: [{ skill: 'skilled', role: 'receiver', group: 1 }, { skill: 'median', role: 'feeder', group: 1 }, { skill: 'median', role: 'feeder', group: 1 }] },
  { name: 'feeding: same ring, feeders on fresh wallets every round (sybil)', ring: [{ skill: 'skilled', role: 'receiver', group: 1 }, { skill: 'median', role: 'feeder', group: 1, rotateWallet: true }, { skill: 'median', role: 'feeder', group: 1, rotateWallet: true }] },
  { name: 'teaming: 3 skilled players who never attack each other and hunt together', ring: [{ skill: 'skilled', role: 'team', group: 2 }, { skill: 'skilled', role: 'team', group: 2 }, { skill: 'skilled', role: 'team', group: 2 }] },
];
