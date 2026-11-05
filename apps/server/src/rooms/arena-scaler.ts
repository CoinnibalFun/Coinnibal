import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARENA_SCALING_DEFAULT,
  ARENA_SCALING_LIMITS,
  applyArenaScaling,
  arenaMeta,
  type ArenaScalingArenaView,
  type ArenaScalingDecision,
  type ArenaScalingSettings,
  type ArenaScalingView,
} from '@elymum/shared';
import type { RoomHandle } from './handle';

/**
 * The arena instance scaler (`packages/shared/src/arena-scaling.ts` has the rules): it decides how many public
 * instances of each arena take seats, picks the instance for a new seat, drains an instance when demand falls and
 * closes it once its bell settled everything in it. It never evicts anyone and never touches a ticket: closing goes
 * through `Room.closeSettled` (nothing of value left), on this thread or in a room worker.
 *
 * Settings: `DATA_DIR/site/arena-scaling.json`, `/api/admin/arena-scaling`, applied live.
 */

/** How often the scaler samples demand and decides (ms). */
export const SCALER_SAMPLE_MS = 5000;
/** Decisions kept for the admin view. */
const SCALER_LOG_KEPT = 200;
const ARENA_SCALING_FILE = join('site', 'arena-scaling.json');

/** What the scaler asks of the room directory (`RoomManager`). */
export interface ScalerHost {
  /** Every public instance of an arena, by instance number (paid custom rooms are never among them). */
  instances(arenaId: number): RoomHandle[];
  /** Arenas that have at least one public instance here. */
  arenaIds(): number[];
  /** Seats per instance (`ARENA_INSTANCE_CAP`). */
  capacity(): number;
  /** Opens one more public instance of the arena (on the least-loaded worker); null when the arena cannot take one now. */
  openInstance(arenaId: number): RoomHandle | null;
  /** Closes a drained instance once nothing of value is left in it: `closed` now, or `pending` (try again later). */
  closeDrained(room: RoomHandle): 'closed' | 'pending';
  /** The thread a room runs on (`w<n>`), absent on the main thread. */
  threadOf(room: RoomHandle): string | undefined;
  /** The wall clock (Unix ms) the rounds run on: the scaler's windows and cooldowns use it too. */
  now(): number;
  log(m: string): void;
}

interface Sample {
  at: number;
  /** People in every public instance (draining ones too). */
  all: number;
  /** People in the instances taking seats. */
  active: number;
  /** Seats of the instances taking seats. */
  seats: number;
}

interface ArenaState {
  samples: Sample[];
  /** When an instance reached its capacity (pruned to the window). */
  hits: number[];
  /** Instances at capacity at the last sample (a hit is the step up to it). */
  atCap: Set<string>;
  lastActionAt: number | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export class ArenaScalingFail extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/** The persisted settings (validated; a broken file is moved aside). */
export class ArenaScalingStore {
  private cur: ArenaScalingSettings = { ...ARENA_SCALING_DEFAULT };

  constructor(
    private readonly dataDir: string | null,
    private readonly log: (m: string) => void = () => {},
  ) {
    const p = this.path();
    if (!p || !existsSync(p)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (!isObj(raw)) throw new Error('not an object');
      const r = applyArenaScaling(ARENA_SCALING_DEFAULT, raw, false);
      if (r.ok) this.cur = r.settings;
    } catch (err) {
      const backup = `${p}.corrupt-${Date.now()}`;
      renameSync(p, backup);
      this.log(`arena scaling: ${p} is unreadable (${(err as Error).message}); moved to ${backup}, using the defaults`);
    }
  }

  private path(): string | null {
    return this.dataDir ? join(this.dataDir, ARENA_SCALING_FILE) : null;
  }

  get settings(): ArenaScalingSettings {
    return { ...this.cur };
  }

