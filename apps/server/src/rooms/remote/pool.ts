import { Worker } from 'node:worker_threads';
import {
  PlayerFlag,
  WORLD_PRESETS,
  boostDurationMs,
  isBoostKind,
  type BoostKind,
  type ClientInput,
  type CustomDifficulty,
  type DeathStats,
  type MapScaleSettings,
  type RoomInfo,
  type RoundWindow,
} from '@elymum/shared';
import type { ChainGateway } from '../../chain/types';
import type { Player } from '../../game/entities';
import type { IntegrityService } from '../../integrity/service';
import type { SessionSummary } from '../../integrity/types';
import type { Leaderboards } from '../../leaderboards';
import type { Conn } from '../../net/conn';
import type { ShopService, UseContext } from '../../shop/service';
import type { Journal, LootRecord } from '../../stake/journal';
import type { PlayerLook, RoomConn, RoomHandle, StakeSeat } from '../handle';
import type { NotableKillEvent } from '../manager';
import { TickStats, wsOut, type RoomLoad, type ThreadLoad } from '../load';
import type { BellSettled, JoinOptions, RoomOptions } from '../room';
import type { RoundClock } from '../round-clock';
import { FRAME_BINARY, FRAME_HEADER, type Cmd, type ConnMeta, type Ctl, type OutBatch, type RoomSummary, type WorkerInit } from './protocol';

/** A socket with more than this queued gets no snapshots until it drains (the same rule as one thread). */
const SLOW_BYTES = 768 * 1024;
/** A worker that sends nothing (its stats come every second) for this long is stopped and its rooms recovered. */
const HANG_MS_DEFAULT = 10_000;
/** A worker gets this long to load its modules before the hang check applies. */
const START_GRACE_MS = 60_000;
/** How long the shutdown waits for a worker to settle its rooms. */
const SHUTDOWN_MS = 5_000;

export interface PoolDeps {
  journal: Journal;
  chain: ChainGateway;
  leaderboards: Leaderboards;
  log: (m: string) => void;
  clock: RoundClock;
  round: { roundMs: number; closeMs: number; breakMs?: number };
  /** The main thread's round clock minus `Date.now()` (non-zero only with an injected clock). */
  clockOffset: () => number;
  integrity?: IntegrityService;
  shop?: ShopService;
  /** A human's game ended in a room worker (the profile, the league, the custom room's board). */
  onGameOver: (e: { room: RemoteRoom; conn: Conn | null; player: PlayerLook; stats: DeathStats }) => void;
  onNotableKill: (e: NotableKillEvent) => void;
  onBellSettled: (e: BellSettled) => void;
  /** A worker died: its rooms are gone (already recovered from the journal); the directory opens the standing ones again. */
  onLost: (rooms: RemoteRoom[]) => void;
  /** A cleanup close was answered (`ok`: the worker dropped the idle room). */
  onClosed: (room: RemoteRoom, ok: boolean) => void;
  hangMs?: number;
}

/** The main thread's stand-in for a player that lives in a room worker: only `id` and `alive` are read here. */
function remotePlayer(id: number): Player {
  return { id, alive: true } as unknown as Player;
}

class Slot {
  dead = false;
  queue: Cmd[] = [];
  queued = false;
  lastMsgAt: number;
  load: ThreadLoad | null = null;
  roomLoads: RoomLoad[] = [];
  /** Rooms placed here since the last stats (their load is not measured yet). */
  fresh = 0;
  bye: (() => void) | null = null;
  liveSessions: SessionSummary[] = [];
  readonly startedAt = Date.now();
  /** The round-clock offset this worker was last told. */
  offset = 0;
  /** Deaths in a row soon after a start (the respawn backs off). */
  failures = 0;
  /** Requests waiting for this worker's answer. */
  readonly reattaches = new Map<number, { resolve: (ok: boolean) => void; conn: Conn; room: RemoteRoom }>();
  readonly boosts = new Map<number, { conn: Conn; ctx: UseContext; kind: BoostKind }>();

  constructor(
    readonly index: number,
    readonly worker: Worker,
    readonly restarts: number,
  ) {
    this.lastMsgAt = Date.now() + START_GRACE_MS;
  }
}

/**
 * The room workers and the main thread's side of them. Each worker runs whole rooms; this thread
 * keeps the sockets, the journal (the only writer), the chain and every store, and applies what
 * the rooms report in the order they did it. A worker that dies is recovered from the journal like
 * a process restart (its tickets settled at their last journaled value, never twice) and respawned.
 */
