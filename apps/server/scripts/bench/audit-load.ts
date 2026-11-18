/**
 * Mainnet-readiness load audit: the real app in this process (DEV_FAKE_CHAIN: free arena tickets) with
 * AUDIT_CLIENTS WebSocket clients (`audit-client.ts`) spread over the four arenas and the practice ponds,
 * moving at 30 Hz, splitting, ejecting and chatting. Measures over AUDIT_SECONDS:
 *
 * - per thread (main + every room worker): tick p50 / p95 / p99 / max (via `tick-probe.ts`), event-loop lag,
 *   utilisation, GC pauses (count, total, max, p99, major collections);
 * - process CPU (all threads), RSS, heap, WebSocket bytes and frames out;
 * - per client: payload bytes per second, by room kind, and an estimate of the bytes on the wire
 *   (WebSocket + TLS 1.3 record + TCP/IPv4 headers per frame), plus the monthly traffic it implies.
 *
 * Run from apps/server (the probe must be preloaded so that the room workers load it too):
 *   AUDIT_CLIENTS=200 GAME_WORKERS=3 node --import tsx --import ./scripts/bench/tick-probe.ts scripts/bench/audit-load.ts
 *
 * Env: AUDIT_CLIENTS (200), AUDIT_SECONDS (60), AUDIT_WARMUP_S (15), AUDIT_PROCS (one per 150 clients),
 * AUDIT_ARENA_PCT (share of clients with arena tickets, spread over arenas 1..4; default 50), AUDIT_OUT (JSON
 * file), GAME_WORKERS.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ARENAS } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { ServerLoad, ThreadLoad } from '../../src/rooms/load';
import type { AuditSpec, AuditStats } from './audit-client';

const N = Number(process.env.AUDIT_CLIENTS ?? 200);
const SECONDS = Number(process.env.AUDIT_SECONDS ?? 60);
const WARMUP = Number(process.env.AUDIT_WARMUP_S ?? 15);
const PROCS = Number(process.env.AUDIT_PROCS ?? Math.max(1, Math.ceil(N / 150)));
const ARENA_PCT = Number(process.env.AUDIT_ARENA_PCT ?? 50);
const here = dirname(fileURLToPath(import.meta.url));

/** Bytes per WebSocket frame on the wire beyond its payload: WS header (2..4) + TLS 1.3 record (22) + TCP/IPv4 with timestamps (52). */
const WIRE_OVERHEAD_PER_FRAME = 2 + 22 + 52;
const MSS = 1448;

const dir = mkdtempSync(join(tmpdir(), 'elymum-audit-'));
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
  LOAD_SHED: '1',
};
if (process.env.GAME_WORKERS !== undefined) env.GAME_WORKERS = process.env.GAME_WORKERS;
// every client comes from its own address (X-Forwarded-For, one trusted hop as behind Caddy): the per-IP, per-subnet
// and upgrade-rate limits then apply per client as in production instead of to 127.0.0.1 as a whole
process.env.TRUST_PROXY = '1';
process.env.TRUST_PROXY_HOPS = '1';
const cfg = loadConfig(env as unknown as NodeJS.ProcessEnv);
const logs: string[] = [];
const app = await createApp(cfg, { log: (m) => logs.push(m) });
const port = await app.listen();
const url = `ws://127.0.0.1:${port}/ws`;
await app.rooms.ensureArenaRooms();

const arenaIds = DEFAULT_ARENAS.map((a) => a.id);
/** A distinct address (and /24) per client. */
const clientIp = (i: number) => `10.${(i >> 8) & 255}.${i & 255}.7`;
const nArena = Math.round((N * ARENA_PCT) / 100);
const specs: AuditSpec[] = [];
for (let i = 0; i < nArena; i++) {
  const wallet = getAddress(`0x${(i + 1).toString(16).padStart(8, '0')}${'cd'.repeat(16)}`);
  specs.push({ room: `arena:${arenaIds[i % arenaIds.length]}`, token: app.auth.issueToken(wallet), ip: clientIp(i) });
}
for (let i = nArena; i < N; i++) specs.push({ room: 'practice', ip: clientIp(i) });

