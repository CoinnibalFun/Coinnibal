/**
 * The chain registry: the ONLY place a chain Elymum can run on is described. Everything chain-specific (the
 * name shown to players, the gas token's symbol, the RPC, the explorer, the faucet, the bridge, the block time,
 * the gas token's price feed) comes from here; nothing else in the code base names a chain or a gas token.
 *
 * The active chain is configuration: the server picks it with `CHAIN_ID` (and checks that `EVM_RPC_URL` really
 * serves that id), the web with `VITE_CHAIN_ID` (a build-time default until the server's `/api/config` answers;
 * the server's chain wins). `DEFAULT_CHAIN_ID` is used when neither is set.
 *
 * Sources and the status of every value: docs/RESEARCH.md. A value marked `unconfirmed` comes from a reputable
 * third party but not from the chain's own documentation. Plain data, no dependencies.
 */

export type ChainKey = 'robinhood-testnet' | 'robinhood' | 'elysium-testnet' | 'localnet';

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainDef {
  key: ChainKey;
  id: number;
  /** Shown to players ("Robinhood Chain Testnet"). */
  name: string;
  /** Short name for tight copy ("Robinhood Chain"). */
  shortName: string;
  testnet: boolean;
  /** The gas token. */
  nativeCurrency: Readonly<NativeCurrency>;
  /** Public, rate-limited RPC (fine for wallets and light server use; production should use a provider). */
  rpcUrl: string | null;
  /** Blockscout-style explorer base URL (no trailing slash). */
  explorerUrl: string | null;
  /** Faucet for the gas token (testnets). */
  faucetUrl: string | null;
  /** Where players bring funds from (the canonical bridge). */
  bridgeUrl: string | null;
  /** Typical block time, ms (sizes polling and `eth_getLogs` windows). */
  blockTimeMs: number;
  /** Blocks per `eth_getLogs` request to start with (the server adapts it). */
  logChunkBlocks: number;
  /** The gas token's coin on Hyperliquid's `allMids` feed (USD price for the $-pinned NFT mint); null: none. */
  priceCoin: string | null;
  /** `confirmed`: every value above is in the chain's own docs; `unconfirmed`: some are not (see `notes`). */
  status: 'confirmed' | 'unconfirmed';
  notes?: string;
}

const ETH: Readonly<NativeCurrency> = Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 });
const HYPE_GAS: Readonly<NativeCurrency> = Object.freeze({ name: 'HYPE', symbol: 'HYPE', decimals: 18 });

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ROBINHOOD_CHAIN_ID = 4663;
export const ELYSIUM_TESTNET_CHAIN_ID = 99801;
export const LOCALNET_CHAIN_ID = 31337;

/** The chain used when neither `CHAIN_ID` (server) nor `VITE_CHAIN_ID` (web) is set. */
export const DEFAULT_CHAIN_ID = ROBINHOOD_TESTNET_CHAIN_ID;

export const CHAINS: readonly ChainDef[] = Object.freeze([
  {
    key: 'robinhood-testnet',
    id: ROBINHOOD_TESTNET_CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    shortName: 'Robinhood Chain',
    testnet: true,
    nativeCurrency: ETH,
    rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
    bridgeUrl: 'https://portal.arbitrum.io/bridge',
    blockTimeMs: 100,
    logChunkBlocks: 50_000,
    priceCoin: 'ETH',
    status: 'unconfirmed',
    notes: 'Faucet URL from the Arbitrum launch post and BitGo docs (not on docs.robinhood.com); ~100 ms blocks per third-party RPC providers.',
  },
  {
    key: 'robinhood',
    id: ROBINHOOD_CHAIN_ID,
    name: 'Robinhood Chain',
    shortName: 'Robinhood Chain',
    testnet: false,
    nativeCurrency: ETH,
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    faucetUrl: null,
    bridgeUrl: 'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum',
    blockTimeMs: 100,
    logChunkBlocks: 50_000,
    priceCoin: 'ETH',
    status: 'unconfirmed',
    notes: 'Chain id, RPC, explorer and bridge are in docs.robinhood.com; the ~100 ms block time is from third-party RPC providers.',
  },
  {
    key: 'elysium-testnet',
    id: ELYSIUM_TESTNET_CHAIN_ID,
    name: 'Elysium Testnet',
    shortName: 'Elysium',
    testnet: true,
    nativeCurrency: HYPE_GAS,
    rpcUrl: 'https://testnet-rpc.elysium.kinetiq.xyz',
    explorerUrl: 'https://explorer-elysium-testnet.t.conduit.xyz',
    faucetUrl: 'https://elysium.kinetiq.xyz/testnet-faucet',
    bridgeUrl: null,
    blockTimeMs: 1000,
    logChunkBlocks: 50_000,
    priceCoin: 'HYPE',
    status: 'confirmed',
  },
  {
    key: 'localnet',
    id: LOCALNET_CHAIN_ID,
    name: 'Localnet',
    shortName: 'Localnet',
    testnet: true,
    nativeCurrency: ETH,
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: null,
    faucetUrl: null,
    bridgeUrl: null,
    blockTimeMs: 1000,
    logChunkBlocks: 10_000,
    priceCoin: 'ETH',
    status: 'confirmed',
  },
] as const satisfies readonly ChainDef[]);

