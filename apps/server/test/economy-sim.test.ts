/**
 * The economy simulation (test/economy-sim.ts) at CI size: real arena rooms with 1 to 50 tickets each, test arenas
 * with bots, holders and everyone else, against the contract model; every conservation invariant is exact. The long
 * run: `pnpm -F @coinnibal/server econ-mc` (scripts/economy-sim.ts).
 */
import { computeProfitFee, DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES, MAX_TOTAL_FEE_BPS, profitFee, ratesFor } from '@coinnibal/shared';
import { settlementSplit } from '@coinnibal/sdk';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/game/rng';
import { ArenaModel, contractComputeFees, ratio, runEconomySim, STYLES } from './economy-sim';

describe('fee on profit: fees.ts, the SDK and the contract port agree to the base unit', () => {
  const U128 = (1n << 128n) - 1n;
  const big = (rng: () => number, bits: number): bigint => {
    let v = 0n;
    for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(Math.floor(rng() * 65536));
    return v & ((1n << BigInt(bits)) - 1n);
  };

  it('random entries, payouts and rate pairs up to uint128 and the 25 % cap', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 20_000; i++) {
      const bits = 1 + Math.floor(rng() * 128);
      const entry = big(rng, bits) || 1n;
      const payout = rng() < 0.1 ? entry : rng() < 0.5 ? big(rng, bits) : entry + big(rng, Math.max(1, bits - 1));
      if (payout > U128) continue;
      const burnBps = Math.floor(rng() * (MAX_TOTAL_FEE_BPS + 1));
      const vaultBps = Math.floor(rng() * (MAX_TOTAL_FEE_BPS - burnBps + 1));
      const c = contractComputeFees(entry, payout, burnBps, vaultBps);
      const s = computeProfitFee(entry, payout, { burnBps, vaultBps });
      const k = settlementSplit(entry, payout, { burnBps, vaultBps });
      expect([s.burned, s.toVault, s.net]).toEqual([c.burned, c.toVault, c.net]);
      expect([k.burned, k.toVault, k.net]).toEqual([c.burned, c.toVault, c.net]);
      const profit = payout > entry ? payout - entry : 0n;
      // only the profit pays, never more than the rates, the split adds up
      expect(c.burned + c.toVault <= (profit * BigInt(burnBps + vaultBps)) / 10_000n).toBe(true);
      expect(c.net + c.burned + c.toVault).toBe(payout);
      if (profit === 0n) expect(c.burned + c.toVault).toBe(0n);
      expect(c.net >= (payout < entry ? payout : entry)).toBe(true);
    }
  }, 60_000);

  it('the ledger-unit preview (numbers) equals the bigint split for every safe amount', () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 20_000; i++) {
      const entry = 1 + Math.floor(rng() * 1e12);
      const payout = Math.floor(rng() * 4 * entry);
      for (const r of [DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES]) {
        const n = profitFee(entry, payout, r);
        const b = computeProfitFee(BigInt(entry), BigInt(payout), r);
        expect([n.burned, n.toVault, n.net]).toEqual([Number(b.burned), Number(b.toVault), Number(b.net)]);
      }
    }
  }, 60_000);

  it('the holder pair is used only when it is lower, exactly as the contract picks it', () => {
    for (const [normal, holder] of [
      [DEFAULT_FEE_RATES, DEFAULT_HOLDER_FEE_RATES],
      [DEFAULT_FEE_RATES, DEFAULT_FEE_RATES],
      [{ burnBps: 500, vaultBps: 500 }, { burnBps: 1_500, vaultBps: 500 }],
      [{ burnBps: 0, vaultBps: 0 }, { burnBps: 0, vaultBps: 0 }],
    ]) {
      const m = new ArenaModel(normal, holder);
      for (const isHolder of [true, false]) expect(m.ratesFor(isHolder)).toEqual(ratesFor(normal, holder, isHolder));
    }
  });

  it('worked examples of docs/ECONOMY.md', () => {
    const e = 1_000n;
    expect(contractComputeFees(e, 2_000n, 1_500, 500)).toEqual({ net: 1_800n, burned: 150n, toVault: 50n });
    expect(contractComputeFees(e, 400n, 1_500, 500)).toEqual({ net: 400n, burned: 0n, toVault: 0n });
    expect(contractComputeFees(e, 3_000n, 800, 200)).toEqual({ net: 2_800n, burned: 160n, toVault: 40n });
    expect(contractComputeFees(e, 1_001n, 800, 200)).toEqual({ net: 1_001n, burned: 0n, toVault: 0n });
  });
});

describe('economy simulation (many rooms, 1..50 tickets each, contract model in base units)', () => {
  for (const seed of [101, 102]) {
    it(`seed ${seed}: every room, arena, vault and the token supply add up to the base unit; fees only on profit`, () => {
      const r = runEconomySim({ seed, rounds: 12, instances: 1, testArenas: true, wallets: 500 });
      expect(r.violations).toEqual([]);
      expect(r.settled).toBeGreaterThan(150);
      expect(r.deaths).toBeGreaterThan(20);
      expect(r.cancelled).toBeGreaterThan(0);
      expect(r.maxSeatedInRoom).toBeGreaterThanOrEqual(30);
      expect(r.testArenas!.botSpills).toBeGreaterThan(0);
      // zero-sum minus the fee and the burned loot: people as a whole never get back more than they paid in
      expect(r.paidOut).toBeLessThanOrEqual(r.deposited);
      expect(r.deposited - r.paidOut).toBe(r.feeBurned + r.feeToWallet + r.lootBurned + r.vaultDust);
      for (const s of STYLES) expect(r.byStyle[s].tickets).toBeGreaterThan(0);
      console.log(`econ seed ${seed}: ${r.roomRounds} room-rounds, ${r.settled} settled, ${r.cancelled} cancelled, ${r.deaths} deaths, max ${r.maxSeatedInRoom} in a room; return ${ratio(r.paidOut, r.deposited)}; ${r.ms} ms`);
    }, 120_000);
  }

  for (const decimals of [0, 6, 9]) {
    it(`a token with ${decimals} decimals: the same books, to the base unit`, () => {
      const r = runEconomySim({ seed: 110 + decimals, rounds: 3, instances: 1, testArenas: true, wallets: 300, decimals });
      expect(r.violations).toEqual([]);
      expect(r.settled).toBeGreaterThan(30);
      expect(r.deposited - r.paidOut).toBe(r.feeBurned + r.feeToWallet + r.lootBurned);
      // with at most 6 decimals a ledger unit is a base unit: the preview is exact
      if (decimals <= 6) expect(r.previewMaxDiff).toBe(0n);
    }, 60_000);
  }

  it('an entry fee that is not a whole number of ledger units: the sub-unit dust stays in the vault, nothing else drifts', () => {
    const r = runEconomySim({ seed: 103, rounds: 4, instances: 1, testArenas: false, wallets: 200, entryDust: 123_456n });
    expect(r.violations).toEqual([]);
    expect(r.vaultDust).toBeGreaterThan(0n);
    // each seated ticket leaves at most its own dust (123,456 base units, far below one ledger unit of 10^12)
    expect(r.vaultDust).toBeLessThanOrEqual(123_456n * BigInt(r.settled));
  }, 60_000);
});
