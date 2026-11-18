import { useEffect } from 'react';
import { create } from 'zustand';
import type { ProfileView, XCodeView, XLinkError, XLinkView, XStatusView } from '@coinnibal/shared';
import { SERVER } from '../config';
import { serverText, t, type TKey } from '../i18n';

/**
 * "Link X" on the web: the signed-in wallet's link and pending code (`GET /api/x`), a new code, the proof check, unlink
 * and "My X picture". Kept apart from the profile: the profile calls answer without the link.
 */
interface XLinkState {
  /** The wallet the status is of (lower case); null: not loaded. */
  wallet: string | null;
  link: XLinkView | null;
  code: XCodeView | null;
  loaded: boolean;
}

export const useXLink = create<XLinkState>(() => ({ wallet: null, link: null, code: null, loaded: false }));

/** Errors the server names, in the player's language (the server's own words in English). */
const ERRORS: Record<XLinkError | 'x_picture_unavailable' | 'rate_limited', TKey> = {
  x_bad_url: 'x.err.badUrl',
  x_no_code: 'x.err.noCode',
  x_not_found: 'x.err.notFound',
  x_code_mismatch: 'x.err.mismatch',
  x_post_old: 'x.err.old',
  x_unreachable: 'x.err.unreachable',
  x_picture_unavailable: 'x.err.picture',
  rate_limited: 'x.err.rate',
};

/** A refused call: `code` is the server's error code. */
export class XCallError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER.http}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new XCallError(t('api.reach'), null, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok || !data) {
    const code = typeof data?.error === 'string' ? data.error : null;
    const key = code && code in ERRORS ? ERRORS[code as keyof typeof ERRORS] : null;
    const fallback = res.status === 401 ? t('api.expiredVerify') : key ? t(key) : t('x.err.generic');
    throw new XCallError(key && code !== null ? serverText(data?.message, t(key)) : fallback, code, res.status);
  }
  return data;
}

const adopt = (wallet: string, s: XStatusView) => useXLink.setState({ wallet: wallet.toLowerCase(), link: s.link, code: s.code, loaded: true });

/** `GET /api/x`. */
export async function loadXLink(wallet: string, token: string): Promise<void> {
  adopt(wallet, await call<XStatusView>('GET', '/api/x', token));
}

/** `POST /api/x/code`: a new code (it replaces the earlier one). */
export async function newXCode(wallet: string, token: string): Promise<XCodeView> {
  const { code } = await call<{ code: XCodeView }>('POST', '/api/x/code', token);
  useXLink.setState({ wallet: wallet.toLowerCase(), code, loaded: true });
  return code;
}

/** `POST /api/x/verify {url}`: the link, from X's own answer. */
export async function verifyXPost(wallet: string, token: string, url: string): Promise<XLinkView> {
  const s = await call<XStatusView>('POST', '/api/x/verify', token, { url });
  adopt(wallet, s);
  return s.link!;
}

/** `DELETE /api/x`. */
export async function unlinkX(wallet: string, token: string): Promise<void> {
  adopt(wallet, await call<XStatusView>('DELETE', '/api/x', token));
}

/** `POST /api/x/picture`: the X picture becomes the profile picture (the profile with its new `avatar`). */
export async function wearXPicture(token: string): Promise<ProfileView> {
  return (await call<{ profile: ProfileView }>('POST', '/api/x/picture', token)).profile;
}

/** Loads the wallet's link once per signed-in session (cleared on sign-out or another wallet). */
export function useXLinkSync(wallet: string | null, token: string | null): XLinkState {
  const state = useXLink();
  useEffect(() => {
    if (!wallet || !token) {
      useXLink.setState({ wallet: null, link: null, code: null, loaded: false });
      return;
    }
    if (useXLink.getState().wallet === wallet.toLowerCase() && useXLink.getState().loaded) return;
    useXLink.setState({ wallet: wallet.toLowerCase(), link: null, code: null, loaded: false });
    loadXLink(wallet, token).catch(() => useXLink.setState({ loaded: true }));
  }, [wallet, token]);
  return wallet && state.wallet === wallet.toLowerCase() ? state : { wallet: null, link: null, code: null, loaded: false };
}
