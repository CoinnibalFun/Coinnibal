import { elymumArenaAbi, elymumArenaArtifact, testTokenAbi, testTokenArtifact } from '@elymum/contracts';
import { DEFAULT_ARENAS, formatUsdCents, type ArenaPriceRow } from '@elymum/shared';
import { BaseError, erc20Abi, getAddress, isAddress, type Account, type Address, type Chain, type Hash, type PublicClient, type WalletClient } from 'viem';
import type { ContractCall } from './call';
import {
  MAX_ARENA_ID,
  MAX_ARENA_SESSIONS,
  MAX_TOTAL_FEE_BPS,
  BPS,
  BURN_MODE_CALL,
  MAX_UINT128,
  MAX_UINT64,
  MIN_ARENA_ID,
  MIN_ARENA_SESSIONS,
  REFUND_DELAY_SECS,
  SETTLE_CHUNK,
} from './constants';
import { isZeroAddress } from './format';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * `ElymumArena` (v3: fee on profit, burned on chain): typed reads and call builders. Every builder validates its input like the
 * contract does (throws `RangeError` / `TypeError` before anything is signed) and returns a
 * `ContractCall` for `sendCall`, a browser wallet's `writeContract`, or a preview.
 */

type ReadClient = Pick<PublicClient, 'readContract'>;

export type ArenaAbi = typeof elymumArenaAbi;
export type ArenaCall = ContractCall<ArenaAbi>;
export type Erc20Call = ContractCall<typeof erc20Abi>;

/* -------------------------------------------------------------------- */
/* Views                                                                 */
/* -------------------------------------------------------------------- */

export interface ArenaConfig {
  address: Address;
  /** Owner (Ownable2Step). */
  admin: Address;
  /** Pending owner of a two-step transfer, null when none. */
  pendingAdmin: Address | null;
  serverAuthority: Address;
  feeWallet: Address;
  /** Game token, null until `setToken`. */
  token: Address | null;
  /** The token's decimals (18 until the token is set). */
  decimals: number;
  /** Fee rates on the profit of new tickets (bps): `burnBps` burned, `vaultBps` to the fee wallet. */
  burnBps: number;
  vaultBps: number;
  paused: boolean;
  /** ERC-721 whose holders get the holder perks (their own rates, holders-only arenas); null when the perks are off. */
  holderNft: Address | null;
  /** Holder rates (bps); a holder's ticket gets them when they total less than the normal pair. */
  holderBurnBps: number;
  holderVaultBps: number;
  /** `BURN_MODE_DEAD` (0) or `BURN_MODE_CALL` (1). */
  burnMode: number;
  /** Share of a `pay` payment burned (bps); the rest goes to the fee wallet. */
  paymentBurnBps: number;
  totals: {
    sessions: bigint;
    games: bigint;
    staked: bigint;
    /** Net payouts, cancels and refunds. */
    paidOut: bigint;
    feeBurned: bigint;
    feeToVault: bigint;
    lootBurned: bigint;
    payments: bigint;
    paymentBurned: bigint;
  };
}

export interface ArenaInfo {
  id: number;
  entryFee: bigint;
  /** Spendable by settle / cancel / refund / sweepLoot / sweepArena (the open tickets' stakes as they stand). */
  vault: bigint;
  /** Reserved for finalized sessions (collected with `refund`). */
  owed: bigint;
  maxSessions: number;
  openSessions: number;
  enabled: boolean;
  exists: boolean;
  totalDeposited: bigint;
  totalPaidOut: bigint;
  /** Fee burns + loot burns of this arena. */
  totalBurned: bigint;
  /** Fees this arena sent to the fee wallet. */
  totalFees: bigint;
  lastSweepId: bigint;
  /** Only holders of the holder NFT may join (`HoldersOnly`). */
  holdersOnly: boolean;
}

export interface SessionInfo {
  arenaId: number;
  player: Address;
  /** 0n means no session. */
  id: bigint;
  entryFee: bigint;
  /** Unix seconds. */
  openedAt: number;
  /** The ticket's fee rates on profit, fixed at join. */
  burnBps: number;
  vaultBps: number;
  /** Settled; the player's share waits as `owed` (collect with `refund`). */
  finalized: boolean;
  owed: bigint;
}

const nullIfZero = (a: Address): Address | null => (isZeroAddress(a) ? null : getAddress(a));

