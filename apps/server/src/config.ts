import { availableParallelism } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CAPACITY, NETWORKS, RULES, ROBINHOOD_CHAIN_ID, TOKEN_SYMBOL_DEFAULT, MINT_USD_CENTS_DEFAULT, configuredChainId, unsupportedChainMessage, isGameAccess, normalizeXHandle, SITE_URL_DEFAULT, withBrandOrigins, NFT_SUPPLY, type GameAccess } from '@coinnibal/shared';
import { GAS_PRICE_URL_DEFAULT } from '@coinnibal/sdk';
import { getAddress, isAddress } from 'viem';
import { DEFAULT_ART_STYLE, parseArtStyle, type ArtStyle } from './site/nft/render';

export interface ServerConfig {
  port: number;
  host: string;
  /** Allowed CORS origin for REST ("*" by default). */
  corsOrigin: string;
  dataDir: string;
  /**
   * Public base URL of this server (`PUBLIC_URL`, no trailing slash), the origin wallet logins
   * (SIWE) are bound to and the base of the NFT metadata links. Required unless `NODE_ENV=development`
   * (`assertPublicUrl`); null (development only): the request's Host header, else `http://localhost:<PORT>`.
   */
  publicUrl: string | null;
  /** Optional path to the built web app (apps/web/dist) to serve statically. */
  webDist: string | null;
  maxConnectionsPerIp: number;
  /** WebSockets per IPv4 /24 or IPv6 /64 (`MAX_CONNECTIONS_PER_SUBNET`, default 48). */
  maxConnectionsPerSubnet: number;
  maxConnections: number;
  /**
   * Graceful degradation (`LOAD_SHED`; default on with `NODE_ENV=production`): new free games, then new sockets and
   * new arena seats are refused while the server is overloaded, so live rooms keep their tick budget.
   */
  loadShed: boolean;
  /** A WebSocket that sends no valid `hello` within this is closed (`WS_HELLO_TIMEOUT_MS`, default 10 000). */
  wsHelloTimeoutMs: number;
  /** Humans per practice room (`PRACTICE_CAPACITY`). */
  practiceCapacity: number;
  privateRoomCapacity: number;
  /** Humans per arena instance before another instance opens (`ARENA_INSTANCE_CAP`). */
  arenaInstanceCap: number;
  /**
   * Room worker threads (`GAME_WORKERS`): rooms (simulation, bots, snapshots) run in this many
   * `worker_threads`, the main thread keeps HTTP, sockets, the chain and the journal. 0: every room
   * runs on the main thread (today's single-thread mode). Default: `availableParallelism() - 1` (at
   * least 1) with `NODE_ENV=production`, else 0 (tests, `pnpm dev`).
   */
  gameWorkers: number;
  /** A room worker silent this long is stopped and its rooms recovered (`GAME_WORKER_HANG_S`, default 10). */
  gameWorkerHangMs: number;
  /**
   * Arena round clock (`ROUND_SECONDS` = the play, `ROUND_JOIN_CLOSE_SECONDS`, `ROUND_BREAK_SECONDS` = the break
   * added after each bell; defaults `RULES.roundMs` / `RULES.roundJoinCloseMs` / `RULES.roundBreakMs`). Tests, the
   * localnet e2e and demo recordings shorten it; production uses the defaults. The closed window is at most half the
   * play.
   */
  round: { roundMs: number; closeMs: number; breakMs: number };
  authSecret: Buffer;
  /** `AUTH_SECRET` came from the environment (false: the generated `DATA_DIR/auth-secret`). */
  authSecretFromEnv: boolean;
  /** Lifetime of an admin wallet's session token (`ADMIN_TOKEN_TTL_MIN`, default 120, 5 to 1440). */
  adminTokenTtlMs: number;
  /**
   * `ADMIN_SECRET_EXPORT=1`: `GET /api/admin/backup` and `/api/admin/migration-env` (they hand out the server key)
   * work on the mainnet. Off by default there; on a testnet they work unless `ADMIN_SECRET_EXPORT=0`.
   */
  adminSecretExport: boolean | null;
  /**
   * Admin wallets (`ADMIN_WALLETS`, comma-separated 0x addresses, EIP-55 checksummed here): a SIWE session of
   * one of them may use `/api/admin/*` and always play. No default: unset means nobody is admin (logged loudly).
   */
  adminWallets: string[];
  /**
   * `GAME_ACCESS` (`admins`, `holders`, `public` or `maintenance`): overrides the admin's `gameAccess` setting.
   * Null: the site setting decides (default `admins`).
   */
  gameAccess: GameAccess | null;
  /**
   * `X_HANDLE`: the project's X handle by default (no `@`; e.g. `coinnibal` once that account is live). Null: the
   * shared default (`SITE_X_HANDLE_DEFAULT`). The admin's Settings, X handle, overrides it once saved; a saved handle
   * that is an earlier default (`PREVIOUS_X_HANDLES`) moves to this one on start.
   */
  xHandle: string | null;
  /** `NODE_ENV` as given (null when unset). */
  nodeEnv: string | null;
  /**
   * `DEV_FAKE_CHAIN=1`: an in-memory chain with auto-issued arena tickets and
   * simulated settlements, for local UI work and Playwright. Only allowed with
   * `NODE_ENV=development` and no real chain configured (see `createChain`).
   */
  devFakeChain: boolean;
  /**
   * `DEV_FAKE_TOKEN=1`: the fake chain starts with its game token set (arenas open at once).
   * Without it the token starts unset (practice only, "Opening soon") and the dev-only
   * `POST /api/dev/token` sets it, to show the transition.
   */
  devFakeToken: boolean;
  chain: {
    /**
     * The Robinhood Chain network this deployment runs on (`CHAIN_ID`: 46630 testnet, the default, or 4663 mainnet;
     * 31337 for a local development node). The RPC must serve exactly this id: otherwise arenas
     * stay off (`EvmChain` compares `eth_chainId` with it).
     */
    chainId: number;
    /** `CHAIN_ID` was set explicitly (the RPC is held to it); false: the RPC's own id is used. */
    chainIdExplicit: boolean;
    /** Server RPC (`EVM_RPC_URL`, may hold an API key): the first of `rpcUrls`. Null: chain off, practice only. */
    rpcUrl: string | null;
    /**
     * Every server RPC in order of preference (`EVM_RPC_URLS`, a comma list, e.g. an Alchemy URL then the public RPC;
     * else `EVM_RPC_URL` alone). Reads and sends go through a viem fallback over them, each URL with its own budget.
     */
    rpcUrls: string[];
    /** `RPC_MAX_RPS` per entry of `rpcUrls` (a comma list; one number applies to every URL). */
    rpcMaxRpsPerUrl: number[];
    /**
     * RPC handed to browsers (`PUBLIC_RPC_URL`, no secrets). Default: `EVM_RPC_URL` when it is Robinhood Chain's
     * public RPC, else null (the wallet's own RPC is used).
     */
    publicRpcUrl: string | null;
    /** Blockscout explorer (`EXPLORER_URL`), overrides the network's. */
    explorerUrl: string | null;
    /** The gas faucet the `/faucet` page links to (`GAS_FAUCET_URL`), overrides the testnet's. */
    gasFaucetUrl: string | null;
    /** `ARENA_ADDRESS`: overrides the registry's arena (normally written by the admin panel after a deploy). */
    arenaAddress: string | null;
    /** `NFT_ADDRESS`: overrides the registry's NFT. */
    nftAddress: string | null;
    /** `TOKEN_ADDRESS`: overrides the registry's game token entry (the TestToken on testnet: its faucet). */
    tokenAddress: string | null;
    /** `SERVER_PRIVATE_KEY`: `auto` (generated once into `DATA_DIR/server-key.json`), a 0x hex key, or a path to a file holding one. */
    serverKey: string | null;
    stakeEnabled: boolean;
    /**
     * `JOURNAL_ABANDON_CONTRACT` (testnet escape hatch): the old arena whose unsent journal records are set aside
     * (copied to a backup file, then cleared) so a newly registered arena can open. Never set it on mainnet.
     */
    journalAbandonContract: string | null;
    /** Arena ids to open as stake rooms (empty = discover on-chain). */
    arenaIds: number[];
    /** Display symbol of the game token (`TOKEN_SYMBOL`, default `tokens`; the on-chain symbol is not used for display). */
    tokenSymbol: string;
    /**
     * Seconds after which an open session nobody plays is settled at its entry fee by the sweeper
     * (`STALE_SESSION_AFTER_S`, default 900). The sweeper runs every 5 minutes, or this often
     * when it is shorter (the localnet e2e uses 5 s to reach the refund path quickly).
     */
    staleSessionAfterS: number;
    /**
     * `STALE_SWEEP_ACK=1`: the operator reviewed a quarantined journal (`journal.json.corrupt-*`)
     * and allows the stale-session sweeper to run again. Without it the sweeper stays off
     * after a quarantine, so it cannot refund sessions whose real result was in the lost journal.
     */
    staleSweepAck: boolean;
    /**
     * `LOG_CHUNK_BLOCKS`: blocks per `eth_getLogs` request of the session and holder indexes to start
     * with (default 50,000; adaptive: doubled after a full-width success up to 500,000, halved when the
     * RPC refuses a range).
     */
    logChunkBlocks: number;
    /**
     * `RPC_MAX_RPS` / `RPC_BURST`: the server's own request budget on the RPC (calls per second and burst,
     * defaults 4 and 8). Public RPCs answer 429 above their limit; every call of the process
     * (settlements, joins, mint page, indexes) shares this budget, by priority.
     */
    rpcMaxRps: number;
    rpcBurst: number;
    /**
     * `TESTNET_RPC_URL`: the RPC of the testnet whose emblem holders are imported into the mainnet allowlist
     * (`POST /api/admin/mint/import-holders`). Default: the Robinhood Chain Testnet public RPC.
     */
    testnetRpcUrl: string;
    /**
     * `PAYOUT_GUARD_MULTIPLE` (default 100; 0 turns it off): a settlement paying a ticket more than this many entry
     * fees is held for an admin decision instead of being sent (limits what a bug or a tampered journal can pay).
     */
    payoutGuardMultiple: number;
    /**
     * `DEATH_SETTLE_BATCH_S` (default 6, 0 to 30; 0 sends each at once): an eaten ticket's settlement (payout 0) waits up
     * to this long so the deaths of a few seconds go out in one `settle` batch instead of one transaction each. A bell,
     * a cash-out or any item with a payout in the same arena takes the waiting deaths along at once.
     */
    deathBatchMs: number;
    /**
     * `GAS_FLOOR_ETH` (default 0.002): the server key's balance below which it is low whatever its spend; above it the
     * runway decides (trailing spend: under `GAS_RUNWAY_WARN_DAYS` 7 a warning, under `GAS_RUNWAY_CRITICAL_DAYS` 2 an alert).
     */
    gasFloorWei: bigint;
    gasRunwayWarnDays: number;
    gasRunwayCriticalDays: number;
  };
  /**
   * NFT mint: the USD target (`MINT_USD_CENTS`, default 100) and the ETH/USD feed (`GAS_PRICE_URL`).
   */
  mint: { usdCents: number; gasPriceUrl: string };
  /**
   * The emblem collection (docs/NFT-DESIGN.md): `NFT_COLLECTION_SIZE` (default `NFT_SUPPLY`, 3,333: the contract's max supply),
   * `NFT_COLLECTION_SEED` (default: 32 random bytes, generated once and committed to the chain's state directory),
   * `NFT_ART_STYLE` (`vector`, the default, or `pixel`).
   */
  nft: { size: number; seed: string | null; style: ArtStyle };
  /** `/api/health` thresholds: `HEALTH_MAX_PENDING` (400) due settlements, `HEALTH_MAX_PENDING_AGE_S` (900) for the oldest. */
  health?: { maxPending: number; maxPendingAgeS: number };
}

