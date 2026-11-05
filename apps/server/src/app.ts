import { SiteFail } from './site/validate';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { ELYSIUM_TESTNET_CHAIN_ID, LOCALNET_CHAIN_ID, chainByKey, chainInfo, isTestChainId, setActiveChain } from '@elymum/shared';
import { chainOverridesFor } from './chain/evm';
import type { Hex } from 'viem';
import { Auth } from './auth';
import { assertDevFakeChainAllowed, createChain, dataFileNames } from './chain';
import { PriceKeeper } from './chain/price-keeper';
import type { ChainGateway } from './chain/types';
import type { ServerConfig } from './config';
import { createHttpServer, publicBaseUrl, redactUrls } from './http';
import { IntegrityService } from './integrity/service';
import { IntegrityStore } from './integrity/store';
import { Leaderboards } from './leaderboards';
import type { Limiter } from './net/limiter';
import { Gateway } from './net/gateway';
import { MapSettingsStore } from './rooms/map-settings';
import { viemHolderReader, type HolderReader } from './chain/evm-client';
import { configureRpcBudgets, startRpcMinuteLog } from './chain/rpc-budget';
import { loadServerKeySecret } from './chain/server-key';
import { chainDir, isTestChain, migrateLegacyState, resolveStateChainId, stateDir } from './chain/state-dir';
import { HolderWlStore } from './site/holder-wl';
import { FaucetInfo } from './site/network';
import { RoomManager } from './rooms/manager';
import { gameLoad } from './rooms/load';
import { CustomRoomService } from './rooms/custom';
import { UsedPayments, devFakePaymentReader, viemPaymentReader, type PaymentReader } from './chain/payment';
import { checksumAddress } from './auth';
import { ProfileStore } from './profiles';
import { AvatarStore } from './avatars';
import { ContractsStore } from './site/contracts';
import { MintService, hyperliquidPrice, type PriceFetcher } from './site/mint';
import { SiteApi, type SiteLimits } from './site/routes';
import { SiteStore } from './site/store';
import { Journal } from './stake/journal';
import { BoostInventory } from './shop/inventory';
import { ShopService } from './shop/service';
import { ShopSettingsStore } from './shop/settings';

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
  /** The NFT mint: state, the gas token's USD price, holders, allowlist, metadata. */
  mint: MintService;
  /** Keeps the mint price at $1 in the gas token when the server key is the NFT's price keeper; null without a chain. */
  priceKeeper: PriceKeeper | null;
  /** Cheat and collusion detection: telemetry, flags, bans, auto-hold (`/api/admin/integrity/*`). */
  integrity: IntegrityService;
  /** Paid custom rooms: settings, live rooms, payment checks (`/api/rooms/custom/*`, `/api/admin/custom-rooms`). */
  customRooms: CustomRoomService;
  /** Bought power-ups: prices, purchases (`DATA_DIR/chains/<id>/boosts.json`) and the in-room rules. */
  shop: ShopService;
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
    /** HYPE/USD feed (default: Hyperliquid at `HYPE_PRICE_URL`); tests inject one. */
    fetchPrice?: PriceFetcher;
    /** The chain id to key the state on (default: the injected chain's, else `eth_chainId` of `EVM_RPC_URL`). */
    chainId?: number | null;
    /** Holder readers per chain (default: the server's client on its own chain, `TESTNET_RPC_URL` for the testnet). */
    holderReaderFor?: (chainId: number) => HolderReader | null;
    /** Reads custom-room payments (default: the server's RPC; the fake chain's own on `DEV_FAKE_CHAIN`); tests inject one. */
    paymentReader?: PaymentReader | null;
    /** Wall clock of the custom rooms (Unix ms); tests inject one. */
    customNow?: () => number;
  } = {},
): Promise<App> {
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${redactUrls(m)}`));
  const persist = opts.persist ?? true;
  // refuse a misconfigured DEV_FAKE_CHAIN before any file is opened
  assertDevFakeChainAllowed(cfg);
  // one request budget per RPC URL for the whole process (the public RPC answers 429 above its limit)
  configureRpcBudgets({ ratePerSec: cfg.chain.rpcMaxRps, burst: cfg.chain.rpcBurst });
  const stopRpcLog = startRpcMinuteLog(log);
  const files = dataFileNames(cfg);
  // chain-keyed state: DATA_DIR/chains/<chainId>/ (registry, journal, bot wallets, allowlist snapshots)
  const stateChainId =
    opts.chainId !== undefined ? opts.chainId : opts.chain ? opts.chain.status().chainId : await resolveStateChainId(cfg, { persist, log });
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
  const auth = new Auth(cfg.authSecret, { onChain: chain.verifyMessage ? (a, m, sig) => chain.verifyMessage!(a, m, sig) : null });
  const profiles = new ProfileStore(persist ? join(cfg.dataDir, files.profiles) : null, log);
  // profile pictures: content-addressed files next to the profiles (DATA_DIR/avatars/<id>.png|webp)
  const avatars = new AvatarStore(persist ? join(cfg.dataDir, cfg.devFakeChain ? 'avatars.dev-fake' : 'avatars') : null, log);
  // on a public testnet the game is open to everyone unless the admin already chose otherwise
  const siteStore = new SiteStore(persist ? cfg.dataDir : null, { now: opts.siteNow, log, ...(isTestChainId(stateChainId) && stateChainId !== LOCALNET_CHAIN_ID ? { defaults: { gameAccess: 'public' } } : {}) });
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
    log,
  });
  // the NFT of another chain comes from that chain's registry (the testnet emblem import after the move to mainnet)
  const nftOf = (id: number) => {
    const r = id === chain.status().chainId || id === stateChainId ? contracts.effective(id).nft : persist ? new ContractsStore(chainDir(cfg.dataDir, id)).stored().nft : null;
    return r ? { address: r.address, txHash: r.txHash } : null;
  };
  const holderReaderFor =
    opts.holderReaderFor ??
    ((id: number): HolderReader | null => {
      const own = chain.evm?.() ?? null;
      if (own && id === chain.status().chainId) return own;
      if (id === ELYSIUM_TESTNET_CHAIN_ID) return viemHolderReader(cfg.chain.testnetRpcUrl || chainByKey('elysium-testnet').rpcUrl!);
      return null;
    });
  const site = new SiteApi(cfg, auth, siteStore, opts.siteLimits, {
    chain,
    contracts,
    mint,
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
    store: new IntegrityStore(integrityDir, { log }),
    journal,
    kick: () => chain.kick(),
    log,
  });
  site.setIntegrity(integrity);
  const held = journal.held().length;
  if (held > 0) log(`integrity: ${held} settlement(s) held for admin review (/admin → Integrity)`);

  // the admin's map settings per room kind (DATA_DIR/site/maps.json; taken over once from the old bots.json)
  const mapSettings = new MapSettingsStore(persist ? cfg.dataDir : null, log);

  // bought power-ups: the admin's prices (DATA_DIR/site/shop.json), the charges and used payments per chain
  const shopSettings = new ShopSettingsStore(persist ? cfg.dataDir : null, undefined, log);
  const boostInventory = new BoostInventory(chainState ? join(chainState, files.boosts) : null, log);
  const shop = new ShopService({
    settings: shopSettings,
    inventory: boostInventory,
    chain,
    holder: (wallet, fresh) => mint.isHolder(wallet, fresh),
    log,
  });
  site.setShop({ service: shop, settings: shopSettings, inventory: boostInventory });

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
        const wallet = e.conn?.wallet;
        if (!wallet) return;
        const xp = profiles.recordGame(wallet, { score: e.stats.maxMass, kills: e.stats.playersEaten, xp: e.stats.xp ?? 0 });
        const level = profiles.level(wallet);
        if (e.conn!.profile) e.conn!.profile = { ...e.conn!.profile, xp, level };
        e.conn!.send({ t: 'xp', xp, level });
      },
    },
    chain,
    mapSettings,
  );
  // custom rooms: paid with a gas-token transfer to the treasury (checked on chain), restored after a restart
  let paymentReader: PaymentReader | null | undefined = opts.paymentReader;
  const customRooms = new CustomRoomService({
    rooms,
    dataDir: persist ? cfg.dataDir : null,
    suffix: cfg.devFakeChain ? '.dev-fake' : '',
    used: new UsedPayments(chainState ? join(chainState, cfg.devFakeChain ? 'room-payments.dev-fake.json' : 'room-payments.json') : null, log),
    reader: () => {
      if (paymentReader !== undefined) return paymentReader;
      if (cfg.devFakeChain) return (paymentReader = devFakePaymentReader());
      if (!chain.enabled || !cfg.chain.rpcUrl) return null;
      return (paymentReader = viemPaymentReader(cfg.chain.rpcUrl));
    },
    chainId: () => chain.status().chainId,
    isHolder: (wallet) => mint.isHolder(wallet),
    ownerWallet: checksumAddress(cfg.adminWallets[0] ?? null),
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
  });
  shop.onCharges((wallet) => rooms.pushBoosts(wallet));
  // a removed (or replaced) picture comes off the live coins at once
  site.onAvatarChange((wallet) => void rooms.clearAvatar(wallet));
  site.setLoad(() => gameLoad(rooms.loadStats()));
  site.setMaps({ store: rooms.mapSettings, live: () => rooms.roomCounts(), log });
  chain.setLiveSessionProvider(() => rooms.liveSessions());
  // the game token was set on chain (picked up by the 30 s config watcher, no restart): attach the
  // arenas now (a fresh read of the arena list) instead of waiting for the next arena timer
  chain.onStatusChange(() => {
    if (chain.tokenReady) void rooms.refreshArenas();
  });
  await chain.start();
  // what this process shows amounts in (logs, the price feed's coin): the chain it runs on, else the configured one
  const showChain = () => {
    const st = chain.status();
    setActiveChain(chainInfo(st.chainId ?? cfg.chain.chainId, chainOverridesFor(cfg, st.chainId ?? cfg.chain.chainId)));
  };
  showChain();
  chain.onStatusChange(showChain);
  await rooms.ensureArenaRooms();

  const server = createHttpServer(cfg, { rooms, leaderboards, chain, auth, journal, site, priceKeeper, apiLimiter: opts.apiLimiter, startedAt: Date.now(), log });
  const gateway = new Gateway(cfg, rooms, auth, chain, journal, log);
  gateway.setProfiles(profiles);
  // who may play: `gameAccess` (setting) or `GAME_ACCESS`: admins, NFT holders + admins, or everyone
  gateway.setGameGate((wallet, fresh) => site.gameOpenFor(wallet, fresh));
  // wallets the admin banned after an integrity review cannot start arena games (practice still works)
  gateway.setBanGate((wallet) => integrity.isBanned(wallet));
  // emblem holders wear a laurel and may play the emblem skin (cached holder check of the NFT)
  gateway.setHolderCheck((wallet) => mint.isHolder(wallet));
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
    priceKeeper,
    integrity,
    customRooms,
    shop,
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
      stopRpcLog();
      mint.flush();
      await rooms.shutdown();
      customRooms.flush();
      integrity.close();
      priceKeeper?.stop();
      leaderboards.flush();
      profiles.flush();
      gateway.close();
      await chain.stop().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
