// Static layout guards over the app's stylesheets (the browser-based guard is scripts/layout-guard.mjs,
// which needs a Chromium and so runs outside CI's vitest job).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
/** The design gallery is a dev-only specimen sheet, not a page players see. */
const SKIP = new Set(['design/gallery.css']);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith('.css') && !SKIP.has(relative(SRC, p).replace(/\\/g, '/')) ? [p] : [];
  });
}
const sheets = cssFiles(SRC).map((p) => ({ file: relative(SRC, p), css: readFileSync(p, 'utf8') }));
const tokens = readFileSync(join(SRC, 'design/tokens.css'), 'utf8');

describe('layout css', () => {
  it('finds the stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(15);
  });

  it('sets no text below the 12 px readable floor', () => {
    const small: string[] = [];
    for (const { file, css } of sheets)
      for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) if (Number(m[1]) < 12) small.push(`${file}: ${m[0]}`);
    expect(small).toEqual([]);
    expect(tokens).toMatch(/--t-micro:\s*12px/);
  });

  it('sizes sheets to the visible viewport and keeps them clear of the notch and home bar', () => {
    const story = sheets.find((s) => s.file.endsWith('storybook.css'))!.css;
    const layer = /\.kb-sheet-layer \{[^}]*\}/.exec(story)![0];
    expect(layer).toMatch(/safe-area-inset-top/);
    expect(layer).toMatch(/safe-area-inset-bottom/);
    const bottom = /\.kb-sheet\.is-bottom \{[^}]*\}/.exec(story)![0];
    expect(bottom).toMatch(/dvh/);
    expect(bottom).toMatch(/safe-area-inset-bottom/);
    expect([...story.matchAll(/\.kb-sheet__body \{[^}]*\}/g)].some((m) => /overflow-y: auto/.test(m[0]))).toBe(true);
  });

  it('scales the desktop HUD on large screens', () => {
    const game = sheets.find((s) => s.file.endsWith('ui/game/game.css'))!.css;
    expect(game).toMatch(/\.g-hud\.is-desktop > :is\([^)]*\.g-corner[^)]*\) \{\s*zoom: var\(--hud-scale\);/);
  });

  it('keeps the chat at the bottom left (transparent: no panel), docked between the kill feed and the key hints on a desktop', () => {
    const game = sheets.find((s) => s.file.endsWith('ui/game/game.css'))!.css;
    const stream = /\n\.g-stream \{[^}]*\}/.exec(game)![0];
    expect(stream).toMatch(/\bleft:/);
    expect(stream).toMatch(/\bbottom:/);
    expect(stream).not.toMatch(/\bright:/);
    expect(stream).not.toMatch(/background/);
    expect(game).toMatch(/\.g-bl > \.g-stream\.is-docked \{[^}]*position: relative;/);
    // touch: above the thumb stick, never under it
    expect(/\.g-hud\.is-touch \.g-stream \{[^}]*\}/.exec(game)![0]).toMatch(/bottom: calc\(22px \+ 136px/);
  });
});
