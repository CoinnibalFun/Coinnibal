import type { ShareService } from './site/shares';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { BRAND_SITE_ORIGINS, PROTOCOL_VERSION } from '@coinnibal/shared';
import { NonceLimitError, checksumAddress, type Auth, type SiweOrigin } from './auth';
import type { DevFakeChainActions } from './chain/dev-fake';
import type { ChainGateway } from './chain/types';
import type { ServerConfig } from './config';
import type { Leaderboards } from './leaderboards';
import { healthReport } from './health';
import { clientIp, trustProxyHops } from './net/gateway';
import { asClient } from './net/client-scope';
import { rateKey } from './net/ip-key';
import { Limiter } from './net/limiter';
import type { PriceKeeper } from './chain/price-keeper';
import type { RoomManager } from './rooms/manager';
import { bearerWallet, type SiteApi } from './site/routes';
import type { Journal } from './stake/journal';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
};

interface Ctx {
  rooms: RoomManager;
  leaderboards: Leaderboards;
  chain: ChainGateway;
  auth: Auth;
  startedAt: number;
  /** Settlements owed (for `/api/pending`). */
  journal?: Journal;
  /** The site API (`/api/site/*`, `/api/admin/*`, `/api/auth/login`, `/api/auth/me`, `/api/profile`, `/api/nft/*`). */
  site?: SiteApi;
  /** The NFT price keeper (its last outcome is shown to admins in `/api/config`). */
  priceKeeper?: PriceKeeper | null;
  /** "Share on X" cards (`/share/<id>`, `/share/<id>.png`). */
  shares?: ShareService;
  /** The per-IP limiter of every `/api/*` request (default 240 a minute); tests inject a larger one. */
  apiLimiter?: Limiter;
  /** Server log (unexpected errors of a request go here, never to the client). Default: console.error. */
  log?: (m: string) => void;
}

/** Strips URLs (an RPC URL can carry an API key in its path or query) from a message before it is logged. */
export function redactUrls(s: string): string {
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => {
    try {
      return `${new URL(u).protocol}//${new URL(u).host}/<redacted>`;
    } catch {
      return '<redacted-url>';
    }
  });
}

const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * Public base URL of this server: `PUBLIC_URL` when set. Without it (only allowed with
 * `NODE_ENV=development`, see `assertPublicUrl`) the request's own `Host` header in development, else
 * `http://localhost:<PORT>`. Client-supplied `X-Forwarded-Host`/`-Proto` are never used: this URL is the
 * SIWE origin of a login and the base of the NFT metadata links, so it must not be chosen by a caller
 * (`_trustProxy` is accepted for compatibility and ignored).
 */
export function publicBaseUrl(cfg: ServerConfig, req: IncomingMessage, _trustProxy?: boolean | number): string {
  if (cfg.publicUrl) return cfg.publicUrl;
  const host = req.headers.host;
  if (cfg.nodeEnv === 'development' && host && HOST_RE.test(host)) return `http://${host}`;
  return `http://localhost:${cfg.port}`;
}

/**
 * SIWE origin of a login: the domain is the `PUBLIC_URL` host (the request host only in
 * development, as in `publicBaseUrl`); the URI is that base URL; the chain id is the server's
 * (`eth_chainId` of its RPC), or the configured `CHAIN_ID` while the chain is off.
 */
export function siweOrigin(cfg: ServerConfig, req: IncomingMessage, _trustProxy: boolean | number, chainId: number | null): SiweOrigin {
  // a sign-in from one of the brand's own sites (coinnibal.fun) names that site, so the wallet shows the page's own
  // domain; every other request names PUBLIC_URL as before. The browser sets Origin, a page cannot choose it.
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '') : '';
  const uri = BRAND_SITE_ORIGINS.includes(origin) ? origin : publicBaseUrl(cfg, req);
  return { domain: new URL(uri).host, uri, chainId: chainId ?? cfg.chain.chainId };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** A small JSON body (dev routes); null when it is not JSON or larger than 4 KiB. */
