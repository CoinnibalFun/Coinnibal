import { describe, expect, it } from 'vitest';
import { BRAND_NAME, BRAND_TAGLINE, NFT_NAME, SITE_HOST_DEFAULT, SITE_URL_DEFAULT, SITE_X_HANDLE_DEFAULT, isReservedName, sanitizeName, siteHostOf, BRAND_SITE_ORIGINS, OPEN_PLAY_ORIGINS, isOpenPlayOrigin, withBrandOrigins } from '../src';

describe('brand', () => {
  it('is Coinnibal, with the live domain and X handle as defaults until the new ones are live', () => {
    expect(BRAND_NAME).toBe('Coinnibal');
    expect(NFT_NAME).toBe('Coinnibal');
    expect(BRAND_TAGLINE).toBe('Eat or be eaten.');
    expect(SITE_HOST_DEFAULT).toBe('coinnibal.fun');
    expect(SITE_URL_DEFAULT).toBe('https://coinnibal.fun');
    expect(SITE_X_HANDLE_DEFAULT).toBe('coinnibalfun');
  });

  it('siteHostOf: the host of a configured origin, else the default', () => {
    expect(siteHostOf('https://coinnibal.fun')).toBe('coinnibal.fun');
    expect(siteHostOf('https://coinnibal.fun/')).toBe('coinnibal.fun');
    expect(siteHostOf('http://localhost:5173')).toBe('localhost:5173');
    expect(siteHostOf(null)).toBe('coinnibal.fun');
    expect(siteHostOf('')).toBe('coinnibal.fun');
    expect(siteHostOf('not a url')).toBe('coinnibal.fun');
    expect(siteHostOf(undefined, 'x.example')).toBe('x.example');
  });

  it('player names cannot pose as the game, old name or new', () => {
    for (const n of ['Coinnibal', 'COINNIBAL Support', 'c.o.i.n.n.i.b.a.l', 'C0innibal', 'Elymum', 'E1ymum']) expect(isReservedName(n)).toBe(true);
    expect(isReservedName('Coin Nibbler')).toBe(false);
    expect(sanitizeName('Coinnibal', 'Coinie-0a1b')).toBe('Coinie-0a1b');
  });

  it('adds the brand site origins to a CORS list, and leaves * and unset alone', () => {
    // elymum.io, the domain of before the rename, stays a brand origin while the live config redirects it; the
    // open-play copy is one too (CORS and its own sign-in domain)
    expect(BRAND_SITE_ORIGINS).toEqual(['https://coinnibal.fun', 'https://www.coinnibal.fun', 'https://elymum.io', 'https://coinnibal.vercel.app']);
    expect(withBrandOrigins(undefined)).toBe('*');
    expect(withBrandOrigins('*')).toBe('*');
    expect(withBrandOrigins('https://coinnibal.fun/')).toBe('https://coinnibal.fun,https://www.coinnibal.fun,https://elymum.io,https://coinnibal.vercel.app');
    expect(withBrandOrigins('https://admin.example')).toBe(['https://admin.example', ...BRAND_SITE_ORIGINS].join(','));
    expect(withBrandOrigins('https://coinnibal.fun, https://admin.example').split(',')).toEqual(['https://coinnibal.fun', 'https://admin.example', 'https://www.coinnibal.fun', 'https://elymum.io', 'https://coinnibal.vercel.app']);
  });

  it('knows the open-play copies of the site by their exact Origin', () => {
    expect(OPEN_PLAY_ORIGINS).toEqual(['https://coinnibal.vercel.app']);
    for (const o of OPEN_PLAY_ORIGINS) expect(BRAND_SITE_ORIGINS).toContain(o);
    expect(isOpenPlayOrigin('https://coinnibal.vercel.app')).toBe(true);
    expect(isOpenPlayOrigin('https://coinnibal.vercel.app/')).toBe(true);
    expect(isOpenPlayOrigin('https://coinnibal.fun')).toBe(false);
    expect(isOpenPlayOrigin('http://coinnibal.vercel.app')).toBe(false);
    expect(isOpenPlayOrigin('https://evil-coinnibal.vercel.app')).toBe(false);
    expect(isOpenPlayOrigin('https://coinnibal.vercel.app.evil.example')).toBe(false);
    expect(isOpenPlayOrigin('null')).toBe(false);
    expect(isOpenPlayOrigin(undefined)).toBe(false);
    expect(isOpenPlayOrigin(null)).toBe(false);
  });
});
