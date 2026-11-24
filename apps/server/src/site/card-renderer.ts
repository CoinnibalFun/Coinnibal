import { Worker } from 'node:worker_threads';
import { runCardJob, type CardJob } from './card-jobs';

/**
 * Where share and Appetizer cards are drawn. A draw is 40-75 ms of CPU (up to ~235 ms measured), and on the main
 * thread it stalls every player's snapshots, so the server draws in a small pool of worker threads
 * (`CardWorkerPool`, `CARD_WORKERS`, default 1); `CARD_WORKERS=0` (and the tests' default) draws on the calling
 * thread (`InlineCardRenderer`). The drawing code is the same either way (`card-jobs.ts`), so are the PNG bytes.
 *
 * Errors (`CardRenderError.code`):
 *  - `canvas`: the drawing itself failed (the canvas addon cannot load here, a font is missing): the services fall
 *    back to the site's picture until a restart, as before;
 *  - `busy`: the queue is full (`maxQueue` waiting): the request gets a 429, nothing is drawn;
 *  - `failed`: a worker died or did not answer in `timeoutMs` (it is replaced): this one request falls back.
 * A pool whose workers die `MAX_STARTUP_FAILURES` times in a row without drawing anything (a missing worker file, a
 * crash on load) reports `canvas` from then on.
 */
export type CardDrawJob = Exclude<CardJob, { kind: 'selfcheck' }>;
export type CardSelfCheck = { ok: true } | { ok: false; error: string };

export class CardRenderError extends Error {
  constructor(
    message: string,
    readonly code: 'canvas' | 'busy' | 'failed',
  ) {
    super(message);
  }
}

export interface CardRenderer {
  /** Draws one card; rejects with a `CardRenderError`. */
  render(job: CardDrawJob): Promise<Buffer>;
  /** The startup self-check (`shareCardSelfCheck`), run where the cards are drawn. Never rejects. */
  selfCheck(): Promise<CardSelfCheck>;
  close(): Promise<void>;
}

const toBuffer = (u: Uint8Array): Buffer => (Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength));
const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0];

/** Draws on the calling thread (`CARD_WORKERS=0`, tests, scripts): what the server did before the pool. */
export class InlineCardRenderer implements CardRenderer {
  async render(job: CardDrawJob): Promise<Buffer> {
    try {
      const r = runCardJob(job);
      if (!('png' in r)) throw new Error('not a picture');
      return toBuffer(r.png);
    } catch (err) {
      throw new CardRenderError(firstLine(err), 'canvas');
    }
  }

  async selfCheck(): Promise<CardSelfCheck> {
    const r = runCardJob({ kind: 'selfcheck' });
    return 'check' in r ? r.check : { ok: false, error: 'no answer' };
  }

  async close(): Promise<void> {}
}

/** The process-wide main-thread renderer (the services' default). */
export const inlineCardRenderer = new InlineCardRenderer();

export interface CardPoolOptions {
  /** Worker threads (1..4, default 1). Each holds its own canvas and fonts (~30 MB). */
  size?: number;
  /** Jobs that may wait for a worker; past it `busy` (default 32). */
  maxQueue?: number;
  /** A draw that takes longer is abandoned and its worker replaced (default 10 s). */
  timeoutMs?: number;
  /** The worker script (tests: one that cannot start); default the card worker. */
  file?: URL;
  log?: (m: string) => void;
}

export const CARD_POOL_DEFAULTS = { size: 1, maxQueue: 32, timeoutMs: 10_000 } as const;
/** Deaths in a row, without a single answer in between, after which the pool stops trying (reports `canvas`). */
export const MAX_STARTUP_FAILURES = 3;

interface Pending {
  id: number;
  job: CardJob;
  resolve: (v: { png?: Uint8Array; check?: CardSelfCheck }) => void;
  reject: (e: CardRenderError) => void;
}

interface Slot {
  worker: Worker | null;
  busy: Pending | null;
  timer: NodeJS.Timeout | null;
}

/** Card drawing in `size` worker threads, one job at a time each, at most `maxQueue` waiting (see the file note). */
export class CardWorkerPool implements CardRenderer {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly log: (m: string) => void;
  private readonly file: URL | null;
  private seq = 0;
  private failures = 0;
  private broken: string | null = null;
  private closed = false;
  /** Draws done, refused as busy, failed (worker died or timed out), for the log and tests. */
  readonly counts = { done: 0, busy: 0, failed: 0 };

  constructor(o: CardPoolOptions = {}) {
    const size = Math.max(1, Math.min(4, Math.floor(o.size ?? CARD_POOL_DEFAULTS.size)));
    this.maxQueue = Math.max(0, Math.floor(o.maxQueue ?? CARD_POOL_DEFAULTS.maxQueue));
    this.timeoutMs = Math.max(100, o.timeoutMs ?? CARD_POOL_DEFAULTS.timeoutMs);
    this.log = o.log ?? (() => {});
    this.file = o.file ?? null;
    for (let i = 0; i < size; i++) this.slots.push({ worker: null, busy: null, timer: null });
  }