export async function getArenaConfig(client: ReadClient, arena: Address): Promise<ArenaConfig> {
  const c = await client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'config' });
  return {
    address: getAddress(arena),
    admin: getAddress(c.admin),
    pendingAdmin: nullIfZero(c.pendingAdmin),
    serverAuthority: getAddress(c.serverAuthority),
    feeWallet: getAddress(c.feeWallet),
    token: nullIfZero(c.token),
    decimals: c.token && !isZeroAddress(c.token) ? Number(c.decimals) : 18,
    burnBps: Number(c.burnBps),
    vaultBps: Number(c.vaultBps),
    paused: c.paused,
    holderNft: nullIfZero(c.holderNft),
    holderBurnBps: Number(c.holderBurnBps),
    holderVaultBps: Number(c.holderVaultBps),
    burnMode: Number(c.burnMode),
    paymentBurnBps: Number(c.paymentBurnBps),
    totals: {
      sessions: c.totalSessions,
      games: c.totalGames,
      staked: c.totalStaked,
      paidOut: c.totalPaidOut,
      feeBurned: c.totalFeeBurned,
      feeToVault: c.totalFeeToVault,
      lootBurned: c.totalLootBurned,
      payments: c.totalPayments,
      paymentBurned: c.totalPaymentBurned,
    },
  };
}

export async function getArenaIds(client: ReadClient, arena: Address): Promise<number[]> {
  const ids = await client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'arenaIds' });
  return ids.map(Number);
}

/** An arena by id (`exists: false` when it was never created). */
export async function getArena(client: ReadClient, arena: Address, id: number): Promise<ArenaInfo> {
  checkArenaId(id);
  const a = await client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'getArena', args: [id] });
  return {
    id: Number(a.id),
    entryFee: a.entryFee,
    vault: a.vault,
    owed: a.owed,
    maxSessions: Number(a.maxSessions),
    openSessions: Number(a.openSessions),
    enabled: a.enabled,
    exists: a.exists,
    totalDeposited: a.totalDeposited,
    totalPaidOut: a.totalPaidOut,
    totalBurned: a.totalBurned,
    totalFees: a.totalFees,
    lastSweepId: a.lastSweepId,
    holdersOnly: a.holdersOnly === true,
  };
}

/** A player's session in an arena (`id: 0n` when none). */
export async function getSession(client: ReadClient, arena: Address, arenaId: number, player: Address): Promise<SessionInfo> {
  checkArenaId(arenaId);
  const s = await client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'getSession', args: [arenaId, player] });
  return {
    arenaId,
    player: getAddress(player),
    id: s.id,
    entryFee: s.entryFee,
    openedAt: Number(s.openedAt),
    burnBps: Number(s.burnBps),
    vaultBps: Number(s.vaultBps),
    finalized: s.finalized,
    owed: s.owed,
  };
}

/** Every created arena, in creation order. */
export async function listArenas(client: ReadClient, arena: Address): Promise<ArenaInfo[]> {
  const ids = await getArenaIds(client, arena);
  return Promise.all(ids.map((id) => getArena(client, arena, id)));
}

/** True when `player` holds the arena's holder NFT (false while the perks are off or when the NFT misbehaves). */
export function isArenaHolder(client: ReadClient, arena: Address, player: Address): Promise<boolean> {
  return client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'isHolder', args: [player] });
}

/** The fee rates a ticket bought by `player` now would get (the holder pair for holders, when lower). */
export async function getFeeRatesFor(client: ReadClient, arena: Address, player: Address): Promise<FeeRates> {
  const [burnBps, vaultBps] = await client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'feeRatesFor', args: [player] });
  return { burnBps: Number(burnBps), vaultBps: Number(vaultBps) };
}

/** A pair of fee rates on profit (bps). */
export interface FeeRates {
  burnBps: number;
  vaultBps: number;
}

/** The rates a ticket gets, off-chain (`ElymumArena._ratesFor`): the holder pair when the perks are on and it totals less. */
export function effectiveFeeRates(
  config: Pick<ArenaConfig, 'burnBps' | 'vaultBps' | 'holderNft' | 'holderBurnBps' | 'holderVaultBps'>,
  holder: boolean,
): FeeRates {
  if (holder && config.holderNft && config.holderBurnBps + config.holderVaultBps < config.burnBps + config.vaultBps) {
    return { burnBps: config.holderBurnBps, vaultBps: config.holderVaultBps };
  }
  return { burnBps: config.burnBps, vaultBps: config.vaultBps };
}

/** `ElymumArena.computeFees(entryFee, payout, burnBps, vaultBps)` on chain (the off-chain twin is `settlementSplit`). */
export async function computeFeesOnChain(client: ReadClient, arena: Address, entryFee: bigint, payout: bigint, rates: FeeRates): Promise<{ net: bigint; burned: bigint; toVault: bigint }> {
  const [net, burned, toVault] = await client.readContract({ address: arena, abi: elymumArenaAbi, functionName: 'computeFees', args: [entryFee, payout, rates.burnBps, rates.vaultBps] });
  return { net, burned, toVault };
}

/** True when `codeHash` is the bundled arena build (the only version this SDK and the server support). */
export function isBundledArena(codeHash: string | null | undefined): boolean {
  return !!codeHash && codeHash.toLowerCase() === elymumArenaArtifact.runtimeCodeHash.toLowerCase();
}

