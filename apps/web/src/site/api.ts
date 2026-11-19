import type {
  ArenaPricingSettings,
  NftCollectionAdminView,
  NftProvenance,
  ArenaScalingSettings,
  ArenaScalingView,
  TestArenaSettings,
  TestArenaView,
  CustomRoomAdminView,
  CustomRoomSettings,
  MapScaleSettings,
  CustomRoomView,
  AdminAvatarEntry,
  BoostKind,
  ShopSettings,
  IntegrityBan,
  IntegrityFlag,
  IntegrityFlagKind,
  IntegrityFlagStatus,
  IntegrityHeld,
  IntegrityOverview,
  IntegritySettings,
  IntegrityThresholds,
  IntegrityWalletView,
  CollabAdmin,
  CollabApplyRequest,
  CollabPublic,
  CollabStatus,
  CollabWalletRow,
  AllowlistBuildResponse,
  AllowlistStatus,
  ContractKind,
  ContractRegisterRequest,
  ContractsRegistry,
  FaucetConfig,
  FeedbackEntry,
  FeedbackList,
  HolderWlView,
  NetworkInfo,
  GameAccess,
  MintPriceQuote,
  MintProofResponse,
  MintState,
  PublicWlTask,
  SiteCounts,
  SiteErrorCode,
  SiteSettings,
  WlEntryAdmin,
  WlEntryPublic,
  WlStatus,
  WlSubmitRequest,
  WlTask,
} from '@coinnibal/shared';
import { SERVER } from '../config';
import { X_HANDLE_BUILD, getLocale, t, type TKey } from '../i18n';

/**
 * The site API (`/api/site/*`, `/api/admin/*`, `/api/auth/*`). Every error is a
 * `SiteApiError` with the server's code, its short English message and the offending field.
 */
/** `GET /api/admin/custom-rooms`. */
/** `GET /api/admin/custom-rooms`: the settings, where fees are paid (the arena), the base price now and the live rooms. */
export type CustomRoomsAdminView = CustomRoomAdminView;

export class SiteApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: SiteErrorCode | 'network',
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SiteApiError';
  }
}

/** User-facing fallbacks when the server sends no message. */
const FALLBACK: Partial<Record<SiteApiError['code'], string>> = {
  network: 'Cannot reach the server right now. Check your connection and try again.',
  unauthorized: 'Your sign-in expired. Sign in with your wallet again.',
  forbidden: 'This wallet is not an admin.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  wl_closed: `Applications are closed. Follow @${X_HANDLE_BUILD} to hear when they open again.`,
  collab_closed: `Collab applications are closed. Follow @${X_HANDLE_BUILD} to hear when they open again.`,
  already_applied: 'This wallet has already applied.',
  handle_taken: 'This X handle has already applied.',
  collab_limit: 'This X account has already applied twice.',
  wrong_state: 'This community cannot be changed right now.',
  deadline_passed: 'The deadline has passed.',
  too_many_wallets: 'There are more wallets than spots.',
  auth_failed: 'The wallet signature did not check out. Try again.',
  bad_request: 'Something in the form is not right.',
  game_closed: 'The game is not open to this wallet yet.',
  code_mismatch: 'That address holds no code, or code other than the Coinnibal contract this server ships with.',
  not_owner: 'The contract owner is not the signed-in admin wallet.',
  wrong_authority: "The arena's server authority is not this server's key.",
  chain_off: 'The server has no chain (its RPC did not answer, serves another chain or is not set, or it has no usable server key), or the contract is not registered.',
  price_unavailable: 'The gas token price feed is unavailable right now.',
};

/**
 * The same fallbacks in the reader's language. Outside English the client's own words win over the
 * server's English message for these codes (a form error with a field keeps the server's detail).
 */
const LOCAL: Partial<Record<SiteApiError['code'], TKey>> = {
  network: 'api.network',
  unauthorized: 'api.unauthorized',
  forbidden: 'api.forbidden',
  rate_limited: 'api.rate_limited',
  wl_closed: 'api.wl_closed',
  collab_closed: 'api.collab_closed',
  already_applied: 'api.already_applied',
  handle_taken: 'api.handle_taken',
  collab_limit: 'api.collab_limit',
  wrong_state: 'api.wrong_state',
  deadline_passed: 'api.deadline_passed',
  too_many_wallets: 'api.too_many_wallets',
  auth_failed: 'api.auth_failed',
  bad_request: 'api.bad_request',
  game_closed: 'api.game_closed',
  price_unavailable: 'api.price_unavailable',
};

