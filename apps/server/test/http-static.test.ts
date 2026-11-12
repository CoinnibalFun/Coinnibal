import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { createHttpServer, redactUrls } from '../src/http';

/** The single-origin deploy (`WEB_DIST`): static files plus the SPA fallback for client routes like `/docs`. */
describe('static web client', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  async function start(): Promise<string> {
    const web = mkdtempSync(join(tmpdir(), 'elymum-web-'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Elymum</title>');
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'assets', 'app-1234.js'), 'console.log(1)');
    writeFileSync(join(web, 'favicon-32.png'), 'png');
    writeFileSync(join(web, 'sitemap.xml'), '<urlset/>');
    writeFileSync(join(web, 'assets', 'bell-1234.ogg'), 'ogg');
    const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-data-')), WEB_DIST: web } as NodeJS.ProcessEnv);
    server = createHttpServer(cfg, { chain: new NullChain(), rooms: {} as never, leaderboards: {} as never, auth: {} as never, startedAt: Date.now() });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  it('serves index.html for the player guide path /docs (SPA fallback)', async () => {
    const url = await start();
    for (const path of ['/docs', '/docs/', '/']) {
      const res = await fetch(url + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/text\/html/);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'");
      expect(await res.text(), path).toContain('<title>Elymum</title>');
    }
  });

  it('serves hashed assets immutable and 404s missing files and API paths', async () => {
    const url = await start();
    const asset = await fetch(`${url}/assets/app-1234.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toMatch(/immutable/);
    // a missing file with an extension is not the SPA
    expect((await fetch(`${url}/assets/missing.js`)).status).toBe(404);
    // what vercel.json did for the site, now that the server serves it: /favicon.ico is the 32 px PNG, and the
    // sitemap and the sounds carry their real types
    const ico = await fetch(`${url}/favicon.ico`);
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${url}/sitemap.xml`)).headers.get('content-type')).toMatch(/^application\/xml/);
    expect((await fetch(`${url}/assets/bell-1234.ogg`)).headers.get('content-type')).toBe('audio/ogg');
    // API paths and missing files with an extension (e.g. the removed /pass/<n>.json) never fall back to index.html
    const api = await fetch(`${url}/api/docs`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toMatch(/json/);
    expect((await fetch(`${url}/pass/1.json`)).headers.get('content-type')).toMatch(/json/);
  });

  it('answers an unexpected error with a generic 500 and logs the details with URLs redacted', async () => {
    const logs: string[] = [];
    const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-data-')) } as NodeJS.ProcessEnv);
    const boom = () => {
      throw new Error('HTTP request failed. URL: https://rpc.example/v2/SECRETKEY123?apikey=SECRET2');
    };
    server = createHttpServer(cfg, { chain: new NullChain(), rooms: { online: boom, list: boom } as never, leaderboards: {} as never, auth: {} as never, startedAt: Date.now(), log: (m) => logs.push(m) });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const res = await fetch(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/rooms`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal', message: 'internal server error' });
    expect(text).not.toMatch(/SECRET|rpc\.example/);
    expect(logs.join('\n')).toMatch(/\/api\/rooms failed: Error: HTTP request failed/);
    expect(logs.join('\n')).not.toMatch(/SECRET/);
    expect(redactUrls('see wss://a.example:8443/k/abc?x=1 and http://b.example')).toBe('see wss://a.example:8443/<redacted> and http://b.example/<redacted>');
  });

  it('without WEB_DIST in production a page of the game domain redirects to the site (one copy of the web app)', async () => {
    const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-data-')), NODE_ENV: 'production', PUBLIC_URL: 'https://elymum.io' } as NodeJS.ProcessEnv);
    server = createHttpServer(cfg, { chain: new NullChain(), rooms: { online: () => 0, list: () => [] } as never, leaderboards: {} as never, auth: {} as never, startedAt: Date.now() });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const page = await fetch(`${base}/play?room=AB2CD`, { redirect: 'manual' });
    expect(page.status).toBe(301);
    expect(page.headers.get('location')).toBe('https://elymum.io/play?room=AB2CD');
    // the API is served here, not redirected
    expect((await fetch(`${base}/api/nope`, { redirect: 'manual' })).status).toBe(404);
  });

  it('the bundled web app (WEB_DIST) is served with a strict CSP: scripts from this origin only', async () => {
    const { WEB_CSP } = await import('../src/http');
    expect(WEB_CSP).toMatch(/script-src 'self';/);
    expect(WEB_CSP).toMatch(/frame-ancestors 'none'/);
    expect(WEB_CSP).toMatch(/object-src 'none'/);
    expect(WEB_CSP).not.toMatch(/unsafe-eval/);
  });
});
