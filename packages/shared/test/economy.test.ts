import { describe, expect, it } from 'vitest';
import { ECONOMY, RECOMMENDED_ENTRY_FEE_BPS, WINNINGS_CUT_BPS, winningsCut } from '../src';

describe('the cut on winnings', () => {
  it('is 20 % of the winnings: 15 % burned, 5 % kept in the vault', () => {
    expect(WINNINGS_CUT_BPS).toBe(2000);
    expect(ECONOMY).toEqual({ burnBps: 1500, vaultBps: 500 });
    expect(RECOMMENDED_ENTRY_FEE_BPS).toBe(0);
    expect(winningsCut(1900, 1000)).toEqual({ gross: 1900, profit: 900, burn: 135, vault: 45, cut: 180, net: 1720 });
  });

  it('takes nothing from a game that ends at or below its start, and never touches the stake', () => {
    expect(winningsCut(1000, 1000)).toMatchObject({ profit: 0, cut: 0, net: 1000 });
    expect(winningsCut(400, 1000)).toMatchObject({ profit: 0, cut: 0, net: 400 });
    expect(winningsCut(0, 1000)).toMatchObject({ cut: 0, net: 0 });
    for (const [g, s] of [
      [1001, 1000],
      [1_000_000_007, 999_999_999],
      [Number.MAX_SAFE_INTEGER, 1],
    ]) {
      const c = winningsCut(g, s);
      expect(c.net).toBeGreaterThanOrEqual(s);
      expect(c.burn + c.vault).toBe(c.cut);
      expect(c.net + c.cut).toBe(g);
      // rounding is down on each share: never more than 20 %
      expect(c.cut * 10_000).toBeLessThanOrEqual(c.profit * 2000);
    }
  });

  it('ignores malformed amounts', () => {
    expect(winningsCut(Number.NaN, 5)).toMatchObject({ gross: 0, cut: 0, net: 0 });
    expect(winningsCut(10.5, 1)).toMatchObject({ gross: 0, net: 0 });
  });
});