/**
 * Whether `token` has a working `burn(uint256)` (ERC20Burnable), probed with an `eth_call` of `burn(0)` from the
 * arena's address (burning nothing changes nothing). `true` means the call did not revert; a token with a catch-all
 * fallback would also answer `true`, which is why the arena checks the balance after every real burn and falls
 * back to 0x…dEaD. `null` when the probe could not be made (no RPC).
 */
export async function probeBurnSupport(client: Pick<PublicClient, 'call'>, token: Address, from: Address): Promise<boolean | null> {
  try {
    await client.call({ to: token, account: from, data: BURN_ZERO_CALLDATA });
    return true;
  } catch (err) {
    // a transport failure means "unknown"; anything else (a revert, an empty answer) means "no burn()"
    const names: string[] = [];
    if (err instanceof BaseError) err.walk((e) => (names.push((e as Error).name), false));
    else names.push((err as Error)?.name ?? '');
    return names.some((n) => /HttpRequestError|TimeoutError|WebSocketRequestError|LimitExceededRpcError/.test(n)) ? null : false;
  }
}

/** `burn(0)` calldata (selector 0x42966c68). */
const BURN_ZERO_CALLDATA = '0x42966c680000000000000000000000000000000000000000000000000000000000000000' as const;

/** What a session can do now: nothing, collect `owed` (finalized), or refund after the 24 h delay. */
export function sessionRefundState(
  s: Pick<SessionInfo, 'id' | 'finalized' | 'openedAt' | 'owed' | 'entryFee'>,
  nowSecs: number = Math.floor(Date.now() / 1000),
): { kind: 'none' } | { kind: 'collect'; amount: bigint } | { kind: 'refund'; amount: bigint } | { kind: 'wait'; availableAt: number } {
  if (s.id === 0n) return { kind: 'none' };
  if (s.finalized) return { kind: 'collect', amount: s.owed };
  const at = s.openedAt + REFUND_DELAY_SECS;
  return nowSecs >= at ? { kind: 'refund', amount: s.entryFee } : { kind: 'wait', availableAt: at };
}

/* -------------------------------------------------------------------- */
/* ERC-20 game token                                                     */
/* -------------------------------------------------------------------- */

export interface TokenInfo {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number;
}

/** Name, symbol and decimals of an ERC-20 (name/symbol null when the call fails; decimals default 18 like the contract). */
export async function getTokenInfo(client: ReadClient, token: Address): Promise<TokenInfo> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: 'name' }).catch(() => null),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => null),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { address: getAddress(token), name, symbol, decimals: Number(decimals) };
}

export function getTokenBalance(client: ReadClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
}

export function getAllowance(client: ReadClient, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
}

/** The largest ERC-20 allowance (2^256 − 1): "unlimited", one approval for every later ticket. */
export const MAX_ALLOWANCE = (1n << 256n) - 1n;

export function approveCall(token: Address, spender: Address, amount: bigint): Erc20Call {
  checkAddress('spender', spender);
  if (amount < 0n || amount > (1n << 256n) - 1n) throw new RangeError(`approve amount out of range: ${amount}`);
  return { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] };
}

/* -------------------------------------------------------------------- */
/* Players                                                               */
/* -------------------------------------------------------------------- */

export function joinCall(arena: Address, arenaId: number): ArenaCall {
  checkArenaId(arenaId);
  return { address: arena, abi: elymumArenaAbi, functionName: 'join', args: [arenaId] };
}

/** Refund after 24 h, or collect `owed` of a finalized session. */
export function refundCall(arena: Address, arenaId: number): ArenaCall {
  checkArenaId(arenaId);
  return { address: arena, abi: elymumArenaAbi, functionName: 'refund', args: [arenaId] };
}

export interface JoinPlan {
  entryFee: bigint;
  /**
   * The fee rates on profit this ticket will be fixed at: the holder pair when the player holds the emblem and it is
   * lower. null only when the arena contract could not be read for it.
   */
  rates: FeeRates | null;
  /** The normal pair (`config.burnBps` / `config.vaultBps`); null when unknown. */
  standardRates: FeeRates | null;
  /** The player holds the holder NFT; null when unknown. */
  holder: boolean | null;
  /** The player gets the lower holder rates. */
  holderDiscount: boolean;
  /** The arena admits holders only. */
  holdersOnly: boolean;
  allowance: bigint;
  balance: bigint;
  /** `approve` when the allowance is short (exact entry fee, or `MAX_ALLOWANCE` with `approve: 'unlimited'`), else null. */
  approve: Erc20Call | null;
  join: ArenaCall;
  /** Calls in order (approve first when needed). */
  calls: ContractCall[];
}

