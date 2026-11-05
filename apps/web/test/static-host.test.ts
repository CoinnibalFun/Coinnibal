import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveServer } from '../src/config';

const page = { protocol: 'https:', host: 'elymum.io' };

describe('where the browser reaches the game server', () => {
  it('goes straight to the game server for the API and the socket when the site is on a static host', () => {
    expect(resolveServer({ server: 'https://game.elymum.io' }, page)).toEqual({ http: 'https://game.elymum.io', ws: 'wss://game.elymum.io/ws' });
    // a deployment that only set VITE_WS_URL: the API goes to that origin too (not through the static host)
    expect(resolveServer({ ws: 'wss://game.elymum.io' }, page)).toEqual({ http: 'https://game.elymum.io', ws: 'wss://game.elymum.io/ws' });
    expect(resolveServer({ ws: 'wss://game.elymum.io/ws/' }, page)).toEqual({ http: 'https://game.elymum.io', ws: 'wss://game.elymum.io/ws' });
  });

  it('is the page itself when the server serves the client (Docker, pnpm dev)', () => {
    expect(resolveServer({}, page)).toEqual({ http: 'https://elymum.io', ws: 'wss://elymum.io/ws' });
    expect(resolveServer({}, { protocol: 'http:', host: 'localhost:5173' })).toEqual({ http: 'http://localhost:5173', ws: 'ws://localhost:5173/ws' });
  });

  it('vercel.json proxies only what must live on the site domain, and the site runs only its own scripts', () => {
    const v = JSON.parse(readFileSync(join(__dirname, '../../../vercel.json'), 'utf8')) as {
      rewrites: { source: string; destination: string }[];
      headers: { headers: { key: string; value: string }[] }[];
    };
    const proxied = v.rewrites.filter((r) => r.destination.startsWith('https://')).map((r) => r.source);
    expect(proxied.sort()).toEqual(['/api/nft/:path*', '/share/:path*']);
    const csp = v.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')!.value;
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
  });
});
