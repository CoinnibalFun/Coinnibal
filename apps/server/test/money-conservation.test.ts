/**
 * The money simulation (test/money-sim.ts) in the test suite: randomized rounds with every fault on, the
 * conservation checker after every chain pass, the drain at the end (no ticket left open, every ticket closed
 * exactly once, every vault down to its forfeits). On the contract model (fast, several seeds) and on a real
 * hardhat node with the real ElymumArena v3 (skipped when the node does not start). The long runs:
 * `pnpm -F @elymum/server money-sim` (see scripts/money-sim.ts).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAULTS, fakeSimChain, runMoneySim, type SimReport } from './money-sim';
import { runCartConservation } from './shop-cart';

const brief = (r: SimReport) =>
  `${r.chain}: ${r.rounds} rounds, ${r.tickets} tickets, ${r.closures.Settled} settled, ${r.closures.Cancelled} cancelled, ` +
  `${r.closures.Refunded} refunded, ${r.closures.Collected} collected, ${r.checks} checks, ${r.faults.workerCrashes} worker crashes, ` +
  `${r.faults.restarts} restarts, ${r.faults.holds} holds; holders: ${r.holders.wallets} wallets, ${r.holders.tickets} tickets, ` +
  `${r.holders.settled} settled (${r.holders.winners} with a profit, at 8 % + 2 %)`;

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
      // a share of the tickets came from emblem holders, at the holder pair (checked per Joined / Settled event)
      expect(r.holders.tickets).toBeGreaterThan(20);
      expect(r.holders.tickets).toBeLessThan(r.tickets);
      expect(r.holders.winners).toBeGreaterThan(0);
      console.log(brief(r));
    }, 120_000);
  }

  for (const seed of [4, 5]) {
    it(`contract model with test arenas (practice bots in a test instance of every arena), seed ${seed}: the same books, to the unit`, async () => {
      const r = await runMoneySim(fakeSimChain({ players: 14, seed }), { seed, rounds: 200, faults: DEFAULT_FAULTS, testArenas: { bots: 10, difficulty: 'mixed' } });
      expect(r.violations).toEqual([]);
      expect(r.closures.Settled).toBeGreaterThan(150);
      // the bots really played: players ate bots (mass, no value) and bots ate stake cells (value spilled as loot);
      // seated players made bots leave and the bots came back after them (the bounds are checked every tick)
      expect(r.testArenas!.botsEaten).toBeGreaterThan(0);
      expect(r.testArenas!.botSpills).toBeGreaterThan(0);
      expect(r.testArenas!.botsLeft).toBeGreaterThan(0);
      console.log(`${brief(r)}; test arenas: ${r.testArenas!.botsEaten} bots eaten, ${r.testArenas!.botSpills} stake cells eaten by bots (${r.testArenas!.botSpillValue} spilled as loot), ${r.testArenas!.botsLeft} left for players`);
    }, 180_000);
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
      // with a test arena per arena (practice bots): the real contract's books must not see them either
      const r = await runMoneySim(sim, { seed: 7, rounds: 6, faults: DEFAULT_FAULTS, testArenas: { bots: 6, difficulty: 'mixed' } });
      expect(r.violations).toEqual([]);
      expect(r.closures.Settled).toBeGreaterThan(5);
      expect(r.holders.wallets).toBeGreaterThan(0);
      expect(r.holders.tickets).toBeGreaterThan(0);
      console.log(brief(r));
    } finally {
      await sim.stop();
    }
  }, 240_000);
});

describe('money conservation: power-up carts (one payment, applied at once)', () => {
  for (const seed of [21, 22, 23]) {
    it(`seed ${seed}: what a cart paid is credited at its price or owed back, to the unit; nothing twice, nothing for a refused payment`, async () => {
      const r = await runCartConservation(seed, 500);
      expect(r.violations).toEqual([]);
      expect(r.refunds).toBeGreaterThan(0);
      console.log(`carts seed ${seed}: ${r.purchases} payments, ${r.refused} refused, ${r.refunds} with a part owed back`);
    }, 60_000);
  }
});