/**
 * The ticket flow: reads the arena's entry fee, the fee rate the player will get (holder discount),
 * the player's allowance and balance, and returns `approve` (only when the allowance is short;
 * the exact entry fee, or with `approve: 'unlimited'` the largest allowance so later tickets need
 * `join` only) + `join`. Throws a `RangeError` when the arena is missing, disabled or full, the
 * token is not set, the arena is holders-only and the player holds no emblem (message contains
 * "holders only"), or the balance is short.
 */
export async function planJoin(
  client: ReadClient,
  p: { arena: Address; arenaId: number; player: Address; token?: Address; approve?: 'exact' | 'unlimited' },
): Promise<JoinPlan> {
  const [info, config, holder] = await Promise.all([
    getArena(client, p.arena, p.arenaId),
    // with a known token the config only feeds the fee report: a failed read is not fatal
    p.token ? getArenaConfig(client, p.arena).catch(() => null) : getArenaConfig(client, p.arena),
    isArenaHolder(client, p.arena, p.player).catch(() => null),
  ]);
  const token = p.token ?? config?.token ?? null;
  if (!token) throw new RangeError('the arena contract has no game token yet');
  if (!info.exists) throw new RangeError(`arena #${p.arenaId} does not exist`);
  if (!info.enabled) throw new RangeError(`arena #${p.arenaId} is closed`);
  if (info.openSessions >= info.maxSessions) throw new RangeError(`arena #${p.arenaId} is full`);
  if (info.holdersOnly && holder === false) {
    throw new RangeError(`arena #${p.arenaId} is for Coinnibal NFT holders only: ${getAddress(p.player)} holds no emblem`);
  }
  const standardRates = config ? { burnBps: config.burnBps, vaultBps: config.vaultBps } : null;
  const rates = config ? effectiveFeeRates(config, holder === true) : null;
  const total = (r: FeeRates) => r.burnBps + r.vaultBps;
  const fee = { rates, standardRates, holder, holderDiscount: !!rates && !!standardRates && total(rates) < total(standardRates), holdersOnly: info.holdersOnly };
  const [allowance, balance] = await Promise.all([getAllowance(client, token, p.player, p.arena), getTokenBalance(client, token, p.player)]);
  if (balance < info.entryFee) throw new RangeError(`balance too low for the ticket (need ${info.entryFee}, have ${balance} base units)`);
  const approve = allowance < info.entryFee ? approveCall(token, p.arena, p.approve === 'unlimited' ? MAX_ALLOWANCE : info.entryFee) : null;
  const join = joinCall(p.arena, p.arenaId);
  return { entryFee: info.entryFee, ...fee, allowance, balance, approve, join, calls: approve ? [approve, join] : [join] };
}

/* -------------------------------------------------------------------- */
/* Server                                                                */
/* -------------------------------------------------------------------- */

/** One item of a `settle` batch. */
export interface Settlement {
  arenaId: number;
  player: Address;
  sessionId: bigint;
  /** The ticket's gross value, base units (see `fromLedger`); the contract takes the fee on the profit from it. */
  payout: bigint;
}

/** One ticket of a `cancel` batch: a ticket that was never played gets its full entry fee back. */
export interface SessionRef {
  arenaId: number;
  player: Address;
  sessionId: bigint;
}

function checkSessionRef(s: SessionRef): void {
  checkArenaId(s.arenaId);
  checkAddress('player', s.player);
  if (typeof s.sessionId !== 'bigint' || s.sessionId <= 0n || s.sessionId > MAX_UINT64) throw new RangeError(`sessionId must be a uint64 > 0, got ${s.sessionId}`);
}

/** One `cancel` call: full entry-fee refunds of unplayed tickets, signed by the server. */
export function cancelCall(arena: Address, items: readonly SessionRef[]): ArenaCall {
  if (items.length === 0) throw new RangeError('cancel needs at least one item');
  for (const s of items) checkSessionRef(s);
  return {
    address: arena,
    abi: elymumArenaAbi,
    functionName: 'cancel',
    args: [items.map((s) => ({ arenaId: s.arenaId, player: getAddress(s.player), sessionId: s.sessionId }))],
  };
}

function checkSettlement(s: Settlement): void {
  checkArenaId(s.arenaId);
  checkAddress('player', s.player);
  if (typeof s.sessionId !== 'bigint' || s.sessionId <= 0n || s.sessionId > MAX_UINT64) throw new RangeError(`sessionId must be a uint64 > 0, got ${s.sessionId}`);
  if (typeof s.payout !== 'bigint' || s.payout < 0n || s.payout > MAX_UINT128) throw new RangeError(`payout must be a uint128, got ${s.payout}`);
}

/** Splits items into chunks of at most `size` (default 40, `SETTLE_CHUNK`). */
export function chunkSettlements<T>(items: readonly T[], size: number = SETTLE_CHUNK): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One `settle` call for up to any number of items (prefer `settleCalls`, which chunks). */
export function settleCall(arena: Address, items: readonly Settlement[]): ArenaCall {
  if (items.length === 0) throw new RangeError('settle needs at least one item');
  for (const s of items) checkSettlement(s);
  return {
    address: arena,
    abi: elymumArenaAbi,
    functionName: 'settle',
    args: [items.map((s) => ({ arenaId: s.arenaId, player: getAddress(s.player), sessionId: s.sessionId, payout: s.payout }))],
  };
}