const procs: ChildProcess[] = [];
const per: AuditSpec[][] = Array.from({ length: PROCS }, () => []);
specs.forEach((s, i) => per[i % PROCS].push(s));
for (const list of per) {
  const p = fork(join(here, 'audit-client.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  p.send({ t: 'start', url, specs: list });
  procs.push(p);
}

function askStats(): Promise<AuditStats[]> {
  return Promise.all(
    procs.map(
      (p) =>
        new Promise<AuditStats>((resolve) => {
          const on = (m: { t: string; stats: AuditStats }) => {
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

function procCpu(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return 0;
  }
}

type Probed = ThreadLoad['tick'] & { p50Ms?: number; p99Ms?: number; gc?: { count: number; totalMs: number; maxMs: number; p99Ms: number; major: number; majorMaxMs: number } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connectS = (N * 8) / 1000 / PROCS + 2;
console.log(`audit-load: ${N} clients (${nArena} arena over ${arenaIds.length} arenas, ${N - nArena} practice) in ${PROCS} process(es); workers ${process.env.GAME_WORKERS ?? 'default'}; warm-up ${WARMUP} s, measuring ${SECONDS} s`);
await sleep((connectS + WARMUP) * 1000);
await askStats();
const first = app.rooms.loadStats();
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
    `  t+${((performance.now() - t0) / 1000).toFixed(0)}s rss ${s.rssMb} MB out ${(s.sentBytesPerSec / 1e6).toFixed(2)} MB/s | ` +
      th.map((t) => { const k = t.tick as Probed; return `${t.id}: ${t.rooms}r ${t.humans}h p50 ${k.p50Ms} p95 ${k.p95Ms} p99 ${k.p99Ms} max ${k.maxMs} lag99 ${t.lagP99Ms}`; }).join(' | '),
  );
}
const secs = (performance.now() - t0) / 1000;
const cpu1 = process.cpuUsage(cpu0);
const childCpu = procs.map((p, i) => procCpu(p.pid!) - child0[i]);
const stats = await askStats();

const agg = { bytesIn: 0, framesIn: 0, open: 0, playing: 0, joins: 0, deaths: 0, splits: 0, ejects: 0, chats: 0, chatsIn: 0 };
const hist = new Array(1000).fill(0);
const errors: Record<string, number> = {};
const bytesByKind: Record<string, number> = {};
const clientsByKind: Record<string, number> = {};
for (const s of stats) {
  for (const k of Object.keys(agg) as (keyof typeof agg)[]) agg[k] += s[k];
  s.hist.forEach((v, i) => (hist[i] += v));
  for (const [k, v] of Object.entries(s.errors)) errors[k] = (errors[k] ?? 0) + v;
  for (const [k, v] of Object.entries(s.bytesByKind)) bytesByKind[k] = (bytesByKind[k] ?? 0) + v;
  for (const [k, v] of Object.entries(s.clientsByKind)) clientsByKind[k] = (clientsByKind[k] ?? 0) + v;
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

const threads: Record<string, unknown> = {};
const ids = [samples[0].main, ...samples[0].threads].map((t) => String(t.id));
const firstGc = new Map([first.main, ...first.threads].map((t) => [String(t.id), (t.tick as Probed).gc]));
for (const id of ids) {
  const rows = samples.map((s) => [s.main, ...s.threads].find((t) => String(t.id) === id)!).filter(Boolean);
  const ticks = rows.map((r) => r.tick as Probed);
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const g1 = ticks.at(-1)?.gc;
  const g0 = firstGc.get(id);
  threads[id] = {
    rooms: rows.at(-1)!.rooms,
    humans: rows.at(-1)!.humans,
    tickP50Ms: med(ticks.map((t) => t.p50Ms ?? 0)),
    tickP95Ms: { median: med(ticks.map((t) => t.p95Ms)), worst: Math.max(...ticks.map((t) => t.p95Ms)) },
    tickP99Ms: { median: med(ticks.map((t) => t.p99Ms ?? 0)), worst: Math.max(...ticks.map((t) => t.p99Ms ?? 0)) },
    tickMaxMs: Math.max(...ticks.map((t) => t.maxMs)),
    elu: Math.round((rows.reduce((a, r) => a + r.elu, 0) / rows.length) * 1000) / 1000,
    lagP99MsWorst: Math.max(...rows.map((r) => r.lagP99Ms)),
    heapMb: rows.at(-1)!.heapMb,
    gc: g1 && g0 ? { pauses: g1.count - g0.count, pausesPerSec: Math.round(((g1.count - g0.count) / secs) * 10) / 10, totalMs: Math.round((g1.totalMs - g0.totalMs) * 10) / 10, pctOfTime: Math.round(((g1.totalMs - g0.totalMs) / (secs * 1000)) * 10000) / 100, maxMs: g1.maxMs, p99Ms: g1.p99Ms, major: g1.major - g0.major, majorMaxMs: g1.majorMaxMs } : null,
  };
}

const perClientPayload = agg.bytesIn / secs / Math.max(1, agg.open);
const framesPerClient = agg.framesIn / secs / Math.max(1, agg.open);
const avgFrame = agg.bytesIn / Math.max(1, agg.framesIn);
const extraSegments = Math.max(0, Math.ceil(avgFrame / MSS) - 1);
const perClientWire = perClientPayload + framesPerClient * (WIRE_OVERHEAD_PER_FRAME + extraSegments * 52);
const serverOut = samples.reduce((a, s) => a + s.sentBytesPerSec, 0) / samples.length;
const totalWire = perClientWire * agg.open;
const monthTB = (bps: number) => Math.round(((bps * 86_400 * 30) / 1e12) * 100) / 100;
const summary = {
  clients: N,
  workers: samples.at(-1)!.workers,
  mode: samples.at(-1)!.mode,
  cpus: cpus().length,
  secs: Math.round(secs),
  rooms: samples.at(-1)!.threads.reduce((a, t) => a + t.rooms, samples.at(-1)!.main.rooms),
  client: { ...agg, errors, clientsByKind },
  server: {
    cpuCores: Math.round(((cpu1.user + cpu1.system) / 1e6 / secs) * 100) / 100,
    rssMaxMb: rssMax,
    outMBps: Math.round((serverOut / 1e6) * 100) / 100,
    outMsgsPerSec: Math.round(samples.reduce((a, s) => a + s.sentMsgsPerSec, 0) / samples.length),
    threads,
  },
  clientsCpuCores: Math.round((childCpu.reduce((a, b) => a + b, 0) / secs) * 100) / 100,
  perClient: {
    payloadBytesPerSec: Math.round(perClientPayload),
    byKindBytesPerSec: Object.fromEntries(Object.entries(bytesByKind).map(([k, v]) => [k, Math.round(v / secs / Math.max(1, clientsByKind[k] ?? 1))])),
    framesPerSec: Math.round(framesPerClient * 10) / 10,
    avgFrameBytes: Math.round(avgFrame),
    wireBytesPerSecEstimate: Math.round(perClientWire),
    snapshotIntervalMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
  },
  traffic: {
    totalWireMbitPerSec: Math.round(((totalWire * 8) / 1e6) * 10) / 10,
    tbPerMonthAtThisLoad24x7: monthTB(totalWire),
    tbPerMonthAt30PctDutyCycle: monthTB(totalWire * 0.3),
  },
  shedderLog: logs.filter((l) => /load:/.test(l)).slice(0, 5),
};
console.log(JSON.stringify(summary, null, 2));
if (process.env.AUDIT_OUT) writeFileSync(process.env.AUDIT_OUT, JSON.stringify(summary, null, 2));
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
