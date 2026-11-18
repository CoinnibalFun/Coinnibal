/**
 * Connection slots: guests (not signed in) hold at most GUEST_SHARE of MAX_CONNECTIONS and are limited per IP and
 * subnet; signed-in sockets (a session token offered as the `coinnibal.auth.<token>` subprotocol, or signed in after
 * the hello) are not limited per IP (carrier NAT) and take the reserve; an idle lobby guest makes room; a live-stake
 * holder's reconnect always gets in.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSE_REPLACED, PROTOCOL_VERSION } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { testSigner } from './signers';

let app: App;
let port = 0;
const saved = process.env.TRUST_PROXY;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  process.env.TRUST_PROXY = '1';
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-slots-')),
    GAME_ACCESS: 'public',
    NODE_ENV: 'development',
    MAX_CONNECTIONS: '10',
    MAX_CONNECTIONS_PER_IP: '3',
    MAX_CONNECTIONS_PER_SUBNET: '6',
  } as unknown as NodeJS.ProcessEnv);
  app = await createApp(cfg, { chain: new NullChain(), log: () => {}, persist: false });
  port = await app.listen();
});

afterAll(async () => {
  await app.close();
  if (saved === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = saved;
});

const opened: WebSocket[] = [];
function open(ip: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, token ? ['coinnibal', `coinnibal.auth.${token}`] : [], { headers: { 'X-Forwarded-For': ip } });
    opened.push(ws);
    ws.once('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      resolve(ws);
    });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}
const closeAll = async () => {
  for (const ws of opened.splice(0)) ws.close();
  for (let i = 0; i < 50 && app.rooms.conns.size > 0; i++) await sleep(20);
};
/** Makes every guest look idle (no message for a minute). */
const idleGuests = () => {
  for (const c of app.rooms.conns) if (!c.wallet) c.lastMsgAt = Date.now() - 60_000;
};

