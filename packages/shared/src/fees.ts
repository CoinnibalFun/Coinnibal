/**
 * The fee rules, in one place. They mirror `ElymumArena` v3 exactly (the contract is the authority; the server,
 * the web and the tests use this module to predict and explain what the contract does).
 *
 * - **Tickets.** No entry fee: the whole ticket price goes into the arena vault and the coin starts at it.
 * - **Fee on profit.** When a ticket is settled for more than its entry fee, a fee is taken from the profit
 *   (`payout - entryFee`): `burnBps` of it is burned and `vaultBps` of it goes to the fee wallet (the vault).
 *   Defaults 15 % + 5 % = 20 %; the contract caps the pair at 25 % (`MAX_TOTAL_FEE_BPS`). Each share rounds down,
 *   so the player never pays more than the rate. A loss or a break-even pays nothing.
 * - **Rates are fixed at join** (a ticket keeps the rates it was bought with); emblem holders may get their own,
 *   lower pair.
 * - **Payments** (power-up packs, through `ElymumArena.pay`): `paymentBurnBps` (default 50 %) is burned, the rest
 *   goes to the fee wallet.
 * - **Floor loot** still on the floor at the bell is burned.
 */

/** Basis-point denominator (100 %). */
export const BPS = 10_000;

/** `ElymumArena.MAX_TOTAL_FEE_BPS`: the most the fee pair can take of a profit (25 %). */
export const MAX_TOTAL_FEE_BPS = 2_500;

/** A pair of fee rates on profit, in basis points. */
export interface FeeRates {
  /** Share of the profit burned. */
  burnBps: number;
  /** Share of the profit sent to the fee wallet. */
  vaultBps: number;
}

/** The contract's deploy defaults (`DEFAULT_BURN_BPS`, `DEFAULT_VAULT_BPS`): 15 % burned + 5 % to the fee wallet. */
export const DEFAULT_FEE_RATES: Readonly<FeeRates> = Object.freeze({ burnBps: 1_500, vaultBps: 500 });

/** `ElymumArena.DEFAULT_PAYMENT_BURN_BPS`: half of every power-up payment is burned, half goes to the fee wallet. */
export const DEFAULT_PAYMENT_BURN_BPS = 5_000;

/** The pair is valid on chain: whole bps, each >= 0, together at most `MAX_TOTAL_FEE_BPS`. */
export function isValidFeeRates(r: FeeRates): boolean {
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_TOTAL_FEE_BPS;
  return ok(r.burnBps) && ok(r.vaultBps) && r.burnBps + r.vaultBps <= MAX_TOTAL_FEE_BPS;
}

/** The whole fee rate of a pair, in bps. */
export const totalFeeBps = (r: FeeRates): number => r.burnBps + r.vaultBps;

/** The rates a ticket gets: the holder pair when it totals less than the normal pair (`ElymumArena._ratesFor`). */
export function ratesFor(normal: FeeRates, holder: FeeRates | null, isHolder: boolean): FeeRates {
  if (isHolder && holder && totalFeeBps(holder) < totalFeeBps(normal)) return { ...holder };
  return { ...normal };
}

/** The split of one settlement. */
export interface ProfitFee<T extends number | bigint = bigint> {
  /** The ticket's gross in-game value at the bell (what leaves the vault). */
  payout: T;
  /** `max(0, payout - entryFee)`. */
  profit: T;
  /** Burned. */
  burned: T;
  /** Sent to the fee wallet. */
  toVault: T;
  /** `burned + toVault`. */
  fee: T;
  /** What the player receives: `payout - fee`. */
  net: T;
}

const nonNegBig = (v: bigint): bigint => (v < 0n ? 0n : v);

/** `ElymumArena.computeFees` in base units (exact, rounding down each share). */
export function computeProfitFee(entryFee: bigint, payout: bigint, rates: FeeRates): ProfitFee<bigint> {
  const p = nonNegBig(payout);
  const e = nonNegBig(entryFee);
  const profit = p > e ? p - e : 0n;
  const burned = (profit * BigInt(rates.burnBps)) / BigInt(BPS);
  const toVault = (profit * BigInt(rates.vaultBps)) / BigInt(BPS);
  const fee = burned + toVault;
  return { payout: p, profit, burned, toVault, fee, net: p - fee };
}

const safeNum = (v: number): number => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/**
 * The same split in whole ledger units (the server's and the client's `number` amounts). Malformed amounts count
 * as 0. Exact: the arithmetic runs on bigint.
 */
export function profitFee(entryFee: number, payout: number, rates: FeeRates = DEFAULT_FEE_RATES): ProfitFee<number> {
  const r = computeProfitFee(BigInt(safeNum(entryFee)), BigInt(safeNum(payout)), rates);
  return { payout: Number(r.payout), profit: Number(r.profit), burned: Number(r.burned), toVault: Number(r.toVault), fee: Number(r.fee), net: Number(r.net) };
}

/** The split of a `pay` payment: `burned = floor(amount * paymentBurnBps / 10 000)`, the rest to the fee wallet. */
export function paymentSplit(amount: bigint, paymentBurnBps: number = DEFAULT_PAYMENT_BURN_BPS): { burned: bigint; toVault: bigint } {
  const a = nonNegBig(amount);
  const burned = (a * BigInt(paymentBurnBps)) / BigInt(BPS);
  return { burned, toVault: a - burned };
}

/** `1500` → `"15"`, `250` → `"2.5"`: a bps rate as a percent string for copy. */
export function bpsToPercent(bps: number): string {
  const v = Math.round(bps) / 100;
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

/** The worked example every fee explanation uses (whole tokens): a ticket of `entry` that ends worth `payout`. */
export function feeExample(entry: number, payout: number, rates: FeeRates = DEFAULT_FEE_RATES): ProfitFee<number> & { entry: number } {
  return { entry, ...profitFee(entry, payout, rates) };
}
