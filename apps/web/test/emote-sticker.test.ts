import { EntityKind } from '@elymum/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Camera } from '../src/game/camera';
import { Particles } from '../src/game/particles';
import { ClientWorld } from '../src/game/state';
import { EMOTE_MAX_PX, EMOTE_MIN_PX, Renderer, emoteSize, type FrameInput } from '../src/render/renderer';
import type { Settings } from '../src/store';

const EMOJI = { width: 72, height: 72, emoji: true };
vi.mock('../src/ui/game/emoji', async (orig) => ({ ...(await orig<object>()), emojiImage: () => EMOJI }));

/** A 2D context that only logs the calls the emote drawing makes (every other call is a no-op). */
const log: [string, ...unknown[]][] = [];
const ctx = new Proxy(
  { globalAlpha: 1, canvas: null as unknown },
  {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      if (k === 'measureText') return () => ({ width: 40, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'getContextAttributes') return () => null;
      return (...args: unknown[]) => {
        if (k === 'translate' || k === 'drawImage' || k === 'save') log.push([k as string, ...args]);
      };
    },
    set(t, k, v) {
      (t as Record<string | symbol, unknown>)[k] = v;
      return true;
    },
  },
);
let restore: (() => void) | null = null;
beforeAll(() => {
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  restore = () => spy.mockRestore();
});
afterAll(() => restore?.());

const SETTINGS = { name: 'x', skin: 0, theme: 'light', quality: 'low', showNames: true, showMass: true, showEmotes: true } as Settings;

/** Where the emote sticker of a coin of radius `r` at `zoom` is drawn: its anchor (the translate before it) and size. */
function drawEmote(r: number, zoom: number): { x: number; y: number; size: number } {
  const world = new ClientWorld();
  world.myPid = 1;
  world.apply({ tick: 1, view: { x: 1000, y: 1000, h: 1000 }, players: [{ id: 1, skin: 2, flags: 0, name: 'me' }], upserts: [{ id: 5, kind: EntityKind.Cell, x: 1200, y: 900, r, playerId: 1 }], removals: [] }, 0);
  world.update(1000, 0);
  world.players.get(1)!.emote = { id: 3, at: 900 };
  const camera = new Camera();
  camera.resize(1280, 800);
  camera.x = 1200;
  camera.y = 900;
  camera.zoom = zoom;
  const renderer = new Renderer(document.createElement('canvas'));
  renderer.resize(1280, 800);
  const f: FrameInput = { now: 1000, dt: 1 / 60, world, camera, particles: new Particles(), settings: SETTINGS, reduced: true, aim: null, coinRain: false, rand: Math.random, drop: null };
  log.length = 0;
  renderer.draw(f);
  const i = log.findIndex((c) => c[0] === 'drawImage' && c[1] === EMOJI);
  expect(i).toBeGreaterThan(0);
  const tr = log.slice(0, i).reverse().find((c) => c[0] === 'translate')!;
  return { x: tr[1] as number, y: tr[2] as number, size: log[i][4] as number };
}

describe('emote stickers', () => {
  it('sit on the middle of the coin (not over the name tag above it)', () => {
    for (const [r, zoom] of [
      [20, 0.6],
      [60, 0.8],
      [400, 0.5],
    ]) {
      const at = drawEmote(r, zoom);
      expect(at.x).toBeCloseTo(1200);
      expect(at.y).toBeCloseTo(900);
      expect(at.size).toBeCloseTo(emoteSize(r, zoom));
    }
  });

  it('scale with the coin within readable bounds', () => {
    // a mid-size coin: about its face, inside the rim
    expect(emoteSize(100, 1)).toBeCloseTo(124);
    expect(emoteSize(100, 1) / 2).toBeLessThan(100);
    // a speck: never smaller than the minimum on screen; a giant: never bigger than the maximum
    expect(emoteSize(5, 1)).toBe(EMOTE_MIN_PX);
    expect(emoteSize(5, 0.5) * 0.5).toBeCloseTo(EMOTE_MIN_PX);
    expect(emoteSize(2000, 0.25) * 0.25).toBeCloseTo(EMOTE_MAX_PX);
  });

  it('stay clear of the name tag of the smallest coin that has one (14 px), even at the pop overshoot', () => {
    const z = 1;
    const r = 14;
    // the tag's bottom edge (see `drawLabel`: font 11 px, the tag 1.78 font tall, 7 px over the coin)
    const tagBottom = -r - 7 / z;
    const top = -(emoteSize(r, z) / 2) * 1.12;
    expect(top).toBeGreaterThan(tagBottom);
  });
});
