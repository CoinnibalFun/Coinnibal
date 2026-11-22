import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every TypeScript source under src/ (recursively). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

// Strip comments so prose such as "no fillText" does not trip the guard.
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('source guard', () => {
  const files = sources(join(__dirname, '..', 'src'));

  it('finds the sources', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // The art must render identically in browsers and in @napi-rs/canvas:
  // canvas filters and text rendering differ between the two (and fonts may be missing).
  // One exception: the Appetizer card is a picture of text (a menu), drawn with the fonts its caller registers
  // (`AppetizerFonts`); its test draws it on @napi-rs/canvas. It still uses no filter.
  const TEXT_OK = new Set(['appetizer.ts']);
  it.each(files.map((f) => [f.slice(f.indexOf('src')), f]))('%s uses no ctx.filter and no canvas text', (_name, file) => {
    const src = code(readFileSync(file, 'utf8'));
    expect(src).not.toMatch(/\.filter\s*=(?!=)/);
    if (!TEXT_OK.has(file.split(/[\\/]/).pop()!)) expect(src).not.toMatch(/\b(fillText|strokeText|measureText)\b/);
  });
});
