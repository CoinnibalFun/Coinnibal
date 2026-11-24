/**
 * How long the share cards take to draw (they are drawn on the main thread, which also relays every snapshot):
 * `renderShareCard`, `renderStandingsCard` and `renderAppetizerCard`, CARD_RUNS times each (the first one loads the
 * fonts). Prints the median and the worst draw in ms.
 *
 *   node --import tsx scripts/bench/card-bench.ts            (from apps/server)
 */
import { renderAppetizerCard, renderShareCard, renderStandingsCard } from '../../src/site/share-card';

const RUNS = Number(process.env.CARD_RUNS ?? 20);
const card = {
  id: 'abc',
  kind: 'result' as const,
  at: Date.now(),
  name: 'Stress Tester',
  wallet: '0x1234…abcd',
  skin: 3,
  country: 'DE',
  holder: true,
  room: 'Gold Arena #2',
  rank: 3,
  players: 48,
  mass: 2412,
  kills: 7,
  paid: '1,234.5 tokens',
  eaten: Array.from({ length: 6 }, (_, i) => ({ name: `Victim ${i}`, skin: i % 4, mass: 100 + i * 50 })),
  eatenMore: 3,
  standings: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, name: `Player ${i}`, mass: 3000 - i * 200, kills: 10 - i, value: 1000 - i * 50, skin: i % 4 })),
};
const bench = (name: string, draw: () => Buffer) => {
  draw();
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    draw();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  console.log(`${name}: median ${ms[Math.floor(RUNS / 2)].toFixed(1)} ms, worst ${ms.at(-1)!.toFixed(1)} ms`);
};
bench('share card', () => renderShareCard(card as never));
bench('standings card', () => renderStandingsCard(card as never));
bench('appetizer card', () => renderAppetizerCard({ no: 123, handle: 'coinnibalfun', at: Date.now() }));
