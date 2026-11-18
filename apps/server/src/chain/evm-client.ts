import {
  coinnibalArenaAbi,
  coinnibalNFTAbi,
  getAllowance,
  getArena,
  getArenaConfig,
  getTestTokenFaucet,
  getTokenBalance,
  isArenaHolder,
  getMintState,
  getNftBalance,
  getSession,
  listArenas,
  sendCall,
  simulateCall,
  toViemChain,
  type ArenaConfig,
  type ArenaInfo,
  type ContractCall,
  type MintState,
  type SessionInfo,
  type TestTokenFaucetConfig,
} from '@coinnibal/sdk';
import { checkDeployedCode, type CodeCheck } from '@coinnibal/sdk/ops';
import { chainInfo, type ChainOverrides } from '@coinnibal/shared';
import {
  createPublicClient,
  createWalletClient,
  fallback,
  getAddress,
  http,
  zeroAddress,
  parseEventLogs,
  verifyMessage as verifyEoaMessage,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { rpcBudgetFor } from './rpc-budget';

export type { CodeCheck } from '@coinnibal/sdk/ops';
export type ContractKindCode = 'arena' | 'nft' | 'token';

/** An `CoinnibalArena` event the settlement worker reads from a receipt. */
export type ArenaEvent =
  /** `settle`: `payout` (gross) left the vault; `burned` + `toVault` is the fee on its profit, `net` reached the player. */
  | { name: 'Settled'; arenaId: number; player: Address; sessionId: bigint; payout: bigint; net: bigint; burned: bigint; toVault: bigint; collected: boolean }
  /** `cancel`: an unplayed ticket's full entry fee went back (no fee). */
  | { name: 'Cancelled'; arenaId: number; player: Address; sessionId: bigint; amount: bigint; collected: boolean }
  | { name: 'SettleSkipped'; arenaId: number; player: Address; sessionId: bigint; reason: number }
  | { name: 'LootBurned'; arenaId: number; sweepId: bigint; amount: bigint };

export interface TxReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  /** Arena events emitted by the arena contract in this transaction. */
  events: ArenaEvent[];
}

export interface JoinedLog {
  arenaId: number;
  player: Address;
  sessionId: bigint;
  entryFee: bigint;
  blockNumber: bigint;
}

export interface TransferLog {
  from: Address;
  to: Address;
  tokenId: bigint;
  blockNumber: bigint;
}

/**
 * Everything the server reads from and sends to the chain. `viemEvmClient` is the real one; tests
 * inject a fake (a TypeScript model of the contracts).
 */
export interface EvmClient {
  /** The server key's address (EIP-55). */
  readonly address: Address;
  getChainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** Code at `address` vs the bundled artifact of `kind`. */
  codeCheck(address: Address, kind: ContractKindCode): Promise<CodeCheck>;
  /** Whether there is any code at `address`. */
  hasCode(address: Address): Promise<boolean>;
  arenaConfig(arena: Address): Promise<ArenaConfig>;
  arenas(arena: Address): Promise<ArenaInfo[]>;
  arena(arena: Address, id: number): Promise<ArenaInfo>;
  session(arena: Address, arenaId: number, player: Address): Promise<SessionInfo>;
  /** Gas-token balance (wei). */
  balance(address: Address): Promise<bigint>;
  /** `Joined` events of an arena contract in `[from, to]` (the caller chunks). */
  joinedLogs(arena: Address, from: bigint, to: bigint): Promise<JoinedLog[]>;
  /** NFT `Transfer` events in `[from, to]` (the caller chunks). */
  transferLogs(nft: Address, from: bigint, to: bigint): Promise<TransferLog[]>;
  /** Block a contract was deployed in (binary search on `eth_getCode`); null when the RPC cannot tell. */
  deployBlock(address: Address): Promise<bigint | null>;
  /** Block of a mined transaction; null when unknown. */
  txBlock(hash: Hash): Promise<bigint | null>;
  /** Hash of block `n`; null when it is not mined yet (the NFT reveal's entropy). */
  blockHash(n: bigint): Promise<Hash | null>;
  /** The latest block's number and timestamp (Unix seconds): the chain's clock. */
  latestBlock?(): Promise<{ number: bigint; timestamp: number }>;
  /** Simulates (throws the decoded revert) then sends `call` signed by the server key. */
  send(call: ContractCall): Promise<Hash>;
  /**
   * One look at a receipt: status, its ERC-20 `Transfer` logs and the `Paid` events of `arena` (power-up payments);
   * null when it is not mined. Throws on RPC errors.
   */
  tokenReceipt?(
    hash: Hash,
    arena?: Address | null,
  ): Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    timestamp?: number;
    transfers: { token: Address; from: Address; to: Address; value: bigint }[];
    payments?: { contract: Address; payer: Address; ref: Hex; amount: bigint }[];
  } | null>;
  /** The receipt of `hash`; null when it is not mined within `timeoutMs`. */
  receipt(hash: Hash, arena: Address | null, timeoutMs: number): Promise<TxReceipt | null>;
  /** On-chain signature check (EOA, ERC-1271 and ERC-6492). */
  verifyMessage(address: Address, message: string, signature: Hex): Promise<boolean>;
  /** `owner()` of an Ownable contract. */
  ownerOf(contract: Address): Promise<Address>;
  mintState(nft: Address): Promise<MintState>;
  nftBalance(nft: Address, owner: Address): Promise<bigint>;
  /** `royaltyInfo(1, 10000)`: receiver and basis points; null when unreadable. */
  royalty(nft: Address): Promise<{ receiver: Address; bps: number } | null>;
  /** ERC-20 `balanceOf`. */
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  /** ERC-20 `allowance`. */
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  /** The TestToken's faucet settings. */
  testTokenFaucet(token: Address): Promise<TestTokenFaucetConfig>;
  /** `CoinnibalArena.isHolder(who)`: holds the arena's holder NFT. */
  isArenaHolder(arena: Address, who: Address): Promise<boolean>;
}

