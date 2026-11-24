/**
 * The cost of a journal write on the main thread at a given load: JOURNAL_LIVE live tickets over JOURNAL_ROOMS arena
 * instances (every instance rewrites the whole journal at most once a second while values change, and at every join
 * and death), JOURNAL_RUNS commits. Prints the median and p99 of one commit (stringify + write + rename, synchronous)
 * and what JOURNAL_ROOMS commits a second cost the main thread. JOURNAL_DIR: where to write (default: a temp dir; use
 * the data volume's disk to measure the real one).
 *
 *   node --import tsx scripts/bench/journal-bench.ts             (from apps/server)
 *   JOURNAL_LIVE=1000 JOURNAL_ROOMS=20 JOURNAL_DIR=/data/bench node --import tsx scripts/bench/journal-bench.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, type LiveStake } from '../../src/stake/journal';

const LIVE = Number(process.env.JOURNAL_LIVE ?? 1000);
const ROOMS = Number(process.env.JOURNAL_ROOMS ?? 20);
const RUNS = Number(process.env.JOURNAL_RUNS ?? 400);
const base = process.env.JOURNAL_DIR ?? tmpdir();
const dir = mkdtempSync(join(base, 'coinnibal-journal-bench-'));
const j = new Journal(join(dir, 'journal.json'));
const per = Math.ceil(LIVE / ROOMS);
const live = (room: number): LiveStake[] =>
  Array.from({ length: per }, (_, i) => ({
    roomId: `arena-1-${room}`,
    session: `1:0x${(room * 1000 + i).toString(16).padStart(40, '0')}:${room * 1000 + i}`,
    sessionId: room * 1000 + i,
    player: `0x${(room * 1000 + i).toString(16).padStart(40, '0')}`,
    arenaId: 1,
    value: 1_000_000 + i,
    entryFee: 1_000_000,
    score: 100 + i,
    kills: i % 5,
  }));
for (let r = 1; r <= ROOMS; r++) j.commit({ roomId: `arena-1-${r}`, live: live(r), loot: { roomId: `arena-1-${r}`, arenaId: 1, items: Array.from({ length: 30 }, (_, k) => ({ x: k * 10, y: k * 20, value: 5000 })) } });
const ms: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const r = (i % ROOMS) + 1;
  const t0 = performance.now();
  j.commit({ roomId: `arena-1-${r}`, live: live(r) });
  ms.push(performance.now() - t0);
}
ms.sort((a, b) => a - b);
const med = ms[Math.floor(RUNS / 2)];
const p99 = ms[Math.floor(RUNS * 0.99)];
console.log(`${LIVE} live tickets in ${ROOMS} instances: one commit median ${med.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${ms.at(-1)!.toFixed(2)} ms; ${ROOMS} commits/s ≈ ${((med * ROOMS) / 10).toFixed(1)} % of the main thread`);
rmSync(dir, { recursive: true, force: true });
