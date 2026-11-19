import { describe, expect, it } from 'vitest';
import { BPS, MAX_UINT128 } from '../src/constants';
import { fromLedger, ledgerDecimals, ledgerUnitScale, mulBps, settlementSplit, toBigInt, toLedger } from '../src/math';

describe('settlementSplit (CoinnibalArena v3 computeFees)', () => {
  const R = { burnBps: 1_500, vaultBps: 500 };
  it('takes the fee from the profit only, each share rounded down', () => {
    expect(settlementSplit(1_000n, 2_000n, R)).toEqual({ profit: 1_000n, burned: 150n, toVault: 50n, net: 1_800n });
    expect(settlementSplit(1_000n, 1_000n, R)).toEqual({ profit: 0n, burned: 0n, toVault: 0n, net: 1_000n });
    expect(settlementSplit(1_000n, 400n, R)).toEqual({ profit: 0n, burned: 0n, toVault: 0n, net: 400n });
    expect(settlementSplit(1_000n, 1_019n, R)).toMatchObject({ burned: 2n, toVault: 0n, net: 1_017n });
    expect(settlementSplit(1_000n, 1_020n, R)).toMatchObject({ burned: 3n, toVault: 1n, net: 1_016n });
  });

  it('adds up for any payout and never cuts into the stake', () => {
    for (const [e, p] of [
      [10n, 0n],
      [1_000n, 12_345_678n],
      [10n ** 21n, 10n ** 24n],
      [0n, MAX_UINT128],
    ] as const) {
      const s = settlementSplit(e, p, { burnBps: 2_000, vaultBps: 500 });
      expect(s.net + s.burned + s.toVault).toBe(p);
      expect(s.burned).toBe(((p > e ? p - e : 0n) * 2_000n) / BigInt(BPS));
      if (p > e) expect(s.net >= e).toBe(true);
    }
  });

  it('accepts numbers and refuses what the contract could not take', () => {
    expect(settlementSplit(1000, 2000, R).net).toBe(1_800n);
    expect(() => settlementSplit(-1n, 0n, R)).toThrow(RangeError);
    expect(() => settlementSplit(0n, MAX_UINT128 + 1n, R)).toThrow(RangeError);
    expect(() => settlementSplit(0n, 1n, { burnBps: 70_000, vaultBps: 0 })).toThrow(RangeError);
    expect(() => settlementSplit(1.5, 2, R)).toThrow(RangeError);
  });

  it('mulBps and toBigInt', () => {
    expect(mulBps(10_000n, 250)).toBe(250n);
    expect(toBigInt(5)).toBe(5n);
    expect(() => toBigInt(0.1)).toThrow(RangeError);
  });
});

describe('ledger units', () => {
  it('scales an 18-decimal token down to 6 decimals', () => {
    expect(ledgerUnitScale(18)).toBe(10n ** 12n);
    expect(ledgerUnitScale(6)).toBe(1n);
    expect(ledgerUnitScale(0)).toBe(1n);
    expect(ledgerDecimals(18)).toBe(6);
    expect(ledgerDecimals(2)).toBe(2);
    expect(() => ledgerUnitScale(-1)).toThrow(RangeError);
  });

  it('round-trips the default entry fees of an 18-decimal token', () => {
    const base = 250_000n * 10n ** 18n;
    const l = toLedger(base, 18);
    expect(l).toBe(250_000_000_000);
    expect(Number.isSafeInteger(l)).toBe(true);
    expect(fromLedger(l, 18)).toBe(base);
  });

  it('refuses inexact amounts unless asked to round', () => {
    const base = 10n ** 12n + 1n;
    expect(() => toLedger(base, 18)).toThrow(RangeError);
    expect(toLedger(base, 18, 'floor')).toBe(1);
    expect(toLedger(base, 18, 'ceil')).toBe(2);
  });

  it('refuses unsafe and negative values', () => {
    expect(() => toLedger(-1n, 18)).toThrow(RangeError);
    expect(() => toLedger(2n ** 53n * 10n ** 12n, 18)).toThrow(RangeError);
    expect(() => fromLedger(2 ** 53, 18)).toThrow(RangeError);
    expect(() => fromLedger(-1, 18)).toThrow(RangeError);
    expect(() => fromLedger(1.5, 18)).toThrow(RangeError);
    expect(fromLedger(7n, 6)).toBe(7n);
  });
});