export class WorkerPool {
  private slots: Slot[] = [];
  readonly rooms = new Map<number, RemoteRoom>();
  private readonly conns = new Map<number, Conn>();
  private nextHid = 1;
  private reqSeq = 0;
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];
  /** Time this thread spends delivering the workers' batches (`main.tick` in the load view). */
  readonly relayStats = new TickStats(600);

  constructor(
    readonly size: number,
    private readonly deps: PoolDeps,
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.spawn(i, 0));
    this.timers.push(
      setInterval(() => this.watch(), 1000),
      // an injected round clock (tests) moves: the workers follow within a tick (and before any command)
      setInterval(() => {
        for (const s of this.slots) if (Math.abs(deps.clockOffset() - s.offset) >= 1) this.flush(s, true);
      }, 20),
    );
    for (const t of this.timers) t.unref();
  }

  private spawn(index: number, restarts: number): Slot {
    const ts = import.meta.url.endsWith('.ts');
    // the build ships the worker as dist/room-worker.js next to dist/index.js; tests and tsx run the
    // source through a bootstrap that registers tsx inside the worker thread
    const file = ts ? new URL('./ts-worker.mjs', import.meta.url) : new URL('./room-worker.js', import.meta.url);
    const init: WorkerInit & { entry?: string } = {
      ...(ts ? { entry: new URL('./worker-main.ts', import.meta.url).href } : {}),
      index,
      round: this.deps.round,
      clockOffset: this.deps.clockOffset(),
      integrity: !!this.deps.integrity,
    };
    const worker = new Worker(file, { workerData: init });
    const slot = new Slot(index, worker, restarts);
    slot.offset = init.clockOffset;
    worker.on('message', (b: OutBatch) => {
      if (slot.dead) return;
      slot.lastMsgAt = Date.now();
      const t0 = performance.now();
      try {
        this.deliver(slot, b);
      } catch (err) {
        this.deps.log(`!!! room worker ${index}: batch handling failed: ${(err as Error).stack ?? err}`);
      }
      this.relayStats.record(performance.now() - t0);
    });
    worker.on('error', (err) => this.lost(slot, `error: ${(err as Error).stack ?? err}`));
    worker.on('exit', (code) => this.lost(slot, `exit code ${code}`));
    worker.unref();
    return slot;
  }

  /* ------------------------------ commands ------------------------------ */

  send(slot: Slot, cmd: Cmd): void {
    if (slot.dead) return;
    slot.queue.push(cmd);
    if (slot.queued) return;
    slot.queued = true;
    setImmediate(() => this.flush(slot));
  }

  private flush(slot: Slot, clockOnly = false): void {
    if (!clockOnly) slot.queued = false;
    if (slot.dead) return;
    // the round clock first: a join must never land in a round the main thread has already left
    const off = this.deps.clockOffset();
    const clock = Math.abs(off - slot.offset) >= 1;
    if (!clock && (clockOnly || slot.queue.length === 0)) return;
    const cmds: Cmd[] = clock ? [{ k: 'clock', offset: off }] : [];
    slot.offset = off;
    if (!clockOnly) {
      cmds.push(...slot.queue);
      slot.queue = [];
    }
    slot.worker.postMessage({ cmds });
  }

  private broadcast(cmd: Cmd): void {
    for (const s of this.slots) this.send(s, cmd);
  }

  meta(conn: Conn): ConnMeta {
    const integ = this.deps.integrity;
    return {
      id: conn.id,
      wallet: conn.wallet,
      ipHash: integ ? integ.hashIp(conn.ip) : '',
      fpHash: integ ? integ.hashFp(conn.fp) : null,
      aspect: conn.aspect,
      standings: conn.standings,
    };
  }

  track(conn: Conn): void {
    this.conns.set(conn.id, conn);
  }

  /** The socket closed: its connection leaves its room (an arena player stays AFK, like on one thread). */
  forget(conn: Conn): void {
    this.conns.delete(conn.id);
    conn.pendingReattach = null;
  }

  /** The least-loaded live worker: measured tick time, plus the rooms placed since its last report. */
  private pick(): Slot {
    let best: Slot | null = null;
    let bestScore = Infinity;
    for (const s of this.slots) {
      if (s.dead) continue;
      const rooms = [...this.rooms.values()].filter((r) => r.slot === s);
      const humans = rooms.reduce((a, r) => a + r.humanCount, 0);
      const score = (s.load?.tick.meanMs ?? 0) + 1.5 * s.fresh + 0.05 * humans + 0.01 * rooms.length;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) throw new Error('no room worker is running');
    return best;
  }

  /** Places a new room on the least-loaded worker. `loot`: what it adopts from the journal (an arena's first instance). */
  createRoom(opts: RoomOptions, loot: LootRecord[]): RemoteRoom {
    const slot = this.pick();
    slot.fresh++;
    const hid = this.nextHid++;
    const { map, ...rest } = opts;
    // a function does not cross threads: the worker rebuilds a custom room's shape from `map.config`
    const spec: RoomOptions = { ...rest, ...(map ? { map: { scale: map.scale, ...(map.config ? { config: map.config } : {}) } } : {}) };
    const room = new RemoteRoom(hid, opts, slot, this);
    this.rooms.set(hid, room);
    this.send(slot, { k: 'create', hid, spec, loot });
    return room;
  }

  /** Closes a room for good (a custom room's end: everyone is evicted with `message`). */
  closeRoom(room: RemoteRoom, message: string): void {
    room.closed = true;
    this.send(room.slot, { k: 'close', hid: room.hid, force: true, message });
  }

  /** Asks the worker to close a paid custom room once its tickets and loot are settled (answered through `onClosed`). */
  closeSettled(room: RemoteRoom, message: string): void {
    room.closing = true;
    this.send(room.slot, { k: 'close', hid: room.hid, force: false, message });
  }

  /** Asks the worker to drop an idle room (answered through `onClosed`). */
  closeIdle(room: RemoteRoom): void {
    room.closing = true;
    this.send(room.slot, { k: 'close', hid: room.hid, force: false });
  }

  clearAvatar(wallet: string): void {
    this.broadcast({ k: 'avatar', wallet });
  }

  input(conn: Conn, room: RemoteRoom, input: ClientInput): void {
    this.send(room.slot, { k: 'in', conn: conn.id, op: input.op, x: 'x' in input ? input.x : 0, y: 'y' in input ? input.y : 0 });
  }

  reattach(conn: Conn, room: RemoteRoom, pid: number): Promise<boolean> {
    const req = ++this.reqSeq;
    return new Promise((resolve) => {
      room.slot.reattaches.set(req, { resolve, conn, room });
      this.send(room.slot, { k: 'reattach', hid: room.hid, conn: this.meta(conn), pid, req });
    });
  }

  boost(conn: Conn, room: RemoteRoom, ctx: UseContext, kind: BoostKind): void {
    const req = ++this.reqSeq;
    room.slot.boosts.set(req, { conn, ctx, kind });
    this.send(room.slot, { k: 'boost', hid: room.hid, conn: conn.id, pid: conn.player?.id ?? -1, kind, req });
  }

  /* ------------------------------ from the workers ------------------------------ */

  private deliver(slot: Slot, b: OutBatch): void {
    const frames = b.frames ? Buffer.from(b.frames) : null;
    let pos = 0;
    let done = 0;
    const upTo = (n: number) => {
      while (done < n && frames) {
        const conn = frames.readUInt32LE(pos);
        const hid = frames.readUInt32LE(pos + 4);
        const binary = frames[pos + 8] === FRAME_BINARY;
        const len = frames.readUInt32LE(pos + 9);
        const data = frames.subarray(pos + FRAME_HEADER, pos + FRAME_HEADER + len);
        pos += FRAME_HEADER + len;
        done++;
        this.route(conn, hid, binary, data);
      }
    };
    for (const c of b.ctl) {
      upTo(c.at);
      try {
        this.control(slot, c);
      } catch (err) {
        this.deps.log(`!!! room worker ${slot.index}: ${c.k} failed on the main thread: ${(err as Error).stack ?? err}`);
      }
    }
    upTo(b.count);
  }

  private route(connId: number, hid: number, binary: boolean, data: Buffer): void {
    const conn = this.conns.get(connId);
    if (!conn || !conn.open) return;
    const pr = conn.pendingReattach;
    if (pr && (hidOf(pr.target) === hid || hidOf(pr.old) === hid)) {
      pr.held.push({ hid, binary, data });
      return;
    }
    // frames of a room this connection left are dropped (it starts afresh in the next one)
    if (hidOf(conn.room) !== hid) return;
    this.write(conn, binary, data);
  }

  write(conn: Conn, binary: boolean, data: Buffer): void {
    wsOut.bytes += data.byteLength;
    wsOut.msgs++;
    conn.ws.send(data, { binary });
    const slow = conn.ws.bufferedAmount > SLOW_BYTES;
    if (slow !== conn.slowSent && conn.room instanceof RemoteRoom) {
      conn.slowSent = slow;
      this.send(conn.room.slot, { k: 'slow', conn: conn.id, slow });
    }
  }

  private control(slot: Slot, c: Ctl): void {
    const d = this.deps;
    switch (c.k) {
      case 'commit': {
        // the money path: applied exactly as a room on this thread writes it, in the order it wrote it
        const enqueue = c.enqueue ?? [];
        for (const item of enqueue) {
          if (item.kind !== 'sweep' || !d.journal.pending.some((p) => p.key === item.key)) continue;
          const base = item.key;
          let k = 2;
          while (d.journal.pending.some((p) => p.key === `${base}:${k}`)) k++;
          item.key = `${base}:${k}`;
          d.log(`!!! room ${item.roomId}: loot sweep ${base} is already pending (wall clock stepped back?); queuing ${item.amount} as ${item.key}`);
        }
        if (d.integrity) {
          for (const [key, entryFee] of c.holds) {
            const item = enqueue.find((i) => i.key === key);
            if (item?.kind === 'settle') d.integrity.holdDecision(item, entryFee);
          }
        }
        d.journal.commit({
          ...(c.enqueue ? { enqueue: c.enqueue } : {}),
          ...(c.roomId !== undefined ? { roomId: c.roomId } : {}),
          ...(c.live ? { live: c.live } : {}),
          ...(c.loot ? { loot: c.loot } : {}),
        });
        const room = this.rooms.get(c.hid);
        if (room && c.live) room.setSeats(c.seats, enqueue.map((i) => i.key));
        if (enqueue.length > 0) d.chain.kick();
        return;
      }
      case 'go': {
        const room = this.rooms.get(c.hid);
        if (room) d.onGameOver({ room, conn: c.conn !== null ? (this.conns.get(c.conn) ?? null) : null, player: c.player, stats: c.stats });
        return;
      }
      case 'nk': {
        const room = this.rooms.get(c.hid);
        const conn = this.conns.get(c.conn);
        if (room && conn) d.onNotableKill({ room, conn, player: c.player, mass: c.mass, kills: c.kills, victim: c.victim, victimMass: c.victimMass, ...(c.victimIsBot ? { victimIsBot: true } : {}) });
        return;
      }
      case 'bell':
        d.onBellSettled(c.e);
        return;
      case 'lb':
        d.leaderboards.submit(c.rec);
        return;
      case 'roundBoard':
        d.leaderboards.roundOver(c.r);
        return;
      case 'country':
        d.leaderboards.countryGame(c.g);
        return;
      case 'log':
        d.log(c.m);
        return;
      case 'cs': {
        const conn = this.conns.get(c.conn);
        if (!conn || conn.pendingReattach || hidOf(conn.room) !== c.hid) return;
        conn.player = c.pid !== null ? remotePlayer(c.pid) : null;
        if (!c.attached) {
          (conn.room as RemoteRoom).attached.delete(conn);
          conn.room = null;
          conn.game = null;
        }
        return;
      }
      case 'joined': {
        const room = this.rooms.get(c.hid);
        if (!room) return;
        room.joinDone(c.conn);
        room.humansNow = c.humans;
        const conn = this.conns.get(c.conn);
        if (conn && conn.room === room && !conn.pendingReattach) {
          conn.player = remotePlayer(c.pid);
          // the power-up state follows `joined`, as on one thread
          room.sendBoosts(conn);
        }
        return;
      }
      case 'joinFail': {
        const room = this.rooms.get(c.hid);
        room?.joinDone(c.conn);
        const conn = this.conns.get(c.conn);
        if (conn && room && conn.room === room) {
          room.attached.delete(conn);
          conn.room = null;
          conn.player = null;
          conn.send({ t: 'error', code: 'room_closed', message: 'This room has closed.' });
        }
        return;
      }
      case 'reattached': {
        const r = slot.reattaches.get(c.req);
        slot.reattaches.delete(c.req);
        if (!r) return;
        r.room.humansNow = c.humans;
        if (c.ok) r.conn.game = { wallet: r.conn.wallet, holder: c.holder };
        this.settleReattach(r.conn, r.room, c.ok);
        r.resolve(c.ok);
        return;
      }
      case 'boost': {
        const r = slot.boosts.get(c.req);
        slot.boosts.delete(c.req);
        if (!r) return;
        this.boostDone(r.conn, r.ctx, r.kind, c.ok);
        return;
      }
      case 'session':
        d.integrity?.ingestSession(c.s);
        return;
      case 'transfer':
        d.integrity?.ingestTransfer(c.t);
        return;
      case 'liveSessions':
        slot.liveSessions = c.list;
        return;
      case 'stats': {
        slot.load = { ...c.load, restarts: slot.restarts, up: true };
        slot.roomLoads = c.roomLoads;
        slot.fresh = 0;
        for (const s of c.rooms) this.rooms.get(s.hid)?.setSummary(s);
        return;
      }
      case 'closed': {
        const room = this.rooms.get(c.hid);
        if (!room) return;
        room.closing = false;
        if (c.ok) {
          room.closed = true;
          this.rooms.delete(c.hid);
        }
        d.onClosed(room, c.ok);
        return;
      }
      case 'bye':
        slot.bye?.();
        return;
    }
  }

  /** A reattach was answered: the frames held meanwhile go out for the room the connection is in now. */
  private settleReattach(conn: Conn, room: RemoteRoom, ok: boolean): void {
    const pr = conn.pendingReattach;
    conn.pendingReattach = null;
    if (!pr || pr.target !== room) return;
    if (ok) {
      const old = pr.old;
      if (old && old !== room) {
        old.detach(conn);
      }
      conn.room = room;
      room.attached.add(conn);
    }
    for (const f of pr.held) if (hidOf(conn.room) === f.hid && conn.open) this.write(conn, f.binary, f.data);
  }

  private boostDone(conn: Conn, ctx: UseContext, kind: BoostKind, ok: boolean): void {
    const shop = this.deps.shop;
    if (!shop) return;
    if (ok) conn.send({ t: 'boost', kind, ok: true, ms: boostDurationMs(kind) });
    else {
      // the player died before the effect arrived: the charge comes back
      shop.refund(ctx, kind);
      conn.send({ t: 'boost', kind, ok: false, reason: 'dead' });
    }
    conn.send({ t: 'boosts', state: shop.state(ctx) });
  }

  /* ------------------------------ failure ------------------------------ */

  private lastWatchAt = Date.now();

  private watch(): void {
    const now = Date.now();
    const gap = now - this.lastWatchAt;
    this.lastWatchAt = now;
    if (gap > 3000) {
      // this thread itself stalled (its timers came late): the workers' messages may still be queued
      // behind them, so silence is not judged this round
      for (const s of this.slots) s.lastMsgAt = Math.max(s.lastMsgAt, now);
      return;
    }
    const hang = this.deps.hangMs ?? HANG_MS_DEFAULT;
    for (const s of this.slots) if (!s.dead && now - s.lastMsgAt > hang) this.lost(s, `no message for ${Math.round((now - s.lastMsgAt) / 1000)} s (hung)`);
  }

  /**
   * A worker died or hung. Its rooms are recovered from the journal exactly as a restart recovers a
   * stopped process: every ticket journaled live in them is settled at its last journaled value
   * (reason `crash`, never twice: a ticket already pending is skipped), their floor loot is queued to
   * burn, and nothing more from that worker is ever applied (its later messages are ignored, the
   * thread is terminated). Their players' sockets are closed so the clients reconnect, as after a
   * deploy. Then the worker is started again and the directory reopens its standing rooms.
   */
  private lost(slot: Slot, why: string): void {
    if (slot.dead) return;
    slot.dead = true;
    void slot.worker.terminate().catch(() => {});
    const rooms = [...this.rooms.values()].filter((r) => r.slot === slot);
    for (const r of rooms) {
      this.rooms.delete(r.hid);
      r.closed = true;
    }
    const d = this.deps;
    if (!this.stopping || rooms.length > 0) d.log(`!!! room worker ${slot.index} stopped (${why}): recovering its ${rooms.length} room(s) from the journal`);
    const ids = rooms.map((r) => r.id);
    if (ids.length > 0) {
      const res = d.journal.recoverRooms(ids, d.clock.window().n);
      if (res.settled > 0 || res.swept > 0) {
        d.log(`!!! room worker ${slot.index}: ${res.settled} live ticket(s) queued for settlement at their last journaled value, loot ${res.swept} queued to burn`);
        d.chain.kick();
      }
    }
    for (const r of slot.reattaches.values()) {
      if (r.conn.pendingReattach?.target === r.room) r.conn.pendingReattach = null;
      r.resolve(false);
    }
    slot.reattaches.clear();
    for (const b of slot.boosts.values()) this.boostDone(b.conn, b.ctx, b.kind, false);
    slot.boosts.clear();
    for (const r of rooms) {
      for (const conn of [...r.attached]) {
        conn.room = null;
        conn.player = null;
        conn.game = null;
        conn.pendingReattach = null;
        // 1012: service restart — the client reconnects and finds its ticket settled (or plays on)
        conn.ws.close(1012, 'room restarting');
      }
      r.attached.clear();
    }
    if (this.stopping) {
      slot.bye?.();
      return;
    }
    // a worker that keeps dying right after its start is retried ever more slowly (at most every 30 s)
    const quick = Date.now() - slot.startedAt < 30_000;
    slot.failures = quick ? slot.failures + 1 : 0;
    const delay = slot.failures === 0 ? 0 : Math.min(30_000, 500 * 2 ** Math.min(6, slot.failures - 1));
    const at = this.slots.indexOf(slot);
    const respawn = () => {
      if (this.stopping) return;
      const next = this.spawn(slot.index, slot.restarts + 1);
      next.failures = slot.failures;
      this.slots[at] = next;
      // standing rooms that found no worker before open now
      d.onLost(rooms);
    };
    // the directory drops the lost rooms now and reopens the standing ones on whatever worker is up
    if (this.slots.some((s) => !s.dead)) d.onLost(rooms);
    if (delay === 0) respawn();
    else {
      d.log(`!!! room worker ${slot.index} failed ${slot.failures} time(s) in a row; next start in ${delay} ms`);
      setTimeout(respawn, delay).unref();
    }
  }

  /** Stops every worker: each settles its rooms first (an operator exit), like `Room.shutdown` on one thread. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.all(
      this.slots.map(
        (slot) =>
          new Promise<void>((resolve) => {
            if (slot.dead) return resolve();
            const timer = setTimeout(() => this.lost(slot, 'no answer at shutdown'), SHUTDOWN_MS);
            slot.bye = () => {
              clearTimeout(timer);
              resolve();
            };
            this.send(slot, { k: 'shutdown' });
            this.flush(slot);
          }),
      ),
    );
    for (const s of this.slots) {
      s.dead = true;
      await s.worker.terminate().catch(() => 0);
    }
  }

  /** Test hook: makes a worker unresponsive for `ms` (the hang watchdog stops it). */
  block(index: number, ms: number): void {
    const s = this.slots[index];
    if (s) this.send(s, { k: 'block', ms });
  }

  /** Test hook: kills a worker as a crash would. */
  crash(index: number): void {
    const s = this.slots[index];
    if (s && !s.dead) void s.worker.terminate();
  }

  /** Per-worker load (the admin view, the load test). */
  threads(): ThreadLoad[] {
    return this.slots.map((s) => {
      const rooms = [...this.rooms.values()].filter((r) => r.slot === s);
      const base: ThreadLoad = s.load ?? { id: s.index, rooms: 0, humans: 0, conns: 0, bots: 0, tick: { n: 0, meanMs: 0, p95Ms: 0, maxMs: 0 }, elu: 0, lagP50Ms: 0, lagP99Ms: 0, lagMaxMs: 0, heapMb: 0 };
      return { ...base, id: s.index, rooms: rooms.length, restarts: s.restarts, up: !s.dead, roomLoads: s.roomLoads };
    });
  }

  /** Tickets in play in the workers (for the integrity detectors). */
  liveSessions(): SessionSummary[] {
    return this.slots.flatMap((s) => s.liveSessions);
  }

  get shop(): ShopService | undefined {
    return this.deps.shop;
  }

  roundN(): number {
    return this.deps.clock.window().n;
  }

  round(): RoundWindow {
    return this.deps.clock.window();
  }
}

