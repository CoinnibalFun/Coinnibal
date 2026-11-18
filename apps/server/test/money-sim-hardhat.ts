/**
 * The money simulation's chain on a real `hardhat node` with the real CoinnibalArena v3 and the TestToken (deployed
 * with the SDK, like /admin does). The game server talks to it through its production client (`viemEvmClient`).
 * Returns null when the node does not start within 40 s (Hardhat missing): callers skip.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BURN_ADDRESS,
  approveCall,
  createDefaultArenaCalls,
  createCoinnibalPublicClient,
  createCoinnibalWalletClient,
  deployArena,
  deployNft,
  deployTestToken,
  deployedAddress,
  coinnibalArenaAbi,
  getArena,
  getSession,
  getTokenBalance,
  joinCall,
  ownerMintCall,
  refundCall,
  sendCall,
  setHolderPerksCall,
  setTokenCall,
  testTokenMintCall,
  viemChain,
  type ContractCall,
} from '@coinnibal/sdk';
import { DEFAULT_HOLDER_FEE_RATES, computeProfitFee } from '@coinnibal/shared';
import { toHex, type Address, type PublicClient, type WalletClient } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { viemEvmClient } from '../src/chain/evm-client';
import { configureRpcBudgets } from '../src/chain/rpc-budget';
import { expectedRates, type Closure, type SimChain } from './money-sim';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MNEMONIC = 'test test test test test test test test test test test junk';

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

async function rpcUp(u: string): Promise<boolean> {
  try {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok && /"result"/.test(await r.text());
  } catch {
    return false;
  }
}

/**
 * Starts a hardhat node, deploys and sets up the arena (arenas 1 and 2 used), funds `players` wallets. Every third
 * wallet holds a CoinnibalNFT (owner-minted), the arena's holder NFT at the owner's holder pair (8 % + 2 %).
 */
