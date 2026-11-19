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
import { sessionKey } from '../src/chain/types';
import { currentRpcPriority } from '../src/chain/rpc-budget';
import { loadConfig } from '../src/config';
import { ClientBudgetError, asClient } from '../src/net/client-scope';
import {
  Gateway,
  JOIN_CHAIN_RETRY_MS,
  TICKET_READS_IN_FLIGHT_PER_CLIENT,
  TICKET_READS_IN_FLIGHT_PER_WIDE,
  TICKET_READS_PER_IP_PER_MIN,
  TICKET_READS_PER_WALLET_PER_MIN,
  TICKET_READ_QUEUE_S,
  TICKET_READ_RESERVE,
} from '../src/net/gateway';
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

const seated = (c: TestConn) => c.msgs.some((m) => m.t === 'joined');
/** The stale sweeper's `Joined`-log index holds this ticket (what a sweep after its purchase would have read). */
function knownTicket(chain: EvmChain, arenaId: number, player: string, id: number | bigint): void {
  const index = (chain as unknown as { index: { candidates: Map<string, { arenaId: number; player: string; sessionId: bigint }> } }).index;
  index.candidates.set(sessionKey(arenaId, player, id), { arenaId, player: getAddress(player), sessionId: BigInt(id) });
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

  it('past the server-wide bound a join hears chain_busy at once instead of queuing; its last share is kept for known ticket holders', async () => {
    const t = await setup();
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length);
    const max = Math.max(16, Math.ceil(t.cfg.chain.rpcMaxRps * TICKET_READ_QUEUE_S));
    const general = Math.floor(max * (1 - TICKET_READ_RESERVE));
    t.slow(300);
    const conns: TestConn[] = [];
    const joins: Promise<void>[] = [];
    // free wallets (no ticket), each from a client of its own
    for (let i = 0; i < max + 3; i++) {
      const c = await t.connect(testWallet(0x3000 + i), `10.${i >> 8}.${i & 255}.1`);
      conns.push(c);
      joins.push(t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 }));
    }
    // a ticket holder the server knows of (its ticket is in the Joined-log index): the reserve is its
    const holder = testWallet(0x3fff);
    const ticket = t.evm.join(3, holder, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    knownTicket(t.chain, 3, holder, ticket.id);
    const mine = await t.connect(holder, '192.0.2.44');
    joins.push(t.send(mine, { t: 'join', room: 'arena:3', name: 'me', skin: 0 }));
    await sleep(50);
    // the rest were answered before any read came back
    expect(conns.slice(general).every((c) => errors(c).join() === 'chain_busy')).toBe(true);
    await Promise.all(joins);
    expect(t.evm.sessionReads).toBe(general + 1);
    expect(conns.slice(0, general).every((c) => errors(c).join() === 'no_session')).toBe(true);
    expect(seated(mine)).toBe(true);
  });

  it('one network holds a small share of the bound: an IPv6 /48 cannot fill it, and a ticket holder elsewhere is seated (NET-R1-4)', async () => {
    const t = await setup();
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length);
    t.slow(300);
    const joins: Promise<void>[] = [];
    // 64 /64s of one /48, a free wallet each, all joining at once
    const wide = Array.from({ length: 64 }, (_, i) => `2001:db8:66:${(i + 1).toString(16)}::1`);
    const fromWide: TestConn[] = [];
    for (const [i, ip] of wide.entries()) {
      const c = await t.connect(testWallet(0x7000 + i), ip);
      fromWide.push(c);
      joins.push(t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 }));
    }
    // one IPv4 address, many free wallets
    const fromOne: TestConn[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await t.connect(testWallet(0x7100 + i), '203.0.113.66');
      fromOne.push(c);
      joins.push(t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 }));
    }
    await sleep(50);
    expect(t.evm.sessionReads).toBe(0);
    expect(fromWide.filter((c) => errors(c).join() === 'chain_busy')).toHaveLength(64 - TICKET_READS_IN_FLIGHT_PER_WIDE);
    expect(fromOne.filter((c) => errors(c).join() === 'chain_busy')).toHaveLength(12 - TICKET_READS_IN_FLIGHT_PER_CLIENT);
    // a real ticket holder on another network, not in the index yet (a ticket bought a moment ago)
    const holder = testWallet(0xabc);
    const ticket = t.evm.join(3, holder, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    const me = await t.connect(holder, '198.51.100.20');
    await t.send(me, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
    expect(errors(me)).toEqual([]);
    expect(seated(me)).toBe(true);
    expect(t.rooms.findArenaStake(3, holder)?.entry.session).toBe(sessionKey(3, holder, ticket.id));
    await Promise.all(joins);
  });

  it('ticket reads a minute are bounded per IPv6 /48 too, not only per /64', async () => {
    const t = await setup();
    const got: string[] = [];
    for (let i = 0; i < TICKET_READS_PER_IP_PER_MIN * 2 + 10; i++) {
      // a new /64 of one /48 (and a new wallet) every time
      const c = await t.connect(testWallet(0x8000 + i), `2001:db8:77:${(i + 1).toString(16)}::1`);
      await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
      got.push(errors(c).join());
    }
    expect(t.evm.sessionReads).toBe(TICKET_READS_PER_IP_PER_MIN * 2);
    expect(got.filter((e) => e === 'rate_limited')).toHaveLength(10);
    // another /48 is not affected
    const other = await t.connect(testWallet(0x8fff), '2001:db8:78:1::1');
    await t.send(other, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    expect(errors(other)).toEqual(['no_session']);
  });
});

