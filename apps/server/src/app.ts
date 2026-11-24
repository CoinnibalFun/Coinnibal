import { SiteFail } from './site/validate';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { LOCALNET_CHAIN_ID, NETWORKS, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, chainInfo, isTestChainId, setActiveChain, siteHostOf } from '@coinnibal/shared';
import { chainOverridesFor } from './chain/evm';
import type { Hex } from 'viem';
import { Auth } from './auth';
import { assertDevFakeChainAllowed, createChain, dataFileNames } from './chain';
import { PriceKeeper } from './chain/price-keeper';
import { parseSessionKey, type ChainGateway } from './chain/types';
import { checkAuthSecret, type ServerConfig } from './config';
import { createHttpServer, publicBaseUrl, redactUrls } from './http';
import { IntegrityService } from './integrity/service';
import { IntegrityStore } from './integrity/store';
import { integrityDefaults } from './integrity/settings';
import { Leaderboards } from './leaderboards';
import type { Limiter } from './net/limiter';
import { Gateway } from './net/gateway';
import { LoadShedder } from './net/shedder';
import { ArenaScalingStore } from './rooms/arena-scaler';
import { TestArenaStore } from './rooms/test-arenas';
import { MapSettingsStore } from './rooms/map-settings';
import { ShareService } from './site/shares';
import { createCardRenderer } from './site/card-renderer';
import { viemHolderReader, type HolderReader } from './chain/evm-client';
import { configureRpcBudgetFor, configureRpcBudgets, startRpcMinuteLog } from './chain/rpc-budget';
import { loadServerKeySecret } from './chain/server-key';
import { chainDir, isTestChain, migrateLegacyState, resolveStateChainId, stateDir } from './chain/state-dir';
import { HolderWlStore } from './site/holder-wl';
import { FaucetInfo } from './site/network';
import { RoomManager } from './rooms/manager';
import { gameLoad } from './rooms/load';
import { CustomRoomService } from './rooms/custom';
import { UsedPayments } from './chain/payment';
import { checksumAddress } from './auth';
import { ProfileStore } from './profiles';
import { AvatarStore } from './avatars';
import { XLinkService, devFakeXPicture, fakeXFetch, type XFetch } from './xlink';
import { ContractsStore } from './site/contracts';
import { SitePinsStore } from './site/pins';
import { MintService, hyperliquidPrice, type PriceFetcher } from './site/mint';
import { SiteApi, type SiteLimits } from './site/routes';
import { SiteStore } from './site/store';
import { Journal } from './stake/journal';
import { JoinPermits } from './stake/join-permits';
import { BoostInventory } from './shop/inventory';
import { ShopService } from './shop/service';
import { ShopSettingsStore } from './shop/settings';
import { ArenaPriceStore } from './site/arena-prices';
import { EmblemClaims } from './site/emblem-claims';
import { EmblemGate } from './site/emblem-gate';
import { RepriceScheduler } from './site/reprice';
import { NFT_COLLECTION_FILE, NftCollection } from './site/nft/collection';

