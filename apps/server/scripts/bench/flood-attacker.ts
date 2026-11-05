/**
 * Abuse traffic for `flood.ts` (a child process). Each attack spoofs its client address with X-Forwarded-For, which
 * the server under test trusts (TRUST_PROXY=1): that stands for many attacking machines behind one proxy hop, the
 * way Caddy hands the real address on. In production Caddy writes that header itself, so a real attacker cannot.
 *
 * IPC: `{ t: 'run', kind, url, seconds }` → `{ t: 'done', kind, stats }`.
 */
import { connect } from 'node:net';
import { PROTOCOL_VERSION } from '@elymum/shared';
import WebSocket from 'ws';

type Kind = 'idle-sockets' | 'message-flood' | 'http-flood' | 'slowloris';

const rnd = (n: number) => Math.floor(Math.random() * n);
/** An address in one of 64 /16s (so most land in different /24s: the per-IP and per-subnet caps alone do not hold). */
const ip = () => `10.${rnd(64)}.${rnd(256)}.${1 + rnd(254)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function idleSockets(url: string, seconds: number) {
  const s = { tried: 0, opened: 0, refused: 0, closedByServer: 0 };
  const end = Date.now() + seconds * 1000;
  const live = new Set<WebSocket>();
  while (Date.now() < end) {
    for (let i = 0; i < 40; i++) {
      s.tried++;
      const ws = new WebSocket(url, { headers: { 'X-Forwarded-For': ip() } });
      ws.on('open', () => {
        s.opened++;
        live.add(ws);
      });
      ws.on('unexpected-response', () => s.refused++);
      ws.on('error', () => {});
      ws.on('close', () => {
        if (live.delete(ws)) s.closedByServer++;
      });
    }
    await sleep(50);
  }
  for (const ws of live) ws.terminate();
  return s;
}

async function messageFlood(url: string, seconds: number) {
  const s = { sockets: 0, sent: 0, closedByServer: 0 };
  const socks: WebSocket[] = [];
  for (let i = 0; i < 40; i++) {
    const ws = new WebSocket(url, { headers: { 'X-Forwarded-For': ip() } });
    ws.on('error', () => {});
    ws.on('close', () => s.closedByServer++);
    ws.on('open', () => {
      s.sockets++;
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      ws.send(JSON.stringify({ t: 'join', room: 'practice', name: 'flood', skin: 1 }));
    });
    socks.push(ws);
  }
  const end = Date.now() + seconds * 1000;
  const junk = [JSON.stringify({ t: 'chat', text: 'spam' }), '{"t":', Buffer.from([1, 2, 3, 4]), JSON.stringify({ t: 'viewport', w: 1, h: 1 })];
  while (Date.now() < end) {
    for (const ws of socks) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      for (let k = 0; k < 40; k++) {
        ws.send(junk[rnd(junk.length)]);
        s.sent++;
      }
    }
    await sleep(10);
  }
  for (const ws of socks) ws.terminate();
  return s;
}

async function httpFlood(url: string, seconds: number) {
  const base = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const s = { sent: 0, ok: 0, limited: 0, other: 0 };
  const end = Date.now() + seconds * 1000;
  const paths = ['/api/rooms', '/api/leaderboard', '/api/config', '/api/health', '/api/auth/nonce?address=0x0000000000000000000000000000000000000001', '/share/AAAAAAAAAA.png'];
  const worker = async () => {
    // a few addresses per worker: the per-IP limits do their part, the micro-cache the rest
    const mine = Array.from({ length: 3 }, ip);
    while (Date.now() < end) {
      s.sent++;
      try {
        const r = await fetch(base + paths[rnd(paths.length)], { headers: { 'X-Forwarded-For': mine[rnd(mine.length)] } });
        await r.arrayBuffer();
        if (r.status === 429) s.limited++;
        else if (r.ok) s.ok++;
        else s.other++;
      } catch {
        s.other++;
      }
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  return s;
}

async function slowloris(url: string, seconds: number) {
  const { hostname, port } = new URL(url.replace(/^ws/, 'http'));
  const s = { opened: 0, droppedByServer: 0 };
  const socks = new Set<ReturnType<typeof connect>>();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    for (let i = 0; i < 25 && socks.size < 400; i++) {
      const c = connect(Number(port), hostname);
      c.on('error', () => {});
      c.on('connect', () => {
        s.opened++;
        socks.add(c);
        c.write(`GET /api/health HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${ip()}\r\n`);
      });
      c.on('close', () => {
        if (socks.delete(c)) s.droppedByServer++;
      });
    }
    for (const c of socks) c.write('X-Slow: 1\r\n');
    await sleep(500);
  }
  for (const c of socks) c.destroy();
  return s;
}

process.on('message', async (m: { t: string; kind: Kind; url: string; seconds: number }) => {
  if (m.t !== 'run') return;
  const run = { 'idle-sockets': idleSockets, 'message-flood': messageFlood, 'http-flood': httpFlood, slowloris }[m.kind];
  const stats = await run(m.url, m.seconds);
  process.send!({ t: 'done', kind: m.kind, stats });
});
