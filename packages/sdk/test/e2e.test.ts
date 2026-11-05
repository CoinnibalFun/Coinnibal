/**
 * End to end against a real EVM: spawns `hardhat node` (from @elymum/contracts) on a free port,
 * deploys the TestToken, the arena and the NFT with the SDK's helpers, and runs the money paths:
 * set the token, create the default arenas, join (approve-if-needed), settle a batch (the fee on profit checked
 * against math.ts and the contract's computeFees: burned + to the fee wallet), cancel an unplayed ticket, burn loot,
 * the token's own burn() (burn mode 1), a power-up payment (`pay`), then the allowlist mint with a proof built in
 * TypeScript (excess refunded) and the treasury withdrawal, then the emblem utilities: the holder rates and a
 * holders-only arena on the arena, and the TestToken's holder faucet.
 *
 * Skips itself when the node cannot start within 40 s (no Hardhat, or no network for the compiler
 * download). The child process group is killed when the suite ends or the process exits.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hash, PublicClient, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BURN_ADDRESS,
  DEFAULT_BURN_BPS,
  DEFAULT_VAULT_BPS,
  MintPhase,
  buildMerkleTree,
  cancelCall,
  computeFeesOnChain,
  isBundledArena,
  getCodeHash,
  payCall,
  approveCall,
  probeBurnSupport,
  setBurnModeCall,
  settlementSplit,
  createDefaultArenaCalls,
  createElymumPublicClient,
  createElymumWalletClient,
  deployArena,
  deployNft,
  deployTestToken,
  deployedAddress,
  describeError,
  viemChain,
  faucetCall,
  fromLedger,
  getArena,
  getArenaConfig,
  getFaucetInfo,
  getFeeRatesFor,
  getMintState,
  getMintedBy,
  getNftBalance,
  getSession,
  getTestTokenFaucet,
  getTokenBalance,
  isArenaHolder,
  listArenas,
  mintAllowlistCall,
  mintValue,
  planJoin,
  sendCall,
  setArenaHoldersOnlyCall,
  setHolderPerksCall,
  setMerkleRootCall,
  setPausedCall,
  setPhaseCall,
  setTokenCall,
  settleCalls,
  simulateCall,
  sweepLootCall,
  testTokenMintCall,
  testTokenSetFaucetCall,
  testTokenSetHolderNftCall,
  toLedger,
  usdCentsToWei,
  verifyMerkleProof,
  withdrawCall,
  joinCall,
  type ContractCall,
} from '../src/index';
import { checkDeployedCode, fetchStatus } from '../src/ops';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // admin
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // server
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // player 1
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // player 2
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // fee wallet
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // outsider
] as const;
const [admin, server, p1, p2, feeWallet, outsider] = KEYS.map((k) => privateKeyToAccount(k));
const T = 10n ** 18n;

let child: ChildProcess | null = null;
let up = false;
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
    process.kill(-child.pid, 'SIGTERM'); // the whole group: pnpm and the node it started
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}
process.on('exit', killChild);

async function rpcUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok && /"result"/.test(await r.text());
  } catch {
    return false;
  }
}

async function send(from: Address, call: ContractCall): Promise<Hash> {
  const hash = await sendCall(wallets.get(from)!, call);
  const r = await client.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return hash;
}

beforeAll(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
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
    console.warn('e2e: hardhat node did not start within 40 s; skipping');
    return;
  }
  const chain = viemChain(31337, { rpcUrl: url });
  client = createElymumPublicClient(url, chain, { pollingInterval: 50 });
  for (const a of [admin, server, p1, p2, feeWallet, outsider]) wallets.set(a.address, createElymumWalletClient(url, { account: a, chain, pollingInterval: 50 }));
}, 60_000);

afterAll(() => killChild());

describe('e2e on a hardhat node', () => {
  let token: Address;
  let arena: Address;
  let nft: Address;

  it('deploys the TestToken and the arena with the bundled bytecode', async (ctx) => {
    if (!up) return ctx.skip();
    token = await deployedAddress(client, await deployTestToken(wallets.get(admin.address)!, { owner: admin.address }));
    arena = await deployedAddress(
      client,
      await deployArena(wallets.get(admin.address)!, { admin: admin.address, serverAuthority: server.address, feeWallet: feeWallet.address }),
    );
    expect(await checkDeployedCode(client, token, 'token')).toBe('ok');
    expect(await checkDeployedCode(client, arena, 'arena')).toBe('ok');
    expect(isBundledArena(await getCodeHash(client, arena))).toBe(true);
    expect(isBundledArena(await getCodeHash(client, token))).toBe(false);
    expect(await checkDeployedCode(client, token, 'arena')).toBe('mismatch');
    const c = await getArenaConfig(client, arena);
    expect(c).toMatchObject({ admin: admin.address, serverAuthority: server.address, feeWallet: feeWallet.address, token: null, burnBps: DEFAULT_BURN_BPS, vaultBps: DEFAULT_VAULT_BPS, burnMode: 0, paymentBurnBps: 5000, paused: false });
  }, 30_000);

  it('sets the token and creates the default arenas', async (ctx) => {
    if (!up) return ctx.skip();
    await send(admin.address, setTokenCall(arena, token));
    const c = await getArenaConfig(client, arena);
    expect(c.token).toBe(token);
    expect(c.decimals).toBe(18);
    // set-token is final
    const again = await simulateCall(client, setTokenCall(arena, token), admin).catch((e) => e);
    expect(describeError(again).name).toBe('TokenAlreadySet');

    for (const call of createDefaultArenaCalls(arena, c.decimals)) await send(admin.address, call);
    const arenas = await listArenas(client, arena);
    expect(arenas.map((a) => a.id)).toEqual([1, 2, 3, 4]);
    expect(arenas[0]).toMatchObject({ entryFee: 1000n * T, maxSessions: 300, enabled: true, exists: true, openSessions: 0 });
    expect(createDefaultArenaCalls(arena, 18, arenas.map((a) => a.id))).toEqual([]);
  }, 30_000);

  it('joins with approve-if-needed and settles a batch with the right fee', async (ctx) => {
    if (!up) return ctx.skip();
    for (const p of [p1, p2]) await send(p.address, faucetCall(token));
    expect(await getTokenBalance(client, token, p1.address)).toBe(1_000_000n * T);

    const plan = await planJoin(client, { arena, arenaId: 1, player: p1.address });
    expect(plan.calls.map((c) => c.functionName)).toEqual(['approve', 'join']);
    for (const call of plan.calls) await send(p1.address, call);
    for (const call of (await planJoin(client, { arena, arenaId: 1, player: p2.address, token })).calls) await send(p2.address, call);

    const s1 = await getSession(client, arena, 1, p1.address);
    const s2 = await getSession(client, arena, 1, p2.address);
    expect(s1).toMatchObject({ id: 1n, entryFee: 1000n * T, burnBps: 1500, vaultBps: 500, finalized: false });
    expect(s2.id).toBe(2n);
    // no entry fee: the whole ticket price goes into the vault
    expect((await getArena(client, arena, 1)).vault).toBe(2000n * T);

    // the joining player cannot join twice
    const twice = await simulateCall(client, (await planJoin(client, { arena, arenaId: 1, player: p1.address, token })).join, p1).catch((e) => e);
    expect(describeError(twice).name).toBe('SessionExists');

    // the server's ledger works in ledger units (6 decimals) and converts at the chain boundary
    const entryLedger = toLedger(s1.entryFee, 18);
    expect(entryLedger).toBe(1_000_000_000);
    const payout1 = fromLedger(1_512_345_678, 18); // 1512.345678 tokens: a profit of 512.345678
    const payout2 = 2000n * T - payout1; // a loss: no fee
    const before1 = await getTokenBalance(client, token, p1.address);
    const before2 = await getTokenBalance(client, token, p2.address);
    const calls = settleCalls(arena, [
      { arenaId: 1, player: p1.address, sessionId: s1.id, payout: payout1 },
      { arenaId: 1, player: p2.address, sessionId: s2.id, payout: payout2 },
    ]);
    expect(calls).toHaveLength(1);
    await send(server.address, calls[0]);

    const split1 = settlementSplit(s1.entryFee, payout1, s1);
    expect(await computeFeesOnChain(client, arena, s1.entryFee, payout1, s1)).toEqual({ net: split1.net, burned: split1.burned, toVault: split1.toVault });
    expect(split1.burned).toBe((512_345_678n * 10n ** 12n * 1500n) / 10_000n);
    expect((await getTokenBalance(client, token, p1.address)) - before1).toBe(split1.net);
    expect((await getTokenBalance(client, token, p2.address)) - before2).toBe(payout2); // no fee on a loss
    expect(await getTokenBalance(client, token, feeWallet.address)).toBe(split1.toVault);
    expect(await getTokenBalance(client, token, BURN_ADDRESS)).toBe(split1.burned);
    expect((await getSession(client, arena, 1, p1.address)).id).toBe(0n);
    const a1 = await getArena(client, arena, 1);
    expect(a1).toMatchObject({ vault: 0n, openSessions: 0, totalBurned: split1.burned, totalFees: split1.toVault });
    const c = await getArenaConfig(client, arena);
    expect(c.totals).toMatchObject({ games: 2n, feeBurned: split1.burned, feeToVault: split1.toVault, staked: 2000n * T });

    // a replayed settlement is skipped, not paid twice
    await send(server.address, settleCalls(arena, [{ arenaId: 1, player: p1.address, sessionId: s1.id, payout: payout1 }])[0]);
    expect(await getTokenBalance(client, token, feeWallet.address)).toBe(split1.toVault);

    // a ticket that is never played is cancelled by the server: the full entry fee comes back, no fee
    for (const call of (await planJoin(client, { arena, arenaId: 1, player: p2.address, token })).calls) await send(p2.address, call);
    const s3 = await getSession(client, arena, 1, p2.address);
    const before3 = await getTokenBalance(client, token, p2.address);
    await send(server.address, cancelCall(arena, [{ arenaId: 1, player: p2.address, sessionId: s3.id }]));
    expect((await getTokenBalance(client, token, p2.address)) - before3).toBe(1000n * T);
    expect(await getTokenBalance(client, token, feeWallet.address)).toBe(split1.toVault);
    expect((await getSession(client, arena, 1, p2.address)).id).toBe(0n);

    // only the server may settle
    const notServer = await simulateCall(client, calls[0], p1).catch((e) => e);
    expect(describeError(notServer).name).toBe('NotServer');
  }, 60_000);

  it('burns floor loot with a monotonic sweep id', async (ctx) => {
    if (!up) return ctx.skip();
    for (const call of (await planJoin(client, { arena, arenaId: 1, player: p1.address, token })).calls) await send(p1.address, call);
    const s = await getSession(client, arena, 1, p1.address);
    const burned0 = await getTokenBalance(client, token, BURN_ADDRESS);
    const totalBurned0 = (await getArena(client, arena, 1)).totalBurned;
    await send(server.address, settleCalls(arena, [{ arenaId: 1, player: p1.address, sessionId: s.id, payout: 400n * T }])[0]);
    // the ticket held 1,000 and ended at 400: 600 is left as loot
    await send(server.address, sweepLootCall(arena, 1, 1n, 600n * T));
    expect((await getTokenBalance(client, token, BURN_ADDRESS)) - burned0).toBe(600n * T);
    expect(await getArena(client, arena, 1)).toMatchObject({ vault: 0n, totalBurned: totalBurned0 + 600n * T, lastSweepId: 1n });
    const replay = await simulateCall(client, sweepLootCall(arena, 1, 1n, 0n), server).catch((e) => e);
    expect(describeError(replay).name).toBe('SweepIdNotIncreasing');

    // pause blocks joins only
    await send(admin.address, setPausedCall(arena, true));
    const paused = await simulateCall(client, (await planJoin(client, { arena, arenaId: 2, player: p2.address, token })).join, p2).catch((e) => e);
    expect(describeError(paused)).toMatchObject({ kind: 'contract', name: 'Paused' });
    await send(admin.address, setPausedCall(arena, false));
  }, 60_000);

  it('burns with the token\'s own burn() in burn mode 1, and takes power-up payments half burned', async (ctx) => {
    if (!up) return ctx.skip();
    expect(await probeBurnSupport(client, token, arena)).toBe(true); // the TestToken is ERC20Burnable
    expect(await probeBurnSupport(client, arena, arena)).toBe(false); // the arena has no burn()
    await send(admin.address, setBurnModeCall(arena, 1));
    const supply = async () => (await client.readContract({ address: token, abi: [{ type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }], functionName: 'totalSupply' })) as bigint;
    const dead0 = await getTokenBalance(client, token, BURN_ADDRESS);
    const fee0 = await getTokenBalance(client, token, feeWallet.address);
    const s0 = await supply();
    // a power-up payment: approve, then pay; half is burned (supply falls), half goes to the fee wallet
    await send(p2.address, approveCall(token, arena, 600n * T));
    await send(p2.address, payCall(arena, 600n * T, `0x${'01'.repeat(32)}`));
    expect(s0 - (await supply())).toBe(300n * T);
    expect((await getTokenBalance(client, token, feeWallet.address)) - fee0).toBe(300n * T);
    expect(await getTokenBalance(client, token, BURN_ADDRESS)).toBe(dead0); // nothing sent to 0x…dEaD in mode 1
    expect((await getArenaConfig(client, arena)).totals).toMatchObject({ payments: 600n * T, paymentBurned: 300n * T });
    await send(admin.address, setBurnModeCall(arena, 0));
  }, 60_000);

  it('mints on the allowlist with a TypeScript-built Merkle proof and refunds the excess', async (ctx) => {
    if (!up) return ctx.skip();
    const price = usdCentsToWei(100, '40'); // $1 at 40 USD per gas token = 0.025
    nft = await deployedAddress(
      client,
      await deployNft(wallets.get(admin.address)!, {
        owner: admin.address,
        maxSupply: 100,
        mintPrice: price,
        wlLimit: 2,
        publicLimit: 2,
        baseURI: 'https://elymum.test/api/nft/',
        treasury: feeWallet.address,
      }),
    );
    expect(await checkDeployedCode(client, nft, 'nft')).toBe('ok');

    const extra = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    const tree = buildMerkleTree([p2.address.toLowerCase(), ...extra, p1.address]);
    expect(tree.count).toBe(8);
    await send(admin.address, setMerkleRootCall(nft, tree.root));
    await send(admin.address, setPhaseCall(nft, 'allowlist'));
    const state = await getMintState(client, nft);
    expect(state).toMatchObject({ phase: MintPhase.Allowlist, root: tree.root, price, totalSupply: 0, maxSupply: 100 });

    const proof = tree.proof(p1.address)!;
    expect(verifyMerkleProof(tree.root, p1.address, proof)).toBe(true);
    const call = mintAllowlistCall(nft, { qty: 2, proof, price: state.price });
    expect(call.value).toBe(mintValue(price, 2)); // 1 % over
    expect(call.value! > price * 2n).toBe(true);

    const before = await client.getBalance({ address: p1.address });
    const hash = await send(p1.address, call);
    const r = await client.getTransactionReceipt({ hash });
    const after = await client.getBalance({ address: p1.address });
    expect(before - after).toBe(price * 2n + r.gasUsed * r.effectiveGasPrice); // the 1 % buffer came back
    expect(await client.getBalance({ address: nft })).toBe(price * 2n);
    expect(await getNftBalance(client, nft, p1.address)).toBe(2n);
    expect(await getMintedBy(client, nft, p1.address)).toEqual({ wl: 2, pub: 0 });

    // every listed wallet verifies on chain; an outsider cannot reuse a proof
    const p2proof = tree.proof(p2.address)!;
    await send(p2.address, mintAllowlistCall(nft, { qty: 1, proof: p2proof, price }));
    const stolen = await simulateCall(client, mintAllowlistCall(nft, { qty: 1, proof, price }), outsider).catch((e) => e);
    expect(describeError(stolen).name).toBe('NotAllowlisted');
    const over = await simulateCall(client, mintAllowlistCall(nft, { qty: 1, proof, price }), p1).catch((e) => e);
    expect(describeError(over).name).toBe('WlLimitExceeded');

    // withdraw to the treasury
    const t0 = await client.getBalance({ address: feeWallet.address });
    await send(admin.address, withdrawCall(nft));
    expect((await client.getBalance({ address: feeWallet.address })) - t0).toBe(price * 3n);

    const status = await fetchStatus(client, { arena, nft, account: admin.address });
    expect(status.chain.id).toBe(31337);
    expect(status.arena?.code).toBe('ok');
    expect(status.arena?.arenas).toHaveLength(4);
    expect(status.nft?.state?.totalSupply).toBe(3);
  }, 60_000);

  it('emblem holders get the holder rates and alone enter a holders-only arena', async (ctx) => {
    if (!up) return ctx.skip();
    // p1 holds 2 emblems, p2 holds 1, the outsider none (minted above)
    const holder = { burnBps: 1500, vaultBps: 0 };
    await send(admin.address, setHolderPerksCall(arena, nft, holder));
    await send(admin.address, setArenaHoldersOnlyCall(arena, 4, true));
    const c = await getArenaConfig(client, arena);
    expect(c).toMatchObject({ holderNft: nft, holderBurnBps: 1500, holderVaultBps: 0, burnBps: 1500, vaultBps: 500 });
    expect((await getArena(client, arena, 4)).holdersOnly).toBe(true);
    expect((await getArena(client, arena, 2)).holdersOnly).toBe(false);
    expect(await isArenaHolder(client, arena, p1.address)).toBe(true);
    expect(await isArenaHolder(client, arena, outsider.address)).toBe(false);
    expect(await getFeeRatesFor(client, arena, p1.address)).toEqual(holder);
    expect(await getFeeRatesFor(client, arena, outsider.address)).toEqual({ burnBps: 1500, vaultBps: 500 });

    await send(admin.address, testTokenMintCall(token, outsider.address, 10_000n * T)); // the owner mints
    const plan = await planJoin(client, { arena, arenaId: 2, player: p1.address });
    expect(plan).toMatchObject({ rates: holder, standardRates: { burnBps: 1500, vaultBps: 500 }, holder: true, holderDiscount: true, holdersOnly: false });
    for (const call of plan.calls) await send(p1.address, call);
    const outsiderPlan = await planJoin(client, { arena, arenaId: 2, player: outsider.address, token });
    expect(outsiderPlan).toMatchObject({ rates: { burnBps: 1500, vaultBps: 500 }, holder: false, holderDiscount: false });
    for (const call of outsiderPlan.calls) await send(outsider.address, call);
    const s1 = await getSession(client, arena, 2, p1.address);
    const so = await getSession(client, arena, 2, outsider.address);
    expect([s1.vaultBps, so.vaultBps]).toEqual([0, 500]);
    const fees0 = await getTokenBalance(client, token, feeWallet.address);
    expect((await getArena(client, arena, 2)).vault).toBe(20_000n * T);
    await send(
      server.address,
      settleCalls(arena, [
        { arenaId: 2, player: p1.address, sessionId: s1.id, payout: 15_000n * T },
        { arenaId: 2, player: outsider.address, sessionId: so.id, payout: 5_000n * T },
      ])[0],
    );
    // the holder's profit of 5,000 pays 750 burned and nothing to the fee wallet; the outsider lost and pays nothing
    expect(settlementSplit(s1.entryFee, 15_000n * T, s1)).toEqual({ profit: 5_000n * T, burned: 750n * T, toVault: 0n, net: 14_250n * T });
    expect((await getTokenBalance(client, token, feeWallet.address)) - fees0).toBe(0n);

    // holders-only: refused early by planJoin, and by the contract
    await expect(planJoin(client, { arena, arenaId: 4, player: outsider.address, token })).rejects.toThrow(/holders only/);
    const refused = await simulateCall(client, joinCall(arena, 4), outsider).catch((e) => e);
    expect(describeError(refused)).toMatchObject({ kind: 'contract', name: 'HoldersOnly' });
    const holderPlan = await planJoin(client, { arena, arenaId: 4, player: p2.address, token });
    expect(holderPlan).toMatchObject({ holdersOnly: true, holder: true, rates: holder });
  }, 60_000);

  it('TestToken: owner-only mint, the holder faucet bonus and owner-set amounts', async (ctx) => {
    if (!up) return ctx.skip();
    // only the owner mints (the minter role is gone)
    const denied = await simulateCall(client, testTokenMintCall(token, server.address, 5n * T), server).catch((e) => e);
    expect(describeError(denied).name).toBe('OwnableUnauthorizedAccount');

    // holders get the holder amount
    const block = await client.getBlock();
    const now = Number(block.timestamp);
    await send(admin.address, testTokenSetHolderNftCall(token, nft));
    expect(await getFaucetInfo(client, token, outsider.address, now)).toEqual({ amount: 1_000_000n * T, nextClaimAt: 0, canClaim: true, waitSecs: 0 });
    const p1Info = await getFaucetInfo(client, token, p1.address, now);
    expect(p1Info.amount).toBe(2_000_000n * T);
    expect(p1Info.canClaim).toBe(false); // claimed at the start of the suite, 1 h cooldown
    const cooling = await simulateCall(client, faucetCall(token), p1).catch((e) => e);
    expect(describeError(cooling).name).toBe('FaucetCooldown');

    await send(admin.address, testTokenSetFaucetCall(token, { amount: 10n * T, holderAmount: 30n * T, cooldownSecs: 0 }));
    expect(await getTestTokenFaucet(client, token)).toMatchObject({ amount: 10n * T, holderAmount: 30n * T, cooldownSecs: 0, holderNft: nft, owner: admin.address });
    const b1 = await getTokenBalance(client, token, p1.address);
    await send(p1.address, faucetCall(token));
    expect((await getTokenBalance(client, token, p1.address)) - b1).toBe(30n * T);
    const bo = await getTokenBalance(client, token, outsider.address);
    await send(outsider.address, faucetCall(token));
    expect((await getTokenBalance(client, token, outsider.address)) - bo).toBe(10n * T);
    const invalid = await simulateCall(client, { ...testTokenSetFaucetCall(token, { amount: 10n, holderAmount: 10n, cooldownSecs: 0 }), args: [10n, 9n, 0n] }, admin).catch((e) => e);
    expect(describeError(invalid).name).toBe('InvalidFaucet');

    // the status read shows the perks and the TestToken (auto-detected as the game token)
    const status = await fetchStatus(client, { arena, nft, account: admin.address });
    expect(status.arena?.config).toMatchObject({ holderNft: nft, holderBurnBps: 1500, holderVaultBps: 0 });
    expect(status.arena?.arenas.find((a) => a.id === 4)?.holdersOnly).toBe(true);
    expect(status.testToken).toMatchObject({ address: token, code: 'ok' });
    expect(status.testToken?.faucet).toMatchObject({ amount: 10n * T, holderAmount: 30n * T, holderNft: nft });
  }, 60_000);
});
