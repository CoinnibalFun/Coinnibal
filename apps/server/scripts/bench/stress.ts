/**
 * Stress and auto-scaling test against a LOCAL game server (never the live site). The server runs in a child
 * process (`drill-server.ts`: `src/index.ts` plus IPC hooks) with the production shape where it matters (room workers,
 * the load shedder, `MAX_CONNECTIONS`, one trusted proxy hop so every client has its own address) on the dev fake
 * chain (free arena tickets per wallet, no transaction). The players are WebSocket clients in child processes
 * (`stress-client.ts`) that behave like the web client; an HTTP client hits the site's APIs meanwhile.
 *
 * Phases (STRESS_PHASES, in order; default every one):
 *
 * - `ramp`    100 → 500 → 1000 → 1500 players (STRESS_STAGES), mixed arena / practice / test arena / private
 *             (STRESS_MIX), each stage held STRESS_STAGE_S seconds: tick time per worker and per room, event-loop lag
 *             and utilisation per thread, GC pauses, CPU, RSS and heap, bytes per client, snapshot interval, ping
 *             round trip, join latency, HTTP latency per endpoint;
 * - `storm`   STRESS_STORM players join arena 1 within 3 s at the opening of a round: instances opened (none over
 *             its seats), spread over the workers, join latency;
 * - `slow`    STRESS_SLOW players stop reading their socket: the server must close them, memory must stay flat;
 * - `drop`    half of the players disconnect at once;
 * - `crash`   room worker 0 dies under load: it restarts, its rooms come back, the other workers play on;
 * - `restart` the server is stopped (SIGTERM, as a deploy) and started again on the same data: every client
 *             reconnects with the web client's backoff (a reconnect storm); downtime per client;
 * - `drain`   (short scaler windows) the arena's demand falls: extra instances drain and close, nobody is evicted;
 * - `soak`    STRESS_SOAK_MIN minutes (10) with churn (a tenth of the players replaced every 10 s): heap and RSS per minute;
 * - `limits`  20 sockets from one address, then guests past `MAX_CONNECTIONS`: clean refusals, no crash.
 *
 * After every phase the directory is checked: unique room ids, no room over its seats, `/api/rooms` matching the
 * directory, every arena instance on the same round, the bell on time (the clients' `roundOver` against the round's
 * end).
 *
 *   node --import tsx scripts/bench/stress.ts                       (from apps/server)
 *   STRESS_STAGES=100,500 STRESS_PHASES=ramp,storm GAME_WORKERS=3 node --import tsx scripts/bench/stress.ts
 *
 * Env: STRESS_PHASES, STRESS_STAGES (100,500,1000,1500), STRESS_STAGE_S (40), STRESS_MIX (arena,practice,test,
 * private shares; 40,45,10,5), STRESS_STORM (500), STRESS_SLOW (50), STRESS_HTTP_RPS (40), STRESS_ROUND_S (120), STRESS_CLOSE_S (joins close this long before the bell; 20),
 * STRESS_PROCS (client processes; one per 300 players, at least 2), STRESS_OUT (JSON report), STRESS_LOG (the server's log, appended to this file), STRESS_SHED (the load shedder, 1; 0 on a shared machine for the scaling phases), STRESS_PROF (a directory: the server writes a CPU profile per thread there), GAME_WORKERS (3),
 * MAX_CONNECTIONS (1500), PRACTICE_CAPACITY, ARENA_INSTANCE_CAP.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ARENAS, type ArenaScalingView, type RoomInfo } from '@coinnibal/shared';
import { getAddress } from 'viem';
import WebSocket from 'ws';
import { Auth } from '../../src/auth';
import type { ServerLoad, ThreadLoad } from '../../src/rooms/load';
import { freePort } from './hardhat-arena';
import type { Hist, StressSpec, StressStats } from './stress-client';

const here = dirname(fileURLToPath(import.meta.url));
const PHASES = (process.env.STRESS_PHASES ?? 'ramp,storm,slow,drop,crash,restart,drain,limits').split(',');
const STAGES = (process.env.STRESS_STAGES ?? '100,500,1000,1500').split(',').map(Number);
const STAGE_S = Number(process.env.STRESS_STAGE_S ?? 40);
const MIX = (process.env.STRESS_MIX ?? '40,45,10,5').split(',').map(Number);
const STORM = Number(process.env.STRESS_STORM ?? 500);
const SLOW = Number(process.env.STRESS_SLOW ?? 50);
const HTTP_RPS = Number(process.env.STRESS_HTTP_RPS ?? 40);
const ROUND_S = Number(process.env.STRESS_ROUND_S ?? 120);
const CLOSE_S = Number(process.env.STRESS_CLOSE_S ?? 20);
const WORKERS = process.env.GAME_WORKERS ?? '3';
const MAX_CONN = Number(process.env.MAX_CONNECTIONS ?? 1500);
const PROCS = Number(process.env.STRESS_PROCS ?? Math.max(2, Math.ceil(Math.max(...STAGES, STORM) / 300)));
const SECRET = 'stress-secret-0123456789abcdef0123456789abcdef';
const arenaIds = DEFAULT_ARENAS.map((a) => a.id);

const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const auth = new Auth(Buffer.from(SECRET, 'utf8'));
const report: Record<string, unknown> = { cpus: cpus().length, workers: Number(WORKERS), maxConnections: MAX_CONN, roundS: ROUND_S, phases: {} };
const phases = report.phases as Record<string, unknown>;
const problems: string[] = [];
const problem = (s: string) => {
  problems.push(s);
  say(`PROBLEM: ${s}`);
};

/* ------------------------------------------------------------ server */