/** `settle` calls of at most `chunk` items each (default 40). */
export function settleCalls(arena: Address, items: readonly Settlement[], chunk: number = SETTLE_CHUNK): ArenaCall[] {
  return chunkSettlements(items, chunk).map((c) => settleCall(arena, c));
}

/**
 * `pay(amount, ref)`: pays for something the game sells off chain (power-up packs). `paymentBurnBps` of it is burned,
 * the rest goes to the fee wallet. Needs an allowance of `amount` for the arena (approve first).
 */
export function payCall(arena: Address, amount: bigint, ref: `0x${string}`): ArenaCall {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > MAX_UINT128) throw new RangeError(`payment must be a uint128 > 0, got ${amount}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) throw new TypeError(`payment ref must be 32 bytes of hex, got ${ref}`);
  return { address: arena, abi: elymumArenaAbi, functionName: 'pay', args: [amount, ref] };
}

/** Burns floor loot; `sweepId` must be larger than the arena's `lastSweepId`. */
export function sweepLootCall(arena: Address, arenaId: number, sweepId: bigint, amount: bigint): ArenaCall {
  checkArenaId(arenaId);
  if (sweepId <= 0n || sweepId > MAX_UINT64) throw new RangeError(`sweepId must be a uint64 > 0, got ${sweepId}`);
  if (amount < 0n || amount > MAX_UINT128) throw new RangeError(`amount must be a uint128, got ${amount}`);
  return { address: arena, abi: elymumArenaAbi, functionName: 'sweepLoot', args: [arenaId, sweepId, amount] };
}

/* -------------------------------------------------------------------- */
/* Owner                                                                 */
/* -------------------------------------------------------------------- */

export function setTokenCall(arena: Address, token: Address): ArenaCall {
  checkAddress('token', token, { nonZero: true });
  return { address: arena, abi: elymumArenaAbi, functionName: 'setToken', args: [getAddress(token)] };
}

/** Fee rates on the profit of new tickets (`burnBps + vaultBps <= 2 500`). Open tickets keep theirs. */
export function setFeeRatesCall(arena: Address, rates: FeeRates): ArenaCall {
  checkFeeRates(rates);
  return { address: arena, abi: elymumArenaAbi, functionName: 'setFeeRates', args: [rates.burnBps, rates.vaultBps] };
}

/** `BURN_MODE_DEAD` (0) or `BURN_MODE_CALL` (1, the token's own `burn`; see `probeBurnSupport`). */
export function setBurnModeCall(arena: Address, mode: number): ArenaCall {
  if (mode !== 0 && mode !== BURN_MODE_CALL) throw new RangeError(`burn mode must be 0 or 1, got ${mode}`);
  return { address: arena, abi: elymumArenaAbi, functionName: 'setBurnMode', args: [mode] };
}

/** Share of every `pay` payment that is burned, in bps (0..10 000). */
export function setPaymentBurnBpsCall(arena: Address, bps: number): ArenaCall {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS) throw new RangeError(`payment burn share must be an integer in 0..${BPS} bps, got ${bps}`);
  return { address: arena, abi: elymumArenaAbi, functionName: 'setPaymentBurnBps', args: [bps] };
}

export function setFeeWalletCall(arena: Address, wallet: Address): ArenaCall {
  checkAddress('fee wallet', wallet, { nonZero: true });
  return { address: arena, abi: elymumArenaAbi, functionName: 'setFeeWallet', args: [getAddress(wallet)] };
}

export function setServerAuthorityCall(arena: Address, server: Address): ArenaCall {
  checkAddress('server authority', server, { nonZero: true });
  return { address: arena, abi: elymumArenaAbi, functionName: 'setServerAuthority', args: [getAddress(server)] };
}

export function setPausedCall(arena: Address, paused: boolean): ArenaCall {
  return { address: arena, abi: elymumArenaAbi, functionName: 'setPaused', args: [paused] };
}

export interface ArenaParams {
  id: number;
  entryFee: bigint;
  maxSessions: number;
}

export function createArenaCall(arena: Address, p: ArenaParams): ArenaCall {
  checkArenaId(p.id);
  checkArenaParams(p.entryFee, p.maxSessions);
  return { address: arena, abi: elymumArenaAbi, functionName: 'createArena', args: [p.id, p.entryFee, p.maxSessions] };
}

/** All fields are written (the contract has no partial update); the entry fee changes only while no ticket is open. */
export function updateArenaCall(arena: Address, p: ArenaParams & { enabled: boolean }): ArenaCall {
  checkArenaId(p.id);
  checkArenaParams(p.entryFee, p.maxSessions);
  return { address: arena, abi: elymumArenaAbi, functionName: 'updateArena', args: [p.id, p.entryFee, p.maxSessions, p.enabled] };
}

/** `updateArena` from the current state plus a partial change. */
export function updateArenaFrom(arena: Address, current: Pick<ArenaInfo, 'id' | 'entryFee' | 'maxSessions' | 'enabled'>, changes: Partial<Pick<ArenaInfo, 'entryFee' | 'maxSessions' | 'enabled'>>): ArenaCall {
  return updateArenaCall(arena, {
    id: current.id,
    entryFee: changes.entryFee ?? current.entryFee,
    maxSessions: changes.maxSessions ?? current.maxSessions,
    enabled: changes.enabled ?? current.enabled,
  });
}

/**
 * Holder perks: holders of `nft` (an ERC-721) join with the holder rates (when they total less than the normal
 * pair) and may enter holders-only arenas. `nft` null (or zero) turns the perks off.
 */
export function setHolderPerksCall(arena: Address, nft: Address | null, rates: FeeRates): ArenaCall {
  if (nft !== null) checkAddress('holder NFT', nft);
  checkFeeRates(rates);
  const a = nft === null ? ZERO_ADDRESS : getAddress(nft);
  return { address: arena, abi: elymumArenaAbi, functionName: 'setHolderPerks', args: [a, rates.burnBps, rates.vaultBps] };
}

/** Marks an arena holders-only (or opens it to everyone again). Open tickets are not affected. */
export function setArenaHoldersOnlyCall(arena: Address, id: number, holdersOnly: boolean): ArenaCall {
  checkArenaId(id);
  return { address: arena, abi: elymumArenaAbi, functionName: 'setArenaHoldersOnly', args: [id, holdersOnly] };
}

/**
 * "Sync arena prices to USD": the owner calls for the rows of `arenaPriceDiff` that can be signed now. Per arena an
 * `updateArena` with the new entry fee (its max open tickets and enabled state unchanged) and, when the tier says so,
 * `setArenaHoldersOnly`. Rows that are blocked (open tickets, missing arena or holder NFT) or cannot be priced are
 * left out; nothing else is touched. Open tickets keep the entry fee they were bought with (`Session.entryFee`).
 */
export function arenaPriceSyncCalls(arena: Address, rows: readonly ArenaPriceRow[]): { arenaId: number; label: string; call: ArenaCall }[] {
  const out: { arenaId: number; label: string; call: ArenaCall }[] = [];
  for (const r of rows) {
    if (r.blocked || r.error || !r.chain) continue;
    if (r.entryChange && r.newEntry !== null) {
      out.push({ arenaId: r.arenaId, label: `Arena #${r.arenaId}: ${formatUsdCents(r.usdCents)} ticket`, call: updateArenaFrom(arena, r.chain, { entryFee: r.newEntry }) });
    }
    if (r.holdersOnlyChange !== null) {
      out.push({ arenaId: r.arenaId, label: `Arena #${r.arenaId}: ${r.holdersOnlyChange ? 'emblem holders only' : 'open to everyone'}`, call: setArenaHoldersOnlyCall(arena, r.arenaId, r.holdersOnlyChange) });
    }
  }
  return out;
}

