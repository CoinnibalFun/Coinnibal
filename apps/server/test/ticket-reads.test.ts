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
  TICKET_READS_PER_NET_PER_MIN,
  TICKET_READS_PER_WALLET_PER_MIN,
  TICKET_READS_UNKNOWN_SHARE,
  TICKET_READ_QUEUE_S,
} from '../src/net/gateway';
import { RoomManager } from '../src/rooms/manager';
import { HOLDERS_FRESH_MS, HOLDERS_ON_DEMAND_MS, HOLDER_READS_BURST_S, HOLDER_READS_QUIET_MS, HOLDER_READS_RPC_SHARE, MintService, holderReadLimits } from '../src/site/mint';
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

  it('ticket reads a minute of wallets the index does not know are bounded per IPv6 /48 too, not only per /64', async () => {
    const t = await setup();
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length);
    const got: string[] = [];
    for (let i = 0; i < TICKET_READS_PER_NET_PER_MIN + 10; i++) {
      // a new /64 of one /48 (and a new wallet) every time
      const c = await t.connect(testWallet(0x8000 + i), `2001:db8:77:${(i + 1).toString(16)}::1`);
      await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
      got.push(errors(c).join());
    }
    expect(t.evm.sessionReads).toBe(TICKET_READS_PER_NET_PER_MIN);
    // past it: "network busy" (the join retries; a ticket bought a moment ago is in the index by then)
    expect(got.filter((e) => e === 'chain_busy')).toHaveLength(10);
    // another /48 is not affected
    const other = await t.connect(testWallet(0x8fff), '2001:db8:78:1::1');
    await t.send(other, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    expect(errors(other)).toEqual(['no_session']);
  });

  it('two addresses of one /24 with free wallets cannot keep a ticket holder on a third address out (R3-NET-3)', async () => {
    const t = await setup({ ticketIndexRefreshMs: 50 });
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length, 100, 200, 400);
    // two SIMs of one carrier's NAT pool (172.58.10.0/24), four free wallets each, three sockets per wallet, each
    // socket spending its own burst of joins without a ticket: the /24's minute for unknown wallets is spent
    let refusedHere = 0;
    for (let a = 0; a < 2; a++) {
      for (let w = 0; w < 4; w++) {
        for (let k = 0; k < 3; k++) {
          const c = await t.connect(testWallet(0x7100 + a * 10 + w), `172.58.10.${a + 1}`);
          for (let i = 0; i < 6; i++) await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
          refusedHere += errors(c).filter((e) => e === 'chain_busy' || e === 'rate_limited').length;
        }
      }
    }
    expect(refusedHere).toBeGreaterThan(0);
    // a ticket holder the index knows, on a third address: no network bound applies to it, seated at once
    const known = testWallet(0xabc);
    const kt = t.evm.join(3, known, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    knownTicket(t.chain, 3, known, kt.id);
    const k = await t.connect(known, '172.58.10.77');
    await t.send(k, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
    expect(errors(k)).toEqual([]);
    expect(seated(k)).toBe(true);
    // a free wallet on another address of the /24 is refused for the network's minute
    const free = await t.connect(testWallet(0x7200), '172.58.10.50');
    await t.send(free, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    expect(errors(free)).toContain('chain_busy');
    // a ticket bought a moment ago (not in the index yet), on a fourth address: refused once for the network's minute,
    // which has the index read the new blocks; the join's retry is known and seated
    const buyer = testWallet(0xabd);
    t.evm.join(3, buyer, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    expect(t.chain.knowsOpenTicket(3, buyer)).toBe(false);
    const b = await t.connect(buyer, '172.58.10.78');
    await t.send(b, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
    expect(errors(b).every((e) => e === 'chain_busy')).toBe(true);
    expect(t.chain.knowsOpenTicket(3, buyer)).toBe(true);
    expect(seated(b)).toBe(true);
  });

  it('a client\'s free wallets never use up its ticket holders\' reads: known wallets count apart (R3-NET-3)', async () => {
    const t = await setup({ ticketIndexRefreshMs: 50 });
    JOIN_CHAIN_RETRY_MS.splice(0, JOIN_CHAIN_RETRY_MS.length);
    const nat = '198.51.100.200';
    // free wallets behind one carrier NAT address spend its minute of reads (60), and its unknown in-flight share
    for (let i = 0; i < TICKET_READS_PER_IP_PER_MIN + 5; i++) {
      const c = await t.connect(testWallet(0x7300 + i), nat);
      await t.send(c, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    }
    const late = await t.connect(testWallet(0x73ff), nat);
    await t.send(late, { t: 'join', room: 'arena:3', name: 'x', skin: 0 });
    expect(errors(late)).toEqual(['rate_limited']);
    // a ticket holder behind the same address, known to the index: seated
    const holder = testWallet(0xabe);
    const ticket = t.evm.join(3, holder, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    knownTicket(t.chain, 3, holder, ticket.id);
    const me = await t.connect(holder, nat);
    await t.send(me, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
    expect(errors(me)).toEqual([]);
    expect(seated(me)).toBe(true);
    // a fresh buyer there, refused once (the free wallets' minute), has the index read the new blocks: its next try
    // is a known wallet's and is seated
    const buyer = testWallet(0xabf);
    t.evm.join(3, buyer, { openedAt: Math.floor(Date.now() / 1000) - 60 });
    await sleep(60); // the refreshes the free wallets' refusals asked for are over (`ticketIndexRefreshMs`)
    const b = await t.connect(buyer, nat);
    await t.send(b, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
    expect(errors(b)).toEqual(['rate_limited']);
    for (let i = 0; i < 50 && !t.chain.knowsOpenTicket(3, buyer); i++) await sleep(10);
    expect(t.chain.knowsOpenTicket(3, buyer)).toBe(true);
    const b2 = await t.connect(buyer, nat);
    await t.send(b2, { t: 'join', room: 'arena:3', name: 'me', skin: 0 });
    expect(errors(b2)).toEqual([]);
    expect(seated(b2)).toBe(true);
  });
});

describe('a paid join under a flood of client work (R2-NET-1, R2-NET-2)', () => {
  /** Every ticket and holder read of the fake chain waits for a real RPC budget (4 calls/s), at its own priority. */
  function onBudget(evm: FakeEvm, budget: RpcBudget): void {
    const ea = evm as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const m of ['session', 'nftBalance', 'blockNumber', 'transferLogs']) {
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
    await mint.holdersCount(); // the holder index read once (the mint page): later scans read only the new blocks
    // six /64s of six /48s, free wallets: 60 holder checks each at once (360 balanceOf calls if nothing bounded them)
    let reads = 0;
    let scans = 0;
    const realBalance = t.evm.nftBalance.bind(t.evm);
    t.evm.nftBalance = async (...a: Parameters<typeof realBalance>) => (reads++, realBalance(...a));
    const realLogs = t.evm.transferLogs.bind(t.evm);
    t.evm.transferLogs = async (...a: Parameters<typeof realLogs>) => (scans++, realLogs(...a));
    const flood: Promise<boolean | 'busy'>[] = [];
    for (let c = 0; c < 6; c++) {
      for (let i = 0; i < 60; i++) {
        flood.push(asClient(`2001:db8:${(c + 1).toString(16)}:1::/64`, () => mint.isHolder(testWallet(0x10000 + c * 100 + i))).catch((err) => (expect(err).toBeInstanceOf(ClientBudgetError), 'busy' as const)));
      }
    }
    await sleep(20);
    // at most a burst of the server-wide share went to the chain as balanceOf; everyone else waits for the holder
    // index to read the new blocks (one scan for all of them)
    const { burst } = holderReadLimits(4);
    expect(reads).toBeLessThanOrEqual(burst);
    expect(budget.queued).toBeLessThanOrEqual(burst + 2);
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
    // every free wallet got its answer, "not a holder", none busy: from the index two scans at most (one already
    // running when the rest asked, then one more), never a balanceOf of its own past the bound
    const answers = await Promise.all(flood);
    expect(answers.every((a) => a === false)).toBe(true);
    expect(reads).toBeLessThanOrEqual(burst);
    expect(scans).toBeLessThanOrEqual(2);
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
  /**
   * `moveClock`: the pause before the holder index may read again for a gate decision (`HOLDERS_FRESH_MS` after the
   * last scan) moves the test's clock; else it is no pause at all (the clock stands still or the test moves it).
   */
  function holderSetup(rpcMaxRps = 1_000, { moveClock = false } = {}) {
    const evm = new FakeEvm();
    let reads = 0;
    /** The wallets `balanceOf` was read for (lower case), in order. */
    const read: string[] = [];
    const real = evm.nftBalance.bind(evm);
    evm.nftBalance = async (...a: Parameters<typeof real>) => (reads++, read.push(String(a[1]).toLowerCase()), await sleep(1), real(...a));
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
      sleep: async (ms) => void (moveClock && (clock.now += ms)),
    });
    // holder index scans (each reads the latest block number once)
    let scans = 0;
    const latest = evm.blockNumber.bind(evm);
    evm.blockNumber = async () => (scans++, latest());
    return { evm, mint, clock, read, reads: () => reads, scans: () => scans, reset: () => ((reads = 0), (read.length = 0), (scans = 0)) };
  }
  /** A holder check of `wallet` on behalf of client `ip`: true / false, or 'busy' (`ClientBudgetError`). */
  const check = (mint: MintService, ip: string, wallet: string) =>
    asClient(ip, () => mint.isHolder(wallet)).catch((err) => {
      expect(err).toBeInstanceOf(ClientBudgetError);
      return 'busy' as const;
    });

  it('the bounds follow the bucket: a client 1/16 of its rate, a network 1/8, so a few networks cannot keep it empty (R3-NET-1)', () => {
    const l = holderReadLimits(4);
    // RPC_MAX_RPS 4: a quarter of it server-wide, bursts of 10 s of that
    expect(l.rate).toBe(4 * HOLDER_READS_RPC_SHARE);
    expect(l.burst).toBe(Math.ceil(l.rate * HOLDER_READS_BURST_S));
    expect(l.client.rate).toBeCloseTo(l.rate / 16);
    expect(l.net.rate).toBeCloseTo(l.rate / 8);
    // seven networks reading without a pause take less than the bucket's rate, and their bursts fit above the reserve
    expect(7 * l.net.rate).toBeLessThan(l.rate);
    expect(l.reserve).toBeGreaterThan(0);
    expect(l.client.burst).toBeLessThanOrEqual(l.net.burst);
    // a higher RPC budget scales every bound with it
    const big = holderReadLimits(400);
    expect(big.client.rate / big.rate).toBeCloseTo(1 / 16);
    expect(big.net.burst).toBeGreaterThan(l.net.burst);
  });

  it('one client at its own limit and three networks cannot starve first-time holders on other networks (R3-NET-1)', async () => {
    // RPC_MAX_RPS 4 (the default): 1 holder read a second server-wide
    const h = holderSetup(4);
    const l = holderReadLimits(4);
    // the attackers: one IPv4 address, a /24 with 16 addresses, two /48s with 16 /64s each; a new throwaway wallet
    // for every check (a "no" is cached 2 s only), every 100 ms, for two minutes
    const attackers = [
      ['198.51.100.7'],
      Array.from({ length: 16 }, (_, i) => `203.0.113.${i + 1}`),
      Array.from({ length: 16 }, (_, i) => `2001:db8:a:${(i + 1).toString(16)}::/64`),
      Array.from({ length: 16 }, (_, i) => `2001:db8:b:${(i + 1).toString(16)}::/64`),
    ].flat();
    let w = 0x100000;
    const attackerAnswers = new Set<boolean | 'busy'>();
    const holders: string[] = [];
    const answers: (boolean | 'busy')[] = [];
    for (let step = 0; step < 1_200; step++) {
      for (const ip of attackers) attackerAnswers.add(await check(h.mint, ip, testWallet(w++)));
      // a first-time holder on a network of its own every 4 s: never checked before, so nothing is on record
      if (step % 40 === 20) {
        const holder = testWallet(0x9000 + holders.length);
        h.evm.mintNft(holder);
        holders.push(holder);
        answers.push(await check(h.mint, `10.${holders.length}.0.9`, holder));
      }
      h.clock.now += 100;
    }
    // every holder was read on chain and told it holds the NFT; none heard busy
    expect(answers).toHaveLength(30);
    expect(answers.every((a) => a === true)).toBe(true);
    for (const holder of holders) expect(h.read).toContain(holder.toLowerCase());
    // the attackers' balanceOf reads: no more than their networks' shares (4 networks, plus their bursts); past them
    // the holder index answered "not a holder", never busy
    const attackerReads = h.read.length - holders.length;
    expect(attackerReads).toBeLessThanOrEqual(Math.ceil(4 * (l.net.rate * 120 + l.net.burst)));
    expect([...attackerAnswers]).toEqual([false]);
    // and the chain was read at most at the bucket's rate
    expect(h.reads()).toBeLessThanOrEqual(l.burst + l.rate * 120);
  });

  it('client-triggered holder reads are bounded server-wide and per network (an IPv6 /48, an IPv4 /24); past them the caught-up holder index answers (R2-NET-1, R4-NET-1)', async () => {
    const h = holderSetup(4);
    const l = holderReadLimits(4);
    const known = testWallet(0x71);
    h.evm.mintNft(known);
    await h.mint.isHolder(known); // the server's own check: never counted
    const stale = testWallet(0x72);
    await check(h.mint, '198.51.100.1', stale); // "no" on record (it mints a moment later)
    h.evm.mintNft(stale);
    h.reset();
    // a hundred clients of a hundred networks, a few throwaway wallets each: at most the bucket's burst is read (the
    // first check of 198.51.100.1 took one token)
    const seen: (boolean | 'busy')[] = [];
    for (let c = 0; c < 100; c++) {
      for (let i = 0; i < 3; i++) seen.push(await check(h.mint, `10.${c}.0.1`, testWallet(0x9000 + c * 10 + i)));
    }
    expect(h.reads()).toBe(l.burst - 1);
    // past the bucket the holder index, read up to a block mined after each check, answers: not a holder, never busy
    expect(seen.filter((a) => a === 'busy')).toHaveLength(0);
    expect(seen.filter((a) => a === false)).toHaveLength(300);
    expect(h.scans()).toBeGreaterThan(0);
    // past the bucket a holder on record keeps its answer; a "no" on record is never taken as it is (it may predate a
    // mint): the index is read up to a block after the check
    h.clock.now += 20_000; // the holder's answer is old, the "no" too
    for (let i = 0; i < 30; i++) await check(h.mint, `10.200.${i}.1`, testWallet(0x9900 + i));
    h.reset();
    expect(await check(h.mint, '198.51.100.1', known)).toBe(true);
    expect(await check(h.mint, '198.51.100.1', testWallet(0x73))).toBe(false);
    // the stale "no" that minted since is a holder by the index caught up, with no read of its own
    expect(await check(h.mint, '198.51.100.1', stale)).toBe(true);
    expect(h.read).toEqual([]);
    // the bucket refills at its rate
    h.reset();
    h.clock.now += 5_000;
    for (let i = 0; i < 20; i++) await check(h.mint, `10.201.${i}.1`, testWallet(0x9a00 + i));
    expect(h.reads()).toBe(5 * l.rate);

    // per network, with a bucket that is never the limit: /64s of one /48, addresses of one /24
    const n = holderSetup();
    const nl = holderReadLimits(1_000);
    for (let i = 0; i < nl.net.burst + 10; i++) await check(n.mint, `2001:db8:5:${(i + 1).toString(16)}::/64`, testWallet(0xa000 + i));
    expect(n.reads()).toBe(nl.net.burst);
    n.reset();
    for (let i = 0; i < nl.net.burst + 10; i++) await check(n.mint, `203.0.113.${(i % 250) + 1}`, testWallet(0xb000 + i));
    expect(n.reads()).toBe(nl.net.burst);
    // a smooth bound: one second later the networks read again at their rate, not a whole new minute at once
    n.reset();
    n.clock.now += 1_000;
    for (let i = 0; i < nl.net.burst; i++) await check(n.mint, `2001:db8:5:${(i + 0x400).toString(16)}::/64`, testWallet(0xa800 + i));
    expect(n.reads()).toBe(Math.floor(nl.net.rate));
    // another /48 and another /24 are not affected
    n.reset();
    await check(n.mint, '2001:db8:6:1::/64', testWallet(0xc001));
    await check(n.mint, '203.0.114.1', testWallet(0xc002));
    expect(n.reads()).toBe(2);
  });

  it('concurrent checks of one wallet share one read; a client\'s cache misses are bounded', async () => {
    const h = holderSetup();
    const l = holderReadLimits(1_000);
    const w = testWallet(0x61);
    await Promise.all(Array.from({ length: 8 }, () => h.mint.isHolder(w)));
    expect(h.reads()).toBe(1);
    // one client, a new throwaway wallet for every join: the chain is read at most the client's burst; past it the
    // holder index (read up to a block after each check) answers, never busy
    h.reset();
    const seen: (boolean | 'busy')[] = [];
    for (let i = 0; i < l.client.burst + 20; i++) seen.push(await check(h.mint, '2001:db8:9:9::/64', testWallet(0x4000 + i)));
    expect(h.reads()).toBe(l.client.burst);
    expect(seen.every((a) => a === false)).toBe(true);
    // the server's own checks, another client, and a fresh check (an arena seat) still read
    await h.mint.isHolder(testWallet(0x5001));
    await asClient('198.51.100.1', () => h.mint.isHolder(testWallet(0x5002)));
    await asClient('2001:db8:9:9::/64', () => h.mint.isHolder(testWallet(0x5003), true));
    expect(h.reads()).toBe(l.client.burst + 3);
  });

  it('two players behind one address, no NFT, the default budget: one plays and browses, the other\'s room creation (a gate decision) is never busy (R4-NET-1)', async () => {
    const h = holderSetup(4, { moveClock: true });
    const nat = '198.51.100.200';
    const a = testWallet(0xa11ce);
    const b = testWallet(0xb0b);
    const t0 = h.clock.now;
    const creates: (boolean | 'busy')[] = [];
    let pageB = t0;
    let gateB = t0;
    let createA = t0 + 5_000;
    while (h.clock.now - t0 <= 180_000) {
      // B: a page every 2 s (auth/me, the profile, a quote, the laurel at a join: only shown) and a gate decision
      // every 4 s (who may play at a join, a join permit): more than the address's own holder reads (one per 16 s)
      if (h.clock.now >= pageB) {
        expect(await asClient(nat, () => h.mint.shownHolder(b))).toBe(false);
        pageB += 2_000;
      }
      if (h.clock.now >= gateB) {
        expect(await check(h.mint, nat, b)).toBe(false);
        gateB += 4_000;
      }
      // A: its pages, then a custom room's creation (create() asks isHolder, not fresh), every 10 s
      if (h.clock.now >= createA) {
        await asClient(nat, () => h.mint.shownHolder(a));
        creates.push(await check(h.mint, nat, a));
        createA += 10_000;
      }
      h.clock.now += 100;
    }
    // every creation was answered (not a holder: the full price), none busy
    expect(creates.length).toBeGreaterThanOrEqual(17);
    expect(creates.every((x) => x === false)).toBe(true);
    // A mints: its next creation is a holder's, though the address's holder reads are spent
    h.evm.mintNft(a);
    expect(await check(h.mint, nat, b)).toBe(false);
    expect(await check(h.mint, nat, a)).toBe(true);
    // the holder index read the new blocks for them at most every HOLDERS_FRESH_MS
    expect(h.scans()).toBeLessThanOrEqual(Math.ceil((h.clock.now - t0) / HOLDERS_FRESH_MS) + 2);
  });

  it('networks of one address that keep reading never take the newcomer reserve: with 24 of them a first check on a new network reads at once, and no gate decision is busy (R4-NET-2)', async () => {
    const h = holderSetup(4, { moveClock: true });
    const l = holderReadLimits(4);
    // 24 attacker addresses, each alone in its /24, a throwaway wallet for every check, as fast as they may
    const attackers = Array.from({ length: 24 }, (_, i) => `100.64.${i}.7`);
    let w = 0x200000;
    const t0 = h.clock.now;
    const victim = testWallet(0xdead);
    const victims: (boolean | 'busy')[] = [];
    const firsts: string[] = [];
    let nextVictim = t0 + 30_000;
    let nextFirst = t0 + HOLDER_READS_QUIET_MS + 10_000;
    while (h.clock.now - t0 < 330_000) {
      for (const ip of attackers) expect(await check(h.mint, ip, testWallet(w++))).toBe(false);
      // a wallet with no NFT and nothing on record, on a network of its own, asking for a gate decision every 20 s
      // (a room's creation): it read 20 s ago, so it is no newcomer either
      if (h.clock.now >= nextVictim) {
        victims.push(await check(h.mint, '10.200.0.9', victim));
        nextVictim += 20_000;
      }
      // a first-time holder on a network of its own every 30 s, once the attackers kept reading for a minute
      if (h.clock.now >= nextFirst) {
        const holder = testWallet(0x9000 + firsts.length);
        h.evm.mintNft(holder);
        firsts.push(holder);
        expect(await check(h.mint, `10.${100 + firsts.length}.0.9`, holder)).toBe(true);
        nextFirst += 30_000;
      }
      h.clock.now += 100;
    }
    // the victim was answered every time (from the holder index past the bounds), never busy
    expect(victims.length).toBeGreaterThanOrEqual(14);
    expect(victims.every((x) => x === false)).toBe(true);
    // every first check on a new network found a token of the reserve: its wallet was read on chain at once
    expect(firsts.length).toBeGreaterThanOrEqual(8);
    for (const holder of firsts) expect(h.read).toContain(holder.toLowerCase());
    // and the chain was read at most at the bucket's rate
    expect(h.reads()).toBeLessThanOrEqual(l.burst + l.rate * (h.clock.now - t0) / 1000);
  });

  it('a spent client budget never tells a holder it is none: the last answer, or the holder index read after the check; busy only while the index cannot tell (NET-R1-5, R3-NET-1, R4-NET-1)', async () => {
    const h = holderSetup(4);
    const l = holderReadLimits(4);
    const known = testWallet(0x62);
    const fresh = testWallet(0x63);
    h.evm.mintNft(known);
    const nat = '203.0.113.80';
    expect(await check(h.mint, nat, known)).toBe(true);
    // others behind the same address spend its budget
    for (let i = 0; i < l.client.burst; i++) await check(h.mint, nat, testWallet(0x6000 + i));
    h.clock.now += 15_001; // the cached answer is old, the client's bucket still empty
    h.reset();
    // a holder with an answer on record gets it; a wallet with none, the holder index read up to a block mined after
    // its check: it holds none, so the game is closed to it (the right answer, not busy)
    expect(await check(h.mint, nat, known)).toBe(true);
    const nobody = testWallet(0x64);
    expect(await check(h.mint, nat, nobody)).toBe(false);
    const t = await setup();
    t.gateway.setGameGate((wallet, isFresh) => !!wallet && h.mint.isHolder(wallet, isFresh));
    const c = await t.connect(nobody, nat);
    await asClient(nat, () => t.send(c, { t: 'join', room: 'practice', name: 'x', skin: 0 }));
    expect(errors(c)).toEqual(['game_closed']);
    // a wallet that minted a moment ago is a holder by the index read after its check, though this client still may
    // not read the chain
    h.evm.mintNft(fresh);
    h.clock.now += 100;
    expect(await check(h.mint, nat, fresh)).toBe(true);
    const me = await t.connect(fresh, nat);
    await asClient(nat, () => t.send(me, { t: 'join', room: 'practice', name: 'x', skin: 0 }));
    expect(errors(me)).toEqual([]);
    expect(seated(me)).toBe(true);
    expect(h.read).toEqual([]);
    // the index cannot read the new blocks (the RPC refuses the logs: a failed scan's back-off): a wallet with nothing
    // on record hears busy, never "not a holder", and the game gate says "busy, try again"; a holder on record plays
    h.clock.now += 3_000;
    await check(h.mint, nat, testWallet(0x6300)); // the token the client's bucket refilled meanwhile
    h.evm.block += 1n;
    h.evm.limited.set('transferLogs', 1);
    expect(await check(h.mint, nat, testWallet(0x66))).toBe('busy');
    c.msgs.length = 0;
    await asClient(nat, () => t.send(c, { t: 'join', room: 'practice', name: 'x', skin: 0 }));
    expect(errors(c)).toEqual(['rate_limited']);
    expect(await check(h.mint, nat, fresh)).toBe(true);
    // once the back-off is over and the client's bucket refilled, the plain wallet is read and answered for real
    h.clock.now += 60_000;
    c.msgs.length = 0;
    await asClient(nat, () => t.send(c, { t: 'join', room: 'practice', name: 'x', skin: 0 }));
    expect(errors(c)).toEqual(['game_closed']);
    expect(h.read).toContain(nobody.toLowerCase());
  });

  it('a value only shown (`shownHolder`) is never busy and never reads the chain: the holder on record, else "not a holder", not kept (R3-NET-1, R4-NET-1)', async () => {
    const h = holderSetup(4);
    const known = testWallet(0x65);
    const fresh = testWallet(0x66);
    h.evm.mintNft(known);
    const nat = '203.0.113.90';
    // pages of many wallets behind one address: never busy, nothing read for them; the index (never read yet) reads
    // the new blocks in the background, so the holder shows as one a moment later
    for (let i = 0; i < 50; i++) expect(await asClient(nat, () => h.mint.shownHolder(testWallet(0x6100 + i)))).toBe(false);
    for (let i = 0; i < 50 && !(await asClient(nat, () => h.mint.shownHolder(known))); i++) await sleep(2);
    expect(await asClient(nat, () => h.mint.shownHolder(known))).toBe(true);
    expect(h.reads()).toBe(0);
    // a wallet that minted a moment ago: "not a holder" (not kept) until the index reads again, at most every
    // HOLDERS_ON_DEMAND_MS, then a holder
    h.evm.mintNft(fresh);
    expect(await asClient(nat, () => h.mint.shownHolder(fresh))).toBe(false);
    h.clock.now += HOLDERS_ON_DEMAND_MS;
    for (let i = 0; i < 50 && !(await asClient(nat, () => h.mint.shownHolder(fresh))); i++) await sleep(2);
    expect(await asClient(nat, () => h.mint.shownHolder(fresh))).toBe(true);
    expect(h.reads()).toBe(0);
    // the pages spent none of the address's holder reads: a gate decision behind it reads the chain at once
    const plain = testWallet(0x6300);
    expect(await check(h.mint, nat, plain)).toBe(false);
    expect(h.read).toEqual([plain.toLowerCase()]);
    // a wallet a gate check read as a holder is shown as one after the 15 s, until a complete index read since says
    // otherwise (it sold the emblem)
    const seller = testWallet(0x6301);
    h.evm.mintNft(seller);
    expect(await check(h.mint, '198.51.100.91', seller)).toBe(true);
    h.clock.now += 20_000;
    expect(await asClient(nat, () => h.mint.shownHolder(seller))).toBe(true);
  });
});
