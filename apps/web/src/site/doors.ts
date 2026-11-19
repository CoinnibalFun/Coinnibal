import { gameVisible, type SiteSettings } from '@coinnibal/shared';
import { useEffect, useState } from 'react';
import { auth } from './api';
import { useSiteSettings } from './settings';
import { readStoredSession } from './storedSession';

/**
 * What the site shows to visitors, from the admin's settings (`/admin`, Settings): the game (and its
 * faucet), the mint page, WL applications, collab applications. A closed part has no link, button or
 * widget anywhere on the site, and its page says "not open yet".
 */
export interface Doors {
  /** The game shows: `gameAccess` is `public`, `holders` or `maintenance` (not `admins`). */
  game: boolean;
  mint: boolean;
  wl: boolean;
  collab: boolean;
}

export const DOORS_CLOSED: Doors = { game: false, mint: false, wl: false, collab: false };

export function doorsOf(s: Pick<SiteSettings, 'gameAccess' | 'mintOpen' | 'wlOpen' | 'collabOpen'>): Doors {
  return { game: gameVisible(s.gameAccess), mint: s.mintOpen === true, wl: s.wlOpen === true, collab: s.collabOpen === true };
}

/** The doors; everything is closed while the settings load (and when the server is down), so nothing closed flashes. */
export function useDoors(): Doors & { loaded: boolean } {
  const { settings, loaded } = useSiteSettings();
  return loaded ? { ...doorsOf(settings), loaded } : { ...DOORS_CLOSED, loaded };
}

/** The door a page hangs on (`/wl` closes itself: it still shows an earlier applicant their status). */
const PAGE_DOOR: Record<string, keyof Doors> = { '/mint': 'mint', '/faucet': 'game', '/collab': 'collab' };

export const pageDoor = (path: string): keyof Doors | null => PAGE_DOOR[path] ?? null;

/** True when a link to `path` may show. */
export function linkOpen(path: string, doors: Doors): boolean {
  if (path === '/play') return doors.game;
  if (path === '/wl') return doors.wl;
  const door = pageDoor(path);
  return door === null || doors[door];
}

/**
 * Whether this browser holds a signed-in admin wallet (the owner looks at a closed page before opening it).
 * The stored flag is only a hint: the server confirms it (`/api/auth/me`). `null` while it is being checked.
 */
export function useAdminPreview(wanted: boolean): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(() => (wanted && readStoredSession()?.admin ? null : false));
  useEffect(() => {
    if (!wanted) return;
    const stored = readStoredSession();
    if (!stored?.admin) {
      setAdmin(false);
      return;
    }
    let live = true;
    setAdmin(null);
    auth.me(stored.token).then(
      (me) => live && setAdmin(me.admin === true),
      () => live && setAdmin(false),
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return wanted ? admin : false;
}