/**
 * `ADMIN_WALLETS`: comma-separated 0x addresses (any case), returned EIP-55 checksummed and de-duplicated;
 * malformed entries are dropped. There is no default: an empty list means nobody is admin.
 */
export function parseAdminWallets(v: string | undefined): string[] {
  const out = new Set<string>();
  for (const raw of (v ?? '').split(',')) {
    const s = raw.trim();
    if (isAddress(s, { strict: false })) out.add(getAddress(s));
  }
  return [...out];
}

/** Malformed entries of `ADMIN_WALLETS` (for the startup warning). */
/**
 * Refuses to start without a usable `PUBLIC_URL` unless `NODE_ENV=development`: it is the origin SIWE
 * logins are bound to and the base of the NFT metadata links, and a request-derived one (Host /
 * X-Forwarded-Host) would let any site that proxies to this server obtain real sessions. Throws a clear message.
 */
export function assertPublicUrl(cfg: Pick<ServerConfig, 'publicUrl' | 'nodeEnv'>): void {
  if (cfg.publicUrl) {
    let ok = false;
    try {
      const u = new URL(cfg.publicUrl);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && u.host !== '' && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && !u.username;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`PUBLIC_URL must be the site's origin, e.g. ${SITE_URL_DEFAULT} (got ${JSON.stringify(cfg.publicUrl)}); refusing to start`);
    return;
  }
  if (cfg.nodeEnv === 'development') return;
  throw new Error(
    `PUBLIC_URL is required (NODE_ENV is ${cfg.nodeEnv ?? 'unset'}): set it to the site's public origin, e.g. ${SITE_URL_DEFAULT}. ` +
      'It is the domain wallet sign-ins (SIWE) are bound to and the base of the NFT metadata links; only NODE_ENV=development may derive it from the request. Refusing to start',
  );
}

