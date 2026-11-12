import { describe, expect, it } from 'vitest';
import { BRAND_NAME, BRAND_TAGLINE, NFT_NAME, SITE_HOST_DEFAULT, SITE_URL_DEFAULT, SITE_X_HANDLE_DEFAULT, isReservedName, sanitizeName, siteHostOf, BRAND_SITE_ORIGINS, withBrandOrigins } from '../src';

describe('brand', () => {
  it('is Coinnibal, with the live domain and X handle as defaults until the new ones are live', () => {
    expect(BRAND_NAME).toBe('Coinnibal');
    expect(NFT_NAME).toBe('Coinnibal');
    expect(BRAND_TAGLINE).toBe('Eat or be eaten.');
    expect(SITE_HOST_DEFAULT).toBe('elymum.io');
    expect(SITE_URL_DEFAULT).toBe('https://elymum.io');
    expect(SITE_X_HANDLE_DEFAULT).toBe('elymumio');
  });

  it('siteHostOf: the host of a configured origin, else the default', () => {
    expect(siteHostOf('https://coinnibal.fun')).toBe('coinnibal.fun');
    expect(siteHostOf('https://coinnibal.fun/')).toBe('coinnibal.fun');
    expect(siteHostOf('http://localhost:5173')).toBe('localhost:5173');
    expect(siteHostOf(null)).toBe('elymum.io');
    expect(siteHostOf('')).toBe('elymum.io');
    expect(siteHostOf('not a url')).toBe('elymum.io');
    expect(siteHostOf(undefined, 'x.example')).toBe('x.example');
  });

  it('player names cannot pose as the game, old name or new', () => {
    for (const n of ['Coinnibal', 'COINNIBAL Support', 'c.o.i.n.n.i.b.a.l', 'C0innibal', 'Elymum', 'E1ymum']) expect(isReservedName(n)).toBe(true);
    expect(isReservedName('Coin Nibbler')).toBe(false);
    expect(sanitizeName('Coinnibal')).toBe('Coinie');
  });

  it('adds the brand site origins to a CORS list, and leaves * and unset alone', () => {
    expect(withBrandOrigins(undefined)).toBe('*');
    expect(withBrandOrigins('*')).toBe('*');
    expect(withBrandOrigins('https://elymum.io/')).toBe(['https://elymum.io', ...BRAND_SITE_ORIGINS].join(','));
    expect(withBrandOrigins('https://coinnibal.fun, https://elymum.io').split(',')).toEqual(['https://coinnibal.fun', 'https://elymum.io', 'https://www.coinnibal.fun']);
  });
});