  /** Validates and stores an admin patch; throws `ArenaScalingFail`. */
  update(body: Record<string, unknown>): ArenaScalingSettings {
    const r = applyArenaScaling(this.cur, body, true);
    if (!r.ok) throw new ArenaScalingFail(r.message, r.field);
    this.cur = r.settings;
    const p = this.path();
    if (p) {
      mkdirSync(join(this.dataDir!, 'site'), { recursive: true });
      writeFileSync(`${p}.tmp`, JSON.stringify(this.cur, null, 2));
      renameSync(`${p}.tmp`, p);
    }
    return this.settings;
  }
}

export class ArenaScaler {
  private readonly state = new Map<number, ArenaState>();
  /** Instances that take no new seats and close once settled. */
  private readonly draining = new Set<string>();
  private readonly decisions: ArenaScalingDecision[] = [];
  private nextSampleAt = 0;

  constructor(
    private readonly host: ScalerHost,
    readonly store: ArenaScalingStore,
  ) {}

  get settings(): ArenaScalingSettings {
    return this.store.settings;
  }

  isDraining(room: RoomHandle): boolean {
    return this.draining.has(room.id);
  }

  private st(arenaId: number): ArenaState {
    let s = this.state.get(arenaId);
    if (!s) {
      s = { samples: [], hits: [], atCap: new Set(), lastActionAt: null };
      this.state.set(arenaId, s);
    }
    return s;
  }

  private active(arenaId: number): RoomHandle[] {
    return this.host.instances(arenaId).filter((r) => !this.draining.has(r.id) && !isClosing(r));
  }

  private people(rooms: RoomHandle[]): number {
    let n = 0;
    for (const r of rooms) n += r.humanCount;
    return n;
  }

  /**
   * Logs a decision. `scaler`: one of the scaler's own moves (ahead of demand, a consolidation, the minimum), which
   * start the arena's cooldown; a seat's overflow or take-back and a close do not.
   */
  private record(arenaId: number, action: ArenaScalingDecision['action'], room: string, reason: string, now: number, scaler = false): void {
    const all = this.host.instances(arenaId);
    const d: ArenaScalingDecision = { at: now, arenaId, action, room, reason, people: this.people(all), instances: this.active(arenaId).length };
    this.decisions.unshift(d);
    if (this.decisions.length > SCALER_LOG_KEPT) this.decisions.length = SCALER_LOG_KEPT;
    if (scaler) this.st(arenaId).lastActionAt = now;
    this.host.log(`arena scaling: #${arenaId} ${action} ${room} (${reason}; ${d.people} people, ${d.instances} taking seats)`);
  }

  /**
   * The instance for a new seat of `arenaId`: the fullest instance taking seats that is not full. When every
   * one is full: a draining instance with room takes seats again, else a new instance opens (beyond
   * `maxInstances` too, logged as an overflow: a bought ticket always gets a room). Null only when the arena
   * cannot open an instance at all.
   */
  seatFor(arenaId: number, now = this.host.now()): RoomHandle | null {
    const cap = this.host.capacity();
    let best: RoomHandle | null = null;
    for (const r of this.active(arenaId)) {
      if (r.humanCount >= cap) continue;
      if (!best || r.humanCount > best.humanCount || (r.humanCount === best.humanCount && (r.opts.instance ?? 1) < (best.opts.instance ?? 1))) best = r;
    }
    if (best) return best;
    const active = this.active(arenaId).length;
    if (active > 0) this.st(arenaId).hits.push(now);
    const back = this.drainingWithRoom(arenaId);
    if (back) {
      this.draining.delete(back.id);
      this.record(arenaId, 'undrain', back.id, 'every instance taking seats is full', now);
      return back;
    }
    const room = this.host.openInstance(arenaId);
    if (!room) return null;
    const max = this.settings.maxInstances;
    if (active === 0) return room;
    this.record(arenaId, 'overflow', room.id, active + 1 > max ? `every instance is full; above the maximum of ${max} so no ticket waits` : 'every instance is full', now);
    return room;
  }

  /** A seat may go to `room` (still open here, not draining, not full). */
  seatable(room: RoomHandle): boolean {
    return !this.draining.has(room.id) && !isClosing(room) && room.humanCount < this.host.capacity();
  }

