/**
 * Room workers (GAME_WORKERS > 0): the rooms run in worker threads, the main thread keeps the sockets,
 * the journal and the chain. These tests drive the real app over WebSockets with two workers; the
 * whole integration suite also runs in this mode (`pnpm -F @elymum/server test:workers`).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, encodeTarget, roundAt, type ChainStatus, type ServerMessage } from '@elymum/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import type { ChainArena, ChainGateway, ChainSession, ServerKeyInfo } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { gameLoad } from '../src/rooms/load';
import { RemoteRoom } from '../src/rooms/remote/pool';
import { BoostInventory } from '../src/shop/inventory';
import { ShopService } from '../src/shop/service';
import { ShopSettingsStore } from '../src/shop/settings';
import { Journal } from '../src/stake/journal';
import { testWallet } from './helpers';

class FakeChain implements ChainGateway {
  readonly enabled = true;
  readonly tokenReady = true;
  readonly stakeEnabled = true;
  sessions = new Map<string, ChainSession>();
  kicked = 0;
  status(): ChainStatus {
    return {
      enabled: true,
      chainId: 31337,
      chainName: 'Localnet',
      rpcUrl: null,
      explorerUrl: null,
      arenaAddress: '0x00000000000000000000000000000000000A7e4A',
      nftAddress: null,
      arenasEnabled: true,
      tokenReady: true,
      token: { address: '0x0000000000000000000000000000000000000707', symbol: '$ELYMUM', decimals: 18 },
      feeBps: 500,
      serverKey: null,
    };
  }
  serverInfo(): ServerKeyInfo {
    return { address: null, balanceWei: null, low: false };
  }
  async getSession(arenaId: number, player: string) {
    return this.sessions.get(`${arenaId}:${player}`) ?? null;
  }
  async listArenas(): Promise<ChainArena[]> {
    return [
      { id: 1, entryFee: 10_000_000, maxSessions: 100, enabled: true, openSessions: 0, pot: null },
      { id: 2, entryFee: 50_000_000, maxSessions: 100, enabled: true, openSessions: 0, pot: null },
    ];
  }
  kick() {
    this.kicked++;
  }
  setLiveSessionProvider() {}
  onSettled() {}
  onStatusChange() {}
  async start() {}
  async stop() {}
}

class Client {
  msgs: ServerMessage[] = [];
  bins = 0;
  closeCode: number | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.bins++;
        return;
      }
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.msgs.push(msg);
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async open(port: number, token?: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = new Client(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.wait('welcome');
    if (token) {
      c.send({ t: 'auth', token });
      await c.wait('authed');
    }
    return c;
  }

  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }

  wait<T extends ServerMessage['t']>(t: T, timeoutMs = 5000, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) {
    const hit = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
    if (hit) return Promise.resolve(hit as Extract<ServerMessage, { t: T }>);
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
};

let seq = 500;
function ticket(player: string, arenaId = 1, entryFee = 10_000_000): ChainSession {
  const id = ++seq;
  return {
    key: `${arenaId}:${player.toLowerCase()}:${id}`,
    id,
    player,
    arenaId,
    entryFee,
    feeBps: 500,
    value: entryFee - Math.floor((entryFee * 500) / 10_000),
    openedAt: Math.floor(Date.now() / 1000),
    finalized: false,
    owed: 0,
  };
}

let app: App;
let port: number;
let chain: FakeChain;
let dir: string;
const t0 = Date.now();
let clockBase = roundAt(t0).startsAt + 2_000;
const serverNow = () => clockBase + (Date.now() - t0);
const jumpTo = (at: number) => {
  clockBase = at - (Date.now() - t0);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'elymum-workers-'));
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    BOT_TARGET: '4',
    BOT_MIN: '1',
    BOT_MAX: '4',
    GAME_ACCESS: 'public',
    NODE_ENV: 'development',
    GAME_WORKERS: '2',
  } as NodeJS.ProcessEnv);
  chain = new FakeChain();
  app = await createApp(cfg, { chain, log: () => {}, persist: true, now: serverNow });
  port = await app.listen();
});

afterAll(async () => {
  await app?.close();
});

describe('room workers', () => {
  it('places the standing rooms on both workers; practice plays over the socket', async () => {
    expect(app.rooms.pool?.size).toBe(2);
    expect(app.rooms.rooms.size).toBe(0);
    const threads = app.rooms.pool!.threads();
    expect(threads.every((t) => t.rooms > 0)).toBe(true);

    const a = await Client.open(port);
    const b = await Client.open(port);
    a.send({ t: 'join', room: 'practice', name: 'Alice', skin: 1 });
    const ja = await a.wait('joined');
    b.send({ t: 'join', room: 'practice', name: 'Bob', skin: 2 });
    const jb = await b.wait('joined');
    expect(jb.room.id).toBe(ja.room.id);
    expect(ja.room.mode).toBe('practice');
    // power-up state follows `joined` (the main thread holds the charges)
    await a.wait('boosts');
    for (let i = 0; i < 10; i++) {
      a.ws.send(encodeTarget(ja.room.width / 2, ja.room.height / 2));
      await sleep(30);
    }
    expect(a.bins).toBeGreaterThan(5);
    a.send({ t: 'chat', text: 'hello from a worker' });
    expect((await b.wait('chat', 3000, (m) => m.from === 'Alice')).text).toBe('hello from a worker');
    await a.wait('lb');
    const room = app.rooms.get(ja.room.id) as RemoteRoom;
    await until(() => room.humanCount === 2);
    a.ws.close();
    b.ws.close();
    await until(() => room.humanCount === 0);
  });

  it('an arena ticket is journaled by the main thread, settled once at the bell', async () => {
    const w = testWallet(0xa001);
    const t = ticket(w);
    chain.sessions.set(`1:${w}`, t);
    const c = await Client.open(port, app.auth.issueToken(w));
    c.send({ t: 'join', room: 'arena:1', name: 'Staker', skin: 0 });
    const j = await c.wait('joined');
    expect(j.session).toBe(t.key);
    expect(j.value).toBe(9_500_000);
    await until(() => app.journal.live().some((l) => l.session === t.key));
    expect(app.rooms.liveSessions().has(t.key)).toBe(true);
    expect(app.rooms.findArenaStake(1, w)?.entry.pid).toBe(j.playerId);
    // a second tab with the same ticket is refused while the first plays
    const c2 = await Client.open(port, app.auth.issueToken(w));
    c2.send({ t: 'join', room: 'arena:1', name: 'Again', skin: 0 });
    expect((await c2.wait('error')).code).toBe('session_busy');

    const r = roundAt(serverNow());
    jumpTo(r.endsAt + 50);
    const over = await c.wait('roundOver', 5000);
    expect(over.round).toBe(r.n);
    expect(over.payout).toBe(9_500_000);
    const items = app.journal.settlements().filter((p) => p.key === t.key);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'round', payout: 9_500_000, player: w });
    expect(app.journal.live().some((l) => l.session === t.key)).toBe(false);
    expect(chain.kicked).toBeGreaterThan(0);
    // on disk too: the journal is the only writer, on this thread
    const file = JSON.parse(readFileSync(join(dir, 'chains', '31337', 'journal.json'), 'utf8')) as { pending: { key: string }[] };
    expect(file.pending.some((p) => p.key === t.key)).toBe(true);
    app.journal.remove(t.key);
    chain.sessions.delete(`1:${w}`);
    c.ws.close();
    c2.ws.close();
  });

  it('an AFK staker reconnects into the same coin (frames of both rooms wait for the answer)', async () => {
    const w = testWallet(0xa002);
    const t = ticket(w, 2, 50_000_000);
    chain.sessions.set(`2:${w}`, t);
    const token = app.auth.issueToken(w);
    const a = await Client.open(port, token);
    a.send({ t: 'join', room: 'arena:2', name: 'Afk', skin: 0 });
    const j1 = await a.wait('joined');
    a.ws.close();
    await sleep(150);
    const b = await Client.open(port, token);
    // watching a practice pond first (another worker, maybe): the reattach moves the socket
    b.send({ t: 'spectate' });
    await b.wait('spectating');
    b.send({ t: 'join', room: 'arena:2', name: 'Afk', skin: 0 });
    const j2 = await b.wait('joined');
    expect(j2.playerId).toBe(j1.playerId);
    expect(j2.room.id).toBe(j1.room.id);
    const bins = b.bins;
    await sleep(200);
    expect(b.bins).toBeGreaterThan(bins);
    b.ws.close();
  });

  it('a crashed worker: its live tickets are settled once at their journaled value, its sockets closed, the worker respawned', async () => {
    const w = testWallet(0xa003);
    const t = ticket(w);
    chain.sessions.set(`1:${w}`, t);
    const c = await Client.open(port, app.auth.issueToken(w));
    c.send({ t: 'join', room: 'arena:1', name: 'Crashy', skin: 0 });
    const j = await c.wait('joined');
    await until(() => app.journal.live().some((l) => l.session === t.key));
    const room = app.rooms.get(j.room.id) as RemoteRoom;
    const index = room.slot.index;
    const restarts = app.rooms.pool!.threads()[index].restarts ?? 0;

    app.rooms.pool!.crash(index);
    await until(() => app.journal.settlements().some((p) => p.key === t.key));
    const items = app.journal.settlements().filter((p) => p.key === t.key);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'crash', payout: 9_500_000, player: w });
    expect(app.journal.live().some((l) => l.session === t.key)).toBe(false);
    await until(() => c.closeCode !== null);
    expect(c.closeCode).toBe(1012);

    // respawned; the standing rooms are open again
    await until(() => (app.rooms.pool!.threads()[index].restarts ?? 0) === restarts + 1 && app.rooms.pool!.threads()[index].up === true);
    await until(() => !!app.rooms.get('practice-rookie-1') && !!app.rooms.get('practice-pro-1') && !!app.rooms.get('arena-1-1'), 8000);
    // the settled ticket cannot be played again while its settlement is pending
    const back = await Client.open(port, app.auth.issueToken(w));
    back.send({ t: 'join', room: 'arena:1', name: 'Crashy', skin: 0 });
    const err = await back.wait('error');
    expect(err.code).toBe('no_session');
    expect(app.journal.settlements().filter((p) => p.key === t.key)).toHaveLength(1);
    // the respawned worker serves new games
    const p = await Client.open(port);
    p.send({ t: 'join', room: 'practice', name: 'After', skin: 0 });
    await p.wait('joined');
    app.journal.remove(t.key);
    chain.sessions.delete(`1:${w}`);
    back.ws.close();
    p.ws.close();
  });

  it('a custom room closed early evicts its players with room_closed', async () => {
    const code = app.rooms.newPrivateCode();
    app.rooms.createCustomRoom(code, {
      name: 'Party',
      maxPlayers: 6,
      bots: null,
      custom: { durationMin: 30, mapSize: 'S', bots: 0, difficulty: 'easy', food: 'normal', traps: 'normal', powerUps: false, creator: testWallet(1), createdAt: Date.now(), endsAt: Date.now() + 60_000 },
    });
    const c = await Client.open(port);
    c.send({ t: 'join', room: `private:${code}`, name: 'Guest', skin: 0 });
    await c.wait('joined');
    expect(app.rooms.closeCustomRoom(code, 'The room creator closed this room.')).toBe(true);
    const err = await c.wait('error', 3000, (m) => m.code === 'room_closed');
    expect(err.message).toMatch(/creator closed/);
    expect(app.rooms.get(`priv-${code}`)).toBeUndefined();
    c.ws.close();
  });

  it('reports per-worker load', async () => {
    await sleep(1200);
    const load = app.rooms.loadStats({ rooms: true });
    expect(load.mode).toBe('workers');
    expect(load.workers).toBe(2);
    expect(load.threads).toHaveLength(2);
    for (const t of load.threads) {
      expect(t.up).toBe(true);
      expect(t.tick.n).toBeGreaterThan(0);
      expect(Array.isArray(t.roomLoads)).toBe(true);
    }
    const view = gameLoad(load);
    expect(view.threads.map((t) => t.id)).toEqual([0, 1]);
    expect(view.main.id).toBe('main');
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { game: { mode: string; workers: number; up: number } };
    expect(health.game).toEqual({ mode: 'workers', workers: 2, up: 2 });
  });
});

describe('room workers: shutdown', () => {
  it('a server stop settles the live tickets of every worker (an operator exit) before it returns', async () => {
    const d = mkdtempSync(join(tmpdir(), 'elymum-workers-stop-'));
    const ch = new FakeChain();
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, BOT_TARGET: '0', BOT_MIN: '0', BOT_MAX: '0', GAME_ACCESS: 'public', NODE_ENV: 'development', GAME_WORKERS: '1' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: () => {}, persist: true });
    const p = await a.listen();
    const w = testWallet(0xb001);
    const t = ticket(w);
    ch.sessions.set(`1:${w}`, t);
    const c = await Client.open(p, a.auth.issueToken(w));
    c.send({ t: 'join', room: 'arena:1', name: 'Leaver', skin: 0 });
    await c.wait('joined');
    await until(() => a.journal.live().some((l) => l.session === t.key));
    await a.close();
    const file = JSON.parse(readFileSync(join(d, 'chains', '31337', 'journal.json'), 'utf8')) as { pending: { key: string; reason: string; payout: number }[]; live: unknown[] };
    expect(file.pending.filter((x) => x.key === t.key)).toEqual([expect.objectContaining({ reason: 'kicked', payout: 9_500_000 })]);
    expect(file.live).toEqual([]);
  });
});

describe('room workers: a hung worker', () => {
  it('is stopped by the watchdog, its tickets settled from the journal, and it comes back', async () => {
    const d = mkdtempSync(join(tmpdir(), 'elymum-workers-hang-'));
    const ch = new FakeChain();
    const logs: string[] = [];
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, BOT_TARGET: '0', BOT_MIN: '0', BOT_MAX: '0', GAME_ACCESS: 'public', NODE_ENV: 'development', GAME_WORKERS: '1', GAME_WORKER_HANG_S: '2' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: (m) => logs.push(m), persist: true });
    const p = await a.listen();
    try {
      const w = testWallet(0xc001);
      const t = ticket(w);
      ch.sessions.set(`1:${w}`, t);
      const c = await Client.open(p, a.auth.issueToken(w));
      c.send({ t: 'join', room: 'arena:1', name: 'Stuck', skin: 0 });
      await c.wait('joined');
      await until(() => a.journal.live().some((l) => l.session === t.key));
      a.rooms.pool!.block(0, 6000);
      await until(() => a.journal.settlements().some((x) => x.key === t.key), 9000);
      expect(a.journal.settlements().filter((x) => x.key === t.key)).toEqual([expect.objectContaining({ reason: 'crash', payout: 9_500_000 })]);
      expect(logs.some((l) => /room worker 0 stopped \(no message for/.test(l))).toBe(true);
      await until(() => a.rooms.pool!.threads()[0].restarts === 1 && !!a.rooms.get('arena-1-1'), 9000);
      const q = await Client.open(p);
      q.send({ t: 'join', room: 'practice', name: 'Next', skin: 0 });
      await q.wait('joined', 8000);
      q.ws.close();
    } finally {
      await a.close();
    }
  }, 30_000);
});

describe('room workers: the money helpers', () => {
  it('Journal.recoverRooms settles live tickets once and queues the floor loot to burn', () => {
    const j = new Journal(null);
    j.commit({
      roomId: 'arena-1-2',
      live: [
        { roomId: 'arena-1-2', session: '1:a:1', sessionId: 1, player: '0xA', arenaId: 1, value: 700, score: 10, kills: 0 },
        { roomId: 'arena-1-2', session: '1:b:2', sessionId: 2, player: '0xB', arenaId: 1, value: 300, score: 5, kills: 1 },
      ],
      loot: { roomId: 'arena-1-2', arenaId: 1, items: [{ x: 1, y: 1, value: 40 }, { x: 2, y: 2, value: 60 }] },
    });
    j.commit({ roomId: 'arena-1-1', live: [{ roomId: 'arena-1-1', session: '1:c:3', sessionId: 3, player: '0xC', arenaId: 1, value: 950, score: 1, kills: 0 }] });
    // one of them was already being settled (the worker's last write made it there)
    j.enqueue({ kind: 'settle', key: '1:b:2', player: '0xB', arenaId: 1, session: '1:b:2', sessionId: 2, payout: 300, score: 5, kills: 1, xp: 0, reason: 'death', attempts: 0, nextAttemptAt: 0, createdAt: 0 });
    const owed = j.owedByArena(1);
    const res = j.recoverRooms(['arena-1-2'], 42);
    expect(res).toEqual({ settled: 1, swept: 100 });
    expect(j.owedByArena(1)).toBe(owed - 300);
    expect(j.settlements().map((s) => [s.key, s.reason, s.payout])).toEqual([
      ['1:b:2', 'death', 300],
      ['1:a:1', 'crash', 700],
    ]);
    expect(j.pending.find((p) => p.kind === 'sweep')).toMatchObject({ key: 'sweep:arena-1-2:42:lost', amount: 100, arenaId: 1, round: 42 });
    expect(j.live().map((l) => l.session)).toEqual(['1:c:3']);
    expect(j.recoverLoot(1)).toEqual([]);
    // again: nothing more
    expect(j.recoverRooms(['arena-1-2'], 42)).toEqual({ settled: 0, swept: 0 });
  });

  it('ShopService.refund gives back a charge whose effect a worker could not apply', () => {
    const wallet = '0x1111111111111111111111111111111111111111';
    const inv = new BoostInventory(null);
    inv.credit(wallet, 'magnet', 2, `0x${'1'.padStart(64, '0')}`, 1n);
    const shop = new ShopService({ settings: new ShopSettingsStore(null), inventory: inv, chain: new FakeChain() as never, owner: () => null, holder: async () => false });
    const ctx = { wallet, isBot: false, arena: true, round: 7, holder: false };
    expect(shop.use(ctx, 'magnet', () => true)).toEqual({ ok: true });
    expect(inv.get(wallet).magnet).toBe(1);
    expect(shop.use(ctx, 'magnet', () => true)).toEqual({ ok: false, reason: 'cooldown' });
    shop.refund(ctx, 'magnet');
    expect(inv.get(wallet).magnet).toBe(2);
    expect(shop.state(ctx).arena?.left).toBe(shop.state({ ...ctx, round: 8 }).arena?.left);
    expect(shop.use(ctx, 'magnet', () => true)).toEqual({ ok: true });
  });
});

describe('room workers: the house bots bankroll', () => {
  it('bots in a worker arena draw their budget from the reserve on the main thread; an admin ticket tops the reserve up', async () => {
    const d = mkdtempSync(join(tmpdir(), 'elymum-workers-bank-'));
    const ch = new FakeChain();
    const admin = testWallet(0xa0a0);
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, ARENA_BOT_TARGET: '6', ARENA_BOT_MIN: '6', ARENA_BOT_MAX: '6', BOT_TARGET: '0', BOT_MIN: '0', BOT_MAX: '0', GAME_ACCESS: 'public', NODE_ENV: 'development', GAME_WORKERS: '1', ADMIN_WALLETS: admin, TRUST_PROXY: '0' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: () => {}, persist: true });
    const p = await a.listen();
    try {
      const value = 10_000_000 - Math.floor((10_000_000 * 500) / 10_000);
      // the admin's unplayed ticket becomes reserve: settled at 0, its value kept in the vault
      const t = ticket(admin);
      ch.sessions.set(`1:${admin}`, t);
      const call = async (body: unknown) => {
        const res = await fetch(`http://127.0.0.1:${p}/api/admin/bots/bankroll`, { method: 'POST', headers: { Authorization: `Bearer ${a.auth.issueToken(admin)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as { amount?: number; reserve?: number; error?: string } };
      };
      const r = await call({ arenaId: 1 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ amount: value, reserve: value });
      expect(a.journal.settlements()).toEqual([expect.objectContaining({ key: t.key, payout: 0, reason: 'house' })]);
      // the same ticket twice, and no ticket at all, are refused
      expect((await call({ arenaId: 1 })).status).toBe(409);
      expect((await call({ arenaId: 2 })).body.error).toBe('no_ticket');
      // more reserve, then the bots that walk in (in the worker) draw from it
      a.journal.commit({ house: [{ arenaId: 1, amount: 5 * value }] });
      await until(() => a.journal.purses().reduce((s, x) => s + x.value, 0) >= 3 * value, 20_000);
      const purses = a.journal.purses().reduce((s, x) => s + x.value, 0);
      expect(purses % value).toBe(0);
      expect(a.journal.houseByArena(1) + purses).toBe(6 * value);
    } finally {
      await a.close();
    }
  }, 30_000);
});
