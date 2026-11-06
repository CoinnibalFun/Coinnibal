/**
 * Edge-abuse checks that `flood.ts` does not cover, against the real app (DEV_FAKE_CHAIN, production limits:
 * MAX_CONNECTIONS 600, 8 per IP, 48 per /24, 4 KB frames, the load shedder on). One trusted proxy hop, as behind
 * Caddy, so X-Forwarded-For names the attacker's addresses.
 *
 * 1. oversized frames: a 5 KB and a 1 MB WebSocket frame;
 * 2. many wallets from one IP: 12 signed-in wallets from one address;
 * 3. slot exhaustion: sockets that DO say hello and then idle (the 10 s hello timeout does not apply; ws answers
 *    the server's pings by itself), from 13 /24 networks x 48, until MAX_CONNECTIONS is reached; then can a real
 *    player still connect, and can a ticket holder still resume?
 *
 *   node --import tsx scripts/bench/edge-abuse.ts      (from apps/server)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@elymum/shared';
import { getAddress } from 'viem';
import WebSocket from 'ws';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
process.env.TRUST_PROXY = '1';
const dir = mkdtempSync(join(tmpdir(), 'elymum-edge-'));
const cfg = loadConfig({ NODE_ENV: 'development', DEV_FAKE_CHAIN: '1', DEV_FAKE_TOKEN: '1', PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, GAME_ACCESS: 'public', LOAD_SHED: '1', GAME_WORKERS: '1' } as unknown as NodeJS.ProcessEnv);
const app = await createApp(cfg, { log: () => {} });
const port = await app.listen();
await app.rooms.ensureArenaRooms();

function open(ip: string, onMsg?: (m: { t: string; code?: string }) => void): Promise<{ ws: WebSocket; status: 'open' | number | string; closed: Promise<number> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false, headers: { 'x-forwarded-for': ip } });
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      resolve({ ws, status: 'open', closed });
    });
    ws.on('message', (d: Buffer, bin: boolean) => !bin && onMsg?.(JSON.parse(d.toString())));
    ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0, closed }));
    ws.on('error', (e) => resolve({ ws, status: (e as Error).message, closed }));
  });
}

const out: Record<string, unknown> = {};

// 1. oversized frames
{
  const a = await open('10.1.0.1');
  a.ws.send(Buffer.alloc(5 * 1024, 1));
  const c1 = await Promise.race([a.closed, sleep(3000).then(() => 'still open')]);
  const b = await open('10.1.0.2');
  b.ws.send(Buffer.alloc(1024 * 1024, 1));
  const c2 = await Promise.race([b.closed, sleep(3000).then(() => 'still open')]);
  out.oversized = { frame5KB: `close ${c1}`, frame1MB: `close ${c2}` };
}

// 2. many wallets from one IP
{
  const res: string[] = [];
  const socks: WebSocket[] = [];
  for (let i = 0; i < 12; i++) {
    const w = getAddress(`0x${(0x7000 + i).toString(16).padStart(8, '0')}${'aa'.repeat(16)}`);
    const s = await open('10.2.0.1');
    if (s.status === 'open') {
      s.ws.send(JSON.stringify({ t: 'auth', token: app.auth.issueToken(w) }));
      socks.push(s.ws);
    }
    res.push(String(s.status));
  }
  out.manyWalletsOneIp = { attempts: 12, results: res.reduce<Record<string, number>>((m, r) => ((m[r] = (m[r] ?? 0) + 1), m), {}) };
  for (const s of socks) s.terminate();
}

// 3. slot exhaustion with hello'd idle sockets
{
  const held: WebSocket[] = [];
  let refused = 0;
  const t0 = Date.now();
  for (let net = 0; net < 14 && held.length < cfg.maxConnections; net++) {
    const batch = await Promise.all(Array.from({ length: 48 }, (_, h) => open(`10.3.${net}.${(h % 6) + 1}`)));
    for (const s of batch) (s.status === 'open' ? held.push(s.ws) : refused++);
  }
  await sleep(12_000); // past the hello timeout: the sockets said hello, they stay
  const stillOpen = held.filter((w) => w.readyState === WebSocket.OPEN).length;
  const player = await open('192.0.2.10');
  const ticket = await open('192.0.2.11');
  out.slotExhaustion = {
    maxConnections: cfg.maxConnections,
    attackerSocketsOpen: stillOpen,
    attackerIpsUsed: 14 * 6,
    attackerNetworks: 14,
    refusedAttackerSockets: refused,
    secondsToFill: Math.round((Date.now() - t0) / 1000),
    newPlayerStatus: player.status,
    ticketHolderStatus: ticket.status,
  };
  for (const w of held) w.terminate();
  player.ws.terminate();
  ticket.ws.terminate();
}

console.log(JSON.stringify(out, null, 2));
if (process.env.EDGE_OUT) writeFileSync(process.env.EDGE_OUT, JSON.stringify(out, null, 2));
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