function message(code: SiteApiError['code'], server: string | undefined, field: string | undefined): string {
  const key = LOCAL[code];
  if (key && getLocale() !== 'en' && !(field && server)) return t(key);
  return server || FALLBACK[code] || t('api.wrong');
}

/** A 5xx with no JSON error: the proxy answered for a server that is down or waking up. */
export const SERVER_DOWN = 'The game server is not answering right now. Try again in a moment.';

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  /** Extra request headers (the secret exports' `X-Coinnibal-Proof`). */
  headers?: Record<string, string>;
}

/** Told when an admin route answers `admin_session_expired` (session.ts signs out and asks for a new sign-in). */
let adminExpiredListener: ((message: string) => void) | null = null;
export function onAdminSessionExpired(fn: ((message: string) => void) | null): void {
  adminExpiredListener = fn;
}

async function send(path: string, { method = 'GET', body, token, signal, headers: extra }: RequestOpts): Promise<Response> {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${SERVER.http}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new SiteApiError(0, 'network', message('network', undefined, undefined));
  }
  if (!res.ok) {
    let data: { error?: SiteErrorCode; message?: string; field?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      /* not JSON */
    }
    // a 5xx without the server's JSON error is the proxy in front of it (the server is down, restarting or
    // waking up): not "Something in the form is not right"
    if (!data.error && res.status >= 500) throw new SiteApiError(res.status, 'network', getLocale() === 'en' ? SERVER_DOWN : t('api.down'));
    const code = data.error ?? (res.status === 429 ? 'rate_limited' : res.status === 401 ? 'unauthorized' : 'bad_request');
    const err = new SiteApiError(res.status, code, message(code, data.message, data.field), data.field);
    if (code === 'admin_session_expired') adminExpiredListener?.(err.message);
    throw err;
  }
  return res;
}

export async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const res = await send(path, opts);
  return (await res.json()) as T;
}

/** Fetches a CSV with the session header and saves it (a plain link cannot carry the header). */
export async function downloadCsv(path: string, token: string, fallbackName: string, headers?: Record<string, string>): Promise<void> {
  const res = await send(path, { token, headers });
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disp)?.[1] ?? fallbackName;
  saveBlob(blob, name);
}

/** The header that carries a secret export's proof (`/api/admin/backup`, `/api/admin/migration-env`). */
export const PROOF_HEADER = 'X-Coinnibal-Proof';

/** What the admin wallet signs to open one secret export (`POST /api/admin/secret-proof`). */
export interface SecretProofChallenge {
  message: string;
  nonce: string;
  expiresAt: number;
}

/** A purpose: `backup` opens one backup download; `migration` the settings and one backup (the move to a new server). */
export type SecretPurpose = 'backup' | 'migration';

/** The `X-Coinnibal-Proof` value: base64url of `{"message","signature"}` (pure, tested). */
export function encodeProof(message: string, signature: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ message, signature }));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const SECRETS_END = 'COINNIBAL_SECRETS';

/**
 * `lines` as a quoted here-document on the command's stdin: the secrets never go on a command line, which any local
 * user can read in ps (the shell writes a here-document to the command's stdin itself). Quoted, so nothing in it is
 * expanded. A value holding a line break would end it early: refused.
 */
function onStdin(lines: string[]): string {
  if (lines.some((l) => /[\r\n]/.test(l) || l === SECRETS_END)) throw new Error('a secret holds a line break');
  return ` <<'${SECRETS_END}'\n${lines.join('\n')}\n${SECRETS_END}`;
}

/**
 * The shell command that downloads a server backup with an admin session token and a fresh proof (pure, tested): run
 * on the new server to move the data without a laptop in between. Both headers reach curl on its stdin (`-H @-`),
 * never as arguments. The leading space keeps the command out of the shell history (Ubuntu's HISTCONTROL). The proof
 * opens one download within 10 minutes; the session lasts 2 hours at most.
 */
export function backupCurlCommand(serverHttp: string, token: string, proof: string): string {
  return ` curl -fsS -H @- ${shellQuote(`${serverHttp.replace(/\/+$/, '')}/api/admin/backup`)} -o coinnibal-backup.tar.gz${onStdin([`Authorization: Bearer ${token}`, `${PROOF_HEADER}: ${proof}`])}`;
}

/**
 * The whole move to a new server in one paste (deploy/vps/install.sh --from): settings and data, with a `migration`
 * proof. The token and the proof reach install.sh on its stdin, one per line, never as arguments.
 */