const dataDir = mkdtempSync(join(tmpdir(), 'coinnibal-stress-'));
mkdirSync(join(dataDir, 'site'), { recursive: true });
// the test arenas (testnet only, bots when empty) are on, as on the live testnet
writeFileSync(join(dataDir, 'site', 'test-arenas.json'), JSON.stringify({ enabled: true, bots: 10, difficulty: 'mixed' }));
let port = 0;
let server: ChildProcess | null = null;
const serverLog: string[] = [];

async function startServer(): Promise<number> {
  port = port || (await freePort());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'development',
    DEV_FAKE_CHAIN: '1',
    DEV_FAKE_TOKEN: '1',
    DATA_DIR: dataDir,
    AUTH_SECRET: SECRET,
    GAME_ACCESS: 'public',
    GAME_WORKERS: WORKERS,
    HOST: '127.0.0.1',
    PORT: String(port),
    TRUST_PROXY: '1',
    TRUST_PROXY_HOPS: '1',
    LOAD_SHED: process.env.STRESS_SHED ?? '1',
    MAX_CONNECTIONS: String(MAX_CONN),
    ROUND_SECONDS: String(ROUND_S),
    ROUND_JOIN_CLOSE_SECONDS: String(CLOSE_S),
    PUBLIC_URL: 'http://127.0.0.1',
  };
  const t0 = Date.now();
  const child = fork(join(here, 'drill-server.ts'), [], { execArgv: ['--import', 'tsx', '--import', join(here, 'tick-probe.ts'), ...(process.env.STRESS_PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.STRESS_PROF}`] : [])], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const onLine = (b: Buffer) => {
    for (const l of b.toString().split('\n')) {
      if (!l.trim()) continue;
      serverLog.push(l);
      if (process.env.STRESS_LOG) appendFileSync(process.env.STRESS_LOG, `${l}\n`);
    }
  };
  child.stdout!.on('data', onLine);
  child.stderr!.on('data', onLine);
  server = child;
  let up = false;
  await new Promise<void>((resolve, reject) => {
    child.on('message', (m: { t: string }) => {
      if (m.t !== 'ready') return;
      up = true;
      resolve();
    });
    child.on('exit', (code, signal) => {
      if (!up) reject(new Error(`server exited ${code ?? signal} during start`));
      else if (!stopping) {
        problem(`the server exited by itself (${code ?? signal}); last lines: ${serverLog.slice(-8).join(' | ')}`);
        server = null;
      }
    });
  });
  say(`server up on :${port} in ${Date.now() - t0} ms (workers ${WORKERS})`);
  return port;
}

let stopping = false;
async function stopServer(): Promise<number> {
  const s = server!;
  stopping = true;
  const t0 = Date.now();
  const done = new Promise<void>((r) => s.on('exit', () => r()));
  s.kill('SIGTERM');
  await done;
  server = null;
  stopping = false;
  return Date.now() - t0;
}

interface LoadReply {
  load: ServerLoad;
  rooms: RoomInfo[];
  scaling: ArenaScalingView;
  shed: { level: string; refused: { busy: number; critical: number } };
  live: number;
  heapMb: number;
  extMb: number;
}

function ask<T>(t: string, extra: Record<string, unknown> = {}): Promise<T> {
  const s = server;
  if (!s || !s.connected) return Promise.reject(new Error('the server is not running'));
  return new Promise((resolve) => {
    const on = (m: { t: string }) => {
      if (m.t !== t) return;
      s.off('message', on);
      resolve(m as T);
    };
    s.on('message', on);
    s.send({ t, ...extra });
  });
}
const load = () => ask<LoadReply>('load');

/** CPU seconds (user + system) of a process, every thread. */
function procCpu(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return 0;
  }
}

/** CPU seconds per thread of a process (tid → seconds); the main thread's tid is the pid. */
function threadCpu(pid: number): Map<number, number> {
  const out = new Map<number, number>();
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const f = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8').split(') ')[1].split(' ');
        out.set(Number(tid), (Number(f[11]) + Number(f[12])) / 100);
      } catch {
        /* the thread ended */
      }
    }
  } catch {
    /* no /proc */
  }
  return out;
}

/** The busiest threads over a window (CPU cores each): `main`, then the others by use (the room workers lead). */
function threadUse(pid: number, before: Map<number, number>, secs: number): Record<string, number> {
  const after = threadCpu(pid);
  const rows = [...after].map(([tid, s]) => [tid, (s - (before.get(tid) ?? 0)) / secs] as const);
  const out: Record<string, number> = {};
  const main = rows.find(([tid]) => tid === pid);
  if (main) out.main = Math.round(main[1] * 100) / 100;
  rows
    .filter(([tid]) => tid !== pid)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(WORKERS) + 2)
    .forEach(([tid, c], i) => (out[`t${i + 1}:${tid}`] = Math.round(c * 100) / 100));
  return out;
}

/* ------------------------------------------------------------ clients */

const procs: ChildProcess[] = [];
/** Every bell a client saw (Unix ms). */
const bellsSeen: number[] = [];
let next = 0;
const url = () => `ws://127.0.0.1:${port}/ws`;
const ipOf = (i: number) => `10.${(i >> 8) & 255}.${i & 255}.7`;
const walletOf = (i: number) => getAddress(`0x${(i + 1).toString(16).padStart(8, '0')}${'5e'.repeat(16)}`);

function spawnClients(): void {
  for (let i = 0; i < PROCS; i++) {
    const p = fork(join(here, 'stress-client.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    procs.push(p);
  }
}

/** Private rooms are played by groups of friends: PRIVATE_GROUP players per code. */
const PRIVATE_GROUP = 8;
let privateCode: string | null = null;
let privateLeft = 0;
async function privateTarget(): Promise<string> {
  if (!privateCode || privateLeft <= 0) {
    privateCode = (await ask<{ code: string | null }>('private')).code;
    privateLeft = PRIVATE_GROUP;
  }
  privateLeft--;
  return privateCode ? `private:${privateCode}` : 'practice';
}

function spec(kind: 'arena' | 'practice' | 'test' | 'private' | 'idle', arenaId = arenaIds[next % arenaIds.length]): StressSpec {
  const i = next++;
  const ip = ipOf(i);
  if (kind === 'arena') return { room: `arena:${arenaId}`, token: auth.issueToken(walletOf(i)), ip };
  if (kind === 'test') return { room: `arena:${arenaId}:test`, token: auth.issueToken(walletOf(i)), ip };
  if (kind === 'private') return { room: 'private:NEW', ip };
  if (kind === 'idle') return { room: 'practice', ip, idle: true };
  return { room: 'practice', ip };
}

function addClients(specs: StressSpec[], spreadMs: number): void {
  const per: StressSpec[][] = procs.map(() => []);
  specs.forEach((s, i) => per[i % procs.length].push(s));
  procs.forEach((p, i) => per[i].length > 0 && p.send({ t: 'add', url: url(), specs: per[i], spreadMs }));
}

async function mixSpecs(n: number): Promise<StressSpec[]> {
  const total = MIX.reduce((a, b) => a + b, 0);
  const out: StressSpec[] = [];
  const kinds = ['arena', 'practice', 'test', 'private'] as const;
  for (let i = 0; i < n; i++) {
    // a deterministic interleave with the mix's shares
    let r = ((i * 7919) % total) + 0.5;
    let k = 0;
    while (r > MIX[k]) r -= MIX[k++];
    const sp = spec(kinds[k]);
    if (kinds[k] === 'private') sp.room = await privateTarget();
    out.push(sp);
  }
  return out;
}

async function clientStats(): Promise<StressStats[]> {
  const list = await Promise.all(
    procs.map(
      (p) =>
        new Promise<StressStats>((resolve) => {
          const on = (m: { t: string; stats: StressStats }) => {
            if (m.t !== 'stats') return;
            p.off('message', on);
            resolve(m.stats);
          };
          p.on('message', on);
          p.send({ t: 'stats' });
        }),
    ),
  );
  for (const s of list) for (const b of s.bells) if (!bellsSeen.some((x) => Math.abs(x - b) < 1000)) bellsSeen.push(b);
  return list;
}

function merge(list: StressStats[]) {
  const sum = (h: (s: StressStats) => Hist) => list.reduce((acc, s) => (h(s).forEach((v, i) => (acc[i] = (acc[i] ?? 0) + v)), acc), [] as number[]);
  const add = (pick: (s: StressStats) => Record<string, number>) => {
    const o: Record<string, number> = {};
    for (const s of list) for (const [k, v] of Object.entries(pick(s))) o[k] = (o[k] ?? 0) + v;
    return o;
  };
  const secs = Math.max(0.001, list[0]?.secs ?? 1);
  const open = list.reduce((a, s) => a + s.open, 0);
  return {
    clients: list.reduce((a, s) => a + s.clients, 0),
    open,
    playing: list.reduce((a, s) => a + s.playing, 0),
    joins: list.reduce((a, s) => a + s.joins, 0),
    reconnects: list.reduce((a, s) => a + s.reconnects, 0),
    bytesPerClientPerSec: Math.round(list.reduce((a, s) => a + s.bytesIn, 0) / secs / Math.max(1, open)),
    framesPerClientPerSec: Math.round((list.reduce((a, s) => a + s.framesIn, 0) / secs / Math.max(1, open)) * 10) / 10,
    snapshotMs: pcts(sum((s) => s.snapHist)),
    // 30 when every room ticks on time (each tick sends every player one snapshot)
    snapshotsPerPlayerPerSec: Math.round((sum((s) => s.snapHist).reduce((a, b) => a + (b ?? 0), 0) / secs / Math.max(1, list.reduce((a, s) => a + s.playing, 0))) * 10) / 10,
    rttMs: pcts(sum((s) => s.rttHist)),
    joinMs: pcts(sum((s) => s.joinHist)),
    downMs: pcts(sum((s) => s.downHist)),
    errors: add((s) => s.errors),
    closes: add((s) => s.closes),
    refused: add((s) => s.refused),
  };
}

function pcts(h: number[]) {
  const n = h.reduce((a, b) => a + (b ?? 0), 0);
  const q = (p: number) => {
    let acc = 0;
    for (let i = 0; i < h.length; i++) {
      acc += h[i] ?? 0;
      if (acc >= n * p) return i;
    }
    return h.length - 1;
  };
  let max = 0;
  h.forEach((v, i) => v > 0 && (max = i));
  return n === 0 ? { n: 0 } : { n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max };
}

/* ------------------------------------------------------------ HTTP traffic */

const HTTP_PATHS = ['/api/rooms', '/api/health', '/api/leaderboard', '/api/config', '/api/appetizer/post', '/share/k/doesnotexist.png'];
const http = new Map<string, { lat: number[]; status: Record<string, number> }>();
let httpOn = false;
let httpIp = 0;
function startHttp(): void {
  httpOn = true;
  const tick = () => {
    if (!httpOn) return;
    const path = HTTP_PATHS[Math.floor(Math.random() * HTTP_PATHS.length)];
    const ip = `172.16.${(httpIp >> 8) & 255}.${httpIp++ & 255}`;
    const t0 = performance.now();
    const rec = (status: string) => {
      const e = http.get(path) ?? { lat: [], status: {} };
      e.lat.push(performance.now() - t0);
      e.status[status] = (e.status[status] ?? 0) + 1;
      http.set(path, e);
    };
    fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'X-Forwarded-For': ip }, signal: AbortSignal.timeout(10_000) })
      .then(async (r) => {
        await r.arrayBuffer();
        rec(String(r.status));
      })
      .catch((err) => rec(`err:${(err as Error).name}`));
    setTimeout(tick, 1000 / HTTP_RPS);
  };
  tick();
}
function httpReport() {
  const out: Record<string, unknown> = {};
  for (const [path, e] of http) {
    const a = [...e.lat].sort((x, y) => x - y);
    const q = (p: number) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0);
    out[path] = { n: a.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(a.at(-1) ?? 0), status: e.status };
  }
  http.clear();
  return out;
}

/* ------------------------------------------------------------ checks */

type Probed = ThreadLoad['tick'] & { p99Ms?: number; gc?: { count: number; totalMs: number; maxMs: number; p99Ms: number; major: number } };

/** The directory's invariants; returns a short summary. */
async function check(phase: string, r?: LoadReply) {
  r ??= await load();
  const ids = r.rooms.map((x) => x.id);
  if (new Set(ids).size !== ids.length) problem(`${phase}: duplicate room ids in the directory`);
  for (const x of r.rooms) if (x.players > x.maxPlayers) problem(`${phase}: ${x.id} holds ${x.players} people for ${x.maxPlayers} seats`);
  let api: { rooms: RoomInfo[] } = { rooms: [] };
  try {
    api = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`, { headers: { 'X-Forwarded-For': '192.168.200.1' }, signal: AbortSignal.timeout(15_000) })).json()) as { rooms: RoomInfo[] };
  } catch (err) {
    problem(`${phase}: /api/rooms did not answer (${(err as Error).message})`);
  }
  const apiIds = new Set(api.rooms.map((x) => x.id));
  // /api/rooms is cached for up to a second: allow rooms that opened or closed meanwhile, but never a duplicate
  if (apiIds.size !== api.rooms.length) problem(`${phase}: duplicate room ids in /api/rooms`);
  const missing = ids.filter((id) => !apiIds.has(id)).length;
  const ghost = [...apiIds].filter((id) => !ids.includes(id)).length;
  const arenas = r.rooms.filter((x) => x.mode === 'arena' && !x.test);
  const ends = new Set(arenas.map((x) => x.round?.endsAt));
  if (ends.size > 1) problem(`${phase}: arena instances disagree on the round's end (${[...ends].join(', ')})`);
  const perThread: Record<string, number> = {};
  for (const a of r.scaling.arenas) for (const i of a.instances) perThread[i.thread ?? 'main'] = (perThread[i.thread ?? 'main'] ?? 0) + 1;
  const humans = r.load.threads.map((t) => t.humans);
  return {
    rooms: r.rooms.length,
    apiMissing: missing,
    apiGhost: ghost,
    arenaInstances: Object.fromEntries(r.scaling.arenas.map((a) => [a.arenaId, a.instances.map((i) => `${i.instance}:${i.people}${i.draining ? 'd' : ''}@${i.thread ?? 'main'}`).join(' ')])),
    arenaInstancesPerThread: perThread,
    humansPerThread: humans,
    testRooms: r.rooms.filter((x) => x.test).map((x) => `${x.id}:${x.players}p/${x.bots}b`).join(' '),
    roomsPerThread: r.load.threads.map((t) => t.rooms),
    shed: r.shed,
    live: r.live,
  };
}

/** Samples the server every 5 s for `secs`; returns the window's figures. */
async function measure(label: string, secs: number) {
  await clientStats();
  httpReport();
  const r0 = await load();
  const cpu0 = procCpu(server!.pid!);
  const th0 = threadCpu(server!.pid!);
  const t0 = performance.now();
  const samples: LoadReply[] = [];
  const steps = Math.max(1, Math.round(secs / 5));
  for (let i = 0; i < steps; i++) {
    await sleep((secs * 1000) / steps);
    const s = await load();
    samples.push(s);
    const th = [s.load.main, ...s.load.threads];
    say(`  ${label} t+${Math.round((performance.now() - t0) / 1000)}s conns ${s.load.conns} rss ${s.load.rssMb} MB heap ${s.heapMb} MB out ${(s.load.sentBytesPerSec / 1e6).toFixed(1)} MB/s shed ${s.shed.level} | ${th.map((t) => `${t.id}:${t.rooms}r/${t.humans}h p95 ${t.tick.p95Ms} max ${t.tick.maxMs} elu ${t.elu} lag99 ${t.lagP99Ms}`).join(' | ')}`);
  }
  const elapsed = (performance.now() - t0) / 1000;
  const cpu = (procCpu(server!.pid!) - cpu0) / elapsed;
  const perThreadCpu = threadUse(server!.pid!, th0, elapsed);
  const clients = merge(await clientStats());
  const last = samples.at(-1)!;
  const threads: Record<string, unknown> = {};
  const gc0 = new Map([r0.load.main, ...r0.load.threads].map((t) => [String(t.id), (t.tick as Probed).gc]));
  for (const t of [last.load.main, ...last.load.threads]) {
    const id = String(t.id);
    const rows = samples.map((s) => [s.load.main, ...s.load.threads].find((x) => String(x.id) === id)).filter((x): x is ThreadLoad => !!x);
    const g1 = (t.tick as Probed).gc;
    const g0 = gc0.get(id);
    threads[id] = {
      rooms: t.rooms,
      humans: t.humans,
      bots: t.bots,
      tickMeanMs: Math.round((rows.reduce((a, x) => a + x.tick.meanMs, 0) / rows.length) * 100) / 100,
      tickP95MsWorst: Math.max(...rows.map((x) => x.tick.p95Ms)),
      tickP99MsWorst: Math.max(...rows.map((x) => (x.tick as Probed).p99Ms ?? 0)),
      tickMaxMs: Math.max(...rows.map((x) => x.tick.maxMs)),
      elu: Math.round((rows.reduce((a, x) => a + x.elu, 0) / rows.length) * 1000) / 1000,
      lagP99MsWorst: Math.max(...rows.map((x) => x.lagP99Ms)),
      lagMaxMs: Math.max(...rows.map((x) => x.lagMaxMs)),
      heapMb: t.heapMb,
      gc: g1 && g0 ? { pauses: g1.count - g0.count, totalMs: Math.round(g1.totalMs - g0.totalMs), pctOfTime: Math.round(((g1.totalMs - g0.totalMs) / (elapsed * 10)) * 100) / 100, maxMs: g1.maxMs, major: g1.major - g0.major } : null,
    };
  }
  const roomLoads = last.load.threads.flatMap((t) => t.roomLoads ?? []);
  const worstRoom = roomLoads.reduce((w, x) => (!w || x.tick.p95Ms > w.tick.p95Ms ? x : w), null as (typeof roomLoads)[number] | null);
  return {
    secs: Math.round(elapsed),
    server: {
      cpuCores: Math.round(cpu * 100) / 100,
      threadCpuCores: perThreadCpu,
      rssMb: last.load.rssMb,
      heapMb: last.heapMb,
      externalMb: last.extMb,
      outMBps: Math.round((samples.reduce((a, s) => a + s.load.sentBytesPerSec, 0) / samples.length / 1e6) * 100) / 100,
      outMsgsPerSec: Math.round(samples.reduce((a, s) => a + s.load.sentMsgsPerSec, 0) / samples.length),
      conns: last.load.conns,
      threads,
      worstRoom: worstRoom ? { id: worstRoom.id, humans: worstRoom.humans, bots: worstRoom.bots, tickP95Ms: worstRoom.tick.p95Ms, tickMaxMs: worstRoom.tick.maxMs } : null,
    },
    clients,
    http: httpReport(),
    directory: await check(label, last),
  };
}

/* ------------------------------------------------------------ bell timing */

/** Every arena round end seen in the directory (for the bell check). */
const roundEnds = new Set<number>();
async function watchRounds(): Promise<void> {
  while (server) {
    try {
      const r = await load();
      for (const x of r.rooms) if (x.mode === 'arena' && x.round?.endsAt) roundEnds.add(x.round.endsAt);
    } catch {
      /* restarting */
    }
    await sleep(5000);
  }
}

/* ------------------------------------------------------------ phases */

async function waitConns(min: number, maxMs: number): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const r = await load();
    if (r.load.conns >= min || Date.now() - t0 > maxMs) return r.load.conns;
    await sleep(1000);
  }
}

