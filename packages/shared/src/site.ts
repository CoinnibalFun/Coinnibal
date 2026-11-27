import type { XLinkError } from './xlink';

/**
 * Coinnibal site: WL (allowlist) and collab applications, the NFT mint, the contracts registry and
 * player profiles. Types shared by the server (`/api/site/*`, `/api/admin/*`, `/api/profile`) and
 * the web app, plus the validation rules both apply.
 */

/** The X account of the project (no `@`). */
export const SITE_X_HANDLE_DEFAULT = 'coinnibalfun';

/**
 * Who may play (practice, arenas, private rooms, spectating): `admins` only, NFT `holders`
 * (wallets with `balanceOf > 0` on the NFT) plus admins, or the `public`.
 */
export type GameAccess = 'admins' | 'holders' | 'public' | 'maintenance';
/** `maintenance`: only admins play (like `admins`), and /play tells everyone else the game is down for maintenance. */
export const GAME_ACCESS_MODES: readonly GameAccess[] = ['admins', 'holders', 'public', 'maintenance'];
export const GAME_ACCESS_DEFAULT: GameAccess = 'admins';

/** The game shows on the site (nav links, the faucet, landing pieces): every mode but `admins`. */
export function gameVisible(mode: GameAccess): boolean {
  return mode !== 'admins';
}

export function isGameAccess(s: unknown): s is GameAccess {
  return typeof s === 'string' && (GAME_ACCESS_MODES as readonly string[]).includes(s);
}

/** Site switches the admin controls. */
export interface SiteSettings {
  /** WL applications accepted. */
  wlOpen: boolean;
  /** Collab applications accepted (the landing's Collab button reads it). */
  collabOpen: boolean;
  /** Appetizer cards handed out (`appetizer.ts`; the landing's card stand reads it). */
  appetizerOpen: boolean;
  /** Visitors see the mint page (and every link to it). */
  mintOpen: boolean;
  /** Who may play (server `GAME_ACCESS` overrides it). */
  gameAccess: GameAccess;
  /** The project's X handle, without `@`. */
  xHandle: string;
  /** The pinned launch post the `engage_x` task points at; null until it is live. */
  launchPostUrl: string | null;
  /**
   * The X post the Appetizer's "like and comment" step opens (`appetizer.ts`): an x.com / twitter.com status link;
   * null hides the step. Defaults to the project's Appetizer post (`APPETIZER_POST_URL_DEFAULT`).
   */
  appetizerPostUrl: string | null;
}

/** The project's Appetizer post on X: the Appetizer's "like and comment" step until the admin sets another (or none). */
export const APPETIZER_POST_URL_DEFAULT = 'https://x.com/Coinnibalfun/status/2126283168374251696';

/** Earlier defaults of `appetizerPostUrl`: a stored one moves to the current default on start. */
export const PREVIOUS_APPETIZER_POST_URLS: readonly string[] = ['https://x.com/Coinnibalfun/status/2123416055406354866'];

export const SITE_SETTINGS_DEFAULT: SiteSettings = {
  wlOpen: false,
  collabOpen: false,
  appetizerOpen: true,
  mintOpen: false,
  gameAccess: GAME_ACCESS_DEFAULT,
  xHandle: SITE_X_HANDLE_DEFAULT,
  launchPostUrl: null,
  appetizerPostUrl: APPETIZER_POST_URL_DEFAULT,
};

export type WlTaskKind = 'follow_x' | 'post_x' | 'engage_x' | 'join_link' | 'text' | 'wallet';
export const WL_TASK_KINDS: readonly WlTaskKind[] = ['follow_x', 'post_x', 'engage_x', 'join_link', 'text', 'wallet'];

/** One WL task, as the admin edits it. */
export interface WlTask {
  id: string;
  kind: WlTaskKind;
  title: string;
  body: string;
  /** URL or handle the task points at. An `engage_x` task with no target uses `SiteSettings.launchPostUrl`. */
  target: string | null;
  required: boolean;
  enabled: boolean;
  order: number;
}

