/**
 * The chain reads a join triggers are cached and bounded (security review S11). Any signed-in wallet can send `join`
 * for a paid arena without a ticket; each one read the ticket at `high` priority (then the top one, shared with
 * settlements), per socket only, with nothing bounding the RPC queue. Now: settlements run at `critical`; concurrent
 * reads of one wallet share one call at `high`; ticket reads are limited per wallet, client and network besides per
 * socket; a server-wide bound answers "network busy" at once instead of queuing, and wallets the `Joined` index does
 * not know fill only a share of it; the holder checks clients trigger are bounded per client, network and server-wide,
 * and a join never waits long on its laurel.
 */
import { EMBLEM_SKIN_ID, PROTOCOL_VERSION, type ServerMessage } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth } from '../src/auth';
import { EvmChain, type EvmChainDeps } from '../src/chain/evm';
import { sessionKey } from '../src/chain/types';
import { RpcBudget, currentRpcPriority, withRpcPriority } from '../src/chain/rpc-budget';
import { loadConfig } from '../src/config';
import { ClientBudgetError, asClient } from '../src/net/client-scope';
import {
  Gateway,
  HOLDER_CHECK_WAIT_MS,
  JOIN_CHAIN_RETRY_MS,
  TICKET_READS_IN_FLIGHT_PER_CLIENT,
  TICKET_READS_IN_FLIGHT_PER_WIDE,
  TICKET_READS_PER_IP_PER_MIN,
  TICKET_READS_PER_WALLET_PER_MIN,
  TICKET_READS_UNKNOWN_SHARE,
  TICKET_READ_QUEUE_S,
} from '../src/net/gateway';
import { RoomManager } from '../src/rooms/manager';
import { HOLDER_READS_BURST_S, HOLDER_READS_PER_CLIENT_PER_MIN, HOLDER_READS_PER_NET_PER_MIN, HOLDER_READS_RPC_SHARE, MintService } from '../src/site/mint';
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