async function ramp(): Promise<void> {
  let have = 0;
  const stages: Record<string, unknown> = {};
  for (const n of STAGES) {
    const add = n - have;
    if (add > 0) {
      say(`ramp: ${have} → ${n} players`);
      addClients(await mixSpecs(add), Math.max(2000, add * 8));
      have = n;
      await sleep(Math.max(2000, add * 8) + 2000);
      await waitConns(Math.round(n * 0.95), 30_000);
      await sleep(8000);
    }
    const m = await measure(`ramp ${n}`, STAGE_S);
    stages[n] = m;
    say(`ramp ${n}: cpu ${m.server.cpuCores} cores, rss ${m.server.rssMb} MB, out ${m.server.outMBps} MB/s, snapshot p99 ${(m.clients.snapshotMs as { p99?: number }).p99} ms, rtt p99 ${(m.clients.rttMs as { p99?: number }).p99} ms, open ${m.clients.open}/${m.clients.clients}`);
  }
  phases.ramp = stages;
}

async function storm(): Promise<void> {
  const r = await load();
  const a = r.rooms.find((x) => x.mode === 'arena' && !x.test && x.round);
  const round = a?.round as { endsAt: number; startsAt?: number; opensAt?: number } | undefined;
  // the next opening: the round after this one starts at its end (plus the break, if any)
  const opens = round ? Math.max(round.opensAt ?? 0, round.endsAt) : Date.now();
  const wait = Math.max(0, opens - Date.now() + 300);
  say(`storm: waiting ${Math.round(wait / 1000)} s for the next round to open, then ${STORM} joins in 3 s on arena 1`);
  await sleep(wait);
  const before = await check('storm-before');
  const specs = Array.from({ length: STORM }, () => spec('arena', arenaIds[0]));
  addClients(specs, 3000);
  await sleep(5000);
  const m = await measure('storm', 20);
  const arena1 = (await load()).scaling.arenas.find((x) => x.arenaId === arenaIds[0]);
  const seats = arena1?.instances.reduce((acc, i) => acc + i.people, 0) ?? 0;
  phases.storm = { before, after: m, arena1: arena1?.instances, seated: seats, log: (await load()).scaling.log.slice(0, 20) };
  say(`storm: arena 1 has ${arena1?.instances.length} instances, ${seats} seated; join p99 ${(m.clients.joinMs as { p99?: number }).p99} ms`);
}