/** A task as the public sees it: enabled tasks only, the target resolved. */
export interface PublicWlTask {
  id: string;
  kind: WlTaskKind;
  title: string;
  body: string;
  target: string | null;
  required: boolean;
  /**
   * False when the task cannot be done yet (an `engage_x` task whose post is not live): the step shows
   * "opens when the post is live" and the server does not require it.
   */
  available: boolean;
}

/** Id of the seeded "Your X handle" task: its answer is the entry's `xHandle`. */
export const WL_TASK_X_HANDLE = 'x_handle';
/** Id of the seeded "Your EVM wallet" task: its answer is the signed-in wallet (0x address). */
export const WL_TASK_WALLET = 'wallet';

export type WlStatus = 'pending' | 'approved' | 'rejected';
export const WL_STATUSES: readonly WlStatus[] = ['pending', 'approved', 'rejected'];

/** A task as it was when the applicant answered it, with the answer. */
export interface WlTaskAnswer {
  id: string;
  kind: WlTaskKind;
  title: string;
  target: string | null;
  required: boolean;
  /** `true` for self-attested tasks (`follow_x`, `join_link`), else the text / URL / wallet given. */
  answer: string | true | null;
}

/** The applicant's own view of their WL entry. */
export interface WlEntryPublic {
  id: string;
  /** The applicant's wallet (an EVM address). */
  wallet: string;
  xHandle: string;
  status: WlStatus;
  tasks: WlTaskAnswer[];
  createdAt: number;
  updatedAt: number;
}

/** The admin view of a WL entry. */
export interface WlEntryAdmin extends WlEntryPublic {
  note: string;
  /** Ids of collabs whose wallet list holds this wallet (duplicate flag). */
  dupCollabs: string[];
}

/** `POST /api/site/wl` body. */
export interface WlSubmitRequest {
  /** The applicant's X handle (`@name`, `name` or an x.com profile URL; normalised by the server). */
  xHandle: string;
  /** Answers by task id. Self-attested tasks take `true`. Wallet tasks are filled by the server. */
  answers: Record<string, string | boolean>;
  /** Honeypot: must be absent or empty. */
  website?: string;
}

export type CollabType = 'dao' | 'guild' | 'alpha' | 'nft' | 'other';
export const COLLAB_TYPES: readonly CollabType[] = ['dao', 'guild', 'alpha', 'nft', 'other'];
export type CollabRole = 'founder' | 'community_manager' | 'moderator' | 'other';
export const COLLAB_ROLES: readonly CollabRole[] = ['founder', 'community_manager', 'moderator', 'other'];

/** Stored collab state: pending → rejected | approved{spots, deadline} → submitted{wallets, raffleUrl}. */
export type CollabStatus = 'pending' | 'rejected' | 'approved' | 'submitted';
export const COLLAB_STATUSES: readonly CollabStatus[] = ['pending', 'rejected', 'approved', 'submitted'];
/**
 * What the applicant sees: `in_review` (pending), `rejected` ("not this time"), `approved` (filling the
 * list), `submitted` (locked), `closed` (approved but the deadline passed without a submit).
 */
export type CollabPhase = 'in_review' | 'rejected' | 'approved' | 'submitted' | 'closed';

/** `POST /api/site/collab` body. */
export interface CollabApplyRequest {
  community: string;
  type: CollabType;
  members: number;
  /** The community's X handle. */
  communityX: string;
  /** The applicant's own X handle (at most 2 applications per handle). */
  contactX: string;
  discord?: string;
  role: CollabRole;
  /** A post about Coinnibal on the community's X (tags the project). */
  postUrl: string;
  about: string;
  /** Honeypot: must be absent or empty. */
  website?: string;
}

export interface CollabWalletRow {
  name: string;
  wallet: string;
}

