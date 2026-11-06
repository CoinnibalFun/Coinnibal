/**
 * Network-quality drill: the real app (DEV_FAKE_CHAIN, so arena tickets are free) behind a userspace TCP proxy that
 * emulates a far-away or lossy path, and WebSocket clients that steer like the web client and ping every 2 s.
 *
 * Path model (no `tc`/netem needed): every chunk waits RTT/2 in each direction; with probability `loss` a chunk
 * is "lost" and it AND everything after it in that direction wait a retransmission (TCP is in order: one lost
 * segment holds every later snapshot, head-of-line blocking). The retransmission delay is max(200 ms, RTT + 50 ms)
 * (Linux's minimum RTO; fast retransmit / tail-loss probe land near RTT). Chunks are what the kernel hands the
 * proxy, roughly one per WebSocket frame here.
 *
 * Per profile: snapshot inter-arrival (p50 / p95 / p99 / max), the share of gaps over 120 ms (the web client eases
 * each snapshot over LERP_MS = 120 ms: a longer gap is a visible freeze then a jump) and over 250 ms, and the
 * application ping RTT. Then two mobile network-switch drills on an arena player:
 *
 * - `switch-clean`: the old path is reset (both ends see the close; e.g. Chrome's ERR_NETWORK_CHANGED);
 * - `switch-blackhole`: the old path goes silent (no FIN/RST reaches either end: what a Wi-Fi -> LTE handover
 *   usually looks like to the server); the client opens a new socket after 1 s, as a page that noticed the change.
 *
 * For each: time until the same coin is back (`joined` with the same session), and the refusals on the way.
 *
 *   node --import tsx scripts/bench/netem.ts      (from apps/server)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect as tcpConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, encodeTarget } from '@elymum/shared';
import { getAddress } from 'viem';
import WebSocket from 'ws';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';

interface Profile {
  name: string;
  rttMs: number;
  loss: number;
}
const PROFILES: Profile[] = [
  { name: 'local (Nuremberg region)', rttMs: 10, loss: 0 },
  { name: 'Istanbul (~55 ms, 0.5 %)', rttMs: 55, loss: 0.005 },
  { name: 'US East (~100 ms, 0.5 %)', rttMs: 100, loss: 0.005 },
  { name: 'target: 150 ms RTT, 2 % loss', rttMs: 150, loss: 0.02 },
  { name: 'US West mobile (~180 ms, 2 %)', rttMs: 180, loss: 0.02 },
];
const SECS = Number(process.env.NETEM_SECONDS ?? 30);
const CLIENTS = Number(process.env.NETEM_CLIENTS ?? 8);
const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the path */

class Lane {
  private queue: { at: number; data: Buffer }[] = [];
  private holdUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly out: Socket,
    private readonly p: { rttMs: number; loss: number },
  ) {}
  push(data: Buffer): void {
    const now = Date.now();
    let at = now + this.p.rttMs / 2;
    if (Math.random() < this.p.loss) this.holdUntil = Math.max(this.holdUntil, at + Math.max(200, this.p.rttMs + 50));
    at = Math.max(at, this.holdUntil);
    // in order: never before the chunk ahead of it
    const last = this.queue.at(-1);
    if (last && last.at > at) at = last.at;
    this.queue.push({ at, data });
    this.pump();
  }
  private pump(): void {
    if (this.timer) return;
    const next = this.queue[0];
    if (!next) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = Date.now();
      while (this.queue.length && this.queue[0].at <= now) {
        const c = this.queue.shift()!;
        if (!this.out.destroyed) this.out.write(c.data);
      }
      this.pump();
    }, Math.max(0, next.at - Date.now()));
  }
}

interface PathCtl {
  port: number;
  profile: { rttMs: number; loss: number };
  /** Silently stops every current pair (no FIN, no RST: the packets just vanish). */
  blackhole(): void;
  /** Resets every current pair (both ends see the connection die). */
  reset(): void;
  close(): void;
}

