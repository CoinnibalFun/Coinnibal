import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ShareCard } from '@coinnibal/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CardRenderError, CardWorkerPool, InlineCardRenderer, MAX_STARTUP_FAILURES, type CardDrawJob, type CardRenderer } from '../src/site/card-renderer';
import { cardWorkers } from '../src/config';
import { renderAppetizerCard, renderShareCard, renderStandingsCard } from '../src/site/share-card';
import { ShareService } from '../src/site/shares';
import { AppetizerService } from '../src/site/appetizer';
import { testSigner } from './signers';

const card: ShareCard = {
  id: 'AbCdEfGh12',
  kind: 'round',
  at: 1_800_000_000_000,
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
  board: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, name: `Player ${i}`, mass: 3000 - i * 200, kills: 10 - i, ...(i === 2 ? { you: true } : {}) })),
};
const appetizer = { no: 123, handle: 'coinnibalfun', at: 1_800_000_000_000 };

const pools: CardRenderer[] = [];
const pool = (o: ConstructorParameters<typeof CardWorkerPool>[0] = {}) => {
  const p = new CardWorkerPool({ timeoutMs: 30_000, ...o });
  pools.push(p);
  return p;
};
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});

describe('card worker pool (share and Appetizer cards off the main thread)', () => {
  it('draws the same PNG bytes as the main thread, and passes the startup self-check there', async () => {
    const p = pool();
    expect(await p.selfCheck()).toEqual({ ok: true });
    const [share, standings, app] = await Promise.all([
      p.render({ kind: 'share', card, site: 'coinnibal.fun' }),
      p.render({ kind: 'standings', card, site: 'coinnibal.fun' }),
      p.render({ kind: 'appetizer', card: appetizer, site: 'coinnibal.fun' }),
    ]);
    expect(Buffer.isBuffer(share)).toBe(true);
    expect(share.equals(renderShareCard(card, 'coinnibal.fun'))).toBe(true);
    expect(standings.equals(renderStandingsCard(card, 'coinnibal.fun'))).toBe(true);
    expect(app.equals(renderAppetizerCard(appetizer, 'coinnibal.fun'))).toBe(true);
    // the main-thread renderer (`CARD_WORKERS=0`) gives the same bytes too
    expect((await new InlineCardRenderer().render({ kind: 'share', card, site: 'coinnibal.fun' })).equals(share)).toBe(true);
  }, 60_000);

  it('keeps the main thread free while it draws', async () => {
    const p = pool({ size: 1 });
    await p.selfCheck(); // the worker is up and its fonts are loaded
    await p.render({ kind: 'share', card, site: 'x' });
    // the same burst on this thread, for comparison: each draw holds the event loop for its whole length
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) renderShareCard(card, 'x');
    const inlineMs = performance.now() - t0;
    // through the pool: a 5 ms timer keeps firing while six cards are drawn
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    const t1 = performance.now();
    await Promise.all(Array.from({ length: 6 }, (_, i) => p.render({ kind: 'share', card: { ...card, mass: card.mass + i }, site: 'x' })));
    const poolMs = performance.now() - t1;
    clearInterval(timer);
    // six draws took (about) as long as on this thread, but no stall of this thread came near one draw
    expect(poolMs).toBeGreaterThan(inlineMs / 6);
    expect(worst).toBeLessThan(Math.max(25, (0.75 * inlineMs) / 6));
  }, 60_000);

  it('bounds its queue: past `maxQueue` waiting jobs a render is refused as busy, nothing is drawn for it', async () => {
    const p = pool({ size: 1, maxQueue: 2 });
    const jobs: CardDrawJob[] = Array.from({ length: 5 }, (_, i) => ({ kind: 'appetizer', card: { ...appetizer, no: i + 1 }, site: 'x' }));
    const out = await Promise.allSettled(jobs.map((j) => p.render(j)));
    // one drawing, two waiting, two refused
    expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const refused = out.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.reason).toMatchObject({ code: 'busy' });
    expect(p.counts).toMatchObject({ done: 3, busy: 2, failed: 0 });
  }, 60_000);

  it('a worker that cannot start fails its cards (fallback), and after a few tries the pool reports the canvas broken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-card-worker-'));
    const bad = join(dir, 'bad-worker.mjs');
    writeFileSync(bad, "throw new Error('no canvas binary for this platform');\n");
    const logs: string[] = [];
    const p = pool({ file: pathToFileURL(bad), log: (m) => logs.push(m) });
    const check = await p.selfCheck();
    expect(check.ok).toBe(false);
    const first = await p.render({ kind: 'share', card, site: 'x' }).catch((e: CardRenderError) => e);
    expect(first).toBeInstanceOf(CardRenderError);
    expect((first as CardRenderError).code).toBe('failed');
    let last: CardRenderError | null = null;
    for (let i = 0; i < MAX_STARTUP_FAILURES; i++) last = await p.render({ kind: 'share', card, site: 'x' }).catch((e: CardRenderError) => e) as CardRenderError;
    expect(last?.code).toBe('canvas');
    expect(logs.some((l) => l.includes('giving up'))).toBe(true);
  }, 60_000);

  it('close() stops the workers and fails what still waits; nothing is drawn afterwards', async () => {
    const p = pool({ size: 1 });
    const waiting = Array.from({ length: 3 }, (_, i) => p.render({ kind: 'appetizer', card: { ...appetizer, no: i }, site: 'x' }).catch((e: CardRenderError) => e.code));
    await p.close();
    expect(await Promise.all(waiting)).toEqual(['failed', 'failed', 'failed']);
    await expect(p.render({ kind: 'share', card, site: 'x' })).rejects.toMatchObject({ code: 'failed' });
  }, 60_000);

  it('CARD_WORKERS: default 1, 0 draws on the main thread, at most 4', () => {
    expect(cardWorkers({})).toBe(1);
    expect(cardWorkers({ CARD_WORKERS: '0' })).toBe(0);
    expect(cardWorkers({ CARD_WORKERS: '2' })).toBe(2);
    expect(cardWorkers({ CARD_WORKERS: '9' })).toBe(4);
    expect(cardWorkers({ CARD_WORKERS: 'many' })).toBe(1);
  });
});

