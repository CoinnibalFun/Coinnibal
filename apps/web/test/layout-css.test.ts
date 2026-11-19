// Static layout guards over the app's stylesheets (the browser-based guard is scripts/layout-guard.mjs,
// which needs a Chromium and so runs outside CI's vitest job).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEAT } from '../src/design/motion';

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

  it('keeps the room intro a slim one-line banner and the quiet-pond note a chip (no big card over the play area)', () => {
    const moments = sheets.find((s) => s.file.endsWith('ui/game/moments.css'))!.css;
    const card = /\n\.gm-intro__card \{[^}]*\}/.exec(moments)![0];
    expect(card).toMatch(/white-space: nowrap;/);
    expect(card).toMatch(/border-radius: var\(--r-pill\);/);
    expect(/\n\.gm-intro__card \.av \{[^}]*\}/.exec(moments)![0]).toMatch(/width: 24px;/);
    const rooms = sheets.find((s) => s.file.endsWith('rooms/rooms.css'))!.css;
    expect(/\n\.pq--hud \{[^}]*\}/.exec(rooms)![0]).toMatch(/flex-direction: row;/);
  });

  it('names every @keyframes once across the app (a second sheet would silently replace the first)', () => {
    const names = sheets.flatMap(({ file, css }) => [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => `${m[1]} (${file})`));
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const n of names) {
      const k = n.split(' ')[0];
      if (seen.has(k)) twice.push(`${seen.get(k)} and ${n}`);
      else seen.set(k, n);
    }
    expect(twice).toEqual([]);
  });

  it('keeps every hidden state of the landing reveals inside the motion media query, on the individual transform properties', () => {
    const reveal = sheets.find((s) => s.file.endsWith('landing/reveal.css'))!.css;
    const start = reveal.indexOf('@media (prefers-reduced-motion: no-preference) {');
    expect(start).toBeGreaterThan(0);
    // the block's end: its matching brace
    let depth = 0;
    let end = start;
    for (let i = reveal.indexOf('{', start); i < reveal.length; i++) {
      if (reveal[i] === '{') depth++;
      else if (reveal[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    const outside = reveal.slice(0, start) + reveal.slice(end);
    // reduced motion, print and old browsers never meet a waiting state, a play or a hiding rule
    expect(outside).not.toMatch(/='(wait|in|set)'/);
    expect(outside).not.toMatch(/\banimation:(?!\s*none)/);
    // reveals never set `transform` (the CSS tilts on transform must survive), except the fan dealt from its deck
    const transforms = [...reveal.matchAll(/([^{}]*)\{[^{}]*\btransform:/g)].map((m) => m[1].trim());
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms.filter((sel) => !sel.endsWith('.ld-fan__card'))).toEqual([]);
    // the beat in CSS and in motion.ts are one number
    expect(tokens).toMatch(new RegExp(`--beat:\\s*${Math.round(BEAT * 1000)}ms`));
  });

  it('has no shop key on the in-game top bar (the shop is in the lobby only)', () => {
    const hud = readFileSync(join(SRC, 'ui/game/GameHud.tsx'), 'utf8');
    expect(hud).not.toMatch(/openModal\('shop'\)/);
    expect(hud).not.toMatch(/hud-shop/);
  });

  it('hangs toasts over the sheets and under the connection banner, a short note on one line in a game', () => {
    const story = sheets.find((s) => s.file.endsWith('storybook.css'))!.css;
    const conn = sheets.find((s) => s.file.endsWith('ui/game/connection.css'))!.css;
    const z = (css: string, sel: string) => Number(/z-index:\s*(\d+)/.exec(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{[^}]*\\}`).exec(css)![0])![1]);
    // the play-test's "Added: +3 Magnet, …" hung dimmed under the shop's scrim, its tape under the sheet's corner
    expect(z(story, '.kb-toasts')).toBeGreaterThan(z(story, '.kb-sheet-layer'));
    expect(z(story, '.kb-toasts')).toBeLessThan(z(conn, '.g-conn'));
    // "You are invisible for 10 s." printed "s." alone on a second line over the coin
    expect(/\n\.kb-toasts\.kb-toasts--game \{[^}]*\}/.exec(story)![0]).toMatch(/width: min\(400px,/);
    expect(/\n\.kb-toast__title \{[^}]*\}/.exec(story)![0]).toMatch(/text-wrap: balance;/);
    expect(/\n\.kb-receipt__title \{[^}]*\}/.exec(story)![0]).toMatch(/text-wrap: balance;/);
  });

  it('keeps the shop cart over the packs: only a pack with its note open rides above it', () => {
    const shop = sheets.find((s) => s.file.endsWith('ui/shop/shop.css'))!.css;
    expect(/\n\.sh-cart \{[^}]*\}/.exec(shop)![0]).toMatch(/position: sticky;[^}]*z-index: 2;/);
    // a pack under the pointer (or with its + focused) covered the cart's total
    expect(shop).not.toMatch(/\.sh-pack:hover|\.sh-pack:focus-within/);
    expect(shop).toMatch(/\.sh-pack:has\(\.sh-info:hover, \.sh-info:focus-within, \.sh-info\.is-open\) \{\s*z-index: 3;/);
  });

  it('wraps the labels that carry information instead of cutting them', () => {
    const lobby = sheets.find((s) => s.file.endsWith('ui/lobby/lobby.css'))!.css;
    const game = sheets.find((s) => s.file.endsWith('ui/game/game.css'))!.css;
    const news = sheets.find((s) => s.file.endsWith('ui/news/news.css'))!.css;
    // "Rookie and Pro ponds · people only" (cut to "· P…"), a private room's "29:32 left" (cut to "29:32 L…")
    for (const block of [/\n\.kl-ticket \.kb-ticket__meta \{[^}]*\}/.exec(lobby)![0], /\n\.g-pond__label \{[^}]*\}/.exec(game)![0]]) {
      expect(block).not.toMatch(/text-overflow: ellipsis|white-space: nowrap/);
      expect(block).toMatch(/text-wrap: (pretty|balance);/);
    }
    // the final board's kills column holds its heading (at 36 px "KILLS" ran into "PAYOUT")
    const cols = /\n\.g-board__row\.has-value \{[^}]*grid-template-columns: ([^;]+);/.exec(game)![1].split(/\s+(?![^(]*\))/);
    expect(Number.parseInt(cols[3], 10)).toBeGreaterThanOrEqual(44);
    // four standings tabs: a phone wraps the last ones instead of scrolling "Last rounds" out of view
    expect(/\n\.nw-tabs \{[^}]*\}/.exec(news)![0]).toMatch(/flex-wrap: wrap;/);
  });
});
