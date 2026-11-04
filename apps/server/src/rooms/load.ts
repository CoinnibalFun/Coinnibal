import { monitorEventLoopDelay, performance, type EventLoopUtilization, type IntervalHistogram } from 'node:perf_hooks';

/** Tick time of the last few seconds: mean, p95 and max (ms). */
export interface TickSummary {
  n: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

/** One room's load (from the thread that runs it). */
export interface RoomLoad {
  id: string;
  humans: number;
  conns: number;
  bots: number;
  tick: TickSummary;
}

/** One game thread: the main thread in single-thread mode, else one room worker. */
export interface ThreadLoad {
  /** `main` (GAME_WORKERS=0) or the worker index (0-based). */
  id: 'main' | number;
  rooms: number;
  humans: number;
  conns: number;
  bots: number;
  /** The whole tick of the thread (every room it runs, back to back): the 33 ms frame budget. */
  tick: TickSummary;
  /** Event-loop utilisation since the previous sample (0..1). */
  elu: number;
  lagP50Ms: number;
  lagP99Ms: number;
  lagMaxMs: number;
  heapMb: number;
  /** Restarts of this worker after a crash or a hang (workers only). */
  restarts?: number;
  /** Worker threads: alive and answering. */
  up?: boolean;
  /** Per-room detail (only asked for by the admin view and the load test). */
  roomLoads?: RoomLoad[];
}

/** `GET /api/admin/load`: per-thread load of the game server. */
export interface ServerLoad {
  mode: 'single' | 'workers';
  workers: number;
  cpus: number;
  rssMb: number;
  /** The main thread (HTTP, chain, journal, sockets); in single-thread mode it also runs every room. */
  main: ThreadLoad;
  /** Room workers (empty in single-thread mode). */
  threads: ThreadLoad[];
  /** WebSocket bytes sent per second (all clients). */
  sentBytesPerSec: number;
  /** WebSocket messages sent per second (all clients). */
  sentMsgsPerSec: number;
  conns: number;
  at: number;
}

const EMPTY: TickSummary = { n: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };

/** A ring of the last `size` tick durations (ms). At 30 Hz, 300 is ten seconds. */
export class TickStats {
  private readonly buf: Float64Array;
  private i = 0;
  private count = 0;

  constructor(size = 300) {
    this.buf = new Float64Array(size);
  }

  record(ms: number): void {
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  summary(): TickSummary {
    const n = this.count;
    if (n === 0) return EMPTY;
    const a = Array.from(this.buf.subarray(0, n)).sort((x, y) => x - y);
    let sum = 0;
    for (const v of a) sum += v;
    const r = (v: number) => Math.round(v * 100) / 100;
    return { n, meanMs: r(sum / n), p95Ms: r(a[Math.min(n - 1, Math.floor(n * 0.95))]), maxMs: r(a[n - 1]) };
  }
}

/** Event-loop lag and utilisation of the current thread, reset at every sample. */
export class ThreadMeter {
  private readonly lag: IntervalHistogram;
  private elu: EventLoopUtilization;

  constructor() {
    this.lag = monitorEventLoopDelay({ resolution: 10 });
    this.lag.enable();
    this.elu = performance.eventLoopUtilization();
  }

  sample(): { elu: number; lagP50Ms: number; lagP99Ms: number; lagMaxMs: number; heapMb: number } {
    const now = performance.eventLoopUtilization();
    const d = performance.eventLoopUtilization(now, this.elu);
    this.elu = now;
    const ms = (ns: number) => Math.round((ns / 1e6) * 100) / 100;
    // the histogram's floor is its resolution (10 ms): lag is what comes on top of it
    const res = 10;
    const out = {
      elu: Math.round(d.utilization * 1000) / 1000,
      lagP50Ms: Math.max(0, ms(this.lag.percentile(50)) - res),
      lagP99Ms: Math.max(0, ms(this.lag.percentile(99)) - res),
      lagMaxMs: Math.max(0, ms(this.lag.max) - res),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1e5) / 10,
    };
    this.lag.reset();
    return out;
  }

  stop(): void {
    this.lag.disable();
  }
}

/** Bytes and messages written to WebSockets by this process (counted where frames are sent). */
export const wsOut = { bytes: 0, msgs: 0 };

const roomStats = new WeakMap<object, TickStats>();

/** The tick-time ring of one room (created on first use). */
export function roomTickStats(room: object): TickStats {
  let s = roomStats.get(room);
  if (!s) roomStats.set(room, (s = new TickStats()));
  return s;
}

/**
 * The fixed-step game loop: calls `tick` every `stepMs` on the wall clock, catching up at most
 * three steps at once and resyncing when it fell far behind. Returns its stop function.
 */
export function startTickLoop(tick: () => void, stepMs: number): () => void {
  let next = performance.now();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 3) {
      tick();
      next += stepMs;
      n++;
    }
    if (now - next > 250) next = now + stepMs; // fell far behind: resync
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  };
  timer = setTimeout(loop, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
