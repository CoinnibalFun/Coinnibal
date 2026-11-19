/**
 * Snapshot benchmark: the per-connection cost of building and encoding the delta snapshot (the
 * biggest part of a room tick), on a big busy world: `viewers` views following players around.
 * Simulation time is not counted, only `ViewState.build` + `writeSnapshot`.
 *
 *   node --import tsx scripts/bench/snapshot-bench.ts [viewers=40] [players=80] [seconds=10]
 */
import { BinaryWriter, MAP_SPACE, TICK_MS, VIEW, viewSize, worldForSide, writeSnapshot } from '@coinnibal/shared';
import { mulberry32 } from '../../src/game/rng';
import { World } from '../../src/game/world';
import { ViewState } from '../../src/rooms/visibility';

const viewers = Number(process.argv[2] ?? 40);
const players = Number(process.argv[3] ?? 80);
const seconds = Number(process.argv[4] ?? 10);
const side = 10_000;
const world = new World({ ...worldForSide(side), powerUps: true, coinRain: false, seed: 11, space: MAP_SPACE });
const rng = mulberry32(5);
const ps = Array.from({ length: players }, (_, i) => world.addPlayer({ name: `p${i}`, skin: i % 4, mass: 40 + rng() * 400 }));
const views = Array.from({ length: viewers }, () => new ViewState());
const writer = new BinaryWriter(32 * 1024);
for (let i = 0; i < 300; i++) world.tick(TICK_MS);
let buildMs = 0;
let bytes = 0;
const ticks = Math.round((seconds * 1000) / TICK_MS);
for (let t = 0; t < ticks; t++) {
  if (t % 30 === 0) for (const p of ps) if (p.alive) world.setTarget(p.id, world.x0 + rng() * side, world.y0 + rng() * side);
  world.tick(TICK_MS);
  const t0 = performance.now();
  for (let i = 0; i < viewers; i++) {
    const p = ps[i % ps.length];
    if (!p.alive || p.cells.length === 0) continue;
    const c = p.center();
    const size = viewSize(p.totalMass(), 16 / 9);
    const hw = (size.w / 2) * VIEW.serverMargin;
    const hh = (size.h / 2) * VIEW.serverMargin;
    const snap = views[i].build(world, { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh }, { x: c.x, y: c.y, h: size.h });
    if (!snap) continue;
    writer.reset();
    writeSnapshot(writer, snap);
    bytes += writer.offset;
  }
  buildMs += performance.now() - t0;
}
console.log(`${viewers} viewers, ${players} players, food ${world.foodCount}: snapshots ${(buildMs / ticks).toFixed(3)} ms per tick (${((buildMs / ticks / viewers) * 1000).toFixed(1)} µs per viewer), ${(bytes / ticks / viewers).toFixed(0)} B per snapshot`);
