/**
 * Abuse / DDoS test: the real app (DEV_FAKE_CHAIN, room workers, the load shedder on) with FLOOD_PLAYERS real
 * players in arenas and practice ponds (`load-client.ts`), then one attack after another from a separate process
 * (`flood-attacker.ts`): a storm of sockets that never say hello, a message flood of garbage, an HTTP flood of the
 * public endpoints, slowloris. For each phase it prints what the live players saw (snapshot interval p95) and the
 * server's worst tick p95 and main-thread lag, plus what the limits refused. The attackers spoof X-Forwarded-For
 * (the server trusts one hop here, like Caddy's): each attack comes from thousands of addresses.
 *
 *   node --import tsx scripts/bench/flood.ts
 *   FLOOD_PLAYERS=120 FLOOD_SECONDS=20 GAME_WORKERS=3 node --import tsx scripts/bench/flood.ts
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ARENAS } from '@elymum/shared';
import { getAddress } from 'viem';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { ClientSpec, ClientStats } from './load-client';

const N = Number(process.env.FLOOD_PLAYERS ?? 60);
const SECONDS = Number(process.env.FLOOD_SECONDS ?? 15);
const here = dirname(fileURLToPath(import.meta.url));
process.env.TRUST_PROXY = '1';
const env: Record<string, string> = {
  NODE_ENV: 'development',
  DEV_FAKE_CHAIN: '1',
  DEV_FAKE_TOKEN: '1',
  PORT: '0',
  HOST: '127.0.0.1',
  DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-flood-')),
  GAME_ACCESS: 'public',
  LOAD_SHED: '1',
  GAME_WORKERS: process.env.GAME_WORKERS ?? '2',
  MAX_CONNECTIONS: String(N + 400),
  // the real players all come from 127.0.0.1 here
  MAX_CONNECTIONS_PER_IP: String(N + 10),
  MAX_CONNECTIONS_PER_SUBNET: String(N + 10),
};
const cfg = loadConfig(env as unknown as NodeJS.ProcessEnv);
const app = await createApp(cfg, { log: (m) => m.startsWith('!!!') && console.log(`  [server] ${m}`) });
const port = await app.listen();
const url = `ws://127.0.0.1:${port}/ws`;
await app.rooms.ensureArenaRooms();

const specs: ClientSpec[] = [];
for (let i = 0; i < N; i++) {
  if (i % 2 === 0) {
    const wallet = getAddress(`0x${(i + 1).toString(16).padStart(8, '0')}${'cd'.repeat(16)}`);
    specs.push({ room: `arena:${(i % DEFAULT_ARENAS.length) + 1}`, token: app.auth.issueToken(wallet) });
  } else specs.push({ room: 'practice' });
}
const players = fork(join(here, 'load-client.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
players.send({ t: 'start', url, specs });
const attacker: ChildProcess = fork(join(here, 'flood-attacker.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ask = <T>(p: ChildProcess, msg: object, t: string): Promise<T> =>
  new Promise((resolve) => {
    const on = (m: { t: string }) => {
      if (m.t !== t) return;
      p.off('message', on);
      resolve(m as T);
    };
    p.on('message', on);
    p.send(msg);
  });
const p95 = (hist: number[]) => {
  const n = hist.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < hist.length; i++) if ((acc += hist[i]) >= n * 0.95) return i;
  return hist.length - 1;
};

interface Row {
  phase: string;
  playersOpen: number;
  snapshotP95Ms: number;
  worstTickP95Ms: number;
  mainLagP99Ms: number;
  level: string;
  attack: unknown;
}
const rows: Row[] = [];

async function phase(name: string, kind: string | null): Promise<void> {
  await ask(players, { t: 'stats' }, 'stats');
  app.rooms.loadStats();
  const before = { ...app.gateway.dropped, ...app.shedder.refused };
  let worstTick = 0;
  let worstLag = 0;
  let level = 'ok';
  const watch = setInterval(() => {
    const s = app.rooms.loadStats();
    worstTick = Math.max(worstTick, ...[s.main, ...s.threads].map((t) => t.tick.p95Ms));
    worstLag = Math.max(worstLag, s.main.lagP99Ms);
    if (app.shedder.level !== 'ok') level = app.shedder.level;
  }, 2_000);
  const attack = kind ? ask<{ stats: unknown }>(attacker, { t: 'run', kind, url, seconds: SECONDS }, 'done') : sleep(SECONDS * 1000);
  const result = await attack;
  clearInterval(watch);
  const st = (await ask<{ stats: ClientStats }>(players, { t: 'stats' }, 'stats')).stats;
  const after = { ...app.gateway.dropped, ...app.shedder.refused };
  const refused = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - (before as Record<string, number>)[k]]).filter(([, v]) => (v as number) > 0));
  rows.push({ phase: name, playersOpen: st.open, snapshotP95Ms: p95(st.hist), worstTickP95Ms: worstTick, mainLagP99Ms: worstLag, level, attack: kind ? { ...(result as { stats: object }).stats, serverRefused: refused } : null });
  console.log(JSON.stringify(rows.at(-1)));
  await sleep(3_000);
}

console.log(`flood: ${N} players (half arena, half practice), ${cfg.gameWorkers} room workers, ${SECONDS} s per phase`);
await sleep(8_000);
await phase('baseline', null);
await phase('idle sockets (never hello)', 'idle-sockets');
await phase('message flood (garbage)', 'message-flood');
await phase('HTTP flood (public endpoints)', 'http-flood');
await phase('slowloris', 'slowloris');
await phase('after', null);

console.log('\n| Phase | Players connected | Their snapshot interval p95 | Worst game thread tick p95 | Main lag p99 | Shedder |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.phase} | ${r.playersOpen}/${N} | ${r.snapshotP95Ms} ms | ${r.worstTickP95Ms} ms | ${r.mainLagP99Ms} ms | ${r.level} |`);
players.send({ t: 'stop' });
attacker.kill();
players.kill();
await app.close();
process.exit(0);
