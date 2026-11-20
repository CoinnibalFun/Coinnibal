import type { GasRunway, JoinPermit } from '@coinnibal/shared';
import { activeChain, type ChainInfo, type ChainStatus, type FeeRates } from '@coinnibal/shared';
import type { EvmClient } from './evm-client';

/**
 * Amounts in this module are **ledger units** (see `toLedger` / `fromLedger` in `@coinnibal/sdk`): the game
 * token with at most 6 decimals, a safe JS integer. The EVM gateway converts at the chain boundary only.
 */

/** Journal key of an arena ticket: `<arenaId>:<player lowercase>:<sessionId>` (session ids are global and never reused). */
export function sessionKey(arenaId: number, player: string, sessionId: number | bigint): string {
  return `${arenaId}:${player.toLowerCase()}:${sessionId}`;
}

/** Parts of a session key; null when it is not one. */
export function parseSessionKey(key: string): { arenaId: number; player: string; sessionId: number } | null {
  const m = /^(\d{1,5}):(0x[0-9a-f]{40}):(\d{1,20})$/.exec(key);
  if (!m) return null;
  const sessionId = Number(m[3]);
  return Number.isSafeInteger(sessionId) ? { arenaId: Number(m[1]), player: m[2], sessionId } : null;
}

/**
 * The chain could not be read right now (the RPC is rate-limiting or unreachable). Not an answer:
 * the caller must not conclude "no ticket" or "no arena" from it; it tells the player the network is
 * busy and tries again (`chain_busy`).
 */
export class ChainBusyError extends Error {
  readonly code = 'chain_busy';
  constructor(what: string, cause?: unknown) {
    super(`chain busy: ${what}${cause ? ` (${String((cause as Error)?.message ?? cause).split('\n')[0].slice(0, 200)})` : ''}`);
    this.name = 'ChainBusyError';
  }
}

export interface ChainSession {
  /** Journal key `<arenaId>:<player lowercase>:<sessionId>` (the settlement's key). */
  key: string;
  /** On-chain session id (must be echoed in `settle`). */
  id: number;
  /** Player wallet, EIP-55 checksummed. */
  player: string;
  arenaId: number;
  /** Ticket price, ledger units. */
  entryFee: number;
  /** The ticket's fee rates on profit, fixed at join (absent: unknown, the contract defaults are assumed). */
  rates?: FeeRates;
  /** What the ticket plays with, ledger units (rounded down): the whole entry fee (no entry fee cut). */
  value: number;
  /** Unix seconds. */
  openedAt: number;
  /**
   * Already settled but the token transfer to the player failed; the result is final and
   * `owed` waits for the player to collect it (`refund`). Never playable, never settled again.
   */
  finalized: boolean;
  /** Ledger units the player can collect (finalized sessions; 0 otherwise). */
  owed: number;
}

export interface ChainArena {
  id: number;
  /** Ticket price, ledger units. */
  entryFee: number;
  /** On-chain cap on open sessions. */
  maxSessions: number;
  openSessions: number;
  enabled: boolean;
  /**
   * Ledger units the arena vault can spend (rounded down); null when the gateway has no real vault
   * (dev-fake) or the vault is unknown right now (a stale list served while the RPC refuses the read),
   * which skips the vault-vs-journal guard.
   */
  pot: number | null;
  /** Emblem holders only (on-chain `holdersOnly`; the contract refuses other buyers). Absent: open to all. */
  holdersOnly?: boolean;
}

export interface SettledEvent {
  /** Journal key (`<arenaId>:<player lowercase>:<sessionId>`). */
  key: string;
  /** Player wallet, EIP-55 checksummed. */
  player: string;
  /** Arena of the settled session (absent on journal items written before it existed). */
  arenaId?: number;
  /** The settlement transaction (0x hash). */
  txHash: string;
  /** The ticket's gross value, ledger units (what left the vault). */
  payout: number;
  /** The fee on its profit (burned + to the fee wallet), ledger units. */
  fee?: number;
  /** The burned share of the fee, ledger units. */
  burned?: number;
  /** The fee wallet's share of the fee, ledger units. */
  toVault?: number;
  /** What reached the player (or waits to be collected): `payout - fee`, ledger units. */
  net?: number;
  /** An unplayed ticket was cancelled: `payout` is its full entry fee, no fee. */
  refund?: boolean;
  /** The transfer to the player failed; the session is finalized and the player collects the net payout. */
  collect?: boolean;
  /** A stale cancel of a ticket never seated while its arena was open (`SettlementItem.noShow`): the join permits count it. */
  noShow?: boolean;
}

