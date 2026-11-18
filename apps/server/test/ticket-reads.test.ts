/**
 * The chain reads a join triggers are cached and bounded (security review S11). Any signed-in wallet can send `join`
 * for a paid arena without a ticket; each one read the ticket at `high` priority (ahead of settlements), per socket
 * only, with nothing bounding the RPC queue. Now: concurrent reads of one wallet share one call at `normal` priority;
 * ticket reads are limited per wallet and per client besides per socket; a server-wide bound answers "network busy"
 * at once instead of queuing; a client's holder checks that read the chain are bounded too.
 */
import { PROTOCOL_VERSION, type ServerMessage } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth';
import { EvmChain } from '../src/chain/evm';
import { currentRpcPriority } from '../src/chain/rpc-budget';
import { loadConfig } from '../src/config';
import { asClient } from '../src/net/client-scope';
import { Gateway, JOIN_CHAIN_RETRY_MS, TICKET_READS_PER_IP_PER_MIN, TICKET_READS_PER_WALLET_PER_MIN, TICKET_READ_QUEUE_S } from '../src/net/gateway';
import { RoomManager } from '../src/rooms/manager';
import { HOLDER_READS_PER_CLIENT_PER_MIN, MintService } from '../src/site/mint';
import { SiteStore } from '../src/site/store';
import { Journal } from '../src/stake/journal';
import { ARENA, FakeEvm, NFT } from './fake-evm';
import { MID_ROUND, fakeConn, roomDeps, testWallet, type TestConn } from './helpers';

const T0 = MID_ROUND;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_DEFAULT = [...JOIN_CHAIN_RETRY_MS];

afterEach(() => {
  JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length, ...RETRY_DEFAULT);
});

async function setup() {
  const evm = new FakeEvm();
  evm.addArena(3, 50_000n);
  const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), GAME_ACCESS: 'public' } as unknown as NodeJS.ProcessEnv);
  const journal = new Journal(null);
  const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0, receiptTimeoutMs: 10, cacheDir: null });
  await chain.start();
  const rooms = new RoomManager(cfg, { ...roomDeps(chain, journal, () => T0), log: () => {} }, chain);
  chain.setLiveSessionProvider(() => rooms.liveSessions());
  const gateway = new Gateway(cfg, rooms, new Auth(cfg.authSecret), chain, journal, () => {});
  const send = (conn: TestConn, msg: Record<string, unknown>) => gateway.onMessage(conn, Buffer.from(JSON.stringify(msg)) as never, false);
  const connect = async (wallet: string, ip = '127.0.0.1') => {
    const conn = fakeConn(wallet, ip);
    rooms.conns.add(conn);
    await send(conn, { t: 'hello', v: PROTOCOL_VERSION });
    return conn;
  };
  await rooms.ensureArenaRooms();
  // every ticket read is recorded with the RPC priority it ran at
  const priorities: string[] = [];
  const ea = evm as unknown as { session: (...a: unknown[]) => Promise<unknown> };
  const session = ea.session.bind(evm);
  let delay = 0;
  ea.session = async (...a) => {
    priorities.push(currentRpcPriority());
    if (delay) await sleep(delay);
    return session(...a);
  };
  return { cfg, evm, chain, rooms, gateway, send, connect, priorities, slow: (ms: number) => (delay = ms) };
}

const errors = (c: TestConn) => c.msgs.filter((m): m is Extract<ServerMessage, { t: 'error' }> => m.t === 'error').map((m) => m.code);

