import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { byteRange, createHttpServer, redactUrls } from '../src/http';

/** The single-origin deploy (`WEB_DIST`): static files plus the SPA fallback for client routes like `/docs`. */
describe('static web client', () => {
  let server: Server | null = null;
  let webRoot = '';
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
    mkdirSync(join(web, 'media'));
    writeFileSync(join(web, 'media', 'loop.mp4'), '0123456789');
    writeFileSync(join(web, 'media', 'loop.webm'), 'webm');
    // far larger than a socket buffer: a client that hangs up after the first chunk leaves the transfer unfinished
    writeFileSync(join(web, 'media', 'big.mp4'), Buffer.alloc(16 * 1024 * 1024, 1));
    webRoot = web;
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

  it('serves the videos with their types and answers one byte range of a real file (206, Content-Range, Content-Length)', async () => {
    const url = await start();
    const whole = await fetch(url + '/media/loop.mp4');
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('content-length')).toBe('10');
    expect(whole.headers.get('content-range')).toBeNull();
    expect(await whole.text()).toBe('0123456789');
    const webm = await fetch(url + '/media/loop.webm');
    expect([webm.headers.get('content-type'), webm.headers.get('accept-ranges')]).toEqual(['video/webm', 'bytes']);
    await webm.arrayBuffer();

    // Safari's probe, an open end, a suffix, an end past the file
    const cases: [string, string, string][] = [
      ['bytes=0-1', 'bytes 0-1/10', '01'],
      ['bytes=7-', 'bytes 7-9/10', '789'],
      ['bytes=-3', 'bytes 7-9/10', '789'],
      ['bytes=-30', 'bytes 0-9/10', '0123456789'],
      ['bytes=4-400', 'bytes 4-9/10', '456789'],
      ['bytes=5-5', 'bytes 5-5/10', '5'],
    ];
    for (const [range, contentRange, body] of cases) {
      const res = await fetch(url + '/media/loop.mp4', { headers: { Range: range } });
      expect(res.status, range).toBe(206);
      expect(res.headers.get('content-range'), range).toBe(contentRange);
      expect(res.headers.get('content-length'), range).toBe(String(body.length));
      expect(res.headers.get('content-type'), range).toBe('video/mp4');
      expect(await res.text(), range).toBe(body);
    }
    // a HEAD with a range: the same headers, no body
    const head = await fetch(url + '/media/loop.mp4', { method: 'HEAD', headers: { Range: 'bytes=2-3' } });
    expect([head.status, head.headers.get('content-range'), head.headers.get('content-length')]).toEqual([206, 'bytes 2-3/10', '2']);
  });

  it('answers a range past the end with 416 and bytes */size, and sends the whole file for a range it cannot use', async () => {
    const url = await start();
    for (const range of ['bytes=10-', 'bytes=10-12', 'bytes=-0']) {
      const res = await fetch(url + '/media/loop.mp4', { headers: { Range: range } });
      expect(res.status, range).toBe(416);
      expect(res.headers.get('content-range'), range).toBe('bytes */10');
      expect(await res.text(), range).toBe('');
    }
    // several ranges, another unit, a reversed range, garbage: RFC 9110 lets the server ignore the header
    for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=5-2', 'bytes=-', 'bytes=a-b']) {
      const res = await fetch(url + '/media/loop.mp4', { headers: { Range: range } });
      expect([res.status, await res.text()], range).toEqual([200, '0123456789']);
    }
    // If-Range: the range only for the copy the client has (this file's Last-Modified), else the whole file
    const lastModified = statSync(join(webRoot, 'media', 'loop.mp4')).mtime.toUTCString();
    const same = await fetch(url + '/media/loop.mp4', { headers: { Range: 'bytes=0-1', 'If-Range': lastModified } });
    expect([same.status, await same.text()]).toEqual([206, '01']);
    const stale = await fetch(url + '/media/loop.mp4', { headers: { Range: 'bytes=0-1', 'If-Range': '"some-etag"' } });
    expect([stale.status, await stale.text()]).toEqual([200, '0123456789']);
  });

  it('never answers a range with the app page (the SPA fallback is always sent whole)', async () => {
    const url = await start();
    for (const path of ['/docs', '/', '/play']) {
      const res = await fetch(url + path, { headers: { Range: 'bytes=0-1' } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-range'), path).toBeNull();
      expect(res.headers.get('accept-ranges'), path).toBeNull();
      expect(await res.text(), path).toContain('<title>Elymum</title>');
      const past = await fetch(url + path, { headers: { Range: 'bytes=999999-' } });
      expect(past.status, path).toBe(200);
      await past.text();
    }
  });

  it.skipIf(process.platform !== 'linux')('closes the file of every download a client aborts mid-transfer (the descriptor count does not grow)', async () => {
    const url = new URL(await start());
    const fds = () => readdirSync('/proc/self/fd').length;
    /** One download of the big file that hangs up after its first chunk. */
    const aborted = (headers: Record<string, string>) =>
      new Promise<void>((done) => {
        const req = request({ host: url.hostname, port: url.port, path: '/media/big.mp4', headers: { ...headers, Connection: 'close' } }, (res) => {
          res.once('data', () => {
            req.destroy();
            done();
          });
        });
        req.on('error', () => done());
        req.end();
      });
    // warm up (the first request opens what the server keeps open anyway), then count
    await aborted({});
    await new Promise((r) => setTimeout(r, 200));
    const before = fds();
    for (let i = 0; i < 20; i++) await aborted(i % 2 ? { Range: 'bytes=0-' } : {});
    // twenty at once, too
    await Promise.all(Array.from({ length: 20 }, () => aborted({ Range: 'bytes=1024-' })));
    // the server side notices each hang-up asynchronously: give it a moment
    let grown = fds() - before;
    for (let i = 0; i < 40 && grown >= 4; i++) {
      await new Promise((r) => setTimeout(r, 50));
      grown = fds() - before;
    }
    // with .pipe() every aborted download kept its file open (40 more descriptors here)
    expect(grown).toBeLessThan(4);
    // and the server still serves
    const after = await fetch(url.origin + '/media/loop.mp4');
    expect([after.status, await after.text()]).toEqual([200, '0123456789']);
  });

  it('reads one byte range of a Range header and ignores what it cannot use', () => {
    expect(byteRange(undefined, 10)).toBeNull();
    expect(byteRange('', 10)).toBeNull();
    expect(byteRange('bytes=0-1', 10)).toEqual({ start: 0, end: 1 });
    expect(byteRange(' bytes=0-1 ', 10)).toEqual({ start: 0, end: 1 });
    expect(byteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=5-500', 10)).toEqual({ start: 5, end: 9 });
    expect(byteRange('bytes=9-9', 10)).toEqual({ start: 9, end: 9 });
    expect(byteRange('bytes=10-12', 10)).toBe('unsatisfiable');
    expect(byteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(byteRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(byteRange('bytes=0-0', 0)).toBe('unsatisfiable');
    expect(byteRange('bytes=-5', 0)).toBe('unsatisfiable');
    expect(byteRange('bytes=5-2', 10)).toBeNull();
    expect(byteRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(byteRange('items=0-1', 10)).toBeNull();
    expect(byteRange('bytes=-', 10)).toBeNull();
    expect(byteRange('bytes=1e3-', 10)).toBeNull();
    expect(byteRange('bytes=99999999999999999999-', 10)).toBeNull();
  });
});
