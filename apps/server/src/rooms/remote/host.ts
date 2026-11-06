import { PlayerFlag, TICK_MS, type ClientInput, type ServerMessage } from '@elymum/shared';
import { IntegrityMonitor } from '../../integrity/telemetry';
import type { Player } from '../../game/entities';
import type { LootRecord } from '../../stake/journal';
import { customWorld } from '../custom';
import type { RoomConn, RoomConnRoom } from '../handle';
import { lookOf } from '../handle';
import { ThreadMeter, TickStats, roomTickStats, startTickLoop, type RoomLoad } from '../load';
import { Room, type RoomDeps, type RoomIntegrity, type RoomJournal } from '../room';
import { RoundClock } from '../round-clock';
import { ViewState } from '../visibility';
import { FRAME_BINARY, FRAME_HEADER, FRAME_TEXT, type Cmd, type ConnMeta, type Ctl, type OutBatch, type RoomSummary, type WorkerInit } from './protocol';

const encoder = new TextEncoder();
/** Live integrity summaries go to the main thread this often (its detectors scan every minute). */
const LIVE_SUMMARY_MS = 15_000;
const STATS_MS = 1000;

/** Frames and control entries of one batch, in order. */
class Outbox {
  private buf = new ArrayBuffer(64 * 1024);
  private bytes = new Uint8Array(this.buf);
  private dv = new DataView(this.buf);
  private off = 0;
  private count = 0;
  private ctl: (Ctl & { at: number })[] = [];

  private ensure(n: number): void {
    if (this.off + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.off + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.off));
    this.buf = next;
    this.bytes = new Uint8Array(next);
    this.dv = new DataView(next);
  }

  private header(conn: number, hid: number, kind: number, len: number): void {
    this.dv.setUint32(this.off, conn, true);
    this.dv.setUint32(this.off + 4, hid, true);
    this.dv.setUint8(this.off + 8, kind);
    this.dv.setUint32(this.off + 9, len, true);
    this.off += FRAME_HEADER;
  }

  binary(conn: number, hid: number, data: Uint8Array): void {
    this.ensure(FRAME_HEADER + data.byteLength);
    this.header(conn, hid, FRAME_BINARY, data.byteLength);
    this.bytes.set(data, this.off);
    this.off += data.byteLength;
    this.count++;
  }

  text(conn: number, hid: number, s: string): void {
    // UTF-8 needs at most 3 bytes per UTF-16 unit
    this.ensure(FRAME_HEADER + s.length * 3);
    const at = this.off;
    this.off += FRAME_HEADER;
    const { written } = encoder.encodeInto(s, this.bytes.subarray(this.off));
    this.off = at;
    this.header(conn, hid, FRAME_TEXT, written);
    this.off += written;
    this.count++;
  }

  push(c: Ctl): void {
    this.ctl.push({ ...c, at: this.count });
  }

  get empty(): boolean {
    return this.count === 0 && this.ctl.length === 0;
  }

  /** The batch to post (its frame buffer is transferred) and a fresh outbox state. */
  take(): { batch: OutBatch; transfer: ArrayBuffer[] } {
    const frames = this.count > 0 ? this.buf.slice(0, this.off) : null;
    const batch: OutBatch = { ctl: this.ctl, frames, bytes: this.off, count: this.count };
    this.ctl = [];
    this.off = 0;
    this.count = 0;
    return { batch, transfer: frames ? [frames] : [] };
  }
}

/** A connection inside a room worker: the socket is on the main thread, frames go there in batches. */
export class WorkerConn implements RoomConn {
  room: Room | null = null;
  /** Room handle id of the room it was last attached to (tags frames written after a detach). */
  lastHid = 0;
  player: Player | null = null;
  spectating = false;
  spectatePid: number | null = null;
  lastCenter = { x: 0, y: 0 };
  aspect = 16 / 9;
  wallet: string | null = null;
  lastName: string | null = null;
  lastSkin = 0;
  lastChatAt = 0;
  lastEmoteAt = 0;
  standings = false;
  readonly view = new ViewState();
  slow = false;
  /** The last state reported to the main thread (`cs`). */
  reported: { hid: number; pid: number | null } = { hid: 0, pid: null };

