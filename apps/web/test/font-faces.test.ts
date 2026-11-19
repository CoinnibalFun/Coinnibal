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

  it('the body text has a metric-matched stand-in for DM Sans, and the hero sizes its text without ch', () => {
    // the prerendered landing paints before DM Sans lands: the stand-in (local Arial, scaled) keeps the line breaks
    const main = readFileSync(join(__dirname, '../src/main.tsx'), 'utf8');
    expect(main.indexOf("import './design/fonts/dm-sans-fallback.css'")).toBeGreaterThan(main.indexOf("import '@fontsource-variable/dm-sans/opsz.css'"));
    const css = readFileSync(join(__dirname, '../src/design/fonts/dm-sans-fallback.css'), 'utf8');
    expect(css.match(/font-family: 'DM Sans Fallback';/g)).toHaveLength(2);
    expect(css).toMatch(/src: local\('Arial'\)/);
    expect(css).toMatch(/size-adjust: \d/);
    const tokens = readFileSync(join(__dirname, '../src/design/tokens.css'), 'utf8');
    expect(tokens).toMatch(/--font-body: 'DM Sans Variable', 'DM Sans', 'DM Sans Fallback', /);
    // a ch is measured on whichever font draws: 44ch of the stand-in was 80 px narrower than 44ch of DM Sans
    const landing = readFileSync(join(__dirname, '../src/site/landing/landing.css'), 'utf8');
    for (const sel of ['.ld-hero__lede', '.ld-hero__money']) {
      const rule = new RegExp(`\\${sel} \\{[^}]*\\}`).exec(landing)?.[0] ?? '';
      expect(rule, sel).toMatch(/max-width: [\d.]+em;/);
    }
  });

  it('the three upright faces come cut down to basic latin and punctuation, declared after every other face', () => {
    const main = readFileSync(join(__dirname, '../src/main.tsx'), 'utf8');
    const core = main.indexOf("import './design/fonts/core.css'");
    expect(core).toBeGreaterThan(-1);
    for (const other of [
      "import '@fontsource-variable/fraunces/full.css'",
      "import './design/fonts/fraunces-soft.css'",
      "import '@fontsource-variable/dm-sans/opsz.css'",
      "import '@fontsource-variable/geist-mono/wght.css'",
    ])
      expect(core, other).toBeGreaterThan(main.indexOf(other));
    const css = readFileSync(join(__dirname, '../src/design/fonts/core.css'), 'utf8');
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]);
    expect(faces.map((f) => /font-family: '([^']+)'/.exec(f)?.[1]).sort()).toEqual(['DM Sans Variable', 'Fraunces Variable', 'Geist Mono Variable']);
    for (const f of faces) {
      const range = /unicode-range: ([^;]+);/.exec(f)?.[1] ?? '';
      expect(f).toMatch(/font-style: normal;/);
      // basic latin, the signs the copy uses (middle dot, no-break space, minus, dashes, quotes, ellipsis), no letters
      // with accents: those stay with the whole latin file
      for (const cp of [0x20, 0x61, 0x7e, 0xa0, 0xb7, 0xd7, 0x2013, 0x2014, 0x2019, 0x2026, 0x2212]) expect(rangeCovers(range, cp), cp.toString(16)).toBe(true);
      for (const cp of [0xe9, 0xf6, 0xfc, 0xe7, 0x131, 0x152]) expect(rangeCovers(range, cp), cp.toString(16)).toBe(false);
      const file = /src: url\(\.\/([^)]+)\)/.exec(f)?.[1] ?? '';
      expect(readFileSync(join(__dirname, '../src/design/fonts', file)).subarray(0, 4).toString('latin1'), file).toBe('wOF2');
    }
  });

  it('nothing the site, the guide or the game says needs the whole latin files', () => {
    // a character of the copy that only the whole latin file has would make every visit download it next to the cut
    const css = readFileSync(join(__dirname, '../src/design/fonts/core.css'), 'utf8');
    const core = /unicode-range: ([^;]+);/.exec(css)?.[1] ?? '';
    const src = ['../src/i18n/en.ts', '../src/ui/docs/content.en.ts', '../src/ui/docs/facts.ts']
      .map((f) => readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))
      .join('');
    const outside = [...new Set([...src].filter((c) => rangeCovers(LATIN, c.codePointAt(0)!) && !rangeCovers(core, c.codePointAt(0)!)))];
    expect(outside).toEqual([]);
  });
});
