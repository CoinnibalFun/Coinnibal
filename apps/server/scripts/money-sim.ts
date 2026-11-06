/**
 * The long money simulation (see test/money-sim.ts): real rooms, journal and settlement worker against the
 * contract model (default) or a real hardhat node with the real ElymumArena v3 (`--hardhat`), with every fault on.
 * Prints one report per seed and exits 1 on any broken invariant.
 *
 *   pnpm -F @elymum/server money-sim                          # 4 seeds x 500 rounds on the model
 *   pnpm -F @elymum/server money-sim --rounds 2000 --seeds 2
 *   pnpm -F @elymum/server money-sim --hardhat --rounds 150   # the real contract on a fresh hardhat node
 *   pnpm -F @elymum/server money-sim --test-arenas            # plus a test arena with practice bots per arena
 */
import { DEFAULT_FAULTS, fakeSimChain, runMoneySim, type SimChain, type SimReport } from '../test/money-sim';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const hardhat = process.argv.includes('--hardhat');
const rounds = arg('rounds', hardhat ? 150 : 500);
const seeds = arg('seeds', hardhat ? 1 : 4);
const players = arg('players', 14);
const testArenas = process.argv.includes('--test-arenas') ? { bots: arg('bots', 10), difficulty: 'mixed' as const } : undefined;

async function main(): Promise<void> {
  const reports: SimReport[] = [];
  for (let k = 0; k < seeds; k++) {
    const seed = 20261105 + k * 7919;
    let sim: SimChain;
    if (hardhat) {
      const { hardhatSimChain } = await import('../test/money-sim-hardhat');
      sim = await hardhatSimChain({ players, seed });
    } else sim = fakeSimChain({ players, seed });
    try {
      const r = await runMoneySim(sim, { seed, rounds, faults: DEFAULT_FAULTS, passEvery: arg('pass', 6), instances: arg('instances', 2), testArenas });
      reports.push(r);
      console.log(JSON.stringify(r, null, 1));
    } finally {
      await sim.stop();
    }
  }
  const bad = reports.flatMap((r) => r.violations);
  const sum = (f: (r: SimReport) => number) => reports.reduce((s, r) => s + f(r), 0);
  console.log(
    `\n${reports.length} run(s) on ${reports[0]?.chain}: ${sum((r) => r.rounds)} rounds, ${sum((r) => r.ticks)} ticks, ${sum((r) => r.tickets)} tickets ` +
      `(${sum((r) => r.unplayed)} unplayed), ${sum((r) => r.closures.Settled)} settled, ${sum((r) => r.closures.Cancelled)} cancelled, ` +
      `${sum((r) => r.closures.Collected)} collected, ${sum((r) => r.checks)} conservation checks, ${sum((r) => r.faults.workerCrashes)} worker crashes, ` +
      `${sum((r) => r.faults.restarts)} restarts (${sum((r) => r.faults.hardKills)} hard), ${sum((r) => r.faults.rpcErrors)} RPC errors, ` +
      `${sum((r) => r.faults.ambiguousSends)} ambiguous sends, ${sum((r) => r.faults.lostReceipts)} lost receipts, ${sum((r) => r.faults.holds)} holds ` +
      `(${sum((r) => r.faults.zeroed)} settled at 0) — ${bad.length} violation(s) in ${(sum((r) => r.ms) / 1000).toFixed(1)} s`,
  );
  for (const v of bad.slice(0, 30)) console.log(`  ✗ ${v}`);
  process.exit(bad.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
