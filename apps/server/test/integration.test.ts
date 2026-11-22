import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSE_REPLACED, CUSTOM_DEFAULTS, EntityKind, customRoomPaymentRef, PROTOCOL_VERSION, RULES, TEST_ARENA_DEFAULT, decodeSnapshot, encodeTarget, type ChainStatus, type ServerMessage, type SnapshotData, roundAt, siweMessage } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import type { ChainArena, ChainGateway, ChainSession, ServerKeyInfo, TokenReceipt } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { testSigner } from './signers';

class FakeChain implements ChainGateway {
  readonly enabled = true;
  readonly tokenReady = true;
  readonly stakeEnabled = true;
  sessions = new Map<string, ChainSession>();
  /** `CoinnibalArena.pay` receipts by hash (custom room fees). */
  receipts = new Map<string, TokenReceipt>();
  kicked = 0;
  async tokenReceipt(hash: string): Promise<TokenReceipt | null> {
    return this.receipts.get(hash.toLowerCase()) ?? null;
  }
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
  /** The next `getSession` fails like an RPC error. */
  failNextGetSession = false;
  /** Runs inside `getSession` (lets a test act while a join awaits the chain). */
  onGetSession: (() => void) | null = null;
  async getSession(arenaId: number, player: string) {
    if (this.failNextGetSession) {
      this.failNextGetSession = false;
      throw new Error('rpc down');
    }
    const hook = this.onGetSession;
    this.onGetSession = null;
    if (hook) {
      await sleep(20);
      hook();
    }
    return this.sessions.get(`${arenaId}:${player}`) ?? null;
  }
  async listArenas(): Promise<ChainArena[]> {
    return [
      { id: 1, entryFee: 10_000_000, maxSessions: 10, enabled: true, openSessions: 0, pot: 0 },
      { id: 2, entryFee: 50_000_000, maxSessions: 10, enabled: true, openSessions: 0, pot: 0 },
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
  snaps: SnapshotData[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = data as Buffer;
        this.snaps.push(decodeSnapshot(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
        return;
      }
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.msgs.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const c = new Client(ws);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
    });
  }

  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }

  wait<T extends ServerMessage['t']>(t: T, timeoutMs = 3000, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) {
    const existing = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
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

  close() {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `TEST_GAME_WORKERS=2 vitest run test/integration.test.ts` (`pnpm test:workers`) runs this whole suite
 * with the rooms in room workers; the few looks inside a room object are skipped then.
 */
const WORKERS = Number(process.env.TEST_GAME_WORKERS ?? 0);

let sessionSeq = 100;
function session(player: string, opts: Partial<ChainSession> = {}): ChainSession {
  const id = opts.id ?? ++sessionSeq;
  const arenaId = opts.arenaId ?? 1;
  const entryFee = opts.entryFee ?? 10_000_000;
  return {
    key: `${arenaId}:${player.toLowerCase()}:${id}`,
    id,
    player,
    arenaId: 1,
    entryFee,
    rates: { burnBps: 1500, vaultBps: 500 },
    // arena v3: no entry fee cut, the ticket plays its whole price
    value: entryFee,
    openedAt: Math.floor(Date.now() / 1000),
    finalized: false,
    owed: 0,
    ...opts,
  };
}

const newWallet = () => testSigner().address;

/** Connected, greeted and (with a wallet) signed-in client. */
async function signedIn(wallet: string | null): Promise<Client> {
  const c = await Client.connect(port);
  c.send({ t: 'hello', v: PROTOCOL_VERSION });
  await c.wait('welcome');
  if (wallet) {
    c.send({ t: 'auth', token: app.auth.issueToken(wallet) });
    await c.wait('authed');
  }
  return c;
}

/** The latest PlayerInfo of `pid` from the client's snapshots. */
function playerInfo(c: Client, pid: number) {
  for (let i = c.snaps.length - 1; i >= 0; i--) {
    const p = c.snaps[i].players.find((x) => x.id === pid);
    if (p) return p;
  }
  return undefined;
}

let app: App;
let port: number;
let chain: FakeChain;

/**
 * The server's round clock: real time shifted so the suite starts 2 s into a 5-minute round
 * (no round ends by accident); tests move it with `jumpTo`.
 */
const t0 = Date.now();
let clockBase = roundAt(t0).startsAt + 2_000;
const serverNow = () => clockBase + (Date.now() - t0);
const jumpTo = (at: number) => {
  clockBase = at - (Date.now() - t0);
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-int-'));
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    // the game gate (site setting `gameAccess`) is covered in site.test.ts
    GAME_ACCESS: 'public',
    // no break after a bell here (the break has its own test)
    ROUND_BREAK_SECONDS: '0',
    // no PUBLIC_URL: only development derives the SIWE origin from the request host
    NODE_ENV: 'development',
    ...(WORKERS ? { GAME_WORKERS: String(WORKERS) } : {}),
  });
  chain = new FakeChain();
  app = await createApp(cfg, { chain, log: () => {}, persist: true, now: serverNow });
  port = await app.listen();
});

afterAll(async () => {
  await app.close();
});