async function slow(): Promise<void> {
  const before = await load();
  procs.forEach((p) => p.send({ t: 'slow', n: Math.ceil(SLOW / procs.length) }));
  say(`slow: ${SLOW} players stop reading`);
  // a socket that does not read cannot echo the heartbeat's ping: closed at the second beat (25 s apart) at the latest
  const m = await measure('slow', 60);
  const closedBySlow = before.load.conns - m.server.conns;
  phases.slow = { connsBefore: before.load.conns, rssBefore: before.load.rssMb, after: m, connsGone: closedBySlow };
  if (m.server.rssMb > before.load.rssMb + 300) problem(`slow: RSS grew ${m.server.rssMb - before.load.rssMb} MB with ${SLOW} slow clients`);
}

async function drop(): Promise<void> {
  const before = await load();
  const n = Math.floor(before.load.conns / 2);
  procs.forEach((p) => p.send({ t: 'drop', n: Math.ceil(n / procs.length) }));
  say(`drop: ${n} players disconnect at once`);
  const m = await measure('drop', 20);
  phases.drop = { connsBefore: before.load.conns, dropped: n, after: m };
}

async function crash(): Promise<void> {
  const before = await load();
  const w0 = before.load.threads.find((t) => t.id === 0);
  say(`crash: room worker 0 dies (${w0?.rooms} rooms, ${w0?.humans} people)`);
  server!.send({ t: 'crash', index: 0 });
  const t0 = Date.now();
  let back = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await load();
    const t = r.load.threads.find((x) => x.id === 0);
    if (t?.up !== false && (t?.restarts ?? 0) > (w0?.restarts ?? 0)) {
      back = Date.now() - t0;
      break;
    }
  }
  const m = await measure('crash', 20);
  phases.crash = { worker0Before: { rooms: w0?.rooms, humans: w0?.humans }, restartedMs: back, after: m };
  if (back < 0) problem('crash: room worker 0 did not come back within 30 s');
}

