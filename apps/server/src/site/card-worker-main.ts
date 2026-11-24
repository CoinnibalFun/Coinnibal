/**
 * Entry of a card worker thread (`card-renderer.ts`): draws share and Appetizer cards with @napi-rs/canvas, one job
 * at a time, so a 40-75 ms draw never stalls the main thread (which relays every player's snapshots).
 * Built as `dist/card-worker.js`; run from the TypeScript source (tests, `tsx`) with tsx's loader.
 */
import { parentPort } from 'node:worker_threads';
import { runCardJob, type CardJob } from './card-jobs';

if (!parentPort) throw new Error('card worker: no parent port');
const port = parentPort;
port.on('message', (m: { id: number; job: CardJob }) => {
  try {
    const r = runCardJob(m.job);
    if ('png' in r) {
      // a copy of its own (the canvas may hand out a view into a larger buffer), transferred rather than cloned
      const png = new Uint8Array(r.png);
      port.postMessage({ id: m.id, ok: true, png }, [png.buffer]);
    } else port.postMessage({ id: m.id, ok: true, check: r.check });
  } catch (err) {
    port.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err).split('\n')[0] });
  }
});
port.postMessage({ ready: true });
