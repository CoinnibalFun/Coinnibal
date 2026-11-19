import { CUSTOM_PAYMENT_MAX_AGE_MS, CUSTOM_REQUEST_RE, SITE_URL_DEFAULT, type CustomRoomConfig, type CustomRoomCreate, type CustomRoomError, type CustomRoomQuote, type CustomRoomView } from '@coinnibal/shared';
import { SERVER } from '../config';
import { serverText, t } from '../i18n';
import { storageKey } from '../storageKey';

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

/**
 * Every kept room payment of this browser, a list keyed by wallet and transaction (2026-11 audit S12: one slot for
 * all of them let a new payment or a free room overwrite or erase a payment that never opened a room). v3: a list.
 */
const PAYMENTS_KEY = storageKey('room-payments.v3');
/** The single slot of earlier builds (v2: rooms paid in the game token; a v1 entry was an ETH transfer): moved into the list once. */
const OLD_PAY_KEY = storageKey('room-payment.v2');
/** How long this browser keeps a payment (the server refuses one older than two hours for good; a week is far past that). */
const PAYMENT_KEEP_MS = 7 * 24 * 3600_000;

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

const isPayment = (p: unknown): p is PendingRoomPayment => {
  const x = p as PendingRoomPayment | null;
  return !!x && typeof x === 'object' && typeof x.hash === 'string' && typeof x.wallet === 'string' && typeof x.request === 'string' && CUSTOM_REQUEST_RE.test(x.request) && typeof x.raw === 'string' && /^\d{1,78}$/.test(x.raw) && typeof x.at === 'number';
};
const samePayment = (wallet: string, hash: string) => (p: PendingRoomPayment) => p.wallet.toLowerCase() === wallet.toLowerCase() && p.hash.toLowerCase() === hash.toLowerCase();
/** Payments this page could not write (no storage, a full storage): kept for this page at least. */
let unsaved: PendingRoomPayment[] = [];

function readPayments(): PendingRoomPayment[] {
  let list: PendingRoomPayment[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PAYMENTS_KEY) ?? '[]');
    if (Array.isArray(raw)) list = raw.filter(isPayment);
  } catch {
    /* no storage, or an unreadable list */
  }
  for (const p of unsaved) if (!list.some(samePayment(p.wallet, p.hash))) list.push(p);
  try {
    const old: unknown = JSON.parse(localStorage.getItem(OLD_PAY_KEY) ?? 'null');
    if (isPayment(old)) {
      if (!list.some(samePayment(old.wallet, old.hash))) list.push(old);
      // the list first: should that fail, the old slot keeps the payment
      if (!writePayments(list)) return list;
    }
    localStorage.removeItem(OLD_PAY_KEY);
  } catch {
    /* an unreadable old slot holds nothing to keep */
  }
  return list;
}

function writePayments(list: PendingRoomPayment[]): boolean {
  try {
    if (list.length) localStorage.setItem(PAYMENTS_KEY, JSON.stringify(list));
    else localStorage.removeItem(PAYMENTS_KEY);
    unsaved = [];
    return true;
  } catch {
    unsaved = list;
    return false;
  }
}

/** The payments kept for `wallet` that the server still takes (younger than two hours), smallest first. */
export function loadPendingPayments(wallet: string | null): PendingRoomPayment[] {
  if (!wallet) return [];
  const now = Date.now();
  return readPayments()
    .filter((p) => p.wallet.toLowerCase() === wallet.toLowerCase() && now - p.at <= CUSTOM_PAYMENT_MAX_AGE_MS)
    .sort((a, b) => (BigInt(a.raw) < BigInt(b.raw) ? -1 : BigInt(a.raw) > BigInt(b.raw) ? 1 : a.at - b.at));
}

/** The kept payment of `wallet` that covers a room of `raw` (the smallest that does); null when none does. */
export function keptPaymentFor(wallet: string | null, raw: bigint): PendingRoomPayment | null {
  return loadPendingPayments(wallet).find((p) => BigInt(p.raw) >= raw) ?? null;
}

/** Keeps a payment beside every other kept one (the same wallet and transaction again: replaced, never doubled). */
export function savePendingPayment(p: PendingRoomPayment): void {
  const now = Date.now();
  writePayments([...readPayments().filter((x) => !samePayment(p.wallet, p.hash)(x) && now - x.at < PAYMENT_KEEP_MS), p]);
}

/** Forgets exactly one kept payment: a room opened with it, or the server refused it for good. */
export function dropPendingPayment(wallet: string, hash: string): void {
  const list = readPayments();
  const next = list.filter((p) => !samePayment(wallet, hash)(p));
  if (next.length !== list.length) writePayments(next);
}

/** The share link of a room on this site. */
export function roomLink(code: string, origin = typeof location === 'undefined' ? SITE_URL_DEFAULT : location.origin): string {
  return `${origin.replace(/\/+$/, '')}/play?room=${code}`;
}
