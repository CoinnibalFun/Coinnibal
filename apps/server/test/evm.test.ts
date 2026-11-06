/**
 * The EVM gateway against a real chain: spawns `hardhat node` (from @elymum/contracts) on a free port,
 * deploys the TestToken and the arena with the SDK, then runs `EvmChain` through the money paths:
 * waiting for contracts → token set → join (real tickets) → one settle batch (the fee on profit: burned + to the
 * fee wallet) → the token's own burn() in burn mode 1 → loot burn with a sweep id → the stale-session sweeper
 * cancelling unplayed tickets (the full entry fee back).
 *
 * Skips itself when the node does not start within 40 s (e.g. Hardhat is not installed). The child process
 * group is killed when the suite ends or the process exits.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BURN_ADDRESS,
  createDefaultArenaCalls,
  createElymumPublicClient,
  createElymumWalletClient,
  deployArena,
  deployTestToken,
  deployedAddress,
  viemChain,
  faucetCall,
  getArena,
  getSession,
  getTokenBalance,
  planJoin,
  sendCall,
  setBurnModeCall,
  testTokenAbi,
  setTokenCall,
  type ContractCall,
} from '@elymum/sdk';

import type { Address, PublicClient, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvmChain, type ContractsView } from '../src/chain/evm';
import { sessionKey, type SettledEvent } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Journal, sweepKey, type SettlementItem } from '../src/stake/journal';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // admin
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // server
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // player 1
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // player 2
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // fee wallet
] as const;
const [admin, server, p1, p2, feeWallet] = KEYS.map((k) => privateKeyToAccount(k));
const T = 10n ** 18n;
/** 1,000 tokens in ledger units. */
const K = 1_000 * 1e6;

let child: ChildProcess | null = null;
let up = false;
let url = '';
let client: PublicClient;
const wallets = new Map<Address, WalletClient>();

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? ok(a.port) : fail(new Error('no port'))));
    });
  });
}

function killChild(): void {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}
process.on('exit', killChild);

async function rpcUp(u: string): Promise<boolean> {
  try {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok && /"result"/.test(await r.text());
  } catch {
    return false;
  }
}

async function send(from: Address, call: ContractCall): Promise<void> {
  const hash = await sendCall(wallets.get(from)!, call);
  const r = await client.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
}

beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  child = spawn('pnpm', ['-F', '@elymum/contracts', 'exec', 'hardhat', 'node', '--port', String(port)], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  child.on('error', () => undefined);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await rpcUp(url)) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) {
    killChild();
    console.warn('evm.test: hardhat node did not start within 40 s; skipping');
    return;
  }
  const chain = viemChain(31337, { rpcUrl: url });
  client = createElymumPublicClient(url, chain, { pollingInterval: 50 });
  for (const a of [admin, server, p1, p2, feeWallet]) wallets.set(a.address, createElymumWalletClient(url, { account: a, chain, pollingInterval: 50 }));
}, 60_000);

afterAll(() => killChild());