/** What reading an NFT's holders needs (also on a chain the server does not run on: `TESTNET_RPC_URL`). */
export type HolderReader = Pick<EvmClient, 'getChainId' | 'blockNumber' | 'transferLogs' | 'deployBlock' | 'txBlock' | 'nftBalance'>;

/** ERC-20 `Transfer` (three topics: an NFT's has an indexed token id and does not decode as this). */
const erc20TransferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

const ownableAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

const RPC_TIMEOUT_MS = 20_000;
/** Multicall3 (same address on every chain that has it; `hasMulticall3` checks the server's chain). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
/** Outer timeout of one viem request: it includes the wait for the RPC budget and the 429 retries. */
const TRANSPORT_TIMEOUT_MS = 120_000;
/** Receipt polling: first look after this long, then slower (one `eth_getTransactionReceipt` per look). */
const RECEIPT_FIRST_POLL_MS = 500;
const RECEIPT_MAX_POLL_MS = 3_000;

/** One RPC URL, or several in order of preference (`EVM_RPC_URLS`: a provider first, the public RPC as fallback). */
export type RpcUrls = string | readonly string[];

const urlList = (rpc: RpcUrls): string[] => (typeof rpc === 'string' ? [rpc] : [...rpc]);

/**
 * viem transport on `rpc` through the process-wide RPC budget (`rpc-budget.ts`), one budget per URL: rate-limited,
 * prioritised, 429-aware. With several URLs it is a viem `fallback` in the given order: a URL that fails or keeps
 * answering 429 hands the call to the next one (after two tries instead of the full backoff), and the first URL is
 * tried first again for every new call. `batch`: JSON-RPC batching (reads only; the server key sends one request each).
 * A transaction resent through the next URL is the same signed transaction (same hash and nonce), never a second one.
 */