async function restart(): Promise<void> {
  const before = await load();
  const conns = before.load.conns;
  const stopMs = await stopServer();
  say(`restart: server stopped in ${stopMs} ms; starting again (${conns} clients reconnecting)`);
  const t0 = Date.now();
  await startServer();
  void watchRounds();
  const bootMs = Date.now() - t0;
  // every client reconnects (0.5 s, 1 s, 2 s, 4 s, 8 s...)
  let backAt = -1;
  for (let i = 0; i < 90; i++) {
    const r = await load();
    if (r.load.conns >= conns * 0.98) {
      backAt = Date.now() - t0;
      break;
    }
    await sleep(1000);
  }
  const m = await measure('restart', 20);
  phases.restart = { connsBefore: conns, stopMs, bootMs, reconnected98PctMs: backAt, after: m };
  if (backAt < 0) problem(`restart: fewer than 98 % of ${conns} clients were back after 90 s`);
}

async function drain(): Promise<void> {
  // short windows so a consolidation shows within the run (the defaults wait 10 minutes)
  await ask('scaling', { scaling: { lowMin: 1, lowPct: 35, cooldownMin: 0, sustainMin: 1 } });
  const r0 = await load();
  const a0 = r0.scaling.arenas.find((x) => x.arenaId === arenaIds[0]);
  // the storm's players leave: all but a few of arena 1
  const leave = Math.max(0, (a0?.instances.reduce((s, i) => s + i.people, 0) ?? 0) - 10);
  procs.forEach((p) => p.send({ t: 'drop', n: Math.ceil(leave / procs.length), room: `arena:${arenaIds[0]}` }));
  say(`drain: ${leave} players leave; waiting for arena 1 to consolidate (it plays out the round first)`);
  const t0 = Date.now();
  const deadline = t0 + (ROUND_S + 150) * 1000;
  let a1 = a0;
  while (Date.now() < deadline) {
    await sleep(5000);
    a1 = (await load()).scaling.arenas.find((x) => x.arenaId === arenaIds[0]);
    if ((a1?.instances.length ?? 0) <= 1) break;
  }
  const r1 = await load();
  phases.drain = {
    instancesBefore: a0?.instances,
    instancesAfter: a1?.instances,
    secs: Math.round((Date.now() - t0) / 1000),
    log: r1.scaling.log.filter((d) => d.arenaId === arenaIds[0]).slice(0, 30),
    directory: await check('drain', r1),
  };
  if ((a1?.instances.length ?? 0) > 1) problem(`drain: arena 1 still runs ${a1?.instances.length} instances after the demand fell`);
}