const hidOf = (r: RoomHandle | null | undefined): number => (r instanceof RemoteRoom ? r.hid : 0);

/**
 * A room that runs in a room worker, as the main thread sees it. Its figures come from the worker
 * (every second, and with the acks of joins); its staked seats from every journal write it makes,
 * plus the joins sent and not yet answered, so a ticket can never be seated twice.
 */
export class RemoteRoom implements RoomHandle {
  lastActivity = Date.now();
  humansNow = 0;
  /** Set when the room is gone (closed or its worker died): it takes no joins. */
  closed = false;
  closing = false;
  private summary: RoomSummary | null = null;
  /** Connections this thread has in the room. */
  readonly attached = new Set<Conn>();
  /** Seated stakes, from the room's last journal write. */
  private seats = new Map<string, StakeSeat>();
  /** Stake joins on their way to the worker: session → seat (pid -1), by connection. */
  private readonly pendingStakes = new Map<string, StakeSeat & { conn: number }>();
  private readonly pendingJoinConns = new Map<number, number>();

  constructor(
    readonly hid: number,
    readonly opts: RoomOptions,
    readonly slot: Slot,
    private readonly pool: WorkerPool,
  ) {}

  get id(): string {
    return this.opts.id;
  }

  get isFull(): boolean {
    return this.humanCount >= this.opts.maxPlayers;
  }

