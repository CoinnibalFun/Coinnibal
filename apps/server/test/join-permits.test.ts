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
import { JOIN_PERMIT_MAX_WINDOW_S, PROTOCOL_VERSION, type ChainStatus, type JoinPermit, type ServerMessage } from '@coinnibal/shared';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { EvmChain } from '../src/chain/evm';
import { ChainBusyError, sessionKey, type ChainArena, type ChainSession, type SettledEvent } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { CLIENT_BUSY_MESSAGE, ClientBudgetError } from '../src/net/client-scope';
import { Limiter } from '../src/net/limiter';
import { Journal } from '../src/stake/journal';
import { SettledLog } from '../src/stake/settled-log';
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
  /** The arena contract in use and its chain (an admin can register another one live). */
  arenaAddress: string = ARENA;
  chainId = 31337;
  readonly settledFns: ((e: SettledEvent) => void)[] = [];
  override status(): ChainStatus {
    return { ...super.status(), chainId: this.chainId, arenaAddress: this.arenaAddress };
  }
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
    return { arena: this.arenaAddress, chainId: this.chainId, player: getAddress(player), arenaId, nonce: nonce.toString(), deadline, signature: `0x${(this.signed.length % 10).toString().repeat(130)}` };
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
    /** Each wallet's latest played ticket (Unix ms): standing (the settled log's `settle` records). */
    played: new Map<string, number>(),
    /** The NFT token ids each wallet holds (the holder index). */
    tokens: new Map<string, string[]>(),
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
    playedAt: (w) => h.played.get(w.toLowerCase()) ?? null,
    holderTokens: async (w) => h.tokens.get(w.toLowerCase()) ?? [],
    now: () => clock.now,
    ...o,
  });
  return h;
}

/** `wallets` played a ticket an hour ago (a `settle` in the settled log): they have standing. */
const established = (h: ReturnType<typeof harness>, ...wallets: string[]) => {
  for (const w of wallets) h.played.set(w.toLowerCase(), h.clock.now - 3_600_000);
};

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
    // players with standing: the cap holds for everyone (new wallets also have their share of it, tested below)
    established(h, ...wallets, BOB);
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
    established(fixed, ALICE, BOB);
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
    v6.seats = 100;
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:aaaa::3']) await v6.permits.issue(testSigner().address, 1, ip);
    const e = await fail(v6.permits.issue(testSigner().address, 1, '2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect([e.code, e.status]).toEqual(['rate_limited', 429]);
    expect((await v6.permits.issue(testSigner().address, 1, '2001:db8:1:3::1')).arenaId).toBe(1);
    // every /64 of one IPv6 /48 shares a limit too
    const site = harness({ cfg: { perIp: 100, perSubnet: 100, perSite: 4, perWallet: 10 } });
    site.seats = 100;
    for (let i = 0; i < 4; i++) await site.permits.issue(testSigner().address, 1, `2001:db8:7:${i + 1}::1`);
    expect((await fail(site.permits.issue(testSigner().address, 1, '2001:db8:7:ff::1'))).code).toBe('rate_limited');
    expect((await site.permits.issue(testSigner().address, 1, '2001:db8:8:1::1')).arenaId).toBe(1);
    expect(loadConfig({ JOIN_PERMIT_PER_SITE: '7' } as unknown as NodeJS.ProcessEnv).joinPermits.perSite).toBe(7);
    // one wallet from many addresses
    const w = harness({ cfg: { perIp: 100, perSubnet: 100, perWallet: 2 } });
    established(w, ALICE);
    await w.permits.issue(ALICE, 1, '10.9.0.1');
    await w.permits.issue(ALICE, 1, '10.9.0.2');
    expect((await fail(w.permits.issue(ALICE, 1, '10.9.0.3'))).code).toBe('rate_limited');
  });
});