/** Long run with churn: every 10 s a tenth of the players leave and as many new ones arrive; heap and RSS per minute. */
async function soak(): Promise<void> {
  const minutes = Number(process.env.STRESS_SOAK_MIN ?? 10);
  const r0 = await load();
  const n = Math.max(100, r0.load.conns);
  const churn = Math.max(10, Math.round(n / 10));
  say(`soak: ${minutes} min, ${n} players, ${churn} leave and ${churn} arrive every 10 s`);
  const series: { min: number; conns: number; rssMb: number; mainHeapMb: number; workerHeapMb: number[]; rooms: number; live: number; tickP95: number[] }[] = [];
  const t0 = Date.now();
  let lastMin = -1;
  while (Date.now() - t0 < minutes * 60_000) {
    procs.forEach((p) => p.send({ t: 'drop', n: Math.ceil(churn / procs.length) }));
    addClients(await mixSpecs(churn), 3000);
    await sleep(10_000);
    const min = Math.floor((Date.now() - t0) / 60_000);
    if (min !== lastMin) {
      lastMin = min;
      const r = await load();
      series.push({ min, conns: r.load.conns, rssMb: r.load.rssMb, mainHeapMb: r.heapMb, workerHeapMb: r.load.threads.map((t) => t.heapMb), rooms: r.rooms.length, live: r.live, tickP95: r.load.threads.map((t) => t.tick.p95Ms) });
      say(`  soak min ${min}: ${JSON.stringify(series.at(-1))}`);
    }
  }
  const m = await measure('soak', 10);
  phases.soak = { minutes, players: n, churnPer10s: churn, series, after: m };
  const first = series[1] ?? series[0];
  const last = series.at(-1)!;
  if (first && last.rssMb > first.rssMb * 1.5 + 100) problem(`soak: RSS grew from ${first.rssMb} to ${last.rssMb} MB`);
}

