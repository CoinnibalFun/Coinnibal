/**
 * Join permits (CoinnibalArena v4; 2026-11 audit S16): who may buy a ticket, how many tickets may wait for a seat,
 * and the no-show rule. The contract side (the signature, nonce, deadline) is tested in Solidity; here the server's
 * rules, its EIP-712 signature through the production client model (FakeEvm), the no-show records of the stale
 * sweeper, and `POST /api/arena/permit`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinCall, joinPermitTypedData, signJoinPermit } from '@coinnibal/sdk';
import { JOIN_PERMIT_MAX_WINDOW_S, PROTOCOL_VERSION, type JoinPermit, type ServerMessage } from '@coinnibal/shared';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { EvmChain } from '../src/chain/evm';
import { ChainBusyError, sessionKey, type ChainArena, type ChainSession, type SettledEvent } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { Journal } from '../src/stake/journal';
import { JOIN_PERMIT_TTL_MAX_S, JoinPermitFail, JoinPermits, NET_NO_SHOW_FACTOR, NO_SHOW_WINDOW_MS, SITE_NO_SHOW_FACTOR, requesterOf, type JoinPermitDeps } from '../src/stake/join-permits';
import { ARENA, E18, FakeEvm } from './fake-evm';
import { ArenaChain, arena, testWallet } from './helpers';
import { testSigner } from './signers';

const T0 = 1_790_000_000_000;
const ALICE = getAddress('0x1111111111111111111111111111111111111111');
const BOB = getAddress('0x2222222222222222222222222222222222222222');

/** A chain that issues permits (a model of `EvmChain`: one nonce per wallet, a signature naming every field). */
class PermitChain extends ArenaChain {
  nonces = new Map<string, bigint>();
  open = new Set<string>();
  paused = false;
  busy = false;
  signed: { player: string; arenaId: number; nonce: bigint; deadline: number }[] = [];
  noShowTimes = new Map<string, number[]>();
  /** Game token per wallet (ledger units); null: every wallet holds plenty. */
  balances: Map<string, number> | null = null;
  balanceReads = 0;
  /** The chain's clock (Unix ms); null: none (the permits use the server clock). */
  chainClock: (() => number) | null = null;
  readonly settledFns: ((e: SettledEvent) => void)[] = [];
  async tokenBalance(player: string): Promise<number> {
    this.balanceReads++;
    if (this.busy) throw new ChainBusyError('token balance');
    return this.balances ? (this.balances.get(player.toLowerCase()) ?? 0) : 1e15;
  }
  chainNow(): number {
    return this.chainClock ? this.chainClock() : Date.now();
  }
  override onSettled(fn?: (e: SettledEvent) => void): void {
    if (fn) this.settledFns.push(fn);
  }
  async joinNonce(player: string): Promise<bigint> {
    if (this.busy) throw new ChainBusyError('join nonce');
    return this.nonces.get(player.toLowerCase()) ?? 0n;
  }
  async signJoinPermit(player: string, arenaId: number, nonce: bigint, deadline: number): Promise<JoinPermit> {
    this.signed.push({ player, arenaId, nonce, deadline });
    return { arena: ARENA, chainId: 31337, player: getAddress(player), arenaId, nonce: nonce.toString(), deadline, signature: `0x${(this.signed.length % 10).toString().repeat(130)}` };
  }
  joinsPaused(): boolean {
    return this.paused;
  }
  async hasOpenTicket(arenaId: number, player: string): Promise<boolean> {
    if (this.busy) throw new ChainBusyError('session');
    return this.open.has(`${arenaId}:${player.toLowerCase()}`);
  }
  noShowsSince(player: string, since: number): number[] {
    return (this.noShowTimes.get(player.toLowerCase()) ?? []).filter((t) => t >= since);
  }
}

function harness(o: Partial<JoinPermitDeps> & { arenas?: ChainArena[] } = {}) {
  const chain = new PermitChain(o.arenas ?? [arena(1, 1000), { ...arena(2, 3000), enabled: false }]);
  const clock = { now: T0 };
  // the chain's clock agrees with the server's unless a test moves it
  chain.chainClock = () => clock.now;
  const h = {
    chain,
    clock,
    gameOpen: true,
    banned: new Set<string>(),
    blocked: [] as number[],
    seated: new Set<string>(),
    pending: [] as string[],
    seats: 4,
    holders: new Set<string>(),
    permits: null as unknown as JoinPermits,
  };
  h.permits = new JoinPermits({
    chain,
    gameOpenFor: async () => h.gameOpen,
    isBanned: (w) => h.banned.has(w.toLowerCase()),
    isHolder: async (w) => h.holders.has(w.toLowerCase()),
    blocked: () => h.blocked,
    seatedKeys: () => h.seated,
    pendingKeys: () => h.pending,
    seatsPerRound: () => h.seats,
    noShows: (w, since) => chain.noShowsSince(w, since),
    now: () => clock.now,
    ...o,
  });
  return h;
}

