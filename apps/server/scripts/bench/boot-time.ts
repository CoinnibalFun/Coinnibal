/**
 * Boot time of the production build (`dist/index.js`, what the container runs): start the process with
 * NODE_ENV=production and GAME_WORKERS=3 on an empty DATA_DIR (and again on the same, now populated one), and time
 * until `/api/health` answers. A deploy's downtime is this plus the old container's shutdown (see drills.ts) plus
 * Docker's container swap. No chain (practice only): the RPC probe at boot runs in the background either way.
 *
 *   pnpm -F @coinnibal/server build && node --import tsx scripts/bench/boot-time.ts      (from apps/server)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './hardhat-arena';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
const dir = mkdtempSync(join(tmpdir(), 'elymum-boot-'));
const out: Record<string, number> = {};
for (const run of ['first boot (empty DATA_DIR)', 'second boot (same DATA_DIR)', 'third boot']) {
  const port = await freePort();
  const t0 = Date.now();
  const child = spawn(process.execPath, [dist], {
    env: { ...process.env, NODE_ENV: 'production', DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', GAME_WORKERS: '3', PUBLIC_URL: 'https://elymum.io', AUTH_SECRET: 'boot-test-secret-0123456789abcdef0123456789' },
    stdio: 'ignore',
  });
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > 60_000) throw new Error('no health in 60 s');
    await new Promise((r) => setTimeout(r, 50));
  }
  out[`${run} ms`] = Date.now() - t0;
  const s0 = Date.now();
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  out[`${run} shutdown ms`] = Date.now() - s0;
}
console.log(JSON.stringify(out, null, 2));
rmSync(dir, { recursive: true, force: true });
