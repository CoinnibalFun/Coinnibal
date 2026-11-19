import { useEffect, useSyncExternalStore } from 'react';
import type { TKey } from '../i18n';

/**
 * A tab title a page claims while it shows: `/wl` draws its own closed card (the WL door is not a page door, so
 * `SiteApp` cannot tell a closed WL from an applicant's status page), and that card's tab must read like the other
 * closed pages. `SiteApp`'s title effect owns `document.title` and prefers the claim over the path's own title: the
 * page cannot set the title itself, because the parent's effect runs after the page's and again whenever the settings
 * land, and would put the path's title back.
 */
let claimed: TKey | null = null;
const listeners = new Set<() => void>();

function set(key: TKey | null): void {
  if (claimed === key) return;
  claimed = key;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The title a page claims, or null (the prerendered landing claims none: the server snapshot is null too). */
export function useClaimedTitle(): TKey | null {
  return useSyncExternalStore(
    subscribe,
    () => claimed,
    () => null,
  );
}

/** While the calling component is mounted, the tab shows `key` instead of its path's title. */
export function useClaimTitle(key: TKey): void {
  useEffect(() => {
    set(key);
    return () => {
      if (claimed === key) set(null);
    };
  }, [key]);
}