describe('a permit is free, so it holds a place only briefly and only when backed (audit S16, round 2)', () => {
  /** Wallets that hold no game token (the attacker's), and an IPv6 address in the `n`-th /64 of 2001:db8:0::/48. */
  const v6 = (n: number, host: number) => `2001:db8:0:${n.toString(16)}::${host.toString(16)}`;
  /** The place rule alone: no share per network (tested on its own below) and no request limit per /48. */
  const placesOnly = { openPerIp: 0, openPerNet: 0, openPerSite: 0, perSite: 100_000 };

  it('300 signed-in wallets without the entry fee, from ten IPv6 /64s, never push a funded player to arena_busy', async () => {
    const h = harness({ arenas: [arena(1, 1000)], cfg: placesOnly });
    h.seats = 300; // the default cap: ARENA_INSTANCE_CAP 50 × 6 instances
    h.chain.balances = new Map();
    const attackers = Array.from({ length: 300 }, (_, i) => testWallet(0x1000 + i));
    // a new wallet without the entry fee gets no permit at all (round 4: a free permit must hold no share either)
    for (let i = 0; i < 300; i++) {
      const e = await fail(h.permits.issue(attackers[i], 1, v6(Math.floor(i / 30), (i % 30) + 1)));
      expect([e.code, e.status]).toEqual(['no_funds', 409]);
    }
    expect(h.chain.signed).toHaveLength(0);
    expect(await h.permits.load(1, 0)).toMatchObject({ used: 0, held: 0 });
    const player = testWallet(0xabcdef);
    h.chain.balances.set(player.toLowerCase(), 1000);
    expect((await h.permits.issue(player, 1, '198.51.100.7')).player).toBe(player);
    expect((await h.permits.load(1, 0)).held).toBe(1);
    // nine minutes on the attackers ask again (from ten other /64s): still nothing
    h.clock.now += 9 * 60_000;
    for (let i = 0; i < 300; i++) await fail(h.permits.issue(attackers[i], 1, v6(16 + Math.floor(i / 30), (i % 30) + 1)));
    expect(h.chain.signed).toHaveLength(1);
    expect(await h.permits.load(1, 0)).toMatchObject({ used: 0, held: 0 });
    const next = testWallet(0xabcdee);
    h.chain.balances.set(next.toLowerCase(), 5000);
    expect((await h.permits.issue(next, 1, '198.51.100.8')).player).toBe(next);
    // a player with standing is not asked for the entry fee (it holds a place only when it holds the fee)
    const known = testWallet(0xabcded);
    established(h, known);
    expect((await h.permits.issue(known, 1, '198.51.100.9')).player).toBe(known);
    expect((await h.permits.load(1, 0)).held).toBe(1);
    // a balance that cannot be read is busy, never "no tokens"
    const read = h.chain.tokenBalance.bind(h.chain);
    h.chain.tokenBalance = async () => {
      throw new ChainBusyError('token balance');
    };
    expect((await fail(h.permits.issue(testWallet(0xabcdec), 1, '198.51.100.10'))).code).toBe('chain_busy');
    h.chain.tokenBalance = read;
  });

  it('funded wallets hold at most 4 places per IPv4 address or IPv6 /64 and 16 per /48, and one per wallet, arena and nonce', async () => {
    const h = harness({ arenas: [arena(1, 1000)], cfg: placesOnly });
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
    expect(requesterOf('::ffff:203.0.113.5')).toEqual({ net: '203.0.113.5', site: '203.0.113.0/24' });
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

  it('a holders-only arena: a holder check the server cannot answer right now is busy, never "not a holder"', async () => {
    // the holder reads of one client are bounded (site/mint.ts): past the bound, with no "holder" on record and the
    // holder index unable to catch up, the check throws ClientBudgetError. A holder asking for a permit then hears
    // "busy", not that the room is not theirs
    let spent = true;
    const h = harness({
      arenas: [{ ...arena(4, 5000), holdersOnly: true }],
      isHolder: async () => {
        if (spent) throw new ClientBudgetError('holder check');
        return true;
      },
    });
    const e = await fail(h.permits.issue(ALICE, 4, '10.0.0.1'));
    expect([e.code, e.status, e.message]).toEqual(['chain_busy', 503, CLIENT_BUSY_MESSAGE]);
    expect(h.chain.signed).toHaveLength(0);
    spent = false;
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
      // their tickets were played and settled: the settled log gives them standing
      for (const w of players) h.played.set(w.toLowerCase(), h.clock.now);
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
    // 200 players in the break (each on its own /24, each with standing: the new wallets' share is tested below): each
    // gets a permit and buys at once, and none of their pages enters the room
    for (let i = 0; i < 200; i++) {
      const w = testWallet(0x5000 + i);
      established(h, w);
      await h.permits.issue(w, 1, `10.${1 + (i >> 8)}.${i & 255}.1`);
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
    established(idle, ALICE, BOB);
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
    // players with standing (new wallets hold at most half of the 10: below)
    for (let i = 0; i < 11; i++) established(h, testWallet(0x100 + i));
    established(h, testWallet(0x200));
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

describe('each network has a share of an arena\'s permits not played yet (audit S16, round 3)', () => {
  /** The join of `w`'s permit mines: its nonce moves and its ticket is open (unseated) on chain. */
  const buy = (h: ReturnType<typeof harness>, w: string, arenaId = 1) => {
    const lower = w.toLowerCase();
    h.chain.nonces.set(lower, (h.chain.nonces.get(lower) ?? 0n) + 1n);
    h.chain.open.add(`${arenaId}:${lower}`);
    h.chain.arenas.find((a) => a.id === arenaId)!.openSessions++;
  };
  /** The stale sweeper cancels `w`'s unplayed ticket (a no-show). */
  const swept = (h: ReturnType<typeof harness>, w: string, arenaId = 1) => {
    h.chain.open.delete(`${arenaId}:${w.toLowerCase()}`);
    h.chain.arenas.find((a) => a.id === arenaId)!.openSessions--;
    h.permits.ticketDone(w, arenaId, true);
  };

  it('300 funded throwaway wallets from one IPv6 /48 get 16 permits, not 300: the arena never fills (the reviewer\'s burst)', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300; // the default cap, and the arena's maxSessions
    const a = h.chain.arenas[0];
    let n = 0;
    /**
     * One pass: 300 fresh funded wallets over five minutes, from the ten /64s of 2001:db8:77::/48 (three addresses each),
     * the `from`-th /64 first.
     */
    const pass = async (from = 0) => {
      const got: string[] = [];
      const refused: Record<string, number> = {};
      for (let i = 0; i < 300; i++) {
        const ip = `2001:db8:77:${((Math.floor(i / 30) + from) % 10).toString(16)}::${Math.floor((i % 30) / 12) + 1}`;
        const w = testWallet(0x7000 + n++);
        try {
          await h.permits.issue(w, 1, ip);
          got.push(w);
        } catch (err) {
          const code = (err as JoinPermitFail).code;
          refused[code] = (refused[code] ?? 0) + 1;
        }
        h.clock.now += 1000;
      }
      return { got, refused };
    };
    // the /48's 60 requests per 10 minutes reach two /64s: 4 permits each, the rest wait for their network
    const first = await pass();
    expect(first.got).toHaveLength(8);
    expect(first.refused).toEqual({ network_busy: 52, rate_limited: 240 });
    // all of them join at once, and never play
    for (const w of first.got) buy(h, w);
    // ten minutes on (the permits expired, the request windows are new): the tickets still wait unplayed, so those two
    // /64s get nothing (asking again with a used wallet frees nothing either) ...
    h.clock.now += 6 * 60_000;
    expect((await fail(h.permits.issue(first.got[0], 1, '2001:db8:77:0::1'))).code).toBe('session_open');
    const again = await pass();
    expect(again.got).toHaveLength(0);
    // (the /48's 60 requests: 57 meet the full /64s, 2 more the address and /64 limits, the used wallet's 1)
    expect(again.refused).toEqual({ network_busy: 57, rate_limited: 243 });
    // ... and two other /64s fill the /48's share of 16
    h.clock.now += 6 * 60_000;
    const second = await pass(2);
    expect(second.got).toHaveLength(8);
    for (const w of second.got) buy(h, w);
    expect(a.openSessions).toBe(16);
    h.clock.now += 11 * 60_000;
    const third = await pass(4);
    expect(third).toEqual({ got: [], refused: { network_busy: 60, rate_limited: 240 } });
    // a real player elsewhere is never refused: the arena holds 16 unplayed tickets of its 300
    const player = testWallet(0xabcdef);
    expect((await h.permits.issue(player, 1, '198.51.100.7')).player).toBe(player);
    // the stale sweeper cancels the 16 (no-shows): the /48's share is free again, and its no-shows count
    for (const w of [...first.got, ...second.got]) swept(h, w);
    h.clock.now += 11 * 60_000;
    expect((await h.permits.issue(testWallet(0x7fff0), 1, '2001:db8:77:0::1')).arenaId).toBe(1);
  });

  it('a burst of concurrent requests from one network passes its share only once', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    const burst = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => h.permits.issue(testWallet(0x7100 + i), 1, '203.0.113.77')));
    expect(burst.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
    const codes = burst.flatMap((r) => (r.status === 'rejected' ? [(r.reason as JoinPermitFail).code] : []));
    expect(codes).toEqual(['network_busy', 'network_busy', 'network_busy', 'network_busy']);
    // a /48: 16, whatever /64s the burst comes from
    const site = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => h.permits.issue(testWallet(0x7200 + i), 1, `2001:db8:78:${(i % 10).toString(16)}::1`)));
    expect(site.filter((r) => r.status === 'fulfilled')).toHaveLength(16);
  });

  it('one IPv4 address (carrier NAT: many players) has 8 per arena; a seated or settled permit makes room, an unused one keeps its place a day', async () => {
    // a carrier NAT address: its request limit set high (JOIN_PERMIT_PER_IP)
    const h = harness({ arenas: [arena(1, 1000), arena(3, 1000)], cfg: { perIp: 1000 } });
    h.seats = 300;
    const ip = '198.51.100.20';
    const ws = Array.from({ length: 10 }, (_, i) => testWallet(0x7300 + i));
    for (let i = 0; i < 8; i++) await h.permits.issue(ws[i], 1, ip);
    const e = await fail(h.permits.issue(ws[8], 1, ip));
    expect([e.code, e.status]).toEqual(['network_busy', 409]);
    expect(e.message).toMatch(/your network/);
    // another arena has its own share; a kept permit asked for again is no new one
    expect((await h.permits.issue(ws[8], 3, ip)).arenaId).toBe(3);
    expect((await h.permits.issue(ws[0], 1, ip)).nonce).toBe('0');
    // ws[0] buys and is seated (played): it leaves the share
    buy(h, ws[0]);
    h.seated.add(sessionKey(1, ws[0], 1));
    expect((await h.permits.issue(ws[8], 1, ip)).player).toBe(ws[8]);
    // ws[1] buys and never plays: asking to sit (with the round closed) frees nothing
    buy(h, ws[1]);
    h.permits.ticketSeen(ws[1], 1, null);
    expect((await fail(h.permits.issue(ws[9], 1, ip))).code).toBe('network_busy');
    // ten minutes on, the unused permits expired: read once at the share (the join nonce first), each of them bought
    // nothing. Round 4: such a dud keeps its place in its networks' share for a day, so free permits asked again and
    // again (new wallets each time) hold one network's share only, not the arena's
    let nonceReads = 0;
    let ticketReads = 0;
    const nonceOf = h.chain.joinNonce.bind(h.chain);
    const has = h.chain.hasOpenTicket.bind(h.chain);
    h.chain.joinNonce = async (w: string) => {
      nonceReads++;
      return nonceOf(w);
    };
    h.chain.hasOpenTicket = async (id: number, w: string) => {
      ticketReads++;
      return has(id, w);
    };
    h.clock.now += 11 * 60_000;
    expect((await fail(h.permits.issue(ws[9], 1, ip))).code).toBe('network_busy');
    // ws[9]'s own ticket and nonce; then the nonce of ws[1]..ws[8], and the ticket of ws[1] only (its nonce moved)
    expect([nonceReads, ticketReads]).toEqual([1 + 8, 1 + 1]);
    // read once per 10 s: asking again reads none of them
    await fail(h.permits.issue(ws[9], 1, ip));
    expect([nonceReads, ticketReads]).toEqual([2 + 8, 2 + 1]);
    // ws[1]'s ticket stays in the share until the stale sweeper settles it; then one place is free
    swept(h, ws[1]);
    expect((await h.permits.issue(ws[9], 1, ip)).player).toBe(ws[9]);
    expect((await fail(h.permits.issue(testWallet(0x7406), 1, ip))).code).toBe('network_busy');
    // a day after they were asked, those duds are gone; ws[9]'s permit expired unused meanwhile: it is the one left
    h.clock.now += 24 * 3_600_000;
    for (let i = 0; i < 7; i++) expect((await h.permits.issue(testWallet(0x7400 + i), 1, ip)).arenaId).toBe(1);
    expect((await fail(h.permits.issue(testWallet(0x7407), 1, ip))).code).toBe('network_busy');
    // a player with standing on that address is never refused for its share
    const regular = testWallet(0x7499);
    established(h, regular);
    expect((await h.permits.issue(regular, 1, ip)).player).toBe(regular);
    // a /64 has 4; the shares can be set (0: no limit)
    const v6 = harness({ arenas: [arena(1, 1000)] });
    v6.seats = 300;
    for (let i = 0; i < 4; i++) await v6.permits.issue(testWallet(0x7500 + i), 1, `2001:db8:79:1::${i + 1}`);
    expect((await fail(v6.permits.issue(testWallet(0x7504), 1, '2001:db8:79:1::99'))).code).toBe('network_busy');
    expect((await v6.permits.issue(testWallet(0x7505), 1, '2001:db8:79:2::1')).arenaId).toBe(1);
    const env = loadConfig({ JOIN_PERMIT_OPEN_PER_IP: '20', JOIN_PERMIT_OPEN_PER_SUBNET: '0', JOIN_PERMIT_OPEN_PER_SITE: '5' } as unknown as NodeJS.ProcessEnv).joinPermits;
    expect([env.openPerIp, env.openPerNet, env.openPerSite]).toEqual([20, 0, 5]);
    expect(loadConfig({} as unknown as NodeJS.ProcessEnv).joinPermits).toMatchObject({ openPerIp: 8, openPerNet: 4, openPerSite: 16, perSite: 60 });
  });
});

describe('standing: the network rules never refuse a player with standing (audit R3-M1, round 4)', () => {
  const hour = 3_600_000;
  /** `w` buys a ticket with a permit asked from `ip` and never sits: the stale sweeper's no-show (its own one too). */
  const noShow = async (h: ReturnType<typeof harness>, w: string, arenaId: number, ip: string) => {
    const p = await h.permits.issue(w, arenaId, ip);
    h.chain.nonces.set(w.toLowerCase(), BigInt(p.nonce) + 1n);
    h.clock.now += 20 * 60_000;
    h.permits.ticketDone(w, arenaId, true);
    h.chain.noShowTimes.set(w.toLowerCase(), [...(h.chain.noShowTimes.get(w.toLowerCase()) ?? []), h.clock.now]);
  };

  it('the reviewer\'s case: 9 no-shows from one carrier NAT address, or 24 from one mobile /48, refuse its new wallets, never a player with standing', async () => {
    const h = harness({ arenas: [arena(1, 1000), arena(2, 1000), arena(3, 1000)], cfg: { perIp: 1000 } });
    h.seats = 300;
    // a long-time player behind the carrier NAT: a played ticket three days ago, no no-show of its own
    const regular = testWallet(0xbeef01);
    h.played.set(regular.toLowerCase(), T0 - 72 * hour);
    expect(await h.permits.standing(regular)).toBe('played');
    // 3 throwaway wallets × 3 arenas from the same address, never played
    for (let w = 0; w < 3; w++) for (const a of [1, 2, 3]) await noShow(h, testWallet(0x7000 + w), a, '100.64.12.34');
    const fresh = await fail(h.permits.issue(testWallet(0xbeef02), 1, '100.64.12.34'));
    expect([fresh.code, fresh.message]).toEqual(['no_show', expect.stringMatching(/your network/)]);
    expect((await h.permits.issue(regular, 1, '100.64.12.34')).player).toBe(regular);
    // a mobile carrier's /48 (a /64 per device): 8 wallets × 3 arenas; a player with standing in another /64 of it
    const phone = testWallet(0xbeef03);
    h.played.set(phone.toLowerCase(), T0 - 10 * 24 * hour);
    for (let w = 0; w < 8; w++) for (const a of [1, 2, 3]) await noShow(h, testWallet(0x7100 + w), a, `2a00:1450:4001:${(w + 1).toString(16)}::1`);
    expect((await fail(h.permits.issue(testWallet(0xbeef04), 1, '2a00:1450:4001:ff00::77'))).code).toBe('no_show');
    expect((await h.permits.issue(phone, 1, '2a00:1450:4001:ff00::77')).player).toBe(phone);
    // it loses its standing at its first no-show: then its network's block applies to it too
    h.chain.noShowTimes.set(phone.toLowerCase(), [h.clock.now - 60_000]);
    expect(await h.permits.standing(phone)).toBeNull();
    expect((await fail(h.permits.issue(phone, 2, '2a00:1450:4001:ff00::77'))).code).toBe('no_show');
  });

  it('a network at its share, or past its request limits, still serves a player with standing; its new wallets wait', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    const ip = '100.64.20.1';
    // 8 free permits (funded throwaway wallets) fill the address's share; 12 requests its request limit
    for (let i = 0; i < 8; i++) await h.permits.issue(testWallet(0x7200 + i), 1, ip);
    for (let i = 0; i < 4; i++) await fail(h.permits.issue(testWallet(0x7210 + i), 1, ip));
    const limited = await fail(h.permits.issue(testWallet(0x7220), 1, ip));
    expect(limited.code).toBe('rate_limited');
    const regular = testWallet(0xbeef05);
    established(h, regular);
    expect((await h.permits.issue(regular, 1, ip)).player).toBe(regular);
    // its permit is in no network's share: asked again it is the same one, and the new wallets' count is unchanged
    expect((await h.permits.issue(regular, 1, ip)).nonce).toBe('0');
    // the per-wallet limit still holds for it (20 per 10 minutes)
    for (let i = 0; i < 18; i++) await h.permits.issue(regular, 1, ip);
    expect((await fail(h.permits.issue(regular, 1, ip))).code).toBe('rate_limited');
  });

  it('standing: the latest ticket of 14 days was played and none was a no-show since, or an NFT that gives no other wallet standing', async () => {
    const h = harness();
    const w = testWallet(0xbeef10);
    expect(await h.permits.standing(w)).toBeNull();
    // a played ticket 15 days ago is too old
    h.played.set(w.toLowerCase(), T0 - 15 * 24 * hour);
    expect(await h.permits.standing(w)).toBeNull();
    // played 2 days ago, after a no-show 3 days ago: standing
    h.played.set(w.toLowerCase(), T0 - 48 * hour);
    h.chain.noShowTimes.set(w.toLowerCase(), [T0 - 72 * hour]);
    expect(await h.permits.standing(w)).toBe('played');
    // a no-show after that played ticket: none, until it plays again
    h.chain.noShowTimes.set(w.toLowerCase(), [T0 - 30 * hour]);
    expect(await h.permits.standing(w)).toBeNull();
    h.played.set(w.toLowerCase(), T0 - 26 * hour);
    expect(await h.permits.standing(w)).toBe('played');
    // never with a no-show of its own in the last 24 h, whatever it played since
    h.chain.noShowTimes.set(w.toLowerCase(), [T0 - 2 * hour]);
    h.played.set(w.toLowerCase(), T0 - hour);
    expect(await h.permits.standing(w)).toBeNull();
    // an NFT holder: one wallet per token id a day (an NFT passed around gives standing to one wallet of them)
    const a = testWallet(0xbeef11);
    const b = testWallet(0xbeef12);
    h.tokens.set(a.toLowerCase(), ['7']);
    expect(await h.permits.standing(a)).toBe('holder');
    h.tokens.delete(a.toLowerCase());
    h.tokens.set(b.toLowerCase(), ['7']);
    expect(await h.permits.standing(b)).toBeNull();
    h.clock.now += 24 * hour + 1;
    expect(await h.permits.standing(b)).toBe('holder');
    // a holder index that cannot tell (null) gives no standing; a holder with a no-show today has none either
    const c = testWallet(0xbeef13);
    h.tokens.set(c.toLowerCase(), ['8']);
    h.chain.noShowTimes.set(c.toLowerCase(), [h.clock.now - hour]);
    expect(await h.permits.standing(c)).toBeNull();
    const unknown = harness({ holderTokens: async () => null });
    expect(await unknown.permits.standing(c)).toBeNull();
  });

  it('standing covers one unplayed ticket at a time: one played ticket cannot hold every arena past the network rules', async () => {
    const h = harness({ arenas: [arena(1, 1000), arena(2, 1000), arena(3, 1000)], cfg: { perIp: 1000 } });
    h.seats = 300;
    for (let w = 0; w < 3; w++) for (const a of [1, 2, 3]) await noShow(h, testWallet(0x7300 + w), a, '100.64.30.1');
    const regular = testWallet(0xbeef20);
    established(h, regular);
    const p = await h.permits.issue(regular, 1, '100.64.30.1');
    // arena 1's permit is not used yet: with arena 2's (the same join nonce) the two buy one ticket between them
    expect((await h.permits.issue(regular, 2, '100.64.30.1')).nonce).toBe(p.nonce);
    // it bought arena 1's ticket and has not played it: arena 2 follows the network's rules, and the refusal says why
    h.chain.nonces.set(regular.toLowerCase(), BigInt(p.nonce) + 1n);
    h.chain.open.add(`1:${regular.toLowerCase()}`);
    const e = await fail(h.permits.issue(regular, 2, '100.64.30.1'));
    expect([e.code, e.retryAt]).toEqual(['ticket_elsewhere', undefined]);
    expect(e.message).toMatch(/another room that is not played yet/);
    // it sits in arena 1 (played): arena 2 is open to it again
    h.seated.add(sessionKey(1, regular, 1));
    expect((await h.permits.issue(regular, 2, '100.64.30.1')).arenaId).toBe(2);
  });

  it("the reviewer's switch (audit R4-M2 a): an arena-1 permit declined at the wallet, then arena 2: a permit at once, never a day's block", async () => {
    const h = harness({ arenas: [arena(1, 1000), arena(2, 1000), arena(3, 1000)], cfg: { perIp: 1000 } });
    h.seats = 300;
    // the R3-M1 griefer: 9 no-shows from 3 throwaway wallets on the carrier NAT address
    for (let w = 0; w < 3; w++) for (const a of [1, 2, 3]) await noShow(h, testWallet(0x7400 + w), a, '100.64.12.34');
    const player = testWallet(0xbeef30);
    h.played.set(player.toLowerCase(), h.clock.now - 2 * hour);
    expect((await h.permits.issue(player, 1, '100.64.12.34')).arenaId).toBe(1);
    // declined the wallet prompt; 30 s later it picks arena 2, and again 9 minutes later (arena 1's permit still valid)
    h.clock.now += 30_000;
    expect((await h.permits.issue(player, 2, '100.64.12.34')).arenaId).toBe(2);
    h.clock.now += 9 * 60_000;
    expect((await h.permits.issue(player, 3, '100.64.12.34')).arenaId).toBe(3);
    // every one of them names the same nonce: one ticket at most
    expect(new Set(h.chain.signed.filter((x) => x.player === player).map((x) => x.nonce))).toEqual(new Set([0n]));
  });

  it("the reviewer's stale record (audit R4-M2 b): an abandoned arena-1 permit never takes standing away after an arena-2 ticket was played", async () => {
    for (const seen of [true, false]) {
      const h = harness({ arenas: [arena(1, 1000), arena(2, 1000), arena(3, 1000)], cfg: { perIp: 1000 } });
      h.seats = 300;
      const ip = '100.64.12.34';
      const player = testWallet(seen ? 0xbeef40 : 0xbeef41);
      h.played.set(player.toLowerCase(), h.clock.now - hour);
      // it opens arena 1's ticket sheet and declines the wallet; a minute later it buys arena 2's ticket instead
      await h.permits.issue(player, 1, ip);
      h.clock.now += 60_000;
      const p2 = await h.permits.issue(player, 2, ip);
      h.chain.nonces.set(player.toLowerCase(), BigInt(p2.nonce) + 1n);
      h.chain.open.add(`2:${player.toLowerCase()}`);
      const openedAtS = Math.floor(h.clock.now / 1000);
      // it sits 11 minutes later: the arena-1 permit expired, and someone's request pruned it from the kept permits
      h.clock.now += 11 * 60_000;
      await h.permits.issue(testWallet(0xbbb000), 3, '192.0.2.9');
      h.permits.ticketSeen(player, 2, null);
      // `seen`: the gateway read its ticket and seated it; else the server never heard of the ticket (another tab)
      if (seen) h.permits.ticketSeen(player, 2, openedAtS);
      h.seated.add(sessionKey(2, player, 1));
      h.clock.now += 5 * 60_000;
      h.seated.clear();
      h.chain.open.delete(`2:${player.toLowerCase()}`);
      h.permits.ticketDone(player, 2, false);
      h.played.set(player.toLowerCase(), h.clock.now);
      // the griefer's 9 no-shows on the same address
      for (let w = 0; w < 3; w++) for (const a of [1, 2, 3]) await noShow(h, testWallet((seen ? 0xccc010 : 0xccc020) + w), a, ip);
      h.clock.now += hour;
      expect(await h.permits.standing(player)).toBe('played');
      // the address is blocked for new wallets; this player's own record is clean, so it gets its permit
      expect((await fail(h.permits.issue(testWallet(0xddd000), 3, ip))).code).toBe('no_show');
      expect((await h.permits.issue(player, 3, ip)).arenaId).toBe(3);
    }
  });

  it('a ticket bought with standing and never seen by the gateway still counts once, read on chain; a busy chain answers busy', async () => {
    const h = harness({ arenas: [arena(1, 1000), arena(2, 1000)], cfg: { perIp: 1000 } });
    h.seats = 300;
    for (let w = 0; w < 3; w++) for (const a of [1, 2]) await noShow(h, testWallet(0x7600 + w), a, '100.64.40.1');
    for (let w = 0; w < 3; w++) await noShow(h, testWallet(0x7610 + w), 1, '100.64.40.1');
    const player = testWallet(0xbeef50);
    established(h, player);
    const p1 = await h.permits.issue(player, 1, '100.64.40.1');
    h.chain.nonces.set(player.toLowerCase(), BigInt(p1.nonce) + 1n);
    h.chain.open.add(`1:${player.toLowerCase()}`);
    // the chain cannot be read: busy, never the network's block
    h.chain.busy = true;
    expect((await fail(h.permits.issue(player, 2, '100.64.40.1'))).code).toBe('chain_busy');
    h.chain.busy = false;
    expect((await fail(h.permits.issue(player, 2, '100.64.40.1'))).code).toBe('ticket_elsewhere');
    // the arena-1 ticket goes back (settled): its record leaves, arena 2 is exempt again
    h.chain.open.delete(`1:${player.toLowerCase()}`);
    h.permits.ticketDone(player, 1, false);
    expect((await h.permits.issue(player, 2, '100.64.40.1')).arenaId).toBe(2);
  });
});

describe('an IPv4 /24 is one site, and new wallets hold at most their share of an arena (audit R3-M2, round 4)', () => {
  it('the reviewer\'s burst: 38 addresses of one IPv4 /24 get 16 permits, not 304; the arena stays open', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    let got = 0;
    const refused: Record<string, number> = {};
    for (let i = 0; i < 304; i++) {
      try {
        await h.permits.issue(testWallet(0x5000 + i), 1, `203.0.113.${1 + Math.floor(i / 8)}`);
        got++;
      } catch (err) {
        const c = (err as JoinPermitFail).code;
        refused[c] = (refused[c] ?? 0) + 1;
      }
      h.clock.now += 500;
    }
    expect(got).toBe(16);
    expect(refused.network_busy).toBeGreaterThan(0);
    expect(refused.rate_limited).toBeGreaterThan(0);
    expect((await h.permits.issue(testWallet(0xabcdef), 1, '198.51.100.7')).arenaId).toBe(1);
    // its no-shows count as a site: 8× NO_SHOW_LIMIT from any addresses of the /24
    const n = harness({ arenas: [arena(1, 1000)], cfg: { perIp: 1000, perSite: 1000 } });
    n.seats = 300;
    for (let i = 0; i < 3 * SITE_NO_SHOW_FACTOR; i++) {
      const w = testWallet(0x5800 + i);
      await n.permits.issue(w, 1, `198.18.7.${1 + Math.floor(i / 2)}`);
      n.permits.ticketDone(w, 1, true);
      n.clock.now += 60_000;
    }
    expect((await fail(n.permits.issue(testWallet(0x58ff), 1, '198.18.7.200'))).code).toBe('no_show');
    expect((await n.permits.issue(testWallet(0x58fe), 1, '198.18.8.1')).arenaId).toBe(1);
  });

  it('300 new wallets from 300 /24s get half of the arena; a player with standing is still served; a seat makes room', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 300;
    const got: string[] = [];
    let busy = 0;
    for (let i = 0; i < 300; i++) {
      const w = testWallet(0x6000 + i);
      try {
        await h.permits.issue(w, 1, `10.${i >> 8}.${i & 255}.1`);
        got.push(w);
      } catch (err) {
        expect((err as JoinPermitFail).code).toBe('arena_busy');
        expect((err as JoinPermitFail).message).toMatch(/new players/);
        busy++;
      }
    }
    expect([got.length, busy]).toEqual([150, 150]);
    // they all buy (unseated): the arena holds 150 unplayed tickets of its 300, the rest is open to players with standing
    for (const w of got) {
      h.chain.nonces.set(w.toLowerCase(), 1n);
      h.chain.open.add(`1:${w.toLowerCase()}`);
    }
    h.chain.arenas[0].openSessions = 150;
    const regular = testWallet(0xbeef30);
    established(h, regular);
    expect((await h.permits.issue(regular, 1, '198.51.100.30')).player).toBe(regular);
    expect((await fail(h.permits.issue(testWallet(0x6fff), 1, '198.51.100.31'))).code).toBe('arena_busy');
    // one of them is seated (played): one new wallet more
    h.seated.add(sessionKey(1, got[0], 1));
    expect((await h.permits.issue(testWallet(0x6fff), 1, '198.51.100.31')).arenaId).toBe(1);
    expect((await fail(h.permits.issue(testWallet(0x6ffe), 1, '198.51.100.32'))).code).toBe('arena_busy');
    // the share of min(cap, maxSessions): an arena of 40 sessions takes 20 new wallets; 0 turns it off
    const small = harness({ arenas: [{ ...arena(1, 1000), maxSessions: 40 }] });
    small.seats = 300;
    for (let i = 0; i < 20; i++) await small.permits.issue(testWallet(0x6100 + i), 1, `10.50.${i}.1`);
    expect((await fail(small.permits.issue(testWallet(0x6120), 1, '10.50.99.1'))).code).toBe('arena_busy');
    const off = harness({ arenas: [arena(1, 1000)], cfg: { freshShare: 0 } });
    off.seats = 4;
    for (let i = 0; i < 4; i++) await off.permits.issue(testWallet(0x6200 + i), 1, `10.60.${i}.1`);
    expect((await fail(off.permits.issue(testWallet(0x6204), 1, '10.60.9.1'))).message).toMatch(/as a round can take/);
    expect(loadConfig({} as unknown as NodeJS.ProcessEnv).joinPermits.freshShare).toBe(0.5);
    expect(loadConfig({ JOIN_PERMIT_FRESH_SHARE: '0.25' } as unknown as NodeJS.ProcessEnv).joinPermits.freshShare).toBe(0.25);
    expect(loadConfig({ JOIN_PERMIT_FRESH_SHARE: '7' } as unknown as NodeJS.ProcessEnv).joinPermits.freshShare).toBe(1);
    expect(loadConfig({ JOIN_PERMIT_FRESH_SHARE: '0' } as unknown as NodeJS.ProcessEnv).joinPermits.freshShare).toBe(0);
  });

  it('a burst of concurrent new wallets from many networks passes the share only once', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 40;
    const burst = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => h.permits.issue(testWallet(0x6300 + i), 1, `10.70.${i}.1`)));
    expect(burst.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
  });

  it('free permits asked again and again cannot hold the new wallets\' share: unused, they leave it once expired, and keep their networks\' share a day', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 40; // a share of 20
    // the attacker: 20 funded throwaway wallets on one /24 (16) and another /24 (4), permits never used
    const ask = (i: number, n = 0) => h.permits.issue(testWallet(0x6400 + i + n), 1, i < 16 ? `198.18.1.${1 + (i >> 3)}` : `198.18.2.${1 + (i >> 3)}`);
    for (let i = 0; i < 20; i++) await ask(i);
    expect((await fail(h.permits.issue(testWallet(0x64ff), 1, '10.80.0.1'))).code).toBe('arena_busy');
    // ten minutes on they expired unused: the next new player's request reads them (duds) and gets in
    h.clock.now += 11 * 60_000;
    expect((await h.permits.issue(testWallet(0x64ff), 1, '10.80.0.1')).arenaId).toBe(1);
    // the attacker's first /24 asked 16 that bought nothing: its share is held for a day, new wallets or not
    expect((await fail(h.permits.issue(testWallet(0x6500), 1, '198.18.1.77'))).code).toBe('network_busy');
    h.clock.now += 23 * 3_600_000;
    expect((await fail(h.permits.issue(testWallet(0x6501), 1, '198.18.1.77'))).code).toBe('network_busy');
    h.clock.now += 3_600_000;
    expect((await h.permits.issue(testWallet(0x6502), 1, '198.18.1.77')).arenaId).toBe(1);
    // asking again with the same wallet once its permit expired is a dud too (its nonce never moved)
    const w = testWallet(0x6600);
    await h.permits.issue(w, 1, '198.18.3.1');
    h.clock.now += 11 * 60_000;
    await h.permits.issue(w, 1, '198.18.3.1');
    h.clock.now += 11 * 60_000;
    await h.permits.issue(w, 1, '198.18.3.1');
    for (let i = 0; i < 5; i++) await h.permits.issue(testWallet(0x6610 + i), 1, '198.18.3.1');
    // 2 duds, its live permit and 5 more: the address's 8
    expect((await fail(h.permits.issue(testWallet(0x6620), 1, '198.18.3.1'))).code).toBe('network_busy');
  });
});