describe('EvmChain on a hardhat node', () => {
  let token: Address;
  let arena: Address;
  let chain: EvmChain;
  const journal = new Journal(null);
  const view: ContractsView = { arena: null, nft: null };
  const settled: SettledEvent[] = [];
  const logs: string[] = [];
  /** The gateway's clock (moved forward to make tickets stale). */
  let skewMs = 0;

  it('starts waiting for contracts, then picks up the deployed arena and its token without a restart', async (ctx) => {
    if (!up) return ctx.skip();
    const cfg = loadConfig({
      EVM_RPC_URL: url,
      SERVER_PRIVATE_KEY: KEYS[1],
      DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-evm-')),
      STALE_SESSION_AFTER_S: '60',
      LOG_CHUNK_BLOCKS: '5',
    } as unknown as NodeJS.ProcessEnv);
    chain = new EvmChain(cfg, journal, (m) => logs.push(m), { contracts: () => view, loops: false, now: () => Date.now() + skewMs, receiptTimeoutMs: 20_000 });
    chain.onSettled((e) => settled.push(e));
    await chain.start();
    expect(chain.status()).toMatchObject({ enabled: true, chainId: 31337, chainName: 'Localnet', arenaAddress: null, tokenReady: false, serverKey: server.address });

    token = await deployedAddress(client, await deployTestToken(wallets.get(admin.address)!, { owner: admin.address }));
    arena = await deployedAddress(
      client,
      await deployArena(wallets.get(admin.address)!, { admin: admin.address, serverAuthority: server.address, feeWallet: feeWallet.address }),
    );
    view.arena = arena;
    await chain.refresh();
    expect(chain.status()).toMatchObject({ arenaAddress: arena, tokenReady: false });

    await send(admin.address, setTokenCall(arena, token));
    for (const call of createDefaultArenaCalls(arena, 18)) await send(admin.address, call);
    let changes = 0;
    chain.onStatusChange(() => changes++);
    await chain.refresh();
    expect(changes).toBe(1);
    expect(chain.status()).toMatchObject({ tokenReady: true, arenasEnabled: true, token: { address: token, decimals: 18 }, fees: { burnBps: 1500, vaultBps: 500, paymentBurnBps: 5000, burnMode: 0 } });
    expect((await chain.listArenas(true)).map((a) => [a.id, a.entryFee])).toEqual([
      [1, K],
      [2, 3 * K],
      [3, 5 * K],
      [4, 10 * K],
    ]);
    await chain.checkBalance();
    expect(chain.serverInfo()).toMatchObject({ address: server.address, low: false });
  }, 60_000);

  it('real tickets: join, then one settle batch pays the winner less the fee on its profit (burned + fee wallet)', async (ctx) => {
    if (!up) return ctx.skip();
    for (const p of [p1, p2]) {
      await send(p.address, faucetCall(token));
      for (const call of (await planJoin(client, { arena, arenaId: 1, player: p.address, token })).calls) await send(p.address, call);
    }
    const s1 = (await chain.getSession(1, p1.address))!;
    const s2 = (await chain.getSession(1, p2.address.toLowerCase()))!;
    // arena v3: no entry fee, the ticket plays its whole 1,000; its fee rates on profit are fixed at the join
    expect(s1).toMatchObject({ key: sessionKey(1, p1.address, s1.id), player: p1.address, entryFee: K, value: K, rates: { burnBps: 1500, vaultBps: 500 }, finalized: false });
    expect(s2.id).toBe(s1.id + 1);
    const before1 = await getTokenBalance(client, token, p1.address);
    const item = (s: typeof s1, payout: number, createdAt: number): SettlementItem => ({
      kind: 'settle',
      key: s.key,
      player: s.player,
      arenaId: 1,
      session: s.key,
      sessionId: s.id,
      payout,
      score: 1,
      kills: 1,
      xp: 1,
      reason: 'round',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt,
    });
    // p1 ate half of p2: 1,500 / 500 tokens
    journal.commit({ enqueue: [item(s1, 1_500 * 1e6, 1), item(s2, 500 * 1e6, 2)] });
    await chain.processPending();
    expect(journal.pending).toHaveLength(0);
    // p1's profit of 500: 75 burned, 25 to the fee wallet, 1,400 to p1; p2 lost and pays nothing
    expect(settled.map((e) => [e.player, e.payout, e.fee, e.burned, e.toVault, e.net])).toEqual([
      [p1.address, 1_500 * 1e6, 100 * 1e6, 75 * 1e6, 25 * 1e6, 1_400 * 1e6],
      [p2.address, 500 * 1e6, 0, 0, 0, 500 * 1e6],
    ]);
    expect(settled[0].txHash).toBe(settled[1].txHash); // one batch
    expect(await getTokenBalance(client, token, p1.address)).toBe(before1 + 1_400n * T);
    expect(await getTokenBalance(client, token, feeWallet.address)).toBe(25n * T);
    expect(await getTokenBalance(client, token, BURN_ADDRESS)).toBe(75n * T);
    expect((await getSession(client, arena, 1, p1.address)).id).toBe(0n);
    expect((await getArena(client, arena, 1)).vault).toBe(0n);
  }, 60_000);

  it('burn mode 1: the fee burn uses the token\'s own burn() (the supply falls, nothing goes to 0x…dEaD)', async (ctx) => {
    if (!up) return ctx.skip();
    await send(admin.address, setBurnModeCall(arena, 1));
    await chain.refresh();
    expect(chain.status().fees?.burnMode).toBe(1);
    const supply = async () => (await client.readContract({ address: token, abi: testTokenAbi, functionName: 'totalSupply' })) as bigint;
    for (const p of [p1, p2]) for (const call of (await planJoin(client, { arena, arenaId: 1, player: p.address, token })).calls) await send(p.address, call);
    const a = (await chain.getSession(1, p1.address))!;
    const b = (await chain.getSession(1, p2.address))!;
    const mk = (s: typeof a, payout: number, createdAt: number): SettlementItem => ({ kind: 'settle', key: s.key, player: s.player, arenaId: 1, session: s.key, sessionId: s.id, payout, score: 1, kills: 0, xp: 1, reason: 'round', attempts: 0, nextAttemptAt: 0, createdAt });
    const dead0 = await getTokenBalance(client, token, BURN_ADDRESS);
    const s0 = await supply();
    journal.commit({ enqueue: [mk(a, 2_000 * 1e6, 5), mk(b, 0, 6)] });
    await chain.processPending();
    expect(journal.pending).toHaveLength(0);
    expect(s0 - (await supply())).toBe(150n * T);
    expect(await getTokenBalance(client, token, BURN_ADDRESS)).toBe(dead0);
    await send(admin.address, setBurnModeCall(arena, 0));
    await chain.refresh();
  }, 60_000);

  it('burns floor loot with a sweep id the journal assigned', async (ctx) => {
    if (!up) return ctx.skip();
    for (const call of (await planJoin(client, { arena, arenaId: 1, player: p1.address, token })).calls) await send(p1.address, call);
    const s = (await chain.getSession(1, p1.address))!;
    const dead0 = await getTokenBalance(client, token, BURN_ADDRESS);
    const burned0 = (await getArena(client, arena, 1)).totalBurned;
    // 100 of p1's 1,000 spilled as loot nobody picked up: paid 900, the loot is burned
    journal.commit({
      enqueue: [
        { kind: 'settle', key: s.key, player: s.player, arenaId: 1, session: s.key, sessionId: s.id, payout: 900 * 1e6, score: 1, kills: 0, xp: 1, reason: 'round', attempts: 0, nextAttemptAt: 0, createdAt: 3 },
        { kind: 'sweep', key: sweepKey('arena-1-1', 9), arenaId: 1, roomId: 'arena-1-1', round: 9, amount: 100 * 1e6, attempts: 0, nextAttemptAt: 0, createdAt: 4 },
      ],
    });
    await chain.processPending();
    expect(journal.pending).toHaveLength(0);
    expect(journal.lastSweepId(1)).toBe(1);
    const a = await getArena(client, arena, 1);
    expect(a).toMatchObject({ lastSweepId: 1n, totalBurned: burned0 + 100n * T, vault: 0n, openSessions: 0 });
    expect((await getTokenBalance(client, token, BURN_ADDRESS)) - dead0).toBe(100n * T);
    expect(logs.join('\n')).toMatch(/burned 100 \$ELYMUM loot of arena-1-1 \(round 9\) · sweep #1/);
  }, 60_000);

  it('the stale sweeper finds unplayed tickets in the Joined logs and cancels them: the full entry fee back', async (ctx) => {
    if (!up) return ctx.skip();
    for (const call of (await planJoin(client, { arena, arenaId: 2, player: p2.address, token })).calls) await send(p2.address, call);
    expect(await chain.sweepStale()).toBe(0); // fresh tickets are not stale
    skewMs = 3_600_000;
    const before2 = await getTokenBalance(client, token, p2.address);
    expect(await chain.sweepStale()).toBe(1); // every arena-1 ticket was settled: only p2's in arena 2
    // the journal counts what leaves the vault: the whole 3,000 entry fee
    expect(journal.settlements().map((s) => [s.player, s.arenaId, s.payout, s.reason])).toEqual([[p2.address, 2, 3_000 * 1e6, 'stale']]);
    const fees2 = await getTokenBalance(client, token, feeWallet.address);
    await chain.processPending();
    expect(journal.pending).toHaveLength(0);
    expect(await getTokenBalance(client, token, p2.address)).toBe(before2 + 3_000n * T);
    expect((await getSession(client, arena, 2, p2.address)).id).toBe(0n);
    expect(settled.at(-1)).toMatchObject({ player: p2.address, arenaId: 2, payout: 3 * K, fee: 0, refund: true });
    expect((await getArena(client, arena, 2)).vault).toBe(0n);
    expect(await getTokenBalance(client, token, feeWallet.address)).toBe(fees2); // no fee for an unplayed ticket
    expect(await chain.sweepStale()).toBe(0);
    await chain.stop();
  }, 60_000);
});
