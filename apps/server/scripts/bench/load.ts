/**
 * Load test: the real app in this process (DEV_FAKE_CHAIN: free arena tickets, bots in every room)
 * and LOAD_CLIENTS real WebSocket clients in child processes (`load-client.ts`) that sign in, join
 * arenas, practice ponds, private and custom rooms, and steer at up to 30 Hz. After a warm-up it
 * measures, over LOAD_SECONDS:
 *
 * - server: tick time per thread and per room (mean / p95 / max), event-loop lag and utilisation per
 *   thread (main + every room worker), CPU per core (/proc/stat), process CPU, RSS, bytes sent;
 * - clients: bytes per client per second, and the snapshot interval they observe (p50 / p95 / p99).
 *
 *   node --import tsx scripts/bench/load.ts
 *   LOAD_CLIENTS=500 GAME_WORKERS=3 LOAD_SECONDS=60 node --import tsx scripts/bench/load.ts
 *
 * Env: LOAD_CLIENTS (100), LOAD_SECONDS (40), LOAD_WARMUP_S (15), LOAD_PROCS (one per 200 clients),
 * LOAD_MIX (arena,practice,private,custom shares; default 35,45,10,10), LOAD_OUT (JSON summary file),
 * GAME_WORKERS (as for the server; unset: the server default).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOM_DEFAULTS, DEFAULT_ARENAS } from '@elymum/shared';
import { getAddress } from 'viem';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { customBots, customWorld } from '../../src/rooms/custom';
import type { ServerLoad, ThreadLoad } from '../../src/rooms/load';
import type { ClientSpec, ClientStats } from './load-client';

const N = Number(process.env.LOAD_CLIENTS ?? 100);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 40);
const WARMUP = Number(process.env.LOAD_WARMUP_S ?? 15);
const PROCS = Number(process.env.LOAD_PROCS ?? Math.max(1, Math.ceil(N / 200)));
const MIX = (process.env.LOAD_MIX ?? '35,45,10,10').split(',').map(Number);
const here = dirname(fileURLToPath(import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'elymum-load-'));
const env: Record<string, string> = {
  NODE_ENV: 'development',
  DEV_FAKE_CHAIN: '1',
  DEV_FAKE_TOKEN: '1',
  PORT: '0',
  HOST: '127.0.0.1',
  DATA_DIR: dir,
  GAME_ACCESS: 'public',
  MAX_CONNECTIONS: String(N + 100),
  MAX_CONNECTIONS_PER_IP: String(N + 100),
};
if (process.env.GAME_WORKERS !== undefined) env.GAME_WORKERS = process.env.GAME_WORKERS;
const cfg = loadConfig(env as unknown as NodeJS.ProcessEnv);
const logs: string[] = [];
const app = await createApp(cfg, { log: (m) => logs.push(m) });
const port = await app.listen();
const url = `ws://127.0.0.1:${port}/ws`;

// the mix: arena players sign in (dev-fake chain: a free ticket per wallet and arena)
const total = MIX.reduce((a, b) => a + b, 0);
const nArena = Math.round((N * MIX[0]) / total);
const nPrivate = Math.round((N * MIX[2]) / total);
const nCustom = Math.round((N * MIX[3]) / total);
const nPractice = N - nArena - nPrivate - nCustom;
const arenaIds = DEFAULT_ARENAS.map((_, i) => i + 1);
await app.rooms.ensureArenaRooms();

const specs: ClientSpec[] = [];
for (let i = 0; i < nArena; i++) {
  const wallet = getAddress(`0x${(i + 1).toString(16).padStart(8, '0')}${'ab'.repeat(16)}`);
  specs.push({ room: `arena:${arenaIds[i % arenaIds.length]}`, token: app.auth.issueToken(wallet) });
}
for (let i = 0; i < nPractice; i++) specs.push({ room: 'practice' });
// private rooms of up to 12 people, custom rooms (the default config: 6 bots, auto map) of up to 10
for (let i = 0; i < nPrivate; i += 12) {
  const room = app.rooms.privateRoom(null)!;
  for (let k = 0; k < Math.min(12, nPrivate - i); k++) specs.push({ room: `private:${room.opts.code}` });
}
for (let i = 0; i < nCustom; i += 10) {
  const code = app.rooms.newPrivateCode();
  const c = { ...CUSTOM_DEFAULTS, name: `Load ${i / 10 + 1}`, maxPlayers: 12 };
  app.rooms.createCustomRoom(code, {
    name: c.name,
    maxPlayers: c.maxPlayers,
    bots: customBots(c),
    world: customWorld(c),
    map: { scale: app.rooms.customMapScale(), shape: (side: number) => customWorld(c, side), config: c },
    powerUps: c.powerUps,
    custom: { ...c, creator: '0x0000000000000000000000000000000000000001', createdAt: Date.now(), endsAt: Date.now() + 3600_000 },
  });
  for (let k = 0; k < Math.min(10, nCustom - i); k++) specs.push({ room: `private:${code}` });
}
// interleave so every child process carries the same mix
const procs: ChildProcess[] = [];
const per: ClientSpec[][] = Array.from({ length: PROCS }, () => []);
specs.forEach((s, i) => per[i % PROCS].push(s));
for (const list of per) {
  const p = fork(join(here, 'load-client.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  p.send({ t: 'start', url, specs: list });
  procs.push(p);
}

function askStats(): Promise<ClientStats[]> {
  return Promise.all(
    procs.map(
      (p) =>
        new Promise<ClientStats>((resolve) => {
          const on = (m: { t: string; stats: ClientStats }) => {
            if (m.t !== 'stats') return;
            p.off('message', on);
            resolve(m.stats);
          };
          p.on('message', on);
          p.send({ t: 'stats' });
        }),
    ),
  );
}

/** /proc/stat: busy and total jiffies per core. */
function coreTimes(): { busy: number; total: number }[] {
  const out: { busy: number; total: number }[] = [];
  for (const line of readFileSync('/proc/stat', 'utf8').split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].split(/\s+/).map(Number);
    const idle = v[3] + (v[4] ?? 0);
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    out.push({ busy: total - idle, total });
  }
  return out;
}

