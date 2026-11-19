import { TICK_MS } from '@coinnibal/shared';

/**
 * The jitter buffer: snapshots are drawn on a steady timeline about `RENDER_DELAY_MS` behind the newest one, instead of
 * the moment each happens to arrive. A WebSocket is TCP: a lost segment holds every snapshot behind it until the
 * retransmission lands (head-of-line blocking), so on a lossy phone link they arrive in bursts with gaps of 200 ms
 * and more. Drawn on arrival, every gap is a freeze and every burst a jump; on the timeline a gap shorter than the
 * delay is never seen, and a longer one is bridged by extrapolating with the cells' velocities
 * (`ClientWorld.extrapolateMs`).
 *
 * Each snapshot carries the server's tick; its place on the timeline is `tick * TICK_MS + offset`, where `offset`
 * is the smallest arrival delay seen lately (a "leaky minimum": it snaps down to any earlier arrival and creeps up
 * slowly, so a path that got slower for good is followed within seconds). Pure (no DOM): unit-tested.
 */

/** How far behind the newest snapshot the world is drawn (ms). */
export const RENDER_DELAY_MS = 100;
/** How long a cell keeps moving on its last velocity when the next snapshot is late (ms). */
export const EXTRAPOLATE_MS = 250;
/** The offset creeps up by this much per snapshot (30 a second: about 7.5 ms a second). */
const OFFSET_LEAK_MS = 0.25;
/** A tick this far off the last one is another room (or a restart): the timeline starts afresh. */
const TICK_JUMP = 150;
/** The ease of one snapshot is the time to the next one, within these bounds (ms). */
const MIN_STEP_MS = TICK_MS / 2;
const MAX_STEP_MS = 150;

export interface Due<T> {
  item: T;
  /** The snapshot's time on the timeline (local ms, `performance.now()` clock). */
  at: number;
  /** The time since the snapshot before it (ms): how long the world eases toward this one. */
  step: number;
}

export class SnapshotTimeline<T> {
  private queue: { item: T; at: number; step: number }[] = [];
  private offset: number | null = null;
  private lastTick = 0;
  /** The timeline time of the last snapshot queued. */
  private lastAt = -Infinity;

  constructor(
    readonly delayMs = RENDER_DELAY_MS,
    private readonly tickMs = TICK_MS,
  ) {}

  /** Snapshots waiting for their time. */
  get size(): number {
    return this.queue.length;
  }

  /** Queues a snapshot of server tick `tick` that arrived at `now`. */
  push(item: T, tick: number, now: number): void {
    if (this.offset !== null && (tick < this.lastTick || tick - this.lastTick > TICK_JUMP)) this.restart();
    const base = tick * this.tickMs;
    const delay = now - base;
    if (this.offset === null || delay < this.offset) this.offset = delay;
    else this.offset += OFFSET_LEAK_MS;
    const prev = this.lastAt;
    // in order, always (an offset that just snapped down never puts a snapshot before the one queued ahead of it)
    const at = Math.max(base + this.offset, prev);
    const step = prev === -Infinity ? this.tickMs : Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, (tick - this.lastTick) * this.tickMs));
    this.lastTick = tick;
    this.lastAt = at;
    this.queue.push({ item, at, step });
  }

  /**
   * The snapshots whose time has come at `now` (the timeline runs `delayMs` behind), oldest first. Each is removed.
   * With `all` every queued snapshot is due (a hidden tab draws nothing, but the mirror must keep up).
   */
  due(now: number, all = false): Due<T>[] {
    const until = now - this.delayMs;
    let n = 0;
    while (n < this.queue.length && (all || this.queue[n].at <= until)) n++;
    return n === 0 ? EMPTY : this.queue.splice(0, n);
  }

  /** Drops what is queued (a new view on the server: `welcome`, `joined`, `spectating`). The offset is kept. */
  clear(): void {
    this.queue = [];
  }

  /** Forgets everything, the offset too (another room's ticks). */
  restart(): void {
    this.queue = [];
    this.offset = null;
    this.lastAt = -Infinity;
    this.lastTick = 0;
  }
}

const EMPTY: never[] = [];
