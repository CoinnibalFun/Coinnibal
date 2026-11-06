/**
 * Bench-only probe, preloaded into the main thread AND every room worker (workers inherit `execArgv`):
 *
 *   node --import tsx --import ./scripts/bench/tick-probe.ts scripts/bench/audit-load.ts
 *
 * - `TickStats.summary()` additionally reports `p50Ms` and `p99Ms` of its ring (the production summary has
 *   mean / p95 / max only). The extra fields ride along in the worker's stats message unchanged.
 * - Every summary also carries `gc`: this thread's garbage-collection pauses since the probe was loaded
 *   (count, total, max, p99 of the last 4,096 pauses), from a `PerformanceObserver` on `gc` entries.
 *
 * Nothing in production imports this file.
 */
import { PerformanceObserver } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';

// a room worker runs this preload before its own bootstrap registers tsx (ts-worker.mjs): register it here
if (!isMainThread) (await import('tsx/esm/api')).register();
const { TickStats } = await import('../../src/rooms/load');

const GC_RING = 4096;
const gc = { count: 0, totalMs: 0, maxMs: 0, ring: new Float64Array(GC_RING), i: 0, major: 0, majorMaxMs: 0 };
const KIND_MAJOR = 4; // NODE_PERFORMANCE_GC_MAJOR (mark-sweep-compact)

new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    const d = e.duration;
    gc.count++;
    gc.totalMs += d;
    if (d > gc.maxMs) gc.maxMs = d;
    gc.ring[gc.i++ % GC_RING] = d;
    const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind;
    if (kind === KIND_MAJOR) {
      gc.major++;
      if (d > gc.majorMaxMs) gc.majorMaxMs = d;
    }
  }
}).observe({ entryTypes: ['gc'] });

function gcSummary() {
  const n = Math.min(gc.count, GC_RING);
  const a = Array.from(gc.ring.subarray(0, n)).sort((x, y) => x - y);
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    count: gc.count,
    totalMs: r(gc.totalMs),
    maxMs: r(gc.maxMs),
    p99Ms: n ? r(a[Math.min(n - 1, Math.floor(n * 0.99))]) : 0,
    major: gc.major,
    majorMaxMs: r(gc.majorMaxMs),
  };
}

const proto = TickStats.prototype as unknown as { summary: () => Record<string, unknown>; __probed?: boolean };
if (!proto.__probed) {
  proto.__probed = true;
  const orig = proto.summary;
  proto.summary = function (this: { buf: Float64Array; count: number }) {
    const base = orig.call(this);
    const n = this.count;
    if (n > 0) {
      const a = Array.from(this.buf.subarray(0, n)).sort((x, y) => x - y);
      const r = (v: number) => Math.round(v * 100) / 100;
      base.p50Ms = r(a[Math.floor(n * 0.5)]);
      base.p99Ms = r(a[Math.min(n - 1, Math.floor(n * 0.99))]);
    }
    base.gc = gcSummary();
    return base;
  };
}