/** The server key and its gas balance (admins see it in `/api/config` and `/admin`). */
export interface ServerKeyInfo {
  /** EIP-55 address of the server key; null when there is none. */
  address: string | null;
  /** Gas-token balance in wei (decimal string); null when unknown. */
  balanceWei: string | null;
  /** The gas runs low: under the floor (`GAS_FLOOR_ETH`) or under the critical runway (`GasRunway`). */
  low: boolean;
  /** The runway at the trailing spend (absent: not tracked, e.g. the chain is off). */
  gas?: GasRunway;
}

/** An ERC-20 `Transfer` log of a receipt. */
export interface TokenTransfer {
  /** The token contract that emitted the log (EIP-55). */
  token: string;
  from: string;
  to: string;
  /** Raw base units. */
  value: bigint;
}

/** A `Paid` event of the arena contract (a power-up payment, `CoinnibalArena.pay`). */
export interface ArenaPayment {
  /** The arena contract that emitted it (EIP-55). */
  contract: string;
  payer: string;
  /** The payer's order reference (0x, 32 bytes). */
  ref: string;
  /** Raw base units. */
  amount: bigint;
}

/** What a power-up purchase is checked against: a mined transaction's status, its ERC-20 transfers and `Paid` events. */
export interface TokenReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  /** Unix ms of the block (the real chain always reads it; the purchase age check needs it). */
  timestamp?: number;
  transfers: TokenTransfer[];
  /** `Paid` events of the arena contract in this transaction. */
  payments?: ArenaPayment[];
}