/** CPU seconds (user + system) of a child process. */
function procCpu(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connectS = (N * 8) / 1000 / PROCS + 2;
console.log(`load: ${N} clients (${nArena} arena, ${nPractice} practice, ${nPrivate} private, ${nCustom} custom) in ${PROCS} process(es); workers ${process.env.GAME_WORKERS ?? 'default'}; connecting ${connectS.toFixed(0)} s, warm-up ${WARMUP} s, measuring ${SECONDS} s`);
await sleep((connectS + WARMUP) * 1000);
await askStats();
app.rooms.loadStats();
const cores0 = coreTimes();
const cpu0 = process.cpuUsage();
const child0 = procs.map((p) => procCpu(p.pid!));
const t0 = performance.now();
let rssMax = 0;
const samples: ServerLoad[] = [];
const steps = Math.max(1, Math.round(SECONDS / 5));
for (let i = 0; i < steps; i++) {
  await sleep((SECONDS * 1000) / steps);
  const s = app.rooms.loadStats({ rooms: true });
  samples.push(s);
  rssMax = Math.max(rssMax, s.rssMb);
  const th = [s.main, ...s.threads];
  console.log(
    `  t+${((performance.now() - t0) / 1000).toFixed(0)}s rss ${s.rssMb} MB · out ${(s.sentBytesPerSec / 1e6).toFixed(2)} MB/s · ` +
      th.map((t) => `${t.id}: ${t.rooms}r ${t.humans}h tick p95 ${t.tick.p95Ms} max ${t.tick.maxMs} elu ${t.elu} lag99 ${t.lagP99Ms}`).join(' | '),
  );
}
const secs = (performance.now() - t0) / 1000;
const cores1 = coreTimes();
const cpu1 = process.cpuUsage(cpu0);
const childCpu = procs.map((p, i) => procCpu(p.pid!) - child0[i]);
const stats = await askStats();

// clients
const hist = new Array(1000).fill(0);
let bytesIn = 0;
let open = 0;
let playing = 0;
let joins = 0;
const errors: Record<string, number> = {};
for (const s of stats) {
  s.hist.forEach((v, i) => (hist[i] += v));
  bytesIn += s.bytesIn;
  open += s.open;
  playing += s.playing;
  joins += s.joins;
  for (const [k, v] of Object.entries(s.errors)) errors[k] = (errors[k] ?? 0) + v;
}
const count = hist.reduce((a, b) => a + b, 0);
const pct = (q: number) => {
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= count * q) return i;
  }
  return hist.length - 1;
};
const late = hist.slice(50).reduce((a, b) => a + b, 0);