export interface App {
  server: Server;
  rooms: RoomManager;
  chain: ChainGateway;
  journal: Journal;
  auth: Auth;
  leaderboards: Leaderboards;
  /** The site: settings, WL tasks and entries, collabs, mint, contracts registry, admin API, game gate. */
  site: SiteApi;
  /** Player profiles (names, skins, stats): `DATA_DIR/profiles.json`. */
  profiles: ProfileStore;
  /** The contracts registry of the current chain: `DATA_DIR/chains/<id>/contracts.json` (plus `ARENA_ADDRESS` / `NFT_ADDRESS`). */
  contracts: ContractsStore;
  /** The chain id the chain-keyed state was opened for (`DATA_DIR/chains/<id>/`); null: none (chain off, dev fake chain). */
  stateChainId: number | null;
  /** Imported testnet emblem holders (`DATA_DIR/site/holder-wl.json`). */
  holderWl: HolderWlStore;
  /** The NFT mint: state, the gas token's USD price, holders, allowlist. */
  mint: MintService;
  /** The emblem collection: committed seed, provenance, reveal, metadata and art (`DATA_DIR/chains/<id>/nft-collection.json`). */
  nft: NftCollection;
  /** Keeps the mint at the mint price (MINT_USD_CENTS) in the gas token when the server key is the NFT's price keeper; null without a chain. */
  priceKeeper: PriceKeeper | null;
  /** Cheat and collusion detection: telemetry, flags, bans, auto-hold (`/api/admin/integrity/*`). */
  integrity: IntegrityService;
  /** Paid custom rooms: settings, live rooms, payment checks (`/api/rooms/custom/*`, `/api/admin/custom-rooms`). */
  customRooms: CustomRoomService;
  /** Bought power-ups: prices, purchases (`DATA_DIR/chains/<id>/boosts.json`) and the in-room rules. */
  shop: ShopService;
  /** "Share on X" cards. */
  shares: ShareService;
  /** "Link X": linked X accounts and their pictures (`DATA_DIR/x-links.json`, `DATA_DIR/x-avatars/`). */
  xLinks: XLinkService;
  /** The WebSocket front door (connection limits, abuse counters). */
  gateway: Gateway;
  /** Graceful degradation under load (active with `LOAD_SHED`, default on in production). */
  shedder: LoadShedder;
  /** Arena join permits (`POST /api/arena/permit`, `stake/join-permits.ts`). */
  permits: JoinPermits;
  /** Resolves once the HTTP server is listening; returns the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export async function createApp(
  cfg: ServerConfig,
  opts: {
    chain?: ChainGateway;
    log?: (m: string) => void;
    persist?: boolean;
    /** Wall clock for the arena rounds (Unix ms); tests inject one. Defaults to `Date.now`. */
    now?: () => number;
    /** Wall clock of the site store (collab deadlines); tests inject one. Defaults to `Date.now`. */
    siteNow?: () => number;
    /** Rate limiters of the site API; tests inject small ones. */
    siteLimits?: SiteLimits;
    /** The per-IP limiter of every `/api/*` request; tests inject a larger one. */
    apiLimiter?: Limiter;
    /** ETH/USD feed (default: Hyperliquid at `GAS_PRICE_URL`); tests inject one. */
    fetchPrice?: PriceFetcher;
    /** The chain id to key the state on (default: the injected chain's, else `eth_chainId` of `EVM_RPC_URL`). */
    chainId?: number | null;
    /** Holder readers per chain (default: the server's client on its own chain, `TESTNET_RPC_URL` for the testnet). */
    holderReaderFor?: (chainId: number) => HolderReader | null;
    /** Wall clock of the custom rooms (Unix ms); tests inject one. */
    customNow?: () => number;
    /** "Link X": the fetch that reads X's public endpoints (tests inject a fake X). */
    xFetch?: XFetch;
  } = {},
): Promise<App> {
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${redactUrls(m)}`));
  const persist = opts.persist ?? true;
  // refuse a misconfigured DEV_FAKE_CHAIN before any file is opened
  assertDevFakeChainAllowed(cfg);
  // the secret signs every session token (admin sessions too): a short one can be brute-forced offline from any
  // token. The mainnet refuses to start with one (throws, also below once the RPC told its chain); a testnet logs it
  checkAuthSecret(cfg);
  // one request budget per RPC URL for the whole process (the public RPC answers 429 above its limit)
  configureRpcBudgets({ ratePerSec: cfg.chain.rpcMaxRps, burst: cfg.chain.rpcBurst });
  // EVM_RPC_URLS: each URL its own budget (RPC_MAX_RPS may give one rate per URL: a provider allows far more than a public RPC)
  cfg.chain.rpcUrls.forEach((u, i) => configureRpcBudgetFor(u, { ratePerSec: cfg.chain.rpcMaxRpsPerUrl[i] ?? cfg.chain.rpcMaxRps, burst: cfg.chain.rpcBurst }));
  const stopRpcLog = startRpcMinuteLog(log);
  const files = dataFileNames(cfg);
  // chain-keyed state: DATA_DIR/chains/<chainId>/ (registry, journal, bot wallets, allowlist snapshots)
  let served: number | null = null;
  const resolve = opts.chainId === undefined && !opts.chain;
  const stateChainId = opts.chainId !== undefined ? opts.chainId : opts.chain ? opts.chain.status().chainId : await resolveStateChainId(cfg, { persist, log, served: (id) => (served = id) });
  // the weak-secret refusal also looks at the chain the RPC really serves (CHAIN_ID may be unset): see checkAuthSecret
  const realChain = resolve && !cfg.devFakeChain && !!cfg.chain.rpcUrl && !!cfg.chain.serverKey;
  const weakSecret = checkAuthSecret(cfg, [stateChainId, served], realChain && !cfg.chain.chainIdExplicit && stateChainId === null && served === null);
  if (weakSecret) log(`auth: ${weakSecret}`);
  if (persist && stateChainId !== null) migrateLegacyState(cfg.dataDir, stateChainId, log);
  const chainState = persist ? stateDir(cfg.dataDir, stateChainId) : null;
  if (stateChainId !== null) log(`state: chain ${stateChainId} (${persist ? join(cfg.dataDir, 'chains', String(stateChainId)) : 'in memory'})`);
  const journal = new Journal(chainState ? join(chainState, files.journal) : null, log);
  const recovered = journal.recoverLive();
  if (recovered > 0) log(`journal: ${recovered} stake player(s) were alive at last shutdown → queued automatic payout`);
  if (journal.pending.length > 0) log(`journal: ${journal.pending.length} settlement(s) pending`);

  // a deploy that raises LEADERBOARD_EPOCH starts the boards fresh once (the old file is backed up next to it)
  const leaderboards = new Leaderboards(persist ? join(cfg.dataDir, files.leaderboards) : null, Date.now(), { log });
  if (cfg.adminWallets.length === 0) {
    log('!!! ADMIN_WALLETS is not set: NOBODY is admin (/admin and /api/admin/* refuse everyone). Set it to the owner\'s 0x address.');
  }
  const contracts = new ContractsStore(chainState, { arena: cfg.chain.arenaAddress, nft: cfg.chain.nftAddress, token: cfg.chain.tokenAddress }, log);
  const chain = opts.chain ?? (await createChain(cfg, journal, log, { contracts: () => contracts.view(), stateChainId, cacheDir: chainState }));
  // a newly registered (or cleared) contract is picked up at once, without a restart
  contracts.onChange(() => void chain.refresh?.());
  const adminSet = new Set(cfg.adminWallets.map((w) => w.toLowerCase()));
  const auth = new Auth(cfg.authSecret, {
    onChain: chain.verifyMessage ? (a, m, sig) => chain.verifyMessage!(a, m, sig) : null,
    // garbage aimed at a plain account never reaches the smart-wallet check (`CODE_CHECKS`)
    hasCode: chain.hasCode ? (a) => chain.hasCode!(a) : null,
    // admin sessions are short (ADMIN_TOKEN_TTL_MIN) and can be revoked (POST /api/admin/auth/revoke)
    isAdmin: (w) => adminSet.has(w.toLowerCase()),
    adminTtlMs: cfg.adminTokenTtlMs,
    revocationsFile: persist ? join(cfg.dataDir, 'auth-revoked.json') : null,
    // smart wallets that signed in, per network: their sign-in reserve survives a restart (`SMART_WALLET_RESERVE`)
    smartWalletsFile: persist ? join(cfg.dataDir, 'auth-smart-wallets.json') : null,
    log,
  });
  const profiles = new ProfileStore(persist ? join(cfg.dataDir, files.profiles) : null, log);
  // profile pictures: content-addressed files next to the profiles (DATA_DIR/avatars/<id>.png|webp)
  const avatars = new AvatarStore(persist ? join(cfg.dataDir, cfg.devFakeChain ? 'avatars.dev-fake' : 'avatars') : null, log);
  // a fresh server starts closed (information site): the admin opens the game, mint, WL and collab in /admin
  const siteStore = new SiteStore(persist ? cfg.dataDir : null, {
    now: opts.siteNow,
    log,
    defaults: {
      ...(cfg.xHandle ? { xHandle: cfg.xHandle } : {}),
    },
  });
  const holderWl = new HolderWlStore(persist ? cfg.dataDir : null, log);
  const fetchPrice = opts.fetchPrice ?? hyperliquidPrice(cfg.mint.gasPriceUrl);
  const nftRecord = () => {
    const r = contracts.effective(null).nft;
    return r ? { address: r.address, txHash: r.txHash } : null;
  };
  const mint = new MintService({
    store: siteStore,
    client: () => chain.evm?.() ?? null,
    nft: nftRecord,
    chainId: () => chain.status().chainId,
    stateDir: chainState,
    holderWl: () => holderWl.wallets(),
    usdCents: cfg.mint.usdCents,
    fetchPrice,
    logChunkBlocks: cfg.chain.logChunkBlocks,
    rpcMaxRps: cfg.chain.rpcMaxRps,
    log,
  });
  // the testnet's NFT comes from the testnet's registry (the testnet emblem import after the move to mainnet)
  const nftOf = (id: number) => {
    const r = id === chain.status().chainId || id === stateChainId ? contracts.effective(id).nft : persist ? new ContractsStore(chainDir(cfg.dataDir, id)).stored().nft : null;
    return r ? { address: r.address, txHash: r.txHash } : null;
  };
  const holderReaderFor =
    opts.holderReaderFor ??
    ((id: number): HolderReader | null => {
      const own = chain.evm?.() ?? null;
      if (own && id === chain.status().chainId) return own;
      if (id === ROBINHOOD_TESTNET_CHAIN_ID) return viemHolderReader(cfg.chain.testnetRpcUrl || NETWORKS.testnet.rpcUrl);
      return null;
    });
  const nft = new NftCollection({ file: chainState ? join(chainState, NFT_COLLECTION_FILE) : null, size: cfg.nft.size, seed: cfg.nft.seed, style: cfg.nft.style, log });
  const site = new SiteApi(cfg, auth, siteStore, opts.siteLimits, {
    chain,
    contracts,
    pins: new SitePinsStore(persist ? cfg.dataDir : null, log),
    mint,
    nft,
    profiles,
    journal,
    baseUrl: (req) => publicBaseUrl(cfg, req),
    dataDir: persist ? cfg.dataDir : null,
    holderWl,
    nftOf,
    holderReaderFor,
    faucet: new FaucetInfo({ chain, contracts }),
    avatars,
    leaderboards,
    log,
  });
  const priceKeeper = chain.evm
    ? new PriceKeeper({ client: () => chain.evm?.() ?? null, nft: () => nftRecord()?.address ?? null, usdCents: cfg.mint.usdCents, fetchPrice, log })
    : null;
  // integrity data lives next to the journal; the fake chain keeps its own directory
  const integrityDir = persist ? join(cfg.dataDir, cfg.devFakeChain ? 'integrity.dev-fake' : 'integrity') : null;
  const integrity = new IntegrityService({
    // auto-hold of high-risk payouts: on by default on the mainnet (an admin may still turn it off), off on a testnet
    store: new IntegrityStore(integrityDir, { log, defaults: integrityDefaults(cfg.chain.chainId === ROBINHOOD_CHAIN_ID || stateChainId === ROBINHOOD_CHAIN_ID ? ROBINHOOD_CHAIN_ID : stateChainId) }),
    journal,
    kick: () => chain.kick(),
    books: () => (chain as Partial<{ booksGuard(): ReadonlyMap<number, string> }>).booksGuard?.() ?? new Map(),
    log,
  });
  site.setIntegrity(integrity);
  const held = journal.held().length;
  if (held > 0) log(`integrity: ${held} settlement(s) held for admin review (/admin → Safety → Held settlements)`);

  // the admin's map settings per room kind (DATA_DIR/site/maps.json; taken over once from the old bots.json)
  const mapSettings = new MapSettingsStore(persist ? cfg.dataDir : null, log);

  // one emblem, one holder perk at a time: token id claims of holder tickets and of the daily perks (per chain)
  const emblemClaims = new EmblemClaims(chainState ? join(chainState, 'emblem-claims.json') : null, log);
  const emblemTokens = (wallet: string, fresh = false) => mint.emblemTokens(wallet, fresh);

  // bought power-ups: the admin's prices (DATA_DIR/site/shop.json), the charges and used payments per chain
  const shopSettings = new ShopSettingsStore(persist ? cfg.dataDir : null, undefined, log);
  const boostInventory = new BoostInventory(chainState ? join(chainState, files.boosts) : null, log);
  // arena tiers in US dollars and the token's USD price (DATA_DIR/chains/<id>/arena-prices.json): the owner re-prices on chain
  const arenaPrices = new ArenaPriceStore(chainState, log);
  // what is priced in dollars (power-up packs, custom room fees) converts at the arenas' price and rounding (the manual price today)
  const usdPrice = async () => {
    const r = await arenaPrices.price();
    return r.ok ? { price: r.price, usdPerToken: r.usdPerToken, sigFigs: arenaPrices.settings.sigFigs } : null;
  };
  const shop = new ShopService({
    settings: shopSettings,
    inventory: boostInventory,
    chain,
    holder: (wallet, fresh) => mint.isHolder(wallet, fresh),
    shownHolder: (wallet) => mint.shownHolder(wallet),
    emblemTokens,
    claims: emblemClaims,
    usdPrice,
    log,
  });
  site.setShop({ service: shop, settings: shopSettings, inventory: boostInventory });
  site.setArenaPrices(arenaPrices);

  // "Link X": X accounts linked by a post with a code (no X API; DATA_DIR/x-links.json, DATA_DIR/x-avatars/)
  const xLinks: XLinkService = new XLinkService({
    dataDir: persist ? cfg.dataDir : null,
    suffix: cfg.devFakeChain ? '.dev-fake' : '',
    // the dev stack (fake chain only) may ask for a fake X: posts carry the newest code, by @coinnibal_fan
    ...(opts.xFetch ? { fetch: opts.xFetch } : {}),
    ...(!opts.xFetch && cfg.devFakeChain && process.env.DEV_FAKE_X === '1' ? { fetch: fakeXFetch({ text: () => `Linking my X to Coinnibal: ${xLinks.lastCode() ?? ''} ${siteHostOf(cfg.publicUrl)}`, avatar: devFakeXPicture }) } : {}),
    log,
  });
  if (cfg.devFakeChain && process.env.DEV_FAKE_X === '1') log('x-links: DEV_FAKE_X=1, X is faked (dev stack only)');
  site.setXLinks(xLinks);
  // the card pictures (share and Appetizer cards) are drawn in card worker threads (`CARD_WORKERS`, 0: here)
  const cardRenderer = createCardRenderer(cfg.cardWorkers, log);
  site.appetizers.setRenderer(cardRenderer);
  // "Share on X": cards of results and kills, made from the server's own records (DATA_DIR/site/shares.json)
  const shares = new ShareService({
    renderer: cardRenderer,
    dataDir: persist ? cfg.dataDir : null,
    baseUrl: (req) => publicBaseUrl(cfg, req),
    token: () => {
      const t = chain.status().token;
      return t ? { decimals: t.decimals, symbol: t.symbol } : null;
    },
    xLinked: (handle) => xLinks.links.linkedHandle(handle),
    log,
  });
  // the native canvas addon draws the share cards: checked once at startup, where the cards are drawn (the server
  // runs without it); a card asked for before the answer is drawn, or falls back if drawing fails
  void cardRenderer.selfCheck().then((cards) => {
    if (cards.ok) log(`share cards: @napi-rs/canvas ready (${cfg.cardWorkers > 0 ? `${cfg.cardWorkers} card worker${cfg.cardWorkers > 1 ? 's' : ''}` : 'on the main thread'})`);
    else {
      shares.setRenderBroken(cards.error);
      site.appetizers.setRenderBroken(cards.error);
      log(`!!! share cards: @napi-rs/canvas cannot draw here (${cards.error}) — share images fall back to the site's picture; everything else works`);
    }
  });
  const rooms = new RoomManager(
    cfg,
    {
      chain,
      journal,
      leaderboards,
      log,
      now: opts.now,
      integrity,
      shop,
      // the server's own records: every finished game of a signed-in wallet counts in its profile
      onGameOver: (e) => {
        const s = e.stats;
        const test = !!e.room.opts.test;
        // a room's end (a bell, a custom room's end): the card of my place on its final board and who I ate, for
        // "Share on X" (a test arena's card says TEST and shows no payout)
        if (e.conn && s.finalRank && s.finalOf) {
          const card = shares.result(
            { room: e.room, player: e.player, wallet: e.conn.wallet },
            { rank: s.finalRank, of: s.finalOf, mass: s.finalMass, kills: s.playersEaten, payout: s.payout, eaten: s.eaten, eatenMore: s.eatenMore, standings: e.standings },
          );
          e.conn.send({ t: 'share', kind: card.kind, id: card.id, ...(card.board?.length ? { standings: true } : {}), ...(test ? { test: true } : {}) });
        } else if (e.conn && e.dead) {
          // a death: the card of the game I had (an offer, kept only if its link is opened), for the death sheet's share panel
          const card = shares.game({ room: e.room, player: e.player, wallet: e.conn.wallet }, { mass: s.maxMass, kills: s.playersEaten, eaten: s.eaten, eatenMore: s.eatenMore });
          e.conn.send({ t: 'share', kind: card.kind, id: card.id, dead: true, ...(test ? { test: true } : {}) });
        }
        // a test arena (testnet, with bots): its games count nowhere official (no profile stats)
        if (test) return;
        const wallet = e.conn?.wallet;
        if (!wallet) return;
        const xp = profiles.recordGame(wallet, { score: s.maxMass, kills: s.playersEaten, xp: s.xp ?? 0 });
        const level = profiles.level(wallet);
        if (e.conn!.profile) e.conn!.profile = { ...e.conn!.profile, xp, level };
        e.conn!.send({ t: 'xp', xp, level });
      },
      // a person ate a person (in a test arena a practice bot too, on a TEST card): the killer's card (one every few seconds at most;
      // an offer that is kept for good only once its link is opened, so a kill nobody shares costs no storage)
      onNotableKill: (e) => {
        const card = shares.kill({ room: e.room, player: e.player, wallet: e.conn.wallet }, e.conn.wallet ?? `conn:${e.conn.id}`, e);
        if (card) {
          e.conn.send({ t: 'share', kind: 'kill', id: card.id, victim: card.victim ?? e.victim, ...(card.victimBot ? { victimIsBot: true } : {}), ...(card.victimX ? { victimX: card.victimX } : {}), ...(card.test ? { test: true } : {}) });
        }
      },
    },
    chain,
    mapSettings,
    // the arena instance scaler's settings (DATA_DIR/site/arena-scaling.json)
    new ArenaScalingStore(persist ? cfg.dataDir : null, log),
    // "Test arenas with bots" (testnet only; DATA_DIR/site/test-arenas.json; refused and ignored on the mainnet)
    new TestArenaStore(cfg.chain.chainId, persist ? cfg.dataDir : null, log),
  );
  // custom rooms: paid in the game token with `CoinnibalArena.pay` (half burned, half to the fee wallet; the receipt
  // checked like a power-up purchase), restored after a restart
  const customRooms = new CustomRoomService({
    rooms,
    dataDir: persist ? cfg.dataDir : null,
    suffix: cfg.devFakeChain ? '.dev-fake' : '',
    used: new UsedPayments(chainState ? join(chainState, cfg.devFakeChain ? 'room-payments.dev-fake.json' : 'room-payments.json') : null, log),
    chain,
    usdPrice,
    isHolder: (wallet) => mint.isHolder(wallet),
    shownHolder: (wallet) => mint.shownHolder(wallet),
    emblemTokens,
    claims: emblemClaims,
    now: opts.customNow,
    log,
  });
  customRooms.restore();
  site.setCustomRooms(customRooms);
  // `GET /api/admin/backup` writes every store's unsaved state first (the journal writes at once)
  site.setFlush(() => {
    mint.flush();
    customRooms.flush();
    integrity.flush();
    leaderboards.flush();
    profiles.flush();
    shares.flush();
    site.appetizers.flush();
  });
  shop.onCharges((wallet) => rooms.pushBoosts(wallet));
  // a removed (or replaced) picture comes off the live coins at once
  site.onAvatarChange((wallet) => void rooms.clearAvatar(wallet));
  site.setLoad(() => gameLoad(rooms.loadStats()));
  site.setMaps({ store: rooms.mapSettings, live: () => rooms.roomCounts(), log });
  site.setScaler(rooms.scaler);
  site.setTestArenas(rooms);
  chain.setLiveSessionProvider(() => rooms.liveSessions());
  // "Re-price at next bell": the arena closes at the round's last minute, drains after its bell, waits for the owner
  const reprice = new RepriceScheduler({
    listArenas: (fresh) => chain.listArenas(fresh),
    journal,
    roundWindow: (n) => rooms.roundWindow(n),
    now: () => rooms.now(),
    liveStakes: (id) => rooms.liveStakesOf(id),
    sweepNow: () => void (chain as Partial<{ sweepStale(): Promise<number> }>).sweepStale?.(),
    file: chainState ? join(chainState, 'reprice.json') : null,
    log,
  });
  (chain as Partial<{ setClosedArenaProvider(fn: () => Set<number>): void }>).setClosedArenaProvider?.(() => reprice.closedArenas());
  rooms.repricingArenas = () => reprice.view().filter((e) => reprice.closedForSeats(e.arenaId)).map((e) => e.arenaId);
  site.setReprice(reprice);
  const repriceTimer = setInterval(() => void reprice.tick().catch((err) => log(`reprice: ${(err as Error).message}`)), 2_000);
  repriceTimer.unref();
  const emblems = new EmblemGate({
    chain,
    journal,
    claims: emblemClaims,
    isHolder: (w, fresh) => mint.isHolder(w, fresh),
    emblemTokens,
    flag: (c) => void integrity.raise(c),
    liveSessions: () => rooms.liveSessions(),
    // a cancel for an emblem moved away or passed on is a no-show unless the arena takes no seat or the server owes it
    noShow: (s) => !chain.joinsPaused?.() && rooms.arenaTakesSeats(s.arenaId) && !reprice.closedForSeats(s.arenaId) && chain.excusedSince?.(s.arenaId, s.player, s.openedAt) !== true,
    log,
  });
  // the game token was set on chain (picked up by the 30 s config watcher, no restart): attach the
  // arenas now (a fresh read of the arena list) instead of waiting for the next arena timer
  chain.onStatusChange(() => {
    if (chain.tokenReady) void rooms.refreshArenas();
  });
  await chain.start();
  // the network this process names (testnet or mainnet): the one it runs on, else the configured one
  const showChain = () => {
    const st = chain.status();
    setActiveChain(chainInfo(st.chainId ?? cfg.chain.chainId, chainOverridesFor(cfg)));
  };
  showChain();
  chain.onStatusChange(showChain);
  await rooms.ensureArenaRooms();

  // join permits (CoinnibalArena v4): who may buy a ticket, and how many may wait for a seat (stake/join-permits.ts)
  const permits = new JoinPermits({
    chain,
    gameOpenFor: (wallet, origin) => site.gameOpenFor(wallet, true, origin),
    isBanned: (wallet) => integrity.isBanned(wallet),
    // the owner's wallets: never refused by the network rules (stake/join-permits.ts, the invariant's rule 4)
    isAdmin: (wallet) => site.isAdmin(wallet),
    isHolder: (wallet) => mint.isHolder(wallet),
    blocked: () => rooms.blockedArenas().map((b) => b.arenaId),
    seatedKeys: () => rooms.liveSessions(),
    pendingKeys: () => journal.pending.map((p) => p.key),
    seatsPerRound: () => cfg.arenaInstanceCap * rooms.scaler.settings.maxInstances,
    noShows: (wallet, since) => chain.noShowsSince?.(wallet, since) ?? [],
    // standing (exempt from the network rules): a played ticket of its own in 14 days, or an NFT of its own
    playedAt: (wallet) => chain.lastPlayedAt?.(wallet) ?? null,
    // the holder index (no chain read here); kept warm by a low-priority catch-up at most every 2 minutes
    holderTokens: (wallet) => {
      void mint.holdersCount().catch(() => 0);
      return mint.emblemTokens(wallet);
    },
    // a ticket for a paid custom room is bound to it while it takes seats (its early refund is excused: audit R4-M1)
    paidRoom: (arenaId, code) => {
      const seats = rooms.paidRoomSeats(arenaId, code);
      const view = seats === null ? null : customRooms.get(code);
      return seats !== null && view && view.kind === 'paid' && !view.closing ? { seats, creator: view.creator } : null;
    },
    cfg: cfg.joinPermits,
    log,
  });
  // a settled or cancelled ticket used its permit (a no-show also counts against the networks its permit was asked from)
  chain.onSettled((e) => {
    const arenaId = e.arenaId ?? parseSessionKey(e.key)?.arenaId;
    if (arenaId !== undefined) permits.ticketDone(e.player, arenaId, e.noShow === true);
  });
  const server = createHttpServer(cfg, { rooms, leaderboards, chain, auth, journal, site, shares, priceKeeper, permits, apiLimiter: opts.apiLimiter, startedAt: Date.now(), log });
  const gateway = new Gateway(cfg, rooms, auth, chain, journal, log);
  gateway.setProfiles(profiles);
  // a linked X handle rides on the coin (read from memory at the join: X is never asked then)
  gateway.setXHandles((wallet) => xLinks.links.handle(wallet));
  // who may play: `gameAccess` (setting) or `GAME_ACCESS`: admins, NFT holders + admins, or everyone
  // (an open-play copy of the site opens it to everyone on a testnet: OPEN_PLAY_ORIGINS, the socket's Origin)
  gateway.setGameGate((wallet, fresh, origin) => site.gameOpenFor(wallet, fresh, origin));
  // wallets the admin banned after an integrity review cannot start arena games (practice still works)
  gateway.setBanGate((wallet) => integrity.isBanned(wallet));
  // emblem holders wear a laurel and may play the emblem skin (cached holder check of the NFT)
  gateway.setHolderCheck((wallet, gate) => (gate ? mint.isHolder(wallet) : mint.shownHolder(wallet)));
  gateway.setRepricing((id) => reprice.closedForSeats(id));
  // holder tickets: the emblem is there at the seat (read fresh) and one token id serves one open holder ticket
  gateway.setEmblemGate((wallet, session) => emblems.seat(wallet, session));
  // a wallet sitting down with its ticket gives up the place its join permit held; a ticket read used up its permits
  gateway.setTicketSeen((wallet, arenaId, openedAtS) => permits.ticketSeen(wallet, arenaId, openedAtS));
  // a paid room that stopped taking seats refunds the unseated ticket bought for it without a no-show (audit R4-M1)
  gateway.setRoomExcuse((wallet, arenaId, code, openedAtS) => permits.roomExcuse(wallet, arenaId, code, openedAtS));
  chain.onSettled((e) => emblems.settled(e.key));
  const emblemTimer = setInterval(() => emblems.sweep(), 60_000);
  emblemTimer.unref();
  // graceful degradation: new joins are shed before the live rooms lose their tick budget
  const shedder = new LoadShedder({ bestTickP95Ms: () => rooms.bestTickP95Ms() }, log);
  if (cfg.loadShed) {
    gateway.setShedder(shedder);
    shedder.start();
  }
  integrity.start();
  priceKeeper?.start();
  gateway.attach(server);
  const flushTimer = setInterval(() => leaderboards.flush(), 30_000);
  flushTimer.unref();
  // arenas created (or a chain / token that came online) after startup show up in the lobby without a restart
  const arenaTimer = setInterval(() => void rooms.ensureArenaRooms(), 30_000);
  arenaTimer.unref();

  let closed = false;
  return {
    server,
    rooms,
    chain,
    journal,
    auth,
    leaderboards,
    site,
    profiles,
    contracts,
    stateChainId,
    holderWl,
    mint,
    nft,
    priceKeeper,
    integrity,
    customRooms,
    shop,
    shares,
    xLinks,
    gateway,
    shedder,
    permits,
    listen: () =>
      new Promise((resolve) => {
        server.listen(cfg.port, cfg.host, () => {
          rooms.start();
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : cfg.port);
        });
      }),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(flushTimer);
      clearInterval(arenaTimer);
      clearInterval(emblemTimer);
      clearInterval(repriceTimer);
      shedder.stop();
      stopRpcLog();
      mint.flush();
      // no new socket or request from here on: a client that reconnects during the shutdown would keep the HTTP
      // server open (and the process alive) until the hard exit
      gateway.stopAccepting();
      server.close();
      await rooms.shutdown();
      customRooms.flush();
      integrity.close();
      priceKeeper?.stop();
      leaderboards.flush();
      profiles.flush();
      shares.flush();
      site.appetizers.flush();
      await cardRenderer.close();
      gateway.close();
      await chain.stop().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    },
  };
}