/** The least `AUTH_SECRET` may hold (bytes): it signs every session token, so it must not be guessable. */
export const AUTH_SECRET_MIN_BYTES = 32;

/**
 * A weak `AUTH_SECRET` (under `AUTH_SECRET_MIN_BYTES` bytes) lets anyone who guesses it forge an admin session
 * offline. On the mainnet (`CHAIN_ID=4663`) the server refuses to start with one; elsewhere it returns the
 * warning to log (null: fine). The generated `DATA_DIR/auth-secret` (64 hex characters) always passes.
 */
export function checkAuthSecret(cfg: Pick<ServerConfig, 'authSecret' | 'authSecretFromEnv' | 'chain'>): string | null {
  if (!cfg.authSecretFromEnv || cfg.authSecret.length >= AUTH_SECRET_MIN_BYTES) return null;
  const msg = `AUTH_SECRET is ${cfg.authSecret.length} byte(s): it must be at least ${AUTH_SECRET_MIN_BYTES} (e.g. openssl rand -hex 32), or unset to use a generated one`;
  if (cfg.chain.chainId === ROBINHOOD_CHAIN_ID) throw new Error(`${msg}; refusing to start on the mainnet`);
  return `!!! ${msg} (a mainnet server refuses to start with it)`;
}

export function invalidAdminWallets(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isAddress(s, { strict: false }));
}

