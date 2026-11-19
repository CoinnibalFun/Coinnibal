import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AdminAudit } from './audit';
import { OLD_SECRET_PROOF_HEADER, SECRET_PROOF_HEADER, SECRET_PURPOSES, SecretProofError, SecretProofs, type SecretPurpose, type SecretRoute } from './secret-proof';

import { FEEDBACK_LIMITS, ROBINHOOD_CHAIN_ID, ARENA_PRICING_DEFAULT, formatUsdCents, AVATAR_LIMITS, AVATAR_TYPES, PRACTICE_ROOM, BASIC_SKINS, EMBLEM_SKIN_ID, SITE_LIMITS, isAvatarId, type GameAccess, type GameServerLoad, type ProfileResponse, type SiteError, type SiteSettings, type NftCollectionAdminView, GAS_SYMBOL, siteHostOf, gameVisible, isOpenPlayOrigin, isTestChainId } from '@coinnibal/shared';
import { SIGN_IN_BUSY_MESSAGE, SignInBusyError, checksumAddress, type Auth } from '../auth';
import { AvatarError, avatarIdOf, sanitizeAvatar, type AvatarStore } from '../avatars';
import { XLinkFail, type XLinkService } from '../xlink';
import { squarePng } from './share-card';
import type { ChainGateway } from '../chain/types';
import { integrityRoutes } from '../integrity/routes';
import type { IntegrityService } from '../integrity/service';
import type { ServerConfig } from '../config';
import { CLIENT_BUSY_MESSAGE, ClientBudgetError } from '../net/client-scope';
import { Limiter } from '../net/limiter';
import { ProfileError, type ProfileStore } from '../profiles';
import type { Journal } from '../stake/journal';
import type { Leaderboards } from '../leaderboards';
import type { HolderReader } from '../chain/evm-client';
import { ShopFail, type ShopService } from '../shop/service';
import { ShopSettingsError, type ShopSettingsStore } from '../shop/settings';
import type { BoostInventory } from '../shop/inventory';
import { migrationEnv, streamBackup } from './backup';
import { ArenaScalingFail, type ArenaScaler } from '../rooms/arena-scaler';
import type { RoomManager } from '../rooms/manager';
import { TestArenaFail } from '../rooms/test-arenas';
import { ArenaPricingFail, type ArenaPriceStore } from './arena-prices';
import { mapRoutes, type MapAdmin } from './maps';
import { RepriceFail, type RepriceScheduler } from './reprice';
import { customRoomAdminRoutes, customRoomRoutes } from './custom-rooms';
import type { CustomRoomService } from '../rooms/custom';
import { importHolders, type HolderWlStore } from './holder-wl';
import { FaucetInfo, networkInfo } from './network';
import { clearContract, registerContract, type ContractsStore } from './contracts';
import { parseNftPath, type MintService } from './mint';
import { CollectionFail, type NftCollection } from './nft/collection';
import { parseArtStyle } from './nft/render';
import type { SiteStore } from './store';
import { SiteFail, obj } from './validate';
import { FeedbackStore, parseFeedback } from './feedback';

/** A request's or a socket's `Origin` header (absent on a same-origin GET and on a server's own call). */
type Origin = string | string[] | null | undefined;

/** Admin routes whose every request (reads too) goes to the audit log: they hand out secrets. */
const SECRET_ROUTES = new Set(['backup', 'migration-env', 'secret-proof', 'auth']);

/** What the site needs besides its own store; every part is optional (bare unit tests). */
export interface SiteExtras {
  chain?: ChainGateway;
  contracts?: ContractsStore;
  mint?: MintService;
  /** The emblem collection (art, metadata, provenance, reveal). */
  nft?: NftCollection;
  profiles?: ProfileStore;
  journal?: Journal;
  /** Public base URL (`PUBLIC_URL`; the request host only in development): NFT metadata links. */
  baseUrl?: (req: IncomingMessage) => string;
  /** `DATA_DIR` (the chain-keyed state under `chains/`); null: memory only. */
  dataDir?: string | null;
  /** Imported testnet emblem holders (`site/holder-wl.json`). */
  holderWl?: HolderWlStore;
  /** The NFT registered on a chain (its chain-keyed registry). */
  nftOf?: (chainId: number) => { address: string; txHash: string | null } | null;
  /** A holder reader on a chain (the server's client, or `TESTNET_RPC_URL`). */
  holderReaderFor?: (chainId: number) => HolderReader | null;
  /** The TestToken faucet settings (`GET /api/site/faucet`). */
  faucet?: FaucetInfo;
  /** Profile pictures (`/api/profile/avatar`, `/api/avatar/<id>`, `/api/admin/avatars`). */
  avatars?: AvatarStore;
  /** The daily / all-time boards (`/api/admin/leaderboards`: info and reset). */
  leaderboards?: Leaderboards;
  log?: (m: string) => void;
}

export interface SiteLimits {
  /** Writes to `/api/site/*` per IP. */
  writeIp: Limiter;
  /** Writes to `/api/site/*` per signed-in wallet. */
  writeWallet: Limiter;
  /** `POST /api/auth/login` per IP. */
  login: Limiter;
  /** Picture uploads per IP (default 20 an hour). */
  avatarIp?: Limiter;
  /** Picture uploads per signed-in wallet (default 6 an hour). */
  avatarWallet?: Limiter;
  /** `POST /api/feedback` per client (default 10 in 10 minutes). */
  feedbackIp?: Limiter;
  /** `POST /api/feedback` per signed-in wallet (default 5 in 10 minutes). */
  feedbackWallet?: Limiter;
  /** Messages stored server-wide (default 300 in 10 minutes): a flood from many addresses cannot churn the kept 5,000 in minutes. */
  feedbackAll?: Limiter;
}

export const defaultSiteLimits = (): SiteLimits => ({
  writeIp: new Limiter(60, 10 * 60_000),
  writeWallet: new Limiter(20, 10 * 60_000),
  login: new Limiter(20, 60_000),
  avatarIp: new Limiter(20, 60 * 60_000),
  avatarWallet: new Limiter(6, 60 * 60_000),
});

type FeedbackLimits = Required<Pick<SiteLimits, 'feedbackIp' | 'feedbackWallet' | 'feedbackAll'>>;

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const fail = (res: ServerResponse, status: number, error: SiteError) => send(res, status, error);

const sendCsv = (res: ServerResponse, name: string, body: string) => {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

/** Reads a JSON object body: `application/json`, at most `SITE_LIMITS.bodyBytes`. */
export async function readJson(req: IncomingMessage, limit: number = SITE_LIMITS.bodyBytes): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) throw new SiteFail(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json)');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new SiteFail(413, 'body_too_large', `The body is larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new SiteFail(413, 'body_too_large', `The body is larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SiteFail(400, 'bad_request', 'The body is not valid JSON');
  }
  return obj(parsed);
}