async function limits(): Promise<void> {
  // 20 sockets from one address: the guest bound per address (8) refuses the rest cleanly
  const one = await Promise.all(
    Array.from(
      { length: 20 },
      () =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(url(), { headers: { 'X-Forwarded-For': '10.250.250.250' } });
          ws.on('open', () => resolve('open'));
          ws.on('unexpected-response', (_q, res) => resolve(`http:${res.statusCode}`));
          ws.on('error', () => resolve('error'));
          setTimeout(() => resolve('timeout'), 5000).unref();
        }),
    ),
  );
  const perIp: Record<string, number> = {};
  for (const o of one) perIp[o] = (perIp[o] ?? 0) + 1;
  // guests past MAX_CONNECTIONS
  const r = await load();
  const extra = Math.max(0, MAX_CONN - r.load.conns) + 300;
  say(`limits: one address got ${JSON.stringify(perIp)}; now ${extra} idle guests on top of ${r.load.conns} sockets (cap ${MAX_CONN})`);
  await clientStats();
  addClients(Array.from({ length: extra }, () => ({ ...spec('idle'), reconnect: false })), 4000);
  await sleep(8000);
  const storm = merge(await clientStats());
  const m = await measure('limits', 10);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((x) => x.status).catch(() => 0);
  phases.limits = { oneAddress: perIp, extraGuests: extra, refused: storm.refused, closes: storm.closes, after: m, health };
  say(`limits: the guests got ${JSON.stringify(storm.refused)} refusals, ${JSON.stringify(storm.closes)} closes; ${m.server.conns} sockets now; health ${health}`);
  if (m.server.conns > MAX_CONN * 1.06) problem(`limits: ${m.server.conns} sockets for a cap of ${MAX_CONN}`);
  if (!server || server.exitCode !== null) problem('limits: the server died');
}

