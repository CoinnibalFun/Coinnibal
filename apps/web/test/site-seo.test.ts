import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { CLOSED_META, NOT_FOUND_META, PAGE_META, setPageHead } from '../src/site/seo';

const head = () => ({
  canon: document.head.querySelector('link[rel="canonical"]')?.getAttribute('href'),
  og: document.head.querySelector('meta[property="og:url"]')?.getAttribute('content'),
  robots: document.head.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
});

describe('per-page head tags', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="canonical" href="https://elymum.io/" /><meta property="og:url" content="https://elymum.io/" />';
  });

  it('points canonical and og:url at the page, on the build origin', () => {
    setPageHead('/mint');
    expect(head()).toEqual({ canon: 'https://elymum.io/mint', og: 'https://elymum.io/mint', robots: null });
    setPageHead('/');
    expect(head().canon).toBe('https://elymum.io/');
  });

  it('marks the not-found page noindex, and drops it again on a real page', () => {
    setPageHead('/nope', false);
    expect(head().robots).toBe('noindex');
    setPageHead('/docs');
    expect(head().robots).toBeNull();
  });

  it("gives the guide its own title and description in the share tags, and the other pages index.html's", () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="description" content="Home text" /><meta property="og:title" content="Home title" /><meta property="og:description" content="Home og" />' +
        '<meta name="twitter:title" content="Home title" /><meta name="twitter:description" content="Home og" />',
    );
    const tags = () =>
      ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[name="twitter:title"]', 'meta[name="twitter:description"]'].map(
        (s) => document.head.querySelector(s)?.getAttribute('content'),
      );
    setPageHead('/docs');
    const docs = PAGE_META['/docs'];
    expect(tags()).toEqual([docs.description, docs.title, docs.description, docs.title, docs.description]);
    // the same name as the browser tab, and nothing a visitor page must not say
    expect(docs.title).toBe(en['site.title.docs']);
    expect(JSON.stringify(docs)).not.toMatch(/testnet|faucet|\bsoon\b/i);
    expect(JSON.stringify(docs)).not.toMatch(/\bNIBAL\b|\$[A-Z]{3,}/);
    setPageHead('/');
    expect(tags()).toEqual(['Home text', 'Home title', 'Home og', 'Home title', 'Home og']);
    setPageHead('/docs');
    setPageHead('/nope', false);
    const missing = PAGE_META[NOT_FOUND_META];
    expect(tags()).toEqual([missing.description, missing.title, missing.description, missing.title, missing.description]);
    setPageHead('/');
    expect(tags()[0]).toBe('Home text');
  });

  it('a closed page (noindex) shares as "Not open yet" and never names itself; an unknown path as "Page not found"', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="description" content="Home text" /><meta property="og:title" content="Home title" />');
    const tags = () => ['meta[name="description"]', 'meta[property="og:title"]'].map((s) => document.head.querySelector(s)?.getAttribute('content'));
    const closed = PAGE_META[CLOSED_META];
    for (const path of ['/mint', '/faucet', '/collab']) {
      setPageHead(path, false);
      expect(tags()).toEqual([closed.description, closed.title]);
    }
    // the same words as the browser tab; nothing a visitor page must not say
    expect(closed.title).toBe(en['site.title.closed']);
    expect(PAGE_META[NOT_FOUND_META].title).toBe(en['site.nf.docTitle']);
    for (const m of [closed, PAGE_META[NOT_FOUND_META]]) expect(JSON.stringify(m)).not.toMatch(/testnet|faucet|test tokens?|mint|\bsoon\b|\bNIBAL\b/i);
    setPageHead('/nope', false);
    expect(tags()[1]).toBe(PAGE_META[NOT_FOUND_META].title);
    // open again: the site's own words
    setPageHead('/mint');
    expect(tags()).toEqual(['Home text', 'Home title']);
  });

  it("index.html's own words promise no payout and name no test network (a fee comes off a win)", () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    const words = [...html.matchAll(/<(?:title|meta[^>]+(?:description|title)")[^>]*?(?:content="([^"]*)"|>([^<]*)<)/g)].map((m) => m[1] ?? m[2]);
    expect(words.length).toBeGreaterThan(4);
    for (const w of words) expect(w).not.toMatch(/is yours|testnet|faucet|test tokens?|\bnibal\b|Elymum|Elysium/i);
  });

  it('ships robots.txt and a sitemap (the SPA rewrite would answer them with the landing HTML)', () => {
    const pub = resolve(__dirname, '../public');
    expect(readFileSync(resolve(pub, 'robots.txt'), 'utf8')).toMatch(/Sitemap: https:\/\/coinnibal\.fun\/sitemap\.xml/);
    const sitemap = readFileSync(resolve(pub, 'sitemap.xml'), 'utf8');
    // a static file cannot follow the admin's settings: only the pages that are always open are listed
    for (const p of ['/', '/docs']) expect(sitemap).toContain(`https://coinnibal.fun${p}<`);
    for (const p of ['/play', '/mint', '/wl', '/collab', '/faucet']) expect(sitemap).not.toContain(`https://coinnibal.fun${p}<`);
  });
});
