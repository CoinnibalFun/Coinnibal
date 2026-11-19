import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullChain } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { SITE_SETTINGS_DEFAULT, type SiteSettings } from '@coinnibal/shared';
import { acceptsEncoding, byteRange, createHttpServer, etagMatches, redactUrls } from '../src/http';

/** The single-origin deploy (`WEB_DIST`): static files plus the SPA fallback for client routes like `/docs`. */
describe('static web client', () => {
  let server: Server | null = null;
  let webRoot = '';
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  async function start(): Promise<string> {
    const web = mkdtempSync(join(tmpdir(), 'coinnibal-web-'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Coinnibal</title>');
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
    const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-data-')), WEB_DIST: web } as NodeJS.ProcessEnv);
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
      expect(await res.text(), path).toContain('<title>Coinnibal</title>');
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
    const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-data-')) } as NodeJS.ProcessEnv);
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
    const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-data-')), NODE_ENV: 'production', PUBLIC_URL: 'https://coinnibal.fun' } as NodeJS.ProcessEnv);
    server = createHttpServer(cfg, { chain: new NullChain(), rooms: { online: () => 0, list: () => [] } as never, leaderboards: {} as never, auth: {} as never, startedAt: Date.now() });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const page = await fetch(`${base}/play?room=AB2CD`, { redirect: 'manual' });
    expect(page.status).toBe(301);
    expect(page.headers.get('location')).toBe('https://coinnibal.fun/play?room=AB2CD');
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
      expect(await res.text(), path).toContain('<title>Coinnibal</title>');
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

  /** A raw GET (no automatic decompression): status, headers and the body bytes as sent. */
  function raw(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    return new Promise((done, fail) => {
      const u = new URL(url);
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', fail);
      req.end();
    });
  }

  it('sends the build\'s precompressed copies: brotli when the browser takes it, else gzip, else the file (Vary: Accept-Encoding)', async () => {
    const url = await start();
    const js = 'console.log("a precompressed asset");'.repeat(40);
    const html = '<!doctype html><title>Coinnibal</title>' + '<p>app</p>'.repeat(40);
    writeFileSync(join(webRoot, 'assets', 'app-1234.js'), js);
    writeFileSync(join(webRoot, 'assets', 'app-1234.js.br'), brotliCompressSync(js));
    writeFileSync(join(webRoot, 'assets', 'app-1234.js.gz'), gzipSync(js));
    writeFileSync(join(webRoot, 'index.html'), html);
    writeFileSync(join(webRoot, 'index.html.br'), brotliCompressSync(html));
    writeFileSync(join(webRoot, 'index.html.gz'), gzipSync(html));

    const br = await raw(`${url}/assets/app-1234.js`, { 'Accept-Encoding': 'gzip, deflate, br, zstd' });
    expect([br.status, br.headers['content-encoding'], br.headers.vary]).toEqual([200, 'br', 'Accept-Encoding']);
    expect(br.headers['cache-control']).toMatch(/immutable/);
    expect(br.headers['content-type']).toMatch(/javascript/);
    expect(Number(br.headers['content-length'])).toBe(br.body.length);
    expect(brotliDecompressSync(br.body).toString()).toBe(js);

    for (const ae of ['gzip', 'br;q=0, gzip;q=0.8', 'deflate, gzip']) {
      const gz = await raw(`${url}/assets/app-1234.js`, { 'Accept-Encoding': ae });
      expect([gz.headers['content-encoding'], gz.headers.vary], ae).toEqual(['gzip', 'Accept-Encoding']);
      expect(gunzipSync(gz.body).toString(), ae).toBe(js);
    }
    for (const ae of [undefined, 'identity', 'br;q=0, gzip;q=0', 'deflate']) {
      const plain = await raw(`${url}/assets/app-1234.js`, ae ? { 'Accept-Encoding': ae } : {});
      expect([plain.headers['content-encoding'], plain.headers.vary], String(ae)).toEqual([undefined, 'Accept-Encoding']);
      expect(plain.body.toString(), String(ae)).toBe(js);
    }

    // the app page for client routes, too (no-cache, as before)
    const page = await raw(`${url}/docs`, { 'Accept-Encoding': 'br' });
    expect([page.headers['content-encoding'], page.headers['cache-control'], page.headers.vary]).toEqual(['br', 'no-cache', 'Accept-Encoding']);
    expect(brotliDecompressSync(page.body).toString()).toBe(html);

    // a HEAD has the same headers and no body; a byte range of a precompressed file gets the whole file
    const head = await raw(`${url}/assets/app-1234.js`, { 'Accept-Encoding': 'br' }, 'HEAD');
    expect([head.headers['content-encoding'], head.headers['content-length'], head.body.length]).toEqual(['br', String(br.body.length), 0]);
    const ranged = await raw(`${url}/assets/app-1234.js`, { 'Accept-Encoding': 'br', Range: 'bytes=0-9' });
    expect([ranged.status, ranged.headers['content-range'], ranged.headers['accept-ranges']]).toEqual([200, undefined, undefined]);
    expect(brotliDecompressSync(ranged.body).toString()).toBe(js);

    // a file the build did not compress: no Vary, no encoding, byte ranges as before
    const png = await raw(`${url}/favicon-32.png`, { 'Accept-Encoding': 'br, gzip' });
    expect([png.headers['content-encoding'], png.headers.vary, png.headers['accept-ranges']]).toEqual([undefined, undefined, 'bytes']);
  });

  describe('the prerendered landing (landing.html for /)', () => {
    const LANDING = '<!doctype html><html lang="en" data-theme="light"><title>Coinnibal</title><div id="root"><h1>prerendered</h1></div>' + '<p>landing</p>'.repeat(60);
    const APP = '<!doctype html><title>Coinnibal</title><div id="root"><div class="boot"></div></div>' + '<p>app</p>'.repeat(60);
    const BUILT = { gameAccess: 'admins', mintOpen: false, wlOpen: false, collabOpen: false, xHandle: 'coinnibalfun' };

    /** A web dist with both pages (and their precompressed copies) behind a server whose site store answers `live()`. */
    async function startLanding(live: (() => SiteSettings) | null): Promise<string> {
      const web = mkdtempSync(join(tmpdir(), 'coinnibal-web-'));
      for (const [name, body] of [['index.html', APP], ['landing.html', LANDING]]) {
        writeFileSync(join(web, name), body);
        writeFileSync(join(web, name + '.br'), brotliCompressSync(body));
        writeFileSync(join(web, name + '.gz'), gzipSync(body));
      }
      writeFileSync(join(web, 'landing.json'), JSON.stringify(BUILT));
      webRoot = web;
      const cfg = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-data-')), WEB_DIST: web } as NodeJS.ProcessEnv);
      const site = live ? ({ publicSettings: live, handle: async () => false } as never) : undefined;
      server = createHttpServer(cfg, { chain: new NullChain(), rooms: {} as never, leaderboards: {} as never, auth: {} as never, startedAt: Date.now(), site });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const addr = server.address();
      return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    }
    const decode = (r: { headers: Record<string, string | string[] | undefined>; body: Buffer }) =>
      r.headers['content-encoding'] === 'br' ? brotliDecompressSync(r.body).toString() : r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body).toString() : r.body.toString();

    it('sends landing.html for / while the live settings equal landing.json, and with no site store', async () => {
      let settings: SiteSettings = { ...SITE_SETTINGS_DEFAULT, xHandle: 'coinnibalfun', launchPostUrl: 'https://x.com/coinnibalfun/status/1' };
      const url = await startLanding(() => settings);
      for (const ae of ['br', 'gzip', 'identity']) {
        const res = await raw(url + '/', { 'Accept-Encoding': ae });
        expect([res.status, res.headers['cache-control'], res.headers.vary], ae).toEqual([200, 'no-cache', 'Accept-Encoding']);
        expect(res.headers['content-encoding'], ae).toBe(ae === 'identity' ? undefined : ae);
        expect(res.headers['content-type'], ae).toMatch(/text\/html/);
        expect(res.headers['x-frame-options'], ae).toBe('DENY');
        expect(Number(res.headers['content-length']), ae).toBe(res.body.length);
        expect(decode(res), ae).toBe(LANDING);
      }
      // a handle stored with its @ is the same handle; a setting the page does not show (the launch post) changes nothing
      settings = { ...settings, xHandle: '@coinnibalfun' };
      expect(decode(await raw(url + '/', { 'Accept-Encoding': 'br' }))).toBe(LANDING);
      // every other client route, and the query string of /, as before: /docs is the app page, /?x the landing
      expect(decode(await raw(url + '/docs', { 'Accept-Encoding': 'br' }))).toBe(APP);
      expect((await fetch(url + '/?ref=x')).headers.get('etag')).toMatch(/^"/);
      server!.close();
      const bare = await startLanding(null);
      expect(decode(await raw(bare + '/', { 'Accept-Encoding': 'gzip' }))).toBe(LANDING);
    });

    it('sends index.html for / as soon as a door is open, the game access or the handle differs, or landing.json is gone', async () => {
      let settings: SiteSettings = { ...SITE_SETTINGS_DEFAULT, xHandle: 'coinnibalfun' };
      const url = await startLanding(() => settings);
      const changes: Partial<SiteSettings>[] = [{ wlOpen: true }, { mintOpen: true }, { collabOpen: true }, { gameAccess: 'public' }, { gameAccess: 'holders' }, { gameAccess: 'maintenance' }, { xHandle: 'someoneelse' }];
      for (const change of changes) {
        settings = { ...SITE_SETTINGS_DEFAULT, xHandle: 'coinnibalfun', ...change };
        const res = await raw(url + '/', { 'Accept-Encoding': 'br, gzip' });
        expect([res.status, decode(res)], JSON.stringify(change)).toEqual([200, APP]);
        // the app page keeps its headers: no validator, so a browser's cached landing is never answered with a 304
        expect([res.headers.etag, res.headers['cache-control']], JSON.stringify(change)).toEqual([undefined, 'no-cache']);
      }
      settings = { ...SITE_SETTINGS_DEFAULT, xHandle: 'coinnibalfun' };
      expect(decode(await raw(url + '/', { 'Accept-Encoding': 'br' }))).toBe(LANDING);
      rmSync(join(webRoot, 'landing.json'));
      expect(decode(await raw(url + '/', { 'Accept-Encoding': 'br' }))).toBe(APP);
    });

    it('validates landing.html with a content-hash ETag per encoding: a match is a 304, another encoding or a new build a 200', async () => {
      let settings: SiteSettings = { ...SITE_SETTINGS_DEFAULT, xHandle: 'coinnibalfun' };
      const url = await startLanding(() => settings);
      const tags: Record<string, string> = {};
      for (const ae of ['br', 'gzip', 'identity']) {
        const first = await raw(url + '/', { 'Accept-Encoding': ae });
        const etag = String(first.headers.etag);
        expect(etag, ae).toMatch(ae === 'br' ? /^"[\w-]{27}-br"$/ : ae === 'gzip' ? /^"[\w-]{27}-gz"$/ : /^"[\w-]{27}"$/);
        expect(first.headers['last-modified'], ae).toBe(statSync(join(webRoot, 'landing.html' + (ae === 'br' ? '.br' : ae === 'gzip' ? '.gz' : ''))).mtime.toUTCString());
        tags[ae] = etag;
        // the same copy again: 304, no body, the validator and the caching headers (Vary too) repeated
        const again = await raw(url + '/', { 'Accept-Encoding': ae, 'If-None-Match': etag });
        expect([again.status, again.body.length, again.headers.etag, again.headers.vary, again.headers['cache-control']], ae).toEqual([304, 0, etag, 'Accept-Encoding', 'no-cache']);
        expect([again.headers['content-encoding'], again.headers['content-length']], ae).toEqual([undefined, undefined]);
        // a list, a weak form (a proxy that re-encodes weakens it), a HEAD
        expect((await raw(url + '/', { 'Accept-Encoding': ae, 'If-None-Match': `"nope", W/${etag}` })).status, ae).toBe(304);
        expect((await raw(url + '/', { 'Accept-Encoding': ae, 'If-None-Match': etag }, 'HEAD')).status, ae).toBe(304);
        const head = await raw(url + '/', { 'Accept-Encoding': ae }, 'HEAD');
        expect([head.status, head.headers.etag, head.headers['content-length'], head.body.length], ae).toEqual([200, etag, String(first.body.length), 0]);
      }
      expect(new Set(Object.values(tags)).size).toBe(3);
      // another encoding's tag is another representation: the whole page
      const other = await raw(url + '/', { 'Accept-Encoding': 'br', 'If-None-Match': tags.gzip });
      expect([other.status, decode(other)]).toEqual([200, LANDING]);
      // a door opens: the browser's cached landing is not confirmed, it gets the app page
      settings = { ...settings, mintOpen: true };
      const opened = await raw(url + '/', { 'Accept-Encoding': 'br', 'If-None-Match': tags.br });
      expect([opened.status, decode(opened), opened.headers.etag]).toEqual([200, APP, undefined]);
      settings = { ...settings, mintOpen: false };
      // a new build of the page: a new tag, so the old one gets the whole new page
      const next = LANDING.replace('prerendered', 'rebuilt');
      writeFileSync(join(webRoot, 'landing.html.br'), brotliCompressSync(next));
      const rebuilt = await raw(url + '/', { 'Accept-Encoding': 'br', 'If-None-Match': tags.br });
      expect([rebuilt.status, decode(rebuilt)]).toEqual([200, next]);
      expect(rebuilt.headers.etag).not.toBe(tags.br);
    });

    it('reads If-None-Match with weak tags, lists and *', () => {
      expect(etagMatches('"abc-br"', '"abc-br"')).toBe(true);
      expect(etagMatches('W/"abc-br"', '"abc-br"')).toBe(true);
      expect(etagMatches('"x", "abc-br" ', '"abc-br"')).toBe(true);
      expect(etagMatches('*', '"abc"')).toBe(true);
      expect(etagMatches('"abc"', '"abc-br"')).toBe(false);
      expect(etagMatches('', '"abc"')).toBe(false);
      expect(etagMatches(undefined, '"abc"')).toBe(false);
    });
  });

  it('reads Accept-Encoding with q-values and the * wildcard', () => {
    expect(acceptsEncoding('gzip, deflate, br', 'br')).toBe(true);
    expect(acceptsEncoding('GZIP;Q=1.0, BR', 'br')).toBe(true);
    expect(acceptsEncoding('br;q=0', 'br')).toBe(false);
    expect(acceptsEncoding('br;q=0.001', 'br')).toBe(true);
    expect(acceptsEncoding('gzip', 'br')).toBe(false);
    expect(acceptsEncoding('*', 'br')).toBe(true);
    expect(acceptsEncoding('*;q=0', 'gzip')).toBe(false);
    expect(acceptsEncoding('br;q=0, *', 'br')).toBe(false);
    expect(acceptsEncoding(undefined, 'gzip')).toBe(false);
    expect(acceptsEncoding('', 'gzip')).toBe(false);
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