const fail = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(JoinPermitFail);
  return e as JoinPermitFail;
};

describe('join permits: who gets one', () => {
  it('a signed-in wallet gets one permit per arena; asking again returns the same one while it is valid and unused', async () => {
    const h = harness();
    const p = await h.permits.issue(ALICE, 1, '10.0.0.1');
    expect(p).toMatchObject({ player: ALICE, arenaId: 1, nonce: '0', deadline: Math.floor(T0 / 1000) + 600 });
    expect(await h.permits.issue(ALICE, 1, '10.0.0.1')).toEqual(p);
    expect(h.chain.signed).toHaveLength(1);
    // used (the nonce moved on): a new one
    h.chain.nonces.set(ALICE.toLowerCase(), 1n);
    expect((await h.permits.issue(ALICE, 1, '10.0.0.1')).nonce).toBe('1');
    // close to its end: a new one with a full window
    h.clock.now += 9 * 60_000;
    const late = await h.permits.issue(ALICE, 1, '10.0.0.1');
    expect(late.deadline).toBe(Math.floor(h.clock.now / 1000) + 600);
    expect(h.chain.signed).toHaveLength(3);
  });

  it('refuses a closed game, a banned wallet, paid rooms off, a closed, paused, blocked or unknown arena, and an open ticket', async () => {
    const h = harness();
    h.gameOpen = false;
    expect((await fail(h.permits.issue(ALICE, 1, '10.0.0.1'))).code).toBe('game_closed');
    h.gameOpen = true;
    h.banned.add(ALICE.toLowerCase());
    expect((await fail(h.permits.issue(ALICE, 1, '10.0.0.2'))).code).toBe('banned');
    h.banned.clear();
    expect((await fail(h.permits.issue(ALICE, 2, '10.0.0.3'))).code).toBe('arena_closed'); // disabled on chain
    expect((await fail(h.permits.issue(ALICE, 9, '10.0.0.4'))).code).toBe('arena_closed'); // no such arena
    h.blocked = [1];
    expect((await fail(h.permits.issue(ALICE, 1, '10.0.0.5'))).code).toBe('arena_closed'); // books guard / re-price
    h.blocked = [];
    h.chain.paused = true;
    expect((await fail(h.permits.issue(ALICE, 1, '10.0.0.6'))).code).toBe('arena_closed');
    h.chain.paused = false;
    h.chain.open.add(`1:${ALICE.toLowerCase()}`);
    const open = await fail(h.permits.issue(ALICE, 1, '10.0.0.7'));
    expect([open.code, open.status]).toEqual(['session_open', 409]);
    h.chain.busy = true;
    expect((await fail(h.permits.issue(BOB, 1, '10.0.0.8'))).code).toBe('chain_busy');
    expect((await fail(h.permits.issue(ALICE, 0, '10.0.0.9'))).code).toBe('bad_request');
    expect(h.chain.signed).toHaveLength(0);
    const off = harness();
    (off.chain as { stakeEnabled: boolean }).stakeEnabled = false;
    expect((await fail(off.permits.issue(ALICE, 1, '10.0.0.10'))).code).toBe('arenas_off');
  });

  it('a wallet whose tickets went back unplayed 3 times in a day gets no permit until the oldest is a day old, and is told when', async () => {
    const h = harness();
    const hour = 3_600_000;
    h.chain.noShowTimes.set(ALICE.toLowerCase(), [T0 - 30 * hour, T0 - 20 * hour, T0 - 5 * hour, T0 - hour]);
    const e = await fail(h.permits.issue(ALICE, 1, '10.0.0.1'));
    expect([e.code, e.status, e.retryAt]).toEqual(['no_show', 403, T0 - 20 * hour + NO_SHOW_WINDOW_MS]);
    expect(e.message).toMatch(/never played/);
    // two in the window: fine again
    h.clock.now = T0 - 20 * hour + NO_SHOW_WINDOW_MS + 1;
    expect((await h.permits.issue(ALICE, 1, '10.0.0.1')).player).toBe(ALICE);
    // another wallet is not affected; the limit can be turned off
    const off = harness({ cfg: { noShowLimit: 0 } });
    off.chain.noShowTimes.set(ALICE.toLowerCase(), [T0 - 3, T0 - 2, T0 - 1]);
    expect((await off.permits.issue(ALICE, 1, '10.0.0.1')).player).toBe(ALICE);
  });

  it('an arena takes at most its cap of unseated tickets plus held places; seated tickets and queued payouts do not count', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 3;
    const wallets = [1, 2, 3, 4].map((i) => testSigner().address);
    for (const w of wallets.slice(0, 3)) await h.permits.issue(w, 1, `10.0.1.${wallets.indexOf(w)}`);
    // three new permits hold a place each: the fourth wallet waits
    const busy = await fail(h.permits.issue(wallets[3], 1, '10.0.1.9'));
    expect([busy.code, busy.status]).toEqual(['arena_busy', 409]);
    // the first wallet's ticket is seated: its permit is done and the seat does not count
    h.seated.add(sessionKey(1, wallets[0], 7));
    h.chain.arenas[0].openSessions = 1;
    expect((await h.permits.issue(wallets[3], 1, '10.0.1.9')).player).toBe(wallets[3]);
    // the places lapse (2 minutes); unseated tickets on chain count instead (a payout being settled does not)
    h.clock.now += 11 * 60_000;
    h.seated.clear();
    h.chain.arenas[0].openSessions = 4;
    h.pending = [sessionKey(1, wallets[1], 8)];
    expect((await fail(h.permits.issue(BOB, 1, '10.0.1.10'))).code).toBe('arena_busy');
    h.pending.push(sessionKey(1, wallets[2], 9));
    expect((await h.permits.issue(BOB, 1, '10.0.1.10')).player).toBe(BOB);
    // the configured cap wins over the seats of a round
    const fixed = harness({ arenas: [arena(1, 1000)], cfg: { arenaCap: 1 } });
    await fixed.permits.issue(ALICE, 1, '10.0.2.1');
    expect((await fail(fixed.permits.issue(BOB, 1, '10.0.2.2'))).code).toBe('arena_busy');
  });

  it('limits requests per IP, per IPv6 /64 and per wallet', async () => {
    const h = harness({ cfg: { perIp: 2, perSubnet: 3, perWallet: 4 } });
    await h.permits.issue(ALICE, 1, '10.0.0.1');
    await h.permits.issue(ALICE, 1, '10.0.0.1');
    expect((await fail(h.permits.issue(BOB, 1, '10.0.0.1'))).code).toBe('rate_limited');
    // another IPv4 address is another player
    expect((await h.permits.issue(BOB, 1, '10.0.0.2')).player).toBe(BOB);
    // every address of one IPv6 /64 shares a limit
    const v6 = harness({ cfg: { perIp: 2, perSubnet: 3, perWallet: 10 } });
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:aaaa::3']) await v6.permits.issue(testSigner().address, 1, ip);
    const e = await fail(v6.permits.issue(testSigner().address, 1, '2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect([e.code, e.status]).toEqual(['rate_limited', 429]);
    expect((await v6.permits.issue(testSigner().address, 1, '2001:db8:1:3::1')).arenaId).toBe(1);
    // one wallet from many addresses
    const w = harness({ cfg: { perIp: 100, perSubnet: 100, perWallet: 2 } });
    await w.permits.issue(ALICE, 1, '10.9.0.1');
    await w.permits.issue(ALICE, 1, '10.9.0.2');
    expect((await fail(w.permits.issue(ALICE, 1, '10.9.0.3'))).code).toBe('rate_limited');
  });
});

describe('a permit is free, so it holds a place only briefly and only when backed (audit S16, round 2)', () => {
  /** Wallets that hold no game token (the attacker's), and an IPv6 address in the `n`-th /64 of 2001:db8:0::/48. */
  const v6 = (n: number, host: number) => `2001:db8:0:${n.toString(16)}::${host.toString(16)}`;

  it('300 signed-in wallets without the entry fee, from ten IPv6 /64s, never push a funded player to arena_busy', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300; // the default cap: ARENA_INSTANCE_CAP 50 × 6 instances
    h.chain.balances = new Map();
    const attackers = Array.from({ length: 300 }, (_, i) => testWallet(0x1000 + i));
    for (let i = 0; i < 300; i++) expect((await h.permits.issue(attackers[i], 1, v6(Math.floor(i / 30), (i % 30) + 1))).player).toBe(attackers[i]);
    // every permit was issued, none holds a place
    expect(await h.permits.load(1, 0)).toMatchObject({ used: 0, held: 0 });
    const player = testWallet(0xabcdef);
    h.chain.balances.set(player.toLowerCase(), 1000);
    expect((await h.permits.issue(player, 1, '198.51.100.7')).player).toBe(player);
    expect((await h.permits.load(1, 0)).held).toBe(1);
    // nine minutes on the attackers ask again (fresh permits, from ten other /64s): still no place
    h.clock.now += 9 * 60_000;
    for (let i = 0; i < 300; i++) await h.permits.issue(attackers[i], 1, v6(16 + Math.floor(i / 30), (i % 30) + 1));
    expect(h.chain.signed).toHaveLength(601);
    expect(await h.permits.load(1, 0)).toMatchObject({ used: 0, held: 0 });
    const next = testWallet(0xabcdee);
    h.chain.balances.set(next.toLowerCase(), 5000);
    expect((await h.permits.issue(next, 1, '198.51.100.8')).player).toBe(next);
  });

  it('funded wallets hold at most 4 places per IPv4 address or IPv6 /64 and 16 per /48, and one per wallet, arena and nonce', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    // 40 funded wallets from ten /64s of one /48: 4 places per /64, 16 in the /48
    for (let i = 0; i < 40; i++) await h.permits.issue(testWallet(0x2000 + i), 1, v6(Math.floor(i / 4), (i % 4) + 1));
    expect((await h.permits.load(1, 0)).held).toBe(16);
    // another /48 has its own share; so does an IPv4 address (4)
    for (let i = 0; i < 10; i++) await h.permits.issue(testWallet(0x2100 + i), 1, `2001:db8:9:1::${i + 1}`);
    for (let i = 0; i < 6; i++) await h.permits.issue(testWallet(0x2200 + i), 1, '203.0.113.5');
    expect((await h.permits.load(1, 0)).held).toBe(24);
    expect(h.chain.signed).toHaveLength(56);
    // the places lapse after 2 minutes; a permit signed again for the same nonce holds none
    h.clock.now += 9 * 60_000;
    expect((await h.permits.load(1, 0)).held).toBe(0);
    const w = testWallet(0x2100);
    await h.permits.issue(w, 1, '2001:db8:9:1::1');
    expect((await h.permits.load(1, 0)).held).toBe(0);
    // its ticket was bought and settled: the next nonce holds a place again
    h.chain.nonces.set(w.toLowerCase(), 1n);
    await h.permits.issue(w, 1, '2001:db8:9:1::1');
    expect((await h.permits.load(1, 0)).held).toBe(1);
    // the balance is read only when a place could be held (a permit handed out again reads nothing)
    const reads = h.chain.balanceReads;
    await h.permits.issue(w, 1, '2001:db8:9:1::1');
    expect(h.chain.balanceReads).toBe(reads);
    expect(requesterOf('::ffff:203.0.113.5')).toEqual({ net: '203.0.113.5', site: null });
    expect(requesterOf('2001:DB8:9:1:aaaa::7')).toEqual({ net: '2001:db8:9:1::/64', site: '2001:db8:9::/48' });
  });

  it('a holders-only arena gives no permit to a wallet without the NFT', async () => {
    const h = harness({ arenas: [{ ...arena(4, 5000), holdersOnly: true }] });
    const e = await fail(h.permits.issue(ALICE, 4, '10.0.0.1'));
    expect([e.code, e.status]).toEqual(['holders_only', 403]);
    expect(h.chain.signed).toHaveLength(0);
    h.holders.add(ALICE.toLowerCase());
    expect((await h.permits.issue(ALICE, 4, '10.0.0.1')).arenaId).toBe(4);
  });

  it('a bell followed by a re-buy wave of players below the cap is never refused: a used permit is not counted twice', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    const a = h.chain.arenas[0];
    const N = 280;
    const players = Array.from({ length: N }, (_, i) => testWallet(0x3000 + i));
    const ip = (i: number) => `10.${i >> 8}.${i & 255}.7`;
    let sid = 0;
    let refused = 0;
    const ask = (i: number) =>
      h.permits.issue(players[i], 1, ip(i)).catch((err: unknown) => {
        refused++;
        throw err;
      });
    // the join mines (the nonce moves, the ticket is open on chain) and the web enters the room: the wallet asks to sit
    const bought = (i: number, seat: boolean) => {
      const w = players[i].toLowerCase();
      h.chain.nonces.set(w, (h.chain.nonces.get(w) ?? 0n) + 1n);
      a.openSessions++;
      const key = sessionKey(1, w, ++sid);
      h.permits.ticketSeen(w, 1, null);
      if (seat) {
        // the round is open: the ticket is read and seated
        h.permits.ticketSeen(w, 1, Math.floor(h.clock.now / 1000));
        h.seated.add(key);
      }
    };
    const bell = () => {
      h.clock.now += 5 * 60_000;
      for (const w of players) h.permits.ticketDone(w, 1);
      h.seated.clear();
      a.openSessions = 0;
    };
    // round 1: one after another, each buys and sits down
    for (let i = 0; i < N; i++) {
      await ask(i);
      bought(i, true);
    }
    expect(refused).toBe(0);
    // the bell: every ticket settled; in the break every player buys the next one (it waits for the round, unseated)
    bell();
    expect(await h.permits.load(1, 0)).toMatchObject({ used: 0 });
    for (let i = 0; i < N; i++) {
      await ask(i);
      bought(i, false);
    }
    expect(refused).toBe(0);
    expect(await h.permits.load(1, a.openSessions)).toMatchObject({ unseated: N, held: 0 });
    // the round opens: all seated; the next bell, and this time everybody asks before anybody buys
    for (let i = 0; i < N; i++) h.seated.add(sessionKey(1, players[i], 1000 + i));
    bell();
    for (let i = 0; i < N; i++) await ask(i);
    expect(await h.permits.load(1, 0)).toMatchObject({ used: N, held: N });
    for (let i = 0; i < N; i++) bought(i, false);
    expect(await h.permits.load(1, a.openSessions)).toMatchObject({ used: N, unseated: N, held: 0 });
    expect(refused).toBe(0);
    // a newcomer still fits (280 of 300)
    expect((await h.permits.issue(BOB, 1, '198.51.100.9')).player).toBe(BOB);
  });

  it('buyers that never ask to sit are not counted twice either: at the cap the held places\' nonces are read again', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    const a = h.chain.arenas[0];
    let reads = 0;
    const joinNonce = h.chain.joinNonce.bind(h.chain);
    h.chain.joinNonce = async (w: string) => {
      reads++;
      return joinNonce(w);
    };
    // 200 players in the break: each gets a permit and buys at once, and none of their pages enters the room
    for (let i = 0; i < 200; i++) {
      const w = testWallet(0x5000 + i);
      await h.permits.issue(w, 1, `10.1.${i >> 8}.${i & 255}`);
      h.chain.nonces.set(w.toLowerCase(), 1n);
      a.openSessions++;
    }
    // at 150 bought tickets (150 unseated + 150 places = the cap of 300) the 150 holders were read again and dropped;
    // the 50 after them hold their place until it lapses, they ask again, or the next refusal reads them
    expect(await h.permits.load(1, a.openSessions)).toMatchObject({ unseated: 200, held: 50 });
    expect(reads).toBe(200 + 150);
    // places held by permits not used yet are read at most once per 10 s, however many requests meet the cap
    const idle = harness({ arenas: [arena(1, 1000)] });
    idle.seats = 2;
    await idle.permits.issue(ALICE, 1, '10.2.0.1');
    await idle.permits.issue(BOB, 1, '10.2.0.2');
    let idleReads = 0;
    const idleNonce = idle.chain.joinNonce.bind(idle.chain);
    idle.chain.joinNonce = async (w: string) => {
      idleReads++;
      return idleNonce(w);
    };
    for (let i = 0; i < 5; i++) expect((await fail(idle.permits.issue(testWallet(0x5900 + i), 1, `10.2.1.${i}`))).code).toBe('arena_busy');
    // five requests: their own nonce each, and the two holders once
    expect(idleReads).toBe(5 + 2);
    idle.clock.now += 11_000;
    await fail(idle.permits.issue(testWallet(0x5990), 1, '10.2.2.1'));
    expect(idleReads).toBe(5 + 2 + 1 + 2);
  });

  it('the reviewer\'s case: five bought tickets waiting in the break count once, so five more players fit a cap of ten', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 10;
    const a = h.chain.arenas[0];
    for (let i = 0; i < 5; i++) {
      const w = testWallet(0x100 + i);
      await h.permits.issue(w, 1, `198.51.100.${i + 1}`);
      h.chain.nonces.set(w.toLowerCase(), 1n);
      a.openSessions++;
      h.permits.ticketSeen(w, 1, null); // round_closed: held for the round
    }
    expect(await h.permits.load(1, a.openSessions)).toMatchObject({ used: 5, unseated: 5, held: 0 });
    for (let i = 5; i < 10; i++) expect((await h.permits.issue(testWallet(0x100 + i), 1, `198.51.100.${i + 1}`)).arenaId).toBe(1);
    expect((await fail(h.permits.issue(testWallet(0x200), 1, '198.51.100.99'))).code).toBe('arena_busy');
  });

  it('a moved join nonce, a ticket read and a settled ticket drop the permits they used up, in every arena', async () => {
    const h = harness({ arenas: [arena(1, 1000), arena(2, 1000), arena(3, 1000)] });
    await h.permits.issue(ALICE, 1, '10.0.0.1');
    await h.permits.issue(ALICE, 2, '10.0.0.1');
    expect([(await h.permits.load(1, 0)).held, (await h.permits.load(2, 0)).held]).toEqual([1, 1]);
    // alice bought arena 1's ticket and closed the tab (no seat request): her next request reads the nonce
    h.chain.nonces.set(ALICE.toLowerCase(), 1n);
    await h.permits.issue(ALICE, 3, '10.0.0.1');
    expect(await h.permits.load(1, 1)).toMatchObject({ unseated: 1, held: 0 });
    expect((await h.permits.load(2, 0)).held).toBe(0);
    expect((await h.permits.load(3, 0)).held).toBe(1);
    // a ticket read (opened at its block time) used up every permit signed before it: here bob's of arena 2, not 3
    await h.permits.issue(BOB, 2, '10.0.0.2');
    const boughtAtS = Math.floor(h.clock.now / 1000);
    h.clock.now += 30_000;
    await h.permits.issue(BOB, 3, '10.0.0.2');
    h.permits.ticketSeen(BOB, 1, boughtAtS);
    expect((await h.permits.load(2, 0)).held).toBe(0);
    expect((await h.permits.load(3, 0)).held).toBe(2);
    // a settled (or cancelled) ticket is done with its permit
    h.permits.ticketDone(BOB, 3);
    expect((await h.permits.load(3, 0)).held).toBe(1);
  });

  it('wallet rotation from one IPv6 /64, one /48 or one IPv4 address hits the no-show block', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    const perNet = 3 * NET_NO_SHOW_FACTOR; // NO_SHOW_LIMIT 3
    const perSite = 3 * SITE_NO_SHOW_FACTOR;
    let n = 0;
    // a fresh wallet each time: its permit buys a ticket that goes back unplayed (the stale sweeper's no-show)
    const noShow = async (ip: string) => {
      const w = testWallet(0x4000 + ++n);
      await h.permits.issue(w, 1, ip);
      h.permits.ticketDone(w, 1, true);
      h.clock.now += 60_000;
    };
    const first = h.clock.now;
    for (let i = 0; i < perNet; i++) await noShow(`2001:db8:5:1::${i + 1}`);
    // every wallet is new (one no-show each), but the /64 is not
    const e = await fail(h.permits.issue(testWallet(0x4900), 1, '2001:db8:5:1:ffff::9'));
    expect([e.code, e.status, e.retryAt]).toEqual(['no_show', 403, first + NO_SHOW_WINDOW_MS]);
    expect(e.message).toMatch(/your network/);
    // a settled (played) ticket is not a no-show; another /64 of the /48 is open until the /48 has its own limit
    h.permits.ticketDone(testWallet(0x4000 + 1), 1, false);
    for (let i = perNet; i < perSite; i++) await noShow(`2001:db8:5:${(2 + Math.floor((i - perNet) / 3)).toString(16)}::1`);
    expect((await fail(h.permits.issue(testWallet(0x4901), 1, '2001:db8:5:ff::1'))).code).toBe('no_show');
    expect((await h.permits.issue(testWallet(0x4902), 1, '2001:db8:6:1::1')).arenaId).toBe(1);
    // IPv4: one address
    for (let i = 0; i < perNet; i++) await noShow('203.0.113.9');
    expect((await fail(h.permits.issue(testWallet(0x4903), 1, '203.0.113.9'))).code).toBe('no_show');
    expect((await h.permits.issue(testWallet(0x4904), 1, '203.0.113.10')).arenaId).toBe(1);
    // a day after the first of them, the /64 opens again; NO_SHOW_LIMIT=0 turns it off
    h.clock.now = first + NO_SHOW_WINDOW_MS + 1;
    expect(h.permits.netNoShowUntil('2001:db8:5:1::1')).toBeNull();
    const off = harness({ cfg: { noShowLimit: 0 } });
    for (let i = 0; i < 10; i++) {
      await off.permits.issue(testWallet(0x4a00 + i), 1, '203.0.113.20');
      off.permits.ticketDone(testWallet(0x4a00 + i), 1, true);
      off.clock.now += 60_000;
    }
    expect(off.permits.netNoShowUntil('203.0.113.20')).toBeNull();
  });

  it('the deadline is set on the chain clock: a server clock 60 s ahead never signs past the contract window', async () => {
    const h = harness();
    h.chain.chainClock = () => T0;
    h.clock.now = T0 + 60_000;
    expect((await h.permits.issue(ALICE, 1, '10.0.0.1')).deadline).toBe(Math.floor(T0 / 1000) + 600);
    // the longest TTL is the contract's hour less 5 minutes, also through the env setting
    const long = harness({ cfg: { ttlS: 3600 } });
    long.chain.chainClock = () => T0;
    long.clock.now = T0 + 60_000;
    expect(long.permits.config.ttlS).toBe(JOIN_PERMIT_TTL_MAX_S);
    expect(JOIN_PERMIT_TTL_MAX_S).toBe(JOIN_PERMIT_MAX_WINDOW_S - 300);
    const p = await long.permits.issue(ALICE, 1, '10.0.0.1');
    expect(p.deadline).toBe(Math.floor(T0 / 1000) + 3300);
    expect(loadConfig({ JOIN_PERMIT_TTL_S: '3600' } as unknown as NodeJS.ProcessEnv).joinPermits.ttlS).toBe(3300);
    expect(loadConfig({ JOIN_PERMIT_HOLD_S: '0' } as unknown as NodeJS.ProcessEnv).joinPermits).toMatchObject({ holdS: 0, holdsPerNet: 4, holdsPerSite: 16 });
  });
});

