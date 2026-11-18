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
import type { JoinPermit } from '@coinnibal/shared';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { EvmChain } from '../src/chain/evm';
import { ChainBusyError, sessionKey, type ChainArena, type ChainSession } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { Journal } from '../src/stake/journal';
import { JoinPermitFail, JoinPermits, NO_SHOW_WINDOW_MS, type JoinPermitDeps } from '../src/stake/join-permits';
import { ARENA, E18, FakeEvm } from './fake-evm';
import { ArenaChain, arena } from './helpers';
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
  const h = {
    chain,
    clock,
    gameOpen: true,
    banned: new Set<string>(),
    blocked: [] as number[],
    seated: new Set<string>(),
    pending: [] as string[],
    seats: 4,
    permits: null as unknown as JoinPermits,
  };
  h.permits = new JoinPermits({
    chain,
    gameOpenFor: async () => h.gameOpen,
    isBanned: (w) => h.banned.has(w.toLowerCase()),
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

  it('an arena takes at most its cap of live permits plus unseated tickets; seated tickets and queued payouts do not count', async () => {
    const h = harness({ arenas: [arena(1, 1000)] });
    h.seats = 3;
    const wallets = [1, 2, 3, 4].map((i) => testSigner().address);
    for (const w of wallets.slice(0, 3)) await h.permits.issue(w, 1, `10.0.1.${wallets.indexOf(w)}`);
    // three live permits: the fourth wallet waits
    const busy = await fail(h.permits.issue(wallets[3], 1, '10.0.1.9'));
    expect([busy.code, busy.status]).toEqual(['arena_busy', 409]);
    // the first wallet's ticket is seated: its permit is done and the seat does not count
    h.seated.add(sessionKey(1, wallets[0], 7));
    h.chain.arenas[0].openSessions = 1;
    expect((await h.permits.issue(wallets[3], 1, '10.0.1.9')).player).toBe(wallets[3]);
    // permits run out; unseated tickets on chain count instead (a payout being settled does not)
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

describe('join permits on the chain (EvmChain + the FakeEvm model of CoinnibalArena v4)', () => {
  async function evmChain(env: Record<string, string> = {}) {
    const evm = new FakeEvm();
    evm.addArena(1, 1_000n);
    evm.nowS = () => Math.floor(T0 / 1000);
    const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), STALE_SESSION_AFTER_S: '60', ...env } as unknown as NodeJS.ProcessEnv);
    const journal = new Journal(null);
    const chain = new EvmChain(cfg, journal, () => {}, { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0, receiptTimeoutMs: 10 });
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
    const late = testSigner().address;
    evm.join(1, late, { openedAt: Math.floor(T0 / 1000) - 3600 });
    expect(await chain.sweepStale()).toBe(1);
    expect(journal.pending[0]).toMatchObject({ reason: 'stale', noShow: true });
    await chain.processPending();
    expect(chain.noShowsSince(late, T0 - 1)).toEqual([T0]);
    expect(chain.settledLog.noShowsSince(late, T0 + 1)).toEqual([]);
    // a disabled arena's tickets go back at once: not the player's doing
    const fresh = testSigner().address;
    evm.join(1, fresh, { openedAt: Math.floor(T0 / 1000) });
    evm.arenaMap.get(1)!.enabled = false;
    expect(await chain.sweepStale()).toBe(1);
    expect((journal.pending[0] as { noShow?: true }).noShow).toBeUndefined();
    await chain.processPending();
    expect(chain.noShowsSince(fresh, 0)).toEqual([]);
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
    const cfg = loadConfig({ PORT: '0', DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-permit-')), GAME_ACCESS: 'public', NODE_ENV: 'development' } as NodeJS.ProcessEnv);
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
});