// server: worst sample per thread
const worst = (pick: (t: ThreadLoad) => number) => Math.max(...samples.flatMap((s) => [s.main, ...s.threads].map(pick)));
const perThread = new Map<string, { tickP95: number; tickMax: number; tickMean: number; elu: number; lagP99: number; lagMax: number; rooms: number; humans: number; n: number }>();
for (const s of samples) {
  for (const t of [s.main, ...s.threads]) {
    const k = String(t.id);
    const a = perThread.get(k) ?? { tickP95: 0, tickMax: 0, tickMean: 0, elu: 0, lagP99: 0, lagMax: 0, rooms: 0, humans: 0, n: 0 };
    a.tickP95 = Math.max(a.tickP95, t.tick.p95Ms);
    a.tickMax = Math.max(a.tickMax, t.tick.maxMs);
    a.tickMean += t.tick.meanMs;
    a.elu += t.elu;
    a.lagP99 = Math.max(a.lagP99, t.lagP99Ms);
    a.lagMax = Math.max(a.lagMax, t.lagMaxMs);
    a.rooms = t.rooms;
    a.humans = t.humans;
    a.n++;
    perThread.set(k, a);
  }
}
const roomTicks = samples.at(-1)!.main.roomLoads ?? [];
for (const t of samples.at(-1)!.threads) roomTicks.push(...(t.roomLoads ?? []));
const coreUse = cores1.map((c, i) => Math.round(((c.busy - cores0[i].busy) / Math.max(1, c.total - cores0[i].total)) * 1000) / 10);
const serverCpuS = (cpu1.user + cpu1.system) / 1e6;
const summary = {
  clients: N,
  workers: samples.at(-1)!.workers,
  mode: samples.at(-1)!.mode,
  cpus: cpus().length,
  secs: Math.round(secs),
  rooms: roomTicks.length,
  open,
  playing,
  joins,
  errors,
  server: {
    cpuCores: Math.round((serverCpuS / secs) * 100) / 100,
    rssMaxMb: rssMax,
    outMBps: Math.round((samples.reduce((a, s) => a + s.sentBytesPerSec, 0) / samples.length / 1e6) * 100) / 100,
    outMsgsPerSec: Math.round(samples.reduce((a, s) => a + s.sentMsgsPerSec, 0) / samples.length),
    tickP95Worst: worst((t) => t.tick.p95Ms),
    tickMaxWorst: worst((t) => t.tick.maxMs),
    lagP99Worst: worst((t) => t.lagP99Ms),
    threads: Object.fromEntries([...perThread].map(([k, a]) => [k, { rooms: a.rooms, humans: a.humans, tickMeanMs: Math.round((a.tickMean / a.n) * 100) / 100, tickP95Ms: a.tickP95, tickMaxMs: a.tickMax, elu: Math.round((a.elu / a.n) * 1000) / 1000, lagP99Ms: a.lagP99, lagMaxMs: a.lagMax }])),
    roomTickP95Worst: Math.max(0, ...roomTicks.map((r) => r.tick.p95Ms)),
    roomTickMeanAvg: Math.round((roomTicks.reduce((a, r) => a + r.tick.meanMs, 0) / Math.max(1, roomTicks.length)) * 100) / 100,
  },
  clientsCpuCores: Math.round((childCpu.reduce((a, b) => a + b, 0) / secs) * 100) / 100,
  coreUsePct: coreUse,
  perClient: {
    bytesPerSec: Math.round(bytesIn / secs / Math.max(1, open)),
    snapshotIntervalMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: hist.reduce((m: number, v: number, i: number) => (v > 0 ? i : m), 0) },
    lateOver50msPct: Math.round((late / Math.max(1, count)) * 10000) / 100,
  },
};
console.log(JSON.stringify(summary, null, 2));
if (process.env.LOAD_OUT) writeFileSync(process.env.LOAD_OUT, JSON.stringify(summary, null, 2));
const bad = logs.filter((l) => /!!!|failed|Error/.test(l));
if (bad.length > 0) {
  console.log(`alarms/errors in the server log: ${bad.length}`);
  for (const l of bad.slice(0, 10)) console.log(`  ${l}`);
}
for (const p of procs) p.send({ t: 'stop' });
await sleep(500);
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
