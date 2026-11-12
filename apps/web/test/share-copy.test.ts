import { describe, expect, it } from 'vitest';
import { formatMessage, LOCALES, loadLocale, translate, type Dict, type Locale, type TKey } from '../src/i18n';
import { en } from '../src/i18n/en';
import { gameShareText, killShareText, liveShareText, pickShareKey, resultShareText, SHARE_VARIANTS, X_MAX, xLength } from '../src/ui/game/ShareOnX';

const t = (k: TKey, v?: Record<string, string | number>) => translate(k, v);
const varsOf = (s: string) => [...new Set([...s.matchAll(/\{(\w+)(?:, plural,|\})/g)].map((m) => m[1]))].sort();

/** The placeholders each post's call supplies (and every line of it must use). */
const NEEDS: Record<keyof typeof SHARE_VARIANTS, string[]> = {
  kill: ['name'],
  result: ['n', 'rank', 'room'],
  resultAte: ['n', 'names', 'rank', 'room'],
  game: ['eaten', 'mass', 'room'],
  live: ['eaten', 'mass', 'n', 'rank', 'room'],
  liveMass: ['eaten', 'mass', 'room'],
};
const KINDS = Object.keys(SHARE_VARIANTS) as (keyof typeof SHARE_VARIANTS)[];

async function dicts(): Promise<[Locale, Dict][]> {
  const all: [Locale, Dict][] = [['en', en as Dict]];
  for (const l of LOCALES) if (l.code !== 'en') all.push([l.code, await loadLocale(l.code)]);
  return all;
}