  /** Jobs waiting for a worker (not counting those being drawn). */
  get waiting(): number {
    return this.queue.length;
  }

  async render(job: CardDrawJob): Promise<Buffer> {
    if (this.queue.length >= this.maxQueue) {
      this.counts.busy++;
      throw new CardRenderError('card renderer busy', 'busy');
    }
    const r = await this.submit(job);
    return toBuffer(r.png!);
  }

  async selfCheck(): Promise<CardSelfCheck> {
    try {
      return (await this.submit({ kind: 'selfcheck' })).check ?? { ok: false, error: 'no answer' };
    } catch (err) {
      return { ok: false, error: firstLine(err) };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.queue.splice(0)) p.reject(new CardRenderError('card renderer closed', 'failed'));
    await Promise.all(
      this.slots.map(async (s) => {
        if (s.timer) clearTimeout(s.timer);
        s.busy?.reject(new CardRenderError('card renderer closed', 'failed'));
        s.busy = null;
        const w = s.worker;
        s.worker = null;
        if (w) await w.terminate().catch(() => {});
      }),
    );
  }

  private submit(job: CardJob): Promise<{ png?: Uint8Array; check?: CardSelfCheck }> {
    if (this.closed) return Promise.reject(new CardRenderError('card renderer closed', 'failed'));
    if (this.broken) return Promise.reject(new CardRenderError(this.broken, 'canvas'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.seq, job, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed) return;
    for (const s of this.slots) {
      if (s.busy || this.queue.length === 0) continue;
      if (!s.worker) {
        try {
          s.worker = this.spawn(s);
        } catch (err) {
          this.died(s, `could not start: ${firstLine(err)}`);
          continue;
        }
      }
      const p = this.queue.shift()!;
      s.busy = p;
      // a worker with a job holds the process open (a script awaiting a card); an idle one does not
      s.worker.ref();
      s.timer = setTimeout(() => this.timedOut(s), this.timeoutMs);
      s.worker.postMessage({ id: p.id, job: p.job });
    }
  }

  private spawn(s: Slot): Worker {
    const ts = import.meta.url.endsWith('.ts');
    // the build ships the worker as dist/card-worker.js next to dist/index.js; tests and tsx run the source through
    // the room workers' bootstrap, which registers tsx inside the worker thread
    const file = this.file ?? (ts ? new URL('../rooms/remote/ts-worker.mjs', import.meta.url) : new URL('./card-worker.js', import.meta.url));
    const w = new Worker(file, { workerData: ts && !this.file ? { entry: new URL('./card-worker-main.ts', import.meta.url).href } : {} });
    w.on('message', (m: { ready?: true; id?: number; ok?: boolean; png?: Uint8Array; check?: CardSelfCheck; error?: string }) => {
      if (s.worker !== w || m.ready || !s.busy || m.id !== s.busy.id) return;
      const p = s.busy;
      s.busy = null;
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
      w.unref();
      // the worker answered: it starts and draws (or reports why it cannot)
      this.failures = 0;
      if (m.ok) {
        this.counts.done++;
        p.resolve({ png: m.png, check: m.check });
      } else p.reject(new CardRenderError(m.error ?? 'drawing failed', 'canvas'));
      this.pump();
    });
    w.on('error', (err) => {
      if (s.worker === w) this.died(s, firstLine(err));
    });
    w.on('exit', (code) => {
      if (s.worker === w) this.died(s, `exit code ${code}`);
    });
    w.unref();
    return w;
  }

  private timedOut(s: Slot): void {
    const w = s.worker;
    this.died(s, `no answer in ${this.timeoutMs} ms`);
    if (w) void w.terminate().catch(() => {});
  }

  /** The slot's worker is gone (died, timed out, never started): its job fails, the next job starts a new one. */
  private died(s: Slot, why: string): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.worker = null;
    const p = s.busy;
    s.busy = null;
    if (this.closed) return;
    this.failures++;
    this.counts.failed++;
    this.log(`!!! card worker: ${why}${p ? ' (its card falls back to the site picture)' : ''}`);
    p?.reject(new CardRenderError(`card worker: ${why}`, 'failed'));
    if (this.failures >= MAX_STARTUP_FAILURES) {
      this.broken = `card workers keep failing (${why})`;
      this.log(`!!! card worker: ${this.failures} failures in a row, giving up: card images fall back to the site's picture until a restart`);
      for (const q of this.queue.splice(0)) q.reject(new CardRenderError(this.broken, 'canvas'));
      return;
    }
    // jobs still waiting get a fresh worker
    setImmediate(() => this.pump());
  }
}

/** The renderer the server runs with: `n` card workers, or the main thread for 0. */
export function createCardRenderer(n: number, log?: (m: string) => void): CardRenderer {
  return n > 0 ? new CardWorkerPool({ size: n, log }) : inlineCardRenderer;
}