  constructor(
    readonly id: number,
    /** The IP's HMAC: the integrity monitor only ever sees hashes. */
    public ip: string,
    public fp: string | null,
    private readonly host: RoomHost,
  ) {}

  get open(): boolean {
    return true;
  }

  get buffered(): number {
    return this.slow ? Number.MAX_SAFE_INTEGER : 0;
  }

  private hid(): number {
    return this.room ? this.host.hidOf(this.room) : this.lastHid;
  }

  send(msg: ServerMessage): void {
    this.host.out.text(this.id, this.hid(), JSON.stringify(msg));
  }

  sendText(json: string): void {
    this.host.out.text(this.id, this.hid(), json);
  }

  sendBinary(buf: ArrayBuffer): void {
    this.host.out.binary(this.id, this.hid(), new Uint8Array(buf));
  }

  /** A snapshot straight from the room's writer (one copy, into the batch). */
  sendBytes(bytes: Uint8Array): void {
    this.host.out.binary(this.id, this.hid(), bytes);
  }
}

/**
 * Everything a room worker runs: its rooms (simulation, bots, snapshots), their connections, and the
 * proxies of the main thread's services. Money never leaves the main thread: every journal write
 * of a room becomes a `commit` entry, applied there in order; staked-bot tickets and power-up charges
 * are asked for and answered.
 */
