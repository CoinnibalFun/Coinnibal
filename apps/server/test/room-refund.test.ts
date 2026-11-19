/**
 * The early refund of an unseated ticket through a paid custom room that stopped taking seats (audit R4-M1). The
 * gateway refunds such a ticket at once instead of the stale sweeper's 15 minutes. Anyone may name a room code, so that
 * refund is a no-show like the sweeper's, unless the server owes the excuse: the ticket was bought for that very room
 * (its permit was bound to it while the room took seats, not by its creator), just now, within the room's seats. A free
 * room's code (a practice room's too) and another arena's code refund nothing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUSTOM_DEFAULTS, customRoomPaymentRef, PROTOCOL_VERSION, roundAt, type ChainStatus, type CustomRoomView, type JoinPermit, type ServerMessage } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import type { ChainArena, ChainGateway, ChainSession, ServerKeyInfo, TokenReceipt } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { JoinPermitFail, ROOM_EXCUSE_S } from '../src/stake/join-permits';
import type { SettlementItem } from '../src/stake/journal';
import { testSigner } from './signers';

const ARENA_ADDR = '0x00000000000000000000000000000000000A7e4A';
const TOKEN = '0x0000000000000000000000000000000000000707';

class FakeChain implements ChainGateway {
  readonly enabled = true;
  readonly tokenReady = true;
  readonly stakeEnabled = true;
  sessions = new Map<string, ChainSession>();
  receipts = new Map<string, TokenReceipt>();
  nonces = new Map<string, bigint>();
  paused = false;
  /** Wallets (lower case) the server refused a seat for a reason of its own (`excuseNoShow`). */
  excused = new Set<string>();
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
      arenaAddress: ARENA_ADDR,
      nftAddress: null,
      arenasEnabled: true,
      tokenReady: true,
      token: { address: TOKEN, symbol: '$NIBAL', decimals: 18 },
      fees: { burnBps: 1500, vaultBps: 500, holderBurnBps: 1500, holderVaultBps: 500, holderPerks: false, paymentBurnBps: 5000, burnMode: 0 },
      serverKey: null,
    };
  }
  serverInfo(): ServerKeyInfo {
    return { address: null, balanceWei: null, low: false };
  }
  async getSession(arenaId: number, player: string) {
    return this.sessions.get(`${arenaId}:${player.toLowerCase()}`) ?? null;
  }
  async listArenas(): Promise<ChainArena[]> {
    return [
      { id: 1, entryFee: 10_000_000, maxSessions: 100, enabled: true, openSessions: 0, pot: 0 },
      { id: 2, entryFee: 50_000_000, maxSessions: 100, enabled: true, openSessions: 0, pot: 0 },
    ];
  }
  async joinNonce(player: string): Promise<bigint> {
    return this.nonces.get(player.toLowerCase()) ?? 0n;
  }
  async signJoinPermit(player: string, arenaId: number, nonce: bigint, deadline: number): Promise<JoinPermit> {
    return { arena: ARENA_ADDR, chainId: 31337, player: getAddress(player), arenaId, nonce: nonce.toString(), deadline, signature: `0x${'1'.repeat(130)}` };
  }
  joinsPaused(): boolean {
    return this.paused;
  }
  excuseNoShow(_arenaId: number, player: string): void {
    this.excused.add(player.toLowerCase());
  }
  excusedSince(_arenaId: number, player: string): boolean {
    return this.excused.has(player.toLowerCase());
  }
  kick() {}
  setLiveSessionProvider() {}
  onSettled() {}
  onStatusChange() {}
  async start() {}
  async stop() {}
}