/** `GAME_ACCESS`: `admins`, `holders`, `public` or `maintenance`; anything else (or unset) is null (the site setting decides). */
export function parseGameAccess(v: string | undefined): GameAccess | null {
  const s = v?.trim().toLowerCase();
  return isGameAccess(s) ? s : null;
}

/** `PUBLIC_RPC_URL`, else `EVM_RPC_URL` when it is a Robinhood Chain public RPC (no secrets in it), else null. */
export function defaultPublicRpc(rpcUrl: string | null, publicRpcUrl: string | undefined): string | null {
  const explicit = publicRpcUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const url = rpcUrl?.replace(/\/+$/, '');
  const known = Object.values(NETWORKS).find((c) => c.rpcUrl === url && !/127\.0\.0\.1|localhost/.test(c.rpcUrl));
  return known?.rpcUrl ?? null;
}

/** `PAYOUT_GUARD_MULTIPLE` default: twice a full 50-seat arena instance of entry fees for one ticket. */
export const PAYOUT_GUARD_MULTIPLE_DEFAULT = 100;

const blank = (v: string | undefined): string | null => (v?.trim() ? v.trim() : null);

/** `CHAIN_ID`: 46630 (Robinhood Chain Testnet, the default), 4663 (Robinhood Chain) or 31337 (a local node). Anything else refuses to start. */
export function chainIdOf(raw: string | undefined): number {
  if (blank(raw) === null) return configuredChainId(undefined);
  const id = configuredChainId(raw, -1);
  if (id === -1) throw new Error(`CHAIN_ID: ${unsupportedChainMessage(raw?.trim())}`);
  return id;
}