export function sweepArenaCall(arena: Address, id: number): ArenaCall {
  checkArenaId(id);
  return { address: arena, abi: elymumArenaAbi, functionName: 'sweepArena', args: [id] };
}

/** Recovers the gas token (`token` null/zero) or a foreign ERC-20; never the game token. */
export function rescueCall(arena: Address, p: { token: Address | null; to: Address; amount: bigint }): ArenaCall {
  checkAddress('to', p.to, { nonZero: true });
  const token = p.token ?? ZERO_ADDRESS;
  return { address: arena, abi: elymumArenaAbi, functionName: 'rescue', args: [token, getAddress(p.to), p.amount] };
}

/** Ownable2Step: starts a transfer (the new owner must `acceptOwnership`). Works for the arena and the NFT. */
export function transferOwnershipCall(contract: Address, newOwner: Address): ArenaCall {
  checkAddress('new owner', newOwner, { nonZero: true });
  return { address: contract, abi: elymumArenaAbi, functionName: 'transferOwnership', args: [getAddress(newOwner)] };
}

export function acceptOwnershipCall(contract: Address): ArenaCall {
  return { address: contract, abi: elymumArenaAbi, functionName: 'acceptOwnership', args: [] };
}

/** The four default tiers of `@elymum/shared` in base units of a token with `decimals`. */
export function defaultArenaParams(decimals: number): ArenaParams[] {
  return DEFAULT_ARENAS.map((a) => ({ id: a.id, entryFee: BigInt(a.entryTokens) * 10n ** BigInt(decimals), maxSessions: a.maxSessions }));
}

