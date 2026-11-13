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

  it('vercel.json only sends elymum.io (the old Vercel site) to coinnibal.fun, path and all: the site lives on the VPS', () => {
    const v = JSON.parse(readFileSync(join(__dirname, '../../../vercel.json'), 'utf8')) as {
      redirects: { source: string; destination: string; permanent: boolean }[];
      rewrites?: unknown;
    };
    expect(v.redirects).toEqual([{ source: '/:path*', destination: 'https://coinnibal.fun/:path*', permanent: true }]);
    expect(v.rewrites).toBeUndefined();
  });
});
