import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEE_RATES,
  DEFAULT_HOLDER_FEE_RATES,
  DEFAULT_PAYMENT_BURN_BPS,
  MAX_TOTAL_FEE_BPS,
  bpsToPercent,
  computeProfitFee,
  feeExample,
  isValidFeeRates,
  paymentSplit,
  profitFee,
  ratesFor,
} from '../src';

const E = 10n ** 18n;

describe('fee on profit (mirrors CoinnibalArena v3)', () => {
  it('has the contract defaults and cap', () => {
    expect(DEFAULT_FEE_RATES).toEqual({ burnBps: 1500, vaultBps: 500 });
    expect(MAX_TOTAL_FEE_BPS).toBe(2500);
    expect(DEFAULT_PAYMENT_BURN_BPS).toBe(5000);
  });

  // the same vectors as packages/contracts/test/CoinnibalArena.t.sol
  it('matches the Solidity test vectors', () => {
    expect(computeProfitFee(1000n * E, 2000n * E, DEFAULT_FEE_RATES)).toEqual({
      payout: 2000n * E,
      profit: 1000n * E,
      burned: 150n * E,
      toVault: 50n * E,
      fee: 200n * E,
      net: 1800n * E,
    });
    // rounding: profit 19 wei → burn 2, vault 0; profit 20 wei → burn 3, vault 1
    expect(computeProfitFee(1000n * E, 1000n * E + 19n, DEFAULT_FEE_RATES)).toMatchObject({ burned: 2n, toVault: 0n, net: 1000n * E + 17n });
    expect(computeProfitFee(1000n * E, 1000n * E + 20n, DEFAULT_FEE_RATES)).toMatchObject({ burned: 3n, toVault: 1n, net: 1000n * E + 16n });
    // max payout of a 3-ticket vault
    expect(computeProfitFee(1000n * E, 3000n * E, DEFAULT_FEE_RATES).net).toBe(2600n * E);
    // at the cap
    expect(computeProfitFee(1000n * E, 2000n * E, { burnBps: 2000, vaultBps: 500 }).net).toBe(1750n * E);
  });

  it('takes nothing from a loss or a break-even', () => {
    for (const payout of [0n, 400n * E, 1000n * E]) {
      const f = computeProfitFee(1000n * E, payout, DEFAULT_FEE_RATES);
      expect(f.fee).toBe(0n);
      expect(f.net).toBe(payout);
    }
  });

  it('adds up, never exceeds the rate and never cuts into the stake (property)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const entry = BigInt(Math.floor(rnd() * 1e12));
      const payout = BigInt(Math.floor(rnd() * 3e12));
      const burnBps = Math.floor(rnd() * 2501);
      const vaultBps = Math.floor(rnd() * (2501 - burnBps));
      const f = computeProfitFee(entry, payout, { burnBps, vaultBps });
      expect(f.net + f.burned + f.toVault).toBe(payout);
      expect(f.fee * 10_000n).toBeLessThanOrEqual(f.profit * BigInt(burnBps + vaultBps));
      if (payout > entry) expect(f.net).toBeGreaterThanOrEqual(entry);
    }
  });

  it('works in ledger units', () => {
    expect(profitFee(1000, 1900)).toEqual({ payout: 1900, profit: 900, burned: 135, toVault: 45, fee: 180, net: 1720 });
    expect(profitFee(1000, Number.NaN)).toMatchObject({ payout: 0, net: 0 });
    expect(profitFee(1000, 10.5)).toMatchObject({ payout: 0 });
    expect(feeExample(1000, 2000)).toMatchObject({ entry: 1000, net: 1800, burned: 150, toVault: 50 });
  });

  it('validates rates like the contract and picks the holder pair only when lower', () => {
    expect(isValidFeeRates({ burnBps: 2000, vaultBps: 500 })).toBe(true);
    expect(isValidFeeRates({ burnBps: 2001, vaultBps: 500 })).toBe(false);
    expect(isValidFeeRates({ burnBps: -1, vaultBps: 0 })).toBe(false);
    expect(isValidFeeRates({ burnBps: 1.5, vaultBps: 0 })).toBe(false);
    const holder = { burnBps: 1000, vaultBps: 0 };
    expect(ratesFor(DEFAULT_FEE_RATES, holder, true)).toEqual(holder);
    expect(ratesFor(DEFAULT_FEE_RATES, holder, false)).toEqual(DEFAULT_FEE_RATES);
    expect(ratesFor(DEFAULT_FEE_RATES, { burnBps: 2000, vaultBps: 500 }, true)).toEqual(DEFAULT_FEE_RATES);
  });

  it('holder fee selection: holders pay 10 % of profit (8 % burned + 2 % fee wallet), everyone else 20 %', () => {
    expect(DEFAULT_HOLDER_FEE_RATES).toEqual({ burnBps: 800, vaultBps: 200 });
    expect(isValidFeeRates(DEFAULT_HOLDER_FEE_RATES)).toBe(true);
    const holder = ratesFor(DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, true);
    const other = ratesFor(DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, false);
    expect(holder).toEqual({ burnBps: 800, vaultBps: 200 });
    expect(other).toEqual({ burnBps: 1500, vaultBps: 500 });
    // entry 1,000 → 2,000: holders keep 1,900, others 1,800
    expect(profitFee(1000, 2000, holder)).toMatchObject({ burned: 80, toVault: 20, net: 1900 });
    expect(profitFee(1000, 2000, other)).toMatchObject({ burned: 150, toVault: 50, net: 1800 });
    // perks off (no holder pair): the normal pair for everyone
    expect(ratesFor(DEFAULT_FEE_RATES, null, true)).toEqual(DEFAULT_FEE_RATES);
    // an admin pair equal to the normal pair gives no discount, a lower one does (the contract's `_ratesFor`)
    expect(ratesFor(DEFAULT_FEE_RATES, { burnBps: 1000, vaultBps: 1000 }, true)).toEqual(DEFAULT_FEE_RATES);
    expect(ratesFor({ burnBps: 2000, vaultBps: 500 }, DEFAULT_HOLDER_FEE_RATES, true)).toEqual(DEFAULT_HOLDER_FEE_RATES);
  });

  it('splits payments half burned, half to the fee wallet', () => {
    expect(paymentSplit(601n * E + 1n)).toEqual({ burned: 300n * E + E / 2n, toVault: 300n * E + E / 2n + 1n });
    expect(paymentSplit(100n, 10_000)).toEqual({ burned: 100n, toVault: 0n });
    expect(bpsToPercent(1500)).toBe('15');
    expect(bpsToPercent(250)).toBe('2.5');
    expect(bpsToPercent(2000)).toBe('20');
  });
});