  get humanCount(): number {
    let pending = 0;
    for (const n of this.pendingJoinConns.values()) pending += n;
    return this.humansNow + pending;
  }

  get connCount(): number {
    return this.attached.size;
  }

  setSummary(s: RoomSummary): void {
    this.summary = s;
    this.humansNow = s.humans;
    this.lastActivity = Math.max(this.lastActivity, s.lastActivity);
  }

  setSeats(seats: [string, number, string][], enqueued: string[]): void {
    this.seats = new Map(seats.map(([session, pid, player]) => [session, { session, pid, player }]));
    for (const s of seats) this.pendingStakes.delete(s[0]);
    for (const k of enqueued) this.pendingStakes.delete(k);
  }

  joinDone(conn: number): void {
    const n = (this.pendingJoinConns.get(conn) ?? 0) - 1;
    if (n > 0) this.pendingJoinConns.set(conn, n);
    else this.pendingJoinConns.delete(conn);
    for (const [k, s] of this.pendingStakes) if (s.conn === conn) this.pendingStakes.delete(k);
  }

  info(): RoomInfo {
    // the round comes from this thread's clock (the summary may be a second old)
    const r = this.opts.mode === 'arena' ? this.pool.round() : undefined;
    const round = r ? { round: { n: r.n, endsAt: r.endsAt, joinsCloseAt: r.joinsCloseAt, ...(r.opensAt > r.startsAt ? { opensAt: r.opensAt } : {}) } } : {};
    if (this.summary) return { ...this.summary.info, players: this.humanCount, ...round };
    const w = this.opts.world ?? WORLD_PRESETS[this.opts.mode];
    return {
      ...round,
      id: this.opts.id,
      mode: this.opts.mode,
      name: this.opts.name,
      width: w.width,
      height: w.height,
      players: this.humanCount,
      bots: 0,
      maxPlayers: this.opts.maxPlayers,
      league: this.opts.league,
      arenaId: this.opts.stake?.arenaId,
      entryFee: this.opts.stake?.buyIn,
      instance: this.opts.stake ? (this.opts.instance ?? 1) : undefined,
      loot: this.opts.stake ? 0 : undefined,
      code: this.opts.code,
      ...(this.opts.custom ? { custom: this.opts.custom } : {}),
      ...(this.opts.test ? { test: true as const } : {}),
    };
  }