/** A chain resolved for one chain id (a registry entry, or a generic one for an id the registry does not know). */
export interface ChainInfo {
  /** null: not in the registry (named and configured by the server's environment). */
  key: ChainKey | null;
  id: number;
  name: string;
  shortName: string;
  rpcUrl: string | null;
  explorerUrl: string | null;
  faucetUrl: string | null;
  bridgeUrl: string | null;
  nativeCurrency: NativeCurrency;
  testnet: boolean;
  blockTimeMs: number;
  logChunkBlocks: number;
  priceCoin: string | null;
}

/**
 * Values the server's environment sets (`CHAIN_NAME`, `PUBLIC_RPC_URL`, `EXPLORER_URL`, `GAS_SYMBOL`,
 * `GAS_FAUCET_URL`); `undefined` keeps the registry's, `null` clears it.
 */
export interface ChainOverrides {
  name?: string | null;
  rpcUrl?: string | null;
  explorerUrl?: string | null;
  gasSymbol?: string | null;
  faucetUrl?: string | null;
}

export function isChainId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
}

export function chainByKey(key: ChainKey): ChainDef {
  const def = CHAINS.find((c) => c.key === key);
  if (!def) throw new RangeError(`unknown chain key ${key}`);
  return def;
}

/** The registry entry of a chain id, or null. */
export function chainById(id: number): ChainDef | null {
  return CHAINS.find((c) => c.id === id) ?? null;
}

/** A testnet (or the localnet). An id the registry does not know counts as a mainnet: the careful default. */
export function isTestChainId(id: number | null | undefined): boolean {
  return id != null && chainById(id)?.testnet === true;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');
const blankToNull = (s: string | null | undefined): string | null => (s == null || s.trim() === '' ? null : s.trim());
const pick = (o: string | null | undefined, d: string | null): string | null => (o !== undefined ? blankToNull(o) : d);

/** Everything known about `chainId`, with the server's overrides applied. Throws on a malformed id. */
export function chainInfo(chainId: number, overrides: ChainOverrides = {}): ChainInfo {
  if (!isChainId(chainId)) throw new RangeError(`invalid chain id ${chainId}`);
  const def = chainById(chainId);
  const name = blankToNull(overrides.name) ?? def?.name ?? `Chain ${chainId}`;
  const symbol = blankToNull(overrides.gasSymbol) ?? def?.nativeCurrency.symbol ?? 'ETH';
  const explorer = pick(overrides.explorerUrl, def?.explorerUrl ?? null);
  const rpc = pick(overrides.rpcUrl, def?.rpcUrl ?? null);
  const faucet = pick(overrides.faucetUrl, def?.faucetUrl ?? null);
  return {
    key: def?.key ?? null,
    id: chainId,
    name,
    shortName: blankToNull(overrides.name) ?? def?.shortName ?? name,
    rpcUrl: rpc === null ? null : trimSlash(rpc),
    explorerUrl: explorer === null ? null : trimSlash(explorer),
    faucetUrl: faucet,
    bridgeUrl: def?.bridgeUrl ?? null,
    nativeCurrency: { name: symbol === def?.nativeCurrency.symbol ? def.nativeCurrency.name : symbol, symbol, decimals: 18 },
    testnet: def?.testnet ?? false,
    blockTimeMs: def?.blockTimeMs ?? 1000,
    logChunkBlocks: def?.logChunkBlocks ?? 50_000,
    priceCoin: blankToNull(overrides.gasSymbol) ? symbol : (def?.priceCoin ?? null),
  };
}

/**
 * The chain id a deployment is configured for: `raw` (`CHAIN_ID` / `VITE_CHAIN_ID`) when it is a valid id, else
 * `DEFAULT_CHAIN_ID`. `fallback` replaces the default (tests).
 */
export function configuredChainId(raw: string | number | null | undefined, fallback = DEFAULT_CHAIN_ID): number {
  const n = typeof raw === 'number' ? raw : raw == null || String(raw).trim() === '' ? NaN : Number(String(raw).trim());
  return isChainId(n) ? n : fallback;
}

/** `0x`-prefixed hex chain id, as `wallet_switchEthereumChain` wants it. */
export function toHexChainId(chainId: number): `0x${string}` {
  if (!isChainId(chainId)) throw new RangeError(`invalid chain id ${chainId}`);
  return `0x${chainId.toString(16)}`;
}

/** EIP-3085 `wallet_addEthereumChain` parameters for a chain (null when it has no RPC to hand the wallet). */
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

/** Decimals of every EVM gas token (wei). */
export const GAS_DECIMALS = 18;

/* ------------------------------------------------------------------ */
/* The active chain (display only)                                      */
/* ------------------------------------------------------------------ */

let active: ChainInfo = chainInfo(DEFAULT_CHAIN_ID);

/**
 * The chain this process shows amounts and names for: the server sets it once its chain is known, the web from
 * `VITE_CHAIN_ID` and then from the server's `/api/config`. Display only: nothing that moves money reads it.
 */
export function setActiveChain(info: ChainInfo): void {
  active = { ...info, nativeCurrency: { ...info.nativeCurrency } };
}

/** The active chain (see `setActiveChain`; `DEFAULT_CHAIN_ID` until it is set). */
export function activeChain(): ChainInfo {
  return active;
}

/** The active chain's gas token symbol (`ETH` on Robinhood Chain). */
export function gasSymbol(): string {
  return active.nativeCurrency.symbol;
}