describe('join permits on the chain (EvmChain + the FakeEvm model of CoinnibalArena v4)', () => {
  async function evmChain(env: Record<string, string> = {}, now: () => number = () => T0) {
    const evm = new FakeEvm();
    evm.addArena(1, 1_000n);
    evm.nowS = () => Math.floor(T0 / 1000);
    const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), STALE_SESSION_AFTER_S: '60', ...env } as unknown as NodeJS.ProcessEnv);
    const journal = new Journal(null);
    const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now, receiptTimeoutMs: 10 });
    chain.setLiveSessionProvider(() => new Set());
    await chain.start();
    return { evm, chain, journal };
  }
  const fund = (evm: FakeEvm, w: string) => {
    evm.gas.set(w.toLowerCase(), 10n ** 18n);
    evm.tokens.set(w.toLowerCase(), 100_000n * E18);
    evm.allowances.set(`${w.toLowerCase()}:${ARENA.toLowerCase()}`, (1n << 256n) - 1n);
  };

  it('a permit the server signed buys exactly one ticket for exactly that wallet and arena', async () => {
    const { evm, chain } = await evmChain();
    const alice = getAddress(testSigner().address);
    const bob = getAddress(testSigner().address);
    fund(evm, alice);
    fund(evm, bob);
    const deadline = Math.floor(T0 / 1000) + 600;
    const p = await chain.signJoinPermit(alice, 1, await chain.joinNonce(alice), deadline);
    expect(p).toMatchObject({ arena: ARENA, chainId: evm.chainId, player: alice, arenaId: 1, nonce: '0', deadline });
    expect(await chain.hasOpenTicket(1, alice)).toBe(false);
    const call = joinCall(ARENA, 1, { deadline: BigInt(deadline), signature: p.signature as Hex });
    // bob cannot use alice's permit
    await expect(evm.sendFrom(bob, call)).rejects.toThrow(/InvalidPermit/);
    await evm.sendFrom(alice, call);
    expect(await chain.joinNonce(alice)).toBe(1n);
    expect(await chain.hasOpenTicket(1, alice)).toBe(true);
    // a cancelled ticket cannot be bought again with the same permit
    evm.close(1, alice);
    await expect(evm.sendFrom(alice, call)).rejects.toThrow(/InvalidPermit/);
    // nor can a permit be signed while the server key is not the arena's server authority
    evm.config = { ...evm.config, serverAuthority: getAddress('0x000000000000000000000000000000000000bEEF') };
    await chain.refresh();
    await expect(chain.signJoinPermit(alice, 1, 1n, deadline)).rejects.toThrow(/cannot sign/);
  });

  it('the stale sweeper marks a ticket never seated while its arena was open as a no-show; a closed arena refund is not one', async () => {
    const { evm, chain, journal } = await evmChain();
    const events: SettledEvent[] = [];
    chain.onSettled((e) => events.push(e));
    const late = testSigner().address;
    evm.join(1, late, { openedAt: Math.floor(T0 / 1000) - 3600 });
    expect(await chain.sweepStale()).toBe(1);
    expect(journal.pending[0]).toMatchObject({ reason: 'stale', noShow: true });
    await chain.processPending();
    expect(chain.noShowsSince(late, T0 - 1)).toEqual([T0]);
    // the settled event says so too: the join permits count it against the networks the permit was asked from
    expect(events.at(-1)).toMatchObject({ player: getAddress(late), arenaId: 1, refund: true, noShow: true });
    expect(chain.settledLog.noShowsSince(late, T0 + 1)).toEqual([]);
    // a disabled arena's tickets go back at once: not the player's doing
    const fresh = testSigner().address;
    evm.join(1, fresh, { openedAt: Math.floor(T0 / 1000) });
    evm.arenaMap.get(1)!.enabled = false;
    expect(await chain.sweepStale()).toBe(1);
    expect((journal.pending[0] as { noShow?: true }).noShow).toBeUndefined();
    await chain.processPending();
    expect(chain.noShowsSince(fresh, 0)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ player: getAddress(fresh), refund: true });
    expect(events.at(-1)?.noShow).toBeUndefined();
  });

  it('a permit signed while the server clock runs 60 s ahead of the chain buys a ticket at the longest TTL; the balance read', async () => {
    // the chain's clock (block time) is T0; the server's is a minute ahead
    const local = { now: T0 + 60_000 };
    const { evm, chain } = await evmChain({}, () => local.now);
    await chain.readChainClock();
    expect(chain.clockSkewMs()).toBe(60_000);
    const alice = getAddress(testSigner().address);
    fund(evm, alice);
    expect(await chain.tokenBalance(alice)).toBe(100_000 * 1_000_000);
    expect(await chain.tokenBalance(getAddress(testSigner().address))).toBe(0);
    const permits = new JoinPermits({
      chain,
      gameOpenFor: async () => true,
      blocked: () => [],
      seatedKeys: () => new Set(),
      pendingKeys: () => [],
      seatsPerRound: () => 300,
      noShows: () => [],
      cfg: { ttlS: 3600 },
      now: () => local.now,
    });
    const p = await permits.issue(alice, 1, '10.0.0.1');
    expect(p.deadline).toBe(Math.floor(T0 / 1000) + JOIN_PERMIT_TTL_MAX_S);
    expect((await permits.load(1, 0)).held).toBe(1);
    await evm.sendFrom(alice, joinCall(ARENA, 1, { deadline: BigInt(p.deadline), signature: p.signature as Hex }));
    expect(await chain.hasOpenTicket(1, alice)).toBe(true);
  });
});

