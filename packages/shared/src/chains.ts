/**
 * Robinhood Chain: the only chain Elymum runs on. Two networks of it, switched by configuration and nothing else:
 * the testnet now, the mainnet later. The server picks one with `CHAIN_ID` (46630 or 4663; default the testnet) and
 * checks that `EVM_RPC_URL` really serves it; the web names it with `VITE_CHAIN_ID` until the server's
 * `/api/config` answers (the server's network wins). The gas token is ETH on both.
 *
 * `localnet` (31337) is a local Hardhat node standing in for Robinhood Chain Testnet in development and tests
 * only (`pnpm localnet`); it is a testnet for every rule here.
 *
 * Sources and the status of every value: docs/RESEARCH.md. Plain data, no dependencies.
 */

export type NetworkKey = 'testnet' | 'mainnet' | 'localnet';

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

/** Robinhood Chain's gas token (an Arbitrum Orbit L2 paying gas in ETH). */
export const GAS_SYMBOL = 'ETH';
const ETH: Readonly<NativeCurrency> = Object.freeze({ name: 'Ether', symbol: GAS_SYMBOL, decimals: 18 });

export interface NetworkDef {
  key: NetworkKey;
  id: number;
  /** Shown to players ("Robinhood Chain Testnet"). */
  name: string;
  testnet: boolean;
  /** Public, rate-limited RPC (fine for wallets and light server use; production should use a provider). */
  rpcUrl: string;
  /** Blockscout explorer base URL (no trailing slash); null on the local node. */
  explorerUrl: string | null;
  /** Gas faucet (testnet; unconfirmed, see docs/RESEARCH.md). */
  faucetUrl: string | null;
  /** Where players bring ETH from (the canonical Arbitrum bridge). */
  bridgeUrl: string | null;
  /** Typical block time, ms (sizes polling). */
  blockTimeMs: number;
  /** Blocks per `eth_getLogs` request to start with (the server adapts it). */
  logChunkBlocks: number;
}

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ROBINHOOD_CHAIN_ID = 4663;
export const LOCALNET_CHAIN_ID = 31337;

/** The network used when neither `CHAIN_ID` (server) nor `VITE_CHAIN_ID` (web) is set. */
export const DEFAULT_CHAIN_ID = ROBINHOOD_TESTNET_CHAIN_ID;

const BRIDGE = 'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum';

export const NETWORKS: Readonly<Record<NetworkKey, Readonly<NetworkDef>>> = Object.freeze({
  testnet: {
    key: 'testnet',
    id: ROBINHOOD_TESTNET_CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    testnet: true,
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
    bridgeUrl: null,
    blockTimeMs: 100,
    logChunkBlocks: 50_000,
  },
  mainnet: {
    key: 'mainnet',
    id: ROBINHOOD_CHAIN_ID,
    name: 'Robinhood Chain',
    testnet: false,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    faucetUrl: null,
    bridgeUrl: BRIDGE,
    blockTimeMs: 100,
    logChunkBlocks: 50_000,
  },
  localnet: {
    key: 'localnet',
    id: LOCALNET_CHAIN_ID,
    name: 'Localnet',
    testnet: true,
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: null,
    faucetUrl: null,
    bridgeUrl: null,
    blockTimeMs: 1000,
    logChunkBlocks: 10_000,
  },
});

/** A network resolved with the server's overrides (`PUBLIC_RPC_URL`, `EXPLORER_URL`, `GAS_FAUCET_URL`). */
export interface ChainInfo {
  key: NetworkKey;
  id: number;
  name: string;
  rpcUrl: string | null;
  explorerUrl: string | null;
  faucetUrl: string | null;
  bridgeUrl: string | null;
  nativeCurrency: NativeCurrency;
  testnet: boolean;
  blockTimeMs: number;
  logChunkBlocks: number;
}

/** `undefined` keeps the network's value, `null` clears it. */
export interface ChainOverrides {
  rpcUrl?: string | null;
  explorerUrl?: string | null;
  faucetUrl?: string | null;
}

export function isChainId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

/** The Robinhood Chain network (or the local node) of a chain id; null for any other chain. */
export function networkOf(id: number | null | undefined): Readonly<NetworkDef> | null {
  if (id == null) return null;
  return Object.values(NETWORKS).find((n) => n.id === id) ?? null;
}

/** Elymum runs on this chain id: Robinhood Chain Testnet, Robinhood Chain, or the local development node. */
export const isSupportedChainId = (id: unknown): id is number => isChainId(id) && networkOf(id) !== null;

/** The testnet or the local node. Any other id (the mainnet, or a chain Elymum does not run on) is not. */
export function isTestChainId(id: number | null | undefined): boolean {
  return networkOf(id)?.testnet === true;
}

