/**
 * The mainnet economic simulation (test/mainnet-econ-sim.ts): physics calibration in real arena rooms, then the
 * economy of 100 and 200 concurrent players, the re-pricing study and the abuse study. Prints readable tables and,
 * with `--json <file>`, writes every figure.
 *
 *   pnpm -F @elymum/server econ-sim                 # full run (several minutes)
 *   pnpm -F @elymum/server econ-sim --quick         # a short calibration (about a minute)
 *   pnpm -F @elymum/server econ-sim --price 0.00002 # another mainnet token price (USD per token)
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_ARENAS, SHOP_DEFAULTS } from '@elymum/shared';
import {
  ABUSE_CASES,
  ETH_USD,
  GAS_PRICES_GWEI,
  L1_WEI_PER_BYTE,
  MAINNET_DEFAULT,
  abuseStudy,
  calibrate,
  loadGas,
  pricePath,
  repricingStudy,
  runEconomy,
  skillStats,
  type EconomyReport,
  type RepricePolicy,
} from '../test/mainnet-econ-sim';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const quick = flag('quick');
const price = opt('price', MAINNET_DEFAULT.usdPerToken);
const log = (m: string) => console.error(m);
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)} %`;
const num = (x: number, d = 0) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

const sizes = quick ? [15, 25, 40] : [15, 20, 25, 30, 40];
const cal = calibrate({ sizes, rounds: quick ? 3 : 6, seeds: quick ? [1, 2] : [1, 2, 3], log });
const all = [...cal.bySize.values()].flat();
const st = skillStats(all);
console.log(`\n## Physics calibration: ${all.length} room-rounds of 5 minutes (${sizes.join(' / ')} players), ${all.reduce((s, r) => s + r.tickets.length, 0)} tickets, ${(cal.ms / 1000).toFixed(0)} s`);
console.log('skill    tickets  tickets/player-round  mean payout  P(eaten)  P(profit)  p10  p50  p90  (payout in entry fees)');
for (const [k, v] of Object.entries(st)) console.log(`${k.padEnd(8)} ${String(v.tickets).padStart(7)}  ${v.ticketsPerSeatRound.toFixed(2).padStart(20)}  ${v.meanPayout.toFixed(3).padStart(11)}  ${pct(v.pDeath).padStart(8)}  ${pct(v.pProfit).padStart(9)}  ${v.p10.toFixed(2)} ${v.p50.toFixed(2)} ${v.p90.toFixed(2)}`);

const gas = loadGas();
const reports: EconomyReport[] = [];
for (const concurrent of [100, 200]) {
  reports.push(runEconomy(cal, { ...MAINNET_DEFAULT, usdPerToken: price, name: `${concurrent} players`, concurrent }, gas));
}
// the emblem costs $1 and halves the fee: if every player mints one (or borrows one, see F-emblem)
reports.push(runEconomy(cal, { ...MAINNET_DEFAULT, usdPerToken: price, name: '200 players, every player holds the emblem', concurrent: 200, holderShare: 1 }, gas));
for (const r of reports) {
  console.log(`\n## Economy: ${r.scenario.name}, ${r.scenario.hours} h (${r.rounds} rounds), $ELYMUM at $${r.scenario.usdPerToken}`);
  console.log('arena  ticket   entry (tokens)  players  instances  tickets/day  winners  burned/day  fee wallet/day  power-ups/day (tokens)');
  for (const t of r.tiers) {
    const d = 24 / r.scenario.hours;
    const tok = (x: bigint) => num(Number(x / 10n ** 18n) * d);
    console.log(`#${t.arenaId}     $${(t.usdCents / 100).toFixed(0).padEnd(3)}   ${num(Number(t.entry / 10n ** 18n)).padStart(14)}  ${String(t.players).padStart(7)}  ${String(t.instances).padStart(9)}  ${num(t.tickets * d).padStart(11)}  ${pct(t.winners / Math.max(1, t.tickets)).padStart(7)}  ${tok(t.burned).padStart(10)}  ${tok(t.toFeeWallet).padStart(14)}  ${tok(t.powerUpSpend).padStart(10)}`);
  }
  console.log(`flows per hour: burned ${num(r.perHour.burnedTokens)} tokens ($${r.perHour.burnedUsd.toFixed(2)}), of it power-ups ${num(r.perHour.powerUpBurnTokens)}; fee wallet ${num(r.perHour.feeWalletTokens)} tokens ($${r.perHour.feeWalletUsd.toFixed(2)}), of it power-ups ${num(r.perHour.powerUpFeeTokens)}`);
  console.log(`flows per day:  burned ${num(r.perDay.burnedTokens)} tokens ($${r.perDay.burnedUsd.toFixed(0)}, ${pct(r.perDay.burnedShareOfSupply, 3)} of the supply); fee wallet ${num(r.perDay.feeWalletTokens)} tokens ($${r.perDay.feeWalletUsd.toFixed(0)})`);
  console.log(`house edge per player-round: fee on profit ${pct(r.houseEdge.feeOnly, 2)} of the stake, with power-ups ${pct(r.houseEdge.withPowerUps, 2)}; by arena ${Object.entries(r.houseEdge.byTier).map(([k, v]) => `#${k} ${pct(v, 2)}`).join(', ')}; value changing hands: ${pct(r.transferRate)} of the stakes`);
  console.log('skill    EV/player-round (entries)  gross transfer  fee paid  power-ups   $/hour at $1 / $3 / $5 / $10');
  for (const [k, v] of Object.entries(r.ev)) {
    console.log(`${k.padEnd(8)} ${v.evPerRound.toFixed(3).padStart(25)}  ${v.grossPerRound.toFixed(3).padStart(14)}  ${v.feePerRound.toFixed(3).padStart(8)}  ${v.powerUpsPerRound.toFixed(3).padStart(9)}   ${Object.values(v.usdPerHour).map((x) => x.toFixed(2)).join(' / ')}`);
  }
  console.log('bankroll of 20 tickets at $1, playing every round: busted after 1 h / 4 h / the run, median hours to bust');
  for (const b of r.bankrolls) console.log(`  ${b.skill.padEnd(8)} ${pct(b.busted1h)} / ${pct(b.busted4h)} / ${pct(b.bustedEnd)}  ${Number.isFinite(b.medianHoursToBust) ? b.medianHoursToBust.toFixed(1) + ' h' : 'never (under half bust)'}`);
  console.log(`server key: ${num(r.gas.txs)} transactions a day (${r.gas.meanItemsPerTx.toFixed(2)} tickets each), ${num(r.gas.gasPerDay / 1e6, 1)} M gas a day; L1 data at ${L1_WEI_PER_BYTE / 1e9} gwei per byte`);
  console.log(`  ${Object.entries(r.gas.txByKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${num(v * (24 / r.scenario.hours))}`).join(', ')}`);
  for (const g of GAS_PRICES_GWEI) console.log(`  at ${g} gwei: ${r.gas.ethPerDay[`${g} gwei`].toFixed(5)} ETH a day ($${r.gas.usdPerDay[`${g} gwei`].toFixed(2)} at ETH $${ETH_USD})`);
  {
    const worst = r.gas.ethPerDay['0.25 gwei'];
    // the server warns by runway (trailing spend): under 7 days a warning, under 2 days an alert (GAS_RUNWAY_*_DAYS)
    console.log(`  runway alerts at 0.25 gwei: warning below ${(7 * worst).toFixed(4)} ETH (7 days), alert below ${(2 * worst).toFixed(4)} ETH (2 days); floor GAS_FLOOR_ETH 0.002`);
  }
  console.log(r.violations.length ? `VIOLATIONS: ${r.violations.slice(0, 5).join('; ')}` : 'conservation: every instance-round balanced exactly (deposited = paid + burned + fee wallet, nothing minted)');
}

// ---- re-pricing
const policies: RepricePolicy[] = [
  { name: 'manual, once a day', threshold: null, everyHours: 24, minGapHours: 0, twapMin: 5 },
  { name: 'manual, every 6 h', threshold: null, everyHours: 6, minGapHours: 0, twapMin: 5 },
  { name: 'threshold 5 % (spot)', threshold: 0.05, everyHours: null, minGapHours: 0, twapMin: 5 },
  { name: 'threshold 10 %, 30-min TWAP, >= 1 h apart', threshold: 0.1, everyHours: null, minGapHours: 1, twapMin: 30 },
  { name: 'threshold 15 %, 30-min TWAP, >= 2 h apart', threshold: 0.15, everyHours: null, minGapHours: 2, twapMin: 30 },
  { name: 'threshold 25 %, 30-min TWAP, >= 2 h apart', threshold: 0.25, everyHours: null, minGapHours: 2, twapMin: 30 },
];
const r200 = reports[1];
const per15: Record<number, number> = {};
for (const t of r200.tiers) per15[t.arenaId] = Math.round((t.tickets / r200.rounds) * 3);
const paths = [
  { name: 'random walk, 50 % daily volatility, 7 days', path: pricePath({ hours: 24 * 7, dailyVol: 0.5, seed: 11, start: Number(price) }) },
  { name: 'launch week: 100 % daily volatility, 7 days', path: pricePath({ hours: 24 * 7, dailyVol: 1.0, seed: 12, start: Number(price) }) },
  { name: 'a -50 % hour on day 2, 30 % volatility', path: pricePath({ hours: 24 * 3, dailyVol: 0.3, seed: 13, start: Number(price), shock: { atH: 30, move: -0.5 } }) },
];
const reprice: { path: string; results: ReturnType<typeof repricingStudy> }[] = [];
for (const p of paths) {
  const res = repricingStudy({ path: p.path, policies, ticketsPer15Min: per15, unplayed: MAINNET_DEFAULT.unplayed, seed: 5 });
  reprice.push({ path: p.name, results: res });
  console.log(`\n## Re-pricing at 200 players: ${p.name} (tickets per arena per 15 min: ${Object.entries(per15).map(([k, v]) => `#${k} ${v}`).join(', ')})`);
  console.log('policy                                         syncs/day  mean |dev|  p95 |dev|  >10 %   >25 %   pause/sync now p50 / p95   with drain   pause min/day/arena now / drain   magnet charge vs $1 ticket');
  for (const x of res) {
    console.log(`${x.policy.padEnd(46)} ${x.syncsPerDay.toFixed(1).padStart(9)}  ${pct(x.meanAbsDev).padStart(10)}  ${pct(x.p95AbsDev).padStart(9)}  ${pct(x.shareOver10).padStart(6)}  ${pct(x.shareOver25).padStart(6)}   ${x.pauseNowP50.toFixed(1).padStart(5)} / ${x.pauseNowP95.toFixed(1)} min   ${x.pauseFixedP50.toFixed(1).padStart(5)} min   ${x.pauseMinPerDayNow.toFixed(1).padStart(12)} / ${x.pauseMinPerDayFixed.toFixed(1)}   ${pct(x.powerUpVsTicketMin, 0)}..${pct(x.powerUpVsTicketMax, 0)}`);
  }
}
console.log(`(the shop sells a magnet charge for ${Number(SHOP_DEFAULTS.prices.magnet) / SHOP_DEFAULTS.packSize} tokens whatever the price; ECONOMY.md designed it as 20 % of the $1 ticket at $0.001)`);

// ---- abuse
const abuse = abuseStudy({ honest: quick ? 16 : 22, rounds: quick ? 3 : 5, seeds: quick ? [3] : [3, 4, 5], cases: ABUSE_CASES, log });
console.log('\n## Abuse (real rooms, real integrity detectors, same seeds as an honest control)');
console.log('case                                                                   rounds  ring net/round  control  taken from honest/round  best member payout  flags on the ring              false flags');
for (const a of abuse) console.log(`${a.name.padEnd(70)} ${String(a.roundsPlayed).padStart(6)}  ${a.ringNetPerRound.toFixed(2).padStart(14)}  ${a.controlNetPerRound.toFixed(2).padStart(7)}  ${a.extraFromHonestPerRound.toFixed(2).padStart(23)}  ${a.receiverPayoutPerRound.toFixed(2).padStart(18)}  ${(a.ringFlags.join(', ') || 'none').padEnd(28)}  ${a.honestFlags}`);

const out = opt('json', '');
if (out) {
  const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
  writeFileSync(out, JSON.stringify({ price, calibration: st, economy: reports, reprice, abuse, arenas: DEFAULT_ARENAS }, big, 1));
  log(`wrote ${out}`);
}
process.exit(reports.some((r) => r.violations.length > 0) ? 1 : 0);