const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : d;
};

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? n : d;
};

/**
 * `ROUND_SECONDS` / `ROUND_JOIN_CLOSE_SECONDS` / `ROUND_BREAK_SECONDS`: whole seconds. `ROUND_SECONDS` is the full
 * play of a round (at least 2 s); joins close at most half of it before the bell; the break after each bell comes on
 * top of the play (one cycle on the wall clock is play + break). An explicit break is kept up to the play length;
 * left unset it is the default 30 s, at most a tenth of the play (so short test rounds get a short break).
 */
export function parseRoundConfig(env: NodeJS.ProcessEnv): { roundMs: number; closeMs: number; breakMs: number } {
  const roundS = Math.floor(num(env.ROUND_SECONDS, RULES.roundMs / 1000));
  const roundMs = Math.max(2, roundS) * 1000;
  const closeS = Math.floor(num(env.ROUND_JOIN_CLOSE_SECONDS, RULES.roundJoinCloseMs / 1000));
  const closeMs = Math.min(Math.max(0, closeS) * 1000, Math.floor(roundMs / 2000) * 1000);
  const breakSet = num(env.ROUND_BREAK_SECONDS, NaN);
  const breakMs = Number.isNaN(breakSet)
    ? Math.min(RULES.roundBreakMs, Math.floor(roundMs / 10_000) * 1000)
    : Math.min(Math.max(0, Math.floor(breakSet)) * 1000, roundMs);
  return { roundMs, closeMs, breakMs };
}

/** A decimal ETH amount ("0.002") in wei; `d` when unset or malformed. */
function ethToWei(v: string | undefined, d: bigint): bigint {
  const m = /^\s*(\d{1,6})(?:\.(\d{1,18}))?\s*$/.exec(v ?? '');
  if (!m) return d;
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0'));
}

const bool = (v: string | undefined, d: boolean): boolean => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

/**
 * Without `AUTH_SECRET`, sign-ins would reset on every restart (and a deploy restarts the server):
 * keep a generated secret in `DATA_DIR/auth-secret` (mode 0600) so sessions survive restarts.
 * Falls back to a one-run secret when the data dir is not writable.
 */
export function persistedAuthSecret(dataDir: string): Buffer {
  const file = join(dataDir, 'auth-secret');
  try {
    const hex = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'utf8');
  } catch {
    /* not there yet */
  }
  const hex = randomBytes(32).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, hex + '\n', { mode: 0o600, flag: 'wx' });
    return Buffer.from(hex, 'utf8');
  } catch {
    try {
      const again = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(again)) return Buffer.from(again, 'utf8');
    } catch {
      /* unwritable data dir */
    }
    return Buffer.from(hex, 'utf8');
  }
}