describe('the X share posts: four lines each, picked from the moment', () => {
  it('each post has four distinct lines, the first under its old key', () => {
    for (const kind of KINDS) {
      const keys = SHARE_VARIANTS[kind];
      expect(keys).toHaveLength(4);
      expect(keys[0]).toBe(`share.${kind}`);
      expect(new Set(keys.map((k) => en[k])).size).toBe(4);
    }
  });

  it('the pick is deterministic (same inputs, same line) and every line comes up over varied inputs', () => {
    for (const kind of KINDS) {
      const seen = new Set<TKey>();
      for (let i = 0; i < 200; i++) {
        const seed = [`Coin${i}`, i % 17, 'Pond'];
        const key = pickShareKey(kind, seed);
        expect(pickShareKey(kind, [...seed])).toBe(key);
        seen.add(key);
      }
      expect([...seen].sort()).toEqual([...SHARE_VARIANTS[kind]].sort());
    }
    // the helpers agree with themselves: the preview and the posted text are the same line
    const kill = { id: 'KiLL123456', victim: 'Penny', victimX: 'penny_x' };
    expect(killShareText(t, kill)).toBe(killShareText(t, { ...kill }));
    expect(resultShareText(t, { rank: 4, n: 9, room: 'Pond', eaten: [{ name: 'Zed' }] })).toBe(resultShareText(t, { rank: 4, n: 9, room: 'Pond', eaten: [{ name: 'Zed' }] }));
    expect(gameShareText(t, { mass: 99.9, eaten: 0, room: 'Pond' })).toBe(gameShareText(t, { mass: 99.2, eaten: 0, room: 'Pond' }));
    expect(liveShareText(t, { mass: 50, rank: 3, n: 8, eaten: 1, room: 'Pond' })).toBe(liveShareText(t, { mass: 50, rank: 3, n: 8, eaten: 1, room: 'Pond' }));
    // different kills read differently
    const lines = new Set(Array.from({ length: 40 }, (_, i) => killShareText(t, { id: `KiLL${i}`, victim: 'Penny' })));
    expect(lines.size).toBe(4);
  });

  it('the helpers fill in the right name, @handle, place and numbers', () => {
    const kill = killShareText(t, { id: 'KiLLaaaaaa', victim: 'Penny', victimX: 'penny_x' });
    expect(SHARE_VARIANTS.kill.map((k) => t(k, { name: '@penny_x' }))).toContain(kill);
    const res = resultShareText(t, { rank: 7, n: 9, room: '$5 Room' });
    expect(res).toMatch(/#7 of 9 in \$5 Room on Coinnibal/);
    const ate = resultShareText(t, { rank: 2, n: 5, room: 'Pond', eaten: [{ name: 'Penny', xHandle: 'penny_x' }, { name: 'Rocky', n: 2 }] });
    expect(ate).toContain('@penny_x, Rocky ×2');
    expect(gameShareText(t, { mass: 1, eaten: 1, room: 'Pond' })).toMatch(/1 coin\b/);
    expect(liveShareText(t, { mass: 1234.5, rank: 0, n: 0, eaten: 2, room: 'Pond' })).toMatch(/1,234.*2 coins/);
  });

  it('every line in every language keeps the placeholders its call supplies, names Coinnibal, and fills in cleanly', async () => {
    const bad: string[] = [];
    const sample = { name: '@penny_x', names: 'Penny, Rocky ×2', rank: 3, n: 9, room: 'Pond', mass: '1,234', eaten: 5 };
    for (const [code, dict] of await dicts())
      for (const kind of KINDS)
        for (const key of SHARE_VARIANTS[kind]) {
          const s = dict[key];
          if (varsOf(s).join() !== NEEDS[kind].join()) bad.push(`${code} ${key}: [${varsOf(s)}] != [${NEEDS[kind]}]`);
          if (!s.includes('Coinnibal')) bad.push(`${code} ${key}: no Coinnibal`);
          for (const eaten of [0, 1, 2, 5, 21]) {
            const out = formatMessage(s, { ...sample, eaten }, code);
            if (/[{}]/.test(out)) bad.push(`${code} ${key}: unfilled "${out}"`);
          }
        }
    expect(bad).toEqual([]);
  });

  it("stays within X's 280 characters (link 23, coin 2, TEST) with the longest names, rooms and eaten lists", async () => {
    const name = 'W'.repeat(16);
    const room = 'W'.repeat(26);
    const eaten = Array.from({ length: 5 }, () => ({ name, bot: true, n: 99 }));
    const over: string[] = [];
    for (const [code, dict] of await dicts()) {
      const tl = (k: TKey, v?: Record<string, string | number>) => formatMessage(dict[k], v, code);
      const posts: string[] = [];
      for (let i = 0; i < 40; i++) {
        posts.push(killShareText(tl, { id: `KiLL${i}`, victim: name, victimIsBot: true, test: true }));
        posts.push(resultShareText(tl, { rank: 100 + i, n: 199, room, eaten, eatenMore: 999, test: true }));
        posts.push(resultShareText(tl, { rank: 100 + i, n: 199, room, test: true }));
        posts.push(gameShareText(tl, { mass: 9_999_999 - i, eaten: 999, room, test: true }));
        posts.push(liveShareText(tl, { mass: 9_999_999 - i, rank: 100 + i, n: 199, eaten: 999, room, test: true }));
        posts.push(liveShareText(tl, { mass: 9_999_999 - i, rank: 0, n: 0, eaten: 999, room, test: true }));
      }
      for (const p of posts) if (xLength(p) + 27 > X_MAX) over.push(`${code} (${xLength(p) + 27}): ${p}`);
      // the long eaten list still shows some names (the rest fold into +N)
      expect(resultShareText(tl, { rank: 1, n: 2, room, eaten, eatenMore: 999, test: true })).toContain(name);
    }
    expect(over).toEqual([]);
  });

  it('counts as X does: CJK and emoji weigh 2', () => {
    expect(xLength('abc')).toBe(3);
    expect(xLength('Привет')).toBe(6);
    expect(xLength('我饿了')).toBe(6);
    expect(xLength('\u{1FA99}')).toBe(2);
  });
});