async function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) return null;
    chunks.push(c as Buffer);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  // browsers ask for /favicon.ico on their own: the site ships favicon-32.png (Vercel's old rewrite, now here)
  if (rel === '/favicon.ico' && !existsSync(join(resolve(root), 'favicon.ico'))) rel = '/favicon-32.png';
  const base = resolve(root);
  let file = normalize(join(base, rel));
  if (file !== base && !file.startsWith(base + sep)) return false;
  let fallback = false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) return false;
    file = join(base, 'index.html'); // SPA fallback
    if (!existsSync(file)) return false;
    fallback = true;
  }
  const ext = extname(file);
  const immutable = rel.startsWith('/assets/');
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    // the web app is never framed (clickjacking of wallet actions); scripts from this origin only (Vercel's old rule,
    // plus the sources the app needs: its own API and sockets, wallet RPCs over https, inline styles of the shell)
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': WEB_CSP,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (fallback) {
    // the app page stands in for every client route: always sent whole, never a byte range of it
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else sendFile(file, res);
    return true;
  }
  // a real file answers one byte range: Safari and iOS play a <video> only from a server that does (they probe
  // with `Range: bytes=0-1` first), and a download can resume
  const stat = statSync(file);
  const size = stat.size;
  const lastModified = stat.mtime.toUTCString();
  headers['Accept-Ranges'] = 'bytes';
  headers['Last-Modified'] = lastModified;
  // `If-Range` with any other validator than this file's date means the client's copy is stale: send it whole
  const ifRange = req.headers['if-range'];
  const range = ifRange === undefined || ifRange === lastModified ? byteRange(req.headers.range, size) : null;
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return true;
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else {
    headers['Content-Length'] = size;
  }
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') res.end();
  else sendFile(file, res, range ?? undefined);
  return true;
}

/**
 * Streams a file (or one byte range of it) to the response. pipeline() destroys both ends when the client goes away
 * mid-transfer or the read fails, so the file descriptor is always closed and no stream error goes unhandled (with
 * `.pipe()` an aborted download kept its descriptor open: enough of them exhaust the process's descriptors, and the
 * next unhandled stream error crashes the server).
 */
function sendFile(file: string, res: ServerResponse, range?: { start: number; end: number }): void {
  pipeline(createReadStream(file, range), res, () => {
    /* finished, the client left, or the read failed: pipeline has already closed the file and the response */
  });
}

/**
 * The one byte range of a `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`) clamped to a file of `size` bytes;
 * null to send the whole file (no header, another unit, several ranges, or a header that does not parse, which
 * RFC 9110 lets a server ignore), 'unsatisfiable' for a range that starts past the end (or an empty suffix).
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  if (m[2] !== '' && Number(m[2]) < start) return null;
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

/**
 * The `Access-Control-Allow-Origin` answer for a request: `*` when `CORS_ORIGIN` is `*` (sessions are bearer
 * tokens, never cookies, so no browser sends credentials either way), else the request's `Origin` when it is one
 * of the comma-separated allowed origins, else nothing (the browser blocks the read).
 */
export function corsAllow(corsOrigin: string, origin: string | undefined): string | null {
  const allowed = corsOrigin.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (allowed.includes('*')) return '*';
  return origin && allowed.includes(origin) ? origin : null;
}

/** Slow or idle HTTP clients (slowloris): headers within 15 s, the whole request within 30 s, idle keep-alive 5 s. */
export const HTTP_TIMEOUTS = { headersMs: 15_000, requestMs: 30_000, keepAliveMs: 5_000, maxHeaders: 64 } as const;

/** The strict CSP of the bundled web app (`WEB_DIST`). */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; " +
  "connect-src 'self' https: wss:; worker-src 'self' blob:; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; " +
  "frame-ancestors 'none'; form-action 'self'";

/**
 * Without `WEB_DIST` (a deploy where the web app is hosted elsewhere; the VPS serves it itself) a browser that opens a page of
 * the game server's own domain is sent to the same page on `PUBLIC_URL`, so there is one copy of the site. Null when
 * there is nothing to redirect (development, no `PUBLIC_URL`, the request is already for that host).
 */
