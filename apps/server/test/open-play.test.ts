import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type ChainStatus, type GameAccess, type ServerMessage } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

/** The open-play copy of the site (OPEN_PLAY_ORIGINS) and the main site. */
const COPY = 'https://coinnibal.vercel.app';
const MAIN = 'https://coinnibal.fun';

/** The test chain on another chain id (the mainnet: 4663). */
class ChainOn extends ArenaChain {
  constructor(private readonly id: number) {
    super([arena(1, 1000)]);
  }
  override status(): ChainStatus {
    return { ...super.status(), chainId: this.id };
  }
}

const roomy = () => new Limiter(10_000, 60_000);

interface Harness {
  app: App;
  port: number;
  dir: string;
  admin: string;
  call(method: string, path: string, opts?: { wallet?: string; origin?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /** A guest socket (with the page's `Origin` when given): the reply to a practice join. */
  practice(origin?: string): Promise<ServerMessage>;
}

async function harness(opts: { chainId?: number; access?: GameAccess } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-open-play-'));
  const admin = testSigner().address;
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0', CORS_ORIGIN: MAIN } as NodeJS.ProcessEnv);
  const app = await createApp(cfg, {
    chain: opts.chainId === undefined ? new ArenaChain([arena(1, 1000)]) : new ChainOn(opts.chainId),
    log: () => {},
    persist: true,
    siteLimits: { writeIp: roomy(), writeWallet: roomy(), login: roomy() },
    apiLimiter: roomy(),
  });
  if (opts.access) app.site.store.updateSettings({ gameAccess: opts.access });
  const port = await app.listen();
  const call: Harness['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.origin) headers.Origin = o.origin;
    if (o.wallet) headers.Authorization = `Bearer ${app.auth.issueToken(o.wallet)}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
  const practice: Harness['practice'] = async (origin) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, binary) => {
      if (!binary) msgs.push(JSON.parse(String(d)) as ServerMessage);
    });
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    const wait = async (pick: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
      const until = Date.now() + 3000;
      for (;;) {
        const m = msgs.find(pick);
        if (m) return m;
        if (Date.now() > until) throw new Error(`no reply: ${JSON.stringify(msgs.map((x) => x.t))}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      await wait((m) => m.t === 'welcome');
      ws.send(JSON.stringify({ t: 'join', room: 'practice', name: 'copy', skin: 0 }));
      return await wait((m) => m.t === 'joined' || m.t === 'error');
    } finally {
      ws.close();
    }
  };
  return { app, port, dir, admin, call, practice };
}

const done = async (h: Harness) => {
  await h.app.close();
  rmSync(h.dir, { recursive: true, force: true });
};

describe('the open-play copy of the site (OPEN_PLAY_ORIGINS) on a testnet', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => done(h));

  it('sees the game open to everyone; the main site and a request without an Origin keep the admin setting', async () => {
    expect((await h.call('GET', '/api/site/settings', { origin: COPY })).body.settings.gameAccess).toBe('public');
    expect((await h.call('GET', '/api/site/settings', { origin: `${COPY}/` })).body.settings.gameAccess).toBe('public');
    expect((await h.call('GET', '/api/site/settings', { origin: MAIN })).body.settings.gameAccess).toBe('admins');
    expect((await h.call('GET', '/api/site/settings')).body.settings.gameAccess).toBe('admins');
    expect((await h.call('GET', '/api/site/settings', { origin: 'https://evil-coinnibal.vercel.app' })).body.settings.gameAccess).toBe('admins');
    // the admin's own setting is untouched
    expect((await h.call('GET', '/api/admin/settings', { wallet: h.admin, origin: COPY })).body.settings.gameAccess).toBe('admins');
    expect((await h.call('GET', '/api/site/mint', { origin: COPY })).body.gameAccess).toBe('public');
    expect((await h.call('GET', '/api/site/mint')).body.gameAccess).toBe('admins');
  });

  it('lets a player in from the copy: the session check, the shop, room quotes and practice rooms, the faucet', async () => {
    const player = testSigner().address;
    expect((await h.call('GET', '/api/auth/me', { wallet: player, origin: COPY })).body).toMatchObject({ canPlay: true });
    expect((await h.call('GET', '/api/auth/me', { wallet: player, origin: MAIN })).body).toMatchObject({ canPlay: false });
    for (const path of ['/api/shop', '/api/rooms/custom/quote', '/api/site/faucet']) {
      expect((await h.call('GET', path, { wallet: player, origin: COPY })).body?.error, path).not.toBe('game_closed');
      expect((await h.call('GET', path, { origin: COPY })).body?.error, `${path} guest`).not.toBe('game_closed');
      expect((await h.call('GET', path, { wallet: player, origin: MAIN })).body?.error, `${path} main`).toBe('game_closed');
    }
    expect((await h.call('POST', '/api/rooms/custom/practice', { origin: COPY })).body?.error).not.toBe('game_closed');
    expect((await h.call('POST', '/api/rooms/custom/practice', { origin: MAIN })).body?.error).toBe('game_closed');
    // a ticket permit: past the game gate from the copy (then judged as usual), refused from the main site
    const permit = (origin: string) => h.call('POST', '/api/arena/permit', { wallet: player, origin, body: { arenaId: 1 } });
    expect((await permit(COPY)).body?.error).not.toBe('game_closed');
    expect((await permit(MAIN)).body?.error).toBe('game_closed');
  });

  it('opens a game socket from the copy (its Origin rides on the connection), not one from the main site', async () => {
    expect((await h.practice(COPY)).t).toBe('joined');
    expect(await h.practice(MAIN)).toMatchObject({ t: 'error', code: 'game_closed' });
    expect(await h.practice()).toMatchObject({ t: 'error', code: 'game_closed' });
  });

  it('answers CORS for the copy and names it in its own sign-in', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/site/settings`, { headers: { Origin: COPY } });
    expect(res.headers.get('access-control-allow-origin')).toBe(COPY);
    const player = testSigner().address;
    const nonce = await fetch(`http://127.0.0.1:${h.port}/api/auth/nonce?address=${player}`, { headers: { Origin: COPY } }).then((r) => r.json());
    expect(nonce.message).toMatch(/^coinnibal\.vercel\.app wants you to sign in/);
  });
});

describe('the open-play copy never opens the game', () => {
  it('in maintenance', async () => {
    const h = await harness({ access: 'maintenance' });
    try {
      expect((await h.call('GET', '/api/site/settings', { origin: COPY })).body.settings.gameAccess).toBe('maintenance');
      expect(await h.practice(COPY)).toMatchObject({ t: 'error', code: 'game_closed' });
    } finally {
      await done(h);
    }
  });

  it('on the mainnet (the copy follows the main site: holders here)', async () => {
    const h = await harness({ chainId: 4663, access: 'holders' });
    try {
      expect((await h.call('GET', '/api/site/settings', { origin: COPY })).body.settings.gameAccess).toBe('holders');
      expect((await h.call('GET', '/api/auth/me', { wallet: testSigner().address, origin: COPY })).body).toMatchObject({ canPlay: false });
      expect(await h.practice(COPY)).toMatchObject({ t: 'error', code: 'game_closed' });
    } finally {
      await done(h);
    }
  });
});