/** `createArena` calls for the default tiers that do not exist yet. */
export function createDefaultArenaCalls(arena: Address, decimals: number, existingIds: readonly number[] = []): ArenaCall[] {
  return defaultArenaParams(decimals)
    .filter((p) => !existingIds.includes(p.id))
    .map((p) => createArenaCall(arena, p));
}

/* -------------------------------------------------------------------- */
/* Deploy                                                                */
/* -------------------------------------------------------------------- */

export interface DeployArenaArgs {
  admin: Address;
  serverAuthority: Address;
  feeWallet: Address;
}

/** Fields for viem's `deployContract` (also used to preview the deploy). */
export function deployArenaParams(args: DeployArenaArgs) {
  checkAddress('admin', args.admin, { nonZero: true });
  checkAddress('server authority', args.serverAuthority, { nonZero: true });
  checkAddress('fee wallet', args.feeWallet, { nonZero: true });
  return {
    abi: elymumArenaAbi,
    bytecode: elymumArenaArtifact.bytecode,
    args: [getAddress(args.admin), getAddress(args.serverAuthority), getAddress(args.feeWallet)] as const,
  };
}

type DeployOpts = { account?: Account | Address; chain?: Chain | null };

function deploy(wallet: WalletClient, p: { abi: readonly unknown[]; bytecode: `0x${string}`; args: readonly unknown[] }, opts: DeployOpts): Promise<Hash> {
  return wallet.deployContract({
    abi: p.abi,
    bytecode: p.bytecode,
    args: p.args,
    account: opts.account ?? wallet.account ?? null,
    chain: opts.chain === undefined ? wallet.chain : opts.chain,
  } as never);
}

/** Deploys `ElymumArena` with the bundled bytecode. Returns the transaction hash (see `deployedAddress`). */
export function deployArena(wallet: WalletClient, args: DeployArenaArgs, opts: DeployOpts = {}): Promise<Hash> {
  return deploy(wallet, deployArenaParams(args), opts);
}

/** Fields for deploying the `TestToken` (localnet and testnet only). */
export function deployTestTokenParams(args: { owner: Address }) {
  checkAddress('owner', args.owner, { nonZero: true });
  return { abi: testTokenAbi, bytecode: testTokenArtifact.bytecode, args: [getAddress(args.owner)] as const };
}

/** Deploys the `TestToken` (localnet and testnet only; the caller checks the chain). */
export function deployTestToken(wallet: WalletClient, args: { owner: Address }, opts: DeployOpts = {}): Promise<Hash> {
  return deploy(wallet, deployTestTokenParams(args), opts);
}

export type TestTokenCall = ContractCall<typeof testTokenAbi>;

/** `TestToken.faucet()`: the caller's faucet amount (1,000,000 by default, 2,000,000 for holders), once per cooldown (1 h by default). */
export function faucetCall(token: Address): TestTokenCall {
  return { address: token, abi: testTokenAbi, functionName: 'faucet', args: [] };
}

/** `TestToken.mint(to, amount)` (the owner). */
export function testTokenMintCall(token: Address, to: Address, amount: bigint): TestTokenCall {
  checkAddress('to', to, { nonZero: true });
  if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_UINT256) throw new RangeError(`mint amount must be a uint256, got ${amount}`);
  return { address: token, abi: testTokenAbi, functionName: 'mint', args: [getAddress(to), amount] };
}

/** Alias of `testTokenMintCall`. */
export const mintCall = testTokenMintCall;

/** `TestToken.setHolderNft(nft)` (owner): holders of `nft` get the holder faucet amount; null turns the bonus off. */
export function testTokenSetHolderNftCall(token: Address, nft: Address | null): TestTokenCall {
  if (nft !== null) checkAddress('holder NFT', nft);
  return { address: token, abi: testTokenAbi, functionName: 'setHolderNft', args: [nft === null ? ZERO_ADDRESS : getAddress(nft)] };
}

/** `TestToken.setFaucet(amount, holderAmount, cooldown)` (owner), base units and seconds. Needs `0 < amount <= holderAmount`. */
export function testTokenSetFaucetCall(token: Address, p: { amount: bigint; holderAmount: bigint; cooldownSecs: number }): TestTokenCall {
  if (typeof p.amount !== 'bigint' || p.amount <= 0n || p.amount > MAX_UINT256) throw new RangeError(`faucet amount must be a uint256 > 0, got ${p.amount}`);
  if (typeof p.holderAmount !== 'bigint' || p.holderAmount < p.amount || p.holderAmount > MAX_UINT256) {
    throw new RangeError(`holder faucet amount must be at least the faucet amount, got ${p.holderAmount}`);
  }
  if (!Number.isSafeInteger(p.cooldownSecs) || p.cooldownSecs < 0) throw new RangeError(`faucet cooldown must be a whole number of seconds >= 0, got ${p.cooldownSecs}`);
  return { address: token, abi: testTokenAbi, functionName: 'setFaucet', args: [p.amount, p.holderAmount, BigInt(p.cooldownSecs)] };
}

