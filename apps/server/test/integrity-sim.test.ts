import { describe, expect, it } from 'vitest';
import { runIntegritySim } from '../scripts/integrity-sim';

describe('integrity simulation (scripts/integrity-sim.ts)', () => {
  it('honest players raise no flag at the default thresholds', () => {
    for (const seed of [1, 2]) {
      const r = runIntegritySim({ minutes: 5, seed, honest: 12 });
      // the scenario really played: rounds ended, tickets were bought back, value moved between stakers
      expect(r.rounds).toBeGreaterThanOrEqual(4);
      expect(r.tickets).toBeGreaterThan(12);
      expect(r.transfers).toBeGreaterThan(0);
      expect(r.flags.map((f) => `${f.kind}: ${f.summary}`)).toEqual([]);
      expect(r.journal.held()).toEqual([]);
    }
  }, 180_000);

  it('people who steer with the move keys (eight directions, the aim at full reach) raise no flag either', () => {
    const r = runIntegritySim({ minutes: 4, seed: 3, honest: 6, keyboard: 4 });
    expect(r.tickets).toBeGreaterThan(10);
    expect(r.flags.map((f) => `${f.kind}: ${f.summary}`)).toEqual([]);
  }, 180_000);

  it('scripted input among them is flagged, and only the scripts', () => {
    // seed 2: the scenario is a whole game (bots included), so what each script gets to show in
    // 4 minutes depends on the seed; with the 2026-11 squad bots seeds 1, 2, 3 and 7 let both scripts
    // play long enough, while at 4, 5 and 6 a script is eaten early and shows only part of its signal
    // (below the flag score), which is the detector's documented behaviour (rooms also read the wall
    // clock in places, so a seed near that edge can differ between runs)
    const r = runIntegritySim({ minutes: 4, seed: 2, honest: 8, scripted: 2 });
    const bots = r.flags.filter((f) => f.kind === 'bot_input');
    expect(bots.map((f) => f.wallets[0]).sort()).toEqual(['ScriptWallet0', 'ScriptWallet1']);
    expect(r.flags.every((f) => f.wallets.every((w) => w.startsWith('Script')))).toBe(true);
  }, 180_000);
});
