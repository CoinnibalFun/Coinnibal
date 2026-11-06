import { BPS, MAX_UINT128 } from './constants';

/** Anything that holds an integer: a JS number or a bigint. */
export type IntLike = number | bigint;

/** Converts a bigint/number to a bigint (numbers must be integers). */
export function toBigInt(value: IntLike): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isInteger(value)) throw new RangeError(`expected an integer, got ${value}`);
  return BigInt(value);
}

/** `amount * bps / 10_000`, rounded down (exact). */
export function mulBps(amount: IntLike, bps: number): bigint {
  return (toBigInt(amount) * BigInt(bps)) / BigInt(BPS);
}

/** How a settled ticket's payout is split (base units of the game token). */
export interface PayoutSplit {
  /** `max(0, payout - entryFee)`. */
  profit: bigint;
  /** Burned (`burnBps` of the profit). */
  burned: bigint;
  /** Sent to the fee wallet (`vaultBps` of the profit). */
  toVault: bigint;
  /** What the player receives: `payout - burned - toVault`. */
  net: bigint;
}

function checkU128(name: string, v: bigint): void {
  if (v < 0n || v > MAX_UINT128) throw new RangeError(`${name} must be a uint128, got ${v}`);
}

function checkRate(name: string, bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 0xffff) throw new RangeError(`${name} must be a uint16, got ${bps}`);
}

/**
 * `ElymumArena.computeFees` exactly: the fee is taken from the profit only, each share rounded down. Pass the
 * session's own rates (fixed at join) for a settlement, the config's for a preview. Throws `RangeError` where the
 * contract could not run (a value outside uint128, a rate outside uint16).
 */
export function settlementSplit(entryFee: IntLike, payout: IntLike, rates: { burnBps: number; vaultBps: number }): PayoutSplit {
  const e = toBigInt(entryFee);
  const p = toBigInt(payout);
  checkU128('entryFee', e);
  checkU128('payout', p);
  checkRate('burnBps', rates.burnBps);
  checkRate('vaultBps', rates.vaultBps);
  const profit = p > e ? p - e : 0n;
  const burned = mulBps(profit, rates.burnBps);
  const toVault = mulBps(profit, rates.vaultBps);
  return { profit, burned, toVault, net: p - burned - toVault };
}

/* -------------------------------------------------------------------- */
/* Ledger units                                                          */
/* -------------------------------------------------------------------- */

/**
 * Ledger units.
 *
 * The game server's ledger and the wire protocol carry token amounts as JS numbers, but an
 * 18-decimal token makes base units exceed 2^53 (1,000 tokens = 1e21 base units). So the server
 * keeps its ledger in **ledger units**: the token amount with at most 6 decimals. One ledger unit
 * is `ledgerUnitScale(decimals)` base units (`10^(decimals − 6)`, or 1 for a token with ≤ 6
 * decimals). Amounts are converted only at the chain boundary: `toLedger` when reading the chain
 * (entry fees, vaults, owed), `fromLedger` when writing it (settle payouts, sweepLoot amounts).
 * 2^53 ledger units are ~9 billion tokens, far above any arena's volume.
 */
export const LEDGER_MAX_DECIMALS = 6;

/** Base units per ledger unit: `10n ** BigInt(max(0, decimals − 6))`. */
export function ledgerUnitScale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`token decimals must be an integer in 0..255, got ${decimals}`);
  return 10n ** BigInt(Math.max(0, decimals - LEDGER_MAX_DECIMALS));
}

/** Decimals of a ledger amount for display (`formatToken(ledger, ledgerDecimals(decimals))`). */
export function ledgerDecimals(decimals: number): number {
  ledgerUnitScale(decimals);
  return Math.min(decimals, LEDGER_MAX_DECIMALS);
}

/** How `toLedger` treats base units below one ledger unit. */
export type LedgerRounding = 'exact' | 'floor' | 'ceil';

/**
 * Base units (bigint, from the chain) → ledger units (a safe JS integer).
 * `round` (default `'exact'`) throws `RangeError` when `base` is not a whole number of ledger
 * units; `'floor'` / `'ceil'` round instead (use `'floor'` for balances you may spend: it never
 * overstates them). Throws `RangeError` for negative values or results above 2^53 − 1.
 */
export function toLedger(base: bigint, decimals: number, round: LedgerRounding = 'exact'): number {
  if (typeof base !== 'bigint') throw new TypeError('toLedger expects a bigint amount of base units');
  if (base < 0n) throw new RangeError(`token amount ${base} is negative`);
  const scale = ledgerUnitScale(decimals);
  let units = base / scale;
  const rest = base % scale;
  if (rest !== 0n) {
    if (round === 'exact') throw new RangeError(`token amount ${base} is not a whole number of ledger units (1 unit = ${scale} base units)`);
    if (round === 'ceil') units += 1n;
  }
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`token amount ${base} exceeds the ledger's safe range`);
  return Number(units);
}

/** Ledger units (a non-negative safe JS integer) → base units for the chain. */
export function fromLedger(units: number | bigint, decimals: number): bigint {
  const scale = ledgerUnitScale(decimals);
  if (typeof units === 'number') {
    if (!Number.isSafeInteger(units)) throw new RangeError(`ledger amount ${units} is not a safe integer`);
  }
  const u = toBigInt(units);
  if (u < 0n) throw new RangeError(`ledger amount ${units} is negative`);
  return u * scale;
}