describe('the server key signs the arena\'s EIP-712 join permit', () => {
  it('recovers to the server key with the arena domain (name CoinnibalArena, version 4, chain, contract)', async () => {
    const server = privateKeyToAccount(generatePrivateKey());
    const fields = { chainId: 46630, arena: ARENA, player: ALICE, arenaId: 3, nonce: 7n, deadline: 1_790_000_600n };
    const sig = await signJoinPermit(server, fields);
    const typed = joinPermitTypedData(fields);
    expect(typed.domain).toEqual({ name: 'CoinnibalArena', version: '4', chainId: 46630, verifyingContract: ARENA });
    expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(server.address);
    expect(await recoverTypedDataAddress({ ...joinPermitTypedData({ ...fields, player: BOB }), signature: sig })).not.toBe(server.address);
  });
});

describe('POST /api/arena/permit', () => {
  let app: App;
  let port: number;
  const chain = new PermitChain([arena(1, 1000)]);
  beforeAll(async () => {
    const cfg = loadConfig({
      PORT: '0',
      DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-permit-')),
      GAME_ACCESS: 'public',
      NODE_ENV: 'development',
      JOIN_PERMIT_PER_IP: '100',
    } as unknown as NodeJS.ProcessEnv);
    app = await createApp(cfg, {
      chain,
      log: () => {},
      persist: false,
      siteLimits: { writeIp: new Limiter(10_000, 60_000), writeWallet: new Limiter(10_000, 60_000), login: new Limiter(10_000, 60_000) },
      apiLimiter: new Limiter(10_000, 60_000),
    });
    port = await app.listen();
  });
  afterAll(async () => {
    await app.close();
  });
  const post = (body: unknown, token?: string) =>
    fetch(`http://127.0.0.1:${port}/api/arena/permit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it('needs a signed-in wallet and answers the permit, or why not', async () => {
    expect((await post({ arenaId: 1 })).status).toBe(401);
    const token = app.auth.issueToken(ALICE);
    const ok = await post({ arenaId: 1 }, token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { permit: JoinPermit }).permit).toMatchObject({ player: ALICE, arenaId: 1, nonce: '0' });
    chain.open.add(`1:${BOB.toLowerCase()}`);
    const open = await post({ arenaId: 1 }, app.auth.issueToken(BOB));
    expect([open.status, await open.json()]).toEqual([409, { error: 'session_open', message: expect.stringMatching(/resume it/) }]);
    chain.noShowTimes.set(ALICE.toLowerCase(), [Date.now() - 3000, Date.now() - 2000, Date.now() - 1000]);
    chain.nonces.set(ALICE.toLowerCase(), 1n);
    const noShow = await post({ arenaId: 1 }, token);
    const body = (await noShow.json()) as { error: string; retryAt: number };
    expect([noShow.status, body.error]).toEqual([403, 'no_show']);
    expect(body.retryAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect((await fetch(`http://127.0.0.1:${port}/api/arena/permit`)).status).toBe(405);
  });

  /** A signed-in game socket that asks to sit in `room` and answers the server's first error. */
  async function sitDown(wallet: string, room: string): Promise<ServerMessage> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: ServerMessage[] = [];
    const next = (t: ServerMessage['t']) =>
      new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 3000);
        const look = () => {
          const m = msgs.find((x) => x.t === t);
          if (!m) return false;
          clearTimeout(timer);
          resolve(m);
          return true;
        };
        if (!look()) ws.on('message', () => look());
      });
    ws.on('message', (data, binary) => {
      if (!binary) msgs.push(JSON.parse(data.toString()) as ServerMessage);
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      await next('welcome');
      ws.send(JSON.stringify({ t: 'auth', token: app.auth.issueToken(wallet) }));
      await next('authed');
      ws.send(JSON.stringify({ t: 'join', room, name: 'Buyer', skin: 0 }));
      return await next('error');
    } finally {
      ws.close();
    }
  }

  it('the place a permit holds is given up when its wallet asks the game to sit with its ticket', async () => {
    const carol = getAddress(testSigner().address);
    const ok = await post({ arenaId: 1 }, app.auth.issueToken(carol));
    expect(ok.status).toBe(200);
    const held = (await app.permits.load(1, 0)).held;
    expect(held).toBeGreaterThan(0);
    // the web enters the room right after the join (here the chain has no ticket yet: no_session)
    expect((await sitDown(carol, 'arena:1')).t).toBe('error');
    expect((await app.permits.load(1, 0)).held).toBe(held - 1);
  });

  it('a no-show settled on chain counts against the network the permits were asked from', async () => {
    // fresh wallets from this one address (127.0.0.1), each ticket cancelled unseated (the stale sweeper's no-show)
    for (let i = 0; i < 3 * NET_NO_SHOW_FACTOR; i++) {
      const w = getAddress(testSigner().address);
      expect((await post({ arenaId: 1 }, app.auth.issueToken(w))).status).toBe(200);
      for (const fn of chain.settledFns) fn({ key: sessionKey(1, w, 500 + i), player: w, arenaId: 1, txHash: `0x${'1'.repeat(64)}`, payout: 1000, fee: 0, net: 1000, refund: true, noShow: true });
    }
    const res = await post({ arenaId: 1 }, app.auth.issueToken(getAddress(testSigner().address)));
    const body = (await res.json()) as { error: string; message: string; retryAt: number };
    expect([res.status, body.error]).toEqual([403, 'no_show']);
    expect(body.message).toMatch(/your network/);
    expect(body.retryAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
});
