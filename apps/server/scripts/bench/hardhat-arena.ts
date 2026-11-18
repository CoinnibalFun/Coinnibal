/**
 * A real CoinnibalArena v3 + TestToken on a local `hardhat node` for the bell-burst and failure drills: deploys with
 * the SDK (the /admin order), creates the four default arenas, funds `players` fresh wallets with gas
 * (`hardhat_setBalance`) and tokens, and buys tickets for them. `interval` > 0 mines a block every that many ms
 * instead of on every transaction (Robinhood Chain, an Arbitrum Orbit chain, makes blocks about every 250 ms).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approveCall,
  createDefaultArenaCalls,
  createElymumPublicClient,
  createElymumWalletClient,
  deployArena,
  deployTestToken,
  deployedAddress,
  coinnibalArenaAbi,
  getArena,
  getSession,
  joinCall,
  sendCall,
  setTokenCall,
  testTokenMintCall,
  viemChain,
  type ContractCall,
} from '@elymum/sdk';
import { toHex, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MNEMONIC = 'test test test test test test test test test test test junk';

export function freePort(): Promise<number> {
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

export interface HardhatArena {
  url: string;
  pub: PublicClient;
  arena: Address;
  token: Address;
  serverKey: Hex;
  server: PrivateKeyAccount;
  players: PrivateKeyAccount[];
  entryFee: Map<number, bigint>;
  /** Buys a ticket in `arenaIds[i % n]` for every player without an open session there; returns how many. */
  buyAll(arenaOf: (i: number) => number): Promise<number>;
  logs(eventName: 'Settled' | 'Cancelled' | 'SettleSkipped' | 'Joined', fromBlock?: bigint): Promise<{ args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[]>;
  nonce(addr: Address): Promise<number>;
  stop(): void;
}

export async function startHardhatArena(opts: { players: number; intervalMs?: number }): Promise<HardhatArena> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // the `bench` network keeps block timestamps on the real clock (several blocks a second share a timestamp, as on
  // Robinhood Chain); the default node adds a second per block, so its time would run 4x fast at 250 ms blocks
  const child: ChildProcess = spawn('pnpm', ['-F', '@elymum/contracts', 'exec', 'hardhat', '--network', 'bench', 'node', '--port', String(port)], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const stop = () => {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      /* gone */
    }
  };
  process.on('exit', stop);
  for (const deadline = Date.now() + 60_000; ; ) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error('hardhat node did not start');
    await new Promise((r) => setTimeout(r, 300));
  }
  const chain = viemChain(31337, { rpcUrl: url });
  const pub: PublicClient = createElymumPublicClient(url, chain, { pollingInterval: 20 });
  const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });
  const admin = privateKeyToAccount(toHex(mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).getHdKey().privateKey!));
  const serverKey = generatePrivateKey();
  const server = privateKeyToAccount(serverKey);
  const players = Array.from({ length: opts.players }, () => privateKeyToAccount(generatePrivateKey()));
  const gas = toHex(10n ** 20n);
  await rpc('hardhat_setBalance', [server.address, toHex(10n ** 18n)]);
  for (const p of players) await rpc('hardhat_setBalance', [p.address, gas]);
  const wallets = new Map<string, WalletClient>();
  for (const a of [admin, ...players]) wallets.set(a.address.toLowerCase(), createElymumWalletClient(url, { account: a, chain, pollingInterval: 20 }));
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
  const arena = await deployedAddress(pub, await deployArena(W, { admin: admin.address, serverAuthority: server.address, feeWallet: admin.address }));
  if (!(await send(admin.address, setTokenCall(arena, token)))) throw new Error('setToken failed');
  for (const call of createDefaultArenaCalls(arena, 18)) if (!(await send(admin.address, call))) throw new Error('createArena failed');
  const grant = 10_000_000n * 10n ** 18n;
  for (const p of players) if (!(await send(admin.address, testTokenMintCall(token, p.address, grant)))) throw new Error('mint failed');
  const pool = async <T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }));
  };
  await pool(players, 16, async (p) => {
    if (!(await send(p.address, approveCall(token, arena, (1n << 256n) - 1n)))) throw new Error('approve failed');
  });
  const entryFee = new Map<number, bigint>();
  for (const id of [1, 2, 3, 4]) entryFee.set(id, (await getArena(pub, arena, id)).entryFee);
  if (opts.intervalMs && opts.intervalMs > 0) {
    await rpc('evm_setAutomine', [false]);
    await rpc('evm_setIntervalMining', [opts.intervalMs]);
  }
  return {
    url,
    pub,
    arena,
    token,
    serverKey,
    server,
    players,
    entryFee,
    async buyAll(arenaOf) {
      let n = 0;
      await pool(players, 16, async (p, i) => {
        const id = arenaOf(i);
        const s = await getSession(pub, arena, id, p.address);
        if (s.id !== 0n && !s.finalized) return;
        if (await send(p.address, joinCall(arena, id))) n++;
      });
      return n;
    },
    async logs(eventName, fromBlock = 0n) {
      return (await pub.getContractEvents({ address: arena, abi: coinnibalArenaAbi, eventName, fromBlock })) as unknown as { args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[];
    },
    nonce: (addr) => pub.getTransactionCount({ address: addr }),
    stop,
  };
}