describe('a new arena contract registered live (audit S16, round 3)', () => {
  it('is never handed a permit of the old contract: the permits, places and shares start afresh', async () => {
    const h = harness({ arenas: [arena(1, 1000)], cfg: { openPerIp: 2 } });
    h.seats = 300;
    const old = await h.permits.issue(ALICE, 1, '10.0.0.1');
    await h.permits.issue(BOB, 1, '10.0.0.1');
    expect(old.arena).toBe(ARENA);
    expect((await h.permits.load(1, 0)).held).toBe(2);
    expect((await fail(h.permits.issue(testWallet(0x7600), 1, '10.0.0.1'))).code).toBe('network_busy');
    // POST /api/admin/contracts: a new arena, its join nonces at 0 again (the old permit's nonce matches)
    const NEXT = getAddress('0x00000000000000000000000000000000000a4e42');
    h.chain.arenaAddress = NEXT;
    h.clock.now += 60_000;
    const fresh = await h.permits.issue(ALICE, 1, '10.0.0.1');
    expect(fresh).toMatchObject({ arena: NEXT, nonce: '0', player: ALICE });
    expect(fresh.signature).not.toBe(old.signature);
    // the old contract's places and share are gone: only the new permit holds one, and the network has room again
    expect((await h.permits.load(1, 0)).held).toBe(1);
    expect((await h.permits.issue(testWallet(0x7600), 1, '10.0.0.1')).arena).toBe(NEXT);
    // the same permit again on the same contract; a new chain (same address) is another contract
    expect(await h.permits.issue(ALICE, 1, '10.0.0.1')).toEqual(fresh);
    h.chain.chainId = 46630;
    expect((await h.permits.issue(ALICE, 1, '10.0.0.1')).chainId).toBe(46630);
    expect(h.chain.signed).toHaveLength(5);
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

  it('a seat the server refused for its own reason is not a no-show; a refusal before the ticket was bought, or in another arena, is no excuse', async () => {
    const clock = { s: Math.floor(T0 / 1000) };
    const { evm, chain, journal } = await evmChain({}, () => clock.s * 1000);
    evm.nowS = () => clock.s;
    evm.addArena(2, 1_000n);
    const refused = testSigner().address; // asked to sit while the server was overloaded (or the RPC down, the disk full)
    const early = testSigner().address; // its refusal came before it bought the ticket
    const never = testSigner().address; // never asked to sit
    chain.excuseNoShow(1, early);
    clock.s += 120;
    for (const w of [refused, early, never]) evm.join(1, w, { openedAt: clock.s });
    clock.s += 30;
    chain.excuseNoShow(1, refused);
    chain.excuseNoShow(2, never);
    clock.s += 3600;
    await chain.readChainClock();
    expect(await chain.sweepStale()).toBe(3);
    const flags = Object.fromEntries(journal.pending.map((p) => [(p as { player: string }).player.toLowerCase(), (p as { noShow?: true }).noShow === true]));
    expect(flags).toEqual({ [refused.toLowerCase()]: false, [early.toLowerCase()]: true, [never.toLowerCase()]: true });
    await chain.processPending();
    expect(chain.noShowsSince(refused, 0)).toEqual([]);
    expect(chain.noShowsSince(never, 0)).toHaveLength(1);
  });

  it('a played ticket (a settle, never a cancel) is the wallet\'s standing for 14 days, kept across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-played-'));
    const file = join(dir, 'settled.jsonl');
    const clock = { now: T0 };
    const log = new SettledLog(file, () => {}, () => clock.now);
    const base = { contract: ARENA.toLowerCase(), arenaId: 1, tx: `0x${'2'.repeat(64)}`, amount: 1000 };
    log.record({ ...base, kind: 'cancel', key: sessionKey(1, ALICE, 1), player: ALICE, sessionId: 1, noShow: true, at: T0 - 5000 });
    log.record({ ...base, kind: 'cancel', key: sessionKey(1, BOB, 1), player: BOB, sessionId: 1, at: T0 - 4000 });
    expect([log.lastPlayedAt(ALICE), log.lastPlayedAt(BOB)]).toEqual([null, null]);
    log.record({ ...base, kind: 'settle', key: sessionKey(1, ALICE, 2), player: ALICE, sessionId: 2, at: T0 - 3000 });
    log.record({ ...base, kind: 'settle', key: sessionKey(1, ALICE, 0), player: ALICE, sessionId: 0, at: T0 - 9000 });
    expect(log.lastPlayedAt(ALICE.toLowerCase())).toBe(T0 - 3000);
    const again = new SettledLog(file, () => {}, () => clock.now);
    expect([again.lastPlayedAt(ALICE), again.lastPlayedAt(BOB)]).toEqual([T0 - 3000, null]);
    clock.now = T0 - 3000 + 14 * 24 * 3_600_000 + 1;
    expect(again.lastPlayedAt(ALICE)).toBeNull();
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