/** Everything the rooms need from the chain. `NullChain` is used when it is off. */
export interface ChainGateway {
  /** The server talks to an EVM RPC (`EVM_RPC_URL` reachable). */
  readonly enabled: boolean;
  /**
   * The game token is set on the arena contract (`setToken`). False while no arena is registered or
   * the token is not set: practice only, arena joins answer `token_not_set`.
   */
  readonly tokenReady: boolean;
  /** Arena tickets can be played (chain on, token set and usable, server authorized). */
  readonly stakeEnabled: boolean;
  status(): ChainStatus;
  /**
   * The wallet's session in an arena; null when it has none. Throws `ChainBusyError` when the chain
   * cannot be read (after the RPC budget's retries): that is not "no session".
   */
  getSession(arenaId: number, player: string): Promise<ChainSession | null>;
  /**
   * Whether the server already knows that this wallet holds an open ticket of the arena (the `Joined` log index of the
   * stale sweeper; no RPC call). False is "not known", never "no ticket". Absent: never known.
   */
  knowsOpenTicket?(arenaId: number, player: string): boolean;
  /**
   * Reads new `Joined` logs into that index now, in the background (coalesced, a few seconds apart at most): a join of
   * a wallet it does not know was refused for a full queue, or found a ticket. Absent: the index is the sweeper's only.
   */
  refreshTicketIndex?(): void;
  /**
   * On-chain arenas; cached unless `fresh` (a re-read that bypasses the cache). When the RPC fails the
   * last good list is served (stale); `ChainBusyError` only when no list was ever read.
   */
  listArenas(fresh?: boolean): Promise<ChainArena[]>;
  /** Wake the settlement worker (new journal items). */
  kick(): void;
  /** Keys of sessions currently owned by a room (live): never settled as stale. */
  setLiveSessionProvider(fn: () => Set<string>): void;
  onSettled(fn: (e: SettledEvent) => void): void;
  /**
   * `status()` changed in a way clients must see without reconnecting (the token was set, so
   * `tokenReady` turned true and arenas can attach). Listeners re-read `status()`.
   */
  onStatusChange(fn: () => void): void;
  /** The server key and its gas balance. */
  serverInfo(): ServerKeyInfo;
  /**
   * Verifies a signed message on chain (ERC-1271 / ERC-6492 smart wallets). Absent or false when the
   * chain is off; EOA signatures are checked without it.
   */
  verifyMessage?(address: string, message: string, signature: string): Promise<boolean>;
  /** Whether the address holds code (one `eth_getCode` at low priority): a sign-in's smart-wallet check is worth it. */
  hasCode?(address: string): Promise<boolean>;
  /** The EVM access (the site reads the NFT and checks registered contracts through it); absent or null when off. */
  evm?(): EvmClient | null;
  /** Re-reads the registry and the arena config now (after a registry change). */
  refresh?(): Promise<void>;
  /**
   * The ERC-20 transfers and the arena's `Paid` events of a mined transaction (power-up purchases); null when it
   * is not mined (or unknown). One receipt read at `normal` priority through the RPC budget. Throws
   * `ChainBusyError` when the RPC refuses the read. Absent when the chain is off.
   */
  tokenReceipt?(hash: string): Promise<TokenReceipt | null>;
  /**
   * The nonce the next join permit of `player` must name (CoinnibalArena v4 `joinNonce`). Throws `ChainBusyError`
   * when it cannot be read. Absent when the chain is off.
   */
  joinNonce?(player: string): Promise<bigint>;
  /**
   * A join permit (v4): the server key's EIP-712 signature of `JoinPermit(player, arenaId, nonce, deadline)` in the
   * arena's domain. Throws when the server key is not the arena's server authority. Absent when the chain is off.
   */
  signJoinPermit?(player: string, arenaId: number, nonce: bigint, deadlineS: number): Promise<JoinPermit>;
  /** The arena contract is paused: no ticket can be bought. */
  joinsPaused?(): boolean;
  /**
   * Whether `player` holds an open ticket in `arenaId`, without opening one (the dev fake chain opens a ticket on its
   * first `getSession`). Absent: `getSession` answers it.
   */
  hasOpenTicket?(arenaId: number, player: string): Promise<boolean>;
  /** Unix ms of each no-show of `player` since `since`: a ticket cancelled unseated while its arena was open. */
  noShowsSince?(player: string, since: number): number[];
  /**
   * Unix ms of `player`'s latest played ticket (a `settle`, not a `cancel`, in the settled log: 14 days); null when it
   * has none. A join permit's standing (`JoinPermits`).
   */
  lastPlayedAt?(player: string): number | null;
  /**
   * `player` asked to sit with its ticket of `arenaId` while joins were open, and the server refused for a reason of
   * its own (overloaded, the journal cannot be written, a re-price, the chain could not be read): the stale sweeper
   * does not count that ticket, if never seated, as a no-show. Absent: no such record (every unseated ticket counts).
   */
  excuseNoShow?(arenaId: number, player: string): void;
  /**
   * The server refused a seat request of `player` in `arenaId` for its own reason (`excuseNoShow`) at or after the
   * ticket opened (`openedAtS`, the block time): its refund, if it is never seated, is not a no-show. Absent: never.
   */
  excusedSince?(arenaId: number, player: string, openedAtS: number): boolean;
  /**
   * The game token `player` holds, ledger units (rounded down; capped at the largest safe integer): one read at
   * `normal` priority. Throws `ChainBusyError` when it cannot be read. Absent when the chain is off (and on the dev
   * fake chain).
   */
  tokenBalance?(player: string): Promise<number>;
  /**
   * The chain's clock (Unix ms): the local clock, corrected where the latest blocks read prove it off (an idle chain's
   * old latest block proves no skew). Ticket ages (the stale sweeper, the 6 h cap) and permit deadlines are measured
   * with it: a server clock that drifts never cancels a fresh ticket. Absent (the chain off, tests): the local clock.
   */
  chainNow?(): number;
  /** How far the blocks read prove the server clock off the chain's (ms, local − chain); null until a block time was read. */
  clockSkewMs?(): number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class NullChain implements ChainGateway {
  readonly enabled = false;
  readonly tokenReady = false;
  readonly stakeEnabled = false;
  constructor(private readonly chain: ChainInfo = activeChain()) {}
  status(): ChainStatus {
    return {
      enabled: false,
      chainId: null,
      chainName: this.chain.name,
      testnet: this.chain.testnet,
      faucetUrl: this.chain.faucetUrl,
      rpcUrl: null,
      explorerUrl: null,
      arenaAddress: null,
      nftAddress: null,
      arenasEnabled: false,
      tokenReady: false,
      token: null,
      fees: null,
      serverKey: null,
    };
  }
  async getSession(): Promise<ChainSession | null> {
    return null;
  }
  async listArenas(): Promise<ChainArena[]> {
    return [];
  }
  kick(): void {}
  setLiveSessionProvider(): void {}
  onSettled(): void {}
  onStatusChange(): void {}
  serverInfo(): ServerKeyInfo {
    return { address: null, balanceWei: null, low: false };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