/* ------------------------------------------------------------ run */

await startServer();
spawnClients();
void watchRounds();
startHttp();
const t0 = Date.now();
try {
  for (const p of PHASES) {
    const ph = { ramp, storm, slow, drop, crash, restart, drain, soak, limits }[p];
    if (!ph) throw new Error(`unknown phase ${p}`);
    say(`── phase ${p}`);
    await ph();
    say(`── phase ${p} done: ${JSON.stringify(await check(p))}`);
  }
} catch (err) {
  problem(`run failed: ${(err as Error).stack ?? err}`);
}
httpOn = false;
merge(await clientStats());
report.minutes = Math.round((Date.now() - t0) / 6000) / 10;
report.roundEnds = [...roundEnds].sort();
// the bell's delay: the first client's roundOver after a round's end
report.bellDelaysMs = [...roundEnds].sort().map((end) => {
  const after = bellsSeen.filter((b) => b >= end - 2000 && b < end + 30_000).sort((a, b) => a - b)[0];
  return after === undefined ? null : after - end;
});
const alarms = serverLog.filter((l) => /!!!|Error|failed/.test(l));
report.serverAlarms = { count: alarms.length, first: alarms.slice(0, 30) };
report.scalingLog = serverLog.filter((l) => /arena scaling:/.test(l)).slice(-60);
report.problems = problems;
const out = process.env.STRESS_OUT ?? join(tmpdir(), `coinnibal-stress-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
say(`report: ${out}; ${problems.length} problem(s)`);
for (const p of problems) say(`  - ${p}`);
for (const p of procs) p.send({ t: 'stop' });
if (server) await stopServer().catch(() => {});
rmSync(dataDir, { recursive: true, force: true });
process.exit(problems.length > 0 ? 1 : 0);
