/**
 * The long economy simulation (see test/economy-sim.ts): many arena rooms at once with 1 to 50 tickets each, test
 * arenas with practice bots, holders and everyone else, five play styles, against the contract model in base units.
 * Prints the numbers (return per play style, per holder status, official vs test rooms, fees, burns, the bots' take,
 * the testnet faucet against the burn) and exits 1 on any broken invariant.
 *
 *   pnpm -F @coinnibal/server econ-mc                                   # 2 seeds x 400 rounds, 2 instances per arena
 *   pnpm -F @coinnibal/server econ-mc --rounds 2000 --seeds 1 --instances 3 --wallets 1500
 */
import { RULES } from '@coinnibal/shared';
import { ratio, runEconomySim, STYLES, type EconReport, type StyleStats } from '../test/economy-sim';

const arg = (name: string, d: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const rounds = arg('rounds', 400);
const seeds = arg('seeds', 2);
const instances = arg('instances', 2);
const walletsN = arg('wallets', 1200);

const TOKEN = 10n ** 18n;
const tok = (v: bigint): string => (Number((v * 100n) / TOKEN) / 100).toLocaleString('en-US');
const pct = (a: bigint, b: bigint): string => `${(ratio(a, b) * 100).toFixed(2)} %`;
const share = (n: number, d: number): string => `${(d ? (100 * n) / d : 0).toFixed(1).padStart(5)} %`;
const row = (name: string, s: StyleStats): string =>
  `  ${name.padEnd(10)} tickets ${String(s.tickets).padStart(7)}  paid in ${tok(s.paidIn).padStart(14)}  got back ${tok(s.netOut).padStart(14)}  return ${pct(s.netOut, s.paidIn).padStart(8)}  fee ${tok(s.fees).padStart(11)}  deaths ${share(s.deaths, s.tickets)}  winners ${share(s.winners, s.tickets)}`;

function print(r: EconReport): void {
  console.log(`\n=== seed ${r.seed}: ${r.rounds} rounds, ${r.roomRounds} room-rounds, ${r.ticks} ticks, ${r.checks} check passes, ${(r.ms / 1000).toFixed(0)} s`);
  console.log(`  tickets ${r.tickets} (settled ${r.settled}, cancelled unseated ${r.cancelled}), deaths ${r.deaths}, most tickets in one room-round ${r.maxSeatedInRoom}, rooms drained and closed ${r.closedRooms}`);
  console.log(`  deposited ${tok(r.deposited)}  paid out ${tok(r.paidOut)} (${pct(r.paidOut, r.deposited)})  fee burned ${tok(r.feeBurned)}  fee to wallet ${tok(r.feeToWallet)}  loot burned ${tok(r.lootBurned)}  vault dust ${r.vaultDust}`);
  console.log(`  identity: deposited - paid out = ${r.deposited - r.paidOut}; fees + loot burned + dust = ${r.feeBurned + r.feeToWallet + r.lootBurned + r.vaultDust} (base units)`);
  console.log(`  server preview vs contract net: ${r.previewDiffs} of ${r.settled} differ, at most ${r.previewMaxDiff} base units (${Number(r.previewMaxDiff) / 1e18} tokens)`);
  console.log('  by play style:');
  for (const s of STYLES) console.log(row(s, r.byStyle[s]));
  console.log('  by emblem:');
  console.log(row('holder', r.byHolder.holder));
  console.log(row('normal', r.byHolder.normal));
  console.log('  by room kind:');
  console.log(row('official', r.byRoomKind.official));
  console.log(row('test', r.byRoomKind.test));
  if (r.testArenas) {
    const t = r.testArenas;
    console.log(`  test arenas: ${t.botSpills} stake cells eaten by bots, ${t.botSpillValue / 1e6} tokens spilled as loot: ${t.lootPickedInTest / 1e6} picked up by people, ${t.lootBurnedInTest / 1e6} burned at the bell; bots keep nothing`);
  }
  const hours = (r.rounds * (RULES.roundMs + RULES.roundBreakMs)) / 3_600_000;
  const perH = (v: bigint) => tok((v * 1000n) / BigInt(Math.max(1, Math.round(hours * 1000))));
  console.log(`  supply over ${hours.toFixed(1)} h of 5:30 cycles: faucet minted ${tok(r.supply.minted)} (${r.supply.faucetClaims} claims, on demand), burned ${tok(r.supply.burned)} (${pct(r.supply.burned, r.supply.minted)} of minted), fee wallet ${tok(r.supply.feeWallet)}`);
  console.log(`  per hour: minted ${perH(r.supply.minted)}, burned ${perH(r.supply.burned)}`);
  if (r.violations.length > 0) {
    console.log(`  VIOLATIONS (${r.violations.length}):`);
    for (const v of r.violations) console.log(`    ${v}`);
  } else console.log('  every invariant held');
}

let bad = 0;
for (let k = 0; k < seeds; k++) {
  const r = runEconomySim({ seed: 20261124 + k * 7919, rounds, instances, testArenas: true, wallets: walletsN });
  print(r);
  if (r.violations.length > 0) bad++;
}
process.exit(bad > 0 ? 1 : 0);
