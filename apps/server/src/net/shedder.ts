import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * - `ok`: everything is admitted.
 * - `busy`: new free games (practice, private and custom rooms) are refused (`server_full`); live games, reconnects
 *   and paid arena seats go on.
 * - `critical`: new WebSocket connections are refused too (HTTP 503) and new arena seats wait (the ticket stays on
 *   chain; a seat is retried, or the unplayed ticket is refunded in full).
 */
export type LoadLevel = 'ok' | 'busy' | 'critical';

export interface ShedderSignals {
  /** The game thread with the most headroom: its tick p95 (ms; the frame budget is 33 ms). Null: unknown. */
  bestTickP95Ms(): number | null;
}

export const SHED_THRESHOLDS = {
  busy: { lagP99Ms: 150, tickP95Ms: 28 },
  critical: { lagP99Ms: 400, tickP95Ms: 45 },
};

/** Sampling period; a level holds at least two periods before it eases (no flapping). */
const SAMPLE_MS = 2_000;

/**
 * Graceful degradation under load: new joins are shed before live rooms lose their tick budget. Watches the main
 * thread's event-loop lag (sockets, HTTP, the chain and the journal all run there) and the tick time of the game
 * thread with the most headroom (a new room goes to the least loaded worker). Sampled every 2 s.
 */
export class LoadShedder {
  private readonly lag: IntervalHistogram;
  private timer: NodeJS.Timeout | null = null;
  private levelV: LoadLevel = 'ok';
  private calmSamples = 0;
  /** Refusals since start, by level (the load test and `/api/admin/load` read them). */
  readonly refused = { busy: 0, critical: 0 };

  constructor(
    private readonly signals: ShedderSignals,
    private readonly log: (m: string) => void = () => {},
  ) {
    this.lag = monitorEventLoopDelay({ resolution: 10 });
  }

  start(): void {
    if (this.timer) return;
    this.lag.enable();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lag.disable();
  }

  get level(): LoadLevel {
    return this.levelV;
  }

  /** One sample (public for tests): the level from the lag since the last sample and the best tick p95. */
  sample(lagP99Ms = Math.max(0, this.lag.percentile(99) / 1e6 - 10), tickP95Ms = this.signals.bestTickP95Ms()): LoadLevel {
    this.lag.reset();
    const t = tickP95Ms ?? 0;
    const want: LoadLevel =
      lagP99Ms >= SHED_THRESHOLDS.critical.lagP99Ms || t >= SHED_THRESHOLDS.critical.tickP95Ms
        ? 'critical'
        : lagP99Ms >= SHED_THRESHOLDS.busy.lagP99Ms || t >= SHED_THRESHOLDS.busy.tickP95Ms
          ? 'busy'
          : 'ok';
    const rank = { ok: 0, busy: 1, critical: 2 } as const;
    if (rank[want] >= rank[this.levelV]) {
      this.calmSamples = 0;
      if (want !== this.levelV) this.log(`!!! load: ${want.toUpperCase()} (event-loop lag p99 ${Math.round(lagP99Ms)} ms, best game thread tick p95 ${t} ms) — shedding new ${want === 'critical' ? 'connections and joins' : 'free games'}`);
      this.levelV = want;
    } else if (++this.calmSamples >= 2) {
      this.calmSamples = 0;
      this.log(`load: ${want} again (lag p99 ${Math.round(lagP99Ms)} ms, tick p95 ${t} ms)`);
      this.levelV = want;
    }
    return this.levelV;
  }

  /** May a new free game start? Counts a refusal. */
  admitFree(): boolean {
    if (this.levelV === 'ok') return true;
    this.refused.busy++;
    return false;
  }

  /** May a new connection (or a new arena seat) be taken? Counts a refusal. */
  admitCritical(): boolean {
    if (this.levelV !== 'critical') return true;
    this.refused.critical++;
    return false;
  }
}