describe('connection slots', () => {
  it('guests and old clients: no subprotocol, plain `coinnibal`, or a bad token all get in as guests; the token is never echoed', async () => {
    const withProtocols = (ip: string, protocols: string[]) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers: { 'X-Forwarded-For': ip } });
        opened.push(ws);
        ws.once('open', () => {
          ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
          resolve(ws);
        });
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once('error', reject);
      });
    const none = await withProtocols('192.0.2.10', []);
    expect(none.protocol).toBe('');
    const plain = await withProtocols('192.0.2.11', ['coinnibal']);
    expect(plain.protocol).toBe('coinnibal');
    const forged = await withProtocols('192.0.2.12', ['coinnibal', 'coinnibal.auth.not-a-token']);
    expect(forged.protocol).toBe('coinnibal');
    const signed = await withProtocols('192.0.2.13', ['coinnibal', `coinnibal.auth.${app.auth.issueToken(testSigner().address)}`]);
    expect(signed.protocol).toBe('coinnibal');
    await sleep(50);
    const conns = [...app.rooms.conns];
    expect(conns.filter((c) => c.priority === 'signed')).toHaveLength(1);
    expect(conns.filter((c) => !c.priority)).toHaveLength(3);
    await closeAll();
  });

  it('a page from before the rename offers `elymum` / `elymum.auth.<token>`: answered with its own name, token honoured', async () => {
    const withProtocols = (ip: string, protocols: string[]) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers: { 'X-Forwarded-For': ip } });
        opened.push(ws);
        ws.once('open', () => {
          ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
          resolve(ws);
        });
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once('error', reject);
      });
    const old = await withProtocols('192.0.2.21', ['elymum']);
    expect(old.protocol).toBe('elymum');
    const oldSigned = await withProtocols('192.0.2.22', ['elymum', `elymum.auth.${app.auth.issueToken(testSigner().address)}`]);
    expect(oldSigned.protocol).toBe('elymum');
    const oldForged = await withProtocols('192.0.2.23', ['elymum', 'elymum.auth.not-a-token']);
    expect(oldForged.protocol).toBe('elymum');
    // both offered: the current name wins
    const both = await withProtocols('192.0.2.24', ['elymum', 'coinnibal']);
    expect(both.protocol).toBe('coinnibal');
    await sleep(50);
    const conns = [...app.rooms.conns];
    expect(conns.filter((c) => c.priority === 'signed')).toHaveLength(1);
    await closeAll();
  });

  it('guests fill at most 80 %; a signed-in socket still gets in; an idle guest makes room for a newcomer', async () => {
    for (let i = 0; i < 8; i++) await open(`198.51.${i}.1`);
    await expect(open('198.51.100.1')).rejects.toThrow(/HTTP 429/);
    // a signed-in player (its token as the subprotocol) takes the reserve
    const signed = await open('198.51.101.1', app.auth.issueToken(testSigner().address));
    expect(signed.protocol).toBe('coinnibal');
    expect(app.rooms.conns.size).toBe(9);
    // the lobby guests went quiet: a new one takes the slot of the longest idle
    idleGuests();
    const evicted = new Promise<number>((r) => opened[0].once('close', (code) => r(code)));
    await open('198.51.102.1');
    expect(await evicted).toBe(1013);
    expect(app.gateway.dropped.idle).toBeGreaterThanOrEqual(1);
    await closeAll();
  });

  it('carrier NAT: sockets that signed in no longer count in their IP limit; a session token is never limited per IP', async () => {
    const nat = '203.0.113.50';
    const g = [await open(nat), await open(nat), await open(nat)];
    await expect(open(nat)).rejects.toThrow(/HTTP 429/);
    // one of them signs in: its IP slot is free for the next guest
    g[0].send(JSON.stringify({ t: 'auth', token: app.auth.issueToken(testSigner().address) }));
    await sleep(100);
    await open(nat);
    // with a token, more players from that address get in
    for (let i = 0; i < 3; i++) await open(nat, app.auth.issueToken(testSigner().address));
    expect(app.rooms.conns.size).toBe(7);
    await closeAll();
  });

  it('signed-in sockets are bounded per IPv6 /64 and per /48, not per address', async () => {
    const { SIGNED_PER_IP_FACTOR } = await import('../src/net/gateway');
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-slots6-')), GAME_ACCESS: 'public', NODE_ENV: 'development', MAX_CONNECTIONS: '200', MAX_CONNECTIONS_PER_IP: '1', MAX_CONNECTIONS_PER_SUBNET: '2' } as unknown as NodeJS.ProcessEnv);
    const other = await createApp(cfg, { chain: new NullChain(), log: () => {}, persist: false });
    const p2 = await other.listen();
    const socks: WebSocket[] = [];
    const tryOpen = (ip: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws`, ['coinnibal', `coinnibal.auth.${other.auth.issueToken(testSigner().address)}`], { headers: { 'X-Forwarded-For': ip } });
        socks.push(ws);
        ws.on('error', () => {});
        ws.once('open', () => resolve('open'));
        ws.once('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
      });
    try {
      // a new address of one /64 (and a new throwaway wallet) for every socket: the /64 holds 1 x 8
      const one64: (number | 'open')[] = [];
      for (let i = 0; i < SIGNED_PER_IP_FACTOR + 2; i++) one64.push(await tryOpen(`2001:db8:1:1::${(i + 1).toString(16)}`));
      expect(one64.filter((g) => g === 'open')).toHaveLength(SIGNED_PER_IP_FACTOR);
      expect(one64.at(-1)).toBe(429);
      // more /64s of the same /48: the /48 holds 2 x 8 in all
      const one48: (number | 'open')[] = [];
      for (let i = 0; i < SIGNED_PER_IP_FACTOR + 2; i++) one48.push(await tryOpen(`2001:db8:1:${(i + 2).toString(16)}::1`));
      expect(one48.filter((g) => g === 'open')).toHaveLength(SIGNED_PER_IP_FACTOR);
      // another customer's /48 is not affected
      expect(await tryOpen('2001:db8:2:1::1')).toBe('open');
    } finally {
      for (const ws of socks) ws.terminate();
      await other.close();
    }
  });

  it('one address signing in with many throwaway wallets is still bounded (8 x the guest limit per IP)', async () => {
    const { SIGNED_PER_IP_FACTOR } = await import('../src/net/gateway');
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-slots2-')), GAME_ACCESS: 'public', NODE_ENV: 'development', MAX_CONNECTIONS: '100', MAX_CONNECTIONS_PER_IP: '1' } as unknown as NodeJS.ProcessEnv);
    const other = await createApp(cfg, { chain: new NullChain(), log: () => {}, persist: false });
    const p2 = await other.listen();
    const socks: WebSocket[] = [];
    const tryOpen = (token: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p2}/ws`, ['coinnibal', `coinnibal.auth.${token}`], { headers: { 'X-Forwarded-For': '203.0.113.77' } });
        socks.push(ws);
        ws.on('error', () => {});
        ws.once('open', () => resolve('open'));
        ws.once('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
      });
    try {
      const got: (number | 'open')[] = [];
      for (let i = 0; i < SIGNED_PER_IP_FACTOR + 1; i++) got.push(await tryOpen(other.auth.issueToken(testSigner().address)));
      expect(got.filter((g) => g === 'open')).toHaveLength(SIGNED_PER_IP_FACTOR);
      expect(got.at(-1)).toBe(429);
    } finally {
      for (const ws of socks) ws.terminate();
      await other.close();
    }
  });

  it('one session token holds at most SOCKETS_PER_WALLET sockets: a newer one replaces the oldest (CLOSE_REPLACED)', async () => {
    const { SOCKETS_PER_WALLET } = await import('../src/net/gateway');
    const token = app.auth.issueToken(testSigner().address);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ws = await open(`198.18.0.${i + 1}`, token);
      ws.once('close', (code) => codes.push(code));
    }
    await sleep(100);
    // the server holds 3 of them, however many the token opened; the rest were told they were replaced
    expect(app.rooms.conns.size).toBe(SOCKETS_PER_WALLET);
    expect(codes.filter((c) => c === CLOSE_REPLACED)).toHaveLength(8 - SOCKETS_PER_WALLET);
    // the same after a guest signs in with that token
    const g = await open('198.18.1.1');
    g.send(JSON.stringify({ t: 'auth', token }));
    await sleep(100);
    expect(app.rooms.conns.size).toBe(SOCKETS_PER_WALLET);
    // a guest elsewhere still gets in
    await open('198.18.2.1');
    expect(app.rooms.conns.size).toBe(SOCKETS_PER_WALLET + 1);
    await closeAll();
  });

  it('a ticket holder\'s token cannot fill the server: 3 sockets per wallet, and past the cap one headroom slot', async () => {
    const holder = testSigner().address;
    const real = app.rooms.holdsLiveStake.bind(app.rooms);
    app.rooms.holdsLiveStake = (w: string) => w === holder || real(w);
    try {
      const token = app.auth.issueToken(holder);
      // one address, one stake token, a flood of upgrades: the server keeps 3, every other slot stays free
      for (let i = 0; i < 12; i++) await open('192.0.2.77', token);
      await sleep(100);
      expect(app.rooms.conns.size).toBe(3);
      // signed-in players fill every slot; the holder's own sockets are swapped, never added past the cap
      for (let i = 0; i < 7; i++) await open(`192.0.2.${100 + i}`, app.auth.issueToken(testSigner().address));
      expect(app.rooms.conns.size).toBe(10);
      for (let i = 0; i < 8; i++) await open('192.0.2.77', token);
      await sleep(100);
      expect(app.rooms.conns.size).toBe(10);
      await expect(open('192.0.2.201', app.auth.issueToken(testSigner().address))).rejects.toThrow(/HTTP 429/);
      // and the wallet's upgrades are rate-limited (20 a minute) like everyone's
      await expect(open('192.0.2.78', token)).rejects.toThrow(/HTTP 429/);
    } finally {
      app.rooms.holdsLiveStake = real;
    }
    await closeAll();
  });

  it('a ticket holder reconnecting always gets in, even when every slot is taken by signed-in players', async () => {
    for (let i = 0; i < 10; i++) await open(`192.0.2.${i}`, app.auth.issueToken(testSigner().address));
    await expect(open('192.0.2.200', app.auth.issueToken(testSigner().address))).rejects.toThrow(/HTTP 429/);
    await expect(open('192.0.2.201')).rejects.toThrow(/HTTP 429/);
    const holder = testSigner().address;
    const real = app.rooms.holdsLiveStake.bind(app.rooms);
    app.rooms.holdsLiveStake = (w: string) => w === holder || real(w);
    try {
      await open('192.0.2.202', app.auth.issueToken(holder));
      expect(app.rooms.conns.size).toBe(11);
    } finally {
      app.rooms.holdsLiveStake = real;
    }
    await closeAll();
  });
});

describe('HTTP limits per client (an IPv6 client is its /64)', () => {
  it('sign-in nonces: a new address of one /64 for every request still meets the per-client limit', async () => {
    const nonce = (ip: string) =>
      fetch(`http://127.0.0.1:${port}/api/auth/nonce?address=${testSigner().address}`, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.status);
    const got: number[] = [];
    for (let i = 0; i < 21; i++) got.push(await nonce(`2001:db8:77:1:${i.toString(16)}::1`));
    expect(got.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(got[20]).toBe(429);
    // another /64 (another customer) and an IPv4 client are not affected
    expect(await nonce('2001:db8:77:2::1')).toBe(200);
    expect(await nonce('198.51.100.99')).toBe(200);
  });

  it('the site limits (here the sign-in POST) count the /64 too', async () => {
    const login = (ip: string) =>
      fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: '{}' }).then((r) => r.status);
    const got: number[] = [];
    for (let i = 0; i < 40; i++) got.push(await login(`2001:db8:78:1::${(i + 1).toString(16)}`));
    expect(got).toContain(429);
    expect(await login('2001:db8:78:2::1')).toBe(401);
  });
});