class Client {
  msgs: ServerMessage[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.msgs.push(JSON.parse(data.toString()) as ServerMessage);
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
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  async wait(t: string, ms = 3000, pred: (m: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
    for (let i = 0; i < ms / 20; i++) {
      const m = this.msgs.find((x) => x.t === t && pred(x as unknown as Record<string, unknown>));
      if (m) return m as unknown as Record<string, unknown>;
      await sleep(20);
    }
    throw new Error(`timeout ${t}: ${JSON.stringify(this.msgs.slice(-3))}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let app: App;
let port: number;
let chain: FakeChain;
const t0 = Date.now();
let clockBase = roundAt(t0).startsAt + 2_000;
const serverNow = () => clockBase + (Date.now() - t0);
const jumpTo = (at: number) => {
  clockBase = at - (Date.now() - t0);
};
let seq = 900;
/** `player`'s ticket of `arenaId`, opened `ageS` seconds ago (block time). */
const ticket = (player: string, arenaId: number, ageS = 0): ChainSession => {
  const id = seq++;
  return {
    key: `${arenaId}:${player.toLowerCase()}:${id}`,
    id,
    player,
    arenaId,
    entryFee: 10_000_000,
    rates: { burnBps: 1500, vaultBps: 500 },
    value: 10_000_000,
    openedAt: Math.floor(Date.now() / 1000) - ageS,
    finalized: false,
    owed: 0,
  };
};
const buy = (player: string, arenaId: number, ageS = 0): ChainSession => {
  const t = ticket(player, arenaId, ageS);
  chain.sessions.set(`${arenaId}:${player.toLowerCase()}`, t);
  chain.nonces.set(player.toLowerCase(), (chain.nonces.get(player.toLowerCase()) ?? 0n) + 1n);
  return t;
};
async function signedIn(wallet: string): Promise<Client> {
  const c = await Client.connect(port);
  c.send({ t: 'hello', v: PROTOCOL_VERSION });
  await c.wait('welcome');
  c.send({ t: 'auth', token: app.auth.issueToken(wallet) });
  await c.wait('authed');
  return c;
}
let room = 0;
/** A paid room of `arenaId` opened by a new creator (its fee paid in the game token). */
async function paidRoom(arenaId: number, maxPlayers = 4): Promise<{ view: CustomRoomView; creator: string }> {
  const creator = testSigner().address;
  const fee = 1500n * 10n ** 18n;
  const n = ++room;
  const txHash = `0x${n.toString(16).padStart(64, 'c')}`;
  // 16 characters of a-z and 2-7
  const request = `roomrefund${'abcdef'[n % 6]}${'234567'[Math.floor(n / 6) % 6]}aaaa`;
  chain.receipts.set(txHash, {
    status: 'success',
    blockNumber: 1n,
    transfers: [{ token: TOKEN, from: creator, to: ARENA_ADDR, value: fee }],
    payments: [{ contract: ARENA_ADDR, payer: creator, ref: customRoomPaymentRef(request), amount: fee }],
  });
  const view = await app.customRooms.create(creator, { config: { ...CUSTOM_DEFAULTS, name: `Desk ${n}`, kind: 'paid', arenaId, bots: 0, maxPlayers, durationMin: 15 }, txHash, request });
  return { view, creator };
}
/** `wallet` asks to sit with its ticket in `target`: the error it hears, and the refund queued for `t` (if any). */
async function joinRefused(wallet: string, target: string, t: ChainSession, code: string): Promise<SettlementItem | undefined> {
  const c = await signedIn(wallet);
  c.send({ t: 'join', room: target, name: 'P', skin: 0 });
  await c.wait('error', 3000, (m) => m.code === code);
  for (let i = 0; i < 25 && !app.journal.pending.some((p) => p.key === t.key); i++) await sleep(20);
  c.ws.close();
  return app.journal.pending.find((p): p is SettlementItem => p.kind === 'settle' && p.key === t.key);
}
/** What the early refund queued for a ticket is: none, `no-show` (counted) or `excused`; a full `cancel` either way. */
const kind = (item: SettlementItem | undefined): 'none' | 'no-show' | 'excused' => {
  if (!item) return 'none';
  expect(item).toMatchObject({ kind: 'settle', reason: 'stale', payout: 10_000_000 });
  return item.noShow ? 'no-show' : 'excused';
};
const closeNow = async (code: string, creator: string) => {
  app.customRooms.close(code, { wallet: creator, admin: false });
  jumpTo(serverNow() + 15_000);
  for (let i = 0; i < 100 && app.rooms.get(`priv-${code}`); i++) await sleep(50);
  expect(app.rooms.get(`priv-${code}`)).toBeUndefined();
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-room-refund-'));
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, GAME_ACCESS: 'public', ROUND_BREAK_SECONDS: '0', NODE_ENV: 'development' });
  chain = new FakeChain();
  app = await createApp(cfg, { chain, log: () => {}, persist: true, now: serverNow });
  port = await app.listen();
});
afterAll(async () => {
  await app.close();
});

describe('a room code refunds an unseated ticket early only as a no-show, unless the ticket was bought for that room (audit R4-M1)', () => {
  it("the reviewer's paths: a closed practice room's code and another arena's closed code refund nothing; a stranger's ticket through a closing room is a no-show", async () => {
    // a free "Practice with bots" room, opened in one click, closed: its code is no paid room's
    const owner = testSigner().address;
    const practice = app.customRooms.practice({ wallet: owner, ip: '198.51.100.9' });
    app.customRooms.close(practice.code, { wallet: owner, admin: false });
    jumpTo(serverNow() + 15_000);
    for (let i = 0; i < 100 && app.rooms.get(`priv-${practice.code}`); i++) await sleep(50);
    expect(app.rooms.customClosedLately(practice.code)).toBe(true);
    const c = testSigner().address;
    const tc = buy(c, 1);
    expect(kind(await joinRefused(c, `arena:1:${practice.code}`, tc, 'room_not_found'))).toBe('none');

    // a paid room of arena 1, closing (its creator ended it): a stranger's unseated arena-1 ticket bought for nothing
    // in particular goes back at once, as a no-show
    const { view, creator } = await paidRoom(1);
    app.customRooms.close(view.code, { wallet: creator, admin: false });
    const a = testSigner().address;
    const ta = buy(a, 1);
    expect(kind(await joinRefused(a, `arena:1:${view.code}`, ta, 'room_closed'))).toBe('no-show');

    // gone now: remembered as closed for arena 1 only; an arena-2 ticket through it refunds nothing
    jumpTo(serverNow() + 15_000);
    for (let i = 0; i < 100 && app.rooms.get(`priv-${view.code}`); i++) await sleep(50);
    expect(app.rooms.get(`priv-${view.code}`)).toBeUndefined();
    const b = testSigner().address;
    const tb = buy(b, 2);
    expect(kind(await joinRefused(b, `arena:2:${view.code}`, tb, 'room_not_found'))).toBe('none');
    // an arena-1 ticket through the closed arena-1 code: back at once, a no-show
    const d = testSigner().address;
    const td = buy(d, 1);
    expect(kind(await joinRefused(d, `arena:1:${view.code}`, td, 'room_closed'))).toBe('no-show');
    for (const t of [ta, td]) app.journal.remove(t.key);
  }, 30_000);

  it('a ticket bought for the room (its permit asked for it while it took seats) goes back without a no-show: within its seats, just bought, not its creator', async () => {
    const { view, creator } = await paidRoom(1, 2);
    const code = view.code;
    const ip = '192.0.2.50';
    // three players ask for permits for this room, and its creator for its own ticket
    const [p1, p2, p3] = [testSigner().address, testSigner().address, testSigner().address];
    for (const w of [p1, p2, p3, creator]) expect((await app.permits.issue(w, 1, ip, code)).arenaId).toBe(1);
    // one asks for another room (and a late one buys long after its permit)
    const other = await paidRoom(1);
    const p4 = testSigner().address;
    await app.permits.issue(p4, 1, ip, other.view.code);
    const p5 = testSigner().address;
    await app.permits.issue(p5, 1, ip, code);
    const t1 = buy(p1, 1);
    const t2 = buy(p2, 1);
    const t3 = buy(p3, 1);
    const tc = buy(creator, 1);
    const t4 = buy(p4, 1);
    const t5 = buy(p5, 1, ROOM_EXCUSE_S + 30);
    await closeNow(code, creator);
    // the room seats 2: two excuses; then a no-show like any other
    expect(kind(await joinRefused(p1, `arena:1:${code}`, t1, 'room_closed'))).toBe('excused');
    expect(kind(await joinRefused(p2, `arena:1:${code}`, t2, 'room_closed'))).toBe('excused');
    expect(kind(await joinRefused(p3, `arena:1:${code}`, t3, 'room_closed'))).toBe('no-show');
    // its creator ended it: its own ticket is no excuse
    expect(kind(await joinRefused(creator, `arena:1:${code}`, tc, 'room_closed'))).toBe('no-show');
    // a ticket bought for another room, or held unseated past the moments after its purchase
    expect(kind(await joinRefused(p4, `arena:1:${code}`, t4, 'room_closed'))).toBe('no-show');
    expect(kind(await joinRefused(p5, `arena:1:${code}`, t5, 'room_closed'))).toBe('no-show');
    for (const t of [t1, t2, t3, tc, t4, t5]) app.journal.remove(t.key);
  }, 30_000);

  it('the server owes the excuse when it refused the seat itself, or when the arena takes no seat', async () => {
    const { view, creator } = await paidRoom(1);
    await closeNow(view.code, creator);
    const a = testSigner().address;
    const ta = buy(a, 1, 300);
    chain.excused.add(a.toLowerCase());
    expect(kind(await joinRefused(a, `arena:1:${view.code}`, ta, 'room_closed'))).toBe('excused');
    chain.paused = true;
    const b = testSigner().address;
    const tb = buy(b, 1, 300);
    expect(kind(await joinRefused(b, `arena:1:${view.code}`, tb, 'room_closed'))).toBe('excused');
    chain.paused = false;
    for (const t of [ta, tb]) app.journal.remove(t.key);
  }, 30_000);

  it('a permit asked for a room that takes no seat (closing, another arena, unknown) is refused before anything is signed', async () => {
    const { view, creator } = await paidRoom(1);
    const w = testSigner().address;
    for (const [arenaId, code] of [
      [2, view.code],
      [1, 'NOSUCHROOM'],
    ] as const) {
      const e = await app.permits.issue(w, arenaId, '192.0.2.60', code).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(JoinPermitFail);
      expect((e as JoinPermitFail).code).toBe('arena_closed');
    }
    app.customRooms.close(view.code, { wallet: creator, admin: false });
    expect(((await app.permits.issue(w, 1, '192.0.2.60', view.code).catch((err: unknown) => err)) as JoinPermitFail).code).toBe('arena_closed');
    expect(((await app.permits.issue(w, 1, '192.0.2.60', 'bad code!').catch((err: unknown) => err)) as JoinPermitFail).code).toBe('bad_request');
    // no room named: the arena's permit as before
    expect((await app.permits.issue(w, 1, '192.0.2.60')).arenaId).toBe(1);
    // over HTTP the code rides in the body
    const res = await fetch(`http://127.0.0.1:${port}/api/arena/permit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.auth.issueToken(testSigner().address)}` },
      body: JSON.stringify({ arenaId: 1, room: view.code }),
    });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([409, 'arena_closed']);
  }, 30_000);
});