async function setup(deps: Partial<EvmChainDeps> = {}) {
  const evm = new FakeEvm();
  evm.addArena(3, 50_000n);
  const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), GAME_ACCESS: 'public' } as unknown as NodeJS.ProcessEnv);
  const journal = new Journal(null);
  const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0, receiptTimeoutMs: 10, cacheDir: null, ...deps });
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
  it('concurrent reads of one wallet share one call, at high priority (settlements, critical, stay ahead)', async () => {
    const t = await setup();
    t.slow(30);
    const w = getAddress(testWallet(0x51));
    const reads = await Promise.all(Array.from({ length: 10 }, () => t.chain.getSession(3, w)));
    expect(reads.every((r) => r === null)).toBe(true);
    expect(t.evm.sessionReads).toBe(1);
    expect(t.priorities).toEqual(['high']);
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

  it('past the server-wide bound a join hears chain_busy at once instead of queuing; wallets with no known ticket fill only a share of it', async () => {
    const t = await setup();
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length);
    const max = Math.max(16, Math.ceil(t.cfg.chain.rpcMaxRps * TICKET_READ_QUEUE_S));
    const general = Math.floor(max * TICKET_READS_UNKNOWN_SHARE);
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

describe('a paid join under a flood of client work (R2-NET-1, R2-NET-2)', () => {
  /** Every ticket and holder read of the fake chain waits for a real RPC budget (4 calls/s), at its own priority. */
  function onBudget(evm: FakeEvm, budget: RpcBudget): void {
    const ea = evm as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const m of ['session', 'nftBalance']) {
      const real = ea[m].bind(evm);
      ea[m] = async (...a) => (await budget.acquire(1, currentRpcPriority()), real(...a));
    }
  }

  it('holder checks from many /64s on a real RPC budget: bounded server-wide, and a ticket holder is seated at once', async () => {
    const t = await setup();
    const budget = new RpcBudget({ ratePerSec: 4, burst: 8 });
    onBudget(t.evm, budget);
    const mint = new MintService({ store: new SiteStore(null), client: () => t.evm, nft: () => ({ address: NFT, txHash: null }), chainId: () => 31337, stateDir: null, usdCents: 100, fetchPrice: async () => ({ price: '40.0', value: 40 }), logChunkBlocks: 100, rpcMaxRps: 4, log: () => {} });
    t.gateway.setHolderCheck((w) => mint.isHolder(w));
    // an NFT holder with a ticket; its holder answer is cached (it just loaded /play)
    const holder = testWallet(0xabc);
    t.evm.mintNft(holder);
    t.evm.join(3, holder, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    expect(await asClient('192.0.2.20', () => mint.isHolder(holder))).toBe(true);
    // six /64s of six /48s, free wallets: each would spend its 60 holder reads at once (360 balanceOf calls)
    let busy = 0;
    const flood: Promise<unknown>[] = [];
    for (let c = 0; c < 6; c++) {
      for (let i = 0; i < HOLDER_READS_PER_CLIENT_PER_MIN; i++) {
        flood.push(asClient(`2001:db8:${(c + 1).toString(16)}:1::/64`, () => mint.isHolder(testWallet(0x10000 + c * 100 + i))).catch((err) => (expect(err).toBeInstanceOf(ClientBudgetError), busy++)));
      }
    }
    await sleep(20);
    // a burst of the server-wide share went to the chain; everyone else heard busy at once
    const burst = Math.max(4, Math.ceil(4 * HOLDER_READS_RPC_SHARE * HOLDER_READS_BURST_S));
    expect(busy).toBeGreaterThanOrEqual(6 * HOLDER_READS_PER_CLIENT_PER_MIN - burst);
    expect(budget.queued).toBeLessThanOrEqual(burst);
    // a settlement goes first, the paid join next: seated within a second or so
    const t0 = Date.now();
    const settled = withRpcPriority('critical', () => budget.acquire(1)).then(() => Date.now() - t0);
    const me = await t.connect(holder, '192.0.2.20');
    await asClient('192.0.2.20', () => t.send(me, { t: 'join', room: 'arena:3', name: 'me', skin: EMBLEM_SKIN_ID }));
    const seatedAfter = Date.now() - t0;
    expect(errors(me)).toEqual([]);
    expect(seated(me)).toBe(true);
    expect(me.msgs.find((m) => m.t === 'joined')).toMatchObject({ skin: EMBLEM_SKIN_ID });
    expect(seatedAfter).toBeLessThan(1_500);
    expect(await settled).toBeLessThanOrEqual(seatedAfter);
    await Promise.all(flood);
  });

  it('a slow holder check never holds a paid join: seated within HOLDER_CHECK_WAIT_MS, in a basic skin when it asked for the emblem', async () => {
    const t = await setup();
    const answers: ((v: boolean) => void)[] = [];
    t.gateway.setHolderCheck(() => new Promise<boolean>((r) => answers.push(r)));
    const holder = testWallet(0xabd);
    t.evm.join(3, holder, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    const me = await t.connect(holder, '192.0.2.21');
    const t0 = Date.now();
    await t.send(me, { t: 'join', room: 'arena:3', name: 'me', skin: EMBLEM_SKIN_ID });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(HOLDER_CHECK_WAIT_MS - 50);
    expect(took).toBeLessThan(HOLDER_CHECK_WAIT_MS + 1_000);
    expect(errors(me)).toEqual([]);
    expect(me.msgs.find((m) => m.t === 'joined')).toMatchObject({ skin: 0 });
    // a free game with the emblem skin waits for the answer instead: busy, try again
    const other = await t.connect(testWallet(0xabe), '192.0.2.22');
    await t.send(other, { t: 'join', room: 'practice', name: 'x', skin: EMBLEM_SKIN_ID });
    expect(errors(other)).toEqual(['rate_limited']);
    for (const r of answers) r(true);
  });

  /** Free wallets joining a paid arena without a ticket, in a loop, from `ips` (`perIp` sockets each, two per wallet). */
  async function attack(t: Awaited<ReturnType<typeof setup>>, ips: string[], perIp = 4): Promise<() => void> {
    let stop = false;
    let w = 0;
    for (const ip of ips) {
      for (let s = 0; s < perIp; s++) {
        const c = await t.connect(testWallet(0x70000 + (w++ >> 1)), ip);
        void (async () => {
          while (!stop) {
            await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
            await sleep(50);
          }
        })();
      }
    }
    return () => (stop = true);
  }

  it('twelve IPv4 addresses of one /24 hold one network\'s share of the ticket reads: a fresh buyer elsewhere is seated', async () => {
    const t = await setup();
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length, 300, 600, 1_200);
    t.slow(1_500);
    const stop = await attack(t, Array.from({ length: 12 }, (_, i) => `198.51.100.${i + 1}`));
    try {
      await sleep(300);
      // the /24 holds at most TICKET_READS_IN_FLIGHT_PER_WIDE of the bound, however many addresses it uses
      expect((t.gateway as unknown as { ticketReads: number }).ticketReads).toBeLessThanOrEqual(TICKET_READS_IN_FLIGHT_PER_WIDE);
      const buyer = testWallet(0xabc);
      t.evm.join(3, buyer, { openedAt: Math.floor(Date.now() / 1000) - 60 });
      expect(t.chain.knowsOpenTicket(3, buyer)).toBe(false);
      const me = await t.connect(buyer, '192.0.2.20');
      await t.send(me, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
      expect(errors(me)).toEqual([]);
      expect(seated(me)).toBe(true);
    } finally {
      stop();
    }
  });

  it('free wallets from many /24s fill only the unknown share: a ticket bought a moment ago is known by the next retry and seated', async () => {
    const t = await setup({ ticketIndexRefreshMs: 100 });
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length, 300, 600, 1_200);
    t.slow(1_500);
    const max = Math.max(16, Math.ceil(t.cfg.chain.rpcMaxRps * TICKET_READ_QUEUE_S));
    // two addresses in each of eight /24s: up to 64 reads at once, far past the unknown share
    const stop = await attack(t, Array.from({ length: 16 }, (_, i) => `203.0.${(i >> 1) + 1}.${(i & 1) + 1}`));
    try {
      await sleep(300);
      // the free wallets hold the unknown share, never more
      const share = Math.floor(max * TICKET_READS_UNKNOWN_SHARE);
      const inFlight = (t.gateway as unknown as { ticketReads: number }).ticketReads;
      expect(inFlight).toBeLessThanOrEqual(share);
      expect(inFlight).toBeGreaterThan(share / 2);
      const buyer = testWallet(0xabc);
      t.evm.join(3, buyer, { openedAt: Math.floor(Date.now() / 1000) - 60 });
      expect(t.chain.knowsOpenTicket(3, buyer)).toBe(false);
      const me = await t.connect(buyer, '192.0.2.20');
      await t.send(me, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
      // its first read is refused (the share is full) and has the index read the new blocks: a retry gets in
      expect(errors(me).every((e) => e === 'chain_busy')).toBe(true);
      expect(t.chain.knowsOpenTicket(3, buyer)).toBe(true);
      expect(seated(me)).toBe(true);
    } finally {
      stop();
    }
  });
});

describe('holder checks of a client (S11)', () => {
  function holderSetup(rpcMaxRps = 1_000) {
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
      // the per-client tests: a server-wide bucket that is never the limit (the clock stands still)
      rpcMaxRps,
      log: () => {},
      now: () => clock.now,
    });
    return { evm, mint, clock, reads: () => reads, reset: () => (reads = 0) };
  }

  it('client-triggered holder reads are bounded server-wide and per network (an IPv6 /48, an IPv4 /24) (R2-NET-1)', async () => {
    // RPC_MAX_RPS 4: a quarter of it, bursts of 10 s of that
    const h = holderSetup(4);
    const rate = 4 * HOLDER_READS_RPC_SHARE;
    const burst = Math.max(4, Math.ceil(rate * HOLDER_READS_BURST_S));
    const known = testWallet(0x71);
    h.evm.mintNft(known);
    await h.mint.isHolder(known); // the server's own check: never counted
    const stale = testWallet(0x72);
    await asClient('198.51.100.1', () => h.mint.isHolder(stale)); // "no" on record (it mints a moment later)
    h.evm.mintNft(stale);
    h.reset();
    // a hundred clients of a hundred networks, a few throwaway wallets each
    let busy = 0;
    for (let c = 0; c < 100; c++) {
      for (let i = 0; i < 3; i++) await asClient(`10.${c}.0.1`, () => h.mint.isHolder(testWallet(0x9000 + c * 10 + i))).catch((err) => (expect(err).toBeInstanceOf(ClientBudgetError), busy++));
    }
    expect(h.reads()).toBe(burst - 1);
    expect(busy).toBe(300 - (burst - 1));
    // past the bucket a holder on record keeps its answer; a stale "no" is busy, never "not a holder"
    h.clock.now += 20_000; // the holder's answer is old, the "no" too
    for (let i = 0; i < 2 * burst; i++) await asClient('10.200.0.1', () => h.mint.isHolder(testWallet(0x9900 + i))).catch(() => false);
    expect(await asClient('198.51.100.1', () => h.mint.isHolder(known))).toBe(true);
    await expect(asClient('198.51.100.1', () => h.mint.isHolder(stale))).rejects.toBeInstanceOf(ClientBudgetError);
    // the bucket refills at its rate
    h.reset();
    h.clock.now += 5_000;
    for (let i = 0; i < 20; i++) await asClient(`10.201.${i}.1`, () => h.mint.isHolder(testWallet(0x9a00 + i))).catch(() => false);
    expect(h.reads()).toBe(5 * rate);

    // per network, with a bucket that is never the limit: /64s of one /48, addresses of one /24
    const n = holderSetup();
    for (let i = 0; i < HOLDER_READS_PER_NET_PER_MIN + 10; i++) await asClient(`2001:db8:5:${(i + 1).toString(16)}::/64`, () => n.mint.isHolder(testWallet(0xa000 + i))).catch(() => false);
    expect(n.reads()).toBe(HOLDER_READS_PER_NET_PER_MIN);
    n.reset();
    for (let i = 0; i < HOLDER_READS_PER_NET_PER_MIN + 10; i++) await asClient(`203.0.113.${(i % 250) + 1}`, () => n.mint.isHolder(testWallet(0xb000 + i))).catch(() => false);
    expect(n.reads()).toBe(HOLDER_READS_PER_NET_PER_MIN);
    // another /48 and another /24 are not affected
    n.reset();
    await asClient('2001:db8:6:1::/64', () => n.mint.isHolder(testWallet(0xc001)));
    await asClient('203.0.114.1', () => n.mint.isHolder(testWallet(0xc002)));
    expect(n.reads()).toBe(2);
  });

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