async function path(target: number, profile: { rttMs: number; loss: number }): Promise<PathCtl> {
  const pairs: { a: Socket; b: Socket; dead: boolean }[] = [];
  const srv = createServer((a) => {
    const b = tcpConnect(target, '127.0.0.1');
    a.setNoDelay(true);
    b.setNoDelay(true);
    const pair = { a, b, dead: false };
    pairs.push(pair);
    const up = new Lane(b, ctl.profile);
    const down = new Lane(a, ctl.profile);
    a.on('data', (d) => !pair.dead && up.push(d));
    b.on('data', (d) => !pair.dead && down.push(d));
    const end = () => {
      if (pair.dead) return;
      a.destroy();
      b.destroy();
    };
    a.on('close', end);
    b.on('close', end);
    a.on('error', () => undefined);
    b.on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const a = srv.address();
  const ctl: PathCtl = {
    port: typeof a === 'object' && a ? a.port : 0,
    profile,
    blackhole() {
      for (const p of pairs) p.dead = true;
    },
    reset() {
      for (const p of pairs) {
        p.a.resetAndDestroy();
        p.b.resetAndDestroy();
      }
    },
    close() {
      for (const p of pairs) {
        p.a.destroy();
        p.b.destroy();
      }
      srv.close();
    },
  };
  return ctl;
}

/* ------------------------------------------------------------ the app */

const dir = mkdtempSync(join(tmpdir(), 'elymum-netem-'));
process.env.TRUST_PROXY = '1';
const cfg = loadConfig({
  NODE_ENV: 'development',
  DEV_FAKE_CHAIN: '1',
  DEV_FAKE_TOKEN: '1',
  PORT: '0',
  HOST: '127.0.0.1',
  DATA_DIR: dir,
  GAME_ACCESS: 'public',
  GAME_WORKERS: '1',
  MAX_CONNECTIONS_PER_IP: '50',
  // short rounds with a short closed window, so the switch drills find an open round quickly
  ROUND_SECONDS: '60',
  ROUND_JOIN_CLOSE_SECONDS: '5',
} as unknown as NodeJS.ProcessEnv);
const app = await createApp(cfg, { log: () => {} });
const appPort = await app.listen();
await app.rooms.ensureArenaRooms();

interface Probe {
  ws: WebSocket;
  gaps: number[];
  rtts: number[];
  last: number;
  playing: boolean;
  session: string | null;
  events: { at: number; e: string }[];
  timer: NodeJS.Timeout;
}

function probe(port: number, room: string, ip: string, token?: string): Probe {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false, headers: { 'x-forwarded-for': ip } });
  const pr: Probe = { ws, gaps: [], rtts: [], last: 0, playing: false, session: null, events: [], timer: null as unknown as NodeJS.Timeout };
  const buf = new ArrayBuffer(9);
  let x = 0;
  let y = 0;
  const join = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'join', room, name: 'netem', skin: 1 }));
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ t: 'viewport', w: 1600, h: 900 }));
    if (token) ws.send(JSON.stringify({ t: 'auth', token }));
    else join();
  });
  ws.on('message', (d: Buffer, bin: boolean) => {
    const now = performance.now();
    if (bin) {
      if (pr.playing && pr.last) pr.gaps.push(now - pr.last);
      pr.last = now;
      return;
    }
    const m = JSON.parse(d.toString()) as { t: string; ts?: number; code?: string; session?: string };
    if (m.t === 'pong' && m.ts) pr.rtts.push(now - m.ts);
    if (m.t === 'authed') join();
    if (m.t === 'joined') {
      pr.playing = true;
      pr.session = m.session ?? null;
      pr.events.push({ at: Date.now(), e: `joined:${m.session ?? ''}` });
    }
    if (m.t === 'death' || m.t === 'roundOver') {
      pr.playing = false;
      setTimeout(join, 1000).unref();
    }
    if (m.t === 'error') pr.events.push({ at: Date.now(), e: `error:${m.code}` });
  });
  ws.on('close', (c) => pr.events.push({ at: Date.now(), e: `close:${c}` }));
  ws.on('error', () => undefined);
  pr.timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    x += (Math.random() - 0.5) * 300;
    y += (Math.random() - 0.5) * 300;
    ws.send(encodeTarget(x, y, buf));
  }, 33);
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 2000);
  ws.on('close', () => {
    clearInterval(pr.timer);
    clearInterval(ping);
  });
  return pr;
}

const q = (xs: number[], p: number) => {
  const a = [...xs].sort((m, n) => m - n);
  return a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]) : null;
};

