/**
 * Players who set no name: each gets their own "Coinie-xxxx" (never one "Coinie" for everybody), and every line that
 * says "you" can tell players apart by id, not by name (the play-test's kill feed read "you had you for lunch").
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, TICK_MS, defaultName, type ServerMessage } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Leaderboards } from '../src/leaderboards';
import { Limiter } from '../src/net/limiter';
import { Room } from '../src/rooms/room';
import { Journal } from '../src/stake/journal';
import { ArenaChain, MID_ROUND, arena, fakeConn, roomDeps, stakeJoin } from './helpers';
import { testSigner } from './signers';

const FEE = 1_000_000;

describe('kill feed and the last rounds name players by id', () => {
  it('two coins with one name: the kill line carries both player ids; the bell board carries each ticket\'s wallet', () => {
    const leaderboards = new Leaderboards(null);
    const deps = { ...roomDeps(new ArenaChain([]), new Journal(null)), leaderboards };
    const room = new Room({ id: 'arena-1-1', mode: 'arena', name: 'A', instance: 1, maxPlayers: 50, stake: { arenaId: 1, buyIn: FEE } }, deps);
    const a = { ...stakeJoin(1, FEE), name: 'Coinie' };
    const b = { ...stakeJoin(1, FEE), name: 'Coinie' };
    const c = { ...stakeJoin(1, FEE), name: 'Coinie' };
    const ca = fakeConn(a.stake.player);
    const pa = room.join(ca, a);
    const pb = room.join(fakeConn(b.stake.player), b);
    room.join(fakeConn(c.stake.player), c);
    pa.shieldUntil = 0;
    pb.shieldUntil = 0;
    pa.cells[0].setMass(3000);
    const at = pa.center();
    pb.cells[0].x = at.x + 5;
    pb.cells[0].y = at.y;
    pb.cells[0].setMass(100);
    for (let i = 0; i < 60 && pb.alive; i++) room.tick(TICK_MS);
    expect(pb.alive).toBe(false);
    const kf = ca.msgs.find((m): m is Extract<ServerMessage, { t: 'kf' }> => m.t === 'kf');
    expect(kf).toMatchObject({ killer: 'Coinie', victim: 'Coinie', killerPid: pa.id, victimPid: pb.id, cause: 'eat' });

    // the bell: the "Last rounds" rows name the same "Coinie" twice, each with its own ticket's wallet
    room.syncRound(room.round(MID_ROUND)!.endsAt);
    const top = leaderboards.snapshot().rounds[0].top;
    expect(top.map((r) => r.name)).toEqual(['Coinie', 'Coinie']);
    expect(top.map((r) => r.wallet).sort()).toEqual([a.stake.player, c.stake.player].sort());
  });
});

class Ws {
  msgs: ServerMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d, bin) => {
      if (!bin) this.msgs.push(JSON.parse(d.toString()) as ServerMessage);
    });
  }
  static async open(port: number): Promise<Ws> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    const c = new Ws(ws);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.next('welcome');
    return c;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async next<T extends ServerMessage['t']>(t: T, timeoutMs = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t);
      if (i >= 0) return this.msgs.splice(0, i + 1)[i] as Extract<ServerMessage, { t: T }>;
      if (Date.now() > until) throw new Error(`no ${t}: ${JSON.stringify(this.msgs.map((m) => m.t))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** Joins practice and returns the name the server gave the coin. */
  async joinAs(msg: Record<string, unknown>): Promise<string> {
    this.send({ t: 'join', room: 'practice', skin: 1, ...msg });
    return (await this.next('joined')).name;
  }
  close() {
    this.ws.close();
  }
}

describe('a join without a usable name', () => {
  let app: App;
  let port: number;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-names-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, TRUST_PROXY: '0', GAME_ACCESS: 'public' } as NodeJS.ProcessEnv);
    const big = () => new Limiter(10_000, 60_000);
    app = await createApp(cfg, {
      chain: new ArenaChain([arena(1, 1000)]),
      log: () => {},
      persist: false,
      siteLimits: { writeIp: big(), writeWallet: big(), login: big(), avatarIp: big(), avatarWallet: big() },
      apiLimiter: big(),
    });
    port = await app.listen();
  });
  afterAll(async () => {
    await app.close();
  });

  it('guests each get their own "Coinie-xxxx"; a chosen name (even "Coinie") stays as it is', async () => {
    const names: string[] = [];
    for (const msg of [{}, { name: '' }, { name: '   ' }, { name: 'Admin' }, { name: 42 }]) {
      const c = await Ws.open(port);
      const name = await c.joinAs(msg);
      expect(name, JSON.stringify(msg)).toMatch(/^Coinie-[0-9a-f]{4}$/);
      names.push(name);
      c.close();
    }
    expect(new Set(names).size).toBe(names.length);
    for (const chosen of ['Coinie', 'Penny', 'Coinie-0a1b']) {
      const c = await Ws.open(port);
      expect(await c.joinAs({ name: chosen })).toBe(chosen);
      c.close();
    }
  }, 20_000);

  it('a signed-in wallet without a name gets the name the client sends for it; a profile name still wins', async () => {
    const w = testSigner().address;
    const c = await Ws.open(port);
    c.send({ t: 'auth', token: app.auth.issueToken(w) });
    await c.next('authed');
    expect(await c.joinAs({})).toBe(defaultName(w));
    c.send({ t: 'leave' });
    await c.next('left').catch(() => {});
    const res = await fetch(`http://127.0.0.1:${port}/api/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.auth.issueToken(w)}` },
      body: JSON.stringify({ name: 'Saved', skin: 0 }),
    });
    expect(res.status).toBe(200);
    const s = await Ws.open(port);
    s.send({ t: 'auth', token: app.auth.issueToken(w) });
    await s.next('authed');
    expect(await s.joinAs({ name: '' })).toBe('Saved');
    s.close();
    c.close();
  }, 20_000);
});
