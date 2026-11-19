import type { GameServerLoad, GameThreadLoad } from '@coinnibal/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadCard, threadHot } from '../src/admin/NetworkTab';
import { Kb } from '../src/design';

const thread = (over: Partial<GameThreadLoad> = {}): GameThreadLoad => ({
  id: 0,
  rooms: 7,
  humans: 160,
  bots: 40,
  conns: 170,
  tickMeanMs: 10.5,
  tickP95Ms: 15.6,
  tickMaxMs: 36,
  elu: 0.39,
  lagP99Ms: 13,
  heapMb: 60,
  up: true,
  restarts: 0,
  ...over,
});

afterEach(cleanup);

describe('admin: game server load', () => {
  it('flags a thread near its frame budget, busy, lagging or down', () => {
    expect(threadHot(thread())).toBe(false);
    expect(threadHot(thread({ tickP95Ms: 26 }))).toBe(true);
    expect(threadHot(thread({ elu: 0.8 }))).toBe(true);
    expect(threadHot(thread({ lagP99Ms: 21 }))).toBe(true);
    expect(threadHot(thread({ up: false }))).toBe(true);
  });

  it('lists the main thread and every room worker', () => {
    const load: GameServerLoad = {
      mode: 'workers',
      workers: 2,
      cpus: 6,
      rssMb: 610,
      conns: 500,
      sentBytesPerSec: 3_270_000,
      sentMsgsPerSec: 15_900,
      main: thread({ id: 'main', rooms: 0, elu: 0.44, tickMeanMs: 2, tickP95Ms: 3.8, tickMaxMs: 7 }),
      threads: [thread({ id: 0 }), thread({ id: 1, up: false, restarts: 2 })],
      at: Date.now(),
    };
    render(
      <Kb>
        <LoadCard load={load} />
      </Kb>,
    );
    const rows = screen.getByTestId('load-threads').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('main');
    expect(rows[1].textContent).toContain('worker 0');
    expect(rows[1].textContent).toContain('10.5 / 15.6 / 36.0 ms');
    expect(rows[2].textContent).toContain('down');
    expect(rows[2].textContent).toContain('2 restarts');
    expect(rows[2].className).toContain('ad-bad');
    expect(screen.getByText(/2 room workers on 6 cores/)).toBeTruthy();
  });
});