describe('ticket reads of joins (S11)', () => {
  it('concurrent reads of one wallet share one call, at normal priority (settlements stay ahead)', async () => {
    const t = await setup();
    t.slow(30);
    const w = getAddress(testWallet(0x51));
    const reads = await Promise.all(Array.from({ length: 10 }, () => t.chain.getSession(3, w)));
    expect(reads.every((r) => r === null)).toBe(true);
    expect(t.evm.sessionReads).toBe(1);
    expect(t.priorities).toEqual(['normal']);
  });

  it('many sockets of one wallet: at most TICKET_READS_PER_WALLET_PER_MIN reads, the rest are refused', async () => {
    const t = await setup();
    const w = testWallet(0x52);
    for (let i = 0; i < TICKET_READS_PER_WALLET_PER_MIN + 10; i++) {
      const c = await t.connect(w, `198.51.100.${i + 1}`);
      await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    }
    expect(t.evm.sessionReads).toBe(TICKET_READS_PER_WALLET_PER_MIN);
  });

  it('many throwaway wallets of one client: at most TICKET_READS_PER_IP_PER_MIN reads; another client is not affected', async () => {
    const t = await setup();
    const refused: string[] = [];
    for (let i = 0; i < TICKET_READS_PER_IP_PER_MIN + 10; i++) {
      // one /64, a new address and a new wallet every time
      const c = await t.connect(testWallet(0x1000 + i), `2001:db8:5:5::${(i + 1).toString(16)}`);
      await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
      refused.push(...errors(c).filter((e) => e === 'rate_limited'));
    }
    expect(t.evm.sessionReads).toBe(TICKET_READS_PER_IP_PER_MIN);
    expect(refused).toHaveLength(10);
    const other = await t.connect(testWallet(0x2000), '203.0.113.5');
    await t.send(other, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    expect(errors(other)).toEqual(['no_session']);
  });

  it('past the server-wide bound a join hears chain_busy at once instead of queuing', async () => {
    const t = await setup();
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length);
    const max = Math.max(16, Math.ceil(t.cfg.chain.rpcMaxRps * TICKET_READ_QUEUE_S));
    t.slow(300);
    const conns: TestConn[] = [];
    const joins: Promise<void>[] = [];
    for (let i = 0; i < max + 3; i++) {
      const c = await t.connect(testWallet(0x3000 + i), `10.${i >> 8}.${i & 255}.1`);
      conns.push(c);
      joins.push(t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 }));
    }
    await sleep(50);
    // the last three were answered before any read came back
    expect(conns.slice(max).map(errors)).toEqual([['chain_busy'], ['chain_busy'], ['chain_busy']]);
    await Promise.all(joins);
    expect(t.evm.sessionReads).toBe(max);
    expect(conns.slice(0, max).every((c) => errors(c).join() === 'no_session')).toBe(true);
  });
});

describe('holder checks of a client (S11)', () => {
  it('concurrent checks of one wallet share one read; a client\'s cache misses are bounded', async () => {
    const evm = new FakeEvm();
    let reads = 0;
    const real = evm.nftBalance.bind(evm);
    evm.nftBalance = async (...a: Parameters<typeof real>) => (reads++, await sleep(10), real(...a));
    const clock = { now: 1_000_000 };
    const mint = new MintService({
      store: new SiteStore(null),
      client: () => evm,
      nft: () => ({ address: NFT, txHash: null }),
      chainId: () => 31337,
      stateDir: null,
      usdCents: 100,
      fetchPrice: async () => ({ price: '40.0', value: 40 }),
      logChunkBlocks: 100,
      log: () => {},
      now: () => clock.now,
    });
    const w = testWallet(0x61);
    await Promise.all(Array.from({ length: 8 }, () => mint.isHolder(w)));
    expect(reads).toBe(1);
    // one client, a new throwaway wallet for every join: the chain is read HOLDER_READS_PER_CLIENT_PER_MIN times
    reads = 0;
    await asClient('2001:db8:9:9::/64', async () => {
      for (let i = 0; i < HOLDER_READS_PER_CLIENT_PER_MIN + 20; i++) await mint.isHolder(testWallet(0x4000 + i));
    });
    expect(reads).toBe(HOLDER_READS_PER_CLIENT_PER_MIN);
    // the server's own checks, another client, and a fresh check (an arena seat) still read
    await mint.isHolder(testWallet(0x5001));
    await asClient('198.51.100.1', () => mint.isHolder(testWallet(0x5002)));
    await asClient('2001:db8:9:9::/64', () => mint.isHolder(testWallet(0x5003), true));
    expect(reads).toBe(HOLDER_READS_PER_CLIENT_PER_MIN + 3);
  });
});
