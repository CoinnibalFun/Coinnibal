/**
 * DDoS and abuse limits of the front door, against the real app on a socket: sockets that never say hello,
 * per-IP and per-subnet connection caps, upgrade storms, message floods and garbage, HTTP slowloris timeouts,
 * oversized bodies, the CORS allow-list and the micro-cached public reads; the load shedder's levels.
 */
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { HTTP_TIMEOUTS, corsAllow } from '../src/http';
import { STRIKE_LIMIT } from '../src/net/conn';
import { subnetOf } from '../src/net/gateway';
import { LoadShedder, SHED_THRESHOLDS } from '../src/net/shedder';

let app: App;
let port = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-abuse-')),
    GAME_ACCESS: 'public',
    NODE_ENV: 'development',
    WS_HELLO_TIMEOUT_MS: '400',
    MAX_CONNECTIONS_PER_IP: '6',
    MAX_CONNECTIONS_PER_SUBNET: '6',
    CORS_ORIGIN: 'https://elymum.io,https://www.elymum.io',
  } as unknown as NodeJS.ProcessEnv);
  app = await createApp(cfg, { chain: new NullChain(), log: () => {}, persist: false });
  port = await app.listen();
});

afterAll(async () => {
  await app.close();
});

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}
const closed = (ws: WebSocket) => new Promise<number>((r) => (ws.readyState === WebSocket.CLOSED ? r(-1) : ws.once('close', (code) => r(code))));

describe('WebSocket front door', () => {
  it('closes a socket that never says hello; a client that does stays', async () => {
    const idle = await open();
    const good = await open();
    good.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    const t0 = Date.now();
    await closed(idle);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await sleep(100);
    expect(good.readyState).toBe(WebSocket.OPEN);
    good.close();
  });

  it('caps sockets per IP (and per subnet): the 7th is refused with 429, a closed one frees its slot', async () => {
    const socks: WebSocket[] = [];
    for (let i = 0; i < 6; i++) {
      const ws = await open();
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      socks.push(ws);
    }
    await expect(open()).rejects.toThrow(/HTTP 429/);
    socks.pop()!.close();
    await sleep(100);
    const again = await open();
    socks.push(again);
    for (const s of socks) s.close();
    await sleep(100);
  });

  it('closes a connection that floods messages or sends garbage, before it costs the rooms anything', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    await sleep(50);
    const done = closed(ws);
    // ~3x the token bucket's burst of malformed text, then garbage binary frames
    for (let i = 0; i < STRIKE_LIMIT + 50; i++) ws.send(i % 2 ? 'not json {' : Buffer.from([0xff, 0x00, 0x13]));
    expect(await done).toBe(1008);
  });

  it('a well-behaved client at 30 inputs a second is never closed', async () => {
    const ws = await open();
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ t: 'join', room: 'practice', name: 'calm', skin: 1 }));
    let closedEarly = false;
    ws.once('close', () => (closedEarly = true));
    for (let i = 0; i < 60; i++) {
      ws.send(JSON.stringify({ t: 'ping', ts: i }));
      await sleep(33);
    }
    expect(closedEarly).toBe(false);
    ws.close();
  });

  it('the per-subnet key: IPv4 /24, IPv6 /64, IPv4-mapped IPv6 as IPv4', () => {
    expect(subnetOf('203.0.113.77')).toBe('203.0.113.0/24');
    expect(subnetOf('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
    expect(subnetOf('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(subnetOf('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(subnetOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(subnetOf('2001:0db8:00aa:00bb:0000::1')).toBe('2001:db8:aa:bb::/64');
  });
});

describe('HTTP front door', () => {
  it('drops a slowloris client that never finishes its headers', { timeout: 15_000 }, async () => {
    const srv = app.server;
    expect(srv.headersTimeout).toBe(HTTP_TIMEOUTS.headersMs);
    expect(srv.requestTimeout).toBe(HTTP_TIMEOUTS.requestMs);
    expect(srv.keepAliveTimeout).toBe(HTTP_TIMEOUTS.keepAliveMs);
    // shorten it for the test: the same mechanism Node enforces
    const before = srv.headersTimeout;
    srv.headersTimeout = 300;
    srv.requestTimeout = 300;
    const sock = connect(port, '127.0.0.1');
    try {
      await new Promise((r) => sock.once('connect', r));
      sock.write('GET /api/health HTTP/1.1\r\nHost: x\r\n');
      const t0 = Date.now();
      const out = await new Promise<string>((resolve) => {
        let data = '';
        sock.on('data', (d) => (data += d));
        sock.on('close', () => resolve(data));
        const drip = setInterval(() => sock.writable && sock.write('X-a: b\r\n'), 100);
        sock.on('close', () => clearInterval(drip));
      });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(out).toMatch(/408|^$/);
    } finally {
      sock.destroy();
      srv.headersTimeout = before;
      srv.requestTimeout = HTTP_TIMEOUTS.requestMs;
    }
  });

  it('refuses an oversized JSON body before reading it', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: 'x'.repeat(2_000_000) });
    expect([401, 413]).toContain(r.status);
  });

  it('answers CORS for the allowed origins only (bearer tokens, never cookies)', async () => {
    expect(corsAllow('*', 'https://evil.example')).toBe('*');
    expect(corsAllow('https://elymum.io, https://www.elymum.io/', 'https://www.elymum.io')).toBe('https://www.elymum.io');
    expect(corsAllow('https://elymum.io', 'https://evil.example')).toBeNull();
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Origin: 'https://elymum.io' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://elymum.io');
    expect(ok.headers.get('vary')).toMatch(/Origin/);
    const no = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('builds a public read at most once a second however often it is asked', async () => {
    const lb = app.leaderboards as unknown as { snapshot: () => unknown };
    const real = lb.snapshot.bind(lb);
    let builds = 0;
    lb.snapshot = () => {
      builds++;
      return real();
    };
    await Promise.all(Array.from({ length: 50 }, () => fetch(`http://127.0.0.1:${port}/api/leaderboard`).then((r) => r.text())));
    expect(builds).toBeLessThanOrEqual(2);
    lb.snapshot = real;
  });
});

describe('load shedder', () => {
  it('sheds free games first, then sockets and seats; eases off only after two calm samples', () => {
    let tick: number | null = 5;
    const s = new LoadShedder({ bestTickP95Ms: () => tick });
    expect(s.sample(10)).toBe('ok');
    expect(s.admitFree() && s.admitCritical()).toBe(true);
    tick = SHED_THRESHOLDS.busy.tickP95Ms + 1;
    expect(s.sample(10)).toBe('busy');
    expect(s.admitFree()).toBe(false);
    expect(s.admitCritical()).toBe(true);
    expect(s.sample(SHED_THRESHOLDS.critical.lagP99Ms + 1)).toBe('critical');
    expect(s.admitCritical()).toBe(false);
    tick = 5;
    expect(s.sample(10)).toBe('critical');
    expect(s.sample(10)).toBe('ok');
    expect(s.refused).toEqual({ busy: 1, critical: 1 });
    tick = null;
    expect(s.sample(0)).toBe('ok');
  });
});
