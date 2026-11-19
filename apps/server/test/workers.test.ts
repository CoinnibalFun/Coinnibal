/**
 * Room workers (GAME_WORKERS > 0): the rooms run in worker threads, the main thread keeps the sockets,
 * the journal and the chain. These tests drive the real app over WebSockets with two workers; the
 * whole integration suite also runs in this mode (`pnpm -F @coinnibal/server test:workers`).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSE_REPLACED, PROTOCOL_VERSION, TEST_ARENA_DEFAULT, encodeTarget, roundAt, type ChainStatus, type ServerMessage } from '@coinnibal/shared';
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
      testnet: true,
      faucetUrl: null,
      rpcUrl: null,
      explorerUrl: null,
      arenaAddress: '0x00000000000000000000000000000000000A7e4A',
      nftAddress: null,
      arenasEnabled: true,
      tokenReady: true,
      token: { address: '0x0000000000000000000000000000000000000707', symbol: '$NIBAL', decimals: 18 },
      fees: { burnBps: 1500, vaultBps: 500, holderBurnBps: 1500, holderVaultBps: 500, holderPerks: false, paymentBurnBps: 5000, burnMode: 0 },
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
    rates: { burnBps: 1500, vaultBps: 500 },
    value: entryFee,
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
  dir = mkdtempSync(join(tmpdir(), 'coinnibal-workers-'));
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    GAME_ACCESS: 'public',
    // no break after a bell here (the break has its own test)
    ROUND_BREAK_SECONDS: '0',
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
    expect(j.value).toBe(10_000_000);
    await until(() => app.journal.live().some((l) => l.session === t.key));
    expect(app.rooms.liveSessions().has(t.key)).toBe(true);
    expect(app.rooms.findArenaStake(1, w)?.entry.pid).toBe(j.playerId);
    // a second tab of the same wallet takes the coin over (the first is closed with CLOSE_REPLACED); never a second seat
    const c2 = await Client.open(port, app.auth.issueToken(w));
    const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    c2.send({ t: 'join', room: 'arena:1', name: 'Again', skin: 0 });
    expect((await c2.wait('joined')).playerId).toBe(j.playerId);
    expect(await closed).toBe(CLOSE_REPLACED);

    const r = roundAt(serverNow());
    jumpTo(r.endsAt + 50);
    const over = await c2.wait('roundOver', 5000);
    expect(over.round).toBe(r.n);
    expect(over.payout).toBe(10_000_000);
    const items = app.journal.settlements().filter((p) => p.key === t.key);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'round', payout: 10_000_000, player: w });
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

  it('a test arena in a worker: the person takes a bot\'s place, the official ticket is journaled by the main thread; a crash settles it once and the test arena reopens', async () => {
    await until(() => !!app.rooms.get('test-1'), 8000);
    // three bots in the empty test arena, all arrived (one by one)
    app.rooms.testArenas.update({ bots: 3 });
    await until(() => app.rooms.get('test-1')!.botCounts().bots === 3, 20_000);
    const w = testWallet(0xa0f1);
    const t = ticket(w);
    chain.sessions.set(`1:${w}`, t);
    const c = await Client.open(port, app.auth.issueToken(w));
    c.send({ t: 'join', room: 'arena:1:test', name: 'TestCrash', skin: 0 });
    const j = await c.wait('joined');
    expect(j.room).toMatchObject({ id: 'test-1', test: true, arenaId: 1 });
    expect(j.value).toBe(10_000_000);
    await until(() => app.journal.live().some((l) => l.session === t.key && l.roomId === 'test-1'));
    expect(app.rooms.findArenaStake(1, w)?.room.id).toBe('test-1');
    const room = app.rooms.get('test-1') as RemoteRoom;
    // the worker's room made room for the person: one bot fewer (the lobby and the admin view read it here)
    await until(() => room.botCounts().bots === 2 && room.humanCount === 1, 8000);
    expect(app.rooms.list().find((r) => r.id === 'test-1')).toMatchObject({ players: 1, bots: 2 });
    expect(app.rooms.testArenaView().rooms.find((r) => r.id === 'test-1')).toMatchObject({ people: 1, bots: 2 });

    app.rooms.pool!.crash(room.slot.index);
    await until(() => app.journal.settlements().some((p) => p.key === t.key));
    const items = app.journal.settlements().filter((p) => p.key === t.key);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'crash', player: w });
    // whatever bots ate of it lies in the journaled loot, queued to burn: nothing created, nothing lost
    const burned = app.journal.pending.filter((p) => p.kind === 'sweep' && p.roomId === 'test-1').reduce((n, p) => n + (p.kind === 'sweep' ? p.amount : 0), 0);
    expect((items[0].payout ?? 0) + burned).toBe(10_000_000);
    await until(() => c.closeCode !== null);
    // the standing rooms come back, the test arena with them
    await until(() => !!app.rooms.get('arena-1-1') && !!app.rooms.get('test-1') && app.rooms.get('test-1') !== room, 10_000);
    app.journal.remove(t.key);
    for (const p of [...app.journal.pending]) if (p.kind === 'sweep' && p.roomId === 'test-1') app.journal.remove(p.key);
    chain.sessions.delete(`1:${w}`);
    app.rooms.testArenas.update({ bots: TEST_ARENA_DEFAULT.bots });
  }, 60_000);

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
    expect(items[0]).toMatchObject({ reason: 'crash', payout: 10_000_000, player: w });
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

  it('a custom room closed early: the countdown, the final board, then room_closed', async () => {
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
    // the countdown crosses to the worker and back to everyone in the room
    app.rooms.get(`priv-${code}`)!.closingSoon(Date.now() + 10_000, 'The room creator closed this room.');
    expect((await c.wait('closing', 3000)).message).toMatch(/creator closed/);
    expect(app.rooms.closeCustomRoom(code, 'The room creator closed this room.')).toBe(true);
    // the final board first (its player's own row and game), then room_closed
    const over = await c.wait('roomOver', 3000);
    expect(over.standings.find((s) => s.you)).toMatchObject({ rank: 1, name: 'Guest' });
    expect(over.stats).toMatchObject({ finalRank: 1, finalOf: 1 });
    // the main thread makes my result card from the worker's game-over (with how the player looked)
    const share = await c.wait('share', 3000);
    expect(app.shares.get(share.id)).toMatchObject({ kind: 'room', name: 'Guest', rank: 1, players: 1 });
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
    const d = mkdtempSync(join(tmpdir(), 'coinnibal-workers-stop-'));
    const ch = new FakeChain();
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, GAME_ACCESS: 'public', ROUND_BREAK_SECONDS: '0', ROUND_JOIN_CLOSE_SECONDS: '0', NODE_ENV: 'development', GAME_WORKERS: '1' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: () => {}, persist: true });
    const p = await a.listen();
    const w = testWallet(0xb001);
    const t = ticket(w);
    ch.sessions.set(`1:${w}`, t);
    const c = await Client.open(p, a.auth.issueToken(w));
    // the arena opens once the chain's arena list is read: join only when it is there (slow on a busy CI machine)
    await until(() => !!a.rooms.get('arena-1-1'), 15_000);
    c.send({ t: 'join', room: 'arena:1', name: 'Leaver', skin: 0 });
    await c.wait('joined', 15_000);
    await until(() => a.journal.live().some((l) => l.session === t.key));
    await a.close();
    const file = JSON.parse(readFileSync(join(d, 'chains', '31337', 'journal.json'), 'utf8')) as { pending: { key: string; reason: string; payout: number }[]; live: unknown[] };
    expect(file.pending.filter((x) => x.key === t.key)).toEqual([expect.objectContaining({ reason: 'kicked', payout: 10_000_000 })]);
    expect(file.live).toEqual([]);
    // a worker thread starts slowly on a busy machine (CI): room enough for it
  }, 30_000);
});

describe('room workers: a hung worker', () => {
  it('is stopped by the watchdog, its tickets settled from the journal, and it comes back', async () => {
    const d = mkdtempSync(join(tmpdir(), 'coinnibal-workers-hang-'));
    const ch = new FakeChain();
    const logs: string[] = [];
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, GAME_ACCESS: 'public', ROUND_BREAK_SECONDS: '0', ROUND_JOIN_CLOSE_SECONDS: '0', NODE_ENV: 'development', GAME_WORKERS: '1', GAME_WORKER_HANG_S: '2' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: (m) => logs.push(m), persist: true });
    const p = await a.listen();
    try {
      const w = testWallet(0xc001);
      const t = ticket(w);
      ch.sessions.set(`1:${w}`, t);
      const c = await Client.open(p, a.auth.issueToken(w));
      // the arena opens once the chain's arena list is read: join only when it is there (slow on a busy CI machine)
      await until(() => !!a.rooms.get('arena-1-1'), 15_000);
      c.send({ t: 'join', room: 'arena:1', name: 'Stuck', skin: 0 });
      await c.wait('joined', 15_000);
      await until(() => a.journal.live().some((l) => l.session === t.key));
      a.rooms.pool!.block(0, 6000);
      await until(() => a.journal.settlements().some((x) => x.key === t.key), 9000);
      expect(a.journal.settlements().filter((x) => x.key === t.key)).toEqual([expect.objectContaining({ reason: 'crash', payout: 10_000_000 })]);
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
    const shop = new ShopService({ settings: new ShopSettingsStore(null), inventory: inv, chain: new FakeChain() as never, holder: async () => false });
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

describe('room workers: practice bots', () => {
  it('a free custom room in a worker fields its practice bots; official arenas in a worker have none, test arenas do', async () => {
    const d = mkdtempSync(join(tmpdir(), 'coinnibal-workers-bots-'));
    const ch = new FakeChain();
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, GAME_ACCESS: 'public', ROUND_BREAK_SECONDS: '0', ROUND_JOIN_CLOSE_SECONDS: '0', NODE_ENV: 'development', GAME_WORKERS: '1', TRUST_PROXY: '0' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: () => {}, persist: true });
    await a.listen();
    try {
      const room = a.rooms.createCustomRoom('BOTSS', {
        name: 'Bots',
        maxPlayers: 10,
        bots: { count: 3, difficulty: 'easy' },
        custom: { durationMin: 30, mapSize: 'M', bots: 3, difficulty: 'easy', food: 'normal', traps: 'normal', powerUps: true, kind: 'free', creator: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', createdAt: 0, endsAt: Date.now() + 3600_000 },
      });
      await until(() => room.botCounts().bots === 3, 20_000);
      await a.rooms.ensureArenaRooms();
      await until(() => a.rooms.roomCounts().some((r) => r.kind === 'arena'), 20_000);
      // official arenas and ponds field none; only the testnet's test arenas (on by default here) do
      for (const r of a.rooms.roomCounts()) if (r.kind !== 'private' && !r.id.startsWith('test-')) expect(r.bots).toBe(0);
      await until(() => a.rooms.roomCounts().some((r) => r.id === 'test-1' && r.bots > 0), 20_000);
      // the admin's bot settings reach the test arenas in their workers (more bots arrive one by one, about 4 s apart)
      a.rooms.testArenas.update({ bots: 3 });
      await until(() => a.rooms.roomCounts().filter((r) => r.id.startsWith('test-')).every((r) => r.bots === 3), 30_000);
      expect(a.rooms.testArenaView().rooms.map((r) => [r.id, r.bots, r.thread?.startsWith('w')])).toEqual([
        ['test-1', 3, true],
        ['test-2', 3, true],
      ]);
    } finally {
      await a.close();
    }
  }, 60_000);
});

describe('room workers: arena instance scaling', () => {
  it('an overflow instance opens on a worker; drained once empty, it closes there after its bell settled it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'coinnibal-workers-scale-'));
    const ch = new FakeChain();
    const base = Date.now();
    let off = roundAt(base).startsAt + 2_000 - base;
    const now = () => Date.now() + off;
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: d, GAME_ACCESS: 'public', ROUND_BREAK_SECONDS: '0', ROUND_JOIN_CLOSE_SECONDS: '0', NODE_ENV: 'development', GAME_WORKERS: '2', ARENA_INSTANCE_CAP: '1' } as NodeJS.ProcessEnv);
    const a = await createApp(cfg, { chain: ch, log: () => {}, persist: true, now });
    const p = await a.listen();
    try {
      a.rooms.scaler.store.update({ lowMin: 1, cooldownMin: 0 });
      const w1 = testWallet(0xb001);
      const w2 = testWallet(0xb002);
      ch.sessions.set(`1:${w1}`, ticket(w1));
      const t2 = ticket(w2);
      ch.sessions.set(`1:${w2}`, t2);
      const c1 = await Client.open(p, a.auth.issueToken(w1));
      c1.send({ t: 'join', room: 'arena:1', name: 'One', skin: 0 });
      expect((await c1.wait('joined')).room.id).toBe('arena-1-1');
      const c2 = await Client.open(p, a.auth.issueToken(w2));
      c2.send({ t: 'join', room: 'arena:1', name: 'Two', skin: 0 });
      // one seat per instance: the second ticket overflows into a new instance, placed on a worker
      expect((await c2.wait('joined')).room.id).toBe('arena-1-2');
      const second = a.rooms.get('arena-1-2') as RemoteRoom;
      expect(second).toBeInstanceOf(RemoteRoom);
      // the scaler's own tick may log a scale-up (both instances are full) right after the overflow: look for the decision
      expect(a.rooms.scaler.log().find((x) => x.action === 'overflow')).toMatchObject({ action: 'overflow', room: 'arena-1-2' });
      // the bell settles both tickets (once each, on the main thread)
      const r = roundAt(now());
      off += r.endsAt + 50 - now();
      await c2.wait('roundOver', 5000);
      await until(() => a.journal.settlements().filter((s) => s.key === t2.key).length === 1);
      await until(() => a.rooms.arenaInstances(1).every((x) => x.humanCount === 0 && x.liveSessions().length === 0));
      // a minute of an empty #2: it drains, and its worker closes it (its spectator goes to the lobby)
      const t = now();
      for (let k = 0; k <= 13; k++) a.rooms.scaler.step(t + k * 5000);
      expect(a.rooms.scaler.log().some((x) => x.action === 'drain' && x.room === 'arena-1-2')).toBe(true);
      const closed = await c2.wait('error', 5000, (m) => m.code === 'room_closed');
      expect(closed.message).toMatch(/instance closed/);
      await until(() => a.rooms.get('arena-1-2') === undefined);
      a.rooms.scaler.step(t + 15 * 5000);
      expect(a.rooms.scaler.log().find((x) => x.action === 'close')).toMatchObject({ action: 'close', room: 'arena-1-2' });
      expect(a.rooms.get('arena-1-1')).toBeDefined();
      expect(a.journal.settlements().filter((s) => s.key === t2.key)).toHaveLength(1);
      c1.ws.close();
      c2.ws.close();
    } finally {
      await a.close();
    }
  }, 60_000);
});
