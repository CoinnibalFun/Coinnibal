import { VIEW, viewSize } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { Camera, shortForServerView, watchShort } from '../src/game/camera';

const cam = (w: number, h: number) => {
  const c = new Camera();
  c.resize(w, h);
  return c;
};

describe('spectator camera (paid rooms show exactly the server view)', () => {
  it('a wide screen: the server view height is the short side; a tall one: its width (h × aspect)', () => {
    const wide = viewSize(150, 16 / 9);
    expect(shortForServerView(wide.h, 16 / 9)).toBeCloseTo(Math.min(wide.w, wide.h), 6);
    const tall = viewSize(150, 0.5);
    expect(shortForServerView(tall.h, 0.5)).toBeCloseTo(Math.min(tall.w, tall.h), 6);
    // nothing sent yet: a start-size view
    expect(shortForServerView(0, 1)).toBe(VIEW.base);
  });

  it('a paid room: the lobby live view and the watch screen follow the server\'s (coin-sized) view, not the wide one', () => {
    const c = cam(1600, 900);
    const coin = viewSize(150, 1600 / 900);
    const paid = watchShort(c, { paid: true, wide: true, serverH: coin.h });
    expect(paid).toBeCloseTo(coin.h, 6);
    expect(paid).toBeLessThan(VIEW.spectatorBase * 0.85);
    // the camera then shows exactly that rectangle (no paper past what was sent)
    c.follow(0, 0, paid, 0, true);
    const r = c.visibleRect();
    expect(r.y1 - r.y0).toBeCloseTo(coin.h, 3);
    expect(r.x1 - r.x0).toBeCloseTo(coin.w, 3);
    // a tall phone too
    const p = cam(400, 800);
    const tall = viewSize(150, 0.5);
    p.follow(0, 0, watchShort(p, { paid: true, wide: true, serverH: tall.h }), 0, true);
    const q = p.visibleRect();
    expect(q.x1 - q.x0).toBeCloseTo(tall.w, 3);
    expect(q.y1 - q.y0).toBeCloseTo(tall.h, 3);
    // a paid room before its first snapshot: the usual camera
    expect(watchShort(c, { paid: true, wide: true, serverH: null })).toBeCloseTo(c.visibleShortFor(0, true) * 0.85, 6);
  });

  it('a free room keeps the wide spectator view (lobby, watch) and the coin-sized one after a death', () => {
    const c = cam(1600, 900);
    expect(watchShort(c, { paid: false, wide: true, serverH: 1200 })).toBeCloseTo(VIEW.spectatorBase * 0.85, 6);
    expect(watchShort(c, { paid: false, wide: false, serverH: 1200 })).toBeCloseTo(c.visibleShortFor(400), 6);
  });
});
