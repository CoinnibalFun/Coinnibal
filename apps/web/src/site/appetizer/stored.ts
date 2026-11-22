import { APPETIZER_CODE_RE, type AppetizerCard } from '@coinnibal/shared';
import { useSyncExternalStore } from 'react';
import { storageKey } from '../../storageKey';

/**
 * The visitor's own Appetizer, kept in this browser so a return visit shows the card and its share buttons again:
 * the card as anyone may see it (code, number, handle, day) and whether its post link was sent. Never the wallet.
 * The same entry remembers the checklist steps the visitor opened before the card (`followed`: the follow button,
 * `liked`: our X post), before any card and after one is cleared, so the claim button stays unlocked across a
 * reload.
 */
export interface StoredAppetizer extends AppetizerCard {
  posted?: boolean;
}

/** A step opened before the card is served. */
export type AppetizerStep = 'followed' | 'liked';

const KEY = 'appetizer.v1';
const listeners = new Set<() => void>();
interface Kept {
  card: StoredAppetizer | null;
  followed: boolean;
  liked: boolean;
}
const NONE: Kept = { card: null, followed: false, liked: false };
let cache: { raw: string | null; kept: Kept } = { raw: null, kept: NONE };
/** This visit's steps, for a browser that cannot store them. */
const here = { followed: false, liked: false };

function parse(raw: string | null): Kept {
  if (!raw) return NONE;
  try {
    const v = JSON.parse(raw) as Partial<StoredAppetizer> & { followed?: unknown; liked?: unknown };
    if (!v || typeof v !== 'object') return NONE;
    const steps = { followed: v.followed === true, liked: v.liked === true };
    if (typeof v.code !== 'string' || !APPETIZER_CODE_RE.test(v.code)) return { card: null, ...steps };
    if (typeof v.no !== 'number' || !(v.no > 0) || typeof v.handle !== 'string' || !v.handle) return { card: null, ...steps };
    // a card was only ever handed out after the follow
    return { card: { code: v.code, no: v.no, handle: v.handle, at: typeof v.at === 'number' ? v.at : 0, ...(v.posted ? { posted: true } : {}) }, ...steps, followed: true };
  } catch {
    return NONE;
  }
}

function read(): Kept {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(storageKey(KEY)) ?? null;
  } catch {
    /* storage blocked */
  }
  if (raw !== cache.raw) cache = { raw, kept: parse(raw) };
  return cache.kept;
}

export function readAppetizer(): StoredAppetizer | null {
  return read().card;
}

/** Whether the visitor opened a step (in this browser, or in this visit where nothing can be stored). */
export function readStep(step: AppetizerStep): boolean {
  return here[step] || read()[step];
}

function write(kept: Kept): void {
  try {
    const k = storageKey(KEY);
    const { card, followed, liked } = kept;
    const steps = { ...(followed ? { followed: true } : {}), ...(liked ? { liked: true } : {}) };
    if (card) globalThis.localStorage?.setItem(k, JSON.stringify({ code: card.code, no: card.no, handle: card.handle, at: card.at, ...(card.posted ? { posted: true } : {}), ...steps }));
    else if (followed || liked) globalThis.localStorage?.setItem(k, JSON.stringify(steps));
    else globalThis.localStorage?.removeItem(k);
  } catch {
    /* storage full or blocked: the card still shows for this visit */
  }
  for (const l of listeners) l();
}

/** Keeps the card (only its public fields: an object with more is trimmed), or forgets it with null (the steps stay). */
export function saveAppetizer(card: StoredAppetizer | null): void {
  write({ card, followed: !!card || readStep('followed'), liked: readStep('liked') });
}

/** Remembers that the visitor opened a step. */
export function saveStep(step: AppetizerStep): void {
  here[step] = true;
  write({ card: readAppetizer(), followed: readStep('followed'), liked: readStep('liked') });
}

/** Forgets this visit's steps (tests). */
export function resetSteps(): void {
  here.followed = false;
  here.liked = false;
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

/** Whether a step was opened; false in the server render. */
export function useAppetizerStep(step: AppetizerStep): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readStep(step),
    () => false,
  );
}