/** A response that resolves with what was written. */
function response(): { res: never; done: Promise<{ status: number; headers: Record<string, unknown>; body: unknown }> } {
  let resolve!: (v: { status: number; headers: Record<string, unknown>; body: unknown }) => void;
  const done = new Promise<{ status: number; headers: Record<string, unknown>; body: unknown }>((r) => (resolve = r));
  let status = 0;
  let headers: Record<string, unknown> = {};
  const res = {
    writeHead(s: number, h: Record<string, unknown> = {}) {
      status = s;
      headers = h;
    },
    end(body?: unknown) {
      resolve({ status, headers, body });
    },
  };
  return { res: res as never, done };
}

/** A renderer that answers as told. */
function fake(answer: (job: CardDrawJob) => Promise<Buffer>): CardRenderer & { calls: number } {
  const r = {
    calls: 0,
    render(job: CardDrawJob) {
      r.calls++;
      return answer(job);
    },
    selfCheck: async () => ({ ok: true as const }),
    close: async () => {},
  };
  return r;
}

describe('the card services with a renderer', () => {
  const arenaRoom = { opts: { id: 'arena-1-1', mode: 'arena', name: '$1 Room', maxPlayers: 50, stake: { arenaId: 1, buyIn: 1 } } } as never;
  const look = { name: 'Nakamoto', skin: 2, country: 'JP', flags: 8 };
  const req = (path: string) => ({ method: 'GET', url: path, headers: {} }) as never;
  const shares = (renderer: CardRenderer) => new ShareService({ dataDir: null, baseUrl: () => 'https://coinnibal.fun', token: () => null, renderer });

  it('a share picture is drawn in the pool and cached; requests during the draw share it', async () => {
    const p = pool();
    const s = shares(p);
    const c = s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 1, of: 9, mass: 2000, kills: 4 });
    const a = response();
    const b = response();
    s.handle(req(`/share/${c.id}.png`), a.res, `/share/${c.id}.png`, '1.2.3.4');
    s.handle(req(`/share/${c.id}.png`), b.res, `/share/${c.id}.png`, '1.2.3.4');
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect((ra.body as Buffer).equals(renderShareCard(s.peek(c.id)!, 'coinnibal.fun'))).toBe(true);
    expect((p as CardWorkerPool).counts.done).toBe(1);
    const again = response();
    s.handle(req(`/share/${c.id}.png`), again.res, `/share/${c.id}.png`, '1.2.3.4');
    expect((await again.done).status).toBe(200);
    expect((p as CardWorkerPool).counts.done).toBe(1);
  }, 60_000);

  it('busy: 429 now and the card is drawn later; a dead worker: the site picture once, not "broken"; a canvas error: broken', async () => {
    let mode: 'busy' | 'failed' | 'canvas' | 'ok' = 'busy';
    const r = fake(async () => {
      if (mode === 'ok') return Buffer.from('png');
      throw new CardRenderError(mode, mode);
    });
    const s = shares(r);
    const c = s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 1, of: 9, mass: 2000, kills: 4 });
    const get = async () => {
      const x = response();
      s.handle(req(`/share/${c.id}.png`), x.res, `/share/${c.id}.png`, '1.2.3.4');
      return x.done;
    };
    expect(await get()).toMatchObject({ status: 429, headers: { 'Retry-After': '5' } });
    mode = 'failed';
    expect(await get()).toMatchObject({ status: 302, headers: { Location: 'https://coinnibal.fun/og-coinnibal.png' } });
    mode = 'ok';
    expect(await get()).toMatchObject({ status: 200, body: Buffer.from('png') });
    const d = s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 2, of: 9, mass: 900, kills: 1 });
    mode = 'canvas';
    const x = response();
    s.handle(req(`/share/${d.id}.png`), x.res, `/share/${d.id}.png`, '1.2.3.4');
    expect((await x.done).status).toBe(302);
    // broken from now on: the next new picture falls back at once, without asking the renderer
    const calls = r.calls;
    const e = s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 3, of: 9, mass: 800, kills: 1 });
    const y = response();
    s.handle(req(`/share/${e.id}.png`), y.res, `/share/${e.id}.png`, '1.2.3.4');
    expect((await y.done).status).toBe(302);
    expect(r.calls).toBe(calls);
  });

  it('an Appetizer card is drawn in the pool with the same bytes, and counts its view when it is served', async () => {
    const p = pool();
    const s = new AppetizerService({ path: null, baseUrl: () => 'https://coinnibal.fun', renderer: p });
    const { card: c } = s.claim(testSigner().address, 'pool_fan');
    const x = response();
    s.handle({ method: 'GET', headers: {} } as never, x.res, `/appetizer/${c.code}.png`, '9.9.9.9');
    const out = await x.done;
    expect(out.status).toBe(200);
    expect((out.body as Buffer).equals(renderAppetizerCard(c, 'coinnibal.fun'))).toBe(true);
    expect(s.list().items[0].views).toBe(1);
  }, 60_000);
});