export function budgetTransport(rpc: RpcUrls, opts: { batch?: boolean } = {}): Transport {
  const urls = urlList(rpc);
  if (urls.length === 0) throw new TypeError('no RPC URL');
  for (const u of urls) if (!/^https?:\/\//i.test(u)) throw new TypeError(`RPC URL must start with http:// or https://, got ${JSON.stringify(u)}`);
  const one = (u: string, maxAttempts?: number) =>
    http(u, {
      fetchFn: rpcBudgetFor(u).fetchFn(fetch, { maxAttempts }),
      // 429s are retried inside the budget (with its backoff); viem must not multiply them
      retryCount: 0,
      timeout: TRANSPORT_TIMEOUT_MS,
      batch: opts.batch ? { batchSize: 8, wait: 10 } : false,
    });
  if (urls.length === 1) return one(urls[0]);
  return fallback(
    urls.map((u) => one(u, 2)),
    { rank: false, retryCount: 1, retryDelay: 250 },
  );
}

/**
 * How concurrent `eth_call`s are merged: `multicall3` (the chain has Multicall3 at its usual address),
 * `deployless` (no Multicall3: viem's counterfactual Multicall3, one `eth_call` carrying the aggregator's code), or
 * `none` (plain calls, merged into JSON-RPC batches of 8 only).
 */
export type MulticallMode = 'multicall3' | 'deployless' | 'none';

/** A public client through the budget; `multicall` merges concurrent `eth_call`s into one Multicall3 call. */
function budgetPublicClient(rpc: RpcUrls, chain: Chain | undefined, opts: { pollingInterval?: number; multicall?: boolean | MulticallMode } = {}): PublicClient {
  const mode: MulticallMode = opts.multicall === true ? 'multicall3' : opts.multicall === false || opts.multicall === undefined ? 'none' : opts.multicall;
  const withMc = mode === 'multicall3' && chain ? { ...chain, contracts: { ...(chain.contracts ?? {}), multicall3: { address: MULTICALL3 } } } : chain;
  return createPublicClient({
    chain: withMc,
    transport: budgetTransport(rpc, { batch: true }),
    ...(opts.pollingInterval ? { pollingInterval: opts.pollingInterval } : {}),
    ...(mode !== 'none' && chain ? { batch: { multicall: { wait: 10, batchSize: 4_096, ...(mode === 'deployless' ? { deployless: true } : {}) } } } : {}),
  }) as PublicClient;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** Decodes the arena's events of a receipt (logs of other contracts are ignored). */
export function decodeArenaEvents(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[], arena: Address | null): ArenaEvent[] {
  const own = arena ? logs.filter((l) => l.address.toLowerCase() === arena.toLowerCase()) : [];
  const parsed = parseEventLogs({ abi: coinnibalArenaAbi, logs: own as never, strict: false });
  const out: ArenaEvent[] = [];
  for (const e of parsed) {
    const a = e.args as Record<string, unknown>;
    if (e.eventName === 'Settled') {
      out.push({
        name: 'Settled',
        arenaId: Number(a.arenaId),
        player: getAddress(a.player as string),
        sessionId: a.sessionId as bigint,
        payout: a.payout as bigint,
        net: a.net as bigint,
        burned: a.burned as bigint,
        toVault: a.toVault as bigint,
        collected: a.collected as boolean,
      });
    } else if (e.eventName === 'Cancelled') {
      out.push({
        name: 'Cancelled',
        arenaId: Number(a.arenaId),
        player: getAddress(a.player as string),
        sessionId: a.sessionId as bigint,
        amount: a.amount as bigint,
        collected: a.collected as boolean,
      });
    } else if (e.eventName === 'SettleSkipped') {
      out.push({ name: 'SettleSkipped', arenaId: Number(a.arenaId), player: getAddress(a.player as string), sessionId: a.sessionId as bigint, reason: Number(a.reason) });
    } else if (e.eventName === 'LootBurned') {
      out.push({ name: 'LootBurned', arenaId: Number(a.arenaId), sweepId: a.sweepId as bigint, amount: a.amount as bigint });
    }
  }
  return out;
}

/** The read side shared by the server client and the holder reader. */
function viemReads(publicClient: PublicClient): HolderReader {
  return {
    getChainId: () => publicClient.getChainId(),
    blockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
    transferLogs: async (nft, from, to) => {
      const logs = await publicClient.getContractEvents({ address: nft, abi: coinnibalNFTAbi, eventName: 'Transfer', fromBlock: from, toBlock: to, strict: true });
      return logs.map((l) => ({ from: getAddress(l.args.from), to: getAddress(l.args.to), tokenId: l.args.tokenId, blockNumber: l.blockNumber }));
    },
    deployBlock: async (address) => {
      try {
        const latest = await publicClient.getBlockNumber();
        const has = async (b: bigint) => {
          const code = await publicClient.getCode({ address, blockNumber: b });
          return !!code && code !== '0x';
        };
        if (!(await has(latest))) return null;
        let lo = 0n;
        let hi = latest;
        while (lo < hi) {
          const mid = (lo + hi) / 2n;
          if (await has(mid)) hi = mid;
          else lo = mid + 1n;
        }
        return lo;
      } catch {
        return null; // a pruned node cannot read old state
      }
    },
    txBlock: async (hash) => {
      try {
        return (await publicClient.getTransactionReceipt({ hash })).blockNumber;
      } catch {
        return null;
      }
    },
    nftBalance: (nft, owner) => getNftBalance(publicClient, nft, owner),
  };
}

/** A read-only client for an NFT's holders on any RPC (the testnet emblem import). */
export function viemHolderReader(rpcUrl: string): HolderReader {
  return viemReads(budgetPublicClient(rpcUrl, undefined, { pollingInterval: 1_000 }));
}

/** Runs async jobs one at a time (the server key's sends: nonces come from the pending count). */
function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** `EvmClient` over viem: a public client on `rpcUrl` and a wallet client with the server key. */
export function viemEvmClient(
  rpc: RpcUrls,
  account: PrivateKeyAccount,
  opts: { chainId: number; overrides?: ChainOverrides; pollingInterval?: number; multicall?: boolean | MulticallMode },
): EvmClient {
  const chain = toViemChain(chainInfo(opts.chainId, { ...opts.overrides, rpcUrl: urlList(rpc)[0] }));
  const pollingInterval = opts.pollingInterval ?? 2_000;
  const publicClient: PublicClient = budgetPublicClient(rpc, chain, { pollingInterval, multicall: opts.multicall });
  const wallet: WalletClient = createWalletClient({ account, chain, transport: budgetTransport(rpc), pollingInterval });
  // one server-key transaction at a time (the settlement worker and the price keeper share the key)
  const queue = serial();
  return {
    ...viemReads(publicClient),
    address: account.address,
    blockHash: async (n) => {
      try {
        return (await publicClient.getBlock({ blockNumber: n })).hash;
      } catch (err) {
        if ((err as Error)?.name === 'BlockNotFoundError') return null;
        throw err;
      }
    },
    latestBlock: async () => {
      const b = await publicClient.getBlock({ blockTag: 'latest' });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    codeCheck: (address, kind) => checkDeployedCode(publicClient, address, kind),
    hasCode: async (address) => {
      const code = await publicClient.getCode({ address });
      return !!code && code !== '0x';
    },
    arenaConfig: (arena) => getArenaConfig(publicClient, arena),
    arenas: (arena) => listArenas(publicClient, arena),
    arena: (arena, id) => getArena(publicClient, arena, id),
    session: (arena, arenaId, player) => getSession(publicClient, arena, arenaId, player),
    balance: (address) => publicClient.getBalance({ address }),
    joinedLogs: async (arena, from, to) => {
      const logs = await publicClient.getContractEvents({ address: arena, abi: coinnibalArenaAbi, eventName: 'Joined', fromBlock: from, toBlock: to, strict: true });
      return logs.map((l) => ({
        arenaId: Number(l.args.arenaId),
        player: getAddress(l.args.player),
        sessionId: l.args.sessionId,
        entryFee: l.args.entryFee,
        blockNumber: l.blockNumber,
      }));
    },
    send: (call) =>
      queue(async () => {
        await simulateCall(publicClient, call, account);
        return sendCall(wallet, call, { account, chain });
      }),
    tokenReceipt: async (hash, arena) => {
      let r;
      try {
        r = await publicClient.getTransactionReceipt({ hash });
      } catch (err) {
        if ((err as Error)?.name === 'TransactionReceiptNotFoundError') return null;
        throw err;
      }
      const logs = parseEventLogs({ abi: erc20TransferAbi, eventName: 'Transfer', logs: r.logs, strict: true });
      const own = arena ? r.logs.filter((l) => l.address.toLowerCase() === arena.toLowerCase()) : [];
      const paid = parseEventLogs({ abi: coinnibalArenaAbi, eventName: 'Paid', logs: own, strict: true });
      // the block time: a purchase is credited only for a recent payment (see `SHOP_PAYMENT_MAX_AGE_MS`)
      const block = await publicClient.getBlock({ blockNumber: r.blockNumber });
      return {
        status: r.status,
        blockNumber: r.blockNumber,
        timestamp: Number(block.timestamp) * 1000,
        transfers: logs.map((l) => ({ token: getAddress(l.address), from: getAddress(l.args.from), to: getAddress(l.args.to), value: l.args.value })),
        payments: paid.map((l) => ({ contract: getAddress(l.address), payer: getAddress(l.args.payer), ref: l.args.ref, amount: l.args.amount })),
      };
    },
    // one `eth_getTransactionReceipt` per look, slowing down (viem's waiter also polls the block number)
    receipt: async (hash, arena, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let delay = RECEIPT_FIRST_POLL_MS;
      for (;;) {
        await sleepMs(Math.max(0, Math.min(delay, deadline - Date.now())));
        try {
          const r = await publicClient.getTransactionReceipt({ hash });
          return { status: r.status, blockNumber: r.blockNumber, events: decodeArenaEvents(r.logs, arena) };
        } catch {
          /* not mined yet (TransactionReceiptNotFoundError), or the RPC is busy: look again */
        }
        if (Date.now() >= deadline) return null;
        delay = Math.min(RECEIPT_MAX_POLL_MS, Math.round(delay * 1.6));
      }
    },
    verifyMessage: async (address, message, signature) => {
      try {
        return await publicClient.verifyMessage({ address, message, signature });
      } catch {
        return false;
      }
    },
    ownerOf: (contract) => publicClient.readContract({ address: contract, abi: ownableAbi, functionName: 'owner' }).then(getAddress),
    mintState: (nft) => getMintState(publicClient, nft),
    royalty: async (nft) => {
      try {
        const [receiver, amount] = await publicClient.readContract({ address: nft, abi: coinnibalNFTAbi, functionName: 'royaltyInfo', args: [1n, 10_000n] });
        return { receiver: getAddress(receiver), bps: Number(amount) };
      } catch {
        return null;
      }
    },
    tokenBalance: (token, owner) => getTokenBalance(publicClient, token, owner),
    allowance: (token, owner, spender) => getAllowance(publicClient, token, owner, spender),
    testTokenFaucet: (token) => getTestTokenFaucet(publicClient, token),
    isArenaHolder: (arena, who) => isArenaHolder(publicClient, arena, who),
  };
}

/** Reads `eth_chainId` of an RPC (with a timeout). */
export async function readChainId(rpcUrl: string): Promise<number> {
  const client = budgetPublicClient(rpcUrl, undefined);
  return withTimeout(client.getChainId(), RPC_TIMEOUT_MS, 'eth_chainId');
}

/** Whether Multicall3 is deployed on the RPC's chain (false on errors: plain calls then). */
export async function hasMulticall3(rpcUrl: string): Promise<boolean> {
  try {
    const code = await withTimeout(budgetPublicClient(rpcUrl, undefined).getCode({ address: MULTICALL3 }), RPC_TIMEOUT_MS, 'eth_getCode');
    return !!code && code !== '0x';
  } catch {
    return false;
  }
}

const balanceOfAbi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const;

/**
 * How this RPC can merge reads (`MulticallMode`): Multicall3 when the chain has it; else a deployless Multicall3
 * (an `eth_call` without `to` carrying the aggregator's code) when the RPC runs one (probed with a throwaway call);
 * else none. A bell of 200 tickets then costs a handful of `eth_call`s instead of one per ticket.
 */
export async function multicallMode(rpc: RpcUrls, chainId: number): Promise<MulticallMode> {
  const first = urlList(rpc)[0];
  if (await hasMulticall3(first)) return 'multicall3';
  try {
    const chain = toViemChain(chainInfo(chainId, { rpcUrl: first }));
    const probe = budgetPublicClient(first, chain, { multicall: 'deployless' });
    // two reads of an address with no code: both "fail" inside the aggregator, the eth_call itself must succeed
    await withTimeout(
      probe.multicall({ deployless: true, allowFailure: true, contracts: [0, 1].map(() => ({ address: zeroAddress, abi: balanceOfAbi, functionName: 'balanceOf', args: [zeroAddress] }) as const) }),
      RPC_TIMEOUT_MS,
      'deployless multicall probe',
    );
    return 'deployless';
  } catch {
    return 'none';
  }
}

/** EOA signature check without any RPC (personal_sign / EIP-191). */
export async function verifyEoa(address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    return await verifyEoaMessage({ address, message, signature });
  } catch {
    return false;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
