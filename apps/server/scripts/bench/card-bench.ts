/**
 * Share and Appetizer card drawing: how long a draw takes, and how long it holds the main thread (which relays every
 * player's snapshots). Part 1 draws `renderShareCard`, `renderStandingsCard` and `renderAppetizerCard` CARD_RUNS
 * times each on this thread (the first one loads the fonts) and prints the median and the worst draw. Part 2 asks for
 * CARD_BURST cards at once (a crawler or a share wave) the way the server does: on the main thread
 * (`CARD_WORKERS=0`, as before) and through the card worker pool (1 and 2 workers), while a 5 ms timer measures the
 * main thread's longest stall and its event-loop delay.
 *
 *   node --import tsx scripts/bench/card-bench.ts            (from apps/server)
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { CardWorkerPool, InlineCardRenderer, type CardDrawJob, type CardRenderer } from '../../src/site/card-renderer';
import { renderAppetizerCard, renderShareCard, renderStandingsCard } from '../../src/site/share-card';

const RUNS = Number(process.env.CARD_RUNS ?? 20);
const BURST = Number(process.env.CARD_BURST ?? 30);
const card = {
  id: 'abc',
  kind: 'round' as const,
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
  eaten: Array.from({ length: 6 }, (_, i) => ({ name: `Victim ${i}` })),
  eatenMore: 3,
  board: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, name: `Player ${i}`, mass: 3000 - i * 200, kills: 10 - i })),
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
console.log(`draw time on one thread (${RUNS} runs each):`);
bench('  share card', () => renderShareCard(card));
bench('  standings card', () => renderStandingsCard(card));
bench('  appetizer card', () => renderAppetizerCard({ no: 123, handle: 'coinnibalfun', at: Date.now() }));

/** A mix of the three pictures, each one distinct (no cache in between). */
const jobs = (n: number): CardDrawJob[] =>
  Array.from({ length: n }, (_, i) =>
    i % 3 === 0
      ? { kind: 'share', card: { ...card, mass: card.mass + i }, site: 'coinnibal.fun' }
      : i % 3 === 1
        ? { kind: 'standings', card: { ...card, players: 40 + i }, site: 'coinnibal.fun' }
        : { kind: 'appetizer', card: { no: i, handle: 'coinnibalfun', at: Date.now() }, site: 'coinnibal.fun' },
  );

async function burst(name: string, r: CardRenderer): Promise<void> {
  // warm: the worker is up, its fonts loaded
  await r.selfCheck();
  await r.render(jobs(1)[0]);
  const h = monitorEventLoopDelay({ resolution: 1 });
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  h.enable();
  const t0 = performance.now();
  // as the server asks: one request at a time arrives, each starts its draw (the main-thread renderer draws there)
  const all: Promise<Buffer>[] = [];
  for (const j of jobs(BURST)) {
    all.push(r.render(j));
    await new Promise((res) => setImmediate(res));
  }
  await Promise.all(all);
  const wall = performance.now() - t0;
  // the timer's last turn
  await new Promise((res) => setTimeout(res, 10));
  h.disable();
  clearInterval(timer);
  console.log(
    `  ${name}: ${BURST} cards in ${wall.toFixed(0)} ms · main thread longest stall ${worst.toFixed(1)} ms · event-loop delay p50 ${(h.percentile(50) / 1e6).toFixed(1)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(1)} ms, max ${(h.max / 1e6).toFixed(1)} ms`,
  );
  await r.close();
}

console.log(`\nmain thread while ${BURST} cards are drawn:`);
await burst('main thread (CARD_WORKERS=0, before)', new InlineCardRenderer());
await burst('1 card worker (CARD_WORKERS=1, default)', new CardWorkerPool({ size: 1, maxQueue: BURST }));
await burst('2 card workers (CARD_WORKERS=2)', new CardWorkerPool({ size: 2, maxQueue: BURST }));