  liveSessions(): string[] {
    return [...this.seats.keys(), ...this.pendingStakes.keys()];
  }

  findStakeByWallet(wallet: string): StakeSeat | undefined {
    for (const s of this.seats.values()) if (s.player === wallet) return s;
    for (const s of this.pendingStakes.values()) if (s.player === wallet) return s;
    return undefined;
  }

  lootCount(): number {
    return this.summary?.loot ?? 0;
  }

  mapSide(): number {
    return this.summary?.side ?? (this.opts.world ?? WORLD_PRESETS[this.opts.mode]).width;
  }

  mapScale(): MapScaleSettings | null {
    return this.summary ? this.summary.mapScale : this.opts.map ? { ...this.opts.map.scale } : null;
  }

  botCounts(): { humans: number; bots: number } {
    return { humans: this.humanCount, bots: this.summary?.bots ?? 0 };
  }

  setMapScale(scale: MapScaleSettings): void {
    this.pool.send(this.slot, { k: 'map', hid: this.hid, scale });
  }

  setBots(count: number, difficulty: CustomDifficulty): void {
    if (this.opts.test) this.pool.send(this.slot, { k: 'bots', hid: this.hid, count, difficulty });
  }

  setBuyIn(buyIn: number): void {
    if (!this.opts.stake || !Number.isSafeInteger(buyIn) || buyIn <= 0) return;
    this.opts.stake.buyIn = buyIn;
    this.pool.send(this.slot, { k: 'buyIn', hid: this.hid, buyIn });
  }

