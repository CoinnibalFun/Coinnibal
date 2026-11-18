import { CUSTOM_PAYMENT_MAX_AGE_MS, CUSTOM_REQUEST_RE, SITE_URL_DEFAULT, type CustomRoomConfig, type CustomRoomCreate, type CustomRoomError, type CustomRoomQuote, type CustomRoomView } from '@elymum/shared';
import { SERVER } from '../config';
import { serverText, t } from '../i18n';

/** A refusal of the custom room API, with the server's code and friendly message. */
export class RoomApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: CustomRoomError | 'network' | 'rate_limited',
    message: string,
    readonly field?: string,
    /** `slots_busy` after a verified payment: the payment was kept unused for a retry. */
    readonly paid?: boolean,
  ) {
    super(message);
    this.name = 'RoomApiError';
  }
}

async function call<T>(path: string, opts: { method?: 'GET' | 'POST' | 'DELETE'; token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(`${SERVER.http}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch {
    throw new RoomApiError(0, 'network', t('api.network'));
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = (typeof data.error === 'string' ? data.error : res.status === 429 ? 'rate_limited' : res.status === 401 ? 'unauthorized' : 'bad_request') as RoomApiError['code'];
    const fallback =
      code === 'unauthorized' ? t('api.expiredVerify') : code === 'rate_limited' ? t('api.rate_limited') : t('api.wrong');
    throw new RoomApiError(res.status, code, serverText(typeof data.message === 'string' ? data.message : undefined, fallback), typeof data.field === 'string' ? data.field : undefined, data.paid === true);
  }
  return data as T;
}

export const roomsApi = {
  /** What a room costs this wallet now (guests: the base price). */
  quote: (token: string | null) => call<CustomRoomQuote>('/api/rooms/custom/quote', { token }),
  /** Opens a room: `payment` is the fee's `pay` transaction and the request its ref names (absent for a free room). */
  create: (token: string, config: CustomRoomConfig, payment: { txHash: string; request: string } | null) =>
    call<{ room: CustomRoomView; invite: string }>('/api/rooms/custom', { method: 'POST', token, body: (payment ? { config, ...payment } : { config }) satisfies CustomRoomCreate }),
  get: (code: string) => call<{ room: CustomRoomView }>(`/api/rooms/custom/${encodeURIComponent(code)}`).then((r) => r.room),
  mine: (token: string) => call<{ rooms: CustomRoomView[] }>('/api/rooms/custom/mine', { token }).then((r) => r.rooms),
  close: (token: string, code: string) => call<{ closed: CustomRoomView }>(`/api/rooms/custom/${encodeURIComponent(code)}`, { method: 'DELETE', token }),
  /** "Practice with bots": this player's free practice room (guests too; the same room again while it lasts). */
  practice: (token: string | null) => call<{ room: CustomRoomView; invite: string }>('/api/rooms/custom/practice', { method: 'POST', token }).then((r) => r.room),
};

/** v2: rooms paid in the game token (a v1 entry was an ETH transfer, which can no longer open a room). */
const PAY_KEY = 'elymum.room-payment.v2';

/** A fee payment that went through but has not opened a room yet (kept for a retry: never pay twice). */
export interface PendingRoomPayment {
  hash: string;
  wallet: string;
  /** The room request its ref names (`customRoomPaymentRef`): the retry sends it again. */
  request: string;
  /** Raw base units of the game token paid. */
  raw: string;
  at: number;
}

export function loadPendingPayment(wallet: string | null): PendingRoomPayment | null {
  if (!wallet) return null;
  try {
    const p = JSON.parse(localStorage.getItem(PAY_KEY) ?? 'null') as PendingRoomPayment | null;
    // the server refuses payments older than two hours
    if (!p || typeof p.wallet !== 'string' || p.wallet.toLowerCase() !== wallet.toLowerCase() || Date.now() - p.at > CUSTOM_PAYMENT_MAX_AGE_MS) return null;
    if (typeof p.request !== 'string' || !CUSTOM_REQUEST_RE.test(p.request) || typeof p.raw !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

export function savePendingPayment(p: PendingRoomPayment | null): void {
  try {
    if (p) localStorage.setItem(PAY_KEY, JSON.stringify(p));
    else localStorage.removeItem(PAY_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The share link of a room on this site. */
export function roomLink(code: string, origin = typeof location === 'undefined' ? SITE_URL_DEFAULT : location.origin): string {
  return `${origin.replace(/\/+$/, '')}/play?room=${code}`;
}