export function installCommand(serverHttp: string, token: string, proof: string): string {
  const raw = 'https://raw.githubusercontent.com/furkan3152/Solagel/main/deploy/vps/install.sh';
  return ` curl -fsSL ${raw} -o install.sh && sudo bash install.sh --yes --from ${shellQuote(serverHttp.replace(/\/+$/, ''))}${onStdin([token, proof])}`;
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const q = (params: Record<string, string | number | undefined | null>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

/* ── auth ─────────────────────────────────────────────────────────── */

export interface AuthMe {
  address: string;
  admin: boolean;
  /** The wallet may play under the current `gameAccess` (admins, NFT holders or everyone). */
  canPlay?: boolean;
  /** The wallet holds a Coinnibal NFT (`balanceOf > 0`). */
  holder?: boolean;
  /**
   * The server could not check the wallet's NFT for `canPlay` right now (past its holder reads the holder index could
   * not catch up, and it knows no answer): ask again in a moment. `canPlay` is false then, which is not a "no".
   */
  busy?: boolean;
}

export const auth = {
  /** SIWE: `message` is the rebuilt `siweMessage`, `signature` the wallet's `personal_sign` (0x hex). */
  login: (address: string, message: string, signature: string) =>
    request<{ address: string; token: string; admin: boolean }>('/api/auth/login', { method: 'POST', body: { address, message, signature } }),
  me: (token: string) => request<AuthMe>('/api/auth/me', { token }),
};

/* ── public site ──────────────────────────────────────────────────── */

export const site = {
  settings: (signal?: AbortSignal) => request<{ settings: SiteSettings }>('/api/site/settings', { signal }).then((r) => r.settings),
  tasks: () => request<{ tasks: PublicWlTask[] }>('/api/site/tasks').then((r) => r.tasks),
  myWl: (token: string) => request<{ entry: WlEntryPublic | null }>('/api/site/wl', { token }).then((r) => r.entry),
  submitWl: (token: string, body: WlSubmitRequest) => request<{ entry: WlEntryPublic }>('/api/site/wl', { method: 'POST', token, body }).then((r) => r.entry),
  myCollabs: (token: string) => request<{ collabs: CollabPublic[] }>('/api/site/collab', { token }).then((r) => r.collabs),
  applyCollab: (token: string, body: CollabApplyRequest) =>
    request<{ collab: CollabPublic }>('/api/site/collab', { method: 'POST', token, body }).then((r) => r.collab),
  saveWallets: (token: string, id: string, wallets: CollabWalletRow[], raffleUrl: string | null) =>
    request<{ collab: CollabPublic }>(`/api/site/collab/${encodeURIComponent(id)}/wallets`, { method: 'PUT', token, body: { wallets, raffleUrl } }).then((r) => r.collab),
  submitWallets: (token: string, id: string, wallets: CollabWalletRow[], raffleUrl: string) =>
    request<{ collab: CollabPublic }>(`/api/site/collab/${encodeURIComponent(id)}/submit`, { method: 'POST', token, body: { wallets, raffleUrl } }).then((r) => r.collab),
  /** `GET /api/site/mint`: contract state, the gas token's USD price, the price in USD, holders, game access. */
  mint: (signal?: AbortSignal) => request<MintState>('/api/site/mint', { signal }),
  /** `GET /api/site/mint/proof?wallet=0x…`. */
  mintProof: (wallet: string, signal?: AbortSignal) => request<MintProofResponse>(`/api/site/mint/proof${q({ wallet })}`, { signal }),
  /**
   * `GET /api/site/faucet`: the TestToken faucet (testnet only; amounts in base units). While only admins play, the
   * server answers an admin's session only (`token`: the owner looking the page over before opening the game).
   */
  faucet: (token?: string | null) => request<FaucetConfig>('/api/site/faucet', { token }),
  /** `GET /api/site/contracts`: the registered contracts. */
  contracts: () => request<ContractsRegistry>('/api/site/contracts'),
};

/* ── admin ────────────────────────────────────────────────────────── */

export interface WlPage {
  items: WlEntryAdmin[];
  total: number;
  page: number;
  pageSize: number;
}

export type TaskInput = Partial<Pick<WlTask, 'kind' | 'title' | 'body' | 'target' | 'required' | 'enabled'>>;

export function adminApi(token: string) {
  const id = encodeURIComponent;
  return {
    me: () => request<{ address: string; admin: true }>('/api/admin/me', { token }),
    counts: () => request<SiteCounts>('/api/admin/counts', { token }),
    /** `gameAccessEnv`: the server's `GAME_ACCESS` override (null when unset). */
    settings: () => request<AdminSettingsResponse>('/api/admin/settings', { token }),
    saveSettings: (patch: Partial<SiteSettings>) => request<AdminSettingsResponse>('/api/admin/settings', { method: 'PUT', token, body: patch }),
    /** `POST /api/admin/contracts`: the server checks the code hash, the owner and (arena) the server authority. */
    registerContract: (body: ContractRegisterRequest) => request<{ registry: ContractsRegistry } | ContractsRegistry>('/api/admin/contracts', { method: 'POST', token, body }).then(registryOf),
    clearContract: (kind: ContractKind) => request<{ registry: ContractsRegistry } | ContractsRegistry>(`/api/admin/contracts${q({ kind })}`, { method: 'DELETE', token }).then(registryOf),
    /** `POST /api/admin/mint/allowlist`: builds a snapshot of the allowlist. */
    buildAllowlist: () => request<AllowlistBuildResponse>('/api/admin/mint/allowlist', { method: 'POST', token, body: {} }),
    allowlist: () => request<AllowlistStatus>('/api/admin/mint/allowlist', { token }),
    /** `POST /api/admin/mint/refresh`: the server re-reads the NFT now (after an owner transaction), for the public mint page. */
    mintRefresh: () => request<{ refreshed: boolean }>('/api/admin/mint/refresh', { method: 'POST', token, body: {} }),
    /** `GET /api/admin/mint/price`: the gas token's USD price and the mint price (MINT_USD_CENTS) in wei. */
    mintPrice: () => request<MintPriceQuote>('/api/admin/mint/price', { token }),
    tasks: () => request<{ tasks: WlTask[] }>('/api/admin/tasks', { token }).then((r) => r.tasks),
    createTask: (t: TaskInput) => request<{ task: WlTask }>('/api/admin/tasks', { method: 'POST', token, body: t }).then((r) => r.task),
    updateTask: (taskId: string, t: TaskInput) => request<{ task: WlTask }>(`/api/admin/tasks/${id(taskId)}`, { method: 'PUT', token, body: t }).then((r) => r.task),
    deleteTask: (taskId: string) => request<{ ok: true }>(`/api/admin/tasks/${id(taskId)}`, { method: 'DELETE', token }),
    orderTasks: (ids: string[]) => request<{ tasks: WlTask[] }>('/api/admin/tasks/order', { method: 'PUT', token, body: { ids } }).then((r) => r.tasks),
    wl: (p: { status?: WlStatus | ''; q?: string; page?: number; pageSize?: number }) => request<WlPage>(`/api/admin/wl${q(p)}`, { token }),
    wlEntry: (entryId: string) => request<{ entry: WlEntryAdmin }>(`/api/admin/wl/${id(entryId)}`, { token }).then((r) => r.entry),
    wlStatus: (entryId: string, status: WlStatus) => request<{ entry: WlEntryAdmin }>(`/api/admin/wl/${id(entryId)}/status`, { method: 'PUT', token, body: { status } }).then((r) => r.entry),
    wlBulk: (ids: string[], status: WlStatus) => request<{ updated: number }>('/api/admin/wl/status', { method: 'POST', token, body: { ids, status } }),
    wlNote: (entryId: string, note: string) => request<{ entry: WlEntryAdmin }>(`/api/admin/wl/${id(entryId)}/note`, { method: 'PUT', token, body: { note } }).then((r) => r.entry),
    wlCsv: (scope: 'approved' | 'all') => downloadCsv(`/api/admin/wl.csv${q({ scope })}`, token, `coinnibal-wl-${scope}.csv`),
    collabs: (p: { status?: CollabStatus | 'closed' | ''; q?: string }) => request<{ items: CollabAdmin[] }>(`/api/admin/collabs${q(p)}`, { token }).then((r) => r.items),
    collab: (cid: string) => request<{ collab: CollabAdmin }>(`/api/admin/collabs/${id(cid)}`, { token }).then((r) => r.collab),
    approveCollab: (cid: string, spots: number, deadline: number) =>
      request<{ collab: CollabAdmin }>(`/api/admin/collabs/${id(cid)}/approve`, { method: 'POST', token, body: { spots, deadline } }).then((r) => r.collab),
    rejectCollab: (cid: string) => request<{ collab: CollabAdmin }>(`/api/admin/collabs/${id(cid)}/reject`, { method: 'POST', token }).then((r) => r.collab),
    extendCollab: (cid: string, deadline: number, spots?: number) =>
      request<{ collab: CollabAdmin }>(`/api/admin/collabs/${id(cid)}/extend`, { method: 'POST', token, body: spots === undefined ? { deadline } : { deadline, spots } }).then((r) => r.collab),
    unlockCollab: (cid: string) => request<{ collab: CollabAdmin }>(`/api/admin/collabs/${id(cid)}/unlock`, { method: 'POST', token }).then((r) => r.collab),
    collabNote: (cid: string, note: string) => request<{ collab: CollabAdmin }>(`/api/admin/collabs/${id(cid)}/note`, { method: 'PUT', token, body: { note } }).then((r) => r.collab),
    collabCsv: (cid: string) => downloadCsv(`/api/admin/collabs/${id(cid)}/wallets.csv`, token, `coinnibal-collab-${cid}.csv`),
    allCollabsCsv: () => downloadCsv('/api/admin/collabs/wallets.csv', token, 'coinnibal-collab-wallets.csv'),
    integrity: integrityApi(token),
    /** `GET /api/admin/avatars`: players' profile pictures, newest first. */
    avatars: (limit = 200) => request<{ items: AdminAvatarEntry[]; total: number }>(`/api/admin/avatars${q({ limit })}`, { token }),
    /** `DELETE /api/admin/avatars/<wallet>`: removes (and blocks) the wallet's picture; its coin goes back to the basic skin. */
    removeAvatar: (wallet: string) => request<{ removed: string }>(`/api/admin/avatars/${id(wallet)}`, { method: 'DELETE', token }),
    /** `GET /api/admin/feedback`: players' messages from the game page, newest first, and how many are unread. */
    feedback: (opts: { limit?: number; offset?: number; unread?: boolean } = {}) =>
      request<FeedbackList>(`/api/admin/feedback${q({ limit: opts.limit, offset: opts.offset, unread: opts.unread ? 1 : undefined })}`, { token }),
    setFeedbackRead: (fid: string, read: boolean) => request<{ entry: FeedbackEntry; unread: number }>(`/api/admin/feedback/${id(fid)}`, { method: 'PUT', token, body: { read } }),
    readAllFeedback: () => request<{ unread: number }>('/api/admin/feedback/read-all', { method: 'POST', token }),
    deleteFeedback: (fid: string) => request<{ unread: number }>(`/api/admin/feedback/${id(fid)}`, { method: 'DELETE', token }),
    /** `GET /api/admin/arena-scaling`: the arena instance scaler's settings, every arena's instances and its decisions. */
    arenaScaling: () => request<ArenaScalingView>('/api/admin/arena-scaling', { token }),
    /** `PUT /api/admin/arena-scaling`: a partial update of the settings; answers like the GET. */
    saveArenaScaling: (patch: Partial<ArenaScalingSettings>) => request<ArenaScalingView>('/api/admin/arena-scaling', { method: 'PUT', token, body: patch }),
    /** `GET /api/admin/test-arenas`: the testnet's test arenas (the switch, the bots of an empty test arena, difficulty, every test arena now). */
    testArenas: () => request<TestArenaView>('/api/admin/test-arenas', { token }),
    /** `PUT /api/admin/test-arenas`: a partial update (refused on the mainnet); answers like the GET. */
    saveTestArenas: (patch: Partial<TestArenaSettings>) => request<TestArenaView>('/api/admin/test-arenas', { method: 'PUT', token, body: patch }),
    /** `GET /api/admin/maps`: the dynamic map settings per room kind, their defaults and every room's live numbers. */
    maps: () => request<MapAdminView>('/api/admin/maps', { token }),
    /** `PUT /api/admin/maps`: a partial update (per room kind); answers like the GET. */
    saveMaps: (patch: MapSettingsPatch) => request<MapAdminView>('/api/admin/maps', { method: 'PUT', token, body: patch }),
    /** `GET /api/admin/custom-rooms`: the custom room settings, where fees are paid, the base price now and the live rooms. */
    customRooms: () => request<CustomRoomsAdminView>('/api/admin/custom-rooms', { token }),
    /** `PUT /api/admin/custom-rooms`: a partial settings update; answers like the GET. */
    saveCustomRooms: (patch: Partial<CustomRoomSettings>) => request<CustomRoomsAdminView>('/api/admin/custom-rooms', { method: 'PUT', token, body: patch }),
    /** `DELETE /api/admin/custom-rooms/<CODE>`: closes a live room (everyone in it goes back to the lobby). */
    closeCustomRoom: (code: string) => request<{ closed: CustomRoomView; rooms: CustomRoomView[] }>(`/api/admin/custom-rooms/${id(code)}`, { method: 'DELETE', token }),
    /** `GET /api/admin/leaderboards`: how many records the daily / all-time boards hold, and the last reset. */
    leaderboards: () => request<{ info: LeaderboardAdminInfo }>('/api/admin/leaderboards', { token }).then((r) => r.info),
    /** `POST /api/admin/leaderboards/reset`: clears both boards (the server backs the file up). Profiles stay. */
    resetLeaderboards: () =>
      request<{ cleared: { daily: number; allTime: number }; backedUp: boolean; info: LeaderboardAdminInfo }>('/api/admin/leaderboards/reset', { method: 'POST', token, body: { confirm: 'RESET' } }),
    /** `GET /api/admin/arena-prices`: the USD tiers, the price source and the manual token price, the rounding. */
    arenaPrices: () => request<ArenaPricesAdminView>('/api/admin/arena-prices', { token }),
    /** `PUT /api/admin/arena-prices`: a partial update; answers like the GET. Nothing on chain changes. */
    saveArenaPrices: (patch: Partial<ArenaPricingSettings>) => request<ArenaPricesAdminView>('/api/admin/arena-prices', { method: 'PUT', token, body: patch }),
    /** `GET /api/admin/shop`: power-up prices, sink, limits and the recent purchases. */
    shop: () => request<ShopAdminView>('/api/admin/shop', { token }),
    /** `PUT /api/admin/shop`: a partial settings update; answers like the GET. */
    saveShop: (patch: Partial<ShopSettings>) => request<ShopAdminView>('/api/admin/shop', { method: 'PUT', token, body: patch }),
    /** `POST /api/admin/shop/refunds/<tx>`: the owner sent the owed part of a cart payment back. */
    markRefunded: (tx: string) => request<{ refundsOwed: ShopPurchase[] }>(`/api/admin/shop/refunds/${id(tx)}`, { method: 'POST', token, body: {} }).then((r) => r.refundsOwed),
    /**
     * `POST /api/admin/mint/import-holders` (`{ fromChainId? }`, default the testnet): adds every
     * testnet emblem holder to the mainnet allowlist, recorded per wallet with the source.
     * 409: no NFT on that chain; 502 / 503: the chain did not answer.
     */
    importHolders: (fromChainId?: number) =>
      request<HolderWlView>('/api/admin/mint/import-holders', { method: 'POST', token, body: fromChainId === undefined ? {} : { fromChainId } }),
    /** `GET /api/admin/mint/import-holders`: the last import; null when the server has no such route (404). */
    holderImport: async (): Promise<HolderWlView | null> => {
      try {
        return await request<HolderWlView>('/api/admin/mint/import-holders', { token });
      } catch (err) {
        if (err instanceof SiteApiError && (err.status === 404 || err.status === 405)) return err.status === 405 ? emptyImport() : null;
        throw err;
      }
    },
    /** `GET /api/admin/nft`: the emblem collection (provenance, rarity counts, reveal state, the mint). */
    nftCollection: () => request<NftCollectionAdminView>('/api/admin/nft', { token }),
    /** `POST /api/admin/nft/reveal/schedule` (`{ block? }`, default 50 blocks ahead): mint closed or sold out first. */
    nftScheduleReveal: (block?: string) => request<NftProvenance>('/api/admin/nft/reveal/schedule', { method: 'POST', token, body: block ? { block } : {} }),
    /** `POST /api/admin/nft/reveal`: once the scheduled block is mined. */
    nftReveal: () => request<NftProvenance>('/api/admin/nft/reveal', { method: 'POST', token, body: {} }),
    /** `GET /api/admin/network`: the server's chain, RPC health, server key and the contracts' code checks. */
    network: () => request<NetworkInfo>('/api/admin/network', { token }),
    /** `POST /api/admin/secret-proof`: the text the admin wallet signs to open one secret export (10 minutes, single use). */
    secretProof: (purpose: SecretPurpose) => request<SecretProofChallenge>('/api/admin/secret-proof', { method: 'POST', token, body: { purpose } }),
    /** `GET /api/admin/backup` with a `backup` proof: a gzip tar of the server's DATA_DIR (server key and secrets included), saved as a file. */
    backup: (proof: string) => downloadCsv('/api/admin/backup', token, 'coinnibal-backup.tar.gz', { [PROOF_HEADER]: proof }),
    /** The `curl` command that downloads the same backup with this session and a `backup` proof (one download, 10 minutes). */
    backupCommand: (proof: string) => backupCurlCommand(SERVER.http, token, proof),
    /** The new-server command with a `migration` proof (the settings and one backup, 10 minutes). */
    installCommand: (proof: string) => installCommand(SERVER.http, token, proof),
    /** `POST /api/admin/auth/revoke`: ends every session of `wallet` (this one included), or of every admin (`admins`). */
    revokeSessions: (wallet: string | 'admins') => request<{ revoked: string }>('/api/admin/auth/revoke', { method: 'POST', token, body: { wallet } }),
    /** `GET /api/admin/reprice`: the arenas on their way to a re-price at the next bell. */
    reprice: () => request<{ entries: RepriceEntry[] }>('/api/admin/reprice', { token }).then((r) => r.entries),
    /** `POST /api/admin/reprice`: closes these arenas at the next bell for a re-price (the owner signs once they are empty). */
    scheduleReprice: (arenaIds: number[]) => request<{ entries: RepriceEntry[] }>('/api/admin/reprice', { method: 'POST', token, body: { arenaIds } }).then((r) => r.entries),
    /** `POST /api/admin/reprice {cancel: true}`: opens them again without a re-price. */
    cancelReprice: (arenaIds: number[]) => request<{ entries: RepriceEntry[] }>('/api/admin/reprice', { method: 'POST', token, body: { arenaIds, cancel: true } }).then((r) => r.entries),
  };
}

export type AdminApi = ReturnType<typeof adminApi>;

export interface AdminSettingsResponse {
  settings: SiteSettings;
  /** The server's `GAME_ACCESS` env override; it wins over the stored setting. */
  gameAccessEnv?: GameAccess | null;
}

/** The registry from either `{ registry }` or the bare registry. */
const registryOf = (r: { registry: ContractsRegistry } | ContractsRegistry): ContractsRegistry => ('registry' in r ? r.registry : r);

export interface IntegrityFilter {
  status?: IntegrityFlagStatus | '';
  kind?: IntegrityFlagKind | '';
  minScore?: number | null;
  q?: string;
}

export interface IntegritySettingsPatch {
  autoHold?: boolean;
  holdScore?: number;
  autoReleaseHours?: number;
  thresholds?: Partial<IntegrityThresholds>;
  reset?: true;
}

/** `/api/admin/integrity/*`: flags, bans, held settlements and the detector settings. */
function integrityApi(token: string) {
  const id = encodeURIComponent;
  const base = '/api/admin/integrity';
  return {
    overview: () => request<IntegrityOverview>(base, { token }),
    scan: () => request<IntegrityOverview>(`${base}/scan`, { method: 'POST', token, body: {} }),
    flags: (f: IntegrityFilter) => request<{ flags: IntegrityFlag[] }>(`${base}/flags${q({ ...f, minScore: f.minScore ?? undefined })}`, { token }).then((r) => r.flags),
    flagsCsv: (f: IntegrityFilter) => downloadCsv(`${base}/flags.csv${q({ ...f, minScore: f.minScore ?? undefined })}`, token, 'coinnibal-integrity-flags.csv'),
    setStatus: (flagId: string, status: IntegrityFlagStatus, note?: string) =>
      request<{ flag: IntegrityFlag }>(`${base}/flags/${id(flagId)}/status`, { method: 'POST', token, body: note === undefined ? { status } : { status, note } }).then((r) => r.flag),
    wallet: (wallet: string, other?: string) => request<IntegrityWalletView>(`${base}/wallet/${id(wallet)}${q({ other })}`, { token }),
    ban: (wallet: string, reason: string) => request<{ ban: IntegrityBan }>(`${base}/bans`, { method: 'POST', token, body: { wallet, reason } }).then((r) => r.ban),
    unban: (wallet: string) => request<{ ok: true }>(`${base}/bans/${id(wallet)}`, { method: 'DELETE', token }),
    release: (key: string) => request<{ ok: true; held: IntegrityHeld[] }>(`${base}/held/${id(key)}/release`, { method: 'POST', token, body: {} }).then((r) => r.held),
    settleZero: (key: string, reason: string) =>
      request<{ ok: true; forfeited: number; held: IntegrityHeld[] }>(`${base}/held/${id(key)}/settle-zero`, { method: 'POST', token, body: { reason } }),
    pending: () => request<{ pending: IntegrityHeld[] }>(`${base}/pending`, { token }).then((r) => r.pending),
    hold: (key: string, reason: string) => request<{ ok: true; held: IntegrityHeld[] }>(`${base}/pending/${id(key)}/hold`, { method: 'POST', token, body: { reason } }).then((r) => r.held),
    saveSettings: (patch: IntegritySettingsPatch) => request<{ settings: IntegritySettings }>(`${base}/settings`, { method: 'PUT', token, body: patch }).then((r) => r.settings),
  };
}
export type IntegrityApi = ReturnType<typeof integrityApi>;

/* ── leaderboards (`/api/admin/leaderboards`) ─────────────────────────── */

/** What the daily and all-time boards hold (`GET /api/admin/leaderboards`). */
export interface LeaderboardAdminInfo {
  /** The server's leaderboard epoch (a deploy that raises it starts the boards fresh once). */
  epoch: number;
  day: string;
  daily: number;
  allTime: number;
  resetAt: number | null;
  /** The admin wallet that reset them, or `epoch` for the automatic reset of a deploy. */
  resetBy: string | null;
}

/* ── arena prices in USD (`/api/admin/arena-prices`) ───────────────── */

/** `GET /api/admin/arena-prices`. */
export interface ArenaPricesAdminView {
  settings: ArenaPricingSettings;
  defaults: ArenaPricingSettings;
  /** The token's USD price from the selected source now. */
  price: { ok: true; source: string; usdPerToken: string; at: number | null } | { ok: false; source: string; reason: string; message: string };
}

/* ── re-price at next bell (`/api/admin/reprice`) ──────────────────── */

/**
 * An arena on its way to a re-price at the next bell: `waiting` (joins open until the round's last minute), `closing`
 * (the last minute), `draining` (after the bell: unseated tickets are refunded at once), `ready` (nothing open: sign
 * the new entry fee now). It opens again once the chain shows a new entry fee, or on cancel.
 */
export interface RepriceEntry {
  arenaId: number;
  phase: 'waiting' | 'closing' | 'draining' | 'ready';
  by: string;
  at: number;
  entryFeeAtStart: number;
  bellAt: number | null;
  readyAt: number | null;
  open?: { onChain: number; journal: number; live: number };
}

/* ── power-up shop (`/api/admin/shop`) ─────────────────────────────── */

/** One credited power-up purchase. */
export interface ShopPurchase {
  tx: string;
  wallet: string;
  /** Records from before 2026-11 may name the retired Shockwave (`shock`, now counted as Leap). */
  kind: BoostKind | 'shock' | 'cart';
  /** A cart: charges added per power-up. */
  cart?: Partial<Record<BoostKind, number>>;
  /** Raw base units owed back to the wallet (a part of the cart that could not be applied). */
  refund?: string;
  refundedAt?: number;
  charges: number;
  /** Raw base units (decimal string). */
  paid: string;
  at: number;
}

/** `GET /api/admin/shop`. */
export interface ShopAdminView {
  settings: ShopSettings;
  defaults: ShopSettings;
  /** The arena contract every pack is paid to (`pay`); null without an arena. */
  payTo: string | null;
  /** Share of a payment the arena burns (bps; the rest goes to its fee wallet); null while unknown. */
  burnBps: number | null;
  purchases: ShopPurchase[];
  purchaseCount: number;
  /** Cart payments with a part owed back that the owner has not sent yet (absent on an older server). */
  refundsOwed?: ShopPurchase[];
}

/* ── maps (`/api/admin/maps`) ─────────────────────────────────────── */

/** One room's live numbers (`/api/admin/maps`): people, the practice bots of a free custom room, its map now. */
export interface MapRoomCount {
  id: string;
  kind: string;
  name: string;
  arenaId?: number;
  humans: number;
  bots: number;
  mapSide: number;
  mapAuto: boolean;
}

/** `GET` / `PUT /api/admin/maps`. */
export interface MapAdminView {
  settings: Record<string, MapScaleSettings>;
  defaults: Record<string, MapScaleSettings>;
  rooms: MapRoomCount[];
}

/** A partial map settings update, per room kind. */
export type MapSettingsPatch = Record<string, Partial<MapScaleSettings>>;

const emptyImport = (): HolderWlView => ({ entries: [], counts: { wallets: 0, tokens: 0, alsoWl: 0 }, importedAt: null, importedFrom: null });