  private drainingWithRoom(arenaId: number): RoomHandle | null {
    const cap = this.host.capacity();
    let best: RoomHandle | null = null;
    for (const r of this.host.instances(arenaId)) {
      if (!this.draining.has(r.id) || isClosing(r) || r.humanCount >= cap) continue;
      if (!best || r.humanCount > best.humanCount) best = r;
    }
    return best;
  }

  /** Samples and decides at most every `SCALER_SAMPLE_MS` (called from the directory's housekeeping, every second). */
  tick(now = this.host.now()): void {
    if (now < this.nextSampleAt) return;
    this.nextSampleAt = now + SCALER_SAMPLE_MS;
    this.step(now);
  }

  /** One sampling step (tests and the simulation call it with their own clock). */
  step(now: number): void {
    const s = this.settings;
    const cap = this.host.capacity();
    const ids = this.host.arenaIds();
    // instances that are gone (closed, or lost with a room worker) stop draining
    const live = new Set(ids.flatMap((id) => this.host.instances(id).map((r) => r.id)));
    for (const id of [...this.draining]) {
      if (live.has(id)) continue;
      this.draining.delete(id);
      const m = /^arena-(\d+)-/.exec(id);
      if (m) this.record(Number(m[1]), 'close', id, 'drained: closed once its bell settled every ticket', now);
    }
    for (const [id] of this.state) if (!ids.includes(id)) this.state.delete(id);
    for (const arenaId of ids) {
      const st = this.st(arenaId);
      const all = this.host.instances(arenaId);
      const active = this.active(arenaId);
      // capacity events: an instance that reached its seats since the last sample while the arena is busy (at
      // least `highPct` full: filling the first of several open instances is no pressure)
      const atCap = new Set(active.filter((r) => r.humanCount >= cap).map((r) => r.id));
      const busy = 100 * this.people(active) >= s.highPct * Math.max(1, active.length) * cap;
      if (busy) for (const id of atCap) if (!st.atCap.has(id)) st.hits.push(now);
      st.atCap = atCap;
      const keepMs = Math.max(s.windowMin, s.sustainMin, s.lowMin) * 60_000 + SCALER_SAMPLE_MS;
      st.samples.push({ at: now, all: this.people(all), active: this.people(active), seats: Math.max(1, active.length) * cap });
      while (st.samples.length > 0 && st.samples[0].at < now - keepMs) st.samples.shift();
      st.hits = st.hits.filter((t) => t >= now - s.windowMin * 60_000);
      this.closeDrained(arenaId, now);
      this.decide(arenaId, st, now);
    }
  }

  /** Drained instances with nothing of value left close now. */
  private closeDrained(arenaId: number, now: number): void {
    for (const r of this.host.instances(arenaId)) {
      if (!this.draining.has(r.id) || isClosing(r)) continue;
      if (r.humanCount > 0 || r.liveSessions().length > 0 || r.lootCount() > 0) continue;
      if (this.host.closeDrained(r) === 'closed') {
        this.draining.delete(r.id);
        this.record(arenaId, 'close', r.id, 'drained: its bell settled every ticket', now);
      }
    }
  }