/** `GAME_WORKERS`: a whole number (at most 64); unset: one per core but one in production, 0 elsewhere. */
export function gameWorkers(env: NodeJS.ProcessEnv): number {
  const raw = env.GAME_WORKERS?.trim();
  if (raw) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0) return Math.min(64, n);
  }
  return env.NODE_ENV === 'production' ? Math.max(1, availableParallelism() - 1) : 0;
}

/**
 * `EVM_RPC_URLS` (comma-separated, in order of preference), else `EVM_RPC_URL`: trailing slashes dropped, duplicates
 * and blanks removed.
 */
export function parseRpcUrls(list: string | undefined, single: string | undefined): string[] {
  const raw = blank(list) !== null ? list!.split(',') : [single ?? ''];
  const out: string[] = [];
  for (const r of raw) {
    const u = r.trim().replace(/\/+$/, '');
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** `RPC_MAX_RPS`: one rate for every URL, or a comma list (one per URL, the last one repeated); default 4 a second. */
export function parseRpcRates(v: string | undefined, n: number): number[] {
  const parts = (v ?? '').split(',').map((s) => Number(s.trim()));
  const ok = parts.map((x) => (Number.isFinite(x) && x > 0 ? Math.max(0.2, x) : null));
  const out: number[] = [];
  for (let i = 0; i < Math.max(1, n); i++) out.push(ok[Math.min(i, ok.length - 1)] ?? ok.find((x) => x !== null) ?? 4);
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rpcUrls = parseRpcUrls(env.EVM_RPC_URLS, env.EVM_RPC_URL);
  const rpcUrl = rpcUrls[0] ?? null;
  const rates = parseRpcRates(env.RPC_MAX_RPS, rpcUrls.length);
  const secret = env.AUTH_SECRET ? Buffer.from(env.AUTH_SECRET, 'utf8') : persistedAuthSecret(resolve(env.DATA_DIR ?? 'data'));
  return {
    port: int(env.PORT, 8787),
    host: env.HOST ?? '0.0.0.0',
    corsOrigin: withBrandOrigins(env.CORS_ORIGIN),
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    publicUrl: env.PUBLIC_URL?.trim() ? env.PUBLIC_URL.trim().replace(/\/+$/, '') : null,
    webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : null,
    maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 8),
    maxConnectionsPerSubnet: Math.max(1, int(env.MAX_CONNECTIONS_PER_SUBNET, 48)),
    loadShed: bool(env.LOAD_SHED, env.NODE_ENV === 'production'),
    wsHelloTimeoutMs: Math.max(200, int(env.WS_HELLO_TIMEOUT_MS, 10_000)),
    maxConnections: int(env.MAX_CONNECTIONS, 1500),
    practiceCapacity: Math.max(1, int(env.PRACTICE_CAPACITY ?? env.FREE_ROOM_CAPACITY, CAPACITY.practice)),
    privateRoomCapacity: int(env.PRIVATE_ROOM_CAPACITY, CAPACITY.private),
    arenaInstanceCap: Math.max(1, int(env.ARENA_INSTANCE_CAP, CAPACITY.arena)),
    gameWorkers: gameWorkers(env),
    gameWorkerHangMs: Math.max(2, int(env.GAME_WORKER_HANG_S, 10)) * 1000,
    round: parseRoundConfig(env),
    authSecret: secret,
    authSecretFromEnv: !!env.AUTH_SECRET,
    adminTokenTtlMs: Math.min(1440, Math.max(5, int(env.ADMIN_TOKEN_TTL_MIN, 120))) * 60_000,
    adminSecretExport: env.ADMIN_SECRET_EXPORT === undefined || env.ADMIN_SECRET_EXPORT.trim() === '' ? null : bool(env.ADMIN_SECRET_EXPORT, false),
    adminWallets: parseAdminWallets(env.ADMIN_WALLETS),
    gameAccess: parseGameAccess(env.GAME_ACCESS),
    xHandle: normalizeXHandle(env.X_HANDLE),
    nodeEnv: env.NODE_ENV?.trim() || null,
    devFakeChain: bool(env.DEV_FAKE_CHAIN, false),
    devFakeToken: bool(env.DEV_FAKE_TOKEN, false),
    chain: {
      rpcUrl,
      rpcUrls,
      rpcMaxRpsPerUrl: rates,
      publicRpcUrl: defaultPublicRpc(rpcUrls.find((u) => defaultPublicRpc(u, undefined) !== null) ?? rpcUrl, env.PUBLIC_RPC_URL),
      chainId: chainIdOf(env.CHAIN_ID),
      chainIdExplicit: blank(env.CHAIN_ID) !== null,
      explorerUrl: blank(env.EXPLORER_URL)?.replace(/\/+$/, '') ?? null,
      gasFaucetUrl: blank(env.GAS_FAUCET_URL),
      arenaAddress: blank(env.ARENA_ADDRESS),
      nftAddress: blank(env.NFT_ADDRESS),
      tokenAddress: blank(env.TOKEN_ADDRESS),
      serverKey: blank(env.SERVER_PRIVATE_KEY),
      stakeEnabled: bool(env.STAKE_ENABLED, true),
      journalAbandonContract: blank(env.JOURNAL_ABANDON_CONTRACT),
      arenaIds: (env.STAKE_ARENA_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535),
      tokenSymbol: env.TOKEN_SYMBOL?.trim() || TOKEN_SYMBOL_DEFAULT,
      staleSessionAfterS: Math.max(1, int(env.STALE_SESSION_AFTER_S, 15 * 60)),
      staleSweepAck: bool(env.STALE_SWEEP_ACK, false),
      logChunkBlocks: Math.max(100, int(env.LOG_CHUNK_BLOCKS, 50_000)),
      rpcMaxRps: rates[0],
      rpcBurst: Math.max(1, int(env.RPC_BURST, 8)),
      testnetRpcUrl: blank(env.TESTNET_RPC_URL)?.replace(/\/+$/, '') ?? NETWORKS.testnet.rpcUrl,
      payoutGuardMultiple: Math.max(0, int(env.PAYOUT_GUARD_MULTIPLE, PAYOUT_GUARD_MULTIPLE_DEFAULT)),
      deathBatchMs: Math.min(30, Math.max(0, num(env.DEATH_SETTLE_BATCH_S, 6))) * 1000,
      gasFloorWei: ethToWei(env.GAS_FLOOR_ETH, 2n * 10n ** 15n),
      gasRunwayWarnDays: Math.max(0.1, num(env.GAS_RUNWAY_WARN_DAYS, 7)),
      gasRunwayCriticalDays: Math.max(0.05, num(env.GAS_RUNWAY_CRITICAL_DAYS, 2)),
    },
    mint: {
      usdCents: Math.max(1, int(env.MINT_USD_CENTS, MINT_USD_CENTS_DEFAULT)),
      gasPriceUrl: blank(env.GAS_PRICE_URL) ?? GAS_PRICE_URL_DEFAULT,
    },
    health: {
      maxPending: Math.max(1, int(env.HEALTH_MAX_PENDING, 400)),
      maxPendingAgeS: Math.max(30, int(env.HEALTH_MAX_PENDING_AGE_S, 900)),
    },
    nft: {
      size: Math.max(1, int(env.NFT_COLLECTION_SIZE, NFT_SUPPLY)),
      seed: blank(env.NFT_COLLECTION_SEED),
      style: parseArtStyle(blank(env.NFT_ART_STYLE)) ?? DEFAULT_ART_STYLE,
    },
  };
}