describe('holder checks of a client (S11)', () => {
  function holderSetup() {
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
    return { evm, mint, clock, reads: () => reads, reset: () => (reads = 0) };
  }

  it('concurrent checks of one wallet share one read; a client\'s cache misses are bounded', async () => {
    const h = holderSetup();
    const w = testWallet(0x61);
    await Promise.all(Array.from({ length: 8 }, () => h.mint.isHolder(w)));
    expect(h.reads()).toBe(1);
    // one client, a new throwaway wallet for every join: the chain is read HOLDER_READS_PER_CLIENT_PER_MIN times
    h.reset();
    const busy = await asClient('2001:db8:9:9::/64', async () => {
      let n = 0;
      for (let i = 0; i < HOLDER_READS_PER_CLIENT_PER_MIN + 20; i++) await h.mint.isHolder(testWallet(0x4000 + i)).catch((err) => (expect(err).toBeInstanceOf(ClientBudgetError), n++));
      return n;
    });
    expect(h.reads()).toBe(HOLDER_READS_PER_CLIENT_PER_MIN);
    expect(busy).toBe(20);
    // the server's own checks, another client, and a fresh check (an arena seat) still read
    await h.mint.isHolder(testWallet(0x5001));
    await asClient('198.51.100.1', () => h.mint.isHolder(testWallet(0x5002)));
    await asClient('2001:db8:9:9::/64', () => h.mint.isHolder(testWallet(0x5003), true));
    expect(h.reads()).toBe(HOLDER_READS_PER_CLIENT_PER_MIN + 3);
  });

  it('a spent client budget never tells a holder it is none: the last answer, or busy (NET-R1-5)', async () => {
    const h = holderSetup();
    const known = testWallet(0x62);
    const fresh = testWallet(0x63);
    h.evm.mintNft(known);
    h.evm.mintNft(fresh);
    const nat = '203.0.113.80';
    await asClient(nat, () => h.mint.isHolder(known));
    // others behind the same address spend its budget
    await asClient(nat, async () => {
      for (let i = 0; i < HOLDER_READS_PER_CLIENT_PER_MIN; i++) await h.mint.isHolder(testWallet(0x6000 + i)).catch(() => false);
    });
    h.clock.now += 60_000 - 1; // the cached answer is old, the minute is not over
    // a holder with an answer on record gets it; one with none yet hears busy, never "not a holder"
    expect(await asClient(nat, () => h.mint.isHolder(known))).toBe(true);
    await expect(asClient(nat, () => h.mint.isHolder(fresh))).rejects.toBeInstanceOf(ClientBudgetError);
    // the game gate turns that into "busy, try again", not "the game is not open to this wallet"
    const t = await setup();
    t.gateway.setGameGate((wallet, isFresh) => !!wallet && h.mint.isHolder(wallet, isFresh));
    const c = await t.connect(fresh, nat);
    await asClient(nat, () => t.send(c, { t: 'join', room: 'practice', name: 'x', skin: 0 }));
    expect(errors(c)).toEqual(['rate_limited']);
    // the next minute, the same join goes in
    h.clock.now += 1_000;
    c.msgs.length = 0;
    await asClient(nat, () => t.send(c, { t: 'join', room: 'practice', name: 'x', skin: 0 }));
    expect(errors(c)).toEqual([]);
    expect(seated(c)).toBe(true);
  });
});
