/**
 * The game server for the failure drills (`drills.ts`), started as a child process with the production env shape.
 * It is `src/index.ts` without the public-URL assertion, plus two IPC hooks for the drills:
 * `{ t: 'crash', index }` (a room worker dies: `WorkerPool.crash`, as in test/workers.test.ts) and
 * `{ t: 'stats' }` (answers the journal's pending items and live stakes). SIGTERM runs the same shutdown as
 * `src/index.ts`: `app.close()` (rooms settle their stakers into the journal), then exit.
 */
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { installProcessGuards } from '../../src/process-guards';

const t0 = Date.now();
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const cfg = loadConfig();
const app = await createApp(cfg, { log });
const port = await app.listen();
log(`drill-server ready on ${port} after ${Date.now() - t0} ms`);
process.send?.({ t: 'ready', port, bootMs: Date.now() - t0 });

let stopping = false;
const shutdown = async (signal: string, code = 0) => {
  if (stopping) return;
  stopping = true;
  const s0 = Date.now();
  log(`${signal} received — cashing out stake players and saving state…`);
  setTimeout(() => process.exit(code), 15_000).unref();
  await app.close().catch((err) => log(`shutdown: close failed: ${String((err as Error)?.stack ?? err)}`));
  const pending = app.journal.pending.filter((p) => p.kind === 'settle').length;
  log(`shutdown done in ${Date.now() - s0} ms; ${pending} settlement(s) still pending in the journal (sent by the next start)`);
  process.send?.({ t: 'closed', ms: Date.now() - s0, pending });
  setTimeout(() => process.exit(code), 200).unref();
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
installProcessGuards(log, (why) => void shutdown(why, 1));

process.on('message', (m: { t: string; index?: number; scaling?: Record<string, unknown> }) => {
  if (m.t === 'load') {
    // the stress harness (`stress.ts`): per-thread load, the room directory and the scaler's view
    const mem = process.memoryUsage();
    process.send?.({
      t: 'load',
      load: app.rooms.loadStats({ rooms: true }),
      rooms: app.rooms.list(),
      scaling: app.rooms.scaler.view(),
      shed: { level: app.shedder.level, refused: { ...app.shedder.refused } },
      live: app.journal.live().length,
      heapMb: Math.round(mem.heapUsed / 1e6),
      extMb: Math.round((mem.external + mem.arrayBuffers) / 1e6),
    });
  } else if (m.t === 'private') {
    process.send?.({ t: 'private', code: app.rooms.privateRoom(null)?.opts.code ?? null });
  } else if (m.t === 'scaling') {
    app.rooms.scaler.store.update(m.scaling ?? {});
    process.send?.({ t: 'scaling', settings: app.rooms.scaler.settings });
  } else if (m.t === 'crash') {
    app.rooms.pool?.crash(m.index ?? 0);
    process.send?.({ t: 'crashed', index: m.index ?? 0 });
  } else if (m.t === 'stats') {
    process.send?.({
      t: 'stats',
      pending: app.journal.pending.map((p) => ({ key: p.key, kind: p.kind, reason: p.kind === 'settle' ? p.reason : undefined, payout: p.kind === 'settle' ? p.payout : p.amount })),
      live: app.journal.live().map((l) => ({ session: l.session, value: l.value, roomId: l.roomId })),
      writeFailing: app.journal.writeFailing,
    });
  }
});
