/**
 * False-positive sweep of the integrity detectors: many seeds of the integrity simulation with honest players only
 * (count the flags they raise at the default thresholds, and the payouts the auto-hold would keep), and with two
 * scripted bots among them (count how often both are caught).
 *
 *   pnpm -F @elymum/server exec tsx scripts/integrity-fp.ts [seeds=8] [minutes=8]
 */
import { runIntegritySim } from './integrity-sim';

const seeds = Number(process.argv[2] ?? 8);
const minutes = Number(process.argv[3] ?? 8);
let honestTickets = 0;
let honestFlags = 0;
let honestHolds = 0;
let caught = 0;
let twins = 0;
let scriptFalse = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const h = runIntegritySim({ minutes, seed, honest: 12 });
  honestTickets += h.tickets;
  honestFlags += h.flags.length;
  honestHolds += h.journal.held().length;
  const s = runIntegritySim({ minutes, seed, honest: 10, scripted: 2 });
  const bots = new Set(s.flags.filter((f) => f.kind === 'bot_input').map((f) => f.wallets[0]));
  if (bots.has('ScriptWallet0') && bots.has('ScriptWallet1')) caught++;
  if (s.flags.some((f) => f.kind === 'input_twin')) twins++;
  scriptFalse += s.flags.filter((f) => f.wallets.some((w) => w.startsWith('Honest'))).length;
  console.log(`seed ${seed}: honest ${h.tickets} tickets → ${h.flags.length} flag(s); with scripts → ${s.flags.map((f) => `${f.kind} ${f.score}`).join(', ') || 'none'}`);
}
console.log(
  `\n${seeds} seeds x ${minutes} min: honest players ${honestTickets} tickets, ${honestFlags} flag(s), ${honestHolds} hold(s); ` +
    `both scripts caught in ${caught}/${seeds}, input twins linked in ${twins}/${seeds}, flags naming an honest wallet next to scripts: ${scriptFalse}`,
);