/** Short names of the TestToken owner calls. */
export const setHolderNftCall = testTokenSetHolderNftCall;
export const setFaucetCall = testTokenSetFaucetCall;

export interface TestTokenFaucetConfig {
  address: Address;
  owner: Address;
  /** Base units per claim for a wallet without the holder NFT. */
  amount: bigint;
  /** Base units per claim for a holder. */
  holderAmount: bigint;
  cooldownSecs: number;
  /** null: no holder bonus. */
  holderNft: Address | null;
}

/** The TestToken's faucet settings. */
export async function getTestTokenFaucet(client: ReadClient, token: Address): Promise<TestTokenFaucetConfig> {
  const read = <T>(functionName: 'faucetAmount' | 'holderFaucetAmount' | 'faucetCooldown' | 'holderNft' | 'owner') =>
    client.readContract({ address: token, abi: testTokenAbi, functionName }) as Promise<T>;
  const [amount, holderAmount, cooldown, holderNft, owner] = await Promise.all([
    read<bigint>('faucetAmount'),
    read<bigint>('holderFaucetAmount'),
    read<bigint>('faucetCooldown'),
    read<Address>('holderNft'),
    read<Address>('owner'),
  ]);
  return { address: getAddress(token), owner: getAddress(owner), amount, holderAmount, cooldownSecs: Number(cooldown), holderNft: nullIfZero(holderNft) };
}

export interface FaucetInfo {
  /** Base units `who` gets per claim (the holder amount for holders). */
  amount: bigint;
  /** Unix seconds of the next claim; 0 when `who` never claimed. */
  nextClaimAt: number;
  /** `nowSecs >= nextClaimAt`. */
  canClaim: boolean;
  /** Seconds left (0 when `canClaim`), for a countdown. */
  waitSecs: number;
}

/** `TestToken.faucetInfo(who)`: what the faucet gives `who` and when. `nowSecs` defaults to the local clock. */
export async function getFaucetInfo(client: ReadClient, token: Address, who: Address, nowSecs: number = Math.floor(Date.now() / 1000)): Promise<FaucetInfo> {
  const [amount, next] = await client.readContract({ address: token, abi: testTokenAbi, functionName: 'faucetInfo', args: [who] });
  const nextClaimAt = Number(next);
  const waitSecs = Math.max(0, nextClaimAt - nowSecs);
  return { amount, nextClaimAt, canClaim: waitSecs === 0, waitSecs };
}

/** Short name of `getFaucetInfo`. */
export const faucetInfo = getFaucetInfo;

/** Waits for a deploy transaction and returns the new contract's address. */
export async function deployedAddress(client: Pick<PublicClient, 'waitForTransactionReceipt'>, hash: Hash): Promise<Address> {
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy transaction ${hash} failed`);
  return getAddress(r.contractAddress);
}

/* -------------------------------------------------------------------- */
/* Validation                                                            */
/* -------------------------------------------------------------------- */

export function checkArenaId(id: number): void {
  if (!Number.isInteger(id) || id < MIN_ARENA_ID || id > MAX_ARENA_ID) throw new RangeError(`arena id must be an integer in ${MIN_ARENA_ID}..${MAX_ARENA_ID}, got ${id}`);
}

/** A fee pair the contract accepts: whole bps, each >= 0, together at most `MAX_TOTAL_FEE_BPS` (25 %). */
export function checkFeeRates(r: FeeRates): void {
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_TOTAL_FEE_BPS;
  if (!ok(r.burnBps) || !ok(r.vaultBps) || r.burnBps + r.vaultBps > MAX_TOTAL_FEE_BPS) {
    throw new RangeError(`fee rates must be whole bps with burn + vault at most ${MAX_TOTAL_FEE_BPS}, got ${r.burnBps} + ${r.vaultBps}`);
  }
}

export function checkArenaParams(entryFee: bigint, maxSessions: number): void {
  if (typeof entryFee !== 'bigint' || entryFee <= 0n || entryFee > MAX_UINT128) throw new RangeError(`entry fee must be a uint128 > 0, got ${entryFee}`);
  if (!Number.isInteger(maxSessions) || maxSessions < MIN_ARENA_SESSIONS || maxSessions > MAX_ARENA_SESSIONS) {
    throw new RangeError(`max sessions must be an integer in ${MIN_ARENA_SESSIONS}..${MAX_ARENA_SESSIONS}, got ${maxSessions}`);
  }
}

export function checkAddress(label: string, a: string, opts: { nonZero?: boolean } = {}): void {
  if (typeof a !== 'string' || !isAddress(a, { strict: false })) throw new TypeError(`${label} is not an address: ${String(a)}`);
  if (opts.nonZero && isZeroAddress(a)) throw new RangeError(`${label} must not be the zero address`);
}