export interface CollabPublic {
  id: string;
  /** The applicant's (signed-in) wallet. */
  wallet: string;
  community: string;
  type: CollabType;
  members: number;
  communityX: string;
  contactX: string;
  discord: string;
  role: CollabRole;
  postUrl: string;
  about: string;
  status: CollabStatus;
  phase: CollabPhase;
  /** Set on approval. */
  spots: number | null;
  /** Unix ms; set on approval. */
  deadline: number | null;
  wallets: CollabWalletRow[];
  raffleUrl: string | null;
  submittedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CollabWalletRowAdmin extends CollabWalletRow {
  /** The wallet has a WL entry. */
  dupWl: boolean;
  /** Other collabs whose list holds the wallet. */
  dupCollabs: string[];
}

export interface CollabAdmin extends Omit<CollabPublic, 'wallets'> {
  note: string;
  wallets: CollabWalletRowAdmin[];
}

export interface SiteCounts {
  wl: Record<WlStatus, number> & { total: number };
  collab: Record<CollabStatus, number> & { total: number; closed: number; wallets: number };
}

/** `GET /api/nft/provenance`: what verifies the emblem collection (the seed only after the reveal). */
export interface NftProvenance {
  size: number;
  seedHash: string;
  provenance: string;
  committedAt: number;
  /** The scheduled reveal block (decimal), null until scheduled. */
  revealBlock: string | null;
  revealed: boolean;
  seed: string | null;
  blockHash: string | null;
  offset: number | null;
  algorithm: string;
}

/** `GET /api/nft/rarity`: counts over the whole collection (nothing about which token gets what). */
export interface NftRarityStats {
  size: number;
  quotas: Record<string, number>;
  tiers: Record<string, number>;
  layers: Record<string, Record<string, number>>;
  duplicates: number;
}

/** `GET /api/admin/nft`. */
export interface NftCollectionAdminView {
  provenance: NftProvenance;
  stats: NftRarityStats;
  style: 'vector' | 'pixel';
  currentBlock: string | null;
  mint: { phase: string; totalSupply: number; maxSupply: number; soldOut: boolean } | null;
}

/** Error codes of `/api/site/*`, `/api/admin/*` and `/api/auth/login` (`{ error, message?, field? }`). */
export type SiteErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  /** Admin bot bankroll: the wallet holds no open ticket in that arena, or it is in use. */
  | 'no_ticket'
  | 'ticket_in_use'
  | 'method_not_allowed'
  | 'unsupported_media_type'
  | 'body_too_large'
  | 'rate_limited'
  | 'wl_closed'
  | 'collab_closed'
  | 'already_applied'
  | 'handle_taken'
  | 'collab_limit'
  | 'wrong_state'
  | 'deadline_passed'
  | 'too_many_wallets'
  | 'auth_failed'
  /** The game is not open to this wallet (`gameAccess`). */
  | 'game_closed'
  /** Contracts registry: the address holds no code, or code other than the bundled artifact. */
  | 'code_mismatch'
  /** Contracts registry: the contract's owner is not the signed-in admin. */
  | 'not_owner'
  /** Contracts registry: the arena's server authority is not the server key. */
  | 'wrong_authority'
  /** The server has no chain (its RPC did not answer, serves another chain or is not set, or SERVER_PRIVATE_KEY is empty or invalid) or the contract is not registered. */
  | 'chain_off'
  /** The upstream price feed (gas token / USD) could not be read. */
  | 'price_unavailable'
  /** Profile picture: not a PNG or WebP square of the allowed size (`AVATAR_LIMITS`). */
  | 'bad_image'
  /** Profile picture: an admin removed this picture; it cannot be uploaded again. */
  | 'image_blocked'
  /** A secret export (backup, migration settings) without a fresh, purpose-bound admin signature (`X-Coinnibal-Proof`). */
  | 'proof_required'
  /** The admin session is too old for admin routes (short-lived, revocable), or of the earlier long form: sign in again. */
  | 'admin_session_expired'
  /** Turned off on this server (secret exports on the mainnet without `ADMIN_SECRET_EXPORT=1`). */
  | 'disabled'
  /** "Link X": why a link attempt failed (`xlink.ts`). */
  | XLinkError
  /** "Link X": the X picture cannot be put on the coin here (no picture cached, or no image decoder on the server). */
  | 'x_picture_unavailable';

export interface SiteError {
  error: SiteErrorCode;
  message?: string;
  /** The offending field (validation errors). */
  field?: string;
}

/** Limits shared by the forms and the server. */
export const SITE_LIMITS = {
  /** Max JSON body (bytes). */
  bodyBytes: 32 * 1024,
  taskTitle: 80,
  taskBody: 600,
  taskTarget: 200,
  maxTasks: 30,
  textAnswer: 500,
  community: 60,
  discord: 40,
  about: 600,
  members: 10_000_000,
  note: 1000,
  walletName: 40,
  maxSpots: 1000,
  /** Applications per contact X handle. */
  collabsPerHandle: 2,
  /** Ids per bulk status change. */
  bulk: 500,
  pageSizeMax: 200,
} as const;

/** An X post (status) link. */
export const X_STATUS_URL_RE = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/;

export function isXStatusUrl(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 300 && X_STATUS_URL_RE.test(s) && !/\s/.test(s);
}

/**
 * Normalises an X handle: trims, drops a leading `@` or an x.com / twitter.com profile URL,
 * lower-cases. Null when the result is not a valid handle (1-15 of A-Z, a-z, 0-9, _).
 */
export function normalizeXHandle(s: unknown): string | null {
  if (typeof s !== 'string' || s.length > 100) return null;
  let h = s.trim();
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(h);
  if (m) h = m[1];
  h = h.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
  return h.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* EVM addresses                                                       */
/* ------------------------------------------------------------------ */

/** `0x` + 40 hex digits, any case. EIP-55 checksumming is done elsewhere (viem `getAddress`). */
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(s: unknown): s is `0x${string}` {
  return typeof s === 'string' && EVM_ADDRESS_RE.test(s);
}

/** Lower-case form of an EVM address (trimmed) for comparing and keying; null when it is not one. */
export function normalizeEvmAddress(s: unknown): `0x${string}` | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return EVM_ADDRESS_RE.test(t) ? (t.toLowerCase() as `0x${string}`) : null;
}

/** Both are EVM addresses and name the same account (case-insensitive). */
export function sameEvmAddress(a: unknown, b: unknown): boolean {
  const x = normalizeEvmAddress(a);
  return x !== null && x === normalizeEvmAddress(b);
}

/* ------------------------------------------------------------------ */
/* Contracts registry (`GET /api/site/contracts`, `/api/admin/contracts`) */
/* ------------------------------------------------------------------ */

export type ContractKind = 'arena' | 'nft' | 'token';
export const CONTRACT_KINDS: readonly ContractKind[] = ['arena', 'nft', 'token'];

export interface ContractRecord {
  /** EIP-55 checksummed. */
  address: string;
  /** The deploy (or registering) transaction; null when registered without one. */
  txHash: string | null;
  /** Chain the contract lives on. */
  chainId: number;
  /** Unix ms. */
  registeredAt: number;
  /** The admin wallet that registered it. */
  registeredBy: string;
}

/** What `DATA_DIR/contracts.json` holds and `GET /api/site/contracts` returns. */
export type ContractsRegistry = Record<ContractKind, ContractRecord | null>;

/** `POST /api/admin/contracts` body. `DELETE /api/admin/contracts?kind=` clears a kind. */
export interface ContractRegisterRequest {
  kind: ContractKind;
  address: string;
  txHash: string | null;
}

/* ------------------------------------------------------------------ */
/* Mint (`/api/site/mint*`, `/api/admin/mint/*`)                        */
/* ------------------------------------------------------------------ */

/** `CoinnibalNFT.Phase`, in contract order (Closed = 0, Allowlist = 1, Public = 2). */
export type MintPhase = 'closed' | 'allowlist' | 'public';
export const MINT_PHASES: readonly MintPhase[] = ['closed', 'allowlist', 'public'];

/** Default mint target in US cents (`MINT_USD_CENTS`). */
export const MINT_USD_CENTS_DEFAULT = 100;

/**
 * `CoinnibalNFT.mintState()`. Wei amounts are decimal strings (JSON has no bigint);
 * addresses and the root are 0x hex.
 */
export interface MintContractState {
  phase: MintPhase;
  priceWei: string;
  minPriceWei: string;
  maxPriceWei: string;
  /** Price keeper (zero address when none). */
  keeper: string;
  /** Published allowlist root (bytes32; zero when unset). */
  merkleRoot: string;
  maxSupply: number;
  totalSupply: number;
  wlLimit: number;
  publicLimit: number;
  treasury: string;
  /** Metadata frozen forever. */
  frozen: boolean;
}

/** `GET /api/site/mint`. */
export interface MintState {
  /** Null until an NFT contract is registered. */
  nftAddress: string | null;
  chainId: number | null;
  /** Null when there is no contract (or the chain is off). */
  contract: MintContractState | null;
  /** The gas token's price in USD; null when the feed is unavailable. */
  gasUsd: number | null;
  /** Current mint price in USD at `gasUsd`; null when either is unknown. */
  priceUsd: number | null;
  /**
   * The target the price is kept at (`MINT_USD_CENTS`). Left out while the mint page is closed (Settings → "Mint page
   * open" off), unless a signed-in admin asks.
   */
  targetUsdCents?: number;
  /** Distinct holders (wallets with `balanceOf > 0`). */
  holders: number;
  /** `totalSupply >= maxSupply`. */
  soldOut: boolean;
  gameAccess: GameAccess;
}

/** `GET /api/site/mint/proof?wallet=0x…`. */
export interface MintProofResponse {
  /** The wallet is in the server's latest allowlist snapshot. */
  eligible: boolean;
  /** Merkle proof (bytes32 hex) for `mintAllowlist`; empty when not eligible. */
  proof: string[];
  /** Root of the server's snapshot the proof is for; null when there is no snapshot. */
  root: string | null;
  /** Root published on the contract; the proof only works when it equals `root`. */
  onchainRoot: string | null;
}

/** A built allowlist: approved WL wallets plus submitted collab wallets, checksummed, de-duplicated, sorted. */
export interface AllowlistSnapshot {
  /** OpenZeppelin-compatible Merkle root (bytes32 hex). */
  root: string;
  count: number;
  wallets: string[];
  /** Unix ms. */
  builtAt: number;
  /** The admin wallet that built it. */
  builtBy: string;
  /** How many wallets came from each source (a wallet in several counts in each). `holders`: imported testnet emblem holders. */
  sources: { wl: number; collab: number; holders?: number };
}

/** `POST /api/admin/mint/allowlist` response. */
export interface AllowlistBuildResponse {
  root: string;
  count: number;
}

/** `GET /api/admin/mint/allowlist`. */
export interface AllowlistStatus {
  snapshot: AllowlistSnapshot | null;
  /** Current approvals vs the snapshot: wallets to add / drop on the next build. */
  diff: { added: string[]; removed: string[] };
  onchainRoot: string | null;
  /** The snapshot's root is the one on the contract. */
  published: boolean;
}

/** `GET /api/admin/mint/price`. */
export interface MintPriceQuote {
  /** The gas token's price in USD; null when the feed is unavailable. */
  gasUsd: number | null;
  targetUsdCents: number;
  /** `targetUsdCents` in wei at `gasUsd` (decimal string); null without a price. */
  priceWei: string | null;
  /** Unix ms of the gas-token/USD reading. */
  fetchedAt: number | null;
}

/* ------------------------------------------------------------------ */
/* Profiles (`GET /api/profile`, `PUT /api/profile`)                    */
/* ------------------------------------------------------------------ */

export interface ProfileStats {
  games: number;
  kills: number;
  /** Best score. */
  best: number;
}

/** `GET /api/profile` (signed-in). `name` is null before the player picks one. */
export interface ProfileView {
  /** EIP-55 checksummed. */
  wallet: string;
  name: string | null;
  skin: number;
  stats: ProfileStats;
  /** Unix ms; null when never saved. */
  updatedAt: number | null;
  /**
   * The uploaded profile picture (`isAvatarId`, served at `avatarPath`), null without one (never
   * uploaded, deleted, or removed by an admin). Worn in game with `join.pic`.
   */
  avatar?: string | null;
  /**
   * The country the player plays for (ISO 3166-1 alpha-2, `isCountryCode`); null: none picked
   * ("no flag"); absent: never saved (older profiles).
   */
  country?: string | null;
  /**
   * Wear the country's flag as the coin skin (`join.flag`); absent: never saved (off).
   */
  flagSkin?: boolean;
}

/** `GET /api/admin/avatars`: a player's profile picture, newest first. */
export interface AdminAvatarEntry {
  wallet: string;
  name: string | null;
  avatar: string;
  /** Unix ms of the upload. */
  at: number | null;
}

/**
 * The emblem skin: the Coinnibal emblem's coin face and colour as an in-game skin, unlocked for wallets
 * holding the NFT (checked by the server on `PUT /api/profile` and at every join). Outside the
 * `SKINS` table: a client renders it with its own emblem art.
 */
export const EMBLEM_SKIN_ID = 100;

/** `GET /api/profile` / `PUT /api/profile` response. */
export interface ProfileResponse {
  profile: ProfileView;
  /** Skin ids this wallet may pick: the basic skins, plus `EMBLEM_SKIN_ID` for NFT holders. */
  skinOptions?: number[];
  /** The wallet holds a Coinnibal emblem (laurel on the name tag, emblem skin). */
  holder?: boolean;
}

/** `PUT /api/profile` body. */
export interface ProfileUpdate {
  name: string;
  skin: number;
  /** ISO 3166-1 alpha-2 code, or null for no flag; absent: unchanged. */
  country?: string | null;
  /** Wear the country's flag as the coin skin; absent: unchanged. */
  flagSkin?: boolean;
}

/* ------------------------------------------------------------------ */
/* Network (`GET /api/admin/network`)                                   */
/* ------------------------------------------------------------------ */

export interface NetworkContractCheck {
  kind: ContractKind;
  address: string;
  /** `ok`: the bundled artifact's code; `mismatch`: other code; `missing`: no code; null: not checked (RPC down). */
  code: 'ok' | 'mismatch' | 'missing' | null;
  registeredBy: string;
}

/** `GET /api/admin/network`: the chain the server runs on, its health and the chain-keyed state. */
export interface NetworkInfo {
  /** Null while the chain is off. */
  chainId: number | null;
  chainName: string;
  /** A testnet or a localnet (not mainnet; `isTestChainId`). */
  testnet: boolean;
  rpcOk: boolean;
  rpcLatencyMs: number | null;
  /** Latest block (decimal string); null when the RPC did not answer. */
  block: string | null;
  serverKey: string | null;
  serverBalanceWei: string | null;
  /** The server key's gas runs low: under the floor, or under `GasRunway.criticalDays` days at the trailing spend. */
  low: boolean;
  /** The server key's gas runway (absent on an older server). */
  gas?: GasRunway;
  /** The registered contracts of the current chain, with a code check. */
  contracts: NetworkContractCheck[];
  /** Other chain ids with stored state under `DATA_DIR/chains/`. */
  otherChains: number[];
  /** The game server's threads (absent on an older server). */
  load?: GameServerLoad;
}

/**
 * The server key's gas runway: its balance against the trailing spend (the balance drops between reads over the last
 * day; top-ups are not spend). `critical`: under the floor or under `criticalDays` (2) of runway; `warn`: under
 * `warnDays` (7); `unknown`: less than an hour of samples (only the floor applies then).
 */
export interface GasRunway {
  level: 'ok' | 'warn' | 'critical' | 'unknown';
  /** Wei (decimal string); null before the first read. */
  balanceWei: string | null;
  /** Wei spent per day at the trailing rate; null while unknown. */
  spendWeiPerDay: string | null;
  /** Days the balance lasts at that rate; null while unknown or when nothing is spent. */
  days: number | null;
  floorWei: string;
  warnDays: number;
  criticalDays: number;
  /** Hours of balance samples the rate is measured over (up to 24). */
  sampledHours: number;
}

/** One game thread: the main thread (HTTP, sockets, chain, journal; with `GAME_WORKERS=0` also every room) or a room worker. */
export interface GameThreadLoad {
  id: 'main' | number;
  rooms: number;
  humans: number;
  bots: number;
  conns: number;
  /** The thread's whole tick (every room it runs) over the last seconds; the budget is 33 ms. Main thread with workers: delivering their frames. */
  tickMeanMs: number;
  tickP95Ms: number;
  tickMaxMs: number;
  /** Event-loop utilisation since the previous reading (0..1). */
  elu: number;
  lagP99Ms: number;
  heapMb: number;
  up: boolean;
  /** Restarts after a crash or a hang (room workers). */
  restarts: number;
}

/** `GET /api/admin/load` (and `NetworkInfo.load`): the game server's load per thread. */
export interface GameServerLoad {
  mode: 'single' | 'workers';
  workers: number;
  cpus: number;
  rssMb: number;
  conns: number;
  sentBytesPerSec: number;
  sentMsgsPerSec: number;
  main: GameThreadLoad;
  threads: GameThreadLoad[];
  at: number;
}

/* ------------------------------------------------------------------ */
/* Faucet (`GET /api/site/faucet`)                                      */
/* ------------------------------------------------------------------ */

/** `GET /api/site/faucet`: the TestToken faucet (testnet only). Amounts in base units (decimal strings). */
export interface FaucetConfig {
  /** A test chain with a registered TestToken. */
  enabled: boolean;
  chainId: number | null;
  /** The TestToken (null when none is registered). */
  token: string | null;
  decimals: number;
  /** Per claim for a wallet without the emblem; null when unknown. */
  amount: string | null;
  /** Per claim for an emblem holder; null when unknown. */
  holderAmount: string | null;
  cooldownSecs: number | null;
  /** The NFT the holder bonus reads; null: no bonus. */
  holderNft: string | null;
  /** The chain's gas faucet (`ChainDef.faucetUrl`, `GAS_FAUCET_URL` overrides it); null when there is none. */
  gasFaucetUrl: string | null;
}

/* ------------------------------------------------------------------ */
/* Testnet emblem holders → mainnet WL (`/api/admin/mint/import-holders`) */
/* ------------------------------------------------------------------ */

export interface HolderWlEntry {
  /** EIP-55 checksummed. */
  wallet: string;
  source: 'testnet-emblem';
  chainId: number;
  /** Token ids held at the import (decimal strings). */
  tokenIds: string[];
}

/** `GET` / `POST /api/admin/mint/import-holders`. */
export interface HolderWlView {
  entries: HolderWlEntry[];
  counts: {
    wallets: number;
    tokens: number;
    /** Imported wallets that are also approved WL or collab wallets (counted once in the allowlist). */
    alsoWl: number;
  };
  /** Unix ms of the last import; null before the first. */
  importedAt: number | null;
  importedFrom: number | null;
}
