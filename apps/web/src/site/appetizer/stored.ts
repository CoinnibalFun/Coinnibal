import { APPETIZER_CODE_RE, type AppetizerCard } from '@coinnibal/shared';
import { useSyncExternalStore } from 'react';
import { storageKey } from '../../storageKey';

/**
 * The visitor's own Appetizer, kept in this browser so a return visit shows the card and its share buttons again:
 * the card as anyone may see it (code, number, handle, day) and whether its post link was sent. Never the wallet.
 */
export interface StoredAppetizer extends AppetizerCard {
  posted?: boolean;
}

const KEY = 'appetizer.v1';
const listeners = new Set<() => void>();
let cache: { raw: string | null; card: StoredAppetizer | null } = { raw: null, card: null };

function parse(raw: string | null): StoredAppetizer | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredAppetizer>;
    if (typeof v.code !== 'string' || !APPETIZER_CODE_RE.test(v.code)) return null;
    if (typeof v.no !== 'number' || !(v.no > 0) || typeof v.handle !== 'string' || !v.handle) return null;
    return { code: v.code, no: v.no, handle: v.handle, at: typeof v.at === 'number' ? v.at : 0, ...(v.posted ? { posted: true } : {}) };
  } catch {
    return null;
  }
}

export function readAppetizer(): StoredAppetizer | null {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(storageKey(KEY)) ?? null;
  } catch {
    /* storage blocked */
  }
  if (raw !== cache.raw) cache = { raw, card: parse(raw) };
  return cache.card;
}

/** Keeps the card (only its public fields: an object with more is trimmed), or forgets it with null. */
export function saveAppetizer(card: StoredAppetizer | null): void {
  try {
    const k = storageKey(KEY);
    if (card) globalThis.localStorage?.setItem(k, JSON.stringify({ code: card.code, no: card.no, handle: card.handle, at: card.at, ...(card.posted ? { posted: true } : {}) }));
    else globalThis.localStorage?.removeItem(k);
  } catch {
    /* storage full or blocked: the card still shows for this visit */
  }
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.endsWith(KEY)) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** The kept card; null in the server render and while the browser hydrates it (the prerendered page has none). */
export function useStoredAppetizer(): StoredAppetizer | null {
  return useSyncExternalStore(subscribe, readAppetizer, () => null);
}