describe('server over websocket', () => {
  it('handshake lists rooms and chain status', async () => {
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    const welcome = await c.wait('welcome');
    expect(welcome.rooms.some((r) => r.id === 'practice-rookie-1')).toBe(true);
    expect(welcome.rooms.some((r) => r.mode === 'arena' && r.arenaId === 1)).toBe(true);
    expect(welcome.chain.enabled).toBe(true);
    // the round clock: every arena room carries the same round, on the server clock
    expect(Math.abs(welcome.serverNow - serverNow())).toBeLessThan(1000);
    const r = roundAt(welcome.serverNow);
    for (const room of welcome.rooms.filter((x) => x.mode === 'arena')) expect(room.round).toEqual({ n: r.n, endsAt: r.endsAt, joinsCloseAt: r.joinsCloseAt });
    expect(welcome.rooms.find((x) => x.mode === 'practice')?.round).toBeUndefined();
    c.send({ t: 'ping', ts: 7 });
    const pong = await c.wait('pong');
    expect(Math.abs(pong.serverNow - serverNow())).toBeLessThan(1000);
    // the token and the fee rules ride along with the chain status (no Pass, no season)
    expect(welcome.chain).toMatchObject({ tokenReady: true, fees: { burnBps: 1500, vaultBps: 500 }, token: { decimals: 18 }, testnet: true });
    expect('gasSymbol' in welcome.chain).toBe(false);
    expect('pass' in welcome.chain).toBe(false);
    expect(welcome.blocked).toEqual([]);
    c.close();
  });

  it('arenas kept closed by the vault guard reach the lobby payloads', async () => {
    const underfunded = (app.rooms as unknown as { underfunded: Map<number, string> }).underfunded;
    underfunded.set(7, 'vault short');
    try {
      const res = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()) as { blocked: unknown };
      expect(res.blocked).toEqual([{ arenaId: 7, reason: 'vault_short' }]);
      const c = await Client.connect(port);
      c.send({ t: 'hello', v: PROTOCOL_VERSION });
      expect((await c.wait('welcome')).blocked).toEqual([{ arenaId: 7, reason: 'vault_short' }]);
      c.close();
    } finally {
      underfunded.delete(7);
    }
  });

  it('rejects an old protocol version', async () => {
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: 0 });
    const err = await c.wait('error');
    expect(err.code).toBe('version_mismatch');
    c.close();
  });

  it('joins a practice room, receives snapshots with own cell and moves toward the target', async () => {
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.wait('welcome');
    c.send({ t: 'viewport', w: 1600, h: 900 });
    c.send({ t: 'join', room: 'practice', name: 'Tester', skin: 3 });
    const joined = await c.wait('joined');
    expect(joined.room.mode).toBe('practice');
    expect(joined.name).toBe('Tester');
    await sleep(500);
    expect(c.snaps.length).toBeGreaterThan(8);
    const mine = () => {
      for (let i = c.snaps.length - 1; i >= 0; i--) {
        const e = c.snaps[i].upserts.find((u) => u.kind === EntityKind.Cell && u.playerId === joined.playerId);
        if (e) return e;
      }
      return undefined;
    };
    const start = mine()!;
    expect(start).toBeDefined();
    const players = c.snaps.flatMap((s) => s.players);
    expect(players.find((p) => p.id === joined.playerId)?.name).toBe('Tester');
    // food arrives once and is not resent every tick
    const foodIds = c.snaps.flatMap((s) => s.upserts.filter((u) => u.kind === EntityKind.Food).map((u) => u.id));
    expect(foodIds.length).toBeGreaterThan(10);
    expect(new Set(foodIds).size).toBeGreaterThan(foodIds.length * 0.7);

    const tx = start.x + 600;
    for (let i = 0; i < 10; i++) {
      c.ws.send(encodeTarget(tx, start.y));
      await sleep(50);
    }
    const end = mine()!;
    expect(end.x).toBeGreaterThan(start.x + 50);

    const lb = await c.wait('lb', 2000, (m) => m.me !== null);
    expect(lb.me!.rank).toBeGreaterThan(0);
    expect(lb.top.length).toBeGreaterThan(0);
    c.close();
  });

  it('broadcasts chat and blocks links', async () => {
    const a = await Client.connect(port);
    const b = await Client.connect(port);
    for (const c of [a, b]) {
      c.send({ t: 'hello', v: PROTOCOL_VERSION });
      await c.wait('welcome');
    }
    a.send({ t: 'join', room: 'practice', name: 'Alice', skin: 0 });
    b.send({ t: 'join', room: 'practice', name: 'Bob', skin: 1 });
    await a.wait('joined');
    await b.wait('joined');
    a.send({ t: 'chat', text: 'gm frens' });
    const got = await b.wait('chat', 2000, (m) => m.from === 'Alice');
    expect(got.text).toBe('gm frens');
    await sleep(1300);
    a.send({ t: 'chat', text: 'free tokens at https://scam.xyz' });
    const err = await a.wait('error', 2000, (m) => m.code === 'bad_request');
    expect(err.message).toMatch(/Links/);
    a.close();
    b.close();
  });

  it('authenticates a wallet signature and rejects a bad one', async () => {
    const signer = testSigner();
    const address = signer.address;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/nonce?address=${address.toLowerCase()}`);
    const body = (await res.json()) as { message: string; address: string; domain: string; uri: string; chainId: number; nonce: string; issuedAt: string };
    const { message } = body;
    // SIWE domain = request host (no PUBLIC_URL here, NODE_ENV=development), with URI and the server's Chain ID; the client can rebuild it
    expect(body.domain).toBe(`127.0.0.1:${port}`);
    expect(body.address).toBe(address);
    expect(body.chainId).toBe(31337);
    expect(message.split('\n')[0]).toBe(`127.0.0.1:${port} wants you to sign in with your Ethereum account:`);
    expect(message).toContain(`\nURI: http://127.0.0.1:${port}\n`);
    expect(message).toContain('\nChain ID: 31337\n');
    expect(siweMessage({ domain: body.domain, address, uri: body.uri, chainId: body.chainId, nonce: body.nonce, issuedAt: body.issuedAt })).toBe(message);
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.wait('welcome');
    // wrong signature (another wallet signed it)
    c.send({ t: 'auth', address, message, signature: await testSigner().sign(message) });
    expect((await c.wait('error')).code).toBe('auth_failed');
    const sig = await signer.sign(message);
    c.send({ t: 'auth', address: address.toLowerCase(), message, signature: sig });
    const authed = await c.wait('authed');
    expect(authed.address).toBe(address);
    // the token works on a fresh connection; a replayed signature does not
    const d = await Client.connect(port);
    d.send({ t: 'hello', v: PROTOCOL_VERSION });
    await d.wait('welcome');
    d.send({ t: 'auth', address, message, signature: sig });
    expect((await d.wait('error')).code).toBe('auth_failed');
    d.send({ t: 'auth', token: authed.token });
    expect((await d.wait('authed')).address).toBe(address);
    c.close();
    d.close();
  });

  it('rate-limits sign-ins (each one reads the chain)', async () => {
    const player = newWallet();
    const token = app.auth.issueToken(player);
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.wait('welcome');
    for (let i = 0; i < 8; i++) c.send({ t: 'auth', token });
    expect((await c.wait('error', 2000, (m) => m.code === 'rate_limited')).code).toBe('rate_limited');
    const authed = () => c.msgs.filter((m) => m.t === 'authed').length;
    for (let i = 0; i < 40 && authed() < 6; i++) await sleep(25);
    await sleep(100);
    expect(authed()).toBe(6);
    expect(c.msgs.filter((m) => m.t === 'error' && m.code === 'rate_limited').length).toBe(2);
    c.close();
  });

  it('stake arena: join with an on-chain ticket, no cash-out, settled at value when the round ends', async () => {
    const player = newWallet();
    const ticket = session(player, { id: 1 });
    chain.sessions.set(`1:${player}`, ticket);
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.wait('welcome');
    c.send({ t: 'join', room: 'arena:1', name: 'Whale', skin: 0 });
    expect((await c.wait('error')).code).toBe('auth_required');

    c.send({ t: 'auth', token: app.auth.issueToken(player) });
    await c.wait('authed');
    c.send({ t: 'join', room: 'arena:1', name: 'Whale', skin: 0 });
    const joined = await c.wait('joined');
    expect(joined.room.mode).toBe('arena');
    // the coin starts at the ticket's value: the 10.0 entry minus the 5 % fee taken at the entry
    expect(joined.value).toBe(10_000_000);
    const r = roundAt(serverNow());
    expect(joined.round).toEqual({ n: r.n, endsAt: r.endsAt, joinsCloseAt: r.joinsCloseAt });
    expect(app.journal.live().map((l) => l.session)).toContain(ticket.key);

    // paid arenas have no cash-out
    c.send({ t: 'cashout' });
    expect((await c.wait('error', 2000, (m) => m.code === 'no_cashout')).code).toBe('no_cashout');
    await sleep(100);
    expect(c.msgs.some((m) => m.t === 'cashout')).toBe(false);
    expect(app.journal.pending.some((p) => p.key === ticket.key)).toBe(false);

    // the bell: settled at value (reason `round`), with the round's standings
    jumpTo(r.endsAt);
    const over = await c.wait('roundOver', 3000);
    expect(over.round).toBe(r.n);
    expect(over.payout).toBe(10_000_000);
    expect(over.stats.payout).toBe(10_000_000);
    expect(over.standings.find((s) => s.you)).toEqual({ rank: 1, name: 'Whale', value: 10_000_000, mass: expect.any(Number), kills: 0, you: true });
    const item = app.journal.pending.find((p) => p.key === ticket.key);
    expect(item).toMatchObject({ kind: 'settle', payout: 10_000_000, reason: 'round', player: player });
    expect(chain.kicked).toBeGreaterThan(0);
    expect(app.journal.live().map((l) => l.session)).not.toContain(ticket.key);

    // the same ticket cannot be reused while its settlement is pending
    c.send({ t: 'join', room: 'arena:1', name: 'Whale', skin: 0 });
    expect((await c.wait('error', 2000, (m) => m.code === 'no_session')).code).toBe('no_session');
    app.journal.remove(ticket.key);
    chain.sessions.delete(`1:${player}`);
    c.close();
  }, 15_000);

  it("a holder's ticket: the bell's result and the pending payout take the fee at the ticket's own rates, as the contract does", async () => {
    const player = newWallet();
    // a holder's ticket (8 % + 2 % fixed at join) worth twice its 10.0 price at the bell: 10.0 profit, 1.0 fee
    const ticket = session(player, { id: 77, value: 20_000_000, rates: { burnBps: 800, vaultBps: 200 } });
    chain.sessions.set(`1:${player}`, ticket);
    const c = await signedIn(player);
    c.send({ t: 'join', room: 'arena:1', name: 'Holder', skin: 0 });
    await c.wait('joined');
    jumpTo(roundAt(serverNow()).endsAt);
    const over = await c.wait('roundOver', 3000);
    // the contract pays 19.0 (not 18.0 at the default 20 %)
    expect(over.payout).toBe(19_000_000);
    expect(over.stats).toMatchObject({ payout: 19_000_000, gross: 20_000_000, cut: 1_000_000, rates: { burnBps: 800, vaultBps: 200 } });
    const item = app.journal.pending.find((p) => p.key === ticket.key);
    expect(item).toMatchObject({ kind: 'settle', payout: 20_000_000, entryFee: 10_000_000, rates: { burnBps: 800, vaultBps: 200 } });
    // the lobby's "payout on the way" is what reaches the wallet
    const res = (await (await fetch(`http://127.0.0.1:${port}/api/pending?wallet=${player}`, { headers: { Authorization: `Bearer ${app.auth.issueToken(player)}` } })).json()) as unknown;
    expect(res).toEqual({ pending: [{ key: ticket.key, arenaId: 1, payout: 19_000_000 }] });
    app.journal.remove(ticket.key);
    chain.sessions.delete(`1:${player}`);
    c.close();
  }, 15_000);

  it('holders gate: every arena seat re-checks the gate uncached (an NFT passed on since the lobby check)', async () => {
    const player = newWallet();
    chain.sessions.set(`1:${player}`, session(player, { id: 41 }));
    const site = app.site as unknown as { gameOpenFor: (w: string | null, fresh?: boolean) => Promise<boolean> };
    const original = site.gameOpenFor;
    const asked: boolean[] = [];
    // the cached answer still says "holder"; a fresh balanceOf read says the NFT is gone
    site.gameOpenFor = async (_w, fresh = false) => {
      asked.push(fresh);
      return !fresh;
    };
    try {
      const c = await signedIn(player);
      c.send({ t: 'join', room: 'arena:1', name: 'Passer', skin: 0 });
      expect((await c.wait('error', 2000, (m) => m.code === 'game_closed')).code).toBe('game_closed');
      expect(asked).toEqual([false, true]);
      expect(app.journal.live().some((l) => l.player === player)).toBe(false);
      // practice is gated by the (cached) check only
      c.send({ t: 'join', room: 'practice', name: 'Passer', skin: 0 });
      expect((await c.wait('joined')).room.mode).toBe('practice');
      c.close();
    } finally {
      site.gameOpenFor = original;
      chain.sessions.delete(`1:${player}`);
    }
  });

  it('arena joins close in the last minute; an AFK staker may still come back; the next round opens joins', async () => {
    const afk = newWallet();
    chain.sessions.set(`1:${afk}`, session(afk));
    const a = await signedIn(afk);
    a.send({ t: 'join', room: 'arena:1', name: 'Early', skin: 0 });
    const ja = await a.wait('joined');
    a.close();
    await sleep(150);

    const r = roundAt(serverNow());
    jumpTo(r.joinsCloseAt);
    const late = newWallet();
    chain.sessions.set(`1:${late}`, session(late));
    const b = await signedIn(late);
    b.send({ t: 'join', room: 'arena:1', name: 'Late', skin: 0 });
    const err = await b.wait('error', 2000, (m) => m.code === 'round_closed');
    expect(err.opensAt).toBe(r.endsAt);
    expect(b.msgs.some((m) => m.t === 'joined')).toBe(false);
    expect(app.rooms.liveSessions().size).toBeGreaterThan(0);

    // the AFK return path is not a new join: allowed while joins are closed
    const a2 = await signedIn(afk);
    a2.send({ t: 'join', room: 'arena:1', name: 'Early', skin: 0 });
    const back = await a2.wait('joined');
    expect(back.playerId).toBe(ja.playerId);

    // the next round opens: the held ticket joins at once, before the room's next tick
    // (it plays round n+1; the join rings round n's bell first)
    jumpTo(r.endsAt);
    b.send({ t: 'join', room: 'arena:1', name: 'Late', skin: 0 });
    const jb = await b.wait('joined');
    expect(jb.round?.n).toBe(r.n + 1);
    const over = await a2.wait('roundOver', 3000);
    expect(over.round).toBe(r.n);
    await sleep(200);
    expect(b.msgs.some((m) => m.t === 'roundOver')).toBe(false);
    expect(app.journal.settlements().some((p) => p.player === late)).toBe(false);
    expect(app.rooms.findArenaStake(1, late)).not.toBeNull();
    for (const w of [afk, late]) {
      for (const p of app.journal.pending.filter((x) => x.kind === 'settle' && x.player === w)) app.journal.remove(p.key);
      chain.sessions.delete(`1:${w}`);
    }
    a2.close();
    b.close();
  }, 15_000);

  it('the join permits hear when a wallet asks to sit (also while joins are closed) and when its ticket is read', async () => {
    const seen: [string, number, number | null][] = [];
    app.gateway.setTicketSeen((w, a, at) => void seen.push([w.toLowerCase(), a, at]));
    const w = newWallet();
    try {
      const r = roundAt(serverNow());
      jumpTo(r.joinsCloseAt);
      const c = await signedIn(w);
      // a ticket bought in the last minute: the web enters the room, the server holds it for the next round
      c.send({ t: 'join', room: 'arena:1', name: 'Held', skin: 0 });
      await c.wait('error', 2000, (m) => m.code === 'round_closed');
      expect(seen).toEqual([[w.toLowerCase(), 1, null]]);
      // joins open: the ticket is read (a finalized one here, so nobody sits down)
      jumpTo(r.endsAt);
      chain.sessions.set(`1:${w}`, session(w, { finalized: true, owed: 5, openedAt: 1_790_000_000 }));
      c.send({ t: 'join', room: 'arena:1', name: 'Held', skin: 0 });
      await c.wait('error', 2000, (m) => m.code === 'payout_waiting');
      expect(seen).toEqual([
        [w.toLowerCase(), 1, null],
        [w.toLowerCase(), 1, null],
        [w.toLowerCase(), 1, 1_790_000_000],
      ]);
      c.close();
    } finally {
      chain.sessions.delete(`1:${w}`);
      app.gateway.setTicketSeen((wallet, arenaId, at) => app.permits.ticketSeen(wallet, arenaId, at));
    }
  });

  it('an AFK staker back after the bell hears round_ended (not session_busy), until a new ticket opens', async () => {
    const w = newWallet();
    const first = session(w);
    chain.sessions.set(`1:${w}`, first);
    const a = await signedIn(w);
    a.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
    await a.wait('joined');
    a.close();
    await sleep(150);

    // back right at the bell, before the room's next tick: the reattach rings the bell first
    const r = roundAt(serverNow());
    jumpTo(r.endsAt);
    const b = await signedIn(w);
    b.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
    const err = await b.wait('error', 2000, (m) => m.code === 'round_ended' || m.code === 'session_busy');
    expect(err.message).toMatch(/round ended while you were away/);
    expect(err.code).toBe('round_ended');
    expect(b.msgs.some((m) => m.t === 'roundOver' || m.t === 'joined')).toBe(false);
    expect(app.journal.settlements().find((p) => p.key === first.key)).toMatchObject({ reason: 'round', player: w });

    // a later return, while the settlement is pending: still round_ended (the bell's memo)
    const c = await signedIn(w);
    c.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
    expect((await c.wait('error', 2000, (m) => m.code === 'round_ended' || m.code === 'no_session')).code).toBe('round_ended');
    c.close();

    // a ticket played until a bell rung by the room's own tick while its player is away
    const awayAtBell = async (sess: ChainSession) => {
      chain.sessions.set(`1:${w}`, sess);
      const d = await signedIn(w);
      d.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
      await d.wait('joined');
      d.close();
      await sleep(150);
      jumpTo(roundAt(serverNow()).endsAt);
      await sleep(150);
      expect(app.journal.settlements().some((p) => p.key === sess.key)).toBe(true);
      app.journal.remove(sess.key); // the payout landed
    };

    // back after the payout landed and the session closed on chain: round_ended
    app.journal.remove(first.key);
    await awayAtBell(session(w));
    chain.sessions.delete(`1:${w}`);
    const e = await signedIn(w);
    // the chain read fails once: the usual path answers, and the bell's memo is kept
    chain.failNextGetSession = true;
    e.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
    expect((await e.wait('error', 2000, (m) => m.code === 'round_ended' || m.code === 'no_session')).code).toBe('no_session');
    expect(app.rooms.bellSettled(1, w)).not.toBeNull();
    e.msgs.length = 0;
    e.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
    expect((await e.wait('error', 2000, (m) => m.code === 'round_ended' || m.code === 'no_session')).code).toBe('round_ended');
    e.close();

    // a fresh ticket bought after an away bell plays normally
    await awayAtBell(session(w));
    const fresh = session(w);
    chain.sessions.set(`1:${w}`, fresh);
    const f = await signedIn(w);
    f.send({ t: 'join', room: 'arena:1', name: 'Away', skin: 0 });
    expect((await f.wait('joined', 2000)).session).toBe(fresh.key);
    expect(app.rooms.bellSettled(1, w)).toBeNull();
    f.close();
    await sleep(150);
    jumpTo(roundAt(serverNow()).endsAt);
    await sleep(150);
    for (const p of app.journal.pending.filter((x) => x.kind === 'settle' && x.player === w)) app.journal.remove(p.key);
    chain.sessions.delete(`1:${w}`);
    b.close();
  }, 15_000);

  it('stake players who disconnect stay AFK and can reconnect', async () => {
    const player = newWallet();
    chain.sessions.set(`1:${player}`, session(player, { id: 2, entryFee: 20_000_000 }));
    const token = app.auth.issueToken(player);
    const a = await Client.connect(port);
    a.send({ t: 'hello', v: PROTOCOL_VERSION });
    await a.wait('welcome');
    a.send({ t: 'auth', token });
    await a.wait('authed');
    a.send({ t: 'join', room: 'arena:1', name: 'Afk', skin: 0 });
    const j1 = await a.wait('joined');
    a.close();
    await sleep(200);
    const room = WORKERS ? null : app.rooms.rooms.get('arena-1-1')!;
    if (room) expect(room.world.players.get(j1.playerId)?.afk).toBe(true);

    const b = await Client.connect(port);
    b.send({ t: 'hello', v: PROTOCOL_VERSION });
    await b.wait('welcome');
    b.send({ t: 'auth', token });
    await b.wait('authed');
    b.send({ t: 'join', room: 'arena:1', name: 'Afk', skin: 0 });
    const j2 = await b.wait('joined');
    expect(j2.playerId).toBe(j1.playerId);
    expect(j2.value).toBe(20_000_000);
    if (room) expect(room.world.players.get(j1.playerId)?.afk).toBe(false);
    b.close();
  });

  it('a reconnect of the same wallet takes the live coin over at once (no session_busy); the old socket gets CLOSE_REPLACED', async () => {
    const player = newWallet();
    chain.sessions.set(`1:${player}`, session(player, { id: 3, entryFee: 20_000_000 }));
    const token = app.auth.issueToken(player);
    const enter = async () => {
      const c = await Client.connect(port);
      c.send({ t: 'hello', v: PROTOCOL_VERSION });
      await c.wait('welcome');
      c.send({ t: 'auth', token });
      await c.wait('authed');
      return c;
    };
    const a = await enter();
    a.send({ t: 'join', room: 'arena:1', name: 'Switcher', skin: 0 });
    const j1 = await a.wait('joined');
    // the phone switched from Wi-Fi to mobile data: the old socket is still open as far as the server knows
    const closed = new Promise<{ code: number; at: number }>((r) => a.ws.once('close', (code) => r({ code, at: Date.now() })));
    const b = await enter();
    const t0 = Date.now();
    b.send({ t: 'join', room: 'arena:1', name: 'Switcher', skin: 0 });
    const j2 = await b.wait('joined', 2000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(j2.playerId).toBe(j1.playerId);
    expect(j2.value).toBe(20_000_000);
    expect(b.msgs.some((m) => m.t === 'error' && m.code === 'session_busy')).toBe(false);
    expect((await closed).code).toBe(CLOSE_REPLACED);
    // the coin is the new socket's: it steers it (and the old one cannot come back by itself)
    const room = WORKERS ? null : app.rooms.rooms.get('arena-1-1')!;
    if (room) expect(room.world.players.get(j1.playerId)?.afk).toBe(false);
    expect(app.gateway.replaced).toBeGreaterThanOrEqual(1);

    // another wallet (signed in) can never take it: it has no ticket here
    const thief = newWallet();
    const t = await Client.connect(port);
    t.send({ t: 'hello', v: PROTOCOL_VERSION });
    await t.wait('welcome');
    t.send({ t: 'auth', token: app.auth.issueToken(thief) });
    await t.wait('authed');
    t.send({ t: 'join', room: 'arena:1', name: 'Switcher', skin: 0 });
    expect((await t.wait('error', 2000)).code).toBe('no_session');
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    // a guest (not signed in) cannot either
    const g = await Client.connect(port);
    g.send({ t: 'hello', v: PROTOCOL_VERSION });
    await g.wait('welcome');
    g.send({ t: 'join', room: 'arena:1', name: 'Switcher', skin: 0 });
    expect((await g.wait('error', 2000)).code).toBe('auth_required');
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    t.close();
    g.close();
    b.close();
    app.journal.remove(`1:${player.toLowerCase()}:3`);
    chain.sessions.delete(`1:${player}`);
  });

  it('while the journal cannot be written a new arena seat is refused (storage_failing); a live coin plays on', async () => {
    const player = newWallet();
    chain.sessions.set(`1:${player}`, session(player));
    const c = await signedIn(player);
    Object.defineProperty(app.journal, 'writeFailing', { get: () => true, configurable: true });
    try {
      c.send({ t: 'join', room: 'arena:1', name: 'Disk', skin: 0 });
      expect(await c.wait('error', 2000)).toMatchObject({ code: 'server_full', message: expect.stringMatching(/cannot save/) });
    } finally {
      delete (app.journal as unknown as { writeFailing?: boolean }).writeFailing;
    }
    c.send({ t: 'join', room: 'arena:1', name: 'Disk', skin: 0 });
    await c.wait('joined');
    c.close();
    chain.sessions.delete(`1:${player}`);
  });

  it("spectators watch a room (an empty pond shows its food)", async () => {
    const c = await Client.connect(port);
    c.send({ t: 'hello', v: PROTOCOL_VERSION });
    await c.wait('welcome');
    c.send({ t: 'spectate' });
    const s = await c.wait('spectating');
    expect(s.room.id).toMatch(/^practice-/);
    await sleep(300);
    expect(c.snaps.length).toBeGreaterThan(3);
    // a pond holds people only: an empty one shows its food (no bots fill it)
    expect(c.snaps.some((sn) => sn.upserts.some((u) => u.kind === EntityKind.Food))).toBe(true);
    expect(c.snaps.some((sn) => sn.upserts.some((u) => u.kind === EntityKind.Cell))).toBe(false);
    c.close();
  });

  it('serves REST endpoints', async () => {
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    const rooms = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()) as { rooms: unknown[] };
    expect(rooms.rooms.length).toBeGreaterThan(0);
    const lb = (await (await fetch(`http://127.0.0.1:${port}/api/leaderboard`)).json()) as { daily: unknown[] };
    expect(Array.isArray(lb.daily)).toBe(true);
    const bad = await fetch(`http://127.0.0.1:${port}/api/auth/nonce?address=nope`);
    expect(bad.status).toBe(400);
    const config = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as { protocol: number; chain: ChainStatus };
    expect(config).toEqual({ protocol: PROTOCOL_VERSION, chain: chain.status() });
    // the Pass and season endpoints are gone
    for (const path of ['/api/season', '/api/pass/owned?wallet=x', '/pass/collection.json', '/pass/1.png', '/api/dev/token']) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(404);
    }
  });

  it('a finalized session cannot be played: collect the payout first', async () => {
    const player = newWallet();
    const c = await signedIn(player);
    chain.sessions.set(`1:${player}`, session(player, { finalized: true, owed: 7_000_000 }));
    c.send({ t: 'join', room: 'arena:1', name: 'Collector', skin: 0 });
    const err = await c.wait('error', 2000, (m) => m.code === 'payout_waiting');
    expect(err.message).toMatch(/Collect your payout/);
    expect(c.msgs.some((m) => m.t === 'joined')).toBe(false);
    chain.sessions.delete(`1:${player}`);
    c.close();
  });

  it('a settlement queued while the join awaits blocks the join', async () => {
    const player = newWallet();
    const c = await signedIn(player);
    const s = session(player);
    chain.sessions.set(`1:${player}`, s);
    const now = Date.now();
    // the stale sweeper queues a refund for this session while the join awaits the session lookup
    chain.onGetSession = () =>
      app.journal.enqueue({ kind: 'settle', key: s.key, player: player, arenaId: 1, session: s.key, sessionId: s.id, payout: s.entryFee, score: 0, kills: 0, xp: 0, reason: 'stale', attempts: 0, nextAttemptAt: now + 60_000, createdAt: now });
    c.send({ t: 'join', room: 'arena:1', name: 'Racer', skin: 0 });
    const err = await c.wait('error', 2000, (m) => m.code === 'no_session');
    expect(err.message).toMatch(/still being settled/);
    expect(c.msgs.some((m) => m.t === 'joined')).toBe(false);
    app.journal.remove(s.key);
    chain.sessions.delete(`1:${player}`);
    c.close();
  });

  it('arena join requires a session; every ticket plays alike (no Pass)', async () => {
    const player = newWallet();
    const c = await signedIn(player);
    c.send({ t: 'join', room: 'arena:1', name: 'Noticket', skin: 0 });
    expect((await c.wait('error', 2000, (m) => m.code === 'no_session')).code).toBe('no_session');

    chain.sessions.set(`2:${player}`, session(player, { arenaId: 2, entryFee: 50_000_000 }));
    c.send({ t: 'join', room: 'arena:2', name: 'Gold', skin: 2 });
    const joined = await c.wait('joined');
    expect(joined.room.arenaId).toBe(2);
    expect(joined.value).toBe(50_000_000);
    expect('hasPass' in joined).toBe(false);
    if (!WORKERS) {
      const p = app.rooms.rooms.get(joined.room.id)!.world.players.get(joined.playerId)!;
      // no Pass power: everyone starts at the same mass (a Pass used to add 15 %). The coin may already have
      // eaten a pellet it spawned on (20 → 22 seen in CI), so the bound sits just under the old Pass's +15 %
      expect(p.totalMass()).toBeGreaterThan(RULES.startMass * 0.9);
      expect(p.totalMass()).toBeLessThan(RULES.startMass * 1.15);
    }
    await sleep(200);
    expect(playerInfo(c, joined.playerId)).toMatchObject({ skin: 2, name: 'Gold' });
    expect('pass' in playerInfo(c, joined.playerId)!).toBe(false);
    c.close();
  });

  it('a join that still names a Pass is played with the basic skin (the field is ignored)', async () => {
    const c = await signedIn(newWallet());
    c.send({ t: 'join', room: 'practice', name: 'Legacy', skin: 3, pass: newWallet() });
    const joined = await c.wait('joined');
    expect(joined.skin).toBe(3);
    expect(c.msgs.some((m) => m.t === 'error')).toBe(false);
    c.close();
  });

  it('resume existing non-live session without new charge', async () => {
    const player = newWallet();
    // the ticket was bought earlier (e.g. the tab crashed before joining): it is open on-chain but in no room
    const s = session(player, { openedAt: Math.floor(Date.now() / 1000) - 120, entryFee: 30_000_000 });
    chain.sessions.set(`1:${player}`, s);
    expect(app.rooms.liveSessions().has(s.key)).toBe(false);
    const kicked = chain.kicked;
    const pendingBefore = app.journal.pending.length;
    const c = await signedIn(player);
    c.send({ t: 'join', room: 'arena:1', name: 'Back', skin: 0 });
    const joined = await c.wait('joined');
    expect(joined.value).toBe(30_000_000);
    expect(joined.entryFee).toBe(30_000_000);
    expect(app.rooms.liveSessions().has(s.key)).toBe(true);
    // nothing was settled or charged: the same on-chain ticket simply resumes
    expect(app.journal.pending.length).toBe(pendingBefore);
    expect(chain.kicked).toBe(kicked);
    expect(chain.sessions.get(`1:${player}`)).toBe(s);
    c.close();
  });

  it('practice join routes by league', async () => {
    const pro = newWallet();
    app.profiles.update(pro, { name: 'veteran', skin: 1 });
    app.profiles.recordGame(pro, { score: 9000, kills: 50, xp: 99_999 });
    const a = await signedIn(pro);
    a.send({ t: 'join', room: 'practice', name: 'x', skin: 1 });
    const ja = await a.wait('joined');
    expect(ja.room.league).toBe('pro');
    expect(ja.room.id).toMatch(/^practice-pro-\d+$/);

    const b = await signedIn(null);
    b.send({ t: 'join', room: 'practice', name: 'newbie', skin: 1 });
    const jb = await b.wait('joined');
    expect(jb.room.league).toBe('rookie');
    expect(jb.room.id).toMatch(/^practice-rookie-\d+$/);
    a.close();
    b.close();
  });

  it('lists pending settlements', async () => {
    const player = newWallet();
    const now = Date.now();
    app.journal.enqueue({ kind: 'settle', key: `Owed-${player}`, player: player, arenaId: 1, session: `Owed-${player}`, sessionId: 9, payout: 12_000_000, score: 1, kills: 0, xp: 0, attempts: 0, nextAttemptAt: now + 60_000, createdAt: now });
    const url = `http://127.0.0.1:${port}/api/pending?wallet=${player}`;
    // only that wallet's own session (or an admin's) reads it
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: `Bearer ${app.auth.issueToken(newWallet())}` } })).status).toBe(403);
    const res = (await (await fetch(url, { headers: { Authorization: `Bearer ${app.auth.issueToken(player)}` } })).json()) as unknown;
    expect(res).toEqual({ pending: [{ key: `Owed-${player}`, arenaId: 1, payout: 12_000_000 }] });
    expect((await fetch(`http://127.0.0.1:${port}/api/pending?wallet=nope`)).status).toBe(400);
    app.journal.remove(`Owed-${player}`);
  });

  it('paid custom room: an invite-only arena instance seated by code with a normal ticket, never by quick play; on its own clock (no 5-minute bell), settled at the room end; closes once settled', async () => {
    const svc = app.customRooms;
    const creator = newWallet();
    // the room fee: the creator's `CoinnibalArena.pay` of the base price in the game token (1,500 tokens without a USD price)
    const fee = 1500n * 10n ** 18n;
    const txHash = `0x${'ab'.repeat(32)}`;
    const request = 'integrationroom2';
    const arenaAddr = chain.status().arenaAddress!;
    chain.receipts.set(txHash, {
      status: 'success',
      blockNumber: 1n,
      transfers: [{ token: chain.status().token!.address, from: creator, to: arenaAddr, value: fee }],
      payments: [{ contract: arenaAddr, payer: creator, ref: customRoomPaymentRef(request), amount: fee }],
    });
    const view = await svc.create(creator, { config: { ...CUSTOM_DEFAULTS, name: 'Whale Club', kind: 'paid', arenaId: 1, bots: 0, maxPlayers: 4, durationMin: 15 }, txHash, request });
    expect(view).toMatchObject({ kind: 'paid', arenaId: 1, maxPlayers: 4, paidWith: 'paid', feeRaw: fee.toString(), feeIn: 'token' });
    // it starts now (the server's clock) and ends exactly 15 minutes later: no arena bell involved
    expect(Math.abs(view.createdAt - serverNow())).toBeLessThan(1000);
    expect(view.endsAt - view.createdAt).toBe(15 * 60_000);
    const code = view.code;
    const host = newWallet();
    const hostTicket = session(host, { id: 501 });
    chain.sessions.set(`1:${host}`, hostTicket);
    const c = await signedIn(host);
    // `private:<CODE>` never seats anybody in a paid room
    c.send({ t: 'join', room: `private:${code}`, name: 'Host', skin: 0 });
    expect((await c.wait('error', 2000, (m) => m.code === 'paid_room')).code).toBe('paid_room');
    // a wrong arena for the code
    c.send({ t: 'join', room: `arena:2:${code}`, name: 'Host', skin: 0 });
    expect((await c.wait('error', 2000, (m) => m.code === 'room_not_found')).code).toBe('room_not_found');
    // the ticket of arena 1 seats here by code, at once
    c.send({ t: 'join', room: `arena:1:${code}`, name: 'Host', skin: 0 });
    const joined = await c.wait('joined');
    expect(joined.room).toMatchObject({ id: `priv-${code}`, mode: 'arena', arenaId: 1, code, custom: { kind: 'paid', arenaId: 1 } });
    // its round is the room's own game: from its start to its end, joins closed only in its last minute
    expect(joined.round).toEqual({ n: expect.any(Number), startsAt: view.createdAt, endsAt: view.endsAt, joinsCloseAt: view.endsAt - 60_000 });
    expect(joined.value).toBe(10_000_000);
    expect(app.journal.live().map((l) => l.session)).toContain(hostTicket.key);

    // quick play with another ticket of the same arena lands in a public instance, never here
    const other = newWallet();
    const otherTicket = session(other, { id: 502 });
    chain.sessions.set(`1:${other}`, otherTicket);
    const o = await signedIn(other);
    o.send({ t: 'join', room: 'arena:1', name: 'Walker', skin: 0 });
    expect((await o.wait('joined')).room.id).toMatch(/^arena-1-\d+$/);
    // the directory never lists it
    const listed = (await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()) as { rooms: { id: string }[] };
    expect(listed.rooms.some((r) => r.id === `priv-${code}`)).toBe(false);

    // the arenas' last minute (their joins are closed): the paid room still seats
    const r = roundAt(serverNow());
    jumpTo(r.joinsCloseAt + 1000);
    const mid = newWallet();
    const midTicket = session(mid, { id: 504 });
    chain.sessions.set(`1:${mid}`, midTicket);
    const m = await signedIn(mid);
    m.send({ t: 'join', room: `arena:1:${code}`, name: 'Mid', skin: 0 });
    expect((await m.wait('joined')).room.id).toBe(`priv-${code}`);

    // the arenas' bell: the public ticket is settled, the paid room plays on (no re-pay every 5 minutes)
    jumpTo(r.endsAt);
    await o.wait('roundOver', 4000);
    await sleep(300);
    expect(c.msgs.some((x) => x.t === 'roundOver')).toBe(false);
    expect(app.journal.live().map((x) => x.session)).toEqual(expect.arrayContaining([hostTicket.key, midTicket.key]));

    // the room's own last minute: a new seat is refused, and that unplayed ticket goes back in full at once
    jumpTo(view.endsAt - 30_000);
    const late = newWallet();
    const lateTicket = session(late, { id: 503 });
    chain.sessions.set(`1:${late}`, lateTicket);
    const l = await signedIn(late);
    l.send({ t: 'join', room: `arena:1:${code}`, name: 'Late', skin: 0 });
    expect((await l.wait('error', 2000, (x) => x.code === 'room_closed')).message).toMatch(/last minute/);
    for (let i = 0; i < 40 && !app.journal.pending.some((p) => p.key === lateTicket.key); i++) await sleep(25);
    // bought for nothing in particular (no permit asked for this room: audit R4-M1), so a no-show like the sweeper's
    expect(app.journal.pending.find((p) => p.key === lateTicket.key)).toMatchObject({ kind: 'settle', reason: 'stale', payout: 10_000_000, entryFee: 10_000_000, player: late, noShow: true });
    expect(l.msgs.some((x) => x.t === 'joined')).toBe(false);

    // the room's end settles every ticket in it by the normal server path; then the paid room closes
    jumpTo(view.endsAt);
    const over = await c.wait('roundOver', 4000);
    expect(over.payout).toBe(10_000_000);
    expect(over.standings).toHaveLength(2);
    expect(app.journal.pending.find((p) => p.key === hostTicket.key)).toMatchObject({ kind: 'settle', reason: 'round', payout: 10_000_000, player: host });
    await m.wait('roundOver', 4000);
    expect((await c.wait('error', 4000, (x) => x.code === 'room_closed')).code).toBe('room_closed');
    for (let i = 0; i < 50 && svc.get(code); i++) await sleep(50);
    expect(svc.get(code)).toBeNull();
    expect(app.rooms.get(`priv-${code}`)).toBeUndefined();

    for (const [w, t] of [
      [host, hostTicket],
      [other, otherTicket],
      [mid, midTicket],
      [late, lateTicket],
    ] as const) {
      app.journal.remove(t.key);
      chain.sessions.delete(`1:${w}`);
    }
    for (const x of [c, o, l, m]) x.close();
  }, 20_000);
  it('test arena (testnet): the official ticket in a room with labelled bots, settled at the bell, off every board; quick play never goes there', async () => {
    // test arenas are on by default on a testnet: one per tier, listed with the arenas, marked test
    let listed: { id: string; test?: true; bots: number }[] = [];
    for (let i = 0; i < 60; i++) {
      listed = ((await (await fetch(`http://127.0.0.1:${port}/api/rooms`)).json()) as { rooms: typeof listed }).rooms.filter((r) => r.test);
      if (listed.length === 2 && listed.every((r) => r.bots > 0)) break;
      await sleep(50);
    }
    expect(listed.map((r) => r.id).sort()).toEqual(['test-1', 'test-2']);
    expect(listed.every((r) => r.bots > 0)).toBe(true);

    const player = newWallet();
    const ticket = session(player);
    chain.sessions.set(`1:${player}`, ticket);
    const c = await signedIn(player);
    c.send({ t: 'join', room: 'arena:1:test', name: 'TestArenaPlayer', skin: 0, country: 'DE' });
    const joined = await c.wait('joined');
    expect(joined.room).toMatchObject({ id: 'test-1', mode: 'arena', arenaId: 1, test: true });
    // the ticket's whole value, exactly as in an official instance
    expect(joined.value).toBe(10_000_000);
    for (let i = 0; i < 40 && !app.journal.live().some((l) => l.session === ticket.key); i++) await sleep(25);
    expect(app.journal.live().find((l) => l.session === ticket.key)?.roomId).toBe('test-1');
    // the bots are in the snapshots, tagged BOT
    const lbMsg = await c.wait('lb', 4000, (m) => m.top.some((e) => e.isBot));
    expect(lbMsg.top.find((e) => e.isBot)?.name).toMatch(/^Bot \d+$/);
    // the same ticket never takes a second seat: a new socket of the wallet takes this coin over (in the test arena)
    const c2 = await signedIn(player);
    const replaced = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    c2.send({ t: 'join', room: 'arena:1', name: 'TestArenaPlayer', skin: 0 });
    const back = await c2.wait('joined');
    expect(back).toMatchObject({ playerId: joined.playerId, room: { id: 'test-1' } });
    expect(await replaced).toBe(CLOSE_REPLACED);

    // quick play (`arena:1`) seats another ticket in an official instance, never in the test arena
    const other = newWallet();
    const otherTicket = session(other);
    chain.sessions.set(`1:${other}`, otherTicket);
    const o = await signedIn(other);
    o.send({ t: 'join', room: 'arena:1', name: 'Regular', skin: 0 });
    expect((await o.wait('joined')).room.id).toMatch(/^arena-1-\d+$/);

    // the bell: settled at value like any instance; value + the floor loot queued to burn = the entry fee
    const r = roundAt(serverNow());
    jumpTo(r.endsAt);
    const over = await c2.wait('roundOver', 4000);
    await o.wait('roundOver', 4000);
    await sleep(100);
    const item = app.journal.settlements().find((p) => p.key === ticket.key);
    expect(item).toMatchObject({ kind: 'settle', reason: 'round', player });
    expect(over.payout).toBe(item?.payout);
    const burned = app.journal.pending.filter((p) => p.kind === 'sweep' && p.roomId === 'test-1').reduce((n, p) => n + (p.kind === 'sweep' ? p.amount : 0), 0);
    expect((item?.payout ?? 0) + burned).toBe(10_000_000);
    // off every official board: no record, no "last rounds" entry; its share card is a TEST card (no payout)
    const lb = app.leaderboards.snapshot();
    expect([...lb.daily, ...lb.allTime].some((x) => x.name === 'TestArenaPlayer')).toBe(false);
    expect(lb.rounds.some((x) => x.top.some((t) => t.name === 'TestArenaPlayer'))).toBe(false);
    expect(lb.rounds.some((x) => x.top.some((t) => t.name === 'Regular'))).toBe(true);
    // the takeover socket (c2) holds the coin at the bell, so its share card is the TEST card; the replaced one gets none
    expect(c.msgs.some((m) => m.t === 'share')).toBe(false);
    const testShare = c2.msgs.find((m) => m.t === 'share') as Extract<ServerMessage, { t: 'share' }> | undefined;
    expect(testShare).toMatchObject({ kind: 'round', test: true });
    expect(app.shares.get(testShare!.id)).toMatchObject({ test: true });
    expect(app.shares.get(testShare!.id)?.paid).toBeUndefined();
    const officialShare = o.msgs.find((m) => m.t === 'share') as Extract<ServerMessage, { t: 'share' }> | undefined;
    expect(officialShare).toBeTruthy();
    expect(officialShare!.test).toBeUndefined();

    for (const [w, t] of [
      [player, ticket],
      [other, otherTicket],
    ] as const) {
      app.journal.remove(t.key);
      chain.sessions.delete(`1:${w}`);
    }
    for (const p of [...app.journal.pending]) if (p.kind === 'sweep') app.journal.remove(p.key);
    c2.close();
    o.close();
  }, 20_000);

  it('test arena: each person seated takes a bot\'s place; after the bell the bot comes back with the arrival pacing', async () => {
    // the lobby's room list (in room workers too: the worker's figures reach the main thread)
    const testRoom = async () => app.rooms.list().find((r) => r.id === 'test-1');
    const until = async (ok: (r: { players: number; bots: number }) => boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
        const r = await testRoom();
        if (r && ok(r)) return r;
      }
      throw new Error(`test-1 is ${JSON.stringify(await testRoom())}`);
    };
    // three bots in the empty test arena (the admin's setting)
    app.rooms.testArenas.update({ bots: 3 });
    await until((r) => r.players === 0 && r.bots === 3, 20_000);
    const player = newWallet();
    const ticket = session(player);
    chain.sessions.set(`1:${player}`, ticket);
    const c = await signedIn(player);
    c.send({ t: 'join', room: 'arena:1:test', name: 'MakeRoom', skin: 0 });
    expect((await c.wait('joined')).room).toMatchObject({ id: 'test-1', test: true });
    // one person: one bot fewer, and it stays that way while the person plays
    await until((r) => r.players === 1 && r.bots === 2, 4000);
    await sleep(600);
    expect(await testRoom()).toMatchObject({ players: 1, bots: 2 });
    // the bell settles the ticket: the person is gone, a bot comes back, not at once
    jumpTo(roundAt(serverNow()).endsAt);
    await c.wait('roundOver', 4000);
    await sleep(500);
    expect((await testRoom())?.bots).toBe(2);
    await until((r) => r.players === 0 && r.bots === 3, 15_000);
    app.journal.remove(ticket.key);
    for (const p of [...app.journal.pending]) if (p.kind === 'sweep') app.journal.remove(p.key);
    chain.sessions.delete(`1:${player}`);
    app.rooms.testArenas.update({ bots: TEST_ARENA_DEFAULT.bots });
    c.close();
  }, 45_000);

  it('test arenas turned off: closed (nothing of value in them), joins refused; on again: back', async () => {
    app.rooms.testArenas.update({ enabled: false });
    for (let i = 0; i < 100 && app.rooms.testRooms().length > 0; i++) await sleep(50);
    expect(app.rooms.testRooms().map((r) => ({ id: r.id, h: r.humanCount, s: r.liveSessions(), l: r.lootCount(), c: r.connCount }))).toEqual([]);
    const player = newWallet();
    chain.sessions.set(`1:${player}`, session(player));
    const c = await signedIn(player);
    c.send({ t: 'join', room: 'arena:1:test', name: 'Late', skin: 0 });
    expect((await c.wait('error', 2000, (m) => m.code === 'room_not_found')).code).toBe('room_not_found');
    app.rooms.testArenas.update({ enabled: true });
    for (let i = 0; i < 60 && app.rooms.testRooms().length < 2; i++) await sleep(50);
    expect(app.rooms.testRooms().map((r) => r.id).sort()).toEqual(['test-1', 'test-2']);
    chain.sessions.delete(`1:${player}`);
    c.close();
  }, 15_000);
});