  /** Done for every room at once (`WorkerPool.clearAvatar`); the count is not known here. */
  clearAvatar(_wallet: string): number {
    return 0;
  }

  closingSoon(endsAt: number, message: string): void {
    this.pool.send(this.slot, { k: 'closing', hid: this.hid, endsAt, message });
  }

  announce(text: string): void {
    this.pool.send(this.slot, { k: 'announce', hid: this.hid, text });
  }

  private boostContext(conn: Conn): UseContext | null {
    const p = conn.player;
    if (!p || p.id < 0 || conn.room !== this || !conn.game) return null;
    return {
      wallet: conn.game.wallet,
      isBot: false,
      arena: this.opts.mode === 'arena',
      round: this.opts.stake ? this.pool.roundN() : null,
      holder: conn.game.holder,
    };
  }

  sendBoosts(conn: Conn): void {
    const shop = this.pool.shop;
    const ctx = shop ? this.boostContext(conn) : null;
    if (shop && ctx) conn.send({ t: 'boosts', state: shop.state(ctx) });
  }

  /** Points the connection at this room (frames of the room it was in are dropped from now on). */
  private enter(conn: Conn): void {
    if (conn.room !== this) {
      conn.room?.detach(conn);
      conn.room = this;
      this.attached.add(conn);
    }
    this.pool.track(conn);
    this.lastActivity = Date.now();
  }

