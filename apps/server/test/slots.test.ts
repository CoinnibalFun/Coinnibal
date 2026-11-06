/**
 * Connection slots: guests (not signed in) hold at most GUEST_SHARE of MAX_CONNECTIONS and are limited per IP and
 * subnet; signed-in sockets (a session token offered as the `elymum.auth.<token>` subprotocol, or signed in after
 * the hello) are not limited per IP (carrier NAT) and take the reserve; an idle lobby guest makes room; a live-stake
 * holder's reconnect always gets in.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@elymum/shared';
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
    DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-slots-')),
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, token ? ['elymum', `elymum.auth.${token}`] : [], { headers: { 'X-Forwarded-For': ip } });
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
  it('guests fill at most 80 %; a signed-in socket still gets in; an idle guest makes room for a newcomer', async () => {
    for (let i = 0; i < 8; i++) await open(`198.51.${i}.1`);
    await expect(open('198.51.100.1')).rejects.toThrow(/HTTP 429/);
    // a signed-in player (its token as the subprotocol) takes the reserve
    const signed = await open('198.51.101.1', app.auth.issueToken(testSigner().address));
    expect(signed.protocol).toBe('elymum');
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