  private decide(arenaId: number, st: ArenaState, now: number): void {
    const s = this.settings;
    const cap = this.host.capacity();
    const active = this.active(arenaId);
    const cooled = st.lastActionAt === null || now - st.lastActionAt >= s.cooldownMin * 60_000;
    // the minimum always stands (a crash or a restart may have left fewer)
    if (active.length < s.minInstances) {
      for (let n = active.length; n < s.minInstances; n++) {
        const back = this.drainingWithRoom(arenaId);
        if (back) {
          this.draining.delete(back.id);
          this.record(arenaId, 'undrain', back.id, `below the minimum of ${s.minInstances}`, now, true);
          continue;
        }
        const room = this.host.openInstance(arenaId);
        if (!room) break;
        this.record(arenaId, 'open', room.id, `below the minimum of ${s.minInstances}`, now, true);
      }
      return;
    }
    if (!cooled) return;
    if (s.enabled && active.length < s.maxInstances) {
      const why = this.upReason(st, now);
      if (why) {
        st.hits = [];
        const back = this.drainingWithRoom(arenaId);
        if (back) {
          this.draining.delete(back.id);
          this.record(arenaId, 'undrain', back.id, why, now, true);
          return;
        }
        const room = this.host.openInstance(arenaId);
        if (room) this.record(arenaId, 'open', room.id, why, now, true);
        return;
      }
    }
    if (active.length <= s.minInstances) return;
    const win = st.samples.filter((x) => x.at >= now - s.lowMin * 60_000);
    // the window must be covered (a fresh start or a settings change waits a whole window)
    if (win.length === 0 || win[0].at > now - s.lowMin * 60_000 + SCALER_SAMPLE_MS) return;
    const peakAll = Math.max(...win.map((x) => x.all));
    const peakPct = Math.max(...win.map((x) => (100 * x.all) / x.seats));
    // off: only instances that stayed completely empty are consolidated
    if (!s.enabled ? peakAll > 0 : peakPct >= s.lowPct) return;
    // one instance fewer must still hold the peak below the scale-up line (no flapping)
    if (peakAll > ((active.length - 1) * cap * s.highPct) / 100) return;
    const victim = this.victim(active);
    if (!victim) return;
    this.draining.add(victim.id);
    st.atCap.delete(victim.id);
    this.record(arenaId, 'drain', victim.id, s.enabled ? `peak fill ${Math.round(peakPct)} % under ${s.lowPct} % for ${s.lowMin} min` : `empty for ${s.lowMin} min`, now, true);
    this.closeDrained(arenaId, now);
  }

  /** Why the arena needs another instance now, or null. */
  private upReason(st: ArenaState, now: number): string | null {
    const s = this.settings;
    if (st.hits.length >= s.fullHits) return `an instance reached capacity ${st.hits.length} times in ${s.windowMin} min`;
    const win = st.samples.filter((x) => x.at >= now - s.sustainMin * 60_000);
    if (win.length === 0 || win[0].at > now - s.sustainMin * 60_000 + SCALER_SAMPLE_MS) return null;
    const low = Math.min(...win.map((x) => (100 * x.active) / x.seats));
    return low >= s.highPct ? `at least ${s.highPct} % full for ${s.sustainMin} min` : null;
  }

  /** The instance to drain: never #1 (the lobby's, and the one that adopts journaled loot); the emptiest, then the newest. */
  private victim(active: RoomHandle[]): RoomHandle | null {
    let best: RoomHandle | null = null;
    for (const r of active) {
      if ((r.opts.instance ?? 1) === 1) continue;
      if (!best || r.humanCount < best.humanCount || (r.humanCount === best.humanCount && (r.opts.instance ?? 1) > (best.opts.instance ?? 1))) best = r;
    }
    return best;
  }

  /** `GET /api/admin/arena-scaling`. */
  view(now = this.host.now()): ArenaScalingView {
    const cap = this.host.capacity();
    const s = this.settings;
    const arenas: ArenaScalingArenaView[] = this.host.arenaIds().map((arenaId) => {
      const active = this.active(arenaId);
      const st = this.state.get(arenaId);
      return {
        arenaId,
        name: arenaMeta(arenaId).name,
        instances: this.host.instances(arenaId).map((r) => {
          const thread = this.host.threadOf(r);
          return { id: r.id, instance: r.opts.instance ?? 1, people: r.humanCount, capacity: cap, draining: this.draining.has(r.id), ...(thread ? { thread } : {}) };
        }),
        fillPct: Math.round((100 * this.people(active)) / Math.max(1, active.length * cap)),
        fullHits: st ? st.hits.filter((t) => t >= now - s.windowMin * 60_000).length : 0,
        lastActionAt: st?.lastActionAt ?? null,
      };
    });
    return { settings: s, defaults: { ...ARENA_SCALING_DEFAULT }, limits: ARENA_SCALING_LIMITS, arenas, log: this.decisions.slice(0, 100) };
  }

  /** Decisions, newest first (tests, the simulation). */
  log(): ArenaScalingDecision[] {
    return [...this.decisions];
  }
}

/** A room worker was asked to close the room and has not answered yet. */
function isClosing(r: RoomHandle): boolean {
  return (r as { closing?: boolean }).closing === true || (r as { closed?: boolean }).closed === true;
}
