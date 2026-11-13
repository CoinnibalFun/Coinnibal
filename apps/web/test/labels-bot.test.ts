import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LabelCache, type StickerLabel } from '../src/render/labels';

// jsdom has no canvas: a context that records the words it is asked to print
const printed: string[] = [];
const ctx = new Proxy(
  {
    measureText: (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }),
    fillText: (s: string) => printed.push(s),
  } as Record<string, unknown>,
  { get: (o, k) => (k in o ? o[k as string] : typeof k === 'string' && /^[a-z]/.test(k) && !['canvas'].includes(k) ? () => {} : undefined), set: () => true },
) as unknown as CanvasRenderingContext2D;
let restore: () => void = () => {};
beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const orig = proto.getContext;
  proto.getContext = () => ctx;
  restore = () => (proto.getContext = orig);
});
afterAll(() => restore());
afterEach(() => {
  printed.length = 0;
});

const bot: StickerLabel = { name: 'jakeyboy', value: null, verified: false, bot: true, mine: false, x: 0, y: 0, fs: 14, devicePx: 2, zoom: 1 };

describe('name tags: the bot chip', () => {
  it('says BOT, like the HUD chip', () => {
    const cache = new LabelCache();
    cache.drawSticker(ctx, bot, {});
    expect(printed).toContain('BOT');
  });
});