/** Reads a raw body of at most `limit` bytes. */
export async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new SiteFail(413, 'body_too_large', `The body is larger than ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new SiteFail(413, 'body_too_large', `The body is larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `Authorization: Bearer <token>` → the session wallet (tokens come from `/api/auth/login` or the WebSocket `authed`). */
export function bearerWallet(auth: Auth, req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? auth.verifyToken(m[1]) : null;
}

/**
 * The Coinnibal site API: wallet sign-in over HTTP (SIWE), `/api/site/*` (public + the signed-in
 * applicant), `/api/profile`, the NFT metadata (`/api/nft/*`) and `/api/admin/*` (a session of an
 * `ADMIN_WALLETS` wallet).
 */
export class SiteApi {
  /** Admin wallets, lower-case. */
  private readonly admins: Set<string>;
  /** Cheat and collusion detection (`/api/admin/integrity/*`); absent in bare unit tests. */
  private integrity: IntegrityService | null = null;
  /** Map settings and live room counts (`/api/admin/maps`); absent in bare unit tests. */
  private maps: MapAdmin | null = null;
  /** The arena instance scaler (`/api/admin/arena-scaling`); absent in bare unit tests. */
  private scaler: ArenaScaler | null = null;
  /** Test arenas (testnet only, `/api/admin/test-arenas`); absent in bare unit tests. */
  private testArenas: Pick<RoomManager, 'testArenas' | 'testArenaView'> | null = null;
  /** Custom rooms (`/api/rooms/custom/*`, `/api/admin/custom-rooms`); absent in bare unit tests. */
  private customRooms: CustomRoomService | null = null;
  /** Arena tiers in US dollars (`/api/site/arena-prices`, `/api/admin/arena-prices`); absent in bare unit tests. */
  private arenaPrices: ArenaPriceStore | null = null;
  /** The power-up shop (`/api/shop`, `/api/shop/buy`, `/api/admin/shop`); absent in bare unit tests. */
  private shop: { service: ShopService; settings: ShopSettingsStore; inventory: BoostInventory } | null = null;
  private readonly shopBuys = new Limiter(30, 60_000);
  /** "Practice with bots" rooms opened per IP (`PRACTICE_ROOM.perIp` per window). */
  private readonly practiceIps = new Limiter(PRACTICE_ROOM.perIp, PRACTICE_ROOM.perIpWindowMs);
  /** Fresh, purpose-bound owner signatures for the secret exports (`/api/admin/secret-proof`). */
  private readonly proofs: SecretProofs;
  /** `GET /api/admin/backup` per admin wallet (a full copy of DATA_DIR each time). */
  private readonly backups = new Limiter(6, 60 * 60_000);
  /** Writes every store's unsaved state to disk (before a backup); set by the app. */
  private flushAll: (() => void) | null = null;
  /** Told when a wallet's picture is removed or replaced (live rooms drop it from the coin). */
  private avatarChanged: ((wallet: string) => void) | null = null;
  /** "Link X" (`/api/x/*`); absent in bare unit tests. */
  private xLinks: XLinkService | null = null;
  private readonly avatarIp: Limiter;
  private readonly avatarWallet: Limiter;
  private readonly feedbackLimits: FeedbackLimits;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly auth: Auth,
    readonly store: SiteStore,
    private readonly limits: SiteLimits = defaultSiteLimits(),
    private readonly ext: SiteExtras = {},
  ) {
    this.admins = new Set(cfg.adminWallets.map((w) => w.toLowerCase()));
    // the admin list decides which tokens are short-lived admin sessions
    auth.setAdminCheck((w) => this.isAdmin(w));
    this.avatarIp = limits.avatarIp ?? new Limiter(20, 60 * 60_000);
    this.avatarWallet = limits.avatarWallet ?? new Limiter(6, 60 * 60_000);
    this.audit = new AdminAudit(ext.dataDir ? join(ext.dataDir, 'admin-audit.jsonl') : null, ext.log);
    this.feedback = new FeedbackStore(ext.dataDir ? join(ext.dataDir, 'site', 'feedback.jsonl') : null, { log: ext.log });
    this.feedbackLimits = {
      feedbackIp: limits.feedbackIp ?? new Limiter(10, 10 * 60_000),
      feedbackWallet: limits.feedbackWallet ?? new Limiter(5, 10 * 60_000),
      feedbackAll: limits.feedbackAll ?? new Limiter(300, 10 * 60_000),
    };
    this.proofs = new SecretProofs((w, m, sig) => this.auth.signedBy(w, m, sig));
  }

  /** Every admin write (`DATA_DIR/admin-audit.jsonl`, `GET /api/admin/audit`). */
  readonly audit: AdminAudit;

  /** Player feedback (`POST /api/feedback`, `DATA_DIR/site/feedback.jsonl`, the admin's Feedback drawer). */
  readonly feedback: FeedbackStore;

  /** `fn(wallet)`: the wallet's picture was removed or replaced (the rooms take it off live coins). */
  onAvatarChange(fn: ((wallet: string) => void) | null): void {
    this.avatarChanged = fn;
  }

  /** "Link X": the links, the proof check and the account pictures (`/api/x/*`). */
  setXLinks(x: XLinkService | null): void {
    this.xLinks = x;
  }

  /** `fn()`: flush every store to disk (the backup's consistent snapshot). */
  setFlush(fn: (() => void) | null): void {
    this.flushAll = fn;
  }

  setIntegrity(svc: IntegrityService | null): void {
    this.integrity = svc;
  }

  setMaps(admin: MapAdmin | null): void {
    this.maps = admin;
  }

  setScaler(scaler: ArenaScaler | null): void {
    this.scaler = scaler;
  }

  setTestArenas(rooms: Pick<RoomManager, 'testArenas' | 'testArenaView'> | null): void {
    this.testArenas = rooms;
  }

  /** The game server's load per thread (`GET /api/admin/load`, `NetworkInfo.load`). */
  setLoad(fn: (() => GameServerLoad) | null): void {
    this.load = fn;
  }

  private load: (() => GameServerLoad) | null = null;

  setCustomRooms(svc: CustomRoomService | null): void {
    this.customRooms = svc;
  }

  setArenaPrices(store: ArenaPriceStore | null): void {
    this.arenaPrices = store;
  }

  /** "Re-price at next bell" (`/api/admin/reprice`); absent in bare unit tests. */
  private reprice: RepriceScheduler | null = null;

  setReprice(r: RepriceScheduler | null): void {
    this.reprice = r;
  }

  setShop(shop: { service: ShopService; settings: ShopSettingsStore; inventory: BoostInventory } | null): void {
    this.shop = shop;
  }

  /** Admin wallets compare case-insensitively (stored checksummed). */
  isAdmin(wallet: string | null | undefined): boolean {
    return !!wallet && this.admins.has(wallet.toLowerCase());
  }

  /**
   * Who may play: `GAME_ACCESS` when set, else the admin's setting. A request or a socket from an open-play copy of the
   * site (`OPEN_PLAY_ORIGINS`, its `Origin` header) gets `public` on a testnet, unless the server is in maintenance.
   */
  gameAccess(origin?: Origin): GameAccess {
    const mode = this.cfg.gameAccess ?? this.store.settings.gameAccess;
    return mode !== 'maintenance' && this.openPlay(origin) ? 'public' : mode;
  }

  /** Whether `origin` is an open-play copy of the site and this server runs on a testnet (never on the mainnet). */
  private openPlay(origin: Origin): boolean {
    if (typeof origin !== 'string' || !isOpenPlayOrigin(origin)) return false;
    const live = this.chainId();
    return isTestChainId(this.cfg.chain.chainId) && (live === null || isTestChainId(live));
  }

  /** Whether `wallet` holds a Coinnibal NFT (cached 15 s, `fresh` re-reads; false without an NFT or a chain). */
  async isHolder(wallet: string | null | undefined, fresh = false): Promise<boolean> {
    return !!wallet && !!this.ext.mint && (await this.ext.mint.isHolder(wallet, fresh));
  }

  /**
   * The same for a value that is only shown (a profile's skins, the `holder` field of `/api/auth/me`): never busy (no
   * 429 for a budget) and never a chain read of its own: the "holder" on record, else false, not kept.
   */
  async shownHolder(wallet: string | null | undefined): Promise<boolean> {
    return !!wallet && !!this.ext.mint && (await this.ext.mint.shownHolder(wallet));
  }

  /**
   * Whether `wallet` may enter game rooms: admins always; NFT holders in `holders` mode; everyone in `public`.
   * `fresh`: the holder check skips its 15 s cache (the gateway asks so right before seating an arena ticket).
   */
  async gameOpenFor(wallet: string | null | undefined, fresh = false, origin?: Origin): Promise<boolean> {
    const mode = this.gameAccess(origin);
    if (mode === 'public' || this.isAdmin(wallet)) return true;
    if (mode === 'holders') return this.isHolder(wallet, fresh);
    return false;
  }

  /**
   * `gameOpenFor` for a value that is only shown (the shop's prices): never busy, never a chain read of its own; a
   * holder on record may, anyone else is answered as not a holder (not kept).
   */
  async gameShownFor(wallet: string | null | undefined, origin?: Origin): Promise<boolean> {
    const mode = this.gameAccess(origin);
    if (mode === 'public' || this.isAdmin(wallet)) return true;
    if (mode === 'holders') return this.shownHolder(wallet);
    return false;
  }

  /**
   * Whether `wallet` may read the test-token faucet (`GET /api/site/faucet`): everyone while the game shows on the site
   * (`gameVisible`: every mode but `admins`, the rule of the site's /faucet page), else admins only.
   */
  faucetOpenFor(wallet: string | null | undefined, origin?: Origin): boolean {
    return gameVisible(this.gameAccess(origin)) || this.isAdmin(wallet);
  }

  /** The settings everyone can read; `gameAccess` is the effective value (for this request's origin). */
  publicSettings(origin?: Origin): SiteSettings {
    return { ...this.store.settings, gameAccess: this.gameAccess(origin) };
  }

  private baseUrl(req: IncomingMessage): string {
    return this.ext.baseUrl?.(req) ?? this.cfg.publicUrl ?? `http://localhost:${this.cfg.port}`;
  }

  private chainId(): number | null {
    return this.ext.chain?.status().chainId ?? null;
  }

  /**
   * Handles the request when the path is the site's; false otherwise. `ip`: the client's rate-limit key (`rateKey`:
   * an IPv6 client counts as its /64); `auditIp`: its exact address, for the admin audit and the logs.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, ip: string, auditIp = ip): Promise<boolean> {
    const path = url.pathname;
    const mine =
      path.startsWith('/api/site/') ||
      path.startsWith('/api/admin/') ||
      path.startsWith('/api/nft/') ||
      path.startsWith('/api/avatar/') ||
      path === '/api/auth/login' ||
      path === '/api/auth/me' ||
      path === '/api/profile' ||
      path === '/api/profile/avatar' ||
      path === '/api/rooms/custom' ||
      path.startsWith('/api/rooms/custom/') ||
      path === '/api/shop' ||
      path === '/api/shop/buy' ||
      path === '/api/x' ||
      path.startsWith('/api/x/') ||
      path === '/api/feedback';
    if (!mine) return false;
    try {
      if (path === '/api/auth/login' || path === '/api/auth/me') await this.authRoutes(req, res, path, ip);
      else if (path === '/api/profile') await this.profileRoutes(req, res, ip);
      else if (path === '/api/profile/avatar') await this.uploadRoutes(req, res, ip);
      else if (path === '/api/shop' || path === '/api/shop/buy') await this.shopRoutes(req, res, path, ip);
      else if (path.startsWith('/api/avatar/')) this.serveAvatar(req, res, path.slice('/api/avatar/'.length));
      else if (path === '/api/x' || path.startsWith('/api/x/')) await this.xRoutes(req, res, path, ip);
      else if (path.startsWith('/api/nft/')) await this.nftRoutes(req, res, url);
      else if (path.startsWith('/api/site/')) await this.siteRoutes(req, res, url, ip);
      else if (path.startsWith('/api/rooms/custom')) await this.customRoutes(req, res, path, ip);
      else if (path === '/api/feedback') await this.feedbackRoute(req, res, ip);
      else await this.audited(req, res, url, auditIp);
    } catch (err) {
      if (err instanceof SiteFail && err.status === 413) res.setHeader('Connection', 'close');
      if (err instanceof SiteFail) fail(res, err.status, { error: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) });
      // a holder check past this client's holder reads that the holder index cannot answer now: busy, never a wrong "no"
      else if (err instanceof ClientBudgetError) fail(res, 429, { error: 'rate_limited', message: CLIENT_BUSY_MESSAGE });
      else throw err;
    }
    return true;
  }

  private method(req: IncomingMessage, ...allowed: string[]): string {
    const m = req.method ?? 'GET';
    if (!allowed.includes(m)) throw new SiteFail(405, 'method_not_allowed', `Use ${allowed.join(' or ')}`);
    return m;
  }

  private session(req: IncomingMessage): string {
    const wallet = bearerWallet(this.auth, req);
    if (!wallet) throw new SiteFail(401, 'unauthorized', 'Sign in with your wallet first.');
    return wallet;
  }

  private async authRoutes(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (path === '/api/auth/me') {
      this.method(req, 'GET');
      const wallet = this.session(req);
      const admin = this.isAdmin(wallet);
      // `canPlay` is the gate: a holder check the holder index cannot answer right now, past this client's holder
      // reads (`ClientBudgetError`), is `busy` (ask again in a moment), never a wrong "no". `holder` is only shown,
      // after it (the answer the gate just had is the one on record): never busy, never a chain read of its own
      const canPlay = await this.gameOpenFor(wallet, false, req.headers.origin).catch((err: unknown) => (err instanceof ClientBudgetError ? ('busy' as const) : Promise.reject(err)));
      const holder = await this.shownHolder(wallet);
      return send(res, 200, { address: wallet, admin, holder, canPlay: canPlay === true, ...(canPlay === 'busy' ? { busy: true } : {}) });
    }
    this.method(req, 'POST');
    if (!this.limits.login.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many sign-ins. Wait a moment.');
    const body = await readJson(req);
    const { address, message, signature } = body;
    let wallet: string | null = null;
    if (typeof address === 'string' && typeof message === 'string' && typeof signature === 'string') {
      try {
        wallet = await this.auth.verifySignature(address, message, signature);
      } catch (err) {
        // the smart-wallet check cannot run right now: busy, not a wrong signature (the nonce is kept)
        if (err instanceof SignInBusyError) throw new SiteFail(429, 'rate_limited', SIGN_IN_BUSY_MESSAGE);
        throw err;
      }
    }
    if (!wallet) throw new SiteFail(401, 'auth_failed', 'Wallet sign-in failed. Please sign again.');
    send(res, 200, { address: wallet, token: this.auth.issueToken(wallet), admin: this.isAdmin(wallet) });
  }

  /**
   * `GET /api/shop` (the packs priced for the signed-in wallet, public prices without a session) and
   * `POST /api/shop/buy {cart, txHash}` (signed-in; `{kind, txHash}` for one pack from older clients): verifies the
   * game-token payment on chain and credits the packs. Refusals answer `{ error: ShopBuyError, message }`.
   */
  private async shopRoutes(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const shop = this.shop;
    if (!shop) throw new SiteFail(404, 'not_found', 'Not found');
    if (path === '/api/shop') {
      this.method(req, 'GET');
      const wallet = bearerWallet(this.auth, req);
      // the packs' prices are a quote for play: only for whoever may play now. A purchase (below) is not gated: a
      // payment someone made anyway is credited (or owed back), never kept for nothing
      if (!(await this.gameShownFor(wallet, req.headers.origin))) throw new SiteFail(403, 'game_closed', 'The game is not open yet.');
      return send(res, 200, await shop.service.view(wallet));
    }
    this.method(req, 'POST');
    const wallet = this.session(req);
    if (!this.shopBuys.allow(wallet) || !this.shopBuys.allow(`ip:${ip}`)) throw new SiteFail(429, 'rate_limited', 'Too many purchases at once. Wait a moment.');
    const body = await readJson(req);
    try {
      // `cart`: several power-ups in one payment; `kind`: one pack (older clients)
      return send(res, 200, body.cart !== undefined ? await shop.service.buyCart(wallet, body) : await shop.service.buy(wallet, body));
    } catch (err) {
      if (err instanceof ShopFail) return send(res, err.status, { error: err.code, message: err.message });
      throw err;
    }
  }

  /** Skin ids a wallet may pick: the basic skins, plus the emblem skin for holders. */
  private skinOptions(holder: boolean): number[] {
    return [...BASIC_SKINS.map((s) => s.id), ...(holder ? [EMBLEM_SKIN_ID] : [])];
  }

  /** `GET /api/profile` and `PUT /api/profile {name, skin}` (signed-in): `{ profile, skinOptions, holder }`. */
  private async profileRoutes(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const profiles = this.ext.profiles;
    if (!profiles) throw new SiteFail(404, 'not_found', 'Not found');
    if (this.method(req, 'GET', 'PUT') === 'GET') {
      const wallet = this.session(req);
      const holder = await this.shownHolder(wallet);
      return send(res, 200, { profile: profiles.view(wallet), skinOptions: this.skinOptions(holder), holder } satisfies ProfileResponse);
    }
    const wallet = this.writer(req, ip);
    const body = await readJson(req);
    // the emblem skin is checked on chain right now (a sold emblem no longer unlocks it); otherwise the answer's skin
    // list is only shown
    const holder = body.skin === EMBLEM_SKIN_ID ? await this.isHolder(wallet, true) : await this.shownHolder(wallet);
    try {
      return send(res, 200, { profile: profiles.update(wallet, body, { emblem: holder }), skinOptions: this.skinOptions(holder), holder } satisfies ProfileResponse);
    } catch (err) {
      if (err instanceof ProfileError) throw new SiteFail(400, 'bad_request', err.message, err.field);
      throw err;
    }
  }

  /**
   * `POST /api/profile/avatar` (raw `image/png` or `image/webp` body, at most `AVATAR_LIMITS.maxBytes`,
   * signed-in): stores the cleaned picture as the wallet's; `DELETE` removes it. Both answer `{ profile }`.
   */
  private async uploadRoutes(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const profiles = this.ext.profiles;
    const store = this.ext.avatars;
    if (!profiles || !store) throw new SiteFail(404, 'not_found', 'Not found');
    if (this.method(req, 'POST', 'DELETE') === 'DELETE') {
      const wallet = this.writer(req, ip);
      this.dropAvatar(wallet, false);
      return send(res, 200, { profile: profiles.view(wallet) });
    }
    if (!this.avatarIp.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many pictures. Try again in an hour.');
    const wallet = this.session(req);
    const type = String(req.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim();
    if (!(AVATAR_TYPES as readonly string[]).includes(type)) throw new SiteFail(415, 'unsupported_media_type', 'Send the picture as image/webp or image/png');
    if (!this.avatarWallet.allow(wallet)) throw new SiteFail(429, 'rate_limited', 'Too many pictures. Try again in an hour.');
    const body = await readRaw(req, AVATAR_LIMITS.maxBytes);
    let id: string;
    try {
      const clean = sanitizeAvatar(body);
      if (clean.type !== type) throw new AvatarError('bad_image', 'The picture does not match its content type');
      if (store.isBlocked(avatarIdOf(clean.bytes))) throw new SiteFail(403, 'image_blocked', 'This picture was removed by a moderator and cannot be used.');
      id = store.put(clean);
    } catch (err) {
      if (err instanceof AvatarError) throw new SiteFail(err.code === 'body_too_large' ? 413 : 400, err.code, err.message);
      throw err;
    }
    const before = profiles.setAvatar(wallet, id);
    if (before && before !== id) {
      if (profiles.avatarUsers(before) === 0) store.delete(before);
      this.avatarChanged?.(wallet);
    }
    return send(res, 201, { profile: profiles.view(wallet) });
  }

  /** Clears a wallet's picture; `block`: an admin removed it (the file goes and cannot come back). */
  private dropAvatar(wallet: string, block: boolean): string | null {
    const profiles = this.ext.profiles!;
    const store = this.ext.avatars!;
    const before = profiles.avatar(wallet);
    if (!before) return null;
    profiles.setAvatar(wallet, null);
    if (block) {
      // every profile wearing the same picture loses it too
      for (const e of profiles.avatars(Number.MAX_SAFE_INTEGER).items) {
        if (e.avatar !== before) continue;
        profiles.setAvatar(e.wallet, null);
        this.avatarChanged?.(e.wallet);
      }
      store.block(before);
    } else if (profiles.avatarUsers(before) === 0) store.delete(before);
    this.avatarChanged?.(wallet);
    return before;
  }

  /**
   * "Link X" (signed-in unless said otherwise): `GET /api/x` (the link and the pending code), `POST /api/x/code` (a
   * new code), `POST /api/x/verify {url}` (the proof post's link), `DELETE /api/x` (unlink), `POST /api/x/picture`
   * (wear the X picture on the coin: it becomes the profile picture) and `GET /api/x/avatar/<userId>` (public: the
   * cached picture of a linked account). Refusals answer `{ error, message }` (`XLinkError`).
   */
  private async xRoutes(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const x = this.xLinks;
    if (!x) throw new SiteFail(404, 'not_found', 'Not found');
    // the site named in the proof post: the public site's host, else the game's own name for it
    const site = siteHostOf(this.cfg.publicUrl);
    try {
      if (path.startsWith('/api/x/avatar/')) {
        this.method(req, 'GET', 'HEAD');
        const file = await x.avatar(path.slice('/api/x/avatar/'.length));
        if (!file) throw new SiteFail(404, 'not_found', 'No such picture');
        res.writeHead(200, {
          'Content-Type': file.type,
          'Content-Length': file.bytes.length,
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        res.end(req.method === 'HEAD' ? undefined : file.bytes);
        return;
      }
      if (path === '/api/x') {
        if (this.method(req, 'GET', 'DELETE') === 'GET') return send(res, 200, x.status(this.session(req), site));
        const wallet = this.writer(req, ip);
        x.unlink(wallet);
        return send(res, 200, x.status(wallet, site));
      }
      if (path === '/api/x/code') {
        this.method(req, 'POST');
        const wallet = this.writer(req, ip);
        return send(res, 201, { code: x.issueCode(wallet, ip, site) });
      }
      if (path === '/api/x/verify') {
        this.method(req, 'POST');
        const wallet = this.writer(req, ip);
        const body = await readJson(req);
        const { link } = await x.verify(wallet, ip, body.url);
        return send(res, 200, { link, code: null });
      }
      if (path === '/api/x/picture') {
        this.method(req, 'POST');
        return send(res, 201, { profile: await this.wearXPicture(this.writer(req, ip), ip) });
      }
    } catch (err) {
      if (err instanceof XLinkFail) throw new SiteFail(err.status, err.code, err.message);
      throw err;
    }
    throw new SiteFail(404, 'not_found', 'Not found');
  }

  /** The linked account's picture, squared to `AVATAR_LIMITS.px` and cleaned, becomes the wallet's profile picture. */
  private async wearXPicture(wallet: string, ip: string): Promise<unknown> {
    const profiles = this.ext.profiles;
    const store = this.ext.avatars;
    const userId = this.xLinks?.links.get(wallet)?.userId;
    if (!profiles || !store) throw new SiteFail(404, 'not_found', 'Not found');
    if (!userId) throw new SiteFail(409, 'x_picture_unavailable', 'Your linked X account has no picture we can use. Upload one instead.');
    if (!this.avatarIp.allow(ip) || !this.avatarWallet.allow(wallet)) throw new SiteFail(429, 'rate_limited', 'Too many pictures. Try again in an hour.');
    const file = await this.xLinks!.avatar(userId);
    if (!file) throw new SiteFail(409, 'x_picture_unavailable', 'We could not get your X picture right now. Try again later or upload one.');
    let id: string;
    try {
      const clean = sanitizeAvatar(await squarePng(file.bytes, AVATAR_LIMITS.px));
      if (store.isBlocked(avatarIdOf(clean.bytes))) throw new SiteFail(403, 'image_blocked', 'This picture was removed by a moderator and cannot be used.');
      id = store.put(clean);
    } catch (err) {
      if (err instanceof SiteFail) throw err;
      this.ext.log?.(`x-links: the X picture of ${wallet} could not be used (${(err as Error).message})`);
      throw new SiteFail(503, 'x_picture_unavailable', 'Your X picture cannot be used here right now. Upload one instead.');
    }
    const before = profiles.setAvatar(wallet, id);
    if (before && before !== id) {
      if (profiles.avatarUsers(before) === 0) store.delete(before);
      this.avatarChanged?.(wallet);
    }
    return profiles.view(wallet);
  }

  /** `GET /api/avatar/<id>`: the picture file (immutable: an id is the hash of its bytes). */
  private serveAvatar(req: IncomingMessage, res: ServerResponse, id: string): void {
    this.method(req, 'GET', 'HEAD');
    const file = isAvatarId(id) ? this.ext.avatars?.get(id) : null;
    if (!file) throw new SiteFail(404, 'not_found', 'No such picture');
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.bytes.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
  }

  /**
   * `GET /api/nft/contract`, `/api/nft/provenance`, `/api/nft/rarity`, `/api/nft/<id>` (JSON) and
   * `/api/nft/<id>.svg` (`?style=vector|pixel` previews the other style): minted ids only. Before the reveal
   * every token is the sealed emblem, cached briefly so marketplaces pick up the reveal.
   */
  private async nftRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.method(req, 'GET');
    const mint = this.ext.mint;
    const nft = this.ext.nft;
    const rest = url.pathname.slice('/api/nft/'.length);
    if (!mint || !nft) throw new SiteFail(404, 'not_found', 'Not found');
    const base = this.baseUrl(req);
    if (rest === 'contract') return send(res, 200, await mint.contractMetadata(base, nft.provenance()));
    if (rest === 'provenance') return send(res, 200, nft.provenance());
    if (rest === 'rarity') return send(res, 200, nft.stats());
    const parsed = parseNftPath(rest);
    if (!parsed || !(await mint.minted(parsed.id))) throw new SiteFail(404, 'not_found', 'No such token');
    const cache = nft.revealed ? 'public, max-age=86400' : 'public, max-age=60';
    if (parsed.svg) {
      const style = parseArtStyle(url.searchParams.get('style')) ?? nft.style;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': cache });
      res.end(nft.svg(parsed.id, style));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': nft.revealed ? 'public, max-age=300' : 'public, max-age=60' });
    res.end(JSON.stringify(nft.metadata(parsed.id, base)));
  }

  /** `/api/admin/nft`: the collection (provenance, stats, reveal state) and the two reveal steps. */
  private async nftAdmin(req: IncomingMessage, res: ServerResponse, seg: string[]): Promise<void> {
    const nft = this.ext.nft;
    const mint = this.ext.mint;
    if (!nft || !mint) throw new SiteFail(503, 'chain_off', 'The NFT is not available on this server.');
    const client = this.ext.chain?.evm?.() ?? null;
    const asSite = (err: unknown): never => {
      if (err instanceof CollectionFail) throw new SiteFail(err.status, err.status === 400 ? 'bad_request' : 'wrong_state', err.message);
      throw err;
    };
    if (seg.length === 1) {
      this.method(req, 'GET');
      const state = await mint.chainState().catch(() => null);
      const current = client ? await client.blockNumber().catch(() => null) : null;
      return send(res, 200, {
        provenance: nft.provenance(),
        stats: nft.stats(),
        style: nft.style,
        currentBlock: current?.toString() ?? null,
        mint: state ? { phase: state.phaseName, totalSupply: state.totalSupply, maxSupply: state.maxSupply, soldOut: state.soldOut } : null,
      } satisfies NftCollectionAdminView);
    }
    if (seg.length === 3 && seg[1] === 'reveal' && seg[2] === 'schedule') {
      this.method(req, 'POST');
      const body = obj(await readJson(req));
      if (!client) throw new SiteFail(503, 'chain_off', 'The chain is not available on this server.');
      const state = await mint.chainState(true);
      if (!state) throw new SiteFail(503, 'chain_off', 'The NFT is not registered or its state cannot be read.');
      const raw = body.block;
      if (raw !== undefined && raw !== null && !(typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) && !(typeof raw === 'string' && /^[1-9]\d{0,18}$/.test(raw))) {
        throw new SiteFail(400, 'bad_request', 'block must be a positive block number', 'block');
      }
      try {
        return send(res, 200, nft.schedule({ block: raw === undefined || raw === null ? null : BigInt(raw as number | string), current: await client.blockNumber(), mintOpen: state.phaseName !== 'closed', soldOut: state.soldOut, maxSupply: state.maxSupply }));
      } catch (err) {
        return asSite(err);
      }
    }
    if (seg.length === 2 && seg[1] === 'reveal') {
      this.method(req, 'POST');
      if (!client) throw new SiteFail(503, 'chain_off', 'The chain is not available on this server.');
      try {
        return send(res, 200, await nft.reveal((n) => client.blockHash(n)));
      } catch (err) {
        return asSite(err);
      }
    }
    throw new SiteFail(404, 'not_found', 'Not found');
  }

  /**
   * `POST /api/feedback {text, contact?, page?, room?, viewport?, build?}` from the game page's Feedback sheet: guests
   * too; the wallet is the session's (`Authorization`, when it verifies), never the body's. Limited per client, per
   * wallet and server-wide; answers `{ ok: true }`.
   */
  private async feedbackRoute(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    this.method(req, 'POST');
    const lim = this.feedbackLimits;
    const busy = () => new SiteFail(429, 'rate_limited', 'You sent several messages just now. Try again in a few minutes.');
    if (!lim.feedbackIp.allow(ip)) throw busy();
    const input = parseFeedback(await readJson(req, FEEDBACK_LIMITS.bodyBytes));
    const wallet = bearerWallet(this.auth, req);
    if (wallet && !lim.feedbackWallet.allow(wallet.toLowerCase())) throw busy();
    if (!lim.feedbackAll.allow('all')) throw new SiteFail(429, 'rate_limited', 'Many messages are arriving right now. Try again in a few minutes.');
    this.feedback.add(input, wallet);
    return send(res, 201, { ok: true });
  }

  /** Rate limits a write: per IP before the session is known, then per wallet. */
  private writer(req: IncomingMessage, ip: string): string {
    if (!this.limits.writeIp.allow(ip)) throw new SiteFail(429, 'rate_limited', 'Too many requests. Try again in a few minutes.');
    const wallet = this.session(req);
    if (!this.limits.writeWallet.allow(wallet)) throw new SiteFail(429, 'rate_limited', 'Too many requests. Try again in a few minutes.');
    return wallet;
  }

  private async customRoutes(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const svc = this.customRooms;
    if (!svc) throw new SiteFail(404, 'not_found', 'Not found');
    const rest = path.slice('/api/rooms/custom'.length).replace(/^\//, '');
    // opening a room (paid, or free practice) and its price quote follow the game gate: the join over the WebSocket
    // would be refused anyway, and nobody should pay for (or spend a practice slot on) a room they cannot enter. The
    // quote is only shown (never busy: `gameShownFor`); opening one is the gate decision (busy, never a wrong "no")
    const quote = req.method === 'GET' && rest === 'quote';
    const origin = req.headers.origin;
    if ((req.method === 'POST' || quote) && !(await (quote ? this.gameShownFor(bearerWallet(this.auth, req), origin) : this.gameOpenFor(bearerWallet(this.auth, req), false, origin)))) {
      throw new SiteFail(403, 'game_closed', 'The game is not open yet.');
    }
    return customRoomRoutes(
      svc,
      {
        send,
        method: (r, ...m) => this.method(r, ...m),
        readJson: (r) => readJson(r),
        wallet: (r) => bearerWallet(this.auth, r),
        writer: (r) => this.writer(r, ip),
        isAdmin: (w) => this.isAdmin(w),
        origin: (r) => this.baseUrl(r),
        practiceIp: () => {
          if (!this.practiceIps.allow(ip)) throw new SiteFail(429, 'rate_limited', 'You opened several practice rooms lately. Try again in a while, or play in a pond.');
          return ip;
        },
      },
      req,
      res,
      rest === '' ? [] : rest.split('/'),
    );
  }

  private async siteRoutes(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    const seg = url.pathname.slice('/api/site/'.length).split('/');
    const s = this.store;
    switch (seg[0]) {
      case 'settings':
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        return send(res, 200, { settings: this.publicSettings(req.headers.origin) });
      case 'tasks':
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        return send(res, 200, { tasks: s.publicTasks() });
      case 'contracts':
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        return send(res, 200, this.ext.contracts?.effective(this.chainId()) ?? { arena: null, nft: null, token: null });
      case 'arena-prices': {
        // the tiers in US dollars and the token's USD price: the lobby shows "$1" next to the token amount
        if (seg.length !== 1 || !this.arenaPrices) break;
        this.method(req, 'GET');
        return send(res, 200, await this.arenaPrices.view());
      }
      case 'faucet': {
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        // the test-token faucet belongs to the game: hidden (like the site's /faucet page) while only admins play
        if (!this.faucetOpenFor(bearerWallet(this.auth, req), req.headers.origin)) throw new SiteFail(403, 'game_closed', 'The game is not open yet.');
        const faucet = this.ext.faucet ?? (this.ext.chain ? new FaucetInfo({ chain: this.ext.chain, contracts: this.ext.contracts ?? null }) : null);
        if (!faucet) throw new SiteFail(503, 'chain_off', 'The faucet is not available on this server.');
        return send(res, 200, await faucet.get());
      }
      case 'mint': {
        const mint = this.ext.mint;
        if (seg.length === 1) {
          this.method(req, 'GET');
          if (!mint) throw new SiteFail(503, 'chain_off', 'The mint is not available on this server.');
          return send(res, 200, await mint.publicState(this.gameAccess(req.headers.origin), this.store.settings.mintOpen || this.isAdmin(bearerWallet(this.auth, req))));
        }
        if (seg.length === 2 && seg[1] === 'proof') {
          this.method(req, 'GET');
          if (!mint) throw new SiteFail(503, 'chain_off', 'The mint is not available on this server.');
          return send(res, 200, await mint.proof(url.searchParams.get('wallet')));
        }
        break;
      }
      case 'wl': {
        if (seg.length !== 1) break;
        if (this.method(req, 'GET', 'POST') === 'GET') return send(res, 200, { entry: s.myWl(this.session(req)) });
        const wallet = this.writer(req, ip);
        return send(res, 201, { entry: s.submitWl(wallet, await readJson(req)) });
      }
      case 'collab': {
        if (seg.length === 1) {
          if (this.method(req, 'GET', 'POST') === 'GET') return send(res, 200, { collabs: s.myCollabs(this.session(req)) });
          const wallet = this.writer(req, ip);
          return send(res, 201, { collab: s.applyCollab(wallet, await readJson(req)) });
        }
        if (seg.length === 3 && seg[2] === 'wallets') {
          this.method(req, 'PUT');
          const wallet = this.writer(req, ip);
          return send(res, 200, { collab: s.saveCollabWallets(wallet, seg[1], await readJson(req)) });
        }
        if (seg.length === 3 && seg[2] === 'submit') {
          this.method(req, 'POST');
          const wallet = this.writer(req, ip);
          return send(res, 200, { collab: s.submitCollab(wallet, seg[1], await readJson(req)) });
        }
        break;
      }
    }
    throw new SiteFail(404, 'not_found', 'Not found');
  }

  /**
   * `adminRoutes` with every write of a signed-in admin recorded in the audit log (status included, failures too),
   * and every request of the routes that hand out secrets (`SECRET_ROUTES`), reads included.
   */
  private async audited(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    const sensitive = SECRET_ROUTES.has(url.pathname.slice('/api/admin/'.length).split('/')[0]);
    const write = sensitive || (req.method !== 'GET' && req.method !== 'HEAD');
    const wallet = write ? bearerWallet(this.auth, req) : null;
    if (!write || !wallet || !this.isAdmin(wallet)) return this.adminRoutes(req, res, url, ip);
    let status = 500;
    try {
      await this.adminRoutes(req, res, url, ip);
      status = res.statusCode;
    } catch (err) {
      status = err instanceof SiteFail ? err.status : 500;
      throw err;
    } finally {
      this.audit.record({ at: Date.now(), wallet, method: req.method ?? '?', path: url.pathname, status, ip });
    }
  }

  /** Whether the secret exports (backup, migration settings) may run: `ADMIN_SECRET_EXPORT`, else on every chain but the mainnet. */
  secretExportAllowed(): boolean {
    if (this.cfg.adminSecretExport !== null) return this.cfg.adminSecretExport;
    return this.chainId() !== ROBINHOOD_CHAIN_ID && this.cfg.chain.chainId !== ROBINHOOD_CHAIN_ID;
  }

  /** The secret exports: refused on the mainnet without `ADMIN_SECRET_EXPORT=1`, then a fresh purpose-bound signature. */
  private async secretGate(req: IncomingMessage, wallet: string, route: SecretRoute): Promise<void> {
    if (!this.secretExportAllowed()) {
      throw new SiteFail(403, 'disabled', 'Secret exports are off on the mainnet. Set ADMIN_SECRET_EXPORT=1 on the server (and restart) for the time of the move, then remove it.');
    }
    try {
      await this.proofs.consume(req.headers[SECRET_PROOF_HEADER] ?? req.headers[OLD_SECRET_PROOF_HEADER], wallet, route);
    } catch (err) {
      if (err instanceof SecretProofError) throw new SiteFail(401, 'proof_required', err.message);
      throw err;
    }
  }

  private async adminRoutes(req: IncomingMessage, res: ServerResponse, url: URL, ip = ''): Promise<void> {
    const wallet = this.session(req);
    if (!this.isAdmin(wallet)) throw new SiteFail(403, 'forbidden', 'This wallet is not an admin.');
    // admin sessions are short and revocable: a player-length (or revoked) token of an admin wallet is not enough
    if (!this.auth.verifyAdminToken(/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim())?.[1])) {
      throw new SiteFail(401, 'admin_session_expired', 'Your admin session ended (they last a short time). Sign in again.');
    }
    const seg = url.pathname.slice('/api/admin/'.length).split('/');
    const q = url.searchParams;
    const s = this.store;
    const day = new Date().toISOString().slice(0, 10);
    switch (seg[0]) {
      case 'me':
        this.method(req, 'GET');
        return send(res, 200, { address: wallet, admin: true });
      case 'audit': {
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        const limit = Math.min(5000, Math.max(1, Math.floor(Number(q.get('limit') ?? 500)) || 500));
        return send(res, 200, { entries: this.audit.recent(limit) });
      }
      case 'network': {
        if (seg.length !== 1 || !this.ext.chain) break;
        this.method(req, 'GET');
        const info = await networkInfo({ chain: this.ext.chain, contracts: this.ext.contracts ?? null, dataDir: this.ext.dataDir ?? null });
        return send(res, 200, this.load ? { ...info, load: this.load() } : info);
      }
      case 'load': {
        if (seg.length !== 1 || !this.load) break;
        this.method(req, 'GET');
        return send(res, 200, this.load());
      }
      case 'contracts': {
        if (seg.length !== 1) break;
        const contracts = this.ext.contracts;
        if (!contracts) throw new SiteFail(503, 'chain_off', 'The contracts registry is not available on this server.');
        const m = this.method(req, 'GET', 'POST', 'DELETE');
        if (m === 'GET') return send(res, 200, { registry: contracts.effective(this.chainId()), stored: contracts.stored() });
        if (m === 'DELETE') {
          const cleared = clearContract({ journal: this.ext.journal ?? null, store: contracts }, q.get('kind'));
          return send(res, 200, { cleared, registry: contracts.effective(this.chainId()) });
        }
        const chain = this.ext.chain;
        const record = await registerContract(
          {
            client: chain?.evm?.() ?? null,
            chainId: this.chainId(),
            serverKey: chain?.serverInfo().address ?? null,
            journal: this.ext.journal ?? null,
            store: contracts,
            now: Date.now(),
          },
          await readJson(req),
          wallet,
        );
        return send(res, 201, { record, registry: contracts.effective(this.chainId()) });
      }
      case 'mint': {
        const mint = this.ext.mint;
        if (!mint) throw new SiteFail(503, 'chain_off', 'The mint is not available on this server.');
        if (seg.length === 2 && seg[1] === 'allowlist') {
          if (this.method(req, 'GET', 'POST') === 'GET') return send(res, 200, await mint.allowlistStatus());
          return send(res, 201, mint.buildAllowlist(wallet));
        }
        if (seg.length === 2 && seg[1] === 'import-holders') {
          const store = this.ext.holderWl;
          if (!store) throw new SiteFail(503, 'chain_off', 'Holder imports are not available on this server.');
          const onList = () => {
            const src = this.store.allowlistSources();
            const set = new Set([...src.wl, ...src.collab].map((w) => w.toLowerCase()));
            return (w: string) => set.has(w.toLowerCase());
          };
          if (this.method(req, 'GET', 'POST') === 'GET') return send(res, 200, store.view(onList()));
          await importHolders(
            {
              store,
              nftOf: (id) => this.ext.nftOf?.(id) ?? null,
              readerFor: (id) => this.ext.holderReaderFor?.(id) ?? null,
              chunkBlocks: this.cfg.chain.logChunkBlocks,
              now: Date.now(),
              log: this.ext.log,
            },
            await readJson(req),
            wallet,
          );
          return send(res, 201, store.view(onList()));
        }
        if (seg.length === 2 && seg[1] === 'refresh') {
          // after an owner transaction on the NFT (phase, root, price, limits): the mint page's cached
          // state is re-read now, so visitors do not see the old phase for the next half minute
          this.method(req, 'POST');
          const state = await mint.chainState(true);
          return send(res, 200, { refreshed: state !== null });
        }
        if (seg.length === 2 && seg[1] === 'price') {
          this.method(req, 'GET');
          const quote = await mint.priceQuote();
          if (quote.gasUsd === null) throw new SiteFail(502, 'price_unavailable', `The ${GAS_SYMBOL}/USD price feed is unavailable right now.`);
          return send(res, 200, quote);
        }
        break;
      }
      case 'nft':
        return this.nftAdmin(req, res, seg);
      case 'reprice': {
        // "Re-price at next bell": GET the arenas on their way; POST {"arenaIds":[1,2]} closes them at the next bell
        // (joins close at the round's last minute, the bell and the drain, then "ready to sign"); POST
        // {"arenaIds":[1],"cancel":true} opens them again without a re-price. The owner signs updateArena in /admin
        if (seg.length !== 1 || !this.reprice) break;
        if (this.method(req, 'GET', 'POST') === 'GET') return send(res, 200, { entries: this.reprice.view() });
        const body = await readJson(req);
        const ids = Array.isArray(body.arenaIds) ? body.arenaIds : null;
        if (!ids || ids.length === 0 || ids.length > 16 || !ids.every((x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 65_535)) {
          throw new SiteFail(400, 'bad_request', 'arenaIds must be a list of arena ids', 'arenaIds');
        }
        if (body.cancel === true) return send(res, 200, { entries: this.reprice.cancel(ids as number[], wallet) });
        try {
          return send(res, 200, { entries: await this.reprice.schedule(ids as number[], wallet) });
        } catch (err) {
          if (err instanceof RepriceFail) throw new SiteFail(400, 'bad_request', err.message, 'arenaIds');
          throw err;
        }
      }
      case 'secret-proof': {
        // the text an admin signs to open one secret export (backup, migration settings), single use, 10 minutes
        if (seg.length !== 1) break;
        this.method(req, 'POST');
        const purpose = (await readJson(req)).purpose;
        if (!SECRET_PURPOSES.includes(purpose as SecretPurpose)) throw new SiteFail(400, 'bad_request', `purpose must be one of ${SECRET_PURPOSES.join(', ')}`, 'purpose');
        if (!this.secretExportAllowed()) throw new SiteFail(403, 'disabled', 'Secret exports are off on the mainnet. Set ADMIN_SECRET_EXPORT=1 on the server for the time of the move.');
        const domain = new URL(this.baseUrl(req)).host;
        return send(res, 200, { ...this.proofs.issue(wallet, purpose as SecretPurpose, { domain, chainId: this.chainId() }), header: 'X-Coinnibal-Proof' });
      }
      case 'auth': {
        // POST /api/admin/auth/revoke {"wallet": "0x…"} ends that wallet's sessions; {"wallet": "admins"} every admin session
        if (seg.length !== 2 || seg[1] !== 'revoke') break;
        this.method(req, 'POST');
        const who = (await readJson(req)).wallet;
        if (who === 'admins') this.auth.revoke(null);
        else {
          const target = checksumAddress(who);
          if (!target) throw new SiteFail(400, 'bad_request', 'wallet must be a 0x address or "admins"', 'wallet');
          this.auth.revoke(target);
        }
        this.ext.log?.(`auth: sessions of ${who === 'admins' ? 'every admin' : String(who)} revoked by ${wallet}${ip ? ` from ${ip}` : ''}`);
        return send(res, 200, { revoked: who });
      }
      case 'backup': {
        // a gzip tar of DATA_DIR (server key and secrets included): moving the server, offsite copies
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        if (!this.backups.allow(wallet.toLowerCase())) throw new SiteFail(429, 'rate_limited', 'Too many backups in the last hour. Try again later.');
        await this.secretGate(req, wallet, 'backup');
        return streamBackup(req, res, wallet, { dataDir: this.ext.dataDir ?? null, chainId: this.chainId(), flush: () => this.flushAll?.(), log: this.ext.log });
      }
      case 'migration-env': {
        // the server's own settings (secrets included) for the one-command move to a new server
        // (deploy/vps/install.sh --from): admin-only, rate-limited like the backup, never logged
        if (seg.length !== 1) break;
        this.method(req, 'GET');
        if (!this.backups.allow(wallet.toLowerCase())) throw new SiteFail(429, 'rate_limited', 'Too many backups in the last hour. Try again later.');
        await this.secretGate(req, wallet, 'migration-env');
        this.ext.log?.(`backup: settings for a server move (secrets included) handed to ${wallet}${ip ? ` at ${ip}` : ''}`);
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, { env: migrationEnv(process.env), directUrl: null });
      }
      case 'counts':
        this.method(req, 'GET');
        return send(res, 200, s.counts());
      case 'feedback': {
        // players' messages from the game page, newest first: GET the list (`?limit`, `?offset`, `?unread=1`), PUT
        // `<id> {read}` marks one, POST `read-all` marks every one, DELETE `<id>` removes one
        const fb = this.feedback;
        if (seg.length === 1) {
          this.method(req, 'GET');
          return send(res, 200, fb.list({ limit: Number(q.get('limit') ?? 100), offset: Number(q.get('offset') ?? 0), unread: q.get('unread') === '1' }));
        }
        if (seg.length !== 2) break;
        if (seg[1] === 'read-all') {
          this.method(req, 'POST');
          fb.readAll();
          return send(res, 200, { unread: fb.unread() });
        }
        if (this.method(req, 'PUT', 'DELETE') === 'DELETE') {
          fb.remove(seg[1]);
          return send(res, 200, { unread: fb.unread() });
        }
        const read = (await readJson(req)).read;
        if (typeof read !== 'boolean') throw new SiteFail(400, 'bad_request', 'read must be true or false', 'read');
        return send(res, 200, { entry: fb.setRead(seg[1], read), unread: fb.unread() });
      }
      case 'leaderboards': {
        // the daily and all-time boards: what they hold, and a reset (profiles, XP and levels are not touched)
        const lb = this.ext.leaderboards;
        if (!lb) break;
        if (seg.length === 1) {
          this.method(req, 'GET');
          return send(res, 200, { info: lb.info() });
        }
        if (seg.length === 2 && seg[1] === 'reset') {
          this.method(req, 'POST');
          const body = await readJson(req);
          if (body.confirm !== 'RESET') throw new SiteFail(400, 'bad_request', 'Send {"confirm":"RESET"} to clear both leaderboards.', 'confirm');
          const cleared = lb.reset(wallet!);
          this.ext.log?.(`leaderboards: reset by ${wallet} (${cleared.daily} daily and ${cleared.allTime} all-time records cleared${cleared.backup ? `, backup ${cleared.backup}` : ''})`);
          return send(res, 200, { cleared: { daily: cleared.daily, allTime: cleared.allTime }, backedUp: cleared.backup !== null, info: lb.info() });
        }
        break;
      }
      case 'avatars': {
        // moderation of profile pictures: the list, newest first, and removal (the coin falls back to its basic skin)
        const profiles = this.ext.profiles;
        if (!profiles || !this.ext.avatars) break;
        if (seg.length === 1) {
          this.method(req, 'GET');
          return send(res, 200, profiles.avatars(Number(q.get('limit') ?? 200) || 200));
        }
        if (seg.length !== 2) break;
        this.method(req, 'DELETE');
        const target = checksumAddress(seg[1]);
        if (!target) throw new SiteFail(400, 'bad_request', 'Not a wallet address', 'wallet');
        const removed = this.dropAvatar(target, true);
        if (!removed) throw new SiteFail(404, 'not_found', 'This wallet has no picture');
        this.ext.log?.(`avatars: ${wallet} removed the picture ${removed} of ${target}`);
        return send(res, 200, { removed });
      }
      case 'integrity':
        if (!this.integrity) break;
        return integrityRoutes(
          this.integrity,
          { send, sendCsv, method: (r, ...m) => this.method(r, ...m), readJson: (r) => readJson(r) },
          req,
          res,
          seg.slice(1),
          q,
          wallet,
        );
      case 'custom-rooms':
        if (seg.length > 2 || !this.customRooms) break;
        return customRoomAdminRoutes(this.customRooms, { send, method: (r, ...m) => this.method(r, ...m), readJson: (r) => readJson(r) }, req, res, seg.slice(1), wallet);
      case 'arena-scaling': {
        // the arena instance scaler: its settings (thresholds, min / max instances), every arena's instances, its decisions
        const scaler = this.scaler;
        if (seg.length !== 1 || !scaler) break;
        if (this.method(req, 'GET', 'PUT') === 'PUT') {
          try {
            scaler.store.update(await readJson(req));
          } catch (err) {
            if (err instanceof ArenaScalingFail) throw new SiteFail(400, 'bad_request', err.message, err.field);
            throw err;
          }
          this.ext.log?.(`arena scaling: settings updated by ${wallet}`);
        }
        return send(res, 200, scaler.view());
      }
      case 'test-arenas': {
        // "Test arenas with bots" (testnet only): the switch, the bots per arena, the difficulty, every test arena now
        const tests = this.testArenas;
        if (seg.length !== 1 || !tests) break;
        if (this.method(req, 'GET', 'PUT') === 'PUT') {
          try {
            tests.testArenas.update(await readJson(req));
          } catch (err) {
            // the mainnet refuses the setting (409); a bad value is a 400
            if (err instanceof TestArenaFail) throw new SiteFail(tests.testArenas.available ? 400 : 409, tests.testArenas.available ? 'bad_request' : 'wrong_state', err.message, err.field);
            throw err;
          }
          this.ext.log?.(`test arenas: settings updated by ${wallet}: ${JSON.stringify(tests.testArenas.settings)}`);
        }
        return send(res, 200, tests.testArenaView());
      }
      case 'arena-prices': {
        // arena tiers in US dollars: the price source, the manual token price, the tiers, the rounding. The sync's
        // `updateArena` calls are built and signed in the admin's browser with the owner wallet, never here
        const store = this.arenaPrices;
        if (seg.length !== 1 || !store) break;
        if (this.method(req, 'GET', 'PUT') === 'PUT') {
          try {
            store.update(await readJson(req));
          } catch (err) {
            if (err instanceof ArenaPricingFail) throw new SiteFail(400, 'bad_request', err.message, err.field);
            throw err;
          }
          const st = store.settings;
          const tiers = st.tiers.map((t) => `#${t.arenaId} ${formatUsdCents(t.usdCents)}${t.holdersOnly ? ' holders' : ''}`).join(', ');
          this.ext.log?.(`arena prices: settings updated by ${wallet} (source ${st.source}, ${st.manualUsdPerToken ?? 'no'} USD per token, tiers ${tiers}, ${st.sigFigs} figures)`);
        }
        return send(res, 200, { settings: store.settings, defaults: ARENA_PRICING_DEFAULT, price: await store.priceView() });
      }
      case 'maps':
        if (seg.length !== 1 || !this.maps) break;
        return mapRoutes(this.maps, { send, method: (r, ...m) => this.method(r, ...m), readJson: (r) => readJson(r) }, req, res, wallet);
      case 'shop': {
        // power-up prices, on/off per power-up and the arena limits (every pack is paid with CoinnibalArena.pay: half
        // burned, half to the fee wallet); plus recent purchases
        const shop = this.shop;
        if (!shop) break;
        // POST /api/admin/shop/refunds/<tx>: the owner sent back the part of a cart payment that could not be applied
        if (seg.length === 3 && seg[1] === 'refunds') {
          this.method(req, 'POST');
          if (!shop.inventory.markRefunded(decodeURIComponent(seg[2]))) throw new SiteFail(404, 'not_found', 'No refund owed for that transaction.');
          this.ext.log?.(`shop: refund of ${seg[2]} marked as sent by ${wallet}`);
          return send(res, 200, { refundsOwed: shop.inventory.refundsOwed() });
        }
        if (seg.length !== 1) break;
        if (this.method(req, 'GET', 'PUT') === 'PUT') {
          try {
            shop.settings.update(await readJson(req));
          } catch (err) {
            if (err instanceof ShopSettingsError) throw new SiteFail(400, 'bad_request', err.message, err.field);
            throw err;
          }
          this.ext.log?.(`shop: settings updated by ${wallet}`);
        }
        return send(res, 200, {
          settings: shop.settings.settings,
          defaults: shop.settings.defaults,
          payTo: shop.service.payTo(),
          burnBps: this.ext.chain?.status().fees?.paymentBurnBps ?? null,
          purchases: shop.inventory.recent(Number(q.get('limit') ?? 30) || 30),
          purchaseCount: shop.inventory.purchaseCount,
          refundsOwed: shop.inventory.refundsOwed(),
        });
      }
      case 'settings':
        if (seg.length !== 1) break;
        if (this.method(req, 'GET', 'PUT') === 'PUT') s.updateSettings(await readJson(req));
        return send(res, 200, { settings: s.settings, gameAccessEnv: this.cfg.gameAccess });
      case 'tasks': {
        if (seg.length === 1) {
          if (this.method(req, 'GET', 'POST') === 'GET') return send(res, 200, { tasks: s.tasks });
          return send(res, 201, { task: s.createTask(await readJson(req)) });
        }
        if (seg.length !== 2) break;
        if (seg[1] === 'order') {
          this.method(req, 'PUT');
          return send(res, 200, { tasks: s.reorderTasks((await readJson(req)).ids) });
        }
        if (this.method(req, 'PUT', 'DELETE') === 'PUT') return send(res, 200, { task: s.updateTask(seg[1], await readJson(req)) });
        s.deleteTask(seg[1]);
        return send(res, 200, { ok: true });
      }
      case 'wl.csv': {
        this.method(req, 'GET');
        const scope = q.get('scope') === 'all' ? 'all' : 'approved';
        return sendCsv(res, `coinnibal-wl-${scope}-${day}.csv`, s.wlCsv(scope));
      }
      case 'wl': {
        if (seg.length === 1) {
          this.method(req, 'GET');
          const page = Number(q.get('page') ?? 1);
          const pageSize = Number(q.get('pageSize') ?? 50);
          return send(res, 200, s.listWl({ status: q.get('status'), q: q.get('q'), page, pageSize }));
        }
        if (seg.length === 2 && seg[1] === 'status') {
          this.method(req, 'POST');
          const body = await readJson(req);
          return send(res, 200, { updated: s.setWlStatus(body.ids, body.status) });
        }
        if (seg.length === 2) {
          this.method(req, 'GET');
          return send(res, 200, { entry: s.getWl(seg[1]) });
        }
        if (seg.length === 3 && seg[2] === 'status') {
          this.method(req, 'PUT');
          s.getWl(seg[1]); // 404 before validating the body
          s.setWlStatus([seg[1]], (await readJson(req)).status);
          return send(res, 200, { entry: s.getWl(seg[1]) });
        }
        if (seg.length === 3 && seg[2] === 'note') {
          this.method(req, 'PUT');
          return send(res, 200, { entry: s.setWlNote(seg[1], (await readJson(req)).note) });
        }
        break;
      }
      case 'collabs': {
        if (seg.length === 1) {
          this.method(req, 'GET');
          return send(res, 200, { items: s.listCollabs({ status: q.get('status'), q: q.get('q') }) });
        }
        if (seg.length === 2 && seg[1] === 'wallets.csv') {
          this.method(req, 'GET');
          return sendCsv(res, `coinnibal-collab-wallets-${day}.csv`, s.allCollabsCsv());
        }
        const id = seg[1];
        if (seg.length === 2) {
          this.method(req, 'GET');
          return send(res, 200, { collab: s.getCollab(id) });
        }
        if (seg.length !== 3) break;
        switch (seg[2]) {
          case 'wallets.csv':
            this.method(req, 'GET');
            return sendCsv(res, `coinnibal-collab-${id}-${day}.csv`, s.collabCsv(id));
          case 'approve':
            this.method(req, 'POST');
            return send(res, 200, { collab: s.approveCollab(id, await readJson(req)) });
          case 'reject':
            this.method(req, 'POST');
            return send(res, 200, { collab: s.rejectCollab(id) });
          case 'extend':
            this.method(req, 'POST');
            return send(res, 200, { collab: s.extendCollab(id, await readJson(req)) });
          case 'unlock':
            this.method(req, 'POST');
            return send(res, 200, { collab: s.unlockCollab(id) });
          case 'note':
            this.method(req, 'PUT');
            return send(res, 200, { collab: s.setCollabNote(id, (await readJson(req)).note) });
        }
        break;
      }
    }
    throw new SiteFail(404, 'not_found', 'Not found');
  }
}
