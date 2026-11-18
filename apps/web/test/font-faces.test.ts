import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { latinFaces, loadLatinFaces, rangeCovers } from '../src/design/fonts/faces';

const LATIN = 'U+0-FF, U+131, U+152-153, U+2BB-2BC, U+2C6, U+2DA, U+2DC, U+304, U+308, U+329, U+2000-206F';
const EXT = 'U+100-2BA, U+2BD-2C5, U+2C7-2CC';
const face = (family: string, unicodeRange: string, style = 'normal', id = '') => ({ family, unicodeRange, style, id, load: vi.fn(() => Promise.resolve()) }) as unknown as FontFace & { id: string; load: ReturnType<typeof vi.fn> };

describe('the SOFT-pinned Fraunces and the faces canvas text loads', () => {
  it('reads unicode-range in any serialization', () => {
    expect(rangeCovers(LATIN, 0x61)).toBe(true);
    expect(rangeCovers('U+0000-00FF', 0x61)).toBe(true);
    expect(rangeCovers('U+00??', 0x61)).toBe(true);
    expect(rangeCovers(EXT, 0x61)).toBe(false);
    expect(rangeCovers(EXT, 0x15f)).toBe(true);
    expect(rangeCovers('garbage', 0x61)).toBe(false);
  });

  it('picks, per family and style, the last latin face (the one the browser draws with), never a latin-ext face', () => {
    const fontsource = face('Fraunces Variable', LATIN, 'normal', 'fontsource');
    const pinned = face('"Fraunces Variable"', LATIN, 'normal', 'pinned');
    const italic = face('Fraunces Variable', LATIN, 'italic', 'italic');
    const faces = [
      face('Fraunces Variable', EXT),
      fontsource,
      face('Fraunces Variable', EXT, 'italic'),
      italic,
      pinned,
      face('DM Sans Variable', LATIN, 'normal', 'dm'),
      face('Geist Mono Variable', EXT),
      face('Geist Mono Variable', LATIN, 'normal', 'mono'),
      face('Some Other', LATIN),
    ];
    const ids = (wanted: [string, string][]) => latinFaces(faces, wanted).map((f) => (f as unknown as { id: string }).id);
    expect(ids([['Fraunces Variable', 'normal'], ['Geist Mono Variable', 'normal']])).toEqual(['pinned', 'mono']);
    expect(ids([['Fraunces Variable', 'normal'], ['Fraunces Variable', 'italic']])).toEqual(['pinned', 'italic']);
    expect(ids([['DM Sans Variable', 'italic']])).toEqual([]);
  });

  it('loads only those faces (document.fonts.load would also fetch the unused fontsource latin file)', async () => {
    const fontsource = face('Fraunces Variable', LATIN, 'normal', 'fontsource');
    const pinned = face('Fraunces Variable', LATIN, 'normal', 'pinned');
    const all = [fontsource, pinned];
    // jsdom has no FontFaceSet: a stand-in for this test only
    Object.defineProperty(document, 'fonts', { configurable: true, value: { forEach: (cb: (f: FontFace) => void) => all.forEach(cb) } });
    try {
      await loadLatinFaces([['Fraunces Variable', 'normal']]);
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
    expect(pinned.load).toHaveBeenCalledTimes(1);
    expect(fontsource.load).not.toHaveBeenCalled();
  });

  it('main.tsx declares the SOFT-pinned Fraunces after the fontsource faces (the last declared face wins)', () => {
    const main = readFileSync(join(__dirname, '../src/main.tsx'), 'utf8');
    const pinned = main.indexOf("import './design/fonts/fraunces-soft.css'");
    expect(pinned).toBeGreaterThan(main.indexOf("import '@fontsource-variable/fraunces/full.css'"));
    expect(pinned).toBeGreaterThan(main.indexOf("import '@fontsource-variable/fraunces/full-italic.css'"));
    expect(main.indexOf("import '@fontsource-variable/fraunces/full.css'")).toBeGreaterThan(-1);
    const css = readFileSync(join(__dirname, '../src/design/fonts/fraunces-soft.css'), 'utf8');
    expect(css).toMatch(/font-family: 'Fraunces Variable';/);
    expect(css).toMatch(/src: url\(\.\/fraunces-latin-soft100\.woff2\)/);
  });
});
