/**
 * Arena instance scaling, simulated: arrival waves on one official arena (instances of 10 seats so a few dozen
 * people show the scaling), 5-minute rounds, the real `RoomManager` and scaler on a simulated clock
 * (`test/arena-sim.ts`). Prints a minute-by-minute timeline, the scaler's decisions and the ticket checks
 * (every seated ticket settled exactly once, no seat refused, no instance above capacity).
 *   pnpm -F @coinnibal/server arena-sim
 */
import { ARENA_SIM_WAVES, runArenaSim } from '../test/arena-sim';

const r = await runArenaSim({ demand: ARENA_SIM_WAVES, minutes: 80, cap: 10 });
console.log('min  demand  seated  taking seats / instances  rooms (people per instance, d = draining)');
for (const t of r.timeline) console.log(`${String(t.minute).padStart(3)}  ${String(t.demand).padStart(6)}  ${String(t.seated).padStart(6)}  ${String(t.active).padStart(12)} / ${t.instances}          ${t.rooms}`);
console.log('\ndecisions:');
const t0 = r.log[0]?.at ?? 0;
for (const d of r.log) console.log(`  min ${((d.at - t0) / 60_000).toFixed(1).padStart(5)}  ${d.action.padEnd(8)} ${d.room.padEnd(11)} ${d.reason} (${d.people} people, ${d.instances} taking seats)`);
console.log(`\ntickets seated ${r.seated}, settled ${r.settled} (duplicates ${r.duplicates}), seats refused ${r.refused}, most in one instance ${r.maxInRoom}/10, most instances ${r.maxInstances}`);
const ok = r.seated === r.settled && r.duplicates === 0 && r.refused === 0 && r.maxInRoom <= 10;
console.log(ok ? 'OK: nobody dropped, every ticket settled once' : 'FAILED');
process.exit(ok ? 0 : 1);
