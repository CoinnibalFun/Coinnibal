/**
 * The money simulation (test/money-sim.ts) in the test suite: randomized rounds with every fault on, the
 * conservation checker after every chain pass, the drain at the end (no ticket left open, every ticket closed
 * exactly once, every vault down to its forfeits). On the contract model (fast, several seeds) and on a real
 * hardhat node with the real ElymumArena v3 (skipped when the node does not start). The long runs:
 * `pnpm -F @elymum/server money-sim` (see scripts/money-sim.ts).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAULTS, fakeSimChain, runMoneySim, type SimReport } from './money-sim';

const brief = (r: SimReport) =>
  `${r.chain}: ${r.rounds} rounds, ${r.tickets} tickets, ${r.closures.Settled} settled, ${r.closures.Cancelled} cancelled, ` +
  `${r.closures.Refunded} refunded, ${r.closures.Collected} collected, ${r.checks} checks, ${r.faults.workerCrashes} worker crashes, ` +
  `${r.faults.restarts} restarts, ${r.faults.holds} holds`;

describe('money conservation under faults (simulation)', () => {
  for (const seed of [1, 2, 3]) {
    it(`contract model, seed ${seed}: books balance at every pass, nothing lost, nothing paid twice`, async () => {
      const r = await runMoneySim(fakeSimChain({ players: 14, seed }), { seed, rounds: 250, faults: DEFAULT_FAULTS });
      expect(r.violations).toEqual([]);
      // the run really exercised the money paths
      expect(r.closures.Settled).toBeGreaterThan(200);
      expect(r.winners).toBeGreaterThan(10);
      expect(r.closures.Cancelled).toBeGreaterThan(0);
      expect(r.faults.rpcErrors + r.faults.ambiguousSends + r.faults.lostReceipts).toBeGreaterThan(0);
      console.log(brief(r));
    }, 120_000);
  }

  it('the real ElymumArena v3 on a hardhat node: the same checks', async (ctx) => {
    const { hardhatSimChain } = await import('./money-sim-hardhat');
    let sim;
    try {
      sim = await hardhatSimChain({ players: 8, seed: 7 });
    } catch (err) {
      console.warn(`money sim: ${(err as Error).message}; skipping the hardhat run`);
      return ctx.skip();
    }
    try {
      const r = await runMoneySim(sim, { seed: 7, rounds: 6, faults: DEFAULT_FAULTS });
      expect(r.violations).toEqual([]);
      expect(r.closures.Settled).toBeGreaterThan(5);
      console.log(brief(r));
    } finally {
      await sim.stop();
    }
  }, 240_000);
});