/** The error every wrong chain id gets: Elymum runs on Robinhood Chain only. */
export function unsupportedChainMessage(id: unknown): string {
  return `chain ${String(id)} is not Robinhood Chain: Elymum runs on Robinhood Chain Testnet (${ROBINHOOD_TESTNET_CHAIN_ID}) or Robinhood Chain (${ROBINHOOD_CHAIN_ID}) only (${LOCALNET_CHAIN_ID}: local development node)`;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');
const blankToNull = (s: string | null | undefined): string | null => (s == null || s.trim() === '' ? null : s.trim());
const pick = (o: string | null | undefined, d: string | null): string | null => (o !== undefined ? blankToNull(o) : d);

/** The network of `chainId` with the server's overrides applied. Throws a RangeError for any other chain. */
export function chainInfo(chainId: number, overrides: ChainOverrides = {}): ChainInfo {
  const def = isChainId(chainId) ? networkOf(chainId) : null;
  if (!def) throw new RangeError(unsupportedChainMessage(chainId));
  const explorer = pick(overrides.explorerUrl, def.explorerUrl);
  const rpc = pick(overrides.rpcUrl, def.rpcUrl);
  return {
    key: def.key,
    id: def.id,
    name: def.name,
    rpcUrl: rpc === null ? null : trimSlash(rpc),
    explorerUrl: explorer === null ? null : trimSlash(explorer),
    faucetUrl: pick(overrides.faucetUrl, def.faucetUrl),
    bridgeUrl: def.bridgeUrl,
    nativeCurrency: { ...ETH },
    testnet: def.testnet,
    blockTimeMs: def.blockTimeMs,
    logChunkBlocks: def.logChunkBlocks,
  };
}

/**
 * The chain id a deployment is configured for: `raw` (`CHAIN_ID` / `VITE_CHAIN_ID`) when it is a Robinhood Chain
 * network (or the local node), else `fallback` (default `DEFAULT_CHAIN_ID`, the testnet).
 */
export function configuredChainId(raw: string | number | null | undefined, fallback = DEFAULT_CHAIN_ID): number {
  const n = typeof raw === 'number' ? raw : raw == null || String(raw).trim() === '' ? NaN : Number(String(raw).trim());
  return isSupportedChainId(n) ? n : fallback;
}

/** `0x`-prefixed hex chain id, as `wallet_switchEthereumChain` wants it. */
export function toHexChainId(chainId: number): `0x${string}` {
  if (!isChainId(chainId)) throw new RangeError(`invalid chain id ${chainId}`);
  return `0x${chainId.toString(16)}`;
}

/** EIP-3085 `wallet_addEthereumChain` parameters (null when there is no RPC to hand the wallet). */
export function addEthereumChainParams(info: ChainInfo): {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: NativeCurrency;
  rpcUrls: string[];
  blockExplorerUrls?: string[];
} | null {
  if (!info.rpcUrl) return null;
  return {
    chainId: toHexChainId(info.id),
    chainName: info.name,
    nativeCurrency: { ...info.nativeCurrency },
    rpcUrls: [info.rpcUrl],
    ...(info.explorerUrl ? { blockExplorerUrls: [info.explorerUrl] } : {}),
  };
}

/** `${explorerUrl}/tx/<hash>`, or null without an explorer. */
export function explorerTxUrl(explorerUrl: string | null | undefined, txHash: string): string | null {
  return explorerUrl ? `${trimSlash(explorerUrl)}/tx/${txHash}` : null;
}

/** `${explorerUrl}/address/<address>`, or null without an explorer. */
export function explorerAddressUrl(explorerUrl: string | null | undefined, address: string): string | null {
  return explorerUrl ? `${trimSlash(explorerUrl)}/address/${address}` : null;
}

/** Decimals of the gas token (wei). */
export const GAS_DECIMALS = 18;

/* ------------------------------------------------------------------ */
/* The active network (display only)                                    */
/* ------------------------------------------------------------------ */

let active: ChainInfo = chainInfo(DEFAULT_CHAIN_ID);

/**
 * The network this process names in its copy (testnet or mainnet): the server sets it once its chain is known,
 * the web from `VITE_CHAIN_ID` and then from the server's `/api/config`. Display only: nothing that moves money
 * reads it.
 */
export function setActiveChain(info: ChainInfo): void {
  active = { ...info, nativeCurrency: { ...info.nativeCurrency } };
}

/** The active network (see `setActiveChain`; `DEFAULT_CHAIN_ID` until it is set). */
export function activeChain(): ChainInfo {
  return active;
}