export function siteRedirect(cfg: Pick<ServerConfig, 'webDist' | 'publicUrl' | 'nodeEnv'>, req: IncomingMessage, url: URL): string | null {
  if (cfg.webDist || !cfg.publicUrl || cfg.nodeEnv !== 'production') return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/ws' || p.startsWith('/share/')) return null;
  const site = new URL(cfg.publicUrl);
  if (req.headers.host && req.headers.host.toLowerCase() === site.host.toLowerCase()) return null;
  return `${site.origin}${p}${url.search}`;
}

/** Public reads answered from a copy at most this old (a flood of them costs one build per period). */
const MICRO_CACHE_MS = 1_000;

export function createHttpServer(cfg: ServerConfig, ctx: Ctx): Server {
  const apiLimiter = ctx.apiLimiter ?? new Limiter(240, 60_000);
  const nonceLimiter = new Limiter(20, 60_000);
  const trustProxy = trustProxyHops();
  const cached = new Map<string, { at: number; body: string }>();
  /** A public JSON read, built at most once a second. */
  const publicJson = (res: ServerResponse, key: string, build: () => unknown): void => {
    const now = Date.now();
    let hit = cached.get(key);
    if (!hit || now - hit.at >= MICRO_CACHE_MS) {
      hit = { at: now, body: JSON.stringify(build()) };
      cached.set(key, hit);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=1' });
    res.end(hit.body);
  };

  // the request and header timeouts are enforced by a sweep every `connectionsCheckingInterval` (Node default 30 s)
  const server = createServer({ connectionsCheckingInterval: 2_000 }, (req, res) => {
    // per-client budgets deep down (holder checks) count this request's client
    void asClient(rateKey(clientIp(req, trustProxy)), () => handleRequest(req, res));
  });
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const allow = corsAllow(cfg.corsOrigin, req.headers.origin);
    if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
    if (allow && allow !== '*') res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const ip = clientIp(req, trustProxy);
    // every per-client limit counts an IPv6 client as its /64 (one customer holds the whole /64); the exact address
    // is kept for the admin audit and the logs
    const key = rateKey(ip);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!apiLimiter.allow(key)) return json(res, 429, { error: 'rate_limited' });
        if (ctx.site && (await ctx.site.handle(req, res, url, key, ip))) return;
        switch (url.pathname) {
          case '/api/health': {
            // `?live=1`: the container's liveness check (Docker HEALTHCHECK): the process answers. A server that only
            // waits on the RPC, or whose disk is full, is not restarted for it (a restart fixes neither)
            if (url.searchParams.get('live') === '1') return json(res, 200, { ok: true, live: true, uptimeS: Math.round((Date.now() - ctx.startedAt) / 1000) });
            const report = healthReport({ cfg, rooms: ctx.rooms, journal: ctx.journal, chain: ctx.chain, startedAt: ctx.startedAt });
            return json(res, report.ok ? 200 : 503, report);
          }
          case '/api/rooms':
            return publicJson(res, 'rooms', () => ({ rooms: ctx.rooms.list(), online: ctx.rooms.online(), blocked: ctx.rooms.blockedArenas() }));
          case '/api/leaderboard':
            // the standings: off-chain daily / all-time best scores, no prizes
            return publicJson(res, 'leaderboard', () => ctx.leaderboards.snapshot());
          case '/api/config': {
            // `chain.tokenReady` false: practice only, arenas "opening soon" (the server picks the token up by itself)
            const body: Record<string, unknown> = { protocol: PROTOCOL_VERSION, chain: ctx.chain.status() };
            // admins also see the server key's gas balance (and the price keeper)
            const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim())?.[1];
            const wallet = bearer ? ctx.auth.verifyAdminToken(bearer) : null;
            if (wallet && ctx.site?.isAdmin(wallet)) {
              const info = ctx.chain.serverInfo();
              body.server = { address: info.address, balanceWei: info.balanceWei, low: info.low, ...(info.gas ? { gas: info.gas } : {}), priceKeeper: ctx.priceKeeper?.last ?? null };
            }
            return json(res, 200, body);
          }
          case '/api/auth/nonce': {
            if (!nonceLimiter.allow(key)) return json(res, 429, { error: 'rate_limited' });
            const address = checksumAddress(url.searchParams.get('address'));
            if (!address) return json(res, 400, { error: 'bad_request', message: 'address must be an EVM address (0x…)' });
            try {
              return json(res, 200, ctx.auth.issueNonce(address, siweOrigin(cfg, req, trustProxy, ctx.chain.status().chainId), Date.now(), key));
            } catch (err) {
              if (err instanceof NonceLimitError) return json(res, 429, { error: 'rate_limited', message: 'Too many sign-in attempts. Wait a few minutes.' });
              throw err;
            }
          }
          case '/api/pending': {
            // settlements the server still has to send for a wallet (payouts in ledger units). Finalized sessions
            // (settled, payout waiting to be collected) live on chain; the web reads them there (getSession)
            const wallet = checksumAddress(url.searchParams.get('wallet'));
            if (!wallet) return json(res, 400, { error: 'bad_request', message: 'wallet must be an EVM address (0x…)' });
            // what a wallet is owed (and when it played) is that wallet's business: its own session, or an admin's
            const caller = bearerWallet(ctx.auth, req);
            if (!caller) return json(res, 401, { error: 'unauthorized', message: 'Sign in with your wallet first.' });
            if (caller.toLowerCase() !== wallet.toLowerCase() && !ctx.site?.isAdmin(caller)) return json(res, 403, { error: 'forbidden', message: 'Only that wallet (or an admin) may read its pending payouts.' });
            const pending = (ctx.journal?.pending ?? [])
              // loot sweeps (`kind: 'sweep'`) belong to no wallet
              .flatMap((p) =>
                p.kind === 'settle' && p.player.toLowerCase() === wallet.toLowerCase() ? [{ key: p.key, arenaId: p.arenaId ?? null, payout: p.payout ?? 0 }] : [],
              );
            return json(res, 200, { pending });
          }
          case '/api/dev/token': {
            // DEV ONLY: sets the fake chain's game token, like `setToken` from /admin (absent unless
            // DEV_FAKE_CHAIN=1, which needs NODE_ENV=development); shows the "opening soon" → open transition
            const dev = cfg.devFakeChain ? (ctx.chain as Partial<DevFakeChainActions>) : null;
            if (!dev?.devSetToken) return json(res, 404, { error: 'not found' });
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            const changed = dev.devSetToken();
            return json(res, 200, { changed, chain: ctx.chain.status() });
          }
          case '/api/dev/pay': {
            // DEV ONLY: the web's fake wallet "pays" a power-up pack (`CoinnibalArena.pay`); answers its fake hash
            const dev = cfg.devFakeChain ? (ctx.chain as Partial<DevFakeChainActions>) : null;
            if (!dev?.devPay) return json(res, 404, { error: 'not found' });
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            const body = await readSmallJson(req);
            const value = typeof body?.value === 'string' && /^\d{1,40}$/.test(body.value) ? BigInt(body.value) : 0n;
            const hash = dev.devPay(String(body?.from ?? ''), value, String(body?.ref ?? ''));
            return hash ? json(res, 200, { hash }) : json(res, 400, { error: 'bad_request' });
          }
          default:
            return json(res, 404, { error: 'not found' });
        }
      }
      if (url.pathname.startsWith('/share/') && ctx.shares?.handle(req, res, url.pathname, key)) return;
      if (cfg.webDist && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(cfg.webDist, req, res, url.pathname)) return;
      const to = siteRedirect(cfg, req, url);
      if (to) {
        res.writeHead(301, { Location: to, 'Cache-Control': 'public, max-age=3600' });
        res.end();
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Coinnibal game server: connect via /ws');
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      // details stay server-side (with URLs redacted): an RPC error can name the RPC URL and its key
      (ctx.log ?? ((m: string) => console.error(m)))(`http: ${req.method} ${url.pathname} failed: ${redactUrls(String((err as Error)?.stack ?? err))}`);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: 'internal server error' });
      else res.end();
    }
  };
  server.headersTimeout = HTTP_TIMEOUTS.headersMs;
  server.requestTimeout = HTTP_TIMEOUTS.requestMs;
  server.keepAliveTimeout = HTTP_TIMEOUTS.keepAliveMs;
  server.maxHeadersCount = HTTP_TIMEOUTS.maxHeaders;
  return server;
}
