import type { GasRunway } from '@coinnibal/shared';

/** Samples older than this are dropped. */
const KEEP_MS = 7 * 24 * 3600_000;
/** The spend rate is measured over the last day of samples (or what there is, from an hour on). */
const WINDOW_MS = 24 * 3600_000;
const MIN_SPAN_MS = 3600_000;
/** Samples closer together than this replace the previous one (a restart reads the balance again at once). */
const MIN_GAP_MS = 60_000;

export interface GasRunwayLimits {
  floorWei: bigint;
  warnDays: number;
  criticalDays: number;
}

/**
 * The server key's gas runway: how many days its balance lasts at the trailing spend (the drops between balance
 * reads over the last day; a top-up is not spend). `critical` below `criticalDays` (2) or under the floor, `warn` below
 * `warnDays` (7). The samples survive restarts (`save` / `load`), so a fresh process knows the rate at once.
 */
export class GasRunwayTracker {
  private samples: [number, bigint][] = [];

  constructor(private readonly limits: GasRunwayLimits) {}

  /** The balance read at `at` (Unix ms). */
  record(at: number, balanceWei: bigint): void {
    const last = this.samples.at(-1);
    if (last && at - last[0] < MIN_GAP_MS) this.samples[this.samples.length - 1] = [at, balanceWei];
    else this.samples.push([at, balanceWei]);
    while (this.samples.length > 0 && this.samples[0][0] < at - KEEP_MS) this.samples.shift();
  }

  /** Wei spent per day over the trailing window; null while the samples span less than an hour. */
  spendPerDay(now: number): bigint | null {
    const from = now - WINDOW_MS;
    const s = this.samples.filter(([t]) => t >= from);
    if (s.length < 2 || s.at(-1)![0] - s[0][0] < MIN_SPAN_MS) return null;
    let spent = 0n;
    for (let i = 1; i < s.length; i++) if (s[i][1] < s[i - 1][1]) spent += s[i - 1][1] - s[i][1];
    return (spent * 86_400_000n) / BigInt(s.at(-1)![0] - s[0][0]);
  }

  view(now: number): GasRunway {
    const last = this.samples.at(-1) ?? null;
    const balance = last ? last[1] : null;
    const rate = this.spendPerDay(now);
    const days = balance !== null && rate !== null ? (rate > 0n ? Number((balance * 1000n) / rate) / 1000 : Infinity) : null;
    let level: GasRunway['level'] = 'unknown';
    if (balance !== null) {
      if (balance < this.limits.floorWei || (days !== null && days < this.limits.criticalDays)) level = 'critical';
      else if (days !== null && days < this.limits.warnDays) level = 'warn';
      else level = days === null ? 'unknown' : 'ok';
    }
    const first = this.samples.find(([t]) => t >= now - WINDOW_MS);
    return {
      level,
      balanceWei: balance === null ? null : balance.toString(),
      spendWeiPerDay: rate === null ? null : rate.toString(),
      // no spend at all: an endless runway, shown as null days with level ok
      days: days === null || !Number.isFinite(days) ? null : Math.round(days * 10) / 10,
      floorWei: this.limits.floorWei.toString(),
      warnDays: this.limits.warnDays,
      criticalDays: this.limits.criticalDays,
      sampledHours: first && last ? Math.round(((last[0] - first[0]) / 3600_000) * 10) / 10 : 0,
    };
  }

  /** For the chain cache: `[at, wei]` pairs. */
  save(): [number, string][] {
    return this.samples.map(([t, w]) => [t, w.toString()]);
  }

  load(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const ok: [number, bigint][] = [];
    for (const x of raw) {
      if (Array.isArray(x) && Number.isFinite(x[0]) && typeof x[1] === 'string' && /^\d{1,40}$/.test(x[1])) ok.push([Number(x[0]), BigInt(x[1])]);
    }
    this.samples = ok.sort((a, b) => a[0] - b[0]);
  }
}