const out: Record<string, unknown> = {};
for (const pf of process.env.NETEM_SKIP_PROFILES === '1' ? [] : PROFILES) {
  const ctl = await path(appPort, pf);
  const probes = Array.from({ length: CLIENTS }, (_, i) => probe(ctl.port, 'practice', `10.77.${i}.1`));
  await sleep(4000);
  for (const p of probes) p.gaps = [];
  await sleep(SECS * 1000);
  const gaps = probes.flatMap((p) => p.gaps);
  const rtts = probes.flatMap((p) => p.rtts);
  const r = {
    snapshotGapMs: { p50: q(gaps, 0.5), p95: q(gaps, 0.95), p99: q(gaps, 0.99), max: q(gaps, 1) },
    gapsOver120msPct: Math.round((gaps.filter((g) => g > 120).length / Math.max(1, gaps.length)) * 1000) / 10,
    gapsOver250msPct: Math.round((gaps.filter((g) => g > 250).length / Math.max(1, gaps.length)) * 1000) / 10,
    freezesPerMinutePerClient: Math.round((gaps.filter((g) => g > 120).length / CLIENTS / (SECS / 60)) * 10) / 10,
    appPingRttMs: { p50: q(rtts, 0.5), p95: q(rtts, 0.95), max: q(rtts, 1) },
  };
  out[pf.name] = r;
  say(`${pf.name}: ${JSON.stringify(r)}`);
  for (const p of probes) p.ws.terminate();
  ctl.close();
  await sleep(500);
}

/* ------------------------------------------------------------ network switch */

async function switchDrill(kind: 'clean' | 'blackhole', n: number) {
  const wallet = getAddress(`0x${(0x5000 + n).toString(16).padStart(8, '0')}${'ef'.repeat(16)}`);
  const token = app.auth.issueToken(wallet);
  // start right after a bell, so the drill has the whole round
  while (60 - ((Date.now() / 1000) % 60) < 57) await sleep(250);
  const ctl = await path(appPort, { rttMs: 80, loss: 0 });
  const a = probe(ctl.port, 'arena:1', `10.88.${n}.1`, token);
  // a closed round (its last seconds): ask again until the next one opens
  for (let i = 0; i < 300 && !a.session; i++) {
    await sleep(250);
    if (i % 8 === 7 && a.ws.readyState === WebSocket.OPEN) a.ws.send(JSON.stringify({ t: 'join', room: 'arena:1', name: 'netem', skin: 1 }));
  }
  if (!a.session) return { error: 'not seated', events: a.events.map((e) => e.e) };
  await sleep(3000);
  const t0 = Date.now();
  if (kind === 'clean') ctl.reset();
  else ctl.blackhole();
  // the page notices (or the clean close fires) and opens a new socket on the new network after ~1 s
  await sleep(kind === 'clean' ? 500 : 1000);
  const ctl2 = await path(appPort, { rttMs: 80, loss: 0 });
  let b = probe(ctl2.port, 'arena:1', `10.89.${n}.1`, token);
  const refusals: string[] = [];
  // like a player pressing Resume (the web client retries the join on a new welcome): ask again every 2 s
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    if (b.session === a.session) break;
    await sleep(2000);
    for (const e of b.events) if (e.e.startsWith('error:')) refusals.push(e.e);
    b.events = [];
    if (b.ws.readyState === WebSocket.OPEN) b.ws.send(JSON.stringify({ t: 'join', room: 'arena:1', name: 'netem', skin: 1 }));
    else b = probe(ctl2.port, 'arena:1', `10.89.${n}.1`, token);
  }
  const back = b.session === a.session;
  const r = {
    sameCoinBack: back,
    secondsUntilSameCoin: back ? Math.round((Date.now() - t0) / 100) / 10 : null,
    refusalsOnTheWay: refusals.reduce<Record<string, number>>((m, e) => ((m[e] = (m[e] ?? 0) + 1), m), {}),
    oldSocketClosedByServerAfterS: (() => {
      const c = a.events.find((e) => e.e.startsWith('close'));
      return c ? Math.round((c.at - t0) / 100) / 10 : 'not seen by the client (black hole)';
    })(),
  };
  a.ws.terminate();
  b.ws.terminate();
  ctl.close();
  ctl2.close();
  return r;
}
out['switch-clean'] = await switchDrill('clean', 1);
say(`switch-clean: ${JSON.stringify(out['switch-clean'])}`);
out['switch-blackhole'] = await switchDrill('blackhole', 2);
say(`switch-blackhole: ${JSON.stringify(out['switch-blackhole'])}`);

if (process.env.NETEM_OUT) writeFileSync(process.env.NETEM_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
