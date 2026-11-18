/**
 * A paid join seats the ticket of the wallet that was signed in when the join began. WebSocket messages are handled
 * concurrently, so an `auth` (another wallet's token) or a `logout` can land while a join awaits the chain. Before the
 * fix the seat was built from the socket's wallet after the last await: one wallet's ticket was seated under another
 * wallet, the settlement for that other wallet was dropped by the chain worker, and the same ticket played again.
 * These tests replay the reviewer's two races with a slow RPC (security review S2).
 */
import { PROTOCOL_VERSION, type ServerMessage } from '@coinnibal/shared';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { Auth } from '../src/auth';
import { EvmChain } from '../src/chain/evm';
import { sessionKey } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Gateway } from '../src/net/gateway';
import { RoomManager } from '../src/rooms/manager';
import { Journal } from '../src/stake/journal';
import { ARENA, FakeEvm } from './fake-evm';
import { MID_ROUND, fakeConn, roomDeps, testWallet, type TestConn } from './helpers';

const T0 = MID_ROUND;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const evm = new FakeEvm();
  evm.addArena(3, 50_000n);
  const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), GAME_ACCESS: 'public' } as unknown as NodeJS.ProcessEnv);
  const journal = new Journal(null);
  const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0, receiptTimeoutMs: 10, cacheDir: null });
  await chain.start();
  const rooms = new RoomManager(cfg, { ...roomDeps(chain, journal, () => T0), log: () => {} }, chain);
  chain.setLiveSessionProvider(() => rooms.liveSessions());
  const auth = new Auth(cfg.authSecret);
  const gateway = new Gateway(cfg, rooms, auth, chain, journal, () => {});
  const send = (conn: TestConn, msg: Record<string, unknown>) => gateway.onMessage(conn, Buffer.from(JSON.stringify(msg)) as never, false);
  const connect = async (wallet: string) => {
    const conn = fakeConn(wallet);
    rooms.conns.add(conn);
    await send(conn, { t: 'hello', v: PROTOCOL_VERSION });
    return conn;
  };
  await rooms.ensureArenaRooms();
  // a slow RPC: every arena-list and session read takes 50 ms
  const ea = evm as unknown as { arenas: (...a: unknown[]) => Promise<unknown>; session: (...a: unknown[]) => Promise<unknown> };
  const arenas = ea.arenas.bind(evm);
  const session = ea.session.bind(evm);
  ea.arenas = async (...a) => (await sleep(50), arenas(...a));
  ea.session = async (...a) => (await sleep(50), session(...a));
  /** Both arena caches (the room manager's and the chain's) have expired: the next pick reads the chain. */
  const expireArenaCaches = () => {
    (chain as unknown as { arenasStale(): void }).arenasStale();
    (rooms as unknown as { arenaCache: { at: number } }).arenaCache.at = 0;
  };
  return { evm, chain, rooms, auth, journal, send, connect, expireArenaCaches };
}

const seats = (c: TestConn) => c.msgs.filter((m): m is Extract<ServerMessage, { t: 'joined' }> => m.t === 'joined');

describe('a paid join seats the wallet it began for (S2)', () => {
  it('A joins with its ticket; the socket signs in as B while the instance is re-confirmed: nothing is seated under B', async () => {
    const t = await setup();
    const A = testWallet(0xa1);
    const B = testWallet(0xb2);
    const ticket = t.evm.join(3, A, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    const conn = await t.connect(A);
    const join = t.send(conn, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    await sleep(10); // inside getSession(A)
    // meanwhile the picked instance stops taking seats and both arena caches expire: the seat re-reads the arena list
    (t.rooms as unknown as { scaler: { draining: Set<string> } }).scaler.draining.add('arena-3-1');
    t.expireArenaCaches();
    await sleep(60); // inside confirmArenaRoom's arena-list read
    await t.send(conn, { t: 'auth', token: t.auth.issueToken(B) });
    await join;
    expect(conn.wallet).toBe(B);
    expect(seats(conn)).toHaveLength(0);
    expect(t.rooms.findArenaStake(3, B)).toBeNull();
    expect(t.rooms.liveSessions().size).toBe(0);
    // A's ticket is untouched: A seats it once, under A
    const again = await t.connect(A);
    await t.send(again, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    expect(seats(again).map((m) => m.session)).toEqual([sessionKey(3, A, ticket.id)]);
    expect(t.rooms.findArenaStake(3, A)?.entry.player).toBe(A);
  });

  it('A (no ticket) → B (a ticket) → A during the reads: B\'s ticket is never seated as A', async () => {
    const t = await setup();
    const A = testWallet(0xa1);
    const B = testWallet(0xb2);
    t.evm.join(3, B, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    t.expireArenaCaches();
    const conn = await t.connect(A);
    const join = t.send(conn, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    await sleep(10); // inside arenaRoom's arena-list read
    await t.send(conn, { t: 'auth', token: t.auth.issueToken(B) });
    await sleep(60); // inside the ticket read
    await t.send(conn, { t: 'auth', token: t.auth.issueToken(A) });
    await join;
    expect(seats(conn)).toHaveLength(0);
    expect(t.rooms.findArenaStake(3, A)).toBeNull();
    expect(t.rooms.liveSessions().size).toBe(0);
  });

  it('a logout during the ticket read: no seat with a null player', async () => {
    const t = await setup();
    const A = testWallet(0xa1);
    t.evm.join(3, A, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    const conn = await t.connect(A);
    const join = t.send(conn, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    await sleep(10);
    await t.send(conn, { t: 'logout' });
    await join;
    expect(seats(conn)).toHaveLength(0);
    expect(t.rooms.liveSessions().size).toBe(0);
  });
});
