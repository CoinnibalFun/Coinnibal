import { describe, expect, it } from 'vitest';
import { appEntry, ENTRY_PATHS, isAppRoute, normalizePath, SITE_PATHS } from '../src/routes';

describe('app routes (shared by the web router and the server)', () => {
  it('every site page and entry is a route, in any spelling the router accepts', () => {
    for (const p of [...SITE_PATHS, ...ENTRY_PATHS]) {
      expect(isAppRoute(p), p).toBe(true);
      expect(isAppRoute(`${p}/`), `${p}/`).toBe(true);
      expect(isAppRoute(p.toUpperCase()), p.toUpperCase()).toBe(true);
    }
    expect(normalizePath('/Docs//')).toBe('/docs');
    expect(normalizePath('')).toBe('/');
  });

  it('anything else is not found', () => {
    for (const p of ['/nope', '/docs/rooms', '/mint/1', '/playground', '/admins', '/share', '/api', '/index']) expect(isAppRoute(p), p).toBe(false);
  });

  it('names the bundle entry a path opens', () => {
    expect(appEntry('/play')).toBe('play');
    expect(appEntry('/Play/')).toBe('play');
    expect(appEntry('/admin')).toBe('admin');
    expect(appEntry('/')).toBe('site');
    expect(appEntry('/docs')).toBe('site');
    expect(appEntry('/nope')).toBe('site');
  });
});