  join(conn: Conn, opts: JoinOptions): void {
    this.enter(conn);
    conn.player = remotePlayer(-1);
    conn.spectating = false;
    conn.game = { wallet: conn.wallet, holder: (opts.flags & PlayerFlag.Holder) !== 0 };
    this.pendingJoinConns.set(conn.id, (this.pendingJoinConns.get(conn.id) ?? 0) + 1);
    if (opts.stake) this.pendingStakes.set(opts.stake.session, { session: opts.stake.session, pid: -1, player: opts.stake.player, conn: conn.id });
    this.pool.send(this.slot, { k: 'join', hid: this.hid, conn: this.pool.meta(conn), opts });
  }

  reattach(conn: Conn, pid: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    this.pool.track(conn);
    // frames of both rooms wait until the worker answers (`WorkerPool.settleReattach`)
    conn.pendingReattach = { old: conn.room, target: this, held: [] };
    const done = this.pool.reattach(conn, this, pid);
    return done.then((ok) => {
      if (ok) {
        conn.player = remotePlayer(pid);
        conn.spectating = false;
        this.lastActivity = Date.now();
        this.sendBoosts(conn);
      }
      return ok;
    });
  }

  spectate(conn: Conn, next = false): void {
    this.enter(conn);
    if (!conn.player?.alive) conn.spectating = true;
    this.pool.send(this.slot, { k: 'spectate', hid: this.hid, conn: this.pool.meta(conn), next });
  }