export async function hardhatSimChain(opts: { players: number; seed: number }): Promise<SimChain> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn('pnpm', ['-F', '@coinnibal/contracts', 'exec', 'hardhat', 'node', '--port', String(port)], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  child.on('error', () => undefined);
  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };
  process.on('exit', kill);
  let up = false;
  for (const deadline = Date.now() + 40_000; Date.now() < deadline && child.exitCode === null; ) {
    if (await rpcUp(url)) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) {
    kill();
    throw new Error('hardhat node did not start within 40 s');
  }
  // a local node: no request budget worth the name
  configureRpcBudgets({ ratePerSec: 100_000, burst: 100_000 });
  const chain = viemChain(31337, { rpcUrl: url });
  const pub: PublicClient = createCoinnibalPublicClient(url, chain, { pollingInterval: 20 });
  const account = (i: number) => privateKeyToAccount(toHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey!));
  const admin = account(0);
  const server = account(1);
  const feeWallet = account(2);
  const playerAccounts = Array.from({ length: opts.players }, (_, i) => account(3 + i));
  const wallets = new Map<string, WalletClient>();
  for (const a of [admin, ...playerAccounts]) wallets.set(a.address.toLowerCase(), createCoinnibalWalletClient(url, { account: a, chain, pollingInterval: 20 }));
  const send = async (from: Address, call: ContractCall): Promise<boolean> => {
    try {
      const hash = await sendCall(wallets.get(from.toLowerCase())!, call);
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      return r.status === 'success';
    } catch {
      return false;
    }
  };
  const W = wallets.get(admin.address.toLowerCase())!;
  const token = await deployedAddress(pub, await deployTestToken(W, { owner: admin.address }));
  const arena = await deployedAddress(pub, await deployArena(W, { admin: admin.address, serverAuthority: server.address, feeWallet: feeWallet.address }));
  if (!(await send(admin.address, setTokenCall(arena, token)))) throw new Error('setToken failed');
  for (const call of createDefaultArenaCalls(arena, 18)) if (!(await send(admin.address, call))) throw new Error('createArena failed');
  const nft = await deployedAddress(pub, await deployNft(W, { owner: admin.address, maxSupply: 100, mintPrice: 0n, wlLimit: 1, publicLimit: 1, baseURI: '', treasury: admin.address }));
  if (!(await send(admin.address, setHolderPerksCall(arena, nft, DEFAULT_HOLDER_FEE_RATES)))) throw new Error('setHolderPerks failed');
  const holders = new Set<string>();
  for (const [i, p] of playerAccounts.entries()) {
    if (i % 3 !== 0) continue;
    if (!(await send(admin.address, ownerMintCall(nft, p.address, 1)))) throw new Error('ownerMint failed');
    holders.add(p.address.toLowerCase());
  }
  const grant = 100_000_000n * 10n ** 18n;
  for (const p of playerAccounts) {
    if (!(await send(admin.address, testTokenMintCall(token, p.address, grant)))) throw new Error('mint failed');
    if (!(await send(p.address, approveCall(token, arena, (1n << 256n) - 1n)))) throw new Error('approve failed');
  }
  const ids = [1, 2];
  const fees = new Map<number, bigint>();
  for (const id of ids) fees.set(id, (await getArena(pub, arena, id)).entryFee);
  const client = viemEvmClient(url, server, { chainId: 31337, pollingInterval: 20, multicall: false });

  const logs = async (eventName: 'Settled' | 'Cancelled' | 'Refunded' | 'Collected' | 'Joined') =>
    (await pub.getContractEvents({ address: arena, abi: coinnibalArenaAbi, eventName, fromBlock: 0n })) as unknown as { args: Record<string, unknown> }[];

  return {
    name: 'hardhat node (CoinnibalArena v3, TestToken)',
    arenaAddress: arena,
    client,
    decimals: 18,
    wallets: playerAccounts.map((a) => a.address),
    holders,
    arenaIds: () => ids,
    entryFee: (id) => fees.get(id)!,
    buy: (w, id) => send(w, joinCall(arena, id)),
    refund: (w, id) => send(w, refundCall(arena, id)),
    async advance(s) {
      if (s <= 0) return;
      await pub.request({ method: 'evm_increaseTime' as never, params: [s] as never });
      await pub.request({ method: 'evm_mine' as never, params: [] as never });
    },
    async nowS() {
      return Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
    },
    arena: (id) => getArena(pub, arena, id),
    session: (id, w) => getSession(pub, arena, id, w),
    async tokens() {
      let inWallets = 0n;
      for (const p of playerAccounts) inWallets += await getTokenBalance(pub, token, p.address);
      return {
        wallets: inWallets,
        arena: await getTokenBalance(pub, token, arena),
        feeWallet: await getTokenBalance(pub, token, feeWallet.address),
        burned: await getTokenBalance(pub, token, BURN_ADDRESS),
        minted: grant * BigInt(playerAccounts.length),
      };
    },
    async closures() {
      const out: Closure[] = [];
      for (const name of ['Settled', 'Cancelled', 'Refunded', 'Collected'] as const) {
        for (const l of await logs(name)) {
          const a = l.args;
          out.push({ name, arenaId: Number(a.arenaId), player: String(a.player), sessionId: a.sessionId as bigint, amount: (a.payout ?? a.amount) as bigint });
        }
      }
      return out;
    },
    async feeViolations() {
      const joined = new Map<bigint, { entryFee: bigint; burnBps: number; vaultBps: number }>();
      const bad: string[] = [];
      for (const l of await logs('Joined')) {
        const r = { entryFee: l.args.entryFee as bigint, burnBps: Number(l.args.burnBps), vaultBps: Number(l.args.vaultBps) };
        joined.set(l.args.sessionId as bigint, r);
        const want = expectedRates(holders, String(l.args.player));
        if (r.burnBps !== want.burnBps || r.vaultBps !== want.vaultBps) bad.push(`Joined #${l.args.sessionId} of ${l.args.player}: rates ${r.burnBps}/${r.vaultBps}, want ${want.burnBps}/${want.vaultBps}`);
      }
      for (const l of await logs('Settled')) {
        const a = l.args;
        const j = joined.get(a.sessionId as bigint);
        if (!j) {
          bad.push(`Settled #${a.sessionId} has no Joined event`);
          continue;
        }
        const f = computeProfitFee(j.entryFee, a.payout as bigint, j);
        if (f.burned !== a.burned || f.toVault !== a.toVault || f.net !== a.net) bad.push(`Settled #${a.sessionId}: fee split ${a.burned}/${a.toVault}/${a.net} != shared fee module ${f.burned}/${f.toVault}/${f.net}`);
      }
      return bad;
    },
    async stop() {
      kill();
    },
  };
}