export class RoomHost {
  readonly out = new Outbox();
  private readonly rooms = new Map<number, Room>();
  private readonly hids = new WeakMap<Room, number>();
  private readonly conns = new Map<number, WorkerConn>();
  private readonly loot = new Map<number, LootRecord[]>();
  private readonly deps: RoomDeps;
  private readonly clock: RoundClock;
  private offset: number;
  private readonly monitor: IntegrityMonitor | null;
  /** Settlements whose auto-hold the main thread decides (filled by `integrity.settle`, drained by the next commit). */
  private holds: [string, number][] = [];
  private readonly tickStats = new TickStats();
  private readonly meter = new ThreadMeter();
  private stopLoop: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly init: WorkerInit,
    private readonly post: (batch: OutBatch, transfer: ArrayBuffer[]) => void,
  ) {
    this.offset = init.clockOffset;
    this.clock = new RoundClock(() => Date.now() + this.offset, init.round);
    const ctl = (c: Ctl) => this.out.push(c);
    const journal: RoomJournal = {
      pending: [],
      commit: (o) => {
        const room = o.roomId !== undefined ? this.byId(o.roomId) : null;
        const seats: [string, number, string][] = room?.ledger ? room.ledger.all().map((e) => [e.session, e.pid, e.player]) : [];
        const holds = this.holds;
        this.holds = [];
        ctl({ k: 'commit', hid: room ? this.hidOf(room) : 0, ...o, seats, holds });
      },
      adoptLoot: (_arenaId, roomId) => {
        const room = this.byId(roomId);
        const hid = room ? this.hidOf(room) : this.creating;
        const l = this.loot.get(hid) ?? [];
        this.loot.delete(hid);
        return l;
      },
    };
    this.monitor = init.integrity
      ? new IntegrityMonitor({ onSession: (s) => ctl({ k: 'session', s }), onTransfer: (t) => ctl({ k: 'transfer', t }) })
      : null;
    const monitor = this.monitor;
    const integrity: RoomIntegrity | undefined = monitor
      ? ({
          monitor,
          join: (room, pid, conn, t) =>
            monitor.onJoin(room, pid, {
              wallet: t.player,
              session: t.session,
              sessionId: t.sessionId,
              arenaId: t.arenaId,
              entryFee: t.value ?? t.entryFee,
              ipHash: conn.ip,
              fpHash: conn.fp,
            }),
          settle: (room, pid, item, end) => {
            try {
              const s = monitor.onEnd(room, pid, end);
              if (s && item) this.holds.push([item.key, s.entryFee]);
            } catch (err) {
              ctl({ k: 'log', m: `integrity: settle hook failed (${(err as Error).stack ?? err})` });
            }
          },
        } as RoomIntegrity)
      : undefined;
    this.deps = {
      // the main thread kicks the chain worker after every commit that queues a settlement
      chain: { kick: () => {} },
      journal,
      leaderboards: { submit: (rec) => ctl({ k: 'lb', rec }), countryGame: (g) => ctl({ k: 'country', g }), roundOver: (r) => ctl({ k: 'roundBoard', r }) },
      log: (m) => ctl({ k: 'log', m }),
      clock: this.clock,
      round: init.round,
      onGameOver: (e) => ctl({ k: 'go', hid: this.hidOf(e.room), conn: e.conn?.id ?? null, player: lookOf(e.player), stats: e.stats }),
      onNotableKill: (e) =>
        ctl({ k: 'nk', hid: this.hidOf(e.room), conn: e.conn.id, player: lookOf(e.killer), mass: Math.floor(e.killer.totalMass()), kills: e.killer.stats.playersEaten, victim: e.victim, victimMass: e.victimMass, ...(e.victimIsBot ? { victimIsBot: true } : {}) }),
      onBellSettled: (e) => ctl({ k: 'bell', e }),
      integrity,
      // power-ups: the main thread holds the charges and asks this worker to apply the effect (`boost`)
    };
  }

  /** The hid of the room under construction (its constructor adopts its loot). */
  private creating = 0;

  hidOf(room: RoomConnRoom): number {
    return this.hids.get(room as Room) ?? 0;
  }

  private byId(id: string): Room | null {
    for (const r of this.rooms.values()) if (r.id === id) return r;
    return null;
  }

  start(): void {
    this.stopLoop = startTickLoop(() => this.tickAll(), TICK_MS);
    this.timers.push(
      setInterval(() => this.sendStats(), STATS_MS),
      setInterval(() => {
        if (this.monitor && this.monitor.size > 0) this.out.push({ k: 'liveSessions', list: this.monitor.live() });
      }, LIVE_SUMMARY_MS),
    );
  }

  private tickAll(): void {
    const t0 = performance.now();
    for (const room of this.rooms.values()) {
      const r0 = performance.now();
      try {
        room.tick(TICK_MS);
      } catch (err) {
        this.out.push({ k: 'log', m: `room ${room.id} tick failed: ${(err as Error).stack ?? err}` });
      }
      roomTickStats(room).record(performance.now() - r0);
    }
    this.tickStats.record(performance.now() - t0);
    this.flush();
  }

  private flushQueued = false;
  private flushSoon(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    setImmediate(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Reports connection state changes, then posts the batch. */
  flush(): void {
    for (const c of this.conns.values()) {
      const hid = c.room ? this.hidOf(c.room) : 0;
      const pid = c.room && c.player?.alive ? c.player.id : null;
      if (hid !== c.reported.hid || pid !== c.reported.pid) {
        const was = c.reported.hid;
        if (was !== 0 && was !== hid) this.out.push({ k: 'cs', conn: c.id, hid: was, attached: false, pid: null });
        if (hid !== 0) this.out.push({ k: 'cs', conn: c.id, hid, attached: true, pid });
        c.reported = { hid, pid };
      }
      if (!c.room) this.conns.delete(c.id);
    }
    if (this.out.empty) return;
    const { batch, transfer } = this.out.take();
    this.post(batch, transfer);
  }

  private summary(hid: number, r: Room): RoomSummary {
    const c = r.botCounts();
    return { hid, info: r.info(), humans: c.humans, conns: r.conns.size, bots: c.bots, loot: r.lootCount(), side: r.mapSide(), mapScale: r.mapScale(), lastActivity: r.lastActivity };
  }

  private sendStats(): void {
    let humans = 0;
    let bots = 0;
    let conns = 0;
    const rooms: RoomSummary[] = [];
    const roomLoads: RoomLoad[] = [];
    for (const [hid, r] of this.rooms) {
      const s = this.summary(hid, r);
      rooms.push(s);
      humans += s.humans;
      bots += s.bots;
      conns += s.conns;
      roomLoads.push({ id: r.id, humans: s.humans, conns: s.conns, bots: s.bots, tick: roomTickStats(r).summary() });
    }
    this.out.push({
      k: 'stats',
      load: { id: this.init.index, rooms: this.rooms.size, humans, bots, conns, tick: this.tickStats.summary(), ...this.meter.sample(), up: true },
      rooms,
      roomLoads,
    });
    this.flush();
  }

  private conn(meta: ConnMeta): WorkerConn {
    let c = this.conns.get(meta.id);
    if (!c) this.conns.set(meta.id, (c = new WorkerConn(meta.id, meta.ipHash, meta.fpHash, this)));
    c.ip = meta.ipHash;
    c.fp = meta.fpHash;
    c.wallet = meta.wallet;
    c.aspect = meta.aspect;
    c.standings = meta.standings;
    return c;
  }

  /** Detaches a connection from its room here when it is about to enter another one. */
  private attachTo(c: WorkerConn, room: Room): void {
    if (c.room && c.room !== room && c.player?.alive) c.room.leave(c, 'switch');
    c.lastHid = this.hidOf(room);
  }

  /** Runs a batch of commands from the main thread, then posts what they produced. */
  handle(cmds: Cmd[]): void {
    for (const cmd of cmds) {
      try {
        this.run(cmd);
      } catch (err) {
        this.out.push({ k: 'log', m: `room worker ${this.init.index}: ${cmd.k} failed: ${(err as Error).stack ?? err}` });
      }
    }
    if (!this.stopped) this.flush();
  }

  private run(cmd: Cmd): void {
    switch (cmd.k) {
      case 'create': {
        const spec = cmd.spec;
        // a custom room's map shape is a function: rebuilt here from its config
        const cfg = spec.map?.config;
        const opts = cfg && spec.map ? { ...spec, map: { ...spec.map, shape: (side: number) => customWorld(cfg, side) } } : spec;
        this.loot.set(cmd.hid, cmd.loot);
        this.creating = cmd.hid;
        let room: Room;
        try {
          room = new Room(opts, this.deps);
        } finally {
          this.creating = 0;
          this.loot.delete(cmd.hid);
        }
        this.rooms.set(cmd.hid, room);
        this.hids.set(room, cmd.hid);
        return;
      }
      case 'close': {
        const room = this.rooms.get(cmd.hid);
        if (!room) {
          if (!cmd.force) this.out.push({ k: 'closed', hid: cmd.hid, ok: true });
          return;
        }
        if (cmd.force) {
          try {
            if (cmd.message !== undefined) room.evict(cmd.message);
          } finally {
            this.rooms.delete(cmd.hid);
            this.out.push({ k: 'closed', hid: cmd.hid, ok: true });
          }
          return;
        }
        if (cmd.message !== undefined) {
          // a paid custom room's end: only once its bell settled every ticket and burned its loot
          const done = room.closeSettled(cmd.message);
          if (done) this.rooms.delete(cmd.hid);
          this.out.push({ k: 'closed', hid: cmd.hid, ok: done });
          return;
        }
        const idle = room.conns.size === 0 && room.humans.size === 0 && room.liveSessions().length === 0 && room.lootCount() === 0;
        if (idle) this.rooms.delete(cmd.hid);
        this.out.push({ k: 'closed', hid: cmd.hid, ok: idle });
        return;
      }
      case 'join': {
        const room = this.rooms.get(cmd.hid);
        const c = this.conn(cmd.conn);
        if (!room) {
          this.out.push({ k: 'joinFail', hid: cmd.hid, conn: c.id });
          return;
        }
        // already playing here (a duplicate join on its way): nothing to do
        if (c.room === room && c.player?.alive) {
          this.out.push({ k: 'joined', hid: cmd.hid, conn: c.id, pid: c.player.id, humans: room.humans.size });
          return;
        }
        this.attachTo(c, room);
        const p = room.join(c, cmd.opts);
        this.out.push({ k: 'joined', hid: cmd.hid, conn: c.id, pid: p.id, humans: room.humans.size });
        return;
      }
      case 'reattach': {
        const room = this.rooms.get(cmd.hid);
        const c = this.conn(cmd.conn);
        let ok = false;
        if (room && !c.player?.alive) {
          const before = c.lastHid;
          c.lastHid = cmd.hid;
          ok = room.reattach(c, cmd.pid);
          if (!ok) c.lastHid = before;
        }
        const holder = ok && ((c.player?.flags ?? 0) & PlayerFlag.Holder) !== 0;
        this.out.push({ k: 'reattached', req: cmd.req, ok, humans: room?.humans.size ?? 0, holder });
        return;
      }
      case 'spectate': {
        const room = this.rooms.get(cmd.hid);
        if (!room) return;
        const c = this.conn(cmd.conn);
        this.attachTo(c, room);
        room.spectate(c, cmd.next);
        return;
      }
      case 'leave': {
        const room = this.rooms.get(cmd.hid);
        const c = this.conns.get(cmd.conn);
        if (room && c && c.room === room) room.leave(c, cmd.reason);
        return;
      }
      case 'detach': {
        const room = this.rooms.get(cmd.hid);
        const c = this.conns.get(cmd.conn);
        if (room && c && c.room === room) room.detach(c);
        return;
      }
      case 'drop': {
        const c = this.conns.get(cmd.conn);
        if (c?.room) c.room.leave(c, 'disconnect');
        return;
      }
      case 'in': {
        const c = this.conns.get(cmd.conn);
        if (c?.room) c.room.input(c, { op: cmd.op, x: cmd.x, y: cmd.y } as ClientInput);
        return;
      }
      case 'chat': {
        const c = this.conns.get(cmd.conn);
        if (c?.room && this.hidOf(c.room) === cmd.hid) c.room.chat(c, cmd.text);
        return;
      }
      case 'emote': {
        const c = this.conns.get(cmd.conn);
        if (c?.room && this.hidOf(c.room) === cmd.hid) c.room.emote(c, cmd.id);
        return;
      }
      case 'cashout': {
        const c = this.conns.get(cmd.conn);
        if (c?.room && this.hidOf(c.room) === cmd.hid) c.room.cashout(c);
        return;
      }
      case 'standings': {
        const c = this.conns.get(cmd.conn);
        if (!c) return;
        c.standings = cmd.on;
        if (cmd.send && c.room) c.room.sendStandings(c);
        return;
      }
      case 'aspect': {
        const c = this.conns.get(cmd.conn);
        if (c) c.aspect = cmd.aspect;
        return;
      }
      case 'slow': {
        const c = this.conns.get(cmd.conn);
        if (c) c.slow = cmd.slow;
        return;
      }
      case 'boost': {
        const room = this.rooms.get(cmd.hid);
        const c = this.conns.get(cmd.conn);
        const p = c?.player;
        const ok = !!room && !!c && c.room === room && !!p && p.alive && !p.afk && p.id === cmd.pid && room.world.useBoost(p.id, cmd.kind as never);
        this.out.push({ k: 'boost', req: cmd.req, ok });
        return;
      }
      case 'map':
        this.rooms.get(cmd.hid)?.setMapScale(cmd.scale);
        return;
      case 'bots':
        this.rooms.get(cmd.hid)?.setBots(cmd.count, cmd.difficulty);
        return;
      case 'buyIn':
        this.rooms.get(cmd.hid)?.setBuyIn(cmd.buyIn);
        return;
      case 'avatar':
        for (const r of this.rooms.values()) r.clearAvatar(cmd.wallet);
        return;
      case 'announce':
        this.rooms.get(cmd.hid)?.announce(cmd.text);
        return;
      case 'closing':
        this.rooms.get(cmd.hid)?.closingSoon(cmd.endsAt, cmd.message);
        return;
      case 'clock':
        this.offset = cmd.offset;
        return;
      case 'block': {
        const end = Date.now() + cmd.ms;
        while (Date.now() < end) {
          /* a hung room */
        }
        return;
      }
      case 'shutdown':
        this.shutdown();
        return;
    }
  }

  /** Settles every staker (an operator exit, like a process stop), posts the last batch and `bye`. */
  private shutdown(): void {
    this.stopped = true;
    this.stopLoop?.();
    for (const t of this.timers) clearInterval(t);
    for (const room of this.rooms.values()) {
      try {
        room.shutdown();
      } catch (err) {
        this.out.push({ k: 'log', m: `room ${room.id}: shutdown failed: ${(err as Error).stack ?? err}` });
      }
    }
    this.out.push({ k: 'bye' });
    const { batch, transfer } = this.out.take();
    this.post(batch, transfer);
    this.meter.stop();
  }
}