  leave(conn: Conn, reason: 'left' | 'disconnect' | 'switch'): void {
    this.pool.send(this.slot, { k: 'leave', hid: this.hid, conn: conn.id, reason });
    conn.player = null;
    conn.game = null;
    if (reason !== 'left') {
      this.attached.delete(conn);
      if (conn.room === this) conn.room = null;
    } else conn.spectating = false;
    if (reason === 'disconnect') this.pool.send(this.slot, { k: 'drop', conn: conn.id });
  }

  detach(conn: RoomConn): void {
    const c = conn as Conn;
    this.attached.delete(c);
    if (c.room === this) c.room = null;
    this.pool.send(this.slot, { k: 'detach', hid: this.hid, conn: c.id });
  }

  input(conn: Conn, input: ClientInput): void {
    if (conn.player) this.pool.input(conn, this, input);
  }

  chat(conn: Conn, raw: unknown): void {
    this.pool.send(this.slot, { k: 'chat', hid: this.hid, conn: conn.id, text: raw });
  }

  emote(conn: Conn, id: unknown): void {
    this.pool.send(this.slot, { k: 'emote', hid: this.hid, conn: conn.id, id });
  }

  cashout(conn: Conn): void {
    this.pool.send(this.slot, { k: 'cashout', hid: this.hid, conn: conn.id });
  }

  /** Power-ups: the charge is taken here (the stores are on this thread), the effect is applied by the worker; refunded when it cannot be. */
  boost(conn: Conn, kind: unknown): void {
    const shop = this.pool.shop;
    if (!shop || !isBoostKind(kind)) return;
    const ctx = this.boostContext(conn);
    if (!ctx) return;
    const res = shop.use(ctx, kind, () => true);
    if (!res.ok) {
      conn.send({ t: 'boost', kind, ok: false, reason: res.reason });
      conn.send({ t: 'boosts', state: shop.state(ctx) });
      return;
    }
    this.pool.boost(conn, this, ctx, kind);
  }

  sendStandings(conn: Conn): void {
    this.pool.send(this.slot, { k: 'standings', conn: conn.id, on: conn.standings, send: true });
  }

  /** The connection's viewport or standings flag changed (the worker keeps its own copy). */
  connChanged(conn: Conn): void {
    this.pool.send(this.slot, { k: 'aspect', conn: conn.id, aspect: conn.aspect });
    this.pool.send(this.slot, { k: 'standings', conn: conn.id, on: conn.standings, send: false });
  }
}
