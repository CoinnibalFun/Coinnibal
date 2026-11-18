/**
 * Edge-abuse checks that `flood.ts` does not cover, against the real app (DEV_FAKE_CHAIN, production limits:
 * MAX_CONNECTIONS 600, 8 per IP, 48 per /24, 4 KB frames, the load shedder on). One trusted proxy hop, as behind
 * Caddy, so X-Forwarded-For names the attacker's addresses.
 *
 * 1. oversized frames: a 5 KB and a 1 MB WebSocket frame;
 * 2. many wallets from one IP: 12 signed-in wallets from one address;
 * 3. slot exhaustion: sockets that DO say hello and then idle (the 10 s hello timeout does not apply; ws answers
 *    the server's pings by itself), from 14 /24 networks x 48, until the server refuses them; then can a real
 *    player still connect (a guest, and signed in with its session token as the `elymum.auth.<token>`
 *    subprotocol), can a ticket holder with a live coin still resume (without and with the token), and does a guest
 *    get in once the attackers idled past IDLE_GUEST_MS? MAX_CONNECTIONS stays 600 here, as when it was measured.
 *
 *   node --import tsx scripts/bench/edge-abuse.ts      (from apps/server)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@coinnibal/shared';
import { getAddress } from 'viem';
import WebSocket from 'ws';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
process.env.TRUST_PROXY = '1';
const dir = mkdtempSync(join(tmpdir(), 'elymum-edge-'));
const cfg = loadConfig({ NODE_ENV: 'development', DEV_FAKE_CHAIN: '1', DEV_FAKE_TOKEN: '1', PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, GAME_ACCESS: 'public', LOAD_SHED: '1', GAME_WORKERS: '1', MAX_CONNECTIONS: '600' } as unknown as NodeJS.ProcessEnv);
const app = await createApp(cfg, { log: () => {} });
const port = await app.listen();
await app.rooms.ensureArenaRooms();

function open(ip: string, onMsg?: (m: { t: string; code?: string }) => void, token?: string): Promise<{ ws: WebSocket; status: 'open' | number | string; closed: Promise<number> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, token ? ['elymum', `elymum.auth.${token}`] : [], { perMessageDeflate: false, headers: { 'x-forwarded-for': ip } });
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
  // a ticket holder whose coin plays on (AFK) while its phone is away
  const holder = getAddress(`0x${'7e'.repeat(20)}`);
  const holderToken = app.auth.issueToken(holder);
  {
    const msgs: { t: string; code?: string }[] = [];
    const h = await open('192.0.2.20', (m) => msgs.push(m));
    h.ws.send(JSON.stringify({ t: 'auth', token: holderToken }));
    await sleep(300);
    h.ws.send(JSON.stringify({ t: 'join', room: 'arena:1', name: 'holder', skin: 0 }));
    for (let i = 0; i < 40 && !msgs.some((m) => m.t === 'joined'); i++) await sleep(100);
    h.ws.terminate();
    await sleep(300);
  }
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
  const signed = await open('192.0.2.12', undefined, app.auth.issueToken(getAddress(`0x${'5e'.repeat(20)}`)));
  const ticketWithToken = await open('192.0.2.13', undefined, holderToken);
  // the attackers' sockets idle past IDLE_GUEST_MS: a newcomer takes the slot of the longest-idle one
  await sleep(20_000);
  const playerLater = await open('192.0.2.14');
  out.slotExhaustion = {
    maxConnections: cfg.maxConnections,
    attackerSocketsOpen: stillOpen,
    attackerIpsUsed: 14 * 6,
    attackerNetworks: 14,
    refusedAttackerSockets: refused,
    secondsToFill: Math.round((Date.now() - t0) / 1000),
    newPlayerStatus: player.status,
    ticketHolderStatus: ticket.status,
    signedInPlayerWithTokenStatus: signed.status,
    ticketHolderWithTokenStatus: ticketWithToken.status,
    newPlayerAfterAttackersIdled32sStatus: playerLater.status,
    idleGuestsEvicted: app.gateway.dropped.idle,
  };
  for (const w of held) w.terminate();
  for (const s of [player, ticket, signed, ticketWithToken, playerLater]) s.ws.terminate();
}

console.log(JSON.stringify(out, null, 2));
if (process.env.EDGE_OUT) writeFileSync(process.env.EDGE_OUT, JSON.stringify(out, null, 2));
await app.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
