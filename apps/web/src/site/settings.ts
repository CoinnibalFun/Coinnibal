import { SITE_SETTINGS_DEFAULT, type SiteSettings } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { X_HANDLE_BUILD, setOurXHandle } from '../i18n';
import { site } from './api';

/**
 * The project's X account before the settings load (the build's `VITE_X_HANDLE`, else the shared default); pages that
 * know the settings use `xProfile(settings.xHandle)`.
 */
export const X_HANDLE = X_HANDLE_BUILD;
/** The settings while loading or when the server is down: the defaults, with the build's X handle. */
const FALLBACK: SiteSettings = { ...SITE_SETTINGS_DEFAULT, xHandle: X_HANDLE_BUILD };
export const X_URL = `https://x.com/${X_HANDLE}`;

let cache: SiteSettings | null = null;
let pending: Promise<SiteSettings> | null = null;

/** The public site settings, fetched once per page (defaults while loading or when the server is down). */
export function loadSiteSettings(): Promise<SiteSettings> {
  if (cache) return Promise.resolve(cache);
  pending ??= site
    .settings()
    .then((s) => {
      cache = s;
      setOurXHandle(s.xHandle);
      return s;
    })
    .catch(() => {
      pending = null;
      return FALLBACK;
    });
  return pending;
}

/** For tests: forget the cached settings. */
export function resetSiteSettings(): void {
  cache = null;
  pending = null;
}

export function useSiteSettings(): { settings: SiteSettings; loaded: boolean } {
  const [state, setState] = useState<{ settings: SiteSettings; loaded: boolean }>(() => ({ settings: cache ?? FALLBACK, loaded: !!cache }));
  useEffect(() => {
    let live = true;
    void loadSiteSettings().then((s) => live && setState({ settings: s, loaded: true }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** `x.com/<handle>` for a stored (normalised) handle. */
export const xProfile = (handle: string): string => `https://x.com/${handle.replace(/^@/, '')}`;

/** An X "compose" link with the text filled in (the user attaches the card themselves). */
export const xIntent = (text: string, inReplyTo?: string | null): string =>
  `https://x.com/intent/post?text=${encodeURIComponent(text)}${inReplyTo ? `&in_reply_to=${encodeURIComponent(inReplyTo)}` : ''}`;

/** The host this site is served at (never hard-coded: `PUBLIC_URL` decides). */
export function siteHost(): string {
  try {
    return window.location.host;
  } catch {
    return '';
  }
}

/** `0x1234…abcd` for an EVM address. */
export const shortWallet = (w: string): string => (w.length <= 12 ? w : `${w.slice(0, 6)}…${w.slice(-4)}`);
